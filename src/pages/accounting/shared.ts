// ---------------------------------------------------------------------------
// accounting/shared.ts — shared types + helpers for the Accounting page and
// its per-tab components under accounting/tabs/.
//
// 2026-07-04: the Accounting page was one ~9.6k-line file with all ~30 tabs
// inline. Splitting each tab into its own file (behaviour-identical) needs a
// home for the small pieces every tab uses. Move shared items here; index.tsx
// and every tab import from "./shared" (or "../shared").
// ---------------------------------------------------------------------------

export type MutationResponse =
  | { success: true; error?: string }
  | { success: false; error?: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

/** Narrow an unknown API JSON body to the repo's { success, error } envelope. */
export function asMutationResponse(v: unknown): MutationResponse | null {
  if (!isRecord(v)) return null;
  if (v.success === true) {
    return {
      success: true,
      error: typeof v.error === "string" ? v.error : undefined,
    };
  }
  if (v.success === false) {
    return {
      success: false,
      error: typeof v.error === "string" ? v.error : undefined,
    };
  }
  return null;
}
