"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../../js/own-decks.js"), "utf8");

function setup(initial) {
  let raw = initial;
  let changes = 0;
  const localStorage = {
    getItem: () => raw,
    setItem: (_, value) => { raw = value; }
  };
  const window = { localStorage, CloudSync: { changed: () => changes++ } };
  vm.runInNewContext(source, { window });
  return { decks: window.OwnDecks, read: () => raw, changes: () => changes, localStorage };
}

const word = { hanzi: " 水 ", pinyin: "shuǐ", translation: "вода" };
test("Словарь создаёт свою колоду и сохраняет отредактированное слово в общем формате", () => {
  const client = setup(null);
  const deck = client.decks.addWord({ title: " Вода " }, word);
  const saved = JSON.parse(client.read()).decks[0];
  assert.match(saved.id, /^my-[a-z0-9]+$/);
  assert.equal(saved.id, deck.id);
  assert.equal(saved.title, "Вода");
  assert.deepEqual(saved.words, [{ ...word, hanzi: "水" }]);
  assert.equal(client.changes(), 1);
});

test("Словарь исключает повтор по иероглифу и чтению, сохраняет остальные данные", () => {
  const initial = { decks: [{ id: "old", title: "HSK", words: [] }], folders: [{ id: "f", decks: ["old"] }], extra: { builtin: [word] } };
  const client = setup(JSON.stringify(initial));
  client.decks.addWord({ id: "old" }, word);
  const saved = client.read();
  assert.throws(() => client.decks.addWord({ id: "old" }, { ...word, translation: "новый перевод" }), /уже есть/);
  assert.equal(client.read(), saved);
  assert.equal(client.changes(), 1);
  const data = JSON.parse(saved);
  assert.deepEqual(data.folders, initial.folders);
  assert.deepEqual(data.extra, initial.extra);
  assert.throws(() => client.decks.addWord({ id: "builtin" }, word), /недоступна/);
});

test("При сбое хранилища словарь не затирает данные и не объявляет об успешной записи", () => {
  const client = setup("не JSON");
  assert.throws(() => client.decks.addWord({ title: "HSK" }, word));
  assert.equal(client.read(), "не JSON");
  client.localStorage.getItem = () => null;
  client.localStorage.setItem = () => { throw new Error("quota"); };
  assert.throws(() => client.decks.addWord({ title: "HSK" }, word), /не удалось сохранить/);
  assert.equal(client.changes(), 0);
});

test("На втором устройстве слово из словаря доступно через обычную синхронизацию карточек", async () => {
  const { createMemoryStore } = require("./memory-store");
  const { validateItems } = require("../src/sync");
  const { LIMITS } = require("../src/limits");
  const store = createMemoryStore();
  const user = await store.login({ provider: "telegram", subject: 77, name: "Маша" }, Date.now());
  const cloud = fs.readFileSync(path.join(__dirname, "../../js/cloud-sync.js"), "utf8");

  function device() {
    let activeUser = user;
    let holdPull;
    const items = new Map();
    const noop = () => {};
    const window = {
      addEventListener: noop,
      localStorage: {
        get length() { return items.size; },
        key: (i) => Array.from(items.keys())[i],
        getItem: (key) => items.get(key) || null,
        setItem: (key, value) => items.set(key, value),
        removeItem: (key) => items.delete(key)
      },
      Account: {
        enabled: true, user: () => activeUser, onChange: noop,
        api(method, url, body) {
          if (method === "GET") {
            const q = new URL(url, "https://example.test").searchParams;
            const result = store.pull(activeUser.id, { rev: Number(q.get("rev")), id: q.get("id") }, LIMITS);
            return holdPull ? holdPull.then(() => result) : result;
          }
          assert.equal(method, "PUT");
          return store.push(activeUser.id, validateItems(body.items, LIMITS, Date.now()), LIMITS, Date.now());
        }
      }
    };
    // Все отложенные сверки в тесте выполняются явно через syncNow.
    const ctx = { window, Blob, document: { addEventListener: noop }, location: { pathname: "/dictionary/" }, setTimeout: noop, clearTimeout: noop };
    vm.runInNewContext(cloud, ctx);
    vm.runInNewContext(source, ctx);
    window.CloudSync.start();
    return Object.assign(window, {
      signedOut() { activeUser = null; },
      delayPull(promise) { holdPull = promise; }
    });
  }

  const a = device();
  await a.CloudSync.syncNow();
  const id = a.OwnDecks.addWord({ title: "Вода" }, word).id;
  await a.CloudSync.syncNow();

  const b = device();
  await b.CloudSync.syncNow();
  assert.equal(b.OwnDecks.list()[0].id, id);
  assert.equal(b.OwnDecks.list()[0].words[0].translation, "вода");
  b.OwnDecks.addWord({ id }, { hanzi: "茶", pinyin: "chá", translation: "чай" });
  await b.CloudSync.syncNow();
  await a.CloudSync.syncNow();
  assert.equal(a.OwnDecks.list()[0].words[1].hanzi, "茶");

  // Ответ прежней сессии не возвращает данные после выхода.
  const c = device();
  let release;
  c.delayPull(new Promise(resolve => { release = resolve; }));
  const inFlight = c.CloudSync.syncNow();
  c.signedOut();
  await c.CloudSync.clearLocal(false);
  release();
  await inFlight;
  assert.deepEqual(JSON.parse(JSON.stringify(c.OwnDecks.list())), []);
  assert.equal(c.localStorage.getItem("cloud-sync"), null);
});
