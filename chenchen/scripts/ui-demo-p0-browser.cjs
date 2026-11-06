"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const out = path.resolve(root, "../review/ui-demo-p0-artifacts");
fs.mkdirSync(out, { recursive: true });
const results = [], receipts = [], errors = [];
const fixture = JSON.parse(fs.readFileSync(path.join(root, "contracts/examples/model-review.response.json")));
let server, browser;
async function check(name, callback, layer = "LOCAL_REAL_API") {
  try { await callback(); results.push({ name, layer, result: "PASS" }); }
  catch (error) { results.push({ name, layer, result: "FAIL", error: error.message }); throw error; }
}
async function start() {
  server = spawn(process.execPath, ["-e", 'const {server}=require("./server");server.listen(0,"127.0.0.1",()=>console.log(server.address().port));'], {
    cwd: root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Local server start timed out")), 15000);
    server.stdout.once("data", value => { clearTimeout(timer); resolve("http://127.0.0.1:" + Number(value.toString().trim())); });
    server.once("error", reject);
  });
}
const health = taskId => ({ task_state: { task_id: taskId, status: "HANDOFF_REQUIRED", request_id: "mock-request" }, tool_results: {}, audit_evidence: { task_id: taskId, events: [] } });
async function query(page, kind, id) {
  await page.locator("#task-kind").selectOption(kind);
  await page.locator("#task-lookup-id").fill(id);
  await page.locator("#task-lookup button").click();
}
async function main() {
  const base = await start();
  const engines = [
    ["Chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe"],
    ["Edge", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]
  ];
  for (const [name, executablePath] of engines) {
    if (!fs.existsSync(executablePath)) { results.push({ name, result: "UNVERIFIED", reason: "Browser executable missing" }); continue; }
    browser = await chromium.launch({ executablePath, headless: true });
    results.push({ name, version: browser.version(), mode: "headless desktop", result: "AVAILABLE" });
    const context = await browser.newContext();
    await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    context.on("page", page => page.on("pageerror", error => errors.push({ browser: name, message: error.message })));
    const page = await context.newPage();
    page.on("response", async response => {
      if (/\/api\/(health-check\/run|audit\/)/.test(response.url()) && response.ok()) {
        try { receipts.push({ browser: name, url: new URL(response.url()).pathname, body: await response.json() }); } catch { /* Page may close after capture. */ }
      }
    });
    await check(name + " main health flow", async () => {
      await page.goto(base + "/investment");
      await page.locator("#demo-profile").click(); await page.locator("#run").click();
      await page.locator("#results").waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelector("#task-observer-content").textContent.includes("HANDOFF_REQUIRED"));
      assert.match(await page.locator("#task-observer-content").innerText(), /NOT_EXECUTED/);
      assert.match(await page.locator("#task-observer-content").innerText(), /NOT_CALLED/);
    });
    for (const width of [375, 768, 1440]) {
      await check(name + " investment layout " + width, async () => {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Horizontal overflow");
        await page.screenshot({ path: path.join(out, name.toLowerCase() + "-investment-" + width + ".png"), fullPage: true });
      });
    }
    await check(name + " refresh restores by GET only", async () => {
      let writes = 0;
      const listener = request => { if (request.method() === "POST") writes++; };
      page.on("request", listener); await page.reload();
      await page.waitForFunction(() => document.querySelector("#task-observer-content").textContent.includes("HANDOFF_REQUIRED"));
      assert.equal(writes, 0); page.off("request", listener);
    });
    await check(name + " risk gates and local capability absence", async () => {
      await page.goto(base + "/risk-workbench");
      await page.waitForFunction(() => document.querySelector("#workflow-message").textContent.includes("模型入口禁用"));
      assert.equal(await page.locator("#run-workflow").isDisabled(), true);
      assert.equal(await page.locator('[data-workflow-action]').count(), 0);
    });
    const mock = await browser.newContext();
    await mock.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await mock.route("**/api/review/capabilities", route => route.fulfill({ json: { capability_version: "core-agent-capabilities.v1", model: { configured: true, inference_probe: "MOCK_NOT_LIVE" } } }));
    const plan = { plan_version: "funding-plan-demo.v1", plan_id: "mock-plan", revision: 1, synthetic: true, cash_minor: 1000000,
      protected_purposes: [{ purpose_id: "rent", amount_minor: 400000 }], protected_minor: 400000, allocated_minor: 0, available_minor: 600000, allocations: [] };
    await mock.route("**/api/funding-demo/plan", route => route.fulfill({ json: plan }));
    await mock.route("**/api/review", route => {
      const body = route.request().postDataJSON();
      assert.equal(body.capability, "REVIEW_ONLY"); assert.equal(body.idempotency_key, body.request_id);
      const record = structuredClone(fixture); record.status = "PENDING_APPROVAL"; record.request_id = body.request_id; record.audit.request_id = body.request_id;
      record.model.model_response.model = "MOCK model, no provider call";
      return route.fulfill({ json: record });
    });
    const mocked = await mock.newPage();
    mocked.on("pageerror", error => errors.push({ browser: name, message: error.message }));
    await mock.route("**/api/review/task/mock-*", async route => {
      const id = new URL(route.request().url()).pathname.split("/").at(-1);
      const record = structuredClone(fixture); record.task_id = id;
      for (const key of ["risk_handoff", "approval", "execution", "audit"]) record[key].task_id = id;
      record.audit.events.forEach(event => { event.task_id = id; });
      record.status = id.includes("receipt") ? "SIMULATED" : id.includes("approval") ? "PENDING_APPROVAL" : "PENDING_RISK";
      record.model.model_response.model = "MOCK MODEL " + "long-text-".repeat(100);
      record.risk_decision = { decision: "REJECT", reason: '<img src=x onerror="alert(1)">MOCK 拒绝' };
      await route.fulfill({ json: record });
    });
    await mocked.goto(base + "/risk-workbench");
    await mocked.evaluate(() => { const p = document.createElement("p"); p.textContent = "MOCK · 前端专项测试，不是实际 Risk 联调"; document.querySelector("main").prepend(p); });
    await check(name + " MOCK review UI cannot approve or simulate", async () => {
      await mocked.waitForFunction(() => !document.querySelector("#run-workflow").disabled);
      await mocked.locator("#funding-confirm").check(); await mocked.locator("#save-funding").click();
      await mocked.waitForFunction(() => document.querySelector("#funding-status").textContent.includes("已确认"));
      await mocked.locator("#run-workflow").click();
      await mocked.locator("#workflow-result").waitFor({ state: "visible" });
      assert.equal(await mocked.locator("#workflow-actions button:disabled").count(), 3);
      assert.equal(await mocked.locator("[data-workflow-action]").count(), 0);
      assert.match(await mocked.locator("#workflow-actions").innerText(), /NO-GO/);
      assert.match(await mocked.locator("#workflow-metrics").innerText(), /NOT_EXECUTED/);
    }, "MOCK");
    await check(name + " MOCK task switching, approval and missing receipt", async () => {
      for (const id of ["mock-approval", "mock-receipt", "mock-risk"]) {
        await query(mocked, "review", id);
        await mocked.waitForFunction(id => document.querySelector("#task-observer-content").textContent.includes(id), id);
        assert.match(await mocked.locator("#task-observer-content").innerText(), /NOT_EXECUTED/);
        assert.equal(await mocked.locator("#task-observer img").count(), 0);
      }
    }, "MOCK");
    for (const width of [375, 768, 1440]) {
      await check(name + " MOCK long text risk layout " + width, async () => {
        await mocked.setViewportSize({ width, height: 900 });
        assert.equal(await mocked.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Risk horizontal overflow");
        await mocked.screenshot({ path: path.join(out, name.toLowerCase() + "-mock-risk-" + width + ".png"), fullPage: true });
      }, "MOCK");
    }
    for (const status of [401, 403, 409, 423, 503]) {
      await check(name + " MOCK HTTP " + status, async () => {
        await mock.route("**/api/task/mock-http-" + status, route => route.fulfill({ status, json: { error: { code: "MOCK_" + status } } }));
        await query(mocked, "health", "mock-http-" + status);
        await mocked.waitForFunction(status => document.querySelector("#task-observer-message").textContent.includes("HTTP " + status), status);
      }, "MOCK");
    }
    await check(name + " MOCK malformed and cross-task responses", async () => {
      await mock.route("**/api/task/mock-malformed", route => route.fulfill({ contentType: "application/json", body: "{" }));
      await query(mocked, "health", "mock-malformed");
      await mocked.waitForFunction(() => document.querySelector("#task-observer-message").textContent.includes("格式错误"));
      await mock.route("**/api/task/mock-cross-task", route => route.fulfill({ json: health("someone-else") }));
      await query(mocked, "health", "mock-cross-task");
      await mocked.waitForFunction(() => document.querySelector("#task-observer-message").textContent.includes("其他任务"));
    }, "MOCK");
    await check(name + " MOCK out of order lookup", async () => {
      await mock.route("**/api/task/mock-slow", async route => { await new Promise(resolve => setTimeout(resolve, 350)); await route.fulfill({ json: health("mock-slow") }).catch(() => {}); });
      await mock.route("**/api/task/mock-fast", route => route.fulfill({ json: health("mock-fast") }));
      await query(mocked, "health", "mock-slow"); await query(mocked, "health", "mock-fast");
      await mocked.waitForFunction(() => document.querySelector("#task-observer-content").textContent.includes("mock-fast"));
      await mocked.waitForTimeout(450);
      assert.doesNotMatch(await mocked.locator("#task-observer-content").innerText(), /mock-slow/);
    }, "MOCK");
    await check(name + " keyboard and input invalidation", async () => {
      await page.goto(base + "/investment");
      await page.waitForFunction(() => document.querySelector("#task-observer-content").textContent.includes("HANDOFF_REQUIRED"));
      await page.locator("#task-lookup-id").focus(); await page.keyboard.press("Tab");
      assert.equal(await page.locator("#task-lookup button").evaluate(button => button === document.activeElement), true);
      await page.locator("#horizon").fill("400");
      assert.match(await page.locator("#task-observer-message").innerText(), /旧方案不得/);
    });
    const concurrent = await browser.newContext();
    await concurrent.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    let submissions = 0;
    const held = [];
    await concurrent.route("**/api/health-check/run", async route => {
      submissions++;
      await new Promise(resolve => held.push(resolve));
      try { const original = await route.fetch(); await route.fulfill({ response: original }); } catch { /* Deliberate cancellation. */ }
    });
    const first = await concurrent.newPage(), second = await concurrent.newPage();
    await first.goto(base + "/investment"); await second.goto(base + "/investment");
    await first.locator("#demo-profile").click(); await second.locator("#demo-profile").click();
    await check(name + " duplicate click and multiple tabs", async () => {
      await first.evaluate(() => { document.querySelector("#check-form").requestSubmit(); document.querySelector("#check-form").requestSubmit(); });
      await first.waitForFunction(() => localStorage.getItem("ui-demo-p0-pending-v1") !== null);
      await second.locator("#run").click();
      await second.waitForFunction(() => document.querySelector("#task-observer-message").textContent.includes("另一标签页"));
      assert.equal(submissions, 1);
    });
    await check(name + " cancel, refresh and back keep unknown result", async () => {
      await first.locator("#task-stop-waiting").click();
      await first.waitForFunction(() => document.querySelector("#task-observer-message").textContent.includes("未知"));
      await first.reload();
      assert.match(await first.locator("#task-pending").innerText(), /结果未知/);
      assert.equal(submissions, 1);
      await first.goto(base + "/risk-workbench"); await first.goBack();
      assert.match(await first.locator("#task-pending").innerText(), /结果未知/);
      assert.equal(submissions, 1);
    });
    held.forEach(resolve => resolve());
    await concurrent.close();
    await mock.close(); await context.close(); await browser.close(); browser = null;
  }
  assert.equal(errors.length, 0, JSON.stringify(errors));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  server?.kill();
  fs.writeFileSync(path.join(out, "browser-results.json"), JSON.stringify({ environment: "Windows / loopback / headless desktop; no mobile hardware", network: "External browser requests blocked", results, errors }, null, 2));
  fs.writeFileSync(path.join(out, "main-local-api.json"), JSON.stringify({ layer: "LOCAL_REAL_API", synthetic: true, paid_model_calls: 0, receipts }, null, 2));
  console.log(JSON.stringify({ passed: results.filter(item => item.result === "PASS").length, failed: results.filter(item => item.result === "FAIL").length, errors }));
});
