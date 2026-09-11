// ---------------------------------------------------------------------------
// sequence-rule-unit — the BOM sequence rule, on its own.
//
// The rule landed on main ahead of the gate that refuses with it, because
// `scripts/backfill-skipped-completions.mjs` needs the SAME answer the gate
// will give: the backfill closes exactly the cases the gate would reject, and
// a second implementation would eventually close a different set.
//
// Nothing in the API imports it yet, so on main this module is inert. These
// tests exist so it cannot rot while it waits.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { sequenceBlockers, transitionConsumesUpstream } from "../src/api/lib/sequence-lock.ts";

const card = (id, dept, seq, status, branch = "", wip = "SOFA") => ({
  id, departmentCode: dept, sequence: seq, status, wipKey: wip, branchKey: branch,
});

test("a step waits for the one before it in its own branch", () => {
  const cards = [
    card("a", "WOOD_CUT", 1, "WAITING", "frame"),
    card("b", "FRAMING", 2, "WAITING", "frame"),
  ];
  assert.deepEqual(sequenceBlockers(cards[1], cards).map((b) => b.departmentCode), ["WOOD_CUT"]);
  cards[0].status = "COMPLETED";
  assert.equal(sequenceBlockers(cards[1], cards).length, 0);
});

test("a branch never waits for a parallel branch", () => {
  const cards = [
    card("a", "FAB_CUT", 1, "WAITING", "fabric"),
    card("b", "WOOD_CUT", 1, "WAITING", "frame"),
    card("c", "FRAMING", 2, "WAITING", "frame"),
  ];
  assert.deepEqual(sequenceBlockers(cards[2], cards).map((b) => b.departmentCode), ["WOOD_CUT"]);
});

test("a convergence step waits for every branch's LAST card", () => {
  // branchKey "" is the BOM's own mark for a step belonging to the whole
  // product — the owner's 「Upholstery 要完成的话，它需要 Foam Bonding、Fabric
  // Sewing，还有 Webbing 那一边都做好」.
  const cards = [
    card("f1", "FOAM", 1, "COMPLETED", "foam"),
    card("f2", "FOAM_BOND", 2, "WAITING", "foam"),
    card("s1", "FAB_SEW", 2, "WAITING", "fabric"),
    card("u", "UPHOLSTERY", 5, "WAITING", ""),
  ];
  const depts = sequenceBlockers(cards[3], cards).map((b) => b.departmentCode).sort();
  assert.deepEqual(depts, ["FAB_SEW", "FOAM_BOND"]);
});

test("cancelled upstream is never a dead end, and TRANSFERRED counts as done", () => {
  const cards = [
    card("a", "WOOD_CUT", 1, "CANCELLED", "frame"),
    card("b", "FRAMING", 2, "TRANSFERRED", "frame"),
    card("c", "WEBBING", 3, "WAITING", "frame"),
  ];
  assert.equal(sequenceBlockers(cards[2], cards).length, 0);
});

test("only a transition that consumes upstream is gated", () => {
  assert.equal(transitionConsumesUpstream("IN_PROGRESS"), true);
  assert.equal(transitionConsumesUpstream("COMPLETED"), true);
  assert.equal(transitionConsumesUpstream("WAITING"), false);
  assert.equal(transitionConsumesUpstream(null), false);
});
