// ---------------------------------------------------------------------------
// security-permission-matrix.test.mjs — spot-check the seeded role->permission
// matrix in migrations/0045_rbac.sql. Catches drift like:
//
//   * SUPER_ADMIN losing a key permission
//   * READ_ONLY accidentally getting a write permission
//   * FINANCE losing invoice posting
//   * WORKER getting more than the four read-only perms it needs
//
// We don't run the migration — we statically parse 0045_rbac.sql via
// _security-helpers.mjs and replay its INSERT...SELECT logic to build the
// expected (role, perm) tuples. That keeps the test hermetic (no D1 needed)
// while still failing if anyone edits the migration.
//
// Closes audit P1 follow-up "安全回归清单".
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { parseRbacMatrix, loadPermsForRole } from "./_security-helpers.mjs";

// ---------------------------------------------------------------------------
// SUPER_ADMIN — must have every seeded permission, no exceptions.
// ---------------------------------------------------------------------------
test("SUPER_ADMIN has every seeded permission", () => {
  const { allPerms, matrix } = parseRbacMatrix();
  const perms = matrix["role_super_admin"] ?? new Set();
  assert.equal(
    perms.size,
    allPerms.size,
    `SUPER_ADMIN should have ${allPerms.size} perms, has ${perms.size}`,
  );
  // Spot-check the most sensitive grants.
  for (const p of [
    "invoices:post",
    "invoices:void",
    "users:delete",
    "purchase-orders:approve",
    "production-orders:complete",
    "sales-orders:confirm",
  ]) {
    assert.ok(
      perms.has(p),
      `SUPER_ADMIN missing ${p} — every permission must be granted`,
    );
  }
});

// ---------------------------------------------------------------------------
// READ_ONLY — only :read actions, no exceptions.
// ---------------------------------------------------------------------------
test("READ_ONLY has only :read actions", () => {
  const perms = loadPermsForRole("role_read_only");
  assert.ok(perms.size > 0, "READ_ONLY should have at least one read perm");
  for (const p of perms) {
    assert.match(
      p,
      /:read$/,
      `READ_ONLY has non-read perm: ${p} — privilege escalation risk`,
    );
  }
});

test("READ_ONLY explicitly does NOT have any write/post/delete actions", () => {
  const perms = loadPermsForRole("role_read_only");
  for (const dangerous of [
    "invoices:create",
    "invoices:post",
    "invoices:void",
    "invoices:delete",
    "users:create",
    "users:delete",
    "payments:create",
    "purchase-orders:approve",
    "sales-orders:confirm",
    "production-orders:start",
  ]) {
    assert.ok(
      !perms.has(dangerous),
      `READ_ONLY must NOT have ${dangerous}`,
    );
  }
});

// ---------------------------------------------------------------------------
// FINANCE — full on finance domains, no production/HR write access.
// ---------------------------------------------------------------------------
test("FINANCE can post + void invoices", () => {
  const perms = loadPermsForRole("role_finance");
  assert.ok(perms.has("invoices:post"), "FINANCE needs invoices:post");
  assert.ok(perms.has("invoices:void"), "FINANCE needs invoices:void");
  assert.ok(perms.has("payments:create"));
  assert.ok(perms.has("credit-notes:create"));
  assert.ok(perms.has("debit-notes:create"));
  assert.ok(perms.has("e-invoices:create"));
});

test("FINANCE cannot mutate production orders or workers", () => {
  const perms = loadPermsForRole("role_finance");
  assert.ok(!perms.has("production-orders:create"));
  assert.ok(!perms.has("production-orders:start"));
  assert.ok(!perms.has("workers:create"));
  assert.ok(!perms.has("workers:delete"));
  assert.ok(!perms.has("users:create"));
  assert.ok(!perms.has("users:delete"));
});

// ---------------------------------------------------------------------------
// PROCUREMENT — POs/GRNs/suppliers full; production read-only.
// ---------------------------------------------------------------------------
test("PROCUREMENT owns POs and supplier domain", () => {
  const perms = loadPermsForRole("role_procurement");
  assert.ok(perms.has("purchase-orders:create"));
  assert.ok(perms.has("purchase-orders:approve"));
  assert.ok(perms.has("purchase-orders:receive"));
  assert.ok(perms.has("grn:create"));
  assert.ok(perms.has("suppliers:create"));
  assert.ok(perms.has("raw-materials:create"));
});

test("PROCUREMENT cannot post invoices or run payroll", () => {
  const perms = loadPermsForRole("role_procurement");
  assert.ok(!perms.has("invoices:post"));
  assert.ok(!perms.has("payments:create"));
  assert.ok(!perms.has("payroll:create"));
});

// ---------------------------------------------------------------------------
// PRODUCTION — owns production orders + job cards; no finance access.
// ---------------------------------------------------------------------------
test("PRODUCTION can start + complete production orders and edit BOM", () => {
  const perms = loadPermsForRole("role_production");
  assert.ok(perms.has("production-orders:create"));
  assert.ok(perms.has("production-orders:start"));
  assert.ok(perms.has("production-orders:complete"));
  assert.ok(perms.has("job-cards:create"));
  assert.ok(perms.has("bom:create"));
  assert.ok(perms.has("scheduling:create"));
});

test("PRODUCTION cannot post invoices or approve POs", () => {
  const perms = loadPermsForRole("role_production");
  assert.ok(!perms.has("invoices:post"));
  assert.ok(!perms.has("purchase-orders:approve"));
});

// ---------------------------------------------------------------------------
// SALES — sales orders + customers; can't confirm POs or post invoices.
// ---------------------------------------------------------------------------
test("SALES can create + confirm sales orders, manage customers and DOs", () => {
  const perms = loadPermsForRole("role_sales");
  assert.ok(perms.has("sales-orders:create"));
  assert.ok(perms.has("sales-orders:confirm"));
  assert.ok(perms.has("customers:create"));
  assert.ok(perms.has("delivery-orders:create"));
  assert.ok(perms.has("consignments:create"));
});

test("SALES cannot post invoices or run production", () => {
  const perms = loadPermsForRole("role_sales");
  assert.ok(!perms.has("invoices:post"));
  assert.ok(!perms.has("payments:create"));
  assert.ok(!perms.has("production-orders:start"));
  assert.ok(!perms.has("purchase-orders:approve"));
});

// ---------------------------------------------------------------------------
// WAREHOUSE — inventory & FG units; no finance / production writes.
// ---------------------------------------------------------------------------
test("WAREHOUSE owns inventory + fabric tracking + FG units", () => {
  const perms = loadPermsForRole("role_warehouse");
  assert.ok(perms.has("inventory:create"));
  assert.ok(perms.has("warehouse:create"));
  assert.ok(perms.has("fabrics:create"));
  assert.ok(perms.has("fabric-tracking:create"));
  assert.ok(perms.has("stock-movements:create"));
  assert.ok(perms.has("fg-units:create"));
});

test("WAREHOUSE cannot post invoices or start production", () => {
  const perms = loadPermsForRole("role_warehouse");
  assert.ok(!perms.has("invoices:post"));
  assert.ok(!perms.has("payments:create"));
  assert.ok(!perms.has("production-orders:start"));
  assert.ok(!perms.has("sales-orders:confirm"));
});

// ---------------------------------------------------------------------------
// WORKER — read-only, scoped to portal-relevant resources only.
// ---------------------------------------------------------------------------
test("WORKER cannot mutate ANY resource", () => {
  const perms = loadPermsForRole("role_worker");
  for (const p of perms) {
    assert.match(
      p,
      /:read$/,
      `WORKER has non-read perm: ${p} — privilege escalation risk`,
    );
  }
});

test("WORKER cannot post invoices or create users", () => {
  const perms = loadPermsForRole("role_worker");
  assert.ok(!perms.has("invoices:post"));
  assert.ok(!perms.has("invoices:create"));
  assert.ok(!perms.has("users:create"));
  assert.ok(!perms.has("users:delete"));
  assert.ok(!perms.has("payments:create"));
});

test("WORKER scope is exactly the four portal-relevant resources", () => {
  const perms = loadPermsForRole("role_worker");
  // Should be exactly: payslips:read, attendance:read, production-orders:read,
  // job-cards:read. If anyone widens this, force a test update.
  const resources = new Set([...perms].map((p) => p.split(":")[0]));
  assert.deepStrictEqual(
    [...resources].sort(),
    ["attendance", "job-cards", "payslips", "production-orders"],
    "WORKER scope drift — only attendance/job-cards/payslips/production-orders should be readable",
  );
});

// ---------------------------------------------------------------------------
// Cross-role invariant: only SUPER_ADMIN has users:create / users:delete.
// ---------------------------------------------------------------------------
test("only SUPER_ADMIN has users:create / users:delete", () => {
  const { matrix } = parseRbacMatrix();
  for (const [role, perms] of Object.entries(matrix)) {
    if (role === "role_super_admin") continue;
    assert.ok(
      !perms.has("users:create"),
      `${role} must not have users:create — only SUPER_ADMIN may create users`,
    );
    assert.ok(
      !perms.has("users:delete"),
      `${role} must not have users:delete — only SUPER_ADMIN may delete users`,
    );
  }
});

// ---------------------------------------------------------------------------
// All eight seeded roles are present.
// ---------------------------------------------------------------------------
test("all 8 seeded roles appear in the matrix", () => {
  const { matrix } = parseRbacMatrix();
  for (const role of [
    "role_super_admin",
    "role_finance",
    "role_procurement",
    "role_production",
    "role_warehouse",
    "role_sales",
    "role_worker",
    "role_read_only",
  ]) {
    assert.ok(
      matrix[role] && matrix[role].size > 0,
      `role ${role} is missing or has zero perms in 0045_rbac.sql`,
    );
  }
});
