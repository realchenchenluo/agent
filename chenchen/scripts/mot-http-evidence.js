"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mot-evidence-"));
  process.env.MOT_LOCAL_DEMO = "true";
  process.env.MOT_SCHEDULER_ENABLED = "false";
  process.env.MOT_DATA_DIR = directory;
  const { server } = require("../server");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const records = [];
  async function call(method, route, requestBody) {
    const response = await fetch(base + route, { method,
      headers: requestBody === undefined ? {} : { "Content-Type": "application/json" },
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody) });
    const body = await response.json();
    records.push({ method, route, request: requestBody ?? null, status: response.status, response: body });
    return body;
  }
  try {
    await call("GET", "/api/mot/overview");
    await call("POST", "/api/mot/demo/ingest", { idempotency_key: "evidence-demo-v1" });
    await call("POST", "/api/mot/check", { idempotency_key: "evidence-check-v1" });
    await call("GET", "/api/mot/overview");
    await call("GET", "/api/mot/tasks");
    await call("GET", "/api/mot/inbox");
    const proposal = await call("POST", "/api/mot/reservations/propose", {
      amount_minor: 10_000, account_ids: ["bank-main"], request_key: "evidence-reserve-v1" });
    await call("POST", `/api/mot/tasks/${proposal.task_id}/approval`, { decision: "APPROVE" });
    await call("GET", "/api/mot/health");
    console.log(JSON.stringify({ contract_version: "mot.v1", data_mode: "SYNTHETIC_ONLY",
      transport: "isolated local Node HTTP", requests: records }, null, 2));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
