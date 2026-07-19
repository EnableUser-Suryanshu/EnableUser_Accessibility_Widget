// Multi-framework standards cross-reference.
//
// The source of truth is the WCAG 2.1 success-criterion number (e.g. "1.4.3").
// Every other framework below is either a direct 1-to-1 equivalence (EN 301
// 549 ch.9, IS 17802 ch.9) or a higher-level reference that incorporates
// WCAG by citation (Section 508, ADA Title III).
//
// References
//   EN 301 549 v3.2.1 — Chapter 9 (Web) uses WCAG 2.1 SC numbering prefixed "9."
//     e.g. EN 9.1.1.1 ≡ WCAG 1.1.1.
//   IS 17802 Part 1 (2021) — Chapter 9 (Web) mirrors EN 301 549 numbering;
//     Part 2 (2022) defines conformance methodology.
//   Section 508 (Revised, 2018) — E205.4 incorporates WCAG 2.0 Level AA by
//     reference; IT-ICT Refresh. We tag coverage, not exact clause.
//   ADA Title III — DOJ uses WCAG 2.1 AA as the practical benchmark via
//     consent decrees and 2024 Title II rule; no numbered clauses.

// The 50 WCAG 2.1 Level A + AA success criteria we cover. Master list —
// every profile below is expressed as a subset of these.
const WCAG21AA_LIST = [
  "1.1.1",
  "1.2.1", "1.2.2", "1.2.3", "1.2.4", "1.2.5",
  "1.3.1", "1.3.2", "1.3.3", "1.3.4", "1.3.5",
  "1.4.1", "1.4.2", "1.4.3", "1.4.4", "1.4.5",
  "1.4.10", "1.4.11", "1.4.12", "1.4.13",
  "2.1.1", "2.1.2", "2.1.4",
  "2.2.1", "2.2.2",
  "2.3.1",
  "2.4.1", "2.4.2", "2.4.3", "2.4.4", "2.4.5", "2.4.6", "2.4.7",
  "2.5.1", "2.5.2", "2.5.3", "2.5.4",
  "3.1.1", "3.1.2",
  "3.2.1", "3.2.2", "3.2.3", "3.2.4",
  "3.3.1", "3.3.2", "3.3.3", "3.3.4",
  "4.1.1", "4.1.2", "4.1.3"
];

// EN 301 549 v3.2.1 — web content chapter. Clauses are "9." + WCAG number.
// For the subset of WCAG 2.1 A/AA we cover here, this mapping is mechanical.
function enClause(wcagNum) { return `9.${wcagNum}`; }

// IS 17802 Part 1 — web content chapter. Same clause numbering as EN 301 549
// for the web subset (India adopted the EN structure). Part 2 covers
// determination-of-conformance methodology, not per-SC clauses.
function isClause(wcagNum) { return `Part 1, ${enClause(wcagNum)}`; }

// Section 508 (Revised 2018) — E205.4 (Accessibility Standards for Electronic
// Content) incorporates WCAG 2.0 Level A and AA by reference. WCAG 2.1 SCs
// introduced in 2.1 (not present in 2.0) are NOT part of Section 508's
// statutory requirement today, but are commonly audited anyway. We mark the
// coverage status accordingly.
const WCAG21_NEW = new Set([
  "1.3.4", "1.3.5", "1.4.10", "1.4.11", "1.4.12", "1.4.13",
  "2.1.4", "2.2.6", "2.3.3", "2.5.1", "2.5.2", "2.5.3", "2.5.4",
  "4.1.3"
]);

// WCAG 2.2 (2023) added 6 Level A/AA success criteria — and removed 4.1.1
// Parsing. These are the A/AA additions we audit (the 3 AAA additions —
// 2.4.12, 2.4.13, 3.3.9 — are out of A+AA scope):
//   2.4.11 Focus Not Obscured (Minimum)        AA
//   2.5.7  Dragging Movements                  AA
//   2.5.8  Target Size (Minimum)               AA
//   3.2.6  Consistent Help                     A
//   3.3.7  Redundant Entry                     A
//   3.3.8  Accessible Authentication (Minimum) AA
const WCAG22_NEW = new Set(["2.4.11", "2.5.7", "2.5.8", "3.2.6", "3.3.7", "3.3.8"]);

function section508Ref(wcagNum) {
  if (WCAG21_NEW.has(wcagNum)) return "Beyond E205.4 (WCAG 2.1 addition)";
  if (WCAG22_NEW.has(wcagNum)) return "Beyond E205.4 (WCAG 2.2 addition)";
  return "E205.4 / WCAG 2.0 AA (incorporated by reference)";
}

// ADA Title III — no formal clause numbers. DOJ's 2024 Title II rule and
// settled consent decrees treat WCAG 2.1 AA as the governing benchmark.
function adaRef() { return "ADA Title III (WCAG 2.1 AA benchmark per DOJ)"; }

// Public API — enrich a WCAG SC number with all equivalent clauses.
export function standardsFor(wcagNum) {
  if (!wcagNum) return null;
  return {
    wcag: wcagNum,
    en301549: enClause(wcagNum),
    is17802: isClause(wcagNum),
    section508: section508Ref(wcagNum),
    ada: adaRef()
  };
}

// Which profile includes which WCAG SC.
//
//   wcag21aa        — full WCAG 2.1 A + AA
//   is17802         — web content subset of IS 17802 Part 1 (≡ WCAG 2.1 AA)
//   combined_in     — WCAG 2.1 AA + IS 17802 (India engagements)
//   en301549        — EN 301 549 Chapter 9 (≡ WCAG 2.1 AA for web)
//   section508      — WCAG 2.0 A/AA only (excludes 2.1 additions)
//   ada             — same set as wcag21aa in practice
// ── WCAG version scopes ────────────────────────────────────────────────
// WCAG 2.0 A+AA = the 2.1 list minus the SCs introduced in 2.1.
// WCAG 2.2 A+AA = the 2.1 list minus 4.1.1 (removed in 2.2) plus the 6 new
// 2.2 A/AA SCs. These drive which criteria the report tallies when each
// version/profile is selected.
const cmpSc = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
};
const WCAG20AA_LIST = WCAG21AA_LIST.filter(k => !WCAG21_NEW.has(k));
const WCAG22AA_LIST = WCAG21AA_LIST.filter(k => k !== "4.1.1").concat([...WCAG22_NEW]).sort(cmpSc);

const WCAG21AA_SET   = new Set(WCAG21AA_LIST);
const WCAG20AA_SET   = new Set(WCAG20AA_LIST);
const WCAG22AA_SET   = new Set(WCAG22AA_LIST);
const SECTION508_SET = WCAG20AA_SET; // Section 508 ≡ WCAG 2.0 A/AA

// axe-core runOnly tag sets per WCAG version. THIS is what makes version
// selection real — background.js feeds the chosen set into content-script.js.
const TAGS_20 = ["wcag2a", "wcag2aa"];
const TAGS_21 = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const TAGS_22 = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

// Each profile now carries the axe tag set that drives the live scan AND the
// ordered criterion scope (SC numbers) the report tallies against — so the
// selector actually changes what axe runs, not just how results are labelled.
export const PROFILES = {
  wcag21aa:    { label: "WCAG 2.1 AA",                             set: WCAG21AA_SET,    criteria: WCAG21AA_LIST, tags: TAGS_21, wcagVersion: "2.1", clauseKey: "wcag" },
  wcag22aa:    { label: "WCAG 2.2 AA",                             set: WCAG22AA_SET,    criteria: WCAG22AA_LIST, tags: TAGS_22, wcagVersion: "2.2", clauseKey: "wcag" },
  is17802:     { label: "IS 17802 (India)",                        set: WCAG21AA_SET,    criteria: WCAG21AA_LIST, tags: TAGS_21, wcagVersion: "2.1", clauseKey: "is17802" },
  combined_in: { label: "WCAG 2.1 AA + IS 17802 (Combined India)", set: WCAG21AA_SET,    criteria: WCAG21AA_LIST, tags: TAGS_21, wcagVersion: "2.1", clauseKey: "combined_in" },
  en301549:    { label: "EN 301 549 (EU)",                         set: WCAG21AA_SET,    criteria: WCAG21AA_LIST, tags: TAGS_21, wcagVersion: "2.1", clauseKey: "en301549" },
  section508:  { label: "Section 508 (US)",                        set: SECTION508_SET,  criteria: WCAG20AA_LIST, tags: TAGS_20, wcagVersion: "2.0", clauseKey: "section508" },
  ada:         { label: "ADA Title III (US)",                      set: WCAG21AA_SET,    criteria: WCAG21AA_LIST, tags: TAGS_21, wcagVersion: "2.1", clauseKey: "ada" }
};

export const PROFILE_KEYS = Object.keys(PROFILES);

// axe-core runOnly tags for a profile (drives the live scan).
export function tagsForProfile(profileKey) {
  return (PROFILES[profileKey] && PROFILES[profileKey].tags) || TAGS_21;
}
// Ordered SC-number scope for a profile (drives the report's criterion tally).
export function criteriaForProfile(profileKey) {
  return (PROFILES[profileKey] && PROFILES[profileKey].criteria) || WCAG21AA_LIST;
}
// WCAG version label for a profile (e.g. "2.2").
export function versionForProfile(profileKey) {
  return (PROFILES[profileKey] && PROFILES[profileKey].wcagVersion) || "2.1";
}

// Is this WCAG SC in-scope for the given profile?
export function isInProfile(profileKey, wcagNum) {
  const p = PROFILES[profileKey];
  if (!p) return true;
  return p.set.has(wcagNum);
}

// Convert a WCAG SC into a profile-appropriate clause label
// (e.g. profile=is17802, wcag=1.1.1 → "IS 17802 Part 1, 9.1.1.1").
export function profileClause(profileKey, wcagNum) {
  const p = PROFILES[profileKey];
  if (!p) return wcagNum;
  const s = standardsFor(wcagNum);
  if (!s) return wcagNum;
  if (profileKey === "combined_in") {
    return `WCAG ${s.wcag} / IS 17802 ${s.is17802}`;
  }
  const raw = s[p.clauseKey];
  if (!raw) return wcagNum;
  switch (profileKey) {
    case "wcag21aa":   return `WCAG ${raw}`;
    case "is17802":    return `IS 17802 ${raw}`;
    case "en301549":   return `EN 301 549 §${raw}`;
    case "section508": return raw;
    case "ada":        return raw;
    default:           return raw;
  }
}
