// ---------------------------------------------------------------------------
// D1-backed Consignments route.
//
// Uses consignment_notes + consignment_items tables (both in 0001_init.sql).
// Shares the same underlying table as routes/consignment-notes.ts; this
// file mirrors the old /api/consignments surface (validates customer exists,
// returns nested `items` array, supports DELETE-with-data response).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type NoteRow = {
  id: string;
  noteNumber: string;
  type: string | null;
  customerId: string;
  customerName: string | null;
  branchName: string | null;
  sentDate: string | null;
  status: string | null;
  totalValue: number;
  notes: string | null;
};

type ItemRow = {
  id: string;
  consignmentNoteId: string;
  productId: string | null;
  productName: string | null;
  productCode: string | null;
  quantity: number;
  unitPrice: number;
  status: string | null;
  soldDate: string | null;
  returnedDate: string | null;
};

function rowToNote(row: NoteRow, items: ItemRow[] = []) {
  return {
    id: row.id,
    noteNumber: row.noteNumber,
    type: row.type ?? "OUT",
    customerId: row.customerId,
    customerName: row.customerName ?? "",
    branchName: row.branchName ?? "",
    sentDate: row.sentDate ?? "",
    status: row.status ?? "ACTIVE",
    totalValue: row.totalValue,
    notes: row.notes ?? "",
    items: items
      .filter((it) => it.consignmentNoteId === row.id)
      .map((it) => ({
        id: it.id,
        productId: it.productId ?? "",
        productName: it.productName ?? "",
        productCode: it.productCode ?? "",
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        status: it.status ?? "AT_BRANCH",
        soldDate: it.soldDate,
        returnedDate: it.returnedDate,
      })),
  };
}

function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function nextConsignmentNumber(
  db: D1Database,
  now: Date,
): Promise<string> {
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `CON-${yy}${mm}-`;
  const res = await db
    .prepare("SELECT COUNT(*) as n FROM consignment_notes WHERE noteNumber LIKE ?")
    .bind(`${prefix}%`)
    .first<{ n: number }>();
  const seq = (res?.n ?? 0) + 1;
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

// GET /api/consignments
app.get("/", async (c) => {
  const status = c.req.query("status");
  const customerId = c.req.query("customerId");
  const clauses: string[] = [];
  const params: string[] = [];
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (customerId) {
    clauses.push("customerId = ?");
    params.push(customerId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const [notesRes, itemsRes] = await Promise.all([
    c.var.DB.prepare(`SELECT * FROM consignment_notes ${where}`)
      .bind(...params)
      .all<NoteRow>(),
    c.var.DB.prepare("SELECT * FROM consignment_items").all<ItemRow>(),
  ]);
  const data = (notesRes.results ?? []).map((r) =>
    rowToNote(r, itemsRes.results ?? []),
  );
  return c.json({ success: true, data, total: data.length });
});

// POST /api/consignments — creates note + items atomically, validates customer
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const customer = await c.var.DB.prepare(
      "SELECT id, name FROM customers WHERE id = ?",
    )
      .bind(body.customerId)
      .first<{ id: string; name: string }>();
    if (!customer) {
      return c.json({ success: false, error: "Customer not found" }, 400);
    }

    const now = new Date();
    const noteNumber = await nextConsignmentNumber(c.var.DB, now);
    const id = genId("con");

    const rawItems = Array.isArray(body.items) ? body.items : [];
    const itemRows: ItemRow[] = rawItems.map(
      (it: Record<string, unknown>) => ({
        id: genId("coni"),
        consignmentNoteId: id,
        productId: (it.productId as string) ?? "",
        productName: (it.productName as string) ?? "",
        productCode: (it.productCode as string) ?? "",
        quantity: Number(it.quantity) || 1,
        unitPrice: Number(it.unitPrice) || 0,
        status: "AT_BRANCH",
        soldDate: null,
        returnedDate: null,
      }),
    );
    const totalValue = itemRows.reduce(
      (sum, it) => sum + it.unitPrice * it.quantity,
      0,
    );

    const stmts: D1PreparedStatement[] = [];
    stmts.push(
      c.var.DB.prepare(
        `INSERT INTO consignment_notes (id, noteNumber, type, customerId, customerName,
           branchName, sentDate, status, totalValue, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        noteNumber,
        body.type ?? "OUT",
        customer.id,
        customer.name,
        body.branchName ?? customer.name,
        body.sentDate ?? now.toISOString().split("T")[0],
        "ACTIVE",
        totalValue,
        body.notes ?? "",
      ),
    );
    for (const it of itemRows) {
      stmts.push(
        c.var.DB.prepare(
          `INSERT INTO consignment_items (id, consignmentNoteId, productId, productName,
             productCode, quantity, unitPrice, status, soldDate, returnedDate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          it.id,
          it.consignmentNoteId,
          it.productId,
          it.productName,
          it.productCode,
          it.quantity,
          it.unitPrice,
          it.status,
          it.soldDate,
          it.returnedDate,
        ),
      );
    }
    await c.var.DB.batch(stmts);

    const created = await c.var.DB.prepare(
      "SELECT * FROM consignment_notes WHERE id = ?",
    )
      .bind(id)
      .first<NoteRow>();
    if (!created) {
      return c.json({ success: false, error: "Failed to create consignment" }, 500);
    }
    return c.json({ success: true, data: rowToNote(created, itemRows) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/consignments/:id
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [row, items] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM consignment_notes WHERE id = ?")
      .bind(id)
      .first<NoteRow>(),
    c.var.DB.prepare(
      "SELECT * FROM consignment_items WHERE consignmentNoteId = ?",
    )
      .bind(id)
      .all<ItemRow>(),
  ]);
  if (!row) {
    return c.json({ success: false, error: "Consignment not found" }, 404);
  }
  return c.json({
    success: true,
    data: rowToNote(row, items.results ?? []),
  });
});

// PUT /api/consignments/:id
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM consignment_notes WHERE id = ?",
    )
      .bind(id)
      .first<NoteRow>();
    if (!existing) {
      return c.json({ success: false, error: "Consignment not found" }, 404);
    }
    const body = await c.req.json();
    const merged = {
      status: body.status ?? existing.status,
      notes: body.notes ?? existing.notes ?? "",
      branchName: body.branchName ?? existing.branchName ?? "",
      totalValue: existing.totalValue,
    };

    // If items provided, replace them and recompute totalValue
    if (Array.isArray(body.items)) {
      const stmts: D1PreparedStatement[] = [];
      stmts.push(
        c.var.DB.prepare(
          "DELETE FROM consignment_items WHERE consignmentNoteId = ?",
        ).bind(id),
      );
      let total = 0;
      for (const it of body.items as Record<string, unknown>[]) {
        const qty = Number(it.quantity) || 1;
        const price = Number(it.unitPrice) || 0;
        total += qty * price;
        stmts.push(
          c.var.DB.prepare(
            `INSERT INTO consignment_items (id, consignmentNoteId, productId, productName,
               productCode, quantity, unitPrice, status, soldDate, returnedDate)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            (it.id as string) ?? genId("coni"),
            id,
            (it.productId as string) ?? "",
            (it.productName as string) ?? "",
            (it.productCode as string) ?? "",
            qty,
            price,
            (it.status as string) ?? "AT_BRANCH",
            (it.soldDate as string | null) ?? null,
            (it.returnedDate as string | null) ?? null,
          ),
        );
      }
      merged.totalValue = total;
      await c.var.DB.batch(stmts);
    }

    await c.var.DB.prepare(
      "UPDATE consignment_notes SET status = ?, notes = ?, branchName = ?, totalValue = ? WHERE id = ?",
    )
      .bind(
        merged.status,
        merged.notes,
        merged.branchName,
        merged.totalValue,
        id,
      )
      .run();

    const [updated, items] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM consignment_notes WHERE id = ?")
        .bind(id)
        .first<NoteRow>(),
      c.var.DB.prepare(
        "SELECT * FROM consignment_items WHERE consignmentNoteId = ?",
      )
        .bind(id)
        .all<ItemRow>(),
    ]);
    if (!updated) {
      return c.json({ success: false, error: "Consignment not found" }, 404);
    }
    return c.json({
      success: true,
      data: rowToNote(updated, items.results ?? []),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/consignments/:id
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM consignment_notes WHERE id = ?",
  )
    .bind(id)
    .first<NoteRow>();
  if (!existing) {
    return c.json({ success: false, error: "Consignment not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM consignment_notes WHERE id = ?")
    .bind(id)
    .run();
  // consignment_items cascades via FK
  return c.json({ success: true });
});

export default app;
