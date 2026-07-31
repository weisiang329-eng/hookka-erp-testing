// ---------------------------------------------------------------------------
// production-folder-rows.test.mjs — the dedicated folder /rows endpoint (perf
// 2026-07-31). folder-detail used to pull the whole ~22MB PO list just to
// filter it down to a folder's members; now GET /:id/rows returns only the POs
// this folder's job cards belong to, in the same minimal PO+jobCards shape.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const route = readFileSync(resolve(process.cwd(), "src/api/routes/production-folders.ts"), "utf8");
const page = readFileSync(resolve(process.cwd(), "src/pages/production/folder-detail.tsx"), "utf8");

test("folder /:id/rows endpoint exists, RBAC-gated, org-scoped", () => {
  assert.match(route, /app\.get\("\/:id\/rows"/);
  assert.match(route, /requirePermission\(c, "production-orders", "read"\)/);
  assert.match(route, /FROM production_folders WHERE id = \? AND org_id = \?/);
});

test("it resolves folder → job-card ids → distinct POs → batched build", () => {
  const f = route.replace(/\s+/g, " ");
  assert.match(f, /FROM folder_job_cards WHERE folder_id = \?/);
  assert.match(f, /SELECT DISTINCT productionOrderId FROM job_cards WHERE id IN/);
  // batched (no fetchPO-per-PO N+1): 3 IN-list queries + rowsToPOsBatch
  assert.match(f, /SELECT \* FROM production_orders WHERE id IN/);
  assert.match(f, /SELECT \* FROM job_cards WHERE productionOrderId IN/);
  assert.match(f, /const out = rowsToPOsBatch\(poRows, jcAll, picAll, leadTimeMap\)/);
  assert.doesNotMatch(f, /await fetchPO\(/);
  assert.match(route, /from "\.\/production-orders\/_helpers"/);
});

test("folder-detail calls /rows instead of the full PO matrix", () => {
  assert.match(page, /\/api\/production-folders\/\$\{encodeURIComponent\(folderId\)\}\/rows/);
  assert.doesNotMatch(page, /fetch\("\/api\/production-orders\?fields=minimal&include=jobCards"/);
});
