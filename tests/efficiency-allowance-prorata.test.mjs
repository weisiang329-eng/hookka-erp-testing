// ---------------------------------------------------------------------------
// The efficiency allowance is pro-rated by days actually worked.
//
// Owner 2026-08-06: "如果一个月有 27 天的工作天，他两天没有来，代表这两天其实是
// 没有工作的 … 可是如果因为他的效率达到 100% 我却还要给他 150 块，那其实我这两
// 天是亏了的 … 如果他没有来，即使效率达到了也是会扣钱的；那如果他没有达到效率，
// 当然是没有."
//
// Efficiency is a RATE — minutes produced per hour present — so someone who
// came 24 of 26 days can sit at 100% while producing two days less. The flat
// bonus paid for output that was never made.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { resolveEfficiencyAllowanceSen } from "../src/api/lib/efficiency-allowance.ts";

const eff = (pct) => ({ prodMinutes: 0, prodHours: 0, daysWithEntries: 0, pct });
const RM150 = 15000;

test("full attendance still earns the full bonus", () => {
  const v = resolveEfficiencyAllowanceSen(eff(105), RM150, 100, { workingDays: 26, absentDays: 0 });
  assert.equal(v, RM150);
});

test("missing days scales it down — the owner's own figures", () => {
  // Verified against prod July 2026 before shipping.
  const one = resolveEfficiencyAllowanceSen(eff(110), RM150, 100, { workingDays: 26, absentDays: 1 });
  const two = resolveEfficiencyAllowanceSen(eff(110), RM150, 100, { workingDays: 26, absentDays: 2 });
  assert.equal(one, 14423, "26 days, 1 absent → RM 144.23");
  assert.equal(two, 13846, "26 days, 2 absent → RM 138.46");
});

test("missing the efficiency target earns nothing, however good the attendance", () => {
  // The gate comes first. Perfect attendance does not buy the bonus.
  assert.equal(
    resolveEfficiencyAllowanceSen(eff(99.4), RM150, 100, { workingDays: 26, absentDays: 0 }),
    0,
  );
});

test("absent every day earns nothing even at 100%", () => {
  assert.equal(
    resolveEfficiencyAllowanceSen(eff(100), RM150, 100, { workingDays: 26, absentDays: 26 }),
    0,
  );
  // More absences than working days must not go negative.
  assert.equal(
    resolveEfficiencyAllowanceSen(eff(100), RM150, 100, { workingDays: 26, absentDays: 40 }),
    0,
  );
});

test("an unconfigured bonus stays unconfigured", () => {
  const att = { workingDays: 26, absentDays: 0 };
  assert.equal(resolveEfficiencyAllowanceSen(eff(120), 0, 100, att), 0);
  assert.equal(resolveEfficiencyAllowanceSen(eff(120), RM150, 0, att), 0, "threshold 0 means off");
  assert.equal(resolveEfficiencyAllowanceSen(eff(null), RM150, 100, att), 0, "no efficiency → no bonus");
  assert.equal(resolveEfficiencyAllowanceSen(undefined, RM150, 100, att), 0);
});

test("a caller that passes no attendance keeps the old behaviour", () => {
  // Fail SAFE, not silent-zero: a caller not yet updated must not quietly stop
  // paying everyone.
  assert.equal(resolveEfficiencyAllowanceSen(eff(100), RM150, 100), RM150);
  assert.equal(
    resolveEfficiencyAllowanceSen(eff(100), RM150, 100, { workingDays: 0, absentDays: 0 }),
    RM150,
    "zero working days is unusable data, not a reason to pay nothing",
  );
});

test("both payslip call sites pass attendance", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const src = readFileSync(resolve(process.cwd(), "src/api/routes/payslips.ts"), "utf8");
  // Both allowance call sites — generate and regenerate — must pass it. A
  // bonus that differs between the two is worse than either rule alone.
  const sites = [...src.matchAll(/resolveEfficiencyAllowanceSen\(([\s\S]{0,320}?)\)\s*;/g)];
  assert.equal(sites.length, 2, "expected exactly two allowance call sites in payslips.ts");
  for (const [i, m] of sites.entries()) {
    assert.match(m[1], /absentDays: labor\.payroll\.absentDays/, `call site ${i + 1} does not pass attendance`);
    assert.match(m[1], /workingDays: worker\.workingDaysPerMonth/, `call site ${i + 1} does not pass working days`);
  }
});
