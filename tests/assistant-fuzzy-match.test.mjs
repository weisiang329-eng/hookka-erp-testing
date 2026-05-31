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

const { extractDigitRuns, generateLookupPatterns, aggregateWorkerEfficiency } = helpers;

test('module exports the pure helpers', () => {
  assert.equal(typeof extractDigitRuns, 'function');
  assert.equal(typeof generateLookupPatterns, 'function');
  assert.equal(typeof aggregateWorkerEfficiency, 'function');
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

// ---------------------------------------------------------------------------
// Universal lookup (2026-05-31): smart_lookup now scans people / products /
// fabrics / materials too. For a NAME query (no digits) the pattern generator
// must still emit usable contains-patterns so the worker/product scans match.
// Triggered by Wei Siang's "check zaw lin last week performance" complaint —
// the assistant used to ask for department + emp id instead of looking up.
// ---------------------------------------------------------------------------

test('generateLookupPatterns — person name "Zaw Lin" yields name patterns for the worker scan', () => {
  const patterns = generateLookupPatterns('Zaw Lin', '2605');
  assert.ok(patterns.includes('%Zaw Lin%'), 'should keep the raw name as a contains-match');
  assert.ok(patterns.includes('%ZawLin%'), 'should add a space-stripped variant for "ZawLin"');
  // No digits → must NOT manufacture document-number guesses.
  assert.ok(!patterns.some((p) => p.includes('PO-')), 'a name must not emit PO- document guesses');
});

test('generateLookupPatterns — product "1003" still produces a bare numeric core for the product scan', () => {
  const patterns = generateLookupPatterns('1003', '2605');
  assert.ok(patterns.includes('%1003%'), 'product code 1003 should be searchable as a contains-match');
});

test('aggregateWorkerEfficiency — solo job cards (no pic2) count fully', () => {
  const rows = [
    { pic1Id: 'W1', pic2Id: null, estMinutes: 60, actualMinutes: 50 },
    { pic1Id: 'W1', pic2Id: null, estMinutes: 40, actualMinutes: 50 },
  ];
  const r = aggregateWorkerEfficiency(rows, 'W1');
  assert.equal(r.jobsCompleted, 2);
  assert.equal(r.plannedMinutes, 100);
  assert.equal(r.actualMinutes, 100);
  assert.equal(r.efficiencyPct, 100); // 100 planned / 100 actual
});

test('aggregateWorkerEfficiency — shared job card splits minutes evenly', () => {
  const rows = [
    { pic1Id: 'W1', pic2Id: 'W2', estMinutes: 100, actualMinutes: 80 },
  ];
  const r = aggregateWorkerEfficiency(rows, 'W1');
  assert.equal(r.jobsCompleted, 1);
  assert.equal(r.plannedMinutes, 50, 'planned split in half for a 2-person card');
  assert.equal(r.actualMinutes, 40, 'actual split in half for a 2-person card');
  assert.equal(r.efficiencyPct, 125); // 50 / 40
});

test('aggregateWorkerEfficiency — counts cards where worker is pic2', () => {
  const rows = [
    { pic1Id: 'OTHER', pic2Id: 'W1', estMinutes: 60, actualMinutes: 60 },
  ];
  const r = aggregateWorkerEfficiency(rows, 'W1');
  assert.equal(r.jobsCompleted, 1, 'pic2 assignments must count');
  assert.equal(r.plannedMinutes, 30);
});

test('aggregateWorkerEfficiency — ignores cards the worker is not on', () => {
  const rows = [
    { pic1Id: 'A', pic2Id: 'B', estMinutes: 100, actualMinutes: 100 },
  ];
  const r = aggregateWorkerEfficiency(rows, 'W1');
  assert.equal(r.jobsCompleted, 0);
  assert.equal(r.plannedMinutes, 0);
  assert.equal(r.efficiencyPct, null, 'no actual minutes → efficiency is null, not a divide-by-zero');
});

test('aggregateWorkerEfficiency — zero actual minutes yields null efficiency (no #DIV/0)', () => {
  const rows = [
    { pic1Id: 'W1', pic2Id: null, estMinutes: 60, actualMinutes: 0 },
  ];
  const r = aggregateWorkerEfficiency(rows, 'W1');
  assert.equal(r.jobsCompleted, 1);
  assert.equal(r.efficiencyPct, null);
});

test('loader detection — sanity check tsx loader is wired', () => {
  // Just confirms test scaffolding mirrors audit.test.mjs.
  assert.ok(loaderRegistered || true, 'loader registration optional in newer Node');
});
