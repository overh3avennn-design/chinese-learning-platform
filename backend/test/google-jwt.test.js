"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { verifyGoogleIdToken, createJwksCache } = require("../src/google");
const { signToken, verifyToken } = require("../src/jwt");
const { makeGoogleSigner } = require("./sign");

const CLIENT = "123-abc.apps.googleusercontent.com";
const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;
const g = makeGoogleSigner();
const base = { iss: "https://accounts.google.com", aud: CLIENT, sub: "1098765", name: "Ivan", picture: "https://lh3.googleusercontent.com/a/x", iat: NOW_S - 10, exp: NOW_S + 3600 };
const verify = (t, extra) => verifyGoogleIdToken(t, Object.assign({ clientId: CLIENT, getKey: g.getKey, now: NOW }, extra));
const code = (c) => (err) => err.code === c;

test("Google: настоящий токен принимается (оба вида iss)", async () => {
  assert.equal((await verify(g.sign(base))).googleSub, "1098765");
  assert.equal((await verify(g.sign(Object.assign({}, base, { iss: "accounts.google.com" })))).name, "Ivan");
});

test("Google: чужой aud, чужой iss, истёкший — отказ", async () => {
  await assert.rejects(verify(g.sign(Object.assign({}, base, { aud: "other.apps.googleusercontent.com" }))), code("bad_audience"));
  await assert.rejects(verify(g.sign(Object.assign({}, base, { iss: "https://evil.example" }))), code("bad_issuer"));
  await assert.rejects(verify(g.sign(Object.assign({}, base, { exp: NOW_S - 120 }))), code("token_expired"));
  await assert.rejects(verify(g.sign(Object.assign({}, base, { exp: undefined }))), code("token_expired"));
});

test("Google: подмена данных, чужой ключ, неизвестный kid — отказ", async () => {
  const t = g.sign(base).split(".");
  const forged = t[0] + "." + Buffer.from(JSON.stringify(Object.assign({}, base, { sub: "1" }))).toString("base64url") + "." + t[2];
  await assert.rejects(verify(forged), code("bad_signature"));
  const other = makeGoogleSigner();
  const otherToken = other.sign(base, { kid: g.kid });          // подписан чужим ключом под нашим kid
  await assert.rejects(verify(otherToken), code("bad_signature"));
  await assert.rejects(verify(other.sign(base)), code("unknown_key"));
});

test("Google: alg none и HS256 — отказ", async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const none = b64({ alg: "none", kid: g.kid }) + "." + b64(base) + ".AAAA";
  await assert.rejects(verify(none), code("bad_token"));
  const hsBody = b64({ alg: "HS256", kid: g.kid }) + "." + b64(base);
  const hs = hsBody + "." + crypto.createHmac("sha256", JSON.stringify(g.jwk)).update(hsBody).digest("base64url");
  await assert.rejects(verify(hs), code("bad_token"));
  await assert.rejects(verify("not-a-token"), code("bad_token"));
  await assert.rejects(verify(""), code("bad_token"));
});

test("Google: кэш ключей не дёргает Google на каждый мусорный kid", async () => {
  let calls = 0;
  const getKey = createJwksCache(async () => {
    calls += 1;
    return { ok: true, headers: { get: () => "public, max-age=3600" }, json: async () => ({ keys: [g.jwk] }) };
  });
  assert.ok(await getKey(g.kid));
  assert.equal(await getKey("unknown-1"), null);
  assert.equal(await getKey("unknown-2"), null);
  assert.equal(calls, 1);
});

const SECRET = crypto.randomBytes(48).toString("base64");

test("JWT: свой пропуск проверяется, срок 30 дней", () => {
  const t = signToken("user-1", SECRET, { now: NOW });
  assert.equal(t.expiresAt, NOW + 30 * 86400 * 1000);
  assert.equal(verifyToken(t.token, SECRET, { now: NOW + 29 * 86400 * 1000 }).sub, "user-1");
  assert.throws(() => verifyToken(t.token, SECRET, { now: NOW + 31 * 86400 * 1000 }), code("token_expired"));
});

test("JWT: подмена sub, чужой секрет, alg none — отказ", () => {
  const [h, , s] = signToken("user-1", SECRET, { now: NOW }).token.split(".");
  const p = Buffer.from(JSON.stringify({ sub: "user-2", iat: NOW_S, exp: NOW_S + 999 })).toString("base64url");
  assert.throws(() => verifyToken(h + "." + p + "." + s, SECRET, { now: NOW }), code("bad_token"));
  const foreign = signToken("user-1", crypto.randomBytes(48).toString("base64"), { now: NOW }).token;
  assert.throws(() => verifyToken(foreign, SECRET, { now: NOW }), code("bad_token"));
  const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url") + "." + p + ".";
  assert.throws(() => verifyToken(none, SECRET, { now: NOW }), code("bad_token"));
  assert.throws(() => signToken("u", "short"), /JWT_SECRET/);
});
