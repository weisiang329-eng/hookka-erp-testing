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

test("11 min late = just over grace → rounds UP to a 15-min block (owner 2026-06-11)", () => {
  // Lateness ceils to 15-min blocks: even 1 min into a block costs the block.
  assert.equal(day("08:11", "18:00").shortfallMin, 15);
  assert.equal(day("08:16", "18:00").shortfallMin, 30); // 16 min → next block
  assert.equal(day("08:30", "18:00").shortfallMin, 30); // exact block boundary
  assert.equal(day("08:31", "18:00").shortfallMin, 45);
});

test("leaving early is also a shortfall (17:30 → 30 min short), no grace", () => {
  const d = day("08:00", "17:30");
  assert.equal(d.shortfallMin, 30);
  assert.equal(d.isLate, false);
});

test("late + early are one combined shortfall, not double-counted", () => {
  // 08:20 in (20 late) + 17:40 out (20 early) → 40 min short total.
  const d = day("08:20", "17:40");
  assert.equal(d.lateMin, 20); // raw lateness reported as-is
  // Late 20 → penal 30 (ceiled block) + early 20 (exact) = 50 min short total.
  assert.equal(d.shortfallMin, 50);
});

test("OT needs 30 min (owner 2026-07-04): 18:14/18:16/18:28/18:29 → 0, 18:30 → 30", () => {
  assert.equal(day("08:00", "18:14").otMin, 0);
  assert.equal(day("08:00", "18:15").otMin, 0);
  assert.equal(day("08:00", "18:16").otMin, 0); // was 15 pre-2026-07-04
  assert.equal(day("08:00", "18:28").otMin, 0); // the owner's exact example
  assert.equal(day("08:00", "18:30").otMin, 30);
});

test("OT rounding within the hour (18:30→30, 18:45→45, 18:59→45)", () => {
  assert.equal(day("08:00", "18:29").otMin, 0); // below the 30-min OT threshold
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
  // Sub-30-min tail no longer counts at all (owner 2026-07-04): 18:20 out is
  // 0 OT, so the full 30-min morning gap is docked.
  const e = day("08:30", "18:20");
  assert.equal(e.otMin, 0);
  assert.equal(e.shortfallMin, 30);
});

// ── Lunch (12:00–13:00) is deducted only for the overlap with the worked
//    window — owner 2026-06-28: arrive after 1pm and you missed the break, so
//    it isn't docked; you just came a half day. ──────────────────────────────
test("arrive AFTER lunch (13:58 -> 18:00) -> NO lunch deducted (owner 2026-06-28)", () => {
  // 13:58 ceils to 14:00; lunch window is entirely before the shift, 0 overlap
  // -> 18:00-14:00 = 4h (was 3h when the hour was always cut).
  const d = day("13:58", "18:00");
  assert.equal(d.regularWorkMin, 4 * 60);
});

test("arrive DURING lunch (12:30 -> 18:00) -> only the remaining 30 min drops", () => {
  const d = day("12:30", "18:00");
  assert.equal(d.regularWorkMin, 5 * 60); // 5.5h on shift - 30 min lunch overlap
});

test("leave BEFORE lunch (08:00 -> 11:00) -> no lunch deducted (none taken)", () => {
  const d = day("08:00", "11:00");
  assert.equal(d.regularWorkMin, 3 * 60);
});
