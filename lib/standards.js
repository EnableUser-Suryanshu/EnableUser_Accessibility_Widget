// Multi-framework standards cross-reference.
//
// The source of truth is the WCAG 2.1 success-criterion number (e.g. "1.4.3").
// Every other framework below is either a direct 1-to-1 equivalence (GIGW 3.0,
// EN 301 549 ch.9, IS 17802 ch.9) or a higher-level reference that incorporates
// WCAG by citation (Section 508, ADA Title III).
//
// References
//   GIGW 3.0 — guidelines.india.gov.in/accessibility-guidelines-and-attributes
//     Clauses 5.2.1 … 5.2.50 map 1-to-1 to WCAG 1.1.1 … 4.1.3.
//   EN 301 549 v3.2.1 — Chapter 9 (Web) uses WCAG 2.1 SC numbering prefixed "9."
//     e.g. EN 9.1.1.1 ≡ WCAG 1.1.1.
//   IS 17802 Part 1 (2021) — Chapter 9 (Web) mirrors EN 301 549 numbering;
//     Part 2 (2022) defines conformance methodology.
//   Section 508 (Revised, 2018) — E205.4 incorporates WCAG 2.0 Level AA by
//     reference; IT-ICT Refresh. We tag coverage, not exact clause.
//   ADA Title III — DOJ uses WCAG 2.1 AA as the practical benchmark via
//     consent decrees and 2024 Title II rule; no numbered clauses.

// WCAG SC num → GIGW 3.0 clause number (from the 50-item table in GIGW 3.0).
const GIGW_MAP = {
  "1.1.1": "5.2.1",  "1.2.1": "5.2.2",  "1.2.2": "5.2.3",  "1.2.3": "5.2.4",
  "1.2.4": "5.2.5",  "1.2.5": "5.2.6",  "1.3.1": "5.2.7",  "1.3.2": "5.2.8",
  "1.3.3": "5.2.9",  "1.3.4": "5.2.10", "1.3.5": "5.2.11", "1.4.1": "5.2.12",
  "1.4.2": "5.2.13", "1.4.3": "5.2.14", "1.4.4": "5.2.15", "1.4.5": "5.2.16",
  "1.4.10": "5.2.17","1.4.11": "5.2.18","1.4.12": "5.2.19","1.4.13": "5.2.20",
  "2.1.1": "5.2.21", "2.1.2": "5.2.22", "2.1.4": "5.2.23", "2.2.1": "5.2.24",
  "2.2.2": "5.2.25", "2.3.1": "5.2.26", "2.4.1": "5.2.27", "2.4.2": "5.2.28",
  "2.4.3": "5.2.29", "2.4.4": "5.2.30", "2.4.5": "5.2.31", "2.4.6": "5.2.32",
  "2.4.7": "5.2.33", "2.5.1": "5.2.34", "2.5.2": "5.2.35", "2.5.3": "5.2.36",
  "2.5.4": "5.2.37", "3.1.1": "5.2.38", "3.1.2": "5.2.39", "3.2.1": "5.2.40",
  "3.2.2": "5.2.41", "3.2.3": "5.2.42", "3.2.4": "5.2.43", "3.3.1": "5.2.44",
  "3.3.2": "5.2.45", "3.3.3": "5.2.46", "3.3.4": "5.2.47", "4.1.1": "5.2.48",
  "4.1.2": "5.2.49", "4.1.3": "5.2.50"
};

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

function section508Ref(wcagNum) {
  if (WCAG21_NEW.has(wcagNum)) return "Beyond E205.4 (WCAG 2.1 addition)";
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
    gigw: GIGW_MAP[wcagNum] || null,
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
//   gigw3           — GIGW 3.0 clauses 5.2.1–5.2.50 (≡ WCAG 2.1 AA subset listed)
//   en301549        — EN 301 549 Chapter 9 (≡ WCAG 2.1 AA for web)
//   section508      — WCAG 2.0 A/AA only (excludes 2.1 additions)
//   ada             — same set as wcag21aa in practice
const SECTION508_SET = new Set(Object.keys(GIGW_MAP).filter(k => !WCAG21_NEW.has(k)));
const WCAG21AA_SET   = new Set(Object.keys(GIGW_MAP)); // our CRITERION_MAP set
const GIGW_SET       = new Set(Object.keys(GIGW_MAP));

// Combined India profile — union of WCAG 2.1 AA + IS 17802 + GIGW 3.0.
// In practice the three share the same 50 success criteria, so the union is
// WCAG21AA_SET. The clauseKey "combined_in" is a sentinel handled specially
// in profileClause() to render all three clause citations side-by-side.
const COMBINED_IN_SET = new Set([...WCAG21AA_SET, ...GIGW_SET]);

export const PROFILES = {
  wcag21aa:    { label: "WCAG 2.1 AA",                             set: WCAG21AA_SET,    clauseKey: "wcag" },
  is17802:     { label: "IS 17802 (India)",                        set: WCAG21AA_SET,    clauseKey: "is17802" },
  gigw3:       { label: "GIGW 3.0 (NIC)",                          set: GIGW_SET,        clauseKey: "gigw" },
  combined_in: { label: "WCAG 2.1 AA + IS 17802 + GIGW 3.0",       set: COMBINED_IN_SET, clauseKey: "combined_in" },
  en301549:    { label: "EN 301 549 (EU)",                         set: WCAG21AA_SET,    clauseKey: "en301549" },
  section508:  { label: "Section 508 (US)",                        set: SECTION508_SET,  clauseKey: "section508" },
  ada:         { label: "ADA Title III (US)",                      set: WCAG21AA_SET,    clauseKey: "ada" }
};

export const PROFILE_KEYS = Object.keys(PROFILES);

// Is this WCAG SC in-scope for the given profile?
export function isInProfile(profileKey, wcagNum) {
  const p = PROFILES[profileKey];
  if (!p) return true;
  return p.set.has(wcagNum);
}

// Convert a WCAG SC into a profile-appropriate clause label
// (e.g. profile=gigw3, wcag=1.1.1 → "GIGW 5.2.1").
export function profileClause(profileKey, wcagNum) {
  const p = PROFILES[profileKey];
  if (!p) return wcagNum;
  const s = standardsFor(wcagNum);
  if (!s) return wcagNum;
  if (profileKey === "combined_in") {
    const parts = [`WCAG ${s.wcag}`, `IS 17802 ${s.is17802}`];
    if (s.gigw) parts.push(`GIGW ${s.gigw}`);
    return parts.join(" / ");
  }
  const raw = s[p.clauseKey];
  if (!raw) return wcagNum;
  switch (profileKey) {
    case "wcag21aa":   return `WCAG ${raw}`;
    case "is17802":    return `IS 17802 ${raw}`;
    case "gigw3":      return `GIGW ${raw}`;
    case "en301549":   return `EN 301 549 §${raw}`;
    case "section508": return raw;
    case "ada":        return raw;
    default:           return raw;
  }
}
