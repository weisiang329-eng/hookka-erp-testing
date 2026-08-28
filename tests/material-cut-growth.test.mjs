// ---------------------------------------------------------------------------
// material-cut-growth — a bigger order is a BIGGER PIECE, not more pieces.
//
// Owner 2026-08-21, looking at the BOM scaling row on a foam line:
//
//   「海绵 by scaling 如果多一寸就是 24 嘛，那我如果加 1 的话，它又是要加多少
//     length、多少 width 的 usage？这些都没有写。」
//
// He was right: nothing was written, because nothing existed. The BOM could say
// "+N PIECES per inch over base" — correct for a leg or a screw, and physically
// wrong for anything cut from a sheet. A 30" seat does not consume six extra
// slabs of foam; it consumes ONE slab cut six inches longer.
//
// The two features had been built four months apart and never joined up:
//   2026-04-29  the qty scaling row
//   2026-07-31  the cut L × W inputs
//
// The growth rides on the EXISTING rule — same dimension, same baseValue — so
// there can never be two baselines disagreeing about what "over base" means.
//
// 「通常是长度变而已」: the axes are independent and either may stay at 0.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  expandCutSize,
  expandMaterialQty,
  parseMaterialScaling,
} from '../src/api/lib/material-scaling.ts';

const rule = (over = {}) => ({
  dimension: 'seatHeight',
  baseValue: 24,
  perUnit: 0,
  cutLengthPerUnit: 0,
  cutWidthPerUnit: 0,
  ...over,
});

// --- the owner's case ----------------------------------------------------
test("the seat grows 6 inches, so the cut grows 6 inches — length only", () => {
  // 「座高每多 1 寸，长加 1 寸、宽不变」
  const r = rule({ cutLengthPerUnit: 1 });
  const got = expandCutSize(30, 20, [r], { seatHeightInches: 30 });
  assert.deepEqual(got, { lengthIn: 36, widthIn: 20 });
});

test('area — and therefore cost — follows', () => {
  const r = rule({ cutLengthPerUnit: 1 });
  const base = expandCutSize(30, 20, [r], { seatHeightInches: 24 });
  const big = expandCutSize(30, 20, [r], { seatHeightInches: 30 });
  const sheet = 75 * 42;
  assert.equal((base.lengthIn * base.widthIn) / sheet, 600 / 3150);
  assert.equal((big.lengthIn * big.widthIn) / sheet, 720 / 3150);
  assert.ok(big.lengthIn * big.widthIn > base.lengthIn * base.widthIn);
});

// --- nothing that exists today changes ----------------------------------
test('a rule with no cut slopes leaves the typed size EXACTLY alone', () => {
  // Every BOM written before 2026-08-21. This is the whole no-regression claim.
  const got = expandCutSize(30, 20, [rule({ perUnit: 2 })], { seatHeightInches: 35 });
  assert.deepEqual(got, { lengthIn: 30, widthIn: 20 });
});

test('no scaling at all leaves it alone', () => {
  for (const sc of [null, undefined, []]) {
    assert.deepEqual(expandCutSize(30, 20, sc, { seatHeightInches: 35 }), {
      lengthIn: 30,
      widthIn: 20,
    });
  }
});

test('a legacy rule object parses with both slopes defaulting to 0', () => {
  const [parsed] = parseMaterialScaling({ dimension: 'seatHeight', baseValue: 24, perUnit: 1 });
  assert.equal(parsed.cutLengthPerUnit, 0);
  assert.equal(parsed.cutWidthPerUnit, 0);
});

// --- the shape of the rule ----------------------------------------------
test('both axes can grow, independently', () => {
  const r = rule({ cutLengthPerUnit: 1, cutWidthPerUnit: 0.5 });
  assert.deepEqual(expandCutSize(30, 20, [r], { seatHeightInches: 28 }), {
    lengthIn: 34,
    widthIn: 22,
  });
});

test('a SMALLER order shrinks the cut on the same slope', () => {
  // Symmetric, like expandMaterialQty: the BOM records a typical spec, not the
  // smallest one. A 20" seat is genuinely less foam.
  const r = rule({ cutLengthPerUnit: 1 });
  assert.deepEqual(expandCutSize(30, 20, [r], { seatHeightInches: 20 }), {
    lengthIn: 26,
    widthIn: 20,
  });
});

test('a side can never go negative', () => {
  const r = rule({ cutLengthPerUnit: 5 });
  const got = expandCutSize(10, 20, [r], { seatHeightInches: 4 });
  assert.equal(got.lengthIn, 0, 'floored, not negative');
});

test('a dimension the order does not carry is ignored, not guessed', () => {
  const r = rule({ dimension: 'divan', cutLengthPerUnit: 1 });
  assert.deepEqual(expandCutSize(30, 20, [r], { seatHeightInches: 30 }), {
    lengthIn: 30,
    widthIn: 20,
  });
});

test('several rules stack', () => {
  const rules = [
    rule({ dimension: 'seatHeight', baseValue: 24, cutLengthPerUnit: 1 }),
    rule({ dimension: 'leg', baseValue: 1, cutWidthPerUnit: 2 }),
  ];
  assert.deepEqual(expandCutSize(30, 20, rules, { seatHeightInches: 28, legHeightInches: 3 }), {
    lengthIn: 34,
    widthIn: 24,
  });
});

// --- the two mechanisms stay separate -----------------------------------
test('growing the CUT does not also multiply the piece count', () => {
  // The bug this feature exists to avoid: a foam line set to "+1 PCS/inch"
  // consumed six extra whole slabs for a 30" seat. Cut growth must not repeat
  // that from the other side.
  const r = rule({ cutLengthPerUnit: 1 });
  assert.equal(expandMaterialQty(1, [r], { seatHeightInches: 30 }), 1, 'qty untouched');
  assert.equal(expandCutSize(30, 20, [r], { seatHeightInches: 30 }).lengthIn, 36);
});

test('a discrete part still scales by pieces, with the cut untouched', () => {
  const r = rule({ perUnit: 1 });
  assert.equal(expandMaterialQty(4, [r], { seatHeightInches: 27 }), 7);
  assert.deepEqual(expandCutSize(0, 0, [r], { seatHeightInches: 27 }), {
    lengthIn: 0,
    widthIn: 0,
  });
});
