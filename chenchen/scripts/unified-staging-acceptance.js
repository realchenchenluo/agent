"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

async function main() {
  const base = process.env.MOT_STAGING_BASE;
  const password = process.env.APP_STAGING_PASSWORD;
  const tokenA = process.env.MOT_TOKEN_A, tokenB = process.env.MOT_TOKEN_B;
  const expectedSha = process.env.EXPECTED_SHA;
  if (!base || !password || !tokenA || !tokenB || !expectedSha) throw new Error("Staging acceptance environment is incomplete");
  const evidence = { contract_version: "app.v1", base, expected_sha: expectedSha,
    worker_version_id: process.env.MOT_VERSION_ID || null, data_mode: "SYNTHETIC_ONLY", requests: [] };
  async function call(route, { method = "GET", body, token, cookie, origin = base } = {}) {
    const response = await fetch(base + route, { method, redirect: "manual",
      headers: { ...(token ? { "X-Mot-Key": token } : {}), ...(cookie ? { Cookie: cookie } : {}),
        ...(method === "POST" ? { Origin: origin } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    let data = null;
    if (response.headers.get("content-type")?.includes("json")) data = await response.json();
    evidence.requests.push({ method, route, status: response.status, result: data?.error?.code || data?.contract_version || null });
    return { response, data, text: data ? null : await response.text() };
  }
  const landing = await call("/app");
  assert.equal(landing.response.status, 200); assert.match(landing.text, /Staging 登录/);
  assert.equal((await call("/api/app/bootstrap")).response.status, 401);
  const rejected = await fetch(base + "/api/app/login", { method: "POST", redirect: "manual",
    headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password: "wrong-staging-password" }) });
  evidence.requests.push({ method: "POST", route: "/api/app/login", status: rejected.status, result: "INVALID_PASSWORD" });
  assert.equal(rejected.status, 401);
  const login = await fetch(base + "/api/app/login", { method: "POST", redirect: "manual",
    headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password }) });
  const setCookie = login.headers.get("set-cookie") || "";
  evidence.requests.push({ method: "POST", route: "/api/app/login", status: login.status, result: "SESSION_CREATED" });
  assert.equal(login.status, 303); assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict/);
  const cookie = setCookie.split(";")[0];
  const app = await call("/app", { cookie });
  assert.equal(app.response.status, 200); assert.match(app.text, /MOT · 财务总助手/);
  assert.ok(!app.text.includes(tokenA) && !app.text.includes(tokenB));
  const script = await call("/versions/app.js");
  assert.equal(script.response.status, 200); assert.ok(!script.text.includes(tokenA) && !script.text.includes(tokenB));
  const css = await call("/versions/app.css"); assert.equal(css.response.status, 200);
  const health = await call("/api/mot/health", { token: tokenA });
  assert.equal(health.response.status, 200); assert.equal(health.data.build_sha, expectedSha);
  const bootstrap = await call("/api/app/bootstrap", { cookie });
  assert.equal(bootstrap.response.status, 200); assert.equal(bootstrap.data.owner_id, "mot-staging-a");
  assert.ok(bootstrap.data.agents.some(item => item.agent_id === "mot"));
  const context = await call("/api/app/context/mot", { cookie });
  assert.equal(context.response.status, 200); assert.equal(context.data.overview.stores, 2);
  assert.ok(context.data.tasks.length >= 2);
  const createKey = `unified-accept-${expectedSha.slice(0, 12)}`;
  const created = await call("/api/app/conversations", { method: "POST", cookie,
    body: { agent_id: "mot", request_id: createKey } });
  assert.equal(created.response.status, 201);
  const id = created.data.conversation_id;
  const messageRoute = `/api/app/conversations/${id}/messages`;
  const message = { text: "查看当前监测任务", request_id: `${createKey}-tasks` };
  const replied = await call(messageRoute, { method: "POST", cookie, body: message });
  assert.equal(replied.response.status, 200); assert.equal(replied.data.messages[1].source, "MOT_INBOX");
  assert.ok(replied.data.messages[1].tool_results[0].tasks.length >= 2);
  assert.equal((await call(messageRoute, { method: "POST", cookie, body: message })).data.replayed, true);
  const transferInput = { text: "帮我从运营账户转账 500 元到西店账户", request_id: `${createKey}-transfer` };
  const blocked = await call(messageRoute, { method: "POST", cookie, body: transferInput });
  assert.equal(blocked.response.status, 200); assert.equal(blocked.data.messages[1].status, "BLOCKED");
  const transferTask = blocked.data.messages[1].tool_results[0].task;
  assert.equal(transferTask.kind, "TRANSFER_PROPOSAL");
  assert.equal(transferTask.proposal.amount_minor, 50_000);
  assert.equal(transferTask.proposal.to_account_id, "bank-west");
  assert.equal((await call(messageRoute, { method: "POST", cookie, body: transferInput })).data.messages[1].task_id, transferTask.task_id);
  assert.equal((await call(`/api/mot/tasks/${transferTask.task_id}/simulate`, { method: "POST", cookie,
    body: { idempotency_key: `${createKey}-paper` } })).response.status, 409);
  assert.equal((await call(`/api/app/conversations/${id}`, { token: tokenB })).response.status, 404);
  const restored = await call(`/api/app/conversations/${id}`, { cookie });
  assert.equal(restored.data.messages.length, 4);
  const combined = await call(messageRoute, { method: "POST", cookie,
    body: { text: "检查两家门店资金，并告诉我有没有需要关注的持仓风险", request_id: `${createKey}-combined` } });
  assert.equal(combined.response.status, 200);
  assert.equal(combined.data.messages[1].status, "PARTIAL");
  const run = combined.data.messages[1].tool_results.find(row => row.kind === "run").run;
  assert.deepEqual(run.steps.map(row => row.agent_id), ["mot", "investment", "risk"]);
  assert.equal(run.steps[2].status, "UNAVAILABLE");
  assert.equal((await call("/api/app/bootstrap", { cookie })).data.task_runs.find(row => row.run_id === run.run_id).task_id, run.task_id);
  const monitor = await call(messageRoute, { method: "POST", cookie,
    body: { text: "监测资金池可用余额低于 9000 元，站内提醒我", request_id: `${createKey}-monitor` } });
  assert.equal(monitor.response.status, 200);
  const monitorId = monitor.data.messages[1].tool_results[0].monitor.monitor_id;
  assert.equal((await call("/api/mot/monitors", { token: tokenB })).data.items.find(row => row.monitor_id === monitorId), undefined);
  const manual = await call("/api/mot/check", { method: "POST", cookie, body: { idempotency_key: `${createKey}-monitor-check` } });
  assert.equal(manual.response.status, 200);
  assert.ok((await call("/api/mot/tasks", { cookie })).data.items.some(row => row.kind === "MONITOR_BELOW_THRESHOLD" && row.finding_key.endsWith(monitorId)));
  const paused = await call(`/api/mot/monitors/${monitorId}`, { method: "POST", cookie,
    body: { action: "PAUSE", request_key: `${createKey}-monitor-pause` } });
  assert.equal(paused.data.status, "PAUSED");
  const resumed = await call(`/api/mot/monitors/${monitorId}`, { method: "POST", cookie,
    body: { action: "RESUME", request_key: `${createKey}-monitor-resume` } });
  assert.equal(resumed.data.status, "ACTIVE");
  const unsafe = await call("/api/app/conversations", { method: "POST", cookie,
    origin: "https://attacker.example", body: { agent_id: "mot", request_id: randomUUID() } });
  assert.equal(unsafe.response.status, 403);
  const old = await call("/mot");
  assert.equal(old.response.status, 302); assert.match(old.response.headers.get("location"), /\/app\?agent=mot$/);
  evidence.owner_id = bootstrap.data.owner_id;
  evidence.stores = context.data.overview.stores;
  evidence.unresolved_tasks = context.data.unresolved_count;
  evidence.conversation_id = id;
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch(cause => { console.error(cause); process.exitCode = 1; });
