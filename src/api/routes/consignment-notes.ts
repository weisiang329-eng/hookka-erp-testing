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
import { nextInvoiceNo } from "./invoices";
import { emitAudit } from "../lib/audit";

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

// ---------------------------------------------------------------------------
// GET /api/consignment-notes/stats — whole-dataset KPI / tab counts.
//
// Mirrors the rationale behind /api/delivery-orders/stats: the CN list is
// paginated to PAGE_SIZE on the FE, but the KPI strip + tab badges need
// to reflect the FULL dataset, not just the current page. Once production
// CN volume goes past a single page, computing counts client-side from
// `cnList` undercounts every metric.
//
// Bucket → status mapping (legacy CN status enum, the FE re-skins):
//   pendingDispatch  ← status='ACTIVE'           (Pending Dispatch tab)
//   dispatched       ← status='PARTIALLY_SOLD'   (Dispatched tab — the goods left
//                                                  the warehouse but haven't
//                                                  reached the branch yet)
//   inTransit        ← status='IN_TRANSIT'       (In Transit tab — added with
//                                                  migration 0078; mirrors DO's
//                                                  3-state shipping lane)
//   delivered        ← status='FULLY_SOLD'       (Delivered tab)
//   acknowledged     ← status='CLOSED'           (Acknowledged tab)
//   deliveredMTD     ← FULLY_SOLD AND deliveredAt ≥ start-of-current-month UTC
//                                                (KPI: deliveries booked
//                                                 month-to-date)
//
// pendingCN intentionally NOT computed server-side — the derivation is
// the multi-step JOIN-and-filter "CO-origin POs that are fully UPHOLSTERY-
// complete AND not on any consignment_note", which is a rewrite of the FE's
// readyPOs computation in note.tsx (~lines 933-947). Doing it correctly
// requires loading production_orders + their job_cards + the linked CN
// items just for a count, which is more work than the rest of /stats put
// together. The FE keeps its current readyPOs-based pendingCNCount for
// now; follow-up if it ever shows undercount on a production dataset.
//
// Registered BEFORE the PUT /:id wildcard per the project memory note
// about Hono route ordering (static routes before /:id wildcards or they
// get swallowed). The two GET routes (this one + GET /) live above the
// POST/PATCH/PUT routes; static path "/stats" + parameterless GET means
// no collision with the PUT /:id route registered later in the file.
// ---------------------------------------------------------------------------
app.get("/stats", async (c) => {
  // byStatus aggregate. Same shape as /api/delivery-orders/stats so a
  // future refactor can collapse the two if we ever decide to.
  const aggRes = await c.var.DB
    .prepare(
      "SELECT status, COUNT(*) AS n FROM consignment_notes GROUP BY status",
    )
    .all<{ status: string; n: number }>();
  const byStatus: Record<string, number> = {};
  for (const row of aggRes.results ?? []) {
    byStatus[row.status] = Number(row.n) || 0;
  }

  // deliveredMTD — count of FULLY_SOLD CNs whose deliveredAt timestamp is
  // ≥ first-of-this-month (UTC). Operator's KPI: "how many CNs reached
  // the branch this month so far". String comparison works because
  // deliveredAt is stored as ISO 8601 (lexicographic order = chronological
  // order for same-format ISO strings).
  const now = new Date();
  const startOfMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  const mtdRes = await c.var.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM consignment_notes
         WHERE status = 'FULLY_SOLD' AND deliveredAt >= ?`,
    )
    .bind(startOfMonth)
    .first<{ n: number }>();
  const deliveredMTD = Number(mtdRes?.n) || 0;

  return c.json({
    success: true,
    data: {
      // pendingCN intentionally omitted — see route header rationale.
      pendingDispatch: byStatus.ACTIVE ?? 0,
      dispatched: byStatus.PARTIALLY_SOLD ?? 0,
      inTransit: byStatus.IN_TRANSIT ?? 0,
      delivered: byStatus.FULLY_SOLD ?? 0,
      deliveredMTD,
      acknowledged: byStatus.CLOSED ?? 0,
    },
  });
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
        // when status flips PARTIALLY_SOLD / IN_TRANSIT / FULLY_SOLD /
        // CLOSED. inTransitAt added by migration 0078.
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

// ---------------------------------------------------------------------------
// POST /api/consignment-notes/:id/return — process a Consignment Return.
//
// Body: { items: [{ id: string, quantity: number }] }
//   - id          consignment_items.id of the line being returned
//   - quantity    number of units to return (must be ≤ item.quantity)
//
// Side effects (everything in a single c.var.DB.batch so a partial failure
// rolls back):
//   1. consignment_items: rows where returnQty fully covers item.quantity
//      flip status='RETURNED' + returnedDate=now. Partial returns reduce
//      item.quantity by returnQty (item stays AT_BRANCH for the remaining
//      units — the legacy schema has no per-item returnedQty column, and
//      adding one would force a wider migration; reducing quantity keeps
//      the totalValue recompute trivial).
//   2. consignment_notes: stamp dispatchedAt fallback if not yet set
//      (a return implies the goods physically left); recompute totalValue;
//      flip status to RETURNED if every item is fully returned, otherwise
//      PARTIALLY_SOLD (the legacy enum value the FE re-skins as DISPATCHED;
//      see note.tsx cnStatusFromBackend()).
//   3. fg_units: for every item with a productionOrderId, find DELIVERED
//      units tied to that PO (limit returnQty) and flip them to 'RETURNED'
//      with returnedAt=now. Why we update FG stock: the goods are coming
//      back into our warehouse, so the fg_units ledger that the Inventory
//      page reads has to reflect that. Mirrors the LOADED→DRAFT reversal
//      pattern in delivery-orders.ts (the inverse of the dispatch-time
//      stamping).
//   4. stock_movements: write one STOCK_IN audit row per item with
//      reason='CONSIGNMENT_RETURN' and rackLabel=PO.rackingNumber so the
//      racking ledger shows the round-trip. Schema CHECK on
//      stock_movements.type only allows STOCK_IN/STOCK_OUT/TRANSFER, so
//      we use STOCK_IN (positive qty back into stock); the reason field
//      carries the business-event tag.
//
// SAFETY: if a CN item has no productionOrderId or the PO has been
// deleted, we DO NOT crash. The CN status update + consignment_items
// update still apply; we just skip the fg_units flip + stock_movements
// row for that item and log a warning. The user's task spec calls this
// out explicitly ("legacy CN whose source PO is deleted").
// ---------------------------------------------------------------------------
app.post("/:id/return", async (c) => {
  try {
    const id = c.req.param("id");
    const body = (await c.req.json()) as {
      items?: Array<{ id?: unknown; quantity?: unknown }>;
    };
    const requestedItems = Array.isArray(body.items) ? body.items : [];
    if (requestedItems.length === 0) {
      return c.json(
        { success: false, error: "items array is required and must be non-empty" },
        400,
      );
    }

    // Read source CN + items.
    const [cn, itemsRes] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM consignment_notes WHERE id = ?")
        .bind(id)
        .first<ConsignmentNoteRow>(),
      c.var.DB.prepare(
        "SELECT * FROM consignment_items WHERE consignmentNoteId = ?",
      )
        .bind(id)
        .all<ConsignmentItemRow>(),
    ]);
    if (!cn) {
      return c.json({ success: false, error: "Consignment note not found" }, 404);
    }
    const cnItems = itemsRes.results ?? [];
    const itemById = new Map(cnItems.map((it) => [it.id, it]));

    // Validate every requested item exists on the CN and the requested
    // returnQty is ≤ item.quantity. We do all validation up-front so a
    // bad payload doesn't half-apply.
    type ValidatedReturn = {
      item: ConsignmentItemRow;
      returnQty: number;
      isFull: boolean;
    };
    const validated: ValidatedReturn[] = [];
    for (const r of requestedItems) {
      const itemId = typeof r.id === "string" ? r.id : "";
      const returnQty = Number(r.quantity);
      if (!itemId || !Number.isFinite(returnQty) || returnQty <= 0) {
        return c.json(
          { success: false, error: "Each item needs id (string) and quantity (positive number)" },
          400,
        );
      }
      const item = itemById.get(itemId);
      if (!item) {
        return c.json(
          { success: false, error: `CN item ${itemId} not found on consignment note ${id}` },
          400,
        );
      }
      if (returnQty > item.quantity) {
        return c.json(
          {
            success: false,
            error: `Return quantity ${returnQty} exceeds item quantity ${item.quantity} for ${itemId}`,
          },
          400,
        );
      }
      validated.push({ item, returnQty, isFull: returnQty === item.quantity });
    }

    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];

    // ----------- consignment_items updates -----------
    // Track post-update qty for each touched item so we can recompute
    // totalValue + decide the parent CN's next status without re-reading.
    const postUpdateQtyByItemId = new Map<string, number>();
    for (const { item, returnQty, isFull } of validated) {
      if (isFull) {
        statements.push(
          c.var.DB.prepare(
            `UPDATE consignment_items
                SET status = 'RETURNED', returnedDate = ?
              WHERE id = ?`,
          ).bind(now, item.id),
        );
        postUpdateQtyByItemId.set(item.id, 0);
      } else {
        const remaining = item.quantity - returnQty;
        statements.push(
          c.var.DB.prepare(
            `UPDATE consignment_items
                SET quantity = ?
              WHERE id = ?`,
          ).bind(remaining, item.id),
        );
        postUpdateQtyByItemId.set(item.id, remaining);
      }
    }

    // ----------- fg_units flip + stock_movements audit -----------
    // For each validated item, look up the linked PO, find DELIVERED
    // fg_units we can flag RETURNED, and write a STOCK_IN audit row.
    // Skip items with no PO link or whose PO has been deleted (legacy
    // CN safety per task spec).
    for (const { item, returnQty } of validated) {
      const poId = item.productionOrderId;
      if (!poId) {
        console.warn(
          `[CN return] item ${item.id} has no productionOrderId — skipping fg_units + stock_movements (legacy row)`,
        );
        continue;
      }
      const po = await c.var.DB.prepare(
        `SELECT id, productCode, productName, quantity, rackingNumber
           FROM production_orders WHERE id = ?`,
      )
        .bind(poId)
        .first<{
          id: string;
          productCode: string | null;
          productName: string | null;
          quantity: number | null;
          rackingNumber: string | null;
        }>();
      if (!po) {
        console.warn(
          `[CN return] productionOrder ${poId} not found — skipping fg_units + stock_movements for item ${item.id}`,
        );
        continue;
      }

      // Pick up to returnQty DELIVERED units for this PO and flip them
      // RETURNED. We use a sub-SELECT with LIMIT to keep the operation
      // bounded (a PO with 10 units shouldn't flip all 10 if only 3 are
      // being returned). If fewer than returnQty units exist (mismatched
      // ledgers), we flip what's there and let the stock_movements audit
      // record the requested qty — operations can reconcile later.
      statements.push(
        c.var.DB.prepare(
          `UPDATE fg_units
              SET status = 'RETURNED', returnedAt = ?
            WHERE id IN (
              SELECT id FROM fg_units
                WHERE poId = ? AND status = 'DELIVERED'
                ORDER BY deliveredAt DESC
                LIMIT ?
            )`,
        ).bind(now, po.id, returnQty),
      );

      statements.push(
        c.var.DB.prepare(
          `INSERT INTO stock_movements (
             id, type, rackLocationId, rackLabel, productionOrderId,
             productCode, productName, quantity, reason, performedBy,
             created_at
           ) VALUES (?, 'STOCK_IN', ?, ?, ?, ?, ?, ?, ?, 'System', ?)`,
        ).bind(
          `mov-${crypto.randomUUID().slice(0, 8)}`,
          null,
          po.rackingNumber ?? "",
          po.id,
          po.productCode ?? "",
          po.productName ?? "",
          returnQty,
          "CONSIGNMENT_RETURN",
          now,
        ),
      );
    }

    // ----------- consignment_notes status + totalValue -----------
    // Recompute totalValue from the post-update quantities. Items not
    // touched keep their original quantity.
    let nextTotalValue = 0;
    for (const it of cnItems) {
      const q =
        postUpdateQtyByItemId.has(it.id)
          ? postUpdateQtyByItemId.get(it.id)!
          : it.quantity;
      nextTotalValue += q * it.unitPrice;
    }

    // All-returned check: every original item must end up with qty=0 +
    // status='RETURNED'. Iterate cnItems (the source of truth pre-update)
    // and consult our post-update map.
    const allReturned = cnItems.every((it) => {
      const post = postUpdateQtyByItemId.get(it.id);
      return post !== undefined && post === 0;
    });

    // Pick next status per task spec:
    //   * fully returned → RETURNED
    //   * partial         → PARTIALLY_SOLD (the legacy "some items left
    //                       the warehouse" state; FE re-skins as DISPATCHED)
    const nextStatus = allReturned ? "RETURNED" : "PARTIALLY_SOLD";

    // Stamp dispatchedAt if not yet set (a return implies the goods
    // physically left at some prior point even if the operator skipped
    // the Mark Dispatched click).
    const dispatchedAt = cn.dispatchedAt ?? now;

    statements.push(
      c.var.DB.prepare(
        `UPDATE consignment_notes
            SET status = ?, totalValue = ?, dispatchedAt = ?
          WHERE id = ?`,
      ).bind(nextStatus, nextTotalValue, dispatchedAt, id),
    );

    await c.var.DB.batch(statements);

    // Audit (best-effort — never blocks the mutation per audit.ts contract).
    await emitAudit(c, {
      resource: "consignment-notes",
      resourceId: id,
      action: "return",
      after: {
        id,
        status: nextStatus,
        returnedItems: validated.map((v) => ({ id: v.item.id, quantity: v.returnQty })),
      },
    });

    // Read back the canonical row + items so the FE can refresh without a
    // second fetch.
    const [updatedNote, updatedItemsRes] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM consignment_notes WHERE id = ?")
        .bind(id)
        .first<ConsignmentNoteRow>(),
      c.var.DB.prepare(
        "SELECT * FROM consignment_items WHERE consignmentNoteId = ?",
      )
        .bind(id)
        .all<ConsignmentItemRow>(),
    ]);
    if (!updatedNote) {
      return c.json(
        { success: false, error: "Consignment note disappeared mid-update" },
        500,
      );
    }
    return c.json({
      success: true,
      data: rowToConsignmentNote(updatedNote, updatedItemsRes.results ?? []),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/consignment-notes/:id/return] failed:", msg);
    return c.json({ success: false, error: msg || "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /api/consignment-notes/:id/convert-to-invoice — convert a CN into a
// Sales Invoice.
//
// Body (all optional):
//   notes?: string   — passed through to the invoice's notes column
//
// What it does:
//   1. Reads the source CN + items.
//   2. Pulls unit prices from the parent Consignment Order's items
//      (consignment_order_items) where productCode matches, falling back
//      to the unitPrice already on consignment_items, then 0.
//   3. Generates a sequential invoice number via nextInvoiceNo() (shared
//      INV-YYMM-NNN sequence, fixed 2026-04-28).
//   4. INSERTs a DRAFT invoice with delivery_order_id=NULL +
//      sales_order_id=NULL — this is a CN-origin invoice. See migration
//      0070 header for why we chose CN→Invoice as one-way (no reverse
//      FK on invoices). Customer + hub fields denormalized from the CN.
//   5. INSERTs invoice_items mirroring CN items.
//   6. UPDATEs consignment_notes.status='FULLY_SOLD' (the legacy enum
//      value the FE re-skins as DELIVERED) and stamps deliveredAt if not
//      yet set. Writes converted_invoice_id pointing at the new invoice.
//   7. Marks every consignment_items row status='SOLD' + soldDate=now.
// ---------------------------------------------------------------------------
app.post("/:id/convert-to-invoice", async (c) => {
  try {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      notes?: string;
    };

    // Read source CN + items.
    const [cn, itemsRes] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM consignment_notes WHERE id = ?")
        .bind(id)
        .first<ConsignmentNoteRow>(),
      c.var.DB.prepare(
        "SELECT * FROM consignment_items WHERE consignmentNoteId = ?",
      )
        .bind(id)
        .all<ConsignmentItemRow>(),
    ]);
    if (!cn) {
      return c.json({ success: false, error: "Consignment note not found" }, 404);
    }
    const cnItems = itemsRes.results ?? [];

    // Idempotency guard — if the CN already converted, return the existing
    // invoice id rather than creating a duplicate. (Stops a double-click
    // from generating two invoices for the same CN.)
    if (cn.convertedInvoiceId) {
      return c.json(
        {
          success: false,
          error: `Consignment note already converted to invoice ${cn.convertedInvoiceId}`,
          invoiceId: cn.convertedInvoiceId,
        },
        409,
      );
    }

    // Pull unit prices from the parent CO's items (best-effort fallback).
    // CN items often store unitPrice=0 because pricing lives on the CO line.
    let priceByCode = new Map<string, number>();
    if (cn.consignmentOrderId) {
      const coItemsRes = await c.var.DB.prepare(
        "SELECT productCode, unitPriceSen FROM consignment_order_items WHERE consignmentOrderId = ?",
      )
        .bind(cn.consignmentOrderId)
        .all<{ productCode: string | null; unitPriceSen: number | null }>();
      priceByCode = new Map(
        (coItemsRes.results ?? [])
          .filter((r) => r.productCode)
          .map((r) => [r.productCode as string, Number(r.unitPriceSen) || 0]),
      );
    }

    const invoiceItems = cnItems.map((it) => {
      // Price preference: CO item > CN item > 0.
      const fromCo = it.productCode ? priceByCode.get(it.productCode) : undefined;
      const unitPriceSen =
        fromCo !== undefined ? fromCo : Number(it.unitPrice) || 0;
      return {
        id: `invi-${crypto.randomUUID().slice(0, 8)}`,
        productCode: it.productCode ?? "",
        productName: it.productName ?? "",
        sizeLabel: "",
        fabricCode: "",
        quantity: it.quantity,
        unitPriceSen,
        totalSen: unitPriceSen * it.quantity,
      };
    });

    const subtotalSen = invoiceItems.reduce((s, i) => s + i.totalSen, 0);
    const totalSen = subtotalSen;
    const now = new Date().toISOString();
    const invoiceDate = now.split("T")[0];
    const due = new Date();
    due.setDate(due.getDate() + 30);
    const dueDate = due.toISOString().split("T")[0];
    const invoiceId = `inv-${crypto.randomUUID().slice(0, 8)}`;
    const invoiceNo = await nextInvoiceNo(c.var.DB);

    // Resolve hub name for denormalization (matches the DO→invoice path).
    let hubName: string | null = null;
    if (cn.hubId) {
      const hub = await c.var.DB.prepare(
        "SELECT shortName FROM delivery_hubs WHERE id = ?",
      )
        .bind(cn.hubId)
        .first<{ shortName: string | null }>();
      hubName = hub?.shortName ?? null;
    }

    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `INSERT INTO invoices (
           id, invoiceNo, deliveryOrderId, doNo, salesOrderId, companySOId,
           customerId, customerName, customerState, hubId, hubName,
           subtotalSen, totalSen, status, invoiceDate, dueDate, paidAmount,
           paymentDate, paymentMethod, notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        invoiceId,
        invoiceNo,
        // CN-origin invoice: deliveryOrderId + doNo + salesOrderId stay
        // null. The CN linkage is held one-way on consignment_notes
        // .convertedInvoiceId (migration 0070).
        null,
        null,
        null,
        null,
        cn.customerId,
        cn.customerName ?? "",
        null,
        cn.hubId,
        hubName,
        subtotalSen,
        totalSen,
        "DRAFT",
        invoiceDate,
        dueDate,
        0,
        null,
        "",
        body.notes ?? `Converted from consignment note ${cn.noteNumber}`,
        now,
        now,
      ),
      ...invoiceItems.map((item) =>
        c.var.DB.prepare(
          `INSERT INTO invoice_items (
             id, invoiceId, productCode, productName, sizeLabel, fabricCode,
             quantity, unitPriceSen, totalSen
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          item.id,
          invoiceId,
          item.productCode,
          item.productName,
          item.sizeLabel,
          item.fabricCode,
          item.quantity,
          item.unitPriceSen,
          item.totalSen,
        ),
      ),
      // Flip CN to FULLY_SOLD + link the new invoice id back. Stamp
      // deliveredAt if not already (a sale-conversion implies the goods
      // reached the customer's hands).
      c.var.DB.prepare(
        `UPDATE consignment_notes
            SET status = 'FULLY_SOLD',
                deliveredAt = COALESCE(deliveredAt, ?),
                convertedInvoiceId = ?
          WHERE id = ?`,
      ).bind(now, invoiceId, id),
      // Mark every CN item SOLD with soldDate=now. The legacy enum allows
      // AT_BRANCH / SOLD / RETURNED / DAMAGED — SOLD is the right tag for
      // the convert-to-invoice action.
      c.var.DB.prepare(
        `UPDATE consignment_items
            SET status = 'SOLD', soldDate = ?
          WHERE consignmentNoteId = ? AND status = 'AT_BRANCH'`,
      ).bind(now, id),
    ];

    await c.var.DB.batch(statements);

    // Audit (best-effort).
    await emitAudit(c, {
      resource: "consignment-notes",
      resourceId: id,
      action: "convert-to-invoice",
      after: {
        id,
        invoiceId,
        invoiceNo,
        totalSen,
      },
    });

    return c.json(
      {
        success: true,
        data: {
          invoiceId,
          invoiceNo,
          totalSen,
          consignmentNoteId: id,
        },
      },
      201,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/consignment-notes/:id/convert-to-invoice] failed:", msg);
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
