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
  // Rich snapshot so the DR (and the SV order it spawns) carries the SAME detail
  // as the source DO/SO — spec / variant / fabric / size + the SO reference.
  fabricCode?: string;
  sizeLabel?: string;
  specialOrder?: string;
  salesOrderNo?: string;
  /** The line's own SO refs — a DO can span several SOs, so the DO header's
   *  single customer PO can't identify a line (owner 2026-07-16). */
  customerPO?: string;
  reference?: string;
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
           was_invoiced INTEGER NOT NULL DEFAULT 0,
           fabric_code TEXT, size_label TEXT, special_order TEXT, sales_order_no TEXT,
           customer_po TEXT, reference TEXT )`,
      )
      .run();
    // Rich-snapshot columns for tables created before the enrichment (runtime
    // self-apply; deploy does not replay migration files).
    for (const col of [
      "fabric_code TEXT",
      "size_label TEXT",
      "special_order TEXT",
      "sales_order_no TEXT",
      // Owner 2026-07-16: two identical lines (e.g. the same bedframe twice)
      // are indistinguishable without their order refs — carry the SO's
      // customer PO + Reference per line, not just the DO header's single one.
      "customer_po TEXT",
      "reference TEXT",
    ]) {
      try {
        await db
          .prepare(
            `ALTER TABLE delivery_return_items ADD COLUMN IF NOT EXISTS ${col}`,
          )
          .run();
      } catch {
        /* column already exists / DDL transiently rejected */
      }
    }
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

// Load a DO's lines as DR items. Pass `onlyProductionOrderIds` to keep just the
// ticked subset (driver "Delivered with Issue" → only the returned lines);
// omit it to take every line on the DO.
export async function loadDoItemsForReturn(
  db: D1Database,
  doId: string,
  onlyProductionOrderIds?: Set<string>,
): Promise<DRCreateItem[]> {
  const res = await db
    .prepare(
      `SELECT productionOrderId AS "productionOrderId", poNo AS "poNo",
              productCode AS "productCode", productName AS "productName",
              sizeLabel AS "sizeLabel", fabricCode AS "fabricCode",
              specialOrder AS "specialOrder", salesOrderNo AS "salesOrderNo",
              quantity AS "quantity"
         FROM delivery_order_items WHERE deliveryOrderId = ?`,
    )
    .bind(doId)
    .all<{
      productionOrderId: string | null;
      poNo: string | null;
      productCode: string | null;
      productName: string | null;
      sizeLabel: string | null;
      fabricCode: string | null;
      specialOrder: string | null;
      salesOrderNo: string | null;
      quantity: number | null;
    }>();
  const items: DRCreateItem[] = (res.results ?? [])
    .filter(
      (r) =>
        !onlyProductionOrderIds ||
        (!!r.productionOrderId &&
          onlyProductionOrderIds.has(r.productionOrderId)),
    )
    .map((r) => ({
      productionOrderId: r.productionOrderId ?? "",
      poNo: r.poNo ?? "",
      productCode: r.productCode ?? "",
      productName: r.productName ?? "",
      sizeLabel: r.sizeLabel ?? "",
      fabricCode: r.fabricCode ?? "",
      specialOrder: r.specialOrder ?? "",
      salesOrderNo: r.salesOrderNo ?? "",
      quantity: Number(r.quantity ?? 1),
      customerPO: "",
      reference: "",
    }));

  // delivery_order_items only carries the SO NUMBER — look the SO up to get its
  // customer PO + Reference so each returned line can be told apart (two
  // identical products on one DO are otherwise identical on screen).
  try {
    const soNos = [...new Set(items.map((i) => i.salesOrderNo).filter(Boolean))] as string[];
    if (soNos.length) {
      const ph = soNos.map(() => "?").join(",");
      const so = await db
        .prepare(
          `SELECT companySOId AS "companySOId", customerPOId AS "customerPOId",
                  reference AS "reference"
             FROM sales_orders WHERE companySOId IN (${ph})`,
        )
        .bind(...soNos)
        .all<{ companySOId: string; customerPOId: string | null; reference: string | null }>();
      const refs = new Map<string, { po: string; ref: string }>();
      for (const s of so.results ?? [])
        refs.set(s.companySOId, { po: s.customerPOId ?? "", ref: s.reference ?? "" });
      for (const it of items) {
        const hit = refs.get(it.salesOrderNo ?? "");
        if (hit) {
          it.customerPO = hit.po;
          it.reference = hit.ref;
        }
      }
    }
  } catch (err) {
    console.warn("[delivery-return-create] SO ref lookup failed:", err);
  }

  return items;
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
    let customerPOId = "";
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
                    so.customerId AS "customerId", so.customerPOId AS "customerPOId"
               FROM production_orders po
               JOIN sales_orders so ON so.id = po.salesOrderId
              WHERE po.id = ? LIMIT 1`,
          )
          .bind(firstPo.productionOrderId)
          .first<{
            soId: string;
            companySOId: string;
            customerId: string;
            customerPOId: string;
          }>();
        if (soRow) {
          salesOrderId = soRow.soId ?? "";
          companySOId = soRow.companySOId ?? "";
          customerId = soRow.customerId ?? "";
          customerPOId = soRow.customerPOId ?? "";
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
                product_name, wip_label, quantity, problem, disposition, fg_unit_id, was_invoiced,
                fabric_code, size_label, special_order, sales_order_no,
                customer_po, reference)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            String(it.fabricCode ?? ""),
            String(it.sizeLabel ?? ""),
            String(it.specialOrder ?? ""),
            String(it.salesOrderNo ?? ""),
            String(it.customerPO ?? ""),
            String(it.reference ?? ""),
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
