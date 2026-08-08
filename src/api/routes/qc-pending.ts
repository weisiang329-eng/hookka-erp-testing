// ---------------------------------------------------------------------------
// QC Pending Inspections + Cron Trigger.
//
// Generation runs twice a day (12:00 / 16:00 factory local) on FOUR DIFFERENT
// RHYTHMS, because the owner's model (2026-08-08) is four different jobs. Do
// not "unify" them: each one fires on a different event and answers a different
// question.
//
//   RM  — ONE INSPECTION PER RECEIPT DAY × SUPPLIER × MATERIAL FAMILY.
//         "只要有了 GR，可能是一张 PI 或者同一天进来的货，我们只需要检查一次",
//         corrected on the same day to "同一天的话，通常是验一次就够了". The
//         batch is the DAY's goods from ONE supplier, not the document: two
//         GRNs of one family on one day raise ONE inspection carrying both
//         receipt numbers, and a GRN confirmed later that day attaches to it
//         while it is still open. Re-running raises none. See generateRmForGrns.
//   STORED — DAILY, on the material actually DRAWN for production, however long
//         it has been in the racks. "可是有一些东西还是要 daily 检查的 … 那天用的
//         木头有没有发霉？还有海绵，那天用的海绵有没有问题？" IQC fires on a
//         delivery; this fires on an ISSUE, so it still runs on a day nothing
//         arrives — which is exactly when stored stock is the risk. It names the
//         rm_batch and its days-in-store, and draws the OLDEST batches first.
//         See generateStoredRmChecks.
//   WIP — TWICE DAILY, gated on the department actually working.
//         "这个可能需要每天跟进，比如早上一次、下午一次". See stageHadActivity.
//   FG  — PERIODIC SAMPLING of what was produced, each slot bound to a
//         SPECIFIC finished unit and its sales order.
//         "定期进行抽查，重点看他们有没有做对 order，有没有做错".
//         See generateFgSamples.
//
// It was a blind schedule until 2026-08-07 (34 rows a day regardless of
// whether anything was made, a 3,009-row backlog nobody could clear), then a
// day-gated schedule, then briefly one inspection per GRN. The day gate's real
// fault was never the day — it was that it named NO receipt, so the inspector
// could not tell which goods to look at, and that it collapsed two suppliers'
// deliveries into one PASS. Both are fixed without going back to one row per
// document: the batch is (day × supplier × family) and the row names every
// receipt in it.
//
// Endpoints:
//   GET    /api/qc-pending              — list PENDING + IN_PROGRESS rows
//                                         (filter by ?slot=, ?stage=, ?deptCode=)
//   POST   /api/qc-pending/trigger      — cron entry. CRON_SECRET-gated.
//                                         Body: { slot?: ISO timestamp }. If
//                                         omitted, uses current 12:00/16:00
//                                         slot (closest past slot today).
//                                         Idempotent: never creates duplicate
//                                         (template_id, scheduled_slot_at) rows.
//   POST   /api/qc-pending/generate-now — manual trigger from UI button (auth-gated).
//                                         Same logic as /trigger, no secret.
//   POST   /api/qc-pending/:id/start    — flip PENDING → IN_PROGRESS, attach inspector.
//   POST   /api/qc-pending/:id/complete — submit final results. Body has
//                                         { subjectType, subjectId, subjectLabel,
//                                           items: [{templateItemId, result, notes?, photoUrl?}],
//                                           overallNotes? }. Computes overall
//                                         PASS/FAIL, creates qc_tags rows for
//                                         every FAIL item, and (for WIP stage)
//                                         resets the linked job_card.
//   POST   /api/qc-pending/:id/skip     — mark SKIPPED with reason.
//   POST   /api/qc-pending/bulk-skip    — retire a backlog of old slots with a
//                                         reason. DRY RUN unless confirm:true.
//                                         HAS NOT BEEN RUN — see the handler.
//   DELETE /api/qc-pending/:id          — cancel a PENDING slot (e.g., template
//                                         was deactivated mid-day).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { recomputePoStatusAndProgress } from "./production-orders";
import { ensureQcGenerationSchema } from "../lib/qc-generation-schema";
import {
  drawReasonSummary,
  scoreFgUnit,
  FG_RARITY_WINDOW_DAYS,
  FG_SERVICE_CASE_WINDOW_DAYS,
  OUR_FAULT_ROOT_CAUSES,
  type FgRiskScore,
} from "../lib/qc-fg-risk";
import {
  pickRmTemplate,
  rmFamiliesOnReceipt,
  rmFamilyForLine,
  STORE_CONDITION_TEMPLATE_ID,
  type RmCheckKind,
  type RmFamily,
  type RmLineLike,
} from "../lib/qc-rm-families";

const app = new Hono<Env>();

// --- types ----------------------------------------------------------------
type Stage = "RM" | "WIP" | "FG";
type ItemCategory = "SOFA" | "BEDFRAME" | "ACCESSORY" | "GENERAL";
type Severity = "MINOR" | "MAJOR" | "CRITICAL";
type SubjectType = "RM_BATCH" | "JOB_CARD" | "FG_BATCH" | "RAW_MATERIAL" | "WIP_ITEM";

type InspectionRow = {
  id: string;
  inspectionNo: string | null;
  templateId: string | null;
  templateSnapshot: string | null;
  stage: Stage | null;
  itemCategory: ItemCategory | null;
  department: string | null;
  subjectType: SubjectType | null;
  subjectId: string | null;
  subjectLabel: string | null;
  triggerType: string | null;
  scheduledSlotAt: string | null;
  status: string | null;
  result: string | null;
  notes: string | null;
  inspectorId: string | null;
  inspectorName: string | null;
  inspectionDate: string | null;
  skipReason: string | null;
  completedAt: string | null;
  createdAt: string | null;
  // Added 2026-08-08 (mig 0215 + ensureQcGenerationSchema). Read dual-keyed:
  // the PG adapter folds snake_case → camelCase on the way out, but a row
  // written before the self-apply landed carries neither.
  sourceGrnId?: string | null;
  source_grn_id?: string | null;
  sourceGrnNo?: string | null;
  source_grn_no?: string | null;
  sourceGrnIds?: string | null;
  source_grn_ids?: string | null;
  sourceGrnNos?: string | null;
  source_grn_nos?: string | null;
  sourceReceiptDate?: string | null;
  source_receipt_date?: string | null;
  sourceSupplierId?: string | null;
  source_supplier_id?: string | null;
  rmCheckKind?: string | null;
  rm_check_kind?: string | null;
  sourceRmBatchId?: string | null;
  source_rm_batch_id?: string | null;
  sourceBatchAgeDays?: number | null;
  source_batch_age_days?: number | null;
  sampleReason?: string | null;
  sample_reason?: string | null;
  materialFamily?: string | null;
  material_family?: string | null;
  sourceFgUnitId?: string | null;
  source_fg_unit_id?: string | null;
  soSpec?: string | null;
  so_spec?: string | null;
};

type TemplateRow = {
  id: string;
  name: string;
  deptCode: string;
  deptName: string | null;
  itemCategory: ItemCategory;
  stage: Stage;
  active: number;
  notes: string | null;
  materialFamily?: string | null;
  material_family?: string | null;
  supplierId?: string | null;
  supplier_id?: string | null;
};

type TemplateItemRow = {
  id: string;
  templateId: string;
  sequence: number;
  itemName: string;
  criteria: string | null;
  severity: Severity;
  isMandatory: number;
};

type InspectionItemRow = {
  id: string;
  inspectionId: string;
  sequence: number;
  itemName: string;
  criteria: string | null;
  severity: Severity;
  isMandatory: number;
  result: "PASS" | "FAIL" | "NA" | null;
  notes: string | null;
  photoUrl: string | null;
};

// --- helpers --------------------------------------------------------------
function genInspId(): string {
  return `qc-${crypto.randomUUID().slice(0, 8)}`;
}
function genItemId(): string {
  return `qcii-${crypto.randomUUID().slice(0, 8)}`;
}
function genTagId(): string {
  return `qctg-${crypto.randomUUID().slice(0, 8)}`;
}
function genDefectId(): string {
  return `qcd-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * One allocator per generation run, NOT one lookup per inspection.
 *
 * BUG-2026-08-07: this used to be `getNextInspectionNo(db)` — a COUNT(*)
 * called inside the per-template loop. Every INSERT of the run is deferred to
 * a single db.batch() at the end, so the count never moved between calls and
 * EVERY inspection generated in the same slot got the SAME inspectionNo. On
 * prod that meant 17 rows per slot sharing one number, twice a day, for three
 * months — an inspection number that identifies seventeen inspections
 * identifies none of them.
 *
 * The base is now read ONCE, before the loop, and the counter is incremented
 * in memory per row. It is also taken from the highest suffix actually in use
 * rather than a row COUNT, so a deleted slot (DELETE /api/qc-pending/:id) can
 * no longer hand its number to the next run.
 */
async function inspectionNoAllocator(
  db: D1Database,
): Promise<() => string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `QC-${yymm}-`;
  const res = await db
    .prepare("SELECT inspectionNo FROM qc_inspections WHERE inspectionNo LIKE ?")
    .bind(`${prefix}%`)
    .all<{ inspectionNo: string | null }>();
  let seq = 0;
  for (const r of res.results ?? []) {
    const tail = Number((r.inspectionNo ?? "").slice(prefix.length));
    if (Number.isFinite(tail) && tail > seq) seq = tail;
  }
  return () => {
    seq += 1;
    return `${prefix}${String(seq).padStart(3, "0")}`;
  };
}

// --- is there anything to inspect? ----------------------------------------
//
// BUG-2026-08-07: generation used to be a blind schedule — one row per active
// template per slot, twice a day, forever, whether or not that station made
// anything or any goods arrived. 34 rows a day against a factory that had not
// completed a single inspection. A queue that can never be cleared is a queue
// everyone learns to ignore, and that is exactly what happened.
//
// Owner 2026-08-07: everything is SAMPLING, tied to actual volume — "他应该要
// 定期检查我们的 WIP 部门，还有我们的完成品（我们正常是抽查）… 如果是进货，也就是
// IQC 那边，基本上他应该也都是要抽查的".
//
// So a slot is only created when the thing it samples EXISTS on that date:
//   WIP — the department has work in hand (a card IN_PROGRESS or PAUSED) or
//         finished something that day. A WAITING-only department is a queue,
//         not production: nothing has been made yet, so there is nothing to
//         sample. (The phone still offers WAITING cards as subjects once a
//         slot exists — being able to inspect a card that just started is
//         fine; generating a slot for a department that has only ever queued
//         is not.)
//
// RM and FG NO LONGER COME THROUGH HERE (2026-08-08). A day gate was the wrong
// unit for both of them:
//   RM  — the unit is the RECEIPT, not the day. The day gate collapsed two
//         GRNs into one inspection and named neither. → generateRmForGrns.
//   FG  — the unit is the finished PIECE, and the volume decides how many to
//         pull. One blind slot a day is not sampling. → generateFgSamples.
// This probe is now WIP only, unchanged, because the owner's WIP rule is
// literally a twice-daily follow-up on a department that is working.
//
// Fail OPEN: an unknown stage, or a probe that throws, still generates. Over-
// generating is a nuisance; silently never generating is how you end up
// believing you have QC when you don't.
async function stageHadActivity(
  db: D1Database,
  stage: Stage | null,
  deptCode: string,
  slotDate: string,
): Promise<boolean> {
  try {
    if (stage === "WIP") {
      const row = await db
        .prepare(
          `SELECT 1 AS hit FROM job_cards
            WHERE departmentCode = ?
              AND (status IN ('IN_PROGRESS','PAUSED') OR completedDate = ?)
            LIMIT 1`,
        )
        .bind(deptCode, slotDate)
        .first<{ hit: number }>();
      return !!row;
    }
    return true;
  } catch (err) {
    console.error("[qc-pending] activity probe failed — generating anyway", {
      stage,
      deptCode,
      slotDate,
      err: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/**
 * Compute the most-recent past 12:00 / 16:00 slot in the user's local TZ.
 * Returns ISO string in UTC.
 *
 * The factory operates in UTC+8 (Singapore / Malaysia). We anchor the slot
 * boundaries to local clock time so "12:00 noon" means noon LOCAL.
 */
export function currentSlotIso(now = new Date()): string {
  // Convert to UTC+8 wall clock
  const utcMs = now.getTime();
  const localMs = utcMs + 8 * 60 * 60 * 1000;
  const local = new Date(localMs);
  const localHour = local.getUTCHours();
  // Pick the slot: 12:00 if local hour in [12, 16), 16:00 if [16, 24), else
  // yesterday's 16:00.
  const slotLocal = new Date(local);
  slotLocal.setUTCMinutes(0, 0, 0);
  if (localHour >= 16) {
    slotLocal.setUTCHours(16);
  } else if (localHour >= 12) {
    slotLocal.setUTCHours(12);
  } else {
    // Roll back one calendar day to yesterday 16:00 local
    slotLocal.setUTCDate(slotLocal.getUTCDate() - 1);
    slotLocal.setUTCHours(16);
  }
  // Convert back from UTC+8 wall clock to UTC ISO
  return new Date(slotLocal.getTime() - 8 * 60 * 60 * 1000).toISOString();
}

function rowToInspection(r: InspectionRow, items: InspectionItemRow[] = []) {
  return {
    id: r.id,
    inspectionNo: r.inspectionNo ?? "",
    templateId: r.templateId ?? "",
    templateSnapshot: r.templateSnapshot ? safeParseJson(r.templateSnapshot) : null,
    stage: r.stage,
    itemCategory: r.itemCategory,
    deptCode: r.department ?? "",
    subjectType: r.subjectType,
    subjectId: r.subjectId ?? "",
    subjectLabel: r.subjectLabel ?? "",
    triggerType: r.triggerType ?? "",
    scheduledSlotAt: r.scheduledSlotAt ?? "",
    status: r.status ?? "",
    result: r.result ?? "",
    notes: r.notes ?? "",
    inspectorId: r.inspectorId ?? "",
    inspectorName: r.inspectorName ?? "",
    inspectionDate: r.inspectionDate ?? "",
    skipReason: r.skipReason ?? "",
    completedAt: r.completedAt ?? "",
    createdAt: r.createdAt ?? "",
    // WHAT this inspection is about, decided at generation time. The subject
    // columns above are what the inspector finally submitted; these say what
    // they were handed. Dual-keyed — see InspectionRow.
    sourceGrnId: r.sourceGrnId ?? r.source_grn_id ?? "",
    sourceGrnNo: r.sourceGrnNo ?? r.source_grn_no ?? "",
    // EVERY receipt the day's batch covers. Falls back to the singular column so
    // a row written before the day-batching change still renders as one receipt
    // rather than as none.
    sourceGrnNos: (() => {
      const list = safeParseJson(r.sourceGrnNos ?? r.source_grn_nos ?? "");
      if (Array.isArray(list) && list.length) return list.filter((x) => typeof x === "string");
      const one = r.sourceGrnNo ?? r.source_grn_no ?? "";
      return one ? [one] : [];
    })(),
    sourceReceiptDate: r.sourceReceiptDate ?? r.source_receipt_date ?? "",
    // INCOMING (a goods receipt) vs STORED (a batch drawn for production today).
    // Both are stage RM; a row with neither is an INCOMING one from before the
    // stored rhythm existed.
    rmCheckKind: r.rmCheckKind ?? r.rm_check_kind ?? "",
    sourceRmBatchId: r.sourceRmBatchId ?? r.source_rm_batch_id ?? "",
    sourceBatchAgeDays: r.sourceBatchAgeDays ?? r.source_batch_age_days ?? null,
    materialFamily: r.materialFamily ?? r.material_family ?? "",
    sourceFgUnitId: r.sourceFgUnitId ?? r.source_fg_unit_id ?? "",
    soSpec: safeParseJson(r.soSpec ?? r.so_spec ?? "") as Record<string, unknown> | null,
    // WHY this unit was drawn. Null on a WIP/RM slot and on FG rows drawn
    // before the weighting existed — the screen falls back to saying nothing
    // rather than to saying "routine".
    sampleReason: safeParseJson(r.sampleReason ?? r.sample_reason ?? "") as Record<
      string,
      unknown
    > | null,
    items: items
      .filter((i) => i.inspectionId === r.id)
      .sort((a, b) => a.sequence - b.sequence)
      .map((i) => ({
        id: i.id,
        sequence: i.sequence,
        itemName: i.itemName,
        criteria: i.criteria ?? "",
        severity: i.severity,
        isMandatory: i.isMandatory === 1,
        result: i.result,
        notes: i.notes ?? "",
        photoUrl: i.photoUrl ?? "",
      })),
  };
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Constant-time string equality for cron-secret check. Hashes both sides.
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  if (va.length !== vb.length) return false;
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

// --- shared trigger logic -------------------------------------------------

/**
 * How far back a generation run looks for goods receipts that have not been
 * inspected yet.
 *
 * NOT unbounded, deliberately. Prod carries years of receipts; a lookback of
 * "all time" would raise thousands of inspections for goods that were consumed
 * months ago on the first run after deploy — the same wallpaper backlog this
 * module has already been rebuilt twice to get rid of. Seven days covers a GRN
 * confirmed late (weekend arrivals, a document confirmed on the Monday) while
 * keeping the first run honest.
 */
export const RM_GRN_LOOKBACK_DAYS = 7;

/**
 * FG sampling rate and per-slot ceiling.
 *
 * Owner 2026-08-08: "FG 检查：定期进行抽查" — a SHARE of what was produced.
 * One blind slot a day is not a sampling plan: it says the same thing whether
 * the factory shipped 2 units or 60. 10% with a floor of 1 (anything produced
 * gets looked at) and a ceiling of 5 per slot per category (an inspector who
 * is handed 12 units in one afternoon does 12 tick-box exercises, not 12
 * inspections — and there is a second slot the same day).
 */
export const FG_SAMPLE_RATE = 0.1;
export const FG_SAMPLE_MAX_PER_SLOT = 5;

export function fgSampleTarget(unitsProduced: number): number {
  if (unitsProduced <= 0) return 0;
  return Math.min(
    FG_SAMPLE_MAX_PER_SLOT,
    Math.max(1, Math.ceil(unitsProduced * FG_SAMPLE_RATE)),
  );
}

/** Everything one generated inspection needs, independent of which stage built it. */
type PlannedInspection = {
  tpl: TemplateRow;
  subjectType?: SubjectType | null;
  subjectId?: string | null;
  subjectLabel?: string | null;
  sourceGrnId?: string | null;
  sourceGrnNo?: string | null;
  sourceGrnIds?: string[] | null;
  sourceGrnNos?: string[] | null;
  sourceReceiptDate?: string | null;
  sourceSupplierId?: string | null;
  materialFamily?: string | null;
  sourceFgUnitId?: string | null;
  soSpec?: unknown;
  rmCheckKind?: RmCheckKind | null;
  sourceRmBatchId?: string | null;
  sourceBatchAgeDays?: number | null;
  sampleReason?: unknown;
};

/**
 * Turn a planned inspection into its INSERT statements (header + one row per
 * checklist item, results NULL so the inspector just fills them in).
 *
 * Shared by all three stage generators so a new stage cannot quietly forget the
 * template snapshot — the snapshot is what keeps a completed inspection
 * readable after the template is edited.
 */
function buildInspectionStatements(
  db: D1Database,
  plan: PlannedInspection,
  tplItems: TemplateItemRow[],
  slotIso: string,
  slotDate: string,
  inspNo: string,
): D1PreparedStatement[] {
  const { tpl } = plan;
  const inspId = genInspId();
  const items = tplItems
    .filter((i) => i.templateId === tpl.id)
    .sort((a, b) => a.sequence - b.sequence);
  const snapshot = JSON.stringify({
    templateName: tpl.name,
    items: items.map((i) => ({
      id: i.id,
      sequence: i.sequence,
      itemName: i.itemName,
      criteria: i.criteria,
      severity: i.severity,
      isMandatory: i.isMandatory,
    })),
  });
  const now = new Date().toISOString();

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO qc_inspections (
           id, inspectionNo, templateId, templateSnapshot, stage, itemCategory,
           department, triggerType, scheduledSlotAt, status,
           inspectionDate, created_at,
           subjectType, subjectId, subjectLabel,
           source_grn_id, source_grn_no, material_family, source_fg_unit_id, so_spec,
           source_grn_ids, source_grn_nos, source_receipt_date, source_supplier_id,
           rm_check_kind, source_rm_batch_id, source_batch_age_days, sample_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        inspId,
        inspNo,
        tpl.id,
        snapshot,
        tpl.stage,
        tpl.itemCategory,
        tpl.deptCode,
        slotIso,
        slotDate,
        now,
        plan.subjectType ?? null,
        plan.subjectId ?? null,
        plan.subjectLabel ?? null,
        plan.sourceGrnId ?? null,
        plan.sourceGrnNo ?? null,
        plan.materialFamily ?? null,
        plan.sourceFgUnitId ?? null,
        plan.soSpec === undefined || plan.soSpec === null ? null : JSON.stringify(plan.soSpec),
        plan.sourceGrnIds?.length ? JSON.stringify(plan.sourceGrnIds) : null,
        plan.sourceGrnNos?.length ? JSON.stringify(plan.sourceGrnNos) : null,
        plan.sourceReceiptDate ?? null,
        plan.sourceSupplierId ?? null,
        plan.rmCheckKind ?? null,
        plan.sourceRmBatchId ?? null,
        plan.sourceBatchAgeDays ?? null,
        plan.sampleReason === undefined || plan.sampleReason === null
          ? null
          : JSON.stringify(plan.sampleReason),
      ),
  ];

  for (const it of items) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO qc_inspection_items (
             id, inspectionId, sequence, itemName, criteria, severity, isMandatory, result
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .bind(genItemId(), inspId, it.sequence, it.itemName, it.criteria, it.severity, it.isMandatory),
    );
  }
  return stmts;
}

// --- RM: one inspection per receipt DAY, per supplier, per material family --
//
// THE UNIT IS THE DAY'S BATCH FROM ONE SUPPLIER. Owner 2026-08-08, correcting
// the per-GRN rule shipped earlier the same day: "同一天的话，通常是验一次就够
// 了" (and originally "可能是一张 PI 或者同一天进来的货，我们只需要检查一次").
// Two GRNs of the same goods on one day is the goods arriving on two documents,
// not two inspections' worth of work — the inspector walks to the same pallet
// once. So:
//   • two GRNs of one family from one supplier on one day raise ONE inspection,
//     and BOTH receipts are recorded on it (source_grn_ids / source_grn_nos) so
//     the inspector knows what is actually in front of them;
//   • a GRN confirmed LATER the same day ATTACHES to that inspection while it
//     is still PENDING / IN_PROGRESS — the common case, since receipts trickle
//     in across the day and generation runs at 12:00 and again at 16:00. If the
//     inspection is already COMPLETED or SKIPPED the late receipt raises a NEW
//     one: you cannot add goods to a record somebody has already signed;
//   • re-running raises nothing, keyed on (grnId, templateId) covered — which
//     is read out of source_grn_ids, not just the singular column.
//
// TWO SUPPLIERS ON ONE DAY ARE TWO INSPECTIONS. Two suppliers is two batches
// with two independent risks and two different corrective actions (a claim goes
// back to one supplier, not to "Tuesday"), and one blended PASS would hide
// which delivery was the bad one — the same argument that already splits the
// families, applied to the other axis of the batch.
//
// MIXED GOODS: one inspection PER MATERIAL FAMILY, not one blended checklist. A
// timber + fabric day raises two. The checks are different physical activities
// (moisture meter and a bench vs. a swatch in daylight) commonly done by
// different people at different times; a single overall PASS/FAIL would let a
// fabric finding condemn the timber and vice-versa, and the whole value of the
// record is being able to say WHAT was wrong; and it keeps one inspection = one
// template snapshot, so nothing downstream (completion, tags, the phone) has to
// learn about multi-template inspections.
//
// `source_grn_id` stays SINGULAR and stays the first receipt of the batch, so
// every existing read, index and subject link keeps resolving; the full list
// lives alongside it. That was the choice over "point at the day + family and
// let the UI re-derive the receipts": the inspection is a record, and a record
// that has to re-run a query to say what it was about stops being true the
// moment a GRN is cancelled or back-dated.
//
// ROUTING is off `raw_materials.item_group` (see lib/qc-rm-families.ts), never
// off the supplier's free-text description — a new material code inherits the
// right checklist the moment it is filed in the right group.
type GrnHeaderRow = {
  id: string;
  grnNumber: string | null;
  supplierId: string | null;
  supplierName: string | null;
  receiveDate: string | null;
};
type GrnLineRow = RmLineLike & { grnId: string };

/** An existing RM inspection, as far as batching cares. */
type RmExistingRow = {
  id: string;
  templateId: string | null;
  status: string | null;
  sourceGrnId: string | null;
  sourceGrnIds: string | null;
  sourceReceiptDate: string | null;
  sourceSupplierId: string | null;
};

/** One (day × supplier × template) batch being assembled this run. */
type RmBatch = {
  key: string;
  day: string;
  supplierId: string;
  supplierName: string | null;
  family: RmFamily;
  tpl: TemplateRow;
  grns: GrnHeaderRow[];
};

/** The receipt DAY, whether receiveDate is 'YYYY-MM-DD' or a full ISO stamp. */
function receiptDay(receiveDate: string | null | undefined, fallback: string): string {
  const d = String(receiveDate ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : fallback;
}

/**
 * What the inspector is told to go and look at.
 *
 * Every receipt number is named while the list is short, because "GRN-0007 and
 * GRN-0011" is an instruction and "2 receipts" is a riddle. Past three it is
 * truncated with a count and the full list is still on the row.
 */
function rmSubjectLabel(grnNos: string[], supplierName: string | null): string {
  const shown = grnNos.length <= 3 ? grnNos.join(", ") : `${grnNos.slice(0, 3).join(", ")} +${grnNos.length - 3} more`;
  const count = grnNos.length > 1 ? ` (${grnNos.length} receipts)` : "";
  return `${shown}${count}${supplierName ? ` · ${supplierName}` : ""}`;
}

function parseIdList(json: string | null | undefined): string[] {
  if (!json) return [];
  const parsed = safeParseJson(json);
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
}

/** PENDING / IN_PROGRESS is "still open" — anything else has been signed off. */
function isOpenInspection(status: string | null): boolean {
  return status === "PENDING" || status === "IN_PROGRESS";
}

export async function generateRmForGrns(
  db: D1Database,
  slotIso: string,
  slotDate: string,
  templates: TemplateRow[],
  tplItems: TemplateItemRow[],
  nextInspectionNo: () => string,
): Promise<{
  stmts: D1PreparedStatement[];
  created: number;
  attached: number;
  skipped: number;
  receipts: number;
  noTemplate: number;
}> {
  const empty = {
    stmts: [] as D1PreparedStatement[],
    created: 0,
    attached: 0,
    skipped: 0,
    receipts: 0,
    noTemplate: 0,
  };
  const rmTemplates = templates.filter((t) => t.stage === "RM");
  if (rmTemplates.length === 0) return empty;

  const from = new Date(`${slotDate}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - RM_GRN_LOOKBACK_DAYS);
  const fromDate = from.toISOString().slice(0, 10);
  // receiveDate is stored either as a plain 'YYYY-MM-DD' or as a full ISO
  // timestamp. Both compare correctly against these bounds as strings.
  const toBound = `${slotDate}T23:59:59.999Z`;

  let receipts: GrnHeaderRow[];
  try {
    const res = await db
      .prepare(
        `SELECT id, grnNumber, supplierId, supplierName, receiveDate
           FROM grns
          WHERE status IN ('CONFIRMED','POSTED')
            AND receiveDate >= ?
            AND receiveDate <= ?
          ORDER BY receiveDate, id`,
      )
      .bind(fromDate, toBound)
      .all<GrnHeaderRow>();
    receipts = res.results ?? [];
  } catch (err) {
    // Unlike the WIP probe there is nothing to fail open TO — without the
    // receipt list there is no receipt to inspect. Log loudly and let WIP/FG
    // still generate rather than 500 the whole run.
    console.error("[qc-pending] RM receipt scan failed — no RM slots this run", {
      slotDate,
      err: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
  if (receipts.length === 0) return empty;

  const ids = receipts.map((r) => r.id);
  const ph = ids.map(() => "?").join(",");

  const [lineRes, doneRes] = await Promise.all([
    db
      .prepare(
        `SELECT gitem.grnId AS "grnId",
                gitem.materialCode AS "materialCode",
                gitem.materialName AS "materialName",
                rmat.itemGroup AS "itemGroup"
           FROM grn_items gitem
           LEFT JOIN raw_materials rmat ON UPPER(rmat.itemCode) = UPPER(gitem.materialCode)
          WHERE gitem.grnId IN (${ph})`,
      )
      .bind(...ids)
      .all<GrnLineRow>(),
    // Every RM inspection that could belong to one of this window's batches:
    // by receipt DAY (the batch key), OR by a receipt id it already names (which
    // catches rows written before source_receipt_date existed, so the per-GRN
    // era cannot be re-raised as a day batch).
    db
      .prepare(
        `SELECT id AS "id",
                templateId AS "templateId",
                status AS "status",
                source_grn_id AS "sourceGrnId",
                source_grn_ids AS "sourceGrnIds",
                source_receipt_date AS "sourceReceiptDate",
                source_supplier_id AS "sourceSupplierId"
           FROM qc_inspections
          WHERE source_grn_id IN (${ph})
             OR (source_receipt_date IS NOT NULL
                 AND source_receipt_date >= ? AND source_receipt_date <= ?)`,
      )
      .bind(...ids, fromDate, slotDate)
      .all<RmExistingRow>(),
  ]);

  const linesByGrn = new Map<string, GrnLineRow[]>();
  for (const l of lineRes.results ?? []) {
    const list = linesByGrn.get(l.grnId);
    if (list) list.push(l);
    else linesByGrn.set(l.grnId, [l]);
  }
  const receiptById = new Map(receipts.map((r) => [r.id, r]));

  // (grnId, templateId) — the idempotency key, unchanged in meaning but now
  // read out of the LIST as well as the singular column, because a receipt that
  // attached to an existing inspection only ever appears in the list.
  const alreadyRaised = new Set<string>();
  // (day, supplier, template) → the OPEN inspection a late receipt attaches to.
  const openByBatch = new Map<string, RmExistingRow>();
  const attachedTo = new Map<string, { ids: string[]; nos: string[]; supplierName: string | null }>();

  for (const row of doneRes.results ?? []) {
    const covered = parseIdList(row.sourceGrnIds);
    if (row.sourceGrnId) covered.push(row.sourceGrnId);
    for (const gid of covered) alreadyRaised.add(`${gid}|${row.templateId}`);
    if (!isOpenInspection(row.status)) continue;
    // A row written before these columns existed carries neither day nor
    // supplier — derive them from the receipt it names, so the first row of the
    // per-GRN era still absorbs the rest of its own day.
    const seed = row.sourceGrnId ? receiptById.get(row.sourceGrnId) : undefined;
    const day = row.sourceReceiptDate ?? (seed ? receiptDay(seed.receiveDate, slotDate) : null);
    const supplierId = row.sourceSupplierId ?? seed?.supplierId ?? "";
    if (!day) continue;
    const key = `${day}|${supplierId}|${row.templateId}`;
    if (!openByBatch.has(key)) openByBatch.set(key, row);
  }

  const stmts: D1PreparedStatement[] = [];
  let created = 0;
  let attached = 0;
  let skipped = 0;
  let noTemplate = 0;

  // --- pass 1: group every uninspected receipt into its (day × supplier ×
  // template) batch. Nothing is written until the whole window is grouped —
  // that is what turns two receipts into one inspection instead of two.
  const batches = new Map<string, RmBatch>();
  for (const grn of receipts) {
    const lines = linesByGrn.get(grn.id) ?? [];
    // A receipt with no lines is still goods in the building — inspect it
    // against the general checklist rather than letting it pass unlooked-at.
    const families: RmFamily[] = lines.length ? rmFamiliesOnReceipt(lines) : ["GENERAL"];
    const day = receiptDay(grn.receiveDate, slotDate);
    for (const family of families) {
      const tpl = pickRmTemplate(rmTemplates, family, grn.supplierId);
      if (!tpl) {
        // Counted and reported, never swallowed. Handing a plywood delivery the
        // solid-timber checklist would be worse than saying no template matched.
        noTemplate++;
        continue;
      }
      if (alreadyRaised.has(`${grn.id}|${tpl.id}`)) {
        skipped++;
        continue;
      }
      alreadyRaised.add(`${grn.id}|${tpl.id}`);
      const key = `${day}|${grn.supplierId ?? ""}|${tpl.id}`;
      const batch = batches.get(key);
      if (batch) batch.grns.push(grn);
      else {
        batches.set(key, {
          key,
          day,
          supplierId: grn.supplierId ?? "",
          supplierName: grn.supplierName,
          family,
          tpl,
          grns: [grn],
        });
      }
    }
  }

  // --- pass 2: attach to the open inspection for this batch, or raise one.
  for (const batch of batches.values()) {
    const grnIds = batch.grns.map((g) => g.id);
    const grnNos = batch.grns.map((g) => g.grnNumber ?? g.id);
    const open = openByBatch.get(batch.key);

    if (open) {
      // The case that will actually happen: a second delivery lands after the
      // inspection was raised and before anyone has answered it. Fold it in.
      const prev = attachedTo.get(open.id) ?? {
        ids: (() => {
          const l = parseIdList(open.sourceGrnIds);
          return l.length ? l : open.sourceGrnId ? [open.sourceGrnId] : [];
        })(),
        nos: [] as string[],
        supplierName: batch.supplierName,
      };
      // Numbers for receipts already on the row are re-derived where we can see
      // them; a receipt outside the lookback keeps its id as its label.
      if (prev.nos.length === 0) {
        prev.nos = prev.ids.map((id) => receiptById.get(id)?.grnNumber ?? id);
      }
      const mergedIds = [...prev.ids];
      const mergedNos = [...prev.nos];
      for (let i = 0; i < grnIds.length; i++) {
        if (mergedIds.includes(grnIds[i])) continue;
        mergedIds.push(grnIds[i]);
        mergedNos.push(grnNos[i]);
      }
      attachedTo.set(open.id, { ids: mergedIds, nos: mergedNos, supplierName: prev.supplierName });
      stmts.push(
        db
          .prepare(
            `UPDATE qc_inspections
                SET source_grn_ids = ?, source_grn_nos = ?, subjectLabel = ?,
                    source_receipt_date = ?, source_supplier_id = ?
              WHERE id = ?`,
          )
          .bind(
            JSON.stringify(mergedIds),
            JSON.stringify(mergedNos),
            rmSubjectLabel(mergedNos, prev.supplierName),
            batch.day,
            batch.supplierId || null,
            open.id,
          ),
      );
      attached += batch.grns.length;
      continue;
    }

    stmts.push(
      ...buildInspectionStatements(
        db,
        {
          tpl: batch.tpl,
          // The day's goods ARE the subject. Before 2026-08-08 the inspector was
          // handed an RM slot with no link to any goods at all; the singular
          // column stays the first receipt so every existing link resolves.
          subjectType: "RM_BATCH",
          subjectId: grnIds[0],
          subjectLabel: rmSubjectLabel(grnNos, batch.supplierName),
          sourceGrnId: grnIds[0],
          sourceGrnNo: grnNos[0],
          sourceGrnIds: grnIds,
          sourceGrnNos: grnNos,
          sourceReceiptDate: batch.day,
          sourceSupplierId: batch.supplierId || null,
          materialFamily: batch.family,
          rmCheckKind: "INCOMING",
        },
        tplItems,
        slotIso,
        slotDate,
        nextInspectionNo(),
      ),
    );
    created++;
  }

  return { stmts, created, attached, skipped, receipts: receipts.length, noTemplate };
}

// --- STORED: the material being USED today, however long it has been here ---
//
// Owner 2026-08-08, after seeing the incoming work: "所以基本上就是有货到他才有
// 工作，没有货到他就没有工作，这个是 RM 管理和到货检查。可是有一些东西还是要
// daily 检查的，以确保那些货物没有问题。例如我们讲的木头，那天用的木头有没有
// 发霉？还有海绵，那天用的海绵有没有问题？"
//
// He is right, and it is a gap rather than a refinement: everything above is
// INCOMING. No delivery, no inspection — while the timber that passed at 12%
// moisture in June sits in a Malaysian warehouse through the monsoon and is
// mouldy in August. Foam yellows and takes a compression set under its own
// stack. Fabric mildews on the roll ends. Hardware rusts.
//
// THE TRIGGER IS THE ISSUE, NOT THE RACK. The check fires on material DRAWN for
// production today (`cost_ledger` RM_ISSUE, which names the exact
// `rm_batches` row FIFO consumed). That is what makes it work on a day with no
// deliveries, and it puts the check on the batch that is about to be built into
// a customer's sofa rather than on whatever the inspector happens to walk past.
//
// IT NAMES THE BATCH AND ITS AGE. "Is the foam OK" is unanswerable; "is batch
// rmb-…, received 2026-04-02, 128 days in store, OK" is a twenty-second job.
// Where the batch came from a goods receipt its GRN is carried too, so a
// storage finding walks straight back to the delivery it arrived on.
//
// AGE IS THE DRAW. Every batch issued today is a candidate; the OLDEST are
// drawn first, capped per family per day, because a batch drawn a week after
// arrival needs a glance and one drawn after four months is the entire point.
const STORED_ISSUE_TYPE = "RM_ISSUE";

/**
 * How many batches per material family per day get a stored-material check.
 *
 * Two, not all of them. A day that issues nine timber batches does not need
 * nine identical checklists — it needs the two that have been in the racks
 * longest. The floor is 1: anything issued of a family gets looked at.
 */
export const STORED_SAMPLE_PER_FAMILY = 2;

type IssuedBatchRow = {
  batchId: string;
  rmId: string | null;
  receivedDate: string | null;
  batchSource: string | null;
  batchSourceRefId: string | null;
  itemCode: string | null;
  itemName: string | null;
  itemGroup: string | null;
};

/** Whole days between a batch's arrival and the day it was drawn. */
export function daysInStore(receivedDate: string | null | undefined, onDate: string): number {
  const from = Date.parse(`${String(receivedDate ?? "").slice(0, 10)}T00:00:00.000Z`);
  const to = Date.parse(`${onDate}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

export async function generateStoredRmChecks(
  db: D1Database,
  slotIso: string,
  slotDate: string,
  templates: TemplateRow[],
  tplItems: TemplateItemRow[],
  nextInspectionNo: () => string,
): Promise<{
  stmts: D1PreparedStatement[];
  created: number;
  skipped: number;
  batchesIssued: number;
  oldestDays: number;
}> {
  const empty = {
    stmts: [] as D1PreparedStatement[],
    created: 0,
    skipped: 0,
    batchesIssued: 0,
    oldestDays: 0,
  };
  const rmTemplates = templates.filter((t) => t.stage === "RM");
  if (rmTemplates.length === 0) return empty;

  // cost_ledger.date is written as a full ISO stamp in some paths and a plain
  // date in others; these bounds compare correctly against both as strings.
  const dayFrom = slotDate;
  const dayTo = `${slotDate}T23:59:59.999Z`;

  let issued: IssuedBatchRow[];
  try {
    const res = await db
      .prepare(
        `SELECT cl.batchId AS "batchId",
                b.rmId AS "rmId",
                b.receivedDate AS "receivedDate",
                b.source AS "batchSource",
                b.sourceRefId AS "batchSourceRefId",
                rmat.itemCode AS "itemCode",
                rmat.itemName AS "itemName",
                rmat.itemGroup AS "itemGroup"
           FROM cost_ledger cl
           INNER JOIN rm_batches b ON b.id = cl.batchId
           INNER JOIN raw_materials rmat ON rmat.id = b.rmId
          WHERE cl.type = '${STORED_ISSUE_TYPE}'
            AND cl.batchId IS NOT NULL
            AND cl.date >= ? AND cl.date <= ?
          GROUP BY cl.batchId, b.rmId, b.receivedDate, b.source, b.sourceRefId,
                   rmat.itemCode, rmat.itemName, rmat.itemGroup`,
      )
      .bind(dayFrom, dayTo)
      .all<IssuedBatchRow>();
    issued = res.results ?? [];
  } catch (err) {
    // Nothing to fail open TO: without the issue list there is no batch to
    // name, and naming no batch is what made the old RM slot useless. Log
    // loudly, let the other rhythms generate.
    console.error("[qc-pending] stored-material issue scan failed — no STORED slots this run", {
      slotDate,
      err: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
  if (issued.length === 0) return empty;

  // What has already been raised for this day — batch-level so a re-run and the
  // second slot add nothing, family-level so the per-family cap holds across
  // both slots rather than being spent twice.
  const doneBatches = new Set<string>();
  const perFamilyDone = new Map<string, number>();
  let storeConditionDone = false;
  try {
    const done = await db
      .prepare(
        `SELECT source_rm_batch_id AS "batchId",
                material_family AS "materialFamily",
                templateId AS "templateId"
           FROM qc_inspections
          WHERE rm_check_kind = 'STORED' AND inspectionDate = ?`,
      )
      .bind(slotDate)
      .all<{ batchId: string | null; materialFamily: string | null; templateId: string | null }>();
    for (const r of done.results ?? []) {
      if (r.templateId === STORE_CONDITION_TEMPLATE_ID) {
        storeConditionDone = true;
        continue;
      }
      if (r.batchId) doneBatches.add(r.batchId);
      const fam = r.materialFamily ?? "";
      perFamilyDone.set(fam, (perFamilyDone.get(fam) ?? 0) + 1);
    }
  } catch (err) {
    console.warn("[qc-pending] stored-material already-checked lookup failed", err);
  }

  // The goods receipt each batch arrived on, so a storage finding walks back to
  // the delivery. Best-effort: a batch from OPENING or an ADJUSTMENT has none.
  const grnIds = [
    ...new Set(
      issued
        .filter((b) => b.batchSource === "GRN" && b.batchSourceRefId)
        .map((b) => b.batchSourceRefId as string),
    ),
  ];
  const grnNoById = new Map<string, string>();
  if (grnIds.length) {
    try {
      const gh = grnIds.map(() => "?").join(",");
      const res = await db
        .prepare(`SELECT id AS "id", grnNumber AS "grnNumber" FROM grns WHERE id IN (${gh})`)
        .bind(...grnIds)
        .all<{ id: string; grnNumber: string | null }>();
      for (const r of res.results ?? []) if (r.grnNumber) grnNoById.set(r.id, r.grnNumber);
    } catch (err) {
      console.warn("[qc-pending] stored-material GRN lookup failed", err);
    }
  }

  // OLDEST FIRST. That is the whole draw rule, and it is deliberately not
  // random: age is the signal, and a random draw over a rack that is mostly
  // fresh stock spends the day's check on the batch that arrived on Tuesday.
  const candidates = issued
    .map((b) => ({ ...b, ageDays: daysInStore(b.receivedDate, slotDate) }))
    .sort((a, b) => b.ageDays - a.ageDays || a.batchId.localeCompare(b.batchId));

  const stmts: D1PreparedStatement[] = [];
  let created = 0;
  let skipped = 0;

  for (const batch of candidates) {
    const family = rmFamilyForLine({
      itemGroup: batch.itemGroup,
      materialCode: batch.itemCode,
      materialName: batch.itemName,
    });
    if (doneBatches.has(batch.batchId)) {
      skipped++;
      continue;
    }
    if ((perFamilyDone.get(family) ?? 0) >= STORED_SAMPLE_PER_FAMILY) {
      skipped++;
      continue;
    }
    const tpl = pickRmTemplate(rmTemplates, family, null, "STORED");
    if (!tpl) {
      skipped++;
      continue;
    }
    doneBatches.add(batch.batchId);
    perFamilyDone.set(family, (perFamilyDone.get(family) ?? 0) + 1);

    const grnNo = batch.batchSourceRefId ? grnNoById.get(batch.batchSourceRefId) : undefined;
    const label = [
      batch.itemCode ?? batch.rmId ?? batch.batchId,
      batch.itemName,
      `received ${String(batch.receivedDate ?? "?").slice(0, 10)}`,
      `${batch.ageDays}d in store`,
      grnNo,
    ]
      .filter(Boolean)
      .join(" · ");

    stmts.push(
      ...buildInspectionStatements(
        db,
        {
          tpl,
          subjectType: "RM_BATCH",
          subjectId: batch.batchId,
          subjectLabel: label,
          materialFamily: family,
          rmCheckKind: "STORED",
          sourceRmBatchId: batch.batchId,
          sourceBatchAgeDays: batch.ageDays,
          // The batch's OWN arrival date, which is what "how long has this been
          // sitting here" is measured from.
          sourceReceiptDate: String(batch.receivedDate ?? "").slice(0, 10) || null,
          sourceGrnId: batch.batchSource === "GRN" ? batch.batchSourceRefId : null,
          sourceGrnNo: grnNo ?? null,
        },
        tplItems,
        slotIso,
        slotDate,
        nextInspectionNo(),
      ),
    );
    created++;
  }

  // The store-condition check: once a day, not per family and not per batch. It
  // is about the BUILDING and about FIFO being followed, which is what removes
  // most of the per-family causes at source.
  const storeTpl = rmTemplates.find((t) => t.id === STORE_CONDITION_TEMPLATE_ID);
  if (storeTpl && !storeConditionDone) {
    stmts.push(
      ...buildInspectionStatements(
        db,
        {
          tpl: storeTpl,
          subjectType: "RM_BATCH",
          subjectId: `store-${slotDate}`,
          subjectLabel: `Raw material store — condition on ${slotDate}`,
          rmCheckKind: "STORED",
        },
        tplItems,
        slotIso,
        slotDate,
        nextInspectionNo(),
      ),
    );
    created++;
  } else if (storeTpl) {
    skipped++;
  }

  return {
    stmts,
    created,
    skipped,
    batchesIssued: issued.length,
    oldestDays: candidates[0]?.ageDays ?? 0,
  };
}

// --- FG: periodic sampling, bound to a unit and its sales order ------------
//
// Owner 2026-08-08: "FG 检查：定期进行抽查，重点看他们有没有做对 order，有没有
// 做错". Two things follow, and the old model had neither.
//
// 1. SAMPLING IS A SHARE OF VOLUME. One slot a day said the same thing whether
//    2 units or 60 were packed. fgSampleTarget() draws 10% (floor 1, ceiling 5
//    per slot per product category).
// 2. THE SLOT NAMES A UNIT. "Did they build the right order" is not answerable
//    against a template — it is answerable against ONE piece and the sales-order
//    line it was built from. Each generated inspection carries the fg_unit and a
//    frozen copy of its SO line (product code, size, fabric, qty, options) in
//    `so_spec`, so the inspector compares the thing in front of them with what
//    was actually ordered instead of with what the label claims.
//
// And, added the same day when the owner saw the first version:
//
// 3. WHICH unit is drawn is WEIGHTED BY RISK, not arbitrary. "那些特别少出现的
//    一些 order … 一些款式，看手工等等 … 尤其是我们 service case 里面有的东西".
//    The share was right; the draw was whatever order the database returned, so
//    a day of mostly repeat production spent the inspection on the model the
//    factory has built four hundred times. `scoreFgUnit` (lib/qc-fg-risk.ts)
//    ranks the pool on prior service cases (strongest), on how rarely the
//    product code is actually built, and on how much hand work its BOM says it
//    takes; the top of the ranking is drawn and every drawn unit carries the
//    REASONS onto the inspection in `sample_reason`.
//
// A unit whose SO line cannot be resolved is NOT silently dropped — it is
// counted into `unresolved` and reported, because a finished unit with no
// traceable order is exactly the thing you want someone to look at.
type FgUnitRow = {
  unitId: string;
  unitSerial: string | null;
  soId: string | null;
  soNo: string | null;
  soLineNo: number | null;
  productCode: string | null;
  productName: string | null;
  unitNo: number | null;
  totalUnits: number | null;
  customerName: string | null;
  customerHub: string | null;
  itemCategory: string | null;
  soProductCode: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  quantity: number | null;
  specialOrder: string | null;
  legHeightInches: number | null;
  divanHeightInches: number | null;
  soLineNotes: string | null;
  /** Off the sales-order header — the customer-level service-case signal. */
  customerId: string | null;
};

/** One row of the prior-complaint lookup, however the case was recorded. */
type ServiceCaseHitRow = {
  productCode: string | null;
  customerId: string | null;
  rootCauseCategory: string | null;
};

/** ISO day, N days before `slotDate`. */
function daysBefore(slotDate: string, days: number): string {
  const d = new Date(`${slotDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function upperKey(s: string | null | undefined): string {
  return String(s ?? "").trim().toUpperCase();
}

/**
 * Everything the risk weighting needs, gathered in one place so that a failure
 * in any one lookup degrades that SIGNAL rather than the draw.
 *
 * Every query is bounded (a window, or the set of product codes actually in
 * play today) and every one is caught on its own. A factory with no service
 * cases, no BOM minutes and no history scores every unit 0, and the draw falls
 * back to the arbitrary one it used to be — which is the correct failure
 * direction: sampling something beats sampling nothing.
 */
async function loadFgRiskContext(
  db: D1Database,
  slotDate: string,
  productCodes: string[],
  customerIds: string[],
): Promise<{
  unitsByProduct: Map<string, number>;
  minutesByProduct: Map<string, number>;
  medianMinutes: number;
  caseHitsByProduct: Map<string, number>;
  ourFaultByProduct: Map<string, number>;
  caseHitsByCustomer: Map<string, number>;
}> {
  const unitsByProduct = new Map<string, number>();
  const minutesByProduct = new Map<string, number>();
  const caseHitsByProduct = new Map<string, number>();
  const ourFaultByProduct = new Map<string, number>();
  const caseHitsByCustomer = new Map<string, number>();
  let medianMinutes = 0;

  // --- rarity: how often do we actually build this? Counted, never a list.
  if (productCodes.length) {
    try {
      const ph = productCodes.map(() => "?").join(",");
      const since = daysBefore(slotDate, FG_RARITY_WINDOW_DAYS);
      const res = await db
        .prepare(
          `SELECT productCode AS "productCode", COUNT(*) AS "n"
             FROM fg_units
            WHERE productCode IN (${ph})
              AND COALESCE(mfdDate, packedAt) >= ?
            GROUP BY productCode`,
        )
        .bind(...productCodes, since)
        .all<{ productCode: string | null; n: number }>();
      for (const r of res.results ?? []) {
        unitsByProduct.set(upperKey(r.productCode), Number(r.n) || 0);
      }
    } catch (err) {
      console.warn("[qc-pending] FG rarity lookup failed — rarity will not weight this draw", err);
    }
  }

  // --- workmanship: the factory's own statement of how much hand work a model
  // takes. The whole active catalogue, because the yardstick is the MEDIAN and
  // a median over just today's units says nobody is heavy.
  try {
    const res = await db
      .prepare(
        `SELECT productCode AS "productCode", MAX(totalMinutes) AS "totalMinutes"
           FROM bom_versions
          WHERE status = 'ACTIVE' AND totalMinutes > 0 AND productCode IS NOT NULL
          GROUP BY productCode`,
      )
      .all<{ productCode: string | null; totalMinutes: number }>();
    const all: number[] = [];
    for (const r of res.results ?? []) {
      const m = Number(r.totalMinutes) || 0;
      if (m <= 0) continue;
      minutesByProduct.set(upperKey(r.productCode), m);
      all.push(m);
    }
    if (all.length) {
      all.sort((a, b) => a - b);
      medianMinutes = all[Math.floor(all.length / 2)];
    }
  } catch (err) {
    console.warn("[qc-pending] FG BOM-minutes lookup failed — workmanship will not weight this draw", err);
  }

  // --- prior complaint: the strongest signal. Two shapes, because a case can
  // be recorded with a repair order (which names the defective product line) or
  // logged against a sales order with no repair order at all. Missing either
  // one silently loses exactly the complaints nobody followed up.
  const caseSince = daysBefore(slotDate, FG_SERVICE_CASE_WINDOW_DAYS);
  const noteHit = (row: ServiceCaseHitRow) => {
    const pc = upperKey(row.productCode);
    if (pc) {
      caseHitsByProduct.set(pc, (caseHitsByProduct.get(pc) ?? 0) + 1);
      if (OUR_FAULT_ROOT_CAUSES.has(upperKey(row.rootCauseCategory))) {
        ourFaultByProduct.set(pc, (ourFaultByProduct.get(pc) ?? 0) + 1);
      }
    }
    const cid = String(row.customerId ?? "").trim();
    if (cid) caseHitsByCustomer.set(cid, (caseHitsByCustomer.get(cid) ?? 0) + 1);
  };

  try {
    const res = await db
      .prepare(
        `SELECT sol.productCode AS "productCode",
                sc.customerId AS "customerId",
                sc.rootCauseCategory AS "rootCauseCategory"
           FROM service_cases sc
           LEFT JOIN service_orders so ON so.caseId = sc.id
           LEFT JOIN service_order_lines sol ON sol.serviceOrderId = so.id
          WHERE sc.status <> 'CANCELLED' AND sc.createdAt >= ?`,
      )
      .bind(caseSince)
      .all<ServiceCaseHitRow>();
    for (const r of res.results ?? []) noteHit(r);
  } catch (err) {
    console.warn("[qc-pending] FG service-case lookup (repair lines) failed", err);
  }

  try {
    const res = await db
      .prepare(
        `SELECT soi.productCode AS "productCode",
                sc.customerId AS "customerId",
                sc.rootCauseCategory AS "rootCauseCategory"
           FROM service_cases sc
           INNER JOIN sales_order_items soi ON soi.salesOrderId = sc.sourceId
          WHERE sc.sourceType = 'SO'
            AND sc.status <> 'CANCELLED'
            AND sc.createdAt >= ?`,
      )
      .bind(caseSince)
      .all<ServiceCaseHitRow>();
    // Customer hits are already counted by the query above for any case that
    // has a repair order, so only the PRODUCT side is folded in here.
    for (const r of res.results ?? []) {
      const pc = upperKey(r.productCode);
      if (!pc) continue;
      caseHitsByProduct.set(pc, (caseHitsByProduct.get(pc) ?? 0) + 1);
      if (OUR_FAULT_ROOT_CAUSES.has(upperKey(r.rootCauseCategory))) {
        ourFaultByProduct.set(pc, (ourFaultByProduct.get(pc) ?? 0) + 1);
      }
    }
  } catch (err) {
    console.warn("[qc-pending] FG service-case lookup (source orders) failed", err);
  }

  void customerIds; // bounded by the case window rather than by the id list.
  return {
    unitsByProduct,
    minutesByProduct,
    medianMinutes,
    caseHitsByProduct,
    ourFaultByProduct,
    caseHitsByCustomer,
  };
}

export async function generateFgSamples(
  db: D1Database,
  slotIso: string,
  slotDate: string,
  templates: TemplateRow[],
  tplItems: TemplateItemRow[],
  existingBySlotTemplate: Map<string, number>,
  nextInspectionNo: () => string,
): Promise<{
  stmts: D1PreparedStatement[];
  created: number;
  skipped: number;
  units: number;
  unresolved: number;
  priorComplaintDraws: number;
}> {
  const empty = {
    stmts: [] as D1PreparedStatement[],
    created: 0,
    skipped: 0,
    units: 0,
    unresolved: 0,
    priorComplaintDraws: 0,
  };
  const fgTemplates = templates.filter((t) => t.stage === "FG");
  if (fgTemplates.length === 0) return empty;

  let units: FgUnitRow[];
  try {
    const res = await db
      .prepare(
        `SELECT fgu.id AS "unitId",
                fgu.unitSerial AS "unitSerial",
                fgu.soId AS "soId",
                fgu.soNo AS "soNo",
                fgu.soLineNo AS "soLineNo",
                fgu.productCode AS "productCode",
                fgu.productName AS "productName",
                fgu.unitNo AS "unitNo",
                fgu.totalUnits AS "totalUnits",
                fgu.customerName AS "customerName",
                fgu.customerHub AS "customerHub",
                soi.itemCategory AS "itemCategory",
                soi.productCode AS "soProductCode",
                soi.sizeCode AS "sizeCode",
                soi.sizeLabel AS "sizeLabel",
                soi.fabricCode AS "fabricCode",
                soi.quantity AS "quantity",
                soi.specialOrder AS "specialOrder",
                soi.legHeightInches AS "legHeightInches",
                soi.divanHeightInches AS "divanHeightInches",
                soi.notes AS "soLineNotes",
                so.customerId AS "customerId"
           FROM fg_units fgu
           LEFT JOIN sales_order_items soi
                  ON soi.salesOrderId = fgu.soId AND soi.lineNo = fgu.soLineNo
           LEFT JOIN sales_orders so ON so.id = fgu.soId
          WHERE fgu.mfdDate LIKE ? OR fgu.packedAt LIKE ?
          ORDER BY fgu.id`,
      )
      .bind(`${slotDate}%`, `${slotDate}%`)
      .all<FgUnitRow>();
    units = res.results ?? [];
  } catch (err) {
    console.error("[qc-pending] FG unit scan failed — no FG slots this run", {
      slotDate,
      err: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
  if (units.length === 0) return empty;

  // Units already handed to an inspector today (either slot) are not drawn
  // again — that, plus the per-slot target, is what makes a re-run a no-op.
  let inspectedUnitIds = new Set<string>();
  try {
    const done = await db
      .prepare(
        `SELECT source_fg_unit_id AS "unitId"
           FROM qc_inspections
          WHERE source_fg_unit_id IS NOT NULL AND inspectionDate = ?`,
      )
      .bind(slotDate)
      .all<{ unitId: string }>();
    inspectedUnitIds = new Set((done.results ?? []).map((r) => r.unitId).filter(Boolean));
  } catch (err) {
    console.warn("[qc-pending] FG already-sampled lookup failed", err);
  }

  // Risk context for the whole day's pool, gathered once. Bounded queries, each
  // caught on its own, so a missing signal weakens the ranking rather than
  // stopping the draw.
  const risk = await loadFgRiskContext(
    db,
    slotDate,
    [...new Set(units.map((u) => u.soProductCode ?? u.productCode).filter((c): c is string => !!c))],
    [...new Set(units.map((u) => u.customerId).filter((c): c is string => !!c))],
  );

  const scoreOf = (u: FgUnitRow): FgRiskScore => {
    const pc = upperKey(u.soProductCode ?? u.productCode);
    return scoreFgUnit({
      unitsOfProductCode: risk.unitsByProduct.get(pc) ?? null,
      bomTotalMinutes: risk.minutesByProduct.get(pc) ?? null,
      medianBomMinutes: risk.medianMinutes || null,
      specialOrder: u.specialOrder,
      lineNotes: u.soLineNotes,
      serviceCaseProductHits: risk.caseHitsByProduct.get(pc) ?? 0,
      serviceCaseProductOurFaultHits: risk.ourFaultByProduct.get(pc) ?? 0,
      serviceCaseCustomerHits: u.customerId ? (risk.caseHitsByCustomer.get(u.customerId) ?? 0) : 0,
    });
  };

  const stmts: D1PreparedStatement[] = [];
  let created = 0;
  let skipped = 0;
  let unresolved = 0;
  let priorComplaintDraws = 0;

  for (const tpl of fgTemplates) {
    const forThisCategory = units.filter(
      (u) => String(u.itemCategory ?? "").toUpperCase() === String(tpl.itemCategory ?? "").toUpperCase(),
    );
    if (forThisCategory.length === 0) continue;

    const target = fgSampleTarget(forThisCategory.length);
    const already = existingBySlotTemplate.get(`${slotIso}|${tpl.id}`) ?? 0;
    const want = Math.max(0, target - already);
    if (want === 0) {
      skipped += target;
      continue;
    }

    // HIGHEST RISK FIRST. The tie-break is the unit id rather than anything
    // random, so re-running a slot re-derives the same ranking — an inspector
    // must not be handed a different unit because the cron fired twice.
    const pool = forThisCategory
      .filter((u) => !inspectedUnitIds.has(u.unitId))
      .map((u) => ({ unit: u, risk: scoreOf(u) }))
      .sort((a, b) => b.risk.score - a.risk.score || a.unit.unitId.localeCompare(b.unit.unitId));

    for (const { unit, risk: unitRisk } of pool.slice(0, want)) {
      inspectedUnitIds.add(unit.unitId);
      if (unitRisk.reasons.some((r) => r.code.startsWith("SERVICE_CASE"))) priorComplaintDraws++;
      const label = [unit.unitSerial || unit.unitId, unit.soNo, unit.productCode]
        .filter(Boolean)
        .join(" · ");
      stmts.push(
        ...buildInspectionStatements(
          db,
          {
            tpl,
            subjectType: "FG_BATCH",
            subjectId: unit.unitId,
            subjectLabel: label,
            sourceFgUnitId: unit.unitId,
            // Frozen at generation time on purpose: if the SO is edited after
            // the unit was built, the inspector must still be comparing against
            // what production was told to make.
            soSpec: {
              soId: unit.soId,
              soNo: unit.soNo,
              soLineNo: unit.soLineNo,
              productCode: unit.soProductCode ?? unit.productCode,
              productName: unit.productName,
              sizeCode: unit.sizeCode,
              sizeLabel: unit.sizeLabel,
              fabricCode: unit.fabricCode,
              quantity: unit.quantity,
              legHeightInches: unit.legHeightInches,
              divanHeightInches: unit.divanHeightInches,
              specialOrder: unit.specialOrder,
              lineNotes: unit.soLineNotes,
              customerName: unit.customerName,
              customerHub: unit.customerHub,
              unitNo: unit.unitNo,
              totalUnits: unit.totalUnits,
            },
            // WHY this unit and not the one next to it. Frozen at draw time,
            // because "you have this sofa because its product code is on two
            // open complaints" and "you have it because we build one a year"
            // are different jobs, and an inspector not told which is doing
            // neither.
            sampleReason: {
              score: unitRisk.score,
              summary: drawReasonSummary(unitRisk),
              reasons: unitRisk.reasons,
            },
          },
          tplItems,
          slotIso,
          slotDate,
          nextInspectionNo(),
        ),
      );
      created++;
    }
  }

  unresolved = units.filter((u) => !u.itemCategory).length;
  return {
    stmts,
    created,
    skipped,
    units: units.length,
    unresolved,
    // How many of the units drawn today were drawn BECAUSE of a prior
    // complaint. This is the number that says whether the loop is closing;
    // "fgCreated 3" alone cannot.
    priorComplaintDraws,
  };
}

export type GenerateResult = {
  created: number;
  skipped: number;
  skippedNoActivity: number;
  rmCreated: number;
  /** Receipts folded into an inspection that was already open for that day. */
  rmAttached: number;
  rmReceipts: number;
  rmNoTemplate: number;
  /** STORED — the daily check on material actually drawn for production. */
  storedCreated: number;
  storedBatchesIssued: number;
  /** Age of the oldest batch drawn today, in days. "created 0" vs "nothing old". */
  storedOldestDays: number;
  fgCreated: number;
  fgUnits: number;
  fgUnresolved: number;
  /** Of the units drawn, how many were drawn because of a PRIOR COMPLAINT. */
  fgPriorComplaintDraws: number;
};

/**
 * Generate this slot's PENDING inspections across all three stages.
 *
 * WIP is per (template × slot) and gated on the department working; RM is per
 * (receipt × material family); FG is a sampled share of the units produced.
 * Every one of them snapshots the template's items into the row so a completed
 * inspection stays readable after the template is edited.
 *
 * `created` / `skipped` / `skippedNoActivity` are TOTALS across the three
 * stages (the UI and the cron have read those three since 2026-08-07); the
 * per-stage numbers are additive detail. "created 0" must always be legible as
 * a fact about the factory, not as a cron that failed — which is why
 * rmReceipts, fgUnits and rmNoTemplate are reported too.
 */
export async function generatePendingForSlot(
  db: D1Database,
  slotIso: string,
): Promise<GenerateResult> {
  // Awaited BEFORE the first write: a migration file alone is inert.
  await ensureQcGenerationSchema(db);

  const [tplRes, tplItemRes, existingRes, nextInspectionNo] = await Promise.all([
    db.prepare("SELECT * FROM qc_templates WHERE active = 1").all<TemplateRow>(),
    db.prepare("SELECT * FROM qc_template_items").all<TemplateItemRow>(),
    db
      .prepare("SELECT templateId FROM qc_inspections WHERE scheduledSlotAt = ?")
      .bind(slotIso)
      .all<{ templateId: string }>(),
    // Read the number base ONCE, before the loop — see inspectionNoAllocator.
    inspectionNoAllocator(db),
  ]);

  const templates = tplRes.results ?? [];
  const tplItems = tplItemRes.results ?? [];
  const existingBySlotTemplate = new Map<string, number>();
  for (const r of existingRes.results ?? []) {
    const key = `${slotIso}|${r.templateId}`;
    existingBySlotTemplate.set(key, (existingBySlotTemplate.get(key) ?? 0) + 1);
  }

  const stmts: D1PreparedStatement[] = [];
  const slotDate = slotIso.split("T")[0];
  let created = 0;
  let skipped = 0;
  let skippedNoActivity = 0;

  // --- WIP: one slot per template per run, gated on the department working ---
  // One probe per (stage, deptCode) rather than one per template — several
  // templates commonly share a department.
  const activityCache = new Map<string, boolean>();

  for (const tpl of templates) {
    if (tpl.stage !== "WIP") continue;
    if ((existingBySlotTemplate.get(`${slotIso}|${tpl.id}`) ?? 0) > 0) {
      skipped++;
      continue;
    }
    const activityKey = `${tpl.stage}|${tpl.deptCode}`;
    let active = activityCache.get(activityKey);
    if (active === undefined) {
      active = await stageHadActivity(db, tpl.stage, tpl.deptCode, slotDate);
      activityCache.set(activityKey, active);
    }
    if (!active) {
      skippedNoActivity++;
      continue;
    }
    stmts.push(
      ...buildInspectionStatements(db, { tpl }, tplItems, slotIso, slotDate, nextInspectionNo()),
    );
    created++;
  }

  // --- RM: per receipt DAY × supplier × material family ------------------------
  const rm = await generateRmForGrns(db, slotIso, slotDate, templates, tplItems, nextInspectionNo);
  stmts.push(...rm.stmts);
  created += rm.created;
  skipped += rm.skipped;

  // --- STORED: the material actually drawn for production today ---------------
  const stored = await generateStoredRmChecks(db, slotIso, slotDate, templates, tplItems, nextInspectionNo);
  stmts.push(...stored.stmts);
  created += stored.created;
  skipped += stored.skipped;

  // --- FG: sampled share of what was produced ---------------------------------
  const fg = await generateFgSamples(
    db,
    slotIso,
    slotDate,
    templates,
    tplItems,
    existingBySlotTemplate,
    nextInspectionNo,
  );
  stmts.push(...fg.stmts);
  created += fg.created;
  skipped += fg.skipped;

  if (stmts.length) await db.batch(stmts);
  return {
    created,
    skipped,
    skippedNoActivity,
    rmCreated: rm.created,
    rmAttached: rm.attached,
    rmReceipts: rm.receipts,
    rmNoTemplate: rm.noTemplate,
    storedCreated: stored.created,
    storedBatchesIssued: stored.batchesIssued,
    storedOldestDays: stored.oldestDays,
    fgCreated: fg.created,
    fgUnits: fg.units,
    fgUnresolved: fg.unresolved,
    fgPriorComplaintDraws: fg.priorComplaintDraws,
  };
}

// --- routes ---------------------------------------------------------------

// GET /api/qc-pending — list PENDING + IN_PROGRESS, optionally filtered.
app.get("/", async (c) => {
  const slot = c.req.query("slot");
  const stage = c.req.query("stage");
  const deptCode = c.req.query("deptCode");
  const includeSkipped = c.req.query("includeSkipped") === "1";

  const clauses: string[] = [
    includeSkipped
      ? "status IN ('PENDING','IN_PROGRESS','SKIPPED')"
      : "status IN ('PENDING','IN_PROGRESS')",
  ];
  const params: (string | number)[] = [];
  if (slot) {
    clauses.push("scheduledSlotAt = ?");
    params.push(slot);
  }
  if (stage) {
    clauses.push("stage = ?");
    params.push(stage);
  }
  if (deptCode) {
    clauses.push("department = ?");
    params.push(deptCode);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;

  const inspRes = await c.var.DB
    .prepare(`SELECT * FROM qc_inspections ${where} ORDER BY scheduledSlotAt DESC, department, stage`)
    .bind(...params)
    .all<InspectionRow>();
  const inspections = inspRes.results ?? [];

  let itemsResults: InspectionItemRow[] = [];
  if (inspections.length > 0) {
    const placeholders = inspections.map(() => "?").join(",");
    const itemRes = await c.var.DB
      .prepare(`SELECT * FROM qc_inspection_items WHERE inspectionId IN (${placeholders}) ORDER BY sequence`)
      .bind(...inspections.map((i) => i.id))
      .all<InspectionItemRow>();
    itemsResults = itemRes.results ?? [];
  }

  const data = inspections.map((r) => rowToInspection(r, itemsResults));
  return c.json({ success: true, data, total: data.length });
});

// POST /api/qc-pending/trigger — cron entry.
app.post("/trigger", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "create");
  if (denied) return denied;
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[qc-pending/trigger] CRON_SECRET unset or too short — refusing");
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }

  let slotIso: string;
  try {
    const body = c.req.header("content-length") ? await c.req.json().catch(() => ({})) : {};
    slotIso = (body && typeof body === "object" && "slot" in body && typeof (body as Record<string, unknown>).slot === "string")
      ? ((body as Record<string, unknown>).slot as string)
      : currentSlotIso();
  } catch {
    slotIso = currentSlotIso();
  }
  try {
    const result = await generatePendingForSlot(c.var.DB, slotIso);
    return c.json({ ok: true, slotIso, ...result });
  } catch (err) {
    console.error("[qc-pending/trigger] error:", err);
    return c.json({ ok: false, error: "trigger failed" }, 500);
  }
});

// POST /api/qc-pending/generate-now — manual trigger from UI (auth-gated by global authMiddleware)
app.post("/generate-now", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json().catch(() => ({}));
    const slotIso =
      body && typeof body === "object" && "slot" in body && typeof (body as Record<string, unknown>).slot === "string"
        ? ((body as Record<string, unknown>).slot as string)
        : currentSlotIso();
    const result = await generatePendingForSlot(c.var.DB, slotIso);
    return c.json({ success: true, slotIso, ...result });
  } catch (err) {
    console.error("[qc-pending/generate-now] error:", err);
    return c.json({ success: false, error: "failed to generate" }, 500);
  }
});

// POST /api/qc-pending/:id/start — flip PENDING → IN_PROGRESS, attach inspector.
app.post("/:id/start", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "create");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB
    .prepare("SELECT * FROM qc_inspections WHERE id = ?")
    .bind(id)
    .first<InspectionRow>();
  if (!existing) return c.json({ success: false, error: "Inspection not found" }, 404);
  if (existing.status !== "PENDING" && existing.status !== "IN_PROGRESS") {
    return c.json({ success: false, error: `Inspection is ${existing.status}, cannot start` }, 409);
  }
  try {
    const body = await c.req.json().catch(() => ({}));
    const inspectorId = (body as Record<string, unknown>).inspectorId as string | undefined;
    const inspectorName = (body as Record<string, unknown>).inspectorName as string | undefined;
    await c.var.DB
      .prepare("UPDATE qc_inspections SET status = 'IN_PROGRESS', inspectorId = ?, inspectorName = ? WHERE id = ?")
      .bind(inspectorId ?? existing.inspectorId ?? null, inspectorName ?? existing.inspectorName ?? null, id)
      .run();
    return c.json({ success: true, data: { id, status: "IN_PROGRESS" } });
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : "Invalid body" }, 400);
  }
});

// POST /api/qc-pending/:id/skip — mark SKIPPED with reason.
app.post("/:id/skip", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "create");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB
    .prepare("SELECT * FROM qc_inspections WHERE id = ?")
    .bind(id)
    .first<InspectionRow>();
  if (!existing) return c.json({ success: false, error: "Inspection not found" }, 404);
  if (existing.status === "COMPLETED" || existing.status === "SKIPPED") {
    return c.json({ success: false, error: `Already ${existing.status}` }, 409);
  }
  try {
    const body = await c.req.json().catch(() => ({}));
    const reason = String((body as Record<string, unknown>).reason ?? "").trim() || "No production at this stage today";
    const now = new Date().toISOString();
    await c.var.DB
      .prepare("UPDATE qc_inspections SET status = 'SKIPPED', skipReason = ?, completedAt = ? WHERE id = ?")
      .bind(reason, now, id)
      .run();
    return c.json({ success: true, data: { id, status: "SKIPPED", skipReason: reason } });
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : "Invalid body" }, 400);
  }
});

// --- shared completion core ------------------------------------------------
//
// Submitting an inspection is NOT just a status flip — it writes the per-item
// results, the header, a qc_tag + qc_defect per FAIL, and (WIP + JOB_CARD +
// FAIL) resets the job card, clears its piece_pics and recomputes the parent
// PO. Two surfaces now submit inspections: the desktop ERP page and the worker
// phone (POST /api/worker/qc/:id/complete). They MUST NOT each own a copy of
// that side-effect list — the phone silently skipping the piece_pics clear
// would resurrect a QC-blocked card on the next scan (BUG-2026-06-08). So the
// whole thing lives here once and both routes call it. Each surface keeps its
// OWN authorization: this function assumes the caller already decided they may
// submit THIS inspection.
export type CompleteInspectionInput = {
  subjectType: SubjectType;
  subjectId: string;
  subjectLabel?: string;
  subjectCode?: string;
  items: Array<{
    id: string;
    result: "PASS" | "FAIL" | "NA";
    notes?: string;
    photoUrl?: string;
  }>;
  overallNotes?: string;
  inspectorId?: string | null;
  inspectorName?: string | null;
};

// ---------------------------------------------------------------------------
// The photo on a check item.
//
// Owner 2026-08-08: "全部东西都要有照片、有记录。要写什么东西，都要有记录."
// `qc_inspection_items.photoUrl` had been plumbed end to end since the rebuild
// — written here, echoed by rowToInspection, forwarded by quality.tsx — and
// there was NO uploader on either surface, so the column was always null. A
// field that cannot be reached is not a record.
//
// Storage follows the path the repo already uses for a phone-captured photo:
// a compressed JPEG data URL in a TEXT column, exactly like
// `service_cases.issue_photos` and `worker_issues.photoDataUrl`. It is NOT
// /api/files: that route is `requirePermission(c, "files", "create")` behind
// the session cookie, and the worker portal authenticates with X-Worker-Token,
// so the phone — the surface that matters here, because the inspector is
// standing at the bench with the defect in front of them — would get a 401.
//
// ~2.2 MB decoded. `compressImage(file, { maxDim: 1280, quality: 0.7 })`
// lands around 150 KB, so this is a guard against a client that skipped the
// compressor, not a working limit.
const MAX_PHOTO_CHARS = 3_000_000;

function photoProblem(v: string): string | null {
  // An already-hosted URL is accepted so a future move to /api/files (for the
  // desktop, which CAN reach it) does not need this core changed again.
  if (/^https?:\/\//i.test(v)) return null;
  if (!/^data:image\/(png|jpe?g|webp|heic|heif);base64,[A-Za-z0-9+/=\s]+$/i.test(v)) {
    return "the attachment is not an image";
  }
  if (v.length > MAX_PHOTO_CHARS) {
    return "the photo is too large — retake it rather than uploading the original";
  }
  return null;
}

export type CompleteInspectionResult =
  | {
      ok: true;
      data: ReturnType<typeof rowToInspection>;
      sideEffects: { tagsCreated: number; jobCardReset: boolean };
    }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

export async function completeInspection(
  db: D1Database,
  id: string,
  input: CompleteInspectionInput,
): Promise<CompleteInspectionResult> {
  const existing = await db
    .prepare("SELECT * FROM qc_inspections WHERE id = ?")
    .bind(id)
    .first<InspectionRow>();
  if (!existing) return { ok: false, status: 404, error: "Inspection not found" };
  if (existing.status === "COMPLETED" || existing.status === "SKIPPED") {
    return { ok: false, status: 409, error: `Already ${existing.status}` };
  }

  const subjectType = input.subjectType;
  const subjectId = input.subjectId;
  const subjectLabel = input.subjectLabel ?? "";
  const subjectCode = input.subjectCode ?? "";
  const items = Array.isArray(input.items) ? input.items : [];
  const overallNotes = input.overallNotes ?? "";
  const inspectorId = input.inspectorId ?? existing.inspectorId ?? null;
  const inspectorName = input.inspectorName ?? existing.inspectorName ?? null;

  if (!subjectType) return { ok: false, status: 400, error: "subjectType is required" };
  if (!subjectId) return { ok: false, status: 400, error: "subjectId is required" };
  if (items.length === 0) return { ok: false, status: 400, error: "items array is required" };

  // Load existing per-item rows so we can map by id and detect missing
  const itemRowsRes = await db
    .prepare("SELECT * FROM qc_inspection_items WHERE inspectionId = ?")
    .bind(id)
    .all<InspectionItemRow>();
  const itemRows = itemRowsRes.results ?? [];
  const itemRowsById = new Map(itemRows.map((r) => [r.id, r]));

  // Validate every mandatory item has a result
  for (const ir of itemRows) {
    if (ir.isMandatory === 1) {
      const supplied = items.find((x) => x.id === ir.id);
      if (!supplied || !supplied.result) {
        return {
          ok: false,
          status: 400,
          error: `Item "${ir.itemName}" is mandatory and must be PASS / FAIL / NA`,
        };
      }
    }
  }

  // A FAIL with no words is not a finding, it is a shrug — and it is the ONE
  // thing a reviewer needs weeks later ("what actually failed?"). Enforced
  // server-side so neither surface can skip it.
  for (const it of items) {
    if (it.result === "FAIL" && !String(it.notes ?? "").trim()) {
      const row = itemRowsById.get(it.id);
      return {
        ok: false,
        status: 400,
        error: `"${row?.itemName ?? it.id}" is marked FAIL — say what failed`,
      };
    }
  }

  // …and a FAIL with no PICTURE is an argument three days later. The words say
  // what the inspector believed; the photo is the only part anyone else can
  // still check once the unit has been reworked or shipped. Required on FAIL,
  // optional on PASS — a passing item is the normal state, and demanding 251
  // photographs of things that were fine is how the whole requirement gets
  // quietly ignored. Enforced HERE, in the shared core, because the phone
  // posts to the same completion path as the desk (see the note above
  // completeInspection) and a UI-only rule is not a rule.
  for (const it of items) {
    const row = itemRowsById.get(it.id);
    const name = row?.itemName ?? it.id;
    const photo = String(it.photoUrl ?? "").trim();
    if (it.result === "FAIL" && !photo) {
      return {
        ok: false,
        status: 400,
        error: `"${name}" is marked FAIL — attach a photo of what failed`,
      };
    }
    if (photo) {
      const problem = photoProblem(photo);
      if (problem) {
        return { ok: false, status: 400, error: `"${name}": ${problem}` };
      }
    }
  }

  const overallFail = items.some((it) => it.result === "FAIL");
  const overallResult = overallFail ? "FAIL" : "PASS";
  const now = new Date().toISOString();

  const stmts: D1PreparedStatement[] = [];

  // 1. Update each per-item row
  for (const it of items) {
    const row = itemRowsById.get(it.id);
    if (!row) continue;
    stmts.push(
      db
        .prepare(
          `UPDATE qc_inspection_items SET result = ?, notes = ?, photoUrl = ? WHERE id = ?`,
        )
        .bind(it.result, it.notes ?? null, String(it.photoUrl ?? "").trim() || null, it.id),
    );
  }

  // 2. Update the inspection header
  stmts.push(
    db
      .prepare(
        `UPDATE qc_inspections SET
           status = 'COMPLETED',
           result = ?,
           subjectType = ?,
           subjectId = ?,
           subjectLabel = ?,
           notes = ?,
           inspectorId = ?,
           inspectorName = ?,
           completedAt = ?
         WHERE id = ?`,
      )
      .bind(
        overallResult,
        subjectType,
        subjectId,
        subjectLabel,
        overallNotes,
        inspectorId,
        inspectorName,
        now,
        id,
      ),
  );

  // 3. For each FAIL item, create a qc_tag + qc_defect row.
  // The tag is the new soft-marker model; the defect row is kept in sync
  // so the old defect-tracker UI / reports still see fail data.
  // (qc_tags stay WRITE-ONLY here — Phase 2 surfacing in Inventory / as DO
  // warnings was descoped by the owner. Don't re-surface them.)
  const failItems = items.filter((it) => it.result === "FAIL");
  for (const it of failItems) {
    const row = itemRowsById.get(it.id);
    if (!row) continue;
    const tagId = genTagId();
    stmts.push(
      db
        .prepare(
          `INSERT INTO qc_tags (
             id, subjectType, subjectId, subjectCode, subjectLabel,
             inspectionId, reason, severity, status, taggedBy, taggedByName, taggedAt
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
        )
        .bind(
          tagId,
          subjectType,
          subjectId,
          subjectCode || null,
          subjectLabel || null,
          id,
          `${row.itemName}${it.notes ? ` — ${it.notes}` : ""}`,
          row.severity,
          inspectorId,
          inspectorName,
          now,
        ),
    );
    // Mirror into qc_defects so legacy views still see fail data.
    stmts.push(
      db
        .prepare(
          `INSERT INTO qc_defects (id, qcInspectionId, type, severity, description, actionTaken)
           VALUES (?, ?, 'OTHER', ?, ?, 'REWORK')`,
        )
        .bind(genDefectId(), id, row.severity, `${row.itemName}: ${it.notes ?? "(no detail)"}`),
    );
  }

  // 4. WIP-stage + JOB_CARD subject + FAIL → reset the Job Card.
  let jcResetParentPoId: string | null = null;
  if (overallFail && existing.stage === "WIP" && subjectType === "JOB_CARD") {
    stmts.push(
      db
        .prepare(
          `UPDATE job_cards SET
             status = 'BLOCKED',
             completedDate = NULL,
             wipQty = 0,
             actualMinutes = NULL,
             productionTimeMinutes = 0
           WHERE id = ?`,
        )
        .bind(subjectId),
    );
    // BUG-2026-06-08: clearing the JC's completion alone leaves the per-piece
    // scan stamps (piece_pics) in place. A later scan re-derives "all pieces
    // done" from those stamps and re-completes the card (the same vector as
    // the production-page remove fix, BUG-2026-06-08-002), silently un-doing
    // the QC block. Clear this JC's piece_pics so a re-scan after rework
    // starts fresh instead of resurrecting the old completion.
    stmts.push(
      db
        .prepare(
          `UPDATE piece_pics SET
             pic1Id = NULL, pic1Name = NULL,
             pic2Id = NULL, pic2Name = NULL,
             completedAt = NULL, lastScanAt = NULL, boundStickerKey = NULL
           WHERE jobCardId = ?`,
        )
        .bind(subjectId),
    );
    // Stash the parent PO id so we can recompute its status/progress
    // after the batch commits — flipping a JC to BLOCKED can drop the
    // parent PO from COMPLETED (extremely rare but possible) or simply
    // refresh the progress %. Fetched outside the batch so the read
    // happens before the UPDATE lands.
    try {
      const jcRow = await db
        .prepare(`SELECT productionOrderId FROM job_cards WHERE id = ?`)
        .bind(subjectId)
        .first<{ productionOrderId: string }>();
      jcResetParentPoId = jcRow?.productionOrderId ?? null;
    } catch (err) {
      console.error("[qc-pending] parent PO lookup failed", {
        jcId: subjectId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await db.batch(stmts);

  // After the batch commits, recompute the parent PO's status/progress
  // off the fresh JC view. Defensive — a recompute miss must not void
  // the inspection submission that already committed.
  if (jcResetParentPoId) {
    try {
      await recomputePoStatusAndProgress(db, jcResetParentPoId);
    } catch (err) {
      console.error("[qc-pending] recomputePoStatusAndProgress failed", {
        poId: jcResetParentPoId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Reload + return
  const [updated, updatedItems] = await Promise.all([
    db.prepare("SELECT * FROM qc_inspections WHERE id = ?").bind(id).first<InspectionRow>(),
    db
      .prepare("SELECT * FROM qc_inspection_items WHERE inspectionId = ? ORDER BY sequence")
      .bind(id)
      .all<InspectionItemRow>(),
  ]);
  if (!updated) return { ok: false, status: 500, error: "Reload failed" };

  return {
    ok: true,
    data: rowToInspection(updated, updatedItems.results ?? []),
    sideEffects: {
      tagsCreated: failItems.length,
      jobCardReset: overallFail && existing.stage === "WIP" && subjectType === "JOB_CARD",
    },
  };
}

// POST /api/qc-pending/:id/complete — submit results + side-effects.
//
// Body: {
//   subjectType: 'RM_BATCH'|'JOB_CARD'|'FG_BATCH'|'RAW_MATERIAL'|'WIP_ITEM',
//   subjectId: string,
//   subjectLabel?: string,
//   subjectCode?: string,
//   items: [{ id: string, result: 'PASS'|'FAIL'|'NA', notes?: string, photoUrl?: string }],
//   overallNotes?: string,
//   inspectorId?: string,
//   inspectorName?: string,
// }
//
// Side-effects on FAIL: see completeInspection above.
app.post("/:id/complete", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "create");
  if (denied) return denied;
  const id = c.req.param("id");

  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const res = await completeInspection(c.var.DB, id, {
      subjectType: body.subjectType as SubjectType,
      subjectId: body.subjectId as string,
      subjectLabel: (body.subjectLabel as string) ?? "",
      subjectCode: (body.subjectCode as string) ?? "",
      items: (Array.isArray(body.items) ? body.items : []) as CompleteInspectionInput["items"],
      overallNotes: (body.overallNotes as string) ?? "",
      inspectorId: (body.inspectorId as string) ?? null,
      inspectorName: (body.inspectorName as string) ?? null,
    });
    if (!res.ok) return c.json({ success: false, error: res.error }, res.status);
    return c.json({ success: true, data: res.data, sideEffects: res.sideEffects });
  } catch (err) {
    console.error("[qc-pending/complete] error:", err);
    return c.json({ success: false, error: err instanceof Error ? err.message : "Invalid body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /api/qc-pending/bulk-skip — retire a backlog of slots that were
// generated by the old blind schedule and were never answerable.
//
// THIS HAS NOT BEEN RUN. It exists so that clearing the 3,009-row backlog is a
// reviewed, recorded operation with a reason attached, instead of somebody
// running UPDATE by hand against prod. Deciding to clear it is the owner's
// call, not an agent's.
//
// Safety posture:
//   • DRY RUN BY DEFAULT. Without `confirm: true` it only COUNTS what it would
//     touch and writes nothing.
//   • `beforeSlotIso` is REQUIRED — there is no "skip everything" call. You
//     name a cut-off and it only touches slots older than it.
//   • `reason` is REQUIRED (>= 10 chars) and is written onto every row, so the
//     history says why these were retired rather than leaving 3,009 silent
//     SKIPPEDs.
//   • Only PENDING / IN_PROGRESS rows move. A COMPLETED or already-SKIPPED
//     inspection is never rewritten.
//   • Gated on qc-inspections:delete — the same permission that cancels a
//     single slot.
//
// Body: { beforeSlotIso: string, reason: string, confirm?: boolean }
// ---------------------------------------------------------------------------
app.post("/bulk-skip", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "delete");
  if (denied) return denied;
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const beforeSlotIso = String(body.beforeSlotIso ?? "").trim();
    const reason = String(body.reason ?? "").trim();
    const confirm = body.confirm === true;

    if (!beforeSlotIso) {
      return c.json({ success: false, error: "beforeSlotIso is required — name a cut-off" }, 400);
    }
    if (reason.length < 10) {
      return c.json(
        { success: false, error: "reason is required and must say something (>= 10 chars)" },
        400,
      );
    }

    const countRow = await c.var.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM qc_inspections
          WHERE status IN ('PENDING','IN_PROGRESS')
            AND scheduledSlotAt < ?`,
      )
      .bind(beforeSlotIso)
      .first<{ n: number }>();
    const matched = Number(countRow?.n ?? 0);

    if (!confirm) {
      return c.json({
        success: true,
        dryRun: true,
        matched,
        message: `${matched} inspection(s) would be marked SKIPPED. Re-send with confirm: true to apply.`,
      });
    }

    const now = new Date().toISOString();
    await c.var.DB
      .prepare(
        `UPDATE qc_inspections
            SET status = 'SKIPPED', skipReason = ?, completedAt = ?
          WHERE status IN ('PENDING','IN_PROGRESS')
            AND scheduledSlotAt < ?`,
      )
      .bind(reason, now, beforeSlotIso)
      .run();

    return c.json({ success: true, dryRun: false, matched, skipped: matched });
  } catch (err) {
    console.error("[qc-pending/bulk-skip] error:", err);
    return c.json({ success: false, error: err instanceof Error ? err.message : "Invalid body" }, 400);
  }
});

// DELETE /api/qc-pending/:id — cancel a PENDING / IN_PROGRESS slot
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB
    .prepare("SELECT * FROM qc_inspections WHERE id = ?")
    .bind(id)
    .first<InspectionRow>();
  if (!existing) return c.json({ success: false, error: "Inspection not found" }, 404);
  if (existing.status !== "PENDING" && existing.status !== "IN_PROGRESS") {
    return c.json({ success: false, error: `Cannot delete ${existing.status} inspection` }, 409);
  }
  await c.var.DB.prepare("DELETE FROM qc_inspections WHERE id = ?").bind(id).run();
  return c.json({ success: true, data: { id, deleted: true } });
});

export default app;
