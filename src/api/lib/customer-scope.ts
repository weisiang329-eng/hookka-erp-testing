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

/**
 * Path prefixes whose payloads carry customer-linked rows.
 *
 * Owner 2026-08-05: "他只会看到自己客户的 Sales Order、DO、DR，还有 Production
 * Order… 可是 service case 和 Service Order，那就是看他自己的客户的."
 *
 * `/api/planning` is deliberately NOT here — the Planning module is seen in
 * full by everyone ("Planning 他也是会直接看完的"). The Delivery Orders page's
 * own Planning TAB is a different thing: it lists sales orders still awaiting a
 * DO, and a sales order narrows to its customer like any other.
 */
export const SCOPED_PREFIXES = [
  "/api/customers",
  "/api/sales-orders",
  "/api/delivery-orders",
  "/api/delivery-returns",
  "/api/production-orders",
  "/api/service-orders",
  "/api/service-cases",
  "/api/invoices",
  "/api/consignments",
  "/api/consignment-notes",
  "/api/consignment-orders",
];

/** Field names a row might carry its customer under. */
const CUSTOMER_KEYS = ["customerId", "customer_id", "customerid"];

/**
 * Field names a row might carry its customer's NAME under.
 *
 * Needed because plenty of list queries select the name and not the id —
 * /api/delivery-orders/pending-sos is one, and it was showing all 116 rows to a
 * salesperson who owns none of them. A row with no recognisable customer is
 * kept by design, so a row identified only by name was indistinguishable from
 * one that genuinely belongs to nobody.
 *
 * The id is still what decides when it is present; this is the fallback.
 */
const CUSTOMER_NAME_KEYS = ["customerName", "customer_name", "customername", "customer"];

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
  /** Upper-cased names of the same customers, for rows that carry no id. */
  forbiddenNames: Set<string>;
  denyAll: boolean;
}

export async function foreignCustomerIds(
  c: Context<Env>,
): Promise<CustomerScope | null> {
  const get = (c as unknown as { get: (k: string) => string | undefined }).get;
  const role = (get.call(c, "userRole") ?? "").toUpperCase();
  if (!SCOPED_ROLES.has(role)) return null;

  const userId = get.call(c, "userId") ?? "";
  if (!userId) {
    return { forbidden: new Set(), forbiddenNames: new Set(), denyAll: true };
  }

  try {
    // Assigned to SOMEBODY, and that somebody is not me. An unassigned row is
    // absent from this set by construction, so it stays public.
    const res = await c.var.DB.prepare(
      "SELECT id, name FROM customers WHERE salesperson_user_id IS NOT NULL AND salesperson_user_id <> ?",
    )
      .bind(userId)
      .all<{ id: string; name: string | null }>();
    const rows = res.results ?? [];
    return {
      forbidden: new Set(rows.map((r) => String(r.id))),
      forbiddenNames: new Set(
        rows
          .map((r) => String(r.name ?? "").trim().toUpperCase())
          .filter((n) => n !== ""),
      ),
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
    return { forbidden: new Set(), forbiddenNames: new Set(), denyAll: true };
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

/** The customer NAME a row carries, upper-cased, or null. */
function customerNameOf(row: unknown, isCustomerRow: boolean): string | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const keys = isCustomerRow ? ["name", ...CUSTOMER_NAME_KEYS] : CUSTOMER_NAME_KEYS;
  for (const k of keys) {
    const v = r[k];
    // Guard against an object landing here (`customer: { id, name }`) — only a
    // plain scalar is a name.
    if (typeof v === "string" && v.trim() !== "") return v.trim().toUpperCase();
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
    // The id is authoritative when present: a row naming a forbidden customer
    // but carrying an id we allow is genuinely ours (a renamed or merged
    // account), and must not be dropped on the name alone.
    if (cid !== null) return scope.forbidden.has(cid);
    const cname = customerNameOf(row, isCustomerRow);
    return cname !== null && scope.forbiddenNames.has(cname);
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

/** Is this actor row-scoped at all? Cheap — role only, no database read. */
export function isCustomerScoped(c: Context<Env>): boolean {
  const get = (c as unknown as { get: (k: string) => string | undefined }).get;
  return SCOPED_ROLES.has((get.call(c, "userRole") ?? "").toUpperCase());
}

/**
 * A WHERE fragment that keeps only the rows this actor may see.
 *
 * The response filter above cannot do everything, and pretending otherwise is
 * what the owner caught on 2026-08-05: the Sales Orders GRID was correctly
 * empty while the cards above it read 1,229 orders and RM 1.4m, and the
 * Delivery Orders planning list showed all 116 rows.
 *
 * Two holes, both structural:
 *   • an AGGREGATE is a number, not a row. `/stats` returns counts and totals
 *     with no customer on them, so there is nothing for a row filter to drop —
 *     it has to be computed narrowed in the first place;
 *   • a row is only filtered if it CARRIES a customer id. `/pending-sos`
 *     selects customerName and not customerId, so every row looked
 *     customer-less and was kept, exactly as the filter is documented to do.
 *
 * So the scope also has to exist in SQL, where the count and the rows come from
 * the same predicate and cannot disagree.
 *
 * Returns an empty clause for unscoped roles (and for a scoped role with
 * nothing to hide), so callers can concatenate unconditionally.
 */
export interface ScopeSql {
  clause: string;
  binds: string[];
}

export async function customerScopeSql(
  c: Context<Env>,
  column = "customerId",
): Promise<ScopeSql> {
  const scope = await foreignCustomerIds(c);
  if (scope === null) return { clause: "", binds: [] };
  // Lookup failed — show nothing rather than everything.
  if (scope.denyAll) return { clause: "1 = 0", binds: [] };
  if (scope.forbidden.size === 0) return { clause: "", binds: [] };
  const ids = [...scope.forbidden];
  const holes = ids.map(() => "?").join(", ");
  // A row with NO customer stays visible — unassigned work is public, same
  // rule as the response filter. Only a row belonging to somebody else's
  // customer is removed.
  return {
    clause: `(${column} IS NULL OR ${column} NOT IN (${holes}))`,
    binds: ids,
  };
}

/**
 * The same scope for a table that reaches its customer through a sales order.
 *
 * `production_orders` carries salesOrderId and customerName but no customerId,
 * so it cannot be narrowed directly. Owner 2026-08-05 put production orders in
 * the same bucket as sales orders, which is the right reading — a production
 * order exists because a sales order does.
 *
 * A production order with NO sales order (stock builds, samples) has no
 * customer to belong to and stays visible, same rule as everywhere else.
 */
export async function salesOrderScopeSql(
  c: Context<Env>,
  column = "salesOrderId",
  consignmentColumn = "consignmentOrderId",
): Promise<ScopeSql> {
  const scope = await foreignCustomerIds(c);
  if (scope === null) return { clause: "", binds: [] };
  if (scope.denyAll) return { clause: "1 = 0", binds: [] };
  if (scope.forbidden.size === 0) return { clause: "", binds: [] };
  const ids = [...scope.forbidden];
  const holes = ids.map(() => "?").join(", ");
  // A production order comes from a sales order OR a consignment order, and
  // BOTH carry a customer. Checking only the sales order left every one of the
  // 38 consignment-origin production orders on prod visible to a salesperson
  // who owns none of them — they simply had no salesOrderId to test.
  const notForeign = (col: string, table: string) =>
    `${col} IS NULL OR ${col} = '' OR ${col} NOT IN ` +
    `(SELECT id FROM ${table} WHERE customer_id IN (${holes}))`;
  return {
    clause:
      `((${notForeign(column, "sales_orders")}) AND ` +
      `(${notForeign(consignmentColumn, "consignment_orders")}))`,
    binds: [...ids, ...ids],
  };
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
