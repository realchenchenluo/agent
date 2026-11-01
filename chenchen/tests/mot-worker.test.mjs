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
    async transaction(update) {
      const next = new Map(records);
      const result = await update({ get: async name => structuredClone(next.get(name)),
        put: async (name, value) => next.set(name, structuredClone(value)) });
      records.clear(); for (const [name, value] of next) records.set(name, value);
      return result;
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

test("Worker monitor survives restart and writes one owner-scoped Inbox alert", async () => {
  const app = setup();
  await call(app, "/api/mot/events/ingest", { snapshot: fixture(new Date().toISOString()), idempotency_key: "monitor-worker-seed" });
  const input = { scope: "POOL", threshold_minor: 900_000, frequency_minutes: 15, channel: "INBOX_ONLY",
    timezone: "Asia/Shanghai", request_key: "monitor-worker-create" };
  const created = await call(app, "/api/mot/monitors", input);
  assert.equal(created.status, 201);
  const monitorId = created.data.monitor_id;
  assert.equal((await call(app, "/api/mot/monitors", undefined, keyB)).data.items.length, 0);
  assert.equal((await call(app, `/api/mot/monitors/${monitorId}`, { action: "PAUSE", request_key: "cross-owner-pause" }, keyB)).status, 404);
  const first = await call(app, "/api/mot/check", { idempotency_key: "monitor-worker-manual-1" });
  assert.equal(first.status, 200);
  assert.equal((await call(app, "/api/mot/tasks")).data.items.filter(row => row.kind === "MONITOR_BELOW_THRESHOLD").length, 1);
  app.restart();
  assert.equal((await call(app, "/api/mot/monitors")).data.items[0].monitor_id, monitorId);
  await call(app, "/api/mot/check", { idempotency_key: "monitor-worker-manual-2" });
  assert.equal((await call(app, "/api/mot/tasks")).data.items.filter(row => row.kind === "MONITOR_BELOW_THRESHOLD").length, 1);
});

test("Worker storage failure returns unavailable and does not fabricate a task", async () => {
  const app = setup();
  const original = app.storage.transaction;
  app.storage.transaction = async () => { throw new Error("synthetic storage failure"); };
  const response = await call(app, "/api/mot/events/ingest", { snapshot: fixture(new Date().toISOString()), idempotency_key: "failed-seed" });
  assert.equal(response.status, 503);
  app.storage.transaction = original;
  assert.equal((await call(app, "/api/mot/tasks")).data.items.length, 0);
});

test("MOT staging entry rejects unrelated public review routes", async () => {
  const app = setup();
  const unrelated = await staging.fetch(new Request("https://mot.example/api/review/tasks"), app.env, {});
  assert.equal(unrelated.status, 404);
  const mot = await staging.fetch(new Request("https://mot.example/api/mot/overview"), app.env, {});
  assert.equal(mot.status, 401);
});

test("Staging app uses signed session, one owner and durable conversation history", async () => {
  const app = setup();
  Object.assign(app.env, { APP_STAGING_OWNER_ID: "owner-a", APP_STAGING_PASSWORD: "staging-synthetic-password-123456789",
    APP_STAGING_COOKIE_KEY: "staging-synthetic-cookie-signing-key-123456789" });
  const origin = "https://mot.example";
  const anonymous = await staging.fetch(new Request(origin + "/app"), app.env, {});
  assert.match(await anonymous.text(), /Staging 登录/);
  const login = await staging.fetch(new Request(origin + "/api/app/login", { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: app.env.APP_STAGING_PASSWORD }) }), app.env, {});
  assert.equal(login.status, 303);
  const cookie = login.headers.get("Set-Cookie").split(";")[0];
  assert.match(login.headers.get("Set-Cookie"), /HttpOnly; Secure; SameSite=Strict/);
  assert.match(await (await staging.fetch(new Request(origin + "/app", { headers: { Cookie: cookie } }), app.env, {})).text(), /MOT · 财务总助手/);
  const browse = async (route, body, token = null) => {
    const request = new Request(origin + route, { method: body ? "POST" : "GET",
      headers: { ...(token ? { "X-Mot-Key": token } : { Cookie: cookie }), Origin: origin,
        ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const response = await staging.fetch(request, app.env, {});
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await browse("/api/app/bootstrap")).data.owner_id, "owner-a");
  const created = await browse("/api/app/conversations", { agent_id: "mot", request_id: "worker-chat-create-001" });
  assert.equal(created.status, 201);
  const conversationId = created.data.conversation_id;
  const route = `/api/app/conversations/${conversationId}/messages`;
  const body = { text: "查看当前监测任务", request_id: "worker-chat-message-001" };
  assert.equal((await browse(route, body)).data.messages[1].source, "MOT_INBOX");
  assert.equal((await browse(route, body)).data.replayed, true);
  assert.equal((await browse(`/api/app/conversations/${conversationId}`, undefined, keyB)).status, 404);
  app.restart();
  assert.equal((await browse(`/api/app/conversations/${conversationId}`)).data.messages.length, 2);
  const unsafe = await staging.fetch(new Request(origin + "/api/app/conversations", { method: "POST",
    headers: { Cookie: cookie, Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: "mot", request_id: "cross-site-request-001" }) }), app.env, {});
  assert.equal(unsafe.status, 403);
});
