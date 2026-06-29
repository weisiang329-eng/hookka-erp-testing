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
