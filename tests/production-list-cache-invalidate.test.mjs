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
  const start = SRC.indexOf("async function invalidateProductionListCaches");
  assert.ok(start >= 0, "invalidateProductionListCaches must exist");
  const body = SRC.slice(start, start + 700);
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
