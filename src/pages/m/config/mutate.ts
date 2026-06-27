// ===========================================================================
// Mutation helper for the mobile create/edit forms (Phase 4).
//
// Thin wrapper over the global patched window.fetch (CSRF + cookies are
// injected automatically by src/lib/api-client.ts — NO csrfHeaders() needed),
// plus the shared SWR cache invalidation so a saved record shows up in its
// list + detail immediately.
//
// ADDITIVE: imported only by files under src/pages/m/. No backend, no desktop.
// ===========================================================================
import { invalidateCache, invalidateCachePrefix } from "@/lib/cached-fetch";

export type MutateResult<T = unknown> = {
  ok: boolean;
  status: number;
  /** Parsed JSON body (best effort). */
  body: T | null;
  /** A human error string when !ok (from the body's `error` field or HTTP). */
  error?: string;
};

/**
 * POST/PUT/PATCH JSON to an existing API endpoint. Returns a normalised
 * result; never throws on a non-2xx (the caller renders the error inline).
 * CSRF + credentials are injected by the global fetch patch.
 */
export async function mutateJson<T = unknown>(
  url: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<MutateResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(extraHeaders ?? {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    const p = (parsed ?? {}) as {
      success?: boolean;
      ok?: boolean;
      error?: string;
    };
    // Treat the repo's `{ success: false }` envelope as a failure even on a
    // 200, and Mail Center's `{ ok: false }` likewise.
    const envelopeOk = p.success !== false && p.ok !== false;
    const ok = res.ok && envelopeOk;
    return {
      ok,
      status: res.status,
      body: (parsed as T) ?? null,
      error: ok
        ? undefined
        : p.error || `Request failed (HTTP ${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}

/** Drop the SWR cache for a list endpoint (prefix) so the next read refetches. */
export function refreshList(...prefixes: string[]): void {
  for (const p of prefixes) invalidateCachePrefix(p);
}

/** Drop the SWR cache for a single exact URL (e.g. a doc detail GET). */
export function refreshOne(url: string): void {
  invalidateCache(url);
}

/** Pull the new record id out of a `{ data: { id } }` create response. */
export function newIdOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (data && typeof data === "object") {
    const id = (data as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  // Mail Center compose returns { threadId } at the top level.
  const threadId = (body as { threadId?: unknown }).threadId;
  if (typeof threadId === "string" && threadId) return threadId;
  return null;
}
