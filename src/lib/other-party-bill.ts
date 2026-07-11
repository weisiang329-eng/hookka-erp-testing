// ---------------------------------------------------------------------------
// other-party-bill.ts — pure GL logic for Other Debtor/Creditor bills (D1).
//
// Non-trade bills posted SAVE-on-create. CREDITOR (we owe): DR each counter
// line + DR input SST (706) · CR 405 total. DEBTOR (owed to us): DR 305 total
// · CR each counter line + CR output SST (350). Tax is a single optional
// amount on the bill header (operator-entered, MYR). All amounts in sen.
// ---------------------------------------------------------------------------

export type PartyType = "DEBTOR" | "CREDITOR";

export interface BillItemInput {
  counterAccount: string;
  amountSen: number;
  description?: string;
}

export interface AccountingLeg {
  legNo: number;
  accountCode: string;
  debitSen: number;
  creditSen: number;
  description: string;
}

export const OTHER_DEBTOR_CONTROL = "305-0000";
export const OTHER_CREDITOR_CONTROL = "405-0000";
export const OUTPUT_SST_ACCT = "350-0000";
export const INPUT_SST_ACCT = "706-0000";
export const FORBIDDEN_COUNTER_ACCOUNTS = new Set<string>([
  OTHER_DEBTOR_CONTROL,
  OTHER_CREDITOR_CONTROL,
  OUTPUT_SST_ACCT,
  INPUT_SST_ACCT,
]);

export function prefixForPartyType(type: PartyType): string {
  return type === "CREDITOR" ? "OCB" : "ODB";
}

export function computeBillTotals(
  items: BillItemInput[],
  taxSen: number,
): { subtotalSen: number; totalSen: number } {
  const subtotalSen = (items ?? []).reduce((s, it) => s + (it.amountSen || 0), 0);
  return { subtotalSen, totalSen: subtotalSen + (taxSen || 0) };
}

export function validateBillShape(
  items: BillItemInput[],
  taxSen: number,
): string | null {
  if (!Array.isArray(items) || items.length === 0)
    return "At least one line is required";
  for (const it of items) {
    if (!it.counterAccount || !String(it.counterAccount).trim())
      return "Each line needs a counter account";
    if (FORBIDDEN_COUNTER_ACCOUNTS.has(it.counterAccount))
      return `${it.counterAccount} cannot be used as a counter account`;
    if (!Number.isFinite(it.amountSen) || it.amountSen <= 0)
      return "Each line amount must be greater than zero";
  }
  if (!Number.isFinite(taxSen) || taxSen < 0) return "Tax cannot be negative";
  const { totalSen } = computeBillTotals(items, taxSen);
  if (totalSen <= 0) return "Bill total must be greater than zero";
  return null;
}

export function buildBillLegs(opts: {
  partyType: PartyType;
  billNo: string;
  partyName: string;
  items: BillItemInput[];
  taxSen: number;
}): AccountingLeg[] {
  const { partyType, billNo, partyName, items, taxSen } = opts;
  const { totalSen } = computeBillTotals(items, taxSen);
  const tag = `${billNo} · ${partyName}`;
  const legs: AccountingLeg[] = [];
  let legNo = 1;

  if (partyType === "CREDITOR") {
    for (const it of items) {
      legs.push({ legNo: legNo++, accountCode: it.counterAccount, debitSen: it.amountSen, creditSen: 0, description: `Other creditor bill · ${tag}` });
    }
    if (taxSen > 0) {
      legs.push({ legNo: legNo++, accountCode: INPUT_SST_ACCT, debitSen: taxSen, creditSen: 0, description: `Input SST · ${tag}` });
    }
    legs.push({ legNo: legNo++, accountCode: OTHER_CREDITOR_CONTROL, debitSen: 0, creditSen: totalSen, description: `Other creditor · ${tag}` });
  } else {
    legs.push({ legNo: legNo++, accountCode: OTHER_DEBTOR_CONTROL, debitSen: totalSen, creditSen: 0, description: `Other debtor · ${tag}` });
    for (const it of items) {
      legs.push({ legNo: legNo++, accountCode: it.counterAccount, debitSen: 0, creditSen: it.amountSen, description: `Other debtor bill · ${tag}` });
    }
    if (taxSen > 0) {
      legs.push({ legNo: legNo++, accountCode: OUTPUT_SST_ACCT, debitSen: 0, creditSen: taxSen, description: `Output SST · ${tag}` });
    }
  }
  return legs;
}

export function reverseLegs(legs: AccountingLeg[]): AccountingLeg[] {
  return legs.map((l, idx) => ({
    legNo: idx + 1,
    accountCode: l.accountCode,
    debitSen: l.creditSen,
    creditSen: l.debitSen,
    description: `REVERSAL · ${l.description}`,
  }));
}

// ---------------------------------------------------------------------------
// Edit-in-place guard (owner request 2026-07-09: bills must be editable).
// An edited bill keeps its number and its payments; the new total therefore
// may never drop below what has already been paid, and the payment-progress
// status is re-derived from the surviving paid amount.
// ---------------------------------------------------------------------------
export type EditedBillStatus =
  | { ok: true; status: "OPEN" | "PARTIAL_PAID" | "PAID" }
  | { ok: false; error: string };

export function editedBillStatus(totalSen: number, paidAmountSen: number): EditedBillStatus {
  const paid = Math.round(Number(paidAmountSen) || 0);
  const total = Math.round(Number(totalSen) || 0);
  if (paid > total) {
    return {
      ok: false,
      error: `RM ${(paid / 100).toFixed(2)} is already paid against this bill — the new total cannot be below that. Void the settlement first if the bill really shrank.`,
    };
  }
  if (paid <= 0) return { ok: true, status: "OPEN" };
  if (paid < total) return { ok: true, status: "PARTIAL_PAID" };
  return { ok: true, status: "PAID" };
}
