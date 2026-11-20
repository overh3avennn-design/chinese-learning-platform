"use strict";

// Хранилище в памяти с тем же поведением, что store-ydb.js, — для тестов
// маршрутов, квот, изоляции пользователей и слияния аккаунтов.

const crypto = require("crypto");
const { unauthorized } = require("../src/errors");
const { FIELD, planPush, planMerge, decideLink, isCaughtUp, pageResult, publicSet, publicDeckIds, hasPublicFolder } = require("../src/sync");

function createMemoryStore() {
  const users = new Map();            // id → user
  const cards = new Map();            // userId → Map(id → row)
  const publicOwners = new Map();     // userId → updatedAt (таблица public_owners)

  // Как в store-ydb.js: строка public_owners по строке folders.
  function indexFolders(userId, row, now) {
    if (row && !row.deleted && hasPublicFolder(row.data)) publicOwners.set(userId, now);
    else publicOwners.delete(userId);
  }

  function find(identity) {
    const field = FIELD[identity.provider];
    for (const u of users.values()) if (u[field] === identity.subject) return u;
    return null;
  }

  function counters(u) {
    return { rev: u.rev, rowsCount: u.rowsCount, bytesTotal: u.bytesTotal, quotaDay: u.quotaDay, quotaWrites: u.quotaWrites };
  }

  return {
    users,
    cards,
    publicOwners,

    async login(identity, now) {
      let u = find(identity);
      if (!u) {
        u = {
          id: crypto.randomUUID(), telegramId: null, googleSub: null, name: "", photo: "", createdAt: now,
          rev: 0, rowsCount: 0, bytesTotal: 0, quotaDay: 0, quotaWrites: 0
        };
        u[FIELD[identity.provider]] = identity.subject;
        users.set(u.id, u);
      }
      u.name = identity.name;
      u.photo = identity.photo;
      return Object.assign({}, u);
    },

    async getUser(id) {
      const u = users.get(id);
      return u ? Object.assign({}, u) : null;
    },

    async link(userId, identity, limits, now) {
      const current = users.get(userId);
      if (!current) throw unauthorized("user_gone");
      const owner = find(identity);
      const action = decideLink(current, owner, identity);
      if (action === "none") return { user: Object.assign({}, current), merged: false };
      if (action === "merge") {
        const target = Array.from((cards.get(current.id) || new Map()).values());
        const source = Array.from((cards.get(owner.id) || new Map()).values());
        const plan = planMerge(target, source, limits, now, current.rev);
        const mine = cards.get(current.id) || new Map();
        for (const r of plan.upserts) mine.set(r.id, r);
        cards.set(current.id, mine);
        cards.delete(owner.id);
        users.delete(owner.id);
        publicOwners.delete(owner.id);
        indexFolders(current.id, mine.get("folders"), now);
        Object.assign(current, { rev: plan.rev, rowsCount: plan.rowsCount, bytesTotal: plan.bytesTotal });
      }
      current[FIELD[identity.provider]] = identity.subject;
      return { user: Object.assign({}, current), merged: action === "merge" };
    },

    async pull(userId, cursor, limits) {
      const u = users.get(userId);
      if (!u) throw unauthorized("user_gone");
      if (isCaughtUp(u.rev, cursor)) return { items: [], cursor, more: false };
      const rows = Array.from((cards.get(userId) || new Map()).values())
        .filter((r) => r.rev > cursor.rev || (r.rev === cursor.rev && r.id > cursor.id))
        .sort((a, b) => a.rev - b.rev || (a.id < b.id ? -1 : 1));
      const items = [];
      let bytes = 0;
      for (const r of rows) {
        if (items.length >= limits.pullPageRows || (items.length && bytes + r.size > limits.pullPageBytes)) break;
        bytes += r.size;
        items.push({ id: r.id, data: r.deleted ? null : JSON.parse(r.data), deleted: r.deleted, updatedAt: r.updatedAt, rev: r.rev });
      }
      return pageResult(items, cursor, items.length < rows.length);
    },

    async push(userId, items, limits, now) {
      const u = users.get(userId);
      if (!u) throw unauthorized("user_gone");
      const mine = cards.get(userId) || new Map();
      const existing = new Map();
      for (const it of items) if (mine.has(it.id)) existing.set(it.id, mine.get(it.id));
      const plan = planPush(counters(u), existing, items, limits, now);
      for (const r of plan.upserts) mine.set(r.id, r);
      cards.set(userId, mine);
      const folders = plan.upserts.find((r) => r.id === "folders");
      if (folders) indexFolders(userId, folders, now);
      Object.assign(u, plan.counters);
      return { rev: plan.rev, results: plan.results };
    },

    async publicCards(telegramIds, limits) {
      const order = [];
      const add = (uid) => { if (uid && !order.includes(uid)) order.push(uid); };
      for (const tg of telegramIds) {
        const u = find({ provider: "telegram", subject: Number(tg) });
        if (u) add(u.id);
      }
      Array.from(publicOwners.entries()).sort((a, b) => b[1] - a[1]).slice(0, limits.publicMaxOwners).forEach(([uid]) => add(uid));
      const sources = [];
      for (const uid of order) {
        const mine = cards.get(uid);
        const f = mine && mine.get("folders");
        if (!f || f.deleted || !f.data) continue;
        const decks = new Map();
        for (const id of publicDeckIds(f.data, limits)) {
          const r = mine.get(id);
          if (r && !r.deleted && r.data) decks.set(id.slice(5), r.data);
        }
        sources.push({ folders: f.data, decks });
      }
      return publicSet(sources, limits);
    }
  };
}

module.exports = { createMemoryStore };
