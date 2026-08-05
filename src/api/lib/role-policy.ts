// ---------------------------------------------------------------------------
// role-policy.ts — what each role may do, written as CODE.
//
// Owner 2026-08-04: "我全部不要用这种正常的渠道，我要用 backend 直接写出来的。
// 因为你用这种设定有一些比较 tricky 一点，比较麻烦做，所以你全部用 backend 帮我写."
//
// The right call, and for a concrete reason. Expressing these rules through
// `role_permissions` rows would have needed a pile of plumbing first: six
// modules the owner named have NO permission resource at all (mail-center and
// quotations are not gated in any way; announcements IS gated but its resource
// was never seeded, so every non-admin role is silently denied), and Delivery
// Return / Service Cases share the delivery-orders and service-orders
// resources, so "DO read-only but Delivery Return editable" is not expressible
// as data. In code a resource name costs nothing to introduce.
//
// The GATE is unchanged. `requirePermission` still guards every route; this
// only changes where the permission set comes from for the roles listed here.
// Anything not listed falls through to the database exactly as before, so the
// 0045-seeded roles keep working untouched.
//
// Not expressible here, and deliberately so: "只能看到自己顾客的单据". That is a
// row filter, not a permission — see `scopeToOwnCustomers` in
// `src/api/lib/row-scope.ts` for that half.
// ---------------------------------------------------------------------------

/** Every action a resource can carry. `*` means all of them. */
type Actions = string[];
export type RolePolicy = Record<string, Actions>;

const R = ["read"];
const RC = ["read", "create"];
const RCU = ["read", "create", "update"];
const RW = ["read", "create", "update", "delete"];

/**
 * Modules that are money.
 *
 * Owner 2026-08-04, on Office and QA: "他们什么都可以看到，都可以操作，就是不能
 * 看到我们的 finance 还有 forecasting." This is that list — the Finance and
 * Forecasting sections of the sidebar, resolved to resources.
 */
export const FINANCE_RESOURCES = [
  "accounting",
  "invoices",
  "payments",
  "credit-notes",
  "debit-notes",
  "e-invoices",
  "cost-ledger",
  "cash-flow",
  "stock-value",
];
export const FORECAST_RESOURCES = ["forecasts"];

/**
 * Every resource in the system, including the six that have no permission row.
 *
 * Listed here rather than read from the table precisely because the table is
 * missing them — that gap is what made the owner's spec inexpressible.
 */
export const ALL_RESOURCES = [
  // Sales & Customers
  "sales-orders", "delivery-orders", "delivery-returns", "invoices",
  "consignments", "consignment-notes", "customers", "customer-hubs",
  "customer-products", "sales-pipeline", "quotations", "promise-date",
  "historical-sales", "price-history",
  // Procurement
  "purchase-orders", "purchase-returns", "purchase-invoices", "suppliers", "supplier-materials",
  "supplier-scorecards", "grn", "goods-in-transit", "three-way-match", "mrp",
  // Production
  "production-orders", "job-cards", "scheduling", "bom", "bom-master-templates",
  "production-leadtimes",
  // Quality
  "qc-inspections", "service-cases", "service-orders",
  // Warehouse
  "inventory", "raw-materials", "rm-batches", "fg-units", "stock-movements",
  "stock-accounts", "stock-value", "warehouse", "fabric-tracking", "fabrics",
  // Finance
  "accounting", "payments", "credit-notes", "debit-notes", "e-invoices",
  "cost-ledger", "cash-flow",
  // Forecasting
  "forecasts",
  // Products & master data
  "products", "product-configs", "sofa-combos", "rd-projects",
  "equipment", "maintenance-logs", "lorries", "drivers", "departments",
  "organisations",
  // People
  "workers", "attendance", "leaves", "payroll", "payslips",
  // Comms & system
  "announcements", "mail-center", "notifications", "settings", "users",
];

/**
 * Everything except the named resources, at full CRUD.
 *
 * `users` is ALWAYS held back, whatever the caller passes. A wildcard on it
 * includes `role-change`, so a broad role would be able to promote its own
 * holder — which quietly undoes every other line drawn in this file. A role
 * that genuinely needs it lists `users` explicitly, at the actions it needs.
 * (Caught by the test, not by review: the first cut of OFFICE had it.)
 */
const NEVER_WILDCARD = ["users"];

function allExcept(excluded: string[]): RolePolicy {
  const out: RolePolicy = {};
  const skip = new Set([...excluded, ...NEVER_WILDCARD]);
  for (const res of ALL_RESOURCES) {
    if (skip.has(res)) continue;
    out[res] = ["*"];
  }
  return out;
}

/**
 * What EVERY role gets, regardless of department.
 *
 * Owner 2026-08-04: "我们的 News Center、Announcement、Announcement Notification
 * 这三个是全部人都有的，还有『设置』也是全部人都有的."
 *
 * Kept as one base and merged into every policy below, so "everyone gets this"
 * is stated once. Repeating it per role is how the copies drift — and one of
 * them silently loses announcements, which is exactly the failure already
 * sitting in prod (the `announcements` resource was gated but never seeded, so
 * every non-admin role is denied today).
 *
 * `settings` here is the personal settings page — NOT User Management,
 * Organisations, System Health or Agent Console, which stay administrative.
 */
const EVERYONE: RolePolicy = {
  announcements: R,
  "mail-center": R,
  notifications: R,
  settings: R,
};

/** A role's own grants on top of the shared base. */
function withBase(policy: RolePolicy): RolePolicy {
  return { ...EVERYONE, ...policy };
}

/**
 * SALES — owner spec 2026-08-04.
 *
 * The shape is unusual and worth stating plainly: a salesperson READS the
 * documents (SO / DO / Delivery Return / Invoice) and OWNS the customer. They
 * do not edit orders — those are produced by the office — but everything about
 * the customer relationship is theirs, including creating one.
 *
 * Consignment is the single exception: read-only, EXCEPT they may raise one
 * ("可以开单，只是不能编辑").
 */
const SALES: RolePolicy = {
  // (1a) documents — read only, and only their own customers' (row filter).
  "sales-orders": R,
  "delivery-orders": R,
  "delivery-returns": R,
  invoices: R,
  // (1b) consignment — read, but may raise one.
  consignments: RC,
  "consignment-notes": RC,

  // (2) the customer module is theirs end to end.
  customers: RW,
  "sales-pipeline": ["*"],
  "customer-products": RW, // Assign SKU
  quotations: ["*"], // Export Quotation
  "customer-hubs": RW, // 开 HUB
  "sofa-combos": RW, // 设 Sofa Combo / 加钱
  "promise-date": RCU,
  "historical-sales": R,

  // (3) production & planning — look, don't touch.
  "production-orders": R,
  "job-cards": R,
  scheduling: R,

  // (4) products — SKU master, catalogue, maintenance. Price is READ ONLY.
  products: R,
  "price-history": R,

  // (5a) Quality, so an unfamiliar case is not a dead end.
  "qc-inspections": R,
  "service-cases": R,
  "service-orders": R,

  // (5b) announcements / notifications come from EVERYONE below.
};

/**
 * OFFICE and QA — "什么都可以看到，都可以操作，就是不能看到 finance 还有
 * forecasting".
 *
 * Broad by instruction. In a 12-person factory people cover several functions,
 * and a role that blocks the work they actually do just gets escalated back to
 * ADMIN — which is how everyone ended up on `*:*` in the first place. The line
 * that IS held is the one the owner drew: money.
 */
const OFFICE: RolePolicy = {
  ...allExcept([...FINANCE_RESOURCES, ...FORECAST_RESOURCES]),
  // Sees the directory; opening or promoting an account stays SUPER_ADMIN.
  users: R,
};

/**
 * QA — owner correction 2026-08-04: "我们的 QA 只可以看到 Quality 还有
 * Procurement."
 *
 * Narrower than the first draft, which read the Office rule as covering QA too.
 * Two sidebar sections and nothing else: Quality (QC, service cases, service
 * orders) and Procurement (PO, goods receipt, purchase invoice, purchase
 * return, MRP, suppliers).
 *
 * Quality is where QA WRITES; Procurement it can operate, since a rejected
 * delivery is raised and returned from there.
 */
const QA: RolePolicy = {
  // Quality — the work itself.
  "qc-inspections": ["*"],
  "service-cases": RCU,
  "service-orders": RCU,
  // Procurement — a failed inspection becomes a purchase return.
  "purchase-orders": RCU,
  "purchase-returns": ["*"],
  grn: RCU,
  "purchase-invoices": R,
  mrp: R,
  suppliers: RCU,
  "supplier-materials": R,
  "supplier-scorecards": RCU,
  "goods-in-transit": R,
  // Enough context to know what was being made when a defect appeared.
  "production-orders": R,
  "job-cards": R,
  products: R,
  "fg-units": R,
};

/**
 * R&D — owner spec: everything in the Finance / Forecasting / HR & Operations /
 * System / Procurement / Warehouse / Sales screenshots is OFF; Quality and R&D
 * are ON.
 *
 * One deliberate exception to that reading: `fabrics` sits under the Warehouse
 * section of the sidebar, but product development cannot specify a sofa without
 * it. Flagged to the owner rather than assumed silently — the rest of Warehouse
 * (inventory, stock value, adjustments) stays off.
 */
const R_AND_D: RolePolicy = {
  "rd-projects": ["*"],
  products: RW,
  "product-configs": RW,
  bom: RW,
  "bom-master-templates": RW,
  "sofa-combos": RW,
  fabrics: RW, // see note above
  // "R&D Maintenance" in the sidebar.
  equipment: RW,
  "maintenance-logs": RW,
  // Quality is explicitly allowed.
  "qc-inspections": R,
  "service-cases": R,
  "service-orders": R,
  // Enough production visibility to see how a design is actually built.
  "production-orders": R,
  "job-cards": R,
};

/**
 * HR — owner correction 2026-08-04: "HR 只看这个也基础的例如 notification",
 * pointing at the HR & Operations section: Employees and Maintenance.
 *
 * The narrowest of the department roles, and deliberately so: HR handles pay,
 * which means HR must not also be able to read what the company earns. Today
 * this person is on ADMIN and can see every margin in the business.
 *
 * "Maintenance" under HR & Operations is read as the HR master data that sits
 * behind Employees — departments and the like — NOT equipment maintenance,
 * which belongs to QA and R&D. Flagged rather than assumed.
 */
const HR: RolePolicy = {
  workers: ["*"],
  attendance: ["*"],
  leaves: ["*"],
  payroll: ["*"],
  payslips: ["*"],
  departments: R,
  // Sees who has an account; opening or disabling one is requireSuperAdmin.
  users: R,
};

/**
 * Roles whose permission set is defined HERE rather than in `role_permissions`.
 *
 * A role absent from this map falls through to the database untouched, so the
 * 0045-seeded roles (SUPER_ADMIN, FINANCE, PROCUREMENT, PRODUCTION, WAREHOUSE,
 * READ_ONLY, WORKER) behave exactly as before.
 */
export const CODE_ROLE_POLICIES: Record<string, RolePolicy> = {
  SALES: withBase(SALES),
  OFFICE: withBase(OFFICE),
  QA: withBase(QA),
  R_AND_D: withBase(R_AND_D),
  HR: withBase(HR),
};

/** Is this role's permission set defined in code? */
export function isCodeRole(role: string): boolean {
  return Object.hasOwn(CODE_ROLE_POLICIES, (role || "").toUpperCase());
}

/**
 * The `resource:action` strings a code-defined role holds.
 *
 * `["*"]` on a resource expands to `resource:*`, which the wildcard matcher in
 * rbac.ts already understands — so a new action added to a route later is
 * covered without editing this file.
 */
export function permissionsForRole(role: string): Set<string> | null {
  const policy = CODE_ROLE_POLICIES[(role || "").toUpperCase()];
  if (!policy) return null;
  const out = new Set<string>();
  for (const [resource, actions] of Object.entries(policy)) {
    for (const a of actions) out.add(`${resource}:${a}`);
  }
  return out;
}
