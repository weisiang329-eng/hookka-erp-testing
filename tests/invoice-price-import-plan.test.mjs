// ---------------------------------------------------------------------------
// invoice-price-import-plan — the rules an edited Detail Listing is held to.
//
// The whole point of this file is that a spreadsheet is BUG-2026-08-20-158 with
// the volume turned up. That bug wrote RM 0 into 112 lines because an absence
// was read as a value. In a sheet, an empty cell and a zero are visually
// identical, Excel reformats things behind your back, and the invoice can move
// while the file is open.
//
// So every test below is really the same question: does this refuse, or does it
// guess?
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planInvoicePriceImport,
  cellIsBlank,
  rmCellToSen,
} from '../src/lib/invoice-price-import.ts';

const line = (over = {}) => ({
  id: 'invi-1',
  invoiceNo: 'INV-2608-051',
  invoiceId: 'inv-1',
  invoiceStatus: 'SENT',
  invoicePaidSen: 0,
  quantity: 1,
  unitPriceSen: 95600,
  basePriceSen: 75600,
  divanPriceSen: 0,
  legPriceSen: 0,
  totalHeightPriceSen: 0,
  specialOrderPriceSen: 20000,
  discountSen: 0,
  ...over,
});

const db = (...lines) => new Map(lines.map((l) => [l.id, l]));

const row = (over = {}) => ({
  lineId: 'invi-1',
  invoiceNo: 'INV-2608-051',
  exportedUnit: 956,
  base: '',
  divan: '',
  leg: '',
  totalHeight: '',
  special: '',
  discount: '',
  ...over,
});

// --- 1. THE headline rule ------------------------------------------------
test('every cell blank = nothing is written, and it is not an error', () => {
  const plan = planInvoicePriceImport([row()], db(line()));
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.rejections, []);
  assert.equal(plan.untouched, 1);
});

test('a blank component keeps its current value — blank is NOT zero', () => {
  // The entire bug, in one assertion. The operator edits Base and leaves
  // Special alone; Special must survive.
  const plan = planInvoicePriceImport([row({ base: 800 })], db(line()));
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].after.base, 80000);
  assert.equal(plan.changes[0].after.special, 20000, 'untouched, therefore unchanged');
  assert.deepEqual(plan.changes[0].touched, ['base']);
  assert.equal(plan.changes[0].after.unit, 100000, 'unit is the sum of all five');
});

test('an EXPLICIT zero is honoured and flagged as making the line free', () => {
  const plan = planInvoicePriceImport(
    [row({ base: 0, special: 0 })],
    db(line()),
  );
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].after.unit, 0);
  assert.equal(plan.changes[0].makesFree, true, 'the preview must call this out separately');
});

test('cellIsBlank: only absence is blank; 0 and "0" are values', () => {
  for (const v of [null, undefined, '', '   ']) assert.equal(cellIsBlank(v), true, String(v));
  for (const v of [0, '0', '0.00', 12.5]) assert.equal(cellIsBlank(v), false, String(v));
});

// --- 2. the concurrent-edit guard ---------------------------------------
test('a line that changed since export is REFUSED, not overwritten', () => {
  const plan = planInvoicePriceImport(
    [row({ base: 800 })],
    db(line({ unitPriceSen: 90000 })), // someone repriced it meanwhile
  );
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.rejections.length, 1);
  assert.match(plan.rejections[0].reason, /changed it in the meantime/);
});

test('clearing the Unit Price column is refused — it is the baseline', () => {
  const plan = planInvoicePriceImport([row({ exportedUnit: '', base: 800 })], db(line()));
  assert.equal(plan.changes.length, 0);
  assert.match(plan.rejections[0].reason, /baseline/);
});

// --- 3. matching ---------------------------------------------------------
test('a row with no Line ID is refused', () => {
  const plan = planInvoicePriceImport([row({ lineId: '', base: 800 })], db(line()));
  assert.match(plan.rejections[0].reason, /No Line ID/);
});

test('an unknown Line ID is refused, never silently skipped', () => {
  const plan = planInvoicePriceImport([row({ lineId: 'invi-ghost', base: 800 })], db(line()));
  assert.equal(plan.changes.length, 0);
  assert.match(plan.rejections[0].reason, /No such line/);
});

test('the same Line ID twice is refused — the file contradicts itself', () => {
  const plan = planInvoicePriceImport(
    [row({ base: 800 }), row({ base: 900 })],
    db(line()),
  );
  assert.equal(plan.changes.length, 0, 'neither wins');
  assert.match(plan.rejections[0].reason, /more than once/);
});

test('a Line ID whose invoice number disagrees with the file is refused', () => {
  const plan = planInvoicePriceImport(
    [row({ invoiceNo: 'INV-9999-999', base: 800 })],
    db(line()),
  );
  assert.match(plan.rejections[0].reason, /Refusing rather than trusting/);
});

test('rows are matched by id, not by position', () => {
  // The operator sorted the sheet. Nothing may depend on row order.
  const a = line({ id: 'invi-a', unitPriceSen: 42500, basePriceSen: 42500, specialOrderPriceSen: 0 });
  const b = line({ id: 'invi-b', unitPriceSen: 83000, basePriceSen: 83000, specialOrderPriceSen: 0 });
  const plan = planInvoicePriceImport(
    [
      row({ lineId: 'invi-b', exportedUnit: 830, base: 900 }),
      row({ lineId: 'invi-a', exportedUnit: 425, base: 500 }),
    ],
    db(a, b),
  );
  assert.equal(plan.changes.length, 2);
  assert.equal(plan.changes.find((c) => c.lineId === 'invi-a').after.base, 50000);
  assert.equal(plan.changes.find((c) => c.lineId === 'invi-b').after.base, 90000);
});

// --- 4. the document must still be editable ------------------------------
test('a paid invoice is refused', () => {
  const plan = planInvoicePriceImport([row({ base: 800 })], db(line({ invoicePaidSen: 5000 })));
  assert.match(plan.rejections[0].reason, /taken a payment/);
});

test('a cancelled or posted invoice is refused', () => {
  const plan = planInvoicePriceImport([row({ base: 800 })], db(line({ invoiceStatus: 'CANCELLED' })));
  assert.match(plan.rejections[0].reason, /Only a DRAFT or an unpaid SENT/);
});

// --- 5. what Excel does to numbers --------------------------------------
test('rmCellToSen survives the shapes Excel produces', () => {
  assert.equal(rmCellToSen(1039.5), 103950);
  assert.equal(rmCellToSen('1039.50'), 103950);
  assert.equal(rmCellToSen('1,039.50'), 103950, 'thousands separator');
  assert.equal(rmCellToSen('RM 480.00'), 48000, 'a currency prefix someone typed');
  assert.equal(rmCellToSen(' 480 '), 48000);
});

test('a non-numeric cell is refused, never coerced to 0', () => {
  // `Number("abc") || 0` is exactly how the day's bug happened. Not here.
  const plan = planInvoicePriceImport([row({ base: 'eight hundred' })], db(line()));
  assert.equal(plan.changes.length, 0);
  assert.match(plan.rejections[0].reason, /not a number/);
});

test('a negative component is refused', () => {
  const plan = planInvoicePriceImport([row({ divan: -55 })], db(line()));
  assert.match(plan.rejections[0].reason, /cannot be below zero/);
});

// --- 6. the plan is complete and honest ---------------------------------
test('good and bad rows in one file: the good are planned, the bad are named', () => {
  const a = line({ id: 'invi-a', unitPriceSen: 42500, basePriceSen: 42500, specialOrderPriceSen: 0 });
  const plan = planInvoicePriceImport(
    [
      row({ lineId: 'invi-a', exportedUnit: 425, base: 500 }),
      row({ lineId: 'invi-ghost', exportedUnit: 100, base: 200 }),
      row({ lineId: 'invi-a2', exportedUnit: 100, base: 200 }),
    ],
    db(a),
  );
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.rejections.length, 2);
  // The row number must point at the spreadsheet row the operator can see.
  assert.equal(plan.rejections[0].row, 3, 'header is row 1, so the 2nd data row is row 3');
});

test('a discount-only edit counts as a change', () => {
  const plan = planInvoicePriceImport([row({ discount: 50 })], db(line()));
  assert.equal(plan.changes.length, 1);
  assert.deepEqual(plan.changes[0].touched, ['discount']);
  assert.equal(plan.changes[0].after.discount, 5000);
  assert.equal(plan.changes[0].after.unit, 95600, 'a discount does not move the unit price');
});

test('typing the value it already has is not a change', () => {
  const plan = planInvoicePriceImport([row({ base: 756, special: 200 })], db(line()));
  assert.equal(plan.changes.length, 0, 'nothing differs, so nothing is written');
  assert.equal(plan.untouched, 1);
});
