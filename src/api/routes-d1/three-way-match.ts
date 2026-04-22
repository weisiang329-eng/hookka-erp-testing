// ---------------------------------------------------------------------------
// D1-backed three-way-match route.
//
// Mirrors the old src/api/routes/three-way-match.ts shape. IMPORTANT quirks
// that must be preserved:
//
//   - GET / returns the RAW array (no { success, data } wrapper). The SPA
//     reads this endpoint as a plain array. Do NOT wrap it.
//   - POST / returns the created match object directly on 201 (no wrapper)
//     and raw `{ error }` on errors (no `success: false`).
//   - The `items` column is JSON TEXT — stringify on write / parse on read.
//
// Match math: PO ↔ GRN ↔ (optional) invoice. 2% variance tolerance.
// Status transitions: FULL_MATCH | PARTIAL_MATCH | MISMATCH | PENDING_INVOICE.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type ThreeWayMatchRow = {
  id: string;
  poId: string | null;
  poNumber: string | null;
  grnId: string | null;
  grnNumber: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  supplierId: string | null;
  supplierName: string | null;
  matchStatus: string | null;
  poTotal: number;
  grnTotal: number;
  invoiceTotal: number | null;
  variance: number;
  variancePercent: number;
  withinTolerance: number;
  items: string | null;
};

type MatchItem = {
  materialCode: string;
  poQty: number;
  grnQty: number;
  invoiceQty: number | null;
  poPrice: number;
  grnPrice: number;
  invoicePrice: number | null;
  matched: boolean;
};

type GrnItemRow = {
  id: number;
  grnId: string;
  poItemIndex: number | null;
  materialCode: string | null;
  materialName: string | null;
  orderedQty: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  rejectionReason: string | null;
  unitPrice: number;
};

type PoItemRow = {
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

function parseItems(raw: string | null): MatchItem[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as MatchItem[];
  } catch {
    return [];
  }
}

function rowToMatch(row: ThreeWayMatchRow) {
  return {
    id: row.id,
    poId: row.poId ?? "",
    poNumber: row.poNumber ?? "",
    grnId: row.grnId ?? "",
    grnNumber: row.grnNumber ?? "",
    invoiceId: row.invoiceId,
    invoiceNumber: row.invoiceNumber,
    supplierId: row.supplierId ?? "",
    supplierName: row.supplierName ?? "",
    matchStatus: row.matchStatus ?? "PENDING_INVOICE",
    poTotal: row.poTotal,
    grnTotal: row.grnTotal,
    invoiceTotal: row.invoiceTotal,
    variance: row.variance,
    variancePercent: row.variancePercent,
    withinTolerance: row.withinTolerance === 1,
    items: parseItems(row.items),
  };
}

function genId(): string {
  return `twm-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/three-way-match — returns RAW array (no wrapper!)
app.get("/", async (c) => {
  const res = await c.env.DB.prepare(
    "SELECT * FROM three_way_matches",
  ).all<ThreeWayMatchRow>();
  const data = (res.results ?? []).map(rowToMatch);
  return c.json(data);
});

// POST /api/three-way-match — compute + persist a new match
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { grnId, invoiceId, invoiceNumber, invoiceTotal, invoiceItems } =
      body;

    if (!grnId) return c.json({ error: "grnId is required" }, 400);

    const grn = await c.env.DB.prepare(
      "SELECT id, grnNumber, poId, supplierId, supplierName, totalAmount FROM grns WHERE id = ?",
    )
      .bind(grnId)
      .first<{
        id: string;
        grnNumber: string;
        poId: string | null;
        supplierId: string | null;
        supplierName: string | null;
        totalAmount: number;
      }>();
    if (!grn) return c.json({ error: "GRN not found" }, 404);

    if (!grn.poId) {
      return c.json({ error: "Related PO not found" }, 404);
    }
    const po = await c.env.DB.prepare(
      "SELECT id, poNo, totalSen FROM purchase_orders WHERE id = ?",
    )
      .bind(grn.poId)
      .first<{ id: string; poNo: string; totalSen: number }>();
    if (!po) return c.json({ error: "Related PO not found" }, 404);

    const [grnItemsRes, poItemsRes] = await Promise.all([
      c.env.DB.prepare(
        "SELECT * FROM grn_items WHERE grnId = ? ORDER BY id",
      )
        .bind(grn.id)
        .all<GrnItemRow>(),
      c.env.DB.prepare(
        "SELECT * FROM purchase_order_items WHERE purchaseOrderId = ? ORDER BY id",
      )
        .bind(po.id)
        .all<PoItemRow>(),
    ]);
    const grnItems = grnItemsRes.results ?? [];
    const poItems = poItemsRes.results ?? [];

    const TOLERANCE = 0.02;

    const matchItems: MatchItem[] = grnItems.map((gi) => {
      const poItem =
        gi.poItemIndex !== null && gi.poItemIndex !== undefined
          ? poItems[gi.poItemIndex]
          : undefined;
      const invItem = (
        invoiceItems as
          | { materialCode: string; quantity: number; unitPrice: number }[]
          | undefined
      )?.find((ii) => ii.materialCode === gi.materialCode);

      const poQty = poItem?.quantity ?? 0;
      const grnQty = gi.acceptedQty;
      const invoiceQty = invItem?.quantity ?? null;
      const poPrice = poItem?.unitPriceSen ?? 0;
      const grnPrice = gi.unitPrice;
      const invPrice = invItem?.unitPrice ?? null;

      const qtyMatch =
        invoiceQty !== null
          ? poQty === grnQty && grnQty === invoiceQty
          : poQty === grnQty;
      const priceMatch =
        invoiceQty !== null
          ? poPrice === grnPrice && grnPrice === (invPrice ?? 0)
          : poPrice === grnPrice;

      return {
        materialCode: gi.materialCode ?? "",
        poQty,
        grnQty,
        invoiceQty,
        poPrice,
        grnPrice,
        invoicePrice: invPrice,
        matched: qtyMatch && priceMatch,
      };
    });

    const poTotal = po.totalSen;
    const grnTotal = grn.totalAmount;
    const invTotal = (invoiceTotal as number | null | undefined) ?? null;

    let variance: number;
    if (invTotal !== null) {
      const poGrnDiff = Math.abs(poTotal - grnTotal);
      const poInvDiff = Math.abs(poTotal - invTotal);
      const grnInvDiff = Math.abs(grnTotal - invTotal);
      variance = Math.max(poGrnDiff, poInvDiff, grnInvDiff);
    } else {
      variance = Math.abs(poTotal - grnTotal);
    }

    const variancePercent = poTotal > 0 ? (variance / poTotal) * 100 : 0;
    const withinTolerance = variancePercent <= TOLERANCE * 100;

    const allMatched = matchItems.every((i) => i.matched);
    let matchStatus:
      | "FULL_MATCH"
      | "PARTIAL_MATCH"
      | "MISMATCH"
      | "PENDING_INVOICE";
    if (!invoiceId) {
      matchStatus = "PENDING_INVOICE";
    } else if (allMatched && withinTolerance) {
      matchStatus = "FULL_MATCH";
    } else if (variancePercent <= 10) {
      matchStatus = "PARTIAL_MATCH";
    } else {
      matchStatus = "MISMATCH";
    }

    const id = genId();
    const variancePercentRounded = Math.round(variancePercent * 100) / 100;

    await c.env.DB.prepare(
      `INSERT INTO three_way_matches (id, poId, poNumber, grnId, grnNumber,
         invoiceId, invoiceNumber, supplierId, supplierName, matchStatus,
         poTotal, grnTotal, invoiceTotal, variance, variancePercent,
         withinTolerance, items)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        po.id,
        po.poNo,
        grn.id,
        grn.grnNumber,
        invoiceId ?? null,
        invoiceNumber ?? null,
        grn.supplierId,
        grn.supplierName,
        matchStatus,
        poTotal,
        grnTotal,
        invTotal,
        variance,
        variancePercentRounded,
        withinTolerance ? 1 : 0,
        JSON.stringify(matchItems),
      )
      .run();

    const newMatch = {
      id,
      poId: po.id,
      poNumber: po.poNo,
      grnId: grn.id,
      grnNumber: grn.grnNumber,
      invoiceId: invoiceId ?? null,
      invoiceNumber: invoiceNumber ?? null,
      supplierId: grn.supplierId ?? "",
      supplierName: grn.supplierName ?? "",
      matchStatus,
      poTotal,
      grnTotal,
      invoiceTotal: invTotal,
      variance,
      variancePercent: variancePercentRounded,
      withinTolerance,
      items: matchItems,
    };
    return c.json(newMatch, 201);
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
});

export default app;
