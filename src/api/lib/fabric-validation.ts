// ---------------------------------------------------------------------------
// fabric-validation.ts — single-source validator for fabricCode references
// landing on PO / SO / CO line items.
//
// Background: the legacy `fabrics` table accumulated stale duplicates
// (e.g. `M2402-01` alongside the canonical `M2402-1`) that don't exist in
// `raw_materials`. The dropdowns historically read from `fabrics`, so
// operators saved orphan fabricCodes that downstream MRP / fabric tracking
// can never resolve.
//
// Authoritative inventory: `raw_materials` filtered to the fabric
// itemGroups (B.M-FABR / S-FABR / S.M-FABR / LINING / WEBBING). Anything
// outside that set is rejected at the save boundary.
//
// Usage:
//   const codes = items.map(i => i.fabricCode).filter(Boolean) as string[];
//   const { valid, unknown } = await validateFabricCodes(c.var.DB, codes);
//   if (!valid) {
//     return c.json({
//       success: false,
//       error: `Unknown fabricCode: ${unknown[0]}. Must exist in raw_materials.`,
//     }, 400);
//   }
// ---------------------------------------------------------------------------

export const FABRIC_ITEM_GROUPS = [
  "B.M-FABR",
  "S-FABR",
  "S.M-FABR",
  "LINING",
  "WEBBING",
] as const;

export type FabricValidationResult = {
  valid: boolean;
  unknown: string[];
};

/**
 * Validate that every supplied fabricCode exists in `raw_materials` with a
 * fabric `itemGroup`. Empty / null / undefined entries are dropped before
 * the lookup so callers don't have to pre-filter (saving an empty-string
 * fabricCode is still legal — the line item simply has no fabric tied to
 * it). Duplicates are deduped so a 3-item SO with the same fabricCode on
 * every line costs one round-trip.
 *
 * Returns the unknown codes in input order so the caller can surface a
 * stable, helpful error to the operator.
 */
export async function validateFabricCodes(
  db: D1Database,
  codes: Array<string | null | undefined>,
): Promise<FabricValidationResult> {
  // Dedupe + drop empties. Trim defensively — operators can paste codes
  // with stray whitespace and the comparison below uses exact string match.
  const wanted = new Set<string>();
  const order: string[] = [];
  for (const raw of codes) {
    if (raw == null) continue;
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    if (wanted.has(trimmed)) continue;
    wanted.add(trimmed);
    order.push(trimmed);
  }
  if (wanted.size === 0) {
    return { valid: true, unknown: [] };
  }

  const placeholders = order.map(() => "?").join(",");
  const sql =
    `SELECT itemCode FROM raw_materials
      WHERE itemCode IN (${placeholders})
        AND itemGroup IN ('B.M-FABR','S-FABR','S.M-FABR','LINING','WEBBING')`;

  const stmt = db.prepare(sql).bind(...order);
  const rows = await stmt.all<{ itemCode: string | null }>();
  const known = new Set<string>();
  for (const r of rows.results ?? []) {
    if (r.itemCode) known.add(r.itemCode);
  }

  const unknown: string[] = [];
  for (const code of order) {
    if (!known.has(code)) unknown.push(code);
  }
  return { valid: unknown.length === 0, unknown };
}

/**
 * Convenience: build the standard 400 response payload when validation
 * fails. Keeps every save handler returning the same error shape.
 */
export function unknownFabricCodeError(unknown: string[]): {
  success: false;
  error: string;
} {
  const first = unknown[0] ?? "";
  return {
    success: false,
    error: `Unknown fabricCode: ${first}. Must exist in raw_materials.`,
  };
}
