// ---------------------------------------------------------------------------
// broken-punch-credit-rule.test.mjs — the leniency knob (owner 2026-08-01,
// 「前期我们松一点通融点」).
//
// A worker who forgets the morning punch and taps in AND out at knock-off
// leaves a window with no payable minutes (18:01 in / 18:02 out). They were
// demonstrably AT the factory, but the day logs no hours and counts as a full
// absence. `brokenPunchCreditsFullDay` credits the contracted shift instead.
//
// It is a PAY RULE, not a constant, so it is effective-dated: run it on while
// the floor learns the punch app, then flip it off from a chosen date. These
// tests pin the default (lenient), the off switch, and — most important — that
// turning it on never changes a NORMAL day.
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

const { DEFAULT_PAY_RULES, normalizePayRules, resolvePayRulesAsOf, toAttendanceRules } =
  await import(pathToFileURL(resolve(process.cwd(), "src/lib/pay-rules.ts")).href);
const { computeAttendanceDay } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/attendance-rules.ts")).href
);

test("default is LENIENT — the owner's call for the early period", () => {
  assert.equal(DEFAULT_PAY_RULES.brokenPunchCreditsFullDay, true);
});

test("a stored version predating the knob stays lenient", () => {
  // An older row simply has no such field; it must not silently go strict.
  const r = normalizePayRules({ absenceGraceWorkingDays: 1 });
  assert.equal(r.brokenPunchCreditsFullDay, true);
});

test("only an explicit false turns it off", () => {
  assert.equal(normalizePayRules({ brokenPunchCreditsFullDay: false }).brokenPunchCreditsFullDay, false);
  assert.equal(normalizePayRules({ brokenPunchCreditsFullDay: true }).brokenPunchCreditsFullDay, true);
});

test("effective-dated: lenient before the cutover, strict from it", () => {
  const versions = [
    { id: "v1", effectiveFrom: "2026-01-01", rules: normalizePayRules({}) },
    { id: "v2", effectiveFrom: "2026-10-01", rules: normalizePayRules({ brokenPunchCreditsFullDay: false }) },
  ];
  assert.equal(resolvePayRulesAsOf(versions, "2026-08-15").brokenPunchCreditsFullDay, true);
  assert.equal(resolvePayRulesAsOf(versions, "2026-10-01").brokenPunchCreditsFullDay, false);
  assert.equal(resolvePayRulesAsOf(versions, "2026-12-31").brokenPunchCreditsFullDay, false);
});

// The condition the clock-out handler uses to decide "this punch is broken".
const isBroken = (inHHMM, outHHMM, cfg) => {
  const m = (s) => {
    const x = /^(\d{1,2}):(\d{2})$/.exec(s);
    return x ? Number(x[1]) * 60 + Number(x[2]) : null;
  };
  const i = m(inHHMM), o = m(outHHMM);
  if (i == null || o == null || o <= i) return true;
  const day = computeAttendanceDay(i, o, toAttendanceRules(cfg));
  return day.regularWorkMin <= 0 && day.otMin <= 0;
};

test("the broken-punch shapes we actually saw are detected", () => {
  const cfg = DEFAULT_PAY_RULES;
  assert.equal(isBroken("18:01", "18:02", cfg), true); // KYAW ZIN OO 2026-07-01
  assert.equal(isBroken("18:01", "18:01", cfg), true); // THI THI AYE 2026-07-01
  assert.equal(isBroken("07:42", "07:43", cfg), true); // TUN TUN NAING 2026-06-30
  assert.equal(isBroken("18:03", "18:00", cfg), true); // inverted (EMP-001 7/04)
});

test("a NORMAL day is never treated as broken — the leniency must not leak", () => {
  const cfg = DEFAULT_PAY_RULES;
  assert.equal(isBroken("08:00", "18:00", cfg), false); // full day
  assert.equal(isBroken("09:09", "18:03", cfg), false); // real late arrival
  assert.equal(isBroken("08:00", "14:00", cfg), false); // real half day
  assert.equal(isBroken("08:00", "20:00", cfg), false); // day + OT
});
