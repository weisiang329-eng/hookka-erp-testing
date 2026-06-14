import { useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Factory,
  Search,
  Truck,
  Menu,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Mobile bottom navigation (phones only — hidden at md+).
//
// Replaces the desktop sidebar on small screens with a standard 5-slot tab
// bar. The centre "Search" slot is raised into an accent FAB and opens the
// global command palette (the primary order-lookup surface) by firing a
// custom event GlobalSearch listens for — no shared state needed. "More"
// opens the full sidebar as a slide-over drawer (owned by DashboardLayout).
// ---------------------------------------------------------------------------

type NavItem =
  | { kind: "link"; label: string; icon: LucideIcon; href: string; match: (p: string) => boolean }
  | { kind: "action"; label: string; icon: LucideIcon; onClick: () => void; accent?: boolean };

export function MobileBottomNav({ onMore }: { onMore: () => void }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const items: NavItem[] = [
    { kind: "link", label: "Home", icon: LayoutDashboard, href: "/dashboard", match: (p) => p.startsWith("/dashboard") },
    { kind: "link", label: "Production", icon: Factory, href: "/production", match: (p) => p.startsWith("/production") },
    { kind: "action", label: "Search", icon: Search, accent: true, onClick: () => document.dispatchEvent(new CustomEvent("hookka:open-search")) },
    { kind: "link", label: "Delivery", icon: Truck, href: "/delivery", match: (p) => p.startsWith("/delivery") },
    { kind: "action", label: "More", icon: Menu, onClick: onMore },
  ];

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-[#E2DDD8] bg-white/95 backdrop-blur pb-[env(safe-area-inset-bottom)] md:hidden">
      <div className="grid grid-cols-5">
        {items.map((item) => {
          const Icon = item.icon;
          const active = item.kind === "link" && item.match(pathname);
          const accent = item.kind === "action" && item.accent;
          return (
            <button
              key={item.label}
              type="button"
              onClick={() => (item.kind === "link" ? navigate(item.href) : item.onClick())}
              className={cn(
                "flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors",
                active ? "text-[#6B5C32]" : "text-[#6B7280]",
              )}
            >
              {accent ? (
                <span className="-mt-4 flex h-11 w-11 items-center justify-center rounded-full bg-[#6B5C32] text-white shadow-lg ring-4 ring-white">
                  <Icon className="h-5 w-5" />
                </span>
              ) : (
                <Icon className={cn("h-5 w-5", active && "text-[#6B5C32]")} />
              )}
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
