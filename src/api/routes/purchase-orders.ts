// ---------------------------------------------------------------------------
// D1-backed purchase-orders route.
//
// Mirrors the old src/api/routes/purchase-orders.ts response shape so the SPA
// frontend does not need any changes. `items` is a nested array joined from
// the purchase_order_items table.
//
// Schema-note: D1 stores timestamps as `created_at`/`updated_at` (snake_case)
// but the TS type exposes `createdAt`/`updatedAt` (camelCase); the row->API
// mapper handles the rename.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { supplierPoEmailTemplate } from "../lib/email";
import { enqueueEmail } from "../lib/email-outbox";
import { emitAudit } from "../lib/audit";

const app = new Hono<Env>();

type PurchaseOrderRow = {
  id: string;
  poNo: string;
  supplierId: string;
  supplierName: string | null;
  subtotalSen: number;
  totalSen: number;
  status: string;
  orderDate: string | null;
  expectedDate: string | null;
  receivedDate: string | null;
  notes: string | null;
  // 3.1 — manual "Email to Supplier" button stamps this on each send so
  // the FE can show "Last sent: …" + a Resend affordance. Nullable until
  // first send. Column added by ensurePendingMigrations() below.
  lastEmailedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type PurchaseOrderItemRow = {
  id: string;
  purchaseOrderId: string;
  materialCategory: string | null;
  materialName: string | null;
  supplierSKU: string | null;
  quantity: number;
  unitPriceSen: number;
  totalSen: number;
  receivedQty: number;
  unit: string | null;
};

// PO lifecycle. RECEIVED → CLOSED added 2026-04-26 to match the
// frontend's "Close PO" action button on procurement/detail.tsx — the
// previous backend transition map ended at RECEIVED with no further
// allowed states, so clicking Close PO returned 400 (the audit caught
// this as a FE/BE drift). CLOSED is terminal: nothing more flows from
// it. CANCELLED is also terminal.
const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PARTIAL_RECEIVED", "RECEIVED", "CANCELLED"],
  PARTIAL_RECEIVED: ["RECEIVED", "CANCELLED"],
  RECEIVED: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

function rowToItem(r: PurchaseOrderItemRow) {
  return {
    id: r.id,
    materialCategory: r.materialCategory ?? "",
    materialName: r.materialName ?? "",
    supplierSKU: r.supplierSKU ?? "",
    quantity: r.quantity,
    unitPriceSen: r.unitPriceSen,
    totalSen: r.totalSen,
    receivedQty: r.receivedQty,
    unit: r.unit ?? "pcs",
  };
}

function rowToPO(row: PurchaseOrderRow, items: PurchaseOrderItemRow[] = []) {
  return {
    id: row.id,
    poNo: row.poNo,
    supplierId: row.supplierId,
    supplierName: row.supplierName ?? "",
    items: items.filter((i) => i.purchaseOrderId === row.id).map(rowToItem),
    subtotalSen: row.subtotalSen,
    totalSen: row.totalSen,
    status: row.status,
    orderDate: row.orderDate ?? "",
    expectedDate: row.expectedDate ?? "",
    receivedDate: row.receivedDate,
    notes: row.notes ?? "",
    lastEmailedAt: row.lastEmailedAt ?? null,
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
  };
}

function genPoId(): string {
  return `po-${crypto.randomUUID().slice(0, 8)}`;
}
function genItemId(): string {
  return `poi-${crypto.randomUUID().slice(0, 8)}`;
}

// Compute the next-suffix poNo for the current YYMM prefix. Pure scan-and-
// increment — concurrency safety lives in the retry wrapper below.
async function nextPoNoCandidate(db: D1Database): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `PO-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT poNo FROM purchase_orders WHERE poNo LIKE ? ORDER BY poNo DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ poNo: string }>();
  const seq = res?.poNo ? Number(res.poNo.split("-").pop()) + 1 : 1;
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

// 5.3 — concurrency-safe poNo generator. Two simultaneous POSTs in the
// same month would otherwise collide on the bare scan above — both see
// the same max suffix, both compute the same next number, the second
// INSERT trips the new ux_purchase_orders_po_no UNIQUE index. We catch
// that 23505 / "UNIQUE" error path, re-scan, and retry up to 5 times
// (each retry races against any other in-flight inserts so it's not a
// fixed answer — re-scan picks up whichever insert just landed).
//
// NOTE: callers consume this poNo immediately in the same INSERT. If
// the INSERT fails with a UNIQUE collision, the caller catches and
// retries via tryGeneratePoNoAndInsert below.
const generatePoNo = nextPoNoCandidate;

const PO_NO_RETRY_LIMIT = 5;

function isPoNoUniqueViolation(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  // Postgres 23505 / SQLite "UNIQUE constraint failed" / generic "duplicate"
  // are all surfaced through the same DB layer here.
  return (
    msg.includes("23505") ||
    msg.includes("UNIQUE constraint failed") ||
    /duplicate key/i.test(msg) ||
    /ux_purchase_orders_po_no/i.test(msg)
  );
}

async function fetchPOWithItems(db: D1Database, id: string) {
  const [po, itemsRes] = await Promise.all([
    db
      .prepare("SELECT * FROM purchase_orders WHERE id = ?")
      .bind(id)
      .first<PurchaseOrderRow>(),
    db
      .prepare("SELECT * FROM purchase_order_items WHERE purchaseOrderId = ?")
      .bind(id)
      .all<PurchaseOrderItemRow>(),
  ]);
  if (!po) return null;
  return rowToPO(po, itemsRes.results ?? []);
}

// GET /api/purchase-orders — list all POs + items
app.get("/", async (c) => {
  // RBAC gate (P3.3-followup) — purchase-orders:read.
  const denied = await requirePermission(c, "purchase-orders", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const [pos, items] = await Promise.all([
    c.var.DB.prepare(
      "SELECT * FROM purchase_orders WHERE orgId = ? ORDER BY created_at DESC, id DESC",
    )
      .bind(orgId)
      .all<PurchaseOrderRow>(),
    c.var.DB.prepare(
      "SELECT * FROM purchase_order_items WHERE orgId = ?",
    )
      .bind(orgId)
      .all<PurchaseOrderItemRow>(),
  ]);
  const data = (pos.results ?? []).map((p) =>
    rowToPO(p, items.results ?? []),
  );
  return c.json({ success: true, data });
});

// POST /api/purchase-orders — create PO + items atomically
app.post("/", async (c) => {
  // RBAC gate (P3.3-followup) — purchase-orders:create.
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;
  // 5.3 — make sure the unique-poNo index exists before we rely on it for
  // concurrency safety. Idempotent + cheap; same one-shot promise pattern
  // as sales-orders.ts.
  await ensurePendingMigrations(c.var.DB);
  try {
    const body = await c.req.json();
    const { supplierId, supplierName } = body;
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!supplierId || !supplierName || rawItems.length === 0) {
      return c.json(
        {
          success: false,
          error: "supplierId, supplierName, and items are required",
        },
        400,
      );
    }

    // Validate supplier exists
    const supplier = await c.var.DB.prepare(
      "SELECT id FROM suppliers WHERE id = ?",
    )
      .bind(supplierId)
      .first<{ id: string }>();
    if (!supplier) {
      return c.json({ success: false, error: "Supplier not found" }, 400);
    }

    const poId = genPoId();
    const now = new Date().toISOString();
    const today = now.split("T")[0];

    const poItems = rawItems as Array<Record<string, unknown>>;
    for (let i = 0; i < poItems.length; i++) {
      const q = Number(poItems[i].quantity);
      const p = Number(poItems[i].unitPriceSen);
      if (!Number.isFinite(q) || q < 0) {
        return c.json({ success: false, error: `items[${i}]: quantity must be a number >= 0` }, 400);
      }
      if (!Number.isFinite(p) || p < 0) {
        return c.json({ success: false, error: `items[${i}]: unitPriceSen must be a number >= 0` }, 400);
      }
    }
    const items = poItems.map((item) => {
      const quantity = Number(item.quantity) || 0;
      const unitPriceSen = Number(item.unitPriceSen) || 0;
      return {
        id: genItemId(),
        materialCategory: (item.materialCategory as string) ?? "",
        materialName: (item.materialName as string) ?? "",
        supplierSKU: (item.supplierSKU as string) ?? "",
        quantity,
        unitPriceSen,
        totalSen: quantity * unitPriceSen,
        receivedQty: 0,
        unit: (item.unit as string) ?? "pcs",
      };
    });
    const subtotalSen = items.reduce((sum, i) => sum + i.totalSen, 0);
    const status: string = body.status ?? "DRAFT";

    // 5.3 — retry-on-unique-collision. Two concurrent POSTs in the same
    // YYMM bucket would otherwise both compute the same suffix and the
    // second INSERT would trip ux_purchase_orders_po_no. We catch the
    // 23505 path, re-scan max+1 (which now includes whichever insert
    // just landed), and try again. After 5 attempts we give up and let
    // the operator retry — by then the contention storm is real.
    let poNo = await generatePoNo(c.var.DB);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < PO_NO_RETRY_LIMIT; attempt++) {
      const statements = [
        c.var.DB.prepare(
          `INSERT INTO purchase_orders (id, poNo, supplierId, supplierName,
             subtotalSen, totalSen, status, orderDate, expectedDate, receivedDate,
             notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          poId,
          poNo,
          supplierId,
          supplierName,
          subtotalSen,
          subtotalSen,
          status,
          body.orderDate ?? today,
          body.expectedDate ?? "",
          null,
          body.notes ?? "",
          now,
          now,
        ),
        ...items.map((item) =>
          c.var.DB.prepare(
            `INSERT INTO purchase_order_items (id, purchaseOrderId,
               materialCategory, materialName, supplierSKU, quantity,
               unitPriceSen, totalSen, receivedQty, unit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            item.id,
            poId,
            item.materialCategory,
            item.materialName,
            item.supplierSKU,
            item.quantity,
            item.unitPriceSen,
            item.totalSen,
            item.receivedQty,
            item.unit,
          ),
        ),
      ];

      try {
        await c.var.DB.batch(statements);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!isPoNoUniqueViolation(err)) {
          throw err;
        }
        // Re-scan to pick up whichever concurrent insert just won.
        poNo = await generatePoNo(c.var.DB);
      }
    }
    if (lastErr) {
      throw new Error(
        "PO number generation failed after 5 retries — concurrent insert storm",
      );
    }

    const created = await fetchPOWithItems(c.var.DB, poId);
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create purchase order" },
        500,
      );
    }
    // Audit emit (P3.4) — PO create. Snapshot the after-state for the journal.
    await emitAudit(c, {
      resource: "purchase-orders",
      resourceId: poId,
      action: "create",
      after: created,
    });
    return c.json({ success: true, data: created }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/purchase-orders] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error creating purchase order" }, 500);
  }
});

// GET /api/purchase-orders/:id — single PO + items
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "read");
  if (denied) return denied;
  const po = await fetchPOWithItems(c.var.DB, c.req.param("id"));
  if (!po) {
    return c.json({ success: false, error: "Purchase order not found" }, 404);
  }
  return c.json({ success: true, data: po });
});

// PUT /api/purchase-orders/:id — update scalar fields + optionally replace items
app.put("/:id", async (c) => {
  // RBAC gate (P3.3-followup) — base check is purchase-orders:update.
  // Status transitions get stricter row-level checks below:
  //   • SUBMITTED → CONFIRMED  ⇒ purchase-orders:approve
  //   • *         → RECEIVED   ⇒ purchase-orders:receive
  //   • *         → PARTIAL_RECEIVED ⇒ purchase-orders:receive
  const baseDenied = await requirePermission(c, "purchase-orders", "update");
  if (baseDenied) return baseDenied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM purchase_orders WHERE id = ?",
    )
      .bind(id)
      .first<PurchaseOrderRow>();
    if (!existing) {
      return c.json(
        { success: false, error: "Purchase order not found" },
        404,
      );
    }
    const body = await c.req.json();
    const now = new Date().toISOString();

    // Lock supplier + line items once goods have been received against this PO.
    // A POSTED/CONFIRMED GRN has written rm_batches + cost_ledger against the
    // original supplier and prices; editing them here would desync stock/cost
    // from the document (and re-reading receivedQty from the body can even zero
    // it). Status / notes / date edits still flow through.
    const wantsSupplierChange =
      body.supplierId !== undefined && body.supplierId !== existing.supplierId;
    const wantsItemChange = body.items !== undefined;
    if (wantsSupplierChange || wantsItemChange) {
      const postedGrn = await c.var.DB.prepare(
        `SELECT id FROM grns WHERE poId = ? AND status IN ('POSTED','CONFIRMED') LIMIT 1`,
      )
        .bind(id)
        .first<{ id: string }>();
      if (postedGrn) {
        return c.json(
          {
            success: false,
            error: "This PO already has a posted goods receipt — its supplier and line items are locked. Reverse/cancel the GRN first.",
          },
          409,
        );
      }
    }

    // Status transition validation
    if (body.status && body.status !== existing.status) {
      const allowed = VALID_TRANSITIONS[existing.status] || [];
      if (!allowed.includes(body.status)) {
        return c.json(
          {
            success: false,
            error: `Cannot transition from ${existing.status} to ${body.status}. Allowed: ${allowed.join(", ") || "none"}`,
          },
          400,
        );
      }

      // Row-level RBAC for the high-impact status flips.
      if (existing.status === "SUBMITTED" && body.status === "CONFIRMED") {
        const denied = await requirePermission(c, "purchase-orders", "approve");
        if (denied) return denied;
      }
      if (body.status === "RECEIVED" || body.status === "PARTIAL_RECEIVED") {
        const denied = await requirePermission(c, "purchase-orders", "receive");
        if (denied) return denied;
      }

      // 2.3 — Block direct PO→RECEIVED unless a POSTED GRN exists. The
      // previous behaviour auto-created an empty DRAFT GRN here as a
      // cascade, but that's worse than useful: it lets operators flip
      // RECEIVED without ever posting receipts to inventory, leaving
      // rm_batches + cost_ledger empty. Now: requires the operator to
      // create + post a GRN first. CONFIRMED is treated as committed
      // for this check (rare but legal — see grn.ts COMMITTED_STATUSES).
      if (body.status === "RECEIVED") {
        const postedGrn = await c.var.DB.prepare(
          `SELECT id FROM grns
            WHERE poId = ?
              AND status IN ('POSTED','CONFIRMED')
            LIMIT 1`,
        )
          .bind(id)
          .first<{ id: string }>();
        if (!postedGrn) {
          return c.json(
            {
              success: false,
              error: "Create + post a GRN before marking received",
              requiresGrn: true,
            },
            412,
          );
        }
      }
    }

    const statements: D1PreparedStatement[] = [];
    let subtotalSen = existing.subtotalSen;
    let totalSen = existing.totalSen;

    // If items provided, replace them entirely and recompute totals
    if (body.items !== undefined) {
      const rawItems: Array<Record<string, unknown>> = Array.isArray(body.items)
        ? body.items
        : [];
      for (let i = 0; i < rawItems.length; i++) {
        const q = Number(rawItems[i].quantity);
        const p = Number(rawItems[i].unitPriceSen);
        if (!Number.isFinite(q) || q < 0) {
          return c.json({ success: false, error: `items[${i}]: quantity must be a number >= 0` }, 400);
        }
        if (!Number.isFinite(p) || p < 0) {
          return c.json({ success: false, error: `items[${i}]: unitPriceSen must be a number >= 0` }, 400);
        }
      }
      const newItems = rawItems.map((item) => {
        const quantity = Number(item.quantity) || 0;
        const unitPriceSen = Number(item.unitPriceSen) || 0;
        return {
          id: (item.id as string) || genItemId(),
          materialCategory: (item.materialCategory as string) ?? "",
          materialName: (item.materialName as string) ?? "",
          supplierSKU: (item.supplierSKU as string) ?? "",
          quantity,
          unitPriceSen,
          totalSen: quantity * unitPriceSen,
          receivedQty: Number(item.receivedQty) || 0,
          unit: (item.unit as string) ?? "pcs",
        };
      });

      statements.push(
        c.var.DB.prepare(
          "DELETE FROM purchase_order_items WHERE purchaseOrderId = ?",
        ).bind(id),
      );
      for (const item of newItems) {
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO purchase_order_items (id, purchaseOrderId,
               materialCategory, materialName, supplierSKU, quantity,
               unitPriceSen, totalSen, receivedQty, unit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            item.id,
            id,
            item.materialCategory,
            item.materialName,
            item.supplierSKU,
            item.quantity,
            item.unitPriceSen,
            item.totalSen,
            item.receivedQty,
            item.unit,
          ),
        );
      }
      subtotalSen = body.subtotalSen ?? newItems.reduce((s, i) => s + i.totalSen, 0);
      totalSen = body.totalSen ?? subtotalSen;
    } else {
      subtotalSen = body.subtotalSen ?? existing.subtotalSen;
      totalSen = body.totalSen ?? existing.totalSen;
    }

    const merged = {
      supplierId: body.supplierId ?? existing.supplierId,
      supplierName: body.supplierName ?? existing.supplierName ?? "",
      status: body.status ?? existing.status,
      orderDate: body.orderDate ?? existing.orderDate ?? "",
      expectedDate: body.expectedDate ?? existing.expectedDate ?? "",
      receivedDate:
        body.receivedDate !== undefined
          ? body.receivedDate
          : existing.receivedDate,
      notes: body.notes ?? existing.notes ?? "",
    };

    statements.push(
      c.var.DB.prepare(
        `UPDATE purchase_orders SET
           supplierId = ?, supplierName = ?, subtotalSen = ?, totalSen = ?,
           status = ?, orderDate = ?, expectedDate = ?, receivedDate = ?,
           notes = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(
        merged.supplierId,
        merged.supplierName,
        subtotalSen,
        totalSen,
        merged.status,
        merged.orderDate,
        merged.expectedDate,
        merged.receivedDate,
        merged.notes,
        now,
        id,
      ),
    );

    // 2.3 — Procurement cascade removed (formerly auto-created an empty
    // DRAFT GRN on PO→RECEIVED). The pre-flight check above now requires
    // a POSTED GRN before RECEIVED is allowed at all, so the auto-create
    // cascade was a no-op in practice and misleading in code: removed
    // to keep the receipt path single-sourced through grn.ts.

    await c.var.DB.batch(statements);

    // Sprint 4: enqueue supplier notification on the DRAFT/etc → SUBMITTED
    // transition. The cron drain (.github/workflows/process-email-outbox.yml)
    // is what actually contacts Resend, so a Resend outage doesn't backpressure
    // the PO submit. Failures (no email on file, INSERT failure) are logged
    // only and never roll back the PO update.
    if (body.status === "SUBMITTED" && existing.status !== "SUBMITTED") {
      try {
        const supplierRow = await c.var.DB.prepare(
          "SELECT email FROM suppliers WHERE id = ? LIMIT 1",
        )
          .bind(merged.supplierId)
          .first<{ email: string | null }>();
        if (supplierRow?.email) {
          const tpl = supplierPoEmailTemplate({
            poNo: existing.poNo,
            supplierName: merged.supplierName,
          });
          await enqueueEmail(c, {
            to: supplierRow.email,
            subject: tpl.subject,
            html: tpl.html,
            text: tpl.text,
          });
        } else {
          console.log(
            `[purchase-orders] PO ${existing.poNo}: skipped — supplier ${merged.supplierName} (${merged.supplierId}) has no email on file`,
          );
        }
      } catch (err) {
        console.warn(
          "[purchase-orders] supplier notification failed",
          err instanceof Error ? err.message : err,
        );
      }
    }

    const updated = await fetchPOWithItems(c.var.DB, id);
    return c.json({ success: true, data: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[PUT /api/purchase-orders/:id] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error updating purchase order" }, 500);
  }
});

// 3.1 — Self-applying migration for the lastEmailedAt column. Same module-
// level promise pattern as sales-orders.ts:1531. Idempotent ALTER so the
// column appears on first POST per isolate without a separate migration
// deploy. Translated by supabase-compat: lastEmailedAt → last_emailed_at
// (added to column-rename-map.json).
//
// 5.3 — additionally creates the UNIQUE index ux_purchase_orders_po_no so
// concurrent POSTs collide cleanly instead of double-issuing the same
// poNo. CREATE UNIQUE INDEX IF NOT EXISTS is idempotent on Postgres + D1.
// IMPORTANT: this will fail loudly on first run if duplicate poNos already
// exist on the table — that's intentional. The probe at GET
// /api/import/po-no-duplicates must return zero before this rolls out;
// otherwise the catch below swallows the error (best-effort) and the
// subsequent INSERT will keep working without uniqueness protection. To
// detect that case, call the probe explicitly before relying on retry
// behaviour.
let pendingMigrations: Promise<void> | null = null;
function ensurePendingMigrations(db: D1Database): Promise<void> {
  if (pendingMigrations) return pendingMigrations;
  pendingMigrations = (async () => {
    const stmts = [
      "ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS lastEmailedAt TEXT",
      // 5.3 — concurrency guard for generatePoNo. The retry wrapper in
      // POST / depends on this index existing.
      "CREATE UNIQUE INDEX IF NOT EXISTS ux_purchase_orders_po_no ON purchase_orders(poNo)",
    ];
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch (err) {
        console.warn(
          "[purchase-orders] migration: CREATE UNIQUE INDEX failed " +
            "(usually means duplicate poNos exist — run /api/import/po-no-duplicates to investigate). " +
            "Worker will continue without uniqueness enforcement.",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  })();
  return pendingMigrations;
}

// POST /api/purchase-orders/:id/email — manual "Email to Supplier" send.
// Reuses the same enqueueEmail flow as the auto-cascade on DRAFT→SUBMITTED
// (line ~488 above). The cron drain (.github/workflows/process-email-outbox.yml)
// is what actually contacts Resend, so this returns immediately on the
// outbox INSERT — no Resend round-trip on the user's request thread.
//
// Visible on SUBMITTED+ statuses (gate enforced at the FE; backend is
// permissive — even DRAFT can be emailed manually if a permission grant
// reaches here).
app.post("/:id/email", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "update");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);

  const id = c.req.param("id");
  const po = await c.var.DB
    .prepare("SELECT * FROM purchase_orders WHERE id = ?")
    .bind(id)
    .first<PurchaseOrderRow>();
  if (!po) {
    return c.json({ success: false, error: "Purchase order not found" }, 404);
  }

  const supplierRow = await c.var.DB
    .prepare("SELECT email FROM suppliers WHERE id = ? LIMIT 1")
    .bind(po.supplierId)
    .first<{ email: string | null }>();
  if (!supplierRow?.email) {
    return c.json(
      {
        success: false,
        error: `Supplier ${po.supplierName ?? po.supplierId} has no email on file`,
      },
      400,
    );
  }

  try {
    const tpl = supplierPoEmailTemplate({
      poNo: po.poNo,
      supplierName: po.supplierName ?? "",
    });
    await enqueueEmail(c, {
      to: supplierRow.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });
    const now = new Date().toISOString();
    await c.var.DB
      .prepare(
        "UPDATE purchase_orders SET lastEmailedAt = ?, updated_at = ? WHERE id = ?",
      )
      .bind(now, now, id)
      .run();
    return c.json({
      success: true,
      data: { lastEmailedAt: now, to: supplierRow.email },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/purchase-orders/:id/email] failed:", msg, err);
    return c.json(
      { success: false, error: msg || "Failed to enqueue email" },
      500,
    );
  }
});

// DELETE /api/purchase-orders/:id — cascades to items via FK
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await fetchPOWithItems(c.var.DB, id);
  if (!existing) {
    return c.json({ success: false, error: "Purchase order not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM purchase_orders WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true, data: existing });
});

export default app;
