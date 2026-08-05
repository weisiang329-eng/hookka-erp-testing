// ---------------------------------------------------------------------------
// nav-permissions.ts — which resource each menu link belongs to.
//
// Owner 2026-08-05: "全部生效了吗？因为我看到还有很多东西，好像和我们之前看的是
// 一样的."
//
// It HAD taken effect — on the API. The sidebar was the half that had not. It
// carried a hand-written list of NINE links, all Finance, and defaulted the
// other eighty-four to visible:
//
//     const req = NAV_PERMISSION_REQUIREMENTS[href];
//     if (!req) return true;          // everything else, always shown
//
// So a salesperson still saw Payroll, Procurement, Warehouse and R&D in the
// menu and only found out on click. That is worse than no filtering: it teaches
// people that the app throws errors at random, and it makes a permission change
// look like it did nothing.
//
// Keyed by PATH PREFIX, longest match wins, so a sub-page inherits its section
// without being listed. `/inventory/fabrics` resolves to `fabrics` rather than
// `inventory` purely because it is the longer key.
//
// A link with NO entry stays visible. That is deliberate: the dashboard, the
// daily report and anything added tomorrow should not vanish because nobody
// remembered to map it. Hiding by omission is how a menu quietly loses a page.
// ---------------------------------------------------------------------------

/** Path prefix → the resource that guards it. Longest prefix wins. */
export const NAV_RESOURCE: Record<string, string> = {
  // Owner 2026-08-05: "Dashboard、VUCA report，除了 Management、Super Admin
  // 可以看到，其他人都看不到." Both surface company-wide revenue, margin and
  // plant load on one screen — the numbers every department role is otherwise
  // kept away from. Mapped to `accounting`, which only Finance-side roles and
  // SUPER_ADMIN hold, so the command centre cannot leak past them.
  "/dashboard": "accounting",
  "/daily-report": "accounting",

  // Comms — everyone has these, but map them so a future role could not.
  "/notifications": "notifications",
  "/announcements": "announcements",
  "/mail-center": "mail-center",

  // Sales & customers. `/delivery-returns` must resolve on its own and not be
  // swallowed by `/delivery` — longest-match handles it.
  "/sales": "sales-orders",
  "/delivery-returns": "delivery-returns",
  "/delivery": "delivery-orders",
  "/invoices/credit-notes": "credit-notes",
  "/invoices/debit-notes": "debit-notes",
  "/invoices/supplier-payments": "payments",
  "/invoices/payments": "payments",
  "/invoices/e-invoice": "e-invoices",
  "/invoices": "invoices",
  "/consignment/note": "consignment-notes",
  "/consignment": "consignments",
  "/customers": "customers",
  "/leads": "sales-pipeline",

  // Production & planning.
  "/production": "production-orders",
  "/planning/mrp": "mrp",
  "/planning": "scheduling",

  // Products & BOM.
  "/products": "products",
  "/cnc-templates": "products",
  "/bom": "bom",
  "/maintenance/sofa-combos": "sofa-combos",

  // Warehouse.
  "/inventory/fabrics": "fabrics",
  "/inventory/stock-value": "stock-value",
  "/inventory/adjustments": "stock-movements",
  "/inventory": "inventory",
  "/warehouse": "warehouse",

  // Procurement.
  "/procurement/grn": "grn",
  "/procurement/pi": "purchase-invoices",
  "/procurement/maintenance": "suppliers",
  "/procurement": "purchase-orders",
  "/purchase-returns": "purchase-returns",

  // R&D and Quality.
  "/rd": "rd-projects",
  "/quality": "qc-inspections",
  "/service-cases": "service-cases",
  "/service-order": "service-orders",

  // Finance — every `/accounting?tab=…` view shares one resource.
  "/accounting": "accounting",

  // Forecasting.
  "/finance-dashboard": "forecasts",
  "/forecast": "forecasts",

  // HR & operations. `/maintenance/sofa-combos` is longer, so it still wins.
  "/employees": "workers",
  "/maintenance": "equipment",

  // System.
  "/settings/organisations": "organisations",
  "/settings": "settings",
};

const PREFIXES = Object.keys(NAV_RESOURCE).sort((a, b) => b.length - a.length);

/**
 * The resource guarding a menu link, or null when it is ungated.
 *
 * Query strings are ignored — the Finance section is thirty `?tab=` views over
 * one page and one resource.
 */
export function resourceForNav(href: string): string | null {
  const path = (href || "").split("?")[0];
  if (!path) return null;
  for (const p of PREFIXES) {
    if (path === p || path.startsWith(`${p}/`)) return NAV_RESOURCE[p];
  }
  return null;
}

/**
 * The path prefixes this permission set may NOT see.
 *
 * Computed on the SERVER and handed to the client, at the owner's instruction:
 * "我不要用 frontend loading 等等的，直接从 backend 就挡掉嘛." The browser then
 * hides a link without knowing which resource guards it — the mapping never
 * leaves this file, so it cannot drift from the gate that enforces it.
 *
 * Returns the DENIED list rather than the allowed one on purpose: a link with
 * no mapping is absent from both, and the client's rule becomes "hide what I
 * was told to hide". An allow-list would make every unmapped link vanish.
 */
export function hiddenNavPrefixes(perms: ReadonlySet<string>): string[] {
  if (perms.has("*") || perms.has("*:*")) return [];
  const out: string[] = [];
  for (const [prefix, resource] of Object.entries(NAV_RESOURCE)) {
    if (perms.has(`${resource}:read`) || perms.has(`${resource}:*`)) continue;
    out.push(prefix);
  }
  return out.sort();
}

/**
 * Where to send this user after login.
 *
 * `/dashboard` is the default landing page and is NOT route-guarded, so hiding
 * it from the menu is not enough on its own: a salesperson would still land
 * there, on a screen absent from their own navigation whose every figure comes
 * back 403. Landing somewhere useful is part of restricting it, not a separate
 * nicety.
 *
 * Ordered by how central each surface is to the person's day, and computed
 * server-side so it cannot disagree with what the menu shows.
 */
const HOME_PREFERENCE = [
  "/dashboard",
  "/sales",
  "/procurement",
  "/production",
  "/quality",
  "/rd",
  "/employees",
  "/inventory",
  "/accounting",
  "/mail-center",
];

/**
 * The page a role actually works in, checked before the generic order.
 *
 * A global preference list gets this wrong in a way that looks arbitrary: R&D
 * can read production, so it would land on the production board rather than its
 * own projects, and QA would open on Purchase Orders instead of QC. The role
 * knows its own front door.
 */
const ROLE_HOME: Record<string, string> = {
  SALES: "/sales",
  OFFICE: "/procurement",
  QA: "/quality",
  R_AND_D: "/rd",
  HR: "/employees",
  FINANCE: "/accounting",
  PROCUREMENT: "/procurement",
  PRODUCTION: "/production",
  WAREHOUSE: "/inventory",
};

export function homeForPermissions(
  perms: ReadonlySet<string>,
  role?: string,
): string {
  const hidden = new Set(hiddenNavPrefixes(perms));
  const preferred = ROLE_HOME[(role ?? "").toUpperCase()];
  if (preferred && !hidden.has(preferred)) return preferred;
  for (const p of HOME_PREFERENCE) {
    if (!hidden.has(p)) return p;
  }
  // Everyone has Settings, so there is always somewhere to land.
  return "/settings";
}
