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

test("roundOutMinute floors to the confirmed quarters (15→0 enforces >15)", () => {
  assert.equal(A.roundOutMinute(0), 0);
  assert.equal(A.roundOutMinute(15), 0); // 15 → 0 (must EXCEED 15)
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

test("late beyond grace deducts from 08:00 (08:15 → 15 min short)", () => {
  const d = day("08:15", "18:00");
  assert.equal(d.isLate, true);
  assert.equal(d.lateMin, 15);
  assert.equal(d.shortfallMin, 15);
  assert.equal(d.otMin, 0);
});

test("11 min late = just over grace → 11 min short", () => {
  assert.equal(day("08:11", "18:00").shortfallMin, 11);
});

test("leaving early is also a shortfall (17:30 → 30 min short), no grace", () => {
  const d = day("08:00", "17:30");
  assert.equal(d.shortfallMin, 30);
  assert.equal(d.isLate, false);
});

test("late + early are one combined shortfall, not double-counted", () => {
  // 08:20 in (20 late) + 17:40 out (20 early) → 40 min short total.
  const d = day("08:20", "17:40");
  assert.equal(d.lateMin, 20);
  assert.equal(d.shortfallMin, 40);
});

test("OT must exceed 15 min: 18:14 and 18:15 → 0, 18:16 → 15", () => {
  assert.equal(day("08:00", "18:14").otMin, 0);
  assert.equal(day("08:00", "18:15").otMin, 0);
  assert.equal(day("08:00", "18:16").otMin, 15);
});

test("OT rounding within the hour (18:30→30, 18:45→45, 18:59→45)", () => {
  assert.equal(day("08:00", "18:29").otMin, 15);
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

test("late AND overtime in the same day are independent (08:20 → 19:00)", () => {
  const d = day("08:20", "19:00");
  assert.equal(d.shortfallMin, 20); // 20 min late in the morning
  assert.equal(d.otMin, 60); // 1h OT in the evening
});
