// ---------------------------------------------------------------------------
// sales-leads.test.mjs — pins the CRM pipeline slice (owner 2026-07-30): a
// pre-sale leads funnel (NEW → … → WON/LOST) + a board page. Structural pins;
// live UX verified on staging.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync(new URL("../src/api/routes/sales-leads.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/api/worker.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/pages/leads/index.tsx", import.meta.url), "utf8");
const routes = readFileSync(new URL("../src/dashboard-routes.tsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../src/components/layout/sidebar.tsx", import.meta.url), "utf8");

test("leads route: stages, RBAC-gated, tenant-scoped, runtime table + stage move", () => {
  assert.match(route, /LEAD_STAGES = \[[^\]]*"WON"[^\]]*"LOST"/, "funnel defines WON + LOST terminals");
  assert.match(route, /requirePermission\(c, "customers", "read"\)/);
  assert.match(route, /requirePermission\(c, "customers", "update"\)/);
  assert.match(route, /getOrgId\(c\)/, "tenant-scoped");
  assert.match(route, /CREATE TABLE IF NOT EXISTS sales_leads/);
  assert.match(route, /"\/:id\/stage"/, "must expose a stage-move endpoint");
  assert.match(route, /stage === "LOST"[\s\S]{0,120}?lost_?[Rr]eason/, "LOST captures a reason");
});

test("route mounted in worker", () => {
  assert.match(worker, /import salesLeads from "\.\/routes\/sales-leads"/);
  assert.match(worker, /app\.route\("\/api\/sales-leads", salesLeads\)/);
});

test("pipeline board page: columns by stage + routed + in the sidebar", () => {
  assert.match(page, /export default function LeadsPage/);
  assert.match(page, /\/api\/sales-leads/);
  assert.match(page, /const STAGES = \[/, "renders columns per stage");
  assert.match(routes, /path: '\/leads'/, "route registered");
  assert.match(routes, /const Leads = lazy/, "lazy-loaded");
  assert.match(sidebar, /name: "Sales Pipeline", href: "\/leads"/, "nav entry present");
});

// ---------------------------------------------------------------------------
// REGRESSION (owner 2026-08-01): stage LABELS were relabelled to match the
// Customer module's vocabulary (a lead enters Potential and becomes a Confirmed
// customer). The stored `key` must NOT move with the label — renaming a key
// would orphan every existing sales_leads.stage row. Guard both halves.
// ---------------------------------------------------------------------------
test("pipeline stage labels are the owner's wording; stored keys are unchanged", () => {
  const block = page.match(/const STAGES = \[([\s\S]*?)\] as const;/);
  assert.ok(block, "STAGES array not found");
  const pairs = [...block[1].matchAll(/key: "([A-Z_]+)", label: "([^"]+)"/g)]
    .map((m) => [m[1], m[2]]);
  assert.deepEqual(pairs, [
    ["NEW", "Potential"],
    ["CONTACTED", "Contacted"],
    ["QUOTED", "Quoted"],
    ["NEGOTIATING", "Negotiating"],
    ["WON", "Confirmed"],
    ["LOST", "Dropped"],
  ]);
  // The stale labels must not survive anywhere user-facing on this page.
  assert.ok(!/label: "New"|label: "Won"|label: "Lost"/.test(page), "stale stage label left behind");
  assert.ok(!/>Won</.test(page), 'the summary header still reads "Won"');
});
