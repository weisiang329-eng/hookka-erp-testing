// ---------------------------------------------------------------------------
// delivery-agent-auto-do.test.mjs — safety pins for the phase-3 red-line move:
// the Delivery Agent auto-OPENS DOs after self-approving its LOAD_PLANs
// (owner "B", 2026-07-28). See docs/plans/2026-07-28-delivery-agent-auto-open-do.md.
//
// This creates REAL delivery orders (FG/COGS), so the guardrails must never be
// silently refactored away. Structural pins (source assertions) in the style of
// service-hub-chain.test.mjs / production-overdue-counts.test.mjs — the behaviour
// runs through the office's own createDeliveryOrderForPOs, which its own suites
// already cover; here we lock that the AGENT path stays guarded + gated.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../src/api/routes/delivery-agent.ts", import.meta.url),
  "utf8",
);

// Isolate the auto-create function body.
function autoFn() {
  const start = src.indexOf("export async function autoCreateDosForApprovedLoadPlans");
  assert.ok(start >= 0, "autoCreateDosForApprovedLoadPlans must exist");
  const after = src.slice(start);
  const end = after.indexOf("\nexport async function runDeliveryAgent");
  return end < 0 ? after : after.slice(0, end);
}

test("gated: auto-open only runs inside the DELIVERY phase-3 (auto-approve) gate", () => {
  // The call must sit inside `if (await isAutoApproveOn(db, "DELIVERY")) { ... }`.
  const gateIdx = src.indexOf('isAutoApproveOn(db, "DELIVERY")');
  assert.ok(gateIdx >= 0, "phase-3 gate check must exist");
  const callIdx = src.indexOf("autoCreateDosForApprovedLoadPlans(db, orgId)");
  assert.ok(callIdx > gateIdx, "auto-open must be called after the gate opens");
  // And the next handler/decl after the gate block must come AFTER the call —
  // i.e. the call is within the gate block, not after it.
  const braceClose = src.indexOf("\n  }", gateIdx);
  assert.ok(
    callIdx < braceClose,
    "the auto-open call must be INSIDE the isAutoApproveOn block (default OFF)",
  );
});

test("acts only on states with a just-approved AGENT_AUTO LOAD_PLAN", () => {
  const fn = autoFn();
  assert.match(
    fn,
    /kind = 'LOAD_PLAN' AND status = 'APPROVED' AND decided_by = 'AGENT_AUTO'/,
    "must scope to approved AGENT_AUTO LOAD_PLANs (approval-driven)",
  );
});

test("never guesses a hub: groups with no resolved hub are skipped, not created", () => {
  const fn = autoFn();
  assert.match(
    fn,
    /if \(!so\.hubId \|\| !so\.hubId\.trim\(\)\) \{[\s\S]{0,120}?skippedNoHub\+\+;/,
    "a ready SO with no hub must increment skippedNoHub and `continue` (left for the office)",
  );
});

test("uses the office's SHARED guarded path — no hand-rolled DO INSERT", () => {
  const fn = autoFn();
  assert.match(
    fn,
    /createDeliveryOrderForPOs\(shim, \{/,
    "must create DOs through createDeliveryOrderForPOs (which runs validateDoComposition)",
  );
  assert.doesNotMatch(
    fn,
    /INSERT INTO delivery_orders/,
    "must NOT hand-roll a delivery_orders INSERT — reuse the guarded office path",
  );
});

test("opens the DO ONLY — no auto-invoice / dispatch / delivered", () => {
  const fn = autoFn();
  // Must not invoice, nor flip a DO to a dispatched/delivered status. (The
  // comment word "delivered-once" is a guard description, not an action, so we
  // target actual code: invoice creation + status writes.)
  assert.doesNotMatch(
    fn,
    /INSERT INTO invoices|createInvoice|generateInvoice|status\s*=\s*'(DISPATCHED|IN_TRANSIT|DELIVERED|INVOICED)'/,
    "auto-open must not invoice, dispatch, or mark delivered (those stay human)",
  );
  // Auto-created DOs are tagged so they're identifiable.
  assert.match(fn, /Auto-opened by Delivery Agent/, "auto-created DOs must carry the identifying remark");
});

test("has a per-run runaway cap", () => {
  const fn = autoFn();
  assert.match(fn, /MAX_PER_RUN/, "must cap DOs created per run as a runaway backstop");
});

test("header red-line comment records the phase-3 exception", () => {
  assert.match(
    src,
    /At PHASE 3 \(full-auto, owner-enabled\) the agent ALSO auto-opens the DO/,
    "the JD red-line header must document the 2026-07-28 phase-3 move",
  );
});
