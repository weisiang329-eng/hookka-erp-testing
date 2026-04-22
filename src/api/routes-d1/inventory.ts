// ---------------------------------------------------------------------------
// D1-backed inventory route.
//
// Mirrors src/api/routes/inventory.ts shape so the SPA frontend doesn't
// need any changes. Response envelope:
//   {
//     success: true,
//     data: { finishedProducts, wipItems, rawMaterials }
//   }
//
// `finishedProducts` are products joined with a deterministic seeded stock
// quantity (matches the in-memory seededRandom output for index i).
// `wipItems` come from the wip_items table and `rawMaterials` from
// raw_materials. The raw material POST endpoint validates uniqueness of
// itemCode the same way as the in-memory route.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

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

type WipItemRow = {
  id: string;
  code: string;
  type: string;
  relatedProduct: string | null;
  deptStatus: string | null;
  stockQty: number;
  status: string;
};

type RawMaterialRow = {
  id: string;
  itemCode: string;
  description: string;
  baseUOM: string;
  itemGroup: string;
  isActive: number;
  balanceQty: number;
};

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToProduct(row: ProductRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    description: row.description ?? "",
    baseModel: row.baseModel ?? "",
    sizeCode: row.sizeCode ?? "",
    sizeLabel: row.sizeLabel ?? "",
    fabricUsage: row.fabricUsage,
    unitM3: row.unitM3,
    status: row.status,
    costPriceSen: row.costPriceSen,
    basePriceSen: row.basePriceSen ?? 0,
    price1Sen: row.price1Sen ?? 0,
    productionTimeMinutes: row.productionTimeMinutes,
    subAssemblies: parseJson<string[]>(row.subAssemblies, []),
    skuCode: row.skuCode ?? "",
    fabricColor: row.fabricColor ?? "",
    pieces: parseJson<{ count: number; names: string[] } | null>(
      row.pieces,
      null,
    ),
    seatHeightPrices: parseJson<Array<{ height: string; priceSen: number }>>(
      row.seatHeightPrices,
      [],
    ),
  };
}

function rowToWipItem(row: WipItemRow) {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    relatedProduct: row.relatedProduct ?? "",
    deptStatus: row.deptStatus ?? "",
    stockQty: row.stockQty,
    status: row.status,
  };
}

function rowToRawMaterial(row: RawMaterialRow) {
  return {
    id: row.id,
    itemCode: row.itemCode,
    description: row.description,
    baseUOM: row.baseUOM,
    itemGroup: row.itemGroup,
    isActive: row.isActive === 1,
    balanceQty: row.balanceQty,
  };
}

// Deterministic seeded random — matches the in-memory route so the same
// product index always produces the same stockQty. Preserves a frontend
// expectation (stable stock numbers in dev).
function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function genRmId(): string {
  return `rm-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/inventory — all three buckets
app.get("/", async (c) => {
  const [productsRes, wipRes, rmRes] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM products ORDER BY code").all<ProductRow>(),
    c.env.DB.prepare("SELECT * FROM wip_items ORDER BY id").all<WipItemRow>(),
    c.env.DB.prepare(
      "SELECT * FROM raw_materials ORDER BY itemCode",
    ).all<RawMaterialRow>(),
  ]);

  const finishedProducts = (productsRes.results ?? []).map((p, i) => ({
    ...rowToProduct(p),
    stockQty: Math.floor(seededRandom(i + 1) * 51),
  }));
  const wipItems = (wipRes.results ?? []).map(rowToWipItem);
  const rawMaterials = (rmRes.results ?? []).map(rowToRawMaterial);

  return c.json({
    success: true,
    data: { finishedProducts, wipItems, rawMaterials },
  });
});

// POST /api/inventory/raw-materials — create a raw material row
app.post("/raw-materials", async (c) => {
  try {
    const body = await c.req.json();
    const { itemCode, description, baseUOM } = body;
    if (!itemCode || !description) {
      return c.json(
        { success: false, error: "itemCode and description are required" },
        400,
      );
    }

    // Duplicate check — matches in-memory uniqueness on itemCode
    const exists = await c.env.DB.prepare(
      "SELECT id FROM raw_materials WHERE itemCode = ? LIMIT 1",
    )
      .bind(itemCode)
      .first<{ id: string }>();
    if (exists) {
      return c.json(
        { success: false, error: `Raw material ${itemCode} already exists` },
        400,
      );
    }

    const id = genRmId();
    const isActive = body.isActive === false ? 0 : 1;
    const itemGroup = body.itemGroup ?? "General";
    const balanceQty = Number(body.balanceQty) || 0;
    const uom = baseUOM || "PCS";

    await c.env.DB.prepare(
      `INSERT INTO raw_materials (id, itemCode, description, baseUOM, itemGroup,
         isActive, balanceQty)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, itemCode, description, uom, itemGroup, isActive, balanceQty)
      .run();

    const created = await c.env.DB.prepare(
      "SELECT * FROM raw_materials WHERE id = ?",
    )
      .bind(id)
      .first<RawMaterialRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create raw material" },
        500,
      );
    }
    return c.json({ success: true, data: rowToRawMaterial(created) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;
