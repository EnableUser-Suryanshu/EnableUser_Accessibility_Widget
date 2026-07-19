// lib/dom-similarity.js
// v0.4.0 team-merge — DOM simhash clustering.
//
// Consumes the 16-hex `domHash` that content-script.js emits per page
// (tag 3-gram FNV-64 simhash, presence-based) and groups pages by
// Hamming distance. Zero-tolerance groups hash-identical pages only;
// raise the threshold to catch near-duplicates that differ by a few
// modules (sidebar variant, extra banner, etc.).
//
// hamming(a, b): popcount over the XOR of two 64-bit hex strings using
// BigInt. Returns 64 on any parse error (treated as "maximally far").
//
// clusterByHamming(items, threshold):
//   items: [{ url, domHash, ...anything }]; only hashed items are
//          considered valid — callers should filter out "" domHash
//          first (e.g. PDFs, failed loads).
//   threshold: bits of tolerance (0 = exact hash match).
//   Returns [{ centroid, preview, urls: [...] }] sorted by first-seen.
//
// Centroid strategy: first-wins. We don't recompute centroids because
// the team build doesn't either, and doing so would break the visible
// stability of clusters when the tolerance slider is nudged.

export function hamming(a, b) {
  if (!a || !b) return 64;
  try {
    let x = BigInt("0x" + a) ^ BigInt("0x" + b);
    let count = 0;
    while (x > 0n) {
      count += Number(x & 1n);
      x >>= 1n;
    }
    return count;
  } catch {
    return 64;
  }
}

export function clusterByHamming(items, threshold) {
  const tol = Number.isFinite(threshold) ? threshold : 0;
  // Deterministic iteration: sort by URL so the first-wins centroid
  // picks the alphabetically-first URL's hash, not whatever order the
  // input happened to have.
  const sorted = [...items].sort((a, b) => String(a.url).localeCompare(String(b.url)));
  const clusters = [];
  for (const item of sorted) {
    let bestIdx = -1;
    let bestDist = tol + 1;
    for (let i = 0; i < clusters.length; i++) {
      const d = hamming(item.domHash, clusters[i].centroid);
      if (d < bestDist) {
        bestIdx = i;
        bestDist = d;
        if (d === 0) break;
      }
    }
    if (bestIdx >= 0 && bestDist <= tol) {
      clusters[bestIdx].urls.push(item);
    } else {
      clusters.push({
        centroid: item.domHash,
        preview: item.domPreview || "",
        urls: [item]
      });
    }
  }
  return clusters;
}
