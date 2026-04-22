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

  const res = await c.env.DB.prepare(
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
  try {
    const body = await c.req.json();
    const { customerId, amount, method, reference, allocations } = body;
    if (!customerId || amount === undefined || !method) {
      return c.json(
        { success: false, error: "customerId, amount, and method are required" },
        400,
      );
    }

    const customer = await c.env.DB.prepare(
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
    const invoiceSnapshots = new Map<
      string,
      { invoiceNo: string; paidAmount: number; totalSen: number }
    >();
    if (allocInput.length > 0) {
      const ids = allocInput.map((a) => a.invoiceId);
      const placeholders = ids.map(() => "?").join(",");
      const invs = await c.env.DB.prepare(
        `SELECT id, invoiceNo, paidAmount, totalSen FROM invoices WHERE id IN (${placeholders})`,
      )
        .bind(...ids)
        .all<{
          id: string;
          invoiceNo: string;
          paidAmount: number;
          totalSen: number;
        }>();
      for (const i of invs.results ?? []) {
        invoiceSnapshots.set(i.id, {
          invoiceNo: i.invoiceNo,
          paidAmount: i.paidAmount,
          totalSen: i.totalSen,
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
      c.env.DB.prepare(
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
    for (const alloc of parsedAllocations) {
      const snap = invoiceSnapshots.get(alloc.invoiceId);
      if (!snap) continue;
      const newPaid = snap.paidAmount + alloc.amount;
      const newStatus =
        newPaid >= snap.totalSen
          ? "PAID"
          : newPaid > 0
            ? "PARTIAL_PAID"
            : "SENT";
      statements.push(
        c.env.DB.prepare(
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
        c.env.DB.prepare(
          `UPDATE invoices
             SET paidAmount = ?, status = ?, paymentDate = ?, updated_at = ?
           WHERE id = ?`,
        ).bind(
          newPaid,
          newStatus,
          newStatus === "PAID" ? date : null,
          now,
          alloc.invoiceId,
        ),
      );
    }

    await c.env.DB.batch(statements);

    const created = await c.env.DB.prepare(
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
  const row = await c.env.DB.prepare(
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
    const existing = await c.env.DB.prepare(
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
      c.env.DB.prepare(
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
      if (invoiceIds.length > 0) {
        const placeholders = invoiceIds.map(() => "?").join(",");
        const invs = await c.env.DB.prepare(
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
          statements.push(
            c.env.DB.prepare(
              `UPDATE invoices SET paidAmount = ?, status = ?, updated_at = ? WHERE id = ?`,
            ).bind(newPaid, newStatus, now, invoiceId),
          );
        }
      }
    }

    await c.env.DB.batch(statements);

    const updated = await c.env.DB.prepare(
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
