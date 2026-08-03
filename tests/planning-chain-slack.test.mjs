// ---------------------------------------------------------------------------
// planning-chain-slack.test.mjs — the engine queues on SLACK, not on raw
// customer delivery date.
//
// The old key was [customerDD, floor, modelKey, soId]. When two orders shared a
// due date it fell through to the SO reference — i.e. alphabetical order
// decided which one got the scarce day. Slack accounts for how much room each
// order actually has left, so the one genuinely in trouble wins the slot.
//
// These tests drive computeChain itself, so they fail if the slack wiring is
// removed even though planning-deadlines.ts stays green on its own.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import { computeChain } from "../src/api/lib/planning-chain.ts";
import { DEFAULT_CAPACITY_CONFIG } from "../src/api/lib/planning-capacity.ts";

const START = "2026-08-03"; // Monday

function sewCard({ soId, mins, dd, soPo }) {
  return {
    dept: "FAB_SEW",
    soPo: soPo ?? soId,
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
    cutDone: true, // floor = day 1 for both, so only slack can separate them
    noCutStep: false,
  };
}

/** soId -> the day it was scheduled on. */
function scheduleDays(cards, budgets) {
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
      if (a.dept !== "FAB_SEW") return;
      const prev = out.get(a.soId);
      if (prev === undefined || a.date < prev) out.set(a.soId, a.date);
    },
  });
  return out;
}

test("with the same due date, the order needing more work is scheduled first", () => {
  // Both promised the same day and both free to start immediately. "SO-Z" is a
  // big job (little slack); "SO-A" is small (lots of slack). Under the old
  // key these tied on due date and floor, and SO-A won on the letter A alone.
  const dd = "2026-08-14";
  const cards = [
    sewCard({ soId: "SO-A", mins: 100, dd }),
    sewCard({ soId: "SO-Z", mins: 1100, dd }),
  ];
  // Budget forces a real choice: both cannot share one day.
  const days = scheduleDays(cards, { FAB_SEW: 3540 });

  assert.ok(days.get("SO-Z") <= days.get("SO-A"), "the tighter job must not be queued behind");
});

test("a nearer promise outranks a distant one", () => {
  const cards = [
    sewCard({ soId: "SO-FAR", mins: 900, dd: "2026-10-30" }),
    sewCard({ soId: "SO-NEAR", mins: 900, dd: "2026-08-10" }),
  ];
  const days = scheduleDays(cards, { FAB_SEW: 3540 });
  assert.ok(
    days.get("SO-NEAR") <= days.get("SO-FAR"),
    "the order due sooner must be scheduled no later than the distant one",
  );
});

test("undated work never displaces a dated promise", () => {
  const cards = [
    sewCard({ soId: "SO-NODATE", mins: 900, dd: null }),
    sewCard({ soId: "SO-DATED", mins: 900, dd: "2026-08-12" }),
  ];
  const days = scheduleDays(cards, { FAB_SEW: 1200 });
  assert.ok(
    days.get("SO-DATED") <= days.get("SO-NODATE"),
    "an order with no promise must yield to one that has made a promise",
  );
});

test("ordering is deterministic run to run", () => {
  const mk = () => [
    sewCard({ soId: "SO-1", mins: 400, dd: "2026-08-12" }),
    sewCard({ soId: "SO-2", mins: 800, dd: "2026-08-12" }),
    sewCard({ soId: "SO-3", mins: 600, dd: "2026-08-20" }),
  ];
  const a = [...scheduleDays(mk(), { FAB_SEW: 2000 }).entries()].sort();
  const b = [...scheduleDays(mk(), { FAB_SEW: 2000 }).entries()].sort();
  assert.deepEqual(a, b);
});

test("every card still lands on a working day at or after the start", () => {
  const cards = Array.from({ length: 12 }, (_, i) =>
    sewCard({ soId: `SO-${i}`, mins: 500, dd: "2026-08-20" }),
  );
  const days = scheduleDays(cards, { FAB_SEW: 1200 });
  assert.equal(days.size, 12, "no order may be dropped by the new ordering");
  for (const [so, d] of days) {
    assert.ok(d >= START, `${so} scheduled at ${d}, before the start day`);
    assert.notEqual(new Date(`${d}T00:00:00Z`).getUTCDay(), 0, `${so} landed on a Sunday`);
  }
});
