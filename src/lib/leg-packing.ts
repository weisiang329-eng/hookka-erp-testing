// ---------------------------------------------------------------------------
// Shared "pack leg separately" resolution.
//
// A leg is represented in the product catalog as a LEG-HEIGHT OPTION in the
// `variants-config` blob (kv_config), under `legHeights` (bedframe / divan)
// and `sofaLegHeights` (sofa). Each option is a PricedOption:
//
//     { value: '4"', priceSen: 0, packSeparately?: boolean }
//
// `packSeparately` is the owner-set, once-per-leg-height flag:
//   - TICKED:    the leg ships in its own box and shows as its OWN piece on
//                the FG packing sticker (its own box in the X/N count).
//   - UNTICKED:  the leg ships inside the main item (no separate box).
//   - UNDEFINED (legacy rows that predate the flag): fall back to the old
//                height rule -- any leg taller than LEG_PACK_THRESHOLD_INCHES
//                got its own box. This keeps pre-existing configs unchanged.
//
// Production orders carry the leg height as a NUMBER (`legHeightInches`), while
// the catalog keys it as a STRING (`4"`). The mapping is exact: 4 maps to "4"",
// null / 0 maps to "No Leg". This module centralises both the option-list
// lookup and the legacy fallback so the Maintenance editor and the FG-sticker
// builder agree on the rule.
// ---------------------------------------------------------------------------

// Legacy rule: legs taller than 1" used to get their own pack. Mirrors the
// LEG_PACK_THRESHOLD_INCHES constant in the FG-sticker aggregation block.
export const LEG_PACK_THRESHOLD_INCHES = 1;

export type LegHeightOption = {
  value: string;
  priceSen: number;
  packSeparately?: boolean;
};

/** Parse inches from a height string like '4"', '10.5"', or 'No Leg'. */
export function parseLegInches(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = value.match(/^(\d+(?:\.\d+)?)"/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Legacy default for a leg height when no explicit flag is set: anything
 * strictly taller than the threshold packs separately. Used to seed new rows
 * in the Maintenance editor and as the fallback when `packSeparately` is
 * undefined on an existing option.
 */
export function legHeightPacksByDefault(value: string): boolean {
  const inches = parseLegInches(value);
  return inches !== null && inches > LEG_PACK_THRESHOLD_INCHES;
}

/**
 * Resolve a single leg-height option to a boolean. Explicit flag wins; when
 * undefined, fall back to the legacy height rule.
 */
export function optionPacksSeparately(opt: LegHeightOption): boolean {
  if (typeof opt.packSeparately === "boolean") return opt.packSeparately;
  return legHeightPacksByDefault(opt.value);
}

/**
 * Decide whether a leg of `legHeightInches` (the production-order number)
 * packs separately, given the catalog's leg-height option list. Looks the
 * height up by its `N"` string form; if the catalog has no matching row
 * (e.g. an ad-hoc height the operator typed), fall back to the legacy
 * height rule so behaviour is never worse than before.
 */
export function legPacksSeparately(
  legHeightInches: number | null | undefined,
  options: LegHeightOption[] | null | undefined,
): boolean {
  if (legHeightInches === null || legHeightInches === undefined || legHeightInches <= 0) {
    return false;
  }
  const key = `${legHeightInches}"`;
  const match = (options ?? []).find((o) => o.value === key);
  if (match) return optionPacksSeparately(match);
  // No catalog row for this exact height — legacy fallback.
  return legHeightInches > LEG_PACK_THRESHOLD_INCHES;
}
