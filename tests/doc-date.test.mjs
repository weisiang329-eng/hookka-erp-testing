import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripLegSuffix,
  familyOf,
  parseSourceIdDate,
  stripSourceIdSuffix,
  DOC_DATE_FAMILIES,
} from "../src/lib/doc-date.ts";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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

// BUG-2026-08-06-001 (class C5). The unvoid endpoint shipped posting a brand
// new sourceType that this list had never heard of, so its legs got no family,
// fell back to postedAt, and reported in the month the button was clicked
// rather than the month of the invoice — PI-2606-073's restored RM 1,865.80
// landed in August's P&L instead of June's. The money tied the whole time;
// only the period was wrong. Every correction sourceType must resolve HOME.
test("stripLegSuffix — unvoid resolves home, and is not confused with void", () => {
  assert.equal(stripLegSuffix("purchase_invoice_unvoid"), "purchase_invoice");
  assert.equal(stripLegSuffix("purchase_invoice_void"), "purchase_invoice");
  assert.equal(stripLegSuffix("invoice_unvoid"), "invoice");
});

// BUG-2026-08-06-003. The version of this test written that morning listed the
// sourceTypes BY HAND, so it passed while `labor_post` — which the month-end
// labour posting had been writing all along — resolved to nothing and dated
// itself to the day the button was pressed. A hand-typed list can only catch
// the types its author already thought of, which is never the one that bites.
//
// So SCAN the routes instead: every sourceType the API actually writes must
// either resolve to a document family or encode its own date in the sourceId.
// A new type that does neither now fails here, in the commit that adds it.
test("every sourceType the API posts is dated by something other than postedAt", () => {
  const routes = resolve(process.cwd(), "src/api/routes");
  const found = new Set();
  for (const f of readdirSync(routes)) {
    if (!f.endsWith(".ts")) continue;
    const src = readFileSync(resolve(routes, f), "utf8");
    for (const m of src.matchAll(/sourceType: *"([a-z_]+)"/g)) found.add(m[1]);
  }
  assert.ok(found.size > 10, `expected to scan real sourceTypes, found ${found.size}`);

  // Deliberate postedAt users, each with a reason:
  //   contra          — always same-day, so postedAt IS its document date
  //   customers/suppliers — audit rows, not money legs
  //   purchase_return — same-day goods return
  //   opening_balance — posted WITH an explicit postedAt of the opening date,
  //     so its postedAt already IS its document date. Verified on prod
  //     2026-08-06: all 274 legs sit on 2026-05-22 after three same-day
  //     re-posts. It is exempt because it sets the date, not because it
  //     escapes the rule.
  const EXEMPT = new Set([
    "contra", "customers", "suppliers", "purchase_return",
    "opening_balance", "opening_balance_reversal",
  ]);
  // Types whose date lives in the sourceId rather than a source table.
  const SELF_DATED = new Set(["closing_stock", "year_close", "depreciation", "labor_post"]);

  const orphans = [...found].filter(
    (t) => !EXEMPT.has(t) && !SELF_DATED.has(stripLegSuffix(t)) && !familyOf(t),
  );
  assert.deepEqual(
    orphans,
    [],
    `these post money but resolve to no date — they will report in the month the button was clicked: ${orphans.join(", ")}`,
  );
});

test("labor_post dates to the month it is FOR, not the day it was posted", () => {
  // The owner posted July's wage bill on 2026-08-07; it must land in July.
  assert.equal(parseSourceIdDate("labor_post", "labor-2026-07"), "2026-07-31");
  assert.equal(parseSourceIdDate("labor_post", "labor-2026-02"), "2026-02-28");
  assert.equal(parseSourceIdDate("labor_post", "labor-2024-02"), "2024-02-29"); // leap
  assert.equal(parseSourceIdDate("labor_post", "labor-bogus"), null);
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

// BUG-2026-07-24-001: purchase-invoice EDIT legs post sourceId
// 'docId:edit-<stamp>'. The date resolver's raw-id lookup missed them, fell
// back to postedAt, and a post-opening edit to a pre-opening PI escaped the
// opening floor — double-counting against the opening entry (+312/+95.04 on
// 400-0000). The resolver now retries with the suffix stripped.
test("stripSourceIdSuffix — ':edit-<stamp>' correction ids reach the base doc id", () => {
  assert.equal(stripSourceIdSuffix("pi-47dff213:edit-1753340000000"), "pi-47dff213");
  assert.equal(stripSourceIdSuffix("inv-abc123:edit-42"), "inv-abc123");
  // ids without a suffix pass through unchanged
  assert.equal(stripSourceIdSuffix("pi-47dff213"), "pi-47dff213");
  assert.equal(stripSourceIdSuffix("PI-2605-008"), "PI-2605-008");
  // null/undefined/empty safe
  assert.equal(stripSourceIdSuffix(null), "");
  assert.equal(stripSourceIdSuffix(undefined), "");
  assert.equal(stripSourceIdSuffix(""), "");
});

test("DOC_DATE_FAMILIES — every entry has table/noCol/dateCol", () => {
  for (const [fam, cfg] of Object.entries(DOC_DATE_FAMILIES)) {
    assert.ok(cfg.table, `${fam} table`);
    assert.ok(cfg.noCol, `${fam} noCol`);
    assert.ok(cfg.dateCol, `${fam} dateCol`);
  }
});
