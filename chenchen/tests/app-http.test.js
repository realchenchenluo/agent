"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { fixture } = require("../mot/engine");
const { ConversationStore } = require("../app/conversations");

const keyA = "app-owner-a-synthetic-key-123456", keyB = "app-owner-b-synthetic-key-123456";
let directory, server, base;
test.before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "app-http-"));
  process.env.MOT_DATA_DIR = directory;
  process.env.APP_DATA_DIR = path.join(directory, "conversations");
  process.env.MOT_AUTH_TOKENS_JSON = JSON.stringify([
    { owner_id: "app-owner-a", token: keyA, roles: ["read", "operator", "approver", "ingestor"] },
    { owner_id: "app-owner-b", token: keyB, roles: ["read", "operator", "approver", "ingestor"] }
  ]);
  ({ server } = require("../server"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });

async function call(route, { method = "GET", body, token = keyA, redirect } = {}) {
  const response = await fetch(base + route, { method, redirect,
    headers: { ...(token ? { "X-Mot-Key": token } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: response.headers.get("content-type")?.includes("json") ? await response.json() : null,
    location: response.headers.get("location") };
}

test("one app entry redirects legacy product routes", async () => {
  assert.equal((await call("/mot", { redirect: "manual" })).location, "/app?agent=mot");
  assert.equal((await call("/merchant", { redirect: "manual" })).location, "/app?agent=merchant");
  assert.equal((await call("/investment", { redirect: "manual" })).location, "/app?agent=investment");
  assert.equal((await call("/risk-workbench", { redirect: "manual" })).location, "/app?agent=risk");
  assert.equal((await call("/app")).status, 200);
});

test("server owned conversations, tool answers, idempotency and isolation", async () => {
  assert.equal((await call("/api/app/bootstrap", { token: null })).status, 401);
  assert.equal((await call("/api/mot/events/ingest", { method: "POST", body: {
    snapshot: fixture(new Date().toISOString()), idempotency_key: "app-seed-owner-a" } })).status, 200);
  const created = await call("/api/app/conversations", { method: "POST", body: { agent_id: "mot", request_id: "create-app-a-001" } });
  assert.equal(created.status, 201);
  const id = created.data.conversation_id;
  assert.equal((await call("/api/app/conversations", { method: "POST", body: { agent_id: "mot", request_id: "create-app-a-001" } })).data.conversation_id, id);
  const sent = await call(`/api/app/conversations/${id}/messages`, { method: "POST", body: { text: "查看当前监测任务", request_id: "message-app-a-001" } });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.messages[1].source, "MOT_INBOX");
  assert.equal(sent.data.messages[1].conversation_id, id);
  assert.ok(sent.data.messages[1].tool_results[0].tasks.length >= 2);
  assert.equal((await call(`/api/app/conversations/${id}/messages`, { method: "POST", body: { text: "查看当前监测任务", request_id: "message-app-a-001" } })).data.replayed, true);
  assert.equal((await call(`/api/app/conversations/${id}/messages`, { method: "POST", body: { text: "不同请求", request_id: "message-app-a-001" } })).status, 409);
  assert.equal((await call(`/api/app/conversations/${id}`, { token: keyB })).status, 404);
  assert.equal((await call("/api/app/bootstrap", { token: keyB })).data.conversations.length, 0);
  const reloaded = await new ConversationStore(path.join(directory, "conversations")).read("app-owner-a");
  assert.equal(reloaded.conversations[0].messages.length, 2);
});

test("merchant and investment adapters return sourced results; transfer remains blocked", async () => {
  for (const [agent, text, source] of [
    ["merchant", "看看账单", "MERCHANT_LEDGER_LOCAL_SESSION"],
    ["investment", "看看持仓", "INVESTMENT_DEMO_SNAPSHOT"],
    ["mot", "把东店的钱转给西店", "MOT_CORE_RISK"]
  ]) {
    const created = await call("/api/app/conversations", { method: "POST", body: { agent_id: agent, request_id: `create-${agent}-test` } });
    const sent = await call(`/api/app/conversations/${created.data.conversation_id}/messages`, { method: "POST", body: { text, request_id: `message-${agent}-test` } });
    assert.equal(sent.status, 200, sent.data.error?.code);
    assert.equal(sent.data.messages[1].source, source);
    if (agent === "mot") assert.equal(sent.data.messages[1].status, "NEEDS_INPUT");
  }
  assert.equal((await call("/api/mot/tasks")).data.items.filter(row => row.kind === "RESERVATION_PROPOSAL").length, 0);
  const createdTransfer = await call("/api/app/conversations", { method: "POST", body: { agent_id: "mot", request_id: "create-transfer-chat-001" } });
  const transferRoute = `/api/app/conversations/${createdTransfer.data.conversation_id}/messages`;
  const transferBody = { text: "帮我从运营账户转账 500 元到西店账户", request_id: "transfer-chat-001" };
  const transfer = await call(transferRoute, { method: "POST", body: transferBody });
  assert.equal(transfer.data.messages[1].status, "BLOCKED");
  assert.equal(transfer.data.messages[1].tool_results[0].kind, "transfer_proposal");
  const transferTaskId = transfer.data.messages[1].task_id;
  assert.ok(transferTaskId);
  assert.equal((await call(transferRoute, { method: "POST", body: transferBody })).data.messages[1].task_id, transferTaskId);
  assert.equal((await call("/api/mot/tasks")).data.items.filter(row => row.kind === "TRANSFER_PROPOSAL").length, 1);
});

test("MOT coordinator keeps one conversation and exposes persistent monitor controls", async () => {
  const created = await call("/api/app/conversations", { method: "POST", body: { agent_id: "mot", request_id: "create-coordinator-http-1" } });
  const route = `/api/app/conversations/${created.data.conversation_id}/messages`;
  const combined = await call(route, { method: "POST", body: {
    text: "检查两家门店资金，并告诉我有没有需要关注的持仓风险", request_id: "combined-coordinator-http-1" } });
  assert.equal(combined.status, 200);
  const reply = combined.data.messages[1];
  assert.equal(reply.status, "PARTIAL");
  assert.equal(reply.conversation_id, created.data.conversation_id);
  const run = reply.tool_results.find(row => row.kind === "run").run;
  assert.equal((await call("/api/app/bootstrap")).data.task_runs.find(row => row.run_id === run.run_id).task_id, run.task_id);
  const monitorReply = await call(route, { method: "POST", body: {
    text: "监测资金池可用余额低于 9000 元，站内提醒我", request_id: "monitor-chat-http-1" } });
  assert.equal(monitorReply.status, 200);
  const monitor = monitorReply.data.messages[1].tool_results[0].monitor;
  assert.equal(monitor.status, "ACTIVE");
  assert.equal((await call("/api/mot/monitors")).data.items.find(row => row.monitor_id === monitor.monitor_id).threshold_minor, 900_000);
  assert.equal((await call("/api/mot/monitors", { token: keyB })).data.items.length, 0);
  assert.equal((await call(`/api/mot/monitors/${monitor.monitor_id}`, { method: "POST", token: keyB,
    body: { action: "PAUSE", request_key: "cross-owner-pause-1" } })).status, 404);
  assert.equal((await call(`/api/mot/monitors/${monitor.monitor_id}`, { method: "POST",
    body: { action: "PAUSE", request_key: "owner-pause-1" } })).data.status, "PAUSED");
});
