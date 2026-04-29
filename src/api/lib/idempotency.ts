// ---------------------------------------------------------------------------
// idempotency.ts — Sprint 3 #4 idempotency wrapper for money POST routes.
//
// Money-mutating endpoints (sales-orders, invoices, payments) must be
// safe to retry. A network blip during the round-trip leaves the client
// uncertain whether the server saw the request — a retry could create a
// duplicate sales order, double-collect a payment, or fan out two
// invoice records for the same delivery.
//
// Spec:
//   * Client sends `Idempotency-Key: <uuid>` header on the POST.
//   * Server hashes (resource, key) into a KV cache key.
//   * First request runs the handler, stores the response (status + JSON
//     body) in KV with a 24h TTL, returns the response.
//   * Subsequent requests with the same (resource, key) read from KV and
//     return the cached response — bit-for-bit identical to the first.
//
// Key collision: while a request is in-flight, a duplicate retry races
// against the cache write. We mark the slot with a sentinel
// (`{state: 'pending', startedAt}`) on entry, so a concurrent retry
// returns a 409 Conflict with a Retry-After hint instead of executing
// the handler twice. The pending sentinel is overwritten with the final
// response when the handler completes.
//
// What if the handler throws?
//   * The pending sentinel is DELETED so a future retry can run cleanly.
//   * We deliberately do NOT cache 5xx responses — the client should be
//     able to retry a transient failure and get a different outcome.
//   * 4xx responses ARE cached so the client gets the same validation
//     error on retry (matches Stripe / IETF idempotency-key draft).
//
// What if the client sends NO header?
//   * No-op. The handler runs as before. Idempotency is opt-in.
//
// Storage budget per cached response: ~5KB for typical money-API JSON.
// At 1k POSTs/day with a 24h TTL, that's 5MB resident — well within
// the SESSION_CACHE budget.
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";

const TTL_SECONDS = 60 * 60 * 24; // 24h
const PENDING_TTL_SECONDS = 60 * 5; // 5min — enough for a slow handler
const MAX_KEY_LENGTH = 200;

type CachedResponse = {
  state: "complete";
  status: number;
  body: unknown;
  storedAt: string;
};

type PendingMarker = {
  state: "pending";
  startedAt: string;
};

type CacheEntry = CachedResponse | PendingMarker;

/**
 * Read the `Idempotency-Key` header. Returns null if absent / empty /
 * suspiciously long. Trimmed of whitespace.
 */
export function readIdempotencyKey(c: Context<Env>): string | null {
  const raw = c.req.header("idempotency-key") ?? c.req.header("Idempotency-Key");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_KEY_LENGTH) return null;
  return trimmed;
}

function cacheKey(resource: string, key: string): string {
  return `idem:${resource}:${key}`;
}

/**
 * Wrap a POST handler with idempotency. Pass the resource name (e.g.
 * "sales-orders") and the per-request key (from `readIdempotencyKey`).
 *
 * - If the client did not send a key, runs `handler` directly.
 * - If a complete cache hit exists, returns the cached response.
 * - If a pending marker exists, returns 409 Conflict.
 * - Otherwise, marks the slot pending, runs the handler, caches the
 *   final response (or clears the marker on throw / 5xx).
 *
 * The handler must return a Hono `Response` object. We capture status +
 * JSON body and reconstruct an equivalent response on cache replay.
 */
export async function withIdempotency(
  c: Context<Env>,
  resource: string,
  key: string | null,
  handler: () => Promise<Response>,
): Promise<Response> {
  if (!key) return handler();

  const kv = c.env.SESSION_CACHE;
  if (!kv) {
    // KV namespace not bound (e.g. in some test envs). Idempotency
    // becomes a no-op — better to serve the request than to 500.
    return handler();
  }

  const k = cacheKey(resource, key);

  // 1. Check for an existing entry.
  let existing: CacheEntry | null = null;
  try {
    existing = await kv.get<CacheEntry>(k, { type: "json" });
  } catch {
    /* KV read failure is non-fatal — fall through and run the handler */
  }

  if (existing?.state === "complete") {
    // Cache hit: replay the original response.
    return new Response(JSON.stringify(existing.body), {
      status: existing.status,
      headers: {
        "content-type": "application/json",
        "idempotency-replay": "true",
      },
    });
  }

  if (existing?.state === "pending") {
    // Concurrent retry while the original request is still running.
    return new Response(
      JSON.stringify({
        success: false,
        error:
          "A request with this Idempotency-Key is already in flight. Retry once it completes.",
      }),
      {
        status: 409,
        headers: {
          "content-type": "application/json",
          "retry-after": "5",
        },
      },
    );
  }

  // 2. Mark pending so concurrent retries 409 instead of double-running.
  const pending: PendingMarker = {
    state: "pending",
    startedAt: new Date().toISOString(),
  };
  try {
    await kv.put(k, JSON.stringify(pending), {
      expirationTtl: PENDING_TTL_SECONDS,
    });
  } catch {
    /* KV write failure: still try to run the handler */
  }

  // 3. Execute the handler.
  let res: Response;
  try {
    res = await handler();
  } catch (e) {
    // Clear the pending marker so a retry can succeed cleanly.
    try {
      await kv.delete(k);
    } catch {
      /* swallow */
    }
    throw e;
  }

  // 4. Cache the response (only 2xx and 4xx — never 5xx).
  if (res.status >= 500) {
    try {
      await kv.delete(k);
    } catch {
      /* swallow */
    }
    return res;
  }

  // We need to read the body so we can both cache it and return it. Clone
  // before reading so the original response stream is intact for the SPA.
  let body: unknown = null;
  try {
    body = await res.clone().json();
  } catch {
    // Non-JSON response — skip caching but still return the response.
    try {
      await kv.delete(k);
    } catch {
      /* swallow */
    }
    return res;
  }

  const complete: CachedResponse = {
    state: "complete",
    status: res.status,
    body,
    storedAt: new Date().toISOString(),
  };
  try {
    await kv.put(k, JSON.stringify(complete), {
      expirationTtl: TTL_SECONDS,
    });
  } catch {
    /* swallow — better to return the live response than to 500 */
  }
  return res;
}
