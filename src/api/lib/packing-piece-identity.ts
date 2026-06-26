// ---------------------------------------------------------------------------
// packing-piece-identity.ts — THE one formula for a packed piece's warehouse
// identity (the `rack_items.productName` "description" + the `rack_items.notes`
// "SO …" tag).
//
// Three paths put a piece into a rack and must agree on this identity or the
// Warehouse grid shows duplicates / a move can't find the old row:
//   • the office Packing-sheet rack dropdown + the /p/ piece-sticker scan + the
//     worker scan   → all funnel through applyPackingRack (packing-rack-write.ts)
//   • the /r/ rack-QR "scan items" stock-in  → public-rack-qr.ts (resolve +
//     buildRackStockInStatements + currentRackOfPiece)
//
// They previously each in-lined the same description/notes formula, which is
// exactly the kind of duplicated rule that drifts. This is the single source.
// `notes` mirrors pieceNotes() (no trim) and `description` mirrors the public
// /p/ resolve, so the move-match key (productName + notes) stays identical.
// ---------------------------------------------------------------------------

export type PackingPieceCard = {
  wipLabel?: string | null;
  productName?: string | null;
  productCode?: string | null;
  poNo?: string | null;
  sizeLabel?: string | null;
  salesOrderNo?: string | null;
  // The physical piece number on a multi-piece WIP (a DIVAN of 2 pieces → 1, 2).
  // OPTIONAL: when present (and the WIP genuinely has >1 piece) it makes each
  // piece a DISTINCT warehouse identity so two pieces of the SAME WIP can sit on
  // DIFFERENT racks (no more "already in this rack"). When omitted / 0 / a
  // single-piece WIP, the identity is the legacy card-level one — byte-identical
  // to before, so old single-piece rack_items rows still match + move/clear.
  pieceNo?: number | null;
  totalPieces?: number | null;
};

/**
 * The warehouse identity for one packed piece. `description` becomes the
 * rack_items.productName (and is what currentRackOfPiece matches on); `notes`
 * becomes rack_items.notes (the "SO <no>" tag the grid parses back out).
 *
 * Per-piece distinction (mig 0192): when the card carries a pieceNo AND the WIP
 * has more than one piece, the piece marker is appended to `notes` (e.g.
 * "SO 12345 · pc 2 of 2") so the move-match key (productName + notes) is UNIQUE
 * per physical piece. A single-piece WIP (totalPieces ≤ 1) or a card with no
 * pieceNo keeps the legacy notes EXACTLY ("SO <no>" / "") — so existing rows are
 * matched + moved/cleared unchanged.
 */
export function packingPieceIdentity(card: PackingPieceCard): {
  description: string;
  notes: string;
} {
  const name = (card.productName || card.productCode || card.poNo || "").trim();
  const size = (card.sizeLabel || "").trim();
  const description =
    (card.wipLabel || "").trim() ||
    (size ? `${name} ${size}`.trim() : name) ||
    "Item";
  const soNo = card.salesOrderNo ?? null;
  let notes = soNo ? `SO ${soNo}` : "";
  const pieceNo = card.pieceNo ?? null;
  const total = card.totalPieces ?? null;
  // Only diverge from the legacy notes when this WIP actually has >1 piece AND a
  // valid piece number — otherwise stay byte-identical for back-compat.
  if (
    pieceNo != null &&
    pieceNo > 0 &&
    total != null &&
    total > 1
  ) {
    const pc = `pc ${pieceNo} of ${total}`;
    notes = notes ? `${notes} · ${pc}` : pc;
  }
  return { description, notes };
}
