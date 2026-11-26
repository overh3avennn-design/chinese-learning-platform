"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryStore } = require("./memory-store");
const { validateItems } = require("../src/sync");
const { LIMITS } = require("../src/limits");

test("отдельные публикации изолированы по владельцу, копия независима от публикации", async () => {
  const store = createMemoryStore();
  let now = 100;
  const owner = await store.login({ provider: "telegram", subject: 1, name: "Лена" }, now);
  const reader = await store.login({ provider: "telegram", subject: 2, name: "Маша" }, now);
  const title = "Одинаковый локальный id";
  const source = { title, words: [{ hanzi: "水", pinyin: "shuǐ", translation: "вода" }] };
  async function write(user, id, data) {
    now += 1;
    const items = validateItems([{ id, data, updatedAt: now }], LIMITS, now);
    await store.push(user.id, items, LIMITS, now);
  }
  const publication = [{ id: "published-decks", public: true, decks: ["local"] }];
  const catalog = async () => (await store.publicCards([], LIMITS)).catalog || [];
  await write(owner, "deck:local", source);
  await write(reader, "folders", publication);
  assert.deepEqual(await catalog(), []);
  await write(owner, "folders", publication);
  const [original] = await catalog();
  assert.equal(original.author, "Лена");
  assert.deepEqual(original.words, source.words);
  assert.deepEqual((await store.publicCards([], LIMITS)).folders, []);
  await write(reader, "deck:copy", { title: original.title, words: original.words });
  await write(reader, "deck:local", { title: "Другая", words: [{ hanzi: "茶" }] });
  const both = await catalog();
  assert.equal(new Set(both.map((d) => d.id)).size, 2);
  assert.deepEqual(both.find((d) => d.id === original.id), original);
  await write(owner, "folders", []);
  assert.deepEqual((await catalog()).map((d) => d.author), ["Маша"]);
  const mine = await store.pull(reader.id, { rev: 0, id: "" }, LIMITS);
  assert.deepEqual(mine.items.find((r) => r.id === "deck:copy").data, source);
});
