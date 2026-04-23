// ---------------------------------------------------------------------------
// Client helper for the D1-backed /api/kv-config/:key store.
//
// Replaces the legacy `hookka-variants-config` localStorage blob. The shape of
// the blob is decided by the callers — we just handle transport, in-memory
// caching, and debounced saves so pages don't have to re-invent it each time.
//
// The in-memory cache is the single source of truth *within a session*. On
// first read we hydrate from the server; writes update the cache synchronously
// and schedule a debounced PUT. Callers get optimistic reads immediately.
//
// API failures (offline, 5xx, auth hiccup) are swallowed so the UI stays
// functional — the in-memory value is still correct, it just isn't persisted
// until the next successful save.
// ---------------------------------------------------------------------------
import { getAuthToken } from "./auth";

type JsonValue = unknown;

type CacheEntry = {
  value: JsonValue;
  hydrated: boolean;
  hydratePromise: Promise<JsonValue> | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  listeners: Set<(value: JsonValue) => void>;
};

const cache = new Map<string, CacheEntry>();
const SAVE_DEBOUNCE_MS = 500;

function ensureEntry(key: string): CacheEntry {
  let e = cache.get(key);
  if (!e) {
    e = {
      value: null,
      hydrated: false,
      hydratePromise: null,
      saveTimer: null,
      listeners: new Set(),
    };
    cache.set(key, e);
  }
  return e;
}

function authHeaders(): HeadersInit {
  const token = getAuthToken();
  const base: Record<string, string> = { "content-type": "application/json" };
  if (token) base.authorization = `Bearer ${token}`;
  return base;
}

/**
 * Fetch the key from D1, caching the result. Returns `null` if the key is
 * missing or the request fails (caller can fall back to defaults).
 *
 * Safe to call multiple times — concurrent callers share one in-flight request.
 */
export async function fetchKvConfig<T = JsonValue>(
  key: string,
): Promise<T | null> {
  const entry = ensureEntry(key);
  if (entry.hydrated) return entry.value as T | null;
  if (entry.hydratePromise) return entry.hydratePromise as Promise<T | null>;

  entry.hydratePromise = (async () => {
    try {
      const res = await fetch(`/api/kv-config/${encodeURIComponent(key)}`, {
        headers: authHeaders(),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { success?: boolean; data?: JsonValue };
      const data = json?.data ?? null;
      entry.value = data;
      entry.hydrated = true;
      return data;
    } catch {
      // Offline or bad gateway — leave unhydrated so the next read retries.
      return null;
    } finally {
      entry.hydratePromise = null;
    }
  })();

  return entry.hydratePromise as Promise<T | null>;
}

/**
 * Synchronous read from the in-memory cache. Returns `null` if not hydrated
 * yet. Use alongside `fetchKvConfig` to avoid blocking renders.
 */
export function peekKvConfig<T = JsonValue>(key: string): T | null {
  const entry = cache.get(key);
  return entry?.hydrated ? (entry.value as T) : null;
}

// Per-entry "save failed" listeners — products/index.tsx subscribes here so
// it can flip the "Auto-saved" badge back to "Save failed" when the PUT
// didn't make it to the server (4xx/5xx or offline).
const saveErrorListeners = new Map<string, Set<(error: Error) => void>>();

export function subscribeKvConfigSaveError(
  key: string,
  listener: (error: Error) => void,
): () => void {
  if (!saveErrorListeners.has(key)) saveErrorListeners.set(key, new Set());
  saveErrorListeners.get(key)!.add(listener);
  return () => {
    saveErrorListeners.get(key)?.delete(listener);
  };
}

async function flushSave(key: string): Promise<boolean> {
  const entry = cache.get(key);
  if (!entry) return false;
  try {
    const res = await fetch(`/api/kv-config/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify(entry.value),
    });
    // fetch only throws on network error — an HTTP 4xx/5xx resolves
    // normally with ok=false, so we must check explicitly. Before this
    // guard a 401 (expired token) or 500 silently marked the change as
    // saved, which is how users ended up losing entries after a
    // refresh. Surface the failure via saveErrorListeners so the UI
    // can prompt a retry.
    if (!res.ok) {
      const err = new Error(`kv-config save failed: HTTP ${res.status}`);
      for (const cb of saveErrorListeners.get(key) ?? []) {
        try { cb(err); } catch { /* ignore */ }
      }
      return false;
    }
    return true;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    for (const cb of saveErrorListeners.get(key) ?? []) {
      try { cb(err); } catch { /* ignore */ }
    }
    return false;
  }
}

/**
 * Flush any pending debounced save for this key immediately and await the
 * server response. Returns true when the server accepted the write. Used by
 * pages that need confirmation before telling the user "saved" — the bare
 * `setKvConfig` schedules a debounced PUT and returns before the network
 * round-trip, so its caller can't tell success from silent failure.
 */
export async function flushKvConfig(key: string): Promise<boolean> {
  const entry = cache.get(key);
  if (!entry) return true;
  if (entry.saveTimer) {
    clearTimeout(entry.saveTimer);
    entry.saveTimer = null;
  }
  return flushSave(key);
}

/**
 * Update the cached value and schedule a debounced PUT. Returns immediately;
 * subscribers get the new value synchronously via `subscribeKvConfig`.
 */
export function setKvConfig(key: string, value: JsonValue): void {
  const entry = ensureEntry(key);
  entry.value = value;
  entry.hydrated = true;
  for (const cb of entry.listeners) {
    try {
      cb(value);
    } catch {
      /* ignore listener errors */
    }
  }
  if (entry.saveTimer) clearTimeout(entry.saveTimer);
  entry.saveTimer = setTimeout(() => {
    entry.saveTimer = null;
    void flushSave(key);
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Update a nested subset of the stored JSON, preserving other fields.
 * Equivalent to `{ ...existing, ...patch }`. Assumes the stored value is an
 * object (falls back to `{}` if not yet hydrated or null).
 */
export function patchKvConfig(
  key: string,
  patch: Record<string, unknown>,
): void {
  const entry = ensureEntry(key);
  const current =
    entry.value && typeof entry.value === "object" && !Array.isArray(entry.value)
      ? (entry.value as Record<string, unknown>)
      : {};
  setKvConfig(key, { ...current, ...patch });
}

/** Subscribe to value changes. Returns an unsubscribe function. */
export function subscribeKvConfig(
  key: string,
  listener: (value: JsonValue) => void,
): () => void {
  const entry = ensureEntry(key);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Convenience wrapper for the legacy "variants-config" blob.
// ---------------------------------------------------------------------------

export const VARIANTS_CONFIG_KEY = "variants-config";

export type VariantsConfig = {
  fabricGroups?: string[];
  productionTimes?: Record<string, Record<string, number>>;
  divanHeights?: unknown[];
  legHeights?: unknown[];
  totalHeights?: unknown[];
  gaps?: string[];
  specials?: unknown[];
  sofaLegHeights?: unknown[];
  sofaSpecials?: unknown[];
  sofaSizes?: string[];
  [extra: string]: unknown;
};

export function getVariantsConfigSync(): VariantsConfig | null {
  return peekKvConfig<VariantsConfig>(VARIANTS_CONFIG_KEY);
}

export function fetchVariantsConfig(): Promise<VariantsConfig | null> {
  return fetchKvConfig<VariantsConfig>(VARIANTS_CONFIG_KEY);
}

export function patchVariantsConfig(patch: Partial<VariantsConfig>): void {
  patchKvConfig(VARIANTS_CONFIG_KEY, patch as Record<string, unknown>);
}

export function setVariantsConfig(value: VariantsConfig): void {
  setKvConfig(VARIANTS_CONFIG_KEY, value);
}
