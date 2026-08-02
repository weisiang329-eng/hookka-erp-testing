// ---------------------------------------------------------------------------
// pay-rules.test.mjs — effective-dated pay rules (owner 2026-06-11).
//   • resolvePayRulesAsOf picks the newest version <= the date, else defaults.
//   • The labor engine applies a mid-month multiplier change PER DATE.
//   • toAttendanceRules feeds custom grace/blocks into computeAttendanceDay.
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

const pr = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/pay-rules.ts")).href
);
const labor = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/labor-engine.ts")).href
);
const att = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/attendance-rules.ts")).href
);

const v = (effectiveFrom, rules) => ({
  id: `t-${effectiveFrom}`,
  effectiveFrom,
  rules: { ...pr.DEFAULT_PAY_RULES, ...rules },
});

test("resolvePayRulesAsOf: defaults when empty; newest <= date wins; future ignored", () => {
  assert.deepEqual(pr.resolvePayRulesAsOf([], "2026-06-15"), pr.DEFAULT_PAY_RULES);
  const versions = [
    v("2026-06-10", { sundayOtMultiplier: 2.5 }),
    v("2026-06-01", { sundayOtMultiplier: 2.2 }),
    v("2026-07-01", { sundayOtMultiplier: 3.5 }),
  ];
  assert.equal(pr.resolvePayRulesAsOf(versions, "2026-05-31").sundayOtMultiplier, 2); // before all → defaults
  assert.equal(pr.resolvePayRulesAsOf(versions, "2026-06-05").sundayOtMultiplier, 2.2);
  assert.equal(pr.resolvePayRulesAsOf(versions, "2026-06-10").sundayOtMultiplier, 2.5); // effective ON its date
  assert.equal(pr.resolvePayRulesAsOf(versions, "2026-06-30").sundayOtMultiplier, 2.5); // future version ignored
});

test("normalizePayRules: missing/garbage fields fall back per-field", () => {
  const n = pr.normalizePayRules({ sundayOtMultiplier: 2.5, lateGraceMin: "x" });
  assert.equal(n.sundayOtMultiplier, 2.5);
  assert.equal(n.lateGraceMin, pr.DEFAULT_PAY_RULES.lateGraceMin);
  assert.equal(n.holidayOtMultiplier, 3);
});

test("engine: mid-month Sunday-multiplier change applies PER DATE", () => {
  // ANN (RM2,650 / 26 days / 8h / 1.5x). May 2026: Sundays 10 + 17. A version
  // raises Sunday OT from 2x to 2.5x effective 2026-05-15 — the 10th pays 2x,
  // the 17th pays 2.5x. Base hour = 265000/26/9 (her 8h + 1h lunch span).
  const worker = { basicSalarySen: 265_000, workingDaysPerMonth: 26, workingHoursPerDay: 8, otMultiplier: 1.5 };
  const days = [
    { date: "2026-05-10", hours: 4 }, // Sunday before the change
    { date: "2026-05-17", hours: 4 }, // Sunday after the change
  ];
  const versions = [v("2026-05-15", { sundayOtMultiplier: 2.5 })];
  const r = labor.computeMonthlyLabor({
    worker, year: 2026, month: 5, days,
    publicHolidays: [], absenceThroughDay: 31,
    payRuleVersions: versions,
  });
  const base = 265_000 / 26 / 9;
  assert.equal(r.otSundayHours, 8);
  assert.equal(r.payroll.otSundayPaySen, Math.round(4 * base * 2 + 4 * base * 2.5));
  // Without versions: both Sundays at the default 2x.
  const r0 = labor.computeMonthlyLabor({
    worker, year: 2026, month: 5, days,
    publicHolidays: [], absenceThroughDay: 31,
  });
  assert.equal(r0.payroll.otSundayPaySen, Math.round(8 * base * 2));
});

test("hourly divisor = the worker's day span (hours + lunch); rateHoursPerDay only as fallback (owner 2026-06-11)", () => {
  // Same salary, three workers: 9h (span 10), 7.5h (span 8.5), and hours
  // UNSET (falls back to the rules' rateHoursPerDay = 10). One Monday with
  // 2h weekday OT prices each differently.
  const days = [{ date: "2026-05-04", hours: 11 }]; // Mon
  const run = (workingHoursPerDay) =>
    labor.computeMonthlyLabor({
      worker: { basicSalarySen: 265_000, workingDaysPerMonth: 26, workingHoursPerDay, otMultiplier: 1.5 },
      year: 2026, month: 5, days, publicHolidays: [], absenceThroughDay: 4,
    });
  const day = 265_000 / 26;
  const r9 = run(9); // 11h − 9h std = 2h OT at ÷(9+1)
  assert.equal(r9.payroll.otPaySen, Math.round(2 * (day / 10) * 1.5));
  const r75 = run(7.5); // 11h − 7.5h std = 3.5h OT at ÷(7.5+1)
  assert.equal(r75.payroll.otPaySen, Math.round(3.5 * (day / 8.5) * 1.5));
  const r0h = run(0); // no hours set → no weekday OT threshold, fallback ÷10 idle
  assert.equal(r0h.payroll.otPaySen, 0);
  // The short-hour dock uses the same span: 1h docked at ÷8.5 vs ÷10.
  const dock = (workingHoursPerDay) =>
    labor.computeMonthlyLabor({
      worker: { basicSalarySen: 265_000, workingDaysPerMonth: 26, workingHoursPerDay, otMultiplier: 1.5 },
      year: 2026, month: 5, days, publicHolidays: [], absenceThroughDay: 4,
      shortHourDeductionHours: 1,
    }).payroll.shortHourDeductionSen;
  assert.equal(dock(7.5), Math.round(day / 8.5));
  assert.equal(dock(9), Math.round(day / 10));
  assert.equal(dock(0), Math.round(day / 10)); // fallback rateHoursPerDay
  // A lunch change (effective-dated) moves the span: 30-min lunch → ÷9.5.
  const rLunch = labor.computeMonthlyLabor({
    worker: { basicSalarySen: 265_000, workingDaysPerMonth: 26, workingHoursPerDay: 9, otMultiplier: 1.5 },
    year: 2026, month: 5, days, publicHolidays: [], absenceThroughDay: 4,
    shortHourDeductionHours: 1,
    payRuleVersions: [v("2026-05-01", { lunchMin: 30 })],
  });
  assert.equal(rLunch.payroll.shortHourDeductionSen, Math.round(day / 9.5));
});

test("divisor MODES (owner 2026-06-11 dropdown): day ÷26 / ÷calendar / ÷working-days; hour span/only/fixed", () => {
  // ANN: RM2,650, 26 days, 8h. May 2026: 31 calendar days, 24 working days
  // (2 weekday holidays). Absent 2 of the 24 working days.
  const holidays = ["2026-05-01", "2026-05-27"];
  const days = [];
  for (let i = 2; i <= 30; i++) {
    const d = new Date(2026, 4, i);
    if (d.getDay() === 0) continue;
    const iso = `2026-05-${String(i).padStart(2, "0")}`;
    if (holidays.includes(iso)) continue;
    days.push({ date: iso, hours: 8 });
  }
  days.splice(0, 2); // first 2 working days absent
  const run = (rules) =>
    labor.computeMonthlyLabor({
      worker: { basicSalarySen: 265_000, workingDaysPerMonth: 26, workingHoursPerDay: 8, otMultiplier: 1.5 },
      year: 2026, month: 5, days,
      publicHolidays: holidays, absenceThroughDay: 31,
      payRuleVersions: rules ? [v("2026-05-01", rules)] : undefined,
    });
  // Default fixed26: 2 × 265000/26.
  assert.equal(run(undefined).payroll.absenceDeductionSen, Math.round(2 * (265_000 / 26)));
  // Calendar days: 2 × 265000/31 (the old pre-unification behaviour, now a choice).
  assert.equal(
    run({ dayRateDivisorMode: "calendarDays" }).payroll.absenceDeductionSen,
    Math.round(2 * (265_000 / 31)),
  );
  // Actual working days: 2 × 265000/24.
  assert.equal(
    run({ dayRateDivisorMode: "workingDays" }).payroll.absenceDeductionSen,
    Math.round(2 * (265_000 / 24)),
  );
  // Hour modes price a 1h dock differently (ANN is an 8h worker):
  const dock = (rules) =>
    labor.computeMonthlyLabor({
      worker: { basicSalarySen: 265_000, workingDaysPerMonth: 26, workingHoursPerDay: 8, otMultiplier: 1.5 },
      year: 2026, month: 5, days,
      publicHolidays: holidays, absenceThroughDay: 31,
      shortHourDeductionHours: 1,
      payRuleVersions: rules ? [v("2026-05-01", rules)] : undefined,
    }).payroll.shortHourDeductionSen;
  assert.equal(dock(undefined), Math.round(265_000 / 26 / 9)); // hours+lunch: 8+1
  assert.equal(dock({ hourRateDivisorMode: "hoursOnly" }), Math.round(265_000 / 26 / 8));
  assert.equal(dock({ hourRateDivisorMode: "fixed" }), Math.round(265_000 / 26 / 10)); // rateHoursPerDay
});

test("normalizePayRules: divisor modes — garbage falls back, valid values kept", () => {
  assert.equal(pr.normalizePayRules({}).dayRateDivisorMode, "fixed26");
  assert.equal(pr.normalizePayRules({}).hourRateDivisorMode, "hoursPlusLunch");
  assert.equal(pr.normalizePayRules({ dayRateDivisorMode: "banana" }).dayRateDivisorMode, "fixed26");
  assert.equal(pr.normalizePayRules({ dayRateDivisorMode: "calendarDays" }).dayRateDivisorMode, "calendarDays");
  assert.equal(pr.normalizePayRules({ dayRateDivisorMode: "workingDays" }).dayRateDivisorMode, "workingDays");
  assert.equal(pr.normalizePayRules({ hourRateDivisorMode: "hoursOnly" }).hourRateDivisorMode, "hoursOnly");
  assert.equal(pr.normalizePayRules({ hourRateDivisorMode: "fixed" }).hourRateDivisorMode, "fixed");
});

test("toAttendanceRules: a 15-min grace version makes 08:12 on-time", () => {
  const cfg = pr.normalizePayRules({ lateGraceMin: 15 });
  const rules = pr.toAttendanceRules(cfg);
  assert.equal(rules.standardWorkMin, 540); // 08:00-18:00 minus 60 lunch
  const d = att.computeAttendanceDay(8 * 60 + 12, 18 * 60, rules);
  assert.equal(d.isLate, false);
  assert.equal(d.shortfallMin, 0);
  // The DEFAULT grace is now 15 too, so the same punch is on-time either way.
  // A stricter stored version still bites: grace 10, charged to the minute.
  const d0 = att.computeAttendanceDay(8 * 60 + 12, 18 * 60);
  assert.equal(d0.shortfallMin, 0);
  const strict = pr.toAttendanceRules(pr.normalizePayRules({ lateGraceMin: 10, lateBlockMin: 1 }));
  assert.equal(att.computeAttendanceDay(8 * 60 + 12, 18 * 60, strict).shortfallMin, 12);
});
