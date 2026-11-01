"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { MotEngine, fixture } = require("../mot/engine");
const { FileRepository } = require("../mot/file-repository");
const { makeMotHttp } = require("../mot/http");

test("isolated HTTP payment uses real MOT routes, verified synthetic adapter, one receipt and one debit", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mot-payment-http-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const owner = "isolated-payment-http", key = "synthetic-payment-http-key-123456789";
  const env = { MOT_AUTH_TOKENS_JSON: JSON.stringify([{ owner_id: owner, token: key,
    roles: ["read", "operator", "approver", "ingestor"] }]) };
  const engine = new MotEngine(new FileRepository(directory), { coreRisk: {
    review: async ({ task_id, proposal_fingerprint }) => ({ status: "VERIFIED", risk: "APPROVE", verified: true,
      core_task_id: task_id, risk_check_id: "synthetic-http-risk", proof_id: "synthetic-http-review",
      proposal_fingerprint, mode: "SIMULATION_ONLY" }),
    approve: async ({ task_id, ledger_revision, review }) => ({ verified: true, decision: "APPROVE", task_id,
      ledger_revision, proof_id: "synthetic-http-approval", proposal_fingerprint: review.proposal_fingerprint })
  } });
  const api = makeMotHttp(env, engine);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    let body = {};
    if (raw) try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
    await api.handle(req, res, new URL(req.url, "http://localhost").pathname,
      new URL(req.url, "http://localhost"), body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body, token = key) => {
    const response = await fetch(base + route, { method: body ? "POST" : "GET",
      headers: { "X-Mot-Key": token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  await engine.ingest(owner, fixture(new Date().toISOString()), "isolated-http-fixture");
  const input = { amount_minor: 120_000, account_id: "bank-main", payee_id: "synthetic-landlord",
    currency: "CNY", request_key: "http-payment-1200" };
  const proposal = await call("/api/mot/payments/propose", input);
  assert.equal(proposal.status, 201);
  assert.equal(proposal.data.state, "PENDING_APPROVAL");
  assert.equal((await call("/api/mot/overview")).data.total_verified_minor, 1_500_000);
  const taskId = proposal.data.task_id;
  assert.equal((await call(`/api/mot/tasks/${taskId}/approval`, { decision: "APPROVE" })).status, 200);
  const first = await call(`/api/mot/tasks/${taskId}/simulate`, { idempotency_key: "http-payment-once" });
  assert.equal(first.status, 200);
  assert.equal(first.data.balance_after_minor, 680_000);
  const replay = await call(`/api/mot/tasks/${taskId}/simulate`, { idempotency_key: "http-payment-once" });
  assert.equal(replay.data.receipt_id, first.data.receipt_id);
  assert.equal((await call(`/api/mot/tasks/${taskId}/simulate`, { idempotency_key: "http-payment-again" })).status, 409);
  const overview = (await call("/api/mot/overview")).data;
  assert.deepEqual([overview.pool_balance_minor, overview.total_verified_minor, overview.pending_settlement_minor],
    [680_000, 1_380_000, 55_000]);
  assert.equal((await call("/api/mot/audit")).data.items.filter(row => row.task_id === taskId && row.event_type === "payment.simulated").length, 1);
  assert.equal((await call(`/api/mot/tasks/${taskId}`, undefined, "wrong-synthetic-key-123456789")).status, 401);
});
