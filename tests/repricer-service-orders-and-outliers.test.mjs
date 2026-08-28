// ---------------------------------------------------------------------------
// repricer-service-orders-and-outliers
//
// Both caught by READING the dry run before the July/August backfill ran, and
// neither would have raised an error if written.
//
// 1. SERVICE ORDERS. An SV- document is priced at exactly what the operator
//    typed — 0 means 0, a free or goodwill repair. Every write path says so;
//    this repricer had never heard of them. The 2026-08-24 dry run put 33
//    service-order lines in the plan worth +RM 15,674.50, NINETEEN of them
//    currently at RM 0 — 76% of the run's headline total. It would have billed
//    customers for repairs that were given away. (Same trap as the
//    SV-2606-001 RM 730 incident the SO write path still notes.)
//
// 2. ORDER-OF-MAGNITUDE MOVES. SO-2608-234's 5536-CNR was going to be
//    rewritten RM 900 -> RM 8,258. The first version of this guard compared
//    the computed price against the PRICE LIST and did not fire — because the
//    list agreed with 8,258: the master price row effective 2026-07-18 holds
//    825800 sen where its neighbours hold 82500. One digit too many, typed
//    into the price list itself.
//
//    A guard that trusts the list cannot catch a bad list. So it measures
//    against what the ORDER carries today.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/api/routes/import-completion/sofa-pricing.ts', 'utf8');
const SO_ENDPOINT = SRC.slice(
  SRC.indexOf('app.post("/recompute-so-sofa-prices"'),
  SRC.indexOf('app.post("/recompute-co-sofa-prices"'),
);
const GUARD = SO_ENDPOINT.slice(
  SO_ENDPOINT.indexOf('const OUTLIER_MULTIPLE'),
  SO_ENDPOINT.indexOf('const senOf ='),
);

// --- service orders ------------------------------------------------------
test('the query reads isServiceOrder — it cannot filter what it never selected', () => {
  assert.match(SO_ENDPOINT, /companySODate, isServiceOrder, created_at AS createdAt/);
});

test('service orders are dropped, in both truthy shapes', () => {
  // Boolean on Postgres, 1 through the D1 compat layer. Checking one silently
  // keeps half of them.
  assert.match(
    SO_ENDPOINT,
    /so\.isServiceOrder === true \|\| \(so\.isServiceOrder as unknown\) === 1/,
  );
});

test('there is NO flag to include them — it is a rule, not a scope choice', () => {
  // Owner 2026-08-24: 「service order是根据当初开的价格 0就是0 有amount就是有
  // amount」. A repair was quoted at a number, the customer was told that
  // number, and a price-list change months later does not reach back. A switch
  // here would be a way to break that by accident.
  assert.equal(
    /includeServiceOrders/.test(SO_ENDPOINT),
    false,
    'no opt-in may exist for repricing service orders',
  );
  assert.match(SO_ENDPOINT, /0就是0/, 'the rule is quoted where the filter lives');
});

test('and the count is reported, not silently swallowed', () => {
  // "205 lines will change" means something different if 33 were dropped on
  // the way there.
  assert.match(SO_ENDPOINT, /const serviceOrdersExcluded = sos\.filter\(/);
  assert.match(SO_ENDPOINT, /serviceOrdersExcluded,/, 'must ride in appliedScope');
});

// --- order-of-magnitude guard -------------------------------------------
test('the guard measures against the ORDER price, not the price list', () => {
  assert.ok(GUARD.length > 100, 'the guard block must be found');
  assert.match(SO_ENDPOINT, /const OUTLIER_MULTIPLE = 3;/);
  assert.match(GUARD, /p\.newBaseRM \/ p\.oldBaseRM/);
  assert.equal(
    /ratio = p\.newBaseRM \/ p\.listBaseRM/.test(SO_ENDPOINT),
    false,
    'comparing to the list is what let the 8,258 through',
  );
});

test('the skip reason points at the price list, which is where the fault was', () => {
  assert.match(GUARD, /check the price list for this SKU/);
  assert.match(GUARD, /price moved/);
});

test('a zero-priced line is left to the other rules', () => {
  assert.match(GUARD, /if \(!p\.oldBaseRM \|\| !p\.newBaseRM\) continue;/);
});

test('a skipped outlier carries NO new price — it cannot be written by accident', () => {
  for (const field of ['newBaseRM', 'newUnitRM', 'newLineRM']) {
    assert.match(GUARD, new RegExp(`p\\.${field} = null;`), `${field} must be cleared`);
  }
  // willChange requires newLineRM != null, so clearing it removes the row from
  // the WRITE set, not merely from the report.
  assert.match(SO_ENDPOINT, /p\.newLineRM != null/);
});

test('symmetric — a collapse is as suspect as a multiplication', () => {
  assert.match(GUARD, /ratio > OUTLIER_MULTIPLE/);
  assert.match(GUARD, /ratio < 1 \/ OUTLIER_MULTIPLE/);
});

test('the ratio rule itself, executed against the real case', () => {
  const MULT = 3;
  const suspect = (oldRM, newRM) => {
    if (!oldRM || !newRM) return false;
    const r = newRM / oldRM;
    return r > MULT || r < 1 / MULT;
  };
  assert.equal(suspect(900, 8258), true, 'SO-2608-234 5536-CNR — the whole reason');
  assert.equal(suspect(700, 605), false, 'ordinary combo movement survives');
  assert.equal(suspect(550, 495), false);
  assert.equal(suspect(1032.63, 1091), false);
  assert.equal(suspect(900, 300), false, '3x down is the edge, not over it');
  assert.equal(suspect(900, 299), true);
  assert.equal(suspect(0, 1170), false, 'a free line is the service-order rule, not this one');
});
