// ---------------------------------------------------------------------------
// production-write-invalidation-class.test.mjs
//
// A CLASS test, not an instance test. This is the difference that matters.
//
// The dept sheets are served from two caches (a per-org KV body + the
// production_orders_list_snapshot cache-aside layer). Neither notices a write,
// so EVERY route that writes production_orders has to invalidate them. That
// rule was written down — PLAYBOOKS.md P5, "Fix all instances of the same
// class, not just the flagged one" — and then broken three times, because
// prose does not fail a build:
//
//   2026-06-06  scan completion left the dept sheet on the pre-scan status
//   2026-06-24  a PIC / completion-date edit stayed invisible for a full day
//   2026-07-22  an SO went ON_HOLD and the Fab Sew sheet showed no hold at all
//
// Each fix repaired the one file someone was looking at. Rather than add a
// fourth instance test, this enumerates the writers FROM DISK: any route file
// that writes production_orders must reference an invalidation helper. Add a
// new writer and this test fails until it is wired — which is the whole point.
//
// If a writer legitimately does not need to invalidate, add it to EXEMPT with
// the reason. Silence is not an option; an explicit exemption is.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROUTES = resolve(process.cwd(), "src/api/routes");
const WRITE = /UPDATE\s+production_orders|INSERT\s+INTO\s+production_orders|DELETE\s+FROM\s+production_orders/i;
const INVALIDATES = /invalidateProductionListCaches|invalidateProductionCachesAfterScan|invalidateOrderCascadeSnapshots|bumpPoListCacheVersion/;

// file -> why it is allowed to write without invalidating
const EXEMPT = {
  // Creates the POs for a brand-new SO/CO inside the same request that already
  // invalidates for its own cascade; the rows cannot be on a cached sheet yet.
};

function routeFiles() {
  return readdirSync(ROUTES)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ f, src: readFileSync(resolve(ROUTES, f), "utf8") }))
    .filter(({ src }) => WRITE.test(src));
}

test("every route that writes production_orders invalidates the dept-sheet caches", () => {
  const missing = [];
  for (const { f, src } of routeFiles()) {
    if (f in EXEMPT) continue;
    if (!INVALIDATES.test(src)) missing.push(f);
  }
  assert.deepEqual(
    missing,
    [],
    `These routes write production_orders but never invalidate the dept-sheet caches, so ` +
      `their change stays invisible to the shop floor until a TTL expires:\n  ` +
      missing.join("\n  ") +
      `\n\nCall invalidateProductionListCaches(c, orgId) from src/api/lib/po-list-cache.ts ` +
      `after the write commits (wrapped in try/catch — a failed wipe must not roll back the ` +
      `business write). If a writer genuinely does not need it, add it to EXEMPT with a reason.`,
  );
});

test("the invalidation helper wipes BOTH layers", () => {
  const lib = readFileSync(
    resolve(process.cwd(), "src/api/lib/po-list-cache.ts"),
    "utf8",
  );
  const body = lib.slice(lib.indexOf("export async function invalidateProductionListCaches"));
  assert.match(body, /bumpPoListCacheVersion\(c, orgId\)/, "must bump the KV version");
  assert.match(
    body,
    /DELETE FROM production_orders_list_snapshot WHERE org_id = \?/,
    "must DELETE the snapshot rows — marking them stale relies on a background " +
      "revalidation that has already been proven unreliable (2026-06-24).",
  );
});

test("the class is not empty — the enumeration is actually finding writers", () => {
  // Guards against a regex that silently stops matching and turns this whole
  // file into a no-op that passes forever.
  assert.ok(
    routeFiles().length >= 5,
    `Expected the sweep to find several production_orders writers, found ${routeFiles().length}. ` +
      `If the SQL was refactored (a helper, a query builder), update WRITE to match it — ` +
      `do not let this test pass by finding nothing.`,
  );
});
