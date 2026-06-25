// ---------------------------------------------------------------------------
// Opening-date hard floor.
//
// kv_config `opening_date` is the accounting start date ("books start here").
// Any data dated BEFORE it is "pre-opening" — the owner has chosen NOT to
// extract it (it is reconciled separately into opening balances). Every
// financial report (GL ledger, trial balance, P&L, BS, cash-flow, AR/AP
// control, debtor/creditor ledgers, statements, aging) must EXCLUDE it.
//
// Opening SEEDS always pass the floor regardless of their own date, so opening
// balances are never lost:
//   - GL side:        sourceType opening_balance / opening_balance_reversal
//                     (these legs are displayed dated AT opening_date).
//   - Subledger side: invoices / purchase_invoices flagged is_opening = 1.
//
// Pure + dependency-free so it is unit-testable in isolation.
// ---------------------------------------------------------------------------

export function isOpeningSourceType(
  sourceType: string | null | undefined,
): boolean {
  return (
    sourceType === "opening_balance" ||
    sourceType === "opening_balance_reversal"
  );
}

// Day-precision compare. ISO timestamps ("2026-05-18T13:47:32Z") and bare days
// ("2026-05-18") both sort lexically, and slicing to 10 chars makes a leg
// posted at any time on the opening day compare EQUAL to the floor (not before).
function dayBefore(value: string | null | undefined, openingDate: string): boolean {
  return String(value ?? "").slice(0, 10) < openingDate;
}

// A GL leg is pre-opening when it is NOT an opening leg and its posted day is
// before openingDate. Returns false when no opening date is set (no floor).
export function legBeforeOpening(
  sourceType: string | null | undefined,
  postedAt: string | null | undefined,
  openingDate: string | null | undefined,
): boolean {
  if (!openingDate) return false;
  if (isOpeningSourceType(sourceType)) return false;
  return dayBefore(postedAt, openingDate);
}

// A subledger row (invoice / PI / payment / credit-note / bill …) is
// pre-opening when it is NOT an opening seed (is_opening) and its date is before
// openingDate. `isOpening` only applies to invoices/PIs; pass false/undefined
// for payments/CNs/DNs/bills (which can never be opening seeds).
export function rowBeforeOpening(
  date: string | null | undefined,
  openingDate: string | null | undefined,
  isOpening?: boolean | number | null,
): boolean {
  if (!openingDate) return false;
  if (isOpening) return false;
  return dayBefore(date, openingDate);
}
