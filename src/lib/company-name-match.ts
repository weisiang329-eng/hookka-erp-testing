// ---------------------------------------------------------------------------
// Tolerant company-name matching for scan-to-create (SO / PI / GRN).
//
// A scanned document prints the customer/supplier's FULL legal name
// ("Houzs Century Sdn Bhd"), but the catalog usually stores a SHORT form
// ("Houzs Century"). Exact string matching then rejects a real, existing
// party over a legal suffix — the "Customer not in catalog" false block that
// hard-stopped 6 Houzs Century POs (BUG-2026-07-01). Products and fabric codes
// already get tolerant matching (normalizeForMatch); customers/suppliers never
// did — this closes that gap.
//
// Design (owner 2026-07-01: "靠单据、别拿名字死配"):
//   • Strip ONLY the Malaysian legal-entity suffixes (Sdn Bhd / Berhad / PLT)
//     plus punctuation/spacing/case — the parts that are noise.
//   • Do NOT strip the distinguishing trade words (Enterprise, Trading,
//     Marketing, …) that tell two companies apart.
//   • Auto-match ONLY when exactly ONE party normalizes to the target. If two
//     parties collide, return null so the caller falls back to a manual match
//     rather than silently picking the wrong company (reject-don't-guess).
//
// Shared by the backend (scan-po validateAndEnrichPO) and the FE preview modal
// so both sides resolve the party identically (FE+BE unified validation).
// ---------------------------------------------------------------------------

/**
 * Uppercase, drop legal-entity suffixes (Sdn Bhd / Berhad / Bhd / PLT), then
 * strip every non-alphanumeric character.
 * "Houzs Century Sdn Bhd" -> "HOUZSCENTURY"; "Houzs Century" -> "HOUZSCENTURY".
 */
export function normalizeCompanyName(s: string | null | undefined): string {
  return (s ?? "")
    .toUpperCase()
    // The separator between SDN and BHD is whatever the letterhead used —
    // space, dot, hyphen, comma or nothing. Requiring whitespace left
    // "ADD-WOOD-TRADING-SDN-BHD" normalising to "…TRADINGSDN" (BHD stripped by
    // the next rule, SDN stranded), so the same company produced two different
    // alias keys (party-alias.test.mjs).
    .replace(/\bSDN[\s.,-]*BHD\.?\b/g, " ")
    .replace(/\bBERHAD\b/g, " ")
    .replace(/\bBHD\.?\b/g, " ")
    .replace(/\bPLT\b/g, " ")
    .replace(/[^A-Z0-9]+/g, "");
}

/**
 * Find the ONE catalog party whose name matches `raw` after normalization.
 * Returns null when nothing matches, or when 2+ parties share the normalized
 * name (ambiguous — the caller should surface a manual match, never guess).
 */
export function matchByCompanyName<T extends { name: string }>(
  parties: readonly T[],
  raw: string | null | undefined,
): T | null {
  const target = normalizeCompanyName(raw);
  if (!target) return null;
  let hit: T | null = null;
  for (const p of parties) {
    if (normalizeCompanyName(p.name) === target) {
      if (hit) return null; // ambiguous — two parties normalize the same
      hit = p;
    }
  }
  return hit;
}
