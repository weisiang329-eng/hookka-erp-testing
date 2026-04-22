// ---------------------------------------------------------------------------
// D1-backed credit-notes route.
//
// Mirrors the old src/api/routes/credit-notes.ts shape so the SPA frontend
// doesn't need any changes. The `items` column is stored as JSON TEXT in D1
// and is parsed back to an array of line items on read / stringified on write.
//
// GET / returns { success, data, total } — note the extra `total` field that
// the frontend expects (same for debit-notes).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type CreditNoteRow = {
  id: string;
  noteNumber: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  customerId: string;
  customerName: string;
  date: string;
  reason: string | null;
  reasonDetail: string | null;
  totalAmount: number;
  status: string | null;
  approvedBy: string | null;
  items: string | null;
};

type CNItem = {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
};

function parseItems(raw: string | null): CNItem[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as CNItem[];
  } catch {
    return [];
  }
}

function rowToCreditNote(row: CreditNoteRow) {
  return {
    id: row.id,
    noteNumber: row.noteNumber,
    invoiceId: row.invoiceId ?? "",
    invoiceNumber: row.invoiceNumber ?? "",
    customerId: row.customerId,
    customerName: row.customerName,
    date: row.date,
    reason: row.reason ?? "OTHER",
    reasonDetail: row.reasonDetail ?? "",
    items: parseItems(row.items),
    totalAmount: row.totalAmount,
    status: row.status ?? "DRAFT",
    approvedBy: row.approvedBy,
  };
}

function genId(): string {
  return `cn-${crypto.randomUUID().slice(0, 8)}`;
}

// A credit note is considered "issued" (i.e. applied against the invoice)
// when it's in any terminal-ish state. The D1 schema only has DRAFT /
// APPROVED / POSTED — treat both APPROVED and POSTED as issued. DRAFT is
// pending and does not mutate the invoice.
function isIssuedStatus(status: string | null | undefined): boolean {
  return status === "APPROVED" || status === "POSTED";
}

// Compose the statements that apply a CN's amount against the linked
// invoice:
//   * totalSen / subtotalSen are reduced by the CN's amountSen (floored at 0);
//   * paidAmount is left alone (we never over-credit);
//   * status is re-evaluated:
//       paidAmount >= new totalSen  → PAID
//       paidAmount >  0             → PARTIAL_PAID
//       (else retain existing status)
//
// Returns [] when the CN has no linked invoice or when amountSen <= 0.
async function buildInvoiceCascadeForCN(
  db: D1Database,
  invoiceId: string,
  amountSen: number,
  nowIso: string,
): Promise<D1PreparedStatement[]> {
  if (!invoiceId || amountSen <= 0) return [];
  const inv = await db
    .prepare(
      "SELECT id, totalSen, subtotalSen, paidAmount, status FROM invoices WHERE id = ?",
    )
    .bind(invoiceId)
    .first<{
      id: string;
      totalSen: number;
      subtotalSen: number;
      paidAmount: number;
      status: string;
    }>();
  if (!inv) return [];

  const newTotal = Math.max(0, inv.totalSen - amountSen);
  const newSubtotal = Math.max(0, inv.subtotalSen - amountSen);
  // paidAmount stays as-is — a credit note does NOT convert into a payment.
  const nextStatus =
    inv.paidAmount >= newTotal && newTotal >= 0 && inv.paidAmount > 0
      ? "PAID"
      : inv.paidAmount > 0
        ? "PARTIAL_PAID"
        : inv.status;

  return [
    db
      .prepare(
        `UPDATE invoices
            SET totalSen = ?, subtotalSen = ?, status = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(newTotal, newSubtotal, nextStatus, nowIso, invoiceId),
  ];
}

function nextCNNo(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(
    now.getMonth() + 1,
  ).padStart(2, "0")}`;
  const seq = String(Math.floor(Math.random() * 900) + 100);
  return `CN-${yymm}-${seq}`;
}

// GET /api/credit-notes — list all
app.get("/", async (c) => {
  const res = await c.env.DB.prepare(
    "SELECT * FROM credit_notes ORDER BY date DESC",
  ).all<CreditNoteRow>();
  const data = (res.results ?? []).map(rowToCreditNote);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/credit-notes — create
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { invoiceId, reason, reasonDetail, items } = body;
    if (!invoiceId || !reason || !items || items.length === 0) {
      return c.json(
        {
          success: false,
          error: "invoiceId, reason, and items are required",
        },
        400,
      );
    }
    const invoice = await c.env.DB.prepare(
      "SELECT id, invoiceNo, customerId, customerName FROM invoices WHERE id = ?",
    )
      .bind(invoiceId)
      .first<{
        id: string;
        invoiceNo: string;
        customerId: string;
        customerName: string;
      }>();
    if (!invoice) {
      return c.json({ success: false, error: "Invoice not found" }, 404);
    }

    const parsedItems: CNItem[] = (
      items as { description: string; quantity: number; unitPrice: number }[]
    ).map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: item.quantity * item.unitPrice,
    }));
    const totalAmount = parsedItems.reduce((sum, item) => sum + item.total, 0);

    const id = genId();
    const noteNumber = nextCNNo();
    const date = new Date().toISOString().split("T")[0];
    const now = new Date().toISOString();

    // Allow the client to create a CN already in APPROVED/POSTED (e.g. from
    // an admin tool). If so, apply the invoice cascade atomically with the
    // insert. DRAFT CNs skip the cascade — they mutate nothing.
    const requestedStatus =
      typeof body.status === "string" &&
      ["DRAFT", "APPROVED", "POSTED"].includes(body.status)
        ? (body.status as string)
        : "DRAFT";
    const approvedBy =
      isIssuedStatus(requestedStatus) && typeof body.approvedBy === "string"
        ? body.approvedBy
        : null;

    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `INSERT INTO credit_notes (id, noteNumber, invoiceId, invoiceNumber, customerId,
           customerName, date, reason, reasonDetail, totalAmount, status, approvedBy, items)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        noteNumber,
        invoice.id,
        invoice.invoiceNo,
        invoice.customerId,
        invoice.customerName,
        date,
        reason,
        reasonDetail || "",
        totalAmount,
        requestedStatus,
        approvedBy,
        JSON.stringify(parsedItems),
      ),
    ];

    if (isIssuedStatus(requestedStatus) && totalAmount > 0) {
      // Mirror the PUT-POSTED path: decrement customer A/R and, if a specific
      // invoice is pinned, re-evaluate invoice totals + status.
      statements.push(
        c.env.DB.prepare(
          `UPDATE customers SET outstandingSen = MAX(0, outstandingSen - ?) WHERE id = ?`,
        ).bind(totalAmount, invoice.customerId),
      );
      const invStmts = await buildInvoiceCascadeForCN(
        c.env.DB,
        invoice.id,
        totalAmount,
        now,
      );
      statements.push(...invStmts);
    }

    await c.env.DB.batch(statements);

    const created = await c.env.DB.prepare(
      "SELECT * FROM credit_notes WHERE id = ?",
    )
      .bind(id)
      .first<CreditNoteRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create credit note" },
        500,
      );
    }
    return c.json({ success: true, data: rowToCreditNote(created) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/credit-notes/:id — single
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT * FROM credit_notes WHERE id = ?",
  )
    .bind(id)
    .first<CreditNoteRow>();
  if (!row) {
    return c.json({ success: false, error: "Credit note not found" }, 404);
  }
  return c.json({ success: true, data: rowToCreditNote(row) });
});

// PUT /api/credit-notes/:id — update status / approvedBy.
//
// The invoice/customer cascade fires on the first transition out of DRAFT
// (DRAFT → APPROVED or DRAFT → POSTED). Once the CN is "issued" (APPROVED
// or POSTED) the invoice totals + customer A/R have already absorbed the
// amount, so a later APPROVED → POSTED (or the reverse) must NOT fire the
// cascade again. Idempotent: repeated PUTs with the same status are a
// no-op beyond the status/approvedBy column update.
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await c.env.DB.prepare(
      "SELECT * FROM credit_notes WHERE id = ?",
    )
      .bind(id)
      .first<CreditNoteRow>();
    if (!existing) {
      return c.json({ success: false, error: "Credit note not found" }, 404);
    }
    const body = await c.req.json();
    let status = existing.status;
    let approvedBy = existing.approvedBy;
    if (body.status) {
      status = body.status;
      if (body.status === "APPROVED" || body.status === "POSTED") {
        approvedBy = body.approvedBy || "Admin";
      }
    }

    // Fire cascade only on the first DRAFT → issued transition. Once the
    // existing row is already APPROVED or POSTED, the invoice cascade has
    // already been applied (either here on the earlier transition, or via
    // POST if the CN was created directly in an issued state).
    const transitionedToIssued =
      !isIssuedStatus(existing.status) && isIssuedStatus(status);

    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        "UPDATE credit_notes SET status = ?, approvedBy = ? WHERE id = ?",
      ).bind(status, approvedBy, id),
    ];

    if (transitionedToIssued && existing.totalAmount > 0) {
      // Customer A/R: a credit note reduces what the customer owes.
      statements.push(
        c.env.DB.prepare(
          `UPDATE customers SET outstandingSen = MAX(0, outstandingSen - ?) WHERE id = ?`,
        ).bind(existing.totalAmount, existing.customerId),
      );
      // If pinned to a specific invoice, reduce that invoice's totalSen and
      // re-evaluate its status (PAID / PARTIAL_PAID) so aging math stays
      // correct. `buildInvoiceCascadeForCN` floors the invoice totals at 0
      // and preserves paidAmount (never over-credits).
      if (existing.invoiceId) {
        const now = new Date().toISOString();
        const invStmts = await buildInvoiceCascadeForCN(
          c.env.DB,
          existing.invoiceId,
          existing.totalAmount,
          now,
        );
        statements.push(...invStmts);
      }
    }

    await c.env.DB.batch(statements);

    const updated = await c.env.DB.prepare(
      "SELECT * FROM credit_notes WHERE id = ?",
    )
      .bind(id)
      .first<CreditNoteRow>();
    if (!updated) {
      return c.json({ success: false, error: "Credit note not found" }, 404);
    }
    return c.json({ success: true, data: rowToCreditNote(updated) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;
