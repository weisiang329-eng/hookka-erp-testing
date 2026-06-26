// ---------------------------------------------------------------------------
// production-bulk-patch-readback-reread.test.mjs — locks the cache-bypassed
// re-read that makes the /bulk-patch verify-readback robust to a cross-
// connection read-after-write race (BUG-2026-06-26-001).
//
// Root cause (recap): /bulk-patch writes each job card via a LOOPBACK fetch()
// PATCH to /:id (applyPoUpdate), which runs as a SEPARATE Worker subrequest on
// its OWN DB connection. After the loopback loop resolves, /bulk-patch verifies
// the write with a SELECT that runs on the OUTER request's connection. Hyperdrive
// caches simple parameterized SELECTs at the proxy, so the outer read can be
// served a STALE pre-write snapshot of the row — even though the loopback PATCH
// already committed. Symptom: setting the SECOND PIC on a card ("PIC1 ok, then
// PIC2") spuriously reverts with `pic2Id: tried "...", db has null`, and clicking
// again works (nondeterministic cache race, NOT a write bug — PIC1/PIC2 use the
// exact same write + readback code path and the same pic1_id/pic2_id rename-map
// entries).
//
// Fix: on a first-pass mismatch, do ONE re-read of only the mismatched rows via
// db.batch([...]) — db.batch wraps the statement in sql.begin (an explicit
// transaction), which Hyperdrive does NOT cache, forcing the re-read back to the
// primary. Only rows that STILL mismatch after the fresh read are flipped to
// failure, so a genuine unpersisted write surfaces exactly as before.
//
// Source-level structural test (no DB / no worker runtime), matching the pattern
// of production-fresh-po-direct-db.test.mjs + production-orders-dept-narrow-
// guard.test.mjs. These invariants are subtle and easy to silently regress in a
// future "perf" / "cleanup" PR, so pin them in CI.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(process.cwd(), "src/api/routes/production-orders.ts");
const COMPAT = resolve(process.cwd(), "src/api/lib/supabase-compat.ts");

function read(p) {
  return readFileSync(p, "utf8");
}

// Isolate the /bulk-patch handler body so the assertions only inspect that
// route, not the rest of the 7k-line file. The handler starts at the
// `app.post("/bulk-patch", ...)` mount and ends at the next top-level
// `app.put("/:id"` mount that immediately follows it.
function extractBulkPatch(src) {
  const start = src.indexOf('app.post("/bulk-patch"');
  if (start < 0) return null;
  const end = src.indexOf('app.put("/:id"', start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

// ---------------------------------------------------------------------------
// 1. The /bulk-patch handler still exists (anchor for everything below).
// ---------------------------------------------------------------------------
test("bulk-patch handler exists", () => {
  const h = extractBulkPatch(read(SRC));
  assert.ok(
    h,
    'Could not find app.post("/bulk-patch" in production-orders.ts. If it was ' +
      "renamed/moved, update this test — but the re-read invariants below must still hold.",
  );
});

// ---------------------------------------------------------------------------
// 2. The verify-readback must NOT fail a row on the FIRST mismatch alone.
//    It must collect mismatches and re-read before declaring failure, so a
//    stale cached read can't spuriously revert a persisted PIC2 write.
// ---------------------------------------------------------------------------
test("verify-readback collects mismatches and re-reads (no fail-on-first-mismatch)", () => {
  const h = extractBulkPatch(read(SRC));
  assert.ok(h, "handler missing — see previous test");

  // The mismatched-rows accumulator must exist.
  assert.match(
    h,
    /const\s+mismatched\s*[:=]/,
    "Expected a `mismatched` accumulator — the first pass must DEFER the verdict " +
      "and collect mismatched rows for a cache-bypassed re-read, not fail immediately.",
  );

  // There must be a SECOND, cache-bypassing read via db.batch (sql.begin →
  // Hyperdrive does not cache transactional reads). A plain .prepare().all()
  // re-read would hit the same cache and not fix the race.
  assert.match(
    h,
    /\.batch\s*[<(]/,
    "Expected a db.batch([...]) re-read — the retry SELECT must run inside an " +
      "explicit transaction so Hyperdrive bypasses its read query cache.",
  );

  // The re-read must be gated on there being mismatches (don't pay for it on
  // the happy path).
  assert.match(
    h,
    /if\s*\(\s*mismatched\.length\s*>\s*0\s*\)/,
    "The cache-bypassed re-read must only run when mismatched.length > 0.",
  );
});

// ---------------------------------------------------------------------------
// 3. The mismatch error string is only emitted AFTER the re-read confirms it,
//    not from the first pass. Guard against a regression that flips success
//    to false in the first loop again.
// ---------------------------------------------------------------------------
test("verify-readback mismatch failure comes after the re-read", () => {
  const h = extractBulkPatch(read(SRC));
  assert.ok(h, "handler missing — see previous test");

  const reReadAt = h.search(/if\s*\(\s*mismatched\.length\s*>\s*0\s*\)/);
  // Use lastIndexOf to find the ACTUAL error emission (a template literal),
  // not the explanatory comment that mentions the same string earlier in the
  // readback-column docstring.
  const mismatchErrAt = h.lastIndexOf("verify-readback mismatch —");
  assert.ok(reReadAt >= 0, "re-read guard not found");
  assert.ok(mismatchErrAt >= 0, "mismatch error string not found");
  assert.ok(
    mismatchErrAt > reReadAt,
    'The "verify-readback mismatch —" failure must be emitted INSIDE the ' +
      "re-read block (after the cache-bypassed re-read), not in the first pass.",
  );
});

// ---------------------------------------------------------------------------
// 4. PIC1 and PIC2 are symmetric on both write + readback (sanity guard) —
//    the bug was NEVER a pic2-specific write/rename issue; both columns are
//    in the same rename map and the same readback SELECT.
// ---------------------------------------------------------------------------
test("pic1Id and pic2Id are both in the readback SELECT (symmetric)", () => {
  const h = extractBulkPatch(read(SRC));
  assert.ok(h, "handler missing — see previous test");
  // Both columns appear in the readback column list (and the re-read uses the
  // same list).
  const pic1Count = (h.match(/pic1Id/g) ?? []).length;
  const pic2Count = (h.match(/pic2Id/g) ?? []).length;
  assert.ok(pic1Count >= 1, "pic1Id must be in the readback SELECT");
  assert.ok(pic2Count >= 1, "pic2Id must be in the readback SELECT");
});

// ---------------------------------------------------------------------------
// 5. db.batch genuinely opens a transaction (sql.begin) — the property the
//    fix relies on for Hyperdrive cache bypass. If the adapter ever stops
//    using sql.begin for batch(), the re-read would silently go back through
//    the cache and the race would return.
// ---------------------------------------------------------------------------
test("SupabaseAdapter.batch uses sql.begin (transactional → cache-bypassed)", () => {
  const compat = read(COMPAT);
  // Find the batch method and assert it opens a transaction.
  const batchAt = compat.indexOf("async batch");
  assert.ok(batchAt >= 0, "SupabaseAdapter.batch method not found");
  const batchBody = compat.slice(batchAt, batchAt + 800);
  assert.match(
    batchBody,
    /this\.sql\.begin\s*\(/,
    "SupabaseAdapter.batch must call sql.begin(...) — the bulk-patch re-read " +
      "relies on the transaction to bypass Hyperdrive's read query cache.",
  );
});
