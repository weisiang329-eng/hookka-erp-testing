// ---------------------------------------------------------------------------
// so-original-every-path.test.mjs
//
// THE BUG THIS PINS
// Owner 2026-07-15: every SO must keep the customer's original PO on record.
// The code to do that was written the same day, reviewed, and saved NOTHING for
// a month. On 2026-08-19 the owner reported that a brand-new SO still had no
// "View original" — and 0 of the SOs sampled on prod carried an attachment.
//
// Two independent faults, both invisible to a reader:
//
//   1. the call was gated `if (data.data.id && row.scanQueueRowId)`. That id is
//      NULL on every row produced by dragging a PDF into the modal
//      (`scan-po-modal.tsx`, sync /extract path) — the common case. The gate
//      failed, nothing was saved, and NOTHING WAS WARNED. A silent skip.
//   2. the template-match fallback branch, which also creates SOs, had no call
//      at all.
//
// The two entry points are COMPLEMENTARY and each is missing what the other
// has: a direct upload holds the real File but no queue id; a queue row holds
// the id but only a ZERO-BYTE placeholder File. Asking for one of them only is
// a no-op for half the operators — that is the shape to watch for.
//
// WHAT IS PROVED HERE, AND WHAT IS NOT
// Tests 1-7 are BEHAVIOURAL: they call the real exported functions with a
// stubbed `fetch` and assert what goes over the wire. Test 8 is a source-
// structure check on the modal, and it is honest about being one: no unit test
// can reach inside a 3.5k-line component, so the invariant "EVERY create branch
// calls it" is asserted against the source. That is weaker than a behavioural
// test and is why the logic was extracted into `src/lib/so-original.ts` at all.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  persistSoOriginal,
  originalSourceForRow,
  newQueueBytesCache,
} from '../src/lib/so-original.ts';

// --- a fetch stub that records every call --------------------------------
function stubFetch({ bytesStatus = 200, uploadStatus = 200, bytes = 'PDFDATA', bytesType = 'application/pdf' } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/api/scan-queue/')) {
      return {
        ok: bytesStatus >= 200 && bytesStatus < 300,
        status: bytesStatus,
        blob: async () => new Blob([bytes], { type: bytesType }),
      };
    }
    return { ok: uploadStatus >= 200 && uploadStatus < 300, status: uploadStatus };
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

// Silence the deliberate console.error on the failure paths — its presence is
// the point of the design (do not swallow), but it is noise in test output.
function quiet(body) {
  const real = console.error;
  console.error = () => {};
  return Promise.resolve(body()).finally(() => {
    console.error = real;
  });
}

const pdf = (name = 'PO.pdf', content = 'PDFDATA') =>
  new File([content], name, { type: 'application/pdf' });

// --- 1. the picker: a direct upload has a File and no queue id ------------
test('originalSourceForRow uses the local File when the row has one', () => {
  const f = pdf();
  assert.deepEqual(originalSourceForRow({ file: f, scanQueueRowId: null }), {
    kind: 'file',
    file: f,
  });
});

// --- 2. the picker: a queue row's File is a zero-byte placeholder ---------
test('originalSourceForRow ignores a ZERO-BYTE placeholder File and uses the queue id', () => {
  // scan-po-modal builds queue rows as `new File([], it.fileName)`. Trusting
  // `row.file` without checking `.size` would upload an empty attachment and
  // report success — worse than the original bug, because it looks fixed.
  const placeholder = new File([], 'PO.pdf', { type: 'application/pdf' });
  assert.equal(placeholder.size, 0, 'premise: the placeholder really is empty');
  assert.deepEqual(
    originalSourceForRow({ file: placeholder, scanQueueRowId: 'row-1' }),
    { kind: 'queue', rowId: 'row-1' },
  );
});

// --- 3. the picker: neither source -> null, never a bogus source ----------
test('originalSourceForRow returns null when there is genuinely no source', () => {
  assert.equal(originalSourceForRow({ file: null, scanQueueRowId: null }), null);
  assert.equal(originalSourceForRow({}), null);
});

// --- 4. a File source uploads WITHOUT a scan-queue round trip -------------
test('a File source is uploaded directly — no /api/scan-queue read', async () => {
  const f = stubFetch();
  const res = await withFetch(f, () =>
    persistSoOriginal('so-1', { kind: 'file', file: pdf() }, 'PO-9001'),
  );
  assert.deepEqual(res, { ok: true, poNo: 'PO-9001' });

  const queueReads = f.calls.filter((c) => c.url.includes('/api/scan-queue/'));
  assert.equal(queueReads.length, 0, 'must not fetch bytes it already holds');

  const uploads = f.calls.filter((c) => c.url === '/api/files');
  assert.equal(uploads.length, 1);
  const fd = uploads[0].init.body;
  assert.equal(fd.get('resourceType'), 'SO');
  assert.equal(fd.get('resourceId'), 'so-1');
  assert.equal(fd.get('file').name, 'PO-original-PO-9001.pdf');
  assert.ok(fd.get('file').size > 0, 'the attachment must carry real bytes');
});

// --- 5. a queue source reads the bytes, then uploads ----------------------
test('a queue source fetches the stored bytes and uploads them', async () => {
  const f = stubFetch();
  const res = await withFetch(f, () =>
    persistSoOriginal('so-2', { kind: 'queue', rowId: 'row-7' }, 'PO-9002'),
  );
  assert.deepEqual(res, { ok: true, poNo: 'PO-9002' });
  assert.equal(f.calls[0].url, '/api/scan-queue/row-7/bytes');
  assert.equal(f.calls[1].url, '/api/files');
  assert.equal(f.calls[1].init.body.get('file').name, 'PO-original-PO-9002.pdf');
});

// --- 6. no source is a REPORTED failure, not a silent skip ----------------
test('a null source reports ok:false instead of skipping quietly', async () => {
  // This is the whole lesson. The old code expressed "no source" as an `if`
  // that simply did not run: no upload, no warning, no trace. Now it returns a
  // failure the caller surfaces on the done step, so a missing original is
  // caught while the operator still has the paper in hand.
  const f = stubFetch();
  const res = await quiet(() =>
    withFetch(f, () => persistSoOriginal('so-3', null, 'PO-9003')),
  );
  assert.deepEqual(res, { ok: false, poNo: 'PO-9003' });
  assert.equal(f.calls.length, 0);
});

// --- 7. transport failures are reported, never thrown --------------------
test('HTTP failures and empty bytes report ok:false and never throw', async () => {
  const cases = [
    ['bytes 404', stubFetch({ bytesStatus: 404 })],
    ['upload 500', stubFetch({ uploadStatus: 500 })],
    ['empty source bytes', stubFetch({ bytes: '' })],
  ];
  for (const [label, f] of cases) {
    const res = await quiet(() =>
      withFetch(f, () =>
        persistSoOriginal('so-4', { kind: 'queue', rowId: 'row-9' }, 'PO-9004'),
      ),
    );
    assert.deepEqual(res, { ok: false, poNo: 'PO-9004' }, label);
  }
});

// --- 8. EVERY create branch in the modal calls it ------------------------
test('every SO-creation branch in scan-po-modal calls persistSoOriginal', () => {
  // A source-structure assertion, and it is the weakest test in this file — it
  // is here because the component is too large to render in a unit test, and
  // because "the fallback branch has no call at all" is exactly the fault that
  // shipped. If this component is ever split, replace this with a real one.
  const src = readFileSync('src/components/scan-po-modal.tsx', 'utf8');

  // Each `created.push({` marks one branch that has just made an SO.
  const branches = [...src.matchAll(/created\.push\(\{/g)].map((m) => m.index);
  assert.ok(branches.length >= 2, `expected >=2 create branches, found ${branches.length}`);

  for (const at of branches) {
    // Look only as far as the end of that branch's try/catch, so a call in a
    // LATER branch cannot vouch for an earlier one that has none.
    const window = src.slice(at, at + 2600);
    assert.match(
      window,
      /persistSoOriginal\(/,
      `an SO-creation branch near offset ${at} does not save the original PO`,
    );
  }

  // And the call must not be re-gated on the queue id — that gate is the
  // original bug, and it reads as a safety check rather than a filter.
  assert.doesNotMatch(
    src,
    /data\.data\.id\s*&&\s*row\.scanQueueRowId/,
    'the queue-id gate is back: direct uploads will silently save nothing',
  );

  // Ordering: the copies must all be awaited BEFORE /consume nulls the stored
  // bytes. (Only matters for queue sources, but a reorder would be silent.)
  const awaited = src.indexOf('await Promise.all(originalUploads)');
  const consumed = src.indexOf('void postScanQueueConsume(row.scanQueueRowId');
  assert.ok(awaited > 0 && consumed > 0, 'both anchors must exist');
  assert.ok(
    awaited < consumed,
    'the attachment copies must finish before the queue rows are consumed',
  );
});

// --- 9. one scanned PDF, one download ------------------------------------
test('several POs off ONE scan download the source once, not once each', async () => {
  // The fault this exists to stop: eight POs on one PDF meant eight parallel
  // downloads of the same multi-megabyte file, and some lost. Because the
  // failure lands on the BYTES fetch rather than the upload, nothing reaches
  // the server's error log — on prod (2026-08-26) it showed up only as a batch
  // of eight Carress orders where the first three kept their original and the
  // last five did not.
  const f = stubFetch();
  const cache = newQueueBytesCache();
  const results = await withFetch(f, () =>
    Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
        persistSoOriginal(`so-${n}`, { kind: 'queue', rowId: 'row-1' }, `PO-${n}`, cache),
      ),
    ),
  );
  assert.deepEqual(
    results.map((r) => r.ok),
    Array(8).fill(true),
    'every PO keeps its original',
  );
  const byteCalls = f.calls.filter((c) => c.url.includes('/api/scan-queue/'));
  assert.equal(byteCalls.length, 1, 'the PDF is downloaded ONCE for all eight');
  const uploads = f.calls.filter((c) => c.url.includes('/api/files'));
  assert.equal(uploads.length, 8, 'but each SO still gets its own attachment');
});

test('two DIFFERENT scans still download separately', async () => {
  const f = stubFetch();
  const cache = newQueueBytesCache();
  await withFetch(f, () =>
    Promise.all([
      persistSoOriginal('so-a', { kind: 'queue', rowId: 'row-a' }, 'PO-A', cache),
      persistSoOriginal('so-b', { kind: 'queue', rowId: 'row-b' }, 'PO-B', cache),
    ]),
  );
  assert.equal(f.calls.filter((c) => c.url.includes('/api/scan-queue/')).length, 2);
});

test('a failed download is not remembered as the answer', async () => {
  // Otherwise one blip would poison every later PO from that scan.
  const cache = newQueueBytesCache();
  const bad = await quiet(() =>
    withFetch(stubFetch({ bytesStatus: 500 }), () =>
      persistSoOriginal('so-x', { kind: 'queue', rowId: 'row-z' }, 'PO-X', cache),
    ),
  );
  assert.equal(bad.ok, false);
  const good = await withFetch(stubFetch(), () =>
    persistSoOriginal('so-y', { kind: 'queue', rowId: 'row-z' }, 'PO-Y', cache),
  );
  assert.equal(good.ok, true, 'the retry is allowed to fetch again');
});

test('the queue-path create branch passes a shared cache', () => {
  const src = readFileSync('src/components/scan-po-modal.tsx', 'utf8');
  assert.match(src, /const originalBytes = newQueueBytesCache\(\);/);
  assert.match(
    src,
    /originalSourceForRow\(row\),[\s\S]{0,80}?originalBytes,/,
    'the queue branch must share one download across the pass',
  );
});
