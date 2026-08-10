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
  // Either field missing pulls the invoice — a stored allocation has neither.
  assert.match(API, /a\.invoiceId && \(!a\.invoiceNumber \|\| !a\.invoiceDate\)/);
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

// Owner 2026-08-06: 「这边也显示日期, invoice number, 然后 amount」. An
// allocation stores only an id and an amount; the date is what makes a receipt
// checkable against a customer statement, which is ordered by date.
test("the allocation carries the invoice DATE as well", () => {
  assert.match(API, /type Allocation = \{[^}]*invoiceDate\?: string/);
  assert.match(API, /SELECT id, invoiceNo, invoiceDate FROM invoices WHERE id IN/);
  assert.match(API, /if \(!a\.invoiceDate\) a\.invoiceDate = hit\?\.date \?\? "";/);
});

test("the lines come back oldest first, like the list they were picked from", () => {
  const fn = API.slice(API.indexOf("async function fillAllocationNumbers"));
  assert.match(fn.slice(0, 2200), /r\.allocations\.sort\(/);
});

test("the detail panel and the printed receipt both show the date", () => {
  assert.match(UI, /<th className="text-left px-3 py-1\.5 font-medium text-gray-600">Date<\/th>/);
  assert.match(UI, /a\.invoiceDate \? formatDateDMY\(a\.invoiceDate\) : "-"/);
  // …and the voucher, whose column list must stay the same width as its rows.
  assert.match(UI, /cells: \[a\.invoiceDate \? formatDateDMY\(a\.invoiceDate\) : "", a\.invoiceNumber, formatCurrency\(a\.amount\)\]/);
  assert.match(UI, /columns: \[\{ label: "Date" \}, \{ label: "Invoice" \}, \{ label: "Amount", align: "right" \}\]/);
  assert.match(UI, /totalCells: \["", "Total", formatCurrency\(p\.amount\)\]/);
});
