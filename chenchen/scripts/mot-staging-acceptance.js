"use strict";

const assert = require("node:assert/strict");
const { fixture } = require("../mot/engine");

const base = process.env.MOT_STAGING_BASE;
const tokenA = process.env.MOT_STAGING_TOKEN_A;
const tokenB = process.env.MOT_STAGING_TOKEN_B;
if (!base || !tokenA || !tokenB) throw new Error("MOT_STAGING_CONFIGURATION_REQUIRED");

const evidence = { contract_version: "mot.v1", data_mode: "SYNTHETIC_ONLY", base, requests: [] };
async function call(route, { method = "GET", body, token = tokenA } = {}) {
  const response = await fetch(`${base}/api/mot/${route}`, { method,
    headers: { ...(token ? { "X-Mot-Key": token } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  evidence.requests.push({ method, route: `/api/mot/${route}`, status: response.status,
    result: data.error?.code || data.state || data.contract_version || data.schema_version || null });
  return { status: response.status, data };
}

async function main() {
  const unauthenticated = await call("overview", { token: null });
  assert.equal(unauthenticated.status, 401);
  const health = await call("health");
  assert.equal(health.status, 200);
  assert.equal(health.data.core_risk, "UNAVAILABLE");
  evidence.build_sha = health.data.build_sha;
  const ownerB = await call("overview", { token: tokenB });
  assert.equal(ownerB.data.total_verified_minor, null);
  const snapshot = fixture(new Date().toISOString());
  const ingested = await call("events/ingest", { method: "POST", body: { snapshot, idempotency_key: "staging-seed-v1" } });
  assert.equal(ingested.status, 200);
  assert.equal(ingested.data.imported, 8);
  assert.equal(ingested.data.check.tasks_created.length, 2);
  const overview = await call("overview");
  assert.deepEqual([overview.data.stores, overview.data.terminals, overview.data.accounts], [2, 5, 3]);
  assert.equal(overview.data.total_verified_minor, 1_500_000);
  assert.equal(overview.data.pending_settlement_minor, 55_000);
  const tasks = await call("tasks");
  assert.equal(tasks.data.items.length, 2);
  assert.equal((await call("inbox")).data.items.length, 2);
  const checked = await call("check", { method: "POST", body: { idempotency_key: "staging-check-v1" } });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.tasks_created.length, 0);
  assert.equal((await call("check", { method: "POST", body: { idempotency_key: "staging-check-v1" } })).data.replayed, true);
  const proposal = await call("reservations/propose", { method: "POST", body: {
    amount_minor: 50_000, account_ids: ["bank-main"], request_key: "staging-proposal-v1" } });
  assert.equal(proposal.status, 201);
  assert.equal(proposal.data.state, "BLOCKED");
  assert.equal((await call(`tasks/${proposal.data.task_id}/approval`, { method: "POST", body: { decision: "APPROVE" } })).status, 409);
  assert.equal((await call("overview", { token: tokenB })).data.total_verified_minor, null);
  assert.ok((await call("audit")).data.items.length > 0);
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch(cause => { console.error(cause); process.exitCode = 1; });
