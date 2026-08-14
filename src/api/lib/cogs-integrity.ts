// ---------------------------------------------------------------------------
// cogs-integrity.ts — did every delivered unit actually get a cost?
//
// READ-ONLY BY CONSTRUCTION, and deliberately shipped BEFORE any repair.
//
// The defect it looks for
// -----------------------
// `consumeFGBatchesForDO` (do-cost-cascade.ts:163) FIFO-consumes fg_batches for
// each delivered line and returns `{ statements, totalCogsSen, shortages }`.
// `shortages` is every line it could not fully satisfy — goods that physically
// left the warehouse with no FG layer to draw cost from.
//
// The caller (routes/delivery-orders/_helpers.ts:4290) consumes ONLY
// `cogs.statements`. `cogs.shortages` is dropped on the floor, and there is no
// reconcile anywhere in routes/, lib/ or cron/. So those units ship with RM0
// COGS, the DO and its invoice show 100% margin, and nothing ever revisits it.
// `po-cost-cascade.ts:800` has the same shape for raw materials.
//
// Why a detector first
// --------------------
// Houzs-ERP's inventory-costing-oversell COE spends its section 6 on exactly
// this: they wrote the repair before they knew the size or the shape of the
// damage, and had to redo it. Costing is the last place to guess. This measures
// the exposure, in ringgit, from data — and writes nothing.
//
// Method
// ------
// Per delivered DO, compare the units that LEFT against the units the ledger
// paid for:
//
//   delivered = SUM(delivery_order_items.quantity)
//   costed    = SUM(cost_ledger.qty) WHERE type = 'FG_DELIVERED'
//                                      AND refType = 'DELIVERY_ORDER'
//                                      AND refId  = <do id>
//
// A DO with `costed < delivered` shipped uncosted units. A DO with NO ledger
// rows at all is reported separately (`kind: 'no_cost_at_all'`), because that
// is a different failure — the cascade never ran, rather than running short.
//
// Returns are NOT netted off: a return writes an ADJUSTMENT with
// refType='DELIVERY_RETURN', so it never lands in the sums above. That is
// correct here — the question is whether the ORIGINAL delivery was costed.
//
// Dialect traps this file was written against (both learned the hard way in
// pricing-integrity.ts, which is the sibling of this file):
//   * every alias is snake_case — Postgres folds an unquoted alias to lower
//     case and the adapter only re-camelCases names containing an underscore,
//     so `AS shortQty` would read back undefined and the number would silently
//     be 0. Guarded by scripts/audit-sql-aliases.mjs.
//   * a failed query used to be caught and reported as [] — "nothing uncosted".
//     It now RETHROWS and the daily report marks the check UNAVAILABLE
//     (2026-08-14, BUG-2026-08-13-141): silence about money is not a clean bill.
// ---------------------------------------------------------------------------

export type CogsIssueKind =
  /** Some units on this DO shipped without a cost layer to draw from. */
  | "partial_uncosted"
  /** The whole DO has no FG_DELIVERED ledger at all — the cascade never ran. */
  | "no_cost_at_all";

export type CogsIssueRow = {
  kind: CogsIssueKind;
  doId: string;
  doNo: string;
  customerName: string | null;
  deliveredAt: string | null;
  /** Units that physically left. */
  deliveredQty: number;
  /** Units the cost ledger actually paid for. */
  costedQty: number;
  /** deliveredQty - costedQty. Always > 0 for a reported row. */
  uncostedQty: number;
  /** What the costed units DID cost, in sen — the basis for the estimate. */
  costedSen: number;
  /**
   * Rough ringgit exposure: the uncosted units valued at this DO's own average
   * unit cost. NULL when nothing on the DO was costed, because then there is no
   * honest basis — better to report null than to invent a number.
   */
  estimatedMissingSen: number | null;
};

interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
  };
}

type Row = {
  doId?: string;
  do_id?: string;
  doNo?: string | null;
  do_no?: string | null;
  customerName?: string | null;
  customer_name?: string | null;
  deliveredAt?: string | null;
  delivered_at?: string | null;
  deliveredQty?: number | string | null;
  delivered_qty?: number | string | null;
  costedQty?: number | string | null;
  costed_qty?: number | string | null;
  costedSen?: number | string | null;
  costed_sen?: number | string | null;
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Every delivered DO whose cost ledger does not cover the units it shipped.
 *
 * Writes nothing. Never throws — an empty list on failure, the house style in
 * compliance-report.ts, so one bad query cannot take the daily sweep down.
 */
export async function checkCogsIntegrity(db: DbLike): Promise<CogsIssueRow[]> {
  try {
    const res = await db
      .prepare(
        `SELECT d.id                                   AS do_id,
                d.doNo                                 AS do_no,
                d.customerName                         AS customer_name,
                d.deliveredAt                          AS delivered_at,
                COALESCE(items.qty, 0)                 AS delivered_qty,
                COALESCE(led.qty, 0)                   AS costed_qty,
                COALESCE(led.sen, 0)                   AS costed_sen
           FROM delivery_orders d
           LEFT JOIN (
                  SELECT deliveryOrderId AS do_ref, SUM(quantity) AS qty
                    FROM delivery_order_items
                   GROUP BY deliveryOrderId
                ) items ON items.do_ref = d.id
           LEFT JOIN (
                  SELECT refId AS do_ref,
                         SUM(qty) AS qty,
                         SUM(totalCostSen) AS sen
                    FROM cost_ledger
                   WHERE type = 'FG_DELIVERED'
                     AND refType = 'DELIVERY_ORDER'
                     AND direction = 'OUT'
                   GROUP BY refId
                ) led ON led.do_ref = d.id
          WHERE d.deliveredAt IS NOT NULL
            AND COALESCE(items.qty, 0) > COALESCE(led.qty, 0)
          ORDER BY d.deliveredAt DESC`,
      )
      .bind()
      .all<Row>();

    const out: CogsIssueRow[] = [];
    for (const r of res.results ?? []) {
      const doId = r.doId ?? r.do_id ?? "";
      if (!doId) continue;
      const deliveredQty = num(r.deliveredQty ?? r.delivered_qty);
      const costedQty = num(r.costedQty ?? r.costed_qty);
      const costedSen = num(r.costedSen ?? r.costed_sen);
      const uncostedQty = deliveredQty - costedQty;
      if (uncostedQty <= 0) continue;
      out.push({
        kind: costedQty <= 0 ? "no_cost_at_all" : "partial_uncosted",
        doId,
        doNo: String(r.doNo ?? r.do_no ?? ""),
        customerName: r.customerName ?? r.customer_name ?? null,
        deliveredAt: r.deliveredAt ?? r.delivered_at ?? null,
        deliveredQty,
        costedQty,
        uncostedQty,
        costedSen,
        // Value the gap at what this DO's OWN costed units cost. No costed
        // units means no honest basis — report null rather than invent one.
        estimatedMissingSen:
          costedQty > 0 ? Math.round((costedSen / costedQty) * uncostedQty) : null,
      });
    }
    return out;
  } catch (err) {
    // Rethrow (2026-08-14, BUG-2026-08-13-141): `[]` here rendered as "every
    // delivered unit is costed", which is a money statement, made by a query
    // that failed. The caller records this check as UNAVAILABLE instead.
    console.error("[cogs-integrity] checkCogsIntegrity failed:", err);
    throw err;
  }
}

/** One-line headline for the daily report. */
export function summarizeCogsIssues(rows: CogsIssueRow[]): {
  orders: number;
  uncostedUnits: number;
  estimatedMissingSen: number;
  ordersWithNoBasis: number;
} {
  let uncostedUnits = 0;
  let estimatedMissingSen = 0;
  let ordersWithNoBasis = 0;
  for (const r of rows) {
    uncostedUnits += r.uncostedQty;
    if (r.estimatedMissingSen == null) ordersWithNoBasis += 1;
    else estimatedMissingSen += r.estimatedMissingSen;
  }
  return {
    orders: rows.length,
    uncostedUnits,
    estimatedMissingSen,
    ordersWithNoBasis,
  };
}
