// ---------------------------------------------------------------------------
// ensure-org-roles.ts — a role ROW for every org department.
//
// Owner 2026-08-04: "根据我们的部门都要有对应的 role，先把 role 都打开."
//
// This file creates the role so it can be picked on the Users page. It does NOT
// grant permissions — those live in `role-policy.ts`, written as code at the
// owner's instruction: "我全部要用程序代码那边去处理这个 RBAC 就可以了."
//
// It used to seed grants here as well, which left HR / QA / R&D / OFFICE with a
// permission set in TWO places. That is the exact defect that took purchase
// invoice creation down earlier the same day: two definitions of one thing,
// drifting until one broke. So there is one source, and it is not this file —
// `rbac.ts` short-circuits to the code policy before it ever reads the table.
//
// NOTE the two different "departments" here. The `departments` TABLE is the 14
// PRODUCTION stages (Fabric Cutting, Sewing, …) used by job cards and
// scheduling. This file is about `users.department`, the org chart. Different
// axes — conflating them is the easy mistake.
// ---------------------------------------------------------------------------

interface Runner {
  prepare(sql: string): {
    bind(...args: unknown[]): { run(): Promise<unknown> };
    run(): Promise<unknown>;
  };
}

export interface OrgRole {
  id: string;
  name: string;
  description: string;
  /** `users.department` values that default to this role. */
  departments: string[];
}

/**
 * One role per org department. The permission detail behind each lives in
 * `role-policy.ts`; the description here is the one-line version of it.
 */
export const ORG_ROLES: OrgRole[] = [
  {
    id: "role_hr",
    name: "HR",
    description: "Employees, attendance, leave, payroll and payslips",
    departments: ["HR"],
  },
  {
    id: "role_qa",
    name: "QA",
    description: "Quality and Procurement",
    departments: ["QA"],
  },
  {
    id: "role_rd",
    name: "R_AND_D",
    description: "Product development and Quality",
    departments: ["R&D", "R_AND_D", "RD"],
  },
  {
    id: "role_office",
    name: "OFFICE",
    description: "Everything except Finance and Forecasting",
    departments: ["Office"],
  },
];

let _applied = false;

/**
 * Create any missing org role.
 *
 * Cached as a BOOLEAN, never as the in-flight promise: a rejected promise stays
 * cached and one transient failure would disable this for the life of the
 * isolate, while a pending one shares the socket of the request that created it
 * (db-pg.ts forbids that).
 *
 * Additive only — `ON CONFLICT DO NOTHING`, no UPDATE, no DELETE.
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
  }
  _applied = true;
}

/** For tests — reset the module-level memo between cases. */
export function _resetOrgRolesMemoForTests(): void {
  _applied = false;
}

/**
 * The role a department defaults to, or null when it maps to none.
 *
 * A SUGGESTION for the Users page, never an automatic assignment — least of all
 * for Management, which maps to the master key.
 */
export function defaultRoleForDepartment(department: string): string | null {
  const d = (department || "").trim().toUpperCase();
  if (!d) return null;
  for (const r of ORG_ROLES) {
    if (r.departments.some((x) => x.toUpperCase() === d)) return r.name;
  }
  const legacy: Record<string, string> = {
    SALES: "SALES",
    FINANCE: "FINANCE",
    PRODUCTION: "PRODUCTION",
    PROCUREMENT: "PROCUREMENT",
    WAREHOUSE: "WAREHOUSE",
    WAREHOUSING: "WAREHOUSE",
    // Owner ruling 2026-08-04: "management 不是跟 superadmin 的吗？" — yes.
    MANAGEMENT: "SUPER_ADMIN",
  };
  return legacy[d] ?? null;
}
