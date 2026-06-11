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
  // the 17th pays 2.5x. Base hour = 265000/26/10.
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
  const base = 265_000 / 26 / 10;
  assert.equal(r.otSundayHours, 8);
  assert.equal(r.payroll.otSundayPaySen, Math.round(4 * base * 2 + 4 * base * 2.5));
  // Without versions: both Sundays at the default 2x.
  const r0 = labor.computeMonthlyLabor({
    worker, year: 2026, month: 5, days,
    publicHolidays: [], absenceThroughDay: 31,
  });
  assert.equal(r0.payroll.otSundayPaySen, Math.round(8 * base * 2));
});

test("toAttendanceRules: a 15-min grace version makes 08:12 on-time", () => {
  const cfg = pr.normalizePayRules({ lateGraceMin: 15 });
  const rules = pr.toAttendanceRules(cfg);
  assert.equal(rules.standardWorkMin, 540); // 08:00-18:00 minus 60 lunch
  const d = att.computeAttendanceDay(8 * 60 + 12, 18 * 60, rules);
  assert.equal(d.isLate, false);
  assert.equal(d.shortfallMin, 0);
  // Default grace (10): 08:12 is late → ceiled to a 15-min block.
  const d0 = att.computeAttendanceDay(8 * 60 + 12, 18 * 60);
  assert.equal(d0.shortfallMin, 15);
});
