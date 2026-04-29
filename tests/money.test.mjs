// ---------------------------------------------------------------------------
// money.test.mjs — unit tests for the SEN<->RM money helpers + pricing +
// labor-rate floating algorithm. (Sprint 6 P0 — money paranoia.)
//
// The whole ERP stores currency as integer SEN (1 RM = 100 sen) to avoid
// float drift. Every screen multiplies/divides by 100 at the boundary.
// If formatRM, calculateUnitPrice, calculateLineTotal, or
// laborRatePerMinuteSen ever drift, every report and journal entry in the
// system silently disagrees with itself. Lock them in here.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let loaderRegistered = false;
try {
  register("tsx/esm", pathToFileURL("./"));
  loaderRegistered = true;
} catch {
  // Native type-stripping handles it on Node 22+.
}

let utils, pricing, costing;
try {
  utils = await import(
    pathToFileURL(resolve(process.cwd(), "src/lib/utils.ts")).href
  );
  pricing = await import(
    pathToFileURL(resolve(process.cwd(), "src/lib/pricing.ts")).href
  );
  costing = await import(
    pathToFileURL(resolve(process.cwd(), "src/lib/costing.ts")).href
  );
} catch (err) {
  console.warn(
    "[money.test] Could not import money modules. " +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn("[money.test] Error:", err?.message ?? err);
  throw err;
}

// ---------------------------------------------------------------------------
// formatRM(sen) — must always render "RM <amount with 2 decimals>".
// Uses Intl.NumberFormat("en-MY") under the hood, which inserts commas as
// thousands separator. We assert the *shape* (RM prefix, 2 dp, comma
// grouping) rather than rely on a single locale fixture so the test stays
// stable across Node minor bumps.
// ---------------------------------------------------------------------------
test("formatRM: 100 sen renders as RM 1.00", () => {
  assert.equal(utils.formatRM(100), "RM 1.00");
});

test("formatRM: 0 sen renders as RM 0.00", () => {
  assert.equal(utils.formatRM(0), "RM 0.00");
});

test("formatRM: 1 sen renders as RM 0.01 (no rounding loss)", () => {
  assert.equal(utils.formatRM(1), "RM 0.01");
});

test("formatRM: 50 sen renders as RM 0.50", () => {
  assert.equal(utils.formatRM(50), "RM 0.50");
});

test("formatRM: 1234567 sen groups thousands -> RM 12,345.67", () => {
  assert.equal(utils.formatRM(1234567), "RM 12,345.67");
});

test("formatRM: 100000000 sen renders with two commas -> RM 1,000,000.00", () => {
  // 1 million ringgit. Sanity check that the comma grouping works at scale.
  assert.equal(utils.formatRM(100000000), "RM 1,000,000.00");
});

test("formatRM: negative values keep the sign in front of the digits", () => {
  // Refunds / credit notes flow through formatRM with a negative sign.
  // en-MY's NumberFormat puts the minus in front of the digits, after "RM ".
  const out = utils.formatRM(-150);
  // Don't lock the exact glyph (en-MY may use Unicode minus), just shape.
  assert.match(out, /^RM\s*-?[\d,.]+$/);
  assert.match(out, /1\.50/);
});

test("formatRM: rounds to 2 decimals at most (no float gotchas)", () => {
  // A value that, if naively formatted via toFixed(2) on raw division,
  // can sometimes flicker due to FP imprecision. Confirm we always get
  // exactly two decimal places.
  const out = utils.formatRM(199);
  assert.match(out, /^RM\s*1\.99$/);
});

// ---------------------------------------------------------------------------
// SEN<->RM conversion — there's no dedicated function, just the convention
// "sen / 100 = ringgit". Pin the convention so a future refactor that
// flips the precision (e.g. to 1/1000) breaks loudly here first.
// ---------------------------------------------------------------------------
test("sen/100 yields the ringgit amount used by formatCurrency", () => {
  const cur = utils.formatCurrency(100); // RM 1.00 / "RM1.00" depending on locale
  // Either "RM1.00" or "RM 1.00" — both contain "1.00".
  assert.match(cur, /1\.00/);
  // formatCurrency for 12345 sen = RM 123.45
  assert.match(utils.formatCurrency(12345), /123\.45/);
});

// ---------------------------------------------------------------------------
// pricing.ts — line totals + seat-height price picker.
// ---------------------------------------------------------------------------
test("calculateUnitPrice: sums all components in sen", () => {
  const out = pricing.calculateUnitPrice({
    basePriceSen: 100_000,        // RM 1000
    divanPriceSen: 5_000,         // RM 50
    legPriceSen: 2_000,           // RM 20
    totalHeightPriceSen: 3_000,   // RM 30
    specialOrderPriceSen: 1_000,  // RM 10
  });
  assert.equal(out, 111_000); // RM 1110.00
});

test("calculateUnitPrice: missing components default to 0", () => {
  // The frontend often omits divanPriceSen/legPriceSen/etc. for non-bed SKUs.
  const out = pricing.calculateUnitPrice({ basePriceSen: 50_000 });
  assert.equal(out, 50_000);
});

test("calculateUnitPrice: undefined fields treated as 0 (don't NaN out)", () => {
  const out = pricing.calculateUnitPrice({
    basePriceSen: 200_000,
    divanPriceSen: undefined,
    legPriceSen: undefined,
  });
  assert.equal(out, 200_000);
});

test("calculateLineTotal: integer sen × qty stays integer", () => {
  // Ringgit precision is 2 decimals. As long as unit price stays integer
  // sen, qty stays integer, the line total is exact.
  assert.equal(pricing.calculateLineTotal(150_00, 3), 45_000);
  assert.equal(pricing.calculateLineTotal(0, 5), 0);
  assert.equal(pricing.calculateLineTotal(99_99, 1), 99_99);
});

test("calculateLineTotal: zero quantity yields zero", () => {
  assert.equal(pricing.calculateLineTotal(123_456, 0), 0);
});

test("calculateLineTotal: matches calculateUnitPrice * qty for typical bed", () => {
  // End-to-end: a typical bed line (base + divan + height) priced for qty 2.
  const unit = pricing.calculateUnitPrice({
    basePriceSen: 1_500_00,
    divanPriceSen: 200_00,
    totalHeightPriceSen: 50_00,
  });
  // 1750.00 RM unit price.
  assert.equal(unit, 175_000);
  assert.equal(pricing.calculateLineTotal(unit, 2), 350_000);
});

// ---------------------------------------------------------------------------
// costing.ts — month-floating labor rate.
// February 2026 has 24 working days (Mon-Sat).
// ---------------------------------------------------------------------------
test("countWorkingDaysInMonth: Feb 2026 has 24 Mon-Sat days", () => {
  // 2026-02 starts Sun Feb 1. 28 days. Sundays = 1, 8, 15, 22 = 4 Sundays.
  // 28 - 4 = 24 working days.
  assert.equal(costing.countWorkingDaysInMonth(2026, 2), 24);
});

test("countWorkingDaysInMonth: Jan 2026 has 27 Mon-Sat days", () => {
  // 2026-01: 31 days. Jan 1 is Thursday. Sundays: 4, 11, 18, 25 = 4.
  // 31 - 4 = 27.
  assert.equal(costing.countWorkingDaysInMonth(2026, 1), 27);
});

test("countWorkingDaysInMonth: leap-year Feb 2024 has 25 Mon-Sat days", () => {
  // 2024-02: 29 days. Feb 1 2024 is Thursday. Sundays: 4, 11, 18, 25 = 4.
  // 29 - 4 = 25.
  assert.equal(costing.countWorkingDaysInMonth(2024, 2), 25);
});

test("countWorkingDaysInMonth: custom workingDOW (Mon-Fri only) reduces count", () => {
  // 2026-02: 28 days. Sundays = 4, Saturdays = 4. Mon-Fri = 28 - 8 = 20.
  const monFri = [1, 2, 3, 4, 5];
  assert.equal(costing.countWorkingDaysInMonth(2026, 2, monFri), 20);
});

test("laborRatePerMinuteSen: Feb 2026 -> 205000 / (24*9*60) ≈ 15.82 sen/min", () => {
  const rate = costing.laborRatePerMinuteSen(2026, 2);
  // 24 * 9 * 60 = 12960 minutes
  // 205_000 / 12960 ≈ 15.8179...
  assert.ok(rate > 15.81 && rate < 15.83, `Feb 2026 rate ${rate} out of band`);
});

test("laborRatePerMinuteSen: a denser month has a smaller per-minute rate", () => {
  const feb = costing.laborRatePerMinuteSen(2026, 2); // 24 days
  const jan = costing.laborRatePerMinuteSen(2026, 1); // 27 days
  // More working days -> smaller per-minute slice of the same monthly salary.
  assert.ok(jan < feb, `expected Jan rate (${jan}) < Feb rate (${feb})`);
});

test("laborRatePerMinuteSen: zero-working-days config returns 0 (no /0)", () => {
  // Sundays only — for the Feb 2026 calendar, working DOW = [0] yields 4
  // working days. To force 0 we'd need an empty set, but the function
  // should still divide cleanly. Pick a nonsense DOW that has no overlap
  // with the actual days of the week.
  const rate = costing.laborRatePerMinuteSen(2026, 2, {
    baseSalarySen: 205_000,
    hoursPerDay: 9,
    workingDaysOfWeek: [], // zero working days
    includeOverhead: false,
  });
  assert.equal(rate, 0);
});

test("laborRatePerMinuteSen: scales linearly with baseSalary", () => {
  // Doubling salary should double rate (ceteris paribus).
  const base = costing.laborRatePerMinuteSen(2026, 2, {
    baseSalarySen: 200_000,
    hoursPerDay: 9,
    workingDaysOfWeek: [1, 2, 3, 4, 5, 6],
    includeOverhead: false,
  });
  const doubled = costing.laborRatePerMinuteSen(2026, 2, {
    baseSalarySen: 400_000,
    hoursPerDay: 9,
    workingDaysOfWeek: [1, 2, 3, 4, 5, 6],
    includeOverhead: false,
  });
  // Float comparison with tolerance.
  assert.ok(
    Math.abs(doubled - base * 2) < 1e-6,
    `doubled (${doubled}) != 2x base (${base * 2})`,
  );
});

test("laborRateForDate: pulls the right month from a Date", () => {
  // 2026-02-15 should resolve to the Feb 2026 rate.
  const d = new Date(2026, 1, 15);
  const rateFromDate = costing.laborRateForDate(d);
  const rateExplicit = costing.laborRatePerMinuteSen(2026, 2);
  assert.equal(rateFromDate, rateExplicit);
});

test("laborRateForDate: ISO string accepted", () => {
  const rate = costing.laborRateForDate("2026-02-15T00:00:00.000Z");
  assert.ok(rate > 0, "ISO date should resolve to a positive rate");
});

// ---------------------------------------------------------------------------
// Sanity: weighted-avg cost helper rounds nothing — pure float math, but
// money paranoia means we still assert the obvious.
// ---------------------------------------------------------------------------
test("weightedAvgCostSen: empty/zero-remaining batches -> 0", () => {
  assert.equal(costing.weightedAvgCostSen([]), 0);
  assert.equal(
    costing.weightedAvgCostSen([
      {
        id: "b1",
        rmId: "rm-1",
        receivedDate: "2026-01-01",
        unitCostSen: 1000,
        remainingQty: 0,
      },
    ]),
    0,
  );
});

test("weightedAvgCostSen: two batches with same qty -> arithmetic mean", () => {
  const batches = [
    { id: "b1", rmId: "rm-1", receivedDate: "2026-01-01", unitCostSen: 100, remainingQty: 10 },
    { id: "b2", rmId: "rm-1", receivedDate: "2026-01-02", unitCostSen: 200, remainingQty: 10 },
  ];
  assert.equal(costing.weightedAvgCostSen(batches), 150);
});
