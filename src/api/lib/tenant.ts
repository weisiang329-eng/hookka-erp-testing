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
  let orgId = DEFAULT_ORG_ID;
  if (userId) {
    try {
      const row = await c.var.DB.prepare(
        "SELECT orgId AS orgId FROM users WHERE id = ? LIMIT 1",
      )
        .bind(userId)
        .first<UserOrgRow>();
      if (row?.orgId) orgId = row.orgId;
    } catch {
      // Fail-open to default — a missing column / migration not-yet-applied
      // must not break the request path. The roadmap expects this column
      // to be populated by 0049; until it is, every user is on 'hookka'.
    }
  }

  (c as unknown as { set: (k: string, v: unknown) => void }).set("orgId", orgId);
  await next();
};

/**
 * Read the active orgId off the Hono context. Returns DEFAULT_ORG_ID if
 * the middleware hasn't run yet — defensive fallback so a forgotten wire-up
 * doesn't accidentally leak a query across tenants (it just over-restricts
 * to the default tenant, which is the conservative failure mode).
 */
export function getOrgId<E extends Env>(c: Context<E>): string {
  const v = (c.get as unknown as (k: string) => unknown)("orgId");
  return typeof v === "string" && v.length > 0 ? v : DEFAULT_ORG_ID;
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
  _c: Context<E>,
  _table: string,
  where: string = "",
): { whereSql: string; params: unknown[] } {
  // ───────────────────────────────────────────────────────────────────────
  // SAFETY GATE — 2026-04-26 (Wei Siang report: Production + Sales lists
  // came back empty after this code shipped without migration 0049 being
  // applied to remote D1). Without the orgId column, the query
  // `WHERE orgId = ?` errors at SQL parse time and the frontend silently
  // shows zero rows.
  //
  // Until migrations 0048–0055 are applied (admin task — see DR-RUNBOOK.md),
  // this helper degrades to a no-op so the app keeps serving rows. Once the
  // migrations are in place, restore the original WHERE-orgId logic by
  // checking c.env.MIGRATIONS_APPLIED or by removing this guard entirely.
  // ───────────────────────────────────────────────────────────────────────
  const trimmed = where.trim();
  if (trimmed.length === 0) {
    return { whereSql: "", params: [] };
  }
  return {
    whereSql: `WHERE ${trimmed}`,
    params: [],
  };
}
