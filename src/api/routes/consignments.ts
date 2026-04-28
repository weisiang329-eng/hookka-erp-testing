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
import {
  type ConsignmentNoteRow,
  type ConsignmentItemRow,
  rowToConsignmentNote,
  genNoteId,
  genItemId,
  nextConsignmentNoteNumber,
  resolveTransport,
  updateConsignmentNoteById,
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
           dispatchedAt, deliveredAt, acknowledgedAt,
           consignmentOrderId, hubId
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?, ?,
                   ?, ?, ?,
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
        // Lifecycle timestamps null on create.
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
      return c.json({ success: false, error: "Consignment not found" }, 404);
    }
    return c.json({
      success: true,
      data: rowToConsignmentNote(res.note, res.items),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/consignments/:id
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
  await c.var.DB.prepare("DELETE FROM consignment_notes WHERE id = ?")
    .bind(id)
    .run();
  // consignment_items cascades via FK
  return c.json({ success: true });
});

export default app;
