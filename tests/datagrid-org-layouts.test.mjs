// ---------------------------------------------------------------------------
// datagrid-org-layouts.test.mjs — lock the org-wide DataGrid layout feature.
//
// Background: the DataGrid's "Save as Org Default" and the print preset ("Save
// as Production Schedule") used to write ONLY to the local browser's
// localStorage, so a different browser / consultant / user never saw them.
// They are now persisted to the backend (org-scoped) so any user on any
// browser loads them. The PERSONAL layout stays in localStorage.
//
// These are source assertions (same posture as security-route-coverage and
// sql-write-column-coverage) — they catch a refactor that quietly drops the
// org-scope / the SUPER_ADMIN gate / the FE wiring at the commit level, before
// the app is rebuilt. They do NOT exercise the live route.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const ROUTE = "src/api/routes/datagrid-layouts.ts";
const WORKER = "src/api/worker.ts";
const GRID = "src/components/ui/data-grid.tsx";

function read(path) {
  return readFileSync(path, "utf8");
}

// ---------------------------------------------------------------------------
// Backend route
// ---------------------------------------------------------------------------
test("backend: route file exists and defines a Hono app", () => {
  const src = read(ROUTE);
  assert.match(src, /new Hono</, "route should create a Hono app");
  assert.match(src, /export default app/, "route should default-export the app");
});

test("backend: GET handler exists and is org-scoped", () => {
  const src = read(ROUTE);
  assert.match(src, /app\.get\(\s*["'`]\//, "should register a GET handler");
  // Org scope: getOrgId(c) is read AND the GET query binds it.
  assert.match(src, /getOrgId\(c\)/, "GET must resolve the caller's org via getOrgId");
  assert.match(
    src,
    /SELECT[\s\S]*FROM datagrid_org_layouts[\s\S]*WHERE org_id = \?/,
    "GET must scope the SELECT by org_id",
  );
  // Returns the documented shape.
  assert.match(src, /orgDefault/, "GET response must include orgDefault");
  assert.match(src, /print/, "GET response must include print");
});

test("backend: PUT is requireSuperAdmin-gated and org-scoped upsert", () => {
  const src = read(ROUTE);
  assert.match(src, /app\.put\(\s*["'`]\//, "should register a PUT handler");
  // SUPER_ADMIN gate, called at the top of the PUT (before any write).
  assert.match(src, /requireSuperAdmin\(c\)/, "PUT must call requireSuperAdmin");
  const putIdx = src.indexOf("app.put(");
  const gateIdx = src.indexOf("requireSuperAdmin(c)", putIdx);
  const insertIdx = src.indexOf("INSERT INTO datagrid_org_layouts", putIdx);
  assert.ok(putIdx >= 0 && gateIdx >= 0 && insertIdx >= 0, "PUT, gate and INSERT must all be present");
  assert.ok(gateIdx < insertIdx, "the SUPER_ADMIN gate must run BEFORE the upsert write");
  // Org-scoped write + idempotent upsert on the unique (org,grid,kind) key.
  assert.match(src, /getOrgId\(c\)/, "PUT must resolve the org via getOrgId");
  assert.match(
    src,
    /ON CONFLICT\s*\(\s*org_id,\s*grid_id,\s*kind\s*\)\s*DO UPDATE/,
    "PUT must upsert on the (org_id, grid_id, kind) unique key",
  );
});

test("backend: DELETE (reset) is requireSuperAdmin-gated and org-scoped", () => {
  const src = read(ROUTE);
  assert.match(src, /app\.delete\(\s*["'`]\//, "should register a DELETE handler");
  const delIdx = src.indexOf("app.delete(");
  assert.ok(delIdx >= 0, "DELETE handler must exist");
  const gateIdx = src.indexOf("requireSuperAdmin(c)", delIdx);
  assert.ok(gateIdx >= 0, "DELETE must call requireSuperAdmin");
  assert.match(
    src,
    /DELETE FROM datagrid_org_layouts[\s\S]*WHERE org_id = \?[\s\S]*grid_id = \?[\s\S]*kind = \?/,
    "DELETE must scope by org_id + grid_id + kind",
  );
});

test("backend: table is created via a runtime lazy self-apply (CREATE TABLE IF NOT EXISTS)", () => {
  const src = read(ROUTE);
  assert.match(
    src,
    /CREATE TABLE IF NOT EXISTS datagrid_org_layouts/,
    "must self-apply the table at runtime (migration files are inert on prod)",
  );
  // Memoized module-level flight, awaited inside handlers.
  assert.match(src, /let pendingSchema/, "schema apply should be memoized at module level");
  assert.match(src, /await ensureLayoutSchema\(c\.var\.DB\)/, "handlers must await the schema apply");
  // snake_case columns only (no column-rename-map edits needed).
  assert.match(src, /org_id TEXT/, "columns must be snake_case (org_id)");
  assert.match(src, /grid_id TEXT/, "columns must be snake_case (grid_id)");
  assert.match(src, /visible_cols TEXT/, "columns must be snake_case (visible_cols)");
  assert.match(src, /col_order TEXT/, "columns must be snake_case (col_order)");
  assert.match(src, /col_widths TEXT/, "columns must be snake_case (col_widths)");
});

// ---------------------------------------------------------------------------
// Worker mount
// ---------------------------------------------------------------------------
test("worker: the route is imported and mounted at /api/datagrid-layouts", () => {
  const src = read(WORKER);
  assert.match(src, /import datagridLayouts from "\.\/routes\/datagrid-layouts"/, "must import the route");
  assert.match(
    src,
    /app\.route\(\s*["'`]\/api\/datagrid-layouts["'`]\s*,\s*datagridLayouts\s*\)/,
    "must mount the route at /api/datagrid-layouts",
  );
});

// ---------------------------------------------------------------------------
// Frontend DataGrid wiring
// ---------------------------------------------------------------------------
test("frontend: save functions PUT the org-wide preset to /api/datagrid-layouts", () => {
  const src = read(GRID);
  // The shared PUT helper targets the route and uses the PUT method.
  assert.match(
    src,
    /fetchJson\(\s*[`"']\/api\/datagrid-layouts[`"']\s*,[\s\S]*method:\s*["']PUT["']/,
    "the org-layout PUT helper must call PUT /api/datagrid-layouts",
  );
  // Both save functions route through putOrgLayout with the right kinds.
  assert.match(src, /putOrgLayout\(\s*gridId,\s*["']org-default["']/, "saveAsOrgDefault must publish kind 'org-default'");
  assert.match(src, /putOrgLayout\(\s*gridId,\s*["']print["']/, "saveAsPrintPreset must publish kind 'print'");
  // The org-default toast now advertises org-wide scope (not "this browser").
  assert.match(src, /every user on every browser/i, "org-default toast must say it is org-wide");
  assert.doesNotMatch(
    src,
    /new users on this browser will see this layout/,
    "the old browser-local toast text must be gone",
  );
});

test("frontend: a mount-effect GETs the org-wide presets for the grid", () => {
  const src = read(GRID);
  assert.match(
    src,
    /fetchJson\(\s*[`"']\/api\/datagrid-layouts\?gridId=/,
    "must GET /api/datagrid-layouts?gridId=... for the grid",
  );
  // Helper used by the mount-effect.
  assert.match(src, /fetchOrgLayouts\(/, "should expose a fetchOrgLayouts helper");
  assert.match(src, /orgHydratedRef/, "mount-effect should guard one hydration per (grid,user)");
  // Must not clobber a user's personal layout — only applies org-default when
  // the user has no personal localStorage layer.
  assert.match(src, /hasPersonal/, "mount-effect must check for a personal override before applying org-default");
});

test("frontend: personal layout still localStorage (resolution order preserved)", () => {
  const src = read(GRID);
  // Personal read keys still consulted first in the useState initializers.
  assert.match(
    src,
    /datagrid-cols-\$\{gridId\}-\$\{userKey\(\)\}/,
    "personal layout must still be keyed per-user in localStorage",
  );
  // Org-default cache mirror keys still used as the fallback layer.
  assert.match(
    src,
    /datagrid-cols-\$\{gridId\}-org-default/,
    "org-default localStorage cache mirror must remain for sync read paths",
  );
});

test("frontend: production print read honours the shared print preset", () => {
  const src = read("src/pages/production/index.tsx");
  // The print read still consults the print cache key first.
  assert.match(
    src,
    /datagrid-cols-\$\{gridId\}-print/,
    "production print read must consult the print preset cache key",
  );
  // And a prefetch effect hydrates that key from the backend for a cold print.
  assert.match(
    src,
    /\/api\/datagrid-layouts\?gridId=/,
    "production page must prefetch the org-wide print preset from the backend",
  );
});
