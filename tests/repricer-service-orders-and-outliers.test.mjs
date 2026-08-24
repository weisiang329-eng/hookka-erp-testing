// ---------------------------------------------------------------------------
// repricer-service-orders-and-outliers
//
// Both of these were caught by READING THE DRY RUN before running the
// July/August backfill, and neither would have raised an error if written.
//
// 1. SERVICE ORDERS. An SV document is priced at exactly what the operator
//    typed — 0 means 0, a free or goodwill repair. Every write path says so;
//    this repricer had never heard of them. The 2026-08-24 dry run put 33
//    service-order lines in the plan worth +RM 15,674.50, NINETEEN of them
//    currently at RM 0. Running it would have billed customers for repairs
//    that were given away. (Same trap as the SV-2606-001 RM 730 incident the
//    SO write path still carries a note about.)
//
// 2. COMBO RESIDUAL OUTLIERS. The residual exists to make a matched SET total
//    the agreed combo price. On SO-2608-234 it put RM 8,258 on a 5536-CNR —
//    a line whose list price is RM 900 in the master, RM 900 for the customer,
//    with no price history at all. Every source agreed on 900 and the plan
//    still said 8,258. A repricing pass that can multiply one line by nine has
//    to say so rather than write it.
//
// Both are cases of the same thing: the dry run is only worth reading if what
// it cannot justify shows up as a SKIP with a reason, not as a number.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/api/routes/import-completion/sofa-pricing.ts', 'utf8');
const SO_ENDPOINT = SRC.slice(
  SRC.indexOf('app.post("/recompute-so-sofa-prices"'),
  SRC.indexOf('app.post("/recompute-co-sofa-prices"'),
);

// --- service orders ------------------------------------------------------
test('the query reads isServiceOrder — it cannot filter what it never selected', () => {
  assert.match(SO_ENDPOINT, /companySODate, isServiceOrder, created_at AS createdAt/);
});

test('service orders are dropped from the scope, both truthy shapes', () => {
  // The column comes back as a boolean on Postgres and as 1 through the D1
  // compat layer. Checking only one of them silently keeps half of them.
  assert.match(SO_ENDPOINT, /so\.isServiceOrder === true \|\| \(so\.isServiceOrder as unknown\) === 1/);
  assert.match(SO_ENDPOINT, /sos = sos\.filter\(/);
});

test('and the count is reported, not silently swallowed', () => {
  // "205 lines will change" means something different if 33 of them were
  // dropped on the way. The scope says how many.
  assert.match(SO_ENDPOINT, /const serviceOrdersExcluded = sos\.filter\(/);
  assert.match(SO_ENDPOINT, /serviceOrdersExcluded,/, 'must ride in appliedScope');
});

// --- combo residual outliers --------------------------------------------
test('the list price is kept beside the plan so the combo pass cannot hide it', () => {
  assert.match(SO_ENDPOINT, /plan\.listBaseRM = priceSen \/ 100;/);
  assert.match(SO_ENDPOINT, /listBaseRM\?: number \| null;/);
});

test('a line that leaves its list price by more than 3x is skipped, with a reason', () => {
  assert.match(SO_ENDPOINT, /const RESIDUAL_SANITY_MULTIPLE = 3;/);
  assert.match(SO_ENDPOINT, /combo residual outlier/);
  assert.match(SO_ENDPOINT, /needs review/);
});

test('a skipped outlier carries NO new price — it cannot be written by accident', () => {
  const guard = SO_ENDPOINT.slice(
    SO_ENDPOINT.indexOf('const RESIDUAL_SANITY_MULTIPLE'),
    SO_ENDPOINT.indexOf('const senOf ='),
  );
  for (const field of ['newBaseRM', 'newUnitRM', 'newLineRM']) {
    assert.match(guard, new RegExp(`p\\.${field} = null;`), `${field} must be cleared`);
  }
  // willChange requires newLineRM != null, so clearing it is what removes the
  // row from the write set — not merely from the report.
  assert.match(SO_ENDPOINT, /p\.newLineRM != null/);
});

test('the guard is symmetric — a collapse is as suspect as a multiplication', () => {
  const guard = SO_ENDPOINT.slice(
    SO_ENDPOINT.indexOf('const RESIDUAL_SANITY_MULTIPLE'),
    SO_ENDPOINT.indexOf('const senOf ='),
  );
  assert.match(guard, /ratio > RESIDUAL_SANITY_MULTIPLE/);
  assert.match(guard, /ratio < 1 \/ RESIDUAL_SANITY_MULTIPLE/, 'RM 900 -> RM 100 is equally wrong');
});

test('the ratio rule itself, executed', () => {
  const MULT = 3;
  const suspect = (listRM, newRM) => {
    const r = newRM / listRM;
    return r > MULT || r < 1 / MULT;
  };
  // The real case.
  assert.equal(suspect(900, 8258), true, 'the 5536-CNR line');
  // Ordinary combo movement stays.
  assert.equal(suspect(700, 605), false);
  assert.equal(suspect(550, 495), false);
  assert.equal(suspect(1032.63, 1091), false);
  // A genuine large discount is still allowed up to the bound.
  assert.equal(suspect(900, 300), false, '3x down is the edge, not over it');
  assert.equal(suspect(900, 299), true);
});
