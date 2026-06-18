// Unified document numbering: <prefix>-<YYMM>-<NNN>. Prefix is per bank
// account + direction (out=payments, in=receipts); YYMM comes from the
// voucher date (back-datable); NNN is a per-(prefix,YYMM) running counter.
// Pure helpers here; the atomic counter lives in the DB (issueDocNumber).

export type DocDirection = "out" | "in";
export type DocPrefixMap = Record<string, { out?: string; in?: string }>;

export const DEFAULT_OUT_PREFIX = "PV";
export const DEFAULT_IN_PREFIX = "OR";

// "2026-06-15" → "2606" (2-digit year + 2-digit month).
export function ymFromDate(dateIso: string): string {
  return dateIso.slice(2, 4) + dateIso.slice(5, 7);
}

// "HPV-2606-001"; pads to 3 digits, grows naturally past 999.
export function formatDocNo(prefix: string, ym: string, n: number): string {
  return `${prefix}-${ym}-${String(n).padStart(3, "0")}`;
}

// The prefix for a bank account + direction; configured value wins, else
// the direction default.
export function resolveDocPrefix(
  cfg: DocPrefixMap,
  bankAccountCode: string,
  direction: DocDirection,
): string {
  const entry = cfg[bankAccountCode];
  const v = entry ? entry[direction] : undefined;
  if (v && v.trim()) return v.trim();
  return direction === "out" ? DEFAULT_OUT_PREFIX : DEFAULT_IN_PREFIX;
}
