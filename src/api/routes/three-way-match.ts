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
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { PO_ITEMS_ORDER, ensurePoItemLineNo } from "./purchase-orders";
import {
  buildPoLineIndex,
  resolveGrnPoLine,
  isResolvedGrnPoLine,
  type GrnPoLineOutcome,
} from "../lib/grn-po-line-link";

const app = new Hono<Env>();

// ── Runtime self-apply ──────────────────────────────────────────────────────
// Migrations do NOT run on deploy in this repo, so a new column reaches prod
// only from here. snake_case, so no column-rename-map.json entry is needed.
//
// `po_ids` — a receipt may span several purchase orders, so a match row that
// names only one reads as if the other were never involved. `poId` is kept as
// the header for every existing reader.
// Cached as a BOOLEAN, never as the in-flight promise: a rejected promise stays
// cached and one transient DDL blip would disable the column for the life of
// the isolate, while a pending one shares the socket of the request that
// created it (db-pg.ts forbids that). The statement is IF NOT EXISTS, so a
// re-run costs nothing and a failure simply leaves the flag unset to retry.
let _twmColumnsApplied = false;

async function ensureTwmMigrations(db: D1Database): Promise<void> {
  if (_twmColumnsApplied) return;
  await db
    .prepare("ALTER TABLE three_way_matches ADD COLUMN IF NOT EXISTS po_ids TEXT")
    .run();
  _twmColumnsApplied = true;
}

type ThreeWayMatchRow = {
  id: string;
  poId: string | null;
  po_ids?: string | null;
  poIds?: string | null;
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
  /**
   * NULL means the receipt line could not be resolved to ONE purchase-order
   * line — it was NOT compared. It used to be `0`, which reads as "ordered
   * none" and is indistinguishable from a real finding. See `resolution`.
   */
  poQty: number | null;
  grnQty: number;
  invoiceQty: number | null;
  /** NULL for the same reason as `poQty` — never `0` as a stand-in. */
  poPrice: number | null;
  grnPrice: number;
  invoicePrice: number | null;
  matched: boolean;
  /** The purchase-order line this receipt line was scored against, or NULL. */
  poItemId?: string | null;
  /** WHY it did or did not resolve — reported verbatim, never summarised away. */
  resolution: GrnPoLineOutcome;
};

type GrnItemRow = {
  id: number;
  grnId: string;
  poItemIndex: number | null;
  // Per-line PO ownership (see grn.ts). Read dual-keyed: the columns are
  // snake_case, but a driver or view may hand them back camelCased.
  po_id?: string | null;
  poId?: string | null;
  po_item_id?: string | null;
  poItemId?: string | null;
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
    const rows = JSON.parse(raw) as Partial<MatchItem>[];
    if (!Array.isArray(rows)) return [];
    // Rows written before BUG-2026-08-13-150 carry no `resolution` and cannot
    // now be told apart from a resolved one — the guess that produced them left
    // no trace. They are reported as `legacy-unknown` rather than silently
    // labelled `id`, which would be the same lie one layer up.
    return rows.map((r) => ({
      materialCode: r.materialCode ?? "",
      poQty: r.poQty ?? null,
      grnQty: r.grnQty ?? 0,
      invoiceQty: r.invoiceQty ?? null,
      poPrice: r.poPrice ?? null,
      grnPrice: r.grnPrice ?? 0,
      invoicePrice: r.invoicePrice ?? null,
      matched: r.matched === true,
      poItemId: r.poItemId ?? null,
      resolution: r.resolution ?? "legacy-unknown",
    }));
  } catch {
    return [];
  }
}

/** Every PO the match covers. Falls back to the header for rows written before `po_ids`. */
function parsePoIds(row: ThreeWayMatchRow): string[] {
  const raw = row.po_ids ?? row.poIds ?? null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const ids = parsed.map((v) => String(v)).filter(Boolean);
        if (ids.length > 0) return ids;
      }
    } catch {
      // Fall through to the header id below.
    }
  }
  return row.poId ? [row.poId] : [];
}

function rowToMatch(row: ThreeWayMatchRow) {
  return {
    id: row.id,
    poId: row.poId ?? "",
    poIds: parsePoIds(row),
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
  // RBAC gate (P3.3-followup) — three-way-match:read.
  const denied = await requirePermission(c, "three-way-match", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const res = await c.var.DB.prepare(
    "SELECT * FROM three_way_matches WHERE orgId = ?",
  )
    .bind(orgId)
    .all<ThreeWayMatchRow>();
  const data = (res.results ?? []).map(rowToMatch);
  return c.json(data);
});

// ---------------------------------------------------------------------------
// GET /api/three-way-match/by-po/:poId
//
// Phase 4.3 — per-line PO ↔ GRN ↔ PI quantity / value comparison for the
// procurement detail "Three-Way Match" tab. Computed live from the source
// tables so it stays current without re-running POST.
//
// Response shape:
//   {
//     success: true,
//     data: {
//       poId, poNo,
//       supplierId, supplierName,
//       lines: [{
//         materialCode, materialName, materialCategory, unit,
//         poQty, grnQty, piQty,
//         poUnitPriceSen, grnUnitPriceSen, piUnitPriceSen,
//         poLineSen, grnLineSen, piLineSen,
//         qtyVarianceVsPo,        // grnQty - poQty
//         piVsPoQtyVariance,       // piQty - poQty
//         senVarianceVsPo,         // grnLineSen - poLineSen
//         piVsPoSenVariance,       // piLineSen - poLineSen
//         fabricVariancePct,       // (grnQty-poQty)/poQty for FABRIC lines
//         status,                  // 'MATCH' | 'VARIANCE'
//       }],
//       summary: {
//         overBilledSen,           // sum(max(piLineSen - poLineSen, 0))
//         underDeliveredSen,       // sum(max(poLineSen - grnLineSen, 0))
//         poTotalSen, grnTotalSen, piTotalSen,
//       }
//     }
//   }
//
// Material aggregation key: materialCode (falls back to materialName when
// missing). One PO line per material — historical PO imports don't always
// dedupe, so we sum within material.
// ---------------------------------------------------------------------------
type PoLineRow = {
  id: string;
  materialCategory: string | null;
  materialName: string | null;
  supplierSKU: string | null;
  quantity: number;
  unitPriceSen: number;
  totalSen: number;
  unit: string | null;
};

type GrnLineRow = {
  materialCode: string | null;
  materialName: string | null;
  receivedQty: number;
  acceptedQty: number;
  unitPrice: number;
};

type PiLineRow = {
  materialCode: string | null;
  materialName: string | null;
  qty: number;
  unitPriceSen: number;
  lineTotalSen: number;
  lineType: string | null;
};

type LineAgg = {
  materialCode: string;
  materialName: string;
  materialCategory: string;
  unit: string;
  poQty: number;
  grnQty: number;
  piQty: number;
  poLineSen: number;
  grnLineSen: number;
  piLineSen: number;
  poUnitPriceSen: number;
  grnUnitPriceSen: number;
  piUnitPriceSen: number;
};

function deriveMatCode(name: string | null, fallback: string | null): string {
  // PO line items store "RM-CODE - description" in materialName. Split on
  // " - " to recover the code.
  if (fallback && fallback.trim().length > 0) return fallback.trim();
  if (!name) return "";
  const idx = name.indexOf(" - ");
  return idx > 0 ? name.slice(0, idx).trim() : name.trim();
}

app.get("/by-po/:poId", async (c) => {
  const denied = await requirePermission(c, "three-way-match", "read");
  if (denied) return denied;

  const orgId = getOrgId(c);
  const poId = c.req.param("poId");

  const po = await c.var.DB.prepare(
    `SELECT id, poNo, supplierId, supplierName, totalSen
     FROM purchase_orders WHERE id = ? AND orgId = ?`,
  )
    .bind(poId, orgId)
    .first<{
      id: string;
      poNo: string;
      supplierId: string | null;
      supplierName: string | null;
      totalSen: number;
    }>();
  if (!po) {
    return c.json({ success: false, error: "Purchase order not found" }, 404);
  }

  const [poItemsRes, grnsRes, pisRes] = await Promise.all([
    c.var.DB.prepare(
      `SELECT id, materialCategory, materialName, supplierSKU, quantity,
              unitPriceSen, totalSen, unit
       FROM purchase_order_items
       WHERE purchaseOrderId = ?
       ORDER BY id`,
    )
      .bind(poId)
      .all<PoLineRow>(),
    c.var.DB.prepare(
      `SELECT id FROM grns WHERE poId = ? AND status = 'POSTED'`,
    )
      .bind(poId)
      .all<{ id: string }>(),
    c.var.DB.prepare(
      `SELECT id FROM purchase_invoices WHERE purchaseOrderId = ?`,
    )
      .bind(poId)
      .all<{ id: string }>(),
  ]);

  const grnIds = (grnsRes.results ?? []).map((g) => g.id);
  const piIds = (pisRes.results ?? []).map((p) => p.id);

  let grnLines: GrnLineRow[] = [];
  let piLines: PiLineRow[] = [];
  if (grnIds.length > 0) {
    const ph = grnIds.map(() => "?").join(",");
    const gRes = await c.var.DB.prepare(
      `SELECT materialCode, materialName, receivedQty, acceptedQty, unitPrice
       FROM grn_items WHERE grnId IN (${ph})`,
    )
      .bind(...grnIds)
      .all<GrnLineRow>();
    grnLines = gRes.results ?? [];
  }
  if (piIds.length > 0) {
    const ph = piIds.map(() => "?").join(",");
    // purchase_invoice_items uses snake_case columns natively (pi_id,
    // line_type, etc.) — see purchase-invoices.ts loadItemsForPI for the
    // same pattern. Aliasing back to camelCase so the row-typed handler
    // doesn't have to dual-key.
    const pRes = await c.var.DB.prepare(
      `SELECT material_code AS "materialCode",
              material_name AS "materialName",
              qty,
              unit_price_sen AS "unitPriceSen",
              line_total_sen AS "lineTotalSen",
              line_type AS "lineType"
       FROM purchase_invoice_items
       WHERE pi_id IN (${ph})`,
    )
      .bind(...piIds)
      .all<PiLineRow>();
    // Only STOCKED lines compare against PO/GRN qty. FEE/TAX/REBATE/etc.
    // are excluded — they have no PO match and would distort variance.
    piLines = (pRes.results ?? []).filter(
      (l) => (l.lineType ?? "STOCKED") === "STOCKED",
    );
  }

  // Aggregate per material code
  const agg = new Map<string, LineAgg>();
  const ensure = (key: string): LineAgg => {
    let v = agg.get(key);
    if (!v) {
      v = {
        materialCode: key,
        materialName: "",
        materialCategory: "",
        unit: "",
        poQty: 0,
        grnQty: 0,
        piQty: 0,
        poLineSen: 0,
        grnLineSen: 0,
        piLineSen: 0,
        poUnitPriceSen: 0,
        grnUnitPriceSen: 0,
        piUnitPriceSen: 0,
      };
      agg.set(key, v);
    }
    return v;
  };

  for (const it of poItemsRes.results ?? []) {
    const code = deriveMatCode(it.materialName, it.supplierSKU);
    if (!code) continue;
    const a = ensure(code);
    if (!a.materialName) a.materialName = it.materialName ?? code;
    if (!a.materialCategory) a.materialCategory = it.materialCategory ?? "";
    if (!a.unit) a.unit = it.unit ?? "";
    a.poQty += it.quantity;
    a.poLineSen += it.totalSen;
    if (a.poUnitPriceSen === 0) a.poUnitPriceSen = it.unitPriceSen;
  }

  for (const gl of grnLines) {
    const code = deriveMatCode(gl.materialName, gl.materialCode);
    if (!code) continue;
    const a = ensure(code);
    if (!a.materialName) a.materialName = gl.materialName ?? code;
    a.grnQty += gl.acceptedQty;
    a.grnLineSen += gl.acceptedQty * gl.unitPrice;
    if (a.grnUnitPriceSen === 0) a.grnUnitPriceSen = gl.unitPrice;
  }

  for (const pl of piLines) {
    const code = deriveMatCode(pl.materialName, pl.materialCode);
    if (!code) continue;
    const a = ensure(code);
    if (!a.materialName) a.materialName = pl.materialName ?? code;
    a.piQty += pl.qty;
    a.piLineSen += pl.lineTotalSen;
    if (a.piUnitPriceSen === 0) a.piUnitPriceSen = pl.unitPriceSen;
  }

  const QTY_TOL = 1e-6;
  const FABRIC_TOL_PCT = 2;

  const lines = Array.from(agg.values()).map((a) => {
    const qtyVarianceVsPo = a.grnQty - a.poQty;
    const piVsPoQtyVariance = a.piQty - a.poQty;
    const senVarianceVsPo = a.grnLineSen - a.poLineSen;
    const piVsPoSenVariance = a.piLineSen - a.poLineSen;

    const isFabric =
      a.materialCategory.toUpperCase().includes("FABR") ||
      a.materialCategory.toUpperCase() === "FABRIC";
    const fabricVariancePct =
      isFabric && a.poQty > 0
        ? Math.round(((a.grnQty - a.poQty) / a.poQty) * 10000) / 100
        : null;
    const fabricFlagged =
      fabricVariancePct !== null && Math.abs(fabricVariancePct) > FABRIC_TOL_PCT;

    const piMatched =
      a.piQty === 0
        ? true
        : Math.abs(piVsPoQtyVariance) < QTY_TOL && piVsPoSenVariance === 0;
    const grnMatched =
      a.grnQty === 0
        ? true
        : Math.abs(qtyVarianceVsPo) < QTY_TOL && senVarianceVsPo === 0;
    const status = grnMatched && piMatched ? "MATCH" : "VARIANCE";

    return {
      materialCode: a.materialCode,
      materialName: a.materialName,
      materialCategory: a.materialCategory,
      unit: a.unit,
      poQty: a.poQty,
      grnQty: a.grnQty,
      piQty: a.piQty,
      poUnitPriceSen: a.poUnitPriceSen,
      grnUnitPriceSen: a.grnUnitPriceSen,
      piUnitPriceSen: a.piUnitPriceSen,
      poLineSen: a.poLineSen,
      grnLineSen: a.grnLineSen,
      piLineSen: a.piLineSen,
      qtyVarianceVsPo,
      piVsPoQtyVariance,
      senVarianceVsPo,
      piVsPoSenVariance,
      fabricVariancePct,
      fabricFlagged,
      status,
    };
  });

  // Per-supplier summary footer
  let overBilledSen = 0;
  let underDeliveredSen = 0;
  let poTotalSen = 0;
  let grnTotalSen = 0;
  let piTotalSen = 0;
  for (const l of lines) {
    poTotalSen += l.poLineSen;
    grnTotalSen += l.grnLineSen;
    piTotalSen += l.piLineSen;
    if (l.piLineSen > l.poLineSen) overBilledSen += l.piLineSen - l.poLineSen;
    if (l.grnLineSen < l.poLineSen) underDeliveredSen += l.poLineSen - l.grnLineSen;
  }

  return c.json({
    success: true,
    data: {
      poId: po.id,
      poNo: po.poNo,
      supplierId: po.supplierId ?? "",
      supplierName: po.supplierName ?? "",
      hasGRN: grnIds.length > 0,
      hasPI: piIds.length > 0,
      lines,
      summary: {
        poTotalSen,
        grnTotalSen,
        piTotalSen,
        overBilledSen,
        underDeliveredSen,
      },
    },
  });
});

// POST /api/three-way-match — compute + persist a new match
//
// Spec asked for `three-way-match:approve` here, but the 0045 seed only
// defines read/create/update/delete for this resource. Treat the
// compute+persist POST as the `create` action — that's what's actually
// in the matrix.
app.post("/", async (c) => {
  // RBAC gate (P3.3-followup) — three-way-match:create.
  const denied = await requirePermission(c, "three-way-match", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { grnId, invoiceId, invoiceNumber, invoiceTotal, invoiceItems } =
      body;

    if (!grnId) return c.json({ error: "grnId is required" }, 400);

    // Awaited before the first write — a migration file alone is inert here.
    await ensureTwmMigrations(c.var.DB);

    const grn = await c.var.DB.prepare(
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

    const grnItemsRes = await c.var.DB.prepare(
      "SELECT * FROM grn_items WHERE grnId = ? ORDER BY id",
    )
      .bind(grn.id)
      .all<GrnItemRow>();
    const grnItems = grnItemsRes.results ?? [];

    // A receipt may span SEVERAL purchase orders (owner 2026-08-04), so the
    // orders to match against come from the LINES — `grns.poId` is the header
    // for display. Matching only the header meant a second-PO line was scored
    // against whatever sat at its index on the first order (wrong ordered qty,
    // wrong price), and the variance compared ONE order's entire value against
    // a receipt that was partly another order's goods. Both fail quietly: the
    // first invents mismatches, the second can invent a FULL_MATCH.
    const linePoIds = [
      ...new Set(
        grnItems
          .map((gi) => (gi.po_id ?? gi.poId ?? "").trim())
          .filter(Boolean),
      ),
    ];
    const poIds = linePoIds.length > 0 ? linePoIds : grn.poId ? [grn.poId] : [];
    if (poIds.length === 0) {
      return c.json({ error: "Related PO not found" }, 404);
    }

    // `poItemIndex` is a POSITION, and a position is meaningless without the
    // order it was taken against. `purchase-orders.ts` states that order once
    // (`PO_ITEMS_ORDER = "ORDER BY line_no NULLS LAST, id"`) and `grn.ts:930`
    // — the stock draw-down — reads the index against it. This file used a
    // plain `ORDER BY id`, so the moment a PO's lines were reordered
    // (`line_no` is written from the request's array index on POST/PUT) the
    // same receipt line drew stock from one PO line and was PRICED against a
    // different one, on a single-PO receipt, with nothing logged.
    await ensurePoItemLineNo(c.var.DB);
    const placeholders = poIds.map(() => "?").join(",");
    const [posRes, poItemsRes] = await Promise.all([
      c.var.DB.prepare(
        `SELECT id, poNo, totalSen FROM purchase_orders WHERE id IN (${placeholders})`,
      )
        .bind(...poIds)
        .all<{ id: string; poNo: string; totalSen: number }>(),
      c.var.DB.prepare(
        `SELECT * FROM purchase_order_items WHERE purchaseOrderId IN (${placeholders}) ${PO_ITEMS_ORDER}`,
      )
        .bind(...poIds)
        .all<PoItemRow>(),
    ]);
    const pos = posRes.results ?? [];
    if (pos.length === 0) return c.json({ error: "Related PO not found" }, 404);
    const poItems = poItemsRes.results ?? [];

    // COUNT the claimants, never pick one. `resolveGrnPoLine` links a receipt
    // line to its PO line by identity (`po_item_id`), or positionally when the
    // owning order is not in doubt, and returns NULL with a reason for
    // everything else. See grn-po-line-link.ts — a wrong match reports
    // "checked, all fine" on an overcharge, which is worse than "cannot check".
    const lineIdx = buildPoLineIndex(
      poItems.map((it) => ({
        id: String(it.id),
        purchaseOrderId: String(it.purchaseOrderId ?? ""),
      })),
      pos.map((p) => p.id),
    );
    const poItemById = new Map<string, PoItemRow>();
    for (const it of poItems) poItemById.set(String(it.id), it);

    // The header PO stays whatever the GRN records, so existing single-PO
    // matches are unchanged. When the GRN's header order is NOT among the ones
    // its lines draw on there is no header to name — `pos` came from
    // `IN (...)`, which carries no ORDER BY, so `pos[0]` was an arbitrary
    // purchase order. One claimant is an observation; two is a refusal.
    const headerPo =
      pos.find((p) => p.id === grn.poId) ?? (pos.length === 1 ? pos[0] : null);
    const headerPoId = headerPo?.id ?? grn.poId ?? null;

    const TOLERANCE = 0.02;

    const matchItems: MatchItem[] = grnItems.map((gi) => {
      const link = resolveGrnPoLine(lineIdx, gi);
      const poItem = link.poItemId
        ? poItemById.get(link.poItemId)
        : undefined;
      const resolved = isResolvedGrnPoLine(link.outcome) && !!poItem;
      const invItem = (
        invoiceItems as
          | { materialCode: string; quantity: number; unitPrice: number }[]
          | undefined
      )?.find((ii) => ii.materialCode === gi.materialCode);

      // NULL, not 0, when the PO line could not be resolved. `?? 0` was the
      // second half of the money bug: an unresolved line printed "ordered 0 @
      // RM 0.00" beside a real receipt, which reads as a finding rather than as
      // "this line was never checked".
      const poQty = resolved ? (poItem?.quantity ?? null) : null;
      const grnQty = gi.acceptedQty;
      const invoiceQty = invItem?.quantity ?? null;
      const poPrice = resolved ? (poItem?.unitPriceSen ?? null) : null;
      const grnPrice = gi.unitPrice;
      const invPrice = invItem?.unitPrice ?? null;

      // An unresolved line is never `matched`. It has not been compared, and
      // `allMatched` below is what gates FULL_MATCH.
      const qtyMatch =
        poQty === null
          ? false
          : invoiceQty !== null
            ? poQty === grnQty && grnQty === invoiceQty
            : poQty === grnQty;
      const priceMatch =
        poPrice === null
          ? false
          : invoiceQty !== null
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
        poItemId: link.poItemId,
        resolution: link.outcome,
      };
    });
    const unresolvedLines = matchItems.filter(
      (i) => !isResolvedGrnPoLine(i.resolution),
    ).length;

    // Every order this receipt draws down, not just the header — otherwise the
    // variance measures one order's value against goods that partly belong to
    // another, which can land inside tolerance by coincidence. Identical to the
    // old behaviour when there is one PO.
    const poTotal = pos.reduce((s, p) => s + (Number(p.totalSen) || 0), 0);
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

    // An unresolved line is `matched: false` above, so it cannot reach
    // FULL_MATCH through this gate. Stated separately because that is the whole
    // point of the change: the old code priced such a line off another order
    // and could therefore call the match FULL.
    const allMatched = unresolvedLines === 0 && matchItems.every((i) => i.matched);
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

    // `poId` stays the header so every existing reader keeps working; the full
    // set goes in `po_ids` (snake_case, self-applied) and `poNumber` lists them
    // all, because a match row that names one of two orders reads as if the
    // other were never involved.
    const poNumbers = pos.map((p) => p.poNo).filter(Boolean);
    const poNumberOut =
      poNumbers.length > 1 ? poNumbers.join(", ") : (headerPo?.poNo ?? "");

    await c.var.DB.prepare(
      `INSERT INTO three_way_matches (id, poId, po_ids, poNumber, grnId, grnNumber,
         invoiceId, invoiceNumber, supplierId, supplierName, matchStatus,
         poTotal, grnTotal, invoiceTotal, variance, variancePercent,
         withinTolerance, items)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        headerPoId,
        JSON.stringify(pos.map((p) => p.id)),
        poNumberOut,
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
      poId: headerPoId,
      poIds: pos.map((p) => p.id),
      poNumber: poNumberOut,
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
      // How many receipt lines were NOT checked, surfaced beside the verdict.
      // A caller that never sees this number reads "MISMATCH on 1 line" the
      // same way whether the other lines were compared or skipped.
      unresolvedLines,
    };
    return c.json(newMatch, 201);
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
});

export default app;
