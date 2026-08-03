// ---------------------------------------------------------------------------
// planning-cutting-minutes.test.mjs — the CNC minutes model for Fabric Cutting.
//
// Fabric Cutting is the chain's drum: every downstream floor is derived from
// its days, so its capacity model decides the whole factory's throughput. The
// legacy model metered CUT SLOTS, which got two things structurally wrong:
//
//   * a one-set batch consumed a whole slot, so fragmented orders burned the
//     day's budget without filling it;
//   * a fabric change cost nothing, so "batch the same fabric together" — the
//     one real lever the CNC has — earned nothing in the schedule.
//
// These tests pin the minutes model against both, and pin that omitting the
// budget still reproduces the legacy slot behaviour exactly.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import { scheduleCutting } from "../src/api/lib/planning-scheduler.ts";
import { DEFAULT_CAPACITY_CONFIG } from "../src/api/lib/planning-capacity.ts";

const START = "2026-08-03"; // Monday

function card(i, { fabric = "PC151-01", lane = "BEDFRAME", sets = 1, config = "CFG-A" } = {}) {
  return {
    soPo: `SO-${String(i).padStart(3, "0")}`,
    customer: "Test",
    label: `${config} | 6FT`,
    fabric,
    lane,
    config,
    size: "6FT",
    sets,
    // Close to START on purpose: the engine pulls batches back from the
    // CUSTOMER date (modelLeadDays), so a far-out date would park every cut in
    // September and these tests would measure the pull window, not capacity.
    customerDd: "2026-08-10",
    expectedDd: null,
  };
}

function run(cards, dailyBudgetMin) {
  const days = new Set();
  scheduleCutting({
    cards,
    config: DEFAULT_CAPACITY_CONFIG,
    holidays: [],
    startDate: START,
    generatedAt: START,
    dailyBudgetMin,
    collect: (a) => days.add(a.date),
  });
  return days;
}

test("omitting the budget reproduces the legacy slot schedule exactly", () => {
  const cards = Array.from({ length: 12 }, (_, i) => card(i, { config: `CFG-${i}` }));
  const a = JSON.stringify(
    scheduleCutting({
      cards,
      config: DEFAULT_CAPACITY_CONFIG,
      holidays: [],
      startDate: START,
      generatedAt: START,
    }),
  );
  const b = JSON.stringify(
    scheduleCutting({
      cards,
      config: DEFAULT_CAPACITY_CONFIG,
      holidays: [],
      startDate: START,
      generatedAt: START,
      dailyBudgetMin: undefined,
    }),
  );
  assert.equal(a, b);
});

test("a zero or invalid budget falls back to the legacy model", () => {
  const cards = Array.from({ length: 8 }, (_, i) => card(i, { config: `CFG-${i}` }));
  const legacy = run(cards, undefined);
  for (const bad of [0, -5, Number.NaN]) {
    assert.deepEqual([...run(cards, bad)].sort(), [...legacy].sort(), `budget ${bad}`);
  }
});

test("fragmented one-set batches no longer burn a whole slot each", () => {
  // 12 distinct cut identities, one set apiece. Under the slot model these
  // consume 12 slots against a 2-cuts/day bedframe allowance. In minutes they
  // are 12 x 8min of cutting plus changeovers — a fraction of one CNC day.
  const cards = Array.from({ length: 12 }, (_, i) => card(i, { config: `CFG-${i}` }));

  const legacyDays = run(cards, undefined);
  const minuteDays = run(cards, 951); // measured CNC throughput

  assert.ok(
    minuteDays.size < legacyDays.size,
    `minutes should need far fewer days (legacy ${legacyDays.size}, minutes ${minuteDays.size})`,
  );
});

test("same-fabric batching costs less machine time than alternating fabrics", () => {
  // Identical work, identical count — only the fabric mix differs.
  const sameFabric = Array.from({ length: 6 }, (_, i) =>
    card(i, { config: `CFG-${i}`, fabric: "PC151-01" }),
  );
  const mixedFabric = Array.from({ length: 6 }, (_, i) =>
    card(i, { config: `CFG-${i}`, fabric: `PC151-0${i}` }),
  );

  // A budget tight enough that changeover time decides how much fits per day.
  const BUDGET = 90;
  const same = run(sameFabric, BUDGET);
  const mixed = run(mixedFabric, BUDGET);

  assert.ok(
    same.size <= mixed.size,
    `same-fabric work must never need MORE days (same ${same.size}, mixed ${mixed.size})`,
  );
  assert.ok(
    same.size < mixed.size,
    `re-rigging must cost real time (same ${same.size}, mixed ${mixed.size})`,
  );
});

test("a bigger CNC budget schedules the same work sooner", () => {
  const cards = Array.from({ length: 30 }, (_, i) => card(i, { config: `CFG-${i}` }));
  const small = run(cards, 100);
  const large = run(cards, 2000);
  assert.ok(large.size < small.size);
});

test("sofa is never starved out of the machine by bedframe volume", () => {
  // Enough bedframe to swamp the machine for days, plus one small sofa cut.
  const bedframe = Array.from({ length: 40 }, (_, i) =>
    card(i, { config: `BF-${i}`, lane: "BEDFRAME", sets: 8 }),
  );
  const sofa = [card(900, { config: "SOFA-A", lane: "SOFA", sets: 1 })];

  const dayOf = (cards) => {
    let d = null;
    scheduleCutting({
      cards,
      config: DEFAULT_CAPACITY_CONFIG,
      holidays: [],
      startDate: START,
      generatedAt: START,
      dailyBudgetMin: 951,
      collect: (a) => {
        if (a.lane === "SOFA" && (d === null || a.date < d)) d = a.date;
      },
    });
    return d;
  };

  const alone = dayOf(sofa);
  const crowded = dayOf([...bedframe, ...sofa]);
  assert.ok(alone !== null && crowded !== null, "the sofa cut must always be placed");
  assert.equal(
    crowded,
    alone,
    `sofa's reserved share must hold its day even under bedframe load (alone ${alone}, crowded ${crowded})`,
  );
});

test("the sofa reserve can never starve bedframe on a small machine day", () => {
  // The reserve is derived from cut COUNTS, so on a small measured budget an
  // unclamped reserve would exceed the whole day and leave bedframe nothing.
  const cards = Array.from({ length: 6 }, (_, i) => card(i, { config: `CFG-${i}` }));
  const days = run(cards, 90); // far below the raw 180-minute sofa reserve
  assert.ok(
    days.size <= 2,
    `bedframe must still get most of a small day (spread over ${days.size} days)`,
  );
});

test("every card is scheduled exactly once and never before the start day", () => {
  const cards = Array.from({ length: 25 }, (_, i) => card(i, { config: `CFG-${i % 7}` }));
  const seen = [];
  scheduleCutting({
    cards,
    config: DEFAULT_CAPACITY_CONFIG,
    holidays: [],
    startDate: START,
    generatedAt: START,
    dailyBudgetMin: 951,
    collect: (a) => seen.push(a),
  });
  assert.equal(seen.length, cards.length, "no card may be dropped or duplicated");
  for (const a of seen) assert.ok(a.date >= START, `${a.date} precedes the start day`);
});

test("no day is scheduled on a Sunday or a holiday", () => {
  const cards = Array.from({ length: 40 }, (_, i) => card(i, { config: `CFG-${i}` }));
  const holidays = ["2026-08-05"];
  const days = new Set();
  scheduleCutting({
    cards,
    config: DEFAULT_CAPACITY_CONFIG,
    holidays,
    startDate: START,
    generatedAt: START,
    dailyBudgetMin: 60, // tight, so the schedule must walk across many days
    collect: (a) => days.add(a.date),
  });
  for (const d of days) {
    assert.ok(!holidays.includes(d), `${d} is a public holiday`);
    assert.notEqual(new Date(`${d}T00:00:00Z`).getUTCDay(), 0, `${d} is a Sunday`);
  }
});
