// ---------------------------------------------------------------------------
// SDK cache layer — small SWR around fetchJson.
//
// Why a separate cache from `cached-fetch.ts`?
//   - `cached-fetch.ts` exists primarily as a React hook + localStorage SWR
//     for whole-page data. It's load-bearing and we don't want to disturb it.
//   - The SDK needs an in-memory + sessionStorage layer that can be shared
//     across multiple resource modules, dedupe in-flight requests, and
//     provide simple prefix-invalidation tied to *URL strings* the SDK uses.
//
// Behaviour:
//   - Memory map keyed on cacheKey = `${url}` (params already encoded).
//   - On read: return cached value if `Date.now() - fetchedAt < ttlMs`.
//   - Otherwise: dedupe with an in-flight Promise map, refetch, store.
//   - On stale (cached but expired): return cached immediately, kick off
//     background refetch — the SWR pattern. Caller gets the cached value
//     synchronously via `peek()`.
//   - sessionStorage mirror so a soft refresh keeps the cache; lost on tab
//     close which is fine for ERP data freshness.
//
// Invalidation:
//   - `invalidatePrefix("/api/customers")` drops all keys matching the prefix
//     in both memory and sessionStorage.
//   - Re-exports `invalidateCachePrefix` from `cached-fetch.ts` so callers
//     can wipe the page-cache too in one mutation handler.
// ---------------------------------------------------------------------------
import { invalidateCachePrefix as legacyInvalidateCachePrefix } from "../cached-fetch";

const STORAGE_NAMESPACE = "hookka-sdk-cache:v1:";

type CacheEntry<T> = {
  data: T;
  fetchedAt: number;
};

// In-memory cache. Survives navigations within the SPA, dropped on full reload.
const memCache = new Map<string, CacheEntry<unknown>>();

// In-flight de-duplication. Two callers asking for the same URL share one
// Promise — dropped from the map when settled.
const inflight = new Map<string, Promise<unknown>>();

function storageKey(key: string): string {
  return STORAGE_NAMESPACE + key;
}

function readSession<T>(key: string): CacheEntry<T> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (!parsed || typeof parsed.fetchedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSession<T>(key: string, entry: CacheEntry<T>): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey(key), JSON.stringify(entry));
  } catch {
    // quota / disabled — best effort, memCache still holds the entry
  }
}

function removeSession(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(storageKey(key));
  } catch {
    /* ignore */
  }
}

/** Synchronously peek the cache; returns the entry or null. */
export function peek<T>(key: string): CacheEntry<T> | null {
  const mem = memCache.get(key);
  if (mem) return mem as CacheEntry<T>;
  const session = readSession<T>(key);
  if (session) {
    memCache.set(key, session);
    return session;
  }
  return null;
}

export function isFresh(entry: { fetchedAt: number }, ttlMs: number): boolean {
  return Date.now() - entry.fetchedAt < ttlMs;
}

export function setEntry<T>(key: string, data: T): void {
  const entry: CacheEntry<T> = { data, fetchedAt: Date.now() };
  memCache.set(key, entry);
  writeSession<T>(key, entry);
}

/** Drop a single key. */
export function invalidate(key: string): void {
  memCache.delete(key);
  removeSession(key);
}

/**
 * Drop every memory + sessionStorage entry whose KEY starts with `prefix`.
 * Note: keys are typically URLs like `/api/customers?...`, so the URL prefix
 * is the natural way to wipe a domain ("/api/customers").
 */
export function invalidatePrefix(prefix: string): void {
  for (const k of Array.from(memCache.keys())) {
    if (k.startsWith(prefix)) memCache.delete(k);
  }
  if (typeof window === "undefined") return;
  try {
    const fullPrefix = storageKey(prefix);
    const toRemove: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      if (k && k.startsWith(fullPrefix)) toRemove.push(k);
    }
    for (const k of toRemove) window.sessionStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/** Wipe everything the SDK has cached. */
export function clearAll(): void {
  memCache.clear();
  if (typeof window === "undefined") return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      if (k && k.startsWith(STORAGE_NAMESPACE)) toRemove.push(k);
    }
    for (const k of toRemove) window.sessionStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

type CachedFetchOptions = {
  /** TTL in seconds. <= 0 disables caching. */
  ttlSec?: number;
  /** Force bypass cache and refetch. */
  force?: boolean;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
};

/**
 * SWR helper wrapped around any async fetcher.
 *
 * - If a fresh entry exists, returns it without calling the fetcher.
 * - If a stale entry exists, returns it AND fires the fetcher in the
 *   background to refresh the cache.
 * - If no entry exists, awaits the fetcher.
 * - Concurrent calls to the same key share one in-flight Promise.
 */
export async function cachedFetch<T>(
  key: string,
  fetcher: (signal?: AbortSignal) => Promise<T>,
  options: CachedFetchOptions = {},
): Promise<T> {
  const { ttlSec = 0, force = false, signal } = options;
  const ttlMs = ttlSec * 1000;

  if (!force && ttlMs > 0) {
    const entry = peek<T>(key);
    if (entry && isFresh(entry, ttlMs)) {
      return entry.data;
    }
    if (entry) {
      // Stale: serve immediately and refresh in background. We don't pass
      // the caller's signal to the background refetch — they've already got
      // their answer, so cancellation no longer matters to them.
      void runFetcher(key, fetcher).catch(() => {
        /* swallow; next read will retry */
      });
      return entry.data;
    }
  }

  return runFetcher(key, fetcher, signal);
}

function runFetcher<T>(
  key: string,
  fetcher: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = fetcher(signal)
    .then((data) => {
      setEntry(key, data);
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise as Promise<unknown>);
  return promise;
}

// Re-export the legacy page-cache invalidator for convenience so a single
// mutation handler can wipe both layers in one call.
export { legacyInvalidateCachePrefix as invalidateCachePrefix };
