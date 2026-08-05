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
  ownedCustomerIds,
  SCOPED_ROLES,
  SCOPED_PREFIXES,
} from "../src/api/lib/customer-scope.ts";

const OWNED = new Set(["c1", "c2"]);

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
  const { value } = filterPayload(rows, OWNED, false);
  assert.deepEqual(value.map((r) => r.id), ["s1"]);
});

test("the customers list is judged on its OWN id", () => {
  const rows = [{ id: "c1" }, { id: "c9" }];
  const { value } = filterPayload(rows, OWNED, true);
  assert.deepEqual(value.map((r) => r.id), ["c1"]);
});

test("snake_case and camelCase customer keys are both honoured", () => {
  // A row read through a different path may come back either way; missing one
  // spelling silently lets those rows through.
  const rows = [{ id: "a", customer_id: "c9" }, { id: "b", customerId: "c9" }];
  const { value } = filterPayload(rows, OWNED, false);
  assert.deepEqual(value, []);
});

test("a row carrying NO customer is kept", () => {
  // These payloads also carry option lists, totals and config. Blanking them
  // would break the page while looking like a permissions bug — the rule is
  // "hide other people's customers", not "hide anything unrecognised".
  const rows = [{ id: "opt1", label: "Cash" }, { id: "s1", customerId: "c1" }];
  const { value } = filterPayload(rows, OWNED, false);
  assert.equal(value.length, 2);
});

test("fetching one record you do not own is denied", () => {
  const { denied } = filterPayload({ id: "s9", customerId: "c9" }, OWNED, false);
  assert.equal(denied, true);
});

test("fetching your own record is returned", () => {
  const { value, denied } = filterPayload({ id: "s1", customerId: "c1" }, OWNED, false);
  assert.equal(denied, false);
  assert.equal(value.id, "s1");
});

// ── The failure directions ──────────────────────────────────────────────────

test("owning nothing hides everything — it does not mean owning all", () => {
  // A brand-new salesperson with no customers assigned must see an empty list,
  // not the whole book. `null` (no scoping) and an EMPTY set are deliberately
  // different values for this reason.
  const rows = [{ id: "s1", customerId: "c1" }];
  const { value } = filterPayload(rows, new Set(), false);
  assert.deepEqual(value, []);
});

test("a database failure FAILS CLOSED", async () => {
  // Treating an error as "no filter" would turn a transient blip into a leak.
  const c = {
    get: (k) => (k === "userRole" ? "SALES" : "u1"),
    var: { DB: { prepare() { return { bind: () => ({ all: async () => { throw new Error("boom"); } }) }; } } },
  };
  const owned = await ownedCustomerIds(c);
  assert.ok(owned instanceof Set);
  assert.equal(owned.size, 0, "must deny, not allow");
});

test("a scoped user with no id is denied, not waved through", async () => {
  const c = { get: (k) => (k === "userRole" ? "SALES" : ""), var: { DB: null } };
  const owned = await ownedCustomerIds(c);
  assert.equal(owned.size, 0);
});

test("an unscoped role is not filtered at all", async () => {
  // null, distinctly — the middleware returns early on it.
  for (const role of ["OFFICE", "FINANCE", "SUPER_ADMIN", "ADMIN", "QA"]) {
    const c = { get: (k) => (k === "userRole" ? role : "u1"), var: { DB: null } };
    assert.equal(await ownedCustomerIds(c), null, `${role} must not be filtered`);
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
  assert.equal(SCOPED_PREFIXES.length, 6);
});
