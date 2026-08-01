// ---------------------------------------------------------------------------
// audit-coverage.test.mjs — structural pins for the audit gaps closed on
// feat/audit-critical-gaps.
//
// An audit of the API found that of ~55 route files carrying a DELETE
// handler, only ~7 emitted an audit event. The mutations left unrecorded
// were the ones that matter most: money moving (supplier payments, the
// BOUNCED receipt rollback), stock quantities being corrected by hand,
// accounts being created and deleted, pay rates being edited, and whole
// documents being destroyed with nothing left behind.
//
// These are STRUCTURAL pins, not behavioural ones — they read the route
// source and assert that the specific handler still contains an audit
// emit for the specific action. That is deliberate: the failure mode being
// guarded against is someone quietly deleting or refactoring away the emit
// during an unrelated edit, which no runtime test in this repo would
// notice. Behavioural coverage of emitAudit itself lives in audit.test.mjs.
//
// Also pinned: the 9 redundant `.catch(() => {})` wrappers that used to sit
// on already-awaited emitAudit calls. emitAudit never throws — it catches
// and console.warns internally — so the extra catch bought nothing and
// would have hidden a future failure completely.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) =>
  readFileSync(new URL(`../src/api/routes/${rel}`, import.meta.url), "utf8");

/**
 * Slice the source of ONE route handler: from `anchor` up to the start of
 * the next top-level `app.<verb>(` declaration. Keeps each assertion scoped
 * to its own handler so an emit added to a neighbouring route can't make a
 * pin pass by accident.
 */
function handler(src, anchor, file) {
  const start = src.indexOf(anchor);
  assert.ok(
    start !== -1,
    `${file}: handler anchor ${JSON.stringify(anchor)} not found — the route was renamed or removed`,
  );
  const next = src.indexOf("\napp.", start + anchor.length);
  return src.slice(start, next === -1 ? src.length : next);
}

/**
 * Assert one handler emits an audit event carrying `action`.
 *
 * `action` is matched as the literal source fragment inside the emit —
 * `action: "update"` for a fixed action, or `action,` for the two handlers
 * (payments + supplier-payments lifecycle) that forward the caller's
 * void/delete/unvoid verb through as a variable. Matching the literal
 * rather than the bare word keeps the pin from passing on an incidental
 * occurrence of e.g. "create" elsewhere in the handler.
 */
function pinAudit(src, anchor, action, file) {
  const body = handler(src, anchor, file);
  assert.match(
    body,
    /emitAudit\(\s*c\s*,/,
    `${file} ${anchor}: no emitAudit call in this handler`,
  );
  const literal = action === "action," ? "action," : `action: "${action}"`;
  assert.ok(
    body.includes(literal),
    `${file} ${anchor}: audit emit does not carry ${literal}`,
  );
}

// ---------------------------------------------------------------------------
// 1. purchase-orders — create was audited; the edit path (which owns the
//    SUBMITTED→CONFIRMED→RECEIVED commitments and can rewrite supplier and
//    prices) and the delete (which cascades the line items away) were not.
// ---------------------------------------------------------------------------
test("purchase-orders: PUT and DELETE emit audit events", () => {
  const src = read("purchase-orders.ts");
  pinAudit(src, 'app.put("/:id",', "update", "purchase-orders.ts");
  pinAudit(src, 'app.delete("/:id",', "delete", "purchase-orders.ts");
  // A delete's `before` is the only surviving record of the document.
  const del = handler(src, 'app.delete("/:id",', "purchase-orders.ts");
  assert.match(
    del,
    /before:\s*existing/,
    "purchase-orders.ts DELETE: audit must snapshot the pre-state, not just the id",
  );
});

// ---------------------------------------------------------------------------
// 2. payments — the customer receipt. PUT owns the BOUNCED transition that
//    reverses every allocated invoice's paidAmount, restores the customer's
//    outstandingSen and posts a GL reversal. lifecycle void/delete and the
//    in-place restate move the same money.
// ---------------------------------------------------------------------------
test("payments: PUT, lifecycle and restate emit audit events", () => {
  const src = read("payments.ts");
  pinAudit(src, 'app.put("/:id",', "update", "payments.ts");
  pinAudit(src, 'app.post("/:id/lifecycle",', "action,", "payments.ts");
  pinAudit(src, 'app.post("/:id/restate",', "restate", "payments.ts");
  // The BOUNCED rollback is computed from the pre-state allocations.
  const put = handler(src, 'app.put("/:id",', "payments.ts");
  assert.match(
    put,
    /before:\s*rowToPayment\(existing\)/,
    "payments.ts PUT: audit must snapshot the pre-bounce allocations",
  );
});

// ---------------------------------------------------------------------------
// 3. supplier-payments — cash leaving the bank to a supplier. All seven
//    mutating endpoints previously had ZERO audit coverage.
// ---------------------------------------------------------------------------
test("supplier-payments: all seven mutating endpoints emit audit events", () => {
  const src = read("supplier-payments.ts");
  const f = "supplier-payments.ts";
  assert.match(
    src,
    /import\s*\{\s*emitAudit\s*\}\s*from\s*"\.\.\/lib\/audit"/,
    `${f}: emitAudit must be imported`,
  );
  pinAudit(src, 'app.post("/",', "create", f);
  pinAudit(src, 'app.post("/knock-off",', "knock-off", f);
  pinAudit(src, 'app.post("/un-knock",', "un-knock", f);
  pinAudit(src, 'app.post("/:paymentNo/void",', "void", f);
  pinAudit(src, 'app.post("/:paymentNo/lifecycle",', "action,", f);
  pinAudit(src, 'app.post("/recompute-pi-paid",', "recompute-pi-paid", f);
  pinAudit(src, 'app.post("/:paymentNo/restate",', "restate", f);
});

// ---------------------------------------------------------------------------
// 4. stock-adjustments — direct, unapproved corrections to on-hand
//    quantities. The module header calls the audit trail "the safety net";
//    the safety net did not exist.
// ---------------------------------------------------------------------------
test("stock-adjustments: POST / emits an audit event with the pre-state qty", () => {
  const src = read("stock-adjustments.ts");
  pinAudit(src, 'app.post("/",', "create", "stock-adjustments.ts");
  const post = handler(src, 'app.post("/",', "stock-adjustments.ts");
  assert.match(
    post,
    /qty:\s*currentQty/,
    "stock-adjustments.ts POST: audit must snapshot the on-hand qty before the correction",
  );
});

// ---------------------------------------------------------------------------
// 5. grn — create and delete were already audited. The edit path owns the
//    DRAFT→POSTED flip that writes rm_batches and cost_ledger; the arrival
//    path owns the landed-cost inputs (FX rate, duty, shipping).
// ---------------------------------------------------------------------------
test("grn: PUT /:id and PUT /:id/arrival emit audit events", () => {
  const src = read("grn.ts");
  pinAudit(src, 'app.put("/:id",', "update", "grn.ts");
  pinAudit(src, 'app.put("/:id/arrival",', "arrival-update", "grn.ts");
});

// ---------------------------------------------------------------------------
// 6. users — a role CHANGE was audited, but minting an account (possibly
//    straight into a privileged role), deleting one, and plain profile /
//    isActive edits were not.
// ---------------------------------------------------------------------------
test("users: create, delete and non-role edits emit audit events", () => {
  const src = read("users.ts");
  pinAudit(src, 'app.post("/",', "create", "users.ts");
  pinAudit(src, 'app.delete("/:id",', "delete", "users.ts");
  const put = handler(src, 'app.put("/:id",', "users.ts");
  assert.ok(
    put.includes('action: "role-change"'),
    "users.ts PUT: the role-change audit must stay",
  );
  assert.ok(
    put.includes('action: "update"'),
    "users.ts PUT: a non-role profile / isActive edit must also be audited",
  );
  // Never let a password hash reach audit_events.
  assert.ok(
    !/before:\s*existing\s*,/.test(put) && put.includes("publicUser(existing)"),
    "users.ts PUT: audit snapshots must go through publicUser() so passwordHash is stripped",
  );
});

// ---------------------------------------------------------------------------
// 7. workers — delete and the PIN actions were audited; creating the payroll
//    record and editing salary / EPF / SOCSO / efficiency-bonus were not.
// ---------------------------------------------------------------------------
test("workers: POST / and PUT /:id emit audit events", () => {
  const src = read("workers.ts");
  pinAudit(src, 'app.post("/",', "create", "workers.ts");
  pinAudit(src, 'app.put("/:id",', "update", "workers.ts");
  const put = handler(src, 'app.put("/:id",', "workers.ts");
  assert.match(
    put,
    /before:\s*rowToWorker\(existing\)/,
    "workers.ts PUT: a pay-rate change must be traceable to its previous value",
  );
});

// ---------------------------------------------------------------------------
// 8. credit-notes / debit-notes — create was audited on both; the status
//    transition that fires the A/R cascade and posts the GL legs was not.
// ---------------------------------------------------------------------------
test("credit-notes and debit-notes: PUT /:id emits an audit event", () => {
  pinAudit(read("credit-notes.ts"), 'app.put("/:id",', "update", "credit-notes.ts");
  pinAudit(read("debit-notes.ts"), 'app.put("/:id",', "update", "debit-notes.ts");
});

// ---------------------------------------------------------------------------
// 9. The redundant silent catches are gone.
//
// Every one of these was `await emitAudit(c, {...}).catch(() => {})`.
// emitAudit already swallows and console.warns its own failures, so the
// extra catch was pure noise on the happy path and, on a future failure,
// would have discarded the one signal that something was wrong.
// ---------------------------------------------------------------------------
test("no emitAudit call is wrapped in a redundant silent catch", () => {
  for (const file of [
    "cnc-templates.ts",
    "cn-packing-lists.ts",
    "packing-lists.ts",
    "delivery-orders.ts",
  ]) {
    const src = read(file);
    assert.ok(
      src.includes("emitAudit("),
      `${file}: expected this file to still emit audit events`,
    );
    assert.ok(
      !src.includes("}).catch(() => {})"),
      `${file}: emitAudit already swallows and logs its own failures — ` +
        "the extra .catch(() => {}) hides a future audit failure entirely",
    );
  }
});
