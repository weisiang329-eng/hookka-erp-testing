// ---------------------------------------------------------------------------
// Client helper for the D1-backed /api/kv-config/:key store.
//
// Replaces the legacy `hookka-variants-config` localStorage blob. The shape of
// the blob is decided by the callers — we just handle transport, in-memory
// caching, and debounced saves so pages don't have to re-invent it each time.
//
// RESILIENCE LAYER (added 2026-04-29 — see BUG-2026-04-29-007):
//   Every `setKvConfig` writes the new value to localStorage AS A BACKUP
//   (`kv-config-pending:<key>`) before scheduling the network PUT. The
//   backup is cleared once the server confirms. So:
//
//     • If the user closes the tab inside the 500ms debounce window, the
//       backup persists and gets replayed next page load.
//     • If the PUT fails on a transient error (network blip / 5xx / 408 /
//       429), we auto-retry with backoff (1s → 2s → 4s) before giving up.
//       The backup stays on disk through every retry.
//     • If retries exhaust OR a permanent error fires (e.g. 422), the
//       backup STILL stays on disk and gets replayed on next page load.
//     • Auth errors (401 / 403) are flagged as their own state so the UI
//       can prompt re-login instead of looping retries.
//
//   Net effect: edits are effectively never lost. The user only sees a
//   "syncing" indicator while a write is in flight; "Saved" toasts fire
//   AFTER the server confirms.
// ---------------------------------------------------------------------------
import { getAuthToken } from "./auth";

type JsonValue = unknown;

export type KvSyncState = "idle" | "syncing" | "retrying" | "error" | "auth-error";

type CacheEntry = {
  value: JsonValue;
  hydrated: boolean;
  hydratePromise: Promise<JsonValue> | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAttempt: number; // 0 = first try; resets on every new setKvConfig
  syncState: KvSyncState;
  listeners: Set<(value: JsonValue) => void>;
};

const cache = new Map<string, CacheEntry>();
const SAVE_DEBOUNCE_MS = 500;
// Backoff schedule for transient failures (network / 5xx / 408 / 429).
// After RETRY_DELAYS_MS.length attempts the entry transitions to `error`,
// but the localStorage backup stays on disk for replay on next page load.
const RETRY_DELAYS_MS = [1000, 2000, 4000];

const PENDING_LS_PREFIX = "kv-config-pending:";

function ensureEntry(key: string): CacheEntry {
  let e = cache.get(key);
  if (!e) {
    e = {
      value: null,
      hydrated: false,
      hydratePromise: null,
      saveTimer: null,
      retryTimer: null,
      retryAttempt: 0,
      syncState: "idle",
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

function notifyValueListeners(entry: CacheEntry, value: JsonValue): void {
  for (const cb of entry.listeners) {
    try {
      cb(value);
    } catch {
      /* ignore listener errors */
    }
  }
}

// ---------------------------------------------------------------------------
// localStorage backup. Synchronous, can't fail (worst case — quota full —
// we just skip the backup; the in-memory cache still has the value).
// ---------------------------------------------------------------------------
type PendingEntry = {
  value: JsonValue;
  ts: number; // ms epoch — diagnostics only, not used for conflict resolution
};

function lsAvailable(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function pendingLsKey(key: string): string {
  return `${PENDING_LS_PREFIX}${key}`;
}

function writePending(key: string, value: JsonValue): void {
  if (!lsAvailable()) return;
  try {
    const entry: PendingEntry = { value, ts: Date.now() };
    localStorage.setItem(pendingLsKey(key), JSON.stringify(entry));
  } catch {
    // Quota / disabled / private mode — best effort only.
  }
}

function readPending(key: string): PendingEntry | null {
  if (!lsAvailable()) return null;
  try {
    const raw = localStorage.getItem(pendingLsKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingEntry;
    if (typeof parsed?.ts !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearPending(key: string): void {
  if (!lsAvailable()) return;
  try {
    localStorage.removeItem(pendingLsKey(key));
  } catch {
    // Ignore.
  }
}

function listPendingKeys(): string[] {
  if (!lsAvailable()) return [];
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PENDING_LS_PREFIX)) {
        keys.push(k.slice(PENDING_LS_PREFIX.length));
      }
    }
  } catch {
    /* ignore */
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Sync state machine. Listeners get state transitions for the dot indicator
// in the UI. Independent of saveError listeners (which are one-shot
// notifications used by older callers).
// ---------------------------------------------------------------------------
const syncStateListeners = new Map<string, Set<(state: KvSyncState) => void>>();

function setSyncState(key: string, state: KvSyncState): void {
  const entry = ensureEntry(key);
  if (entry.syncState === state) return;
  entry.syncState = state;
  for (const cb of syncStateListeners.get(key) ?? []) {
    try {
      cb(state);
    } catch {
      /* ignore */
    }
  }
}

export function getKvConfigSyncState(key: string): KvSyncState {
  return cache.get(key)?.syncState ?? "idle";
}

export function subscribeKvConfigSyncState(
  key: string,
  listener: (state: KvSyncState) => void,
): () => void {
  if (!syncStateListeners.has(key)) syncStateListeners.set(key, new Set());
  syncStateListeners.get(key)!.add(listener);
  return () => {
    syncStateListeners.get(key)?.delete(listener);
  };
}

// Per-entry "save failed" listeners — kept for backward compat. Modern
// callers should subscribe to syncState instead (it covers transient
// retries too without firing a fake error per attempt).
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

function notifyError(key: string, err: Error): void {
  for (const cb of saveErrorListeners.get(key) ?? []) {
    try {
      cb(err);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Core save flow with retry + localStorage backup integration.
// ---------------------------------------------------------------------------
type Outcome = "ok" | "transient" | "permanent" | "auth";

function classifyOutcome(status: number): Outcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "auth";
  // 408 = request timeout; 425 = too early; 429 = rate limited; 5xx = server.
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return "transient";
  }
  return "permanent";
}

async function flushSave(key: string): Promise<boolean> {
  const entry = cache.get(key);
  if (!entry) return false;

  // Cancel any pending retry — we're flushing now (either explicit user
  // action or a fresh debounced fire).
  if (entry.retryTimer) {
    clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }

  setSyncState(key, "syncing");

  let outcome: Outcome;
  let httpStatus = 0;

  try {
    const res = await fetch(`/api/kv-config/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify(entry.value),
    });
    httpStatus = res.status;
    outcome = classifyOutcome(res.status);
  } catch {
    // Network error / fetch threw — treat as transient.
    outcome = "transient";
  }

  if (outcome === "ok") {
    clearPending(key);
    entry.retryAttempt = 0;
    setSyncState(key, "idle");
    return true;
  }

  if (outcome === "transient" && entry.retryAttempt < RETRY_DELAYS_MS.length) {
    const delay = RETRY_DELAYS_MS[entry.retryAttempt];
    entry.retryAttempt++;
    setSyncState(key, "retrying");
    // Module-scope timer; not tied to React lifecycle.
    // eslint-disable-next-line no-restricted-syntax -- module-level retry backoff
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      void flushSave(key);
    }, delay);
    return false;
  }

  // Final failure — exhausted retries or permanent / auth error.
  // localStorage backup is preserved for next page load to replay.
  const detail = httpStatus > 0 ? `HTTP ${httpStatus}` : "network error";
  const err = new Error(`kv-config save failed: ${detail}`);
  notifyError(key, err);
  setSyncState(key, outcome === "auth" ? "auth-error" : "error");
  return false;
}

/**
 * Fetch the key from D1, caching the result. Returns `null` if the key is
 * missing or the request fails (caller can fall back to defaults).
 *
 * Hydrate-time replay: if a localStorage backup exists for this key (left
 * over from a previous session whose save didn't make it), we hydrate from
 * the backup AND fire a flush in the background. The local copy wins until
 * the server confirms; this is the right call because the user's last
 * action is fresher than whatever's on the server.
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
    // Replay path: localStorage has unsynced data from a previous session.
    const pending = readPending(key);
    if (pending) {
      entry.value = pending.value;
      entry.hydrated = true;
      notifyValueListeners(entry, pending.value);
      // Fire and forget — the syncState machine handles retries.
      void flushSave(key);
      return pending.value;
    }

    // Normal path: fetch from server.
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

/**
 * Flush any pending debounced save for this key immediately and await the
 * server response. Returns true when the server accepted the write.
 *
 * Note: returns false on the FIRST attempt of a transient failure even
 * though retries are scheduled. Callers who only need eventual consistency
 * should use the syncState listener instead — it transitions to `idle`
 * when the data eventually lands.
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
 *
 * Always writes a localStorage backup before scheduling the PUT — the
 * backup survives tab close, network failures, and 401s, and is replayed
 * on next page load.
 */
export function setKvConfig(key: string, value: JsonValue): void {
  const entry = ensureEntry(key);
  entry.value = value;
  entry.hydrated = true;

  // Persistent backup — synchronous and untouchable by the network layer.
  writePending(key, value);

  notifyValueListeners(entry, value);

  // A new write supersedes any in-flight retry — reset the retry counter
  // so the new value gets a fresh 3-attempt budget.
  if (entry.retryTimer) {
    clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }
  entry.retryAttempt = 0;

  if (entry.saveTimer) clearTimeout(entry.saveTimer);
  setSyncState(key, "syncing");
  // Module-scope debounce timer keyed off the cache map — not bound to any
  // React component lifecycle, so the useTimeout hook doesn't apply here.
  // eslint-disable-next-line no-restricted-syntax -- module-level debounce, lives outside React lifecycle
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
// Startup replay — best effort attempt to flush any localStorage backups
// left from previous sessions. Runs once when the module first loads in a
// browser context. Defers to the next tick so auth/etc has time to wire.
// ---------------------------------------------------------------------------
function replayPendingOnStartup(): void {
  const pendingKeys = listPendingKeys();
  for (const key of pendingKeys) {
    const entry = ensureEntry(key);
    if (entry.hydrated) {
      // Already loaded by something — fetchKvConfig handles replay there.
      continue;
    }
    const pending = readPending(key);
    if (!pending) continue;
    entry.value = pending.value;
    entry.hydrated = true;
    notifyValueListeners(entry, pending.value);
    void flushSave(key);
  }
}

if (typeof window !== "undefined") {
  // Defer to next tick so the rest of the bundle (auth init, fetch
  // polyfills, etc) has a chance to settle before we fire writes.
  // eslint-disable-next-line no-restricted-syntax -- module-level startup deferral
  setTimeout(replayPendingOnStartup, 0);
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
