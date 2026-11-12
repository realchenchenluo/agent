"use strict";

class MotScheduler {
  constructor(engine, { intervalMs = 15 * 60_000, now = () => Date.now() } = {}) {
    this.engine = engine;
    this.intervalMs = intervalMs;
    this.now = now;
    this.timer = null;
    this.running = false;
    this.lastError = null;
    this.nextRunAt = null;
  }

  async tick() {
    if (this.running) return { skipped: "ALREADY_RUNNING" };
    this.running = true;
    try {
      const bucket = Math.floor(this.now() / this.intervalMs);
      const owners = await this.engine.repository.owners();
      const results = [];
      for (const owner of owners) results.push(await this.engine.check(owner,
        { trigger: "scheduled", requestKey: `scheduled-${bucket}` }));
      this.lastError = null;
      return { checked: results.length, results };
    } catch (error) {
      this.lastError = { code: error.code || "SCHEDULER_FAILED", at: new Date(this.now()).toISOString() };
      throw error;
    } finally { this.running = false; }
  }

  start() {
    if (this.timer) return;
    this.tick().catch(() => {});
    this.nextRunAt = new Date(this.now() + this.intervalMs).toISOString();
    this.timer = setInterval(() => {
      this.nextRunAt = new Date(this.now() + this.intervalMs).toISOString();
      this.tick().catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.nextRunAt = null; }
}

module.exports = { MotScheduler };
