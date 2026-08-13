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
import { humanizeError } from "./humanize-error";

// Per-build cache namespace. `__BUILD_ID__` is injected by Vite (see
// vite.config.ts `define`) as a unique-per-build string. Every new
// deploy ships a different namespace, so previously-cached payloads
// orphan automatically — no manual localStorage clear, no version
// bump, no stale data after a backend reset.
declare const __BUILD_ID__: string;
const NAMESPACE = `hookka-cache:${__BUILD_ID__}:`;

// One-shot cleanup: when this module loads (i.e. once per browser
// session, on the first import), sweep localStorage for any
// `hookka-cache:*` entries that don't belong to the current build and
// delete them. Keeps the per-build namespacing from accumulating dead
// entries forever (browsers will eventually GC under quota pressure,
// but explicit cleanup is friendlier).
if (typeof window !== "undefined") {
  try {
    const keysToDrop: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k) continue;
      if (k.startsWith("hookka-cache:") && !k.startsWith(NAMESPACE)) {
        keysToDrop.push(k);
      }
    }
    for (const k of keysToDrop) window.localStorage.removeItem(k);
  } catch {
    // localStorage disabled or quota error — best effort, ignore.
  }
}

type CacheEntry<T> = {
  data: T;
  fetchedAt: number;
};

function storageKey(url: string): string {
  return NAMESPACE + url;
}

/**
 * Sync read of the cached value for a URL — no network. Returns null if
 * nothing is cached. Useful for synchronous overlays (e.g. global search)
 * that need to read multiple cached lists without triggering network.
 */
export function peekCache<T>(url: string): T | null {
  return readCache<T>(url)?.data ?? null;
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

// ---------------------------------------------------------------------------
// Cross-tab + same-tab live invalidation.
//
// Why: when the operator adds a new product / fabric / variants entry in the
// Maintenance page (often in a separate tab), the SO Create + Edit pages
// previously kept showing stale dropdowns until the user hard-refreshed.
// Recurring complaint pattern (Wei Siang May 2026 — "added new fabric in
// maintenance, not visible in SO create").
//
// Architecture:
//   1. invalidateCache / invalidateCachePrefix drop the localStorage entry
//      (existing behaviour) AND fire a notification so any mounted
//      useCachedJson hook for that URL re-fetches immediately (same tab).
//   2. They also broadcast to other tabs via BroadcastChannel — receiving
//      tabs drop their localStorage copies AND notify their hooks too.
//   3. useCachedJson subscribers register in a per-URL set; on receiving a
//      bus tick they bump their `tick` state to re-run the fetch effect.
//
// Pure additive — existing callers don't change.
// ---------------------------------------------------------------------------
type InvalidationListener = () => void;
const invalidationListeners = new Map<string, Set<InvalidationListener>>();

function notifyInvalidation(url: string): void {
  const exact = invalidationListeners.get(url);
  if (exact) for (const cb of exact) try { cb(); } catch { /* ignore */ }
}

function notifyInvalidationPrefix(prefix: string): void {
  for (const [url, listeners] of invalidationListeners) {
    if (!url.startsWith(prefix)) continue;
    for (const cb of listeners) try { cb(); } catch { /* ignore */ }
  }
}

function subscribeInvalidation(url: string, listener: InvalidationListener): () => void {
  let set = invalidationListeners.get(url);
  if (!set) {
    set = new Set();
    invalidationListeners.set(url, set);
  }
  set.add(listener);
  return () => {
    const s = invalidationListeners.get(url);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) invalidationListeners.delete(url);
  };
}

// BroadcastChannel — cross-tab notification. Channel name is namespaced per
// build so two builds running side-by-side (dev + prod) don't cross-talk.
type InvalidateMessage =
  | { kind: "url"; url: string }
  | { kind: "prefix"; prefix: string };

let bcast: BroadcastChannel | null = null;
if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
  try {
    bcast = new BroadcastChannel(`hookka-cache-bus:${__BUILD_ID__}`);
    bcast.addEventListener("message", (ev) => {
      const msg = ev.data as InvalidateMessage | null;
      if (!msg || typeof msg !== "object") return;
      // Drop the localStorage entry on this tab too — sender already did it
      // on theirs. Then notify any mounted hooks on this tab to refetch.
      if (msg.kind === "url") {
        try { window.localStorage.removeItem(storageKey(msg.url)); } catch { /* ignore */ }
        notifyInvalidation(msg.url);
      } else if (msg.kind === "prefix") {
        try {
          const full = storageKey(msg.prefix);
          const toRemove: string[] = [];
          for (let i = 0; i < window.localStorage.length; i++) {
            const k = window.localStorage.key(i);
            if (k && k.startsWith(full)) toRemove.push(k);
          }
          for (const k of toRemove) window.localStorage.removeItem(k);
        } catch { /* ignore */ }
        notifyInvalidationPrefix(msg.prefix);
      }
    });
  } catch {
    // BroadcastChannel may be blocked (rare). Same-tab path still works.
    bcast = null;
  }
}

function broadcast(msg: InvalidateMessage): void {
  if (!bcast) return;
  try { bcast.postMessage(msg); } catch { /* ignore */ }
}

export function invalidateCache(url: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(url));
  } catch {
    // ignore
  }
  notifyInvalidation(url);
  broadcast({ kind: "url", url });
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
  notifyInvalidationPrefix(prefix);
  broadcast({ kind: "prefix", prefix });
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

// Transient status codes worth one automatic retry. The backend returns a
// RETRIABLE 503 ("Auth service busy — please retry") when a session-verify DB
// query momentarily fails under the request burst a page fires on load — the
// dept grid alone fetches ~12 endpoints at once and, with the DB adapter's
// max:1 socket/request, one can lose the connection race (auth-middleware.ts).
// 502/504 are the CF-edge/gateway equivalents. Without a retry the server's
// documented "keep your session and retry" never happened: the fetch surfaced
// as an error and, e.g., the dept page's "due today" query 503'd every morning
// (its dueFrom=<today> snapshot key is cold on the day's first load).
const RETRIABLE_STATUS = new Set([502, 503, 504]);
const MAX_FETCH_RETRIES = 2;

// Backoff that resolves early if the request is aborted (unmount / url change),
// so a cancelled fetch never lingers through the retry wait.
function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      resolve();
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function joinInflight<T>(url: string): Promise<T> {
  const existing = inflight.get(url);
  if (existing) {
    existing.refs++;
    return existing.promise as Promise<T>;
  }
  const controller = new AbortController();

  // Every URL routed through here is an idempotent GET (SWR reads), so an
  // automatic retry can NEVER double-apply a write — writes use raw fetch(),
  // not this path. Retry only the transient statuses above, bounded, with a
  // jittered backoff so a burst of deduped callers doesn't thunder back in
  // lockstep. Non-retriable non-2xx still throw on the first try so the caller
  // keeps its last-known-good cached data (blank-page guard, Wei Siang
  // 2026-06-04 "我的系统为什么东西空去了").
  const run = async (): Promise<T> => {
    let attempt = 0;
    for (;;) {
      const r = await fetch(url, {
        signal: controller.signal,
        // P6.1 — W3C Trace Context. trace_id is sticky for the page session
        // so the worker can stitch every fetch from this tab onto one trace.
        headers: { traceparent: buildTraceparent() },
      });
      if (!r.ok) {
        if (RETRIABLE_STATUS.has(r.status) && attempt < MAX_FETCH_RETRIES) {
          attempt++;
          await retryDelay(
            200 * attempt + Math.floor(Math.random() * 150),
            controller.signal,
          );
          if (controller.signal.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          continue;
        }
        // Treat any non-2xx as a HARD failure so the caller KEEPS its
        // last-known-good cached data instead of overwriting a populated
        // list with the parsed error body. A transient 500/503 (DB
        // connection contention under load) must never blank a page that
        // was already showing data.
        //
        // Thrown as an HttpError (not a bare Error) so the STATUS survives
        // as a number. Only the status separates "the server answered and
        // said this record is not there" (404) from "we never got an
        // answer" — and a page that cannot tell them apart prints
        // "not found" over a dead request (BUG-2026-08-13-016). The message
        // is byte-identical to the old one so humanizeError and every
        // existing caller behave exactly as before.
        throw new HttpError(r.status, url);
      }
      const j = (await r.json()) as T;
      // Catch-all stub guard (2026-04-26): the backend's /api/* fallback in
      // worker.ts returns `{success:true, data:[], _stub:true, path}` for
      // any unrouted endpoint. Without surfacing this, a typo'd or
      // unmounted route silently renders "no data" forever — exactly
      // the failure mode that masked the linkedPOs bug for months.
      // Warn loudly in dev so the next typo is caught immediately.
      if (
        j &&
        typeof j === "object" &&
        (j as { _stub?: unknown })._stub === true
      ) {
        console.warn(
          `[cached-fetch] STUB RESPONSE for ${url} — backend route is not mounted (returned the catch-all _stub envelope from worker.ts). Frontend will see empty data. Check the route is registered in src/api/worker.ts.`,
        );
      }
      return j;
    }
  };

  const promise: Promise<T> = run().finally(() => {
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

// ---------------------------------------------------------------------------
// A failed read is not an empty one — and only ONE failure means the record
// is actually absent.
//
// `api-client.ts` aborts every `/api/*` request at `API_TIMEOUT_MS` (30 s).
// The abort used to be swallowed here with no error set, so a consumer was
// left holding `data = null, loading = false, error = null` — a state
// indistinguishable from "the server answered, and there is nothing here".
// Eight detail pages printed "Order not found." / "Invoice not found." over
// requests that had simply been killed, and four sat on an eternal "Loading…"
// (BUG-2026-08-13-016, audit finding D3).
//
// The distinction is available by construction:
//   • HTTP 404 — the server ANSWERED. The record is genuinely absent.
//   • abort / network / 5xx / degraded body — we have NO answer. The record
//     may well exist. Never assert otherwise.
//
// `kind: "notFound"` is the ONLY value that licenses the words "not found".
// ---------------------------------------------------------------------------

/** A non-2xx response, carrying its status as a number rather than as prose. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
  }
}

export type FetchFailureKind =
  /** HTTP 404 — the server answered and said this record is not there. */
  | "notFound"
  /** The 30 s cap in api-client.ts stopped the request. Outcome unknown. */
  | "timeout"
  /** Never got a usable answer (offline, DNS, reset, unparsable body). */
  | "network"
  /** The server answered, but could not fulfil the request (5xx / other 4xx). */
  | "server"
  /** HTTP 200 carrying the unmounted-route `_stub` envelope or `success:false`. */
  | "degraded";

export type CachedFetchFailure = {
  kind: FetchFailureKind;
  /** HTTP status when there was a response; 0 when there was none. */
  status: number;
  /** Operator-safe sentence, already through `humanizeError`. */
  message: string;
};

/**
 * Turn anything thrown by `joinInflight` into a classified failure.
 *
 * NOTE on aborts: an AbortError only reaches a caller that did NOT cancel
 * itself. `releaseInflight` aborts a shared request only when its refcount
 * hits 0 — i.e. every subscriber has already unmounted and set its own
 * `cancelled` flag, and those return before this is ever called. So an abort
 * observed here is the 30 s timeout, not a cancellation.
 */
export function classifyFetchFailure(err: unknown): CachedFetchFailure {
  if (isAbortError(err)) {
    return {
      kind: "timeout",
      status: 0,
      message:
        "The server didn't respond within 30 seconds, so the request was stopped. Please try again.",
    };
  }
  const status = err instanceof HttpError ? err.status : 0;
  if (status === 404) {
    return { kind: "notFound", status, message: humanizeError(err) };
  }
  return {
    kind: status > 0 ? "server" : "network",
    status,
    message: humanizeError(err),
  };
}

/**
 * `true` when the read failed in a way that leaves the record's existence
 * UNKNOWN. Guard every "…not found" branch with this: the only failure that
 * proves absence is `kind: "notFound"`.
 */
export function isUnknownOutcome(
  failure: CachedFetchFailure | null | undefined,
): boolean {
  return failure != null && failure.kind !== "notFound";
}

// A 200-OK response can still be semantically degraded: the worker's
// catch-all returns `{success:true,data:[],_stub:true}` for an unmounted
// route, and handled backend errors return `{success:false,error}`.
// Writing either into state/cache replaces a populated list with
// emptiness — the same blank-page failure mode as a raw 500. Callers use
// this to keep last-known-good data instead of overwriting it.
//
// NOTE: a genuine empty dataset is `{success:true,data:[]}` (no _stub,
// success !== false) — that is NOT degraded and correctly renders empty.
function isDegradedResponse(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as { _stub?: unknown; success?: unknown };
  return o._stub === true || o.success === false;
}

type UseCachedJsonResult<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  /**
   * Set when the LAST attempt failed. `failure.kind` is what separates a
   * record the server said is absent (`"notFound"`) from a record we simply
   * could not reach — see `isUnknownOutcome`. `error` is `failure.message`
   * (kept as a plain string for existing callers).
   *
   * `null` while loading, on success, and after a silent cancellation
   * (unmount / URL change) — cancelling is not a failure.
   */
  failure: CachedFetchFailure | null;
  refresh: () => void;
};

export type UseCachedJsonOptions = {
  /**
   * Re-fetch when the window regains focus (operator switches back to this
   * tab). Use for catalog endpoints where stale data manifests as missing
   * dropdown entries. Off by default — most pages don't need it.
   */
  revalidateOnFocus?: boolean;
};

/**
 * React hook for stale-while-revalidate JSON fetching.
 *
 * - Returns cached data immediately if any is stored for `url`.
 * - Kicks off a background fetch and updates state when the response lands.
 * - Skips the background fetch if the cached entry is younger than `ttlSec`.
 * - Pass `null` as the URL to intentionally skip the fetch (useful for
 *   routes where the id isn't known yet).
 * - Auto-refetches when another tab calls invalidateCache(prefix) for this
 *   URL via the BroadcastChannel bus. Same-tab invalidations are also
 *   delivered (so Maintenance Save → SO dropdowns refresh without a
 *   navigation).
 * - With `revalidateOnFocus: true`, also refetches whenever the window
 *   regains focus.
 *
 * `loading` is true only when there is NO cached data — so SWR hits feel
 * instant to the user without a spinner flash over stale-but-usable data.
 * Call `refresh()` to force a background refetch (e.g. pull-to-refresh).
 */
export function useCachedJson<T = unknown>(
  url: string | null,
  ttlSec: number = 300,
  options: UseCachedJsonOptions = {},
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
  const [failure, setFailure] = useState<CachedFetchFailure | null>(null);
  const [tick, setTick] = useState(0);
  const lastUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!url) {
      // Reseed state when caller passes null URL (e.g. id not yet known).
      // eslint-disable-next-line react-hooks/set-state-in-effect -- url=null reset path; pre-existing pattern, separate cleanup task
      setData(null);
      setLoading(false);
      setError(null);
      setFailure(null);
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
      setFailure(null);
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
        // Blank-page guard (2026-06-04): a 200-OK but degraded response
        // (unmounted-route _stub envelope, or {success:false}) must not
        // overwrite a populated cache with emptiness. If we already hold a
        // non-degraded copy, keep showing it and surface an error instead
        // of blanking the page. Only fall through to write/show the
        // degraded body when we have nothing better to show (first load).
        if (isDegradedResponse(raw)) {
          const prior = readCache<T>(joinedUrl);
          if (prior && !isDegradedResponse(prior.data)) {
            const stale = "Showing your most recent saved data while we refresh.";
            setData(prior.data);
            setError(stale);
            // Degraded, not absent. Stated so a consumer that renders a
            // "not found" branch can never reach it off the back of a
            // route that simply isn't mounted.
            setFailure({ kind: "degraded", status: 200, message: stale });
            return;
          }
        }
        // Canonicalise Hono's `{ success, data }` envelope into `data` only
        // when we're confident that's what the caller wants. We DO NOT strip
        // the envelope here — callers decide how to interpret the response —
        // but we do cache the whole body so future reads match the server.
        writeCache<T>(joinedUrl, raw);
        setData(raw);
        setError(null);
        setFailure(null);
      })
      .catch((err) => {
        // A consumer that cancelled itself (unmount / URL change) stays
        // SILENT — that is not an error, and making it noisy would be a new
        // bug. Everything that gets past this line is a real failure the
        // consumer is still mounted to see, INCLUDING the 30 s abort from
        // api-client.ts, which used to `return` here with no error set and
        // left the page claiming the record did not exist
        // (BUG-2026-08-13-016).
        if (cancelled) return;
        const f = classifyFetchFailure(err);
        setFailure(f);
        setError(f.message);
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

  // Subscribe to cache invalidations for this URL — fires when another
  // tab (or this tab's Maintenance Save) calls invalidateCache /
  // invalidateCachePrefix that matches this URL. Bumping the tick re-runs
  // the fetch effect.
  useEffect(() => {
    if (!url) return;
    return subscribeInvalidation(url, () => setTick((t) => t + 1));
  }, [url]);

  // Optional: revalidate when window regains focus. We gate on cache age
  // (>2s) so quick alt-tab roundtrips don't fire redundant requests, but
  // anything more than a momentary blur triggers a refetch.
  const revalidateOnFocus = options.revalidateOnFocus === true;
  useEffect(() => {
    if (!url || !revalidateOnFocus) return;
    if (typeof window === "undefined") return;
    const onFocus = () => {
      const cached = readCache<T>(url);
      const age = cached ? Date.now() - cached.fetchedAt : Infinity;
      if (age > 2000) setTick((t) => t + 1);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [url, revalidateOnFocus]);

  return { data, loading, error, failure, refresh };
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
    // Same blank-page guard as useCachedJson: don't let a degraded 200
    // (unmounted-route _stub / {success:false}) replace good cached data.
    if (isDegradedResponse(raw) && cached && !isDegradedResponse(cached.data)) {
      return cached.data;
    }
    writeCache<T>(url, raw);
    return raw;
  } catch (err) {
    if (isAbortError(err)) return cached?.data ?? null;
    return cached?.data ?? null;
  }
}

// ---------------------------------------------------------------------------
// cachedFetchJsonResult — the same fetch, but the caller is TOLD when it failed.
//
// `cachedFetchJson` returns `null` on any failure (timeout, 30 s global abort,
// HTTP 500, a degraded `_stub` body). A caller that then writes `json?.data ||
// []` into state cannot tell "the server has nothing for this range" apart from
// "the request died", and every report page in this repo printed the former over
// the latter — see BUG-2026-08-13-005: Reports › Production captioned an EMPTY
// Department Efficiency table "No data available" while `/api/production-orders`
// was being killed at 30,012 ms.
//
// A report that cannot load must SAY it could not load. Use this anywhere a
// falsy/empty response is rendered as a factual statement about the business.
// ---------------------------------------------------------------------------
export type CachedFetchResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      /**
       * Why it failed. `"notFound"` is the ONLY value that means the record
       * is genuinely absent — see `isUnknownOutcome`. `error` stays the
       * report-flavoured sentence this function has always returned.
       */
      kind: FetchFailureKind;
      status: number;
      data: T | null;
    };

export async function cachedFetchJsonResult<T = unknown>(
  url: string,
): Promise<CachedFetchResult<T>> {
  const cached = readCache<T>(url);
  try {
    const raw = await joinInflight<T>(url);
    if (isDegradedResponse(raw)) {
      // A 200 that carries the unmounted-route `_stub` envelope or
      // `{success:false}` is a FAILURE, not an empty dataset. Saying so is the
      // whole point of this function — never let it render as "no data".
      const o = raw as { error?: unknown };
      return {
        ok: false,
        kind: "degraded",
        status: 200,
        // Route the backend string through the same display translator every
        // toast uses, so a constraint name or a column name can never reach an
        // operator (humanize-error.ts, owner directive 2026-06-08).
        error: humanizeError(
          typeof o.error === "string" && o.error.length > 0 ? o.error : null,
        ),
        data: cached && !isDegradedResponse(cached.data) ? cached.data : null,
      };
    }
    writeCache<T>(url, raw);
    return { ok: true, data: raw };
  } catch (err) {
    const f = classifyFetchFailure(err);
    return {
      ok: false,
      kind: f.kind,
      status: f.status,
      // The 30 s global abort in api-client.ts surfaces as an AbortError whose
      // message ("Aborted" / "signal is aborted without reason") reads clean
      // enough that humanizeError would hand it straight to the operator. Name
      // it for what it is instead — this is the exact failure that used to be
      // rendered as "No data available". Report-flavoured on purpose: this
      // function's callers are report tabs over a date range.
      error:
        f.kind === "timeout"
          ? "This report took too long to load. Narrow the date range and try again."
          : humanizeError(err, "Couldn't load this report. Please try again."),
      data: cached?.data ?? null,
    };
  }
}
