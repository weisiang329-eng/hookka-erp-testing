// ---------------------------------------------------------------------------
// D1-backed purchase_invoices route.
//
// Wired 2026-04-26 to replace the previous client-side mock in
// src/pages/procurement/pi.tsx (audit #2). Shape matches the old in-memory
// PurchaseInvoice type so the SPA upgrade is a swap-out, not a rewrite.
//
// Lifecycle: DRAFT → PENDING_APPROVAL → APPROVED → PAID. PAID is terminal.
// DELETE is gated to DRAFT only — once approved we keep the row for audit.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { emitAudit } from "../lib/audit";

const app = new Hono<Env>();

type PurchaseInvoiceRow = {
  id: string;
  piNo: string;
  purchaseOrderId: string | null;
  poRef: string | null;
  supplierId: string;
  supplierName: string;
  invoiceDate: string | null;
  dueDate: string | null;
  amountSen: number;
  status: string;
  remarks: string | null;
  created_at: string | null;
  updated_at: string | null;
};

const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["PENDING_APPROVAL", "APPROVED"],
  PENDING_APPROVAL: ["APPROVED", "DRAFT"],
  APPROVED: ["PAID"],
  PAID: [],
};

function rowToPI(r: PurchaseInvoiceRow) {
  return {
    id: r.id,
    piNo: r.piNo,
    purchaseOrderId: r.purchaseOrderId ?? "",
    poRef: r.poRef ?? "",
    supplierId: r.supplierId,
    supplier: r.supplierName, // SPA reads `.supplier` (legacy field name)
    supplierName: r.supplierName,
    invoiceDate: r.invoiceDate ?? "",
    dueDate: r.dueDate ?? "",
    amountSen: r.amountSen,
    status: r.status,
    remarks: r.remarks ?? "",
    created_at: r.created_at ?? "",
    updated_at: r.updated_at ?? "",
  };
}

// Generate next PI number for the current YYMM. Pattern: PI-YYMM-NNN.
async function generatePiNo(db: D1Database): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `PI-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT piNo FROM purchase_invoices WHERE piNo LIKE ? ORDER BY piNo DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ piNo: string }>();
  if (!res) return `${prefix}001`;
  const seq = parseInt(res.piNo.replace(prefix, ""), 10);
  if (!Number.isFinite(seq)) return `${prefix}001`;
  return `${prefix}${String(seq + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// GET /api/purchase-invoices — list with optional filters.
//   ?status=DRAFT,PENDING_APPROVAL  (CSV)
//   ?supplierId=...
//   ?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD  (filters invoiceDate)
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const db = c.var.DB;
  const statusParam = c.req.query("status") ?? "";
  const supplierIdParam = c.req.query("supplierId") ?? "";
  const dateFrom = c.req.query("dateFrom") ?? "";
  const dateTo = c.req.query("dateTo") ?? "";

  const wheres: string[] = [];
  const binds: (string | number)[] = [];
  if (statusParam) {
    const statuses = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length > 0) {
      wheres.push(`status IN (${statuses.map(() => "?").join(",")})`);
      binds.push(...statuses);
    }
  }
  if (supplierIdParam) {
    wheres.push("supplierId = ?");
    binds.push(supplierIdParam);
  }
  if (dateFrom) {
    wheres.push("invoiceDate >= ?");
    binds.push(dateFrom);
  }
  if (dateTo) {
    wheres.push("invoiceDate <= ?");
    binds.push(dateTo);
  }
  const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
  const sql = `SELECT * FROM purchase_invoices ${whereSql} ORDER BY invoiceDate DESC, piNo DESC`;
  const stmt = binds.length > 0 ? db.prepare(sql).bind(...binds) : db.prepare(sql);
  const res = await stmt.all<PurchaseInvoiceRow>();
  return c.json({ success: true, data: (res.results ?? []).map(rowToPI) });
});

// ---------------------------------------------------------------------------
// GET /api/purchase-invoices/:id
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
    "SELECT * FROM purchase_invoices WHERE id = ?",
  )
    .bind(id)
    .first<PurchaseInvoiceRow>();
  if (!row) return c.json({ success: false, error: "PI not found" }, 404);
  return c.json({ success: true, data: rowToPI(row) });
});

// ---------------------------------------------------------------------------
// POST /api/purchase-invoices — create from a PO (or standalone).
// Body: { purchaseOrderId?, supplierId, supplierName, invoiceDate, dueDate,
//         amountSen, remarks?, status? (default DRAFT) }
// PO denorm fields (poRef) auto-resolved when purchaseOrderId is given.
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "create");
  if (denied) return denied;

  const db = c.var.DB;
  const body = await c.req.json().catch(() => ({})) as {
    purchaseOrderId?: string;
    supplierId?: string;
    supplierName?: string;
    invoiceDate?: string;
    dueDate?: string;
    amountSen?: number;
    remarks?: string;
    status?: string;
  };

  if (!body.supplierId || !body.supplierName) {
    return c.json(
      { success: false, error: "supplierId and supplierName are required" },
      400,
    );
  }
  const status = body.status || "DRAFT";
  if (!VALID_TRANSITIONS[status] && status !== "DRAFT") {
    return c.json({ success: false, error: `Invalid initial status: ${status}` }, 400);
  }

  // Resolve poRef from purchaseOrderId if given.
  let poRef: string | null = null;
  if (body.purchaseOrderId) {
    const po = await db
      .prepare("SELECT poNo FROM purchase_orders WHERE id = ?")
      .bind(body.purchaseOrderId)
      .first<{ poNo: string }>();
    poRef = po?.poNo ?? null;
  }

  const piNo = await generatePiNo(db);
  const id = `pi-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO purchase_invoices (
         id, piNo, purchaseOrderId, poRef, supplierId, supplierName,
         invoiceDate, dueDate, amountSen, status, remarks,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      piNo,
      body.purchaseOrderId ?? null,
      poRef,
      body.supplierId,
      body.supplierName,
      body.invoiceDate ?? null,
      body.dueDate ?? null,
      body.amountSen ?? 0,
      status,
      body.remarks ?? null,
      now,
      now,
    )
    .run();

  await emitAudit(c, {
    resource: "purchase-invoices",
    resourceId: id,
    action: "create",
    after: { piNo, status, amountSen: body.amountSen ?? 0 },
  });

  const created = await db
    .prepare("SELECT * FROM purchase_invoices WHERE id = ?")
    .bind(id)
    .first<PurchaseInvoiceRow>();
  return c.json({ success: true, data: created ? rowToPI(created) : null });
});

// ---------------------------------------------------------------------------
// PUT /api/purchase-invoices/:id — update fields + status (with transition
// guard). Body: { status?, remarks?, invoiceDate?, dueDate?, amountSen? }
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "update");
  if (denied) return denied;

  const id = c.req.param("id");
  const db = c.var.DB;
  const existing = await db
    .prepare("SELECT * FROM purchase_invoices WHERE id = ?")
    .bind(id)
    .first<PurchaseInvoiceRow>();
  if (!existing) return c.json({ success: false, error: "PI not found" }, 404);

  const body = await c.req.json().catch(() => ({})) as {
    status?: string;
    remarks?: string;
    invoiceDate?: string;
    dueDate?: string;
    amountSen?: number;
  };

  // Status transition guard.
  if (body.status && body.status !== existing.status) {
    const allowed = VALID_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(body.status)) {
      return c.json(
        {
          success: false,
          error: `Invalid status transition: ${existing.status} → ${body.status}. Allowed: ${allowed.join(", ") || "none"}`,
        },
        400,
      );
    }
  }

  const merged = {
    status: body.status ?? existing.status,
    remarks: body.remarks ?? existing.remarks,
    invoiceDate: body.invoiceDate ?? existing.invoiceDate,
    dueDate: body.dueDate ?? existing.dueDate,
    amountSen: body.amountSen ?? existing.amountSen,
  };
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE purchase_invoices SET
         status = ?, remarks = ?, invoiceDate = ?, dueDate = ?, amountSen = ?,
         updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      merged.status,
      merged.remarks,
      merged.invoiceDate,
      merged.dueDate,
      merged.amountSen,
      now,
      id,
    )
    .run();

  await emitAudit(c, {
    resource: "purchase-invoices",
    resourceId: id,
    action: "update",
    before: existing,
    after: merged,
  });

  const updated = await db
    .prepare("SELECT * FROM purchase_invoices WHERE id = ?")
    .bind(id)
    .first<PurchaseInvoiceRow>();
  return c.json({ success: true, data: updated ? rowToPI(updated) : null });
});

// ---------------------------------------------------------------------------
// DELETE /api/purchase-invoices/:id — only DRAFT rows are deletable.
// Approved / paid PIs are kept for audit (use PUT to flip back to DRAFT
// first if you really need to delete one).
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "delete");
  if (denied) return denied;

  const id = c.req.param("id");
  const db = c.var.DB;
  const existing = await db
    .prepare("SELECT * FROM purchase_invoices WHERE id = ?")
    .bind(id)
    .first<PurchaseInvoiceRow>();
  if (!existing) return c.json({ success: false, error: "PI not found" }, 404);
  if (existing.status !== "DRAFT") {
    return c.json(
      {
        success: false,
        error: `Only DRAFT invoices can be deleted (current: ${existing.status})`,
      },
      409,
    );
  }
  await db
    .prepare("DELETE FROM purchase_invoices WHERE id = ?")
    .bind(id)
    .run();
  await emitAudit(c, {
    resource: "purchase-invoices",
    resourceId: id,
    action: "delete",
    before: existing,
  });
  return c.json({ success: true });
});

export default app;
