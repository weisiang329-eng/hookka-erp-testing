import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeliveredAsOf, fgClosingSen } from "../src/lib/fg-closing.ts";

// Regression for the MONEY-CRITICAL FG-closing bug: the P&L's finished-goods
// CLOSING stock accumulated without bound (~RM 1,355,189) because deliveries
// never relieved FG. The old code counted `fg_units` keyed on
// `fg_units.batchId`, which is ALWAYS NULL → delivered = 0 → undelivered =
// originalQty forever → FG closing = every batch ever completed.
//
// The fix sources relief from cost_ledger FG_DELIVERED rows (emitted by
// consumeFGBatchesForDO on every DO→DELIVERED) with (date, qty, batchId),
// where qty is the SAME quantity decremented from fg_batches.remainingQty —
// i.e. the SAME unit as originalQty by construction.
//
// THE CORE INVARIANT: a batch of N units with M delivered as of date D yields
// FG closing = (N − M) × unitCost, NOT N × unitCost.

// A flat per-unit cost so the assertions read in plain money. unitCostResolver
// returns the TOTAL completion basis (material+labour) in sen for the PO;
// fgClosingSen divides by originalQty internally.
const flatBasis = (perUnitSen, origQty) => () => perUnitSen * origQty;

test("THE BUG: N units, M delivered as of D → closing = (N−M)×unitCost, not N×unitCost", () => {
  const N = 10;
  const M = 4;
  const unitCostSen = 5000; // RM 50.00 per unit
  const batch = {
    id: "fgb-1",
    productionOrderId: "po-1",
    completedDate: "2026-06-01",
    originalQty: N,
  };
  // FG_DELIVERED relief: 4 units delivered on 2026-06-10 (one ledger slice).
  const delivered = [{ batchId: "fgb-1", date: "2026-06-10", qty: M }];
  const deliveredAsOf = buildDeliveredAsOf(delivered);

  // As of 2026-06-30 (after the delivery): only N−M remain.
  const closeAfter = fgClosingSen({
    batches: [batch],
    asOfIso: "2026-06-30",
    deliveredAsOf,
    unitCostResolver: flatBasis(unitCostSen, N),
  });
  assert.equal(closeAfter, (N - M) * unitCostSen); // 6 × 5000 = 30000
  // The bug would have returned the full N × unitCost.
  assert.notEqual(closeAfter, N * unitCostSen); // NOT 50000

  // As of 2026-06-05 (BEFORE the delivery): nothing relieved yet → full N.
  const closeBefore = fgClosingSen({
    batches: [batch],
    asOfIso: "2026-06-05",
    deliveredAsOf,
    unitCostResolver: flatBasis(unitCostSen, N),
  });
  assert.equal(closeBefore, N * unitCostSen); // 10 × 5000 = 50000
});

test("relief is as-of-date: deliveries after D do not reduce closing at D", () => {
  const batch = { id: "b", productionOrderId: "po", completedDate: "2026-05-01", originalQty: 8 };
  const deliveredAsOf = buildDeliveredAsOf([
    { batchId: "b", date: "2026-05-15", qty: 3 },
    { batchId: "b", date: "2026-06-20", qty: 2 },
  ]);
  const u = (origQty) => flatBasis(1000, origQty);
  // End of May: only the 2026-05-15 relief counts → 8−3 = 5.
  assert.equal(
    fgClosingSen({ batches: [batch], asOfIso: "2026-05-31", deliveredAsOf, unitCostResolver: u(8) }),
    5 * 1000,
  );
  // End of June: both reliefs count → 8−5 = 3.
  assert.equal(
    fgClosingSen({ batches: [batch], asOfIso: "2026-06-30", deliveredAsOf, unitCostResolver: u(8) }),
    3 * 1000,
  );
});

test("fully delivered batch contributes 0 (no negative closing)", () => {
  const batch = { id: "b", productionOrderId: "po", completedDate: "2026-06-01", originalQty: 5 };
  // Over-relieve (6 > 5) — must clamp at 0, never go negative.
  const deliveredAsOf = buildDeliveredAsOf([{ batchId: "b", date: "2026-06-02", qty: 6 }]);
  assert.equal(
    fgClosingSen({ batches: [batch], asOfIso: "2026-06-30", deliveredAsOf, unitCostResolver: flatBasis(1000, 5) }),
    0,
  );
});

test("batch not completed by D is excluded entirely", () => {
  const batch = { id: "b", productionOrderId: "po", completedDate: "2026-07-01", originalQty: 5 };
  const deliveredAsOf = buildDeliveredAsOf([]);
  assert.equal(
    fgClosingSen({ batches: [batch], asOfIso: "2026-06-30", deliveredAsOf, unitCostResolver: flatBasis(1000, 5) }),
    0,
  );
});

test("multiple FG_DELIVERED slices for the same batch sum up", () => {
  // consumeFGBatchesForDO emits one row PER layer-slice; several deliveries of
  // the same batch must accumulate. 10 made; 2+3+1 delivered by D → 4 remain.
  const batch = { id: "b", productionOrderId: "po", completedDate: "2026-06-01", originalQty: 10 };
  const deliveredAsOf = buildDeliveredAsOf([
    { batchId: "b", date: "2026-06-05", qty: 2 },
    { batchId: "b", date: "2026-06-06", qty: 3 },
    { batchId: "b", date: "2026-06-07", qty: 1 },
    { batchId: "other", date: "2026-06-08", qty: 99 }, // different batch, ignored
  ]);
  assert.equal(
    fgClosingSen({ batches: [batch], asOfIso: "2026-06-30", deliveredAsOf, unitCostResolver: flatBasis(700, 10) }),
    4 * 700,
  );
});

test("piece-level originalQty: relief qty is in the SAME unit as originalQty", () => {
  // When a product has >1 piece, fg_batches.originalQty is piece-level
  // (units×pieces) and unitCostSen is therefore per-piece. The FG_DELIVERED
  // qty is the SAME quantity decremented from remainingQty, so it is ALSO
  // piece-level — they tie out without any units↔pieces conversion.
  // 3 units × 2 pieces = 6 (originalQty). Deliver 1 unit = 2 pieces → 4 remain.
  const PIECES = 6;
  const totalBasisSen = 12000; // RM 120 for the batch → 2000 sen/piece
  const batch = { id: "b", productionOrderId: "po", completedDate: "2026-06-01", originalQty: PIECES };
  const deliveredAsOf = buildDeliveredAsOf([{ batchId: "b", date: "2026-06-10", qty: 2 }]);
  const close = fgClosingSen({
    batches: [batch],
    asOfIso: "2026-06-30",
    deliveredAsOf,
    unitCostResolver: () => totalBasisSen,
  });
  // (6 − 2) pieces × (12000/6) sen/piece = 4 × 2000 = 8000.
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

test("two batches: closing sums per-batch undelivered value", () => {
  const batches = [
    { id: "b1", productionOrderId: "po1", completedDate: "2026-06-01", originalQty: 10 },
    { id: "b2", productionOrderId: "po2", completedDate: "2026-06-02", originalQty: 4 },
  ];
  const deliveredAsOf = buildDeliveredAsOf([
    { batchId: "b1", date: "2026-06-10", qty: 7 }, // 3 left @ 1000 = 3000
    { batchId: "b2", date: "2026-06-11", qty: 1 }, // 3 left @ 2000 = 6000
  ]);
  const unitCostResolver = (poId) => (poId === "po1" ? 1000 * 10 : 2000 * 4);
  assert.equal(
    fgClosingSen({ batches, asOfIso: "2026-06-30", deliveredAsOf, unitCostResolver }),
    3000 + 6000,
  );
});
