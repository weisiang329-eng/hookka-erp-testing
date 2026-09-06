// ---------------------------------------------------------------------------
// wip-active-symmetry
//
// Three defects found while proving BUG-2026-09-06-177, all in the same shape:
// the cascade takes upstream stock on one transition and only knows how to give
// it back on a different one.
//
//   1. The forward consume fires on IN_PROGRESS as well as COMPLETED, but the
//      refund branch was gated on `wasDone && !isDone`. A card started and then
//      put back to WAITING kept its upstream consumed with nothing produced —
//      the row stayed down forever.
//   2. PAUSED was in neither set. IN_PROGRESS → PAUSED gave nothing back, and
//      PAUSED → IN_PROGRESS looked like a fresh start and consumed again.
//   3. The upstream row was resolved TWICE, by two different pieces of code:
//      the consume had four ways to find a merged FAB_CUT row, the refund had
//      one. A consume found through a fallback could not be reversed.
//
// All three were latent on the day they were fixed — measured on production,
// of 45,511 job cards 2 were IN_PROGRESS and 0 were PAUSED, so the floor goes
// WAITING → COMPLETED directly. They are fixed because the sequence lock gates
// IN_PROGRESS too, which will put real traffic through these paths.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync("src/api/routes/production-orders/_helpers.ts", "utf8");
const FN = SRC.slice(SRC.indexOf("export async function applyWipInventoryChange"));

const DERIVED = readFileSync("src/api/lib/wip-expected.ts", "utf8");

test("one definition of active, shared by the writer and the audit", () => {
  // The cascade MOVES the stock; wip-expected DERIVES what it should be, and
  // the reconcile report and the WIP reset are both built on the derivation.
  // Two definitions of "started" means the audit reports drift the cascade
  // never produced — so there is one, and the cascade imports it.
  const def = DERIVED.slice(
    DERIVED.indexOf("export const isWipActive"),
    DERIVED.indexOf("export function wipCardQty"),
  );
  for (const s of ["IN_PROGRESS", "PAUSED"]) {
    assert.match(def, new RegExp(`"${s}"`), `${s} must count as active`);
  }
  assert.match(def, /isWipDone\(status\)/, "COMPLETED / TRANSFERRED via isWipDone");
  assert.ok(!SRC.includes("const isActiveStatus ="), "no local restatement");
  assert.match(SRC, /^\s*isWipActive,$/m, "imported from wip-expected");
  assert.match(FN, /const becomingActive = isWipActive\(newStatus\);/);
  assert.match(FN, /const wasActive = isWipActive\(prevStatus\);/);
});

test("the consume guard reads that same definition, not its own list", () => {
  // It used to re-list IN_PROGRESS / COMPLETED / TRANSFERRED inline, which is
  // how PAUSED came to be missing from one list and not the other.
  const consume = FN.slice(FN.indexOf("double-consume guard"));
  assert.ok(
    !/const wasActive =\s*\n?\s*prevStatus === "IN_PROGRESS"/.test(consume),
    "no second inline list of active statuses",
  );
});

test("every step out of the active set gives the upstream back", () => {
  assert.match(FN, /if \(wasActive && !becomingActive\) \{/);
  assert.ok(
    !FN.includes("if (wasDone && !isDone) {"),
    "the narrow gate is gone — it was the bug",
  );
});

test("what is undone depends on how far the card got", () => {
  const branch = FN.slice(
    FN.indexOf("if (wasActive && !becomingActive) {"),
    FN.indexOf("double-consume guard"),
  );
  // Only a COMPLETED card produced its own row or could have settled the order.
  assert.match(branch, /if \(wasDone\) \{\s*\n\s*await unsettlePoTerminalWip/);
  assert.match(branch, /if \(isUpholstery && !wasDone\) return;/);
  assert.match(
    branch,
    /if \(wasDone\) \{[\s\S]{0,200}stockQty = stockQty - \? WHERE code = \?/,
    "the own-row subtract is completed-only",
  );
});

test("the upstream row is resolved in exactly one place", () => {
  assert.match(SRC, /async function resolveUpstreamWip\(/);
  const callers = SRC.match(/await resolveUpstreamWip\(/g) ?? [];
  assert.equal(callers.length, 2, "the consume and the refund");
  // The merged-FC fallback ladder is the part that had drifted. One copy only.
  const ladders = SRC.match(/Last-resort fallback: any FC JC on this PO/g) ?? [];
  assert.equal(ladders.length, 1);
  const walks = SRC.match(/For SOFA cross-PO: when this SEW row is on a sibling PO/g) ?? [];
  assert.equal(walks.length, 1, "the sibling-PO walk must not exist only on the consume side");
});

test("the refund hands back what the consume took, from the same card", () => {
  // Both sides read label and quantity off ONE card. A refund that guesses the
  // quantity is how `wipQty - 1` was left behind on every merged card.
  const helper = SRC.slice(
    SRC.indexOf("async function resolveUpstreamWip("),
    SRC.indexOf("export async function applyWipInventoryChange"),
  );
  assert.match(helper, /return \{ label: upstreamLabel, wipQty: upstreamWipQty \};/);
  assert.match(FN, /const refundLabel = up\.label;/);
  assert.match(FN, /const refundUpstreamWipQty = up\.wipQty;/);
});

test("still NOT fixed, and deliberately so: the writes are not org-scoped", () => {
  // `UPDATE wip_items … WHERE code = ?` with no org filter, while the insert
  // conflicts on (org_id, code). If a second organisation ever holds a row
  // under the same code, one company's production moves another's stock.
  //
  // It is left alone because the fix cannot be written honestly yet: the insert
  // does not name org_id at all, so it relies on the column default, and adding
  // `AND org_id = ?` with the wrong value would turn every cascade write into a
  // silent no-op. That needs a measurement of the live table (how many orgs
  // actually hold wip_items rows, and what the default put there), which the
  // HTTP surface does not expose. Recorded here so the gap is visible rather
  // than forgotten.
  const unscoped = SRC.match(/UPDATE wip_items SET stockQty[^`"]*WHERE code = \?/g) ?? [];
  assert.ok(unscoped.length >= 6, `still ${unscoped.length} unscoped writes — this test is the reminder`);
});
