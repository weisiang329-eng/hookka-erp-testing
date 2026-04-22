// ---------------------------------------------------------------------------
// Costing library — FIFO consume + month-floating labor rate.
//
// Conventions
//   - All money values are stored in SEN (integer) to avoid float drift.
//     RM 2050.00 = 205_000 sen. UI code divides by 100 when displaying.
//   - Quantities stay as floats — fabric meters, plywood pcs, staples boxes
//     all mix — the "unit" is defined by the RM's `baseUOM`.
//
// Labor rate model
//   Monthly salary is fixed (RM 2050 default), but the per-minute rate
//   FLOATS with the calendar: February with 24 working Mon–Sat is more
//   expensive per minute than May with 26. Callers pass a date (or
//   year+month) and we return the rate for that month.
//
// FIFO consume
//   Given a set of batches for one RM sorted by receivedDate ascending,
//   walk them and decrement `remainingQty` until the requested qty is
//   satisfied or batches run out. Returns an array of "slices" — one per
//   batch touched, each carrying qty + unitCost — so the caller can build
//   ledger entries and compute total cost.
// ---------------------------------------------------------------------------
import type {
  RMBatch,
  FGBatch,
  CostingConfig,
  CostLedgerEntry,
  CostLedgerEntryType,
  CostLedgerItemType,
} from "@/types";

// ---- Default config -------------------------------------------------------

/** Monday..Saturday, skip Sunday. */
export const DEFAULT_WORKING_DOW = [1, 2, 3, 4, 5, 6];

export const DEFAULT_COSTING_CONFIG: CostingConfig = {
  baseSalarySen: 205_000, // RM 2050/month
  hoursPerDay: 9,
  workingDaysOfWeek: DEFAULT_WORKING_DOW,
  includeOverhead: false,
};

// ---- Calendar helpers -----------------------------------------------------

/**
 * Count how many working days (Mon–Sat by default) fall in `year`/`month`.
 * `month` is 1-indexed (1 = January).
 */
export function countWorkingDaysInMonth(
  year: number,
  month: number,
  workingDOW: number[] = DEFAULT_WORKING_DOW,
): number {
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0); // day 0 of next month = last day of this month
  const set = new Set(workingDOW);
  let count = 0;
  for (let d = 1; d <= last.getDate(); d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (set.has(dow)) count++;
  }
  // keep `first` referenced so tree-shakers don't complain
  void first;
  return count;
}

/**
 * Labor rate in SEN per MINUTE for the given year/month.
 * Example: Feb 2026 has 24 Mon–Sat → 24 × 9 × 60 = 12960 minutes
 *          205_000 / 12960 ≈ 15.82 sen/minute.
 */
export function laborRatePerMinuteSen(
  year: number,
  month: number,
  config: CostingConfig = DEFAULT_COSTING_CONFIG,
): number {
  const workingDays = countWorkingDaysInMonth(
    year,
    month,
    config.workingDaysOfWeek,
  );
  if (workingDays === 0) return 0;
  const minutes = workingDays * config.hoursPerDay * 60;
  return config.baseSalarySen / minutes;
}

/** Convenience: rate for the month of the given Date or ISO string. */
export function laborRateForDate(
  date: Date | string,
  config: CostingConfig = DEFAULT_COSTING_CONFIG,
): number {
  const d = typeof date === "string" ? new Date(date) : date;
  return laborRatePerMinuteSen(d.getFullYear(), d.getMonth() + 1, config);
}

// ---- FIFO consume ---------------------------------------------------------

export type ConsumeSlice = {
  batchId: string;
  qty: number;        // positive — amount pulled from this batch
  unitCostSen: number;
  totalCostSen: number; // qty × unitCostSen rounded to sen
};

export type ConsumeResult = {
  slices: ConsumeSlice[];
  consumedQty: number;     // how much we actually pulled (may be < requested if short)
  totalCostSen: number;
  shortageQty: number;     // requested - consumed (0 if fully satisfied)
};

/**
 * FIFO-consume `requestedQty` from the given batches, modifying
 * `remainingQty` in place. Batches are sorted by receivedDate asc; ties
 * broken by id so the order is stable.
 *
 * Caller should:
 *   1. Pass ONLY batches that match the RM being issued.
 *   2. Use the returned slices to emit ledger entries.
 *   3. Handle `shortageQty > 0` according to business rule (block? back-order?).
 *
 * This function mutates — if you want to simulate without committing, pass
 * a deep copy of the batches.
 */
export function fifoConsume(
  batches: RMBatch[],
  requestedQty: number,
): ConsumeResult {
  const sorted = [...batches]
    .filter((b) => b.remainingQty > 0)
    .sort((a, b) => {
      const d = a.receivedDate.localeCompare(b.receivedDate);
      return d !== 0 ? d : a.id.localeCompare(b.id);
    });

  const slices: ConsumeSlice[] = [];
  let remaining = requestedQty;
  let totalCostSen = 0;

  for (const batch of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(batch.remainingQty, remaining);
    if (take <= 0) continue;

    const slice: ConsumeSlice = {
      batchId: batch.id,
      qty: take,
      unitCostSen: batch.unitCostSen,
      totalCostSen: Math.round(take * batch.unitCostSen),
    };
    slices.push(slice);
    totalCostSen += slice.totalCostSen;

    // Mutate in place — caller owns the batches array.
    batch.remainingQty -= take;
    remaining -= take;
  }

  const consumedQty = requestedQty - remaining;
  return {
    slices,
    consumedQty,
    totalCostSen,
    shortageQty: Math.max(0, remaining),
  };
}

// ---- Display helpers ------------------------------------------------------

/**
 * Weighted average unit cost across all active (remainingQty > 0) batches.
 * Used for inventory display ("what's the current avg cost of PC151-01?").
 * Returns 0 if no active batches. Result in SEN (same precision as batches).
 */
export function weightedAvgCostSen(batches: RMBatch[]): number {
  let totalQty = 0;
  let totalCost = 0;
  for (const b of batches) {
    if (b.remainingQty <= 0) continue;
    totalQty += b.remainingQty;
    totalCost += b.remainingQty * b.unitCostSen;
  }
  if (totalQty === 0) return 0;
  return totalCost / totalQty;
}

/**
 * Oldest-active batch's unit cost — the price the NEXT consume will pay
 * (at least for its first slice). Useful as an "at-risk" cost indicator.
 */
export function nextFifoUnitCostSen(batches: RMBatch[]): number {
  const sorted = [...batches]
    .filter((b) => b.remainingQty > 0)
    .sort((a, b) => a.receivedDate.localeCompare(b.receivedDate));
  return sorted.length > 0 ? sorted[0].unitCostSen : 0;
}

/**
 * Total active qty across all live batches. Should match the RM's
 * `balanceQty` once the system fully runs on batches — until then
 * RM.balanceQty remains the source of truth for display and this is
 * useful for reconciliation.
 */
export function totalRemainingQty(batches: RMBatch[]): number {
  return batches.reduce((s, b) => s + Math.max(0, b.remainingQty), 0);
}

/**
 * Sum total cost value of all active batch layers, in SEN. This is the
 * "on-hand inventory value" for this RM under strict FIFO.
 */
export function totalBatchValueSen(batches: RMBatch[]): number {
  return batches.reduce(
    (s, b) => s + Math.max(0, b.remainingQty) * b.unitCostSen,
    0,
  );
}

// ---- FG batch helpers -----------------------------------------------------

/**
 * FIFO-consume FG units for a delivery. Same contract as `fifoConsume`
 * but for FGBatch layers — returns total cost so the DO can post COGS.
 */
export function fifoConsumeFG(
  batches: FGBatch[],
  requestedQty: number,
): {
  slices: { batchId: string; qty: number; unitCostSen: number; totalCostSen: number }[];
  totalCostSen: number;
  shortageQty: number;
} {
  const sorted = [...batches]
    .filter((b) => b.remainingQty > 0)
    .sort((a, b) => a.completedDate.localeCompare(b.completedDate));
  const slices: { batchId: string; qty: number; unitCostSen: number; totalCostSen: number }[] = [];
  let remaining = requestedQty;
  let totalCostSen = 0;
  for (const b of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(b.remainingQty, remaining);
    if (take <= 0) continue;
    const totalSen = Math.round(take * b.unitCostSen);
    slices.push({ batchId: b.id, qty: take, unitCostSen: b.unitCostSen, totalCostSen: totalSen });
    totalCostSen += totalSen;
    b.remainingQty -= take;
    remaining -= take;
  }
  return { slices, totalCostSen, shortageQty: Math.max(0, remaining) };
}

// ---- Ledger entry builder -------------------------------------------------

let _ledgerSeq = 0;
function nextLedgerId(): string {
  _ledgerSeq++;
  return `cl-${Date.now().toString(36)}-${_ledgerSeq.toString(36)}`;
}

/**
 * Build (don't persist) a CostLedgerEntry. Callers push the result into
 * the shared ledger array themselves so they stay in control of the
 * in-memory store.
 */
export function makeLedgerEntry(args: {
  date?: string;
  type: CostLedgerEntryType;
  itemType: CostLedgerItemType;
  itemId: string;
  batchId?: string;
  qty: number;
  direction: "IN" | "OUT";
  unitCostSen: number;
  refType?: string;
  refId?: string;
  notes?: string;
}): CostLedgerEntry {
  const qty = Math.abs(args.qty);
  return {
    id: nextLedgerId(),
    date: args.date ?? new Date().toISOString(),
    type: args.type,
    itemType: args.itemType,
    itemId: args.itemId,
    batchId: args.batchId,
    qty,
    direction: args.direction,
    unitCostSen: args.unitCostSen,
    totalCostSen: Math.round(qty * args.unitCostSen),
    refType: args.refType,
    refId: args.refId,
    notes: args.notes,
  };
}
