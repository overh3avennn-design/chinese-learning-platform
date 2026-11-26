"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createApp } = require("../src/app");
const { createMemoryStore } = require("./memory-store");
const { signInitData, signWidget, makeGoogleSigner } = require("./sign");

const TOKEN = "1234567890:TEST_test-token_ABCDEFGHIJKLMNOPQRSTUV";
const CLIENT = "123-abc.apps.googleusercontent.com";
const ORIGIN = "https://overh3avennn-design.github.io";
const g = makeGoogleSigner();

function setup(opts) {
  let clock = 1_800_000_000_000;
  const store = createMemoryStore();
  const app = createApp(Object.assign({
    store,
    config: { botToken: TOKEN, googleClientId: CLIENT, jwtSecret: crypto.randomBytes(48).toString("base64"), allowedOrigins: [ORIGIN] },
    getGoogleKey: g.getKey,
    now: () => clock,
    log: () => {}
  }, opts));
  async function call(method, path, body, token, extra) {
    const [p, qs] = path.split("?");
    const res = await app(Object.assign({
      method, path: p, query: Object.fromEntries(new URLSearchParams(qs || "")),
      headers: Object.assign({ origin: ORIGIN }, token ? { authorization: "Bearer " + token } : {}),
      body: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body),
      ip: "10.0.0.1"
    }, extra));
    return { status: res.status, headers: res.headers, data: res.body ? JSON.parse(res.body) : null };
  }
  const nowS = () => Math.floor(clock / 1000);
  const tg = (id) => call("POST", "/auth/telegram-miniapp", { initData: signInitData({ user: { id, first_name: "U" + id }, auth_date: String(nowS()) }, TOKEN) });
  const widget = (id) => signWidget({ id, first_name: "W" + id, auth_date: nowS() }, TOKEN);
  const google = (sub) => g.sign({ iss: "accounts.google.com", aud: CLIENT, sub, name: "G" + sub, iat: nowS(), exp: nowS() + 3600 });
  return { app, store, call, tg, widget, google, tick: (ms) => { clock += ms; }, now: () => clock };
}

const deck = (title) => ({ title, words: [{ hanzi: "你好", pinyin: "nǐ hǎo", translation: "привет" }] });

test("без пропуска и с плохим пропуском — 401", async () => {
  const { call } = setup();
  assert.equal((await call("GET", "/cards")).status, 401);
  assert.equal((await call("PUT", "/cards", { items: [] })).status, 401);
  assert.equal((await call("GET", "/me")).status, 401);
  assert.equal((await call("GET", "/cards", undefined, "abc.def.ghi")).status, 401);
  assert.equal((await call("POST", "/auth/link/google", { credential: "x" })).status, 401);
});

test("CORS: свой сайт — да, чужой — без разрешающих заголовков", async () => {
  const { call } = setup();
  const pre = await call("OPTIONS", "/cards");
  assert.equal(pre.status, 204);
  assert.equal(pre.headers["Access-Control-Allow-Origin"], ORIGIN);
  const evil = await call("OPTIONS", "/cards", undefined, null, { headers: { origin: "https://evil.example" } });
  assert.equal(evil.headers["Access-Control-Allow-Origin"], undefined);
});

test("вход через Mini App, виджет и Google; тот же человек — тот же аккаунт", async () => {
  const { call, tg, widget, google } = setup();
  const a = await tg(111);
  assert.equal(a.status, 200);
  assert.ok(a.data.token);
  assert.deepEqual([a.data.user.telegram, a.data.user.google], [true, false]);
  const b = await call("POST", "/auth/telegram-widget", { user: widget(111) });
  assert.equal(b.data.user.id, a.data.user.id);           // тот же Telegram — тот же аккаунт
  const c = await call("POST", "/auth/google", { credential: google("g-1") });
  assert.equal(c.status, 200);
  assert.notEqual(c.data.user.id, a.data.user.id);
  const me = await call("GET", "/me", undefined, a.data.token);
  assert.equal(me.data.user.name, "W111");
});

test("поддельный вход — 401, мусор — 400", async () => {
  const { call, widget } = setup();
  const w = widget(5);
  w.id = 6;
  assert.equal((await call("POST", "/auth/telegram-widget", { user: w })).status, 401);
  assert.equal((await call("POST", "/auth/telegram-miniapp", { initData: "user=%7B%22id%22%3A1%7D&auth_date=1&hash=" + "0".repeat(64) })).status, 401);
  assert.equal((await call("POST", "/auth/google", { credential: "a.b.c" })).status, 401);
  assert.equal((await call("POST", "/auth/google", "{not json")).status, 400);
  assert.equal((await call("POST", "/auth/unknown", {})).status, 404);
  assert.equal((await call("GET", "/auth/google")).status, 405);
});

test("карточки: свои видны, чужие — нет, user_id из тела не действует", async () => {
  const { call, tg, tick } = setup();
  const A = (await tg(1)).data;
  const B = (await tg(2)).data;
  const put = await call("PUT", "/cards", { items: [{ id: "deck:my-a", data: deck("A"), updatedAt: 1 }] }, A.token);
  assert.equal(put.status, 200);
  assert.equal(put.data.results[0].status, "ok");

  const bView = await call("GET", "/cards", undefined, B.token);
  assert.deepEqual(bView.data.items, []);

  // B пытается записать в аккаунт A, подставив его id
  tick(1000);
  await call("PUT", "/cards", { user_id: A.user.id, userId: A.user.id, items: [{ id: "deck:my-a", data: deck("взлом"), updatedAt: 999999 }] }, B.token);
  const aView = await call("GET", "/cards?user_id=" + A.user.id, undefined, A.token);
  assert.equal(aView.data.items.length, 1);
  assert.equal(aView.data.items[0].data.title, "A");
  const bView2 = await call("GET", "/cards", undefined, B.token);
  assert.equal(bView2.data.items[0].data.title, "взлом");  // попало в свой же аккаунт B
});

test("карточки: новее побеждает, удаление доходит, курсор отдаёт только новое", async () => {
  const { call, tg, tick } = setup();
  const A = (await tg(1)).data;
  await call("PUT", "/cards", { items: [{ id: "deck:x", data: deck("v2"), updatedAt: 200 }] }, A.token);
  tick(10);
  const stale = await call("PUT", "/cards", { items: [{ id: "deck:x", data: deck("v1"), updatedAt: 100 }] }, A.token);
  assert.equal(stale.data.results[0].status, "stale");
  const all = await call("GET", "/cards", undefined, A.token);
  assert.equal(all.data.items[0].data.title, "v2");
  const cur = all.data.cursor;
  const none = await call("GET", "/cards?rev=" + cur.rev + "&id=" + encodeURIComponent(cur.id), undefined, A.token);
  assert.deepEqual(none.data.items, []);
  tick(10);
  await call("PUT", "/cards", { items: [{ id: "deck:x", deleted: true, updatedAt: 300 }] }, A.token);
  const after = await call("GET", "/cards?rev=" + cur.rev + "&id=" + encodeURIComponent(cur.id), undefined, A.token);
  assert.equal(after.data.items.length, 1);
  assert.equal(after.data.items[0].deleted, true);
});

test("карточки: проверка строк — id, размер, повтор, число строк", async () => {
  const { call, tg } = setup();
  const A = (await tg(1)).data;
  const put = (items) => call("PUT", "/cards", { items }, A.token);
  assert.equal((await put([{ id: "../etc", data: {}, updatedAt: 1 }])).status, 400);
  assert.equal((await put([{ id: "deck:a", data: "str", updatedAt: 1 }])).status, 400);
  assert.equal((await put([{ id: "deck:a", data: {}, updatedAt: 1 }, { id: "deck:a", data: {}, updatedAt: 1 }])).status, 400);
  assert.equal((await put([{ id: "deck:a", data: { t: "x".repeat(140 * 1024) }, updatedAt: 1 }])).status, 413);
  const many = Array.from({ length: 101 }, (_, i) => ({ id: "deck:a" + i, data: {}, updatedAt: 1 }));
  assert.equal((await put(many)).status, 413);
  assert.equal((await call("PUT", "/cards", "x".repeat(1024 * 1024 + 1), A.token)).status, 413);
});

test("квоты: всего строк и байт на пользователя, суточный лимит записей", async () => {
  const { call, tg } = setup({ limits: { maxRows: 3, maxBytes: 4000, writesPerDay: 5 } });
  const A = (await tg(1)).data;
  const items = Array.from({ length: 4 }, (_, i) => ({ id: "deck:q" + i, data: { t: "x" }, updatedAt: 1 }));
  const r = await call("PUT", "/cards", { items }, A.token);
  assert.deepEqual(r.data.results.map((x) => x.status), ["ok", "ok", "ok", "quota"]);
  const big = await call("PUT", "/cards", { items: [{ id: "deck:q0", data: { t: "x".repeat(5000) }, updatedAt: 2 }] }, A.token);
  assert.equal(big.data.results[0].status, "quota");
  for (let i = 0; i < 3; i++) await call("PUT", "/cards", { items: [{ id: "deck:q1", data: { t: "y" }, updatedAt: 10 + i }] }, A.token);
  assert.equal((await call("PUT", "/cards", { items: [{ id: "deck:q1", data: { t: "z" }, updatedAt: 99 }] }, A.token)).status, 429);
});

test("частота: больше 60 запросов в минуту от пользователя — 429, через минуту снова можно", async () => {
  const { call, tg, tick } = setup({ rates: { ip: 1000, ipAuth: 1000, user: 60 } });
  const A = (await tg(1)).data;
  let last;
  for (let i = 0; i < 61; i++) last = await call("GET", "/cards", undefined, A.token);
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers["Retry-After"]) > 0);
  tick(61000);
  assert.equal((await call("GET", "/cards", undefined, A.token)).status, 200);
});

test("частота: входы с одного IP ограничены", async () => {
  const { tg } = setup({ rates: { ip: 1000, ipAuth: 3, user: 1000 } });
  for (let i = 0; i < 3; i++) assert.equal((await tg(1)).status, 200);
  assert.equal((await tg(1)).status, 429);
});

test("пагинация: большой аккаунт отдаётся страницами без пропусков", async () => {
  const { call, tg, tick } = setup({ limits: { pullPageRows: 7 } });
  const A = (await tg(1)).data;
  for (let b = 0; b < 3; b++) {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: "progress:d" + b + "-" + i, data: { words: {} }, updatedAt: 1 }));
    await call("PUT", "/cards", { items }, A.token);
    tick(5);
  }
  const got = new Set();
  let cursor = { rev: 0, id: "" };
  for (let guard = 0; guard < 20; guard++) {
    const r = await call("GET", "/cards?rev=" + cursor.rev + "&id=" + encodeURIComponent(cursor.id), undefined, A.token);
    r.data.items.forEach((it) => got.add(it.id));
    cursor = r.data.cursor;
    if (!r.data.more) break;
  }
  assert.equal(got.size, 30);
});

test("привязка: Google к Telegram-аккаунту, потом вход через Google — тот же аккаунт", async () => {
  const { call, tg, google } = setup();
  const A = (await tg(1)).data;
  const l = await call("POST", "/auth/link/google", { credential: google("g-9") }, A.token);
  assert.equal(l.status, 200);
  assert.deepEqual([l.data.user.telegram, l.data.user.google, l.data.merged], [true, true, false]);
  const viaGoogle = await call("POST", "/auth/google", { credential: google("g-9") });
  assert.equal(viaGoogle.data.user.id, A.user.id);
  // второй Google к тому же аккаунту — нельзя
  assert.equal((await call("POST", "/auth/link/google", { credential: google("g-10") }, A.token)).status, 409);
});

test("привязка со слиянием: карточки второго аккаунта переезжают, ничего не теряется", async () => {
  const { call, tg, google, widget, tick } = setup();
  const A = (await tg(1)).data;                              // телефон: Telegram
  const G = (await call("POST", "/auth/google", { credential: google("g-1") })).data;   // ноутбук: Google
  await call("PUT", "/cards", { items: [
    { id: "deck:my-phone", data: deck("с телефона"), updatedAt: 10 },
    { id: "progress:hsk1", data: { words: { "你|nǐ": "learning", "好|hǎo": "learned" } }, updatedAt: 10 },
    { id: "folders", data: [{ id: "f1", title: "Папка", decks: ["a"] }], updatedAt: 10 }
  ] }, A.token);
  await call("PUT", "/cards", { items: [
    { id: "deck:my-laptop", data: deck("с ноутбука"), updatedAt: 20 },
    { id: "progress:hsk1", data: { words: { "你|nǐ": "learned", "我|wǒ": "learning" } }, updatedAt: 20 },
    { id: "folders", data: [{ id: "f1", title: "Папка", decks: ["b"] }, { id: "f2", title: "Вторая", decks: [] }], updatedAt: 20 }
  ] }, G.token);
  tick(100);
  const l = await call("POST", "/auth/link/google", { credential: google("g-1") }, A.token);
  assert.equal(l.status, 200);
  assert.equal(l.data.merged, true);
  const all = (await call("GET", "/cards", undefined, A.token)).data.items;
  const byId = Object.fromEntries(all.map((i) => [i.id, i.data]));
  assert.ok(byId["deck:my-phone"] && byId["deck:my-laptop"]);
  assert.deepEqual(byId["progress:hsk1"].words, { "你|nǐ": "learned", "好|hǎo": "learned", "我|wǒ": "learning" });
  assert.deepEqual(byId.folders.map((f) => f.id), ["f1", "f2"]);
  assert.deepEqual(byId.folders[0].decks.sort(), ["a", "b"]);
  // старый пропуск слитого аккаунта больше не работает
  assert.equal((await call("GET", "/cards", undefined, G.token)).status, 401);
  // вход через Google теперь ведёт в общий аккаунт
  assert.equal((await call("POST", "/auth/google", { credential: google("g-1") })).data.user.id, A.user.id);
  // аккаунт с двумя входами в третий не сливается
  const T2 = (await call("POST", "/auth/telegram-widget", { user: widget(2) })).data;
  assert.equal((await call("POST", "/auth/link/google", { credential: google("g-1") }, T2.token)).status, 409);
});

// ------------------------------------------------------- общие папки
const PUB = 777;                     // Telegram id издателя (преподавателя) в тестах
const W = (h, t) => ({ hanzi: h, pinyin: "", translation: t });

test("общие папки: у любого пользователя видна папка с отметкой и только её колоды", async () => {
  const { call, tg, tick, store } = setupPublisher();
  const P = (await tg(PUB)).data;
  const U = (await tg(5)).data;
  assert.equal(P.user.publisher, true);
  assert.equal(U.user.publisher, false);
  await call("PUT", "/cards", { items: [
    { id: "deck:conf-1", data: { title: "01.10-conf", words: [{ hanzi: "石头", pinyin: "shítou", translation: "камень", secret: "x" }] }, updatedAt: 10 },
    { id: "deck:conf-2", data: { title: "21.10-conf", words: [W("碎", "разбить")] }, updatedAt: 10 },
    { id: "deck:private", data: { title: "Личная", words: [W("秘密", "секрет")] }, updatedAt: 10 },
    { id: "progress:conf-1", data: { words: { "石头|shítou": "learned" } }, updatedAt: 10 },
    { id: "folders", data: [
      { id: "folder-conf", title: "конфуций", decks: ["conf-1", "conf-2", "26-09-conf"], public: true },
      { id: "folder-mine", title: "Мои", decks: ["private", "conf-1"] }
    ], updatedAt: 10 }
  ] }, P.token);
  tick(100);
  // Ученик публикует свою папку и пытается подложить в неё колоду учителя
  // своей колодой с тем же id.
  await call("PUT", "/cards", { items: [
    { id: "deck:u-deck", data: { title: "Мои слова", words: [W("书", "книга")] }, updatedAt: 10 },
    { id: "deck:conf-1", data: { title: "ПОДМЕНА", words: [W("假", "подделка")] }, updatedAt: 10 },
    { id: "deck:u-private", data: { title: "Только мне", words: [W("我", "я")] }, updatedAt: 10 },
    { id: "folders", data: [
      { id: "f-u", title: "Для всех", decks: ["u-deck", "conf-1", "u-gone"], public: true },
      { id: "f-u-me", title: "Себе", decks: ["u-private"] }
    ], updatedAt: 10 }
  ] }, U.token);
  // без входа
  const r = await call("GET", "/public");
  assert.equal(r.status, 200);
  assert.equal(r.headers["Cache-Control"], "no-store");
  assert.deepEqual(r.data.folders, [
    { id: "folder-conf", title: "конфуций", decks: ["conf-1", "conf-2"] },     // учитель — первым; 26-09-conf нет
    { id: "f-u", title: "Для всех", decks: ["u-deck"] }                         // conf-1 ученика не подкладывается
  ]);
  assert.deepEqual(r.data.decks.map((d) => d.id), ["conf-1", "conf-2", "u-deck"]);
  assert.deepEqual(r.data.decks[0].words, [{ hanzi: "石头", pinyin: "shítou", translation: "камень" }]);
  const text = JSON.stringify(r.data);
  assert.ok(!/秘密|Личная|folder-mine|progress|secret|learned|ПОДМЕНА|Только мне|f-u-me/.test(text), text);
  assert.deepEqual(Array.from(store.publicOwners.keys()).sort(), [P.user.id, U.user.id].sort());
  // свои карточки по-прежнему видит только владелец
  const theirs = (await call("GET", "/cards", undefined, U.token)).data.items.map((i) => i.id).sort();
  assert.deepEqual(theirs, ["deck:conf-1", "deck:u-deck", "deck:u-private", "folders"]);
  assert.equal((await call("PUT", "/public", {})).status, 405);
});

test("общие папки: без издателей в настройках видны папки учеников", async () => {
  const { call, tg, tick } = setup();
  const A = (await tg(41)).data;
  assert.deepEqual((await call("GET", "/public")).data, { folders: [], decks: [] });
  await call("PUT", "/cards", { items: [
    { id: "deck:a", data: { title: "A", words: [W("一", "один")] }, updatedAt: 10 },
    { id: "folders", data: [{ id: "f", title: "Общая", decks: ["a"], public: true }], updatedAt: 10 }
  ] }, A.token);
  tick(61000);                       // ответ помнится минуту
  const r = await call("GET", "/public");
  assert.deepEqual(r.data.folders, [{ id: "f", title: "Общая", decks: ["a"] }]);
  assert.deepEqual(r.data.decks.map((d) => d.id), ["a"]);
});

test("общие папки: снятая отметка или удалённая колода пропадают из общего доступа", async () => {
  const { call, tg, tick, store } = setup();
  const A = (await tg(42)).data;
  await call("PUT", "/cards", { items: [
    { id: "deck:a", data: { title: "A", words: [W("一", "один")] }, updatedAt: 10 },
    { id: "deck:b", data: { title: "B", words: [W("二", "два")] }, updatedAt: 10 },
    { id: "folders", data: [{ id: "f", title: "conf", decks: ["a", "b"], public: true }], updatedAt: 10 }
  ] }, A.token);
  assert.deepEqual((await call("GET", "/public")).data.decks.map((d) => d.id), ["a", "b"]);
  tick(61000);                       // ответ помнится минуту
  await call("PUT", "/cards", { items: [{ id: "deck:b", deleted: true, updatedAt: 20 }] }, A.token);
  assert.deepEqual((await call("GET", "/public")).data.decks.map((d) => d.id), ["a"]);
  tick(61000);
  await call("PUT", "/cards", { items: [{ id: "folders", data: [{ id: "f", title: "conf", decks: ["a"] }], updatedAt: 30 }] }, A.token);
  assert.deepEqual((await call("GET", "/public")).data, { folders: [], decks: [] });
  assert.equal(store.publicOwners.has(A.user.id), false);
});

test("общие папки: при слиянии аккаунтов общая папка остаётся общей", async () => {
  const { call, tg, google, tick, store } = setup();
  const A = (await tg(43)).data;
  const G = (await call("POST", "/auth/google", { credential: google("g-43") })).data;
  await call("PUT", "/cards", { items: [
    { id: "deck:g", data: { title: "Из Google", words: [W("好", "хорошо")] }, updatedAt: 10 },
    { id: "folders", data: [{ id: "fg", title: "Общая из Google", decks: ["g"], public: true }], updatedAt: 10 }
  ] }, G.token);
  assert.ok(store.publicOwners.has(G.user.id));
  tick(100);
  const l = await call("POST", "/auth/link/google", { credential: google("g-43") }, A.token);
  assert.equal(l.data.merged, true);
  assert.equal(store.publicOwners.has(G.user.id), false);
  assert.equal(store.publicOwners.has(A.user.id), true);
  tick(61000);
  const r = await call("GET", "/public");
  assert.deepEqual(r.data.folders.map((f) => f.id), ["fg"]);
  assert.deepEqual(r.data.decks.map((d) => d.id), ["g"]);
});

function setupPublisher() {
  const base = setup();
  const app = createApp({
    store: base.store,
    config: { botToken: TOKEN, googleClientId: CLIENT, jwtSecret: crypto.randomBytes(48).toString("base64"), allowedOrigins: [ORIGIN], publisherTelegramIds: [String(PUB)] },
    getGoogleKey: g.getKey,
    now: base.now,
    log: () => {}
  });
  async function call(method, path, body, token) {
    const [p, qs] = path.split("?");
    const res = await app({
      method, path: p, query: Object.fromEntries(new URLSearchParams(qs || "")),
      headers: Object.assign({ origin: ORIGIN }, token ? { authorization: "Bearer " + token } : {}),
      body: body === undefined ? "" : JSON.stringify(body), ip: "10.0.0.2"
    });
    return { status: res.status, headers: res.headers, data: res.body ? JSON.parse(res.body) : null };
  }
  const tg = (id) => call("POST", "/auth/telegram-miniapp", { initData: signInitData({ user: { id, first_name: "U" + id }, auth_date: String(Math.floor(base.now() / 1000)) }, TOKEN) });
  return { call, tg, tick: base.tick, store: base.store };
}
