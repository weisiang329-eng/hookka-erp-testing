// ---------------------------------------------------------------------------
// invoice-price-edit-no-implicit-zero.test.mjs — BUG-2026-08-20-158.
//
// WHAT HAPPENED
// The invoice price editor wrote RM 0 into lines the operator never touched.
// Measured on prod 2026-08-20: 17 SENT invoices, 112 lines, three of them
// reduced to a RM 0 total. Every zeroed line carried priceEdited = 1, and only
// one code path writes that column — so the client really did send them.
//
// WHY
// The invoice detail is served stale-while-revalidate from localStorage, so
// `invoice.items` can GAIN rows after the price editor opened and seeded
// itself. Such a row has neither draft nor seed, and BOTH fallbacks pointed the
// wrong way:
//
//     const now = priceDraft[id] || ZERO;   // no draft -> the value is ZERO
//     if (!was) return true;                // no seed  -> "the operator edited it"
//
// Read together: "the operator set this line to zero. Write it." Two
// independent absences combined into a confident, wrong, money-changing claim.
//
// And the screen hid it — a row with no draft falls back to displaying the
// STORED price, so the editor looked completely normal right up to Save.
//
// This file pins the rule at BOTH layers: the client must not send such a line,
// and the server must not accept one even if some other client does.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPriceEditPayload,
  isLineEdited,
} from '../src/lib/invoice-price-edit-payload.ts';

const comp = (base, divan = '0', leg = '0', special = '0', totalHeight = '0') => ({
  base,
  divan,
  leg,
  special,
  totalHeight,
});

// The exact shape that caused the loss: the editor seeded 2 rows, the invoice
// then revalidated to 3, and the operator typed into one of the seeded ones.
const staleSeededEditor = () => ({
  items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  priceDraft: { a: comp('1039.50'), b: comp('800.00') },
  priceSeed: { a: comp('1039.50'), b: comp('800.00') },
  discountDraft: { a: 0, b: 0 },
  discountSeed: { a: 0, b: 0 },
});

// --- 1. THE BUG: a line the editor never held must not be written ---------
test('a line that appeared after the editor opened is NOT written', () => {
  const inp = staleSeededEditor();
  inp.priceDraft.a = comp('1100.00'); // operator edits line a
  const payload = buildPriceEditPayload(inp);

  assert.deepEqual(
    payload.map((p) => p.id),
    ['a'],
    'only the edited line may be sent — line c has no draft and is unknown',
  );
  assert.equal(
    payload.find((p) => p.id === 'c'),
    undefined,
    'line c must not appear in the payload at ANY value, least of all zero',
  );
});

// --- 2. the same, stated as the predicate -------------------------------
test('isLineEdited: no draft is UNKNOWN, never "edited to zero"', () => {
  const inp = staleSeededEditor();
  assert.equal(isLineEdited('c', inp), false, 'no draft, no seed → not edited');
  assert.equal(isLineEdited('a', inp), false, 'draft equals seed → not edited');
});

// --- 3. an untouched invoice writes NOTHING ------------------------------
test('opening the editor and saving without typing writes nothing at all', () => {
  // The 11-of-11 case: INV-2608-031 went to RM 0 on a save where the operator
  // had typed into no line at all.
  const inp = staleSeededEditor();
  assert.deepEqual(buildPriceEditPayload(inp), []);
});

// --- 4. a real edit still goes through ----------------------------------
test('a genuinely edited line is sent, with components in sen', () => {
  const inp = staleSeededEditor();
  inp.priceDraft.b = comp('900.00', '50.00', '25.50');
  const payload = buildPriceEditPayload(inp);
  assert.equal(payload.length, 1);
  assert.deepEqual(payload[0], {
    id: 'b',
    baseSen: 90000,
    divanSen: 5000,
    legSen: 2550,
    specialSen: 0,
    totalHeightSen: 0,
    discountSen: 0,
    allowZero: false,
  });
});

// --- 5. typing into a line that had no seed IS an edit -------------------
test('a line with a draft but no seed is a real edit, not a skip', () => {
  // The mirror of the bug: over-correcting to "no seed → never write" would
  // silently drop a value the operator actually typed.
  const inp = staleSeededEditor();
  inp.priceDraft.c = comp('250.00');
  const payload = buildPriceEditPayload(inp);
  assert.deepEqual(payload.map((p) => p.id), ['c']);
  assert.equal(payload[0].baseSen, 25000);
});

// --- 6. a DELIBERATE zero is distinguishable from an unknown -------------
test('an intentional free line is flagged allowZero, an absent line is absent', () => {
  const inp = staleSeededEditor();
  inp.priceDraft.b = comp('0'); // operator cleared every component on purpose
  const payload = buildPriceEditPayload(inp);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].id, 'b');
  assert.equal(
    payload[0].allowZero,
    true,
    'the server needs this to tell "meant zero" from "did not know"',
  );
});

// --- 7. a discount-only change still counts ------------------------------
test('changing only the discount marks the line edited', () => {
  const inp = staleSeededEditor();
  inp.discountDraft.a = 500;
  const payload = buildPriceEditPayload(inp);
  assert.deepEqual(payload.map((p) => p.id), ['a']);
  assert.equal(payload[0].discountSen, 500);
});

// --- 8. the server refuses an implicit zero even from a bad client -------
test('the backend refuses to zero a charged line without allowZero', async () => {
  // Defense in depth: the client rule above is the fix, this is the net. The
  // guard lives in the priceEdits branch of PUT /api/invoices/:id.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/api/routes/invoices.ts', 'utf8');

  assert.match(
    src,
    /if \(unit === 0 && !ed\.allowZero && \(Number\(r\.unitPriceSen\) \|\| 0\) > 0\)/,
    'the server must refuse an edit that prices a charged line at RM 0 implicitly',
  );
  assert.match(
    src,
    /allowZero: e\.allowZero === true/,
    'the flag must be read from the payload, not defaulted to true',
  );
  // It must REFUSE, not silently skip: a partial write leaves the invoice
  // half-repriced with no record of which half.
  const guardAt = src.search(/if \(unit === 0 && !ed\.allowZero/);
  const after = src.slice(guardAt, guardAt + 900);
  assert.match(after, /return c\.json\(/, 'the guard must reject the request');
  assert.match(after, /409/, 'and say so with a conflict status');
});
