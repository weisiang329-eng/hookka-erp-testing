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

/**
 * Brand palette for the phone UI. CHANGELOG (owner 2026-06-29) requires
 * Dark/Light mode toggle. Values are now CSS custom properties — the
 * concrete colour values live in src/pages/m/theme-vars.css and flip per
 * `[data-theme="dark"]` on the document root. Components reference M.foo
 * verbatim (e.g. `style={{ backgroundColor: M.paper }}`) so the CSS-var
 * indirection is transparent.
 *
 * Light mode = the design source's authoritative values (Hookka ERP
 * Mobile.dc.html). Dark mode swaps surfaces to dark + text to light while
 * keeping the taupe accent + gold readable.
 */
export const M = {
  raisin: "var(--m-raisin)",
  taupe: "var(--m-taupe)",
  taupeDark: "var(--m-taupe-dark)",
  paper: "var(--m-paper)",
  card: "var(--m-card)",
  border: "var(--m-border)",
  hairline: "var(--m-hairline)",
  divider: "var(--m-divider)",
  gold: "var(--m-gold)",
  ink: "var(--m-ink)",
  body: "var(--m-body)",
  muted: "var(--m-muted)",
  faint: "var(--m-faint)",
  logoFrom: "var(--m-logo-from)",
  logoTo: "var(--m-logo-to)",
} as const;

/**
 * Tinted "icon tile" accents used on the Home dashboard (KPI cards,
 * quick-action tiles, stock-alert rows). These mirror the design source's
 * `S` palette EXACTLY: [tileBg, iconColor]. They are NOT status pills — they
 * are decorative accent tiles, so they live here rather than in the semantic
 * status map.
 */
export const M_ACCENT = {
  gold: { bg: "#F0EAD8", fg: "#6B5C32" },
  info: { bg: "#E0EDF0", fg: "#3E6570" },
  moss: { bg: "#EEF3E4", fg: "#4F7C3A" },
  danger: { bg: "#F9E1DA", fg: "#9A3A2D" },
  warning: { bg: "#FAEFCB", fg: "#9C6F1E" },
  plum: { bg: "#F1E6F0", fg: "#6B4A6D" },
} as const;

/** Positive (up) / negative (down) delta text colours. */
export const M_DELTA = { up: "#4F7C3A", down: "#9A3A2D" } as const;

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
