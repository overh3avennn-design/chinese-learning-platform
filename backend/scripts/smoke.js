"use strict";

// Проверка API после выкладки (GitHub Actions). Ничего секретного не печатает.
//   API_URL=https://….apigw.yandexcloud.net TELEGRAM_BOT_TOKEN=… node scripts/smoke.js
//
// Два тестовых пользователя Telegram с несуществующими id (9000000000001 и
// …002): входят через Mini App подписью настоящим токеном бота, пишут
// карточки и проверяют, что не видят и не меняют чужие. В конце свои
// тестовые колоды удаляют.

const { signInitData, signWidget } = require("../test/sign");

const API = (process.env.API_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
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

async function call(method, path, body, token) {
  const headers = { Origin: ORIGIN };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    // Первый вызов после выкладки — холодный старт; 5xx повторяем пару раз.
    if (res.status >= 500 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 200) }; }
    return { status: res.status, headers: res.headers, data };
  }
}

const now = () => Math.floor(Date.now() / 1000);
const login = (id) => call("POST", "/auth/telegram-miniapp", {
  initData: signInitData({ query_id: "smoke", user: { id, first_name: "Smoke", last_name: "Test " + id }, auth_date: String(now()) }, TOKEN)
});

// Новый шлюз отвечает не сразу (имя ещё не разошлось по DNS) — ждём до 2 минут.
async function waitReachable() {
  for (let i = 1; i <= 24; i++) {
    try {
      const res = await fetch(API + "/me");
      console.log("шлюз отвечает (HTTP " + res.status + ")");
      return;
    } catch (e) {
      console.log("шлюз ещё не отвечает (" + (e.cause && e.cause.code ? e.cause.code : e.message) + "), жду 5 с…");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error("API gateway is not reachable");
}

async function main() {
  console.log("API: " + API);
  await waitReachable();

  const pre = await fetch(API + "/cards", { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,content-type" } });
  check("CORS: preflight для сайта разрешён", pre.status === 204 && pre.headers.get("access-control-allow-origin") === ORIGIN, "status " + pre.status);

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
