"use strict";

// Проверка API после выкладки (GitHub Actions). Ничего секретного не печатает.
//   API_URL=https://….apigw.yandexcloud.net TELEGRAM_BOT_TOKEN=… node scripts/smoke.js
//
// Два тестовых пользователя Telegram с несуществующими id (9000000000001 и
// …002): входят через Mini App подписью настоящим токеном бота, пишут
// карточки и проверяют, что не видят и не меняют чужие. В конце свои
// тестовые колоды удаляют.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { signInitData, signWidget } = require("../test/sign");

const API = (process.env.API_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FUNCTION_NAME = process.env.FUNCTION_NAME || "";
const ORIGIN = process.env.SMOKE_ORIGIN || "https://overh3avennn-design.github.io";
if (!API || !TOKEN) {
  console.error("API_URL and TELEGRAM_BOT_TOKEN are required");
  process.exit(2);
}

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok || !detail ? "" : " — " + detail));
  if (!ok) failed += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Как доходят запросы: "gateway" — через API Gateway, как из браузера;
// "invoke" — прямо в функцию через `yc serverless function invoke` (событие
// в том же формате, что присылает шлюз), если шлюз не отвечает из сети GitHub.
let transport = "gateway";

function ycInvoke(event) {
  const file = path.join(os.tmpdir(), "smoke-event-" + process.pid + ".json");
  fs.writeFileSync(file, JSON.stringify(event), { mode: 0o600 });
  return new Promise((resolve, reject) => {
    execFile("yc", ["serverless", "function", "invoke", FUNCTION_NAME, "--data-file", file], { maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      fs.rmSync(file, { force: true });
      if (err) return reject(new Error("yc invoke failed: " + String(stderr || err.message).slice(0, 300)));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error("yc invoke: not JSON: " + String(stdout).slice(0, 200)));
      }
    });
  });
}

function useInvoke(reason) {
  if (transport === "invoke") return;
  if (!FUNCTION_NAME) throw new Error("API gateway is not reachable and FUNCTION_NAME is not set");
  transport = "invoke";
  console.log("\nВНИМАНИЕ: " + reason + " — дальше проверяю функцию напрямую (yc serverless function invoke).\n");
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, "SMOKE_TRANSPORT=invoke\n");
}

// Один запрос к API. Возвращает { status, header(name), text }.
async function send(method, pathAndQuery, headers, bodyText) {
  if (transport === "gateway") {
    // Из сети GitHub соединение со шлюзом иногда срывается (до части его
    // адресов не достучаться) — сетевую ошибку повторяем, потом идём в обход.
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(API + pathAndQuery, { method, headers, body: bodyText, signal: AbortSignal.timeout(15000) });
        return { status: res.status, header: (n) => res.headers.get(n), text: await res.text() };
      } catch (e) {
        const why = (e.cause && (e.cause.code || e.cause.message)) || e.name || e.message;
        console.log("  (сеть до шлюза: " + why + ", попытка " + attempt + ")");
        await sleep(2000);
      }
    }
    useInvoke("соединение со шлюзом из сети GitHub срывается");
  }
  const [p, qs] = pathAndQuery.split("?");
  const out = await ycInvoke({
    httpMethod: method,
    path: p,
    headers,
    multiValueHeaders: {},
    queryStringParameters: Object.fromEntries(new URLSearchParams(qs || "")),
    body: bodyText || "",
    isBase64Encoded: false,
    requestContext: { identity: { sourceIp: "198.51.100.7" } }
  });
  const h = {};
  for (const [k, v] of Object.entries(out.headers || {})) h[k.toLowerCase()] = v;
  return { status: out.statusCode, header: (n) => h[n.toLowerCase()] || null, text: out.body || "" };
}

async function call(method, path, body, token) {
  const headers = { Origin: ORIGIN };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  for (let attempt = 0; ; attempt++) {
    const res = await send(method, path, headers, body === undefined ? undefined : JSON.stringify(body));
    // Первый вызов после выкладки — холодный старт; 5xx повторяем пару раз.
    if (res.status >= 500 && attempt < 2) {
      await sleep(3000);
      continue;
    }
    let data = null;
    try { data = res.text ? JSON.parse(res.text) : null; } catch (e) { data = { raw: res.text.slice(0, 200) }; }
    return { status: res.status, header: res.header, data };
  }
}

const now = () => Math.floor(Date.now() / 1000);
const login = (id) => call("POST", "/auth/telegram-miniapp", {
  initData: signInitData({ query_id: "smoke", user: { id, first_name: "Smoke", last_name: "Test " + id }, auth_date: String(now()) }, TOKEN)
});

// Отвечает ли шлюз из сети GitHub (до 45 секунд).
async function gatewayReachable() {
  for (let i = 1; i <= 9; i++) {
    try {
      const res = await fetch(API + "/me", { signal: AbortSignal.timeout(10000) });
      console.log("шлюз отвечает (HTTP " + res.status + ")");
      return true;
    } catch (e) {
      const why = (e.cause && (e.cause.code || e.cause.message)) || e.name || e.message;
      console.log("шлюз не отвечает (" + why + "), попытка " + i);
      await sleep(5000);
    }
  }
  return false;
}

async function main() {
  console.log("API: " + API);
  if (!(await gatewayReachable())) useInvoke("шлюз не отвечает из сети GitHub");

  const pre = await send("OPTIONS", "/cards", { Origin: ORIGIN, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,content-type" });
  check("CORS: preflight для сайта разрешён", pre.status === 204 && pre.header("access-control-allow-origin") === ORIGIN, "status " + pre.status);

  check("GET /cards без пропуска → 401", (await call("GET", "/cards")).status === 401);
  check("PUT /cards без пропуска → 401", (await call("PUT", "/cards", { items: [] })).status === 401);
  check("GET /cards с поддельным пропуском → 401", (await call("GET", "/cards", undefined, "eyJhbGciOiJIUzI1NiJ9.e30.AAAA")).status === 401);

  const forged = signInitData({ user: { id: 9000000000001 }, auth_date: String(now()) }, TOKEN).replace(/hash=[0-9a-f]/, "hash=0");
  check("Mini App с испорченной подписью → 401", (await call("POST", "/auth/telegram-miniapp", { initData: forged })).status === 401);
  const old = signInitData({ user: { id: 9000000000001 }, auth_date: String(now() - 90000) }, TOKEN);
  check("Mini App старше суток → 401", (await call("POST", "/auth/telegram-miniapp", { initData: old })).status === 401);
  const asWidget = signWidget({ id: 9000000000001, first_name: "Smoke", auth_date: now() }, TOKEN);
  const asWidgetToMiniApp = new URLSearchParams({ user: JSON.stringify({ id: 9000000000001 }), auth_date: String(now()), hash: asWidget.hash });
  check("подпись виджета не подходит Mini App → 401", (await call("POST", "/auth/telegram-miniapp", { initData: asWidgetToMiniApp.toString() })).status === 401);
  check("Google с мусорным токеном → 401", (await call("POST", "/auth/google", { credential: "a.b.c" })).status === 401);

  const a = await login(9000000000001);
  check("вход Mini App (пользователь A) → 200", a.status === 200 && a.data && a.data.token, "status " + a.status + " " + JSON.stringify(a.data));
  const b = await login(9000000000002);
  check("вход Mini App (пользователь B) → 200", b.status === 200 && b.data && b.data.token, "status " + b.status);
  const w = await call("POST", "/auth/telegram-widget", { user: asWidget });
  check("вход виджетом тем же Telegram → тот же аккаунт A", w.status === 200 && w.data.user.id === (a.data && a.data.user.id), "status " + w.status);
  if (!a.data || !a.data.token || !b.data || !b.data.token) throw new Error("login failed, stopping");
  const A = a.data;
  const B = b.data;

  const stamp = Date.now();
  const deck = { title: "smoke A " + stamp, words: [{ hanzi: "测试", pinyin: "cè shì", translation: "тест" }] };
  const put = await call("PUT", "/cards", { items: [{ id: "deck:smoke-a", data: deck, updatedAt: stamp }] }, A.token);
  check("A записывает колоду → ok", put.status === 200 && put.data.results[0].status === "ok", "status " + put.status + " " + JSON.stringify(put.data));

  const aGet = await call("GET", "/cards", undefined, A.token);
  const aDeck = aGet.data && aGet.data.items && aGet.data.items.find((i) => i.id === "deck:smoke-a");
  check("A видит свою колоду", aGet.status === 200 && aDeck && aDeck.data.title === deck.title, "status " + aGet.status);

  const bGet = await call("GET", "/cards", undefined, B.token);
  const bSees = bGet.data && bGet.data.items && bGet.data.items.find((i) => i.id === "deck:smoke-a" && i.data && i.data.title === deck.title);
  check("B не видит колоду A", bGet.status === 200 && !bSees, "status " + bGet.status);

  const hijack = await call("PUT", "/cards?user_id=" + encodeURIComponent(A.user.id),
    { user_id: A.user.id, userId: A.user.id, items: [{ id: "deck:smoke-a", data: { title: "hijack", words: [] }, updatedAt: stamp + 1000 }] }, B.token);
  const aAfter = await call("GET", "/cards", undefined, A.token);
  const still = aAfter.data.items.find((i) => i.id === "deck:smoke-a");
  check("B с чужим user_id не меняет колоду A", hijack.status === 200 && still && still.data.title === deck.title, "status " + hijack.status);

  const cur = aAfter.data.cursor;
  const empty = await call("GET", "/cards?rev=" + cur.rev + "&id=" + encodeURIComponent(cur.id), undefined, A.token);
  check("курсор: без изменений — пустой ответ", empty.status === 200 && empty.data.items.length === 0, JSON.stringify(empty.data).slice(0, 200));

  const me = await call("GET", "/me", undefined, A.token);
  check("GET /me → A", me.status === 200 && me.data.user.id === A.user.id && me.data.user.telegram === true);

  // уборка
  const delA = await call("PUT", "/cards", { items: [{ id: "deck:smoke-a", deleted: true, updatedAt: Date.now() }] }, A.token);
  const delB = await call("PUT", "/cards", { items: [{ id: "deck:smoke-a", deleted: true, updatedAt: Date.now() + 2000 }] }, B.token);
  check("уборка тестовых колод", delA.status === 200 && delB.status === 200);

  console.log(failed ? "\nSMOKE FAILED: " + failed + " check(s)" : "\nSMOKE OK");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Smoke crashed:", err && err.message ? err.message : err);
  process.exit(1);
});
