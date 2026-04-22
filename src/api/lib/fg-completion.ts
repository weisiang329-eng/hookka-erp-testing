// ---------------------------------------------------------------------------
// fg-completion.ts — cascade helper invoked when a Production Order reaches
// COMPLETED status. Generates the per-piece FGUnit stickers (idempotent) and
// records a single fg_batches row keyed by (productionOrderId, productId).
//
// Cost fields (unitCostSen / materialCostSen / laborCostSen / overheadCostSen)
// are written as 0 for now — Track F will populate them when the cost_ledger
// cascade lands (FIFO RM consume + LABOR_POSTED + FG_COMPLETED ledger entries).
//
// Idempotency: delegates to generateFGUnitsForPO() for the fg_units side, and
// checks fg_batches by productionOrderId before inserting. Calling this
// helper multiple times for the same PO is a no-op after the first success.
// ---------------------------------------------------------------------------
import { generateFGUnitsForPO } from "../routes-d1/fg-units";

export async function postProductionOrderCompletion(
  db: D1Database,
  poId: string,
): Promise<{ fgUnitsGenerated: boolean; fgBatchCreated: boolean }> {
  const fgResult = await generateFGUnitsForPO(db, poId);
  if (fgResult.status === "not-found" || !fgResult.po) {
    return { fgUnitsGenerated: false, fgBatchCreated: false };
  }

  const po = fgResult.po;
  const quantity = fgResult.units.length;
  if (quantity <= 0) {
    return { fgUnitsGenerated: fgResult.generated, fgBatchCreated: false };
  }

  // Idempotency: fg_batches row-per-PO — never duplicate.
  const existingBatch = await db
    .prepare(
      "SELECT id FROM fg_batches WHERE productionOrderId = ? LIMIT 1",
    )
    .bind(poId)
    .first<{ id: string }>();
  if (existingBatch) {
    return { fgUnitsGenerated: fgResult.generated, fgBatchCreated: false };
  }

  // Resolve productId — prefer PO.productId, fall back to products.code lookup.
  let productId = po.productId ?? null;
  if (!productId && po.productCode) {
    const p = await db
      .prepare("SELECT id FROM products WHERE code = ? LIMIT 1")
      .bind(po.productCode)
      .first<{ id: string }>();
    productId = p?.id ?? null;
  }
  if (!productId) {
    // No product to key the batch on — skip rather than write garbage.
    return { fgUnitsGenerated: fgResult.generated, fgBatchCreated: false };
  }

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

  return { fgUnitsGenerated: fgResult.generated, fgBatchCreated: true };
}
