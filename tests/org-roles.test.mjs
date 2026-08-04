// ---------------------------------------------------------------------------
// org-roles.test.mjs — a role for every ORG department.
//
// Owner 2026-08-04: "根据我们的部门都要有对应的 role，先把 role 都打开."
//
// The 0045 seed built roles around FUNCTIONS (sales, finance, procurement,
// production, warehouse, worker, read-only, super-admin), but people are filed
// by ORG DEPARTMENT — Sales, Finance, Production, HR, R&D, QA, Office,
// Management. Four of those had no role, so everyone in them sat on ADMIN,
// which rbac.ts short-circuits to `*:*`: HR could read every margin, QA could
// edit invoices.
//
// Watch the two different "departments": the `departments` TABLE is the 14
// PRODUCTION stages used by job cards and scheduling. This is `users.department`
// — the org chart. Conflating them is the easy mistake here.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

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
  // Silently defaulting to a role would hand out permissions nobody chose.
  assert.equal(defaultRoleForDepartment("Legal"), null);
  assert.equal(defaultRoleForDepartment(""), null);
});

test("HR gets people data and NOT the commercials", () => {
  const hr = ORG_ROLES.find((r) => r.name === "HR");
  for (const res of ["workers", "attendance", "leaves", "payroll", "payslips"]) {
    assert.ok(hr.grants[res], `HR needs ${res}`);
  }
  for (const res of ["cost-ledger", "accounting", "invoices", "payments", "sales-orders"]) {
    assert.equal(hr.grants[res], undefined, `HR must not reach ${res}`);
  }
});

test("HR can see accounts but not mint them", () => {
  // Creating / disabling an account is requireSuperAdmin in users.ts; the grant
  // must not imply otherwise.
  const hr = ORG_ROLES.find((r) => r.name === "HR");
  assert.deepEqual(hr.grants.users, ["read"]);
});

test("QA records defects without creating or deleting production work", () => {
  const qa = ORG_ROLES.find((r) => r.name === "QA");
  assert.deepEqual(qa.grants["job-cards"], ["read", "update"]);
  assert.deepEqual(qa.grants["production-orders"], ["read"]);
  assert.ok(qa.grants["qc-inspections"].includes("create"));
  for (const res of ["invoices", "payments", "cost-ledger", "payroll"]) {
    assert.equal(qa.grants[res], undefined, `QA must not reach ${res}`);
  }
});

test("R&D can change a BOM — that is the point of the role", () => {
  // Tan and Chee were READ_ONLY, so product development could not edit the
  // things it exists to edit.
  const rd = ORG_ROLES.find((r) => r.name === "R_AND_D");
  for (const res of ["products", "bom", "sofa-combos", "product-configs", "fabrics"]) {
    assert.ok(rd.grants[res].includes("update"), `R&D needs to edit ${res}`);
  }
});

test("R&D may add a raw material but not retire one", () => {
  // Deleting a material has stock and cost consequences owned elsewhere.
  const rd = ORG_ROLES.find((r) => r.name === "R_AND_D");
  assert.deepEqual(rd.grants["raw-materials"], ["read", "create", "update"]);
});

test("Office raises and receives a PO but cannot approve the spend", () => {
  const off = ORG_ROLES.find((r) => r.name === "OFFICE");
  assert.ok(off.grants["purchase-orders"].includes("create"));
  assert.ok(off.grants["purchase-orders"].includes("receive"));
  assert.ok(
    !off.grants["purchase-orders"].includes("approve"),
    "approving is a spend decision, not a clerical one",
  );
});

test("Management approves and confirms, and reads everything", () => {
  const mg = ORG_ROLES.find((r) => r.name === "MANAGEMENT");
  assert.ok(mg.grants["purchase-orders"].includes("approve"));
  assert.ok(mg.grants["sales-orders"].includes("confirm"));
  // Read-all is granted by expansion in ensureOrgRoles, not listed per resource.
  assert.equal(mg.grants["cost-ledger"], undefined);
});

test("no role grants users:role-change — that stays SUPER_ADMIN", () => {
  // Otherwise a role could quietly promote its own holder.
  for (const r of ORG_ROLES) {
    assert.ok(
      !(r.grants.users ?? []).includes("role-change"),
      `${r.name} must not be able to change roles`,
    );
  }
});

test("seeding is additive — it never resets an edited role", async () => {
  // The owner tunes these from the permissions UI afterwards; a re-seed that
  // overwrote their choices would undo that work on every isolate boot.
  const sqls = [];
  const db = {
    prepare(sql) {
      sqls.push(sql);
      const r = { run: async () => {}, all: async () => ({ results: [] }) };
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
      const r = { run: async () => {}, all: async () => ({ results: [] }) };
      return { ...r, bind: () => r };
    },
  };
  _resetOrgRolesMemoForTests();
  await ensureOrgRoles(db);
  const first = n;
  await ensureOrgRoles(db);
  assert.equal(n, first, "a second call must be a no-op");
});
