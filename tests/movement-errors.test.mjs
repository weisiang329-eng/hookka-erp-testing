// ---------------------------------------------------------------------------
// movement-errors.test.mjs — a write whose DOCUMENT saved but whose downstream
// MOVEMENT failed must say so.
//
// Houzs-ERP's api-fetch-hardening COE calls this shape "doc posted, stock never
// moved". Two instances here, both `console.error` and carry on:
//
//   · production-orders/_helpers.ts — a FAB_CUT job card completes, the
//     raw-material consume throws, so the meters never leave the roll in the
//     books and no RM_ISSUE reaches the cost ledger. The operator sees a clean
//     save.
//   · purchase-orders.ts — the intercompany mirror throws, so the SISTER
//     COMPANY has no order at all, and this side answers 201.
//
// The cascades must NOT roll the document back — the cutting physically
// happened. The fix is to stop hiding the failure, not to fail the save.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const po = readFileSync("src/api/routes/production-orders/_helpers.ts", "utf8");
const purch = readFileSync("src/api/routes/purchase-orders.ts", "utf8");
const client = readFileSync("src/lib/api-client.ts", "utf8");
const toast = readFileSync("src/components/ui/toast.tsx", "utf8");

test("a failed raw-material consume reaches the response", () => {
  assert.match(po, /movementErrors\.push\(`Raw-material consumption failed: \$\{msg\}`\)/);
  // Still caught — the job card stays committed.
  assert.match(po, /await consumeRawMaterialsForPO\(db, existing\.id\);/);
});

test("a failed intercompany mirror reaches the response", () => {
  assert.match(purch, /mirrorError = `Intercompany mirror not created: \$\{msg\}`/);
  assert.match(purch, /movementErrors: \[mirrorError\]/);
});

test("the field is ADDITIVE — absent when everything cascaded", () => {
  // An always-present empty array would change every existing response body.
  assert.match(
    po,
    /movementErrors\.length > 0\s*\n\s*\? \{ success: true, data: fresh, movementErrors \}\s*\n\s*: \{ success: true, data: fresh \}/,
  );
  assert.match(
    purch,
    /mirrorError\s*\n\s*\? \{ success: true, data: created, movementErrors: \[mirrorError\] \}\s*\n\s*: \{ success: true, data: created \}/,
  );
});

test("it is surfaced centrally, so a new route needs no call-site change", () => {
  assert.match(client, /hookka:movement-error/);
  // The body must be read off a CLONE — consuming it would break every caller.
  assert.match(client, /await response\.clone\(\)\.json\(\)/);
  assert.match(toast, /window\.addEventListener\("hookka:movement-error"/);
});

test("it warns, it does not claim the save failed", () => {
  // The document really did save. Saying "error" would be a different lie from
  // the one this fixes.
  assert.match(toast, /addToast\("warning", detail\)/);
});
