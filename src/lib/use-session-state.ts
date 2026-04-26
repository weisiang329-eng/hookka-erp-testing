// ---------------------------------------------------------------------------
// useSessionState — useState that survives refresh + nav within the same tab.
//
// Backed by sessionStorage (NOT localStorage) so it dies when the tab closes.
// Right tool for: scroll position on a long list, "is this dialog open right
// now", which sub-tab the user had open inside a detail page.
//
// Wrong tool for:
//   • cross-tab user prefs                — use localStorage directly
//   • shareable filter state              — use useUrlState
//   • mid-edit form drafts (>1 tab life)  — use useFormDraft
//
// SSR-safe: returns the default on the server / before hydration, then
// reads sessionStorage on first client render.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";

const PREFIX = "hookka:ss:";

function read<T>(key: string, def: T): T {
  if (typeof sessionStorage === "undefined") return def;
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (raw == null) return def;
    return JSON.parse(raw) as T;
  } catch {
    return def;
  }
}

function write<T>(key: string, val: T): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(val));
  } catch {
    // quota / disabled storage — best-effort, don't crash UI
  }
}

export function useSessionState<T>(
  key: string,
  def: T,
): [T, (next: T) => void] {
  const [value, setValueState] = useState<T>(() => read(key, def));

  // Track if we've mounted so the first effect doesn't pointlessly rewrite
  // the same value we just read out.
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    write(key, value);
  }, [key, value]);

  const setValue = useCallback((next: T) => {
    setValueState(next);
  }, []);

  return [value, setValue];
}
