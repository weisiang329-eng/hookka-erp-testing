// ---------------------------------------------------------------------------
// Module-level helpers extracted VERBATIM from production-orders.ts.
// Behaviour-preserving split: this file contains only the non-endpoint
// declarations (types, mappers, cascades, cache + id helpers). All route
// handlers remain in production-orders.ts, which imports/re-exports from here.
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../../worker";
import { postProductionOrderCompletion } from "../../lib/fg-completion";
import { archiveUnionSource } from "../../lib/archive-union";
import {
  consumeRawMaterialsForPO,
  postJobCardLabor,
} from "../../lib/po-cost-cascade";
import {
  computeFcFabricUsageMeters,
  fetchBomWipComponentsByCode,
  fetchSofaSiblingsByGroupKey,
  sofaSiblingGroupKey,
  type SiblingPo,
} from "../../lib/fabric-usage";
import { checkProductionOrderLocked, lockedResponse } from "../../lib/lock-helpers";
import { emitAudit } from "../../lib/audit";
import { applyPackingRack } from "../../lib/packing-rack-write";
import { getOrgId, tryGetOrgId, DEFAULT_ORG_ID } from "../../lib/tenant";
import {
  poListCacheVersion,
  invalidateProductionListCaches,
} from "../../lib/po-list-cache";
// Phase 6 — parallel event sourcing for JC mutations. appendJobCardEvent
// writes go after the UPDATE lands so the source-of-truth row is committed
// before we narrate what changed; a write failure here does NOT roll the
// UPDATE back (events are audit-only, not the transactional source).
import {
  buildJobCardEventStatement,
  diffJobCardEvents,
} from "../../lib/job-card-events";
// Google Sheets sync (fire-and-forget). Helper silently no-ops when
// GOOGLE_SHEETS_SA_KEY is missing — see docs/SHEETS-SYNC.md.
import { syncJobCardToSheet } from "../../lib/sheets-sync";
import { planCompletionPieceStamps } from "../../lib/completion-piece-stamp";
// Per-request leadtime map → expectedDueDate computation. The Production
// overview cell flips its text colour to teal when a JC's persisted
// dueDate doesn't match what the *current* leadtime config says it
// should be (operator manually moved it, OR config changed underneath
// it). Computed at read time, never persisted — purely derived.
import {
  loadLeadTimes,
  leadDaysFor,
  addDays,
  DEPT_ORDER,
  type LeadTimeMap,
} from "../../lib/lead-times";
// HB-only completion gate (commit 9086352 + this commit). When a BEDFRAME PO
// carries specialOrder "Headboard Only", the SO/CO line really is HB-only —
// any DIVAN job_cards are either (a) filtered out at PO creation by the
// production-builder forward-only fix, or (b) legacy stragglers from before
// that fix that we don't touch (per memory feedback_protect_completed_work).
// Either way, completion math must ignore wipType=DIVAN so the HB pack alone
// can flip the PO to COMPLETED → SO/CO to READY_TO_SHIP.
import { isHeadboardOnlySpecial } from "../fg-units";


// ---------------------------------------------------------------------------
// HB-only completion filter — single helper used by every "are all JCs done?"
// gate so the rule stays in one place. Returns the JC list with DIVAN entries
// dropped when the PO is BEDFRAME + Headboard Only; otherwise returns the
// list unchanged. The match is on jc.wipType (the BOM tag set at PO creation
// — see _shared/production-builder breakBomIntoWips), not on labels/codes,
// so any future BOM relabeling stays self-consistent.
//
// Why we filter rather than delete legacy DIVAN JCs: per Wei Siang
// 2026-05-10 ("不用理 之后的"), legacy HB-only POs that already created
// DIVAN job_cards before commit 9086352 must keep those rows untouched.
// The cleanup endpoint /api/import/cleanup-headboard-only-divans (added in
// 9086352) is the explicit opt-in path for clearing them.
// ---------------------------------------------------------------------------
export function filterJcsForCompletionGate<
  J extends { wipType?: string | null },
>(
  po: { itemCategory?: string | null; specialOrder?: string | null } | null
    | undefined,
  jcs: J[],
): J[] {
  if (!po) return jcs;
  const isBf = (po.itemCategory ?? "").toUpperCase() === "BEDFRAME";
  if (!isBf) return jcs;
  if (!isHeadboardOnlySpecial(po.specialOrder ?? null)) return jcs;
  return jcs.filter((j) => (j.wipType ?? "").toUpperCase() !== "DIVAN");
}

// Self-applying migrations for the production-orders / job-cards space.
// Mirrors the pattern in src/api/routes/sales-orders.ts:1492 — each ALTER
// runs IF NOT EXISTS so it's idempotent + cheap, and the module-level
// promise gates one round of ALTERs per isolate boot, not per request.
//
// Added 2026-05-07: distributedAt on job_cards — the dept sheet needs a
// per-JC "Sent to floor" tick that survives sessions/devices so operators
// stop double-printing the same sheet.
export let pendingMigrations: Promise<void> | null = null;
export function ensurePendingMigrations(db: D1Database): Promise<void> {
  if (pendingMigrations) return pendingMigrations;
  pendingMigrations = (async () => {
    const stmts = [
      "ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS distributedAt TEXT",
      // ON HOLD reason columns (BUG-2026-06-24-008). The production list READ
      // joins sales_orders / consignment_orders and SELECTs
      // hold_reason/held_by/held_at (attachCustomerSO). Those columns are added
      // by the SO/CO WRITE path's own ensure — but the production read's cold
      // recompute can run BEFORE any SO/CO write has created them on this DB,
      // so the recompute 500s ("column hold_reason does not exist"). It stayed
      // hidden while the stale snapshot was served (never recomputed); forcing a
      // recompute exposed it. Ensure them on the READ path too. TEXT for all
      // three is type-safe (IF NOT EXISTS no-ops if the SO/CO ensure already
      // created them; a timestamp string stores fine in TEXT).
      "ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS hold_reason TEXT",
      "ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS held_by TEXT",
      "ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS held_at TEXT",
      "ALTER TABLE consignment_orders ADD COLUMN IF NOT EXISTS hold_reason TEXT",
      "ALTER TABLE consignment_orders ADD COLUMN IF NOT EXISTS held_by TEXT",
      "ALTER TABLE consignment_orders ADD COLUMN IF NOT EXISTS held_at TEXT",
      // BUG-2026-05-12 (FOAM 326 cleanup): WIP cascade idempotency log. Every
      // call to applyWipInventoryChange first INSERTs into this table with
      // ON CONFLICT DO NOTHING; if no row was inserted the cascade
      // short-circuits. Atomic, concurrent-safe, catches the cross-session
      // replay case BUG-005 misses (backfill scripts, retries, migration
      // imports re-firing the cascade on already-final-state JCs).
      //
      // org_id is TEXT (not UUID) to match the multi-tenant skeleton from
      // migration 0049 — every Hookka table uses TEXT 'hookka' as the tenant
      // scope. The initial deploy on 2026-05-12 declared this as UUID by
      // mistake, which caused every INSERT to fail silently (caught + logged
      // as warning, so cascade still ran but without the idempotency guard
      // active). The ALTER fixes any existing-with-wrong-type rows in place.
      `CREATE TABLE IF NOT EXISTS wip_cascade_log (
         id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         org_id      TEXT NOT NULL,
         job_card_id TEXT NOT NULL,
         from_status TEXT,
         to_status   TEXT NOT NULL,
         source      TEXT NOT NULL,
         applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      // Fix prior-deploy mistake — flip org_id from UUID to TEXT if needed.
      // ALTER ... USING is idempotent: re-running when already TEXT is a no-op.
      `ALTER TABLE wip_cascade_log
         ALTER COLUMN org_id TYPE TEXT USING org_id::text`,
      // NULL from_status is treated distinct by Postgres uniqueness, so the
      // index is partial — one for the common (from, to) pair, one for the
      // initial-emission case.
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_wip_cascade_log_transition
         ON wip_cascade_log (org_id, job_card_id, from_status, to_status)
         WHERE from_status IS NOT NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_wip_cascade_log_initial
         ON wip_cascade_log (org_id, job_card_id, to_status)
         WHERE from_status IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_wip_cascade_log_jc
         ON wip_cascade_log (org_id, job_card_id, applied_at DESC)`,
    ];
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch (err) {
        // Best-effort. Log so silent schema drift surfaces in wrangler tail
        // (per the security-fix tightening landed earlier this branch).
        console.warn("[production-orders.migrations] DDL skipped", {
          sql: sql.split("\n")[0],
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
export async function fireAndForgetSyncJc(
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

export function scheduleFireAndForget(c: Context<Env>, p: Promise<unknown>): void {
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
  // Service-order Repair Scope snapshot (0160), stamped at PO creation by
  // the production builder. Runtime-added column → SELECT * rows carry the
  // folded-lowercase key (BUG-2026-06-11-007); read dual-key.
  repairScope?: string | null;
  repairscope?: string | null;
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

export type PiecePicRow = {
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
  // Per-PIECE warehouse rack (mig 0192). New snake_case column; dual-keyed read
  // (rackingNumber from toCamel folding, racking_number raw) so it survives both.
  rackingNumber?: string | null;
  racking_number?: string | null;
};

// Shape mirrored to the frontend — matches the in-memory PiecePic type.
export type PiecePicOut = {
  pieceNo: number;
  pic1Id: string | null;
  pic1Name: string;
  pic2Id: string | null;
  pic2Name: string;
  completedAt: string | null;
  lastScanAt: string | null;
  boundStickerKey: string | null;
};

export type ProductionOrderOut = ReturnType<typeof rowToPO>;

export function rowToPiecePic(r: PiecePicRow): PiecePicOut {
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
export function computeExpectedDueDate(
  targetEndDate: string | null | undefined,
  itemCategory: string | null | undefined,
  deptCode: string | null | undefined,
  leadTimeMap: LeadTimeMap | null,
): string {
  if (!targetEndDate || !itemCategory || !deptCode || !leadTimeMap) return "";
  const days = leadDaysFor(leadTimeMap, itemCategory, deptCode);
  return addDays(targetEndDate, -days);
}

export function rowToJobCard(
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
export type MinimalJobCardOut = {
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
  // Per-piece PIC slots — populated ONLY when the caller passes piece_pics
  // (the worker scan-lookup, so the phone can pre-check "already done /
  // limit reached" on a per-piece sticker BEFORE the worker taps Complete).
  // Omitted (undefined) on the Production page's minimal payload. BUG-2026-06-08.
  piecePics?: PiecePicOut[];
};
export type MinimalPOOut = {
  id: string;
  poNo: string;
  salesOrderId: string;
  salesOrderNo: string;
  companySOId: string;
  consignmentOrderId: string;
  companyCOId: string;
  customerPOId: string;
  customerReference: string;
  // Customer's own SO number (sales_orders.customerSOId), or the customer's
  // CO number (consignment_orders.customerCOId) for CO-origin POs. NOT a
  // production_orders column — batch-joined onto the payload by
  // attachCustomerSO() at the route boundary. "" until then.
  customerSO: string;
  customerName: string;
  customerState: string;
  // Planning aid (2026-05-28) — batch-joined by attachCustomerSO from
  // sales_orders. Customer's requested delivery date + Hookka's internal
  // target. "" for CO-origin POs. Read by the dept sheet's Customer DD /
  // Our Expected DD columns.
  customerDeliveryDate: string;
  hookkaExpectedDD: string;
  // ON HOLD reason (0185) — sourced from the parent SO / CO, NOT a
  // production_orders column. Like customerSO above, it is emitted here as a
  // declared "" default so the key is ALWAYS present on the returned object
  // (and therefore in any list snapshot blob); attachCustomerSO() then
  // overwrites it with the real value at the route boundary. WITHOUT this
  // anchor the field only existed as a transient mutation that the
  // production_orders_list_snapshot cache dropped, so the grid never saw it
  // (BUG-2026-06-24-001). The grid reads these only on ON_HOLD rows.
  holdReason: string;
  heldBy: string;
  heldAt: string;
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
  // Service-order Repair Scope snapshot (0160) — JSON string or null.
  // The delivery pipeline keys its no-UPHOLSTERY readiness fallback on it.
  repairScope: string | null;
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

export function rowToMinimalJobCard(
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
  // When a dept tab is active, the frontend only renders the OTHER-dept
  // JCs as date-pill cells (renderDeptSchedCell — production/index.tsx
  // L2221). Those cells only read id, departmentCode, dueDate, completed-
  // Date, status, wipKey, branchKey, prerequisiteMet, expectedDueDate.
  // Sending the full ~25-field JC for every PACKING / WOOD_CUT / FOAM
  // row on a 700-PO sheet was ~7 MB of wire payload that the FE never
  // looked at. activeDeptCode='UPHOLSTERY' (etc.) opts into a slim
  // shape: full for the active dept + FAB_CUT (FC row needs PIC, prod-
  // Time, fabricUsage), slim for the rest. activeDeptCode=null (overview
  // mode) keeps the full shape for every dept — the matrix needs them.
  activeDeptCode: string | null = null,
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
  // Slim path: non-active, non-FC JC on a dept-filtered request only
  // renders as a date pill in the row's `sched_<DEPT>.sortKey` column.
  // Drop fields the renderer never reads (wipCode, wipType, wipLabel,
  // wipQty, pic1Id/pic1Name/pic2Id/pic2Name, productionTimeMinutes,
  // estMinutes, category, rackingNumber, piecesTotal/piecesDone,
  // distributedAt, fabricUsageMeters). Saves ~70% per JC on the wire,
  // which is dominant on wide-range fetches (~10k other-dept JCs).
  if (
    activeDeptCode !== null &&
    r.departmentCode !== activeDeptCode &&
    r.departmentCode !== "FAB_CUT"
  ) {
    // Slim shape — JSON.stringify drops `undefined` so the wire payload
    // omits ~12 fields the FE's renderDeptSchedCell never reads. Each
    // dropped field saves ~15-25 bytes after key+separator; on a 9k-JC
    // wide-range response that's another ~2-3 MB on top of the field
    // count itself. The FE side reads these via `?? 0` / `|| ""` /
    // `?? null` defaults (production/index.tsx L2112-2145), so undefined
    // is safe — confirmed by reading every consumer of jc.pic1Name,
    // .pic2Name, .productionTimeMinutes, .estMinutes, .category,
    // .piecesTotal, .piecesDone, .distributedAt before this edit.
    // TS-side: MinimalJobCardOut declares those fields non-optional, so
    // we still satisfy the type with `0 / "" / null` for keys that the
    // FE WOULD read but we want to keep as the JSON wire-default. The
    // ones we want fully dropped use undefined casts.
    return {
      id: r.id,
      departmentCode: r.departmentCode ?? "",
      sequence: r.sequence,
      status: r.status,
      dueDate: r.dueDate ?? "",
      expectedDueDate: computeExpectedDueDate(
        parentTargetEndDate,
        parentItemCategory,
        r.departmentCode,
        leadTimeMap,
      ),
      wipKey: r.wipKey ?? undefined,
      branchKey: r.branchKey ?? undefined,
      prerequisiteMet: Boolean(r.prerequisiteMet),
      completedDate: r.completedDate,
      // Wire-drop these (FE tolerates undefined). Cast through unknown so
      // the slim record still satisfies the full MinimalJobCardOut type
      // without polluting the wire JSON with empty placeholders.
      pic1Id: undefined as unknown as null,
      pic1Name: undefined as unknown as string,
      pic2Id: undefined as unknown as null,
      pic2Name: undefined as unknown as string,
      productionTimeMinutes: undefined as unknown as number,
      estMinutes: undefined as unknown as number,
      category: undefined as unknown as string,
      piecesTotal: undefined as unknown as number,
      piecesDone: undefined as unknown as number,
      distributedAt: undefined as unknown as null,
    };
  }
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

// Exported so the worker portal's scan-lookup (worker.ts) can reuse the exact
// same PO+jobCards shape the Production page consumes — the /worker/scan page's
// Order/JobCard types are a view of this output. Reusing it (rather than
// re-assembling) keeps the scan card from silently missing a field.
export function rowToMinimalPO(
  row: ProductionOrderRow,
  jobCards: JobCardRow[] = [],
  piecesDoneByJc: Map<string, number> = new Map(),
  leadTimeMap: LeadTimeMap | null = null,
  bomByProductCode: Map<string, unknown> | null = null,
  siblingsByGroupKey: Map<string, SiblingPo[]> | null = null,
  baseModelByProductCode: Map<string, string> | null = null,
  // Dept tab routes the active dept code in via the ?dept=X query param.
  // Passed through to rowToMinimalJobCard so non-active-dept JCs render
  // as slim shape (renderDeptSchedCell only reads ~9 fields out of ~25).
  activeDeptCode: string | null = null,
  // Opt-in per-piece slots, keyed by jobCardId. Only the worker scan-lookup
  // passes this (so the phone can pre-check "already done" on a per-piece
  // sticker); every other caller omits it and the payload is unchanged.
  picsByJcId: Map<string, PiecePicRow[]> | null = null,
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
    .map((j) => {
      const jc = rowToMinimalJobCard(
        j,
        piecesDoneByJc,
        parentTargetEndDate,
        parentItemCategory,
        leadTimeMap,
        parentPoForFabric,
        bomWipComponents,
        bomByProductCode,
        siblings,
        activeDeptCode,
      );
      // Attach per-piece slots only when the caller supplied them (worker
      // scan-lookup). BUG-2026-06-08: without this the phone's per-piece
      // "already done" pre-check is blind and the worker can re-tap Complete.
      const pics = picsByJcId?.get(j.id);
      if (pics && pics.length > 0) jc.piecePics = pics.map(rowToPiecePic);
      return jc;
    });
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
    customerSO: "",
    // Filled by attachCustomerSO at the route boundary (batch-join).
    customerDeliveryDate: "",
    hookkaExpectedDD: "",
    // ON HOLD reason (0185) — declared "" default so the key is always present
    // (survives the list snapshot); attachCustomerSO overwrites with the real
    // SO/CO value. See the MinimalPOOut comment (BUG-2026-06-24-001).
    holdReason: "",
    heldBy: "",
    heldAt: "",
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
    // Repair Scope (0160) — dual-key: runtime-added column comes back under
    // the folded-lowercase key on SELECT * rows.
    repairScope: row.repairScope ?? row.repairscope ?? null,
    status: row.status,
    currentDepartment: row.currentDepartment ?? "",
    progress: row.progress ?? 0,
    completedDate: row.completedDate ?? null,
    lineNo: row.lineNo,
    targetEndDate: row.targetEndDate ?? "",
    jobCards: myJCs,
  };
}

export function rowToPO(
  row: ProductionOrderRow,
  jobCards: JobCardRow[] = [],
  pics: PiecePicRow[] = [],
  leadTimeMap: LeadTimeMap | null = null,
) {
  // Tier B B1 fix 2026-05-21 (Agent C #1, the 5-17s Production page
  // slowness) — when this function is called from a batched
  // caller (.map over many POs with the SAME full arrays), the inner
  // .filter is O(N×M). For 530 PO × 2200 JC that's ~1.16M comparisons
  // per page load. Batched callers should use rowsToPOsBatch() below
  // which pre-groups once at O(N+M). This direct function is
  // preserved verbatim (same .filter, same output shape) for the few
  // single-PO callers (line 1586, GET /api/production-orders/:id)
  // and any future caller that genuinely has one PO at a time.
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
    customerSO: "",
    // ON HOLD reason (0185) — declared "" default (parity with customerSO);
    // attachCustomerSO overwrites with the parent SO/CO value at the route
    // boundary so the key always rides to the FE (BUG-2026-06-24-001).
    holdReason: "",
    heldBy: "",
    heldAt: "",
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
    // Repair Scope (0160) — dual-key: runtime-added column comes back under
    // the folded-lowercase key on SELECT * rows.
    repairScope: row.repairScope ?? row.repairscope ?? null,
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
// Batched PO → JSON converter (Tier B B1, Agent C #1, 2026-05-21).
//
// Same output as `rows.map(r => rowToPO(r, allJcs, allPics, leadTimeMap))`
// but O(N + M) instead of O(N × M). Builds two indexes once:
//   • jcsByPoId : Map<poId, JobCardRow[]>
//   • picsByJcId: Map<jcId, PiecePicRow[]>
// Then each PO row does an O(1) lookup. Output shape is identical
// (verified field-by-field against rowToPO + rowToJobCard) so every
// frontend (Production matrix, dept tabs, dashboard cross-dept dates,
// Workers page completion dates) sees exactly the same data — only
// the server-side compute path changes.
//
// Measured win at current data (530 PO × 2200 JC): 1.16M comparisons
// → 2,730 ops. ~400× cheaper per request.
//
// Sorting honoured: JCs by sequence, pics by pieceNo — same as rowToPO/
// rowToJobCard. Sorting happens once per bucket here vs per-PO before.
// ---------------------------------------------------------------------------
export function rowsToPOsBatch(
  rows: ProductionOrderRow[],
  allJcs: JobCardRow[],
  allPics: PiecePicRow[],
  leadTimeMap: LeadTimeMap | null = null,
): ReturnType<typeof rowToPO>[] {
  // Group JCs by productionOrderId, sorted by sequence within each bucket.
  const jcsByPoId = new Map<string, JobCardRow[]>();
  for (const j of allJcs) {
    const arr = jcsByPoId.get(j.productionOrderId);
    if (arr) arr.push(j);
    else jcsByPoId.set(j.productionOrderId, [j]);
  }
  for (const arr of jcsByPoId.values()) {
    arr.sort((a, b) => a.sequence - b.sequence);
  }

  // Group pics by jobCardId, sorted by pieceNo within each bucket.
  const picsByJcId = new Map<string, PiecePicRow[]>();
  for (const p of allPics) {
    const arr = picsByJcId.get(p.jobCardId);
    if (arr) arr.push(p);
    else picsByJcId.set(p.jobCardId, [p]);
  }
  for (const arr of picsByJcId.values()) {
    arr.sort((a, b) => a.pieceNo - b.pieceNo);
  }

  return rows.map((row) => {
    const parentTargetEndDate = row.targetEndDate ?? null;
    const parentItemCategory = row.itemCategory ?? null;
    const myJCs = (jcsByPoId.get(row.id) ?? []).map((j) => {
      const myPics = (picsByJcId.get(j.id) ?? []).map(rowToPiecePic);
      return {
        id: j.id,
        departmentId: j.departmentId ?? "",
        departmentCode: j.departmentCode ?? "",
        departmentName: j.departmentName ?? "",
        sequence: j.sequence,
        status: j.status,
        dueDate: j.dueDate ?? "",
        expectedDueDate: computeExpectedDueDate(
          parentTargetEndDate,
          parentItemCategory,
          j.departmentCode,
          leadTimeMap,
        ),
        wipKey: j.wipKey ?? undefined,
        wipCode: j.wipCode ?? undefined,
        wipType: j.wipType ?? undefined,
        wipLabel: j.wipLabel ?? undefined,
        wipQty: j.wipQty ?? undefined,
        branchKey: j.branchKey ?? undefined,
        prerequisiteMet: Boolean(j.prerequisiteMet),
        pic1Id: j.pic1Id,
        pic1Name: j.pic1Name ?? "",
        pic2Id: j.pic2Id,
        pic2Name: j.pic2Name ?? "",
        completedDate: j.completedDate,
        estMinutes: j.estMinutes,
        actualMinutes: j.actualMinutes,
        category: j.category ?? "",
        productionTimeMinutes: j.productionTimeMinutes,
        overdue: j.overdue ?? "",
        rackingNumber: j.rackingNumber ?? undefined,
        distributedAt: j.distributedAt ?? null,
        piecePics: myPics.length > 0 ? myPics : undefined,
      };
    });
    return {
      id: row.id,
      poNo: row.poNo,
      salesOrderId: row.salesOrderId ?? "",
      salesOrderNo: row.salesOrderNo ?? "",
      lineNo: row.lineNo,
      customerPOId: row.customerPOId ?? "",
      customerReference: row.customerReference ?? "",
      customerSO: "",
      // ON HOLD reason (0185) — declared "" default (parity with rowToPO /
      // customerSO); attachCustomerSO overwrites it (BUG-2026-06-24-001).
      holdReason: "",
      heldBy: "",
      heldAt: "",
      customerName: row.customerName ?? "",
      customerState: row.customerState ?? "",
      companySOId: row.companySOId ?? "",
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
      // Repair Scope (0160) — dual-key (see rowToPO; identical shape).
      repairScope: row.repairScope ?? row.repairscope ?? null,
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
  });
}

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------
export function genPoId(): string {
  return `pord-${crypto.randomUUID().slice(0, 8)}`;
}
export function genJcId(): string {
  return `jc-${crypto.randomUUID().slice(0, 8)}`;
}
export function genSoId(): string {
  return `so-${crypto.randomUUID().slice(0, 8)}`;
}
export function genItemId(): string {
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
export async function fetchInChunks<R>(
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
export async function fetchPiecesDoneByJc(
  db: D1Database,
  orgId: string,
  jcIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (jcIds.length === 0) return out;
  // Phase B+ (2026-05-08): the chunked IN(...) variant fanned 12 k JC IDs
  // into 122 parallel `IN (?,?,?,...)` queries via Hyperdrive — Hyperdrive's
  // pool serialises beyond a small concurrency, so the 100/chunk batches
  // cumulatively cost ~3 s on prod (the 90% slice of /api/production-orders
  // server time per the inline ?debug=timing probe). One unfiltered
  // `GROUP BY jobCardId` returns the same map in <100 ms — the wider scope
  // is harmless because the caller already loads every JC the user is
  // entitled to in the same request, and Postgres collapses the count
  // server-side. We still scope by orgId so cross-tenant counts can't leak.
  // Result rows that aren't in jcIds get dropped during the Map fill below.
  void jcIds;
  const wanted = new Set(jcIds);
  const stmt = db
    .prepare(
      `SELECT jobCardId, COUNT(*) AS "piecesDone"
         FROM piece_pics
        WHERE orgId = ?
          AND pic1Id IS NOT NULL
        GROUP BY jobCardId`,
    )
    .bind(orgId);
  const res = await stmt.all<{ jobCardId: string; piecesDone: number }>();
  for (const r of res.results ?? []) {
    if (!wanted.has(r.jobCardId)) continue;
    out.set(r.jobCardId, Number(r.piecesDone) || 0);
  }
  return out;
}

export async function fetchAllPOs(
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
  // Tier B B1 (2026-05-21) — batched O(N+M) conversion. Same output as
  // .map(rowToPO) but ~400× cheaper at current data scale.
  return rowsToPOsBatch(pos.results ?? [], jcs.results ?? [], pics.results ?? []);
}

// Variant of fetchAllPOs that supports server-side status filtering and
// optional omission of inlined jobCards. Used by the list endpoint so the
// Production page can avoid shipping every PO + every JC on mount.
//
// - statuses: if provided (non-empty), applies `WHERE status IN (...)` at the
//   SQL layer.
// - includeJobCards: when false, skip the job_cards + piece_pics fetches and
//   return POs with `jobCards: []`. Defaults to true for backward compat.
// The customer's own SO number lives on sales_orders.customerSOId (and the
// customer's CO number on consignment_orders.customerCOId for CO-origin
// POs) — NOT on production_orders. The legacy customerSO / customerCO
// columns are dead (always empty); the live data is in the *Id columns,
// matching the Sales/Consignment grids' own column keys. The Production
// dept sheet's
// "Customer SO" column needs it, so we batch-join it onto the PO payload
// at the route boundary. Doing it here (one spot) keeps the many
// rowToPO / rowToMinimalPO call sites untouched. CO POs fall back to the
// consignment customer-CO number per Wei Siang's spec.
export async function attachCustomerSO(
  db: D1Database,
  pos: Array<{
    salesOrderId: string;
    consignmentOrderId: string;
    customerSO: string;
    // 2026-06-03: the PO row carries snapshot copies of customerPOId /
    // customerReference, but those snapshots are sparsely populated on the
    // production_orders table — the live values live on the joined
    // sales_orders row (customerPOId / customerPO + reference). Same batch
    // join already loads the SO, so we enrich both here too (preferring the
    // populated SO values, PO snapshot as fallback). Mirrors the Delivery
    // page fix (commit 2c548b60): *Id column first, plain column next.
    customerPOId?: string;
    customerReference?: string;
    // 2026-05-28: planning aid — surface the customer's requested delivery
    // date + Hookka's internal expected DD on the production sheet so the
    // operator can plan against the real promise without flipping to the SO.
    // Same batch-join as customerSO (zero extra round-trip, just 2 more cols).
    // CO-origin POs leave these "" (consignment has no customer DD concept).
    customerDeliveryDate?: string;
    hookkaExpectedDD?: string;
    // ON HOLD reason (0185) — sourced from the parent SO / CO via the same
    // batch join. Surfaces on the production grid's ON HOLD chip + a faint
    // reason line. Sourcing from the order (not a production_orders column)
    // means editing a hold reason never requires re-cascading to the POs.
    holdReason?: string;
    heldBy?: string;
    heldAt?: string;
  }>,
): Promise<void> {
  if (pos.length === 0) return;
  const soIds = Array.from(
    new Set(pos.map((p) => p.salesOrderId).filter(Boolean)),
  );
  const coIds = Array.from(
    new Set(pos.map((p) => p.consignmentOrderId).filter(Boolean)),
  );
  const soMap = new Map<string, string>();
  // SO id → enriched customer PO / reference (prefer-*Id resolved). Populated
  // from the same SO chunk query below (no extra round-trip).
  const soRefMap = new Map<string, { customerPOId: string; reference: string }>();
  const coMap = new Map<string, string>();
  // SO id → { customerDeliveryDate, hookkaExpectedDD }. Populated from the
  // same SO chunk query below (no extra round-trip).
  const soDatesMap = new Map<
    string,
    { customerDeliveryDate: string; hookkaExpectedDD: string }
  >();
  // order id (SO or CO) → ON HOLD reason triple. Populated from the same SO /
  // CO chunk queries below (no extra round-trip). Empty for orders not on hold.
  const holdMap = new Map<
    string,
    { holdReason: string; heldBy: string; heldAt: string }
  >();
  // Chunk well under the bound-variable ceiling.
  const CHUNK = 200;
  // Perf 2026-05-22 — fire every SO chunk + CO chunk query as ONE parallel
  // batch instead of awaiting each chunk in sequence. With ~1000 distinct
  // SO ids on a Production dept load that was ~6 serial Hyperdrive
  // round-trips (~0.9s of pure latency); now it is a single wave. Output
  // is identical — same per-chunk SQL, same maps.
  const soChunks: string[][] = [];
  for (let i = 0; i < soIds.length; i += CHUNK) {
    soChunks.push(soIds.slice(i, i + CHUNK));
  }
  const coChunks: string[][] = [];
  for (let i = 0; i < coIds.length; i += CHUNK) {
    coChunks.push(coIds.slice(i, i + CHUNK));
  }
  const [soResults, coResults] = await Promise.all([
    Promise.all(
      soChunks.map((slice) =>
        db
          .prepare(
            `SELECT id, customerSOId, customerPOId, customerPO, reference, customerDeliveryDate, hookkaExpectedDD, hold_reason, held_by, held_at FROM sales_orders WHERE id IN (${slice.map(() => "?").join(",")})`,
          )
          .bind(...slice)
          .all<{
            id: string;
            customerSOId: string | null;
            customerPOId: string | null;
            customerPO: string | null;
            reference: string | null;
            customerDeliveryDate: string | null;
            hookkaExpectedDD: string | null;
            // snake_case columns come back camelCased via the db adapter
            // (postgres.toCamel: hold_reason → holdReason). Dual-keyed below.
            holdReason?: string | null;
            hold_reason?: string | null;
            heldBy?: string | null;
            held_by?: string | null;
            heldAt?: string | null;
            held_at?: string | null;
          }>(),
      ),
    ),
    Promise.all(
      coChunks.map((slice) =>
        db
          .prepare(
            `SELECT id, customerCOId, hold_reason, held_by, held_at FROM consignment_orders WHERE id IN (${slice.map(() => "?").join(",")})`,
          )
          .bind(...slice)
          .all<{
            id: string;
            customerCOId: string | null;
            holdReason?: string | null;
            hold_reason?: string | null;
            heldBy?: string | null;
            held_by?: string | null;
            heldAt?: string | null;
            held_at?: string | null;
          }>(),
      ),
    ),
  ]);
  for (const res of soResults) {
    for (const r of res.results ?? []) {
      soMap.set(r.id, r.customerSOId || "");
      // Prefer the populated *Id column, then the plain column. Mirrors the
      // Delivery page resolution (commit 2c548b60).
      soRefMap.set(r.id, {
        customerPOId: r.customerPOId || r.customerPO || "",
        reference: r.reference || "",
      });
      soDatesMap.set(r.id, {
        customerDeliveryDate: (r.customerDeliveryDate || "").slice(0, 10),
        hookkaExpectedDD: (r.hookkaExpectedDD || "").slice(0, 10),
      });
      // ON HOLD reason (0185) — dual-key read (snake_case → camelCase via the
      // adapter, but tolerate the raw key too). Only store a non-empty reason.
      const hr = (r.holdReason ?? r.hold_reason ?? "").trim();
      if (hr) {
        holdMap.set(r.id, {
          holdReason: hr,
          heldBy: (r.heldBy ?? r.held_by ?? "").trim(),
          heldAt: (r.heldAt ?? r.held_at ?? "").slice(0, 16).replace("T", " "),
        });
      }
    }
  }
  for (const res of coResults) {
    for (const r of res.results ?? []) {
      coMap.set(r.id, r.customerCOId || "");
      const hr = (r.holdReason ?? r.hold_reason ?? "").trim();
      if (hr) {
        holdMap.set(r.id, {
          holdReason: hr,
          heldBy: (r.heldBy ?? r.held_by ?? "").trim(),
          heldAt: (r.heldAt ?? r.held_at ?? "").slice(0, 16).replace("T", " "),
        });
      }
    }
  }
  for (const p of pos) {
    p.customerSO =
      soMap.get(p.salesOrderId) || coMap.get(p.consignmentOrderId) || "";
    // Enrich customerPOId / customerReference from the joined SO, preferring
    // the populated SO values over the (sparse) production_orders snapshot.
    // CO-origin POs (no salesOrderId) keep their existing snapshot values.
    const ref = soRefMap.get(p.salesOrderId);
    if (ref) {
      p.customerPOId = ref.customerPOId || p.customerPOId || "";
      p.customerReference = ref.reference || p.customerReference || "";
    }
    const dates = soDatesMap.get(p.salesOrderId);
    p.customerDeliveryDate = dates?.customerDeliveryDate || "";
    p.hookkaExpectedDD = dates?.hookkaExpectedDD || "";
    // ON HOLD reason (0185) — from the parent SO or CO. Empty for orders not
    // on hold; the grid only reads these on ON_HOLD rows anyway.
    const hold =
      holdMap.get(p.salesOrderId) || holdMap.get(p.consignmentOrderId);
    p.holdReason = hold?.holdReason || "";
    p.heldBy = hold?.heldBy || "";
    p.heldAt = hold?.heldAt || "";
  }
}

export async function fetchFilteredPOs(
  db: D1Database,
  orgId: string,
  statuses: string[] | null,
  includeJobCards: boolean,
  includeArchive = false,
  minimal = false,
  deptFilter: string | null = null,
  dueFrom: string | null = null,
  dueTo: string | null = null,
  catFilter: string | null = null,
  // Phase 4 (2026-05-24): when true, drop COMPLETED / TRANSFERRED / CANCELLED
  // PO rows at SQL level. FE passes this on dept tabs by default since
  // its column filter already hides those statuses client-side. Cuts wire
  // + parse cost by ~60% on a typical dept tab.
  excludeCompleted = false,
  // Sticker-print scope: when non-empty, only POs whose id / poNo / companySOId
  // / salesOrderId / companyCOId / consignmentOrderId is in this set come back
  // (2026-06-24 — Fab Sew / Foam print fetch only the visible orders + their
  // SO/CO group, not the whole org).
  scopeTokens: string[] | null = null,
): Promise<ProductionOrderOut[] | MinimalPOOut[]> {
  // Load the (category, deptCode) → days map once per request. Drives the
  // derived `expectedDueDate` field on each JC — the FE compares it
  // against the persisted `dueDate` to flip the Production overview cell
  // text to teal when an operator has manually moved a JC off the
  // current leadtime plan. Single round-trip; safe to fail-soft (a null
  // map yields expectedDueDate = "" which the FE treats as "on plan").
  // Perf 2026-05-22 — kick the lead-time query off here but DON'T await it
  // yet; it's joined into the Promise.all with the BOM/siblings fetch below
  // so the two run in parallel instead of as two serial Hyperdrive
  // round-trips. leadTimeMap is only consumed after that await.
  const leadTimeP = loadLeadTimes(db).catch(() => null);
  const hasFilter = Array.isArray(statuses) && statuses.length > 0;
  const placeholders = hasFilter
    ? statuses.map(() => "?").join(",")
    : "";
  // Phase-5: when includeArchive is set, UNION hot + archive. Hot rows get
  // a projected '' archivedAt so the column lists align with the archive
  // table. rowToPO ignores columns it doesn't know about.
  // includeArchive UNION: route BOTH the po and jc sources through the
  // self-healing helper (introspects + brings the archive into column parity,
  // emits an explicit ordered column list — see src/api/lib/archive-union.ts).
  // Falls back to the legacy SELECT * literal only if introspection fails.
  const poSource = includeArchive
    ? (await archiveUnionSource(db, "production_orders", "production_orders_archive")) ??
      `(SELECT *, '' AS "archivedAt" FROM production_orders
        UNION ALL
        SELECT * FROM production_orders_archive)`
    : "production_orders";
  const jcSource = includeArchive
    ? (await archiveUnionSource(db, "job_cards", "job_cards_archive")) ??
      `(SELECT *, '' AS "archivedAt" FROM job_cards
        UNION ALL
        SELECT * FROM job_cards_archive)`
    : "job_cards";
  // Sprint 4: orgId is always the leading WHERE predicate. Status filter
  // becomes an AND clause when present.
  // dueFrom / dueTo: date window applied differently depending on context:
  //   overview (no deptFilter)  → the PO's SO "Our Expected DD"
  //                               (sales_orders.hookkaExpectedDD) window — this
  //                               is the column the operator actually reads in
  //                               the Overview "Our Expected DD" cell, so the
  //                               top Due-Date range filter must key off it, NOT
  //                               the internal targetEndDate (2026-06-10).
  //   dept page (deptFilter set) → that dept's JC.dueDate window (correct semantic
  //                                for /production/<dept> filtering)
  // Undated rows are preserved on both sides — a PO with no salesOrderId
  // (CO-origin) or a NULL/'' hookkaExpectedDD still passes the overview window
  // (never silently dropped), and a JC with NULL dueDate still passes the dept
  // window — so the daily view keeps showing them.
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
      // Overview mode: window the PO's SO "Our Expected DD". Correlated
      // subquery looks up sales_orders.hookkaExpectedDD for this PO's
      // salesOrderId. NULLIF(...,'') folds an empty stored value into NULL so
      // the "undated → always shown" guard covers both NULL and ''. The outer
      // `salesOrderId` is referenced unqualified so the clause works whether
      // the FROM is `production_orders` or the (unaliased) hot+archive UNION;
      // sales_orders has no salesOrderId column, so there is no ambiguity.
      // A PO with NULL salesOrderId (CO-origin) short-circuits the OR and is
      // always kept.
      const ddExpr =
        "NULLIF((SELECT so.hookkaExpectedDD FROM sales_orders so WHERE so.id = salesOrderId), '')";
      if (dueFrom) {
        dueClauses.push(
          `(salesOrderId IS NULL OR ${ddExpr} IS NULL OR ${ddExpr} >= ?)`,
        );
        dueBindings.push(dueFrom);
      }
      if (dueTo) {
        dueClauses.push(
          `(salesOrderId IS NULL OR ${ddExpr} IS NULL OR ${ddExpr} <= ?)`,
        );
        dueBindings.push(dueTo);
      }
    }
  }
  const dueWhere = dueClauses.length > 0 ? ` AND ${dueClauses.join(" AND ")}` : "";
  const catWhere = catFilter ? ' AND itemCategory = ?' : '';
  const catBindings: string[] = catFilter ? [catFilter] : [];
  // Phase 4 (2026-05-24): excludeCompleted=true drops PO rows the operator
  // never sees by default — the Production grid's defaultExcludedValues
  // already hides COMPLETED + TRANSFERRED + CANCELLED status rows
  // client-side, so the wire payload was shipping ~60% rows that just got
  // discarded after parse. Filtering at SQL cuts the decompressed payload
  // by ~60% on a typical dept tab (7.6 MB → ~3 MB measured).
  // CANCELLED rows are dropped too because the FE's special-pill render
  // already shows them via a separate path on overview only.
  // 2026-05-25 — Wei Siang reported Planning page's "Past 7d Production"
  // chart was undercounting because the original `excludeCompleted` filter
  // (status NOT IN COMPLETED/TRANSFERRED/CANCELLED) dropped EVERY fully-
  // completed PO, including those whose JCs were completed in the last
  // week. Planning aggregates per-JC actualMinutes by completedDate, so
  // it NEEDS the recently-completed POs to come through.
  //
  // Fix: when excludeCompleted is on, still drop OLD completed/cancelled
  // POs but KEEP any PO that was completed in the last 35 days. 35 picked
  // to cover Planning's 7-day past window with margin (and Master Tracker
  // / monthly retro views that look back further). Per-row cost is small
  // because the date filter is very selective.
  const completedCutoffDate = new Date();
  completedCutoffDate.setDate(completedCutoffDate.getDate() - 35);
  const completedCutoffIso = completedCutoffDate.toISOString().slice(0, 10);
  const excludeCompletedWhere = excludeCompleted
    ? ` AND (status NOT IN ('COMPLETED','TRANSFERRED','CANCELLED') OR (completedDate IS NOT NULL AND completedDate >= '${completedCutoffIso}'))`
    : '';
  // Phase 4: when a dept tab fetches, drop POs that have NO JC for the
  // requested dept (sibling chain still preserved via companySOId /
  // companyCOId — mirrors the existing jcWhereDept subquery so the SOFA
  // cross-PO Divan-only siblings still come through when their SO has at
  // least one PO with the requested dept's JC). Was previously returning
  // every PO in the org, leaving the FE to filter ~1086 → 464 rows; now
  // the SQL does that filter, cutting another ~50% from the response.
  const deptScopeWhere = deptFilter
    ? ` AND id IN (
        SELECT po.id FROM ${poSource} po
        WHERE po.orgId = ?
          AND (po.id IN (SELECT productionOrderId FROM ${jcSource} WHERE orgId = ? AND departmentCode = ?)
               OR (po.companySOId IS NOT NULL AND po.companySOId IN (
                    SELECT po2.companySOId FROM ${poSource} po2
                    JOIN ${jcSource} jc2 ON jc2.productionOrderId = po2.id
                    WHERE jc2.orgId = ? AND jc2.departmentCode = ? AND po2.companySOId IS NOT NULL))
               OR (po.companyCOId IS NOT NULL AND po.companyCOId IN (
                    SELECT po3.companyCOId FROM ${poSource} po3
                    JOIN ${jcSource} jc3 ON jc3.productionOrderId = po3.id
                    WHERE jc3.orgId = ? AND jc3.departmentCode = ? AND po3.companyCOId IS NOT NULL))))`
    : '';
  const deptScopeBinds: string[] = deptFilter
    ? [orgId, orgId, deptFilter, orgId, deptFilter, orgId, deptFilter]
    : [];
  // Sticker-print scope (2026-06-24): match an order by ANY of its identifying
  // ids/numbers, so the FE can pass internal po ids (visible rows) AND human
  // SO/CO numbers (ticked rows) in one list. Each token list binds once per OR
  // arm. The camelCase identifiers are rewritten to snake_case by the SQL
  // adapter, same as companySOId / companyCOId in the dept-scope clause above.
  const hasScope = Array.isArray(scopeTokens) && scopeTokens.length > 0;
  const scopePh = hasScope ? scopeTokens!.map(() => "?").join(",") : "";
  const scopeWhere = hasScope
    ? ` AND (id IN (${scopePh}) OR poNo IN (${scopePh}) OR companySOId IN (${scopePh}) OR salesOrderId IN (${scopePh}) OR companyCOId IN (${scopePh}) OR consignmentOrderId IN (${scopePh}))`
    : "";
  const scopeBinds: string[] = hasScope
    ? [
        ...(scopeTokens as string[]), ...(scopeTokens as string[]), ...(scopeTokens as string[]),
        ...(scopeTokens as string[]), ...(scopeTokens as string[]), ...(scopeTokens as string[]),
      ]
    : [];
  const poSql = hasFilter
    ? `SELECT * FROM ${poSource} WHERE orgId = ? AND status IN (${placeholders})${excludeCompletedWhere}${deptScopeWhere}${dueWhere}${catWhere}${scopeWhere} ORDER BY created_at DESC, id DESC`
    : `SELECT * FROM ${poSource} WHERE orgId = ?${excludeCompletedWhere}${deptScopeWhere}${dueWhere}${catWhere}${scopeWhere} ORDER BY created_at DESC, id DESC`;
  const poStmt = hasFilter
    ? db.prepare(poSql).bind(orgId, ...(statuses as string[]), ...deptScopeBinds, ...dueBindings, ...catBindings, ...scopeBinds)
    : db.prepare(poSql).bind(orgId, ...deptScopeBinds, ...dueBindings, ...catBindings, ...scopeBinds);

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
  // Performance note: deptFilter narrows the PO set (only POs that have at
  // least one JC of this dept, plus cross-SO/CO siblings) but the JC
  // SELECT itself stays un-narrowed by departmentCode. Returning all 8
  // depts of JCs per matched PO is required for the dept page's upstream
  // cells: the frontend picker (production/index.tsx L1914) does a strict
  // wipKey match against same-PO JCs of OTHER depts to populate columns
  // like Fab Sew / Foam / Framing / Webbing on the Upholstery tab. The
  // 2026-05-11 attempt to add `AND departmentCode = ?` here (commit
  // f5657f5) blanked every non-active upstream cell on every dept page
  // because the picker had nothing to match against. The frontend's
  // ordersByGroup fallback only fires for FAB_CUT lookups, NOT for non-
  // FC ↔ non-FC pairs, so the outer narrow could not be salvaged by FE.
  // Cross-PO sibling subquery still widens the PO set within a SO group
  // so the merged FAB_CUT JC + sibling rows are returned together. CO-
  // origin POs use companyCOId.
  // Smart wipKey-aware narrow (2026-05-11 F2): the previous "PO-set narrow
  // only, JC fan-out full" path returned ~14 JCs/PO × hundreds of POs on
  // wide date ranges (~8 MB / 5s on /production/upholstery profile). The
  // frontend picker (production/index.tsx L1914) only needs:
  //   - the active dept's JCs (current row in the DataGrid), AND
  //   - JCs whose wipKey matches an active-dept JC's wipKey on that SAME PO
  //     (the upstream / downstream cells in the row's wipKey chain), AND
  //   - FAB_CUT JCs unconditionally (Option C merged FC has a different
  //     wipKey schema that won't match downstream per-piece wipKeys).
  //
  // Plus the sofa PACKING merge case: when the active-dept JC has wipKey
  // 'FG' on a PO, every JC on that PO is needed (the upstream component
  // branches don't share the FG wipKey but their dates feed the merge-row
  // display). Mirrors the comment in fetchPaginatedPOs L1338 — same rule,
  // single-query implementation.
  //
  // Result: ~8 MB → ~1.5 MB for wide ranges; daily-slice payloads
  // unchanged. The `jc` alias on the outer table enables the EXISTS
  // correlations that filter at row level rather than table level.
  // FAB_CUT page exception (fix 2026-05-18 — regression from d8ec903
  // "restore slim non-active-dept JC shape + wipKey narrow", 2026-05-12):
  // the Option-C merged FAB_CUT JC has a wipKey schema
  // (`{poId|companySOId}::baseModel::fabric::FAB_CUT`) that NEVER matches
  // the per-piece downstream wipKeys. The row-level wipKey narrow below
  // therefore strips every FAB_SEW / FOAM / … JC from the Fab Cut sheet
  // payload, so the sheet's "Fab Sew" (and other prev/next-dept) date
  // columns render "—" on every row. On the Fab Cut page we keep ONLY the
  // PO-set membership filter and return all departments' JCs for the
  // FC-related PO set — restores the pre-d8ec903 behaviour for THIS page
  // only; every other dept page keeps the slim wipKey narrow + payload win.
  const skipRowNarrow = deptFilter === "FAB_CUT";
  const jcWhereDept = deptFilter
    ? ` jc WHERE jc.orgId = ? AND jc.productionOrderId IN (
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
        )` +
      (skipRowNarrow
        ? ""
        : `
        AND (
          jc.departmentCode = ?
          OR jc.departmentCode = 'FAB_CUT'
          OR (jc.wipKey IS NOT NULL AND EXISTS (
                SELECT 1 FROM ${jcSource} jcm
                WHERE jcm.productionOrderId = jc.productionOrderId
                  AND jcm.departmentCode = ?
                  AND jcm.wipKey = jc.wipKey))
          OR EXISTS (
                SELECT 1 FROM ${jcSource} jcfg
                WHERE jcfg.productionOrderId = jc.productionOrderId
                  AND jcfg.departmentCode = ?
                  AND jcfg.wipKey = 'FG')
        )`)
    : "";
  // Positional binds for jcWhereDept, kept in lockstep with the SQL above
  // so the two call sites below can't drift. 8 binds for the PO-set
  // membership filter; +3 deptFilter binds for the row-level wipKey narrow
  // when it's present (every dept except FAB_CUT).
  const jcWhereBinds: string[] = deptFilter
    ? skipRowNarrow
      ? [orgId, orgId, orgId, deptFilter, orgId, deptFilter, orgId, deptFilter]
      : [orgId, orgId, orgId, deptFilter, orgId, deptFilter, orgId, deptFilter, deptFilter, deptFilter, deptFilter]
    : [];

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
  // Perf 2026-05-22 — run the lead-time, BOM and sofa-siblings queries as
  // ONE parallel batch instead of three serial Hyperdrive round-trips.
  const [leadTimeMap, [bomByProductCode, siblingsIdx]] = await Promise.all([
    leadTimeP,
    minimal
      ? Promise.all([
          fetchBomWipComponentsByCode(db),
          fetchSofaSiblingsByGroupKey(db, orgId),
        ])
      : Promise.resolve([null, null] as [null, null]),
  ]);
  const siblingsByGroupKey = siblingsIdx?.byGroupKey ?? null;
  const baseModelByProductCode = siblingsIdx?.baseModelByProductCode ?? null;

  if (!includeJobCards) {
    const pos = await poStmt.all<ProductionOrderRow>();
    if (minimal) {
      return (pos.results ?? []).map((p) =>
        rowToMinimalPO(p, [], new Map(), leadTimeMap, bomByProductCode, siblingsByGroupKey, baseModelByProductCode, deptFilter),
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
      // Binds come from jcWhereBinds (8 for FAB_CUT, 11 for every other
      // dept) so the SQL and its placeholders can't drift — see the
      // jcWhereDept / jcWhereBinds construction above.
      const jcStmt = db
        .prepare(`SELECT * FROM ${jcSource}${jcWhereDept}`)
        .bind(...jcWhereBinds);
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
        rowToMinimalPO(p, jcRows, piecesDoneByJc, leadTimeMap, bomByProductCode, siblingsByGroupKey, baseModelByProductCode, deptFilter),
      );
    }
    if (hasFilter || hasScope) {
      // Status-filter / sticker-scope path: run POs first, then narrow JCs to
      // only the matching POs' productionOrderId set. Avoids a full ~9k-row scan
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
        rowToMinimalPO(p, jcs, piecesDoneByJc, leadTimeMap, bomByProductCode, siblingsByGroupKey, baseModelByProductCode, deptFilter),
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
      rowToMinimalPO(p, jcRows, piecesDoneByJc, leadTimeMap, bomByProductCode, siblingsByGroupKey, baseModelByProductCode, deptFilter),
    );
  }

  if (deptFilter) {
    // Binds from jcWhereBinds (8 for FAB_CUT, 11 otherwise) — see the
    // jcWhereDept / jcWhereBinds construction above.
    const jcStmt = db
      .prepare(`SELECT * FROM ${jcSource}${jcWhereDept}`)
      .bind(...jcWhereBinds);
    const [pos, jcs, pics] = await Promise.all([
      poStmt.all<ProductionOrderRow>(),
      jcStmt.all<JobCardRow>(),
      db
        .prepare("SELECT * FROM piece_pics WHERE orgId = ?")
        .bind(orgId)
        .all<PiecePicRow>(),
    ]);
    // Tier B B1 (2026-05-21) — batched O(N+M).
    return rowsToPOsBatch(
      pos.results ?? [],
      jcs.results ?? [],
      pics.results ?? [],
      leadTimeMap,
    );
  }
  if (hasFilter || hasScope) {
    // Status-filter / sticker-scope path (full payload): same narrow-by-PO-id
    // trick as the minimal branch. piece_pics stays a full fetch for now.
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
    // Tier B B1 (2026-05-21) — batched O(N+M).
    return rowsToPOsBatch(poRows, jcs, pics, leadTimeMap);
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
  // Tier B B1 (2026-05-21) — batched O(N+M).
  return rowsToPOsBatch(
    pos.results ?? [],
    jcs.results ?? [],
    pics.results ?? [],
    leadTimeMap,
  );
}

// Paginated variant of fetchFilteredPOs. Returns the page's POs + the total
// filtered count in one round-trip group. Uses SQL LIMIT/OFFSET on the PO
// table and then fetches job_cards/piece_pics for ONLY the page's PO IDs
// (not the whole table), which is the big win when the list is paginated.
export async function fetchPaginatedPOs(
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
  catFilter: string | null = null,
): Promise<{ data: ProductionOrderOut[] | MinimalPOOut[]; total: number }> {
  const hasFilter = Array.isArray(statuses) && statuses.length > 0;
  const statusPlaceholders = hasFilter
    ? statuses.map(() => "?").join(",")
    : "";
  const offset = (page - 1) * limit;

  // includeArchive UNION: route BOTH the po and jc sources through the
  // self-healing helper (introspects + brings the archive into column parity,
  // emits an explicit ordered column list — see src/api/lib/archive-union.ts).
  // Falls back to the legacy SELECT * literal only if introspection fails.
  const poSource = includeArchive
    ? (await archiveUnionSource(db, "production_orders", "production_orders_archive")) ??
      `(SELECT *, '' AS "archivedAt" FROM production_orders
        UNION ALL
        SELECT * FROM production_orders_archive)`
    : "production_orders";
  const jcSource = includeArchive
    ? (await archiveUnionSource(db, "job_cards", "job_cards_archive")) ??
      `(SELECT *, '' AS "archivedAt" FROM job_cards
        UNION ALL
        SELECT * FROM job_cards_archive)`
    : "job_cards";

  // dueFrom / dueTo: dept-aware date window — same logic as
  // fetchFilteredPOs. Overview filters the PO's SO "Our Expected DD"
  // (sales_orders.hookkaExpectedDD — the column shown in the Overview cell);
  // dept page filters that dept's JC.dueDate via EXISTS subquery. Undated rows
  // (no salesOrderId / NULL or '' hookkaExpectedDD; or NULL JC dueDate) are
  // always kept.
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
      // Overview mode: window the PO's SO "Our Expected DD". See the matching
      // block in fetchFilteredPOs for the full rationale — correlated lookup of
      // sales_orders.hookkaExpectedDD, NULLIF('') folds empty into NULL, and the
      // unqualified outer `salesOrderId` keeps the clause valid against both
      // `production_orders` and the unaliased hot+archive UNION. CO-origin POs
      // (NULL salesOrderId) and undated SOs are always kept.
      const ddExpr =
        "NULLIF((SELECT so.hookkaExpectedDD FROM sales_orders so WHERE so.id = salesOrderId), '')";
      if (dueFrom) {
        dueClauses.push(
          `(salesOrderId IS NULL OR ${ddExpr} IS NULL OR ${ddExpr} >= ?)`,
        );
        dueBindings.push(dueFrom);
      }
      if (dueTo) {
        dueClauses.push(
          `(salesOrderId IS NULL OR ${ddExpr} IS NULL OR ${ddExpr} <= ?)`,
        );
        dueBindings.push(dueTo);
      }
    }
  }
  const dueWhere = dueClauses.length > 0 ? ` AND ${dueClauses.join(" AND ")}` : "";
  const catWhere = catFilter ? ' AND itemCategory = ?' : '';
  const catBindings: string[] = catFilter ? [catFilter] : [];

  const countSql = hasFilter
    ? `SELECT COUNT(*) AS n FROM ${poSource} WHERE orgId = ? AND status IN (${statusPlaceholders})${dueWhere}${catWhere}`
    : `SELECT COUNT(*) AS n FROM ${poSource} WHERE orgId = ?${dueWhere}${catWhere}`;
  const pageSql = hasFilter
    ? `SELECT * FROM ${poSource} WHERE orgId = ? AND status IN (${statusPlaceholders})${dueWhere}${catWhere} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
    : `SELECT * FROM ${poSource} WHERE orgId = ?${dueWhere}${catWhere} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;

  const countStmt = hasFilter
    ? db.prepare(countSql).bind(orgId, ...(statuses as string[]), ...dueBindings, ...catBindings)
    : db.prepare(countSql).bind(orgId, ...dueBindings, ...catBindings);
  const pageStmt = hasFilter
    ? db.prepare(pageSql).bind(orgId, ...(statuses as string[]), ...dueBindings, ...catBindings, limit, offset)
    : db.prepare(pageSql).bind(orgId, ...dueBindings, ...catBindings, limit, offset);

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
          rowToMinimalPO(p, [], new Map(), leadTimeMap, bomByProductCode, siblingsByGroupKey, baseModelByProductCode, deptFilter),
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
        rowToMinimalPO(p, jcs, new Map(), leadTimeMap, bomByProductCode, siblingsByGroupKey, baseModelByProductCode, deptFilter),
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
    // Tier B B1 (2026-05-21) — batched O(N+M).
    data: rowsToPOsBatch(posRows, jcs, pics, leadTimeMap),
    total,
  };
}

export async function fetchPO(
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

// Cache-bypassing single-PO read in the SAME minimal shape the list endpoint
// returns (rowToMinimalPO). Reads the ONE production order + its job_cards
// DIRECTLY from the DB — no KV, no production_orders_list_snapshot, no
// serve-stale path — so a freshly-written PIC / completion can be shown
// deterministically right after the write (the list's serve-stale snapshot can
// hand back the pre-write row for the ~1-3 min rebuild window, which is the
// 8-times-patched "flicker"). Mirrors the minimal branch of fetchFilteredPOs
// (leadTime + BOM + sofa-sibling preloads → rowToMinimalPO + fetchPiecesDoneByJc),
// scoped to this single PO. deptFilter is threaded through so non-active-dept
// JCs render in the SAME slim shape the dept tab's list payload uses.
export async function fetchFreshMinimalPO(
  db: D1Database,
  orgId: string,
  id: string,
  deptFilter: string | null,
): Promise<MinimalPOOut | null> {
  const po = await db
    .prepare("SELECT * FROM production_orders WHERE orgId = ? AND id = ?")
    .bind(orgId, id)
    .first<ProductionOrderRow>();
  if (!po) return null;
  // All JCs for this one PO. A single PO has at most a few dozen JCs, so the
  // list's dept-narrow EXISTS gymnastics (a payload-size optimization for the
  // ~9k-row whole-list scan) is unnecessary here — load them all and let
  // rowToMinimalPO + the deptFilter slim-shape handle presentation. This keeps
  // the prev/next-dept date columns populated exactly like the list path.
  const jcs = await db
    .prepare("SELECT * FROM job_cards WHERE orgId = ? AND productionOrderId = ?")
    .bind(orgId, id)
    .all<JobCardRow>();
  const jcRows = jcs.results ?? [];
  // Same three preloads the minimal list path runs, fired in parallel. BOM +
  // sofa-siblings drive FAB_CUT fabricUsageMeters / cross-PO sums; leadTime
  // drives expectedDueDate. Fail-soft to null (→ rowToMinimalPO treats as
  // "no signal"), identical to the list's .catch(() => null) on leadTime.
  const [leadTimeMap, bomByProductCode, siblingsIdx] = await Promise.all([
    loadLeadTimes(db).catch(() => null),
    fetchBomWipComponentsByCode(db).catch(() => null),
    fetchSofaSiblingsByGroupKey(db, orgId).catch(() => null),
  ]);
  const siblingsByGroupKey = siblingsIdx?.byGroupKey ?? null;
  const baseModelByProductCode = siblingsIdx?.baseModelByProductCode ?? null;
  const piecesDoneByJc = await fetchPiecesDoneByJc(
    db,
    orgId,
    jcRows.map((j) => j.id),
  );
  return rowToMinimalPO(
    po,
    jcRows,
    piecesDoneByJc,
    leadTimeMap,
    bomByProductCode,
    siblingsByGroupKey,
    baseModelByProductCode,
    deptFilter,
  );
}

// Ensure piece_pics rows exist for a job card. Creates wipQty (or 1) slots on
// demand and returns the ordered array. Mirrors the in-memory ensurePiecePics
// semantics, but persists to D1 so subsequent scans find the same slots.
// Runtime self-apply for the per-PIECE rack column (mig 0192). A migration file
// alone is INERT on prod (deploys do NOT replay migrations-postgres/*.sql) — the
// column reaches prod only via this ADD COLUMN IF NOT EXISTS, awaited inside
// ensurePiecePicsForJc before any piece_pics row is created/read. Memoised so
// the DDL runs at most once per worker isolate.
export let piecePicsRackingColumnEnsured: Promise<void> | null = null;
export function ensurePiecePicsRackingColumn(db: D1Database): Promise<void> {
  if (piecePicsRackingColumnEnsured) return piecePicsRackingColumnEnsured;
  piecePicsRackingColumnEnsured = (async () => {
    try {
      await db
        .prepare(
          "ALTER TABLE piece_pics ADD COLUMN IF NOT EXISTS racking_number TEXT",
        )
        .run();
    } catch {
      // ignore — column may already exist or DDL transiently rejected
    }
  })();
  return piecePicsRackingColumnEnsured;
}

// co_status_changes — the Consignment Order status audit log (migration 0104).
// Migrations are INERT on deploy, and unlike so_status_changes (seeded in the
// initial schema) this table has NO runtime self-apply — so on prod it simply
// never existed. Every CO cascade below writes to it inside a db.batch()
// alongside the CO status UPDATE, so a missing table failed the WHOLE batch and
// the swallowed error left COs stuck (never auto-advancing to READY_TO_SHIP),
// and GET /api/consignment-orders/status-changes 500'd with
// relation "co_status_changes" does not exist (found on prod 2026-08-01).
// Create it lazily (idempotent) before any read or write touches it. Snake_case
// columns matching the migration + the cascade INSERTs; org_id defaults so the
// writers (which don't set it) still satisfy NOT NULL. FK omitted so the DDL
// can never fail on a schema quirk — the audit log doesn't need it.
export let coStatusChangesTableEnsured: Promise<void> | null = null;
export function ensureCoStatusChangesTable(db: D1Database): Promise<void> {
  if (coStatusChangesTableEnsured) return coStatusChangesTableEnsured;
  coStatusChangesTableEnsured = (async () => {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS co_status_changes (
             id           TEXT PRIMARY KEY,
             co_id        TEXT,
             from_status  TEXT,
             to_status    TEXT,
             changed_by   TEXT,
             timestamp    TEXT NOT NULL,
             notes        TEXT,
             auto_actions TEXT,
             org_id       TEXT NOT NULL DEFAULT 'hookka'
           )`,
        )
        .run();
      await db
        .prepare(
          "CREATE INDEX IF NOT EXISTS idx_co_status_changes_co_id ON co_status_changes(co_id)",
        )
        .run();
      await db
        .prepare(
          "CREATE INDEX IF NOT EXISTS idx_co_status_changes_timestamp ON co_status_changes(timestamp)",
        )
        .run();
    } catch {
      // ignore — table may already exist or DDL transiently rejected; callers
      // read-guard so a still-missing table degrades to an empty list, never 500.
    }
  })();
  return coStatusChangesTableEnsured;
}

export async function ensurePiecePicsForJc(
  db: D1Database,
  jc: JobCardRow,
): Promise<PiecePicRow[]> {
  await ensurePiecePicsRackingColumn(db);
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

// Month-based SOH counter.
export async function nextSOHNumber(db: D1Database): Promise<string> {
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
  options: { orgId?: string; source?: string } = {},
): Promise<void> {
  // BUG-2026-04-27-005: a PATCH that re-sends the same status (e.g. duplicate
  // form submit, refresh + retry, two operators racing the same JC) used to
  // fire the cascade twice — once per PATCH — doubling every consume and
  // every producer-add. Short-circuit when the status didn't actually change.
  if (prevStatus !== null && prevStatus === newStatus) return;

  // BUG-2026-05-12: structural fix for the FOAM 326 inflation. BUG-005 only
  // catches duplicates within ONE PATCH request — it does NOT catch the same
  // (jcId, fromStatus, toStatus) replayed from a backfill script, a retry
  // handler, or a cross-session re-fire. Every prior WIP inflation traced
  // back to one of those replay paths. Idempotency claim ticket: try to
  // INSERT a row into wip_cascade_log under a UNIQUE (orgId, jcId, from,
  // to) index. If we win the race (changes > 0) the cascade proceeds; if
  // somebody already claimed this exact transition, we short-circuit and
  // skip the side effects. Atomic, concurrent-safe, zero race window.
  //
  // Callers that pass options.orgId opt into the guard. Callers without
  // orgId (legacy code paths we haven't audited yet, plus the unit tests)
  // skip the guard and behave like before. Once every caller is updated
  // we can flip this to require orgId.
  if (options.orgId) {
    try {
      const claimResult = await db
        .prepare(
          `INSERT INTO wip_cascade_log (org_id, job_card_id, from_status, to_status, source)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          options.orgId,
          jcRow.id,
          prevStatus,
          newStatus,
          options.source || "PATCH",
        )
        .run();
      const changes = (claimResult as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
      if (changes === 0) {
        // Already claimed by an earlier call for this exact transition.
        // Side effects already applied — skip to keep wip_items balanced.
        return;
      }
    } catch (err) {
      // If the claim insert itself fails (DB error, table missing because
      // migration hasn't landed yet), log and proceed without guard rather
      // than blocking the primary write. The cascade is still gated by
      // BUG-005 for same-request duplicates.
      console.warn("[applyWipInventoryChange] cascade-log claim failed", {
        jcId: jcRow.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
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
      // HB-only PO: drop DIVAN UPH JCs from the predicate so the rollback
      // mirror stays in step with the forward gate above.
      const poUphJcsAll = allJcRows.filter(
        (j) =>
          j.productionOrderId === poRow.id &&
          (j.departmentCode || "").toUpperCase() === "UPHOLSTERY",
      );
      const poUphJcs = filterJcsForCompletionGate(poRow, poUphJcsAll);
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
      // HB-only PO: ignore DIVAN UPH JCs in the "all UPH done?" gate so
      // legacy stranded DIVAN rows don't keep the WIP→FG transition from
      // firing. The DIVAN wip_items rows themselves stay where they are
      // (we don't subtract them since their UPH JCs never completed).
      const poUphJcsAll = allJcRows.filter(
        (j) =>
          j.productionOrderId === poRow.id &&
          (j.departmentCode || "").toUpperCase() === "UPHOLSTERY",
      );
      const poUphJcs = filterJcsForCompletionGate(poRow, poUphJcsAll);
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
            SET stockQty = GREATEST(0, stockQty - ?),
                status = CASE
                  WHEN GREATEST(0, stockQty - ?) = 0 THEN 'IN_PRODUCTION'
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
export async function cascadeUpholsteryToSO(
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

  // HB-only sibling POs: drop their DIVAN UPHOLSTERY JCs so the readiness
  // check doesn't wait for divan pieces the customer never ordered. See
  // filterJcsForCompletionGate above for full context.
  const poById = new Map(siblingPOs.map((p) => [p.id, p]));
  const filteredUphFor = (poId: string): JobCardRow[] => {
    const mine = uphJcs.filter((j) => j.productionOrderId === poId);
    return filterJcsForCompletionGate(poById.get(poId), mine);
  };

  const everyUphDone = siblingPOs.every((p) => {
    const mine = filteredUphFor(p.id);
    if (mine.length === 0) return true;
    return mine.every((j) => j.status === "COMPLETED" || j.status === "TRANSFERRED");
  });

  const now = new Date().toISOString();
  if (everyUphDone) {
    for (const p of siblingPOs) {
      const mine = filteredUphFor(p.id);
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
export async function cascadeUpholsteryToCO(
  db: D1Database,
  poId: string,
): Promise<void> {
  // The status UPDATE below is batched with an INSERT into co_status_changes;
  // ensure that table exists (idempotent, memoized) or the whole batch fails
  // and the CO never advances. See ensureCoStatusChangesTable.
  await ensureCoStatusChangesTable(db);
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

  // HB-only sibling POs: drop their DIVAN UPHOLSTERY JCs (see SO twin above
  // for full rationale).
  const poById = new Map(siblingPOs.map((p) => [p.id, p]));
  const filteredUphFor = (poId: string): JobCardRow[] => {
    const mine = uphJcs.filter((j) => j.productionOrderId === poId);
    return filterJcsForCompletionGate(poById.get(poId), mine);
  };

  const everyUphDone = siblingPOs.every((p) => {
    const mine = filteredUphFor(p.id);
    if (mine.length === 0) return true;
    return mine.every((j) => j.status === "COMPLETED" || j.status === "TRANSFERRED");
  });

  const now = new Date().toISOString();
  if (everyUphDone) {
    for (const p of siblingPOs) {
      const mine = filteredUphFor(p.id);
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
      const mine = filteredUphFor(p.id);
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
export async function cascadeUpholsteryRollbackToSO(
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
    .prepare(
      "SELECT id, itemCategory, specialOrder FROM production_orders WHERE salesOrderId = ?",
    )
    .bind(so.id)
    .all<{ id: string; itemCategory: string | null; specialOrder: string | null }>();
  const siblingPOs = siblings.results ?? [];
  if (siblingPOs.length === 0) return;

  const sibIds = siblingPOs.map((p) => p.id);
  const placeholders = sibIds.map(() => "?").join(",");
  const uphRes = await db
    .prepare(
      `SELECT productionOrderId, status, wipType FROM job_cards
        WHERE departmentCode = 'UPHOLSTERY' AND productionOrderId IN (${placeholders})`,
    )
    .bind(...sibIds)
    .all<{ productionOrderId: string; status: string; wipType: string | null }>();
  const uphJcs = uphRes.results ?? [];

  // Mirror the forward path: every sibling PO must have all its UPH JCs in
  // COMPLETED/TRANSFERRED for the SO to remain READY_TO_SHIP. POs with no
  // UPH JCs at all are treated as vacuous-true (matches the forward path).
  // HB-only sibling POs: drop their DIVAN UPH JCs so the rollback decision
  // stays in sync with the forward cascade (which also ignores them).
  const poById = new Map(siblingPOs.map((p) => [p.id, p]));
  const everyUphDone = siblingPOs.every((p) => {
    const minePre = uphJcs.filter((j) => j.productionOrderId === p.id);
    const mine = filterJcsForCompletionGate(poById.get(p.id), minePre);
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
export async function cascadePoCompletionToSO(
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
export async function cascadePoCompletionToCO(
  db: D1Database,
  consignmentOrderId: string | null,
): Promise<void> {
  if (!consignmentOrderId) return;
  await ensureCoStatusChangesTable(db);
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
  await ensureCoStatusChangesTable(db);
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
  await ensureCoStatusChangesTable(db);
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
      `SELECT status, progress, completedDate, itemCategory, specialOrder
         FROM production_orders WHERE id = ?`,
    )
    .bind(poId)
    .first<{
      status: string;
      progress: number;
      completedDate: string | null;
      itemCategory: string | null;
      specialOrder: string | null;
    }>();
  if (!poRow) return noop;

  // Admin states are sticky — exit before touching anything.
  if (poRow.status === "ON_HOLD" || poRow.status === "CANCELLED") return noop;

  const sibs = await db
    .prepare(
      `SELECT id, status, completedDate, wipQty, sequence, wipType
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
      wipType: string | null;
    }>();
  // HB-only PO: drop DIVAN job cards from the completion gate so the HB
  // pieces alone can flip the PO to COMPLETED. Leaves the rows in the DB
  // untouched (per forward-only fix policy) — they just don't block status.
  const allJcs = filterJcsForCompletionGate(poRow, sibs.results ?? []);

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
export async function applyPoUpdate(
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
      }
      // BUG-2026-05-12: previously this branch auto-cleared completedDate
      // whenever a JC transitioned out of DONE (e.g. status flipped back to
      // WAITING for re-filtering on the production page). Operator domain
      // model treats status as a FILTER label and completedDate as the
      // user-owned source of truth — the system must never silently wipe a
      // date the user explicitly set. Removed the auto-clear entirely. To
      // actually drop a completion date, callers must send
      // `body.completedDate = ""` (or null) explicitly; the block below
      // honours that. Verified in prod via job_card_events audit: 153 COMPLETED_DATE_CLEARED
      // events in 36h, all triggered by COMPLETED -> WAITING status flips,
      // none of which the operator intended to wipe the date.
    }

    // Capture whether this card was completed BEFORE the operator's edit, so an
    // explicit "remove completion date" can also wipe the scan stamps below.
    const jcWasCompleted = !!updated.completedDate;
    if (body.completedDate !== undefined) {
      // Guard (owner data-tally audit 2026-07-11): never store a FUTURE
      // completion date — work can't be completed in the future, and a stray
      // future date dates the RM_ISSUE / FG_COMPLETED cost_ledger rows into
      // future months (the 148.7m-BF-in-2026-09 bug). Cap at today; an empty
      // string still clears the date as before.
      const cd = body.completedDate || null;
      updated.completedDate = cd && String(cd).slice(0, 10) > today ? today : cd;
    }

    // Snapshot the PICs BEFORE the body's change is applied, so a PIC swap can
    // be propagated to the piece_pics scan stamps below (the worker "completed
    // products" view credits a worker via piece_pics, not the JC-level pic).
    const oldPic1Id = updated.pic1Id ?? null;
    const oldPic2Id = updated.pic2Id ?? null;

    if (body.pic1Id !== undefined) {
      if (body.pic1Id) {
        updated.pic1Id = body.pic1Id;
        const w = await db
          .prepare("SELECT name FROM workers WHERE id = ?")
          .bind(body.pic1Id)
          .first<{ name: string }>();
        updated.pic1Name = w?.name ?? "";
      } else {
        // CLEAR: coerce to null, NOT "". Empty string is not nullish, so the
        // `updated.pic1Id ?? null` bind below kept "" — and piecesDone counts
        // `piece_pics WHERE pic1Id IS NOT NULL`, so a "" stamp still read as
        // "present" and the cleared PIC popped back. Store a real NULL.
        updated.pic1Id = null;
        updated.pic1Name = null;
      }
    }
    if (body.pic2Id !== undefined) {
      if (body.pic2Id) {
        updated.pic2Id = body.pic2Id;
        const w = await db
          .prepare("SELECT name FROM workers WHERE id = ?")
          .bind(body.pic2Id)
          .first<{ name: string }>();
        updated.pic2Name = w?.name ?? "";
      } else {
        // CLEAR → real NULL (see the pic1 note above).
        updated.pic2Id = null;
        updated.pic2Name = null;
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
        // 2026-05-25: explicit `updated_at = NOW()` on every JC mutation
        // so the Phase 6 snapshot cache's MAX(job_cards.updated_at)
        // freshness probe sees the bump and invalidates the cached
        // /api/production-orders payload. Without this, batch Apply PIC
        // (and any other PATCH) wrote to job_cards but the next list
        // fetch served stale rows from production_orders_list_snapshot,
        // silently overwriting the FE's optimistic update with the old
        // pic1Id=null. Same fix applied to the production_orders UPDATE
        // path below for symmetry.
        `UPDATE job_cards SET
           status = ?, completedDate = ?, pic1Id = ?, pic1Name = ?,
           pic2Id = ?, pic2Name = ?, actualMinutes = ?, dueDate = ?,
           rackingNumber = ?, overdue = ?, distributedAt = ?,
           updated_at = NOW()
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

    // Mirror the rack assignment through the shared writer so the Warehouse
    // rack_items occupancy is populated — the office dropdown now shows the
    // piece under its rack in the Warehouse grid, exactly like the /p/ + worker
    // scans (owner 2026-06-25 (B): set Rack 9 → not in Warehouse). The inline
    // UPDATE above already set job_cards.rackingNumber; applyPackingRack
    // re-affirms it (idempotent), mirrors it onto the PO, and writes/moves/
    // clears the one rack_items row. NOT_PACKING cards are a no-op inside the
    // helper. Best-effort — never block the JC mutation on an occupancy hiccup.
    if (body.rackingNumber !== undefined) {
      try {
        await applyPackingRack(db, body.jobCardId, body.rackingNumber);
      } catch (e) {
        console.warn(
          "[production-orders PATCH] rack occupancy mirror skipped",
          e,
        );
      }
    }

    // BUG-2026-06-08 (scan ↔ production sync): when the operator REMOVES the
    // completion on the production page (clears completedDate) on a card that
    // was completed, ALSO clear the underlying piece_pics scan stamps. The
    // card's completion % is re-derived from those stamps, so without this the
    // cleared card "jumps back to complete" on the next refetch (and the PIC,
    // aggregated from the same stamps, reappears). This makes the production-
    // page "undo" reach the scan layer the worker filled. Targeted: only fires
    // on an explicit date-removal of a previously-completed card, so valid
    // IN_PROGRESS partial scans are untouched.
    if (
      body.completedDate !== undefined &&
      !body.completedDate &&
      jcWasCompleted
    ) {
      await db
        .prepare(
          `UPDATE piece_pics SET pic1Id = NULL, pic1Name = NULL, pic2Id = NULL,
             pic2Name = NULL, completedAt = NULL, lastScanAt = NULL,
             boundStickerKey = NULL WHERE jobCardId = ?`,
        )
        .bind(updated.id)
        .run();
    }

    // BUG-2026-06-08-008 (scan ↔ production sync, the SET mirror of the CLEAR
    // branch above): when the operator SETS a completion on the production page
    // — the card transitions from not-completed to completed and a PIC is
    // recorded — ALSO stamp the underlying piece_pics so the worker phone sees
    // the card as done. The phone's "already done" pre-check AND the backend
    // scan-complete no-op both key off piece_pics (pic1Id IS NOT NULL), NOT the
    // card status, so without this a dashboard-completed card still lets a
    // worker re-scan + re-Mark-Complete (re-dating it / splitting the credit).
    // We fill ONLY un-scanned pieces with the card's PIC and leave real worker
    // stamps intact, so efficiency attribution is unchanged (it already unions
    // the JC-level PIC). Uses `updated.completedDate` (not body.completedDate)
    // so a status→COMPLETED that auto-set the date above also triggers it.
    if (updated.completedDate && !jcWasCompleted && updated.pic1Id) {
      const existingSlots = await db
        .prepare("SELECT pieceNo, pic1Id FROM piece_pics WHERE jobCardId = ?")
        .bind(updated.id)
        .all<{ pieceNo: number; pic1Id: string | null }>();
      const plan = planCompletionPieceStamps(
        updated.wipQty,
        existingSlots.results ?? [],
      );
      const pieceStmts: D1PreparedStatement[] = [];
      for (const pieceNo of plan.insert) {
        pieceStmts.push(
          db
            .prepare(
              `INSERT INTO piece_pics
                 (jobCardId, pieceNo, pic1Id, pic1Name, pic2Id, pic2Name,
                  completedAt, lastScanAt, boundStickerKey)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
            )
            .bind(
              updated.id,
              pieceNo,
              updated.pic1Id ?? null,
              updated.pic1Name ?? "",
              updated.pic2Id ?? null,
              updated.pic2Name ?? "",
              updated.completedDate,
              updated.completedDate,
            ),
        );
      }
      for (const pieceNo of plan.fill) {
        pieceStmts.push(
          db
            .prepare(
              `UPDATE piece_pics SET pic1Id = ?, pic1Name = ?, pic2Id = ?,
                 pic2Name = ?, completedAt = ?, lastScanAt = ?
               WHERE jobCardId = ? AND pieceNo = ? AND pic1Id IS NULL`,
            )
            .bind(
              updated.pic1Id ?? null,
              updated.pic1Name ?? "",
              updated.pic2Id ?? null,
              updated.pic2Name ?? "",
              updated.completedDate,
              updated.completedDate,
              updated.id,
              pieceNo,
            ),
        );
      }
      if (pieceStmts.length > 0) await db.batch(pieceStmts);
    }

    // BUG (PIC change ↔ scan sync): when the PIC is CHANGED — not the completion
    // — on a card that STAYS completed, the JC-level pic1Id/pic2Id moved but the
    // piece_pics scan stamps still carry the OLD pic. The worker "completed
    // products" view credits a worker via piece_pics, so the old PIC keeps
    // showing the card (e.g. a PIC removed on the production page still appears
    // as having completed it). Propagate the swap: for this card's pieces stamped
    // with the OLD pic, move them to the NEW pic (or clear when the new pic is
    // null). Pieces a DIFFERENT real scanner filled are left alone (WHERE
    // picXId = old). The SET branch above handles a fresh complete; the CLEAR
    // branch wipes everything on un-complete; this covers the change-in-between.
    if (
      updated.completedDate &&
      jcWasCompleted &&
      (updated.pic1Id !== oldPic1Id || updated.pic2Id !== oldPic2Id)
    ) {
      const swapStmts: D1PreparedStatement[] = [];
      if (oldPic1Id && updated.pic1Id !== oldPic1Id) {
        swapStmts.push(
          db
            .prepare(
              "UPDATE piece_pics SET pic1Id = ?, pic1Name = ? WHERE jobCardId = ? AND pic1Id = ?",
            )
            .bind(updated.pic1Id ?? null, updated.pic1Name ?? "", updated.id, oldPic1Id),
        );
      }
      if (oldPic2Id && updated.pic2Id !== oldPic2Id) {
        swapStmts.push(
          db
            .prepare(
              "UPDATE piece_pics SET pic2Id = ?, pic2Name = ? WHERE jobCardId = ? AND pic2Id = ?",
            )
            .bind(updated.pic2Id ?? null, updated.pic2Name ?? "", updated.id, oldPic2Id),
        );
      }
      if (swapStmts.length > 0) await db.batch(swapStmts);
    }

    // BUG (PIC-only clear ↔ scan sync): when a PIC is REMOVED (oldPicId set →
    // new is null) on a card that is NOT completed, the swap branch above does
    // NOT fire (it is gated on `updated.completedDate && jcWasCompleted`), so
    // the matching piece_pics stamp survives. piecesDone counts `piece_pics
    // WHERE pic1Id IS NOT NULL`, so the cleared PIC kept counting as present
    // and popped back on the next refetch. Clear the matching stamp
    // UNCONDITIONALLY on removal — this is the complement of the swap branch
    // (which already clears removed PICs while completed, now that the clear
    // coerces to real NULL). Only fires when the swap branch didn't, so the
    // two never double-run on the same removal. Pieces a DIFFERENT real scanner
    // filled are untouched (WHERE picXId = old).
    const swapHandledRemoval = !!updated.completedDate && jcWasCompleted;
    if (!swapHandledRemoval) {
      const clearStmts: D1PreparedStatement[] = [];
      if (oldPic1Id && !updated.pic1Id) {
        clearStmts.push(
          db
            .prepare(
              "UPDATE piece_pics SET pic1Id = NULL, pic1Name = NULL WHERE jobCardId = ? AND pic1Id = ?",
            )
            .bind(updated.id, oldPic1Id),
        );
      }
      if (oldPic2Id && !updated.pic2Id) {
        clearStmts.push(
          db
            .prepare(
              "UPDATE piece_pics SET pic2Id = NULL, pic2Name = NULL WHERE jobCardId = ? AND pic2Id = ?",
            )
            .bind(updated.id, oldPic2Id),
        );
      }
      if (clearStmts.length > 0) await db.batch(clearStmts);
    }

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
          { orgId: getOrgId(c), source: "PATCH" },
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

    // currentDepartment is the production frontier: the EARLIEST department
    // in the chain (DEPT_ORDER) that still has a not-yet-done job card. The
    // old code did a plain `find` of the first IN_PROGRESS/WAITING JC in raw
    // DB order — `SELECT * FROM job_cards` has no ORDER BY, so the row order
    // is arbitrary (rowid/insertion), and the reported dept could jump around
    // and not reflect how far down the chain the order actually is (e.g. a
    // line whose true frontier is WEBBING showing PACKING, or vice versa).
    // Ranking the incomplete JCs by DEPT_ORDER index makes currentDepartment
    // monotonically advance down the chain. Falls back to PACKING when every
    // JC is done (the recompute below flips status to COMPLETED in that case).
    // PO.status / progress / completedDate are recomputed by
    // recomputePoStatusAndProgress() below — no longer derived here.
    const refreshedJcs = allJcRows.map((j) => (j.id === updated.id ? updated : j));
    const deptRank = (code: string | null | undefined): number => {
      const idx = DEPT_ORDER.indexOf(
        (code ?? "") as (typeof DEPT_ORDER)[number],
      );
      return idx >= 0 ? idx : DEPT_ORDER.length; // unknown depts sort last
    };
    const frontier = refreshedJcs
      .filter((j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED")
      .reduce<JobCardRow | null>((earliest, j) => {
        if (!earliest) return j;
        return deptRank(j.departmentCode) < deptRank(earliest.departmentCode)
          ? j
          : earliest;
      }, null);
    updatedCurrentDept = frontier?.departmentCode ?? "PACKING";
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

  // Invalidate every cached GET / read for this org so the operator's own
  // edit is reflected on the very next list fetch. Mirror the scan path: bump
  // the KV version key AND mark the dept-sheet snapshot stale. Bumping the KV
  // version alone left the Layer-2 snapshot serving the pre-edit row for up to
  // ~1-3 min, which the operator saw as their just-removed completion date /
  // PIC flickering back in, then vanishing again once the snapshot finally
  // caught up (BUG-2026-06-09-005). Best-effort: the row is already committed,
  // so a cache hiccup must never 500 the save.
  const orgId = getOrgId(c);
  try {
    await invalidateProductionListCaches(c, orgId);
  } catch (err) {
    console.warn(
      "[applyPoUpdate] cache invalidation failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

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
//   ?dept missing  → Overview rule: the PO's SO "Our Expected DD"
//                    (sales_orders.hookkaExpectedDD) < today AND any
//                    UPHOLSTERY JC still open.  earliest = that DD. A PO with
//                    no DD (empty / CO-origin) is never overdue (2026-06-10 —
//                    was keyed off PO.targetEndDate).
//   ?dept=<code>   → Per-dept rule: that dept's JC dueDate passed AND open.
//                    earliest = MIN(such JC.dueDate).
//
// Skips COMPLETED / CANCELLED POs in both modes (matches the predicate).
//
// Per-piece ship-exclusion (2026-06-12, owner-verified): in BOTH modes a PO is
// also excluded when the piece is already on a dispatched/delivered DO — it
// appears in delivery_order_items joined to a delivery_orders row whose status
// IN ('LOADED','IN_TRANSIT','DELIVERED','INVOICED'). Checked PER PIECE via the
// PO's own delivery linkage, NOT by SO status: a partially invoiced SO can read
// INVOICED at SO level while a specific overdue piece is still in the factory,
// so excluding by SO status would wrongly drop genuinely-overdue pieces.
//
// Count units differ (owner rule): BEDFRAME = overdue PIECES (sold per SKU, so
// each overdue bedframe PO counts 1); SOFA = overdue SETS = distinct SOs with a
// sofa piece overdue (the -01/-02/-03 pieces of one SO = one set).
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
export type OverduePoRow = {
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

export type OverdueBreakdownRow = {
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

// ---------------------------------------------------------------------------
// Phase 2.5-C — KV cache for GET /api/production-orders.
// ---------------------------------------------------------------------------
// The list endpoint joins production_orders + job_cards across an entire org
// and the comment in deploy.yml + observability tags note it routinely takes
// 5-17s on Hyperdrive. With 3-5 operators opening the matrix in a short
// window, that's 30-80s of duplicated DB work. KV wraps each (orgId, query)
// tuple with a 60s TTL.
//
// Invalidation uses a per-org monotonic "version" key — every mutation
// (applyPoUpdate at the end of every PUT/PATCH) bumps the version, which
// changes every subsequent cache key under that prefix. Old cache values
// expire naturally via TTL (no manual delete needed; KV doesn't support
// prefix-delete cheaply anyway).
//
// 60s TTL is generous because:
//   1. The user's OWN mutation bumps the version → next read misses → fresh
//      data within ~50ms. Operator never sees their own write delayed.
//   2. Other operators in the same org see staleness up to 60s. Phase 2.5-D
//      (Supabase Realtime) closes that gap.
//
// 2026-07-22: poListCacheVersion / bumpPoListCacheVersion moved verbatim to
// src/api/lib/po-list-cache.ts (imported at the top of this file) so writers
// outside this module can invalidate too — the SO ON_HOLD / CANCELLED cascade
// rewrites production_orders.status and has to reach these same dept sheets.

export function buildPoListCacheKey(orgId: string, version: string, url: URL): string {
  // Canonicalise query params (sorted) so semantically-identical URLs share
  // a cache key. Drop empty values to be conservative.
  const pairs = Array.from(url.searchParams.entries())
    .filter(([, v]) => v !== "")
    .sort(([a], [b]) => a.localeCompare(b));
  const qs = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `pos:${orgId}:v${version}:${qs}`;
}

// ---------------------------------------------------------------------------
// KV-layer serve-stale for the non-paginated list (2026-07-03, Phase 1 of the
// visibility/perf plan). Measured on prod: a KV HIT serves in ~0.77s but any
// write bumps the org version, and the next poll then pays the snapshot path —
// a ~10MB snapshot row read from Postgres + JSON.parse + JSON.stringify,
// 1.3-1.8s warm and up to ~5.4s on a full recompute. During an active shift
// scans bump the version every 10-20s while the page polls every 8s, so
// operators sat on the slow path ~half the time.
//
// Fix: store the response body under a STABLE key (no version in the key) and
// stamp the org version into KV *metadata*. On version mismatch, serve the
// previous body immediately (X-Cache: STALE) and refresh in the background.
// Freshness semantics are unchanged — the snapshot layer's own
// serve-stale-while-revalidate already hands back the pre-write copy once
// after every write (see the 2026-06-06 mark-stale note above); this just cuts
// what that stale serve costs from 1.3-5.4s to a ~0.1s KV read. The page's 8s
// poll picks up the refreshed body one cycle later exactly as before, and
// in-page cell edits stay protected by the drafts/pending-patch overlay.
// ---------------------------------------------------------------------------
export const PO_LIST_BODY_TTL_S = 300;

export function buildPoListBodyKey(orgId: string, url: URL): string {
  const pairs = Array.from(url.searchParams.entries())
    .filter(([, v]) => v !== "")
    .sort(([a], [b]) => a.localeCompare(b));
  const qs = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `pos:body:${orgId}:${qs}`;
}

// Single-flight guard so a burst of stale serves (several operators polling
// the same sheet) triggers ONE background rebuild, not one per request.
export const inFlightPoListBodyRefreshes = new Set<string>();

export function schedulePoListBodyRefresh(
  c: Context<Env>,
  orgId: string,
  bodyKey: string,
  build: () => Promise<unknown>,
): void {
  const kv = c.env.SESSION_CACHE;
  if (!kv) return;
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try {
    const ctx = c.executionCtx;
    if (ctx?.waitUntil) waitUntil = ctx.waitUntil.bind(ctx);
  } catch {
    waitUntil = undefined;
  }
  if (!waitUntil || inFlightPoListBodyRefreshes.has(bodyKey)) return;
  inFlightPoListBodyRefreshes.add(bodyKey);
  const task = (async () => {
    try {
      const fresh = await build();
      // Re-read the version AFTER the compute: if another write landed while
      // we were rebuilding, the stamp won't match it and the next poll simply
      // refreshes again — self-healing, never serves a wrong "fresh" flag.
      const v = await poListCacheVersion(c, orgId);
      await kv.put(bodyKey, JSON.stringify(fresh), {
        expirationTtl: PO_LIST_BODY_TTL_S,
        metadata: { v },
      });
    } catch (err) {
      console.error("[poList cache] stale refresh failed", err);
    } finally {
      inFlightPoListBodyRefreshes.delete(bodyKey);
    }
  })();
  waitUntil(task);
}

// ── jobCards-lite: the Planning board's slim job-card projection ─────────────
// Planning (src/pages/planning/index.tsx) pulls the whole ~10MB
// ?fields=minimal&include=jobCards&excludeCompleted=true payload but reads ONLY
// these 12 fields off each job card (audited 2026-07-14: every access is `jc.X`
// in a local loop — no spread, no destructure, never passed to a helper).
// `include=jobCards-lite` ships ONLY these → ~half the wire vs the full ~25-field
// MinimalJobCardOut. Byte-identical FOR PLANNING (its sole consumer); every other
// page keeps include=jobCards (the full shape) untouched. Applied as a post-pass
// on the assembled list so it needs no threading through fetchFilteredPOs /
// rowToMinimalPO / rowToMinimalJobCard (blast radius = the lite request only).
// (jc.actualMinutes is read too but was never in the payload → already undefined,
// so it is intentionally NOT added here.)
export function slimJobCardsToPlanningLite(pos: unknown[]): void {
  for (const po of pos as Array<{ jobCards?: MinimalJobCardOut[] }>) {
    if (!Array.isArray(po.jobCards)) continue;
    po.jobCards = po.jobCards.map((jc) => ({
      id: jc.id,
      departmentCode: jc.departmentCode,
      status: jc.status,
      dueDate: jc.dueDate,
      completedDate: jc.completedDate,
      estMinutes: jc.estMinutes,
      pic1Id: jc.pic1Id,
      pic1Name: jc.pic1Name,
      pic2Id: jc.pic2Id,
      pic2Name: jc.pic2Name,
      wipLabel: jc.wipLabel,
      wipQty: jc.wipQty,
    })) as unknown as MinimalJobCardOut[];
  }
}

// ── Pre-warm the delivery page's heavy PO-list snapshot (perf 2026-07-13) ─────
// The delivery page fetches `/api/production-orders?fields=minimal&include=jobCards`.
// When its snapshot row is EMPTY (right after a deploy busts the caches, or the
// very first read of the day) the handler cold-computes fetchFilteredPOs over
// every PO + job card — ~20MB, ~25s — as a BLOCKING request. Once a stale
// snapshot exists the read is instant (serve-stale + background refresh), so the
// only 25s hit is the empty-snapshot case. A cron calls this every few minutes
// so a snapshot always exists and users never hit the empty-blocking recompute.
//
// The stored payload is BYTE-IDENTICAL to the live handler: same fetchFilteredPOs
// with the delivery variant's exact params, same attachCustomerSO, same snapshot
// table + cache key. No figure changes — only the timing of the recompute moves
// off the request path (owner red line: input/output figures must stay exact).
// withSnapshot with
// no SWR option = compute-fresh-and-store when stale/empty, return cached when
// already fresh, so a warm tick is a cheap no-op when nothing changed.
export async function warmPoListDeliveryVariant(
  c: Context<Env>,
  orgId: string,
): Promise<{ rows: number }> {
  const { withSnapshot } = await import("../../lib/snapshot");
  // Must equal the delivery page's request key. snapshotCacheKey is the sorted
  // "&"-joined query string of `?fields=minimal&include=jobCards`.
  const snapshotCacheKey = "fields=minimal&include=jobCards";
  const result = await withSnapshot<{
    success: true;
    data: unknown[];
    total: number;
  }>(
    c.var.DB,
    {
      tableName: "production_orders_list_snapshot",
      sourceTables: ["production_orders", "job_cards", "sales_orders", "consignment_orders"],
    },
    orgId,
    async () => {
      const data = await fetchFilteredPOs(
        c.var.DB,
        orgId,
        null, // statuses
        true, // includeJobCards
        false, // includeArchive
        true, // minimal
        null, // deptFilter
        null, // dueFrom
        null, // dueTo
        null, // catFilter
        false, // excludeCompleted
      );
      await attachCustomerSO(
        c.var.DB,
        data as Array<{
          salesOrderId: string;
          consignmentOrderId: string;
          customerSO: string;
        }>,
      );
      return { success: true, data, total: data.length };
    },
    snapshotCacheKey,
    c,
    // No SWR: force the compute+store on the cron (this IS the off-request path).
    undefined,
  );
  return { rows: result?.total ?? 0 };
}

// ── Pre-warm the PLANNING page's PO-list snapshot (perf 2026-07-14) ───────────
// Planning fetches `?fields=minimal&include=jobCards&excludeCompleted=true` — a
// DIFFERENT snapshot key from the delivery variant above (excludeCompleted flips
// it), so warmPoListDeliveryVariant does NOT keep it warm. Its snapshot went
// empty/stale between production writes → the first planning load of the window
// cold-computed ~10MB / ~8s as a BLOCKING request (measured on prod 2026-07-14).
// Warming this exact variant every cron tick means planning always finds a
// snapshot → serve-stale (instant) + background refresh, never the 8s block.
//
// BYTE-IDENTICAL to the live handler: same fetchFilteredPOs params planning's
// request drives (excludeCompleted=true) + same attachCustomerSO + same snapshot
// table + the exact sorted request key. No figure changes — only the timing of
// the recompute moves off the request path.
export async function warmPoListPlanningVariant(
  c: Context<Env>,
  orgId: string,
): Promise<{ rows: number }> {
  const { withSnapshot } = await import("../../lib/snapshot");
  // Must equal the planning page's request key: the sorted "&"-joined query
  // string of `?fields=minimal&include=jobCards-lite&excludeCompleted=true`.
  const snapshotCacheKey =
    "excludeCompleted=true&fields=minimal&include=jobCards-lite";
  const result = await withSnapshot<{
    success: true;
    data: unknown[];
    total: number;
  }>(
    c.var.DB,
    {
      tableName: "production_orders_list_snapshot",
      sourceTables: ["production_orders", "job_cards", "sales_orders", "consignment_orders"],
    },
    orgId,
    async () => {
      const data = await fetchFilteredPOs(
        c.var.DB,
        orgId,
        null, // statuses
        true, // includeJobCards
        false, // includeArchive
        true, // minimal
        null, // deptFilter
        null, // dueFrom
        null, // dueTo
        null, // catFilter
        true, // excludeCompleted — the planning variant
      );
      await attachCustomerSO(
        c.var.DB,
        data as Array<{
          salesOrderId: string;
          consignmentOrderId: string;
          customerSO: string;
        }>,
      );
      // Slim jobCards to the Planning board's 12 read fields — the warmed
      // snapshot must match the live jobCards-lite request byte-for-byte.
      slimJobCardsToPlanningLite(data);
      return { success: true, data, total: data.length };
    },
    snapshotCacheKey,
    c,
    // No SWR: force the compute+store on the cron (this IS the off-request path).
    undefined,
  );
  return { rows: result?.total ?? 0 };
}

// Today's date in Malaysia (UTC+8, no DST) — mirrors todayISO() in
// src/pages/production/utils.ts. The dept page seeds its cold-start date
// window from that exact function, so the warmer must agree on the day or the
// key drifts by one at the UTC boundary.
export function todayMytISO(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// The snapshot key for a dept sheet's cold open. Built the same way the
// handler builds it: sorted, "&"-joined query params. Exported so the
// regression test can compare it against the FE's URL construction.
export function deptWarmCacheKey(dept: string, today: string): string {
  return [
    `fields=minimal`,
    `dept=${encodeURIComponent(dept)}`,
    `excludeCompleted=true`,
    `dueFrom=${encodeURIComponent(today)}`,
    `dueTo=${encodeURIComponent(today)}`,
  ]
    .sort()
    .join("&");
}

// Warm ONE per-DEPT sheet snapshot (Fab Cut / Fab Sew / … / Packing), so the
// first operator to open a dept sheet doesn't pay the ~5-8s cold recompute
// (owner-reported "打开卡很久" on Fab Cut; health 2026-08-01 measured
// /api/production-orders at P50 8s / P95 30s).
//
// ATTEMPT 1 (be17d4b4) SHIPPED A KEY THAT NEVER MATCHED and was reverted in
// 071fcee7. It assumed the dept page sends no date window. It does: on a cold
// open `useColdStartTodayFallback` seeds dueFrom=dueTo=todayISO() (MYT), so the
// live request is
//   fields=minimal&dept=<D>&excludeCompleted=true&dueFrom=<today>&dueTo=<today>
// while the warmer stored `dept=<D>&excludeCompleted=true&fields=minimal`.
// Result: a snapshot nobody ever read, plus wasted cron time per dept.
//
// The key here is now built by the SAME rule the handler uses — the request's
// query string, sorted and "&"-joined (see production-orders.ts:
// `new URL(c.req.url).searchParams.toString().split("&").sort().join("&")`) —
// with the same today-MYT window the page seeds. deptWarmCacheKey() below is
// the single place that shape is defined, and the test asserts it against the
// FE's own construction so this cannot silently drift a third time.
//
// The rows we compute MUST also be filtered by that same window, or the
// snapshot would hold more rows than the key promises.
export async function warmPoListDeptVariant(
  c: Context<Env>,
  orgId: string,
  dept: string,
): Promise<{ rows: number }> {
  const { withSnapshot } = await import("../../lib/snapshot");
  const today = todayMytISO();
  const snapshotCacheKey = deptWarmCacheKey(dept, today);
  const result = await withSnapshot<{
    success: true;
    data: unknown[];
    total: number;
  }>(
    c.var.DB,
    {
      tableName: "production_orders_list_snapshot",
      sourceTables: ["production_orders", "job_cards", "sales_orders", "consignment_orders"],
    },
    orgId,
    async () => {
      const data = await fetchFilteredPOs(
        c.var.DB,
        orgId,
        null, // statuses
        true, // includeJobCards — the dept sheet inlines full jobCards
        false, // includeArchive
        true, // minimal
        dept, // deptFilter
        today, // dueFrom — MUST mirror the key's window (cold open seeds today)
        today, // dueTo
        null, // catFilter
        true, // excludeCompleted — dept pages always send it
      );
      await attachCustomerSO(
        c.var.DB,
        data as Array<{
          salesOrderId: string;
          consignmentOrderId: string;
          customerSO: string;
        }>,
      );
      return { success: true, data, total: data.length };
    },
    snapshotCacheKey,
    c,
    undefined, // no SWR — force compute+store on the cron
  );
  return { rows: result?.total ?? 0 };
}

// After a worker QR scan completes job cards, the operator-facing production
// dept sheets read from a cache-aside snapshot (production_orders_list_snapshot)
// plus the KV list cache. The snapshot freshness probe compares MAX(updated_at)
// across production_orders (updated_at is TEXT, stored as ISO "…T…Z") and
// job_cards (TIMESTAMP, "… …") — a lexical compare over mixed formats the
// codebase documents as unreliable ("the probe lies"; see snapshot.ts
// invalidateHubChangeSnapshots). So a scan could leave the dept sheet showing
// the pre-scan status (e.g. Fab Cut stuck PENDING while the card is already
// COMPLETED — the SO-2605-305-03 report, 2026-06-06). Explicitly bump the KV
// version AND wipe the per-org snapshot rows so the next operator fetch
// recomputes fresh — for EVERY scan dept (Fab Cut / Fab Sew / Upholstery /
// Packing). Best-effort: never throws into the scan's success path.
//
// 2026-06-06: changed from DELETE to mark-stale (built_from = epoch) so the
// serve-stale-while-revalidate read path keeps the prior copy to hand back
// instantly instead of paying a cold recompute on the next operator open.
// Resolve the org for a SCAN-path write. Worker-token scans carry NO dashboard
// user, so getOrgId(c) would throw ("orgId not resolved on request context") —
// which is exactly what crashed worker scan-completion. Fall back to the default
// org (single-tenant today) so a worker's scan completes AND invalidates the
// operator's dept-sheet snapshot; a dashboard scan still gets its own resolved
// org via tryGetOrgId.
export function scanOrgId(c: Context<Env>): string {
  return tryGetOrgId(c) ?? DEFAULT_ORG_ID;
}

// Invalidate every cached read of GET /api/production-orders for one org:
//   (1) bump the KV version key so the 60s Layer-1 cache is skipped, AND
//   (2) DELETE the Layer-2 dept-sheet snapshot rows so the next read does a
//       COLD recompute and returns FRESH data. We previously only marked them
//       stale (built_from = epoch) and leaned on serve-stale-while-revalidate,
//       but the background revalidation did NOT reliably rewrite the snapshot —
//       a dept-cell edit with no PO-status change (PIC / completion-date) stayed
//       invisible for a FULL DAY across many refreshes, and the stale blank got
//       re-cached into the 60s KV layer on every read (the 2026-06-24 WOOD_CUT
//       incident: SO-2606-160/161/152 WOOD_CUT was COMPLETED + had a PIC in
//       job_cards but the grid showed WAITING / blank). A hard DELETE forces
//       freshness regardless of the (mixed TEXT/TIMESTAMP) updated_at probe AND
//       the flaky revalidation. Cost: one ~2-3s cold recompute on the first
//       read after a write — correctness wins over the snapshot optimization.
//
// EVERY production-order write path — scan completion AND dashboard edit — must
// do BOTH steps; doing only the KV bump leaves the snapshot stale for ~1-3 min
// (the operator-visible flicker, BUG-2026-06-09-005). Callers pass their own
// resolved orgId (dashboard: getOrgId; scan: scanOrgId) and own the try/catch.
// 2026-07-23: the implementation moved to src/api/lib/po-list-cache.ts and is
// imported at the top of this file. Six route modules write production_orders;
// they now share ONE helper instead of each carrying a copy that can drift.
// tests/production-write-invalidation-class.test.mjs enumerates them.

export async function invalidateProductionCachesAfterScan(
  c: Context<Env>,
): Promise<void> {
  try {
    await invalidateProductionListCaches(c, scanOrgId(c));
  } catch (err) {
    console.warn(
      "[invalidateProductionCachesAfterScan] failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function applyPoStatusChange(
  c: Context<Env>,
  id: string,
  next: "ON_HOLD" | "PENDING" | "CANCELLED",
): Promise<Response> {
  const db = c.var.DB;
  const existing = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(id)
    .first<ProductionOrderRow>();
  if (!existing) {
    return c.json({ success: false, error: "Production order not found" }, 404);
  }

  const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
  const reason =
    typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";

  // Gate the transition against the current status.
  const from = existing.status;
  if (next === "ON_HOLD") {
    if (from !== "PENDING" && from !== "IN_PROGRESS") {
      return c.json(
        {
          success: false,
          error: `Cannot hold a ${from} production order. Only PENDING or IN_PROGRESS POs can be held.`,
        },
        409,
      );
    }
  } else if (next === "PENDING") {
    if (from !== "ON_HOLD") {
      return c.json(
        {
          success: false,
          error: `Cannot resume a ${from} production order. Only ON_HOLD POs can be resumed.`,
        },
        409,
      );
    }
  } else if (next === "CANCELLED") {
    if (from === "COMPLETED" || from === "CANCELLED") {
      return c.json(
        {
          success: false,
          error: `Cannot cancel a ${from} production order. Completed work is locked; if you need to back out a completed PO, contact admin.`,
        },
        409,
      );
    }
  }

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];

  statements.push(
    db
      .prepare(
        `UPDATE production_orders SET status = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(next, now, id),
  );

  // CANCEL also cascades down: any non-terminal JC under this PO becomes
  // CANCELLED. Completed/transferred JCs stay — they represent real
  // production output (cost_ledger / fg_units already posted).
  let jcCascadeCount = 0;
  if (next === "CANCELLED") {
    statements.push(
      db
        .prepare(
          `UPDATE job_cards SET status = 'CANCELLED', updated_at = ?
             WHERE productionOrderId = ?
               AND status NOT IN ('COMPLETED', 'TRANSFERRED')`,
        )
        .bind(now, id),
    );
    // Count for response transparency (best-effort — small overhead).
    try {
      const r = await db
        .prepare(
          `SELECT COUNT(*) AS c FROM job_cards
             WHERE productionOrderId = ?
               AND status NOT IN ('COMPLETED', 'TRANSFERRED', 'CANCELLED')`,
        )
        .bind(id)
        .first<{ c: number }>();
      jcCascadeCount = Number(r?.c ?? 0);
    } catch {
      /* non-fatal */
    }
  }

  await db.batch(statements);

  // Audit trail — single row capturing the before/after PO snapshot plus
  // the operator-supplied reason. Forensic queries can trace any PO that
  // suddenly went ON_HOLD / CANCELLED to who pressed the button and why.
  try {
    await emitAudit(c, {
      resource: "production-orders",
      resourceId: id,
      action:
        next === "ON_HOLD"
          ? "hold"
          : next === "PENDING"
            ? "resume"
            : "cancel",
      before: { status: from },
      after: { status: next, reason, jcCascadeCount },
    });
  } catch {
    /* audit best-effort, don't fail the action */
  }

  return c.json({
    success: true,
    id,
    status: next,
    previousStatus: from,
    jcCascadeCount,
    reason,
  });
}

