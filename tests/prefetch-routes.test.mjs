import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRoutePrefetchPlan,
  routeKeyForPrefetch,
} from "../src/lib/prefetch-policy.ts";

test("dashboard plan is role-aware and capped", () => {
  assert.deepEqual(buildRoutePrefetchPlan("/dashboard", "SUPER_ADMIN"), [
    "/sales",
    "/delivery",
    "/production",
  ]);
  assert.deepEqual(buildRoutePrefetchPlan("/dashboard", "READ_ONLY"), []);
});

test("scan and mobile terminal routes never speculate", () => {
  assert.deepEqual(buildRoutePrefetchPlan("/production/scan", "SUPER_ADMIN"), []);
  assert.deepEqual(buildRoutePrefetchPlan("/production/fg-scan", "SUPER_ADMIN"), []);
  assert.deepEqual(buildRoutePrefetchPlan("/m/production", "SUPER_ADMIN"), []);
  assert.deepEqual(buildRoutePrefetchPlan("/worker/scan", "SUPER_ADMIN"), []);
});

test("workflow pages warm only likely next areas", () => {
  assert.deepEqual(buildRoutePrefetchPlan("/sales/SO-001", "ADMIN"), [
    "/delivery",
    "/invoices",
    "/customers",
  ]);
  assert.deepEqual(buildRoutePrefetchPlan("/production/fab-cut", "ADMIN"), [
    "/planning",
    "/inventory",
  ]);
  assert.deepEqual(buildRoutePrefetchPlan("/accounting?tab=pl", "ADMIN"), [
    "/invoices",
    "/reports",
  ]);
  assert.equal(routeKeyForPrefetch("/accounting?tab=pl#month"), "/accounting");
});
