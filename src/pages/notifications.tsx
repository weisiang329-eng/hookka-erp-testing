import { useState, useMemo } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Notification } from "@/lib/mock-data";
import {
  Bell,
  BellOff,
  CheckCheck,
  AlertTriangle,
  Info,
  AlertCircle,
  Package,
  Factory,
  ShoppingCart,
  Truck,
  ShieldCheck,
  DollarSign,
  Loader2,
  Check,
} from "lucide-react";

// --- Helpers ---

function getTypeIcon(type: Notification["type"]) {
  const map: Record<Notification["type"], React.ReactNode> = {
    ORDER: <ShoppingCart className="h-4 w-4" />,
    PRODUCTION: <Factory className="h-4 w-4" />,
    INVENTORY: <Package className="h-4 w-4" />,
    DELIVERY: <Truck className="h-4 w-4" />,
    QUALITY: <ShieldCheck className="h-4 w-4" />,
    FINANCE: <DollarSign className="h-4 w-4" />,
    SYSTEM: <Bell className="h-4 w-4" />,
  };
  return map[type];
}

function getSeverityDot(severity: Notification["severity"]) {
  const colors: Record<Notification["severity"], string> = {
    CRITICAL: "bg-[#9A3A2D]",
    WARNING: "bg-[#9C6F1E]",
    INFO: "bg-[#3E6570]",
  };
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${colors[severity]}`} />;
}

function getSeverityBorder(severity: Notification["severity"]) {
  const map: Record<Notification["severity"], string> = {
    CRITICAL: "border-l-red-500",
    WARNING: "border-l-amber-500",
    INFO: "border-l-blue-500",
  };
  return map[severity];
}

function relativeTime(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" });
}

function getDateGroup(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 6 * 86400000);

  if (date >= today) return "Today";
  if (date >= yesterday) return "Yesterday";
  if (date >= weekAgo) return "This Week";
  return "Older";
}

// --- Filter tabs ---

type FilterValue =
  | "ALL"
  | "UNREAD"
  | "ORDER"
  | "PRODUCTION"
  | "INVENTORY"
  | "DELIVERY"
  | "QUALITY"
  | "FINANCE";

const filterTabs: { label: string; value: FilterValue }[] = [
  { label: "All", value: "ALL" },
  { label: "Unread", value: "UNREAD" },
  { label: "Orders", value: "ORDER" },
  { label: "Production", value: "PRODUCTION" },
  { label: "Inventory", value: "INVENTORY" },
  { label: "Delivery", value: "DELIVERY" },
  { label: "Quality", value: "QUALITY" },
  { label: "Finance", value: "FINANCE" },
];

// --- Component ---

export default function NotificationsPage() {
  const navigate = useNavigate();
  // Local read-state overrides (mark-as-read mutation) layered on top of the
  // server snapshot. We track JUST the ids that have been marked read locally
  // since the last server fetch; the rendered list is derived (no setState in
  // an effect that copies from notifResp).
  const [locallyRead, setLocallyRead] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<FilterValue>("ALL");

  const { data: notifResp, loading } = useCachedJson<unknown>("/api/notifications");

  const notifications: Notification[] = useMemo(() => {
    const raw = notifResp;
    if (raw === null || raw === undefined) return [];
    const list = Array.isArray(raw)
      ? (raw as Notification[])
      : Array.isArray((raw as { data?: unknown })?.data)
        ? ((raw as { data: Notification[] }).data)
        : [];
    if (locallyRead.size === 0) return list;
    return list.map((n) => (locallyRead.has(n.id) ? { ...n, isRead: true } : n));
  }, [notifResp, locallyRead]);

  // --- Mark as read ---

  async function markAsRead(ids: string[]) {
    await fetch("/api/notifications", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    setLocallyRead((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }

  function markAllRead() {
    const unreadIds = notifications.filter((n) => !n.isRead).map((n) => n.id);
    if (unreadIds.length > 0) markAsRead(unreadIds);
  }

  // --- Derived data ---

  const unreadCount = notifications.filter((n) => !n.isRead).length;
  const criticalCount = notifications.filter((n) => n.severity === "CRITICAL" && !n.isRead).length;
  const warningCount = notifications.filter((n) => n.severity === "WARNING" && !n.isRead).length;
  const infoCount = notifications.filter((n) => n.severity === "INFO" && !n.isRead).length;

  const filtered =
    filter === "ALL"
      ? notifications
      : filter === "UNREAD"
        ? notifications.filter((n) => !n.isRead)
        : notifications.filter((n) => n.type === filter);

  // Group by date
  const groups: { label: string; items: Notification[] }[] = [];
  const groupOrder = ["Today", "Yesterday", "This Week", "Older"];
  const groupMap = new Map<string, Notification[]>();

  for (const n of filtered) {
    const g = getDateGroup(n.createdAt);
    if (!groupMap.has(g)) groupMap.set(g, []);
    groupMap.get(g)!.push(n);
  }

  for (const label of groupOrder) {
    const items = groupMap.get(label);
    if (items && items.length > 0) {
      groups.push({ label, items });
    }
  }

  // --- Loading state ---

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-[#6B5C32]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Notifications</h1>
          <p className="text-xs text-[#6B7280]">
            System alerts, reminders, and activity updates
          </p>
        </div>
        <Button variant="outline" onClick={markAllRead} disabled={unreadCount === 0}>
          <CheckCheck className="h-4 w-4" />
          Mark All Read
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Total Unread</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{unreadCount}</p>
            </div>
            <BellOff className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Critical Alerts</p>
              <p className="text-xl font-bold text-[#9A3A2D]">{criticalCount}</p>
            </div>
            <AlertCircle className="h-5 w-5 text-[#9A3A2D]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Warnings</p>
              <p className="text-xl font-bold text-[#9C6F1E]">{warningCount}</p>
            </div>
            <AlertTriangle className="h-5 w-5 text-[#9C6F1E]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Info</p>
              <p className="text-xl font-bold text-[#3E6570]">{infoCount}</p>
            </div>
            <Info className="h-5 w-5 text-[#3E6570]" />
          </CardContent>
        </Card>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {filterTabs.map((tab) => (
          <Button
            key={tab.value}
            variant={filter === tab.value ? "primary" : "outline"}
            size="sm"
            onClick={() => setFilter(tab.value)}
          >
            {tab.label}
            {tab.value === "UNREAD" && unreadCount > 0 && (
              <span className="ml-1 inline-flex items-center justify-center rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold leading-none">
                {unreadCount}
              </span>
            )}
          </Button>
        ))}
      </div>

      {/* Notification List - Grouped by Date */}
      {groups.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Bell className="h-10 w-10 text-[#E2DDD8] mx-auto mb-3" />
            <p className="text-xs text-[#6B7280]">No notifications to show</p>
          </CardContent>
        </Card>
      ) : (
        groups.map((group) => (
          <div key={group.label} className="space-y-2">
            <h2 className="text-sm font-semibold text-[#6B7280] uppercase tracking-wide px-1">
              {group.label}
            </h2>
            <div className="space-y-2">
              {group.items.map((notif) => (
                <div
                  key={notif.id}
                  onClick={() => notif.link && navigate(notif.link)}
                  className={`flex items-start gap-3 p-4 rounded-lg border border-l-4 transition-colors
                    ${getSeverityBorder(notif.severity)}
                    ${notif.isRead ? "bg-white border-[#E2DDD8]" : "bg-[#FAF9F7] border-[#E2DDD8]"}
                    ${notif.link ? "cursor-pointer hover:bg-[#F0ECE9]" : ""}`}
                >
                  {/* Type icon */}
                  <div className="shrink-0 mt-0.5 p-2 rounded-md bg-[#F0ECE9] text-[#6B5C32]">
                    {getTypeIcon(notif.type)}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      {getSeverityDot(notif.severity)}
                      <h3
                        className={`text-sm truncate ${
                          notif.isRead
                            ? "font-medium text-[#4B5563]"
                            : "font-semibold text-[#1F1D1B]"
                        }`}
                      >
                        {notif.title}
                      </h3>
                    </div>
                    <p className="text-sm text-[#6B7280] line-clamp-2">{notif.message}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <Badge>{notif.type}</Badge>
                      <span className="text-xs text-[#9CA3AF]">
                        {relativeTime(notif.createdAt)}
                      </span>
                    </div>
                  </div>

                  {/* Mark as read button */}
                  {!notif.isRead ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-[#6B5C32] hover:text-[#4D4224]"
                      onClick={(e) => {
                        e.stopPropagation();
                        markAsRead([notif.id]);
                      }}
                    >
                      <Check className="h-4 w-4" />
                      <span className="hidden sm:inline">Mark Read</span>
                    </Button>
                  ) : (
                    <span className="shrink-0 text-xs text-[#9CA3AF] mt-1">Read</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
