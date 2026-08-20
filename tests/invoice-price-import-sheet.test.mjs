// ---------------------------------------------------------------------------
// invoice-price-import-sheet — everything that can be wrong about the SHAPE of
// an edited Detail Listing, decided before a single row reaches the planner.
//
// Columns are found BY NAME, never by position. The operator will hide columns,
// reorder them and paste a subset into a fresh sheet — all reasonable things to
// do to a spreadsheet, all of which break a positional reader SILENTLY.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import { readImportSheet } from '../src/lib/invoice-price-import-sheet.ts';

const HEAD = ['Doc. No.', 'Item Code', 'Base', 'Divan', 'Leg', 'T.Height', 'Special', 'Unit Price', 'Discount', 'Line ID'];
const ROW = ['INV-2608-051', '5535-1A(RHF)', 800, '', '', '', '', 956, '', 'invi-1'];

test('a straight export round-trips', () => {
  const r = readImportSheet([HEAD, ROW]);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].lineId, 'invi-1');
  assert.equal(r.rows[0].invoiceNo, 'INV-2608-051');
  assert.equal(r.rows[0].exportedUnit, 956);
  assert.equal(r.rows[0].base, 800);
  assert.equal(r.rows[0].divan, '', 'a blank cell stays blank — never becomes 0');
});

test('columns may be reordered', () => {
  const head = ['Line ID', 'Unit Price', 'Base', 'Doc. No.'];
  const row = ['invi-9', 425, 500, 'INV-1'];
  const r = readImportSheet([head, row]);
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].lineId, 'invi-9');
  assert.equal(r.rows[0].base, 500);
});

test('header matching ignores case and spacing', () => {
  const r = readImportSheet([['  LINE   ID ', 'unit price', 'BASE'], ['invi-1', 100, 200]]);
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].lineId, 'invi-1');
});

test('a subset of price columns is fine — absent means do not touch', () => {
  const r = readImportSheet([['Line ID', 'Unit Price', 'Base'], ['invi-1', 956, 800]]);
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].base, 800);
  assert.equal(r.rows[0].special, undefined, 'a column that is not there asks for nothing');
});

test('extra columns are reported, not fatal', () => {
  const r = readImportSheet([[...HEAD, 'My Notes'], [...ROW, 'check this']]);
  assert.equal(r.ok, true);
  assert.ok(r.ignoredColumns.includes('My Notes'));
  assert.ok(r.ignoredColumns.includes('Item Code'));
});

test('NO Line ID column is fatal', () => {
  const r = readImportSheet([['Doc. No.', 'Unit Price', 'Base'], ['INV-1', 956, 800]]);
  assert.equal(r.ok, false);
  assert.match(r.error, /Line ID/);
  assert.match(r.error, /row order/, 'and it says why, so nobody adds one by hand');
});

test('NO Unit Price column is fatal — it is the staleness baseline', () => {
  const r = readImportSheet([['Line ID', 'Base'], ['invi-1', 800]]);
  assert.equal(r.ok, false);
  assert.match(r.error, /baseline/);
});

test('two columns meaning the same thing is refused, not silently resolved', () => {
  const r = readImportSheet([['Line ID', 'Unit Price', 'Base', 'base'], ['invi-1', 956, 800, 900]]);
  assert.equal(r.ok, false);
  assert.match(r.error, /two columns/);
});

test('blank spacer rows are dropped, not sent as empty edits', () => {
  const r = readImportSheet([HEAD, ROW, ['', '', '', '', '', '', '', '', '', ''], ROW]);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 2);
});

test('an empty file and a header-only file both say so', () => {
  assert.equal(readImportSheet([]).ok, false);
  const h = readImportSheet([HEAD]);
  assert.equal(h.ok, false);
  assert.match(h.error, /no data rows/);
});
