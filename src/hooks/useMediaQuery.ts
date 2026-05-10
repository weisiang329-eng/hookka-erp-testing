"use client";

import { useState, useEffect } from "react";

/**
 * useMediaQuery — subscribe to a CSS media-query string and re-render when
 * the match state flips.
 *
 * Used by responsive layout decisions (e.g. default-hiding low-priority
 * DataGrid columns on tablet, auto-collapsing the sidebar in portrait).
 *
 * SSR-safe: returns `false` on the server / pre-hydration. The first effect
 * pass on the client syncs the real value via `matchMedia`.
 *
 * @example
 * ```tsx
 * const isTablet = useMediaQuery("(max-width: 1280px)");
 * const isPortrait = useMediaQuery("(orientation: portrait)");
 * ```
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(query);
    // Sync state on mount in case the query changed since the lazy initialiser
    // ran (e.g. SSR -> hydrate, or query string changed across renders).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot media-query rehydrate; pattern used across responsive hooks
    setMatches(mql.matches);

    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    // addEventListener is the modern API (Safari 14+, all evergreens). Older
    // Safari used addListener — we don't support it; the codebase already
    // assumes evergreen browsers.
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}
