// ---------------------------------------------------------------------------
// on-time-delivery.ts — "did we deliver by the date the CUSTOMER was given?"
//
// Owner's rule, verbatim (2026-08-14):
//   「基本上就是看我们送货的时间减掉我们顾客的 delivery date，
//     就会知道有没有 on-time delivery 了」
//   — our delivery time minus the customer's delivery date.
//
// So there are exactly two dates, and this module uses only those two:
//   * `delivery_orders.delivered_at`     — when the goods actually arrived
//   * `sales_orders.customer_delivery_date` — the date the customer was given
//
// WHAT THIS REPLACES. The Hookka Report's "On-time delivery %" scored
// `delivery_orders.dispatched_at` against `delivery_orders.hookka_expected_dd`
// (operations-report.ts, before 2026-08-14). Both halves were wrong:
//   1. `hookka_expected_dd` is OUR OWN internal target, back-derived from the
//      customer's date minus a per-category buffer (`sales-orders.ts`, the
//      `loadHookkaDDBuffer` block). Scoring it is marking our own homework —
//      `kpi-metrics.ts:18-19` states the prohibition outright.
//   2. Dispatch is not delivery. Leaving the yard on time and arriving late is
//      100% on-time under the old measure.
//   Its denominator also required `dispatched_at IS NOT NULL`, so an order
//   never dispatched at all — the worst outcome there is — was EXCLUDED, and
//   lateness could only ever be under-reported.
//
// THE JOIN. `delivery_orders.sales_order_id` is populated on only about half
// the DOs, and `delivery_order_items.sales_order_no` is a stale denormalised
// string. The path that resolves is the one `kpi-metrics.ts` measured and uses:
//     delivery_orders → delivery_order_items.production_order_id
//                     → production_orders.sales_order_id → sales_orders
// This module deliberately shares that path so the two surfaces cannot drift
// into disagreeing about which shipments exist.
//
// THE UNIT OF MEASURE IS THE SALES ORDER, not the delivery order. A customer
// promised one date and sent three lorries was let down once, not three times —
// the same reasoning `customerDeliveryLate` records. So an SO is judged on its
// LAST delivery: the customer's order is complete when the final piece lands.
//
// WHAT IS EXCLUDED, AND WHY EVERY EXCLUSION IS PUBLISHED
// (BUG-2026-08-13-096: a percentage over an incomplete population must state
// its coverage, or "0 problems" is indistinguishable from "cannot see"):
//
//   * `excludedNotDelivered` — the SO still has a live DO with no
//     `delivered_at`. Not yet delivered is NOT late: the delivery has not
//     finished, so there is nothing to score. Counting it as late would invent
//     failures; counting it as on-time would hide them. It is excluded and
//     reported, and it is the number to watch — a large one means the metric is
//     measuring a small corner of the book.
//   * `excludedNoCustomerDate` — the SO carries no `customer_delivery_date`.
//     There is no promise to score against, so no verdict is possible.
//   * PART-DELIVERIES are NOT a separate exclusion. A part-delivered SO always
//     has an undelivered leg, so it lands in `excludedNotDelivered` by
//     construction; once the last leg is delivered the SO is judged on that
//     last date. Nothing is double-counted and nothing silently qualifies on
//     the strength of its first lorry.
//   * CANCELLED DOs are ignored entirely, on both sides — a cancelled delivery
//     is neither a late one nor an outstanding one.
//
// `coveragePct` is judged ÷ (judged + both exclusions). `onTimePct` is null,
// never 0 or 100, when nothing is judgeable.
// ---------------------------------------------------------------------------

/** The narrow DB surface this module needs (matches compliance-report.ts). */
export interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

export interface OnTimeDelivery {
  /** on-time ÷ judged, 1dp. Null when nothing could be judged. */
  onTimePct: number | null;
  /** Sales orders fully delivered in the window AND carrying a customer date. */
  judged: number;
  onTime: number;
  late: number;
  /** Delivered, but the SO has no customer-committed date to score against. */
  excludedNoCustomerDate: number;
  /** Has a delivery in the window but is not fully delivered yet. */
  excludedNotDelivered: number;
  /** judged ÷ (judged + exclusions), 1dp. Null when the population is empty. */
  coveragePct: number | null;
  /** Every sales order this metric looked at, judged or not. */
  population: number;
  /**
   * Plain-English provenance, printed beside the figure. C15's third
   * corollary: publish the provenance next to the number, not in a doc.
   */
  basis: string;
}

export const EMPTY_ON_TIME: OnTimeDelivery = {
  onTimePct: null,
  judged: 0,
  onTime: 0,
  late: 0,
  excludedNoCustomerDate: 0,
  excludedNotDelivered: 0,
  coveragePct: null,
  population: 0,
  basis:
    "delivered_at vs the customer's delivery date, per sales order (last delivery counts)",
};

interface OnTimeRow {
  soId: string;
  customerDeliveryDate: string | null;
  lastDeliveredOn: string | null;
  openLegs: number | string | null;
  /** dual-key: the pg shim camelCases, but never assume it */
  so_id?: string;
  customer_delivery_date?: string | null;
  last_delivered_on?: string | null;
  open_legs?: number | string | null;
}

/**
 * On-time delivery for [startYmd, endYmd], bucketed by the SO's LAST delivery.
 *
 * An SO enters the population when at least one of its non-cancelled DOs was
 * delivered inside the window. `open_legs` counts its non-cancelled DOs that
 * carry no `delivered_at` — across the WHOLE order, not just the window, so a
 * part-delivery cannot qualify on a window technicality.
 */
export async function collectOnTimeDelivery(
  db: DbLike,
  startYmd: string,
  endYmd: string,
): Promise<OnTimeDelivery> {
  const res = await db
    .prepare(
      `WITH so_delivery AS (
         SELECT po.salesOrderId AS so_id,
                MAX(substr(d.deliveredAt::text, 1, 10)) AS last_delivered_on,
                SUM(CASE WHEN d.deliveredAt IS NULL OR d.deliveredAt::text = ''
                         THEN 1 ELSE 0 END) AS open_legs
           FROM delivery_orders d
           JOIN delivery_order_items di ON di.deliveryOrderId = d.id
           JOIN production_orders po ON po.id = di.productionOrderId
          WHERE d.status <> 'CANCELLED'
            AND po.salesOrderId IS NOT NULL AND po.salesOrderId <> ''
          GROUP BY po.salesOrderId
       )
       SELECT s.so_id AS "soId",
              substr(so.customerDeliveryDate::text, 1, 10) AS "customerDeliveryDate",
              s.last_delivered_on AS "lastDeliveredOn",
              s.open_legs AS "openLegs"
         FROM so_delivery s
         JOIN sales_orders so ON so.id = s.so_id
        WHERE s.last_delivered_on IS NOT NULL
          AND s.last_delivered_on >= ?
          AND s.last_delivered_on <= ?`,
    )
    .bind(startYmd, endYmd)
    .all<OnTimeRow>();

  return summarizeOnTimeRows(res.results ?? []);
}

/**
 * The verdict logic, split out from the query so it is testable without a DB.
 * Exported for `tests/on-time-delivery.test.mjs`.
 */
export function summarizeOnTimeRows(rows: OnTimeRow[]): OnTimeDelivery {
  let onTime = 0;
  let late = 0;
  let excludedNoCustomerDate = 0;
  let excludedNotDelivered = 0;

  for (const r of rows) {
    const openLegs = Number(r.openLegs ?? r.open_legs ?? 0) || 0;
    if (openLegs > 0) {
      // Still going out. Not late — not yet judgeable at all.
      excludedNotDelivered += 1;
      continue;
    }
    const due = String(r.customerDeliveryDate ?? r.customer_delivery_date ?? "")
      .slice(0, 10)
      .trim();
    const delivered = String(r.lastDeliveredOn ?? r.last_delivered_on ?? "")
      .slice(0, 10)
      .trim();
    if (!due) {
      excludedNoCustomerDate += 1;
      continue;
    }
    if (!delivered) {
      // Defensive: the query cannot produce this (last_delivered_on is NOT
      // NULL there), but an empty string would otherwise compare as "on time".
      excludedNotDelivered += 1;
      continue;
    }
    // Both are YYYY-MM-DD, so a string compare IS a date compare. Delivering ON
    // the promised day is ON TIME — the customer asked for that date, not for
    // the day before it.
    if (delivered <= due) onTime += 1;
    else late += 1;
  }

  const judged = onTime + late;
  const population =
    judged + excludedNoCustomerDate + excludedNotDelivered;
  const pct1 = (num: number, den: number) =>
    den > 0 ? Math.round((num / den) * 1000) / 10 : null;

  return {
    onTimePct: pct1(onTime, judged),
    judged,
    onTime,
    late,
    excludedNoCustomerDate,
    excludedNotDelivered,
    coveragePct: pct1(judged, population),
    population,
    basis: EMPTY_ON_TIME.basis,
  };
}
