"use strict";

// Подписывает тестовые данные так, как это делают Telegram и Google, — для
// тестов и для проверки API после выкладки (scripts/smoke.js). Алгоритмы
// написаны здесь заново по документации, а не взяты из src/, чтобы ошибка в
// src/ не повторилась в тесте.

const crypto = require("crypto");

function hmacHex(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

function checkString(obj) {
  return Object.keys(obj).sort().map((k) => k + "=" + obj[k]).join("\n");
}

// Mini App: secret = HMAC_SHA256(key="WebAppData", data=token).
function signInitData(fields, botToken) {
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const all = Object.assign({}, fields);
  if (all.user && typeof all.user === "object") all.user = JSON.stringify(all.user);
  const hash = hmacHex(secret, checkString(all));
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(all)) params.set(k, v);
  params.set("hash", hash);
  return params.toString();
}

// Login Widget: secret = SHA256(token).
function signWidget(fields, botToken) {
  const secret = crypto.createHash("sha256").update(botToken).digest();
  const all = {};
  for (const [k, v] of Object.entries(fields)) all[k] = String(v);
  return Object.assign({}, fields, { hash: hmacHex(secret, checkString(all)) });
}

// Google: свой RSA-ключ, свой JWKS.
function makeGoogleSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "test-kid-" + crypto.randomBytes(4).toString("hex");
  const jwk = Object.assign(publicKey.export({ format: "jwk" }), { kid, alg: "RS256", use: "sig" });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return {
    kid,
    jwk,
    getKey: async (k) => (k === kid ? jwk : null),
    sign(payload, header) {
      const h = b64(Object.assign({ alg: "RS256", kid, typ: "JWT" }, header));
      const body = h + "." + b64(payload);
      const sig = crypto.sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url");
      return body + "." + sig;
    }
  };
}

module.exports = { signInitData, signWidget, makeGoogleSigner };
