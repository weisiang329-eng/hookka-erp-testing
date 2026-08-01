// ---------------------------------------------------------------------------
// reverse-doc-links.test.mjs — pin the reverse document links (2026-08-01).
//
// Several document relationships existed in the DB but were only discoverable
// in ONE direction: the child row stored the parent's id, so the parent's
// detail page could not say what was linked to it. Two detail pages papered
// over that by downloading a WHOLE list and filtering client-side.
//
// What this file pins:
//   1. Each `GET /:id` handler returns its new `linked*` field, sourced from a
//      query on the reverse key (not fabricated, not derived from status).
//   2. The indexes those queries depend on are RUNTIME self-applied
//      (`CREATE INDEX IF NOT EXISTS`) — migration files are inert on deploy,
//      so a migration-only index would never reach prod.
//   3. The two detail pages no longer fetch whole lists client-side.
//
// Style: structural regex pins on source (cn-do-parity-gaps.test.mjs pattern).
// These are the cheap guards that stop a later refactor silently reverting to
// "fetch everything and filter in the browser".
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const PO_ROUTE = read("../src/api/routes/purchase-orders.ts");
const PI_ROUTE = read("../src/api/routes/purchase-invoices.ts");
const DO_ROUTE = read("../src/api/routes/delivery-orders.ts");
const INV_ROUTE = read("../src/api/routes/invoices.ts");
const CASES_ROUTE = read("../src/api/routes/service-cases.ts");

const PO_PAGE = read("../src/pages/procurement/detail.tsx");
const PI_PAGE = read("../src/pages/procurement/PurchaseInvoiceDetail.tsx");
const DO_PAGE = read("../src/pages/delivery/detail.tsx");
const INV_PAGE = read("../src/pages/invoices/detail.tsx");

// Slice out a route file's `app.get("/:id", …)` handler so a `linked*` mention
// somewhere else in the file (a POST, a comment block) cannot satisfy a pin.
function getByIdHandler(src, label) {
  const start = src.indexOf(`app.get("/:id"`);
  assert.ok(start >= 0, `${label}: no app.get("/:id") handler found`);
  // Next top-level route registration ends the handler.
  const rest = src.slice(start + 10);
  const nextIdx = rest.search(/\napp\.(get|put|post|delete|patch)\(/);
  return nextIdx >= 0 ? rest.slice(0, nextIdx) : rest;
}

const PO_GET = getByIdHandler(PO_ROUTE, "purchase-orders");
const PI_GET = getByIdHandler(PI_ROUTE, "purchase-invoices");
const DO_GET = getByIdHandler(DO_ROUTE, "delivery-orders");
const INV_GET = getByIdHandler(INV_ROUTE, "invoices");

// ---------------------------------------------------------------------------
// 1. purchase-orders GET /:id — linkedGRNs + linkedPIs
//
// WHY: a PO could have been fully received and invoiced, and the only way to
// learn that from the PO was to download every GRN and every purchase invoice
// in the system and filter them in the browser.
// ---------------------------------------------------------------------------
test("PO detail returns linkedGRNs from grns.poId", () => {
  assert.match(PO_GET, /linkedGRNs:/);
  assert.match(PO_GET, /FROM grns\s+WHERE poId = \?/);
});

test("PO detail returns linkedPIs from purchase_invoices.purchaseOrderId", () => {
  assert.match(PO_GET, /linkedPIs:/);
  assert.match(PO_GET, /FROM purchase_invoices\s+WHERE purchaseOrderId = \?/);
});

test("PO detail resolves both links in one Promise.all with the PO fetch", () => {
  assert.match(PO_GET, /await Promise\.all\(\[/);
});

// ---------------------------------------------------------------------------
// 2. purchase-invoices GET /:id — linkedPayments + linkedGRNs
//
// WHY: a purchase invoice could be fully paid and its page gave no indication
// a payment existed — supplier_payments only pointed at the PI, never back.
// ---------------------------------------------------------------------------
test("PI detail returns linkedPayments from supplier_payments.purchaseInvoiceId", () => {
  assert.match(PI_GET, /linkedPayments,?/);
  assert.match(PI_GET, /FROM supplier_payments\s+WHERE purchaseInvoiceId = \?/);
});

test("PI detail returns linkedGRNs resolved from the PI's own grn_id", () => {
  assert.match(PI_GET, /linkedGRNs,?/);
  assert.match(PI_GET, /FROM grns\s+WHERE id = \?/);
  // The grn_id is dual-keyed on read by rowToPI; the handler must go through
  // that projection rather than reaching for a raw column that may not exist.
  assert.match(PI_GET, /projected\.grnId/);
});

// ---------------------------------------------------------------------------
// 3. delivery-orders GET /:id — linkedReturns
//
// WHY: the DO page never mentioned delivery returns at all, so goods coming
// back off a delivery (stock reversed + a credit note or repair order raised)
// left the source DO looking like a clean, closed document.
// ---------------------------------------------------------------------------
test("DO detail returns linkedReturns from delivery_returns.delivery_order_id", () => {
  assert.match(DO_GET, /linkedReturns/);
  assert.match(DO_GET, /FROM delivery_returns\s+WHERE delivery_order_id = \?/);
});

test("DO detail aliases the snake_case return columns it selects", () => {
  // return_no / return_type have NO column-rename-map.json entry, so the
  // camelCase spelling would NOT resolve — the physical name plus a quoted
  // alias is the only correct form.
  assert.match(DO_GET, /return_no AS "returnNo"/);
  assert.match(DO_GET, /return_type AS "returnType"/);
});

// ---------------------------------------------------------------------------
// 4. invoices GET /:id — linkedCreditNotes + linkedDebitNotes
//
// WHY: an invoice could be half credited back and its own page still showed
// the original total — the most misleading number on the page.
// ---------------------------------------------------------------------------
test("invoice detail returns linkedCreditNotes from credit_notes.invoiceId", () => {
  assert.match(INV_GET, /linkedCreditNotes:/);
  assert.match(INV_GET, /FROM credit_notes\s+WHERE invoiceId = \?/);
});

test("invoice detail returns linkedDebitNotes from debit_notes.invoiceId", () => {
  assert.match(INV_GET, /linkedDebitNotes:/);
  assert.match(INV_GET, /FROM debit_notes\s+WHERE invoiceId = \?/);
});

// ---------------------------------------------------------------------------
// 5. Indexes are RUNTIME self-applied, never migration-only.
//
// Migration files are NOT replayed on deploy, so an index that only exists in
// migrations-postgres/ is inert in prod. Every index these queries rely on
// must be created by a memoised runtime ensure whose failure is swallowed.
// ---------------------------------------------------------------------------
test("credit/debit note invoice_id indexes are runtime self-applied", () => {
  assert.match(
    INV_ROUTE,
    /CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice_id ON credit_notes \(invoice_id\)/,
  );
  assert.match(
    INV_ROUTE,
    /CREATE INDEX IF NOT EXISTS idx_debit_notes_invoice_id ON debit_notes \(invoice_id\)/,
  );
});

test("the note-index ensure is memoised and swallows failure with a warn", () => {
  assert.match(INV_ROUTE, /let _invNoteIndexMig: Promise<void> \| null = null/);
  assert.match(INV_ROUTE, /if \(!_invNoteIndexMig\)/);
  assert.match(INV_ROUTE, /console\.warn\("\[invoices\] ensureInvoiceNoteIndexes:/);
});

test("invoice GET /:id awaits the note-index ensure before querying", () => {
  assert.match(INV_GET, /await ensureInvoiceNoteIndexes\(c\.var\.DB\)/);
});

test("sales_orders.caseid index is runtime self-applied (perf fix)", () => {
  // service-cases.ts loadSvOrdersForCases() filters sales_orders on caseid on
  // every case-detail load. The column was runtime-added with no index, so the
  // query full-scanned a table that grows with every order.
  assert.match(
    CASES_ROUTE,
    /CREATE INDEX IF NOT EXISTS idx_sales_orders_caseid ON sales_orders \(caseid\)/,
  );
  // It rides the existing memoised ensure that loadSvOrdersForCases awaits.
  assert.match(CASES_ROUTE, /function ensureCaseLinkColumns/);
  assert.match(CASES_ROUTE, /console\.warn\("\[service-cases\] idx_sales_orders_caseid:/);
  const ensureStart = CASES_ROUTE.indexOf("function ensureCaseLinkColumns");
  const ensureEnd = CASES_ROUTE.indexOf("idx_sales_orders_caseid");
  assert.ok(
    ensureEnd > ensureStart,
    "idx_sales_orders_caseid must live inside ensureCaseLinkColumns",
  );
});

// ---------------------------------------------------------------------------
// 6. The detail pages no longer download whole lists to answer a per-document
//    question. These are the pins that matter most — the fetches are easy to
//    reintroduce and cost an unbounded payload on every page view.
// ---------------------------------------------------------------------------
test("PO detail page no longer fetches the whole GRN or PI list", () => {
  assert.doesNotMatch(PO_PAGE, /useCachedJson<[^>]*>\(\s*"\/api\/grn"\s*\)/s);
  assert.doesNotMatch(PO_PAGE, /useCachedJson<[^>]*>\(\s*"\/api\/purchase-invoices"\s*\)/s);
  // and no client-side filtering of those lists survives
  assert.doesNotMatch(PO_PAGE, /\.filter\(\(g\) => g\.poId === po\?\.id\)/);
  assert.doesNotMatch(PO_PAGE, /\.filter\(\(p\) => p\.purchaseOrderId === po\?\.id\)/);
});

test("PO detail page reads linkedGRNs / linkedPIs off the detail response", () => {
  assert.match(PO_PAGE, /resp\?\.linkedGRNs \?\? \[\]/);
  assert.match(PO_PAGE, /resp\?\.linkedPIs \?\? \[\]/);
});

test("PI detail page no longer fetches the whole GRN list", () => {
  assert.doesNotMatch(PI_PAGE, /useCachedJson<[^>]*>\(\s*"\/api\/grn"\s*\)/s);
  assert.match(PI_PAGE, /resp\?\.linkedGRNs \?\? \[\]/);
});

test("PI detail page surfaces the supplier payments that settle the invoice", () => {
  assert.match(PI_PAGE, /resp\?\.linkedPayments \?\? \[\]/);
  assert.match(PI_PAGE, /Supplier Payments \(/);
});

test("DO detail page surfaces delivery returns", () => {
  assert.match(DO_PAGE, /doResp\?\.linkedReturns \?\? \[\]/);
  assert.match(DO_PAGE, /Delivery Returns \(/);
  // links out to the return's own detail page
  assert.match(DO_PAGE, /\/delivery-returns\/\$\{r\.id\}/);
});

test("invoice detail page surfaces credit and debit notes", () => {
  assert.match(INV_PAGE, /invResp\?\.linkedCreditNotes \?\? \[\]/);
  assert.match(INV_PAGE, /invResp\?\.linkedDebitNotes \?\? \[\]/);
  assert.match(INV_PAGE, /Adjustments/);
});

// ---------------------------------------------------------------------------
// 7. Guard-rail: consignment notes / converted_invoice_id are explicitly OUT
//    of scope (that relationship is under review with the owner). Pin that
//    this change did not quietly wire it up.
// ---------------------------------------------------------------------------
// This began life as a SCOPE GUARD — the consignment link was under review with
// the owner when these reverse queries were written, so the test asserted it had
// deliberately been left alone. The owner has since ruled that
// convert-to-invoice IS official (#197), so the guard expired: the same lookup
// it used to forbid is now required. Inverted rather than deleted, so the two
// features are pinned as coexisting in one payload instead of one silently
// dropping the other on a future merge.
test("the CN reverse link coexists with the credit/debit note lookups", () => {
  assert.match(INV_GET, /convertedInvoiceId/);
  assert.match(INV_GET, /consignment_notes/);
  assert.match(INV_GET, /linkedCreditNotes/);
  assert.match(INV_GET, /linkedDebitNotes/);
});
