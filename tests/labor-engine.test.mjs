// ---------------------------------------------------------------------------
// labor-engine.test.mjs — unit tests for the labor engine
// (src/lib/labor-engine.ts).
//
// The engine is the single source of truth for payroll + production labor
// cost. If its formulas drift, every payslip and every production-cost
// figure silently disagrees. Lock the numbers in here.
//
// Reference worker throughout: ANN — RM2,650/mo, 26 days, 8 h/day, OT ×1.5.
// Reference month: May 2026. Its public holidays — verified against the
// live kv_config['public_holidays'] on 2026-05-22 — are 1 May (Friday) and
// 27 May (Wednesday): two working-weekday holidays, so May has 24 working
// days (26 calendar Mon–Sat minus the two holidays).
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

// May 2026 public holidays, as stored in production kv_config.
const MAY_HOLIDAYS = ["2026-05-01", "2026-05-27"];

// The 24 working days of May 2026 — Mon–Sat, excluding the four Sundays
// (3/10/17/24/31) and the two public holidays (1 May, 27 May).
const MAY_WORKDAYS = [
  "2026-05-02",
  "2026-05-04", "2026-05-05", "2026-05-06", "2026-05-07", "2026-05-08", "2026-05-09",
  "2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14", "2026-05-15", "2026-05-16",
  "2026-05-18", "2026-05-19", "2026-05-20", "2026-05-21", "2026-05-22", "2026-05-23",
  "2026-05-25", "2026-05-26", "2026-05-28", "2026-05-29", "2026-05-30",
];

// 24 days present: first 19 at 8 h (no OT), last 5 at 11 h (3 h OT each →
// 15 h OT for the month).
const annFullMonth = MAY_WORKDAYS.map((date, i) => ({
  date,
  hours: i < 19 ? 8 : 11,
}));

// ── countPublicHolidaysInMonth ──────────────────────────────────────────────

test("countPublicHolidaysInMonth: 1 May 2026 (Friday) counts as 1", () => {
  assert.equal(labor.countPublicHolidaysInMonth(2026, 5, ["2026-05-01"]), 1);
});

test("countPublicHolidaysInMonth: real May 2026 fixture has 2 weekday holidays", () => {
  // 1 May (Fri) + 27 May (Wed) — both land on working weekdays.
  assert.equal(labor.countPublicHolidaysInMonth(2026, 5, MAY_HOLIDAYS), 2);
});

test("countPublicHolidaysInMonth: a holiday on a Sunday does not count", () => {
  // 2026-05-03 is a Sunday — already a non-working day.
  assert.equal(labor.countPublicHolidaysInMonth(2026, 5, ["2026-05-03"]), 0);
});

test("countPublicHolidaysInMonth: holiday in another month is ignored", () => {
  // 2026-06-01 is also a real holiday — but it belongs to June, not May.
  assert.equal(labor.countPublicHolidaysInMonth(2026, 5, ["2026-06-01"]), 0);
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

test("countElapsedWorkingDays: full May 2026 minus 2 holidays -> 24", () => {
  assert.equal(labor.countElapsedWorkingDays(2026, 5, 31, MAY_HOLIDAYS), 24);
});

test("countElapsedWorkingDays: full May 2026 with no holidays -> 26", () => {
  assert.equal(labor.countElapsedWorkingDays(2026, 5, 31, []), 26);
});

test("countElapsedWorkingDays: partial month (through 9 May) -> 7", () => {
  // Days 1–9: 1 May holiday, 3 May Sunday → 2/4/5/6/7/8/9 = 7 working days.
  // (27 May is out of range, so it doesn't affect this window.)
  assert.equal(labor.countElapsedWorkingDays(2026, 5, 9, MAY_HOLIDAYS), 7);
});

test("countElapsedWorkingDays: throughDay past month-end clamps to last day", () => {
  assert.equal(labor.countElapsedWorkingDays(2026, 5, 999, MAY_HOLIDAYS), 24);
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
  assert.equal(r.holidaysInMonth, 2);
  assert.equal(r.daysWorked, 24);
  assert.equal(r.otHours, 15);
  // Payroll day rate ÷26 = 265000/26 ≈ 10192.31 sen.
  assert.ok(
    Math.abs(r.payrollDailyRateSen - 265_000 / 26) < 1e-6,
    `payroll day rate ${r.payrollDailyRateSen}`,
  );
  // Production day rate ÷(26−2) = 265000/24 ≈ 11041.67 sen.
  assert.ok(
    Math.abs(r.costingDailyRateSen - 265_000 / 24) < 1e-6,
    `production day rate ${r.costingDailyRateSen}`,
  );
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
  // 24 days × (265000/24) = 265000 sen exactly.
  assert.equal(r.cost.regularCostSen, 265_000);
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

test("computeMonthlyLabor: ANN absent 2 days — payroll docks ÷26; gap vs cost = non-productive paid", () => {
  // Drop the first two 8 h days → 22 days present, still 15 h OT.
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 5,
    days: annFullMonth.slice(2),
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
  });
  assert.equal(r.daysWorked, 22);
  assert.equal(r.payroll.absentDays, 2);
  // Absence is docked at the nominal ÷26 day rate (ordinary rate of pay):
  // 2 × 265000/26 = 20384.6 → 20385 sen.
  assert.equal(r.payroll.absenceDeductionSen, 20_385);
  assert.equal(r.payroll.basicEarnedSen, 244_615); // 265000 − 20385 → RM2,446.15
  assert.equal(r.payroll.grossSen, 273_281); // 244615 + 28666 (OT, ÷26) → RM2,732.81
  // Cost removes the 2 unworked days at the higher ÷working-days rate, so basic
  // earned is HIGHER than production-cost regular. That gap (paid above
  // production value on absent days) is the "non-productive paid (absence)"
  // reconciliation line — here 244615 − 242917 = 1698 sen (RM16.98).
  assert.equal(r.cost.regularCostSen, 242_917);
  assert.equal(r.payroll.basicEarnedSen - r.cost.regularCostSen, 1_698);
});

test("computeMonthlyLabor: part-month prorate uses ÷working-days (matches cost), not ÷26", () => {
  // Joined mid-May (day 18). prorateToService pays days SERVED × the
  // ÷working-days rate — the SAME rate production cost uses — so a part-month
  // worker's basic earned equals production-cost regular exactly (no leniency
  // gap; the ÷26 absence rule does not apply to days outside employment).
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 5,
    days: [
      { date: "2026-05-18", hours: 8 },
      { date: "2026-05-19", hours: 8 },
      { date: "2026-05-20", hours: 8 },
      { date: "2026-05-21", hours: 8 },
      { date: "2026-05-22", hours: 8 },
    ],
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
    employmentStartDay: 18,
    prorateToService: true,
  });
  assert.equal(r.daysWorked, 5);
  assert.equal(r.payroll.basicEarnedSen, 55_208); // 5 × 265000/24 = 55208.33 → 55208
  assert.equal(r.payroll.basicEarnedSen, r.cost.regularCostSen);
});

test("computeMonthlyLabor: short-hour deduction docks ÷working-days hourly from earned", () => {
  // ANN full attendance, but the owner docks 5 unworked hours (under-recorded
  // review). ÷working-days hourly = 265000/24/8 = 1380.21 sen; 5h → 6901 sen.
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 5,
    days: annFullMonth,
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
    shortHourDeductionHours: 5,
  });
  assert.equal(r.payroll.shortHourDeductionSen, 6_901); // 5 × 265000/24/8
  assert.equal(r.payroll.basicEarnedSen, 265_000 - 6_901); // full salary − dock
  assert.equal(r.payroll.grossSen, 265_000 - 6_901 + 28_666); // OT unchanged
  // The dock does not touch production cost — that stays hours/day based.
  assert.equal(r.cost.regularCostSen, 265_000);
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
  // 22 days × (265000/24) = 242916.67 → 242917 sen.
  assert.equal(r.cost.regularCostSen, 242_917);
  assert.equal(r.cost.totalCostSen, 271_583); // 242917 + 28666
});

// ── Holiday effect ──────────────────────────────────────────────────────────

test("computeMonthlyLabor: public holidays make the production day rate higher", () => {
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 5,
    days: annFullMonth,
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
  });
  // Production day rate (÷24) must exceed the payroll day rate (÷26).
  assert.ok(
    r.costingDailyRateSen > r.payrollDailyRateSen,
    `${r.costingDailyRateSen} should exceed ${r.payrollDailyRateSen}`,
  );
});

test("computeMonthlyLabor: costing divisor = ACTUAL month working days, not fixed 26 (payroll stays ÷26)", () => {
  // July 2026 has 27 Mon–Sat working days and NO public holidays. Payroll still
  // divides by the nominal workingDaysPerMonth (26); production cost divides by
  // the ACTUAL 27 → the two day rates DIFFER even with no holidays. (2026-06-07
  // fix: working days are the real per-month count, not a fixed 26.)
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 7,
    days: [{ date: "2026-07-01", hours: 8 }],
    publicHolidays: [],
    absenceThroughDay: 31,
  });
  assert.equal(r.holidaysInMonth, 0);
  assert.equal(r.payrollDailyRateSen, ANN.basicSalarySen / ANN.workingDaysPerMonth); // ÷26 nominal
  assert.equal(r.costingDailyRateSen, ANN.basicSalarySen / 27); // ÷ actual 27 working days
  assert.ok(r.costingDailyRateSen < r.payrollDailyRateSen); // 27 > 26 → each day costs less
});

test("computeMonthlyLabor: costing == payroll rate when the month actually has 26 working days + no holidays", () => {
  // May 2026 has exactly 26 Mon–Sat days; with no holidays passed, the actual
  // working-days divisor is 26 = the payroll ÷26, so the two rates converge.
  const r = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 5,
    days: [{ date: "2026-05-04", hours: 8 }],
    publicHolidays: [],
    absenceThroughDay: 31,
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

// ── productionCostRatePerMinuteSen — cost_ledger per-minute rate ─────────────

test("productionCostRatePerMinuteSen: ANN May 2026 = 265000 ÷ 24 ÷ 8 ÷ 60", () => {
  const rate = labor.productionCostRatePerMinuteSen(
    ANN,
    2026,
    5,
    MAY_HOLIDAYS, // 2 holidays → divisor 24
  );
  // 265000 / 24 / 8 / 60 ≈ 23.003 sen/min.
  assert.ok(
    Math.abs(rate - 265_000 / 24 / 8 / 60) < 1e-9,
    `rate ${rate} out of band`,
  );
});

test("productionCostRatePerMinuteSen: a public holiday raises the rate", () => {
  const withHolidays = labor.productionCostRatePerMinuteSen(
    ANN, 2026, 5, MAY_HOLIDAYS,
  );
  const noHolidays = labor.productionCostRatePerMinuteSen(ANN, 2026, 5, []);
  assert.ok(
    withHolidays > noHolidays,
    `${withHolidays} should exceed ${noHolidays}`,
  );
  // No holidays → 265000 / 26 / 8 / 60.
  assert.ok(Math.abs(noHolidays - 265_000 / 26 / 8 / 60) < 1e-9);
});

test("productionCostRatePerMinuteSen: divisor = ACTUAL month working days (July 2026 = 27, not nominal 26)", () => {
  // July 2026 has 27 Mon-Sat working days (4 Sundays), no public holidays.
  // The rate must divide by 27, NOT the worker's nominal workingDaysPerMonth (26).
  const july = labor.productionCostRatePerMinuteSen(ANN, 2026, 7, []);
  assert.ok(
    Math.abs(july - 265_000 / 27 / 8 / 60) < 1e-9,
    `July rate ${july} should divide by the real 27 working days, not 26`,
  );
  // ÷27 spreads the salary over more days → a lower per-minute rate than a
  // 26-working-day month with no holidays.
  const mayNoHol = labor.productionCostRatePerMinuteSen(ANN, 2026, 5, []);
  assert.ok(july < mayNoHol, `${july} (÷27) should be below ${mayNoHol} (÷26)`);
});

test("productionCostRatePerMinuteSen: zero salary or zero hours → 0", () => {
  assert.equal(
    labor.productionCostRatePerMinuteSen(
      { ...ANN, basicSalarySen: 0 }, 2026, 5, MAY_HOLIDAYS,
    ),
    0,
  );
  assert.equal(
    labor.productionCostRatePerMinuteSen(
      { ...ANN, workingHoursPerDay: 0 }, 2026, 5, MAY_HOLIDAYS,
    ),
    0,
  );
});

// ── Effective-dated salary helpers ──────────────────────────────────────────

test("salaryAsOfSen: newest effective row <= date wins; else fallback", () => {
  const hist = [
    { effectiveFrom: "2026-01-01", basicSalarySen: 200_000 },
    { effectiveFrom: "2026-05-15", basicSalarySen: 220_000 },
  ];
  assert.equal(labor.salaryAsOfSen(hist, 999, "2026-05-14"), 200_000);
  assert.equal(labor.salaryAsOfSen(hist, 999, "2026-05-15"), 220_000); // inclusive
  assert.equal(labor.salaryAsOfSen(hist, 999, "2026-06-01"), 220_000);
  assert.equal(labor.salaryAsOfSen(hist, 12_345, "2025-12-31"), 12_345); // before first → fallback
});

test("effectiveSalarySenForMonth: no change → the single salary exactly", () => {
  const hist = [{ effectiveFrom: "2026-01-01", basicSalarySen: 205_000 }];
  assert.equal(
    labor.effectiveSalarySenForMonth(hist, 0, 2026, 5, MAY_HOLIDAYS),
    205_000,
  );
});

test("effectiveSalarySenForMonth: mid-month raise → day-weighted average", () => {
  // May 2026 has 24 working days (Mon–Sat minus 1 May + 27 May holidays):
  // 11 working days before 15 May (at 200000) + 13 on/after 15 May (at 240000).
  // (11×200000 + 13×240000) / 24 = 5,320,000 / 24 = 221,666.67 → 221,667.
  const hist = [
    { effectiveFrom: "2026-01-01", basicSalarySen: 200_000 },
    { effectiveFrom: "2026-05-15", basicSalarySen: 240_000 },
  ];
  assert.equal(
    labor.effectiveSalarySenForMonth(hist, 0, 2026, 5, MAY_HOLIDAYS),
    221_667,
  );
});

// ── costingWorkerOrDefault ──────────────────────────────────────────────────

test("costingWorkerOrDefault: undefined → the system default worker", () => {
  const w = labor.costingWorkerOrDefault(undefined);
  assert.equal(w.basicSalarySen, 205_000);
  assert.equal(w.workingDaysPerMonth, 26);
  assert.equal(w.workingHoursPerDay, 9);
  assert.equal(w.otMultiplier, 1.5);
});

test("costingWorkerOrDefault: a fully-set worker keeps their own figures", () => {
  const w = labor.costingWorkerOrDefault({
    basicSalarySen: 265_000,
    workingHoursPerDay: 8,
    workingDaysPerMonth: 26,
    otMultiplier: 1.5,
  });
  assert.equal(w.basicSalarySen, 265_000);
  assert.equal(w.workingHoursPerDay, 8);
});

test("costingWorkerOrDefault: a no-salary worker falls back to the default rate (not 0)", () => {
  // "CHAU" in prod — salary/hours unset. Must still cost at the default.
  const w = labor.costingWorkerOrDefault({
    basicSalarySen: 0,
    workingHoursPerDay: 0,
    workingDaysPerMonth: 26,
    otMultiplier: 1,
  });
  assert.equal(w.basicSalarySen, 205_000);
  assert.equal(w.workingHoursPerDay, 9);
  const rate = labor.productionCostRatePerMinuteSen(w, 2026, 5, MAY_HOLIDAYS);
  assert.ok(rate > 0, "an unconfigured worker should cost at the default rate");
});

// ── computeAttendanceDayDetail — per-day absent/OT dates (display only) ──────
// Must stay consistent with computeMonthlyLabor: the absentDates length equals
// payroll.absentDays, and the OT hours summed across otDays equal otHours.

test("computeAttendanceDayDetail: full attendance — no absences, OT on the last 5 days", () => {
  const detail = labor.computeAttendanceDayDetail({
    worker: ANN,
    year: 2026,
    month: 5,
    days: annFullMonth,
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
  });
  assert.deepEqual(detail.absentDates, []);
  // 11h days (last 5 working days) each have 3h OT → 5 OT days, 15h total.
  assert.equal(detail.otDays.length, 5);
  assert.deepEqual(
    detail.otDays.map((d) => d.date),
    ["2026-05-25", "2026-05-26", "2026-05-28", "2026-05-29", "2026-05-30"],
  );
  assert.equal(detail.otDays.reduce((s, d) => s + d.hours, 0), 15);
});

test("computeAttendanceDayDetail: absent 2 days — lists the exact 2 dates, matches the engine count", () => {
  // Drop the first two working days (2 May, 4 May) — same fixture the engine
  // 'absent 2 days' test uses, where payroll.absentDays === 2.
  const days = annFullMonth.slice(2);
  const detail = labor.computeAttendanceDayDetail({
    worker: ANN,
    year: 2026,
    month: 5,
    days,
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
  });
  assert.deepEqual(detail.absentDates, ["2026-05-02", "2026-05-04"]);
  const engine = labor.computeMonthlyLabor({
    worker: ANN,
    year: 2026,
    month: 5,
    days,
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
  });
  assert.equal(detail.absentDates.length, engine.payroll.absentDays);
});

test("computeAttendanceDayDetail: public holidays + Sundays are never absences", () => {
  // No hours logged at all in May → every elapsed WORKING day is absent, but
  // the 4 Sundays and the 2 public holidays (1 May, 27 May) are excluded.
  const detail = labor.computeAttendanceDayDetail({
    worker: ANN,
    year: 2026,
    month: 5,
    days: [],
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
  });
  // Exactly the 24 working days of May 2026.
  assert.deepEqual(detail.absentDates, MAY_WORKDAYS);
  assert.ok(!detail.absentDates.includes("2026-05-01")); // Friday holiday
  assert.ok(!detail.absentDates.includes("2026-05-27")); // Wednesday holiday
  assert.ok(!detail.absentDates.includes("2026-05-03")); // Sunday
});

test("computeAttendanceDayDetail: grace cutoff stops the absent list early", () => {
  // No hours, but only count absences through 9 May. The absent dates must be
  // exactly the working days 2–9 May (7 of them), matching countElapsedWorkingDays.
  const detail = labor.computeAttendanceDayDetail({
    worker: ANN,
    year: 2026,
    month: 5,
    days: [],
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 9,
  });
  assert.deepEqual(detail.absentDates, [
    "2026-05-02", "2026-05-04", "2026-05-05", "2026-05-06",
    "2026-05-07", "2026-05-08", "2026-05-09",
  ]);
  assert.equal(
    detail.absentDates.length,
    labor.countElapsedWorkingDays(2026, 5, 9, MAY_HOLIDAYS),
  );
});

test("computeAttendanceDayDetail: part-month worker — days before joining are not absences", () => {
  // Joined 18 May, logged the 5 working days served. No absences for the days
  // before joining; no OT.
  const detail = labor.computeAttendanceDayDetail({
    worker: ANN,
    year: 2026,
    month: 5,
    days: [
      { date: "2026-05-18", hours: 8 },
      { date: "2026-05-19", hours: 8 },
      { date: "2026-05-20", hours: 8 },
      { date: "2026-05-21", hours: 8 },
      { date: "2026-05-22", hours: 8 },
    ],
    publicHolidays: MAY_HOLIDAYS,
    absenceThroughDay: 31,
    employmentStartDay: 18,
    employmentEndDay: 22,
  });
  assert.deepEqual(detail.absentDates, []);
  assert.deepEqual(detail.otDays, []);
});

test("computeAttendanceDayDetail: several rows on one date aggregate before the OT test", () => {
  // 5h + 4h on the same date = 9h → 1h OT for an 8h-standard worker.
  const detail = labor.computeAttendanceDayDetail({
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
  assert.deepEqual(detail.otDays, [{ date: "2026-05-04", hours: 1 }]);
});
