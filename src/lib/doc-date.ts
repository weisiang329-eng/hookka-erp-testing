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
// Bookkeeping / ledger-only types (opening_balance, closing_stock, year_close,
// depreciation, fund_transfer, contra) are intentionally ABSENT — they have no
// document date and fall back to postedAt in the resolver.
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
export function stripLegSuffix(sourceType: string | null | undefined): string {
  const base = String(sourceType ?? "").split(":")[0];
  return base.replace(
    /_(restate_rev|restate_post|reversal|void|bounce|settle)$/,
    "",
  );
}

// The source-document family for a leg, or null when it has no document date
// (bookkeeping / ledger-only / unknown → caller falls back to postedAt).
export function familyOf(sourceType: string | null | undefined): DocFamily | null {
  return DOC_DATE_FAMILIES[stripLegSuffix(sourceType)] ?? null;
}
