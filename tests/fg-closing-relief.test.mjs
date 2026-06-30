import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeliveredAsOf, fgClosingSen } from "../src/lib/fg-closing.ts";

// Regression for the MONEY-CRITICAL FG-closing bugs.
//
// BUG 1 (relief): the P&L's finished-goods CLOSING stock accumulated without
// bound (~RM 1,355,189) because deliveries never relieved FG. The old code
// counted `fg_units` keyed on `fg_units.batchId`, which is ALWAYS NULL →
// delivered = 0 → undelivered = originalQty forever. Fixed by sourcing relief
// from cost_ledger FG_DELIVERED rows (emitted by consumeFGBatchesForDO on every
// DO→DELIVERED) with (date, qty, batchId), qty in the SAME unit as originalQty.
//
// BUG 2 (unit cost ~15× inflated): FG was re-valued at
// (PO FIFO material@completion + PO labour@completion)/originalQty via a per-PO
// resolver. On live prod that came out ~15× too high (post-opening FG closing
// RM 595k vs the real RM 39k = Σ remaining_qty × unit_cost_sen) — the FIFO
// replay's per-layer issue costs for a PO did not reconcile to the material
// actually booked to that PO. Fixed by valuing each batch's undelivered qty at
// the cascade-maintained fg_batches.unit_cost_sen (per-unit, piece-level) — the
// same figure backfillFGBatchCost rolls up and every other FG surface uses.
//
// THE CORE INVARIANT: a batch of N units (unit_cost_sen = c) with M delivered as
// of date D yields FG closing = (N − M) × c, NOT N × c.

test("THE RELIEF BUG: N units, M delivered as of D → closing = (N−M)×c, not N×c", () => {
  const N = 10;
  const M = 4;
  const unitCostSen = 5000; // RM 50.00 per unit (cascade-maintained)
  const batch = {
    id: "fgb-1",
    productionOrderId: "po-1",
    completedDate: "2026-06-01",
    originalQty: N,
    unitCostSen,
  };
  // FG_DELIVERED relief: 4 units delivered on 2026-06-10 (one ledger slice).
  const delivered = [{ batchId: "fgb-1", date: "2026-06-10", qty: M }];
  const deliveredAsOf = buildDeliveredAsOf(delivered);

  // As of 2026-06-30 (after the delivery): only N−M remain.
  const closeAfter = fgClosingSen({
    batches: [batch],
    asOfIso: "2026-06-30",
    deliveredAsOf,
  });
  assert.equal(closeAfter, (N - M) * unitCostSen); // 6 × 5000 = 30000
  // The bug would have returned the full N × unitCost.
  assert.notEqual(closeAfter, N * unitCostSen); // NOT 50000

  // As of 2026-06-05 (BEFORE the delivery): nothing relieved yet → full N.
  const closeBefore = fgClosingSen({
    batches: [batch],
    asOfIso: "2026-06-05",
    deliveredAsOf,
  });
  assert.equal(closeBefore, N * unitCostSen); // 10 × 5000 = 50000
});

test("THE COST BUG: closing values undelivered at stored unit_cost_sen (not a re-valuation)", () => {
  // The defect inflated FG ~15× by re-deriving unit cost from the FIFO engine.
  // The fix uses fg_batches.unit_cost_sen verbatim. Here a batch's stored
  // unit_cost_sen is RM 12.34/unit; closing MUST equal undelivered × 1234,
  // regardless of any production-order material/labour figures.
  const batch = {
    id: "b",
    productionOrderId: "po",
    completedDate: "2026-06-01",
    originalQty: 20,
    unitCostSen: 1234,
  };
  const deliveredAsOf = buildDeliveredAsOf([{ batchId: "b", date: "2026-06-10", qty: 8 }]);
  const close = fgClosingSen({ batches: [batch], asOfIso: "2026-06-30", deliveredAsOf });
  assert.equal(close, (20 - 8) * 1234); // 12 × 1234 = 14808
});

test("a batch with unit_cost_sen not yet rolled up (0 / null) contributes 0", () => {
  const batches = [
    { id: "z", productionOrderId: "po", completedDate: "2026-06-01", originalQty: 5, unitCostSen: 0 },
    { id: "n", productionOrderId: "po", completedDate: "2026-06-01", originalQty: 5, unitCostSen: null },
  ];
  const deliveredAsOf = buildDeliveredAsOf([]);
  assert.equal(fgClosingSen({ batches, asOfIso: "2026-06-30", deliveredAsOf }), 0);
});

test("relief is as-of-date: deliveries after D do not reduce closing at D", () => {
  const batch = { id: "b", productionOrderId: "po", completedDate: "2026-05-01", originalQty: 8, unitCostSen: 1000 };
  const deliveredAsOf = buildDeliveredAsOf([
    { batchId: "b", date: "2026-05-15", qty: 3 },
    { batchId: "b", date: "2026-06-20", qty: 2 },
  ]);
  // End of May: only the 2026-05-15 relief counts → 8−3 = 5.
  assert.equal(
    fgClosingSen({ batches: [batch], asOfIso: "2026-05-31", deliveredAsOf }),
    5 * 1000,
  );
  // End of June: both reliefs count → 8−5 = 3.
  assert.equal(
    fgClosingSen({ batches: [batch], asOfIso: "2026-06-30", deliveredAsOf }),
    3 * 1000,
  );
});

test("fully delivered batch contributes 0 (no negative closing)", () => {
  const batch = { id: "b", productionOrderId: "po", completedDate: "2026-06-01", originalQty: 5, unitCostSen: 1000 };
  // Over-relieve (6 > 5) — must clamp at 0, never go negative.
  const deliveredAsOf = buildDeliveredAsOf([{ batchId: "b", date: "2026-06-02", qty: 6 }]);
  assert.equal(
    fgClosingSen({ batches: [batch], asOfIso: "2026-06-30", deliveredAsOf }),
    0,
  );
});

test("batch not completed by D is excluded entirely", () => {
  const batch = { id: "b", productionOrderId: "po", completedDate: "2026-07-01", originalQty: 5, unitCostSen: 1000 };
  const deliveredAsOf = buildDeliveredAsOf([]);
  assert.equal(
    fgClosingSen({ batches: [batch], asOfIso: "2026-06-30", deliveredAsOf }),
    0,
  );
});

test("opening-date floor: batches completed BEFORE openingIso are excluded (pre-opening seed)", () => {
  // The owner's ~RM 1.35M legacy FG over-statement: historical batches completed
  // before the accounting opening date are pre-opening stock (represented by the
  // SEEDED opening inventory), NOT system-computed — fgClosingSen must skip them.
  // Relief-by-FG_DELIVERED alone does NOT clear them (legacy batches have no
  // FG_DELIVERED rows), so without the floor they accumulate forever.
  const batches = [
    { id: "old", productionOrderId: "po-old", completedDate: "2026-04-15", originalQty: 100, unitCostSen: 1000 }, // pre-opening
    { id: "new", productionOrderId: "po-new", completedDate: "2026-05-25", originalQty: 5, unitCostSen: 1000 }, // post-opening
  ];
  const deliveredAsOf = buildDeliveredAsOf([]); // nothing delivered (legacy batches never were, via the system)
  const opening = "2026-05-22";

  // With the floor: only the post-opening batch counts → 5 × 1000 = 5000.
  assert.equal(
    fgClosingSen({ batches, asOfIso: "2026-06-30", deliveredAsOf, openingIso: opening }),
    5 * 1000,
  );
  // Without the floor (openingIso omitted): the legacy batch dominates → 105000.
  assert.equal(
    fgClosingSen({ batches, asOfIso: "2026-06-30", deliveredAsOf }),
    105 * 1000,
  );
  // Boundary: a batch completed EXACTLY on openingIso is INCLUDED (>= floor).
  assert.equal(
    fgClosingSen({
      batches: [{ id: "x", productionOrderId: "po-x", completedDate: opening, originalQty: 2, unitCostSen: 1000 }],
      asOfIso: "2026-06-30",
      deliveredAsOf,
      openingIso: opening,
    }),
    2 * 1000,
  );
});

test("multiple FG_DELIVERED slices for the same batch sum up", () => {
  // consumeFGBatchesForDO emits one row PER layer-slice; several deliveries of
  // the same batch must accumulate. 10 made; 2+3+1 delivered by D → 4 remain.
  const batch = { id: "b", productionOrderId: "po", completedDate: "2026-06-01", originalQty: 10, unitCostSen: 700 };
  const deliveredAsOf = buildDeliveredAsOf([
    { batchId: "b", date: "2026-06-05", qty: 2 },
    { batchId: "b", date: "2026-06-06", qty: 3 },
    { batchId: "b", date: "2026-06-07", qty: 1 },
    { batchId: "other", date: "2026-06-08", qty: 99 }, // different batch, ignored
  ]);
  assert.equal(
    fgClosingSen({ batches: [batch], asOfIso: "2026-06-30", deliveredAsOf }),
    4 * 700,
  );
});

test("piece-level originalQty: unit_cost_sen and relief qty are both piece-level", () => {
  // When a product has >1 piece, fg_batches.originalQty is piece-level
  // (units×pieces) and unit_cost_sen is therefore per-piece. The FG_DELIVERED
  // qty is the SAME quantity decremented from remainingQty, so it is ALSO
  // piece-level — they tie out without any units↔pieces conversion.
  // 3 units × 2 pieces = 6 (originalQty), 2000 sen/piece. Deliver 1 unit = 2
  // pieces → 4 remain.
  const batch = { id: "b", productionOrderId: "po", completedDate: "2026-06-01", originalQty: 6, unitCostSen: 2000 };
  const deliveredAsOf = buildDeliveredAsOf([{ batchId: "b", date: "2026-06-10", qty: 2 }]);
  const close = fgClosingSen({ batches: [batch], asOfIso: "2026-06-30", deliveredAsOf });
  // (6 − 2) pieces × 2000 sen/piece = 8000.
  assert.equal(close, 8000);
});

test("buildDeliveredAsOf ignores null batchId, empty date, and non-positive qty", () => {
  const deliveredAsOf = buildDeliveredAsOf([
    { batchId: null, date: "2026-06-01", qty: 5 }, // null batch → ignored
    { batchId: "b", date: "", qty: 5 }, // empty date → ignored
    { batchId: "b", date: "2026-06-01", qty: 0 }, // zero qty → ignored
    { batchId: "b", date: "2026-06-01", qty: -3 }, // negative → ignored
    { batchId: "b", date: "2026-06-02", qty: 4 }, // the only counted row
  ]);
  assert.equal(deliveredAsOf("b", "2026-06-30"), 4);
  assert.equal(deliveredAsOf("b", "2026-06-01"), 0); // before the only valid row
  assert.equal(deliveredAsOf("missing", "2026-06-30"), 0);
});

test("two batches: closing sums per-batch undelivered value at each batch's own unit cost", () => {
  const batches = [
    { id: "b1", productionOrderId: "po1", completedDate: "2026-06-01", originalQty: 10, unitCostSen: 1000 },
    { id: "b2", productionOrderId: "po2", completedDate: "2026-06-02", originalQty: 4, unitCostSen: 2000 },
  ];
  const deliveredAsOf = buildDeliveredAsOf([
    { batchId: "b1", date: "2026-06-10", qty: 7 }, // 3 left @ 1000 = 3000
    { batchId: "b2", date: "2026-06-11", qty: 1 }, // 3 left @ 2000 = 6000
  ]);
  assert.equal(
    fgClosingSen({ batches, asOfIso: "2026-06-30", deliveredAsOf }),
    3000 + 6000,
  );
});
