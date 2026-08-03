// ---------------------------------------------------------------------------
// planning-frozen-capacity.test.mjs — committed work must consume the capacity
// of the day it will REALLY be worked.
//
// schedule-proposals.ts refuses to move a job card that is already sent to the
// floor (`distributedAt`) or due within 3 days: those dates are committed. The
// engine, though, kept re-planning those cards and charging their minutes to
// whatever day IT chose. The work then happened on the frozen day while the
// engine believed that day was free — so it handed the same near-term hours
// out twice, in exactly the window where an over-commitment can no longer be
// recovered.
//
// A pinned card is now placed on its committed day and consumes that day's
// budget, which is what stops the double-booking.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import { computeChain } from "../src/api/lib/planning-chain.ts";
import { DEFAULT_CAPACITY_CONFIG } from "../src/api/lib/planning-capacity.ts";

const START = "2026-08-03"; // Monday
const PINNED_DAY = "2026-08-04"; // Tuesday, inside the freeze window

function sewCard({ soId, mins = 600, pinnedDue = null, dd = "2026-09-30" }) {
  return {
    dept: "FAB_SEW",
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
    pinnedDue,
  };
}

function place(cards, budgets) {
  const out = new Map();
  computeChain({
    cutCards: [],
    chainCards: cards,
    config: DEFAULT_CAPACITY_CONFIG,
    holidays: [],
    startDate: START,
    generatedAt: START,
    dailyBudgetByDept: budgets,
    collect: (a) => {
      if (a.dept === "FAB_SEW") out.set(a.soId, a.date);
    },
  });
  return out;
}

test("a committed card is placed on its committed day", () => {
  const days = place([sewCard({ soId: "SO-PINNED", pinnedDue: PINNED_DAY })]);
  assert.equal(days.get("SO-PINNED"), PINNED_DAY);
});

test("a committed card is NOT moved even when the engine would prefer elsewhere", () => {
  // Fill the pinned day past its budget with other work; the pinned card must
  // still stay put, because that date is already promised to the floor.
  const cards = [
    sewCard({ soId: "SO-PINNED", mins: 1000, pinnedDue: PINNED_DAY }),
    ...Array.from({ length: 5 }, (_, i) => sewCard({ soId: `SO-FREE-${i}`, mins: 1000 })),
  ];
  const days = place(cards, { FAB_SEW: 3540 });
  assert.equal(days.get("SO-PINNED"), PINNED_DAY, "committed work may never be re-dated");
});

test("committed work consumes its day's budget, so free work is pushed off it", () => {
  const budget = { FAB_SEW: 3540 }; // bedframe share = 1200 min/day
  const freeOnly = place(
    [sewCard({ soId: "SO-FREE", mins: 1000, dd: "2026-08-06" })],
    budget,
  );

  // Same free card, but now a big committed job already owns that same day.
  const withPinned = place(
    [
      sewCard({ soId: "SO-PINNED", mins: 1150, pinnedDue: freeOnly.get("SO-FREE") }),
      sewCard({ soId: "SO-FREE", mins: 1000, dd: "2026-08-06" }),
    ],
    budget,
  );

  assert.ok(
    withPinned.get("SO-FREE") > freeOnly.get("SO-FREE"),
    `free work must move off a day the committed job already owns ` +
      `(alone ${freeOnly.get("SO-FREE")}, crowded ${withPinned.get("SO-FREE")})`,
  );
});

test("an unpinned plan is unchanged — pinning is additive", () => {
  const cards = Array.from({ length: 4 }, (_, i) => sewCard({ soId: `SO-${i}`, mins: 500 }));
  const withNull = place(cards, { FAB_SEW: 3540 });
  const withoutField = place(
    cards.map(({ pinnedDue, ...rest }) => rest),
    { FAB_SEW: 3540 },
  );
  assert.deepEqual([...withNull].sort(), [...withoutField].sort());
});

test("a pin in the past is clamped to the first schedulable day", () => {
  const days = place([sewCard({ soId: "SO-OLD", pinnedDue: "2020-01-01" })]);
  const d = days.get("SO-OLD");
  assert.ok(d >= START, `a stale commitment must not schedule into the past (got ${d})`);
});

test("several committed cards on one day all keep that day", () => {
  const cards = Array.from({ length: 4 }, (_, i) =>
    sewCard({ soId: `SO-P${i}`, mins: 900, pinnedDue: PINNED_DAY }),
  );
  const days = place(cards, { FAB_SEW: 3540 });
  for (const [so, d] of days) {
    assert.equal(d, PINNED_DAY, `${so} was moved off its committed day`);
  }
});
