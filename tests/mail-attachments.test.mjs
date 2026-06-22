// ---------------------------------------------------------------------------
// mail-attachments.test.mjs — unit tests for the Mail Center compose
// attachment validator (src/api/lib/mail-attachments.ts).
//
// The POST /api/mail-center/compose route sends synchronously and BYPASSES the
// email outbox, so it owns its own cap. These tests pin that cap so it can't
// silently drift away from the frontend mirror in compose.tsx:
//   - decodedBase64Bytes: base64 → binary-byte math (incl. padding)
//   - count cap (≤ 10)
//   - total decoded-size cap (≤ 5 MB)
//   - extension allow-list (images + PDF only)
//
// Pure helpers only — no DB, no network.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

try {
  register('tsx/esm', pathToFileURL('./'));
} catch {
  // Native type-stripping handles it on newer Node.
}

const mod = await import('../src/api/lib/mail-attachments.ts');
const {
  decodedBase64Bytes,
  isAllowedMailAttachment,
  validateMailAttachments,
  MAIL_ATTACH_MAX_COUNT,
  MAIL_ATTACH_MAX_TOTAL_BYTES,
} = mod;

// A base64 string whose decoded size is exactly `bytes`. 'A' is a valid base64
// char; 4 chars → 3 bytes, so 4/3 * bytes chars (rounded up to a multiple of 4)
// is more than enough — but to land EXACTLY on a byte count we build from
// Buffer so the padding is correct.
function base64OfBytes(bytes) {
  return Buffer.alloc(bytes, 0x41).toString('base64');
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

test('caps match the FE/BE contract (10 files, 5 MB)', () => {
  assert.equal(MAIL_ATTACH_MAX_COUNT, 10);
  assert.equal(MAIL_ATTACH_MAX_TOTAL_BYTES, 5 * 1024 * 1024);
});

// ---------------------------------------------------------------------------
// decodedBase64Bytes
// ---------------------------------------------------------------------------

test('decodedBase64Bytes — exact byte counts incl. padding', () => {
  assert.equal(decodedBase64Bytes(''), 0);
  // 'YQ==' = "a" (1 byte), 'YWI=' = "ab" (2 bytes), 'YWJj' = "abc" (3 bytes)
  assert.equal(decodedBase64Bytes('YQ=='), 1);
  assert.equal(decodedBase64Bytes('YWI='), 2);
  assert.equal(decodedBase64Bytes('YWJj'), 3);
  // Round-trips an arbitrary size.
  assert.equal(decodedBase64Bytes(base64OfBytes(1000)), 1000);
  assert.equal(decodedBase64Bytes(base64OfBytes(123456)), 123456);
});

// ---------------------------------------------------------------------------
// isAllowedMailAttachment
// ---------------------------------------------------------------------------

test('isAllowedMailAttachment — images + PDF only', () => {
  assert.equal(isAllowedMailAttachment('photo.jpg'), true);
  assert.equal(isAllowedMailAttachment('PHOTO.JPEG'), true);
  assert.equal(isAllowedMailAttachment('scan.PNG'), true);
  assert.equal(isAllowedMailAttachment('quote.pdf'), true);
  assert.equal(isAllowedMailAttachment('logo.webp'), true);
  // Disallowed
  assert.equal(isAllowedMailAttachment('orders.csv'), false);
  assert.equal(isAllowedMailAttachment('macro.xlsx'), false);
  assert.equal(isAllowedMailAttachment('payload.exe'), false);
  assert.equal(isAllowedMailAttachment('noext'), false);
  assert.equal(isAllowedMailAttachment('trailingdot.'), false);
});

// ---------------------------------------------------------------------------
// validateMailAttachments
// ---------------------------------------------------------------------------

test('validateMailAttachments — empty / undefined is ok', () => {
  assert.equal(validateMailAttachments(undefined).ok, true);
  assert.equal(validateMailAttachments([]).ok, true);
});

test('validateMailAttachments — accepts a small images+PDF batch', () => {
  const b64 = base64OfBytes(1024);
  const res = validateMailAttachments([
    { filename: 'a.jpg', contentBase64: b64 },
    { filename: 'b.pdf', contentBase64: b64 },
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.totalDecodedBytes, 2048);
});

test('validateMailAttachments — rejects > 10 files', () => {
  const b64 = base64OfBytes(16);
  const list = [];
  for (let i = 0; i < MAIL_ATTACH_MAX_COUNT + 1; i++) {
    list.push({ filename: `f${i}.png`, contentBase64: b64 });
  }
  const res = validateMailAttachments(list);
  assert.equal(res.ok, false);
  assert.match(res.error, /at most 10 files/i);
});

test('validateMailAttachments — exactly 10 files is allowed', () => {
  const b64 = base64OfBytes(16);
  const list = [];
  for (let i = 0; i < MAIL_ATTACH_MAX_COUNT; i++) {
    list.push({ filename: `f${i}.png`, contentBase64: b64 });
  }
  assert.equal(validateMailAttachments(list).ok, true);
});

test('validateMailAttachments — rejects total decoded size > 5 MB', () => {
  // Two files, ~3 MB each → ~6 MB combined.
  const big = base64OfBytes(3 * 1024 * 1024);
  const res = validateMailAttachments([
    { filename: 'a.png', contentBase64: big },
    { filename: 'b.png', contentBase64: big },
  ]);
  assert.equal(res.ok, false);
  assert.match(res.error, /5 MB limit/i);
});

test('validateMailAttachments — exactly 5 MB total is allowed', () => {
  const exact = base64OfBytes(MAIL_ATTACH_MAX_TOTAL_BYTES);
  const res = validateMailAttachments([
    { filename: 'a.pdf', contentBase64: exact },
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.totalDecodedBytes, MAIL_ATTACH_MAX_TOTAL_BYTES);
});

test('validateMailAttachments — 1 byte over 5 MB is rejected', () => {
  const over = base64OfBytes(MAIL_ATTACH_MAX_TOTAL_BYTES + 1);
  const res = validateMailAttachments([
    { filename: 'a.pdf', contentBase64: over },
  ]);
  assert.equal(res.ok, false);
  assert.match(res.error, /5 MB limit/i);
});

test('validateMailAttachments — rejects a disallowed extension', () => {
  const res = validateMailAttachments([
    { filename: 'malware.exe', contentBase64: base64OfBytes(16) },
  ]);
  assert.equal(res.ok, false);
  assert.match(res.error, /not an allowed type/i);
});

test('validateMailAttachments — rejects a row missing filename or content', () => {
  assert.equal(
    validateMailAttachments([{ filename: '', contentBase64: 'YQ==' }]).ok,
    false,
  );
  assert.equal(
    validateMailAttachments([{ filename: 'a.png', contentBase64: '' }]).ok,
    false,
  );
});
