// ---------------------------------------------------------------------------
// punch-degenerate-window.test.mjs — BUG-2026-08-01-002.
//
// A worker who forgets the MORNING punch and does both at knock-off leaves a
// window like 18:01 IN / 18:02 OUT. That is technically "valid" (out > in), and
// the shift maths turned it into a FULL day's shortfall — docked on top of the
// absence the same day already carried, because it had no logged hours either.
// KYAW ZIN OO 2026-07-01: RM78.85 absence + RM70.96 hour dock = RM149.81 for a
// day he was physically at the factory.
//
// Rule: a window that yields NO payable minutes at all is a BROKEN PUNCH, not a
// zero-hour day. It is not evidence, so it docks nothing and the day is left to
// the absence rule / the office.
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

const { computePunchShortfallHours } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/attendance-deduct.ts")).href
);

test("18:01 → 18:02 is a broken punch, not a 9h shortfall", () => {
  const r = computePunchShortfallHours("18:01", "18:02");
  assert.equal(r.shortfallHours, 0);
  assert.equal(r.valid, false); // not evidence — nothing to dock
});

test("same-minute punch (18:01 → 18:01) docks nothing", () => {
  const r = computePunchShortfallHours("18:01", "18:01");
  assert.equal(r.shortfallHours, 0);
});

test("a late-evening sliver of work still docks nothing rather than a full day", () => {
  // 17:50 → 18:00: after the late blocks there are no payable regular minutes.
  // The day's absence (no logged hours) is the bigger charge anyway.
  const r = computePunchShortfallHours("17:50", "18:00");
  assert.equal(r.shortfallHours, 0);
});

test("a REAL short day is still docked — the guard must not swallow those", () => {
  // 08:00 → 14:00 = 5h payable against a 9h day.
  const r = computePunchShortfallHours("08:00", "14:00");
  assert.equal(r.valid, true);
  assert.equal(r.shortfallHours, 4);
});

test("a real late arrival is still docked", () => {
  // 09:09 in (69 min late, rounds up to 75) → EI PHOO WEI 2026-07-11: 1.25h.
  const r = computePunchShortfallHours("09:09", "18:03");
  assert.equal(r.valid, true);
  assert.equal(r.shortfallHours, 1.25);
});

test("a full day is still zero", () => {
  const r = computePunchShortfallHours("08:00", "18:00");
  assert.equal(r.valid, true);
  assert.equal(r.shortfallHours, 0);
});
