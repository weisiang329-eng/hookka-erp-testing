// ---------------------------------------------------------------------------
// Shared "pack leg separately" resolution.
//
// A leg is represented in the product catalog as a LEG-HEIGHT OPTION in the
// `variants-config` blob (kv_config), under `legHeights` (bedframe / divan)
// and `sofaLegHeights` (sofa). Each option is a PricedOption:
//
//     { value: '4"', priceSen: 0, packSeparately?: boolean }
//
// `packSeparately` is the owner-set, once-per-leg-height flag and the SINGLE
// source of truth (Wei Siang 2026-06-02 — manage packing purely from the
// Products > Maintenance > Leg Heights checkbox; the old automatic
// "taller than 1 inch" height rule was removed):
//   - TICKED (true):  the leg ships in its own box and shows as its OWN piece
//                     on the FG packing sticker (its own box in the X/N count).
//   - UNTICKED / UNDEFINED: the leg ships inside the main item (no separate
//                     box). A leg only packs separately when its Maintenance
//                     checkbox is ticked — nothing is inferred from the height.
//
// Production orders carry the leg height as a NUMBER (`legHeightInches`), while
// the catalog keys it as a STRING (`4"`). The mapping is exact: 4 maps to "4"",
// null / 0 maps to "No Leg". This module centralises the option-list lookup so
// the Maintenance editor and the FG-sticker builder agree on the rule.
// ---------------------------------------------------------------------------

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
 * Resolve a single leg-height option to a boolean. Only the explicit
 * Maintenance flag matters: a leg packs separately iff `packSeparately` is
 * ticked (true). Untick / undefined => packed with the main item.
 */
export function optionPacksSeparately(opt: LegHeightOption): boolean {
  return opt.packSeparately === true;
}

/**
 * Decide whether a leg of `legHeightInches` (the production-order number)
 * packs separately, given the catalog's leg-height option list. Looks the
 * height up by its `N"` string form and returns its Maintenance flag. A height
 * with no catalog row (e.g. an ad-hoc height the operator typed) is treated as
 * NOT separate — only configured, ticked leg heights pack on their own.
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
  return match ? optionPacksSeparately(match) : false;
}
