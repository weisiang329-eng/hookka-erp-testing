// ---------------------------------------------------------------------------
// jobcard-sync — reconcile an existing PO's job_cards set with its CURRENT
// BOM template. Fixes the class of bug where a BOM was edited after POs were
// already created (e.g. migrations/0027 + 0029 adding UPHOLSTERY + PACKING to
// sofa variants, or the 5536-CSL / 5537-STOOL missing-FAB_CUT discovery):
// the POs kept their original JC set and had to be patched by hand.
//
// Endpoint:
//   POST /api/production/sync-jobcards-from-bom             — scan every PO
//   POST /api/production/sync-jobcards-from-bom?poId=XYZ    — scan one PO
//
// Semantics (idempotent):
//   For every (wipKey, deptCode) pair the CURRENT ACTIVE BOM expects, check
//   for an existing job_cards row on (productionOrderId, wipKey, deptCode).
//   If missing, INSERT a new row with status='WAITING', dueDate=po.targetEndDate,
//   PIC1/2 null, completedDate null. Existing JCs are never touched — use
//   /api/production-leadtimes or the dedicated recalc endpoint to refresh
//   dueDate/status.
//
// The BOM-resolution logic (ACTIVE first, fall back to most-recent) and the
// JC-row shape are imported from the shared helpers so this endpoint stays in
// lockstep with the SO-confirm path in sales-orders.ts.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import {
  breakBomIntoWips,
  type BomVariantContext,
} from "../lib/bom-wip-breakdown";

const app = new Hono<Env>();

type ProductionOrderRow = {
  id: string;
  salesOrderId: string | null;
  productCode: string | null;
  itemCategory: string | null;
  quantity: number;
  currentDepartment: string | null;
  targetEndDate: string | null;
  startDate: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
};

type L1Process = { deptCode: string; category: string; minutes: number };

// Mirror parseL1Processes from sales-orders.ts. Kept inline (not exported
// from sales-orders.ts) to preserve the "do not touch sales-orders.ts"
// constraint — the parser is small and stable.
function parseL1Processes(raw: string | null): L1Process[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((p) => ({
        deptCode: String((p as { deptCode?: unknown }).deptCode ?? ""),
        category: String((p as { category?: unknown }).category ?? ""),
        minutes: Number((p as { minutes?: unknown }).minutes) || 0,
      }))
      .filter((p) => p.deptCode.length > 0);
  } catch {
    return [];
  }
}

// Build the full (wipKey, deptCode) → {wipCode, wipLabel, wipType, wipQty,
// estMinutes, category, sequence} map the BOM currently expects for one PO.
// Covers both the L2 WIP chain (breakBomIntoWips output) and the FG-level
// l1Processes (wipKey="FG").
type ExpectedJc = {
  wipKey: string;
  wipCode: string;
  wipLabel: string;
  wipType: string;
  wipQty: number;
  deptCode: string;
  sequence: number;
  estMinutes: number;
  category: string;
  branchKey: string;
};

function computeExpectedJcs(
  po: ProductionOrderRow,
  bomRow: {
    wipComponents: string | null;
    l1Processes: string | null;
    baseModel: string | null;
  } | null,
): ExpectedJc[] {
  const productCode = po.productCode ?? "";
  const variants: BomVariantContext = {
    productCode,
    // Parent model from bom_templates.baseModel — fall back to productCode
    // when BOM didn't store one (so {MODEL} keeps the legacy variant value
    // for those rows instead of going blank). See BUG-2026-04-27-004.
    model: bomRow?.baseModel ?? productCode,
    sizeLabel: po.sizeLabel ?? "",
    sizeCode: po.sizeCode ?? "",
    fabricCode: po.fabricCode ?? "",
    divanHeightInches: po.divanHeightInches ?? null,
    legHeightInches: po.legHeightInches ?? null,
    gapInches: po.gapInches ?? null,
  };
  const wips = breakBomIntoWips(
    bomRow?.wipComponents ?? null,
    productCode,
    variants,
  );
  const expected: ExpectedJc[] = [];
  for (const wip of wips) {
    const wipQty = Math.max(
      1,
      Math.floor((po.quantity || 1) * wip.quantityMultiplier),
    );
    for (let i = 0; i < wip.processes.length; i++) {
      const p = wip.processes[i];
      expected.push({
        wipKey: wip.wipKey,
        wipCode: p.wipCode || wip.wipCode,
        wipLabel: p.wipLabel || wip.wipLabel,
        wipType: wip.wipType,
        wipQty,
        deptCode: p.deptCode,
        sequence: i,
        estMinutes: p.minutes,
        category: p.category,
        // BOM-walker stamped this on the process — no category/dept hardcode.
        branchKey: p.branchKey ?? "",
      });
    }
  }
  // FG-level l1Processes — single JC per process, wipKey="FG".
  const l1Procs = parseL1Processes(bomRow?.l1Processes ?? null);
  for (const l1p of l1Procs) {
    expected.push({
      wipKey: "FG",
      wipCode: productCode,
      wipLabel: productCode,
      wipType: "FG",
      wipQty: po.quantity || 1,
      deptCode: l1p.deptCode,
      sequence: 99,
      estMinutes: l1p.minutes,
      category: l1p.category,
      // FG-level joint terminals (UPHOLSTERY, PACKING) live at root —
      // shared by every branch, so no specific branch identifier.
      branchKey: "",
    });
  }
  return expected;
}

// Load ACTIVE BOM; fall back to most-recent. Mirrors sales-orders.ts.
async function loadBomTemplate(
  db: D1Database,
  productCode: string,
): Promise<{
  wipComponents: string | null;
  l1Processes: string | null;
  baseModel: string | null;
} | null> {
  if (!productCode) return null;
  type Row = {
    wipComponents: string | null;
    l1Processes: string | null;
    baseModel: string | null;
  };
  const active = await db
    .prepare(
      `SELECT wipComponents, l1Processes, baseModel FROM bom_templates
         WHERE productCode = ? AND versionStatus = 'ACTIVE'
         ORDER BY effectiveFrom DESC LIMIT 1`,
    )
    .bind(productCode)
    .first<Row>();
  if (active) return active;
  const latest = await db
    .prepare(
      `SELECT wipComponents, l1Processes, baseModel FROM bom_templates
         WHERE productCode = ? ORDER BY effectiveFrom DESC LIMIT 1`,
    )
    .bind(productCode)
    .first<Row>();
  return latest ?? null;
}

// Chunk an array into groups of n.
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n));
  }
  return out;
}

// ---------------------------------------------------------------------------
// POST /api/production/sync-jobcards-from-bom
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const db = c.var.DB;
  const poIdParam = c.req.query("poId");

  // Load departments once — every INSERT needs deptId + deptName lookups.
  const deptRes = await db
    .prepare("SELECT id, code, name FROM departments")
    .all<{ id: string; code: string; name: string }>();
  const deptByCode = new Map<string, { id: string; name: string }>();
  for (const d of deptRes.results ?? []) {
    deptByCode.set(d.code, { id: d.id, name: d.name });
  }

  // Target PO set.
  let poRows: ProductionOrderRow[];
  if (poIdParam) {
    const one = await db
      .prepare(
        `SELECT id, salesOrderId, productCode, itemCategory, quantity,
                currentDepartment, targetEndDate, startDate, sizeCode, sizeLabel,
                fabricCode, gapInches, divanHeightInches, legHeightInches
           FROM production_orders WHERE id = ?`,
      )
      .bind(poIdParam)
      .first<ProductionOrderRow>();
    poRows = one ? [one] : [];
  } else {
    const all = await db
      .prepare(
        `SELECT id, salesOrderId, productCode, itemCategory, quantity,
                currentDepartment, targetEndDate, startDate, sizeCode, sizeLabel,
                fabricCode, gapInches, divanHeightInches, legHeightInches
           FROM production_orders`,
      )
      .all<ProductionOrderRow>();
    poRows = all.results ?? [];
  }

  const perPO: Array<{ poId: string; created: string[] }> = [];
  const insertStatements: D1PreparedStatement[] = [];
  let totalCreated = 0;

  for (const po of poRows) {
    const productCode = po.productCode ?? "";
    const bomRow = await loadBomTemplate(db, productCode);
    // Legacy POs without ANY BOM template: we still compute expected JCs —
    // breakBomIntoWips returns a synthetic FG_MAIN WIP covering DEPT_ORDER
    // when `wipComponents` is null, and parseL1Processes returns [] for null
    // l1Processes. This mirrors what SO-confirm would do for the same PO.
    const expected = computeExpectedJcs(po, bomRow);
    if (expected.length === 0) {
      perPO.push({ poId: po.id, created: [] });
      continue;
    }

    // Load existing (wipKey, deptCode) pairs for this PO in one shot.
    const existingRes = await db
      .prepare(
        "SELECT wipKey, departmentCode FROM job_cards WHERE productionOrderId = ?",
      )
      .bind(po.id)
      .all<{ wipKey: string | null; departmentCode: string | null }>();
    const existing = new Set<string>();
    for (const row of existingRes.results ?? []) {
      existing.add(`${row.wipKey ?? ""}::${row.departmentCode ?? ""}`);
    }

    const dueDate = po.targetEndDate || po.startDate || "";
    const createdForThisPO: string[] = [];
    for (const exp of expected) {
      const key = `${exp.wipKey}::${exp.deptCode}`;
      if (existing.has(key)) continue;
      const deptMeta = deptByCode.get(exp.deptCode);
      if (!deptMeta) continue;
      const jcIdBase =
        exp.wipKey === "FG"
          ? `jc-${po.id}-FG-${exp.deptCode}`
          : `jc-${po.id}-${exp.wipKey}-${exp.deptCode}`;
      const jcId = jcIdBase.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
      insertStatements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO job_cards (id, productionOrderId, departmentId, departmentCode,
               departmentName, sequence, status, dueDate, wipKey, wipCode, wipType, wipLabel,
               wipQty, prerequisiteMet, pic1Id, pic1Name, pic2Id, pic2Name, completedDate,
               estMinutes, actualMinutes, category, productionTimeMinutes, overdue, rackingNumber, branchKey)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            jcId,
            po.id,
            deptMeta.id,
            exp.deptCode,
            deptMeta.name,
            exp.sequence,
            "WAITING",
            dueDate,
            exp.wipKey,
            exp.wipCode,
            exp.wipType,
            exp.wipLabel,
            exp.wipQty,
            // prerequisiteMet: leave 0 for appended JCs. The SO-confirm path
            // only sets 1 on sequence=0 of a fresh chain — for sync we can't
            // safely assume the appended dept is the new first step, so 0 is
            // the safe default. Upstream-lock / recalc endpoints can
            // re-evaluate.
            0,
            null,
            "",
            null,
            "",
            null,
            exp.estMinutes,
            null,
            exp.category,
            exp.estMinutes,
            "PENDING",
            null,
            // BOM-branch identifier — straight from computeExpectedJcs
            // which gets it from the BOM walker. Pure tree-driven, no
            // category/dept hardcode.
            exp.branchKey,
          ),
      );
      createdForThisPO.push(exp.deptCode);
      totalCreated++;
    }
    perPO.push({ poId: po.id, created: createdForThisPO });
  }

  // Batch INSERTs in groups of 50 to stay under D1's bound-param ceiling.
  for (const batch of chunk(insertStatements, 50)) {
    if (batch.length > 0) {
      await db.batch(batch);
    }
  }

  return c.json({
    success: true,
    scannedPOs: poRows.length,
    createdJCs: totalCreated,
    perPO,
  });
});

export default app;
