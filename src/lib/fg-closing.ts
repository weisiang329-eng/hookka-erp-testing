// ---------------------------------------------------------------------------
// fg-closing.ts — pure, as-of-date finished-goods closing-stock valuation.
//
// Extracted from accounting.ts `loadMaterialCostData` so the relief math is
// unit-testable in isolation. The P&L's finished-goods CLOSING stock is:
//
//   fgCloseSen(D) = Σ over fg_batches completed by D of
//                     undeliveredQty(batch, D) × unitCostSen(batch)
//
//   undeliveredQty(batch, D) = originalQty − deliveredAsOf(batch, D)
//   unitCostSen(batch)       = fg_batches.unit_cost_sen  (cascade-maintained,
//                              per-unit-of-originalQty; piece-level)
//
// THE BUG THIS FIXES (FG closing accumulated without bound):
//   The old relief signal counted `fg_units` rows keyed on `fg_units.batchId`,
//   but that column is ALWAYS NULL (fg-units.ts never writes it) → delivered
//   was always 0 → undelivered = originalQty forever → FG closing = every
//   batch ever completed (~RM 1,355,189).
//
//   The correct as-of-date relief signal is the `cost_ledger` FG_DELIVERED
//   rows emitted by `consumeFGBatchesForDO` (do-cost-cascade.ts) on every
//   DO → DELIVERED transition: each carries (date, qty, batchId) where `qty`
//   is the SAME quantity decremented from `fg_batches.remainingQty`, so it is
//   in the SAME unit as `originalQty` BY CONSTRUCTION — regardless of whether
//   originalQty is a unit count or a piece count.  See accounting.ts.
//
// Money is integer sen; quantities are exact counts. The per-batch product
// (undelivered × unit_cost_sen) is rounded once.
// ---------------------------------------------------------------------------

/** One FG_DELIVERED relief event: a quantity delivered out of a batch on a date. */
export type FgDeliveredRow = {
  /** fg_batches.id this relief applies to (cost_ledger.batchId). */
  batchId: string | null;
  /** Delivery date (cost_ledger.date); only the YYYY-MM-DD prefix is used. */
  date: string | null;
  /** Quantity relieved — same unit as fg_batches.originalQty. */
  qty: number | null;
};

/** An FG batch row needed to value undelivered closing stock. */
export type FgBatchRow = {
  id: string;
  productionOrderId: string | null;
  completedDate: string | null;
  originalQty: number | null;
  /**
   * Cascade-maintained per-unit cost (sen) of THIS batch — the figure
   * `backfillFGBatchCost` writes as `floor((ΣRM_ISSUE + ΣLABOR) / originalQty)`
   * for the batch's own PO. This is the authoritative, sane per-unit value
   * (it is what the rest of the ERP — stock pages, FG_COMPLETED ledger — uses),
   * and it is in the SAME unit as `originalQty`/`remainingQty` (piece-level).
   * Closing stock is valued from this directly; see {@link fgClosingSen}.
   */
  unitCostSen: number | null;
};

/**
 * Build an as-of-date delivered-quantity accessor from FG_DELIVERED rows.
 *
 * Returns `deliveredAsOf(batchId, dIso)` = Σ qty of FG_DELIVERED rows for that
 * batch whose date ≤ dIso. Rows with a null/empty batchId or non-positive qty
 * are ignored. Dates are compared on their YYYY-MM-DD prefix (ISO-sortable).
 */
export function buildDeliveredAsOf(
  rows: Iterable<FgDeliveredRow>,
): (batchId: string, dIso: string) => number {
  const byBatch = new Map<string, { date: string; qty: number }[]>();
  for (const r of rows) {
    if (!r.batchId) continue;
    const date = (r.date ?? "").slice(0, 10);
    if (!date) continue;
    const qty = Number(r.qty) || 0;
    if (qty <= 0) continue;
    let arr = byBatch.get(r.batchId);
    if (!arr) {
      arr = [];
      byBatch.set(r.batchId, arr);
    }
    arr.push({ date, qty });
  }
  return (batchId: string, dIso: string): number => {
    const arr = byBatch.get(batchId);
    if (!arr) return 0;
    let q = 0;
    for (const e of arr) if (e.date <= dIso) q += e.qty;
    return q;
  };
}

/**
 * Closing finished-goods stock value (integer sen) as of `asOfIso`.
 *
 * For each batch completed on/before `asOfIso`, values the still-undelivered
 * quantity at the batch's cascade-maintained per-unit cost
 * (`fg_batches.unit_cost_sen`):  Σ undelivered(batch, D) × unitCostSen(batch).
 *
 * WHY stored unit cost, not a re-valuation:  the previous implementation
 * re-derived the unit cost as (FIFO material@completion + labour@completion) /
 * originalQty via a per-PO resolver.  On live prod that re-valuation came out
 * ~15× too high (post-opening FG closing RM 595k vs the real RM 39k =
 * Σ remaining_qty × unit_cost_sen), because the FIFO replay's per-layer costs
 * for a PO's issues did not reconcile to the material actually booked to that PO
 * (RM_ISSUE.total_cost_sen) — a layer-pricing discrepancy in the replay, not an
 * attribution bug, so it inflated EVERY batch.  `fg_batches.unit_cost_sen` is the
 * figure `backfillFGBatchCost` rolls up from the same RM_ISSUE+LABOR rows and is
 * what every other FG surface in the ERP uses; it is sane and authoritative.  It
 * is in the SAME unit as originalQty/remainingQty (piece-level) by construction.
 *
 * `deliveredAsOf` supplies the relief quantity (see {@link buildDeliveredAsOf}).
 * undelivered is clamped at 0 so an over-relieved batch never goes negative.
 */
export function fgClosingSen(args: {
  batches: Iterable<FgBatchRow>;
  asOfIso: string;
  deliveredAsOf: (batchId: string, dIso: string) => number;
  /**
   * Opening-date floor (YYYY-MM-DD) or null. Batches completed BEFORE this are
   * pre-opening finished goods — they belong to the seeded opening inventory,
   * NOT the system's batch-by-batch computation, so they are excluded here.
   * Without this floor every historical batch ever completed accumulates
   * (the legacy FG over-statement, ~RM 1.35M). Null = no floor (count all).
   */
  openingIso?: string | null;
}): number {
  const { batches, asOfIso, deliveredAsOf, openingIso } = args;
  let s = 0;
  for (const b of batches) {
    const completed = (b.completedDate ?? "").slice(0, 10);
    if (!completed || completed > asOfIso) continue; // not completed by D
    if (openingIso && completed < openingIso) continue; // pre-opening → seeded, not computed
    const origQty = Number(b.originalQty) || 0;
    if (origQty <= 0) continue;
    const undelivered = origQty - deliveredAsOf(b.id, asOfIso);
    if (undelivered <= 0) continue; // fully shipped by D
    // Cascade-maintained per-unit cost (sen), same unit as undelivered.
    const unitCostSen = Number(b.unitCostSen) || 0;
    if (unitCostSen <= 0) continue; // cost not yet rolled up → contributes 0
    s += Math.round(undelivered * unitCostSen);
  }
  return s;
}
