// ---------------------------------------------------------------------------
// planning-chain-adaptive.test.mjs — proves the ENGINE actually consumes the
// measured daily budgets, and that omitting them reproduces the legacy run.
//
// The whole rebuild rests on one wiring claim: computeChain packs against
// `dailyBudgetByDept` when it is supplied and against the hardcoded constants
// when it is not. If that wiring silently breaks, every other capacity test
// still passes while the live schedule quietly reverts to 2026-06-01 numbers.
// These tests exercise computeChain itself so that cannot happen unnoticed.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import { computeChain } from "../src/api/lib/planning-chain.ts";
import { DEFAULT_CAPACITY_CONFIG } from "../src/api/lib/planning-capacity.ts";

const START = "2026-08-03"; // a Monday

function sewCard(i, mins, soId) {
  return {
    dept: "FAB_SEW",
    soPo: `SO-TEST-${i}`,
    soId: soId ?? `SO-TEST-${i}`,
    customer: "Test",
    label: `Line ${i}`,
    fabric: "PC151-01",
    lane: "BEDFRAME",
    model: "TESTMODEL",
    size: "6FT",
    sets: 1,
    mins,
    customerDd: "2026-09-30",
    expectedDd: null,
    wipType: "DIVAN",
    cutDone: true, // floor = day 1; keeps the test about capacity, not handoffs
    noCutStep: false,
  };
}

function run(cards, dailyBudgetByDept) {
  return computeChain({
    cutCards: [],
    chainCards: cards,
    config: DEFAULT_CAPACITY_CONFIG,
    holidays: [],
    startDate: START,
    generatedAt: START,
    dailyBudgetByDept,
    collect: undefined,
  });
}

/** Distinct scheduled days across every emitted assignment for a department. */
function daysUsed(cards, budgets, dept) {
  const days = new Set();
  computeChain({
    cutCards: [],
    chainCards: cards,
    config: DEFAULT_CAPACITY_CONFIG,
    holidays: [],
    startDate: START,
    generatedAt: START,
    dailyBudgetByDept: budgets,
    collect: (a) => {
      if (a.dept === dept) days.add(a.date);
    },
  });
  return days;
}

test("a bigger measured budget compresses the same work into fewer days", () => {
  // 10 SOs of 600 min each. Bedframe sewing's constant is 1200 min/day.
  const cards = Array.from({ length: 10 }, (_, i) => sewCard(i, 600));

  const legacy = daysUsed(cards, undefined, "FAB_SEW");
  // Measured total across all three sew lanes; bedframe takes its configured
  // share (1200/3540) of it, so a big total gives bedframe a big budget.
  const measured = daysUsed(cards, { FAB_SEW: 3540 * 4 }, "FAB_SEW");

  assert.ok(legacy.size > 0, "legacy run must schedule something");
  assert.ok(
    measured.size < legacy.size,
    `a 4x budget should need fewer days (legacy ${legacy.size}, measured ${measured.size})`,
  );
});

test("a smaller measured budget spreads the same work over more days", () => {
  const cards = Array.from({ length: 10 }, (_, i) => sewCard(i, 600));
  const legacy = daysUsed(cards, undefined, "FAB_SEW");
  const starved = daysUsed(cards, { FAB_SEW: 700 }, "FAB_SEW");
  assert.ok(
    starved.size > legacy.size,
    `a starved budget should need more days (legacy ${legacy.size}, starved ${starved.size})`,
  );
});

test("omitting the budgets reproduces the legacy run exactly", () => {
  const cards = Array.from({ length: 6 }, (_, i) => sewCard(i, 500));
  const a = JSON.stringify(run(cards, undefined));
  const b = JSON.stringify(run(cards, {}));
  assert.equal(a, b, "an empty budget map must behave identically to none at all");
});

test("a zero or negative budget falls back to the constant, never to nothing", () => {
  const cards = Array.from({ length: 4 }, (_, i) => sewCard(i, 500));
  const legacy = daysUsed(cards, undefined, "FAB_SEW");
  for (const bad of [0, -100, Number.NaN]) {
    const got = daysUsed(cards, { FAB_SEW: bad }, "FAB_SEW");
    assert.deepEqual(
      [...got].sort(),
      [...legacy].sort(),
      `budget ${bad} must fall back to the configured constant`,
    );
  }
});

test("the sewing sheet reports the capacity it actually packed against", () => {
  const cards = [sewCard(1, 500), sewCard(2, 500)];

  const byDayCap = (budgets) => {
    const sheet = run(cards, budgets).sewing.sheets["By Day"];
    const header = sheet[0];
    const capCol = header.indexOf("Cap h");
    assert.ok(capCol >= 0, "By Day sheet must carry a Cap h column");
    return sheet[1][capCol];
  };

  // Bedframe's constant is 1200 min/day = 20h.
  assert.equal(byDayCap(undefined), 20);
  // Doubling the measured department total doubles bedframe's share: 40h.
  assert.equal(
    byDayCap({ FAB_SEW: 3540 * 2 }),
    40,
    "the sheet must report the MEASURED capacity, not the 1200-min constant",
  );
});

test("every lane keeps a share — a big total never starves sofa to zero", () => {
  const cards = [
    ...Array.from({ length: 3 }, (_, i) => sewCard(i, 400)),
    { ...sewCard(99, 400), lane: "SOFA", soId: "SO-SOFA" },
  ];
  const days = daysUsed(cards, { FAB_SEW: 3540 }, "FAB_SEW");
  assert.ok(days.size > 0, "sofa work must still be schedulable alongside bedframe");
});
