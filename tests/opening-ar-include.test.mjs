// ---------------------------------------------------------------------------
// opening-ar-include.test.mjs — count a pre-opening SALES invoice as opening.
//
// Owner 2026-08-06, reconciling Carress against that customer's own creditor
// aging: six ERP invoices dated before 22/05 are exactly the RM 8,828 Carress
// admits owing, so they belong in the opening — but there was no way to say so.
// The AP side has had `ap-exclude` since 2026-07-02; the AR twin was noted as
// missing on 2026-07-09 and never built.
//
// The three properties that keep it safe:
//   1. it runs OPT-IN, the opposite of AP — flipping the AR default would sweep
//      every customer's pre-opening invoices into the books at once
//   2. an invoice dated on/after the opening is refused — it is already in the
//      ledger on its own date and would be counted twice
//   3. un-flagging is the undo. The existing "remove" DELETES the invoice row,
//      which is right for a seed and catastrophic for a real document.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const API = read("src/api/routes/accounting.ts");
const UI = read("src/pages/accounting/index.tsx");

const EP = API.slice(API.indexOf('app.post("/opening-balance/ar-include"'));

test("the endpoint exists and is permission-gated", () => {
  assert.ok(EP.length > 0, "POST /opening-balance/ar-include must exist");
  assert.match(EP.slice(0, 300), /requirePermission\(c, "accounting", "create"\)/);
});

test("it sets isOpening on the invoice, and touches nothing else", () => {
  assert.match(EP, /UPDATE invoices SET isOpening = \?, updated_at = \? WHERE id = \?/);
  // No amount, status or payment writes hidden in the handler.
  assert.doesNotMatch(EP.slice(0, 3000), /SET totalSen|SET status|SET paidAmount/);
});

test("an invoice dated on/after the opening date is REFUSED", () => {
  assert.match(EP, /inv\.invoiceDate \?\? ""\)\.slice\(0, 10\) >= openingDate/);
  assert.match(EP, /already in the ledger and must not also be opening/);
});

test("DRAFT and CANCELLED cannot be part of the opening", () => {
  assert.match(EP, /inv\.status === "DRAFT" \|\| inv\.status === "CANCELLED"/);
});

test("the aging snapshot is bumped so the change shows immediately", () => {
  // BUG-2026-07-09-002: a change that writes no probed table leaves the
  // snapshot serving the old set forever.
  assert.match(EP, /opening_ar_include_rev/);
});

test("the list is opt-IN — pre-opening invoices are not opening by default", () => {
  assert.match(API, /preExistingAr/);
  const q = API.slice(API.indexOf("let preExistingAr"));
  assert.match(q.slice(0, 900), /COALESCE\(isOpening, 0\) = 0/);
  assert.match(q.slice(0, 900), /invoiceDate < \?/);
});

test("deleting a REAL invoice that was flagged as opening is refused", () => {
  const del = API.slice(API.indexOf('app.delete("/opening-balance/ar/:id"'));
  assert.match(del.slice(0, 2000), /!String\(row\.id\)\.startsWith\("inv-ob-"\)/);
  assert.match(del.slice(0, 2000), /un-tick it with 'remove from opening' instead of deleting it/);
});

test("the UI offers un-flag, not delete, for a real invoice", () => {
  assert.match(UI, /r\.id\.startsWith\("inv-ob-"\) \? \(/);
  assert.match(UI, /toggleArInclude\(r\.id, false\)/);
  assert.match(UI, /remove from opening/);
});

test("the UI counts an invoice at FACE value, and says so", () => {
  assert.match(UI, /count as opening/);
  assert.match(UI, /later payments reduce it on their own dates/);
});
