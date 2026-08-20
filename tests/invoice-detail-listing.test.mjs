// ---------------------------------------------------------------------------
// invoice-detail-listing — the per-line invoice export.
//
// Owner 2026-08-20: 「我可以怎么样 export 整个 excel listing check details
// listing price 呢？」 Invoices were the one module with no per-line export, and
// the reason was written in the page: GET /api/invoices ships `items: []` on
// every row, so a detail listing needed a per-invoice re-fetch nobody had built.
//
// Two properties carry the weight here, and both are the same lesson the day
// taught expensively:
//
//   1. a component that does not apply renders BLANK, not 0.00. A sofa has no
//      divan; "0.00" states a fact about a thing that does not exist. Blank
//      says "not applicable", zero says "it costs nothing".
//   2. "Build-up reconciles" is YES / NO / BLANK. An unresolved build-up is an
//      ABSENCE, not a mismatch — reporting it as NO sends the operator hunting
//      for an error that is not there.
//
// The fetcher is tested with injected deps: no network, no real waiting.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInvoiceDetailListingAoa,
  reconcilesCell,
  INVOICE_DETAIL_HEADERS,
} from '../src/lib/invoice-detail-listing.ts';
import { buildInvoiceDetailRows } from '../src/lib/invoice-detail-export.ts';

const H = INVOICE_DETAIL_HEADERS;
const col = (name) => H.indexOf(name);

const doc = (over = {}) => ({
  invoiceNo: 'INV-2608-051',
  invoiceDate: '2026-08-14T00:00:00.000Z',
  customerName: 'Houzs Century',
  status: 'SENT',
  subtotalSen: 228800,
  totalSen: 228800,
  items: [],
  ...over,
});

const sofa = (over = {}) => ({
  id: 'invi-824a1c9f',
  productCode: '5535-1A(RHF)',
  productName: 'SOFA 5535 1A(RHF)',
  itemCategory: 'SOFA',
  quantity: 1,
  basePriceSen: 75600,
  specialOrderPriceSen: 20000,
  unitPriceSen: 95600,
  totalSen: 95600,
  ...over,
});

// --- 1. shape ------------------------------------------------------------
test('one row per line item, header repeated', () => {
  const aoa = buildInvoiceDetailListingAoa([
    doc({ items: [sofa(), sofa({ id: 'invi-2' }), sofa({ id: 'invi-3' })] }),
  ]);
  assert.equal(aoa.length, 4, 'header + 3 lines');
  for (const row of aoa.slice(1)) {
    assert.equal(row[col('Doc. No.')], 'INV-2608-051');
    assert.equal(row[col('Debtor Name')], 'Houzs Century');
  }
});

test('an invoice with no lines still produces a row', () => {
  // Dropping it silently would make the export disagree with the count on
  // screen, and a short file that looks complete is the whole failure mode.
  const aoa = buildInvoiceDetailListingAoa([doc({ items: [] })]);
  assert.equal(aoa.length, 2);
  assert.equal(aoa[1][col('Doc. No.')], 'INV-2608-051');
});

// --- 2. the components ---------------------------------------------------
test('a sofa gets BLANK divan and t.height, not 0.00', () => {
  const aoa = buildInvoiceDetailListingAoa([doc({ items: [sofa()] })]);
  const r = aoa[1];
  assert.equal(r[col('Base')], 756, 'base in ringgit');
  assert.equal(r[col('Special')], 200);
  assert.equal(r[col('Divan')], '', 'a sofa has no divan — blank, never 0.00');
  assert.equal(r[col('T.Height')], '', 'total height is bedframe geometry');
  assert.equal(r[col('Leg')], 0, 'a sofa DOES take a leg price, so it renders');
});

test('a bedframe gets all five components', () => {
  const bf = {
    id: 'invi-bf', productCode: '2038(A)-(K)', itemCategory: 'BEDFRAME', quantity: 1,
    basePriceSen: 71000, divanPriceSen: 5500, unitPriceSen: 76500, totalSen: 76500,
  };
  const r = buildInvoiceDetailListingAoa([doc({ items: [bf] })])[1];
  assert.equal(r[col('Base')], 710);
  assert.equal(r[col('Divan')], 55);
  assert.equal(r[col('Leg')], 0);
  assert.equal(r[col('T.Height')], 0);
});

test('a component holding money renders even where the category says no', () => {
  const odd = sofa({ divanPriceSen: 5500, unitPriceSen: 101100 });
  const r = buildInvoiceDetailListingAoa([doc({ items: [odd] })])[1];
  assert.equal(r[col('Divan')], 55, 'money is never hidden by a category rule');
});

// --- 3. the reconciliation column ---------------------------------------
test('reconciles: YES when the components add up', () => {
  assert.equal(reconcilesCell(sofa()), 'YES');
});

test('reconciles: NO when they do not', () => {
  assert.equal(reconcilesCell(sofa({ unitPriceSen: 95700 })), 'NO');
});

test('reconciles: BLANK when the build-up was never resolved', () => {
  // Not a mismatch — an absence. The distinction is the point of the column.
  const unresolved = {
    id: 'x', quantity: 1, unitPriceSen: 60000,
    basePriceSen: 0, divanPriceSen: 0, legPriceSen: 0,
    totalHeightPriceSen: 0, specialOrderPriceSen: 0,
  };
  assert.equal(reconcilesCell(unresolved), '');
});

test('reconciles: a genuinely free line reads YES, not blank', () => {
  const free = { id: 'x', quantity: 1, unitPriceSen: 0 };
  assert.equal(reconcilesCell(free), 'YES', '0 = 0 reconciles');
});

// --- 4. the round-trip key ----------------------------------------------
test('every row carries its Line ID', () => {
  // An invoice can hold the SAME product code several times — INV-2608-031 has
  // 1007-(Q) four times — so invoice number + item code cannot identify a line.
  const dup = [
    { id: 'invi-a', productCode: '1007-(Q)', quantity: 1, unitPriceSen: 42500 },
    { id: 'invi-b', productCode: '1007-(Q)', quantity: 1, unitPriceSen: 42500 },
  ];
  const aoa = buildInvoiceDetailListingAoa([doc({ items: dup })]);
  assert.equal(aoa[1][col('Line ID')], 'invi-a');
  assert.equal(aoa[2][col('Line ID')], 'invi-b');
  assert.notEqual(aoa[1][col('Line ID')], aoa[2][col('Line ID')]);
});

test('a line written by the price editor is flagged', () => {
  const r = buildInvoiceDetailListingAoa([doc({ items: [sofa({ priceEdited: 1 })] })])[1];
  assert.equal(r[col('Price Edited')], 'YES');
});

// --- 5. the fetcher ------------------------------------------------------
const fakeDeps = (responses, log = []) => ({
  wait: async () => {},
  confirmLarge: () => true,
  fetchJson: async (url) => {
    log.push(url);
    if (url in responses) {
      const v = responses[url];
      if (v instanceof Error) throw v;
      return v;
    }
    throw new Error('HTTP 404');
  },
});

test('the fetcher merges print-extras onto the lines', async () => {
  const log = [];
  const deps = fakeDeps({
    '/api/invoices/inv-1': { data: doc({ id: 'inv-1', items: [{ id: 'L1', productCode: 'X', quantity: 1, unitPriceSen: 95600, basePriceSen: 75600, specialOrderPriceSen: 20000 }] }) },
    '/api/invoices/inv-1/print-extras': { data: { items: { L1: { itemCategory: 'SOFA', companySO: 'SO-2607-039' } } } },
  }, log);
  const aoa = await buildInvoiceDetailRows([{ id: 'inv-1' }], deps);
  assert.equal(aoa[1][col('Category')], 'SOFA');
  assert.equal(aoa[1][col('Our SO')], 'SO-2607-039');
  assert.equal(aoa[1][col('Divan')], '', 'the merged category drives the blank');
  assert.deepEqual(log, ['/api/invoices/inv-1', '/api/invoices/inv-1/print-extras']);
});

test('losing print-extras loses the enrichment, never the invoice', async () => {
  const deps = fakeDeps({
    '/api/invoices/inv-1': { data: doc({ id: 'inv-1', items: [{ id: 'L1', productCode: 'X', quantity: 1, unitPriceSen: 42500 }] }) },
    '/api/invoices/inv-1/print-extras': new Error('HTTP 500'),
  });
  const aoa = await buildInvoiceDetailRows([{ id: 'inv-1' }], deps);
  assert.equal(aoa.length, 2, 'the line is still exported');
  assert.equal(aoa[1][col('Category')], '', 'category simply unknown');
});

test('an invoice that cannot be read is REPORTED, not dropped', async () => {
  // A silently short export is how a spreadsheet comes to be trusted for
  // something it does not contain.
  const deps = fakeDeps({
    '/api/invoices/ok': { data: doc({ id: 'ok', items: [{ id: 'L1', quantity: 1, unitPriceSen: 100 }] }) },
    '/api/invoices/ok/print-extras': { data: { items: {} } },
  });
  const aoa = await buildInvoiceDetailRows(
    [{ id: 'ok' }, { id: 'bad', invoiceNo: 'INV-BAD' }],
    deps,
  );
  assert.equal(aoa.length, 3, 'header + the good line + the failure row');
  const failure = aoa[2];
  assert.equal(failure[col('Doc. No.')], 'INV-BAD');
  assert.match(String(failure[col('Status')]), /EXPORT FAILED/);
});

test('declining the large-export confirm exports nothing', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ id: `inv-${i}` }));
  const deps = { ...fakeDeps({}), confirmLarge: () => false };
  const aoa = await buildInvoiceDetailRows(rows, deps);
  assert.equal(aoa.length, 1, 'header only — a refusal must not half-export');
});
