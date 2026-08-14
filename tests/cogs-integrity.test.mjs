// ---------------------------------------------------------------------------
// cogs-integrity.test.mjs — the detector that measures how many delivered
// units shipped with no cost behind them.
//
// `consumeFGBatchesForDO` returns `shortages` — DO lines it could not satisfy
// from fg_batches. The caller in routes/delivery-orders/_helpers.ts consumes
// only `statements` and drops `shortages`, and there is no reconcile anywhere
// in routes/, lib/ or cron/. Those units ship with RM0 COGS and 100% margin,
// permanently.
//
// Detector BEFORE repair, deliberately: Houzs-ERP's inventory-costing-oversell
// COE spends its section 6 on having written the repair before knowing the
// shape of the damage. Costing is the last place to guess.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkCogsIntegrity,
  summarizeCogsIssues,
} from "../src/api/lib/cogs-integrity.ts";

/** Minimal D1-shaped stub — the same shape compliance-report.ts passes in. */
function db(rows, { throwOn = false } = {}) {
  return {
    prepare() {
      return {
        bind() {
          return {
            async all() {
              if (throwOn) throw new Error("boom");
              return { results: rows };
            },
          };
        },
      };
    },
  };
}

test("a fully costed delivery is not an issue", async () => {
  const out = await checkCogsIntegrity(
    db([{ do_id: "do-1", do_no: "DO-1", delivered_qty: 5, costed_qty: 5, costed_sen: 5000 }]),
  );
  assert.deepEqual(out, []);
});

test("a partly costed delivery reports the gap and values it", async () => {
  const [r] = await checkCogsIntegrity(
    db([
      {
        do_id: "do-2",
        do_no: "DO-2607-111",
        customer_name: "Houzs Century",
        delivered_at: "2026-07-23",
        delivered_qty: 5,
        costed_qty: 3,
        costed_sen: 3000, // RM 10.00 per unit
      },
    ]),
  );
  assert.equal(r.kind, "partial_uncosted");
  assert.equal(r.uncostedQty, 2);
  // 2 units at this DO's OWN average of 1000 sen.
  assert.equal(r.estimatedMissingSen, 2000);
  assert.equal(r.doNo, "DO-2607-111");
  assert.equal(r.customerName, "Houzs Century");
});

test("a delivery with NO ledger at all is a different finding", async () => {
  // The cascade never ran here, as opposed to running short — a different
  // failure with a different repair, so it must not be averaged in with the
  // partial ones.
  const [r] = await checkCogsIntegrity(
    db([{ do_id: "do-3", do_no: "DO-3", delivered_qty: 4, costed_qty: 0, costed_sen: 0 }]),
  );
  assert.equal(r.kind, "no_cost_at_all");
  assert.equal(r.uncostedQty, 4);
  assert.equal(
    r.estimatedMissingSen,
    null,
    "no costed unit means no honest basis — report null, never invent a number",
  );
});

test("the driver's camelCase keys are read too", async () => {
  // db-pg camelCases every column it returns, so the rows arrive as
  // deliveredQty / costedQty — the exact trap that made /api/org-chart return
  // 200 with the value silently discarded.
  const [r] = await checkCogsIntegrity(
    db([{ doId: "do-4", doNo: "DO-4", deliveredQty: 3, costedQty: 1, costedSen: 500 }]),
  );
  assert.equal(r.uncostedQty, 2);
  assert.equal(r.estimatedMissingSen, 1000);
});

test("a broken query is an UNKNOWN, not an empty result", async () => {
  // CHANGED 2026-08-14 (BUG-2026-08-13-141). This used to assert
  // `deepEqual(…, [])` — "it never throws". That WAS the bug: an `[]` from a
  // failed query is indistinguishable from an `[]` meaning "every delivered
  // unit is costed", and the daily report printed the second sentence over the
  // first. The sweep still cannot 500 — `collectComplianceData`'s `runCheck`
  // catches this rejection and records the check as unavailable — but the
  // decision is made THERE, once, instead of here, silently.
  await assert.rejects(
    () => checkCogsIntegrity(db([], { throwOn: true })),
    /boom/,
    "a failed COGS query must propagate so the report can say it could not check",
  );
});

test("the summary separates what can be valued from what cannot", () => {
  const s = summarizeCogsIssues([
    { uncostedQty: 2, estimatedMissingSen: 2000 },
    { uncostedQty: 4, estimatedMissingSen: null },
    { uncostedQty: 1, estimatedMissingSen: 750 },
  ]);
  assert.deepEqual(s, {
    orders: 3,
    uncostedUnits: 7,
    estimatedMissingSen: 2750,
    ordersWithNoBasis: 1,
  });
});

test("the detector writes NOTHING", () => {
  const src = readFileSync("src/api/lib/cogs-integrity.ts", "utf8");
  for (const w of ["INSERT", "UPDATE ", "DELETE", "ALTER", "DROP"]) {
    assert.ok(!src.toUpperCase().includes(` ${w}`.toUpperCase().trimStart() + " INTO"), w);
  }
  assert.doesNotMatch(src, /\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|ALTER TABLE|DROP TABLE)\b/);
});

test("it is wired into the daily report AND reachable on demand", () => {
  const compliance = readFileSync("src/api/lib/compliance-report.ts", "utf8");
  assert.match(compliance, /checkCogsIntegrity\(db\)/);
  // The count goes through `n(key, outcome)`, which returns `null` for a check
  // that could not run (BUG-2026-08-13-141). A bare `.length` here would mean
  // the outcome was unwrapped without recording the failure.
  assert.match(compliance, /cogsIssues: n\("cogsIssues", cogsIssues\)/);
  // It must still reach the headline total. The total is now a reduce over the
  // per-check map rather than a hand-written sum, so assert on membership in
  // that map — the positional form broke the moment another category was
  // appended (pendingTimeAdjustments, 2026-08-07) and a hardcoded sum broke
  // again here.
  const perCheck = compliance.match(/const perCheck = \{([\s\S]*?)\n  \};/)?.[1] ?? "";
  assert.ok(
    perCheck.includes('cogsIssues: n("cogsIssues", cogsIssues)'),
    "must be in perCheck, which is what the total reduces over",
  );
  assert.match(
    compliance,
    /total: checkKeys\.reduce\(\(s, k\) => s \+ \(perCheck\[k\] \?\? 0\), 0\)/,
    "the total must sum perCheck — an unavailable check contributes nothing, " +
      "not a zero it never measured",
  );

  // The on-demand endpoint is the point: sizing a money exposure needs live
  // data, not yesterday's cached snapshot.
  const reports = readFileSync("src/api/routes/reports.ts", "utf8");
  assert.match(reports, /app\.get\("\/cogs-integrity\.json"/);
});
