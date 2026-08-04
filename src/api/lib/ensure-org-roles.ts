// ---------------------------------------------------------------------------
// ensure-org-roles.ts — a role for every ORG department.
//
// Owner 2026-08-04: "根据我们的部门都要有对应的 role，先把 role 都打开，然后我们
// 再 control role 的 RBAC."
//
// The 0045 seed created 8 roles around FUNCTIONS (sales, finance, procurement,
// production, warehouse, worker, read-only, super-admin). But people are filed
// by ORG DEPARTMENT — `users.department` holds Sales, Finance, Production, HR,
// R&D, QA, Office, Management — and four of those had no role at all. Everyone
// in them sat on ADMIN, which `rbac.ts` short-circuits to `*:*`, so they had
// the run of the system: HR could read every cost and margin, QA could edit
// invoices.
//
// NOTE the two different "departments" in this system, which is easy to
// conflate: the `departments` TABLE is the 14 production stages (Fabric
// Cutting, Sewing, …) used by job cards and scheduling. This file is about
// `users.department`, the org chart. They are not the same axis.
//
// Department is the DEFAULT for a role, never a hard link — the two stay
// separate columns so one person can sit in Office and hold PROCUREMENT, or
// cover two functions. This only guarantees a sensible role EXISTS for each
// department; who gets which is assigned per user, and the grants below are a
// starting point the owner tunes from the permissions UI.
//
// Idempotent and additive: roles are inserted ON CONFLICT DO NOTHING and grants
// are re-applied, so a role an admin has since edited is NOT reset — only
// missing rows are added.
// ---------------------------------------------------------------------------

interface Runner {
  prepare(sql: string): {
    bind(...args: unknown[]): { run(): Promise<unknown>; all<T>(): Promise<{ results?: T[] }> };
    run(): Promise<unknown>;
    all<T>(): Promise<{ results?: T[] }>;
  };
}

/** `resource: [actions]` — matched against the `permissions` table. */
type Grants = Record<string, string[]>;

const RW = ["read", "create", "update", "delete"];
const RO = ["read"];

export interface OrgRole {
  id: string;
  name: string;
  description: string;
  /** `users.department` values that should default to this role. */
  departments: string[];
  grants: Grants;
}

/**
 * The roles each org department needs, and what they start with.
 *
 * Deliberately scoped to the work, not to seniority — a department gets what
 * it needs to do its job and nothing further. Anything commercially sensitive
 * (cost ledger, margins, payments) is granted only where the job requires it.
 */
export const ORG_ROLES: OrgRole[] = [
  {
    id: "role_hr",
    name: "HR",
    description: "People — workers, attendance, leave, payroll and payslips",
    departments: ["HR"],
    grants: {
      workers: RW,
      attendance: RW,
      leaves: RW,
      payroll: RW,
      payslips: RW,
      // The production-stage list, so workers can be assigned to one.
      departments: RO,
      // See who has an account; creating/disabling stays SUPER_ADMIN-only
      // (users.ts enforces that separately via requireSuperAdmin).
      users: RO,
      notifications: RO,
    },
  },
  {
    id: "role_qa",
    name: "QA",
    description: "Quality — inspections, defects, equipment and maintenance",
    departments: ["QA"],
    grants: {
      "qc-inspections": RW,
      "maintenance-logs": RW,
      equipment: ["read", "update"],
      // Record a defect against the card that produced it, but never create or
      // delete production work.
      "job-cards": ["read", "update"],
      "production-orders": RO,
      "fg-units": RO,
      products: RO,
      bom: RO,
      // A defect found in QA becomes a service order.
      "service-orders": ["read", "create", "update"],
      notifications: RO,
    },
  },
  {
    id: "role_rd",
    name: "R_AND_D",
    description: "Product development — products, BOM, combos, fabrics",
    departments: ["R&D", "R_AND_D", "RD"],
    grants: {
      products: RW,
      bom: RW,
      "bom-master-templates": RW,
      "sofa-combos": RW,
      "product-configs": RW,
      fabrics: RW,
      "rd-projects": RW,
      "customer-products": RW,
      // New materials get specified here, but retiring one has stock and cost
      // consequences that belong to warehouse / finance.
      "raw-materials": ["read", "create", "update"],
      "price-history": RO,
      "sales-orders": RO,
      "production-orders": RO,
      "job-cards": RO,
      inventory: RO,
      notifications: RO,
    },
  },
  {
    id: "role_office",
    name: "OFFICE",
    description: "Administration — purchasing, receiving, document entry",
    departments: ["Office"],
    grants: {
      // Raise and receive, but approving a PO is a spend decision.
      "purchase-orders": ["read", "create", "update", "receive"],
      grn: RW,
      suppliers: RW,
      "supplier-materials": RW,
      "goods-in-transit": RW,
      customers: ["read", "create", "update"],
      "customer-hubs": RW,
      "sales-orders": ["read", "create", "update"],
      "delivery-orders": ["read", "create", "update"],
      invoices: ["read", "create", "update"],
      organisations: RO,
      inventory: RO,
      notifications: RO,
    },
  },
  {
    id: "role_management",
    name: "MANAGEMENT",
    description: "Oversight — read across the business, approve spend",
    departments: ["Management"],
    // Read-everything is granted below by expansion, not listed here; the
    // explicit grants are the WRITE actions management actually needs.
    grants: {
      "purchase-orders": ["read", "approve"],
      "sales-orders": ["read", "confirm"],
      forecasts: RW,
      notifications: RO,
    },
  },
];

/** Roles that also receive read on EVERY resource. */
const READ_ALL_ROLES = new Set(["role_management"]);

let _applied = false;

/**
 * Create any missing org role and grant its starting permissions.
 *
 * Cached as a BOOLEAN, never as the in-flight promise: a rejected promise stays
 * cached and one transient failure would disable this for the life of the
 * isolate, while a pending one shares the socket of the request that created it
 * (db-pg.ts forbids that).
 */
export async function ensureOrgRoles(db: Runner): Promise<void> {
  if (_applied) return;

  for (const role of ORG_ROLES) {
    await db
      .prepare(
        "INSERT INTO roles (id, name, description) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
      )
      .bind(role.id, role.name, role.description)
      .run();

    // Grant by (resource, action) so a permission id naming convention change
    // cannot silently drop a grant.
    for (const [resource, actions] of Object.entries(role.grants)) {
      for (const action of actions) {
        await db
          .prepare(
            `INSERT INTO role_permissions (role_id, permission_id)
             SELECT ?, p.id FROM permissions p
              WHERE p.resource = ? AND p.action = ?
             ON CONFLICT DO NOTHING`,
          )
          .bind(role.id, resource, action)
          .run();
      }
    }

    if (READ_ALL_ROLES.has(role.id)) {
      await db
        .prepare(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT ?, p.id FROM permissions p WHERE p.action = 'read'
           ON CONFLICT DO NOTHING`,
        )
        .bind(role.id)
        .run();
    }
  }

  _applied = true;
}

/** For tests — reset the module-level memo between cases. */
export function _resetOrgRolesMemoForTests(): void {
  _applied = false;
}

/** The role a department defaults to, or null when it maps to none. */
export function defaultRoleForDepartment(department: string): string | null {
  const d = (department || "").trim().toUpperCase();
  if (!d) return null;
  for (const r of ORG_ROLES) {
    if (r.departments.some((x) => x.toUpperCase() === d)) return r.name;
  }
  // Departments the 0045 seed already covers.
  const legacy: Record<string, string> = {
    SALES: "SALES",
    FINANCE: "FINANCE",
    PRODUCTION: "PRODUCTION",
    PROCUREMENT: "PROCUREMENT",
    WAREHOUSE: "WAREHOUSE",
    WAREHOUSING: "WAREHOUSE",
  };
  return legacy[d] ?? null;
}
