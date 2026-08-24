// ---------------------------------------------------------------------------
// invoice-backfill-from-so
//
// The last write the July/August repricing needed: 52 invoices, +RM 58,960.50,
// of which 90 lines are the BUG-2026-08-20-158 damage — editing one line's
// price wrote RM 0 into every line the operator had not typed into, and those
// goods were delivered and were never free.
//
// ## Why it self-calls instead of writing the ledger itself
//
// Restating a SENT invoice means reversing its GL posting and re-posting the
// new one on the same hash chain, then collapsing the original legs — ~200
// lines inside the invoice PUT. Copying that here was the obvious move and the
// wrong one. In this session alone, copying produced:
//
//   · one dropped surcharge term living in SIX hand-written copies
//   · a tokenizer written twice that disagreed with itself on the separator
//
// On the GL, a seventh copy is the last thing this repo needs. So the endpoint
// builds the payload and calls `PUT /api/invoices/:id` — the endpoint the Edit
// button already uses — which is also the owner's instruction taken literally:
// 「记得要用 edit 的功能走正常普通流程」.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/api/routes/import-completion/price-backfill.ts', 'utf8');
const H = SRC.slice(SRC.indexOf('app.post("/backfill-invoice-prices-from-so"'));

// --- reuse, not copy -----------------------------------------------------
test('it calls the invoice edit endpoint rather than restating the GL itself', () => {
  assert.match(H, /fetch\(`\$\{origin\}\/api\/invoices\/\$\{p\.id\}`/);
  assert.match(H, /method: "PUT"/);
  assert.match(H, /priceEdits:/);
});

test('no ledger writing lives in this file', () => {
  // The moment any of these appear here, the copy has begun.
  for (const forbidden of [
    'buildInvoiceLedgerLegs',
    'buildJournalEntryStatements',
    'ledger_journal_entries',
    'invoice_restate',
  ]) {
    assert.equal(
      SRC.includes(forbidden),
      false,
      `${forbidden} must stay in invoices.ts — this endpoint calls it, never repeats it`,
    );
  }
});

test('the caller’s own session carries the self-call', () => {
  // No shared secret, no elevated path: whoever may edit the invoice by hand
  // is exactly who may run the backfill.
  assert.match(H, /const cookie = c\.req\.header\("cookie"\)/);
  assert.match(H, /const csrf = c\.req\.header\("x-csrf-token"\)/);
  assert.match(H, /cookie,\s*\n\s*"x-csrf-token": csrf,/);
});

// --- which lines move ----------------------------------------------------
test('a hand-set price is left alone; a hand-set ZERO is not', () => {
  // The whole distinction. priceEdited=1 normally means "a person decided
  // this" — except where the bug wrote the 0, which was nobody's decision.
  assert.match(H, /const zero = \(Number\(li\.unitPriceSen\) \|\| 0\) === 0;/);
  assert.match(H, /const handSet = Number\(li\.priceEdited\) === 1;/);
  assert.match(H, /if \(handSet && !zero\) \{\s*\n\s*leftAloneHandSet\+\+;/);
});

test('allowZero stays false — nothing here is a deliberate zero', () => {
  assert.match(H, /allowZero: false,/);
});

// --- identity, not guesswork --------------------------------------------
test('a contested sales-order line is refused, never averaged or picked', () => {
  assert.match(H, /const uniq = new Set\(arr\.map\(sig\)\);/);
  assert.match(H, /return uniq\.size === 1 \? arr\[0\] : null;/);
  assert.match(H, /sales-order line missing or contested/);
});

test('the full key is tried before the looser one', () => {
  const order = H.indexOf('settle(full.get(');
  const loose = H.indexOf('settle(byCode.get(');
  assert.ok(order > 0 && loose > order, 'salesOrder|code|size|fabric must win first');
});

test('lines match the delivery order by nth occurrence, not by position', () => {
  // A position match silently mispriced whole invoices when the two documents
  // listed the same goods in a different order.
  assert.match(H, /const n = used\.get\(code\) \?\? 0;/);
  assert.match(H, /used\.set\(code, n \+ 1\);/);
  assert.match(H, /\(pool\.get\(code\) \?\? \[\]\)\[n\]/);
});

test('every line it declines is named, with a reason', () => {
  for (const why of [
    'no matching delivery line',
    'delivery line has no production order',
    'sales-order line missing or contested',
  ]) {
    assert.ok(H.includes(why), `must report: ${why}`);
  }
  assert.match(H, /unresolvedLines: unresolved\.length/);
});

// --- scope and safety ----------------------------------------------------
test('only DRAFT and unpaid SENT invoices are in scope', () => {
  assert.match(H, /status IN \('SENT','DRAFT'\)/);
  // PAID / PARTIAL_PAID cannot appear, so a settled document is untouchable
  // by construction rather than by a filter someone can forget.
  assert.equal(/'PAID'/.test(H), false);
});

test('dry run is the default, and the batch is bounded and reported', () => {
  assert.match(SRC, /dryRun: c\.req\.query\("dryRun"\) !== "false"/);
  assert.match(H, /const limit = Math\.min\(200, Math\.max\(1, Number\(c\.req\.query\("limit"\)\) \|\| 25\)\)/);
  assert.match(H, /remaining: Math\.max\(0, plan\.length - applied\.length\)/);
  assert.match(H, /failed: applied\.filter\(\(a\) => !a\.ok\)/, 'failures are returned, not counted away');
});

test('re-running is the resume strategy, and it says so', () => {
  assert.match(H, /Idempotent/);
  assert.match(H, /RE-RUN rather than resumed from a cursor/);
});

test('the plan is built in a bounded number of queries, not two per invoice', () => {
  // The first version ran 2 x 167 = 334 sequential round-trips inside one
  // request and the worker died — a 500 with no message, which reads like a
  // logic bug rather than what it was: too many trips.
  assert.match(H, /WHERE deliveryOrderId IN \(\$\{doIds\.map/);
  assert.match(H, /WHERE invoiceId IN \(\$\{invIds\.map/);
  assert.equal(
    /WHERE deliveryOrderId = \?/.test(H),
    false,
    'no per-invoice delivery-line query may return',
  );
  assert.equal(
    /WHERE invoiceId = \?/.test(H),
    false,
    'no per-invoice line query may return',
  );
  // And the loop reads from the maps, not from the database.
  assert.match(H, /const doItems = doByOrder\.get\(inv\.deliveryOrderId\) \?\? \[\];/);
  assert.match(H, /const liItems = liByInvoice\.get\(inv\.id\) \?\? \[\];/);
});
