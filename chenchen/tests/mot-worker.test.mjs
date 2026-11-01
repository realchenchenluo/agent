import test from "node:test";
import assert from "node:assert/strict";
import worker, { ReviewService } from "../deployment/worker.js";
import staging from "../deployment/mot-staging-entry.js";
import motModule from "../mot/engine.js";

const { fixture } = motModule;
const keyA = "mot-worker-owner-a-key-123456789", keyB = "mot-worker-owner-b-key-123456789";
function setup() {
  const records = new Map();
  const storage = {
    async get(key) { return structuredClone(records.get(key)); },
    async put(key, value) {
      if (arguments.length === 1) for (const [name, row] of Object.entries(key)) records.set(name, structuredClone(row));
      else records.set(key, structuredClone(value));
    },
    async list({ prefix }) { return new Map([...records].filter(([key]) => key.startsWith(prefix))); }
  };
  const env = { MOT_AUTH_TOKENS_JSON: JSON.stringify([
    { owner_id: "owner-a", token: keyA, roles: ["read", "operator", "approver", "ingestor"] },
    { owner_id: "owner-b", token: keyB, roles: ["read", "operator", "approver", "ingestor"] }
  ]), MOT_CRON_SECRET: "synthetic-cron-secret-123456789", CORS_ORIGINS: "*" };
  let service = new ReviewService({ storage }, env);
  env.REVIEW_SERVICE = { idFromName: value => value, get: () => service };
  return { env, storage, restart() { service = new ReviewService({ storage }, env); } };
}
async function call(app, route, body, token = keyA) {
  const request = new Request(`https://mot.example${route}`, { method: body === undefined ? "GET" : "POST",
    headers: token ? { "X-Mot-Key": token, "Content-Type": "application/json" } : {},
    body: body === undefined ? undefined : JSON.stringify(body) });
  const response = await worker.fetch(request, app.env);
  return { status: response.status, data: await response.json() };
}

test("Worker uses existing ReviewService Durable Object, owner isolation and restart recovery", async () => {
  const app = setup();
  assert.equal((await call(app, "/api/mot/overview", undefined, null)).status, 401);
  const ingested = await call(app, "/api/mot/events/ingest", { snapshot: fixture(new Date().toISOString()), idempotency_key: "worker-seed" });
  assert.equal(ingested.status, 200);
  assert.equal(ingested.data.check.tasks_created.length, 2);
  assert.equal((await call(app, "/api/mot/overview")).data.total_verified_minor, 1_500_000);
  assert.equal((await call(app, "/api/mot/overview", undefined, keyB)).data.total_verified_minor, null);
  const check = await call(app, "/api/mot/check", { idempotency_key: "worker-check" });
  assert.equal(check.data.tasks_created.length, 0);
  app.restart();
  assert.equal((await call(app, "/api/mot/tasks")).data.items.length, 2);
  assert.equal((await call(app, `/api/mot/tasks/${ingested.data.check.tasks_created[0]}`, undefined, keyB)).status, 404);
  assert.equal((await call(app, "/api/mot/health")).data.core_risk, "UNAVAILABLE");
});

test("Worker scheduled trigger has a separate secret and never duplicates an Inbox task", async () => {
  const app = setup();
  await call(app, "/api/mot/events/ingest", { snapshot: fixture(new Date().toISOString()), idempotency_key: "cron-seed" });
  const pending = [];
  const ctx = { waitUntil: promise => pending.push(promise) };
  await worker.scheduled({}, app.env, ctx);
  await Promise.all(pending);
  assert.equal((await call(app, "/api/mot/inbox")).data.items.length, 2);
  await worker.scheduled({}, app.env, ctx);
  await Promise.all(pending);
  assert.equal((await call(app, "/api/mot/inbox")).data.items.length, 2);
  const unauthenticated = await app.env.REVIEW_SERVICE.get().fetch(new Request("https://mot.example/api/mot/internal/tick", { method: "POST" }));
  assert.equal(unauthenticated.status, 401);
});

test("Worker storage failure returns unavailable and does not fabricate a task", async () => {
  const app = setup();
  const original = app.storage.put;
  app.storage.put = async () => { throw new Error("synthetic storage failure"); };
  const response = await call(app, "/api/mot/events/ingest", { snapshot: fixture(new Date().toISOString()), idempotency_key: "failed-seed" });
  assert.equal(response.status, 503);
  app.storage.put = original;
  assert.equal((await call(app, "/api/mot/tasks")).data.items.length, 0);
});

test("MOT staging entry rejects unrelated public review routes", async () => {
  const app = setup();
  const unrelated = await staging.fetch(new Request("https://mot.example/api/review/tasks"), app.env, {});
  assert.equal(unrelated.status, 404);
  const mot = await staging.fetch(new Request("https://mot.example/api/mot/overview"), app.env, {});
  assert.equal(mot.status, 401);
});
