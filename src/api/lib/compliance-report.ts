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
//   - One broken query still cannot 500 the whole report — but it no longer
//     reports CLEAN either. See below.
//
// THE REPORT CAN SAY "I COULD NOT CHECK" (2026-08-14, BUG-2026-08-13-141)
//
// Every check used to end `catch (err) { console.error(…); return []; }`. That
// made a check which THREW byte-identical to a check which ran and found
// nothing: its chip showed 0, it added 0 to the headline, and the Daily Report
// printed a green `0` under "A Quiet Day on the Floor" over a sweep that had
// partly not happened. The owner reads that number every morning.
//
// Now: each check RETHROWS, `runCheck` (bottom of this file) records the
// failure, the check's count becomes `null` — never `0` — and the key is listed
// in `ComplianceData.unavailable`. `counts.checksRun` / `counts.checksTotal`
// publish the coverage beside the headline, so a partial report states that it
// is partial. This is C15 (`docs/BUG-CLASSES.md`): `0` is a claim, not a blank,
// and a percentage or a count over an incomplete population must publish that
// population.
//
// A check that legitimately finds nothing still returns `[]` and counts `0`.
// The distinction is the entire point; do not "simplify" `number | null` back
// to `number`.
// ---------------------------------------------------------------------------

import {
  collectOverdueData,
  type OverdueRow,
} from "./schedule-overdue-report";
import {
  collectEfficiencyData,
  type WorkerSummary,
} from "./efficiency-report";
import {
  checkPricingIntegrity,
  type PricingIssueRow,
} from "./pricing-integrity";
import {
  checkCogsIntegrity,
  type CogsIssueRow,
} from "./cogs-integrity";

// D1-compat shape (the SupabaseAdapter installed in worker.ts exposes this).
// `first` is used to read the single kv_config row (mirrors kv-config.ts).
interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

const LOW_EFFICIENCY_THRESHOLD = 60; // workers below this (when present) flagged

// ─── Configurable SOP grace windows ────────────────────────────────────────
// Per-category exception thresholds (whole days). A record is only flagged once
// it has been stuck at its stage for at least this many days. Stored in the
// kv_config table under key `daily-report-config` (shared contract with the
// Daily Report settings UI). Missing row / missing field falls back to these
// exact defaults. DO stages move daily; POs are slower-moving (two weeks).
export interface GraceDays {
  doPendingDispatch: number;
  doNotDelivered: number;
  doNotInvoiced: number;
  soWithoutDo: number;
  soWithoutInvoice: number;
  poNotReceived: number;
  processSkips: number;
}

const DEFAULT_GRACE_DAYS: GraceDays = {
  doPendingDispatch: 1,
  doNotDelivered: 1,
  doNotInvoiced: 1,
  soWithoutDo: 2,
  soWithoutInvoice: 3,
  poNotReceived: 14,
  processSkips: 1,
};

const DAILY_REPORT_CONFIG_KEY = "daily-report-config";

// Coerce an arbitrary value into a non-negative whole-day number, else fall
// back. Guards against strings ("2"), floats, NaN and negatives coming from a
// hand-edited config blob.
function toGraceDay(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

// Load the `daily-report-config` row server-side and merge with the defaults so
// every key is always present. The kv_config value may be stored as a JSON
// string (the normal kv-config.ts write path) OR already as an object (some
// adapters auto-parse JSON columns) — both are handled. Any read/parse failure
// falls back to the full default set so the report can never 500 on config.
async function loadGraceDays(db: DbLike): Promise<GraceDays> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind(DAILY_REPORT_CONFIG_KEY)
      .first<{ value: unknown }>();
    if (!row || row.value == null) return { ...DEFAULT_GRACE_DAYS };

    let parsed: unknown = row.value;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return { ...DEFAULT_GRACE_DAYS };
      }
    }

    const cfg =
      parsed && typeof parsed === "object"
        ? ((parsed as Record<string, unknown>).graceDays as
            | Record<string, unknown>
            | undefined)
        : undefined;
    if (!cfg || typeof cfg !== "object") return { ...DEFAULT_GRACE_DAYS };

    return {
      doPendingDispatch: toGraceDay(
        cfg.doPendingDispatch,
        DEFAULT_GRACE_DAYS.doPendingDispatch,
      ),
      doNotDelivered: toGraceDay(
        cfg.doNotDelivered,
        DEFAULT_GRACE_DAYS.doNotDelivered,
      ),
      doNotInvoiced: toGraceDay(
        cfg.doNotInvoiced,
        DEFAULT_GRACE_DAYS.doNotInvoiced,
      ),
      soWithoutDo: toGraceDay(cfg.soWithoutDo, DEFAULT_GRACE_DAYS.soWithoutDo),
      soWithoutInvoice: toGraceDay(
        cfg.soWithoutInvoice,
        DEFAULT_GRACE_DAYS.soWithoutInvoice,
      ),
      poNotReceived: toGraceDay(
        cfg.poNotReceived,
        DEFAULT_GRACE_DAYS.poNotReceived,
      ),
      processSkips: toGraceDay(
        cfg.processSkips,
        DEFAULT_GRACE_DAYS.processSkips,
      ),
    };
  } catch (err) {
    console.error("[compliance] loadGraceDays failed, using defaults:", err);
    return { ...DEFAULT_GRACE_DAYS };
  }
}

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
  // Whole days since the SO's clock-start (companySODate, else createdAt /
  // updatedAt). Row is only flagged once this reaches graceDays.soWithoutDo.
  days: number;
}

export interface SoNoInvoiceRow {
  id: string;
  companySOId: string;
  customerName: string;
  status: string;
  // Whole days since the SO was delivered (latest deliveredAt across its DOs).
  // Once known, the row is only flagged when this reaches graceDays. When the
  // delivered date can't be resolved (a DELIVERED SO whose DO never stamped
  // deliveredAt — common), days is left undefined and the row is STILL flagged
  // (we never hide an uninvoiced delivered SO just because its date is missing).
  days?: number;
}

export interface PoNotReceivedRow {
  id: string;
  poNo: string;
  supplierName: string;
  status: string;
  orderDate: string;
  daysOpen: number;
  // Whole days past the PO's Expected Delivery Date (purchase_orders.expectedDate)
  // when that date exists and is before today; 0 otherwise. Enrichment only —
  // does not change which POs are flagged.
  expectedOverdueDays: number;
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
  // Whole days since the DONE card's completedDate. Row is only flagged once
  // this reaches graceDays.processSkips.
  days: number;
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

export interface PendingTimeAdjustmentRow {
  id: string;
  workerId: string;
  departmentCode: string;
  minutes: number;
  kind: string;
  requestedOn: string;
  daysWaiting: number;
}

/**
 * Per-check counts.
 *
 * Every per-check field is `number | null`. **`null` means the check could not
 * run** — the query threw — and is the whole point of BUG-2026-08-13-141: a
 * failed check used to report `0`, which is a claim ("we looked, and this is
 * clean"), not a blank. Render `null` as "—" / "couldn't check", never as 0.
 *
 * `total` stays a plain number and is the sum over the checks that ACTUALLY
 * RAN. It is therefore a floor, not a total, whenever `checksRun < checksTotal`
 * — which is exactly why those two fields travel beside it and why no caller
 * may print a clean headline without reading them.
 */
export interface ComplianceCounts {
  total: number;
  /** How many of the checks completed. */
  checksRun: number;
  /** How many checks exist. `checksRun < checksTotal` ⇒ partial coverage. */
  checksTotal: number;
  doPendingDispatch: number | null;
  doNotDelivered: number | null;
  doNotInvoiced: number | null;
  soNoDo: number | null;
  soNoInvoice: number | null;
  overdueOrders: number | null;
  poNotReceived: number | null;
  lowEfficiencyWorkers: number | null;
  processSkips: number | null;
  missingWipTimes: number | null;
  incompleteBoms: number | null;
  rdStalled: number | null;
  /** Time-adjustment requests left PENDING. Owner 2026-08-07: "either reject
   *  or approve 而不是 hanging 在那边" — an unanswered request is a worker's
   *  pay sitting in limbo, and it silently distorts efficiency too, because the
   *  minutes are neither counted nor refused. */
  pendingTimeAdjustments: number | null;
  /** Money invariants (src/api/lib/pricing-integrity.ts). Three price defects
   *  ran for months unseen because nothing checked the DATA daily. */
  pricingIssues: number | null;
  /** Delivered units with no cost layer behind them (cogs-integrity.ts). The
   *  cascade already computes the shortfall and the caller drops it, so the
   *  only place this is visible is here. */
  cogsIssues: number | null;
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
  pendingTimeAdjustments: PendingTimeAdjustmentRow[];
  pricingIssues: PricingIssueRow[];
  cogsIssues: CogsIssueRow[];
}

/** The keys of every individual check, i.e. of ComplianceGroups. */
export type ComplianceCheckKey = keyof ComplianceGroups;

/** One check that could not run. `message` is for the operator, not a stack. */
export interface ComplianceCheckFailure {
  check: ComplianceCheckKey;
  message: string;
}

export interface ComplianceData {
  generatedAtIso: string;
  today: string;
  counts: ComplianceCounts;
  groups: ComplianceGroups;
  /**
   * BUG-2026-08-13-141 — the report's ability to say "I could not check".
   *
   * Every check used to catch its own error and return `[]`, so a query that
   * threw contributed 0 to its chip AND to the headline, indistinguishable from
   * a check that ran and found nothing. The Daily Report then printed a green
   * `0` under "A Quiet Day on the Floor" over a report that had partly not
   * happened.
   *
   * A failed check now appears here, its group stays `[]` (there are no rows to
   * show — that much is honest) and its count is `null`, never `0`. `counts`
   * additionally publishes `checksRun` / `checksTotal` so the headline can state
   * its own coverage: the lesson of BUG-2026-08-13-096 is that "0 items" meant
   * "cannot see", not "nothing wrong".
   */
  unavailable: ComplianceCheckFailure[];
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
  graceDays: number,
): Promise<DoPendingDispatchRow[]> {
  try {
    const cutoff = isoCutoff(todayYmd, graceDays);
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
    throw err;
  }
}

// 2. DOs loaded/dispatched/in-transit > 1 day ago but never marked delivered.
async function checkDoNotDelivered(
  db: DbLike,
  todayYmd: string,
  graceDays: number,
): Promise<DoNotDeliveredRow[]> {
  try {
    const cutoff = isoCutoff(todayYmd, graceDays);
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
    throw err;
  }
}

// 3. DOs delivered > 1 day ago with no invoice raised against them.
async function checkDoNotInvoiced(
  db: DbLike,
  todayYmd: string,
  graceDays: number,
): Promise<DoNotInvoicedRow[]> {
  try {
    const cutoff = isoCutoff(todayYmd, graceDays);
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
    throw err;
  }
}

// 4. Confirmed / ready-to-ship SOs with no delivery order at all. A DO links
//    either via delivery_orders.salesOrderId (single-SO DO) OR via
//    delivery_order_items.salesOrderNo = the SO's companySOId (consolidated
//    DO). Mirrors the reverse lookup in sales-orders.ts GET /:id.
async function checkSoNoDo(
  db: DbLike,
  todayYmd: string,
  graceDays: number,
): Promise<SoNoDoRow[]> {
  try {
    // Clock-start for "how long has this confirmed SO had no DO": sales_orders
    // carries no confirmed/ready timestamp, so we use companySODate (the date
    // the order was booked as a company SO) and fall back to createdAt /
    // updatedAt when it's blank.
    const soRes = await db
      .prepare(
        `SELECT id, companySOId, customerName, status,
                companySODate, createdAt, updatedAt
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
        companySODate: string | null;
        createdAt: string | null;
        updatedAt: string | null;
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
      .map((s) => {
        const clockStart = !isEmpty(s.companySODate)
          ? s.companySODate
          : !isEmpty(s.createdAt)
            ? s.createdAt
            : s.updatedAt;
        return {
          id: s.id,
          companySOId: s.companySOId ?? "",
          customerName: s.customerName ?? "",
          status: s.status,
          days: daysBetween(clockStart, todayYmd),
        };
      })
      .filter((s) => s.days >= graceDays);
  } catch (err) {
    console.error("[compliance] soNoDo failed:", err);
    throw err;
  }
}

// 5. Delivered / closed SOs with no invoice. v1 matches by invoices.salesOrderId
//    OR by any invoice on one of the SO's own DOs (deliveryOrderId in the SO's
//    DO set). DO set resolved via salesOrderId + consolidated salesOrderNo link.
async function checkSoNoInvoice(
  db: DbLike,
  todayYmd: string,
  graceDays: number,
): Promise<SoNoInvoiceRow[]> {
  try {
    const soRes = await db
      .prepare(
        // Only DELIVERED — a delivered order with no invoice is a real billing
        // gap. CLOSED orders are already done/paid; including them flooded the
        // list with linkage false-positives (invoice anchored to the combined
        // DO / lead SO), so they're excluded (Wei Siang 2026-05-29).
        // RM0 orders excluded too (owner audit 2026-07-11): service orders are
        // free by default and legitimately never invoiced — counting them
        // inflated the headline with non-actionable rows.
        `SELECT id, companySOId, customerName, status
           FROM sales_orders
          WHERE status = 'DELIVERED'
            AND COALESCE(totalSen, 0) > 0
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
    // deliveredAtBySoId tracks the LATEST deliveredAt across an SO's DOs — the
    // clock-start for "days since delivered".
    const soNos = sos
      .map((s) => s.companySOId)
      .filter((x): x is string => !isEmpty(x));
    const doIdToSoId = new Map<string, string>(); // doId → owning soId
    const deliveredAtBySoId = new Map<string, string>(); // soId → latest deliveredAt
    const noteDelivered = (soId: string, deliveredAt: string | null) => {
      if (isEmpty(deliveredAt)) return;
      const prev = deliveredAtBySoId.get(soId);
      if (!prev || String(deliveredAt) > prev) {
        deliveredAtBySoId.set(soId, String(deliveredAt));
      }
    };
    {
      const ph = soIds.map(() => "?").join(",");
      const r = await db
        .prepare(
          `SELECT id, salesOrderId, deliveredAt FROM delivery_orders
            WHERE salesOrderId IN (${ph})
              AND salesOrderId IS NOT NULL
              AND salesOrderId <> ''`,
        )
        .bind(...soIds)
        .all<{ id: string; salesOrderId: string | null; deliveredAt: string | null }>();
      for (const x of r.results ?? []) {
        if (x.salesOrderId) {
          doIdToSoId.set(x.id, x.salesOrderId);
          noteDelivered(x.salesOrderId, x.deliveredAt);
        }
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

    // Backfill deliveredAt for consolidated DOs (linked via items, so their
    // deliveredAt wasn't read in the salesOrderId query above).
    const doIdsNeedingDelivered = allDoIds.filter((doId) => {
      const soId = doIdToSoId.get(doId);
      return soId !== undefined && !deliveredAtBySoId.has(soId);
    });
    if (doIdsNeedingDelivered.length > 0) {
      const ph = doIdsNeedingDelivered.map(() => "?").join(",");
      const r = await db
        .prepare(
          `SELECT id, deliveredAt FROM delivery_orders
            WHERE id IN (${ph})
              AND deliveredAt IS NOT NULL
              AND deliveredAt <> ''`,
        )
        .bind(...doIdsNeedingDelivered)
        .all<{ id: string; deliveredAt: string | null }>();
      for (const x of r.results ?? []) {
        const owningSo = doIdToSoId.get(x.id);
        if (owningSo) noteDelivered(owningSo, x.deliveredAt);
      }
    }

    return sos
      .filter((s) => !invoicedSoIds.has(s.id))
      .map((s) => {
        // Clock-start = latest deliveredAt across the SO's DOs. A DELIVERED SO
        // SHOULD have one, but in practice the deliveredAt timestamp is often
        // left blank, so treat "unknown" as a first-class case: keep the row
        // (days undefined → shown as "—") instead of hiding a real uninvoiced
        // delivered SO. Only a KNOWN delivered date drives the grace filter.
        const delivered = deliveredAtBySoId.get(s.id);
        return {
          id: s.id,
          companySOId: s.companySOId ?? "",
          customerName: s.customerName ?? "",
          status: s.status,
          days: isEmpty(delivered) ? undefined : daysBetween(delivered, todayYmd),
        };
      })
      // Drop only rows whose delivered date is KNOWN and still inside the grace
      // window; unknown-date rows (days === undefined) always stay flagged.
      .filter((s) => s.days === undefined || s.days >= graceDays);
  } catch (err) {
    console.error("[compliance] soNoInvoice failed:", err);
    throw err;
  }
}

// 6. POs open > 14 days that have neither a received GRN nor a purchase invoice.
//    GRN counts as "received" when its status is CONFIRMED or POSTED (DRAFT
//    GRNs haven't booked stock yet).
async function checkPoNotReceived(
  db: DbLike,
  todayYmd: string,
  graceDays: number,
): Promise<PoNotReceivedRow[]> {
  try {
    const cutoff = isoCutoff(todayYmd, graceDays).slice(0, 10); // orderDate is a date
    const res = await db
      .prepare(
        `SELECT id, poNo, supplierName, status, orderDate, expectedDate
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
        expectedDate: string | null;
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
        // Days past the Expected Delivery Date when set and already in the
        // past; 0 when there's no expectedDate or it's still upcoming.
        expectedOverdueDays:
          !isEmpty(p.expectedDate) &&
          String(p.expectedDate).slice(0, 10) < todayYmd
            ? daysBetween(p.expectedDate, todayYmd)
            : 0,
      }));
  } catch (err) {
    console.error("[compliance] poNotReceived failed:", err);
    throw err;
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
    throw err;
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
    throw err;
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
async function checkProcessSkips(
  db: DbLike,
  todayYmd: string,
  graceDays: number,
): Promise<ProcessSkipRow[]> {
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
          // Same-department earlier card = another PIECE of the same product
          // (multi-unit PO: HB+Divan, multi-seat sofa) still queued at that
          // station. Piece B finishing before piece A is normal parallel work,
          // NOT an SOP skip — those rows were pure noise ("PACKING ahead of
          // PACKING", owner audit 2026-07-11). Only a DIFFERENT upstream dept
          // still pending counts as a real skipped step.
          if (earlier.departmentCode === card.departmentCode) continue;
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
        // Clock-start = the DONE card's completedDate; suppress fresh skips
        // inside the grace window.
        const days = daysBetween(card.completedDate, todayYmd);
        if (days < graceDays) continue;
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
          days,
        });
      }
    }
    return rows;
  } catch (err) {
    console.error("[compliance] processSkips failed:", err);
    throw err;
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
    throw err;
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
    throw err;
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
    throw err;
  }
}

// 14. Time-adjustment requests still waiting for a yes or a no.
//
// Owner 2026-08-07: "either reject or approve 而不是 hanging 在那边." A pending
// request is worse than a rejected one — the worker does not know whether the
// minutes count, and neither does the efficiency figure that pays their
// allowance. There is no grace window: the whole point is that these are
// answered, and an answer takes seconds.
async function checkPendingTimeAdjustments(
  db: DbLike,
  todayYmd: string,
): Promise<PendingTimeAdjustmentRow[]> {
  try {
    const res = await db
      .prepare(
        `SELECT id, workerId, departmentCode, hours, kind, date, createdAt
           FROM worker_nonprod_requests
          WHERE status = 'PENDING'
          ORDER BY createdAt ASC
          LIMIT 500`,
      )
      .bind()
      .all<{
        id: string;
        workerId: string | null;
        departmentCode: string | null;
        hours: number | string | null;
        kind: string | null;
        date: string | null;
        createdAt: string | null;
      }>();
    return (res.results ?? []).map((r) => {
      // The request carries hours; the floor talks in minutes.
      const minutes = Math.round((Number(r.hours) || 0) * 60);
      // created_at is nullable on legacy rows — fall back to the work date so
      // "waiting 0 days" never hides a request from 2026-06.
      const raised = r.createdAt || r.date || "";
      return {
        id: r.id,
        workerId: r.workerId ?? "",
        departmentCode: r.departmentCode ?? "",
        minutes,
        kind: r.kind ?? "",
        requestedOn: String(raised).slice(0, 10),
        daysWaiting: daysBetween(raised, todayYmd),
      };
    });
  } catch (err) {
    console.error("[compliance] pendingTimeAdjustments failed:", err);
    throw err;
  }
}

// ─── Top-level collector ───────────────────────────────────────────────────

/**
 * The outcome of ONE check: either the rows it found, or the reason it could
 * not look. There is no third state, and in particular there is no "empty
 * because it broke" — that conflation is BUG-2026-08-13-141.
 */
type CheckOutcome<T> =
  | { ok: true; rows: T[] }
  | { ok: false; message: string };

/**
 * Run one check, converting a throw into a RECORDED failure.
 *
 * Each check rethrows now instead of returning `[]` (see the rethrow sites
 * above), so the decision of what an unreadable check means is made in exactly
 * one place — here — rather than fifteen times by fifteen catch blocks that all
 * happened to choose "clean".
 */
async function runCheck<T>(
  key: ComplianceCheckKey,
  fn: () => Promise<T[]>,
): Promise<CheckOutcome<T>> {
  try {
    return { ok: true, rows: await fn() };
  } catch (err) {
    console.error(`[compliance] check '${key}' unavailable:`, err);
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function collectComplianceData(
  db: DbLike,
  todayYmd: string,
): Promise<ComplianceData> {
  // Load per-category grace windows once (kv_config `daily-report-config`),
  // merged with the bundled defaults so every key is present.
  const graceDays = await loadGraceDays(db);

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
    pricingIssues,
    cogsIssues,
    pendingTimeAdjustments,
  ] = await Promise.all([
    runCheck("doPendingDispatch", () =>
      checkDoPendingDispatch(db, todayYmd, graceDays.doPendingDispatch),
    ),
    runCheck("doNotDelivered", () =>
      checkDoNotDelivered(db, todayYmd, graceDays.doNotDelivered),
    ),
    runCheck("doNotInvoiced", () =>
      checkDoNotInvoiced(db, todayYmd, graceDays.doNotInvoiced),
    ),
    runCheck("soNoDo", () => checkSoNoDo(db, todayYmd, graceDays.soWithoutDo)),
    runCheck("soNoInvoice", () =>
      checkSoNoInvoice(db, todayYmd, graceDays.soWithoutInvoice),
    ),
    runCheck("overdueOrders", () => checkOverdueOrders(db, todayYmd)),
    runCheck("poNotReceived", () =>
      checkPoNotReceived(db, todayYmd, graceDays.poNotReceived),
    ),
    runCheck("lowEfficiencyWorkers", () =>
      checkLowEfficiencyWorkers(db, todayYmd),
    ),
    runCheck("processSkips", () =>
      checkProcessSkips(db, todayYmd, graceDays.processSkips),
    ),
    runCheck("missingWipTimes", () => checkMissingWipTimes(db)),
    runCheck("incompleteBoms", () => checkIncompleteBoms(db)),
    runCheck("rdStalled", () => checkRdStalled(db, todayYmd)),
    runCheck("pricingIssues", () => checkPricingIntegrity(db)),
    runCheck("cogsIssues", () => checkCogsIntegrity(db)),
    runCheck("pendingTimeAdjustments", () =>
      checkPendingTimeAdjustments(db, todayYmd),
    ),
  ]);

  const unavailable: ComplianceCheckFailure[] = [];
  // A failed check contributes NOTHING to the total — not a zero, an absence.
  // Its count is null and its key is listed above, so no reader can mistake the
  // gap for a clean result.
  const n = (key: ComplianceCheckKey, o: CheckOutcome<unknown>): number | null => {
    if (o.ok) return o.rows.length;
    unavailable.push({ check: key, message: o.message });
    return null;
  };
  const rows = <T>(o: CheckOutcome<T>): T[] => (o.ok ? o.rows : []);

  const perCheck = {
    doPendingDispatch: n("doPendingDispatch", doPendingDispatch),
    doNotDelivered: n("doNotDelivered", doNotDelivered),
    doNotInvoiced: n("doNotInvoiced", doNotInvoiced),
    soNoDo: n("soNoDo", soNoDo),
    soNoInvoice: n("soNoInvoice", soNoInvoice),
    overdueOrders: n("overdueOrders", overdueOrders),
    poNotReceived: n("poNotReceived", poNotReceived),
    lowEfficiencyWorkers: n("lowEfficiencyWorkers", lowEfficiencyWorkers),
    processSkips: n("processSkips", processSkips),
    missingWipTimes: n("missingWipTimes", missingWipTimes),
    incompleteBoms: n("incompleteBoms", incompleteBoms),
    rdStalled: n("rdStalled", rdStalled),
    pricingIssues: n("pricingIssues", pricingIssues),
    cogsIssues: n("cogsIssues", cogsIssues),
    pendingTimeAdjustments: n("pendingTimeAdjustments", pendingTimeAdjustments),
  };

  const checkKeys = Object.keys(perCheck) as ComplianceCheckKey[];
  const counts: ComplianceCounts = {
    ...perCheck,
    checksTotal: checkKeys.length,
    checksRun: checkKeys.length - unavailable.length,
    // Σ over the checks that ran. With any failure this is a FLOOR on the
    // number of exceptions, not the number — `checksRun`/`checksTotal` beside
    // it is what makes that readable, and every renderer must read them.
    total: checkKeys.reduce((s, k) => s + (perCheck[k] ?? 0), 0),
  };

  return {
    generatedAtIso: new Date().toISOString(),
    today: todayYmd,
    counts,
    unavailable,
    groups: {
      doPendingDispatch: rows(doPendingDispatch),
      doNotDelivered: rows(doNotDelivered),
      doNotInvoiced: rows(doNotInvoiced),
      soNoDo: rows(soNoDo),
      soNoInvoice: rows(soNoInvoice),
      overdueOrders: rows(overdueOrders),
      poNotReceived: rows(poNotReceived),
      lowEfficiencyWorkers: rows(lowEfficiencyWorkers),
      processSkips: rows(processSkips),
      missingWipTimes: rows(missingWipTimes),
      incompleteBoms: rows(incompleteBoms),
      rdStalled: rows(rdStalled),
      pricingIssues: rows(pricingIssues),
      cogsIssues: rows(cogsIssues),
      pendingTimeAdjustments: rows(pendingTimeAdjustments),
    },
  };
}
