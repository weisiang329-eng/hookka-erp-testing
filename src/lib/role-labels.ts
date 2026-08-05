// ---------------------------------------------------------------------------
// role-labels.ts — how a role is written for a PERSON, and which one a
// department suggests.
//
// Owner 2026-08-04: "它的 Role R&D 为什么那么难看呢？" — because the grid was
// printing `R_AND_D`, which is the stored identifier, not a label.
//
// Lives outside the Users page for two reasons. The page may only export
// components (fast refresh), and these belong to more than one surface: any
// screen showing a role should write it the same way.
//
// The DEPARTMENT mapping mirrors `defaultRoleForDepartment` in
// src/api/lib/ensure-org-roles.ts. It is a SUGGESTION shown next to the picker,
// never an automatic assignment — least of all for Management, which maps to
// the master key.
// ---------------------------------------------------------------------------

/** Every role a user may hold, in the order the picker should list them. */
export const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "SUPER_ADMIN", label: "Super Admin (full access + manage users)" },
  { value: "ADMIN", label: "Admin (full access, cannot manage users)" },
  // Department roles. What each may DO is defined in
  // src/api/lib/role-policy.ts — this list only names them.
  { value: "SALES", label: "Sales" },
  { value: "FINANCE", label: "Finance" },
  { value: "PRODUCTION", label: "Production" },
  { value: "PROCUREMENT", label: "Procurement" },
  { value: "WAREHOUSE", label: "Warehouse" },
  { value: "OFFICE", label: "Office (all except Finance & Forecasting)" },
  { value: "QA", label: "QA (Quality & Procurement)" },
  { value: "R_AND_D", label: "R&D (product development & Quality)" },
  { value: "HR", label: "HR (employees, attendance, payroll)" },
  { value: "WORKER", label: "Worker (own attendance, payslip, scan)" },
  { value: "READ_ONLY", label: "Viewer (read-only)" },
];

const ROLE_SHORT: Record<string, string> = {
  SUPER_ADMIN: "Super Admin",
  ADMIN: "Admin",
  R_AND_D: "R&D",
  READ_ONLY: "Viewer",
  SALES: "Sales",
  FINANCE: "Finance",
  PRODUCTION: "Production",
  PROCUREMENT: "Procurement",
  WAREHOUSE: "Warehouse",
  OFFICE: "Office",
  QA: "QA",
  HR: "HR",
  WORKER: "Worker",
};

/** Short form for a grid cell or a chip. */
export function roleShort(role: string): string {
  const r = (role || "").trim().toUpperCase();
  if (!r) return "";
  // Fall back to title-casing rather than showing the identifier raw, so a role
  // added later still reads as words instead of `SOME_NEW_ROLE`. Lowercase
  // FIRST — the stored value is already all-caps, so title-casing it directly
  // would leave "SOME NEW ROLE" and change nothing.
  return (
    ROLE_SHORT[r] ??
    r
      .replace(/_/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (m) => m.toUpperCase())
  );
}

/** Full form for the picker and the confirm dialog. */
export function roleLabel(role: string): string {
  return ROLE_OPTIONS.find((o) => o.value === role)?.label ?? roleShort(role);
}

const DEPARTMENT_ROLE: Record<string, string> = {
  SALES: "SALES",
  FINANCE: "FINANCE",
  PRODUCTION: "PRODUCTION",
  PROCUREMENT: "PROCUREMENT",
  WAREHOUSE: "WAREHOUSE",
  WAREHOUSING: "WAREHOUSE",
  OFFICE: "OFFICE",
  QA: "QA",
  "R&D": "R_AND_D",
  R_AND_D: "R_AND_D",
  RD: "R_AND_D",
  HR: "HR",
  // Owner ruling 2026-08-04: "management 不是跟 superadmin 的吗？" — yes. Shown
  // as a suggestion only; handing out the master key is not something to
  // automate off a department field.
  MANAGEMENT: "SUPER_ADMIN",
};

/** The role this department suggests, or null when it maps to none. */
export function suggestedRoleForDepartment(department: string): string | null {
  return DEPARTMENT_ROLE[(department || "").trim().toUpperCase()] ?? null;
}
