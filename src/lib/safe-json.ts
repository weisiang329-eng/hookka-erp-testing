// ---------------------------------------------------------------------------
// safe-json — normalise arbitrary API response bodies into the shape a
// caller expects. The app fetches three envelope styles:
//
//   { success, data: [...] }   D1 routes
//   [...]                      mock routes returning arrays directly
//   { success, data: [], _stub: true }   Phase 5 catch-all stub for GET
//
// Passing any of those through `asArray()` always yields an array (possibly
// empty); passing them through `asObject()` returns the first real object it
// finds or the supplied fallback. Pages using these helpers are guaranteed
// not to crash on `.filter` / `.map` / `.forEach` / property access.
// ---------------------------------------------------------------------------

/** Accepts any JSON body and returns its array payload, or []. */
export function asArray<T = unknown>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object") {
    const d = (body as { data?: unknown }).data;
    if (Array.isArray(d)) return d as T[];
  }
  return [];
}

/** Accepts any JSON body and returns its object payload, or the fallback. */
export function asObject<T extends Record<string, unknown>>(
  body: unknown,
  fallback: T,
): T {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const d = (body as { data?: unknown }).data;
    if (d && typeof d === "object" && !Array.isArray(d)) {
      return { ...fallback, ...(d as Record<string, unknown>) } as T;
    }
    // Some legacy routes return the object directly (no `data` envelope).
    // Respect that only if it doesn't look like an error envelope.
    const looksLikeError =
      "error" in (body as object) && !("data" in (body as object));
    if (!looksLikeError) {
      return { ...fallback, ...(body as Record<string, unknown>) } as T;
    }
  }
  return fallback;
}
