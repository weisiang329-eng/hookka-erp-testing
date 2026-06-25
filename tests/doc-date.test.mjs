import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripLegSuffix,
  familyOf,
  parseSourceIdDate,
  DOC_DATE_FAMILIES,
} from "../src/lib/doc-date.ts";

test("stripLegSuffix — base types unchanged", () => {
  assert.equal(stripLegSuffix("invoice"), "invoice");
  assert.equal(stripLegSuffix("supplier_payment"), "supplier_payment");
  assert.equal(stripLegSuffix("payment_voucher"), "payment_voucher");
  assert.equal(stripLegSuffix("other_party_bill"), "other_party_bill");
});

test("stripLegSuffix — void / bounce / reversal / settle suffixes", () => {
  assert.equal(stripLegSuffix("invoice_void"), "invoice");
  assert.equal(stripLegSuffix("payment_bounce"), "payment");
  assert.equal(stripLegSuffix("manual_reversal"), "manual");
  assert.equal(stripLegSuffix("purchase_credit_note_void"), "purchase_credit_note");
  assert.equal(stripLegSuffix("payment_voucher_settle"), "payment_voucher");
  assert.equal(stripLegSuffix("opening_balance_reversal"), "opening_balance");
});

test("stripLegSuffix — restate rev/post drop the :stamp then the suffix", () => {
  assert.equal(stripLegSuffix("invoice_restate_rev:1719216340123"), "invoice");
  assert.equal(stripLegSuffix("invoice_restate_post:1719216340123"), "invoice");
  assert.equal(stripLegSuffix("payment_restate_rev:42"), "payment");
  assert.equal(stripLegSuffix("supplier_payment_restate_post:42"), "supplier_payment");
  assert.equal(stripLegSuffix("other_party_payment_restate_rev:42"), "other_party_payment");
});

test("stripLegSuffix — null/undefined/empty safe", () => {
  assert.equal(stripLegSuffix(null), "");
  assert.equal(stripLegSuffix(undefined), "");
  assert.equal(stripLegSuffix(""), "");
});

test("stripLegSuffix — payment_voucher is NOT confused with payment", () => {
  // payment_voucher must NOT strip to 'payment' (different family/table)
  assert.equal(stripLegSuffix("payment_voucher"), "payment_voucher");
  assert.notEqual(stripLegSuffix("payment_voucher"), "payment");
});

test("familyOf — real document families resolve to the right table", () => {
  assert.equal(familyOf("invoice").table, "invoices");
  assert.equal(familyOf("invoice_void").table, "invoices");
  assert.equal(familyOf("invoice_restate_post:99").table, "invoices");
  assert.equal(familyOf("payment").table, "payment_records");
  assert.equal(familyOf("payment_voucher").table, "payment_vouchers");
  assert.equal(familyOf("official_receipt").table, "official_receipts");
  assert.equal(familyOf("purchase_invoice").dateCol, "invoice_date");
  assert.equal(familyOf("supplier_payment_restate_rev:7").table, "supplier_payments");
  assert.equal(familyOf("other_party_bill").dateCol, "bill_date");
  assert.equal(familyOf("fund_transfer").table, "fund_transfers"); // date stored in fund_transfers
});

test("familyOf — bookkeeping / ledger-only / unknown → null (postedAt fallback)", () => {
  assert.equal(familyOf("opening_balance"), null);
  assert.equal(familyOf("opening_balance_reversal"), null);
  assert.equal(familyOf("closing_stock"), null);
  assert.equal(familyOf("year_close"), null);
  assert.equal(familyOf("depreciation"), null);
  assert.equal(familyOf("contra"), null);
  assert.equal(familyOf("something_unknown"), null);
});

test("parseSourceIdDate — depreciation → that month's last day", () => {
  assert.equal(parseSourceIdDate("depreciation", "dep-2026-06-1719216340123"), "2026-06-30");
  assert.equal(parseSourceIdDate("depreciation", "dep-2026-02-99"), "2026-02-28"); // non-leap
  assert.equal(parseSourceIdDate("depreciation", "dep-2024-02-99"), "2024-02-29"); // leap
});

test("parseSourceIdDate — closing_stock → month-end; its reversal → null", () => {
  assert.equal(parseSourceIdDate("closing_stock", "cs-2026-05-1719216340123"), "2026-05-31");
  // reversal sourceId is cs-rev-<stamp> (no month) → null → postedAt fallback
  assert.equal(parseSourceIdDate("closing_stock_reversal", "cs-rev-1719216340123"), null);
});

test("parseSourceIdDate — year_close → the FY-end date", () => {
  assert.equal(parseSourceIdDate("year_close", "fyclose-2026-08-31"), "2026-08-31");
});

test("parseSourceIdDate — same-day / mapped / unknown types → null (postedAt fallback)", () => {
  assert.equal(parseSourceIdDate("contra", "contra-1719216340123"), null);
  assert.equal(parseSourceIdDate("fund_transfer", "HLBB-OUT-2606-001"), null);
  assert.equal(parseSourceIdDate("invoice", "inv-uuid"), null);
  assert.equal(parseSourceIdDate("opening_balance", "ob-1"), null);
});

test("DOC_DATE_FAMILIES — every entry has table/noCol/dateCol", () => {
  for (const [fam, cfg] of Object.entries(DOC_DATE_FAMILIES)) {
    assert.ok(cfg.table, `${fam} table`);
    assert.ok(cfg.noCol, `${fam} noCol`);
    assert.ok(cfg.dateCol, `${fam} dateCol`);
  }
});
