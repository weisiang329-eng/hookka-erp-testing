import { test } from "node:test";
import assert from "node:assert/strict";
import { costAsOfByPo, poKeyForLedgerType } from "../src/lib/cost-attribution.ts";

// MONEY-CRITICAL regression. The WIP/FG cost engine attributes a production
// order's material + labour from cost_ledger. The owning PO lives in a DIFFERENT
// column per row type:
//   RM_ISSUE     → PO in refId   (itemId = raw-material id)
//   LABOR_POSTED → PO in itemId  (refId = job-card id)
// A prior bug bucketed LABOR_POSTED by refId (the JOB CARD) but looked it up by
// PO id → every lookup missed → labour silently 0 in WIP and finished-goods cost.
// These tests lock the key choice AND the per-PO isolation (a PO's cost is ONLY
// its own rows, never another PO's).

test("poKeyForLedgerType: LABOR_POSTED uses itemId, RM_ISSUE/ADJUSTMENT use refId", () => {
  assert.equal(poKeyForLedgerType("LABOR_POSTED"), "itemId");
  assert.equal(poKeyForLedgerType("RM_ISSUE"), "refId");
  assert.equal(poKeyForLedgerType("ADJUSTMENT"), "refId");
});

test("LABOR_POSTED is bucketed by itemId (the PO), NOT refId (the job card)", () => {
  // Two job cards (jc-1, jc-2) for the SAME PO (po-1); refId differs per card,
  // itemId is the PO on both. Labour must aggregate to po-1, and a lookup by the
  // job-card id must return 0 (the old-bug key).
  const rows = [
    { type: "LABOR_POSTED", itemId: "po-1", refId: "jc-1", date: "2026-06-01", totalCostSen: 1500 },
    { type: "LABOR_POSTED", itemId: "po-1", refId: "jc-2", date: "2026-06-02", totalCostSen: 2500 },
  ];
  const laborAsOf = costAsOfByPo(rows, "LABOR_POSTED");
  assert.equal(laborAsOf("po-1", "2026-06-30"), 4000); // 1500 + 2500
  assert.equal(laborAsOf("jc-1", "2026-06-30"), 0); // the buggy refId key → miss
  assert.equal(laborAsOf("jc-2", "2026-06-30"), 0);
});

test("RM_ISSUE is bucketed by refId (the PO), NOT itemId (the raw material)", () => {
  // Two raw materials issued to the same PO; itemId differs (the RM), refId is
  // the PO on both. Material must aggregate to po-1; a lookup by an RM id → 0.
  const rows = [
    { type: "RM_ISSUE", itemId: "rm-foam", refId: "po-1", date: "2026-06-01", totalCostSen: 700 },
    { type: "RM_ISSUE", itemId: "rm-fabric", refId: "po-1", date: "2026-06-03", totalCostSen: 300 },
  ];
  const matAsOf = costAsOfByPo(rows, "RM_ISSUE");
  assert.equal(matAsOf("po-1", "2026-06-30"), 1000);
  assert.equal(matAsOf("rm-foam", "2026-06-30"), 0); // the buggy itemId key → miss
});

test("per-PO ISOLATION: a PO's cost is ONLY its own rows, never another PO's", () => {
  const rows = [
    // po-1 labour
    { type: "LABOR_POSTED", itemId: "po-1", refId: "jc-a", date: "2026-06-01", totalCostSen: 1000 },
    // po-2 labour — must NOT leak into po-1
    { type: "LABOR_POSTED", itemId: "po-2", refId: "jc-b", date: "2026-06-01", totalCostSen: 9999 },
    // an RM_ISSUE row that happens to share po-1 in refId must be IGNORED when
    // bucketing LABOR_POSTED (wrong type), so it can't inflate labour either.
    { type: "RM_ISSUE", itemId: "rm-x", refId: "po-1", date: "2026-06-01", totalCostSen: 5000 },
  ];
  const laborAsOf = costAsOfByPo(rows, "LABOR_POSTED");
  assert.equal(laborAsOf("po-1", "2026-06-30"), 1000); // only po-1's labour
  assert.equal(laborAsOf("po-2", "2026-06-30"), 9999);
});

test("as-of-date: only rows dated <= D count; later rows excluded", () => {
  const rows = [
    { type: "LABOR_POSTED", itemId: "po", refId: "jc1", date: "2026-05-10", totalCostSen: 100 },
    { type: "LABOR_POSTED", itemId: "po", refId: "jc2", date: "2026-06-20", totalCostSen: 200 },
  ];
  const laborAsOf = costAsOfByPo(rows, "LABOR_POSTED");
  assert.equal(laborAsOf("po", "2026-05-31"), 100); // only the May row
  assert.equal(laborAsOf("po", "2026-06-30"), 300); // both
  assert.equal(laborAsOf("po", "2026-04-30"), 0); // none yet
});

test("rows with a null PO key or null/empty date are ignored", () => {
  const rows = [
    { type: "LABOR_POSTED", itemId: null, refId: "jc", date: "2026-06-01", totalCostSen: 500 }, // null PO → ignored
    { type: "LABOR_POSTED", itemId: "po", refId: "jc", date: null, totalCostSen: 500 }, // null date → ignored
    { type: "LABOR_POSTED", itemId: "po", refId: "jc", date: "2026-06-02", totalCostSen: 400 }, // counted
  ];
  const laborAsOf = costAsOfByPo(rows, "LABOR_POSTED");
  assert.equal(laborAsOf("po", "2026-06-30"), 400);
});

test("date compares on the YYYY-MM-DD prefix (full ISO timestamps work)", () => {
  const rows = [
    { type: "LABOR_POSTED", itemId: "po", refId: "jc", date: "2026-06-15T12:00:00.000Z", totalCostSen: 250 },
  ];
  const laborAsOf = costAsOfByPo(rows, "LABOR_POSTED");
  assert.equal(laborAsOf("po", "2026-06-15"), 250);
  assert.equal(laborAsOf("po", "2026-06-14"), 0);
});

// --- BUG-2026-06-29-001: WIP per PO = ACTUAL booked cost, NOT a FIFO re-valuation ---
//
// `wipAsOf` in loadMaterialCostData values each in-progress production order as
//   materialAsOf(po,D) + laborAsOf(po,D)
// where BOTH accessors are costAsOfByPo over the SAME cost_ledger rows:
//   materialAsOf = costAsOfByPo(rows, "RM_ISSUE")     // RM_ISSUE.total_cost_sen by refId(=PO)
//   laborAsOf    = costAsOfByPo(rows, "LABOR_POSTED") // LABOR_POSTED.total_cost_sen by itemId(=PO)
// i.e. WIP per PO is exactly Σ that PO's OWN (RM_ISSUE + LABOR_POSTED) total_cost_sen
// dated ≤ D — the material actually booked to the PO + labour posted to it. It is
// NOT the FIFO replay's per-issue re-valuation (the old `fifoMaterialAsOf`), which
// was ~15× too high on live prod (WIP-CLOSING RM 267,721 vs the real ~RM 10k).
// These tests lock that composition: integer-sen booked totals, as-of-date, and no
// cross-PO leakage. They mirror exactly how wipAsOf builds the two accessors.

// Replicates wipAsOf's per-PO term from raw cost_ledger rows.
function wipPoAsOf(rows, poId, dIso) {
  const materialAsOf = costAsOfByPo(rows, "RM_ISSUE");
  const laborAsOf = costAsOfByPo(rows, "LABOR_POSTED");
  return materialAsOf(poId, dIso) + laborAsOf(poId, dIso);
}

test("WIP per PO = Σ its own RM_ISSUE + LABOR_POSTED total_cost_sen (the booked cost, not a FIFO replay)", () => {
  // po-1: two RM issues (refId=PO) + two labour postings (itemId=PO).
  const rows = [
    { type: "RM_ISSUE", itemId: "rm-foam", refId: "po-1", date: "2026-06-01", totalCostSen: 4000 },
    { type: "RM_ISSUE", itemId: "rm-fabric", refId: "po-1", date: "2026-06-03", totalCostSen: 1500 },
    { type: "LABOR_POSTED", itemId: "po-1", refId: "jc-1", date: "2026-06-02", totalCostSen: 800 },
    { type: "LABOR_POSTED", itemId: "po-1", refId: "jc-2", date: "2026-06-04", totalCostSen: 1200 },
  ];
  // EXACT integer-sen sum of the PO's own booked rows: 4000+1500 material + 800+1200 labour.
  assert.equal(wipPoAsOf(rows, "po-1", "2026-06-30"), 4000 + 1500 + 800 + 1200); // 7500
});

test("WIP per PO honours as-of-date (only rows dated <= D, material and labour alike)", () => {
  const rows = [
    { type: "RM_ISSUE", itemId: "rm-x", refId: "po-1", date: "2026-05-10", totalCostSen: 1000 },
    { type: "LABOR_POSTED", itemId: "po-1", refId: "jc-a", date: "2026-05-20", totalCostSen: 300 },
    { type: "RM_ISSUE", itemId: "rm-y", refId: "po-1", date: "2026-06-15", totalCostSen: 2000 },
    { type: "LABOR_POSTED", itemId: "po-1", refId: "jc-b", date: "2026-06-25", totalCostSen: 700 },
  ];
  assert.equal(wipPoAsOf(rows, "po-1", "2026-04-30"), 0);              // nothing yet
  assert.equal(wipPoAsOf(rows, "po-1", "2026-05-31"), 1000 + 300);    // only May rows
  assert.equal(wipPoAsOf(rows, "po-1", "2026-06-30"), 1000 + 300 + 2000 + 700); // all
});

test("WIP per PO has NO cross-PO leakage (po-1 never includes po-2's material or labour)", () => {
  const rows = [
    { type: "RM_ISSUE", itemId: "rm-x", refId: "po-1", date: "2026-06-01", totalCostSen: 5000 },
    { type: "LABOR_POSTED", itemId: "po-1", refId: "jc-a", date: "2026-06-01", totalCostSen: 600 },
    // po-2's rows must NOT bleed into po-1.
    { type: "RM_ISSUE", itemId: "rm-x", refId: "po-2", date: "2026-06-01", totalCostSen: 99999 },
    { type: "LABOR_POSTED", itemId: "po-2", refId: "jc-b", date: "2026-06-01", totalCostSen: 88888 },
  ];
  assert.equal(wipPoAsOf(rows, "po-1", "2026-06-30"), 5000 + 600);        // only po-1
  assert.equal(wipPoAsOf(rows, "po-2", "2026-06-30"), 99999 + 88888);     // only po-2
});

test("WIP per PO uses RM_ISSUE.total_cost_sen verbatim — independent of any FIFO layer/qty re-pricing", () => {
  // The booked RM_ISSUE total is taken as-is. Even if a FIFO replay would re-cost
  // these issues differently (e.g. layer pricing inflating them ~15×), WIP must
  // equal the booked sen, not the replay figure. qty/unitCost are deliberately
  // absent here: the accessor reads total_cost_sen only.
  const rows = [
    { type: "RM_ISSUE", itemId: "rm-1", refId: "po-1", date: "2026-06-01", totalCostSen: 333 },
    { type: "RM_ISSUE", itemId: "rm-1", refId: "po-1", date: "2026-06-02", totalCostSen: 667 },
  ];
  // No labour: WIP material-only = exactly Σ booked RM_ISSUE = 1000 sen (RM 10.00).
  assert.equal(wipPoAsOf(rows, "po-1", "2026-06-30"), 1000);
});
