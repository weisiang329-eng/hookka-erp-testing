// ---------------------------------------------------------------------------
// houzs-sweep-hardening.test.mjs — the four smaller findings from reading
// Houzs-ERP's COEs and recent fixes against this codebase.
//
//   1. transient DB failures answered 500 with the raw driver message
//   2. lorry plates had neither a comparison form nor any uniqueness
//   3. migration 0178 declared a table production does not actually have
//   4. the prod→staging cloner could wipe production
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isTransientDbError } from "../src/api/lib/supabase-compat.ts";
import { normalizePlate, findPlateCollisions } from "../src/lib/plate-no.ts";

// --- 1. transient DB errors -------------------------------------------------

test("the database being briefly unreachable is not a 500", () => {
  for (const m of [
    "Timed out while creating a new server connection",
    "remaining connection slots are reserved for non-replication superuser connections",
    "sorry, too many clients already",
    "Connection terminated unexpectedly",
    "socket hang up",
    "terminating connection due to administrator command",
  ]) {
    assert.ok(isTransientDbError(new Error(m)), m);
  }
  const byCode = Object.assign(new Error("x"), { code: "53300" });
  assert.ok(isTransientDbError(byCode));
});

test("a real bug is still a 500", () => {
  for (const m of [
    'column "reportsto" does not exist',
    "duplicate key value violates unique constraint",
    "Cannot read properties of undefined",
  ]) {
    assert.ok(!isTransientDbError(new Error(m)), m);
  }
});

test("the RETRY matcher stays narrow — a mid-statement drop is never re-run", () => {
  // isTransientDbError decides the STATUS CODE. Retrying is a different, much
  // more dangerous decision: re-running an INSERT that may already have applied
  // is a silent double-write. Houzs' set includes these; ours must not.
  const compat = readFileSync("src/api/lib/supabase-compat.ts", "utf8");
  const createRe = compat.match(/const CONN_CREATE_RE =\s*(\/.*\/i)/)?.[1] ?? "";
  assert.ok(createRe, "CONN_CREATE_RE must still exist");
  for (const unsafe of ["connection terminated", "socket hang up", "fetch failed"]) {
    assert.ok(
      !createRe.toLowerCase().includes(unsafe),
      `${unsafe} can fire MID-statement — retrying it is a double-write`,
    );
  }
  // Pool exhaustion at CONNECT time is the same class as a connect timeout.
  assert.match(createRe, /remaining connection slots/);
  assert.match(createRe, /too many clients/);
});

test("the raw driver message no longer travels to a browser", () => {
  const worker = readFileSync("src/api/worker.ts", "utf8");
  // pg-ping already refuses to echo these "because they can leak schema /
  // table names"; onError was doing it for every route in the app.
  assert.doesNotMatch(
    worker,
    /error: err instanceof Error \? err\.message : String\(err\),\n\s*\},\n\s*500,/,
    "the global handler must not return the driver message",
  );
  assert.match(worker, /transient: true/);
  assert.match(worker, /"Retry-After": "2"/);
  // The real message must still be recoverable — logged in full, with a handle
  // the operator can quote.
  assert.match(worker, /console\.error\(`\[onError \$\{ref\}\]/);
  assert.match(worker, /ref,/);
});

// --- 2. plates --------------------------------------------------------------

test("one truck is one truck however it was typed", () => {
  assert.equal(normalizePlate("AKF 8100"), "AKF8100");
  assert.equal(normalizePlate("akf-8100"), "AKF8100");
  assert.equal(normalizePlate(" W 1234 A "), "W1234A");
  assert.equal(normalizePlate(null), "");
});

test("collisions are grouped, blanks are not", () => {
  const groups = findPlateCollisions([
    { id: "v1", plateNo: "AKF 8100" },
    { id: "v2", plateNo: "akf-8100" },
    { id: "v3", plateNo: "WXY 1" },
    { id: "v4", plateNo: "" },
    { id: "v5", plateNo: null },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].normalized, "AKF8100");
  assert.deepEqual(groups[0].rows.map((r) => r.id), ["v1", "v2"]);
});

test("the plate column keeps what the operator typed", () => {
  const route = readFileSync("src/api/routes/three-pl-vehicles.ts", "utf8");
  // A DO that prints "AKF8100" when the lorry says "AKF 8100" is a regression
  // on paperwork a driver actually reads. Match on plate_norm, display plateNo.
  assert.match(route, /ADD COLUMN IF NOT EXISTS plate_norm TEXT/);
  assert.match(route, /idx_three_pl_vehicles_plate_norm/);
  assert.doesNotMatch(
    route,
    /CREATE UNIQUE INDEX[^"]*plate_norm/,
    "production already contains collisions — a unique index would fail or start rejecting saves before anyone decided which duplicate wins",
  );
  // New duplicates blocked; existing ones reported, not silently merged.
  assert.match(route, /already exists\.`,\s*\},\s*409,/);
  assert.match(route, /app\.get\("\/collisions"/);
  // Renaming a plate must move its comparison form with it.
  assert.match(route, /normalizePlate\(merged\.plateNo\)/);
});

// --- 3. migration 0178 ------------------------------------------------------

test("migration 0178 declares the table production actually has", () => {
  const sql = readFileSync(
    "migrations-postgres/0178_catchup_runtime_tables.sql",
    "utf8",
  );
  const block = sql.slice(
    sql.indexOf("CREATE TABLE IF NOT EXISTS supplier_scan_samples"),
    sql.indexOf(");", sql.indexOf("CREATE TABLE IF NOT EXISTS supplier_scan_samples")),
  );
  // Production is MIXED: map keys became snake_case, everything else folded.
  for (const mapped of ["org_id", "supplier_id", "corrected_json", "is_gold", "created_by", "created_at"]) {
    assert.match(block, new RegExp(`\\b${mapped}\\b`), mapped);
  }
  for (const folded of ["supplierhint", "docidentifier", "doctype", "rawjson"]) {
    assert.match(block, new RegExp(`\\b${folded}\\b`), folded);
  }
  assert.doesNotMatch(block, /supplierHint|docIdentifier|docType|rawJson|orgId/);
});

test("the assets dir is pinned to what _headers and the 404 Function assume", () => {
  const vite = readFileSync("vite.config.ts", "utf8");
  assert.match(vite, /assetsDir: "assets"/);
});

// --- 4. the cloner ----------------------------------------------------------

test("the prod-to-staging cloner cannot wipe production", () => {
  const src = readFileSync("scripts/clone-prod-to-staging.mjs", "utf8");
  // The credential is out of git and the two URLs are no longer adjacent
  // literals a copy/paste can swap.
  assert.doesNotMatch(src, /postgresql:\/\/postgres:[A-Za-z0-9]+@/);
  assert.match(src, /process\.env\.CLONE_SOURCE_URL/);
  assert.match(src, /process\.env\.CLONE_TARGET_URL/);
  // Fails closed: unknown host refused, prod host refused by name.
  assert.match(src, /TARGET_ALLOWLIST/);
  assert.match(src, /is the PRODUCTION database/);
  assert.match(src, /not in the target allow-list/);
  // Dry run is the DEFAULT, and a real run must name the target back — so the
  // destructive path is not reachable from shell history.
  assert.match(src, /const dryRun = !confirmed;/);
  assert.match(src, /argv\[confirmIdx \+ 1\] === targetHost/);
});
