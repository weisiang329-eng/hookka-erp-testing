// ---------------------------------------------------------------------------
// org-letterhead-row.ts — "is this registry row usable as a letterhead?"
//
// Its own module, with NO imports, for two reasons.
//
// 1. It is the C16 guard. `GET /api/organisations` returns the full registry
//    row only to callers holding `organisations:read`; everyone else gets
//    id / code / name (BUG-2026-08-13-100). `letterheadForPurchaseOrg` used to
//    accept any row with a `name` and print `org.regNo ?? ""`, which on a
//    reduced row puts "Reg.  | TIN " on a purchase order — a field the
//    projection dropped and a consumer still read.
// 2. `generate-purchase-order-pdf.ts` imports `@/lib/constants`, and a module
//    behind that alias cannot be imported by the test runner (see the note in
//    tests/payment-method.test.mjs). Keeping the decision here means it is
//    tested by RUNNING it, not by reading the source it lives in.
// ---------------------------------------------------------------------------

/** The letterhead-bearing fields of an organisations-registry row. */
export type LetterheadFields = {
  regNo?: string | null;
  tin?: string | null;
  address?: string | null;
};

/**
 * True when the row actually carries printable company details.
 *
 * False for a REDUCED row (the keys are absent) and equally false for a row
 * whose details are genuinely blank — both must fall back to the hardcoded
 * letterhead, which is what such a company printed before the registry existed.
 * Printing an empty Reg. No. / TIN on a tax-relevant document is the failure
 * being prevented, and its cause does not change the right answer.
 */
export function hasLetterheadDetails(org: LetterheadFields | null | undefined): boolean {
  if (!org) return false;
  return Boolean(
    (org.regNo ?? "").trim() ||
      (org.tin ?? "").trim() ||
      (org.address ?? "").trim(),
  );
}
