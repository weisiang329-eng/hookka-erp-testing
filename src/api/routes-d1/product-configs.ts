// ---------------------------------------------------------------------------
// D1-backed product-configs route.
//
// Mirrors src/api/routes/product-configs.ts — a single GET that returns every
// row in the `product_dept_configs` lookup table (per-product dept working
// time defaults sourced from the GSheet). JSON columns `subAssemblies` and
// `heightsSubAssemblies` are parsed back to string[].
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type ProductDeptConfigRow = {
  productCode: string;
  unitM3: number;
  fabricUsage: number;
  price2Sen: number;
  fabCutCategory: string | null;
  fabCutMinutes: number | null;
  fabSewCategory: string | null;
  fabSewMinutes: number | null;
  woodCutCategory: string | null;
  woodCutMinutes: number | null;
  foamCategory: string | null;
  foamMinutes: number | null;
  framingCategory: string | null;
  framingMinutes: number | null;
  upholsteryCategory: string | null;
  upholsteryMinutes: number | null;
  packingCategory: string | null;
  packingMinutes: number | null;
  subAssemblies: string | null;
  heightsSubAssemblies: string | null;
};

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToConfig(row: ProductDeptConfigRow) {
  return {
    productCode: row.productCode,
    unitM3: row.unitM3,
    fabricUsage: row.fabricUsage,
    price2Sen: row.price2Sen,
    fabCutCategory: row.fabCutCategory,
    fabCutMinutes: row.fabCutMinutes,
    fabSewCategory: row.fabSewCategory,
    fabSewMinutes: row.fabSewMinutes,
    woodCutCategory: row.woodCutCategory,
    woodCutMinutes: row.woodCutMinutes,
    foamCategory: row.foamCategory,
    foamMinutes: row.foamMinutes,
    framingCategory: row.framingCategory,
    framingMinutes: row.framingMinutes,
    upholsteryCategory: row.upholsteryCategory,
    upholsteryMinutes: row.upholsteryMinutes,
    packingCategory: row.packingCategory,
    packingMinutes: row.packingMinutes,
    // NOTE: seeded data stores these as arrays of either strings or
    // {code,name,quantity} objects — passed through verbatim.
    subAssemblies: parseJson<unknown[]>(row.subAssemblies, []),
    heightsSubAssemblies: parseJson<unknown[]>(row.heightsSubAssemblies, []),
  };
}

// GET /api/product-configs — list all product dept configs
app.get("/", async (c) => {
  const res = await c.env.DB.prepare(
    "SELECT * FROM product_dept_configs ORDER BY productCode",
  ).all<ProductDeptConfigRow>();
  const data = (res.results ?? []).map(rowToConfig);
  return c.json({ success: true, data });
});

export default app;
