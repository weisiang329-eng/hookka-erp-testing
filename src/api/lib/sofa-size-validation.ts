// ---------------------------------------------------------------------------
// sofa-size-validation.ts — single-source validator for SOFA sizeLabel
// values landing on sales_order_items + consignment_order_items.
//
// Source of truth: kv_config.variants-config.sofaSizes (the same list the
// frontend SOFA seat-size dropdown reads). Currently bare numerics
// like ["24","26","28","30","32","35"]. The validator does not transform
// — values that don't match exactly are rejected, mirroring the
// "reject, don't normalize" rule (feedback_reject_dont_normalize.md).
//
// Phase 1 of DUP-001 fix:
//   A. backfill cleaned existing dirty rows (af372e8)
//   B. removed normalize-add-quote logic at SO POST/PUT (f2fa7a9)
//   C. THIS FILE — gate that rejects new SOFA sizeLabel writes that don't
//      match the dropdown source
//
// Usage (pattern mirrors fabric-validation.ts):
//   const { valid, unknown } = await validateSofaSizeLabels(c.var.DB, items);
//   if (!valid) {
//     return c.json(unknownSofaSizeLabelError(unknown), 400);
//   }
// ---------------------------------------------------------------------------

const KV_CONFIG_KEY = "variants-config";

export type SofaSizeValidationResult = {
  valid: boolean;
  unknown: string[];
  /** The canonical list at the time of the check — surfaced for the error
   *  message so the operator sees which values WERE allowed. */
  allowed: string[];
};

type CategorisedItem = {
  itemCategory?: string | null;
  sizeLabel?: string | null | undefined;
};

/**
 * Validate that every SOFA item's sizeLabel matches an entry in
 * kv_config.variants-config.sofaSizes. Non-SOFA items are skipped (the
 * BEDFRAME / ACCESSORY sizeLabel comes from the products catalog, not
 * from this dropdown). Empty / null sizeLabel is also skipped — saving a
 * SOFA line without a seat height is an upstream concern.
 *
 * Returns the unknown values in input order so the caller surfaces a
 * stable, helpful error.
 */
export async function validateSofaSizeLabels(
  db: D1Database,
  items: CategorisedItem[],
): Promise<SofaSizeValidationResult> {
  // Quick exit when there are no SOFA items — saves a kv_config round-trip
  // for pure-BEDFRAME / pure-ACCESSORY orders.
  const sofaLabels: string[] = [];
  for (const it of items) {
    const cat = (it.itemCategory ?? "").toUpperCase();
    if (cat !== "SOFA") continue;
    const raw = it.sizeLabel == null ? "" : String(it.sizeLabel).trim();
    if (!raw) continue;
    sofaLabels.push(raw);
  }
  if (sofaLabels.length === 0) {
    return { valid: true, unknown: [], allowed: [] };
  }

  // Pull canonical list from kv_config. Missing row / malformed JSON / empty
  // sofaSizes array all degrade to "no canonical, accept everything" — the
  // gate's job is to enforce the dropdown source, and if there's no
  // dropdown source there's nothing to enforce against. Loud failure here
  // would block every SOFA write; silent pass-through keeps the order
  // create flow alive while the operator fixes the config.
  const row = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind(KV_CONFIG_KEY)
    .first<{ value: string }>();
  let allowed: string[] = [];
  if (row?.value) {
    try {
      const cfg = JSON.parse(row.value) as { sofaSizes?: unknown };
      if (Array.isArray(cfg.sofaSizes)) {
        allowed = cfg.sofaSizes
          .map((v) => (typeof v === "string" ? v : ""))
          .filter((s) => s.length > 0);
      }
    } catch {
      allowed = [];
    }
  }
  if (allowed.length === 0) {
    return { valid: true, unknown: [], allowed: [] };
  }

  const allowedSet = new Set(allowed);
  const unknownSet = new Set<string>();
  const unknownOrdered: string[] = [];
  for (const label of sofaLabels) {
    if (allowedSet.has(label)) continue;
    if (unknownSet.has(label)) continue;
    unknownSet.add(label);
    unknownOrdered.push(label);
  }
  return {
    valid: unknownOrdered.length === 0,
    unknown: unknownOrdered,
    allowed,
  };
}

/**
 * Convenience: build the standard 400 response payload when validation
 * fails. Quoting both the offending value AND the allowed list helps the
 * operator (and future debugging) see exactly what the dropdown source
 * permits.
 */
export function unknownSofaSizeLabelError(
  unknown: string[],
  allowed: string[],
): { success: false; error: string } {
  const first = unknown[0] ?? "";
  return {
    success: false,
    error: `Unknown SOFA sizeLabel: "${first}". Must match one of the dropdown values: ${allowed.join(", ")}.`,
  };
}
