// ---------------------------------------------------------------------------
// po-cost-cascade.ts — Track F cost cascade on Production Order completion.
//
// When a PO reaches COMPLETED, three cost-side things must happen AFTER the
// fg_batches row is created by postProductionOrderCompletion():
//
//   F1. RM consumption (FIFO):
//       - Resolve BOM for PO.productId via bom_versions.tree (JSON) — we
//         walk the tree and collect every node's materials[] entry. If no
//         active bom_version exists, fall back to bom_components table.
//       - For each material line: required qty = perUnit × po.quantity
//         × (1 + waste%). FIFO-consume rm_batches (oldest receivedDate
//         first), decrement rm_batches.remainingQty and
//         raw_materials.balanceQty, emit one RM_ISSUE cost_ledger entry
//         per slice touched.
//       - Shortages log as a warning but do NOT abort.
//       - Idempotent: bail early if cost_ledger already has RM_ISSUE rows
//         for this productionOrderId.
//
//   F2. Labor posting per completed job card (handled by postJobCardLabor):
//       - On each job_card status flip to COMPLETED/TRANSFERRED, post a
//         LABOR_POSTED cost_ledger entry. Uses the floating laborRateForDate()
//         (there's no per-department rate column in schema today).
//       - Idempotent per jobCardId — we key by refType='JOB_CARD', refId=jc.id.
//
//   F3. FG batch cost backfill:
//       - Sum all RM_ISSUE + LABOR_POSTED totalCostSen for this PO, write
//         them back into fg_batches.{materialCostSen, laborCostSen,
//         unitCostSen} and emit the single FG_COMPLETED cost_ledger entry.
//       - Idempotent: bail if an FG_COMPLETED row already exists for the PO.
//
//   F4. WIP component tracking (light placeholder):
//       - Emits one WIP_COMPLETED cost_ledger entry summarising the FG qty.
//         Real WIP inventory deducts / layer creation is deferred
//         (TODO(wip-phase-2)).
//       - Idempotent by refType='PRODUCTION_ORDER' + WIP_COMPLETED row check.
//
// SCHEMA NOTE
//   cost_ledger.type CHECK constraint allows (post-migration-0011):
//     RM_RECEIPT / RM_ISSUE / LABOR_POSTED / FG_COMPLETED / FG_DELIVERED /
//     ADJUSTMENT / WIP_COMPLETED. F4 uses WIP_COMPLETED directly.
//     Legacy pre-0011 rows may still exist as ADJUSTMENT with a
//     "WIP_COMPLETED" notes prefix — the idempotency check covers both.
// ---------------------------------------------------------------------------
import { fifoConsume, laborRateForDate } from "../../lib/costing";
import type { RMBatch } from "../../types";
import {
  expandMaterialQty,
  parseMaterialScaling,
  parseSofaSeatHeightInches,
  type ProductionDimensions,
} from "./material-scaling";

type RMBatchRow = {
  id: string;
  rmId: string;
  source: string;
  sourceRefId: string | null;
  receivedDate: string;
  originalQty: number;
  remainingQty: number;
  unitCostSen: number;
  created_at: string | null;
  notes: string | null;
};

type ProductionOrderRow = {
  id: string;
  poNo: string;
  productId: string | null;
  productCode: string | null;
  quantity: number;
  completedDate: string | null;
  // Snapshotted SO/CO line dimensions used by the BOM material scaling
  // rule. Bedframe dims are stored as INTs; sofa seat height lives
  // inline in sizeCode/sizeLabel and is parsed at use time via
  // parseSofaSeatHeightInches. itemCategory tells us whether to do
  // that parse (bedframe sizeCode is "K"/"Q"/"S", not inches).
  itemCategory: string | null;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  // SO line fabric snapshot. Fabric raw materials live in raw_materials
  // keyed by itemCode === fabricCode (e.g. "PC151-01"), so this drives
  // the autoDetect=FABRIC substitution at consumption time.
  fabricCode: string | null;
};

type BomVersionRow = {
  id: string;
  productId: string;
  productCode: string | null;
  status: string | null;
  tree: string | null;
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

type MaterialLine = {
  code: string;              // BOM-side lookup key (e.g. "PLY-18")
  name: string;
  qtyPerUnit: number;
  wastePct: number;          // 0..100
  inventoryCode?: string;    // preferred mapping to raw_materials.itemCode
  // When set, this BOM line is bound to a per-SO field rather than a
  // fixed inventory item. resolveBomMaterials substitutes inventoryCode
  // with the PO's snapshotted SO value before FIFO lookup runs:
  //   "FABRIC" → po.fabricCode (raw_materials.itemCode === fabricCode)
  //   "LEG"    → no current schema mapping → falls through to shortage
  //              report with the original "Leg (from order)" name.
  autoDetect?: "FABRIC" | "LEG";
};

// Walk a BOM tree JSON node and gather every `materials[]` entry across all
// nested levels. The tree is the JSON stored in bom_versions.tree.
//
// Material scaling is applied HERE (not later in consumeRawMaterialsForPO)
// so the resulting `qtyPerUnit` is already the SCALED per-FG-unit qty.
// Downstream multiplication by `po.quantity` and `(1 + wastePct/100)`
// stays unchanged. If a row has no scaling rule, expandMaterialQty
// returns the raw qty — same behaviour as before this change.
function collectTreeMaterials(
  node: unknown,
  out: MaterialLine[],
  dims: ProductionDimensions,
): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  const mats = n.materials;
  if (Array.isArray(mats)) {
    for (const m of mats) {
      if (!m || typeof m !== "object") continue;
      const row = m as Record<string, unknown>;
      const code = typeof row.code === "string" ? row.code : "";
      const name = typeof row.name === "string" ? row.name : code;
      const qty = typeof row.qty === "number" ? row.qty : Number(row.qty) || 0;
      const scaling = parseMaterialScaling(row.scaling);
      const scaledQty = expandMaterialQty(qty, scaling, dims);
      const waste =
        typeof row.wastePct === "number"
          ? row.wastePct
          : Number(row.wastePct) || 0;
      const inventoryCode =
        typeof row.inventoryCode === "string" ? row.inventoryCode : undefined;
      const autoDetect =
        row.autoDetect === "FABRIC" || row.autoDetect === "LEG"
          ? row.autoDetect
          : undefined;
      // autoDetect lines may have empty code/name at authoring time — keep
      // them so the substitution step downstream can resolve them. The
      // (code || name) guard would otherwise drop them silently.
      if (scaledQty > 0 && (code || name || autoDetect)) {
        out.push({
          code: code || name,
          name: name || (autoDetect === "FABRIC" ? "Fabric (from order)" : autoDetect === "LEG" ? "Leg (from order)" : ""),
          qtyPerUnit: scaledQty,
          wastePct: waste,
          inventoryCode,
          autoDetect,
        });
      }
    }
  }
  const kids = n.children;
  if (Array.isArray(kids)) {
    for (const child of kids) {
      collectTreeMaterials(child, out, dims);
    }
  }
}

// Resolve the BOM material list for a PO. Walks three sources in order:
//   1. bom_versions.tree            (legacy rich schema, only ~4 rows in prod)
//   2. bom_templates.wipComponents  (current source of truth — BOM editor +
//                                    MRP both write here; 244 rows in prod)
//   3. bom_components               (flat fallback keyed by productId)
//
// Source #2 was added 2026-05-07: existing PO completions were silently
// returning [] for almost every product because bom_versions had only 4
// entries while operators authored BOMs through the /api/bom/templates UI.
// fabric was never being deducted at PO completion. Walking
// bom_templates.wipComponents with the same collectTreeMaterials helper
// (compatible shape — same `materials`/`children` keys) closes that gap
// without a data migration. Returns [] if nothing is found. Dimensions
// snapshot is used by the JSON-tree paths to expand per-material scaling
// rules at extraction time.
async function resolveBomMaterials(
  db: D1Database,
  po: ProductionOrderRow,
): Promise<MaterialLine[]> {
  // Try ACTIVE bom_version by productId first, productCode second.
  let version: BomVersionRow | null = null;
  if (po.productId) {
    version = await db
      .prepare(
        "SELECT id, productId, productCode, status, tree FROM bom_versions WHERE productId = ? AND status = 'ACTIVE' LIMIT 1",
      )
      .bind(po.productId)
      .first<BomVersionRow>();
  }
  if (!version && po.productCode) {
    version = await db
      .prepare(
        "SELECT id, productId, productCode, status, tree FROM bom_versions WHERE productCode = ? AND status = 'ACTIVE' LIMIT 1",
      )
      .bind(po.productCode)
      .first<BomVersionRow>();
  }

  // Build the dimension snapshot used by every scaling rule on this PO.
  // Bedframe sizeCode ("Q" / "K" / "S") is rejected by the parser so it
  // doesn't pollute seatHeightInches; only sofa SO lines populate it.
  const dims: ProductionDimensions = {
    gapInches: po.gapInches,
    divanHeightInches: po.divanHeightInches,
    legHeightInches: po.legHeightInches,
    seatHeightInches:
      po.itemCategory === "SOFA"
        ? parseSofaSeatHeightInches(po.sizeCode, po.sizeLabel)
        : null,
  };

  if (version?.tree) {
    try {
      const parsed = JSON.parse(version.tree);
      const acc: MaterialLine[] = [];
      collectTreeMaterials(parsed, acc, dims);
      if (acc.length > 0) return await substituteAutoDetectMaterials(db, acc, po);
    } catch {
      // fall through to bom_templates
    }
  }

  // Step 2: bom_templates.wipComponents — current source of truth. The
  // wipComponents column is a JSON ARRAY of root nodes (one root per top-
  // level WIP — divan, headboard, sofa base, etc.), not a single root.
  // Walk each root with collectTreeMaterials; the helper accumulates into
  // `acc` across siblings.
  if (po.productCode) {
    const tplRow = await db
      .prepare(
        "SELECT id, wipComponents FROM bom_templates WHERE productCode = ? AND versionStatus = 'ACTIVE' LIMIT 1",
      )
      .bind(po.productCode)
      .first<{ id: string; wipComponents: string | null }>();
    if (tplRow?.wipComponents) {
      try {
        const parsed = JSON.parse(tplRow.wipComponents);
        const roots = Array.isArray(parsed) ? parsed : [parsed];
        const acc: MaterialLine[] = [];
        for (const root of roots) {
          collectTreeMaterials(root, acc, dims);
        }
        if (acc.length > 0) return await substituteAutoDetectMaterials(db, acc, po);
      } catch {
        // fall through to bom_components
      }
    }
  }

  // Fallback: bom_components table (flat list keyed by productId).
  if (po.productId) {
    const bcRes = await db
      .prepare(
        "SELECT id, productId, materialCategory, materialName, qtyPerUnit, unit, wastePct FROM bom_components WHERE productId = ?",
      )
      .bind(po.productId)
      .all<BomComponentRow>();
    const rows = bcRes.results ?? [];
    if (rows.length > 0) {
      return rows.map((r) => ({
        code: r.materialName,
        name: r.materialName,
        qtyPerUnit: r.qtyPerUnit,
        wastePct: r.wastePct,
      }));
    }
  }
  return [];
}

// Bind autoDetect lines to a concrete inventory key from the PO snapshot.
//   FABRIC: po.fabricCode IS raw_materials.itemCode for the SO's chosen
//           fabric — set inventoryCode and let the normal lookup chain run.
//   LEG:    SO line carries legHeightInches; the shop names leg inventory
//           with the inch height inline (e.g. `SOFA LEG PLASTIC (ROUND) 2"`).
//           Match raw_materials.description LIKE `%<N>"%` AND `%LEG%`,
//           case-insensitive, first by itemCode ASC. Misses fall through
//           and the caller records a shortage with the original name.
// Lines without an autoDetect tag are passed through unchanged.
async function substituteAutoDetectMaterials(
  db: D1Database,
  lines: MaterialLine[],
  po: ProductionOrderRow,
): Promise<MaterialLine[]> {
  const out: MaterialLine[] = [];
  for (const line of lines) {
    if (!line.autoDetect) {
      out.push(line);
      continue;
    }
    if (line.autoDetect === "FABRIC" && po.fabricCode) {
      out.push({ ...line, inventoryCode: po.fabricCode, code: po.fabricCode });
      continue;
    }
    if (line.autoDetect === "LEG" && po.legHeightInches != null && po.legHeightInches > 0) {
      const heightStr = `${po.legHeightInches}"`;
      const hit = await db
        .prepare(
          `SELECT itemCode FROM raw_materials
             WHERE isActive = 1
               AND description LIKE ? COLLATE NOCASE
               AND description LIKE '%LEG%' COLLATE NOCASE
             ORDER BY itemCode ASC LIMIT 1`,
        )
        .bind(`%${heightStr}%`)
        .first<{ itemCode: string }>();
      if (hit) {
        out.push({ ...line, inventoryCode: hit.itemCode, code: hit.itemCode });
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

// Resolve a BOM material line to a raw_materials row id. Tries:
//   1. inventoryCode exact match on raw_materials.itemCode
//   2. code on itemCode
//   3. name on description (case-insensitive)
async function resolveRmFromBom(
  db: D1Database,
  line: MaterialLine,
): Promise<{ id: string; itemCode: string; description: string } | null> {
  if (line.inventoryCode) {
    const hit = await db
      .prepare(
        "SELECT id, itemCode, description FROM raw_materials WHERE itemCode = ? LIMIT 1",
      )
      .bind(line.inventoryCode)
      .first<{ id: string; itemCode: string; description: string }>();
    if (hit) return hit;
  }
  if (line.code) {
    const hit = await db
      .prepare(
        "SELECT id, itemCode, description FROM raw_materials WHERE itemCode = ? LIMIT 1",
      )
      .bind(line.code)
      .first<{ id: string; itemCode: string; description: string }>();
    if (hit) return hit;
  }
  if (line.name) {
    const hit = await db
      .prepare(
        "SELECT id, itemCode, description FROM raw_materials WHERE description = ? COLLATE NOCASE LIMIT 1",
      )
      .bind(line.name)
      .first<{ id: string; itemCode: string; description: string }>();
    if (hit) return hit;
  }
  return null;
}

function genLedgerId(prefix: string): string {
  return `cl-${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Walk the bom_templates wipComponents tree and return materials from every
// FAB_CUT node a JC should consume, paired with the parent FC node's
// `quantity` field so consumption math can multiply correctly. Two-step
// match strategy:
//
//   1. SPECIFIC: if any FC node's wipType === jc.wipType, return ONLY
//      that node's materials. Used for STOOL / CSL / pillow JCs whose
//      wipType is fine-grained (SOFA_BASE / SOFA_CUSHION / SOFA_ARMREST)
//      and matches the BOM node 1:1.
//
//   2. FALLBACK: if no specific match, return the union of ALL FC nodes'
//      materials. Used for bedframe (jc.wipType='BEDFRAME', BOM has
//      Divan FC[wipType='DIVAN', quantity=2] + HB FC[wipType='HEADBOARD',
//      quantity=1]) and sofa (jc.wipType='SOFA', BOM has Base + Cushion +
//      Arm FC nodes — but Cushion / Arm have empty materials[] per spec).
//
// Why pair with nodeQuantity: the BOM authors `material.qty` as PER-PIECE
// (e.g. divan FC qty=3.25 means 3.25m fabric per divan piece). The FC
// node's `quantity` field is the piece count (2 for K/Q divans, 1 for
// HB). Total per FG = material.qty × scaling × nodeQuantity. The merged
// FAB_CUT JC for a bedframe needs different multipliers per material
// (×2 for Divan, ×1 for HB), which jc.wipQty alone can't capture.
// ---------------------------------------------------------------------------
type FcMaterialWithMultiplier = {
  material: unknown;
  nodeQuantity: number;
};

function collectFcNodeMaterials(
  roots: unknown[],
  jcWipType: string,
): FcMaterialWithMultiplier[] {
  function isFcNode(node: unknown): boolean {
    if (!node || typeof node !== "object") return false;
    const n = node as Record<string, unknown>;
    const procs = Array.isArray(n.processes) ? n.processes : [];
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
  function emitMaterials(
    node: unknown,
    out: FcMaterialWithMultiplier[],
  ): void {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    const mats = Array.isArray(n.materials) ? n.materials : [];
    const q = nodeQty(node);
    for (const m of mats) out.push({ material: m, nodeQuantity: q });
  }

  // Pass 1: specific match by wipType.
  function walkSpecific(node: unknown): FcMaterialWithMultiplier[] | null {
    if (!node || typeof node !== "object") return null;
    const n = node as Record<string, unknown>;
    if (isFcNode(node) && n.wipType === jcWipType) {
      const out: FcMaterialWithMultiplier[] = [];
      emitMaterials(node, out);
      return out;
    }
    const kids = Array.isArray(n.children) ? n.children : [];
    for (const c of kids) {
      const found = walkSpecific(c);
      if (found) return found;
    }
    return null;
  }
  for (const root of roots) {
    const found = walkSpecific(root);
    if (found) return found;
  }
  // Pass 2: fallback — union of all FC nodes' materials.
  const acc: FcMaterialWithMultiplier[] = [];
  function walkAll(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (isFcNode(node)) emitMaterials(node, acc);
    const kids = Array.isArray(n.children) ? n.children : [];
    for (const c of kids) walkAll(c);
  }
  for (const root of roots) walkAll(root);
  return acc;
}

// ---------------------------------------------------------------------------
// Resolve BOM materials scoped to ONE specific FAB_CUT JC. Reads
// bom_templates.wipComponents (current source of truth — same table
// resolveBomMaterials walks for the PO-wide path), but extracts only the
// node matching this JC's wipType + FAB_CUT process.
//
// Materials get scaled with the same expandMaterialQty + scaling rules
// the PO-wide path uses, then autoDetect=FABRIC is substituted to
// po.fabricCode (sofa/bedframe spec — fabric SKU lives on the SO line, not
// the BOM template).
// ---------------------------------------------------------------------------
async function resolveBomMaterialsForJC(
  db: D1Database,
  po: ProductionOrderRow,
  jc: { id: string; departmentCode: string | null; wipType: string | null },
): Promise<MaterialLine[]> {
  if (!po.productCode) return [];
  if (jc.departmentCode !== "FAB_CUT") return [];
  if (!jc.wipType) return [];

  const dims: ProductionDimensions = {
    gapInches: po.gapInches,
    divanHeightInches: po.divanHeightInches,
    legHeightInches: po.legHeightInches,
    seatHeightInches:
      po.itemCategory === "SOFA"
        ? parseSofaSeatHeightInches(po.sizeCode, po.sizeLabel)
        : null,
  };

  const tplRow = await db
    .prepare(
      "SELECT id, wipComponents FROM bom_templates WHERE productCode = ? AND versionStatus = 'ACTIVE' LIMIT 1",
    )
    .bind(po.productCode)
    .first<{ id: string; wipComponents: string | null }>();
  if (!tplRow?.wipComponents) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(tplRow.wipComponents);
  } catch {
    return [];
  }
  const roots = Array.isArray(parsed) ? parsed : [parsed];
  const tagged = collectFcNodeMaterials(roots, jc.wipType);
  if (tagged.length === 0) return [];

  // Build MaterialLine[] — scale per-piece qty against PO dims, then
  // multiply by parent FC node's quantity to get per-FG qty. Scaling
  // rules are authored per-piece (base 8" divan / base 20" totalHeight
  // / base 30" seatHeight), so we expand BEFORE multiplying by
  // pieceCount; multiplying first would scale the perUnit slope wrong.
  const acc: MaterialLine[] = [];
  for (const { material, nodeQuantity } of tagged) {
    if (!material || typeof material !== "object") continue;
    const row = material as Record<string, unknown>;
    const code = typeof row.code === "string" ? row.code : "";
    const name = typeof row.name === "string" ? row.name : code;
    const qty = typeof row.qty === "number" ? row.qty : Number(row.qty) || 0;
    const scaling = parseMaterialScaling(row.scaling);
    const perPieceScaled = expandMaterialQty(qty, scaling, dims);
    const perFgQty = perPieceScaled * nodeQuantity;
    const waste =
      typeof row.wastePct === "number"
        ? row.wastePct
        : Number(row.wastePct) || 0;
    const inventoryCode =
      typeof row.inventoryCode === "string" ? row.inventoryCode : undefined;
    const autoDetect =
      row.autoDetect === "FABRIC" || row.autoDetect === "LEG"
        ? row.autoDetect
        : undefined;
    if (perFgQty > 0 && (code || name || autoDetect)) {
      acc.push({
        code: code || name,
        name:
          name ||
          (autoDetect === "FABRIC"
            ? "Fabric (from order)"
            : autoDetect === "LEG"
              ? "Leg (from order)"
              : ""),
        qtyPerUnit: perFgQty,
        wastePct: waste,
        inventoryCode,
        autoDetect,
      });
    }
  }
  if (acc.length === 0) return [];
  return await substituteAutoDetectMaterials(db, acc, po);
}

// ---------------------------------------------------------------------------
// F1-JC — RM consumption (FIFO) on FAB_CUT JC completion.
//
// Per 2026-05-07 architecture decision: fabric (and any other raw materials
// authored on the FC node) is deducted from raw_materials.balanceQty the
// moment the FAB_CUT JC flips to COMPLETED/TRANSFERRED — matches physical
// reality (meters leave the roll when cutting happens, not weeks later when
// the whole PO finishes).
//
// Idempotency: cost_ledger refType='JOB_CARD', refId=jc.id, type='RM_ISSUE'.
// Re-flipping a JC's status (rollback + re-complete) does not re-consume.
//
// Cross-PO sibling caveat (SOFA group with anchor FAB_CUT JC): only the
// anchor PO has a FAB_CUT JC; sibling POs have no FAB_CUT JC of their own.
// The anchor's BOM is authored to cover the whole group's fabric demand
// (i.e. wipQty already aggregates), so consuming on the anchor JC is
// correct without explicit sibling traversal.
// ---------------------------------------------------------------------------
export async function consumeRawMaterialsForJC(
  db: D1Database,
  jcId: string,
): Promise<{
  skipped: boolean;
  materialCostSen: number;
  linesConsumed: number;
  shortages: { materialName: string; shortageQty: number }[];
}> {
  // Idempotency — already consumed on this JC?
  const existing = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM cost_ledger WHERE refType = 'JOB_CARD' AND refId = ? AND type = 'RM_ISSUE'",
    )
    .bind(jcId)
    .first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) {
    return { skipped: true, materialCostSen: 0, linesConsumed: 0, shortages: [] };
  }

  const jc = await db
    .prepare(
      "SELECT id, productionOrderId, departmentCode, wipType, wipQty, status, completedDate FROM job_cards WHERE id = ?",
    )
    .bind(jcId)
    .first<{
      id: string;
      productionOrderId: string;
      departmentCode: string | null;
      wipType: string | null;
      wipQty: number | null;
      status: string;
      completedDate: string | null;
    }>();
  if (!jc) {
    return { skipped: true, materialCostSen: 0, linesConsumed: 0, shortages: [] };
  }
  // Only FAB_CUT JCs consume raw materials in this architecture. Other
  // dept JCs (FAB_SEW, WOOD_CUT, etc.) are pure WIP-transformation steps —
  // their cost is captured as labor + WIP cascade, not RM consume.
  if (jc.departmentCode !== "FAB_CUT") {
    return { skipped: true, materialCostSen: 0, linesConsumed: 0, shortages: [] };
  }

  const po = await db
    .prepare(
      `SELECT id, poNo, productId, productCode, quantity, completedDate,
              itemCategory, gapInches, divanHeightInches, legHeightInches,
              sizeCode, sizeLabel, fabricCode
         FROM production_orders WHERE id = ?`,
    )
    .bind(jc.productionOrderId)
    .first<ProductionOrderRow>();
  if (!po || !po.quantity || po.quantity <= 0) {
    return { skipped: false, materialCostSen: 0, linesConsumed: 0, shortages: [] };
  }

  const bomLines = await resolveBomMaterialsForJC(db, po, jc);
  if (bomLines.length === 0) {
    return { skipped: false, materialCostSen: 0, linesConsumed: 0, shortages: [] };
  }

  const dateIso = jc.completedDate
    ? new Date(`${jc.completedDate}T12:00:00`).toISOString()
    : new Date().toISOString();

  // JC-level required qty = qtyPerUnit (per-FG, already includes
  // node-quantity multiplication from resolveBomMaterialsForJC) ×
  // po.quantity × (1 + waste%). Most POs run quantity=1 so this
  // collapses to qtyPerUnit × (1 + waste%); for batch POs (quantity > 1)
  // the consume scales linearly with FG count, which matches BOM
  // semantics where qty is "per finished good."
  let materialCostSen = 0;
  let linesConsumed = 0;
  const shortages: { materialName: string; shortageQty: number }[] = [];
  const statements: D1PreparedStatement[] = [];

  for (const line of bomLines) {
    const required =
      line.qtyPerUnit *
      po.quantity *
      (1 + Math.max(0, line.wastePct || 0) / 100);
    if (required <= 0) continue;

    const rm = await resolveRmFromBom(db, line);
    if (!rm) {
      shortages.push({ materialName: line.name, shortageQty: required });
      continue;
    }

    const batchesRes = await db
      .prepare(
        "SELECT id, rmId, source, sourceRefId, receivedDate, originalQty, remainingQty, unitCostSen, created_at, notes FROM rm_batches WHERE rmId = ? AND remainingQty > 0 ORDER BY receivedDate ASC, id ASC",
      )
      .bind(rm.id)
      .all<RMBatchRow>();
    const rows = batchesRes.results ?? [];

    const batches: RMBatch[] = rows.map((b) => ({
      id: b.id,
      rmId: b.rmId,
      source: b.source as RMBatch["source"],
      sourceRefId: b.sourceRefId ?? undefined,
      receivedDate: b.receivedDate,
      originalQty: b.originalQty,
      remainingQty: b.remainingQty,
      unitCostSen: b.unitCostSen,
      createdAt: b.created_at ?? "",
      notes: b.notes ?? undefined,
    }));

    const result = fifoConsume(batches, required);

    for (const slice of result.slices) {
      statements.push(
        db
          .prepare(
            "UPDATE rm_batches SET remainingQty = remainingQty - ? WHERE id = ?",
          )
          .bind(slice.qty, slice.batchId),
        db
          .prepare(
            `INSERT INTO cost_ledger
               (id, date, type, itemType, itemId, batchId, qty, direction,
                unitCostSen, totalCostSen, refType, refId, notes)
             VALUES (?, ?, 'RM_ISSUE', 'RM', ?, ?, ?, 'OUT', ?, ?, 'JOB_CARD', ?, ?)`,
          )
          .bind(
            genLedgerId("rmi"),
            dateIso,
            rm.id,
            slice.batchId,
            slice.qty,
            slice.unitCostSen,
            slice.totalCostSen,
            jcId,
            `Issued for ${po.poNo} ${jc.departmentCode}/${jc.wipType ?? "?"} (${line.name})`,
          ),
      );
      materialCostSen += slice.totalCostSen;
    }

    if (result.consumedQty > 0) {
      statements.push(
        db
          .prepare(
            "UPDATE raw_materials SET balanceQty = MAX(0, balanceQty - ?) WHERE id = ?",
          )
          .bind(result.consumedQty, rm.id),
      );
      linesConsumed++;
    }

    if (result.shortageQty > 0) {
      shortages.push({ materialName: line.name, shortageQty: result.shortageQty });
    }
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }

  return { skipped: false, materialCostSen, linesConsumed, shortages };
}

// ---------------------------------------------------------------------------
// F1 — RM consumption (FIFO) on PO completion.
//
// LEGACY: as of 2026-05-07, RM consumption moved to the FAB_CUT JC
// completion event (consumeRawMaterialsForJC). This PO-wide path stays
// only for backwards compat — products without a FAB_CUT JC in their BOM
// (legacy / accessory) still need a fallback. Idempotency is preserved
// at refType='PRODUCTION_ORDER'; new code paths should call
// consumeRawMaterialsForJC instead.
// ---------------------------------------------------------------------------
export async function consumeRawMaterialsForPO(
  db: D1Database,
  poId: string,
): Promise<{
  skipped: boolean;
  materialCostSen: number;
  linesConsumed: number;
  shortages: { materialName: string; shortageQty: number }[];
}> {
  // Idempotency — already consumed?
  const existing = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM cost_ledger WHERE refType = 'PRODUCTION_ORDER' AND refId = ? AND type = 'RM_ISSUE'",
    )
    .bind(poId)
    .first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) {
    return { skipped: true, materialCostSen: 0, linesConsumed: 0, shortages: [] };
  }

  const po = await db
    .prepare(
      `SELECT id, poNo, productId, productCode, quantity, completedDate,
              itemCategory, gapInches, divanHeightInches, legHeightInches,
              sizeCode, sizeLabel, fabricCode
         FROM production_orders WHERE id = ?`,
    )
    .bind(poId)
    .first<ProductionOrderRow>();
  if (!po || !po.quantity || po.quantity <= 0) {
    return { skipped: false, materialCostSen: 0, linesConsumed: 0, shortages: [] };
  }

  const bomLines = await resolveBomMaterials(db, po);
  if (bomLines.length === 0) {
    // No BOM → nothing to consume; also no FG materialCost.
    return { skipped: false, materialCostSen: 0, linesConsumed: 0, shortages: [] };
  }

  const dateIso = po.completedDate
    ? new Date(`${po.completedDate}T12:00:00`).toISOString()
    : new Date().toISOString();

  let materialCostSen = 0;
  let linesConsumed = 0;
  const shortages: { materialName: string; shortageQty: number }[] = [];
  const statements: D1PreparedStatement[] = [];

  for (const line of bomLines) {
    const required =
      line.qtyPerUnit *
      po.quantity *
      (1 + Math.max(0, line.wastePct || 0) / 100);
    if (required <= 0) continue;

    const rm = await resolveRmFromBom(db, line);
    if (!rm) {
      shortages.push({ materialName: line.name, shortageQty: required });
      continue;
    }

    const batchesRes = await db
      .prepare(
        "SELECT id, rmId, source, sourceRefId, receivedDate, originalQty, remainingQty, unitCostSen, created_at, notes FROM rm_batches WHERE rmId = ? AND remainingQty > 0 ORDER BY receivedDate ASC, id ASC",
      )
      .bind(rm.id)
      .all<RMBatchRow>();
    const rows = batchesRes.results ?? [];

    // Map RMBatchRow → RMBatch (in-memory shape) for fifoConsume().
    const batches: RMBatch[] = rows.map((b) => ({
      id: b.id,
      rmId: b.rmId,
      source: b.source as RMBatch["source"],
      sourceRefId: b.sourceRefId ?? undefined,
      receivedDate: b.receivedDate,
      originalQty: b.originalQty,
      remainingQty: b.remainingQty,
      unitCostSen: b.unitCostSen,
      createdAt: b.created_at ?? "",
      notes: b.notes ?? undefined,
    }));

    const result = fifoConsume(batches, required);

    for (const slice of result.slices) {
      statements.push(
        db
          .prepare(
            "UPDATE rm_batches SET remainingQty = remainingQty - ? WHERE id = ?",
          )
          .bind(slice.qty, slice.batchId),
        db
          .prepare(
            `INSERT INTO cost_ledger
               (id, date, type, itemType, itemId, batchId, qty, direction,
                unitCostSen, totalCostSen, refType, refId, notes)
             VALUES (?, ?, 'RM_ISSUE', 'RM', ?, ?, ?, 'OUT', ?, ?, 'PRODUCTION_ORDER', ?, ?)`,
          )
          .bind(
            genLedgerId("rmi"),
            dateIso,
            rm.id,
            slice.batchId,
            slice.qty,
            slice.unitCostSen,
            slice.totalCostSen,
            poId,
            `Issued for ${po.poNo} (${line.name})`,
          ),
      );
      materialCostSen += slice.totalCostSen;
    }

    if (result.consumedQty > 0) {
      statements.push(
        db
          .prepare(
            "UPDATE raw_materials SET balanceQty = MAX(0, balanceQty - ?) WHERE id = ?",
          )
          .bind(result.consumedQty, rm.id),
      );
      linesConsumed++;
    }

    if (result.shortageQty > 0) {
      shortages.push({ materialName: line.name, shortageQty: result.shortageQty });
    }
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }

  return { skipped: false, materialCostSen, linesConsumed, shortages };
}

// ---------------------------------------------------------------------------
// F2 — Labor posting for a single job card on COMPLETED transition.
// Called from production-orders.ts whenever a job_card status moves to
// COMPLETED or TRANSFERRED. Idempotent per jobCardId.
//
// Multi-PIC split: a single JC can have up to 2 PICs per piece (see
// piece_pics table), and a multi-piece JC may have different workers on
// different pieces. We collect every DISTINCT worker id who appears in
// ANY pic1Id or pic2Id slot for this JC, then split the JC's production
// minutes evenly across them — one cost_ledger row per worker.
//
// If no workers are attributed (no piece_pics rows, or all slots null),
// fall back to a single un-attributed LABOR_POSTED row so the FG-batch
// cost rollup stays correct.
// ---------------------------------------------------------------------------
export async function postJobCardLabor(
  db: D1Database,
  jobCardId: string,
  productionOrderId: string,
): Promise<{
  skipped: boolean;
  laborSen: number;
  minutes: number;
  workerCount: number;
}> {
  // Idempotency — already posted for this job card? Check covers BOTH
  // legacy single-row and new multi-row shapes: any LABOR_POSTED ledger
  // entry with refType='JOB_CARD' AND refId=jcId means we've run.
  const existing = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM cost_ledger WHERE type = 'LABOR_POSTED' AND refType = 'JOB_CARD' AND refId = ?",
    )
    .bind(jobCardId)
    .first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) {
    return { skipped: true, laborSen: 0, minutes: 0, workerCount: 0 };
  }

  const jc = await db
    .prepare(
      "SELECT id, productionOrderId, departmentCode, status, completedDate, estMinutes, actualMinutes, productionTimeMinutes FROM job_cards WHERE id = ?",
    )
    .bind(jobCardId)
    .first<{
      id: string;
      productionOrderId: string;
      departmentCode: string | null;
      status: string;
      completedDate: string | null;
      estMinutes: number;
      actualMinutes: number | null;
      productionTimeMinutes: number;
    }>();
  if (!jc) return { skipped: false, laborSen: 0, minutes: 0, workerCount: 0 };

  // Prefer actualMinutes if recorded, else fall back to standard/estimate.
  const minutes =
    (jc.actualMinutes && jc.actualMinutes > 0
      ? jc.actualMinutes
      : jc.productionTimeMinutes || jc.estMinutes) || 0;
  if (minutes <= 0) {
    return { skipped: false, laborSen: 0, minutes: 0, workerCount: 0 };
  }

  // TODO(labor-rate): once departments.laborRatePerMinSen lands, prefer it
  // over the global floating rate. Today we use the calendar-aware default.
  const dateIso = jc.completedDate
    ? new Date(`${jc.completedDate}T12:00:00`).toISOString()
    : new Date().toISOString();
  const ratePerMin = laborRateForDate(dateIso);

  // Collect distinct worker ids from piece_pics for this JC.
  const picsRes = await db
    .prepare(
      "SELECT pic1Id, pic2Id FROM piece_pics WHERE jobCardId = ?",
    )
    .bind(jobCardId)
    .all<{ pic1Id: string | null; pic2Id: string | null }>();
  const picRows = picsRes.results ?? [];
  const distinctWorkers = new Set<string>();
  for (const row of picRows) {
    if (row.pic1Id) distinctWorkers.add(row.pic1Id);
    if (row.pic2Id) distinctWorkers.add(row.pic2Id);
  }

  // No attributed workers → single un-attributed LABOR_POSTED row so the
  // FG rollup still captures the labor cost.
  if (distinctWorkers.size === 0) {
    const laborSen = Math.round(ratePerMin * minutes);
    if (laborSen <= 0) {
      return { skipped: false, laborSen: 0, minutes, workerCount: 0 };
    }
    await db
      .prepare(
        `INSERT INTO cost_ledger
           (id, date, type, itemType, itemId, batchId, qty, direction,
            unitCostSen, totalCostSen, refType, refId, notes, workerId)
         VALUES (?, ?, 'LABOR_POSTED', 'WIP', ?, NULL, ?, 'IN', ?, ?, 'JOB_CARD', ?, ?, NULL)`,
      )
      .bind(
        genLedgerId("lab"),
        dateIso,
        productionOrderId,
        minutes,
        Math.round(ratePerMin),
        laborSen,
        jobCardId,
        `Labor posted for ${jc.departmentCode ?? "?"} (${minutes} min) — no worker attributed`,
      )
      .run();
    return { skipped: false, laborSen, minutes, workerCount: 0 };
  }

  // Split minutes evenly across distinct workers (round half-up).
  const n = distinctWorkers.size;
  const perWorkerMinutes = Math.round((minutes / n) * 10) / 10; // 1 dp
  const statements: D1PreparedStatement[] = [];
  let totalLaborSen = 0;
  for (const wid of distinctWorkers) {
    const workerSen = Math.round(ratePerMin * perWorkerMinutes);
    totalLaborSen += workerSen;
    if (workerSen <= 0) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO cost_ledger
             (id, date, type, itemType, itemId, batchId, qty, direction,
              unitCostSen, totalCostSen, refType, refId, notes, workerId)
           VALUES (?, ?, 'LABOR_POSTED', 'WIP', ?, NULL, ?, 'IN', ?, ?, 'JOB_CARD', ?, ?, ?)`,
        )
        .bind(
          genLedgerId("lab"),
          dateIso,
          productionOrderId,
          perWorkerMinutes,
          Math.round(ratePerMin),
          workerSen,
          jobCardId,
          `Labor posted for ${jc.departmentCode ?? "?"} — PIC share 1/${n} (${perWorkerMinutes} min)`,
          wid,
        ),
    );
  }
  if (statements.length > 0) {
    await db.batch(statements);
  }

  return { skipped: false, laborSen: totalLaborSen, minutes, workerCount: n };
}

// ---------------------------------------------------------------------------
// F3 — FG batch cost backfill. Run AFTER consumeRawMaterialsForPO() and all
// relevant postJobCardLabor() calls have landed (so the ledger rollup is
// complete). Idempotent via FG_COMPLETED ledger entry check.
// ---------------------------------------------------------------------------
export async function backfillFGBatchCost(
  db: D1Database,
  poId: string,
): Promise<{
  skipped: boolean;
  materialCostSen: number;
  laborCostSen: number;
  totalCostSen: number;
  unitCostSen: number;
}> {
  // Idempotency — already emitted FG_COMPLETED for this PO?
  const fgExisting = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM cost_ledger WHERE type = 'FG_COMPLETED' AND refType = 'PRODUCTION_ORDER' AND refId = ?",
    )
    .bind(poId)
    .first<{ n: number }>();
  if ((fgExisting?.n ?? 0) > 0) {
    return {
      skipped: true,
      materialCostSen: 0,
      laborCostSen: 0,
      totalCostSen: 0,
      unitCostSen: 0,
    };
  }

  const batch = await db
    .prepare(
      "SELECT id, productId, productionOrderId, originalQty, completedDate FROM fg_batches WHERE productionOrderId = ? LIMIT 1",
    )
    .bind(poId)
    .first<{
      id: string;
      productId: string;
      productionOrderId: string;
      originalQty: number;
      completedDate: string;
    }>();
  if (!batch || !batch.originalQty || batch.originalQty <= 0) {
    return {
      skipped: false,
      materialCostSen: 0,
      laborCostSen: 0,
      totalCostSen: 0,
      unitCostSen: 0,
    };
  }

  // Sum RM_ISSUE rows across BOTH refType paths:
  //   - refType='PRODUCTION_ORDER' → legacy F1 path (PO-wide consume)
  //   - refType='JOB_CARD'         → new F1-JC path (consume at FAB_CUT
  //                                  JC completion, post 2026-05-07)
  // A single PO will have rows from one path or the other, not both, but
  // the union query handles legacy + new uniformly.
  const matSum = await db
    .prepare(
      `SELECT COALESCE(SUM(totalCostSen),0) AS s FROM cost_ledger
         WHERE type = 'RM_ISSUE'
           AND ((refType = 'PRODUCTION_ORDER' AND refId = ?)
                OR (refType = 'JOB_CARD'
                    AND refId IN (SELECT id FROM job_cards WHERE productionOrderId = ?)))`,
    )
    .bind(poId, poId)
    .first<{ s: number }>();
  const materialCostSen = matSum?.s ?? 0;

  // Labor entries are refType='JOB_CARD'. Join via job_cards.productionOrderId.
  const labSum = await db
    .prepare(
      `SELECT COALESCE(SUM(cl.totalCostSen),0) AS s
         FROM cost_ledger cl
         INNER JOIN job_cards jc ON jc.id = cl.refId
         WHERE cl.type = 'LABOR_POSTED'
           AND cl.refType = 'JOB_CARD'
           AND jc.productionOrderId = ?`,
    )
    .bind(poId)
    .first<{ s: number }>();
  const laborCostSen = labSum?.s ?? 0;

  const totalCostSen = materialCostSen + laborCostSen;
  const unitCostSen =
    batch.originalQty > 0 ? Math.floor(totalCostSen / batch.originalQty) : 0;

  const dateIso = batch.completedDate
    ? new Date(`${batch.completedDate}T12:00:00`).toISOString()
    : new Date().toISOString();

  await db.batch([
    db
      .prepare(
        "UPDATE fg_batches SET unitCostSen = ?, materialCostSen = ?, laborCostSen = ?, overheadCostSen = 0 WHERE id = ?",
      )
      .bind(unitCostSen, materialCostSen, laborCostSen, batch.id),
    db
      .prepare(
        `INSERT INTO cost_ledger
           (id, date, type, itemType, itemId, batchId, qty, direction,
            unitCostSen, totalCostSen, refType, refId, notes)
         VALUES (?, ?, 'FG_COMPLETED', 'FG', ?, ?, ?, 'IN', ?, ?, 'PRODUCTION_ORDER', ?, ?)`,
      )
      .bind(
        genLedgerId("fgc"),
        dateIso,
        batch.productId,
        batch.id,
        batch.originalQty,
        unitCostSen,
        totalCostSen,
        poId,
        `FG completion for PO ${poId}`,
      ),
  ]);

  return {
    skipped: false,
    materialCostSen,
    laborCostSen,
    totalCostSen,
    unitCostSen,
  };
}

// ---------------------------------------------------------------------------
// F4 — Light WIP completion marker. Real WIP inventory deducts / layer
// creation is a bigger project — for now we emit a single WIP_COMPLETED
// ledger entry so month-end views can see something happened. Full
// tracking is TODO(wip-phase-2).
//
// Idempotency: checks for WIP_COMPLETED OR legacy ADJUSTMENT rows with a
// "WIP_COMPLETED" notes prefix (pre-migration-0011 shape).
// ---------------------------------------------------------------------------
export async function postWIPCompletionMarker(
  db: D1Database,
  poId: string,
  fgQty: number,
): Promise<{ skipped: boolean }> {
  if (fgQty <= 0) return { skipped: true };

  const existing = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM cost_ledger
         WHERE refType = 'PRODUCTION_ORDER' AND refId = ?
           AND (
             type = 'WIP_COMPLETED'
             OR (type = 'ADJUSTMENT' AND notes LIKE 'WIP_COMPLETED%')
           )`,
    )
    .bind(poId)
    .first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) {
    return { skipped: true };
  }

  // TODO(wip-phase-2): Walk the BOM tree, compute WIP layer qtys + cost
  // splits, insert wip_items / wip_layers rows, and emit one ledger entry
  // per WIP node. For now just a single summary marker so we don't pretend
  // WIP inventory is tracked.
  await db
    .prepare(
      `INSERT INTO cost_ledger
         (id, date, type, itemType, itemId, batchId, qty, direction,
          unitCostSen, totalCostSen, refType, refId, notes)
       VALUES (?, ?, 'WIP_COMPLETED', 'WIP', ?, NULL, ?, 'IN', 0, 0, 'PRODUCTION_ORDER', ?, ?)`,
    )
    .bind(
      genLedgerId("wip"),
      new Date().toISOString(),
      poId,
      fgQty,
      poId,
      `WIP_COMPLETED — ${fgQty} FG from PO ${poId}. TODO(wip-phase-2): full WIP layer tracking.`,
    )
    .run();

  return { skipped: false };
}
