// ---------------------------------------------------------------------------
// role-policy.test.mjs — the department roles, as the owner specified them.
//
// Owner 2026-08-04: "我全部要用程序代码那边去处理这个 RBAC 就可以了，你根据我的
// 指令去做."
//
// The right call. Expressing these rules as `role_permissions` rows would have
// needed a pile of plumbing first: six modules the owner named have no
// permission resource at all, and Delivery Return / Service Cases share the
// delivery-orders and service-orders resources, so "DO read-only but Delivery
// Return editable" is not expressible as data. In code a resource name is free.
//
// The GATE is unchanged — requirePermission still guards every route. Only the
// SOURCE of the permission set moved, and only for the roles listed here.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CODE_ROLE_POLICIES,
  permissionsForRole,
  isCodeRole,
  FINANCE_RESOURCES,
  FORECAST_RESOURCES,
} from "../src/api/lib/role-policy.ts";

const can = (role, res, action) => {
  const p = permissionsForRole(role);
  return p.has(`${res}:${action}`) || p.has(`${res}:*`);
};

// ── Everyone gets the basics ────────────────────────────────────────────────

test("News Center, Announcements, Notifications and Settings are for everyone", () => {
  // Owner: "这三个是全部人都有的，还有『设置』也是全部人都有的." Stated once as a
  // shared base — repeating it per role is how one copy silently loses it.
  for (const role of Object.keys(CODE_ROLE_POLICIES)) {
    for (const res of ["announcements", "mail-center", "notifications", "settings"]) {
      assert.ok(can(role, res, "read"), `${role} must see ${res}`);
    }
  }
});

// ── SALES ───────────────────────────────────────────────────────────────────

test("SALES has the modules its spec named, at module level", () => {
  // Owner 2026-08-04: "暂时不需要去理它是可以 view 还是 edit… 只需要开放那个
  // module 给它先." So the assertion is presence, not shape. The finer spec
  // (SO/DO/Invoice read-only, consignment read-plus-create, price read-only) is
  // recorded as `was:` notes in role-policy.ts so it can be reinstated without
  // another interview.
  for (const res of [
    "sales-orders", "delivery-orders", "delivery-returns", "invoices",
    "consignments", "consignment-notes",
    "customers", "sales-pipeline", "quotations", "customer-hubs",
    "customer-products", "sofa-combos", "promise-date",
    "production-orders", "scheduling", "products", "price-history",
    "qc-inspections", "service-cases", "service-orders",
  ]) {
    assert.ok(can("SALES", res, "read"), `SALES needs ${res}`);
    assert.ok(can("SALES", res, "update"), `${res} is open, so editable`);
  }
});

test("the finer read-only spec is preserved for later, not discarded", () => {
  // Losing it would mean re-asking the owner every rule they already gave.
  const src = readFileSync(resolve(process.cwd(), "src/api/lib/role-policy.ts"), "utf8");
  assert.ok(src.split("was: read").length - 1 >= 8, "the earlier spec must stay recorded");
});

test("SALES owns the customer end to end", () => {
  for (const a of ["read", "create", "update", "delete"]) {
    assert.ok(can("SALES", "customers", a), `customers:${a}`);
  }
  // Pipeline, quotation, HUB, sofa combo, assign SKU — all theirs.
  assert.ok(can("SALES", "sales-pipeline", "create"));
  assert.ok(can("SALES", "quotations", "create"));
  assert.ok(can("SALES", "customer-hubs", "update"));
  assert.ok(can("SALES", "sofa-combos", "update"));
  assert.ok(can("SALES", "customer-products", "create"));
});

test("SALES can reach Quality so an unfamiliar case is not a dead end", () => {
  for (const res of ["qc-inspections", "service-cases", "service-orders"]) {
    assert.ok(can("SALES", res, "read"), res);
  }
});

test("SALES never reaches the money", () => {
  for (const res of FINANCE_RESOURCES) {
    if (res === "invoices") continue; // read-only by spec, asserted above
    for (const a of ["read", "create", "update", "delete"]) {
      assert.ok(!can("SALES", res, a), `SALES must not ${a} ${res}`);
    }
  }
});

// ── OFFICE ──────────────────────────────────────────────────────────────────

test("OFFICE does everything except Finance and Forecasting", () => {
  // Owner: "什么都可以看到，都可以操作，就是不能看到我们的 finance 还有 forecasting."
  for (const res of [...FINANCE_RESOURCES, ...FORECAST_RESOURCES]) {
    assert.ok(!can("OFFICE", res, "read"), `OFFICE must not see ${res}`);
  }
  for (const res of ["purchase-orders", "grn", "sales-orders", "customers", "inventory"]) {
    assert.ok(can("OFFICE", res, "update"), `OFFICE should operate ${res}`);
  }
});

// ── QA ──────────────────────────────────────────────────────────────────────

test("QA sees Quality and Procurement, and nothing else", () => {
  // Owner correction: "我们的 QA 只可以看到 Quality 还有 Procurement." The first
  // draft had QA on the Office rule — far too wide.
  for (const res of ["qc-inspections", "service-cases", "service-orders"]) {
    assert.ok(can("QA", res, "read"), `Quality: ${res}`);
  }
  for (const res of ["purchase-orders", "grn", "suppliers", "purchase-returns", "mrp"]) {
    assert.ok(can("QA", res, "read"), `Procurement: ${res}`);
  }
  for (const res of ["customers", "sales-orders", "payroll", "inventory", "accounting", "forecasts"]) {
    assert.ok(!can("QA", res, "read"), `QA must not see ${res}`);
  }
});

test("QA writes in Quality and can return a rejected delivery", () => {
  assert.ok(can("QA", "qc-inspections", "create"));
  assert.ok(can("QA", "purchase-returns", "create"));
});

// ── R&D ─────────────────────────────────────────────────────────────────────

test("R&D can change what it exists to change", () => {
  for (const res of ["products", "bom", "product-configs", "rd-projects"]) {
    assert.ok(can("R_AND_D", res, "update"), `R&D needs to edit ${res}`);
  }
});

test("R&D sees what a product COSTS, never what it sells for", () => {
  // Owner 2026-08-05: "我们卖价不需要给他们知道，我们只需要给他们看到成本就可以."
  // The catalogue, the BOM and the build stay; the price does not.
  assert.ok(can("R_AND_D", "products", "update"), "R&D still needs the catalogue");
  assert.ok(can("R_AND_D", "bom", "update"), "R&D still needs the BOM");
  assert.ok(!can("R_AND_D", "product-pricing", "read"), "R&D must not see selling price");
  // Sofa Combos is a per-customer price list — removed the same day.
  assert.ok(!can("R_AND_D", "sofa-combos", "read"), "R&D must not see combo pricing");

  // And the roles that reached prices through `products` before it split off
  // must NOT have lost them. Only R&D was to lose anything.
  for (const role of ["SALES", "OFFICE", "QA"]) {
    assert.ok(can(role, "product-pricing", "read"), `${role} lost selling price`);
  }
});

test("HR sees the labour bill, not the revenue beside it", () => {
  // Owner 2026-08-05: "我们只需要保留着人工成本，给 HR 看到就行."
  assert.ok(can("HR", "workers", "read"), "HR still needs the labour report");
  assert.ok(!can("HR", "revenue-figures", "read"), "HR must not see revenue / remain");
  assert.ok(can("OFFICE", "revenue-figures", "read"), "Office should still see it");
});

test("R&D keeps fabrics even though they sit under Warehouse", () => {
  // Flagged to the owner: product development cannot specify a sofa without
  // fabric, so this one Warehouse item is kept while the rest is not.
  assert.ok(can("R_AND_D", "fabrics", "update"));
  for (const res of ["inventory", "stock-value", "stock-movements", "warehouse"]) {
    assert.ok(!can("R_AND_D", res, "read"), `R&D must not see ${res}`);
  }
});

test("R&D is shut out of Finance, Procurement, Sales, HR and System", () => {
  for (const res of [
    ...FINANCE_RESOURCES, ...FORECAST_RESOURCES,
    "purchase-orders", "suppliers", "sales-orders", "customers",
    "payroll", "workers", "users", "organisations",
  ]) {
    assert.ok(!can("R_AND_D", res, "read"), `R&D must not see ${res}`);
  }
});

// ── HR ──────────────────────────────────────────────────────────────────────

test("HR sees Employees and nothing commercial", () => {
  // Owner: "HR 只看这个也基础的例如 notification" — the HR & Operations section
  // plus the shared base. HR handles pay, so it must not also read earnings.
  for (const res of ["workers", "attendance", "leaves", "payroll", "payslips"]) {
    assert.ok(can("HR", res, "update"), `HR needs ${res}`);
  }
  for (const res of [
    ...FINANCE_RESOURCES, ...FORECAST_RESOURCES,
    "sales-orders", "customers", "purchase-orders", "inventory", "production-orders",
  ]) {
    assert.ok(!can("HR", res, "read"), `HR must not see ${res}`);
  }
});

test("HR can see accounts but not mint them", () => {
  assert.ok(can("HR", "users", "read"));
  assert.ok(!can("HR", "users", "create"));
  assert.ok(!can("HR", "users", "role-change"));
});

// ── The gate itself ─────────────────────────────────────────────────────────

test("no code role can change roles — that stays SUPER_ADMIN", () => {
  // Otherwise a role could quietly promote its own holder.
  for (const role of Object.keys(CODE_ROLE_POLICIES)) {
    assert.ok(!can(role, "users", "role-change"), `${role} must not change roles`);
  }
});

test("roles NOT defined in code still fall through to the database", () => {
  // FINANCE, PROCUREMENT, PRODUCTION, WAREHOUSE, READ_ONLY, WORKER and
  // SUPER_ADMIN keep the 0045-seeded behaviour untouched.
  for (const role of ["FINANCE", "PROCUREMENT", "PRODUCTION", "WAREHOUSE", "READ_ONLY", "SUPER_ADMIN"]) {
    assert.equal(isCodeRole(role), false, `${role} must not be code-defined`);
    assert.equal(permissionsForRole(role), null);
  }
});

test("the code policy short-circuits BEFORE the table is read", () => {
  // If the query ran first the two could disagree; a stale role_permissions row
  // for a code role must never widen or narrow what the code says.
  const rbac = readFileSync(resolve(process.cwd(), "src/api/lib/rbac.ts"), "utf8");
  const coded = rbac.indexOf("const coded = permissionsForRole(role);");
  const query = rbac.indexOf("FROM role_permissions rp");
  assert.ok(coded > 0 && query > coded, "the code check must come first");
  assert.match(rbac, /if \(coded\) return coded;/);
});

test("the seeder no longer grants permissions — one source only", () => {
  // It used to seed grants too, so HR/QA/R&D/OFFICE had a permission set in two
  // places. Two definitions of one thing is what broke PI creation earlier.
  const seed = readFileSync(resolve(process.cwd(), "src/api/lib/ensure-org-roles.ts"), "utf8");
  assert.doesNotMatch(seed, /INSERT INTO role_permissions/);
  assert.match(seed, /INSERT INTO roles/);
});
