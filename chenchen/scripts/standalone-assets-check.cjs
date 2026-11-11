"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

// Validate the deployed project subpath, including transitive ES module imports.
function validate(root) {
  root = path.resolve(root);
  const seen = new Set();
  function visit(url) {
    if (url.origin !== "https://example.invalid") return;
    assert.ok(url.pathname.startsWith("/agent/"), "Reference escapes Pages project: " + url.href);
    let file = path.join(root, decodeURIComponent(url.pathname.slice(7)));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    assert.ok(fs.existsSync(file), "Missing artifact: " + url.pathname);
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    let refs = [];
    if (file.endsWith(".html")) refs = [...text.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(m => m[1]);
    if (/\.(?:m?js)$/.test(file)) refs = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)].map(m => m[1]);
    if (file.endsWith(".css")) refs = [...text.matchAll(/url\(["']?([^)'"\s]+)["']?\)/g)].map(m => m[1]);
    for (const ref of refs) {
      if (/^(?:data:|mailto:|#)/.test(ref)) continue;
      visit(new URL(ref, url));
    }
  }
  visit(new URL("https://example.invalid/agent/"));
  return [...seen].map(file => path.relative(root, file));
}
if (require.main === module) console.log(JSON.stringify({ result: "PASS", files: validate(process.argv[2] || "_site") }, null, 2));
module.exports = { validate };
