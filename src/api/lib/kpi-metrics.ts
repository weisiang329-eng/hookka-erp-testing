// ---------------------------------------------------------------------------
// kpi-metrics.ts — where each KPI's ACTUAL comes from.
//
// One function per KPI, each returning { actual, sampleSize, detail } so the
// card can say "9 late of 41 shipped" rather than a bare number. A KPI whose
// sample is too small to mean anything reports it rather than hiding it.
//
// Join note, and it matters: `delivery_orders.sales_order_id` is set on only
// 166 of 361 DOs, so joining on it silently drops half the shipments.
// `delivery_order_items.sales_order_no` is a stale denormalised string. The one
// path that resolves is
//   delivery_orders → delivery_order_items.production_order_id
//                   → production_orders.sales_order_id → sales_orders
// (2081/2081 and 2341/2379 respectively, measured 2026-08-06). Every query
// below uses it.
//
// The customer's date is `sales_orders.customer_delivery_date` (99.8% filled).
// `hookka_expected_dd` is OUR internal estimate and must never be scored
// against — see docs/PRODUCTION-PLANNING-LOGIC.md.
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";
import { kpiByKey } from "./kpi-catalog";

export interface MetricResult {
  actual: number | null;
  /** How many rows the figure was computed from. */
  sampleSize: number;
  /** One line for the card, e.g. "9 late of 41 shipped". */
  detail: string;
}

const EMPTY: MetricResult = { actual: null, sampleSize: 0, detail: "No data" };

/** First and last day of a YYYY-MM period, inclusive. */
export function periodBounds(period: string): { start: string; end: string } {
  const [y, m] = period.split("-").map(Number);
  const start = `${period}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start, end: `${period}-${String(last).padStart(2, "0")}` };
}

/**
 * GATE — orders dispatched in the period, later than the customer's date.
 *
 * Counted at SALES ORDER level, not per delivery order: a customer who was
 * promised one date and received three deliveries was let down once, not
 * three times. The first dispatch is what counts.
 */
export async function customerDeliveryLate(
  c: Context<Env>,
  period: string,
): Promise<MetricResult> {
  const { start, end } = periodBounds(period);
  const row = await c.var.DB.prepare(
    `WITH first_dispatch AS (
       SELECT po.salesOrderId AS so_id,
              MIN(substr(d.dispatchedAt::text, 1, 10)) AS shipped_on
         FROM delivery_orders d
         JOIN delivery_order_items di ON di.deliveryOrderId = d.id
         JOIN production_orders po ON po.id = di.productionOrderId
        WHERE d.status <> 'CANCELLED'
          AND d.dispatchedAt IS NOT NULL AND d.dispatchedAt <> ''
          AND po.salesOrderId IS NOT NULL AND po.salesOrderId <> ''
        GROUP BY po.salesOrderId
     )
     SELECT COUNT(*) AS shipped,
            COALESCE(SUM(CASE WHEN f.shipped_on >
                   substr(so.customerDeliveryDate::text, 1, 10)
                 THEN 1 ELSE 0 END), 0) AS late
       FROM first_dispatch f
       JOIN sales_orders so ON so.id = f.so_id
      WHERE f.shipped_on >= ? AND f.shipped_on <= ?
        AND so.customerDeliveryDate IS NOT NULL
        AND so.customerDeliveryDate <> ''`,
  )
    .bind(start, end)
    .first<{ shipped: number; late: number }>();

  const shipped = Number(row?.shipped) || 0;
  const late = Number(row?.late) || 0;
  if (shipped === 0) return EMPTY;
  // Reported as a PERCENTAGE, not a count: 9 late out of 41 and 9 out of 400
  // are different failures, and the scoring curve is per percentage point.
  const pct = Math.round((late / shipped) * 1000) / 10;
  return {
    actual: pct,
    sampleSize: shipped,
    detail: `${late} late of ${shipped} shipped (${pct}%)`,
  };
}

/**
 * Active SKUs that are fully set up.
 *
 * "Fully" means all four: a price, a cubic volume, a fabric usage, and a BOM
 * template that actually contains routing. That last clause is the one that
 * matters — the daily report's own incomplete-BOM check only asks whether a
 * template ROW exists, which is why it reads 0 every day while 45% of
 * templates have empty l1_processes.
 */
export async function setupCompleteness(
  c: Context<Env>,
): Promise<MetricResult> {
  const row = await c.var.DB.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN COALESCE(p.basePriceSen,0) + COALESCE(p.price1Sen,0) > 0
                          AND COALESCE(p.unitM3,0) > 0
                          AND COALESCE(p.fabricUsage,0) > 0
                          AND EXISTS (
                                SELECT 1 FROM bom_templates b
                                 WHERE b.productCode = p.code
                                   AND b.versionStatus = 'ACTIVE'
                                   AND COALESCE(b.l1Processes,'') NOT IN ('', '[]')
                              )
                     THEN 1 ELSE 0 END), 0) AS complete
       FROM products p
      WHERE p.status = 'ACTIVE'`,
  ).first<{ total: number; complete: number }>();

  const total = Number(row?.total) || 0;
  const complete = Number(row?.complete) || 0;
  if (total === 0) return EMPTY;
  return {
    actual: Math.round((complete / total) * 1000) / 10,
    sampleSize: total,
    detail: `${complete} of ${total} active SKUs fully set up`,
  };
}

/**
 * The merged daily-report KPI: invoicing lag AND the exception burn-down.
 *
 * Owner 2026-08-07 merged two KPIs into one ("这两个要结合"), because the
 * uninvoiced buckets were BOTH scored here and counted again inside the daily
 * exception total — the same late invoice charged twice. The exception half
 * now runs with those buckets removed.
 *
 * Half one, invoicing:
 *
 * Owner 2026-08-07: "dispatch 了之后三天内要看到 invoice，迟一天扣 10 分 … 5 张
 * 单 1 天就 50 分 … 就是一个 DO or SI，不是跟着一个 order，multiple order become
 * 1 DO SI 的我们."
 *
 * Three things in that sentence decide the shape of this query:
 *
 *  1. The clock starts at DISPATCH, not at order date, and runs to the invoice
 *     — so this is a LAG, not a snapshot of what is currently outstanding. The
 *     old version read the Daily Report's "not invoiced" count, which answers a
 *     different question: it says how many are stuck right now and says nothing
 *     about a document invoiced on day 30 last week. Under the new rule that
 *     one cost 270 points and the snapshot would have shown it as clean.
 *
 *  2. The unit is the DELIVERY ORDER. Several sales orders routinely ship on
 *     one delivery order, and that is one document to raise, so counting sales
 *     orders would charge the same lateness three times.
 *
 *  3. Days accumulate across documents. Five documents one day late is 5, the
 *     same as one document five days late — the owner's own example. So this
 *     sums days rather than counting offending documents.
 *
 * A delivery order with no invoice yet accrues up to TODAY (or the period end,
 * whichever is earlier), otherwise a document nobody ever billed would score
 * better than one billed a day late.
 */
export async function documentsStuck(
  c: Context<Env>,
  period: string,
): Promise<MetricResult> {
  const lag = await invoiceLag(c, period);
  const burn = await exceptionsCleared(c, period, /* excludeInvoiceBuckets */ true);

  const def = kpiByKey("documents_not_stuck");
  const per = Number(def?.penaltyPerUnit ?? 10);

  const halves: Array<{ score: number; detail: string }> = [];
  if (lag.actual !== null) {
    halves.push({
      score: Math.max(0, Math.min(100, 100 - lag.actual * per)),
      detail: lag.detail,
    });
  }
  if (burn.actual !== null) {
    halves.push({ score: Math.max(0, Math.min(100, burn.actual)), detail: burn.detail });
  }
  if (halves.length === 0) {
    return { actual: null, sampleSize: 0, detail: "No invoicing or exception data yet" };
  }

  // Averaged over the halves that HAVE data. A half with nothing to measure is
  // dropped, not scored zero — the snapshot table only keeps ~23 days, so an
  // older month legitimately has no burn-down and the invoicing half should
  // still stand on its own rather than being halved by an absence.
  const score = halves.reduce((s, h) => s + h.score, 0) / halves.length;
  return {
    actual: Math.round(score * 10) / 10,
    sampleSize: lag.sampleSize + burn.sampleSize,
    detail: halves.map((h) => h.detail).join(" · "),
  };
}

/**
 * Half one: document-days of invoicing lag.
 *
 * Cancelled delivery orders are excluded — there is nothing to bill, so
 * counting them would charge Office for a shipment that never happened.
 */
async function invoiceLag(
  c: Context<Env>,
  period: string,
): Promise<MetricResult> {
  const { start, end } = periodBounds(period);
  const def = kpiByKey("documents_not_stuck");
  const grace = Number(def?.graceDays ?? 3);
  const today = new Date().toISOString().slice(0, 10);
  const asAt = today < end ? today : end;

  // DISPATCH, in the owner's word — the day the goods left. `dispatchedAt` is
  // the field the on-time-delivery KPI already scores against, so the two
  // cannot disagree about when a shipment happened. `deliveredAt` is the
  // fallback for older rows that only carry the arrival date.
  const res = await c.var.DB.prepare(
    `SELECT d.id AS "id",
            substr(COALESCE(NULLIF(d.dispatchedAt::text, ''), d.deliveredAt::text), 1, 10) AS "dispatched",
            substr(MIN(i.invoiceDate)::text, 1, 10) AS "invoiced"
       FROM delivery_orders d
       LEFT JOIN invoices i ON i.deliveryOrderId = d.id
      WHERE d.status <> 'CANCELLED'
        AND COALESCE(NULLIF(d.dispatchedAt::text, ''), d.deliveredAt::text) IS NOT NULL
        AND substr(COALESCE(NULLIF(d.dispatchedAt::text, ''), d.deliveredAt::text), 1, 10) >= ?
        AND substr(COALESCE(NULLIF(d.dispatchedAt::text, ''), d.deliveredAt::text), 1, 10) <= ?
      GROUP BY d.id, d.dispatchedAt, d.deliveredAt`,
  )
    .bind(start, end)
    .all<{ id: string; dispatched: string | null; invoiced: string | null }>();

  const rows = res.results ?? [];
  if (rows.length === 0) return EMPTY;

  let lateDays = 0;
  let lateDocs = 0;
  let uninvoiced = 0;
  for (const r of rows) {
    const from = String(r.dispatched ?? "").slice(0, 10);
    if (!from) continue;
    const to = r.invoiced ? String(r.invoiced).slice(0, 10) : asAt;
    if (!r.invoiced) uninvoiced += 1;
    const late = Math.max(0, daysBetweenYmd(from, to) - grace);
    if (late > 0) {
      lateDays += late;
      lateDocs += 1;
    }
  }

  return {
    actual: lateDays,
    sampleSize: rows.length,
    detail:
      `${lateDays} days late across ${lateDocs} of ${rows.length} delivery orders` +
      (uninvoiced > 0 ? ` (${uninvoiced} still not invoiced, counted to ${asAt})` : ""),
  };
}

/** Whole days from one YYYY-MM-DD to another; negative clamps to 0. */
function daysBetweenYmd(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

/**
 * A supervisor's score for the month, or null if they have not rated it yet.
 *
 * Deliberately returns "not yet rated" rather than 0. An unrated month is the
 * supervisor's outstanding task, not the employee's failure, and scoring it as
 * a zero would quietly punish the employee for their manager's inaction.
 */
export async function manualRating(
  c: Context<Env>,
  period: string,
  userId: string,
  kpiKey: string,
): Promise<MetricResult> {
  const row = await c.var.DB.prepare(
    `SELECT score AS "score", note AS "note"
       FROM kpi_manual_ratings
      WHERE period = ? AND userId = ? AND kpiKey = ?
      LIMIT 1`,
  )
    .bind(period, userId, kpiKey)
    .first<{ score: number | null; note: string | null }>();

  if (!row || row.score === null || row.score === undefined) {
    return { actual: null, sampleSize: 0, detail: "Not yet rated by the supervisor" };
  }
  const score = Number(row.score) || 0;
  return {
    actual: score,
    sampleSize: 1,
    detail: row.note ? `${score}/100 — ${row.note}` : `${score}/100`,
  };
}

/**
 * How much of the daily exception list gets cleared.
 *
 * Compares the period's FIRST stored compliance snapshot with its LAST. The
 * snapshot table is a cache rebuilt many times a day, so a row is that day's
 * last build — good enough for a trend, and the only history that exists.
 * Only ~23 days are retained, so an older period legitimately has no answer;
 * it says so rather than inventing one.
 */
export async function exceptionsCleared(
  c: Context<Env>,
  period: string,
  excludeInvoiceBuckets = false,
): Promise<MetricResult> {
  const { start, end } = periodBounds(period);
  const res = await c.var.DB.prepare(
    `SELECT cache_key AS "day", data AS "payload"
       FROM reports_compliance_snapshot
      WHERE cache_key >= ? AND cache_key <= ?
      ORDER BY cache_key`,
  )
    .bind(start, end)
    .all<{ day: string; payload: unknown }>();

  const rows = res.results ?? [];
  if (rows.length < 2) {
    return {
      actual: null,
      sampleSize: rows.length,
      detail:
        rows.length === 0
          ? "No exception history for this period"
          : "Only one day recorded — needs at least two to show a trend",
    };
  }
  const totalOf = (p: unknown): number => {
    const d = typeof p === "string" ? safeParse(p) : p;
    const counts = (d as { counts?: Record<string, number> })?.counts ?? {};
    const total = Number(counts.total) || 0;
    if (!excludeInvoiceBuckets) return total;
    // The uninvoiced buckets are scored by the invoicing half of the same KPI.
    // Leaving them in here charged one late invoice twice — which is exactly
    // why the owner merged the two KPIs on 2026-08-07.
    const billed =
      (Number(counts.soNoInvoice) || 0) + (Number(counts.doNotInvoiced) || 0);
    return Math.max(0, total - billed);
  };
  const first = totalOf(rows[0].payload);
  const last = totalOf(rows[rows.length - 1].payload);
  if (first <= 0) return EMPTY;
  // Cleared share of what was open at the start. A month that ENDS with more
  // than it started scores 0 rather than a negative.
  const cleared = Math.max(0, first - last);
  const label = excludeInvoiceBuckets ? " non-invoice exceptions" : "";
  return {
    actual: Math.round((cleared / first) * 1000) / 10,
    sampleSize: rows.length,
    detail: `${first}${label} open at the start, ${last} at the end (${rows.length} days recorded)`,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * CHECKLIST — items ticked ÷ items defined.
 *
 * The denominator comes from the CODE catalogue, not the database, so nobody
 * can raise their own score by shortening the list. The ticks are facts about
 * what was done; the list is the standard, and the standard lives in one place.
 */
export async function checklistProgress(
  c: Context<Env>,
  userId: string,
  kpiKey: string,
  period: string,
  totalItems: number,
): Promise<MetricResult> {
  if (totalItems <= 0) return EMPTY;
  const row = await c.var.DB.prepare(
    `SELECT COUNT(*) AS n FROM kpi_checklist_ticks
      WHERE userId = ? AND period = ? AND kpiKey = ? AND done = TRUE
        AND itemIndex >= 0 AND itemIndex < ?`,
  )
    .bind(userId, period, kpiKey, totalItems)
    .first<{ n: number }>();
  const done = Math.min(totalItems, Number(row?.n) || 0);
  return {
    actual: Math.round((done / totalItems) * 1000) / 10,
    sampleSize: totalItems,
    detail: `${done} of ${totalItems} items done`,
  };
}

/**
 * SURVEY — the average of the replies received this month.
 *
 * One reply scores (sum of its five 1–5 answers ÷ 25) × 100, so five 5s is 100
 * and four 5s with one 4 is 96. The month's figure is the mean across replies;
 * a month with none has no figure rather than a zero, because nobody asking is
 * a different failure from customers answering badly, and scoring it as 0
 * would hide which one happened.
 */
export async function surveyMean(
  c: Context<Env>,
  userId: string,
  kpiKey: string,
  period: string,
): Promise<MetricResult> {
  const res = await c.var.DB.prepare(
    `SELECT q1, q2, q3, q4, q5 FROM kpi_survey_responses
      WHERE userId = ? AND kpiKey = ? AND period = ?`,
  )
    .bind(userId, kpiKey, period)
    .all<{ q1: number; q2: number; q3: number; q4: number; q5: number }>();
  const rows = res.results ?? [];
  if (rows.length === 0) {
    return { actual: null, sampleSize: 0, detail: "No replies received yet" };
  }
  let total = 0;
  for (const r of rows) {
    const sum = [r.q1, r.q2, r.q3, r.q4, r.q5].reduce(
      (a, v) => a + (Number(v) || 0),
      0,
    );
    total += (sum / 25) * 100;
  }
  const mean = Math.round((total / rows.length) * 10) / 10;
  return {
    actual: mean,
    sampleSize: rows.length,
    detail: `${mean} average across ${rows.length} repl${rows.length === 1 ? "y" : "ies"}`,
  };
}

/** Dispatch table — one entry per computable KPI. */
export async function computeMetric(
  c: Context<Env>,
  key: string,
  period: string,
): Promise<MetricResult> {
  switch (key) {
    case "customer_delivery_date":
      return customerDeliveryLate(c, period);
    case "setup_completeness":
      return setupCompleteness(c);
    case "documents_not_stuck":
      return documentsStuck(c, period);
    default:
      return EMPTY;
  }
}
