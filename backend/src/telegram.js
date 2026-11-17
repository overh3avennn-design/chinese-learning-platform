"use strict";

// Проверка данных входа Telegram. Два РАЗНЫХ алгоритма:
//
// 1. Mini App (Telegram.WebApp.initData) —
//    https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//    secret = HMAC_SHA256(key = "WebAppData", data = токен бота)
//
// 2. Login Widget на сайте —
//    https://core.telegram.org/widgets/login#checking-authorization
//    secret = SHA256(токен бота)
//
// В обоих случаях hash = hex(HMAC_SHA256(key = secret, data = data_check_string)),
// где data_check_string — все поля, кроме hash, по алфавиту, «key=value»
// через перевод строки. Подпись одного вида не подходит к другому: на этом
// построен тест «не перепутали ли алгоритмы».

const crypto = require("crypto");
const { unauthorized, badRequest } = require("./errors");

const DAY = 24 * 60 * 60;
const MAX_FUTURE = 5 * 60;          // часы клиента могут спешить
const MAX_INIT_DATA = 8192;         // настоящая initData — около 1 КБ

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function miniAppSecret(botToken) {
  return hmac("WebAppData", botToken);
}

function widgetSecret(botToken) {
  return crypto.createHash("sha256").update(botToken).digest();
}

function dataCheckString(pairs) {
  return pairs
    .slice()
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => k + "=" + v)
    .join("\n");
}

// Сравнение подписи без утечки по времени ответа.
function sameHash(expected, received) {
  if (typeof received !== "string" || !/^[0-9a-f]{64}$/.test(received)) return false;
  const a = Buffer.from(received, "hex");
  return a.length === expected.length && crypto.timingSafeEqual(a, expected);
}

function checkAuthDate(value, now, maxAge) {
  const t = Number(value);
  if (!Number.isSafeInteger(t) || t <= 0) throw unauthorized("bad_auth_date");
  if (now - t > maxAge) throw unauthorized("auth_expired");
  if (t - now > MAX_FUTURE) throw unauthorized("bad_auth_date");
  return t;
}

function cleanUser(raw) {
  if (!raw || typeof raw !== "object") throw unauthorized("bad_user");
  const id = Number(raw.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw unauthorized("bad_user");
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const name = [str(raw.first_name, 64), str(raw.last_name, 64)].filter(Boolean).join(" ") ||
    str(raw.username, 64) || "Telegram";
  const photo = str(raw.photo_url, 512);
  return {
    telegramId: id,
    name,
    username: str(raw.username, 64),
    photo: /^https:\/\//.test(photo) ? photo : ""
  };
}

function nowSec(opts) {
  return Math.floor((opts && opts.now != null ? opts.now : Date.now()) / 1000);
}

// initData — строка запроса вида "query_id=…&user=%7B…%7D&auth_date=…&hash=…".
function verifyMiniAppInitData(initData, botToken, opts) {
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  if (typeof initData !== "string" || !initData || initData.length > MAX_INIT_DATA) {
    throw badRequest("bad_init_data");
  }
  const params = new URLSearchParams(initData);
  const pairs = [];
  const seen = new Set();
  let hash = null;
  for (const [key, value] of params) {
    if (seen.has(key)) throw unauthorized("bad_init_data");   // повтор поля — подделка
    seen.add(key);
    if (key === "hash") hash = value;
    else pairs.push([key, value]);
  }
  if (!hash) throw unauthorized("bad_signature");

  const secret = miniAppSecret(botToken);
  let ok = sameHash(hmac(secret, dataCheckString(pairs)), hash);
  // Поле signature (Ed25519 для проверки третьими сторонами) входит в строку
  // для hash. Если когда-нибудь Telegram перестанет его туда включать, вторая
  // попытка без него — та же HMAC-подпись токеном бота, подделать её нельзя.
  if (!ok && seen.has("signature")) {
    ok = sameHash(hmac(secret, dataCheckString(pairs.filter(([k]) => k !== "signature"))), hash);
  }
  if (!ok) throw unauthorized("bad_signature");

  const fields = Object.fromEntries(pairs);
  const authDate = checkAuthDate(fields.auth_date, nowSec(opts), (opts && opts.maxAge) || DAY);
  let user;
  try {
    user = JSON.parse(fields.user || "null");
  } catch (e) {
    throw unauthorized("bad_user");
  }
  return Object.assign(cleanUser(user), { authDate });
}

// data — объект, который виджет передаёт в data-onauth: id, first_name,
// last_name, username, photo_url, auth_date, hash.
function verifyLoginWidget(data, botToken, opts) {
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  if (!data || typeof data !== "object" || Array.isArray(data)) throw badRequest("bad_widget_data");
  const keys = Object.keys(data);
  if (keys.length > 16) throw badRequest("bad_widget_data");
  const pairs = [];
  let hash = null;
  for (const key of keys) {
    const value = data[key];
    if (!/^[a-z_]{1,32}$/.test(key)) throw unauthorized("bad_widget_data");
    if (value === null || value === undefined) continue;   // пустые поля виджет не присылает
    if (typeof value !== "string" && typeof value !== "number") throw unauthorized("bad_widget_data");
    const text = String(value);
    if (text.length > 1024) throw unauthorized("bad_widget_data");
    if (key === "hash") hash = text;
    else pairs.push([key, text]);
  }
  if (!hash) throw unauthorized("bad_signature");
  if (!sameHash(hmac(widgetSecret(botToken), dataCheckString(pairs)), hash)) {
    throw unauthorized("bad_signature");
  }
  const fields = Object.fromEntries(pairs);
  const authDate = checkAuthDate(fields.auth_date, nowSec(opts), (opts && opts.maxAge) || DAY);
  return Object.assign(cleanUser(fields), { authDate });
}

module.exports = {
  verifyMiniAppInitData,
  verifyLoginWidget,
  // для тестов и проверки после выкладки: подписать данные своим токеном
  _internal: { miniAppSecret, widgetSecret, dataCheckString, hmac }
};
