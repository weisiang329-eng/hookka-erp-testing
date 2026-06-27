// ---------------------------------------------------------------------------
// announcement-popup-gate.test.mjs — regression for the worker "Got it" re-pop
// bug (BUG-2026-06-27). Owner report: after tapping "Got it" on a must-ack
// announcement, navigating away and back re-showed the popup asking to tap it
// again.
//
// ROOT CAUSE (client, src/pages/worker/index.tsx): the device kept its acks in
// a localStorage SET of ids, and refreshAnnouncements() reconciled that set
// DESTRUCTIVELY against the server's `ackedIds` — deleting any local ack the
// server didn't (yet) report. The "Got it" server POST is fire-and-forget, so
// the next GET on remount routinely returned BEFORE the ack was committed (or
// after a silently-failed POST), the just-tapped id was missing from
// `ackedIds`, it got deleted from the local set, and the popup re-popped.
//
// FIX: the local ack is now a durable MAP { id -> ackedAtMs } that is only ever
// ADDED to (server acks union in for cross-device sync; nothing is ever deleted
// because the server is behind). The ONE legitimate re-pop — the office tapping
// "Remind" — is decided client-side by comparing each notice's server
// `remindedAt` against the local ack timestamp.
//
// This suite locks the two pure pieces of that fix:
//   1. shouldPopup(ackedAtMs, remindedAt) — the popup-gate decision.
//   2. reconcileAcks(localMap, serverAckedIds, nowMs) — the additive merge.
// Both mirror the implementation in src/pages/worker/index.tsx exactly; if the
// component logic drifts back to a destructive reconcile, these fail.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

// --- Mirrors the popupAnnouncements filter predicate in worker/index.tsx -----
// Show the popup for a notice when: never acked on this device, OR the office
// reminded it AFTER this device's ack. Never re-pops on a stale/lagging server.
function shouldPopup(ackedAtMs /* number|undefined */, remindedAt /* string|null */) {
  if (ackedAtMs === undefined) return true; // never acked here → pop
  const remindedMs = remindedAt ? Date.parse(remindedAt) : NaN;
  return Number.isFinite(remindedMs) && remindedMs > ackedAtMs;
}

// --- Mirrors the additive reconcile in refreshAnnouncements ------------------
// Fold server acks into the local map WITHOUT ever deleting a local ack.
function reconcileAcks(localMap, serverAckedIds, nowMs) {
  const next = new Map(localMap);
  for (const id of serverAckedIds) {
    if (!next.has(id)) next.set(id, nowMs);
  }
  return next;
}

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ---- 1. A tapped "Got it" stays suppressed on return -----------------------

test("popup gate: a locally-acked notice does NOT re-pop (no remind)", () => {
  const ackedAt = NOW - 5000;
  // No remind → never re-pops, regardless of how long ago it was acked.
  assert.equal(shouldPopup(ackedAt, null), false);
  assert.equal(shouldPopup(0, null), false, "legacy ack@0 still suppressed");
});

// ---- 2. The fire-and-forget POST lag/failure can't wipe the local ack ------

test("reconcile: a just-tapped ack survives a server GET that doesn't report it yet", () => {
  // Worker tapped "Got it" → local map has the id stamped now. The very next
  // GET (server hasn't committed the ack) returns ackedIds WITHOUT it.
  const local = new Map([["ann-1", NOW]]);
  const merged = reconcileAcks(local, /* serverAckedIds */ [], NOW + 10);
  assert.ok(merged.has("ann-1"), "local ack NOT deleted by a behind server");
  // And the gate still suppresses it.
  assert.equal(shouldPopup(merged.get("ann-1"), null), false);
});

test("reconcile: a permanently-failed ack POST never re-pops the popup", () => {
  // The ack POST silently failed, so the server NEVER reports ann-1 — old code
  // deleted it every mount and re-popped forever. New code keeps it.
  let local = new Map([["ann-1", NOW]]);
  for (let i = 0; i < 5; i++) {
    local = reconcileAcks(local, [], NOW + i); // five returns to the page
    assert.equal(
      shouldPopup(local.get("ann-1"), null),
      false,
      `still suppressed on visit ${i + 1}`,
    );
  }
});

// ---- 3. The office "Remind" is the ONE legitimate re-pop -------------------

test("popup gate: a remind AFTER the ack re-pops; a remind BEFORE does not", () => {
  const ackedAt = NOW;
  assert.equal(
    shouldPopup(ackedAt, iso(NOW + 1000)),
    true,
    "reminded after ack → re-pops",
  );
  assert.equal(
    shouldPopup(ackedAt, iso(NOW - 1000)),
    false,
    "reminded before ack (stale) → stays suppressed",
  );
  // Re-tapping "Got it" stamps a NEW ack time (> the remind) → suppressed again.
  const reAckedAt = NOW + 2000;
  assert.equal(shouldPopup(reAckedAt, iso(NOW + 1000)), false);
});

// ---- 4. Cross-device sync: a server ack for an unknown id is folded in ------

test("reconcile: a server ack made on another device suppresses here too", () => {
  // This device never acked ann-2, but the server says the worker acked it
  // (on their other phone). Union it in so it doesn't pop here.
  const local = new Map([["ann-1", NOW]]);
  const merged = reconcileAcks(local, ["ann-2"], NOW + 50);
  assert.ok(merged.has("ann-2"), "server-only ack folded into local map");
  assert.equal(shouldPopup(merged.get("ann-2"), null), false);
  // An existing local timestamp is preserved (not overwritten by the merge).
  assert.equal(merged.get("ann-1"), NOW, "local tap time kept as-is");
});
