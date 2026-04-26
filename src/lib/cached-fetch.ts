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
import { buildTraceparent } from "./trace";

// Bumped v1 → v2 (Wei Siang Apr 26 2026): old TTL-gated cache had a
// 5-minute window where stale data hid backend resets. Bumping the
// namespace orphans every old entry on first bundle load, forcing a
// fresh API hit — no manual localStorage clear needed.
const NAMESPACE = "hookka-cache:v2:";

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

// ---------------------------------------------------------------------------
// In-flight request dedup + abort.
//
// Two pages calling the same URL on the same render should NOT each fire a
// network request — they share one Promise. And when a component unmounts
// (or its URL changes) before the response lands, the old fetch should be
// cancelled, not just have its setState skipped. Without this, rapid
// route switching (e.g. /production/fab-cut → /production/fab-sew →
// /production/foam) piles slow PO queries on D1 and trips 503 throttling.
//
// Refcount semantics:
//   - First subscriber to a URL creates the entry + AbortController.
//   - Subsequent subscribers join the same Promise (refs++).
//   - Each unsubscribe decrements refs.
//   - When refs reaches 0 BEFORE the fetch resolves, we abort.
//   - Once the fetch resolves (or rejects) the entry is dropped from the
//     map regardless of refs — refcounting only governs cancellation.
// ---------------------------------------------------------------------------
type InflightEntry = {
  promise: Promise<unknown>;
  controller: AbortController;
  refs: number;
};
const inflight = new Map<string, InflightEntry>();

function joinInflight<T>(url: string): Promise<T> {
  const existing = inflight.get(url);
  if (existing) {
    existing.refs++;
    return existing.promise as Promise<T>;
  }
  const controller = new AbortController();
  const promise: Promise<T> = fetch(url, {
    signal: controller.signal,
    // P6.1 — W3C Trace Context. trace_id is sticky for the page session
    // so the worker can stitch every fetch from this tab onto one trace.
    headers: { traceparent: buildTraceparent() },
  })
    .then((r) => r.json())
    .finally(() => {
      // Drop the entry once settled — refs no longer matter after resolution.
      // Late releaseInflight() calls become no-ops.
      inflight.delete(url);
    }) as Promise<T>;
  inflight.set(url, { promise, controller, refs: 1 });
  return promise;
}

function releaseInflight(url: string): void {
  const entry = inflight.get(url);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    entry.controller.abort();
    inflight.delete(url);
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError";
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
      // Reseed state when caller passes null URL (e.g. id not yet known).
      // eslint-disable-next-line react-hooks/set-state-in-effect -- url=null reset path; pre-existing pattern, separate cleanup task
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

    // Stale-while-revalidate: ALWAYS fire a network refetch on mount /
    // url-change. The TTL check used to skip the refetch when the cache
    // was <ttlSec old, but that left users staring at stale empty
    // responses for up to 5 minutes whenever a backend deploy fixed a
    // 'returns empty list' bug AFTER the page had cached the empty
    // response. Recurring complaint pattern (Wei Siang Apr 2026: 'Sales
    // Orders 显示 0 但 stats 314').
    //
    // The cache is still used for instant first paint (state was seeded
    // from readCache() above) — we just no longer trust it as the final
    // word. Network roundtrip is < 1s typically; the refetch replaces
    // the cached data the moment it returns, so users never linger on
    // stale data again. ttlSec is now informational; kept for API
    // compatibility but no longer gates the refetch.
    void ttlSec;

    let cancelled = false;
    const t0 = performance.now();
    const joinedUrl = url;
    joinInflight<T>(joinedUrl)
      .then((raw) => {
        if (cancelled) return;
        // Client-side timing — anything over 500ms gets a warn so slow
        // endpoints surface in devtools without adding a dashboard.
        const dur = Math.round(performance.now() - t0);
        if (dur >= 500) {

          console.warn(`[slow-fetch] url=${joinedUrl} dur_ms=${dur}`);
        }
        // Canonicalise Hono's `{ success, data }` envelope into `data` only
        // when we're confident that's what the caller wants. We DO NOT strip
        // the envelope here — callers decide how to interpret the response —
        // but we do cache the whole body so future reads match the server.
        writeCache<T>(joinedUrl, raw);
        setData(raw);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        // AbortError is the expected outcome of releaseInflight() racing
        // a slow request; not a user-visible failure.
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      releaseInflight(joinedUrl);
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
  // Always-fetch policy (matches useCachedJson SWR pattern, d8f71d2):
  // the cache is read only as a network-failure fallback. Without this,
  // a 5-min TTL kept Inventory pages on stale data after backend resets
  // (Wei Siang Apr 26 2026: cleared all completion dates in D1, frontend
  // still showed populated WIP for up to 5 min).
  void ttlSec;
  const cached = readCache<T>(url);
  try {
    const raw = await joinInflight<T>(url);
    writeCache<T>(url, raw);
    return raw;
  } catch (err) {
    if (isAbortError(err)) return cached?.data ?? null;
    return cached?.data ?? null;
  }
}
