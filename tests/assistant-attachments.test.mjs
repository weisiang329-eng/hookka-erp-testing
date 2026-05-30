// ---------------------------------------------------------------------------
// assistant-attachments.test.mjs — unit tests for the attachment parser.
//
// Covers:
//   - parseCsv: RFC 4180-ish corner cases (quoted fields, embedded commas
//     and newlines, escaped quotes)
//   - parseExcelBytes: SheetJS round-trip — build a tiny .xlsx in memory,
//     parse it back, check sheet names + headers + rows
//   - validateIncoming: size + extension guardrails
//   - ingestAttachments: per-message budget (max 3 files) + rejection
//     of executable file types
//
// Pure helpers only — no DB, no network. The Anthropic vision flow is
// tested manually (see docs/assistant-attachment-manual-test.md).
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

const parser = await import('../src/api/lib/attachment-parser.ts');
const XLSX = await import('xlsx');

const {
  parseCsv,
  parseExcelBytes,
  validateIncoming,
  ingestAttachments,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} = parser;

// ---------------------------------------------------------------------------
// parseCsv
// ---------------------------------------------------------------------------

test('parseCsv — simple header + body', () => {
  const rows = parseCsv('Name,Age\nAlice,30\nBob,25\n');
  assert.deepEqual(rows, [
    ['Name', 'Age'],
    ['Alice', '30'],
    ['Bob', '25'],
  ]);
});

test('parseCsv — quoted fields with embedded commas', () => {
  const rows = parseCsv('Name,Note\n"Alice, A.","hello, world"\nBob,plain\n');
  assert.deepEqual(rows, [
    ['Name', 'Note'],
    ['Alice, A.', 'hello, world'],
    ['Bob', 'plain'],
  ]);
});

test('parseCsv — escaped double quotes inside a quoted field', () => {
  const rows = parseCsv('Name,Quote\nAlice,"She said ""hi"""\n');
  assert.deepEqual(rows, [
    ['Name', 'Quote'],
    ['Alice', 'She said "hi"'],
  ]);
});

test('parseCsv — embedded newline inside a quoted field', () => {
  const rows = parseCsv('Name,Address\n"Alice","Line1\nLine2"\nBob,Other\n');
  assert.deepEqual(rows, [
    ['Name', 'Address'],
    ['Alice', 'Line1\nLine2'],
    ['Bob', 'Other'],
  ]);
});

test('parseCsv — trailing newline does not produce an empty row', () => {
  const rows = parseCsv('a,b\n1,2\n');
  assert.equal(rows.length, 2);
});

// ---------------------------------------------------------------------------
// parseExcelBytes — generate a tiny in-memory .xlsx then parse it back.
// ---------------------------------------------------------------------------

test('parseExcelBytes — round-trips a single-sheet workbook with headers + body', async () => {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['PO Number', 'Customer', 'Date'],
    ['PO-009003', 'Houzs Century', '2026-05-12'],
    ['PO-009010', 'Houzs Century', '2026-05-14'],
    ['PO-008654', 'Carress', '2026-05-08'],
  ]);
  XLSX.utils.book_append_sheet(wb, sheet, 'Orders');
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

  const parsed = await parseExcelBytes(new Uint8Array(bytes));
  assert.equal(parsed.sheets.length, 1);
  const s = parsed.sheets[0];
  assert.equal(s.name, 'Orders');
  assert.deepEqual(s.headers, ['PO Number', 'Customer', 'Date']);
  assert.equal(s.rowCount, 3);
  assert.equal(s.rows[0]['PO Number'], 'PO-009003');
  assert.equal(s.rows[0]['Customer'], 'Houzs Century');
  assert.equal(s.rows[2]['Customer'], 'Carress');
});

test('parseExcelBytes — multi-sheet workbook returns every sheet', async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['a', 'b'], ['1', '2']]),
    'Sheet1',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['x', 'y'], ['9', '8']]),
    'Other',
  );
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const parsed = await parseExcelBytes(new Uint8Array(bytes));
  assert.equal(parsed.sheets.length, 2);
  assert.deepEqual(parsed.sheets.map((s) => s.name), ['Sheet1', 'Other']);
});

// ---------------------------------------------------------------------------
// validateIncoming
// ---------------------------------------------------------------------------

test('validateIncoming — rejects oversize file even before decode', () => {
  // Build a base64 payload that decodes to > 10 MB. base64 size is 4/3 of
  // the binary size, so 14 MB of base64 = ~10.5 MB binary.
  const oversize = 'A'.repeat(14 * 1024 * 1024);
  const check = validateIncoming({
    name: 'big.jpg',
    mediaType: 'image/jpeg',
    base64: oversize,
  });
  assert.equal(check.ok, false);
  assert.match(check.reason, /too large/i);
});

test('validateIncoming — rejects executable extensions even with image mime', () => {
  // Defense-in-depth: a malicious upload could spoof image/png on a .exe.
  const check = validateIncoming({
    name: 'payload.exe',
    mediaType: 'image/png',
    base64: 'AAAA',
  });
  assert.equal(check.ok, false);
  assert.match(check.reason, /executable/i);
});

test('validateIncoming — accepts CSV when MIME is octet-stream but extension is .csv', () => {
  const check = validateIncoming({
    name: 'orders.csv',
    mediaType: 'application/octet-stream',
    base64: 'YQ==',
  });
  assert.equal(check.ok, true);
});

test('validateIncoming — accepts standard image MIME', () => {
  const check = validateIncoming({
    name: 'po.jpg',
    mediaType: 'image/jpeg',
    base64: 'YQ==',
  });
  assert.equal(check.ok, true);
});

test('validateIncoming — rejects unsupported MIME with no recognised extension', () => {
  const check = validateIncoming({
    name: 'mystery',
    mediaType: 'application/x-msdownload',
    base64: 'YQ==',
  });
  assert.equal(check.ok, false);
});

// ---------------------------------------------------------------------------
// ingestAttachments
// ---------------------------------------------------------------------------

test('ingestAttachments — clamps to MAX_ATTACHMENTS_PER_MESSAGE and rejects excess', async () => {
  // Trivially-small valid CSVs.
  const tiny = Buffer.from('a\n1\n').toString('base64');
  const inputs = [];
  for (let i = 0; i < MAX_ATTACHMENTS_PER_MESSAGE + 2; i++) {
    inputs.push({ name: `f${i}.csv`, mediaType: 'text/csv', base64: tiny });
  }
  const out = await ingestAttachments(inputs);
  assert.equal(out.parsed.length, MAX_ATTACHMENTS_PER_MESSAGE);
  assert.equal(out.rejected.length, 2);
  assert.ok(out.rejected.every((r) => /only the first/i.test(r.reason)));
});

test('ingestAttachments — drops .exe attempts', async () => {
  const tiny = Buffer.from('hello').toString('base64');
  const out = await ingestAttachments([
    { name: 'malware.exe', mediaType: 'application/octet-stream', base64: tiny },
  ]);
  assert.equal(out.parsed.length, 0);
  assert.equal(out.rejected.length, 1);
  assert.match(out.rejected[0].reason, /executable/i);
});

test('ingestAttachments — parses a CSV through end-to-end', async () => {
  const csv = 'PO,Customer\nPO-009003,Houzs\nPO-008654,Carress\n';
  const b64 = Buffer.from(csv).toString('base64');
  const out = await ingestAttachments([
    { name: 'orders.csv', mediaType: 'text/csv', base64: b64 },
  ]);
  assert.equal(out.parsed.length, 1);
  const p = out.parsed[0];
  assert.equal(p.kind, 'csv');
  assert.ok(p.parsedRows);
  const sheet = p.parsedRows.sheets[0];
  assert.deepEqual(sheet.headers, ['PO', 'Customer']);
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.rows[0]['PO'], 'PO-009003');
});

test('MAX_ATTACHMENT_BYTES is 10 MB', () => {
  assert.equal(MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024);
});
