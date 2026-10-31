"use strict";
const path = require("node:path"), fs = require("node:fs"), { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const out = path.resolve(root, "../review/ui-demo-p0-artifacts/video");
fs.mkdirSync(out, { recursive: true });
let browser;
const server = spawn(process.execPath, ["-e", 'const {server}=require("./server");server.listen(0,"127.0.0.1",()=>console.log(server.address().port));'], {
  cwd: root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true
});
async function main() {
  const base = await new Promise((resolve, reject) => { server.stdout.once("data", value => resolve("http://127.0.0.1:" + Number(value))); server.once("error", reject); });
  browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: out, size: { width: 1280, height: 800 } } });
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(base + "/investment"); await page.waitForTimeout(1500);
  await page.locator("#demo-profile").click(); await page.waitForTimeout(800); await page.locator("#run").click();
  await page.locator("#results").waitFor({ state: "visible" }); await page.locator("#task-observer").scrollIntoViewIfNeeded(); await page.waitForTimeout(2500);
  await page.locator("#task-observer-content details").first().click(); await page.waitForTimeout(1500);
  await page.reload(); await page.waitForFunction(() => document.querySelector("#task-observer-content").textContent.includes("HANDOFF_REQUIRED")); await page.waitForTimeout(1500);
  await page.goto(base + "/risk-workbench"); await page.waitForTimeout(1800);
  const video = page.video(); await context.close();
  const source = await video.path(), target = path.join(out, "main-local-no-go.webm");
  fs.renameSync(source, target); console.log(JSON.stringify({ result: "RECORDED", path: target, layer: "LOCAL_REAL_API", full_demo: "NO-GO", mobile_hardware: "UNVERIFIED" }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.kill(); });
