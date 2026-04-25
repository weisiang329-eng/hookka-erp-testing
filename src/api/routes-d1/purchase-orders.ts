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
import { notifySupplierPoSubmitted } from "../lib/email";
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

// Same transitions as the in-memory route
const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PARTIAL_RECEIVED", "RECEIVED", "CANCELLED"],
  PARTIAL_RECEIVED: ["RECEIVED", "CANCELLED"],
  RECEIVED: [],
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
function genGrnId(): string {
  return `grn-${crypto.randomUUID().slice(0, 8)}`;
}

// Mirror of grn.ts generateGrnNumber — scans existing GRN numbers for the
// current YYMM prefix and increments. Duplicated locally so the cascade is
// fully contained in this file.
async function generateGrnNumber(db: D1Database): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `GRN-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT grnNumber FROM grns WHERE grnNumber LIKE ? ORDER BY grnNumber DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ grnNumber: string }>();
  const seq = res?.grnNumber ? Number(res.grnNumber.split("-").pop()) + 1 : 1;
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

// Generate next PO number by scanning existing poNo for the current YYMM
// prefix and incrementing the max sequence. Falls back to 001.
async function generatePoNo(db: D1Database): Promise<string> {
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
  const [pos, items] = await Promise.all([
    c.var.DB.prepare(
      "SELECT * FROM purchase_orders ORDER BY created_at DESC, id DESC",
    ).all<PurchaseOrderRow>(),
    c.var.DB.prepare(
      "SELECT * FROM purchase_order_items",
    ).all<PurchaseOrderItemRow>(),
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
    const poNo = await generatePoNo(c.var.DB);
    const now = new Date().toISOString();
    const today = now.split("T")[0];

    const items = (rawItems as Array<Record<string, unknown>>).map((item) => {
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

    await c.var.DB.batch(statements);

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
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
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
    }

    const statements: D1PreparedStatement[] = [];
    let subtotalSen = existing.subtotalSen;
    let totalSen = existing.totalSen;

    // If items provided, replace them entirely and recompute totals
    if (body.items !== undefined) {
      const rawItems: Array<Record<string, unknown>> = Array.isArray(body.items)
        ? body.items
        : [];
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

    // ---------------------------------------------------------------------
    // Procurement cascade — PO RECEIVED triggers auto-creation of a DRAFT
    // GRN so the warehouse team can walk the aisle and fill in actual
    // received quantities. Idempotent via an existence check on grns.poId.
    // Uses the item list we resolved above (either body.items when the
    // request replaced them, or the existing rows in the DB).
    // ---------------------------------------------------------------------
    const isReceivedTransition =
      body.status === "RECEIVED" && existing.status !== "RECEIVED";
    if (isReceivedTransition) {
      const existingGrn = await c.var.DB.prepare(
        "SELECT id FROM grns WHERE poId = ? LIMIT 1",
      )
        .bind(id)
        .first<{ id: string }>();
      if (!existingGrn) {
        // Gather the line set we want GRN items for. If body.items was
        // present the batch above will have replaced the rows; otherwise
        // we fall back to the current DB state.
        const poItemRows: PurchaseOrderItemRow[] = await (async () => {
          if (body.items !== undefined) {
            const raw = Array.isArray(body.items)
              ? (body.items as Array<Record<string, unknown>>)
              : [];
            return raw.map((item) => ({
              id: String(item.id ?? ""),
              purchaseOrderId: id,
              materialCategory: (item.materialCategory as string) ?? "",
              materialName: (item.materialName as string) ?? "",
              supplierSKU: (item.supplierSKU as string) ?? "",
              quantity: Number(item.quantity) || 0,
              unitPriceSen: Number(item.unitPriceSen) || 0,
              totalSen:
                (Number(item.quantity) || 0) *
                (Number(item.unitPriceSen) || 0),
              receivedQty: Number(item.receivedQty) || 0,
              unit: (item.unit as string) ?? "pcs",
            }));
          }
          const existingItems = await c.var.DB.prepare(
            "SELECT * FROM purchase_order_items WHERE purchaseOrderId = ?",
          )
            .bind(id)
            .all<PurchaseOrderItemRow>();
          return existingItems.results ?? [];
        })();

        const grnId = genGrnId();
        const grnNumber = await generateGrnNumber(c.var.DB);
        const today = now.split("T")[0];
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO grns (id, grnNumber, poId, poNumber, supplierId,
               supplierName, receiveDate, receivedBy, totalAmount,
               qcStatus, status, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'DRAFT', ?)`,
          ).bind(
            grnId,
            grnNumber,
            id,
            existing.poNo,
            merged.supplierId,
            merged.supplierName,
            today,
            "",
            0,
            "Auto-created on PO receive",
          ),
        );
        poItemRows.forEach((item, idx) => {
          statements.push(
            c.var.DB.prepare(
              `INSERT INTO grn_items (grnId, poItemIndex, materialCode,
                 materialName, orderedQty, receivedQty, acceptedQty,
                 rejectedQty, rejectionReason, unitPrice)
               VALUES (?, ?, ?, ?, ?, 0, 0, 0, NULL, ?)`,
            ).bind(
              grnId,
              idx,
              item.supplierSKU ?? "",
              item.materialName ?? "",
              item.quantity,
              item.unitPriceSen,
            ),
          );
        });
      }
    }

    await c.var.DB.batch(statements);

    // Fire-and-forget supplier notification when a PO is submitted. Stubbed
    // out as a console log for now — real Resend wiring can hook into the
    // same call site later.
    if (body.status === "SUBMITTED" && existing.status !== "SUBMITTED") {
      try {
        notifySupplierPoSubmitted({
          poNo: existing.poNo,
          supplierName: merged.supplierName,
          supplierId: merged.supplierId,
        });
      } catch {
        // Never let a stub break the PO update.
      }
    }

    const updated = await fetchPOWithItems(c.var.DB, id);
    return c.json({ success: true, data: updated });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
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
