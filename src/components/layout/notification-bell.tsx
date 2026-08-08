// ---------------------------------------------------------------------------
// NotificationBell — the top-bar bell, wired to the real notification feed.
//
// Before this it was a `<button>` with no onClick and a hardcoded pink dot, so
// it was both unclickable and permanently "unread". The dot now renders ONLY
// when `unreadCount(...) > 0` over the same rows /notifications renders, and
// clicking opens a popover of the most recent items (unread first) with a
// "View all" link to the page. A popover, not a navigation, because the common
// case — glance, see it's the nightly stock alert, move on — should not cost
// the operator their current page.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCheck } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import type { Notification } from "@/types";
import {
  loadNotifications,
  markNotificationsRead,
  recentForBell,
  subscribeNotifications,
  unreadCount,
  isUnread,
} from "@/lib/notifications-feed";

const SEVERITY_DOT: Record<Notification["severity"], string> = {
  CRITICAL: "bg-[#9A3A2D]",
  WARNING: "bg-[#9C6F1E]",
  INFO: "bg-[#3E6570]",
};

function relativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  if (!Number.isFinite(diffMs)) return "";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(dateStr).toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const popoverRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    void loadNotifications().then(setItems);
  }, []);

  // First paint, plus whenever the OTHER surface (the /notifications page)
  // marks something read, plus when the tab regains focus.
  useEffect(() => {
    refresh();
    const unsub = subscribeNotifications(refresh);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      unsub();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unread = unreadCount(items);
  const recent = recentForBell(items);

  async function markRead(ids: string[]) {
    if (ids.length === 0) return;
    // Optimistic — the broadcast from markNotificationsRead re-reads the
    // server copy right after, so a rejected write self-corrects.
    setItems((prev) => prev.map((n) => (ids.includes(n.id) ? { ...n, isRead: true } : n)));
    await markNotificationsRead(ids);
  }

  function openItem(n: Notification) {
    setOpen(false);
    if (isUnread(n)) void markRead([n.id]);
    if (n.link) navigate(n.link);
    else navigate("/notifications");
  }

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
        title={unread > 0 ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications"}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) refresh();
        }}
        className={cn(
          "relative rounded-md p-2 text-[#6B7280] hover:bg-[#F0ECE9] transition-colors",
          open && "bg-[#F0ECE9] text-[#1F1D1B]",
        )}
      >
        <Bell className="h-5 w-5" />
        {/* Real unread state only. No unread → no dot. */}
        {unread > 0 && (
          <span
            data-testid="notification-unread-dot"
            className="absolute -right-0.5 -top-0.5 min-w-[1rem] rounded-full bg-[#EC4899] px-1 text-[10px] font-semibold leading-4 text-white tabular-nums"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-96 max-w-[90vw] rounded-md border border-[#E2DDD8] bg-white shadow-lg z-50">
          <div className="flex items-center justify-between border-b border-[#E2DDD8] px-3 py-2">
            <span className="text-sm font-semibold text-[#1F1D1B]">
              Notifications{unread > 0 ? ` · ${unread} unread` : ""}
            </span>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-[#6B5C32] hover:text-[#4D4224] disabled:text-[#C9C3BC]"
              disabled={unread === 0}
              onClick={() => void markRead(items.filter(isUnread).map((n) => n.id))}
            >
              <CheckCheck className="h-3.5 w-3.5" />
              Mark all read
            </button>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {recent.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-[#6B7280]">
                No notifications to show
              </div>
            ) : (
              recent.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => openItem(n)}
                  className={cn(
                    "flex w-full items-start gap-2 border-b border-[#F0ECE9] px-3 py-2 text-left hover:bg-[#F0ECE9]",
                    isUnread(n) ? "bg-[#FAF9F7]" : "bg-white",
                  )}
                >
                  <span
                    className={cn(
                      "mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full",
                      SEVERITY_DOT[n.severity] ?? "bg-[#3E6570]",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-sm",
                        isUnread(n)
                          ? "font-semibold text-[#1F1D1B]"
                          : "font-medium text-[#4B5563]",
                      )}
                    >
                      {n.title}
                    </span>
                    <span className="block truncate text-xs text-[#6B7280]">{n.message}</span>
                    <span className="mt-0.5 block text-[10px] text-[#9CA3AF]">
                      {n.type} · {relativeTime(n.createdAt)}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>

          <button
            type="button"
            className="w-full border-t border-[#E2DDD8] px-3 py-2 text-center text-xs font-medium text-[#6B5C32] hover:bg-[#F0ECE9]"
            onClick={() => {
              setOpen(false);
              navigate("/notifications");
            }}
          >
            View all notifications
          </button>
        </div>
      )}
    </div>
  );
}
