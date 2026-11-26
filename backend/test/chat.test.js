"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { createApp } = require("../src/app");
const { signToken } = require("../src/jwt");
const { emptyHistory, apply } = require("../src/chat");

function setup() {
  const histories = new Map();
  const secret = randomBytes(48).toString("hex");
  const store = {
    chatHistory(uid) { return histories.get(uid) || emptyHistory(); },
    updateChat(uid, op) {
      const h = apply(this.chatHistory(uid), op);
      histories.set(uid, h);
      return { epoch: h.epoch };
    }
  };
  const app = createApp({ store, config: { jwtSecret: secret } });
  return async function request(user, body) {
    const headers = {};
    if (user) headers.authorization = "Bearer " + signToken(user, secret).token;
    const res = await app({ path: "/chat", method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : "", headers, ip: "local" });
    return { status: res.status, data: JSON.parse(res.body) };
  };
}

const append = (id, role = "user") => ({ action: "append", epoch: "initial",
  message: { id, chat: "lesson", role, time: role === "user" ? 1 : 2, content: role === "user" ? "你好?" : "Здравствуйте!" } });

test("история доступна только владельцу, игнорирует чужой user_id в теле", async () => {
  const req = setup();
  assert.equal((await req(null)).status, 401);
  assert.equal((await req(null, append("a"))).status, 401);
  assert.equal((await req("a", { ...append("a"), user_id: "b" })).status, 200);
  assert.deepEqual((await req("b")).data.messages, []);
  assert.equal((await req("a")).data.messages[0].chat, "lesson");
  await req("b", { action: "clear", epoch: "initial", next: "empty", user_id: "a" });
  assert.equal((await req("a")).data.messages.length, 1);
});

test("два клиента, повторная отправка, порядок и коллизия идентификаторов", async () => {
  const req = setup();
  await Promise.all([req("a", append("q")), req("a", append("q"))]);
  await req("a", append("a", "assistant"));
  const view = (await req("a")).data.messages;
  assert.deepEqual(view.map(m => [m.id, m.time]), [["q", 1], ["a", 2]]);
  assert.equal((await req("a", append("q", "assistant"))).status, 409);
  assert.deepEqual((await req("a")).data.messages, view);
});

test("удаление повторяемо и отклоняет позднюю отправку со старого устройства", async () => {
  const req = setup();
  await req("a", append("q"));
  const clear = { action: "clear", epoch: "initial", next: "new-epoch" };
  assert.equal((await req("a", clear)).status, 200);
  assert.equal((await req("a", { ...append("new"), epoch: "new-epoch" })).status, 200);
  assert.equal((await req("a", clear)).status, 200);
  assert.equal((await req("a", append("stale"))).status, 409);
  assert.deepEqual((await req("a")).data.messages.map(m => m.id), ["new"]);
});

test("некорректные сообщения и переполнение не меняют историю", async () => {
  const req = setup();
  const op = append("q");
  op.message.content = "";
  assert.equal((await req("a", op)).status, 400);
  op.message.content = "中".repeat(45000);
  for (let i = 0; i < 5; i++) {
    op.message.id = "q" + i;
    assert.equal((await req("a", op)).status, 200);
  }
  op.message.id = "overflow";
  assert.equal((await req("a", op)).status, 413);
  assert.equal((await req("a")).data.messages.length, 5);
});
