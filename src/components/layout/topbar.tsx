import { useState } from "react";
import { Bell, ChevronDown, LogOut, User, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { GlobalSearch } from "./global-search";
import { clearAuth, getCurrentUser } from "@/lib/auth";

interface TopbarProps {
  user?: {
    name: string;
    email: string;
    role: string;
    organisationName: string;
    organisationCode: string;
  };
}

// POST /api/auth/logout, then clear local state and bounce to /login.
// We run the server call best-effort — even if it fails we still want to
// wipe the client token so a reload doesn't auto-sign-in.
async function handleSignOut(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // ignore — network hiccup shouldn't trap the user in the app
  }
  clearAuth();
  window.location.href = "/login";
}

const organisations = [
  { code: "HOOKKA", name: "HOOKKA INDUSTRIES SDN BHD" },
  { code: "OHANA", name: "OHANA MARKETING" },
];

export function Topbar({ user }: TopbarProps) {
  const [orgDropdownOpen, setOrgDropdownOpen] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const currentOrg = user?.organisationCode || "HOOKKA";

  // Prefer the real signed-in user for the avatar label + dropdown.
  // If nobody is signed in yet (localStorage empty during boot), fall back
  // to "—" rather than inventing a name — never show a stale demo user
  // (P3.7: replaced hardcoded "Lim / Director" placeholder).
  const authUser = getCurrentUser();
  const displayName =
    authUser?.displayName || authUser?.email || user?.name || "—";
  const rawRole = authUser?.role || user?.role || "";
  const displayRole = rawRole
    ? rawRole
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase())
    : "—";

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-[#E2DDD8] bg-white px-6">
      {/* Breadcrumb area */}
      <div className="flex-1" />

      {/* Global Search (command palette) */}
      <GlobalSearch />

      {/* Organisation Switcher */}
      <div className="relative">
        <button
          onClick={() => { setOrgDropdownOpen(!orgDropdownOpen); setUserDropdownOpen(false); }}
          className="flex items-center gap-2 rounded-md border border-[#E2DDD8] px-3 py-1.5 text-sm hover:bg-[#F0ECE9] transition-colors"
        >
          <Building2 className="h-4 w-4 text-[#6B5C32]" />
          <span className="hidden sm:inline font-medium text-[#1F1D1B]">{currentOrg}</span>
          <ChevronDown className="h-3 w-3 text-[#9CA3AF]" />
        </button>
        {orgDropdownOpen && (
          <div className="absolute right-0 top-full mt-1 w-64 rounded-md border border-[#E2DDD8] bg-white shadow-lg py-1 z-50">
            {organisations.map((org) => (
              <button
                key={org.code}
                className={cn(
                  "flex w-full items-center gap-2 px-4 py-2 text-sm hover:bg-[#F0ECE9]",
                  currentOrg === org.code && "bg-[#F5F2ED] text-[#6B5C32] font-medium"
                )}
                onClick={() => setOrgDropdownOpen(false)}
              >
                <Building2 className="h-4 w-4" />
                <div className="text-left">
                  <div className="font-medium">{org.code}</div>
                  <div className="text-xs text-[#9CA3AF]">{org.name}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Notifications */}
      <button className="relative rounded-md p-2 text-[#6B7280] hover:bg-[#F0ECE9] transition-colors">
        <Bell className="h-5 w-5" />
        <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-[#EC4899]" />
      </button>

      {/* User menu */}
      <div className="relative">
        <button
          onClick={() => { setUserDropdownOpen(!userDropdownOpen); setOrgDropdownOpen(false); }}
          className="flex items-center gap-2 rounded-md p-1.5 hover:bg-[#F0ECE9] transition-colors"
        >
          <div className="h-8 w-8 rounded-full bg-[#6B5C32] flex items-center justify-center text-white text-sm font-medium">
            {displayName.charAt(0).toUpperCase() || "U"}
          </div>
          <div className="hidden sm:block text-left">
            <p className="text-sm font-medium text-[#1F1D1B]">{displayName}</p>
            <p className="text-xs text-[#9CA3AF]">{displayRole}</p>
          </div>
          <ChevronDown className="h-3 w-3 text-[#9CA3AF] hidden sm:block" />
        </button>
        {userDropdownOpen && (
          <div className="absolute right-0 top-full mt-1 w-48 rounded-md border border-[#E2DDD8] bg-white shadow-lg py-1 z-50">
            <button className="flex w-full items-center gap-2 px-4 py-2 text-sm text-[#4B5563] hover:bg-[#F0ECE9]">
              <User className="h-4 w-4" />
              Profile
            </button>
            <hr className="my-1 border-[#E2DDD8]" />
            <button
              className="flex w-full items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
              onClick={() => { handleSignOut(); }}
            >
              <LogOut className="h-4 w-4" />
              Sign Out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
