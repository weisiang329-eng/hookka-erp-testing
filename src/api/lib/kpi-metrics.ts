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
  return {
    actual: late,
    sampleSize: shipped,
    detail: `${late} late of ${shipped} shipped`,
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
 * Documents sitting in the middle of the chain.
 *
 * Reads the SAME compliance snapshot the Daily Report renders, rather than
 * asking the question again in its own SQL. The first draft of this did write
 * its own query — "delivered more than 7 days ago with no invoice" — and
 * returned 0 while the Daily Report showed 139. Both were correct about
 * different things, which is exactly how a KPI loses its authority: the
 * employee sees 0 on their card and 139 on the dashboard and stops believing
 * either. One source, one number.
 *
 * `soNoInvoice` + `doNotInvoiced` are the two buckets that are Office's to
 * clear; the rest of the report belongs to other roles.
 */
export async function documentsStuck(
  c: Context<Env>,
  period: string,
): Promise<MetricResult> {
  const snap = await latestSnapshotIn(c, period);
  if (!snap) return EMPTY;
  const counts = snap.counts;
  const n = (Number(counts.soNoInvoice) || 0) + (Number(counts.doNotInvoiced) || 0);
  return {
    actual: n,
    sampleSize: Number(counts.total) || 0,
    detail: `${counts.soNoInvoice ?? 0} orders + ${counts.doNotInvoiced ?? 0} deliveries not invoiced (as at ${snap.day})`,
  };
}

/** The last compliance snapshot stored within the period, if any. */
async function latestSnapshotIn(
  c: Context<Env>,
  period: string,
): Promise<{ day: string; counts: Record<string, number> } | null> {
  const { start, end } = periodBounds(period);
  const row = await c.var.DB.prepare(
    `SELECT cache_key AS "day", data AS "payload"
       FROM reports_compliance_snapshot
      WHERE cache_key >= ? AND cache_key <= ?
      ORDER BY cache_key DESC LIMIT 1`,
  )
    .bind(start, end)
    .first<{ day: string; payload: unknown }>();
  if (!row) return null;
  const d = typeof row.payload === "string" ? safeParse(row.payload) : row.payload;
  return {
    day: String(row.day),
    counts: ((d as { counts?: Record<string, number> })?.counts ?? {}),
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
    return Number(counts.total) || 0;
  };
  const first = totalOf(rows[0].payload);
  const last = totalOf(rows[rows.length - 1].payload);
  if (first <= 0) return EMPTY;
  // Cleared share of what was open at the start. A month that ENDS with more
  // than it started scores 0 rather than a negative.
  const cleared = Math.max(0, first - last);
  return {
    actual: Math.round((cleared / first) * 1000) / 10,
    sampleSize: rows.length,
    detail: `${first} open at the start, ${last} at the end (${rows.length} days recorded)`,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
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
    case "exceptions_cleared":
      return exceptionsCleared(c, period);
    default:
      return EMPTY;
  }
}
