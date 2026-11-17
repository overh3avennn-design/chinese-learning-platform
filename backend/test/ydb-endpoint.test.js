"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseYdbEndpoint } = require("../src/ydb-endpoint");

test("адрес базы из yc: database берётся из параметра, а не из пути «/»", () => {
  assert.deepEqual(
    parseYdbEndpoint("grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/b1gabc/etnxyz"),
    { endpoint: "grpcs://ydb.serverless.yandexcloud.net:2135", database: "/ru-central1/b1gabc/etnxyz" }
  );
  assert.equal(parseYdbEndpoint("grpcs://host:2135/local").database, "/local");
  assert.throws(() => parseYdbEndpoint("grpcs://host:2135/"), /no database/);
});
