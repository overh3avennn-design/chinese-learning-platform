"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { emptyHistory, apply } = require("../src/chat");

const clientSource = readFileSync(resolve(__dirname, "../../js/assistant.js"), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));

class Node {
  constructor() {
    this.children = [];
    this.controls = new Map();
    this.handlers = {};
    this.value = "";
    this.style = {};
    this.scrollHeight = 20;
  }
  set textContent(value) { this.children = []; this.text = value; }
  get textContent() { return this.text; }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  fire(name, e = {}) { return this.handlers[name](e); }
  appendChild(node) { node.parentNode = this; this.children.push(node); }
  removeChild(node) { this.children = this.children.filter(c => c !== node); node.parentNode = null; }
  add(node) { this.appendChild(node); }
  querySelector(s) {
    if (!this.controls.has(s)) this.controls.set(s, new Node());
    return this.controls.get(s);
  }
  querySelectorAll() { return []; }
  setAttribute() {}
  focus() {}
}

function storage() {
  const data = new Map();
  return { setItem: (k, v) => data.set(k, v), getItem: k => data.get(k) || null,
    removeItem: k => data.delete(k), key: i => Array.from(data.keys())[i], get length() { return data.size; } };
}

function client(initialUser, histories, disk = storage()) {
  const root = new Node();
  const hooks = [];
  let user = initialUser;
  let failWriteOnce = false;
  const account = {
    user: () => user && { id: user },
    onChange: fn => hooks.push(fn),
    api: async (method, path, op) => {
      assert.equal(path, "/chat");
      const h = histories.get(user) || emptyHistory();
      if (method === "GET") return JSON.parse(JSON.stringify(h));
      const next = apply(h, op);
      histories.set(user, next);
      if (failWriteOnce) {
        failWriteOnce = false;
        throw new Error("connection lost after commit");
      }
      return { epoch: next.epoch };
    }
  };
  const window = new Node();
  Object.assign(window, { Account: account, sessionStorage: storage(), crypto: webcrypto, confirm: () => true,
    scrollTo() {}, AI: { text: s => s, markdown: s => s, ask: async () => ({ text: "Ответ" }) } });
  vm.runInNewContext(clientSource, { window, localStorage: disk, document: { addEventListener() {}, querySelector: () => root,
    createElement: () => new Node(), documentElement: {} }, Option: class {} });
  const control = name => root.querySelector("[data-" + name + "]");
  return {
    control, root, disk, ask(text) {
      control("input").value = text;
      control("form").fire("submit", { preventDefault() {} });
    },
    login(value) { user = value; hooks.forEach(fn => fn()); },
    loseAck() { failWriteOnce = true; }
  };
}

test("помощник: сервер подтвердил запись, ответ потерян, повтор после перезагрузки без дублей", async () => {
  const histories = new Map();
  const a = client("alice", histories);
  await settle();
  a.loseAck();
  a.ask("你好?");
  await settle();
  // Первая попытка успевает закоммитить вопрос, ответ также сохраняется в очереди.
  const b = client("alice", histories, a.disk);
  await settle();
  assert.deepEqual(histories.get("alice").messages.map(m => m.content), ["你好?", "Ответ"]);
  assert.equal(a.disk.length, 0);
  const otherDevice = client("alice", histories);
  await settle();
  assert.equal(otherDevice.control("log").children.length, 2);
});

test("помощник: смена пользователя, гостевой диалог, удаление только своей истории", async () => {
  const histories = new Map();
  const tab = client(null, histories);
  tab.ask("Вопрос гостя");
  await settle();
  tab.login("alice");
  await settle();
  assert.equal(tab.control("log").children.length, 0);
  tab.ask("Мой вопрос");
  await settle();
  tab.login("bob");
  await settle();
  assert.equal(tab.control("log").children.length, 0);
  tab.ask("Другой вопрос");
  await settle();
  await tab.control("history-clear").fire("click");
  assert.equal(histories.get("bob").messages.length, 0);
  assert.equal(histories.get("alice").messages.length, 2);
  tab.login(null);
  assert.equal(tab.control("history").hidden, true);
  assert.equal(tab.control("log").children.length, 2);
});
