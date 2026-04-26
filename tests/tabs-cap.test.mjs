// ---------------------------------------------------------------------------
// tabs-cap.test.mjs — exercises the LRU + dirty-aware eviction reducer
// behind the 10-tab cap (src/contexts/tabs-reducer.ts).
//
// Why pure-reducer tests, not provider tests:
//   The reducer is the only place the cap rules live. Hooking JSDOM up just
//   to render TabsProvider would test the React plumbing, not the policy.
//   Same convention as authz.test.mjs.
//
// Coverage:
//   1. Opening up to 10 tabs is uncapped.
//   2. The 11th tab evicts the oldest non-dirty, non-pinned tab.
//   3. The 11th tab when ALL tabs are dirty returns "blocked" + sets
//      pendingOpenPath, doesn't crash, doesn't drop a tab.
//   4. Pinned tabs are never evicted, even if older than the dirty ones.
//   5. markDirty / markClean toggles eviction eligibility correctly.
//   6. setActive bumps lastVisitedAt so subsequent opens evict a *different*
//      tab (LRU semantics, not arrival-order).
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

let loaderRegistered = false;
try {
  register('tsx/esm', pathToFileURL('./'));
  loaderRegistered = true;
} catch {
  // Native type-stripping (Node 22.6+ / Node 24+) handles .ts imports
  // without a loader. If both fail, the import below throws.
}

let reducer;
try {
  reducer = await import(
    pathToFileURL(resolve(process.cwd(), 'src/contexts/tabs-reducer.ts')).href
  );
} catch (err) {
  console.warn(
    '[tabs-cap.test] Could not import src/contexts/tabs-reducer.ts. ' +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn('[tabs-cap.test] Error:', err?.message ?? err);
  throw err;
}

const {
  MAX_TABS,
  initialState,
  openTabAction,
  closeTabAction,
  markDirtyAction,
  setActiveAction,
  evictionCandidate,
} = reducer;

// ---- Helpers --------------------------------------------------------------

function makeId(i) {
  return `tab:/work/${i}`;
}
function makePath(i) {
  return `/work/${i}`;
}
function makeTitle(i) {
  return `Work ${i}`;
}

/** Build a state with N open tabs at increasing timestamps. */
function buildN(n) {
  let s = initialState;
  for (let i = 0; i < n; i++) {
    const r = openTabAction(s, {
      id: makeId(i),
      path: makePath(i),
      title: makeTitle(i),
      now: 1000 + i, // strictly increasing
    });
    s = r.state;
  }
  return s;
}

// ---- Tests ----------------------------------------------------------------

test('MAX_TABS is 10', () => {
  assert.equal(MAX_TABS, 10);
});

test('opening up to MAX_TABS tabs is uncapped', () => {
  const s = buildN(10);
  assert.equal(s.tabs.length, 10);
  assert.equal(s.activeId, makeId(9));
  assert.equal(s.pendingOpenPath, null);
});

test('11th tab evicts the oldest non-dirty tab (LRU)', () => {
  let s = buildN(10);
  const oldestId = makeId(0);

  // Open the 11th
  const r = openTabAction(s, {
    id: 'tab:/work/new',
    path: '/work/new',
    title: 'New',
    now: 1100,
  });
  assert.equal(r.kind, 'opened');
  assert.equal(r.evictedId, oldestId);
  assert.equal(r.state.tabs.length, 10);
  assert.equal(r.state.tabs.some((t) => t.id === oldestId), false);
  assert.equal(r.state.activeId, 'tab:/work/new');
});

test('11th tab is blocked when all tabs are dirty', () => {
  let s = buildN(10);
  // Mark every tab dirty
  for (let i = 0; i < 10; i++) {
    s = markDirtyAction(s, makeId(i), true);
  }

  const r = openTabAction(s, {
    id: 'tab:/work/blocked',
    path: '/work/blocked',
    title: 'Blocked',
    now: 9999,
  });
  assert.equal(r.kind, 'blocked');
  assert.equal(r.state.tabs.length, 10, 'no tab should be dropped');
  assert.equal(r.state.pendingOpenPath, '/work/blocked');
  // None of the existing tabs should be evicted
  for (let i = 0; i < 10; i++) {
    assert.ok(r.state.tabs.some((t) => t.id === makeId(i)));
  }
  // Should not crash on second blocked attempt either
  const r2 = openTabAction(r.state, {
    id: 'tab:/work/blocked2',
    path: '/work/blocked2',
    title: 'Blocked 2',
    now: 10000,
  });
  assert.equal(r2.kind, 'blocked');
});

test('pinned tabs are never evicted even when oldest', () => {
  let s = buildN(10);
  // Pin the very oldest
  s = {
    ...s,
    tabs: s.tabs.map((t, i) => (i === 0 ? { ...t, pinned: true } : t)),
  };

  const r = openTabAction(s, {
    id: 'tab:/work/new',
    path: '/work/new',
    title: 'New',
    now: 1100,
  });
  assert.equal(r.kind, 'opened');
  assert.notEqual(r.evictedId, makeId(0));
  // Pinned tab survived
  assert.ok(r.state.tabs.some((t) => t.id === makeId(0)));
  // Second-oldest got evicted
  assert.equal(r.evictedId, makeId(1));
});

test('markDirty / markClean toggles eviction eligibility', () => {
  let s = buildN(10);
  // Make tab 0 the only one with old timestamp (others have been "visited")
  // Mark tab 0 dirty so it's no longer evictable
  s = markDirtyAction(s, makeId(0), true);
  assert.equal(evictionCandidate(s)?.id, makeId(1));

  // Mark tab 0 clean again — now it's evictable (and oldest)
  s = markDirtyAction(s, makeId(0), false);
  assert.equal(evictionCandidate(s)?.id, makeId(0));
});

test('setActive bumps lastVisitedAt → LRU follows recency, not arrival order', () => {
  let s = buildN(10);
  // Re-visit the oldest tab. Now tab 1 should be the LRU candidate.
  s = setActiveAction(s, makeId(0), 5000);
  assert.equal(evictionCandidate(s)?.id, makeId(1));

  const r = openTabAction(s, {
    id: 'tab:/work/new',
    path: '/work/new',
    title: 'New',
    now: 6000,
  });
  assert.equal(r.kind, 'opened');
  assert.equal(r.evictedId, makeId(1));
  // Originally-oldest tab survived because we re-visited it
  assert.ok(r.state.tabs.some((t) => t.id === makeId(0)));
});

test('reopening an existing tab is a no-op or switch — does not exceed cap', () => {
  let s = buildN(10);
  const r = openTabAction(s, {
    id: makeId(3),
    path: makePath(3),
    title: makeTitle(3),
    now: 2000,
  });
  assert.ok(r.kind === 'switched' || r.kind === 'noop');
  assert.equal(r.state.tabs.length, 10);
});

test('closing a dirty tab cleans up its dirty entry', () => {
  let s = buildN(3);
  s = markDirtyAction(s, makeId(1), true);
  assert.equal(s.dirty[makeId(1)], true);
  const { state: after } = closeTabAction(s, makeId(1));
  assert.equal(after.dirty[makeId(1)], undefined);
  assert.equal(after.tabs.length, 2);
});
