// ---------------------------------------------------------------------------
// cached-fetch-result.test.mjs — BEHAVIOURAL cover for the distinction the
// Reports page now depends on: a failed fetch is not an empty dataset.
//
// BUG-2026-08-13-005. `cachedFetchJson` collapses a 30 s abort, an HTTP 500, a
// degraded `_stub` envelope and a genuinely empty list into the same `null`,
// so `json?.data || []` wrote emptiness into state and the page printed
// "No data available" over dead requests. `cachedFetchJsonResult` is the
// variant that says which happened.
//
// The source pins in reports-failed-fetch-is-not-empty.test.mjs stop the page
// regressing; this runs the real function so the distinction itself is proved,
// including the case that matters most — a 200 OK that is still a failure.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

// The module reads a Vite-injected build id at import time and gates all
// localStorage work on `window` existing. Leaving `window` undefined keeps the
// cache layer inert, which is what we want: these assertions are about the
// network outcome, not about caching.
globalThis.__BUILD_ID__ = "test-build";

const { cachedFetchJsonResult } = await import("../src/lib/cached-fetch.ts");

function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

const okResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

test("a genuinely empty dataset is a SUCCESS, and stays empty", async () => {
  await withFetch(
    async () => okResponse({ success: true, data: [] }),
    async () => {
      const r = await cachedFetchJsonResult("/api/empty-on-purpose");
      assert.equal(r.ok, true, "an empty list is not a failure");
      assert.deepEqual(r.data, { success: true, data: [] });
    },
  );
});

test("a non-2xx is a failure, never an empty dataset", async () => {
  await withFetch(
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => {
      const r = await cachedFetchJsonResult("/api/boom");
      assert.equal(r.ok, false);
      assert.ok(r.error && r.error.length > 0, "must carry a reason");
      // Operator-safe: no status code, no URL, no stack noise.
      assert.ok(
        !/HTTP\s*\d{3}|\/api\//.test(r.error),
        `the message must be plain English, got: ${r.error}`,
      );
    },
  );
});

test("the 30 s global abort is reported as a timeout, not as 'Aborted'", async () => {
  await withFetch(
    async () => {
      throw new DOMException("signal is aborted without reason", "AbortError");
    },
    async () => {
      const r = await cachedFetchJsonResult("/api/too-slow");
      assert.equal(r.ok, false);
      assert.match(
        r.error,
        /took too long/i,
        "an abort must read as a timeout the operator can act on",
      );
      assert.ok(
        !/abort/i.test(r.error),
        "the AbortError's own wording must never reach the operator",
      );
    },
  );
});

test("a 200 OK carrying the unmounted-route _stub envelope is a FAILURE", async () => {
  // This is the dangerous one: HTTP 200, `success: true`, and `data: []`. Read
  // as a dataset it says "nothing happened"; it actually means the route is
  // not mounted. It masked the linkedPOs bug for months.
  await withFetch(
    async () => okResponse({ success: true, data: [], _stub: true, path: "/x" }),
    async () => {
      const r = await cachedFetchJsonResult("/api/not-mounted");
      assert.equal(r.ok, false, "a _stub envelope must not read as empty data");
      assert.ok(r.error && r.error.length > 0);
    },
  );
});

test("a handled backend error ({success:false}) is a FAILURE", async () => {
  await withFetch(
    async () => okResponse({ success: false, error: "Report range is invalid" }),
    async () => {
      const r = await cachedFetchJsonResult("/api/refused");
      assert.equal(r.ok, false);
      assert.equal(
        r.error,
        "Report range is invalid",
        "a clean backend sentence is the best thing to show, so keep it",
      );
    },
  );
});

test("a technical backend string is translated before it reaches an operator", async () => {
  await withFetch(
    async () =>
      okResponse({
        success: false,
        error:
          'null value in column "start_date" violates not-null constraint',
      }),
    async () => {
      const r = await cachedFetchJsonResult("/api/constraint");
      assert.equal(r.ok, false);
      assert.ok(
        !r.error.includes("start_date"),
        `a column name must never be shown, got: ${r.error}`,
      );
    },
  );
});
