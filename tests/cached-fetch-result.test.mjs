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

const { cachedFetchJsonResult, classifyFetchFailure, isUnknownOutcome, HttpError } =
  await import("../src/lib/cached-fetch.ts");

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

// ---------------------------------------------------------------------------
// BUG-2026-08-13-016 — the THREE outcomes, pinned apart.
//
// The failure this suite was originally written for collapsed "the request
// died" into "there is no data". Its sibling on the detail pages collapsed
// something worse: a killed request into "this record does not exist", which
// is a statement about the business that operators act on (they re-key orders
// that already exist).
//
// Three outcomes, three answers, and they must never merge:
//   (a) the server answered and the payload is empty  → SUCCESS, empty
//   (b) the request was aborted / never landed        → FAILURE, existence UNKNOWN
//   (c) the server answered 404                       → FAILURE, existence OBSERVED
// ---------------------------------------------------------------------------

test("(a) loaded-and-empty is a success and claims nothing about failure", async () => {
  await withFetch(
    async () => okResponse({ success: true, data: [] }),
    async () => {
      const r = await cachedFetchJsonResult("/api/genuinely-empty");
      assert.equal(r.ok, true);
      assert.equal(r.kind, undefined, "a success carries no failure kind");
    },
  );
});

test("(b) a 30 s abort is a TIMEOUT — existence stays unknown", async () => {
  await withFetch(
    async () => {
      throw new DOMException("signal is aborted without reason", "AbortError");
    },
    async () => {
      const r = await cachedFetchJsonResult("/api/killed-at-30s");
      assert.equal(r.ok, false);
      assert.equal(r.kind, "timeout");
      assert.equal(r.status, 0, "there was no response, so there is no status");
      assert.equal(
        isUnknownOutcome({ kind: r.kind, status: r.status, message: r.error }),
        true,
        "a timeout must never license the words 'not found'",
      );
    },
  );
});

test("(c) a real 404 is reported as ABSENT, and is NOT laundered into a network message", async () => {
  await withFetch(
    async () => ({ ok: false, status: 404, json: async () => ({}) }),
    async () => {
      const r = await cachedFetchJsonResult("/api/gone");
      assert.equal(r.ok, false);
      assert.equal(r.kind, "notFound", "404 is the ONE observed absence");
      assert.equal(r.status, 404);
      assert.equal(
        isUnknownOutcome({ kind: r.kind, status: r.status, message: r.error }),
        false,
        "a 404 IS an observation — the page may still say 'not found'",
      );
      assert.match(
        r.error,
        /couldn.t be found|removed/i,
        `a 404 must read as absence, got: ${r.error}`,
      );
      assert.ok(
        !/HTTP\s*\d{3}|\/api\//.test(r.error),
        `still operator-safe, got: ${r.error}`,
      );
    },
  );
});

test("(b) and (c) are DIFFERENT — the same page must be able to tell them apart", async () => {
  let timedOut;
  let absent;
  await withFetch(
    async () => {
      throw new DOMException("Aborted", "AbortError");
    },
    async () => {
      timedOut = await cachedFetchJsonResult("/api/x-timeout");
    },
  );
  await withFetch(
    async () => ({ ok: false, status: 404, json: async () => ({}) }),
    async () => {
      absent = await cachedFetchJsonResult("/api/x-absent");
    },
  );
  assert.notEqual(
    timedOut.kind,
    absent.kind,
    "if these ever collapse, the detail pages go back to lying",
  );
  assert.notEqual(timedOut.error, absent.error);
});

test("a 5xx is a server failure, distinct from both absence and timeout", async () => {
  await withFetch(
    async () => ({ ok: false, status: 503, json: async () => ({}) }),
    async () => {
      // 503 is retried twice before it throws; that is existing behaviour.
      const r = await cachedFetchJsonResult("/api/down");
      assert.equal(r.ok, false);
      assert.equal(r.kind, "server");
      assert.equal(r.status, 503);
      assert.equal(
        isUnknownOutcome({ kind: r.kind, status: r.status, message: r.error }),
        true,
      );
    },
  );
});

test("a browser network failure classifies as network, never as absence", async () => {
  await withFetch(
    async () => {
      throw new TypeError("Failed to fetch");
    },
    async () => {
      const r = await cachedFetchJsonResult("/api/offline");
      assert.equal(r.ok, false);
      assert.equal(r.kind, "network");
      assert.notEqual(r.kind, "notFound");
    },
  );
});

// --- the classifier itself (the decision every consumer now rests on) -------

test("classifyFetchFailure: only a 404 is an observed absence", () => {
  const cases = [
    [new HttpError(404, "/api/a"), "notFound", false],
    [new HttpError(500, "/api/a"), "server", true],
    [new HttpError(403, "/api/a"), "server", true],
    [new DOMException("Aborted", "AbortError"), "timeout", true],
    [new TypeError("Failed to fetch"), "network", true],
  ];
  for (const [err, kind, unknown] of cases) {
    const f = classifyFetchFailure(err);
    assert.equal(f.kind, kind, `${err} should classify as ${kind}`);
    assert.equal(isUnknownOutcome(f), unknown);
    assert.ok(f.message && f.message.length > 0, "every failure carries a reason");
    assert.ok(
      !/HTTP\s*\d{3}|\/api\/|abort/i.test(f.message),
      `operator-safe wording required, got: ${f.message}`,
    );
  }
});

test("classifyFetchFailure: a timeout says how long and what to do", () => {
  const f = classifyFetchFailure(new DOMException("Aborted", "AbortError"));
  assert.match(f.message, /30 seconds/);
  assert.match(f.message, /try again/i);
});

test("isUnknownOutcome(null) is false — no failure is not an unknown outcome", () => {
  assert.equal(isUnknownOutcome(null), false);
  assert.equal(isUnknownOutcome(undefined), false);
});
