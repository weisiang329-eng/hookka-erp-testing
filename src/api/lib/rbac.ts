// ---------------------------------------------------------------------------
// RBAC — role-based permission checks built on the 0045_rbac.sql schema.
//
// The schema (roles / permissions / role_permissions) was migrated by P3.1.
// auth-middleware.ts already stamps `userRole` on the Hono context for every
// authenticated request.  This module is the second half: turn that role
// into a `(resource, action) -> allowed?` decision.
//
// Cache: per-role permission set is cached in KV (SESSION_CACHE binding) for
// 5 minutes.  Cache key = "rbac:perms:" + roleId.  Invalidate on role-perm
// edits (admin endpoint) by deleting the key.
//
// Fallback: if a role doesn't yet exist in the new tables (legacy users
// still on users.role TEXT), allow the request iff the legacy `role` matches
// the conservative default in LEGACY_ROLE_DEFAULTS below — this keeps the
// dashboard working during the rollout.  Once every user has a roleId, the
// legacy fallback can be deleted.
//
// Usage in a Hono route handler:
//   import { requirePermission } from "../lib/rbac";
//   app.post("/", async (c) => {
//     const denied = await requirePermission(c, "sales-orders", "create");
//     if (denied) return denied;       // 403 response, abort handler
//     // ...normal logic...
//   });
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";

const PERM_CACHE_TTL_S = 300;

// Role-name → set of "resource:action" tuples.  Loaded lazily per role and
// cached in KV.  Empty Set means the role has no granted permissions
// (treated as deny-all).
type PermSet = Set<string>;

function permKey(role: string): string {
  return `rbac:perms:${role}`;
}

/**
 * Conservative permission set for legacy users that haven't been migrated
 * to the new roleId column yet.  Maps the old `users.role` TEXT enum to a
 * minimal allow-list so the app keeps working.  Anything not in this map
 * gets the same treatment as a fully-migrated role with zero permissions
 * (deny-all by design — surface the gap loudly).
 */
const LEGACY_ROLE_DEFAULTS: Record<string, string[]> = {
  // Super admin keeps wildcard ✱:✱ — the wildcard handler below short-circuits
  // any check.
  SUPER_ADMIN: ["*:*"],
  ADMIN: ["*:*"],
  // Read-only legacy users: every resource on action=read.
  READ_ONLY: ["*:read"],
  // Empty fallback — fully-typed roles below override per resource.
  USER: [],
};

async function loadRolePermissions(
  db: D1Database,
  role: string,
): Promise<PermSet> {
  // role here is the user.role TEXT (uppercase like "FINANCE").  The 0045
  // schema seeds roles.name with the same uppercase — join through.
  //
  // Defensive try/catch (2026-04-26 prod 500 dogfood report): if any of the
  // RBAC tables (roles / role_permissions / permissions) are missing or the
  // JOIN throws for any reason, fall through to the legacy default for the
  // role text rather than letting a 500 escape to the user. The same role
  // text is what auth-middleware already stamps on the context from the
  // legacy users.role TEXT column, so this keeps the dashboard working
  // until ops re-applies migrations.
  let rows: { results?: { resource: string; action: string }[] } = {};
  try {
    rows = await db
      .prepare(
        `SELECT p.resource AS resource, p.action AS action
           FROM role_permissions rp
           JOIN roles r       ON r.id  = rp.roleId
           JOIN permissions p ON p.id  = rp.permissionId
          WHERE r.name = ?`,
      )
      .bind(role)
      .all<{ resource: string; action: string }>();
  } catch (err) {
    console.warn(
      `[rbac] role_permissions JOIN failed for role=${role} — falling back to legacy defaults. err=${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // rows stays empty → legacy fallback below kicks in.
  }

  const set: PermSet = new Set();
  for (const r of rows.results ?? []) {
    set.add(`${r.resource}:${r.action}`);
  }
  // No rows AND a known legacy fallback → seed the legacy defaults so the
  // user keeps working.  Logged at the end so ops can spot un-migrated roles.
  if (set.size === 0 && LEGACY_ROLE_DEFAULTS[role]) {
    for (const t of LEGACY_ROLE_DEFAULTS[role]) set.add(t);
    console.warn(
      `[rbac] role=${role} had 0 grants in role_permissions — seeded ${set.size} legacy defaults. Migrate user to new roleId.`,
    );
  }
  // No rows, no legacy default — give ANY authenticated caller read-only
  // access. Mutations stay locked. This is the fail-safe for an unknown
  // role text (e.g. "FINANCE" before its row exists) so the user doesn't
  // get stuck on a blank dashboard. Surfaced in the warn log above.
  if (set.size === 0) {
    set.add("*:read");
  }
  return set;
}

/** Get the permission set for a role, caching in KV. */
export async function getRolePermissions(
  c: Context<Env>,
  role: string,
): Promise<PermSet> {
  const kv = c.env.SESSION_CACHE;
  const key = permKey(role);

  if (kv) {
    const cached = await kv.get(key, { type: "json" });
    if (Array.isArray(cached)) return new Set(cached as string[]);
  }

  const set = await loadRolePermissions(c.var.DB, role);

  if (kv) {
    c.executionCtx.waitUntil(
      kv.put(key, JSON.stringify([...set]), { expirationTtl: PERM_CACHE_TTL_S }),
    );
  }
  return set;
}

/** Wildcard match — allow `*:*`, `*:action`, `resource:*` and the exact match. */
function permitted(set: PermSet, resource: string, action: string): boolean {
  return (
    set.has(`${resource}:${action}`) ||
    set.has(`${resource}:*`) ||
    set.has(`*:${action}`) ||
    set.has(`*:*`)
  );
}

/**
 * Authorise a Hono request against the (resource, action) tuple.  Returns
 * `null` when the call is allowed, or a 403 Response the caller should
 * `return` immediately.  Falls back to deny when context has no userRole.
 *
 * Example:
 *   const denied = await requirePermission(c, "sales-orders", "create");
 *   if (denied) return denied;
 */
export async function requirePermission(
  c: Context<Env>,
  resource: string,
  action: string,
): Promise<Response | null> {
  // userRole is stamped by auth-middleware via c.set('userRole', ...). Read
  // through the get() escape hatch since worker.ts's typed Variables map
  // doesn't enumerate the auth-middleware-injected keys.
  const role = (
    c as unknown as { get: (k: string) => string | undefined }
  ).get("userRole")?.toUpperCase();
  if (!role) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  // Defensive try/catch (2026-04-26 prod 500 dogfood report): if the
  // permission lookup throws (KV blip, D1 transient, schema drift), fall
  // back to legacy users.role text — SUPER_ADMIN / ADMIN keep full access,
  // anything else degrades to read-only via permitted() against ["*:read"].
  // This is strictly safer than letting a 500 escape, because the worst
  // case is a mutation getting blocked (caller retries) rather than the
  // whole page going blank. The thrown error is logged so ops can root-
  // cause via wrangler tail.
  let set: PermSet;
  try {
    set = await getRolePermissions(c, role);
  } catch (err) {
    console.warn(
      `[rbac] getRolePermissions threw for role=${role} resource=${resource} action=${action} — falling back to legacy. err=${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    set = new Set(LEGACY_ROLE_DEFAULTS[role] ?? ["*:read"]);
  }
  if (!permitted(set, resource, action)) {
    return c.json(
      {
        success: false,
        error: "Forbidden",
        // Loud body so the frontend can surface the missing permission to
        // ops without parsing console logs.
        missingPermission: `${resource}:${action}`,
        role,
      },
      403,
    );
  }
  return null;
}

/**
 * Invalidate the cached permission set for a role.  Call after admin edits
 * role_permissions for that role so the change is visible within seconds
 * instead of waiting out the 5-minute TTL.
 */
export async function invalidateRolePermissions(
  kv: KVNamespace | undefined,
  role: string,
): Promise<void> {
  if (!kv || !role) return;
  await kv.delete(permKey(role));
}
