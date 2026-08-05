// ---------------------------------------------------------------------------
// Row scoping has to exist in SQL, not only in the response filter.
//
// Owner 2026-08-05, looking at the sales account: the Sales Orders GRID read
// "No confirmed orders" while the cards above it read 1,229 orders and
// RM 1,411,671.95, and the Delivery Orders planning tab showed all 116 rows.
// Two structural holes:
//   • an aggregate is a number — there is no row for a row filter to drop;
//   • a row is only filtered if it CARRIES a customer id, and /pending-sos
//     selects customerName without one.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import {
  customerScopeSql, salesOrderScopeSql, isCustomerScoped,
  filterPayload, SCOPED_PREFIXES, isScopedPath,
} from "../src/api/lib/customer-scope.ts";

const ctx = (role, userId, customers = []) => ({
  get: (k) => (k === "userRole" ? role : k === "userId" ? userId : undefined),
  var: {
    DB: {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: customers }) }),
      }),
    },
  },
});

const FOREIGN = [{ id: "cust-A", name: "Carress" }, { id: "cust-B", name: "Houzs Century" }];

test("an unscoped role gets no clause at all", async () => {
  for (const role of ["SUPER_ADMIN", "OFFICE", "FINANCE", "QA"]) {
    const s = await customerScopeSql(ctx(role, "u1", FOREIGN));
    assert.equal(s.clause, "", `${role} should not be narrowed`);
    assert.deepEqual(s.binds, []);
  }
});

test("a salesperson's clause excludes other people's customers", async () => {
  const s = await customerScopeSql(ctx("SALES", "u1", FOREIGN), "customer_id");
  assert.match(s.clause, /customer_id IS NULL OR customer_id NOT IN \(\?, \?\)/);
  assert.deepEqual(s.binds, ["cust-A", "cust-B"]);
});

test("a failed lookup hides everything rather than nothing", async () => {
  // No userId → the scope cannot be resolved. Fail closed.
  const s = await customerScopeSql(ctx("SALES", "", FOREIGN));
  assert.equal(s.clause, "1 = 0");
});

test("nothing assigned to anyone else means nothing to hide", async () => {
  const s = await customerScopeSql(ctx("SALES", "u1", []));
  assert.equal(s.clause, "");
});

test("production orders narrow through BOTH their sales and consignment order", async () => {
  // All 38 consignment-origin POs on prod were visible to a salesperson who
  // owned none of them, because they carry no salesOrderId to test.
  const s = await salesOrderScopeSql(ctx("SALES", "u1", FOREIGN));
  assert.match(s.clause, /FROM sales_orders WHERE customer_id IN/);
  assert.match(s.clause, /FROM consignment_orders WHERE customer_id IN/);
  assert.equal(s.binds.length, 4, "both subqueries need their own binds");
});

test("a row identified only by customer NAME is still filtered", () => {
  // /api/delivery-orders/pending-sos selects customerName and no customerId.
  const scope = {
    forbidden: new Set(["cust-A"]),
    forbiddenNames: new Set(["CARRESS"]),
    denyAll: false,
  };
  const rows = [
    { id: "SO-1", customerName: "Carress" },      // theirs — drop
    { id: "SO-2", customerName: "Unassigned Co" }, // public — keep
    { id: "SO-3", customerId: "cust-MINE", customerName: "Carress" }, // id wins — keep
    { id: "SO-4" },                                // no customer — keep
  ];
  const out = filterPayload(rows, scope, false).value;
  assert.deepEqual(out.map((r) => r.id), ["SO-2", "SO-3", "SO-4"]);
});

test("the scoped modules are exactly the ones the owner listed", () => {
  for (const p of ["/api/sales-orders", "/api/delivery-orders", "/api/delivery-returns",
                   "/api/production-orders", "/api/service-orders", "/api/service-cases",
                   "/api/customers", "/api/invoices", "/api/consignments"]) {
    assert.ok(SCOPED_PREFIXES.includes(p), `${p} should be scoped`);
  }
  // "Planning 他也是会直接看完的" — the Planning module is seen in full.
  assert.equal(isScopedPath("/api/planning"), false);
  assert.equal(isScopedPath("/api/planning/schedule"), false);
});

test("isCustomerScoped is role-only and needs no database", () => {
  assert.equal(isCustomerScoped(ctx("SALES", "u1")), true);
  assert.equal(isCustomerScoped(ctx("sales", "u1")), true);
  assert.equal(isCustomerScoped(ctx("OFFICE", "u1")), false);
});

// ---------------------------------------------------------------------------
// Round two, owner 2026-08-05: "他 deliveryOrder planning 跟 planning delivery
// 还是会看到别的顧客的，包括 invoice 也会看到 total amount… consignment order
// 也是这样。我想 consignment note、return 等等都是."
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

test("every list that shows customer rows narrows in SQL", () => {
  // Asserted against the SOURCE because these are route handlers with their own
  // snapshots and query builders — a unit test of the helper alone would keep
  // passing while a route quietly stopped calling it.
  for (const [file, needle] of [
    ["src/api/routes/sales-orders.ts", "customerScopeSql"],
    ["src/api/routes/delivery-orders.ts", "customerScopeSql"],
    ["src/api/routes/delivery-returns.ts", "customerScopeSql"],
    ["src/api/routes/service-orders.ts", "customerScopeSql"],
    ["src/api/routes/service-cases.ts", "customerScopeSql"],
    ["src/api/routes/invoices.ts", "customerScopeSql"],
    ["src/api/routes/consignments.ts", "customerScopeSql"],
    ["src/api/routes/consignment-notes.ts", "customerScopeSql"],
    ["src/api/routes/consignment-orders.ts", "customerScopeSql"],
    ["src/api/routes/production-orders.ts", "salesOrderScopeSql"],
  ]) {
    assert.ok(read(file).includes(needle), `${file} does not narrow its rows`);
  }
});

test("the Planning and Pending-Delivery tabs narrow too", () => {
  // /ready-planning answers {ready, planning}, not {data} — the response filter
  // never inspected it, which is why both tabs kept showing other people's rows
  // after the first pass.
  const src = read("src/api/routes/delivery-orders.ts");
  const rp = src.slice(src.indexOf('app.get("/ready-planning"'));
  assert.match(rp, /rpPoScope/, "ready-planning does not narrow its production orders");
  assert.match(rp, /rpSoScope/, "ready-planning does not narrow its sales orders");
  assert.match(rp, /isCustomerScoped\(c\)/, "ready-planning would cache a scoped payload");
});

test("no org-keyed snapshot is written from a scoped request", () => {
  // A narrowed payload in a shared cache is worse than no filter at all: it
  // would serve one salesperson's view to the whole factory.
  for (const [file, guard] of [
    ["src/api/routes/sales-orders.ts", /if \(serviceOrderFilter !== "false" \|\| scope\.clause\)/],
    ["src/api/routes/delivery-orders.ts", /if \(!statsScope\.clause\)/],
    ["src/api/routes/invoices.ts", /\|\| !!statScope\.clause/],
    ["src/api/routes/production-orders.ts", /if \(isCustomerScoped\(c\)\)/],
  ]) {
    assert.match(read(file), guard, `${file} may poison its snapshot`);
  }
});

test("CNC templates have a gate of their own, not the catalogue's", () => {
  // They used to share `products`, so read-only catalogue access handed out the
  // shop-floor cutting templates with it.
  const nav = read("src/api/lib/nav-permissions.ts");
  assert.match(nav, /"\/cnc-templates": "cnc-templates"/);
  const route = read("src/api/routes/cnc-templates.ts");
  assert.equal(
    (route.match(/requirePermission\(c, "products"/g) ?? []).length, 0,
    "a CNC template endpoint still gates on products",
  );
});
