// ---------------------------------------------------------------------------
// completion-piece-stamp.ts — plan how a DASHBOARD completion propagates down
// to the per-piece scan layer (piece_pics).
//
// Why this exists (BUG-2026-06-08-008, the SET mirror of -002's CLEAR fix):
// worker-scan completion is TWO-LAYER — `piece_pics` holds one "scanner stamp"
// per physical piece, and BOTH the worker phone's "already done" pre-check AND
// the backend scan-complete no-op key off those stamps (pic1Id IS NOT NULL),
// NOT the card's status. So when the office completes a card on the production
// dashboard (writes job_cards.completedDate + PIC) but leaves piece_pics empty,
// the phone still thinks "no piece is done" and lets a worker re-scan +
// re-Mark-Complete (which re-dates the card / splits the credit). -002 already
// made the dashboard CLEAR reach piece_pics (wipe stamps); this is the matching
// SET direction (stamp stamps).
//
// This module is the PURE decision: given the card's piece count (wipQty) and
// the piece_pics rows that already exist, decide — per physical piece —
// whether to INSERT a fresh stamped slot, FILL an existing un-scanned slot, or
// SKIP a slot a worker already scanned (so real worker attribution is never
// overwritten). The route layer turns the plan into INSERT/UPDATE statements.
// Kept pure + exported so the branch logic (empty / partial / fully-scanned) is
// unit-tested without standing up the 480-line applyPoUpdate handler.
// ---------------------------------------------------------------------------

export type ExistingPieceSlot = {
  pieceNo: number;
  pic1Id: string | null;
};

export type CompletionStampPlan = {
  // pieceNos with NO existing slot — INSERT a new slot already stamped done.
  insert: number[];
  // pieceNos whose slot exists but is un-scanned (pic1Id empty) — UPDATE-fill.
  fill: number[];
};

/**
 * Decide which physical pieces of a just-completed card need a piece_pics stamp.
 *
 * - `insert`: pieceNo has no row yet → create one stamped with the card PIC.
 * - `fill`: pieceNo has a row but no PIC yet → fill it with the card PIC.
 * - (omitted): pieceNo already carries a worker's scan stamp → leave untouched,
 *   so efficiency attribution (which unions piece_pics PICs with the JC PIC)
 *   keeps crediting the worker who physically did that piece.
 *
 * wipQty is clamped to a minimum of 1 (a legacy single-piece JC may carry
 * wipQty 0/null). Pieces are numbered 1..slots, matching ensurePiecePicsForJc.
 */
export function planCompletionPieceStamps(
  wipQty: number | null | undefined,
  existing: ReadonlyArray<ExistingPieceSlot>,
): CompletionStampPlan {
  const slots = Math.max(1, Math.floor(Number(wipQty) || 1));
  const pic1ByPiece = new Map<number, string | null>(
    existing.map((r) => [r.pieceNo, r.pic1Id] as const),
  );
  const insert: number[] = [];
  const fill: number[] = [];
  for (let i = 1; i <= slots; i++) {
    if (!pic1ByPiece.has(i)) {
      insert.push(i);
    } else if (!pic1ByPiece.get(i)) {
      // slot exists but pic1Id is null/empty → un-scanned, fill it
      fill.push(i);
    }
    // else: a worker already scanned this piece — leave it alone
  }
  return { insert, fill };
}
