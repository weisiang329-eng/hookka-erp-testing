// ---------------------------------------------------------------------------
// invoice-line-price — the ONE definition of an invoice line's unit price.
//
// A line's unit = base + divan + leg + special + totalHeight (all in sen).
//
// This exists because the invoice price editor computed that sum in FOUR
// places (three live previews + the save payload) and one of them — the save —
// included totalHeight while the three previews did not. The result: opening
// the editor showed a price ~RM3 lower than the real one, editing the T.Height
// field changed nothing on screen, and hitting Save wrote the on-screen
// (lower) number over the correct stored price. A silent money-loss path.
//
// Every call site now sums through here, so a component can never again be
// present in one place and missing in another. Pure + tested.
// ---------------------------------------------------------------------------

export type InvoiceLinePriceParts = {
  baseSen: number;
  divanSen: number;
  legSen: number;
  specialSen: number;
  totalHeightSen: number;
};

/** Unit price in sen = base + divan + leg + special + totalHeight. */
export function invoiceLineUnitSen(p: InvoiceLinePriceParts): number {
  return (
    (Number(p.baseSen) || 0) +
    (Number(p.divanSen) || 0) +
    (Number(p.legSen) || 0) +
    (Number(p.specialSen) || 0) +
    (Number(p.totalHeightSen) || 0)
  );
}
