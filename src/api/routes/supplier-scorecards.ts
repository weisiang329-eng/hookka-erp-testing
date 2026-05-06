// ---------------------------------------------------------------------------
// D1-backed supplier-scorecards route.
//
// Mirrors src/api/routes/supplier-scorecards.ts — read-only GET with optional
// ?supplierId=... Returns a single scorecard when filtered, a list otherwise.
//
// NOTE: the original in-memory route returns `{ error }` (no `success: false`)
// on the supplierId-not-found case. Preserving that exact shape.
//
// Phase 4.1 additions:
//   - GET /summary returns { supplierId -> onTimeRate } for ALL suppliers
//     (used by procurement table column — single-fetch, NOT N+1)
//   - GET /:supplierId returns { onTimeRate, defectRate, averageLeadDays,
//     last10POs[] } derived live from purchase_orders + grns. Falls back to
//     the supplier_scorecards table for the rate metrics if no data.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { getOrgId } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type ScorecardRow = {
  supplierId: string;
  onTimeRate: number;
  qualityRate: number;
  leadTimeAccuracy: number;
  avgPriceTrend: number;
  overallRating: number;
  lastUpdated: string | null;
};

function rowToScorecard(r: ScorecardRow) {
  return {
    supplierId: r.supplierId,
    onTimeRate: r.onTimeRate,
    qualityRate: r.qualityRate,
    leadTimeAccuracy: r.leadTimeAccuracy,
    avgPriceTrend: r.avgPriceTrend,
    overallRating: r.overallRating,
    lastUpdated: r.lastUpdated ?? "",
  };
}

// GET /api/supplier-scorecards?supplierId=...
app.get("/", async (c) => {
  const denied = await requirePermission(c, "supplier-scorecards", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const supplierId = c.req.query("supplierId");
  if (supplierId) {
    const row = await c.var.DB.prepare(
      "SELECT * FROM supplier_scorecards WHERE orgId = ? AND supplierId = ?",
    )
      .bind(orgId, supplierId)
      .first<ScorecardRow>();
    if (!row) {
      return c.json({ error: "Scorecard not found" }, 404);
    }
    return c.json({ success: true, data: rowToScorecard(row) });
  }
  const res = await c.var.DB.prepare(
    "SELECT * FROM supplier_scorecards WHERE orgId = ? ORDER BY supplierId",
  )
    .bind(orgId)
    .all<ScorecardRow>();
  const data = (res.results ?? []).map(rowToScorecard);
  return c.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// GET /api/supplier-scorecards/summary
//
// One-shot OTR-by-supplier map for the procurement table. Computed live so
// it stays in sync with newly received POs (the supplier_scorecards table
// is only refreshed on a cron). Returns { success, data: { [supplierId]:
// { onTimeRate, totalPOs, onTimeCount } } }.
// ---------------------------------------------------------------------------
type PoStatRow = {
  supplierId: string | null;
  expectedDate: string | null;
  receivedDate: string | null;
  status: string | null;
};

function isReceivedOnTime(r: PoStatRow): boolean | null {
  // Only POs that were actually received contribute to OTR.
  if (r.status !== "RECEIVED" && r.status !== "CLOSED") return null;
  if (!r.expectedDate || !r.receivedDate) return null;
  return r.receivedDate <= r.expectedDate;
}

app.get("/summary", async (c) => {
  const denied = await requirePermission(c, "supplier-scorecards", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const res = await c.var.DB.prepare(
    `SELECT supplierId, expectedDate, receivedDate, status
     FROM purchase_orders
     WHERE orgId = ?`,
  )
    .bind(orgId)
    .all<PoStatRow>();
  const rows = res.results ?? [];

  const acc = new Map<
    string,
    { totalPOs: number; onTimeCount: number }
  >();
  for (const r of rows) {
    if (!r.supplierId) continue;
    const onTime = isReceivedOnTime(r);
    if (onTime === null) continue;
    const e = acc.get(r.supplierId) ?? { totalPOs: 0, onTimeCount: 0 };
    e.totalPOs += 1;
    if (onTime) e.onTimeCount += 1;
    acc.set(r.supplierId, e);
  }

  const data: Record<
    string,
    { onTimeRate: number; totalPOs: number; onTimeCount: number }
  > = {};
  for (const [sid, s] of acc) {
    data[sid] = {
      onTimeRate: s.totalPOs > 0 ? (s.onTimeCount / s.totalPOs) * 100 : 0,
      totalPOs: s.totalPOs,
      onTimeCount: s.onTimeCount,
    };
  }
  return c.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// GET /api/supplier-scorecards/:supplierId
//
// Extended detail used by the supplier-detail page. Computes live:
//   - onTimeRate (received POs where receivedDate <= expectedDate)
//   - defectRate (rejectedQty / totalReceivedQty across the supplier's GRNs)
//   - averageLeadDays (orderDate -> receivedDate, only RECEIVED POs)
//   - last10POs (most recent purchase orders, with status / quantities /
//     expected vs actual delivery)
//
// Falls back to the cron-cached supplier_scorecards row only for the
// overallRating display.
// ---------------------------------------------------------------------------
type DetailedPoRow = {
  id: string;
  poNo: string;
  status: string | null;
  orderDate: string | null;
  expectedDate: string | null;
  receivedDate: string | null;
  totalSen: number;
};

type DetailedPoItemRow = {
  purchaseOrderId: string;
  quantity: number;
  receivedQty: number | null;
};

type GrnQcRow = {
  poId: string | null;
  status: string | null;
  totalReceived: number;
  totalRejected: number;
};

app.get("/:supplierId", async (c) => {
  const denied = await requirePermission(c, "supplier-scorecards", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const supplierId = c.req.param("supplierId");

  const [supRow, posRes, scoreRow] = await Promise.all([
    c.var.DB.prepare(
      "SELECT id, code, name FROM suppliers WHERE orgId = ? AND id = ?",
    )
      .bind(orgId, supplierId)
      .first<{ id: string; code: string; name: string }>(),
    c.var.DB.prepare(
      `SELECT id, poNo, status, orderDate, expectedDate, receivedDate, totalSen
       FROM purchase_orders
       WHERE orgId = ? AND supplierId = ?
       ORDER BY orderDate DESC, poNo DESC`,
    )
      .bind(orgId, supplierId)
      .all<DetailedPoRow>(),
    c.var.DB.prepare(
      "SELECT * FROM supplier_scorecards WHERE orgId = ? AND supplierId = ?",
    )
      .bind(orgId, supplierId)
      .first<ScorecardRow>(),
  ]);
  if (!supRow) {
    return c.json({ error: "Supplier not found" }, 404);
  }

  const allPOs = posRes.results ?? [];
  const poIds = allPOs.map((p) => p.id);

  // Pull aggregated qty per PO (ordered + received) so the last-10 table
  // can show side-by-side without N+1.
  let itemRows: DetailedPoItemRow[] = [];
  let grnAgg: GrnQcRow[] = [];
  if (poIds.length > 0) {
    const placeholders = poIds.map(() => "?").join(",");
    const [itemsRes, grnRes] = await Promise.all([
      c.var.DB.prepare(
        `SELECT purchaseOrderId, quantity, receivedQty
         FROM purchase_order_items
         WHERE purchaseOrderId IN (${placeholders})`,
      )
        .bind(...poIds)
        .all<DetailedPoItemRow>(),
      c.var.DB.prepare(
        `SELECT g.poId AS "poId",
                g.status AS "status",
                COALESCE(SUM(gi.receivedQty), 0) AS "totalReceived",
                COALESCE(SUM(gi.rejectedQty), 0) AS "totalRejected"
         FROM grns g
         LEFT JOIN grn_items gi ON gi.grnId = g.id
         WHERE g.poId IN (${placeholders})
         GROUP BY g.poId, g.status`,
      )
        .bind(...poIds)
        .all<GrnQcRow>(),
    ]);
    itemRows = itemsRes.results ?? [];
    grnAgg = grnRes.results ?? [];
  }

  // Per-PO ordered/received roll-ups
  const orderedByPo = new Map<string, number>();
  const receivedByPo = new Map<string, number>();
  for (const it of itemRows) {
    orderedByPo.set(
      it.purchaseOrderId,
      (orderedByPo.get(it.purchaseOrderId) ?? 0) + (it.quantity ?? 0),
    );
    receivedByPo.set(
      it.purchaseOrderId,
      (receivedByPo.get(it.purchaseOrderId) ?? 0) + (it.receivedQty ?? 0),
    );
  }

  // OTR + average lead days from received POs
  let onTimeCount = 0;
  let receivedPoCount = 0;
  let leadDaysSum = 0;
  let leadDaysCount = 0;
  for (const p of allPOs) {
    if (p.status !== "RECEIVED" && p.status !== "CLOSED") continue;
    receivedPoCount += 1;
    if (p.expectedDate && p.receivedDate && p.receivedDate <= p.expectedDate) {
      onTimeCount += 1;
    }
    if (p.orderDate && p.receivedDate) {
      const ord = new Date(p.orderDate).getTime();
      const rec = new Date(p.receivedDate).getTime();
      if (Number.isFinite(ord) && Number.isFinite(rec) && rec >= ord) {
        leadDaysSum += (rec - ord) / 86400000;
        leadDaysCount += 1;
      }
    }
  }
  const onTimeRate = receivedPoCount > 0 ? (onTimeCount / receivedPoCount) * 100 : 0;
  const averageLeadDays =
    leadDaysCount > 0 ? Math.round((leadDaysSum / leadDaysCount) * 10) / 10 : 0;

  // Defect rate from GRNs (only POSTED GRNs count toward QC stats)
  let totalReceivedQty = 0;
  let totalRejectedQty = 0;
  for (const g of grnAgg) {
    if (g.status !== "POSTED") continue;
    totalReceivedQty += g.totalReceived ?? 0;
    totalRejectedQty += g.totalRejected ?? 0;
  }
  const defectRate =
    totalReceivedQty > 0 ? (totalRejectedQty / totalReceivedQty) * 100 : 0;

  const last10POs = allPOs.slice(0, 10).map((p) => ({
    id: p.id,
    poNo: p.poNo,
    status: p.status ?? "",
    orderDate: p.orderDate ?? "",
    expectedDate: p.expectedDate ?? "",
    receivedDate: p.receivedDate ?? "",
    totalSen: p.totalSen,
    orderedQty: orderedByPo.get(p.id) ?? 0,
    receivedQty: receivedByPo.get(p.id) ?? 0,
  }));

  return c.json({
    success: true,
    data: {
      supplierId,
      supplierCode: supRow.code,
      supplierName: supRow.name,
      onTimeRate: Math.round(onTimeRate * 10) / 10,
      defectRate: Math.round(defectRate * 100) / 100,
      averageLeadDays,
      totalPOs: allPOs.length,
      receivedPOs: receivedPoCount,
      onTimeCount,
      overallRating: scoreRow?.overallRating ?? 0,
      last10POs,
    },
  });
});

export default app;
