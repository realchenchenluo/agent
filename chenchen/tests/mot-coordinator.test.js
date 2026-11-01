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
