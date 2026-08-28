// ---------------------------------------------------------------------------
// repricer-scope-filters
//
// `/recompute-so-sofa-prices` had exactly one knob: status. Aimed at "July and
// August" it would have rewritten every order in the book — 1,231 orders on
// prod 2026-08-24, against the ~500 the owner had actually decided on.
//
// Three filters, and one rule about all of them: the scope that RAN is echoed
// back in the response. A scope you have to reconstruct from the request you
// think you sent is a scope nobody can audit afterwards.
//
// The paid exclusion is the owner's ruling, not a default someone guessed:
// 「把还没paid的都补」— an order whose invoice is already settled is money the
// customer has paid against a document they hold, so repricing it makes the
// invoice disagree with the payment. It takes an explicit ?includePaid=true.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/api/routes/import-completion/sofa-pricing.ts', 'utf8');
const SO_ENDPOINT = SRC.slice(
  SRC.indexOf('app.post("/recompute-so-sofa-prices"'),
  SRC.indexOf('app.post("/recompute-co-sofa-prices"'),
);

test('the date window filters on the order’s OWN date', () => {
  // The same value the pricing resolves as of — anything else would filter one
  // set of orders and price them as another.
  assert.match(SO_ENDPOINT, /const soDateOf = \(so: SoRow\) =>/);
  assert.match(SO_ENDPOINT, /so\.companySODate \|\| so\.createdAt/);
  assert.match(SO_ENDPOINT, /sos = sos\.filter\(\(so\) => soDateOf\(so\) >= fromDate\)/);
  assert.match(SO_ENDPOINT, /sos = sos\.filter\(\(so\) => soDateOf\(so\) <= toDate\)/);
});

test('a malformed date is refused, not silently ignored', () => {
  // Ignoring ?from=2026-7-1 would run against the whole book while the caller
  // believed it was scoped to July.
  assert.match(SO_ENDPOINT, /must be YYYY-MM-DD/);
  assert.match(SO_ENDPOINT, /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/);
  assert.match(SO_ENDPOINT, /400\)/);
});

test('customer scoping is opt-in and exact', () => {
  assert.match(SO_ENDPOINT, /c\.req\.query\("customerIds"\)/);
  assert.match(SO_ENDPOINT, /const want = new Set\(customerIds\)/);
  assert.match(
    SO_ENDPOINT,
    /if \(customerIds\.length > 0\)/,
    'no customerIds means every customer — the filter must not silently empty the scope',
  );
});

test('a PAID or part-paid order is excluded by default', () => {
  assert.match(SO_ENDPOINT, /const includePaid = c\.req\.query\("includePaid"\) === "true"/);
  assert.match(SO_ENDPOINT, /status IN \('PAID','PARTIAL_PAID'\)/);
  assert.match(SO_ENDPOINT, /if \(!includePaid && sos\.length > 0\)/, 'excluded unless asked for');
  assert.match(SO_ENDPOINT, /paidExcluded = before - sos\.length/, 'and the count is kept');
});

test('the scope that RAN is reported back, on every response', () => {
  // Including the empty-scope early return: "0 orders" and "0 orders matching
  // a filter you did not mean" look identical without it.
  const echoes = SO_ENDPOINT.match(/appliedScope/g) ?? [];
  assert.ok(echoes.length >= 4, `expected the scope object plus 3 responses, saw ${echoes.length}`);
  const scopeObj = SO_ENDPOINT.slice(
    SO_ENDPOINT.indexOf('const appliedScope = {'),
    SO_ENDPOINT.indexOf('};', SO_ENDPOINT.indexOf('const appliedScope = {')),
  );
  // `includePaid` is shorthand in the literal — match the key, not a colon.
  for (const field of ['statuses', 'from', 'to', 'customerIds', 'includePaid', 'paidOrdersExcluded']) {
    assert.match(scopeObj, new RegExp(`\\b${field}\\b`), `appliedScope must carry ${field}`);
  }
});

test('filters narrow the set — they never widen it past the status scope', () => {
  // Each filter is applied to `sos` after the status query, so no filter can
  // reintroduce an order the status scope excluded.
  const idx = {
    query: SO_ENDPOINT.indexOf('WHERE status IN (${soPlaceholders})'),
    from: SO_ENDPOINT.indexOf('soDateOf(so) >= fromDate'),
    cust: SO_ENDPOINT.indexOf('want.has(so.customerId)'),
    paid: SO_ENDPOINT.indexOf('!paid.has(so.id)'),
  };
  assert.ok(idx.query > 0 && idx.from > idx.query, 'date filter applies after the status query');
  assert.ok(idx.cust > idx.query, 'customer filter applies after the status query');
  assert.ok(idx.paid > idx.query, 'paid filter applies after the status query');
});
