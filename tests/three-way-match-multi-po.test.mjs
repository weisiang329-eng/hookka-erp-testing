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
  // ⚠ REWRITTEN 2026-08-14 (BUG-2026-08-13-144). This test used to pin the
  // resolution EXPRESSIONS inline in the route — `poItemById.get(lineItemId)`
  // and `(itemsByPo.get(ownerPoId) ?? [])[gi.poItemIndex]`. Both were correct
  // as far as they went and both are gone, because `ownerPoId` fell back to
  // `headerPo.id` (= `pos[0]`, an arbitrary order) whenever the line named no
  // order of its own. The resolution now lives in `src/api/lib/grn-po-line-link.ts`,
  // which COUNTS the claimants and refuses; the rule itself is driven
  // behaviourally in `tests/first-one-wins-refusal.test.mjs`.
  assert.match(SRC, /resolveGrnPoLine\(lineIdx,\s*gi\)/);
  assert.match(SRC, /buildPoLineIndex\(/);
});

test("per-line PO columns are read dual-keyed", () => {
  // They are snake_case in the schema; a driver or view may hand them back
  // camelCased, and a one-sided read silently sees null and falls back.
  // The dual read moved into the resolver with the rest of the logic.
  const LINK = readFileSync(
    resolve(process.cwd(), "src/api/lib/grn-po-line-link.ts"),
    "utf8",
  );
  assert.match(LINK, /line\.po_id \?\? line\.poId/);
  assert.match(LINK, /line\.po_item_id \?\? line\.poItemId/);
});

test("poTotal covers every order the receipt draws down", () => {
  assert.match(SRC, /const poTotal = pos\.reduce\(\(s, p\) => s \+ \(Number\(p\.totalSen\) \|\| 0\), 0\);/);
  assert.doesNotMatch(SRC, /const poTotal = po\.totalSen/);
});

test("the header PO is preserved, so single-PO matches are unchanged", () => {
  // ⚠ REWRITTEN 2026-08-14 (BUG-2026-08-13-144). The old assertion pinned
  // `?? pos[0]` as if it were the fix. It was the second guess: `pos` is loaded
  // from the LINE orders, so on a receipt whose header order is not among them
  // the `.find` misses — the case this code exists for — and `pos[0]` is
  // whichever row `IN (...)` happened to return first. One claimant is kept
  // (single-PO behaviour is bit-identical); several is a refusal.
  assert.match(
    SRC,
    /pos\.find\(\(p\) => p\.id === grn\.poId\) \?\? \(pos\.length === 1 \? pos\[0\] : null\)/,
  );
});

test("the match row records every order, and still names one as the header", () => {
  // `poId` stays so existing readers keep working; `po_ids` carries the set,
  // because a row naming one of two orders reads as if the other were never
  // involved.
  assert.match(SRC, /INSERT INTO three_way_matches \(id, poId, po_ids, poNumber/);
  assert.match(SRC, /JSON\.stringify\(pos\.map\(\(p\) => p\.id\)\)/);
  // `headerPo` is nullable since BUG-2026-08-13-144 — a receipt whose header
  // order is not among its line orders has no single header to name, and
  // `poNumber` already lists every order when there is more than one.
  assert.match(
    SRC,
    /poNumbers\.length > 1 \? poNumbers\.join\(", "\) : \(headerPo\?\.poNo \?\? ""\)/,
  );
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
