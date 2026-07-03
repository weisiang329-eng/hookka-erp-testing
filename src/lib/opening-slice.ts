// ---------------------------------------------------------------------------
// Mid-year opening → P&L slice (owner rule 2026-07-03, "ledger 不留痕迹").
//
// The opening-balance entry carries the CUMULATIVE P&L balances as at the
// opening date (books start 2026-05-22; the values run from company start to
// 21/05). The P&L statement must show, in the OPENING MONTH, only the slice
// that belongs to that month (opening cumulative − prior-month-end TB), while
// months before the opening month come from the owner-keyed historical P&L.
//
// This is a pure REPORT-layer adjustment: the ledger keeps exactly one clean
// opening entry (no bridge accounts, no extra JVs). The prior-month-end TB
// P&L balances live in kv `pnl_opening_prior_cum` as {accountCode: signedSen}
// (DR positive / CR negative — sales will be negative).
//
// Pure + dependency-free so the slice math is unit-testable.
// ---------------------------------------------------------------------------

/**
 * Inject the opening month's P&L slice into a GL window net map.
 *
 * @param net        window net per account (DR−CR), mutated in place
 * @param openingNet net of ALL opening_balance(+reversal) legs per account —
 *                   reversals net out, so re-posting the opening later keeps
 *                   this correct automatically
 * @param priorCumSen prior-month-end TB balances per account (signed sen)
 * @param isPnlAccount only P&L accounts take a slice (BS accounts stay out of
 *                   the P&L entirely)
 */
export function applyOpeningSlice(
  net: Map<string, number>,
  openingNet: ReadonlyMap<string, number>,
  priorCumSen: Record<string, number>,
  isPnlAccount: (code: string) => boolean,
): void {
  for (const [code, v] of openingNet) {
    if (!isPnlAccount(code)) continue;
    const slice = v - (Number(priorCumSen[code]) || 0);
    if (slice === 0) continue;
    net.set(code, (net.get(code) ?? 0) + slice);
  }
}

/** Does the window [startYm, endYm] (either side open) cover the given month? */
export function windowCoversMonth(
  startYm: string | null,
  endYm: string | null,
  ym: string | null,
): boolean {
  if (!ym) return false;
  if (startYm && ym < startYm) return false;
  if (endYm && ym > endYm) return false;
  return true;
}
