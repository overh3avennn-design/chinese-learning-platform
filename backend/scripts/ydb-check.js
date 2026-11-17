"use strict";

// Ручная диагностика базы: простые запросы через Query Service и Table
// Service с замером времени, схема таблиц, проба на временной таблице.
//   YDB_CONNECTION=… YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS=… node scripts/ydb-check.js
//
// В выкладку не входит: из сети GitHub (за рубежом) запросы к таблицам то
// проходят, то зависают «during compilation», хотя из функции в облаке база
// отвечает за доли секунды, — по этой проверке о базе судить нельзя.

const { Driver, getCredentialsFromEnv, TypedValues } = require("ydb-sdk");
const { parseYdbEndpoint } = require("../src/ydb-endpoint");

process.on("unhandledRejection", (err) => {
  console.log("  (фоновая ошибка драйвера: " + String(err && err.message ? err.message : err).slice(0, 120) + ")");
});

const QUERIES = [
  ["SELECT 1", "SELECT 1 AS one;", {}],
  ["число пользователей", "SELECT COUNT(*) AS n FROM users;", {}],
  ["поиск по индексу telegram", "DECLARE $tg AS Int64;\nSELECT id FROM users VIEW idx_telegram WHERE telegram_id = $tg;", { $tg: TypedValues.int64(1) }],
  ["карточки пользователя", "DECLARE $uid AS Utf8;\nSELECT id FROM cards WHERE user_id = $uid LIMIT 1;", { $uid: TypedValues.utf8("nobody") }]
];

const short = (err) => String(err && err.message ? err.message : err).replace(/\s+/g, " ").slice(0, 220);

async function timed(label, fn) {
  const started = Date.now();
  try {
    await fn();
    console.log("  ✓ " + label + " — " + (Date.now() - started) + " ms");
  } catch (err) {
    console.log("  ✗ " + label + " — " + (Date.now() - started) + " ms: " + short(err));
  }
}

async function main() {
  const target = parseYdbEndpoint(process.env.YDB_CONNECTION);
  const driver = new Driver(Object.assign({}, target, { authService: getCredentialsFromEnv() }));
  const started = Date.now();
  if (!(await driver.ready(20000))) throw new Error("driver not ready");
  console.log("драйвер готов за " + (Date.now() - started) + " ms");
  try {
    console.log("Query Service:");
    for (const [label, text, parameters] of QUERIES) {
      await timed(label, () => driver.queryClient.do({
        timeout: 15000,
        fn: async (session) => {
          const res = await session.execute({ text, parameters });
          for await (const rs of res.resultSets) for await (const row of rs.rows) void row;
          await res.opFinished;
        }
      }));
    }
    console.log("Table Service:");
    for (const [label, text, parameters] of QUERIES) {
      await timed(label, () => driver.tableClient.withSession((session) => session.executeQuery(text, parameters), 15000));
    }

    console.log("Схема таблиц:");
    for (const name of ["users", "cards"]) {
      await timed("describeTable " + name, async () => {
        const d = await driver.tableClient.withSession((session) => session.describeTable(name), 15000);
        const idx = (d.indexes || []).map((i) => i.name + ":" + (i.status === 1 ? "READY" : i.status === 2 ? "BUILDING" : "status " + i.status));
        console.log("    колонок " + (d.columns || []).length + ", партиций " + ((d.tableStats && d.tableStats.partitions) || "?") +
          ", индексы: " + (idx.join(", ") || "нет"));
      });
    }

    // Новая пустая таблица: если запрос к ней тоже зависает на компиляции —
    // беда во всей базе, если нет — только в наших таблицах.
    console.log("Проба на новой таблице diag_probe:");
    const run = (text) => driver.queryClient.do({
      timeout: 20000,
      fn: async (session) => {
        const res = await session.execute({ text });
        for await (const rs of res.resultSets) for await (const row of rs.rows) void row;
        await res.opFinished;
      }
    });
    await timed("CREATE TABLE diag_probe", () => run("CREATE TABLE diag_probe (id Utf8 NOT NULL, PRIMARY KEY (id));"));
    await timed("SELECT COUNT(*) FROM diag_probe", () => run("SELECT COUNT(*) AS n FROM diag_probe;"));
    await timed("DROP TABLE diag_probe", () => run("DROP TABLE diag_probe;"));
  } finally {
    await driver.destroy().catch(() => {});
  }
}

main().then(() => process.exit(0), (err) => {
  console.log("ydb-check: " + short(err));
  process.exit(0);
});
