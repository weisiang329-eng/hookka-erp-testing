// ---------------------------------------------------------------------------
// special-order-combo-discount.test.mjs — the HB + Divan Top combo is a
// DISCOUNT off the sum, not a hardcoded total, and it is on the right pair.
//
// Owner 2026-08-02, from a live order showing chips of +RM50 and +RM80 beside a
// surcharge field reading RM 100:「为什么这边 SpecialOrder 是显示加 50 还有加
// 80,在外面却是显示加 100?」
//
// What was here: a flat RM 100 TOTAL applied to HB Fully Cover + Divan FULL
// Cover. Wrong twice over —
//   * wrong pair. The rule is HB + Divan **TOP** Fully Cover. HB + Divan FULL
//     Cover has no rule at all: 50 + 80 = 130, and it had been charging 100.
//   * a flat TOTAL hardcodes the prices. Owner:「不要放死价格」— they edit
//     special-order prices in Settings, and "100" stops meaning anything the
//     moment either price moves.
//
// Owner's ruling on history:「旧的 order 就算了 新的 order 确保要全部跟着」.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deriveSpecialOrderSurchargeSen,
  HB_DIVAN_TOP_COMBO_DISCOUNT_SEN,
} from "../src/lib/special-order-surcharge.ts";

test("HB + Divan TOP Fully Cover = 50 + 50 − 20 = RM 80", () => {
  assert.equal(HB_DIVAN_TOP_COMBO_DISCOUNT_SEN, 2000);
  assert.equal(
    deriveSpecialOrderSurchargeSen("HB Fully Cover; Divan Top Fully Cover"),
    8000,
  );
});

test("HB + Divan FULL Cover has NO rule — it is simply 50 + 80 = RM 130", () => {
  // This is the one that was under-charging: RM 100 instead of RM 130.
  assert.equal(
    deriveSpecialOrderSurchargeSen("HB Fully Cover; Divan Full Cover"),
    13000,
  );
});

test("each option alone is its own price", () => {
  assert.equal(deriveSpecialOrderSurchargeSen("HB Fully Cover"), 5000);
  assert.equal(deriveSpecialOrderSurchargeSen("Divan Top Fully Cover"), 5000);
  assert.equal(deriveSpecialOrderSurchargeSen("Divan Full Cover"), 8000);
});

test("the discount FOLLOWS the owner's prices — nothing is hardcoded", () => {
  // Settings raises both covers to RM 90; the combo must become 90+90−20 = 160,
  // not stay at some frozen total.
  const cfg = [
    { value: "HB Fully Cover", priceSen: 9000 },
    { value: "Divan Top Fully Cover", priceSen: 9000 },
  ];
  assert.equal(
    deriveSpecialOrderSurchargeSen("HB Fully Cover; Divan Top Fully Cover", null, cfg),
    16000,
  );
});

test("the discount itself is overridable, and can never become a credit", () => {
  assert.equal(
    deriveSpecialOrderSurchargeSen("HB Fully Cover; Divan Top Fully Cover", null, null, 1000),
    9000,
  );
  // A discount larger than the sum must floor at zero, however prices are edited.
  assert.equal(
    deriveSpecialOrderSurchargeSen("HB Fully Cover; Divan Top Fully Cover", null, null, 999999),
    0,
  );
});

test("a third option is added on top of the discounted pair", () => {
  // 50 + 50 − 20 + 160 (Left Drawer)
  assert.equal(
    deriveSpecialOrderSurchargeSen(
      "HB Fully Cover; Divan Top Fully Cover; Left Drawer",
    ),
    8000 + 16000,
  );
});

test("ONE implementation — the create form no longer carries its own copy", () => {
  // Two implementations of one money rule is how the two sides drift, and a
  // price that drifts is not a display bug.
  const create = readFileSync("src/pages/sales/create.tsx", "utf8");
  assert.match(create, /deriveSpecialOrderSurchargeSen\(names\.join\("; "\)\)/);
  assert.doesNotMatch(create, /total \+= 10000/);
  assert.doesNotMatch(create, /DIVAN_BTM_COVER/);
});

test("the catalog note says what the code does", () => {
  const opts = readFileSync("src/lib/pricing-options.ts", "utf8");
  assert.match(opts, /If HB & divan top full cover combined = discount RM20/);
  assert.doesNotMatch(opts, /RM100 total/);
});
