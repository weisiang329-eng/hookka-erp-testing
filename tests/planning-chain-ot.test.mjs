// ---------------------------------------------------------------------------
// planning-chain-ot.test.mjs — planned overtime inside the schedule.
//
// Owner red line: "不要突然有一天直接开 10 个小时的 OT… 你一定要提前把 OT 分摊
// 开". So OT is never decided day-by-day as the packer walks. A department
// packs once at normal capacity; only if something lands past its promise is
// the shortfall spread FLAT across the horizon, capped per day, and the
// department re-packed. No day can be handed a spike, and the extra hours
// start immediately instead of piling up in front of the deadline.
//
// Units are NEVER split — "a whole SO is cut the same day, never split" is an
// explicit grouping rule of this engine, so OT raises the day's ceiling rather
// than cutting a unit in half.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import { computeChain } from "../src/api/lib/planning-chain.ts";
import { DEFAULT_CAPACITY_CONFIG } from "../src/api/lib/planning-capacity.ts";

const START = "2026-08-03"; // Monday
const OT_CAP = 120; // owner red line: 2h/day

function frameCard({ soId, mins, dd }) {
  return {
    dept: "FRAMING",
    soPo: soId,
    soId,
    customer: "Test",
    label: soId,
    fabric: "PC151-01",
    lane: "BEDFRAME",
    model: "MODEL",
    size: "6FT",
    sets: 1,
    mins,
    customerDd: dd,
    expectedDd: null,
    wipType: "DIVAN",
    cutDone: true,
    noCutStep: false,
    pinnedDue: null,
  };
}

/** day -> total FRAMING minutes placed on it. */
function loadByDay(cards, budgets) {
  const perDay = new Map();
  const minutes = new Map(cards.map((c) => [c.soId, c.mins]));
  computeChain({
    cutCards: [],
    chainCards: cards,
    config: DEFAULT_CAPACITY_CONFIG,
    holidays: [],
    startDate: START,
    generatedAt: START,
    dailyBudgetByDept: budgets,
    collect: (a) => {
      if (a.dept !== "FRAMING") return;
      perDay.set(a.date, (perDay.get(a.date) ?? 0) + (minutes.get(a.soId) ?? 0));
    },
  });
  return perDay;
}

test("no overtime is planned when every promise is comfortably met", () => {
  const cards = Array.from({ length: 3 }, (_, i) =>
    frameCard({ soId: `SO-${i}`, mins: 400, dd: "2026-12-31" }),
  );
  // Bedframe framing's share of a 1800-min department total is 1320/day.
  const perDay = loadByDay(cards, { FRAMING: 1800 });
  for (const [day, mins] of perDay) {
    assert.ok(mins <= 1320, `day ${day} carried ${mins}min — OT used with no deadline pressure`);
  }
});

test("no day is ever loaded beyond capacity plus the humane OT cap", () => {
  // Far more work than the horizon can hold, all promised very soon.
  const cards = Array.from({ length: 40 }, (_, i) =>
    frameCard({ soId: `SO-${i}`, mins: 600, dd: "2026-08-08" }),
  );
  const perDay = loadByDay(cards, { FRAMING: 1800 });
  const ceiling = 1320 + OT_CAP;
  for (const [day, mins] of perDay) {
    assert.ok(
      mins <= ceiling,
      `day ${day} carried ${mins}min, above the ${ceiling}min humane ceiling`,
    );
  }
});

test("a 20-hour day is impossible however desperate the deadline", () => {
  const cards = Array.from({ length: 60 }, (_, i) =>
    frameCard({ soId: `SO-${i}`, mins: 900, dd: "2026-08-04" }),
  );
  const perDay = loadByDay(cards, { FRAMING: 1800 });
  for (const [day, mins] of perDay) {
    assert.ok(mins <= 1320 + OT_CAP, `day ${day} reached ${mins}min`);
  }
});

test("overtime is spread, not concentrated on the days before the deadline", () => {
  // Slightly more than the plain budget can absorb before the promise.
  const cards = Array.from({ length: 8 }, (_, i) =>
    frameCard({ soId: `SO-${i}`, mins: 700, dd: "2026-08-08" }),
  );
  const perDay = loadByDay(cards, { FRAMING: 1800 });
  const over = [...perDay.entries()]
    .filter(([, mins]) => mins > 1320)
    .map(([day, mins]) => ({ day, ot: mins - 1320 }));
  for (const o of over) {
    assert.ok(o.ot <= OT_CAP, `day ${o.day} planned ${o.ot}min of OT, over the 2h cap`);
  }
  if (over.length > 1) {
    const amounts = over.map((o) => o.ot);
    assert.ok(
      Math.max(...amounts) - Math.min(...amounts) <= OT_CAP,
      "OT must be spread across days, not dumped on one",
    );
  }
});

test("no unit is ever split across days", () => {
  // Every SO must appear on exactly ONE framing day — the engine's grouping
  // rule ("a whole SO is cut the same day, never split") survives OT.
  const cards = Array.from({ length: 12 }, (_, i) =>
    frameCard({ soId: `SO-${i}`, mins: 700, dd: "2026-08-10" }),
  );
  const daysPerSo = new Map();
  computeChain({
    cutCards: [],
    chainCards: cards,
    config: DEFAULT_CAPACITY_CONFIG,
    holidays: [],
    startDate: START,
    generatedAt: START,
    dailyBudgetByDept: { FRAMING: 1800 },
    collect: (a) => {
      if (a.dept !== "FRAMING") return;
      const set = daysPerSo.get(a.soId) ?? new Set();
      set.add(a.date);
      daysPerSo.set(a.soId, set);
    },
  });
  for (const [so, days] of daysPerSo) {
    assert.equal(days.size, 1, `${so} was split across ${days.size} days`);
  }
});

test("every card is still scheduled exactly once", () => {
  const cards = Array.from({ length: 15 }, (_, i) =>
    frameCard({ soId: `SO-${i}`, mins: 500, dd: "2026-08-12" }),
  );
  let n = 0;
  computeChain({
    cutCards: [],
    chainCards: cards,
    config: DEFAULT_CAPACITY_CONFIG,
    holidays: [],
    startDate: START,
    generatedAt: START,
    dailyBudgetByDept: { FRAMING: 1800 },
    collect: (a) => {
      if (a.dept === "FRAMING") n++;
    },
  });
  assert.equal(n, cards.length, "OT planning must not drop or duplicate work");
});

test("the plan is deterministic run to run", () => {
  const mk = () =>
    Array.from({ length: 10 }, (_, i) => frameCard({ soId: `SO-${i}`, mins: 600, dd: "2026-08-09" }));
  const a = [...loadByDay(mk(), { FRAMING: 1800 }).entries()].sort();
  const b = [...loadByDay(mk(), { FRAMING: 1800 }).entries()].sort();
  assert.deepEqual(a, b);
});
