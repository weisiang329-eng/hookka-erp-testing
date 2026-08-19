// ---------------------------------------------------------------------------
// supplier-source-doc-every-path.test.mjs — BUG-2026-08-19-156.
//
// The purchasing-side twin of BUG-2026-08-19-155. Same gate, same silence,
// different document.
//
// Owner ruling 2026-06-30: a scanned supplier document must stay linked to the
// purchase invoice it produced ("View source document"). The upload that does
// that was gated:
//
//     if (card.scanQueueRowId) { … uploadScanQueueRowAsSourceDoc(…) }
//
// `scanQueueRowId` is set only on cards resumed from the background scan queue.
// `buildCard(upload.file.name, result.data, result.sampleId)` — the sync
// /extract path, i.e. dragging a PDF into the modal — left it at its `null`
// default. So a PI created that way silently kept no source document, and the
// helper's bare `catch {}` meant a document never saved looked exactly like one
// that was.
//
// The card held only `fileName`, never the File, so the fix had to give it one.
// The trap in the other direction is real too: queue-resumed cards have NO File,
// so "just use card.sourceFile" would save nothing for them instead.
//
// Tests 1-8 are BEHAVIOURAL against the real exported functions with a stubbed
// `fetch`. Test 9 is a source-structure check on the modal and says so — the
// component is ~5,900 lines and cannot be rendered in a unit test.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  uploadSourceDoc,
  sourceDocOriginForCard,
} from '../src/lib/scan-queue-client.ts';

function stubFetch({
  bytesStatus = 200,
  uploadStatus = 200,
  bytes = 'PDFDATA',
  uploadJson = { success: true, data: { id: 'file-1' } },
  disposition = 'attachment; filename="supplier-inv.pdf"',
} = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/api/scan-queue/')) {
      return {
        ok: bytesStatus >= 200 && bytesStatus < 300,
        status: bytesStatus,
        headers: {
          get: (h) =>
            h.toLowerCase() === 'content-disposition'
              ? disposition
              : h.toLowerCase() === 'content-type'
                ? 'application/pdf'
                : null,
        },
        blob: async () => new Blob([bytes], { type: 'application/pdf' }),
      };
    }
    return {
      ok: uploadStatus >= 200 && uploadStatus < 300,
      status: uploadStatus,
      json: async () => uploadJson,
    };
  };
  fn.calls = calls;
  return fn;
}

function withFetch(fn, body) {
  const real = globalThis.fetch;
  globalThis.fetch = fn;
  return Promise.resolve(body()).finally(() => {
    globalThis.fetch = real;
  });
}

function quiet(body) {
  const real = console.error;
  console.error = () => {};
  return Promise.resolve(body()).finally(() => {
    console.error = real;
  });
}

const pdf = (name = 'inv.pdf') => new File(['PDFBYTES'], name, { type: 'application/pdf' });

// --- 1. a direct-upload card: File present, no queue row -----------------
test('sourceDocOriginForCard uses the card File when the card has one', () => {
  const f = pdf();
  assert.deepEqual(sourceDocOriginForCard({ sourceFile: f, scanQueueRowId: null }), {
    kind: 'file',
    file: f,
  });
});

// --- 2. a queue-resumed card: no File, row id present --------------------
test('sourceDocOriginForCard falls back to the queue row when there is no File', () => {
  assert.deepEqual(
    sourceDocOriginForCard({ sourceFile: null, scanQueueRowId: 'row-3' }),
    { kind: 'queue', rowId: 'row-3' },
  );
});

// --- 3. an empty File must not beat a usable queue row -------------------
test('sourceDocOriginForCard ignores a zero-byte File and prefers the queue row', () => {
  const empty = new File([], 'inv.pdf', { type: 'application/pdf' });
  assert.equal(empty.size, 0, 'premise');
  assert.deepEqual(
    sourceDocOriginForCard({ sourceFile: empty, scanQueueRowId: 'row-4' }),
    { kind: 'queue', rowId: 'row-4' },
  );
});

// --- 4. neither -> null, never a bogus origin ----------------------------
test('sourceDocOriginForCard returns null when there is genuinely no source', () => {
  assert.equal(sourceDocOriginForCard({ sourceFile: null, scanQueueRowId: null }), null);
  assert.equal(sourceDocOriginForCard({}), null);
});

// --- 5. a File origin uploads with no scan-queue round trip --------------
test('a File origin is uploaded directly — no /api/scan-queue read', async () => {
  const f = stubFetch();
  const id = await withFetch(f, () =>
    uploadSourceDoc({ kind: 'file', file: pdf('SUP-88.pdf') }, 'purchase-invoice-source', 'card-1'),
  );
  assert.equal(id, 'file-1');
  assert.equal(f.calls.filter((c) => c.url.includes('/api/scan-queue/')).length, 0);

  const up = f.calls.find((c) => c.url === '/api/files');
  assert.ok(up, 'it must POST to /api/files');
  assert.equal(up.init.body.get('resourceType'), 'purchase-invoice-source');
  assert.equal(up.init.body.get('resourceId'), 'card-1');
  assert.equal(up.init.body.get('file').name, 'SUP-88.pdf', 'keeps the real filename');
  assert.ok(up.init.body.get('file').size > 0);
});

// --- 6. a queue origin reads the bytes and keeps the served filename -----
test('a queue origin fetches the stored bytes and honours Content-Disposition', async () => {
  const f = stubFetch();
  const id = await withFetch(f, () =>
    uploadSourceDoc({ kind: 'queue', rowId: 'row-9' }, 'purchase-invoice-source', 'row-9'),
  );
  assert.equal(id, 'file-1');
  assert.equal(f.calls[0].url, '/api/scan-queue/row-9/bytes');
  assert.equal(f.calls[1].init.body.get('file').name, 'supplier-inv.pdf');
});

// --- 7. no origin is a REPORTED null, and touches nothing ----------------
test('a null origin returns null without pretending to upload', async () => {
  const f = stubFetch();
  const id = await quiet(() =>
    withFetch(f, () => uploadSourceDoc(null, 'purchase-invoice-source', 'card-2')),
  );
  assert.equal(id, null);
  assert.equal(f.calls.length, 0);
});

// --- 8. every transport failure returns null and never throws ------------
test('HTTP failures, empty bytes and a bad upload body all return null', async () => {
  const cases = [
    ['bytes 404', stubFetch({ bytesStatus: 404 })],
    ['upload 500', stubFetch({ uploadStatus: 500 })],
    ['empty bytes', stubFetch({ bytes: '' })],
    ['upload returned no id', stubFetch({ uploadJson: { success: true, data: {} } })],
  ];
  for (const [label, f] of cases) {
    const id = await quiet(() =>
      withFetch(f, () =>
        uploadSourceDoc({ kind: 'queue', rowId: 'row-9' }, 'purchase-invoice-source', 'row-9'),
      ),
    );
    assert.equal(id, null, label);
  }
});

// --- 9. the modal must not re-gate the upload on the queue id ------------
test('the supplier modal saves the source document on every create path', () => {
  // The weakest test here, and deliberately kept: the fault that shipped was a
  // gate in the component, and no unit test can reach inside a ~5,900-line file.
  const src = readFileSync('src/components/scan-supplier-modal.tsx', 'utf8');

  assert.doesNotMatch(
    src,
    /if\s*\(card\.scanQueueRowId\)\s*\{[\s\S]{0,200}?uploadSourceDoc/,
    'the queue-id gate is back: direct uploads will save no source document',
  );
  assert.match(src, /sourceDocOriginForCard\(card\)/, 'the origin picker must be used');

  // The sync /extract path must hand its File to the card, or the picker has
  // nothing to find. This is the line whose absence caused the bug.
  assert.match(
    src,
    /buildCard\(\s*upload\.file\.name,\s*result\.data,\s*result\.sampleId,\s*null,\s*0,\s*upload\.file,?\s*\)/,
    'the direct-upload call site must pass upload.file into the card',
  );
});
