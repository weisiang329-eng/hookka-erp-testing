// ---------------------------------------------------------------------------
// customer-scope.ts — a salesperson sees their OWN customers' documents only.
//
// Owner 2026-08-04: "只能看到自己顾客的单据" / "只能看到自己的顾客，但可以进行
// 完整操作… 他只是不能操作其他人的顾客."
//
// This is NOT a permission. `requirePermission` answers "may you open Sales
// Orders at all"; it cannot answer "which rows". Those are different questions
// and conflating them is how row-level rules get half-implemented.
//
// ONE CHOKE POINT, on purpose.
// The six affected routes expose 29 GET endpoints between them. Filtering each
// query by hand means 29 chances to miss one, and a missed one is not a broken
// page — it is another salesperson's customer list rendering normally. So the
// filter runs as middleware over the RESPONSE, keyed on the path prefix: a new
// endpoint added to any of these routes tomorrow is covered without anyone
// remembering to cover it.
//
// What it does NOT do, and must not be mistaken for:
//   • it does not restrict writes. A salesperson may only edit their own
//     customers, and that is enforced where the write happens — a filter on the
//     way out cannot stop a PUT on the way in;
//   • it does not hide aggregates computed elsewhere (dashboards, reports).
//     Those live in other routes and are out of this scope by design.
//
// Only roles in SCOPED_ROLES are filtered. Everyone else — office, finance,
// management, super admin — sees the whole book, unchanged.
// ---------------------------------------------------------------------------
import type { Context, Next } from "hono";
import type { Env } from "../worker";

/** Roles that see only their own customers. */
export const SCOPED_ROLES = new Set(["SALES"]);

/** Path prefixes whose payloads carry customer-linked rows. */
export const SCOPED_PREFIXES = [
  "/api/customers",
  "/api/sales-orders",
  "/api/delivery-orders",
  "/api/delivery-returns",
  "/api/invoices",
  "/api/consignments",
];

/** Field names a row might carry its customer under. */
const CUSTOMER_KEYS = ["customerId", "customer_id", "customerid"];

export function isScopedPath(path: string): boolean {
  return SCOPED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`));
}

/**
 * The customers this user must NOT see — assigned to somebody else.
 *
 * Owner ruling 2026-08-04: "当他如果没有被 assign 的时候就是公开的，可是一旦被
 * assign，就只有那个 salesperson 看得到了."
 *
 * So the rule is not "show me mine" — it is "hide what belongs to someone
 * else". An UNASSIGNED customer is public and stays visible to everyone; only
 * an assigned one narrows to its owner. The difference matters: the first
 * reading would make every unclaimed account vanish for the whole sales team,
 * including the ones nobody has picked up yet.
 *
 * Null means no filtering at all (unscoped role). `denyAll` means the lookup
 * failed and nothing may be shown.
 */
export interface CustomerScope {
  forbidden: Set<string>;
  denyAll: boolean;
}

export async function foreignCustomerIds(
  c: Context<Env>,
): Promise<CustomerScope | null> {
  const get = (c as unknown as { get: (k: string) => string | undefined }).get;
  const role = (get.call(c, "userRole") ?? "").toUpperCase();
  if (!SCOPED_ROLES.has(role)) return null;

  const userId = get.call(c, "userId") ?? "";
  if (!userId) return { forbidden: new Set(), denyAll: true };

  try {
    // Assigned to SOMEBODY, and that somebody is not me. An unassigned row is
    // absent from this set by construction, so it stays public.
    const res = await c.var.DB.prepare(
      "SELECT id FROM customers WHERE salesperson_user_id IS NOT NULL AND salesperson_user_id <> ?",
    )
      .bind(userId)
      .all<{ id: string }>();
    return {
      forbidden: new Set((res.results ?? []).map((r) => String(r.id))),
      denyAll: false,
    };
  } catch (err) {
    // A failure here must FAIL CLOSED. The alternative — treating an error as
    // "no filter" — turns a transient database blip into a data leak, which is
    // exactly the failure mode this whole module exists to prevent.
    console.error(
      "[customer-scope] owner lookup failed, denying all:",
      err instanceof Error ? err.message : String(err),
    );
    return { forbidden: new Set(), denyAll: true };
  }
}

/** The customer id a row belongs to, or null when it carries none. */
function customerOf(row: unknown, isCustomerRow: boolean): string | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (isCustomerRow && r.id != null) return String(r.id);
  for (const k of CUSTOMER_KEYS) {
    if (r[k] != null && String(r[k]).trim() !== "") return String(r[k]);
  }
  return null;
}

/**
 * Drop rows the user does not own.
 *
 * A row with NO customer id is KEPT. These payloads carry more than customer
 * rows — option lists, totals, config — and silently blanking them would break
 * the page while looking like a permissions bug. The rule is "hide other
 * people's customers", not "hide anything unrecognised".
 */
export function filterPayload(
  payload: unknown,
  scope: CustomerScope,
  isCustomerRow: boolean,
): { value: unknown; denied: boolean } {
  const blocked = (row: unknown): boolean => {
    if (scope.denyAll) return true;
    const cid = customerOf(row, isCustomerRow);
    return cid !== null && scope.forbidden.has(cid);
  };
  if (Array.isArray(payload)) {
    return { value: payload.filter((row) => !blocked(row)), denied: false };
  }
  if (blocked(payload)) return { value: null, denied: true };
  return { value: payload, denied: false };
}

/**
 * Response middleware. Registered ONCE against `/api/*` and gated on the path
 * prefix, so a new endpoint under any scoped route inherits the filter.
 */
export async function customerScopeMiddleware(
  c: Context<Env>,
  next: Next,
): Promise<void> {
  await next();

  if (c.req.method !== "GET") return;
  const path = new URL(c.req.url).pathname;
  if (!isScopedPath(path)) return;

  const scope = await foreignCustomerIds(c);
  if (scope === null) return; // unscoped role — untouched

  const res = c.res;
  if (!res || res.status !== 200) return;
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return;

  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return; // not JSON we can reason about — leave it alone
  }

  const isCustomerRow = path === "/api/customers" || path.startsWith("/api/customers/");
  let out = body;
  let denied = false;

  if (body && typeof body === "object" && "data" in (body as Record<string, unknown>)) {
    const r = filterPayload((body as Record<string, unknown>).data, scope, isCustomerRow);
    denied = r.denied;
    out = { ...(body as Record<string, unknown>), data: r.value };
  } else {
    const r = filterPayload(body, scope, isCustomerRow);
    denied = r.denied;
    out = r.value;
  }

  if (denied) {
    // Someone else's record: 404, not 403. A 403 confirms the id exists, which
    // is itself a disclosure when ids are guessable.
    c.res = new Response(
      JSON.stringify({ success: false, error: "Not found" }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
    return;
  }

  c.res = new Response(JSON.stringify(out), {
    status: res.status,
    headers: res.headers,
  });
}

/**
 * Refuse a WRITE against a customer the actor does not own.
 *
 * The response filter hides other people's customers on the way OUT; it cannot
 * stop a PUT on the way IN. Owner 2026-08-04: "他只是不能操作其他人的顾客" —
 * that half is enforced here, at the write.
 *
 * Returns a Response to send when the write must be refused, or null to
 * proceed. 404 rather than 403, for the same reason as the read filter: a 403
 * confirms the id exists.
 */
export async function denyForeignCustomerWrite(
  c: Context<Env>,
  customerId: string,
): Promise<Response | null> {
  const scope = await foreignCustomerIds(c);
  if (scope === null) return null; // unscoped role
  // Unassigned is public — a salesperson may work an unclaimed account. Only
  // someone else's is refused.
  if (!scope.denyAll && !scope.forbidden.has(String(customerId))) return null;
  return c.json({ success: false, error: "Not found" }, 404);
}

/**
 * May this actor set / change a customer's salesperson?
 *
 * A scoped role may not — reassigning is how a salesperson would hand their
 * account to someone else, or quietly take one. That stays with the roles that
 * see the whole book.
 */
export function canAssignSalesperson(c: Context<Env>): boolean {
  const get = (c as unknown as { get: (k: string) => string | undefined }).get;
  const role = (get.call(c, "userRole") ?? "").toUpperCase();
  return !SCOPED_ROLES.has(role);
}

/**
 * The salesperson a NEW customer must be bound to.
 *
 * A scoped role always owns what it creates — the actor's own id, whatever the
 * body says. Without this the flow breaks in a way that looks like a bug rather
 * than a rule: a salesperson raises a Potential in the pipeline, the record is
 * saved with no owner, and the read filter hides it from them the instant it
 * exists. They would be watching their own work disappear.
 *
 * It also closes the other direction — a scoped role cannot create an account
 * already assigned to somebody else, which is the same reassignment
 * `canAssignSalesperson` blocks on update.
 *
 * Returns null for unscoped roles, meaning "use whatever the body sent".
 */
export function forcedSalespersonOnCreate(c: Context<Env>): string | null {
  const get = (c as unknown as { get: (k: string) => string | undefined }).get;
  const role = (get.call(c, "userRole") ?? "").toUpperCase();
  if (!SCOPED_ROLES.has(role)) return null;
  return get.call(c, "userId") ?? null;
}
