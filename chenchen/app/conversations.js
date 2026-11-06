"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

class ConversationStore {
  constructor(directory) { this.directory = path.resolve(directory); this.queues = new Map(); }
  file(owner) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(owner)) throw Object.assign(new Error("INVALID_OWNER"), { statusCode: 400 });
    return path.join(this.directory, `${owner}.json`);
  }
  async read(owner) {
    try {
      const state = JSON.parse(await fs.readFile(this.file(owner), "utf8"));
      if (state.version !== "app.v1" || state.owner_id !== owner || !Array.isArray(state.conversations)) throw new Error("invalid state");
      return state;
    } catch (cause) {
      if (cause.code === "ENOENT") return { version: "app.v1", owner_id: owner, conversations: [] };
      throw Object.assign(new Error("CONVERSATION_STORAGE_UNAVAILABLE"), { statusCode: 503 });
    }
  }
  async transact(owner, change) {
    const previous = this.queues.get(owner) || Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const state = await this.read(owner);
      const result = await change(state);
      await fs.mkdir(this.directory, { recursive: true });
      const target = this.file(owner), temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, target);
      } catch {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw Object.assign(new Error("CONVERSATION_STORAGE_UNAVAILABLE"), { statusCode: 503 });
      }
      return structuredClone(result);
    });
    this.queues.set(owner, work);
    try { return await work; } finally { if (this.queues.get(owner) === work) this.queues.delete(owner); }
  }
}

module.exports = { ConversationStore };
