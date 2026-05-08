// ---------------------------------------------------------------------------
// D1-backed production-orders route.
//
// Mirrors the old src/api/routes/production-orders.ts response shape so the
// SPA frontend does not need any changes. `jobCards` is returned as a nested
// array joined from job_cards; each job card's `piecePics` is joined from
// piece_pics.
//
// Phase-4A scope: base CRUD (list/get/update/patch), /stock PO creation,
// /historical-wips + /historical-fgs aggregates, and the /scan-complete FIFO
// routing + piece-pic binding. Multi-table writes are batched.
//
// Deferred to later phases:
//   - TODO(phase-5): FIFO raw-material consumption on PO completion
//     (fg_batches/rm_batches/cost_ledger are present in schema but the
//     lookup helpers in src/lib/material-lookup + src/lib/costing haven't
//     been ported to D1 yet).
//   - TODO(phase-5): jobCard/PO override persistence (job-card-persistence.ts)
//     — D1 writes are already durable so overrides become redundant, but the
//     module is still called by the in-memory route. Not needed here.
//
// JSON columns: none on production_orders/job_cards themselves. piece_pics is
// its own table in the schema.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { postProductionOrderCompletion } from "../lib/fg-completion";
import {
  consumeRawMaterialsForPO,
  postJobCardLabor,
} from "../lib/po-cost-cascade";
import {
  computeFcFabricUsageMeters,
  fetchBomWipComponentsByCode,
  fetchSofaSiblingsByGroupKey,
  sofaSiblingGroupKey,
  type SiblingPo,
} from "../lib/fabric-usage";
import { resolveWorkerToken } from "./worker-auth";
import { checkProductionOrderLocked, lockedResponse } from "../lib/lock-helpers";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
// Used by the regen-job-cards endpoints below. Lives in sales-orders.ts
// because it's the canonical "BOM template -> job_cards" walker that the
// SO-confirm path also calls; the force=true mode is the only thing
// production-orders.ts itself layers on top.
import { backfillJobCardsForPo } from "./sales-orders";
// Phase 6 — parallel event sourcing for JC mutations. appendJobCardEvent
// writes go after the UPDATE lands so the source-of-truth row is committed
// before we narrate what changed; a write failure here does NOT roll the
// UPDATE back (events are audit-only, not the transactional source).
import {
  buildJobCardEventStatement,
  diffJobCardEvents,
} from "../lib/job-card-events";
// Google Sheets sync (fire-and-forget). Helper silently no-ops when
// GOOGLE_SHEETS_SA_KEY is missing — see docs/SHEETS-SYNC.md.
import { syncJobCardToSheet } from "../lib/sheets-sync";
// Per-request leadtime map → expectedDueDate computation. The Production
// overview cell flips its text colour to teal when a JC's persisted
// dueDate doesn't match what the *current* leadtime config says it
// should be (operator manually moved it, OR config changed underneath
// it). Computed at read time, never persisted — purely derived.
import {
  loadLeadTimes,
  leadDaysFor,
  addDays,
  type LeadTimeMap,
} from "../lib/lead-times";

const app = new Hono<Env>();

// Self-applying migrations for the production-orders / job-cards space.
// Mirrors the pattern in src/api/routes/sales-orders.ts:1492 — each ALTER
// runs IF NOT EXISTS so it's idempotent + cheap, and the module-level
// promise gates one round of ALTERs per isolate boot, not per request.
//
// Added 2026-05-07: distributedAt on job_cards — the dept sheet needs a
// per-JC "Sent to floor" tick that survives sessions/devices so operators
// stop double-printing the same sheet.
let pendingMigrations: Promise<void> | null = null;
function ensurePendingMigrations(db: D1Database): Promise<void> {
  if (pendingMigrations) return pendingMigrations;
  pendingMigrations = (async () => {
    const stmts = [
      "ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS distributedAt TEXT",
    ];
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch (err) {
        // Best-effort. Log so silent schema drift surfaces in wrangler tail
        // (per the security-fix tightening landed earlier this branch).
        console.warn("[production-orders.migrations] ALTER skipped", {
          sql,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();
  return pendingMigrations;
}

// Local helper — push one JC row to the matching dept tab on the live
// spreadsheet via fire-and-forget. Joins production_orders + sales_orders
// for the customerRef / customer columns the sheet expects. Wrapped in
// try/catch so a Sheets-side failure NEVER voids the primary mutation.
async function fireAndForgetSyncJc(
  c: Context<Env>,
  jc: JobCardRow,
  po: ProductionOrderRow,
): Promise<void> {
  try {
    const so = po.salesOrderId
      ? await c.var.DB
          .prepare(
            "SELECT customerPOId, reference FROM sales_orders WHERE id = ?",
          )
          .bind(po.salesOrderId)
          .first<{ customerPOId: string | null; reference: string | null }>()
      : null;
    await syncJobCardToSheet(
      c.env as unknown as {
        GOOGLE_SHEETS_SA_KEY?: string;
        SHEETS_SPREADSHEET_ID?: string;
      },
      {
        id: jc.id,
        departmentCode: jc.departmentCode,
        status: jc.status,
        dueDate: jc.dueDate,
        completedDate: jc.completedDate,
        pic1Name: jc.pic1Name,
        pic2Name: jc.pic2Name,
        wipLabel: jc.wipLabel,
        category: jc.category,
        wipQty: jc.wipQty,
      },
      {
        poNo: po.poNo,
        customerName: po.customerName,
        productCode: po.productCode,
      },
      so
        ? { customerPOId: so.customerPOId, reference: so.reference }
        : null,
    );
  } catch (err) {
    console.error(
      "[sheets-sync] fireAndForgetSyncJc failed",
      err instanceof Error ? err.message : err,
    );
  }
}

function scheduleFireAndForget(c: Context<Env>, p: Promise<unknown>): void {
  const ctx = (c as unknown as {
    executionCtx?: { waitUntil(p: Promise<unknown>): void };
  }).executionCtx;
  if (ctx?.waitUntil) {
    ctx.waitUntil(p);
  }
  // If executionCtx isn't available, the promise still runs — we just don't
  // hold the request open for it.
}

// ---------------------------------------------------------------------------
// Row types (mirror migrations/0001_init.sql exactly)
// ---------------------------------------------------------------------------
export type ProductionOrderRow = {
  id: string;
  poNo: string;
  salesOrderId: string | null;
  salesOrderNo: string | null;
  lineNo: number;
  customerPOId: string | null;
  customerReference: string | null;
  customerName: string | null;
  customerState: string | null;
  companySOId: string | null;
  // Migration 0064 added consignment_order_id + company_co_id. A PO
  // originates from EITHER a SO or a CO (mutex). Surface both so the
  // delivery / consignment-note pages can route completed POs to the
  // right downstream flow (SO -> Delivery Order, CO -> Consignment Note).
  consignmentOrderId: string | null;
  companyCOId: string | null;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  itemCategory: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  specialOrder: string | null;
  notes: string | null;
  status: string;
  currentDepartment: string | null;
  progress: number;
  startDate: string | null;
  targetEndDate: string | null;
  completedDate: string | null;
  rackingNumber: string | null;
  stockedIn: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type JobCardRow = {
  id: string;
  productionOrderId: string;
  departmentId: string | null;
  departmentCode: string | null;
  departmentName: string | null;
  sequence: number;
  status: string;
  dueDate: string | null;
  wipKey: string | null;
  wipCode: string | null;
  wipType: string | null;
  wipLabel: string | null;
  wipQty: number | null;
  // BOM-branch identifier (added 2026-04-27, migration 0058). See
  // src/lib/mock-data.ts JobCard.branchKey for full rationale. Within
  // one wipKey, JCs in different branchKeys are NOT each other's
  // upstream/downstream — used by lock + consume + WIP-display logic.
  branchKey: string | null;
  prerequisiteMet: number;
  pic1Id: string | null;
  pic1Name: string | null;
  pic2Id: string | null;
  pic2Name: string | null;
  completedDate: string | null;
  estMinutes: number;
  actualMinutes: number | null;
  category: string | null;
  productionTimeMinutes: number;
  overdue: string | null;
  rackingNumber: string | null;
  // Per-JC "sent to floor" timestamp. NULL = not yet distributed; ISO
  // string = the moment the operator ticked the sheet as printed/sent.
  // Toggled via PATCH /api/production-orders/:id with `{ jobCardId,
  // distributedAt }`. Migration: see ensurePendingMigrations above.
  distributedAt: string | null;
};

type PiecePicRow = {
  id: number;
  jobCardId: string;
  pieceNo: number;
  pic1Id: string | null;
  pic1Name: string | null;
  pic2Id: string | null;
  pic2Name: string | null;
  completedAt: string | null;
  lastScanAt: string | null;
  boundStickerKey: string | null;
};

// Shape mirrored to the frontend — matches the in-memory PiecePic type.
type PiecePicOut = {
  pieceNo: number;
  pic1Id: string | null;
  pic1Name: string;
  pic2Id: string | null;
  pic2Name: string;
  completedAt: string | null;
  lastScanAt: string | null;
  boundStickerKey: string | null;
};

type ProductionOrderOut = ReturnType<typeof rowToPO>;

function rowToPiecePic(r: PiecePicRow): PiecePicOut {
  return {
    pieceNo: r.pieceNo,
    pic1Id: r.pic1Id,
    pic1Name: r.pic1Name ?? "",
    pic2Id: r.pic2Id,
    pic2Name: r.pic2Name ?? "",
    completedAt: r.completedAt,
    lastScanAt: r.lastScanAt,
    boundStickerKey: r.boundStickerKey,
  };
}

// Compute the dueDate this JC *should* have under the currently loaded
// leadtime config, given the parent PO's anchor (targetEndDate) and
// itemCategory. Returns "" when the inputs aren't enough to compute
// (no anchor / no category / no dept) — FE treats "" as "no signal,
// don't flag". Mirrors the formula in _shared/production-builder.ts:
//   dueDate = packingAnchor - leadDaysFor(category, deptCode)
// where packingAnchor is the PO's targetEndDate.
function computeExpectedDueDate(
  targetEndDate: string | null | undefined,
  itemCategory: string | null | undefined,
  deptCode: string | null | undefined,
  leadTimeMap: LeadTimeMap | null,
): string {
  if (!targetEndDate || !itemCategory || !deptCode || !leadTimeMap) return "";
  const days = leadDaysFor(leadTimeMap, itemCategory, deptCode);
  return addDays(targetEndDate, -days);
}

function rowToJobCard(
  r: JobCardRow,
  pics: PiecePicRow[] = [],
  parentTargetEndDate: string | null = null,
  parentItemCategory: string | null = null,
  leadTimeMap: LeadTimeMap | null = null,
) {
  const myPics = pics
    .filter((p) => p.jobCardId === r.id)
    .sort((a, b) => a.pieceNo - b.pieceNo)
    .map(rowToPiecePic);
  return {
    id: r.id,
    departmentId: r.departmentId ?? "",
    departmentCode: r.departmentCode ?? "",
    departmentName: r.departmentName ?? "",
    sequence: r.sequence,
    status: r.status,
    dueDate: r.dueDate ?? "",
    // Derived per request from current leadtime config. Empty string when
    // we lack the anchor/category/dept to compute. See computeExpectedDueDate.
    expectedDueDate: computeExpectedDueDate(
      parentTargetEndDate,
      parentItemCategory,
      r.departmentCode,
      leadTimeMap,
    ),
    wipKey: r.wipKey ?? undefined,
    wipCode: r.wipCode ?? undefined,
    wipType: r.wipType ?? undefined,
    wipLabel: r.wipLabel ?? undefined,
    wipQty: r.wipQty ?? undefined,
    branchKey: r.branchKey ?? undefined,
    prerequisiteMet: Boolean(r.prerequisiteMet),
    pic1Id: r.pic1Id,
    pic1Name: r.pic1Name ?? "",
    pic2Id: r.pic2Id,
    pic2Name: r.pic2Name ?? "",
    completedDate: r.completedDate,
    estMinutes: r.estMinutes,
    actualMinutes: r.actualMinutes,
    category: r.category ?? "",
    productionTimeMinutes: r.productionTimeMinutes,
    overdue: r.overdue ?? "",
    rackingNumber: r.rackingNumber ?? undefined,
    distributedAt: r.distributedAt ?? null,
    piecePics: myPics.length > 0 ? myPics : undefined,
  };
}

// Slim output shape for ?fields=minimal — only the fields the Production
// page actually reads off the wire. Dropping the ~20 unused PO fields
// (progress, startDate, targetEndDate, notes, etc.) and the full piece_pics
// tree typically halves the payload on a ~530-PO / ~9k-JC response.
type MinimalJobCardOut = {
  id: string;
  departmentCode: string;
  wipKey?: string;
  wipCode?: string;
  wipType?: string;
  wipLabel?: string;
  wipQty?: number;
  branchKey?: string;
  sequence: number;
  status: string;
  dueDate: string;
  // Derived per request from current production_lead_times_history (see
  // computeExpectedDueDate). "" when not computable. FE compares
  // dueDate vs expectedDueDate to surface "off-leadtime" cells in teal.
  expectedDueDate: string;
  completedDate: string | null;
  pic1Id: string | null;
  pic1Name: string;
  pic2Id: string | null;
  pic2Name: string;
  prerequisiteMet: boolean;
  productionTimeMinutes: number;
  estMinutes: number;
  rackingNumber?: string;
  category: string;
  // Per-piece progress, surfaced even on the minimal payload so the
  // Production page can render "1/2"-style partial completion in the
  // Completion column when a multi-piece JC is partially scanned. See
  // rowToMinimalPO for the count-by-jobCardId aggregation. piecesTotal
  // mirrors wipQty (defaulting to 1 for legacy single-piece JCs);
  // piecesDone counts piece_pics rows where pic1Id IS NOT NULL.
  piecesTotal: number;
  piecesDone: number;
  // ISO timestamp when this JC was marked distributed (sent to floor),
  // or null if it hasn't been sent yet. Drives the dept sheet's "Sent"
  // checkbox.
  distributedAt: string | null;
  // Predicted fabric usage in meters for this JC. Populated only for
  // FAB_CUT JCs; 0 / undefined for every other dept (they don't consume
  // fabric — they transform WIP). Computed from bom_templates.wipComponents
  // by walking FC nodes that this JC represents (specific match by
  // wipType, fallback to all-FC for merged bedframe / sofa cases),
  // applying per-piece scaling against PO dims, then multiplying by
  // node.quantity × po.quantity × (1 + waste%). The Fabric Cutting dept
  // page's "Fabric Usage" column reads this directly.
  fabricUsageMeters?: number;
};
type MinimalPOOut = {
  id: string;
  poNo: string;
  salesOrderId: string;
  salesOrderNo: string;
  companySOId: string;
  consignmentOrderId: string;
  companyCOId: string;
  customerPOId: string;
  customerReference: string;
  customerName: string;
  customerState: string;
  productId: string;
  productCode: string;
  productName: string;
  itemCategory: string;
  sizeCode: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  specialOrder: string;
  status: string;
  currentDepartment: string;
  // Piece-level completion % (computed by recomputePoStatusAndProgress).
  // Dashboard "progress" pills + reports read this — keep on the minimal
  // payload so consumers don't have to fetch the full PO row.
  progress: number;
  // ISO date stamped by the auto-cascade when status flips to COMPLETED.
  // Dashboard "Completed Today" tile depends on this.
  completedDate: string | null;
  lineNo: number;
  targetEndDate: string;
  jobCards: MinimalJobCardOut[];
};

function rowToMinimalJobCard(
  r: JobCardRow,
  piecesDoneByJc: Map<string, number> = new Map(),
  parentTargetEndDate: string | null = null,
  parentItemCategory: string | null = null,
  leadTimeMap: LeadTimeMap | null = null,
  parentPoForFabric: {
    quantity: number;
    itemCategory: string | null;
    gapInches: number | null;
    divanHeightInches: number | null;
    legHeightInches: number | null;
    sizeCode: string | null;
    sizeLabel: string | null;
  } | null = null,
  bomWipComponentsRaw: unknown = null,
  bomByProductCode: Map<string, unknown> | null = null,
  siblings: SiblingPo[] | null = null,
): MinimalJobCardOut {
  // wipQty defaults to 1 for legacy single-piece JCs; piecesTotal must
  // therefore floor at 1 so the FE never divides by 0 / renders "0/0".
  const piecesTotal = Math.max(1, r.wipQty ?? 1);
  const piecesDone = piecesDoneByJc.get(r.id) ?? 0;
  // Compute fabric usage only for FAB_CUT JCs. For mainstream bedframe /
  // accessory cases the anchor PO's BOM fully describes the cut. For sofa
  // cross-PO groups (merged FAB_CUT JC sits on ONE anchor PO but cuts for
  // every sibling sharing the same SO+fabric), pass siblings + bomMap so
  // computeFcFabricUsageMeters sums every piece in the group.
  const hasSiblingPath =
    !!parentPoForFabric &&
    parentPoForFabric.itemCategory === "SOFA" &&
    !!siblings &&
    siblings.length > 0 &&
    !!bomByProductCode;
  const fabricUsageMeters =
    r.departmentCode === "FAB_CUT" &&
    parentPoForFabric &&
    (bomWipComponentsRaw || hasSiblingPath)
      ? computeFcFabricUsageMeters(
          parentPoForFabric,
          { departmentCode: r.departmentCode, wipType: r.wipType ?? null },
          bomWipComponentsRaw,
          bomByProductCode ?? undefined,
          siblings ?? undefined,
        )
      : undefined;
  return {
    id: r.id,
    departmentCode: r.departmentCode ?? "",
    sequence: r.sequence,
    status: r.status,
    dueDate: r.dueDate ?? "",
    // Derived per request — see computeExpectedDueDate.
    expectedDueDate: computeExpectedDueDate(
      parentTargetEndDate,
      parentItemCategory,
      r.departmentCode,
      leadTimeMap,
    ),
    wipKey: r.wipKey ?? undefined,
    wipCode: r.wipCode ?? undefined,
    wipType: r.wipType ?? undefined,
    wipLabel: r.wipLabel ?? undefined,
    wipQty: r.wipQty ?? undefined,
    branchKey: r.branchKey ?? undefined,
    prerequisiteMet: Boolean(r.prerequisiteMet),
    pic1Id: r.pic1Id,
    pic1Name: r.pic1Name ?? "",
    pic2Id: r.pic2Id,
    pic2Name: r.pic2Name ?? "",
    completedDate: r.completedDate,
    productionTimeMinutes: r.productionTimeMinutes,
    estMinutes: r.estMinutes,
    category: r.category ?? "",
    rackingNumber: r.rackingNumber ?? undefined,
    piecesTotal,
    piecesDone,
    distributedAt: r.distributedAt ?? null,
    fabricUsageMeters,
  };
}

function rowToMinimalPO(
  row: ProductionOrderRow,
  jobCards: JobCardRow[] = [],
  piecesDoneByJc: Map<string, number> = new Map(),
  leadTimeMap: LeadTimeMap | null = null,
  bomByProductCode: Map<string, unknown> | null = null,
  siblingsByGroupKey: Map<string, SiblingPo[]> | null = null,
  baseModelByProductCode: Map<string, string> | null = null,
): MinimalPOOut {
  const parentTargetEndDate = row.targetEndDate ?? null;
  const parentItemCategory = row.itemCategory ?? null;
  // Lookup BOM template once per PO (productCode → wipComponents). Passed
  // to each JC's converter so per-FAB_CUT-JC fabric usage can be computed
  // without a per-JC DB roundtrip.
  const bomWipComponents =
    bomByProductCode && row.productCode
      ? (bomByProductCode.get(row.productCode) ?? null)
      : null;
  const parentPoForFabric = {
    quantity: row.quantity,
    itemCategory: row.itemCategory,
    gapInches: row.gapInches,
    divanHeightInches: row.divanHeightInches,
    legHeightInches: row.legHeightInches,
    sizeCode: row.sizeCode,
    sizeLabel: row.sizeLabel,
  };
  // For sofa cross-PO merged FAB_CUT JCs, look up the sibling group so
  // fabricUsageMeters sums every piece (the anchor PO's BOM only tells us
  // the anchor's cut; siblings share the same merged JC). Bedframe /
  // accessory / non-merged sofa → groupKey is null or sibling list is
  // single-element, falls back to anchor-only math.
  // Group key includes baseModel — must NOT collapse two different sofa
  // models into one group just because they share a fabricCode in the
  // same SO (e.g. SO-2605-106 has both 5530 and 5535 series cut from
  // M2402-4; they should NOT sum each other).
  const baseModel =
    baseModelByProductCode && row.productCode
      ? (baseModelByProductCode.get(row.productCode) ?? null)
      : null;
  const groupKey = sofaSiblingGroupKey(
    {
      itemCategory: row.itemCategory,
      companySOId: row.companySOId,
      companyCOId: row.companyCOId,
      fabricCode: row.fabricCode,
      productCode: row.productCode,
    },
    baseModel,
  );
  const siblings =
    groupKey && siblingsByGroupKey ? (siblingsByGroupKey.get(groupKey) ?? null) : null;
  const myJCs = jobCards
    .filter((j) => j.productionOrderId === row.id)
    .sort((a, b) => a.sequence - b.sequence)
    .map((j) =>
      rowToMinimalJobCard(
        j,
        piecesDoneByJc,
        parentTargetEndDate,
        parentItemCategory,
        leadTimeMap,
        parentPoForFabric,
        bomWipComponents,
        bomByProductCode,
        siblings,
      ),
    );
  return {
    id: row.id,
    poNo: row.poNo,
    salesOrderId: row.salesOrderId ?? "",
    salesOrderNo: row.salesOrderNo ?? "",
    companySOId: row.companySOId ?? "",
    consignmentOrderId: row.consignmentOrderId ?? "",
    companyCOId: row.companyCOId ?? "",
    customerPOId: row.customerPOId ?? "",
    customerReference: row.customerReference ?? "",
    customerName: row.customerName ?? "",
    customerState: row.customerState ?? "",
    productId: row.productId ?? "",
    productCode: row.productCode ?? "",
    productName: row.productName ?? "",
    itemCategory: row.itemCategory ?? "BEDFRAME",
    sizeCode: row.sizeCode ?? "",
    sizeLabel: row.sizeLabel ?? "",
    fabricCode: row.fabricCode ?? "",
    quantity: row.quantity,
    gapInches: row.gapInches,
    divanHeightInches: row.divanHeightInches,
    legHeightInches: row.legHeightInches,
    specialOrder: row.specialOrder ?? "",
    status: row.status,
    currentDepartment: row.currentDepartment ?? "",
    progress: row.progress ?? 0,
    completedDate: row.completedDate ?? null,
    lineNo: row.lineNo,
    targetEndDate: row.targetEndDate ?? "",
    jobCards: myJCs,
  };
}

function rowToPO(
  row: ProductionOrderRow,
  jobCards: JobCardRow[] = [],
  pics: PiecePicRow[] = [],
  leadTimeMap: LeadTimeMap | null = null,
) {
  const parentTargetEndDate = row.targetEndDate ?? null;
  const parentItemCategory = row.itemCategory ?? null;
  const myJCs = jobCards
    .filter((j) => j.productionOrderId === row.id)
    .sort((a, b) => a.sequence - b.sequence)
    .map((j) =>
      rowToJobCard(j, pics, parentTargetEndDate, parentItemCategory, leadTimeMap),
    );
  return {
    id: row.id,
    poNo: row.poNo,
    salesOrderId: row.salesOrderId ?? "",
    salesOrderNo: row.salesOrderNo ?? "",
    lineNo: row.lineNo,
    customerPOId: row.customerPOId ?? "",
    customerReference: row.customerReference ?? "",
    customerName: row.customerName ?? "",
    customerState: row.customerState ?? "",
    companySOId: row.companySOId ?? "",
    // Migration 0064: a PO can come from a Consignment Order instead of
    // an SO (mutex). Surface both source FKs so the delivery / consignment
    // pages can route the PO to the correct downstream flow. Bug fix
    // 2026-04-28: previously only rowToMinimalPO carried these fields;
    // rowToPO (used by /api/production-orders' default GET path) silently
    // dropped them, leaving CO POs misclassified as SO-source on the FE.
    consignmentOrderId: row.consignmentOrderId ?? "",
    companyCOId: row.companyCOId ?? "",
    productId: row.productId ?? "",
    productCode: row.productCode ?? "",
    productName: row.productName ?? "",
    itemCategory: row.itemCategory ?? "BEDFRAME",
    sizeCode: row.sizeCode ?? "",
    sizeLabel: row.sizeLabel ?? "",
    fabricCode: row.fabricCode ?? "",
    quantity: row.quantity,
    gapInches: row.gapInches,
    divanHeightInches: row.divanHeightInches,
    legHeightInches: row.legHeightInches,
    specialOrder: row.specialOrder ?? "",
    notes: row.notes ?? "",
    status: row.status,
    currentDepartment: row.currentDepartment ?? "",
    progress: row.progress,
    jobCards: myJCs,
    startDate: row.startDate ?? "",
    targetEndDate: row.targetEndDate ?? "",
    completedDate: row.completedDate,
    rackingNumber: row.rackingNumber ?? "",
    stockedIn: Boolean(row.stockedIn),
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
  };
}

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------
function genPoId(): string {
  return `pord-${crypto.randomUUID().slice(0, 8)}`;
}
function genJcId(): string {
  return `jc-${crypto.randomUUID().slice(0, 8)}`;
}
function genSoId(): string {
  return `so-${crypto.randomUUID().slice(0, 8)}`;
}
function genItemId(): string {
  return `soi-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// D1 caps prepared-statement bind parameters at 100 per call. The Production
// page's status-filter result regularly exceeds that (~530 POs in active
// status), so any `WHERE productionOrderId IN (?,?,...)` query against
// job_cards / piece_pics has to chunk its bind list. This helper runs the
// chunks in parallel and concatenates results, preserving order within each
// chunk (overall order is undefined — callers must sort if they need it).
async function fetchInChunks<R>(
  db: D1Database,
  buildSql: (placeholders: string) => string,
  ids: string[],
  extraBindsBefore: unknown[] = [],
  extraBindsAfter: unknown[] = [],
  chunkSize = 100,
): Promise<R[]> {
  if (ids.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    chunks.push(ids.slice(i, i + chunkSize));
  }
  const results = await Promise.all(
    chunks.map((chunk) => {
      const placeholders = chunk.map(() => "?").join(",");
      const sql = buildSql(placeholders);
      return db
        .prepare(sql)
        .bind(...extraBindsBefore, ...chunk, ...extraBindsAfter)
        .all<R>();
    }),
  );
  const out: R[] = [];
  for (const r of results) {
    if (r.results) out.push(...r.results);
  }
  return out;
}

// Returns Map<jobCardId, count> where count = number of piece_pics rows on
// that JC with pic1Id IS NOT NULL (i.e. a worker has scanned the QR sticker
// and "done" PIC1). Used by the minimal /api/production-orders payload to
// drive the Completion column's "1/2"-style partial-progress display
// without shipping the full piece_pics tree. Scoped by orgId + jobCardId IN
// (...) so cost is bound by the active JC set, not the full piece_pics
// table. Chunked at 100 to respect D1's bind-slot cap (the JC list is
// pre-bounded to one of: dept-narrow, status-narrow, or full-org JCs;
// status-narrow on the busiest filter is ~9k JCs → 90 chunks).
async function fetchPiecesDoneByJc(
  db: D1Database,
  orgId: string,
  jcIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (jcIds.length === 0) return out;
  const rows = await fetchInChunks<{ jobCardId: string; piecesDone: number }>(
    db,
    (placeholders) =>
      `SELECT jobCardId, COUNT(*) AS "piecesDone"
         FROM piece_pics
         WHERE orgId = ?
           AND pic1Id IS NOT NULL
           AND jobCardId IN (${placeholders})
         GROUP BY jobCardId`,
    jcIds,
    [orgId],
  );
  for (const r of rows) {
    out.set(r.jobCardId, Number(r.piecesDone) || 0);
  }
  return out;
}

async function fetchAllPOs(
  db: D1Database,
  orgId: string,
): Promise<ProductionOrderOut[]> {
  const [pos, jcs, pics] = await Promise.all([
    db
      .prepare(
        "SELECT * FROM production_orders WHERE orgId = ? ORDER BY created_at DESC, id DESC",
      )
      .bind(orgId)
      .all<ProductionOrderRow>(),
    db
      .prepare("SELECT * FROM job_cards WHERE orgId = ?")
      .bind(orgId)
      .all<JobCardRow>(),
    db
      .prepare("SELECT * FROM piece_pics WHERE orgId = ?")
      .bind(orgId)
      .all<PiecePicRow>(),
  ]);
  return (pos.results ?? []).map((p) =>
    rowToPO(p, jcs.results ?? [], pics.results ?? []),
  );
}

// Variant of fetchAllPOs that supports server-side status filtering and
// optional omission of inlined jobCards. Used by the list endpoint so the
// Production page can avoid shipping every PO + every JC on mount.
//
// - statuses: if provided (non-empty), applies `WHERE status IN (...)` at the
//   SQL layer.
// - includeJobCards: when false, skip the job_cards + piece_pics fetches and
//   return POs with `jobCards: []`. Defaults to true for backward compat.
async function fetchFilteredPOs(
  db: D1Database,
  orgId: string,
  statuses: string[] | null,
  includeJobCards: boolean,
  includeArchive = false,
  minimal = false,
  deptFilter: string | null = null,
  dueFrom: string | null = null,
  dueTo: string | null = null,
): Promise<ProductionOrderOut[] | MinimalPOOut[]> {
  // Load the (category, deptCode) → days map once per request. Drives the
  // derived `expectedDueDate` field on each JC — the FE compares it
  // against the persisted `dueDate` to flip the Production overview cell
  // text to teal when an operator has manually moved a JC off the
  // current leadtime plan. Single round-trip; safe to fail-soft (a null
  // map yields expectedDueDate = "" which the FE treats as "on plan").
  const leadTimeMap = await loadLeadTimes(db).catch(() => null);
  const hasFilter = Array.isArray(statuses) && statuses.length > 0;
  const placeholders = hasFilter
    ? statuses.map(() => "?").join(",")
    : "";
  // Phase-5: when includeArchive is set, UNION hot + archive. Hot rows get
  // a projected '' archivedAt so the column lists align with the archive
  // table. rowToPO ignores columns it doesn't know about.
  const poSource = includeArchive
    ? `(SELECT *, '' AS "archivedAt" FROM production_orders
        UNION ALL
        SELECT * FROM production_orders_archive)`
    : "production_orders";
  const jcSource = includeArchive
    ? `(SELECT *, '' AS "archivedAt" FROM job_cards
        UNION ALL
        SELECT * FROM job_cards_archive)`
    : "job_cards";
  // Sprint 4: orgId is always the leading WHERE predicate. Status filter
  // becomes an AND clause when present.
  // dueFrom / dueTo: date window applied differently depending on context:
  //   overview (no deptFilter)  → PO.targetEndDate window (whole-order PACKING anchor)
  //   dept page (deptFilter set) → that dept's JC.dueDate window (correct semantic
  //                                for /production/<dept> filtering)
  // NULL targetEndDate / dueDate is preserved on both sides — undated POs
  // / JCs survive so the daily view still shows them.
  const dueClauses: string[] = [];
  const dueBindings: string[] = [];
  if (dueFrom || dueTo) {
    if (deptFilter) {
      // Dept-page mode: filter rows where the matching dept's JC dueDate
      // falls in the window. EXISTS sub-query keeps the PO row when at
      // least one such JC exists (or its dueDate is NULL).
      const sub: string[] = [
        "EXISTS (SELECT 1 FROM job_cards jc",
        " WHERE jc.productionOrderId = production_orders.id",
        " AND jc.departmentCode = ?",
      ];
      const subBindings: string[] = [deptFilter];
      if (dueFrom) {
        sub.push(" AND (jc.dueDate IS NULL OR jc.dueDate >= ?)");
        subBindings.push(dueFrom);
      }
      if (dueTo) {
        sub.push(" AND (jc.dueDate IS NULL OR jc.dueDate <= ?)");
        subBindings.push(dueTo);
      }
      sub.push(")");
      dueClauses.push(sub.join(""));
      dueBindings.push(...subBindings);
    } else {
      if (dueFrom) {
        dueClauses.push("(targetEndDate IS NULL OR targetEndDate >= ?)");
        dueBindings.push(dueFrom);
      }
      if (dueTo) {
        dueClauses.push("(targetEndDate IS NULL OR targetEndDate <= ?)");
        dueBindings.push(dueTo);
      }
    }
  }
  const dueWhere = dueClauses.length > 0 ? ` AND ${dueClauses.join(" AND ")}` : "";
  const poSql = hasFilter
    ? `SELECT * FROM ${poSource} WHERE orgId = ? AND status IN (${placeholders})${dueWhere} ORDER BY created_at DESC, id DESC`
    : `SELECT * FROM ${poSource} WHERE orgId = ?${dueWhere} ORDER BY created_at DESC, id DESC`;
  const poStmt = hasFilter
    ? db.prepare(poSql).bind(orgId, ...(statuses as string[]), ...dueBindings)
    : db.prepare(poSql).bind(orgId, ...dueBindings);

  // Dept-narrowing: when caller passes ?dept=FOAM (etc.), return JCs
  // whose wipKey appears in any wipKey that contains a matching-dept JC,
  // PLUS legacy JCs (wipKey NULL) whose PO has a matching-dept JC,
  // PLUS *every* JC on a PO whose matching-dept JC is FG-keyed (sofa
  // PACKING merge-row case — the only matching wipKey is "FG", which
  // would otherwise strip every upstream component-branch JC and leave
  // the Packing tab's upstream date columns rendering "—" for sofas).
  // The production page's prev-dept-CD pills need upstream sibling JCs
  // in the same wipKey -- the original `WHERE departmentCode = ?` filter
  // stripped them, leaving every upstream column rendering "—".  This
  // wipKey-grouped variant keeps the JC-row payload down (only loads
  // wipKeys that the active dept actually touches) while letting the
  // frontend picker find the full chain.
  // Dept-narrowing — Option-C-aware symmetric filter.
  //
  // Pre-Option-C this used a wipKey-IN strip: include only JCs whose wipKey
  // appears in the deptFilter dept's wipKey set. That worked because all
  // depts on the same piece shared the same wipKey schema. After Option C
  // the merged FAB_CUT JC has a brand-new wipKey
  // (`{poId|companySOId}::baseModel::fabric::FAB_CUT`) that never coincides
  // with any per-piece downstream wipKey, so the strip dropped it — and
  // /production/fab-sew on SO-2604-347-01 returned 13 of 14 JCs (no FC),
  // leaving the Fab Cut column rendering "—" everywhere.
  //
  // New rule (symmetric, both directions):
  //   include every JC whose PO is related to the deptFilter's PO set, where
  //   "related" = same productionOrderId OR same companySOId.
  //     - same productionOrderId   → BF / ACC case (FC + per-piece SEW/etc.
  //                                  live on the same PO; deptFilter='FAB_CUT'
  //                                  also pulls downstream siblings on this
  //                                  PO).
  //     - same companySOId         → SOFA case (FC on anchor PO; per-piece
  //                                  SEW on sibling POs of same SO; both
  //                                  directions need to see across).
  //
  // Performance note: for typical SOs this returns ~14 JCs/PO × 1-3 POs.
  // The strict wipKey-IN strip was tighter (~7 JCs/PO) but broke under
  // Option C. The companySOId scan only widens within a SO, which is
  // bounded — production dataset has ~432 POs across ~340 SOs so the
  // upper bound on JC payload is well within Hyperdrive's response budget.
  // Cross-PO sibling subquery widens the JC fetch so a sibling PO of a
  // merged group (e.g. SOFA cross-PO FAB_CUT) gets the merged JC pulled
  // in. CO-origin POs use companyCOId instead of companySOId — match
  // either pair so CO sofa siblings render correctly in dept tabs.
  const jcWhereDept = deptFilter
    ? ` WHERE orgId = ? AND productionOrderId IN (
          SELECT po.id FROM production_orders po
          WHERE po.orgId = ?
            AND (po.id IN (SELECT productionOrderId FROM ${jcSource} WHERE orgId = ? AND departmentCode = ?)
                 OR (po.companySOId IS NOT NULL AND po.companySOId IN (
                      SELECT po2.companySOId FROM production_orders po2
                      JOIN ${jcSource} jc2 ON jc2.productionOrderId = po2.id
                      WHERE jc2.orgId = ? AND jc2.departmentCode = ? AND po2.companySOId IS NOT NULL))
                 OR (po.companyCOId IS NOT NULL AND po.companyCOId IN (
                      SELECT po3.companyCOId FROM production_orders po3
                      JOIN ${jcSource} jc3 ON jc3.productionOrderId = po3.id
                      WHERE jc3.orgId = ? AND jc3.departmentCode = ? AND po3.companyCOId IS NOT NULL)))
        )`
    : "";

  // Pre-load BOM templates ONCE for this request so the per-FAB_CUT-JC
  // fabric usage computation (in rowToMinimalJobCard via rowToMinimalPO)
  // stays O(1) lookup. Loaded only on the minimal path because the
  // Fabric Cutting dept page is the only consumer; the full-payload
  // path skips it to keep the legacy contract unchanged.
  // Sibling map: sofa cross-PO merged FAB_CUT JCs share fabric across
  // multiple POs in the same SO group. Pre-fetched here so each row's
  // converter can sum the entire group's BOM-based fabric demand instead
  // of just the anchor PO. Bedframe / accessory paths get a no-op map.
  // Index also carries productCode → baseModel so callers can compute the
  // group key (which is `${SO|CO}::${baseModel}::${fabricCode}`).
  const [bomByProductCode, siblingsIdx] = minimal
    ? await Promise.all([
        fetchBomWipComponentsByCode(db),
        fetchSofaSiblingsByGroupKey(db, orgId),
      ])
    : [null, null];
  const siblingsByGroupKey = siblingsIdx?.byGroupKey ?? null;
  const baseModelByProductCode = siblingsIdx?.baseModelByProductCode ?? null;

  if (!includeJobCards) {
    const pos = await poStmt.all<ProductionOrderRow>();
    if (minimal) {
      return (pos.results ?? []).map((p) =>
        rowToMinimalPO(p, [], new Map(), leadTimeMap, bomByProductCode, siblingsByGroupKey, baseModelByProductCode),
      );
    }
    return (pos.results ?? []).map((p) => rowToPO(p, [], [], leadTimeMap));
  }

  // Minimal path: skip piece_pics entirely (the Production page never reads
  // them) and return the narrow projection. This is the hot path for the
  // Production page — the dropped fields + table save several MB on the
  // ~530 PO / ~9k JC response.
  //
  // Exception: a single GROUPED count query against piece_pics (one row per
  // JC, not per piece) feeds the Completion column's "1/2"-style partial-
  // progress display. It scopes by jobCardId IN (...) so the cost is bound
  // by the JC set we already loaded, not the full piece_pics table.
  if (minimal) {
    if (deptFilter) {
      // Bind slots: 8 = orgId (outer JC scope) + orgId (po.orgId) + orgId
      // (inner jc) + deptFilter + orgId (jc2 SO sibling) + deptFilter +
      // orgId (jc3 CO sibling) + deptFilter.
      const jcStmt = db
        .prepare(`SELECT * FROM ${jcSource}${jcWhereDept}`)
        .bind(orgId, orgId, orgId, deptFilter, orgId, deptFilter, orgId, deptFilter);
      const [pos, jcs] = await Promise.all([
        poStmt.all<ProductionOrderRow>(),
        jcStmt.all<JobCardRow>(),
      ]);
      const jcRows = jcs.results ?? [];
      const piecesDoneByJc = await fetchPiecesDoneByJc(
        db,
        orgId,
        jcRows.map((j) => j.id),
      );
      return (pos.results ?? []).map((p) =>
        rowToMinimalPO(p, jcRows, piecesDoneByJc, leadTimeMap, bomByProductCode, siblingsByGroupKey, baseModelByProductCode),
      );
    }
    if (hasFilter) {
      // Status-filter path: run POs first, then narrow JCs to only the
      // matching POs' productionOrderId set. Avoids a full ~9k-row scan
      // when the filter shrinks the PO set to a few hundred. Bind list
      // is chunked at 100 (D1 cap) — see fetchInChunks.
      const pos = await poStmt.all<ProductionOrderRow>();
      const poRows = pos.results ?? [];
      if (poRows.length === 0) {
        return [];
      }
      const poIds = poRows.map((p) => p.id);
      const jcs = await fetchInChunks<JobCardRow>(
        db,
        (placeholders) =>
          `SELECT * FROM ${jcSource} WHERE productionOrderId IN (${placeholders})`,
        poIds,
      );
      const piecesDoneByJc = await fetchPiecesDoneByJc(
        db,
        orgId,
        jcs.map((j) => j.id),
      );
      return poRows.map((p) =>
        rowToMinimalPO(p, jcs, piecesDoneByJc, leadTimeMap, bomByProductCode, siblingsByGroupKey, baseModelByProductCode),
      );
    }
    // No status filter, no dept filter: legacy full-fetch backward-compat path.
    const jcStmt = db
      .prepare(`SELECT * FROM ${jcSource} WHERE orgId = ?`)
      .bind(orgId);
    const [pos, jcs] = await Promise.all([
      poStmt.all<ProductionOrderRow>(),
      jcStmt.all<JobCardRow>(),
    ]);
    const jcRows = jcs.results ?? [];
    const piecesDoneByJc = await fetchPiecesDoneByJc(
      db,
      orgId,
      jcRows.map((j) => j.id),
    );
    return (pos.results ?? []).map((p) =>
      rowToMinimalPO(p, jcRows, piecesDoneByJc, leadTimeMap, bomByProductCode, siblingsByGroupKey, baseModelByProductCode),
    );
  }

  if (deptFilter) {
    // Bind slots: 8 — see jcWhereDept comment above for the layout.
    const jcStmt = db
      .prepare(`SELECT * FROM ${jcSource}${jcWhereDept}`)
      .bind(orgId, orgId, orgId, deptFilter, orgId, deptFilter, orgId, deptFilter);
    const [pos, jcs, pics] = await Promise.all([
      poStmt.all<ProductionOrderRow>(),
      jcStmt.all<JobCardRow>(),
      db
        .prepare("SELECT * FROM piece_pics WHERE orgId = ?")
        .bind(orgId)
        .all<PiecePicRow>(),
    ]);
    return (pos.results ?? []).map((p) =>
      rowToPO(p, jcs.results ?? [], pics.results ?? [], leadTimeMap),
    );
  }
  if (hasFilter) {
    // Status-filter path (full payload): same narrow-by-PO-id trick as the
    // minimal branch. piece_pics stays a full fetch for now (separate task).
    // Bind list chunked at 100 — see fetchInChunks.
    const pos = await poStmt.all<ProductionOrderRow>();
    const poRows = pos.results ?? [];
    if (poRows.length === 0) {
      return [];
    }
    const poIds = poRows.map((p) => p.id);
    const [jcs, pics] = await Promise.all([
      fetchInChunks<JobCardRow>(
        db,
        (placeholders) =>
          `SELECT * FROM ${jcSource} WHERE productionOrderId IN (${placeholders})`,
        poIds,
      ),
      // piece_pics scoped via a sub-select bound to the page's PO IDs, not a
      // full table scan. Chunked at 100 PO ids — same D1 bind cap as the JC
      // chunking above. Avoids the ~all-piece_pics scan that the previous
      // `SELECT * FROM piece_pics` did when the operator only asked for a
      // status-filtered slice.
      fetchInChunks<PiecePicRow>(
        db,
        (placeholders) =>
          `SELECT * FROM piece_pics WHERE jobCardId IN (SELECT id FROM ${jcSource} WHERE productionOrderId IN (${placeholders}))`,
        poIds,
      ),
    ]);
    return poRows.map((p) => rowToPO(p, jcs, pics, leadTimeMap));
  }
  // No status filter, no dept filter: legacy full-fetch backward-compat path.
  const jcStmt = db
    .prepare(`SELECT * FROM ${jcSource} WHERE orgId = ?`)
    .bind(orgId);
  const [pos, jcs, pics] = await Promise.all([
    poStmt.all<ProductionOrderRow>(),
    jcStmt.all<JobCardRow>(),
    db
      .prepare("SELECT * FROM piece_pics WHERE orgId = ?")
      .bind(orgId)
      .all<PiecePicRow>(),
  ]);
  return (pos.results ?? []).map((p) =>
    rowToPO(p, jcs.results ?? [], pics.results ?? [], leadTimeMap),
  );
}

// Paginated variant of fetchFilteredPOs. Returns the page's POs + the total
// filtered count in one round-trip group. Uses SQL LIMIT/OFFSET on the PO
// table and then fetches job_cards/piece_pics for ONLY the page's PO IDs
// (not the whole table), which is the big win when the list is paginated.
async function fetchPaginatedPOs(
  db: D1Database,
  orgId: string,
  statuses: string[] | null,
  includeJobCards: boolean,
  page: number,
  limit: number,
  includeArchive = false,
  minimal = false,
  deptFilter: string | null = null,
  dueFrom: string | null = null,
  dueTo: string | null = null,
): Promise<{ data: ProductionOrderOut[] | MinimalPOOut[]; total: number }> {
  const hasFilter = Array.isArray(statuses) && statuses.length > 0;
  const statusPlaceholders = hasFilter
    ? statuses.map(() => "?").join(",")
    : "";
  const offset = (page - 1) * limit;

  const poSource = includeArchive
    ? `(SELECT *, '' AS "archivedAt" FROM production_orders
        UNION ALL
        SELECT * FROM production_orders_archive)`
    : "production_orders";
  const jcSource = includeArchive
    ? `(SELECT *, '' AS "archivedAt" FROM job_cards
        UNION ALL
        SELECT * FROM job_cards_archive)`
    : "job_cards";

  // dueFrom / dueTo: dept-aware date window — same logic as
  // fetchFilteredPOs. Overview filters PO.targetEndDate; dept page
  // filters that dept's JC.dueDate via EXISTS subquery.
  const dueClauses: string[] = [];
  const dueBindings: string[] = [];
  if (dueFrom || dueTo) {
    if (deptFilter) {
      const sub: string[] = [
        "EXISTS (SELECT 1 FROM job_cards jc",
        " WHERE jc.productionOrderId = production_orders.id",
        " AND jc.departmentCode = ?",
      ];
      const subBindings: string[] = [deptFilter];
      if (dueFrom) {
        sub.push(" AND (jc.dueDate IS NULL OR jc.dueDate >= ?)");
        subBindings.push(dueFrom);
      }
      if (dueTo) {
        sub.push(" AND (jc.dueDate IS NULL OR jc.dueDate <= ?)");
        subBindings.push(dueTo);
      }
      sub.push(")");
      dueClauses.push(sub.join(""));
      dueBindings.push(...subBindings);
    } else {
      if (dueFrom) {
        dueClauses.push("(targetEndDate IS NULL OR targetEndDate >= ?)");
        dueBindings.push(dueFrom);
      }
      if (dueTo) {
        dueClauses.push("(targetEndDate IS NULL OR targetEndDate <= ?)");
        dueBindings.push(dueTo);
      }
    }
  }
  const dueWhere = dueClauses.length > 0 ? ` AND ${dueClauses.join(" AND ")}` : "";

  const countSql = hasFilter
    ? `SELECT COUNT(*) AS n FROM ${poSource} WHERE orgId = ? AND status IN (${statusPlaceholders})${dueWhere}`
    : `SELECT COUNT(*) AS n FROM ${poSource} WHERE orgId = ?${dueWhere}`;
  const pageSql = hasFilter
    ? `SELECT * FROM ${poSource} WHERE orgId = ? AND status IN (${statusPlaceholders})${dueWhere} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
    : `SELECT * FROM ${poSource} WHERE orgId = ?${dueWhere} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;

  const countStmt = hasFilter
    ? db.prepare(countSql).bind(orgId, ...(statuses as string[]), ...dueBindings)
    : db.prepare(countSql).bind(orgId, ...dueBindings);
  const pageStmt = hasFilter
    ? db.prepare(pageSql).bind(orgId, ...(statuses as string[]), ...dueBindings, limit, offset)
    : db.prepare(pageSql).bind(orgId, ...dueBindings, limit, offset);

  const [countRes, pageRes] = await Promise.all([
    countStmt.first<{ n: number }>(),
    pageStmt.all<ProductionOrderRow>(),
  ]);
  const total = countRes?.n ?? 0;
  const posRows = pageRes.results ?? [];

  // Per-request leadtime map. See the matching call at the top of
  // fetchFilteredPOs for full rationale: drives the `expectedDueDate`
  // derived field that the FE compares against `dueDate` to highlight
  // off-leadtime cells.
  const leadTimeMap = await loadLeadTimes(db).catch(() => null);

  // BOM templates + sofa sibling group map pre-load — same rationale as
  // fetchFilteredPOs above: load once per request so per-FAB_CUT-JC fabric
  // usage compute is O(1) lookup. Only on the minimal path; full payload
  // skips them. Sibling index also carries productCode → baseModel for
  // group-key resolution (key = `{SO|CO}::{baseModel}::{fabricCode}`).
  const [bomByProductCode, siblingsIdx] = minimal
    ? await Promise.all([
        fetchBomWipComponentsByCode(db),
        fetchSofaSiblingsByGroupKey(db, orgId),
      ])
    : [null, null];
  const siblingsByGroupKey = siblingsIdx?.byGroupKey ?? null;
  const baseModelByProductCode = siblingsIdx?.baseModelByProductCode ?? null;

  if (!includeJobCards || posRows.length === 0) {
    if (minimal) {
      return {
        data: posRows.map((p) =>
          rowToMinimalPO(p, [], new Map(), leadTimeMap, bomByProductCode, siblingsByGroupKey, baseModelByProductCode),
        ),
        total,
      };
    }
    return {
      data: posRows.map((p) => rowToPO(p, [], [], leadTimeMap)),
      total,
    };
  }

  // Scope JC + piece_pics queries to only this page's PO IDs. Bind lists
  // chunked at 100 (D1 cap) — same latent overflow that 745801a fixed for
  // fetchFilteredPOs. With page size up to 500 + 3 IN clauses for the
  // deptFilter case, we'd otherwise blow past D1's 100-parameter cap.
  const poIds = posRows.map((p) => p.id);
  let jcs: JobCardRow[] = [];
  if (deptFilter) {
    // Dept narrowing — same wipKey-grouped logic as fetchFilteredPOs. Drops
    // unrelated wipKeys but keeps every sibling JC inside a touched wipKey
    // so the production page's prev-dept-CD pills (FAB_SEW shown on FOAM
    // tab, etc.) have the data they need.  Plain departmentCode filter
    // would orphan upstream pills.
    //
    // The query references `poIds` 3 times (outer + both subqueries), so we
    // chunk inline rather than threading a triple-IN shape through
    // fetchInChunks. Each chunk substitutes the same chunk slice into all 3
    // IN clauses.
    if (poIds.length > 0) {
      const CHUNK = 100;
      const chunks: string[][] = [];
      for (let i = 0; i < poIds.length; i += CHUNK) {
        chunks.push(poIds.slice(i, i + CHUNK));
      }
      const chunkResults = await Promise.all(
        chunks.map((chunk) => {
          const ph = chunk.map(() => "?").join(",");
          // The 3rd OR clause covers the sofa PACKING merge-row case: when
          // the matching-dept JC's wipKey is "FG" (sofa Packing), include
          // *every* JC on that PO so the frontend has the upstream
          // component-branch JCs (Base / Cushion / Armrest) it needs to
          // aggregate completedDate across the merged set. Without this,
          // the wipKey IN (...FG only...) clause would strip the upstream
          // chain and the Packing tab's date columns render "—".
          // Symmetric Option-C-aware dept narrowing — see jcWhereDept in
          // fetchFilteredPOs for the rationale. Include every JC whose PO
          // is in the requested-dept's PO set OR shares the same parent
          // doc id (SO or CO) with such a PO. CO sofa cross-PO merge
          // matches via companyCOId; SO via companySOId.
          const sql = `SELECT * FROM ${jcSource} WHERE productionOrderId IN (${ph}) AND productionOrderId IN (
            SELECT po.id FROM production_orders po
            WHERE po.id IN (${ph})
              AND (po.id IN (SELECT productionOrderId FROM ${jcSource} WHERE departmentCode = ? AND productionOrderId IN (${ph}))
                   OR (po.companySOId IS NOT NULL AND po.companySOId IN (
                        SELECT po2.companySOId FROM production_orders po2
                        JOIN ${jcSource} jc2 ON jc2.productionOrderId = po2.id
                        WHERE jc2.departmentCode = ? AND po2.companySOId IS NOT NULL AND po2.id IN (${ph})))
                   OR (po.companyCOId IS NOT NULL AND po.companyCOId IN (
                        SELECT po3.companyCOId FROM production_orders po3
                        JOIN ${jcSource} jc3 ON jc3.productionOrderId = po3.id
                        WHERE jc3.departmentCode = ? AND po3.companyCOId IS NOT NULL AND po3.id IN (${ph})))))`;
          return db
            .prepare(sql)
            .bind(
              ...chunk, ...chunk, deptFilter, ...chunk,
              deptFilter, ...chunk, deptFilter, ...chunk,
            )
            .all<JobCardRow>();
        }),
      );
      for (const r of chunkResults) {
        if (r.results) jcs.push(...r.results);
      }
    }
  } else {
    jcs = await fetchInChunks<JobCardRow>(
      db,
      (placeholders) =>
        `SELECT * FROM ${jcSource} WHERE productionOrderId IN (${placeholders})`,
      poIds,
    );
  }

  // Minimal path: skip piece_pics entirely.
  if (minimal) {
    return {
      data: posRows.map((p) =>
        rowToMinimalPO(p, jcs, new Map(), leadTimeMap, bomByProductCode, siblingsByGroupKey, baseModelByProductCode),
      ),
      total,
    };
  }

  // piece_pics: bind chunks of 100 PO ids and use a sub-select on job_cards
  // so each round-trip can sweep all piece_pics for ~hundreds of JCs instead
  // of one prepared statement per 100 JC ids. The previous JC-id-bound shape
  // expanded to ~35 chunks for a 200-PO / ~3500-JC page (the bulk of the
  // 16s/44-query overview path); this collapses that to ceil(POs/100) chunks
  // — typically 2 for an active-status slice — without changing the result
  // set the JC-id-bound query produced.
  let pics: PiecePicRow[] = [];
  if (jcs.length > 0 && poIds.length > 0) {
    pics = await fetchInChunks<PiecePicRow>(
      db,
      (placeholders) =>
        `SELECT * FROM piece_pics WHERE jobCardId IN (SELECT id FROM ${jcSource} WHERE productionOrderId IN (${placeholders}))`,
      poIds,
    );
  }

  return {
    data: posRows.map((p) => rowToPO(p, jcs, pics, leadTimeMap)),
    total,
  };
}

async function fetchPO(
  db: D1Database,
  id: string,
): Promise<ProductionOrderOut | null> {
  const po = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(id)
    .first<ProductionOrderRow>();
  if (!po) return null;
  const jcs = await db
    .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
    .bind(id)
    .all<JobCardRow>();
  const jcIds = (jcs.results ?? []).map((j) => j.id);
  let pics: PiecePicRow[] = [];
  if (jcIds.length > 0) {
    const placeholders = jcIds.map(() => "?").join(",");
    const picsRes = await db
      .prepare(`SELECT * FROM piece_pics WHERE jobCardId IN (${placeholders})`)
      .bind(...jcIds)
      .all<PiecePicRow>();
    pics = picsRes.results ?? [];
  }
  // Same per-request leadtime map as the list endpoints — keeps
  // expectedDueDate consistent on single-PO fetches.
  const leadTimeMap = await loadLeadTimes(db).catch(() => null);
  return rowToPO(po, jcs.results ?? [], pics, leadTimeMap);
}

// Ensure piece_pics rows exist for a job card. Creates wipQty (or 1) slots on
// demand and returns the ordered array. Mirrors the in-memory ensurePiecePics
// semantics, but persists to D1 so subsequent scans find the same slots.
async function ensurePiecePicsForJc(
  db: D1Database,
  jc: JobCardRow,
): Promise<PiecePicRow[]> {
  const existing = await db
    .prepare("SELECT * FROM piece_pics WHERE jobCardId = ? ORDER BY pieceNo")
    .bind(jc.id)
    .all<PiecePicRow>();
  const rows = existing.results ?? [];
  if (rows.length > 0) return rows;
  const slots = Math.max(1, Math.floor(jc.wipQty || 1));
  const inserts: D1PreparedStatement[] = [];
  for (let i = 1; i <= slots; i++) {
    inserts.push(
      db
        .prepare(
          `INSERT INTO piece_pics
             (jobCardId, pieceNo, pic1Id, pic1Name, pic2Id, pic2Name,
              completedAt, lastScanAt, boundStickerKey)
           VALUES (?, ?, NULL, '', NULL, '', NULL, NULL, NULL)`,
        )
        .bind(jc.id, i),
    );
  }
  if (inserts.length > 0) {
    await db.batch(inserts);
  }
  const refreshed = await db
    .prepare("SELECT * FROM piece_pics WHERE jobCardId = ? ORDER BY pieceNo")
    .bind(jc.id)
    .all<PiecePicRow>();
  return refreshed.results ?? [];
}

// Derive spec key used to scope FIFO candidates.
function specKeyFor(jc: JobCardRow, po: ProductionOrderRow): string {
  const wipLabel = jc.wipLabel;
  if (wipLabel) return `${jc.departmentCode}::${wipLabel}`;
  return `${jc.departmentCode}::${po.productCode}`;
}

// Month-based SOH counter.
async function nextSOHNumber(db: D1Database): Promise<string> {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `SOH-${yy}${mm}-`;
  const res = await db
    .prepare(
      "SELECT companySOId FROM sales_orders WHERE companySOId LIKE ? ORDER BY companySOId DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ companySOId: string }>();
  const seq = res?.companySOId
    ? Number(res.companySOId.split("-").pop()) + 1
    : 1;
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// WIP inventory — mirror of the in-memory applyWipInventoryChange().
// Writes directly to wip_items (code-keyed).
//
// UPHOLSTERY special case: UPHOLSTERY is the terminal WIP dept — once it
// completes, the WIP chain is finished and the piece becomes FG. We therefore
// DO NOT create / bump a new wip_items row for UPH (there's no physical
// "upholstered WIP" sitting on a shelf — it's a finished product). Instead we
// consume (zero out) every earlier-dept wip_items row in the same wipKey
// chain so the WIP board stops showing the intermediate Divan / HB / Cushion
// stock that was upstream of this UPH.
//
// FG stock is NOT written from here — it's derived at render time by
// deriveFGStock() in src/pages/inventory/index.tsx, which counts POs where
// every UPH job_card is completed. So the cascade is:
//   earlier depts COMPLETED → wip_items row added (stock accumulates)
//   UPH COMPLETED → wip_items rows for THIS wipKey zeroed out
//                   → deriveFGStock() now sees PO.jobCards[UPH].allCompleted
//                     and surfaces an FG row
// ---------------------------------------------------------------------------
export async function applyWipInventoryChange(
  db: D1Database,
  poRow: ProductionOrderRow,
  jcRow: JobCardRow,
  newStatus: string,
  allJcRows: JobCardRow[],
  prevStatus: string | null = null,
): Promise<void> {
  // BUG-2026-04-27-005: a PATCH that re-sends the same status (e.g. duplicate
  // form submit, refresh + retry, two operators racing the same JC) used to
  // fire the cascade twice — once per PATCH — doubling every consume and
  // every producer-add. Short-circuit when the status didn't actually change.
  if (prevStatus !== null && prevStatus === newStatus) return;
  const deptCodeRaw = (jcRow.departmentCode || "").toUpperCase();
  // BUG-2026-04-27-016: PACKING is a metadata-only step — it only records the
  // racking_number on the PO row. It does NOT participate in the inventory
  // cascade: no producer-add for FG-level PACKING rows, no consume of UPH
  // wip_items. UPH already wrote the +qty rows (and zeroed its upstream
  // siblings); `deriveFGStock` counts the PO as FG once all UPH JCs are
  // COMPLETED; and the DO/DR flow handles dispatch from FG. The PO-level
  // current_department flip, the PO COMPLETED transition,
  // postProductionOrderCompletion (fg_units / fg_batches), postJobCardLabor,
  // cascadePoCompletionToSO, and cascadeUpholsteryToSO all run in the OUTER
  // PATCH handler (see the body.status branch around lines 1590-1726), NOT
  // here — so PACKING's progression / FG generation / SO cascades all still
  // fire on PACKING completion. This short-circuit only suppresses the
  // wip_items writes.
  const isPacking = deptCodeRaw === "PACKING";
  if (isPacking) return;
  // Producer wipLabel — falls back to a synthesized label when the JC was
  // created without BOM (legacy seed via createJobCards()) so the inventory
  // upsert still lands a row. Without this fallback, completing WOOD_CUT (or
  // any producer dept) on a non-BOM PO silently skipped the wip_items
  // upsert, leaving nothing in the warehouse WIP view — reported by user
  // 2026-04-26.
  const wipType = jcRow.wipType;
  const wipKey = jcRow.wipKey;
  const wipQty = jcRow.wipQty || poRow.quantity || 1;
  const wipLabel =
    jcRow.wipLabel ||
    // Synthesize: "<productCode> <wipCode> (<DEPT>)" — keeps each dept's
    // output uniquely keyed so the upsert-by-code accumulates correctly
    // and the JC-derived /api/inventory/wip view groups by dept stage.
    [
      poRow.productCode || "",
      jcRow.wipCode || wipKey || "",
      deptCodeRaw ? `(${deptCodeRaw})` : "",
    ]
      .filter((s) => s && String(s).trim().length > 0)
      .join(" ")
      .trim();
  if (!wipLabel) return;

  const isUpholstery = deptCodeRaw === "UPHOLSTERY";

  const shortType = (() => {
    const t = (wipType || "").toUpperCase();
    if (t === "HEADBOARD") return "HB";
    if (t === "SOFA_BASE") return "BASE";
    if (t === "SOFA_CUSHION") return "CUSHION";
    if (t === "SOFA_ARMREST") return "ARMREST";
    return t || "WIP";
  })();

  // Generic upstream-consume gate — fires on IN_PROGRESS OR COMPLETED for
  // every non-UPH, non-FAB_CUT, non-WOOD_CUT dept. (PACKING is already
  // bypassed at the top of this function, see BUG-2026-04-27-016.) Date-cell
  // clicks skip IN_PROGRESS (WAITING → COMPLETED directly), which used to
  // orphan upstream stock.
  // BUG-2026-04-27-013: consume is unclamped (no MAX(0)) so a skipped /
  // out-of-order upstream dept surfaces as negative stock_qty rather
  // than being silently swallowed.
  const deptUpper = deptCodeRaw;
  const isFabCut = deptUpper === "FAB_CUT";
  // WOOD_CUT is parallel to FAB_CUT — both are raw-material entry points
  // (wood cut starts the wooden-frame chain, fabric cut starts the fabric
  // chain). Neither has an upstream wip_items to consume.
  const isWoodCut = deptUpper === "WOOD_CUT";
  const becomingActive =
    newStatus === "IN_PROGRESS" ||
    newStatus === "COMPLETED" ||
    newStatus === "TRANSFERRED";

  // ---------------------------------------------------------------------
  // BUG-2026-04-27-002 — rollback branch.
  // When a JC transitions OUT of a DONE state (COMPLETED/TRANSFERRED →
  // anything else) we have to undo what the original COMPLETED transition
  // did, otherwise stock drifts on every toggle. Symmetric inverse of the
  // forward paths below:
  //   Non-UPH:   subtract wipQty from this JC's own wip_items row,
  //              refund the same qty to the upstream sibling that the
  //              forward path consumed from.
  //   UPH:       subtract wipQty from UPH's own row, refund each upstream
  //              wipKey sibling that the forward path zeroed.
  // ---------------------------------------------------------------------
  const wasDone =
    prevStatus === "COMPLETED" || prevStatus === "TRANSFERRED";
  const isDone =
    newStatus === "COMPLETED" || newStatus === "TRANSFERRED";
  if (wasDone && !isDone) {
    const refundQty = wipQty;
    if (isUpholstery) {
      // BUG-2026-04-30-003 reverse symmetry: if PO was previously
      // all-UPH-done (Plan B subtract had fired in the forward COMPLETED
      // branch), reverting one UPH JC means the goods are back as WIP.
      // Add back +wipQty for every UPH JC in this PO. Net effect:
      //   - reverting JC's own wipLabel: +wipQty (here) - wipQty (subtract
      //     below) = 0   ← correct, this UPH is no longer producing
      //   - other UPH JCs (still COMPLETED): +wipQty (here) only, no
      //     subtract applies → restored as WIP since PO is no longer
      //     fully UPH-complete.
      // wasAllUphDone is true iff every UPH JC in this PO is currently
      // COMPLETED/TRANSFERRED EXCEPT the reverting one — and we know the
      // reverting one was previously COMPLETED (wasDone=true).
      const poUphJcs = allJcRows.filter(
        (j) =>
          j.productionOrderId === poRow.id &&
          (j.departmentCode || "").toUpperCase() === "UPHOLSTERY",
      );
      const wasAllUphDone =
        poUphJcs.length > 0 &&
        poUphJcs.every((j) =>
          j.id === jcRow.id
            ? true // wasDone=true, this JC was COMPLETED before
            : j.status === "COMPLETED" || j.status === "TRANSFERRED",
        );
      if (wasAllUphDone) {
        for (const uphJc of poUphJcs) {
          if (!uphJc.wipLabel) continue;
          const addQty = uphJc.wipQty || poRow.quantity || 1;
          await db
            .prepare(
              "UPDATE wip_items SET stockQty = stockQty + ? WHERE code = ?",
            )
            .bind(addQty, uphJc.wipLabel)
            .run();
        }
      }

      // Subtract UPH's own row.
      // BUG-2026-04-27-013: no MAX(0) clamp — symmetric with the forward
      // consume; a rollback before any completion can go negative as a
      // visibility signal.
      await db
        .prepare(
          "UPDATE wip_items SET stockQty = stockQty - ? WHERE code = ?",
        )
        .bind(refundQty, wipLabel)
        .run();
      // Refund every upstream sibling the forward UPH-COMPLETED path
      // consumed from.
      if (wipKey) {
        const upstreamLabels = new Set<string>();
        for (const j of allJcRows) {
          if (
            j.wipKey === wipKey &&
            j.sequence < jcRow.sequence &&
            j.wipLabel
          ) {
            upstreamLabels.add(j.wipLabel);
          }
        }
        for (const label of upstreamLabels) {
          await db
            .prepare(
              "UPDATE wip_items SET stockQty = stockQty + ? WHERE code = ?",
            )
            .bind(refundQty, label)
            .run();
        }
      }
      return;
    }

    // Non-UPH dept rollback: subtract this JC's own row first.
    // BUG-2026-04-27-013: no MAX(0) clamp — symmetric with the forward
    // consume so a "rollback before any completion" goes negative as a
    // visibility signal that something is out of order.
    await db
      .prepare(
        "UPDATE wip_items SET stockQty = stockQty - ? WHERE code = ?",
      )
      .bind(refundQty, wipLabel)
      .run();
    // Refund the upstream sibling that the becomingActive branch consumed.
    // FAB_CUT and WOOD_CUT have no upstream so they skip the refund —
    // matches the forward path's `!isFabCut && !isWoodCut && !isUpholstery`
    // gate. Sibling lookup matches by (wipKey, branchKey) — within one
    // wipKey there can be multiple parallel BOM branches that share the
    // wipKey but never each other's upstream/downstream (BUG-2026-04-27:
    // Wood Cut completion was wrongly consuming Fab Sew stock because the
    // old wipKey-only filter pulled siblings from both branches).
    if (!isFabCut && !isWoodCut) {
      let refundLabel: string | null = null;
      if (wipKey) {
        const myBranch = jcRow.branchKey ?? "";
        const children = allJcRows
          .filter(
            (j) =>
              j.wipKey === wipKey &&
              (j.branchKey ?? "") === myBranch &&
              j.sequence < jcRow.sequence,
          )
          .sort((a, b) => b.sequence - a.sequence);
        if (children[0]?.wipLabel) {
          refundLabel = children[0].wipLabel;
        }
      }
      // Option C fallback (mirror of forward consume) — refund the merged
      // FC wip_items row when no per-PO sibling found. Try both wipKey
      // shapes (BF per-PO, SOFA cross-PO).
      if (!refundLabel && deptUpper === "FAB_SEW") {
        // Parent-doc key for SOFA cross-PO merge: prefer SO-side ids,
        // fall back to CO-side ids (CO sofa POs have companySOId NULL).
        const parentDocKey =
          poRow.companySOId ||
          poRow.salesOrderId ||
          poRow.companyCOId ||
          poRow.consignmentOrderId ||
          "";
        const fabricCode = poRow.fabricCode || "";
        const bomLookup = await db
          .prepare(
            `SELECT baseModel FROM bom_templates
             WHERE productCode = ?
             ORDER BY effectiveFrom DESC LIMIT 1`,
          )
          .bind(poRow.productCode ?? "")
          .first<{ baseModel: string | null }>();
        const baseModel = bomLookup?.baseModel || poRow.productCode || "";
        const candidates: string[] = [
          `${jcRow.productionOrderId}::${baseModel}::${fabricCode}::FAB_CUT`,
        ];
        if (parentDocKey) {
          candidates.push(
            `${parentDocKey}::${baseModel}::${fabricCode}::FAB_CUT`,
          );
        }
        for (const cand of candidates) {
          const mergedFc = await db
            .prepare(
              `SELECT wipLabel FROM job_cards
               WHERE wipKey = ? AND departmentCode = 'FAB_CUT'
               LIMIT 1`,
            )
            .bind(cand)
            .first<{ wipLabel: string }>();
          if (mergedFc?.wipLabel) {
            refundLabel = mergedFc.wipLabel;
            break;
          }
        }
      }
      if (refundLabel) {
        // Option C dedup-aware refund: forward consume only fired ONCE
        // per merge group (first DONE sibling). Refund must mirror that:
        // ONLY refund when this rollback leaves zero DONE siblings —
        // otherwise the merge group is still partly consumed and the
        // upstream stub stays.
        let actualRefund = refundQty;
        const isMergedFcUpstream = refundLabel.endsWith("(FC)");
        if (isMergedFcUpstream && deptUpper === "FAB_SEW") {
          // Count DONE siblings remaining in the merge group (jcRow has
          // already been UPDATEd to non-DONE by the PATCH handler, so
          // the COUNT excludes self by virtue of status filter).
          const isSofa = (poRow.itemCategory || "") === "SOFA";
          // CO-aware parent-doc key (mirrors forward consume dedup).
          const refundParentDocKey =
            poRow.companySOId || poRow.companyCOId || "";
          const sibQ = isSofa
            ? await db
                .prepare(
                  `SELECT COUNT(*) AS n FROM job_cards jc2
                     JOIN production_orders po2 ON po2.id = jc2.productionOrderId
                    WHERE jc2.id != ?
                      AND jc2.departmentCode = 'FAB_SEW'
                      AND (jc2.status = 'COMPLETED' OR jc2.status = 'TRANSFERRED')
                      AND (po2.companySOId = ? OR po2.companyCOId = ?)
                      AND ? <> ''
                      AND po2.fabricCode = ?`,
                )
                .bind(
                  jcRow.id,
                  refundParentDocKey,
                  refundParentDocKey,
                  refundParentDocKey,
                  poRow.fabricCode ?? "",
                )
                .first<{ n: number }>()
            : await db
                .prepare(
                  `SELECT COUNT(*) AS n FROM job_cards
                    WHERE id != ?
                      AND productionOrderId = ?
                      AND departmentCode = 'FAB_SEW'
                      AND (status = 'COMPLETED' OR status = 'TRANSFERRED')`,
                )
                .bind(jcRow.id, jcRow.productionOrderId)
                .first<{ n: number }>();
          const stillDoneSibling = Number(sibQ?.n ?? 0) > 0;
          if (stillDoneSibling) {
            // Other sibling still DONE — merge group is still consumed.
            // Don't refund (consume stays).
            actualRefund = 0;
          } else {
            // No other DONE sibling — this rollback leaves the group
            // fully un-consumed. Refund 1 set (mirrors forward consume).
            actualRefund = 1;
          }
        }
        if (actualRefund > 0) {
          await db
            .prepare(
              "UPDATE wip_items SET stockQty = stockQty + ? WHERE code = ?",
            )
            .bind(actualRefund, refundLabel)
            .run();
        }
      }
    }
    return;
  }

  // FAB_CUT and WOOD_CUT are producer-only stages — nothing upstream to
  // consume. UPH has its own consume-all-upstream logic in the COMPLETED
  // branch below.
  //
  // BUG-2026-04-30-002 — double-consume guard. The original gate fired
  // on `becomingActive` alone, so a JC on the WAITING→IN_PROGRESS→COMPLETED
  // path entered this branch TWICE: once at IN_PROGRESS (consume fires +
  // early `return`) and again at COMPLETED (consume fires AGAIN, then
  // falls through to the producer-add). Net effect: -2 consumes + 1
  // producer = -1 leak per JC that touched both transitions, accruing
  // negative wip_items rows on the upstream sibling. Fix: skip the
  // consume when the JC was already active before this transition
  // (i.e. IN_PROGRESS→COMPLETED), but still allow the IN_PROGRESS
  // early-return so COMPLETED falls through to the producer-add below.
  if (!isFabCut && !isWoodCut && !isUpholstery && becomingActive) {
    const wasActive =
      prevStatus === "IN_PROGRESS" ||
      prevStatus === "COMPLETED" ||
      prevStatus === "TRANSFERRED";
    // Per-component upstream consume — sibling lookup is now BOM-branch
    // aware (BUG-2026-04-27 fix, migration 0058). Within one wipKey
    // ("DIVAN" / "HEADBOARD" / "SOFA_*") the BOM has parallel branches
    // (e.g. BF Divan: Foam-branch wood chain || Fabric-branch fab chain)
    // that converge only at UPHOLSTERY. The previous wipKey + sequence
    // heuristic flattened them into one chain and a Wood Cut completion
    // wrongly consumed Fab Sew stock (Wei Siang report 2026-04-27).
    // Filter siblings by (wipKey, branchKey) so each branch's consume
    // only reaches its own true upstream.
    let upstreamLabel: string | null = null;
    if (!wasActive && wipKey) {
      const myBranch = jcRow.branchKey ?? "";
      const children = allJcRows
        .filter(
          (j) =>
            j.wipKey === wipKey &&
            (j.branchKey ?? "") === myBranch &&
            j.sequence < jcRow.sequence,
        )
        .sort((a, b) => b.sequence - a.sequence);
      if (children[0]?.wipLabel) {
        upstreamLabel = children[0].wipLabel;
      }
    }
    // Option C fallback: FAB_SEW's upstream FC is no longer per-piece on
    // the same PO — it's the merged FC JC. Two wipKey shapes depending on
    // category:
    //   SOFA   → `{companySOId}::{baseModel}::{fabric}::FAB_CUT` (cross-PO
    //            merge across same SO).
    //   BF/ACC → `{productionOrderId}::{baseModel}::{fabric}::FAB_CUT`
    //            (per-PO merge inside one set's POs).
    //
    // Try both shapes; whichever matches a real FC JC wins. Falling back
    // to a plain "any FC JC on this PO" lookup catches the BF case where
    // the bom_templates baseModel doesn't match the productCode prefix
    // exactly (legacy BOMs sometimes use different baseModel strings).
    if (!upstreamLabel && deptUpper === "FAB_SEW") {
      // Parent-doc key for SOFA cross-PO merge. Falls back to CO-side ids
      // (companyCOId / consignmentOrderId) when SO ids are NULL — without
      // this, CO sofa SEW completion couldn't find the merged FC and
      // dedup/refund cascades misbehaved.
      const parentDocKey =
        poRow.companySOId ||
        poRow.salesOrderId ||
        poRow.companyCOId ||
        poRow.consignmentOrderId ||
        "";
      const fabricCode = poRow.fabricCode || "";
      const bomLookup = await db
        .prepare(
          `SELECT baseModel FROM bom_templates
           WHERE productCode = ?
           ORDER BY effectiveFrom DESC LIMIT 1`,
        )
        .bind(poRow.productCode ?? "")
        .first<{ baseModel: string | null }>();
      const baseModel = bomLookup?.baseModel || poRow.productCode || "";
      const candidates: string[] = [];
      // BF / ACC: per-PO merge.
      candidates.push(
        `${jcRow.productionOrderId}::${baseModel}::${fabricCode}::FAB_CUT`,
      );
      // SOFA: cross-PO merge keyed by parent doc id (SO or CO).
      if (parentDocKey) {
        candidates.push(
          `${parentDocKey}::${baseModel}::${fabricCode}::FAB_CUT`,
        );
      }
      for (const cand of candidates) {
        const mergedFc = await db
          .prepare(
            `SELECT wipLabel FROM job_cards
             WHERE wipKey = ? AND departmentCode = 'FAB_CUT'
             LIMIT 1`,
          )
          .bind(cand)
          .first<{ wipLabel: string }>();
        if (mergedFc?.wipLabel) {
          upstreamLabel = mergedFc.wipLabel;
          break;
        }
      }
      // Last-resort fallback: any FC JC on this PO. Catches the BF case
      // where the constructed wipKey above doesn't match (legacy baseModel
      // mismatch). Safe because Option C guarantees at most one FC JC
      // per PO.
      if (!upstreamLabel) {
        const anyFc = await db
          .prepare(
            `SELECT wipLabel FROM job_cards
             WHERE productionOrderId = ? AND departmentCode = 'FAB_CUT'
             LIMIT 1`,
          )
          .bind(jcRow.productionOrderId)
          .first<{ wipLabel: string }>();
        if (anyFc?.wipLabel) {
          upstreamLabel = anyFc.wipLabel;
        }
      }
      // For SOFA cross-PO: when this SEW row is on a sibling PO of a
      // merged sofa group, the FC JC may live on the anchor PO (different
      // productionOrderId). Walk same-(SO|CO) siblings.
      if (!upstreamLabel && parentDocKey) {
        const sibFc = await db
          .prepare(
            `SELECT jc.wipLabel FROM job_cards jc
             JOIN production_orders po ON po.id = jc.productionOrderId
             WHERE (po.companySOId = ? OR po.companyCOId = ?)
               AND ? <> ''
               AND jc.departmentCode = 'FAB_CUT'
             LIMIT 1`,
          )
          .bind(parentDocKey, parentDocKey, parentDocKey)
          .first<{ wipLabel: string }>();
        if (sibFc?.wipLabel) {
          upstreamLabel = sibFc.wipLabel;
        }
      }
    }
    if (!wasActive && upstreamLabel) {
      // Option C — when the upstream is a MERGED FC ("X | (FC)" label),
      // multiple per-piece downstream siblings (HB SEW + DV SEW for BF;
      // 2A_LHF / L_RHF / CNR sofa-piece SEWs for sofa) all want to
      // consume from the same upstream wip_items row. Per-piece consume
      // doesn't balance because per-piece wipQty has BOM multipliers
      // (BF DV multiplier=2) so the merged FC stock_qty (= set count)
      // can never reach 0. Use SET-LEVEL dedup: only the FIRST DONE
      // sibling triggers the consume; subsequent siblings no-op. The
      // FC's producer-add of +set_count then balances the row to 0.
      const isMergedFcUpstream =
        deptUpper === "FAB_SEW" && upstreamLabel.endsWith("(FC)");
      let consumeQty = jcRow.wipQty || poRow.quantity || 1;
      if (isMergedFcUpstream) {
        // Count siblings in the same merge group already DONE (excluding
        // self). For BF/ACC the group is bounded by productionOrderId.
        // For SOFA cross-PO the group spans all sibling POs sharing the
        // same companySOId + fabricCode.
        const isSofa = (poRow.itemCategory || "") === "SOFA";
        // CO-aware parent-doc key. CO sofa POs leave companySOId NULL
        // (parent doc lives on companyCOId/consignmentOrderId), and the
        // SO-only WHERE filter treated every CO sibling as "first to
        // finish" → forward consume fired N times → upstream stub went
        // negative by (N-1) sets per CO sofa group. Match either pair so
        // dedup works regardless of order origin.
        const parentDocKey =
          poRow.companySOId || poRow.companyCOId || "";
        const sibQ = isSofa
          ? await db
              .prepare(
                `SELECT COUNT(*) AS n FROM job_cards jc2
                   JOIN production_orders po2 ON po2.id = jc2.productionOrderId
                  WHERE jc2.id != ?
                    AND jc2.departmentCode = 'FAB_SEW'
                    AND (jc2.status = 'COMPLETED' OR jc2.status = 'TRANSFERRED')
                    AND (po2.companySOId = ? OR po2.companyCOId = ?)
                    AND ? <> ''
                    AND po2.fabricCode = ?`,
              )
              .bind(
                jcRow.id,
                parentDocKey,
                parentDocKey,
                parentDocKey,
                poRow.fabricCode ?? "",
              )
              .first<{ n: number }>()
          : await db
              .prepare(
                `SELECT COUNT(*) AS n FROM job_cards
                  WHERE id != ?
                    AND productionOrderId = ?
                    AND departmentCode = 'FAB_SEW'
                    AND (status = 'COMPLETED' OR status = 'TRANSFERRED')`,
              )
              .bind(jcRow.id, jcRow.productionOrderId)
              .first<{ n: number }>();
        const siblingDone = Number(sibQ?.n ?? 0) > 0;
        if (siblingDone) {
          // Already consumed by an earlier sibling. Skip — cascade is
          // idempotent at the merge-group level.
          consumeQty = 0;
        } else {
          // First sibling to finish. Use 1 set unit, NOT per-piece
          // wipQty (per-piece would over-decrement by the BOM
          // multiplier).
          consumeQty = 1;
        }
      }
      if (consumeQty > 0) {
        // BUG-2026-04-27-013: cascade consume always decrements (no MAX
        // clamp). If the upstream wip_items row doesn't exist (because
        // the upstream JC was skipped / never completed), INSERT one
        // with stock_qty = -consumeQty so the negative number surfaces
        // the missed dept on the WIP board.
        // BUG-2026-04-30-001: SELECT-then-(UPDATE-or-INSERT) raced under
        // concurrent PATCHes for the same wipKey — both legs saw "no row"
        // and both INSERTed, producing duplicate codes (329 dup-groups
        // accumulated by 2026-04-30). Migration 0100 added
        // UNIQUE(org_id, code); this is the matching atomic upsert. On
        // conflict we DECREMENT (EXCLUDED.stockQty is already negative).
        //
        // Type for the stub: when upstream is a merged FC, the stub
        // represents the FC's WIP, NOT this SEW JC's piece. Use
        // itemCategory (BEDFRAME / SOFA / ACCESSORY) so the inventory
        // Type column shows the correct set-level label. Falls back to
        // shortType (SEW's wipType) for the legacy non-FC upstream case.
        const stubType = isMergedFcUpstream
          ? (poRow.itemCategory || shortType)
          : shortType;
        await db
          .prepare(
            `INSERT INTO wip_items (id, code, type, relatedProduct, deptStatus, stockQty, status)
             VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
             ON CONFLICT (org_id, code) DO UPDATE SET
               stockQty = wip_items.stockQty + EXCLUDED.stockQty`,
          )
          .bind(
            `wip-dyn-${crypto.randomUUID().slice(0, 8)}`,
            upstreamLabel,
            stubType,
            poRow.productCode ?? "",
            "PENDING",
            -consumeQty,
          )
          .run();
      }
    }
    // For IN_PROGRESS-only we stop here — COMPLETED falls through to
    // upsert its own wip_items row via the COMPLETED branch below.
    if (newStatus === "IN_PROGRESS") return;
  }

  if (newStatus === "COMPLETED" || newStatus === "TRANSFERRED") {
    if (isUpholstery) {
      // UPH completion semantics (per user's accounting model):
      //   1. SUBTRACT wipQty from each upstream wipKey sibling's stockQty
      //      (was "zero out the lot" — wrong when the wip_items row covers
      //      a higher cumulative qty than this UPH wave: e.g., Fab Sew has
      //      13 in stock, this UPH consumed 7, the remaining 6 should
      //      stay visible, not zero).
      //   2. Upsert UPH's OWN wip_items row so the inventory board shows
      //      "completed-by-Upholstery" stock until Packing picks it up.
      const consumeQty = jcRow.wipQty || poRow.quantity || 1;
      if (wipKey) {
        // BUG-2026-04-27-014: UPH only consumes the BRANCH TERMINAL of each
        // BOM branch — i.e., within each branchKey, the JC at the highest
        // sequence below UPH's. Earlier upstreams in the chain are NOT
        // UPH's direct upstream; their stock is consumed by their own
        // direct downstream dept (FRAMING consumes WOOD_CUT, WEBBING
        // consumes FRAMING, etc.). Per the user: "Webbing missing should
        // not also make Framing/WoodCut negative — those would only go
        // negative if Webbing itself were marked complete with
        // Framing/WoodCut missing." The previous code flattened every
        // upstream wipKey sibling into a Set and decremented all of them,
        // which for a sofa Base BOM (6 upstream JCs) wrote 6 separate
        // -consumeQty entries instead of 2 (one per branch terminal).
        const byBranch = new Map<string, JobCardRow>();
        for (const j of allJcRows) {
          if (j.wipKey !== wipKey) continue;
          if (j.sequence >= jcRow.sequence) continue;
          if (!j.wipLabel) continue;
          const bk = j.branchKey ?? "";
          const cur = byBranch.get(bk);
          if (!cur || j.sequence > cur.sequence) {
            byBranch.set(bk, j);
          }
        }
        for (const [, terminal] of byBranch) {
          const label = terminal.wipLabel!;
          // BUG-2026-04-27-013: cascade consume always decrements (no
          // MAX clamp). If the upstream wip_items row doesn't exist
          // (upstream dept was skipped), INSERT one with negative qty
          // so the WIP board surfaces the missed dept.
          // BUG-2026-04-30-001: race-safe atomic upsert — see migration
          // 0100 + sibling site at the non-UPH consume above.
          await db
            .prepare(
              `INSERT INTO wip_items (id, code, type, relatedProduct, deptStatus, stockQty, status)
               VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
               ON CONFLICT (org_id, code) DO UPDATE SET
                 stockQty = wip_items.stockQty + EXCLUDED.stockQty`,
            )
            .bind(
              `wip-dyn-${crypto.randomUUID().slice(0, 8)}`,
              label,
              shortType,
              poRow.productCode ?? "",
              "PENDING",
              -consumeQty,
            )
            .run();
        }
      }
      // Add UPH's own wip_items row (treat UPH like every other producer
      // dept).  Prior code skipped this and left FG derivation to the
      // frontend — but the user wants visible per-dept WIP rows, and the
      // upsert is idempotent so multiple UPH JCs in the same wipKey
      // accumulate correctly.
      if (wipLabel) {
        // BUG-2026-04-30-001: race-safe atomic upsert (see migration 0100).
        // Original SELECT-then-(UPDATE-or-INSERT) accumulated dupes under
        // concurrent PATCHes. UPDATE leg was additive: existing.stockQty +
        // consumeQty — preserved here as wip_items.stockQty + EXCLUDED.stockQty.
        await db
          .prepare(
            `INSERT INTO wip_items (id, code, type, relatedProduct, deptStatus, stockQty, status)
             VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED')
             ON CONFLICT (org_id, code) DO UPDATE SET
               stockQty = wip_items.stockQty + EXCLUDED.stockQty,
               deptStatus = EXCLUDED.deptStatus,
               status = 'COMPLETED'`,
          )
          .bind(
            `wip-dyn-${crypto.randomUUID().slice(0, 8)}`,
            wipLabel,
            shortType,
            poRow.productCode ?? "",
            "UPHOLSTERY",
            consumeQty,
          )
          .run();
      }

      // BUG-2026-04-30-003 (Plan B): WIP→FG transition mirrors frontend
      // `deriveFGStock` rule (src/pages/inventory/index.tsx:307-322). When
      // ALL UPH JCs in this PO are COMPLETED/TRANSFERRED, the goods
      // conceptually transition to FG. Subtract every UPH JC's +wipQty
      // from wip_items so the ledger no longer carries phantom WIP for
      // goods that the frontend treats as FG. Symmetric with the rollback
      // branch above (BUG-2026-04-30-003 reverse). After this fires the
      // DO LOADED / CN dispatch wip_items writes become redundant and have
      // been removed (see delivery-orders.ts + consignment-note-shared.ts).
      //
      // PER-PO trigger: BEDFRAME has DIVAN+HB UPH JCs in one PO; SOFA has
      // BASE+CUSHION+ARMREST UPH JCs in one PO (see _shared/production-builder
      // SOFA-set logic). Accessory: same. allJcRows already reflects the
      // post-update state (refreshed at the call site).
      const poUphJcs = allJcRows.filter(
        (j) =>
          j.productionOrderId === poRow.id &&
          (j.departmentCode || "").toUpperCase() === "UPHOLSTERY",
      );
      const allUphDone =
        poUphJcs.length > 0 &&
        poUphJcs.every(
          (j) => j.status === "COMPLETED" || j.status === "TRANSFERRED",
        );
      if (allUphDone) {
        for (const uphJc of poUphJcs) {
          if (!uphJc.wipLabel) continue;
          const subQty = uphJc.wipQty || poRow.quantity || 1;
          await db
            .prepare(
              "UPDATE wip_items SET stockQty = stockQty - ? WHERE code = ?",
            )
            .bind(subQty, uphJc.wipLabel)
            .run();
        }
      }
      return;
    }

    // Non-UPH dept: upsert-by-code, accumulate stock on each completion.
    // BUG-2026-04-30-001: race-safe atomic upsert (see migration 0100).
    // Original SELECT-then-(UPDATE-or-INSERT) accumulated dupes under
    // concurrent PATCHes. UPDATE leg was additive: existing.stockQty + wipQty
    // — preserved here as wip_items.stockQty + EXCLUDED.stockQty.
    await db
      .prepare(
        `INSERT INTO wip_items (id, code, type, relatedProduct, deptStatus, stockQty, status)
         VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED')
         ON CONFLICT (org_id, code) DO UPDATE SET
           stockQty = wip_items.stockQty + EXCLUDED.stockQty,
           deptStatus = EXCLUDED.deptStatus,
           status = 'COMPLETED'`,
      )
      .bind(
        `wip-dyn-${crypto.randomUUID().slice(0, 8)}`,
        wipLabel,
        shortType,
        poRow.productCode ?? "",
        jcRow.departmentCode ?? "",
        wipQty,
      )
      .run();
    return;
  }

  if (newStatus === "IN_PROGRESS") {
    const isFabSew =
      (jcRow.departmentCode || "").toUpperCase() === "FAB_SEW";
    const isSofa = (poRow.itemCategory || "").toUpperCase() === "SOFA";

    // Defense-in-depth: UPHOLSTERY's wip_items math fires only at
    // COMPLETED via the branch-terminal loop further up. The IN_PROGRESS
    // default-path consume below relies on `branchKey` being non-empty
    // on the upstream JC AND empty on UPH itself; in today's BOM that's
    // always true so children[0] resolves to undefined and the function
    // safely returns. But the contract is implicit — a future BOM that
    // emits a UPH JC with a non-null branchKey would prematurely consume
    // one branch terminal at IN_PROGRESS. Explicit guard makes this
    // invariant self-documenting.
    if ((jcRow.departmentCode || "").toUpperCase() === "UPHOLSTERY") return;

    // Sofa Fab Sew special case: the Fab Cut merge groups a full sofa
    // set (1A(LHF) + 1NA + 1A(RHF) sharing the same bolt) into one
    // sticker. The moment Fab Sew picks up the stack to start sewing
    // ANY piece of the set, the whole batch has left Fab Cut's shelf
    // — it's physically impossible to only grab one. So the first
    // FAB_SEW IN_PROGRESS in a (SO, fabric) group zeroes every
    // upstream FAB_CUT wip_items row in that group. Subsequent sibling
    // FAB_SEW scans are no-ops because the stock is already 0.
    // CO-aware parent-doc id: SO id OR CO id. Without the CO branch
    // every CO sofa FAB_SEW IN_PROGRESS skipped the FAB_CUT zero-out,
    // leaving the merged FC stock floating until a downstream consume
    // happened to drop it.
    const parentDocId =
      poRow.salesOrderId || poRow.consignmentOrderId || "";
    if (isFabSew && isSofa && parentDocId && poRow.fabricCode) {
      const siblingLabels = await db
        .prepare(
          `SELECT DISTINCT jc.wipLabel AS "wipLabel"
             FROM production_orders po
             JOIN job_cards jc ON jc.productionOrderId = po.id
            WHERE (po.salesOrderId = ? OR po.consignmentOrderId = ?)
              AND ? <> ''
              AND po.fabricCode = ?
              AND po.itemCategory = 'SOFA'
              AND jc.departmentCode = 'FAB_CUT'
              AND jc.wipLabel IS NOT NULL`,
        )
        .bind(parentDocId, parentDocId, parentDocId, poRow.fabricCode)
        .all<{ wipLabel: string | null }>();
      const labels = (siblingLabels.results ?? [])
        .map((r) => r.wipLabel)
        .filter((l): l is string => !!l);
      for (const label of labels) {
        await db
          .prepare(
            "UPDATE wip_items SET stockQty = 0, status = 'IN_PRODUCTION' WHERE code = ?",
          )
          .bind(label)
          .run();
      }
      return;
    }

    // Default path (BF / accessory / non-sofa Fab Sew chains): consume
    // the immediate upstream wip_items row within the same (wipKey,
    // branchKey) by this JC's own qty. Per-JC consumption — each child
    // scan decrements exactly its own share. (wipKey, branchKey) match
    // is BOM-branch aware (see migration 0058).
    const myBranch = jcRow.branchKey ?? "";
    const children = allJcRows
      .filter(
        (j) =>
          j.wipKey === wipKey &&
          (j.branchKey ?? "") === myBranch &&
          j.sequence < jcRow.sequence,
      )
      .sort((a, b) => b.sequence - a.sequence);
    const child = children[0];
    if (!child || !child.wipLabel) return;

    // Atomic conditional UPDATE — was previously SELECT-then-UPDATE,
    // which raced under concurrent WAITING→IN_PROGRESS PATCHes for the
    // same upstream wipLabel (both reads see the pre-decrement stockQty,
    // both writes commit, one decrement is lost). The ON-CONFLICT upsert
    // pattern used in the COMPLETED branch (post-migration 0100) doesn't
    // apply here because we're decrementing an existing row by qty, not
    // upserting a known final value. Use a guarded UPDATE that only
    // mutates rows where stockQty > 0 + computes remaining + status in
    // SQL itself.
    await db
      .prepare(
        `UPDATE wip_items
            SET stockQty = MAX(0, stockQty - ?),
                status = CASE
                  WHEN MAX(0, stockQty - ?) = 0 THEN 'IN_PRODUCTION'
                  ELSE 'COMPLETED'
                END
          WHERE code = ?
            AND stockQty > 0`,
      )
      .bind(wipQty, wipQty, child.wipLabel)
      .run();
  }
}

// ---------------------------------------------------------------------------
// Cascade Upholstery completion → SO READY_TO_SHIP + stockedIn flags.
// Mirrors the in-memory cascadeUpholsteryToSO().
// ---------------------------------------------------------------------------
async function cascadeUpholsteryToSO(
  db: D1Database,
  poId: string,
): Promise<void> {
  const po = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(poId)
    .first<ProductionOrderRow>();
  if (!po || !po.salesOrderId) return;
  const so = await db
    .prepare("SELECT id, status FROM sales_orders WHERE id = ?")
    .bind(po.salesOrderId)
    .first<{ id: string; status: string }>();
  if (!so) return;

  const siblings = await db
    .prepare("SELECT * FROM production_orders WHERE salesOrderId = ?")
    .bind(so.id)
    .all<ProductionOrderRow>();
  const siblingPOs = siblings.results ?? [];
  if (siblingPOs.length === 0) return;

  // Load all upholstery job cards for siblings in one go.
  const sibIds = siblingPOs.map((p) => p.id);
  const placeholders = sibIds.map(() => "?").join(",");
  const uphRes = await db
    .prepare(
      `SELECT * FROM job_cards WHERE departmentCode = 'UPHOLSTERY' AND productionOrderId IN (${placeholders})`,
    )
    .bind(...sibIds)
    .all<JobCardRow>();
  const uphJcs = uphRes.results ?? [];
  if (uphJcs.length === 0) return;

  const everyUphDone = siblingPOs.every((p) => {
    const mine = uphJcs.filter((j) => j.productionOrderId === p.id);
    if (mine.length === 0) return true;
    return mine.every((j) => j.status === "COMPLETED" || j.status === "TRANSFERRED");
  });

  const now = new Date().toISOString();
  if (everyUphDone) {
    for (const p of siblingPOs) {
      const mine = uphJcs.filter((j) => j.productionOrderId === p.id);
      if (
        mine.length > 0 &&
        mine.every((j) => j.status === "COMPLETED" || j.status === "TRANSFERRED")
      ) {
        await db
          .prepare("UPDATE production_orders SET stockedIn = 1 WHERE id = ?")
          .bind(p.id)
          .run();
      }
    }
    if (so.status !== "READY_TO_SHIP") {
      await db
        .prepare(
          "UPDATE sales_orders SET status = 'READY_TO_SHIP', updated_at = ? WHERE id = ?",
        )
        .bind(now, so.id)
        .run();
    }
  } else if (so.status === "READY_TO_SHIP") {
    // 2026-04-28: cascade rollback now drops back to IN_PRODUCTION, matching
    // the new "any confirm = in production" semantics. Previously fell back
    // to CONFIRMED, which was a steady state that no longer exists.
    await db
      .prepare(
        "UPDATE sales_orders SET status = 'IN_PRODUCTION', updated_at = ? WHERE id = ?",
      )
      .bind(now, so.id)
      .run();
  }
}

// ---------------------------------------------------------------------------
// CO-parity twin of cascadeUpholsteryToSO. POs originating from a CO carry
// consignmentOrderId set + salesOrderId NULL, so this branch no-ops on
// SO-sourced POs and the SO branch no-ops on CO-sourced POs — both cascades
// run unconditionally from the JC-update site, exactly one fires per PO.
//
// Forward path: every sibling CO PO has all UPH JCs COMPLETED/TRANSFERRED →
// CO flips to READY_TO_SHIP and stockedIn=1 is stamped on each fully-UPH PO.
// Rollback path: any UPH JC drops back to non-DONE while CO is at
// READY_TO_SHIP → CO drops back to IN_PRODUCTION (same "any confirm = in
// production" semantics as the SO twin). No status_changes audit row yet —
// consignment_order_status_changes table is still TODO (see /status-changes
// stub in routes/consignment-orders.ts).
// ---------------------------------------------------------------------------
async function cascadeUpholsteryToCO(
  db: D1Database,
  poId: string,
): Promise<void> {
  const po = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(poId)
    .first<ProductionOrderRow>();
  if (!po || !po.consignmentOrderId) return;
  const co = await db
    .prepare("SELECT id, status FROM consignment_orders WHERE id = ?")
    .bind(po.consignmentOrderId)
    .first<{ id: string; status: string }>();
  if (!co) return;

  const siblings = await db
    .prepare("SELECT * FROM production_orders WHERE consignmentOrderId = ?")
    .bind(co.id)
    .all<ProductionOrderRow>();
  const siblingPOs = siblings.results ?? [];
  if (siblingPOs.length === 0) return;

  // Load all upholstery job cards for siblings in one go.
  const sibIds = siblingPOs.map((p) => p.id);
  const placeholders = sibIds.map(() => "?").join(",");
  const uphRes = await db
    .prepare(
      `SELECT * FROM job_cards WHERE departmentCode = 'UPHOLSTERY' AND productionOrderId IN (${placeholders})`,
    )
    .bind(...sibIds)
    .all<JobCardRow>();
  const uphJcs = uphRes.results ?? [];
  if (uphJcs.length === 0) return;

  const everyUphDone = siblingPOs.every((p) => {
    const mine = uphJcs.filter((j) => j.productionOrderId === p.id);
    if (mine.length === 0) return true;
    return mine.every((j) => j.status === "COMPLETED" || j.status === "TRANSFERRED");
  });

  const now = new Date().toISOString();
  if (everyUphDone) {
    for (const p of siblingPOs) {
      const mine = uphJcs.filter((j) => j.productionOrderId === p.id);
      if (
        mine.length > 0 &&
        mine.every((j) => j.status === "COMPLETED" || j.status === "TRANSFERRED")
      ) {
        await db
          .prepare("UPDATE production_orders SET stockedIn = 1 WHERE id = ?")
          .bind(p.id)
          .run();
      }
    }
    if (co.status !== "READY_TO_SHIP") {
      await db.batch([
        db
          .prepare(
            "UPDATE consignment_orders SET status = 'READY_TO_SHIP', updated_at = ? WHERE id = ?",
          )
          .bind(now, co.id),
        db
          .prepare(
            `INSERT INTO co_status_changes
               (id, co_id, from_status, to_status, changed_by, timestamp, notes, auto_actions)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            `cosc-${crypto.randomUUID().slice(0, 8)}`,
            co.id,
            co.status,
            "READY_TO_SHIP",
            "System",
            now,
            "All sibling COs' UPH job cards completed",
            JSON.stringify([
              `PO ${poId} UPH completion bumped CO to READY_TO_SHIP`,
            ]),
          ),
      ]);
    }
  } else if (co.status === "READY_TO_SHIP") {
    // Mirror the SO twin: rollback drops back to IN_PRODUCTION + clears
    // stockedIn on every PO whose UPH set is no longer fully done. Without
    // the stockedIn clear, the SO twin's BUG-2026-04-27-020 fix (line
    // ~2148) would be one-sided — CO POs would keep stockedIn=1 forever
    // after a UPH undo.
    await db.batch([
      db
        .prepare(
          "UPDATE consignment_orders SET status = 'IN_PRODUCTION', updated_at = ? WHERE id = ?",
        )
        .bind(now, co.id),
      db
        .prepare(
          `INSERT INTO co_status_changes
             (id, co_id, from_status, to_status, changed_by, timestamp, notes, auto_actions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `cosc-${crypto.randomUUID().slice(0, 8)}`,
          co.id,
          "READY_TO_SHIP",
          "IN_PRODUCTION",
          "System",
          now,
          "UPH job card rolled back to non-DONE",
          JSON.stringify([
            `PO ${poId} UPH rolled back — CO no longer fully upholstered`,
          ]),
        ),
    ]);
    for (const p of siblingPOs) {
      if (!p.stockedIn) continue;
      const mine = uphJcs.filter((j) => j.productionOrderId === p.id);
      const stillFullyDone =
        mine.length > 0 &&
        mine.every(
          (j) => j.status === "COMPLETED" || j.status === "TRANSFERRED",
        );
      if (!stillFullyDone) {
        await db
          .prepare("UPDATE production_orders SET stockedIn = 0 WHERE id = ?")
          .bind(p.id)
          .run();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// BUG-2026-04-27-020: rollback companion to cascadeUpholsteryToSO.
//
// `cascadeUpholsteryToSO` (the forward path) bumps the SO to READY_TO_SHIP
// once every sibling PO under the SO has all UPH JCs in COMPLETED/TRANSFERRED.
// When an operator un-completes a UPH JC (via the dept Production Sheet
// date-cell or the form), the BUG-2026-04-27-002 rollback inside
// `applyWipInventoryChange` correctly refunds the wip_items numbers, but
// without this companion the SO stays wedged at READY_TO_SHIP — the SO
// thinks it's good to ship even though one of its UPH JCs is back to
// WAITING.
//
// This helper is gated on the JC actually transitioning OUT of a DONE
// status (the caller passes prevStatus from the pre-UPDATE row), and only
// fires for UPH JCs (other depts don't drive the READY_TO_SHIP cascade).
// It re-runs the same condition the forward path uses ("every sibling PO
// is fully UPH-complete"); if it's no longer true and the SO is currently
// at READY_TO_SHIP, we flip back to IN_PRODUCTION and emit a so_status_changes
// audit row mirroring the forward audit pattern in sales-orders.ts.
//
// `stockedIn` on this PO is also cleared, since the corresponding forward
// path sets stockedIn=1 once UPH is done — symmetric reverse keeps the
// flag truthful.
// ---------------------------------------------------------------------------
async function cascadeUpholsteryRollbackToSO(
  db: D1Database,
  poId: string,
  actorName: string,
): Promise<void> {
  const po = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(poId)
    .first<ProductionOrderRow>();
  if (!po || !po.salesOrderId) return;

  // Clear stockedIn on this PO — the forward cascade flips it to 1 when UPH
  // completes; rolling a UPH JC back means the PO is no longer fully
  // upholstered and the flag is now wrong.
  if (po.stockedIn) {
    await db
      .prepare("UPDATE production_orders SET stockedIn = 0 WHERE id = ?")
      .bind(po.id)
      .run();
  }

  const so = await db
    .prepare("SELECT id, status FROM sales_orders WHERE id = ?")
    .bind(po.salesOrderId)
    .first<{ id: string; status: string }>();
  if (!so) return;

  // Only act when the SO currently thinks it's READY_TO_SHIP — if it's
  // already IN_PRODUCTION (or any earlier state), there's nothing to undo.
  if (so.status !== "READY_TO_SHIP") return;

  const siblings = await db
    .prepare("SELECT id FROM production_orders WHERE salesOrderId = ?")
    .bind(so.id)
    .all<{ id: string }>();
  const siblingPOs = siblings.results ?? [];
  if (siblingPOs.length === 0) return;

  const sibIds = siblingPOs.map((p) => p.id);
  const placeholders = sibIds.map(() => "?").join(",");
  const uphRes = await db
    .prepare(
      `SELECT productionOrderId, status FROM job_cards
        WHERE departmentCode = 'UPHOLSTERY' AND productionOrderId IN (${placeholders})`,
    )
    .bind(...sibIds)
    .all<{ productionOrderId: string; status: string }>();
  const uphJcs = uphRes.results ?? [];

  // Mirror the forward path: every sibling PO must have all its UPH JCs in
  // COMPLETED/TRANSFERRED for the SO to remain READY_TO_SHIP. POs with no
  // UPH JCs at all are treated as vacuous-true (matches the forward path).
  const everyUphDone = siblingPOs.every((p) => {
    const mine = uphJcs.filter((j) => j.productionOrderId === p.id);
    if (mine.length === 0) return true;
    return mine.every(
      (j) => j.status === "COMPLETED" || j.status === "TRANSFERRED",
    );
  });
  if (everyUphDone) return; // Forward condition still holds — nothing to undo.

  const now = new Date().toISOString();
  // 2026-04-28: UPH-undo rollback now drops READY_TO_SHIP back to
  // IN_PRODUCTION, matching the new "any confirm = in production" semantics.
  // Previously dropped to CONFIRMED.
  await db.batch([
    db
      .prepare(
        "UPDATE sales_orders SET status = 'IN_PRODUCTION', updated_at = ? WHERE id = ?",
      )
      .bind(now, so.id),
    db
      .prepare(
        `INSERT INTO so_status_changes
           (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `sc-${crypto.randomUUID().slice(0, 8)}`,
        so.id,
        "READY_TO_SHIP",
        "IN_PRODUCTION",
        actorName,
        now,
        "UPH job card rolled back to non-DONE",
        JSON.stringify([
          `PO ${po.poNo} UPH rolled back — SO no longer fully upholstered`,
        ]),
      ),
  ]);
}

// Cascade when a PO itself reaches COMPLETED (not just Upholstery). Bumps SO
// to READY_TO_SHIP once every sibling is fully done.
async function cascadePoCompletionToSO(
  db: D1Database,
  salesOrderId: string | null,
): Promise<void> {
  if (!salesOrderId) return;
  const so = await db
    .prepare("SELECT id, status FROM sales_orders WHERE id = ?")
    .bind(salesOrderId)
    .first<{ id: string; status: string }>();
  if (!so) return;
  const siblings = await db
    .prepare("SELECT status FROM production_orders WHERE salesOrderId = ?")
    .bind(salesOrderId)
    .all<{ status: string }>();
  const sibList = siblings.results ?? [];
  const allDone = sibList.length > 0 && sibList.every((p) => p.status === "COMPLETED");
  if (allDone && so.status !== "READY_TO_SHIP") {
    await db
      .prepare(
        "UPDATE sales_orders SET status = 'READY_TO_SHIP', updated_at = ? WHERE id = ?",
      )
      .bind(new Date().toISOString(), salesOrderId)
      .run();
  }
}

// CO-parity twin of cascadePoCompletionToSO. CO inherits the same production
// pipeline through the shared `createProductionOrdersForOrder` helper — POs
// originating from a CO carry consignmentOrderId set + salesOrderId NULL, so
// the same "all sibling POs COMPLETED → parent flips to READY_TO_SHIP" rule
// applies. Both cascades are invoked from the same PO-completion sites; one
// no-ops on null FK while the other fires.
async function cascadePoCompletionToCO(
  db: D1Database,
  consignmentOrderId: string | null,
): Promise<void> {
  if (!consignmentOrderId) return;
  const co = await db
    .prepare("SELECT id, status FROM consignment_orders WHERE id = ?")
    .bind(consignmentOrderId)
    .first<{ id: string; status: string }>();
  if (!co) return;
  const siblings = await db
    .prepare("SELECT status FROM production_orders WHERE consignmentOrderId = ?")
    .bind(consignmentOrderId)
    .all<{ status: string }>();
  const sibList = siblings.results ?? [];
  const allDone = sibList.length > 0 && sibList.every((p) => p.status === "COMPLETED");
  if (allDone && co.status !== "READY_TO_SHIP") {
    const now = new Date().toISOString();
    await db.batch([
      db
        .prepare(
          "UPDATE consignment_orders SET status = 'READY_TO_SHIP', updated_at = ? WHERE id = ?",
        )
        .bind(now, consignmentOrderId),
      db
        .prepare(
          `INSERT INTO co_status_changes
             (id, co_id, from_status, to_status, changed_by, timestamp, notes, auto_actions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `cosc-${crypto.randomUUID().slice(0, 8)}`,
          consignmentOrderId,
          co.status,
          "READY_TO_SHIP",
          "System",
          now,
          "All sibling POs COMPLETED",
          JSON.stringify(["PO completion cascade bumped CO to READY_TO_SHIP"]),
        ),
    ]);
  }
}

// ----------------------------------------------------------------------------
// CN-completion cascade — DO-parity twin (gap 1, audit fix 2026-04-29).
//
// DO's PUT /:id flips sales_orders.status='DELIVERED' once the DO crosses
// to DELIVERED (delivery-orders.ts ~lines 1633-1660). CN had no parallel:
// once every CN under a CO went FULLY_SOLD or CLOSED, the parent CO sat
// frozen at READY_TO_SHIP forever. This helper closes that gap.
//
// Called from updateConsignmentNoteById (consignment-note-shared.ts) AFTER
// the main UPDATE statement, when nextStatus IN ('FULLY_SOLD','CLOSED')
// AND existing.consignmentOrderId is set. Also called from convert-to-
// invoice in consignment-notes.ts after that route bumps the CN to
// FULLY_SOLD.
//
// Idempotent: if the CO is already DELIVERED, this is a no-op. Re-running
// after every CN status change is safe.
// ----------------------------------------------------------------------------
export async function cascadeCNCompletionToCO(
  db: D1Database,
  consignmentOrderId: string | null,
): Promise<void> {
  if (!consignmentOrderId) return;
  const co = await db
    .prepare("SELECT id, status FROM consignment_orders WHERE id = ?")
    .bind(consignmentOrderId)
    .first<{ id: string; status: string }>();
  if (!co) return;
  const siblings = await db
    .prepare("SELECT status FROM consignment_notes WHERE consignmentOrderId = ?")
    .bind(consignmentOrderId)
    .all<{ status: string }>();
  const sibList = siblings.results ?? [];
  // Need at least one CN AND every CN must be FULLY_SOLD or CLOSED.
  // RETURNED is intentionally NOT counted as "done" — the goods came back,
  // the CO should not flip DELIVERED.
  const allDone =
    sibList.length > 0 &&
    sibList.every((c) => c.status === "FULLY_SOLD" || c.status === "CLOSED");
  if (allDone && co.status !== "DELIVERED") {
    const now = new Date().toISOString();
    await db.batch([
      db
        .prepare(
          "UPDATE consignment_orders SET status = 'DELIVERED', updated_at = ? WHERE id = ?",
        )
        .bind(now, consignmentOrderId),
      db
        .prepare(
          `INSERT INTO co_status_changes
             (id, co_id, from_status, to_status, changed_by, timestamp, notes, auto_actions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `cosc-${crypto.randomUUID().slice(0, 8)}`,
          consignmentOrderId,
          co.status,
          "DELIVERED",
          "System",
          now,
          "All sibling CNs FULLY_SOLD or CLOSED",
          JSON.stringify(["CN completion cascade bumped CO to DELIVERED"]),
        ),
    ]);
  }
}

// CN-completion REVERSAL twin. When a CN reverses below FULLY_SOLD AND the
// parent CO has been bumped to DELIVERED by a prior cascadeCNCompletionToCO
// call, flip it back to READY_TO_SHIP so the CO no longer reads as completed.
//
// DO doesn't have an equivalent SO bump-back: once a SO crosses to
// DELIVERED via DO cascade, reversing the DO does not bump the SO back —
// the operator handles that manually if desired (delivery-orders.ts is
// silent on the reverse path for the SO cascade). For CN we mirror that
// model by ONLY bumping back if the CO is currently DELIVERED — otherwise
// we leave it alone. This keeps the cascade strictly additive: no
// surprises, no clobbering an operator-set state.
export async function cascadeCNReversalToCO(
  db: D1Database,
  consignmentOrderId: string | null,
): Promise<void> {
  if (!consignmentOrderId) return;
  const co = await db
    .prepare("SELECT id, status FROM consignment_orders WHERE id = ?")
    .bind(consignmentOrderId)
    .first<{ id: string; status: string }>();
  if (!co) return;
  if (co.status !== "DELIVERED") return; // Only bump back from DELIVERED.
  // Re-check: if sibling CNs are still all FULLY_SOLD/CLOSED, do nothing.
  const siblings = await db
    .prepare("SELECT status FROM consignment_notes WHERE consignmentOrderId = ?")
    .bind(consignmentOrderId)
    .all<{ status: string }>();
  const sibList = siblings.results ?? [];
  const stillAllDone =
    sibList.length > 0 &&
    sibList.every((c) => c.status === "FULLY_SOLD" || c.status === "CLOSED");
  if (stillAllDone) return;
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "UPDATE consignment_orders SET status = 'READY_TO_SHIP', updated_at = ? WHERE id = ?",
      )
      .bind(now, consignmentOrderId),
    db
      .prepare(
        `INSERT INTO co_status_changes
           (id, co_id, from_status, to_status, changed_by, timestamp, notes, auto_actions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `cosc-${crypto.randomUUID().slice(0, 8)}`,
        consignmentOrderId,
        "DELIVERED",
        "READY_TO_SHIP",
        "System",
        now,
        "CN reversed below FULLY_SOLD — CO no longer fully delivered",
        JSON.stringify(["CN reversal cascade dropped CO from DELIVERED"]),
      ),
  ]);
}

// Track F cost cascade lives in ../lib/po-cost-cascade.ts and is wired
// through postProductionOrderCompletion() + postJobCardLabor() below.

// ---------------------------------------------------------------------------
// recomputePoStatusAndProgress — single source of truth for PO.status +
// PO.progress + PO.completedDate roll-up off the JC view.
//
// FE-BE consistency audit (2026-05-07) found PO.status was set to "PENDING"
// at PO creation (production-builder.ts:804) and never updated again —
// dashboard "Active Jobs" and "In Queue" tiles were silently broken.
// PO.progress was likewise a dead column the FE never read but the API
// surfaced. This helper rolls both forward whenever a JC mutates so any
// reader sees real values.
//
// Rules:
//   • status — All JCs done (COMPLETED/TRANSFERRED) → "COMPLETED".
//     Any JC IN_PROGRESS or PAUSED → "IN_PROGRESS".
//     Otherwise → "PENDING".
//     ON_HOLD / CANCELLED are admin states — left alone.
//   • progress — piece-level (sum of wipQty for done JCs ÷ sum of wipQty
//     for all JCs × 100). Mirrors the production page's cell math so the
//     two views stop disagreeing.
//   • completedDate — only set when transitioning to COMPLETED. Pulled
//     from the latest JC.completedDate; falls back to today if none
//     present (edge case for backfilled rows).
//
// Idempotent — only writes when something actually changed. Never
// overwrites ON_HOLD / CANCELLED. Returns the diff for diagnostics
// (used by the backfill endpoint).
// ---------------------------------------------------------------------------
export async function recomputePoStatusAndProgress(
  db: D1Database,
  poId: string,
): Promise<{
  changed: boolean;
  statusChanged: boolean;
  progressChanged: boolean;
  completedDateChanged: boolean;
  before: { status: string; progress: number; completedDate: string | null } | null;
  after: { status: string; progress: number; completedDate: string | null } | null;
}> {
  const noop = {
    changed: false,
    statusChanged: false,
    progressChanged: false,
    completedDateChanged: false,
    before: null,
    after: null,
  };
  const poRow = await db
    .prepare(
      `SELECT status, progress, completedDate FROM production_orders WHERE id = ?`,
    )
    .bind(poId)
    .first<{ status: string; progress: number; completedDate: string | null }>();
  if (!poRow) return noop;

  // Admin states are sticky — exit before touching anything.
  if (poRow.status === "ON_HOLD" || poRow.status === "CANCELLED") return noop;

  const sibs = await db
    .prepare(
      `SELECT id, status, completedDate, wipQty, sequence
         FROM job_cards
        WHERE productionOrderId = ?`,
    )
    .bind(poId)
    .all<{
      id: string;
      status: string;
      completedDate: string | null;
      wipQty: number | null;
      sequence: number;
    }>();
  const allJcs = sibs.results ?? [];

  const isDone = (s: string) => s === "COMPLETED" || s === "TRANSFERRED";
  const isInProgress = (s: string) => s === "IN_PROGRESS" || s === "PAUSED";

  let derivedStatus: "PENDING" | "IN_PROGRESS" | "COMPLETED" = "PENDING";
  if (allJcs.length > 0) {
    if (allJcs.every((j) => isDone(j.status))) derivedStatus = "COMPLETED";
    else if (allJcs.some((j) => isInProgress(j.status))) derivedStatus = "IN_PROGRESS";
  }

  // Piece-level progress so the dashboard / production page agree.
  let pieces = 0;
  let donePieces = 0;
  for (const j of allJcs) {
    const t = Math.max(1, j.wipQty ?? 1);
    pieces += t;
    if (isDone(j.status)) donePieces += t;
  }
  const newProgress = pieces > 0 ? Math.round((donePieces / pieces) * 100) : 0;

  let newCompletedDate: string | null = poRow.completedDate ?? null;
  if (derivedStatus === "COMPLETED") {
    const dates = allJcs
      .map((j) => j.completedDate || "")
      .filter(Boolean)
      .sort();
    newCompletedDate =
      dates.length > 0
        ? dates[dates.length - 1]
        : (poRow.completedDate ?? new Date().toISOString().slice(0, 10));
  }

  const statusChanged = poRow.status !== derivedStatus;
  const progressChanged = (poRow.progress ?? 0) !== newProgress;
  const completedDateChanged =
    derivedStatus === "COMPLETED" &&
    (poRow.completedDate ?? null) !== (newCompletedDate ?? null);

  if (!statusChanged && !progressChanged && !completedDateChanged) {
    return {
      changed: false,
      statusChanged: false,
      progressChanged: false,
      completedDateChanged: false,
      before: { ...poRow },
      after: { ...poRow },
    };
  }

  const finalStatus = statusChanged ? derivedStatus : poRow.status;
  const finalCompleted = completedDateChanged
    ? newCompletedDate
    : (poRow.completedDate ?? null);
  await db
    .prepare(
      `UPDATE production_orders
          SET status = ?, progress = ?, completedDate = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(
      finalStatus,
      newProgress,
      finalCompleted,
      new Date().toISOString(),
      poId,
    )
    .run();

  return {
    changed: true,
    statusChanged,
    progressChanged,
    completedDateChanged,
    before: { ...poRow },
    after: {
      status: finalStatus,
      progress: newProgress,
      completedDate: finalCompleted,
    },
  };
}

// ---------------------------------------------------------------------------
// Core PO-update logic shared between PUT and PATCH.
// ---------------------------------------------------------------------------
async function applyPoUpdate(
  c: Context<Env>,
  id: string,
): Promise<Response> {
  const db = c.var.DB;
  const existing = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(id)
    .first<ProductionOrderRow>();
  if (!existing) {
    return c.json({ success: false, error: "Production order not found" }, 404);
  }
  // Cascade lock — once a Delivery Order (or Consignment Note) references
  // the parent SO/CO, the PO's identity (quantity, productCode, dueDate)
  // is committed downstream and edits would corrupt the shipment trail.
  // Job-card status flips and per-PIC scans bypass the lock — those are
  // operational-flow events, not PO identity edits. Identity edits go
  // through body.quantity / body.productCode / body.targetEndDate / body.poNo.
  const body = await c.req.json();
  const isIdentityEdit =
    body.quantity != null ||
    body.productCode != null ||
    body.targetEndDate != null ||
    body.poNo != null;
  if (isIdentityEdit) {
    const lockMsg = await checkProductionOrderLocked(c.var.DB, id);
    if (lockMsg) {
      return c.json(lockedResponse(lockMsg), 403);
    }
  }
  const nowIso = new Date().toISOString();
  const today = nowIso.split("T")[0];

  // Load all job cards for this PO — used for wip-cascade and progress calc.
  const jcRes = await db
    .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
    .bind(id)
    .all<JobCardRow>();
  const allJcRows = jcRes.results ?? [];

  // currentDepartment is the only PO scalar derived inline — it doesn't
  // belong in recomputePoStatusAndProgress (that helper is shared with
  // the backfill endpoint where currentDepartment isn't on the rewrite
  // surface). status / progress / completedDate are derived off the JC
  // view by the helper.
  let updatedCurrentDept = existing.currentDepartment ?? "";
  // BUG-2026-04-27-020: track when this PATCH rolls a UPHOLSTERY JC out of
  // a DONE state so the SO-rollback companion to cascadeUpholsteryToSO
  // fires after the JC + PO UPDATEs commit. Set inside the body.jobCardId
  // block, consumed near the existing cascadeUpholsteryToSO call below.
  let uphRollbackTriggered = false;

  if (body.jobCardId) {
    const jcRow = allJcRows.find((j) => j.id === body.jobCardId);
    if (!jcRow) {
      return c.json({ success: false, error: "Job card not found" }, 404);
    }

    // ---- PO lock guard -----------------------------------------------------
    // If the parent PO is ON_HOLD or CANCELLED, reject any job-card mutation
    // from this endpoint. Mirrors the scan-complete guard so the shop floor
    // and admin PATCH path agree: paused/cancelled work cannot advance until
    // the SO supervisor resumes or reopens the order.
    if (existing.status === "ON_HOLD" || existing.status === "CANCELLED") {
      return c.json(
        {
          success: false,
          code: "PO_LOCKED",
          error: `Cannot modify job card — parent PO is ${existing.status}.`,
        },
        409,
      );
    }

    // Upstream-lock disabled (2026-04-26, user request).
    //
    // The wipKey + sequence predicate doesn't model the BOM tree's parallel
    // branches: within one wipKey ("DIVAN" / "HEADBOARD" / "SOFA_*") the
    // FAB chain (FAB_CUT→FAB_SEW…) and WOOD chain (WOOD_CUT→FRAMING→
    // WEBBING…) run independently and only converge at UPHOLSTERY. The
    // previous predicate treated WOOD_CUT (sequence 3) as downstream of
    // FAB_CUT/FAB_SEW (sequences 1/2), so completing Wood Cut wrongly 409'd
    // pure-date edits on the fabric branch. Frontend lock UI is also a
    // no-op (see src/pages/production/index.tsx buildSched). Will be
    // restored once the lock chain is derived from the actual BOM template
    // at runtime.

    // Mutate a shallow copy — final UPDATE statement below writes it.
    const updated: JobCardRow = { ...jcRow };

    if (body.status) {
      updated.status = body.status;
      const isDone = body.status === "COMPLETED" || body.status === "TRANSFERRED";
      const wasDone =
        jcRow.status === "COMPLETED" || jcRow.status === "TRANSFERRED";
      // BUG-2026-04-27-020: detect UPH rollback (DONE → non-DONE on a
      // UPHOLSTERY JC). The SO-rollback helper runs after the PO UPDATE
      // below, mirroring how the forward cascadeUpholsteryToSO is invoked.
      if (
        wasDone &&
        !isDone &&
        (jcRow.departmentCode || "").toUpperCase() === "UPHOLSTERY"
      ) {
        uphRollbackTriggered = true;
      }
      if (isDone) {
        if (!updated.completedDate) updated.completedDate = today;
        updated.overdue = "COMPLETED";
      } else if (wasDone && body.completedDate === undefined) {
        // BUG-2026-04-27-001: previously cleared completedDate on ANY
        // non-DONE status change (including WAITING → IN_PROGRESS, which
        // shouldn't touch the date). Now only clear when the JC is
        // genuinely transitioning OUT of a DONE state — i.e. the user is
        // un-completing it. Other status touches (PIC re-assign that
        // re-sends status, due-date edit that includes status) leave the
        // date alone.
        updated.completedDate = null;
      }
    }

    if (body.completedDate !== undefined) {
      updated.completedDate = body.completedDate || null;
    }

    if (body.pic1Id !== undefined) {
      updated.pic1Id = body.pic1Id;
      if (body.pic1Id) {
        const w = await db
          .prepare("SELECT name FROM workers WHERE id = ?")
          .bind(body.pic1Id)
          .first<{ name: string }>();
        updated.pic1Name = w?.name ?? "";
      } else {
        updated.pic1Name = "";
      }
    }
    if (body.pic2Id !== undefined) {
      updated.pic2Id = body.pic2Id;
      if (body.pic2Id) {
        const w = await db
          .prepare("SELECT name FROM workers WHERE id = ?")
          .bind(body.pic2Id)
          .first<{ name: string }>();
        updated.pic2Name = w?.name ?? "";
      } else {
        updated.pic2Name = "";
      }
    }

    if (body.actualMinutes !== undefined) {
      updated.actualMinutes = body.actualMinutes;
    }
    if (body.dueDate !== undefined) updated.dueDate = body.dueDate;
    if (body.rackingNumber !== undefined) {
      updated.rackingNumber = body.rackingNumber;
    }
    // distributedAt — ISO string ("now") to mark the JC as sent to floor;
    // null to untick. The dept-sheet operator clicks the "Sent" checkbox
    // and the FE sends the resolved value. Schema column added by
    // ensurePendingMigrations on first PATCH per isolate.
    if (body.distributedAt !== undefined) {
      updated.distributedAt = body.distributedAt;
    }

    await db
      .prepare(
        `UPDATE job_cards SET
           status = ?, completedDate = ?, pic1Id = ?, pic1Name = ?,
           pic2Id = ?, pic2Name = ?, actualMinutes = ?, dueDate = ?,
           rackingNumber = ?, overdue = ?, distributedAt = ?
         WHERE id = ?`,
      )
      .bind(
        // Coerce every nullable column to `null` because the Postgres
        // driver rejects `undefined` with UNDEFINED_VALUE. Undefined
        // creeps in for two reasons: (a) a JC row fetched via SELECT *
        // before a self-applying ALTER TABLE landed has the new
        // column key absent from the row object, so spread copies
        // leave it undefined; (b) optional body fields are only
        // assigned in `if (body.X !== undefined)` branches, and an
        // unrelated PATCH path may not initialize them on `updated`
        // at all.
        updated.status,
        updated.completedDate ?? null,
        updated.pic1Id ?? null,
        updated.pic1Name ?? null,
        updated.pic2Id ?? null,
        updated.pic2Name ?? null,
        updated.actualMinutes ?? null,
        updated.dueDate ?? null,
        updated.rackingNumber ?? null,
        updated.overdue ?? null,
        updated.distributedAt ?? null,
        updated.id,
      )
      .run();

    // Google Sheets sync — fire-and-forget. Push the freshly-updated JC
    // row to its dept tab so the spreadsheet stays mirror-accurate. Helper
    // silently no-ops when GOOGLE_SHEETS_SA_KEY is missing; failures are
    // logged but never void this UPDATE. See docs/SHEETS-SYNC.md.
    scheduleFireAndForget(c, fireAndForgetSyncJc(c, updated, existing));

    // Phase 6 — parallel event log. Diff the JC snapshot before/after and
    // append one row per field that actually changed. `actorUserId` is
    // stashed on the Hono ctx by authMiddleware; for worker-portal calls
    // it's absent (the PIN flow mounts under /api/worker/* which bypasses
    // the dashboard auth gate), so actorUserId may legitimately be null.
    // Source is 'ui' here — the shop-floor scan path lives in its own
    // handler (scan-complete) and will wire its own 'scan' source later.
    const actorUserId = (c.get as unknown as (k: string) => string | undefined)(
      "userId",
    ) ?? null;
    const events = diffJobCardEvents(jcRow, updated, {
      actorUserId,
      actorName: null,
      source: "ui",
    });
    if (events.length > 0) {
      // Batch the event INSERTs so we pay one round-trip regardless of
      // how many fields changed. Event-write failures do NOT roll back the
      // JC UPDATE (already run()), so a batch reject here just means we
      // lose audit rows for this one mutation — acceptable for a v1
      // parallel write path. Any failure will surface in wrangler tail.
      const stmts = events.map((e) => buildJobCardEventStatement(db, e));
      try {
        await db.batch(stmts);
      } catch (err) {
        // Sprint 2 task 6 — instead of silently losing the audit batch,
        // dead-letter the original payload so a replay sweeper can pick
        // it up once the underlying issue is fixed (schema drift, D1
        // transient, etc.). console.error is kept so wrangler tail still
        // surfaces the issue in real time.
        console.error("[jc-events] append failed — DLQ-ing", err);
        try {
          const dlqId = `dlq_${crypto.randomUUID().slice(0, 12)}`;
          const errMsg =
            (err instanceof Error ? err.message : String(err)).slice(0, 1024);
          await db
            .prepare(
              `INSERT INTO audit_dlq
                 (id, original_payload, error_message, error_kind, attempted_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(
              dlqId,
              JSON.stringify(events),
              errMsg,
              "job_card_events.batch_failed",
              new Date().toISOString(),
            )
            .run();
        } catch (dlqErr) {
          // If even the DLQ write fails, we've exhausted graceful options.
          // Log loudly so ops can pull the values out of wrangler tail.
          console.error(
            "[jc-events] DLQ write also failed — events dropped on the floor",
            { events, originalErr: err, dlqErr },
          );
        }
      }
    }

    // Update WIP inventory if status changed.
    //
    // Defensive try/catch (Bug 3, 2026-04-26): a runtime exception inside the
    // WIP cascade — a missing wip_items row, a transient D1 hiccup, a
    // synthesized-label collision — used to bubble up to Hono's default 500
    // handler and surface as "Update applied to 0/1 components" in the UI,
    // even though the job_card UPDATE at line 1383 already committed. The
    // cascade is supplementary inventory bookkeeping; failing it must NOT
    // void the operator's primary write. Log + continue so the PATCH still
    // returns 200 + the updated payload.
    if (body.status) {
      const refreshed = allJcRows.map((j) => (j.id === updated.id ? updated : j));
      try {
        // Pass prevStatus (jcRow.status, the pre-update value) so the
        // cascade can detect a DONE → non-DONE rollback and reverse the
        // forward consume + producer-add. See BUG-2026-04-27-002.
        await applyWipInventoryChange(
          db,
          existing,
          updated,
          body.status,
          refreshed,
          jcRow.status,
        );
      } catch (err) {
        console.error("[applyWipInventoryChange] cascade failed", {
          poId: id,
          jobCardId: updated.id,
          dept: updated.departmentCode,
          status: body.status,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // F2 — labor cost posting on job_card COMPLETED/TRANSFERRED transition.
    // Idempotent: postJobCardLabor checks cost_ledger for existing LABOR_POSTED
    // entries keyed by refType='JOB_CARD', refId=jc.id.
    //
    // Same defensive wrap as above — a labor-ledger insert failure must not
    // void the JC status flip. The ledger write is recoverable separately
    // (idempotent re-run via PATCH), so swallowing once is safe.
    if (
      body.status &&
      (body.status === "COMPLETED" || body.status === "TRANSFERRED")
    ) {
      try {
        await postJobCardLabor(db, updated.id, existing.id);
      } catch (err) {
        console.error("[postJobCardLabor] cascade failed", {
          poId: id,
          jobCardId: updated.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // F1 — RM consumption at FAB_CUT JC completion (moved here from PO
      // completion on 2026-05-07). Fabric (and any other raw material the
      // BOM authors on FC nodes) is deducted from raw_materials.balanceQty
      // the moment ANY FAB_CUT JC of this PO flips done — matches physical
      // reality (meters leave the roll when cutting happens, not weeks
      // later). The consume is keyed on PO + BOM template (productCode):
      // first FAB_CUT JC trips the consume for the whole PO, subsequent
      // FAB_CUT JCs (e.g. STOOL with split Cushion / Base FCs) see the
      // existing RM_ISSUE row and short-circuit via idempotency check
      // inside consumeRawMaterialsForPO (refType='PRODUCTION_ORDER').
      // Other JC dept completions (FAB_SEW, WOOD_CUT, etc.) are pure WIP
      // transformations — no RM consume.
      if (updated.departmentCode === "FAB_CUT") {
        try {
          await consumeRawMaterialsForPO(db, existing.id);
        } catch (err) {
          console.error("[consumeRawMaterialsForPO@FAB_CUT] cascade failed", {
            poId: id,
            jobCardId: updated.id,
            dept: updated.departmentCode,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // currentDepartment is the dept of the next JC the floor will work on.
    // PO.status / progress / completedDate are recomputed by
    // recomputePoStatusAndProgress() below — no longer derived here.
    const refreshedJcs = allJcRows.map((j) => (j.id === updated.id ? updated : j));
    const activeDept = refreshedJcs.find(
      (j) => j.status === "IN_PROGRESS" || j.status === "WAITING",
    );
    updatedCurrentDept = activeDept?.departmentCode ?? "PACKING";
  }

  // PO-level scalar fields.
  const newTargetEnd =
    body.targetEndDate !== undefined ? body.targetEndDate : existing.targetEndDate;
  const newRackingNumber =
    body.rackingNumber !== undefined
      ? body.rackingNumber
      : existing.rackingNumber;
  const newStockedIn =
    body.stockedIn !== undefined
      ? body.stockedIn
        ? 1
        : 0
      : existing.stockedIn;

  // Write the operator-supplied scalar fields (currentDepartment, target
  // dates, racking, stocked-in flag). status / progress / completedDate
  // are NOT touched here — those are derived by
  // recomputePoStatusAndProgress() below off the fresh JC view, which is
  // the single source of truth for the roll-up.
  await db
    .prepare(
      `UPDATE production_orders SET
         currentDepartment = ?, targetEndDate = ?, rackingNumber = ?,
         stockedIn = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      updatedCurrentDept,
      newTargetEnd,
      newRackingNumber,
      newStockedIn,
      nowIso,
      id,
    )
    .run();

  // Roll-up: derive PO.status + PO.progress + PO.completedDate off the
  // post-UPDATE JC view. Skips ON_HOLD / CANCELLED. Only writes when
  // something actually changed.
  let recomputed: Awaited<ReturnType<typeof recomputePoStatusAndProgress>> | null = null;
  try {
    recomputed = await recomputePoStatusAndProgress(db, id);
  } catch (err) {
    console.error("[recomputePoStatusAndProgress] cascade failed", {
      poId: id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  const effectiveStatus = recomputed?.after?.status ?? existing.status;

  // SO cascades.  Wrapped in try/catch for the same reason as the WIP +
  // labor cascades above (Bug 3, 2026-04-26): a downstream cascade failure
  // must not void the JC + PO scalar UPDATEs that already committed.
  if (body.jobCardId && effectiveStatus === "COMPLETED") {
    // Auto-generate FG units + fg_batches row on PO completion. Idempotent:
    // postProductionOrderCompletion short-circuits if fg_units already exist
    // for this PO, and the fg_batches insert is guarded by productionOrderId.
    try {
      await postProductionOrderCompletion(db, id);
    } catch (err) {
      console.error("[postProductionOrderCompletion] cascade failed", {
        poId: id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await cascadePoCompletionToSO(db, existing.salesOrderId);
    } catch (err) {
      console.error("[cascadePoCompletionToSO] cascade failed", {
        poId: id,
        soId: existing.salesOrderId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    // CO-parity twin — POs from a CO carry consignmentOrderId set instead of
    // salesOrderId, so the SO branch above no-oped. Same try/catch contract:
    // a cascade failure must not void the JC + PO scalar UPDATEs that
    // already committed.
    if (existing.consignmentOrderId) {
      try {
        await cascadePoCompletionToCO(db, existing.consignmentOrderId);
      } catch (err) {
        console.error("[cascadePoCompletionToCO] cascade failed", {
          poId: id,
          coId: existing.consignmentOrderId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  try {
    await cascadeUpholsteryToSO(db, id);
  } catch (err) {
    console.error("[cascadeUpholsteryToSO] cascade failed", {
      poId: id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  // CO-parity twin — internally short-circuits on SO-sourced POs (and vice
  // versa for the SO twin). Wrapped separately so a failure in one twin
  // doesn't strand the other.
  try {
    await cascadeUpholsteryToCO(db, id);
  } catch (err) {
    console.error("[cascadeUpholsteryToCO] cascade failed", {
      poId: id,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // BUG-2026-04-27-020: SO-rollback companion. Fires only when this PATCH
  // moved a UPHOLSTERY JC out of a DONE state. Defensive try/catch — same
  // contract as the cascades above: a rollback bookkeeping miss must not
  // void the operator's primary write.
  if (uphRollbackTriggered) {
    try {
      const actorUserId =
        (c.get as unknown as (k: string) => string | undefined)("userId") ??
        null;
      await cascadeUpholsteryRollbackToSO(db, id, actorUserId ?? "System");
    } catch (err) {
      console.error("[cascadeUpholsteryRollbackToSO] cascade failed", {
        poId: id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const fresh = await fetchPO(db, id);
  return c.json({ success: true, data: fresh });
}

// ---------------------------------------------------------------------------
// ROUTES
// Order matters: specific routes BEFORE /:id.
// ---------------------------------------------------------------------------

// GET /api/production-orders
//
// Query params (all optional; omitting them preserves backward-compatible
// "return everything with JCs inlined" behavior for any legacy consumer):
//
//   ?status=PENDING,IN_PROGRESS,ON_HOLD
//     Comma-separated list. Applied as SQL `WHERE status IN (...)` so we
//     don't ship COMPLETED/CANCELLED POs to the Production page.
//
//   ?include=jobCards
//     Whether to inline job_cards (and piece_pics) on each PO. Defaults to
//     `jobCards` (included) to stay backward-compatible. Callers that only
//     need PO headers can pass `?include=` to skip the JC joins.
//
//   ?page=N&limit=M
//     Opt-in pagination. When either is supplied, response includes
//     { page, limit } and `data` is sliced. When both omitted, the full
//     result set is returned (backward compatible). Default page=1,
//     default limit=50, hard cap limit=500. Slicing happens AFTER status
//     filter and AFTER rowToPO shaping, so `total` is always the filtered
//     total (not the page length).
//
//   ?includeArchive=true
//     Phase-5 historical-report hook. When set, UNIONs
//     production_orders + production_orders_archive (and same for
//     job_cards) before filtering/ordering. Default off — hot only.

// ---------------------------------------------------------------------------
// GET /api/production-orders/overdue-counts[?dept=WOOD_CUT]
//
// Aggregate replacement for the bare `?fields=minimal` fetch the Production
// page used to do solely to compute the two top-bar pills + the breakdown
// drill-down panel. Mirrors `isOverduePO` + `earliestOverdueDateOnPO` in
// src/pages/production/utils.ts:
//
//   ?dept missing  → Overview rule: PO.targetEndDate < today AND any
//                    UPHOLSTERY JC still open.  earliest = PO.targetEndDate.
//   ?dept=<code>   → Per-dept rule: that dept's JC dueDate passed AND open.
//                    earliest = MIN(such JC.dueDate).
//
// Skips COMPLETED / CANCELLED POs in both modes (matches the predicate).
// Server SQL replaces a ~8MB / 800-PO + 12k-JC payload that the page used
// to mash through in JS — see Phase B notes 2026-05-08. Response is one
// breakdown row per (companySOId / salesOrderId / companyCOId /
// consignmentOrderId) group with overdue POs in it, plus the per-category
// totals the FE renders as "Bedframe Overdue: N" / "Sofa Overdue: N".
// ---------------------------------------------------------------------------
// NOTE: SQL aliases must use snake_case so postgres.js's snake→camel
// transform turns them back into camelCase here. An unquoted `AS poStatus`
// would land as Postgres-lowercased `postatus`, which the transform leaves
// alone (no underscore = no rename), and `row.poStatus` reads undefined.
type OverduePoRow = {
  id: string;
  companySOId: string | null;
  salesOrderId: string | null;
  companyCOId: string | null;
  consignmentOrderId: string | null;
  customerName: string | null;
  itemCategory: string | null;
  poStatus: string;        // SQL: po.status AS po_status
  earliestOverdue: string | null;  // SQL: ... AS earliest_overdue
};

type OverdueBreakdownRow = {
  soId: string;
  displaySoId: string;
  customer: string;
  totalPos: number;
  overduePos: number;
  earliest: string;
  poStatus: string;
  salesOrderId: string;
  overdueCategories: string[];
};

app.get("/overdue-counts", async (c) => {
  const orgId = getOrgId(c);
  const deptParam = c.req.query("dept");
  const dept =
    deptParam && deptParam.trim().length > 0
      ? deptParam.trim().toUpperCase()
      : null;
  const today = new Date().toISOString().slice(0, 10);

  // One SQL per request; the slim row list (~800 max) is aggregated in JS.
  // Per-PO `earliestOverdue` is computed via the same predicate the FE used
  // to apply locally — overview branch is anchored on PO.targetEndDate and
  // gated on UPHOLSTERY-JC openness; dept branch is the MIN(jc.dueDate)
  // across that dept's still-open JCs that have already passed today.
  let rows: OverduePoRow[];
  if (dept === null) {
    const stmt = c.var.DB.prepare(
      `SELECT po.id,
              po.companySOId,
              po.salesOrderId,
              po.companyCOId,
              po.consignmentOrderId,
              po.customerName,
              po.itemCategory,
              po.status AS po_status,
              CASE
                WHEN po.status NOT IN ('COMPLETED','CANCELLED')
                  AND po.targetEndDate IS NOT NULL
                  AND po.targetEndDate < ?
                  AND EXISTS (
                    SELECT 1 FROM job_cards jc
                    WHERE jc.productionOrderId = po.id
                      AND jc.departmentCode = 'UPHOLSTERY'
                      AND jc.status NOT IN ('COMPLETED','TRANSFERRED')
                  )
                THEN po.targetEndDate
                ELSE NULL
              END AS earliest_overdue
         FROM production_orders po
        WHERE po.orgId = ?`,
    ).bind(today, orgId);
    const res = await stmt.all<OverduePoRow>();
    rows = res.results ?? [];
  } else {
    const stmt = c.var.DB.prepare(
      `SELECT po.id,
              po.companySOId,
              po.salesOrderId,
              po.companyCOId,
              po.consignmentOrderId,
              po.customerName,
              po.itemCategory,
              po.status AS po_status,
              (SELECT MIN(jc.dueDate)
                 FROM job_cards jc
                WHERE jc.productionOrderId = po.id
                  AND jc.departmentCode = ?
                  AND jc.dueDate IS NOT NULL
                  AND jc.dueDate < ?
                  AND jc.status NOT IN ('COMPLETED','TRANSFERRED')) AS earliest_overdue
         FROM production_orders po
        WHERE po.orgId = ?
          AND po.status NOT IN ('COMPLETED','CANCELLED')`,
    ).bind(dept, today, orgId);
    const res = await stmt.all<OverduePoRow>();
    rows = res.results ?? [];
  }

  // Aggregate by SO group. totalPos counts non-CANCELLED POs in the group;
  // overduePos / earliest / overdueCategories track only the overdue subset.
  // Mirrors src/pages/production/index.tsx:1277-1326.
  type Entry = Omit<OverdueBreakdownRow, "overdueCategories"> & {
    overdueCategories: Set<string>;
  };
  const byso = new Map<string, Entry>();
  for (const po of rows) {
    if (po.poStatus === "CANCELLED") continue;
    const groupId =
      po.companySOId ||
      po.salesOrderId ||
      po.companyCOId ||
      po.consignmentOrderId ||
      "";
    if (!groupId) continue;
    let entry = byso.get(groupId);
    if (!entry) {
      entry = {
        soId: groupId,
        displaySoId: po.companySOId || po.companyCOId || groupId,
        customer: po.customerName || "",
        totalPos: 0,
        overduePos: 0,
        earliest: "",
        poStatus: po.poStatus,
        salesOrderId: po.salesOrderId || "",
        overdueCategories: new Set<string>(),
      };
      byso.set(groupId, entry);
    }
    entry.totalPos += 1;
    if (!entry.salesOrderId && po.salesOrderId) entry.salesOrderId = po.salesOrderId;
    const eo = po.earliestOverdue;
    if (eo) {
      entry.overduePos += 1;
      if (po.itemCategory) entry.overdueCategories.add(po.itemCategory);
      if (!entry.earliest || eo < entry.earliest) entry.earliest = eo;
    }
  }

  const breakdown: OverdueBreakdownRow[] = Array.from(byso.values())
    .filter((r) => r.overduePos > 0)
    .map((r) => ({ ...r, overdueCategories: Array.from(r.overdueCategories) }))
    .sort((a, b) => {
      if (!a.earliest && !b.earliest) return 0;
      if (!a.earliest) return 1;
      if (!b.earliest) return -1;
      return a.earliest.localeCompare(b.earliest);
    });

  const bedframeCount = breakdown.filter((r) =>
    r.overdueCategories.includes("BEDFRAME"),
  ).length;
  const sofaCount = breakdown.filter((r) =>
    r.overdueCategories.includes("SOFA"),
  ).length;

  return c.json({
    success: true,
    data: { bedframeCount, sofaCount, breakdown },
  });
});

// ---------------------------------------------------------------------------
// GET /api/production-orders/diag/timing[?dept=WOOD_CUT&dueFrom=...&dueTo=...]
//
// TEMPORARY (Phase B+, 2026-05-08): mirrors the dept-mode minimal hot path
// step-by-step with millisecond timings around each query / compute block.
// Doesn't ship data — just returns the timing breakdown so we can see where
// the 3-4 s server time on /api/production-orders?fields=minimal&dept=X
// actually goes (Postgres EXPLAIN says 5-25 ms; the rest is somewhere
// between Hyperdrive and rowToMinimalPO). Delete once the bottleneck is
// fixed and Phase B+ ships.
// ---------------------------------------------------------------------------
app.get("/diag/timing", async (c) => {
  const orgId = getOrgId(c);
  const deptParamRaw = c.req.query("dept");
  const deptFilter =
    deptParamRaw && deptParamRaw.trim().length > 0
      ? deptParamRaw.trim().toUpperCase()
      : null;
  const dueFrom = c.req.query("dueFrom") || null;
  const dueTo = c.req.query("dueTo") || null;
  const db = c.var.DB;

  const t: Record<string, number> = {};
  const tstart = Date.now();
  const mark = (k: string) => {
    t[k] = Date.now() - tstart;
  };

  // Step 1: leadTimeMap
  const tA = Date.now();
  await loadLeadTimes(db).catch(() => null);
  mark("leadTimes");
  void tA;

  // Step 2: BOM + sibling pre-loads (Promise.all in real code; serial here
  // so we can attribute time per call).
  const tB = Date.now();
  await fetchBomWipComponentsByCode(db);
  t["bomTemplates"] = Date.now() - tB;
  const tC = Date.now();
  await fetchSofaSiblingsByGroupKey(db, orgId);
  t["sofaSiblings"] = Date.now() - tC;

  // Step 3: PO list (with optional date window)
  const tD = Date.now();
  const dueClauses: string[] = [];
  const dueBindings: string[] = [];
  if (dueFrom || dueTo) {
    if (deptFilter) {
      const sub: string[] = [
        "EXISTS (SELECT 1 FROM job_cards jc",
        " WHERE jc.productionOrderId = production_orders.id",
        " AND jc.departmentCode = ?",
      ];
      const subBindings: string[] = [deptFilter];
      if (dueFrom) {
        sub.push(" AND (jc.dueDate IS NULL OR jc.dueDate >= ?)");
        subBindings.push(dueFrom);
      }
      if (dueTo) {
        sub.push(" AND (jc.dueDate IS NULL OR jc.dueDate <= ?)");
        subBindings.push(dueTo);
      }
      sub.push(")");
      dueClauses.push(sub.join(""));
      dueBindings.push(...subBindings);
    } else {
      if (dueFrom) {
        dueClauses.push("(targetEndDate IS NULL OR targetEndDate >= ?)");
        dueBindings.push(dueFrom);
      }
      if (dueTo) {
        dueClauses.push("(targetEndDate IS NULL OR targetEndDate <= ?)");
        dueBindings.push(dueTo);
      }
    }
  }
  const dueWhere = dueClauses.length > 0 ? ` AND ${dueClauses.join(" AND ")}` : "";
  const poRes = await db
    .prepare(
      `SELECT * FROM production_orders WHERE orgId = ?${dueWhere} ORDER BY created_at DESC, id DESC`,
    )
    .bind(orgId, ...dueBindings)
    .all<ProductionOrderRow>();
  t["poQuery"] = Date.now() - tD;
  const poRows = poRes.results ?? [];

  // Step 4: JC list with the 3-way OR sibling fan-out (dept mode only).
  const tE = Date.now();
  let jcCount = 0;
  if (deptFilter) {
    const jcSql =
      `SELECT * FROM job_cards WHERE orgId = ? AND productionOrderId IN (
          SELECT po.id FROM production_orders po
          WHERE po.orgId = ?
            AND (po.id IN (SELECT productionOrderId FROM job_cards WHERE orgId = ? AND departmentCode = ?)
                 OR (po.companySOId IS NOT NULL AND po.companySOId IN (
                      SELECT po2.companySOId FROM production_orders po2
                      JOIN job_cards jc2 ON jc2.productionOrderId = po2.id
                      WHERE jc2.orgId = ? AND jc2.departmentCode = ? AND po2.companySOId IS NOT NULL))
                 OR (po.companyCOId IS NOT NULL AND po.companyCOId IN (
                      SELECT po3.companyCOId FROM production_orders po3
                      JOIN job_cards jc3 ON jc3.productionOrderId = po3.id
                      WHERE jc3.orgId = ? AND jc3.departmentCode = ? AND po3.companyCOId IS NOT NULL)))
        )`;
    const jcRes = await db
      .prepare(jcSql)
      .bind(orgId, orgId, orgId, deptFilter, orgId, deptFilter, orgId, deptFilter)
      .all<JobCardRow>();
    jcCount = (jcRes.results ?? []).length;
    t["jcQuery"] = Date.now() - tE;

    // Step 5: piecesDoneByJc
    const tF = Date.now();
    await fetchPiecesDoneByJc(
      db,
      orgId,
      (jcRes.results ?? []).map((j) => j.id),
    );
    t["piecesDone"] = Date.now() - tF;
  }

  return c.json({
    success: true,
    poCount: poRows.length,
    jcCount,
    timingsMs: t,
    totalMs: Date.now() - tstart,
  });
});

app.get("/", async (c) => {
  const statusParam = c.req.query("status");
  const statuses = statusParam
    ? statusParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : null;

  const includeParam = c.req.query("include");
  // Backward compat: if `include` is not passed at all, inline jobCards.
  // If it IS passed, only include jobCards when the list contains "jobCards".
  const includeJobCards =
    includeParam === undefined
      ? true
      : includeParam
          .split(",")
          .map((s) => s.trim())
          .includes("jobCards");

  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const paginate = pageParam !== undefined || limitParam !== undefined;
  const includeArchive = c.req.query("includeArchive") === "true";
  // Opt-in slim payload for the Production page: drops ~20 unused PO fields
  // and the whole piece_pics tree. Default stays full-response for backward
  // compat (the PO detail page + other consumers need the full shape).
  const minimal = c.req.query("fields") === "minimal";
  // Opt-in dept-narrowing: when present, each PO's jobCards array is
  // filtered at SQL level to only the given dept code. Used by the
  // per-department pages (/production/fab-cut etc.) so they never ship
  // the other 7 depts' JC rows.
  const deptParamRaw = c.req.query("dept");
  const deptFilter =
    deptParamRaw && deptParamRaw.trim().length > 0
      ? deptParamRaw.trim().toUpperCase()
      : null;

  // Server-side targetEndDate window. Both bounds are optional; either or
  // both can be supplied. NULL targetEndDate rows are preserved on both
  // sides so undated POs aren't silently hidden — matches the client-side
  // filter at production/index.tsx:1188-1189.
  const dueFrom = c.req.query("dueFrom") || null;
  const dueTo = c.req.query("dueTo") || null;

  const orgId = getOrgId(c);

  if (!paginate) {
    const data = await fetchFilteredPOs(
      c.var.DB,
      orgId,
      statuses,
      includeJobCards,
      includeArchive,
      minimal,
      deptFilter,
      dueFrom,
      dueTo,
    );
    return c.json({ success: true, data, total: data.length });
  }

  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const rawLimit = parseInt(limitParam ?? "50", 10) || 50;
  const limit = Math.min(500, Math.max(1, rawLimit));
  const { data, total } = await fetchPaginatedPOs(
    c.var.DB,
    orgId,
    statuses,
    includeJobCards,
    page,
    limit,
    includeArchive,
    minimal,
    deptFilter,
    dueFrom,
    dueTo,
  );
  return c.json({ success: true, data, page, limit, total });
});

// ---------------------------------------------------------------------------
// GET /api/production-orders/historical-wips
// Distinct WIPs that have appeared in any JobCard to date.
// ---------------------------------------------------------------------------
app.get("/historical-wips", async (c) => {
  const all = await fetchAllPOs(c.var.DB, getOrgId(c));
  type H = {
    wipLabel: string;
    wipKey?: string;
    wipCode?: string;
    wipType?: string;
    sourcePoId: string;
    sourceJcId: string;
    sourcePoNo: string;
    itemCategory: string;
    productCode: string;
    productName: string;
    sizeCode: string;
    sizeLabel: string;
    fabricCode: string;
    lastSeen: string;
  };
  const seen = new Map<string, H>();
  for (const po of all) {
    for (const jc of po.jobCards) {
      if (!jc.wipLabel) continue;
      const key = `${jc.wipLabel}::${jc.wipKey ?? ""}::${po.sizeCode}::${po.fabricCode}`;
      const prev = seen.get(key);
      if (!prev || (po.createdAt || "") > (prev.lastSeen || "")) {
        seen.set(key, {
          wipLabel: jc.wipLabel,
          wipKey: jc.wipKey,
          wipCode: jc.wipCode,
          wipType: jc.wipType,
          sourcePoId: po.id,
          sourceJcId: jc.id,
          sourcePoNo: po.poNo,
          itemCategory: po.itemCategory,
          productCode: po.productCode,
          productName: po.productName,
          sizeCode: po.sizeCode,
          sizeLabel: po.sizeLabel,
          fabricCode: po.fabricCode,
          lastSeen: po.createdAt || "",
        });
      }
    }
  }
  const list = Array.from(seen.values()).sort((a, b) => {
    if (a.lastSeen !== b.lastSeen) return a.lastSeen > b.lastSeen ? -1 : 1;
    return a.wipLabel.localeCompare(b.wipLabel);
  });
  return c.json({ success: true, data: list });
});

// ---------------------------------------------------------------------------
// GET /api/production-orders/historical-fgs
// ---------------------------------------------------------------------------
app.get("/historical-fgs", async (c) => {
  const all = await fetchAllPOs(c.var.DB, getOrgId(c));
  type H = {
    sourcePoId: string;
    sourcePoNo: string;
    itemCategory: string;
    productCode: string;
    productName: string;
    sizeCode: string;
    sizeLabel: string;
    fabricCode: string;
    lastSeen: string;
  };
  const seen = new Map<string, H>();
  for (const po of all) {
    const key = `${po.productCode}::${po.sizeCode}::${po.fabricCode}`;
    const prev = seen.get(key);
    if (!prev || (po.createdAt || "") > (prev.lastSeen || "")) {
      seen.set(key, {
        sourcePoId: po.id,
        sourcePoNo: po.poNo,
        itemCategory: po.itemCategory,
        productCode: po.productCode,
        productName: po.productName,
        sizeCode: po.sizeCode,
        sizeLabel: po.sizeLabel,
        fabricCode: po.fabricCode,
        lastSeen: po.createdAt || "",
      });
    }
  }
  const list = Array.from(seen.values()).sort((a, b) => {
    if (a.lastSeen !== b.lastSeen) return a.lastSeen > b.lastSeen ? -1 : 1;
    return a.productName.localeCompare(b.productName);
  });
  return c.json({ success: true, data: list });
});

// ---------------------------------------------------------------------------
// POST /api/production-orders/stock — create a WIP-only or full-FG stock PO.
//
// Clones the source PO's jobCards (filtered by wipKey for WIP mode, or all
// for FG mode), resets worker-side state, generates a placeholder SOH SO,
// and creates a new PO linked to it.
// ---------------------------------------------------------------------------
app.post("/stock", async (c) => {
  const denied = await requirePermission(c, "production-orders", "create");
  if (denied) return denied;
  const db = c.var.DB;
  const body = await c.req.json().catch(() => ({}));
  const type = body?.type as "WIP" | "FG" | undefined;
  const sourcePoId = body?.sourcePoId as string | undefined;
  const sourceJcId = body?.sourceJcId as string | undefined;
  const quantity = Math.max(1, Math.floor(Number(body?.quantity) || 0));
  const targetEndDate = body?.targetEndDate as string | undefined;

  if (type !== "WIP" && type !== "FG") {
    return c.json({ success: false, error: "type must be WIP or FG" }, 400);
  }
  if (!sourcePoId) {
    return c.json({ success: false, error: "sourcePoId is required" }, 400);
  }
  if (type === "WIP" && !sourceJcId) {
    return c.json(
      { success: false, error: "sourceJcId is required for WIP stock PO" },
      400,
    );
  }
  if (!quantity) {
    return c.json({ success: false, error: "quantity must be >= 1" }, 400);
  }
  if (!targetEndDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetEndDate)) {
    return c.json(
      { success: false, error: "targetEndDate must be YYYY-MM-DD" },
      400,
    );
  }

  const sourcePO = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(sourcePoId)
    .first<ProductionOrderRow>();
  if (!sourcePO) {
    return c.json({ success: false, error: "Source PO not found" }, 404);
  }
  const sourceJcsRes = await db
    .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
    .bind(sourcePoId)
    .all<JobCardRow>();
  const sourceJcs = sourceJcsRes.results ?? [];

  let jcsToCopy: JobCardRow[];
  let selectedWipLabel = "";
  if (type === "WIP") {
    const sourceJc = sourceJcs.find((j) => j.id === sourceJcId);
    if (!sourceJc) {
      return c.json(
        { success: false, error: "Source JC not found on source PO" },
        404,
      );
    }
    selectedWipLabel = sourceJc.wipLabel || "";
    if (sourceJc.wipKey) {
      jcsToCopy = sourceJcs.filter((j) => j.wipKey === sourceJc.wipKey);
    } else {
      jcsToCopy = [sourceJc];
    }
  } else {
    jcsToCopy = [...sourceJcs];
  }
  if (jcsToCopy.length === 0) {
    return c.json(
      { success: false, error: "No jobCards to clone from source PO" },
      422,
    );
  }

  const nowIso = new Date().toISOString();
  const today = nowIso.split("T")[0];

  // Generate SOH + new SO row.
  const sohNo = await nextSOHNumber(db);
  const soId = genSoId();

  const newItem = {
    id: genItemId(),
    lineNo: 1,
    lineSuffix: "-01",
    productId: sourcePO.productId,
    productCode: sourcePO.productCode,
    productName: sourcePO.productName,
    itemCategory: sourcePO.itemCategory,
    sizeCode: sourcePO.sizeCode,
    sizeLabel: sourcePO.sizeLabel,
    fabricId: "",
    fabricCode: sourcePO.fabricCode,
    quantity,
    gapInches: sourcePO.gapInches,
    divanHeightInches: sourcePO.divanHeightInches,
    divanPriceSen: 0,
    legHeightInches: sourcePO.legHeightInches,
    legPriceSen: 0,
    specialOrder: sourcePO.specialOrder || "",
    specialOrderPriceSen: 0,
    basePriceSen: 0,
    unitPriceSen: 0,
    lineTotalSen: 0,
    notes: type === "WIP" ? `Stock WIP: ${selectedWipLabel}` : "Stock FG",
  };

  // Clone job cards — reset worker state; adjust wipQty proportional to new qty.
  const sourceQty = Math.max(1, sourcePO.quantity || 1);
  const minSeq = jcsToCopy.reduce(
    (m, j) => (j.sequence < m ? j.sequence : m),
    jcsToCopy[0].sequence,
  );

  const newJcIds = jcsToCopy.map(() => genJcId());
  const newPoId = genPoId();
  const newPoNo = `${sohNo}-01`;

  const statements: D1PreparedStatement[] = [];

  // Insert stock SO.
  statements.push(
    db
      .prepare(
        `INSERT INTO sales_orders (id, customerPO, customerPOId, customerPODate,
            customerSO, customerSOId, reference, customerId, customerName,
            customerState, hubId, hubName, companySO, companySOId, companySODate,
            customerDeliveryDate, hookkaExpectedDD, hookkaDeliveryOrder,
            subtotalSen, totalSen, status, overdue, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        soId,
        "",
        "",
        "",
        "",
        "",
        type === "WIP" ? `Stock WIP (${selectedWipLabel})` : "Stock FG",
        "", // customerId — stock SO has no customer; NOT NULL but empty string OK
        "— Stock —",
        "",
        null,
        null,
        sohNo,
        sohNo,
        today,
        targetEndDate,
        targetEndDate,
        "",
        0,
        0,
        "DRAFT",
        "PENDING",
        "Stock placeholder — will be renamed to the customer SO when a real order lands.",
        nowIso,
        nowIso,
      ),
  );

  // Insert minimal SO item so downstream readers don't crash.
  statements.push(
    db
      .prepare(
        `INSERT INTO sales_order_items (id, salesOrderId, lineNo, lineSuffix,
           productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
           fabricId, fabricCode, quantity, gapInches, divanHeightInches,
           divanPriceSen, legHeightInches, legPriceSen, specialOrder,
           specialOrderPriceSen, basePriceSen, unitPriceSen, lineTotalSen, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newItem.id,
        soId,
        newItem.lineNo,
        newItem.lineSuffix,
        newItem.productId,
        newItem.productCode,
        newItem.productName,
        newItem.itemCategory,
        newItem.sizeCode,
        newItem.sizeLabel,
        newItem.fabricId,
        newItem.fabricCode,
        newItem.quantity,
        newItem.gapInches,
        newItem.divanHeightInches,
        newItem.divanPriceSen,
        newItem.legHeightInches,
        newItem.legPriceSen,
        newItem.specialOrder,
        newItem.specialOrderPriceSen,
        newItem.basePriceSen,
        newItem.unitPriceSen,
        newItem.lineTotalSen,
        newItem.notes,
      ),
  );

  // Find first dept — for PO.currentDepartment.
  const firstDept = [...jcsToCopy].sort((a, b) => a.sequence - b.sequence)[0]
    ?.departmentCode || "WOOD_CUT";

  // Insert PO.
  statements.push(
    db
      .prepare(
        `INSERT INTO production_orders (id, poNo, salesOrderId, salesOrderNo, lineNo,
           customerPOId, customerReference, customerName, customerState, companySOId,
           productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
           fabricCode, quantity, gapInches, divanHeightInches, legHeightInches,
           specialOrder, notes, status, currentDepartment, progress, startDate,
           targetEndDate, completedDate, rackingNumber, stockedIn, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newPoId,
        newPoNo,
        soId,
        sohNo,
        1,
        "",
        type === "WIP" ? `Stock WIP (${selectedWipLabel})` : "Stock FG",
        "— Stock —",
        "",
        sohNo,
        sourcePO.productId,
        sourcePO.productCode,
        sourcePO.productName,
        sourcePO.itemCategory,
        sourcePO.sizeCode,
        sourcePO.sizeLabel,
        sourcePO.fabricCode,
        quantity,
        sourcePO.gapInches,
        sourcePO.divanHeightInches,
        sourcePO.legHeightInches,
        sourcePO.specialOrder || "",
        type === "WIP"
          ? `Stock PO — WIP only (${selectedWipLabel}). Cloned from ${sourcePO.poNo}.`
          : `Stock PO — FG. Cloned from ${sourcePO.poNo}.`,
        "PENDING",
        firstDept,
        0,
        today,
        targetEndDate,
        null,
        "",
        0,
        nowIso,
        nowIso,
      ),
  );

  // Insert job cards.
  for (let i = 0; i < jcsToCopy.length; i++) {
    const jc = jcsToCopy[i];
    const newId = newJcIds[i];
    const perUnit = (jc.wipQty ?? sourceQty) / sourceQty;
    const newWipQty = Math.max(1, Math.round(perUnit * quantity));
    statements.push(
      db
        .prepare(
          `INSERT INTO job_cards (id, productionOrderId, departmentId, departmentCode,
             departmentName, sequence, status, dueDate, wipKey, wipCode, wipType,
             wipLabel, wipQty, prerequisiteMet, pic1Id, pic1Name, pic2Id, pic2Name,
             completedDate, estMinutes, actualMinutes, category,
             productionTimeMinutes, overdue, rackingNumber, branchKey)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId,
          newPoId,
          jc.departmentId,
          jc.departmentCode,
          jc.departmentName,
          jc.sequence,
          "WAITING",
          targetEndDate,
          jc.wipKey,
          jc.wipCode,
          jc.wipType,
          jc.wipLabel,
          newWipQty,
          jc.sequence === minSeq ? 1 : 0,
          null,
          "",
          null,
          "",
          null,
          jc.estMinutes,
          null,
          jc.category,
          jc.productionTimeMinutes,
          "PENDING",
          null,
          // Inherit the source JC's branchKey (clone path — same BOM
          // branch as the row we're copying from).
          jc.branchKey ?? "",
        ),
    );
  }

  await db.batch(statements);

  const fresh = await fetchPO(db, newPoId);
  return c.json({ success: true, data: fresh });
});

// ---------------------------------------------------------------------------
// POST /api/production-orders/regen-job-cards-bulk
//
// Cursor-paged bulk regen: walks every production_orders row (ORDER BY id
// ASC, after `?cursor=<lastPoId>`), wipes its job_cards, and rebuilds them
// from the current BOM template + Production Time master. Used after the
// user edits the BOM/PT master and wants every PO's snapshotted JCs
// refreshed in one shot. Companion to the BOM-side
// /api/bom/resync-job-card-times endpoint (commit 05f2523), but heavier
// because each PO regen runs the full BOM walker — hence the smaller
// default page size (50) and lower max (200).
//
// Status filter: NONE. The user confirmed (2026-04-29) that no production
// has actually started on any of these POs (no scan history, no completion
// data), so we regenerate ACROSS ALL STATUSES — including CANCELLED. We
// considered skipping CANCELLED defensively but the user's instruction was
// "regenerate everything regardless of status"; honouring that. If a future
// caller needs status filtering, add `?status=` plumbing then.
//
// Per-PO failures are caught and surfaced in `errors[]`; we never roll
// back successful POs in the same batch (each PO is its own atomic
// db.batch()). One bad BOM template will not block the rest of the run.
//
// Registered BEFORE /:id and /:id/* routes so Hono's literal-vs-param
// routing picks the right handler.
// ---------------------------------------------------------------------------
app.post("/regen-job-cards-bulk", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;

  const cursor = c.req.query("cursor") || null;
  const rawLimit = Number(c.req.query("limit") ?? 50);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 10), 200);

  // limit+1 trick — if we get more than `limit` rows we know there's a next page.
  const cursorClause = cursor ? "WHERE id > ?" : "";
  const sql = `SELECT id FROM production_orders ${cursorClause} ORDER BY id ASC LIMIT ?`;
  const sel = cursor
    ? await db.prepare(sql).bind(cursor, limit + 1).all<{ id: string }>()
    : await db.prepare(sql).bind(limit + 1).all<{ id: string }>();
  const allRows = sel.results ?? [];
  const hasMore = allRows.length > limit;
  if (hasMore) allRows.pop();
  const ids = allRows.map((r) => r.id);

  let processed = 0;
  let totalInserted = 0;
  const errors: Array<{ poId: string; message: string }> = [];
  const results: Array<{ poId: string; inserted: number; currentDept: string | null }> = [];

  for (const poId of ids) {
    try {
      const { statements, jcCount, currentDept } = await backfillJobCardsForPo(db, poId, {
        force: true,
      });
      if (statements.length > 0) {
        await db.batch(statements);
      }
      processed++;
      totalInserted += jcCount;
      results.push({ poId, inserted: jcCount, currentDept });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ poId, message });
    }
  }

  const lastScannedId = ids.length > 0 ? ids[ids.length - 1] : null;
  const nextCursor = hasMore ? lastScannedId : null;

  return c.json({
    success: true,
    processed,
    batchSize: ids.length,
    totalInserted,
    cursor: { hasMore, nextCursor, limit },
    errors,
    results,
  });
});

// ---------------------------------------------------------------------------
// POST /api/production-orders/resync-po-numbers
//
// One-shot backfill that re-aligns production_orders.poNo with the parent
// SO's CURRENT companySOId. Heals the desync introduced by
// scripts/restore-original-so-ids.ts before its 2026-04-30 fix — that
// script renumbered companySOId on both sales_orders AND production_orders
// but left the poNo column stale, so the production page filter (which
// matches against poNo) kept resolving by the pre-renumber SO id and
// confused operators looking for a current SO number.
//
// Body: { dryRun?: boolean } — defaults to true. Pass { dryRun: false }
// to actually write. The endpoint returns the desync count + a sample of
// the diffs in either mode, so the caller can verify scope before
// committing.
// ---------------------------------------------------------------------------
app.post("/resync-po-numbers", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  let body: { dryRun?: boolean } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const dryRun = body.dryRun !== false; // default safe

  // Two layers in play here:
  //   1. supabase-compat.ts rewrites camelCase identifiers → snake_case
  //      via column-rename-map.json. Identifiers MUST be unquoted for the
  //      walker to see them (quoted identifiers are passed through verbatim
  //      and Postgres rejects them as "column does not exist").
  //   2. Postgres folds unquoted aliases to lowercase, which would silently
  //      break the JS-side `r.freshCompanySOId` etc. lookups (every row
  //      comes back as expectedPoNo: "undefined-NN").
  // So: leave column refs unquoted (let the shim rewrite them) and quote
  // only the aliases (preserve the camelCase the result mapper expects).
  const rows = await db
    .prepare(
      `SELECT po.id AS "poId",
              po.poNo AS "currentPoNo",
              po.lineNo AS "lineNo",
              po.salesOrderId AS "soId",
              so.companySOId AS "freshCompanySOId"
         FROM production_orders po
         JOIN sales_orders so ON so.id = po.salesOrderId
        WHERE po.salesOrderId IS NOT NULL
          AND so.companySOId IS NOT NULL
          AND so.companySOId <> ''`,
    )
    .all<{
      poId: string;
      currentPoNo: string;
      lineNo: number;
      soId: string;
      freshCompanySOId: string;
    }>();

  const desync: Array<{
    poId: string;
    currentPoNo: string;
    expectedPoNo: string;
    soId: string;
  }> = [];
  for (const r of rows.results ?? []) {
    const lineSuffix = `-${String(r.lineNo).padStart(2, "0")}`;
    const expectedPoNo = `${r.freshCompanySOId}${lineSuffix}`;
    if (r.currentPoNo !== expectedPoNo) {
      desync.push({
        poId: r.poId,
        currentPoNo: r.currentPoNo,
        expectedPoNo,
        soId: r.soId,
      });
    }
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      desyncCount: desync.length,
      sample: desync.slice(0, 10),
    });
  }

  // Apply in chunks so a single failure (e.g. UNIQUE poNo collision)
  // surfaces with the exact poId and the rest of the batch still lands.
  let applied = 0;
  const errors: Array<{ poId: string; expectedPoNo: string; error: string }> = [];
  for (const d of desync) {
    try {
      await db
        .prepare("UPDATE production_orders SET poNo = ? WHERE id = ?")
        .bind(d.expectedPoNo, d.poId)
        .run();
      applied += 1;
    } catch (err) {
      errors.push({
        poId: d.poId,
        expectedPoNo: d.expectedPoNo,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    desyncCount: desync.length,
    applied,
    errorCount: errors.length,
    errors: errors.slice(0, 10),
  });
});

// ---------------------------------------------------------------------------
// POST /api/production-orders/:poId/regen-job-cards
//
// Single-PO regen: wipes this PO's job_cards and rebuilds them from the
// current BOM template + Production Time master. Force-mode wrapper around
// backfillJobCardsForPo. Used as a per-PO escape hatch / for spot-fixing
// one PO without running the bulk endpoint.
// ---------------------------------------------------------------------------
app.post("/:poId/regen-job-cards", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const poId = c.req.param("poId");

  const po = await db
    .prepare("SELECT id FROM production_orders WHERE id = ?")
    .bind(poId)
    .first<{ id: string }>();
  if (!po) {
    return c.json({ success: false, error: "Production order not found" }, 404);
  }

  const { statements, jcCount, currentDept } = await backfillJobCardsForPo(db, poId, {
    force: true,
  });
  if (statements.length > 0) {
    await db.batch(statements);
  }

  return c.json({ success: true, poId, inserted: jcCount, currentDept });
});

// ---------------------------------------------------------------------------
// POST /api/production-orders/:id/scan-complete
// B-flow piece-pic FIFO routing + sticker binding.
// ---------------------------------------------------------------------------
app.post("/:id/scan-complete", async (c) => {
  const denied = await requirePermission(c, "production-orders", "create");
  if (denied) return denied;
  const db = c.var.DB;
  const scannedId = c.req.param("id");
  const scannedPo = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(scannedId)
    .first<ProductionOrderRow>();
  if (!scannedPo) {
    return c.json({ success: false, error: "Production order not found" }, 404);
  }

  // ---- ON_HOLD / CANCELLED scan block ---------------------------------------
  // Paused or cancelled production orders must not accept new scans. The
  // supervisor has to resume (ON_HOLD → PENDING) before the shop floor can
  // record any more completions. COMPLETED POs are intentionally left alone —
  // FIFO sticker binding already handles that path.
  if (scannedPo.status === "ON_HOLD") {
    return c.json(
      {
        success: false,
        code: "PO_ON_HOLD",
        error: "This Production Order is ON_HOLD. Supervisor must resume before scanning.",
      },
      409,
    );
  }
  if (scannedPo.status === "CANCELLED") {
    return c.json(
      {
        success: false,
        code: "PO_CANCELLED",
        error: "This Production Order has been cancelled and cannot be scanned.",
      },
      409,
    );
  }

  const body = await c.req.json();
  const { jobCardId, workerId } = body || {};
  const rawPiece = Number(body?.pieceNo);
  const pieceNo =
    Number.isFinite(rawPiece) && rawPiece >= 1 ? Math.floor(rawPiece) : 1;
  // `force: true` means the worker has already acknowledged a soft warning
  // (PREREQUISITE_NOT_MET / UPSTREAM_LOCKED) on the previous scan-complete
  // round-trip and is re-posting to bypass it. Each forced scan gets an
  // audit row in `scan_override_audit`.
  const forced = body?.force === true;
  if (!jobCardId || !workerId) {
    return c.json(
      { success: false, error: "jobCardId and workerId are required" },
      400,
    );
  }

  // ---- Worker-auth verification --------------------------------------------
  // The scan-complete endpoint is mounted under /api/production-orders, which
  // means the dashboard auth-middleware gate already passed OR the caller is
  // a worker using the shop-floor portal. For worker callers we bind the
  // body.workerId to the `x-worker-token` header so a malicious worker can't
  // post scans "as someone else" by spoofing the workerId field.
  //
  // Two accepted auth paths:
  //   1. A dashboard user (userId already set on ctx by auth-middleware) —
  //      trust body.workerId as-is (admin scanner in src/pages/production/scan).
  //   2. A worker token (x-worker-token header) — body.workerId must match
  //      the worker_tokens row; otherwise 403.
  const ctxUserId = (c as unknown as { get: (k: string) => unknown }).get(
    "userId",
  );
  const workerToken = c.req.header("x-worker-token");
  if (!ctxUserId) {
    // No dashboard auth → must be a worker call; verify the token binds to
    // the claimed workerId.
    const resolvedWorkerId = await resolveWorkerToken(db, workerToken);
    if (!resolvedWorkerId || resolvedWorkerId !== workerId) {
      return c.json(
        {
          success: false,
          error:
            "Worker auth mismatch — workerId does not match the session token.",
          code: "AUTH_MISMATCH",
        },
        403,
      );
    }
  }

  const scannedJc = await db
    .prepare("SELECT * FROM job_cards WHERE id = ? AND productionOrderId = ?")
    .bind(jobCardId, scannedId)
    .first<JobCardRow>();
  if (!scannedJc) {
    return c.json({ success: false, error: "Job card not found" }, 404);
  }
  const worker = await db
    .prepare("SELECT id, name FROM workers WHERE id = ?")
    .bind(workerId)
    .first<{ id: string; name: string }>();
  if (!worker) {
    return c.json({ success: false, error: "Worker not found" }, 400);
  }

  // Upstream-lock disabled (2026-04-26, user request) — same reasoning as
  // the PATCH guard above: the flat DEPT_ORDER + wipKey predicate doesn't
  // model the BOM tree's parallel branches (FAB chain vs WOOD chain inside
  // one wipKey only converge at UPHOLSTERY). The previous predicate flagged
  // any FAB_CUT/FAB_SEW scan as UPSTREAM_LOCKED the moment WOOD_CUT
  // completed, which is wrong. Re-enable once the lock chain is derived
  // from the BOM template at runtime.

  // ---- prerequisiteMet check -----------------------------------------------
  // The sales-orders planner stamps prerequisiteMet=1 on the first dept of
  // each wip chain and 0 on every downstream dept. As each earlier dept
  // completes, the rollup flips downstream prerequisiteMet=1. If it's still
  // 0 here, the operator is trying to scan a piece whose upstream dept
  // hasn't finished yet.
  if (scannedJc.prerequisiteMet !== 1) {
    if (!forced) {
      return c.json(
        {
          success: false,
          requiresConfirmation: true,
          warning: {
            code: "PREREQUISITE_NOT_MET",
            message: "Earlier dept hasn't completed. Continue anyway?",
          },
          data: {
            jobCardId: scannedJc.id,
            blockedBy: "UPSTREAM_NOT_COMPLETED",
          },
        },
        202,
      );
    }
    // Forced — record the override.
    await db
      .prepare(
        `INSERT INTO scan_override_audit
           (id, workerId, workerName, jobCardId, productionOrderId,
            overrideCode, reason, created_at)
         VALUES (?, ?, ?, ?, ?, 'PREREQUISITE_NOT_MET', 'force scan', ?)`,
      )
      .bind(
        `soa-${crypto.randomUUID().slice(0, 8)}`,
        workerId,
        worker.name,
        scannedJc.id,
        scannedJc.productionOrderId,
        new Date().toISOString(),
      )
      .run();
  }

  // Ensure scanned JC has piecePics rows.
  await ensurePiecePicsForJc(db, scannedJc);

  const targetKey = specKeyFor(scannedJc, scannedPo);
  const stickerKey = `${scannedPo.id}::${scannedJc.id}::${pieceNo}`;

  // Gather all same-spec candidate JCs across all POs.
  const allPoRes = await db
    .prepare("SELECT * FROM production_orders").all<ProductionOrderRow>();
  const allPos = allPoRes.results ?? [];
  const allJcRes = await db.prepare("SELECT * FROM job_cards").all<JobCardRow>();
  const allJcs = allJcRes.results ?? [];

  type Hit = {
    po: ProductionOrderRow;
    jc: JobCardRow;
    slot: PiecePicRow;
  };

  // Find sticker binding first.
  let bound: Hit | null = null;
  const specJcs = allJcs.filter((j) => {
    const p = allPos.find((pp) => pp.id === j.productionOrderId);
    return p && specKeyFor(j, p) === targetKey;
  });
  if (specJcs.length > 0) {
    const jcIds = specJcs.map((j) => j.id);
    const placeholders = jcIds.map(() => "?").join(",");
    const picsRes = await db
      .prepare(
        `SELECT * FROM piece_pics WHERE jobCardId IN (${placeholders}) AND boundStickerKey = ?`,
      )
      .bind(...jcIds, stickerKey)
      .all<PiecePicRow>();
    const hit = picsRes.results?.[0];
    if (hit) {
      const jc = allJcs.find((j) => j.id === hit.jobCardId);
      const po = jc ? allPos.find((p) => p.id === jc.productionOrderId) : undefined;
      if (jc && po) {
        bound = { po, jc, slot: hit };
      }
    }
  }

  // FIFO: if no binding, pick oldest-due unclaimed piece.
  let selected: Hit | null = bound;
  if (!selected) {
    // Build candidate list — for each eligible JC, ensure piece_pics, then
    // collect pic1-empty slots.
    const candidates: Hit[] = [];
    for (const jc of specJcs) {
      if (jc.status === "COMPLETED" || jc.status === "TRANSFERRED") continue;
      const po = allPos.find((p) => p.id === jc.productionOrderId);
      if (!po) continue;
      const slots = await ensurePiecePicsForJc(db, jc);

      // Legacy pic1 mirror: if JC has pic1Id but slot[0] doesn't, sync it.
      const s0 = slots[0];
      let syncedS0 = s0;
      if (jc.pic1Id && s0 && !s0.pic1Id) {
        await db
          .prepare(
            "UPDATE piece_pics SET pic1Id = ?, pic1Name = ? WHERE id = ?",
          )
          .bind(jc.pic1Id, jc.pic1Name ?? "", s0.id)
          .run();
        syncedS0 = { ...s0, pic1Id: jc.pic1Id, pic1Name: jc.pic1Name ?? "" };
        slots[0] = syncedS0;
      }
      if (jc.pic2Id && slots[0] && !slots[0].pic2Id) {
        await db
          .prepare(
            "UPDATE piece_pics SET pic2Id = ?, pic2Name = ? WHERE id = ?",
          )
          .bind(jc.pic2Id, jc.pic2Name ?? "", slots[0].id)
          .run();
        slots[0] = { ...slots[0], pic2Id: jc.pic2Id, pic2Name: jc.pic2Name ?? "" };
      }

      for (const s of slots) {
        if (s.pic1Id) continue;
        candidates.push({ po, jc, slot: s });
      }
    }

    if (candidates.length === 0) {
      return c.json(
        {
          success: false,
          error: `No pending work for ${targetKey}. All pieces in this spec are already in progress or complete.`,
          code: "PIC_FULL",
        },
        400,
      );
    }

    // FIFO sort: jc.dueDate asc, po.targetEndDate asc, po.createdAt asc, pieceNo asc.
    candidates.sort((a, b) => {
      const aJD = a.jc.dueDate || "9999-12-31";
      const bJD = b.jc.dueDate || "9999-12-31";
      if (aJD !== bJD) return aJD.localeCompare(bJD);
      const aTD = a.po.targetEndDate || "9999-12-31";
      const bTD = b.po.targetEndDate || "9999-12-31";
      if (aTD !== bTD) return aTD.localeCompare(bTD);
      const aC = a.po.createdAt || "";
      const bC = b.po.createdAt || "";
      if (aC !== bC) return aC.localeCompare(bC);
      return a.slot.pieceNo - b.slot.pieceNo;
    });
    selected = candidates[0];

    // Bind sticker.
    await db
      .prepare("UPDATE piece_pics SET boundStickerKey = ? WHERE id = ?")
      .bind(stickerKey, selected.slot.id)
      .run();
    selected.slot = { ...selected.slot, boundStickerKey: stickerKey };
  }

  const target = selected;

  // Same-worker guard.
  if (target.slot.pic1Id === worker.id) {
    const freshJc = await fetchPO(db, target.po.id);
    const jcOut = freshJc?.jobCards.find((j) => j.id === target.jc.id);
    return c.json(
      {
        success: false,
        error: `You are already PIC1 on this piece (${worker.name}). A second PIC must be a different worker.`,
        code: "ALREADY_PIC1",
        data: {
          jobCard: jcOut,
          assignedSlot: 1,
          workerName: worker.name,
          pieceNo: target.slot.pieceNo,
        },
      },
      409,
    );
  }
  if (target.slot.pic2Id === worker.id) {
    const freshJc = await fetchPO(db, target.po.id);
    const jcOut = freshJc?.jobCards.find((j) => j.id === target.jc.id);
    return c.json(
      {
        success: false,
        error: `You are already PIC2 on this piece (${worker.name}).`,
        code: "ALREADY_PIC2",
        data: {
          jobCard: jcOut,
          assignedSlot: 2,
          workerName: worker.name,
          pieceNo: target.slot.pieceNo,
        },
      },
      409,
    );
  }

  // 3-second piece-level debounce.
  if (target.slot.lastScanAt) {
    const elapsedMs = Date.now() - new Date(target.slot.lastScanAt).getTime();
    if (elapsedMs < 3000) {
      return c.json(
        {
          success: false,
          error:
            "This piece was just scanned. Please wait a moment before scanning again.",
          code: "DEBOUNCE",
        },
        429,
      );
    }
  }

  if (target.slot.pic1Id && target.slot.pic2Id) {
    const freshJc = await fetchPO(db, target.po.id);
    const jcOut = freshJc?.jobCards.find((j) => j.id === target.jc.id);
    return c.json(
      {
        success: false,
        error: `This piece already has 2 PICs (${target.slot.pic1Name} / ${target.slot.pic2Name}). A third person cannot scan the same piece.`,
        code: "PIC_FULL",
        data: { jobCard: jcOut, pieceNo: target.slot.pieceNo },
      },
      400,
    );
  }

  // Fill the slot.
  const nowIso = new Date().toISOString();
  const today = nowIso.split("T")[0];
  let assignedSlot: 1 | 2;
  let newPic1Id = target.slot.pic1Id;
  let newPic1Name = target.slot.pic1Name ?? "";
  let newPic2Id = target.slot.pic2Id;
  let newPic2Name = target.slot.pic2Name ?? "";
  let newCompletedAt = target.slot.completedAt;

  if (!target.slot.pic1Id) {
    newPic1Id = worker.id;
    newPic1Name = worker.name;
    newCompletedAt = nowIso;
    assignedSlot = 1;
  } else {
    newPic2Id = worker.id;
    newPic2Name = worker.name;
    assignedSlot = 2;
  }

  await db
    .prepare(
      `UPDATE piece_pics SET pic1Id = ?, pic1Name = ?, pic2Id = ?, pic2Name = ?,
         completedAt = ?, lastScanAt = ? WHERE id = ?`,
    )
    .bind(
      newPic1Id,
      newPic1Name,
      newPic2Id,
      newPic2Name,
      newCompletedAt,
      nowIso,
      target.slot.id,
    )
    .run();

  // Rollup: all slots for this JC have pic1 → mark JC COMPLETED.
  const allSlots = await db
    .prepare("SELECT * FROM piece_pics WHERE jobCardId = ?")
    .bind(target.jc.id)
    .all<PiecePicRow>();
  const slotList = allSlots.results ?? [];
  const allPiecesDone = slotList.length > 0 && slotList.every((s) => !!s.pic1Id);

  let jcJustCompleted = false;
  const mergedJc: JobCardRow = { ...target.jc };
  if (
    allPiecesDone &&
    target.jc.status !== "COMPLETED" &&
    target.jc.status !== "TRANSFERRED"
  ) {
    mergedJc.status = "COMPLETED";
    mergedJc.completedDate = today;
    mergedJc.overdue = "COMPLETED";
    jcJustCompleted = true;
  } else if (
    // WAITING → IN_PROGRESS on the FIRST pic1 assignment. The first scan is
    // the operator "starting" the job card; if the rollup above didn't move
    // it straight to COMPLETED (e.g. multi-piece JCs only complete after
    // every piece's pic1 is filled), flip it to IN_PROGRESS now.
    // Never overwrite COMPLETED / TRANSFERRED — those are terminal and the
    // caller is expected to 409 long before we get here.
    target.jc.status === "WAITING" &&
    assignedSlot === 1
  ) {
    mergedJc.status = "IN_PROGRESS";
  }

  // Mirror legacy pic1/pic2 from first piece with a value.
  const firstWithPic1 = slotList.find((s) => s.pic1Id);
  const firstWithPic2 = slotList.find((s) => s.pic2Id);
  if (!mergedJc.pic1Id && firstWithPic1) {
    mergedJc.pic1Id = firstWithPic1.pic1Id;
    mergedJc.pic1Name = firstWithPic1.pic1Name ?? "";
  }
  if (!mergedJc.pic2Id && firstWithPic2) {
    mergedJc.pic2Id = firstWithPic2.pic2Id;
    mergedJc.pic2Name = firstWithPic2.pic2Name ?? "";
  }

  await db
    .prepare(
      `UPDATE job_cards SET status = ?, completedDate = ?, overdue = ?,
         pic1Id = ?, pic1Name = ?, pic2Id = ?, pic2Name = ? WHERE id = ?`,
    )
    .bind(
      mergedJc.status,
      mergedJc.completedDate,
      mergedJc.overdue,
      mergedJc.pic1Id,
      mergedJc.pic1Name ?? "",
      mergedJc.pic2Id,
      mergedJc.pic2Name ?? "",
      mergedJc.id,
    )
    .run();

  // Google Sheets sync — fire-and-forget. Mirror the scan-complete JC row
  // to its dept tab. Helper silently no-ops when the SA key is missing.
  scheduleFireAndForget(c, fireAndForgetSyncJc(c, mergedJc, target.po));

  // If JC just completed, emit WIP inventory update.
  if (jcJustCompleted) {
    const siblings = await db
      .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
      .bind(target.po.id)
      .all<JobCardRow>();
    // Scan path is forward-only (jcJustCompleted is computed from a
    // prevStatus that wasn't COMPLETED/TRANSFERRED). Pass target.jc.status
    // for completeness so the cascade's wasDone gate evaluates correctly.
    await applyWipInventoryChange(
      db,
      target.po,
      mergedJc,
      "COMPLETED",
      siblings.results ?? [],
      target.jc.status,
    );

    // F2 — labor cost posting (idempotent per jobCardId).
    await postJobCardLabor(db, mergedJc.id, target.po.id);
  }

  // PO progress rollup. currentDepartment is derived inline; status,
  // progress, completedDate flow through recomputePoStatusAndProgress
  // below so the same rules apply on every JC mutation site.
  const poJcsRes = await db
    .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
    .bind(target.po.id)
    .all<JobCardRow>();
  const poJcs = poJcsRes.results ?? [];
  const activeDept = poJcs.find(
    (j) => j.status === "IN_PROGRESS" || j.status === "WAITING",
  );
  const newCurrentDept = activeDept?.departmentCode || "PACKING";

  await db
    .prepare(
      `UPDATE production_orders SET currentDepartment = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(newCurrentDept, nowIso, target.po.id)
    .run();

  let scanRecomputed: Awaited<ReturnType<typeof recomputePoStatusAndProgress>> | null = null;
  try {
    scanRecomputed = await recomputePoStatusAndProgress(db, target.po.id);
  } catch (err) {
    console.error("[recomputePoStatusAndProgress] scan path failed", {
      poId: target.po.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  const allDone = scanRecomputed?.after?.status === "COMPLETED";

  if (allDone) {
    // Auto-generate FG units + fg_batches row on PO completion. Runs BEFORE
    // the SO/CO cascade so order progression sees the freshly created inventory.
    // Idempotent — safe on re-entry.
    await postProductionOrderCompletion(db, target.po.id);
    await cascadePoCompletionToSO(db, target.po.salesOrderId);
    // CO-parity twin — fires on POs whose parent is a CO (consignmentOrderId
    // set, salesOrderId NULL). The SO call above no-ops in that case.
    await cascadePoCompletionToCO(db, target.po.consignmentOrderId);
  }
  await cascadeUpholsteryToSO(db, target.po.id);
  await cascadeUpholsteryToCO(db, target.po.id);

  const freshPo = await fetchPO(db, target.po.id);
  const jcOut = freshPo?.jobCards.find((j) => j.id === target.jc.id);
  const redirected =
    target.po.id !== scannedPo.id || target.jc.id !== scannedJc.id;

  return c.json({
    success: true,
    data: {
      jobCard: jcOut,
      assignedSlot,
      workerName: worker.name,
      pieceNo: target.slot.pieceNo,
      pieceCompletedAt: newCompletedAt,
      jcJustCompleted,
      fifoRedirected: redirected,
      scannedPoId: scannedPo.id,
      scannedPoNo: scannedPo.poNo,
      assignedPoId: target.po.id,
      assignedPoNo: target.po.poNo,
      specKey: targetKey,
      fifoDueDate: target.jc.dueDate || target.po.targetEndDate || "",
      stickerKey,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/production-orders/:id
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const po = await fetchPO(c.var.DB, c.req.param("id"));
  if (!po) {
    return c.json({ success: false, error: "Production order not found" }, 404);
  }
  return c.json({ success: true, data: po });
});

// ---------------------------------------------------------------------------
// PUT /api/production-orders/:id
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);
  return applyPoUpdate(c, c.req.param("id"));
});

// ---------------------------------------------------------------------------
// PATCH /api/production-orders/:id — alias for PUT
// ---------------------------------------------------------------------------
app.patch("/:id", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);
  return applyPoUpdate(c, c.req.param("id"));
});

export default app;
