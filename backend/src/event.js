"use strict";

// Событие Yandex Cloud Functions → запрос для app.js
// ({ method, path, query, headers, body, ip }).
//
// Два способа вызова:
//  1. API Gateway (payload_format_version "1.0"): path — путь запроса,
//     заголовки и тело как есть.
//  2. Прямой вызов https://functions.yandexcloud.net/<id> — им пользуется
//     сайт. Платформа присылает пустой path и вырезает заголовок
//     Authorization, поэтому сайт шлёт «простые» запросы (POST, text/plain,
//     без своих заголовков — браузер не делает CORS-предзапрос):
//       маршрут — ?r=/cards, настоящий метод — ?m=GET|PUT (по умолчанию POST),
//       пропуск — поле _token в теле JSON.

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

function requestFromEvent(event) {
  const headers = lowerKeys(Object.assign({}, event.multiValueHeaders, event.headers));
  let body = event.body || "";
  if (event.isBase64Encoded && body) body = Buffer.from(body, "base64").toString("utf8");
  const identity = (event.requestContext && event.requestContext.identity) || {};
  const ip = identity.sourceIp || String(headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const query = Object.assign({}, event.queryStringParameters);
  let method = String(event.httpMethod || "GET").toUpperCase();
  let path = event.path || "";

  if (!path && typeof query.r === "string" && query.r.charAt(0) === "/") {
    path = query.r.split("?")[0];
    if (method === "POST" && /^(GET|PUT|POST)$/.test(query.m || "")) method = query.m;
    delete query.r;
    delete query.m;
    // Пропуск из тела — в заголовок, как при вызове через шлюз. Свой
    // заголовок Authorization сюда не дойдёт: платформа его вырезает.
    if (body && !headers.authorization) {
      try {
        const data = JSON.parse(body);
        if (data && typeof data === "object" && !Array.isArray(data) && "_token" in data) {
          if (typeof data._token === "string" && data._token) headers.authorization = "Bearer " + data._token;
          delete data._token;
          body = JSON.stringify(data);
        }
      } catch (e) {
        // не JSON — app.js ответит 400
      }
    }
  }

  return { method, path: path || event.url || "/", query, headers, body, ip };
}

module.exports = { requestFromEvent };
