// Unit tests for lib/engagement-merge.js — the crawl+workflow fusion:
// identical issues collide across layers (source "both"), layer-unique
// issues survive tagged, nothing is dropped, and page coverage is computed
// on normalized URLs.
import { mergeEngagementPages } from "../lib/engagement-merge.js";
import { issueHash } from "../lib/workflow.js";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS " : "FAIL "} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

const rule = (ruleId, nodes) => ({ ruleId, impact: "serious", description: ruleId, help: "", tags: [], nodes });
const node = (html, sel) => ({ html, target: [sel], impact: "serious", failureSummary: "", any: [], all: [], none: [] });

const crawlPages = [
  {
    url: "https://x.test/a",
    title: "A", violations: [
      rule("image-alt", [node("<img src=1>", "#i1"), node("<img src=2>", "#i2")]),
      rule("label", [node("<input id=q>", "#q")])
    ],
    incomplete: [rule("color-contrast", [node("<p id=c>", "#c")])],
    passes: [], inapplicable: []
  },
  { url: "https://x.test/crawl-only", title: "C", violations: [rule("label", [node("<select>", "#s")])], incomplete: [], passes: [], inapplicable: [] }
];
const workflowPages = [
  {
    // Same page, same first issue (identical html+target+rule), plus one new.
    url: "https://x.test/a?utm=track",  // normalizes to /a — must collide
    title: "A", violations: [
      rule("image-alt", [node("<img src=1>", "#i1"), node("<img src=3>", "#i3")])
    ],
    incomplete: [rule("color-contrast", [node("<p id=c>", "#c")])],
    passes: [], inapplicable: []
  },
  { url: "https://x.test/gated", title: "G", violations: [rule("label", [node("<input id=pw>", "#pw")])], incomplete: [], passes: [], inapplicable: [] }
];

const m = mergeEngagementPages(crawlPages, workflowPages);

// Counts: crawl uniques = i1,i2,q,c,s (5); workflow brings i1(dup), i3(new),
// c(dup), pw(new) → both=2, workflowOnly=2, crawlOnly=3, combined=7.
check("both-count: identical issues collide across layers", m.counts.both === 2, `both=${m.counts.both}`);
check("workflow-only issues survive", m.counts.workflow === 2, `workflow=${m.counts.workflow}`);
check("crawl-only issues survive", m.counts.crawl === 3, `crawl=${m.counts.crawl}`);
check("combined = unique union (nothing dropped, nothing doubled)", m.counts.combined === 7, `combined=${m.counts.combined}`);

// The crawl copy of a collided issue is tagged "both".
const crawlA = m.pages.find(p => p.url === "https://x.test/a");
const i1 = crawlA.violations.find(r => r.ruleId === "image-alt").nodes.find(n => n.target[0] === "#i1");
check("collided crawl node upgraded to source both", i1.euSource === "both");
const i2 = crawlA.violations.find(r => r.ruleId === "image-alt").nodes.find(n => n.target[0] === "#i2");
check("crawl-only node stays source crawl", i2.euSource === "crawl");

// The workflow page keeps ONLY its unique node; the dup was dropped there.
const wfA = m.pages.find(p => p.url === "https://x.test/a?utm=track");
const wfImgNodes = wfA.violations.find(r => r.ruleId === "image-alt").nodes;
check("workflow page keeps only its unique nodes", wfImgNodes.length === 1 && wfImgNodes[0].target[0] === "#i3" && wfImgNodes[0].euSource === "workflow");
check("collided incomplete dropped from workflow page (rule removed when empty)", wfA.incomplete.length === 0);

// URL normalization drives the collision: same recipe as the session dedup.
const h1 = issueHash("<img src=1>", JSON.stringify(["#i1"]), "image-alt", "https://x.test/a");
check("identity hash matches lib/workflow.js recipe", i1.euHash === h1);

// Coverage on normalized URLs.
check("coverage.both", m.coverage.both.length === 1 && m.coverage.both[0] === "https://x.test/a", m.coverage.both.join(","));
check("coverage.crawlOnly", m.coverage.crawlOnly.length === 1 && m.coverage.crawlOnly[0] === "https://x.test/crawl-only");
check("coverage.workflowOnly", m.coverage.workflowOnly.length === 1 && m.coverage.workflowOnly[0] === "https://x.test/gated");

// Empty inputs behave.
const empty = mergeEngagementPages([], []);
check("empty merge yields empty union", empty.pages.length === 0 && empty.counts.combined === 0);
const oneSided = mergeEngagementPages(crawlPages, []);
check("crawl-only merge keeps everything as crawl", oneSided.counts.combined === 5 && oneSided.counts.both === 0);

// Inputs are not mutated (background reuses the stored inventory).
check("input pages not mutated", crawlPages[0].violations[0].nodes[0].euSource === undefined && crawlPages[0].violations[0].nodes[0].euHash === undefined);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
