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
