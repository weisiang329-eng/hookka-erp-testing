// ---------------------------------------------------------------------------
// fg-variants.ts — shared finished-goods variant catalogs + code/name derivation.
//
// The Bedframe Sizes and Sofa Compartments catalogs are editable in
// Products → Maintenance (stored on kv-config `variants-config`), and drive the
// Inventory → Add FG "Bulk generate" mode: the operator enters just Base Model +
// Name + Category and ticks the sizes / compartments, and each variant's Code,
// Size Code, Size Label and Name are derived here (owner 2026-07-11). Fabric
// usage + prices are left blank and filled later via Batch Edit.
//
// ONE source of truth for the seed defaults + the naming rules so the Maintenance
// page and the Add FG generator can never drift. Naming rules match the existing
// live catalog exactly (verified against prod: bedframe `1003-(K)` /
// "HILTON BEDFRAME (6FT) (183X190CM)"; sofa `5539-1A(LHF)` / "SOFA 5539 1A(LHF)").
// ---------------------------------------------------------------------------

/** A bedframe size row: CODE drives the variant code + runtime piece count;
 * LABEL + DIMENSIONS are embedded in the variant name. */
export type BedframeSize = { code: string; label: string; dimensions: string };

// Seed catalogs — used as the Maintenance defaults AND as the Add FG fallback
// when the owner hasn't customised the lists yet (so bulk-generate works out of
// the box). The owner edits these in Products → Maintenance.
export const DEFAULT_BEDFRAME_SIZES: BedframeSize[] = [
  { code: "K", label: "6FT", dimensions: "183X190CM" },
  { code: "Q", label: "5FT", dimensions: "152X190CM" },
  { code: "S", label: "3FT", dimensions: "90X190CM" },
  { code: "SS", label: "3.5FT", dimensions: "107X190CM" },
  { code: "SK", label: "SuperKing", dimensions: "200X200CM" },
];

export const DEFAULT_SOFA_COMPARTMENTS: string[] = [
  "1A(LHF)", "1A(RHF)", "1B(LHF)", "1B(RHF)", "1NA", "1S",
  "2A(LHF)", "2A(RHF)", "2B(LHF)", "2B(RHF)", "2NA", "2S",
  "3A(LHF)", "3A(RHF)", "3NA",
  "L(LHF)", "L(RHF)", "CNR", "STOOL",
];

/** Bedframe variant product code: `{baseModel}-({sizeCode})` → "1003-(K)"
 * (UPPERCASE — owner 2026-07-11: all generated codes/names unified to caps). */
export function bedframeVariantCode(baseModel: string, sizeCode: string): string {
  return `${baseModel.trim()}-(${sizeCode.trim()})`.toUpperCase();
}

/** Bedframe variant name: "`{baseName} ({label}) ({dimensions})`" — empty
 * parentheses dropped so a size with no label/dimensions still reads cleanly.
 * UPPERCASE (owner 2026-07-11: all generated text unified to caps). */
export function bedframeVariantName(baseName: string, size: BedframeSize): string {
  return [
    baseName.trim(),
    size.label.trim() ? `(${size.label.trim()})` : "",
    size.dimensions.trim() ? `(${size.dimensions.trim()})` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
}

/** Sofa variant product code: `{baseModel}-{compartment}` → "5539-1A(LHF)"
 * (UPPERCASE — unified with the rest of the generated fields). */
export function sofaVariantCode(baseModel: string, compartment: string): string {
  return `${baseModel.trim()}-${compartment.trim()}`.toUpperCase();
}

/** Sofa variant name: "`{baseName} {compartment}`", or "`SOFA {model} {compartment}`"
 * when no base name is supplied (matches the existing catalog convention). */
export function sofaVariantName(baseName: string, baseModel: string, compartment: string): string {
  const b = baseName.trim();
  return (b ? `${b} ${compartment.trim()}` : `SOFA ${baseModel.trim()} ${compartment.trim()}`).toUpperCase();
}

// Bedframe size CODE → the human size word used in the auto description
// ("hilton bedframe KING 6ft (183x190cm)"). Unknown codes drop the word.
const BEDFRAME_SIZE_WORDS: Record<string, string> = {
  K: "king",
  Q: "queen",
  S: "single",
  SS: "super single",
  SK: "super king",
  SP: "special",
};

/** Bedframe variant description — UPPERCASE "`{baseName} {sizeWord} {label}
 * ({dimensions})`" (owner 2026-07-11: unify all generated text to caps, e.g.
 * "HILTON BEDFRAME KING 6FT (183X190CM)"). */
export function bedframeVariantDescription(baseName: string, size: BedframeSize): string {
  const word = BEDFRAME_SIZE_WORDS[size.code.trim().toUpperCase()] ?? "";
  return [
    baseName.trim(),
    word,
    size.label.trim(),
    size.dimensions.trim() ? `(${size.dimensions.trim()})` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
}

/** Sofa variant description — UPPERCASE "`SOFA {model} MODULE {compartment}`"
 * (e.g. "SOFA 5530 MODULE 1NA"). */
export function sofaVariantDescription(baseModel: string, compartment: string): string {
  return `sofa ${baseModel.trim()} module ${compartment.trim()}`.toUpperCase();
}
