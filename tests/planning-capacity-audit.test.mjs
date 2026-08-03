// ---------------------------------------------------------------------------
// planning-capacity-audit.test.mjs — guards the READ-ONLY capacity audit
// (src/api/lib/planning-capacity-audit.ts).
//
// The audit exists to answer one question before anyone edits a capacity
// constant: "what does the engine think each department can do per day, versus
// what it actually did?" Two things must stay true:
//
//   1. The engine-side conversion mirrors runCutting's real lane arithmetic.
//      Under the shipped defaults the bedframe lane collapses to 2 cuts/day on
//      the last reserve tier (laneCap 6 vs pool 5 minus sofaMin 3). That number
//      is the whole reason this audit was written — pin it, so a config change
//      that silently un-starves or further starves bedframe shows up here.
//   2. The audit NEVER writes. It is offered as a safe pre-flight check, so a
//      stray INSERT/UPDATE would break the contract it is sold on.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCapacityAudit,
  steadyStateCuts,
  fabCutEngineMinutes,
} from "../src/api/lib/planning-capacity-audit.ts";
import { DEFAULT_CAPACITY_CONFIG } from "../src/api/lib/planning-capacity.ts";

// A DB stub that records every statement and refuses to be a real database.
// `run` exists only to satisfy the shared DbLike shape; calling it fails the
// read-only contract loudly.
function makeDb(rowsFor) {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      statements.push(sql);
      return {
        bind() {
          return {
            async all() {
              return { results: rowsFor(sql) };
            },
            async first() {
              const r = rowsFor(sql);
              return r.length ? r[0] : null;
            },
            async run() {
              throw new Error("capacity audit must never write");
            },
          };
        },
      };
    },
  };
}

test("steady-state cut split mirrors runCutting's lane arithmetic", () => {
  const cuts = steadyStateCuts(DEFAULT_CAPACITY_CONFIG);
  // Last reserve tier is the one that covers most of the 21-day window.
  assert.equal(cuts.pool, 5);
  // min(laneCap.BEDFRAME 6, max(1, pool 5 - sofaMin 3)) = 2
  assert.equal(cuts.bedframe, 2);
  // Sofa fills the shared pool up to min(pool, bedframe + laneCap.SOFA).
  assert.equal(cuts.sofa, 3);
  // Accessory runs on its own pool, so it is laneCap.ACCESSORY outright.
  assert.equal(cuts.accessory, 8);
  // Bedframe + sofa may never exceed the shared pool.
  assert.ok(cuts.bedframe + cuts.sofa <= cuts.pool);
});

test("fabric cutting's slot budget converts to a minutes ceiling", () => {
  // 2*8*8 (bedframe) + 3*3*20 (sofa) + 8*8*4 (accessory) = 564
  assert.equal(fabCutEngineMinutes(DEFAULT_CAPACITY_CONFIG), 564);
});

test("raising the pool alone cannot un-starve bedframe — laneCap also clamps", () => {
  const widened = {
    ...DEFAULT_CAPACITY_CONFIG,
    reserveTiers: [{ uptoDay: Number.MAX_SAFE_INTEGER, cuts: 20 }],
  };
  // pool 20 - sofaMin 3 = 17, but laneCap.BEDFRAME 6 still wins.
  assert.equal(steadyStateCuts(widened).bedframe, 6);
});

test("audit reports every department and never writes", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("kv_config")) return []; // no override, no holidays
    if (sql.includes("SUM(COALESCE(jc.wipQty")) {
      return [{ dept: "WOOD_CUT", sets: 140 }];
    }
    if (sql.includes("job_cards")) {
      return [
        { dept: "FAB_CUT", minutes: 951 * 7 },
        { dept: "FAB_SEW", minutes: 2704 * 7 },
        { dept: "WOOD_CUT", minutes: 1156 * 7 },
      ];
    }
    return [];
  });

  const audit = await buildCapacityAudit(db);

  // Assert the roster, not a count: a newly added department that never
  // reaches the scheduler must fail here rather than pass a stale number.
  assert.deepEqual(
    audit.depts.map((d) => d.dept).sort(),
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
  assert.equal(audit.windowWorkingDays, 7);

  const by = Object.fromEntries(audit.depts.map((d) => [d.dept, d]));

  // Fabric cutting is metered in slots and lands well under actual output.
  assert.equal(by.FAB_CUT.engineUnit, "cut-slots");
  assert.equal(by.FAB_CUT.engineMinPerDay, 564);
  assert.equal(by.FAB_CUT.actualMinPerDay, 951);
  assert.ok(by.FAB_CUT.enginePctOfActual < 100);

  // Sewing's configured ceiling is generous — it is starved by upstream, not
  // capped. Guards against "fix sewing" being read as the remedy.
  assert.equal(by.FAB_SEW.engineUnit, "minutes");
  assert.ok(by.FAB_SEW.enginePctOfActual > 100);

  // Wood cutting is metered in sets; the audit converts via observed min/set.
  assert.equal(by.WOOD_CUT.engineUnit, "sets");
  assert.ok(by.WOOD_CUT.engineMinPerDay > 0);

  // Packing and webbing have no budget at all — that must stay visible.
  assert.equal(by.PACKING.engineUnit, "none");
  assert.equal(by.PACKING.engineMinPerDay, null);
  assert.equal(by.PACKING.enginePctOfActual, null);
  assert.equal(by.WEBBING.engineUnit, "none");

  // The suggested budget is exactly the measured throughput.
  for (const d of audit.depts) {
    assert.equal(d.suggestedMinPerDay, d.actualMinPerDay);
  }

  // Read-only contract: no mutating statement was ever prepared.
  for (const sql of db.statements) {
    assert.ok(
      !/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(sql),
      `audit prepared a mutating statement: ${sql}`,
    );
  }
});
