// ---------------------------------------------------------------------------
// company-batch-reassign.test.mjs — Multi-Company Phase 4 bulk re-assign guard.
//
// Locks the decision core of POST /api/sales-orders/batch-company
// (`classifyBatchReassign` + `isCompanyReassignable` in
// src/lib/company-dimension.ts). The endpoint is a thin executor over this pure
// function, so pinning it here proves the two behaviours the owner cares about:
//
//   • LOCK GUARD — only EARLY-status SOs (DRAFT / CONFIRMED / ON_HOLD) are
//     moved; anything already in production / shipped / delivered / invoiced /
//     closed / cancelled is SKIPPED, never silently reassigned (its downstream
//     POs/DOs/invoices were booked under the original company).
//   • DEFAULT / no-op safety — a row already on the target company is a no-op
//     (moved=false), and an unknown status fails CLOSED (not reassignable).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let loaderRegistered = false;
try {
  register("tsx/esm", pathToFileURL("./"));
  loaderRegistered = true;
} catch {
  // Native type-stripping handles it on Node 22+.
}

let cd;
try {
  cd = await import(
    pathToFileURL(resolve(process.cwd(), "src/lib/company-dimension.ts")).href
  );
} catch (err) {
  console.warn(
    "[company-batch-reassign.test] Could not import module. " +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn("[company-batch-reassign.test] Error:", err?.message ?? err);
  throw err;
}

// ---------------------------------------------------------------------------
// isCompanyReassignable — the lock guard itself.
// ---------------------------------------------------------------------------
test("isCompanyReassignable: only DRAFT / CONFIRMED / ON_HOLD are reassignable", () => {
  for (const s of ["DRAFT", "CONFIRMED", "ON_HOLD"]) {
    assert.equal(cd.isCompanyReassignable(s), true, `expected ${s} reassignable`);
  }
  // case-insensitive
  assert.equal(cd.isCompanyReassignable("draft"), true);
  assert.equal(cd.isCompanyReassignable("  On_Hold "), true);
});

test("isCompanyReassignable: production / shipped / invoiced / terminal are LOCKED", () => {
  for (const s of [
    "IN_PRODUCTION",
    "READY_TO_SHIP",
    "SHIPPED",
    "DELIVERED",
    "INVOICED",
    "CLOSED",
    "CANCELLED",
  ]) {
    assert.equal(cd.isCompanyReassignable(s), false, `expected ${s} locked`);
  }
});

test("isCompanyReassignable: unknown / missing status fails CLOSED", () => {
  assert.equal(cd.isCompanyReassignable(""), false);
  assert.equal(cd.isCompanyReassignable(null), false);
  assert.equal(cd.isCompanyReassignable(undefined), false);
  assert.equal(cd.isCompanyReassignable("WHATEVER"), false);
});

// ---------------------------------------------------------------------------
// classifyBatchReassign — the full moved/skipped decision the endpoint runs.
// ---------------------------------------------------------------------------
test("classifyBatchReassign: moves early-status rows to the target company", () => {
  const out = cd.classifyBatchReassign(
    [
      { id: "so-1", companySOId: "SO-A", status: "DRAFT", currentCompany: "HOOKKA" },
      { id: "so-2", companySOId: "SO-B", status: "CONFIRMED", currentCompany: null },
      { id: "so-3", companySOId: "SO-C", status: "ON_HOLD", currentCompany: "HOUZS" },
    ],
    "OHANA",
  );
  assert.equal(out.length, 3);
  assert.ok(out.every((r) => r.moved === true), "all early-status rows move");
  // companySOId label carried through for the operator report.
  assert.deepEqual(
    out.map((r) => r.companySOId),
    ["SO-A", "SO-B", "SO-C"],
  );
});

test("classifyBatchReassign: LOCK GUARD skips post-production rows with a reason", () => {
  const out = cd.classifyBatchReassign(
    [
      { id: "so-1", companySOId: "SO-A", status: "DRAFT", currentCompany: "HOOKKA" },
      { id: "so-2", companySOId: "SO-B", status: "IN_PRODUCTION", currentCompany: "HOOKKA" },
      { id: "so-3", companySOId: "SO-C", status: "INVOICED", currentCompany: "HOOKKA" },
      { id: "so-4", companySOId: "SO-D", status: "CANCELLED", currentCompany: "HOOKKA" },
    ],
    "OHANA",
  );
  const byId = Object.fromEntries(out.map((r) => [r.id, r]));
  assert.equal(byId["so-1"].moved, true);
  // The three locked rows are skipped and NOT moved to OHANA.
  for (const id of ["so-2", "so-3", "so-4"]) {
    assert.equal(byId[id].moved, false, `${id} must be skipped`);
    assert.match(byId[id].reason, /Locked/, `${id} reason mentions Locked`);
  }
  // Exactly one row moves — the locked ones never leak into the UPDATE set.
  assert.equal(out.filter((r) => r.moved).length, 1);
});

test("classifyBatchReassign: a row already on the target is a no-op (moved=false, not an error)", () => {
  const out = cd.classifyBatchReassign(
    [
      { id: "so-1", companySOId: "SO-A", status: "DRAFT", currentCompany: "OHANA" },
      // pre-column row (null) defaults to HOOKKA — moving to HOOKKA is also a no-op
      { id: "so-2", companySOId: "SO-B", status: "DRAFT", currentCompany: null },
    ],
    "OHANA",
  );
  assert.equal(out[0].moved, false);
  assert.match(out[0].reason, /Already OHANA/);
  // so-2 (defaults HOOKKA) still MOVES to OHANA.
  assert.equal(out[1].moved, true);
});

test("classifyBatchReassign: pre-column HOOKKA no-op when target is HOOKKA", () => {
  const out = cd.classifyBatchReassign(
    [{ id: "so-1", companySOId: "SO-A", status: "CONFIRMED", currentCompany: null }],
    "HOOKKA",
  );
  assert.equal(out[0].moved, false);
  assert.match(out[0].reason, /Already HOOKKA/);
});

test("classifyBatchReassign: target is canonicalised (case-insensitive)", () => {
  const out = cd.classifyBatchReassign(
    [{ id: "so-1", companySOId: "SO-A", status: "DRAFT", currentCompany: "ohana" }],
    "ohana",
  );
  // stored 'ohana' vs target 'ohana' both normalise to OHANA → no-op.
  assert.equal(out[0].moved, false);
  assert.match(out[0].reason, /Already OHANA/);
});

test("classifyBatchReassign: empty input → empty output", () => {
  assert.deepEqual(cd.classifyBatchReassign([], "OHANA"), []);
});
