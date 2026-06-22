// Owner preference: every "money in / money out" form (customer receipts,
// official receipts, expense/payment vouchers, supplier payments, other-party
// payments) defaults its bank/cash account to Hong Leong Bank (HLBB) — falling
// back to the first available bank/cash account when HLBB isn't in the COA.
//
// The COA account is named "CASH AT BANK - HLBB", so match the HLB/HLBB
// abbreviation as well as the full "Hong Leong" name.
const HLBB_RE = /hong\s*leong|\bhlbb?\b/i;

export function defaultBankCode(banks: { code: string; name: string }[]): string {
  const hlbb = banks.find((b) => HLBB_RE.test(b.name));
  return hlbb?.code ?? banks[0]?.code ?? "";
}
