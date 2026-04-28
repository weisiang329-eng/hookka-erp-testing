// ---------------------------------------------------------------------------
// D1-backed Consignment Notes route.
//
// Shares consignment_notes + consignment_items tables with routes/consignments.ts.
// This surface exposes a slightly different API:
//   - GET  /     — list
//   - POST /     — create (no customer validation)
//   - PATCH /    — update status/notes/branchName by body.id
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
  // CGN-YYMM-NNN. Per user 2026-04-28 numbering decision: Credit Note
  // owns CN- (financial standard); Consignment Note moves to CGN- to
  // avoid the collision. Existing CON-* numbers stay valid - the lookup
  // is scoped to the new prefix.
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `CGN-${yy}${mm}-`;
  const res = await db
    .prepare(
      "SELECT noteNumber FROM consignment_notes WHERE noteNumber LIKE ? ORDER BY noteNumber DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ noteNumber: string }>();
  if (!res) return `${prefix}001`;
  const tail = res.noteNumber.replace(prefix, "");
  const seq = parseInt(tail, 10);
  if (!Number.isFinite(seq)) return `${prefix}001`;
  return `${prefix}${String(seq + 1).padStart(3, "0")}`;
}

// GET /api/consignment-notes
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

// POST /api/consignment-notes
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
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
        body.customerId ?? "",
        body.customerName ?? "",
        body.branchName ?? "",
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
      return c.json(
        { success: false, error: "Failed to create consignment note" },
        500,
      );
    }
    return c.json({ success: true, data: rowToNote(created, itemRows) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// PATCH /api/consignment-notes — partial update by body.id
app.patch("/", async (c) => {
  try {
    const body = await c.req.json();
    if (!body.id) {
      return c.json({ success: false, error: "id required in body" }, 400);
    }
    const existing = await c.var.DB.prepare(
      "SELECT * FROM consignment_notes WHERE id = ?",
    )
      .bind(body.id)
      .first<NoteRow>();
    if (!existing) {
      return c.json(
        { success: false, error: "Consignment note not found" },
        404,
      );
    }
    const merged = {
      status: body.status ?? existing.status,
      notes: body.notes ?? existing.notes ?? "",
      branchName: body.branchName ?? existing.branchName ?? "",
    };
    await c.var.DB.prepare(
      "UPDATE consignment_notes SET status = ?, notes = ?, branchName = ? WHERE id = ?",
    )
      .bind(merged.status, merged.notes, merged.branchName, body.id)
      .run();

    const [updated, items] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM consignment_notes WHERE id = ?")
        .bind(body.id)
        .first<NoteRow>(),
      c.var.DB.prepare(
        "SELECT * FROM consignment_items WHERE consignmentNoteId = ?",
      )
        .bind(body.id)
        .all<ItemRow>(),
    ]);
    if (!updated) {
      return c.json(
        { success: false, error: "Consignment note not found" },
        404,
      );
    }
    return c.json({
      success: true,
      data: rowToNote(updated, items.results ?? []),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;
