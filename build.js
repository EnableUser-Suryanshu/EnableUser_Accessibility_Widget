const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "node_modules", "axe-core", "axe.min.js");
const dst = path.join(__dirname, "lib", "axe.min.js");

if (!fs.existsSync(src)) {
  console.error("axe-core not installed. Run `npm install` first.");
  process.exit(1);
}
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log("Copied axe-core →", path.relative(__dirname, dst));
