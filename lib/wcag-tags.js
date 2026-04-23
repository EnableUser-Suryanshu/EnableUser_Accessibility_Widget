export const WCAG_RUNONLY_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

const CRITERION_MAP = {
  "wcag111": { num: "1.1.1", level: "A", name: "Non-text Content" },
  "wcag121": { num: "1.2.1", level: "A", name: "Audio-only and Video-only (Prerecorded)" },
  "wcag122": { num: "1.2.2", level: "A", name: "Captions (Prerecorded)" },
  "wcag123": { num: "1.2.3", level: "A", name: "Audio Description or Media Alternative (Prerecorded)" },
  "wcag124": { num: "1.2.4", level: "AA", name: "Captions (Live)" },
  "wcag125": { num: "1.2.5", level: "AA", name: "Audio Description (Prerecorded)" },
  "wcag131": { num: "1.3.1", level: "A", name: "Info and Relationships" },
  "wcag132": { num: "1.3.2", level: "A", name: "Meaningful Sequence" },
  "wcag133": { num: "1.3.3", level: "A", name: "Sensory Characteristics" },
  "wcag134": { num: "1.3.4", level: "AA", name: "Orientation" },
  "wcag135": { num: "1.3.5", level: "AA", name: "Identify Input Purpose" },
  "wcag141": { num: "1.4.1", level: "A", name: "Use of Color" },
  "wcag142": { num: "1.4.2", level: "A", name: "Audio Control" },
  "wcag143": { num: "1.4.3", level: "AA", name: "Contrast (Minimum)" },
  "wcag144": { num: "1.4.4", level: "AA", name: "Resize Text" },
  "wcag145": { num: "1.4.5", level: "AA", name: "Images of Text" },
  "wcag1410": { num: "1.4.10", level: "AA", name: "Reflow" },
  "wcag1411": { num: "1.4.11", level: "AA", name: "Non-text Contrast" },
  "wcag1412": { num: "1.4.12", level: "AA", name: "Text Spacing" },
  "wcag1413": { num: "1.4.13", level: "AA", name: "Content on Hover or Focus" },
  "wcag211": { num: "2.1.1", level: "A", name: "Keyboard" },
  "wcag212": { num: "2.1.2", level: "A", name: "No Keyboard Trap" },
  "wcag214": { num: "2.1.4", level: "A", name: "Character Key Shortcuts" },
  "wcag221": { num: "2.2.1", level: "A", name: "Timing Adjustable" },
  "wcag222": { num: "2.2.2", level: "A", name: "Pause, Stop, Hide" },
  "wcag231": { num: "2.3.1", level: "A", name: "Three Flashes or Below Threshold" },
  "wcag241": { num: "2.4.1", level: "A", name: "Bypass Blocks" },
  "wcag242": { num: "2.4.2", level: "A", name: "Page Titled" },
  "wcag243": { num: "2.4.3", level: "A", name: "Focus Order" },
  "wcag244": { num: "2.4.4", level: "A", name: "Link Purpose (In Context)" },
  "wcag245": { num: "2.4.5", level: "AA", name: "Multiple Ways" },
  "wcag246": { num: "2.4.6", level: "AA", name: "Headings and Labels" },
  "wcag247": { num: "2.4.7", level: "AA", name: "Focus Visible" },
  "wcag251": { num: "2.5.1", level: "A", name: "Pointer Gestures" },
  "wcag252": { num: "2.5.2", level: "A", name: "Pointer Cancellation" },
  "wcag253": { num: "2.5.3", level: "A", name: "Label in Name" },
  "wcag254": { num: "2.5.4", level: "A", name: "Motion Actuation" },
  "wcag311": { num: "3.1.1", level: "A", name: "Language of Page" },
  "wcag312": { num: "3.1.2", level: "AA", name: "Language of Parts" },
  "wcag321": { num: "3.2.1", level: "A", name: "On Focus" },
  "wcag322": { num: "3.2.2", level: "A", name: "On Input" },
  "wcag323": { num: "3.2.3", level: "AA", name: "Consistent Navigation" },
  "wcag324": { num: "3.2.4", level: "AA", name: "Consistent Identification" },
  "wcag331": { num: "3.3.1", level: "A", name: "Error Identification" },
  "wcag332": { num: "3.3.2", level: "A", name: "Labels or Instructions" },
  "wcag333": { num: "3.3.3", level: "AA", name: "Error Suggestion" },
  "wcag334": { num: "3.3.4", level: "AA", name: "Error Prevention (Legal, Financial, Data)" },
  "wcag411": { num: "4.1.1", level: "A", name: "Parsing" },
  "wcag412": { num: "4.1.2", level: "A", name: "Name, Role, Value" },
  "wcag413": { num: "4.1.3", level: "AA", name: "Status Messages" }
};

export function criterionFromTag(tag) {
  const m = CRITERION_MAP[tag];
  return m ? m : null;
}

export function extractCriteriaFromTags(tags) {
  const out = [];
  for (const t of tags) {
    const c = criterionFromTag(t);
    if (c) out.push(c);
  }
  return out;
}

export const ALL_AA_CRITERIA = Object.values(CRITERION_MAP);

// ──────────────────────────────────────────────────────────────────────
// Given an axe rule's tag array, derive the three audit-report columns:
//   compliance      — "Level A" / "Level AA" / "Level AAA" / "Best Practice"
//   standards       — comma-joined WCAG version + regional frameworks
//   successCriteria — semicolon-joined "1.4.3 Contrast (Minimum); …"
// Shared between report/inventory.js (Findings tab UI) and
// lib/xlsx-writer.js (Audit Report download) so the two stay consistent.
// ──────────────────────────────────────────────────────────────────────
export function deriveFromTags(tags = []) {
  const tagSet = new Set(tags);

  let level = null;
  if (tagSet.has("wcag2aaa") || tagSet.has("wcag21aaa") || tagSet.has("wcag22aaa")) level = "Level AAA";
  else if (tagSet.has("wcag2aa") || tagSet.has("wcag21aa") || tagSet.has("wcag22aa")) level = "Level AA";
  else if (tagSet.has("wcag2a") || tagSet.has("wcag21a") || tagSet.has("wcag22a")) level = "Level A";
  else if (tagSet.has("best-practice")) level = "Best Practice";

  const standards = new Set();
  const tagArr = [...tagSet];
  if (tagArr.some(t => /^wcag22/.test(t))) standards.add("WCAG 2.2");
  else if (tagArr.some(t => /^wcag21/.test(t))) standards.add("WCAG 2.1");
  else if (tagArr.some(t => /^wcag2[a-z]/.test(t))) standards.add("WCAG 2.0");
  if (tagArr.some(t => /section508/i.test(t))) standards.add("Section 508");
  if (tagArr.some(t => /en-?301-?549/i.test(t))) standards.add("EN 301 549");
  if (tagArr.some(t => /is.?17802/i.test(t))) standards.add("IS 17802");
  if (tagArr.some(t => /gigw/i.test(t))) standards.add("GIGW 3.0");
  if (tagArr.some(t => /^ada$/i.test(t))) standards.add("ADA");

  const criteria = [];
  for (const t of tagSet) {
    const c = criterionFromTag(t);
    if (c) criteria.push(`${c.num} ${c.name}`);
  }
  const seen = new Set();
  const uniqCriteria = criteria.filter(c => (seen.has(c) ? false : (seen.add(c), true)));

  return {
    compliance: level || "—",
    standards: standards.size ? [...standards].join(", ") : "—",
    successCriteria: uniqCriteria.length ? uniqCriteria.join("; ") : "—"
  };
}
