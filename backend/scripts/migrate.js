"use strict";

// Создаёт таблицы из schema.sql (если их ещё нет). Запускается в GitHub
// Actions: YDB_CONNECTION — строка подключения, YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS
// — путь к ключу сервисного аккаунта.
//   node scripts/migrate.js

const fs = require("fs");
const path = require("path");
const { Driver, getCredentialsFromEnv } = require("ydb-sdk");
const { parseYdbEndpoint } = require("../src/ydb-endpoint");

async function main() {
  const endpoint = process.env.YDB_CONNECTION;
  if (!endpoint) throw new Error("YDB_CONNECTION is not set");
  // Только что созданная база может недолго быть недоступна, хотя её статус
  // уже RUNNING, — повторяем несколько раз.
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate(endpoint);
      return;
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (attempt >= 6 || !/Database not found|UNAVAILABLE|not ready|DEADLINE|timed out|Timeout|OVERLOADED/i.test(msg)) throw err;
      console.log("база ещё не готова (" + msg.slice(0, 80) + "), попытка " + attempt + ", жду 20 с…");
      await new Promise((r) => setTimeout(r, 20000));
    }
  }
}

async function migrate(endpoint) {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8")
    .split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  const statements = sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);

  const driver = new Driver(Object.assign(parseYdbEndpoint(endpoint), { authService: getCredentialsFromEnv() }));
  try {
    if (!(await driver.ready(20000))) throw new Error("YDB driver is not ready");
    // Для уже существующей таблицы с индексами YDB serverless иногда отвечает
    // на CREATE TABLE IF NOT EXISTS «Query compilation timed out», поэтому
    // сначала смотрим, какие таблицы уже есть, и создаём только недостающие.
    let existing = null;
    try {
      const list = await driver.schemeClient.listDirectory("");
      existing = new Set((list.children || []).map((c) => c.name));
    } catch (e) {
      console.log("список таблиц не получен (" + String(e && e.message ? e.message : e).slice(0, 80) + ") — создаю с IF NOT EXISTS");
    }
    for (const text of statements) {
      const name = (/CREATE TABLE IF NOT EXISTS (\w+)/.exec(text) || [])[1] || text.slice(0, 40);
      if (existing && existing.has(name)) {
        console.log("table exists:", name);
        continue;
      }
      await driver.queryClient.do({
        fn: async (session) => {
          const res = await session.execute({ text });
          await res.opFinished;
        }
      });
      console.log("table ok:", name);
    }
  } finally {
    await driver.destroy().catch(() => {});
  }
}

// Драйвер, не дождавшийся базы, ещё какое-то время бросает фоновые ошибки
// поиска узлов — они не должны обрывать повторные попытки.
process.on("unhandledRejection", (err) => {
  console.log("(фоновая ошибка драйвера: " + String(err && err.message ? err.message : err).slice(0, 100) + ")");
});

main().then(() => process.exit(0), (err) => {
  console.error("Migration failed:", err && err.message ? err.message : err);
  process.exit(1);
});
