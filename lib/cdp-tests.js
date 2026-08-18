// Guided tests — the CDP layer (Phase C). Mechanism mirrored from the axe
// DevTools BackgroundRecorder (digest Part II.4): trusted Tab injection via
// Input.dispatchKeyEvent for the tab-stop walk + trap detection (Manual
// Checklist K-05/K-06), CSS.forcePseudoState + computed-style diffing for
// focus-indicator ground truth (K-02/C-09 — upgrades the CSSOM-guessing
// visual-checks layer to what the browser ACTUALLY renders), and
// Emulation.setDeviceMetricsOverride for the 320 px reflow check (Z-04/Z-05,
// WCAG 1.4.10's normative width).
//
// Honesty rules (repo-wide): findings whose failure is PROVED land as
// violations — a focus indicator that produces zero visible computed-style
// change under a forced :focus/:focus-visible state is a fact, and so is a
// horizontal scrollbar at 320 px. Findings that need judgment (is this
// keyboard trap intentional? is the widget's own Escape handling adequate?)
// are review-tagged and land in Incomplete.
//
// Everything here takes its transports as arguments (sendCommand /
// readActiveElement / pressKey / …) so the walk, trap detection, and
// style-diff logic are pure enough to unit-test with scripted fakes; the
// chrome.debugger adapters live in background.js.

// axe's constant: spacing between injected Tab presses.
export const TAB_SPACING_MS = 200;
// Same element still focused after this many consecutive Tabs → trap.
export const TRAP_SAME_COUNT = 3;

// ── Focus-style diffing (3b) ─────────────────────────────────────────────
// The computed-style properties that can express a visible focus indicator.
// axe's isInvisiblePropChange idea: a property change that cannot be SEEN
// (outline-color changing while outline-width is 0, box-shadow "none" on
// both sides, border-color changing under border-width 0) is not a focus
// indicator.
export const FOCUS_STYLE_PROPS = [
  "outline-width", "outline-style", "outline-color", "outline-offset",
  "box-shadow",
  "border-top-width", "border-top-style", "border-top-color",
  "border-right-width", "border-right-style", "border-right-color",
  "border-bottom-width", "border-bottom-style", "border-bottom-color",
  "border-left-width", "border-left-style", "border-left-color",
  "background-color", "color", "text-decoration-line"
];

const zeroish = (v) => !v || v === "0px" || v === "none" || v === "hidden";

// A rendered outline needs BOTH a non-zero width and a paintable style.
function outlineVisible(style) {
  return !zeroish(style["outline-width"]) && !zeroish(style["outline-style"]);
}
function borderSideVisible(style, side) {
  return !zeroish(style[`border-${side}-width`]) && !zeroish(style[`border-${side}-style`]);
}

// Diff the unfocused vs focused computed styles and answer: does focusing
// this element produce a VISIBLE change? Returns { visible, changes[] } where
// changes lists only the changes a human could see. The browser's default
// focus ring arrives through these same computed properties (we force
// :focus-visible as well as :focus), so "author removed the outline and added
// nothing" comes back visible:false — the provable failure.
export function focusDiffVisible(unfocused, focused) {
  const changes = [];
  const u = unfocused || {}, f = focused || {};

  // Outline: visible when the focused state RENDERS an outline that differs
  // from the unfocused rendering (appearing, growing, or changing color
  // while actually painted).
  if (outlineVisible(f)) {
    if (!outlineVisible(u)) {
      changes.push({ prop: "outline", from: "(none)", to: `${f["outline-width"]} ${f["outline-style"]} ${f["outline-color"]}` });
    } else if (["outline-width", "outline-style", "outline-color", "outline-offset"].some(p => u[p] !== f[p])) {
      changes.push({ prop: "outline", from: `${u["outline-width"]} ${u["outline-style"]} ${u["outline-color"]}`, to: `${f["outline-width"]} ${f["outline-style"]} ${f["outline-color"]}` });
    }
  }

  // Box-shadow: any change where the focused side actually paints one.
  if ((u["box-shadow"] || "none") !== (f["box-shadow"] || "none") && !zeroish(f["box-shadow"])) {
    changes.push({ prop: "box-shadow", from: u["box-shadow"] || "none", to: f["box-shadow"] });
  } else if (!zeroish(u["box-shadow"]) && zeroish(f["box-shadow"])) {
    // Shadow REMOVED on focus — still a visible change.
    changes.push({ prop: "box-shadow", from: u["box-shadow"], to: "none" });
  }

  // Borders: a side that paints in the focused state and differs.
  for (const side of ["top", "right", "bottom", "left"]) {
    const props = [`border-${side}-width`, `border-${side}-style`, `border-${side}-color`];
    if (props.every(p => u[p] === f[p])) continue;
    if (borderSideVisible(f, side) || borderSideVisible(u, side)) {
      changes.push({ prop: `border-${side}`, from: props.map(p => u[p]).join(" "), to: props.map(p => f[p]).join(" ") });
    }
  }

  // Background / text color / underline: plain value changes are visible
  // (both states always render these).
  for (const p of ["background-color", "color", "text-decoration-line"]) {
    if ((u[p] || "") !== (f[p] || "")) changes.push({ prop: p, from: u[p] || "", to: f[p] || "" });
  }

  return { visible: changes.length > 0, changes };
}

// ── Keyboard walk (3a) ───────────────────────────────────────────────────
// Injected-Tab walk of the page's focus order. No arbitrary stop cap — the
// walk ends when focus CYCLES (reaches an element already visited, or falls
// back to body after at least one real stop): the sequence is bounded by the
// page's own number of focusable elements, an algorithmic bound, not a
// findings cap. Trap guard: the same element focused for TRAP_SAME_COUNT
// consecutive Tabs records an eu-keyboard-trap finding and attempts Escape
// (axe's modal-escape pattern); still stuck → the walk stops and says so.
//
// Transports (all async):
//   pressKey(key)         — dispatch one trusted key ("Tab" | "Escape")
//   readActiveElement()   — { tag, selector, html, isBody, same } for the
//                           current document.activeElement (`same` = identity-
//                           equal to the previous read, tracked in-page)
//   wait(ms)              — pacing (injectable so tests run instantly)
export async function keyboardWalk({ pressKey, readActiveElement, wait }) {
  const stops = [];
  const seenSelectors = new Set();
  const findings = [];
  let sameRun = 1;
  let trapped = false;
  let cycled = false;

  for (;;) {
    await pressKey("Tab");
    await wait(TAB_SPACING_MS);
    const active = await readActiveElement();
    if (!active) break; // page navigated / tab closed mid-walk

    if (active.same) {
      sameRun++;
      if (sameRun >= TRAP_SAME_COUNT) {
        // Trap: focus has not moved for TRAP_SAME_COUNT Tabs. Record first,
        // then attempt the escape — the finding stands either way, because a
        // keyboard user DID get stuck here (whether Escape frees them is
        // judgment about the widget's design → review-tagged).
        findings.push({
          ruleId: "eu-keyboard-trap",
          selector: active.selector,
          html: active.html,
          escaped: false
        });
        await pressKey("Escape");
        await wait(TAB_SPACING_MS);
        await pressKey("Tab");
        await wait(TAB_SPACING_MS);
        const after = await readActiveElement();
        if (after && !after.same) {
          findings[findings.length - 1].escaped = true;
          sameRun = 1;
          // continue the walk from wherever Escape+Tab landed
          if (after.isBody || seenSelectors.has(after.selector)) { cycled = true; break; }
          seenSelectors.add(after.selector);
          stops.push({ index: stops.length + 1, tag: after.tag, selector: after.selector, html: after.html });
          continue;
        }
        trapped = true;
        break;
      }
      continue; // brief same-focus (e.g. focus handler re-focus) — keep walking
    }
    sameRun = 1;

    if (active.isBody) {
      if (stops.length) { cycled = true; break; }
      continue; // nothing focusable yet — keep tabbing until something takes focus or we trap on body
    }
    if (seenSelectors.has(active.selector)) { cycled = true; break; }
    seenSelectors.add(active.selector);
    stops.push({ index: stops.length + 1, tag: active.tag, selector: active.selector, html: active.html });
  }

  return { stops, findings, trapped, cycled };
}

// ── Result → report-page assembly ────────────────────────────────────────
// Turn guided-test results into ONE buildReport-shaped page entry (mode
// "guided"), applying the honesty split:
//   violations  — eu-focus-not-visible (forcePseudoState is ground truth),
//                 eu-reflow-horizontal-scroll (the scrollbar is a fact)
//   incomplete  — eu-keyboard-trap (whether the trap is a designed modal
//                 needs a human), review-tagged
export function guidedResultsToPage({ url, title, keyboard, reflow }) {
  const violations = [];
  const incomplete = [];

  if (keyboard) {
    const noFocus = (keyboard.stops || []).filter(s => s.focusCheck && s.focusCheck.checked && !s.focusCheck.visible);
    if (noFocus.length) {
      violations.push({
        ruleId: "eu-focus-not-visible",
        impact: "serious",
        description: "Focusable element shows NO visible focus indicator (ground truth: CSS.forcePseudoState(:focus,:focus-visible) produced zero visible computed-style change — outline, box-shadow, border, background and text color all identical to the unfocused state; the browser default outline would have appeared in these properties)",
        help: "Every keyboard tab stop must have a visible focus indicator (WCAG 2.4.7). Restore the outline or add an equivalent visible focus style.",
        helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/focus-visible.html",
        tags: ["wcag2aa", "wcag247", "eu-guided", "cat.keyboard"],
        nodes: noFocus.map(s => ({
          html: s.html || "",
          target: [s.selector],
          impact: "serious",
          failureSummary: `Tab stop #${s.index}: no visible change between unfocused and focused computed styles (checked: ${FOCUS_STYLE_PROPS.length} paint-relevant properties)`,
          any: [], all: [], none: []
        }))
      });
    }
    const traps = (keyboard.findings || []).filter(f => f.ruleId === "eu-keyboard-trap");
    if (traps.length) {
      incomplete.push({
        ruleId: "eu-keyboard-trap",
        impact: "serious",
        description: "Keyboard focus stopped advancing at this element for 3 consecutive Tab presses — a keyboard trap unless the widget provides (and advertises) its own exit",
        help: "Focus must be movable away using the keyboard alone (WCAG 2.1.2). If this is a modal, Escape must close it and the trap must be documented. Needs human review: the automated Escape attempt " + (traps.every(t => t.escaped) ? "DID free focus (possible intentional modal)" : "did NOT free focus"),
        helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/no-keyboard-trap.html",
        tags: ["wcag2a", "wcag212", "eu-guided", "review", "cat.keyboard"],
        nodes: traps.map(t => ({
          html: t.html || "",
          target: [t.selector],
          impact: "serious",
          failureSummary: `Focus stuck at ${t.selector}; Escape ${t.escaped ? "released it (verify the modal advertises this exit)" : "did not release it — walk abandoned here"}`,
          any: [], all: [], none: []
        }))
      });
    }
  }

  if (reflow && reflow.horizontalScroll) {
    violations.push({
      ruleId: "eu-reflow-horizontal-scroll",
      impact: "serious",
      description: `Page requires horizontal scrolling at 320 CSS px viewport width (scrollWidth ${reflow.scrollWidth}px > clientWidth ${reflow.clientWidth}px) — WCAG 1.4.10 Reflow's normative test`,
      help: "Content must reflow to a 320 px viewport without two-dimensional scrolling (except parts requiring 2-D layout such as maps and data tables).",
      helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/reflow.html",
      tags: ["wcag21aa", "wcag1410", "eu-guided", "cat.structure"],
      nodes: (reflow.offenders && reflow.offenders.length ? reflow.offenders : [{ selector: "html", width: reflow.scrollWidth, html: "" }]).map(o => ({
        html: o.html || "",
        target: [o.selector],
        impact: "serious",
        failureSummary: `Element renders ${Math.round(o.width)}px wide at a 320px viewport`,
        any: [], all: [], none: []
      }))
    });
  }

  return {
    url: url || "",
    title: title || "",
    guided: true,
    violations,
    passes: [],
    incomplete,
    inapplicable: []
  };
}
