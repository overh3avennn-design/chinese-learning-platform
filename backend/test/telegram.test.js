"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyMiniAppInitData, verifyLoginWidget } = require("../src/telegram");
const { signInitData, signWidget } = require("./sign");

const TOKEN = "1234567890:TEST_test-token_ABCDEFGHIJKLMNOPQRSTUV";
const OTHER = "1234567890:OTHER_token_ABCDEFGHIJKLMNOPQRSTUVWX";
const NOW = 1_800_000_000_000;               // мс
const NOW_S = NOW / 1000;
const USER = { id: 424242, first_name: "Иван", last_name: "Петров", username: "ivan", photo_url: "https://t.me/i/userpic/1.jpg" };

function initData(extra) {
  return signInitData(Object.assign({ query_id: "AAE1", user: USER, auth_date: String(NOW_S - 60) }, extra), TOKEN);
}

const code = (c) => (err) => err.code === c;

test("Mini App: настоящая initData принимается", () => {
  const r = verifyMiniAppInitData(initData(), TOKEN, { now: NOW });
  assert.equal(r.telegramId, 424242);
  assert.equal(r.name, "Иван Петров");
  assert.equal(r.photo, USER.photo_url);
});

test("Mini App: initData с полем signature принимается", () => {
  const r = verifyMiniAppInitData(initData({ signature: "c2lnbmF0dXJl" }), TOKEN, { now: NOW });
  assert.equal(r.telegramId, 424242);
});

test("Mini App: подмена пользователя после подписи — отказ", () => {
  const forged = initData().replace(/user=[^&]+/, "user=" + encodeURIComponent(JSON.stringify(Object.assign({}, USER, { id: 1 }))));
  assert.throws(() => verifyMiniAppInitData(forged, TOKEN, { now: NOW }), code("bad_signature"));
});

test("Mini App: подпись чужим токеном — отказ", () => {
  const data = signInitData({ user: USER, auth_date: String(NOW_S) }, OTHER);
  assert.throws(() => verifyMiniAppInitData(data, TOKEN, { now: NOW }), code("bad_signature"));
});

test("Mini App: без hash и с испорченным hash — отказ", () => {
  const data = initData();
  assert.throws(() => verifyMiniAppInitData(data.replace(/&?hash=[0-9a-f]+/, ""), TOKEN, { now: NOW }), code("bad_signature"));
  assert.throws(() => verifyMiniAppInitData(data.replace(/hash=([0-9a-f])/, (m, c) => "hash=" + (c === "a" ? "b" : "a")), TOKEN, { now: NOW }), code("bad_signature"));
  assert.throws(() => verifyMiniAppInitData(data + "&hash=00", TOKEN, { now: NOW }), code("bad_init_data"));
});

test("Mini App: старше суток — отказ, ровно сутки — ещё можно", () => {
  const old = signInitData({ user: USER, auth_date: String(NOW_S - 86401) }, TOKEN);
  assert.throws(() => verifyMiniAppInitData(old, TOKEN, { now: NOW }), code("auth_expired"));
  const edge = signInitData({ user: USER, auth_date: String(NOW_S - 86400) }, TOKEN);
  assert.equal(verifyMiniAppInitData(edge, TOKEN, { now: NOW }).telegramId, 424242);
});

test("Mini App: auth_date из будущего и мусор — отказ", () => {
  const future = signInitData({ user: USER, auth_date: String(NOW_S + 3600) }, TOKEN);
  assert.throws(() => verifyMiniAppInitData(future, TOKEN, { now: NOW }), code("bad_auth_date"));
  const noDate = signInitData({ user: USER }, TOKEN);
  assert.throws(() => verifyMiniAppInitData(noDate, TOKEN, { now: NOW }), code("bad_auth_date"));
  assert.throws(() => verifyMiniAppInitData("", TOKEN, { now: NOW }), code("bad_init_data"));
  assert.throws(() => verifyMiniAppInitData({}, TOKEN, { now: NOW }), code("bad_init_data"));
});

test("Mini App: подписанные данные без пользователя — отказ", () => {
  const data = signInitData({ auth_date: String(NOW_S) }, TOKEN);
  assert.throws(() => verifyMiniAppInitData(data, TOKEN, { now: NOW }), code("bad_user"));
});

const WIDGET = { id: 424242, first_name: "Иван", username: "ivan", photo_url: "https://t.me/i/userpic/1.jpg", auth_date: NOW_S - 30 };

test("Виджет: настоящие данные принимаются", () => {
  const r = verifyLoginWidget(signWidget(WIDGET, TOKEN), TOKEN, { now: NOW });
  assert.equal(r.telegramId, 424242);
  assert.equal(r.name, "Иван");
});

test("Виджет: подмена id, чужой токен, срок — отказ", () => {
  const signed = signWidget(WIDGET, TOKEN);
  assert.throws(() => verifyLoginWidget(Object.assign({}, signed, { id: 1 }), TOKEN, { now: NOW }), code("bad_signature"));
  assert.throws(() => verifyLoginWidget(signWidget(WIDGET, OTHER), TOKEN, { now: NOW }), code("bad_signature"));
  const old = signWidget(Object.assign({}, WIDGET, { auth_date: NOW_S - 90000 }), TOKEN);
  assert.throws(() => verifyLoginWidget(old, TOKEN, { now: NOW }), code("auth_expired"));
  assert.throws(() => verifyLoginWidget(Object.assign({}, signed, { hash: undefined }), TOKEN, { now: NOW }), code("bad_signature"));
  assert.throws(() => verifyLoginWidget(Object.assign({}, signed, { extra: { a: 1 } }), TOKEN, { now: NOW }), code("bad_widget_data"));
  assert.throws(() => verifyLoginWidget(null, TOKEN, { now: NOW }), code("bad_widget_data"));
});

// Алгоритмы нельзя перепутать: подпись одного вида не принимается другим.
test("Алгоритмы не путаются: подпись Mini App не подходит виджету и наоборот", () => {
  const fields = { id: 424242, first_name: "Иван", auth_date: NOW_S };
  // данные виджета, подписанные по-мини-апповски
  const crypto = require("crypto");
  const all = {};
  for (const [k, v] of Object.entries(fields)) all[k] = String(v);
  const dcs = Object.keys(all).sort().map((k) => k + "=" + all[k]).join("\n");
  const miniSecret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
  const wrongWidget = Object.assign({}, fields, { hash: crypto.createHmac("sha256", miniSecret).update(dcs).digest("hex") });
  assert.throws(() => verifyLoginWidget(wrongWidget, TOKEN, { now: NOW }), code("bad_signature"));

  // initData, подписанная по-виджетному
  const widgetSecret = crypto.createHash("sha256").update(TOKEN).digest();
  const payload = { auth_date: String(NOW_S), user: JSON.stringify(USER) };
  const dcs2 = Object.keys(payload).sort().map((k) => k + "=" + payload[k]).join("\n");
  const params = new URLSearchParams(payload);
  params.set("hash", crypto.createHmac("sha256", widgetSecret).update(dcs2).digest("hex"));
  assert.throws(() => verifyMiniAppInitData(params.toString(), TOKEN, { now: NOW }), code("bad_signature"));
});

test("Фото не по https отбрасывается", () => {
  const r = verifyLoginWidget(signWidget(Object.assign({}, WIDGET, { photo_url: "javascript:alert(1)" }), TOKEN), TOKEN, { now: NOW });
  assert.equal(r.photo, "");
});
