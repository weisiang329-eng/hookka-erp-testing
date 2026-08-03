// ---------------------------------------------------------------------------
// grn-create-multi-po.test.mjs — the GRN create page can receive against
// several purchase orders.
//
// Owner 2026-08-04: "可以多个 PO 去 Good receipt". The backend already stored
// per-line PO ownership; this page was the last thing pinning a receipt to one
// purchase order. The pins below are the ones that keep the MONEY right:
//
//   • each line must carry its OWN poId/poItemId, or the second PO is never
//     drawn down;
//   • re-picking a line already on the receipt must not double-count it;
//   • a second supplier must be refused — one GRN has one supplier, and
//     silently keeping the first would misattribute the goods.
//
// Source-level pins (house style for this page — no DOM render).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/pages/procurement/grn/create.tsx"),
  "utf8",
);

test("a receipt line names its own PO line", () => {
  assert.match(SRC, /type POItemEntry = \{\s*\n\s*poId: string;\s*\n\s*poItemId: string;/);
});

test("lines are keyed per (PO, line) — an index alone collides across POs", () => {
  assert.match(SRC, /function entryKey\(/);
  assert.match(SRC, /\$\{e\.poId\}:\$\{e\.poItemId \|\| e\.poItemIndex\}/);
  assert.match(SRC, /key=\{entryKey\(entry\)\}/);
});

test("adding a PO APPENDS instead of replacing the receipt", () => {
  assert.match(SRC, /setPoItemEntries\(\(prev\) => \{[\s\S]*?\.\.\.prev,/);
});

test("a PO line already on the receipt cannot be added twice", () => {
  assert.match(SRC, /const seen = new Set\(prev\.map\(entryKey\)\)/);
  assert.match(SRC, /incoming\.filter\(\(e\) => !seen\.has\(entryKey\(e\)\)\)/);
});

test("a second supplier is refused rather than silently mislabelled", () => {
  assert.match(SRC, /res\.supplierName !== convertSupplierName/);
  assert.match(SRC, /Create a separate GRN for/);
});

test("the FIRST PO stays the header PO when more are added", () => {
  assert.match(SRC, /if \(!selectedPO\) \{[\s\S]*?setSelectedPO\(res\.poId\)/);
});

test("submit sends each line's own PO, not just the header", () => {
  assert.match(SRC, /poId: ie\.poId \|\| selectedPO/);
  assert.match(SRC, /poItemId: ie\.poItemId \|\| null/);
});

test("a line resolves against its own PO, falling back to the header", () => {
  assert.match(SRC, /const poItemForEntry = \(e: POItemEntry\)/);
  assert.match(SRC, /const owner = poById\.get\(e\.poId\) \?\? po/);
  // Prefer the real line id; index is the legacy fallback.
  assert.match(SRC, /owner\.items\.find\(\(it\) => String\(it\.id \?\? ""\) === e\.poItemId\)/);
});

test("rows show which PO they draw down once several are involved", () => {
  assert.match(SRC, /linkedPoIds\.length > 1 && ownerPo\?\.poNo/);
});

test("both seeders record the PO line id", () => {
  // Deep-link (?poId=) and Convert-from-PO must both produce resolvable rows,
  // or their lines fall back to the fragile positional path.
  assert.match(SRC, /poId: po\.id,\s*\n\s*poItemId: String\(item\.id \?\? ""\)/);
  assert.match(SRC, /poId: res\.poId,\s*\n\s*poItemId: String\(/);
});

test("the button says what it now does", () => {
  assert.match(SRC, /poItemEntries\.length > 0 \? "Add another PO" : "Convert from PO"/);
});
