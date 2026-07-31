// ---------------------------------------------------------------------------
// production-scan-lookup.test.mjs — the targeted scan-lookup endpoint (perf
// 2026-07-31). The dept scan page used to download the whole ~22MB PO list to
// find the ONE order a worker just scanned; now it resolves the code (JC id /
// PO number / PO id) to a single order server-side. Structural pins: the
// endpoint exists, is registered BEFORE /:id, resolves all three code types,
// and the scan page calls it (its matching loop unchanged).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const route = readFileSync(resolve(process.cwd(), "src/api/routes/production-orders.ts"), "utf8");
const scan = readFileSync(resolve(process.cwd(), "src/pages/production/scan.tsx"), "utf8");

test("scan-lookup endpoint exists, RBAC-gated, registered before /:id", () => {
  assert.match(route, /app\.get\("\/scan-lookup"/);
  assert.match(route, /requirePermission\(c, "production-orders", "read"\)/);
  // must be registered BEFORE the /:id catch-all or Hono routes it as an id
  assert.ok(
    route.indexOf('app.get("/scan-lookup"') < route.indexOf('app.get("/:id"'),
    "scan-lookup must be registered before /:id",
  );
});

test("scan-lookup resolves a job-card id, then a PO number / PO id", () => {
  const f = route.replace(/\s+/g, " ");
  assert.match(f, /SELECT productionOrderId FROM job_cards WHERE id = \? LIMIT 1/);
  assert.match(f, /WHERE id = \? OR LOWER\(poNo\) = LOWER\(\?\) LIMIT 1/);
  // returns the ONE order in the list shape { data: [order] } via fetchPO
  assert.match(f, /const order = await fetchPO\(db, poId\)/);
  assert.match(f, /data: \[order\]/);
});

test("the scan page calls scan-lookup instead of the full list", () => {
  assert.match(scan, /\/api\/production-orders\/scan-lookup\?code=\$\{encodeURIComponent\(searchTerm\)\}/);
  // it no longer pulls the whole minimal list
  assert.doesNotMatch(
    scan,
    /fetchJson\(\s*"\/api\/production-orders\?fields=minimal&include=jobCards"/,
  );
});
