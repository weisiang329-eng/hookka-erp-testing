// ---------------------------------------------------------------------------
// repricer-total-height
//
// Owner 2026-08-24, briefing the July/August price backfill:
//
//   「确保 BedFrame 包含 D1 price、leg price、total height price、special order
//     price，再加上 Sofa 等等，全部都要有。你看一下，确保了解它的源代码是怎么
//     计算 costing 的。」
//
// He named the term that was missing. The repricer built its unit price by
// hand —
//
//     priceSen + legPriceSen + divanPriceSen + specialOrderPriceSen
//
// — while every WRITE path builds it through `calculateUnitPrice`, which also
// carries `totalHeightPriceSen`. Measured on prod the same day: of the live
// July/August lines carrying a height surcharge, 11 of 11 have
// `unitPriceSen = base + leg + divan + special + totalHeight`. So repricing a
// bedframe with a height surcharge would have SILENTLY REMOVED it — a lower
// price on an order already sent to a customer, with nothing in the output
// naming the missing term.
//
// The same hand-rolled sum existed in SIX places: the SO repricer and the CO
// repricer, plus TWO combo-residual passes inside each. The first sweep found
// four; the guard below went red on the last two, which were written on one
// line and so escaped the multi-line pattern. Fixing the instance in front of
// you and missing its twin is this repo's documented failure mode — the count
// is asserted here so a seventh copy cannot appear quietly.
//
// It is also the THIRD time this exact term has gone missing:
// `lib/sofa-combo-pass.ts:228` still carries the comment from the last one
// ("Was a hardcoded 0"), and the canonical engine `lib/sofa-combo.ts` has
// carried it correctly all along. The repricers were stale copies.
//
// `discountSen` was missing from the line total for the same reason. Zero on
// every live line today — which is exactly how it would have stayed invisible
// until the first discounted line was repriced.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  calculateUnitPrice,
  calculateLineTotalWithDiscount,
} from '../src/lib/pricing.ts';

const SRC = readFileSync('src/api/routes/import-completion/sofa-pricing.ts', 'utf8');

// --- the term itself -----------------------------------------------------
test('the canonical build-up carries the total-height surcharge', () => {
  // If this ever stops being true, the repricer is right to omit it and this
  // whole file is wrong. Pin it.
  const withHeight = calculateUnitPrice({
    basePriceSen: 85000,
    divanPriceSen: 5500,
    legPriceSen: 16000,
    totalHeightPriceSen: 8000,
    specialOrderPriceSen: 13000,
  });
  const withoutHeight = calculateUnitPrice({
    basePriceSen: 85000,
    divanPriceSen: 5500,
    legPriceSen: 16000,
    totalHeightPriceSen: 0,
    specialOrderPriceSen: 13000,
  });
  assert.equal(withHeight - withoutHeight, 8000, 'the surcharge is part of the unit price');
  assert.equal(withHeight, 127500, 'RM 1,275.00 — base + every surcharge');
});

test('dropping it costs the customer-facing price exactly the surcharge', () => {
  // The shape of the bug, in money: a 26" total height at RM 80 on 3 units.
  const line = { qty: 3, base: 85000, divan: 0, leg: 0, height: 8000, special: 0 };
  const correct = calculateLineTotalWithDiscount(
    calculateUnitPrice({
      basePriceSen: line.base,
      divanPriceSen: line.divan,
      legPriceSen: line.leg,
      totalHeightPriceSen: line.height,
      specialOrderPriceSen: line.special,
    }),
    line.qty,
    0,
  );
  const handRolled = (line.base + line.leg + line.divan + line.special) * line.qty;
  assert.equal(correct, 279000);
  assert.equal(handRolled, 255000);
  assert.equal(correct - handRolled, 24000, 'RM 240 quietly removed from one line');
});

test('a per-line discount is subtracted, and cannot invert the line', () => {
  assert.equal(calculateLineTotalWithDiscount(100000, 2, 15000), 185000);
  assert.equal(calculateLineTotalWithDiscount(100000, 1, 0), 100000);
});

// --- and no copy of the old sum survives ---------------------------------
test('no repricer rebuilds the unit price by hand', () => {
  // Six sites carried this: two endpoints x (main pass + two combo residuals).
  assert.equal(
    /priceSen \+ it\.legPriceSen \+ it\.divanPriceSen \+ it\.specialOrderPriceSen/.test(SRC),
    false,
    'the hand-rolled build-up must be gone',
  );
  assert.equal(
    /it\.divanPriceSen \+ it\.legPriceSen \+ it\.specialOrderPriceSen/.test(SRC),
    false,
    'the combo-residual surcharge sum omitted totalHeight too',
  );
  assert.equal(
    /const newLine = newUnit \* it\.quantity/.test(SRC),
    false,
    'the line total must go through the discount-aware helper',
  );
});

test('all SIX surcharge sites were found, not just the first two', () => {
  // The first sweep fixed four and the guard went red on the remaining two —
  // single-line copies in the CO repricer that the multi-line pattern missed.
  // Count them, so a seventh copy cannot appear quietly.
  const sums = SRC.match(/const surchargesPerUnit =/g) ?? [];
  assert.equal(sums.length, 4, 'four combo-residual sites: 2 endpoints x 2 passes');
  for (const m of SRC.matchAll(/const surchargesPerUnit =([\s\S]{0,200}?);/g)) {
    assert.match(m[1], /totalHeightPriceSen/, 'every surcharge sum must carry it');
  }
});

test('every pass uses the shared helpers, in BOTH endpoints', () => {
  const unit = SRC.match(/calculateUnitPrice\(\{/g) ?? [];
  const line = SRC.match(/calculateLineTotalWithDiscount\(/g) ?? [];
  assert.equal(unit.length, 2, 'SO repricer + CO repricer main passes');
  assert.equal(line.length, 4, 'both main passes and both combo residuals');
  assert.match(SRC, /from "\.\.\/\.\.\/\.\.\/lib\/pricing"/, 'imported, not re-implemented');
});

test('the two new columns are actually selected', () => {
  // A term the query never read would default to 0 and look identical to the
  // bug it fixes.
  const selects = SRC.match(/totalHeightPriceSen, discountSen,/g) ?? [];
  assert.equal(selects.length, 2, 'both item queries must select them');
});

test('the row type declares them, so a missing column fails tsc not prod', () => {
  const shared = readFileSync('src/api/routes/import-completion/_shared.ts', 'utf8');
  const row = shared.slice(shared.indexOf('export type SoiRow'), shared.indexOf('export type SoRow'));
  assert.match(row, /totalHeightPriceSen: number;/);
  assert.match(row, /discountSen: number;/);
});
