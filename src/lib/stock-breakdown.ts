// ---------------------------------------------------------------------------
// stock-breakdown.ts — the pure rules behind the Stock Breakdown drawer.
//
// Everything in here is deliberately free of database and React so the same
// function decides the number on the screen and the number in the test. Two
// rules matter more than the rest:
//
//   1. THE RUNNING BALANCE IS DERIVED, NEVER STORED. `withRunningBalance`
//      replays the movements in chronological order and hands each row the
//      balance as at that row. Storing it is exactly how `wip_items` drifted:
//      a stored total and a movement list are two sources for one fact, and
//      the moment a write path misses one they disagree forever. Derived, they
//      cannot.
//
//   2. A LEDGER THAT CANNOT BE RECONCILED SAYS SO. `reconciliationOf` looks at
//      what the movements actually contain and refuses to produce a balance
//      when the ledger is structurally incomplete — WIP records inbound work
//      and no consumption, so a "balance" there would be a running total of
//      one side of a two-sided story. A screen that quietly shows a wrong
//      number is worse than one that says it does not know.
// ---------------------------------------------------------------------------

export type StockItemType = "RM" | "WIP" | "FG";

/** Documents a movement can point back at. */
export type SourceDocType =
  | "GRN"
  | "PURCHASE_ORDER"
  | "PRODUCTION_ORDER"
  | "DELIVERY_ORDER"
  | "SALES_ORDER"
  | "JOB_CARD";

/**
 * One row of the movement ledger, as the drawer renders it.
 *
 * `balanceAfter` is filled in by `withRunningBalance` — a route must never
 * populate it from a stored column, and it stays null when the ledger cannot
 * be reconciled (see `reconciliationOf`).
 */
export interface StockMovement {
  id: string;
  /** ISO timestamp. */
  date: string;
  direction: "IN" | "OUT";
  /** cost_ledger.type — RM_RECEIPT / RM_ISSUE / FG_COMPLETED / … */
  type: string;
  qty: number;
  unitCostSen: number;
  totalCostSen: number;
  /** DERIVED. Null when the ledger is not reconcilable. */
  balanceAfter: number | null;

  /** The clickable source document. Null when the document no longer exists. */
  docType: SourceDocType | null;
  docId: string | null;
  docNo: string | null;
  /** In-app link, or null when nothing can be opened. */
  docHref: string | null;

  // --- per-flavour extras. Every one of these is optional and renders as an
  // em dash when absent; no column is dropped just because the data is thin.
  supplierName?: string | null;
  /** Purchasing PO behind a receipt. */
  purchaseOrderNo?: string | null;
  purchaseOrderHref?: string | null;
  /** Production order behind an issue / completion. */
  productionOrderNo?: string | null;
  productionOrderHref?: string | null;
  department?: string | null;
  /** Who physically took the material. */
  takenByName?: string | null;
  jobCardNo?: string | null;
  jobCardHref?: string | null;
  salesOrderNo?: string | null;
  salesOrderHref?: string | null;
  customerName?: string | null;
  /** FG OUT — the exact pieces that left. */
  unitSerials?: string[];

  batchId?: string | null;
  notes?: string | null;
}

/** A raw-material FIFO lot — one `rm_batches` row. */
export interface RmLot {
  kind: "RM_LOT";
  id: string;
  /** No warehouse dimension exists for RM today; null renders as an em dash. */
  warehouse: string | null;
  /** Free-text descriptors carried on the lot (grade, colour, width…). */
  attributes: string | null;
  qty: number;
  originalQty: number;
  consumedQty: number;
  unitCostSen: number;
  valueSen: number;
  source: string;
  grnNo: string | null;
  grnHref: string | null;
  purchaseOrderNo: string | null;
  purchaseOrderHref: string | null;
  supplierName: string | null;
  receivedDate: string | null;
  ageDays: number | null;
}

/** A finished-good piece — one `fg_units` row. */
export interface FgLot {
  kind: "FG_UNIT";
  id: string;
  serial: string;
  shortCode: string | null;
  attributes: string | null;
  qty: number;
  /** Null until the FG write-side ledger stamps fg_units.batchId. */
  unitCostSen: number | null;
  valueSen: number | null;
  productionOrderNo: string | null;
  productionOrderHref: string | null;
  mfdDate: string | null;
  ageDays: number | null;
  /** The sales order that has claimed this piece, if any. */
  claimedBySoNo: string | null;
  claimedBySoHref: string | null;
  customerName: string | null;
  status: string;
  deliveryOrderNo: string | null;
  deliveryOrderHref: string | null;
}

/**
 * A WIP "lot" is a JOB CARD — the piece of work that produced this WIP item on
 * one production order.
 *
 * It carries no unit cost and no value, and that is not an omission. WIP has no
 * FIFO cost layer in this system: nothing is ever costed per WIP piece, only
 * labour minutes are booked per job card. The two labour fields are named for
 * what they are so they cannot be mistaken for a stock valuation — `laborPosted`
 * is what was booked on that job card for all the pieces it made, not the value
 * of the ones still sitting on the floor.
 */
export interface WipLot {
  kind: "WIP_LOT";
  /** The job card id. */
  id: string;
  productionOrderNo: string | null;
  productionOrderHref: string | null;
  department: string | null;
  jobCardNo: string | null;
  jobCardHref: string | null;
  salesOrderNo: string | null;
  salesOrderHref: string | null;
  /** Pieces this job card produced. */
  qty: number;
  status: string | null;
  laborMinutes: number | null;
  laborPostedSen: number | null;
  completedDate: string | null;
  ageDays: number | null;
}

export type StockLot = RmLot | FgLot | WipLot;

/** One FIFO consumption — which layer paid for an outbound movement. */
export interface CogsRow {
  id: string;
  consumedAt: string;
  docType: SourceDocType | null;
  docNo: string | null;
  docHref: string | null;
  qty: number;
  unitCostSen: number;
  totalCostSen: number;
  /** The rm_batches lot (RM) or fg_units serial (FG) it came out of. */
  fromLotId: string | null;
  fromLotLabel: string | null;
}

export interface StockBreakdownHeader {
  itemType: StockItemType;
  itemId: string;
  itemCode: string;
  itemName: string;
  uom: string;
  /** Owned quantity. Null when the ledger cannot support a figure. */
  totalQty: number | null;
  /** Committed to a customer document. */
  assignedQty: number | null;
  freeQty: number | null;
  /**
   * A short caption under the total, for when the counting unit needs saying
   * out loud — finished goods are counted in PIECES here (one lot row is one
   * piece) and a bed is three of them, so "262" without "= 137 units" invites
   * the wrong read. Null when the number speaks for itself.
   */
  qtyNote: string | null;
  totalValueSen: number | null;
  /**
   * Why the value is partial, when it is. Finished-goods pieces carry no cost
   * until the write-side ledger stamps fg_units.batchId, so a total that
   * silently covered only the priced third of the shelf would be a lie by
   * omission. Null when every layer is priced.
   */
  valuationNote: string | null;
  /** Age of the OLDEST owned layer — the FIFO one, consumed next. */
  oldestAgeDays: number | null;
  oldestLayerDate: string | null;
  reconciliation: Reconciliation;
  /** Does the movement ledger add up to the on-hand figure? */
  ledgerVsOnHand: LedgerVsOnHand;
}

export interface StockBreakdown {
  header: StockBreakdownHeader;
  lots: StockLot[];
  movements: StockMovement[];
  cogs: CogsRow[];
}

// ---------------------------------------------------------------------------
// Reconciliation — can this ledger produce a balance at all?
// ---------------------------------------------------------------------------

export interface Reconciliation {
  /** True only when both sides of the ledger are recorded. */
  reconcilable: boolean;
  /** Plain-English reason, rendered verbatim on the panel. Null when fine. */
  notice: string | null;
  inCount: number;
  outCount: number;
}

/**
 * Decide whether a running balance means anything for this movement list.
 *
 * The failure this guards against is specific and has already happened once in
 * this codebase: WIP accumulates inbound rows (labour posted, work completed)
 * and records no consumption, so summing IN − OUT yields a number that only
 * ever grows and matches no physical count. Rendering it would look like a
 * reconciled figure. It is not one.
 *
 * An item with no movements at all is reconcilable — zero in, zero out, and a
 * balance of zero is the honest answer.
 */
export function reconciliationOf(
  itemType: StockItemType,
  movements: Pick<StockMovement, "direction">[],
): Reconciliation {
  let inCount = 0;
  let outCount = 0;
  for (const m of movements) {
    if (m.direction === "IN") inCount++;
    else outCount++;
  }

  if (itemType === "WIP") {
    return {
      reconcilable: false,
      notice:
        "Outbound movements are not recorded for WIP. Every row below is " +
        "inbound work booked against a production order — nothing is written " +
        "when that work is consumed by the next department or turned into a " +
        "finished good. A running balance would therefore only ever grow, so " +
        "none is shown and this figure cannot be reconciled against a " +
        "physical count.",
      inCount,
      outCount,
    };
  }

  if (inCount === 0 && outCount > 0) {
    return {
      reconcilable: false,
      notice:
        "This item has outbound movements but no inbound ones, so the ledger " +
        "cannot account for where the stock came from. No running balance is " +
        "shown.",
      inCount,
      outCount,
    };
  }

  return { reconcilable: true, notice: null, inCount, outCount };
}

// ---------------------------------------------------------------------------
// Ledger vs on-hand
// ---------------------------------------------------------------------------

/**
 * Whether the movement ledger, summed, lands on the on-hand figure.
 *
 * These are two different sources for one fact and on live data they disagree,
 * for a reason worth naming rather than papering over: opening-balance stock
 * was seeded straight in as FIFO layers when the system was cut over, and no
 * inbound movement was written for it. So the movement ledger starts life short
 * by exactly the opening seed. On prod that accounts for 278 of 279 raw
 * materials — the discrepancy is systematic, not per-item corruption.
 *
 * We do not "fix" it by inventing an opening movement row. The ledger is
 * append-only and says what it says; the panel explains the gap instead.
 */
export interface LedgerVsOnHand {
  /** Closing balance implied by the movements. Null when not reconcilable. */
  ledgerClosingQty: number | null;
  /** On-hand from the FIFO layers — the figure costing actually uses. */
  onHandQty: number | null;
  /** Quantity seeded as opening layers with no matching inbound movement. */
  openingSeedQty: number;
  agrees: boolean;
  /** Plain-English explanation, or null when the two agree. */
  note: string | null;
}

export function ledgerVsOnHand(
  ledgerClosingQty: number | null,
  onHandQty: number | null,
  openingSeedQty: number,
  /**
   * A known, specific reason the two differ, appended to the note. Use it only
   * where the cause is understood — a vague reassurance is worse than the bare
   * numbers, because it implies somebody has checked.
   */
  explain?: string | null,
): LedgerVsOnHand {
  const base: Omit<LedgerVsOnHand, "agrees" | "note"> = {
    ledgerClosingQty,
    onHandQty,
    openingSeedQty,
  };
  if (ledgerClosingQty === null || onHandQty === null) {
    return { ...base, agrees: false, note: null };
  }
  const direct = Math.abs(ledgerClosingQty - onHandQty) < 0.01;
  if (direct) return { ...base, agrees: true, note: null };

  const withSeed = Math.abs(ledgerClosingQty + openingSeedQty - onHandQty) < 0.01;
  if (withSeed && openingSeedQty > 0) {
    return {
      ...base,
      agrees: true,
      note:
        `The running balance below closes at ${fmtQty(ledgerClosingQty)}, not ` +
        `${fmtQty(onHandQty)}. The difference is the opening balance of ` +
        `${fmtQty(openingSeedQty)}, which was seeded straight in as a FIFO ` +
        `layer at cut-over and has no inbound movement row. Add it back and ` +
        `the ledger reconciles exactly.`,
    };
  }
  return {
    ...base,
    agrees: false,
    note:
      `The running balance below closes at ${fmtQty(ledgerClosingQty)} but the ` +
      `stock lots hold ${fmtQty(onHandQty)}` +
      (openingSeedQty > 0
        ? `, and the ${fmtQty(openingSeedQty)} opening balance does not close ` +
          `the gap either`
        : "") +
      `. The two do not reconcile and neither figure has been adjusted to ` +
      `match the other.` +
      (explain ? ` ${explain}` : ""),
  };
}

function fmtQty(n: number): string {
  return String(roundQty(n));
}

// ---------------------------------------------------------------------------
// Finished-goods honesty helpers
// ---------------------------------------------------------------------------

/**
 * A finished-goods piece's unit cost, or null when nobody has costed it.
 *
 * Two sources in priority order, and no third:
 *   • the piece's OWN cost layer, via fg_units.batchId. This is the right
 *     answer. The write side that fills that column landed on 2026-08-08 but
 *     the prod backfill has not been run, so today it matches nothing; it takes
 *     over on its own the moment the column is populated, with no change here;
 *   • the FG completion posted for the piece's production order. Same product,
 *     same PO, the figure the accounting cascade actually booked.
 *
 * When neither exists the answer is null, which renders as an em dash. It is
 * not zero: zero is a cost, and a free sofa is a different claim from an
 * uncosted one.
 */
export function fgUnitCostSen(
  batchUnitCostSen: number | null | undefined,
  productionOrderUnitCostSen: number | null | undefined,
): number | null {
  if (batchUnitCostSen !== null && batchUnitCostSen !== undefined) {
    return batchUnitCostSen;
  }
  if (
    productionOrderUnitCostSen !== null &&
    productionOrderUnitCostSen !== undefined
  ) {
    return productionOrderUnitCostSen;
  }
  return null;
}

/**
 * Why the total value is partial, or null when it is complete.
 *
 * A total that silently covered only the priced part of the shelf would be a
 * lie by omission — it looks like the value of everything and is the value of
 * some of it.
 */
export function valuationNote(
  pricedCount: number,
  totalCount: number,
): string | null {
  if (totalCount === 0 || pricedCount >= totalCount) return null;
  return (
    `Only ${pricedCount} of ${totalCount} piece(s) on hand carry a cost, so the ` +
    `total above values those and no others. A piece has no cost when it is ` +
    `not linked to a cost lot and no finished-goods completion was posted for ` +
    `its production order.`
  );
}

/** Says out loud that finished goods are counted in pieces, not units. */
export function piecesNote(pieces: number, units: number): string | null {
  if (pieces === 0) return null;
  return (
    `${pieces} piece(s) = ${units} sellable unit(s). A bed or sofa ships as ` +
    `several pieces and each one is a row below.`
  );
}

// ---------------------------------------------------------------------------
// Running balance
// ---------------------------------------------------------------------------

/**
 * Attach the derived running balance to each movement.
 *
 * `movements` may arrive in any order. The balance is computed OLDEST FIRST
 * (the SQL equivalent is
 *   SUM(CASE WHEN direction='IN' THEN qty ELSE -qty END)
 *     OVER (PARTITION BY item_type, item_id ORDER BY date, id)
 * ) and the result is returned NEWEST FIRST, which is how the drawer reads.
 *
 * When the ledger is not reconcilable every `balanceAfter` is null. That is the
 * whole point — the column renders as an em dash rather than a plausible lie.
 */
export function withRunningBalance(
  movements: StockMovement[],
  reconciliation: Reconciliation,
): StockMovement[] {
  const oldestFirst = [...movements].sort(compareOldestFirst);

  if (!reconciliation.reconcilable) {
    return oldestFirst.reverse().map((m) => ({ ...m, balanceAfter: null }));
  }

  let running = 0;
  const stamped = oldestFirst.map((m) => {
    running += m.direction === "IN" ? m.qty : -m.qty;
    // Float qty (RM is metres / kilos) accumulates representation error over
    // a thousand rows; round to the same 3dp the rest of the app stores.
    running = roundQty(running);
    return { ...m, balanceAfter: running };
  });
  return stamped.reverse();
}

/** The closing balance implied by a movement list, or null when meaningless. */
export function closingBalance(
  movements: StockMovement[],
  reconciliation: Reconciliation,
): number | null {
  if (!reconciliation.reconcilable) return null;
  let running = 0;
  for (const m of movements) running += m.direction === "IN" ? m.qty : -m.qty;
  return roundQty(running);
}

export function roundQty(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Chronological, with id as the tiebreak so the order is total and stable. */
export function compareOldestFirst(
  a: Pick<StockMovement, "date" | "id">,
  b: Pick<StockMovement, "date" | "id">,
): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Source-document links
// ---------------------------------------------------------------------------

/**
 * The in-app URL for a source document, or null when there is nothing to open.
 *
 * Traceability is the entire point of this screen, so a null here is a real
 * statement: either the document id is missing, or that document has no detail
 * page in this app. Two deliberate quirks:
 *
 *   • a PRODUCTION_ORDER has no detail route (deleted 2026-04-26) — production
 *     orders open on their SALES ORDER, which is where the app tracks them. A
 *     production order raised for stock has no sales order and so no link;
 *   • a JOB_CARD has no detail route either; it opens the department board it
 *     sits on. Passing the department is therefore required for a JC link.
 */
export function sourceDocHref(
  docType: SourceDocType | null,
  id: string | null | undefined,
  opts: { salesOrderId?: string | null; departmentCode?: string | null } = {},
): string | null {
  if (!docType) return null;
  switch (docType) {
    case "GRN":
      return id ? `/procurement/grn/${encodeURIComponent(id)}` : null;
    case "PURCHASE_ORDER":
      return id ? `/procurement/${encodeURIComponent(id)}` : null;
    case "DELIVERY_ORDER":
      return id ? `/delivery/${encodeURIComponent(id)}` : null;
    case "SALES_ORDER":
      return id ? `/sales/${encodeURIComponent(id)}` : null;
    case "PRODUCTION_ORDER":
      return opts.salesOrderId
        ? `/sales/${encodeURIComponent(opts.salesOrderId)}`
        : null;
    case "JOB_CARD":
      return opts.departmentCode ? `/production/${deptSlug(opts.departmentCode)}` : null;
    default:
      return null;
  }
}

/** FAB_CUT → fab-cut. Matches the literal /production/<dept> routes. */
export function deptSlug(code: string): string {
  return code.trim().toLowerCase().replace(/_/g, "-");
}

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

/** Whole days between an ISO date and `now`. Null for an unusable date. */
export function ageDays(iso: string | null | undefined, now = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const days = Math.floor((now.getTime() - t) / 86_400_000);
  return days < 0 ? 0 : days;
}

/**
 * FIFO age for the header: the age of the OLDEST layer still owned.
 *
 * Layers with nothing left are skipped — they are not what the next issue will
 * consume, so their age is not the age of the stock on hand.
 */
export function fifoAge(
  layers: { date: string | null; qty: number }[],
  now = new Date(),
): { ageDays: number | null; date: string | null } {
  let oldest: string | null = null;
  for (const l of layers) {
    if (l.qty <= 0 || !l.date) continue;
    if (oldest === null || l.date < oldest) oldest = l.date;
  }
  return { ageDays: ageDays(oldest, now), date: oldest };
}
