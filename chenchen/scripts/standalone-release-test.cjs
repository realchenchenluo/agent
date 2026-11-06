"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { validate } = require("./standalone-assets-check.cjs");
const root = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/deploy-standalone-sites.yml"), "utf8").replace(/\r\n/g, "\n");
const block = workflow.split("        run: |\n")[1].split("\n      - name:")[0].split("\n").map(line => line.slice(10)).join("\n");
const bash = process.env.BASH_EXE || (process.platform === "win32" ? "C:/AI AGENT/git/Git/bin/bash.exe" : "bash");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-release-"));
for (const dir of ["holdings-intake/site", "fund-market-analysis/site", "versions", "data"]) {
  fs.cpSync(path.join(root, "chenchen", dir), path.join(temp, "chenchen", dir), { recursive: true });
}
fs.writeFileSync(path.join(temp, "assemble.sh"), block);
const run = spawnSync(bash, ["assemble.sh"], { cwd: temp, encoding: "utf8", windowsHide: true });
assert.equal(run.status, 0, run.stderr || run.error?.message);
const site = path.join(temp, "_site");
const files = validate(site);
for (const file of ["task-state.mjs", "task-client.mjs", "task-view.mjs", "task-view.css"]) assert.ok(workflow.includes('"chenchen/versions/' + file + '"'), "Missing paths trigger: " + file);
if (fs.existsSync(path.join(site, "risk-workbench/task-view.mjs"))) {
  for (const file of ["task-state.mjs", "task-client.mjs", "task-view.mjs", "task-view.css"]) {
    const target = path.join(site, "risk-workbench", file), content = fs.readFileSync(target);
    fs.unlinkSync(target);
    assert.throws(() => validate(site), /Missing artifact/);
    fs.writeFileSync(target, content);
  }
}
console.log(JSON.stringify({ result: "PASS", layer: "LOCAL_STATIC_BUILD", artifact: site, files }, null, 2));
