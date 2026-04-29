// ---------------------------------------------------------------------------
// D1-backed supplier-materials route.
//
// Mirrors src/api/routes/supplier-materials.ts. Backed by the
// `supplier_material_bindings` table (per-SKU price bindings with a validity
// window and main-supplier flag) — this is DIFFERENT from `supplier_materials`
// (which is the catalogue field nested in each Supplier, see suppliers.ts).
//
// Schema column `isMainSupplier` is INTEGER 0/1; we return it as boolean.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

type BindingRow = {
  id: string;
  supplierId: string;
  materialCode: string;
  materialName: string;
  supplierSku: string;
  unitPrice: number;
  currency: "MYR" | "RMB" | null;
  leadTimeDays: number;
  paymentTerms: string | null;
  moq: number;
  priceValidFrom: string | null;
  priceValidTo: string | null;
  isMainSupplier: number;
};

function rowToBinding(r: BindingRow) {
  return {
    id: r.id,
    supplierId: r.supplierId,
    materialCode: r.materialCode,
    materialName: r.materialName,
    supplierSku: r.supplierSku,
    unitPrice: r.unitPrice,
    currency: r.currency ?? "MYR",
    leadTimeDays: r.leadTimeDays,
    paymentTerms: r.paymentTerms ?? "NET30",
    moq: r.moq,
    priceValidFrom: r.priceValidFrom ?? "",
    priceValidTo: r.priceValidTo ?? "",
    isMainSupplier: r.isMainSupplier === 1,
  };
}

function genId(): string {
  return `smb-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/supplier-materials?supplierId=...&materialCode=...
app.get("/", async (c) => {
  const supplierId = c.req.query("supplierId");
  const materialCode = c.req.query("materialCode");
  const orgId = getOrgId(c);
  const where: string[] = ["orgId = ?"];
  const binds: unknown[] = [orgId];
  if (supplierId) {
    where.push("supplierId = ?");
    binds.push(supplierId);
  }
  if (materialCode) {
    where.push("materialCode = ?");
    binds.push(materialCode);
  }
  const sql = `SELECT * FROM supplier_material_bindings WHERE ${where.join(" AND ")} ORDER BY materialCode`;
  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<BindingRow>();
  const data = (res.results ?? []).map(rowToBinding);
  return c.json({ success: true, data });
});

// POST /api/supplier-materials — create a new price binding
app.post("/", async (c) => {
  const denied = await requirePermission(c, "supplier-materials", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { supplierId, materialCode, materialName, supplierSku, unitPrice } =
      body;
    if (
      !supplierId ||
      !materialCode ||
      !materialName ||
      !supplierSku ||
      unitPrice == null
    ) {
      return c.json(
        {
          success: false,
          error:
            "supplierId, materialCode, materialName, supplierSku, and unitPrice are required",
        },
        400,
      );
    }
    const id = genId();
    const row = {
      id,
      supplierId: String(supplierId),
      materialCode: String(materialCode),
      materialName: String(materialName),
      supplierSku: String(supplierSku),
      unitPrice: Number(unitPrice),
      currency: body.currency === "RMB" ? "RMB" : "MYR",
      leadTimeDays: Number(body.leadTimeDays) || 7,
      paymentTerms: body.paymentTerms ?? "NET30",
      moq: Number(body.moq) || 1,
      priceValidFrom:
        body.priceValidFrom ?? new Date().toISOString().slice(0, 10),
      priceValidTo: body.priceValidTo ?? "2026-12-31",
      isMainSupplier: body.isMainSupplier ? 1 : 0,
    };
    await c.var.DB.prepare(
      `INSERT INTO supplier_material_bindings (id, supplierId, materialCode,
         materialName, supplierSku, unitPrice, currency, leadTimeDays,
         paymentTerms, moq, priceValidFrom, priceValidTo, isMainSupplier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id,
        row.supplierId,
        row.materialCode,
        row.materialName,
        row.supplierSku,
        row.unitPrice,
        row.currency,
        row.leadTimeDays,
        row.paymentTerms,
        row.moq,
        row.priceValidFrom,
        row.priceValidTo,
        row.isMainSupplier,
      )
      .run();
    const created = await c.var.DB.prepare(
      "SELECT * FROM supplier_material_bindings WHERE id = ?",
    )
      .bind(id)
      .first<BindingRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create binding" },
        500,
      );
    }
    return c.json({ success: true, data: rowToBinding(created) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/supplier-materials/:id
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
    "SELECT * FROM supplier_material_bindings WHERE id = ?",
  )
    .bind(id)
    .first<BindingRow>();
  if (!row) return c.json({ success: false, error: "Binding not found" }, 404);
  return c.json({ success: true, data: rowToBinding(row) });
});

// PUT /api/supplier-materials/:id — shallow merge partial update
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "supplier-materials", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM supplier_material_bindings WHERE id = ?",
  )
    .bind(id)
    .first<BindingRow>();
  if (!existing) {
    return c.json({ success: false, error: "Binding not found" }, 404);
  }
  try {
    const body = await c.req.json();
    const merged = {
      supplierId: body.supplierId ?? existing.supplierId,
      materialCode: body.materialCode ?? existing.materialCode,
      materialName: body.materialName ?? existing.materialName,
      supplierSku: body.supplierSku ?? existing.supplierSku,
      unitPrice:
        body.unitPrice !== undefined ? Number(body.unitPrice) : existing.unitPrice,
      currency:
        body.currency === "RMB" || body.currency === "MYR"
          ? body.currency
          : existing.currency ?? "MYR",
      leadTimeDays:
        body.leadTimeDays !== undefined
          ? Number(body.leadTimeDays)
          : existing.leadTimeDays,
      paymentTerms: body.paymentTerms ?? existing.paymentTerms ?? "NET30",
      moq: body.moq !== undefined ? Number(body.moq) : existing.moq,
      priceValidFrom: body.priceValidFrom ?? existing.priceValidFrom ?? "",
      priceValidTo: body.priceValidTo ?? existing.priceValidTo ?? "",
      isMainSupplier:
        body.isMainSupplier === undefined
          ? existing.isMainSupplier
          : body.isMainSupplier
            ? 1
            : 0,
    };
    await c.var.DB.prepare(
      `UPDATE supplier_material_bindings SET
         supplierId = ?, materialCode = ?, materialName = ?, supplierSku = ?,
         unitPrice = ?, currency = ?, leadTimeDays = ?, paymentTerms = ?,
         moq = ?, priceValidFrom = ?, priceValidTo = ?, isMainSupplier = ?
       WHERE id = ?`,
    )
      .bind(
        merged.supplierId,
        merged.materialCode,
        merged.materialName,
        merged.supplierSku,
        merged.unitPrice,
        merged.currency,
        merged.leadTimeDays,
        merged.paymentTerms,
        merged.moq,
        merged.priceValidFrom,
        merged.priceValidTo,
        merged.isMainSupplier,
        id,
      )
      .run();
    const updated = await c.var.DB.prepare(
      "SELECT * FROM supplier_material_bindings WHERE id = ?",
    )
      .bind(id)
      .first<BindingRow>();
    if (!updated) {
      return c.json(
        { success: false, error: "Failed to reload binding" },
        500,
      );
    }
    return c.json({ success: true, data: rowToBinding(updated) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/supplier-materials/:id
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "supplier-materials", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM supplier_material_bindings WHERE id = ?",
  )
    .bind(id)
    .first<BindingRow>();
  if (!existing) {
    return c.json({ success: false, error: "Binding not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM supplier_material_bindings WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true, data: rowToBinding(existing) });
});

export default app;
