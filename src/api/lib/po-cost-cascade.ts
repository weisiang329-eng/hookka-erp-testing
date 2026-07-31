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
//         LABOR_POSTED cost_ledger entry. The JC's production minutes are
//         costed at each attributed worker's own production-cost rate
//         (basic salary ÷ holiday-adjusted working days ÷ hours/day ÷ 60)
//         via the shared labor engine.
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
import { fifoConsume } from "../../lib/costing";
import {
  productionCostRatePerMinuteSen,
  costingWorkerOrDefault,
} from "../../lib/labor-engine";
import type { RMBatch } from "../../types";
import {
  expandMaterialQty,
  parseMaterialScaling,
  parseSofaSeatHeightInches,
  type ProductionDimensions,
} from "./material-scaling";
import {
  parseRepairScope,
  materialLineInScope,
  repairComponentScale,
} from "../../lib/repair-scope";
import { deriveTopLevelWipKey } from "./bom-wip-breakdown";
import { explodeKits } from "./component-bom";

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
  // Repair Scope snapshot stamped at PO creation (0160). Runtime-added
  // column → SELECT * returns the folded-lowercase key
  // (BUG-2026-06-11-007); read dual-key.
  repairScope?: string | null;
  repairscope?: string | null;
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
  // FILLER (sponge) area-based consumption (owner 2026-07-30). When a BOM
  // material line carries a cut size (inches), the resolved RM's sheet size
  // converts qtyPerUnit (cut-piece count) into a FRACTION of a sheet:
  //   sheets consumed = qtyPerUnit × (cutL×cutW) ÷ (sheetL×sheetW).
  // Thickness cancels (the piece is cut the full thickness of the sheet), so
  // area is enough. No cut size → consumes by qtyPerUnit as before.
  cutLengthIn?: number;
  cutWidthIn?: number;
  // When set, this BOM line is bound to a per-SO field rather than a
  // fixed inventory item. resolveBomMaterials substitutes inventoryCode
  // with the PO's snapshotted SO value before FIFO lookup runs:
  //   "FABRIC" → po.fabricCode (raw_materials.itemCode === fabricCode)
  //   "LEG"    → no current schema mapping → falls through to shortage
  //              report with the original "Leg (from order)" name.
  autoDetect?: "FABRIC" | "LEG";
  // deptCodes of the BOM node that OWNS this material line (the node whose
  // materials[] array carried it). Captured by collectTreeMaterials for
  // the Repair-Scope CUSTOM branch rule: a material is consumed only when
  // its owning node has at least one process in the chosen depts. Live
  // BOM audit 2026-06-11: every material-carrying node also carries its
  // own processes (399/399), so this is reliably populated for tree-based
  // BOMs; the flat bom_components fallback has no process info and leaves
  // it undefined.
  ownerDeptCodes?: string[];
  // Component-level Repair Scope: the TOP-LEVEL BOM WIP this line's owning
  // node descends from. ownerWipKey is derived with the SAME
  // deriveTopLevelWipKey helper breakBomIntoWips uses for job-card wipKeys
  // (single source of truth), so a picked component matches its material
  // lines exactly. ownerWipQty = that top-level node's per-FG piece count
  // (the bound a pick's qty is clamped to → scale = picked/bomQty). Only
  // the bom_templates.wipComponents walk can derive these — the legacy
  // bom_versions.tree single-root shape and the flat bom_components
  // fallback leave them undefined, and a component-scoped repair DROPS
  // such lines (never over-consume on a partial repair).
  ownerWipKey?: string;
  ownerWipQty?: number;
};

// Walk a BOM tree JSON node and gather every `materials[]` entry across all
// nested levels. The tree is the JSON stored in bom_versions.tree (legacy)
// or bom_templates.wipComponents (current source of truth, post-2026-05-07).
//
// Material qty semantics (BOM author convention):
//   - `material.qty` is PER PIECE OF THIS WIP (e.g. divan FC qty=3.25 means
//     3.25m fabric per individual divan piece).
//   - The parent WIP node's `quantity` field is the piece count produced
//     per finished good (2 for K/Q divans, 1 for headboards).
//   - Total per FG = (scaled material.qty) × (parent node quantity).
//
// Order: scale FIRST (perUnit slope is per-piece), then multiply by
// piece count. Scaling rules are authored per piece (base 8" divan,
// +0.4 m/inch); multiplying first would double the slope.
//
// Output `qtyPerUnit` is the per-FG-unit qty. Downstream multiplication
// by `po.quantity` (FG count) and `(1 + wastePct/100)` stays unchanged.
function collectTreeMaterials(
  node: unknown,
  out: MaterialLine[],
  dims: ProductionDimensions,
  // Top-level WIP owner tag (Component-level Repair Scope). Passed once by
  // the wipComponents walk for each root node and inherited UNCHANGED by
  // every descendant — a material anywhere in the Divan subtree belongs to
  // the Divan component. undefined for tree shapes that can't derive a
  // component key (legacy bom_versions.tree); such lines drop under a
  // component-scoped repair.
  owner?: { wipKey: string; wipQty: number },
): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  // Parent node's piece count. Defaults to 1 when missing / non-positive
  // — matches the prior behavior where the multiplier was implicitly 1.
  const rawNodeQty = n.quantity;
  const parsedNodeQty =
    typeof rawNodeQty === "number" ? rawNodeQty : Number(rawNodeQty);
  const nodeQuantity =
    Number.isFinite(parsedNodeQty) && parsedNodeQty > 0 ? parsedNodeQty : 1;
  // Owning node's dept set — drives the Repair-Scope CUSTOM branch rule.
  const nodeProcs = Array.isArray(n.processes) ? n.processes : [];
  const ownerDeptCodes = nodeProcs
    .map((p) =>
      p && typeof p === "object"
        ? String((p as { deptCode?: unknown }).deptCode ?? "").toUpperCase()
        : "",
    )
    .filter((d) => d.length > 0);
  const mats = n.materials;
  if (Array.isArray(mats)) {
    for (const m of mats) {
      if (!m || typeof m !== "object") continue;
      const row = m as Record<string, unknown>;
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
      // FILLER (sponge) cut size, if the BOM author entered one (inches). Read
      // dual-keyed so both camelCase (editor) and snake_case survive.
      const cutLenRaw = (row.cutLengthIn ?? row.cut_length_in) as unknown;
      const cutWidRaw = (row.cutWidthIn ?? row.cut_width_in) as unknown;
      const cutLengthIn = Number(cutLenRaw) > 0 ? Number(cutLenRaw) : undefined;
      const cutWidthIn = Number(cutWidRaw) > 0 ? Number(cutWidRaw) : undefined;
      // autoDetect lines may have empty code/name at authoring time — keep
      // them so the substitution step downstream can resolve them. The
      // (code || name) guard would otherwise drop them silently.
      if (perFgQty > 0 && (code || name || autoDetect)) {
        out.push({
          code: code || name,
          name: name || (autoDetect === "FABRIC" ? "Fabric (from order)" : autoDetect === "LEG" ? "Leg (from order)" : ""),
          qtyPerUnit: perFgQty,
          wastePct: waste,
          inventoryCode,
          autoDetect,
          cutLengthIn,
          cutWidthIn,
          ownerDeptCodes,
          ownerWipKey: owner?.wipKey,
          ownerWipQty: owner?.wipQty,
        });
      }
    }
  }
  const kids = n.children;
  if (Array.isArray(kids)) {
    for (const child of kids) {
      collectTreeMaterials(child, out, dims, owner);
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
// Resolve the BOM material lines for a PO, THEN explode any reusable kit
// sub-BOMs (a mechanism / leg SKU that drags in its required screws — owner
// 2026-07-31). Explosion runs on the FINAL resolved lines so a mechanism bound
// via autoDetect=LEG also pulls its screws. Every consumer (consumption,
// costing, shortage report) goes through here, so the kit is intrinsic to the
// BOM everywhere. See component-bom.ts.
async function resolveBomMaterials(
  db: D1Database,
  po: ProductionOrderRow,
): Promise<MaterialLine[]> {
  const lines = await resolveBomMaterialsRaw(db, po);
  return explodeKits(db, lines);
}

async function resolveBomMaterialsRaw(
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
        const isWipArray = Array.isArray(parsed);
        const roots = isWipArray ? parsed : [parsed];
        const acc: MaterialLine[] = [];
        for (let rootIdx = 0; rootIdx < roots.length; rootIdx++) {
          const root = roots[rootIdx];
          // Component-level Repair Scope: tag every material in this root's
          // subtree with the top-level WIP's key + per-FG piece count. The
          // key is derived with deriveTopLevelWipKey — the EXACT formula
          // breakBomIntoWips stamps on this product's job cards / serves to
          // the repair-components picker — so picked components and material
          // lines match by string equality. Derivable only for the real
          // wipComponents array shape (mirrors breakBomIntoWips, which
          // treats a non-array as the FG_MAIN fallback); otherwise leave
          // the lines untagged → dropped under a component scope.
          const rootQtyRaw =
            root && typeof root === "object"
              ? Number((root as Record<string, unknown>).quantity)
              : NaN;
          const owner = isWipArray
            ? {
                wipKey: deriveTopLevelWipKey(
                  po.productCode ?? "",
                  rootIdx,
                  root as { wipType?: unknown; wipCode?: unknown } | null,
                ),
                wipQty:
                  Number.isFinite(rootQtyRaw) && rootQtyRaw > 0
                    ? rootQtyRaw
                    : 1,
              }
            : undefined;
          collectTreeMaterials(root, acc, dims, owner);
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

// Parse the leading inch value from a leg-height option label.
//   `6"` → 6,  `7"` → 7,  `4.5"` → 4.5,  "No Leg" → null.
// Tolerates surrounding spaces and a missing inch mark.
function parseLegInches(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = value.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Resolve the raw_materials.itemCode a leg-height is EXPLICITLY bound to in the
// Maintenance → Leg Heights catalog. Owner 2026-07-30: each leg-height option
// in kv_config['variants-config'].legHeights / .sofaLegHeights can carry a
// `legSku` (the exact leg's internal code). When present it is authoritative —
// the shop binds e.g. "脚 6寸" → its precise SKU so consumption never guesses.
//
// SOFA orders consult sofaLegHeights first; everything else (bedframe) consults
// legHeights first; the other list is a fallback for shops keeping one shared
// catalog. Match is by the numeric inch value parsed from the option's `value`
// label (`6"` → 6) against po.legHeightInches. Returns null when no binding
// exists → the caller then falls back to the legacy fuzzy description match.
async function resolveBoundLegSku(
  db: D1Database,
  itemCategory: string | null,
  legHeightInches: number,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("variants-config")
    .first<{ value: string }>();
  if (!row?.value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const cfg = parsed as { legHeights?: unknown; sofaLegHeights?: unknown };
  const isSofa = (itemCategory ?? "").toUpperCase() === "SOFA";
  const primary = isSofa ? cfg.sofaLegHeights : cfg.legHeights;
  const secondary = isSofa ? cfg.legHeights : cfg.sofaLegHeights;
  const fromList = (list: unknown): string | null => {
    if (!Array.isArray(list)) return null;
    for (const o of list) {
      if (!o || typeof o !== "object") continue;
      const opt = o as { value?: unknown; legSku?: unknown };
      const inches = parseLegInches(opt.value);
      if (inches != null && inches === legHeightInches) {
        const sku = typeof opt.legSku === "string" ? opt.legSku.trim() : "";
        return sku.length > 0 ? sku : null;
      }
    }
    return null;
  };
  return fromList(primary) ?? fromList(secondary);
}

// Bind autoDetect lines to a concrete inventory key from the PO snapshot.
//   FABRIC: po.fabricCode IS raw_materials.itemCode for the SO's chosen
//           fabric — set inventoryCode and let the normal lookup chain run.
//   LEG:    SO line carries legHeightInches. Resolution order:
//           1. EXPLICIT binding — the leg-height's `legSku` from the
//              Maintenance Leg Heights catalog (resolveBoundLegSku). Owner's
//              chosen source of truth; wins whenever set.
//           2. Legacy fuzzy fallback — the shop names leg inventory with the
//              inch height inline (e.g. `SOFA LEG PLASTIC (ROUND) 2"`); match
//              raw_materials.description LIKE `%<N>"%` AND `%LEG%`,
//              case-insensitive, first by itemCode ASC.
//           Both miss → falls through, caller records a shortage with the
//           original "Leg (from order)" name. Quantity always stays the BOM
//           line's qty (the binding only decides WHICH SKU, not how many).
// Lines without an autoDetect tag are passed through unchanged.
async function substituteAutoDetectMaterials(
  db: D1Database,
  lines: MaterialLine[],
  po: ProductionOrderRow,
): Promise<MaterialLine[]> {
  // Resolve the explicit leg SKU binding ONCE — po is fixed, and a BOM can
  // carry more than one LEG line (nested WIPs), so we avoid re-reading
  // kv_config per line.
  const boundLegSku =
    po.legHeightInches != null && po.legHeightInches > 0
      ? await resolveBoundLegSku(db, po.itemCategory, po.legHeightInches)
      : null;

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
      // 1) Explicit Maintenance binding wins.
      if (boundLegSku) {
        out.push({ ...line, inventoryCode: boundLegSku, code: boundLegSku });
        continue;
      }
      // 2) Legacy fuzzy fallback — description contains the inch height + LEG.
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
// itemGroup rides along for the Repair-Scope material-class filter
// (fabric / wood / foam — see src/lib/repair-scope.ts). It is a
// rename-map-known identifier, so the adapter translates it in the
// explicit projection (unlike the BUG-2026-06-10-001 runtime-column case).
type ResolvedRm = {
  id: string;
  itemCode: string;
  description: string;
  itemGroup: string | null;
  // Sheet dims for FILLER area-based consumption (owner 2026-07-30). Read
  // dual-keyed off SELECT * — the columns are runtime-added and may be absent
  // on a fresh DB, so we must NOT name them in the SELECT (that would throw).
  sheetLengthIn: number | null;
  sheetWidthIn: number | null;
};
function toResolvedRm(row: Record<string, unknown> | null): ResolvedRm | null {
  if (!row) return null;
  const sl = (row.sheet_length_in ?? row.sheetLengthIn) as number | null | undefined;
  const sw = (row.sheet_width_in ?? row.sheetWidthIn) as number | null | undefined;
  return {
    id: String(row.id ?? ""),
    itemCode: String(row.itemCode ?? ""),
    description: String(row.description ?? ""),
    itemGroup: (row.itemGroup ?? null) as string | null,
    sheetLengthIn: sl != null ? Number(sl) : null,
    sheetWidthIn: sw != null ? Number(sw) : null,
  };
}
async function resolveRmFromBom(
  db: D1Database,
  line: MaterialLine,
): Promise<ResolvedRm | null> {
  if (line.inventoryCode) {
    const hit = await db
      .prepare("SELECT * FROM raw_materials WHERE itemCode = ? LIMIT 1")
      .bind(line.inventoryCode)
      .first<Record<string, unknown>>();
    if (hit) return toResolvedRm(hit);
  }
  if (line.code) {
    const hit = await db
      .prepare("SELECT * FROM raw_materials WHERE itemCode = ? LIMIT 1")
      .bind(line.code)
      .first<Record<string, unknown>>();
    if (hit) return toResolvedRm(hit);
  }
  if (line.name) {
    const hit = await db
      .prepare("SELECT * FROM raw_materials WHERE description = ? COLLATE NOCASE LIMIT 1")
      .bind(line.name)
      .first<Record<string, unknown>>();
    if (hit) return toResolvedRm(hit);
  }
  return null;
}

function genLedgerId(prefix: string): string {
  return `cl-${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// F1 — RM consumption (FIFO).
//
// Architecture (2026-05-07): keyed on PRODUCT CODE → BOM template →
// material list. The trigger event moved from PO completion to FAB_CUT
// JC completion (matches physical reality — meters leave the roll when
// cutting happens, not weeks later when the whole PO finishes), but the
// underlying logic stays product-code-centric. We don't try to subdivide
// by JC structure (merged vs split FAB_CUT JCs); the BOM is the source
// of truth for what gets consumed per FG, and idempotency on
// refType='PRODUCTION_ORDER' ensures a PO only consumes once even when
// multiple FAB_CUT JCs in the same PO sequentially complete.
// ---------------------------------------------------------------------------
// Category default sheet size for FILLER area-based consumption. Owner
// 2026-07-30: default 96×48 inch (= an 8ft×4ft sheet), overridable. A FILLER material with no per-SKU
// sheet size falls back to its item-group default from
// kv_config['variants-config'].sheetDefaults, then to a hardcoded 8×4 for any
// FILLER group. Units don't matter to the ratio (cutArea ÷ sheetArea) as long
// as the BOM cut size uses the same unit as the sheet.
const HARDCODED_FILLER_SHEET = { length: 96, width: 48 };
async function loadSheetDefaults(
  db: D1Database,
): Promise<Record<string, { length: number; width: number }>> {
  const out: Record<string, { length: number; width: number }> = {};
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind("variants-config")
      .first<{ value: string }>();
    if (row?.value) {
      const parsed = JSON.parse(row.value) as {
        sheetDefaults?: Record<string, { length?: unknown; width?: unknown }>;
      };
      const sd = parsed?.sheetDefaults;
      if (sd && typeof sd === "object") {
        for (const [k, v] of Object.entries(sd)) {
          const l = Number((v as { length?: unknown }).length);
          const w = Number((v as { width?: unknown }).width);
          if (l > 0 && w > 0) out[k.toUpperCase()] = { length: l, width: w };
        }
      }
    }
  } catch {
    /* fall through to the hardcoded FILLER default */
  }
  return out;
}
function categoryDefaultSheet(
  itemGroup: string | null,
  defaults: Record<string, { length: number; width: number }>,
): { length: number; width: number } | null {
  const g = (itemGroup ?? "").toUpperCase();
  if (defaults[g]) return defaults[g];
  if (/FILLER/.test(g)) return HARDCODED_FILLER_SHEET;
  return null;
}

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

  // SELECT * (not an explicit projection) — the Repair-Scope column is
  // runtime-added so an unquoted camelCase projection entry would be the
  // BUG-2026-06-10-001 trap; SELECT * returns it under the folded key
  // (`repairscope`), read dual-key below.
  const po = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
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

  // FILLER sheet-size defaults, loaded once (config overrides, else 8×4).
  const sheetDefaults = await loadSheetDefaults(db);

  // ---- Repair Scope material filter (0160) -------------------------------
  // A scoped (non-FULL) repair must NEVER consume the full BOM. The scope
  // was stamped onto the PO at creation (production-builder), so it always
  // matches the job cards that were actually built. Per-line rule (see
  // materialLineInScope in src/lib/repair-scope.ts):
  //   FABRIC preset → fabric-class lines only (autoDetect:"FABRIC" or
  //       raw_materials.itemGroup in the fabric groups);
  //   FRAME → wood-class only (PLYWOOD / WD STRIP);
  //   FOAM  → foam-class only (B.FILLER / S.FILLER);
  //   CUSTOM → branch-based: the line's owning BOM node must have at least
  //       one process in the chosen depts.
  // Component-level picks (scope.components) apply ON TOP of the dept/class
  // rule: a line is consumable only when its owning top-level WIP was
  // picked, and its quantity scales by pickedQty/bomQty for partial picks —
  // see repairComponentScale in the loop below.
  // Out-of-scope lines are skipped BEFORE any FIFO consumption — no
  // rm_batches decrement, no RM_ISSUE ledger row, and no shortage report
  // (the material simply isn't part of this repair).
  const repairScope = parseRepairScope(po.repairScope ?? po.repairscope);

  const dateIso = po.completedDate
    ? new Date(`${po.completedDate}T12:00:00`).toISOString()
    : new Date().toISOString();

  let materialCostSen = 0;
  let linesConsumed = 0;
  const shortages: { materialName: string; shortageQty: number }[] = [];
  const statements: D1PreparedStatement[] = [];

  for (const line of bomLines) {
    // Component-level Repair Scope gate + quantity scale (on top of the
    // dept/class filter below — both must pass). repairComponentScale:
    //   1        → no component picks on the scope, or this line's owning
    //              component is picked at full BOM qty (multiply-by-1 keeps
    //              every non-component path byte-identical);
    //   fraction → partial pick — picked 1 of the 2 divan pieces consumes
    //              half the line's per-FG quantity (pickedQty / bomQty);
    //   null     → DROP: the owning component wasn't picked, or the line
    //              has no derivable owner (legacy bom_versions.tree / flat
    //              bom_components shapes) — never over-consume on a
    //              partial repair. No FIFO walk, no shortage report.
    const componentScale = repairScope
      ? repairComponentScale(line, repairScope)
      : 1;
    if (componentScale === null) continue;
    let required =
      line.qtyPerUnit *
      po.quantity *
      (1 + Math.max(0, line.wastePct || 0) / 100) *
      componentScale;
    if (required <= 0) continue;

    const rm = await resolveRmFromBom(db, line);

    // FILLER (sponge) area-based consumption (owner 2026-07-30): a BOM line
    // with a cut size (inches) consumes a FRACTION of a sheet, not whole
    // pieces — sheets = (cut area ÷ sheet area) × qty. Applied only when BOTH
    // the line's cut size and the resolved RM's sheet size are present; any
    // gap falls back to the plain qtyPerUnit path (no regression). Guard
    // against a zero/absent sheet area (would otherwise divide by zero).
    if (rm && line.cutLengthIn && line.cutWidthIn) {
      // Per-SKU sheet size wins; else the category default (config, else the
      // hardcoded FILLER 8×4). Only FILLER-group materials get a default.
      const catDef = categoryDefaultSheet(rm.itemGroup, sheetDefaults);
      const sheetL = rm.sheetLengthIn ?? catDef?.length ?? 0;
      const sheetW = rm.sheetWidthIn ?? catDef?.width ?? 0;
      const sheetArea = sheetL * sheetW;
      const cutArea = line.cutLengthIn * line.cutWidthIn;
      if (sheetArea > 0 && cutArea > 0) {
        required = required * (cutArea / sheetArea);
      }
    }
    if (required <= 0) continue;

    // Repair Scope: out-of-scope material → skip before any consumption.
    // Class lookup needs the resolved itemGroup, hence after resolveRmFromBom
    // but before the shortage report / FIFO walk. Unresolvable AND
    // unclassifiable lines drop too (never over-consume on a partial
    // repair); an in-scope-by-autoDetect line that fails to resolve still
    // falls through to the normal shortage report below.
    if (
      repairScope &&
      !materialLineInScope(line, rm?.itemGroup ?? null, repairScope)
    ) {
      continue;
    }

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

    // PR 0 (2026-05-20, owner-confirmed) — per-slice WHERE guard +
    // serial execution to prevent FIFO over-pull race.
    //
    // Old behaviour:
    //   1. Snapshot all batches with remainingQty > 0 (line 471-476)
    //   2. fifoConsume() picks slices against the JS snapshot
    //   3. Push UPDATE/INSERT pairs into one batch
    //   4. db.batch(statements) commits at the end
    //
    // The UPDATE was `SET remainingQty = remainingQty - ?` — atomic
    // arithmetic, so two concurrent decrements both land correctly on
    // remainingQty itself. But fifoConsume() ran against the SNAPSHOT,
    // so two parallel PO completions both think batch B has 10m
    // available, both pick a 5m slice, both push UPDATE -5, both push
    // INSERT cost_ledger {qty: 5}. End state: remainingQty=0 (correct
    // physical consumption) but cost_ledger has 2×5m=10m issued from
    // a batch that only had 10m physical — fine in this exact case,
    // but if either PO needed 8m, the math breaks: total issued
    // 8+8=16m against a 10m physical batch. raw_materials.balanceQty
    // would be floored by GREATEST(0,...) and silently under-deducted.
    //
    // New behaviour: run each slice as a single conditional UPDATE
    // (`AND remainingQty >= ?` guard) and inspect meta.changes. If
    // another writer has already drained the batch below what we
    // claimed, the UPDATE no-ops and we throw — the caller sees the
    // race and the PO completion fails atomically (no cost_ledger row
    // for the failed slice, raw_materials still consistent with
    // rm_batches). Operator retries; on retry the snapshot reflects
    // the post-race state and fifoConsume picks differently.
    //
    // Serial execution means the slices for THIS PO run one-at-a-time
    // before the function returns. For a typical PO with 2-3 RM lines
    // × 1-2 slices each, that's ~5 extra round-trips per completion.
    // Acceptable given the consequence (silent inventory corruption).
    for (const slice of result.slices) {
      const updateRes = await db
        .prepare(
          "UPDATE rm_batches SET remainingQty = remainingQty - ? WHERE id = ? AND remainingQty >= ?",
        )
        .bind(slice.qty, slice.batchId, slice.qty)
        .run();
      if (!updateRes.meta || updateRes.meta.changes === 0) {
        throw new Error(
          `RM batch ${slice.batchId} race lost: PO ${po.poNo} (${line.name}) tried to consume ${slice.qty} but another writer left less than that available. Retry the completion.`,
        );
      }
      await db
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
        )
        .run();
      materialCostSen += slice.totalCostSen;
    }

    if (result.consumedQty > 0) {
      statements.push(
        db
          .prepare(
            // GREATEST not MAX — Postgres MAX is an aggregate (over rows);
            // GREATEST returns the largest of N argument values and works
            // across numeric types (integer 0 vs balanceQty's numeric/float).
            // SQLite accepted MAX(a, b) as 2-arg max but Postgres errors
            // with "function max(integer, double precision) does not exist"
            // (caught 2026-05-07 when running first live RM consume).
            "UPDATE raw_materials SET balanceQty = GREATEST(0, balanceQty - ?) WHERE id = ?",
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
// Per-worker rate: each worker's minutes are costed at THEIR own
// production-cost rate — basic salary ÷ (working days − public holidays)
// ÷ hours/day ÷ 60 — via the shared labor engine. A worker with no salary
// set falls back to the default (RM 2050 / 9 h / 26 days).
//
// If no workers are attributed (no piece_pics rows, or all slots null),
// fall back to a single un-attributed LABOR_POSTED row at the default
// rate so the FG-batch cost rollup stays correct.
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

  const dateIso = jc.completedDate
    ? new Date(`${jc.completedDate}T12:00:00`).toISOString()
    : new Date().toISOString();
  const completionDate = new Date(dateIso);
  const rateYear = completionDate.getFullYear();
  const rateMonth = completionDate.getMonth() + 1;

  // Public holidays for the completion month — the production-cost rate
  // divides the monthly salary by (working days − public holidays), so a
  // holiday month costs each produced minute more.
  const phRow = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("public_holidays")
    .first<{ value: string | null }>();
  const publicHolidays = new Set<string>();
  if (phRow?.value) {
    try {
      const parsed = JSON.parse(phRow.value);
      if (Array.isArray(parsed)) {
        for (const d of parsed) {
          if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
            publicHolidays.add(d);
          }
        }
      }
    } catch {
      /* malformed payload — treat as no holidays */
    }
  }
  // Rate for un-attributed labor / a deleted or un-configured worker.
  const defaultRatePerMin = productionCostRatePerMinuteSen(
    costingWorkerOrDefault(undefined),
    rateYear,
    rateMonth,
    publicHolidays,
  );

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

  // No attributed workers → single un-attributed LABOR_POSTED row, at the
  // default rate, so the FG rollup still captures the labor cost.
  if (distinctWorkers.size === 0) {
    const laborSen = Math.round(defaultRatePerMin * minutes);
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
        Math.round(defaultRatePerMin),
        laborSen,
        jobCardId,
        `Labor posted for ${jc.departmentCode ?? "?"} (${minutes} min) — no worker attributed`,
      )
      .run();
    return { skipped: false, laborSen, minutes, workerCount: 0 };
  }

  // Per-worker rate — load each attributed worker's Employee Master
  // figures in one query and compute their own production-cost rate.
  const workerIds = [...distinctWorkers];
  const workerPlaceholders = workerIds.map(() => "?").join(", ");
  const workerRowsRes = await db
    .prepare(
      `SELECT id, basicSalarySen, workingHoursPerDay, workingDaysPerMonth FROM workers WHERE id IN (${workerPlaceholders})`,
    )
    .bind(...workerIds)
    .all<{
      id: string;
      basicSalarySen: number | null;
      workingHoursPerDay: number | null;
      workingDaysPerMonth: number | null;
    }>();
  const rateByWorker = new Map<string, number>();
  for (const w of workerRowsRes.results ?? []) {
    rateByWorker.set(
      w.id,
      productionCostRatePerMinuteSen(
        costingWorkerOrDefault(w),
        rateYear,
        rateMonth,
        publicHolidays,
      ),
    );
  }

  // Split minutes evenly across distinct workers (round half-up).
  const n = distinctWorkers.size;
  const perWorkerMinutes = Math.round((minutes / n) * 10) / 10; // 1 dp
  const statements: D1PreparedStatement[] = [];
  let totalLaborSen = 0;
  for (const wid of distinctWorkers) {
    // A worker id with no workers-table row (deleted) → default rate.
    const ratePerMin = rateByWorker.get(wid) ?? defaultRatePerMin;
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

  const matSum = await db
    .prepare(
      "SELECT COALESCE(SUM(totalCostSen),0) AS s FROM cost_ledger WHERE type = 'RM_ISSUE' AND refType = 'PRODUCTION_ORDER' AND refId = ?",
    )
    .bind(poId)
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
