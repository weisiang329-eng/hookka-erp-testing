// ---------------------------------------------------------------------------
// org-roles.test.mjs — a role ROW for every org department.
//
// Owner 2026-08-04: "根据我们的部门都要有对应的 role，先把 role 都打开."
//
// The 0045 seed built roles around FUNCTIONS (sales, finance, procurement,
// production, warehouse, worker, read-only, super-admin), but people are filed
// by ORG DEPARTMENT — Sales, Finance, Production, HR, R&D, QA, Office,
// Management. Four had no role, so everyone in them sat on ADMIN, which
// rbac.ts short-circuits to `*:*`: HR could read every margin.
//
// This file's job is now ONLY to make the role exist so it can be assigned.
// What each role may DO lives in role-policy.ts (see role-policy.test.mjs) —
// the grants used to be seeded here too, and one thing defined in two places
// is what took purchase-invoice creation down earlier the same day.
//
// Watch the two "departments": the `departments` TABLE is the 14 PRODUCTION
// stages used by job cards and scheduling. This is `users.department`.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ORG_ROLES,
  defaultRoleForDepartment,
  ensureOrgRoles,
  _resetOrgRolesMemoForTests,
} from "../src/api/lib/ensure-org-roles.ts";

test("every org department on a live user maps to a role", () => {
  // Observed on prod 2026-08-04.
  for (const dept of [
    "Sales", "Finance", "Production", "HR", "R&D", "QA", "Office", "Management",
  ]) {
    assert.ok(
      defaultRoleForDepartment(dept),
      `${dept} has no role — its people fall back to ADMIN, which is *:*`,
    );
  }
});

test("the mapping is case- and spelling-tolerant", () => {
  assert.equal(defaultRoleForDepartment("r&d"), "R_AND_D");
  assert.equal(defaultRoleForDepartment("R_AND_D"), "R_AND_D");
  assert.equal(defaultRoleForDepartment("  hr  "), "HR");
  assert.equal(defaultRoleForDepartment("Warehousing"), "WAREHOUSE");
});

test("an unknown department maps to nothing rather than guessing", () => {
  // Silently defaulting would hand out permissions nobody chose.
  assert.equal(defaultRoleForDepartment("Legal"), null);
  assert.equal(defaultRoleForDepartment(""), null);
});

test("there is no MANAGEMENT role — management IS super admin", () => {
  // Drafted as read-all plus two approvals; the owner rejected it: "management
  // 不是跟 superadmin 的吗？" Management is the ownership layer, so limiting it
  // to reading routes every action through someone else. It would also have
  // been decorative — requireSuperAdmin in users.ts gates account management
  // independently of the permission table, so even a wildcard MANAGEMENT could
  // not open an account. A role nobody uses is worse than no role.
  assert.equal(ORG_ROLES.find((r) => r.name === "MANAGEMENT"), undefined);
  assert.equal(defaultRoleForDepartment("Management"), "SUPER_ADMIN");
});

test("this file creates roles and grants NOTHING", () => {
  // One source for permissions, and it is role-policy.ts.
  const src = readFileSync(
    resolve(process.cwd(), "src/api/lib/ensure-org-roles.ts"),
    "utf8",
  );
  assert.doesNotMatch(src, /INSERT INTO role_permissions/);
  assert.doesNotMatch(src, /^\s*grants:/m, "no grants field on the role shape");
  assert.match(src, /INSERT INTO roles/);
});

test("seeding is additive — it never resets an edited role", async () => {
  const sqls = [];
  const db = {
    prepare(sql) {
      sqls.push(sql);
      const r = { run: async () => {} };
      return { ...r, bind: () => r };
    },
  };
  _resetOrgRolesMemoForTests();
  await ensureOrgRoles(db);
  assert.ok(sqls.some((s) => s.includes("ON CONFLICT (id) DO NOTHING")));
  assert.ok(sqls.every((s) => !/\bDELETE\b|\bUPDATE\b/.test(s)), "must not delete or overwrite");
});

test("it runs once per isolate", async () => {
  let n = 0;
  const db = {
    prepare() {
      n++;
      const r = { run: async () => {} };
      return { ...r, bind: () => r };
    },
  };
  _resetOrgRolesMemoForTests();
  await ensureOrgRoles(db);
  const first = n;
  await ensureOrgRoles(db);
  assert.equal(n, first, "a second call must be a no-op");
});
