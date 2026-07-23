// ---------------------------------------------------------------------------
// production-list-cache-invalidate.test.mjs
//
// Lock test for the 2026-06-24 "WOOD_CUT invisible" incident.
//
// Symptom: a dept-grid cell edit with NO PO-status change (a PIC assignment or
// a completion-date set) was written to job_cards (proven via ?fresh=1 reads)
// but stayed INVISIBLE on the operator grid for a full day across many
// refreshes — SO-2606-160/161/152 WOOD_CUT showed COMPLETED + a PIC in the DB
// yet the grid showed WAITING / blank.
//
// Root cause: invalidateProductionListCaches only MARKED the
// production_orders_list_snapshot stale (built_from = epoch) and relied on the
// serve-stale-while-revalidate read path to recompute in the background. That
// background revalidation did NOT reliably rewrite the snapshot, so the read
// kept serving the stale copy AND re-cached it into the 60s KV layer.
//
// Fix: DELETE the snapshot rows on every production write so the next read does
// a COLD recompute and returns FRESH data, regardless of the flaky probe /
// revalidation. Pinned here because it is an easy "perf optimization" to revert.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/routes/production-orders.ts"),
  "utf8",
);

test("invalidateProductionListCaches DELETEs the snapshot (not mark-stale)", () => {
  // 2026-07-23: the helper moved to src/api/lib/po-list-cache.ts so all six
  // route modules that write production_orders share one implementation.
  const LIB = readFileSync(
    resolve(process.cwd(), "src/api/lib/po-list-cache.ts"),
    "utf8",
  );
  const start = LIB.indexOf("export async function invalidateProductionListCaches");
  assert.ok(start >= 0, "invalidateProductionListCaches must exist");
  const body = LIB.slice(start, start + 700);
  assert.match(
    body,
    /DELETE FROM production_orders_list_snapshot WHERE org_id = \?/,
    "Must DELETE the snapshot rows so the next read cold-recomputes FRESH. The " +
      "old mark-stale (built_from=epoch) relied on a flaky background revalidation " +
      "that left dept-cell edits invisible for a day (2026-06-24 WOOD_CUT incident).",
  );
  assert.doesNotMatch(
    body,
    /built_from = '1970-01-01/,
    "Must NOT revert to marking the snapshot stale (built_from=epoch).",
  );
  assert.match(
    body,
    /bumpPoListCacheVersion\(c, orgId\)/,
    "Must also bump the 60s KV list-cache version.",
  );
});

// ---------------------------------------------------------------------------
// 2026-07-22 — the same class of bug, one module over.
//
// SO-2607-120 went ON_HOLD at 14:22:26Z and cascadeSOStatusToPOs flipped all 6
// downstream production_orders to ON_HOLD in the same batch. The Fab Sew sheet
// still rendered 11 plain PENDING rows: its snapshot had been built at 06:19Z
// and NOTHING in sales-orders.ts invalidated it. The owner read that as "the
// hold didn't run in the backend".
//
// The SO/CO status cascade writes production_orders.status from OUTSIDE
// production-orders.ts, so it must invalidate both dept-sheet layers itself:
// the snapshot rows AND the KV body version. Wiping only one leaves the other
// serving the pre-hold rows (snapshot only → warm KV body keeps X-Cache: HIT
// for its 5-minute TTL; KV only → the snapshot re-serves stale, the 2026-06-24
// WOOD_CUT incident above).
// ---------------------------------------------------------------------------
const CASCADE_SOURCES = [
  ["src/api/routes/sales-orders.ts", "sales", "cascade && cascade.affectedPoCount > 0"],
  ["src/api/routes/consignment-orders.ts", "consignment", "cascadedPoCount > 0"],
];

for (const [file, kind, gate] of CASCADE_SOURCES) {
  test(`${kind} status cascade (ON_HOLD / CANCELLED / RESUME) invalidates both dept-sheet cache layers`, () => {
    const src = readFileSync(resolve(process.cwd(), file), "utf8");
    assert.match(
      src,
      new RegExp(`invalidateOrderCascadeSnapshots\\(c\\.var\\.DB, orgId, "${kind}"\\)`),
      `${file} must wipe the snapshot rows after a status cascade — the freshness ` +
        `probe is documented as unreliable, so a hold stayed invisible on the ` +
        `Fab Sew sheet (SO-2607-120, 2026-07-22).`,
    );
    assert.match(
      src,
      /bumpPoListCacheVersion\(c, orgId\)/,
      `${file} must ALSO bump the KV list-cache version — wiping only the snapshot ` +
        `leaves a warm KV body serving the pre-hold rows for the rest of its TTL.`,
    );
    assert.ok(
      src.includes(gate),
      `${file} must gate the invalidation on the cascade actually touching POs ` +
        `(\`${gate}\`) so an ordinary field edit pays nothing.`,
    );
  });
}

test("po-list-cache lib stays the single home of the KV version key", () => {
  const lib = readFileSync(
    resolve(process.cwd(), "src/api/lib/po-list-cache.ts"),
    "utf8",
  );
  assert.match(lib, /export async function bumpPoListCacheVersion/);
  assert.match(lib, /pos:version:\$\{orgId\}/);
  // production-orders.ts must import it, not redeclare a second copy that
  // could drift from the key format the read path uses.
  assert.doesNotMatch(
    SRC,
    /async function bumpPoListCacheVersion/,
    "production-orders.ts must import bumpPoListCacheVersion from ../lib/po-list-cache " +
      "rather than keeping a private duplicate.",
  );
  assert.match(SRC, /from "\.\.\/lib\/po-list-cache"/);
});

test("applyPoUpdate invalidates the production list caches on every edit", () => {
  const start = SRC.indexOf("async function applyPoUpdate");
  assert.ok(start >= 0, "applyPoUpdate must exist");
  const after = SRC.slice(start + 1);
  const end = after.search(/\n(?:async )?function /);
  const body = end < 0 ? after : after.slice(0, end);
  assert.match(
    body,
    /invalidateProductionListCaches\(c, orgId\)/,
    "applyPoUpdate (the single-PATCH write path, also reused by the bulk-patch " +
      "loopback) must call invalidateProductionListCaches so a PIC / completion " +
      "edit refreshes the grid cache.",
  );
});
