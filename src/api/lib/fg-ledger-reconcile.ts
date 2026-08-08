// ---------------------------------------------------------------------------
// fg-ledger-reconcile.ts — the check that the two finished-goods ledgers agree.
//
// WHY THIS SHIPS IN THE SAME COMMIT AS THE EVENT TABLE, NOT LATER.
// Houzs shipped the same two-ledger shape — a per-unit stock ledger beside a
// per-lot cost ledger — and the two halves diverged in production. Their own
// post-mortem's conclusion was not "the arithmetic was wrong": it was that
// NOTHING EVER CHECKED THAT THE TWO AGREED, so the drift was only discovered
// once it was months deep and no longer attributable to any one document. A
// second ledger without a reconciliation is a second thing to be wrong.
//
// THE THREE TOTALS, per product code:
//
//   ledgerBalance  Σ fg_stock_events.direction — what the event trail claims we
//                  hold. Cannot be computed any other way: `direction` is
//                  onHand(to) − onHand(from), assigned by fg-stock-events.ts.
//   onHandUnits    COUNT of fg_units whose status is on hand — the per-piece
//                  identity table, the thing an operator can physically count.
//   lotRemaining   Σ fg_batches.remaining_qty — the COST side, what the FIFO
//                  engine will hand to COGS.
//
// AND ONE BRIDGING TERM, named rather than hidden:
//
//   inFlightUnits  units stamped LOADED. The two halves book a dispatch at
//                  DIFFERENT moments and always have: fg_units/stock_movements
//                  book it at DISPATCH (LOADED — the rack is emptied, the
//                  STOCK_OUT is written), fg_batches books it at DELIVERY
//                  (consumeFGBatchesForDO runs on the DELIVERED edge). So a
//                  piece on a truck is legitimately out of one ledger and still
//                  in the other. That is a timing difference, not a break, and
//                  the ONLY safe way to treat it is to subtract it explicitly
//                  and say so. Absorbing it into a tolerance is how a real
//                  break gets to hide behind a legitimate one.
//
// The two identities checked:
//   (A) ledgerBalance == onHandUnits                  — events vs pieces
//   (B) onHandUnits   == lotRemaining − inFlightUnits — pieces vs cost lots
//
// READ-ONLY, and safe to run at any time. It exits non-zero on a GENUINE
// disagreement only; a product with no stock on any of the three sides is not
// reported.
//
// EXPECTED TO FAIL ON PRODUCTION TODAY, AND THAT IS THE POINT. Identity (B)
// breaks hard right now: 379 fg_batches lots carry a NEGATIVE remaining_qty
// (−911 units) and 145 production orders carry DUPLICATE lots that double-count
// their output. Those numbers were invisible because nothing read fg_batches
// per unit. Making them visible is this task; repairing them is an owner-gated
// data decision and is deliberately NOT done here.
// ---------------------------------------------------------------------------
import type { D1Database } from "@cloudflare/workers-types";
import { FG_ONHAND_STATUSES } from "./fg-stock-events";

export type FgReconcileInput = {
  /** product_code → Σ fg_stock_events.direction */
  ledgerBalance: Map<string, number>;
  /** product_code → COUNT(fg_units) in an on-hand status */
  onHandUnits: Map<string, number>;
  /** product_code → COUNT(fg_units) stamped LOADED */
  inFlightUnits: Map<string, number>;
  /** product_code → Σ fg_batches.remaining_qty */
  lotRemaining: Map<string, number>;
  /** events whose fg_unit no longer exists — informational, never a failure */
  orphanEvents?: number;
  /** units carrying no event at all — the opening-balance seed has not run */
  unitsWithoutEvents?: number;
};

export type FgReconcileRow = {
  productCode: string;
  ledgerBalance: number;
  onHandUnits: number;
  inFlightUnits: number;
  lotRemaining: number;
  /** lotRemaining bridged to the dispatch boundary onHandUnits is measured at */
  lotRemainingAtDispatch: number;
  eventsVsUnits: number;
  unitsVsLots: number;
  ok: boolean;
};

export type FgReconcileResult = {
  ok: boolean;
  rows: FgReconcileRow[];
  disagreements: FgReconcileRow[];
  totals: {
    ledgerBalance: number;
    onHandUnits: number;
    inFlightUnits: number;
    lotRemaining: number;
  };
  orphanEvents: number;
  unitsWithoutEvents: number;
  /** Human-readable reasons, empty when ok. */
  problems: string[];
};

/**
 * The pure comparison. Kept free of any DB so both the test suite and the
 * ops script drive the SAME arithmetic — a reconciliation with two
 * implementations reconciles nothing.
 */
export function diffFgReconciliation(input: FgReconcileInput): FgReconcileResult {
  const codes = new Set<string>([
    ...input.ledgerBalance.keys(),
    ...input.onHandUnits.keys(),
    ...input.inFlightUnits.keys(),
    ...input.lotRemaining.keys(),
  ]);

  const rows: FgReconcileRow[] = [];
  for (const productCode of [...codes].sort()) {
    const ledgerBalance = input.ledgerBalance.get(productCode) ?? 0;
    const onHandUnits = input.onHandUnits.get(productCode) ?? 0;
    const inFlightUnits = input.inFlightUnits.get(productCode) ?? 0;
    const lotRemaining = input.lotRemaining.get(productCode) ?? 0;
    // A product that is zero on every side is not evidence of anything.
    if (
      ledgerBalance === 0 &&
      onHandUnits === 0 &&
      inFlightUnits === 0 &&
      lotRemaining === 0
    )
      continue;
    const lotRemainingAtDispatch = lotRemaining - inFlightUnits;
    const eventsVsUnits = ledgerBalance - onHandUnits;
    const unitsVsLots = onHandUnits - lotRemainingAtDispatch;
    rows.push({
      productCode,
      ledgerBalance,
      onHandUnits,
      inFlightUnits,
      lotRemaining,
      lotRemainingAtDispatch,
      eventsVsUnits,
      unitsVsLots,
      ok: eventsVsUnits === 0 && unitsVsLots === 0,
    });
  }

  const disagreements = rows.filter((r) => !r.ok);
  const totals = {
    ledgerBalance: rows.reduce((s, r) => s + r.ledgerBalance, 0),
    onHandUnits: rows.reduce((s, r) => s + r.onHandUnits, 0),
    inFlightUnits: rows.reduce((s, r) => s + r.inFlightUnits, 0),
    lotRemaining: rows.reduce((s, r) => s + r.lotRemaining, 0),
  };

  const problems: string[] = [];
  const eventsBroken = rows.filter((r) => r.eventsVsUnits !== 0);
  const lotsBroken = rows.filter((r) => r.unitsVsLots !== 0);
  if (eventsBroken.length > 0) {
    problems.push(
      `${eventsBroken.length} product(s): the event trail and the fg_units table disagree ` +
        `about how many pieces are on hand (Σ events ≠ unit count).`,
    );
  }
  if (lotsBroken.length > 0) {
    problems.push(
      `${lotsBroken.length} product(s): the on-hand pieces and the fg_batches cost lots disagree ` +
        `(unit count ≠ Σ remaining_qty − in-flight).`,
    );
  }
  // Informational, NEVER a failure: an fg_unit that a regenerate/de-dupe repair
  // deleted takes its events with it (ON DELETE CASCADE), so a non-zero count
  // here means a repair ran, not that the book is wrong.
  const orphanEvents = input.orphanEvents ?? 0;
  const unitsWithoutEvents = input.unitsWithoutEvents ?? 0;

  return {
    ok: problems.length === 0,
    rows,
    disagreements,
    totals,
    orphanEvents,
    unitsWithoutEvents,
    problems,
  };
}

// ---------------------------------------------------------------------------
// The DB-backed gatherer. Four aggregate reads, no writes, no locks.
// ---------------------------------------------------------------------------
type CountRow = { code: string | null; n: number | string | null };

function toMap(rows: CountRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const code = r.code ?? "(no product code)";
    m.set(code, (m.get(code) ?? 0) + Number(r.n ?? 0));
  }
  return m;
}

export async function gatherFgReconciliation(
  db: D1Database,
  orgId = "hookka",
): Promise<FgReconcileInput> {
  const onHandList = FG_ONHAND_STATUSES.map(() => "?").join(",");

  // (1) the event trail. Only events whose unit still exists count toward the
  // balance — see the orphan note above.
  const ledger = await db
    .prepare(
      `SELECT e.product_code AS "code", SUM(e.direction) AS "n"
         FROM fg_stock_events e
         JOIN fg_units u ON u.id = e.fg_unit_id
        WHERE e.org_id = ?
        GROUP BY e.product_code`,
    )
    .bind(orgId)
    .all<CountRow>();

  // (2) the pieces we say we hold.
  const onHand = await db
    .prepare(
      `SELECT productCode AS "code", COUNT(*) AS "n"
         FROM fg_units
        WHERE orgId = ? AND status IN (${onHandList})
        GROUP BY productCode`,
    )
    .bind(orgId, ...FG_ONHAND_STATUSES)
    .all<CountRow>();

  // (3) the bridging term — dispatched, not yet delivered.
  const inFlight = await db
    .prepare(
      `SELECT productCode AS "code", COUNT(*) AS "n"
         FROM fg_units
        WHERE orgId = ? AND status = 'LOADED'
        GROUP BY productCode`,
    )
    .bind(orgId)
    .all<CountRow>();

  // (4) the cost side.
  const lots = await db
    .prepare(
      `SELECT p.code AS "code", SUM(b.remainingQty) AS "n"
         FROM fg_batches b
         LEFT JOIN products p ON p.id = b.productId
        WHERE b.orgId = ?
        GROUP BY p.code`,
    )
    .bind(orgId)
    .all<CountRow>();

  const orphans = await db
    .prepare(
      `SELECT COUNT(*) AS "n" FROM fg_stock_events e
        WHERE e.org_id = ?
          AND NOT EXISTS (SELECT 1 FROM fg_units u WHERE u.id = e.fg_unit_id)`,
    )
    .bind(orgId)
    .first<{ n: number | string | null }>();

  const unseeded = await db
    .prepare(
      `SELECT COUNT(*) AS "n" FROM fg_units u
        WHERE u.orgId = ?
          AND NOT EXISTS (SELECT 1 FROM fg_stock_events e WHERE e.fg_unit_id = u.id)`,
    )
    .bind(orgId)
    .first<{ n: number | string | null }>();

  return {
    ledgerBalance: toMap(ledger.results ?? []),
    onHandUnits: toMap(onHand.results ?? []),
    inFlightUnits: toMap(inFlight.results ?? []),
    lotRemaining: toMap(lots.results ?? []),
    orphanEvents: Number(orphans?.n ?? 0),
    unitsWithoutEvents: Number(unseeded?.n ?? 0),
  };
}

export async function reconcileFgStock(
  db: D1Database,
  orgId = "hookka",
): Promise<FgReconcileResult> {
  return diffFgReconciliation(await gatherFgReconciliation(db, orgId));
}
