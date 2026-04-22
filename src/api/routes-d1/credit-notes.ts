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

    await c.env.DB.prepare(
      `INSERT INTO credit_notes (id, noteNumber, invoiceId, invoiceNumber, customerId,
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

// PUT /api/credit-notes/:id — update status / approvedBy
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

    await c.env.DB.prepare(
      "UPDATE credit_notes SET status = ?, approvedBy = ? WHERE id = ?",
    )
      .bind(status, approvedBy, id)
      .run();

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
