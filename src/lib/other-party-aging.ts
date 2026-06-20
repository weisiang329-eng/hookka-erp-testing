// ---------------------------------------------------------------------------
// other-party-aging.ts — pure aging bucketer for Other Debtor/Creditor bills
// (F4 #3). Groups unpaid bills by party and ages each by (today − billDate)
// into Current/31-60/61-90/91-120/120+ buckets. Read-only; all sen. The
// endpoint feeds it the live unpaid bills so the result is always current.
// ---------------------------------------------------------------------------

export interface AgingBill {
  partyId: string;
  partyName: string;
  billNo: string;
  billDate: string; // YYYY-MM-DD (or ISO; only the date part is used)
  outstandingSen: number;
}

export interface AgingRow {
  partyId: string;
  partyName: string;
  current: number;
  d31_60: number;
  d61_90: number;
  d91_120: number;
  d120plus: number;
  totalSen: number;
}

const DAY_MS = 86_400_000;

/** Bucket unpaid bills per party by age relative to `todayIso` (YYYY-MM-DD). */
export function bucketAging(bills: AgingBill[], todayIso: string): AgingRow[] {
  const today = Date.parse(`${todayIso.slice(0, 10)}T00:00:00Z`);
  const byParty = new Map<string, AgingRow>();
  for (const b of bills) {
    if (b.outstandingSen <= 0) continue;
    let row = byParty.get(b.partyId);
    if (!row) {
      row = { partyId: b.partyId, partyName: b.partyName, current: 0, d31_60: 0, d61_90: 0, d91_120: 0, d120plus: 0, totalSen: 0 };
      byParty.set(b.partyId, row);
    }
    const days = Math.floor((today - Date.parse(`${b.billDate.slice(0, 10)}T00:00:00Z`)) / DAY_MS);
    if (days <= 30) row.current += b.outstandingSen;
    else if (days <= 60) row.d31_60 += b.outstandingSen;
    else if (days <= 90) row.d61_90 += b.outstandingSen;
    else if (days <= 120) row.d91_120 += b.outstandingSen;
    else row.d120plus += b.outstandingSen;
    row.totalSen += b.outstandingSen;
  }
  return [...byParty.values()].sort((a, b) => b.totalSen - a.totalSen);
}
