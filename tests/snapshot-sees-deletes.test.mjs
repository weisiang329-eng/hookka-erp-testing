// ---------------------------------------------------------------------------
// snapshot-sees-deletes.test.mjs
//
// A deleted row kept coming back. Owner 2026-08-02, on the Sales Orders page:
// 「为什么我明明 delete 掉了，却还能看到？而且我在 delete 的时候，它确实显示这个
// 东西已经不在了」— and reports the same happening to Production Orders before.
//
// Measured on production at the time of the report:
//     sales_orders DRAFT rows in the database   = 0   (the delete worked)
//     GET /api/sales-orders                     = both deleted drafts present
//     GET /api/sales-orders/stats  byStatus     = { DRAFT: 2 }
//     sales_orders MAX(updated_at)              = 2026-08-01T08:48:36Z
//     snapshot     built_from                   = 2026-08-01T12:xx  (newer)
//
// The cause is structural, not a bad write. Snapshot freshness was
// `built_from >= MAX(updated_at)` across the source tables, and A DELETE CAN
// NEVER RAISE A MAXIMUM. Removing rows leaves MAX unchanged (or lowers it), so
// the comparison says "still fresh" forever and the snapshot holding the
// deleted row is served until some unrelated edit happens to bump a timestamp.
// Every one of the 31 snapshot tables had the same blind spot.
//
// The fix adds COUNT(*) to the signature: a delete moves the count, an insert
// moves both, an update moves MAX.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping handles the .ts import */
}

const { isSnapshotFresh } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/snapshot.ts")).href
);

const snap = (builtFrom, sourceRows) => ({
  data: {},
  builtFrom,
  builtAt: builtFrom,
  refreshCount: 1,
  sourceRows,
});

const T0 = "2026-08-01T12:00:00.000Z";
const EARLIER = "2026-08-01T08:48:36.000Z";

test("THE BUG: a delete used to be invisible — now it is not", () => {
  // Exactly the production numbers. built_from is NEWER than MAX(updated_at)
  // because the last edit predates the last rebuild, which is the normal
  // steady state. Two rows then get deleted: 1191 → 1189.
  assert.equal(
    isSnapshotFresh(snap(T0, 1191), EARLIER, 1191),
    true,
    "nothing changed — must stay fresh",
  );
  assert.equal(
    isSnapshotFresh(snap(T0, 1191), EARLIER, 1189),
    false,
    "two rows were deleted and MAX(updated_at) did not move — MUST be stale",
  );
});

test("without the count, the same case reports fresh — that WAS the bug", () => {
  // Passing no count reproduces the old behaviour, which is why this is worth
  // stating out loud rather than only asserting the fix.
  assert.equal(isSnapshotFresh(snap(T0, 1191), EARLIER), true);
});

test("an insert is caught by either signal", () => {
  assert.equal(isSnapshotFresh(snap(T0, 1191), EARLIER, 1192), false, "count moved");
  assert.equal(
    isSnapshotFresh(snap(T0, 1191), "2026-08-02T09:00:00.000Z", 1191),
    false,
    "timestamp moved",
  );
});

test("delete-then-insert in the same instant is still caught, by MAX", () => {
  // The count comes back to where it was, but the new row's timestamp is new.
  assert.equal(
    isSnapshotFresh(snap(T0, 1191), "2026-08-02T09:00:00.000Z", 1191),
    false,
  );
});

test("rows written before the column existed rebuild exactly once", () => {
  // Every snapshot row in production has source_rows NULL today. Treating that
  // as stale is what makes the fix self-healing on deploy — no backfill, no
  // manual wipe. After the rebuild it carries a count and behaves normally.
  assert.equal(isSnapshotFresh(snap(T0, null), EARLIER, 1191), false);
  assert.equal(isSnapshotFresh(snap(T0, 1191), EARLIER, 1191), true);
});

test("an uncountable source set falls back to the old rule, not to chaos", () => {
  // getSourceSignature returns rowCount null when no source table could be
  // counted. That must degrade to the previous behaviour, never to "always
  // stale" (which would recompute on every request).
  assert.equal(isSnapshotFresh(snap(T0, 1191), EARLIER, null), true);
  assert.equal(isSnapshotFresh(snap(T0, 1191), "2026-08-02T09:00:00.000Z", null), false);
});

test("a cold snapshot is still never fresh", () => {
  assert.equal(isSnapshotFresh(null, EARLIER, 1191), false);
});

// --- wiring -----------------------------------------------------------------

const SNAP = readFileSync("src/api/lib/snapshot.ts", "utf8");
const FRESH = readFileSync("src/api/lib/snapshot-freshness.ts", "utf8");

test("the count and the timestamp come back in ONE round trip", () => {
  // The probe already made a UNION ALL trip per source set; folding COUNT(*)
  // into the same aggregate costs no extra latency.
  assert.match(
    FRESH,
    /SELECT MAX\(\$\{col\}\)::text AS t, COUNT\(\*\)::bigint AS n FROM \$\{table\}/,
  );
});

test("source_rows reaches production by runtime ALTER, not a migration", () => {
  // Migrations are inert on deploy in this repo. A missing column here would
  // throw inside the snapshot write, which is caught and warned — so the
  // symptom would be "the fix silently does nothing".
  assert.match(
    SNAP,
    /ALTER TABLE \$\{tableName\} ADD COLUMN IF NOT EXISTS source_rows BIGINT/,
  );
  assert.match(SNAP, /await ensureSourceRowsColumn\(db, config\.tableName\)/);
});

test("the count is read back, compared, and written on every rebuild", () => {
  assert.match(SNAP, /source_rows AS "sourceRows"/, "read");
  assert.match(SNAP, /isSnapshotFresh\(snap, currentMax, sourceRows\)/, "compare");
  assert.match(SNAP, /source_rows = EXCLUDED\.source_rows/, "write");
});
