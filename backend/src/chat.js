"use strict";

const { HttpError, badRequest } = require("./errors");
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const MAX_BYTES = 768 * 1024;

const emptyHistory = () => ({ epoch: "initial", messages: [] });

function validateMessage(raw) {
  if (!raw || !ID.test(String(raw.id || "")) || typeof raw.id !== "string" ||
      typeof raw.chat !== "string" || !ID.test(raw.chat) ||
      !["user", "assistant"].includes(raw.role) ||
      typeof raw.content !== "string" || !raw.content.trim() || raw.content.length > 48000 ||
      !Number.isSafeInteger(raw.time) || raw.time < 1 || raw.time > 8640000000000000) {
    throw badRequest("bad_chat_message");
  }
  return { id: raw.id, chat: raw.chat, role: raw.role, content: raw.content, time: raw.time, truncated: raw.truncated === true };
}

function fit(history) {
  if (Buffer.byteLength(JSON.stringify(history)) > MAX_BYTES) throw new HttpError(413, "chat_full");
  return history;
}

function apply(history, op) {
  if (op.action === "clear" && history.epoch === op.next) return history;
  if (history.epoch !== op.epoch) throw new HttpError(409, "history_cleared");
  if (op.action === "clear") return { epoch: op.next, messages: [] };
  const existing = history.messages.find(m => m.id === op.message.id);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(op.message)) throw new HttpError(409, "message_conflict");
    return history;
  }
  return fit({ epoch: history.epoch, messages: history.messages.concat(op.message) });
}

async function chatRoute(method, userId, body, store) {
  if (method === "GET") return store.chatHistory(userId);
  if (method !== "POST") throw new HttpError(405, "method_not_allowed");
  if (typeof body.epoch !== "string" || !ID.test(body.epoch)) throw badRequest("bad_chat_epoch");
  let op;
  if (body.action === "clear" && typeof body.next === "string" && ID.test(body.next) && body.next !== "initial" && body.next !== body.epoch) {
    op = { action: "clear", epoch: body.epoch, next: body.next };
  } else if (body.action === "append") {
    op = { action: "append", epoch: body.epoch, message: validateMessage(body.message) };
  } else throw badRequest("bad_chat_action");
  return store.updateChat(userId, op);
}

module.exports = { emptyHistory, fit, apply, chatRoute };
