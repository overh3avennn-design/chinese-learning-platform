"use strict";

// Строки карточек пользователя — одна строка на колоду:
//   deck:<id>      своя колода { title, words: [{hanzi, pinyin, translation}] }
//   extra:<id>     свои слова в готовой колоде сайта [слово, …]
//   folders        свои папки [{ id, title, decks: [id, …] }]
//   progress:<id>  прогресс колоды { words: { "иероглиф|пиньинь": "learning"|"learned" } }
// Сервер хранит data как JSON-текст и не разбирает его, кроме слияния
// аккаунтов (mergeData). Кто новее — решает updatedAt (время правки на
// устройстве, мс); rev — серверный номер изменения для «дай, что поменялось».

const { HttpError, badRequest } = require("./errors");

const ID_RE = /^(?:folders|(?:deck|extra|progress):[A-Za-z0-9_.-]{1,96})$/;
const FUTURE_SLACK = 60 * 1000;

// Проверка тела PUT /cards. Возвращает строки, готовые к записи.
function validateItems(items, limits, now) {
  if (!Array.isArray(items) || !items.length) throw badRequest("no_items");
  if (items.length > limits.maxItemsPerPush) throw new HttpError(413, "too_many_items");
  const seen = new Set();
  return items.map((raw) => {
    if (!raw || typeof raw !== "object") throw badRequest("bad_item");
    const id = raw.id;
    if (typeof id !== "string" || !ID_RE.test(id)) throw badRequest("bad_item_id");
    if (seen.has(id)) throw badRequest("duplicate_item");
    seen.add(id);
    let updatedAt = Number(raw.updatedAt);
    if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) throw badRequest("bad_updated_at");
    // Часы устройства могут спешить: правка «из будущего» перебила бы все
    // следующие правки с других устройств.
    if (updatedAt > now + FUTURE_SLACK) updatedAt = now;
    if (raw.deleted === true) return { id, deleted: true, data: null, size: 0, updatedAt };
    if (!raw.data || typeof raw.data !== "object") throw badRequest("bad_item_data");
    const data = JSON.stringify(raw.data);
    const size = Buffer.byteLength(data, "utf8");
    if (size > limits.maxRowBytes) throw new HttpError(413, "item_too_large");
    return { id, deleted: false, data, size, updatedAt };
  });
}

function utcDay(now) {
  return Math.floor(now / 86400000);
}

// Решение для PUT /cards по текущему состоянию — одинаковое для YDB и для
// тестового хранилища. user — счётчики пользователя, existing — Map id →
// { updatedAt, size, deleted } строк, которые сейчас пришли.
function planPush(user, existing, items, limits, now) {
  const day = utcDay(now);
  const writes = user.quotaDay === day ? user.quotaWrites : 0;
  if (writes >= limits.writesPerDay) throw new HttpError(429, "daily_limit");
  const rev = Math.max(now, (user.rev || 0) + 1);
  let rows = user.rowsCount || 0;
  let bytes = user.bytesTotal || 0;
  const upserts = [];
  const results = [];
  for (const item of items) {
    const ex = existing.get(item.id);
    if (ex && ex.updatedAt > item.updatedAt) {
      results.push({ id: item.id, status: "stale" });   // на сервере правка новее
      continue;
    }
    if (!ex && item.deleted) {
      results.push({ id: item.id, status: "ok" });      // удалять нечего
      continue;
    }
    const nextRows = rows + (ex ? 0 : 1);
    const nextBytes = bytes - (ex ? ex.size : 0) + item.size;
    if (nextRows > limits.maxRows || (nextBytes > limits.maxBytes && item.size > (ex ? ex.size : 0))) {
      results.push({ id: item.id, status: "quota" });
      continue;
    }
    rows = nextRows;
    bytes = nextBytes;
    upserts.push({ id: item.id, data: item.data, deleted: item.deleted, updatedAt: item.updatedAt, size: item.size, rev });
    results.push({ id: item.id, status: "ok" });
  }
  return {
    rev: upserts.length ? rev : user.rev || 0,
    upserts,
    results,
    counters: {
      rev: upserts.length ? rev : user.rev || 0,
      rowsCount: rows,
      bytesTotal: bytes,
      quotaDay: day,
      quotaWrites: writes + 1
    }
  };
}

// ----------------------------------------------------- слияние аккаунтов
// Когда к аккаунту привязывают вход, у которого уже есть свой аккаунт с
// карточками, карточки второго переезжают в первый. Совпавшие строки
// объединяются по смыслу, чтобы ничего не потерялось.

function parse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

const wordKey = (w) => (w && typeof w.hanzi === "string" ? w.hanzi + "|" + (w.pinyin || "") : null);

function unionWords(a, b) {
  const out = [];
  const seen = new Set();
  for (const w of [].concat(Array.isArray(a) ? a : [], Array.isArray(b) ? b : [])) {
    const k = wordKey(w);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

function mergeData(id, target, source) {
  if (id.startsWith("progress:")) {
    const words = Object.assign({}, (source && source.words) || {});
    for (const [k, v] of Object.entries((target && target.words) || {})) {
      if (v === "learned" || !words[k]) words[k] = v;      // «выучено» сильнее «учу»
    }
    return { words };
  }
  if (id.startsWith("extra:")) return unionWords(target, source);
  if (id === "folders") {
    const out = (Array.isArray(target) ? target : []).map((f) => Object.assign({}, f));
    for (const f of Array.isArray(source) ? source : []) {
      const same = out.find((o) => o && f && o.id === f.id);
      if (same) same.decks = Array.from(new Set([].concat(same.decks || [], f.decks || [])));
      else out.push(f);
    }
    return out;
  }
  return null;     // deck:* — целиком побеждает более новая версия
}

// targetRows, sourceRows — все строки двух аккаунтов { id, data, deleted, updatedAt, size }.
// Возвращает строки, которые нужно записать в целевой аккаунт, и его новые счётчики.
function planMerge(targetRows, sourceRows, limits, now, targetRev) {
  const rev = Math.max(now, (targetRev || 0) + 1);
  const byId = new Map(targetRows.map((r) => [r.id, r]));
  const upserts = [];
  for (const s of sourceRows) {
    if (s.deleted) continue;
    const t = byId.get(s.id);
    let row = null;
    if (!t || t.deleted) {
      row = { id: s.id, data: s.data, deleted: false, updatedAt: s.updatedAt };
    } else {
      const merged = mergeData(s.id, parse(t.data), parse(s.data));
      if (merged) row = { id: s.id, data: JSON.stringify(merged), deleted: false, updatedAt: Math.max(t.updatedAt, s.updatedAt) };
      else if (s.updatedAt > t.updatedAt) row = { id: s.id, data: s.data, deleted: false, updatedAt: s.updatedAt };
    }
    if (!row) continue;
    row.size = Buffer.byteLength(row.data, "utf8");
    row.rev = rev;
    upserts.push(row);
    byId.set(row.id, row);
  }
  let bytes = 0;
  for (const r of byId.values()) bytes += r.deleted ? 0 : r.size || 0;
  if (byId.size > limits.maxRows || bytes > limits.maxBytes) throw new HttpError(409, "merge_too_large");
  return { upserts, rev: upserts.length ? rev : targetRev || 0, rowsCount: byId.size, bytesTotal: bytes };
}

// ------------------------------------------------------ привязка входов
// current — аккаунт, в котором человек сейчас; owner — аккаунт, которому уже
// принадлежит новый вход (или null). Слить можно, только если у owner нет
// других входов: иначе тот вход остался бы без аккаунта.
const FIELD = { telegram: "telegramId", google: "googleSub" };

function decideLink(current, owner, identity) {
  const field = FIELD[identity.provider];
  if (owner && owner.id === current.id) return "none";
  if (current[field] != null && current[field] !== identity.subject) throw new HttpError(409, "already_linked");
  if (!owner) return "attach";
  const other = field === "telegramId" ? "googleSub" : "telegramId";
  if (owner[other] != null) throw new HttpError(409, "other_account_conflict");
  return "merge";
}

// ------------------------------------------------------------- курсор
// Курсор GET /cards — { rev, id } последней отданной строки. Когда отдано
// всё, id = "~": он больше любого id строки (ID_RE), так что «всё до rev
// включительно получено», и следующий запрос без изменений не читает
// таблицу карточек вовсе.
const DONE = "~";

function isCaughtUp(userRev, cursor) {
  return (userRev || 0) < cursor.rev || ((userRev || 0) === cursor.rev && cursor.id === DONE);
}

function pageResult(items, cursor, more) {
  const last = items[items.length - 1];
  if (!last) return { items, cursor: { rev: cursor.rev, id: more ? cursor.id : DONE }, more };
  return { items, cursor: { rev: last.rev, id: more ? last.id : DONE }, more };
}

// ------------------------------------------------------- общие папки
// Папка с public: true в строке folders любого пользователя видна всем,
// вместе с её колодами — но только колодами самого владельца папки.
// Остальные папки и колоды сервер не отдаёт никому, кроме владельца
// (GET /cards). Папки издателей (PUBLISHER_TELEGRAM_IDS) идут первыми.
const DECK_ID_RE = /^[A-Za-z0-9_.-]{1,96}$/;

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Текст строки folders → публичные папки [{ id, title, decks: [id, …] }],
// не больше max.
function publicFolders(text, max) {
  const list = parse(text);
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const f of list) {
    if (max !== undefined && out.length >= max) break;
    if (!f || f.public !== true || !DECK_ID_RE.test(String(f.id || ""))) continue;
    const decks = Array.from(new Set((Array.isArray(f.decks) ? f.decks : []).filter((d) => typeof d === "string" && DECK_ID_RE.test(d))));
    out.push({ id: f.id, title: str(f.title, 60) || f.id, decks });
  }
  return out;
}

// id и текст строки deck:<id> → { id, title, words } только с полями слова.
function publicDeck(id, text) {
  const d = parse(text);
  if (!d || typeof d !== "object" || !Array.isArray(d.words)) return null;
  const words = [];
  for (const w of d.words) {
    const hanzi = w && str(w.hanzi, 40);
    if (hanzi) words.push({ hanzi, pinyin: str(w.pinyin, 100), translation: str(w.translation, 200) });
  }
  return words.length ? { id, title: str(d.title, 60) || id, words } : null;
}

// Есть ли в строке folders хотя бы одна общая папка (для public_owners).
function hasPublicFolder(text) {
  return publicFolders(text, 1).length > 0;
}

// Папки и колоды нескольких владельцев → ответ GET /public. sources —
// [{ folders: текст строки folders, decks: id → текст строки deck:<id> }].
// В папке остаются только колоды её владельца: чужой id (такой же у
// колоды другого человека) в общую папку не попадёт. Не больше
// limits.publicMaxDecks колод и limits.publicMaxBytes байт; одинаковые id
// папок и колод — у первого владельца; папка без колод не показывается.
function publicSet(sources, limits) {
  const folders = [];
  const decks = [];
  const seenFolder = new Set();
  const deckOwner = new Map();        // id колоды → номер владельца
  let bytes = 0;
  sources.forEach((src, owner) => {
    for (const f of publicFolders(src.folders, limits.publicMaxFoldersPerUser)) {
      if (seenFolder.has(f.id)) continue;
      const kept = [];
      for (const id of f.decks) {
        if (deckOwner.has(id)) {
          if (deckOwner.get(id) === owner) kept.push(id);
          continue;
        }
        if (decks.length >= limits.publicMaxDecks) continue;
        const text = src.decks.get(id);
        const deck = text ? publicDeck(id, text) : null;
        if (!deck) continue;
        const size = Buffer.byteLength(JSON.stringify(deck), "utf8");
        if (bytes + size > limits.publicMaxBytes) continue;
        bytes += size;
        deckOwner.set(id, owner);
        decks.push(deck);
        kept.push(id);
      }
      if (!kept.length) continue;
      seenFolder.add(f.id);
      folders.push({ id: f.id, title: f.title, decks: kept });
    }
  });
  return { folders, decks };
}

// Какие строки deck:<id> прочитать для публичных папок (текст строки folders).
function publicDeckIds(text, limits) {
  const ids = new Set();
  for (const f of publicFolders(text, limits.publicMaxFoldersPerUser)) for (const id of f.decks) ids.add(id);
  return Array.from(ids).slice(0, limits.publicMaxDecks).map((id) => "deck:" + id);
}

module.exports = {
  ID_RE, FIELD, DONE, validateItems, planPush, planMerge, mergeData, decideLink, isCaughtUp, pageResult, utcDay,
  publicFolders, publicDeck, publicSet, publicDeckIds, hasPublicFolder
};
