"use strict";

// Маршруты API. Не знает ни про Yandex Cloud, ни про YDB: получает запрос
// { method, path, headers, body, ip } и хранилище store (store-ydb.js на
// сервере, store-memory.js в тестах), возвращает { status, headers, body }.
//
//   POST /auth/telegram-miniapp   { initData }      → { token, expiresAt, user }
//   POST /auth/telegram-widget    { user: {…} }      → то же
//   POST /auth/google             { credential }     → то же
//   POST /auth/link/<способ>      то же тело + пропуск → { user, merged }
//   GET  /me                                         → { user }
//   GET  /cards?rev=&id=                             → { items, cursor, more }
//   PUT  /cards                   { items: [...] }   → { rev, results }
//   GET  /public  (без входа)                        → { folders, decks }
//
// /public — общие папки: папки с public: true у любого пользователя и
// колоды из них (только колоды владельца папки). Папки издателей (Telegram
// id из config.publisherTelegramIds) — первыми. Больше ничего из чужих
// карточек сервер не отдаёт. В user поле publisher — издатель ли человек
// (ему сайт предлагает перенести колоды-файлы в аккаунт).

const { HttpError, unauthorized, badRequest } = require("./errors");
const { verifyMiniAppInitData, verifyLoginWidget } = require("./telegram");
const { verifyGoogleIdToken } = require("./google");
const { signToken, verifyToken } = require("./jwt");
const { LIMITS, RATES, createRateLimiter } = require("./limits");
const { validateItems } = require("./sync");

function publicUser(u, publishers) {
  const out = { id: u.id, name: u.name || "", photo: u.photo || "", telegram: u.telegramId != null, google: u.googleSub != null };
  if (publishers) out.publisher = u.telegramId != null && publishers.has(String(u.telegramId));
  return out;
}

const { chatRoute } = require("./chat");

function createApp(options) {
  const store = options.store;
  const config = options.config;
  const limits = Object.assign({}, LIMITS, options.limits);
  const rates = Object.assign({}, RATES, options.rates);
  const now = options.now || Date.now;
  const hit = createRateLimiter(now);
  const origins = new Set(config.allowedOrigins || []);
  const publishers = new Set((config.publisherTelegramIds || []).map(String).filter((id) => /^\d{1,20}$/.test(id)));
  const log = options.log || ((...a) => console.error(...a));
  const userOut = (u) => publicUser(u, publishers);

  function cors(origin) {
    const h = { "Vary": "Origin" };
    if (origin && origins.has(origin)) {
      h["Access-Control-Allow-Origin"] = origin;
      h["Access-Control-Allow-Methods"] = "GET, POST, PUT, OPTIONS";
      h["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
      h["Access-Control-Max-Age"] = "86400";
    }
    return h;
  }

  function json(status, data, origin, extra) {
    return {
      status,
      headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, cors(origin), extra),
      body: JSON.stringify(data)
    };
  }

  function readJson(req) {
    const body = req.body || "";
    if (Buffer.byteLength(body, "utf8") > limits.maxBodyBytes) throw new HttpError(413, "body_too_large");
    if (!body) return {};
    try {
      const data = JSON.parse(body);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
      return data;
    } catch (e) {
      throw badRequest("bad_json");
    }
  }

  function limit(key, max) {
    const wait = hit(key, max);
    if (wait) throw new HttpError(429, "rate_limited", String(wait));
  }

  function authUserId(req) {
    const h = req.headers.authorization || "";
    const m = /^Bearer\s+(\S+)$/.exec(h);
    if (!m) throw unauthorized("no_token");
    const sub = verifyToken(m[1], config.jwtSecret, { now: now() }).sub;
    limit("u:" + sub, rates.user);
    return sub;
  }

  // Проверка доказательства входа → { provider, subject, name, photo }.
  async function identityFrom(method, body) {
    if (method === "telegram-miniapp") {
      const t = verifyMiniAppInitData(body.initData, config.botToken, { now: now() });
      return { provider: "telegram", subject: t.telegramId, name: t.name, photo: t.photo };
    }
    if (method === "telegram-widget") {
      const t = verifyLoginWidget(body.user, config.botToken, { now: now() });
      return { provider: "telegram", subject: t.telegramId, name: t.name, photo: t.photo };
    }
    if (method === "google") {
      const g = await verifyGoogleIdToken(body.credential, { clientId: config.googleClientId, getKey: options.getGoogleKey, now: now() });
      return { provider: "google", subject: g.googleSub, name: g.name, photo: g.photo };
    }
    throw new HttpError(404, "not_found");
  }

  function issue(user) {
    const t = signToken(user.id, config.jwtSecret, { now: now() });
    return { token: t.token, expiresAt: t.expiresAt, user: userOut(user) };
  }

  async function route(req) {
    const path = req.path.replace(/\/+$/, "") || "/";
    const m = req.method;

    let auth = /^\/auth\/(link\/)?([a-z-]+)$/.exec(path);
    if (auth) {
      if (m !== "POST") throw new HttpError(405, "method_not_allowed");
      limit("ip-auth:" + req.ip, rates.ipAuth);
      const linking = !!auth[1];
      const userId = linking ? authUserId(req) : null;
      const identity = await identityFrom(auth[2], readJson(req));
      if (!linking) return issue(await store.login(identity, now()));
      const res = await store.link(userId, identity, limits, now());
      return { user: userOut(res.user), merged: res.merged };
    }

    if (path === "/me") {
      if (m !== "GET") throw new HttpError(405, "method_not_allowed");
      const user = await store.getUser(authUserId(req));
      if (!user) throw unauthorized("user_gone");
      return { user: userOut(user) };
    }

    if (path === "/chat") {
      return chatRoute(m, authUserId(req), m === "POST" ? readJson(req) : {}, store);
    }

    if (path === "/cards") {
      const userId = authUserId(req);
      if (m === "GET") {
        const q = req.query || {};
        const rev = q.rev ? Number(q.rev) : 0;
        const id = typeof q.id === "string" ? q.id.slice(0, 120) : "";
        if (!Number.isSafeInteger(rev) || rev < 0) throw badRequest("bad_cursor");
        return store.pull(userId, { rev, id }, limits);
      }
      if (m === "PUT") {
        const items = validateItems(readJson(req).items, limits, now());
        return store.push(userId, items, limits, now());
      }
      throw new HttpError(405, "method_not_allowed");
    }

    if (path === "/public") {
      if (m !== "GET") throw new HttpError(405, "method_not_allowed");
      return store.publicCards(Array.from(publishers), limits);
    }

    throw new HttpError(404, "not_found");
  }

  return async function handle(req) {
    const origin = req.headers.origin || "";
    if (req.method === "OPTIONS") return { status: 204, headers: cors(origin), body: "" };
    try {
      limit("ip:" + req.ip, rates.ip);
      const data = await route(req);
      return json(200, data, origin);
    } catch (err) {
      if (err instanceof HttpError) {
        const extra = err.status === 429 && /^\d+$/.test(err.message) ? { "Retry-After": err.message } : undefined;
        return json(err.status, { error: err.code }, origin, extra);
      }
      log("Unhandled error:", err && err.stack ? err.stack : err);
      return json(500, { error: "server_error" }, origin);
    }
  };
}

module.exports = { createApp, publicUser };
