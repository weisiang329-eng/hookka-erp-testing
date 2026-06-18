// Pure per-allocation math for supplier payments. AP (400-0000) is cleared at
// the PI's BOOKED MYR; the bank pays the ACTUAL MYR; the difference is realised
// FX (530-0000). MYR PIs have no FX. All amounts in sen (integer).

export type AllocInput = {
  outstandingBookedSen: number; // PI remaining booked MYR (amountSen − paidAmountSen)
  isForeign: boolean;
  fxRate: number;               // booking rate (MYR per 1 foreign unit); 1 for MYR
  payMyrSen?: number;           // MYR PIs: the MYR being paid
  foreignSen?: number;          // foreign PIs: the foreign amount being paid (sen)
  payRate?: number;             // foreign PIs: payment-day rate (MYR per 1 foreign unit)
  full: boolean;                // paying off the entire remaining outstanding
};
export type AllocResult =
  | { ok: true; bookedSen: number; bankSen: number; fxDiffSen: number }
  | { ok: false; error: string };

export function computeAlloc(a: AllocInput): AllocResult {
  if (!a.isForeign) {
    const booked = Math.round(Number(a.payMyrSen) || 0);
    if (booked <= 0) return { ok: false, error: "amount must be > 0" };
    if (booked > a.outstandingBookedSen) return { ok: false, error: "amount exceeds outstanding" };
    return { ok: true, bookedSen: booked, bankSen: booked, fxDiffSen: 0 };
  }
  const payRate = Number(a.payRate) || 0;
  if (!(payRate > 0)) return { ok: false, error: "foreign invoice needs payment-day rate" };
  const foreign = Math.round(Number(a.foreignSen) || 0);
  if (foreign <= 0) return { ok: false, error: "amount must be > 0" };
  const booked = a.full ? a.outstandingBookedSen : Math.round(foreign * a.fxRate);
  if (booked <= 0) return { ok: false, error: "amount must be > 0" };
  if (booked > a.outstandingBookedSen) return { ok: false, error: "amount exceeds outstanding" };
  const bank = Math.round(foreign * payRate);
  return { ok: true, bookedSen: booked, bankSen: bank, fxDiffSen: booked - bank };
}
