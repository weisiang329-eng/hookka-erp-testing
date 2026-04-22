import { Link, Outlet, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";

const portalNav = [
  { name: "Dashboard", href: "/portal" },
  { name: "Orders", href: "/portal/orders" },
  { name: "Deliveries", href: "/portal/deliveries" },
  { name: "Account", href: "/portal/account" },
];

export default function PortalLayout() {
  const { pathname } = useLocation();

  const isActive = (href: string) => {
    if (href === "/portal") return pathname === "/portal";
    return pathname === href || pathname.startsWith(href + "/");
  };

  return (
    <div className="min-h-screen bg-[#F0ECE9]">
      {/* Portal Header */}
      <header className="bg-[#1F1D1B] text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Brand */}
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded bg-[#6B5C32] flex items-center justify-center text-sm font-bold">
                H
              </div>
              <span className="text-lg font-bold tracking-tight">HOOKKA Customer Portal</span>
            </div>

            {/* Right side */}
            <div className="flex items-center gap-6">
              <span className="text-sm text-gray-400">
                Logged in as <span className="text-white font-medium">HOUZS KL</span>
              </span>
              <Link
                to="/dashboard"
                className="text-sm text-gray-400 hover:text-white transition-colors"
              >
                Back to ERP
              </Link>
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex gap-1 -mb-px">
            {portalNav.map((item) => (
              <Link
                key={item.href}
                to={item.href}
                className={cn(
                  "px-4 py-3 text-sm font-medium border-b-2 transition-colors",
                  isActive(item.href)
                    ? "border-[#6B5C32] text-white"
                    : "border-transparent text-gray-400 hover:text-gray-200 hover:border-gray-600"
                )}
              >
                {item.name}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Outlet />
      </main>
    </div>
  );
}
