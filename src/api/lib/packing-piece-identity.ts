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
};

/**
 * The warehouse identity for one packed piece. `description` becomes the
 * rack_items.productName (and is what currentRackOfPiece matches on); `notes`
 * becomes rack_items.notes (the "SO <no>" tag the grid parses back out).
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
  const notes = soNo ? `SO ${soNo}` : "";
  return { description, notes };
}
