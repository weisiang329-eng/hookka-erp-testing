// ---------------------------------------------------------------------------
// Internal request helpers used by every resource module.
//
// Every SDK call ultimately funnels through here so:
//   - HTTP / network / Zod-validation failures become a single ApiError.
//   - GETs participate in the SWR cache + inflight de-dup (see ./cache.ts).
//   - Mutations (POST/PUT/PATCH/DELETE) are NEVER cached and ALWAYS bypass
//     cache lookups; resource modules call `invalidatePrefix` after them.
//   - AbortSignals pass through to fetchJson uniformly.
// ---------------------------------------------------------------------------
import type { z } from "zod";
import { fetchJson, FetchJsonError } from "../fetch-json";
import { cachedFetch, invalidatePrefix } from "./cache";
import { ApiError } from "./errors";

export type ListParams = Record<string, string | number | boolean | undefined | null>;

export type ApiClientOptions = {
  /** Cancel in-flight request. */
  signal?: AbortSignal;
  /**
   * `force-cache` — return cached if fresh; otherwise fetch.
   * `no-cache` — bypass cache entirely (still updates cache after success).
   * Default: respect domain TTL.
   */
  cache?: "force-cache" | "no-cache";
  /** Override the per-domain default TTL (seconds). */
  ttlSec?: number;
};

/** Default TTLs by domain group. Keep small — ERP data changes constantly. */
export const DEFAULT_TTL_SEC = {
  // Reference data — rarely changes during a session.
  reference: 60,
  // Master records — change occasionally; 15s SWR feels instant.
  master: 15,
  // Transactional — change frequently; 5s.
  transactional: 5,
  // Reports / aggregates — expensive but stable per minute.
  report: 30,
} as const;

export type TtlBucket = keyof typeof DEFAULT_TTL_SEC;

/**
 * Build a URL with query-string params. `null` / `undefined` values are
 * dropped. Keys are sorted for stable cache keys.
 */
export function buildUrl(path: string, params?: ListParams): string {
  if (!params) return path;
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return path;
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  return `${path}?${qs}`;
}

function toApiError(err: unknown, fallbackUrl: string): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof FetchJsonError) {
    let code: ApiError["code"] = "UNKNOWN";
    if (err.status === 0) code = "NETWORK";
    else if (err.status === 401) code = "UNAUTHORIZED";
    else if (err.status === 403) code = "FORBIDDEN";
    else if (err.status === 404) code = "NOT_FOUND";
    else if (err.status === 409) code = "CONFLICT";
    else if (err.status === 422 || err.zodIssues) code = "VALIDATION";
    else if (err.status >= 500) code = "SERVER";
    else if (err.status >= 400) code = "CLIENT";
    return new ApiError(err.message, {
      status: err.status,
      code,
      url: err.url,
      details: err.body,
      zodIssues: err.zodIssues,
      cause: err,
    });
  }
  if (err instanceof DOMException && err.name === "AbortError") {
    return new ApiError("Request aborted", {
      status: 0,
      code: "ABORTED",
      url: fallbackUrl,
      cause: err,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ApiError(message, {
    status: 0,
    code: "UNKNOWN",
    url: fallbackUrl,
    cause: err instanceof Error ? err : undefined,
  });
}

/**
 * GET that runs the response through `schema` and participates in the SWR
 * cache. The cache key is the URL — including the sorted query string.
 */
export async function getJson<TSchema extends z.ZodTypeAny>(
  url: string,
  schema: TSchema,
  bucket: TtlBucket,
  options: ApiClientOptions = {},
): Promise<z.infer<TSchema>> {
  const ttlSec =
    options.cache === "no-cache"
      ? 0
      : (options.ttlSec ?? DEFAULT_TTL_SEC[bucket]);
  const force = options.cache === "no-cache";

  try {
    return await cachedFetch<z.infer<TSchema>>(
      url,
      (signal) => fetchJson(url, schema, { method: "GET", signal }),
      { ttlSec, force, signal: options.signal },
    );
  } catch (err) {
    throw toApiError(err, url);
  }
}

/**
 * Mutation helper — POST/PUT/PATCH/DELETE. Never reads cache; on success the
 * caller is expected to call `invalidatePrefix` for the affected domain(s).
 */
export async function mutateJson<TSchema extends z.ZodTypeAny>(
  url: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  schema: TSchema,
  body: unknown,
  options: ApiClientOptions & { invalidate?: string | string[] } = {},
): Promise<z.infer<TSchema>> {
  try {
    const result = await fetchJson(url, schema, {
      method,
      body,
      signal: options.signal,
    });
    if (options.invalidate) {
      const prefixes = Array.isArray(options.invalidate)
        ? options.invalidate
        : [options.invalidate];
      for (const p of prefixes) invalidatePrefix(p);
    }
    return result;
  } catch (err) {
    throw toApiError(err, url);
  }
}
