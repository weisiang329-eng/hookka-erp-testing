// ---------------------------------------------------------------------------
// outsource-daily-pay.test.mjs
//
// Outsourced people are paid per DAY WORKED, not a monthly salary minus
// absences (owner 2026-08-02: 「或者根据天来计算」). The two are not the same
// arithmetic: someone who comes five days in a month would, under the monthly
// rule, be recorded with 21 absences and docked against a salary they were
// never on.
//
// The first test here is the one that matters most — own staff must compute
// byte-identically to before, because payMode defaults to MONTHLY.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const E = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/labor-engine.ts")).href
);

const STAFF = {
  basicSalarySen: 205000,
  workingDaysPerMonth: 26,
  workingHoursPerDay: 9,
  otMultiplier: 1.5,
};

// July 2026's real working days (Mon–Sat). A naive 1..n range would include
// Sundays, which the engine does not count as worked — the fixture has to match
// the calendar or the numbers mean nothing.
const WORKING_DAYS = [];
for (let d = 1; d <= 31; d++) {
  if (new Date(Date.UTC(2026, 6, d)).getUTCDay() !== 0) {
    WORKING_DAYS.push(`2026-07-${String(d).padStart(2, "0")}`);
  }
}

/** July 2026, a worker who logged `n` full days. */
const run = (worker, n) =>
  E.computeMonthlyLabor({
    worker,
    year: 2026,
    month: 7,
    days: WORKING_DAYS.slice(0, n).map((date) => ({ date, hours: 9 })),
    publicHolidays: [],
    absenceThroughDay: "2026-07-31",
  });

test("own staff are untouched — no payMode means the monthly rule, exactly as before", () => {
  const withoutField = run(STAFF, 26);
  const explicitlyMonthly = run({ ...STAFF, payMode: "MONTHLY" }, 26);
  assert.deepEqual(explicitlyMonthly.payroll, withoutField.payroll);
  // And a DAILY rate sitting unused on a MONTHLY worker changes nothing.
  const strayRate = run({ ...STAFF, payMode: "MONTHLY", dailyRateSen: 9999 }, 26);
  assert.deepEqual(strayRate.payroll, withoutField.payroll);
});

test("MONTHLY pays the full salary regardless of how many days were logged", () => {
  // The monthly rule starts from the salary; absences are decided by the
  // absence window, which this fixture deliberately does not exercise. What
  // matters here is that the DAILY branch has not leaked into it.
  assert.equal(run(STAFF, WORKING_DAYS.length).payroll.basicEarnedSen, 205000);
  assert.equal(run(STAFF, 20).payroll.basicEarnedSen, 205000);
});

test("DAILY pays days worked, and records NO absence", () => {
  // RM120/day. Five days worked = RM600, regardless of the month's length.
  const osc = { ...STAFF, basicSalarySen: 0, payMode: "DAILY", dailyRateSen: 12000 };
  const r = run(osc, 5);
  assert.equal(
    r.payroll.absenceDeductionSen,
    0,
    "a day not worked is simply not paid — it is not an absence to dock",
  );
  assert.equal(r.payroll.basicEarnedSen, 5 * 12000);
});

test("DAILY scales with days, not with the calendar", () => {
  const osc = { ...STAFF, basicSalarySen: 0, payMode: "DAILY", dailyRateSen: 12000 };
  assert.equal(run(osc, 1).payroll.basicEarnedSen, 12000);
  assert.equal(run(osc, 10).payroll.basicEarnedSen, 120000);
});

test("DAILY with no rate set falls back to MONTHLY rather than paying zero", () => {
  // Half-configured must not silently pay nothing — it behaves like the
  // familiar rule until someone fills the rate in.
  const half = { ...STAFF, payMode: "DAILY", dailyRateSen: 0 };
  assert.deepEqual(run(half, 26).payroll, run(STAFF, 26).payroll);
});

test("the two employee-number series are independent", () => {
  const src = readFileSync("src/pages/employees.tsx", "utf8");
  assert.match(src, /prefix: "EMP" \| "OSC" = "EMP"/);
  assert.match(src, /\$\{prefix\}-\$\{String\(max \+ 1\)\.padStart\(3, "0"\)\}/);
});

// ---------------------------------------------------------------------------
// The COST side. Pay was right from the first version; cost was not.
//
// Owner 2026-08-02: 「并且这个薪水需要计算进我们的 labour cost，还有我们的
// department labour…你要把这部分薪水计算在内，这样我们的薪水才能算得准。」
//
// computeMonthlyLabor derived the production-cost day rate from basicSalarySen,
// which is 0 for an outsourced person — so someone could work a full month in a
// department and contribute exactly nothing to that department's cost. Nothing
// looked broken: no error, no zero row, just a factory that appeared cheaper
// than it was.
// ---------------------------------------------------------------------------

test("DAILY costs the day rate — production cost is NOT zero", () => {
  const osc = { ...STAFF, basicSalarySen: 0, payMode: "DAILY", dailyRateSen: 8500 };
  const r = run(osc, 12);
  assert.equal(r.costingDailyRateSen, 8500, "the costing day rate IS the day rate");
  assert.equal(
    r.cost.regularCostSen,
    12 * 8500,
    "12 days logged at RM85 must cost RM1,020 — a zero here is the bug",
  );
  assert.ok(r.cost.totalCostSen > 0);
});

test("DAILY cost tracks days logged, and equals what is paid", () => {
  const osc = { ...STAFF, basicSalarySen: 0, payMode: "DAILY", dailyRateSen: 8500 };
  for (const n of [1, 5, 26]) {
    const r = run(osc, n);
    assert.equal(r.cost.regularCostSen, n * 8500);
    // No OT in this fixture, so cost and pay must agree exactly — the reports
    // and the payslip are the same number seen from two sides.
    assert.equal(r.cost.regularCostSen, r.payroll.basicEarnedSen);
  }
});

test("a MONTHLY worker's costing rate is untouched by the daily branch", () => {
  const before = run(STAFF, 26);
  const withStrayRate = run({ ...STAFF, dailyRateSen: 8500 }, 26);
  assert.equal(withStrayRate.costingDailyRateSen, before.costingDailyRateSen);
  assert.deepEqual(withStrayRate.cost, before.cost);
});

test("dailyPaidEntryCostSen splits one day across departments, summing to the rate", () => {
  const osc = { payMode: "DAILY", dailyRateSen: 8500 };
  assert.equal(E.isDailyPaidWorker(osc), true);
  assert.equal(E.isDailyPaidWorker({ payMode: "MONTHLY", dailyRateSen: 8500 }), false);
  // One day split 6h in one dept, 3h in another — 9h total.
  const a = E.dailyPaidEntryCostSen(osc, 6, 9);
  const b = E.dailyPaidEntryCostSen(osc, 3, 9);
  assert.ok(Math.abs(a + b - 8500) < 1e-6, "the split must sum to exactly one day rate");
  assert.ok(a > b);
  // A single entry carries the whole day.
  assert.equal(E.dailyPaidEntryCostSen(osc, 9, 9), 8500);
  // A punch with no hours is not a paid day, and must not divide by zero.
  assert.equal(E.dailyPaidEntryCostSen(osc, 0, 0), 0);
  // Monthly people get nothing from this helper — callers keep their own maths.
  assert.equal(E.dailyPaidEntryCostSen({ payMode: "MONTHLY", basicSalarySen: 205000 }, 9, 9), 0);
});

test("the labour reports no longer skip a worker just because salary is 0", () => {
  // The three sites in employees.tsx (Department Labor + two in Labor Cost)
  // each used `if (!w || !w.basicSalarySen) continue;`, which silently dropped
  // every outsourced person from the costing. The guard must now come AFTER
  // the daily branch, never before it.
  const src = readFileSync("src/pages/employees.tsx", "utf8");
  assert.equal(
    (src.match(/if \(!w \|\| !w\.basicSalarySen\) continue;/g) ?? []).length,
    0,
    "the blanket skip is back — outsourced people are being dropped from labour cost again",
  );
  assert.equal(
    (src.match(/if \(isDailyPaidWorker\(w\)\) \{/g) ?? []).length,
    3,
    "all three costing sites must handle daily-paid workers",
  );
});

// --- Overtime for per-day people --------------------------------------------
// AMENDED 2026-08-31. The rule used to be "no overtime", set by the owner on
// 2026-08-02 after checking with HR: 「outsource 暂时没有」 — 暂时. He asked for
// it on 2026-08-31: 「也要放 OT rate」, alongside 「跟我们目前的 flow 普通员工一
// 样，只是他不是放 monthly 薪水而是放 daily 薪水，其他一模一样的」.
//
// So there is no second formula. The day rate is simply TAKEN rather than
// derived from a salary, and every rate below it — the hour rate, the dock, the
// day-typed multipliers — falls out of the identical monthly maths.

test("DAILY earns OT off the DAY rate, not off a salary it does not have", () => {
  const osc = {
    ...STAFF,
    basicSalarySen: 0,              // the real shape: no monthly salary at all
    payMode: "DAILY",
    dailyRateSen: 8500,
    otMultiplier: 1.5,
  };
  // Twelve 12-hour days — 3h over the 9h standard day, every day.
  const r = E.computeMonthlyLabor({
    worker: osc,
    year: 2026,
    month: 7,
    days: WORKING_DAYS.slice(0, 12).map((date) => ({ date, hours: 12 })),
    publicHolidays: [],
    absenceThroughDay: "2026-07-31",
  });
  // Day rate 8500 -> hour rate 8500 / (9h + 1h lunch) = 850 -> x1.5 = 1275.
  assert.equal(r.payrollDailyRateSen, 8500, "the agreed rate, taken verbatim");
  assert.equal(r.otHourlyRateSen, 1275);
  assert.equal(r.otHours, 36, "3h over, twelve times");
  assert.equal(r.payroll.otPaySen, Math.round(36 * 1275));
  assert.equal(r.payroll.basicEarnedSen, 12 * 8500);
  assert.equal(r.payroll.grossSen, 12 * 8500 + Math.round(36 * 1275));
});

test("a DAILY worker with NO standard day earns no weekday OT", () => {
  // Hours/day was hidden for outsourced people until 2026-08-31, so it is 0 on
  // every existing record. Weekday OT is "hours ABOVE the standard day" — with
  // no standard day there is nothing to be above, and the old figure stands
  // until someone fills the field in. That makes the change opt-in per worker
  // rather than a silent repricing of everyone's history.
  const osc = {
    ...STAFF, basicSalarySen: 0, payMode: "DAILY", dailyRateSen: 8500,
    workingHoursPerDay: 0,
  };
  const r = E.computeMonthlyLabor({
    worker: osc, year: 2026, month: 7,
    days: WORKING_DAYS.slice(0, 12).map((date) => ({ date, hours: 12 })),
    publicHolidays: [], absenceThroughDay: "2026-07-31",
  });
  assert.equal(r.payroll.otWeekdayPaySen, 0);
  assert.equal(r.payroll.grossSen, 12 * 8500, "day rate x days, unchanged");
});

test("DAILY records no ABSENCE — a day not worked is simply not paid", () => {
  const osc = { ...STAFF, basicSalarySen: 0, payMode: "DAILY", dailyRateSen: 8500 };
  const r = run(osc, 5);
  assert.equal(r.payroll.absentDays, 0, "21 'absences' on a day-rate payslip is meaningless");
  assert.equal(r.payroll.absenceDeductionSen, 0);
});

test("a MONTHLY worker still earns OT on the very same days", () => {
  // The contrast is the point: identical 12-hour days, one worker paid monthly
  // and one paid per day. Monthly earns the overtime; per-day earns none.
  // (Absences are NOT the contrast here — this fixture's absence window does
  // not produce any for either, which the MONTHLY test above already says.)
  // NOTE: run() logs 9-hour days — the standard day, which by definition
  // produces no overtime. The comparison has to use the same 12-hour days as
  // the DAILY test above or it proves nothing.
  const twelveHourDays = (worker) =>
    E.computeMonthlyLabor({
      worker,
      year: 2026,
      month: 7,
      days: WORKING_DAYS.slice(0, 12).map((date) => ({ date, hours: 12 })),
      publicHolidays: [],
      absenceThroughDay: "2026-07-31",
    });
  const before = twelveHourDays(STAFF);
  assert.ok(before.payroll.otPaySen > 0, "the monthly rule still pays overtime");
  const strayRate = twelveHourDays({ ...STAFF, dailyRateSen: 8500 });
  assert.deepEqual(
    strayRate.payroll,
    before.payroll,
    "a DAILY rate sitting unused on a MONTHLY worker changes nothing",
  );
});

test("DAILY IS docked for short hours — the row already existed", () => {
  // AMENDED 2026-08-31, from the case that prompted it. CHAU (OSC-001, RM 85
  // for a 9-hour day) logged FOUR hours on 17 Aug 2026 and was paid the full
  // RM 85. Owner: 「你应该先看他的工作时长，再看他的日薪。如果他没来，是要扣掉
  // 薪水的」.
  //
  // Nothing new had to be DETECTED. The dock row was already in the database —
  // `Auto: short 5h (from punch)`, written by the same punch rules that dock
  // everyone else. The engine read it and then threw it away, because the old
  // rule zeroed it. That is why this is a one-line change and not a feature.
  const osc = { ...STAFF, basicSalarySen: 0, payMode: "DAILY", dailyRateSen: 8500 };
  const withDock = E.computeMonthlyLabor({
    worker: osc, year: 2026, month: 7,
    days: WORKING_DAYS.slice(0, 25).map((date) => ({ date, hours: 9 })),
    publicHolidays: [], absenceThroughDay: "2026-07-31",
    shortHourDeductionHours: 8,
  });
  // 8h short x (8500 / 10) = 6800.
  assert.equal(withDock.payroll.shortHourDeductionSen, 6800);
  assert.equal(withDock.payroll.basicEarnedSen, 25 * 8500 - 6800);
});

test("CHAU August 2026 — the exact case, end to end", () => {
  // 24 days logged, one of them (17 Aug) only four hours against a nine-hour
  // day. Paid RM 2,040.00 with nothing docked; the punch had already recorded
  // the 5-hour shortfall.
  const osc = { ...STAFF, basicSalarySen: 0, payMode: "DAILY", dailyRateSen: 8500,
                workingHoursPerDay: 9, otMultiplier: 1.5 };
  const H = ["2026-08-01","2026-08-03","2026-08-04","2026-08-05","2026-08-06","2026-08-07",
             "2026-08-08","2026-08-10","2026-08-11","2026-08-12","2026-08-13","2026-08-14",
             "2026-08-15","2026-08-17","2026-08-18","2026-08-19","2026-08-20","2026-08-21",
             "2026-08-22","2026-08-25","2026-08-26","2026-08-27","2026-08-28","2026-08-29"];
  const r = E.computeMonthlyLabor({
    worker: osc, year: 2026, month: 8,
    days: H.map((date) => ({ date, hours: date === "2026-08-17" ? 4 : 9 })),
    publicHolidays: ["2026-08-31"],
    absenceThroughDay: 31,
    shortHourDeductionHours: 5,
  });
  assert.equal(r.daysWorked, 24);
  assert.equal(r.payroll.shortHourDeductionSen, 4250, "5h x RM 8.50");
  assert.equal(r.payroll.grossSen, 199750, "RM 1,997.50, not the RM 2,040.00 paid");
  assert.equal(r.payroll.absentDays, 0, "a day not worked is simply not paid");
});

test("a MONTHLY worker IS still docked for short hours", () => {
  const withDock = E.computeMonthlyLabor({
    worker: STAFF, year: 2026, month: 7,
    days: WORKING_DAYS.slice(0, 25).map((date) => ({ date, hours: 9 })),
    publicHolidays: [], absenceThroughDay: "2026-07-31",
    shortHourDeductionHours: 8,
  });
  assert.ok(withDock.payroll.shortHourDeductionSen > 0, "the hourly dock still applies to staff");
});
