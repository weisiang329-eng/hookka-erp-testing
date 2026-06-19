import { test } from "node:test";
import assert from "node:assert/strict";
import { nextState, hiddenTargets, needsReversal } from "../src/lib/lifecycle-machine.ts";

test("nextState transitions", () => {
  assert.equal(nextState("ACTIVE", "void"), "VOID");
  assert.equal(nextState("ACTIVE", "delete"), "DELETED");
  assert.equal(nextState("VOID", "unvoid"), "ACTIVE");
  assert.equal(nextState("VOID", "delete"), "DELETED");
  assert.equal(nextState("DELETED", "unvoid"), "ACTIVE");
  assert.equal(nextState("ACTIVE", "unvoid"), null);
  assert.equal(nextState("VOID", "void"), null);
  assert.equal(nextState("DELETED", "delete"), null);
});

test("hiddenTargets per state", () => {
  assert.deepEqual(hiddenTargets("ACTIVE"), { original: 0, reversal: 1 });
  assert.deepEqual(hiddenTargets("VOID"), { original: 0, reversal: 0 });
  assert.deepEqual(hiddenTargets("DELETED"), { original: 1, reversal: 1 });
});

test("needsReversal", () => {
  assert.equal(needsReversal("void"), true);
  assert.equal(needsReversal("delete"), true);
  assert.equal(needsReversal("unvoid"), false);
});
