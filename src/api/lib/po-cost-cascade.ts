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
      if (scaledQty > 0 && (code || name)) {
        out.push({
          code: code || name,
          name,
          qtyPerUnit: scaledQty,
          wastePct: waste,
          inventoryCode,
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

// Resolve the BOM material list for a PO. Prefers bom_versions.tree
// (rich schema with inventoryCode + nested materials + optional scaling
// rules), falls back to bom_components rows. Returns [] if nothing is
// found. Dimensions snapshot is used by the JSON-tree path to expand
// per-material scaling rules at extraction time.
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
      if (acc.length > 0) return acc;
    } catch {
      // fall through to bom_components
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
// F1 — RM consumption (FIFO) on PO completion.
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
              sizeCode, sizeLabel
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
