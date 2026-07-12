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

    // Resolve productId by product code. fg_batches keys on productId.
    // NOTE: the products table column is `code`, NOT `productCode`.
    // Using `productCode` here made the SupabaseAdapter rename map
    // rewrite it to `product_code` (its global mapping), and
    // `products` has no such column → "column product_code does not
    // exist", failing every DO → DELIVERED cascade. Mirrors the
    // working sibling query in lib/fg-completion.ts:77.
    const product = await db
      .prepare("SELECT id FROM products WHERE code = ? LIMIT 1")
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

// ---------------------------------------------------------------------------
// REVERSE — when goods come back on a Delivery Return, undo the COGS + FG
// consumption for the returned lines. For each returned line we find the
// original FG_DELIVERED slices for its DO + product, add the returned qty back
// to those fg_batches (LIFO across the slices), and write a reversing
// ADJUSTMENT (direction IN) cost_ledger row per slice — refType='DELIVERY_RETURN'
// so it's idempotent + traceable. Net effect: FG inventory qty + value restored,
// COGS reduced. Returns statements to append to the caller's batch.
// ---------------------------------------------------------------------------
export type DeliveryReturnLineForCogs = {
  productCode: string | null;
  quantity: number;
};
export async function reverseFGForDeliveryReturn(
  db: D1Database,
  drId: string,
  doId: string,
  lines: DeliveryReturnLineForCogs[],
  reversedAtIso: string,
): Promise<{ skipped: boolean; statements: D1PreparedStatement[]; reversedCogsSen: number }> {
  // Idempotency — already reversed for this Delivery Return?
  const existing = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM cost_ledger WHERE refType = 'DELIVERY_RETURN' AND refId = ?",
    )
    .bind(drId)
    .first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) {
    return { skipped: true, statements: [], reversedCogsSen: 0 };
  }

  const statements: D1PreparedStatement[] = [];
  let reversedCogsSen = 0;

  for (const line of lines) {
    let toReverse = Number(line.quantity) || 0;
    if (toReverse <= 0) continue;
    const productCode = line.productCode ?? "";
    if (!productCode) continue;
    const product = await db
      .prepare("SELECT id FROM products WHERE code = ? LIMIT 1")
      .bind(productCode)
      .first<{ id: string }>();
    if (!product) continue;

    // The FG_DELIVERED slices this DO consumed for this product (newest first
    // so a return unwinds the most recent consumption).
    const slicesRes = await db
      .prepare(
        `SELECT batchId AS "batchId", qty AS "qty", unitCostSen AS "unitCostSen"
           FROM cost_ledger
          WHERE refType = 'DELIVERY_ORDER' AND refId = ? AND type = 'FG_DELIVERED'
            AND itemId = ?
          ORDER BY date DESC, id DESC`,
      )
      .bind(doId, product.id)
      .all<{ batchId: string; qty: number; unitCostSen: number }>();

    for (const s of slicesRes.results ?? []) {
      if (toReverse <= 0) break;
      const take = Math.min(Number(s.qty) || 0, toReverse);
      if (take <= 0) continue;
      const unitSen = Number(s.unitCostSen) || 0;
      const costSen = Math.round(unitSen * take);
      reversedCogsSen += costSen;
      toReverse -= take;
      statements.push(
        db
          .prepare("UPDATE fg_batches SET remainingQty = remainingQty + ? WHERE id = ?")
          .bind(take, s.batchId),
        db
          .prepare(
            `INSERT INTO cost_ledger
               (id, date, type, itemType, itemId, batchId, qty, direction,
                unitCostSen, totalCostSen, refType, refId, notes)
             VALUES (?, ?, 'ADJUSTMENT', 'FG', ?, ?, ?, 'IN', ?, ?, 'DELIVERY_RETURN', ?, ?)`,
          )
          .bind(
            genLedgerId("fgr"),
            reversedAtIso,
            product.id,
            s.batchId,
            take,
            unitSen,
            costSen,
            drId,
            `FG returned via ${drId} (${productCode})`,
          ),
      );
    }
  }

  return { skipped: false, statements, reversedCogsSen };
}
