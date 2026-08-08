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

/**
 * A raw-material RECEIPT — one `rm_batches` FIFO layer AND the inbound ledger
 * movement that created it, on one row.
 *
 * They used to be two sections of the panel, "Stock lots" and the inbound half
 * of "Movements", and on live data they listed the same receipts twice: same
 * dates, same quantities, same unit costs, same GR numbers. For raw material
 * there is no third possibility — every inbound movement IS the creation of a
 * lot — so two lists fetched down two different paths could only ever agree by
 * luck, and this codebase has spent enough time on lists that stopped agreeing.
 *
 * They are not quite one-to-one, and that is exactly why the merge is
 * `mergeRmReceipts` rather than a join in SQL: the opening-balance layers were
 * seeded straight into `rm_batches` at cut-over with no ledger row at all, so a
 * lot can exist without a movement. Those rows keep their quantities and get no
 * running balance, and `header.ledgerVsOnHand` explains the resulting gap.
 */
export interface RmLot {
  kind: "RM_LOT";
  id: string;
  /** No warehouse dimension exists for RM today; null renders as an em dash. */
  warehouse: string | null;
  /** Free-text descriptors carried on the lot (grade, colour, width…). */
  attributes: string | null;
  /**
   * Quantity still on hand in this layer. NULL — not zero — when the row is a
   * ledger receipt with no surviving FIFO lot: nobody knows what is left of a
   * layer that is not there, and zero would claim it had been consumed.
   */
  qty: number | null;
  /** Quantity received. From the lot when there is one, else the movement. */
  originalQty: number;
  consumedQty: number | null;
  unitCostSen: number;
  /** Value of what is LEFT in this layer. Null when there is no layer. */
  valueSen: number | null;
  source: string;
  grnNo: string | null;
  grnHref: string | null;
  purchaseOrderNo: string | null;
  purchaseOrderHref: string | null;
  supplierName: string | null;
  receivedDate: string | null;
  ageDays: number | null;

  // --- the movement half of the merged row --------------------------------
  /** False when no `rm_batches` layer backs this row (ledger receipt only). */
  hasLot: boolean;
  /** The inbound `cost_ledger` row that created it, when there is one. */
  movementId: string | null;
  /**
   * DERIVED running balance as at that receipt, carried over from the movement
   * ledger. Null when this receipt has no movement row — an opening seed never
   * entered the ledger, so no balance can be stated for it.
   */
  balanceAfter: number | null;
}

/**
 * Fold the inbound movement ledger into the FIFO lots, oldest first.
 *
 * NOTHING IS DROPPED, in either direction, and that is the whole contract:
 *
 *   • a lot with no inbound movement stays (the opening-balance layers, seeded
 *     at cut-over with no ledger row — 278 of 279 materials on prod). It keeps
 *     its quantities and gets no running balance;
 *   • an inbound movement with no lot stays too, as a receipt whose FIFO layer
 *     is gone. Its remaining quantity is NULL, not zero: a layer that is not
 *     there cannot be said to be empty.
 *
 * Matched on `batchId`, which is what the GRN post-to-stock cascade writes on
 * the ledger row and the lot alike. A lot matches at most one movement; the
 * first (oldest) claim wins, so a second row referencing the same batch is kept
 * as its own receipt rather than silently overwriting the first.
 */
export function mergeRmReceipts(
  lots: RmLot[],
  movements: StockMovement[],
): RmLot[] {
  const inbound = [...movements]
    .filter((m) => m.direction === "IN")
    .sort(compareOldestFirst);

  const claimed = new Set<string>();
  const byBatch = new Map<string, StockMovement>();
  for (const m of inbound) {
    if (!m.batchId || byBatch.has(m.batchId)) continue;
    byBatch.set(m.batchId, m);
  }

  const merged: RmLot[] = lots.map((lot) => {
    const m = byBatch.get(lot.id);
    if (m) claimed.add(m.id);
    return {
      ...lot,
      hasLot: true,
      movementId: m?.id ?? null,
      balanceAfter: m?.balanceAfter ?? null,
      // The lot's own received date is the physical fact; the ledger date is
      // the same event as booked. Prefer the lot, fall back to the ledger.
      receivedDate: lot.receivedDate ?? m?.date ?? null,
    };
  });

  for (const m of inbound) {
    if (claimed.has(m.id)) continue;
    merged.push({
      kind: "RM_LOT",
      id: m.id,
      warehouse: null,
      attributes: m.notes ?? null,
      qty: null,
      originalQty: m.qty,
      consumedQty: null,
      unitCostSen: m.unitCostSen,
      // Not the movement's total cost: that is what the receipt was WORTH, and
      // this column is what is left on the shelf. With no layer behind it,
      // nothing can be said — and a value subtotal that quietly counted a
      // vanished layer would overstate the stock.
      valueSen: null,
      source: m.type,
      grnNo: m.docNo,
      grnHref: m.docHref,
      purchaseOrderNo: m.purchaseOrderNo ?? null,
      purchaseOrderHref: m.purchaseOrderHref ?? null,
      supplierName: m.supplierName ?? null,
      receivedDate: m.date,
      ageDays: ageDays(m.date),
      hasLot: false,
      movementId: m.id,
      balanceAfter: m.balanceAfter,
    });
  }

  return merged.sort((a, b) => {
    const ad = a.receivedDate ?? "";
    const bd = b.receivedDate ?? "";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
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

/**
 * One FIFO consumption — which layer paid for an outbound movement, who used
 * it, and on what.
 *
 * `department` and `consumedByName` exist because today a raw material is
 * ISSUED and CONSUMED by the same event: there is no material-requisition step
 * in the system yet, so one BOM completion both takes the material off the
 * shelf and books it against the job. When those two split into separate events
 * this row will still be the one that answers "who used it and where", so the
 * columns belong here now and not only on the outbound movement.
 *
 * Both are nullable and render as an em dash. That is not a placeholder for
 * later — it is the current state of the ledger, said out loud.
 */
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
  /** The department that used it, when the ledger records one. */
  department?: string | null;
  /** The employee, from `cost_ledger.workerId`. */
  consumedByName?: string | null;
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
// What a grid row opens
// ---------------------------------------------------------------------------

/**
 * The item the drawer is opened for. Built from a grid row by one of the three
 * functions below rather than inline at the call site, so the mapping from a
 * row to the thing that gets fetched is a testable fact and not a detail buried
 * in a click handler.
 */
export interface StockBreakdownTarget {
  type: StockItemType;
  itemId: string;
  /** Shown in the header while the fetch is in flight. */
  code: string;
  name?: string;
}

/**
 * The breakdown is keyed on the PRODUCT id. Off-catalog rows the FG grid
 * synthesises from finished production orders carry an `fg-dyn-*` id that no
 * product row matches, so they have nothing to open — the id is left alone and
 * the endpoint says so, rather than guessing at a neighbouring product.
 */
export function fgBreakdownTarget(row: {
  id: string;
  code: string;
  name?: string | null;
}): StockBreakdownTarget {
  return { type: "FG", itemId: row.id, code: row.code, name: row.name ?? undefined };
}

/**
 * The WIP CODE, not the row id: the grid's id is a synthetic `wip-dyn-*` /
 * `wip-rebuild-*` key, while the code is what `job_cards.wipLabel` joins on and
 * is the only handle that reaches the ledger. The endpoint accepts either.
 */
export function wipBreakdownTarget(row: {
  wipCode: string;
  relatedProduct?: string | null;
}): StockBreakdownTarget {
  return {
    type: "WIP",
    itemId: row.wipCode,
    code: row.wipCode,
    name: row.relatedProduct ?? undefined,
  };
}

export function rmBreakdownTarget(row: {
  id: string;
  itemCode: string;
  description?: string | null;
}): StockBreakdownTarget {
  return {
    type: "RM",
    itemId: row.id,
    code: row.itemCode,
    name: row.description ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Panel sections
// ---------------------------------------------------------------------------

/** The collapsible sections of the panel. */
export type BreakdownSection = "movements" | "cogs" | "pieces";

export type BreakdownSections = Record<BreakdownSection, boolean>;

/**
 * Movements and COGS are open on arrival: the panel is a report, not a menu of
 * reports.
 *
 * `pieces` — the per-serial list of finished goods on hand — starts CLOSED. The
 * owner asked for the finished-goods panel to be two movement tables and no
 * stock-lots section (2026-08-08); the per-piece list is the only place the
 * serials, their claiming sales order and their status can be seen at all, so
 * it is kept and folded away rather than deleted. Closed by default is the
 * compromise: it is not part of the panel he described, and the information is
 * still one click away instead of gone.
 */
export const DEFAULT_BREAKDOWN_SECTIONS: BreakdownSections = {
  movements: true,
  cogs: true,
  pieces: false,
};

/**
 * Toggle one section. The sections are INDEPENDENT — no accordion — so closing
 * Movements must leave COGS exactly as it was, and vice versa.
 *
 * State is which sections are open; it is never a cache of what was rendered.
 * A section that is closed and reopened rebuilds from the same response, so
 * collapsing one can never permanently lose the other's content — or its own.
 */
export function toggleBreakdownSection(
  state: BreakdownSections,
  clicked: BreakdownSection,
): BreakdownSections {
  return { ...state, [clicked]: !state[clicked] };
}

// ---------------------------------------------------------------------------
// The honesty notices
// ---------------------------------------------------------------------------

export interface PanelNotice {
  key: "qty" | "reconciliation" | "ledger" | "valuation";
  tone: "warn" | "info";
  text: string;
}

/**
 * Every plain-English notice this header carries, in the order the panel shows
 * them. This exists as a function so a restyle cannot quietly drop one: the
 * panel maps over whatever comes back, and a test asserts that a header whose
 * figures disagree still produces the notice that says so.
 *
 * A prettier panel that loses a warning is a worse panel.
 */
export function panelNotices(
  header: Pick<
    StockBreakdownHeader,
    "qtyNote" | "reconciliation" | "ledgerVsOnHand" | "valuationNote"
  >,
): PanelNotice[] {
  const out: PanelNotice[] = [];
  if (header.qtyNote) out.push({ key: "qty", tone: "info", text: header.qtyNote });
  if (header.reconciliation?.notice) {
    out.push({ key: "reconciliation", tone: "warn", text: header.reconciliation.notice });
  }
  if (header.ledgerVsOnHand?.note) {
    out.push({
      key: "ledger",
      tone: header.ledgerVsOnHand.agrees ? "info" : "warn",
      text: header.ledgerVsOnHand.note,
    });
  }
  if (header.valuationNote) {
    out.push({ key: "valuation", tone: "warn", text: header.valuationNote });
  }
  return out;
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
// The product's own details, folded into the panel
//
// Until 2026-08-08 a finished-goods row had TWO surfaces: this drawer, and a
// centred dialog carrying the catalogue fields plus its own "Source Production
// Orders" table — which listed the same production orders the drawer's inbound
// movements already list, fetched down a different path. Owner: "它们两个已经
// 粘在一起了" — one click, one panel. The dialog's fields moved here, read-only;
// the duplicated table was deleted rather than merged, because the movement
// ledger is the one that can be reconciled.
//
// The values are FORMATTED here rather than in the panel so the same rule
// decides what an empty field looks like everywhere, and so a test can assert
// it without rendering anything.
// ---------------------------------------------------------------------------

export type ProductDetailField =
  | { label: string; kind: "text"; value: string | null }
  /** Integer sen. The panel prints it with formatCurrency; null is an em dash. */
  | { label: string; kind: "money"; valueSen: number | null };

export interface ProductDetails {
  fields: ProductDetailField[];
  /**
   * Configuration the record carries that this panel does not show and the
   * edit form does not touch — it is preserved on save. Naming it is the
   * difference between "this is the whole product" and "this is the part of
   * the product you can see here".
   */
  advanced: string[];
}

/** The row shape this needs; a `Product` satisfies it structurally. */
export interface ProductDetailSource {
  id: string;
  category?: string | null;
  baseModel?: string | null;
  sizeCode?: string | null;
  sizeLabel?: string | null;
  description?: string | null;
  basePriceSen?: number | null;
  price1Sen?: number | null;
  unitM3?: number | null;
  fabricUsage?: number | null;
  skuCode?: string | null;
  fabricColor?: string | null;
  seatHeightPrices?: unknown;
  subAssemblies?: unknown;
  pieces?: unknown;
}

/**
 * The catalogue record behind a finished-goods row, or null when there is none.
 *
 * The FG grid synthesises rows for finished production orders whose product was
 * never catalogued (`fg-dyn-*`, `makeDynShell` in `@/lib/fg-stock`). Those
 * shells carry zeroed prices and blank spec fields that were never anybody's
 * data. Rendering them as a product record would present placeholder zeros as
 * facts, so they get no details section at all — the same reason the breakdown
 * endpoint answers "no catalogue item matches this row" for them.
 *
 * Code and name are deliberately absent: the panel's title bar already carries
 * both, and a field grid that repeats the heading is noise.
 */
export function fgProductDetails(
  row: ProductDetailSource | null | undefined,
): ProductDetails | null {
  if (!row || row.id.startsWith("fg-dyn-")) return null;

  const txt = (label: string, v: string | null | undefined): ProductDetailField => ({
    label,
    kind: "text",
    value: v === undefined || v === null || v === "" ? null : String(v),
  });
  const money = (label: string, v: number | null | undefined): ProductDetailField => ({
    label,
    kind: "money",
    valueSen: v === undefined || v === null ? null : v,
  });
  const num = (label: string, v: number | null | undefined): ProductDetailField =>
    txt(label, v === undefined || v === null ? null : String(v));

  const advanced: string[] = [];
  if (row.seatHeightPrices) advanced.push("Seat-height price ladder (sofa tier JSON)");
  if (row.subAssemblies) advanced.push("Sub-assemblies");
  if (row.pieces) advanced.push("Pieces breakdown");

  return {
    fields: [
      txt("Category", row.category),
      txt("Base model", row.baseModel),
      txt("Size code", row.sizeCode),
      txt("Size label", row.sizeLabel),
      money("Base price", row.basePriceSen),
      money("Price 1", row.price1Sen),
      num("Unit M3", row.unitM3),
      num("Fabric usage (m)", row.fabricUsage),
      txt("SKU code", row.skuCode),
      txt("Fabric colour", row.fabricColor),
      txt("Description", row.description),
    ],
    advanced,
  };
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
