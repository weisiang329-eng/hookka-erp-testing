// ---------------------------------------------------------------------------
// planning-adaptive-capacity.test.mjs — the three guard rails on the
// measured-throughput budget, plus the read-only-by-default contract.
//
// The budget tracks what the floor actually produced, so it must be trusted to
// move on its own. These tests pin the ways it is NOT allowed to move:
// a quiet week may not zero a department, one bad data day may not install an
// absurd budget, and no day may lurch more than 20% from the value the floor
// is currently working to.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveOne,
  configuredMinutes,
  resolveAdaptiveCapacity,
  MAX_DAILY_DRIFT,
  FIRST_RUN_MAX_GROWTH,
  MIN_BUDGET_MIN,
  EFFECTIVE_CAPACITY_KEY,
} from "../src/api/lib/planning-adaptive-capacity.ts";
import { DEFAULT_CAPACITY_CONFIG } from "../src/api/lib/planning-capacity.ts";

test("a measured department simply uses what it produced", () => {
  const r = resolveOne("FAB_SEW", 2704, 3540, 2700);
  // Within ±20% of the previous value, so it is taken as-is.
  assert.equal(r.reason, "measured");
  assert.equal(r.effectiveMinPerDay, 2704);
});

test("a quiet week never zeroes a department", () => {
  const r = resolveOne("FRAMING", 0, 1800, 1750);
  assert.equal(r.reason, "cold-start");
  // Holds the last value in force rather than collapsing to nothing.
  assert.equal(r.effectiveMinPerDay, 1750);
  assert.ok(r.effectiveMinPerDay >= MIN_BUDGET_MIN);
});

test("cold start with no history at all falls back to the configured constant", () => {
  const r = resolveOne("FOAM", 0, 480, null);
  assert.equal(r.reason, "cold-start");
  assert.equal(r.effectiveMinPerDay, 480);
});

test("a department that has never had a constant still gets a usable floor", () => {
  // Packing has no configured minute budget and no history.
  const r = resolveOne("PACKING", 0, null, null);
  assert.equal(r.effectiveMinPerDay, MIN_BUDGET_MIN);
});

test("the budget never jumps more than 20% up in one day", () => {
  const previous = 1000;
  const r = resolveOne("FAB_CUT", 5000, 564, previous);
  assert.equal(r.reason, "rate-limited-up");
  assert.equal(r.effectiveMinPerDay, Math.round(previous * (1 + MAX_DAILY_DRIFT)));
  assert.ok(r.effectiveMinPerDay < 5000, "must not adopt the spike outright");
});

test("the budget never drops more than 20% in one day", () => {
  const previous = 1000;
  const r = resolveOne("WOOD_CUT", 100, null, previous);
  assert.equal(r.reason, "rate-limited-down");
  assert.equal(r.effectiveMinPerDay, Math.round(previous * (1 - MAX_DAILY_DRIFT)));
  assert.ok(r.effectiveMinPerDay > 100, "a bad week must not strand the queue");
});

test("with no history, a wild first observation is capped against the constant", () => {
  const r = resolveOne("FAB_CUT", 99999, 564, null);
  assert.equal(r.reason, "first-run-capped");
  assert.equal(r.effectiveMinPerDay, 564 * FIRST_RUN_MAX_GROWTH);
});

test("a plausible first observation is adopted without capping", () => {
  // The real case: CNC now does ~951 min/day against a 564 min constant.
  const r = resolveOne("FAB_CUT", 951, 564, null);
  assert.equal(r.reason, "measured");
  assert.equal(r.effectiveMinPerDay, 951);
  assert.ok(
    r.effectiveMinPerDay > r.configuredMinPerDay,
    "the whole point: a faster floor must raise its own budget",
  );
});

test("repeated drift converges on the measured value instead of oscillating", () => {
  let prev = 564;
  const measured = 951;
  for (let day = 0; day < 20; day++) {
    prev = resolveOne("FAB_CUT", measured, 564, prev).effectiveMinPerDay;
  }
  assert.equal(prev, measured, "should settle exactly on measured, not overshoot");
});

test("configured constants match the shipped engine values", () => {
  const cfg = DEFAULT_CAPACITY_CONFIG;
  assert.equal(configuredMinutes(cfg, "FAB_SEW"), 1200 + 2100 + 240);
  assert.equal(configuredMinutes(cfg, "FRAMING"), 1320 + 480);
  assert.equal(configuredMinutes(cfg, "FOAM"), 480);
  assert.equal(configuredMinutes(cfg, "UPHOLSTERY"), 1440 + 720);
  assert.equal(configuredMinutes(cfg, "FAB_CUT"), 564);
  // Budgeted in sets — deliberately no minute constant.
  assert.equal(configuredMinutes(cfg, "WOOD_CUT"), null);
  assert.equal(configuredMinutes(cfg, "PACKING"), null);
});

function makeDb(rowsFor) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              return { results: rowsFor(sql) };
            },
            async first() {
              const r = rowsFor(sql);
              return r.length ? r[0] : null;
            },
            async run() {
              writes.push({ sql, args });
            },
          };
        },
      };
    },
  };
}

// Capacity is now sampled PER WORKING DAY over a long window and reduced with
// a trimmed mean, so the stub returns a day series rather than one sum. Every
// day here is a Monday-to-Saturday date; Sundays would be filtered out.
const WORKING_DAYS = [
  "2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-11",
  "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16",
];

const rows = (sql) => {
  if (sql.includes("planning_effective_capacity")) return [];
  if (sql.includes("planning_capacity_pins")) return [];
  if (sql.includes("kv_config")) return [];
  if (sql.includes("job_cards")) {
    // A steady 951/day for FAB_CUT — the trimmed mean of a flat series is the
    // series value, which keeps the assertions below readable.
    return WORKING_DAYS.flatMap((day) => [
      { dept: "FAB_CUT", day, minutes: 951 },
      { dept: "FAB_SEW", day, minutes: 2704 },
    ]);
  }
  return [];
};

test("resolving is read-only unless persistence is asked for", async () => {
  const db = makeDb(rows);
  const r = await resolveAdaptiveCapacity(db);
  assert.equal(r.persisted, false);
  assert.equal(db.writes.length, 0, "a preview must never move the plan");
  assert.equal(r.byDept.FAB_CUT, 951);
  // Every PRODUCTION department must get a budget. Asserting the roster rather
  // than a count means adding a department fails loudly here instead of
  // silently leaving it unbudgeted — which is exactly how FOAM_CUTTING went
  // unscheduled for weeks.
  assert.deepEqual(
    r.budgets.map((b) => b.dept).sort(),
    [
      "FAB_CUT",
      "FAB_SEW",
      "FOAM",
      "FOAM_CUTTING",
      "FRAMING",
      "PACKING",
      "UPHOLSTERY",
      "WEBBING",
      "WOOD_CUT",
    ],
  );
});

test("persistence writes exactly one kv row when asked", async () => {
  const db = makeDb(rows);
  const r = await resolveAdaptiveCapacity(db, { persist: true });
  assert.equal(r.persisted, true);
  assert.equal(db.writes.length, 1);
  assert.ok(db.writes[0].args.includes(EFFECTIVE_CAPACITY_KEY));
  const stored = JSON.parse(db.writes[0].args[1]);
  assert.equal(stored.byDept.FAB_CUT, 951);
});

test("every department gets a budget, including the never-budgeted ones", async () => {
  const db = makeDb(rows);
  const r = await resolveAdaptiveCapacity(db);
  for (const dept of [
    "FAB_CUT",
    "FAB_SEW",
    "WOOD_CUT",
    "FOAM_CUTTING",
    "FRAMING",
    "FOAM",
    "UPHOLSTERY",
    "PACKING",
    "WEBBING",
  ]) {
    assert.ok(r.byDept[dept] >= MIN_BUDGET_MIN, `${dept} has no usable budget`);
  }
});
