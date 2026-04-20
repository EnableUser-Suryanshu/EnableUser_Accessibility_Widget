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
