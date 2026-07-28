import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  activateWorkspaceTab,
  closeWorkspaceTab,
  getWorkspaceTabsSnapshot,
  moveWorkspaceTab,
  recordWorkspaceVisit,
  subscribeWorkspaceTabs,
  workspaceTabLabel,
} from "@/lib/workspaceTabs";

/**
 * Workspace tab strip — browser-style tabs in the topbar so open pages persist
 * (owner 2026-07-28: "开着 SO 的时候我去别的 module 回来不会跳不见"). Ported from
 * the Houzs ERP. A sidebar click spawns/activates a tab; in-content navigation
 * re-points the ACTIVE tab; drag reorders; middle-click / ✕ closes. State lives
 * in @/lib/workspaceTabs (sessionStorage, per window).
 */
export function WorkspaceTabs() {
  const location = useLocation();
  const navigate = useNavigate();
  const { tabs, activeId } = useSyncExternalStore(
    subscribeWorkspaceTabs,
    getWorkspaceTabsSnapshot,
    getWorkspaceTabsSnapshot,
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggingRef = useRef<string | null>(null);

  // Record AFTER render — emitting during render would schedule a mid-render update.
  useEffect(() => {
    recordWorkspaceVisit(location.pathname, location.search);
  }, [location.pathname, location.search]);

  function close(id: string) {
    const { navigateTo } = closeWorkspaceTab(id);
    if (navigateTo !== null) navigate(navigateTo);
  }

  // A single tab isn't worth a strip — the breadcrumb already names the page.
  if (tabs.length <= 1) return <div className="flex-1" />;

  return (
    <div
      role="tablist"
      aria-label="Open pages"
      className="flex h-full min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto overflow-y-hidden"
      onDragOver={(e) => {
        if (draggingRef.current !== null) e.preventDefault();
      }}
      onDrop={(e) => {
        if (draggingRef.current !== null) e.preventDefault();
      }}
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeId;
        const label = workspaceTabLabel(tab.href);
        return (
          <div
            key={tab.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", tab.id);
              e.dataTransfer.effectAllowed = "move";
              draggingRef.current = tab.id;
              setDraggingId(tab.id);
            }}
            onDragEnd={() => {
              draggingRef.current = null;
              setDraggingId(null);
            }}
            onDragOver={(e) => {
              const dragged = draggingRef.current;
              if (dragged === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragged === tab.id) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const after = e.clientX > rect.left + rect.width / 2;
              const from = tabs.findIndex((t) => t.id === dragged);
              moveWorkspaceTab(dragged, index + (after ? 1 : 0) - (from < index ? 1 : 0));
            }}
            onDrop={(e) => {
              if (draggingRef.current !== null) e.preventDefault();
            }}
            // Middle-click closes, Chrome-tab style. mousedown preventDefault
            // kills Windows Chrome's middle-button autoscroll before it starts.
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                close(tab.id);
              }
            }}
            className={cn(
              "group relative flex shrink-0 items-center transition-colors",
              isActive ? "text-[#1F1D1B]" : "text-[#6B7280] hover:text-[#1F1D1B]",
              draggingId === tab.id && "opacity-50",
            )}
          >
            <Link
              to={tab.href}
              role="tab"
              aria-selected={isActive}
              data-tab-id={tab.id}
              draggable={false}
              onClick={(e) => {
                if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                  activateWorkspaceTab(tab.id);
                }
              }}
              className={cn(
                "flex max-w-[13rem] items-center self-center truncate py-2 pl-[15px] pr-0.5 text-[13px] leading-none",
                isActive ? "font-semibold" : "font-medium",
              )}
            >
              {label}
            </Link>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => close(tab.id)}
              title="Close tab"
              aria-label={`Close ${label}`}
              className={cn(
                "mr-1.5 flex h-[18px] w-[18px] items-center justify-center self-center rounded-[5px] transition-colors hover:bg-[#F0ECE9] hover:text-[#6B7280]",
                isActive ? "text-[#9CA3AF]" : "text-transparent group-hover:text-[#9CA3AF]",
              )}
            >
              <X size={11} strokeWidth={2.5} />
            </button>
            {isActive && (
              <span className="absolute inset-x-[11px] bottom-0 h-[2.5px] rounded-[2px] bg-[#6B5C32]" />
            )}
          </div>
        );
      })}
    </div>
  );
}
