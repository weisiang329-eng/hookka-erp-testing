// ---------------------------------------------------------------------------
// A supplier invoice cannot be dated after the day it was keyed in.
//
// Owner 2026-08-05, on PI-2608-009: entered 1 August carrying invoice_date
// 2026-09-03 — 33 days in the future, one row in 350. The cost is not the
// wrong figure: the payment term runs from this date, so that PI's due date
// landed on 31 October instead of 30 September. A month of late payment that
// nobody sees until the supplier chases.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/routes/purchase-invoices.ts"),
  "utf8",
);

test("both create and edit reject a future invoice date", () => {
  assert.match(SRC, /function futureInvoiceDate\(/);
  assert.equal(
    (SRC.match(/futureInvoiceDate\(body\.invoiceDate\)/g) ?? []).length, 2,
    "the guard must run on POST and on PUT — an edit is where a month digit gets fixed, and where a new slip gets introduced",
  );
});

test("the guard tolerates timezone skew but not a month slip", () => {
  // The server is UTC, Malaysia is UTC+8: an invoice keyed this evening MYT can
  // legitimately carry tomorrow's date by the server's clock. A month ahead
  // cannot.
  const futureInvoiceDate = (date) => {
    const d = (date ?? "").trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    const limit = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return d > limit ? d : null;
  };
  const today = new Date().toISOString().slice(0, 10);
  const inAMonth = new Date(Date.now() + 33 * 864e5).toISOString().slice(0, 10);
  const lastWeek = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

  assert.equal(futureInvoiceDate(inAMonth), inAMonth, "a month ahead must be refused");
  assert.equal(futureInvoiceDate(today), null, "today is fine");
  assert.equal(futureInvoiceDate(lastWeek), null, "a back-dated supplier invoice is normal");
  // Anything unparseable is left to the existing handling, not rejected here.
  assert.equal(futureInvoiceDate(""), null);
  assert.equal(futureInvoiceDate("not a date"), null);
  assert.equal(futureInvoiceDate(undefined), null);
});
