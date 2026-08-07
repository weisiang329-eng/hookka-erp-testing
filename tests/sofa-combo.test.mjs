// ---------------------------------------------------------------------------
// sofa-combo.test.mjs — the backend sofa-combo pricing helper
// (src/api/lib/sofa-combo.ts), a verbatim port of the create-page logic.
//
// Locks the BYTE-IDENTICAL behaviour: grouping, uniform tier/height, rule
// priority, OR-group subset match, and the floor→round→residual-to-highest
// distribution. If any of these drift, existing combo SO prices would shift.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping on Node 22+ */
}

const { applySofaCombos } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/sofa-combo.ts")).href
);

// ── fixtures ────────────────────────────────────────────────────────────────
function line(over = {}) {
  return {
    key: over.key ?? "k",
    itemCategory: "SOFA",
    baseModel: "5530",
    sizeCode: "2A(LHF)",
    seatHeight: "28",
    fabricCode: "PC151-01",
    fabricTier: "PRICE_2",
    basePriceSen: 0,
    divanPriceSen: 0,
    legPriceSen: 0,
    totalHeightPriceSen: 0,
    specialOrderPriceSen: 0,
    quantity: 1,
    ...over,
  };
}
function rule(over = {}) {
  return {
    baseModel: "5530",
    componentSizes: [["2A(LHF)", "2A(RHF)"], ["L(LHF)", "L(RHF)"]],
    fabricTier: "ANY",
    pricesByHeight: { "28": 200000 },
    customerId: null,
    effectiveFrom: "2026-01-01",
    ...over,
  };
}
const OPTS = { customerId: "cust-1", todayDateStr: "2026-06-10" };

// ── 1. two-piece combo, discount + rounding residual ─────────────────────────
test("2A+L combo: renegotiates bases to the combo total exactly", () => {
  const lines = [
    line({ key: "a", sizeCode: "2A(LHF)", basePriceSen: 125000 }),
    line({ key: "b", sizeCode: "L(RHF)", basePriceSen: 110000 }),
  ];
  const r = applySofaCombos(lines, [rule()], OPTS);
  assert.equal(r.matches.length, 1, "one combo match");
  assert.equal(r.matches[0].discountSen, 35000, "235000 − 200000");
  const a = r.newBaseByKey.get("a");
  const b = r.newBaseByKey.get("b");
  // Owner pricing policy 2026-08-07 — WHOLE RINGGIT unit prices, rounded UP,
  // with the agreed combo total still held exactly. Prorated ideals are
  // 106,382.98 and 93,617.02 sen; rounded up they are RM 1,064 + RM 937 =
  // RM 2,001, one ringgit over the RM 2,000 combo. The give-back goes to the
  // line the rounding flattered most (L(RHF) gained 82.98 sen vs 17.02).
  assert.equal(a, 106400, "2A(LHF) → RM 1,064");
  assert.equal(b, 93600, "L(RHF) → RM 936 (carries the give-back)");
  assert.equal(a % 100, 0, "unit price is a whole ringgit");
  assert.equal(b % 100, 0, "unit price is a whole ringgit");
  assert.equal(a + b, 200000, "group sum equals the combo total to the sen");
});

// ── 2. an extra piece outside the rule keeps its full master price ───────────
test("extra piece (1NA) outside the combo subset is untouched", () => {
  const lines = [
    line({ key: "a", sizeCode: "2A(LHF)", basePriceSen: 125000 }),
    line({ key: "b", sizeCode: "L(RHF)", basePriceSen: 110000 }),
    line({ key: "c", sizeCode: "1NA", basePriceSen: 50000 }),
  ];
  const r = applySofaCombos(lines, [rule()], OPTS);
  assert.ok(r.newBaseByKey.has("a") && r.newBaseByKey.has("b"));
  assert.equal(r.newBaseByKey.has("c"), false, "1NA stays at master price");
});

// ── 3. customer-specific rule beats company-wide ─────────────────────────────
test("priority: customer rule wins over company rule", () => {
  const lines = [
    line({ key: "a", sizeCode: "2A(LHF)", basePriceSen: 125000 }),
    line({ key: "b", sizeCode: "L(RHF)", basePriceSen: 110000 }),
  ];
  const company = rule({ customerId: null, pricesByHeight: { "28": 220000 } });
  const customer = rule({ customerId: "cust-1", pricesByHeight: { "28": 180000 } });
  const r = applySofaCombos(lines, [company, customer], OPTS);
  assert.equal(r.matches[0].comboTotalSen, 180000, "customer combo total used");
  assert.equal(r.matches[0].customerSpecific, true);
  const sum = r.newBaseByKey.get("a") + r.newBaseByKey.get("b");
  assert.equal(sum, 180000);
});

// ── 4. tier mismatch (no ANY) → no combo ─────────────────────────────────────
test("tier mismatch with no ANY rule → no combo", () => {
  const lines = [
    line({ key: "a", sizeCode: "2A(LHF)", basePriceSen: 125000, fabricTier: "PRICE_3" }),
    line({ key: "b", sizeCode: "L(RHF)", basePriceSen: 110000, fabricTier: "PRICE_3" }),
  ];
  const r = applySofaCombos(lines, [rule({ fabricTier: "PRICE_2" })], OPTS);
  assert.equal(r.matches.length, 0);
  assert.equal(r.newBaseByKey.size, 0);
});

// ── 5. a null-tier line disqualifies the whole group ─────────────────────────
test("null tier (untracked fabric) disqualifies the group", () => {
  const lines = [
    line({ key: "a", sizeCode: "2A(LHF)", basePriceSen: 125000, fabricTier: "PRICE_2" }),
    line({ key: "b", sizeCode: "L(RHF)", basePriceSen: 110000, fabricTier: null }),
  ];
  const r = applySofaCombos(lines, [rule()], OPTS);
  assert.equal(r.matches.length, 0);
});

// ── 6. OR-group handedness (2A(RHF) satisfies the [2A(LHF),2A(RHF)] slot) ─────
test("OR-group: right-hand pieces also match the combo", () => {
  const lines = [
    line({ key: "a", sizeCode: "2A(RHF)", basePriceSen: 125000 }),
    line({ key: "b", sizeCode: "L(LHF)", basePriceSen: 110000 }),
  ];
  const r = applySofaCombos(lines, [rule()], OPTS);
  assert.equal(r.matches.length, 1, "RHF/LHF still forms the combo");
  assert.equal(r.newBaseByKey.get("a") + r.newBaseByKey.get("b"), 200000);
});

// ── 7. no rules / no sofa → no-op ────────────────────────────────────────────
test("no rules or no sofa lines → strict no-op", () => {
  const lines = [line({ key: "a", basePriceSen: 125000 })];
  assert.equal(applySofaCombos(lines, [], OPTS).newBaseByKey.size, 0);
  const bed = [line({ key: "a", itemCategory: "BEDFRAME", basePriceSen: 125000 })];
  assert.equal(applySofaCombos(bed, [rule()], OPTS).newBaseByKey.size, 0);
});

// ── 8. combo total ≥ sum (no saving) → no discount applied ───────────────────
test("combo total not cheaper than the pieces → no change", () => {
  const lines = [
    line({ key: "a", sizeCode: "2A(LHF)", basePriceSen: 90000 }),
    line({ key: "b", sizeCode: "L(RHF)", basePriceSen: 100000 }),
  ];
  // pieces sum 190000 < combo 200000 → discount ≤ 0 → skip
  const r = applySofaCombos(lines, [rule()], OPTS);
  assert.equal(r.matches.length, 0);
  assert.equal(r.newBaseByKey.size, 0);
});
