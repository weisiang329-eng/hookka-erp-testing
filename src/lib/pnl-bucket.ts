// Pure P&L bucket classification for the manufacturing P&L report.
// Decides which account-driven P&L group a GL account belongs to. The owner
// can override an account's bucket via kv `pnl_section_map`, but only within
// the same sign-class (income vs cost) so Net Profit stays invariant.

export type PnlBucket =
  | "REVENUE"
  | "OTHER_INCOME"
  | "DIRECT_LABOUR"
  | "FACTORY_OVERHEAD"
  | "OPERATING_EXPENSE"
  | "OPEX_SALARIES";

export type PnlClass = "income" | "cost";

// Income-class adds to profit; cost-class subtracts. Moving within a class
// keeps Net Profit invariant; cross-class moves would change it (forbidden).
export function bucketClass(b: PnlBucket): PnlClass {
  return b === "REVENUE" || b === "OTHER_INCOME" ? "income" : "cost";
}

const band = (code: string): number => parseInt(code.split("-")[0] ?? "0", 10) || 0;

// Default bucket purely from account type + code band, mirroring the existing
// computePnlWindow classification. Returns null for accounts that are NOT
// account-driven P&L lines (raw-material/carriage/SST/other) — those are
// handled separately and are never draggable.
export function defaultPnlBucket(
  code: string,
  type: string,
): PnlBucket | null {
  if (type === "REVENUE") return band(code) >= 530 ? "OTHER_INCOME" : "REVENUE";
  if (type === "COST") {
    if (band(code) === 750) return "DIRECT_LABOUR";
    if (band(code) === 780) return "FACTORY_OVERHEAD";
    return null; // carriage 700-1015 / SST 706-0000 / other COST → not draggable
  }
  if (type === "EXPENSE") return /^900-S0/.test(code) ? "OPEX_SALARIES" : "OPERATING_EXPENSE";
  return null;
}

// Effective bucket: same-class override wins, else default. null = not
// account-driven (override has no effect).
export function pnlBucketFor(
  code: string,
  type: string,
  override: Record<string, string>,
): PnlBucket | null {
  const def = defaultPnlBucket(code, type);
  if (!def) return null;
  const ov = override[code] as PnlBucket | undefined;
  if (ov && isPnlBucket(ov) && bucketClass(ov) === bucketClass(def)) return ov;
  return def;
}

export function isPnlBucket(v: string): v is PnlBucket {
  return (
    v === "REVENUE" || v === "OTHER_INCOME" || v === "DIRECT_LABOUR" ||
    v === "FACTORY_OVERHEAD" || v === "OPERATING_EXPENSE" || v === "OPEX_SALARIES"
  );
}
