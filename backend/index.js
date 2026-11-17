"use strict";

// Точка входа Yandex Cloud Function (среда nodejs22, entrypoint index.handler).
// Вызывается через API Gateway (payload_format_version "1.0": path — путь
// запроса, httpMethod, headers, queryStringParameters, body,
// requestContext.identity.sourceIp).
//
// Переменные окружения (их ставит .github/workflows/backend.yml):
//   TELEGRAM_BOT_TOKEN, GOOGLE_CLIENT_ID, JWT_SECRET — секреты;
//   YDB_ENDPOINT — grpcs://…/?database=… из `yc ydb database get`;
//   ALLOWED_ORIGINS — сайты, которым можно обращаться к API (через запятую).
//
// К YDB функция ходит с IAM-токеном своего сервисного аккаунта: платформа
// кладёт его в context.token при каждом вызове.

const { Driver, TokenAuthService } = require("ydb-sdk");
const { createApp } = require("./src/app");
const { createYdbStore } = require("./src/store-ydb");

class ContextTokenAuth extends TokenAuthService {
  setToken(token) {
    this.token = token;
  }
}

const auth = new ContextTokenAuth("");
let driver = null;

async function getDriver() {
  if (!auth.token) throw new Error("No IAM token in context: the function version has no service account");
  if (!driver) {
    const d = new Driver({ connectionString: process.env.YDB_ENDPOINT, authService: auth });
    if (!(await d.ready(8000))) {
      await d.destroy().catch(() => {});
      throw new Error("YDB driver is not ready");
    }
    driver = d;
  }
  return driver;
}

const app = createApp({
  store: createYdbStore(getDriver),
  config: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    jwtSecret: process.env.JWT_SECRET,
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "").split(/[|,\s]+/).filter(Boolean)
  }
});

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

module.exports.handler = async function (event, context) {
  if (context && context.token && context.token.access_token) auth.setToken(context.token.access_token);
  const headers = lowerKeys(Object.assign({}, event.multiValueHeaders, event.headers));
  let body = event.body || "";
  if (event.isBase64Encoded && body) body = Buffer.from(body, "base64").toString("utf8");
  const identity = (event.requestContext && event.requestContext.identity) || {};
  const ip = identity.sourceIp || String(headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const res = await app({
    method: String(event.httpMethod || "GET").toUpperCase(),
    path: event.path || event.url || "/",
    query: event.queryStringParameters || {},
    headers,
    body,
    ip
  });
  return { statusCode: res.status, headers: res.headers, body: res.body, isBase64Encoded: false };
};
