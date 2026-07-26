// Pins the limits that are meant to be absent, and the ones that must agree
// across files. Run:  node test/limits.test.mjs
//
// Two classes of bug this catches:
//
// 1. A finding cap creeping back in. Every cap removed in v0.5.1 was silent —
//    a truncated audit rendered identically to a complete one, so the client
//    fixed 25 issues, re-scanned, and 25 more appeared. Nothing in the report
//    said anything had been dropped. If one is ever reinstated it must be
//    deliberate and must report truncation, not reappear as a magic number.
//
// 2. DEFAULT_MAX_URLS drifting apart again. It was 50 in background.js while
//    popup.js and popup.html both said 500, so a scan crawled either 50 or 500
//    pages depending on which supplied the value.

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const R = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(R, p), "utf8");

// Strip comments before asserting on code. The removals below are documented in
// comments that necessarily quote the old constant names and expressions, so a
// naive text search matches the explanation of a removal as though the cap were
// still there. Crude but adequate here: these files contain no regex or string
// literal holding "//" or "/*".
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map(l => l.replace(/(^|\s)\/\/.*$/, "$1"))
  .join("\n");

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// ── DEFAULT_MAX_URLS must agree in all three places ──
const bg = code(read("background.js"));
const popupJs = read("popup/popup.js");
const popupHtml = read("popup/popup.html");

const bgDefault = bg.match(/^const DEFAULT_MAX_URLS = (\d+);/m)?.[1];
const popupDefault = popupJs.match(/^const DEFAULT_MAX_URLS = (\d+);/m)?.[1];
const htmlDefault = popupHtml.match(/id="opt-max-urls"[^>]*value="(\d+)"/)?.[1];

check("DEFAULT_MAX_URLS found in all three files",
  bgDefault && popupDefault && htmlDefault,
  `background=${bgDefault} popup.js=${popupDefault} popup.html=${htmlDefault}`);
check("DEFAULT_MAX_URLS agrees across background.js, popup.js and popup.html",
  bgDefault === popupDefault && popupDefault === htmlDefault,
  `background=${bgDefault} popup.js=${popupDefault} popup.html=${htmlDefault}`);

// ── Finding caps must stay unbounded ──
const visual = code(read("lib/visual-checks.js"));
const xlsx = code(read("lib/xlsx-writer.js"));

for (const [file, src, name] of [
  ["lib/visual-checks.js", visual, "MAX_LINKS_ANALYZED"],
  ["lib/visual-checks.js", visual, "MAX_NODES_PER_RULE"],
  ["lib/xlsx-writer.js", xlsx, "MAX_ISSUE_SHOTS"]
]) {
  const m = src.match(new RegExp(`const ${name} = ([^;]+);`));
  check(`${name} is unbounded in ${file}`, m && m[1].trim() === "Infinity",
    m ? m[1].trim() : "not found");
}

check("MAX_ELEMENT_SHOTS_PER_PAGE is gone from background.js",
  !/MAX_ELEMENT_SHOTS_PER_PAGE/.test(bg));
check("element shots are bounded by time, not count",
  /ELEMENT_SHOTS_BUDGET_MS/.test(bg) && /shotsDeadline/.test(bg));
check("element-shot budget exhaustion is reported, not silent",
  /skippedForBudget/.test(bg) && /budget exhausted/.test(bg));

// The specific inline slices/counters that used to truncate findings.
const goneFromVisual = [
  [/anchors\.slice\(0, *100\)/, "hover-cue sample capped at 100 anchors"],
  [/seen >= *150/, "boundary-contrast controls capped at 150"],
  [/\+\+n > *600/, "text-spacing sample capped at 600 elements"],
  [/MOTION_SEL\)\][^;]*\.slice\(0, *10\)/, "motion candidates capped at 10"]
];
for (const [re, what] of goneFromVisual) {
  check(`removed: ${what}`, !re.test(visual));
}

// ── Deliberate safety limits must NOT have been removed ──
// These bound resources rather than findings; dropping them would be a bug.
for (const [name, src, file] of [
  ["CONCURRENT_TABS", bg, "background.js"],
  ["PER_ORIGIN_TABS", bg, "background.js"],
  ["ERROR_STREAK_LIMIT", bg, "background.js"],
  ["WORKER_HARD_TIMEOUT_MS", bg, "background.js"],
  ["CELL_MAX_LEN", xlsx, "lib/xlsx-writer.js"]
]) {
  check(`safety limit ${name} still present in ${file}`, new RegExp(`\\b${name}\\b`).test(src));
}

console.log(`\n${failures === 0 ? "all checks passed" : failures + " check(s) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
