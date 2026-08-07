// ---------------------------------------------------------------------------
// sofa-combo-drift-guard.test.mjs — locks the CANONICAL sofa-combo engine
// (applySofaCombos in src/api/lib/sofa-combo.ts) on real production scenarios.
//
// Why: the same combo algorithm is re-implemented inline in
// import-completion.ts (/recompute-so-sofa-prices + the CO twin). They agree
// today (both port create.tsx), but nothing stopped one from drifting. This
// pins applySofaCombos's exact output so any silent change to the money maths
// turns a test red. applySofaCombos is the single source of truth; the inline
// copies must match it (see the pointer comment added to import-completion.ts).
//
// The headline case is SO-2603-133 (Houzs / cust-1, PRICE_2, seat 30): the
// 1A(RHF)+2A(LHF) pair combos to RM 1,707.
//
// 2026-08-07 — owner pricing policy. Unit prices used to carry cents
// (RM 1,094.24 + RM 612.76); they must now be WHOLE RINGGIT, rounded UP, while
// the agreed combo total is still held exactly. The pair is now
// RM 1,094 + RM 613 = RM 1,707. These expectations describe what the system
// computes FROM NOW ON; orders already issued at the old sens are untouched —
// nothing re-derives a stored document's prices on read.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { applySofaCombos } from "../src/api/lib/sofa-combo.ts";

const line = (key, sizeCode, seatHeight, basePriceSen, tier = "PRICE_2") => ({
  key,
  itemCategory: "SOFA",
  baseModel: "5536",
  sizeCode,
  seatHeight,
  fabricCode: "BO315-21",
  fabricTier: tier,
  basePriceSen,
  divanPriceSen: 0,
  legPriceSen: 0,
  totalHeightPriceSen: 0,
  specialOrderPriceSen: 0,
  quantity: 1,
});

// The real cust-1 rule that priced the 1A+2A pair (from sofa_combo_rules).
const RULE_1A_2A = {
  baseModel: "5536",
  componentSizes: [["1A(LHF)", "1A(RHF)"], ["2A(LHF)", "2A(RHF)"]],
  fabricTier: "PRICE_2",
  pricesByHeight: { 24: 165900, 28: 170700, 30: 170700 },
  customerId: "cust-1",
  effectiveFrom: "2026-01-01",
};
const OPTS = { customerId: "cust-1", todayDateStr: "2026-07-23" };

test("SO-2603-133 combo: 1A+2A pair → RM 1,707, split into WHOLE ringgit units", () => {
  const lines = [
    line("2A", "2A(LHF)", "30", 125000), // standalone RM 1,250
    line("1A", "1A(RHF)", "30", 70000), //  standalone RM   700
  ];
  const r = applySofaCombos(lines, [RULE_1A_2A], OPTS);
  // Prorated ideals are 109,423.08 and 61,276.92 sen. Rounded UP: RM 1,095 +
  // RM 613 = RM 1,708, one ringgit over the agreed RM 1,707. The give-back
  // lands on 2A(LHF) — the line the round-up flattered most (76.92 vs 23.08).
  assert.equal(r.newBaseByKey.get("2A"), 109400, "2A(LHF) → RM 1,094");
  assert.equal(r.newBaseByKey.get("1A"), 61300, "1A(RHF) → RM 613");
  // group sums EXACTLY to the agreed combo total — rounding up must NOT let an
  // agreed customer price grow
  assert.equal(r.newBaseByKey.get("2A") + r.newBaseByKey.get("1A"), 170700);
  assert.equal(r.totalDiscountSen, 195000 - 170700);
});

test("every combo unit price is a whole ringgit — no .24 / .76 / .98 endings", () => {
  const lines = [
    line("2A", "2A(LHF)", "30", 125000),
    line("1A", "1A(RHF)", "30", 70000),
  ];
  const r = applySofaCombos(lines, [RULE_1A_2A], OPTS);
  for (const [key, base] of r.newBaseByKey) {
    // no surcharges on these lines, so base === the unit price
    assert.equal(base % 100, 0, `${key} unit price must be divisible by RM 1`);
  }
});

test("idempotent: an already-combo'd group (sum already ≤ combo total) is left alone", () => {
  const lines = [
    line("2A", "2A(LHF)", "30", 109400),
    line("1A", "1A(RHF)", "30", 61300),
  ];
  const r = applySofaCombos(lines, [RULE_1A_2A], OPTS);
  assert.equal(r.newBaseByKey.size, 0, "no change — discount already taken");
});

test("null fabric tier disqualifies the whole group (no combo)", () => {
  const lines = [
    line("2A", "2A(LHF)", "30", 125000, null),
    line("1A", "1A(RHF)", "30", 70000, null),
  ];
  assert.equal(applySofaCombos(lines, [RULE_1A_2A], OPTS).newBaseByKey.size, 0);
});

test("non-uniform seat height disqualifies (the 5537-different-sizes false alarm)", () => {
  const lines = [
    line("2A", "2A(LHF)", "35", 125000),
    line("1A", "1A(RHF)", "28", 70000),
  ];
  assert.equal(applySofaCombos(lines, [RULE_1A_2A], OPTS).newBaseByKey.size, 0);
});

test("a rule for a DIFFERENT customer does not apply", () => {
  const otherRule = { ...RULE_1A_2A, customerId: "cust-999" };
  const lines = [
    line("2A", "2A(LHF)", "30", 125000),
    line("1A", "1A(RHF)", "30", 70000),
  ];
  assert.equal(applySofaCombos(lines, [otherRule], OPTS).newBaseByKey.size, 0);
});

// --- Multi-set fix (owner 2026-07-23: two sets must BOTH combo) -------------

test("TWO complete sets → BOTH combo (fix: not just the first)", () => {
  const lines = [
    line("2Aa", "2A(LHF)", "30", 125000),
    line("1Aa", "1A(RHF)", "30", 70000),
    line("2Ab", "2A(LHF)", "30", 125000),
    line("1Ab", "1A(RHF)", "30", 70000),
  ];
  const r = applySofaCombos(lines, [RULE_1A_2A], OPTS);
  assert.equal(r.matches.length, 2, "both sets matched");
  assert.equal(r.newBaseByKey.size, 4, "all four lines re-priced");
  // each set redistributes to the same exact combo sens
  for (const k of ["2Aa", "2Ab"]) assert.equal(r.newBaseByKey.get(k), 109400, k);
  for (const k of ["1Aa", "1Ab"]) assert.equal(r.newBaseByKey.get(k), 61300, k);
});

test("one-and-a-half sets → one full combo, the leftover piece stays standalone", () => {
  const lines = [
    line("2Aa", "2A(LHF)", "30", 125000),
    line("1Aa", "1A(RHF)", "30", 70000),
    line("2Ab", "2A(LHF)", "30", 125000), // no partner 1A → not a set
  ];
  const r = applySofaCombos(lines, [RULE_1A_2A], OPTS);
  assert.equal(r.matches.length, 1, "only one complete set");
  assert.equal(r.newBaseByKey.get("2Aa"), 109400);
  assert.equal(r.newBaseByKey.get("1Aa"), 61300);
  assert.equal(r.newBaseByKey.has("2Ab"), false, "leftover 2A untouched");
});
