// ---------------------------------------------------------------------------
// Product "family" key — the leading base of a SKU code, one level coarser
// than the stored baseModel.
//
// baseModel (stored on products by the import) strips only the trailing
// -(size) segment but KEEPS the config/version suffixes, so a single physical
// family splits into multiple baseModels:
//   1003-(SS)            -> baseModel "1003"
//   1003(A)-(SP)         -> baseModel "1003(A)"
//   1003(A)(HF)(W)-(K)   -> baseModel "1003(A)(HF)(W)"
//
// The FAMILY key collapses all of those into one base ("1003").
//
// RULE (two cases — must NOT over-collapse dash-prefixed product codes):
//  - NUMERIC-leading codes (bedframes 1003…, sofas 5535…): family = the leading
//    digit run. This strips the size suffix -(K)/-(SS)/-(SP), the config/version
//    suffixes (A)/(HF)/(W), AND sofa piece suffixes (5535-1A(LHF) / 5535-3S /
//    5535-CNR all -> "5535").
//  - NON-numeric codes: strip ONLY a trailing -(size) parenthesised segment, so
//    DIVAN-(K) -> "DIVAN" — but a shared-prefix scheme like ACC-001 / ACC-002
//    stays DISTINCT (the dash there separates real codes, not a size). Splitting
//    such codes on the first "-" would wrongly merge every ACC-* into one tile.
//
// Derive from the CODE, never from baseModel (which still carries the config
// suffixes for bedframes), so the Catalog tiles / photos key consistently.
// ---------------------------------------------------------------------------
export function familyOf(code: string): string {
  const c = (code || "").trim().toUpperCase();
  const lead = c.match(/^\d+/);
  if (lead) return lead[0];
  return c.replace(/-\([^)]*\)$/, "");
}
