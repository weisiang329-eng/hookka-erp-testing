// ---------------------------------------------------------------------------
// A lead-minted customer must belong to the org that raised the lead.
//
// THE BUG (found 2026-08-13): createPotentialCustomerForLead's INSERT listed
// every customer column EXCEPT orgId. `customers.orgId` is
// `NOT NULL DEFAULT 'hookka'` (migration 0049:32), so the row was still valid —
// it just silently belonged to HOOKKA. A lead raised in OHANA, HOUZS or HKMFG
// minted a HOOKKA customer, and nothing failed.
//
// Every other statement in sales-leads.ts is scoped `org_id = getOrgId(c)`.
// This one escaped because the helper took a bare `db` handle and so never had
// the request context to scope with — the omission was invisible at the call
// site, which is exactly why a test has to look at the SQL itself.
//
// WHY A SOURCE-TEXT TEST, AND WHAT THAT CANNOT DO
// There is no DB in unit tests, so this reads the route source. That has a real
// weakness worth naming: `tests/sales-leads.test.mjs` already claimed to prove
// this file "tenant-scoped" by matching `org_id = ?` ANYWHERE in it — and it
// passed all along while this INSERT was writing cross-org rows. A file-wide
// match proves nothing about a specific statement. So this test isolates the
// customers INSERT and asserts on THAT statement alone.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const SRC = readFileSync("src/api/routes/sales-leads.ts", "utf8");

/** The single `INSERT INTO customers (...) VALUES (...)` statement, comments stripped. */
function customersInsert() {
  const withoutComments = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const m = withoutComments.match(/INSERT INTO customers\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/);
  assert.ok(m, "expected exactly one INSERT INTO customers in sales-leads.ts");
  return { columns: m[1], values: m[2] };
}

test("the lead-minted customer INSERT names orgId", () => {
  const { columns } = customersInsert();
  assert.match(
    columns,
    /\borgId\b/,
    "INSERT INTO customers omits orgId — the row will silently take the SQL default 'hookka', " +
      "so a lead raised in any other org mints a HOOKKA customer",
  );
});

test("orgId is BOUND, not hard-coded to a literal org", () => {
  const { columns, values } = customersInsert();
  const cols = columns.split(",").map((s) => s.trim());
  const vals = values.split(",").map((s) => s.trim());
  assert.equal(cols.length, vals.length, "column/placeholder count must match");

  const i = cols.indexOf("orgId");
  assert.ok(i >= 0, "orgId column not found");
  assert.equal(
    vals[i],
    "?",
    `orgId is written as ${vals[i]} — a literal would reintroduce the bug in a form that ` +
      "merely LOOKS scoped. It has to be a bound parameter.",
  );
});

test("the helper receives an org argument from its caller", () => {
  assert.match(
    SRC,
    /createPotentialCustomerForLead\(\s*\n?\s*db: D1Database,\s*\n?\s*orgId: string,/,
    "helper must take orgId explicitly — taking only `db` is what hid the omission",
  );
  assert.match(
    SRC,
    /createPotentialCustomerForLead\(\s*c\.var\.DB\s*,\s*getOrgId\(c\)/,
    "call site must pass the REQUEST's org via getOrgId(c), not a constant",
  );
});

test("no lead statement writes a hard-coded org", () => {
  const withoutComments = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const literals = withoutComments.match(/['"](hookka|ohana|houzs|hkmfg)['"]/gi) ?? [];
  assert.deepEqual(
    literals,
    [],
    `hard-coded org literal(s) ${literals.join(", ")} in sales-leads.ts — the org must always ` +
      "come from getOrgId(c)",
  );
});
