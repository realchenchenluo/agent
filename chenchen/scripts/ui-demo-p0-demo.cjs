"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process"), { randomUUID } = require("node:crypto");
const root = path.resolve(__dirname, "..");
const out = path.resolve(root, "../review/ui-demo-p0-artifacts");
const server = spawn(process.execPath, ["-e", 'const {server}=require("./server");server.listen(0,"127.0.0.1",()=>console.log(server.address().port));'], {
  cwd: root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
});
const evidence = { layer: "LOCAL_REAL_API", fixture_version: "ui-demo-p0-20261101.v1", synthetic: true, paid_model_calls: 0, real_financial_operations: 0, records: [] };
async function main() {
  const base = await new Promise((resolve, reject) => { server.stdout.once("data", value => resolve("http://127.0.0.1:" + Number(value))); server.once("error", reject); });
  async function call(route, body) {
    const response = await fetch(base + route, { ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const payload = await response.json(); evidence.records.push({ route, http_status: response.status, payload });
    return { status: response.status, payload };
  }
  const request = JSON.parse(fs.readFileSync(path.join(root, "contracts/examples/health-check.request.json")));
  request.request_id = "req-p0-health-" + randomUUID();
  const health = await call("/api/health-check/run", request);
  assert.equal(health.status, 200); assert.equal(health.payload.task_state.status, "HANDOFF_REQUIRED");
  assert.ok(Object.keys(health.payload.tool_results).length >= 4); assert.equal(health.payload.risk_handoff.execution_allowed, false);
  await call("/api/audit/" + encodeURIComponent(health.payload.task_state.task_id));
  const plan = await call("/api/funding-demo/plan", { synthetic: true, confirmed: true, currency: "CNY", cash_minor: 1000000, protected_purposes: [{ purpose_id: "rent", label: "固定演示房租", amount_minor: 400000 }] });
  assert.equal(plan.status, 200); assert.equal(plan.payload.available_minor, 600000); assert.equal(plan.payload.allocated_minor, 0);
  const requestId = "req-p0-review-" + randomUUID();
  const review = await call("/api/review", { schema_version: "model-review.v1", request_id: requestId, idempotency_key: requestId,
    kind: "bill", source: "ui-demo-p0-20261101.v1", text: "虚构固定账本现金10000元，下月房租预留4000元。我想安排8000元买基金，请核对是否挤占预留。",
    requested_action: "只读检查虚构资金与支出预留的冲突", source_task_id: health.payload.task_state.task_id,
    session_id: health.payload.task_state.session_id, data_mode: "SYNTHETIC_REPLAY", execution_mode: "PAPER", capability: "REVIEW_ONLY", memory_consent: false,
    action_parameters: { amount: 8000, currency: "CNY", synthetic: true, funding_plan_id: plan.payload.plan_id, funding_plan_revision: plan.payload.revision } });
  assert.ok(review.status >= 400, "No provider credentials are passed to this isolated server");
  const workflow = review.payload.workflow;
  if (workflow?.task_id) {
    assert.equal(workflow.execution.receipt, null);
    await call("/api/review/task/" + encodeURIComponent(workflow.task_id));
  }
  const finalPlan = await call("/api/funding-demo/plan/" + encodeURIComponent(plan.payload.plan_id));
  assert.equal(finalPlan.payload.allocated_minor, 0);
  evidence.result = "PASS_EXPECTED_BLOCK";
  evidence.full_demo = "NO-GO";
  evidence.boundary = "Health calculation and funding arithmetic are real local APIs. Model is unconfigured; no Risk decision,本人审批 or SIMULATED receipt was produced.";
}
main().catch(error => { evidence.result = "FAIL"; evidence.error = error.message; process.exitCode = 1; }).finally(() => {
  server.kill(); fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, "main-demo.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ result: evidence.result, full_demo: evidence.full_demo, requests: evidence.records.map(item => ({ route: item.route, status: item.http_status })) }));
});
