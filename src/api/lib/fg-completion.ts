// ---------------------------------------------------------------------------
// fg-completion.ts — cascade helper invoked when a Production Order reaches
// COMPLETED status. Generates the per-piece FGUnit stickers (idempotent),
// records a single fg_batches row keyed by (productionOrderId, productId),
// and drives the cost cascade (RM FIFO consume, FG cost backfill, WIP marker).
//
// Cost cascade (Track F) sequence, AFTER fg_batches is written:
//   1. consumeRawMaterialsForPO  — FIFO rm_batches; emit RM_ISSUE ledger
//      entries; decrement raw_materials.balanceQty.
//   2. backfillFGBatchCost       — sum RM_ISSUE + LABOR_POSTED for the PO,
//      update fg_batches.{unit|material|labor}CostSen, emit FG_COMPLETED.
//   3. postWIPCompletionMarker   — light ADJUSTMENT marker (WIP phase-2 TODO).
//
// Labor posting (LABOR_POSTED) happens upstream per job-card flip —
// postJobCardLabor() is called from production-orders.ts whenever a job_card
// transitions to COMPLETED/TRANSFERRED, so by the time backfillFGBatchCost
// runs, all LABOR_POSTED rows for the PO's job cards are already on the
// ledger.
//
// Idempotency: each helper guards against duplicate emission — generateFG
// checks fg_units, fg_batches is guarded by productionOrderId,
// consumeRawMaterialsForPO checks cost_ledger for RM_ISSUE rows, and
// backfillFGBatchCost checks for an FG_COMPLETED row. Calling this helper
// repeatedly for the same PO is a no-op after the first success.
// ---------------------------------------------------------------------------
import { generateFGUnitsForPO } from "../routes/fg-units";
import { applyPackingRack } from "./packing-rack-write";
import {
  backfillFGBatchCost,
  consumeRawMaterialsForPO,
  postWIPCompletionMarker,
} from "./po-cost-cascade";

// Default packing → Floor (owner 2026-07-11): once a PO is fully produced,
// every PACKING card that hasn't been assigned a rack lands on the "Floor"
// staging location by default so the packed goods appear in the warehouse
// straight away; the operator reassigns to a specific rack afterward. Runs
// through applyPackingRack (the ONE validated + idempotent rack writer) so the
// rack_items occupancy mirror is written exactly like a manual pick. Only
// touches cards whose rackingNumber is still blank, so it NEVER overrides a
// manual pick (or a Floor default already applied) and is safe to replay with
// postProductionOrderCompletion. Best-effort: a warehouse hiccup must never
// block the completion cascade.
async function defaultUnrackedPackingCardsToFloor(
  db: D1Database,
  poId: string,
): Promise<void> {
  try {
    const floor = await db
      .prepare("SELECT rack FROM rack_locations WHERE LOWER(rack) = 'floor' LIMIT 1")
      .first<{ rack: string }>();
    if (!floor?.rack) return; // no Floor location configured → nothing to default to
    const unracked = await db
      .prepare(
        `SELECT id FROM job_cards
           WHERE productionOrderId = ? AND departmentCode = 'PACKING'
             AND (rackingNumber IS NULL OR rackingNumber = '')`,
      )
      .bind(poId)
      .all<{ id: string }>();
    for (const card of unracked.results ?? []) {
      try {
        await applyPackingRack(db, card.id, floor.rack);
      } catch (e) {
        console.warn(
          "[postProductionOrderCompletion] Floor default skipped for card",
          card.id,
          e,
        );
      }
    }
  } catch (e) {
    console.warn("[postProductionOrderCompletion] Floor default step skipped", e);
  }
}

export async function postProductionOrderCompletion(
  db: D1Database,
  poId: string,
): Promise<{
  fgUnitsGenerated: boolean;
  fgBatchCreated: boolean;
  rmConsumed: boolean;
  fgCostBackfilled: boolean;
}> {
  const fgResult = await generateFGUnitsForPO(db, poId);
  if (fgResult.status === "not-found" || !fgResult.po) {
    return {
      fgUnitsGenerated: false,
      fgBatchCreated: false,
      rmConsumed: false,
      fgCostBackfilled: false,
    };
  }

  const po = fgResult.po;
  const quantity = fgResult.units.length;
  if (quantity <= 0) {
    return {
      fgUnitsGenerated: fgResult.generated,
      fgBatchCreated: false,
      rmConsumed: false,
      fgCostBackfilled: false,
    };
  }

  // Idempotency: fg_batches row-per-PO — never duplicate.
  const existingBatch = await db
    .prepare(
      "SELECT id FROM fg_batches WHERE productionOrderId = ? LIMIT 1",
    )
    .bind(poId)
    .first<{ id: string }>();

  let fgBatchCreated = false;
  if (!existingBatch) {
    // Resolve productId — prefer PO.productId, fall back to products.code lookup.
    let productId = po.productId ?? null;
    if (!productId && po.productCode) {
      const p = await db
        .prepare("SELECT id FROM products WHERE code = ? LIMIT 1")
        .bind(po.productCode)
        .first<{ id: string }>();
      productId = p?.id ?? null;
    }
    if (productId) {
      const now = new Date().toISOString();
      const completedDate = po.completedDate || now.split("T")[0];

      // batchNo format: FGB-<YYMMDD>-<NN> — NN is a count of same-day batches
      // (monotonic per calendar date). The row id embeds the batchNo for
      // traceability even though the schema doesn't have a batchNo column.
      const yymmdd = completedDate.replace(/-/g, "").slice(2); // YYYY-MM-DD → YYMMDD
      const sameDayCountRow = await db
        .prepare(
          "SELECT COUNT(*) AS n FROM fg_batches WHERE substr(completedDate,1,10) = ?",
        )
        .bind(completedDate)
        .first<{ n: number }>();
      const nn = String((sameDayCountRow?.n ?? 0) + 1).padStart(2, "0");
      const batchNo = `FGB-${yymmdd}-${nn}`;
      const batchId = `${batchNo}-${crypto.randomUUID().slice(0, 6)}`;

      await db
        .prepare(
          `INSERT INTO fg_batches
             (id, productId, productionOrderId, completedDate, originalQty,
              remainingQty, unitCostSen, materialCostSen, laborCostSen,
              overheadCostSen, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?)`,
        )
        .bind(batchId, productId, poId, completedDate, quantity, quantity, now)
        .run();
      fgBatchCreated = true;
    }
  }

  // ---- Track F cost cascade --------------------------------------------
  // Run even when fg_batches already existed so a replay after a failed
  // cascade can still fill in missing ledger entries. Each helper is
  // independently idempotent via its own guard on cost_ledger rows.
  //
  // F1 trigger moved 2026-05-07: consumeRawMaterialsForPO now also fires
  // at FAB_CUT JC completion (see production-orders.ts applyPoUpdate).
  // Calling it again here at PO completion is a no-op when an RM_ISSUE
  // row already exists (idempotent on refType='PRODUCTION_ORDER'). The
  // PO-completion call is kept as a safety net: if a PO somehow reaches
  // COMPLETED without any FAB_CUT JC having completed first (legacy /
  // accessory products without an FC step in their BOM, or imported
  // historical POs), the PO-level call still consumes correctly.
  const rmResult = await consumeRawMaterialsForPO(db, poId);
  const fgCostResult = await backfillFGBatchCost(db, poId);
  // Light WIP marker — full tracking is TODO(wip-phase-2).
  await postWIPCompletionMarker(db, poId, quantity);

  // Default any still-unracked PACKING cards to the Floor staging location so
  // the freshly packed goods show in the warehouse without a manual rack pick.
  await defaultUnrackedPackingCardsToFloor(db, poId);

  return {
    fgUnitsGenerated: fgResult.generated,
    fgBatchCreated,
    rmConsumed: !rmResult.skipped && rmResult.linesConsumed > 0,
    fgCostBackfilled: !fgCostResult.skipped,
  };
}
