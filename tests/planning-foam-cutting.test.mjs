// ---------------------------------------------------------------------------
// planning-foam-cutting.test.mjs — Foam Cutting is a real production stage and
// must be SCHEDULED, not silently dropped.
//
// FOAM_CUTTING was added to the departments table properly (runtime self-apply,
// sequence slot before Foam Bonding, isProduction=1), so it appeared in every
// dropdown fed by GET /api/departments. But the scheduler does not read that
// table — it used a hardcoded DEPT_CODE_TO_CHAIN map, and the new code was
// never added to it. `if (!chainDept) continue;` then dropped every one of its
// cards: no plan, no capacity, no warning.
//
// The rule (owner 2026-08-03): Foam Cutting has NO upstream — like Fabric
// Cutting and Wood Cutting, the material is simply there. It is pulled back
// `foamCutLeadDays` working days from the day its output is needed (Foam
// Bonding), i.e. "放成 Foam Bonding 的前一天".
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import { computeChain } from "../src/api/lib/planning-chain.ts";
import { DEFAULT_CAPACITY_CONFIG } from "../src/api/lib/planning-capacity.ts";
import { deptDeadlines } from "../src/api/lib/planning-deadlines.ts";

const START = "2026-08-03"; // Monday

function card(dept, { soId = "SO-1", mins = 120, lane = "SOFA", wipType = "SOFA_BASE" } = {}) {
  return {
    dept,
    soPo: soId,
    soId,
    customer: "Test",
    label: `${dept} card`,
    fabric: "PC151-01",
    lane,
    model: "MODEL",
    size: "6FT",
    sets: 1,
    mins,
    customerDd: "2026-09-15",
    expectedDd: null,
    wipType,
    cutDone: true,
    noCutStep: false,
  };
}

function assignments(cards, budgets) {
  const out = [];
  computeChain({
    cutCards: [],
    chainCards: cards,
    config: DEFAULT_CAPACITY_CONFIG,
    holidays: [],
    startDate: START,
    generatedAt: START,
    dailyBudgetByDept: budgets,
    collect: (a) => out.push(a),
  });
  return out;
}

test("foam-cutting cards reach the plan at all", () => {
  const got = assignments([card("FOAM_CUTTING")]);
  const fc = got.filter((a) => a.dept === "FOAM_CUTTING");
  assert.equal(fc.length, 1, "a FOAM_CUTTING card must be scheduled, not dropped");
  assert.ok(fc[0].date >= START);
});

test("foam cutting lands before the foam bonding it feeds", () => {
  const got = assignments([
    card("FRAMING", { soId: "SO-A", wipType: "SOFA_BASE" }),
    card("FOAM", { soId: "SO-A", wipType: "SOFA_BASE" }),
    card("FOAM_CUTTING", { soId: "SO-A" }),
  ]);
  const fc = got.find((a) => a.dept === "FOAM_CUTTING");
  const bonding = got.find((a) => a.dept === "FOAM");
  assert.ok(fc && bonding, "both stages must be scheduled");
  assert.ok(
    fc.date < bonding.date,
    `foam must be cut before it is bonded (cut ${fc.date}, bond ${bonding.date})`,
  );
});

test("it waits on no upstream — an order with only foam cutting still plans", () => {
  // No framing, no bonding, nothing to derive a floor from. A stage with a real
  // upstream would stall here; a source stage must simply start.
  const got = assignments([card("FOAM_CUTTING", { soId: "SO-ALONE" })]);
  assert.equal(got.filter((a) => a.dept === "FOAM_CUTTING").length, 1);
});

test("its daily budget is respected", () => {
  // Ten 120-minute units against a 120-minute day cannot share one day.
  const cards = Array.from({ length: 10 }, (_, i) =>
    card("FOAM_CUTTING", { soId: `SO-${i}`, mins: 120 }),
  );
  const got = assignments(cards, { FOAM_CUTTING: 120 });
  const days = new Set(got.filter((a) => a.dept === "FOAM_CUTTING").map((a) => a.date));
  assert.ok(days.size > 1, "a tight budget must spread the work across days");
});

test("a bigger measured budget compresses foam cutting into fewer days", () => {
  const cards = Array.from({ length: 10 }, (_, i) =>
    card("FOAM_CUTTING", { soId: `SO-${i}`, mins: 120 }),
  );
  const tight = new Set(
    assignments(cards, { FOAM_CUTTING: 120 })
      .filter((a) => a.dept === "FOAM_CUTTING")
      .map((a) => a.date),
  );
  const roomy = new Set(
    assignments(cards, { FOAM_CUTTING: 2400 })
      .filter((a) => a.dept === "FOAM_CUTTING")
      .map((a) => a.date),
  );
  assert.ok(roomy.size < tight.size);
});

test("the backward pass gives foam cutting a deadline ahead of bonding", () => {
  const back = (day, n) => day - n;
  const d = deptDeadlines({
    customerDd: 100,
    lane: "SOFA",
    chain: DEFAULT_CAPACITY_CONFIG.chain,
    backWorkday: back,
  });
  assert.ok(d.FOAM_CUTTING !== null, "foam cutting must carry a deadline");
  assert.equal(
    d.FOAM_CUTTING,
    d.FOAM - DEFAULT_CAPACITY_CONFIG.chain.foamCutLeadDays,
    "its deadline is the bonding deadline minus the lead",
  );
  assert.ok(d.FOAM_CUTTING < d.FOAM);
});

test("a bedframe's headboard foam is timed against framing, not sofa bonding", () => {
  const back = (day, n) => day - n;
  const d = deptDeadlines({
    customerDd: 100,
    lane: "BEDFRAME",
    chain: DEFAULT_CAPACITY_CONFIG.chain,
    backWorkday: back,
  });
  // Bedframes never reach sofa foam bonding, so FOAM is null for them.
  assert.equal(d.FOAM, null);
  assert.equal(d.FOAM_CUTTING, d.FRAMING - DEFAULT_CAPACITY_CONFIG.chain.foamCutLeadDays);
});
