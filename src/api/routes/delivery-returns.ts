// ---------------------------------------------------------------------------
// Delivery Returns route.
//
// A Delivery Return is raised when delivered goods have a problem. Header +
// item lines, linking back to the source DO/SO and forward to either a
// Service Order (repair & re-deliver) or a Credit Note (pure return).
//
// Phase 1 (this file): the document itself — runtime-ensured tables + list /
// get / create / cancel. The accounting + inventory cascade (stock reversal,
// CN convert, service-order spawn, re-deliver) land as additional endpoints in
// later phases. Deploy does NOT replay migration files, so the tables are
// self-applied at runtime (see 0207_delivery_returns.sql for the record copy).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { reverseFGForDeliveryReturn } from "../lib/do-cost-cascade";

const app = new Hono<Env>();
export default app;

// -- runtime table self-apply (idempotent) ----------------------------------
let tablesEnsured = false;
async function ensureDeliveryReturnTables(db: D1Database): Promise<void> {
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
      "[delivery-returns] ensure tables:",
      err instanceof Error ? err.message : err,
    );
  }
}

// -- types + row builders ----------------------------------------------------
type ReturnHeaderRow = {
  id: string;
  returnNo: string;
  deliveryOrderId: string | null;
  doNo: string | null;
  salesOrderId: string | null;
  companySOId: string | null;
  customerId: string | null;
  customerName: string | null;
  customerPOId: string | null;
  returnType: string | null;
  status: string;
  serviceCaseId: string | null;
  serviceOrderId: string | null;
  creditNoteId: string | null;
  reason: string | null;
  notes: string | null;
  returnedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};
type ReturnItemRow = {
  id: string;
  deliveryReturnId: string;
  productionOrderId: string | null;
  poNo: string | null;
  productCode: string | null;
  productName: string | null;
  wipLabel: string | null;
  quantity: number;
  problem: string | null;
  disposition: string | null;
  fgUnitId: string | null;
  wasInvoiced: number;
};

const HEADER_COLS = `id, return_no AS "returnNo", delivery_order_id AS "deliveryOrderId",
  do_no AS "doNo", sales_order_id AS "salesOrderId", company_so_id AS "companySOId",
  customer_id AS "customerId", customer_name AS "customerName", customer_po_id AS "customerPOId",
  return_type AS "returnType", status, service_case_id AS "serviceCaseId",
  service_order_id AS "serviceOrderId", credit_note_id AS "creditNoteId",
  reason, notes, returned_at AS "returnedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

const ITEM_COLS = `id, delivery_return_id AS "deliveryReturnId", production_order_id AS "productionOrderId",
  po_no AS "poNo", product_code AS "productCode", product_name AS "productName",
  wip_label AS "wipLabel", quantity, problem, disposition, fg_unit_id AS "fgUnitId",
  was_invoiced AS "wasInvoiced"`;

function rowToItem(r: ReturnItemRow) {
  return {
    id: r.id,
    productionOrderId: r.productionOrderId ?? "",
    poNo: r.poNo ?? "",
    productCode: r.productCode ?? "",
    productName: r.productName ?? "",
    wipLabel: r.wipLabel ?? "",
    quantity: Number(r.quantity ?? 0),
    problem: r.problem ?? "",
    disposition: r.disposition ?? "",
    fgUnitId: r.fgUnitId ?? "",
    wasInvoiced: Boolean(r.wasInvoiced),
  };
}
function rowToReturn(h: ReturnHeaderRow, items: ReturnItemRow[] = []) {
  return {
    id: h.id,
    returnNo: h.returnNo,
    deliveryOrderId: h.deliveryOrderId ?? "",
    doNo: h.doNo ?? "",
    salesOrderId: h.salesOrderId ?? "",
    companySOId: h.companySOId ?? "",
    customerId: h.customerId ?? "",
    customerName: h.customerName ?? "",
    customerPOId: h.customerPOId ?? "",
    returnType: h.returnType ?? "",
    status: h.status ?? "OPEN",
    serviceCaseId: h.serviceCaseId ?? "",
    serviceOrderId: h.serviceOrderId ?? "",
    creditNoteId: h.creditNoteId ?? "",
    reason: h.reason ?? "",
    notes: h.notes ?? "",
    returnedAt: h.returnedAt ?? "",
    items: items.map(rowToItem),
  };
}

function genId(): string {
  return `dr-${crypto.randomUUID().slice(0, 8)}`;
}
function genItemId(): string {
  return `dri-${crypto.randomUUID().slice(0, 8)}`;
}

// DR-YYMM-NNN, sequential within the current year-month.
async function nextReturnNo(db: D1Database): Promise<string> {
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

async function loadItems(
  db: D1Database,
  drId: string,
): Promise<ReturnItemRow[]> {
  const res = await db
    .prepare(
      `SELECT ${ITEM_COLS} FROM delivery_return_items WHERE delivery_return_id = ?`,
    )
    .bind(drId)
    .all<ReturnItemRow>();
  return res.results ?? [];
}

// -- GET / — list ------------------------------------------------------------
app.get("/", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;
  await ensureDeliveryReturnTables(c.var.DB);
  const orgId = getOrgId(c);
  const res = await c.var.DB
    .prepare(
      `SELECT ${HEADER_COLS} FROM delivery_returns
        WHERE org_id = ? ORDER BY created_at DESC LIMIT 500`,
    )
    .bind(orgId)
    .all<ReturnHeaderRow>();
  const headers = res.results ?? [];
  // Attach a lightweight item summary per row (count + first problem).
  const data = [] as ReturnType<typeof rowToReturn>[];
  for (const h of headers) {
    const items = await loadItems(c.var.DB, h.id);
    data.push(rowToReturn(h, items));
  }
  return c.json({ success: true, data, total: data.length });
});

// -- GET /:id — detail -------------------------------------------------------
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "read");
  if (denied) return denied;
  await ensureDeliveryReturnTables(c.var.DB);
  const id = c.req.param("id");
  const h = await c.var.DB
    .prepare(`SELECT ${HEADER_COLS} FROM delivery_returns WHERE id = ?`)
    .bind(id)
    .first<ReturnHeaderRow>();
  if (!h) return c.json({ success: false, error: "Delivery return not found" }, 404);
  const items = await loadItems(c.var.DB, id);
  return c.json({ success: true, data: rowToReturn(h, items) });
});

// -- POST / — create a return from a delivered DO's problem lines -----------
// Body: { deliveryOrderId, reason?, items: [{ productionOrderId, poNo,
//   productCode, productName, wipLabel, quantity, problem, fgUnitId?,
//   wasInvoiced? }] }. Header snapshot (SO/customer) resolved from the DO.
app.post("/", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;
  await ensureDeliveryReturnTables(c.var.DB);
  const orgId = getOrgId(c);
  try {
    const body = await c.req.json();
    const doId = String(body.deliveryOrderId ?? "").trim();
    const items = Array.isArray(body.items) ? body.items : [];
    if (!doId || items.length === 0) {
      return c.json(
        { success: false, error: "deliveryOrderId and at least one item are required" },
        400,
      );
    }

    // Snapshot header info from the source DO (best-effort — a DO always
    // carries customerName + a salesOrderNo; SO id resolved via items→PO).
    const doRow = await c.var.DB
      .prepare(
        `SELECT id, doNo AS "doNo", customerName AS "customerName",
                customerPOId AS "customerPOId", salesOrderNos AS "salesOrderNos"
           FROM delivery_orders WHERE id = ?`,
      )
      .bind(doId)
      .first<{
        id: string;
        doNo: string | null;
        customerName: string | null;
        customerPOId: string | null;
        salesOrderNos: string | null;
      }>();

    // Resolve the SO id from the first item's production order (a DR is
    // per-SO in practice; the source DO items all trace to production_orders).
    let salesOrderId = "";
    let companySOId = "";
    let customerId = "";
    const firstPo = items.find(
      (it: { productionOrderId?: string }) => it.productionOrderId,
    );
    if (firstPo?.productionOrderId) {
      const soRow = await c.var.DB
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
    }

    const id = genId();
    const returnNo = await nextReturnNo(c.var.DB);
    const now = new Date().toISOString();

    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `INSERT INTO delivery_returns
           (id, return_no, delivery_order_id, do_no, sales_order_id, company_so_id,
            customer_id, customer_name, customer_po_id, return_type, status,
            reason, notes, returned_at, created_at, updated_at, org_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'OPEN', ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        returnNo,
        doId,
        doRow?.doNo ?? "",
        salesOrderId,
        companySOId,
        customerId,
        doRow?.customerName ?? "",
        doRow?.customerPOId ?? "",
        String(body.reason ?? ""),
        String(body.notes ?? ""),
        now,
        now,
        now,
        orgId,
      ),
    ];
    for (const it of items) {
      statements.push(
        c.var.DB.prepare(
          `INSERT INTO delivery_return_items
             (id, delivery_return_id, production_order_id, po_no, product_code,
              product_name, wip_label, quantity, problem, disposition, fg_unit_id, was_invoiced)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        ).bind(
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
    await c.var.DB.batch(statements);

    const created = await c.var.DB
      .prepare(`SELECT ${HEADER_COLS} FROM delivery_returns WHERE id = ?`)
      .bind(id)
      .first<ReturnHeaderRow>();
    const itemRows = await loadItems(c.var.DB, id);
    return c.json(
      { success: true, data: created ? rowToReturn(created, itemRows) : null },
      201,
    );
  } catch (err) {
    console.error("[delivery-returns] POST failed:", err);
    return c.json({ success: false, error: "Failed to create delivery return" }, 400);
  }
});

// -- POST /:id/return-to-stock ----------------------------------------------
// Puts the returned goods back into stock: (1) reverses the COGS / inventory
// value — for each returned line, adds the qty back to the fg_batches it was
// delivered from + writes a reversing ADJUSTMENT (IN) cost_ledger row
// (idempotent per DR via refType='DELIVERY_RETURN'); (2) flags the returned
// fg_units RETURNED; (3) moves the DR to RETURNED_TO_STOCK. All in one batch so
// it rolls back together.
app.post("/:id/return-to-stock", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;
  await ensureDeliveryReturnTables(c.var.DB);
  const id = c.req.param("id");
  const now = new Date().toISOString();

  const header = await c.var.DB
    .prepare(`SELECT delivery_order_id AS "doId" FROM delivery_returns WHERE id = ?`)
    .bind(id)
    .first<{ doId: string | null }>();
  if (!header) return c.json({ success: false, error: "Not found" }, 404);
  const items = await loadItems(c.var.DB, id);

  const statements: D1PreparedStatement[] = [];

  // (1) COGS / FG-value reversal (only if we know the source DO).
  let reversedCogsSen = 0;
  if (header.doId) {
    const rev = await reverseFGForDeliveryReturn(
      c.var.DB,
      id,
      header.doId,
      items.map((it) => ({ productCode: it.productCode, quantity: it.quantity })),
      now,
    );
    statements.push(...rev.statements);
    reversedCogsSen = rev.reversedCogsSen;
  }

  // (2) flag the physical units RETURNED (best-effort — only lines that
  // captured an fg_unit_id).
  const unitIds = items.map((it) => it.fgUnitId).filter((x): x is string => !!x);
  if (unitIds.length) {
    const marks = unitIds.map(() => "?").join(",");
    statements.push(
      c.var.DB.prepare(
        `UPDATE fg_units SET status='RETURNED', returnedAt=? WHERE id IN (${marks})`,
      ).bind(now, ...unitIds),
    );
  }

  // (3) advance the DR.
  statements.push(
    c.var.DB.prepare(
      `UPDATE delivery_returns SET status='RETURNED_TO_STOCK', returned_at=?, updated_at=? WHERE id=?`,
    ).bind(now, now, id),
  );

  await c.var.DB.batch(statements);
  return c.json({ success: true, reversedCogsSen });
});

// -- POST /:id/set-outcome — record repair-vs-pure-return + status ----------
// Body: { returnType: 'REPAIR_REDELIVER' | 'PURE_RETURN', serviceOrderId?,
// creditNoteId? }. The actual Service Order / Credit Note are created via the
// existing (tested) service-case and credit-note flows; this records the
// decision + any resulting doc id + advances the DR status.
app.post("/:id/set-outcome", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;
  await ensureDeliveryReturnTables(c.var.DB);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const type = body.returnType === "PURE_RETURN" ? "PURE_RETURN" : "REPAIR_REDELIVER";
  const status = type === "PURE_RETURN" ? "CN_ISSUED" : "SERVICE_SPAWNED";
  await c.var.DB
    .prepare(
      `UPDATE delivery_returns
          SET return_type=?, status=?, service_case_id=?, service_order_id=?, credit_note_id=?, updated_at=?
        WHERE id=?`,
    )
    .bind(
      type,
      status,
      String(body.serviceCaseId ?? ""),
      String(body.serviceOrderId ?? ""),
      String(body.creditNoteId ?? ""),
      new Date().toISOString(),
      id,
    )
    .run();
  return c.json({ success: true });
});

// -- POST /:id/mark-redelivered ---------------------------------------------
app.post("/:id/mark-redelivered", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;
  await ensureDeliveryReturnTables(c.var.DB);
  const id = c.req.param("id");
  const now = new Date().toISOString();
  await c.var.DB
    .prepare(
      `UPDATE delivery_returns SET status='REDELIVERED', updated_at=? WHERE id=?`,
    )
    .bind(now, id)
    .run();
  return c.json({ success: true });
});

// -- POST /:id/cancel --------------------------------------------------------
app.post("/:id/cancel", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;
  await ensureDeliveryReturnTables(c.var.DB);
  const id = c.req.param("id");
  const h = await c.var.DB
    .prepare(`SELECT status FROM delivery_returns WHERE id = ?`)
    .bind(id)
    .first<{ status: string }>();
  if (!h) return c.json({ success: false, error: "Not found" }, 404);
  if (h.status === "CLOSED" || h.status === "REDELIVERED" || h.status === "CN_ISSUED") {
    return c.json(
      { success: false, error: `Cannot cancel a ${h.status} return` },
      409,
    );
  }
  await c.var.DB
    .prepare(
      `UPDATE delivery_returns SET status='CANCELLED', updated_at=? WHERE id=?`,
    )
    .bind(new Date().toISOString(), id)
    .run();
  return c.json({ success: true });
});
