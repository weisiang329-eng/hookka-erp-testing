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
  parseJobCardBarcode,
  jobCardBarcodeValue,
  JC_BARCODE_PREFIX,
} from '../src/lib/qr-utils.ts';
import QRCode from 'qrcode';

// --- QR density guard -------------------------------------------------------
// "扫了没反应" (scan, no reaction) was a QR-too-dense problem. The phone camera
// reads QR version <=5 (37x37) reliably; v6+ is where it fails to lock on. We
// measure the ACTUAL generated QR here so any future change that re-bloats the
// sticker fails in CI, before it ever reaches a printed sticker on the floor.
//
// The QR encodes the FULL url incl. origin, so density depends on the domain
// the office PRINTS from: erp.hookka.com (the real production domain) keeps the
// worst-case sticker at v5; the longer *.pages.dev preview URL tips it to v6.
// => stickers must be printed from erp.hookka.com, and the payload must not grow.
const PROD_ORIGIN = 'https://erp.hookka.com';
const onProd = (localUrl) => localUrl.replace('http://localhost:3000', PROD_ORIGIN);
const qrVersion = (text) => QRCode.create(text, { errorCorrectionLevel: 'M' }).version;
// Worst realistic case: longest compartment label (HEADBOARD / SOFA_BASE) + 2 pieces.
const WORST_PO = 'SO-2605-305-02';

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

test('FG-PACKING sticker carries pn= (box piece label) for direct compartment targeting', () => {
  const p = parseStickerData(
    'http://localhost:3000/worker/scan?op=FG-PACKING&po=SO-2605-305-02&p=1&t=2&pn=' +
      encodeURIComponent('Divan'),
  );
  assert.equal(p.opId, 'FG-PACKING');
  assert.equal(p.deptCode, 'PACKING');
  // pieceLabel lets the scanner pick the Divan packing card directly instead of
  // prompting "which piece" on a bedframe (Divan + Headboard share one PO).
  assert.equal(p.pieceLabel, 'Divan');
});

test('older FG-PACKING sticker WITHOUT pn still parses (backward compat)', () => {
  const p = parseStickerData('http://localhost:3000/worker/scan?op=FG-PACKING&po=SO-X&p=1&t=2');
  assert.equal(p.opId, 'FG-PACKING');
  assert.equal(p.pieceLabel, undefined);
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

test('Fab Sew compartment sticker stays phone-scannable (QR <= v5)', () => {
  const url = onProd(generateCompartmentStickerData(WORST_PO, 'HEADBOARD', '/worker/scan', 2, 2));
  const v = qrVersion(url);
  assert.ok(v <= 5, `compartment sticker QR is v${v} (must stay <=5 to scan reliably): ${url}`);
});

test('Packing FG sticker stays phone-scannable (QR <= v5)', () => {
  const url = onProd(generateStickerData(WORST_PO, 'PACKING', 'FG-PACKING', '/worker/scan', 2, 2));
  const v = qrVersion(url);
  assert.ok(v <= 5, `packing sticker QR is v${v} (must stay <=5 to scan reliably): ${url}`);
});

// --- Code 128 WIP barcode (the linear-scan twin of the QR) ------------------
test('jobCardBarcodeValue round-trips through parseJobCardBarcode', () => {
  const v = jobCardBarcodeValue('jc-abc-123');
  assert.equal(v, `${JC_BARCODE_PREFIX}jc-abc-123`);
  assert.equal(parseJobCardBarcode(v), 'jc-abc-123');
});

test('parseJobCardBarcode tolerates surrounding whitespace from the scanner', () => {
  assert.equal(parseJobCardBarcode('  HKJC:jc-xyz \n'), 'jc-xyz');
});

test('parseJobCardBarcode rejects non-ours: no prefix, wrong shape, our QR URLs', () => {
  // Stray courier / GTIN barcode — no prefix.
  assert.equal(parseJobCardBarcode('1234567890128'), null);
  // Prefixed but not a jc- id.
  assert.equal(parseJobCardBarcode('HKJC:PO-2605-001'), null);
  // Our own QR URL never carries the prefix → must not be taken as a barcode id.
  assert.equal(
    parseJobCardBarcode('https://erp.hookka.com/worker/scan?op=jc-abc&po=SO-X'),
    null,
  );
  assert.equal(parseJobCardBarcode(''), null);
});

test('the short compartment form is much less dense than the legacy wk= form it replaced', () => {
  // Documents WHY Fab Sew switched off the full-wipKey sticker: that form was v7
  // (unscannable); the short c= form is v5. If anyone reintroduces wk= for Fab
  // Sew, this gap is the reason not to.
  const shortV = qrVersion(onProd(generateCompartmentStickerData(WORST_PO, 'HEADBOARD', '/worker/scan', 2, 2)));
  const longWk =
    `${PROD_ORIGIN}/worker/scan?po=${WORST_PO}&wk=` +
    encodeURIComponent('1013-(Q)::0::HEADBOARD::900mm Headboard- King') +
    '&p=2&t=2';
  const longV = qrVersion(longWk);
  assert.ok(
    longV - shortV >= 2,
    `expected the short form (v${shortV}) to be >=2 QR versions below the legacy wk= form (v${longV})`,
  );
});
