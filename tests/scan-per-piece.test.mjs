// ---------------------------------------------------------------------------
// scan-per-piece.test.mjs — structural regression test for the 2026-06-07
// bedframe per-piece fixes (no D1 runtime; pins the source-level invariants
// so a refactor can't silently re-introduce the bugs Wei Siang hit on device).
//
// Bugs being pinned:
//   1. Scanning Divan #2 / the Headboard after Divan #1 wrongly said "you
//      already scanned this piece" — the lookup guard fell back to the
//      CARD-level pic (the first piece's scanner) for a per-piece scan.
//   2. The card showed only PIC1 when two people each did a piece — it should
//      show PIC1 + PIC2 (the distinct piece scanners).
//   3. Sofa BASE must stay whole-variant (one scan = base+cushion+armrest done,
//      a real completion date) — NOT per-piece.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCAN = readFileSync(resolve(process.cwd(), 'src/pages/worker/scan.tsx'), 'utf8');
const PO =
  readFileSync(resolve(process.cwd(), 'src/api/routes/production-orders.ts'), 'utf8') +
  '\n\n' +
  readFileSync(resolve(process.cwd(), 'src/api/routes/production-orders/_helpers.ts'), 'utf8');

test('per-piece duplicate guard uses ONLY the piece slot (no card-level fallback)', () => {
  // For a per-piece scan (result.piece set) the guard must read the piece slot,
  // never the card-level pic — else scanning a DIFFERENT piece is blocked.
  assert.ok(SCAN.includes('result.piece'), 'guard must branch on result.piece');
  assert.ok(
    SCAN.includes('pieceSlot?.pic1Id ?? null'),
    'per-piece branch must use the piece slot, falling back to null (not the card pic)',
  );
});

test('backend binds ONLY the scanned piece slot (per-piece)', () => {
  assert.ok(
    PO.includes('s.pieceNo === pieceNo'),
    'slot-fill must filter to the scanned pieceNo, not every slot',
  );
});

test('card PIC1/PIC2 = distinct piece scanners (old first-slot logic removed)', () => {
  assert.ok(PO.includes('piecePeople'), 'must aggregate distinct piece scanners');
  assert.ok(
    PO.includes('piecePeople[0]?.id') && PO.includes('piecePeople[1]?.id'),
    'PIC1 = first distinct person, PIC2 = second distinct person',
  );
  assert.ok(
    !PO.includes('const firstWithPic1 = slotList.find'),
    'the old "first slot only" PIC propagation must be gone',
  );
});

test('completion still requires ALL pieces done (date only when both scanned)', () => {
  assert.ok(
    PO.includes('slotList.every((s) => !!s.pic1Id)'),
    'card completes only when EVERY piece slot has a scanner',
  );
});

test('sofa BASE fans out to the whole variant (not per-piece)', () => {
  assert.ok(
    PO.includes('.startsWith("SOFA_")'),
    'a SOFA_* compartment clears wipKey/pieceNo so the scan completes the whole variant',
  );
});

test('worker scans resolve org safely (no "ORGID not resolved" crash)', () => {
  // Worker-token requests carry no dashboard userId, so the strict getOrgId()
  // throws "orgId not resolved on request context" (the red error on the Worker
  // Portal). The scan paths must use the safe resolver that falls back to the
  // single tenant instead of throwing.
  assert.ok(
    PO.includes('tryGetOrgId(c) ?? DEFAULT_ORG_ID'),
    'scanOrgId must fall back to the default tenant for worker scans (no throw)',
  );
  assert.ok(
    PO.includes('orgId: scanOrgId(c)'),
    'scan writes must resolve org via scanOrgId, not the throwing getOrgId',
  );
});

test('every scan completion refreshes the dashboard (no stale Fab Cut / Fab Sew sheet)', () => {
  // The stale-dashboard bug (Fab Cut still PENDING while Fab Sew shows DONE)
  // came from a scan that did not invalidate the production snapshot/cache.
  // Every scan-complete path must call the invalidator so the sheet updates.
  const calls = (PO.match(/await invalidateProductionCachesAfterScan\(c\)/g) || []).length;
  assert.ok(
    calls >= 3,
    `expected all 3 scan-complete paths to refresh the dashboard, found ${calls}`,
  );
});

test('changing a stays-completed card PIC propagates the swap to piece_pics (old PIC no longer credited)', () => {
  // BUG: the operator removes/changes a completed card's PIC on the production
  // page; job_cards.pic1Id/pic2Id moves, but the piece_pics scan stamps keep the
  // OLD pic. The worker "Completed Products" view credits via piece_pics, so the
  // removed PIC still shows as having completed the products. The fix must
  // propagate a PIC swap on a card that STAYS completed (the SET branch handles a
  // fresh complete; the CLEAR branch wipes everything on un-complete).
  assert.ok(
    PO.includes('const oldPic1Id = updated.pic1Id') &&
      PO.includes('const oldPic2Id = updated.pic2Id'),
    'must snapshot the old PICs BEFORE the body change is applied',
  );
  assert.ok(
    /jcWasCompleted &&[\s\S]{0,80}updated\.pic1Id !== oldPic1Id/.test(PO),
    'must branch on a card that stays completed whose PIC changed',
  );
  assert.ok(
    PO.includes(
      'UPDATE piece_pics SET pic1Id = ?, pic1Name = ? WHERE jobCardId = ? AND pic1Id = ?',
    ) &&
      PO.includes(
        'UPDATE piece_pics SET pic2Id = ?, pic2Name = ? WHERE jobCardId = ? AND pic2Id = ?',
      ),
    'must swap OLD pic -> NEW pic in piece_pics, scoped to the old pic so other scanners are untouched',
  );
});
