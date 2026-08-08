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
// `finishedProducts` are products with `stockQty` defaulted to 0 — the real
// on-hand quantity is derived client-side from fg_units state (see
// `deriveFGStock` in src/pages/inventory/index.tsx). `wipItems` come from
// the wip_items table and `rawMaterials` from raw_materials. The raw
// material POST endpoint validates uniqueness of itemCode the same way as
// the in-memory route.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { fetchFilteredPOs } from "./production-orders";
import { deriveFGStock, splitFgDeltas, type FgStockPO } from "../../lib/fg-stock";

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
  // Reorder thresholds — added 0008_raw_materials.sql; nullable for rows
  // that haven't been touched since the migration. Used by the reorder
  // banner on procurement/index (Phase 2.5).
  minStock: number | null;
  maxStock: number | null;
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
    // Reorder thresholds — null in DB → 0 on the wire to keep the
    // RawMaterial type's number contract.
    minStock: row.minStock ?? 0,
    maxStock: row.maxStock ?? 0,
  };
}

function genRmId(): string {
  return `rm-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/inventory — all three buckets
app.get("/", async (c) => {
  const [productsRes, wipRes, rmRes] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM products ORDER BY code").all<ProductRow>(),
    c.var.DB.prepare("SELECT * FROM wip_items ORDER BY id").all<WipItemRow>(),
    c.var.DB.prepare(
      "SELECT * FROM raw_materials ORDER BY itemCode",
    ).all<RawMaterialRow>(),
  ]);

  // stockQty is always 0 from the API — the real FG inventory is derived
  // client-side from fg_units by `deriveFGStock` in
  // src/pages/inventory/index.tsx. Keeping the field on the response
  // preserves the wire-shape that the frontend expects.
  const finishedProducts = (productsRes.results ?? []).map((p) => ({
    ...rowToProduct(p),
    stockQty: 0,
  }));
  const wipItems = (wipRes.results ?? []).map(rowToWipItem);
  const rawMaterials = (rmRes.results ?? []).map(rowToRawMaterial);

  return c.json({
    success: true,
    data: { finishedProducts, wipItems, rawMaterials },
  });
});

// ---------------------------------------------------------------------------
// GET /api/inventory/shortage-forecast (Phase 2.6)
//
// Forward-looking material shortage projection. Walks every CONFIRMED /
// IN_PRODUCTION sales_order, sums per-RM consumption from the BOM
// (bom_templates.wipComponents), subtracts current balanceQty, and adds
// expected-incoming PO quantities (status NOT IN RECEIVED/CLOSED/CANCELLED
// AND expectedDate <= today + 14 days). Returns the rows with
// shortBy > 0 sorted by largest shortfall.
//
// Different from the reorder banner (2.5):
//   • banner = "currently below minStock" — operational floor
//   • forecast = "will be short for committed SOs" — planning horizon
//
// BOM walk mirrors the MRP collectMaterials pattern (see mrp.ts) but is
// SO-driven instead of PO-driven, so the projection answers "what do I
// need to buy NOW so the SOs in the queue can actually ship". For SOFAs
// where 5-15m of fabric per piece is normal, this catches shortfalls
// days before the operator notices via minStock alone.
// ---------------------------------------------------------------------------
type BomMaterial = {
  code?: string;
  inventoryCode?: string;
  qty?: number;
};
type BomWipNode = {
  quantity?: number;
  materials?: BomMaterial[];
  children?: BomWipNode[];
};

function collectBomMaterials(
  node: BomWipNode,
  unitsToBuild: number,
  parentQty: number,
  out: Map<string, number>,
): void {
  const effective = (node.quantity || 1) * parentQty;
  for (const mat of node.materials || []) {
    const key = mat.inventoryCode || mat.code;
    if (!key) continue;
    const baseQty = mat.qty || 0;
    if (baseQty <= 0) continue;
    const total = baseQty * effective * unitsToBuild;
    out.set(key, (out.get(key) || 0) + total);
  }
  for (const child of node.children || []) {
    collectBomMaterials(child, unitsToBuild, effective, out);
  }
}

app.get("/shortage-forecast", async (c) => {
  const denied = await requirePermission(c, "inventory", "read");
  if (denied) return denied;

  const today = new Date().toISOString().slice(0, 10);
  const horizonDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().slice(0, 10);
  })();

  const [soiRes, bomRes, rmRes, poiRes] = await Promise.all([
    // Open SOs and their items. We pull per-line so the BOM walk can
    // attribute shortage back to the originating SO (companySO id).
    c.var.DB.prepare(
      `SELECT so.id            AS "soId",
              so.companySO     AS "companySO",
              so.companySOId   AS "companySOId",
              soi.productCode  AS "productCode",
              soi.quantity     AS "quantity"
         FROM sales_orders so
         JOIN sales_order_items soi ON soi.salesOrderId = so.id
        WHERE so.status IN ('CONFIRMED','IN_PRODUCTION')
          AND soi.productCode IS NOT NULL`,
    ).all<{
      soId: string;
      companySO: string | null;
      companySOId: string | null;
      productCode: string | null;
      quantity: number | null;
    }>(),
    c.var.DB.prepare(
      `SELECT productCode, wipComponents
         FROM bom_templates
        WHERE versionStatus = 'ACTIVE'`,
    ).all<{ productCode: string; wipComponents: string | null }>(),
    c.var.DB.prepare(
      "SELECT itemCode, description, itemGroup, balanceQty FROM raw_materials WHERE isActive = 1",
    ).all<{
      itemCode: string;
      description: string;
      itemGroup: string;
      balanceQty: number;
    }>(),
    // Expected incoming: open POs arriving within the forecast horizon.
    c.var.DB.prepare(
      `SELECT poi.materialName  AS "materialName",
              poi.supplierSKU   AS "supplierSKU",
              poi.quantity      AS "quantity",
              poi.receivedQty   AS "receivedQty"
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.purchaseOrderId
        WHERE po.status NOT IN ('RECEIVED','CLOSED','CANCELLED')
          AND po.expectedDate IS NOT NULL
          AND po.expectedDate != ''
          AND po.expectedDate <= ?`,
    )
      .bind(horizonDate)
      .all<{
        materialName: string | null;
        supplierSKU: string | null;
        quantity: number;
        receivedQty: number;
      }>(),
  ]);

  // Index BOM by productCode, parsing wipComponents JSON defensively
  // (matches the MRP path).
  const bomByProduct = new Map<string, BomWipNode[]>();
  for (const b of bomRes.results ?? []) {
    if (!b.productCode || !b.wipComponents) continue;
    try {
      const parsed = JSON.parse(b.wipComponents);
      if (Array.isArray(parsed)) {
        bomByProduct.set(b.productCode, parsed as BomWipNode[]);
      } else if (Array.isArray(parsed?.components)) {
        bomByProduct.set(b.productCode, parsed.components as BomWipNode[]);
      }
    } catch {
      // skip malformed BOM
    }
  }

  // Aggregate gross requirement per RM code, plus the originating SOs
  // for the criticalSOs list in the response.
  const requiredByRm = new Map<string, number>();
  const criticalByRm = new Map<string, Set<string>>();
  for (const line of soiRes.results ?? []) {
    if (!line.productCode || !line.quantity) continue;
    const bom = bomByProduct.get(line.productCode);
    if (!bom) continue;
    const localMap = new Map<string, number>();
    for (const wip of bom) collectBomMaterials(wip, line.quantity, 1, localMap);
    const soTag = line.companySO || line.companySOId || line.soId;
    for (const [rm, qty] of localMap) {
      requiredByRm.set(rm, (requiredByRm.get(rm) || 0) + qty);
      const set = criticalByRm.get(rm) || new Set<string>();
      set.add(soTag);
      criticalByRm.set(rm, set);
    }
  }

  // Incoming = sum of (quantity - receivedQty) across open PO lines.
  // Match by either supplierSKU OR the leading "<rmCode> -" prefix in
  // materialName so we catch both create-modal lines and historical
  // Excel-import lines.
  const incomingByRm = new Map<string, number>();
  for (const poi of poiRes.results ?? []) {
    const remain = Math.max(0, (poi.quantity || 0) - (poi.receivedQty || 0));
    if (remain <= 0) continue;
    // Try supplierSKU first (matches our binding-driven create flow).
    let rmCode = "";
    if (poi.supplierSKU) {
      rmCode = poi.supplierSKU;
    } else if (poi.materialName) {
      const dashIdx = poi.materialName.indexOf(" - ");
      rmCode = dashIdx > 0 ? poi.materialName.slice(0, dashIdx).trim() : poi.materialName.trim();
    }
    if (!rmCode) continue;
    incomingByRm.set(rmCode, (incomingByRm.get(rmCode) || 0) + remain);
  }

  const rmIndex = new Map<string, { description: string; itemGroup: string; balanceQty: number }>();
  for (const rm of rmRes.results ?? []) {
    rmIndex.set(rm.itemCode, {
      description: rm.description,
      itemGroup: rm.itemGroup,
      balanceQty: rm.balanceQty,
    });
  }

  // Build response rows. Only emit rows where shortBy > 0.
  const rows: Array<{
    itemCode: string;
    description: string;
    itemGroup: string;
    balanceQty: number;
    neededQty: number;
    incomingQty: number;
    shortBy: number;
    criticalSOs: string[];
  }> = [];
  for (const [rmCode, needed] of requiredByRm) {
    const meta = rmIndex.get(rmCode);
    if (!meta) continue;
    const incoming = incomingByRm.get(rmCode) || 0;
    const shortBy = needed - meta.balanceQty - incoming;
    if (shortBy <= 0) continue;
    rows.push({
      itemCode: rmCode,
      description: meta.description,
      itemGroup: meta.itemGroup,
      balanceQty: meta.balanceQty,
      neededQty: Number(needed.toFixed(3)),
      incomingQty: Number(incoming.toFixed(3)),
      shortBy: Number(shortBy.toFixed(3)),
      criticalSOs: Array.from(criticalByRm.get(rmCode) ?? []).slice(0, 20),
    });
  }
  rows.sort((a, b) => b.shortBy - a.shortBy);

  return c.json({
    success: true,
    asOf: today,
    horizonDate,
    data: rows,
  });
});

// POST /api/inventory/raw-materials — create a raw material row
app.post("/raw-materials", async (c) => {
  const denied = await requirePermission(c, "inventory", "create");
  if (denied) return denied;
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
    const exists = await c.var.DB.prepare(
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

    await c.var.DB.prepare(
      `INSERT INTO raw_materials (id, itemCode, description, baseUOM, itemGroup,
         isActive, balanceQty)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, itemCode, description, uom, itemGroup, isActive, balanceQty)
      .run();

    const created = await c.var.DB.prepare(
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

// ---------------------------------------------------------------------------
// GET /api/inventory/rm-source/:rmId
//
// Drill-down for the RM detail dialog: every rm_batches row for the given
// raw material, in FIFO order (received_date ASC) with the originating
// purchase order looked up via the GRN. Each row shows: PO No (purchasing),
// supplier, received date, original qty, remaining qty, unit cost.
// ---------------------------------------------------------------------------
app.get("/rm-source/:rmId", async (c) => {
  const rmId = c.req.param("rmId");
  if (!rmId) return c.json({ success: false, error: "rmId required" }, 400);
  const res = await c.var.DB
    .prepare(
      `SELECT b.id, b.receivedDate, b.originalQty, b.remainingQty,
              b.unitCostSen, b.notes, b.grnId, b.supplierId,
              g.grnNumber, g.poNumber, g.poId, g.supplierName
         FROM rm_batches b
         LEFT JOIN grns g ON g.id = b.grnId
        WHERE b.rmId = ?
        ORDER BY b.receivedDate ASC, b.id ASC`,
    )
    .bind(rmId)
    .all<{
      id: string;
      receivedDate: string | null;
      originalQty: number;
      remainingQty: number;
      unitCostSen: number;
      notes: string | null;
      grnId: string | null;
      supplierId: string | null;
      grnNumber: string | null;
      poNumber: string | null;
      poId: string | null;
      supplierName: string | null;
    }>();
  const batches = (res.results ?? []).map((b) => ({
    id: b.id,
    receivedDate: b.receivedDate ?? "",
    originalQty: b.originalQty,
    remainingQty: b.remainingQty,
    unitCostSen: b.unitCostSen,
    notes: b.notes ?? "",
    grnNumber: b.grnNumber ?? "",
    poNumber: b.poNumber ?? "", // purchase order number
    poId: b.poId ?? "",
    supplierName: b.supplierName ?? "",
  }));
  const totalRemaining = batches.reduce((s, b) => s + (b.remainingQty || 0), 0);
  return c.json({
    success: true,
    rmId,
    totalBatches: batches.length,
    totalRemaining,
    batches, // already FIFO-ordered
  });
});

// ---------------------------------------------------------------------------
// GET /api/inventory/fg-stock — server-side Finished-Goods stock derivation.
//
// Perf 2026-07-14: the Inventory page used to pull the whole ~1.2MB
// /api/production-orders?fields=minimal&include=jobCards (plus /api/delivery-orders
// and /api/consignment-notes) ONLY to derive its Finished-Goods stock/reserved
// counts client-side via deriveFGStock. This endpoint runs the SAME shared
// deriveFGStock (src/lib/fg-stock.ts, byte-identical by construction) server-side
// and returns DELTAS ONLY:
//   { counts: [{id, stockQty, reservedQty}], dyn: [{id, code, name, category,
//     sizeCode, sizeLabel, stockQty, reservedQty}] }
// The page keeps its /api/products fetch (full product assembly — costPriceSen,
// bomComponents, overlays) and merges these counts onto it by product id. So the
// heavy production-orders + DO/CN state pulls are dropped with ZERO product-shape
// risk, and the payload is only the ~34 items that actually have stock.
//   • counts = catalog products (merge by id onto /api/products)
//   • dyn    = finished POs whose product is NOT in the active catalog (the page
//              builds a shell row for them, mirroring deriveFGStock's fg-dyn-* path)
// Only non-zero rows are shipped (a product absent from counts → 0/0 on the page).
//
// BYTE-IDENTITY VERIFIED LIVE on staging (2026-07-14): endpoint counts == the
// page's client-computed deriveFGStock, 0 per-product diffs, tallies bf 160 /
// sofa 108 / stock 52 / reserved 22 identical. Snapshot-cached (serve-stale) so
// the page's cold paint never blocks on the ~8s whole-org compute
// (BUG-2026-07-13-001). Freshness tracks production_orders / job_cards /
// delivery_order_items / consignment_items.
// ---------------------------------------------------------------------------
app.get("/fg-stock", async (c) => {
  const denied = await requirePermission(c, "inventory", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const db = c.var.DB;

  // Runtime self-apply — migration files are inert on deploy, so the snapshot
  // table must be created (awaited) before withSnapshot reads/writes it. Exact
  // generic-withSnapshot schema (org_id + cache_key composite PK).
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS inventory_fg_stock_snapshot (
         org_id        TEXT NOT NULL,
         cache_key     TEXT NOT NULL DEFAULT '',
         data          JSONB NOT NULL,
         built_from    TIMESTAMP NOT NULL,
         built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
         refresh_count INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (org_id, cache_key)
       )`,
    )
    .run();

  // Runtime self-apply of the fg-stock hot-path indexes (also inert as a
  // migration file — see migrations/0209_inventory_perf_indexes.sql). They
  // remove the full scans on job_cards / piece_pics / products and the
  // per-request MAX(updated_at) freshness probe that push the cold whole-org
  // compute past the frontend's 30s abort → 504 (which then crashes the
  // Inventory page on any refetch). Built in the background so the one-time
  // index build never blocks this request; until built the endpoint keeps
  // using today's path. The executionCtx getter throws outside a Worker isolate
  // (tests / local node), so guard it and fall back to fire-and-forget.
  const { ensureInventoryPerfIndexes } = await import(
    "../lib/ensure-inventory-perf-indexes"
  );
  try {
    c.executionCtx.waitUntil(ensureInventoryPerfIndexes(db));
  } catch {
    void ensureInventoryPerfIndexes(db);
  }

  const { withSnapshot } = await import("../lib/snapshot");
  const data = await withSnapshot(
    db,
    {
      tableName: "inventory_fg_stock_snapshot",
      sourceTables: [
        "production_orders",
        "job_cards",
        "delivery_order_items",
        "delivery_orders",
        "consignment_items",
        "consignment_notes",
      ],
    },
    orgId,
    async () => {
      const [prodRes, pos, doStateRes, cnStateRes] = await Promise.all([
        db
          .prepare(
            "SELECT * FROM products WHERE orgId = ? AND status = 'ACTIVE' ORDER BY code",
          )
          .bind(orgId)
          .all(),
        fetchFilteredPOs(db, orgId, null, true, false, true),
        db
          .prepare(
            `SELECT doi.productionOrderId AS poId, d.status
               FROM delivery_order_items doi
               JOIN delivery_orders d ON d.id = doi.deliveryOrderId
              WHERE doi.orgId = ?
                AND doi.productionOrderId IS NOT NULL
                AND doi.productionOrderId <> ''`,
          )
          .bind(orgId)
          .all<{ poId: string; status: string }>(),
        db
          .prepare(
            `SELECT ci.productionOrderId AS poId, cn.status
               FROM consignment_items ci
               JOIN consignment_notes cn ON cn.id = ci.consignmentNoteId
              WHERE ci.orgId = ?
                AND ci.productionOrderId IS NOT NULL
                AND ci.productionOrderId <> ''`,
          )
          .bind(orgId)
          .all<{ poId: string; status: string }>(),
      ]);

      // poStatusByDO: PO id → coarse warehouse state, DISPATCHED wins over DRAFT,
      // merged across DO + CN sources — mirrors fetchDOStates + fetchCNStates in
      // src/pages/inventory/index.tsx. DO: DRAFT→DRAFT else DISPATCHED.
      // CN: ACTIVE→DRAFT else DISPATCHED.
      const poStatusByDO = new Map<string, "DRAFT" | "DISPATCHED">();
      const put = (poId: string, state: "DRAFT" | "DISPATCHED") => {
        if (!poId) return;
        if (poStatusByDO.get(poId) === "DISPATCHED") return;
        poStatusByDO.set(poId, state);
      };
      for (const r of doStateRes.results ?? []) {
        put(r.poId, r.status === "DRAFT" ? "DRAFT" : "DISPATCHED");
      }
      for (const r of cnStateRes.results ?? []) {
        put(r.poId, r.status === "ACTIVE" ? "DRAFT" : "DISPATCHED");
      }

      const fgItems = deriveFGStock(
        (prodRes.results ?? []) as unknown as Parameters<typeof deriveFGStock>[0],
        pos as unknown as FgStockPO[],
        poStatusByDO,
      );

      // Deltas only: ship the ~few dozen rows that carry stock, split into
      // catalog products (merge by id on the FE) vs off-catalog dynamics.
      return splitFgDeltas(fgItems);
    },
    "",
    c,
    { staleWhileRevalidate: true },
  );

  return c.json({ success: true, data });
});

export default app;
