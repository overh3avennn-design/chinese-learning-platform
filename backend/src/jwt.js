"use strict";

// Свой пропуск сайта: JWT HS256 с секретом JWT_SECRET (он есть только у
// функции). В нём только id пользователя и сроки — имя и фото клиент берёт
// из ответа на вход.

const crypto = require("crypto");
const { unauthorized } = require("./errors");

const TTL = 30 * 24 * 60 * 60;      // 30 дней
const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

function checkSecret(secret) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("JWT_SECRET is missing or too short");
}

function mac(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest();
}

function signToken(userId, secret, opts) {
  checkSecret(secret);
  const iat = Math.floor(((opts && opts.now) != null ? opts.now : Date.now()) / 1000);
  const payload = Buffer.from(JSON.stringify({ sub: userId, iat, exp: iat + ((opts && opts.ttl) || TTL) }))
    .toString("base64url");
  const body = HEADER + "." + payload;
  return { token: body + "." + mac(secret, body).toString("base64url"), expiresAt: (iat + ((opts && opts.ttl) || TTL)) * 1000 };
}

function verifyToken(token, secret, opts) {
  checkSecret(secret);
  if (typeof token !== "string" || token.length > 1024) throw unauthorized("bad_token");
  const parts = token.split(".");
  // Заголовок сравниваем целиком: никаких alg "none" или чужих алгоритмов.
  if (parts.length !== 3 || parts[0] !== HEADER) throw unauthorized("bad_token");
  const expected = mac(secret, parts[0] + "." + parts[1]);
  let got;
  try {
    got = Buffer.from(parts[2], "base64url");
  } catch (e) {
    throw unauthorized("bad_token");
  }
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) throw unauthorized("bad_token");
  let p;
  try {
    p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (e) {
    throw unauthorized("bad_token");
  }
  const now = Math.floor(((opts && opts.now) != null ? opts.now : Date.now()) / 1000);
  if (!p || typeof p.sub !== "string" || !p.sub || typeof p.exp !== "number") throw unauthorized("bad_token");
  if (p.exp < now) throw unauthorized("token_expired");
  return p;
}

module.exports = { signToken, verifyToken, TTL };
