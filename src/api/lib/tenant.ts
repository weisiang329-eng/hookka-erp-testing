// ---------------------------------------------------------------------------
// Multi-tenant scope helper — Phase C #1 quick-win.
//
// Reads the active `orgId` for the current request and exposes a couple of
// helpers that routes use to scope their queries. The default for every
// account today is 'hookka'; once a second tenant is seeded, that account's
// users.orgId carries the new value and the same helper transparently
// flips the scope.
//
// Wiring (see worker.ts):
//   1. authMiddleware looks up the user_sessions row and stashes userId on
//      the Hono context.
//   2. tenantMiddleware (this file) reads users.orgId for that userId and
//      stashes it as c.set('orgId', ...). Cached in KV alongside the auth
//      session so the second hop is free on cache hits.
//   3. Routes call `getOrgId(c)` and pass it to `withOrgScope(...)` to build
//      a `WHERE org_id = ? AND (...)` predicate.
//
// Default fallback: anything that hits this middleware before users.orgId
// is populated (or for a userless system call) defaults to 'hookka'. That
// matches the column DEFAULT in migration 0049 and keeps existing tenants
// unaffected during the rollout.
//
// Roadmap §1: this is the read-side enforcement. Write-side defaults are
// handled by the SQL DEFAULT 'hookka' until the §1 finish step adds INSERT
// helpers that stamp the active orgId.
// ---------------------------------------------------------------------------
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../worker";

export const DEFAULT_ORG_ID = "hookka";

type UserOrgRow = { orgId: string | null };

/**
 * Hono middleware: resolves the active orgId for the authenticated user
 * and stashes it on the request context. MUST be registered AFTER
 * authMiddleware (so c.get('userId') is populated) and BEFORE any route
 * that calls getOrgId / withOrgScope.
 *
 * Defaults to DEFAULT_ORG_ID for any request where the lookup fails or no
 * userId is present (e.g. CRON / health endpoints that bypass auth).
 */
export const tenantMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  const path = c.req.path;
  // Public / non-API paths — never need a tenant scope.
  if (!path.startsWith("/api/")) return next();

  const userId = (c.get as unknown as (k: string) => string | undefined)(
    "userId",
  );
  let orgId: string | null = null;
  if (userId) {
    try {
      const row = await c.var.DB.prepare(
        "SELECT orgId AS orgId FROM users WHERE id = ? LIMIT 1",
      )
        .bind(userId)
        .first<UserOrgRow>();
      if (row?.orgId) orgId = row.orgId;
    } catch {
      // Lookup error (missing column / pre-0049 schema) — leave orgId null;
      // getOrgId() will throw OrgIdRequiredError and the route fails 401
      // rather than leaking cross-tenant data via a silent fallback.
    }
  }

  // Sprint 4: only stash orgId if we actually resolved one. getOrgId()
  // throws when the slot is empty, which is the correct fail-closed
  // posture. Cron / worker-portal paths that genuinely have no user
  // context call tryGetOrgId() instead.
  if (orgId) {
    (c as unknown as { set: (k: string, v: unknown) => void }).set("orgId", orgId);
  }
  await next();
};

/**
 * Read the active orgId off the Hono context. THROWS a 401-style error if
 * the middleware hasn't populated it — Sprint 4 hardening removed the
 * "default to hookka" silent fallback. A request that reaches a route
 * handler without a resolved orgId is unauthenticated and MUST be rejected.
 *
 * Routes should call this at the top of every handler that touches
 * tenant-scoped data; the wrapping middleware (worker.ts) catches the
 * thrown OrgIdRequiredError and returns 401.
 */
export class OrgIdRequiredError extends Error {
  readonly status = 401 as const;
  constructor() {
    super("orgId not resolved on request context");
    this.name = "OrgIdRequiredError";
  }
}

export function getOrgId<E extends Env>(c: Context<E>): string {
  const v = (c.get as unknown as (k: string) => unknown)("orgId");
  if (typeof v !== "string" || v.length === 0) {
    throw new OrgIdRequiredError();
  }
  return v;
}

/**
 * Same as getOrgId but never throws — returns null when missing. Use only
 * inside system / cron / worker-portal code paths that legitimately have
 * no user context (CRON_SECRET-gated endpoints, fg-units public lookup,
 * etc.). Never call from a tenant-scoped handler.
 */
export function tryGetOrgId<E extends Env>(c: Context<E>): string | null {
  const v = (c.get as unknown as (k: string) => unknown)("orgId");
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Build a `WHERE` clause that scopes a query to the active orgId.
 *
 * Usage:
 *   const { whereSql, params } = withOrgScope(c, "sales_orders", "status = ?");
 *   db.prepare(`SELECT * FROM sales_orders ${whereSql} ORDER BY ...`)
 *     .bind(...params, "CONFIRMED")
 *
 * - `table` is currently informational (kept on the API so future versions
 *   can pick the right column name when join-aliases differ — e.g.
 *   "so.orgId" vs "orgId").
 * - `where` is the additional predicate (without the leading WHERE). Pass
 *   "" or omit when no extra filter is needed.
 *
 * The returned object splits the SQL fragment from the bound params so the
 * caller can append additional `bind(...)` arguments after. The first param
 * is always the orgId.
 */
export function withOrgScope<E extends Env>(
  c: Context<E>,
  _table: string,
  where: string = "",
): { whereSql: string; params: unknown[] } {
  // Sprint 4 — full activation. Migration 0049 covered the 6 highest-leak
  // tables; 0078 backfills the rest. Every list query now binds the active
  // orgId as the first parameter:
  //
  //   const { whereSql, params } = withOrgScope(c, "sales_orders", "status = ?");
  //   db.prepare(`SELECT * FROM sales_orders ${whereSql} ORDER BY ...`)
  //     .bind(...params, "CONFIRMED")
  //
  // params = [orgId, ...extraBinds-the-caller-appends]. whereSql always
  // begins with `WHERE orgId = ?` so the caller never has to think about
  // whether to use WHERE or AND.
  //
  // getOrgId throws OrgIdRequiredError if the tenant middleware hasn't
  // populated the context — which is the correct behavior: a request that
  // somehow bypasses tenantMiddleware should fail closed, not silently
  // fall back to the default org and leak the entire dataset.
  const orgId = getOrgId(c);
  const trimmed = where.trim();
  if (trimmed.length === 0) {
    return { whereSql: "WHERE orgId = ?", params: [orgId] };
  }
  return {
    whereSql: `WHERE orgId = ? AND (${trimmed})`,
    params: [orgId],
  };
}
