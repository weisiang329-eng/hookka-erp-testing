// ---------------------------------------------------------------------------
// payment-allocation-numbers.test.mjs — an allocation must name its invoice.
//
// Owner 2026-08-06, reconciling Carress line by line against that customer's
// own statement: 「分配记录我要看到」. Every one of the 23 allocations on his
// Carress receipts carried an EMPTY invoice number — the detail panel listed
// amounts against nothing, and finding which receipt paid which invoice meant
// matching by amount.
//
// The create path resolved the number all along. The restate path took whatever
// the client sent, and the form sends {invoiceId, amount} only — so a receipt
// was fine until the first time it was EDITED, then its lines went blank. Every
// Carress receipt had been edited.
//
// Fixed at both ends: the restate resolves the number server-side rather than
// trusting the client, and reads fill in any blank from the invoice — which
// repairs the receipts already stored, not just the next one.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const API = read("src/api/routes/payments.ts");
const UI = read("src/pages/invoices/payments.tsx");

test("the restate resolves the invoice number itself, not from the client", () => {
  const fn = API.slice(API.indexOf("async function buildCustomerPaymentRestate"));
  assert.match(fn.slice(0, 3000), /SELECT id, invoiceNo FROM invoices WHERE id IN/);
  assert.match(fn.slice(0, 3000), /a\.invoiceNumber = a\.invoiceNumber \|\| byId\.get\(a\.invoiceId\) \|\| ""/);
});

test("reads fill in a blank number, repairing receipts already stored", () => {
  assert.match(API, /async function fillAllocationNumbers/);
  assert.match(API, /r\.allocations\.filter\(\(a\) => a\.invoiceId && !a\.invoiceNumber\)/);
});

test("both the list and the single-payment read go through it", () => {
  const uses = API.match(/await fillAllocationNumbers\(/g) ?? [];
  assert.ok(uses.length >= 2, `expected the list and detail reads to resolve; found ${uses.length}`);
});

test("the lookup is chunked — a receipt can carry dozens of lines", () => {
  const fn = API.slice(API.indexOf("async function fillAllocationNumbers"));
  assert.match(fn.slice(0, 1400), /i \+= 100/);
});

test("a number that STILL cannot resolve is shown, not left blank", () => {
  // An unresolvable id means the invoice is gone — an empty cell hides that.
  assert.match(UI, /a\.invoiceNumber \|\| <span[^>]*>\(invoice missing\)<\/span>/);
});

test("the create path still resolves it too", () => {
  assert.match(API, /invoiceNumber: invoiceSnapshots\.get\(a\.invoiceId\)\?\.invoiceNo \?\? ""/);
});
