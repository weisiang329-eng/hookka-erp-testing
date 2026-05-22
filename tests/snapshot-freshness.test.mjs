// ---------------------------------------------------------------------------
// snapshot-freshness.test.mjs — unit tests for `isSnapshotFresh`.
//
// NOTE on file naming: the task brief points at "src/lib/snapshot-freshness.ts"
// for `isSnapshotFresh`. In the actual tree the freshness comparison helper
// `isSnapshotFresh` is NOT in src/api/lib/snapshot-freshness.ts (that file
// only holds the DB-dependent `getMaxSourceUpdatedAt` schema probe, which is
// async + needs a D1Database — not unit-testable as a pure function).
//
// `isSnapshotFresh` is the pure comparison function, defined identically in
// four places (snapshot.ts, dashboard-snapshot.ts, invoice-snapshot.ts, and
// re-exported from delivery-snapshot.ts). We test the canonical copy in the
// GENERIC helper `src/api/lib/snapshot.ts` — the library every snapshot-ized
// endpoint is meant to converge on.
//
// Comparison rule (from the module comment):
//   • null snapshot   -> never fresh  (cold cache, caller must compute)
//   • null currentMax -> trivially fresh (every source table empty)
//   • otherwise       -> fresh iff snapshot.builtFrom >= currentMax,
//                        compared lexicographically (ISO-8601 datetimes
//                        sort as numeric time when the format is uniform).
//
// We test fresh / stale / missing, the boundary (builtFrom == currentMax),
// and the lexicographic-compare assumption on ISO strings.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let loaderRegistered = false;
try {
  register("tsx/esm", pathToFileURL("./"));
  loaderRegistered = true;
} catch {
  // Native type-stripping handles it on Node 22+.
}

let snapshot;
try {
  snapshot = await import(
    pathToFileURL(resolve(process.cwd(), "src/api/lib/snapshot.ts")).href
  );
} catch (err) {
  console.warn(
    "[snapshot-freshness.test] Could not import snapshot module. " +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn("[snapshot-freshness.test] Error:", err?.message ?? err);
  throw err;
}

const { isSnapshotFresh } = snapshot;

// Build a SnapshotRow with a given builtFrom; other fields are irrelevant
// to the freshness comparison.
function snap(builtFrom) {
  return {
    data: {},
    builtFrom,
    builtAt: "2026-05-21T00:00:00.000Z",
    refreshCount: 1,
  };
}

// ---------------------------------------------------------------------------
// Missing snapshot — cold cache.
// ---------------------------------------------------------------------------
test("isSnapshotFresh: null snapshot is never fresh (cold cache)", () => {
  assert.equal(isSnapshotFresh(null, "2026-05-21T10:00:00.000Z"), false);
});

test("isSnapshotFresh: null snapshot is not fresh even when currentMax is also null", () => {
  // No cached row at all — caller must compute regardless.
  assert.equal(isSnapshotFresh(null, null), false);
});

// ---------------------------------------------------------------------------
// null currentMax — every source table empty -> trivially fresh.
// ---------------------------------------------------------------------------
test("isSnapshotFresh: null currentMax with a snapshot present -> trivially fresh", () => {
  assert.equal(isSnapshotFresh(snap("2026-01-01T00:00:00.000Z"), null), true);
});

// ---------------------------------------------------------------------------
// Fresh — builtFrom strictly after currentMax.
// ---------------------------------------------------------------------------
test("isSnapshotFresh: builtFrom after currentMax -> fresh", () => {
  assert.equal(
    isSnapshotFresh(
      snap("2026-05-21T12:00:00.000Z"),
      "2026-05-21T10:00:00.000Z",
    ),
    true,
  );
});

test("isSnapshotFresh: builtFrom a full day after currentMax -> fresh", () => {
  assert.equal(
    isSnapshotFresh(
      snap("2026-05-22T00:00:00.000Z"),
      "2026-05-21T23:59:59.999Z",
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// Boundary — builtFrom exactly equal to currentMax. The rule is `>=`, so an
// exact tie counts as FRESH (the snapshot was built from precisely the
// latest source state).
// ---------------------------------------------------------------------------
test("isSnapshotFresh: builtFrom == currentMax -> fresh (>= boundary)", () => {
  assert.equal(
    isSnapshotFresh(
      snap("2026-05-21T10:00:00.000Z"),
      "2026-05-21T10:00:00.000Z",
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// Stale — a source table changed after the snapshot was built.
// ---------------------------------------------------------------------------
test("isSnapshotFresh: builtFrom before currentMax -> stale", () => {
  assert.equal(
    isSnapshotFresh(
      snap("2026-05-21T08:00:00.000Z"),
      "2026-05-21T10:00:00.000Z",
    ),
    false,
  );
});

test("isSnapshotFresh: builtFrom one millisecond before currentMax -> stale", () => {
  assert.equal(
    isSnapshotFresh(
      snap("2026-05-21T10:00:00.000Z"),
      "2026-05-21T10:00:00.001Z",
    ),
    false,
  );
});

test("isSnapshotFresh: snapshot from last month vs a today source bump -> stale", () => {
  assert.equal(
    isSnapshotFresh(
      snap("2026-04-01T00:00:00.000Z"),
      "2026-05-21T00:00:00.000Z",
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// Lexicographic-compare assumption — ISO-8601 datetimes sort as time order
// only because the format is uniform (zero-padded, same precision). These
// confirm the string compare doesn't misorder across day / month / year
// rollovers.
// ---------------------------------------------------------------------------
test("isSnapshotFresh: lexicographic compare orders across a year boundary", () => {
  // "2026-..." > "2025-..." as strings AND as time. Fresh.
  assert.equal(
    isSnapshotFresh(
      snap("2026-01-01T00:00:00.000Z"),
      "2025-12-31T23:59:59.999Z",
    ),
    true,
  );
  // Reverse — 2025 snapshot vs 2026 source bump -> stale.
  assert.equal(
    isSnapshotFresh(
      snap("2025-12-31T23:59:59.999Z"),
      "2026-01-01T00:00:00.000Z",
    ),
    false,
  );
});

test("isSnapshotFresh: zero-padded months compare correctly (09 vs 10)", () => {
  // String compare: "2026-10-01" > "2026-09-30" — correct because months
  // are zero-padded. A naive non-padded format would break here.
  assert.equal(
    isSnapshotFresh(
      snap("2026-10-01T00:00:00.000Z"),
      "2026-09-30T00:00:00.000Z",
    ),
    true,
  );
});

test("isSnapshotFresh: identical timestamps differing only in trailing precision", () => {
  // Both helpers in the codebase write toISOString() (always 3-digit ms),
  // so formats are uniform. An exact-equal string is fresh.
  const ts = "2026-05-21T10:30:00.000Z";
  assert.equal(isSnapshotFresh(snap(ts), ts), true);
});
