// Builds real inventory workbooks in Node and asserts the OOXML embedded-image
// plumbing. Run:  node test/xlsx-drawings.test.mjs
//
// Why this exists: v0.5.0 added an inline Preview column to the Violations sheet,
// taking the workbook from two drawing specs to three. Media images are numbered
// globally (image1..imageN) while each drawing's rels reference them through a
// per-drawing offset, so an off-by-one there yields either a workbook Excel
// refuses to open or previews silently pointing at the wrong screenshot. Neither
// failure is visible from reading the code.
//
// xlsx-writer only needs TextEncoder and Blob, both of which Node provides, so
// this runs without a browser. Requires `unzip` on PATH.

import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const { buildInventoryXlsx } = await import(join(HERE, "..", "lib", "xlsx-writer.js"));

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// A 1x1 PNG. Content is irrelevant — only that the bytes land as image parts.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
  0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
]);

const node = (target, shotId) => ({
  target: [target], xpath: [`/html/body/${target}`], ancestry: ["html > body"],
  failureSummary: "Fix this", html: `<${target}>`, elementShotId: shotId,
  any: [], all: [], none: []
});

const page = (url, shotId, nodes) => ({
  url, title: `Title ${url}`, depth: 1, source: "link",
  template_id: "T1", url_cluster: "/", page_type: "content",
  spa_markers: "", is_spa: false,
  screenshot: shotId ? { id: shotId, bytes: 1000 } : null,
  counts: {}, contentSignals: {}, components: {}, mediaInventory: null,
  axe_version: "4.12.1",
  audit: {
    violations: [{
      ruleId: "image-alt", id: "image-alt", impact: "critical",
      tags: ["wcag2a", "wcag111"], description: "Images need alt",
      help: "Add alt", helpUrl: "https://x.test", nodes
    }],
    passes: [], incomplete: [], inapplicable: []
  }
});

// 2 pages, 3 violating nodes total -> 3 element shots + 2 page shots.
const inventory = {
  seedUrl: "https://example.test/",
  startedAt: new Date(0).toISOString(),
  finishedAt: new Date(1000).toISOString(),
  pages: [
    page("https://example.test/", "shot-p1", [node("img.a", "shot-el-1"), node("img.b", "shot-el-2")]),
    page("https://example.test/two", "shot-p2", [node("img.c", "shot-el-3")])
  ],
  shellPages: [], hashDuplicates: [], brokenLinks: [], pdfRows: [], officeRows: [],
  templates: [], clusters: [], linkGraph: {}, settings: {}, counts: {},
  proposedSample: [], formFields: [], components: [], contentSignals: {},
  manualChecklist: [], scanSettings: {}, testMatrix: [], docRows: [],
  discovery: {}, stats: {}, errors: []
};

const thumbnails = new Map([
  ["shot-p1",   { bytes: PNG, width: 300, height: 200 }],
  ["shot-p2",   { bytes: PNG, width: 300, height: 200 }],
  ["shot-el-1", { bytes: PNG, width: 300, height: 225 }],
  ["shot-el-2", { bytes: PNG, width: 300, height: 225 }],
  ["shot-el-3", { bytes: PNG, width: 300, height: 225 }]
]);

const dir = mkdtempSync(join(tmpdir(), "eu-xlsx-"));
const withThumbs = join(dir, "with-thumbs.xlsx");
const noThumbs = join(dir, "no-thumbs.xlsx");

writeFileSync(withThumbs, Buffer.from(await (await buildInventoryXlsx(inventory, { thumbnails })).arrayBuffer()));
writeFileSync(noThumbs, Buffer.from(await (await buildInventoryXlsx(inventory)).arrayBuffer()));

const list = f => execFileSync("unzip", ["-l", f], { encoding: "utf8" });
const part = (f, p) => execFileSync("unzip", ["-p", f, p], { encoding: "utf8" });
const intact = f => /No errors detected/.test(execFileSync("unzip", ["-t", f], { encoding: "utf8" }));

// ── With thumbnails ──
check("workbook is a valid zip", intact(withThumbs));

const entries = list(withThumbs);
const images = [...entries.matchAll(/xl\/media\/(image\d+\.png)/g)].map(m => m[1]);
check("8 media images embedded (3 inline + 2 pages + 3 dedicated sheet)",
  images.length === 8, `got ${images.length}: ${images.join(",")}`);
check("three drawing parts emitted",
  /drawing1\.xml/.test(entries) && /drawing2\.xml/.test(entries) && /drawing3\.xml/.test(entries));

// Sheet order determines which sheetN.xml.rels each drawing hangs off.
const names = [...part(withThumbs, "xl/workbook.xml").matchAll(/name="([^"]+)"/g)].map(m => m[1]);
const idx1 = n => names.indexOf(n) + 1;
check("Violations is sheet 2, Pages sheet 3", idx1("Violations") === 2 && idx1("Pages") === 3,
  `Violations=${idx1("Violations")} Pages=${idx1("Pages")} IssueShots=${idx1("Issue Screenshots")}`);

for (const [sheet, drawing] of [["Violations", "drawing1.xml"], ["Pages", "drawing2.xml"], ["Issue Screenshots", "drawing3.xml"]]) {
  const rels = part(withThumbs, `xl/worksheets/_rels/sheet${idx1(sheet)}.xml.rels`);
  check(`${sheet} sheet rels point at ${drawing}`, rels.includes(drawing), rels.match(/drawing\d+\.xml/)?.[0]);
}

// The off-by-one that would silently mis-map previews to the wrong screenshot.
const relImages = d => [...part(withThumbs, `xl/drawings/_rels/drawing${d}.xml.rels`).matchAll(/(image\d+\.png)/g)].map(m => m[1]);
check("drawing1 rels -> image1..3", relImages(1).join(",") === "image1.png,image2.png,image3.png", relImages(1).join(","));
check("drawing2 rels -> image4..5", relImages(2).join(",") === "image4.png,image5.png", relImages(2).join(","));
check("drawing3 rels -> image6..8", relImages(3).join(",") === "image6.png,image7.png,image8.png", relImages(3).join(","));

// Header shape: Preview must occupy column A, shifting every other column.
function headerRow(file, sheetIdx) {
  const ss = [...part(file, "xl/sharedStrings.xml").matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(m => m[1]);
  const xml = part(file, `xl/worksheets/sheet${sheetIdx}.xml`);
  const row = xml.match(/<row r="1".*?<\/row>/s)?.[0] || "";
  return [...row.matchAll(/<c r="[A-Z]+1"[^>]*>(?:<v>(\d+)<\/v>)?/g)]
    .map(m => (m[1] != null ? ss[Number(m[1])] : "")).slice(0, 4);
}
check("Violations header starts with Preview when thumbnails present",
  headerRow(withThumbs, 2)[0] === "Preview", headerRow(withThumbs, 2).join(" | "));

// ── Without thumbnails: must keep exactly the pre-v0.5.0 shape ──
check("no-thumbnails workbook is a valid zip", intact(noThumbs));
const noEntries = list(noThumbs);
check("no drawing or media parts without thumbnails",
  !/drawing\d+\.xml/.test(noEntries) && !/xl\/media/.test(noEntries));
check("Violations header unchanged without thumbnails (starts at URL)",
  headerRow(noThumbs, 2)[0] === "URL", headerRow(noThumbs, 2).join(" | "));

console.log(`\n${failures === 0 ? "all checks passed" : failures + " check(s) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
