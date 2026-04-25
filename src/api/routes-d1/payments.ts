// ---------------------------------------------------------------------------
// D1-backed payments route.
//
// Mirrors the old src/api/routes/payments.ts response shape so the SPA
// frontend doesn't need any changes. Payment "allocations" are stored as a
// JSON TEXT column on payment_records (per the schema). When a payment is
// created with allocations, we also insert an invoice_payments row per
// allocation and bump the target invoice's paidAmount/status — identical
// semantics to the old impl.
//
// Phase-3 scope: full CRUD + status transitions (RECEIVED → CLEARED/BOUNCED)
// with the BOUNCED rollback of invoice payments.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { previewCascadeSOClosed } from "./invoices";

const app = new Hono<Env>();

type PaymentRow = {
  id: string;
  receiptNumber: string;
  customerId: string;
  customerName: string;
  date: string;
  amount: number;
  method: string | null;
  reference: string | null;
  status: string | null;
  allocations: string | null;
};

type Allocation = { invoiceId: string; invoiceNumber: string; amount: number };

const VALID_TRANSITIONS: Record<string, string[]> = {
  RECEIVED: ["CLEARED", "BOUNCED"],
  CLEARED: [],
  BOUNCED: [],
};

function parseAllocations(raw: string | null): Allocation[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((a: Record<string, unknown>) => ({
      invoiceId: (a.invoiceId as string) || "",
      invoiceNumber: (a.invoiceNumber as string) || "",
      amount: Number(a.amount) || 0,
    }));
  } catch {
    return [];
  }
}

function rowToPayment(row: PaymentRow) {
  return {
    id: row.id,
    receiptNumber: row.receiptNumber,
    customerId: row.customerId,
    customerName: row.customerName,
    date: row.date,
    amount: row.amount,
    method: row.method ?? "BANK_TRANSFER",
    reference: row.reference ?? "",
    allocations: parseAllocations(row.allocations),
    status: row.status ?? "RECEIVED",
  };
}

function genPaymentId(): string {
  return `pay-${crypto.randomUUID().slice(0, 8)}`;
}

function genInvoicePaymentId(): string {
  return `invpay-${crypto.randomUUID().slice(0, 8)}`;
}

function genNextReceiptNo(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `REC-${yymm}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
}

function genStatusChangeId(): string {
  return `sc-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/payments — list all (optional ?customerId= / ?invoiceId= filters)
app.get("/", async (c) => {
  const customerId = c.req.query("customerId");
  const invoiceId = c.req.query("invoiceId");

  const where: string[] = [];
  const params: unknown[] = [];
  if (customerId) {
    where.push("customerId = ?");
    params.push(customerId);
  }
  // invoiceId filter is a JSON LIKE since allocations is stored as JSON TEXT.
  // It's a rough match (substring on invoiceId) — good enough for a list view
  // and avoids exploding the schema at this phase.
  if (invoiceId) {
    where.push("allocations LIKE ?");
    params.push(`%"invoiceId":"${invoiceId}"%`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const res = await c.var.DB.prepare(
    `SELECT * FROM payment_records ${clause} ORDER BY date DESC, id DESC`,
  )
    .bind(...params)
    .all<PaymentRow>();

  const data = (res.results ?? []).map(rowToPayment);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/payments — create. If allocations reference invoices, also inserts
// matching invoice_payments rows and bumps the invoice paidAmount/status.
app.post("/", async (c) => {
  // RBAC gate (P3.3) — only roles with payments:create may record payments.
  const denied = await requirePermission(c, "payments", "create");
  if (denied) return denied;

  try {
    const body = await c.req.json();
    const { customerId, amount, method, reference, allocations } = body;
    if (!customerId || amount === undefined || !method) {
      return c.json(
        { success: false, error: "customerId, amount, and method are required" },
        400,
      );
    }

    const customer = await c.var.DB.prepare(
      "SELECT id, name FROM customers WHERE id = ?",
    )
      .bind(customerId)
      .first<{ id: string; name: string }>();
    if (!customer) {
      return c.json({ success: false, error: "Customer not found" }, 404);
    }

    const allocInput: Array<{ invoiceId: string; amount: number }> =
      Array.isArray(allocations) ? allocations : [];

    // Look up each invoice to grab the invoiceNo + current state for the
    // per-allocation side-effects (invoice_payments insert + paid bump).
    // Also pull salesOrderId so we can cascade the SO once the invoice is
    // fully paid (E3), and deliveryOrderId so we can reuse
    // previewCascadeSOClosed() from invoices.ts to flip the SO to CLOSED
    // when every sibling invoice is PAID.
    const invoiceSnapshots = new Map<
      string,
      {
        invoiceNo: string;
        paidAmount: number;
        totalSen: number;
        salesOrderId: string | null;
        deliveryOrderId: string | null;
      }
    >();
    if (allocInput.length > 0) {
      const ids = allocInput.map((a) => a.invoiceId);
      const placeholders = ids.map(() => "?").join(",");
      const invs = await c.var.DB.prepare(
        `SELECT id, invoiceNo, paidAmount, totalSen, salesOrderId, deliveryOrderId
           FROM invoices WHERE id IN (${placeholders})`,
      )
        .bind(...ids)
        .all<{
          id: string;
          invoiceNo: string;
          paidAmount: number;
          totalSen: number;
          salesOrderId: string | null;
          deliveryOrderId: string | null;
        }>();
      for (const i of invs.results ?? []) {
        invoiceSnapshots.set(i.id, {
          invoiceNo: i.invoiceNo,
          paidAmount: i.paidAmount,
          totalSen: i.totalSen,
          salesOrderId: i.salesOrderId,
          deliveryOrderId: i.deliveryOrderId,
        });
      }
    }

    const parsedAllocations: Allocation[] = allocInput.map((a) => ({
      invoiceId: a.invoiceId,
      invoiceNumber: invoiceSnapshots.get(a.invoiceId)?.invoiceNo ?? "",
      amount: Number(a.amount) || 0,
    }));

    const id = genPaymentId();
    const date = new Date().toISOString().split("T")[0];
    const receiptNumber = body.receiptNumber || genNextReceiptNo();
    const now = new Date().toISOString();

    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `INSERT INTO payment_records (
           id, receiptNumber, customerId, customerName, date, amount, method,
           reference, status, allocations
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        receiptNumber,
        customer.id,
        customer.name,
        date,
        Number(amount),
        method,
        reference || "",
        "RECEIVED",
        JSON.stringify(parsedAllocations),
      ),
    ];

    // Per-allocation: add invoice_payments row and bump paidAmount/status.
    // Track total allocated to this customer so we can decrement their
    // outstandingSen in one statement (E3). Track fully-paid invoices so
    // we can cascade their linked SO to INVOICED (only from DELIVERED /
    // READY_TO_SHIP) *and* run previewCascadeSOClosed() to flip the SO to
    // CLOSED once every sibling invoice is PAID.
    let totalAllocatedSen = 0;
    const fullyPaidSOIds: string[] = [];
    const fullyPaidInvoices: Array<{
      invoiceId: string;
      deliveryOrderId: string | null;
    }> = [];
    for (const alloc of parsedAllocations) {
      const snap = invoiceSnapshots.get(alloc.invoiceId);
      if (!snap) continue;
      const newPaid = snap.paidAmount + alloc.amount;
      const isFullyPaid = newPaid >= snap.totalSen;
      const newStatus = isFullyPaid
        ? "PAID"
        : newPaid > 0
          ? "PARTIAL_PAID"
          : "SENT";
      totalAllocatedSen += alloc.amount;
      if (isFullyPaid && snap.salesOrderId) {
        fullyPaidSOIds.push(snap.salesOrderId);
      }
      if (isFullyPaid) {
        fullyPaidInvoices.push({
          invoiceId: alloc.invoiceId,
          deliveryOrderId: snap.deliveryOrderId,
        });
      }
      statements.push(
        c.var.DB.prepare(
          `INSERT INTO invoice_payments (id, invoiceId, date, amountSen, method, reference)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
          genInvoicePaymentId(),
          alloc.invoiceId,
          date,
          alloc.amount,
          method,
          reference || "",
        ),
      );
      statements.push(
        c.var.DB.prepare(
          `UPDATE invoices
             SET paidAmount = ?, status = ?, paymentDate = ?, updated_at = ?
           WHERE id = ?`,
        ).bind(
          newPaid,
          newStatus,
          isFullyPaid ? date : null,
          now,
          alloc.invoiceId,
        ),
      );
    }

    // E3: decrement the customer's outstanding A/R by the total allocated.
    // MAX(0, ...) protects against over-allocation (rounding / partial
    // historical state). If the full invoice has just flipped to PAID,
    // cascade the linked SO from DELIVERED/READY_TO_SHIP → INVOICED and
    // append a so_status_changes audit row.
    if (totalAllocatedSen > 0) {
      statements.push(
        c.var.DB.prepare(
          `UPDATE customers SET outstandingSen = MAX(0, outstandingSen - ?) WHERE id = ?`,
        ).bind(totalAllocatedSen, customer.id),
      );
    }

    if (fullyPaidSOIds.length > 0) {
      const uniqueSOIds = [...new Set(fullyPaidSOIds)];
      const placeholders = uniqueSOIds.map(() => "?").join(",");
      const soRows = await c.var.DB.prepare(
        `SELECT id, status FROM sales_orders WHERE id IN (${placeholders})`,
      )
        .bind(...uniqueSOIds)
        .all<{ id: string; status: string }>();
      for (const so of soRows.results ?? []) {
        if (so.status === "DELIVERED" || so.status === "READY_TO_SHIP") {
          statements.push(
            c.var.DB.prepare(
              "UPDATE sales_orders SET status = 'INVOICED', updated_at = ? WHERE id = ?",
            ).bind(now, so.id),
            c.var.DB.prepare(
              `INSERT INTO so_status_changes
                 (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              genStatusChangeId(),
              so.id,
              so.status,
              "INVOICED",
              "System",
              now,
              "Invoice fully paid",
              JSON.stringify([`Payment ${receiptNumber} fully paid linked invoice`]),
            ),
          );
        }
      }
    }

    // Second SO cascade: if this payment pushed an invoice to PAID *and*
    // every sibling invoice attached to that SO (through every DO of the
    // SO) is also PAID, flip the SO to CLOSED. previewCascadeSOClosed()
    // treats the in-flight invoice as PAID (since the UPDATE is queued in
    // the same batch above) and ignores invoices already tagged CLOSED /
    // CANCELLED — so repeat POSTs or mixed-status SOs are safe. De-dupe
    // on salesOrderId because multiple allocations in the same payment
    // can target different invoices of the same SO; we only need to emit
    // one UPDATE + audit row per SO.
    const seenClosedSO = new Set<string>();
    for (const fp of fullyPaidInvoices) {
      if (!fp.deliveryOrderId) continue;
      const snap = invoiceSnapshots.get(fp.invoiceId);
      const soKey = snap?.salesOrderId;
      if (!soKey || seenClosedSO.has(soKey)) continue;
      const closeStmts = await previewCascadeSOClosed(
        c.var.DB,
        fp.invoiceId,
        fp.deliveryOrderId,
        now,
      );
      if (closeStmts.length === 0) continue;
      seenClosedSO.add(soKey);
      statements.push(...closeStmts);
    }

    await c.var.DB.batch(statements);

    const created = await c.var.DB.prepare(
      "SELECT * FROM payment_records WHERE id = ?",
    )
      .bind(id)
      .first<PaymentRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create payment" },
        500,
      );
    }
    return c.json({ success: true, data: rowToPayment(created) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/payments/:id — single
app.get("/:id", async (c) => {
  const row = await c.var.DB.prepare(
    "SELECT * FROM payment_records WHERE id = ?",
  )
    .bind(c.req.param("id"))
    .first<PaymentRow>();
  if (!row) {
    return c.json({ success: false, error: "Payment not found" }, 404);
  }
  return c.json({ success: true, data: rowToPayment(row) });
});

// PUT /api/payments/:id — status transitions (RECEIVED → CLEARED / BOUNCED).
// BOUNCED rolls back invoice paidAmount/status exactly like the old impl.
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM payment_records WHERE id = ?",
    )
      .bind(id)
      .first<PaymentRow>();
    if (!existing) {
      return c.json({ success: false, error: "Payment not found" }, 404);
    }

    const body = await c.req.json();
    const currentStatus = existing.status ?? "RECEIVED";

    if (!body.status || body.status === currentStatus) {
      return c.json({ success: true, data: rowToPayment(existing) });
    }

    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(body.status)) {
      return c.json(
        {
          success: false,
          error: `Cannot transition from ${currentStatus} to ${body.status}. Allowed: ${allowed.join(", ") || "none"}`,
        },
        400,
      );
    }

    const allocs = parseAllocations(existing.allocations);
    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        "UPDATE payment_records SET status = ? WHERE id = ?",
      ).bind(body.status, id),
    ];

    if (body.status === "BOUNCED" && currentStatus !== "BOUNCED") {
      const now = new Date().toISOString();
      // Re-fetch current paidAmount for each allocated invoice so rollback
      // math is based on live state, not stale local state.
      const invoiceIds = [...new Set(allocs.map((a) => a.invoiceId))].filter(
        (id) => id,
      );
      let totalRolledBack = 0;
      if (invoiceIds.length > 0) {
        const placeholders = invoiceIds.map(() => "?").join(",");
        const invs = await c.var.DB.prepare(
          `SELECT id, paidAmount, totalSen FROM invoices WHERE id IN (${placeholders})`,
        )
          .bind(...invoiceIds)
          .all<{ id: string; paidAmount: number; totalSen: number }>();
        const invMap = new Map(
          (invs.results ?? []).map((i) => [i.id, i]),
        );
        // Sum allocations per invoice before applying.
        const deltaByInvoice = new Map<string, number>();
        for (const alloc of allocs) {
          deltaByInvoice.set(
            alloc.invoiceId,
            (deltaByInvoice.get(alloc.invoiceId) ?? 0) + alloc.amount,
          );
        }
        for (const [invoiceId, delta] of deltaByInvoice) {
          const inv = invMap.get(invoiceId);
          if (!inv) continue;
          const newPaid = Math.max(0, inv.paidAmount - delta);
          const newStatus =
            newPaid <= 0
              ? "SENT"
              : newPaid < inv.totalSen
                ? "PARTIAL_PAID"
                : "PAID";
          totalRolledBack += Math.min(delta, inv.paidAmount);
          statements.push(
            c.var.DB.prepare(
              `UPDATE invoices SET paidAmount = ?, status = ?, updated_at = ? WHERE id = ?`,
            ).bind(newPaid, newStatus, now, invoiceId),
          );
        }
      }
      // Restore the customer's A/R — bounce means the money never cleared.
      if (totalRolledBack > 0) {
        statements.push(
          c.var.DB.prepare(
            `UPDATE customers SET outstandingSen = outstandingSen + ? WHERE id = ?`,
          ).bind(totalRolledBack, existing.customerId),
        );
      }
    }

    await c.var.DB.batch(statements);

    const updated = await c.var.DB.prepare(
      "SELECT * FROM payment_records WHERE id = ?",
    )
      .bind(id)
      .first<PaymentRow>();
    return c.json({
      success: true,
      data: updated ? rowToPayment(updated) : null,
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;
