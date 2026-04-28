// ---------------------------------------------------------------------------
// D1-backed invoices route.
//
// Mirrors the old src/api/routes/invoices.ts response shape so the SPA
// frontend doesn't need any changes. `items` joins invoice_items; `payments`
// joins invoice_payments. Invoice creation still requires a DELIVERED
// deliveryOrderId, and flips the DO status to INVOICED in the same batch.
//
// When an invoice transitions to PAID (either via a direct PUT setting
// status=PAID / paidAmount ≥ totalSen, or via a payment allocation in
// payments.ts), we cascade the linked SO to CLOSED *once every invoice
// attached to that SO is PAID*. An SO can fan out to multiple DOs →
// multiple invoices; closing the SO on the first fully-paid invoice would
// be wrong. The exported helper `previewCascadeSOClosed` walks back
// invoice → DO → SO, probes every sibling invoice, and returns the batch
// statements to flip the SO + write a so_status_changes audit row.
// Idempotent — running against an already-CLOSED SO is a no-op.
// payments.ts imports the same helper so both paths stay in lock-step.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { emitAudit } from "../lib/audit";
import { appendJournalEntries } from "../lib/journal-hash";
import { checkInvoiceLocked, lockedResponse } from "../lib/lock-helpers";

const app = new Hono<Env>();

type InvoiceRow = {
  id: string;
  invoiceNo: string;
  deliveryOrderId: string | null;
  doNo: string | null;
  salesOrderId: string | null;
  companySOId: string | null;
  customerId: string;
  customerName: string;
  customerState: string | null;
  hubId: string | null;
  hubName: string | null;
  subtotalSen: number;
  totalSen: number;
  status: string;
  invoiceDate: string | null;
  dueDate: string | null;
  paidAmount: number;
  paymentDate: string | null;
  paymentMethod: string | null;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type InvoiceItemRow = {
  id: string;
  invoiceId: string;
  productCode: string | null;
  productName: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  quantity: number;
  unitPriceSen: number;
  totalSen: number;
};

type InvoicePaymentRow = {
  id: string;
  invoiceId: string;
  date: string;
  amountSen: number;
  method: string | null;
  reference: string | null;
};

const INV_VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SENT", "CANCELLED"],
  SENT: ["PAID", "PARTIAL_PAID", "OVERDUE", "CANCELLED"],
  PARTIAL_PAID: ["PAID", "OVERDUE", "CANCELLED"],
  OVERDUE: ["PAID", "PARTIAL_PAID", "CANCELLED"],
  PAID: [],
  CANCELLED: [],
};

function rowToItem(row: InvoiceItemRow) {
  return {
    id: row.id,
    productCode: row.productCode ?? "",
    productName: row.productName ?? "",
    sizeLabel: row.sizeLabel ?? "",
    fabricCode: row.fabricCode ?? "",
    quantity: row.quantity,
    unitPriceSen: row.unitPriceSen,
    totalSen: row.totalSen,
  };
}

function rowToPayment(row: InvoicePaymentRow) {
  return {
    id: row.id,
    date: row.date,
    amountSen: row.amountSen,
    method: row.method ?? "BANK_TRANSFER",
    reference: row.reference ?? "",
  };
}

function rowToInvoice(
  row: InvoiceRow,
  items: InvoiceItemRow[] = [],
  payments: InvoicePaymentRow[] = [],
) {
  return {
    id: row.id,
    invoiceNo: row.invoiceNo,
    deliveryOrderId: row.deliveryOrderId ?? "",
    doNo: row.doNo ?? "",
    salesOrderId: row.salesOrderId ?? "",
    companySOId: row.companySOId ?? "",
    customerId: row.customerId,
    customerName: row.customerName,
    customerState: row.customerState ?? "",
    hubId: row.hubId,
    hubName: row.hubName ?? "",
    items: items
      .filter((i) => i.invoiceId === row.id)
      .map(rowToItem),
    subtotalSen: row.subtotalSen,
    totalSen: row.totalSen,
    status: row.status,
    invoiceDate: row.invoiceDate ?? "",
    dueDate: row.dueDate ?? "",
    paidAmount: row.paidAmount,
    paymentDate: row.paymentDate,
    paymentMethod: row.paymentMethod ?? "",
    payments: payments
      .filter((p) => p.invoiceId === row.id)
      .map(rowToPayment),
    notes: row.notes ?? "",
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
  };
}

function genInvoiceId(): string {
  return `inv-${crypto.randomUUID().slice(0, 8)}`;
}

function genInvoiceItemId(): string {
  return `invi-${crypto.randomUUID().slice(0, 8)}`;
}

function genInvoicePaymentId(): string {
  return `invpay-${crypto.randomUUID().slice(0, 8)}`;
}

// INV-YYMM-NNN sequential. Bug fix 2026-04-28: previous random hex tail was
// not monotonic and could collide. Pulls max-existing-suffix+1 in the
// (year, month) bucket so new invoices always increment.
// Exported so delivery-orders.ts can share the same source of truth.
export async function nextInvoiceNo(db: D1Database): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(
    now.getMonth() + 1,
  ).padStart(2, "0")}`;
  const prefix = `INV-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT invoiceNo FROM invoices WHERE invoiceNo LIKE ? ORDER BY invoiceNo DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ invoiceNo: string }>();
  if (!res) return `${prefix}001`;
  const tail = res.invoiceNo.replace(prefix, "");
  const seq = parseInt(tail, 10);
  if (!Number.isFinite(seq)) return `${prefix}001`;
  return `${prefix}${String(seq + 1).padStart(3, "0")}`;
}

function genStatusChangeId(): string {
  return `sc-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// previewCascadeSOClosed
//
// Called from inside a PUT handler that is about to flip an invoice to PAID
// as part of its own batch. The current invoice's PAID status is in-flight
// (not yet on disk); every sibling invoice is read straight from D1.
//
// Returns the extra batch statements that, when appended to the caller's
// batch, flip the linked SO to CLOSED and append a so_status_changes audit
// row *only if* every invoice against every DO of that SO is PAID or
// CANCELLED (the in-flight invoice is treated as PAID).
//
// Idempotent:
//   * no-op if invoice has no linked DO / SO;
//   * no-op if the SO is already CLOSED or CANCELLED;
//   * no-op if any sibling invoice is still unpaid.
//
// Handles missing `so_status_changes` table gracefully by probing once
// before appending the INSERT (so older deployments still close the SO
// even without the audit row).
// ---------------------------------------------------------------------------
export async function previewCascadeSOClosed(
  db: D1Database,
  invoiceId: string,
  deliveryOrderId: string | null,
  nowIso: string,
  changedBy = "System",
): Promise<D1PreparedStatement[]> {
  if (!deliveryOrderId) return [];
  const doRow = await db
    .prepare("SELECT id, salesOrderId FROM delivery_orders WHERE id = ?")
    .bind(deliveryOrderId)
    .first<{ id: string; salesOrderId: string | null }>();
  if (!doRow || !doRow.salesOrderId) return [];

  const soRow = await db
    .prepare("SELECT id, status FROM sales_orders WHERE id = ?")
    .bind(doRow.salesOrderId)
    .first<{ id: string; status: string }>();
  if (!soRow) return [];
  if (soRow.status === "CLOSED" || soRow.status === "CANCELLED") return [];

  // Sibling invoices that are still unpaid (excluding *this* invoice —
  // its PAID status is in-flight and will land in the same batch).
  const unpaidProbe = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM invoices i
         JOIN delivery_orders d ON d.id = i.deliveryOrderId
        WHERE d.salesOrderId = ?
          AND i.id != ?
          AND i.status != 'PAID'
          AND i.status != 'CANCELLED'`,
    )
    .bind(soRow.id, invoiceId)
    .first<{ n: number }>();
  if ((unpaidProbe?.n ?? 0) > 0) return [];

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        "UPDATE sales_orders SET status = 'CLOSED', updated_at = ? WHERE id = ?",
      )
      .bind(nowIso, soRow.id),
  ];

  // Probe for so_status_changes — skip audit insert if the table isn't
  // present (older deployments that haven't applied migration 0001's
  // status-history tables yet).
  const hasAudit = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'so_status_changes' LIMIT 1",
    )
    .first<{ name: string }>()
    .catch(() => null);
  if (hasAudit) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO so_status_changes
             (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          genStatusChangeId(),
          soRow.id,
          soRow.status,
          "CLOSED",
          changedBy,
          nowIso,
          "All invoices fully paid",
          JSON.stringify([`Invoice ${invoiceId} PAID closed SO`]),
        ),
    );
  }

  return stmts;
}

async function fetchInvoiceWithChildren(db: D1Database, id: string) {
  const [inv, itemsRes, paymentsRes] = await Promise.all([
    db
      .prepare("SELECT * FROM invoices WHERE id = ?")
      .bind(id)
      .first<InvoiceRow>(),
    db
      .prepare("SELECT * FROM invoice_items WHERE invoiceId = ?")
      .bind(id)
      .all<InvoiceItemRow>(),
    db
      .prepare("SELECT * FROM invoice_payments WHERE invoiceId = ?")
      .bind(id)
      .all<InvoicePaymentRow>(),
  ]);
  if (!inv) return null;
  return rowToInvoice(
    inv,
    itemsRes.results ?? [],
    paymentsRes.results ?? [],
  );
}

// GET /api/invoices — list all, nested items + payments. Optional filters.
//
// Filters: ?customerId= and ?status= (existing; applied at the SQL layer).
// Pagination: opt-in via ?page=N&limit=M. When either is supplied, SQL
// LIMIT/OFFSET applies to the filtered set, and items + payments are
// scoped to only the page's invoice IDs. Default limit=50, cap=500.
//
// ?includeArchive=true — phase-5 flag accepted for API symmetry with the
// other list endpoints, but invoices are NOT archived (compliance/tax
// retention rules). So this is a no-op on the invoices endpoint; the
// query param is consumed-and-ignored rather than forwarded to SQL.
app.get("/", async (c) => {
  // RBAC gate (P3.3-followup) — invoices:read.
  const denied = await requirePermission(c, "invoices", "read");
  if (denied) return denied;
  const db = c.var.DB;
  const customerId = c.req.query("customerId");
  const status = c.req.query("status");
  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const paginate = pageParam !== undefined || limitParam !== undefined;

  const where: string[] = [];
  const params: unknown[] = [];
  if (customerId) {
    where.push("customerId = ?");
    params.push(customerId);
  }
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  if (!paginate) {
    // 2026-04-26 prod 500 fix: cap the unbounded items + payments fetch
    // when no customer/status filter is applied. The unfiltered
    // `SELECT * FROM invoice_items` was the prime suspect for the 500
    // surfaced in the dogfood test (Server-Timing showed app-time + 0
    // db queries, consistent with a result-set or CPU-budget exception
    // inside the handler before any timer fires). Past this cap callers
    // must pass ?page=N&limit=M.
    const ROWS_HARD_CAP = 5000;
    const [invs, items, payments] = await Promise.all([
      db
        .prepare(`SELECT * FROM invoices ${clause} ORDER BY created_at DESC`)
        .bind(...params)
        .all<InvoiceRow>(),
      db
        .prepare(
          customerId || status
            ? `SELECT i.* FROM invoice_items i
                 INNER JOIN invoices v ON v.id = i.invoiceId ${clause.replace(/customerId/g, "v.customerId").replace(/status/g, "v.status")}
                 LIMIT ${ROWS_HARD_CAP}`
            : `SELECT * FROM invoice_items LIMIT ${ROWS_HARD_CAP}`,
        )
        .bind(...params)
        .all<InvoiceItemRow>(),
      db
        .prepare(
          customerId || status
            ? `SELECT p.* FROM invoice_payments p
                 INNER JOIN invoices v ON v.id = p.invoiceId ${clause.replace(/customerId/g, "v.customerId").replace(/status/g, "v.status")}
                 LIMIT ${ROWS_HARD_CAP}`
            : `SELECT * FROM invoice_payments LIMIT ${ROWS_HARD_CAP}`,
        )
        .bind(...params)
        .all<InvoicePaymentRow>(),
    ]);

    const data = (invs.results ?? []).map((inv) =>
      rowToInvoice(inv, items.results ?? [], payments.results ?? []),
    );
    return c.json({ success: true, data, total: data.length });
  }

  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const rawLimit = parseInt(limitParam ?? "50", 10) || 50;
  const limit = Math.min(500, Math.max(1, rawLimit));
  const offset = (page - 1) * limit;

  const [countRes, pageRes] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS n FROM invoices ${clause}`)
      .bind(...params)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT * FROM invoices ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .bind(...params, limit, offset)
      .all<InvoiceRow>(),
  ]);
  const total = countRes?.n ?? 0;
  const invRows = pageRes.results ?? [];

  let items: InvoiceItemRow[] = [];
  let payments: InvoicePaymentRow[] = [];
  if (invRows.length > 0) {
    const ids = invRows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const [itemsRes, paymentsRes] = await Promise.all([
      db
        .prepare(`SELECT * FROM invoice_items WHERE invoiceId IN (${placeholders})`)
        .bind(...ids)
        .all<InvoiceItemRow>(),
      db
        .prepare(`SELECT * FROM invoice_payments WHERE invoiceId IN (${placeholders})`)
        .bind(...ids)
        .all<InvoicePaymentRow>(),
    ]);
    items = itemsRes.results ?? [];
    payments = paymentsRes.results ?? [];
  }
  const data = invRows.map((inv) => rowToInvoice(inv, items, payments));
  return c.json({ success: true, data, page, limit, total });
});

// ---------------------------------------------------------------------------
// GET /api/invoices/stats — whole-dataset status bucket counts.
//
// Returns { byStatus: Record<string, number>, total }. Used by the invoices
// list page KPI cards so counts reflect the full table rather than only the
// current paginated page. Registered BEFORE /:id (Hono route ordering).
// ---------------------------------------------------------------------------
app.get("/stats", async (c) => {
  const denied = await requirePermission(c, "invoices", "read");
  if (denied) return denied;
  const res = await c.var.DB
    .prepare("SELECT status, COUNT(*) AS n FROM invoices GROUP BY status")
    .all<{ status: string; n: number }>();
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of res.results ?? []) {
    byStatus[row.status] = row.n;
    total += row.n;
  }
  return c.json({ success: true, byStatus, total });
});

// POST /api/invoices — create from a DELIVERED delivery order.
app.post("/", async (c) => {
  // RBAC gate (P3.3-followup) — invoices:create.
  const denied = await requirePermission(c, "invoices", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const deliveryOrderId: string | undefined = body.deliveryOrderId;
    if (!deliveryOrderId) {
      return c.json(
        { success: false, error: "deliveryOrderId is required" },
        400,
      );
    }

    const doRow = await c.var.DB.prepare(
      `SELECT id, doNo, salesOrderId, companySOId, customerId, customerName,
              customerState, hubId, hubName, status
         FROM delivery_orders WHERE id = ?`,
    )
      .bind(deliveryOrderId)
      .first<{
        id: string;
        doNo: string;
        salesOrderId: string | null;
        companySOId: string | null;
        customerId: string;
        customerName: string;
        customerState: string | null;
        hubId: string | null;
        hubName: string | null;
        status: string;
      }>();
    if (!doRow) {
      return c.json(
        { success: false, error: "Delivery order not found" },
        404,
      );
    }
    if (doRow.status !== "DELIVERED") {
      return c.json(
        {
          success: false,
          error: `Cannot create invoice: Delivery Order is "${doRow.status}". Only DELIVERED delivery orders can be invoiced.`,
        },
        400,
      );
    }

    // Pull the DO items + the SO items to get unit prices (mirrors the old impl).
    const [doItemsRes, soItemsRes] = await Promise.all([
      c.var.DB.prepare(
        `SELECT productCode, productName, sizeLabel, fabricCode, quantity
           FROM delivery_order_items WHERE deliveryOrderId = ?`,
      )
        .bind(doRow.id)
        .all<{
          productCode: string | null;
          productName: string | null;
          sizeLabel: string | null;
          fabricCode: string | null;
          quantity: number;
        }>(),
      doRow.salesOrderId
        ? c.var.DB.prepare(
            "SELECT productCode, unitPriceSen FROM sales_order_items WHERE salesOrderId = ?",
          )
            .bind(doRow.salesOrderId)
            .all<{ productCode: string | null; unitPriceSen: number }>()
        : Promise.resolve({ results: [] as { productCode: string | null; unitPriceSen: number }[] }),
    ]);

    const priceByCode = new Map<string, number>();
    for (const si of soItemsRes.results ?? []) {
      if (si.productCode) priceByCode.set(si.productCode, si.unitPriceSen);
    }

    const items = (doItemsRes.results ?? []).map((doItem) => {
      const unitPriceSen = doItem.productCode
        ? priceByCode.get(doItem.productCode) ?? 0
        : 0;
      return {
        id: genInvoiceItemId(),
        productCode: doItem.productCode ?? "",
        productName: doItem.productName ?? "",
        sizeLabel: doItem.sizeLabel ?? "",
        fabricCode: doItem.fabricCode ?? "",
        quantity: doItem.quantity,
        unitPriceSen,
        totalSen: unitPriceSen * doItem.quantity,
      };
    });

    const subtotalSen = items.reduce((s, i) => s + i.totalSen, 0);
    const totalSen = subtotalSen;
    const now = new Date().toISOString();
    const invoiceDate = now.split("T")[0];
    const due = new Date();
    due.setDate(due.getDate() + 30);
    const dueDate = due.toISOString().split("T")[0];
    const id = genInvoiceId();
    const invoiceNo = body.invoiceNo || (await nextInvoiceNo(c.var.DB));

    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `INSERT INTO invoices (
           id, invoiceNo, deliveryOrderId, doNo, salesOrderId, companySOId,
           customerId, customerName, customerState, hubId, hubName,
           subtotalSen, totalSen, status, invoiceDate, dueDate, paidAmount,
           paymentDate, paymentMethod, notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        invoiceNo,
        doRow.id,
        doRow.doNo,
        doRow.salesOrderId,
        doRow.companySOId,
        doRow.customerId,
        doRow.customerName,
        doRow.customerState,
        doRow.hubId,
        doRow.hubName,
        subtotalSen,
        totalSen,
        "DRAFT",
        invoiceDate,
        dueDate,
        0,
        null,
        "",
        body.notes ?? "",
        now,
        now,
      ),
      ...items.map((item) =>
        c.var.DB.prepare(
          `INSERT INTO invoice_items (
             id, invoiceId, productCode, productName, sizeLabel, fabricCode,
             quantity, unitPriceSen, totalSen
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          item.id,
          id,
          item.productCode,
          item.productName,
          item.sizeLabel,
          item.fabricCode,
          item.quantity,
          item.unitPriceSen,
          item.totalSen,
        ),
      ),
      // Flip DO to INVOICED in the same batch so we roll back together.
      c.var.DB.prepare(
        `UPDATE delivery_orders SET status = 'INVOICED', overdue = 'INVOICED', updated_at = ? WHERE id = ?`,
      ).bind(now, doRow.id),
    ];

    await c.var.DB.batch(statements);

    const created = await fetchInvoiceWithChildren(c.var.DB, id);
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create invoice" },
        500,
      );
    }
    return c.json({ success: true, data: created }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/invoices] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error creating invoice" }, 500);
  }
});

// GET /api/invoices/:id — single
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, "invoices", "read");
  if (denied) return denied;
  const id = c.req.param("id");
  const inv = await fetchInvoiceWithChildren(c.var.DB, id);
  if (!inv) {
    return c.json({ success: false, error: "Invoice not found" }, 404);
  }
  // Lock status (payment recorded / status=PAID?) — surfaced to the
  // detail page so it can render a "credit note required" banner.
  const lockReason = await checkInvoiceLocked(c.var.DB, id);
  return c.json({ success: true, data: inv, lockReason });
});

// PUT /api/invoices/:id — update (status transitions, payments, fields)
app.put("/:id", async (c) => {
  // RBAC gate (P3.3-followup) — base permission is invoices:update.
  // Sensitive transitions get additional row-level checks below:
  //   • DRAFT → SENT  (the "post" action)        ⇒ invoices:post
  //   • *     → CANCELLED  (the "void" action)   ⇒ invoices:void
  const baseDenied = await requirePermission(c, "invoices", "update");
  if (baseDenied) return baseDenied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM invoices WHERE id = ?",
    )
      .bind(id)
      .first<InvoiceRow>();
    if (!existing) {
      return c.json({ success: false, error: "Invoice not found" }, 404);
    }
    // Cascade lock — once a payment is recorded (paidAmountSen > 0 or
    // status='PAID'), the invoice is GL-posted and edits would orphan
    // the accounting trail. Reversals must go through a credit note.
    // Status transitions to CANCELLED still need to flow through, so the
    // status-change branch below runs unconditionally; the lock only
    // blocks field-level edits.
    const lockMsg = await checkInvoiceLocked(c.var.DB, id);
    const body = await c.req.json();
    const isStatusOnly =
      body.status &&
      !body.dueDate &&
      !body.notes &&
      !body.lineItems &&
      !body.subtotalSen;
    if (lockMsg && !isStatusOnly) {
      return c.json(lockedResponse(lockMsg), 403);
    }
    const now = new Date().toISOString();

    // --- validate status transition (same rules as mock-data) ---
    let nextStatus: string = existing.status;
    if (body.status && body.status !== existing.status) {
      const allowed = INV_VALID_TRANSITIONS[existing.status] || [];
      if (!allowed.includes(body.status)) {
        return c.json(
          {
            success: false,
            error: `Cannot transition from ${existing.status} to ${body.status}. Allowed: ${allowed.join(", ") || "none"}`,
          },
          400,
        );
      }
      nextStatus = body.status;

      // Row-level RBAC for the high-impact post/void transitions.
      if (existing.status === "DRAFT" && nextStatus === "SENT") {
        const denied = await requirePermission(c, "invoices", "post");
        if (denied) return denied;
      }
      if (nextStatus === "CANCELLED" && existing.status !== "CANCELLED") {
        const denied = await requirePermission(c, "invoices", "void");
        if (denied) return denied;
      }
    }

    // --- handle payment delta (old impl pushed one InvoicePayment per delta) ---
    let nextPaidAmount = existing.paidAmount;
    let newInvoicePayment: {
      id: string;
      date: string;
      amountSen: number;
      method: string;
      reference: string;
    } | null = null;
    if (body.paidAmount !== undefined) {
      const paymentAmountSen = Number(body.paidAmount) - existing.paidAmount;
      if (paymentAmountSen > 0) {
        newInvoicePayment = {
          id: genInvoicePaymentId(),
          date: body.paymentDate || now.split("T")[0],
          amountSen: paymentAmountSen,
          method: body.paymentMethod || "BANK_TRANSFER",
          reference: body.paymentReference || "",
        };
      }
      nextPaidAmount = Number(body.paidAmount);
      if (nextPaidAmount >= existing.totalSen) {
        nextStatus = "PAID";
      } else if (nextPaidAmount > 0) {
        nextStatus = "PARTIAL_PAID";
      }
    }

    const merged = {
      paymentDate:
        body.paymentDate === undefined
          ? existing.paymentDate
          : body.paymentDate,
      paymentMethod:
        body.paymentMethod === undefined
          ? existing.paymentMethod
          : body.paymentMethod,
      notes: body.notes === undefined ? existing.notes : body.notes,
      dueDate: body.dueDate === undefined ? existing.dueDate : body.dueDate,
    };

    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `UPDATE invoices SET
           status = ?, paidAmount = ?, paymentDate = ?, paymentMethod = ?,
           notes = ?, dueDate = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(
        nextStatus,
        nextPaidAmount,
        merged.paymentDate,
        merged.paymentMethod,
        merged.notes,
        merged.dueDate,
        now,
        id,
      ),
    ];

    if (newInvoicePayment) {
      statements.push(
        c.var.DB.prepare(
          `INSERT INTO invoice_payments (id, invoiceId, date, amountSen, method, reference)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
          newInvoicePayment.id,
          id,
          newInvoicePayment.date,
          newInvoicePayment.amountSen,
          newInvoicePayment.method,
          newInvoicePayment.reference,
        ),
      );
    }

    // --- items replacement (optional) ---
    if (Array.isArray(body.items)) {
      statements.push(
        c.var.DB.prepare(
          "DELETE FROM invoice_items WHERE invoiceId = ?",
        ).bind(id),
      );
      let computedSubtotal = 0;
      for (const raw of body.items as Array<Record<string, unknown>>) {
        const quantity = Number(raw.quantity) || 0;
        const unitPriceSen = Number(raw.unitPriceSen) || 0;
        const totalSen = Number(raw.totalSen) || unitPriceSen * quantity;
        computedSubtotal += totalSen;
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO invoice_items (
               id, invoiceId, productCode, productName, sizeLabel, fabricCode,
               quantity, unitPriceSen, totalSen
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            (raw.id as string) || genInvoiceItemId(),
            id,
            (raw.productCode as string) ?? "",
            (raw.productName as string) ?? "",
            (raw.sizeLabel as string) ?? "",
            (raw.fabricCode as string) ?? "",
            quantity,
            unitPriceSen,
            totalSen,
          ),
        );
      }
      statements.push(
        c.var.DB.prepare(
          "UPDATE invoices SET subtotalSen = ?, totalSen = ? WHERE id = ?",
        ).bind(computedSubtotal, computedSubtotal, id),
      );
    }

    // Cascade: if this PUT flipped the invoice to PAID, close the linked
    // SO iff all sibling invoices are also PAID. See
    // previewCascadeSOClosed() for the "this invoice is in-flight" logic.
    if (nextStatus === "PAID" && existing.status !== "PAID") {
      const cascadeStmts = await previewCascadeSOClosed(
        c.var.DB,
        id,
        existing.deliveryOrderId,
        now,
      );
      statements.push(...cascadeStmts);
    }

    await c.var.DB.batch(statements);

    const updated = await fetchInvoiceWithChildren(c.var.DB, id);

    // Audit emit (P3.4) — only on the two sensitive status transitions:
    //   • post  = DRAFT → SENT (the finalize / publish moment)
    //   • void  = ANY   → CANCELLED (the kill-switch)
    // Skip the remaining payment-driven transitions (SENT → PARTIAL_PAID /
    // PAID / OVERDUE) — those are already journaled via payment audit
    // events on payments.ts. Avoid double-logging.
    if (existing.status === "DRAFT" && nextStatus === "SENT") {
      await emitAudit(c, {
        resource: "invoices",
        resourceId: id,
        action: "post",
        before: existing,
        after: updated,
      });

      // ----------------------------------------------------------------
      // Phase C #2 quick-win — dual-write to the immutable ledger.
      //
      // Standard 2-leg invoice posting per the roadmap (chart in 0010):
      //   DR 1100 Accounts Receivable     totalSen
      //   CR 4000 Sales Revenue           subtotalSen
      //   CR 2400 GST Output              taxSen   (only if non-zero)
      //
      // taxSen is derived as totalSen - subtotalSen. The current invoice
      // schema doesn't carry an explicit tax column, so the GST leg only
      // fires once a future migration starts populating it; today this
      // resolves to 0 and the leg is skipped.
      //
      // Errors are caught and warned, not thrown (same pattern as audit).
      // The editable invoice posting stays authoritative until M3/W9 when
      // the immutability trigger flips.
      try {
        const orgId =
          (existing as unknown as { orgId?: string | null }).orgId ??
          "hookka";
        const actorUserId =
          (
            c as unknown as { get: (k: string) => string | undefined }
          ).get("userId") ?? null;
        const taxSen = Math.max(0, existing.totalSen - existing.subtotalSen);
        const legs = [
          {
            id: `lje-${crypto.randomUUID().slice(0, 12)}`,
            sourceType: "invoice",
            sourceId: id,
            legNo: 1,
            accountCode: "1100",
            debitSen: existing.totalSen,
            creditSen: 0,
            description: `AR · invoice ${existing.invoiceNo}`,
            actorUserId,
            orgId,
          },
          {
            id: `lje-${crypto.randomUUID().slice(0, 12)}`,
            sourceType: "invoice",
            sourceId: id,
            legNo: 2,
            accountCode: "4000",
            debitSen: 0,
            creditSen: existing.subtotalSen,
            description: `Sales · invoice ${existing.invoiceNo}`,
            actorUserId,
            orgId,
          },
        ];
        if (taxSen > 0) {
          legs.push({
            id: `lje-${crypto.randomUUID().slice(0, 12)}`,
            sourceType: "invoice",
            sourceId: id,
            legNo: 3,
            accountCode: "2400",
            debitSen: 0,
            creditSen: taxSen,
            description: `GST output · invoice ${existing.invoiceNo}`,
            actorUserId,
            orgId,
          });
        }
        await appendJournalEntries(c.var.DB, orgId, legs);
      } catch (e) {
        console.warn(
          `[ledger] dual-write failed for invoice ${id} post:`,
          e,
        );
      }
    } else if (
      nextStatus === "CANCELLED" &&
      existing.status !== "CANCELLED"
    ) {
      await emitAudit(c, {
        resource: "invoices",
        resourceId: id,
        action: "void",
        before: existing,
        after: updated,
      });
    }

    return c.json({ success: true, data: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[PUT /api/invoices/:id] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error updating invoice" }, 500);
  }
});

// DELETE /api/invoices/:id — only DRAFT. Cascades via FK to items + payments.
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "invoices", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT id, status FROM invoices WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!existing) {
    return c.json({ success: false, error: "Invoice not found" }, 404);
  }
  if (existing.status !== "DRAFT") {
    return c.json(
      { success: false, error: "Only DRAFT invoices can be deleted" },
      400,
    );
  }
  await c.var.DB.prepare("DELETE FROM invoices WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

export default app;
