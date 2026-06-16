// Pure Balance-Sheet section classification. Decides which of the 5 BS
// sections a GL account belongs to. The owner can override an account's
// section via kv `bs_section_map` to ANY of the 5 sections (cross-side
// allowed) — the BS stays balanced because the displayed amount follows the
// destination section's sign (asset = dr−cr, liab/equity = cr−dr), so moving
// an account shifts both totals by the same magnitude with opposite sign.

export type BsSection =
  | "FIXED_ASSET"
  | "CURRENT_ASSET"
  | "CURRENT_LIABILITY"
  | "LONG_TERM_LIABILITY"
  | "EQUITY";

export type BsClass = "asset" | "liabeq";

// Asset-class accounts are debit-normal (balance = dr−cr); liability/equity
// are credit-normal (balance = cr−dr). Drives the displayed sign.
export function bsSectionClass(s: BsSection): BsClass {
  return s === "FIXED_ASSET" || s === "CURRENT_ASSET" ? "asset" : "liabeq";
}

const band = (code: string): number => parseInt(code.split("-")[0] ?? "0", 10) || 0;

// Default section purely from account type + code band. Returns null for
// accounts not on the balance sheet (REVENUE/COST/EXPENSE).
export function defaultBsSection(code: string, type: string): BsSection | null {
  if (type === "ASSET") return band(code) < 300 ? "FIXED_ASSET" : "CURRENT_ASSET";
  if (type === "LIABILITY") {
    const p = band(code);
    return p >= 480 && p < 490 ? "LONG_TERM_LIABILITY" : "CURRENT_LIABILITY";
  }
  if (type === "EQUITY") return "EQUITY";
  return null;
}

export function isBsSection(v: string): v is BsSection {
  return (
    v === "FIXED_ASSET" || v === "CURRENT_ASSET" || v === "CURRENT_LIABILITY" ||
    v === "LONG_TERM_LIABILITY" || v === "EQUITY"
  );
}

// Effective section: a valid override (any of the 5 — no same-class guard,
// unlike P&L) wins; else default. null = not a balance-sheet account.
export function bsSectionFor(
  code: string,
  type: string,
  override: Record<string, string>,
): BsSection | null {
  const def = defaultBsSection(code, type);
  if (!def) return null;
  const ov = override[code];
  if (ov && isBsSection(ov)) return ov;
  return def;
}
