// ---------------------------------------------------------------------------
// attendance-rules.test.mjs — locks Wei Siang's punch→pay spec to the minute
// (src/lib/attendance-rules.ts). Shift 08:00–18:00, 1h lunch = 9 payable hours;
// 10-min late grace; shortfall deducted at hourly; OT past 18:00, must exceed
// 15 min, clock-out minute floored 0-15→0/16-29→15/30-44→30/45-59→45.
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

const A = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/attendance-rules.ts")).href
);

const at = (hhmm) => A.hhmmToMinutes(hhmm);
const day = (inHHMM, outHHMM) =>
  A.computeAttendanceDay(at(inHHMM), at(outHHMM));

test("hhmmToMinutes parses HH:MM and rejects garbage", () => {
  assert.equal(at("08:00"), 480);
  assert.equal(at("18:45"), 1125);
  assert.equal(at("0:00"), 0);
  assert.equal(at("25:00"), null);
  assert.equal(at("08:60"), null);
  assert.equal(at("8-5"), null);
  assert.equal(at(null), null);
});

test("roundOutMinute floors to COMPLETED quarters — 15 earns 15", () => {
  // HR via owner 2026-08-02: 「不满 15 分钟不算，要做满 15 分钟才会算 15 分钟」.
  // The old table returned 0 for exactly 15 (a 2026-06-09 note read the rule as
  // "must EXCEED 15"), so someone who stayed to precisely 18:15 was paid nothing.
  assert.equal(A.roundOutMinute(0), 0);
  assert.equal(A.roundOutMinute(14), 0);
  assert.equal(A.roundOutMinute(15), 15);
  assert.equal(A.roundOutMinute(16), 15);
  assert.equal(A.roundOutMinute(29), 15);
  assert.equal(A.roundOutMinute(30), 30);
  assert.equal(A.roundOutMinute(44), 30);
  assert.equal(A.roundOutMinute(45), 45);
  assert.equal(A.roundOutMinute(59), 45);
});

test("on-time full day = 9h, no shortfall, no OT", () => {
  const d = day("08:00", "18:00");
  assert.deepEqual(d, {
    lateMin: 0,
    isLate: false,
    regularWorkMin: 540,
    shortfallMin: 0,
    otMin: 0,
  });
});

test("late within the 10-min grace is forgiven (08:10 still full pay)", () => {
  const d = day("08:10", "18:00");
  assert.equal(d.isLate, false);
  assert.equal(d.lateMin, 0);
  assert.equal(d.shortfallMin, 0); // forgiven — no deduction
});

test("15 minutes late is still WITHIN grace — nothing docked", () => {
  // Grace is 15 (HR via owner 2026-08-02: 「允许员工迟到 15 分钟」). It was 10.
  const d = day("08:15", "18:00");
  assert.equal(d.isLate, false);
  assert.equal(d.lateMin, 0);
  assert.equal(d.shortfallMin, 0);
  assert.equal(d.otMin, 0);
});

test("past grace, the ACTUAL minutes are docked — no block rounding", () => {
  // 「当超过了 15 分钟，就会以分钟来计算，根据具体迟到了多少分钟来扣钱」.
  // The grace stays a threshold, not a free allowance: 08:16 owes 16, not 1.
  assert.equal(day("08:16", "18:00").shortfallMin, 16);
  assert.equal(day("08:17", "18:00").shortfallMin, 17);
  assert.equal(day("08:31", "18:00").shortfallMin, 31);
  assert.equal(day("08:16", "18:00").lateMin, 16);
});

test("11 minutes late is inside the 15-minute grace", () => {
  // Under the old 10-min grace + ceil-to-15 this cost a full 15 minutes.
  assert.equal(day("08:11", "18:00").shortfallMin, 0);
  assert.equal(day("08:11", "18:00").isLate, false);
});

test("leaving early is also a shortfall (17:30 → 30 min short), no grace", () => {
  const d = day("08:00", "17:30");
  assert.equal(d.shortfallMin, 30);
  assert.equal(d.isLate, false);
});

test("late + early are one combined shortfall, not double-counted", () => {
  // 08:20 in (20 late, past grace → charged as 20) + 17:40 out (20 early) = 40.
  // Under the old ceil-to-15 the same day cost 50.
  const d = day("08:20", "17:40");
  assert.equal(d.lateMin, 20);
  assert.equal(d.shortfallMin, 40);
});

test("OT needs a COMPLETED 15 minutes (HR, owner 2026-08-02)", () => {
  // 「只要做满 15 分钟，就会算 15 分钟的 OT … 做 20 分钟只算 15，做 29 分钟也
  // 只算 15，做 30 分钟就算 30」. Between 2026-07-04 and 2026-08-02 the floor
  // was 30, so every one of these except the last paid nothing.
  assert.equal(day("08:00", "18:14").otMin, 0);
  assert.equal(day("08:00", "18:15").otMin, 15);
  assert.equal(day("08:00", "18:20").otMin, 15);
  assert.equal(day("08:00", "18:29").otMin, 15);
  assert.equal(day("08:00", "18:30").otMin, 30);
});

test("OT rounding within the hour (18:30→30, 18:45→45, 18:59→45)", () => {
  assert.equal(day("08:00", "18:29").otMin, 15); // one completed quarter
  assert.equal(day("08:00", "18:30").otMin, 30);
  assert.equal(day("08:00", "18:44").otMin, 30);
  assert.equal(day("08:00", "18:45").otMin, 45); // the table's deciding case
  assert.equal(day("08:00", "18:50").otMin, 45);
  assert.equal(day("08:00", "18:59").otMin, 45);
});

test("OT across hours (19:00→60, 20:30→150, 20:50→165)", () => {
  assert.equal(day("08:00", "19:00").otMin, 60);
  assert.equal(day("08:00", "20:30").otMin, 150);
  assert.equal(day("08:00", "20:50").otMin, 165);
});

test("same-day OT OFFSETS the morning shortfall (08:20 → 19:00)", () => {
  // Owner spec 2026-06-11: evening OT covers the morning gap at 1:1 first —
  // only a remainder is docked. 20 min late, 60 min OT → shortfall 0; otMin
  // stays the FULL 60 (the grid logs regular+OT, and the payroll engine pays
  // only hours above the 9h standard, so the paid OT nets naturally there).
  const d = day("08:20", "19:00");
  assert.equal(d.shortfallMin, 0);
  assert.equal(d.otMin, 60);
});

test("owner scenario: 30 min late + 2h OT (08:30 -> 20:00) -> no dock, engine pays 1.5h OT", () => {
  const d = day("08:30", "20:00");
  assert.equal(d.isLate, true);
  assert.equal(d.regularWorkMin, 8.5 * 60); // 18:00 - 08:30 - 1h lunch
  assert.equal(d.otMin, 120); // grid Hours = 8.5 + 2 = 10.5 logged
  assert.equal(d.shortfallMin, 0); // OT covered the 30 min — nothing docked
  // (10.5 logged - 9 std -> the payroll engine pays exactly 1.5h at the OT rate)
});

test("OT smaller than the shortfall -> only the remainder is docked (08:30 -> 18:35)", () => {
  // 30 min late, 30 min rounded OT -> the evening covers the morning, dock 0.
  const d = day("08:30", "18:35");
  assert.equal(d.otMin, 30);
  assert.equal(d.shortfallMin, 0);
  // A completed quarter DOES count now (HR, 2026-08-02): 18:20 out is 15 min
  // of OT, which offsets 15 of the 30-minute morning gap. Under the 30-minute
  // floor this tail was worth nothing and the whole 30 was docked.
  const e = day("08:30", "18:20");
  assert.equal(e.otMin, 15);
  assert.equal(e.shortfallMin, 15);
});

// ── Lunch (12:00–13:00) is deducted only for the overlap with the worked
//    window — owner 2026-06-28: arrive after 1pm and you missed the break, so
//    it isn't docked; you just came a half day. ──────────────────────────────
test("arrive AFTER lunch (13:58 -> 18:00) -> NO lunch deducted (owner 2026-06-28)", () => {
  // Lateness is charged to the MINUTE now, so 13:58 is 13:58 — it no longer
  // ceils to 14:00, and the day is 4h02m rather than a rounded 4h. The point of
  // the case is unchanged: the lunch window is entirely before the shift, so
  // zero overlap and no hour is cut.
  const d = day("13:58", "18:00");
  assert.equal(d.regularWorkMin, 4 * 60 + 2);
});

test("arrive DURING lunch (12:30 -> 18:00) -> only the remaining 30 min drops", () => {
  const d = day("12:30", "18:00");
  assert.equal(d.regularWorkMin, 5 * 60); // 5.5h on shift - 30 min lunch overlap
});

test("leave BEFORE lunch (08:00 -> 11:00) -> no lunch deducted (none taken)", () => {
  const d = day("08:00", "11:00");
  assert.equal(d.regularWorkMin, 3 * 60);
});

// ── One OT minimum for the whole system (owner 2026-08-01: 「全系统统一」) ───
//
// Overtime was derived independently on four surfaces — the punch, the payroll
// engine's logged-hours path, the worker's own My Pay screen and the office
// attendance grid — and only the punch applied the 30-minute minimum. A worker
// could see 0.02h of overtime on their phone for a day the payslip paid nothing.
test("otMinutesAtLeastMinimum: below ONE completed block earns nothing", () => {
  assert.equal(A.otMinutesAtLeastMinimum(1), 0);
  assert.equal(A.otMinutesAtLeastMinimum(14), 0);
  assert.equal(A.otMinutesAtLeastMinimum(15), 15);
  assert.equal(A.otMinutesAtLeastMinimum(29), 15);
  assert.equal(A.otMinutesAtLeastMinimum(0), 0);
  assert.equal(A.otMinutesAtLeastMinimum(-5), 0);
});

test("otMinutesAtLeastMinimum: 30 minutes and up is paid in full", () => {
  assert.equal(A.otMinutesAtLeastMinimum(30), 30);
  assert.equal(A.otMinutesAtLeastMinimum(45), 45);
  assert.equal(A.otMinutesAtLeastMinimum(120), 120);
});

test("otMinutesAtLeastMinimum agrees with the punch path at the boundary", () => {
  // The punch path and the logged-hours path must never disagree — a worker
  // seeing OT on their phone that the payslip does not pay is the bug this
  // shared helper exists to prevent.
  for (const [mins, want] of [[14, 0], [15, 15], [29, 15], [30, 30], [44, 30], [45, 45]]) {
    assert.equal(
      A.computeAttendanceDay(8 * 60, 18 * 60 + mins).otMin,
      want,
      `punch path at 18:${String(mins).padStart(2, "0")}`,
    );
    assert.equal(A.otMinutesAtLeastMinimum(mins), want, `logged-hours path at ${mins}`);
  }
});
