"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { requestFromEvent } = require("../src/event");

const ctx = { identity: { sourceIp: "203.0.113.5" } };

test("событие шлюза: путь, заголовки, тело как есть", () => {
  const r = requestFromEvent({
    httpMethod: "put", path: "/cards", headers: { Authorization: "Bearer abc", Origin: "https://x" },
    queryStringParameters: { rev: "5" }, body: '{"items":[]}', isBase64Encoded: false, requestContext: ctx
  });
  assert.equal(r.method, "PUT");
  assert.equal(r.path, "/cards");
  assert.equal(r.headers.authorization, "Bearer abc");
  assert.equal(r.headers.origin, "https://x");
  assert.deepEqual(r.query, { rev: "5" });
  assert.equal(r.ip, "203.0.113.5");
});

test("прямой вызов: маршрут из ?r, метод из ?m, пропуск из _token", () => {
  const r = requestFromEvent({
    httpMethod: "POST", path: "", headers: { "Content-Type": "text/plain;charset=UTF-8" },
    queryStringParameters: { r: "/cards", m: "GET", rev: "7", id: "deck:a" },
    body: JSON.stringify({ _token: "jwt-123" }), requestContext: ctx
  });
  assert.equal(r.method, "GET");
  assert.equal(r.path, "/cards");
  assert.deepEqual(r.query, { rev: "7", id: "deck:a" });
  assert.equal(r.headers.authorization, "Bearer jwt-123");
  assert.equal(r.body, "{}");
});

test("прямой вызов: тело без _token остаётся, метод по умолчанию POST", () => {
  const body = JSON.stringify({ initData: "query_id=1&hash=00" });
  const r = requestFromEvent({ httpMethod: "POST", path: "", queryStringParameters: { r: "/auth/telegram-miniapp" }, body });
  assert.equal(r.method, "POST");
  assert.equal(r.path, "/auth/telegram-miniapp");
  assert.equal(r.body, body);
  assert.equal(r.headers.authorization, undefined);
});

test("прямой вызов: PUT с карточками, тело в base64", () => {
  const body = Buffer.from(JSON.stringify({ items: [{ id: "deck:a" }], _token: "t" })).toString("base64");
  const r = requestFromEvent({ httpMethod: "POST", path: "", queryStringParameters: { r: "/cards", m: "PUT" }, body, isBase64Encoded: true });
  assert.equal(r.method, "PUT");
  assert.deepEqual(JSON.parse(r.body), { items: [{ id: "deck:a" }] });
  assert.equal(r.headers.authorization, "Bearer t");
});

test("прямой вызов: чужие методы и мусор не проходят", () => {
  const r = requestFromEvent({ httpMethod: "POST", path: "", queryStringParameters: { r: "/cards", m: "DELETE" }, body: "not json" });
  assert.equal(r.method, "POST");
  assert.equal(r.body, "not json");
  const noRoute = requestFromEvent({ httpMethod: "GET", path: "", queryStringParameters: { r: "cards" } });
  assert.equal(noRoute.path, "/");
  const opt = requestFromEvent({ httpMethod: "OPTIONS", path: "", queryStringParameters: { r: "/cards", m: "PUT" } });
  assert.equal(opt.method, "OPTIONS");
});
