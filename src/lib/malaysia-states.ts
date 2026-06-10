// ---------------------------------------------------------------------------
// malaysia-states.ts — canonical Malaysia state list for the 3PL per-state
// rate card (shared by frontend AND backend — keep dependency-free).
//
// Why canonical 3-letter codes: the live hub data carries city-flavoured
// shorthand (KL, PG, JB, SRW, IPH, KCH, KB, KT...) that drifted over time.
// The rate card stores ONE canonical code per state (`three_pl_state_rates.
// state`); writes are validated against MALAYSIA_STATES codes only
// (reject-don't-normalize — the backend never silently transforms input).
// `resolveStateCode` is the READ-side helper: it maps legacy hub shorthand /
// full labels onto a canonical code so later phases can look a hub's state
// up in the rate card. Unknown input resolves to null — never a guess.
// ---------------------------------------------------------------------------

export type MalaysiaState = {
  /** Canonical 3-letter code stored in three_pl_state_rates.state. */
  code: string;
  /** English display label. */
  label: string;
};

/** All 16 states / federal territories, in rate-card display order. */
export const MALAYSIA_STATES: readonly MalaysiaState[] = [
  { code: "KUL", label: "Kuala Lumpur" },
  { code: "SGR", label: "Selangor" },
  { code: "PNG", label: "Penang" },
  { code: "JHR", label: "Johor" },
  { code: "MLK", label: "Melaka" },
  { code: "NSN", label: "Negeri Sembilan" },
  { code: "PHG", label: "Pahang" },
  { code: "PRK", label: "Perak" },
  { code: "PLS", label: "Perlis" },
  { code: "KDH", label: "Kedah" },
  { code: "KTN", label: "Kelantan" },
  { code: "TRG", label: "Terengganu" },
  { code: "SBH", label: "Sabah" },
  { code: "SWK", label: "Sarawak" },
  { code: "PJY", label: "Putrajaya" },
  { code: "LBN", label: "Labuan" },
] as const;

const CODE_SET: ReadonlySet<string> = new Set(MALAYSIA_STATES.map((s) => s.code));

/** Display-order index per canonical code — for sorting badge lists etc. */
export const MALAYSIA_STATE_ORDER: ReadonlyMap<string, number> = new Map(
  MALAYSIA_STATES.map((s, i) => [s.code, i]),
);

/** Exact (case-sensitive) membership test against the canonical codes. */
export function isMalaysiaStateCode(v: unknown): v is string {
  return typeof v === "string" && CODE_SET.has(v);
}

// Legacy shorthand seen in live hub data → canonical state code. City-
// flavoured: IPH(Ipoh)→Perak, KCH(Kuching)→Sarawak, KB(Kota Bharu)→Kelantan,
// KT(Kuala Terengganu)→Terengganu. SRW is a non-standard Sarawak spelling.
const LEGACY_ALIASES: Record<string, string> = {
  KL: "KUL",
  PG: "PNG",
  JB: "JHR",
  SRW: "SWK",
  IPH: "PRK",
  KCH: "SWK",
  KB: "KTN",
  KT: "TRG",
};

// Lowercased full label → code ("selangor" → "SGR").
const LABEL_TO_CODE: Record<string, string> = Object.fromEntries(
  MALAYSIA_STATES.map((s) => [s.label.toLowerCase(), s.code]),
);

/**
 * Resolve free-form state input (legacy hub codes, full labels, any casing)
 * to a canonical MALAYSIA_STATES code. READ-side only — never use this to
 * launder user input into a write path (writes validate with
 * isMalaysiaStateCode and reject unknowns instead).
 *
 * Returns null for unknown / empty input.
 */
export function resolveStateCode(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  if (CODE_SET.has(upper)) return upper;
  if (LEGACY_ALIASES[upper]) return LEGACY_ALIASES[upper];
  return LABEL_TO_CODE[trimmed.toLowerCase()] ?? null;
}
