// ---------------------------------------------------------------------------
// Cascade lock helpers — prevent upstream document edits when a downstream
// document already exists.
//
// User's model (per audit 2026-04-28):
//
//   Invoice exists                → lock DO
//   DO exists (any status)         → lock PO
//   ANY PO has status='COMPLETED'  → lock SO
//
// Editing an upstream entity therefore requires REVERSE-unlocking — first
// delete/cancel the downstream document(s), then the upstream becomes
// editable again.
//
// The same cascade applies on the consignment side (parallel pipeline):
//   Invoice exists                 → lock CN (Consignment Note)
//   CN exists                      → lock PO  [shared production_orders table;
//                                              CN references PO via SO/CO id]
//   ANY PO has status='COMPLETED'  → lock CO
//
// Why query-based and not a `locked_at` column:
//   * No schema migration needed — purely derived from existing FKs/status.
//   * Self-healing: delete the downstream doc, the lock goes away.
//   * No "lock got stamped at the wrong time" foot-guns.
//
// Each helper returns a string error message if the entity is locked, or
// null if it is editable. Routes use the message in their 403 response so
// the frontend can render a clear "delete the invoice first" hint.
// ---------------------------------------------------------------------------

/**
 * Check whether a Sales Order is locked because any of its production
 * orders have reached COMPLETED status.
 *
 * Returns null if the SO is still editable, or an error string if locked.
 */
export async function checkSalesOrderLocked(
  db: D1Database,
  salesOrderId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT poNo FROM production_orders
         WHERE salesOrderId = ? AND status = 'COMPLETED' LIMIT 1`,
    )
    .bind(salesOrderId)
    .first<{ poNo: string }>();
  if (row) {
    return `Cannot edit Sales Order — Production Order ${row.poNo} is already COMPLETED. Cancel the production order first to unlock the SO.`;
  }
  return null;
}

/**
 * Consignment Order lock — TWO triggers:
 *   1. Any of its production orders has reached COMPLETED.
 *   2. A Consignment Note has been created against the parent customer
 *      (parallel to "DO created → SO locks" on the SO side; CN is the
 *      shipment doc for CO).
 *
 * NOTE: The CN check below uses the legacy `consignment_notes` table by
 * customerId because there is no consignment_notes.consignmentOrderId FK
 * yet (PR 5 will add it when the proper CN shipment shape lands). For
 * now the customerId proxy is conservative — it locks the CO if ANY CN
 * exists for the same customer, which is the safer error.
 */
export async function checkConsignmentOrderLocked(
  db: D1Database,
  consignmentOrderId: string,
): Promise<string | null> {
  // 1. PO COMPLETED check
  const poRow = await db
    .prepare(
      `SELECT poNo FROM production_orders
         WHERE consignmentOrderId = ? AND status = 'COMPLETED' LIMIT 1`,
    )
    .bind(consignmentOrderId)
    .first<{ poNo: string }>();
  if (poRow) {
    return `Cannot edit Consignment Order — Production Order ${poRow.poNo} is already COMPLETED. Cancel the production order first to unlock the CO.`;
  }

  // 2. CN exists check (proxy via customerId until PR 5 adds the FK).
  const cnRow = await db
    .prepare(
      `SELECT noteNumber FROM consignment_notes WHERE customerId IN
         (SELECT customerId FROM consignment_orders WHERE id = ?) LIMIT 1`,
    )
    .bind(consignmentOrderId)
    .first<{ noteNumber: string }>();
  if (cnRow) {
    return `Cannot edit Consignment Order — Consignment Note ${cnRow.noteNumber} already exists. Delete the CN first to unlock the CO.`;
  }
  return null;
}

/**
 * Check whether a Production Order is locked because at least one delivery
 * order references its parent SO (or CO). Once goods are scheduled to ship,
 * the PO's identity (quantity, product code, due date) must not change.
 *
 * The current schema links DO → SO (delivery_orders.salesOrderId). If your
 * shipment side later supports DO → multiple POs, swap this check to a
 * delivery_order_items lookup.
 */
export async function checkProductionOrderLocked(
  db: D1Database,
  productionOrderId: string,
): Promise<string | null> {
  // Resolve the source order (SO or CO) that owns this PO.
  const po = await db
    .prepare(
      `SELECT salesOrderId, consignmentOrderId FROM production_orders
         WHERE id = ?`,
    )
    .bind(productionOrderId)
    .first<{ salesOrderId: string | null; consignmentOrderId: string | null }>();
  if (!po) return null;

  // Check delivery_orders for the SO side.
  if (po.salesOrderId) {
    const doRow = await db
      .prepare(
        `SELECT doNo FROM delivery_orders WHERE salesOrderId = ? LIMIT 1`,
      )
      .bind(po.salesOrderId)
      .first<{ doNo: string }>();
    if (doRow) {
      return `Cannot edit Production Order — Delivery Order ${doRow.doNo} already exists for the parent Sales Order. Delete or cancel the DO first to unlock the PO.`;
    }
  }
  // Check consignment_notes for the CO side (legacy table for now —
  // will be repurposed as the proper CN shipment table in PR 5).
  if (po.consignmentOrderId) {
    const cnRow = await db
      .prepare(
        `SELECT noteNumber FROM consignment_notes WHERE customerId IN
           (SELECT customerId FROM consignment_orders WHERE id = ?) LIMIT 1`,
      )
      .bind(po.consignmentOrderId)
      .first<{ noteNumber: string }>();
    if (cnRow) {
      return `Cannot edit Production Order — Consignment Note ${cnRow.noteNumber} already exists for the parent Consignment Order. Delete the CN first to unlock the PO.`;
    }
  }
  return null;
}

/**
 * Check whether a Delivery Order is locked because an Invoice references
 * it. Once the invoice is issued the DO line items / quantities must not
 * change — they're already on the customer's bill.
 */
export async function checkDeliveryOrderLocked(
  db: D1Database,
  deliveryOrderId: string,
): Promise<string | null> {
  const inv = await db
    .prepare(
      `SELECT invoiceNo FROM invoices WHERE deliveryOrderId = ? LIMIT 1`,
    )
    .bind(deliveryOrderId)
    .first<{ invoiceNo: string }>();
  if (inv) {
    return `Cannot edit Delivery Order — Invoice ${inv.invoiceNo} has been issued against it. Delete or void the invoice first to unlock the DO.`;
  }
  return null;
}

/**
 * Check whether an Invoice is locked because a payment has been recorded
 * against it. Paid invoices have GL entries — edits would orphan the
 * accounting trail. Reversals must go through credit notes, not edits.
 */
export async function checkInvoiceLocked(
  db: D1Database,
  invoiceId: string,
): Promise<string | null> {
  const inv = await db
    .prepare(
      `SELECT invoiceNo, status, paidAmountSen FROM invoices WHERE id = ?`,
    )
    .bind(invoiceId)
    .first<{ invoiceNo: string; status: string; paidAmountSen: number }>();
  if (!inv) return null;
  if (inv.status === "PAID" || (inv.paidAmountSen ?? 0) > 0) {
    return `Cannot edit Invoice ${inv.invoiceNo} — a payment has been recorded. Issue a credit note instead.`;
  }
  return null;
}

/**
 * Customer delete guard — blocks the delete if the customer is referenced
 * by any non-cancelled order/note/invoice. Counts across SO, CO, DO, CN,
 * and Invoice in a single round trip. Returns null if the customer is
 * safe to delete.
 */
export async function checkCustomerDeleteLocked(
  db: D1Database,
  customerId: string,
): Promise<string | null> {
  const refs = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sales_orders WHERE customerId = ? AND status NOT IN ('CANCELLED','CLOSED')) AS so,
         (SELECT COUNT(*) FROM consignment_orders WHERE customerId = ? AND status NOT IN ('CANCELLED','CLOSED')) AS co,
         (SELECT COUNT(*) FROM delivery_orders WHERE customerId = ? AND status NOT IN ('CANCELLED')) AS do_,
         (SELECT COUNT(*) FROM invoices WHERE customerId = ? AND status NOT IN ('CANCELLED')) AS inv,
         (SELECT COUNT(*) FROM consignment_notes WHERE customerId = ?) AS cn`,
    )
    .bind(customerId, customerId, customerId, customerId, customerId)
    .first<{ so: number; co: number; do_: number; inv: number; cn: number }>();
  const counts = refs ?? { so: 0, co: 0, do_: 0, inv: 0, cn: 0 };
  const parts: string[] = [];
  if (counts.so) parts.push(`${counts.so} sales order(s)`);
  if (counts.co) parts.push(`${counts.co} consignment order(s)`);
  if (counts.do_) parts.push(`${counts.do_} delivery order(s)`);
  if (counts.cn) parts.push(`${counts.cn} consignment note(s)`);
  if (counts.inv) parts.push(`${counts.inv} invoice(s)`);
  if (parts.length === 0) return null;
  return `Cannot delete customer — still referenced by ${parts.join(", ")}. Cancel or close those documents first.`;
}

/**
 * Product delete guard — blocks the soft-delete (status=INACTIVE flip) if
 * the product is currently referenced by any non-cancelled SO/CO line, any
 * active production order, or any active BOM template. Soft-delete is
 * already non-destructive (the row stays), but operators want to know
 * BEFORE the flip whether the product is in use.
 */
export async function checkProductDeleteLocked(
  db: D1Database,
  productId: string,
  productCode: string,
): Promise<string | null> {
  const refs = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sales_order_items soi
            JOIN sales_orders so ON so.id = soi.salesOrderId
            WHERE soi.productId = ? AND so.status NOT IN ('CANCELLED','CLOSED')) AS so,
         (SELECT COUNT(*) FROM consignment_order_items coi
            JOIN consignment_orders co ON co.id = coi.consignmentOrderId
            WHERE coi.productId = ? AND co.status NOT IN ('CANCELLED','CLOSED')) AS co,
         (SELECT COUNT(*) FROM production_orders WHERE productId = ?
            AND status NOT IN ('CANCELLED','COMPLETED')) AS po,
         (SELECT COUNT(*) FROM bom_templates WHERE productCode = ?
            AND versionStatus = 'ACTIVE') AS bom`,
    )
    .bind(productId, productId, productId, productCode)
    .first<{ so: number; co: number; po: number; bom: number }>();
  const counts = refs ?? { so: 0, co: 0, po: 0, bom: 0 };
  const parts: string[] = [];
  if (counts.so) parts.push(`${counts.so} active SO line(s)`);
  if (counts.co) parts.push(`${counts.co} active CO line(s)`);
  if (counts.po) parts.push(`${counts.po} active production order(s)`);
  if (counts.bom) parts.push(`${counts.bom} active BOM template(s)`);
  if (parts.length === 0) return null;
  return `Cannot delete product ${productCode} — still referenced by ${parts.join(", ")}. Resolve those references first.`;
}

/**
 * Raw Material delete guard — blocks the delete if the material is
 * referenced by any active BOM component or any pending purchase order.
 * Fabrics also check sales_order_items.fabricCode (the existing fabric
 * guard, kept inline in raw-materials.ts; this helper covers the
 * non-fabric case + structural BOM/PO refs).
 */
export async function checkRawMaterialDeleteLocked(
  db: D1Database,
  itemCode: string,
): Promise<string | null> {
  const refs = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM bom_components bc
            JOIN bom_templates bt ON bt.id = bc.bomTemplateId
            WHERE bc.materialCode = ?
              AND bt.versionStatus IN ('ACTIVE','DRAFT')) AS bom,
         (SELECT COUNT(*) FROM purchase_order_items
            WHERE materialCode = ?) AS po,
         (SELECT COUNT(*) FROM rm_batches WHERE itemCode = ?) AS batches`,
    )
    .bind(itemCode, itemCode, itemCode)
    .first<{ bom: number; po: number; batches: number }>();
  const counts = refs ?? { bom: 0, po: 0, batches: 0 };
  const parts: string[] = [];
  if (counts.bom) parts.push(`${counts.bom} BOM component(s)`);
  if (counts.po) parts.push(`${counts.po} purchase order line(s)`);
  if (counts.batches)
    parts.push(`${counts.batches} batch(es) on hand (delete those first)`);
  if (parts.length === 0) return null;
  return `Cannot delete raw material ${itemCode} — still referenced by ${parts.join(", ")}. Remove those references first.`;
}

/**
 * Standardised JSON response for a 403 lock denial. Each route returns this
 * with the message from one of the helpers above. Keeping the shape identical
 * to other error responses so the frontend can render the same toast / banner.
 */
export function lockedResponse(message: string): {
  success: false;
  error: string;
  locked: true;
} {
  return { success: false, error: message, locked: true };
}
