// ---------------------------------------------------------------------------
// production-lock-scope.test.mjs — regression test for Bug 1 (2026-04-26).
//
// Bug history: completing a Wood Cut JC locked the Fab Cut + Fab Sew cells
// on the SAME row in the Production Sheet — but those three are independent
// component chains (different wipKey) in a Bedframe BOM:
//   Divan chain   = WOOD_CUT, FRAMING, WEBBING, UPHOLSTERY, PACKING
//   HB chain      = FAB_CUT, FAB_SEW, FOAM, UPHOLSTERY, PACKING
//
// The frontend's `buildSched` was being passed a `siblings` list pre-filtered
// by the ROW's wipKey. When a column rendered a card from a different chain
// (e.g. the FAB_CUT column on a WOOD_CUT row, where picker fell back to "any
// FAB_CUT JC on this PO" and returned the HB-chain card), the lock predicate
// then ran against DIVAN siblings and saw WOOD_CUT in the COMPLETED state at
// a higher DEPT_ORDER position than FAB_CUT — flipping the FAB_CUT cell to
// `locked: true` erroneously.
//
// Fix: buildSched filters siblings by the **card's own** wipKey, not the
// row's. So per-column DeptSched objects only see siblings from the same
// chain as the card being rendered.
//
// This is a structural test — we read the source and assert the predicate
// shape is correct, mirroring production-patch-guard.test.mjs.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(
  process.cwd(),
  'src/pages/production/index.tsx',
);

function read() {
  return readFileSync(SRC, 'utf8');
}

test('buildSched scopes lock siblings to the card\'s own wipKey, not the row\'s', () => {
  const src = read();
  // The function must compute its sibling list inside buildSched using
  // card.wipKey, not accept a pre-filtered siblings array. If a refactor
  // re-introduces a row-scoped pre-filter, the cross-chain false-positive
  // returns and Wood Cut completion locks Fab Cut again.
  assert.match(
    src,
    /const cardSiblings = card\.wipKey\s*\?\s*poJobCards\.filter\(\(j\) => j\.wipKey === card\.wipKey\)\s*:\s*poJobCards;/,
    'buildSched should filter siblings by card.wipKey',
  );
  // The lock predicate iterates the wipKey-scoped list, not the raw param.
  assert.match(
    src,
    /const locked = myPos >= 0 && cardSiblings\.some\(\(j\) =>/,
    'lock predicate should iterate cardSiblings (the wipKey-scoped list)',
  );
});

test('buildSched is called with the full PO JC list (not a pre-filtered subset)', () => {
  const src = read();
  // The call site passes `poJobCards` (the whole PO's JCs) — buildSched then
  // does the wipKey filtering itself. If a future refactor switches back to
  // pre-filtering at the call site, this regression returns.
  const callMatches = src.match(/buildSched\(picker\("[A-Z_]+"\),\s*today,\s*o\.id,\s*poJobCards\)/g);
  assert.ok(
    callMatches && callMatches.length >= 8,
    `expected 8 buildSched calls (one per dept), found ${callMatches?.length ?? 0}`,
  );
});

test('Wood Cut and Fab Cut are recognised as different wipKey chains by the BOM walker', () => {
  // Sanity check that the source-of-truth BOM walker still emits different
  // wipKey values per top-level component. If this test fails, the entire
  // premise of wipKey-scoped locks falls apart.
  const builder = readFileSync(
    resolve(process.cwd(), 'src/lib/production-order-builder.ts'),
    'utf8',
  );
  // walkWip emits wipKey: topWipType (the parent BOM node's wipType, e.g.
  // "DIVAN" or "HEADBOARD"). If a refactor switches wipKey to something
  // else (e.g. a hash of node-id), the wipKey-scoped lock breaks.
  assert.match(
    builder,
    /wipKey:\s*topWipType,/,
    'production-order-builder should set wipKey = topWipType on every JC',
  );
});
