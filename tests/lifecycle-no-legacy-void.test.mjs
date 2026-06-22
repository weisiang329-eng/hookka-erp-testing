import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Regression for the GL void-leak (2026-06-22): voiding a lifecycle-managed
// accounting document MUST go through its /lifecycle endpoint (which hides the
// original + reversal legs from the GL via applyLifecycle), never a legacy
// /void endpoint (which posted a reversal but left BOTH legs visible).
//
// The leak: editing a payment voucher called /payment-vouchers/:id/void, so the
// voided original stayed in the ledger. Fixed by routing edit-void through
// /lifecycle. This test fails if any frontend code re-introduces a legacy /void
// call for one of these documents.

const FILES = [
  "src/pages/accounting/index.tsx",
  "src/pages/invoices/supplier-payments.tsx",
  "src/pages/invoices/payments.tsx",
];

// A fetch to <doc>/<id>/void (the legacy, non-hiding void). The [^"`]* between
// the doc prefix and /void can't cross a quote/backtick, so this only matches a
// real single-string URL, not prose mentioning "/void".
const LEGACY_VOID =
  /(payment-vouchers|official-receipts|fund-transfers|other-party-payments|supplier-payments)\/[^"`]*\/void\b/;

test("frontend document voids go through /lifecycle, not legacy /void", () => {
  for (const f of FILES) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    const m = src.match(LEGACY_VOID);
    assert.equal(
      m,
      null,
      `${f} calls a legacy /void endpoint (${m?.[0]}) — use the /lifecycle endpoint so the GL hides the voided entries`,
    );
  }
});
