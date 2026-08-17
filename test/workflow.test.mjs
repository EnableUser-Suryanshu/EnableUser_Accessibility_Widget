// Pins the workflow-session invariants that the whole feature's correctness
// rests on. Run:  node test/workflow.test.mjs
//
// The three mechanisms under test come from the competitor forensics
// (_Workroom/2026-08-17_extension-mechanism-digest) and losing any of them
// silently breaks the product promise:
//
// 1. Page identity ignores query/fragment — otherwise tracking params turn
//    one page into fifty and the report's page count is fiction.
// 2. The step-reuse rule — consecutive DOM-change bursts on one page must
//    collapse into ONE step, or an animated page produces a thousand-row
//    timeline.
// 3. Issue-hash dedup — a violation re-found by a later scan of the same
//    page must count exactly once, or every re-scan doubles the numbers.

import {
  normalizePageUrl, issueHash, newSession, recordPage, openScanStep,
  recordClick, ingestScan, seenSetFrom, storeSeenSet, STEP_ACTIONS, MAX_STEPS,
  activitySignature
} from "../lib/workflow.js";

let failures = 0;
const check = (name, cond) => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
};

// ── 1. URL normalization ──────────────────────────────────────────────────
check("query stripped", normalizePageUrl("https://x.com/p?utm=1") === "https://x.com/p");
check("fragment stripped", normalizePageUrl("https://x.com/p#top") === "https://x.com/p");
check("keepParams honoured", normalizePageUrl("https://x.com/p?a=1", true) === "https://x.com/p?a=1");

const s = newSession({ tabId: 1, testId: "t", seedUrl: "https://x.com/", seedTitle: "X", profile: "wcag21aa", settings: {} });
const p1 = recordPage(s, "https://x.com/?utm=a", "Home");
const p1b = recordPage(s, "https://x.com/#hero", "Home");
check("same page for query/hash variants", p1.pageId === p1b.pageId && s.pages.length === 1);
const p2 = recordPage(s, "https://x.com/checkout", "Checkout");
check("new page on path change", p2.pageId !== p1.pageId && s.pages.length === 2);

// ── 2. Step-reuse rule ────────────────────────────────────────────────────
const full = openScanStep(s, STEP_ACTIONS.FULL_SCAN, p2);
const sc1 = openScanStep(s, STEP_ACTIONS.STATE_CHANGE, p2);
const sc2 = openScanStep(s, STEP_ACTIONS.STATE_CHANGE, p2);
check("state-change after full scan opens a new step", sc1.stepId !== full.stepId);
check("consecutive state-changes on one page reuse the step", sc2.stepId === sc1.stepId);
recordClick(s, p2, { tag: "button", text: "Pay now", selector: "button.pay" });
const sc3 = openScanStep(s, STEP_ACTIONS.STATE_CHANGE, p2);
check("a click breaks the reuse chain", sc3.stepId !== sc1.stepId);
const p3 = recordPage(s, "https://x.com/done", "Done");
const sc4 = openScanStep(s, STEP_ACTIONS.STATE_CHANGE, p3);
check("page change breaks the reuse chain", sc4.stepId !== sc3.stepId);

// ── 3. Issue-hash dedup across scans ─────────────────────────────────────
const payload = (n) => ({
  violations: [{ ruleId: "color-contrast", nodes: [{ html: `<p id="${n}">x</p>`, target: [`#${n}`] }] }],
  incomplete: [], passes: [{ ruleId: "document-title", nodes: [] }], inapplicable: []
});
const seen = seenSetFrom(s);
const r1 = ingestScan(s, sc4, payload("a"), p3.url, seen);
const r2 = ingestScan(s, sc4, payload("a"), p3.url, seen);   // identical re-find
const r3 = ingestScan(s, sc4, payload("b"), p3.url, seen);   // genuinely new node
storeSeenSet(s, seen);
check("first find counts", r1.newIssues === 1 && r1.suppressed === 0);
check("identical re-find suppressed", r2.newIssues === 0 && r2.suppressed === 1);
check("new node still counts", r3.newIssues === 1);
check("counters aggregate", s.counts.newIssues === 2 && s.counts.suppressedDuplicates === 1);
check("hash set round-trips", seenSetFrom(s).size === 2);
check("passes kept only on first scan of page",
  s.resultsPages.filter(p => p.url === p3.url && (p.passes || []).length).length === 1);

// same node on a DIFFERENT page is a different issue (per-page identity)
const p4 = recordPage(s, "https://x.com/other", "Other");
const sc5 = openScanStep(s, STEP_ACTIONS.STATE_CHANGE, p4);
const seen2 = seenSetFrom(s);
const r4 = ingestScan(s, sc5, payload("a"), p4.url, seen2);
check("same node on another page counts separately", r4.newIssues === 1);
check("issueHash is page-scoped",
  issueHash("<p>x</p>", '["#a"]', "r", "https://x.com/1") !== issueHash("<p>x</p>", '["#a"]', "r", "https://x.com/2"));

// ── 4. No step cap (repo rule: finding caps must not exist) ──────────────
check("MAX_STEPS is Infinity — sessions are unbounded", MAX_STEPS === Infinity);
const s2 = newSession({ tabId: 2, testId: "t2", seedUrl: "https://y.com/", profile: "wcag21aa", settings: {} });
const pg = recordPage(s2, "https://y.com/", "Y");
for (let i = 0; i < 500; i++) recordClick(s2, pg, { tag: "a", text: String(i) });
check("500 steps recorded without a limit trip", s2.steps.length === 500 && s2.limitReached === false);
check("scan steps still open past any former cap", openScanStep(s2, STEP_ACTIONS.STATE_CHANGE, pg) !== null);

// ── 5. Click metadata (BrowserStack's step-object fields) ────────────────
const s3 = newSession({ tabId: 3, testId: "t3", seedUrl: "https://z.com/", profile: "wcag21aa", settings: {} });
const pg3 = recordPage(s3, "https://z.com/", "Z");
const clk = recordClick(s3, pg3, {
  tag: "a", text: "Docs", selector: "a.docs",
  coordinates: { x: 10, y: 20 }, value: "search term", href: "https://z.com/docs"
});
check("click stores coordinates", clk.coordinates?.x === 10 && clk.coordinates?.y === 20);
check("click stores value", clk.value === "search term");
check("click stores href", clk.href === "https://z.com/docs");
check("value truncated to 80", recordClick(s3, pg3, { tag: "input", value: "x".repeat(200) }).value.length === 80);
const bare = recordClick(s3, pg3, { tag: "button", text: "Go" });
check("absent metadata adds no fields", !("coordinates" in bare) && !("value" in bare) && !("href" in bare));

// ── 6. Activity-mode snapshot signature (scanOnUserActivity) ─────────────
// The injected observer's inline copy must detect exactly what this pure
// twin detects: a structural change OR a serialized-length change flips the
// signature; identical snapshots compare equal (no false re-scans).
const sigA = activitySignature(["DIV", "P", "SPAN"], 1234);
check("signature stable for identical snapshot", sigA === activitySignature(["DIV", "P", "SPAN"], 1234));
check("signature changes when tag structure changes", sigA !== activitySignature(["DIV", "P", "A"], 1234));
check("signature changes when an element is added", sigA !== activitySignature(["DIV", "P", "SPAN", "SPAN"], 1234));
check("signature changes when content length changes", sigA !== activitySignature(["DIV", "P", "SPAN"], 1235));
check("empty page yields a signature too", typeof activitySignature([], 0) === "string" && activitySignature([], 0).length > 0);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall workflow invariants hold");
