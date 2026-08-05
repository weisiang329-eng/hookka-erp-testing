// ---------------------------------------------------------------------------
// customer-scope.test.mjs — a salesperson sees their own customers only.
//
// Owner 2026-08-04: "只能看到自己顾客的单据."
//
// This is a row filter, not a permission. `requirePermission` answers "may you
// open Sales Orders at all"; it cannot answer "which rows". Conflating the two
// is how row-level rules end up half-implemented.
//
// The tests below are mostly about the FAILURE directions, because the success
// direction is obvious and the failures are not: a filter that fails open on a
// database blip, or that treats "owns nothing yet" as "owns everything", turns
// a safety feature into the leak it was built to prevent.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  filterPayload,
  isScopedPath,
  foreignCustomerIds,
  SCOPED_ROLES,
  SCOPED_PREFIXES,
} from "../src/api/lib/customer-scope.ts";

// c9 belongs to another salesperson. c1/c2 are mine, cX is UNASSIGNED.
const SCOPE = { forbidden: new Set(["c9"]), denyAll: false };
const DENY_ALL = { forbidden: new Set(), denyAll: true };

// ── Which paths are covered ─────────────────────────────────────────────────

test("every route carrying customer-linked rows is covered", () => {
  for (const p of [
    "/api/customers", "/api/sales-orders", "/api/delivery-orders",
    "/api/delivery-returns", "/api/invoices", "/api/consignments",
  ]) {
    assert.ok(isScopedPath(p), `${p} must be scoped`);
    assert.ok(isScopedPath(`${p}/abc`), `${p}/:id must be scoped`);
    assert.ok(isScopedPath(`${p}?status=OPEN`), `${p} with a query must be scoped`);
  }
});

test("a sub-path of a scoped route is covered without being listed", () => {
  // The whole point of gating on the prefix: an endpoint added tomorrow
  // inherits the filter rather than waiting to be remembered.
  assert.ok(isScopedPath("/api/sales-orders/SO-1/footprint"));
  assert.ok(isScopedPath("/api/invoices/abc/pdf"));
});

test("unrelated routes are untouched", () => {
  for (const p of ["/api/purchase-orders", "/api/workers", "/api/customers-summary"]) {
    assert.equal(isScopedPath(p), false, `${p} must NOT be scoped`);
  }
});

// ── Filtering ───────────────────────────────────────────────────────────────

test("another salesperson's rows are dropped from a list", () => {
  const rows = [{ id: "s1", customerId: "c1" }, { id: "s2", customerId: "c9" }];
  const { value } = filterPayload(rows, SCOPE, false);
  assert.deepEqual(value.map((r) => r.id), ["s1"]);
});

test("an UNASSIGNED customer stays public", () => {
  // Owner ruling: "没有被 assign 的时候就是公开的，可是一旦被 assign，就只有那个
  // salesperson 看得到." The opposite reading — show me only mine — would make
  // every unclaimed account vanish for the whole team, including ones nobody
  // has picked up yet.
  const rows = [{ id: "s1", customerId: "cX" }, { id: "s2", customerId: "c9" }];
  const { value } = filterPayload(rows, SCOPE, false);
  assert.deepEqual(value.map((r) => r.id), ["s1"], "unassigned must survive");
});

test("the customers list is judged on its OWN id", () => {
  const rows = [{ id: "c1" }, { id: "c9" }, { id: "cX" }];
  const { value } = filterPayload(rows, SCOPE, true);
  assert.deepEqual(value.map((r) => r.id), ["c1", "cX"], "mine + unassigned");
});

test("snake_case and camelCase customer keys are both honoured", () => {
  // A row read through a different path may come back either way; missing one
  // spelling silently lets those rows through.
  const rows = [{ id: "a", customer_id: "c9" }, { id: "b", customerId: "c9" }];
  const { value } = filterPayload(rows, SCOPE, false);
  assert.deepEqual(value, []);
});

test("a row carrying NO customer is kept", () => {
  // These payloads also carry option lists, totals and config. Blanking them
  // would break the page while looking like a permissions bug — the rule is
  // "hide other people's customers", not "hide anything unrecognised".
  const rows = [{ id: "opt1", label: "Cash" }, { id: "s1", customerId: "c1" }];
  const { value } = filterPayload(rows, SCOPE, false);
  assert.equal(value.length, 2);
});

test("fetching one record you do not own is denied", () => {
  const { denied } = filterPayload({ id: "s9", customerId: "c9" }, SCOPE, false);
  assert.equal(denied, true);
});

test("fetching your own record is returned", () => {
  const { value, denied } = filterPayload({ id: "s1", customerId: "c1" }, SCOPE, false);
  assert.equal(denied, false);
  assert.equal(value.id, "s1");
});

// ── The failure directions ──────────────────────────────────────────────────

test("a brand-new salesperson sees the unclaimed book, not an empty screen", () => {
  // Nothing assigned to anyone → nothing forbidden → everything public. This is
  // what makes the rule usable on day one; the earlier "show me only mine"
  // reading gave a new joiner a blank system.
  const rows = [{ id: "s1", customerId: "c1" }, { id: "s2", customerId: "c2" }];
  const { value } = filterPayload(rows, { forbidden: new Set(), denyAll: false }, false);
  assert.equal(value.length, 2);
});

test("denyAll hides everything, including unassigned", () => {
  const rows = [{ id: "s1", customerId: "cX" }, { id: "s2" }];
  const { value } = filterPayload(rows, DENY_ALL, false);
  assert.deepEqual(value, []);
});

test("a database failure FAILS CLOSED", async () => {
  // Treating an error as "no filter" would turn a transient blip into a leak.
  const c = {
    get: (k) => (k === "userRole" ? "SALES" : "u1"),
    var: { DB: { prepare() { return { bind: () => ({ all: async () => { throw new Error("boom"); } }) }; } } },
  };
  const scope = await foreignCustomerIds(c);
  assert.equal(scope.denyAll, true, "must deny, not allow");
});

test("a scoped user with no id is denied, not waved through", async () => {
  const c = { get: (k) => (k === "userRole" ? "SALES" : ""), var: { DB: null } };
  const scope = await foreignCustomerIds(c);
  assert.equal(scope.denyAll, true);
});

test("an unscoped role is not filtered at all", async () => {
  // null, distinctly — the middleware returns early on it.
  for (const role of ["OFFICE", "FINANCE", "SUPER_ADMIN", "ADMIN", "QA"]) {
    const c = { get: (k) => (k === "userRole" ? role : "u1"), var: { DB: null } };
    assert.equal(await foreignCustomerIds(c), null, `${role} must not be filtered`);
  }
});

test("only SALES is scoped today", () => {
  assert.deepEqual([...SCOPED_ROLES], ["SALES"]);
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test("the middleware is registered ONCE, after auth", () => {
  // Bolting it onto 29 endpoints means 29 chances to miss one — and a missed
  // one renders another salesperson's customer list perfectly normally.
  const w = readFileSync(resolve(process.cwd(), "src/api/worker.ts"), "utf8");
  assert.equal(w.split("customerScopeMiddleware").length - 1, 2, "import + one use");
  const auth = w.indexOf('app.use("/api/*", authMiddleware);');
  const scope = w.indexOf('app.use("/api/*", customerScopeMiddleware);');
  assert.ok(auth > 0 && scope > auth, "must run AFTER auth — it needs userId and role");
});

test("a denied single record answers 404, not 403", () => {
  // 403 confirms the id exists, which is itself a disclosure when ids are
  // guessable.
  const src = readFileSync(resolve(process.cwd(), "src/api/lib/customer-scope.ts"), "utf8");
  assert.match(src, /status: 404/);
  assert.doesNotMatch(src, /status: 403/);
});

test("only GET responses are filtered", () => {
  // A response filter cannot police writes; that belongs where the write
  // happens. Pretending otherwise would be worse than not claiming it.
  const src = readFileSync(resolve(process.cwd(), "src/api/lib/customer-scope.ts"), "utf8");
  assert.match(src, /if \(c\.req\.method !== "GET"\) return;/);
});

test("the prefix list and the tested list agree", () => {
  // Asserted by CONTENT, not by count. A bare length made adding production
  // orders / service orders / service cases (owner 2026-08-05) look like a
  // regression while saying nothing about which modules are actually covered.
  assert.deepEqual([...SCOPED_PREFIXES].sort(), [
    "/api/consignments",
    "/api/customers",
    "/api/delivery-orders",
    "/api/delivery-returns",
    "/api/invoices",
    "/api/production-orders",
    "/api/sales-orders",
    "/api/service-cases",
    "/api/service-orders",
  ]);
});

// ── The write side ──────────────────────────────────────────────────────────
// The response filter hides other people's customers on the way OUT. It cannot
// stop a PUT on the way IN — owner: "他只是不能操作其他人的顾客."

test("a scoped role cannot edit a customer it does not own", () => {
  const src = readFileSync(resolve(process.cwd(), "src/api/routes/customers.ts"), "utf8");
  assert.match(src, /const foreign = await denyForeignCustomerWrite\(c, id\);/);
  assert.match(src, /if \(foreign\) return foreign;/);
});

test("the write guard refuses BEFORE the row is used", () => {
  // Checking after the update is built would still leak existence via timing
  // or a differing error, and risks the write landing.
  const src = readFileSync(resolve(process.cwd(), "src/api/routes/customers.ts"), "utf8");
  const put = src.slice(src.indexOf('app.put("/:id"'));
  const guard = put.indexOf("denyForeignCustomerWrite");
  const update = put.indexOf("UPDATE customers SET");
  assert.ok(guard > 0 && update > guard, "guard must precede the UPDATE");
});

test("a scoped role cannot reassign the salesperson", () => {
  // That is how an account would be handed away — or quietly taken.
  const src = readFileSync(resolve(process.cwd(), "src/api/routes/customers.ts"), "utf8");
  assert.match(src, /!canAssignSalesperson\(c\) \|\|/);
});

test("an unscoped role writes exactly as before", async () => {
  const { denyForeignCustomerWrite } = await import("../src/api/lib/customer-scope.ts");
  for (const role of ["OFFICE", "SUPER_ADMIN", "ADMIN"]) {
    const c = { get: (k) => (k === "userRole" ? role : "u1"), var: { DB: null }, json: () => "DENIED" };
    assert.equal(await denyForeignCustomerWrite(c, "c9"), null, `${role} must pass`);
  }
});

test("a scoped role writing its OWN customer passes", async () => {
  const { denyForeignCustomerWrite } = await import("../src/api/lib/customer-scope.ts");
  const c = {
    get: (k) => (k === "userRole" ? "SALES" : "u1"),
    // c9 is somebody else's; c1 is mine, cX is unassigned.
    var: { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ id: "c9" }] }) }) }) } },
    json: () => "DENIED",
  };
  assert.equal(await denyForeignCustomerWrite(c, "c1"), null, "own customer");
  assert.equal(await denyForeignCustomerWrite(c, "cX"), null, "unassigned is public");
  assert.equal(await denyForeignCustomerWrite(c, "c9"), "DENIED", "someone else's");
});

test("a scoped role owns what it creates", () => {
  // Owner: "谁去 key new potential，这个时候就会 assign 给那个人自己." Without
  // this a salesperson raises a Potential and the filter hides it the moment it
  // is saved — they would watch their own work vanish.
  const src = readFileSync(resolve(process.cwd(), "src/api/routes/customers.ts"), "utf8");
  assert.match(src, /forcedSalespersonOnCreate\(c\) \?\?/);
});
