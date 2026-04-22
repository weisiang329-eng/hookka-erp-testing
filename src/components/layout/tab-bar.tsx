// ---------------------------------------------------------------------------
// TabBar — VS Code-style in-app tab strip.
//
// Renders the `tabs` from TabsContext as a horizontally-scrollable strip.
// Features:
//   • Click a tab to switch  (triggers navigation via TabsNavigationSync)
//   • Middle-click closes the tab
//   • Hover shows the close (×) button; pinned tabs have a pin glyph instead
//   • Right-click opens a context menu: Close / Close Others / Close All / Pin
//   • Drag-and-drop reorders tabs (HTML5 DnD API, no external deps)
//   • Horizontal scroll-wheel support — vertical wheel is mapped to scrollLeft
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from "react";
import { Pin, PinOff, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTabs, type TabDescriptor } from "@/contexts/tabs-context";

type ContextMenuState = {
  tabId: string;
  x: number;
  y: number;
};

export function TabBar() {
  const {
    tabs,
    activeId,
    closeTab,
    closeOthers,
    closeAll,
    switchTab,
    reorderTabs,
    togglePinned,
  } = useTabs();

  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  // Scroll active tab into view whenever it changes.
  useEffect(() => {
    if (!stripRef.current || !activeId) return;
    const el = stripRef.current.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(activeId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  // Close context menu on outside click or escape.
  useEffect(() => {
    if (!menu) return;
    const onDown = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (tabs.length === 0) {
    return (
      <div className="h-9 border-b border-[#E2DDD8] bg-[#F5F2ED]" />
    );
  }

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    // Translate vertical wheel into horizontal scroll so users can swipe.
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      stripRef.current?.scrollBy({ left: e.deltaY, behavior: "auto" });
    }
  };

  const onDragStart = (idx: number) => (e: React.DragEvent) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(idx));
  };

  const onDragOver = (idx: number) => (e: React.DragEvent) => {
    if (dragIdx === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setHoverIdx(idx);
  };

  const onDragEnd = () => {
    setDragIdx(null);
    setHoverIdx(null);
  };

  const onDrop = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    if (dragIdx !== null && dragIdx !== idx) {
      reorderTabs(dragIdx, idx);
    }
    onDragEnd();
  };

  return (
    <div className="border-b border-[#E2DDD8] bg-[#F5F2ED]">
      <div
        ref={stripRef}
        onWheel={handleWheel}
        className="flex items-stretch overflow-x-auto scrollbar-none"
        style={{ scrollbarWidth: "none" } as React.CSSProperties}
      >
        {tabs.map((tab, idx) => (
          <TabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            beingDragged={dragIdx === idx}
            dropBefore={hoverIdx === idx && dragIdx !== null && dragIdx !== idx}
            onSelect={() => switchTab(tab.id)}
            onClose={() => closeTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
            }}
            onDragStart={onDragStart(idx)}
            onDragOver={onDragOver(idx)}
            onDrop={onDrop(idx)}
            onDragEnd={onDragEnd}
          />
        ))}
        {/* Filler so the last tab's right-border extends to the end */}
        <div className="flex-1 min-w-4 border-b border-[#E2DDD8]" />
      </div>

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => closeTab(menu.tabId)}
          onCloseOthers={() => closeOthers(menu.tabId)}
          onCloseAll={() => closeAll()}
          onTogglePin={() => togglePinned(menu.tabId)}
          pinned={!!tabs.find((t) => t.id === menu.tabId)?.pinned}
          dismiss={() => setMenu(null)}
        />
      )}
    </div>
  );
}

// ---- Single tab -----------------------------------------------------------

interface TabItemProps {
  tab: TabDescriptor;
  active: boolean;
  beingDragged: boolean;
  dropBefore: boolean;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

function TabItem({
  tab,
  active,
  beingDragged,
  dropBefore,
  onSelect,
  onClose,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: TabItemProps) {
  const onMouseDown = (e: React.MouseEvent) => {
    // Middle-click closes the tab.
    if (e.button === 1) {
      e.preventDefault();
      if (!tab.pinned) onClose();
    }
  };

  return (
    <div
      data-tab-id={tab.id}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onContextMenu={onContextMenu}
      onMouseDown={onMouseDown}
      onClick={onSelect}
      title={tab.path}
      className={cn(
        "group relative flex items-center gap-2 px-3 py-1.5 min-w-[120px] max-w-[220px]",
        "text-sm cursor-pointer select-none border-r border-[#E2DDD8]",
        "transition-colors",
        active
          ? "bg-white text-[#1F1D1B] font-medium"
          : "text-[#5A5550] hover:bg-[#EAE5E0] hover:text-[#1F1D1B]",
        beingDragged && "opacity-50",
      )}
    >
      {/* Top accent bar for active tab */}
      {active && (
        <span
          className="absolute inset-x-0 top-0 h-[2px] bg-[#6B5C32]"
          aria-hidden
        />
      )}

      {/* Left drop indicator */}
      {dropBefore && (
        <span
          className="absolute left-0 top-0 bottom-0 w-[2px] bg-[#6B5C32]"
          aria-hidden
        />
      )}

      {/* Pin glyph (if pinned) */}
      {tab.pinned && (
        <Pin className="h-3.5 w-3.5 text-[#6B5C32] shrink-0" />
      )}

      {/* Label */}
      <span className="truncate flex-1">{tab.title}</span>

      {/* Close button — hidden for pinned tabs */}
      {!tab.pinned && (
        <button
          type="button"
          aria-label="Close tab"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            "shrink-0 rounded-sm h-4 w-4 inline-flex items-center justify-center",
            "text-[#9CA3AF] hover:bg-[#D1CBC5] hover:text-[#1F1D1B]",
            active ? "opacity-70" : "opacity-0 group-hover:opacity-70",
          )}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// ---- Context menu ---------------------------------------------------------

interface ContextMenuProps {
  menu: ContextMenuState;
  pinned: boolean;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  onTogglePin: () => void;
  dismiss: () => void;
}

function ContextMenu({
  menu,
  pinned,
  onClose,
  onCloseOthers,
  onCloseAll,
  onTogglePin,
  dismiss,
}: ContextMenuProps) {
  // Clamp menu position so it never spills outside the viewport.
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const { innerWidth, innerHeight } = window;
    const { width, height } = ref.current.getBoundingClientRect();
    const x = Math.min(menu.x, innerWidth - width - 4);
    const y = Math.min(menu.y, innerHeight - height - 4);
    setPos({ x, y });
  }, [menu]);

  const Item = ({
    label,
    icon,
    onClick,
    danger,
  }: {
    label: string;
    icon?: React.ReactNode;
    onClick: () => void;
    danger?: boolean;
  }) => (
    <button
      type="button"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => {
        onClick();
        dismiss();
      }}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[#F0ECE9]",
        danger ? "text-red-600 hover:bg-red-50" : "text-[#1F1D1B]",
      )}
    >
      {icon && <span className="w-4 h-4 inline-flex items-center justify-center text-[#6B5C32]">{icon}</span>}
      <span>{label}</span>
    </button>
  );

  return (
    <div
      ref={ref}
      style={{ position: "fixed", top: pos.y, left: pos.x, zIndex: 100 }}
      onMouseDown={(e) => e.stopPropagation()}
      className="min-w-[180px] rounded-md border border-[#E2DDD8] bg-white shadow-lg py-1"
    >
      {!pinned && <Item label="Close" onClick={onClose} icon={<X className="h-3.5 w-3.5" />} />}
      <Item label="Close Others" onClick={onCloseOthers} />
      <Item label="Close All" onClick={onCloseAll} danger />
      <hr className="my-1 border-[#E2DDD8]" />
      <Item
        label={pinned ? "Unpin" : "Pin"}
        icon={pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        onClick={onTogglePin}
      />
    </div>
  );
}
