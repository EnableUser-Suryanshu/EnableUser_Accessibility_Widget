// DevTools bootstrap — creates the "EnableUser" panel. Mirrors both vendors'
// approach: axe passes the panel page plainly; BrowserStack passes the
// inspected tabId in the query string so the panel needs no devtools API of
// its own. We do the BrowserStack thing — it keeps panel.js free to run in
// any context (easier to test) — and, like axe, register nothing else here:
// no sidebar panes, no devtools.network listeners (the background's
// tabs.onUpdated listener is the navigation source of truth).
chrome.devtools.panels.create(
  "EnableUser",
  "../icons/icon48.png",
  `panel.html?tabId=${chrome.devtools.inspectedWindow.tabId}`
);
