"use client";

// DataGrid is a generic table utility that operates on arbitrary row shapes.
// The `any` types mark "we don't statically know this value's shape" —
// callers pass typed data via `columns` + `Column<T>.render`, which is where
// the type safety actually lives. Changing these to `unknown` would force
// type guards at every lookup with no real safety gain.
/* eslint-disable @typescript-eslint/no-explicit-any */

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn, formatDateDMY, formatNumber, formatRM, getStatusColor } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth";
import { useToast } from "@/components/ui/toast";

// Stable identifier for namespacing per-user grid preferences in localStorage.
// Using email (lowercased) so column visibility / order / saved views are
// scoped to the logged-in user rather than shared across accounts on the
// same browser. Falls back to "anon" when not signed in.
function userKey(): string {
  try {
    const u = getCurrentUser();
    return u?.email ? u.email.toLowerCase() : "anon";
  } catch {
    return "anon";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Column<T> = {
  key: string;
  label: string;
  width?: string;
  align?: "left" | "center" | "right";
  sortable?: boolean;
  hidden?: boolean; // context-driven: column is excluded from the toggle list AND from render. Final.
  defaultHidden?: boolean; // column appears in the Columns toggle list but is OFF by default. User can toggle on.
  render?: (value: any, row: T, index: number) => React.ReactNode;
  type?: "text" | "date" | "currency" | "number" | "docno" | "status";
  // Freeze this column to the left edge so it stays visible during horizontal
  // scroll. Sticky columns must appear contiguously at the start of the
  // visible-column order (after the optional `selectable` checkbox column),
  // and each sticky column REQUIRES an explicit pixel `width` so the runtime
  // can compute cumulative left offsets. Body cells force a solid background
  // (zebra / selected / rowClassName) so non-sticky cells scrolling underneath
  // do not bleed through. Defaults to false — fully opt-in, every other grid
  // in the codebase keeps its existing behaviour.
  sticky?: boolean;
  // Optional value-filter accessor — when defined, the per-column value-
  // filter dropdown (the "(All)" checkbox panel) reads from this fn
  // instead of `getNestedValue(row, key)`. Used for two reasons:
  //   1. Sortable numeric columns where filter UI needs human labels
  //      (e.g. dept-status sortKey 0..3 → "Pending / Overdue / Done / —").
  //   2. Object / array columns where the default String() conversion
  //      gives "[object Object]" (e.g. Inventory's `sources` array →
  //      show row.sources.length).
  // Sort still uses `key` so sortable: true keeps its original ordering.
  filterAccessor?: (row: T) => string | number | null;
  // Optional sort-value accessor — when defined the sort comparator reads
  // from this fn instead of `getNestedValue(row, key)`. Use this for
  // columns whose displayed value is computed in `render` from a lookup
  // outside the row (e.g. a Map keyed by row.id) so sort reflects the
  // visible value rather than always returning undefined and leaving rows
  // in input order. Only the value matters — direction stays user-controlled.
  sortAccessor?: (row: T) => string | number | null | undefined;
};

export type ContextMenuItem = {
  label: string;
  icon?: React.ReactNode;
  action: (row: any) => void;
  separator?: boolean;
  danger?: boolean;
  disabled?: boolean;
};

export type DataGridProps<T> = {
  columns: Column<T>[];
  data: T[];
  keyField: string;
  onDoubleClick?: (row: T) => void;
  onRowClick?: (row: T) => void;
  contextMenuItems?: ContextMenuItem[] | ((row: T) => ContextMenuItem[]);
  onSelectionChange?: (selectedRows: T[]) => void;
  selectable?: boolean;
  rowClassName?: (row: T) => string;
  emptyMessage?: string;
  loading?: boolean;
  stickyHeader?: boolean;
  maxHeight?: string;
  className?: string;
  gridId?: string; // unique key for persisting column visibility in localStorage
  groupBy?: string; // column key to group rows by — inserts group header rows
  viewStorageKey?: string; // when provided, enables saved views feature; used as localStorage prefix
  // Fires whenever the currently filtered + sorted rows change. Lets the
  // parent mirror the grid's internal filter state — e.g. to scope a
  // "Print" action or a QR-sticker row to exactly what the user sees.
  onFilteredDataChange?: (rows: T[]) => void;
  // Opt-in row virtualization (windowed rendering via @tanstack/react-virtual).
  // Off by default to keep the table-layout-driven column widths working for
  // small grids; turn on for large data sets (~500+ rows) where the DOM
  // node count is the dominant cost. When `groupBy` + `groupEnabled` are
  // active, virtualization is automatically skipped because group headers
  // and per-group collapse make a single linear-list virtualizer awkward.
  virtualize?: boolean;
  // First-load defaults for the per-column value filter (the "(All)"
  // dropdown). Map of columnKey → list of values to EXCLUDE on first
  // render. Used to hide already-completed / shipped rows from the
  // default view without forcing the API to omit them — operator can
  // tick those values back in to see the full set. Only applied once,
  // after data loads, when no saved filter state exists in localStorage
  // for this gridId — once the user has any saved state we honour their
  // explicit filter choice rather than re-applying the default. Pass an
  // empty object / undefined to skip.
  defaultExcludedValues?: Record<string, string[]>;
};

type SavedView = {
  name: string;
  filters: {
    searchText: string;
    columnFilters: Record<string, string>;
    columnValueFilters: Record<string, string[]>; // serialized from Set<string>
    sortKey: string | null;
    sortDir: "asc" | "desc";
    groupEnabled: boolean;
    groupFilter: string[] | null; // serialized from Set<string>
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNestedValue(obj: any, path: string): any {
  return path.split(".").reduce((acc, part) => acc?.[part], obj);
}

function compareValues(a: any, b: any): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function matchesFilter(value: any, filter: string): boolean {
  if (!filter) return true;
  const s = String(value ?? "").toLowerCase();

  // Check for mode prefix (e.g. "equals:hello")
  const modeMatch = filter.match(/^([a-z_]+):(.*)/);
  if (modeMatch) {
    const mode = modeMatch[1];
    const term = modeMatch[2].toLowerCase();
    switch (mode) {
      case "equals": return s === term;
      case "not_equals": return s !== term;
      case "begins_with": return s.startsWith(term);
      case "ends_with": return s.endsWith(term);
      case "not_contains": return !s.includes(term);
      case "is_blank": return s === "";
      case "is_not_blank": return s !== "";
      default: return s.includes(term);
    }
  }

  return s.includes(filter.toLowerCase());
}

// ---------------------------------------------------------------------------
// Context Menu
// ---------------------------------------------------------------------------

function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(-1);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nx = x, ny = y;
    if (rect.right > window.innerWidth) nx = window.innerWidth - rect.width - 8;
    if (rect.bottom > window.innerHeight) ny = window.innerHeight - rect.height - 8;
    if (nx < 0) nx = 8;
    if (ny < 0) ny = 8;
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") { onClose(); return; }
      const enabledIndices = items.reduce<number[]>((acc, item, i) => {
        if (!item.disabled) acc.push(i);
        return acc;
      }, []);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const curPos = enabledIndices.indexOf(focusIndex);
        setFocusIndex(enabledIndices[(curPos + 1) % enabledIndices.length] ?? -1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const curPos = enabledIndices.indexOf(focusIndex);
        setFocusIndex(enabledIndices[(curPos - 1 + enabledIndices.length) % enabledIndices.length] ?? -1);
      } else if (e.key === "Enter" && focusIndex >= 0) {
        e.preventDefault();
        const item = items[focusIndex];
        if (item && !item.disabled) { item.action({}); onClose(); }
      }
    }
    function handleScroll() { onClose(); }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose, items, focusIndex]);

  return (
    <div
      ref={menuRef}
      className="fixed z-[100] min-w-[220px] rounded border border-[#D0D0D0] bg-white py-1 shadow-md"
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item, i) => (
        <React.Fragment key={i}>
          {item.separator && i > 0 && <div className="my-0.5 border-t border-[#E5E5E5]" />}
          <button
            className={cn(
              "flex w-full items-center gap-2 px-3 py-[5px] text-left text-[12px] transition-colors",
              item.disabled ? "cursor-not-allowed text-[#BBB]"
                : item.danger ? "text-red-600 hover:bg-[#E8E8E8]"
                : "text-[#222] hover:bg-[#E8E8E8]",
              focusIndex === i && !item.disabled && "bg-[#E8E8E8]"
            )}
            disabled={item.disabled}
            onClick={() => { if (!item.disabled) { item.action({}); onClose(); } }}
            onMouseEnter={() => setFocusIndex(i)}
          >
            {item.icon && <span className="flex h-4 w-4 items-center justify-center text-[#666]">{item.icon}</span>}
            {item.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column Filter Dropdown (AutoCount-style)
// ---------------------------------------------------------------------------

function ColumnFilterDropdown<T>({
  columnKey,
  columnType: _columnType,
  filterAccessor,
  allData,
  activeValues,
  textFilter,
  onApplyValues,
  onApplyText,
  onClear,
  onClose,
  anchorRect,
}: {
  columnKey: string;
  columnType?: "text" | "date" | "currency" | "number" | "docno" | "status";
  filterAccessor?: (row: T) => string | number | null;
  allData: T[];
  activeValues: Set<string> | null;
  textFilter: string;
  onApplyValues: (values: Set<string> | null) => void;
  onApplyText: (text: string, mode?: string) => void;
  onClear: () => void;
  onClose: () => void;
  anchorRect: { left: number; top: number };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"values" | "text">("values");
  const [search, setSearch] = useState("");
  const [localText, setLocalText] = useState(textFilter.replace(/^[a-z_]+:/, ""));
  const [localTextMode, setLocalTextMode] = useState<string>(() => {
    const m = textFilter.match(/^([a-z_]+):/);
    return m ? m[1] : "contains";
  });

  // Compute unique values for this column. When the column defines a
  // filterAccessor, route through it so the dropdown shows human labels
  // (e.g. "Pending / Overdue / Done") instead of the raw sort number
  // the column.key resolves to. Also covers object/array columns where
  // the default String(getNestedValue) gives "[object Object]" — the
  // accessor stringifies into a meaningful filter label.
  const uniqueValues = useMemo(() => {
    const vals = new Map<string, number>();
    allData.forEach(row => {
      const v = filterAccessor
        ? String(filterAccessor(row) ?? "")
        : String(getNestedValue(row as any, columnKey) ?? "");
      vals.set(v, (vals.get(v) || 0) + 1);
    });
    return Array.from(vals.entries()).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }, [allData, columnKey, filterAccessor]);

  const filteredValues = useMemo(() => {
    if (!search) return uniqueValues;
    const lower = search.toLowerCase();
    return uniqueValues.filter(([v]) => v.toLowerCase().includes(lower));
  }, [uniqueValues, search]);

  // Local checked state
  const [checked, setChecked] = useState<Set<string>>(() => {
    if (activeValues) return new Set(activeValues);
    return new Set(uniqueValues.map(([v]) => v)); // all checked by default
  });

  const allChecked = checked.size === uniqueValues.length;

  const toggleAll = () => {
    if (allChecked) setChecked(new Set());
    else setChecked(new Set(uniqueValues.map(([v]) => v)));
  };

  const toggleValue = (v: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  };

  // Close on outside click / escape
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Position
  const [pos, setPos] = useState(anchorRect);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nx = anchorRect.left, ny = anchorRect.top;
    if (nx + rect.width > window.innerWidth) nx = window.innerWidth - rect.width - 8;
    if (ny + rect.height > window.innerHeight) ny = window.innerHeight - rect.height - 8;
    if (nx < 0) nx = 8;
    if (ny < 0) ny = 8;
    setPos({ left: nx, top: ny });
  }, [anchorRect]);

  return (
    <div
      ref={ref}
      className="fixed z-[100] w-[240px] rounded border border-[#C0C0C0] bg-white shadow-lg"
      style={{ left: pos.left, top: pos.top }}
    >
      {/* Tabs */}
      <div className="flex border-b border-[#E2DDD8]">
        <button
          className={cn("flex-1 px-3 py-1.5 text-[11px] font-medium border-b-2 transition-colors",
            tab === "values" ? "border-[#6B5C32] text-[#6B5C32] bg-[#F5F9FF]" : "border-transparent text-[#666] hover:text-[#333]"
          )}
          onClick={() => setTab("values")}
        >
          Values
        </button>
        <button
          className={cn("flex-1 px-3 py-1.5 text-[11px] font-medium border-b-2 transition-colors",
            tab === "text" ? "border-[#6B5C32] text-[#6B5C32] bg-[#F5F9FF]" : "border-transparent text-[#666] hover:text-[#333]"
          )}
          onClick={() => setTab("text")}
        >
          Text Filters
        </button>
      </div>

      {tab === "values" ? (
        <div>
          {/* Search */}
          <div className="px-2 pt-2 pb-1">
            <div className="relative">
              <input
                type="text"
                placeholder="Enter text to search..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full rounded border border-[#D0D0D0] bg-white py-1 pl-2 pr-6 text-[11px] text-[#333] placeholder-[#AAA] focus:border-[#6B5C32] focus:outline-none"
              />
              <svg className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[#999]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
            </div>
          </div>
          {/* All checkbox */}
          <label className="flex items-center gap-2 px-3 py-1 text-[11px] text-[#333] cursor-pointer hover:bg-[#F0ECE9]">
            <input type="checkbox" checked={allChecked} onChange={toggleAll} className="h-3.5 w-3.5 accent-[#6B5C32]" />
            <span className="font-medium">(All)</span>
          </label>
          {/* Values list */}
          <div className="max-h-[200px] overflow-y-auto border-t border-[#F0F0F0]">
            {filteredValues.map(([val, count]) => (
              <label key={val} className="flex items-center gap-2 px-3 py-0.5 text-[11px] text-[#333] cursor-pointer hover:bg-[#F0ECE9]">
                <input type="checkbox" checked={checked.has(val)} onChange={() => toggleValue(val)} className="h-3.5 w-3.5 accent-[#6B5C32]" />
                <span className="truncate flex-1">{val || "(blank)"}</span>
                <span className="text-[9px] text-[#AAA]">{count}</span>
              </label>
            ))}
          </div>
          {/* Actions */}
          <div className="flex items-center justify-between border-t border-[#E2DDD8] px-2 py-1.5">
            <button
              className="rounded border border-[#D0D0D0] px-3 py-1 text-[11px] text-[#555] hover:bg-[#F0ECE9]"
              onClick={() => { onClear(); onClose(); }}
            >
              Clear Filter
            </button>
            <div className="flex gap-1">
              <button
                className="rounded border border-[#6B5C32] bg-[#6B5C32] px-3 py-1 text-[11px] text-white hover:bg-[#4D4224]"
                onClick={() => {
                  if (allChecked) onApplyValues(null); // no filter
                  else onApplyValues(new Set(checked));
                  onClose();
                }}
              >
                OK
              </button>
              <button
                className="rounded border border-[#D0D0D0] px-3 py-1 text-[11px] text-[#555] hover:bg-[#F0ECE9]"
                onClick={onClose}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-2 space-y-2">
          {/* Filter mode selector */}
          <select
            value={localTextMode}
            onChange={e => setLocalTextMode(e.target.value as any)}
            className="w-full rounded border border-[#D0D0D0] bg-white py-1.5 px-2 text-[11px] text-[#333] focus:border-[#6B5C32] focus:outline-none cursor-pointer"
          >
            <option value="contains">Contains</option>
            <option value="equals">Equals</option>
            <option value="not_equals">Does Not Equal</option>
            <option value="begins_with">Begins With</option>
            <option value="ends_with">Ends With</option>
            <option value="not_contains">Does Not Contain</option>
            <option value="is_blank">Is Blank</option>
            <option value="is_not_blank">Is Not Blank</option>
          </select>
          {/* Text input (hidden for blank/not-blank modes) */}
          {localTextMode !== "is_blank" && localTextMode !== "is_not_blank" && (
            <input
              type="text"
              placeholder="Enter filter value..."
              value={localText}
              onChange={e => setLocalText(e.target.value)}
              className="w-full rounded border border-[#D0D0D0] bg-white py-1.5 px-2 text-[11px] text-[#333] placeholder-[#AAA] focus:border-[#6B5C32] focus:outline-none"
            />
          )}
          <div className="flex items-center justify-between pt-1">
            <button
              className="rounded border border-[#D0D0D0] px-3 py-1 text-[11px] text-[#555] hover:bg-[#F0ECE9]"
              onClick={() => { onApplyText("", "contains"); onClose(); }}
            >
              Clear
            </button>
            <button
              className="rounded border border-[#6B5C32] bg-[#6B5C32] px-3 py-1 text-[11px] text-white hover:bg-[#4D4224]"
              onClick={() => { onApplyText(localText, localTextMode); onClose(); }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column Customization Dialog
// ---------------------------------------------------------------------------

function ColumnCustomizer<T>({
  columns,
  visibleKeys,
  columnOrder,
  onToggle,
  onReorder,
  onClose,
  onSaveAsOrgDefault,
  onResetToOrgDefault,
}: {
  columns: Column<T>[];
  visibleKeys: Set<string>;
  columnOrder: string[];
  onToggle: (key: string) => void;
  onReorder: (order: string[]) => void;
  onClose: () => void;
  // Optional admin actions — only wired when the grid has a `gridId`
  // (without an id there's no stable key to namespace per-grid org default).
  onSaveAsOrgDefault?: () => boolean;
  onResetToOrgDefault?: () => boolean;
}) {
  const { toast } = useToast();
  // SUPER_ADMIN is the only role allowed to publish an org-wide default.
  // Mirrors the gate in `src/components/layout/sidebar.tsx`.
  const isSuperAdmin = (() => {
    try {
      return getCurrentUser()?.role === "SUPER_ADMIN";
    } catch {
      return false;
    }
  })();
  const ref = useRef<HTMLDivElement>(null);
  const dragItem = useRef<number | null>(null);
  const dragOver = useRef<number | null>(null);

  // Order columns by columnOrder; exclude parent-hidden columns so users can't
  // toggle them on (parent's `hidden: true` is final / context-driven).
  const orderedColumns = useMemo(() => {
    const orderMap = new Map(columnOrder.map((k, i) => [k, i]));
    return columns.filter(c => c.hidden !== true).sort((a, b) => {
      const ai = orderMap.get(a.key) ?? 999;
      const bi = orderMap.get(b.key) ?? 999;
      return ai - bi;
    });
  }, [columns, columnOrder]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const handleDragStart = (idx: number) => {
    dragItem.current = idx;
  };

  const handleDragEnter = (idx: number) => {
    dragOver.current = idx;
  };

  const handleDragEnd = () => {
    if (dragItem.current === null || dragOver.current === null || dragItem.current === dragOver.current) {
      dragItem.current = null;
      dragOver.current = null;
      return;
    }
    const newOrder = orderedColumns.map(c => c.key);
    const [removed] = newOrder.splice(dragItem.current, 1);
    newOrder.splice(dragOver.current, 0, removed);
    onReorder(newOrder);
    dragItem.current = null;
    dragOver.current = null;
  };

  // Tap-to-move fallback for iPad operators — HTML5 drag-and-drop above
  // does not fire on iOS/iPadOS Safari, so the grip handle is a no-op on
  // tablets. The ↑/↓ buttons rendered next to each row let touch users
  // reorder one step at a time; desktop drag still works in parallel.
  const moveBy = (idx: number, delta: number) => {
    const newIdx = idx + delta;
    if (newIdx < 0 || newIdx >= orderedColumns.length) return;
    const newOrder = orderedColumns.map(c => c.key);
    const [removed] = newOrder.splice(idx, 1);
    newOrder.splice(newIdx, 0, removed);
    onReorder(newOrder);
  };

  return (
    <div
      ref={ref}
      className="absolute right-0 top-8 z-50 w-60 rounded border border-[#D0D0D0] bg-white shadow-lg"
         >
      <div className="border-b border-[#E5E5E5] px-3 py-2 text-[11px] font-semibold text-[#666] uppercase tracking-wide">
        Customization
      </div>
      <div className="max-h-[300px] overflow-y-auto py-1">
        {orderedColumns.map((col, idx) => (
          <div
            key={col.key}
            onDragEnter={() => handleDragEnter(idx)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => e.preventDefault()}
            className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#333] hover:bg-[#F5F3F0]"
          >
            {/* Drag handle — draggable is scoped to the grip icon only. When
              * the whole row was draggable, Chrome occasionally swallowed the
              * checkbox click (mousedown started a potential drag), leaving
              * the column "unremovable" from the user's POV. */}
            <span
              draggable
              onDragStart={(e) => {
                e.stopPropagation();
                handleDragStart(idx);
              }}
              className="cursor-grab active:cursor-grabbing shrink-0"
              title="Drag to reorder"
            >
              <svg className="h-3 w-3 text-[#BBB]" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
                <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
                <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
              </svg>
            </span>
            <label className="flex items-center gap-2 cursor-pointer flex-1 select-none">
              <input
                type="checkbox"
                checked={visibleKeys.has(col.key)}
                onChange={() => onToggle(col.key)}
                onMouseDown={(e) => e.stopPropagation()}
                className="h-3.5 w-3.5 rounded border-[#CCC] accent-[#6B5C32]"
              />
              {col.label}
            </label>
            {/* Touch fallback — HTML5 drag does not fire on iPad Safari.
                These buttons let tablet operators reorder one step at a
                time. Disabled at the edges so the visual affordance
                matches the constraint. */}
            <button
              type="button"
              onClick={() => moveBy(idx, -1)}
              disabled={idx === 0}
              className="shrink-0 px-1.5 py-0.5 text-[#6B5C32] disabled:text-[#D0D0D0] disabled:cursor-not-allowed hover:bg-[#F0ECE9] rounded"
              title="Move up"
              aria-label="Move column up"
            >
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 15 12 9 18 15" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => moveBy(idx, 1)}
              disabled={idx === orderedColumns.length - 1}
              className="shrink-0 px-1.5 py-0.5 text-[#6B5C32] disabled:text-[#D0D0D0] disabled:cursor-not-allowed hover:bg-[#F0ECE9] rounded"
              title="Move down"
              aria-label="Move column down"
            >
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        ))}
      </div>
      <div className="border-t border-[#E5E5E5] px-3 py-1.5">
        <button
          className="text-[11px] text-[#6B5C32] font-medium hover:underline"
          onClick={() => {
            columns.forEach(col => {
              if (!visibleKeys.has(col.key)) onToggle(col.key);
            });
          }}
        >
          Show All
        </button>
      </div>
      {(onSaveAsOrgDefault || onResetToOrgDefault) && (
        <div className="border-t border-[#E5E5E5] px-3 py-2 space-y-1.5 bg-[#FAF8F5]">
          {onSaveAsOrgDefault && isSuperAdmin && (
            <button
              type="button"
              className="flex w-full items-center gap-1.5 text-[11px] font-medium text-[#6B5C32] hover:underline"
              onClick={() => {
                const ok = onSaveAsOrgDefault();
                if (ok) {
                  toast.success(
                    "Saved as Org Default - new users on this browser will see this layout.",
                  );
                } else {
                  toast.error("Could not save org default.");
                }
              }}
              title="Publish current layout as the org-wide default"
            >
              <span aria-hidden>★</span>
              Save as Org Default
            </button>
          )}
          {onResetToOrgDefault && (
            <button
              type="button"
              className="flex w-full items-center gap-1.5 text-[10px] text-[#888] hover:text-[#555] hover:underline"
              onClick={() => {
                const ok = onResetToOrgDefault();
                if (ok) {
                  toast.success("Reset to Org Default.");
                } else {
                  toast.error("Could not reset to org default.");
                }
              }}
              title="Discard your personal layout and reload the org default"
            >
              Reset to Org Default
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Default Cell Renderers
// ---------------------------------------------------------------------------

function DefaultCellRenderer<T>({
  column,
  value,
  row,
  index,
}: {
  column: Column<T>;
  value: any;
  row: T;
  index: number;
}) {
  if (column.render) return <>{column.render(value, row, index)}</>;

  switch (column.type) {
    case "date":
      return <span className="tabular-nums">{formatDateDMY(value)}</span>;
    case "currency":
      return (
        <span className="tabular-nums">
          {typeof value === "number" ? formatRM(value) : value}
        </span>
      );
    case "number":
      return (
        <span className="tabular-nums">
          {typeof value === "number" ? formatNumber(value) : value}
        </span>
      );
    case "docno":
      return (
        <span className="tabular-nums">{value}</span>
      );
    case "status": {
      const colors = getStatusColor(String(value ?? ""));
      return (
        <span className={cn("inline-block rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-tight", colors.bg, colors.text)}>
          {String(value ?? "").replace(/_/g, " ")}
        </span>
      );
    }
    default:
      return <>{value != null ? String(value) : ""}</>;
  }
}

// ---------------------------------------------------------------------------
// DataGrid Component
// ---------------------------------------------------------------------------

export function DataGrid<T extends Record<string, any>>({
  columns,
  data,
  keyField,
  onDoubleClick,
  onRowClick,
  contextMenuItems,
  onSelectionChange,
  selectable = false,
  rowClassName,
  emptyMessage = "No data found.",
  loading = false,
  stickyHeader = true,
  maxHeight,
  className,
  gridId,
  groupBy,
  viewStorageKey,
  onFilteredDataChange,
  virtualize = false,
  defaultExcludedValues,
}: DataGridProps<T>) {
  // ── Column visibility & order ──
  // Two-tier persistence per gridId:
  //   1. Personal layout `datagrid-cols-${gridId}-${userKey()}` — written
  //      whenever the user toggles a column or drags to reorder. Always wins
  //      when present.
  //   2. Org default `datagrid-cols-${gridId}-org-default` — written by an
  //      admin via "Save as Org Default" inside the Columns popover. Used as
  //      INITIAL state for users who have not yet customized this grid (we
  //      do not copy it into Personal — letting their first toggle create
  //      the Personal entry).
  //   3. Falls back to the column definitions' `hidden` attribute.
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(() => {
    if (gridId && typeof window !== "undefined") {
      try {
        const personal = localStorage.getItem(`datagrid-cols-${gridId}-${userKey()}`);
        if (personal) return new Set(JSON.parse(personal));
        const orgDefault = localStorage.getItem(`datagrid-cols-${gridId}-org-default`);
        if (orgDefault) return new Set(JSON.parse(orgDefault));
      } catch { /* ignore */ }
    }
    return new Set(columns.filter(c => !c.hidden && !c.defaultHidden).map(c => c.key));
  });
  const [columnOrder, setColumnOrder] = useState<string[]>(() => {
    if (gridId && typeof window !== "undefined") {
      try {
        const personal = localStorage.getItem(`datagrid-colorder-${gridId}-${userKey()}`);
        if (personal) return JSON.parse(personal);
        const orgDefault = localStorage.getItem(`datagrid-colorder-${gridId}-org-default`);
        if (orgDefault) return JSON.parse(orgDefault);
      } catch { /* ignore */ }
    }
    return columns.map(c => c.key);
  });
  const [showCustomizer, setShowCustomizer] = useState(false);

  const toggleColumn = useCallback((key: string) => {
    setVisibleKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      if (gridId) {
        try { localStorage.setItem(`datagrid-cols-${gridId}-${userKey()}`, JSON.stringify([...next])); } catch { /* ignore */ }
      }
      return next;
    });
  }, [gridId]);

  const reorderColumns = useCallback((order: string[]) => {
    setColumnOrder(order);
    if (gridId) {
      try { localStorage.setItem(`datagrid-colorder-${gridId}-${userKey()}`, JSON.stringify(order)); } catch { /* ignore */ }
    }
  }, [gridId]);

  // Admin-only: snapshot the current Personal layout (visible columns + order)
  // into the org-default keys so future first-time viewers of this grid see
  // the curated layout. Personal layouts always still take precedence on
  // read, so this never clobbers a user who has already customized.
  const saveAsOrgDefault = useCallback((): boolean => {
    if (!gridId || typeof window === "undefined") return false;
    try {
      localStorage.setItem(
        `datagrid-cols-${gridId}-org-default`,
        JSON.stringify([...visibleKeys]),
      );
      localStorage.setItem(
        `datagrid-colorder-${gridId}-org-default`,
        JSON.stringify(columnOrder),
      );
      return true;
    } catch {
      return false;
    }
  }, [gridId, visibleKeys, columnOrder]);

  // Drop the user's Personal layout for this grid and re-seed state from the
  // Org Default (or column-definition defaults if no Org Default exists).
  const resetToOrgDefault = useCallback((): boolean => {
    if (!gridId || typeof window === "undefined") return false;
    try {
      localStorage.removeItem(`datagrid-cols-${gridId}-${userKey()}`);
      localStorage.removeItem(`datagrid-colorder-${gridId}-${userKey()}`);

      const orgCols = localStorage.getItem(`datagrid-cols-${gridId}-org-default`);
      const orgOrder = localStorage.getItem(`datagrid-colorder-${gridId}-org-default`);
      setVisibleKeys(
        orgCols
          ? new Set(JSON.parse(orgCols) as string[])
          : new Set(columns.filter(c => !c.hidden && !c.defaultHidden).map(c => c.key)),
      );
      setColumnOrder(
        orgOrder
          ? (JSON.parse(orgOrder) as string[])
          : columns.map(c => c.key),
      );
      return true;
    } catch {
      return false;
    }
  }, [gridId, columns]);

  // When the parent passes a new `columns` array (e.g., the production page
  // changes activeTab and rebuilds dept-pill columns, or BOM-driven upstream
  // adds a sibling column), sync local state:
  //   - Append new column keys to columnOrder (so they don't sort to 999/end)
  //   - For NEW visible-by-default keys not yet known, add to visibleKeys so
  //     the column renders.  Don't override user-toggled visibility.
  // The "first time we see this key" check is via columnOrder (a key exists
  // there as soon as the grid has acknowledged its existence).
  useEffect(() => {
    const known = new Set(columnOrder);
    const fresh: string[] = [];
    const newlyVisible: string[] = [];
    for (const c of columns) {
      if (!known.has(c.key)) {
        fresh.push(c.key);
        if (!c.hidden && !c.defaultHidden) newlyVisible.push(c.key);
      }
    }
    if (fresh.length === 0) return;
    setColumnOrder((prev) => {
      const next = [...prev, ...fresh];
      if (gridId) {
        try { localStorage.setItem(`datagrid-colorder-${gridId}-${userKey()}`, JSON.stringify(next)); } catch { /* ignore */ }
      }
      return next;
    });
    if (newlyVisible.length > 0) {
      setVisibleKeys((prev) => {
        const next = new Set(prev);
        for (const k of newlyVisible) next.add(k);
        if (gridId) {
          try { localStorage.setItem(`datagrid-cols-${gridId}-${userKey()}`, JSON.stringify([...next])); } catch { /* ignore */ }
        }
        return next;
      });
    }
  }, [columns, columnOrder, gridId]);

  const visibleColumns = useMemo(() => {
    const orderMap = new Map(columnOrder.map((k, i) => [k, i]));
    // Parent's `hidden: true` is final — it represents context-driven
    // visibility (e.g., production page hiding dept-pill columns based on
    // activeTab). User-toggled visibility (visibleKeys) only matters for
    // columns the parent has not force-hidden. This prevents stale visibleKeys
    // entries from causing body cells to drift into wrong header columns when
    // the parent switches contexts and changes which columns are hidden.
    return columns
      .filter(c => c.hidden !== true && visibleKeys.has(c.key))
      .sort((a, b) => (orderMap.get(a.key) ?? 999) - (orderMap.get(b.key) ?? 999));
  }, [columns, visibleKeys, columnOrder]);

  // Cumulative `left` offsets for sticky columns. We walk the leading run of
  // sticky columns (each requires an explicit pixel width) and accumulate
  // their widths. The optional `selectable` checkbox column is treated as the
  // first 32px when present so a freeze can sit beside it. Non-sticky columns
  // and any sticky column appearing after the leading run are ignored — the
  // freeze must be a contiguous left-edge group, otherwise <td> stacking
  // breaks. Returns a map: column key → left offset in pixels.
  const stickyOffsets = useMemo(() => {
    const out = new Map<string, number>();
    let acc = selectable ? 32 : 0;
    for (const col of visibleColumns) {
      if (!col.sticky) break; // contiguous leading run only
      out.set(col.key, acc);
      // Parse a pixel width like "170px"; if the column lacks one, give up
      // freezing later columns to avoid mis-aligned offsets.
      const m = col.width ? /^(\d+(?:\.\d+)?)px$/.exec(col.width) : null;
      if (!m) break;
      acc += parseFloat(m[1]);
    }
    return out;
  }, [visibleColumns, selectable]);

  // ── Search / Filter ──
  // Persisted in sessionStorage keyed by gridId so the search text and
  // column-filter selections survive tab switches within the same browser
  // session. Without this, the TabbedOutlet's mount-on-activate model wipes
  // every search the user types the moment they switch tabs (Wei Siang
  // report Apr 26 2026: 'I search something, switch tabs, come back, it's
  // gone'). sessionStorage clears on browser close — the user explicitly
  // wants the search to NOT persist across days, just across tab hops.
  const filterStoreKey = gridId ? `datagrid-filters-${gridId}-${userKey()}` : null;
  const readFilterState = (): {
    searchText: string;
    columnFilters: Record<string, string>;
    columnValueFilters: Record<string, string[]>;
  } | null => {
    if (!filterStoreKey || typeof window === "undefined") return null;
    try {
      const raw = sessionStorage.getItem(filterStoreKey);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  };
  const seeded = readFilterState();
  const [searchText, setSearchText] = useState(seeded?.searchText ?? "");
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>(
    seeded?.columnFilters ?? {},
  );
  const [columnValueFilters, setColumnValueFilters] = useState<Record<string, Set<string>>>(
    () => {
      if (!seeded?.columnValueFilters) return {};
      const out: Record<string, Set<string>> = {};
      for (const [k, v] of Object.entries(seeded.columnValueFilters)) {
        out[k] = new Set(v);
      }
      return out;
    },
  );
  // Track whether the operator has any saved filter state OR has touched
  // any value-filter dropdown. While both are false, we keep applying the
  // caller's defaultExcludedValues whenever new data arrives — so the
  // default "hide COMPLETED rows" behaviour kicks in on every fresh load.
  // Once they touch a filter, we stop overriding their choice.
  const hasInitialFilterState = !!seeded?.columnValueFilters && Object.keys(seeded.columnValueFilters).length > 0;
  const [valueFilterTouched, setValueFilterTouched] = useState<boolean>(hasInitialFilterState);

  // Apply defaultExcludedValues once after data loads (and again whenever
  // data shape changes, e.g. a new status value appears) — but only if
  // the operator hasn't manually touched the value filters in this grid.
  // We compute the allowed-values Set as (all values currently in data)
  // minus (the caller's excluded list), so e.g. excluding "COMPLETED" on
  // the Status column ticks every other status box on by default.
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot seed of value filters */
  useEffect(() => {
    if (valueFilterTouched) return;
    if (!defaultExcludedValues || data.length === 0) return;
    const next: Record<string, Set<string>> = {};
    for (const [colKey, excluded] of Object.entries(defaultExcludedValues)) {
      const col = columns.find((c) => c.key === colKey);
      const allValues = new Set<string>();
      for (const row of data) {
        const v = col?.filterAccessor
          ? String(col.filterAccessor(row) ?? "")
          : String(getNestedValue(row, colKey) ?? "");
        allValues.add(v);
      }
      for (const e of excluded) allValues.delete(e);
      // Skip the column entirely if no values remain — an all-excluded
      // filter would hide every row, the inverse of what we want.
      if (allValues.size > 0) next[colKey] = allValues;
    }
    setColumnValueFilters(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-runs only when data/defaults change
  }, [data, defaultExcludedValues, valueFilterTouched]);
  /* eslint-enable react-hooks/set-state-in-effect */
  // Push state changes back to sessionStorage on every change so a tab
  // switch picks up the latest snapshot.
  useEffect(() => {
    if (!filterStoreKey || typeof window === "undefined") return;
    try {
      sessionStorage.setItem(
        filterStoreKey,
        JSON.stringify({
          searchText,
          columnFilters,
          columnValueFilters: Object.fromEntries(
            Object.entries(columnValueFilters).map(([k, v]) => [k, Array.from(v)]),
          ),
        }),
      );
    } catch { /* ignore quota / serialize errors */ }
  }, [filterStoreKey, searchText, columnFilters, columnValueFilters]);
  const [filterDropdown, setFilterDropdown] = useState<{ key: string; rect: { left: number; top: number } } | null>(null);

  const setColFilter = useCallback((key: string, val: string) => {
    setColumnFilters(prev => ({ ...prev, [key]: val }));
  }, []);

  const setColValueFilter = useCallback((key: string, values: Set<string> | null) => {
    setValueFilterTouched(true);
    setColumnValueFilters(prev => {
      const next = { ...prev };
      if (!values) delete next[key];
      else next[key] = values;
      return next;
    });
  }, []);

  const clearColFilter = useCallback((key: string) => {
    setValueFilterTouched(true);
    setColumnFilters(prev => { const n = { ...prev }; delete n[key]; return n; });
    setColumnValueFilters(prev => { const n = { ...prev }; delete n[key]; return n; });
  }, []);

  // ── Sorting ──
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // ── Selection ──
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const lastClickedIndex = useRef<number | null>(null);

  // ── Context menu ──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; row: T } | null>(null);

  // ── Grouping state ──
  const [groupEnabled, setGroupEnabled] = useState(!!groupBy);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [groupFilter, setGroupFilter] = useState<Set<string> | null>(null); // null = show all
  const [showGroupDropdown, setShowGroupDropdown] = useState(false);

  // Sync groupEnabled when groupBy prop changes
  useEffect(() => { setGroupEnabled(!!groupBy); }, [groupBy]);

  // ── Saved Views ──
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => {
    if (viewStorageKey && typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem(`datagrid-views-${viewStorageKey}-${userKey()}`);
        if (raw) return JSON.parse(raw);
      } catch { /* ignore */ }
    }
    return [];
  });
  const [showViewsDropdown, setShowViewsDropdown] = useState(false);
  const [newViewName, setNewViewName] = useState("");
  const [showNewViewInput, setShowNewViewInput] = useState(false);
  const viewsDropdownRef = useRef<HTMLDivElement>(null);

  // Persist saved views to localStorage
  const persistViews = useCallback((views: SavedView[]) => {
    setSavedViews(views);
    if (viewStorageKey) {
      try { localStorage.setItem(`datagrid-views-${viewStorageKey}-${userKey()}`, JSON.stringify(views)); } catch { /* ignore */ }
    }
  }, [viewStorageKey]);

  const saveCurrentView = useCallback((name: string) => {
    if (!name.trim()) return;
    const view: SavedView = {
      name: name.trim(),
      filters: {
        searchText,
        columnFilters: { ...columnFilters },
        columnValueFilters: Object.fromEntries(
          Object.entries(columnValueFilters).map(([k, v]) => [k, Array.from(v)])
        ),
        sortKey,
        sortDir,
        groupEnabled,
        groupFilter: groupFilter ? Array.from(groupFilter) : null,
      },
    };
    persistViews([...savedViews, view]);
    setNewViewName("");
    setShowNewViewInput(false);
  }, [searchText, columnFilters, columnValueFilters, sortKey, sortDir, groupEnabled, groupFilter, savedViews, persistViews]);

  const applyView = useCallback((view: SavedView) => {
    setValueFilterTouched(true);
    const f = view.filters;
    setSearchText(f.searchText);
    setColumnFilters(f.columnFilters);
    setColumnValueFilters(
      Object.fromEntries(
        Object.entries(f.columnValueFilters).map(([k, v]) => [k, new Set(v)])
      )
    );
    setSortKey(f.sortKey);
    setSortDir(f.sortDir);
    setGroupEnabled(f.groupEnabled);
    setGroupFilter(f.groupFilter ? new Set(f.groupFilter) : null);
    setShowViewsDropdown(false);
  }, []);

  const deleteView = useCallback((index: number) => {
    persistViews(savedViews.filter((_, i) => i !== index));
  }, [savedViews, persistViews]);

  const resetAllFilters = useCallback(() => {
    setValueFilterTouched(true);
    setSearchText("");
    setColumnFilters({});
    setColumnValueFilters({});
    setSortKey(null);
    setSortDir("asc");
    setGroupEnabled(!!groupBy);
    setGroupFilter(null);
    setCollapsedGroups(new Set());
    setShowViewsDropdown(false);
  }, [groupBy]);

  // Close views dropdown on outside click
  useEffect(() => {
    if (!showViewsDropdown) return;
    function handleClick(e: MouseEvent) {
      if (viewsDropdownRef.current && !viewsDropdownRef.current.contains(e.target as Node)) {
        setShowViewsDropdown(false);
        setShowNewViewInput(false);
        setNewViewName("");
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setShowViewsDropdown(false);
        setShowNewViewInput(false);
        setNewViewName("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [showViewsDropdown]);

  const toggleGroupCollapse = useCallback((gv: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(gv)) next.delete(gv); else next.add(gv);
      return next;
    });
  }, []);

  // ── Filtered + Sorted data ──
  const filteredData = useMemo(() => {
    let result = data;

    // Global search
    if (searchText) {
      const lower = searchText.toLowerCase();
      result = result.filter(row =>
        visibleColumns.some(col => {
          const val = getNestedValue(row, col.key);
          return String(val ?? "").toLowerCase().includes(lower);
        })
      );
    }

    // Per-column text filters
    const activeFilters = Object.entries(columnFilters).filter(([, v]) => v);
    if (activeFilters.length > 0) {
      result = result.filter(row =>
        activeFilters.every(([key, val]) => matchesFilter(getNestedValue(row, key), val))
      );
    }

    // Per-column value filters (checkbox-based). filterAccessor on the
    // column wins over the raw key so e.g. dept-status columns can store
    // a sort number on .key but filter on a "Pending/Overdue/Done" label.
    const activeValueFilters = Object.entries(columnValueFilters);
    if (activeValueFilters.length > 0) {
      result = result.filter(row =>
        activeValueFilters.every(([key, allowedValues]) => {
          const col = columns.find((c) => c.key === key);
          const v = col?.filterAccessor
            ? String(col.filterAccessor(row) ?? "")
            : String(getNestedValue(row, key) ?? "");
          return allowedValues.has(v);
        })
      );
    }

    return result;
  }, [data, searchText, columnFilters, columnValueFilters, visibleColumns]);

  // All unique group values (for group filter dropdown)
  const allGroupValues = useMemo(() => {
    if (!groupBy) return [];
    const vals = new Set<string>();
    for (const row of filteredData) {
      vals.add(String(getNestedValue(row, groupBy) ?? "—"));
    }
    return Array.from(vals).sort();
  }, [groupBy, filteredData]);

  const sortedData = useMemo(() => {
    let result = [...filteredData];

    // Apply group filter (only when grouping is active)
    if (groupBy && groupEnabled && groupFilter) {
      result = result.filter(row => {
        const gv = String(getNestedValue(row, groupBy) ?? "—");
        return groupFilter.has(gv);
      });
    }

    // Primary sort by groupBy column (if grouping enabled), then by user sort.
    // Look up column.sortAccessor from sortKey so columns whose displayed
    // value is computed (e.g. via an external Map lookup) sort by that
    // computed value instead of always returning undefined from
    // getNestedValue.
    const sortCol = sortKey ? columns.find((c) => c.key === sortKey) : null;
    const sortRead = sortCol?.sortAccessor;
    if ((groupBy && groupEnabled) || sortKey) {
      result.sort((a, b) => {
        if (groupBy && groupEnabled) {
          const ga = getNestedValue(a, groupBy);
          const gb = getNestedValue(b, groupBy);
          const gc = compareValues(ga, gb);
          if (gc !== 0) return gc;
        }
        if (sortKey) {
          const va = sortRead ? sortRead(a) : getNestedValue(a, sortKey);
          const vb = sortRead ? sortRead(b) : getNestedValue(b, sortKey);
          const vc = compareValues(va, vb);
          return sortDir === "desc" ? -vc : vc;
        }
        return 0;
      });
    }
    return result;
  }, [filteredData, sortKey, sortDir, groupBy, groupEnabled, groupFilter, columns]);

  // ── Virtualization ──
  // Only enable when explicitly opted-in AND no group headers are interleaved
  // (collapsing groups would require a separate flat-index → row-or-header
  // model that's not worth the complexity for v1). When disabled, the
  // virtualizer still mounts but its result is ignored — keeping hook order
  // stable across renders is non-negotiable.
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizationActive = virtualize && !(groupBy && groupEnabled);
  // Single source of truth for the per-row height. Used by both the
  // virtualizer's estimateSize and the body padding math below — without
  // sharing one constant, the padding calc could fall out of sync with
  // the virtualizer's height model and reintroduce the alignment drift
  // that VIRTUALIZE_MIN_ROWS tries to mask. Must match the inline
  // `style={{ height: "26px" }}` on each row's <td>.
  const ROW_HEIGHT_PX = 26;
  const rowVirtualizer = useVirtualizer({
    count: virtualizationActive ? sortedData.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 8,
  });

  // ── Handlers ──
  const handleSort = useCallback((col: Column<T>) => {
    if (col.sortable === false) return;
    if (sortKey === col.key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(col.key); setSortDir("asc"); }
  }, [sortKey]);

  const handleRowClick = useCallback((e: React.MouseEvent, row: T, index: number) => {
    const key = String(getNestedValue(row, keyField));
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (e.shiftKey && lastClickedIndex.current !== null) {
        const start = Math.min(lastClickedIndex.current, index);
        const end = Math.max(lastClickedIndex.current, index);
        for (let i = start; i <= end; i++) {
          next.add(String(getNestedValue(sortedData[i], keyField)));
        }
      } else if (e.ctrlKey || e.metaKey) {
        if (next.has(key)) next.delete(key);
        else next.add(key);
      } else {
        next.clear();
        next.add(key);
      }
      return next;
    });
    lastClickedIndex.current = index;
    onRowClick?.(row);
  }, [keyField, sortedData, onRowClick]);

  useEffect(() => {
    if (!onSelectionChange) return;
    const selected = sortedData.filter(row => selectedKeys.has(String(getNestedValue(row, keyField))));
    onSelectionChange(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKeys]);

  // Mirror the grid's internal filter + sort result back to the parent.
  // Scoped to the stable identity of `onFilteredDataChange` so a caller
  // that passes a non-memoised callback doesn't trigger an infinite loop.
  useEffect(() => {
    if (!onFilteredDataChange) return;
    onFilteredDataChange(sortedData);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedData]);

  const handleContextMenu = useCallback((e: React.MouseEvent, row: T) => {
    if (!contextMenuItems) return;
    e.preventDefault();
    const key = String(getNestedValue(row, keyField));
    setSelectedKeys(new Set([key]));
    setCtxMenu({ x: e.clientX, y: e.clientY, row });
  }, [contextMenuItems, keyField]);

  // Tablet UX: open the same context menu via a tap on the row's kebab
  // button. Anchors the menu to the kebab's bottom-right so it appears
  // exactly where the operator's finger expects, instead of at click coords.
  const handleKebabTap = useCallback((e: React.MouseEvent, row: T) => {
    if (!contextMenuItems) return;
    e.stopPropagation();
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const key = String(getNestedValue(row, keyField));
    setSelectedKeys(new Set([key]));
    setCtxMenu({ x: rect.right, y: rect.bottom, row });
  }, [contextMenuItems, keyField]);

  const resolvedCtxItems = useMemo(() => {
    if (!ctxMenu || !contextMenuItems) return [];
    if (typeof contextMenuItems === "function") return contextMenuItems(ctxMenu.row);
    return contextMenuItems.map(item => ({ ...item, action: () => item.action(ctxMenu.row) }));
  }, [ctxMenu, contextMenuItems]);

  const alignClass = (col: Column<T>) => {
    if (col.align === "right" || col.type === "currency" || col.type === "number") return "text-right";
    if (col.align === "center") return "text-center";
    return "text-left";
  };

  const activeFilterCount = Object.values(columnFilters).filter(Boolean).length + Object.keys(columnValueFilters).length + (searchText ? 1 : 0);

  // Tablet UX: when a row has any context-menu items (static array OR
  // a function — the function only resolves per-row, so we can only
  // assume "yes" here), render a kebab column. Operators on iPad can
  // tap to open the same menu that desktop right-click reveals.
  const hasContextMenu = !!contextMenuItems;

  return (
    <div className={cn("flex flex-col", className)}>
      {/* Toolbar */}
      {/* Tablet UX: bumped from py-1.5 / text-[11px] / h-~26px to h-9 (36px)
          search + h-9 buttons. Per-control sizing notes inline below. */}
      <div className="flex items-center gap-2 border border-b-0 border-[#E2DDD8] bg-[#FAFAF8] px-2 py-1.5 rounded-t">
        {/* Search — h-9 / text-sm for finger-target on iPad Safari */}
        <div className="relative flex-1 max-w-[280px]">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[#999]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            placeholder="Search..."
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            className="w-full rounded border border-[#DDD] bg-white h-9 pl-8 pr-7 text-sm text-[#333] placeholder-[#AAA] focus:border-[#6B5C32] focus:outline-none"
          />
          {searchText && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[#AAA] hover:text-[#666] p-1"
              onClick={() => setSearchText("")}
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          )}
        </div>

        {/* Clear filters */}
        {activeFilterCount > 0 && (
          <button
            className="flex items-center gap-1 text-sm text-[#6B5C32] hover:text-[#4D4224] font-medium"
            onClick={() => { setValueFilterTouched(true); setSearchText(""); setColumnFilters({}); setColumnValueFilters({}); }}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M18 6 6 18M6 6l12 12" /></svg>
            Clear {activeFilterCount} filter{activeFilterCount > 1 ? "s" : ""}
          </button>
        )}

        <div className="flex-1" />

        {/* Group toggle + filter (only when groupBy prop is set) */}
        {groupBy && (
          <div className="relative flex items-center gap-1">
            <button
              className={cn(
                "flex items-center gap-1 rounded border h-9 px-3 text-sm font-medium transition-colors",
                groupEnabled ? "border-[#6B5C32] bg-[#6B5C32]/10 text-[#6B5C32]" : "border-[#DDD] text-[#666] hover:border-[#999]"
              )}
              onClick={() => { setGroupEnabled(v => !v); setCollapsedGroups(new Set()); setGroupFilter(null); }}
              title={groupEnabled ? "Disable grouping" : "Enable grouping"}
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              Group
            </button>
            {groupEnabled && allGroupValues.length > 1 && (
              <button
                className={cn(
                  "flex items-center gap-1 rounded border h-9 px-3 text-sm font-medium transition-colors",
                  groupFilter ? "border-[#6B5C32] bg-[#6B5C32]/10 text-[#6B5C32]" : "border-[#DDD] text-[#666] hover:border-[#999]"
                )}
                onClick={() => setShowGroupDropdown(v => !v)}
                title="Filter groups"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
                {groupFilter ? `${groupFilter.size}/${allGroupValues.length}` : "All"}
              </button>
            )}
            {showGroupDropdown && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-white border border-[#DDD] rounded-lg shadow-lg p-2 min-w-[160px]">
                <div className="text-[10px] text-[#999] px-1 pb-1 border-b border-[#EEE] mb-1">Filter by group</div>
                <label className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-[#333] hover:bg-[#F5F5F5] rounded cursor-pointer">
                  <input
                    type="checkbox"
                    className="h-3 w-3 accent-[#6B5C32]"
                    checked={!groupFilter}
                    onChange={() => { setGroupFilter(null); setShowGroupDropdown(false); }}
                  />
                  <span className="font-medium">All</span>
                </label>
                {allGroupValues.map(gv => (
                  <label key={gv} className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-[#333] hover:bg-[#F5F5F5] rounded cursor-pointer">
                    <input
                      type="checkbox"
                      className="h-3 w-3 accent-[#6B5C32]"
                      checked={groupFilter ? groupFilter.has(gv) : true}
                      onChange={() => {
                        setGroupFilter(prev => {
                          const current = prev || new Set(allGroupValues);
                          const next = new Set(current);
                          if (next.has(gv)) next.delete(gv); else next.add(gv);
                          // If all selected again, revert to null (= all)
                          if (next.size === allGroupValues.length) return null;
                          if (next.size === 0) return prev; // don't allow empty
                          return next;
                        });
                      }}
                    />
                    {gv}
                  </label>
                ))}
                <button
                  className="mt-1 w-full text-[10px] text-[#6B5C32] hover:underline text-center py-0.5"
                  onClick={() => setShowGroupDropdown(false)}
                >
                  Done
                </button>
              </div>
            )}
          </div>
        )}

        {/* Saved Views */}
        {viewStorageKey && (
          <div className="relative" ref={viewsDropdownRef}>
            <button
              className={cn(
                "flex items-center gap-1 rounded border h-9 px-3 text-sm font-medium transition-colors",
                showViewsDropdown ? "border-[#6B5C32] bg-[#6B5C32]/10 text-[#6B5C32]" : "border-[#DDD] text-[#666] hover:border-[#999]"
              )}
              onClick={() => { setShowViewsDropdown(v => !v); setShowNewViewInput(false); setNewViewName(""); }}
              title="Saved Views"
            >
              {/* Bookmark icon (lucide-react style) */}
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
              </svg>
              Views
              {savedViews.length > 0 && (
                <span className="ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#6B5C32] px-1 text-[9px] font-semibold text-white leading-none">
                  {savedViews.length}
                </span>
              )}
            </button>
            {showViewsDropdown && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-white border border-[#DDD] rounded-lg shadow-lg min-w-[200px]">
                <div className="text-[10px] text-[#999] px-3 py-1.5 border-b border-[#EEE] font-medium uppercase tracking-wide">
                  Saved Views
                </div>
                {savedViews.length === 0 && !showNewViewInput && (
                  <div className="px-3 py-2 text-[11px] text-[#AAA] italic">No saved views yet</div>
                )}
                {savedViews.map((view, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1 px-3 min-h-[32px] py-1 text-sm text-[#333] hover:bg-[#F5F3F0] cursor-pointer group"
                    onClick={() => applyView(view)}
                  >
                    <svg className="h-3.5 w-3.5 text-[#999] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
                    </svg>
                    <span className="flex-1 truncate">{view.name}</span>
                    {/* Tablet has no hover — always visible. Kept compact. */}
                    <button
                      className="flex h-5 w-5 items-center justify-center rounded hover:bg-[#E0E0E0] text-[#AAA] hover:text-[#666] shrink-0"
                      onClick={(e) => { e.stopPropagation(); deleteView(i); }}
                      title="Delete view"
                    >
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path d="M18 6 6 18M6 6l12 12" /></svg>
                    </button>
                  </div>
                ))}
                <div className="border-t border-[#EEE]">
                  {showNewViewInput ? (
                    <div className="flex items-center gap-1 px-2 py-1.5">
                      <input
                        type="text"
                        placeholder="View name..."
                        value={newViewName}
                        onChange={e => setNewViewName(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") saveCurrentView(newViewName); if (e.key === "Escape") { setShowNewViewInput(false); setNewViewName(""); } }}
                        className="flex-1 rounded border border-[#D0D0D0] bg-white py-1 px-2 text-[11px] text-[#333] placeholder-[#AAA] focus:border-[#6B5C32] focus:outline-none"
                        autoFocus
                      />
                      <button
                        className="rounded border border-[#6B5C32] bg-[#6B5C32] px-2 py-1 text-[10px] text-white hover:bg-[#4D4224] disabled:opacity-40"
                        onClick={() => saveCurrentView(newViewName)}
                        disabled={!newViewName.trim()}
                      >
                        Save
                      </button>
                    </div>
                  ) : (
                    <button
                      className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] text-[#6B5C32] font-medium hover:bg-[#F5F3F0]"
                      onClick={() => setShowNewViewInput(true)}
                    >
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 5v14M5 12h14" /></svg>
                      Save Current View
                    </button>
                  )}
                </div>
                <div className="border-t border-[#EEE]">
                  <button
                    className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] text-[#888] hover:text-[#555] hover:bg-[#F5F3F0]"
                    onClick={resetAllFilters}
                  >
                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M18 6 6 18M6 6l12 12" /></svg>
                    Reset All Filters
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Column customizer */}
        <div className="relative">
          <button
            className={cn(
              "flex items-center gap-1 rounded border h-9 px-3 text-sm font-medium transition-colors",
              showCustomizer ? "border-[#6B5C32] bg-[#6B5C32]/10 text-[#6B5C32]" : "border-[#DDD] text-[#666] hover:border-[#999]"
            )}
            onClick={() => setShowCustomizer(!showCustomizer)}
            title="Customize Columns"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
            Columns
          </button>
          {showCustomizer && (
            <ColumnCustomizer
              columns={columns}
              visibleKeys={visibleKeys}
              columnOrder={columnOrder}
              onToggle={toggleColumn}
              onReorder={reorderColumns}
              onClose={() => setShowCustomizer(false)}
              onSaveAsOrgDefault={gridId ? saveAsOrgDefault : undefined}
              onResetToOrgDefault={gridId ? resetToOrgDefault : undefined}
            />
          )}
        </div>

        {/* Row count */}
        <span className="text-[10px] text-[#999] tabular-nums">
          {sortedData.length} of {data.length} records
        </span>
      </div>

      {/* Table */}
      <div
        ref={scrollRef}
        className="overflow-auto border border-[#E2DDD8] rounded-b"
        style={{ maxHeight: maxHeight || "calc(100vh - 240px)" }}
      >
        <table
          className="w-full border-collapse text-[12px]"
          // table-layout:auto lets the browser redistribute width when a
          // column is hidden via the Columns picker. The previous default
          // (no explicit table-layout) caused the cached `<colgroup>` widths
          // to lock in place after the first render — when a column was
          // toggled off, the browser kept the old widths AND the data cells
          // drifted into the wrong slot. Explicit `auto` re-runs the layout
          // algorithm on every change to <colgroup>, keeping <thead> and
          // <tbody> aligned. (Apr 2026 Wei Siang report.)
          style={{ tableLayout: "auto" }}
        >
          <colgroup>
            {selectable && <col style={{ width: "32px" }} />}
            {visibleColumns.map(col => (
              <col
                key={col.key}
                style={col.width ? { width: col.width, minWidth: col.width } : undefined}
              />
            ))}
            {/* Kebab column — renders only when contextMenuItems is set
                so list pages without row actions stay unchanged. */}
            {hasContextMenu && <col style={{ width: "40px" }} />}
          </colgroup>

          <thead className={cn(stickyHeader && "sticky top-0 z-10")}>
            {/* Header row */}
            <tr className="border-b border-[#D0D0D0] bg-[#F0ECE9]">
              {selectable && (
                <th className="px-2 py-1.5 text-center bg-[#F0ECE9]">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[#6B5C32] cursor-pointer"
                    checked={sortedData.length > 0 && sortedData.every(r => selectedKeys.has(String(getNestedValue(r, keyField))))}
                    onChange={(e) => {
                      e.stopPropagation();
                      setSelectedKeys(prev => {
                        const next = new Set(prev);
                        const allKeys = sortedData.map(r => String(getNestedValue(r, keyField)));
                        const allSelected = allKeys.every(k => next.has(k));
                        if (allSelected) {
                          allKeys.forEach(k => next.delete(k));
                        } else {
                          allKeys.forEach(k => next.add(k));
                        }
                        return next;
                      });
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                </th>
              )}
              {visibleColumns.map(col => {
                const hasValueFilter = columnValueFilters[col.key] != null;
                const hasTextFilter = !!columnFilters[col.key];
                const hasFilter = hasValueFilter || hasTextFilter;
                const stickyLeft = stickyOffsets.get(col.key);
                const isSticky = stickyLeft !== undefined;
                return (
                  <th
                    key={col.key}
                    className={cn(
                      "whitespace-nowrap px-2 py-1.5 text-[11px] font-semibold text-[#333] relative",
                      alignClass(col),
                      "select-none",
                      // Sticky header cells need bg-[#F0ECE9] explicitly; the
                      // parent <thead>/<tr>'s class doesn't paint <th> boxes,
                      // so without this scrolled body content shows through.
                      // z-20 sits above the body's sticky cells (z-10) AND
                      // above stickyHeader's z-10, keeping the corner cell on
                      // top during simultaneous H+V scroll.
                      isSticky && "sticky bg-[#F0ECE9] z-20",
                    )}
                    style={isSticky ? { left: `${stickyLeft}px` } : undefined}
                  >
                    <span
                      className={cn(
                        "inline-flex items-center gap-0.5",
                        (col.align === "right" || col.type === "currency" || col.type === "number") && "flex-row-reverse"
                      )}
                    >
                      {/* Tablet UX: label + sort arrows form one tappable
                          area (single onClick on a wrapping span). Filter
                          funnel stays separate so it doesn't trigger a
                          sort when tapped. Sort triangles bumped from
                          text-[7px] to text-[10px]. */}
                      <span
                        className="inline-flex items-center gap-0.5 cursor-pointer hover:text-[#000] hover:bg-[#E5E5E5] rounded px-0.5 py-0.5"
                        onClick={() => handleSort(col)}
                      >
                        <span>{col.label}</span>
                        <span className="inline-flex flex-col text-[10px] leading-none ml-0.5">
                          <span className={sortKey === col.key && sortDir === "asc" ? "text-[#333]" : "text-[#CCC]"}>▲</span>
                          <span className={sortKey === col.key && sortDir === "desc" ? "text-[#333]" : "text-[#CCC]"}>▼</span>
                        </span>
                      </span>
                      {/* Filter funnel: bumped 16px → 28px (h-7 w-7) for
                          tablet tap target. Glyph also bumped from 8px
                          to text-xs (12px) so it's actually visible. */}
                      <button
                        className={cn(
                          "ml-0.5 inline-flex items-center justify-center h-7 w-7 rounded hover:bg-[#D8D8D8] transition-colors text-xs",
                          hasFilter ? "text-[#6B5C32]" : "text-[#AAA] hover:text-[#666]"
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setFilterDropdown(prev =>
                            prev?.key === col.key ? null : { key: col.key, rect: { left: rect.left, top: rect.bottom + 2 } }
                          );
                        }}
                        title="Filter"
                      >
                        ▼
                      </button>
                    </span>
                  </th>
                );
              })}
              {hasContextMenu && (
                <th
                  className="px-1 py-1.5 text-center bg-[#F0ECE9]"
                  aria-label="Row actions"
                />
              )}
            </tr>

          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={visibleColumns.length + (selectable ? 1 : 0) + (hasContextMenu ? 1 : 0)} className="py-8 text-center text-[12px] text-[#999]">
                  <span className="inline-block animate-pulse">Loading...</span>
                </td>
              </tr>
            ) : sortedData.length === 0 ? (
              <tr>
                <td colSpan={visibleColumns.length + (selectable ? 1 : 0) + (hasContextMenu ? 1 : 0)} className="py-8 text-center text-[12px] text-[#999]">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              (() => {
                // Renders one data row. Extracted so both the legacy
                // render-all-rows path and the virtualized windowed path
                // share identical markup / handlers.
                const renderDataRow = (row: T, index: number) => {
                  const key = String(getNestedValue(row, keyField));
                  const isSelected = selectedKeys.has(key);
                  const isEven = index % 2 === 1;
                  return (
                    <tr
                      key={key}
                      className={cn(
                        // Tablet: min-h-[40px] for finger-friendly row height
                        // when selectable=true; otherwise keep the dense default
                        // so non-selectable list pages stay information-dense.
                        "border-b border-[#E2DDD8] text-[12px] text-[#111]",
                        selectable && "min-h-[40px]",
                        isEven && "bg-[#FAFAFA]",
                        rowClassName?.(row),
                        isSelected && "!bg-[#CCE0FF] border-l-2 border-l-[#3366CC]",
                        !isSelected && "hover:bg-[#F0ECE9]",
                        (onDoubleClick || onRowClick) && "cursor-pointer"
                      )}
                      onClick={e => handleRowClick(e, row, index)}
                      onDoubleClick={() => onDoubleClick?.(row)}
                      onContextMenu={e => handleContextMenu(e, row)}
                    >
                      {selectable && (
                        <td
                          className="p-2 text-center cursor-pointer"
                          style={{ minHeight: "40px" }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedKeys(prev => {
                              const next = new Set(prev);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            });
                          }}
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[#6B5C32] cursor-pointer pointer-events-none"
                            checked={isSelected}
                            // Cell-wrapper handles toggle so the entire cell
                            // is a tap target on tablet. The input itself is
                            // pointer-events-none + readOnly to avoid double-
                            // toggle when the input is tapped directly.
                            readOnly
                          />
                        </td>
                      )}
                      {visibleColumns.map(col => {
                        const value = getNestedValue(row, col.key);
                        const stickyLeft = stickyOffsets.get(col.key);
                        const isSticky = stickyLeft !== undefined;
                        return (
                          <td
                            key={col.key}
                            className={cn(
                              "whitespace-nowrap px-2 py-[3px]",
                              alignClass(col),
                              // Sticky body cells must paint an opaque
                              // background that mirrors the row's bg state
                              // (zebra / rowClassName / selected) — <tr>
                              // backgrounds do not paint into child <td>
                              // boxes, so without this the cells go
                              // transparent and non-sticky cells scroll
                              // visibly underneath. We deliberately skip
                              // hover bg-tint on the sticky cell because
                              // hover styles target the <tr>, not its
                              // children; the static row colors are enough
                              // to keep the column readable during scroll.
                              isSticky && "sticky z-10 bg-white",
                              isSticky && isEven && "bg-[#FAFAFA]",
                              isSticky && rowClassName?.(row),
                              isSticky && isSelected && "!bg-[#CCE0FF]",
                            )}
                            style={{
                              height: "26px",
                              lineHeight: "20px",
                              ...(isSticky ? { left: `${stickyLeft}px` } : {}),
                            }}
                          >
                            <DefaultCellRenderer column={col} value={value} row={row} index={index} />
                          </td>
                        );
                      })}
                      {hasContextMenu && (
                        <td
                          className="px-1 text-center"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            className="inline-flex h-7 w-7 items-center justify-center rounded text-[#888] hover:bg-[#E0DCD7] hover:text-[#333] active:bg-[#D5D0CB]"
                            onClick={(e) => handleKebabTap(e, row)}
                            title="Row actions"
                            aria-label="Row actions"
                          >
                            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                              <circle cx="12" cy="5" r="1.6" />
                              <circle cx="12" cy="12" r="1.6" />
                              <circle cx="12" cy="19" r="1.6" />
                            </svg>
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                };

                // ── Virtualized path ──
                // Two spacer <tr>s (top/bottom) hold the height of the
                // off-screen rows so the scroll-container's scrollHeight
                // and per-pixel offsets match what they'd be if all rows
                // were rendered. Only `visible.length + 2` <tr> nodes
                // exist in the DOM at any time. Note that grouping is
                // disabled in this path (virtualizationActive guards it).
                //
                // ALIGNMENT GATE: original 2026-04-26 incident was that
                // tanstack-virtual's getTotalSize() lagged one render
                // behind a sharp count drop (e.g. column-filter narrows
                // 460→3), producing a giant stale paddingBottom and a
                // body that disagreed with the "X of Y records" badge
                // ("filter doesn't align" report, multiple sightings).
                // The fix landed at line ~1990 below: totalSize is now
                // computed directly from sortedData.length × ROW_HEIGHT_PX
                // — bypasses the lagging memo entirely. With that fix
                // shipped + the v.index<sortedData.length clip on the
                // virtualItems, the original race is closed.
                //
                // Lowered 2026-05-11 from 100 → 30: Fab Cut runs ~47
                // dept rows × ~25 cols × custom cell renderers (status
                // pills, date pickers, sticky cols), and at the 100-row
                // threshold it fell back to legacy non-virtualized
                // render — paying ~850ms initial mount per profile.
                // Below 30 rows the virtualizer's overhead exceeds its
                // gain, so legacy path stays for tiny lists (e.g.
                // /consignment with 6 rows). Bump back up if a future
                // race surfaces — one-line revert.
                const VIRTUALIZE_MIN_ROWS = 30;
                const useVirtualizedBody =
                  virtualizationActive && sortedData.length >= VIRTUALIZE_MIN_ROWS;
                if (useVirtualizedBody) {
                  // Clip virtualItems to the current sortedData length. The
                  // tanstack-virtual instance can transiently emit indices
                  // computed from a *previous* `count` value when the count
                  // shrinks sharply in the same tick that React passes new
                  // options — e.g., applying a column-value filter that
                  // narrows 460 rows down to 3. Its internal getMeasurements
                  // memo recomputes synchronously on the next call, but the
                  // body render uses whatever getVirtualItems() emits in this
                  // pass. Without an explicit clip, stale indices slipped
                  // through the body and rendered alongside the freshly
                  // filtered rows, producing a row count that disagreed with
                  // the "X of Y records" badge (Wei Siang's Apr 26 2026 Fab
                  // Cut report). Using `sortedData.length` as the upper bound
                  // mirrors the badge — body and badge are now derived from
                  // the same source of truth.
                  const rawVirtualItems = rowVirtualizer.getVirtualItems();
                  const virtualItems = rawVirtualItems.filter(
                    (v) => v.index < sortedData.length,
                  );
                  // Compute totalSize from sortedData.length × ROW_HEIGHT_PX
                  // instead of rowVirtualizer.getTotalSize(). The virtualizer's
                  // getTotalSize() lags one render behind a sharp count drop
                  // (filter narrows 460 → 3): its memo recomputes synchronously
                  // on the next pass, but THIS pass returns the stale 460-row
                  // total. paddingBottom then computes against the stale total,
                  // leaving thousands of pixels of empty space below the 3
                  // visible rows — the user sees their 3 filtered rows
                  // separated from the table footer by a giant blank gap, even
                  // though the badge correctly reads "3 of 3". The
                  // VIRTUALIZE_MIN_ROWS=100 gate masks the issue when the post-
                  // filter count crosses below the threshold (legacy path
                  // takes over) but NOT when both pre- and post-filter counts
                  // stay above 100 — which is the Fab Sew case (1,200 rows
                  // filtered down to ~150 still hits this code path). Driving
                  // totalSize from sortedData.length directly means body and
                  // footer are derived from the same source of truth in the
                  // SAME render pass, eliminating the drift.
                  const totalSize = sortedData.length * ROW_HEIGHT_PX;
                  const colSpan = visibleColumns.length + (selectable ? 1 : 0) + (hasContextMenu ? 1 : 0);
                  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
                  const paddingBottom =
                    virtualItems.length > 0
                      ? Math.max(0, totalSize - virtualItems[virtualItems.length - 1].end)
                      : 0;
                  const out: React.ReactNode[] = [];
                  if (paddingTop > 0) {
                    out.push(
                      <tr key="__virt_top__" aria-hidden="true">
                        <td colSpan={colSpan} style={{ height: `${paddingTop}px`, padding: 0, border: 0 }} />
                      </tr>
                    );
                  }
                  for (const v of virtualItems) {
                    const row = sortedData[v.index];
                    if (row) out.push(renderDataRow(row, v.index));
                  }
                  if (paddingBottom > 0) {
                    out.push(
                      <tr key="__virt_bot__" aria-hidden="true">
                        <td colSpan={colSpan} style={{ height: `${paddingBottom}px`, padding: 0, border: 0 }} />
                      </tr>
                    );
                  }
                  return out;
                }

                // ── Legacy / grouped path (renders every row) ──
                const rows: React.ReactNode[] = [];
                let lastGroup: string | null = null;
                // Pre-compute group counts if groupBy is set and enabled
                const groupCounts = new Map<string, number>();
                if (groupBy && groupEnabled) {
                  for (const row of sortedData) {
                    const gv = String(getNestedValue(row, groupBy) ?? "—");
                    groupCounts.set(gv, (groupCounts.get(gv) ?? 0) + 1);
                  }
                }

                sortedData.forEach((row, index) => {
                  // Group header
                  if (groupBy && groupEnabled) {
                    const gv = String(getNestedValue(row, groupBy) ?? "—");
                    if (gv !== lastGroup) {
                      lastGroup = gv;
                      const isCollapsed = collapsedGroups.has(gv);
                      rows.push(
                        <tr
                          key={`__group__${gv}`}
                          className="bg-[#E8E4DF] border-b border-[#D0CCC7] cursor-pointer hover:bg-[#DDD8D2] select-none"
                          onClick={() => toggleGroupCollapse(gv)}
                        >
                          <td
                            colSpan={visibleColumns.length + (selectable ? 1 : 0) + (hasContextMenu ? 1 : 0)}
                            className="px-3 py-1.5 text-[11px] font-bold text-[#4A4540]"
                          >
                            <span className="inline-block w-3 text-[9px] mr-1">{isCollapsed ? "▶" : "▼"}</span>
                            {gv} <span className="font-normal text-[#888] ml-1">({groupCounts.get(gv) ?? 0})</span>
                          </td>
                        </tr>
                      );
                    }
                    // Skip rows in collapsed groups
                    if (collapsedGroups.has(gv)) return;
                  }

                  rows.push(renderDataRow(row, index));
                });
                return rows;
              })()
            )}
          </tbody>
        </table>
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between border border-t-0 border-[#E2DDD8] bg-[#F0ECE9] px-3 py-1 rounded-b text-[10px] text-[#777]">
        <span>
          {selectedKeys.size > 0 ? `${selectedKeys.size} selected` : `Record 1 of ${sortedData.length}`}
        </span>
        <span>
          {data.length} total records
          {activeFilterCount > 0 && ` · ${activeFilterCount} filter${activeFilterCount > 1 ? "s" : ""} active`}
        </span>
      </div>

      {/* Column Filter Dropdown — Excel-style: the Values list shows
          only values that exist in the CURRENTLY FILTERED data
          (excluding this column's own filter). So if the operator has
          already filtered Customer = X, the Status dropdown only
          shows statuses that exist for Customer X — not every status
          in the entire dataset. */}
      {filterDropdown && (() => {
        const dropdownKey = filterDropdown.key;
        // Apply all filters except the current dropdown's column.
        let scopedData = data;
        if (searchText) {
          const lower = searchText.toLowerCase();
          scopedData = scopedData.filter((row) =>
            visibleColumns.some((col) => {
              const val = getNestedValue(row, col.key);
              return String(val ?? "").toLowerCase().includes(lower);
            }),
          );
        }
        const otherTextFilters = Object.entries(columnFilters).filter(
          ([k, v]) => v && k !== dropdownKey,
        );
        if (otherTextFilters.length > 0) {
          scopedData = scopedData.filter((row) =>
            otherTextFilters.every(([k, v]) =>
              matchesFilter(getNestedValue(row, k), v),
            ),
          );
        }
        const otherValueFilters = Object.entries(columnValueFilters).filter(
          ([k]) => k !== dropdownKey,
        );
        if (otherValueFilters.length > 0) {
          scopedData = scopedData.filter((row) =>
            otherValueFilters.every(([k, allowed]) => {
              const col = columns.find((c) => c.key === k);
              const v = col?.filterAccessor
                ? String(col.filterAccessor(row) ?? "")
                : String(getNestedValue(row, k) ?? "");
              return allowed.has(v);
            }),
          );
        }
        return (
          <ColumnFilterDropdown
            columnKey={dropdownKey}
            columnType={columns.find((c) => c.key === dropdownKey)?.type}
            filterAccessor={columns.find((c) => c.key === dropdownKey)?.filterAccessor}
            allData={scopedData}
            activeValues={columnValueFilters[dropdownKey] ?? null}
            textFilter={columnFilters[dropdownKey] || ""}
            onApplyValues={(values) => setColValueFilter(dropdownKey, values)}
            onApplyText={(text, mode) => {
              const val = mode && mode !== "contains" ? `${mode}:${text}` : text;
              setColFilter(dropdownKey, val);
            }}
            onClear={() => clearColFilter(dropdownKey)}
            onClose={() => setFilterDropdown(null)}
            anchorRect={filterDropdown.rect}
          />
        );
      })()}

      {/* Context Menu */}
      {ctxMenu && resolvedCtxItems.length > 0 && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={resolvedCtxItems} onClose={() => setCtxMenu(null)} />
      )}
    </div>
  );
}
