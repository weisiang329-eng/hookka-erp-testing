// ---------------------------------------------------------------------------
// planning-ot-reported.test.mjs — the overtime a plan RELIES ON must be told.
//
// The scheduler was already planning overtime, but `placeUnitsWithOt` returned
// its result and every caller dropped it. A plan could therefore depend on two
// hours a day, every day, that nobody was ever informed about — the floor would
// simply fall behind and no one would know why.
//
// What is reported is the SCHEDULE'S OWN figure, not a second estimate made
// from due dates afterwards. If the two ever disagree, the brief is telling the
// owner to work hours the plan did not assume, or hiding hours it did.
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

function plannedOt(cards) {
  const ot = [];
  computeChain({
    cutCards: [],
    chainCards: cards,
    config: DEFAULT_CAPACITY_CONFIG,
    holidays: [],
    startDate: START,
    generatedAt: START,
    dailyBudgetByDept: { FRAMING: 1800 },
    collectOt: (d) => ot.push(d),
  });
  return ot;
}

test("a plan that needs overtime says so", () => {
  const ot = plannedOt(
    Array.from({ length: 8 }, (_, i) => frameCard({ soId: `SO-${i}`, mins: 700, dd: "2026-08-10" })),
  );
  assert.ok(ot.length > 0, "overtime was planned but never reported");
  for (const d of ot) {
    assert.equal(d.dept, "FRAMING");
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(d.minutes > 0);
  }
});

test("a comfortable plan reports none", () => {
  const ot = plannedOt(
    Array.from({ length: 3 }, (_, i) => frameCard({ soId: `SO-${i}`, mins: 400, dd: "2026-12-31" })),
  );
  assert.equal(ot.length, 0, "no deadline pressure must mean no overtime claimed");
});

test("reported overtime respects the humane per-day cap", () => {
  const ot = plannedOt(
    Array.from({ length: 60 }, (_, i) => frameCard({ soId: `SO-${i}`, mins: 900, dd: "2026-08-05" })),
  );
  for (const d of ot) {
    assert.ok(d.minutes <= OT_CAP, `${d.date} reported ${d.minutes}min, above the 2h cap`);
  }
});

test("it starts on the first day rather than banking up", () => {
  const ot = plannedOt(
    Array.from({ length: 8 }, (_, i) => frameCard({ soId: `SO-${i}`, mins: 700, dd: "2026-08-10" })),
  ).sort((a, b) => (a.date < b.date ? -1 : 1));
  assert.equal(ot[0].date, START, "the first overtime day must be the first working day");
});

test("it is spread flat, not concentrated", () => {
  const ot = plannedOt(
    Array.from({ length: 8 }, (_, i) => frameCard({ soId: `SO-${i}`, mins: 700, dd: "2026-08-10" })),
  );
  const amounts = ot.map((d) => d.minutes);
  assert.ok(
    Math.max(...amounts) - Math.min(...amounts) <= 1,
    "overtime must be level across the days it covers",
  );
});

test("one run never reports another run's overtime", () => {
  // The sink is module-local, so a stale entry would leak between calls and
  // claim overtime for a plan that does not need any.
  const heavy = Array.from({ length: 8 }, (_, i) =>
    frameCard({ soId: `SO-${i}`, mins: 700, dd: "2026-08-10" }),
  );
  const light = Array.from({ length: 2 }, (_, i) =>
    frameCard({ soId: `SO-${i}`, mins: 300, dd: "2026-12-31" }),
  );
  assert.ok(plannedOt(heavy).length > 0);
  assert.equal(plannedOt(light).length, 0, "a fresh run must start from an empty sink");
  assert.ok(plannedOt(heavy).length > 0, "and the sink must still work afterwards");
});

test("omitting the collector changes nothing", () => {
  const cards = Array.from({ length: 8 }, (_, i) =>
    frameCard({ soId: `SO-${i}`, mins: 700, dd: "2026-08-10" }),
  );
  const run = (withCollector) => {
    const days = [];
    computeChain({
      cutCards: [],
      chainCards: cards,
      config: DEFAULT_CAPACITY_CONFIG,
      holidays: [],
      startDate: START,
      generatedAt: START,
      dailyBudgetByDept: { FRAMING: 1800 },
      collect: (a) => {
        if (a.dept === "FRAMING") days.push(`${a.soId}@${a.date}`);
      },
      ...(withCollector ? { collectOt: () => {} } : {}),
    });
    return days.sort();
  };
  assert.deepEqual(run(true), run(false), "reporting must not alter the plan");
});
