// ---------------------------------------------------------------------------
// discount-alloc.ts — pure allocation math for a Supplier Discount (purchase
// credit note). A discount of `discountTotalSen` (net + SST) can be applied
// against zero, one, or many of the supplier's unpaid PIs. Each allocation
// reduces that PI's outstanding; the unallocated remainder sits as a
// supplier-level credit. All amounts integer sen. Mirrors supplier-payment-alloc.
// ---------------------------------------------------------------------------

export interface PiOpen {
  piId: string;
  /** Outstanding = amountSen − paidAmountSen (must be > 0 to be listed). */
  outstandingSen: number;
}

export interface Alloc {
  piId: string;
  amountSen: number;
}

export type DiscountAllocResult =
  | {
      ok: true;
      /** Per-PI amount to add to paid_amount_sen. Blank/zero rows dropped. */
      applied: { piId: string; appliedSen: number }[];
      /** Discount not tied to any PI (supplier-level credit). */
      unallocatedSen: number;
    }
  | { ok: false; error: string };

/**
 * Validate + resolve a supplier-discount allocation. Pure: no DB. The caller
 * loads the supplier's open PIs, passes the operator's allocations, and gets
 * back the per-PI amounts to apply (or an error to reject the post).
 */
export function computeDiscountAlloc(opts: {
  discountTotalSen: number;
  open: PiOpen[];
  allocations: Alloc[];
}): DiscountAllocResult {
  const total = Math.round(opts.discountTotalSen) || 0;
  if (!(total > 0)) {
    return { ok: false, error: "Discount total must be greater than zero" };
  }

  const outstandingByPi = new Map(
    (opts.open ?? []).map((o) => [
      o.piId,
      Math.max(0, Math.round(o.outstandingSen) || 0),
    ]),
  );

  const seen = new Set<string>();
  const applied: { piId: string; appliedSen: number }[] = [];
  let allocated = 0;

  for (const a of opts.allocations ?? []) {
    const amt = Math.round(a.amountSen) || 0;
    if (amt <= 0) continue; // blank / unticked row
    if (seen.has(a.piId)) {
      return { ok: false, error: `Duplicate allocation for ${a.piId}` };
    }
    seen.add(a.piId);
    const outstanding = outstandingByPi.get(a.piId);
    if (outstanding === undefined) {
      return {
        ok: false,
        error: `${a.piId} is not an open invoice for this supplier`,
      };
    }
    if (amt > outstanding) {
      return {
        ok: false,
        error: `Allocation ${amt} exceeds outstanding ${outstanding} on ${a.piId}`,
      };
    }
    applied.push({ piId: a.piId, appliedSen: amt });
    allocated += amt;
  }

  if (allocated > total) {
    return {
      ok: false,
      error: `Allocated ${allocated} exceeds discount total ${total}`,
    };
  }

  return { ok: true, applied, unallocatedSen: total - allocated };
}
