// ============================================================
// Shared "what piece is this?" label derivation.
//
// The worker portal (scan card, today-completed list, worker home) and
// the production sticker print all need the same human-facing WIP name.
// That name is:
//   - `wipLabel` when the back-end has one (e.g. `8" Divan- 5FT (WD)`)
//   - otherwise derived from (dept, itemCategory, sizeLabel, productName)
//
// Keeping the fallback here means every surface stays in sync — no more
// "lookup card shows Divan but Today's Completed shows the generic PO
// code" mismatches.
// ============================================================

/**
 * Derive the human-facing WIP name. Loosely typed so callers can pass
 * a JobCard + Order, a history-row, or a sticker struct without first
 * having to reshape them into the production JobCard type.
 */
export function deriveWipName(args: {
  wipLabel?: string;
  departmentCode: string;
  productName?: string;
  productCode?: string;
  itemCategory?: string;
  sizeLabel?: string;
}): string {
  const label = args.wipLabel?.trim();
  if (label) return label;
  const base = args.productName || args.productCode || "";
  const dept = args.departmentCode;
  if (dept === "PACKING") return base;
  if (args.itemCategory === "BEDFRAME") {
    if (dept === "WOOD_CUT" || dept === "FRAMING" || dept === "WEBBING") {
      return `Divan ${args.sizeLabel || ""}`.trim();
    }
    if (dept === "FAB_CUT" || dept === "FAB_SEW" || dept === "UPHOLSTERY") {
      return `${base} (Fabric)`.trim();
    }
    if (dept === "FOAM") return `Foam ${args.sizeLabel || ""}`.trim();
  }
  return base;
}
