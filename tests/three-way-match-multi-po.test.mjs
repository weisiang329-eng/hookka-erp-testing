// ---------------------------------------------------------------------------
// three-way-match-multi-po.test.mjs — match a receipt against the orders it
// actually draws down.
//
// A GRN may span several purchase orders (`grn_items.po_id`). The matcher was
// written when it could not, and it stayed that way after the receipt side
// changed, which left two silent defects:
//
//   1. every line was scored against `poItems[poItemIndex]` on the HEADER PO,
//      and only the header's lines were loaded. A second-PO line therefore took
//      its ordered quantity and price from whatever sat at that index on the
//      first order — inventing mismatches, or worse, agreeing by accident;
//   2. `poTotal` was the header order's ENTIRE value, compared against a
//      receipt whose goods were partly another order's. The variance is then
//      measuring two different things, and it can land inside the 2% tolerance
//      by coincidence — a FULL_MATCH nobody should trust.
//
// Neither surfaces as an error. That is what makes them worth a test.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/routes/three-way-match.ts"),
  "utf8",
);

test("the orders come from the receipt's LINES, not from its header", () => {
  assert.match(SRC, /const linePoIds = \[/);
  assert.match(
    SRC,
    /const poIds = linePoIds\.length > 0 \? linePoIds : grn\.poId \? \[grn\.poId\] : \[\];/,
    "a receipt with no per-line ownership must still match on the header",
  );
});

test("every order's lines are loaded, not just the header's", () => {
  assert.match(
    SRC,
    /SELECT \* FROM purchase_order_items WHERE purchaseOrderId IN \(\$\{placeholders\}\)/,
  );
  assert.match(SRC, /SELECT id, poNo, totalSen FROM purchase_orders WHERE id IN \(/);
});

test("a line is scored against its OWN order's line", () => {
  assert.doesNotMatch(
    SRC,
    /poItems\[gi\.poItemIndex\]/,
    "indexing the header order's lines is exactly the bug",
  );
  assert.match(SRC, /poItemById\.get\(lineItemId\)/, "an explicit line id is unambiguous");
  assert.match(
    SRC,
    /\(itemsByPo\.get\(ownerPoId\) \?\? \[\]\)\[gi\.poItemIndex\]/,
    "the index must be read on the line's own order",
  );
});

test("per-line PO columns are read dual-keyed", () => {
  // They are snake_case in the schema; a driver or view may hand them back
  // camelCased, and a one-sided read silently sees null and falls back.
  assert.match(SRC, /gi\.po_id \?\? gi\.poId/);
  assert.match(SRC, /gi\.po_item_id \?\? gi\.poItemId/);
});

test("poTotal covers every order the receipt draws down", () => {
  assert.match(SRC, /const poTotal = pos\.reduce\(\(s, p\) => s \+ \(Number\(p\.totalSen\) \|\| 0\), 0\);/);
  assert.doesNotMatch(SRC, /const poTotal = po\.totalSen/);
});

test("the header PO is preserved, so single-PO matches are unchanged", () => {
  assert.match(SRC, /const headerPo = pos\.find\(\(p\) => p\.id === grn\.poId\) \?\? pos\[0\];/);
});

test("the match row records every order, and still names one as the header", () => {
  // `poId` stays so existing readers keep working; `po_ids` carries the set,
  // because a row naming one of two orders reads as if the other were never
  // involved.
  assert.match(SRC, /INSERT INTO three_way_matches \(id, poId, po_ids, poNumber/);
  assert.match(SRC, /JSON\.stringify\(pos\.map\(\(p\) => p\.id\)\)/);
  assert.match(SRC, /poNumbers\.length > 1 \? poNumbers\.join\(", "\) : headerPo\.poNo/);
});

test("reads expose the full set and fall back for older rows", () => {
  assert.match(SRC, /function parsePoIds\(row: ThreeWayMatchRow\): string\[\]/);
  assert.match(SRC, /return row\.poId \? \[row\.poId\] : \[\];/);
  assert.match(SRC, /poIds: parsePoIds\(row\)/);
});

test("the new column is self-applied before the first write", () => {
  // Migrations are inert on deploy in this repo — a migration file alone would
  // leave the INSERT failing on a missing column in production.
  assert.match(
    SRC,
    /ALTER TABLE three_way_matches ADD COLUMN IF NOT EXISTS po_ids TEXT/,
  );
  assert.match(SRC, /await ensureTwmMigrations\(c\.var\.DB\);/);
  // Boolean memo, not a cached promise — see self-apply-memo-is-boolean.
  assert.match(SRC, /^let _twmColumnsApplied = false;$/m);
  assert.match(SRC, /_twmColumnsApplied = true;/);
});

test("the schema fixture records the self-applied column", () => {
  const schema = JSON.parse(
    readFileSync(resolve(process.cwd(), "tests/db-schema.json"), "utf8"),
  );
  assert.ok(schema.three_way_matches.includes("po_ids"));
});
