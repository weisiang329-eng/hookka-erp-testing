// ---------------------------------------------------------------------------
// refresh-so-surcharges
//
// Owner 2026-08-24, after being shown that the July/August repricing carried
// each line's stored surcharges rather than re-deriving them: 「要的」.
//
// Measured on prod that day: of 890 lines in scope, 880 carry a surcharge and
// EIGHT disagree with the owner's current lists —
//
//   SO-2608-242  divan 10"                      RM 0   vs  RM 55
//   7 lines      "HB Fully Cover, Divan Full Cover"  RM 100  vs  RM 130
//
// All eight sit on orders the ordinary SO edit refuses (production started, or
// a status past editing). Cancelling six production orders to correct RM 265
// of surcharge is the wrong trade, so this endpoint corrects prices only and
// touches nothing production reads.
//
// The subtlety that makes this endpoint necessary rather than a one-liner:
// `resolveHeightPriceSen` and friends DERIVE only when the field is OMITTED —
// a supplied number is trusted verbatim, including a deliberate 0. That is
// correct for an edit (an operator may zero a surcharge on purpose) and wrong
// for a backfill, whose entire job is to re-derive. So it passes `undefined`
// deliberately, and every line it moves is named in the response.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/api/routes/import-completion/price-backfill.ts', 'utf8');
const HANDLER = SRC.slice(SRC.indexOf('app.post("/refresh-so-surcharges"'));

test('it re-derives — it does not re-trust the stored number', () => {
  // The whole point. Passing the stored value back would be a no-op with extra
  // steps, which is exactly how this would have "shipped" and done nothing.
  const derivations = HANDLER.match(/resolveHeightPriceSen\(\s*\n\s*undefined,/g) ?? [];
  assert.equal(derivations.length, 2, 'divan and leg both derive');
  assert.match(
    HANDLER,
    /resolveTotalHeightPriceSen\(\s*\n\s*undefined,/,
    'total height derives too',
  );
  assert.match(HANDLER, /resolveSpecialOrderPriceSen\(/);
});

test('it uses the CANONICAL build-up for the unit and line totals', () => {
  // Not a hand-rolled sum — that mistake already cost six copies of a dropped
  // total-height term (BUG-2026-08-24-162).
  assert.match(HANDLER, /calculateUnitPrice\(\{/);
  assert.match(HANDLER, /totalHeightPriceSen: totalHeight,/);
  assert.match(HANDLER, /calculateLineTotalWithDiscount\(/);
  assert.equal(
    /unit \* qty/.test(HANDLER),
    false,
    'the discount-aware helper does the line total',
  );
});

test('service orders are excluded, with no flag to include them', () => {
  assert.match(HANDLER, /so\.isServiceOrder === true \|\| so\.isServiceOrder === 1/);
  assert.equal(/includeServiceOrders/.test(SRC), false, 'no opt-in may exist');
  assert.match(SRC, /0就是0/, "the owner's rule is quoted where it is enforced");
});

test('paid orders are excluded by default', () => {
  assert.match(HANDLER, /status IN \('PAID','PARTIAL_PAID'\)/);
  assert.match(HANDLER, /paidOrdersExcluded = beforePaid - sos\.length/);
});

test('cancelled orders never enter the scope', () => {
  assert.match(HANDLER, /status != 'CANCELLED'/);
});

test('dry run is the DEFAULT — writing takes ?dryRun=false', () => {
  // The opposite default to the sofa repricer's `=== "true"`, and deliberately
  // so: this one has no separate plan step to read first.
  assert.match(SRC, /dryRun: c\.req\.query\("dryRun"\) !== "false"/);
});

test('a malformed date is refused, not silently ignored', () => {
  assert.match(SRC, /must be YYYY-MM-DD/);
  assert.match(SRC, /const DATE_RE = \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
});

test('every line it moves is NAMED, field by field', () => {
  // "8 lines changed" is not reviewable; "this line, this field, RM 100 -> 130"
  // is. The response carries both sides and the resulting line total.
  for (const field of ['field', 'oldRM', 'newRM', 'oldLineRM', 'newLineRM', 'product']) {
    assert.match(HANDLER, new RegExp(`${field}[,:]`), `changes must carry ${field}`);
  }
  assert.match(HANDLER, /samplesTruncated: changes\.length > scope\.sampleLimit/);
});

test('the scope that ran is echoed back', () => {
  for (const f of ['from', 'to', 'customerIds', 'serviceOrdersExcluded', 'paidOrdersExcluded', 'soCount']) {
    assert.match(HANDLER, new RegExp(`\\b${f}\\b`), `appliedScope must carry ${f}`);
  }
});

test('order totals are rebuilt from the lines, not patched by a delta', () => {
  assert.match(HANDLER, /SELECT COALESCE\(SUM\(lineTotalSen\), 0\) AS sub/);
  assert.match(HANDLER, /UPDATE sales_orders SET subtotalSen = \?, totalSen = \?/);
});
