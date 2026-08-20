// ---------------------------------------------------------------------------
// invoice-price-import-route — the two properties that decide whether an import
// is safe, asserted against the REAL handler with a stub database.
//
//   1. A dry run writes NOTHING. Not "writes little" — nothing. This is the
//      step whose absence let the price editor zero 112 lines on 2026-08-20:
//      it wrote the moment the button was pressed and nobody saw a plan first.
//
//   2. An execute with ANY refused row applies NOTHING. A half-applied import
//      leaves the operator holding a spreadsheet that describes neither the old
//      state nor the new one, with no way to tell which half landed.
//
// Both are about the same thing: an import must never be partly true.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

import invoices from '../src/api/routes/invoices.ts';

/** A line as the JOIN returns it. */
const dbLine = (over = {}) => ({
  id: 'invi-1',
  invoiceId: 'inv-1',
  quantity: 1,
  unitPriceSen: 95600,
  discountSen: 0,
  basePriceSen: 75600,
  divanPriceSen: 0,
  legPriceSen: 0,
  totalHeightPriceSen: 0,
  specialOrderPriceSen: 20000,
  invoiceNo: 'INV-2608-051',
  status: 'SENT',
  paidAmount: 0,
  customerId: 'cust-1',
  ...over,
});

function makeDb(lines) {
  const writes = [];
  const reads = [];
  const db = {
    writes,
    reads,
    prepare(sql) {
      const isWrite = /^\s*(UPDATE|INSERT|DELETE)/i.test(sql);
      return {
        bind(...args) {
          if (isWrite) writes.push({ sql, args });
          else reads.push({ sql, args });
          return this;
        },
        async all() {
          if (/FROM invoice_items ii/i.test(sql)) return { results: lines, success: true };
          return { results: [], success: true };
        },
        async first() {
          if (/COALESCE\(SUM\(totalSen\)/i.test(sql)) return { s: 100000 };
          if (/SELECT invoiceNo, totalSen, customerId/i.test(sql)) {
            return { invoiceNo: 'INV-2608-051', totalSen: 95600, customerId: 'cust-1' };
          }
          return null;
        },
      };
    },
    async batch(stmts) {
      return stmts.map(() => ({ success: true }));
    },
  };
  return db;
}

async function call(db, body, query = '') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('orgId', 'hookka');
    c.set('DB', db);
    // requirePermission reads userRole (stamped by auth-middleware), and
    // SUPER_ADMIN short-circuits before any permission table is loaded.
    c.set('userRole', 'SUPER_ADMIN');
    c.set('userId', 'u1');
    await next();
  });
  app.route('/api/invoices', invoices);
  return app.request(`/api/invoices/import-line-prices${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const goodRow = (over = {}) => ({
  lineId: 'invi-1',
  invoiceNo: 'INV-2608-051',
  exportedUnit: 956,
  base: 800,
  ...over,
});

// --- 1. a dry run writes nothing ----------------------------------------
test('DRY RUN: the plan is returned and not one write is issued', async () => {
  const db = makeDb([dbLine()]);
  const res = await call(db, { rows: [goodRow()] });
  assert.equal(res.status, 200);
  const j = await res.json();

  assert.equal(j.mode, 'dry-run');
  assert.equal(j.willChange, 1);
  assert.equal(j.refused, 0);
  assert.equal(j.changes[0].after.base, 80000);
  assert.equal(j.changes[0].after.special, 20000, 'a blank cell kept its value');

  assert.deepEqual(
    db.writes,
    [],
    'a dry run that writes anything is not a dry run — this is the guarantee ' +
      'whose absence cost 112 lines on 2026-08-20',
  );
});

test('DRY RUN is the default: no query string means no writing', async () => {
  const db = makeDb([dbLine()]);
  await call(db, { rows: [goodRow()] });
  assert.deepEqual(db.writes, []);
});

test('DRY RUN reports the rows that would price a line at nothing', async () => {
  const db = makeDb([dbLine()]);
  const res = await call(db, { rows: [goodRow({ base: 0, special: 0 })] });
  const j = await res.json();
  assert.equal(j.makesFree, 1, 'a line about to become free must be counted separately');
});

// --- 2. execute is all-or-nothing ---------------------------------------
test('EXECUTE refuses the WHOLE file when any row is refused', async () => {
  const db = makeDb([dbLine()]);
  const res = await call(
    db,
    { rows: [goodRow(), goodRow({ lineId: 'invi-ghost' })] },
    '?execute=1',
  );
  assert.equal(res.status, 409);
  const j = await res.json();
  assert.equal(j.success, false);
  assert.match(j.error, /so none were/);
  assert.deepEqual(db.writes, [], 'the good row must NOT have been applied on its own');
});

test('EXECUTE applies a clean file and stamps priceEdited', async () => {
  const db = makeDb([dbLine()]);
  const res = await call(db, { rows: [goodRow()] }, '?execute=1');
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.mode, 'executed');
  assert.equal(j.applied, 1);

  const lineWrite = db.writes.find((w) => /UPDATE invoice_items/i.test(w.sql));
  assert.ok(lineWrite, 'the line must be written');
  assert.match(lineWrite.sql, /priceEdited = 1/);
  assert.equal(lineWrite.args[0], 80000, 'base');
  assert.equal(lineWrite.args[4], 20000, 'special survived the blank cell');
  assert.equal(lineWrite.args[5], 100000, 'unit is the sum');
});

test('EXECUTE re-derives the invoice total from its own lines, not from a delta', async () => {
  // A delta is a second source of truth and drifts. The stub reports the line
  // sum as 100000, so that is what must be written — regardless of arithmetic
  // done on the way in.
  const db = makeDb([dbLine()]);
  await call(db, { rows: [goodRow()] }, '?execute=1');
  const totalWrite = db.writes.find((w) => /UPDATE invoices SET subtotalSen/i.test(w.sql));
  assert.ok(totalWrite);
  assert.equal(totalWrite.args[0], 100000, 'subtotal comes from SUM(totalSen)');
});

test('EXECUTE moves the customer outstanding by the gross difference', async () => {
  const db = makeDb([dbLine()]);
  await call(db, { rows: [goodRow()] }, '?execute=1');
  const cust = db.writes.find((w) => /UPDATE customers SET outstandingSen/i.test(w.sql));
  assert.ok(cust, 'the receivable must move with the invoice');
  assert.equal(cust.args[0], 100000 - 95600);
});

// --- 3. the body is not trusted -----------------------------------------
test('a body that is not { rows: [] } is refused', async () => {
  for (const body of [{}, { rows: 'nope' }, { rows: [] }]) {
    const res = await call(makeDb([dbLine()]), body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('an absurdly large file is refused before any query runs', async () => {
  const db = makeDb([dbLine()]);
  const rows = Array.from({ length: 5001 }, () => goodRow());
  const res = await call(db, { rows });
  assert.equal(res.status, 400);
  assert.deepEqual(db.reads, [], 'it must not even load lines for a file this size');
});
