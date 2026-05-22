// ---------------------------------------------------------------------------
// labor-engine.test.mjs — unit tests for the labor engine
// (src/lib/labor-engine.ts).
//
// The engine is the single source of truth for payroll + production labor
// cost. If its formulas drift, every payslip and every production-cost
// figure silently disagrees. Lock the numbers in here.
//
// Reference worker throughout: ANN — RM2,650/mo, 26 days, 8 h/day, OT ×1.5.
// Reference month: May 2026, one public holiday (1 May, a Friday).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on Node 22+.
}

const labor = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/labor-engine.ts")).href
);

// ── Fixtures ────────────────────────────────────────────────────────────────

// ANN's Employee Master figures.
const ANN = {
  basicSalarySen: 265_000, // RM2,650
  workingDaysPerMonth: 26,
  workingHoursPerDay: 8,
  otMultiplier: 1.5,
};

// The 25 working days of May 2026 (Mon–Sat, excludes the four Sundays
// 3/10/17/24/31 and the 1 May public holiday).
const MAY_WORKDAYS = [
  "2026-05-02",
  "2026-05-04", "2026-05-05", "2026-05-06", "2026-05-07", "2026-05-08", "2026-05-09",
  "2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14", "2026-05-15", "2026-05-16",
  "2026-05-18", "2026-05-19", "2026-05-20", "2026-05-21", "2026-05-22", "2026-05-23",
  "2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28", "2026-05-29", "2026-05-30",
];

const MAY_HOLIDAYS = ["2026-05-01"];

// 25 days present: first 20 at 8 h (no OT), last 5 at 11 h (3 h OT each →
// 15 h OT for the month).
const annFullMonth = MAY_WORKDAYS.map((date, i) => ({
  date,
  hours: i < 20 ? 8 : 11,
}));

// ── countPublicHolidaysInMonth ──────────────────────────────────────────────

test("countPublicHolidaysInMonth: 1 May 2026 (Friday) counts as 1", () => {
  assert.equal(labor.countPublicHolidaysInMonth(2026, 5, MAY_HOLIDAYS), 1);
});

test("countPublicHolidaysInMonth: a holiday on a Sunday does not count", () => {
  // 2026-05-03 is a Sunday — already a non-working day.
  assert.equal(labor.countPublicHolidaysInMonth(2026, 5, ["2026-05-03"]), 0);
});

test("countPublicHolidaysInMonth: holiday in another month is ignored", () => {
  assert.equal(labor.countPublicHolidaysInMonth(2026, 5, ["2026-04-01"]), 0);
});

test("countPublicHolidaysInMonth: empty list -> 0", () => {
  assert.equal(labor.countPublicHolidaysInMonth(2026, 5, []), 0);
});

test("countPublicHolidaysInMonth: only weekday holidays in-month are counted", () => {
  // 1 May (Fri) + 13 May (Wed) count; 3 May (Sun) + 1 Jun (other month) don't.
  const set = ["2026-05-01", "2026-05-03", "2026-05-13", "2026-06-01"];
  assert.equal(labor.countPublicHolidaysInMonth(2026, 5, set), 2);
});

// ── countElapsedWorkingDays ─────────────────────────────────────────────────

test("countElapsedWorkingDays: full May 2026 minus 1 holiday -> 25", () => {
  assert.equal(labor.countElapsedWorkingDays(2026, 5, 31, MAY_HOLIDAYS), 25);
});

test("countElapsedWorkingDays: full May 2026 with no holidays -> 26", () => {
  assert.equal(labor.countElapsedWorkingDays(2026, 5, 31, []), 26);
});

test("countElapsedWorkingDays: partial month (through 9 May) -> 7", () => {
  // Days 1–9: 1 May holiday, 3 May Sunday → 2/4/5/6/7/8/9 = 7 working days.
  assert.equal(labor.countElapsedWorkingDays(2026, 5, 9, MAY_HOLIDAYS), 7);
});

test("countElapsedWorkingDays: throughDay past month-end clamps to last day", () => {
  assert.equal(labor.countElapsedWorkingDays(2026, 5, 999, MAY_HOLIDAYS), 25);
});

// ── computeMonthlyLabor: ANN, full attendance ───────────────────────────────

test("computeMonthlyLabor: ANN full attendance — rates", () => {
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 5,
    days: annFullMonth,
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
  });
  assert.equal(r.holidaysInMonth, 1);
  assert.equal(r.daysWorked, 25);
  assert.equal(r.otHours, 15);
  // Payroll day rate ÷26 = 265000/26 ≈ 10192.31 sen.
  assert.ok(
    Math.abs(r.payrollDailyRateSen - 265_000 / 26) < 1e-6,
    `payroll day rate ${r.payrollDailyRateSen}`,
  );
  // Production day rate ÷(26−1) = 265000/25 = 10600 sen exactly.
  assert.equal(r.costingDailyRateSen, 10_600);
  // OT hourly = 265000/26/8 × 1.5 ≈ 1911.06 sen.
  assert.ok(
    Math.abs(r.otHourlyRateSen - (265_000 / 26 / 8) * 1.5) < 1e-6,
    `OT hourly ${r.otHourlyRateSen}`,
  );
});

test("computeMonthlyLabor: ANN full attendance — payroll = RM2,936.66", () => {
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 5,
    days: annFullMonth,
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
  });
  assert.equal(r.payroll.fullSalarySen, 265_000);
  assert.equal(r.payroll.absentDays, 0);
  assert.equal(r.payroll.absenceDeductionSen, 0);
  assert.equal(r.payroll.basicEarnedSen, 265_000);
  assert.equal(r.payroll.otPaySen, 28_666); // 15h × 1911.057… → 28665.87 → 28666
  assert.equal(r.payroll.grossSen, 293_666); // RM2,936.66
});

test("computeMonthlyLabor: ANN full attendance — production cost = RM2,936.66", () => {
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 5,
    days: annFullMonth,
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
  });
  assert.equal(r.cost.regularCostSen, 265_000); // 25 days × 10600
  assert.equal(r.cost.otCostSen, 28_666); // identical to payroll OT
  assert.equal(r.cost.totalCostSen, 293_666); // RM2,936.66
});

test("computeMonthlyLabor: full attendance — payroll gross equals production cost", () => {
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 5,
    days: annFullMonth,
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
  });
  assert.equal(r.payroll.grossSen, r.cost.totalCostSen);
});

// ── computeMonthlyLabor: ANN, absent 2 days ─────────────────────────────────

test("computeMonthlyLabor: ANN absent 2 days — payroll deducts ÷26", () => {
  // Drop the first two 8 h days → 23 days present, still 15 h OT.
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 5,
    days: annFullMonth.slice(2),
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
  });
  assert.equal(r.daysWorked, 23);
  assert.equal(r.payroll.absentDays, 2);
  // 2 × 265000/26 = 20384.62 → 20385 sen.
  assert.equal(r.payroll.absenceDeductionSen, 20_385);
  assert.equal(r.payroll.basicEarnedSen, 244_615); // RM2,446.15
  assert.equal(r.payroll.grossSen, 273_281); // 244615 + 28666 → RM2,732.81
});

test("computeMonthlyLabor: ANN absent 2 days — production cost is days-worked based", () => {
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 5,
    days: annFullMonth.slice(2),
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
  });
  // 23 days × 10600 = 243800 sen.
  assert.equal(r.cost.regularCostSen, 243_800);
  assert.equal(r.cost.totalCostSen, 272_466); // 243800 + 28666
});

// ── Holiday effect ──────────────────────────────────────────────────────────

test("computeMonthlyLabor: a public holiday makes the production day rate higher", () => {
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 5,
    days: annFullMonth,
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
  });
  // Production day rate (÷25) must exceed the payroll day rate (÷26).
  assert.ok(
    r.costingDailyRateSen > r.payrollDailyRateSen,
    `${r.costingDailyRateSen} should exceed ${r.payrollDailyRateSen}`,
  );
});

test("computeMonthlyLabor: no holidays — production day rate equals payroll day rate", () => {
  // June 2026, no public holidays → both divisors are 26.
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 6,
    days: [{ date: "2026-06-01", hours: 8 }],
    publicHolidays: [],
    absenceThroughDay: 30,
  });
  assert.equal(r.holidaysInMonth, 0);
  assert.equal(r.costingDailyRateSen, r.payrollDailyRateSen);
});

// ── OT threshold uses the worker's OWN standard day ─────────────────────────

test("computeMonthlyLabor: OT threshold is the worker's workingHoursPerDay", () => {
  // Same 11 h day, two workers — 8 h standard → 3 h OT; 9 h standard → 2 h OT.
  const day = [{ date: "2026-05-04", hours: 11 }];
  const eightHr = labor.computeMonthlyLabor({
    worker: { ...ANN, workingHoursPerDay: 8 },
    year: 2026, month: 5, days: day, publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 4,
  });
  const nineHr = labor.computeMonthlyLabor({
    worker: { ...ANN, workingHoursPerDay: 9 },
    year: 2026, month: 5, days: day, publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 4,
  });
  assert.equal(eightHr.otHours, 3);
  assert.equal(nineHr.otHours, 2);
});

test("computeMonthlyLabor: otMultiplier scales OT pay", () => {
  const day = [{ date: "2026-05-04", hours: 11 }]; // 3 h OT
  const flat = labor.computeMonthlyLabor({
    worker: { ...ANN, otMultiplier: 1.0 },
    year: 2026, month: 5, days: day, publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 4,
  });
  const premium = labor.computeMonthlyLabor({
    worker: { ...ANN, otMultiplier: 1.5 },
    year: 2026, month: 5, days: day, publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 4,
  });
  // 1.5× multiplier → OT pay is exactly 1.5× the flat (no-premium) figure.
  assert.ok(
    Math.abs(premium.payroll.otPaySen - flat.payroll.otPaySen * 1.5) <= 1,
    `${premium.payroll.otPaySen} vs ${flat.payroll.otPaySen}`,
  );
});

// ── Per-date aggregation + month filtering ──────────────────────────────────

test("computeMonthlyLabor: several department rows on one date = one day", () => {
  // 5 h Upholstery + 4 h Framing on the same date → 1 day, 9 h total, 1 h OT.
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 5,
    days: [
      { date: "2026-05-04", hours: 5 },
      { date: "2026-05-04", hours: 4 },
    ],
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 4,
  });
  assert.equal(r.daysWorked, 1);
  assert.equal(r.otHours, 1); // 9 h total − 8 h standard
});

test("computeMonthlyLabor: rows outside the target month are ignored", () => {
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 5,
    days: [
      { date: "2026-04-30", hours: 8 }, // previous month — ignored
      { date: "2026-05-04", hours: 8 },
      { date: "2026-06-01", hours: 8 }, // next month — ignored
    ],
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 4,
  });
  assert.equal(r.daysWorked, 1);
});

// ── Degenerate inputs ───────────────────────────────────────────────────────

test("computeMonthlyLabor: no hours logged — zero production cost, no OT", () => {
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 5,
    days: [],
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
  });
  assert.equal(r.daysWorked, 0);
  assert.equal(r.otHours, 0);
  assert.equal(r.cost.totalCostSen, 0);
  assert.equal(r.payroll.otPaySen, 0);
});

test("computeMonthlyLabor: a worker with no salary set costs nothing (no crash)", () => {
  // "CHAU" in prod — basic salary / hours unset. Must not divide by zero.
  const r = labor.computeMonthlyLabor({
    worker: {
      basicSalarySen: 0,
      workingDaysPerMonth: 0,
      workingHoursPerDay: 0,
      otMultiplier: 0,
    },
    year: 2026,
    month: 5,
    days: [{ date: "2026-05-04", hours: 11 }],
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 4,
  });
  assert.equal(r.cost.totalCostSen, 0);
  assert.equal(r.payroll.grossSen, 0);
  assert.ok(Number.isFinite(r.costingDailyRateSen));
});
