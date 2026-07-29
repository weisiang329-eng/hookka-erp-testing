// ---------------------------------------------------------------------------
// customer-crm.test.mjs — pins the CRM MVP slice (owner 2026-07-30, for outbound
// sales): per-customer Contacts + an Activity/follow-up timeline. Structural
// pins (source assertions, the repo idiom); live UX verified on staging.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync(new URL("../src/api/routes/customer-crm.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/api/worker.ts", import.meta.url), "utf8");
const panel = readFileSync(new URL("../src/components/customer/CrmPanel.tsx", import.meta.url), "utf8");
const customers = readFileSync(new URL("../src/pages/customers.tsx", import.meta.url), "utf8");

test("route exposes contacts + activities + follow-ups, all RBAC-gated + tenant-scoped", () => {
  for (const p of ["/contacts", "/activities", "/follow-ups"]) {
    assert.ok(route.includes(`"${p}"`), `route must define ${p}`);
  }
  // Every handler gates on the customers resource and scopes by org.
  assert.match(route, /requirePermission\(c, "customers", "read"\)/);
  assert.match(route, /requirePermission\(c, "customers", "update"\)/);
  assert.match(route, /requirePermission\(c, "customers", "delete"\)/);
  assert.match(route, /getOrgId\(c\)/, "must tenant-scope by org_id");
  // Runtime self-applied tables (migrations are inert on deploy).
  assert.match(route, /CREATE TABLE IF NOT EXISTS customer_contacts/);
  assert.match(route, /CREATE TABLE IF NOT EXISTS customer_activities/);
});

test("route is mounted in the worker", () => {
  assert.match(worker, /import customerCrm from "\.\/routes\/customer-crm"/);
  assert.match(worker, /app\.route\("\/api\/customer-crm", customerCrm\)/);
});

test("CrmPanel renders contacts + timeline and is mounted on the customer view", () => {
  assert.match(panel, /export function CrmPanel/);
  assert.match(panel, /\/api\/customer-crm\/contacts/);
  assert.match(panel, /\/api\/customer-crm\/activities/);
  assert.match(panel, /next.?follow.?up/i, "timeline must capture a next follow-up");
  assert.match(customers, /import \{ CrmPanel \} from "@\/components\/customer\/CrmPanel"/);
  assert.match(customers, /<CrmPanel customerId=\{cust\.id\}/);
});
