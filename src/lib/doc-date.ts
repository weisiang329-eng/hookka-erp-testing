// ---------------------------------------------------------------------------
// doc-date.ts — map a ledger leg's sourceType to its SOURCE DOCUMENT family.
//
// The immutable ledger stores only `postedAt` (the entry timestamp). To report
// by the DOCUMENT's own date (owner: "a June invoice entered in July belongs to
// June"), each leg must be resolved back to its source document's date. This
// file is the PURE part: strip a leg's reversal/correction suffix to its base
// family, and map that family to its source table + date/number columns. The
// db-backed resolver (loadDocDateResolver, in accounting.ts) uses this.
//
// Pure + dependency-free so it is unit-testable.
// ---------------------------------------------------------------------------

export interface DocFamily {
  table: string;
  noCol: string; // human document number column (snake_case)
  dateCol: string; // the document's own date column (snake_case)
}

// Base family (after suffix-strip) → its source table + columns. Columns are
// snake_case (the real Postgres names) so they pass the d1-compat untranslated.
// closing_stock / year_close / depreciation have no table but encode their own
// date in the sourceId (parseSourceIdDate). contra is always same-day so it
// keeps the postedAt fallback. fund_transfer stores its date in fund_transfers
// (added 2026-06-25 so a back-dated transfer reports on its own date).
export const DOC_DATE_FAMILIES: Record<string, DocFamily> = {
  invoice: { table: "invoices", noCol: "invoice_no", dateCol: "invoice_date" },
  payment: { table: "payment_records", noCol: "receipt_number", dateCol: "date" },
  credit_note: { table: "credit_notes", noCol: "note_number", dateCol: "date" },
  debit_note: { table: "debit_notes", noCol: "note_number", dateCol: "date" },
  purchase_invoice: { table: "purchase_invoices", noCol: "pi_no", dateCol: "invoice_date" },
  purchase_credit_note: { table: "purchase_credit_notes", noCol: "note_number", dateCol: "date" },
  supplier_payment: { table: "supplier_payments", noCol: "payment_no", dateCol: "date" },
  manual: { table: "journal_entries", noCol: "entry_no", dateCol: "date" },
  payment_voucher: { table: "payment_vouchers", noCol: "pv_no", dateCol: "date" },
  official_receipt: { table: "official_receipts", noCol: "or_no", dateCol: "date" },
  other_party_bill: { table: "other_party_bills", noCol: "bill_no", dateCol: "bill_date" },
  other_party_payment: { table: "other_party_payments", noCol: "payment_no", dateCol: "date" },
  fund_transfer: { table: "fund_transfers", noCol: "transfer_no", dateCol: "date" },
};

// Reversal / correction legs carry the SAME source document, so strip the
// suffix to reach the base family:
//   invoice_void                  → invoice
//   payment_bounce                → payment
//   manual_reversal               → manual
//   purchase_credit_note_void     → purchase_credit_note
//   payment_voucher_settle        → payment_voucher
//   <type>_restate_rev:<stamp>    → <type>   (':stamp' dropped first)
//   <type>_restate_post:<stamp>   → <type>
//   opening_balance_reversal      → opening_balance
//   purchase_invoice_unvoid       → purchase_invoice
//
// `unvoid` must precede `void` in the alternation for readability, though it
// would match either way: in "…_unvoid" the character before "void" is 'n', so
// the `_void$` branch cannot fire. Getting this list wrong is silent — an
// unlisted suffix yields no family, the leg falls back to postedAt, and it
// reports in the month it was CLICKED instead of the month of its document
// (BUG-2026-08-06-001, and BUG-2026-07-24-001 before it: class C5). Any new
// correction sourceType has to be added here in the same commit that posts it.
export function stripLegSuffix(sourceType: string | null | undefined): string {
  const base = String(sourceType ?? "").split(":")[0];
  return base.replace(
    /_(restate_rev|restate_post|reversal|unvoid|void|bounce|settle)$/,
    "",
  );
}

// The source-document family for a leg, or null when it has no document date
// (bookkeeping / ledger-only / unknown → caller falls back to postedAt).
export function familyOf(sourceType: string | null | undefined): DocFamily | null {
  return DOC_DATE_FAMILIES[stripLegSuffix(sourceType)] ?? null;
}

// Correction legs reuse their document's sourceId plus a ':<tag>' suffix
// (e.g. a purchase-invoice edit posts sourceId 'pi-47dff213:edit-1753...').
// Strip to the base document id so those legs date to the SOURCE DOCUMENT
// like every other leg. Document ids/numbers never contain ':', so stripping
// can only recover a match, never change one.
export function stripSourceIdSuffix(sourceId: string | null | undefined): string {
  return String(sourceId ?? "").split(":")[0];
}

// Last calendar day of a 1-indexed month, as 'YYYY-MM-DD' (handles leap Feb).
function lastDayOfMonth(year: number, month1to12: number): string {
  const d = new Date(year, month1to12, 0).getDate(); // day 0 of next month = last day of this one
  return `${String(year).padStart(4, "0")}-${String(month1to12).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Period-end bookkeeping legs have NO source table but DO encode their own date
// in the sourceId. Return that date (period-END for month-stamped types so the
// opening-date floor classifies a whole period correctly), else null → postedAt.
//   depreciation   dep-YYYY-MM-<stamp>      → that month's last day
//   closing_stock  cs-YYYY-MM-<stamp>       → that month's last day
//                  (its reversal cs-rev-<stamp> has no month → null → postedAt)
//   year_close     fyclose-YYYY-MM-DD       → that FY-end date
// (contra is always same-day and fund_transfer same-day-ish, so both keep the
//  postedAt fallback — their sourceId carries no reliable own-date.)
export function parseSourceIdDate(
  sourceType: string | null | undefined,
  sourceId: string | null | undefined,
): string | null {
  const base = stripLegSuffix(sourceType);
  const sid = String(sourceId ?? "");
  let m: RegExpMatchArray | null;
  if (base === "depreciation" && (m = sid.match(/^dep-(\d{4})-(\d{2})-/))) {
    return lastDayOfMonth(Number(m[1]), Number(m[2]));
  }
  if (base === "closing_stock" && (m = sid.match(/^cs-(\d{4})-(\d{2})-/))) {
    return lastDayOfMonth(Number(m[1]), Number(m[2]));
  }
  if (base === "year_close" && (m = sid.match(/^fyclose-(\d{4}-\d{2}-\d{2})/))) {
    return m[1];
  }
  // Month-end labour posting: sourceId is `labor-YYYY-MM`. Without this it fell
  // back to postedAt, so July's wage bill reported in the month the button was
  // pressed — the owner posted July on 2026-08-07 and it landed in August,
  // leaving July's Production Salary at zero (BUG-2026-08-06-003, class C5).
  if (base === "labor_post" && (m = sid.match(/^labor-(\d{4})-(\d{2})$/))) {
    return lastDayOfMonth(Number(m[1]), Number(m[2]));
  }
  return null;
}
