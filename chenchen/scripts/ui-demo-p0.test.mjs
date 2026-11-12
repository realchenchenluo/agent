import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { taskView } from "../versions/task-state.mjs";
import { requestJson, TaskClient, pendingRequest, pendingKey } from "../versions/task-client.mjs";
const example = JSON.parse(fs.readFileSync(new URL("../contracts/examples/model-review.response.json", import.meta.url)));
const fixture = () => structuredClone(example);
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const storage = () => { const entries = new Map(); return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) }; };
function locks() {
  let busy = false;
  return { async request(name, options, callback) {
    if (busy) return callback(null);
    busy = true;
    try { return await callback({ name }); } finally { busy = false; }
  } };
}
test("MOCK: health handoff stays distinct from model PENDING_RISK", () => {
  const health = taskView({ task_state: { task_id: "task-health", status: "HANDOFF_REQUIRED" }, tool_results: {} });
  assert.match(health.rows[3].status, /HANDOFF_REQUIRED/);
  assert.match(health.model, /NOT_CALLED/);
  assert.match(taskView(fixture()).rows[3].status, /PENDING_REVIEW/);
});
for (const status of ["PENDING_RISK", "PENDING_APPROVAL", "READY_FOR_SIMULATION", "REJECTED", "RISK_TIMEOUT", "EXPIRED", "FUNDING_BLOCKED", "CANCELLED", "SIMULATED", "UNRECOGNIZED"]) {
  test("MOCK: no inferred receipt or authorization for " + status, () => {
    const record = fixture(); record.status = status;
    const view = taskView(record);
    assert.equal(view.receiptValid, false);
    assert.match(view.rows[5].status, /NOT_EXECUTED/);
    assert.equal(Object.hasOwn(view, "execution_allowed"), false);
  });
}
test("MOCK: receipt binds task, hash, execution, mode and side effects", () => {
  const record = fixture(); record.status = "SIMULATED"; record.capability = "SIMULATION_ONLY";
  record.execution = { task_id: record.task_id, status: "SIMULATED", execution_id: "mock-execution", execution_allowed: false, receipt: { mode: "SIMULATED", side_effects: false, task_id: record.task_id, execution_id: "mock-execution", proposal_sha256: record.proposed_action.proposal_sha256, completed_at: new Date().toISOString() } };
  assert.equal(taskView(record).receiptValid, true);
  for (const field of ["task_id", "proposal_sha256", "execution_id", "mode", "completed_at"]) {
    const changed = structuredClone(record); changed.execution.receipt[field] = "";
    assert.equal(taskView(changed).receiptValid, false, field);
  }
  record.execution.receipt.side_effects = true;
  assert.equal(taskView(record).receiptValid, false);
  record.execution.receipt.side_effects = false; record.plan_hash = "changed-proposal";
  assert.equal(taskView(record).receiptValid, false);
});
for (const part of ["audit", "approval", "execution", "risk_handoff"]) {
  test("MOCK: cross-task " + part + " is rejected", () => {
    const record = fixture(); record[part].task_id = "another-task";
    assert.throws(() => taskView(record), /TASK_CONTEXT_MISMATCH/);
  });
}
test("MOCK: old proposal, data version and expired approval stay historical", () => {
  const record = fixture(); record.approval.expires_at = "2000-01-01T00:00:00.000Z";
  const before = JSON.stringify(record), view = taskView(record, { stale: true });
  assert.equal(view.rows[4].status, "EXPIRED"); assert.equal(view.stale, true);
  assert.equal(JSON.stringify(record), before);
  assert.match(view.reason, /旧方案不得/);
});
for (const status of [401, 403, 409, 423, 503]) {
  test("MOCK HTTP " + status + ": preserve error status, never return success", async () => {
    await assert.rejects(requestJson("/api/review", { fetcher: async () => response({ error: { code: "MOCK_ERROR" } }, status) }), error => error.status === status && error.code === "MOCK_ERROR");
  });
}
for (const body of ["{", "null", "[]", '"wrong"']) {
  test("MOCK malformed response " + body, async () => {
    await assert.rejects(requestJson("/api/task/x", { fetcher: async () => new Response(body) }), error => error.code === "INVALID_RESPONSE");
  });
}
test("MOCK: network and timeout are unknown outcomes", async () => {
  await assert.rejects(requestJson("/x", { fetcher: async () => { throw new TypeError("offline"); } }), error => error.code === "NETWORK_ERROR");
  await assert.rejects(requestJson("/x", { timeoutMs: 5, fetcher: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("abort")))) }), error => error.code === "TIMEOUT");
});
test("MOCK: wrong task response is rejected", async () => {
  await assert.rejects(requestJson("/api/task/a", { expectedTaskId: "a", fetcher: async () => response({ task_id: "b" }) }), error => error.code === "TASK_CONTEXT_MISMATCH");
});
test("MOCK: duplicate click and another tab cannot create a second request", async () => {
  const store = storage(), shared = locks(); let count = 0, finish;
  const fetcher = () => { count++; return new Promise(resolve => { finish = resolve; }); };
  const a = new TaskClient({ storage: store, locks: shared, fetcher }), b = new TaskClient({ storage: store, locks: shared, fetcher });
  const first = a.request("/api/review", { request_id: "mock-request" });
  await assert.rejects(a.request("/api/review", {}), error => error.code === "REQUEST_IN_PROGRESS");
  await assert.rejects(b.request("/api/review", {}), error => error.code === "OTHER_TAB_BUSY");
  finish(response({ request_id: "mock-request" })); await first;
  assert.equal(count, 1); assert.equal(pendingRequest(store), null);
});
test("MOCK: cancelled request survives refresh and cannot be retried blindly", async () => {
  const store = storage(), shared = locks();
  const client = new TaskClient({ storage: store, locks: shared, fetcher: (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("abort")))) });
  const first = client.request("/api/review", { request_id: "mock-request", text: "must-not-be-persisted" });
  client.cancel(); await assert.rejects(first, error => error.code === "CANCELLED");
  assert.equal(pendingRequest(store).request_id, "mock-request");
  assert.doesNotMatch(store.getItem(pendingKey), /must-not-be-persisted/);
  const restored = new TaskClient({ storage: store, locks: shared });
  await assert.rejects(restored.request("/api/review", {}), error => error.code === "UNRESOLVED_REQUEST");
  restored.reconcile({ task_id: "other", request_id: "other" }); assert.ok(pendingRequest(store));
  restored.reconcile({ task_id: "mock-task", request_id: "mock-request" }); assert.equal(pendingRequest(store), null);
});
for (const action of ["risk-decision", "risk-callback", "approval", "simulate", "cancel"]) {
  test("MOCK: UI cannot submit privileged action " + action, async () => {
    let count = 0;
    const client = new TaskClient({ storage: storage(), locks: locks(), fetcher: async () => { count++; } });
    await assert.rejects(client.request("/api/review/" + action, { approver: "forged", execution_allowed: true }), error => error.code === "UI_ACTION_BLOCKED");
    assert.equal(count, 0);
  });
}
test("MOCK: unsupported browser locking fails closed", async () => {
  const client = new TaskClient({ storage: storage(), locks: null });
  await assert.rejects(client.request("/api/review", {}), error => error.code === "LOCK_UNAVAILABLE");
});
test("MOCK: storage unavailable fails before network access", async () => {
  const client = new TaskClient({ storage: null, locks: locks() });
  await assert.rejects(client.request("/api/review", {}), error => error.code === "PERSISTENCE_UNAVAILABLE");
});
test("MOCK: READ_ONLY cannot display a simulated receipt as valid", () => {
  const record = fixture(); record.status = "SIMULATED";
  record.execution.status = "SIMULATED";
  record.execution.receipt = { mode: "SIMULATED", side_effects: false, task_id: record.task_id };
  assert.equal(taskView(record).receiptValid, false);
});
