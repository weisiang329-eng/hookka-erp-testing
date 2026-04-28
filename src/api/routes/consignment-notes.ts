// ---------------------------------------------------------------------------
// D1-backed Consignment Notes route.
//
// Shares consignment_notes + consignment_items tables with routes/consignments.ts.
// This surface exposes a slightly different API:
//   - GET   /     — list
//   - POST  /     — create (no customer validation)
//   - PATCH /     — update status/notes/branchName + dispatch lifecycle by body.id
//   - PUT   /:id  — same as PATCH but addressed by URL param (FE alias)
//
// Row mapping + carrier resolution lives in api/lib/consignment-note-shared.ts
// so this file and consignments.ts stay in lock-step.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
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
      .all<ConsignmentNoteRow>(),
    c.var.DB.prepare("SELECT * FROM consignment_items").all<ConsignmentItemRow>(),
  ]);
  const data = (notesRes.results ?? []).map((r) =>
    rowToConsignmentNote(r, itemsRes.results ?? []),
  );
  return c.json({ success: true, data, total: data.length });
});

// POST /api/consignment-notes
//
// Body shape (all fields optional unless noted):
//   customerId?, customerName?, branchName?, type?, sentDate?, notes?
//   hubId?                       — delivery_hubs row, drives branchName fallback
//   consignmentOrderId?          — parent CO id (FK to consignment_orders)
//   providerId? / driverId? / vehicleId?
//                                — 3PL refactor lookup (see resolveTransport)
//   driverName? driverPhone? driverContactPerson? vehicleNo? vehicleType?
//                                — explicit overrides for the resolved values
//   productionOrderIds?: string[]
//                                — when provided, INSERT one consignment_items
//                                  row per PO with production_order_id set.
//                                  Mirrors DO's "create from Pending Delivery"
//                                  flow. Each item picks productCode +
//                                  productName + quantity from production_orders.
//   items?: Array<{...}>         — explicit items array (legacy callers).
//                                  Used as a fallback when productionOrderIds
//                                  isn't passed.
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const now = new Date();
    const noteNumber = await nextConsignmentNoteNumber(c.var.DB, now);
    const id = genNoteId();

    // Resolve hub → branchName + state. Mirrors how DO denormalizes
    // hubName/customerState from delivery_hubs at insert time.
    let resolvedBranchName = (body.branchName as string | undefined) ?? "";
    const hubId = (body.hubId as string | undefined) ?? null;
    if (hubId) {
      const hub = await c.var.DB.prepare(
        "SELECT id, shortName FROM delivery_hubs WHERE id = ?",
      )
        .bind(hubId)
        .first<{ id: string; shortName: string | null }>();
      if (hub && !resolvedBranchName) {
        resolvedBranchName = hub.shortName ?? "";
      }
    }
    // No customer_state column on consignment_notes (unlike delivery_orders),
    // so we don't denormalize the hub's state here. The hub_id FK is enough
    // for downstream reads to JOIN delivery_hubs when state is needed.

    // Carrier resolution (provider/driver/vehicle).
    const transport = await resolveTransport(c.var.DB, body);

    // Items source preference:
    //   1. body.productionOrderIds (DO-style "create from Pending CN")
    //   2. body.items (legacy explicit array)
    // Either way produces consignment_items rows; productionOrderIds path
    // sets production_order_id, items-array path may set it too if the
    // caller passed it.
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
        unitPrice: 0, // CN pricing is set on the parent CO; line items
        // copy 0 by default and the user can edit later via PUT.
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
        body.customerId ?? "",
        body.customerName ?? "",
        resolvedBranchName,
        body.sentDate ?? now.toISOString().split("T")[0],
        "ACTIVE",
        totalValue,
        body.notes ?? "",
        // Carrier metadata. driverId on consignment_notes mirrors the DO
        // convention — stores the PROVIDER company id, not the person.
        // The actual person id (when picked) lives in the request body
        // and is denormalized into driverName + driverPhone here.
        transport.providerId,
        transport.driverName,
        transport.driverContactPerson,
        transport.driverPhone,
        transport.vehicleId,
        transport.vehicleNo,
        transport.vehicleType,
        // Lifecycle timestamps — null on create. Get stamped by PATCH/PUT
        // when status flips PARTIALLY_SOLD / FULLY_SOLD / CLOSED.
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
      return c.json(
        { success: false, error: "Failed to create consignment note" },
        500,
      );
    }
    return c.json(
      { success: true, data: rowToConsignmentNote(created, items.results ?? []) },
      201,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/consignment-notes] failed:", msg);
    return c.json({ success: false, error: msg || "Invalid request body" }, 400);
  }
});

// PATCH /api/consignment-notes — partial update by body.id (legacy shape).
//
// See updateConsignmentNoteById for the lifecycle / driver / vehicle /
// hub merge semantics. Both this PATCH and the PUT /:id alias delegate
// to that helper so the two paths stay identical.
app.patch("/", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    if (!body.id || typeof body.id !== "string") {
      return c.json({ success: false, error: "id required in body" }, 400);
    }
    const res = await updateConsignmentNoteById(c.var.DB, body.id, body);
    if (!res.ok) {
      return c.json(
        { success: false, error: "Consignment note not found" },
        404,
      );
    }
    return c.json({
      success: true,
      data: rowToConsignmentNote(res.note, res.items),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// PUT /api/consignment-notes/:id — same as PATCH but addressed by URL
// param. FE alias so the CN page's row-action menu can use REST-style
// `/api/consignment-notes/{id}` instead of the body-id PATCH.
app.put("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = (await c.req.json()) as Record<string, unknown>;
    const res = await updateConsignmentNoteById(c.var.DB, id, body);
    if (!res.ok) {
      return c.json(
        { success: false, error: "Consignment note not found" },
        404,
      );
    }
    return c.json({
      success: true,
      data: rowToConsignmentNote(res.note, res.items),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;
