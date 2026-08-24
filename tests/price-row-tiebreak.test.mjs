// ---------------------------------------------------------------------------
// price-row-tiebreak
//
// Found 2026-08-24, clearing the sofa P3 prices for 2990 and Carress. The
// clear was done by POSTing a corrected price row on the SAME effectiveFrom
// as the row it supersedes — which is the ordinary shape of a same-day
// correction, not something exotic.
//
// That left 60 products with two rows dated 2026-08-24, and the two readers
// of that table disagreed about which one wins:
//
//   resolveCustomerPriceAsOf   ORDER BY effectiveFrom DESC, created_at DESC
//     (customer-products.ts)   → the correction. What the order screens show.
//
//   pickActive                 sort by effectiveFrom only, over a query that
//     (sofa-pricing.ts, ×2)    also ordered by effectiveFrom only
//                              → whichever row Postgres happened to return.
//
// So the repricer could price an order off the SUPERSEDED row while the SO
// screen showed the corrected one, and a re-run could disagree with itself.
// Nothing in the output would say so: both numbers are plausible prices.
//
// This is the same class as the money-path rule the repo already carries —
// two code paths answering one question must read the same way. Here they
// now share `newestFirst`.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/api/routes/import-completion/sofa-pricing.ts', 'utf8');
const CANON = readFileSync('src/api/routes/customer-products.ts', 'utf8');

test('the canonical resolver still breaks the tie on created_at', () => {
  // If this ever stops being true, the comparator below is copying the wrong
  // rule and every assertion in this file is worthless.
  assert.match(
    CANON,
    /ORDER BY effectiveFrom DESC, created_at DESC/,
    'resolveCustomerPriceAsOf is the reference order — sofa-pricing mirrors it',
  );
});

test('both customer-history queries select AND order by created_at', () => {
  const queries = SRC.match(/SELECT cpp\.basePriceSen[\s\S]{0,400}?`/g) ?? [];
  assert.equal(queries.length, 2, 'there are two copies of this query — both must be fixed');
  for (const q of queries) {
    assert.match(q, /cpp\.created_at AS "createdAt"/, 'must SELECT created_at to sort on it');
    assert.match(
      q,
      /ORDER BY cpp\.effectiveFrom DESC, cpp\.created_at DESC/,
      'a same-day correction must beat the row it supersedes',
    );
  }
});

test('neither pickActive sorts on effectiveFrom alone any more', () => {
  assert.equal(
    /\.sort\(\(a, b\) => b\.effectiveFrom\.localeCompare\(a\.effectiveFrom\)\)/.test(SRC),
    false,
    'date-only sort leaves same-day rows in arbitrary order',
  );
  const uses = SRC.match(/\.sort\(newestFirst\)/g) ?? [];
  assert.equal(uses.length, 2, 'both pickActive copies must use the shared comparator');
});

test('the comparator itself: date first, then newest write', () => {
  // Reproduces `newestFirst` from source so the ordering rule is executable
  // rather than merely asserted about.
  const body = SRC.slice(SRC.indexOf('function newestFirst'), SRC.indexOf('const app = new Hono'));
  assert.match(body, /b\.effectiveFrom\.localeCompare\(a\.effectiveFrom\)/);
  assert.match(body, /String\(b\.createdAt \?\? ""\)\.localeCompare\(String\(a\.createdAt \?\? ""\)\)/);

  const newestFirst = (a, b) => {
    const byDate = b.effectiveFrom.localeCompare(a.effectiveFrom);
    if (byDate !== 0) return byDate;
    return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
  };

  // The real case: the morning's row carries P3, the afternoon correction does not.
  const superseded = { effectiveFrom: '2026-08-24', createdAt: '2026-08-24T03:51:17Z', tag: 'with-P3' };
  const correction = { effectiveFrom: '2026-08-24', createdAt: '2026-08-24T08:40:15Z', tag: 'cleared' };
  assert.equal([superseded, correction].sort(newestFirst)[0].tag, 'cleared');
  assert.equal([correction, superseded].sort(newestFirst)[0].tag, 'cleared', 'input order must not matter');

  // A later effective date still outranks a newer write on an earlier date.
  const older = { effectiveFrom: '2026-08-24', createdAt: '2026-08-24T23:59:59Z', tag: 'aug24' };
  const newer = { effectiveFrom: '2026-09-01', createdAt: '2026-08-01T00:00:00Z', tag: 'sep01' };
  assert.equal([older, newer].sort(newestFirst)[0].tag, 'sep01');

  // Master product_prices rows carry no created_at — they must not throw or
  // reorder among themselves.
  const a = { effectiveFrom: '2026-04-01' };
  const b = { effectiveFrom: '2026-04-01' };
  assert.equal([a, b].sort(newestFirst).length, 2);
});
