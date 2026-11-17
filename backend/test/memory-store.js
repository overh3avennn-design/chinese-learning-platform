"use strict";

// Хранилище в памяти с тем же поведением, что store-ydb.js, — для тестов
// маршрутов, квот, изоляции пользователей и слияния аккаунтов.

const crypto = require("crypto");
const { unauthorized } = require("../src/errors");
const { FIELD, planPush, planMerge, decideLink, isCaughtUp, pageResult } = require("../src/sync");

function createMemoryStore() {
  const users = new Map();            // id → user
  const cards = new Map();            // userId → Map(id → row)

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
      Object.assign(u, plan.counters);
      return { rev: plan.rev, results: plan.results };
    }
  };
}

module.exports = { createMemoryStore };
