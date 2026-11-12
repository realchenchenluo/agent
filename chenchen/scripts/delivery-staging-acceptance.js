"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture } = require("../mot/engine");

async function main() {
  const base = process.env.MOT_STAGING_BASE;
  const token = process.env.MOT_TOKEN_B;
  const tokenA = process.env.MOT_TOKEN_A;
  const password = process.env.APP_STAGING_PASSWORD;
  const expectedSha = process.env.EXPECTED_SHA;
  if (!base || !token || !tokenA || !password || !expectedSha) throw new Error("Missing isolated Staging acceptance configuration");
  const evidence = { base, expected_sha: expectedSha, owner_id: null, requests: [], stories: {}, payment: {} };
  const call = async (route, body, options = {}) => {
    const selectedToken = options.token === undefined ? token : options.token;
    const response = await fetch(base + route, { method: body ? "POST" : "GET",
      headers: { ...(selectedToken ? { "X-Mot-Key": selectedToken } : {}),
        ...(body ? { "Content-Type": "application/json", Origin: options.origin || base } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    evidence.requests.push({ route, status: response.status, error: data.error?.code || null });
    return { status: response.status, data };
  };
  const health = await call("/api/mot/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.build_sha, expectedSha);
  assert.equal((await call("/api/mot/health", undefined, { token: null })).status, 401);
  let view = (await call("/api/mot/overview")).data;
  evidence.owner_id = view.owner_id;
  assert.equal(view.owner_id, "mot-staging-b");
  if (view.stores === 0) {
    const seeded = await call("/api/mot/events/ingest", { snapshot: fixture(new Date().toISOString()),
      idempotency_key: `delivery-seed-${expectedSha.slice(0, 12)}` });
    assert.equal(seeded.status, 200, seeded.data.error?.code);
    view = (await call("/api/mot/overview")).data;
  }
  assert.deepEqual([view.total_verified_minor, view.pool_balance_minor, view.pending_settlement_minor],
    [1_500_000, 800_000, 55_000]);
  evidence.baseline = { ledger_revision: view.revision, as_of: view.as_of,
    total_minor: view.total_verified_minor, pool_minor: view.pool_balance_minor,
    pending_minor: view.pending_settlement_minor };
  const conversation = await call("/api/app/conversations", { agent_id: "mot", request_id: randomUUID() });
  assert.equal(conversation.status, 201);
  const conversationId = conversation.data.conversation_id;
  evidence.conversation_id = conversationId;
  assert.equal((await call(`/api/app/conversations/${conversationId}`, undefined, { token: tokenA })).status, 404);
  const login = await fetch(base + "/api/app/login", { method: "POST", redirect: "manual",
    headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }) });
  evidence.requests.push({ route: "/api/app/login", status: login.status, error: null });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const unsafe = await fetch(base + "/api/app/conversations", { method: "POST",
    headers: { Cookie: cookie, Origin: "https://untrusted.example", "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: "mot", request_id: randomUUID() }) });
  evidence.requests.push({ route: "/api/app/conversations", status: unsafe.status, error: (await unsafe.json()).error?.code });
  assert.equal(unsafe.status, 403);
  const ask = async text => {
    const response = await call(`/api/app/conversations/${conversationId}/messages`, { text, request_id: randomUUID() });
    assert.equal(response.status, 200, response.data.error?.code);
    return response.data.messages[1];
  };
  const treasury = await ask("帮我看两家店现在有多少钱，资金池里有多少，还有多少没到账。");
  assert.equal(treasury.source, "MOT_LEDGER");
  assert.deepEqual([treasury.tool_results[0].overview.total_verified_minor,
    treasury.tool_results[0].overview.pool_balance_minor,
    treasury.tool_results[0].overview.pending_settlement_minor], [1_500_000, 800_000, 55_000]);
  evidence.stories.treasury = { status: treasury.status, source: treasury.source, text: treasury.text,
    as_of: treasury.as_of, message_id: treasury.message_id };
  const reconciliation = await ask("核对今天的收款和到账，哪几笔对不上？内部调拨不要算营业收入。");
  const pairs = reconciliation.tool_results.find(row => row.kind === "reconciliation");
  assert.equal(reconciliation.status, "PARTIAL");
  assert.deepEqual(pairs.pairs.map(row => [row.expected_minor, row.settled_minor, row.status]),
    [[20_000, 20_000, "MATCHED"], [30_000, 29_000, "MISMATCH"]]);
  assert.equal(pairs.pending.reduce((sum, row) => sum + row.amount_minor, 0), 55_000);
  assert.equal(pairs.internal_transfers.length, 2);
  evidence.stories.reconciliation = { status: reconciliation.status, source: reconciliation.source,
    text: reconciliation.text, pairs: pairs.pairs, pending: pairs.pending,
    internal_transfers: pairs.internal_transfers, message_id: reconciliation.message_id };
  const rent = await ask("帮我支付 13,500 元房租。");
  const decision = rent.tool_results.find(row => row.kind === "payment_decision");
  assert.equal(rent.status, "BLOCKED");
  assert.equal(decision.shortfall_minor, 550_000);
  assert.equal(decision.execution_allowed, false);
  evidence.stories.rent = { status: rent.status, source: rent.source, text: rent.text,
    decision, message_id: rent.message_id };
  const combined = await ask("检查两家门店资金，并告诉我有没有需要关注的持仓风险");
  const run = combined.tool_results.find(row => row.kind === "run")?.run;
  assert.equal(combined.status, "PARTIAL");
  assert.deepEqual(run.steps.map(row => [row.agent_id, row.status]),
    [["mot", "READY"], ["investment", "DEMO_DATA"], ["risk", "UNAVAILABLE"]]);
  const restored = await call("/api/app/bootstrap");
  assert.equal(restored.status, 200);
  assert.equal(restored.data.task_runs.find(row => row.run_id === run.run_id)?.task_id, run.task_id);
  evidence.coordination = { run_id: run.run_id, task_id: run.task_id, steps: run.steps,
    stop_reason: run.stop_reason, restored: true };
  const proposal = await call("/api/mot/payments/propose", { amount_minor: 120_000,
    account_id: "bank-main", payee_id: "synthetic-landlord", currency: "CNY", request_key: randomUUID() });
  assert.equal(proposal.status, 201);
  assert.equal(proposal.data.state, "BLOCKED");
  const approve = await call(`/api/mot/tasks/${proposal.data.task_id}/approval`, { decision: "APPROVE" });
  const simulate = await call(`/api/mot/tasks/${proposal.data.task_id}/simulate`, { idempotency_key: randomUUID() });
  assert.deepEqual([approve.status, simulate.status], [409, 409]);
  const after = (await call("/api/mot/overview")).data;
  assert.deepEqual([after.total_verified_minor, after.pool_balance_minor, after.pending_settlement_minor],
    [1_500_000, 800_000, 55_000]);
  evidence.payment = { task_id: proposal.data.task_id, review: proposal.data.review,
    approval_status: approve.status, simulation_status: simulate.status,
    approval_error: approve.data.error?.code, simulation_error: simulate.data.error?.code,
    ledger_unchanged: true };
  evidence.request_count = evidence.requests.length;
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
