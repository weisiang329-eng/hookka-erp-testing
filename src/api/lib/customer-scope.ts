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
 * The customer ids this user owns, or null when they own the whole book.
 *
 * Null means "no filtering" and is returned for every unscoped role — kept
 * distinct from an EMPTY set, which means "scoped, and owns nothing yet" and
 * must hide everything. Collapsing the two would turn a brand-new salesperson
 * into an admin.
 */
export async function ownedCustomerIds(
  c: Context<Env>,
): Promise<Set<string> | null> {
  const get = (c as unknown as { get: (k: string) => string | undefined }).get;
  const role = (get.call(c, "userRole") ?? "").toUpperCase();
  if (!SCOPED_ROLES.has(role)) return null;

  const userId = get.call(c, "userId") ?? "";
  if (!userId) return new Set();

  try {
    const res = await c.var.DB.prepare(
      "SELECT id FROM customers WHERE salesperson_user_id = ?",
    )
      .bind(userId)
      .all<{ id: string }>();
    return new Set((res.results ?? []).map((r) => String(r.id)));
  } catch (err) {
    // A failure here must FAIL CLOSED. The alternative — treating an error as
    // "no filter" — turns a transient database blip into a data leak, which is
    // exactly the failure mode this whole module exists to prevent.
    console.error(
      "[customer-scope] owner lookup failed, denying all:",
      err instanceof Error ? err.message : String(err),
    );
    return new Set();
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
  owned: Set<string>,
  isCustomerRow: boolean,
): { value: unknown; denied: boolean } {
  if (Array.isArray(payload)) {
    return {
      value: payload.filter((row) => {
        const cid = customerOf(row, isCustomerRow);
        return cid === null || owned.has(cid);
      }),
      denied: false,
    };
  }
  const cid = customerOf(payload, isCustomerRow);
  if (cid !== null && !owned.has(cid)) return { value: null, denied: true };
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

  const owned = await ownedCustomerIds(c);
  if (owned === null) return; // unscoped role — untouched

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
    const r = filterPayload((body as Record<string, unknown>).data, owned, isCustomerRow);
    denied = r.denied;
    out = { ...(body as Record<string, unknown>), data: r.value };
  } else {
    const r = filterPayload(body, owned, isCustomerRow);
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
