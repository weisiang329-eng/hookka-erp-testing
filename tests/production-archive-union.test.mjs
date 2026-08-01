// Lock test for the includeArchive UNION column-mismatch fix (BUG-2026-06-24-009b).
//
// The bug: `(SELECT *, '' AS "archivedAt" FROM hot UNION ALL SELECT * FROM
// archive)` 500s because the archive tables drifted (missing columns the hot
// tables gained via runtime ALTER). The fix: a self-healing helper that brings
// the archive into column parity and emits an EXPLICIT, identically-ordered,
// quoted column list for both sides. These assertions lock the invariants so a
// future edit can't silently regress back to the fragile SELECT * UNION.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const helper = readFileSync("src/api/lib/archive-union.ts", "utf8");
// 2026-08-01: the UNION sites moved into _helpers.ts when the route was split,
// so reading only the route file went red - unnoticed, because this test was
// never registered in `npm test`. Read BOTH halves.
const route = [
  "src/api/routes/production-orders.ts",
  "src/api/routes/production-orders/_helpers.ts",
]
  .map((f) => readFileSync(f, "utf8"))
  .join(String.fromCharCode(10));

test("helper introspects, self-heals the archive, and is memoized", () => {
  assert.match(helper, /export async function archiveUnionSource/, "must export archiveUnionSource");
  assert.match(
    helper,
    /FROM information_schema\.columns/,
    "must introspect information_schema.columns to discover the real column set",
  );
  assert.match(
    helper,
    /ALTER TABLE \$\{archive\} ADD COLUMN IF NOT EXISTS/,
    "must self-heal: ADD COLUMN IF NOT EXISTS on the archive for missing hot columns",
  );
  assert.match(helper, /specCache/, "must memoize per (hot|archive) pair");
});

test("helper backfills org_id so pre-multi-tenant archive rows surface", () => {
  // Archive rows have NULL org_id → the org-scoped read filters them all out.
  // The helper must backfill (idempotent) to the default org.
  assert.match(helper, /UPDATE \$\{archive\} SET "org_id" = \? WHERE "org_id" IS NULL/);
  assert.match(helper, /DEFAULT_ORG_ID/, "must bind the default org id for the backfill");
});

test("helper emits an explicit quoted column list, not SELECT *", () => {
  // The whole point: no `SELECT *` in the emitted UNION.
  assert.doesNotMatch(
    helper.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""),
    /SELECT \*/,
    "the emitted UNION must use an explicit column list, never SELECT * (after stripping comments)",
  );
  assert.match(
    helper,
    /SELECT \$\{list\}, '' AS "archivedAt" FROM \$\{hot\}/,
    "hot side projects '' AS archivedAt with the explicit list",
  );
  assert.match(
    helper,
    /SELECT \$\{list\}, "archived_at" AS "archivedAt" FROM \$\{archive\}/,
    "archive side surfaces its native archived_at under the camelCase alias",
  );
});

test("helper mirrors the real column type (not blind TEXT) for UNION compatibility", () => {
  assert.match(helper, /function alterType/, "must derive the ALTER type from the hot column's data_type");
  assert.match(helper, /data_type/, "must read data_type during introspection");
});

test("both production-orders UNION sites route through the helper with a legacy fallback", () => {
  assert.match(route, /import \{[^}]*archiveUnionSource[^}]*\} from "[.\/]*lib\/archive-union"/);
  // po + jc, in each of fetchFilteredPOs and fetchPaginatedPOs → 2 calls each.
  const poCalls = route.match(/archiveUnionSource\(db, "production_orders", "production_orders_archive"\)/g) || [];
  const jcCalls = route.match(/archiveUnionSource\(db, "job_cards", "job_cards_archive"\)/g) || [];
  assert.equal(poCalls.length, 2, "both functions must build poSource via the helper");
  assert.equal(jcCalls.length, 2, "both functions must build jcSource via the helper");
  // Legacy literal kept as the ?? fallback (introspection failure → no regression).
  assert.match(route, /\)\) \?\?\s*`\(SELECT \*, '' AS "archivedAt" FROM production_orders/);
});
