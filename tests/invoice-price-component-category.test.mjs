// ---------------------------------------------------------------------------
// invoice-price-component-category — rule 6 of src/lib/invoice-line-price.ts.
//
// Owner 2026-08-20, looking at a sofa in the price editor: 「为什么 Sofa 的
// invoice 会有 DIVAN leg 呢？」 It did because the editor asked every line for
// all five components regardless of what the line IS.
//
// Divan height and total height are bedframe geometry — total height IS
// divan + gap + leg. The PDF spec line has refused to print them on a sofa
// since the owner's ruling of 2026-05-29; the price editor never learned it.
// A LEG price does apply to a sofa (the same PDF rule prints one), so it stays
// — which is why this is a rule and not "hide three boxes".
//
// The safety property is the important one: a component holding MONEY is always
// shown. Hiding a non-zero value would hide part of the charge, and the
// operator would face a Unit price the visible boxes cannot account for.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { priceComponentApplies } from '../src/lib/invoice-line-price.ts';

test('base and special apply to every category', () => {
  for (const cat of ['SOFA', 'BEDFRAME', 'ACCESSORY', 'SERVICE', '', null, undefined]) {
    assert.equal(priceComponentApplies('base', cat, 0), true, `base / ${cat}`);
    assert.equal(priceComponentApplies('special', cat, 0), true, `special / ${cat}`);
  }
});

test('a sofa is not asked for divan or total height', () => {
  assert.equal(priceComponentApplies('divan', 'SOFA', 0), false);
  assert.equal(priceComponentApplies('totalHeight', 'SOFA', 0), false);
});

test('a sofa IS asked for a leg price — the PDF prints one', () => {
  // The correction that matters: "hide what a sofa does not have" is three
  // boxes if you guess, two if you read the rule that already exists.
  assert.equal(priceComponentApplies('leg', 'SOFA', 0), true);
});

test('an accessory follows the same rule as a sofa', () => {
  assert.equal(priceComponentApplies('divan', 'ACCESSORY', 0), false);
  assert.equal(priceComponentApplies('totalHeight', 'ACCESSORY', 0), false);
  assert.equal(priceComponentApplies('leg', 'ACCESSORY', 0), true);
});

test('a bedframe is asked for all five', () => {
  for (const k of ['base', 'divan', 'leg', 'totalHeight', 'special']) {
    assert.equal(priceComponentApplies(k, 'BEDFRAME', 0), true, k);
  }
});

test('an untagged line is asked for all five — never assume', () => {
  // itemCategory is not always stamped. Showing a box that does not apply is a
  // wasted question; hiding one that does is a hidden charge.
  for (const k of ['base', 'divan', 'leg', 'totalHeight', 'special']) {
    assert.equal(priceComponentApplies(k, '', 0), true, k);
    assert.equal(priceComponentApplies(k, null, 0), true, `${k} / null`);
  }
});

test('a component holding MONEY is shown even where the category says no', () => {
  // The safety property. A sofa carrying a stray divan charge must still show
  // it, or the Unit price stops being explainable by what is on screen.
  assert.equal(priceComponentApplies('divan', 'SOFA', 5500), true);
  assert.equal(priceComponentApplies('totalHeight', 'SOFA', 1), true);
  assert.equal(priceComponentApplies('totalHeight', 'ACCESSORY', 20000), true);
});

test('the editor consults the rule instead of carrying its own copy', () => {
  const src = readFileSync('src/pages/invoices/detail.tsx', 'utf8');
  assert.match(
    src,
    /priceComponentApplies\(k, ex\?\.itemCategory, sen\(shownDraft\[k\]\)\)/,
    'the editor must ask the shared rule, with the value, so money is never hidden',
  );
});
