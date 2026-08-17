// DevTools bootstrap — creates the "EnableUser" panel in the inspector.
// CRITICAL path detail: chrome.devtools.panels.create resolves BOTH the icon
// path and the page path relative to the EXTENSION ROOT, not this file's
// directory. "panel.html" here would point at a nonexistent root file and the
// panel renders blank — the exact bug shipped in the first cut of this file.
// tabId rides the query string (BrowserStack's pattern) so panel.js never
// needs chrome.devtools APIs.
chrome.devtools.panels.create(
  "EnableUser",
  "icons/icon48.png",
  `devtools/panel.html?tabId=${chrome.devtools.inspectedWindow.tabId}`
);
