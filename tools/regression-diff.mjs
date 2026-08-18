#!/usr/bin/env node
// Session regression diffing — compare two report JSON exports (the report
// page's "Download JSON" button) by issue identity and answer the retest
// question: what got FIXED, what is STILL PRESENT, what is NEW.
//
// Identity is the same recipe every dedup layer in this codebase uses —
// lib/workflow.js issueHash(html + target + ruleId + normalizedPageUrl) —
// so a finding "moves" between reports only if the page genuinely changed
// (same defect re-rendered with different markup counts as fixed+new, which
// is the honest reading: the original filed finding no longer reproduces).
//
// Usage: node tools/regression-diff.mjs <oldReport.json> <newReport.json> [outdir]
// Writes <outdir>/regression-diff.md (human summary) and
//        <outdir>/regression-diff.json (machine findings). outdir defaults
// to the new report's directory.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { issueHash, normalizePageUrl } from "../lib/workflow.js";

// Hash one issueRows row. Rows carry html_snippet / target_array / rule_id /
// url — exactly the fields the live dedup hashes at scan time.
export function rowHash(row) {
  return issueHash(
    row.html_snippet || "",
    JSON.stringify(row.target_array || (row.selector ? [row.selector] : [])),
    row.rule_id || "",
    normalizePageUrl(row.url || "")
  );
}

// Pure diff. Rows = report.issueRows arrays (one row per node×criterion —
// rows sharing a hash are ONE issue seen through several criteria, so both
// sides dedupe by hash first; the row kept is the first occurrence).
// Returns { fixed, stillPresent, new, perRule, perPage, counts }.
export function diffReports(oldRows, newRows) {
  const oldByHash = new Map();
  for (const r of oldRows || []) if (!oldByHash.has(rowHash(r))) oldByHash.set(rowHash(r), r);
  const newByHash = new Map();
  for (const r of newRows || []) if (!newByHash.has(rowHash(r))) newByHash.set(rowHash(r), r);

  const fixed = [], stillPresent = [], added = [];
  for (const [h, r] of oldByHash) (newByHash.has(h) ? stillPresent : fixed).push({ hash: h, ...pick(r) });
  for (const [h, r] of newByHash) if (!oldByHash.has(h)) added.push({ hash: h, ...pick(r) });

  const tally = (list, key) => {
    const m = new Map();
    for (const r of list) m.set(r[key] || "(none)", (m.get(r[key] || "(none)") || 0) + 1);
    return m;
  };
  const perRule = {};
  for (const [name, list] of [["fixed", fixed], ["stillPresent", stillPresent], ["new", added]]) {
    for (const [ruleId, n] of tally(list, "rule_id")) {
      perRule[ruleId] = perRule[ruleId] || { fixed: 0, stillPresent: 0, new: 0 };
      perRule[ruleId][name] = n;
    }
  }
  const perPage = {};
  for (const [name, list] of [["fixed", fixed], ["stillPresent", stillPresent], ["new", added]]) {
    for (const [url, n] of tally(list.map(r => ({ page: normalizePageUrl(r.url || "") })), "page")) {
      perPage[url] = perPage[url] || { fixed: 0, stillPresent: 0, new: 0 };
      perPage[url][name] = n;
    }
  }
  return {
    fixed, stillPresent, new: added, perRule, perPage,
    counts: { old: oldByHash.size, new: newByHash.size, fixed: fixed.length, stillPresent: stillPresent.length, newIssues: added.length }
  };
}

function pick(r) {
  return {
    url: r.url || "", rule_id: r.rule_id || "", impact: r.impact || "",
    selector: r.selector || "", html_snippet: r.html_snippet || "",
    failure_summary: r.failure_summary || "", wcag_criterion: r.wcag_criterion || ""
  };
}

function markdown(diff, oldMeta, newMeta) {
  const c = diff.counts;
  const lines = [
    `# Regression diff`,
    ``,
    `| | Report |`,
    `|---|---|`,
    `| Baseline | ${oldMeta?.seedUrl || "?"} — generated ${oldMeta?.generatedAt || "?"} (${c.old} unique issue(s)) |`,
    `| Retest | ${newMeta?.seedUrl || "?"} — generated ${newMeta?.generatedAt || "?"} (${c.new} unique issue(s)) |`,
    ``,
    `**${c.fixed} fixed · ${c.stillPresent} still present · ${c.newIssues} new.**`,
    `Identity = hash(node html + selector + rule id + normalized page URL) — the same recipe the live dedup uses; a defect re-rendered with different markup reads as fixed+new because the originally filed finding no longer reproduces.`,
    ``,
    `## Per rule`,
    `| Rule | Fixed | Still present | New |`,
    `|---|---:|---:|---:|`,
    ...Object.entries(diff.perRule)
      .sort((a, b) => (b[1].stillPresent + b[1].new) - (a[1].stillPresent + a[1].new))
      .map(([r, t]) => `| ${r} | ${t.fixed} | ${t.stillPresent} | ${t.new} |`),
    ``,
    `## Per page`,
    `| Page | Fixed | Still present | New |`,
    `|---|---:|---:|---:|`,
    ...Object.entries(diff.perPage)
      .sort((a, b) => (b[1].stillPresent + b[1].new) - (a[1].stillPresent + a[1].new))
      .map(([u, t]) => `| ${u} | ${t.fixed} | ${t.stillPresent} | ${t.new} |`),
    ``,
    `## New issues`,
    ...(diff.new.length ? diff.new.map(r => `- **${r.rule_id}** (${r.impact}) ${r.url} — \`${r.selector}\``) : ["(none)"]),
    ``,
    `## Fixed issues`,
    ...(diff.fixed.length ? diff.fixed.map(r => `- **${r.rule_id}** (${r.impact}) ${r.url} — \`${r.selector}\``) : ["(none)"]),
    ``
  ];
  return lines.join("\n");
}

// CLI — only runs when invoked directly (the unit test imports the exports).
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] || "").endsWith("regression-diff.mjs")) {
  const [oldPath, newPath, outdirArg] = process.argv.slice(2);
  if (!oldPath || !newPath) {
    console.error("usage: node tools/regression-diff.mjs <oldReport.json> <newReport.json> [outdir]");
    process.exit(1);
  }
  const oldReport = JSON.parse(readFileSync(oldPath, "utf8"));
  const newReport = JSON.parse(readFileSync(newPath, "utf8"));
  const diff = diffReports(oldReport.issueRows || [], newReport.issueRows || []);
  const outdir = resolve(outdirArg || dirname(resolve(newPath)));
  const mdPath = join(outdir, "regression-diff.md");
  const jsonPath = join(outdir, "regression-diff.json");
  writeFileSync(mdPath, markdown(diff, oldReport.meta, newReport.meta));
  writeFileSync(jsonPath, JSON.stringify({
    baseline: { path: oldPath, meta: oldReport.meta || null },
    retest: { path: newPath, meta: newReport.meta || null },
    ...diff
  }, null, 2));
  const c = diff.counts;
  console.log(`${c.fixed} fixed, ${c.stillPresent} still present, ${c.newIssues} new (baseline ${c.old} → retest ${c.new} unique issues)`);
  console.log(`→ ${mdPath}\n→ ${jsonPath}`);
}
