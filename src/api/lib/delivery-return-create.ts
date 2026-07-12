// ---------------------------------------------------------------------------
// Shared Delivery Return creation.
//
// One place that writes a DR header + item snapshot, used by BOTH:
//   • the office route (routes/delivery-returns.ts — "New return" /
//     "Convert to Delivery Return"), and
//   • the public driver scan (routes/public-do-qr.ts — "Not received →
//     Delivery Return", where the whole DO's goods come back).
//
// Keeping it here means both paths produce an identical record and the DR
// numbering / snapshot logic never drifts between them. Deploy does NOT replay
// migration files, so the tables are self-applied at runtime here as well (see
// migrations-postgres/0207_delivery_returns.sql for the record copy).
// ---------------------------------------------------------------------------

export type DRCreateItem = {
  productionOrderId?: string;
  poNo?: string;
  productCode?: string;
  productName?: string;
  wipLabel?: string;
  quantity?: number;
  problem?: string;
  fgUnitId?: string;
  wasInvoiced?: boolean;
};

let tablesEnsured = false;
export async function ensureDeliveryReturnTables(
  db: D1Database,
): Promise<void> {
  if (tablesEnsured) return;
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS delivery_returns (
           id TEXT PRIMARY KEY, return_no TEXT NOT NULL,
           delivery_order_id TEXT, do_no TEXT, sales_order_id TEXT, company_so_id TEXT,
           customer_id TEXT, customer_name TEXT, customer_po_id TEXT,
           return_type TEXT, status TEXT NOT NULL DEFAULT 'OPEN',
           service_case_id TEXT, service_order_id TEXT, credit_note_id TEXT,
           reason TEXT, notes TEXT, returned_at TEXT,
           created_at TEXT, updated_at TEXT, org_id TEXT )`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS delivery_return_items (
           id TEXT PRIMARY KEY, delivery_return_id TEXT NOT NULL,
           production_order_id TEXT, po_no TEXT, product_code TEXT, product_name TEXT,
           wip_label TEXT, quantity DOUBLE PRECISION NOT NULL DEFAULT 1,
           problem TEXT, disposition TEXT, fg_unit_id TEXT,
           was_invoiced INTEGER NOT NULL DEFAULT 0 )`,
      )
      .run();
    tablesEnsured = true;
  } catch (err) {
    console.warn(
      "[delivery-return-create] ensure tables:",
      err instanceof Error ? err.message : err,
    );
  }
}

export function genDeliveryReturnId(): string {
  return `dr-${crypto.randomUUID().slice(0, 8)}`;
}
function genItemId(): string {
  return `dri-${crypto.randomUUID().slice(0, 8)}`;
}

// DR-YYMM-NNN, sequential within the current year-month.
export async function nextReturnNo(db: D1Database): Promise<string> {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const prefix = `DR-${yy}${mm}-`;
  const row = await db
    .prepare(
      `SELECT return_no AS "returnNo" FROM delivery_returns
        WHERE return_no LIKE ? ORDER BY return_no DESC LIMIT 1`,
    )
    .bind(`${prefix}%`)
    .first<{ returnNo: string }>();
  let n = 1;
  if (row?.returnNo) {
    const tail = Number(row.returnNo.slice(prefix.length));
    if (Number.isFinite(tail)) n = tail + 1;
  }
  return `${prefix}${String(n).padStart(3, "0")}`;
}

// Load every line on a DO as a DR item — used when the WHOLE delivery comes
// back (driver "Not received"). No item picking; every good on the DO returns.
export async function loadDoItemsForReturn(
  db: D1Database,
  doId: string,
): Promise<DRCreateItem[]> {
  const res = await db
    .prepare(
      `SELECT productionOrderId AS "productionOrderId", poNo AS "poNo",
              productCode AS "productCode", productName AS "productName",
              quantity AS "quantity"
         FROM delivery_order_items WHERE deliveryOrderId = ?`,
    )
    .bind(doId)
    .all<{
      productionOrderId: string | null;
      poNo: string | null;
      productCode: string | null;
      productName: string | null;
      quantity: number | null;
    }>();
  return (res.results ?? []).map((r) => ({
    productionOrderId: r.productionOrderId ?? "",
    poNo: r.poNo ?? "",
    productCode: r.productCode ?? "",
    productName: r.productName ?? "",
    quantity: Number(r.quantity ?? 1),
  }));
}

// Create a Delivery Return document from a DO + a set of returned lines.
// Header (SO / customer) is snapshotted from the source DO. BOTH lookups are
// best-effort (a missing/renamed column or an un-rewritten JOIN alias must NOT
// fail the create — the DR header + items still get written). Returns the new
// DR id + number, or null on hard failure.
export async function createDeliveryReturnRecord(
  db: D1Database,
  orgId: string,
  input: {
    doId: string;
    items: DRCreateItem[];
    reason?: string;
    notes?: string;
  },
): Promise<{ id: string; returnNo: string } | null> {
  await ensureDeliveryReturnTables(db);
  const doId = String(input.doId ?? "").trim();
  const items = Array.isArray(input.items) ? input.items : [];
  if (!doId || items.length === 0) return null;

  try {
    let doNo = "";
    let customerName = "";
    const customerPOId = "";
    try {
      const doRow = await db
        .prepare(
          `SELECT doNo AS "doNo", customerName AS "customerName" FROM delivery_orders WHERE id = ?`,
        )
        .bind(doId)
        .first<{ doNo: string | null; customerName: string | null }>();
      doNo = doRow?.doNo ?? "";
      customerName = doRow?.customerName ?? "";
    } catch (e) {
      console.warn(
        "[delivery-return-create] DO snapshot failed:",
        e instanceof Error ? e.message : e,
      );
    }

    let salesOrderId = "";
    let companySOId = "";
    let customerId = "";
    const firstPo = items.find((it) => it.productionOrderId);
    if (firstPo?.productionOrderId) {
      try {
        const soRow = await db
          .prepare(
            `SELECT so.id AS "soId", so.companySOId AS "companySOId",
                    so.customerId AS "customerId"
               FROM production_orders po
               JOIN sales_orders so ON so.id = po.salesOrderId
              WHERE po.id = ? LIMIT 1`,
          )
          .bind(firstPo.productionOrderId)
          .first<{ soId: string; companySOId: string; customerId: string }>();
        if (soRow) {
          salesOrderId = soRow.soId ?? "";
          companySOId = soRow.companySOId ?? "";
          customerId = soRow.customerId ?? "";
        }
      } catch (e) {
        console.warn(
          "[delivery-return-create] SO resolve failed:",
          e instanceof Error ? e.message : e,
        );
      }
    }

    const id = genDeliveryReturnId();
    const returnNo = await nextReturnNo(db);
    const now = new Date().toISOString();

    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO delivery_returns
             (id, return_no, delivery_order_id, do_no, sales_order_id, company_so_id,
              customer_id, customer_name, customer_po_id, return_type, status,
              reason, notes, returned_at, created_at, updated_at, org_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'OPEN', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          returnNo,
          doId,
          doNo,
          salesOrderId,
          companySOId,
          customerId,
          customerName,
          customerPOId,
          String(input.reason ?? ""),
          String(input.notes ?? ""),
          now,
          now,
          now,
          orgId,
        ),
    ];
    for (const it of items) {
      statements.push(
        db
          .prepare(
            `INSERT INTO delivery_return_items
               (id, delivery_return_id, production_order_id, po_no, product_code,
                product_name, wip_label, quantity, problem, disposition, fg_unit_id, was_invoiced)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .bind(
            genItemId(),
            id,
            String(it.productionOrderId ?? ""),
            String(it.poNo ?? ""),
            String(it.productCode ?? ""),
            String(it.productName ?? ""),
            String(it.wipLabel ?? ""),
            Number(it.quantity ?? 1),
            String(it.problem ?? ""),
            String(it.fgUnitId ?? ""),
            it.wasInvoiced ? 1 : 0,
          ),
      );
    }
    await db.batch(statements);
    return { id, returnNo };
  } catch (err) {
    console.error("[delivery-return-create] create failed:", err);
    return null;
  }
}
