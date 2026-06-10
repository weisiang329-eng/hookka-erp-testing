// ---------------------------------------------------------------------------
// jc-minutes-total.test.mjs — guards jcMinutesTotal, the shared read-side
// "total production minutes for a job card" helper.
//
// Why this exists: the merged FABRIC CUTTING (FAB_CUT) job_card stores
// estMinutes / productionTimeMinutes as the per-SET TOTAL (sum of every piece
// of the set), and wipQty as the piece count. So for FAB_CUT the stored total
// is ALREADY the answer — multiplying by wipQty triple-counts (e.g. a 3-piece
// sofa set of 190 min would read 570). Every OTHER dept stores PER-PIECE
// minutes, so its total is per-piece × wipQty. This helper centralises that
// branch; the labor COST cascade already costs the un-multiplied total, so this
// keeps efficiency/capacity reads consistent with cost.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { jcMinutesTotal } from "../src/lib/job-card-minutes.ts";

test("FAB_CUT: stored total is NOT multiplied by wipQty (piece count)", () => {
  // 3-piece sofa set: estMinutes 190 is the whole-set total, wipQty=3 pieces.
  // Pre-fix this read 190 × 3 = 570 — a 3× over-count.
  assert.equal(jcMinutesTotal(190, { departmentCode: "FAB_CUT", wipQty: 3 }), 190);
});

test("FAB_SEW: per-piece minutes × wipQty (1 piece) = per-piece", () => {
  assert.equal(jcMinutesTotal(150, { departmentCode: "FAB_SEW", wipQty: 1 }), 150);
});

test("non-FAB_CUT dept: per-piece × wipQty", () => {
  assert.equal(jcMinutesTotal(50, { departmentCode: "FRAMING", wipQty: 4 }), 200);
});

test("wipQty null on a non-FAB_CUT dept falls back to ×1", () => {
  assert.equal(jcMinutesTotal(50, { departmentCode: "FRAMING", wipQty: null }), 50);
});

test("wipQty undefined / 0 floors at ×1 (non-FAB_CUT)", () => {
  assert.equal(jcMinutesTotal(50, { departmentCode: "PACKING" }), 50);
  assert.equal(jcMinutesTotal(50, { departmentCode: "PACKING", wipQty: 0 }), 50);
});

test("missing departmentCode is treated as non-FAB_CUT (×wipQty)", () => {
  assert.equal(jcMinutesTotal(50, { wipQty: 4 }), 200);
  assert.equal(jcMinutesTotal(50, { departmentCode: null, wipQty: 4 }), 200);
});

test("zero / falsy perUnit yields 0 for both branches", () => {
  assert.equal(jcMinutesTotal(0, { departmentCode: "FAB_CUT", wipQty: 3 }), 0);
  assert.equal(jcMinutesTotal(0, { departmentCode: "FRAMING", wipQty: 3 }), 0);
});
