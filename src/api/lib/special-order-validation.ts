// ---------------------------------------------------------------------------
// special-order-validation.ts — backend gate for the `specialOrder` field on
// SO/CO line items. Mirrors the validateFabricCodes pattern in
// `fabric-validation.ts`: reject at SO/CO save when an unknown canonical
// special token is on a line, accept "OTHER: <free text>" tokens unchanged.
//
// Why: maintenance_config defines the per-category specials catalog
// (e.g. BEDFRAME: "HB Straight", "Divan Top Fully Cover"; SOFA: "Headrest
// Firm", "Nylon Fabric"). The frontend dropdown is bound to this catalog
// — but a curl POST or a stale OCR re-import could send any string. Without
// a backend gate the junk lands on the SO and propagates to the JC label,
// the production sheet, the customer-facing PDF, etc.
//
// Custom one-off specials are encoded as "OTHER: <description>" tokens in
// the same comma-joined `specialOrder` string, AND structured separately in
// the `customSpecials` JSON column (post migration 0074). Operators rely on
// custom freeform — those tokens MUST pass through unchanged. Only the
// canonical-shaped tokens (no OTHER: prefix) are catalog-checked.
//
// Usage:
//   const cfg = await loadSpecialOrderCatalog(c.var.DB);
//   const check = validateSpecialOrders(items.map(it => ({
//     specialOrder: it.specialOrder,
//     itemCategory: it.itemCategory,
//   })), cfg);
//   if (!check.valid) {
//     return c.json(unknownSpecialOrderError(check.unknown), 400);
//   }
// ---------------------------------------------------------------------------

export type SpecialOrderCatalog = {
  bedframe: Set<string>; // lowercased for case-insensitive match
  sofa: Set<string>;
};

export type SpecialOrderInput = {
  specialOrder?: string | null | undefined;
  itemCategory?: string | null | undefined;
};

export type SpecialOrderValidationResult = {
  valid: boolean;
  // Each entry is one bad token + the line/category it appeared on. Caller
  // surfaces the first one in the 400 response so the operator sees an
  // actionable error.
  unknown: Array<{ token: string; itemCategory: string; lineIndex: number }>;
};

/**
 * Load the per-category specials catalog from kv_config.variants-config.
 * Returns lowercased Sets for case-insensitive lookup. Empty Sets when the
 * config row is missing or unparseable — in that case validation effectively
 * skips (no catalog → no rejection), which mirrors how the equivalent guard
 * in /backfill-ocr-so-fields behaved.
 */
export async function loadSpecialOrderCatalog(
  db: D1Database,
): Promise<SpecialOrderCatalog> {
  const empty: SpecialOrderCatalog = {
    bedframe: new Set<string>(),
    sofa: new Set<string>(),
  };
  const row = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("variants-config")
    .first<{ value: string }>();
  if (!row?.value) return empty;
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(row.value) as Record<string, unknown>;
  } catch {
    return empty;
  }
  const extract = (arr: unknown): string[] => {
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => {
        if (typeof x === "string") return x;
        if (x && typeof x === "object" && "value" in x) {
          const v = (x as { value?: unknown }).value;
          return typeof v === "string" ? v : "";
        }
        return "";
      })
      .filter((s) => s.length > 0);
  };
  return {
    bedframe: new Set(extract(cfg.specials).map((s) => s.toLowerCase())),
    sofa: new Set(extract(cfg.sofaSpecials).map((s) => s.toLowerCase())),
  };
}

/**
 * Validate every item's specialOrder against the per-category catalog.
 * Tokens are split on `,` or `;`. Tokens prefixed with `OTHER:` (case
 * insensitive) are passed through — they're freeform custom specials that
 * the customSpecials JSON column already structures separately. All other
 * tokens MUST appear in the catalog for the item's category, case-insensitive.
 *
 * ACCESSORY items don't have a specials catalog today; we treat any non-OTHER
 * token on an ACCESSORY line as unknown to be safe (operator must use the
 * customSpecials free-text path or leave specialOrder empty).
 */
export function validateSpecialOrders(
  items: SpecialOrderInput[],
  catalog: SpecialOrderCatalog,
): SpecialOrderValidationResult {
  const unknown: SpecialOrderValidationResult["unknown"] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const raw = String(it.specialOrder ?? "").trim();
    if (!raw) continue;
    const cat = String(it.itemCategory ?? "").toUpperCase();
    const allowed =
      cat === "SOFA"
        ? catalog.sofa
        : cat === "BEDFRAME"
          ? catalog.bedframe
          : new Set<string>();
    const tokens = raw
      .split(/[,;]/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    for (const token of tokens) {
      // Custom freeform — always allowed (frontend "Add custom" flow).
      if (token.toUpperCase().startsWith("OTHER:")) continue;
      // ACCESSORY (no catalog defined yet): every non-OTHER token is unknown.
      // BEDFRAME / SOFA: case-insensitive match against the category catalog.
      if (!allowed.has(token.toLowerCase())) {
        unknown.push({ token, itemCategory: cat || "(unknown)", lineIndex: i });
      }
    }
  }
  return { valid: unknown.length === 0, unknown };
}

/**
 * Standard 400 response payload for an unknown-specialOrder rejection.
 * Mirrors `unknownFabricCodeError` from fabric-validation.ts so the frontend
 * toast handler can render both the same way.
 */
export function unknownSpecialOrderError(
  unknown: SpecialOrderValidationResult["unknown"],
): { success: false; error: string } {
  const first = unknown[0];
  if (!first) {
    return { success: false, error: "Unknown specialOrder token." };
  }
  const cat = first.itemCategory.toLowerCase();
  return {
    success: false,
    error:
      `Unknown specialOrder "${first.token}" on line ${first.lineIndex + 1} (${cat}). ` +
      `Pick from the dropdown, or use "Add custom" for freeform values.`,
  };
}
