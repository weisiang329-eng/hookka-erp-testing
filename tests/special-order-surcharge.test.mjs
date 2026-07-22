// Tests for the special-order surcharge derivation (BUG-2026-07-17-002).
//
// The bug: scan-a-customer-PO paths POST /api/sales-orders directly with the
// specialOrder TEXT but no specialOrderPriceSen, so the backend stored 0 and the
// option was never charged. RM 8,060 across 66 SOs on prod. The typed form sends
// the number and was always correct — so the fix must derive ONLY on omission,
// never override a supplied value (that would over-bill, and would start
// charging Service Orders which are free by design).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveSpecialOrderSurchargeSen,
  resolveSpecialOrderPriceSen,
  parseSpecialOrderTokens,
  HB_DIVAN_COMBINED_SEN,
} from "../src/lib/special-order-surcharge.ts";

test("derives the real prod case: Divan Full Cover = RM 80", () => {
  // INV-2607-060 lines 5 + 6 (SO-2607-043) — stored 0, should have been 8000.
  assert.equal(deriveSpecialOrderSurchargeSen("Divan Full Cover"), 8000);
});

test("derives the real prod case: Divan Curve = RM 50", () => {
  // INV-2607-060 line 3 (SO-2607-014).
  assert.equal(deriveSpecialOrderSurchargeSen("Divan Curve"), 5000);
});

test("accepts BOTH separators — the two writers disagree", () => {
  // sales/create.tsx joins with "; ", scan-po.ts:430 joins with ", ".
  // 2026-07-23: was 16000, when the static catalog had Front Drawer at
  // RM 120 and "No Side Panel" as a +RM 40 SURCHARGE. The live config has
  // RM 130 and −RM 40 (it is a discount), and the catalog now matches it:
  // 13000 - 4000 = 9000. The old number encoded the sign error.
  assert.equal(deriveSpecialOrderSurchargeSen("Front Drawer; No Side Panel"), 9000);
  assert.equal(deriveSpecialOrderSurchargeSen("Front Drawer, No Side Panel"), 9000);
});

test("HB + Divan full cover combined is capped at RM 100, not 130", () => {
  // The owner's rule (pricing-options.ts:66). 10 lines on prod hit this — my
  // first sweep over-counted them as RM 130 and reported RM 8,390 instead of
  // RM 8,060.
  assert.equal(
    deriveSpecialOrderSurchargeSen("HB Fully Cover, Divan Full Cover"),
    HB_DIVAN_COMBINED_SEN,
  );
  assert.equal(deriveSpecialOrderSurchargeSen("HB Fully Cover, Divan Full Cover"), 10000);
  // Order must not matter — prod has it written both ways.
  assert.equal(deriveSpecialOrderSurchargeSen("Divan Full Cover, HB Fully Cover"), 10000);
});

test("combined cap still adds OTHER options on the same line", () => {
  // "Divan Full Cover, HB Fully Cover, Front Drawer" = 100 + 130.
  // Front Drawer was RM 120 in the static catalog until 2026-07-23, when it
  // was realigned to the live config's RM 130.
  assert.equal(
    deriveSpecialOrderSurchargeSen("Divan Full Cover, HB Fully Cover, Front Drawer"),
    10000 + 13000,
  );
});

test("either cover alone is NOT capped", () => {
  assert.equal(deriveSpecialOrderSurchargeSen("HB Fully Cover"), 5000);
  assert.equal(deriveSpecialOrderSurchargeSen("Divan Full Cover"), 8000);
});

test("zero-surcharge options stay free", () => {
  // SO-2607-060 carries "HB Straight" — a real option worth RM 0.
  assert.equal(deriveSpecialOrderSurchargeSen("HB Straight"), 0);
  assert.equal(deriveSpecialOrderSurchargeSen("HB Straight, Divan Curve"), 5000);
});

test("unknown tokens contribute 0 — never invent a price", () => {
  assert.equal(deriveSpecialOrderSurchargeSen("Something The OCR Made Up"), 0);
  assert.equal(deriveSpecialOrderSurchargeSen("Divan Curve, Not A Real Option"), 5000);
});

test("OTHER: tokens are not priced from the catalog", () => {
  // They're operator free-text; their money rides in customSpecials.
  assert.deepEqual(parseSpecialOrderTokens("Divan Curve; OTHER: paint it red"), [
    "Divan Curve",
  ]);
  assert.equal(deriveSpecialOrderSurchargeSen("Divan Curve; OTHER: paint it red"), 5000);
});

test("custom specials add their own surcharge; junk is ignored", () => {
  assert.equal(
    deriveSpecialOrderSurchargeSen("Divan Curve", [
      { description: "paint", surchargeSen: 2500 },
      { description: "negative", surchargeSen: -900 },
      { description: "nan", surchargeSen: Number.NaN },
      { description: "missing" },
    ]),
    5000 + 2500,
  );
});

test("a repeated token is charged once", () => {
  assert.equal(deriveSpecialOrderSurchargeSen("Divan Curve, Divan Curve"), 5000);
});

test("owner's kv_config price overrides the static catalog", () => {
  const cfg = [{ value: "Divan Full Cover", priceSen: 9500 }];
  assert.equal(deriveSpecialOrderSurchargeSen("Divan Full Cover", null, cfg), 9500);
  // An override of 0 must be honoured, not treated as "missing".
  assert.equal(
    deriveSpecialOrderSurchargeSen("Divan Full Cover", null, [
      { value: "Divan Full Cover", priceSen: 0 },
    ]),
    0,
  );
  // Config that doesn't mention the option falls back to the catalog.
  assert.equal(
    deriveSpecialOrderSurchargeSen("Divan Curve", null, [
      { value: "Front Drawer", priceSen: 1 },
    ]),
    5000,
  );
});

test("empty / null text is free", () => {
  assert.equal(deriveSpecialOrderSurchargeSen(""), 0);
  assert.equal(deriveSpecialOrderSurchargeSen(null), 0);
  assert.equal(deriveSpecialOrderSurchargeSen(undefined), 0);
});

// ── The trust model — the part that must not over-bill ──────────────────────

test("TRUSTS a client-supplied number and derives nothing", () => {
  // The typed form computes the surcharge itself and always sends it.
  assert.equal(
    resolveSpecialOrderPriceSen({
      specialOrder: "Divan Full Cover",
      specialOrderPriceSen: 8000,
    }),
    8000,
  );
});

test("Service Order mode stays FREE — an explicit 0 is never overridden", () => {
  // SVs are free by default (arch_service_order_pricing). The form sends 0 on
  // purpose; deriving here would start charging for repairs.
  assert.equal(
    resolveSpecialOrderPriceSen({
      specialOrder: "Divan Full Cover, HB Fully Cover",
      specialOrderPriceSen: 0,
    }),
    0,
  );
});

test("an operator's deliberate custom price is never overridden", () => {
  assert.equal(
    resolveSpecialOrderPriceSen({
      specialOrder: "Divan Full Cover",
      specialOrderPriceSen: 3000, // discounted by hand
    }),
    3000,
  );
});

test("DERIVES only when the field is omitted — the scan paths", () => {
  // scan-po-modal.tsx / ScanPOSheet.tsx send no specialOrderPriceSen at all.
  assert.equal(
    resolveSpecialOrderPriceSen({ specialOrder: "Divan Full Cover" }),
    8000,
  );
  assert.equal(
    resolveSpecialOrderPriceSen({
      specialOrder: "Divan Full Cover",
      specialOrderPriceSen: null,
    }),
    8000,
  );
});

test("omitted + no specials = 0 (a plain scanned line is untouched)", () => {
  assert.equal(resolveSpecialOrderPriceSen({ specialOrder: "" }), 0);
  assert.equal(resolveSpecialOrderPriceSen({}), 0);
});

test("string numbers from a JSON body are trusted, not re-derived", () => {
  assert.equal(
    resolveSpecialOrderPriceSen({
      specialOrder: "Divan Full Cover",
      specialOrderPriceSen: "8000",
    }),
    8000,
  );
});

test("INV-2607-060 reconstructed: the three missed lines total RM 210", () => {
  const lines = [
    { specialOrder: "Divan Curve" }, // line 3  — SO-2607-014
    { specialOrder: "Divan Full Cover" }, // line 5  — SO-2607-043
    { specialOrder: "Divan Full Cover" }, // line 6  — SO-2607-043
  ];
  const total = lines.reduce((s, l) => s + resolveSpecialOrderPriceSen(l), 0);
  assert.equal(total, 21000);
});
