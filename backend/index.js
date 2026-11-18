"use strict";

// Точка входа Yandex Cloud Function (среда nodejs22, entrypoint index.handler).
// Сайт вызывает функцию напрямую (https://functions.yandexcloud.net/<id>),
// можно и через API Gateway — как событие превращается в запрос, см.
// src/event.js.
//
// Переменные окружения (их ставит .github/workflows/backend.yml):
//   TELEGRAM_BOT_TOKEN, GOOGLE_CLIENT_ID, JWT_SECRET — секреты;
//   YDB_CONNECTION — grpcs://…/?database=… из `yc ydb database get`;
//   ALLOWED_ORIGINS — сайты, которым можно обращаться к API (через запятую).
//
// К YDB функция ходит с IAM-токеном своего сервисного аккаунта: платформа
// кладёт его в context.token при каждом вызове.

const { Driver, TokenAuthService } = require("ydb-sdk");
const { createApp } = require("./src/app");
const { createYdbStore } = require("./src/store-ydb");
const { parseYdbEndpoint } = require("./src/ydb-endpoint");
const { requestFromEvent } = require("./src/event");

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
    const target = parseYdbEndpoint(process.env.YDB_CONNECTION);
    const started = Date.now();
    const d = new Driver(Object.assign({}, target, { authService: auth }));
    if (!(await d.ready(8000))) {
      console.error("ydb: driver not ready after " + (Date.now() - started) + " ms (" + target.endpoint + ")");
      await d.destroy().catch(() => {});
      throw new Error("YDB driver is not ready");
    }
    console.log("ydb: driver ready in " + (Date.now() - started) + " ms");
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

module.exports.handler = async function (event, context) {
  if (context && context.token && context.token.access_token) auth.setToken(context.token.access_token);
  const res = await app(requestFromEvent(event));
  return { statusCode: res.status, headers: res.headers, body: res.body, isBase64Encoded: false };
};
