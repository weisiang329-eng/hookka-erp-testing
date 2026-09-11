// ---------------------------------------------------------------------------
// sequence-lock
//
// Owner 2026-09-06: 「上一道工序还没 mark complete，就不能 mark 下一道 complete」.
// Skipping is what drives WIP negative — a step that starts before its upstream
// produced consumes a row nothing filled, and the cascade deliberately does not
// clamp that at zero. Measured the same day: 513 negative rows, and 46 cards
// already completed out of order across 20 live production orders.
//
// The shapes below are the REAL ones, taken off production, not invented:
//
//   · a sofa chain with two branches — fabric (FAB_CUT → FAB_SEW) and wood
//     (WOOD_CUT → FRAMING → WEBBING) — converging on UPHOLSTERY, then PACKING;
//   · UPHOLSTERY and PACKING carry an EMPTY branchKey, which is how the BOM
//     marks a step belonging to the whole product rather than to one branch;
//   · two different departments sharing one sequence number (142 branches on
//     production do this).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  sequenceBlockers,
  transitionConsumesUpstream,
  blockerMessage,
} from "../src/api/lib/sequence-lock.ts";

// A real sofa BOM shape. branchKey "" = top-level (convergence).
const sofa = (over = {}) => {
  const base = {
    fc: { id: "fc", departmentCode: "FAB_CUT", sequence: 0, wipKey: "S", branchKey: "(FC)", status: "WAITING" },
    fs: { id: "fs", departmentCode: "FAB_SEW", sequence: 1, wipKey: "S", branchKey: "(FC)", status: "WAITING" },
    wc: { id: "wc", departmentCode: "WOOD_CUT", sequence: 0, wipKey: "S", branchKey: "(WD)", status: "WAITING" },
    fr: { id: "fr", departmentCode: "FRAMING", sequence: 1, wipKey: "S", branchKey: "(WD)", status: "WAITING" },
    wb: { id: "wb", departmentCode: "WEBBING", sequence: 2, wipKey: "S", branchKey: "(WD)", status: "WAITING" },
    fo: { id: "fo", departmentCode: "FOAM", sequence: 3, wipKey: "S", branchKey: "(WD)", status: "WAITING" },
    uph: { id: "uph", departmentCode: "UPHOLSTERY", sequence: 4, wipKey: "S", branchKey: "", status: "WAITING" },
    pack: { id: "pack", departmentCode: "PACKING", sequence: 5, wipKey: "S", branchKey: "", status: "WAITING" },
  };
  for (const [k, v] of Object.entries(over)) base[k] = { ...base[k], ...v };
  return base;
};
const all = (m) => Object.values(m);
const depts = (bs) => bs.map((b) => b.departmentCode);

// --- the branch's own chain ------------------------------------------------
test("the first step of a branch is never blocked", () => {
  const m = sofa();
  assert.deepEqual(sequenceBlockers(m.fc, all(m)), []);
  assert.deepEqual(sequenceBlockers(m.wc, all(m)), []);
});

test("a step waits for the one before it in its OWN branch", () => {
  const m = sofa();
  assert.deepEqual(depts(sequenceBlockers(m.fs, all(m))), ["FAB_CUT"]);
  assert.deepEqual(depts(sequenceBlockers(m.wb, all(m))), ["WOOD_CUT", "FRAMING"]);
});

test("a branch does NOT wait for the other branch", () => {
  // The whole reason branchKey exists. DEPT_ORDER lists WOOD_CUT after FAB_SEW,
  // so ignoring branches blocks wood cutting on fabric sewing — 415 wrong
  // blocks when simulated over the live orders (WOOD_CUT <- FAB_SEW alone was
  // 322 of them). Wood does not wait for fabric.
  const m = sofa({ fc: { status: "WAITING" }, fs: { status: "WAITING" } });
  assert.deepEqual(sequenceBlockers(m.wc, all(m)), [], "wood cut is independent");
  assert.deepEqual(
    depts(sequenceBlockers(m.fr, all(m))),
    ["WOOD_CUT"],
    "framing waits on wood only, never on fabric",
  );
});

// --- convergence — the owner's own sentence --------------------------------
test("UPHOLSTERY waits for every branch: FAB_SEW + FOAM + WEBBING", () => {
  // 「例如 Upholstery 要完成的话，它需要 Foam Bonding、Fabric Sewing，还有包括
  //   Webbing 那一边都做好」 — measured on production the same rule produced
  //   UPHOLSTERY <- FAB_SEW 256, <- FOAM 202, <- WEBBING 138.
  const m = sofa({
    fc: { status: "COMPLETED" },
    wc: { status: "COMPLETED" },
    fr: { status: "COMPLETED" },
    wb: { status: "COMPLETED" },
    fo: { status: "WAITING" },
    fs: { status: "WAITING" },
  });
  // Both branch terminals are open: fabric's is FAB_SEW, wood's is FOAM.
  assert.deepEqual(depts(sequenceBlockers(m.uph, all(m))).sort(), ["FAB_SEW", "FOAM"]);
});

test("a convergence step names the branch TERMINAL, not every card in it", () => {
  // Telling the operator to chase WOOD_CUT when FOAM is what is next would send
  // them to the wrong bench.
  const m = sofa({ fs: { status: "COMPLETED" }, fc: { status: "COMPLETED" } });
  assert.deepEqual(
    depts(sequenceBlockers(m.uph, all(m))),
    ["FOAM"],
    "the wood branch's last step only",
  );
});

test("every branch done unlocks the convergence step", () => {
  const done = { status: "COMPLETED" };
  const m = sofa({ fc: done, fs: done, wc: done, fr: done, wb: done, fo: done });
  assert.deepEqual(sequenceBlockers(m.uph, all(m)), []);
  assert.deepEqual(depts(sequenceBlockers(m.pack, all(m))), ["UPHOLSTERY"]);
});

test("TRANSFERRED counts as done, like everywhere else in the repo", () => {
  const m = sofa({ fc: { status: "TRANSFERRED" } });
  assert.deepEqual(sequenceBlockers(m.fs, all(m)), []);
});

// --- the traps -------------------------------------------------------------
test("cards at the SAME sequence never block each other", () => {
  // 142 branches on production carry two different departments on one sequence
  // number. Ordering them would be a coin flip, so they run in parallel.
  const m = sofa({ fo: { sequence: 2 } }); // FOAM now ties with WEBBING
  assert.equal(
    depts(sequenceBlockers(m.fo, all(m))).includes("WEBBING"),
    false,
    "a tie is parallel, not an order",
  );
  assert.equal(
    depts(sequenceBlockers(m.wb, all(m))).includes("FOAM"),
    false,
    "and it is symmetric",
  );
});

test("a CANCELLED upstream never holds anything back", () => {
  // Otherwise the card is stuck forever and the floor routes around the system,
  // which is worse than no lock. Measured 2026-09-06: 0 cards sit behind a
  // cancelled upstream today, and this keeps it that way.
  const m = sofa({ fc: { status: "CANCELLED" } });
  assert.deepEqual(sequenceBlockers(m.fs, all(m)), []);
});

test("a different wipKey is a different product and never interferes", () => {
  const m = sofa();
  const other = { id: "x", departmentCode: "WOOD_CUT", sequence: 0, wipKey: "OTHER", branchKey: "(WD)", status: "WAITING" };
  assert.deepEqual(sequenceBlockers(m.fs, [...all(m), other]), sequenceBlockers(m.fs, all(m)));
});

test("the card never blocks itself", () => {
  const m = sofa({ fs: { status: "WAITING" } });
  assert.equal(sequenceBlockers(m.fs, all(m)).some((b) => b.id === "fs"), false);
});

// --- the transition the lock must cover ------------------------------------
test("STARTING consumes upstream too, so it is gated as well", () => {
  // _helpers.ts drains the upstream row on `becomingActive` — IN_PROGRESS or
  // COMPLETED, whichever lands first. Gating only completion leaves the hole
  // open and the negative rows keep appearing.
  assert.equal(transitionConsumesUpstream("IN_PROGRESS"), true);
  assert.equal(transitionConsumesUpstream("COMPLETED"), true);
  assert.equal(transitionConsumesUpstream("TRANSFERRED"), true);
  assert.equal(transitionConsumesUpstream("WAITING"), false);
  assert.equal(transitionConsumesUpstream("PAUSED"), false);
  assert.equal(transitionConsumesUpstream(null), false);
});

// --- operator-facing copy --------------------------------------------------
test("the message is English and names what to do", () => {
  // Repo rule: the UI is 100% English.
  assert.equal(
    blockerMessage([{ id: "a", departmentCode: "WOOD_CUT", status: "WAITING" }]),
    "WOOD_CUT must be completed first.",
  );
  assert.equal(
    blockerMessage([
      { id: "a", departmentCode: "FAB_SEW", status: "WAITING" },
      { id: "b", departmentCode: "FOAM", status: "WAITING" },
    ]),
    "These must be completed first: FAB_SEW, FOAM.",
  );
  assert.equal(blockerMessage([]), "");
  assert.doesNotMatch(
    blockerMessage([{ id: "a", departmentCode: "FOAM", status: "WAITING" }]),
    /[一-鿿]/,
    "no Chinese in operator-facing copy",
  );
});

// --- the flag that must stay untouched -------------------------------------
test("prerequisiteMet is never read", () => {
  // It is stamped once at card creation and never rolled forward. On production
  // 4,680 of 4,967 active cards read 0, of which 1,673 have nothing upstream at
  // all and 938 have upstream already done — at least 2,611 false. Reading it
  // would stop every department except the first, which is exactly why the
  // 2026-06-08 attempt (760d08b3) had to be removed.
  const src = readFileSync("src/api/lib/sequence-lock.ts", "utf8");
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(/prerequisiteMet/.test(code), false);
});

test("no hardcoded department order lives here", () => {
  // 「记得你的这整个流程不可以写死的，应该是根据我的 BOM 的变化的」.
  // The graph comes from branchKey + sequence, which the BOM stamped onto the
  // cards. Importing the build-time chain table would reintroduce exactly the
  // fixed list the owner rejected.
  const src = readFileSync("src/api/lib/sequence-lock.ts", "utf8");
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const forbidden of ["DEPT_ORDER", "PRODUCTION_ORDER_BY_WIP_TYPE", "UPHOLSTERY", "WOOD_CUT"]) {
    assert.equal(code.includes(forbidden), false, `${forbidden} must not appear in the rule`);
  }
});

// --- every way in is gated -------------------------------------------------
test("all FOUR completion paths are gated, and the count is pinned", () => {
  // A gate on three of four surfaces just moves the skipping to the fourth.
  // This repo's documented failure mode is fixing the instance in front of you
  // and missing its twins, so the sites are COUNTED, not spot-checked.
  const po = readFileSync("src/api/routes/production-orders.ts", "utf8");
  const helpers = readFileSync("src/api/routes/production-orders/_helpers.ts", "utf8");

  // Desktop: bulk-patch loops back into PATCH /:id -> applyPoUpdate, so gating
  // applyPoUpdate covers the grid AND the batch date stamp in one place.
  assert.match(helpers, /transitionConsumesUpstream\(body\.status\)/);
  assert.match(helpers, /sequenceBlockers\(jcRow, allJcRows\)/);

  // Shop floor: the single-card scan inline, plus both fan-outs through one
  // shared helper.
  assert.match(po, /sequenceBlockers\(scannedJc, siblings\.results \?\? \[\]\)/);
  assert.equal(
    (po.match(/gateFanOutSequence\(db, c, poId, cards, body\)/g) ?? []).length,
    2,
    "scan-complete-dept AND scan-complete-shared",
  );

  // And every refusal carries the same contract the UI keys off.
  assert.equal((po.match(/code: "UPSTREAM_INCOMPLETE"/g) ?? []).length, 2);
  assert.match(helpers, /code: "UPSTREAM_INCOMPLETE"/);
});

test("a pure date edit is never blocked", () => {
  // The 2026-04-26 lock was disabled partly because it 409'd date edits on a
  // branch that was not even involved. Only a transition that actually consumes
  // upstream WIP is gated.
  const helpers = readFileSync("src/api/routes/production-orders/_helpers.ts", "utf8");
  assert.match(helpers, /if \(transitionConsumesUpstream\(body\.status\)\) \{/);
});

test("the stale note that contradicted the lock is gone", () => {
  // It said workers may complete any dept directly and there is no
  // "earlier dept hasn't completed" gate. That is the permission this change
  // withdraws; leaving the sentence would have left the file arguing with
  // itself, which is how the next reader ends up trusting the wrong half.
  const po = readFileSync("src/api/routes/production-orders.ts", "utf8");
  assert.equal(/prerequisiteMet warning REMOVED/.test(po), false);
  assert.equal(/no "earlier dept hasn't completed" gate/.test(po), false);
});

test("every unlock is recorded, and the audit never blocks the work", () => {
  const helpers = readFileSync("src/api/routes/production-orders/_helpers.ts", "utf8");
  assert.match(helpers, /INSERT INTO scan_override_audit/);
  // Non-fatal: refusing a completion because a log line failed would stop the
  // factory for the sake of the record.
  assert.match(helpers, /audit write failed \(work still applied\)/);
});

test("the audit writes a code the audit table accepts (BUG-2026-09-07-179)", () => {
  // `scan_override_audit.override_code` carries a CHECK from migration 0022
  // allowing exactly PREREQUISITE_NOT_MET / UPSTREAM_LOCKED. Inserting the
  // client-facing refusal code throws — and because the write above is
  // non-fatal BY DESIGN, it threw silently on every unlock, which would have
  // left the weekly review permanently empty and looking like nobody ever
  // unlocked anything. Measured on production by an insert that actually ran.
  const helpers = readFileSync("src/api/routes/production-orders/_helpers.ts", "utf8");
  const insert = helpers.slice(
    helpers.indexOf("INSERT INTO scan_override_audit"),
    helpers.indexOf("INSERT INTO scan_override_audit") + 400,
  );
  assert.match(insert, /'UPSTREAM_LOCKED'/);
  assert.equal(/'UPSTREAM_INCOMPLETE'/.test(insert), false);
  // The refusal the CLIENT sees keeps its own, more precise code — the two are
  // different vocabularies and only one of them is constrained by a table.
  assert.match(helpers, /code: "UPSTREAM_INCOMPLETE"/);
});

// ---------------------------------------------------------------------------
// The schedule grid (src/pages/production/index.tsx) — the screen the office
// actually plans on. Owner 2026-09-07: 「整个加」.
//
// Two things had to be added, and the second is the one that matters: a
// padlock BEFORE the click so the planner can see which cell is not ready, and
// the same three-choice dialog the folder view has so a refusal comes with a
// way out instead of a toast that only says no.
// ---------------------------------------------------------------------------
const GRID = readFileSync("src/pages/production/index.tsx", "utf8");

test("the grid derives the padlock from the SAME rule the server refuses with", () => {
  // Not a copy, not a department table — the shared pure function. A padlock
  // computed from a second implementation would eventually point at a cell the
  // server lets through, or miss one it does not.
  assert.match(GRID, /import \{ sequenceBlockers[^}]*\} from "@\/api\/lib\/sequence-lock";/);
  assert.match(GRID, /const blockers = sequenceBlockers\(jc, cards\);/);
  // Compared against its own PO's cards, and only for the dept on screen.
  assert.match(GRID, /const cards = o\.jobCards as unknown as SequenceCard\[\];/);
  assert.match(GRID, /if \(jc\.departmentCode !== activeTab\) continue;/);
});

test("a finished card never wears the padlock", () => {
  // The lock is about what may move next. A COMPLETED card that once had an
  // open upstream is history, not a warning.
  assert.match(GRID, /const isDoneRow = s === "COMPLETED" \|\| s === "TRANSFERRED";/);
  assert.match(GRID, /const blockers = isDoneRow \? undefined : blockersByJc\.get\(row\.jobCardId\);/);
  assert.match(GRID, /title=\{`Waiting for \$\{waitingFor\.join\(", "\)\} to finish first\.`\}/);
});

test("a refusal opens the three-choice dialog, once for the whole save", () => {
  assert.match(GRID, /<SequenceUnlockDialog/);
  assert.match(GRID, /x\.r\?\.code === "UPSTREAM_INCOMPLETE"/);
  // Merged by blocker id: two cards waiting on the same FRAMING must not ask
  // the operator about FRAMING twice.
  assert.match(GRID, /const byId = new Map\(parsed\.flatMap\(\(p\) => p\.blockedBy\)\.map\(\(b\) => \[b\.id, b\]\)\);/);
  // Only offer the release the server said it would honour, for every card.
  assert.match(GRID, /canSelfUnlock: parsed\.every\(\(p\) => p\.canSelfUnlock\)/);
});

test("'complete the earlier step too' sends upstream FIRST", () => {
  // Order is the whole point: upstream completes before this card consumes, so
  // the produce lands before the consume and no negative row is created. A
  // dialog that fixed the paperwork by creating the exact damage the lock
  // exists to prevent would be worse than no dialog.
  const patches = GRID.slice(GRID.indexOf("<SequenceUnlockDialog"));
  assert.match(patches, /patches: \[\.\.\.upstream, \.\.\.targets\]/);
  assert.match(patches, /status: "COMPLETED",\s*\n\s*completedDate: todayYmdMY\(\),/);
  // The blocking card is usually in ANOTHER department, so its PO is looked up
  // across the loaded orders, not in the dept grid on screen.
  assert.match(patches, /for \(const jc of o\.jobCards\) poIdOfJc\.set\(jc\.id, o\.id\);/);
});

test("the retry re-sends what the operator typed, not a guess", () => {
  // The drafts are kept verbatim and replayed with the release attached. A
  // dialog that re-sent "COMPLETED" would quietly change a PIC edit into a
  // completion.
  assert.match(GRID, /patch: x\.draft\.patch as unknown as Record<string, unknown>,/);
  assert.match(GRID, /\.\.\.d\.patch,\s*\n\s*unlock: \{ reason: choice\.reason \},/);
});

test("after an unlock the grid refetches instead of guessing", () => {
  // The upstream cards belong to other departments and other rows; an
  // optimistic patch would leave half the grid stale.
  const patches = GRID.slice(GRID.indexOf("<SequenceUnlockDialog"));
  assert.match(patches, /fetchOrders\(\);/);
});
