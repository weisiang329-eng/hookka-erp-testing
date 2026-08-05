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

/**
 * MODULE-LEVEL for now, by instruction.
 *
 * Owner 2026-08-04: "这个 RBAC 你暂时不需要去理它是可以 view 还是 edit 还是等等
 * 的，只需要开放那个 module 给它先。开放的意思就是它既可以 edit 也可以 view，
 * 可以做所有的操作."
 *
 * So a role either HAS a module or does not, and having it means full access.
 * The finer spec that came earlier — SALES reading Sales Orders but not editing
 * them, consignment being read-plus-create, price being read-only — is NOT lost:
 * it is recorded per line below as a trailing `was: read` note, so tightening
 * later is a one-line change per resource rather than a re-interview.
 *
 * The one distinction kept is `users`, because it is not a display choice: a
 * wildcard there includes `role-change`, which lets a role promote its own
 * holder and quietly undoes every other line in this file.
 */
const OPEN = ["*"];
const R = ["read"];

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
  "products", "product-configs", "sofa-combos", "rd-projects", "cnc-templates",
  // Two figures that travel WITH other data rather than on a page of their own,
  // so they need a gate of their own or they ride in on whoever can read the
  // page. Owner 2026-08-05: "我们卖价不需要给他们知道，我们只需要给他们看到成本
  // 就可以" (R&D) and "HR… 我们只需要保留着人工成本".
  // The Command Center and the Hookka (daily) Report. Owner 2026-08-05:
  // "office need dashboard … and hookka report". They used to ride on
  // `accounting`, which is why opening them to Office was impossible without
  // opening Finance with them — the one thing Office is explicitly not to see.
  // Not listed in FINANCE_RESOURCES, so allExcept() grants it to Office and
  // the roles with hand-written lists (Sales, QA, HR, R&D) still do not get it.
  "dashboard",
  "product-pricing",   // selling price, margin, surcharge amounts
  "revenue-figures",   // revenue / remain on the labour report
  "agent-console",     // read the Agent Console (which agents, see AGENTS_BY_ROLE)
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
  announcements: OPEN,
  "mail-center": OPEN,
  notifications: OPEN,
  settings: OPEN,
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
  // (1) the documents. Full access for now — the spec was read-only, kept here
  // so it can be tightened without asking again.
  "sales-orders": OPEN, // was: read
  "delivery-orders": OPEN, // was: read
  "delivery-returns": OPEN, // was: read
  invoices: OPEN, // was: read
  consignments: OPEN, // was: read + create
  "consignment-notes": OPEN, // was: read + create

  // (2) the customer module is theirs end to end.
  customers: OPEN,
  "sales-pipeline": OPEN,
  "customer-products": OPEN, // Assign SKU
  quotations: OPEN, // Export Quotation
  "customer-hubs": OPEN, // 开 HUB
  "sofa-combos": OPEN, // 设 Sofa Combo / 加钱
  "product-pricing": OPEN, // 加钱 / quotations — Sales works in selling price
  "agent-console": OPEN, // Sales / Quotation Agent — see AGENTS_BY_ROLE
  "promise-date": OPEN,
  "historical-sales": OPEN,

  // (3) production & planning.
  "production-orders": OPEN, // was: read
  "job-cards": OPEN, // was: read
  scheduling: OPEN, // was: read

  // (4) products — SKU master, catalogue, maintenance.
  products: OPEN, // was: read
  "price-history": OPEN, // was: read

  // (5) Quality, so an unfamiliar case is not a dead end.
  "qc-inspections": OPEN, // was: read
  "service-cases": OPEN, // was: read
  "service-orders": OPEN, // was: read
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
  // Quality.
  "qc-inspections": OPEN,
  "service-cases": OPEN,
  "service-orders": OPEN,
  // Procurement — a failed inspection becomes a purchase return.
  "purchase-orders": OPEN,
  "purchase-returns": OPEN,
  grn: OPEN,
  "purchase-invoices": OPEN,
  mrp: OPEN,
  suppliers: OPEN,
  "supplier-materials": OPEN,
  "supplier-scorecards": OPEN,
  "goods-in-transit": OPEN,
  // Enough context to know what was being made when a defect appeared.
  "production-orders": OPEN,
  "job-cards": OPEN,
  products: OPEN,
  // Kept explicitly: QA reached the CNC templates through `products` before it
  // got a gate of its own, and taking it away was never the point — only Sales
  // was to lose it (owner 2026-08-05).
  "cnc-templates": OPEN,
  // Held explicitly for the same reason as cnc-templates: QA saw prices through
  // `products` before that split off, and only R&D was to lose them.
  "product-pricing": OPEN,
  "agent-console": OPEN,
  "fg-units": OPEN,
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
  "rd-projects": OPEN,
  // products WITHOUT `product-pricing` — the catalogue, the BOM and the cost
  // side, but not what it sells for. Owner 2026-08-05.
  products: OPEN,
  // Same as QA — product development is exactly who the cutting templates are
  // for. Only Sales loses them.
  "cnc-templates": OPEN,
  "product-configs": OPEN,
  bom: OPEN,
  "bom-master-templates": OPEN,
  // Sofa Combos removed 2026-08-05 ("把 IMD 的 sofa compartment remove 掉") —
  // it is a per-customer PRICE list, which is the same thing being withheld
  // via product-pricing below.
  fabrics: OPEN, // sits under Warehouse in the sidebar; see note above
  // "R&D Maintenance".
  equipment: OPEN,
  "maintenance-logs": OPEN,
  // Quality is explicitly allowed.
  "qc-inspections": OPEN,
  "service-cases": OPEN,
  "service-orders": OPEN,
  // Enough production visibility to see how a design is actually built.
  "production-orders": OPEN,
  "job-cards": OPEN,
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
  "agent-console": OPEN, // Employee Agent — see AGENTS_BY_ROLE
  workers: OPEN,
  attendance: OPEN,
  leaves: OPEN,
  payroll: OPEN,
  payslips: OPEN,
  departments: OPEN,
  // Sees who has an account; opening or disabling one is requireSuperAdmin, and
  // `role-change` is never granted to anyone — see NEVER_WILDCARD.
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


// ---------------------------------------------------------------------------
// Agent Console — who sees which agents.
//
// Owner 2026-08-05: "Agent Console 每一个人都会有，但他们只会看到自己相关的
// Agent… 大家只需要看到自己专属的 Agent 就可以了."
//
//   • QA     → Service Agent
//   • Office → Delivery Agent, Production Agent, Customer Service Agent
//   • HR     → Employee Agent
//
// READING the console is what this opens up. The controls — run now, pause,
// kill all, rollback, approve — stay SUPER_ADMIN, because "see your own agent"
// is not the same request as "let everyone stop the factory's automation".
//
// A role absent from this map sees no agents; the link is hidden rather than
// opening an empty console. Sales and R&D are in that position today — the
// owner listed three roles and there are agents named SALES and DATA_QUALITY
// going spare, so this is worth a second look, but guessing an assignment is
// how someone ends up reading a digest that was never meant for them.
// ---------------------------------------------------------------------------
export const AGENTS_BY_ROLE: Record<string, string[]> = {
  QA: ["SERVICE"],
  OFFICE: ["DELIVERY", "PRODUCTION", "CS"],
  HR: ["EMPLOYEE"],
  // Added 2026-08-05. The Sales agent's job — OCR a customer PO into a sales
  // order draft, put engine-backed promise dates in quotes, intercept price
  // anomalies — IS the sales desk's job, so this is reading the roster rather
  // than inventing a responsibility.
  SALES: ["SALES"],
  // R&D deliberately absent: there is no R&D agent in the roster, and handing
  // them DATA_QUALITY would be making one up. Revisit when one exists.
};

/** Agent ids this role may see. `null` means every agent (super admin / admin). */
export function agentsForRole(role: string): string[] | null {
  const r = (role || "").trim().toUpperCase();
  if (r === "SUPER_ADMIN" || r === "ADMIN") return null;
  return AGENTS_BY_ROLE[r] ?? [];
}
