// ---------------------------------------------------------------------------
// pi-status-check-single-source.test.mjs — two lists, one constraint, one outage.
//
// Owner 2026-08-04, after several rounds of "still can't create":
// "还是不行啊，你不能根本解决一下吗？"
//
// The status CHECK on purchase_invoices was defined in TWO places with two
// DIFFERENT lists:
//
//   purchase-invoices.ts   ('DRAFT','CONFIRMED','PAID','CANCELLED',
//                            'PENDING_APPROVAL','APPROVED')      ← no PARTIAL_PAID
//   ensure-partial-payment.ts  … ,'PARTIAL_PAID', …              ← has it
//
// Both DROP the constraint and re-ADD their own version on every isolate boot.
// The moment ONE supplier payment moved an invoice to PARTIAL_PAID (prod had
// exactly 2), the first list could never be applied again: Postgres refuses to
// add a CHECK that existing rows violate.
//
// That ALTER runs inside `runSelfApply`, which THROWS on a real failure, and it
// is awaited at the top of the create handler — so EVERY purchase invoice
// create failed from that point on. Nothing said why, because the throw reached
// the global 500 handler, which strips messages that could leak schema names.
//
// A shared constant is the fix, not a corrected duplicate: two lists that must
// agree will drift again.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PI_STATUS_CHECK_SQL } from "../src/api/lib/ensure-partial-payment.ts";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const ROUTE = read("src/api/routes/purchase-invoices.ts");
const LIB = read("src/api/lib/ensure-partial-payment.ts");

test("PARTIAL_PAID is in the list — the value that caused the outage", () => {
  const add = PI_STATUS_CHECK_SQL.find((s) => s.includes("ADD CONSTRAINT"));
  assert.ok(add, "the list must actually re-add a constraint");
  assert.match(add, /'PARTIAL_PAID'/);
});

test("every status prod actually holds is accepted", () => {
  // Observed on prod 2026-08-04: CONFIRMED 223, PAID 124, PARTIAL_PAID 2.
  // Plus the lifecycle values the app still writes.
  const add = PI_STATUS_CHECK_SQL.find((s) => s.includes("ADD CONSTRAINT"));
  for (const st of [
    "DRAFT", "PENDING_APPROVAL", "APPROVED", "CONFIRMED",
    "PARTIAL_PAID", "PAID", "CANCELLED",
  ]) {
    assert.ok(add.includes(`'${st}'`), `${st} must be accepted`);
  }
});

test("the route no longer keeps its own list", () => {
  assert.equal(
    ROUTE.split("ADD CONSTRAINT purchase_invoices_status_chk").length - 1,
    0,
    "a second definition is what drifted and broke creates",
  );
  assert.match(ROUTE, /\.\.\.PI_STATUS_CHECK_SQL,/);
  assert.match(ROUTE, /import \{ PI_STATUS_CHECK_SQL \} from "\.\.\/lib\/ensure-partial-payment"/);
});

test("the lib uses the shared list too, so neither can drift", () => {
  assert.match(LIB, /\.\.\.PI_STATUS_CHECK_SQL,/);
  assert.equal(
    LIB.split("ADD CONSTRAINT purchase_invoices_status_chk_v2").length - 1,
    1,
    "exactly one place may define it",
  );
});

test("both legacy constraint names are dropped before the re-add", () => {
  // The inline CHECK from 0057 is <table>_<column>_check; the live prod one is
  // <table>_status_chk. A stale restrictive one left behind rejects
  // PARTIAL_PAID no matter what the new constraint says.
  const joined = PI_STATUS_CHECK_SQL.join("\n");
  for (const name of [
    "purchase_invoices_status_check",
    "purchase_invoices_status_chk",
    "purchase_invoices_status_chk_v2",
  ]) {
    assert.ok(
      joined.includes(`DROP CONSTRAINT IF EXISTS ${name}`),
      `${name} must be dropped first`,
    );
  }
  const addIdx = PI_STATUS_CHECK_SQL.findIndex((s) => s.includes("ADD CONSTRAINT"));
  assert.equal(addIdx, PI_STATUS_CHECK_SQL.length - 1, "the ADD must come last");
});

test("no OTHER module re-adds this constraint", () => {
  // The whole class: a second writer with its own list.
  const hits = [];
  for (const f of [
    "src/api/routes/purchase-invoices.ts",
    "src/api/routes/supplier-payments.ts",
    "src/api/routes/accounting.ts",
  ]) {
    if (read(f).includes("ADD CONSTRAINT purchase_invoices_status")) hits.push(f);
  }
  assert.deepEqual(hits, [], `these still define it themselves:\n${hits.join("\n")}`);
});
