// ---------------------------------------------------------------------------
// production-foam-packing-ticked-rows.test.mjs — lock test for the Foam-tab
// "Show / Print Packing Stickers (ticked rows)" SO-matching contract.
//
// Bug history:
//   BUG-2026-06-08 — the ticked-rows scope matched the WRONG id, producing 0
//     stickers. Fixed so the ticked rows carry the HUMAN doc number
//     (companySOId / poNo) and the matcher compares it against the human
//     fields o.poNo / o.companySOId / o.companyCOId.
//   BUG-2026-06-22 — REGRESSION of the above. The DataGrid `onSelectionChange`
//     handler that populates `selectedDeptRows` was changed to store
//     `soId: r.salesOrderId || r.consignmentOrderId` — the INTERNAL primary-key
//     UUIDs, not the human doc number. The Foam packing matcher
//     (loadFoamPackingStickers) still compares `selSoIds` against
//     o.poNo / o.companySOId / o.companyCOId (all human numbers), so every
//     comparison missed → "Could not match the ticked rows to any production
//     orders" even though the preview header counted the SOs correctly
//     (distinct UUIDs still count distinct SOs). Re-fixed: store `soId: r.soId`.
//
// Source-level structural test (no DB / no worker runtime), matching the
// pattern of production-orders-dept-narrow-guard.test.mjs. The contract is a
// two-sided invariant split across ~1800 lines (selection writer + matcher),
// trivially re-breakable by a "cleanup" PR, so pin both sides in CI.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FE = resolve(process.cwd(), 'src/pages/production/index.tsx');

function read() {
  return readFileSync(FE, 'utf8');
}

function extractSelectionMapper(src) {
  // The DataGrid onSelectionChange handler that builds selectedDeptRows.
  // Spans from `onSelectionChange={(rows: DeptRow[]) =>` to the closing of
  // the `.map(...)`.
  const m = src.match(
    /onSelectionChange=\{\(rows: DeptRow\[\]\) =>[\s\S]*?rows\.map\(\(r\) => \(\{[\s\S]*?\}\)\),/,
  );
  return m ? m[0] : null;
}

test('selectedDeptRows selection mapper exists', () => {
  const src = read();
  const mapper = extractSelectionMapper(src);
  assert.ok(
    mapper,
    'Could not locate the `onSelectionChange={(rows: DeptRow[]) => ... rows.map((r) => ({ ... }))` ' +
      'block in production/index.tsx. If it was renamed/restructured, update this test — ' +
      'but keep the soId contract below intact.',
  );
});

test('ticked-row soId must be the HUMAN doc number (r.soId), not the internal PK (lock against BUG-2026-06-22 regression)', () => {
  const src = read();
  const mapper = extractSelectionMapper(src);
  assert.ok(mapper, 'selection mapper missing — see previous test');

  // POSITIVE: the mapper must assign soId from r.soId (DeptRow.soId = the
  // human companySOId for SOFA / line-suffixed poNo for BF+ACC).
  assert.match(
    mapper,
    /soId:\s*r\.soId\b/,
    [
      'The ticked-row soId must be sourced from `r.soId` (the human doc number).',
      'DeptRow.soId = companySOId for SOFA, line-suffixed poNo for BF/ACC — exactly',
      'the values the Foam packing matcher compares against (o.poNo / o.companySOId',
      '/ o.companyCOId).',
      '',
      'Mapper captured:',
      mapper,
    ].join('\n'),
  );

  // NEGATIVE: the mapper must NOT source soId from the internal primary keys.
  // r.salesOrderId / r.consignmentOrderId are UUID PKs and never match the
  // human fields the matcher uses → 0 stickers + the "Could not match" toast.
  assert.doesNotMatch(
    mapper,
    /soId:\s*r\.salesOrderId|soId:\s*r\.consignmentOrderId/,
    [
      'The ticked-row soId must NOT be sourced from r.salesOrderId / r.consignmentOrderId.',
      'Those are internal primary-key UUIDs; the Foam packing matcher in',
      'loadFoamPackingStickers compares selSoIds against o.poNo / o.companySOId /',
      'o.companyCOId (human numbers), so a UUID never matches → 0 stickers and the',
      '"Could not match the ticked rows to any production orders" warning.',
      'This was the BUG-2026-06-22 regression. Use `soId: r.soId` instead.',
    ].join('\n'),
  );
});

test('Foam packing matcher still compares the ticked soId set against the human doc fields', () => {
  const src = read();
  // The other half of the contract: loadFoamPackingStickers builds selSoIds
  // from selectedDeptRows[].soId and matches against o.poNo / companySOId /
  // companyCOId. If someone changes the matcher to compare against the
  // internal id instead, the same breakage returns from the other side.
  assert.match(
    src,
    /selSoIds\.has\(o\.poNo\)\s*\|\|\s*selSoIds\.has\(o\.companySOId[\s\S]*?\)\s*\|\|\s*selSoIds\.has\(o\.companyCOId/,
    'loadFoamPackingStickers must match the ticked soId set against the HUMAN doc ' +
      'fields o.poNo / o.companySOId / o.companyCOId. Pairs with the selection-writer ' +
      'lock above — both sides must agree on the human-doc-number contract.',
  );
});
