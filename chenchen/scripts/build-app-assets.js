"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const source = ["app.html", "app.css", "app.js"].map(name => fs.readFileSync(path.join(root, "versions", name), "utf8"));
const output = "// Generated from versions/app.html, app.css and app.js. Run npm run build:app.\n" +
  ["appHtml", "appCss", "appJs"].map((name, index) => `export const ${name} = ${JSON.stringify(source[index])};\n`).join("");
const target = path.join(root, "deployment", "app-assets.js");
if (process.argv.includes("--check")) {
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== output) {
    console.error("Staging app assets are stale; run npm run build:app.");
    process.exitCode = 1;
  }
} else fs.writeFileSync(target, output);
