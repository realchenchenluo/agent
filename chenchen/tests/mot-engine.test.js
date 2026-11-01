"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { MotEngine, fixture } = require("../mot/engine");
const { FileRepository } = require("../mot/file-repository");
const { MotScheduler } = require("../mot/scheduler");

const AT = "2026-11-01T09:00:00.000Z";
async function setup(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mot-test-"));
  const repository = new FileRepository(directory);
  const engine = new MotEngine(repository, { now: () => AT, ...options });
  return { directory, repository, engine, owner: "merchant-a", cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test("synthetic import, duplicate replay, verified multi-account balances and internal transfer", async t => {
  const ctx = await setup(); t.after(ctx.cleanup);
  const first = await ctx.engine.ingestDemo(ctx.owner);
  assert.equal(first.imported, 8);
  assert.equal((await ctx.engine.ingestDemo(ctx.owner)).replayed, true);
  const repeated = await ctx.engine.ingest(ctx.owner, fixture(AT), "second-import", "event");
  assert.equal(repeated.imported, 0);
  assert.equal(repeated.duplicates, 8);
  const view = await ctx.engine.read(ctx.owner, s => require("../mot/engine").overview(s, AT));
  assert.deepEqual([view.stores, view.terminals, view.accounts], [2, 5, 3]);
  assert.equal(view.total_verified_minor, 1_500_000);
  assert.equal(view.pool_balance_minor, 800_000);
  assert.equal(view.pending_settlement_minor, 55_000);
  assert.equal((await ctx.engine.read(ctx.owner, s => s.transactions.filter(x => x.transaction_type === "INTERNAL_TRANSFER"))).length, 2);
});

test("conflicting external transaction and stale account snapshots fail closed", async t => {
  const ctx = await setup(); t.after(ctx.cleanup);
  await ctx.engine.ingestDemo(ctx.owner);
  const changed = fixture(AT);
  changed.transactions[0].amount_minor++;
  await assert.rejects(ctx.engine.ingest(ctx.owner, changed, "changed-transaction", "event"), { code: "TRANSACTION_ID_CONFLICT" });
  const stale = fixture(AT);
  stale.accounts[0].balance_minor++;
  await assert.rejects(ctx.engine.ingest(ctx.owner, stale, "changed-balance", "event"), { code: "ACCOUNT_SNAPSHOT_CHANGED" });
  assert.equal((await ctx.engine.read(ctx.owner, s => s.transactions)).length, 8);
});

test("zero, negative and missing transaction amounts are rejected before ledger mutation", async t => {
  const ctx = await setup(); t.after(ctx.cleanup);
  for (const value of [0, -1, undefined]) {
    const data = fixture(AT);
    if (value === undefined) delete data.transactions[0].amount_minor;
    else data.transactions[0].amount_minor = value;
    await assert.rejects(ctx.engine.ingest(ctx.owner, data, `invalid-amount-${String(value)}`), { code: "INVALID_TRANSACTION" });
  }
  const state = await ctx.engine.read(ctx.owner);
  assert.equal(state.transactions.length, 0);
  assert.equal(state.accounts.length, 0);
});

test("small source clock skew is tolerated while a later future snapshot stays unknown", async t => {
  const near = await setup(); t.after(near.cleanup);
  const oneMinuteAhead = new Date(Date.parse(AT) + 60_000).toISOString();
  await near.engine.ingest(near.owner, fixture(oneMinuteAhead), "near-clock", "event");
  assert.equal((await near.engine.read(near.owner, s => require("../mot/engine").overview(s, AT))).balance_fresh, true);
  const far = await setup(); t.after(far.cleanup);
  const tenMinutesAhead = new Date(Date.parse(AT) + 600_000).toISOString();
  await far.engine.ingest(far.owner, fixture(tenMinutesAhead), "far-clock", "event");
  assert.equal((await far.engine.read(far.owner, s => require("../mot/engine").overview(s, AT))).balance_fresh, false);
});

test("stale non-pool account cannot be reported as a current total while fresh pool remains readable", async t => {
  const ctx = await setup(); t.after(ctx.cleanup);
  const data = fixture(AT);
  data.accounts[1].as_of = new Date(Date.parse(AT) - 48 * 3600_000).toISOString();
  await ctx.engine.ingest(ctx.owner, data, "stale-west-account");
  const view = await ctx.engine.read(ctx.owner, state => require("../mot/engine").overview(state, AT));
  assert.equal(view.total_verified_minor, null);
  assert.equal(view.total_balance_fresh, false);
  assert.equal(view.pool_balance_minor, 800_000);
  assert.equal(view.available_minor, 800_000);
  assert.equal(view.pool_as_of, AT);
  assert.equal(view.as_of, data.accounts[1].as_of);
});

test("checks detect settlement mismatch and known payment shortfall without duplicate tasks", async t => {
  const ctx = await setup(); t.after(ctx.cleanup);
  await ctx.engine.ingestDemo(ctx.owner);
  const first = await ctx.engine.check(ctx.owner, { trigger: "manual", requestKey: "first-check" });
  assert.equal(first.findings, 2);
  assert.equal(first.tasks_created.length, 2);
  assert.equal(first.new_receipts, 3);
  assert.equal(first.new_payments, 1);
  assert.equal((await ctx.engine.check(ctx.owner, { trigger: "manual", requestKey: "first-check" })).replayed, true);
  const second = await ctx.engine.check(ctx.owner, { trigger: "manual", requestKey: "second-check" });
  assert.equal(second.tasks_created.length, 0);
  assert.equal(second.new_receipts, 0);
  const state = await ctx.engine.read(ctx.owner);
  assert.deepEqual(state.tasks.map(x => x.kind).sort(), ["FUNDING_SHORTFALL", "SETTLEMENT_MISMATCH"]);
  assert.equal(state.inbox.length, 2);
  assert.equal(state.notification_events.length, 2);
  assert.ok(state.notification_events.every(x => x.status === "QUEUED"));
  assert.ok(state.tasks.every(x => x.state === "NEEDS_ATTENTION" && x.owner_id === ctx.owner && x.evidence.length >= 2));
});

test("pool configuration supports one or three verified accounts and resolves cleared shortfall", async t => {
  const ctx = await setup(); t.after(ctx.cleanup);
  await ctx.engine.ingestDemo(ctx.owner);
  await ctx.engine.check(ctx.owner, { trigger: "manual", requestKey: "before-pool-change" });
  const prior = await ctx.engine.read(ctx.owner);
  const configured = await ctx.engine.configurePool(ctx.owner, { account_ids: ["bank-main", "bank-west", "bank-reserve"],
    expected_revision: prior.revision, request_key: "pool-three" });
  assert.equal(configured.revision, prior.revision + 1);
  assert.equal((await ctx.engine.read(ctx.owner, s => require("../mot/engine").overview(s, AT))).pool_balance_minor, 1_500_000);
  await ctx.engine.check(ctx.owner, { trigger: "manual", requestKey: "after-pool-change" });
  const shortfall = (await ctx.engine.read(ctx.owner, s => s.tasks)).find(x => x.kind === "FUNDING_SHORTFALL");
  assert.equal(shortfall.state, "RESOLVED");
  await assert.rejects(ctx.engine.configurePool(ctx.owner, { account_ids: ["bank-main"],
    expected_revision: prior.revision, request_key: "stale-pool" }), { code: "STALE_LEDGER" });
});

test("distinct POS identifiers with matching amount and minute raise suspicious duplicate", async t => {
  const ctx = await setup(); t.after(ctx.cleanup);
  await ctx.engine.ingestDemo(ctx.owner);
  const data = fixture(AT);
  data.transactions.push({ ...data.transactions[0], external_transaction_id: "sale-100-duplicate" });
  assert.equal((await ctx.engine.ingest(ctx.owner, data, "new-pos-event", "event")).imported, 1);
  await ctx.engine.check(ctx.owner, { trigger: "event", requestKey: "event-check" });
  assert.ok((await ctx.engine.read(ctx.owner, s => s.tasks)).some(x => x.kind === "SUSPECT_DUPLICATE"));
});

test("scheduled tick persists one task per anomaly and recovers after restart", async t => {
  const ctx = await setup(); t.after(ctx.cleanup);
  await ctx.engine.ingestDemo(ctx.owner);
  const scheduler = new MotScheduler(ctx.engine, { now: () => Date.parse(AT) });
  assert.equal((await scheduler.tick()).checked, 1);
  assert.equal((await scheduler.tick()).results[0].replayed, true);
  const restarted = new MotEngine(new FileRepository(ctx.directory), { now: () => AT });
  const tasks = await restarted.read(ctx.owner, s => s.tasks);
  assert.equal(tasks.length, 2);
  assert.equal((await restarted.check(ctx.owner, { trigger: "scheduled", requestKey: `scheduled-${Math.floor(Date.parse(AT) / 900000)}` })).replayed, true);
});

test("unknown balances, unknown Risk and unverified approval block reservation simulation", async t => {
  const ctx = await setup(); t.after(ctx.cleanup);
  await assert.rejects(ctx.engine.proposeReservation(ctx.owner, { amount_minor: 1000, account_ids: ["bank-main"], request_key: "before-ingest" }), { code: "FUNDING_UNAVAILABLE" });
  await ctx.engine.ingestDemo(ctx.owner);
  const task = await ctx.engine.proposeReservation(ctx.owner, { amount_minor: 100_000, account_ids: ["bank-main"], request_key: "reserve-one" });
  assert.equal(task.state, "BLOCKED");
  assert.equal(task.review.status, "UNAVAILABLE");
  await assert.rejects(ctx.engine.decideApproval(ctx.owner, task.task_id, "APPROVE"), { code: "APPROVAL_NOT_READY" });
  await assert.rejects(ctx.engine.simulate(ctx.owner, task.task_id, "simulate-one"), { code: "SIMULATION_BLOCKED" });
  assert.equal((await ctx.engine.decideApproval(ctx.owner, task.task_id, "REJECT")).state, "CANCELLED");
  assert.equal((await ctx.engine.decideApproval(ctx.owner, task.task_id, "REJECT")).state, "CANCELLED");
  await assert.rejects(ctx.engine.decideApproval(ctx.owner, task.task_id, "APPROVE"), { code: "IDEMPOTENCY_CONFLICT" });
});

test("transfer intent creates one traceable blocked proposal without moving funds", async t => {
  const ctx = await setup(); t.after(ctx.cleanup);
  await ctx.engine.ingestDemo(ctx.owner);
  const input = { amount_minor: 50_000, from_account_id: "bank-main", to_account_id: "bank-west", request_key: "transfer-request-one" };
  const task = await ctx.engine.proposeTransfer(ctx.owner, input);
  assert.equal(task.kind, "TRANSFER_PROPOSAL");
  assert.equal(task.state, "BLOCKED");
  assert.equal(task.proposal.to_account_id, "bank-west");
  assert.equal((await ctx.engine.proposeTransfer(ctx.owner, input)).task_id, task.task_id);
  await assert.rejects(ctx.engine.decideApproval(ctx.owner, task.task_id, "APPROVE"), { code: "APPROVAL_NOT_READY" });
  await assert.rejects(ctx.engine.simulate(ctx.owner, task.task_id, "transfer-paper-one"), { code: "SIMULATION_BLOCKED" });
  const state = await ctx.engine.read(ctx.owner);
  assert.equal(state.reservations.length, 0);
  assert.equal(state.transactions.length, 8);
  assert.ok(state.audit.some(row => row.task_id === task.task_id && row.event_type === "transfer.proposed"));
});

test("lost Core/Risk acknowledgement remains UNKNOWN and the same proposal is not dispatched twice", async t => {
  let calls = 0;
  const ctx = await setup({ coreRisk: { review: async () => { calls++; throw new Error("synthetic timeout"); } } });
  t.after(ctx.cleanup);
  await ctx.engine.ingestDemo(ctx.owner);
  const proposal = { amount_minor: 100_000, account_ids: ["bank-main"], request_key: "unknown-review" };
  const task = await ctx.engine.proposeReservation(ctx.owner, proposal);
  assert.equal(task.state, "UNKNOWN");
  assert.equal(task.review.status, "UNKNOWN");
  assert.equal((await ctx.engine.proposeReservation(ctx.owner, proposal)).task_id, task.task_id);
  assert.equal(calls, 1);
  await assert.rejects(ctx.engine.decideApproval(ctx.owner, task.task_id, "APPROVE"), { code: "APPROVAL_NOT_READY" });
  await assert.rejects(ctx.engine.simulate(ctx.owner, task.task_id, "paper-unknown"), { code: "SIMULATION_BLOCKED" });
});

test("test-only verified adapter permits human approval and one paper reservation under concurrency", async t => {
  const adapter = {
    review: async ({ task_id }) => ({ status: "VERIFIED", risk: "APPROVE", verified: true,
      core_task_id: task_id, risk_check_id: "risk-test-1", proof_id: "synthetic-test-proof", mode: "SIMULATION_ONLY" }),
    approve: async ({ task_id, ledger_revision }) => ({ verified: true, decision: "APPROVE", task_id,
      ledger_revision, proof_id: "synthetic-test-approval" })
  };
  const ctx = await setup({ coreRisk: adapter }); t.after(ctx.cleanup);
  await ctx.engine.ingestDemo(ctx.owner);
  const task = await ctx.engine.proposeReservation(ctx.owner, { amount_minor: 100_000, account_ids: ["bank-main"], request_key: "reserve-test" });
  assert.equal(task.state, "PENDING_APPROVAL");
  assert.equal((await ctx.engine.decideApproval(ctx.owner, task.task_id, "APPROVE")).approval.verified, true);
  assert.equal((await ctx.engine.decideApproval(ctx.owner, task.task_id, "APPROVE")).approval.verified, true);
  const [first, replay] = await Promise.all([
    ctx.engine.simulate(ctx.owner, task.task_id, "paper-once"),
    ctx.engine.simulate(ctx.owner, task.task_id, "paper-once")
  ]);
  assert.equal(first.receipt_id, replay.receipt_id);
  assert.equal((await ctx.engine.read(ctx.owner, s => s.reservations)).length, 1);
  assert.equal((await ctx.engine.read(ctx.owner, s => require("../mot/engine").overview(s, AT))).available_minor, 700_000);
  assert.equal((await ctx.engine.getTask(ctx.owner, task.task_id)).state, "RESOLVED");
});

test("changed ledger invalidates prior approval and failed persistence cannot return success", async t => {
  const adapter = { review: async ({ task_id }) => ({ status: "VERIFIED", risk: "APPROVE", verified: true,
    core_task_id: task_id, risk_check_id: "risk-test-2", proof_id: "test-proof", mode: "SIMULATION_ONLY" }),
    approve: async ({ task_id, ledger_revision }) => ({ verified: true, decision: "APPROVE", task_id,
      ledger_revision, proof_id: "test-approval" }) };
  const ctx = await setup({ coreRisk: adapter }); t.after(ctx.cleanup);
  await ctx.engine.ingestDemo(ctx.owner);
  const task = await ctx.engine.proposeReservation(ctx.owner, { amount_minor: 100_000, account_ids: ["bank-main"], request_key: "reserve-before-change" });
  await ctx.engine.decideApproval(ctx.owner, task.task_id, "APPROVE");
  const data = fixture(AT); data.accounts[0].revision = 2; data.accounts[0].balance_minor += 1000;
  await ctx.engine.ingest(ctx.owner, data, "new-balance-version", "event");
  await assert.rejects(ctx.engine.simulate(ctx.owner, task.task_id, "stale-paper"), { code: "SIMULATION_BLOCKED" });
  const bad = new MotEngine({ read: () => ctx.repository.read(ctx.owner), transact: () => { throw Object.assign(new Error(), { code: "PERSISTENCE_UNAVAILABLE" }); } }, { now: () => AT });
  await assert.rejects(bad.check(ctx.owner, { requestKey: "failed-write" }), { code: "PERSISTENCE_UNAVAILABLE" });
});

test("memory stores confirmed rules but never acts as account-balance authority", async t => {
  const ctx = await setup(); t.after(ctx.cleanup);
  await assert.rejects(ctx.engine.memory(ctx.owner, { type: "preference", key: "alert-window", value: { hours: 4 }, consent: false }), { code: "INVALID_MEMORY" });
  const input = { type: "store_rule", key: "close-time", value: { hour: 22 }, consent: true, request_key: "memory-close-time-v1" };
  const saved = await ctx.engine.memory(ctx.owner, input);
  assert.equal(saved.source, "USER_CONFIRMED");
  assert.equal((await ctx.engine.memory(ctx.owner, input)).memory_id, saved.memory_id);
  await assert.rejects(ctx.engine.memory(ctx.owner, { ...input, value: { hour: 23 } }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal((await ctx.engine.read(ctx.owner, s => require("../mot/engine").overview(s, AT))).total_verified_minor, null);
});
