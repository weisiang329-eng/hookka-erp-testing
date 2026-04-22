import { useState } from "react";
import { Bell, ChevronDown, LogOut, User, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { GlobalSearch } from "./global-search";

interface TopbarProps {
  user?: {
    name: string;
    email: string;
    role: string;
    organisationName: string;
    organisationCode: string;
  };
}

const organisations = [
  { code: "HOOKKA", name: "HOOKKA INDUSTRIES SDN BHD" },
  { code: "OHANA", name: "OHANA MARKETING" },
];

export function Topbar({ user }: TopbarProps) {
  const [orgDropdownOpen, setOrgDropdownOpen] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const currentOrg = user?.organisationCode || "HOOKKA";

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
            {user?.name?.charAt(0) || "U"}
          </div>
          <div className="hidden sm:block text-left">
            <p className="text-sm font-medium text-[#1F1D1B]">{user?.name || "User"}</p>
            <p className="text-xs text-[#9CA3AF]">{user?.role || "Admin"}</p>
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
              onClick={() => { window.location.href = "/login"; }}
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
