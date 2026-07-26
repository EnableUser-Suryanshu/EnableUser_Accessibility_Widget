// Visual check only: strip sections unrelated to the port so the screenshot
// frames the gallery and the Violations table with its new Screenshot column.
if (new URLSearchParams(location.search).get("visual") === "1") setTimeout(() => {
  const keep = new Set();
  const gal = document.getElementById("screenshots-section");
  if (gal) keep.add(gal);
  for (const s of document.querySelectorAll("main section")) {
    const h = s.querySelector("h2");
    if (h && /^Violations/.test(h.textContent)) keep.add(s);
  }
  for (const s of document.querySelectorAll("main section")) if (!keep.has(s)) s.remove();
  const pre = document.getElementById("harness-results");
  if (pre) pre.remove();
  // Expand the first issue row so the element thumbnail sits in view.
  document.querySelector("#issues-table tbody tr.issue-row")?.classList.add("expanded");
}, 3000);
