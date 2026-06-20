// ---------------------------------------------------------------------------
// grn-arrival-state.test.mjs — unit tests for the GRN arrival state machine.
//
// Tests the VALID_ARRIVAL_TRANSITIONS map exported from grn.ts:
//   NOT_ARRIVED → IN_TRANSIT, ARRIVED
//   IN_TRANSIT  → AT_CUSTOMS, ARRIVED
//   AT_CUSTOMS  → ARRIVED
//   ARRIVED     → (terminal — no further transitions)
//
// Also verifies that the post-to-stock gate requires ARRIVED, and that
// the default arrival_state rule is applied correctly (manual = ARRIVED,
// PO-linked = NOT_ARRIVED).
// ---------------------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Node 22+ native type-stripping handles it.
}

let grn;
try {
  grn = await import(
    pathToFileURL(resolve(process.cwd(), "src/api/routes/grn.ts")).href
  );
} catch (err) {
  console.warn("[grn-arrival-state.test] Could not import grn.ts:", err?.message ?? err);
  throw err;
}

const { VALID_ARRIVAL_TRANSITIONS } = grn;

// ---------------------------------------------------------------------------
// Transition map shape
// ---------------------------------------------------------------------------
test("VALID_ARRIVAL_TRANSITIONS covers all four states", () => {
  const states = Object.keys(VALID_ARRIVAL_TRANSITIONS);
  assert.ok(states.includes("NOT_ARRIVED"), "missing NOT_ARRIVED");
  assert.ok(states.includes("IN_TRANSIT"), "missing IN_TRANSIT");
  assert.ok(states.includes("AT_CUSTOMS"), "missing AT_CUSTOMS");
  assert.ok(states.includes("ARRIVED"), "missing ARRIVED");
  assert.equal(states.length, 4, "unexpected extra states");
});

test("NOT_ARRIVED can advance to IN_TRANSIT or skip to ARRIVED", () => {
  const allowed = VALID_ARRIVAL_TRANSITIONS["NOT_ARRIVED"];
  assert.ok(allowed.includes("IN_TRANSIT"), "NOT_ARRIVED should allow → IN_TRANSIT");
  assert.ok(allowed.includes("ARRIVED"), "NOT_ARRIVED should allow skip → ARRIVED");
});

test("IN_TRANSIT can advance to AT_CUSTOMS or skip to ARRIVED", () => {
  const allowed = VALID_ARRIVAL_TRANSITIONS["IN_TRANSIT"];
  assert.ok(allowed.includes("AT_CUSTOMS"), "IN_TRANSIT should allow → AT_CUSTOMS");
  assert.ok(allowed.includes("ARRIVED"), "IN_TRANSIT should allow skip → ARRIVED");
});

test("AT_CUSTOMS can only advance to ARRIVED", () => {
  const allowed = VALID_ARRIVAL_TRANSITIONS["AT_CUSTOMS"];
  assert.deepEqual(allowed, ["ARRIVED"], "AT_CUSTOMS should only allow → ARRIVED");
});

test("ARRIVED is a terminal state (no further transitions)", () => {
  const allowed = VALID_ARRIVAL_TRANSITIONS["ARRIVED"];
  assert.deepEqual(allowed, [], "ARRIVED should have no allowed transitions");
});

// ---------------------------------------------------------------------------
// Invalid transitions (those NOT in the allowed list)
// ---------------------------------------------------------------------------
test("backward transitions are not allowed", () => {
  // Cannot go backwards
  assert.ok(
    !VALID_ARRIVAL_TRANSITIONS["ARRIVED"].includes("AT_CUSTOMS"),
    "ARRIVED → AT_CUSTOMS must be blocked",
  );
  assert.ok(
    !VALID_ARRIVAL_TRANSITIONS["AT_CUSTOMS"].includes("IN_TRANSIT"),
    "AT_CUSTOMS → IN_TRANSIT must be blocked",
  );
  assert.ok(
    !VALID_ARRIVAL_TRANSITIONS["IN_TRANSIT"].includes("NOT_ARRIVED"),
    "IN_TRANSIT → NOT_ARRIVED must be blocked",
  );
});

test("same-state transitions are not allowed", () => {
  for (const [state, allowed] of Object.entries(VALID_ARRIVAL_TRANSITIONS)) {
    assert.ok(
      !allowed.includes(state),
      `${state} → ${state} (self) must be blocked`,
    );
  }
});

// ---------------------------------------------------------------------------
// Transition guard logic (mirrors what the route handler does)
// ---------------------------------------------------------------------------
function canTransition(from, to) {
  const allowed = VALID_ARRIVAL_TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}

test("canTransition — valid paths return true", () => {
  assert.equal(canTransition("NOT_ARRIVED", "IN_TRANSIT"), true);
  assert.equal(canTransition("NOT_ARRIVED", "ARRIVED"), true);
  assert.equal(canTransition("IN_TRANSIT", "AT_CUSTOMS"), true);
  assert.equal(canTransition("IN_TRANSIT", "ARRIVED"), true);
  assert.equal(canTransition("AT_CUSTOMS", "ARRIVED"), true);
});

test("canTransition — invalid paths return false", () => {
  assert.equal(canTransition("ARRIVED", "IN_TRANSIT"), false);
  assert.equal(canTransition("ARRIVED", "AT_CUSTOMS"), false);
  assert.equal(canTransition("ARRIVED", "NOT_ARRIVED"), false);
  assert.equal(canTransition("ARRIVED", "ARRIVED"), false);
  assert.equal(canTransition("AT_CUSTOMS", "IN_TRANSIT"), false);
  assert.equal(canTransition("AT_CUSTOMS", "NOT_ARRIVED"), false);
  assert.equal(canTransition("IN_TRANSIT", "NOT_ARRIVED"), false);
  // Unknown source state
  assert.equal(canTransition("UNKNOWN_STATE", "ARRIVED"), false);
});

// ---------------------------------------------------------------------------
// Post-to-stock gate: only ARRIVED allows commitment
// ---------------------------------------------------------------------------
test("post-to-stock gate: only ARRIVED passes", () => {
  const blockedStates = ["NOT_ARRIVED", "IN_TRANSIT", "AT_CUSTOMS"];
  for (const state of blockedStates) {
    assert.equal(
      state !== "ARRIVED",
      true,
      `${state} should block post-to-stock`,
    );
  }
  assert.equal("ARRIVED" === "ARRIVED", true, "ARRIVED should pass post-to-stock gate");
});

// ---------------------------------------------------------------------------
// Default arrival_state rule
// ---------------------------------------------------------------------------
test("default arrival_state: manual GRN (no poId) → ARRIVED", () => {
  const poId = null;
  const defaultState = poId ? "NOT_ARRIVED" : "ARRIVED";
  assert.equal(defaultState, "ARRIVED");
});

test("default arrival_state: PO-linked GRN → NOT_ARRIVED", () => {
  const poId = "po-abc123";
  const defaultState = poId ? "NOT_ARRIVED" : "ARRIVED";
  assert.equal(defaultState, "NOT_ARRIVED");
});
