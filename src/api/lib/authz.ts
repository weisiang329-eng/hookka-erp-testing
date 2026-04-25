// ---------------------------------------------------------------------------
// authz.ts — Phase 3 RBAC middleware (P3.3, schema-only).
//
// Provides the (resource, action) permission gate that replaces the ad-hoc
// `if (role !== "SUPER_ADMIN")` checks scattered across the API routes. The
// (role, resource, action) matrix lives in the roles / permissions /
// role_permissions tables created by migration 0045_rbac.sql.
//
// Wiring (this file is schema only — no routes adopt it yet):
//   import { requirePermission, hasPermission } from "../lib/authz";
//   app.get("/api/sales-orders", requirePermission("sales-orders", "read"), handler);
//   if (!(await hasPermission(c, "invoices", "post"))) return c.json(..., 403);
//
// Cache layer:
//   * KV-backed (SESSION_CACHE namespace, optional AUTHZ_KV alias) — same
//     namespace and TTL pattern as auth-middleware's session cache.
//   * Key: authz:role:{roleId} -> JSON array of "resource:action" strings.
//   * TTL: 5 minutes (mirrors SESSION_CACHE_TTL_S = 300 in auth-middleware).
//     Trade-off: a SUPER_ADMIN edit to role_permissions takes up to 5 min to
//     propagate to in-flight workers. Same window as session/role revocation.
//     Call invalidateRolePermissions() from any role-permission mutation
//     handler (P3.3-followup batch) to short-circuit the wait.
//
// SUPER_ADMIN bypass:
//   The role name "SUPER_ADMIN" is hard-coded as a full-access bypass.
//   Reasoning: even if the role_permissions seed is corrupted or a future
//   migration accidentally drops rows, the system administrator must keep
//   the ability to recover. This is independent of the matrix correctness.
//
// READ_ONLY fallback:
//   Users without a roleId fall through to the role_read_only behavior
//   (every read action allowed, no mutations). Mirrors the backfill default
//   in 0045_rbac.sql which assigns role_read_only to any user without an
//   explicit mapping.
//
// Convention:
//   This module stashes the resolved permission set on the Hono context
//   under c.set("userPermissions", set) and reads it via c.get("userPermissions").
//   We do not extend the Env.Variables typing in worker.ts to keep this
//   batch single-file — local casts are used instead (see typed wrappers
//   ctxGetPerm / ctxSetPerm below).
// ---------------------------------------------------------------------------
import type { Context, Next } from "hono";

// ---- Types -----------------------------------------------------------------

/** Permission set for a single role: keys are "resource:action" strings. */
export type PermissionSet = Set<string>;

/** Minimal context-bag shape this module actually reads off c. */
type AuthzCtx = {
  var: {
    DB: D1Database;
    userId?: string;
    userRole?: string;
  };
  env: {
    SESSION_CACHE?: KVNamespace;
    AUTHZ_KV?: KVNamespace;
  };
  executionCtx?: {
    waitUntil(p: Promise<unknown>): void;
  };
  set(key: string, value: unknown): void;
  get<T = unknown>(key: string): T | undefined;
  json(body: unknown, status: number): Response;
};

// ---- Constants -------------------------------------------------------------

const AUTHZ_CACHE_TTL_S = 300; // 5 min — mirrors SESSION_CACHE_TTL_S
const SUPER_ADMIN_ROLE_NAME = "SUPER_ADMIN";
const READ_ONLY_ROLE_ID = "role_read_only";
const CACHE_KEY_PREFIX = "authz:role:";

// Module-scoped flag so the "no KV available" warning fires at most once
// per worker isolate — otherwise we'd spam the logs in dev/test runs.
let kvWarnedOnce = false;

// ---- Internal helpers ------------------------------------------------------

function ctxAsAuthz(c: Context): AuthzCtx {
  return c as unknown as AuthzCtx;
}

function getKv(c: AuthzCtx): KVNamespace | undefined {
  // Prefer the dedicated AUTHZ_KV binding if wired; fall back to SESSION_CACHE
  // (the existing auth-middleware namespace — "same KV namespace" per spec).
  return c.env.AUTHZ_KV ?? c.env.SESSION_CACHE;
}

function cacheKey(roleId: string): string {
  return `${CACHE_KEY_PREFIX}${roleId}`;
}

function warnNoKvOnce(): void {
  if (kvWarnedOnce) return;
  kvWarnedOnce = true;
  console.warn(
    "[authz] no KV namespace bound (AUTHZ_KV / SESSION_CACHE); falling through to D1 every call",
  );
}

/**
 * Resolve the user's roleId + role name. Auth-middleware sets c.var.userRole
 * (the legacy users.role TEXT) but not c.var.userRoleId — we look the row up
 * here on first call.
 */
async function resolveUserRole(
  c: AuthzCtx,
): Promise<{ roleId: string; roleName: string } | null> {
  const userId = c.var.userId;
  if (!userId) return null;

  // Cached on context (per-request memo) so a route with multiple permission
  // checks only hits the DB once.
  const cached = c.get<{ roleId: string; roleName: string }>("userRoleResolved");
  if (cached) return cached;

  const row = await c.var.DB.prepare(
    `SELECT u.roleId AS roleId, r.name AS roleName
       FROM users u
       LEFT JOIN roles r ON r.id = u.roleId
      WHERE u.id = ?
      LIMIT 1`,
  )
    .bind(userId)
    .first<{ roleId: string | null; roleName: string | null }>();

  if (!row) return null;

  // Empty roleId -> READ_ONLY fallback per backfill default.
  const roleId = row.roleId ?? READ_ONLY_ROLE_ID;
  const roleName = row.roleName ?? "READ_ONLY";
  const resolved = { roleId, roleName };
  c.set("userRoleResolved", resolved);
  return resolved;
}

/**
 * Load the permission set for a role from KV cache, or D1 on miss. The result
 * is cached both in KV (cross-request, 5 min TTL) and on the Hono context
 * under "userPermissions" (per-request memo).
 */
async function loadPermissionSet(
  c: AuthzCtx,
  roleId: string,
): Promise<PermissionSet> {
  // Per-request memo — covers the common case of multiple permission checks
  // in one route (middleware + row-level hasPermission()).
  const memo = c.get<PermissionSet>("userPermissions");
  if (memo) return memo;

  const kv = getKv(c);
  const key = cacheKey(roleId);

  if (kv) {
    const cached = await kv.get(key, { type: "json" });
    if (cached && Array.isArray(cached)) {
      const set = new Set<string>(cached as string[]);
      c.set("userPermissions", set);
      return set;
    }
  } else {
    warnNoKvOnce();
  }

  // Cache miss (or no KV) -> direct D1 lookup.
  const res = await c.var.DB.prepare(
    `SELECT p.resource AS resource, p.action AS action
       FROM role_permissions rp
       JOIN permissions p ON rp.permissionId = p.id
      WHERE rp.roleId = ?`,
  )
    .bind(roleId)
    .all<{ resource: string; action: string }>();

  const rows = res.results ?? [];
  const set = new Set<string>(rows.map((r) => `${r.resource}:${r.action}`));
  c.set("userPermissions", set);

  if (kv) {
    const payload = JSON.stringify(Array.from(set));
    const writePromise = kv.put(key, payload, {
      expirationTtl: AUTHZ_CACHE_TTL_S,
    });
    // Fire-and-forget — match auth-middleware's pattern; don't block the
    // request on the cache write. waitUntil is not available in tests.
    if (c.executionCtx?.waitUntil) {
      c.executionCtx.waitUntil(writePromise);
    } else {
      // No executionCtx (tests, sync flows) — let the promise dangle. Errors
      // are non-fatal; the worst case is the next call is also a cache miss.
      void writePromise.catch(() => {});
    }
  }

  return set;
}

// ---- Public API ------------------------------------------------------------

/**
 * Hono middleware factory. Returns 403 if the user's role lacks the requested
 * (resource, action). Returns 401 if the request never authenticated (i.e.
 * c.var.userId is not set — auth-middleware should have run before this).
 *
 * SUPER_ADMIN role short-circuits to allow.
 *
 * Usage:
 *   app.get(
 *     "/api/sales-orders",
 *     requirePermission("sales-orders", "read"),
 *     handler,
 *   );
 */
export function requirePermission(
  resource: string,
  action: string,
): (c: Context, next: Next) => Promise<Response | void> {
  const required = `${resource}:${action}`;
  return async (rawCtx: Context, next: Next): Promise<Response | void> => {
    const c = ctxAsAuthz(rawCtx);

    if (!c.var.userId) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    const role = await resolveUserRole(c);
    if (!role) {
      // userId set but no row found (shouldn't happen in practice, but treat
      // as forbidden rather than crash).
      return c.json({ success: false, error: "Forbidden" }, 403);
    }

    // SUPER_ADMIN bypass — see header comment for rationale.
    if (role.roleName === SUPER_ADMIN_ROLE_NAME) {
      return next();
    }

    const set = await loadPermissionSet(c, role.roleId);
    if (set.has(required)) {
      return next();
    }
    return c.json({ success: false, error: "Forbidden" }, 403);
  };
}

/**
 * Lower-level lookup for use inside route handlers — e.g. row-level checks
 * where the (resource, action) depends on request data and can't be expressed
 * at the route-registration level.
 *
 *   if (!(await hasPermission(c, "invoices", "post"))) {
 *     return c.json({ success: false, error: "Forbidden" }, 403);
 *   }
 *
 * Returns false (not throws) when the user is unauthenticated, has no role,
 * or simply lacks the permission. Returns true for SUPER_ADMIN.
 */
export async function hasPermission(
  rawCtx: Context,
  resource: string,
  action: string,
): Promise<boolean> {
  const c = ctxAsAuthz(rawCtx);
  if (!c.var.userId) return false;

  const role = await resolveUserRole(c);
  if (!role) return false;
  if (role.roleName === SUPER_ADMIN_ROLE_NAME) return true;

  const set = await loadPermissionSet(c, role.roleId);
  return set.has(`${resource}:${action}`);
}

/**
 * Invalidate the cached permission set for a role. Call this from any
 * mutation handler that edits role_permissions (e.g. SUPER_ADMIN promotes a
 * role's capabilities) so the new matrix is visible immediately rather than
 * after the 5-minute TTL.
 *
 * Granularity is per-role, not per-user — every user on that role picks up
 * the change on their next request.
 */
export async function invalidateRolePermissions(
  rawCtx: Context,
  roleId: string,
): Promise<void> {
  const c = ctxAsAuthz(rawCtx);
  const kv = getKv(c);
  if (!kv) return;
  await kv.delete(cacheKey(roleId));
}
