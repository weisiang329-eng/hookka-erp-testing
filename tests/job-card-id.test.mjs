// ---------------------------------------------------------------------------
// job-card-id.test.mjs — pins the job_card id / Code 128 token format.
//
// The printed barcode (production schedule), the worker scanner, and all three
// id-generation sites (production-builder x2, jobcard-sync) MUST agree on
// deriveJobCardId. The old-card scan fallback ALSO depends on the token being
// re-derivable + its dept being recoverable from the last 2 chars. Lock it.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveJobCardId,
  deriveBarcodeToken,
  isBarcodeToken,
  deptOfBarcodeToken,
  deptCode2,
  deptFromCode2,
  DEPT_CODE2,
  isShortJobCardToken,
  shortKeyHash,
} from '../src/lib/job-card-id.ts';

const PROD_DEPTS = [
  'FAB_CUT', 'FAB_SEW', 'WOOD_CUT', 'FOAM',
  'FRAMING', 'WEBBING', 'UPHOLSTERY', 'PACKING',
];

test('deriveJobCardId is deterministic — same inputs, same id', () => {
  const a = deriveJobCardId('pord-so-abc12345-01', 'P1::0::DIVAN::WD', 'WOOD_CUT');
  const b = deriveJobCardId('pord-so-abc12345-01', 'P1::0::DIVAN::WD', 'WOOD_CUT');
  assert.equal(a, b);
});

test('format is jc-<14 base36>-<2 digit> for production depts (scannable + short)', () => {
  for (const dept of PROD_DEPTS) {
    const id = deriveJobCardId('pord-so-abc12345-02', 'P1::0::DIVAN::WD', dept);
    assert.match(id, /^jc-[0-9a-z]{14}-\d{2}$/, `${dept} → ${id}`);
    assert.ok(isShortJobCardToken(id), `${dept} token should be recognised`);
    // ~20 chars keeps the Code 128 well under the dense-barcode threshold.
    assert.ok(id.length <= 22, `${id} should stay short (${id.length})`);
  }
});

test('dept code is 2 digits and round-trips via deptFromCode2', () => {
  for (const dept of PROD_DEPTS) {
    const c2 = deptCode2(dept);
    assert.match(c2, /^\d{2}$/, `${dept} → ${c2}`);
    assert.equal(deptFromCode2(c2), dept);
    // The token's trailing 2 chars carry the dept — the scan-lookup fallback
    // parses them to narrow the candidate cards.
    const id = deriveJobCardId('pord-x', 'wip', dept);
    assert.equal(id.slice(-2), c2);
    assert.equal(deptFromCode2(id.slice(-2)), dept);
  }
});

test('every production dept maps to a UNIQUE 2-digit code', () => {
  const codes = PROD_DEPTS.map((d) => DEPT_CODE2[d]);
  assert.equal(new Set(codes).size, codes.length);
});

test('deptFromCode2 returns null for non-codes (so noise is not mistaken for a token)', () => {
  assert.equal(deptFromCode2('99'), null);
  assert.equal(deptFromCode2('ab'), null);
  assert.equal(deptFromCode2(''), null);
});

test('distinct (poId, wipKey, dept) → distinct tokens; FG folds into the hash', () => {
  const base = deriveJobCardId('pord-1', 'WIPA', 'FRAMING');
  assert.notEqual(base, deriveJobCardId('pord-2', 'WIPA', 'FRAMING')); // poId
  assert.notEqual(base, deriveJobCardId('pord-1', 'WIPB', 'FRAMING')); // wipKey
  assert.notEqual(base, deriveJobCardId('pord-1', 'WIPA', 'WEBBING')); // dept
  // FG card: wipKey "FG" is just another key — stable + distinct.
  const fg = deriveJobCardId('pord-1', 'FG', 'PACKING');
  assert.equal(fg, deriveJobCardId('pord-1', 'FG', 'PACKING'));
  assert.match(fg, /^jc-[0-9a-z]{14}-08$/);
});

test('shortKeyHash is 14 base36 chars (fixed width, no drift)', () => {
  assert.match(shortKeyHash('anything::here'), /^[0-9a-z]{14}$/);
  assert.match(shortKeyHash(''), /^[0-9a-z]{14}$/);
});

test('unmapped dept falls through to its own code (id stays unique, not short-pattern)', () => {
  const id = deriveJobCardId('pord-1', 'wip', 'QC_HOLD');
  assert.ok(id.startsWith('jc-'));
  assert.ok(!isShortJobCardToken(id)); // non-2-digit dept → not the scan fast-pattern
});

// ── Numeric barcode token (the printed Code 128, Set C for fat bars) ────────
test('deriveBarcodeToken is <deptNN><8 digits> — 10 digits, deterministic', () => {
  for (const dept of PROD_DEPTS) {
    const t = deriveBarcodeToken('pord-so-abc12345-01', 'P1::0::DIVAN::WD', dept);
    assert.match(t, /^\d{10}$/, `${dept} → ${t}`); // ALL digits → Code 128 Set C
    assert.equal(t.length, 10);
    assert.ok(isBarcodeToken(t));
    // The dept rides in the leading 2 digits and round-trips (scan-lookup scopes by it).
    assert.equal(t.slice(0, 2), deptCode2(dept));
    assert.equal(deptOfBarcodeToken(t), dept);
    // deterministic
    assert.equal(t, deriveBarcodeToken('pord-so-abc12345-01', 'P1::0::DIVAN::WD', dept));
  }
});

test('distinct (poId, wipKey, dept) → distinct barcode tokens', () => {
  const base = deriveBarcodeToken('pord-1', 'WIPA', 'FRAMING');
  assert.notEqual(base, deriveBarcodeToken('pord-2', 'WIPA', 'FRAMING'));
  assert.notEqual(base, deriveBarcodeToken('pord-1', 'WIPB', 'FRAMING'));
  assert.notEqual(base, deriveBarcodeToken('pord-1', 'WIPA', 'WEBBING'));
});

test('isBarcodeToken / deptOfBarcodeToken reject non-tokens (random barcodes)', () => {
  assert.ok(!isBarcodeToken('1299999999'));       // 10 digits but '12' is no dept
  assert.ok(!isBarcodeToken('jc-abc-03'));         // the PK form, not a barcode
  assert.ok(!isBarcodeToken('0112345'));           // too short (not 10 digits)
  assert.ok(!isBarcodeToken('b0112345678'));       // has a letter → not Set C
  assert.equal(deptOfBarcodeToken('9912345678'), null); // 99 isn't a mapped dept
});
