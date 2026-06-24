// ---------------------------------------------------------------------------
// pi-posting.ts — pure GL leg assembly for an APPROVED purchase invoice.
//
// A PI hits the books once it is APPROVED: DR each mapped expense/stock account
// (the bucket from mapPurchaseLinesToAccounts) · CR 400-0000 Trade Creditors for
// the booked invoice total. Any sen of rounding drift between the summed line
// buckets and the booked AP total is parked on `pdefault` so the entry always
// balances exactly (Σ DR === Σ CR).
//
// Shared by BOTH posting paths so they can never drift:
//   · create-as-APPROVED     (purchase-invoices.ts POST)
//   · transition-to-APPROVED (purchase-invoices.ts PUT)
// The route wraps these legs into ledger_journal_entries rows (id / sourceType /
// sourceId / actorUserId / orgId) and runs them through buildJournalEntryStatements.
// All amounts are integer sen (home MYR). Mirrors src/lib/other-party-bill.ts.
// ---------------------------------------------------------------------------

export const AP_CONTROL = "400-0000"; // Trade Creditors

export interface PostingLeg {
  legNo: number;
  accountCode: string;
  debitSen: number;
  creditSen: number;
  description: string;
}

/**
 * Build the balanced GL legs for an APPROVED purchase invoice.
 *
 * @param drBucket account → debit sen, from mapPurchaseLinesToAccounts (home sen)
 * @param apTotalSen booked AP total in home sen (what 400-0000 is credited)
 * @param pdefault   account that absorbs rounding drift (mapPurchaseLinesToAccounts.pdefault)
 */
export function buildPiApprovalLegs(opts: {
  piNo: string;
  supplierName: string;
  apTotalSen: number;
  drBucket: Record<string, number>;
  pdefault: string;
}): PostingLeg[] {
  const apTotal = Math.round(opts.apTotalSen || 0);
  // Clone so we never mutate the caller's bucket.
  const bucket: Record<string, number> = { ...opts.drBucket };
  const sumLines = Object.values(bucket).reduce((s, v) => s + v, 0);
  if (sumLines !== apTotal) {
    bucket[opts.pdefault] = (bucket[opts.pdefault] ?? 0) + (apTotal - sumLines);
  }

  const legs: PostingLeg[] = [];
  let legNo = 1;
  for (const [acct, amt] of Object.entries(bucket)) {
    if (amt === 0) continue;
    legs.push({
      legNo: legNo++,
      accountCode: acct,
      debitSen: amt,
      creditSen: 0,
      description: `Purchase · PI ${opts.piNo}`,
    });
  }
  legs.push({
    legNo: legNo++,
    accountCode: AP_CONTROL,
    debitSen: 0,
    creditSen: apTotal,
    description: `AP · PI ${opts.piNo} · ${opts.supplierName}`,
  });
  return legs;
}
