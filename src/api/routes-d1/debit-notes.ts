// ---------------------------------------------------------------------------
// D1-backed debit-notes route.
//
// Mirrors the old src/api/routes/debit-notes.ts shape so the SPA frontend
// doesn't need any changes. The `items` column is stored as JSON TEXT in D1
// and is parsed back to an array of line items on read / stringified on write.
//
// GET / returns { success, data, total } — note the extra `total` field that
// the frontend expects.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type DebitNoteRow = {
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

type DNItem = {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
};

function parseItems(raw: string | null): DNItem[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as DNItem[];
  } catch {
    return [];
  }
}

function rowToDebitNote(row: DebitNoteRow) {
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
  return `dn-${crypto.randomUUID().slice(0, 8)}`;
}

function nextDNNo(): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(
    now.getMonth() + 1,
  ).padStart(2, "0")}`;
  const seq = String(Math.floor(Math.random() * 900) + 100);
  return `DN-${yymm}-${seq}`;
}

// GET /api/debit-notes — list all
app.get("/", async (c) => {
  const res = await c.env.DB.prepare(
    "SELECT * FROM debit_notes ORDER BY date DESC",
  ).all<DebitNoteRow>();
  const data = (res.results ?? []).map(rowToDebitNote);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/debit-notes — create
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

    const parsedItems: DNItem[] = (
      items as { description: string; quantity: number; unitPrice: number }[]
    ).map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: item.quantity * item.unitPrice,
    }));
    const totalAmount = parsedItems.reduce((sum, item) => sum + item.total, 0);

    const id = genId();
    const noteNumber = nextDNNo();
    const date = new Date().toISOString().split("T")[0];

    await c.env.DB.prepare(
      `INSERT INTO debit_notes (id, noteNumber, invoiceId, invoiceNumber, customerId,
         customerName, date, reason, reasonDetail, totalAmount, status, approvedBy, items)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
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
        "DRAFT",
        null,
        JSON.stringify(parsedItems),
      )
      .run();

    const created = await c.env.DB.prepare(
      "SELECT * FROM debit_notes WHERE id = ?",
    )
      .bind(id)
      .first<DebitNoteRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create debit note" },
        500,
      );
    }
    return c.json({ success: true, data: rowToDebitNote(created) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/debit-notes/:id — single
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT * FROM debit_notes WHERE id = ?",
  )
    .bind(id)
    .first<DebitNoteRow>();
  if (!row) {
    return c.json({ success: false, error: "Debit note not found" }, 404);
  }
  return c.json({ success: true, data: rowToDebitNote(row) });
});

// PUT /api/debit-notes/:id — update status / approvedBy.
// Mirror of the credit-note flow, but inverted: when the DN goes POSTED
// (E5) we INCREMENT customer A/R, and if pinned to an invoice we bump
// that invoice's totalSen. Idempotent: only fires on the actual transition
// into POSTED (not on repeated PUTs with the same status).
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await c.env.DB.prepare(
      "SELECT * FROM debit_notes WHERE id = ?",
    )
      .bind(id)
      .first<DebitNoteRow>();
    if (!existing) {
      return c.json({ success: false, error: "Debit note not found" }, 404);
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

    const transitionedToPosted =
      existing.status !== "POSTED" && status === "POSTED";

    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        "UPDATE debit_notes SET status = ?, approvedBy = ? WHERE id = ?",
      ).bind(status, approvedBy, id),
    ];

    if (transitionedToPosted && existing.totalAmount > 0) {
      // Customer A/R: a debit note adds to what the customer owes.
      statements.push(
        c.env.DB.prepare(
          `UPDATE customers SET outstandingSen = outstandingSen + ? WHERE id = ?`,
        ).bind(existing.totalAmount, existing.customerId),
      );
      // If pinned to a specific invoice, bump that invoice's totalSen
      // so downstream balance math is consistent.
      if (existing.invoiceId) {
        const now = new Date().toISOString();
        statements.push(
          c.env.DB.prepare(
            `UPDATE invoices
               SET totalSen = totalSen + ?,
                   subtotalSen = subtotalSen + ?,
                   updated_at = ?
             WHERE id = ?`,
          ).bind(
            existing.totalAmount,
            existing.totalAmount,
            now,
            existing.invoiceId,
          ),
        );
      }
    }

    await c.env.DB.batch(statements);

    const updated = await c.env.DB.prepare(
      "SELECT * FROM debit_notes WHERE id = ?",
    )
      .bind(id)
      .first<DebitNoteRow>();
    if (!updated) {
      return c.json({ success: false, error: "Debit note not found" }, 404);
    }
    return c.json({ success: true, data: rowToDebitNote(updated) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;
