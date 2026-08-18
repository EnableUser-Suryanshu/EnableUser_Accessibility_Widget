const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// ── Main engine (package.json's pin — the "latest" the extension ships) ──
const src = path.join(__dirname, "node_modules", "axe-core", "axe.min.js");
const dst = path.join(__dirname, "lib", "axe.min.js");

if (!fs.existsSync(src)) {
  console.error("axe-core not installed. Run `npm install` first.");
  process.exit(1);
}
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log("Copied axe-core →", path.relative(__dirname, dst));

// ── Pinned engine versions (axe DevTools' window.axeVersions mechanism,
// digest II.1: side-by-side engine loading). Regulated clients file audits
// against a SPECIFIC engine version; re-running a filed audit months later
// on a newer axe changes rule behaviour and breaks reproducibility. Each
// pin is vendored into lib/axe-versions/<v>/axe.min.js (committed, so the
// extension needs no npm at runtime) and offered in the Settings "Engine
// version" dropdown; injectAxe injects the selected file. package.json's
// main dependency pin is untouched — pins are fetched with `npm i --no-save
// --prefix` into a throwaway dir and copied out.
const PINNED_VERSIONS = ["4.11.3"];

for (const v of PINNED_VERSIONS) {
  const pinDst = path.join(__dirname, "lib", "axe-versions", v, "axe.min.js");
  if (fs.existsSync(pinDst)) {
    console.log(`Pinned axe-core ${v} already vendored →`, path.relative(__dirname, pinDst));
    continue;
  }
  const tmp = fs.mkdtempSync(path.join(__dirname, ".axe-pin-"));
  try {
    console.log(`Vendoring axe-core ${v} (npm i --no-save --prefix, throwaway dir)…`);
    execFileSync("npm", ["i", "--no-save", "--prefix", tmp, `axe-core@${v}`], { stdio: "inherit" });
    const pinSrc = path.join(tmp, "node_modules", "axe-core", "axe.min.js");
    if (!fs.existsSync(pinSrc)) throw new Error(`axe-core@${v} install produced no axe.min.js`);
    fs.mkdirSync(path.dirname(pinDst), { recursive: true });
    fs.copyFileSync(pinSrc, pinDst);
    const lic = path.join(tmp, "node_modules", "axe-core", "LICENSE");
    if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(path.dirname(pinDst), "LICENSE.txt"));
    console.log(`Vendored axe-core ${v} →`, path.relative(__dirname, pinDst));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
