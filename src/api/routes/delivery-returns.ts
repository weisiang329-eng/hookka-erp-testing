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
import {
  createDeliveryReturnRecord,
  ensureDeliveryReturnTables,
} from "../lib/delivery-return-create";

const app = new Hono<Env>();
export default app;

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
  fabricCode: string | null;
  sizeLabel: string | null;
  specialOrder: string | null;
  salesOrderNo: string | null;
  customerPO: string | null;
  reference: string | null;
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
  was_invoiced AS "wasInvoiced", fabric_code AS "fabricCode", size_label AS "sizeLabel",
  special_order AS "specialOrder", sales_order_no AS "salesOrderNo",
  customer_po AS "customerPO", reference AS "reference"`;

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
    fabricCode: r.fabricCode ?? "",
    sizeLabel: r.sizeLabel ?? "",
    specialOrder: r.specialOrder ?? "",
    salesOrderNo: r.salesOrderNo ?? "",
    customerPO: r.customerPO ?? "",
    reference: r.reference ?? "",
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

    // Header snapshot + item insert live in the shared helper so the office
    // "New return" flow and the driver "Not received" flow write an identical
    // record (see lib/delivery-return-create.ts).
    const created = await createDeliveryReturnRecord(c.var.DB, orgId, {
      doId,
      items,
      reason: String(body.reason ?? ""),
      notes: String(body.notes ?? ""),
    });
    if (!created) {
      return c.json({ success: false, error: "Failed to create delivery return" }, 400);
    }

    const header = await c.var.DB
      .prepare(`SELECT ${HEADER_COLS} FROM delivery_returns WHERE id = ?`)
      .bind(created.id)
      .first<ReturnHeaderRow>();
    const itemRows = await loadItems(c.var.DB, created.id);
    return c.json(
      { success: true, data: header ? rowToReturn(header, itemRows) : null },
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
// Builds the "put returned goods back into sellable stock" statements:
//   (1) reverse the COGS / FG value — add qty back to fg_batches + one reversing
//       ADJUSTMENT (IN) cost_ledger row per slice, idempotent per DR;
//   (2) flag the physical fg_units RETURNED.
// SHARED by the "Return to stock" outcome AND the "Pure return → CN" outcome (a
// pure return = the good comes back to sellable stock AND the money is refunded
// via a Credit Note), so inventory is credited in ONE step from either. It is
// safe against double-count: reverseFGForDeliveryReturn no-ops if this DR has
// already reversed (guard on refType='DELIVERY_RETURN' AND refId=drId).
async function buildReturnToStockStatements(
  db: D1Database,
  drId: string,
  doId: string | null,
  items: ReturnItemRow[],
  now: string,
): Promise<{ statements: D1PreparedStatement[]; reversedCogsSen: number }> {
  const statements: D1PreparedStatement[] = [];
  let reversedCogsSen = 0;
  if (doId) {
    const rev = await reverseFGForDeliveryReturn(
      db,
      drId,
      doId,
      items.map((it) => ({ productCode: it.productCode, quantity: it.quantity })),
      now,
    );
    statements.push(...rev.statements);
    reversedCogsSen = rev.reversedCogsSen;
  }
  const unitIds = items.map((it) => it.fgUnitId).filter((x): x is string => !!x);
  if (unitIds.length) {
    const marks = unitIds.map(() => "?").join(",");
    statements.push(
      db
        .prepare(
          `UPDATE fg_units SET status='RETURNED', returnedAt=? WHERE id IN (${marks})`,
        )
        .bind(now, ...unitIds),
    );
  }
  return { statements, reversedCogsSen };
}

app.post("/:id/return-to-stock", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;
  await ensureDeliveryReturnTables(c.var.DB);
  const id = c.req.param("id");
  const now = new Date().toISOString();

  const header = await c.var.DB
    .prepare(`SELECT delivery_order_id AS "doId", status FROM delivery_returns WHERE id = ?`)
    .bind(id)
    .first<{ doId: string | null; status: string }>();
  if (!header) return c.json({ success: false, error: "Not found" }, 404);
  // One-and-done: an outcome can only be chosen from OPEN. This is what makes
  // "restock" and "repair" MUTUALLY EXCLUSIVE — you cannot return-to-stock (+1
  // good stock) and then also repair-&-remake (produce a replacement), which
  // would double-count inventory + COGS. Repair leaves the returned unit OUT of
  // sellable stock; only restock / pure-return credit it back.
  if (header.status !== "OPEN") {
    return c.json(
      { success: false, error: `This return is already resolved (${header.status}).` },
      409,
    );
  }
  const items = await loadItems(c.var.DB, id);

  const { statements, reversedCogsSen } = await buildReturnToStockStatements(
    c.var.DB,
    id,
    header.doId,
    items,
    now,
  );
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
  const now = new Date().toISOString();

  const header = await c.var.DB
    .prepare(`SELECT delivery_order_id AS "doId", status FROM delivery_returns WHERE id = ?`)
    .bind(id)
    .first<{ doId: string | null; status: string }>();
  if (!header) return c.json({ success: false, error: "Not found" }, 404);
  // Mutual exclusivity (see return-to-stock): an outcome is settable only from
  // OPEN, so REPAIR can never follow a RESTOCK (which would book the defective
  // unit as good stock AND produce a replacement — a double count).
  if (header.status !== "OPEN") {
    return c.json(
      { success: false, error: `This return is already resolved (${header.status}).` },
      409,
    );
  }

  const status = type === "PURE_RETURN" ? "CN_ISSUED" : "SERVICE_SPAWNED";
  const statements: D1PreparedStatement[] = [];
  // PURE_RETURN = the good comes back to sellable stock (reverse COGS + fg_units)
  // AND the customer is refunded via a Credit Note. Do the inventory half here so
  // it is one step, not two. REPAIR_REDELIVER touches NO inventory — the unit is
  // repaired / remade for the same customer and never re-enters sellable stock.
  if (type === "PURE_RETURN") {
    const items = await loadItems(c.var.DB, id);
    const rts = await buildReturnToStockStatements(c.var.DB, id, header.doId, items, now);
    statements.push(...rts.statements);
  }
  statements.push(
    c.var.DB.prepare(
      `UPDATE delivery_returns
          SET return_type=?, status=?, service_case_id=?, service_order_id=?, credit_note_id=?,
              returned_at=COALESCE(?, returned_at), updated_at=?
        WHERE id=?`,
    ).bind(
      type,
      status,
      String(body.serviceCaseId ?? ""),
      String(body.serviceOrderId ?? ""),
      String(body.creditNoteId ?? ""),
      type === "PURE_RETURN" ? now : null,
      now,
      id,
    ),
  );
  await c.var.DB.batch(statements);
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
