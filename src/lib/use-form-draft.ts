// ---------------------------------------------------------------------------
// useFormDraft — auto-save half-filled forms to localStorage so a user who
// navigates away mid-edit can pick up where they left off.
//
// Usage pattern (manual restore — recommended):
//
//   const draft = useFormDraft("so-create:new", formValues);
//   const [restored, setRestored] = useState(false);
//
//   if (draft && !restored) {
//     // Show a banner: "Restore your draft? [Restore] [Discard]"
//     // On Restore:  apply draft to form state, setRestored(true)
//     // On Discard:  clearFormDraft(key); setRestored(true)
//   }
//
//   // Save on every change (the hook itself handles debouncing).
//
// Why manual restore? Auto-restoring would silently overwrite an empty form
// with stale data — surprising. Asking once via banner gives users control.
//
// Drafts older than `ttlMs` (default 7 days) are purged on read so we don't
// hand back zombie data from months ago.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useRef } from "react";

const PREFIX = "hookka:draft:";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 500;

type Wrapped<T> = {
  v: T;
  // Saved-at timestamp — used for TTL expiry.
  ts: number;
};

function readWrapped<T>(key: string, ttlMs: number): T | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Wrapped<T>;
    if (!parsed || typeof parsed.ts !== "number") return null;
    if (Date.now() - parsed.ts > ttlMs) {
      // Expired — purge and treat as no draft.
      localStorage.removeItem(PREFIX + key);
      return null;
    }
    return parsed.v;
  } catch {
    return null;
  }
}

function writeWrapped<T>(key: string, value: T): void {
  if (typeof localStorage === "undefined") return;
  try {
    const wrapped: Wrapped<T> = { v: value, ts: Date.now() };
    localStorage.setItem(PREFIX + key, JSON.stringify(wrapped));
  } catch {
    // quota or disabled storage — best-effort
  }
}

export function clearFormDraft(key: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}

export interface UseFormDraftOptions {
  ttlMs?: number;
}

/**
 * Watches `current` and writes it to localStorage under `hookka:draft:<key>`
 * with debouncing. On mount, returns whatever draft was already there
 * (or null). Auto-purges drafts older than `ttlMs`.
 *
 * The draft IS NOT auto-applied to the form — caller decides how to surface
 * it (typically a "Restore your draft?" banner). This avoids the surprise
 * of stale data overwriting a fresh form.
 */
export function useFormDraft<T>(
  key: string,
  current: T,
  options?: UseFormDraftOptions,
): T | null {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;

  // Captured ONCE on mount. Re-rendering doesn't re-read; the caller asked
  // "is there a draft to offer?" and the answer doesn't change mid-life.
  const initialDraft = useMemo<T | null>(() => readWrapped<T>(key, ttlMs), [key, ttlMs]);

  // Debounced save on every change to `current`. We reset the timer on each
  // change so a rapidly-typing user only triggers one write 500ms after the
  // last keystroke. useTimeout from src/lib/scheduler.ts can't express this
  // "reset on every value change" pattern — it's a one-shot. Inline timer
  // is the right shape here.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    // eslint-disable-next-line no-restricted-syntax -- debounce reset-on-change pattern; useTimeout would re-fire on every render and useInterval can't cancel cleanly
    timerRef.current = setTimeout(() => {
      writeWrapped(key, current);
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [key, current]);

  return initialDraft;
}
