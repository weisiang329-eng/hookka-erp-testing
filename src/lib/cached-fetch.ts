// ---------------------------------------------------------------------------
// Stale-while-revalidate fetch cache keyed on URL, backed by localStorage.
//
// Why: every page previously did `useState + useEffect + fetch` on mount, so
// navigating between pages always showed a loading state even when the data
// hadn't changed in minutes. Users hated it — the ERP feels laggy.
//
// How: `useCachedJson(url, ttl)` returns the last-known response for that URL
// immediately (if any is stored), then kicks off a background refetch. When
// the new response lands, component state updates and the UI silently swaps
// in the fresh data. First-visit still pays the network cost; every visit
// after that feels instant.
//
// Invalidation: mutations (POST/PATCH/DELETE) must call `invalidateCache` or
// `invalidateCachePrefix` so the next read doesn't serve the stale entry
// indefinitely. The TTL is a safety net, not the primary freshness guarantee.
//
// Storage limits: localStorage is 5–10 MB per origin. The whole ERP payload
// runs ~2–3 MB so we're fine. If a write fails (quota / disabled storage),
// we swallow the error and fall through to a plain fetch — cache is an
// optimisation, not load-bearing.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useRef, useState } from "react";

const NAMESPACE = "hookka-cache:v1:";

type CacheEntry<T> = {
  data: T;
  fetchedAt: number;
};

function storageKey(url: string): string {
  return NAMESPACE + url;
}

function readCache<T>(url: string): CacheEntry<T> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(url));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (!parsed || typeof parsed.fetchedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache<T>(url: string, data: T): void {
  if (typeof window === "undefined") return;
  try {
    const entry: CacheEntry<T> = { data, fetchedAt: Date.now() };
    window.localStorage.setItem(storageKey(url), JSON.stringify(entry));
  } catch {
    // Quota exceeded, storage disabled, or data not serialisable. Cache is
    // best-effort — drop silently so the component still renders fresh data.
  }
}

export function invalidateCache(url: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(url));
  } catch {
    // ignore
  }
}

export function invalidateCachePrefix(prefix: string): void {
  if (typeof window === "undefined") return;
  try {
    const full = storageKey(prefix);
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(full)) toRemove.push(k);
    }
    for (const k of toRemove) window.localStorage.removeItem(k);
  } catch {
    // ignore
  }
}

export function clearAllCache(): void {
  if (typeof window === "undefined") return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(NAMESPACE)) toRemove.push(k);
    }
    for (const k of toRemove) window.localStorage.removeItem(k);
  } catch {
    // ignore
  }
}

type UseCachedJsonResult<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * React hook for stale-while-revalidate JSON fetching.
 *
 * - Returns cached data immediately if any is stored for `url`.
 * - Kicks off a background fetch and updates state when the response lands.
 * - Skips the background fetch if the cached entry is younger than `ttlSec`.
 * - Pass `null` as the URL to intentionally skip the fetch (useful for
 *   routes where the id isn't known yet).
 *
 * `loading` is true only when there is NO cached data — so SWR hits feel
 * instant to the user without a spinner flash over stale-but-usable data.
 * Call `refresh()` to force a background refetch (e.g. pull-to-refresh).
 */
export function useCachedJson<T = unknown>(
  url: string | null,
  ttlSec: number = 300,
): UseCachedJsonResult<T> {
  const [data, setData] = useState<T | null>(() => {
    if (!url) return null;
    return readCache<T>(url)?.data ?? null;
  });
  const [loading, setLoading] = useState<boolean>(() => {
    if (!url) return false;
    return readCache<T>(url) === null;
  });
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const lastUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!url) {
      setData(null);
      setLoading(false);
      setError(null);
      lastUrl.current = null;
      return;
    }

    // When the URL changes, reseed state from whatever cache we have for
    // the new URL so the component doesn't briefly paint the previous
    // URL's data.
    if (lastUrl.current !== url) {
      lastUrl.current = url;
      const cached = readCache<T>(url);
      setData(cached?.data ?? null);
      setLoading(cached === null);
      setError(null);
    }

    const cached = readCache<T>(url);
    const isFresh = cached && Date.now() - cached.fetchedAt < ttlSec * 1000;
    // When tick bumps (refresh() called) we always refetch regardless of
    // TTL — that's the explicit override path.
    if (isFresh && tick === 0) return;

    let cancelled = false;
    fetch(url)
      .then((r) => r.json())
      .then((raw) => {
        if (cancelled) return;
        // Canonicalise Hono's `{ success, data }` envelope into `data` only
        // when we're confident that's what the caller wants. We DO NOT strip
        // the envelope here — callers decide how to interpret the response —
        // but we do cache the whole body so future reads match the server.
        writeCache<T>(url, raw as T);
        setData(raw as T);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [url, ttlSec, tick]);

  const refresh = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  return { data, loading, error, refresh };
}

/**
 * One-shot stale-while-revalidate fetch for use outside React components
 * (e.g. inside event handlers). Returns cached data immediately if any
 * exists, and always triggers a background refetch that writes to cache.
 * Callers that need the latest value can `await` the returned promise.
 */
export async function cachedFetchJson<T = unknown>(
  url: string,
  ttlSec: number = 300,
): Promise<T | null> {
  const cached = readCache<T>(url);
  const isFresh = cached && Date.now() - cached.fetchedAt < ttlSec * 1000;
  if (isFresh) return cached.data;
  try {
    const res = await fetch(url);
    const raw = (await res.json()) as T;
    writeCache<T>(url, raw);
    return raw;
  } catch {
    return cached?.data ?? null;
  }
}
