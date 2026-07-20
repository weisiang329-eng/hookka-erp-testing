const MAX_SPECULATIVE_ROUTES = 3;
const TERMINAL_PATHS = [
  "/production/scan",
  "/production/fg-scan",
  "/setup-2fa",
];

const DASHBOARD_BY_ROLE: Record<string, string[]> = {
  SUPER_ADMIN: ["/sales", "/delivery", "/production"],
  ADMIN: ["/sales", "/delivery", "/production"],
  SALES: ["/sales", "/delivery", "/customers"],
  FINANCE: ["/accounting", "/invoices", "/reports"],
  ACCOUNTING: ["/accounting", "/invoices", "/reports"],
  PRODUCTION: ["/production", "/planning", "/inventory"],
  WAREHOUSE: ["/inventory", "/warehouse", "/delivery"],
};

const RELATED_ROUTES: Array<{ prefix: string; routes: string[] }> = [
  { prefix: "/sales", routes: ["/delivery", "/invoices", "/customers"] },
  { prefix: "/delivery", routes: ["/invoices", "/sales", "/customers"] },
  { prefix: "/production", routes: ["/planning", "/inventory"] },
  { prefix: "/planning", routes: ["/production", "/inventory"] },
  { prefix: "/inventory", routes: ["/warehouse", "/procurement"] },
  { prefix: "/warehouse", routes: ["/inventory", "/delivery"] },
  { prefix: "/procurement", routes: ["/inventory", "/invoices/supplier-payments"] },
  { prefix: "/invoices", routes: ["/accounting", "/sales"] },
  { prefix: "/accounting", routes: ["/invoices", "/reports"] },
  { prefix: "/customers", routes: ["/sales", "/delivery"] },
];

function pathOnly(pathname: string): string {
  return pathname.split(/[?#]/, 1)[0] || "/";
}

export function routeKeyForPrefetch(href: string): string {
  return pathOnly(href);
}

function isSameArea(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

/** Pure policy used by the runtime scheduler and regression tests. */
export function buildRoutePrefetchPlan(
  pathname: string,
  role?: string | null,
): string[] {
  const current = pathOnly(pathname);
  if (
    isSameArea(current, "/m") ||
    isSameArea(current, "/worker") ||
    TERMINAL_PATHS.some((path) => isSameArea(current, path))
  ) {
    return [];
  }

  const candidates = current === "/dashboard"
    ? (DASHBOARD_BY_ROLE[role?.toUpperCase() ?? ""] ?? [])
    : (RELATED_ROUTES.find(({ prefix }) => isSameArea(current, prefix))?.routes ?? []);

  return [...new Set(candidates)]
    .filter((route) => !isSameArea(current, route))
    .slice(0, MAX_SPECULATIVE_ROUTES);
}
