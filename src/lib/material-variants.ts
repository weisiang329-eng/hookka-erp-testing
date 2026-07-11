// ---------------------------------------------------------------------------
// material-variants.ts — per-category variant suffixes for the Add RM
// "Bulk generate" mode (owner 2026-07-11), mirroring the Add FG generator.
//
// Each raw-material category (itemGroup: FOAM, FABRIC, PLYWOOD…) keeps its own
// list of variant suffixes (FOAM → 6mm / 1" / 2" / 3" / 4"). On Add RM the
// operator picks a category + a BASE code, ticks the variants, and one material
// is created per tick: code = `{base}/{variant}` (e.g. "NC36/50" + "6mm" →
// "NC36/50/6mm"). The lists are stored on kv-config `variants-config` under
// `materialVariants` and edited inline in the bulk form (which doubles as the
// "Material Categories" maintenance).
// ---------------------------------------------------------------------------

/** category (itemGroup) → its variant suffixes. */
export type MaterialVariants = Record<string, string[]>;

// Seed: FOAM thickness range from the owner's example. Other categories start
// empty and the owner fills them inline. Keys match the RM itemGroup values.
export const DEFAULT_MATERIAL_VARIANTS: MaterialVariants = {
  FOAM: ["6mm", '1"', '2"', '3"', '4"'],
};

/** Raw-material variant code: `{base}/{variant}` → "NC36/50/6mm" (the owner's
 * separator is "/", distinct from the FG "-"). */
export function materialVariantCode(base: string, variant: string): string {
  return `${base.trim()}/${variant.trim()}`;
}

/** Variant description: "`{baseDescription} {variant}`", or just the variant
 * when no base description was typed. */
export function materialVariantDescription(baseDescription: string, variant: string): string {
  const b = baseDescription.trim();
  return b ? `${b} ${variant.trim()}` : variant.trim();
}
