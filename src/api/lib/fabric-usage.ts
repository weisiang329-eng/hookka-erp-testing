// ---------------------------------------------------------------------------
// fabric-usage.ts — single source of truth for fabric demand / supply numbers
// across the system.
//
// All consumers (Production Tracking Fab Cut column, Fabric Module live
// metrics, MRP supply/demand forecast) read from the same set of helpers
// here. The architecture decision (2026-05-07): the FAB_CUT JC is the
// authoritative demand record. Each active FAB_CUT JC carries a
// fabricUsageMeters derived from its parent PO's BOM template, dueDate
// for time-bucketing, and parent PO's fabricCode for SKU attribution.
//
// Helpers:
//   - fetchBomWipComponentsByCode  → preload BOM templates once per request
//   - computeFcFabricUsageMeters   → per-JC predicted meters (used by
//                                    rowToMinimalJobCard for the Fab Cut
//                                    sheet's Fabric Usage column)
//   - computeFabricMetrics         → live SOH / PO Outstanding / Historical
//                                    / 1wk-2wk-1mo Predicted per fabric
//                                    SKU. Read by /api/fabric-tracking
//                                    and /api/mrp.
// ---------------------------------------------------------------------------
import {
  expandMaterialQty,
  parseMaterialScaling,
  parseSofaSeatHeightInches,
  type ProductionDimensions,
} from "./material-scaling";

// ---------------------------------------------------------------------------
// Pre-load every ACTIVE bom_templates row's wipComponents JSON into a
// productCode → parsed-tree map. Called once per request (production-orders
// list, fabric-tracking GET, MRP) so per-PO fabric usage stays O(1).
// ---------------------------------------------------------------------------
export async function fetchBomWipComponentsByCode(
  db: D1Database,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const res = await db
    .prepare(
      "SELECT productCode, wipComponents FROM bom_templates WHERE versionStatus = 'ACTIVE'",
    )
    .all<{ productCode: string | null; wipComponents: string | null }>();
  for (const row of res.results ?? []) {
    if (!row.productCode || !row.wipComponents) continue;
    try {
      out.set(row.productCode, JSON.parse(row.wipComponents));
    } catch {
      // Skip malformed templates rather than failing the whole call.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compute predicted fabric meters for one FAB_CUT JC by walking the parent
// PO's bom_templates.wipComponents tree.
//
// Match strategy (mirrors the consume path in po-cost-cascade.ts):
//   1. SPECIFIC: any FC node whose wipType === jc.wipType → only that node
//      (used for STOOL / pillow JCs whose wipType is fine-grained, e.g.
//      SOFA_BASE / SOFA_CUSHION / SOFA_ARMREST and matches the BOM 1:1).
//   2. FALLBACK: union of all FC nodes (used for the merged bedframe FC JC
//      whose wipType is the parent category like "BEDFRAME", and for the
//      mainstream sofa FC JC where Cushion/Arm FC nodes intentionally have
//      empty materials so only Base contributes).
//
// Math: per-piece scaled qty × parent FC node's quantity × po.quantity ×
// (1 + waste%). Scaling is applied BEFORE multiplying by piece count so
// the perUnit slope (per-inch) stays per-piece.
//
// Only counts materials with autoDetect="FABRIC" — leg / foam / hardware
// lines are excluded from this metric.
// ---------------------------------------------------------------------------
export function computeFcFabricUsageMeters(
  po: {
    quantity: number;
    itemCategory: string | null;
    gapInches: number | null;
    divanHeightInches: number | null;
    legHeightInches: number | null;
    sizeCode: string | null;
    sizeLabel: string | null;
  },
  jc: {
    departmentCode: string | null;
    wipType: string | null;
  },
  wipComponentsRaw: unknown,
): number {
  if (jc.departmentCode !== "FAB_CUT") return 0;
  if (!wipComponentsRaw) return 0;
  const roots = Array.isArray(wipComponentsRaw)
    ? wipComponentsRaw
    : [wipComponentsRaw];

  const dims: ProductionDimensions = {
    gapInches: po.gapInches,
    divanHeightInches: po.divanHeightInches,
    legHeightInches: po.legHeightInches,
    seatHeightInches:
      po.itemCategory === "SOFA"
        ? parseSofaSeatHeightInches(po.sizeCode, po.sizeLabel)
        : null,
  };

  function isFcNode(node: unknown): boolean {
    if (!node || typeof node !== "object") return false;
    const procs = (node as Record<string, unknown>).processes;
    if (!Array.isArray(procs)) return false;
    return procs.some(
      (p) =>
        !!p &&
        typeof p === "object" &&
        (p as Record<string, unknown>).deptCode === "FAB_CUT",
    );
  }
  function nodeQty(node: unknown): number {
    if (!node || typeof node !== "object") return 1;
    const q = (node as Record<string, unknown>).quantity;
    const n = typeof q === "number" ? q : Number(q);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }
  function sumNodeFabric(node: unknown): number {
    if (!node || typeof node !== "object") return 0;
    const n = node as Record<string, unknown>;
    const mats = Array.isArray(n.materials) ? n.materials : [];
    let sum = 0;
    for (const m of mats) {
      if (!m || typeof m !== "object") continue;
      const row = m as Record<string, unknown>;
      if (row.autoDetect !== "FABRIC") continue;
      const qty =
        typeof row.qty === "number" ? row.qty : Number(row.qty) || 0;
      const scaling = parseMaterialScaling(row.scaling);
      const perPieceScaled = expandMaterialQty(qty, scaling, dims);
      const waste =
        typeof row.wastePct === "number"
          ? row.wastePct
          : Number(row.wastePct) || 0;
      sum +=
        perPieceScaled *
        nodeQty(node) *
        (po.quantity || 1) *
        (1 + Math.max(0, waste) / 100);
    }
    return sum;
  }

  // Pass 1 — specific match by wipType.
  function findSpecific(node: unknown): unknown | null {
    if (!node || typeof node !== "object") return null;
    const n = node as Record<string, unknown>;
    if (isFcNode(node) && jc.wipType && n.wipType === jc.wipType) {
      return node;
    }
    const kids = Array.isArray(n.children) ? n.children : [];
    for (const c of kids) {
      const found = findSpecific(c);
      if (found) return found;
    }
    return null;
  }
  for (const root of roots) {
    const specific = findSpecific(root);
    if (specific) return sumNodeFabric(specific);
  }

  // Pass 2 — fallback: union of all FC nodes.
  let total = 0;
  function walkAll(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (isFcNode(node)) total += sumNodeFabric(node);
    const kids = Array.isArray(n.children) ? n.children : [];
    for (const c of kids) walkAll(c);
  }
  for (const root of roots) walkAll(root);
  return total;
}

// ---------------------------------------------------------------------------
// Compute live fabric metrics per fabricCode by aggregating across:
//   - production_orders + job_cards (FAB_CUT, status active) → demand
//   - raw_materials.balanceQty                              → SOH
//   - purchase_orders + purchase_order_items (open, not received) → Outstanding
//   - cost_ledger RM_ISSUE rows (last 30 days)              → Historical
//
// Output is keyed by raw_materials.itemCode (which equals po.fabricCode for
// fabric SKUs). Caller merges into fabric_trackings response.
// ---------------------------------------------------------------------------
export type FabricMetrics = {
  fabricCode: string;
  soh: number;
  poOutstanding: number;
  lastMonthUsage: number;     // last 30 days actual consume from cost_ledger
  oneWeekUsage: number;       // forecast: active FAB_CUT JCs due ≤ 7 days
  twoWeeksUsage: number;      //          ≤ 14 days
  oneMonthUsage: number;      //          ≤ 30 days
  totalActiveUsage: number;   // forecast: ALL active FAB_CUT JCs (no date cap)
  shortage: number;           // SOH + poOutstanding − oneMonthUsage (signed)
};

type ActiveFcJcRow = {
  jcId: string;
  dueDate: string | null;
  wipType: string | null;
  departmentCode: string | null;
  poId: string;
  fabricCode: string | null;
  quantity: number;
  productCode: string | null;
  itemCategory: string | null;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  sizeCode: string | null;
  sizeLabel: string | null;
};

export async function computeFabricMetrics(
  db: D1Database,
): Promise<Map<string, FabricMetrics>> {
  const out = new Map<string, FabricMetrics>();
  function ensure(code: string): FabricMetrics {
    let m = out.get(code);
    if (!m) {
      m = {
        fabricCode: code,
        soh: 0,
        poOutstanding: 0,
        lastMonthUsage: 0,
        oneWeekUsage: 0,
        twoWeeksUsage: 0,
        oneMonthUsage: 0,
        totalActiveUsage: 0,
        shortage: 0,
      };
      out.set(code, m);
    }
    return m;
  }

  const today = new Date();
  const isoPlus = (days: number) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const isoMinus = (days: number) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  };
  const week1End = isoPlus(7);
  const week2End = isoPlus(14);
  const monthEnd = isoPlus(30);
  const last30Start = isoMinus(30);

  // ---- Demand: forecast from active FAB_CUT JCs ----
  // Same query the Fab Cut dept page hits (filtered server-side here so
  // we don't ship JCs to the client). Status filter mirrors what's
  // considered "in-flight" in production tracking. PO status excludes
  // CANCELLED/COMPLETED/ON_HOLD (held POs may resume but their fabric
  // demand isn't pressing).
  const bomMap = await fetchBomWipComponentsByCode(db);
  const jcsRes = await db
    .prepare(
      `SELECT jc.id AS jcId, jc.dueDate, jc.wipType, jc.departmentCode,
              po.id AS poId, po.fabricCode, po.quantity, po.productCode,
              po.itemCategory, po.gapInches, po.divanHeightInches,
              po.legHeightInches, po.sizeCode, po.sizeLabel
         FROM job_cards jc
         INNER JOIN production_orders po ON po.id = jc.productionOrderId
        WHERE jc.departmentCode = 'FAB_CUT'
          AND jc.status IN ('WAITING', 'IN_PROGRESS', 'PAUSED', 'BLOCKED')
          AND po.status NOT IN ('CANCELLED', 'COMPLETED', 'ON_HOLD')
          AND po.fabricCode IS NOT NULL
          AND po.fabricCode <> ''`,
    )
    .all<ActiveFcJcRow>();
  for (const jc of jcsRes.results ?? []) {
    if (!jc.fabricCode) continue;
    const wipComponents = jc.productCode ? bomMap.get(jc.productCode) : null;
    if (!wipComponents) continue;
    const meters = computeFcFabricUsageMeters(
      {
        quantity: jc.quantity,
        itemCategory: jc.itemCategory,
        gapInches: jc.gapInches,
        divanHeightInches: jc.divanHeightInches,
        legHeightInches: jc.legHeightInches,
        sizeCode: jc.sizeCode,
        sizeLabel: jc.sizeLabel,
      },
      { departmentCode: jc.departmentCode, wipType: jc.wipType },
      wipComponents,
    );
    if (meters <= 0) continue;
    const m = ensure(jc.fabricCode);
    m.totalActiveUsage += meters;
    if (jc.dueDate && jc.dueDate <= week1End) m.oneWeekUsage += meters;
    if (jc.dueDate && jc.dueDate <= week2End) m.twoWeeksUsage += meters;
    if (jc.dueDate && jc.dueDate <= monthEnd) m.oneMonthUsage += meters;
  }

  // ---- Supply: SOH from raw_materials ----
  // Most fabric SKUs have one row per itemCode but defensively SUM in
  // case there are duplicates. Only fabric-category rows are relevant —
  // we don't filter here because fabricCode rarely collides with non-
  // fabric itemCodes, but if needed we can add a category filter.
  const sohRes = await db
    .prepare(
      "SELECT itemCode, SUM(balanceQty) AS qty FROM raw_materials WHERE itemCode IS NOT NULL GROUP BY itemCode",
    )
    .all<{ itemCode: string; qty: number }>();
  for (const r of sohRes.results ?? []) {
    if (out.has(r.itemCode)) ensure(r.itemCode).soh = Number(r.qty) || 0;
  }

  // ---- Supply: PO Outstanding from purchase_order_items ----
  // Open POs = status NOT IN (RECEIVED, CANCELLED, CLOSED). Per-line
  // outstanding = quantity − COALESCE(receivedQty, 0). The schema has
  // no materialCode column on purchase_order_items; the SKU is stored
  // in `materialName` (e.g. 'PC151-01'). Match raw_materials.itemCode
  // on that. Defensive try/catch — if the column shape drifts again
  // the metric collapses to 0 instead of 500-ing the whole endpoint.
  try {
    const outRes = await db
      .prepare(
        `SELECT poi.materialName AS code,
                SUM(poi.quantity - COALESCE(poi.receivedQty, 0)) AS qty
           FROM purchase_order_items poi
           INNER JOIN purchase_orders po ON po.id = poi.purchaseOrderId
          WHERE po.status NOT IN ('RECEIVED', 'CANCELLED', 'CLOSED')
            AND poi.materialName IS NOT NULL
          GROUP BY poi.materialName`,
      )
      .all<{ code: string; qty: number }>();
    for (const r of outRes.results ?? []) {
      if (out.has(r.code)) ensure(r.code).poOutstanding = Number(r.qty) || 0;
    }
  } catch (err) {
    console.error("[computeFabricMetrics] PO Outstanding query failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // ---- Historical usage: cost_ledger RM_ISSUE rows last 30 days ----
  // JOIN raw_materials so we can group by itemCode (fabric SKU). Defensive
  // try/catch like the PO Outstanding path — schema drift on cost_ledger
  // shouldn't 500 the whole endpoint.
  try {
    const histRes = await db
      .prepare(
        `SELECT rm.itemCode AS code, SUM(cl.qty) AS qty
           FROM cost_ledger cl
           INNER JOIN raw_materials rm ON rm.id = cl.itemId
          WHERE cl.type = 'RM_ISSUE'
            AND cl.date >= ?
            AND rm.itemCode IS NOT NULL
          GROUP BY rm.itemCode`,
      )
      .bind(`${last30Start}T00:00:00.000Z`)
      .all<{ code: string; qty: number }>();
    for (const r of histRes.results ?? []) {
      if (out.has(r.code)) ensure(r.code).lastMonthUsage = Number(r.qty) || 0;
    }
  } catch (err) {
    console.error("[computeFabricMetrics] Historical query failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // ---- Shortage: SOH + Outstanding − 1mo predicted ----
  // Negative = under, positive = sufficient. Sign convention preserved
  // for the existing Fabric Module shortageOnly filter (WHERE shortage < 0).
  for (const m of out.values()) {
    m.shortage = m.soh + m.poOutstanding - m.oneMonthUsage;
  }

  return out;
}

// Re-export for callers that don't want to recompute date arithmetic.
export const FABRIC_METRICS_TODAY = () => new Date().toISOString().slice(0, 10);
