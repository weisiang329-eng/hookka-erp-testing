// ---------------------------------------------------------------------------
// ensure-derived-permissions.ts — give a sub-module its own gate without
// taking anything away.
//
// Owner 2026-08-04, on Delivery Return sharing delivery-orders and Service
// Cases sharing service-orders: "要继续吗？这个是的."
//
// Those routes check the PARENT resource, so "Delivery Order read-only but
// Delivery Return editable" cannot be expressed at all. Splitting them needs a
// resource of their own — but adding a gate can only ever REMOVE access, and a
// role that has never heard of `delivery-returns` would be locked out of a page
// it uses today.
//
// So the new grant is DERIVED from the parent: every role holding
// `delivery-orders:update` is given `delivery-returns:update`, action for
// action. Behaviour on the day of the change is identical by construction, and
// the two can diverge afterwards — which is the whole point.
//
// `mail-center` is the exception: it has no parent, and the owner's rule is
// that everyone has it ("News Center… 全部人都有的"). It is granted to every
// role rather than derived.
//
// Additive only — INSERT … ON CONFLICT DO NOTHING, no UPDATE, no DELETE. A role
// an admin has since edited keeps its edits.
// ---------------------------------------------------------------------------

interface Runner {
  prepare(sql: string): {
    bind(...args: unknown[]): { run(): Promise<unknown> };
    run(): Promise<unknown>;
  };
}

const ACTIONS = ["read", "create", "update", "delete"];

/**
 * Sub-modules that were sharing a parent's gate, and the parent they inherit
 * from. Listed as data so adding another is one line, not another migration.
 */
export const DERIVED_RESOURCES: Array<{ child: string; parent: string }> = [
  { child: "delivery-returns", parent: "delivery-orders" },
  { child: "service-cases", parent: "service-orders" },
  { child: "purchase-returns", parent: "purchase-orders" },
  { child: "quotations", parent: "customers" },
  { child: "sales-pipeline", parent: "customers" },
];

/** Resources every role gets, because the owner's rule is that everyone has them. */
export const UNIVERSAL_RESOURCES = ["mail-center", "settings"];

let _applied = false;

/**
 * Create the missing permission rows and derive their grants.
 *
 * Cached as a BOOLEAN, never as the in-flight promise: a rejected promise stays
 * cached and one transient failure would disable this for the life of the
 * isolate, while a pending one shares the socket of the request that created it.
 */
export async function ensureDerivedPermissions(db: Runner): Promise<void> {
  if (_applied) return;

  for (const { child, parent } of DERIVED_RESOURCES) {
    for (const action of ACTIONS) {
      await db
        .prepare(
          `INSERT INTO permissions (id, resource, action, description)
           VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        )
        .bind(
          `perm_${child.replace(/-/g, "_")}_${action}`,
          child,
          action,
          `${action} ${child}`,
        )
        .run();

      // Derive: whoever holds the parent at this action holds the child at it.
      await db
        .prepare(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT rp.role_id, cp.id
             FROM role_permissions rp
             JOIN permissions pp ON pp.id = rp.permission_id
             JOIN permissions cp ON cp.resource = ? AND cp.action = ?
            WHERE pp.resource = ? AND pp.action = ?
           ON CONFLICT DO NOTHING`,
        )
        .bind(child, action, parent, action)
        .run();
    }
  }

  for (const res of UNIVERSAL_RESOURCES) {
    for (const action of ACTIONS) {
      await db
        .prepare(
          `INSERT INTO permissions (id, resource, action, description)
           VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        )
        .bind(
          `perm_${res.replace(/-/g, "_")}_${action}`,
          res,
          action,
          `${action} ${res}`,
        )
        .run();
      await db
        .prepare(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT r.id, p.id FROM roles r, permissions p
            WHERE p.resource = ? AND p.action = ?
           ON CONFLICT DO NOTHING`,
        )
        .bind(res, action)
        .run();
    }
  }

  _applied = true;
}

/** For tests — reset the module-level memo between cases. */
export function _resetDerivedPermsMemoForTests(): void {
  _applied = false;
}
