// ---------------------------------------------------------------------------
// fe-rum-self-report.test.mjs
//
// Two ways the RUM beacon was corrupting the very dashboard it feeds
// (both observed live on /admin/health, 2026-08-01):
//
//   1. SELF-REPORT LOOP. api-client.ts patches window.fetch and calls
//      reportApiCall() for every /api/* request — including fe-rum's own POST
//      to /api/fe-rum/event. The beacon reported itself, which queued an event,
//      which the next flush posted, which reported itself… /api/fe-rum/event
//      became the worst "endpoint" in the system (92 hits, p95 299s) and
//      crowded out the real slow endpoints the panel exists to show.
//
//   2. SUSPENSION SKEW. Worker phones freeze the tab on screen lock.
//      performance.now() keeps advancing, so an in-flight fetch settles on wake
//      with a duration of HOURS (observed max 7,692,593ms = 2h08m) even though
//      api-client aborts at 30s. Those samples are sleep, not latency, and they
//      dominated p95/max.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(
  resolve(process.cwd(), "src/lib/fe-rum.ts"),
  "utf8",
);
const flat = src.replace(/\s+/g, " ");

test("the beacon endpoint is excluded before any other reporting logic", () => {
  // Must be an early return in reportApiCall — before the slow/failed test,
  // or a slow beacon still queues an event about the beacon.
  const fn = src.slice(src.indexOf("export function reportApiCall"));
  const guard = fn.indexOf("endpoint === RUM_ENDPOINT");
  const slowCheck = fn.indexOf("const slow =");
  assert.ok(guard !== -1, "reportApiCall must skip the RUM endpoint");
  assert.ok(
    guard < slowCheck,
    "the self-report guard must run BEFORE the slow/failed decision",
  );
  assert.match(flat, /const RUM_ENDPOINT = "\/api\/fe-rum\/event"/);
});

test("the beacon posts to the same constant it excludes", () => {
  // If flush() hardcoded the path while the guard used a constant, they could
  // drift apart and the loop would silently come back.
  assert.match(flat, /await fetch\(RUM_ENDPOINT, \{/);
  const hardcoded = flat.match(/fetch\("\/api\/fe-rum\/event"/g) || [];
  assert.equal(
    hardcoded.length,
    0,
    "flush must use RUM_ENDPOINT, not a duplicated literal",
  );
});

test("implausible durations are dropped, not clamped", () => {
  const fn = src.slice(src.indexOf("export function reportApiCall"));
  assert.match(fn, /duration > MAX_PLAUSIBLE_CALL_MS/);
  assert.match(fn, /if \(duration > MAX_PLAUSIBLE_CALL_MS\) return;/);
  // Clamping would still assert "a 60s request happened" — a different lie.
  assert.ok(
    !/Math\.min\([^)]*MAX_PLAUSIBLE_CALL_MS/.test(fn),
    "must drop the sample, not clamp it into a plausible-looking one",
  );
  // Budget must sit above api-client's 30s abort so real slow calls survive.
  const m = flat.match(/MAX_PLAUSIBLE_CALL_MS = ([0-9_]+)/);
  assert.ok(m, "MAX_PLAUSIBLE_CALL_MS must be defined");
  const budget = Number(m[1].replace(/_/g, ""));
  assert.ok(
    budget > 30_000,
    `budget ${budget}ms must exceed api-client's 30s abort or genuine slow calls get dropped`,
  );
});

test("the beacon fetch has its own timeout", () => {
  // flush() deliberately bypasses api-client's abort budget (it must not be
  // reported), so without an explicit signal it had NO timeout at all.
  assert.match(flat, /signal: AbortSignal\.timeout\(FLUSH_TIMEOUT_MS\)/);
  const m = flat.match(/FLUSH_TIMEOUT_MS = ([0-9_]+)/);
  assert.ok(m, "FLUSH_TIMEOUT_MS must be defined");
  const t = Number(m[1].replace(/_/g, ""));
  assert.ok(t > 0 && t <= 30_000, `beacon timeout ${t}ms must be short`);
});

test("keepalive is retained — the last batch must survive navigation", () => {
  // Regression guard: dropping keepalive while adding the signal would lose
  // every flush fired on page-hide.
  assert.match(flat, /keepalive: true/);
});
