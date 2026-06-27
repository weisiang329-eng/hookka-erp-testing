// ===========================================================================
// Mobile UI theme tokens (Phase 1)
//
// Thin layer over the app-wide design tokens in src/lib/design-tokens.ts.
// The mobile shell uses inline-style hex values (not Tailwind classes) so the
// new phone surfaces render identically regardless of the surrounding utility
// classes — but every status colour still resolves through the SAME
// SemanticStyle maps the desktop app uses, so brand drift is impossible.
//
// ADDITIVE: nothing here changes the existing desktop/responsive app. These
// constants are imported ONLY by files under src/pages/m/.
// ===========================================================================
import {
  type SemanticStyle,
  SUCCESS,
  INFO,
  WARNING,
  DANGER,
  NEUTRAL,
} from "@/lib/design-tokens";

/** Brand palette for the phone UI (mirrors the handoff spec + BRAND tokens). */
export const M = {
  /** Dark raisin — dark surfaces / dark text on light. */
  raisin: "#1F1D1B",
  /** Warm taupe — primary / active. */
  taupe: "#6B5C32",
  taupeDark: "#574A28",
  /** Paper — app background. */
  paper: "#FAF8F4",
  /** White card surface. */
  card: "#FFFFFF",
  /** Card / hairline border. */
  border: "#E7E0D4",
  /** Gold accent. */
  gold: "#C9A961",
  /** Body / muted text. */
  body: "#6B7280",
  muted: "#8A7F73",
  /** Logo gradient endpoints. */
  logoFrom: "#8B7A4E",
  logoTo: "#6B5C32",
} as const;

/** Max content width for the phone shell. */
export const M_MAX_WIDTH = 414;

/** System font stack used everywhere on the phone UI. */
export const M_FONT =
  'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

// ---------------------------------------------------------------------------
// Status → SemanticStyle resolution.
//
// Each module's status enum is stored as the repo's canonical UPPER_SNAKE
// value but DISPLAYED in Title Case. We resolve colours through the existing
// design-tokens maps; an unknown value falls back to NEUTRAL (mirrors
// resolveUnknownStatus, without the dev warning spam on every list row).
// ---------------------------------------------------------------------------

/** Convert an UPPER_SNAKE enum value to "Title Case" for display. */
export function titleCaseStatus(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw
    .toString()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Re-export the core semantic styles for direct use by mobile primitives. */
export const SEMANTIC = { SUCCESS, INFO, WARNING, DANGER, NEUTRAL } as const;

export type { SemanticStyle };
