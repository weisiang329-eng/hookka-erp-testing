// ---------------------------------------------------------------------------
// usePermissions — frontend permission set lookup (P3.6).
//
// The backend (src/api/lib/rbac.ts) gates every API route on
// (resource, action). Without a matching client-side check users navigate to
// /accounting, see the page shell render, then watch the data fetches all 403.
// This hook fetches GET /api/auth/me/permissions once per session and exposes
// a `hasPermission(resource, action)` predicate so route guards
// (<RequirePermission>) and nav links can decide what to show.
//
// Shape returned by the endpoint:
//   { success: true, role: "FINANCE", permissions: ["invoices:read", ...] }
// SUPER_ADMIN gets the sentinel ["*"]; we expand that to "allow everything"
// here so callers don't have to special-case it.
//
// Caching strategy: piggyback on useCachedJson so the permission set is
// stale-while-revalidate cached in localStorage with a 5 minute TTL — same
// window as the rbac.ts KV cache, so client and server stay in sync within
// a 5-minute drift after a role-permission edit.
//
// Failure mode: on any error (network, schema mismatch) we return an empty
// PermissionMap. Components default to "no access" rather than crashing —
// the user lands on /dashboard via the redirect path in <RequirePermission>
// instead of staring at a blank page.
// ---------------------------------------------------------------------------
import { useEffect } from "react";
import { useCachedJson, cachedFetchJson } from "./cached-fetch";

export type PermissionMap = ReadonlySet<string>;

type PermissionsResponse = {
  success?: boolean;
  role?: string;
  permissions?: string[];
  /**
   * Path prefixes this user may not see, computed SERVER-side.
   *
   * Owner 2026-08-05: "我不要用 frontend loading 等等的，直接从 backend 就挡掉嘛."
   * The browser hides a link without knowing which resource guards it, so the
   * mapping cannot drift from the gate that enforces it.
   */
  navHidden?: string[];
  /** Where this user should land — see homeForPermissions on the API. */
  home?: string;
};

const PERMISSIONS_URL = "/api/auth/me/permissions";
/**
 * Short on purpose.
 *
 * Owner 2026-08-05: "你说一定要清缓存的原因是什么？我们不是直接在 backend 那边就
 * 直接看不到了吗？" Correct — the API refuses regardless, so a stale menu never
 * grants access, only shows a link that 403s. But five minutes of that after a
 * role change reads as "the change did not work", which is exactly how it read.
 *
 * Thirty seconds keeps the request off the hot path without making a role
 * change feel broken. Sign-in wipes the whole `hookka-cache:` namespace
 * (see wipeApiCache in src/lib/auth.ts), so a fresh session is never stale
 * at all — this window only covers a role change made mid-session.
 */
const PERMISSIONS_TTL_S = 30;
const SUPER_ADMIN_SENTINEL = "*";

// Module-scoped memo so non-React callers (e.g. event handlers) can read the
// last-known set synchronously after the first fetch lands. Updated by both
// usePermissions() effect and fetchPermissions() — last writer wins.
let lastKnown: PermissionMap = new Set<string>();

function buildSet(perms: string[] | undefined): PermissionMap {
  if (!perms || perms.length === 0) return new Set<string>();
  return new Set<string>(perms);
}

function checkSet(
  set: PermissionMap,
  resource: string,
  action: string,
): boolean {
  // SUPER_ADMIN sentinel: a single "*" entry means allow everything.
  if (set.has(SUPER_ADMIN_SENTINEL)) return true;
  // Match exactly how `permitted()` in src/api/lib/rbac.ts matches. The code
  // RBAC policy grants a whole module as `invoices:*`, so an exact-tuple check
  // answered NO to every department role while the API said yes — and every
  // <RequirePermission> route bounced to /dashboard. Owner 2026-08-05: "为什么
  // 我点 Invoice 的 module，它是跑出来 dashboard？"
  //
  // These two predicates must not drift again: tests/permission-wildcards.test.mjs
  // asserts they agree on the same inputs.
  return (
    set.has(`${resource}:${action}`) ||
    set.has(`${resource}:*`) ||
    set.has(`*:${action}`) ||
    set.has(`*:*`)
  );
}

type UsePermissionsResult = {
  permissions: PermissionMap;
  loading: boolean;
  hasPermission: (resource: string, action: string) => boolean;
  /** Server-decided: may this menu link be shown? */
  isNavAllowed: (href: string) => boolean;
  /** Server-decided landing page for this role. See homeForPermissions on the API. */
  home: string;
};

/**
 * React hook — fetches + caches the current user's permission set.
 *
 *   const { hasPermission, loading } = usePermissions();
 *   if (loading) return <Spinner />;
 *   if (!hasPermission("invoices", "post")) return null;
 *
 * `loading` is only true when there is no cached set yet (first visit).
 * Subsequent calls render synchronously from the localStorage cache so the
 * UI doesn't flicker on every navigation.
 */
export function usePermissions(): UsePermissionsResult {
  const { data, loading } = useCachedJson<PermissionsResponse>(
    PERMISSIONS_URL,
    PERMISSIONS_TTL_S,
  );

  const permissions = buildSet(data?.permissions);
  // Keep the module-scoped memo fresh so fetchPermissions() readers reflect
  // the latest set without an extra network round-trip. Done in an effect
  // (not during render) — react-hooks/globals doesn't allow reassigning a
  // module-scoped variable mid-render because it's a side effect.
  useEffect(() => {
    if (data?.permissions) lastKnown = permissions;
    // permissions is freshly derived each render but its membership is what
    // we care about — depending on `data` keeps the effect in sync without
    // adding a Set identity dep that would re-fire on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const navHidden = data?.navHidden ?? [];
  // Settings is granted to every role, so this fallback is never a dead end.
  const home = data?.home ?? "/settings";

  return {
    permissions,
    loading: loading && !data,
    home,
    hasPermission: (resource: string, action: string) =>
      checkSet(permissions, resource, action),
    /**
     * Should this menu link be shown?
     *
     * The decision was made on the server; this only matches the path against
     * the prefixes it was handed. `/delivery-returns` is NOT hidden by a
     * `/delivery` prefix — a prefix matches the path exactly or as a path
     * SEGMENT, never as a bare string prefix.
     *
     * Unknown while the set is still loading means SHOW. A menu that blinks
     * empty on every page load reads as broken, and the API refuses anything
     * the user should not reach anyway.
     */
    isNavAllowed: (href: string) => {
      if (!navHidden.length) return true;
      const path = (href || "").split("?")[0];
      return !navHidden.some((p) => path === p || path.startsWith(`${p}/`));
    },
  };
}

/**
 * Standalone helper — for code that runs outside React (e.g. event handlers
 * doing imperative checks before opening a confirm dialog). Returns the
 * permission set; callers can `.has("resource:action")` directly or use
 * the exported {@link hasPermissionIn} convenience.
 *
 * Uses cachedFetchJson under the hood so it shares the SWR cache with the
 * hook — calling this immediately after the hook's first render is free.
 */
export async function fetchPermissions(): Promise<PermissionMap> {
  try {
    const raw = await cachedFetchJson<PermissionsResponse>(
      PERMISSIONS_URL,
      PERMISSIONS_TTL_S,
    );
    const set = buildSet(raw?.permissions);
    lastKnown = set;
    return set;
  } catch {
    // Network or shape error — return the last-known set (or empty). Failing
    // open here is unsafe, so we fail closed; real auth is enforced server-side.
    return lastKnown;
  }
}

/**
 * Synchronous predicate over a known PermissionMap. Useful inside event
 * handlers that already awaited fetchPermissions() once.
 */
export function hasPermissionIn(
  set: PermissionMap,
  resource: string,
  action: string,
): boolean {
  return checkSet(set, resource, action);
}
