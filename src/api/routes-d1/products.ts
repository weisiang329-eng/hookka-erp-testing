// ---------------------------------------------------------------------------
// D1-backed products route.
//
// Mirrors the old src/api/routes/products.ts shape so the SPA frontend
// doesn't need any changes. `bomComponents` and `deptWorkingTimes` are
// returned as nested arrays joined from their child tables. JSON columns
// (`subAssemblies`, `pieces`, `seatHeightPrices`) are parsed back to objects.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { resolveCustomerPrice } from "./customer-products";

const app = new Hono<Env>();

type ProductRow = {
  id: string;
  code: string;
  name: string;
  category: string;
  description: string | null;
  baseModel: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  fabricUsage: number;
  unitM3: number;
  status: string;
  costPriceSen: number;
  basePriceSen: number | null;
  price1Sen: number | null;
  productionTimeMinutes: number;
  subAssemblies: string | null;
  skuCode: string | null;
  fabricColor: string | null;
  pieces: string | null;
  seatHeightPrices: string | null;
};

type BomComponentRow = {
  id: string;
  productId: string;
  materialCategory: string;
  materialName: string;
  qtyPerUnit: number;
  unit: string;
  wastePct: number;
};

type DeptWorkingTimeRow = {
  id: number;
  productId: string;
  departmentCode: string;
  minutes: number;
  category: string | null;
};

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToProduct(
  row: ProductRow,
  boms: BomComponentRow[] = [],
  dwts: DeptWorkingTimeRow[] = [],
) {
  const productBoms = boms
    .filter((b) => b.productId === row.id)
    .map((b) => ({
      id: b.id,
      materialCategory: b.materialCategory,
      materialName: b.materialName,
      qtyPerUnit: b.qtyPerUnit,
      unit: b.unit,
      wastePct: b.wastePct,
    }));

  const productDwts = dwts
    .filter((d) => d.productId === row.id)
    .map((d) => ({
      departmentCode: d.departmentCode,
      minutes: d.minutes,
      category: d.category ?? "",
    }));

  const base: Record<string, unknown> = {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    description: row.description ?? "",
    baseModel: row.baseModel ?? row.code,
    sizeCode: row.sizeCode ?? "",
    sizeLabel: row.sizeLabel ?? "",
    fabricUsage: row.fabricUsage,
    unitM3: row.unitM3,
    status: row.status,
    costPriceSen: row.costPriceSen,
    productionTimeMinutes: row.productionTimeMinutes,
    subAssemblies: parseJson<string[]>(row.subAssemblies, []),
    bomComponents: productBoms,
    deptWorkingTimes: productDwts,
  };

  if (row.basePriceSen !== null) base.basePriceSen = row.basePriceSen;
  if (row.price1Sen !== null) base.price1Sen = row.price1Sen;
  if (row.skuCode !== null) base.skuCode = row.skuCode;
  if (row.fabricColor !== null) base.fabricColor = row.fabricColor;
  if (row.pieces !== null) {
    base.pieces = parseJson<{ count: number; names: string[] } | null>(
      row.pieces,
      null,
    );
  }
  if (row.seatHeightPrices !== null) {
    base.seatHeightPrices = parseJson<{ height: string; priceSen: number }[]>(
      row.seatHeightPrices,
      [],
    );
  }

  return base;
}

function genProductId(): string {
  return `prod-${crypto.randomUUID().slice(0, 8)}`;
}

function genBomId(): string {
  return `bom-${crypto.randomUUID().slice(0, 8)}`;
}

async function fetchProductWithChildren(db: D1Database, id: string) {
  const [product, bomsRes, dwtsRes] = await Promise.all([
    db.prepare("SELECT * FROM products WHERE id = ?").bind(id).first<ProductRow>(),
    db
      .prepare("SELECT * FROM bom_components WHERE productId = ?")
      .bind(id)
      .all<BomComponentRow>(),
    db
      .prepare("SELECT * FROM dept_working_times WHERE productId = ?")
      .bind(id)
      .all<DeptWorkingTimeRow>(),
  ]);
  if (!product) return null;
  return rowToProduct(product, bomsRes.results ?? [], dwtsRes.results ?? []);
}

// GET /api/products — list ACTIVE products with nested BOM + dept times
app.get("/", async (c) => {
  const [products, boms, dwts] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM products WHERE status = 'ACTIVE' ORDER BY code",
    ).all<ProductRow>(),
    c.env.DB.prepare(
      "SELECT b.* FROM bom_components b INNER JOIN products p ON p.id = b.productId WHERE p.status = 'ACTIVE'",
    ).all<BomComponentRow>(),
    c.env.DB.prepare(
      "SELECT d.* FROM dept_working_times d INNER JOIN products p ON p.id = d.productId WHERE p.status = 'ACTIVE'",
    ).all<DeptWorkingTimeRow>(),
  ]);

  const data = (products.results ?? []).map((p) =>
    rowToProduct(p, boms.results ?? [], dwts.results ?? []),
  );
  return c.json({ success: true, data });
});

// POST /api/products — create (rejects duplicate codes)
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { code, name, category } = body;
    if (!code || !name || !category) {
      return c.json(
        { success: false, error: "code, name, and category are required" },
        400,
      );
    }

    // Duplicate code check
    const dup = await c.env.DB.prepare(
      "SELECT id FROM products WHERE code = ?",
    )
      .bind(code)
      .first<{ id: string }>();
    if (dup) {
      return c.json(
        { success: false, error: `Product code ${code} already exists` },
        400,
      );
    }

    const id = genProductId();
    const bomComponentsInput: Array<{
      materialCategory: string;
      materialName: string;
      qtyPerUnit?: number;
      unit?: string;
      wastePct?: number;
    }> = body.bomComponents ?? [];
    const deptWorkingTimesInput: Array<{
      departmentCode: string;
      minutes: number;
      category?: string;
    }> = body.deptWorkingTimes ?? [];

    const totalMinutes = deptWorkingTimesInput.reduce(
      (sum, d) => sum + (d.minutes || 0),
      0,
    );

    // Build batch: insert product + bom components + dept times atomically
    const statements = [
      c.env.DB.prepare(
        `INSERT INTO products (id, code, name, category, description, baseModel,
           sizeCode, sizeLabel, fabricUsage, unitM3, status, costPriceSen,
           basePriceSen, price1Sen, productionTimeMinutes, subAssemblies,
           skuCode, fabricColor, pieces, seatHeightPrices)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        body.code,
        body.name,
        body.category,
        body.description ?? "",
        body.baseModel ?? body.code,
        body.sizeCode ?? "",
        body.sizeLabel ?? "",
        body.fabricUsage ?? 0,
        body.unitM3 ?? 0,
        "ACTIVE",
        body.costPriceSen ?? 0,
        body.basePriceSen ?? null,
        body.price1Sen ?? null,
        totalMinutes,
        JSON.stringify(body.subAssemblies ?? []),
        body.skuCode ?? null,
        body.fabricColor ?? null,
        body.pieces ? JSON.stringify(body.pieces) : null,
        body.seatHeightPrices ? JSON.stringify(body.seatHeightPrices) : null,
      ),
      ...bomComponentsInput.map((comp) =>
        c.env.DB.prepare(
          `INSERT INTO bom_components (id, productId, materialCategory, materialName,
             qtyPerUnit, unit, wastePct)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          genBomId(),
          id,
          comp.materialCategory,
          comp.materialName,
          comp.qtyPerUnit ?? 0,
          comp.unit ?? "PCS",
          comp.wastePct ?? 0,
        ),
      ),
      ...deptWorkingTimesInput.map((dwt) =>
        c.env.DB.prepare(
          `INSERT INTO dept_working_times (productId, departmentCode, minutes, category)
           VALUES (?, ?, ?, ?)`,
        ).bind(id, dwt.departmentCode, dwt.minutes || 0, dwt.category ?? null),
      ),
    ];

    await c.env.DB.batch(statements);

    const created = await fetchProductWithChildren(c.env.DB, id);
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create product" },
        500,
      );
    }
    return c.json({ success: true, data: created }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/products/:productId/price-for-customer/:customerId —
// resolve the effective price for a (productId, customerId) pair.
// Must be registered BEFORE /:id so the more-specific path wins.
app.get("/:productId/price-for-customer/:customerId", async (c) => {
  const productId = c.req.param("productId");
  const customerId = c.req.param("customerId");
  const data = await resolveCustomerPrice(c.env.DB, productId, customerId);
  if (!data) {
    return c.json({ success: false, error: "Product not found" }, 404);
  }
  return c.json({ success: true, data });
});

// GET /api/products/:id — single product + BOM + dept times
app.get("/:id", async (c) => {
  const product = await fetchProductWithChildren(c.env.DB, c.req.param("id"));
  if (!product) {
    return c.json({ success: false, error: "Product not found" }, 404);
  }
  return c.json({ success: true, data: product });
});

// PUT /api/products/:id — update (recomputes productionTimeMinutes from dept times)
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await c.env.DB.prepare(
      "SELECT * FROM products WHERE id = ?",
    )
      .bind(id)
      .first<ProductRow>();
    if (!existing) {
      return c.json({ success: false, error: "Product not found" }, 404);
    }
    const body = await c.req.json();

    // deptWorkingTimes — if provided, replace entirely; otherwise keep existing
    const existingDwtsRes = await c.env.DB.prepare(
      "SELECT * FROM dept_working_times WHERE productId = ?",
    )
      .bind(id)
      .all<DeptWorkingTimeRow>();
    const existingDwts = existingDwtsRes.results ?? [];

    const deptTimesInput: Array<{
      departmentCode: string;
      minutes: number;
      category?: string;
    }> =
      body.deptWorkingTimes ??
      existingDwts.map((d) => ({
        departmentCode: d.departmentCode,
        minutes: d.minutes,
        category: d.category ?? "",
      }));
    const totalMinutes = deptTimesInput.reduce(
      (sum, d) => sum + (d.minutes || 0),
      0,
    );

    const merged = {
      code: body.code ?? existing.code,
      name: body.name ?? existing.name,
      category: body.category ?? existing.category,
      description: body.description ?? existing.description ?? "",
      baseModel: body.baseModel ?? existing.baseModel ?? existing.code,
      sizeCode: body.sizeCode ?? existing.sizeCode ?? "",
      sizeLabel: body.sizeLabel ?? existing.sizeLabel ?? "",
      fabricUsage: body.fabricUsage ?? existing.fabricUsage,
      unitM3: body.unitM3 ?? existing.unitM3,
      status: body.status ?? existing.status,
      costPriceSen: body.costPriceSen ?? existing.costPriceSen,
      basePriceSen:
        body.basePriceSen === undefined
          ? existing.basePriceSen
          : body.basePriceSen,
      price1Sen:
        body.price1Sen === undefined ? existing.price1Sen : body.price1Sen,
      productionTimeMinutes: totalMinutes,
      subAssemblies: JSON.stringify(
        body.subAssemblies ?? parseJson<string[]>(existing.subAssemblies, []),
      ),
      skuCode: body.skuCode ?? existing.skuCode,
      fabricColor: body.fabricColor ?? existing.fabricColor,
      pieces:
        body.pieces === undefined
          ? existing.pieces
          : body.pieces
            ? JSON.stringify(body.pieces)
            : null,
      seatHeightPrices:
        body.seatHeightPrices === undefined
          ? existing.seatHeightPrices
          : body.seatHeightPrices
            ? JSON.stringify(body.seatHeightPrices)
            : null,
    };

    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `UPDATE products SET
           code = ?, name = ?, category = ?, description = ?, baseModel = ?,
           sizeCode = ?, sizeLabel = ?, fabricUsage = ?, unitM3 = ?, status = ?,
           costPriceSen = ?, basePriceSen = ?, price1Sen = ?,
           productionTimeMinutes = ?, subAssemblies = ?, skuCode = ?,
           fabricColor = ?, pieces = ?, seatHeightPrices = ?
         WHERE id = ?`,
      ).bind(
        merged.code,
        merged.name,
        merged.category,
        merged.description,
        merged.baseModel,
        merged.sizeCode,
        merged.sizeLabel,
        merged.fabricUsage,
        merged.unitM3,
        merged.status,
        merged.costPriceSen,
        merged.basePriceSen,
        merged.price1Sen,
        merged.productionTimeMinutes,
        merged.subAssemblies,
        merged.skuCode,
        merged.fabricColor,
        merged.pieces,
        merged.seatHeightPrices,
        id,
      ),
    ];

    // If bomComponents was provided, replace the whole set
    if (body.bomComponents !== undefined) {
      const bomsInput: Array<{
        id?: string;
        materialCategory: string;
        materialName: string;
        qtyPerUnit?: number;
        unit?: string;
        wastePct?: number;
      }> = body.bomComponents ?? [];
      statements.push(
        c.env.DB.prepare(
          "DELETE FROM bom_components WHERE productId = ?",
        ).bind(id),
      );
      for (const comp of bomsInput) {
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO bom_components (id, productId, materialCategory, materialName,
               qtyPerUnit, unit, wastePct)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            comp.id || genBomId(),
            id,
            comp.materialCategory,
            comp.materialName,
            comp.qtyPerUnit ?? 0,
            comp.unit ?? "PCS",
            comp.wastePct ?? 0,
          ),
        );
      }
    }

    // If deptWorkingTimes was provided, replace the whole set
    if (body.deptWorkingTimes !== undefined) {
      const dwtsInput: Array<{
        departmentCode: string;
        minutes: number;
        category?: string;
      }> = body.deptWorkingTimes ?? [];
      statements.push(
        c.env.DB.prepare(
          "DELETE FROM dept_working_times WHERE productId = ?",
        ).bind(id),
      );
      for (const dwt of dwtsInput) {
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO dept_working_times (productId, departmentCode, minutes, category)
             VALUES (?, ?, ?, ?)`,
          ).bind(
            id,
            dwt.departmentCode,
            dwt.minutes || 0,
            dwt.category ?? null,
          ),
        );
      }
    }

    await c.env.DB.batch(statements);

    const updated = await fetchProductWithChildren(c.env.DB, id);
    return c.json({ success: true, data: updated });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/products/:id — soft delete (status = 'INACTIVE')
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare(
    "SELECT * FROM products WHERE id = ?",
  )
    .bind(id)
    .first<ProductRow>();
  if (!existing) {
    return c.json({ success: false, error: "Product not found" }, 404);
  }
  await c.env.DB.prepare(
    "UPDATE products SET status = 'INACTIVE' WHERE id = ?",
  )
    .bind(id)
    .run();

  const updated = await fetchProductWithChildren(c.env.DB, id);
  return c.json({ success: true, data: updated });
});

export default app;
