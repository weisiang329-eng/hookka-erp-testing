// ---------------------------------------------------------------------------
// production-patch-guard.test.mjs — regression test for the merged Fab Cut
// fan-out PATCH path.
//
// Bug history: the upstream-lock guard in applyPoUpdate (PATCH
// /api/production-orders/:poId) used to fire on any payload that included
// `completedDate`. The Production Sheet's merged-row date-cell click sends
// BOTH `status: 'COMPLETED'` and `completedDate: <today>`, and the operator's
// intent is the status change — the date stamp is just a side-effect. Before
// the fix, this combination could short-circuit a clean WAITING → COMPLETED
// transition with a 409.
//
// The fix exempts patches that include `body.status` from the upstream-lock
// guard. We don't pull in a real Hono runtime here — instead we assert the
// source-level invariant by reading the production-orders.ts file and
// confirming the guard predicate explicitly checks `isStatusChange`.
//
// This is a structural test (same shape as smoke.test.mjs): cheap, no DB,
// no Workers runtime needed. If the guard regresses (someone reverts the
// `!isStatusChange &&` skip), this test fails with a clear message.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(
  process.cwd(),
  'src/api/routes-d1/production-orders.ts',
);

function read() {
  return readFileSync(SRC, 'utf8');
}

test('applyPoUpdate exists in production-orders.ts', () => {
  const src = read();
  assert.match(
    src,
    /async function applyPoUpdate\b/,
    'applyPoUpdate function should be defined',
  );
});

test('upstream-lock guard skips when body.status is part of the patch', () => {
  const src = read();
  // The guard predicate must include an explicit !isStatusChange exemption,
  // otherwise a merged-row Fab Cut WAITING → COMPLETED click (which sends
  // both status and completedDate) is wrongly subjected to the downstream-
  // done check.
  assert.match(
    src,
    /const isStatusChange = body\.status !== undefined;/,
    'guard should derive isStatusChange from body.status',
  );
  assert.match(
    src,
    /!isStatusChange &&\s*\(body\.dueDate !== undefined \|\| body\.completedDate !== undefined\)/,
    'guard should skip when isStatusChange is true',
  );
});

test('PATCH route still wires through applyPoUpdate', () => {
  const src = read();
  assert.match(
    src,
    /app\.patch\("\/:id",\s*async \(c\)\s*=>\s*applyPoUpdate\(c, c\.req\.param\("id"\)\)\)/,
    'PATCH /:id should still call applyPoUpdate',
  );
});

test('frontend merged-row fan-out iterates per-JC poId (not row.poId)', () => {
  // Pin the call shape: refs.map((r) => ({ ...r, patch })) where r already
  // carries its own poId. If a future refactor switches back to row.poId for
  // every entry, sofa multi-PO merges would silently drop sibling-PO JCs.
  const ui = readFileSync(
    resolve(process.cwd(), 'src/pages/production/index.tsx'),
    'utf8',
  );
  // Two callsites — both must spread the per-ref poId.
  const matches = ui.match(/patchJobCardsBatch\(refs\.map\(\(r\)\s*=>\s*\(\{\s*\.\.\.r,\s*patch\s*\}\)\)\)/g);
  assert.ok(
    matches && matches.length >= 2,
    `expected at least 2 patchJobCardsBatch fan-out callsites, found ${matches?.length ?? 0}`,
  );
});

test('merged-row date-cell click sends status + completedDate together', () => {
  // This is the exact payload shape that hits the PATCH endpoint. If a
  // future refactor splits these into two separate patches the upstream-lock
  // exemption above would no longer apply to the date half — and the bug
  // returns. Pin the payload shape here.
  const ui = readFileSync(
    resolve(process.cwd(), 'src/pages/production/index.tsx'),
    'utf8',
  );
  assert.match(
    ui,
    /completedDate:\s*v,\s*\n\s*status:\s*v\s*\?\s*"COMPLETED"\s*:\s*"WAITING",/,
    'date-cell click should set both completedDate and status in one patch',
  );
});
