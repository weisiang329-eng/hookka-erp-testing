// ---------------------------------------------------------------------------
// planning-packer.test.mjs — pins the two owner red lines the shared packer
// exists to enforce (owner 2026-08-03):
//
//   1. "不要排得太多导致做不来，也不要排得太少"
//      No day may exceed its budget (plus, at most, the humane OT ceiling),
//      and no day may sit empty while work that could run on it waits behind.
//
//   2. "不要突然有一天直接开 10 个小时的 OT，一个工作人员怎么能一天连续做 20
//      个小时呢？所以你一定要提前把 OT 分摊开"
//      Overtime is capped per day, spread FLAT, and starts on day 0 — never
//      banked up and dumped on the day before the deadline.
//
// Plus the honesty rule: when even a fully-spread, capped OT plan cannot make
// a deadline, the packer reports it instead of quietly scheduling it late.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import {
  packDepartment,
  slackDays,
  cmpPriority,
} from "../src/api/lib/planning-packer.ts";

const DAY = 480; // one 8h working day of budget

function unit(id, minutes, floorIdx = 0, deadlineIdx = null, priority = [0], groupKey) {
  return { id, minutes, floorIdx, deadlineIdx, priority, groupKey };
}

function baseOpts(over = {}) {
  return {
    horizonLength: 10,
    dailyBudgetMin: DAY,
    otMaxMinPerDay: 120, // owner red line: 2h
    ...over,
  };
}

test("fills each day to its budget before moving on — no half-empty days", () => {
  // Six half-day units should occupy exactly three days, not six.
  const units = Array.from({ length: 6 }, (_, i) => unit(`u${i}`, DAY / 2, 0, null, [i]));
  const r = packDepartment(units, baseOpts());

  assert.equal(r.unplaced.length, 0);
  const usedDays = [...r.loadByDay.keys()].sort((a, b) => a - b);
  assert.deepEqual(usedDays, [0, 1, 2]);
  for (const d of usedDays) assert.equal(r.loadByDay.get(d), DAY);
  assert.equal(r.otTotalMin, 0, "no deadline pressure means no overtime");
});

test("never hands a day more than its budget", () => {
  const units = Array.from({ length: 20 }, (_, i) => unit(`u${i}`, 300, 0, null, [i]));
  const r = packDepartment(units, baseOpts());
  for (const [, mins] of r.loadByDay) {
    assert.ok(mins <= DAY, `day loaded to ${mins}, over budget ${DAY}`);
  }
});

test("a unit bigger than a whole day is split across days, not crammed into one", () => {
  const r = packDepartment([unit("big", DAY * 3 + 100)], baseOpts());
  const rows = r.placements.filter((p) => p.id === "big");
  assert.ok(rows.length >= 4, "oversize unit should span several days");
  for (const [, mins] of r.loadByDay) assert.ok(mins <= DAY);
  const total = rows.reduce((s, p) => s + p.minutes, 0);
  assert.equal(total, DAY * 3 + 100, "no work may be lost in the split");
});

test("respects the earliest-start floor", () => {
  const r = packDepartment([unit("late-start", 200, 4)], baseOpts());
  const p = r.placements.find((x) => x.id === "late-start");
  assert.ok(p.dayIdx >= 4, "must not schedule before upstream is done");
});

test("priority order decides who gets the scarce slot", () => {
  // Two full-day units, both able to start on day 0. Lower priority key first.
  const r = packDepartment(
    [unit("relaxed", DAY, 0, null, [99]), unit("urgent", DAY, 0, null, [1])],
    baseOpts(),
  );
  const urgent = r.placements.find((p) => p.id === "urgent");
  const relaxed = r.placements.find((p) => p.id === "relaxed");
  assert.ok(urgent.dayIdx < relaxed.dayIdx, "the tighter unit must go first");
});

test("no overtime is proposed when nothing is at risk", () => {
  const r = packDepartment([unit("easy", DAY, 0, 5)], baseOpts());
  assert.equal(r.otApplied, false);
  assert.equal(r.otTotalMin, 0);
  assert.equal(r.late.length, 0);
});

test("overtime starts on day 0 and is spread flat — never a single-day spike", () => {
  // Five days of budget crammed into a four-day deadline: needs OT to land.
  const units = Array.from({ length: 5 }, (_, i) => unit(`u${i}`, DAY, 0, 3, [i]));
  const r = packDepartment(units, baseOpts({ horizonLength: 12 }));

  assert.equal(r.otApplied, true, "OT should have been applied to save the deadline");

  const otDays = [...r.otByDay.entries()].sort((a, b) => a[0] - b[0]);
  assert.ok(otDays.length > 0);

  // Red line 1: never more than the humane per-day ceiling.
  for (const [day, mins] of otDays) {
    assert.ok(mins <= 120, `day ${day} was handed ${mins}min of OT, over the 2h cap`);
  }

  // Red line 2: it must START EARLY, not be dumped at the end.
  assert.equal(otDays[0][0], 0, "OT must begin on the first day, not the last");

  // Red line 3: flat. Every OT day carries within one minute of every other
  // (integer rounding aside) — no day absorbs the whole overload.
  const amounts = otDays.map(([, m]) => m);
  const spread = Math.max(...amounts) - Math.min(...amounts);
  assert.ok(spread <= 1, `OT is not flat: spread of ${spread}min across days`);
});

test("a 20-hour day is impossible by construction", () => {
  // Enormous demand against a tight deadline — the packer must still refuse to
  // put more than budget + 2h on any single day, and report the rest as late.
  const units = Array.from({ length: 30 }, (_, i) => unit(`u${i}`, DAY, 0, 2, [i]));
  const r = packDepartment(units, baseOpts({ horizonLength: 40 }));

  const ceiling = DAY + 120; // 8h + 2h humane cap
  for (const dayIdx of r.loadByDay.keys()) {
    const total = (r.loadByDay.get(dayIdx) ?? 0) + (r.otByDay.get(dayIdx) ?? 0);
    assert.ok(total <= ceiling, `day ${dayIdx} totalled ${total}min — beyond humane ceiling`);
  }
  assert.ok(r.late.length > 0, "work that cannot fit must be reported, not hidden");
});

test("what capped OT still cannot save is reported, not quietly pushed out", () => {
  const units = Array.from({ length: 8 }, (_, i) => unit(`u${i}`, DAY, 0, 1, [i]));
  const r = packDepartment(units, baseOpts({ horizonLength: 20 }));
  assert.ok(r.late.length > 0);
  for (const l of r.late) {
    assert.ok(l.daysLate > 0);
    assert.ok(l.dayIdx > l.deadlineIdx);
  }
});

test("overtime is a last resort — it is not used to finish early", () => {
  // Comfortable deadline: the work fits without OT, so none may be proposed
  // even though the horizon has OT headroom available.
  const units = Array.from({ length: 3 }, (_, i) => unit(`u${i}`, DAY, 0, 9, [i]));
  const r = packDepartment(units, baseOpts());
  assert.equal(r.otTotalMin, 0);
});

test("same-group work placed together pays the changeover only once", () => {
  const opts = baseOpts({ changeoverMin: 10, horizonLength: 4 });

  const grouped = packDepartment(
    [
      unit("a", 100, 0, null, [1], "FAB-RED"),
      unit("b", 100, 0, null, [2], "FAB-RED"),
      unit("c", 100, 0, null, [3], "FAB-RED"),
    ],
    opts,
  );
  const alternating = packDepartment(
    [
      unit("a", 100, 0, null, [1], "FAB-RED"),
      unit("b", 100, 0, null, [2], "FAB-BLUE"),
      unit("c", 100, 0, null, [3], "FAB-RED"),
    ],
    opts,
  );

  const load = (r) => [...r.loadByDay.values()].reduce((s, m) => s + m, 0);
  assert.ok(
    load(grouped) < load(alternating),
    "batching one fabric together must cost less machine time than switching",
  );
});

test("slack goes negative once a promise is arithmetically impossible", () => {
  // Needs 3 days of work, floor day 0, promised by day 1.
  const s = slackDays({ floorIdx: 0, deadlineIdx: 1, minutes: DAY * 3 }, DAY);
  assert.ok(s < 0, `expected negative slack, got ${s}`);

  const ok = slackDays({ floorIdx: 0, deadlineIdx: 9, minutes: DAY }, DAY);
  assert.ok(ok > 0);

  // Undated orders have no promise to measure against.
  assert.equal(slackDays({ floorIdx: 0, deadlineIdx: null, minutes: DAY }, DAY), null);
});

test("priority comparison is a stable lexicographic order", () => {
  assert.ok(cmpPriority([1, "a"], [2, "a"]) < 0);
  assert.ok(cmpPriority([2, "a"], [1, "z"]) > 0);
  assert.ok(cmpPriority([1, "a"], [1, "b"]) < 0);
  assert.equal(cmpPriority([1, "a"], [1, "a"]), 0);
});

test("identical input always produces identical output", () => {
  const mk = () => [
    unit("x", 300, 0, 5, [2], "F1"),
    unit("y", 700, 1, 6, [1], "F2"),
    unit("z", 200, 0, 4, [3], "F1"),
  ];
  const a = packDepartment(mk(), baseOpts({ changeoverMin: 10 }));
  const b = packDepartment(mk(), baseOpts({ changeoverMin: 10 }));
  assert.deepEqual(a.placements, b.placements);
  assert.deepEqual([...a.otByDay], [...b.otByDay]);
});
