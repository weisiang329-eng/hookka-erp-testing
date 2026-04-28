import { Link, useLocation } from "react-router-dom";
import { useState, useEffect, useCallback } from "react";
import { useInterval } from "@/lib/scheduler";
import {
  Activity,
  LayoutDashboard,
  ShoppingCart,
  Factory,
  Boxes,
  Truck,
  Users,
  ShieldCheck,
  Warehouse,
  Settings,
  ChevronLeft,
  ChevronRight,
  BarChart3,
  Wrench,
  Bell,
  FileText,
  BookOpen,
  Calendar,
  Building2,
  ChevronDown,
  Check,
  Layers,
  FileCheck,
  QrCode,
  Wallet,
  Calculator,
  Package,
  Ship,
  TrendingUp,
  Lightbulb,
  ClipboardList,
  FileX,
  FilePlus,
  CreditCard,
  Shirt,
  Route,
  DollarSign,
  Scale,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth";
import { usePermissions } from "@/lib/use-permission";

interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  badge?: number;
  children?: NavItem[];
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const navigationGroups: NavGroup[] = [
  {
    label: "OVERVIEW",
    items: [
      { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      { name: "Notifications", href: "/notifications", icon: Bell },
      { name: "Forecasting", href: "/analytics/forecast", icon: TrendingUp },
    ],
  },
  {
    label: "SALES & CUSTOMERS",
    items: [
      { name: "Sales Orders", href: "/sales", icon: ShoppingCart },
      { name: "Delivery Order", href: "/delivery", icon: Truck },
      { name: "Invoices", href: "/invoices", icon: FileText },
      { name: "Consignment", href: "/consignment", icon: Package, children: [
        { name: "Consignment Order", href: "/consignment", icon: Package },
        { name: "Consignment Note", href: "/consignment/note", icon: ClipboardList },
        { name: "Consignment Return", href: "/consignment/return", icon: Ship },
      ]},
      { name: "Customers", href: "/customers", icon: Users },
    ],
  },
  {
    label: "PRODUCTION",
    items: [
      // Production is now an expandable parent: Overview (the matrix that
      // used to be the sole /production page) + one child per department.
      // Each dept page fetches ONLY its own JCs via ?dept=CODE, so the
      // payload drops ~8× vs. the old monolithic page.
      { name: "Production", href: "/production", icon: Factory, children: [
        { name: "Overview", href: "/production", icon: Layers },
        { name: "Fab Cut", href: "/production/fab-cut", icon: Shirt },
        { name: "Fab Sew", href: "/production/fab-sew", icon: Shirt },
        { name: "Foam", href: "/production/foam", icon: Package },
        { name: "Wood Cut", href: "/production/wood-cut", icon: Wrench },
        { name: "Framing", href: "/production/framing", icon: Wrench },
        { name: "Webbing", href: "/production/webbing", icon: Wrench },
        { name: "Upholstery", href: "/production/upholstery", icon: Shirt },
        { name: "Packing", href: "/production/packing", icon: Package },
      ]},
      { name: "Planning", href: "/planning", icon: Calendar },
      { name: "Scanner", href: "/production/scan", icon: QrCode },
    ],
  },
  {
    label: "PRODUCTS & BOM",
    items: [
      { name: "Products", href: "/products", icon: Boxes },
      { name: "BOM", href: "/bom", icon: Layers },
    ],
  },
  {
    label: "WAREHOUSE",
    items: [
      { name: "Inventory", href: "/inventory", icon: Package },
      { name: "Fabrics", href: "/inventory/fabrics", icon: Shirt },
      { name: "Stock Value", href: "/inventory/stock-value", icon: Calculator },
      { name: "Stock Adjustments", href: "/inventory/adjustments", icon: Scale },
      { name: "Warehouse", href: "/warehouse", icon: Warehouse },
    ],
  },
  {
    label: "PROCUREMENT",
    items: [
      { name: "Purchase Order", href: "/procurement", icon: ShoppingCart },
      { name: "In Transit", href: "/procurement/in-transit", icon: Route },
      { name: "GRN", href: "/procurement/grn", icon: ClipboardList },
      { name: "Purchase Invoice", href: "/procurement/pi", icon: CreditCard },
      { name: "Pricing", href: "/procurement/pricing", icon: DollarSign },
      { name: "MRP", href: "/planning/mrp", icon: Layers },
      { name: "Maintenance", href: "/procurement/maintenance", icon: Wrench },
    ],
  },
  {
    label: "R&D",
    items: [
      { name: "R&D Projects", href: "/rd", icon: Lightbulb },
    ],
  },
  {
    label: "QUALITY",
    items: [
      { name: "QC / Quality", href: "/quality", icon: ShieldCheck },
    ],
  },
  {
    label: "FINANCE",
    items: [
      { name: "Accounting", href: "/accounting", icon: BookOpen },
      { name: "Cash Flow", href: "/accounting/cash-flow", icon: Wallet },
      { name: "Credit Notes", href: "/invoices/credit-notes", icon: FileX },
      { name: "Debit Notes", href: "/invoices/debit-notes", icon: FilePlus },
      { name: "Payments", href: "/invoices/payments", icon: CreditCard },
      { name: "e-Invoice", href: "/invoices/e-invoice", icon: FileCheck },
      { name: "Reports", href: "/reports", icon: BarChart3 },
    ],
  },
  {
    label: "HR & OPERATIONS",
    items: [
      { name: "Employees", href: "/employees", icon: Users },
      { name: "Maintenance", href: "/maintenance", icon: Wrench },
    ],
  },
  {
    label: "SYSTEM",
    items: [
      { name: "Organisations", href: "/settings/organisations", icon: Building2 },
      // "User Management" is injected below (SUPER_ADMIN only) at render time
      { name: "Settings", href: "/settings", icon: Settings },
    ],
  },
];

// Admin-only extra links inserted into the SYSTEM group at render time.
// Order: User Management first (admin's most common task), then System
// Health (P6.4 — KPI dashboard). Both gate on role === SUPER_ADMIN both
// in the route guard (RequireRole) and in the API.
const SUPER_ADMIN_LINK: NavItem = {
  name: "User Management",
  href: "/settings/users",
  icon: Users,
};
const SUPER_ADMIN_HEALTH_LINK: NavItem = {
  name: "System Health",
  href: "/admin/health",
  icon: Activity,
};

type OrgInfo = {
  id: string;
  code: string;
  name: string;
};

type NotificationsResponse = { notifications?: Array<{ isRead?: boolean }> };
type OrganisationsResponse = { organisations?: OrgInfo[]; activeOrgId?: string };

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

export function Sidebar() {
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  // Auto-expand only the menu group matching the current route. Per user
  // 2026-04-28: Consignment was hard-coded to always-open which made the
  // sidebar feel cluttered when the user was working in another module.
  // Now the rule is uniform: expand Consignment only when on /consignment,
  // expand Production only when on /production, otherwise everything
  // starts collapsed.
  const [expandedMenus, setExpandedMenus] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (typeof window !== "undefined") {
      const path = window.location.pathname;
      if (path.startsWith("/production")) initial.add("Production");
      if (path.startsWith("/consignment")) initial.add("Consignment");
    }
    return initial;
  });
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [unreadCount, setUnreadCount] = useState(0);
  const [orgs, setOrgs] = useState<OrgInfo[]>([]);
  const [activeOrgId, setActiveOrgId] = useState("");
  const [orgDropdownOpen, setOrgDropdownOpen] = useState(false);

  // Load collapsed groups from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem("sidebar-collapsed-groups");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot localStorage rehydrate on mount; pre-existing pattern, separate cleanup task
      if (saved) setCollapsedGroups(new Set(JSON.parse(saved)));
    } catch { /* ignore */ }
  }, []);

  const toggleGroup = (label: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      try { localStorage.setItem("sidebar-collapsed-groups", JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  const fetchOrgs = useCallback(async () => {
    try {
      const res = await fetch("/api/organisations");
      if (!res.ok) return;
      const data = (await res.json()) as unknown;
      const obj = asObj(data) as OrganisationsResponse | null;
      setOrgs(
        (obj?.organisations ?? []).map((o: OrgInfo) => ({
          id: o.id,
          code: o.code,
          name: o.name,
        }))
      );
      setActiveOrgId(obj?.activeOrgId ?? "");
    } catch {
      // silently ignore
    }
  }, []);

  const switchOrg = useCallback(async (orgId: string) => {
    try {
      await fetch("/api/organisations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId }),
      });
      setOrgDropdownOpen(false);
      window.location.reload();
    } catch {
      // silently ignore
    }
  }, []);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications");
      if (!res.ok) return;
      const data = (await res.json()) as unknown;
      const obj = asObj(data) as NotificationsResponse | null;
      const notifications = Array.isArray(data)
        ? (data as Array<{ isRead?: boolean }>)
        : (obj?.notifications ?? []);
      const count = notifications.filter(
        (n: { isRead?: boolean }) => n.isRead === false
      ).length;
      setUnreadCount(count);
    } catch {
      // silently ignore fetch errors
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount; pre-existing pattern, separate cleanup task
    fetchOrgs();
    fetchUnreadCount();
  }, [fetchOrgs, fetchUnreadCount]);

  // Poll the unread-notifications count once a minute. useInterval pauses when
  // the tab is hidden (saves a request/min on idle pinned tabs) and clears on
  // unmount automatically.
  useInterval(() => {
    fetchUnreadCount();
  }, 60_000);

  // P3.6 — load the current user's permission set so we can hide nav links
  // that would otherwise lead to a redirect or 403. SUPER_ADMIN gets ["*"]
  // from the backend so hasPermission always returns true for them.
  const { hasPermission: canDo } = usePermissions();

  // Routes that are gated by RequirePermission in dashboard-routes.tsx — keep
  // this list in sync with the wrappers there. If we don't list a route here
  // it stays visible by default (matches the current behavior for any link).
  const NAV_PERMISSION_REQUIREMENTS: Record<
    string,
    { resource: string; action: string }
  > = {
    "/accounting": { resource: "accounting", action: "read" },
    "/accounting/cash-flow": { resource: "accounting", action: "read" },
    "/invoices": { resource: "invoices", action: "read" },
    "/invoices/credit-notes": { resource: "invoices", action: "read" },
    "/invoices/debit-notes": { resource: "invoices", action: "read" },
    "/invoices/payments": { resource: "invoices", action: "read" },
    "/invoices/e-invoice": { resource: "invoices", action: "read" },
  };
  const isNavItemAllowed = (href: string): boolean => {
    const req = NAV_PERMISSION_REQUIREMENTS[href];
    if (!req) return true;
    return canDo(req.resource, req.action);
  };

  // Inject badge counts into the Notifications item, and the
  // SUPER_ADMIN-only User Management link into the SYSTEM group.
  const authUser = getCurrentUser();
  const isSuperAdmin = authUser?.role === "SUPER_ADMIN";
  // If localStorage is empty mid-boot, fall back to "—" / blank rather than
  // inventing a placeholder name — never show a stale demo user like the old
  // "Lim / Director" hardcode (P3.7).
  const displayName = authUser?.displayName || authUser?.email || "—";
  const roleLabel = authUser?.role
    ? authUser.role
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase())
    : "—";
  const initials =
    (authUser
      ? displayName
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((s) => s[0]?.toUpperCase() ?? "")
          .join("")
      : "") || "—";
  const groupsWithBadge = navigationGroups.map((group) => {
    let items = group.items.map((item) => {
      if (item.name === "Notifications") return { ...item, badge: unreadCount };
      return item;
    });
    if (group.label === "SYSTEM" && isSuperAdmin) {
      // Insert "User Management" + "System Health" just before the
      // trailing "Settings" entry. Order matters: admin tasks (manage
      // users, view health) sit above the catch-all Settings link.
      const idx = items.findIndex((i) => i.name === "Settings");
      const insertAt = idx === -1 ? items.length : idx;
      items = [
        ...items.slice(0, insertAt),
        SUPER_ADMIN_LINK,
        SUPER_ADMIN_HEALTH_LINK,
        ...items.slice(insertAt),
      ];
    }
    // P3.6 — filter out nav items the current user can't access. Anything
    // not in NAV_PERMISSION_REQUIREMENTS stays visible (default-allow for
    // links the gating doesn't cover yet).
    items = items.filter((item) => isNavItemAllowed(item.href));
    return { ...group, items };
  });

  const isItemActive = (href: string) => {
    if (href === "/production/scan") {
      return pathname === "/production/scan" || pathname.startsWith("/production/scan/");
    }
    if (href === "/production/fg-scan") {
      return pathname === "/production/fg-scan" || pathname.startsWith("/production/fg-scan/");
    }
    // Per-dept pages — each child highlights ONLY on its own URL, no
    // prefix-match fallback (otherwise all dept children would light up
    // simultaneously or Overview would stay active on a dept subpage).
    if (
      href === "/production/fab-cut" ||
      href === "/production/fab-sew" ||
      href === "/production/foam" ||
      href === "/production/wood-cut" ||
      href === "/production/framing" ||
      href === "/production/webbing" ||
      href === "/production/upholstery" ||
      href === "/production/packing"
    ) {
      return pathname === href;
    }
    if (href === "/production") {
      // Overview + parent "Production" share this href. Exact-match only
      // so the Overview child isn't left highlighted while a user is on
      // /production/fab-cut. The parent's own highlight is driven by
      // `childActive` (any dept child matching), so it still lights up
      // on dept subroutes correctly.
      return pathname === "/production";
    }
    if (href === "/planning/mrp") {
      return pathname === "/planning/mrp" || pathname.startsWith("/planning/mrp/");
    }
    if (href === "/planning") {
      return pathname === "/planning" && !pathname.startsWith("/planning/mrp");
    }
    if (href === "/inventory/stock-value") {
      return pathname === "/inventory/stock-value" || pathname.startsWith("/inventory/stock-value/");
    }
    if (href === "/inventory/fabrics") {
      return pathname === "/inventory/fabrics" || pathname.startsWith("/inventory/fabrics/");
    }
    if (href === "/inventory/adjustments") {
      return pathname === "/inventory/adjustments" || pathname.startsWith("/inventory/adjustments/");
    }
    if (href === "/inventory") {
      return pathname === "/inventory" || (pathname.startsWith("/inventory/") && !pathname.startsWith("/inventory/stock-value") && !pathname.startsWith("/inventory/fabrics") && !pathname.startsWith("/inventory/adjustments"));
    }
    if (href === "/accounting/cash-flow") {
      return pathname === "/accounting/cash-flow" || pathname.startsWith("/accounting/cash-flow/");
    }
    if (href === "/accounting") {
      return pathname === "/accounting" || (pathname.startsWith("/accounting/") && !pathname.startsWith("/accounting/cash-flow"));
    }
    if (href === "/procurement/grn") {
      return pathname === "/procurement/grn" || pathname.startsWith("/procurement/grn/");
    }
    if (href === "/procurement/pi") {
      return pathname === "/procurement/pi" || pathname.startsWith("/procurement/pi/");
    }
    if (href === "/procurement/maintenance") {
      return pathname === "/procurement/maintenance" || pathname.startsWith("/procurement/maintenance/");
    }
    if (href === "/procurement/in-transit") {
      return pathname === "/procurement/in-transit" || pathname.startsWith("/procurement/in-transit/");
    }
    if (href === "/procurement/pricing") {
      return pathname === "/procurement/pricing" || pathname.startsWith("/procurement/pricing/");
    }
    if (href === "/procurement") {
      return pathname === "/procurement" || (pathname.startsWith("/procurement/") && !pathname.startsWith("/procurement/grn") && !pathname.startsWith("/procurement/pi") && !pathname.startsWith("/procurement/maintenance") && !pathname.startsWith("/procurement/in-transit") && !pathname.startsWith("/procurement/pricing"));
    }
    if (href === "/consignment/note") {
      return pathname === "/consignment/note" || pathname.startsWith("/consignment/note/");
    }
    if (href === "/consignment/return") {
      return pathname === "/consignment/return" || pathname.startsWith("/consignment/return/");
    }
    if (href === "/consignment") {
      return pathname === "/consignment" || (pathname.startsWith("/consignment/") && !pathname.startsWith("/consignment/note") && !pathname.startsWith("/consignment/return"));
    }
    if (href === "/delivery") {
      return (pathname === "/delivery" || pathname.startsWith("/delivery/"));
    }
    if (href === "/invoices/credit-notes") {
      return pathname === "/invoices/credit-notes" || pathname.startsWith("/invoices/credit-notes/");
    }
    if (href === "/invoices/payments") {
      return pathname === "/invoices/payments" || pathname.startsWith("/invoices/payments/");
    }
    if (href === "/invoices/e-invoice") {
      return pathname === "/invoices/e-invoice" || pathname.startsWith("/invoices/e-invoice/");
    }
    if (href === "/invoices") {
      return pathname === "/invoices" || (pathname.startsWith("/invoices/") && !pathname.startsWith("/invoices/credit-notes") && !pathname.startsWith("/invoices/debit-notes") && !pathname.startsWith("/invoices/payments") && !pathname.startsWith("/invoices/e-invoice"));
    }
    if (href === "/settings/organisations") {
      return pathname === "/settings/organisations" || pathname.startsWith("/settings/organisations/");
    }
    if (href === "/settings") {
      return pathname === "/settings";
    }
    return pathname === href || pathname.startsWith(href + "/");
  };

  return (
    <aside
      className={cn(
        "fixed left-0 top-0 z-40 h-screen bg-[#1F1D1B] text-white transition-all duration-300 flex flex-col",
        collapsed ? "w-14" : "w-60"
      )}
    >
      {/* Brand / Logo — h-16 header (taller than the rest of the sidebar
          rows) gives the wide-aspect lockup more breathing room so the
          HOOKKA letters and 合家 hanjis stay legible at sidebar width. */}
      <div className="flex h-16 items-center justify-center px-3 border-b border-white/10 shrink-0">
        {!collapsed ? (
          <Link to="/dashboard" className="flex items-center justify-center w-full">
            <img
              src="/hookka-logo.png"
              alt="Hookka 合家"
              className="h-10 w-auto max-w-full"
              style={{ filter: "brightness(0) invert(1)" }}
            />
          </Link>
        ) : (
          <Link to="/dashboard" className="mx-auto">
            <div className="h-8 w-8 rounded bg-white/10 flex items-center justify-center text-sm font-[900] tracking-[1px]">
              H
            </div>
          </Link>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-3 scrollbar-thin">
        {groupsWithBadge.map((group) => {
          const isGroupCollapsed = collapsedGroups.has(group.label);
          const groupHasActive = group.items.some((item) => isItemActive(item.href) || (item.children && item.children.some((c) => isItemActive(c.href))));

          return (
          <div key={group.label}>
            {/* Group label - clickable to toggle */}
            {!collapsed && (
              <button
                onClick={() => toggleGroup(group.label)}
                className="w-full flex items-center justify-between px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 select-none hover:text-gray-300 transition-colors group"
              >
                <span>{group.label}</span>
                <ChevronDown className={cn("h-3 w-3 opacity-0 group-hover:opacity-100 transition-all", isGroupCollapsed && "-rotate-90")} />
              </button>
            )}
            {collapsed && <div className="my-1 mx-2 border-t border-white/10" />}

            {/* Show items: always if sidebar collapsed, otherwise respect group collapse (but keep active group open) */}
            {(collapsed || !isGroupCollapsed) && (
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = isItemActive(item.href);
                const hasChildren = item.children && item.children.length > 0;
                const isExpanded = expandedMenus.has(item.name);
                const childActive = hasChildren && item.children!.some(c => isItemActive(c.href));

                if (hasChildren) {
                  return (
                    <div key={item.name}>
                      <button
                        onClick={() => {
                          const next = new Set(expandedMenus);
                          if (isExpanded) next.delete(item.name);
                          else next.add(item.name);
                          setExpandedMenus(next);
                        }}
                        className={cn(
                          "w-full group relative flex items-center gap-3 rounded-md text-sm font-medium transition-colors",
                          "h-9 px-3",
                          childActive
                            ? "bg-[rgba(107,92,50,.18)] text-white border-l-[3px] border-[#6B5C32]"
                            : "text-gray-400 hover:bg-white/5 hover:text-gray-300 border-l-[3px] border-transparent",
                          collapsed && "justify-center px-0"
                        )}
                        title={collapsed ? item.name : undefined}
                      >
                        <item.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
                        {!collapsed && (
                          <>
                            <span className="truncate flex-1 text-left">{item.name}</span>
                            <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", isExpanded && "rotate-180")} />
                          </>
                        )}
                      </button>
                      {isExpanded && !collapsed && (
                        <div className="ml-4 space-y-0.5 mt-0.5">
                          {item.children!.map((child) => {
                            const childIsActive = isItemActive(child.href);
                            return (
                              <Link
                                key={child.href}
                                to={child.href}
                                className={cn(
                                  "group relative flex items-center gap-3 rounded-md text-[13px] font-medium transition-colors",
                                  "h-8 px-3",
                                  childIsActive
                                    ? "bg-[rgba(107,92,50,.18)] text-white border-l-[3px] border-[#6B5C32]"
                                    : "text-gray-500 hover:bg-white/5 hover:text-gray-300 border-l-[3px] border-transparent"
                                )}
                              >
                                <child.icon className="h-[16px] w-[16px] shrink-0" strokeWidth={1.75} />
                                <span className="truncate">{child.name}</span>
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                return (
                  <Link
                    key={item.href}
                    to={item.href}
                    className={cn(
                      "group relative flex items-center gap-3 rounded-md text-sm font-medium transition-colors",
                      "h-9 px-3",
                      active
                        ? "bg-[rgba(107,92,50,.18)] text-white border-l-[3px] border-[#6B5C32]"
                        : "text-gray-400 hover:bg-white/5 hover:text-gray-300 border-l-[3px] border-transparent",
                      collapsed && "justify-center px-0"
                    )}
                    title={collapsed ? item.name : undefined}
                  >
                    <item.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
                    {!collapsed && (
                      <span className="truncate">{item.name}</span>
                    )}
                    {/* Notification badge */}
                    {item.badge !== undefined && item.badge > 0 && (
                      <span
                        className={cn(
                          "flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold leading-none",
                          collapsed
                            ? "absolute -top-0.5 -right-0.5 h-4 min-w-[16px] px-1"
                            : "ml-auto h-5 min-w-[20px] px-1.5"
                        )}
                      >
                        {item.badge > 99 ? "99+" : item.badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
            )}

            {/* Collapsed indicator: show dot if group has active item when collapsed */}
            {!collapsed && isGroupCollapsed && groupHasActive && (
              <div className="px-3 py-0.5">
                <div className="h-0.5 w-6 rounded-full bg-[#6B5C32]" />
              </div>
            )}
          </div>
          );
        })}
      </nav>

      {/* Active organization switcher */}
      <div className="border-t border-white/10 px-2 py-2 shrink-0 relative">
        {(() => {
          const activeOrg = orgs.find((o) => o.id === activeOrgId);
          const label = activeOrg?.name ?? "HOOKKA INDUSTRIES";
          const code = activeOrg?.code ?? "HI";
          const shortCode = code === "HOOKKA" ? "HI" : "OM";

          if (collapsed) {
            return (
              <button
                onClick={() => setOrgDropdownOpen(!orgDropdownOpen)}
                className="flex w-full items-center justify-center rounded-md p-1.5 hover:bg-white/10 transition-colors"
                title={label}
              >
                <div className="h-6 w-6 rounded bg-[#6B5C32]/40 flex items-center justify-center text-[9px] font-bold text-gray-400">
                  {shortCode}
                </div>
              </button>
            );
          }

          return (
            <button
              onClick={() => setOrgDropdownOpen(!orgDropdownOpen)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/10 transition-colors"
            >
              <div className="h-6 w-6 rounded bg-[#6B5C32]/40 flex items-center justify-center text-[9px] font-bold text-gray-400 shrink-0">
                {shortCode}
              </div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400 truncate flex-1 text-left">
                {label}
              </span>
              <ChevronDown
                className={cn(
                  "h-3 w-3 text-gray-500 transition-transform shrink-0",
                  orgDropdownOpen && "rotate-180"
                )}
              />
            </button>
          );
        })()}

        {/* Dropdown */}
        {orgDropdownOpen && (
          <div className="absolute bottom-full left-2 right-2 mb-1 rounded-md bg-[#2A2826] border border-white/10 shadow-lg overflow-hidden z-50">
            <div className="px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wider text-gray-500 border-b border-white/10">
              Switch Organisation
            </div>
            {orgs.map((org) => {
              const isActive = org.id === activeOrgId;
              const sc = org.code === "HOOKKA" ? "HI" : "OM";
              return (
                <button
                  key={org.id}
                  onClick={() => {
                    if (!isActive) switchOrg(org.id);
                    else setOrgDropdownOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors",
                    isActive
                      ? "bg-[#6B5C32]/20 text-white"
                      : "text-gray-400 hover:bg-white/5 hover:text-gray-200"
                  )}
                >
                  <div
                    className={cn(
                      "h-6 w-6 rounded flex items-center justify-center text-[9px] font-bold shrink-0",
                      isActive
                        ? "bg-[#6B5C32] text-white"
                        : "bg-white/10 text-gray-400"
                    )}
                  >
                    {sc}
                  </div>
                  <span className="text-xs truncate flex-1">{org.name}</span>
                  {isActive && (
                    <Check className="h-3.5 w-3.5 text-[#6B5C32] shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* User section */}
      <div className="border-t border-white/10 px-2 py-2 shrink-0">
        {collapsed ? (
          <div className="flex items-center justify-center">
            <div className="h-8 w-8 rounded-full bg-[#6B5C32]/40 flex items-center justify-center text-xs font-semibold text-white">
              {initials}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 px-1">
            <div className="h-8 w-8 rounded-full bg-[#6B5C32]/40 flex items-center justify-center text-xs font-semibold text-white shrink-0">
              {initials}
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-[13px] font-semibold text-white truncate">{displayName}</span>
              <span className="inline-flex items-center self-start rounded-full bg-[#6B5C32]/30 text-[10px] text-gray-300 px-2 py-[2px]">
                {roleLabel}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Collapse toggle */}
      <div className="border-t border-white/10 p-2 shrink-0">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex w-full items-center justify-center rounded-md p-1.5 text-gray-500 hover:bg-white/10 hover:text-white transition-colors"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>
      </div>
    </aside>
  );
}
