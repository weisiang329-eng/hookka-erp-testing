// ---------------------------------------------------------------------------
// cn-invoice-link.test.mjs — structural pins for the CN → invoice link.
//
// BACKGROUND. docs/CODEBASE-MAP.md carried an owner ruling reading "CNs NEVER
// have invoices". The code said otherwise and had for months:
//   • migrations-postgres/0070_cn_invoice_link.sql adds
//     consignment_notes.converted_invoice_id — a REAL FK to invoices(id),
//     backed by idx_consignment_notes_converted_invoice_id.
//   • src/api/routes/consignment-notes.ts serves
//     POST /:id/convert-to-invoice, which creates a DRAFT invoice and stamps
//     the CN (idempotent — a second call 409s with the existing invoice id).
// The owner re-confirmed on 2026-08-01 that convert-to-invoice IS an official
// flow, so the DOC was the stale side, not the code.
//
// These tests pin the consequences of that ruling:
//   1. the doc no longer asserts "CNs NEVER have invoices";
//   2. the CO payload carries the real converted invoice;
//   3. the invoice endpoint exposes its source CN;
//   4. the consignment detail page no longer FABRICATES an invoice number
//      out of order.status.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

const doc = read("../docs/CODEBASE-MAP.md");
const coRoute = read("../src/api/routes/consignment-orders.ts");
const invRoute = read("../src/api/routes/invoices.ts");
const cnRoute = read("../src/api/routes/consignment-notes.ts");
const coDetailPage = read("../src/pages/consignment/detail.tsx");
const invDetailPage = read("../src/pages/invoices/detail.tsx");
const renameMap = JSON.parse(read("../src/api/lib/column-rename-map.json"));

// ---------------------------------------------------------------------------
// 1. The docs no longer claim CNs never have invoices.
// ---------------------------------------------------------------------------
test("CODEBASE-MAP no longer claims CNs never have invoices", () => {
  assert.doesNotMatch(
    doc,
    /CNs NEVER have invoices/,
    'the stale "CNs NEVER have invoices" ruling must not reappear anywhere in the map',
  );
});

test("CODEBASE-MAP records the convert-to-invoice flow and its re-confirmation date", () => {
  assert.match(
    doc,
    /convert-to-invoice/,
    "the map must name the POST /api/consignment-notes/:id/convert-to-invoice endpoint",
  );
  assert.match(
    doc,
    /converted_invoice_id/,
    "the map must name the real link column consignment_notes.converted_invoice_id",
  );
  assert.match(
    doc,
    /2026-08-01/,
    "the map must record the date the owner re-confirmed the flow",
  );
});

test("CODEBASE-MAP keeps the separate 3PL ruling intact", () => {
  // The invoice claim was corrected; the co-located 3PL claim is a DIFFERENT
  // ruling and must survive the edit.
  assert.match(doc, /3PL stays DO-side/);
});

// ---------------------------------------------------------------------------
// 2. The link is real in the schema and written by the endpoint.
// ---------------------------------------------------------------------------
test("convert-to-invoice writes the link and stays idempotent", () => {
  assert.match(
    cnRoute,
    /app\.post\("\/:id\/convert-to-invoice"/,
    "the official convert-to-invoice endpoint must still exist",
  );
  assert.match(
    cnRoute,
    /convertedInvoiceId = \?/,
    "conversion must stamp the CN with the new invoice id",
  );
  assert.match(
    cnRoute,
    /already converted to invoice/,
    "conversion must keep its idempotency guard (one invoice per CN)",
  );
});

test("the camelCase link column is mapped to its snake_case physical column", () => {
  assert.equal(renameMap.convertedInvoiceId, "converted_invoice_id");
  assert.equal(renameMap.noteNumber, "note_number");
  assert.equal(renameMap.invoiceNo, "invoice_no");
});

// ---------------------------------------------------------------------------
// 3. Forward direction — the CO payload carries the converted invoice.
// ---------------------------------------------------------------------------
test("GET /api/consignment-orders/:id selects the CN's converted invoice", () => {
  assert.match(
    coRoute,
    /LEFT JOIN invoices inv ON inv\.id = cn\.convertedInvoiceId/,
    "linkedCNs must join the real invoice row",
  );
  assert.match(
    coRoute,
    /cn\.convertedInvoiceId/,
    "linkedCNs must select the link column itself",
  );
  assert.match(
    coRoute,
    /inv\.invoiceNo/,
    "linkedCNs must select the real invoice number",
  );
});

test("linkedCNs exposes the converted invoice on the CO payload, dual-keyed", () => {
  assert.match(
    coRoute,
    /convertedInvoiceId: cn\.convertedInvoiceId \?\? cn\.converted_invoice_id \?\? null/,
    "the link must be read dual-keyed (camelCase ?? snake_case)",
  );
  assert.match(
    coRoute,
    /convertedInvoiceNo: cn\.invoiceNo \?\? cn\.invoice_no \?\? null/,
    "the invoice number must be read dual-keyed too",
  );
});

test("the one invented SQL alias is quoted so D1Compat leaves it alone", () => {
  // supabase-compat rewrites every BARE identifier through
  // column-rename-map.json, aliases included. `invoiceStatus` has no map
  // entry, so an unquoted alias would fold to `invoicestatus` in Postgres
  // and come back un-camelCased. Quoting it is what makes the read work.
  assert.match(
    coRoute,
    /inv\.status AS "invoiceStatus"/,
    "the invoiceStatus alias must stay double-quoted",
  );
});

// ---------------------------------------------------------------------------
// 4. Reverse direction — the invoice endpoint exposes its source CN.
// ---------------------------------------------------------------------------
test("GET /api/invoices/:id looks the source CN up by converted_invoice_id", () => {
  assert.match(
    invRoute,
    /SELECT id, noteNumber FROM consignment_notes WHERE convertedInvoiceId = \?/,
    "the reverse lookup must probe the indexed link column",
  );
  assert.match(
    invRoute,
    /sourceConsignmentNote/,
    "the reverse link must be exposed on the response",
  );
  assert.match(
    invRoute,
    /lockReason, sourceConsignmentNote \}\)/,
    "sourceConsignmentNote must be returned alongside the existing payload",
  );
});

test("the reverse lookup is best-effort and never fails the invoice read", () => {
  const start = invRoute.indexOf("let sourceConsignmentNote");
  assert.ok(start > -1, "the reverse lookup block must exist");
  const block = invRoute.slice(start, start + 1400);
  assert.match(block, /try \{/);
  assert.match(block, /catch \(err\)/);
});

// ---------------------------------------------------------------------------
// 5. The consignment detail page no longer fabricates an invoice number.
// ---------------------------------------------------------------------------
test("consignment detail no longer invents an invoice number from status", () => {
  assert.doesNotMatch(
    coDetailPage,
    /INV-\$\{/,
    "the fabricated `INV-${...}` document number must stay gone",
  );
  assert.doesNotMatch(
    coDetailPage,
    /docNo: `INV-/,
    "no invoice node may build its docNo from a template literal",
  );
});

test("consignment detail renders the REAL converted invoice", () => {
  assert.match(
    coDetailPage,
    /linkedCNs\.find\(\(cn\) => !!cn\.convertedInvoiceId\)/,
    "the invoice node must be driven by the real CN link",
  );
  assert.match(
    coDetailPage,
    /docNo: invoicedCN\.convertedInvoiceNo \|\| invoicedCN\.convertedInvoiceId/,
    "the node must show the real invoice number, not a derived one",
  );
  assert.match(
    coDetailPage,
    /href: `\/invoices\/\$\{invoicedCN\.convertedInvoiceId\}`/,
    "the node must deep-link to the real invoice",
  );
  assert.match(
    coDetailPage,
    /status: "PENDING"/,
    "with no real link the node must fall back to an explicit pending state",
  );
});

test("LinkedCN carries the link fields on the frontend type", () => {
  assert.match(coDetailPage, /convertedInvoiceId\?: string \| null;/);
  assert.match(coDetailPage, /convertedInvoiceNo\?: string \| null;/);
});

// ---------------------------------------------------------------------------
// 6. Invoice detail surfaces its provenance.
// ---------------------------------------------------------------------------
test("invoice detail shows a one-line 'Created from consignment note' link", () => {
  assert.match(
    invDetailPage,
    /Created from consignment note/,
    "provenance line must be present (English UI text)",
  );
  assert.match(
    invDetailPage,
    /invResp\?\.sourceConsignmentNote \?\? null/,
    "the line must read the real reverse link from the API response",
  );
  assert.match(
    invDetailPage,
    /\/consignment\/note\?focus=\$\{sourceCN\.id\}/,
    "the link must deep-link the CN list at the source note",
  );
});
