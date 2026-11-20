"use strict";

// Хранилище в YDB serverless (Query Service ydb-sdk 5). Таблицы — в
// scripts/schema.sql. Каждая транзакция: сначала чтения, потом одна запись
// (решение принимают общие с тестами функции из sync.js). При конфликте
// параллельных транзакций YDB возвращает ABORTED, и queryClient.do сам
// повторяет функцию целиком.
//
// 64-битные числа читаются через CAST(… AS Utf8): SDK отдаёт их то числом,
// то объектом Long, а строка — всегда строка.

const crypto = require("crypto");
const { Types, TypedValues } = require("ydb-sdk");
const { unauthorized } = require("./errors");
const { FIELD, planPush, planMerge, decideLink, isCaughtUp, pageResult, publicSet, publicDeckIds } = require("./sync");

const RW = { serializableReadWrite: {} };
const RO = { snapshotReadOnly: {} };

const num = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v));
const orNull = (v) => (v === null || v === undefined ? null : v);

const USER_COLS =
  "id, CAST(telegram_id AS Utf8) AS tg, google_sub AS gsub, name, photo_url AS photo, " +
  "CAST(rev AS Utf8) AS rev, rows_count AS nrows, CAST(bytes_total AS Utf8) AS nbytes, " +
  "quota_day AS qday, quota_writes AS qwrites";

function toUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    telegramId: r.tg ? Number(r.tg) : null,
    googleSub: orNull(r.gsub),
    name: r.name || "",
    photo: r.photo || "",
    rev: num(r.rev),
    rowsCount: num(r.nrows),
    bytesTotal: num(r.nbytes),
    quotaDay: num(r.qday),
    quotaWrites: num(r.qwrites)
  };
}

const ROW_STRUCT = Types.struct({
  id: Types.UTF8,
  data: Types.optional(Types.UTF8),
  deleted: Types.BOOL,
  updated_at: Types.UINT64,
  size: Types.UINT32,
  rev: Types.UINT64
});
const ROW_DECL = "List<Struct<id: Utf8, data: Utf8?, deleted: Bool, updated_at: Uint64, size: Uint32, rev: Uint64>>";

function rowsParam(rows) {
  return TypedValues.list(ROW_STRUCT, rows.map((r) => ({
    id: r.id, data: r.deleted ? null : r.data, deleted: !!r.deleted, updated_at: r.updatedAt, size: r.size || 0, rev: r.rev
  })));
}

const subjectParam = (identity) =>
  identity.provider === "telegram" ? TypedValues.int64(identity.subject) : TypedValues.utf8(String(identity.subject));
const subjectDecl = (identity) => (identity.provider === "telegram" ? "Int64" : "Utf8");
const COLUMN = { telegram: "telegram_id", google: "google_sub" };
const INDEX = { telegram: "idx_telegram", google: "idx_google" };

async function run(session, text, parameters) {
  const res = await session.execute({ text, parameters: parameters || {} });
  const sets = [];
  for await (const rs of res.resultSets) {
    const rows = [];
    for await (const row of rs.rows) rows.push(row);
    sets.push(rows);
  }
  await res.opFinished;
  return sets;
}

// Предел одной транзакции: SDK повторяет временные ошибки сам, но ответ
// должен успеть до предела функции — иначе платформа оборвёт её без лога.
const TX_TIMEOUT = 9000;

function createYdbStore(getDriver) {
  async function tx(label, settings, fn) {
    const driver = await getDriver();
    const started = Date.now();
    try {
      const result = await driver.queryClient.do({ txSettings: settings, fn, timeout: TX_TIMEOUT });
      const ms = Date.now() - started;
      if (ms > 1500) console.log("ydb " + label + ": slow, " + ms + " ms");
      return result;
    } catch (err) {
      if (!(err && err.status && err.code)) {
        console.error("ydb " + label + ": failed after " + (Date.now() - started) + " ms:", err && err.message ? err.message.slice(0, 500) : err);
      }
      throw err;
    }
  }

  async function readUser(session, userId) {
    const [rows] = await run(session,
      "DECLARE $uid AS Utf8;\nSELECT " + USER_COLS + " FROM users WHERE id = $uid;",
      { $uid: TypedValues.utf8(userId) });
    return toUser(rows && rows[0]);
  }

  async function findOwner(session, identity) {
    const p = identity.provider;
    const [rows] = await run(session,
      "DECLARE $sub AS " + subjectDecl(identity) + ";\n" +
      "SELECT " + USER_COLS + " FROM users VIEW " + INDEX[p] + " WHERE " + COLUMN[p] + " = $sub;",
      { $sub: subjectParam(identity) });
    return toUser(rows && rows[0]);
  }

  async function readAllRows(session, userId) {
    const [rows] = await run(session,
      "DECLARE $uid AS Utf8;\n" +
      "SELECT id, data, deleted, CAST(updated_at AS Utf8) AS upd, size FROM cards WHERE user_id = $uid;",
      { $uid: TypedValues.utf8(userId) });
    return (rows || []).map((r) => ({ id: r.id, data: r.data, deleted: !!r.deleted, updatedAt: num(r.upd), size: num(r.size) }));
  }

  return {
    async login(identity, now) {
      return tx("login", RW, async (session) => {
        const p = identity.provider;
        let user = await findOwner(session, identity);
        const params = {
          $uid: TypedValues.utf8(user ? user.id : crypto.randomUUID()),
          $name: TypedValues.utf8(identity.name || ""),
          $photo: TypedValues.utf8(identity.photo || "")
        };
        if (user) {
          await run(session,
            "DECLARE $uid AS Utf8; DECLARE $name AS Utf8; DECLARE $photo AS Utf8;\n" +
            "UPSERT INTO users (id, name, photo_url) VALUES ($uid, $name, $photo);", params);
          return Object.assign(user, { name: identity.name || "", photo: identity.photo || "" });
        }
        params.$sub = subjectParam(identity);
        params.$created = TypedValues.timestamp(new Date(now));
        await run(session,
          "DECLARE $uid AS Utf8; DECLARE $name AS Utf8; DECLARE $photo AS Utf8; DECLARE $created AS Timestamp;\n" +
          "DECLARE $sub AS " + subjectDecl(identity) + ";\n" +
          "UPSERT INTO users (id, " + COLUMN[p] + ", name, photo_url, created_at, rev, rows_count, bytes_total, quota_day, quota_writes)\n" +
          "VALUES ($uid, $sub, $name, $photo, $created, 0ul, 0u, 0ul, 0u, 0u);", params);
        user = { id: params.$uid.value.textValue, telegramId: null, googleSub: null, name: identity.name || "", photo: identity.photo || "" };
        user[FIELD[p]] = identity.subject;
        return user;
      });
    },

    async getUser(id) {
      return tx("getUser", RO, (session) => readUser(session, id));
    },

    async link(userId, identity, limits, now) {
      return tx("link", RW, async (session) => {
        const current = await readUser(session, userId);
        if (!current) throw unauthorized("user_gone");
        const owner = await findOwner(session, identity);
        const action = decideLink(current, owner, identity);
        if (action === "none") return { user: current, merged: false };
        const p = identity.provider;
        const params = { $uid: TypedValues.utf8(userId), $sub: subjectParam(identity) };
        let writes = "DECLARE $uid AS Utf8; DECLARE $sub AS " + subjectDecl(identity) + ";\n";
        if (action === "merge") {
          const target = await readAllRows(session, userId);
          const source = await readAllRows(session, owner.id);
          const plan = planMerge(target, source, limits, now, current.rev);
          params.$owner = TypedValues.utf8(owner.id);
          params.$del = TypedValues.list(Types.struct({ user_id: Types.UTF8, id: Types.UTF8 }),
            source.map((r) => ({ user_id: owner.id, id: r.id })));
          params.$rows = rowsParam(plan.upserts);
          params.$rev = TypedValues.uint64(plan.rev);
          params.$nrows = TypedValues.uint32(plan.rowsCount);
          params.$nbytes = TypedValues.uint64(plan.bytesTotal);
          writes +=
            "DECLARE $owner AS Utf8; DECLARE $del AS List<Struct<user_id: Utf8, id: Utf8>>; DECLARE $rows AS " + ROW_DECL + ";\n" +
            "DECLARE $rev AS Uint64; DECLARE $nrows AS Uint32; DECLARE $nbytes AS Uint64;\n" +
            "DELETE FROM cards ON SELECT user_id, id FROM AS_TABLE($del);\n" +
            "DELETE FROM users ON SELECT $owner AS id;\n" +
            "UPSERT INTO cards SELECT $uid AS user_id, id, data, deleted, updated_at, size, rev FROM AS_TABLE($rows);\n" +
            "UPSERT INTO users (id, " + COLUMN[p] + ", rev, rows_count, bytes_total) VALUES ($uid, $sub, $rev, $nrows, $nbytes);";
          Object.assign(current, { rev: plan.rev, rowsCount: plan.rowsCount, bytesTotal: plan.bytesTotal });
        } else {
          writes += "UPSERT INTO users (id, " + COLUMN[p] + ") VALUES ($uid, $sub);";
        }
        await run(session, writes, params);
        current[FIELD[p]] = identity.subject;
        return { user: current, merged: action === "merge" };
      });
    },

    async pull(userId, cursor, limits) {
      return tx("pull", RO, async (session) => {
        const user = await readUser(session, userId);
        if (!user) throw unauthorized("user_gone");
        if (isCaughtUp(user.rev, cursor)) return { items: [], cursor, more: false };
        const [rows] = await run(session,
          "DECLARE $uid AS Utf8; DECLARE $rev AS Uint64; DECLARE $cid AS Utf8; DECLARE $lim AS Uint64;\n" +
          "SELECT id, data, deleted, CAST(updated_at AS Utf8) AS upd, CAST(rev AS Utf8) AS rev, size FROM cards\n" +
          "WHERE user_id = $uid AND (rev > $rev OR (rev = $rev AND id > $cid))\n" +
          "ORDER BY rev, id LIMIT $lim;",
          {
            $uid: TypedValues.utf8(userId),
            $rev: TypedValues.uint64(cursor.rev),
            $cid: TypedValues.utf8(cursor.id || ""),
            $lim: TypedValues.uint64(limits.pullPageRows + 1)
          });
        const items = [];
        let bytes = 0;
        for (const r of rows || []) {
          const size = num(r.size);
          if (items.length >= limits.pullPageRows || (items.length && bytes + size > limits.pullPageBytes)) break;
          bytes += size;
          let data = null;
          if (!r.deleted && r.data) {
            try { data = JSON.parse(r.data); } catch (e) { data = null; }
          }
          items.push({ id: r.id, data, deleted: !!r.deleted, updatedAt: num(r.upd), rev: num(r.rev) });
        }
        return pageResult(items, cursor, items.length < (rows || []).length);
      });
    },

    async push(userId, items, limits, now) {
      return tx("push", RW, async (session) => {
        const user = await readUser(session, userId);
        if (!user) throw unauthorized("user_gone");
        const [rows] = await run(session,
          "DECLARE $uid AS Utf8; DECLARE $ids AS List<Utf8>;\n" +
          "SELECT id, CAST(updated_at AS Utf8) AS upd, size, deleted FROM cards WHERE user_id = $uid AND id IN $ids;",
          { $uid: TypedValues.utf8(userId), $ids: TypedValues.list(Types.UTF8, items.map((i) => i.id)) });
        const existing = new Map((rows || []).map((r) => [r.id, { updatedAt: num(r.upd), size: num(r.size), deleted: !!r.deleted }]));
        const plan = planPush(user, existing, items, limits, now);
        const c = plan.counters;
        const params = {
          $uid: TypedValues.utf8(userId),
          $rev: TypedValues.uint64(c.rev),
          $nrows: TypedValues.uint32(c.rowsCount),
          $nbytes: TypedValues.uint64(c.bytesTotal),
          $qday: TypedValues.uint32(c.quotaDay),
          $qwrites: TypedValues.uint32(c.quotaWrites)
        };
        let text = "DECLARE $uid AS Utf8; DECLARE $rev AS Uint64; DECLARE $nrows AS Uint32; DECLARE $nbytes AS Uint64;\n" +
          "DECLARE $qday AS Uint32; DECLARE $qwrites AS Uint32;\n";
        if (plan.upserts.length) {
          params.$rows = rowsParam(plan.upserts);
          text += "DECLARE $rows AS " + ROW_DECL + ";\n" +
            "UPSERT INTO cards SELECT $uid AS user_id, id, data, deleted, updated_at, size, rev FROM AS_TABLE($rows);\n";
        }
        text += "UPSERT INTO users (id, rev, rows_count, bytes_total, quota_day, quota_writes) VALUES ($uid, $rev, $nrows, $nbytes, $qday, $qwrites);";
        await run(session, text, params);
        return { rev: plan.rev, results: plan.results };
      });
    },

    // Общие папки издателей (Telegram id) и их колоды — для GET /public.
    // Читаются только строка folders издателя и колоды из общих папок.
    async publicCards(telegramIds, limits) {
      return tx("public", RO, async (session) => {
        const sources = [];
        for (const tg of telegramIds) {
          const user = await findOwner(session, { provider: "telegram", subject: Number(tg) });
          if (!user) continue;
          const uid = TypedValues.utf8(user.id);
          const [frows] = await run(session,
            "DECLARE $uid AS Utf8; DECLARE $fid AS Utf8;\nSELECT data, deleted FROM cards WHERE user_id = $uid AND id = $fid;",
            { $uid: uid, $fid: TypedValues.utf8("folders") });
          const f = frows && frows[0];
          if (!f || f.deleted || !f.data) continue;
          const ids = publicDeckIds(f.data, limits);
          const decks = new Map();
          if (ids.length) {
            const [drows] = await run(session,
              "DECLARE $uid AS Utf8; DECLARE $ids AS List<Utf8>;\n" +
              "SELECT id, data, deleted FROM cards WHERE user_id = $uid AND id IN $ids;",
              { $uid: uid, $ids: TypedValues.list(Types.UTF8, ids) });
            for (const r of drows || []) if (!r.deleted && r.data) decks.set(r.id.slice(5), r.data);
          }
          sources.push({ folders: f.data, decks });
        }
        return publicSet(sources, limits);
      });
    }
  };
}

module.exports = { createYdbStore };
