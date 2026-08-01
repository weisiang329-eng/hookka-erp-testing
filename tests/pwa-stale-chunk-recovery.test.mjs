// ---------------------------------------------------------------------------
// pwa-stale-chunk-recovery.test.mjs — the boot-time stale-chunk recovery in
// main.tsx (fix 2026-08-01). main.tsx is the ONLY recovery path that runs when
// the failing chunk is one React needs to MOUNT (the ErrorBoundary never
// mounts in that case). The old version used a blunt 30s time cooldown with no
// attempt counter, which stranded users on the boot splash during CDN edge
// propagation: the first stale chunk recovered, but a SECOND distinct stale
// chunk within 30s was silently swallowed. Structural pins: recovery is now
// bounded by an ATTEMPT CAP (not a time window), shares the counter key the
// ErrorBoundary resets on a successful render, keeps a short debounce, and the
// old unconditional 30s gate is gone.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
const sw = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
const boundary = readFileSync(
  resolve(process.cwd(), "src/components/ui/error-boundary.tsx"),
  "utf8",
);

test("recovery is bounded by an attempt cap, not a time window", () => {
  // A hard cap on total reloads is what prevents an infinite loop now.
  assert.match(main, /STALE_MAX_ATTEMPTS\s*=\s*\d+/);
  // The cap is checked BEFORE reloading (early return once exhausted).
  assert.match(main, /attempts\s*>=\s*STALE_MAX_ATTEMPTS\)\s*return/);
});

test("the old unconditional 30s time gate is gone", () => {
  // The blunt `if (Date.now() - lastTs < 30_000) return` that swallowed a
  // second distinct stale chunk must NOT come back.
  assert.doesNotMatch(main, /<\s*30_000\s*\)\s*return/);
});

test("a short debounce collapses a burst of preloadError events", () => {
  assert.match(main, /STALE_DEBOUNCE_MS\s*=\s*\d+/);
  assert.match(main, /Date\.now\(\)\s*-\s*lastTs\s*<\s*STALE_DEBOUNCE_MS\)\s*return/);
});

test("main.tsx and ErrorBoundary share the same attempt-counter key", () => {
  assert.match(main, /hookka-stale-chunk-attempts/);
  assert.match(boundary, /hookka-stale-chunk-attempts/);
});

test("the recovery budget is cleared where a SUCCESSFUL run can observe it", () => {
  // It used to be cleared inside ErrorFallback via `if (!error) removeItem(...)`
  // — a component only ever mounted BY a crash, so `error` is never null and the
  // effect never fired. The budget only incremented, and after two recoveries in
  // one session every later stale chunk went straight to "Something went wrong"
  // (owner hit exactly that on the second deploy of 2026-08-01).
  assert.doesNotMatch(
    boundary,
    /if \(!error\)\s*\{?\s*sessionStorage\.removeItem/,
    "ErrorFallback cannot clear the budget — it only renders when there IS an error",
  );
  // main.tsx clears both keys once the app has been alive long enough that a
  // stale chunk (which fails at boot or at a lazy route load) would have fired.
  assert.match(main, /setTimeout\(\(\)\s*=>\s*\{[\s\S]*?removeItem\(STALE_ATTEMPTS_KEY\)[\s\S]*?removeItem\(STALE_RELOAD_KEY\)[\s\S]*?\}, *10_000\)/);
});

test("recovery still purges the service worker + caches before reloading", () => {
  assert.match(main, /purgeServiceWorkerAndCaches\(\)\.finally\(\(\)\s*=>\s*window\.location\.reload\(\)\)/);
});

// ── The precache must never compete with the boot (2026-08-02) ──────────────
//
// Every deploy looked like a multi-minute outage: the SW installed, fired 60
// parallel asset downloads, and skipWaiting handed the still-booting page to
// it — so the app's own entry chunks queued behind the precache and arrived
// minutes late. No failed request, no console error, just a splash that hung
// and then, once the precache drained, worked perfectly. Both halves are
// pinned here because either one alone brings the stall back.
test("the SW does not start the heavy precache during install", () => {
  const install = sw.slice(sw.indexOf("addEventListener('install'"));
  const body = install.slice(0, install.indexOf("addEventListener('activate'"));
  assert.doesNotMatch(
    body,
    /precacheBuildAssets\(/,
    "install must not kick off the precache — it runs while a page is booting",
  );
});

test("the precache is client-triggered and concurrency-limited", () => {
  assert.match(sw, /PRECACHE_ASSETS/, "no client trigger");
  assert.match(sw, /const PARALLEL = \d+/, "no concurrency cap");
  const cap = Number(/const PARALLEL = (\d+)/.exec(sw)[1]);
  assert.ok(cap > 0 && cap <= 6, `concurrency ${cap} is not a cap`);
  assert.doesNotMatch(
    sw,
    /Promise\.allSettled\(\s*list\.map/,
    "the all-at-once precache is back",
  );
});

test("the app asks for the precache only after it has been running", () => {
  assert.match(main, /postMessage\('PRECACHE_ASSETS'\)/);
  // It must sit inside the delayed block, not at module scope.
  const idx = main.indexOf("PRECACHE_ASSETS");
  const delayed = main.lastIndexOf("setTimeout(", idx);
  assert.ok(delayed > 0 && idx - delayed < 1200, "precache trigger is not deferred");
});
