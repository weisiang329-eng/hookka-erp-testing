// ---------------------------------------------------------------------------
// do-cost-cascade.ts — Delivery Order cost cascade (phase-4).
//
// Mirrors po-cost-cascade.ts but for the DELIVERY side. When a DO moves to
// DELIVERED, we need to FIFO-consume fg_batches (oldest completedDate first)
// against each DO line item, deducting qty across layers and emitting one
// FG_DELIVERED cost_ledger entry per layer slice with unitCostSen × qtySlice
// as totalCostSen.
//
// SCHEMA NOTE
//   cost_ledger.type CHECK includes 'FG_DELIVERED'. refType for the per-slice
//   ledger rows is 'DELIVERY_ORDER', refId is the DO id. direction='OUT',
//   itemType='FG', itemId=fg_batches.productId, batchId=fg_batches.id.
//
// IDEMPOTENCY
//   Caller (or the helper itself) checks if any cost_ledger row exists with
//   refType='DELIVERY_ORDER' AND refId=<doId> AND type='FG_DELIVERED'. If yes,
//   the helper returns skipped=true and an empty statements list.
//
// RETURN SHAPE
//   { skipped, statements, totalCogsSen, shortages }
//     * statements: D1PreparedStatement[] to append to the existing DELIVERED
//       batch so everything rolls back together if the outer UPDATE fails.
//     * totalCogsSen: sum of every slice's totalCostSen (for observability).
//     * shortages: DO lines where we couldn't fully satisfy from fg_batches
//       (non-fatal — we consume what's available and log the rest).
// ---------------------------------------------------------------------------

type FgBatchRow = {
  id: string;
  productId: string;
  productionOrderId: string | null;
  completedDate: string;
  originalQty: number;
  remainingQty: number;
  unitCostSen: number;
};

export type DeliveryOrderItemForCogs = {
  id: string;
  productCode: string | null;
  productName: string | null;
  quantity: number;
};

export type FGDeliveredShortage = {
  itemId: string;
  productCode: string;
  shortageQty: number;
};

function genLedgerId(prefix: string): string {
  return `cl-${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Main entry point. Returns statements to append to the caller's existing
// batch — we don't call db.batch() ourselves so the outer DELIVERED flow
// (UPDATE delivery_orders + fg_units + SO cascade + auto-invoice) stays
// atomic.
// ---------------------------------------------------------------------------
export async function consumeFGBatchesForDO(
  db: D1Database,
  doId: string,
  doNo: string,
  items: DeliveryOrderItemForCogs[],
  deliveredAtIso: string,
): Promise<{
  skipped: boolean;
  statements: D1PreparedStatement[];
  totalCogsSen: number;
  shortages: FGDeliveredShortage[];
}> {
  // Idempotency — already emitted FG_DELIVERED for this DO?
  const existing = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM cost_ledger WHERE refType = 'DELIVERY_ORDER' AND refId = ? AND type = 'FG_DELIVERED'",
    )
    .bind(doId)
    .first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) {
    return { skipped: true, statements: [], totalCogsSen: 0, shortages: [] };
  }

  const statements: D1PreparedStatement[] = [];
  let totalCogsSen = 0;
  const shortages: FGDeliveredShortage[] = [];

  for (const item of items) {
    const need = Number(item.quantity) || 0;
    if (need <= 0) continue;
    const productCode = item.productCode ?? "";
    if (!productCode) {
      shortages.push({ itemId: item.id, productCode: "", shortageQty: need });
      continue;
    }

    // Resolve productId by productCode. fg_batches keys on productId.
    const product = await db
      .prepare("SELECT id FROM products WHERE productCode = ? LIMIT 1")
      .bind(productCode)
      .first<{ id: string }>();
    if (!product) {
      shortages.push({ itemId: item.id, productCode, shortageQty: need });
      continue;
    }

    // FIFO — oldest completedDate first, then oldest id as tiebreaker.
    const batchesRes = await db
      .prepare(
        `SELECT id, productId, productionOrderId, completedDate, originalQty,
                remainingQty, unitCostSen
           FROM fg_batches
          WHERE productId = ? AND remainingQty > 0
          ORDER BY completedDate ASC, id ASC`,
      )
      .bind(product.id)
      .all<FgBatchRow>();
    const batches = batchesRes.results ?? [];

    let remaining = need;
    for (const batch of batches) {
      if (remaining <= 0) break;
      const take = Math.min(batch.remainingQty, remaining);
      if (take <= 0) continue;
      const sliceCostSen = batch.unitCostSen * take;
      totalCogsSen += sliceCostSen;
      remaining -= take;

      statements.push(
        db
          .prepare(
            "UPDATE fg_batches SET remainingQty = remainingQty - ? WHERE id = ?",
          )
          .bind(take, batch.id),
        db
          .prepare(
            `INSERT INTO cost_ledger
               (id, date, type, itemType, itemId, batchId, qty, direction,
                unitCostSen, totalCostSen, refType, refId, notes)
             VALUES (?, ?, 'FG_DELIVERED', 'FG', ?, ?, ?, 'OUT', ?, ?, 'DELIVERY_ORDER', ?, ?)`,
          )
          .bind(
            genLedgerId("fgd"),
            deliveredAtIso,
            batch.productId,
            batch.id,
            take,
            batch.unitCostSen,
            sliceCostSen,
            doId,
            `FG delivered for ${doNo} (${productCode})`,
          ),
      );
    }

    if (remaining > 0) {
      shortages.push({
        itemId: item.id,
        productCode,
        shortageQty: remaining,
      });
    }
  }

  return { skipped: false, statements, totalCogsSen, shortages };
}
