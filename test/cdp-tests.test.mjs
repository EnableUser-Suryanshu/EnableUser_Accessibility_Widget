// Unit tests for lib/cdp-tests.js — the transport-injected guided-test
// logic: focus-style diffing (the axe isInvisiblePropChange idea), the
// keyboard walk (cycle detection, trap guard, escape recovery), and the
// findings assembly honesty split (provable → violations, judgment →
// review-tagged incomplete).
import { focusDiffVisible, keyboardWalk, guidedResultsToPage, TRAP_SAME_COUNT } from "../lib/cdp-tests.js";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS " : "FAIL "} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

// ── focusDiffVisible ─────────────────────────────────────────────────────
const base = {
  "outline-width": "0px", "outline-style": "none", "outline-color": "rgb(0, 0, 0)", "outline-offset": "0px",
  "box-shadow": "none",
  "border-top-width": "0px", "border-top-style": "none", "border-top-color": "rgb(0, 0, 0)",
  "border-right-width": "0px", "border-right-style": "none", "border-right-color": "rgb(0, 0, 0)",
  "border-bottom-width": "0px", "border-bottom-style": "none", "border-bottom-color": "rgb(0, 0, 0)",
  "border-left-width": "0px", "border-left-style": "none", "border-left-color": "rgb(0, 0, 0)",
  "background-color": "rgb(255, 255, 255)", "color": "rgb(0, 0, 0)", "text-decoration-line": "none"
};
{
  const focused = { ...base, "outline-width": "2px", "outline-style": "auto", "outline-color": "rgb(0, 95, 204)" };
  const d = focusDiffVisible(base, focused);
  check("outline appearing on focus is visible", d.visible && d.changes.some(c => c.prop === "outline"));
}
{
  // Browser-default ring shape (outline-style: auto) counts as visible.
  const focused = { ...base, "outline-width": "1px", "outline-style": "auto" };
  check("UA default focus ring (style:auto) is visible", focusDiffVisible(base, focused).visible);
}
{
  // outline-color change while width stays 0 — cannot be seen.
  const focused = { ...base, "outline-color": "rgb(255, 0, 0)" };
  check("outline-color change under 0 width is INVISIBLE", !focusDiffVisible(base, focused).visible);
}
{
  const focused = { ...base, "box-shadow": "rgb(0, 95, 204) 0px 0px 0px 3px" };
  check("box-shadow appearing is visible", focusDiffVisible(base, focused).visible);
}
{
  // border-color change under 0-width border — invisible.
  const focused = { ...base, "border-top-color": "rgb(255, 0, 0)" };
  check("border-color change under 0 width is INVISIBLE", !focusDiffVisible(base, focused).visible);
}
{
  const withBorder = { ...base, "border-top-width": "1px", "border-top-style": "solid" };
  const focused = { ...withBorder, "border-top-color": "rgb(255, 0, 0)" };
  check("border-color change on a painted border is visible", focusDiffVisible(withBorder, focused).visible);
}
{
  const focused = { ...base, "background-color": "rgb(230, 240, 255)" };
  check("background-color change is visible", focusDiffVisible(base, focused).visible);
}
check("identical styles are invisible", !focusDiffVisible(base, { ...base }).visible);

// ── keyboardWalk (scripted transports) ───────────────────────────────────
// Fake page: a script of activeElement values; `same` is identity vs the
// previous read, exactly like the in-page tracker.
function fakeTransports(script) {
  let i = -1, last = null;
  const presses = [];
  return {
    presses,
    pressKey: async (k) => { presses.push(k); },
    readActiveElement: async () => {
      i = Math.min(i + 1, script.length - 1);
      const cur = script[i];
      const same = cur === last;
      last = cur;
      if (cur === null) return null;
      return { tag: "x", selector: cur, html: `<x id="${cur}">`, isBody: cur === "body", same };
    },
    wait: async () => {}
  };
}
{
  const t = fakeTransports(["a", "b", "c", "a"]);
  const w = await keyboardWalk(t);
  check("walk records stops until the cycle closes", w.stops.length === 3 && w.cycled && !w.trapped,
    w.stops.map(s => s.selector).join(","));
}
{
  // Same element for TRAP_SAME_COUNT consecutive reads → trap; Escape+Tab
  // frees focus → walk continues, trap recorded as escaped.
  const t = fakeTransports(["a", "b", "b", "b", "c", "a"]);
  const w = await keyboardWalk(t);
  check("trap detected after 3 same-focus Tabs", w.findings.length === 1 && w.findings[0].selector === "b");
  check("escape freed the trap and the walk continued", w.findings[0].escaped === true && w.stops.some(s => s.selector === "c") && w.cycled);
  check("escape was actually pressed", t.presses.includes("Escape"));
}
{
  // Escape does NOT free focus → walk stops, trapped flag set.
  const t = fakeTransports(["a", "b", "b", "b", "b", "b"]);
  const w = await keyboardWalk(t);
  check("unescapable trap stops the walk", w.trapped === true && w.findings.length === 1 && w.findings[0].escaped === false);
}
{
  // Focus falling back to body after real stops = cycle end, not a stop.
  const t = fakeTransports(["a", "b", "body"]);
  const w = await keyboardWalk(t);
  check("return to body ends the walk", w.cycled && w.stops.length === 2);
}
{
  // Page death mid-walk (readActiveElement → null) ends cleanly.
  const t = fakeTransports(["a", null]);
  const w = await keyboardWalk(t);
  check("null read ends the walk without throwing", w.stops.length === 1 && !w.cycled && !w.trapped);
}
check("TRAP_SAME_COUNT is 3 (the spec'd guard)", TRAP_SAME_COUNT === 3);

// ── guidedResultsToPage (honesty split) ──────────────────────────────────
{
  const page = guidedResultsToPage({
    url: "https://x.test/", title: "X",
    keyboard: {
      stops: [
        { index: 1, tag: "a", selector: "#ok", html: "<a id=ok>", focusCheck: { checked: true, visible: true, changes: [{ prop: "outline", from: "(none)", to: "2px auto" }] } },
        { index: 2, tag: "button", selector: "#bad", html: "<button id=bad>", focusCheck: { checked: true, visible: false, changes: [] } },
        { index: 3, tag: "div", selector: "#shadow", html: "<div>", focusCheck: { checked: false, reason: "unresolved" } }
      ],
      findings: [{ ruleId: "eu-keyboard-trap", selector: "#trap", html: "<input id=trap>", escaped: false }],
      trapped: true, cycled: false
    },
    reflow: {
      horizontalScroll: true, scrollWidth: 620, clientWidth: 320,
      offenders: [{ selector: "#wide", width: 600, html: "<div id=wide>" }]
    }
  });
  const vRules = page.violations.map(r => r.ruleId);
  const iRules = page.incomplete.map(r => r.ruleId);
  check("focus-not-visible is a VIOLATION (provable)", vRules.includes("eu-focus-not-visible"));
  check("reflow horizontal scroll is a VIOLATION (provable)", vRules.includes("eu-reflow-horizontal-scroll"));
  check("keyboard trap is INCOMPLETE (judgment)", iRules.includes("eu-keyboard-trap") && !vRules.includes("eu-keyboard-trap"));
  const trap = page.incomplete.find(r => r.ruleId === "eu-keyboard-trap");
  check("trap rule is review-tagged", (trap.tags || []).includes("review"));
  const nf = page.violations.find(r => r.ruleId === "eu-focus-not-visible");
  check("only the checked-invisible stop becomes a node (unresolved stops never fail)",
    nf.nodes.length === 1 && nf.nodes[0].target[0] === "#bad");
  const rf = page.violations.find(r => r.ruleId === "eu-reflow-horizontal-scroll");
  check("reflow offenders become nodes", rf.nodes.length === 1 && rf.nodes[0].target[0] === "#wide");
}
{
  const page = guidedResultsToPage({ url: "https://x.test/", title: "X", keyboard: { stops: [{ index: 1, selector: "#a", focusCheck: { checked: true, visible: true } }], findings: [], trapped: false, cycled: true }, reflow: { horizontalScroll: false, scrollWidth: 320, clientWidth: 320, offenders: [] } });
  check("clean run produces zero findings", page.violations.length === 0 && page.incomplete.length === 0);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
