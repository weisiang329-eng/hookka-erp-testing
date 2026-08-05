// ---------------------------------------------------------------------------
// D1-backed products route.
//
// Mirrors the old src/api/routes/products.ts shape so the SPA frontend
// doesn't need any changes. `bomComponents` and `deptWorkingTimes` are
// returned as nested arrays joined from their child tables. JSON columns
// (`subAssemblies`, `pieces`, `seatHeightPrices`) are parsed back to objects.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { checkProductDeleteLocked, lockedResponse } from "../lib/lock-helpers";
import { requirePermission, hasPermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

// created_at lets the Operations Report list "products created this month". The
// products table shipped without it; historical rows stay NULL (creation date
// is unrecoverable) and only surface from the first stamp forward. Runtime-
// ensured — migration files are inert on deploy (see CLAUDE.md). Idempotent.
let productCreatedAtColEnsured = false;
async function ensureProductCreatedAtColumn(db: D1Database): Promise<void> {
  if (productCreatedAtColEnsured) return;
  try {
    await db
      .prepare("ALTER TABLE products ADD COLUMN IF NOT EXISTS created_at TEXT")
      .run();
    productCreatedAtColEnsured = true;
  } catch (err) {
    // Best-effort — read side dual-keys and tolerates a missing/null column.
    console.warn(
      "[products] ensureProductCreatedAtColumn:",
      err instanceof Error ? err.message : err,
    );
  }
}

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
  defaultVariants: string | null;
};

// Per-SKU default variant pre-fills consumed by /sales/create. Each shape
// is JSON-encoded and stored as TEXT in products.default_variants. Empty
// fields just stay undefined / empty array — the SO line falls back to
// "no pre-fill" for them.
type DefaultVariants = {
  fabricCode?: string;
  // Bedframe-only fields
  divanHeight?: string;
  legHeight?: string;
  gap?: string;
  // Sofa-only fields
  seatHeight?: string;
  // Shared multi-select
  specials?: string[];
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
// productCode. The walker matches src/pages/bom.tsx exactly: each node's
// quantity is "per finished good" (NOT per parent), so multipliers do NOT
// compound from root to leaf. A "Foam x2" inside a "Divan x2" means 2 foams
// per FG, not 4.
type WipNode = {
  quantity?: number;
  processes?: { minutes?: number }[];
  children?: WipNode[];
};
type L1Process = { minutes?: number };

function sumWipTreeMinutes(wips: WipNode[]): number {
  let total = 0;
  for (const w of wips) {
    const own = (w.processes ?? []).reduce(
      (s, p) => s + (p.minutes ?? 0),
      0,
    );
    total += own * (w.quantity ?? 1);
    if (w.children?.length) total += sumWipTreeMinutes(w.children);
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

// Per-product overlay computed from product_prices. When an active history
// row exists for a product, its non-NULL price columns win over the
// products table columns. `pendingEffectiveFrom` is set when at least one
// future-dated row is queued.
type ProductPriceOverlay = {
  basePriceSen: number | null;
  price1Sen: number | null;
  seatHeightPricesRaw: string | null;
  hasPendingPriceChange: boolean;
  pendingEffectiveFrom: string | null;
};

function rowToProduct(
  row: ProductRow,
  boms: BomComponentRow[] = [],
  dwts: DeptWorkingTimeRow[] = [],
  bomMinutesByCode?: Map<string, number>,
  priceOverlay?: ProductPriceOverlay,
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

  // Coalesce price columns through the overlay so products list/get always
  // surface the currently-effective master price (history row wins over the
  // raw products table value when present). Pending flag rides along so the
  // UI can show a countdown badge without a second round-trip.
  const baseRaw =
    priceOverlay && priceOverlay.basePriceSen !== null
      ? priceOverlay.basePriceSen
      : row.basePriceSen;
  const p1Raw =
    priceOverlay && priceOverlay.price1Sen !== null
      ? priceOverlay.price1Sen
      : row.price1Sen;
  const seatRaw =
    priceOverlay && priceOverlay.seatHeightPricesRaw !== null
      ? priceOverlay.seatHeightPricesRaw
      : row.seatHeightPrices;

  if (baseRaw !== null) base.basePriceSen = baseRaw;
  if (p1Raw !== null) base.price1Sen = p1Raw;
  if (row.skuCode !== null) base.skuCode = row.skuCode;
  if (row.fabricColor !== null) base.fabricColor = row.fabricColor;
  if (row.pieces !== null) {
    base.pieces = parseJson<{ count: number; names: string[] } | null>(
      row.pieces,
      null,
    );
  }
  if (seatRaw !== null) {
    base.seatHeightPrices = parseJson<{ height: string; priceSen: number }[]>(
      seatRaw,
      [],
    );
  }
  // Per-SKU default variants (BF: divanHeight/legHeight/gap/specials/fabric;
  // SOFA: seatHeight/legHeight/specials/fabric). Empty object when nothing
  // configured — the SO line just falls back to no pre-fill.
  base.defaultVariants = parseJson<DefaultVariants>(row.defaultVariants, {});
  if (priceOverlay) {
    base.hasPendingPriceChange = priceOverlay.hasPendingPriceChange;
    if (priceOverlay.pendingEffectiveFrom) {
      base.pendingEffectiveFrom = priceOverlay.pendingEffectiveFrom;
    }
  }

  return base;
}

// Batch-load product_prices and return a Map keyed by productId. Single
// query, in-memory bucketing — keeps the products list endpoint to one
// extra round-trip even with hundreds of SKUs. `today` controls the
// active-vs-pending split.
async function loadPriceOverlays(
  db: D1Database,
  today: string,
): Promise<Map<string, ProductPriceOverlay>> {
  const res = await db
    .prepare(
      `SELECT productId, basePriceSen, price1Sen, seatHeightPrices,
              effectiveFrom, created_at
         FROM product_prices
        ORDER BY productId, effectiveFrom DESC, created_at DESC`,
    )
    .all<{
      productId: string;
      basePriceSen: number | null;
      price1Sen: number | null;
      seatHeightPrices: string | null;
      effectiveFrom: string;
    }>();

  const overlays = new Map<string, ProductPriceOverlay>();
  // Tracks which productIds have already had their active row picked, so
  // we don't overwrite with an older active row. NULL price columns are
  // valid (= inherit), so we can't use "all null" as the sentinel.
  const activePicked = new Set<string>();
  for (const r of res.results ?? []) {
    let overlay = overlays.get(r.productId);
    if (!overlay) {
      overlay = {
        basePriceSen: null,
        price1Sen: null,
        seatHeightPricesRaw: null,
        hasPendingPriceChange: false,
        pendingEffectiveFrom: null,
      };
      overlays.set(r.productId, overlay);
    }
    if (r.effectiveFrom > today) {
      // Rows arrive DESC, so we may see later pending dates first. Keep
      // the earliest pending date (the next change the customer will
      // experience).
      if (
        !overlay.pendingEffectiveFrom ||
        r.effectiveFrom < overlay.pendingEffectiveFrom
      ) {
        overlay.pendingEffectiveFrom = r.effectiveFrom;
      }
      overlay.hasPendingPriceChange = true;
    } else if (!activePicked.has(r.productId)) {
      // First active row encountered (DESC order) is the most recent one
      // that's currently in effect.
      overlay.basePriceSen = r.basePriceSen;
      overlay.price1Sen = r.price1Sen;
      overlay.seatHeightPricesRaw = r.seatHeightPrices;
      activePicked.add(r.productId);
    }
  }
  return overlays;
}

function genProductId(): string {
  return `prod-${crypto.randomUUID().slice(0, 8)}`;
}

function genBomId(): string {
  return `bom-${crypto.randomUUID().slice(0, 8)}`;
}

async function fetchProductWithChildren(db: D1Database, id: string) {
  const today = new Date().toISOString().slice(0, 10);
  const [product, bomsRes, dwtsRes, priceOverlays] = await Promise.all([
    db.prepare("SELECT * FROM products WHERE id = ?").bind(id).first<ProductRow>(),
    db
      .prepare("SELECT * FROM bom_components WHERE productId = ?")
      .bind(id)
      .all<BomComponentRow>(),
    db
      .prepare("SELECT * FROM dept_working_times WHERE productId = ?")
      .bind(id)
      .all<DeptWorkingTimeRow>(),
    // Overlay query is scoped to one product but reuses the batch helper —
    // the WHERE clause keeps the row count tiny.
    db
      .prepare(
        `SELECT productId, basePriceSen, price1Sen, seatHeightPrices,
                effectiveFrom, created_at
           FROM product_prices
          WHERE productId = ?
          ORDER BY effectiveFrom DESC, created_at DESC`,
      )
      .bind(id)
      .all<{
        productId: string;
        basePriceSen: number | null;
        price1Sen: number | null;
        seatHeightPrices: string | null;
        effectiveFrom: string;
      }>(),
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
  // Build the single-product overlay manually from the result set —
  // mirrors loadPriceOverlays(), just one product so we open-code it.
  let overlay: ProductPriceOverlay | undefined;
  let activePicked = false;
  for (const r of priceOverlays.results ?? []) {
    if (!overlay) {
      overlay = {
        basePriceSen: null,
        price1Sen: null,
        seatHeightPricesRaw: null,
        hasPendingPriceChange: false,
        pendingEffectiveFrom: null,
      };
    }
    if (r.effectiveFrom > today) {
      if (
        !overlay.pendingEffectiveFrom ||
        r.effectiveFrom < overlay.pendingEffectiveFrom
      ) {
        overlay.pendingEffectiveFrom = r.effectiveFrom;
      }
      overlay.hasPendingPriceChange = true;
    } else if (!activePicked) {
      overlay.basePriceSen = r.basePriceSen;
      overlay.price1Sen = r.price1Sen;
      overlay.seatHeightPricesRaw = r.seatHeightPrices;
      activePicked = true;
    }
  }

  return rowToProduct(
    product,
    bomsRes.results ?? [],
    dwtsRes.results ?? [],
    bomMinutesByCode,
    overlay,
  );
}

// GET /api/products — list ACTIVE products with nested BOM + dept times.
// Production-time column is computed live from bom_templates so the SPA
// list doesn't drift away from the source of truth when somebody edits
// the BOM tree (qty changes, process additions). Falls back to the stored
// snapshot for SKUs that have no ACTIVE template yet.
/**
 * Remove what a product SELLS for, keeping what it costs.
 *
 * Owner 2026-08-05: "我们的 products 的这些卖价、价钱这一些东西，全部不需要给
 * [R&D] 知道。我们卖价不需要给他们知道，我们只需要给他们看到成本就可以."
 *
 * Done on the SERVER, not by hiding a column: the figures were on the wire
 * either way, and the SKU export, the Ctrl+K palette and every other reader of
 * this payload would have needed the same treatment separately.
 *
 * Cost, labour minutes, BOM and margin INPUTS other than price are untouched —
 * withholding those would take away the half R&D is meant to have. The margin
 * column derives from the price, so it disappears with it rather than being
 * blanked separately.
 */
const SELLING_PRICE_FIELDS = [
  "basePriceSen",      // PRICE 2
  "price1Sen",         // PRICE 1
  "seatHeightPrices",  // per-height surcharges
  "seatHeightPricesRaw",
];

async function stripSellingPrice<T>(c: Context<Env>, rows: T[]): Promise<T[]> {
  if (await hasPermission(c, "product-pricing", "read")) return rows;
  return rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    const out = { ...(row as Record<string, unknown>) };
    for (const f of SELLING_PRICE_FIELDS) delete out[f];
    return out as T;
  });
}

app.get("/", async (c) => {
  const orgId = getOrgId(c);
  // Global Ctrl+K palette: lightweight, index-backed search returning ONLY
  // matching products (id/code/name); skips the heavy BOM / working-time
  // joins below so the palette stays fast. Fires only when ?search= present —
  // the Products list page (no search param) is unchanged.
  const q = (c.req.query("search") || c.req.query("q") || "").trim();
  if (q) {
    const matches = await c.var.DB.prepare(
      "SELECT id, code, name FROM products WHERE orgId = ? AND status = 'ACTIVE' AND (name ILIKE ? OR COALESCE(code,'') ILIKE ?) ORDER BY code LIMIT 20",
    )
      .bind(orgId, `%${q}%`, `%${q}%`)
      .all<{ id: string; code: string; name: string }>();
    return c.json({ success: true, data: matches.results ?? [] });
  }
  const today = new Date().toISOString().slice(0, 10);
  const [products, boms, dwts, tpls, priceOverlays] = await Promise.all([
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
    loadPriceOverlays(c.var.DB, today),
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
    rowToProduct(
      p,
      boms.results ?? [],
      dwts.results ?? [],
      bomMinutesByCode,
      priceOverlays.get(p.id),
    ),
  );
  return c.json({ success: true, data: await stripSellingPrice(c, data) });
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
    // Bedframe packing pieces are derived from sizeCode (K/Q → Headboard + 2
    // Divan; S/SS → Headboard + 1 Divan). A blank sizeCode silently falls back
    // to a single Headboard piece — the 1052 "packing sticker missing Divan"
    // bug (BUG-2026-06-22-008). Require it so it can't happen again (owner:
    // 必须填写). Validated identically on the frontend save handler.
    if (
      String(category).toUpperCase() === "BEDFRAME" &&
      !String(body.sizeCode ?? "").trim()
    ) {
      return c.json(
        {
          success: false,
          error:
            "Size code (e.g. K / Q / S / SS) is required for bedframe products — it drives the Headboard + Divan piece count.",
        },
        400,
      );
    }

    await ensureProductCreatedAtColumn(c.var.DB);

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
           skuCode, fabricColor, pieces, seatHeightPrices, defaultVariants,
           created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        body.defaultVariants ? JSON.stringify(body.defaultVariants) : null,
        new Date().toISOString(),
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
  return c.json({ success: true, data: (await stripSellingPrice(c, [product]))[0] });
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
      defaultVariants:
        body.defaultVariants === undefined
          ? existing.defaultVariants
          : body.defaultVariants
            ? JSON.stringify(body.defaultVariants)
            : null,
    };

    // Bedframe pieces are derived from sizeCode — never let an edit blank it
    // out (the 1052 "missing Divan" class, BUG-2026-06-22-008). Same rule as
    // the POST + the frontend save handler.
    if (
      String(merged.category).toUpperCase() === "BEDFRAME" &&
      !String(merged.sizeCode ?? "").trim()
    ) {
      return c.json(
        {
          success: false,
          error:
            "Size code (e.g. K / Q / S / SS) is required for bedframe products — it drives the Headboard + Divan piece count.",
        },
        400,
      );
    }

    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `UPDATE products SET
           code = ?, name = ?, category = ?, description = ?, baseModel = ?,
           sizeCode = ?, sizeLabel = ?, fabricUsage = ?, unitM3 = ?, status = ?,
           costPriceSen = ?, basePriceSen = ?, price1Sen = ?,
           productionTimeMinutes = ?, subAssemblies = ?, skuCode = ?,
           fabricColor = ?, pieces = ?, seatHeightPrices = ?, defaultVariants = ?
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
        merged.defaultVariants,
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

// ---------------------------------------------------------------------------
// Master price history (product_prices, migration 0066).
//
// Mirrors customer_product_prices: append-only, NULL columns inherit from
// the products table itself, and the resolver picks the newest row where
// effectiveFrom <= asOf. Future-dated rows sit dormant until their date
// passes — this is what lets the company schedule a 2026-06-01 price hike
// in advance.
// ---------------------------------------------------------------------------
type SeatHeightPrice = { height: string; priceSen: number };

type ProductPriceRow = {
  id: string;
  productId: string;
  basePriceSen: number | null;
  price1Sen: number | null;
  seatHeightPrices: string | null;
  effectiveFrom: string;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
};

function genPriceRowId(): string {
  return `pp-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

// Resolve the master price for a product as of a given ISO date. Returns
// concrete numbers (never null on the price fields), with the products row
// columns acting as the final fallback when no product_prices row applies.
async function resolveProductPriceAsOf(
  db: D1Database,
  productId: string,
  isoDate: string,
): Promise<{
  basePriceSen: number | null;
  price1Sen: number | null;
  seatHeightPrices: SeatHeightPrice[];
  hasPendingPriceChange: boolean;
  pendingEffectiveFrom: string | null;
} | null> {
  const prod = await db
    .prepare(
      `SELECT basePriceSen, price1Sen, seatHeightPrices FROM products WHERE id = ?`,
    )
    .bind(productId)
    .first<{
      basePriceSen: number | null;
      price1Sen: number | null;
      seatHeightPrices: string | null;
    }>();
  if (!prod) return null;

  const hist = await db
    .prepare(
      `SELECT basePriceSen, price1Sen, seatHeightPrices
         FROM product_prices
        WHERE productId = ?
          AND effectiveFrom <= ?
        ORDER BY effectiveFrom DESC, created_at DESC
        LIMIT 1`,
    )
    .bind(productId, isoDate)
    .first<{
      basePriceSen: number | null;
      price1Sen: number | null;
      seatHeightPrices: string | null;
    }>();

  const pending = await db
    .prepare(
      `SELECT effectiveFrom FROM product_prices
        WHERE productId = ? AND effectiveFrom > ?
        ORDER BY effectiveFrom ASC
        LIMIT 1`,
    )
    .bind(productId, isoDate)
    .first<{ effectiveFrom: string }>();

  const baseRaw = hist?.basePriceSen ?? prod.basePriceSen;
  const p1Raw = hist?.price1Sen ?? prod.price1Sen;
  const seatRaw = hist?.seatHeightPrices ?? prod.seatHeightPrices;

  return {
    basePriceSen: baseRaw,
    price1Sen: p1Raw,
    seatHeightPrices: parseJson<SeatHeightPrice[]>(seatRaw, []),
    hasPendingPriceChange: !!pending,
    pendingEffectiveFrom: pending?.effectiveFrom ?? null,
  };
}

// GET /api/products/:productId/price-history — full history (past + pending)
app.get("/:productId/price-history", async (c) => {
  // A history OF the selling price. Nothing to strip — the whole endpoint is
  // the thing being withheld.
  const deniedPricing = await requirePermission(c, "product-pricing", "read");
  if (deniedPricing) return deniedPricing;
  const productId = c.req.param("productId");
  const res = await c.var.DB.prepare(
    `SELECT * FROM product_prices
      WHERE productId = ?
      ORDER BY effectiveFrom DESC, created_at DESC`,
  )
    .bind(productId)
    .all<ProductPriceRow>();
  const data = (res.results ?? []).map((r) => ({
    id: r.id,
    basePriceSen: r.basePriceSen,
    price1Sen: r.price1Sen,
    seatHeightPrices: parseJson<SeatHeightPrice[]>(r.seatHeightPrices, []),
    effectiveFrom: r.effectiveFrom,
    notes: r.notes ?? "",
    createdAt: r.createdAt,
  }));
  return c.json({ success: true, data });
});

// POST /api/products/:productId/prices — append a new effective-dated row.
app.post("/:productId/prices", async (c) => {
  const denied = await requirePermission(c, "products", "update");
  if (denied) return denied;
  const productId = c.req.param("productId");
  try {
    const parent = await c.var.DB.prepare("SELECT id FROM products WHERE id = ?")
      .bind(productId)
      .first<{ id: string }>();
    if (!parent) {
      return c.json({ success: false, error: "Product not found" }, 404);
    }

    const body = await c.req.json();
    const effectiveFrom = String(body.effectiveFrom ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      return c.json(
        {
          success: false,
          error: "effectiveFrom (YYYY-MM-DD) is required",
        },
        400,
      );
    }

    // Auto-baseline: when scheduling the FIRST product_prices row for a SKU
    // and the new effective_from is in the future, capture the SKU's
    // current live price (from products) as a row dated today. Otherwise
    // when the future date kicks in there's no record of "what the price
    // used to be" — Wei Siang flagged this as a recurring "what was the
    // old price?" gap.
    //
    // Skip the auto-baseline when:
    //   - product_prices already has any row for this productId
    //     (the most recent existing row already plays the baseline role)
    //   - the new row is back-dated or effective today
    //     (the new row itself is the source of truth from today onward)
    const today = new Date().toISOString().slice(0, 10);
    if (effectiveFrom > today) {
      const existingHistory = await c.var.DB.prepare(
        "SELECT id FROM product_prices WHERE productId = ? LIMIT 1",
      )
        .bind(productId)
        .first<{ id: string }>();
      if (!existingHistory) {
        const masterRow = await c.var.DB.prepare(
          "SELECT basePriceSen, price1Sen, seatHeightPrices FROM products WHERE id = ?",
        )
          .bind(productId)
          .first<{
            basePriceSen: number | null;
            price1Sen: number | null;
            seatHeightPrices: string | null;
          }>();
        if (masterRow) {
          await c.var.DB.prepare(
            `INSERT INTO product_prices
               (id, productId, basePriceSen, price1Sen, seatHeightPrices,
                effectiveFrom, notes, createdBy)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
            .bind(
              genPriceRowId(),
              productId,
              masterRow.basePriceSen,
              masterRow.price1Sen,
              masterRow.seatHeightPrices,
              today,
              "Auto-baseline (captured before scheduled change)",
              body.createdBy ?? null,
            )
            .run();
        }
      }
    }

    const id = genPriceRowId();
    const seatJson =
      body.seatHeightPrices === undefined || body.seatHeightPrices === null
        ? null
        : JSON.stringify(body.seatHeightPrices);

    await c.var.DB.prepare(
      `INSERT INTO product_prices
         (id, productId, basePriceSen, price1Sen, seatHeightPrices,
          effectiveFrom, notes, createdBy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        productId,
        body.basePriceSen ?? null,
        body.price1Sen ?? null,
        seatJson,
        effectiveFrom,
        body.notes ?? null,
        body.createdBy ?? null,
      )
      .run();

    const row = await c.var.DB.prepare(
      "SELECT * FROM product_prices WHERE id = ?",
    )
      .bind(id)
      .first<ProductPriceRow>();
    if (!row) {
      return c.json(
        { success: false, error: "Failed to create price history row" },
        500,
      );
    }
    return c.json(
      {
        success: true,
        data: {
          id: row.id,
          productId: row.productId,
          basePriceSen: row.basePriceSen,
          price1Sen: row.price1Sen,
          seatHeightPrices: parseJson<SeatHeightPrice[]>(
            row.seatHeightPrices,
            [],
          ),
          effectiveFrom: row.effectiveFrom,
          notes: row.notes ?? "",
          createdAt: row.createdAt,
        },
      },
      201,
    );
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/products/price-row/:priceRowId — remove a history entry
// (typically used to cancel a not-yet-effective scheduled change).
app.delete("/price-row/:priceRowId", async (c) => {
  const denied = await requirePermission(c, "products", "update");
  if (denied) return denied;
  const id = c.req.param("priceRowId");
  const existing = await c.var.DB.prepare(
    "SELECT id, productId FROM product_prices WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; productId: string }>();
  if (!existing) {
    return c.json({ success: false, error: "Price row not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM product_prices WHERE id = ?")
    .bind(id)
    .run();
  return c.json({
    success: true,
    data: { id: existing.id, productId: existing.productId },
  });
});

export default app;
export { resolveProductPriceAsOf };
