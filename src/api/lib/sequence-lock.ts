// ---------------------------------------------------------------------------
// sequence-lock — the ONE answer to "may this job card move yet?"
//
// Owner 2026-09-06: 「上一道工序还没 mark complete，系统应该锁起来，不能在当前
// 工序 mark complete」 — because skipping is what drives WIP negative. A step
// that starts before its upstream produced consumes a row nothing filled, and
// `_helpers.ts` deliberately does not clamp that at zero ("go negative as a
// visibility signal"). Measured 2026-09-06: 513 negative rows, 46 cards already
// completed out of order across 20 live production orders.
//
// ## Read the job cards, nothing else
//
// A previous attempt (760d08b3, removed 2026-06-08) read
// `job_cards.prerequisiteMet`. That column is stamped ONCE when the card is
// built and is never rolled forward when an upstream department finishes.
// Measured on production the day this was written: of 4,967 cards on active
// orders, 4,680 read 0 — and 1,673 of those have nothing upstream at all while
// 938 have upstream that is already done. At least 2,611 are false. As a hard
// block it would stop every department except the first.
//
// So the answer is derived LIVE from the cards themselves. Nothing is cached,
// so nothing can go stale.
//
// ## The dependency graph is the BOM's, not ours
//
// Owner: 「记得你的这整个流程不可以写死的，应该是根据我的 BOM 的变化的」.
//
// It already is. `bom-wip-breakdown.ts` walks the BOM tree and passes
// `branchKey` down: the first descent adopts the child node's raw `wipCode` as
// the branch id, deeper nodes inherit it, and TOP-LEVEL processes keep "".
// So an empty `branchKey` is not missing data — it is the BOM marking a step
// that belongs to the whole product rather than to one branch. That is exactly
// the convergence the owner described:
//
//   「例如 Upholstery 要完成的话，它需要 Foam Bonding、Fabric Sewing，还有包括
//     Webbing 那一边都做好」
//
// Hence two rules and no table:
//
//   1. a card waits for every earlier-sequence card in its OWN (wipKey,
//      branchKey) — its branch's own chain;
//   2. a card whose branchKey is EMPTY additionally waits for the LAST card of
//      every other branch in the same wipKey — the branches converging on it.
//
// Change a BOM and the next cards built carry new branches and sequences; this
// follows automatically. There is nothing to maintain.
//
// `PRODUCTION_ORDER_BY_WIP_TYPE` in bom-wip-breakdown.ts IS a hardcoded list of
// six chains, but it is used at BUILD time to order processes onto cards. This
// module must never read it — doing so would reintroduce the fixed table the
// owner explicitly rejected.
//
// ## Why not "everything earlier in the wipKey"
//
// Because the flat order lies. `DEPT_ORDER` lists WOOD_CUT after FAB_SEW, so
// ignoring branches blocks wood cutting until fabric sewing is done. Simulated
// over the live orders that rule added 415 wrong blocks — WOOD_CUT ← FAB_SEW
// (322), FRAMING ← FAB_SEW (73), WEBBING ← FAB_SEW (20) — none of which is a
// real dependency. The branch dimension is not optional.
// ---------------------------------------------------------------------------

/** A step is finished for its department. Both statuses mean done — the same
 *  pair `compliance-report.ts` and the WIP cascade already use. */
const DONE_STATUSES: ReadonlySet<string> = new Set(["COMPLETED", "TRANSFERRED"]);

/** Statuses that will never complete, so they must never hold anything back. */
const DEAD_STATUSES: ReadonlySet<string> = new Set(["CANCELLED"]);

/** The fields the rule reads. Deliberately narrow so any caller's row type fits. */
export type SequenceCard = {
  id: string;
  departmentCode?: string | null;
  status?: string | null;
  sequence?: number | null;
  wipKey?: string | null;
  branchKey?: string | null;
};

export type SequenceBlocker = {
  id: string;
  departmentCode: string;
  status: string;
};

function isDone(card: SequenceCard): boolean {
  return DONE_STATUSES.has(String(card.status ?? "").toUpperCase());
}

/** A cancelled upstream can never be completed, so holding a card behind it
 *  would be a permanent dead end. Measured 2026-09-06: 0 cards are in that
 *  position today, and this keeps it that way. */
function isDead(card: SequenceCard): boolean {
  return DEAD_STATUSES.has(String(card.status ?? "").toUpperCase());
}

function seqOf(card: SequenceCard): number {
  const n = Number(card.sequence);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The cards that must finish before `card` may move.
 *
 * Empty array = unlocked. `allCards` is every job card on the same production
 * order; passing a wider set is harmless because everything is filtered by
 * `wipKey` first.
 *
 * Cards at the SAME sequence never block each other — they are parallel by
 * construction. This matters: 142 branches on production carry two different
 * departments on one sequence number, and ordering them would be a coin flip.
 */
export function sequenceBlockers(
  card: SequenceCard,
  allCards: SequenceCard[],
): SequenceBlocker[] {
  const wipKey = card.wipKey ?? "";
  const branchKey = card.branchKey ?? "";
  const mySeq = seqOf(card);
  const chain = allCards.filter(
    (c) => c.id !== card.id && (c.wipKey ?? "") === wipKey,
  );

  const out: SequenceCard[] = [];

  // 1. This card's own branch, in order.
  for (const c of chain) {
    if ((c.branchKey ?? "") !== branchKey) continue;
    if (seqOf(c) >= mySeq) continue;
    if (isDone(c) || isDead(c)) continue;
    out.push(c);
  }

  // 2. A convergence step (branchKey === "") also waits for the LAST card of
  //    every other branch below it. Only the branch TERMINAL is named: an
  //    earlier card in that branch is that terminal's own problem, and listing
  //    it would tell the operator to chase a step that is not next.
  if (branchKey === "") {
    const terminalByBranch = new Map<string, SequenceCard>();
    for (const c of chain) {
      const bk = c.branchKey ?? "";
      if (bk === "") continue;
      if (seqOf(c) >= mySeq) continue;
      const cur = terminalByBranch.get(bk);
      if (!cur || seqOf(c) > seqOf(cur)) terminalByBranch.set(bk, c);
    }
    for (const terminal of terminalByBranch.values()) {
      if (isDone(terminal) || isDead(terminal)) continue;
      out.push(terminal);
    }
  }

  const seen = new Set<string>();
  return out
    .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
    .sort((a, b) => seqOf(a) - seqOf(b))
    .map((c) => ({
      id: c.id,
      departmentCode: String(c.departmentCode ?? ""),
      status: String(c.status ?? ""),
    }));
}

/**
 * Statuses that consume upstream WIP. Both of them, on purpose.
 *
 * `_helpers.ts` drains the upstream row on `becomingActive`, which is
 * IN_PROGRESS **or** COMPLETED — whichever lands first. Gating only completion
 * would leave the hole open: a card set to IN_PROGRESS out of order still takes
 * the stock, and the negative row still appears. The lock has to cover the
 * transition that actually moves inventory.
 */
export function transitionConsumesUpstream(newStatus: string | null | undefined): boolean {
  const s = String(newStatus ?? "").toUpperCase();
  return s === "IN_PROGRESS" || s === "COMPLETED" || s === "TRANSFERRED";
}

/** A one-line reason for the operator. UI copy is English (repo rule). */
export function blockerMessage(blockers: SequenceBlocker[]): string {
  if (blockers.length === 0) return "";
  const names = [...new Set(blockers.map((b) => b.departmentCode))];
  return names.length === 1
    ? `${names[0]} must be completed first.`
    : `These must be completed first: ${names.join(", ")}.`;
}
