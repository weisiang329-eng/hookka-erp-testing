// Tests for src/lib/scheduler.ts — useInterval / useTimeout.
//
// These hooks are deeply coupled to React's effect system and to the global
// `document` + `window.setInterval` APIs. Rather than spinning up a full
// JSDOM + react-test-renderer setup (heavy, and the rest of this repo's test
// suite is plain node:test), we re-implement the minimum runtime the hooks
// need:
//
//   - Fake timers (manual advance, no real setTimeout)
//   - A `document` stub with `hidden` flag + `addEventListener` /
//     `removeEventListener` / synthetic `dispatchEvent` for `visibilitychange`
//   - A minimal `useEffect` + `useRef` reducer that mirrors React semantics
//     well enough to drive the hook bodies through mount → effect → cleanup
//
// The "minimum useEffect" reducer (`mountHook`) lets us call the hook as a
// regular function and runs each `useEffect` callback in dependency order;
// changing dependencies on rerender re-runs cleanup-then-effect, which is
// what the real React does. This is the same trick the React docs use in
// their educational examples.
//
// We import the .ts source via `tsx` (already a dev dep — used by `npm run
// api`). The test runner is invoked with `node --import tsx/esm`, so the
// .ts extension resolves natively.

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Fake timers + document stub
// ---------------------------------------------------------------------------

let nowMs = 0;
let nextId = 1;
const intervals = new Map(); // id -> { fn, ms, nextFire }
const timeouts = new Map(); // id -> { fn, fireAt }

function resetTime() {
  nowMs = 0;
  nextId = 1;
  intervals.clear();
  timeouts.clear();
}

function advance(ms) {
  const target = nowMs + ms;
  // Fire timeouts and intervals in chronological order until target reached.
  // Loop because intervals re-arm.
  while (true) {
    let nextEvent = target + 1;
    let nextEventKind = null;
    let nextEventId = null;

    for (const [id, t] of timeouts) {
      if (t.fireAt < nextEvent) {
        nextEvent = t.fireAt;
        nextEventKind = 'timeout';
        nextEventId = id;
      }
    }
    for (const [id, iv] of intervals) {
      if (iv.nextFire < nextEvent) {
        nextEvent = iv.nextFire;
        nextEventKind = 'interval';
        nextEventId = id;
      }
    }

    if (nextEventKind === null || nextEvent > target) {
      nowMs = target;
      return;
    }

    nowMs = nextEvent;
    if (nextEventKind === 'timeout') {
      const t = timeouts.get(nextEventId);
      timeouts.delete(nextEventId);
      t.fn();
    } else {
      const iv = intervals.get(nextEventId);
      if (iv) {
        iv.nextFire = nowMs + iv.ms;
        iv.fn();
      }
    }
  }
}

const docListeners = new Map(); // event -> Set<fn>
const docState = { hidden: false };

function dispatchVisibility() {
  const fns = docListeners.get('visibilitychange');
  if (!fns) return;
  for (const fn of [...fns]) fn();
}

const documentStub = {
  get hidden() {
    return docState.hidden;
  },
  addEventListener(name, fn) {
    if (!docListeners.has(name)) docListeners.set(name, new Set());
    docListeners.get(name).add(fn);
  },
  removeEventListener(name, fn) {
    docListeners.get(name)?.delete(fn);
  },
  // querySelectorAll is referenced by use-version-check but not by scheduler;
  // provide a no-op so accidental cross-imports don't crash.
  querySelectorAll: () => [],
};

const windowStub = {
  setInterval(fn, ms) {
    const id = nextId++;
    intervals.set(id, { fn, ms, nextFire: nowMs + ms });
    return id;
  },
  clearInterval(id) {
    intervals.delete(id);
  },
  setTimeout(fn, ms) {
    const id = nextId++;
    timeouts.set(id, { fn, fireAt: nowMs + ms });
    return id;
  },
  clearTimeout(id) {
    timeouts.delete(id);
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};

// Install globals BEFORE the hook module is imported — the hooks reference
// `window.setInterval` / `document.hidden` at call time, not import time, but
// we still want the references to resolve cleanly.
globalThis.document = documentStub;
globalThis.window = windowStub;

// ---------------------------------------------------------------------------
// Minimal React-effect simulator
// ---------------------------------------------------------------------------
//
// `mountHook(hookFn)` installs hook-state slots and runs the hook once.
// Returns { rerender, unmount }.
//
//   useEffect(fn, deps): on first call, runs fn after the body returns.
//     On subsequent calls (after rerender), if any dep changed, runs the
//     previous cleanup then the new effect.
//   useRef(initial): persistent slot.
//
// Real React batches effects; our simulator runs them inline at end of the
// hook body. Close enough for these tests.

function mountHook(hookFn) {
  const slots = []; // { kind, ...state }
  let pendingEffects = [];
  let cursor = 0;
  let mounted = true;

  function useRef(initial) {
    if (slots.length <= cursor) {
      slots.push({ kind: 'ref', current: initial });
    }
    const slot = slots[cursor++];
    return slot;
  }

  function useEffect(fn, deps) {
    if (slots.length <= cursor) {
      // First call — schedule mount effect.
      const slot = { kind: 'effect', deps, cleanup: undefined };
      slots.push(slot);
      pendingEffects.push({ slot, fn });
    } else {
      const slot = slots[cursor];
      const prevDeps = slot.deps;
      const changed =
        deps === undefined ||
        prevDeps === undefined ||
        deps.length !== prevDeps.length ||
        deps.some((d, i) => !Object.is(d, prevDeps[i]));
      if (changed) {
        slot.deps = deps;
        pendingEffects.push({ slot, fn });
      }
    }
    cursor++;
  }

  // Inject our hooks into the scheduler module by overriding the React
  // package import. Done via the module-level mock below.
  hookEnv.useRef = useRef;
  hookEnv.useEffect = useEffect;

  function runOnce() {
    if (!mounted) return;
    cursor = 0;
    pendingEffects = [];
    hookFn();
    // Run pending effects in registration order.
    for (const { slot, fn } of pendingEffects) {
      // Run previous cleanup first if any.
      if (typeof slot.cleanup === 'function') {
        slot.cleanup();
        slot.cleanup = undefined;
      }
      const ret = fn();
      if (typeof ret === 'function') slot.cleanup = ret;
    }
    pendingEffects = [];
  }

  runOnce();

  return {
    rerender: runOnce,
    unmount() {
      mounted = false;
      // Cleanup in reverse order, like React.
      for (let i = slots.length - 1; i >= 0; i--) {
        const s = slots[i];
        if (s.kind === 'effect' && typeof s.cleanup === 'function') {
          s.cleanup();
          s.cleanup = undefined;
        }
      }
    },
  };
}

// hookEnv is the indirection that lets the scheduler module call our fake
// useRef / useEffect. We patch the `react` module via a Node loader-style
// override: we set `globalThis.__schedulerHookEnv__` and have a tiny test
// shim re-export it.

const hookEnv = { useRef: null, useEffect: null };
globalThis.__schedulerHookEnv__ = hookEnv;

// ---------------------------------------------------------------------------
// Module-level mock of `react` for the scheduler import.
// ---------------------------------------------------------------------------
// Strategy: read scheduler.ts source, swap the `from "react"` import for our
// shim, transpile via tsx programmatically, and load the resulting module.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { transformSync } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schedulerSrc = readFileSync(
  resolve(__dirname, '..', 'src', 'lib', 'scheduler.ts'),
  'utf8',
);

// Replace `from "react"` so we can inject our fake hooks without touching
// the real react package (which would require a full DOM). Use late-binding
// (function delegate) so the test's mountHook can swap the implementations
// per-call.
const patchedSrc = schedulerSrc.replace(
  /import\s*\{\s*useEffect\s*,\s*useRef\s*\}\s*from\s*["']react["'];?/,
  `const useEffect = (...args) => globalThis.__schedulerHookEnv__.useEffect(...args);
   const useRef = (...args) => globalThis.__schedulerHookEnv__.useRef(...args);`,
);

const { code: js } = transformSync(patchedSrc, {
  loader: 'ts',
  format: 'esm',
  target: 'es2020',
});

const tmp = mkdtempSync(resolve(tmpdir(), 'scheduler-test-'));
const tmpFile = resolve(tmp, 'scheduler.mjs');
writeFileSync(tmpFile, js, 'utf8');

const { useInterval, useTimeout } = await import(pathToFileURL(tmpFile).href);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function setupClean() {
  resetTime();
  docState.hidden = false;
  docListeners.clear();
}

test('useInterval fires every ms and clears on unmount', () => {
  setupClean();
  let calls = 0;
  const h = mountHook(() => useInterval(() => calls++, 1000));

  assert.equal(calls, 0, 'no immediate fire by default');
  advance(999);
  assert.equal(calls, 0);
  advance(1);
  assert.equal(calls, 1, 'first fire at +1000ms');
  advance(3000);
  assert.equal(calls, 4, 'fires every 1000ms');

  h.unmount();
  advance(5000);
  assert.equal(calls, 4, 'no more fires after unmount');
});

test('useInterval pauseOnHidden=true stops on document.hidden, resumes on visibilitychange', () => {
  setupClean();
  let calls = 0;
  mountHook(() => useInterval(() => calls++, 1000, { pauseOnHidden: true }));

  advance(2500);
  assert.equal(calls, 2);

  // Tab goes background.
  docState.hidden = true;
  dispatchVisibility();
  advance(5000);
  assert.equal(calls, 2, 'no fires while hidden');

  // Tab returns.
  docState.hidden = false;
  dispatchVisibility();
  advance(999);
  assert.equal(calls, 2, 'no immediate fire on resume — wait full ms');
  advance(1);
  assert.equal(calls, 3, 'first post-resume fire at +ms');
});

test('useInterval pauseOnHidden=false keeps firing even when hidden', () => {
  setupClean();
  let calls = 0;
  mountHook(() => useInterval(() => calls++, 1000, { pauseOnHidden: false }));

  docState.hidden = true;
  // No visibilitychange listener should be registered, so dispatching is a
  // no-op. Just advance and confirm we still tick.
  advance(3000);
  assert.equal(calls, 3, 'fires through hidden when pauseOnHidden=false');
});

test('useInterval runImmediately fires once on mount before first delay', () => {
  setupClean();
  let calls = 0;
  mountHook(() =>
    useInterval(() => calls++, 1000, { runImmediately: true }),
  );

  assert.equal(calls, 1, 'immediate fire on mount');
  advance(1000);
  assert.equal(calls, 2);
});

test('useInterval with ms=null is a no-op', () => {
  setupClean();
  let calls = 0;
  mountHook(() => useInterval(() => calls++, null));

  advance(10_000);
  assert.equal(calls, 0);
  assert.equal(intervals.size, 0, 'no underlying setInterval registered');
});

test('useInterval mounted while document.hidden does not fire until visible', () => {
  setupClean();
  docState.hidden = true;
  let calls = 0;
  mountHook(() =>
    useInterval(() => calls++, 1000, {
      pauseOnHidden: true,
      runImmediately: true,
    }),
  );

  advance(5000);
  assert.equal(calls, 0, 'runImmediately suppressed while hidden');

  docState.hidden = false;
  dispatchVisibility();
  advance(999);
  assert.equal(calls, 0);
  advance(1);
  assert.equal(calls, 1);
});

test('useTimeout fires once after ms; cleared on unmount', () => {
  setupClean();
  let fired = 0;
  const h = mountHook(() => useTimeout(() => fired++, 500));

  advance(499);
  assert.equal(fired, 0);
  advance(1);
  assert.equal(fired, 1);
  advance(5000);
  assert.equal(fired, 1, 'one-shot, no re-fire');

  h.unmount();
});

test('useTimeout cleared on unmount before fire', () => {
  setupClean();
  let fired = 0;
  const h = mountHook(() => useTimeout(() => fired++, 1000));

  advance(500);
  h.unmount();
  advance(2000);
  assert.equal(fired, 0, 'unmount cancels timeout');
});

test('useTimeout disarms when document.hidden becomes true and does NOT fire on resume', () => {
  setupClean();
  let fired = 0;
  mountHook(() => useTimeout(() => fired++, 1000));

  advance(400);
  docState.hidden = true;
  dispatchVisibility();
  advance(2000);
  assert.equal(fired, 0, 'hidden disarms timeout');

  docState.hidden = false;
  dispatchVisibility();
  advance(5000);
  assert.equal(fired, 0, 'does NOT re-arm on resume — stale-fire prevention');
});

test('useTimeout with ms=null is a no-op', () => {
  setupClean();
  let fired = 0;
  mountHook(() => useTimeout(() => fired++, null));

  advance(10_000);
  assert.equal(fired, 0);
  assert.equal(timeouts.size, 0);
});

test('useTimeout runOnUnmount fires the callback if not yet fired', () => {
  setupClean();
  let fired = 0;
  const h = mountHook(() =>
    useTimeout(() => fired++, 1000, { runOnUnmount: true }),
  );

  advance(500);
  h.unmount();
  assert.equal(fired, 1, 'runOnUnmount fires on early unmount');
});

test('useTimeout runOnUnmount does NOT double-fire if already fired', () => {
  setupClean();
  let fired = 0;
  const h = mountHook(() =>
    useTimeout(() => fired++, 500, { runOnUnmount: true }),
  );

  advance(500);
  assert.equal(fired, 1);
  h.unmount();
  assert.equal(fired, 1, 'no double fire on unmount after natural fire');
});

test('useInterval picks up latest fn closure without restarting timer', () => {
  setupClean();
  let label = 'a';
  const captured = [];
  const h = mountHook(() => useInterval(() => captured.push(label), 1000));

  advance(1000);
  assert.deepEqual(captured, ['a']);

  // Caller updates the closure (e.g. state changed in parent). The hook's
  // fnRef should pick up the latest fn without restarting the underlying
  // setInterval — so timing stays on the same cadence.
  label = 'b';
  h.rerender();
  advance(1000);
  assert.deepEqual(captured, ['a', 'b']);
  advance(1000);
  assert.deepEqual(captured, ['a', 'b', 'b']);
});
