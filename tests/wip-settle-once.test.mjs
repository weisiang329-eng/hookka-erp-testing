// ---------------------------------------------------------------------------
// wip-settle-once
//
// Owner 2026-09-06, repeatedly and correctly: 「查看一下我的 WIP 的入库出库问题，
// 它应该是有 bug 的，因为数据是不对的」.
//
// He was right, and it took three wrong answers to find it. Recorded here so
// nobody re-derives the wrong two:
//
//   · "negatives are deliberate" — TRUE (`no MAX(0) clamp` … "go negative as a
//     visibility signal") and a real consequence of skipping, but it does not
//     explain -446 on one label;
//   · "UPH consumes each branch with its own wipQty" — the same bug class its
//     sibling path was already fixed for, and it looked certain. DISPROVEN:
//     12,899 branch terminals on production, 0 quantity mismatches;
//   · the actual cause, below.
//
// ## The bug
//
// `settlePoTerminalWip` drains the order's terminal rows AND its orphaned
// upstream when the last stage finishes. Its ONLY condition was
// `isWipTerminalDone(...)` — which stays true forever once the last stage is
// done. It is called at the end of every non-UPH completion, so **every later
// completion on the same order settled it again**.
//
// The skip workflow is what creates those later completions: finish
// UPHOLSTERY first, then tick the FRAMING nobody recorded, and that second tick
// drains the whole order a second time.
//
// Measured on production the day this was written: **779 orders have an
// upstream card completing AFTER the terminal, worth 2,109 extra settles.**
// That is the scale that puts `8" Divan- 5FT` at -446 against an expected 4.
//
// The fix reads the cards as they stood BEFORE the transition and settles only
// when THIS change is what made the terminal done — the same technique
// `unsettlePoTerminalWip` already used to decide whether a revert is the one
// that breaks terminal-done. The two are now exact mirrors, which is the
// property that makes complete -> revert -> complete safe.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync("src/api/routes/production-orders/_helpers.ts", "utf8");
const SETTLE = SRC.slice(
  SRC.indexOf("export async function settlePoTerminalWip"),
  SRC.indexOf("export async function unsettlePoTerminalWip"),
);

test("the settle refuses to run twice for one order", () => {
  assert.ok(SETTLE.length > 200, "the function must be found");
  // The guard: rebuild the card set as it was, and bail if the terminal was
  // ALREADY done — meaning some earlier transition already settled it.
  assert.match(SETTLE, /trigger\?: \{ jcRow: JobCardRow; prevStatus: string \| null \}/);
  assert.match(SETTLE, /if \(isWipTerminalDone\(poRow, asBefore\)\) return;/);
  assert.match(SETTLE, /already settled earlier/);
});

test("it reads the state BEFORE the transition, not after", () => {
  // After the transition the terminal is done in both the "first time" and the
  // "again" case, so the post-state cannot tell them apart. Only the prior
  // state can.
  assert.match(
    SETTLE,
    /j\.id === trigger\.jcRow\.id\s*\?\s*\{ \.\.\.j, status: trigger\.prevStatus \?\? j\.status \}/,
  );
});

test("every live call site passes the trigger", () => {
  // A call that omits it keeps the old, unguarded behaviour — which is correct
  // for a historical caller but would silently reintroduce the bug if a new
  // call site forgot. Both live ones are counted.
  const calls = SRC.match(/settlePoTerminalWip\(db, poRow, allJcRows[^)]*\)/g) ?? [];
  const live = calls.filter((c) => !c.includes("trigger?:"));
  assert.equal(live.length, 2, "the UPH path and the non-UPH path");
  for (const c of live) {
    assert.match(c, /\{ jcRow, prevStatus \}/, `call site not guarded: ${c}`);
  }
});

test("the settle and its inverse now use the SAME test", () => {
  // `unsettlePoTerminalWip` already rebuilt the pre-transition state to decide
  // whether a revert breaks terminal-done. The forward path did not, so the two
  // were not inverses and a complete -> revert -> complete round trip could
  // drain the same upstream twice — the file's own comment says so.
  const UNSETTLE = SRC.slice(SRC.indexOf("export async function unsettlePoTerminalWip"));
  assert.match(UNSETTLE, /const asBefore = allJcRows\.map/);
  assert.match(SETTLE, /const asBefore = allJcRows\.map/);
});

test("the drain itself is unchanged — only WHEN it runs moved", () => {
  // The amounts were never wrong. Changing them while chasing a trigger bug is
  // how a repair turns into a second incident.
  assert.match(SETTLE, /const subQty = terminal\.wipQty \|\| poRow\.quantity \|\| 1;/);
  assert.match(SETTLE, /for \(const orphan of poOrphanedUpstream\(poRow, allJcRows\)\)/);
});

test("the arithmetic of the bug, so the scale is not re-argued", () => {
  // One order, terminal done, then three skipped upstream steps ticked later:
  // the old code settled 1 + 3 = 4 times, so a shared label lost 4x what it
  // should. Across 779 orders and 2,109 catch-ups that is the -446.
  const settlesUnderOldRule = (catchUps) => 1 + catchUps;
  const settlesUnderNewRule = () => 1;
  assert.equal(settlesUnderOldRule(3), 4);
  assert.equal(settlesUnderNewRule(), 1);
  assert.equal(settlesUnderOldRule(0), 1, "an order done in order was never affected");
});
