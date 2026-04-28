// ---------------------------------------------------------------------------
// D1-backed Consignment Orders route. Parallel to sales-orders.ts.
//
// CO is structurally a SO clone — same line-item shape (category, divan/leg,
// fabric, pricing breakdown), same lifecycle (DRAFT → CONFIRMED → IN_PRODUCTION
// → SHIPPED → ...), same downstream production pipeline. Only the source
// numbering differs (CO-25001 vs SO-25001) and the terminal states
// (PARTIALLY_SOLD/FULLY_SOLD/RETURNED carried over from the legacy
// consignment-tracking model).
//
// `POST /:id/confirm` is the integration point that triggers production —
// it cascades through `createProductionOrdersForOrder()` (same engine SO
// uses) which writes production_orders rows with consignmentOrderId set
// and salesOrderId NULL.
//
// Sibling file: routes/consignments.ts still handles the legacy
// `consignment_notes` table (lightweight tracking). Once the new UI lands,
// that file will be repurposed for the shipment role (DO equivalent for
// CO) — see PR 3.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { createProductionOrdersForOrder } from "./_shared/production-builder";
import { checkConsignmentOrderLocked, lockedResponse } from "../lib/lock-helpers";
import { emitAudit } from "../lib/audit";
import { requirePermission } from "../lib/rbac";
import {
  consumeEditLockOverrideToken,
  createEditLockOverride,
  lookupActorDisplayName,
  MIN_OVERRIDE_REASON_LEN,
} from "../lib/edit-lock-override";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Row types — match the consignment_orders / consignment_order_items
// tables created in migration 0064.
// ---------------------------------------------------------------------------
export type ConsignmentOrderRow = {
  id: string;
  customerCO: string | null;
  customerCOId: string | null;
  customerCODate: string | null;
  reference: string | null;
  customerId: string;
  customerName: string;
  customerState: string | null;
  hubId: string | null;
  hubName: string | null;
  companyCO: string | null;
  companyCOId: string | null;
  companyCODate: string | null;
  customerDeliveryDate: string | null;
  hookkaExpectedDD: string | null;
  subtotalSen: number;
  totalSen: number;
  status: string;
  overdue: string | null;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ConsignmentOrderItemRow = {
  id: string;
  consignmentOrderId: string;
  lineNo: number;
  lineSuffix: string | null;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  itemCategory: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  fabricId: string | null;
  fabricCode: string | null;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  specialOrder: string | null;
  specialOrderPriceSen: number;
  basePriceSen: number;
  unitPriceSen: number;
  lineTotalSen: number;
  notes: string | null;
};

function rowToCO(row: ConsignmentOrderRow, items: ConsignmentOrderItemRow[]) {
  return {
    id: row.id,
    customerCO: row.customerCO ?? "",
    customerCOId: row.customerCOId ?? "",
    customerCODate: row.customerCODate ?? "",
    reference: row.reference ?? "",
    customerId: row.customerId,
    customerName: row.customerName,
    customerState: row.customerState ?? "",
    hubId: row.hubId,
    hubName: row.hubName ?? "",
    companyCO: row.companyCO ?? "",
    companyCOId: row.companyCOId ?? "",
    companyCODate: row.companyCODate ?? "",
    customerDeliveryDate: row.customerDeliveryDate ?? "",
    hookkaExpectedDD: row.hookkaExpectedDD ?? "",
    subtotalSen: row.subtotalSen,
    totalSen: row.totalSen,
    status: row.status,
    overdue: row.overdue ?? "PENDING",
    notes: row.notes ?? "",
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
    items: items
      .filter((it) => it.consignmentOrderId === row.id)
      .sort((a, b) => a.lineNo - b.lineNo)
      .map(rowToItem),
  };
}

function rowToItem(it: ConsignmentOrderItemRow) {
  return {
    id: it.id,
    consignmentOrderId: it.consignmentOrderId,
    lineNo: it.lineNo,
    lineSuffix: it.lineSuffix ?? "",
    productId: it.productId ?? "",
    productCode: it.productCode ?? "",
    productName: it.productName ?? "",
    itemCategory: it.itemCategory ?? "",
    sizeCode: it.sizeCode ?? "",
    sizeLabel: it.sizeLabel ?? "",
    fabricId: it.fabricId ?? "",
    fabricCode: it.fabricCode ?? "",
    quantity: it.quantity,
    gapInches: it.gapInches,
    divanHeightInches: it.divanHeightInches,
    divanPriceSen: it.divanPriceSen,
    legHeightInches: it.legHeightInches,
    legPriceSen: it.legPriceSen,
    specialOrder: it.specialOrder ?? "",
    specialOrderPriceSen: it.specialOrderPriceSen,
    basePriceSen: it.basePriceSen,
    unitPriceSen: it.unitPriceSen,
    lineTotalSen: it.lineTotalSen,
    notes: it.notes ?? "",
  };
}

function genCoId(): string {
  return `co-${crypto.randomUUID().slice(0, 8)}`;
}
function genItemId(): string {
  return `coi-${crypto.randomUUID().slice(0, 8)}`;
}

async function nextCompanyCOId(db: D1Database, now: Date): Promise<string> {
  // CO-YYMM-NNN format. Aligned with SO/PO/DO/GRN/PI per user 2026-04-28
  // numbering audit. Sequence is per (year, month) so January resets to
  // 001. Picks max-existing-suffix+1 (NOT count) so deletions don't
  // recycle numbers and clash with old refs.
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `CO-${yy}${mm}-`;
  const res = await db
    .prepare(
      "SELECT companyCOId FROM consignment_orders WHERE companyCOId LIKE ? ORDER BY companyCOId DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ companyCOId: string }>();
  if (!res) return `${prefix}001`;
  const tail = res.companyCOId.replace(prefix, "");
  const seq = parseInt(tail, 10);
  if (!Number.isFinite(seq)) return `${prefix}001`;
  return `${prefix}${String(seq + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// GET /api/consignment-orders — list
// ---------------------------------------------------------------------------
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

  const [orderRes, itemRes] = await Promise.all([
    c.var.DB.prepare(
      `SELECT * FROM consignment_orders ${where} ORDER BY created_at DESC`,
    )
      .bind(...params)
      .all<ConsignmentOrderRow>(),
    c.var.DB.prepare("SELECT * FROM consignment_order_items").all<ConsignmentOrderItemRow>(),
  ]);
  const items = itemRes.results ?? [];
  const data = (orderRes.results ?? []).map((r) => rowToCO(r, items));
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// POST /api/consignment-orders — create CO in DRAFT status. Items pricing
// breakdown is stored verbatim — the same shape SO uses, so the shared
// <OrderLineItemEditor> form on the frontend can submit identical payloads
// to either endpoint.
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "consignments", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();

    // Validate customer exists. Customers table has no `state` column -
    // state lives on delivery_hubs (each customer has many hubs across
    // different states). Bug fix 2026-04-28: SELECT ... state ... was
    // throwing 'column "state" does not exist' on Postgres. Resolve the
    // hub's state below from delivery_hubs instead.
    const customer = await c.var.DB.prepare(
      "SELECT id, name FROM customers WHERE id = ?",
    )
      .bind(body.customerId)
      .first<{ id: string; name: string }>();
    if (!customer) {
      return c.json({ success: false, error: "Customer not found" }, 400);
    }
    // Pull state from the chosen delivery hub so customerState on the
    // consignment row reflects WHERE this CO is being delivered, not a
    // single customer-level state. Empty string when no hub picked yet.
    let customerState: string | null = null;
    const hubId = (body.hubId as string) ?? null;
    if (hubId) {
      const hub = await c.var.DB
        .prepare("SELECT state FROM delivery_hubs WHERE id = ?")
        .bind(hubId)
        .first<{ state: string | null }>();
      customerState = hub?.state ?? null;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const companyCOId = await nextCompanyCOId(c.var.DB, now);
    const id = genCoId();

    const rawItems = Array.isArray(body.items) ? body.items : [];
    const itemRows: ConsignmentOrderItemRow[] = rawItems.map(
      (it: Record<string, unknown>, idx: number) => {
        const qty = Number(it.quantity) || 1;
        const basePrice = Number(it.basePriceSen) || 0;
        const divanPrice = Number(it.divanPriceSen) || 0;
        const legPrice = Number(it.legPriceSen) || 0;
        const specialPrice = Number(it.specialOrderPriceSen) || 0;
        const unitPrice = basePrice + divanPrice + legPrice + specialPrice;
        return {
          id: genItemId(),
          consignmentOrderId: id,
          lineNo: Number(it.lineNo) || idx + 1,
          lineSuffix: (it.lineSuffix as string) ?? null,
          productId: (it.productId as string) ?? null,
          productCode: (it.productCode as string) ?? null,
          productName: (it.productName as string) ?? null,
          itemCategory: (it.itemCategory as string) ?? null,
          sizeCode: (it.sizeCode as string) ?? null,
          sizeLabel: (it.sizeLabel as string) ?? null,
          fabricId: (it.fabricId as string) ?? null,
          fabricCode: (it.fabricCode as string) ?? null,
          quantity: qty,
          gapInches: it.gapInches != null ? Number(it.gapInches) : null,
          divanHeightInches:
            it.divanHeightInches != null ? Number(it.divanHeightInches) : null,
          divanPriceSen: divanPrice,
          legHeightInches:
            it.legHeightInches != null ? Number(it.legHeightInches) : null,
          legPriceSen: legPrice,
          specialOrder: (it.specialOrder as string) ?? null,
          specialOrderPriceSen: specialPrice,
          basePriceSen: basePrice,
          unitPriceSen: unitPrice,
          lineTotalSen: unitPrice * qty,
          notes: (it.notes as string) ?? null,
        };
      },
    );

    const subtotalSen = itemRows.reduce((s, it) => s + it.lineTotalSen, 0);
    const totalSen = subtotalSen; // No tax/discount in v1

    const stmts: D1PreparedStatement[] = [];
    stmts.push(
      c.var.DB.prepare(
        `INSERT INTO consignment_orders (id, customerCO, customerCOId, customerCODate,
           reference, customerId, customerName, customerState, hubId, hubName,
           companyCO, companyCOId, companyCODate, customerDeliveryDate,
           hookkaExpectedDD, subtotalSen, totalSen, status, overdue, notes,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        (body.customerCO as string) ?? null,
        (body.customerCOId as string) ?? null,
        (body.customerCODate as string) ?? null,
        (body.reference as string) ?? null,
        customer.id,
        customer.name,
        customerState,
        (body.hubId as string) ?? null,
        (body.hubName as string) ?? null,
        companyCOId,
        companyCOId,
        (body.companyCODate as string) || nowIso.split("T")[0],
        (body.customerDeliveryDate as string) ?? null,
        (body.hookkaExpectedDD as string) ?? null,
        subtotalSen,
        totalSen,
        "DRAFT",
        "PENDING",
        (body.notes as string) ?? null,
        nowIso,
        nowIso,
      ),
    );

    for (const it of itemRows) {
      stmts.push(
        c.var.DB.prepare(
          `INSERT INTO consignment_order_items (id, consignmentOrderId, lineNo, lineSuffix,
             productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
             fabricId, fabricCode, quantity, gapInches, divanHeightInches, divanPriceSen,
             legHeightInches, legPriceSen, specialOrder, specialOrderPriceSen,
             basePriceSen, unitPriceSen, lineTotalSen, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          it.id,
          it.consignmentOrderId,
          it.lineNo,
          it.lineSuffix,
          it.productId,
          it.productCode,
          it.productName,
          it.itemCategory,
          it.sizeCode,
          it.sizeLabel,
          it.fabricId,
          it.fabricCode,
          it.quantity,
          it.gapInches,
          it.divanHeightInches,
          it.divanPriceSen,
          it.legHeightInches,
          it.legPriceSen,
          it.specialOrder,
          it.specialOrderPriceSen,
          it.basePriceSen,
          it.unitPriceSen,
          it.lineTotalSen,
          it.notes,
        ),
      );
    }

    await c.var.DB.batch(stmts);

    const created = await c.var.DB.prepare(
      "SELECT * FROM consignment_orders WHERE id = ?",
    )
      .bind(id)
      .first<ConsignmentOrderRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create consignment order" },
        500,
      );
    }
    return c.json({ success: true, data: rowToCO(created, itemRows) }, 201);
  } catch (err) {
    // Surface the real failure — DB constraint violations, missing FKs,
    // bad item category, etc. were silently masked as "Invalid request
    // body" before, which made debugging from the UI impossible.
    console.error("[POST /api/consignment-orders] failed:", err);
    const message = err instanceof Error ? err.message : "Invalid request body";
    return c.json({ success: false, error: message }, 400);
  }
});

// ---------------------------------------------------------------------------
// GET /api/consignment-orders/stats — whole-dataset status bucket counts.
// Mirrors /api/sales-orders/stats. Used by the list-page tab badges.
// MUST be registered BEFORE /:id (Hono matches in registration order; a
// wildcard /:id would otherwise swallow "/stats").
// ---------------------------------------------------------------------------
app.get("/stats", async (c) => {
  const res = await c.var.DB
    .prepare(
      "SELECT status, COUNT(*) AS n FROM consignment_orders GROUP BY status",
    )
    .all<{ status: string; n: number }>();
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of res.results ?? []) {
    byStatus[row.status] = row.n;
    total += row.n;
  }
  return c.json({ success: true, byStatus, total });
});

// ---------------------------------------------------------------------------
// GET /api/consignment-orders/status-changes — full audit log.
// Currently returns an empty list because consignment_order_status_changes
// table doesn't exist yet (parallel to so_status_changes). The CO Detail
// page subscribes to this hook so we return the success envelope to keep
// it from showing a loading skeleton forever.
// TODO: add a consignment_order_status_changes table (and INSERT rows from
// the /confirm + /:id PUT handlers) so CO status history is observable.
// ---------------------------------------------------------------------------
app.get("/status-changes", async (c) => {
  return c.json({ success: true, data: [], total: 0 });
});

// ---------------------------------------------------------------------------
// GET /api/consignment-orders/:id/edit-eligibility — CO-parity twin of the
// SO endpoint. Rules (per user 2026-04-28):
//   1. Status must be DRAFT / CONFIRMED / IN_PRODUCTION.
//   2. No JC under any of the CO's POs may have a completedDate stamped.
//   3. Earliest JC dueDate > today + 2 days (lock once within 2 days of
//      the first scheduled production step's deadline).
//
// Registered BEFORE /:id so Hono's trie picks the right handler.
// ---------------------------------------------------------------------------
app.get("/:id/edit-eligibility", async (c) => {
  const id = c.req.param("id");
  const co = await c.var.DB
    .prepare("SELECT id, status FROM consignment_orders WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!co) {
    return c.json({ success: false, error: "Consignment order not found" }, 404);
  }

  // Rule 1: status must be one of DRAFT / CONFIRMED / IN_PRODUCTION.
  if (
    co.status !== "DRAFT" &&
    co.status !== "CONFIRMED" &&
    co.status !== "IN_PRODUCTION"
  ) {
    return c.json({
      success: true,
      editable: false,
      reason: "status",
      status: co.status,
    });
  }

  // DRAFT/CONFIRMED short-circuit — no production to inspect.
  if (co.status === "DRAFT" || co.status === "CONFIRMED") {
    return c.json({
      success: true,
      editable: true,
      status: co.status,
    });
  }

  // IN_PRODUCTION — pull earliest completed + earliest scheduled JC dueDate.
  const [completedRes, earliestDueRes] = await Promise.all([
    c.var.DB
      .prepare(
        `SELECT jc.departmentName, jc.departmentCode, jc.completedDate
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.consignmentOrderId = ?
            AND jc.completedDate IS NOT NULL
            AND jc.completedDate <> ''
          ORDER BY jc.completedDate ASC
          LIMIT 1`,
      )
      .bind(id)
      .first<{
        departmentName: string | null;
        departmentCode: string | null;
        completedDate: string | null;
      }>(),
    c.var.DB
      .prepare(
        `SELECT jc.dueDate
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.consignmentOrderId = ?
            AND jc.dueDate IS NOT NULL
            AND jc.dueDate <> ''
          ORDER BY jc.dueDate ASC
          LIMIT 1`,
      )
      .bind(id)
      .first<{ dueDate: string | null }>(),
  ]);

  // Rule 2: any dept stamped a completion → fully locked.
  if (completedRes && completedRes.completedDate) {
    return c.json({
      success: true,
      editable: false,
      reason: "dept_completed",
      status: co.status,
      completedDept: completedRes.departmentName || completedRes.departmentCode || "A department",
      completedAt: completedRes.completedDate,
    });
  }

  // Rule 3: earliest JC dueDate > today + 2 days.
  const earliestDue = earliestDueRes?.dueDate?.slice(0, 10) ?? "";
  if (earliestDue.length === 10) {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() + 2);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    if (earliestDue <= cutoffStr) {
      return c.json({
        success: true,
        editable: false,
        reason: "production_window",
        status: co.status,
        earliestJcDueDate: earliestDue,
        cutoffDate: cutoffStr,
      });
    }
  }

  // IN_PRODUCTION, no JC done, first step > 2 days away — editable.
  return c.json({
    success: true,
    editable: true,
    status: co.status,
  });
});

// ---------------------------------------------------------------------------
// POST /api/consignment-orders/:id/override-edit-lock — CO-parity twin of
// the SO endpoint. See routes/sales-orders.ts for the full security-model
// rationale (admin can override Rule 3 production_window because it is a
// soft schedule-drift guard with no committed output yet; admin CANNOT
// override Rule 2 dept_completed because real WIP exists).
//
// Differences from the SO version:
//   * No so_status_changes mirror — CO has no status-changes table yet
//     (TODO at line ~411 of this file). The override row in
//     edit_lock_overrides + the audit_events emit is the full audit trail
//     until that table lands.
//
// Registered BEFORE /:id so Hono's trie picks the right handler.
// ---------------------------------------------------------------------------
app.post("/:id/override-edit-lock", async (c) => {
  const denied = await requirePermission(c, "consignments", "create");
  if (denied) return denied;
  const id = c.req.param("id");

  const role = (
    c as unknown as { get: (k: string) => string | undefined }
  ).get("userRole")?.toUpperCase();
  if (role !== "SUPER_ADMIN" && role !== "ADMIN") {
    return c.json(
      {
        success: false,
        error:
          "Forbidden — only SUPER_ADMIN or ADMIN can override the edit lock.",
      },
      403,
    );
  }

  let body: { reason?: unknown };
  try {
    body = (await c.req.json()) as { reason?: unknown };
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const reasonRaw = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reasonRaw.length < MIN_OVERRIDE_REASON_LEN) {
    return c.json(
      {
        success: false,
        error: `Reason is required (minimum ${MIN_OVERRIDE_REASON_LEN} characters after trimming).`,
      },
      400,
    );
  }

  const co = await c.var.DB
    .prepare("SELECT id, status FROM consignment_orders WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!co) {
    return c.json(
      { success: false, error: "Consignment order not found" },
      404,
    );
  }

  // Rule 1
  if (
    co.status !== "DRAFT" &&
    co.status !== "CONFIRMED" &&
    co.status !== "IN_PRODUCTION"
  ) {
    return c.json(
      {
        success: false,
        error: `Cannot override — order is in status ${co.status}, which is not editable regardless of override.`,
      },
      400,
    );
  }
  if (co.status === "DRAFT" || co.status === "CONFIRMED") {
    return c.json(
      {
        success: false,
        error: "No override needed — this order is already editable.",
      },
      400,
    );
  }

  const [completedRes, earliestDueRes] = await Promise.all([
    c.var.DB
      .prepare(
        `SELECT jc.completedDate
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.consignmentOrderId = ?
            AND jc.completedDate IS NOT NULL
            AND jc.completedDate <> ''
          LIMIT 1`,
      )
      .bind(id)
      .first<{ completedDate: string | null }>(),
    c.var.DB
      .prepare(
        `SELECT jc.dueDate
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.consignmentOrderId = ?
            AND jc.dueDate IS NOT NULL
            AND jc.dueDate <> ''
          ORDER BY jc.dueDate ASC
          LIMIT 1`,
      )
      .bind(id)
      .first<{ dueDate: string | null }>(),
  ]);

  // Rule 2 — NOT bypassable.
  if (completedRes && completedRes.completedDate) {
    return c.json(
      {
        success: false,
        error:
          "Cannot override — production output already exists (a department has stamped completion). Editing would orphan finished WIP. This lock cannot be bypassed.",
      },
      400,
    );
  }

  // Rule 3 must currently be active for the override to be meaningful.
  const earliestDue = earliestDueRes?.dueDate?.slice(0, 10) ?? "";
  let productionWindowActive = false;
  if (earliestDue.length === 10) {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() + 2);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    if (earliestDue <= cutoffStr) productionWindowActive = true;
  }
  if (!productionWindowActive) {
    return c.json(
      {
        success: false,
        error:
          "No override needed — the order is not currently within the 2-day production-window lock.",
      },
      400,
    );
  }

  const actorUserId = (
    c as unknown as { get: (k: string) => string | undefined }
  ).get("userId") ?? null;
  const actorUserName = await lookupActorDisplayName(c.var.DB, actorUserId);

  const created = await createEditLockOverride(c.var.DB, {
    orderType: "CO",
    orderId: id,
    reason: reasonRaw,
    actorUserId,
    actorUserName,
    actorRole: role,
  });

  await emitAudit(c, {
    resource: "consignment-orders",
    resourceId: id,
    action: "override-edit-lock",
    before: {
      editable: false,
      reason: "production_window",
      earliestJcDueDate: earliestDue,
    },
    after: {
      overrideToken: created.token,
      expiresAt: created.expiresAt,
      reason: reasonRaw,
    },
  });

  return c.json({
    success: true,
    overrideToken: created.token,
    expiresAt: created.expiresAt,
  });
});

// ---------------------------------------------------------------------------
// GET /api/consignment-orders/:id
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [row, items] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM consignment_orders WHERE id = ?")
      .bind(id)
      .first<ConsignmentOrderRow>(),
    c.var.DB.prepare(
      "SELECT * FROM consignment_order_items WHERE consignmentOrderId = ?",
    )
      .bind(id)
      .all<ConsignmentOrderItemRow>(),
  ]);
  if (!row) {
    return c.json(
      { success: false, error: "Consignment order not found" },
      404,
    );
  }
  // Lock status — surfaced to the CO detail / edit pages so they can
  // disable inputs + render a banner when locked (PO COMPLETED or
  // CN already created).
  const lockReason = await checkConsignmentOrderLocked(c.var.DB, id);
  return c.json({
    success: true,
    data: rowToCO(row, items.results ?? []),
    lockReason,
  });
});

// ---------------------------------------------------------------------------
// POST /api/consignment-orders/:id/confirm
//
// Transitions DRAFT → CONFIRMED and cascades through the shared production
// builder. Idempotent: re-confirming after the first call returns the
// existing PO set without duplicating.
// ---------------------------------------------------------------------------
app.post("/:id/confirm", async (c) => {
  const denied = await requirePermission(c, "consignments", "create");
  if (denied) return denied;
  const id = c.req.param("id");

  const [orderRow, itemsRes] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM consignment_orders WHERE id = ?")
      .bind(id)
      .first<ConsignmentOrderRow>(),
    c.var.DB.prepare(
      "SELECT * FROM consignment_order_items WHERE consignmentOrderId = ? ORDER BY lineNo",
    )
      .bind(id)
      .all<ConsignmentOrderItemRow>(),
  ]);
  if (!orderRow) {
    return c.json(
      { success: false, error: "Consignment order not found" },
      404,
    );
  }
  const itemRows = itemsRes.results ?? [];
  if (itemRows.length === 0) {
    return c.json(
      { success: false, error: "Cannot confirm a CO with no line items" },
      400,
    );
  }

  // Build production orders via the shared service. The same function SO
  // confirm uses — sourceType discriminates which FK column gets written.
  const result = await createProductionOrdersForOrder(
    c.var.DB,
    {
      id: orderRow.id,
      sourceType: "CO",
      companyOrderId: orderRow.companyCOId ?? "",
      companyOrderDate: orderRow.companyCODate,
      customerPOId: null, // CO has no customer PO equivalent
      reference: orderRow.reference,
      customerName: orderRow.customerName,
      customerState: orderRow.customerState,
      hookkaExpectedDD: orderRow.hookkaExpectedDD,
      customerDeliveryDate: orderRow.customerDeliveryDate,
    },
    itemRows.map((it) => ({
      lineNo: it.lineNo,
      productId: it.productId,
      productCode: it.productCode,
      productName: it.productName,
      itemCategory: it.itemCategory,
      sizeCode: it.sizeCode,
      sizeLabel: it.sizeLabel,
      fabricCode: it.fabricCode,
      quantity: it.quantity,
      gapInches: it.gapInches,
      divanHeightInches: it.divanHeightInches,
      legHeightInches: it.legHeightInches,
      specialOrder: it.specialOrder,
      notes: it.notes,
    })),
  );

  // Apply the production-order INSERTs + bump CO status.
  const stmts = [...result.statements];
  if (!result.preExisting) {
    stmts.push(
      c.var.DB.prepare(
        "UPDATE consignment_orders SET status = 'CONFIRMED', updated_at = ? WHERE id = ?",
      ).bind(new Date().toISOString(), id),
    );
  }
  if (stmts.length > 0) {
    await c.var.DB.batch(stmts);
  }

  return c.json({
    success: true,
    data: {
      id: orderRow.id,
      status: result.preExisting ? orderRow.status : "CONFIRMED",
      productionOrders: result.created,
      preExisting: result.preExisting,
    },
  });
});

// ---------------------------------------------------------------------------
// PUT /api/consignment-orders/:id — update header + items.
//
// Cascade lock: rejects field edits (items / customer / dates) once any
// production order has reached COMPLETED OR a Consignment Note exists for
// the parent customer. Status-only transitions still pass through (the
// caller wants to flip DRAFT → ON_HOLD or similar, not rewrite the order).
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "consignments", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM consignment_orders WHERE id = ?",
    )
      .bind(id)
      .first<ConsignmentOrderRow>();
    if (!existing) {
      return c.json(
        { success: false, error: "Consignment order not found" },
        404,
      );
    }

    const body = await c.req.json();
    const isStatusOnly =
      body.status &&
      !body.items &&
      !body.customerId &&
      !body.companyCODate &&
      !body.customerDeliveryDate &&
      !body.hookkaExpectedDD;

    if (!isStatusOnly) {
      const lockMsg = await checkConsignmentOrderLocked(c.var.DB, id);
      if (lockMsg) {
        return c.json(lockedResponse(lockMsg), 403);
      }

      // ---------------------------------------------------------------
      // Edit-eligibility re-check (defense-in-depth, mirrors the GET
      // /:id/edit-eligibility logic). Same model as sales-orders.ts:
      // Rule 2 (dept_completed) is hard — override cannot bypass; Rule
      // 3 (production_window) is bypassable via a one-shot
      // overrideToken minted by SUPER_ADMIN/ADMIN. See SO PUT block
      // for the full rationale comment.
      // ---------------------------------------------------------------
      if (
        existing.status === "IN_PRODUCTION" ||
        existing.status === "CONFIRMED"
      ) {
        const [completedRes, earliestDueRes] = await Promise.all([
          c.var.DB
            .prepare(
              `SELECT jc.completedDate, jc.departmentName, jc.departmentCode
                 FROM job_cards jc
                 JOIN production_orders po ON po.id = jc.productionOrderId
                WHERE po.consignmentOrderId = ?
                  AND jc.completedDate IS NOT NULL
                  AND jc.completedDate <> ''
                LIMIT 1`,
            )
            .bind(id)
            .first<{
              completedDate: string | null;
              departmentName: string | null;
              departmentCode: string | null;
            }>(),
          c.var.DB
            .prepare(
              `SELECT jc.dueDate
                 FROM job_cards jc
                 JOIN production_orders po ON po.id = jc.productionOrderId
                WHERE po.consignmentOrderId = ?
                  AND jc.dueDate IS NOT NULL
                  AND jc.dueDate <> ''
                ORDER BY jc.dueDate ASC
                LIMIT 1`,
            )
            .bind(id)
            .first<{ dueDate: string | null }>(),
        ]);

        if (completedRes && completedRes.completedDate) {
          const dept =
            completedRes.departmentName ||
            completedRes.departmentCode ||
            "A department";
          return c.json(
            {
              success: false,
              error: `Cannot edit — ${dept} has completed work on this order. Editing items would orphan finished WIP.`,
              reason: "dept_completed",
            },
            403,
          );
        }

        const earliestDue = earliestDueRes?.dueDate?.slice(0, 10) ?? "";
        if (earliestDue.length === 10) {
          const cutoff = new Date();
          cutoff.setUTCDate(cutoff.getUTCDate() + 2);
          const cutoffStr = cutoff.toISOString().slice(0, 10);
          if (earliestDue <= cutoffStr) {
            const overrideToken =
              typeof body.overrideToken === "string"
                ? body.overrideToken
                : "";
            if (!overrideToken) {
              return c.json(
                {
                  success: false,
                  error: `Cannot edit — first production step is due ${earliestDue} (within the 2-day cutoff ${cutoffStr}). An ADMIN override is required.`,
                  reason: "production_window",
                  earliestJcDueDate: earliestDue,
                  cutoffDate: cutoffStr,
                },
                403,
              );
            }
            const consumed = await consumeEditLockOverrideToken(
              c.var.DB,
              overrideToken,
              "CO",
              id,
            );
            if (!consumed.ok) {
              const detail =
                consumed.reason === "expired"
                  ? "Override token has expired (60 min TTL). Request a new override."
                  : consumed.reason === "already_used"
                    ? "Override token has already been used. Request a new override."
                    : consumed.reason === "wrong_order"
                      ? "Override token does not match this order."
                      : "Override token not found.";
              return c.json(
                {
                  success: false,
                  error: detail,
                  reason: "override_invalid",
                },
                403,
              );
            }
            // Token consumed — fall through to the normal PUT flow.
          }
        }
      }
    }

    // Pre-flight: block CANCELLED transition when any job_card under this
    // CO's POs has a completedDate stamped. CO-parity twin of the SO Cancel
    // block in routes/sales-orders.ts — stranded inventory would result if
    // we cascaded CANCELLED through completed work, so operators must first
    // clear the completion dates or reassign those finished units to another
    // order. Returns 409 Conflict (distinct from 4xx validation errors) so
    // the frontend can render a specific blocked-cancel modal.
    if (body.status === "CANCELLED" && existing.status !== "CANCELLED") {
      const blockingRes = await c.var.DB
        .prepare(
          `SELECT jc.id, jc.completedDate, jc.departmentCode, jc.departmentName, po.poNo
             FROM job_cards jc
             JOIN production_orders po ON po.id = jc.productionOrderId
            WHERE po.consignmentOrderId = ?
              AND jc.completedDate IS NOT NULL
              AND jc.completedDate <> ''
              AND jc.status NOT IN ('CANCELLED')
            ORDER BY jc.completedDate ASC
            LIMIT 5`,
        )
        .bind(id)
        .all<{
          id: string;
          completedDate: string;
          departmentCode: string | null;
          departmentName: string | null;
          poNo: string;
        }>();
      const blocking = blockingRes.results ?? [];
      if (blocking.length > 0) {
        const lockedDepts = Array.from(
          new Set(
            blocking
              .map((b) => b.departmentCode || b.departmentName || "")
              .filter((d) => d.length > 0),
          ),
        );
        return c.json(
          {
            success: false,
            error: "Cannot cancel — production has completed work",
            lockedDepts,
            blockingItems: blocking.map((b) => ({
              poNo: b.poNo,
              departmentCode: b.departmentCode || "",
              departmentName: b.departmentName || b.departmentCode || "Department",
              completedDate: b.completedDate,
            })),
            reason:
              "Clear completion dates or reassign these items to another order before cancelling.",
          },
          409,
        );
      }
    }

    const now = new Date().toISOString();

    // Header field updates — preserve existing values when not provided.
    const merged = {
      customerCO: body.customerCO ?? existing.customerCO ?? null,
      customerCOId: body.customerCOId ?? existing.customerCOId ?? null,
      customerCODate: body.customerCODate ?? existing.customerCODate ?? null,
      reference: body.reference ?? existing.reference ?? null,
      hubId: body.hubId ?? existing.hubId ?? null,
      hubName: body.hubName ?? existing.hubName ?? null,
      companyCODate: body.companyCODate ?? existing.companyCODate ?? null,
      customerDeliveryDate:
        body.customerDeliveryDate ?? existing.customerDeliveryDate ?? null,
      hookkaExpectedDD:
        body.hookkaExpectedDD ?? existing.hookkaExpectedDD ?? null,
      notes: body.notes ?? existing.notes ?? null,
      status: body.status ?? existing.status,
    };

    const stmts: D1PreparedStatement[] = [];

    // If items are provided, replace them (and recompute totals)
    let subtotalSen = existing.subtotalSen;
    let totalSen = existing.totalSen;
    if (Array.isArray(body.items)) {
      stmts.push(
        c.var.DB.prepare(
          "DELETE FROM consignment_order_items WHERE consignmentOrderId = ?",
        ).bind(id),
      );
      let runningSubtotal = 0;
      for (let idx = 0; idx < body.items.length; idx++) {
        const it = body.items[idx] as Record<string, unknown>;
        const qty = Number(it.quantity) || 1;
        const basePrice = Number(it.basePriceSen) || 0;
        const divanPrice = Number(it.divanPriceSen) || 0;
        const legPrice = Number(it.legPriceSen) || 0;
        const specialPrice = Number(it.specialOrderPriceSen) || 0;
        const unitPrice = basePrice + divanPrice + legPrice + specialPrice;
        const lineTotal = unitPrice * qty;
        runningSubtotal += lineTotal;
        const lineNo = Number(it.lineNo) || idx + 1;
        const itemId =
          (it.id as string) || `coi-${crypto.randomUUID().slice(0, 8)}`;
        stmts.push(
          c.var.DB.prepare(
            `INSERT INTO consignment_order_items (id, consignmentOrderId, lineNo, lineSuffix,
               productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
               fabricId, fabricCode, quantity, gapInches, divanHeightInches, divanPriceSen,
               legHeightInches, legPriceSen, specialOrder, specialOrderPriceSen,
               basePriceSen, unitPriceSen, lineTotalSen, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            itemId,
            id,
            lineNo,
            (it.lineSuffix as string) ?? null,
            (it.productId as string) ?? null,
            (it.productCode as string) ?? null,
            (it.productName as string) ?? null,
            (it.itemCategory as string) ?? null,
            (it.sizeCode as string) ?? null,
            (it.sizeLabel as string) ?? null,
            (it.fabricId as string) ?? null,
            (it.fabricCode as string) ?? null,
            qty,
            it.gapInches != null ? Number(it.gapInches) : null,
            it.divanHeightInches != null ? Number(it.divanHeightInches) : null,
            divanPrice,
            it.legHeightInches != null ? Number(it.legHeightInches) : null,
            legPrice,
            (it.specialOrder as string) ?? null,
            specialPrice,
            basePrice,
            unitPrice,
            lineTotal,
            (it.notes as string) ?? null,
          ),
        );
      }
      subtotalSen = runningSubtotal;
      totalSen = runningSubtotal;
    }

    stmts.push(
      c.var.DB.prepare(
        `UPDATE consignment_orders SET
           customerCO = ?, customerCOId = ?, customerCODate = ?, reference = ?,
           hubId = ?, hubName = ?, companyCODate = ?, customerDeliveryDate = ?,
           hookkaExpectedDD = ?, subtotalSen = ?, totalSen = ?, status = ?,
           notes = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(
        merged.customerCO,
        merged.customerCOId,
        merged.customerCODate,
        merged.reference,
        merged.hubId,
        merged.hubName,
        merged.companyCODate,
        merged.customerDeliveryDate,
        merged.hookkaExpectedDD,
        subtotalSen,
        totalSen,
        merged.status,
        merged.notes,
        now,
        id,
      ),
    );

    await c.var.DB.batch(stmts);

    const [updated, items] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM consignment_orders WHERE id = ?")
        .bind(id)
        .first<ConsignmentOrderRow>(),
      c.var.DB.prepare(
        "SELECT * FROM consignment_order_items WHERE consignmentOrderId = ?",
      )
        .bind(id)
        .all<ConsignmentOrderItemRow>(),
    ]);
    if (!updated) {
      return c.json(
        { success: false, error: "Failed to reload after update" },
        500,
      );
    }
    return c.json({
      success: true,
      data: rowToCO(updated, items.results ?? []),
    });
  } catch (err) {
    console.error("[PUT /api/consignment-orders/:id] failed:", err);
    const message = err instanceof Error ? err.message : "Invalid request body";
    return c.json({ success: false, error: message }, 400);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/consignment-orders/:id (only DRAFT)
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "consignments", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT status FROM consignment_orders WHERE id = ?",
  )
    .bind(id)
    .first<{ status: string }>();
  if (!existing) {
    return c.json(
      { success: false, error: "Consignment order not found" },
      404,
    );
  }
  if (existing.status !== "DRAFT") {
    return c.json(
      {
        success: false,
        error: "Only DRAFT consignment orders can be deleted",
      },
      400,
    );
  }
  await c.var.DB.prepare("DELETE FROM consignment_orders WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true });
});

export default app;
