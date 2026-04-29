// ---------------------------------------------------------------------------
// D1-backed goods-in-transit route.
//
// Mirrors src/api/routes/goods-in-transit.ts. Items are stored as a JSON blob
// in the `items` TEXT column (not a child table), matching the in-memory type
// `GoodsInTransit`. We parse/stringify at the boundary.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type GoodsInTransitRow = {
  id: string;
  poId: string | null;
  poNumber: string | null;
  supplierId: string | null;
  supplierName: string | null;
  shippingMethod: "SEA" | "AIR" | "LAND" | "COURIER" | null;
  containerNumber: string | null;
  trackingNumber: string | null;
  carrierName: string | null;
  status: "ORDERED" | "SHIPPED" | "IN_TRANSIT" | "CUSTOMS" | "RECEIVED" | null;
  orderDate: string | null;
  shippedDate: string | null;
  expectedArrival: string | null;
  actualArrival: string | null;
  customsClearanceDate: string | null;
  customsStatus: "N/A" | "PENDING" | "CLEARED" | "HELD" | null;
  currency: "MYR" | "RMB" | null;
  productCost: number;
  shippingCost: number;
  customsDuty: number;
  exchangeRate: number | null;
  landedCost: number;
  items: string | null;
  notes: string | null;
};

type GITItem = {
  materialCode: string;
  materialName: string;
  quantity: number;
  unitCost: number;
};

function safeParseItems(text: string | null): GITItem[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToGIT(r: GoodsInTransitRow) {
  return {
    id: r.id,
    poId: r.poId ?? "",
    poNumber: r.poNumber ?? "",
    supplierId: r.supplierId ?? "",
    supplierName: r.supplierName ?? "",
    shippingMethod: r.shippingMethod ?? "SEA",
    containerNumber: r.containerNumber,
    trackingNumber: r.trackingNumber,
    carrierName: r.carrierName ?? "",
    status: r.status ?? "ORDERED",
    orderDate: r.orderDate ?? "",
    shippedDate: r.shippedDate,
    expectedArrival: r.expectedArrival ?? "",
    actualArrival: r.actualArrival,
    customsClearanceDate: r.customsClearanceDate,
    customsStatus: r.customsStatus ?? "N/A",
    currency: r.currency ?? "MYR",
    productCost: r.productCost,
    shippingCost: r.shippingCost,
    customsDuty: r.customsDuty,
    exchangeRate: r.exchangeRate,
    landedCost: r.landedCost,
    items: safeParseItems(r.items),
    notes: r.notes ?? "",
  };
}

function genId(): string {
  return `git-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/goods-in-transit?status=...&supplierId=...
app.get("/", async (c) => {
  const status = c.req.query("status");
  const supplierId = c.req.query("supplierId");
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    where.push("status = ?");
    binds.push(status);
  }
  if (supplierId) {
    where.push("supplierId = ?");
    binds.push(supplierId);
  }
  const sql =
    where.length > 0
      ? `SELECT * FROM goods_in_transit WHERE ${where.join(" AND ")} ORDER BY orderDate DESC, id DESC`
      : "SELECT * FROM goods_in_transit ORDER BY orderDate DESC, id DESC";
  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<GoodsInTransitRow>();
  const data = (res.results ?? []).map(rowToGIT);
  return c.json({ success: true, data });
});

// POST /api/goods-in-transit — create new transit record
app.post("/", async (c) => {
  const denied = await requirePermission(c, "goods-in-transit", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { poNumber, supplierId, supplierName, shippingMethod, items } = body;
    if (
      !poNumber ||
      !supplierId ||
      !supplierName ||
      !shippingMethod ||
      !items ||
      items.length === 0
    ) {
      return c.json(
        {
          success: false,
          error:
            "poNumber, supplierId, supplierName, shippingMethod, and items are required",
        },
        400,
      );
    }

    const productCost = Number(body.productCost) || 0;
    const shippingCost = Number(body.shippingCost) || 0;
    const customsDuty = Number(body.customsDuty) || 0;
    const landedCost =
      body.landedCost !== undefined
        ? Number(body.landedCost)
        : productCost + shippingCost + customsDuty;

    const normalizedItems: GITItem[] = (items as Array<Record<string, unknown>>).map(
      (item) => ({
        materialCode: (item.materialCode as string) ?? "",
        materialName: (item.materialName as string) ?? "",
        quantity: Number(item.quantity) || 0,
        unitCost: Number(item.unitCost) || 0,
      }),
    );

    const id = genId();
    const row = {
      id,
      poId: (body.poId as string) ?? "",
      poNumber: String(poNumber),
      supplierId: String(supplierId),
      supplierName: String(supplierName),
      shippingMethod: String(shippingMethod),
      containerNumber: body.containerNumber ?? null,
      trackingNumber: body.trackingNumber ?? null,
      carrierName: body.carrierName ?? "",
      status: body.status ?? "ORDERED",
      orderDate: body.orderDate ?? new Date().toISOString().split("T")[0],
      shippedDate: body.shippedDate ?? null,
      expectedArrival: body.expectedArrival ?? "",
      actualArrival: body.actualArrival ?? null,
      customsClearanceDate: body.customsClearanceDate ?? null,
      customsStatus: body.customsStatus ?? "N/A",
      currency: body.currency ?? "MYR",
      productCost,
      shippingCost,
      customsDuty,
      exchangeRate: body.exchangeRate ?? null,
      landedCost,
      items: JSON.stringify(normalizedItems),
      notes: body.notes ?? "",
    };

    await c.var.DB.prepare(
      `INSERT INTO goods_in_transit (id, poId, poNumber, supplierId, supplierName,
         shippingMethod, containerNumber, trackingNumber, carrierName, status,
         orderDate, shippedDate, expectedArrival, actualArrival,
         customsClearanceDate, customsStatus, currency, productCost,
         shippingCost, customsDuty, exchangeRate, landedCost, items, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id,
        row.poId,
        row.poNumber,
        row.supplierId,
        row.supplierName,
        row.shippingMethod,
        row.containerNumber,
        row.trackingNumber,
        row.carrierName,
        row.status,
        row.orderDate,
        row.shippedDate,
        row.expectedArrival,
        row.actualArrival,
        row.customsClearanceDate,
        row.customsStatus,
        row.currency,
        row.productCost,
        row.shippingCost,
        row.customsDuty,
        row.exchangeRate,
        row.landedCost,
        row.items,
        row.notes,
      )
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM goods_in_transit WHERE id = ?",
    )
      .bind(id)
      .first<GoodsInTransitRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create transit entry" },
        500,
      );
    }
    return c.json({ success: true, data: rowToGIT(created) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/goods-in-transit/:id — single transit entry
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
    "SELECT * FROM goods_in_transit WHERE id = ?",
  )
    .bind(id)
    .first<GoodsInTransitRow>();
  if (!row) {
    return c.json({ success: false, error: "Transit entry not found" }, 404);
  }
  return c.json({ success: true, data: rowToGIT(row) });
});

// PUT /api/goods-in-transit/:id — update scalar fields (items not replaced here,
// matching in-memory behavior)
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "goods-in-transit", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM goods_in_transit WHERE id = ?",
  )
    .bind(id)
    .first<GoodsInTransitRow>();
  if (!existing) {
    return c.json({ success: false, error: "Transit entry not found" }, 404);
  }
  try {
    const body = await c.req.json();
    const merged = {
      status: body.status ?? existing.status ?? "ORDERED",
      shippedDate:
        body.shippedDate !== undefined ? body.shippedDate : existing.shippedDate,
      expectedArrival: body.expectedArrival ?? existing.expectedArrival ?? "",
      actualArrival:
        body.actualArrival !== undefined
          ? body.actualArrival
          : existing.actualArrival,
      customsClearanceDate:
        body.customsClearanceDate !== undefined
          ? body.customsClearanceDate
          : existing.customsClearanceDate,
      customsStatus: body.customsStatus ?? existing.customsStatus ?? "N/A",
      containerNumber:
        body.containerNumber !== undefined
          ? body.containerNumber
          : existing.containerNumber,
      trackingNumber:
        body.trackingNumber !== undefined
          ? body.trackingNumber
          : existing.trackingNumber,
      carrierName: body.carrierName ?? existing.carrierName ?? "",
      shippingMethod: body.shippingMethod ?? existing.shippingMethod ?? "SEA",
      productCost:
        body.productCost !== undefined
          ? Number(body.productCost)
          : existing.productCost,
      shippingCost:
        body.shippingCost !== undefined
          ? Number(body.shippingCost)
          : existing.shippingCost,
      customsDuty:
        body.customsDuty !== undefined
          ? Number(body.customsDuty)
          : existing.customsDuty,
      exchangeRate:
        body.exchangeRate !== undefined
          ? body.exchangeRate
          : existing.exchangeRate,
      landedCost:
        body.landedCost !== undefined
          ? Number(body.landedCost)
          : existing.landedCost,
      notes: body.notes ?? existing.notes ?? "",
    };

    await c.var.DB.prepare(
      `UPDATE goods_in_transit SET
         status = ?, shippedDate = ?, expectedArrival = ?, actualArrival = ?,
         customsClearanceDate = ?, customsStatus = ?, containerNumber = ?,
         trackingNumber = ?, carrierName = ?, shippingMethod = ?,
         productCost = ?, shippingCost = ?, customsDuty = ?, exchangeRate = ?,
         landedCost = ?, notes = ?
       WHERE id = ?`,
    )
      .bind(
        merged.status,
        merged.shippedDate,
        merged.expectedArrival,
        merged.actualArrival,
        merged.customsClearanceDate,
        merged.customsStatus,
        merged.containerNumber,
        merged.trackingNumber,
        merged.carrierName,
        merged.shippingMethod,
        merged.productCost,
        merged.shippingCost,
        merged.customsDuty,
        merged.exchangeRate,
        merged.landedCost,
        merged.notes,
        id,
      )
      .run();

    const updated = await c.var.DB.prepare(
      "SELECT * FROM goods_in_transit WHERE id = ?",
    )
      .bind(id)
      .first<GoodsInTransitRow>();
    if (!updated) {
      return c.json(
        { success: false, error: "Failed to reload transit entry" },
        500,
      );
    }
    return c.json({ success: true, data: rowToGIT(updated) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/goods-in-transit/:id
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "goods-in-transit", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM goods_in_transit WHERE id = ?",
  )
    .bind(id)
    .first<GoodsInTransitRow>();
  if (!existing) {
    return c.json({ success: false, error: "Transit entry not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM goods_in_transit WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true, data: rowToGIT(existing) });
});

export default app;
