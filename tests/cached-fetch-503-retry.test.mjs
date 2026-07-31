// ---------------------------------------------------------------------------
// cached-fetch-503-retry.test.mjs — the SWR fetch layer (cached-fetch.ts) now
// retries transient gateway/DB-blip statuses (502/503/504) a bounded number of
// times before giving up. The backend returns a RETRIABLE 503 on a momentary
// session-verify DB failure under a page's concurrent request burst
// (auth-middleware.ts); without the retry that surfaced as an error and, e.g.,
// the production dept page's dueFrom=<today> query 503'd on the day's first,
// cold-snapshot load. Every URL through this path is an idempotent GET, so the
// retry can never double-apply a write (writes use raw fetch()). Verified on
// prod 2026-08-01. Driven through cachedFetchJson (the non-React entry that
// shares joinInflight's retry loop).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

// cached-fetch.ts reads the Vite-injected `__BUILD_ID__` at module load to
// namespace its cache. Define it (and skip the browser-only localStorage /
// BroadcastChannel branches, which are already `typeof window` guarded) BEFORE
// dynamically importing the module.
globalThis.__BUILD_ID__ = "test-build";
const { cachedFetchJson } = await import("../src/lib/cached-fetch.ts");

function res(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// Each test uses a UNIQUE url so the module-level in-flight dedup map and any
// (no-op in node) cache never bleed across cases.
function withMockFetch(sequence) {
  let calls = 0;
  globalThis.fetch = async () => {
    const step = sequence[Math.min(calls, sequence.length - 1)];
    calls++;
    return step();
  };
  return () => calls;
}

test("503 twice then 200 → resolves with the final body after retrying", async () => {
  const getCalls = withMockFetch([
    () => res(503, { success: false, error: "busy" }),
    () => res(503, { success: false, error: "busy" }),
    () => res(200, { success: true, data: [1, 2, 3] }),
  ]);
  const out = await cachedFetchJson("/api/test-503-then-200");
  assert.deepEqual(out, { success: true, data: [1, 2, 3] });
  assert.equal(getCalls(), 3, "should fetch 3x: 2 retries then success");
});

test("persistent 503 → gives up after the retry cap (1 + 2 retries = 3 calls)", async () => {
  const getCalls = withMockFetch([() => res(503, { success: false })]);
  // cachedFetchJson swallows the final error and returns cached (null here).
  const out = await cachedFetchJson("/api/test-503-persistent");
  assert.equal(out, null);
  assert.equal(getCalls(), 3, "1 initial + MAX_FETCH_RETRIES(2) = 3, then stop");
});

test("a non-retriable 404 is NOT retried (single fetch)", async () => {
  const getCalls = withMockFetch([() => res(404, { success: false })]);
  const out = await cachedFetchJson("/api/test-404-no-retry");
  assert.equal(out, null);
  assert.equal(getCalls(), 1, "4xx must not retry");
});

test("immediate 200 → no retry, one fetch", async () => {
  const getCalls = withMockFetch([() => res(200, { success: true, data: [] })]);
  const out = await cachedFetchJson("/api/test-200-immediate");
  assert.deepEqual(out, { success: true, data: [] });
  assert.equal(getCalls(), 1);
});
