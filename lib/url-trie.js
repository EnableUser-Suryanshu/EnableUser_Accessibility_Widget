// lib/url-trie.js
// v0.4.0 team-merge — URL-template grouping.
//
// Port of team crawler-extension/report.js groupByTemplate. Partitions a
// list of pages into templated URL groups by walking path segments in
// order and, at each position where multiple values appear, checking
// whether enough of the distinct values share a recognisable "shape"
// (numeric id, UUID, year, ISO date, hex hash, or slug). When ≥3 values
// share a shape, that segment becomes a parametric branch like "[id]" or
// "[slug]"; the remaining literal values stay as their own branches.
//
// Groups are emitted only if the template contains at least one literal
// segment AND has ≥2 URLs. Pure-parametric paths (e.g. "/[slug]") fall
// into ungrouped so we don't invent a fake "Everything under /" cluster.
//
// Two tunables preserved from the team build:
//   MIN_PARAM_VALUES = 3  (segments need ≥3 shared-shape values to
//                          collapse into a parametric branch; below that
//                          they stay literal so small sites don't lose
//                          distinct pages to overzealous bucketing)
//   Shapes: id | uuid | year | date | hash | slug

export const MIN_PARAM_VALUES = 3;

// Group pages by inferred URL template.
// Each page is `{ url, ...anything }`; the extra fields ride along.
// Returns { grouped: [{template, urls:[...]}], ungrouped: [...] }.
export function groupByTemplate(pages) {
  const prepared = [];
  for (const p of pages) {
    if (!p || !p.url) continue;
    const segments = parseSegments(p.url);
    prepared.push({ ...p, segments });
  }

  // Partition by segment count first — templates of different depths
  // can't share a path tree, so we bucket them separately.
  const byCount = new Map();
  for (const p of prepared) {
    const c = p.segments.length;
    if (!byCount.has(c)) byCount.set(c, []);
    byCount.get(c).push(p);
  }

  const allGroups = [];
  for (const [, members] of byCount) {
    allGroups.push(...partition(members, 0, []));
  }

  const grouped = [];
  const ungrouped = [];
  for (const g of allGroups) {
    if (g.urls.length > 1 && hasLiteralSegment(g.template)) {
      grouped.push(g);
    } else {
      ungrouped.push(...g.urls);
    }
  }

  grouped.sort((a, b) =>
    b.urls.length - a.urls.length || a.template.localeCompare(b.template)
  );
  ungrouped.sort((a, b) => a.url.localeCompare(b.url));

  return { grouped, ungrouped };
}

function partition(urls, position, prefix) {
  if (urls.length === 0) return [];
  const len = urls[0].segments.length;

  if (position >= len) {
    const template = len === 0 ? "/" : "/" + prefix.join("/");
    return [{ template, urls }];
  }

  const byValue = new Map();
  for (const u of urls) {
    const v = u.segments[position];
    if (!byValue.has(v)) byValue.set(v, []);
    byValue.get(v).push(u);
  }

  if (byValue.size === 1) {
    const [only] = byValue.keys();
    return partition(urls, position + 1, [...prefix, only]);
  }

  // Classify each distinct value by shape; collapse when enough share one.
  const byShape = new Map();
  for (const v of byValue.keys()) {
    const shape = classifyShape(v);
    if (!shape) continue;
    if (!byShape.has(shape)) byShape.set(shape, []);
    byShape.get(shape).push(v);
  }

  const used = new Set();
  const result = [];

  for (const [shape, values] of byShape) {
    if (values.length < MIN_PARAM_VALUES) continue;
    const branchUrls = values.flatMap(v => byValue.get(v));
    result.push(...partition(branchUrls, position + 1, [...prefix, `[${shape}]`]));
    for (const v of values) used.add(v);
  }

  for (const [v, subUrls] of byValue) {
    if (used.has(v)) continue;
    result.push(...partition(subUrls, position + 1, [...prefix, v]));
  }

  return result;
}

function hasLiteralSegment(template) {
  if (!template || template === "/") return false;
  const segments = template.replace(/^\/+/, "").split("/").filter(Boolean);
  return segments.some(s => !/^\[[a-z]+\]$/.test(s));
}

export function parseSegments(url) {
  try {
    const u = new URL(url);
    const path = u.pathname;
    if (!path || path === "/") return [];
    return path.replace(/^\/+/, "").split("/").filter(s => s !== "");
  } catch {
    return [];
  }
}

// Shape classifier — recognises the six value types that show up in the
// long tail of URLs: numeric ids, UUIDs, years, ISO dates, long hex
// hashes, and human-readable slugs. Anything else (e.g. a literal
// taxonomy name like "legal" or "contact") returns null and stays as a
// literal segment.
export function classifyShape(v) {
  if (!v) return null;
  if (/^[0-9]+$/.test(v)) return "id";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return "uuid";
  if (/^(19|20)\d{2}$/.test(v)) return "year";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return "date";
  if (/^[0-9a-f]{32,}$/i.test(v)) return "hash";
  if ((/-/.test(v) || /\d/.test(v)) && /^[a-z0-9][a-z0-9_.-]*$/i.test(v) && v.length >= 3) return "slug";
  return null;
}
