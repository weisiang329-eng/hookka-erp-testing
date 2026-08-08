// ---------------------------------------------------------------------------
// D1-backed Consignments route.
//
// Uses consignment_notes + consignment_items tables (both in 0001_init.sql,
// extended by 0066 with the dispatch + linkage columns). Shares the
// underlying tables with routes/consignment-notes.ts; this file mirrors
// the old /api/consignments surface (validates customer exists, returns
// nested `items` array, supports DELETE-with-data response, full
// CRUD-by-:id).
//
// Row mapping + carrier resolution lives in api/lib/consignment-note-shared.ts
// so this file and consignment-notes.ts stay in lock-step.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { customerScopeSql } from "../lib/customer-scope";
import { emitAudit } from "../lib/audit";
import {
  loadFgUnitsForEvent,
  recordFgStockEvents,
  SYSTEM_ACTOR,
} from "../lib/fg-stock-events";
import {
  type ConsignmentNoteRow,
  type ConsignmentItemRow,
  rowToConsignmentNote,
  genNoteId,
  genItemId,
  nextConsignmentNoteNumber,
  resolveTransport,
  updateConsignmentNoteById,
  validatePOMutex,
} from "../lib/consignment-note-shared";

const app = new Hono<Env>();

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
  // Owner 2026-08-05: "consignment order 也是这样。我想 consignment note、
  // return 等等都是."
  const cnScope = await customerScopeSql(c, "customerId");
  if (cnScope.clause) {
    clauses.push(cnScope.clause);
    params.push(...cnScope.binds);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const [notesRes, itemsRes] = await Promise.all([
    c.var.DB.prepare(`SELECT * FROM consignment_notes ${where}`)
      .bind(...params)
      .all<ConsignmentNoteRow>(),
    c.var.DB.prepare("SELECT * FROM consignment_items").all<ConsignmentItemRow>(),
  ]);
  const data = (notesRes.results ?? []).map((r) =>
    rowToConsignmentNote(r, itemsRes.results ?? []),
  );
  return c.json({ success: true, data, total: data.length });
});

// POST /api/consignments — creates note + items atomically, validates customer.
//
// Body shape (all fields optional unless noted):
//   customerId (REQUIRED), customerName?, branchName?, type?, sentDate?, notes?
//   hubId?                       — delivery_hubs row, drives branchName fallback
//   consignmentOrderId?          — parent CO id (FK to consignment_orders)
//   providerId? / driverId? / vehicleId?
//                                — 3PL refactor lookup (see resolveTransport)
//   driverName? driverPhone? driverContactPerson? vehicleNo? vehicleType?
//                                — explicit overrides for the resolved values
//   productionOrderIds?: string[]
//                                — when provided, INSERT one consignment_items
//                                  row per PO with production_order_id set.
//   items?: Array<{...}>         — explicit items array (legacy callers).
app.post("/", async (c) => {
  const denied = await requirePermission(c, "consignments", "create");
  if (denied) return denied;
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
    const noteNumber = await nextConsignmentNoteNumber(c.var.DB, now);
    const id = genNoteId();

    // Resolve hub → branchName fallback.
    let resolvedBranchName =
      (body.branchName as string | undefined) ?? customer.name;
    const hubId = (body.hubId as string | undefined) ?? null;
    if (hubId) {
      const hub = await c.var.DB.prepare(
        "SELECT id, shortName FROM delivery_hubs WHERE id = ?",
      )
        .bind(hubId)
        .first<{ id: string; shortName: string | null }>();
      if (hub && body.branchName === undefined) {
        resolvedBranchName = hub.shortName ?? customer.name;
      }
    }

    // Carrier resolution.
    const transport = await resolveTransport(c.var.DB, body);

    // Items source preference: productionOrderIds > body.items.
    const productionOrderIds: string[] = Array.isArray(body.productionOrderIds)
      ? (body.productionOrderIds as unknown[]).filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        )
      : [];

    type ItemSeed = {
      id: string;
      productId: string;
      productName: string;
      productCode: string;
      quantity: number;
      unitPrice: number;
      productionOrderId: string | null;
    };
    let itemSeeds: ItemSeed[] = [];

    // PO mutex check (parity with consignment-notes.ts:211-244). Reject
    // if any incoming PO is already on a non-terminal CN/DO. The legacy
    // /consignments POST was missing this guard; a duplicate CN created
    // here would double-stamp fg_units at dispatch.
    if (productionOrderIds.length > 0) {
      const mutex = await validatePOMutex(c.var.DB, productionOrderIds, "CN");
      if (!mutex.ok) {
        return c.json(
          {
            success: false,
            error: `Cannot create consignment note — ${mutex.conflicts.length} PO${mutex.conflicts.length === 1 ? "" : "s"} already on an active dispatch document: ${mutex.conflicts.join(", ")}`,
            conflicts: mutex.conflicts,
            reason: mutex.reason,
          },
          409,
        );
      }
    } else if (Array.isArray(body.items)) {
      const itemPoIds = (body.items as Array<Record<string, unknown>>)
        .map((it) => it.productionOrderId)
        .filter((s): s is string => typeof s === "string" && s.length > 0);
      if (itemPoIds.length > 0) {
        const mutex = await validatePOMutex(c.var.DB, itemPoIds, "CN");
        if (!mutex.ok) {
          return c.json(
            {
              success: false,
              error: `Cannot create consignment note — ${mutex.conflicts.length} PO${mutex.conflicts.length === 1 ? "" : "s"} already on an active dispatch document: ${mutex.conflicts.join(", ")}`,
              conflicts: mutex.conflicts,
              reason: mutex.reason,
            },
            409,
          );
        }
      }
    }

    if (productionOrderIds.length > 0) {
      const ph = productionOrderIds.map(() => "?").join(",");
      const poRes = await c.var.DB.prepare(
        `SELECT id, productCode, productName, quantity
           FROM production_orders WHERE id IN (${ph})`,
      )
        .bind(...productionOrderIds)
        .all<{
          id: string;
          productCode: string | null;
          productName: string | null;
          quantity: number | null;
        }>();
      itemSeeds = (poRes.results ?? []).map((po) => ({
        id: genItemId(),
        productId: "",
        productName: po.productName ?? "",
        productCode: po.productCode ?? "",
        quantity: Number(po.quantity) || 1,
        unitPrice: 0,
        productionOrderId: po.id,
      }));
    } else {
      const rawItems = Array.isArray(body.items) ? body.items : [];
      itemSeeds = rawItems.map((it: Record<string, unknown>) => ({
        id: genItemId(),
        productId: (it.productId as string) ?? "",
        productName: (it.productName as string) ?? "",
        productCode: (it.productCode as string) ?? "",
        quantity: Number(it.quantity) || 1,
        unitPrice: Number(it.unitPrice) || 0,
        productionOrderId: (it.productionOrderId as string | null) ?? null,
      }));
    }

    const totalValue = itemSeeds.reduce(
      (sum, it) => sum + it.unitPrice * it.quantity,
      0,
    );

    const stmts: D1PreparedStatement[] = [];
    stmts.push(
      c.var.DB.prepare(
        `INSERT INTO consignment_notes (
           id, noteNumber, type, customerId, customerName, branchName,
           sentDate, status, totalValue, notes,
           driverId, driverName, driverContactPerson, driverPhone,
           vehicleId, vehicleNo, vehicleType,
           dispatchedAt, inTransitAt, deliveredAt, acknowledgedAt,
           consignmentOrderId, hubId
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?)`,
      ).bind(
        id,
        noteNumber,
        body.type ?? "OUT",
        customer.id,
        customer.name,
        resolvedBranchName,
        body.sentDate ?? now.toISOString().split("T")[0],
        "ACTIVE",
        totalValue,
        body.notes ?? "",
        // Carrier — driverId stores the PROVIDER company id (DO convention).
        transport.providerId,
        transport.driverName,
        transport.driverContactPerson,
        transport.driverPhone,
        transport.vehicleId,
        transport.vehicleNo,
        transport.vehicleType,
        // Lifecycle timestamps null on create. inTransitAt added per
        // migration 0078 — was previously omitted from this legacy INSERT
        // and worked because the column defaults NULL, but it drifted
        // from the canonical /api/consignment-notes POST shape.
        null,
        null,
        null,
        null,
        // Linkage
        (body.consignmentOrderId as string | null) ?? null,
        hubId,
      ),
    );
    for (const it of itemSeeds) {
      stmts.push(
        c.var.DB.prepare(
          `INSERT INTO consignment_items (
             id, consignmentNoteId, productId, productName, productCode,
             quantity, unitPrice, status, soldDate, returnedDate,
             productionOrderId
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          it.id,
          id,
          it.productId,
          it.productName,
          it.productCode,
          it.quantity,
          it.unitPrice,
          "AT_BRANCH",
          null,
          null,
          it.productionOrderId,
        ),
      );
    }
    await c.var.DB.batch(stmts);

    const [created, items] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM consignment_notes WHERE id = ?")
        .bind(id)
        .first<ConsignmentNoteRow>(),
      c.var.DB.prepare(
        "SELECT * FROM consignment_items WHERE consignmentNoteId = ?",
      )
        .bind(id)
        .all<ConsignmentItemRow>(),
    ]);
    if (!created) {
      return c.json({ success: false, error: "Failed to create consignment" }, 500);
    }
    return c.json(
      { success: true, data: rowToConsignmentNote(created, items.results ?? []) },
      201,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/consignments] failed:", msg);
    return c.json({ success: false, error: msg || "Invalid request body" }, 400);
  }
});

// GET /api/consignments/:id
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [row, items] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM consignment_notes WHERE id = ?")
      .bind(id)
      .first<ConsignmentNoteRow>(),
    c.var.DB.prepare(
      "SELECT * FROM consignment_items WHERE consignmentNoteId = ?",
    )
      .bind(id)
      .all<ConsignmentItemRow>(),
  ]);
  if (!row) {
    return c.json({ success: false, error: "Consignment not found" }, 404);
  }
  return c.json({
    success: true,
    data: rowToConsignmentNote(row, items.results ?? []),
  });
});

// PUT /api/consignments/:id — supports status transitions (with auto
// timestamp stamping), driver/vehicle/hub re-resolution, items
// replacement, and the legacy notes/branchName updates. Delegates the
// non-items merge to updateConsignmentNoteById so this and
// /api/consignment-notes share the same lifecycle logic.
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "consignments", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM consignment_notes WHERE id = ?",
    )
      .bind(id)
      .first<ConsignmentNoteRow>();
    if (!existing) {
      return c.json({ success: false, error: "Consignment not found" }, 404);
    }
    const body = (await c.req.json()) as Record<string, unknown>;

    // Pre-flight items-lock check. updateConsignmentNoteById (helper at
    // consignment-note-shared.ts:575) returns reason="items_locked" when
    // body.items is present and the existing/next status isn't ACTIVE.
    // We previously called the helper AFTER deleting items, so the 403
    // bubbled up but the consignment_items rows were already gone. Pre-
    // check here so the lock rejection is non-destructive.
    if (Array.isArray(body.items)) {
      const nextStatus = (body.status as string | undefined) ?? existing.status;
      if (!(existing.status === "ACTIVE" && nextStatus === "ACTIVE")) {
        return c.json(
          {
            success: false,
            error: `Consignment items are locked once status leaves ACTIVE (current: ${existing.status}). Items field rejected.`,
            reason: "items_locked",
            currentStatus: existing.status,
          },
          403,
        );
      }
    }

    // If items provided, replace them and recompute totalValue. We do
    // this before delegating to updateConsignmentNoteById so the helper
    // sees the post-replace state if a future iteration of it reads
    // totalValue.
    let nextTotalValue = existing.totalValue;
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
            `INSERT INTO consignment_items (
               id, consignmentNoteId, productId, productName, productCode,
               quantity, unitPrice, status, soldDate, returnedDate,
               productionOrderId
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            (it.id as string) ?? genItemId(),
            id,
            (it.productId as string) ?? "",
            (it.productName as string) ?? "",
            (it.productCode as string) ?? "",
            qty,
            price,
            (it.status as string) ?? "AT_BRANCH",
            (it.soldDate as string | null) ?? null,
            (it.returnedDate as string | null) ?? null,
            (it.productionOrderId as string | null) ?? null,
          ),
        );
      }
      nextTotalValue = total;
      await c.var.DB.batch(stmts);

      // Persist totalValue separately — updateConsignmentNoteById doesn't
      // own this column. Bind value before delegating to the helper so the
      // status/lifecycle update doesn't clobber it (it doesn't touch
      // totalValue, but we keep the order explicit).
      await c.var.DB
        .prepare("UPDATE consignment_notes SET totalValue = ? WHERE id = ?")
        .bind(nextTotalValue, id)
        .run();
    }

    const res = await updateConsignmentNoteById(c.var.DB, id, body);
    if (!res.ok) {
      // Mirror consignment-notes.ts error mapping (gaps 5 + latent gap 3,
      // 2026-04-29). The helper now returns typed errors for invalid
      // transitions and items-lock past ACTIVE; surface them as 400/403
      // here too instead of a misleading 404.
      if (res.reason === "invalid_transition") {
        return c.json(
          {
            success: false,
            error: `Invalid status transition: ${res.from ?? "(none)"} → ${res.to}`,
            reason: "invalid_transition",
            from: res.from,
            to: res.to,
          },
          400,
        );
      }
      if (res.reason === "items_locked") {
        return c.json(
          {
            success: false,
            error: `Cannot edit items — consignment is in status ${res.currentStatus ?? "(unknown)"} (items only editable while ACTIVE)`,
            reason: "items_locked",
            currentStatus: res.currentStatus,
          },
          403,
        );
      }
      return c.json({ success: false, error: "Consignment not found" }, 404);
    }
    // Audit parity with the canonical /api/consignment-notes PUT
    // (consignment-notes.ts:1031-1049). Any successful update on this
    // legacy surface now leaves the same audit row shape.
    await emitAudit(c, {
      resource: "consignment-notes",
      resourceId: id,
      action: "update",
      before: existing,
      after: res.note,
    });
    return c.json({
      success: true,
      data: rowToConsignmentNote(res.note, res.items),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/consignments/:id
//
// Refuses to delete past ACTIVE — once a CN has been dispatched (status
// PARTIALLY_SOLD / FULLY_SOLD / IN_TRANSIT / DELIVERED / RETURNED) the
// fg_units rows already carry cnId stamps + the goods may have moved
// physically. Mirrors DO's DRAFT-only delete guard
// (delivery-orders.ts:1911 area).
//
// Rolls back any fg_units cnId/status stamps for ACTIVE-state CNs that
// somehow have units pointing at them (defensive — a properly-ACTIVE CN
// shouldn't have fg_units cnId set, but pre-fix CNs and seed data can).
//
// Emits an audit row so the deletion is traceable. Without this any
// delete via this surface vanishes silently.
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "consignments", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM consignment_notes WHERE id = ?",
  )
    .bind(id)
    .first<ConsignmentNoteRow>();
  if (!existing) {
    return c.json({ success: false, error: "Consignment not found" }, 404);
  }

  // Status guard: only ACTIVE CNs are safely deletable. Anything past
  // ACTIVE has live downstream side-effects (fg_units cnId stamps,
  // STOCK_OUT movements, customer outstandingSen reservations) that
  // delete should not silently undo.
  if (existing.status !== "ACTIVE") {
    return c.json(
      {
        success: false,
        error: `Cannot delete consignment note in status ${existing.status}. Mark it as RETURNED or revert to ACTIVE before deleting.`,
        currentStatus: existing.status,
      },
      403,
    );
  }

  // Defensive fg_units rollback for any unit that picked up this cnId
  // (shouldn't happen at ACTIVE but guard against legacy seed state).
  //
  // Only the LOADED rows actually move, so only those get a ledger row — the
  // CASE leaves every other status untouched and a no-op is not an event. The
  // events are written BEFORE the consignment_notes DELETE below for a
  // structural reason: fg_stock_events cascades on fg_unit_id, not on the note,
  // so the trail of a deleted note survives on the units it touched.
  const releasedUnits = await loadFgUnitsForEvent(
    c.var.DB,
    "cnId = ? AND status = 'LOADED'",
    [id],
  );
  await c.var.DB
    .prepare(
      `UPDATE fg_units
          SET cnId = NULL,
              status = CASE WHEN status = 'LOADED' THEN 'PACKED' ELSE status END,
              loadedAt = CASE WHEN status = 'LOADED' THEN NULL ELSE loadedAt END
        WHERE cnId = ?`,
    )
    .bind(id)
    .run();
  await recordFgStockEvents(c.var.DB, releasedUnits, {
    toStatus: "PACKED",
    doc: {
      docType: "CONSIGNMENT_NOTE",
      docId: id,
      docNo: existing.noteNumber ?? null,
    },
    actor: SYSTEM_ACTOR,
    occurredAt: new Date().toISOString(),
    note: `Consignment note ${existing.noteNumber ?? id} deleted — returned to stock`,
    reverses: { docType: "CONSIGNMENT_NOTE", docId: id },
  });

  await c.var.DB.prepare("DELETE FROM consignment_notes WHERE id = ?")
    .bind(id)
    .run();
  // consignment_items cascades via FK

  await emitAudit(c, {
    resource: "consignment-notes",
    resourceId: id,
    action: "delete",
    before: existing,
    after: null,
  });

  return c.json({ success: true });
});

export default app;
