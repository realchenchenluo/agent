"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { empty, validateState, error } = require("./engine");

class FileRepository {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.queues = new Map();
  }

  file(ownerId) {
    if (typeof ownerId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(ownerId)) throw error("INVALID_OWNER");
    return path.join(this.directory, `${ownerId}.json`);
  }

  async read(ownerId) {
    let raw;
    try { raw = await fs.readFile(this.file(ownerId), "utf8"); }
    catch (cause) { if (cause.code === "ENOENT") return empty(ownerId); throw error("PERSISTENCE_UNAVAILABLE", 503); }
    try {
      const state = JSON.parse(raw);
      return validateState(state, ownerId);
    } catch { throw error("PERSISTENCE_CORRUPT", 503); }
  }

  async write(ownerId, state) {
    const target = this.file(ownerId);
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, target);
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error("PERSISTENCE_UNAVAILABLE", 503);
    }
  }

  async transact(ownerId, fn) {
    const before = this.queues.get(ownerId) || Promise.resolve();
    const work = before.catch(() => {}).then(async () => {
      const state = await this.read(ownerId);
      const result = await fn(state);
      await this.write(ownerId, state);
      return structuredClone(result);
    });
    this.queues.set(ownerId, work);
    try { return await work; }
    finally { if (this.queues.get(ownerId) === work) this.queues.delete(ownerId); }
  }

  async owners() {
    let entries;
    try { entries = await fs.readdir(this.directory); }
    catch (cause) { if (cause.code === "ENOENT") return []; throw error("PERSISTENCE_UNAVAILABLE", 503); }
    return entries.filter(name => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}\.json$/.test(name)).map(name => name.slice(0, -5));
  }
}

module.exports = { FileRepository };
