// Crawler + workflow fusion — pure merge logic (unit-tested; the
// MERGE_ENGAGEMENT background handler is a thin adapter over this).
//
// The two capture layers are complementary by design (digest Part IV: the
// crawler is an ACTIVE visitor, the workflow recorder a PASSIVE watcher of
// logged-in / gated journeys). An engagement that ran both ends up with two
// overlapping finding sets; the deliverable needs ONE deduplicated union
// where every issue says which layer(s) saw it, plus a page-coverage map.
//
// Issue identity is the SAME recipe both layers already use for their own
// dedup: hash(node html + target selector + rule id + normalized page URL)
// — lib/workflow.js issueHash. Using the identical function is what makes
// "crawl finding X" and "workflow finding X" collide when they are the same
// defect on the same page.

import { issueHash, normalizePageUrl } from "./workflow.js";

// Tag every node in a buildReport-shaped page list with its source layer and
// identity hash. Mutates copies, not the inputs.
function tagPages(pages, source, keepParams) {
  return (pages || []).map(p => ({
    ...p,
    violations: tagRules(p.violations, p.url, source, keepParams),
    incomplete: tagRules(p.incomplete, p.url, source, keepParams),
    passes: p.passes || [],
    inapplicable: p.inapplicable || []
  }));
}
function tagRules(rules, pageUrl, source, keepParams) {
  const norm = normalizePageUrl(pageUrl, keepParams);
  return (rules || []).map(r => ({
    ...r,
    nodes: (r.nodes || []).map(n => ({
      ...n,
      euSource: source,
      euHash: issueHash(n.html || "", JSON.stringify(n.target || []), r.ruleId || r.id || "", norm)
    }))
  }));
}

// Merge two buildReport-shaped page lists into ONE deduplicated union.
//
// - Every crawl node is kept, tagged euSource "crawl" — upgraded to "both"
//   when the workflow saw the identical issue.
// - Workflow nodes whose hash the crawl already produced are DROPPED from
//   the workflow page (the crawl copy represents them, as "both") — this is
//   identity dedup, not a cap: every distinct issue survives exactly once.
// - Workflow-only nodes stay, tagged "workflow".
// - Rules whose every node was deduplicated away disappear from that page;
//   pages keep their passes/inapplicable as-is (they don't collide across
//   layers — different URLs list different pass sets, and buildReport
//   handles repetition).
//
// Returns { pages, coverage, counts }:
//   coverage — normalized-URL page map: crawlOnly / workflowOnly / both
//   counts   — { crawl, workflow, both, combined } unique-issue counts
export function mergeEngagementPages(crawlPages, workflowPages, { keepParams = false } = {}) {
  const crawl = tagPages(crawlPages, "crawl", keepParams);
  const workflow = tagPages(workflowPages, "workflow", keepParams);

  // Index every crawl node by hash so workflow collisions can upgrade them.
  const crawlByHash = new Map();
  for (const p of crawl) {
    for (const cat of ["violations", "incomplete"]) {
      for (const r of p[cat]) for (const n of r.nodes) crawlByHash.set(n.euHash, n);
    }
  }

  let bothCount = 0, workflowOnly = 0;
  const dedupedWorkflow = workflow.map(p => {
    const dedupCat = (rules) => rules
      .map(r => ({
        ...r,
        nodes: r.nodes.filter(n => {
          const twin = crawlByHash.get(n.euHash);
          if (twin) { twin.euSource = "both"; bothCount++; return false; }
          workflowOnly++;
          return true;
        })
      }))
      .filter(r => r.nodes.length);
    return { ...p, violations: dedupCat(p.violations), incomplete: dedupCat(p.incomplete) };
  })
  // A workflow page whose every finding deduplicated away STILL counts for
  // coverage (it was journeyed through) — keep the page entry; buildReport
  // handles empty rule arrays.
  ;

  // Page coverage by normalized URL.
  const crawlUrls = new Set(crawl.map(p => normalizePageUrl(p.url, keepParams)));
  const wfUrls = new Set(workflow.map(p => normalizePageUrl(p.url, keepParams)));
  const coverage = { both: [], crawlOnly: [], workflowOnly: [] };
  for (const u of crawlUrls) (wfUrls.has(u) ? coverage.both : coverage.crawlOnly).push(u);
  for (const u of wfUrls) if (!crawlUrls.has(u)) coverage.workflowOnly.push(u);
  coverage.both.sort(); coverage.crawlOnly.sort(); coverage.workflowOnly.sort();

  const crawlCount = crawlByHash.size;
  return {
    pages: [...crawl, ...dedupedWorkflow],
    coverage,
    counts: {
      crawl: crawlCount - bothCount,       // seen by the crawl alone
      workflow: workflowOnly,              // seen by the workflow alone
      both: bothCount,                     // seen by both layers
      combined: crawlCount + workflowOnly  // unique union
    }
  };
}
