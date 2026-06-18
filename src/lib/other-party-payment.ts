// ---------------------------------------------------------------------------
// other-party-payment.ts — pure GL logic for settling Other Debtor/Creditor
// bills (D2). MYR only. CREDITOR payment: DR 405 · CR bank. DEBTOR receipt:
// DR bank · CR 305. One payment settles N bills (allocations). All sen.
// ---------------------------------------------------------------------------
import {
  type PartyType,
  type AccountingLeg,
  OTHER_DEBTOR_CONTROL,
  OTHER_CREDITOR_CONTROL,
} from "./other-party-bill";

export interface PaymentAllocInput {
  billId: string;
  amountSen: number;
}

export function computePaymentTotal(allocs: PaymentAllocInput[]): number {
  return (allocs ?? []).reduce((s, a) => s + (a.amountSen || 0), 0);
}

export function validateAllocations(
  allocs: PaymentAllocInput[],
  outstandingByBill: Record<string, number>,
): string | null {
  if (!Array.isArray(allocs) || allocs.length === 0)
    return "Select at least one bill to settle";
  for (const a of allocs) {
    if (!a.billId || !(a.billId in outstandingByBill))
      return `Unknown bill ${a.billId}`;
    if (!Number.isFinite(a.amountSen) || a.amountSen <= 0)
      return "Each amount must be greater than zero";
    if (a.amountSen > outstandingByBill[a.billId])
      return `Amount exceeds outstanding for bill ${a.billId}`;
  }
  return null;
}

export function buildPaymentLegs(opts: {
  partyType: PartyType;
  paymentNo: string;
  partyName: string;
  bankAccount: string;
  totalSen: number;
}): AccountingLeg[] {
  const { partyType, paymentNo, partyName, bankAccount, totalSen } = opts;
  const tag = `${paymentNo} · ${partyName}`;
  if (partyType === "CREDITOR") {
    return [
      { legNo: 1, accountCode: OTHER_CREDITOR_CONTROL, debitSen: totalSen, creditSen: 0, description: `Other creditor payment · ${tag}` },
      { legNo: 2, accountCode: bankAccount, debitSen: 0, creditSen: totalSen, description: `Other creditor payment · ${tag}` },
    ];
  }
  return [
    { legNo: 1, accountCode: bankAccount, debitSen: totalSen, creditSen: 0, description: `Other debtor receipt · ${tag}` },
    { legNo: 2, accountCode: OTHER_DEBTOR_CONTROL, debitSen: 0, creditSen: totalSen, description: `Other debtor receipt · ${tag}` },
  ];
}
