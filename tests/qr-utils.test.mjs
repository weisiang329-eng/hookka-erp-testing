// ---------------------------------------------------------------------------
// qr-utils.test.mjs — runtime tests for the worker-scan sticker payloads.
//
// Pins the 2026-06-07 fixes that took several real-device rounds to get right:
//   - Fab Sew uses the SHORT compartment form (?po=&c=<subtype>) so the QR is
//     low-density (v5) and the phone camera can lock onto it.
//   - FG-<DEPT> sentinels drop the redundant &dept= (encoded in the op id) so
//     Packing's QR shrinks to v5 too; parse derives the dept back.
//   - Legacy wk= / op=+dept= stickers still parse (printed stickers keep working).
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStickerData,
  generateStickerData,
  generateCompartmentStickerData,
} from '../src/lib/qr-utils.ts';

test('compartment (c=) sticker round-trips: po + compartment + piece', () => {
  const url = generateCompartmentStickerData('SO-2605-305-02', 'DIVAN', '/worker/scan', 1, 2);
  assert.ok(url.includes('?po=') && url.includes('&c=DIVAN'), url);
  assert.ok(!url.includes('&wk='), 'compartment form must NOT carry the long wipKey');
  const p = parseStickerData(url);
  assert.equal(p.poNo, 'SO-2605-305-02');
  assert.equal(p.compartment, 'DIVAN');
  assert.equal(p.pieceNo, 1);
  assert.equal(p.totalPieces, 2);
  assert.equal(p.wipKey, undefined);
  assert.equal(p.opId, undefined);
});

test('two Divan pieces share the compartment but differ by pieceNo', () => {
  const p1 = parseStickerData(generateCompartmentStickerData('SO-X', 'DIVAN', '/worker/scan', 1, 2));
  const p2 = parseStickerData(generateCompartmentStickerData('SO-X', 'DIVAN', '/worker/scan', 2, 2));
  assert.equal(p1.compartment, p2.compartment); // same compartment card
  assert.equal(p1.pieceNo, 1);
  assert.equal(p2.pieceNo, 2); // distinct pieces — must NOT collide
});

test('FG-PACKING sticker drops &dept= but parse derives PACKING', () => {
  const url = generateStickerData('SO-2605-305-02', 'PACKING', 'FG-PACKING', '/worker/scan', 1, 2);
  assert.ok(!url.includes('&dept='), 'FG sentinel must omit redundant &dept= (keeps QR small): ' + url);
  const p = parseStickerData(url);
  assert.equal(p.opId, 'FG-PACKING');
  assert.equal(p.deptCode, 'PACKING'); // derived from the FG- sentinel
  assert.equal(p.poNo, 'SO-2605-305-02');
  assert.equal(p.pieceNo, 1);
});

test('per-JC op= sticker (no FG prefix) keeps &dept=', () => {
  const url = generateStickerData('SO-X', 'PACKING', 'jc-abc-123', '/worker/scan');
  assert.ok(url.includes('&dept=PACKING'), 'non-FG op id keeps dept: ' + url);
  const p = parseStickerData(url);
  assert.equal(p.opId, 'jc-abc-123');
  assert.equal(p.deptCode, 'PACKING');
});

test('OLD FG sticker WITH &dept= still parses (backward compat)', () => {
  const p = parseStickerData('http://localhost:3000/worker/scan?op=FG-FAB_CUT&dept=FAB_CUT&po=SO-X');
  assert.equal(p.opId, 'FG-FAB_CUT');
  assert.equal(p.deptCode, 'FAB_CUT');
});

test('legacy wk= sticker still parses', () => {
  const url =
    'http://localhost:3000/worker/scan?po=SO-X&wk=' +
    encodeURIComponent('1013-(Q)::0::DIVAN::label') +
    '&p=1&t=2';
  const p = parseStickerData(url);
  assert.equal(p.wipKey, '1013-(Q)::0::DIVAN::label');
  assert.equal(p.pieceNo, 1);
  assert.equal(p.compartment, undefined);
});
