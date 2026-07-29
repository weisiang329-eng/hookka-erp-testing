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
// itemGroup rides along for the Repair-Scope material-class filter
// (fabric / wood / foam — see src/lib/repair-scope.ts). It is a
// rename-map-known identifier, so the adapter translates it in the
// explicit projection (unlike the BUG-2026-06-10-001 runtime-column case).
async function resolveRmFromBom(
  db: D1Database,
  line: MaterialLine,
): Promise<{
  id: string;
  itemCode: string;
  description: string;
  itemGroup: string | null;
} | null> {
  if (line.inventoryCode) {
    const hit = await db
      .prepare(
        "SELECT id, itemCode, description, itemGroup FROM raw_materials WHERE itemCode = ? LIMIT 1",
      )
      .bind(line.inventoryCode)
      .first<{ id: string; itemCode: string; description: string; itemGroup: string | null }>();
    if (hit) return hit;
  }
  if (line.code) {
    const hit = await db
      .prepare(
        "SELECT id, itemCode, description, itemGroup FROM raw_materials WHERE itemCode = ? LIMIT 1",
      )
      .bind(line.code)
      .first<{ id: string; itemCode: string; description: string; itemGroup: string | null }>();
    if (hit) return hit;
  }
  if (line.name) {
    const hit = await db
      .prepare(
        "SELECT id, itemCode, description, itemGroup FROM raw_materials WHERE description = ? COLLATE NOCASE LIMIT 1",
      )
      .bind(line.name)
      .first<{ id: string; itemCode: string; description: string; itemGroup: string | null }>();
    if (hit) return hit;
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
// ---------------------------------------------------------------------------
// RM-consumption mode gate + PREVIEW recorder
// (owner 2026-07-29: 「你可以完善 … 等我说 ok 就正式扣料」)
//
// kv_config['rm_consumption_mode'] ∈ {"LIVE","PREVIEW"}. Default (missing /
// unreadable) = PREVIEW — fail-CLOSED so no raw material leaves stock while the
// BOMs are still being completed (premature consume would deduct against an
// incomplete BOM). In PREVIEW, every consume trigger (FAB_CUT + FG completion)
// computes the would-be consumption and records it to rm_consume_preview
// WITHOUT any rm_batches / raw_materials / cost_ledger write, so each BOM can be
// validated against real production before switching to LIVE. See Phase 1 of
// docs/plans/2026-07-29-rm-consumption-gate.md.
// ---------------------------------------------------------------------------
export type RmConsumptionMode = "LIVE" | "PREVIEW";

export async function getRmConsumptionMode(db: D1Database): Promise<RmConsumptionMode> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = 'rm_consumption_mode'")
      .first<{ value: string }>();
    if (!row) return "PREVIEW";
    let v: unknown = row.value;
    // kv-config PUT stringifies values (e.g. '"LIVE"'); tolerate a raw string too.
    try {
      const parsed = JSON.parse(row.value);
      if (typeof parsed === "string") v = parsed;
    } catch {
      /* stored raw — use as-is */
    }
    return v === "LIVE" ? "LIVE" : "PREVIEW";
  } catch {
    return "PREVIEW"; // fail-closed
  }
}

let rmConsumePreviewTableEnsured = false;
async function ensureRmConsumePreviewTable(db: D1Database): Promise<void> {
  if (rmConsumePreviewTableEnsured) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS rm_consume_preview (
         id TEXT PRIMARY KEY,
         po_id TEXT NOT NULL,
         po_no TEXT,
         product_code TEXT,
         material_id TEXT,
         material_code TEXT,
         material_name TEXT,
         required_qty REAL,
         resolved INTEGER,
         computed_at TEXT
       )`,
    )
    .run();
  rmConsumePreviewTableEnsured = true;
}

// Compute what a PO WOULD consume and (re)write its rm_consume_preview rows.
// No stock/ledger writes. `resolved = 0` rows are BOM gaps (a material line that
// maps to no raw_materials row) — exactly what the owner needs to see while
// completing BOMs. Repair-scope is intentionally NOT applied here: preview
// validates the full authored BOM, not a scoped repair.
export async function recordConsumePreview(
  db: D1Database,
  po: ProductionOrderRow,
): Promise<{ shortages: { materialName: string; shortageQty: number }[]; lines: number; unresolved: number }> {
  await ensureRmConsumePreviewTable(db);
  const bomLines = await resolveBomMaterials(db, po);
  const nowIso = new Date().toISOString();
  // Refresh — a re-fired completion replaces the PO's prior preview.
  await db.prepare("DELETE FROM rm_consume_preview WHERE po_id = ?").bind(po.id).run();
  const shortages: { materialName: string; shortageQty: number }[] = [];
  let unresolved = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const line of bomLines) {
    const required =
      line.qtyPerUnit * (po.quantity || 0) * (1 + Math.max(0, line.wastePct || 0) / 100);
    if (required <= 0) continue;
    const rm = await resolveRmFromBom(db, line);
    if (!rm) {
      unresolved++;
      shortages.push({ materialName: line.name, shortageQty: required });
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO rm_consume_preview
             (id, po_id, po_no, product_code, material_id, material_code, material_name, required_qty, resolved, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          genLedgerId("rmp"),
          po.id,
          po.poNo ?? null,
          po.productCode ?? null,
          rm?.id ?? null,
          rm?.itemCode ?? line.inventoryCode ?? line.code ?? null,
          rm?.description ?? line.name ?? null,
          required,
          rm ? 1 : 0,
          nowIso,
        ),
    );
  }
  if (stmts.length > 0) await db.batch(stmts);
  return { shortages, lines: bomLines.length, unresolved };
}

export async function consumeRawMaterialsForPO(
  db: D1Database,
  poId: string,
  opts?: { forceLive?: boolean },
): Promise<{
  skipped: boolean;
  materialCostSen: number;
  linesConsumed: number;
  shortages: { materialName: string; shortageQty: number }[];
  preview?: boolean;
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

  // RM-consumption gate (owner 2026-07-29「等我说 ok 就正式扣料」). Until
  // kv_config['rm_consumption_mode'] = "LIVE", run PREVIEW: record what WOULD
  // leave stock and return without any rm_batches / raw_materials / RM_ISSUE
  // write. Fail-CLOSED default so incomplete BOMs never deduct real stock.
  const mode = opts?.forceLive ? "LIVE" : await getRmConsumptionMode(db);
  if (mode !== "LIVE") {
    const preview = await recordConsumePreview(db, po);
    return {
      skipped: false,
      materialCostSen: 0,
      linesConsumed: 0,
      shortages: preview.shortages,
      preview: true,
    };
  }

  const bomLines = await resolveBomMaterials(db, po);
  if (bomLines.length === 0) {
    // No BOM → nothing to consume; also no FG materialCost.
    return { skipped: false, materialCostSen: 0, linesConsumed: 0, shortages: [] };
  }

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
    const required =
      line.qtyPerUnit *
      po.quantity *
      (1 + Math.max(0, line.wastePct || 0) / 100) *
      componentScale;
    if (required <= 0) continue;

    const rm = await resolveRmFromBom(db, line);

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
