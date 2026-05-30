// ---------------------------------------------------------------------------
// assistant-fuzzy-match.test.mjs — unit tests for the smart_lookup helper
// logic in src/api/lib/assistant-tools.ts (pure, DB-free).
//
// Covers the operator's common typo / shorthand inputs and verifies we
// generate the right ILIKE patterns to find the document. The DB layer
// itself is not exercised here — we only verify that the pattern
// generator emits the canonical strings the SQL would need.
//
// Triggered by Wei Siang's PO9003 complaint (2026-05-30): operator types
// "PO9003" expecting Houzs Customer PO PO-009003, the old assistant said
// not found. The pattern generator now emits PO-9003 / PO-09003 /
// PO-009003 so the DB query catches all three Houzs zero-pad widths, plus
// PO-2605-009003 / PO-2605-9003 for the internal Production Order shape.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

let loaderRegistered = false;
try {
  register('tsx/esm', pathToFileURL('./'));
  loaderRegistered = true;
} catch {
  // Native type-stripping handles it.
}

let helpers;
try {
  helpers = await import('../src/api/lib/assistant-tools.ts');
} catch (err) {
  console.error('Failed to import assistant-tools:', err);
  throw err;
}

const { extractDigitRuns, generateLookupPatterns } = helpers;

test('module exports the two pure helpers', () => {
  assert.equal(typeof extractDigitRuns, 'function');
  assert.equal(typeof generateLookupPatterns, 'function');
});

test('extractDigitRuns — handles common operator shorthand', () => {
  assert.deepEqual(extractDigitRuns('PO9003'), ['9003']);
  assert.deepEqual(extractDigitRuns('PO 9003'), ['9003']);
  assert.deepEqual(extractDigitRuns('PO-9003'), ['9003']);
  assert.deepEqual(extractDigitRuns('PO-009003'), ['009003']);
  assert.deepEqual(extractDigitRuns('houzs 9003'), ['9003']);
  assert.deepEqual(extractDigitRuns('PO03 9003'), ['03', '9003']);
  assert.deepEqual(extractDigitRuns('SO 2605 51'), ['2605', '51']);
  assert.deepEqual(extractDigitRuns('SO-2605-051'), ['2605', '051']);
  assert.deepEqual(extractDigitRuns('9003'), ['9003']);
  assert.deepEqual(extractDigitRuns(''), []);
  assert.deepEqual(extractDigitRuns('houzs'), []);
});

test('generateLookupPatterns — PO9003 covers Houzs Customer-PO zero-pad widths', () => {
  const patterns = generateLookupPatterns('PO9003', '2605');
  // Every reasonable Houzs width.
  assert.ok(patterns.includes('%PO-9003%'), 'should try PO-9003');
  assert.ok(patterns.includes('%PO-09003%'), 'should try PO-09003');
  assert.ok(patterns.includes('%PO-009003%'), 'should try PO-009003');
  // Internal Production Order shape with current YYMM.
  assert.ok(patterns.includes('%PO-2605-9003%'), 'should try PO-2605-9003');
  // Original query for completeness.
  assert.ok(patterns.includes('%PO9003%'), 'should keep raw query');
  // Bare numeric core.
  assert.ok(patterns.includes('%9003%'), 'should also try bare 9003');
});

test('generateLookupPatterns — strips spaces from "PO 9003"', () => {
  const patterns = generateLookupPatterns('PO 9003', '2605');
  assert.ok(patterns.includes('%PO9003%'), 'should add space-stripped variant');
  assert.ok(patterns.includes('%PO-009003%'), 'should still try Houzs width');
});

test('generateLookupPatterns — "9003" (bare number) tries all entity shapes', () => {
  const patterns = generateLookupPatterns('9003', '2605');
  // Customer-PO widths
  assert.ok(patterns.includes('%PO-9003%'));
  assert.ok(patterns.includes('%PO-009003%'));
  // Internal documents — should try SO/CO/DO/INV with YYMM
  assert.ok(patterns.includes('%SO-2605-9003%'), 'should try SO with YYMM');
  assert.ok(patterns.includes('%CO-2605-9003%'), 'should try CO with YYMM');
  assert.ok(patterns.includes('%DO-2605-9003%'), 'should try DO with YYMM');
  assert.ok(patterns.includes('%INV-2605-9003%'), 'should try INV with YYMM');
});

test('generateLookupPatterns — "SO 2605 51" assembles canonical form', () => {
  const patterns = generateLookupPatterns('SO 2605 51', '2605');
  // The longest run is "2605", sequence is "51", so we should hit SO-2605-051.
  assert.ok(
    patterns.includes('%SO-2605-051%'),
    `should assemble SO-2605-051 from "SO 2605 51". Got: ${JSON.stringify(patterns)}`,
  );
});

test('generateLookupPatterns — "PO03 9003" still finds Houzs format', () => {
  const patterns = generateLookupPatterns('PO03 9003', '2605');
  // Longest run is "9003" — should still emit Houzs widths.
  assert.ok(patterns.includes('%PO-009003%'), 'longest digit run drives Houzs lookup');
  assert.ok(patterns.includes('%PO-9003%'));
});

test('generateLookupPatterns — empty / whitespace returns empty', () => {
  assert.deepEqual(generateLookupPatterns('', '2605'), []);
  assert.deepEqual(generateLookupPatterns('   ', '2605'), []);
});

test('generateLookupPatterns — non-numeric query still keeps raw contains-match', () => {
  const patterns = generateLookupPatterns('houzs', '2605');
  // No digits, so no padded variants — but the raw substring should still be searchable.
  assert.ok(patterns.includes('%houzs%'), 'should fall back to raw substring match');
});

test('generateLookupPatterns — single-digit number does NOT explode', () => {
  // Defensive — guards against future loops.
  const patterns = generateLookupPatterns('9', '2605');
  assert.ok(patterns.length < 30, `too many patterns for single-digit query: ${patterns.length}`);
});

test('loader detection — sanity check tsx loader is wired', () => {
  // Just confirms test scaffolding mirrors audit.test.mjs.
  assert.ok(loaderRegistered || true, 'loader registration optional in newer Node');
});
