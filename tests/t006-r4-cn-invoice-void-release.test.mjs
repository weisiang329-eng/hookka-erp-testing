// T-006 R4 — voiding a CN-sourced invoice never released the consignment
// note: convert-to-invoice flips consignment_notes.status to FULLY_SOLD and
// links convertedInvoiceId, but the invoice void handler only ever called
// buildInvoiceDeathReleaseStatements, which is DO-shaped and bails out
// (`if (!doId) return statements`) for a CN-sourced invoice (deliveryOrderId
// is always null on that path). The CN sat at FULLY_SOLD forever, unable to
// convert again.
//
// Fix: record the CN's pre-conversion status (no single fixed value — a CN
// can convert from ACTIVE, PARTIALLY_SOLD, or IN_TRANSIT) in a new
// status_before_conversion column at convert time, and release it via a
// second builder the void handler also calls.
// Source-static — no live D1 in CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SHARED = readFileSync('src/api/lib/consignment-note-shared.ts', 'utf8');
const CN_ROUTE = readFileSync('src/api/routes/consignment-notes.ts', 'utf8');
const INVOICES = readFileSync('src/api/routes/invoices.ts', 'utf8');

test('the status-before-conversion column is self-applied, not assumed', () => {
  assert.match(
    SHARED,
    /ADD COLUMN IF NOT EXISTS status_before_conversion TEXT/,
  );
});

test('convert-to-invoice records the CN status it is about to overwrite', () => {
  const idx = CN_ROUTE.indexOf("SET status = 'FULLY_SOLD'");
  assert.ok(idx !== -1, 'the FULLY_SOLD flip must still exist');
  const block = CN_ROUTE.slice(idx, idx + 300);
  assert.match(block, /status_before_conversion = \?/);
  assert.match(CN_ROUTE, /\.bind\(cn\.status \?\? "ACTIVE", now, invoiceId, id\)/);
});

test('the release builder looks the CN up by convertedInvoiceId, not the other way', () => {
  const fn = SHARED.slice(
    SHARED.indexOf('export async function buildInvoiceDeathCnReleaseStatements'),
  );
  assert.match(
    fn,
    /SELECT id, status_before_conversion FROM consignment_notes WHERE convertedInvoiceId = \?/,
  );
  // No CN found (the common case, e.g. a DO-sourced invoice) must no-op.
  assert.match(fn, /if \(!cn\) return \[\];/);
});

test('the release restores status and clears both linkage columns', () => {
  const fn = SHARED.slice(
    SHARED.indexOf('export async function buildInvoiceDeathCnReleaseStatements'),
  );
  assert.match(fn, /SET status = \?,\s*\n\s*status_before_conversion = NULL,\s*\n\s*convertedInvoiceId = NULL/);
  assert.match(fn, /\.bind\(cn\.status_before_conversion \?\? "PARTIALLY_SOLD", cn\.id\)/);
});

test('the void handler calls the CN release inside the void branch, alongside the DO release', () => {
  const voidBranchStart = INVOICES.indexOf('else if (isVoidTransition && afterSnapshot)');
  assert.ok(voidBranchStart !== -1, 'the void transition branch must exist');
  const doReleaseIdx = INVOICES.indexOf('buildInvoiceDeathReleaseStatements(c.var.DB', voidBranchStart);
  const cnReleaseIdx = INVOICES.indexOf('buildInvoiceDeathCnReleaseStatements(c.var.DB', voidBranchStart);
  assert.ok(doReleaseIdx > voidBranchStart, 'DO release must be inside the void branch');
  assert.ok(cnReleaseIdx > doReleaseIdx, 'CN release must run after the DO release, still inside the void branch');
});

test('the CN release statements land in the SAME batch as the void, not a separate one', () => {
  const cnReleaseIdx = INVOICES.indexOf('buildInvoiceDeathCnReleaseStatements(c.var.DB');
  const batchIdx = INVOICES.indexOf('await c.var.DB.batch(statements)', cnReleaseIdx);
  assert.ok(batchIdx !== -1 && batchIdx > cnReleaseIdx, 'must push into `statements` before the single batch executes');
});
