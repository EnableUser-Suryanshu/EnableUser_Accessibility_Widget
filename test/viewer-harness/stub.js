// Stand in for the extension environment so report.html can be driven from
// file://. Two deliberate choices:
//   • shot-page-1 and shot-el-a resolve from chrome.storage.local (the primary
//     path the port uses), shot-page-2 and shot-el-b resolve only via the
//     GET_SCREENSHOT message (the eviction fallback), and shot-page-3 resolves
//     from NEITHER — that must degrade to "screenshot unavailable", not throw.
//   • The report object mirrors buildReport()'s real return shape, including
//     `pages` (raw page objects carrying `screenshot`) being distinct from
//     `pagesRows` (flattened table rows that do not).

const SHOTS = window.__HARNESS_SHOTS;
const IN_STORAGE = ["shot-page-1", "shot-el-a"];
const VIA_MESSAGE = ["shot-page-2", "shot-el-b"];

window.__HARNESS_CALLS = { storageGet: [], sendMessage: [] };

const storageData = {};
for (const id of IN_STORAGE) storageData[`shot:${id}`] = SHOTS[id];

function page(url, title, shotId, violations) {
  return {
    url, title, depth: 1, source: "link",
    screenshot: shotId ? { id: shotId, bytes: SHOTS[shotId].bytes } : null,
    violations: violations || [],
    passes: [], incomplete: [], inapplicable: []
  };
}

const REPORT = {
  meta: {
    mode: "single", seedUrl: "https://example.test/", generatedAt: new Date().toISOString(),
    totalPages: 4, totalTemplates: 1, profileLabel: "WCAG 2.1 AA", wcagVersion: "2.1"
  },
  pages: [
    page("https://example.test/", "Home — storage path", "shot-page-1"),
    page("https://example.test/about", "About — message fallback", "shot-page-2"),
    page("https://example.test/contact", "Contact — missing image", "shot-page-3"),
    // No screenshot at all: must not produce a gallery card.
    page("https://example.test/legal", "Legal — no screenshot", null)
  ],
  pagesRows: [
    { url: "https://example.test/", depth: 1, source: "link", status: "scanned", violations: 2, passes: 40, incomplete: 1, inapplicable: 5, error: "" },
    { url: "https://example.test/about", depth: 1, source: "link", status: "scanned", violations: 0, passes: 44, incomplete: 0, inapplicable: 5, error: "" },
    { url: "https://example.test/contact", depth: 1, source: "link", status: "failed", violations: 0, passes: 0, incomplete: 0, inapplicable: 0, error: "net::ERR_NAME_NOT_RESOLVED" },
    { url: "https://example.test/legal", depth: 1, source: "link", status: "scanned", violations: 0, passes: 44, incomplete: 0, inapplicable: 5, error: "" }
  ],
  summaryRows: [
    { criterion: "1.1.1", level: "A", name: "Non-text Content", status: "fail", pages_passed: 0, pages_failed: 1, total_violations: 1 },
    { criterion: "1.4.3", level: "AA", name: "Contrast (Minimum)", status: "fail", pages_passed: 0, pages_failed: 1, total_violations: 1 }
  ],
  issueRows: [
    {
      url: "https://example.test/", page_title: "Home", wcag_criterion: "1.1.1", wcag_level: "A",
      wcag_name: "Non-text Content", rule_id: "image-alt", rule_impact: "critical", impact: "critical",
      rule_description: "Images must have alternate text", rule_help: "Add alt text",
      rule_tags: "wcag2a wcag111", rule_source: "axe-core",
      selector: "img.hero", target_array: ["img.hero"], ancestry: "", xpath: "",
      html_snippet: "<img class=\"hero\" src=\"h.png\">", failure_summary: "Element has no alt attribute",
      elementShotId: "shot-el-a",             // resolves from storage
      help_url: "", checks_any: [], checks_all: [], checks_none: [],
      is17802_clause: "", en301549_clause: "", section508_ref: "", ada_ref: ""
    },
    {
      url: "https://example.test/", page_title: "Home", wcag_criterion: "1.4.3", wcag_level: "AA",
      wcag_name: "Contrast (Minimum)", rule_id: "color-contrast", rule_impact: "serious", impact: "serious",
      rule_description: "Elements must have sufficient contrast", rule_help: "Increase contrast",
      rule_tags: "wcag2aa wcag143", rule_source: "axe-core",
      selector: "p.muted", target_array: ["p.muted"], ancestry: "", xpath: "",
      html_snippet: "<p class=\"muted\">low</p>", failure_summary: "Contrast 2.1:1",
      elementShotId: "shot-el-b",             // resolves only via GET_SCREENSHOT
      help_url: "", checks_any: [], checks_all: [], checks_none: [],
      is17802_clause: "", en301549_clause: "", section508_ref: "", ada_ref: ""
    },
    {
      url: "https://example.test/", page_title: "Home", wcag_criterion: "2.4.4", wcag_level: "A",
      wcag_name: "Link Purpose", rule_id: "link-name", rule_impact: "serious", impact: "serious",
      rule_description: "Links must have discernible text", rule_help: "Add link text",
      rule_tags: "wcag2a wcag244", rule_source: "axe-core",
      selector: "a.icon", target_array: ["a.icon"], ancestry: "", xpath: "",
      html_snippet: "<a class=\"icon\"></a>", failure_summary: "Link has no text",
      elementShotId: "",                      // no shot: must render the em-dash placeholder
      help_url: "", checks_any: [], checks_all: [], checks_none: [],
      is17802_clause: "", en301549_clause: "", section508_ref: "", ada_ref: ""
    }
  ],
  passRows: [], incompleteRows: [], inapplicableRows: [], checkRows: [],
  envRows: [{ key: "Screenshots", value: "on" }],
  templatesRows: [], profilesRows: [], mediaRows: [], mediaSummary: {}
};

window.chrome = {
  runtime: {
    sendMessage(msg, cb) {
      window.__HARNESS_CALLS.sendMessage.push(msg?.type + (msg?.id ? ":" + msg.id : ""));
      if (msg?.type === "GET_REPORT") return void cb({ ok: true, report: REPORT });
      if (msg?.type === "GET_SCREENSHOT") {
        const hit = VIA_MESSAGE.includes(msg.id);
        return void cb(hit ? { ok: true, dataUrl: SHOTS[msg.id].dataUrl } : { ok: false, dataUrl: null });
      }
      cb({ ok: false });
    },
    getURL: p => p
  },
  storage: {
    local: {
      get(key) {
        window.__HARNESS_CALLS.storageGet.push(key);
        const keys = Array.isArray(key) ? key : [key];
        const out = {};
        for (const k of keys) if (storageData[k]) out[k] = storageData[k];
        return Promise.resolve(out);
      }
    }
  }
};
