// ---------------------------------------------------------------------------
// Daily Report — factory process-compliance / SOP-watch.
//
// Sweeps the order → delivery → invoice and procurement chains for records
// that are stuck at a stage longer than they should be, plus reuses the
// existing overdue + efficiency reports. The result is a single "what needs
// attention today" payload rendered as a newspaper-style page (see
// src/pages/daily-report.tsx) and surfaced as a Dashboard summary card.
//
// Endpoint: GET /api/reports/compliance.json (see src/api/routes/reports.ts).
//
// Design notes:
//   - Mirrors collectOverdueData's two-step style: pull headers, then pull the
//     related rows in one IN-list query, aggregate in JS. Datasets here are
//     small (open DOs / SOs / POs are O(hundreds)).
//   - Does NOT filter by orgId — the existing overdue / efficiency reports
//     don't either; staying consistent.
//   - app-level SQL uses camelCase column names; the SupabaseAdapter rewrites
//     them to snake_case at runtime (see src/api/lib/supabase-compat.ts).
//   - Each check is wrapped in its own try/catch returning [] on failure, so
//     one broken query can't 500 the whole report.
// ---------------------------------------------------------------------------

import {
  collectOverdueData,
  type OverdueRow,
} from "./schedule-overdue-report";
import {
  collectEfficiencyData,
  type WorkerSummary,
} from "./efficiency-report";

// D1-compat shape (the SupabaseAdapter installed in worker.ts exposes this).
interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
  };
}

// Thresholds (days). DO stages move daily; a stalled DO older than this is a
// process miss. POs are slower-moving so the bar is two weeks.
const DO_STALE_DAYS = 1;
const PO_STALE_DAYS = 14;
const LOW_EFFICIENCY_THRESHOLD = 60; // workers below this (when present) flagged

// ─── Row interfaces ──────────────────────────────────────────────────────

export interface DoPendingDispatchRow {
  id: string;
  doNo: string;
  customerName: string;
  createdAt: string;
  daysWaiting: number;
}

export interface DoNotDeliveredRow {
  id: string;
  doNo: string;
  customerName: string;
  dispatchedAt: string;
  daysSinceDispatch: number;
}

export interface DoNotInvoicedRow {
  id: string;
  doNo: string;
  customerName: string;
  deliveredAt: string;
  daysSinceDelivered: number;
}

export interface SoNoDoRow {
  id: string;
  companySOId: string;
  customerName: string;
  status: string;
}

export interface SoNoInvoiceRow {
  id: string;
  companySOId: string;
  customerName: string;
  status: string;
}

export interface PoNotReceivedRow {
  id: string;
  poNo: string;
  supplierName: string;
  status: string;
  orderDate: string;
  daysOpen: number;
}

// v2 — production out-of-sequence: a later step is done while an earlier step
// in the SAME (production order, branch) is still unfinished.
export interface ProcessSkipRow {
  productionOrderId: string;
  poNo: string;
  companySOId: string;
  salesOrderId: string;
  productName: string;
  doneDept: string;
  doneDeptCompletedDate: string;
  blockedByDept: string;
  blockedByStatus: string;
}

// v2 — a product step in active production with no standard WIP time set.
export interface MissingWipTimeRow {
  productCode: string;
  productName: string;
  departmentCode: string;
  examplePoNo: string;
}

// v2 — a product in active production with no active BOM template.
export interface IncompleteBomRow {
  productCode: string;
  productName: string;
  reason: string;
}

// v2 — an R&D project that looks stalled (overdue launch, or on hold).
export interface RdStalledRow {
  id: string;
  name: string;
  status: string;
  currentStage: string;
  targetLaunchDate: string;
  daysOverdue: number;
}

export interface ComplianceCounts {
  total: number;
  doPendingDispatch: number;
  doNotDelivered: number;
  doNotInvoiced: number;
  soNoDo: number;
  soNoInvoice: number;
  overdueOrders: number;
  poNotReceived: number;
  lowEfficiencyWorkers: number;
  processSkips: number;
  missingWipTimes: number;
  incompleteBoms: number;
  rdStalled: number;
}

export interface ComplianceGroups {
  doPendingDispatch: DoPendingDispatchRow[];
  doNotDelivered: DoNotDeliveredRow[];
  doNotInvoiced: DoNotInvoicedRow[];
  soNoDo: SoNoDoRow[];
  soNoInvoice: SoNoInvoiceRow[];
  overdueOrders: OverdueRow[];
  poNotReceived: PoNotReceivedRow[];
  lowEfficiencyWorkers: WorkerSummary[];
  processSkips: ProcessSkipRow[];
  missingWipTimes: MissingWipTimeRow[];
  incompleteBoms: IncompleteBomRow[];
  rdStalled: RdStalledRow[];
}

export interface ComplianceData {
  generatedAtIso: string;
  today: string;
  counts: ComplianceCounts;
  groups: ComplianceGroups;
}

// ─── Date helpers (YMD-anchored, UTC midnight) ─────────────────────────────

// Whole-days elapsed between an ISO/Y MD timestamp and todayYmd. Returns 0 if
// the value is missing or in the future.
function daysBetween(fromIso: string | null | undefined, todayYmd: string): number {
  if (!fromIso) return 0;
  const from = new Date(String(fromIso).slice(0, 10) + "T00:00:00Z").getTime();
  const today = new Date(todayYmd + "T00:00:00Z").getTime();
  if (Number.isNaN(from)) return 0;
  return Math.max(0, Math.floor((today - from) / 86400000));
}

// todayYmd minus N days, as an ISO cutoff "YYYY-MM-DDT00:00:00". Anything with
// created_at / dispatchedAt / etc. STRICTLY BEFORE this cutoff is "older than
// N days".
function isoCutoff(todayYmd: string, days: number): string {
  const d = new Date(todayYmd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10) + "T00:00:00";
}

// todayYmd minus N days, as a YYYY-MM-DD string.
function addDaysYmd(todayYmd: string, days: number): string {
  const d = new Date(todayYmd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isEmpty(v: string | null | undefined): boolean {
  return v === null || v === undefined || String(v).trim() === "";
}

// ─── Individual checks ─────────────────────────────────────────────────────

// 1. DOs still sitting in DRAFT (not yet loaded onto a truck) for > 1 day.
async function checkDoPendingDispatch(
  db: DbLike,
  todayYmd: string,
): Promise<DoPendingDispatchRow[]> {
  try {
    const cutoff = isoCutoff(todayYmd, DO_STALE_DAYS);
    const res = await db
      .prepare(
        `SELECT id, doNo, customerName, createdAt
           FROM delivery_orders
          WHERE status = 'DRAFT'
            AND createdAt IS NOT NULL
            AND createdAt <> ''
            AND createdAt < ?
          ORDER BY createdAt ASC`,
      )
      .bind(cutoff)
      .all<{
        id: string;
        doNo: string | null;
        customerName: string | null;
        createdAt: string | null;
      }>();
    return (res.results ?? []).map((r) => ({
      id: r.id,
      doNo: r.doNo ?? "",
      customerName: r.customerName ?? "",
      createdAt: (r.createdAt ?? "").slice(0, 10),
      daysWaiting: daysBetween(r.createdAt, todayYmd),
    }));
  } catch (err) {
    console.error("[compliance] doPendingDispatch failed:", err);
    return [];
  }
}

// 2. DOs loaded/dispatched/in-transit > 1 day ago but never marked delivered.
async function checkDoNotDelivered(
  db: DbLike,
  todayYmd: string,
): Promise<DoNotDeliveredRow[]> {
  try {
    const cutoff = isoCutoff(todayYmd, DO_STALE_DAYS);
    const res = await db
      .prepare(
        `SELECT id, doNo, customerName, dispatchedAt, deliveredAt
           FROM delivery_orders
          WHERE status IN ('LOADED','DISPATCHED','IN_TRANSIT')
            AND dispatchedAt IS NOT NULL
            AND dispatchedAt <> ''
            AND dispatchedAt < ?
          ORDER BY dispatchedAt ASC`,
      )
      .bind(cutoff)
      .all<{
        id: string;
        doNo: string | null;
        customerName: string | null;
        dispatchedAt: string | null;
        deliveredAt: string | null;
      }>();
    return (res.results ?? [])
      .filter((r) => isEmpty(r.deliveredAt))
      .map((r) => ({
        id: r.id,
        doNo: r.doNo ?? "",
        customerName: r.customerName ?? "",
        dispatchedAt: (r.dispatchedAt ?? "").slice(0, 10),
        daysSinceDispatch: daysBetween(r.dispatchedAt, todayYmd),
      }));
  } catch (err) {
    console.error("[compliance] doNotDelivered failed:", err);
    return [];
  }
}

// 3. DOs delivered > 1 day ago with no invoice raised against them.
async function checkDoNotInvoiced(
  db: DbLike,
  todayYmd: string,
): Promise<DoNotInvoicedRow[]> {
  try {
    const cutoff = isoCutoff(todayYmd, DO_STALE_DAYS);
    const res = await db
      .prepare(
        `SELECT id, doNo, customerName, deliveredAt
           FROM delivery_orders
          WHERE status = 'DELIVERED'
            AND deliveredAt IS NOT NULL
            AND deliveredAt <> ''
            AND deliveredAt < ?
          ORDER BY deliveredAt ASC`,
      )
      .bind(cutoff)
      .all<{
        id: string;
        doNo: string | null;
        customerName: string | null;
        deliveredAt: string | null;
      }>();
    const dos = res.results ?? [];
    if (dos.length === 0) return [];

    // Two-step: pull every invoice whose deliveryOrderId is in our DO set, then
    // exclude the DOs that have one.
    const doIds = dos.map((d) => d.id);
    const ph = doIds.map(() => "?").join(",");
    const invRes = await db
      .prepare(
        `SELECT deliveryOrderId FROM invoices
          WHERE deliveryOrderId IN (${ph})
            AND deliveryOrderId IS NOT NULL
            AND deliveryOrderId <> ''`,
      )
      .bind(...doIds)
      .all<{ deliveryOrderId: string | null }>();
    const invoicedDoIds = new Set<string>();
    for (const r of invRes.results ?? []) {
      if (r.deliveryOrderId) invoicedDoIds.add(r.deliveryOrderId);
    }

    return dos
      .filter((d) => !invoicedDoIds.has(d.id))
      .map((d) => ({
        id: d.id,
        doNo: d.doNo ?? "",
        customerName: d.customerName ?? "",
        deliveredAt: (d.deliveredAt ?? "").slice(0, 10),
        daysSinceDelivered: daysBetween(d.deliveredAt, todayYmd),
      }));
  } catch (err) {
    console.error("[compliance] doNotInvoiced failed:", err);
    return [];
  }
}

// 4. Confirmed / ready-to-ship SOs with no delivery order at all. A DO links
//    either via delivery_orders.salesOrderId (single-SO DO) OR via
//    delivery_order_items.salesOrderNo = the SO's companySOId (consolidated
//    DO). Mirrors the reverse lookup in sales-orders.ts GET /:id.
async function checkSoNoDo(
  db: DbLike,
): Promise<SoNoDoRow[]> {
  try {
    const soRes = await db
      .prepare(
        `SELECT id, companySOId, customerName, status
           FROM sales_orders
          WHERE status IN ('CONFIRMED','READY_TO_SHIP')
          ORDER BY companySOId ASC`,
      )
      .bind()
      .all<{
        id: string;
        companySOId: string | null;
        customerName: string | null;
        status: string;
      }>();
    const sos = soRes.results ?? [];
    if (sos.length === 0) return [];

    const soIds = sos.map((s) => s.id);
    const soNos = sos
      .map((s) => s.companySOId)
      .filter((x): x is string => !isEmpty(x));

    // DOs linked by salesOrderId.
    const linkedSoIds = new Set<string>();
    {
      const ph = soIds.map(() => "?").join(",");
      const r = await db
        .prepare(
          `SELECT DISTINCT salesOrderId FROM delivery_orders
            WHERE salesOrderId IN (${ph})
              AND salesOrderId IS NOT NULL
              AND salesOrderId <> ''`,
        )
        .bind(...soIds)
        .all<{ salesOrderId: string | null }>();
      for (const x of r.results ?? []) {
        if (x.salesOrderId) linkedSoIds.add(x.salesOrderId);
      }
    }

    // DOs linked per-item by salesOrderNo = companySOId (consolidated DOs).
    const linkedSoNos = new Set<string>();
    if (soNos.length > 0) {
      const ph = soNos.map(() => "?").join(",");
      const r = await db
        .prepare(
          `SELECT DISTINCT salesOrderNo FROM delivery_order_items
            WHERE salesOrderNo IN (${ph})
              AND salesOrderNo IS NOT NULL
              AND salesOrderNo <> ''`,
        )
        .bind(...soNos)
        .all<{ salesOrderNo: string | null }>();
      for (const x of r.results ?? []) {
        if (x.salesOrderNo) linkedSoNos.add(x.salesOrderNo);
      }
    }

    return sos
      .filter((s) => {
        const byId = linkedSoIds.has(s.id);
        const byNo = !isEmpty(s.companySOId) && linkedSoNos.has(s.companySOId!);
        return !byId && !byNo;
      })
      .map((s) => ({
        id: s.id,
        companySOId: s.companySOId ?? "",
        customerName: s.customerName ?? "",
        status: s.status,
      }));
  } catch (err) {
    console.error("[compliance] soNoDo failed:", err);
    return [];
  }
}

// 5. Delivered / closed SOs with no invoice. v1 matches by invoices.salesOrderId
//    OR by any invoice on one of the SO's own DOs (deliveryOrderId in the SO's
//    DO set). DO set resolved via salesOrderId + consolidated salesOrderNo link.
async function checkSoNoInvoice(
  db: DbLike,
): Promise<SoNoInvoiceRow[]> {
  try {
    const soRes = await db
      .prepare(
        // Only DELIVERED — a delivered order with no invoice is a real billing
        // gap. CLOSED orders are already done/paid; including them flooded the
        // list with linkage false-positives (invoice anchored to the combined
        // DO / lead SO), so they're excluded (Wei Siang 2026-05-29).
        `SELECT id, companySOId, customerName, status
           FROM sales_orders
          WHERE status = 'DELIVERED'
          ORDER BY companySOId ASC`,
      )
      .bind()
      .all<{
        id: string;
        companySOId: string | null;
        customerName: string | null;
        status: string;
      }>();
    const sos = soRes.results ?? [];
    if (sos.length === 0) return [];

    const soIds = sos.map((s) => s.id);

    // Invoices directly anchored to a SO.
    const invoicedSoIds = new Set<string>();
    {
      const ph = soIds.map(() => "?").join(",");
      const r = await db
        .prepare(
          `SELECT DISTINCT salesOrderId FROM invoices
            WHERE salesOrderId IN (${ph})
              AND salesOrderId IS NOT NULL
              AND salesOrderId <> ''`,
        )
        .bind(...soIds)
        .all<{ salesOrderId: string | null }>();
      for (const x of r.results ?? []) {
        if (x.salesOrderId) invoicedSoIds.add(x.salesOrderId);
      }
    }

    // Map each SO → its DO ids (salesOrderId + consolidated salesOrderNo), so
    // we can also count an invoice raised on one of its DOs as "invoiced".
    const soNos = sos
      .map((s) => s.companySOId)
      .filter((x): x is string => !isEmpty(x));
    const doIdToSoId = new Map<string, string>(); // doId → owning soId
    {
      const ph = soIds.map(() => "?").join(",");
      const r = await db
        .prepare(
          `SELECT id, salesOrderId FROM delivery_orders
            WHERE salesOrderId IN (${ph})
              AND salesOrderId IS NOT NULL
              AND salesOrderId <> ''`,
        )
        .bind(...soIds)
        .all<{ id: string; salesOrderId: string | null }>();
      for (const x of r.results ?? []) {
        if (x.salesOrderId) doIdToSoId.set(x.id, x.salesOrderId);
      }
    }
    if (soNos.length > 0) {
      const soIdByNo = new Map<string, string>();
      for (const s of sos) {
        if (!isEmpty(s.companySOId)) soIdByNo.set(s.companySOId!, s.id);
      }
      const ph = soNos.map(() => "?").join(",");
      const r = await db
        .prepare(
          `SELECT DISTINCT deliveryOrderId, salesOrderNo
             FROM delivery_order_items
            WHERE salesOrderNo IN (${ph})
              AND deliveryOrderId IS NOT NULL
              AND deliveryOrderId <> ''`,
        )
        .bind(...soNos)
        .all<{ deliveryOrderId: string | null; salesOrderNo: string | null }>();
      for (const x of r.results ?? []) {
        const owningSo = x.salesOrderNo ? soIdByNo.get(x.salesOrderNo) : undefined;
        if (x.deliveryOrderId && owningSo) doIdToSoId.set(x.deliveryOrderId, owningSo);
      }
    }

    // Pull invoices on those DOs and mark their owning SOs as invoiced.
    const allDoIds = [...doIdToSoId.keys()];
    if (allDoIds.length > 0) {
      const ph = allDoIds.map(() => "?").join(",");
      const r = await db
        .prepare(
          `SELECT DISTINCT deliveryOrderId FROM invoices
            WHERE deliveryOrderId IN (${ph})
              AND deliveryOrderId IS NOT NULL
              AND deliveryOrderId <> ''`,
        )
        .bind(...allDoIds)
        .all<{ deliveryOrderId: string | null }>();
      for (const x of r.results ?? []) {
        const owningSo = x.deliveryOrderId ? doIdToSoId.get(x.deliveryOrderId) : undefined;
        if (owningSo) invoicedSoIds.add(owningSo);
      }
    }

    return sos
      .filter((s) => !invoicedSoIds.has(s.id))
      .map((s) => ({
        id: s.id,
        companySOId: s.companySOId ?? "",
        customerName: s.customerName ?? "",
        status: s.status,
      }));
  } catch (err) {
    console.error("[compliance] soNoInvoice failed:", err);
    return [];
  }
}

// 6. POs open > 14 days that have neither a received GRN nor a purchase invoice.
//    GRN counts as "received" when its status is CONFIRMED or POSTED (DRAFT
//    GRNs haven't booked stock yet).
async function checkPoNotReceived(
  db: DbLike,
  todayYmd: string,
): Promise<PoNotReceivedRow[]> {
  try {
    const cutoff = isoCutoff(todayYmd, PO_STALE_DAYS).slice(0, 10); // orderDate is a date
    const res = await db
      .prepare(
        `SELECT id, poNo, supplierName, status, orderDate
           FROM purchase_orders
          WHERE status NOT IN ('RECEIVED','CLOSED','CANCELLED')
            AND orderDate IS NOT NULL
            AND orderDate <> ''
            AND orderDate < ?
          ORDER BY orderDate ASC`,
      )
      .bind(cutoff)
      .all<{
        id: string;
        poNo: string | null;
        supplierName: string | null;
        status: string;
        orderDate: string | null;
      }>();
    const pos = res.results ?? [];
    if (pos.length === 0) return [];

    const poIds = pos.map((p) => p.id);
    const ph = poIds.map(() => "?").join(",");

    // POs that already have a received GRN.
    const grnPoIds = new Set<string>();
    {
      const r = await db
        .prepare(
          `SELECT DISTINCT poId FROM grns
            WHERE poId IN (${ph})
              AND poId IS NOT NULL
              AND poId <> ''
              AND status IN ('CONFIRMED','POSTED')`,
        )
        .bind(...poIds)
        .all<{ poId: string | null }>();
      for (const x of r.results ?? []) {
        if (x.poId) grnPoIds.add(x.poId);
      }
    }

    // POs that already have a purchase invoice.
    const piPoIds = new Set<string>();
    {
      const r = await db
        .prepare(
          `SELECT DISTINCT purchaseOrderId FROM purchase_invoices
            WHERE purchaseOrderId IN (${ph})
              AND purchaseOrderId IS NOT NULL
              AND purchaseOrderId <> ''`,
        )
        .bind(...poIds)
        .all<{ purchaseOrderId: string | null }>();
      for (const x of r.results ?? []) {
        if (x.purchaseOrderId) piPoIds.add(x.purchaseOrderId);
      }
    }

    return pos
      .filter((p) => !grnPoIds.has(p.id) && !piPoIds.has(p.id))
      .map((p) => ({
        id: p.id,
        poNo: p.poNo ?? "",
        supplierName: p.supplierName ?? "",
        status: p.status,
        orderDate: (p.orderDate ?? "").slice(0, 10),
        daysOpen: daysBetween(p.orderDate, todayYmd),
      }));
  } catch (err) {
    console.error("[compliance] poNotReceived failed:", err);
    return [];
  }
}

// 7. Overdue orders — reuse the existing overdue report verbatim.
async function checkOverdueOrders(
  db: DbLike,
  todayYmd: string,
): Promise<OverdueRow[]> {
  try {
    const report = await collectOverdueData(db, todayYmd);
    return report.rows;
  } catch (err) {
    console.error("[compliance] overdueOrders failed:", err);
    return [];
  }
}

// 8. Low-efficiency workers — reuse yesterday's efficiency report, keep only
//    present workers (workingMinutes > 0) below the threshold.
async function checkLowEfficiencyWorkers(
  db: DbLike,
  todayYmd: string,
): Promise<WorkerSummary[]> {
  try {
    const yesterday = addDaysYmd(todayYmd, -1);
    const report = await collectEfficiencyData(db, yesterday);
    return report.workers.filter(
      (w) => w.workingMinutes > 0 && w.efficiencyPct < LOW_EFFICIENCY_THRESHOLD,
    );
  } catch (err) {
    console.error("[compliance] lowEfficiencyWorkers failed:", err);
    return [];
  }
}

// ─── v2 checks ─────────────────────────────────────────────────────────────

// "Done" job-card statuses (the step is finished for that department). Verified
// against job-cards.ts (worker-prod summary), production-orders.ts (anchor /
// transfer logic) and jobcard-sync.ts: COMPLETED + TRANSFERRED both mean done.
const JC_DONE_STATUSES = new Set(["COMPLETED", "TRANSFERRED"]);

// 9. Production out-of-sequence (process skips). Within each production order,
//    group its job cards by branchKey (so the parallel fabric branch and wood
//    branch never cross-contaminate). Within each (productionOrderId, branchKey)
//    group, sort by sequence and flag any DONE card that has an EARLIER-sequence
//    card in the same group that is NOT done. We only look at production orders
//    that are not fully finished (status NOT IN COMPLETED/CANCELLED) to bound
//    the set. One row per (PO, doneDept) violation.
async function checkProcessSkips(db: DbLike): Promise<ProcessSkipRow[]> {
  try {
    // Active production orders — bound the set + carry display/link fields.
    const poRes = await db
      .prepare(
        `SELECT id, poNo, companySOId, salesOrderId, productName, status
           FROM production_orders
          WHERE status NOT IN ('COMPLETED','CANCELLED')`,
      )
      .bind()
      .all<{
        id: string;
        poNo: string | null;
        companySOId: string | null;
        salesOrderId: string | null;
        productName: string | null;
        status: string;
      }>();
    const pos = poRes.results ?? [];
    if (pos.length === 0) return [];

    const poById = new Map<
      string,
      {
        poNo: string;
        companySOId: string;
        salesOrderId: string;
        productName: string;
      }
    >();
    for (const p of pos) {
      poById.set(p.id, {
        poNo: p.poNo ?? "",
        companySOId: p.companySOId ?? "",
        salesOrderId: p.salesOrderId ?? "",
        productName: p.productName ?? "",
      });
    }

    // Job cards for those POs (one IN-list query). job_cards has no poNo /
    // productName — those come from production_orders (verified in
    // job-cards.ts, which LEFT JOINs production_orders for poNo).
    const poIds = [...poById.keys()];
    const ph = poIds.map(() => "?").join(",");
    const jcRes = await db
      .prepare(
        `SELECT productionOrderId, departmentCode, sequence, branchKey,
                status, completedDate
           FROM job_cards
          WHERE productionOrderId IN (${ph})`,
      )
      .bind(...poIds)
      .all<{
        productionOrderId: string | null;
        departmentCode: string | null;
        sequence: number | null;
        branchKey: string | null;
        status: string | null;
        completedDate: string | null;
      }>();
    const jcs = jcRes.results ?? [];
    if (jcs.length === 0) return [];

    // Group by (productionOrderId, branchKey ?? "").
    const groups = new Map<
      string,
      Array<{
        productionOrderId: string;
        departmentCode: string;
        sequence: number;
        status: string;
        completedDate: string;
      }>
    >();
    for (const jc of jcs) {
      const poId = jc.productionOrderId;
      if (!poId) continue;
      const key = `${poId}|${jc.branchKey ?? ""}`;
      const arr = groups.get(key) ?? [];
      arr.push({
        productionOrderId: poId,
        departmentCode: jc.departmentCode ?? "",
        sequence: jc.sequence ?? 0,
        status: jc.status ?? "",
        completedDate: jc.completedDate ?? "",
      });
      groups.set(key, arr);
    }

    const rows: ProcessSkipRow[] = [];
    for (const arr of groups.values()) {
      // Sort by sequence ascending so "earlier" = lower index.
      arr.sort((a, b) => a.sequence - b.sequence);
      for (let i = 0; i < arr.length; i++) {
        const card = arr[i];
        if (!JC_DONE_STATUSES.has(card.status)) continue;
        // Find an earlier-sequence card (strictly smaller sequence) in the same
        // group that is NOT done. Use the most-upstream such gap for the label.
        let blockedBy: { departmentCode: string; status: string } | null = null;
        for (let j = 0; j < i; j++) {
          const earlier = arr[j];
          if (earlier.sequence >= card.sequence) continue;
          if (!JC_DONE_STATUSES.has(earlier.status)) {
            blockedBy = {
              departmentCode: earlier.departmentCode,
              status: earlier.status,
            };
            break; // first (most-upstream) gap is enough
          }
        }
        if (!blockedBy) continue;
        const meta = poById.get(card.productionOrderId);
        if (!meta) continue;
        rows.push({
          productionOrderId: card.productionOrderId,
          poNo: meta.poNo,
          companySOId: meta.companySOId,
          salesOrderId: meta.salesOrderId,
          productName: meta.productName,
          doneDept: card.departmentCode,
          doneDeptCompletedDate: (card.completedDate ?? "").slice(0, 10),
          blockedByDept: blockedBy.departmentCode,
          blockedByStatus: blockedBy.status,
        });
      }
    }
    return rows;
  } catch (err) {
    console.error("[compliance] processSkips failed:", err);
    return [];
  }
}

// 10a. Missing WIP times — distinct (productCode, productName, departmentCode)
//      among job cards on ACTIVE production orders where estMinutes is null/0,
//      i.e. the product is in production but has no standard time for that step.
//      productCode/productName come from production_orders (job_cards carries
//      neither — verified in production-builder.ts INSERT + job-cards.ts join).
async function checkMissingWipTimes(db: DbLike): Promise<MissingWipTimeRow[]> {
  try {
    const poRes = await db
      .prepare(
        `SELECT id, poNo, productCode, productName
           FROM production_orders
          WHERE status NOT IN ('COMPLETED','CANCELLED')`,
      )
      .bind()
      .all<{
        id: string;
        poNo: string | null;
        productCode: string | null;
        productName: string | null;
      }>();
    const pos = poRes.results ?? [];
    if (pos.length === 0) return [];

    const poById = new Map<
      string,
      { poNo: string; productCode: string; productName: string }
    >();
    for (const p of pos) {
      poById.set(p.id, {
        poNo: p.poNo ?? "",
        productCode: p.productCode ?? "",
        productName: p.productName ?? "",
      });
    }

    const poIds = [...poById.keys()];
    const ph = poIds.map(() => "?").join(",");
    const jcRes = await db
      .prepare(
        `SELECT productionOrderId, departmentCode, estMinutes
           FROM job_cards
          WHERE productionOrderId IN (${ph})
            AND (estMinutes IS NULL OR estMinutes = 0)`,
      )
      .bind(...poIds)
      .all<{
        productionOrderId: string | null;
        departmentCode: string | null;
        estMinutes: number | null;
      }>();
    const jcs = jcRes.results ?? [];
    if (jcs.length === 0) return [];

    // Distinct on (productCode, departmentCode); keep first example PO.
    const seen = new Map<string, MissingWipTimeRow>();
    for (const jc of jcs) {
      const poId = jc.productionOrderId;
      if (!poId) continue;
      const meta = poById.get(poId);
      if (!meta) continue;
      const dept = jc.departmentCode ?? "";
      const key = `${meta.productCode}|${dept}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        productCode: meta.productCode,
        productName: meta.productName,
        departmentCode: dept,
        examplePoNo: meta.poNo,
      });
    }
    return [...seen.values()];
  } catch (err) {
    console.error("[compliance] missingWipTimes failed:", err);
    return [];
  }
}

// 10b. Incomplete BOMs — products referenced by ACTIVE production orders that
//      have NO active BOM template. The BOM table is bom_templates, keyed by
//      productCode with versionStatus ('ACTIVE'/'DRAFT'/'OBSOLETE') — verified
//      in bom.ts. There is no per-product "isDefault" flag, so "incomplete" is
//      read as: an active product with no ACTIVE bom_templates row at all.
async function checkIncompleteBoms(db: DbLike): Promise<IncompleteBomRow[]> {
  try {
    const poRes = await db
      .prepare(
        `SELECT DISTINCT productCode, productName
           FROM production_orders
          WHERE status NOT IN ('COMPLETED','CANCELLED')
            AND productCode IS NOT NULL
            AND productCode <> ''`,
      )
      .bind()
      .all<{ productCode: string | null; productName: string | null }>();
    const products = (poRes.results ?? []).filter(
      (p) => !isEmpty(p.productCode),
    );
    if (products.length === 0) return [];

    // Collapse to distinct productCodes (first name wins for display).
    const nameByCode = new Map<string, string>();
    for (const p of products) {
      const code = p.productCode as string;
      if (!nameByCode.has(code)) nameByCode.set(code, p.productName ?? "");
    }
    const codes = [...nameByCode.keys()];

    // productCodes that DO have an active BOM template.
    const withBom = new Set<string>();
    const ph = codes.map(() => "?").join(",");
    const bomRes = await db
      .prepare(
        `SELECT DISTINCT productCode FROM bom_templates
          WHERE productCode IN (${ph})
            AND UPPER(COALESCE(versionStatus, '')) = 'ACTIVE'`,
      )
      .bind(...codes)
      .all<{ productCode: string | null }>();
    for (const r of bomRes.results ?? []) {
      if (r.productCode) withBom.add(r.productCode);
    }

    return codes
      .filter((code) => !withBom.has(code))
      .map((code) => ({
        productCode: code,
        productName: nameByCode.get(code) ?? "",
        reason: "No active BOM template",
      }));
  } catch (err) {
    console.error("[compliance] incompleteBoms failed:", err);
    return [];
  }
}

// 11. R&D projects stalled. rd_projects has no last-activity timestamp (known
//     gap), so this is state-based/approximate: ACTIVE with a targetLaunchDate
//     in the past, OR ON_HOLD. rd_projects columns verified in rd-projects.ts
//     (id, code, name, currentStage, targetLaunchDate, status). Detail route
//     is /rd/:id (dashboard-routes.tsx).
async function checkRdStalled(
  db: DbLike,
  todayYmd: string,
): Promise<RdStalledRow[]> {
  try {
    const res = await db
      .prepare(
        `SELECT id, name, status, currentStage, targetLaunchDate
           FROM rd_projects
          WHERE status = 'ON_HOLD'
             OR (status = 'ACTIVE'
                 AND targetLaunchDate IS NOT NULL
                 AND targetLaunchDate <> ''
                 AND targetLaunchDate < ?)
          ORDER BY targetLaunchDate ASC`,
      )
      .bind(todayYmd)
      .all<{
        id: string;
        name: string | null;
        status: string | null;
        currentStage: string | null;
        targetLaunchDate: string | null;
      }>();
    return (res.results ?? []).map((r) => {
      const overdue =
        r.status === "ACTIVE" &&
        !isEmpty(r.targetLaunchDate) &&
        String(r.targetLaunchDate).slice(0, 10) < todayYmd
          ? daysBetween(r.targetLaunchDate, todayYmd)
          : 0;
      return {
        id: r.id,
        name: r.name ?? "",
        status: r.status ?? "",
        currentStage: r.currentStage ?? "",
        targetLaunchDate: (r.targetLaunchDate ?? "").slice(0, 10),
        daysOverdue: overdue,
      };
    });
  } catch (err) {
    console.error("[compliance] rdStalled failed:", err);
    return [];
  }
}

// ─── Top-level collector ───────────────────────────────────────────────────

export async function collectComplianceData(
  db: DbLike,
  todayYmd: string,
): Promise<ComplianceData> {
  const [
    doPendingDispatch,
    doNotDelivered,
    doNotInvoiced,
    soNoDo,
    soNoInvoice,
    overdueOrders,
    poNotReceived,
    lowEfficiencyWorkers,
    processSkips,
    missingWipTimes,
    incompleteBoms,
    rdStalled,
  ] = await Promise.all([
    checkDoPendingDispatch(db, todayYmd),
    checkDoNotDelivered(db, todayYmd),
    checkDoNotInvoiced(db, todayYmd),
    checkSoNoDo(db),
    checkSoNoInvoice(db),
    checkOverdueOrders(db, todayYmd),
    checkPoNotReceived(db, todayYmd),
    checkLowEfficiencyWorkers(db, todayYmd),
    checkProcessSkips(db),
    checkMissingWipTimes(db),
    checkIncompleteBoms(db),
    checkRdStalled(db, todayYmd),
  ]);

  const counts: ComplianceCounts = {
    doPendingDispatch: doPendingDispatch.length,
    doNotDelivered: doNotDelivered.length,
    doNotInvoiced: doNotInvoiced.length,
    soNoDo: soNoDo.length,
    soNoInvoice: soNoInvoice.length,
    overdueOrders: overdueOrders.length,
    poNotReceived: poNotReceived.length,
    lowEfficiencyWorkers: lowEfficiencyWorkers.length,
    processSkips: processSkips.length,
    missingWipTimes: missingWipTimes.length,
    incompleteBoms: incompleteBoms.length,
    rdStalled: rdStalled.length,
    total:
      doPendingDispatch.length +
      doNotDelivered.length +
      doNotInvoiced.length +
      soNoDo.length +
      soNoInvoice.length +
      overdueOrders.length +
      poNotReceived.length +
      lowEfficiencyWorkers.length +
      processSkips.length +
      missingWipTimes.length +
      incompleteBoms.length +
      rdStalled.length,
  };

  return {
    generatedAtIso: new Date().toISOString(),
    today: todayYmd,
    counts,
    groups: {
      doPendingDispatch,
      doNotDelivered,
      doNotInvoiced,
      soNoDo,
      soNoInvoice,
      overdueOrders,
      poNotReceived,
      lowEfficiencyWorkers,
      processSkips,
      missingWipTimes,
      incompleteBoms,
      rdStalled,
    },
  };
}
