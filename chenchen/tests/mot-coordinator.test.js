"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { MotEngine, fixture } = require("../mot/engine");
const { FileRepository } = require("../mot/file-repository");
const { MotScheduler } = require("../mot/scheduler");
const { answer } = require("../app/router");

test("persistent threshold monitor runs without a browser and deduplicates Inbox", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mot-monitor-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let clock = Date.parse("2026-11-01T09:00:00.000Z");
  const repository = new FileRepository(directory);
  const owner = "monitor-owner";
  const engine = new MotEngine(repository, { now: () => new Date(clock).toISOString() });
  await engine.ingest(owner, fixture(new Date(clock).toISOString()), "monitor-fixture", "event");
  const input = { scope: "POOL", threshold_minor: 900_000, frequency_minutes: 15,
    channel: "INBOX_ONLY", timezone: "Asia/Shanghai", request_key: "monitor-create-1" };
  const monitor = await engine.createMonitor(owner, input);
  assert.equal((await engine.createMonitor(owner, input)).monitor_id, monitor.monitor_id);
  await new MotScheduler(engine, { now: () => clock }).tick();
  let state = await engine.read(owner);
  assert.equal(state.tasks.filter(row => row.kind === "MONITOR_BELOW_THRESHOLD").length, 1);
  const inboxCount = state.inbox.length;
  clock += 15 * 60_000;
  const restarted = new MotEngine(new FileRepository(directory), { now: () => new Date(clock).toISOString() });
  await new MotScheduler(restarted, { now: () => clock }).tick();
  state = await restarted.read(owner);
  assert.equal(state.inbox.length, inboxCount);
  assert.equal(state.monitors[0].last_run_at, new Date(clock).toISOString());
  await restarted.changeMonitor(owner, monitor.monitor_id, { action: "PAUSE", request_key: "monitor-pause-1" });
  clock += 15 * 60_000;
  await new MotScheduler(restarted, { now: () => clock }).tick();
  assert.equal((await restarted.read(owner)).monitors[0].status, "PAUSED");
  await restarted.changeMonitor(owner, monitor.monitor_id, { action: "RESUME", request_key: "monitor-resume-1" });
  await restarted.changeMonitor(owner, monitor.monitor_id, { action: "UPDATE", threshold_minor: 500_000, request_key: "monitor-update-1" });
  await restarted.check(owner, { trigger: "manual", requestKey: "monitor-clear-1" });
  state = await restarted.read(owner);
  assert.equal(state.tasks.find(row => row.kind === "MONITOR_BELOW_THRESHOLD").state, "RESOLVED");
  assert.equal(state.inbox.filter(row => row.status === "OPEN" && state.tasks.find(task => task.task_id === row.task_id)?.kind === "MONITOR_BELOW_THRESHOLD").length, 0);
  assert.equal((await restarted.read("another-owner")).monitors.length, 0);
});

test("one MOT conversation returns sourced substeps and exposes unavailable Risk", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mot-coordination-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const engine = new MotEngine(new FileRepository(directory));
  await engine.ingestDemo("coord-owner");
  const reply = await answer({ text: "检查两家门店资金，并告诉我有没有需要关注的持仓风险", conversationId: "conversation-123",
    agentId: "mot", owner: "coord-owner", runtime: engine, merchant: null, requestId: "coord-request-1" });
  assert.equal(reply.status, "PARTIAL");
  assert.equal(reply.agent_id, "mot");
  const run = reply.tool_results.find(row => row.kind === "run").run;
  assert.equal(run.conversation_id, "conversation-123");
  assert.deepEqual(run.steps.map(row => row.agent_id), ["mot", "investment", "risk"]);
  assert.equal(run.steps[2].status, "UNAVAILABLE");
  assert.ok(run.steps.every(row => row.parent_task_id === run.task_id && row.source));
  assert.match(reply.text, /固定演示组合/);
});

test("ten-thousand cash with four-thousand rent hold blocks eight-thousand and gates three-thousand", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mot-rent-hold-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repository = new FileRepository(directory), owner = "rent-owner";
  const data = fixture(new Date().toISOString());
  data.accounts[0].balance_minor = 1_000_000;
  data.accounts[1].balance_minor = 0;
  data.accounts[2].balance_minor = 0;
  const coreRisk = {
    review: async ({ task_id }) => ({ status: "VERIFIED", risk: "APPROVE", verified: true, core_task_id: task_id,
      risk_check_id: "synthetic-rent-risk", proof_id: "synthetic-rent-review", mode: "SIMULATION_ONLY" }),
    approve: async ({ task_id, ledger_revision }) => ({ verified: true, decision: "APPROVE", task_id,
      ledger_revision, proof_id: "synthetic-rent-approval" })
  };
  const seeded = new MotEngine(repository, { coreRisk });
  await seeded.ingest(owner, data, "rent-fixture-1");
  const rent = await seeded.proposeReservation(owner, { amount_minor: 400_000,
    account_ids: ["bank-main"], request_key: "rent-reserve-1" });
  await seeded.decideApproval(owner, rent.task_id, "APPROVE");
  await seeded.simulate(owner, rent.task_id, "rent-paper-1");
  const engine = new MotEngine(repository);
  await assert.rejects(engine.proposeReservation(owner, { amount_minor: 800_000,
    account_ids: ["bank-main"], request_key: "request-eight-thousand" }), { code: "FUNDING_UNAVAILABLE" });
  const smaller = await engine.proposeReservation(owner, { amount_minor: 300_000,
    account_ids: ["bank-main"], request_key: "request-three-thousand" });
  assert.equal(smaller.state, "BLOCKED");
  assert.equal(smaller.review.status, "UNAVAILABLE");
  await assert.rejects(engine.simulate(owner, smaller.task_id, "paper-three-thousand"), { code: "SIMULATION_BLOCKED" });
  assert.equal((await engine.read(owner, state => require("../mot/engine").overview(state, engine.now()))).available_minor, 600_000);
});

test("three demo prompts share one verified sample without inventing profit or payment", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mot-demo-stories-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const owner = "story-owner", engine = new MotEngine(new FileRepository(directory));
  await engine.ingest(owner, fixture(new Date().toISOString()), "story-baseline");
  const ask = (text, requestId) => answer({ text, conversationId: "story-conversation", agentId: "mot",
    owner, runtime: engine, merchant: null, requestId });
  const before = await engine.read(owner);
  const treasury = await ask("帮我看两家店现在有多少钱，资金池里有多少，还有多少没到账。", "story-1");
  assert.match(treasury.text, /15000\.00|15000/);
  assert.match(treasury.text, /8000\.00|8000/);
  assert.match(treasury.text, /550\.00|550/);
  const recon = await ask("核对今天的收款和到账，哪几笔对不上？内部调拨不要算营业收入。", "story-2");
  assert.equal(recon.status, "PARTIAL");
  const evidence = recon.tool_results.find(row => row.kind === "reconciliation");
  assert.deepEqual(evidence.pairs.map(row => [row.expected_minor, row.settled_minor, row.status]),
    [[20_000, 20_000, "MATCHED"], [30_000, 29_000, "MISMATCH"]]);
  assert.equal(evidence.pending.reduce((sum, row) => sum + row.amount_minor, 0), 55_000);
  assert.equal(evidence.internal_transfers.length, 2);
  assert.match(recon.text, /原因待核实/);
  const rent = await ask("帮我支付 13,500 元房租。", "story-3");
  assert.equal(rent.status, "BLOCKED");
  assert.equal(rent.tool_results[0].shortfall_minor, 550_000);
  assert.equal(rent.tool_results[0].account_id, "bank-main");
  const profit = await ask("今天赚了多少钱？", "profit-scope");
  assert.equal(profit.status, "UNKNOWN");
  assert.match(profit.text, /无法计算净利润/);
  const after = await engine.read(owner);
  assert.deepEqual(after.accounts, before.accounts);
  assert.equal(after.tasks.length, before.tasks.length);
  assert.equal(after.transactions.length, before.transactions.length);
});

test("isolated synthetic approval completes one paper payment and preserves audit", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mot-paper-payment-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const owner = "isolated-payment-owner";
  const engine = new MotEngine(new FileRepository(directory), { coreRisk: {
    review: async ({ task_id, proposal_fingerprint }) => ({ status: "VERIFIED", risk: "APPROVE", verified: true,
      core_task_id: task_id, risk_check_id: "synthetic-risk-payment-1", proof_id: "synthetic-risk-proof-1",
      proposal_fingerprint, mode: "SIMULATION_ONLY" }),
    approve: async ({ task_id, ledger_revision, review }) => ({ verified: true, decision: "APPROVE", task_id,
      ledger_revision, proof_id: "synthetic-owner-proof-1", proposal_fingerprint: review.proposal_fingerprint })
  } });
  await engine.ingest(owner, fixture(new Date().toISOString()), "isolated-payment-fixture");
  const baseline = await engine.read(owner, state => require("../mot/engine").overview(state, engine.now()));
  assert.deepEqual([baseline.total_verified_minor, baseline.pool_balance_minor, baseline.pending_settlement_minor],
    [1_500_000, 800_000, 55_000]);
  const input = { amount_minor: 120_000, account_id: "bank-main", payee_id: "synthetic-landlord",
    currency: "CNY", request_key: "paper-payment-1200" };
  const task = await engine.proposePayment(owner, input);
  assert.equal(task.kind, "PAYMENT_PROPOSAL");
  assert.equal(task.state, "PENDING_APPROVAL");
  assert.equal((await engine.proposePayment(owner, input)).task_id, task.task_id);
  await assert.rejects(engine.proposePayment(owner, { ...input, amount_minor: 120_001 }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal((await engine.read(owner, state => state.accounts[0].balance_minor)), 800_000);
  await engine.decideApproval(owner, task.task_id, "APPROVE");
  assert.equal((await engine.read(owner, state => state.accounts[0].balance_minor)), 800_000);
  const receipt = await engine.simulate(owner, task.task_id, "paper-payment-execute-1");
  assert.equal(receipt.balance_after_minor, 680_000);
  assert.equal(receipt.side_effects, false);
  assert.equal((await engine.simulate(owner, task.task_id, "paper-payment-execute-1")).receipt_id, receipt.receipt_id);
  await assert.rejects(engine.simulate(owner, task.task_id, "paper-payment-execute-2"), { code: "SIMULATION_BLOCKED" });
  const after = await engine.read(owner);
  const view = require("../mot/engine").overview(after, engine.now());
  assert.deepEqual([view.total_verified_minor, view.pool_balance_minor, view.pending_settlement_minor],
    [1_380_000, 680_000, 55_000]);
  assert.equal(after.transactions.filter(row => row.source_system === "PAPER_SIMULATION" && row.task_id === task.task_id).length, 1);
  assert.equal(after.audit.filter(row => row.task_id === task.task_id && row.event_type === "payment.simulated").length, 1);
  assert.equal((await engine.read("another-owner", state => state.tasks)).length, 0);
});

test("paper payment approval expires and unavailable Risk never debits", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mot-payment-expiry-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let clock = Date.parse("2026-11-01T09:00:00.000Z");
  const repository = new FileRepository(directory), owner = "expiry-owner";
  const now = () => new Date(clock).toISOString();
  const input = { amount_minor: 120_000, account_id: "bank-main", payee_id: "synthetic-landlord",
    currency: "CNY", request_key: "payment-expiry-1" };
  const blocked = new MotEngine(repository, { now });
  await blocked.ingest(owner, fixture(now()), "payment-expiry-fixture");
  const denied = await blocked.proposePayment(owner, input);
  assert.equal(denied.state, "BLOCKED");
  await assert.rejects(blocked.decideApproval(owner, denied.task_id, "APPROVE"), { code: "APPROVAL_NOT_READY" });
  await assert.rejects(blocked.simulate(owner, denied.task_id, "denied-execution"), { code: "SIMULATION_BLOCKED" });
  const verified = new MotEngine(repository, { now, coreRisk: {
    review: async ({ task_id, proposal_fingerprint }) => ({ status: "VERIFIED", risk: "APPROVE", verified: true,
      core_task_id: task_id, risk_check_id: "synthetic-risk-expiry", proof_id: "synthetic-review-expiry",
      proposal_fingerprint, mode: "SIMULATION_ONLY" }),
    approve: async ({ task_id, ledger_revision, review }) => ({ verified: true, decision: "APPROVE", task_id,
      ledger_revision, proof_id: "synthetic-approval-expiry", proposal_fingerprint: review.proposal_fingerprint })
  } });
  const approved = await verified.proposePayment(owner, { ...input, request_key: "payment-expiry-2" });
  await verified.decideApproval(owner, approved.task_id, "APPROVE");
  clock += 5 * 60_000 + 1;
  await assert.rejects(verified.simulate(owner, approved.task_id, "expired-execution"), { code: "SIMULATION_BLOCKED" });
  assert.equal((await verified.read(owner, state => state.accounts[0].balance_minor)), 800_000);
  assert.equal((await verified.read(owner, state => state.transactions.filter(tx => tx.source_system === "PAPER_SIMULATION"))).length, 0);
});

test("treasury chat marks stale non-pool totals unknown without hiding a fresh pool balance", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mot-stale-total-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const at = "2026-11-01T09:00:00.000Z", owner = "stale-total-owner";
  const engine = new MotEngine(new FileRepository(directory), { now: () => at });
  const data = fixture(at);
  data.accounts[1].as_of = "2026-10-30T09:00:00.000Z";
  await engine.ingest(owner, data, "stale-total-fixture");
  const reply = await answer({ text: "帮我看两家店现在有多少钱，资金池里有多少，还有多少没到账。",
    conversationId: "stale-total-conversation", agentId: "mot", owner, runtime: engine,
    merchant: null, requestId: "stale-total-request" });
  assert.equal(reply.status, "UNKNOWN");
  assert.equal(reply.tool_results[0].overview.total_verified_minor, null);
  assert.equal(reply.tool_results[0].overview.pool_balance_minor, 800_000);
  assert.match(reply.text, /账户总额 待核对/);
});

test("two competing paper payments cannot approve and spend the same pool snapshot", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mot-payment-concurrent-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const owner = "concurrent-payment-owner";
  const engine = new MotEngine(new FileRepository(directory), { coreRisk: {
    review: async ({ task_id, proposal_fingerprint }) => ({ status: "VERIFIED", risk: "APPROVE", verified: true,
      core_task_id: task_id, risk_check_id: `risk-${task_id}`, proof_id: `review-${task_id}`,
      proposal_fingerprint, mode: "SIMULATION_ONLY" }),
    approve: async ({ task_id, ledger_revision, review }) => ({ verified: true, decision: "APPROVE", task_id,
      ledger_revision, proof_id: `approval-${task_id}`, proposal_fingerprint: review.proposal_fingerprint })
  } });
  await engine.ingest(owner, fixture(new Date().toISOString()), "concurrent-payment-fixture");
  const first = await engine.proposePayment(owner, { amount_minor: 600_000, account_id: "bank-main",
    payee_id: "synthetic-payee-a", currency: "CNY", request_key: "concurrent-payment-a" });
  const second = await engine.proposePayment(owner, { amount_minor: 600_000, account_id: "bank-main",
    payee_id: "synthetic-payee-b", currency: "CNY", request_key: "concurrent-payment-b" });
  const approvals = await Promise.allSettled([
    engine.decideApproval(owner, first.task_id, "APPROVE"), engine.decideApproval(owner, second.task_id, "APPROVE")
  ]);
  assert.equal(approvals.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(approvals.filter(row => row.status === "rejected" && row.reason.code === "STALE_TASK").length, 1);
  const approvedId = approvals[0].status === "fulfilled" ? first.task_id : second.task_id;
  await engine.simulate(owner, approvedId, "concurrent-payment-execute");
  const state = await engine.read(owner);
  assert.equal(state.accounts[0].balance_minor, 200_000);
  assert.equal(state.transactions.filter(row => row.source_system === "PAPER_SIMULATION").length, 1);
});
