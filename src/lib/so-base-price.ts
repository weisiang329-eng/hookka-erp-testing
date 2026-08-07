// ---------------------------------------------------------------------------
// so-base-price — the precedence for a sales-order line's base price.
//
// Owner ruling (2026-08): the CUSTOMER-specific price is authoritative. It was
// previously consulted only when the client sent base=0, so any path that sent
// a non-zero price (a frontend branch pre-filling the product default, the
// scan-PO path) silently billed the product/maintenance price instead of the
// customer's. This is the single precedence every create path now goes through.
//
//   1. customer price (seat-height first, then flat customer base) — wins over
//      everything when present
//   2. else the incoming/manual price, if one was supplied (> 0)
//   3. else the product default (seat-height first, then flat product base)
//
// Pure + tested so the precedence can't silently regress on a money field.
// ---------------------------------------------------------------------------

export type BasePriceInputs = {
  /** What the request sent for this line (0 = nothing supplied). */
  incomingSen: number;
  /** Customer seat-height price for this line's seat height, if set. */
  customerSeatSen: number | null;
  /** Flat customer base price, if a customer-specific price exists. */
  customerBaseSen: number | null;
  /** Product-default seat-height price for this line's seat height, if any. */
  productSeatSen: number | null;
  /** Flat product-default base price. */
  productBaseSen: number | null;
};

/** Resolve the line's base price in sen per the owner's precedence. */
export function resolveSoBasePriceSen(i: BasePriceInputs): number {
  const customer =
    (i.customerSeatSen != null && i.customerSeatSen > 0 ? i.customerSeatSen : null) ??
    (i.customerBaseSen != null && i.customerBaseSen > 0 ? i.customerBaseSen : null);
  if (customer != null) return customer; // customer price wins

  const incoming = Number(i.incomingSen) || 0;
  if (incoming > 0) return incoming; // manual / UI-supplied price

  // Product default (seat-height first).
  if (i.productSeatSen != null && i.productSeatSen > 0) return i.productSeatSen;
  return Number(i.productBaseSen) || 0;
}
