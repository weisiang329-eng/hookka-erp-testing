// ---------------------------------------------------------------------------
// planning-walkin-reserve.test.mjs — keep room for the orders that walk in.
//
// Owner 2026-08-04: "有些时候他们会一直插单… 三天内的可以全部安排满，三天到七天
// 的可以尽量留一点点产能（10% 到 20%）给他们去用".
//
// The near days are packed FULL — that work is imminent and holding capacity
// back from it helps nobody. Beyond `reserveAfterDay` a slice of each day is
// left unplanned, so an order arriving tomorrow has somewhere to go instead of
// forcing a reshuffle of work already promised to the floor.
//
// The reserve is a ceiling on PLANNING, not a cut in capacity: the floor still
// has the whole day. Overtime deliberately ignores it — once a promise is at
// risk, holding a slice for a hypothetical future order is the wrong trade.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import { computeChain } from "../src/api/lib/planning-chain.ts";
import { DEFAULT_CAPACITY_CONFIG, DEFAULT_CHAIN_CONFIG } from "../src/api/lib/planning-capacity.ts";

const START = "2026-08-03"; // Monday
const BEDFRAME_SHARE = 1320; // framing bedframe's slice of an 1800 dept budget

function frameCard({ soId, mins, dd = "2026-12-31" }) {
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

/** date -> framing minutes placed on it. */
function loadByDay(cards, chainOverride) {
  const perDay = new Map();
  const minutes = new Map(cards.map((c) => [c.soId, c.mins]));
  computeChain({
    cutCards: [],
    chainCards: cards,
    config: {
      ...DEFAULT_CAPACITY_CONFIG,
      chain: { ...DEFAULT_CHAIN_CONFIG, ...(chainOverride ?? {}) },
    },
    holidays: [],
    startDate: START,
    generatedAt: START,
    dailyBudgetByDept: { FRAMING: 1800 },
    collect: (a) => {
      if (a.dept !== "FRAMING") return;
      perDay.set(a.date, (perDay.get(a.date) ?? 0) + (minutes.get(a.soId) ?? 0));
    },
  });
  return [...perDay.entries()].sort();
}

test("the defaults are the owner's numbers", () => {
  assert.equal(DEFAULT_CHAIN_CONFIG.reserveAfterDay, 3, "first 3 working days packed full");
  assert.ok(
    DEFAULT_CHAIN_CONFIG.reservePct >= 10 && DEFAULT_CHAIN_CONFIG.reservePct <= 20,
    "hold back 10-20% beyond that",
  );
});

test("the first three working days are packed full", () => {
  // Plenty of undated-ish work with a distant promise, so nothing forces OT.
  const cards = Array.from({ length: 40 }, (_, i) => frameCard({ soId: `SO-${i}`, mins: 660 }));
  const days = loadByDay(cards);
  const nearDays = days.slice(0, 3);
  for (const [d, mins] of nearDays) {
    assert.ok(
      mins > BEDFRAME_SHARE * 0.9,
      `near day ${d} only reached ${mins} of ${BEDFRAME_SHARE} — near days must fill`,
    );
  }
});

test("later days keep a slice free for walk-ins", () => {
  const cards = Array.from({ length: 40 }, (_, i) => frameCard({ soId: `SO-${i}`, mins: 660 }));
  const days = loadByDay(cards);
  const laterDays = days.slice(3, 8);
  assert.ok(laterDays.length > 0, "the fixture must reach past the near-day band");
  const ceiling = Math.round(BEDFRAME_SHARE * (1 - DEFAULT_CHAIN_CONFIG.reservePct / 100));
  for (const [d, mins] of laterDays) {
    assert.ok(
      mins <= ceiling,
      `day ${d} planned ${mins}, above the ${ceiling} ceiling — no room left for an insert`,
    );
  }
});

test("a bigger reserve leaves more room, a zero reserve leaves none", () => {
  const cards = Array.from({ length: 40 }, (_, i) => frameCard({ soId: `SO-${i}`, mins: 660 }));
  const laterLoad = (pct) =>
    loadByDay(cards, { reservePct: pct })
      .slice(3, 8)
      .map(([, m]) => m);

  const none = laterLoad(0);
  const heavy = laterLoad(40);
  assert.ok(
    Math.max(...heavy) < Math.max(...none),
    "raising the reserve must actually hold more back",
  );
});

test("the reserve pushes work out rather than dropping it", () => {
  const cards = Array.from({ length: 20 }, (_, i) => frameCard({ soId: `SO-${i}`, mins: 660 }));
  const withReserve = loadByDay(cards);
  const withoutReserve = loadByDay(cards, { reservePct: 0 });
  const total = (d) => d.reduce((s, [, m]) => s + m, 0);
  assert.equal(
    total(withReserve),
    total(withoutReserve),
    "no work may be lost — a reserved day defers work, it does not discard it",
  );
  assert.ok(
    withReserve.length >= withoutReserve.length,
    "holding capacity back should spread the same work over at least as many days",
  );
});

test("an at-risk promise outranks the reserve — overtime still fires", () => {
  // A hypothetical future order never outranks a real promise, so deadline
  // pressure must still be able to buy overtime. It lands on the NEAR days,
  // which is the owner's rule: start early, do not bank it up in front of the
  // deadline.
  const tight = loadByDay(
    Array.from({ length: 8 }, (_, i) => frameCard({ soId: `SO-${i}`, mins: 700, dd: "2026-08-10" })),
  );
  const relaxed = loadByDay(
    Array.from({ length: 8 }, (_, i) => frameCard({ soId: `SO-${i}`, mins: 700 })),
  );

  assert.ok(
    tight.some(([, mins]) => mins > BEDFRAME_SHARE),
    "a day should exceed plain capacity — that is the overtime",
  );
  assert.equal(
    tight.filter(([, mins]) => mins > BEDFRAME_SHARE)[0][0],
    tight[0][0],
    "overtime must start on the FIRST day, not be saved for the deadline",
  );
  assert.ok(
    tight.length < relaxed.length,
    "the same work must finish sooner under deadline pressure than without it",
  );
});

test("no day ever exceeds capacity plus the humane OT cap", () => {
  const cards = Array.from({ length: 60 }, (_, i) =>
    frameCard({ soId: `SO-${i}`, mins: 900, dd: "2026-08-06" }),
  );
  for (const [d, mins] of loadByDay(cards)) {
    assert.ok(mins <= BEDFRAME_SHARE + 120, `day ${d} reached ${mins}`);
  }
});
