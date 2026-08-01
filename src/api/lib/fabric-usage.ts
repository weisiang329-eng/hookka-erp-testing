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
// Internal — compute per-FG fabric meters for ONE PO using its BOM tree.
// Used twice in computeFcFabricUsageMeters: once for the anchor PO, then
// once per sibling PO when the FAB_CUT JC is the anchor of a sofa cross-PO
// group. Same SPECIFIC-then-FALLBACK match strategy as the consume path.
// ---------------------------------------------------------------------------
function computeFabricFromBomForOnePo(
  po: {
    quantity: number;
    itemCategory: string | null;
    gapInches: number | null;
    divanHeightInches: number | null;
    legHeightInches: number | null;
    sizeCode: string | null;
    sizeLabel: string | null;
  },
  jcWipType: string | null,
  wipComponentsRaw: unknown,
): number {
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

  // SOFA: always sum every FC node in the BOM tree (LHF + 1NA + RHF +
  // backrest + cushion etc. all get cut on the same merged FC JC). The
  // wipType-specific match is wrong here because it would early-return on
  // the first matching module and miss the rest.
  // Bedframe / accessory: keep the wipType-specific match — those JCs
  // really do cut just one piece per JC.
  if (po.itemCategory !== "SOFA") {
    function findSpecific(node: unknown): unknown | null {
      if (!node || typeof node !== "object") return null;
      const n = node as Record<string, unknown>;
      if (isFcNode(node) && jcWipType && n.wipType === jcWipType) {
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
  }

  // Fallback (and sofa default): union of all FC nodes in the tree.
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
// Sibling PO shape used to expand cross-PO sofa cuts. The merged FAB_CUT
// JC sits on ONE anchor PO but physically cuts fabric for every sibling
// in the same SO group sharing the same fabric. Each sibling carries
// its own productCode (so its BOM may have a different fabricUsage) and
// its own quantity (qty=3 means 3 of that variant in one cut).
// ---------------------------------------------------------------------------
export type SiblingPo = {
  productCode: string | null;
  quantity: number;
  itemCategory: string | null;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  sizeCode: string | null;
  sizeLabel: string | null;
};

// ---------------------------------------------------------------------------
// Group key for sofa cross-PO siblings — must mirror the JC builder's
// merged FAB_CUT wipKey shape: `{companySOId|companyCOId}::{baseModel}::{fabricCode}`.
//
// Including baseModel is critical: a single SO may carry two different
// sofa lines that happen to share the same fabricCode (e.g. SO-2605-106
// has both 5530-1A series and 5535-1A series cut from M2402-4). Without
// baseModel they'd collapse into one group and the 5535 piece would be
// reported with the 5530 set's full fabric demand.
//
// Falls back to productCode when baseModel isn't known — slightly less
// precise but still per-product, never cross-product.
// ---------------------------------------------------------------------------
export function sofaSiblingGroupKey(
  po: {
    itemCategory: string | null;
    companySOId: string | null;
    companyCOId: string | null;
    fabricCode: string | null;
    productCode?: string | null;
  },
  baseModel?: string | null,
): string | null {
  if (po.itemCategory !== "SOFA") return null;
  const parent = po.companySOId || po.companyCOId;
  if (!parent || !po.fabricCode) return null;
  const model = baseModel || po.productCode || "";
  if (!model) return null;
  return `${parent}::${model}::${po.fabricCode}`;
}

// ---------------------------------------------------------------------------
// Pre-load every sofa PO that participates in a cross-PO group, then bucket
// by sofaSiblingGroupKey. Returns:
//   - byGroupKey         → Map<groupKey, SiblingPo[]> for sum-across-siblings
//   - baseModelByProductCode → Map<productCode, baseModel> so callers can
//                              recompute groupKey for any PO (callers usually
//                              have productCode but not baseModel).
//
// SQL JOINs bom_templates so baseModel rides along with the same query —
// avoids a second roundtrip. For products with no ACTIVE BOM template, the
// row still goes into the bucket (baseModel falls back to productCode).
// ---------------------------------------------------------------------------
export type SofaSiblingsIndex = {
  byGroupKey: Map<string, SiblingPo[]>;
  baseModelByProductCode: Map<string, string>;
};

export async function fetchSofaSiblingsByGroupKey(
  db: D1Database,
  orgId?: string | null,
): Promise<SofaSiblingsIndex> {
  const byGroupKey = new Map<string, SiblingPo[]>();
  const baseModelByProductCode = new Map<string, string>();
  const sql =
    `SELECT po.productCode, po.quantity, po.itemCategory, po.gapInches,
            po.divanHeightInches, po.legHeightInches, po.sizeCode, po.sizeLabel,
            po.companySOId, po.companyCOId, po.fabricCode,
            bt.baseModel
       FROM production_orders po
       LEFT JOIN bom_templates bt
         ON bt.productCode = po.productCode AND bt.versionStatus = 'ACTIVE'
      WHERE po.itemCategory = 'SOFA'
        AND po.fabricCode IS NOT NULL AND po.fabricCode <> ''
        AND (po.companySOId IS NOT NULL OR po.companyCOId IS NOT NULL)` +
    (orgId ? " AND po.orgId = ?" : "");
  const stmt = orgId ? db.prepare(sql).bind(orgId) : db.prepare(sql);
  const res = await stmt.all<{
    productCode: string | null;
    quantity: number;
    itemCategory: string | null;
    gapInches: number | null;
    divanHeightInches: number | null;
    legHeightInches: number | null;
    sizeCode: string | null;
    sizeLabel: string | null;
    companySOId: string | null;
    companyCOId: string | null;
    fabricCode: string | null;
    baseModel: string | null;
  }>();
  for (const r of res.results ?? []) {
    if (r.productCode && r.baseModel) {
      baseModelByProductCode.set(r.productCode, r.baseModel);
    }
    const key = sofaSiblingGroupKey(
      {
        itemCategory: r.itemCategory,
        companySOId: r.companySOId,
        companyCOId: r.companyCOId,
        fabricCode: r.fabricCode,
        productCode: r.productCode,
      },
      r.baseModel,
    );
    if (!key) continue;
    let bucket = byGroupKey.get(key);
    if (!bucket) {
      bucket = [];
      byGroupKey.set(key, bucket);
    }
    bucket.push({
      productCode: r.productCode,
      quantity: Number(r.quantity) || 0,
      itemCategory: r.itemCategory,
      gapInches: r.gapInches,
      divanHeightInches: r.divanHeightInches,
      legHeightInches: r.legHeightInches,
      sizeCode: r.sizeCode,
      sizeLabel: r.sizeLabel,
    });
  }
  return { byGroupKey, baseModelByProductCode };
}

// ---------------------------------------------------------------------------
// Compute predicted fabric meters for one FAB_CUT JC.
//
// For mainstream bedframe / accessory cases the JC fully describes the cut
// → walk the anchor PO's BOM only.
//
// For sofa cross-PO groups the merged FAB_CUT JC physically cuts fabric for
// MULTIPLE sibling POs (same companySOId + fabricCode). Only the anchor PO
// has the JC; the siblings have NO FC JC of their own. To capture the full
// cut we sum across all siblings. The caller passes `siblings` — when
// omitted (or just the anchor itself), single-PO math is preserved.
//
// Only counts materials with autoDetect="FABRIC" — leg / foam / hardware
// lines are excluded.
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
  bomByProductCode?: Map<string, unknown>,
  siblings?: SiblingPo[],
): number {
  if (jc.departmentCode !== "FAB_CUT") return 0;

  // Cross-PO sofa group: walk every sibling, sum each sibling's BOM-based
  // fabric demand. Bedframe / accessory siblings array is empty (or just
  // the anchor) → falls through to anchor-only math.
  if (
    po.itemCategory === "SOFA" &&
    Array.isArray(siblings) &&
    siblings.length > 0 &&
    bomByProductCode
  ) {
    let total = 0;
    for (const sib of siblings) {
      if (!sib.productCode) continue;
      const sibBom = bomByProductCode.get(sib.productCode);
      if (!sibBom) continue;
      total += computeFabricFromBomForOnePo(
        {
          quantity: sib.quantity,
          itemCategory: sib.itemCategory,
          gapInches: sib.gapInches,
          divanHeightInches: sib.divanHeightInches,
          legHeightInches: sib.legHeightInches,
          sizeCode: sib.sizeCode,
          sizeLabel: sib.sizeLabel,
        },
        jc.wipType,
        sibBom,
      );
    }
    return total;
  }

  // Single-PO path (bedframe / accessory / non-merged sofa).
  return computeFabricFromBomForOnePo(po, jc.wipType, wipComponentsRaw);
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
  companySOId: string | null;
  companyCOId: string | null;
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
  const [bomMap, siblingsIdx] = await Promise.all([
    fetchBomWipComponentsByCode(db),
    fetchSofaSiblingsByGroupKey(db),
  ]);
  const siblingsByGroup = siblingsIdx.byGroupKey;
  const baseModelByProductCode = siblingsIdx.baseModelByProductCode;
  const jcsRes = await db
    .prepare(
      `SELECT jc.id AS jc_id, jc.dueDate, jc.wipType, jc.departmentCode,
              po.id AS poId, po.fabricCode, po.quantity, po.productCode,
              po.itemCategory, po.gapInches, po.divanHeightInches,
              po.legHeightInches, po.sizeCode, po.sizeLabel,
              po.companySOId, po.companyCOId
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
    // For sofa cross-PO groups, fall through to the siblings path even when
    // the anchor's own BOM is missing (siblings supply their own BOM).
    const baseModel = jc.productCode
      ? baseModelByProductCode.get(jc.productCode)
      : null;
    const groupKey = sofaSiblingGroupKey(
      {
        itemCategory: jc.itemCategory,
        companySOId: jc.companySOId,
        companyCOId: jc.companyCOId,
        fabricCode: jc.fabricCode,
        productCode: jc.productCode,
      },
      baseModel,
    );
    const siblings = groupKey ? siblingsByGroup.get(groupKey) : undefined;
    if (!wipComponents && (!siblings || siblings.length === 0)) continue;
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
      bomMap,
      siblings,
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
  // outstanding = quantity − COALESCE(receivedQty, 0).
  //
  // SKU extraction: purchase_order_items.materialName is authored by
  // the Create PO modal as "<itemCode> - <description>" (e.g.
  // "PC151-10 - FABRIC"). To match against raw_materials.itemCode we
  // split on " - " and take the first segment. SPLIT_PART(s, sep, 1)
  // returns the full string if the separator is absent — so legacy
  // rows that were stored as plain itemCode also match.
  try {
    const outRes = await db
      .prepare(
        `SELECT TRIM(SPLIT_PART(poi.materialName, ' - ', 1)) AS code,
                SUM(poi.quantity - COALESCE(poi.receivedQty, 0)) AS qty
           FROM purchase_order_items poi
           INNER JOIN purchase_orders po ON po.id = poi.purchaseOrderId
          WHERE po.status NOT IN ('RECEIVED', 'CANCELLED', 'CLOSED')
            AND poi.materialName IS NOT NULL
          GROUP BY TRIM(SPLIT_PART(poi.materialName, ' - ', 1))`,
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

// ---------------------------------------------------------------------------
// Next-30-day fabric demand split by item CATEGORY (BEDFRAME / SOFA / ...).
//
// Same engine as computeFabricMetrics' demand loop (active FAB_CUT JCs,
// BOM-computed meters, due ≤ 30 days) but bucketed by the JC's production
// order category as well as fabric code. This is what lets the dashboard
// show category-correct forecasts — computeFabricMetrics is SKU-total
// only, so a bedframe fabric would otherwise show its full demand under
// Sofa too.
//
// Returns Map<CATEGORY, Map<fabricCode, meters>>.
// ---------------------------------------------------------------------------
export async function computeFabricNext30ByCategory(
  db: D1Database,
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  const add = (cat: string, code: string, meters: number) => {
    let m = out.get(cat);
    if (!m) {
      m = new Map();
      out.set(cat, m);
    }
    m.set(code, (m.get(code) ?? 0) + meters);
  };

  const today = new Date();
  const monthEnd = (() => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + 30);
    return d.toISOString().slice(0, 10);
  })();

  const [bomMap, siblingsIdx] = await Promise.all([
    fetchBomWipComponentsByCode(db),
    fetchSofaSiblingsByGroupKey(db),
  ]);
  const siblingsByGroup = siblingsIdx.byGroupKey;
  const baseModelByProductCode = siblingsIdx.baseModelByProductCode;

  const jcsRes = await db
    .prepare(
      `SELECT jc.id AS jc_id, jc.dueDate, jc.wipType, jc.departmentCode,
              po.id AS poId, po.fabricCode, po.quantity, po.productCode,
              po.itemCategory, po.gapInches, po.divanHeightInches,
              po.legHeightInches, po.sizeCode, po.sizeLabel,
              po.companySOId, po.companyCOId
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
    if (!jc.dueDate || jc.dueDate > monthEnd) continue;
    const cat = (jc.itemCategory ?? "").toUpperCase();
    if (!cat) continue;
    const wipComponents = jc.productCode ? bomMap.get(jc.productCode) : null;
    const baseModel = jc.productCode
      ? baseModelByProductCode.get(jc.productCode)
      : null;
    const groupKey = sofaSiblingGroupKey(
      {
        itemCategory: jc.itemCategory,
        companySOId: jc.companySOId,
        companyCOId: jc.companyCOId,
        fabricCode: jc.fabricCode,
        productCode: jc.productCode,
      },
      baseModel,
    );
    const siblings = groupKey ? siblingsByGroup.get(groupKey) : undefined;
    if (!wipComponents && (!siblings || siblings.length === 0)) continue;
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
      bomMap,
      siblings,
    );
    if (meters <= 0) continue;
    add(cat, jc.fabricCode, meters);
  }
  return out;
}

// Re-export for callers that don't want to recompute date arithmetic.
export const FABRIC_METRICS_TODAY = () => new Date().toISOString().slice(0, 10);
