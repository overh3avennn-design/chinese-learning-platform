"use strict";

// Адрес базы из `yc ydb database get` выглядит так:
//   grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/b1g…/etn…
// ydb-sdk 5.11 разбирает connectionString с ошибкой: берёт путь URL ("/")
// раньше параметра database и ищет базу "/" — «Database not found». Поэтому
// разбираем сами и передаём драйверу endpoint и database отдельно.
function parseYdbEndpoint(text) {
  const url = new URL(text);
  const database = url.searchParams.get("database") || (url.pathname !== "/" ? url.pathname : "");
  if (!database) throw new Error("YDB endpoint has no database path");
  return { endpoint: url.protocol + "//" + url.host, database };
}

module.exports = { parseYdbEndpoint };
