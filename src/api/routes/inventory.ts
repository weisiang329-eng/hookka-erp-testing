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
// GET /api/inventory/fg-source/:productCode
//
// Drill-down for the FG detail dialog: lists every production_order that
// contributed to the on-hand stock for this productCode. "Contributed"
// means EVERY UPHOLSTERY job_card on the PO is COMPLETED/TRANSFERRED —
// the same rule deriveFGStock() uses on the frontend so the dialog and
// the Stock Qty column always agree (BUG-2026-04-27: previously this
// endpoint pulled from fg_units which has placeholder rows for unfinished
// POs, returning 22 sources for a stock-of-1 product).
//
// The mfdDate in the response is the LATEST UPHOLSTERY completedDate
// across all UPH cards on that PO — that's literally the moment the PO
// became a finished good.
// ---------------------------------------------------------------------------
app.get("/fg-source/:productCode", async (c) => {
  const productCode = c.req.param("productCode");
  if (!productCode) {
    return c.json({ success: false, error: "productCode required" }, 400);
  }
  // First: every PO with this productCode + count of UPH JCs + count of
  // DONE UPH JCs + max DONE UPH completedDate. Then in JS we keep only
  // POs where uphTotal > 0 AND uphDone === uphTotal.
  const res = await c.var.DB
    .prepare(
      `SELECT po.id           AS poId,
              po.poNo         AS poNo,
              po.companySOId  AS soNo,
              po.customerName AS customerName,
              po.quantity     AS qty,
              SUM(CASE WHEN jc.departmentCode = 'UPHOLSTERY' THEN 1 ELSE 0 END) AS uphTotal,
              SUM(CASE WHEN jc.departmentCode = 'UPHOLSTERY'
                        AND jc.status IN ('COMPLETED','TRANSFERRED') THEN 1 ELSE 0 END) AS uphDone,
              MAX(CASE WHEN jc.departmentCode = 'UPHOLSTERY'
                        AND jc.status IN ('COMPLETED','TRANSFERRED')
                       THEN jc.completedDate END) AS uphCompletedDate
         FROM production_orders po
         JOIN job_cards jc ON jc.productionOrderId = po.id
        WHERE po.productCode = ?
        GROUP BY po.id, po.poNo, po.companySOId, po.customerName, po.quantity`,
    )
    .bind(productCode)
    .all<{
      poId: string;
      poNo: string | null;
      soNo: string | null;
      customerName: string | null;
      qty: number | null;
      uphTotal: number;
      uphDone: number;
      uphCompletedDate: string | null;
    }>();
  const sources = (res.results ?? [])
    .filter((r) => r.uphTotal > 0 && r.uphDone === r.uphTotal)
    .map((r) => ({
      poId: r.poId,
      poNo: r.poNo ?? "",
      soNo: r.soNo ?? "",
      customerName: r.customerName ?? "",
      qty: r.qty ?? 0,
      mfdDate: r.uphCompletedDate ?? "",
      // Kept for API shape parity with the previous fg_units-based
      // response. The new query collapses by PO, so per-status counts
      // aren't broken out — UPH-done POs are always "READY/IN_STOCK".
      statusCounts: { READY: r.qty ?? 0 },
    }))
    .sort((a, b) => (b.mfdDate || "").localeCompare(a.mfdDate || ""));
  const totalUnits = sources.reduce((s, r) => s + r.qty, 0);
  return c.json({
    success: true,
    productCode,
    totalUnits,
    sources,
  });
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

export default app;
