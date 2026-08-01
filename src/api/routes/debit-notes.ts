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
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { emitAudit } from "../lib/audit";
import {
  buildJournalEntryStatements,
  ledgerHasSource,
} from "../lib/journal-hash";
import { buildDebitNoteLedgerLegs } from "../lib/note-ledger";

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

// Tier D D2 fix 2026-05-21 — mirror of PR 0 #6 for Credit Notes. The
// original `unitPrice` / `total` field names were unit-ambiguous; a
// caller posting `unitPrice: 4800.00` (RM 4800) would land 4800 in
// `outstandingSen` (= RM 48, 100× off). Renamed to `unitPriceSen` /
// `totalSen` at the JSON shape boundary, with read-side back-compat
// for legacy rows.
type DNItem = {
  description: string;
  quantity: number;
  unitPriceSen: number;
  totalSen: number;
};

type LegacyDNItem = {
  description: string;
  quantity: number;
  unitPrice?: number;
  total?: number;
  unitPriceSen?: number;
  totalSen?: number;
};

function parseItems(raw: string | null): DNItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as LegacyDNItem[];
    return parsed.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPriceSen: item.unitPriceSen ?? item.unitPrice ?? 0,
      totalSen: item.totalSen ?? item.total ?? 0,
    }));
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

async function nextDNNo(db: D1Database): Promise<string> {
  // DN-YYMM-NNN sequential. Bug fix 2026-04-28: previous Math.random
  // sequence was collision-prone and not monotonic. Same pattern as
  // SO/PO/DO/GRN/PI/CN.
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(
    now.getMonth() + 1,
  ).padStart(2, "0")}`;
  const prefix = `DN-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT noteNumber FROM debit_notes WHERE noteNumber LIKE ? ORDER BY noteNumber DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ noteNumber: string }>();
  if (!res) return `${prefix}001`;
  const tail = res.noteNumber.replace(prefix, "");
  const seq = parseInt(tail, 10);
  if (!Number.isFinite(seq)) return `${prefix}001`;
  return `${prefix}${String(seq + 1).padStart(3, "0")}`;
}

// GET /api/debit-notes — list all
app.get("/", async (c) => {
  // RBAC gate (P3.3-followup) — debit-notes:read.
  const denied = await requirePermission(c, "debit-notes", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const res = await c.var.DB.prepare(
    "SELECT * FROM debit_notes WHERE orgId = ? ORDER BY date DESC",
  )
    .bind(orgId)
    .all<DebitNoteRow>();
  const data = (res.results ?? []).map(rowToDebitNote);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/debit-notes — create
app.post("/", async (c) => {
  // RBAC gate (P3.3-followup) — debit-notes:create.
  const denied = await requirePermission(c, "debit-notes", "create");
  if (denied) return denied;
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
    // PR 5 (2026-05-20) — pull the customer-block fields so DN can
    // snapshot them. Mirror of the credit-notes.ts treatment.
    const invoice = await c.var.DB.prepare(
      `SELECT id, invoiceNo, customerId, customerName, customerState,
              customerAddress, attention, customerPhone
         FROM invoices WHERE id = ?`,
    )
      .bind(invoiceId)
      .first<{
        id: string;
        invoiceNo: string;
        customerId: string;
        customerName: string;
        customerState: string | null;
        customerAddress: string | null;
        attention: string | null;
        customerPhone: string | null;
      }>();
    if (!invoice) {
      return c.json({ success: false, error: "Invoice not found" }, 404);
    }

    // Tier D D2 — strict validation: reject unitPrice (legacy ambiguous),
    // require unitPriceSen integer.
    const rawItems = items as Array<{
      description?: string;
      quantity?: number;
      unitPriceSen?: number;
      unitPrice?: number;
    }>;
    const parsedItems: DNItem[] = [];
    for (const item of rawItems) {
      if (item.unitPriceSen === undefined && item.unitPrice !== undefined) {
        return c.json(
          {
            success: false,
            error: `Debit note item must send 'unitPriceSen' (integer sen), not 'unitPrice'. Use Math.round(rm * 100) on the client.`,
          },
          400,
        );
      }
      const unitPriceSen = Number(item.unitPriceSen);
      if (!Number.isInteger(unitPriceSen) || unitPriceSen < 0) {
        return c.json(
          {
            success: false,
            error: `Debit note unitPriceSen must be a non-negative integer (got ${item.unitPriceSen}).`,
          },
          400,
        );
      }
      const quantity = Number(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return c.json(
          {
            success: false,
            error: `Debit note quantity must be > 0 (got ${item.quantity}).`,
          },
          400,
        );
      }
      parsedItems.push({
        description: String(item.description ?? ""),
        quantity,
        unitPriceSen,
        totalSen: quantity * unitPriceSen,
      });
    }
    const totalAmount = parsedItems.reduce((sum, item) => sum + item.totalSen, 0);

    const id = genId();
    const noteNumber = await nextDNNo(c.var.DB);
    const date = new Date().toISOString().split("T")[0];

    await c.var.DB.prepare(
      // PR 5 — INSERT carries customerState / customerAddress /
      // attention / customerPhone snapshotted from the invoice.
      `INSERT INTO debit_notes (id, noteNumber, invoiceId, invoiceNumber, customerId,
         customerName, customerState, customerAddress, attention, customerPhone,
         date, reason, reasonDetail, totalAmount, status, approvedBy, items)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        noteNumber,
        invoice.id,
        invoice.invoiceNo,
        invoice.customerId,
        invoice.customerName,
        invoice.customerState,
        invoice.customerAddress,
        invoice.attention,
        invoice.customerPhone,
        date,
        reason,
        reasonDetail || "",
        totalAmount,
        "DRAFT",
        null,
        JSON.stringify(parsedItems),
      )
      .run();

    const created = await c.var.DB.prepare(
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
    // Audit emit (P3.4) — DN create. Sensitive because issuing a DN
    // increments customer A/R and can bump an invoice's totalSen.
    await emitAudit(c, {
      resource: "debit-notes",
      resourceId: id,
      action: "create",
      after: rowToDebitNote(created),
    });
    return c.json({ success: true, data: rowToDebitNote(created) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/debit-notes/:id — single
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, "debit-notes", "read");
  if (denied) return denied;
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
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
  // RBAC gate (P3.3-followup) — debit-notes:update.
  const denied = await requirePermission(c, "debit-notes", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
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
      c.var.DB.prepare(
        "UPDATE debit_notes SET status = ?, approvedBy = ? WHERE id = ?",
      ).bind(status, approvedBy, id),
    ];

    if (transitionedToPosted && existing.totalAmount > 0) {
      // Customer A/R: a debit note adds to what the customer owes.
      statements.push(
        c.var.DB.prepare(
          `UPDATE customers SET outstandingSen = outstandingSen + ? WHERE id = ?`,
        ).bind(existing.totalAmount, existing.customerId),
      );
      // If pinned to a specific invoice, bump that invoice's totalSen AND
      // re-evaluate its status. Phase 1 fix (2026-06): the original code
      // bumped totals without touching status, so a PAID invoice gained a
      // DN, owed money again, yet still displayed PAID and dropped out of
      // aging. Mirror of buildInvoiceCascadeForCN with the sign flipped:
      //   paidAmount >= newTotal && paidAmount > 0 → PAID
      //   paidAmount > 0                            → PARTIAL_PAID
      //   else                                      → SENT (re-opened)
      if (existing.invoiceId) {
        const inv = await c.var.DB.prepare(
          "SELECT totalSen, subtotalSen, paidAmount, status FROM invoices WHERE id = ?",
        )
          .bind(existing.invoiceId)
          .first<{
            totalSen: number;
            subtotalSen: number;
            paidAmount: number;
            status: string;
          }>();
        if (inv) {
          const now = new Date().toISOString();
          const newTotal = (Number(inv.totalSen) || 0) + existing.totalAmount;
          const newSubtotal =
            (Number(inv.subtotalSen) || 0) + existing.totalAmount;
          const paid = Number(inv.paidAmount) || 0;
          const nextStatus =
            paid >= newTotal && paid > 0
              ? "PAID"
              : paid > 0
                ? "PARTIAL_PAID"
                : inv.status === "PAID"
                  ? "SENT"
                  : inv.status;
          statements.push(
            c.var.DB.prepare(
              `UPDATE invoices
                 SET totalSen = ?, subtotalSen = ?, status = ?, updated_at = ?
               WHERE id = ?`,
            ).bind(newTotal, newSubtotal, nextStatus, now, existing.invoiceId),
          );
        }
      }

      // Phase 1 (2026-06) — GL legs in the SAME batch as the cascade:
      // DR debtor control / CR 500 sales (+ CR 350 output tax). Build
      // failure ABORTS the request — the subledger must never move
      // without the GL.
      try {
        const orgId = getOrgId(c);
        const actorUserId =
          (
            c as unknown as { get: (k: string) => string | undefined }
          ).get("userId") ?? null;
        if (!(await ledgerHasSource(c.var.DB, orgId, "debit_note", id))) {
          const legs = await buildDebitNoteLedgerLegs(
            c.var.DB,
            orgId,
            {
              id,
              noteNumber: existing.noteNumber,
              customerId: existing.customerId,
              reason: existing.reason,
            },
            existing.totalAmount,
            actorUserId,
          );
          const { statements: ledgerStmts } =
            await buildJournalEntryStatements(c.var.DB, orgId, legs);
          statements.push(...ledgerStmts);
        }
      } catch (e) {
        console.error(`[ledger] DN ${id} GL build failed — aborting:`, e);
        return c.json(
          {
            success: false,
            error:
              "Failed to build the GL posting for this debit note — nothing was saved. Retry, and report if it persists.",
          },
          500,
        );
      }
    }

    await c.var.DB.batch(statements);

    const updated = await c.var.DB.prepare(
      "SELECT * FROM debit_notes WHERE id = ?",
    )
      .bind(id)
      .first<DebitNoteRow>();
    if (!updated) {
      return c.json({ success: false, error: "Debit note not found" }, 404);
    }
    // Mirror of the credit-note gap: create was audited, the status transition
    // that actually charges the customer and posts the GL legs was not.
    await emitAudit(c, {
      resource: "debit-notes",
      resourceId: id,
      action: "update",
      before: rowToDebitNote(existing),
      after: rowToDebitNote(updated),
    });
    return c.json({ success: true, data: rowToDebitNote(updated) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;
