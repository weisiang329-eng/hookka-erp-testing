// ---------------------------------------------------------------------------
// cn-packing-list.test.mjs — pin the consolidated CN packing-list print
// (owner decision "2B", 2026-06-11).
//
// The feature is pure frontend: select CNs on the list page, click Print
// Packing List, get ONE PDF = cover summary page + every CN's full branded
// document, page-numbered continuously. Three contracts are cheap to break
// in a refactor and invisible until an operator prints:
//
//   1. generate-cn-pdf.ts: printCnPackingList must build a compressed doc
//      (compress:true is a house rule after BUG-2026-06-11-015), render the
//      cover via renderCnPackingSummary, draw every CN through the SAME
//      renderCnInto the single-CN print uses (fresh page each), and stamp
//      footers exactly ONCE at the end so "Page X of Y" spans the file.
//   2. note.tsx: the single-CN print and the batch print must BOTH assemble
//      their payload through the shared buildCnPdfData helper — a second
//      hand-rolled assembly is exactly the drift this helper exists to
//      prevent (hub address/contact/state/transport resolution).
//   3. note.tsx: the toolbar control exists, batch order is CN number
//      ascending, and the PDF module stays lazy-imported (own chunk).
//
// Regex-on-source, same pattern as data-grid-fill.test.mjs — catches "agent
// simplified the call path" at commit level without a DOM test runner.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PDF_SRC = readFileSync(
  join(process.cwd(), "src", "lib", "generate-cn-pdf.ts"),
  "utf8",
);
const PAGE_SRC = readFileSync(
  join(process.cwd(), "src", "pages", "consignment", "note.tsx"),
  "utf8",
);

// Source slice from a marker to end-of-file. printCnPackingList is the
// file's last export, so this bounds its body well enough for the pins.
function sliceFrom(src, marker) {
  const at = src.indexOf(marker);
  assert.notEqual(at, -1, `${marker} must exist in source`);
  return src.slice(at);
}

test("printCnPackingList builds a compressed A4 portrait document", () => {
  const body = sliceFrom(PDF_SRC, "export function printCnPackingList");
  assert.match(
    body,
    /new jsPDF\(\{ orientation: "portrait", unit: "mm", format: "a4", compress: true \}\)/,
    "constructor must keep compress:true (house rule after BUG-2026-06-11-015)",
  );
  assert.match(
    body,
    /Consignment-PackingList-\$\{stamp\}\.pdf/,
    "filename must be Consignment-PackingList-<YYYY-MM-DD>.pdf",
  );
});

test("each CN renders in full on a fresh page, footers stamped once after all", () => {
  // The render/stamp split exists exactly for this: renderCnInto per CN in
  // a loop, stampCnFooters ONCE at the end so page numbering is continuous.
  const body = sliceFrom(PDF_SRC, "export function printCnPackingList");
  assert.match(
    body,
    /cns\.forEach\(\(cn\) => \{\s*doc\.addPage\(\);\s*renderCnInto\(doc, cn\);\s*\}\);/,
    "every CN must start on addPage() and render via renderCnInto",
  );
  const stampCalls = body.match(/stampCnFooters\(doc\);/g) || [];
  assert.equal(
    stampCalls.length,
    1,
    "stampCnFooters must run exactly once across the whole document",
  );
  assert.ok(
    body.indexOf("stampCnFooters(doc);") > body.indexOf("cns.forEach"),
    "stampCnFooters must run AFTER all CNs are rendered",
  );
  // The split itself must stay exported — the page's single-CN path and
  // this batch path both depend on it.
  assert.match(PDF_SRC, /export function renderCnInto\(/);
  assert.match(PDF_SRC, /export function stampCnFooters\(/);
});

test("cover summary page carries the title, per-CN table, and grand totals", () => {
  assert.match(
    PDF_SRC,
    /"CONSIGNMENT PACKING LIST"/,
    "cover title must be CONSIGNMENT PACKING LIST",
  );
  const fn = sliceFrom(PDF_SRC, "export function printCnPackingList");
  assert.match(
    fn,
    /renderCnPackingSummary\(doc, cns\);/,
    "cover summary must render before the per-CN pages",
  );
  const cover = sliceFrom(PDF_SRC, "function renderCnPackingSummary");
  for (const col of ['"CN No."', '"Customer"', '"Deliver To"', '"State"', '"Items"', '"Qty"']) {
    assert.ok(cover.includes(col), `summary table must keep the ${col} column`);
  }
  assert.match(
    cover,
    /\$\{grandQty\} PCS/,
    "grand-total row must total pieces in the CN doc's `N PCS` format",
  );
  assert.match(
    cover,
    /grandM3\.toFixed\(2\)/,
    "grand-total row must total m3 to 2dp like the CN items footer",
  );
});

test("single print and batch print share the one payload assembler", () => {
  assert.match(
    PAGE_SRC,
    /const buildCnPdfData = useCallback\(/,
    "shared CNPdfData assembler must exist",
  );
  assert.match(
    PAGE_SRC,
    /generateCNPdf\(buildCnPdfData\(row\), mode\);/,
    "single-CN print must assemble via buildCnPdfData",
  );
  assert.match(
    PAGE_SRC,
    /printCnPackingList\(selected\.map\(buildCnPdfData\)\);/,
    "batch print must assemble via buildCnPdfData (no copy-pasted assembly)",
  );
  // Lazy import in BOTH paths — jsPDF must stay out of the page bundle.
  const lazyImports =
    PAGE_SRC.match(/await import\("@\/lib\/generate-cn-pdf"\)/g) || [];
  assert.ok(
    lazyImports.length >= 2,
    "both print paths must lazy-import the PDF module (own chunk)",
  );
});

test("toolbar wires Print Packing List with CN-number-ascending order", () => {
  assert.match(
    PAGE_SRC,
    /Print Packing List/,
    "bulk toolbar must offer the Print Packing List control",
  );
  assert.match(
    PAGE_SRC,
    /void handlePrintPackingList\(\)/,
    "control must invoke the batch print handler",
  );
  assert.match(
    PAGE_SRC,
    /\.sort\(\(a, b\) => a\.cnNo\.localeCompare\(b\.cnNo\)\)/,
    "batch must order CNs by CN number ascending",
  );
});
