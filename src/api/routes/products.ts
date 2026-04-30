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
import { checkProductDeleteLocked, lockedResponse } from "../lib/lock-helpers";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";

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

// --- BOM-derived production-time helpers -----------------------------------
// The Products list shows "Total Min" per SKU. Historically this column was
// the snapshot stored on products.productionTimeMinutes, which doesn't move
// when somebody edits the BOM template (qty changes, process additions). Users
// expect the column to follow the BOM in real time, so /api/products now
// re-computes it on read by walking the active bom_templates row for that
// productCode. The walker matches src/pages/bom.tsx exactly: cumulative qty
// multiplier from root → leaf so child WIPs (foam/frame/wood under a divan
// qty=2) get counted at ×2.
type WipNode = {
  quantity?: number;
  processes?: { minutes?: number }[];
  children?: WipNode[];
};
type L1Process = { minutes?: number };

function sumWipTreeMinutes(wips: WipNode[], parentMul: number = 1): number {
  let total = 0;
  for (const w of wips) {
    const mul = parentMul * (w.quantity ?? 1);
    for (const p of w.processes ?? []) total += (p.minutes ?? 0) * mul;
    if (w.children?.length) total += sumWipTreeMinutes(w.children, mul);
  }
  return total;
}

function bomTotalMinutes(
  l1Processes: L1Process[],
  wipComponents: WipNode[],
): number {
  const l1 = l1Processes.reduce((s, p) => s + (p.minutes ?? 0), 0);
  return l1 + sumWipTreeMinutes(wipComponents);
}

function rowToProduct(
  row: ProductRow,
  boms: BomComponentRow[] = [],
  dwts: DeptWorkingTimeRow[] = [],
  bomMinutesByCode?: Map<string, number>,
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

  // Prefer the BOM-derived total (recursive walk over l1 + wipComponents).
  // Fall back to the stored snapshot when a product has no active template
  // yet — keeps newly-created SKUs from rendering 0 min.
  const bomMin = bomMinutesByCode?.get(row.code);
  const productionTimeMinutes =
    typeof bomMin === "number" && bomMin > 0
      ? bomMin
      : row.productionTimeMinutes;

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
    productionTimeMinutes,
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
  // Pull the ACTIVE bom_template for this productCode so the response
  // carries a real-time totalMinutes derived from the current BOM tree
  // rather than the stored products.productionTimeMinutes snapshot.
  const tplRow = await db
    .prepare(
      `SELECT l1Processes, wipComponents FROM bom_templates
       WHERE productCode = ? AND UPPER(COALESCE(versionStatus,'DRAFT')) = 'ACTIVE'
       ORDER BY effectiveFrom DESC NULLS LAST
       LIMIT 1`,
    )
    .bind(product.code)
    .first<{ l1Processes: string | null; wipComponents: string | null }>();
  const bomMinutesByCode = new Map<string, number>();
  if (tplRow) {
    const l1 = parseJson<L1Process[]>(tplRow.l1Processes, []);
    const wips = parseJson<WipNode[]>(tplRow.wipComponents, []);
    bomMinutesByCode.set(product.code, bomTotalMinutes(l1, wips));
  }
  return rowToProduct(
    product,
    bomsRes.results ?? [],
    dwtsRes.results ?? [],
    bomMinutesByCode,
  );
}

// GET /api/products — list ACTIVE products with nested BOM + dept times.
// Production-time column is computed live from bom_templates so the SPA
// list doesn't drift away from the source of truth when somebody edits
// the BOM tree (qty changes, process additions). Falls back to the stored
// snapshot for SKUs that have no ACTIVE template yet.
app.get("/", async (c) => {
  const orgId = getOrgId(c);
  const [products, boms, dwts, tpls] = await Promise.all([
    c.var.DB.prepare(
      "SELECT * FROM products WHERE orgId = ? AND status = 'ACTIVE' ORDER BY code",
    )
      .bind(orgId)
      .all<ProductRow>(),
    c.var.DB.prepare(
      "SELECT b.* FROM bom_components b INNER JOIN products p ON p.id = b.productId WHERE p.orgId = ? AND p.status = 'ACTIVE'",
    )
      .bind(orgId)
      .all<BomComponentRow>(),
    c.var.DB.prepare(
      "SELECT d.* FROM dept_working_times d INNER JOIN products p ON p.id = d.productId WHERE p.orgId = ? AND p.status = 'ACTIVE'",
    )
      .bind(orgId)
      .all<DeptWorkingTimeRow>(),
    c.var.DB.prepare(
      `SELECT productCode, l1Processes, wipComponents, effectiveFrom
         FROM bom_templates
        WHERE UPPER(COALESCE(versionStatus,'DRAFT')) = 'ACTIVE'
        ORDER BY productCode, effectiveFrom DESC NULLS LAST`,
    ).all<{
      productCode: string;
      l1Processes: string | null;
      wipComponents: string | null;
      effectiveFrom: string | null;
    }>(),
  ]);

  // First-write-wins per productCode preserves the most-recent ACTIVE
  // template (ORDER BY ... effectiveFrom DESC). Tie-break on duplicate
  // ACTIVE rows is handled by the SELECT order above.
  const bomMinutesByCode = new Map<string, number>();
  for (const t of tpls.results ?? []) {
    if (bomMinutesByCode.has(t.productCode)) continue;
    const l1 = parseJson<L1Process[]>(t.l1Processes, []);
    const wips = parseJson<WipNode[]>(t.wipComponents, []);
    bomMinutesByCode.set(t.productCode, bomTotalMinutes(l1, wips));
  }

  const data = (products.results ?? []).map((p) =>
    rowToProduct(p, boms.results ?? [], dwts.results ?? [], bomMinutesByCode),
  );
  return c.json({ success: true, data });
});

// POST /api/products — create (rejects duplicate codes)
app.post("/", async (c) => {
  const denied = await requirePermission(c, "products", "create");
  if (denied) return denied;
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
    const dup = await c.var.DB.prepare(
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
      c.var.DB.prepare(
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
        c.var.DB.prepare(
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
        c.var.DB.prepare(
          `INSERT INTO dept_working_times (productId, departmentCode, minutes, category)
           VALUES (?, ?, ?, ?)`,
        ).bind(id, dwt.departmentCode, dwt.minutes || 0, dwt.category ?? null),
      ),
    ];

    await c.var.DB.batch(statements);

    const created = await fetchProductWithChildren(c.var.DB, id);
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

// GET /api/products/:id — single product + BOM + dept times
app.get("/:id", async (c) => {
  const product = await fetchProductWithChildren(c.var.DB, c.req.param("id"));
  if (!product) {
    return c.json({ success: false, error: "Product not found" }, 404);
  }
  return c.json({ success: true, data: product });
});

// PUT /api/products/:id — update (recomputes productionTimeMinutes from dept times)
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "products", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM products WHERE id = ?",
    )
      .bind(id)
      .first<ProductRow>();
    if (!existing) {
      return c.json({ success: false, error: "Product not found" }, 404);
    }
    const body = await c.req.json();

    // deptWorkingTimes — if provided, replace entirely; otherwise keep existing
    const existingDwtsRes = await c.var.DB.prepare(
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
      c.var.DB.prepare(
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
        c.var.DB.prepare(
          "DELETE FROM bom_components WHERE productId = ?",
        ).bind(id),
      );
      for (const comp of bomsInput) {
        statements.push(
          c.var.DB.prepare(
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
        c.var.DB.prepare(
          "DELETE FROM dept_working_times WHERE productId = ?",
        ).bind(id),
      );
      for (const dwt of dwtsInput) {
        statements.push(
          c.var.DB.prepare(
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

    await c.var.DB.batch(statements);

    const updated = await fetchProductWithChildren(c.var.DB, id);
    return c.json({ success: true, data: updated });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/products/:id — soft delete (status = 'INACTIVE').
// Cascade-lock guard: rejects with 409 if the product is referenced by any
// active SO/CO line, active production order, or active BOM template.
// Forces the operator to resolve those references before retiring the SKU.
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "products", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM products WHERE id = ?",
  )
    .bind(id)
    .first<ProductRow>();
  if (!existing) {
    return c.json({ success: false, error: "Product not found" }, 404);
  }
  const lockMsg = await checkProductDeleteLocked(
    c.var.DB,
    id,
    existing.code ?? "",
  );
  if (lockMsg) {
    return c.json(lockedResponse(lockMsg), 409);
  }
  await c.var.DB.prepare(
    "UPDATE products SET status = 'INACTIVE' WHERE id = ?",
  )
    .bind(id)
    .run();

  const updated = await fetchProductWithChildren(c.var.DB, id);
  return c.json({ success: true, data: updated });
});

export default app;
