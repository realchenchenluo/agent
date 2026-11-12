"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { fixture } = require("../mot/engine");

const keyA = "mot-owner-a-synthetic-key-123456", keyB = "mot-owner-b-synthetic-key-123456";
let directory, server, origin;

test.before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "mot-http-"));
  process.env.MOT_DATA_DIR = directory;
  process.env.MOT_AUTH_TOKENS_JSON = JSON.stringify([
    { owner_id: "owner-a", token: keyA, roles: ["read", "operator", "approver", "ingestor"] },
    { owner_id: "owner-b", token: keyB, roles: ["read", "operator", "approver", "ingestor"] }
  ]);
  ({ server } = require("../server"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
});

async function call(route, { method = "GET", body, token = keyA, headers = {} } = {}) {
  const response = await fetch(origin + route, { method,
    headers: { ...(token ? { "X-Mot-Key": token } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json() };
}

test("HTTP contract isolates two owners and rejects unauthenticated, cross-origin and missing roles", async () => {
  assert.equal((await call("/api/mot/overview", { token: null })).status, 401);
  assert.equal((await call("/api/mot/overview", { headers: { Origin: "https://other.example" } })).status, 403);
  const first = await call("/api/mot/events/ingest", { method: "POST", body: { snapshot: fixture(new Date().toISOString()), idempotency_key: "http-seed-a" } });
  assert.equal(first.status, 200, first.data.error?.code);
  assert.equal(first.data.imported, 8);
  assert.equal(first.data.check.tasks_created.length, 2);
  assert.equal((await call("/api/mot/overview")).data.total_verified_minor, 1_500_000);
  assert.equal((await call("/api/mot/overview", { token: keyB })).data.total_verified_minor, null);
  const checked = await call("/api/mot/check", { method: "POST", body: { idempotency_key: "http-check-a" } });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.tasks_created.length, 0);
  assert.equal((await call("/api/mot/tasks", { token: keyB })).data.items.length, 0);
  assert.equal((await call(`/api/mot/tasks/${first.data.check.tasks_created[0]}`, { token: keyB })).status, 404);
  assert.equal((await call("/api/mot/demo/ingest", { method: "POST", body: {} })).status, 403);
  const health = await call("/api/mot/health");
  assert.equal(health.data.core_risk, "UNAVAILABLE");
  assert.equal(health.data.persistence, "LOCAL_ATOMIC_FILE");
});

test("HTTP task, inbox, audit, denied approval and replay expose durable evidence", async () => {
  const tasks = (await call("/api/mot/tasks")).data.items;
  assert.equal(tasks.length, 2);
  assert.equal((await call("/api/mot/inbox")).data.items.length, 2);
  assert.ok((await call("/api/mot/audit")).data.items.some(x => x.event_type === "runtime.checked"));
  const proposed = await call("/api/mot/reservations/propose", { method: "POST",
    body: { amount_minor: 50_000, account_ids: ["bank-main"], request_key: "http-reservation-a" } });
  assert.equal(proposed.status, 201, proposed.data.error?.code);
  assert.equal(proposed.data.state, "BLOCKED");
  assert.equal((await call(`/api/mot/tasks/${proposed.data.task_id}/approval`, { method: "POST", body: { decision: "APPROVE" } })).status, 409);
  assert.equal((await call(`/api/mot/tasks/${proposed.data.task_id}/simulate`, { method: "POST", body: { idempotency_key: "paper-http" } })).status, 409);
  const replay = await call("/api/mot/check", { method: "POST", body: { idempotency_key: "http-check-a" } });
  assert.equal(replay.data.replayed, true);
  assert.equal((await call("/api/mot/tasks")).data.items.length, 3);
});
