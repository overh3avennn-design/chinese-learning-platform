"use strict";

const { TypedValues } = require("ydb-sdk");
const { unauthorized, HttpError } = require("./errors");
const { emptyHistory, apply, fit } = require("./chat");

async function read(session, run, uid) {
  const [rows] = await run(session, "DECLARE $uid AS Utf8; SELECT data FROM chat_history WHERE user_id = $uid;",
    { $uid: TypedValues.utf8(uid) });
  return rows.length ? JSON.parse(rows[0].data) : emptyHistory();
}

async function write(session, run, uid, history) {
  await run(session, "DECLARE $uid AS Utf8; DECLARE $data AS Utf8; UPSERT INTO chat_history (user_id, data) VALUES ($uid, $data);",
    { $uid: TypedValues.utf8(uid), $data: TypedValues.utf8(JSON.stringify(history)) });
}

function createChatStore({ tx, run, readUser, RW, RO }) {
  async function load(session, uid) {
    if (!(await readUser(session, uid))) throw unauthorized("user_gone");
    return read(session, run, uid);
  }
  return {
    chatHistory(uid) {
      return tx("chatHistory", RO, s => load(s, uid));
    },
    updateChat(uid, op) {
      return tx("updateChat", RW, async s => {
        const before = await load(s, uid);
        const after = apply(before, op);
        if (before !== after) await write(s, run, uid, after);
        return { epoch: after.epoch };
      });
    }
  };
}

async function mergeChatHistory(session, run, target, source) {
  const src = await read(session, run, source);
  if (src.messages.length) {
    const dest = await read(session, run, target);
    const ids = new Set(dest.messages.map(m => m.id));
    if (src.messages.some(m => ids.has(m.id))) throw new HttpError(409, "chat_merge_conflict");
    await write(session, run, target, fit({ epoch: dest.epoch, messages: dest.messages.concat(src.messages) }));
  }
  await run(session, "DECLARE $uid AS Utf8; DELETE FROM chat_history WHERE user_id = $uid;", { $uid: TypedValues.utf8(source) });
}

module.exports = { createChatStore, mergeChatHistory };
