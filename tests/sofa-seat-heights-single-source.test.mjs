// ---------------------------------------------------------------------------
// sofa-seat-heights-single-source
//
// Owner 2026-08-21, after adding a size in Maintenance and seeing it appear on
// exactly one screen: 「这些不可以写死啊 应该要根据我的 product maintenance 那边啊」
//
// The list was hardcoded in EIGHT places across seven files, and they did not
// agree with each other — six were missing 26", a live size, so a
// customer-specific price for a 26" seat could not be entered at all and the
// quotation PDF could not print one.
//
// PR #109 (2026-07-27) fixed precisely this, for precisely one screen: "sofa
// seat-price columns follow Maintenance Sizes (dynamic)". The other seven were
// left behind — the repo's own opening line in BUG-CLASSES.md, again.
//
// Two tests: the rule behaves, and NOBODY re-hardcodes the list.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  sofaSeatHeights,
  unusableSofaSizes,
  FALLBACK_SOFA_SEAT_HEIGHTS,
} from '../src/lib/sofa-seat-heights.ts';

// --- the rule ------------------------------------------------------------
test('the list comes from the config, in ascending order', () => {
  assert.deepEqual(
    sofaSeatHeights({ sofaSizes: ['24', '26', '28', '30', '32', '35', '20'] }),
    ['20', '24', '26', '28', '30', '32', '35'],
  );
});

test('inches marks, stray spaces and numbers all normalise', () => {
  assert.deepEqual(sofaSeatHeights({ sofaSizes: ['28"', ' 24 ', 30] }), ['24', '28', '30']);
});

test('duplicates collapse', () => {
  assert.deepEqual(sofaSeatHeights({ sofaSizes: ['24', '24', '24"'] }), ['24']);
});

test('a non-measurement is dropped from the heights', () => {
  // The owner added "DEFAULT" and nothing happened. It is dropped here because
  // the price columns are keyed h<number> — but see the next test: it must be
  // REPORTABLE, not merely swallowed.
  assert.deepEqual(sofaSeatHeights({ sofaSizes: ['24', 'DEFAULT', '28'] }), ['24', '28']);
});

test('and it can be NAMED, so a screen can say what it ignored', () => {
  assert.deepEqual(unusableSofaSizes({ sofaSizes: ['24', 'DEFAULT', '28"', 'N/A'] }), [
    'DEFAULT',
    'N/A',
  ]);
  assert.deepEqual(unusableSofaSizes({ sofaSizes: ['24', '28'] }), []);
});

test('an empty or missing config degrades to the usual set, never to nothing', () => {
  // A screen with no columns reads as "this product has no prices", which is a
  // different and worse lie than showing the usual six.
  for (const cfg of [null, undefined, {}, { sofaSizes: [] }, { sofaSizes: ['DEFAULT'] }]) {
    assert.deepEqual(sofaSeatHeights(cfg), FALLBACK_SOFA_SEAT_HEIGHTS, JSON.stringify(cfg));
  }
});

test('a junk config does not throw', () => {
  assert.deepEqual(sofaSeatHeights({ sofaSizes: 'not-an-array' }), FALLBACK_SOFA_SEAT_HEIGHTS);
});

// --- nobody re-hardcodes it ---------------------------------------------
test('no screen carries its own copy of the seat-height list', () => {
  // The guard with teeth. Eight copies existed; the cost of following the
  // config used to be twenty lines of cache/fetch/subscribe per file, so a
  // literal was always quicker. `useSofaSeatHeights()` makes the right thing
  // the short thing — this keeps it that way.
  const OFFENDERS = [];
  // A literal array of three or more bare seat-height numbers.
  const RE = /\[\s*"(?:20|24|25|26|27|28|30|32|35)"(?:\s*,\s*"(?:20|24|25|26|27|28|30|32|35)"){2,}\s*,?\s*\]/;

  const ALLOWED = new Set([
    // The fallback itself has to be written down somewhere.
    'src/lib/sofa-seat-heights.ts',
    // Historical price tables keyed by seat size — real data, not a UI list.
    'src/api/routes/import-completion/_shared.ts',
  ]);

  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(p)) continue;
      if (ALLOWED.has(p)) continue;
      const src = readFileSync(p, 'utf8');
      // Ignore comments — the history is written down in several of these files
      // and quotes the old literals on purpose.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (RE.test(code)) OFFENDERS.push(p);
    }
  };
  walk('src');

  assert.deepEqual(
    OFFENDERS,
    [],
    'These files hardcode a sofa seat-height list. Use useSofaSeatHeights() ' +
      '(or sofaSeatHeights(cfg) outside React) so a size added in Maintenance ' +
      'appears everywhere at once — which is what the operator expects and what ' +
      'eight separate copies of this list failed to do:',
  );
});
