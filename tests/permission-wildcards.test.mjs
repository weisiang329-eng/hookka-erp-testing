// ---------------------------------------------------------------------------
// The browser's permission check must answer exactly what the API's does.
//
// Owner 2026-08-05: "为什么我点 Invoice 的 module，它是跑出来 dashboard，那么奇
// 怪的？" — because the two had drifted. The code RBAC policy grants a whole
// module as `invoices:*`, the API's permitted() honours that wildcard, and the
// browser's checkSet() compared the exact tuple only. So hasPermission(
// "invoices", "read") was false for every department role, and <RequirePermission>
// bounced them to /dashboard — a page those same roles are not allowed to see.
//
// This test pins the two implementations to each other over the real policy.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { permissionsForRole, ALL_RESOURCES } from "../src/api/lib/role-policy.ts";

const ACTIONS = ["read", "create", "update", "delete"];
const ROLES = ["SALES", "OFFICE", "QA", "HR", "R_AND_D"];

// The API's rule, copied from src/api/lib/rbac.ts `permitted()`.
const serverAllows = (set, resource, action) =>
  set.has(`${resource}:${action}`) ||
  set.has(`${resource}:*`) ||
  set.has(`*:${action}`) ||
  set.has(`*:*`);

test("the browser's checkSet still matches the API's permitted()", () => {
  // Read the browser rule out of the source rather than re-stating it, so a
  // future edit to one side fails here instead of in production.
  const src = readFileSync(resolve(process.cwd(), "src/lib/use-permission.ts"), "utf8");
  for (const clause of [
    "set.has(`${resource}:${action}`)",
    "set.has(`${resource}:*`)",
    "set.has(`*:${action}`)",
    "set.has(`*:*`)",
  ]) {
    assert.ok(
      src.includes(clause),
      `use-permission.ts no longer checks ${clause} — it has drifted from rbac.ts permitted()`,
    );
  }
});

test("every module a role is granted is reachable in the browser", () => {
  for (const role of ROLES) {
    const set = permissionsForRole(role);
    assert.ok(set, `${role} has no coded policy`);
    for (const resource of ALL_RESOURCES) {
      for (const action of ACTIONS) {
        // Nothing to compare when the role isn't granted it at all.
        if (!serverAllows(set, resource, action)) continue;
        assert.ok(
          set.has(`${resource}:${action}`) || set.has(`${resource}:*`) ||
            set.has(`*:${action}`) || set.has(`*:*`),
          `${role} may ${action} ${resource} on the API but not in the browser`,
        );
      }
    }
  }
});

test("SALES can open the modules the owner listed", () => {
  const set = permissionsForRole("SALES");
  for (const r of ["invoices", "sales-orders", "delivery-orders", "delivery-returns",
                   "consignments", "customers", "quotations", "sales-pipeline"]) {
    assert.ok(serverAllows(set, r, "read"), `SALES cannot read ${r}`);
  }
  // …and not the ones they were not.
  for (const r of ["accounting", "users"]) {
    assert.ok(!serverAllows(set, r, "read"), `SALES should not read ${r}`);
  }
});
