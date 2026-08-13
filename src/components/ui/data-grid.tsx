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
  useDeferredValue,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn, formatDateDMY, formatNumber, formatRM, getStatusColor } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth";
import { fetchJson, passthrough } from "@/lib/fetch-json";
import { useToast } from "@/components/ui/toast";
import { Skeleton } from "@/components/ui/skeleton";
import { buildListingAoa, exportFilename, type ExportColumn } from "@/lib/grid-export";
import { exportReportCsv, exportReportXlsx, type Aoa } from "@/lib/export-report";

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
// Org-wide layout presets (server-persisted) — see
// src/api/routes/datagrid-layouts.ts.
//
// The "Save as Org Default" and the print preset ("Save as Production
// Schedule") are ORG-WIDE: persisted to the backend so any user on any browser
// loads them. The PERSONAL layout stays in localStorage (per-user-per-browser).
//
// These helpers funnel through fetchJson so the session cookie travels
// (credentials:'include') AND the CSRF double-submit header is attached on the
// mutating PUT/DELETE automatically. Every call is best-effort: on ANY failure
// we swallow + fall back to the existing localStorage behavior so a grid never
// breaks (backward compatible).
// ---------------------------------------------------------------------------
type ServerLayoutPreset = {
  visibleCols: string[];
  colOrder: string[];
  colWidths: Record<string, string> | null;
};

async function fetchOrgLayouts(
  gridId: string,
): Promise<{ orgDefault: ServerLayoutPreset | null; print: ServerLayoutPreset | null } | null> {
  try {
    const res = (await fetchJson(
      `/api/datagrid-layouts?gridId=${encodeURIComponent(gridId)}`,
      passthrough,
    )) as {
      success?: boolean;
      orgDefault?: ServerLayoutPreset | null;
      print?: ServerLayoutPreset | null;
    };
    return {
      orgDefault: res?.orgDefault ?? null,
      print: res?.print ?? null,
    };
  } catch {
    return null;
  }
}

async function putOrgLayout(
  gridId: string,
  kind: "org-default" | "print",
  visibleCols: string[],
  colOrder: string[],
  colWidths?: Record<string, string> | null,
): Promise<boolean> {
  try {
    await fetchJson(`/api/datagrid-layouts`, passthrough, {
      method: "PUT",
      body: { gridId, kind, visibleCols, colOrder, colWidths: colWidths ?? null },
    });
    return true;
  } catch {
    return false;
  }
}

async function deleteOrgLayout(
  gridId: string,
  kind: "org-default" | "print",
): Promise<boolean> {
  try {
    await fetchJson(
      `/api/datagrid-layouts?gridId=${encodeURIComponent(gridId)}&kind=${kind}`,
      passthrough,
      { method: "DELETE" },
    );
    return true;
  } catch {
    return false;
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
  // `highlight` wraps the matched global-search term in the cell text (Wei
  // Siang 2026-06-15). Optional + additive — renders that ignore it are
  // unchanged; text-bearing renders should wrap their displayed string with it
  // so a search match is visible (e.g. the comma-joined SO / Customer-PO cols).
  render?: (
    value: any,
    row: T,
    index: number,
    highlight: (text: string) => React.ReactNode,
  ) => React.ReactNode;
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
  // Opt OUT of the default cell clipping. By default every cell truncates its
  // content to the column's resolved width (ellipsis on overflow) so a long
  // value — e.g. a comma-joined SO list — can't balloon the column; dragging
  // the column wider reveals more. Set `noClip: true` for the rare cell that
  // must wrap or render multi-line content.
  noClip?: boolean;
  // Plain value this column contributes to a WYSIWYG export. Defaults to the
  // filterAccessor, then the raw path value (currency sen→RM number, date→day).
  // Set this for columns whose real value is computed in `render` and has no
  // usable raw/filter value.
  exportValue?: (row: T) => string | number | null;
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
  // Row selection lives INSIDE the grid (`selectedKeys`), so a page that
  // empties its own mirror of the selection leaves every checkbox still
  // ticked — a "Clear" button that visibly clears nothing. Bump this number
  // to clear the grid's own selection; any change to it wipes selectedKeys.
  // Undefined (the default) never clears, so existing grids are untouched.
  clearSelectionToken?: number;
  rowClassName?: (row: T) => string;
  emptyMessage?: string;
  loading?: boolean;
  stickyHeader?: boolean;
  maxHeight?: string;
  className?: string;
  gridId?: string; // unique key for persisting column visibility in localStorage
  // When set (and gridId present), the Columns popover shows a "Save as <label>"
  // button that snapshots the CURRENT visible columns + order into a dedicated
  // print preset (`datagrid-cols-${gridId}-print`). A printout can then read that
  // preset to use a curated layout independent of the on-screen view. NOT admin-
  // gated — it's a per-browser print layout the operator owns. (Wei Siang #25.)
  printPresetLabel?: string;
  groupBy?: string; // column key to group rows by — inserts group header rows
  // When `groupBy` is set, grouping is auto-enabled on first render by
  // default. Pass `autoGroup={false}` to keep the grid FLAT on open — the
  // "Group" toggle button still shows so the operator can group on demand.
  autoGroup?: boolean;
  // Enables Saved Views (named filter/sort/grouping snapshots) and prefixes
  // their localStorage key. DEFAULTS TO `gridId` — the feature was fully built
  // (save / apply / delete / reset, persisted per user) but no page ever passed
  // this prop, so the whole thing was unreachable. Defaulting it means any grid
  // that already declares a gridId gets Views under that same stable key.
  // Pass it explicitly only to deviate; pass "" to opt a grid out.
  viewStorageKey?: string;
  // Fires whenever the currently filtered + sorted rows change. Lets the
  // parent mirror the grid's internal filter state — e.g. to scope a
  // "Print" action or a QR-sticker row to exactly what the user sees.
  onFilteredDataChange?: (rows: T[]) => void;
  // Enables the toolbar Export button. `exportName` is the filename base. The
  // built-in "Listing" export is WYSIWYG — the CURRENT visible columns (in
  // order) over the CURRENT filtered+sorted rows. `detailExport` adds a second
  // option (e.g. an AutoCount per-line "Detail Listing"); it is handed the same
  // filtered+sorted rows so it honours the on-screen filter too.
  exportName?: string;
  exportSheetLabel?: string;
  detailExport?: { label: string; build: (rows: T[]) => Aoa };
  // Fires whenever the global search text changes. Lets the parent react
  // to "user is searching" — e.g. switch a server-paginated fetch to a
  // whole-dataset fetch so the search covers every record, not just the
  // currently loaded page.
  onSearchChange?: (query: string) => void;
  // Seeds the grid's internal search box on mount only (useState initializer).
  // Lets a parent that remounts the grid — e.g. a tab switch that unmounts the
  // old grid and mounts a fresh one — carry the active search term across so
  // the new grid opens already filtered instead of with an empty box. Read once
  // on mount; later changes don't re-apply (the operator owns the box after).
  initialSearch?: string;
  // Column keys that are ALWAYS included in the global search, even when the
  // column is hidden via the "Columns" menu. Without this, hiding a column
  // makes its values unsearchable — an order can become unfindable by an
  // identifier the operator simply collapsed off-screen. Pass the stable
  // identifier keys (SO no., customer PO/SO/ref, DO no., vehicle, etc.).
  alwaysSearchKeys?: string[];
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
  // Optional sub-scope for the VALUE-filter / search session bucket only
  // (not the column layout). When the caller has its own authoritative
  // filter above the grid (e.g. a Status dropdown), pass that value here
  // so each selection gets a clean filter session instead of inheriting a
  // sticky column-filter persisted from a previous selection — which would
  // silently blank the grid (Sales Orders "Delivered" showed 0 of 66).
  // Omit on grids without an external filter to keep current behaviour.
  valueFilterKey?: string;
  // New-default-column roll-out. Keys listed here are force-shown ONCE per
  // user per gridId — even for users who already have a saved column
  // layout that predates the column. Used when a column is added to the
  // code and should appear for everyone without them hunting in the
  // Columns menu. Idempotent: once applied (tracked per user), the user's
  // later choice to hide it is respected and never re-forced.
  ensureColumns?: string[];
  // Force-show allowlist (keyField values). Rows whose keyField is in this
  // set are EXEMPT from the per-column text filters AND the per-column value
  // filters (the "(All)" checkbox dropdowns, incl. defaultExcludedValues) —
  // so they stay visible even when their value would normally be hidden. Used
  // by the Production Sheet so a row the operator just batch-flipped to
  // COMPLETED stays on screen (showing the completion) for the rest of the
  // session, instead of silently filtering itself out under the default
  // "hide COMPLETED" Status filter. Global SEARCH is intentionally still
  // honoured (typing a query is an explicit narrowing the operator owns), as
  // is sorting. The set lives in PARENT state and changing it does NOT remount
  // the grid, so the (uncontrolled) checkbox selection / batch toolbar survive.
  // Omit / empty set = no exemption (current behaviour).
  forceShowKeys?: ReadonlySet<string>;
  // Render-only row cap. When set, the grid renders at most this many rows
  // (post-filter, post-sort) on first paint, and shows a "Showing X of Y · Show
  // all Y" footer button to lift the cap. Filter / sort / search / select-all
  // / onFilteredDataChange continue to operate on the FULL filtered set — the
  // cap is purely a rendering optimisation to keep DOM node count bounded on
  // grids with thousands of rows. Omit to disable (no cap, render everything).
  defaultRowCap?: number;
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

// ONE shared collator instead of a fresh one per comparison.
//
// `String.prototype.localeCompare(that, locales, options)` is SPECIFIED as
// `%Collator%(locales, options).compare(this, that)` (ECMA-402) — so this is
// the same algorithm, same locale resolution, same result. The only thing that
// changes is WHEN the collator is resolved: at module load instead of on every
// call. A browser tab's default locale does not change mid-session, so the
// resolved collator is the same one every call would have produced.
//
// Why it matters: this comparator runs n·log₂n times per sort click. Measured
// locally (node, same function bodies, tests/data-grid-collator.test.mjs):
//   1,342 rows  37.2 ms → 1.77 ms   (21×)
//   2,539 rows  99.4 ms → 3.61 ms   (27.6×)
// A sort is not just a header click — `sortedData` re-derives on every
// `filteredData` change too, so a sorted grid pays it on each search keystroke.
const COLLATOR = new Intl.Collator(undefined, { numeric: true });

function compareValues(a: any, b: any): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return COLLATOR.compare(String(a), String(b));
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
  columnType,
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
  // All columns — including date columns — default to the "Values" tab.
  // Date columns now render a FLAT, checkable list of individual dates
  // (formatted "11 Jun") each with its row count, plus a row of quick
  // chips (Overdue / Today / This Week / This Month), the same shape as
  // the status/value columns. The old year▸month rollup tree was dropped
  // (it was "useless for dates"). The "Date Filters" tab is retained for
  // the custom dd/mm/yyyy range picker + period presets. Wei Siang
  // 2026-06-03. (setTab still lets the operator switch tabs.)
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

  // Wei Siang 2026-05-15: hold the latest `checked` in a ref so the OK
  // button's onClick reads the freshest value rather than a closure that
  // can race a still-committing checkbox click. The user-reported
  // symptom was "first OK click does nothing, second one filters".
  // 2026-05-22: the original fix assigned the ref INSIDE the setChecked
  // updater — but that updater body runs at React's render time, not at
  // click time. So an OK click batched into the same tick as a checkbox
  // toggle still read the pre-toggle ref, and the bug persisted
  // intermittently (fast clicks fail, slow clicks work). toggleAll /
  // toggleValue / setRaws now ALL compute the next set and assign
  // checkedRef SYNCHRONOUSLY at click time, before setChecked — so the
  // ref is correct the instant any checkbox handler returns.
  //
  // 2026-05-24: the bug returned. Root cause this time: the OK handler
  // reads `uniqueValues.length` from CLOSURE, not from the ref. When the
  // popover opens against the SO ID column on Production (or any grid
  // with the 20s passive poll), a polling refetch lands BETWEEN the
  // checkbox toggle and the OK click. `data` → `scopedData` → `allData`
  // → `uniqueValues` all reflow with the new data — but the OK button's
  // onClick closure was created on the PRIOR render, so its
  // `uniqueValues.length` is stale. If the poll-induced count happens to
  // equal `checkedRef.current.size`, `latestAllChecked` lies: the
  // handler treats the user's narrowed selection as "all checked" and
  // calls `onApplyValues(null)` — filter wiped, popover closes, user
  // sees "nothing happened". Second click works because that render's
  // closure carries the fresh `uniqueValues.length` and the equality
  // mismatch resolves correctly.
  //
  // Fix: mirror `uniqueValues` into a ref too (synced post-commit via a
  // tiny useEffect), and read BOTH the checked set and the unique-values
  // count from refs at click time. No more closure-captured length, no
  // more race.
  const checkedRef = useRef(checked);
  const uniqueValuesRef = useRef(uniqueValues);
  // Sync the unique-values ref AFTER commit so the OK button's onClick
  // (which runs in an event handler, well after commit) reads the same
  // count React just rendered with — even if the parent's data changed
  // mid-popover (e.g. the Production page's 20s poll). Cheap (a pointer
  // assignment) and lint-clean (no ref writes during render — see
  // react-hooks/refs).
  useEffect(() => {
    uniqueValuesRef.current = uniqueValues;
  }, [uniqueValues]);

  const toggleAll = () => {
    // Read both inputs from refs so a (very rare) same-tick double-click
    // on (All) still resolves to a clean toggle even if React hasn't
    // re-rendered between the two clicks. `allChecked` derived from
    // render-state would lie on the second click.
    const cur = checkedRef.current;
    const unique = uniqueValuesRef.current;
    const isAll = cur.size === unique.length;
    const next = isAll ? new Set<string>() : new Set(unique.map(([v]) => v));
    checkedRef.current = next;
    setChecked(next);
  };

  // Quick-filter chips for status-style columns (operator request
  // 2026-05-13). When a column's uniqueValues contain any string
  // starting with "Done", "Overdue", or "Pending" (case-insensitive),
  // surface a one-click chip per prefix. Clicking applies the filter
  // (the full set of matching distinct labels) and closes the dropdown.
  // Columns whose values don't match these prefixes (Customer, Product
  // Code, etc.) show no chips and behave exactly as before — zero
  // impact outside status columns.
  //
  // The displayed count is the TOTAL ROW count across all matching
  // labels, not the number of distinct labels. Same semantic as the
  // per-row count shown to the right of each value in the list below,
  // so the operator sees "Overdue (100)" and gets the same 100 rows
  // they'd see by ticking every "Overdue …" row individually.
  const quickFilterChips = useMemo(() => {
    const prefixes = ["Done", "Overdue", "Pending"];
    return prefixes
      .map((prefix) => {
        const lower = prefix.toLowerCase();
        const matchingEntries = uniqueValues.filter(([v]) =>
          v.toLowerCase().startsWith(lower),
        );
        const matchValues = matchingEntries.map(([v]) => v);
        const rowCount = matchingEntries.reduce(
          (sum, [, count]) => sum + count,
          0,
        );
        return { prefix, matchValues, rowCount };
      })
      .filter((q) => q.matchValues.length > 0);
  }, [uniqueValues]);

  // Quick-filter chips are MULTI-SELECT toggles over groups of values.
  // Clicking a chip toggles its whole prefix-group in `checked` (like
  // ticking every checkbox under that prefix), so the operator can stack
  // e.g. Overdue + Pending and then press OK. checkedRef is assigned
  // synchronously (see the checkedRef comment) so a same-tick OK is fresh.
  const toggleChip = (matchValues: string[]) => {
    const cur = checkedRef.current;
    const unique = uniqueValuesRef.current;
    const isAll = cur.size === unique.length;
    const groupOn =
      matchValues.length > 0 && matchValues.every((v) => cur.has(v));
    let next: Set<string>;
    if (isAll) {
      // From the default "everything selected" state, the first chip click
      // narrows to JUST that group; further chip clicks add/remove.
      next = new Set(matchValues);
    } else if (groupOn) {
      // Group is on — remove it.
      next = new Set(cur);
      for (const v of matchValues) next.delete(v);
      // Removing the last active group returns to "show all" (no filter),
      // never "show nothing".
      if (next.size === 0) next = new Set(unique.map(([v]) => v));
    } else {
      // Group is off — add it.
      next = new Set(cur);
      for (const v of matchValues) next.add(v);
    }
    checkedRef.current = next;
    setChecked(next);
  };

  const toggleValue = (v: string) => {
    // Compute the next set from checkedRef (kept in lockstep with the
    // `checked` state) and assign the ref BEFORE setChecked, so a same-
    // tick OK click reads the fresh value. See the checkedRef comment.
    const next = new Set(checkedRef.current);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    checkedRef.current = next;
    setChecked(next);
  };

  // ----- Date column: flat value list + quick chips + period presets -----
  // Reuses the SAME checked/checkedRef/apply machinery as the value filter.
  // `parsedDates` (raw / count / ymd per distinct date) feeds the flat
  // date-value list, the quick chips, and the custom range — one parse, no
  // duplicate date math. Zero change to the row-filtering engine: OK still
  // applies a Set<rawValue>.
  const isDateCol = columnType === "date";
  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const parsedDates = useMemo(() => {
    if (!isDateCol) return [] as { raw: string; count: number; ymd: [number, number, number] | null }[];
    return uniqueValues.map(([raw, count]) => {
      const t = raw ? Date.parse(raw) : NaN;
      if (Number.isNaN(t)) return { raw, count, ymd: null };
      const d = new Date(t);
      return { raw, count, ymd: [d.getFullYear(), d.getMonth(), d.getDate()] as [number, number, number] };
    });
  }, [isDateCol, uniqueValues]);
  // Toggle a batch of raw date strings at once (the "(No date)" row).
  // See toggleValue — assign checkedRef synchronously at click time, not
  // inside the setChecked updater, so a same-tick OK click is fresh.
  const setRaws = (raws: string[], on: boolean) => {
    const next = new Set(checkedRef.current);
    for (const r of raws) {
      if (on) next.add(r);
      else next.delete(r);
    }
    checkedRef.current = next;
    setChecked(next);
  };
  const allRawsOn = (raws: string[]) =>
    raws.length > 0 && raws.every((r) => checked.has(r));
  // Apply a [from,to] inclusive day range (period presets).
  const applyDateRange = (from: Date, to: Date) => {
    const f = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
    const t = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
    const matched = parsedDates
      .filter((p) => {
        if (!p.ymd) return false;
        const x = new Date(p.ymd[0], p.ymd[1], p.ymd[2]).getTime();
        return x >= f && x <= t;
      })
      .map((p) => p.raw);
    onApplyValues(new Set(matched));
    onClose();
  };
  const today0 = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const addDays = (d: Date, n: number) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  };
  const weekStart = (d: Date) => addDays(d, -((d.getDay() + 6) % 7)); // Monday
  const datePresets: { label: string; range: () => [Date, Date] }[] = [
    { label: "Yesterday", range: () => { const y = addDays(today0(), -1); return [y, y]; } },
    { label: "Today", range: () => { const t = today0(); return [t, t]; } },
    { label: "Tomorrow", range: () => { const t = addDays(today0(), 1); return [t, t]; } },
    { label: "Last Week", range: () => { const s = addDays(weekStart(today0()), -7); return [s, addDays(s, 6)]; } },
    { label: "This Week", range: () => { const s = weekStart(today0()); return [s, addDays(s, 6)]; } },
    { label: "Next Week", range: () => { const s = addDays(weekStart(today0()), 7); return [s, addDays(s, 6)]; } },
    { label: "Last Month", range: () => { const n = today0(); return [new Date(n.getFullYear(), n.getMonth() - 1, 1), new Date(n.getFullYear(), n.getMonth(), 0)]; } },
    { label: "This Month", range: () => { const n = today0(); return [new Date(n.getFullYear(), n.getMonth(), 1), new Date(n.getFullYear(), n.getMonth() + 1, 0)]; } },
    { label: "Next Month", range: () => { const n = today0(); return [new Date(n.getFullYear(), n.getMonth() + 1, 1), new Date(n.getFullYear(), n.getMonth() + 2, 0)]; } },
    { label: "Last Year", range: () => { const y = today0().getFullYear() - 1; return [new Date(y, 0, 1), new Date(y, 11, 31)]; } },
    { label: "This Year", range: () => { const y = today0().getFullYear(); return [new Date(y, 0, 1), new Date(y, 11, 31)]; } },
    { label: "Next Year", range: () => { const y = today0().getFullYear() + 1; return [new Date(y, 0, 1), new Date(y, 11, 31)]; } },
  ];

  // ----- Date column FLAT value list -----
  // Distinct dates as a flat, chronologically-sorted, checkable list with
  // "11 Jun"-style labels + row counts — the date-column analogue of the
  // non-date `filteredValues` list. Blank/unparseable dates surface as a
  // single "(No date)" row at the end so they stay filterable. Reuses the
  // already-computed `parsedDates` (raw / count / ymd) — no new date math.
  const DATE_MONTHS = MONTHS; // alias for label formatting (Jan…Dec)
  const dateFlatValues = useMemo(() => {
    if (!isDateCol) return [] as { raw: string; label: string; count: number; sortKey: number }[];
    const dated = parsedDates
      .filter((p) => p.ymd)
      .map((p) => {
        const [y, m, dd] = p.ymd as [number, number, number];
        return {
          raw: p.raw,
          // "11 Jun" — drop the year unless the data spans multiple years,
          // in which case append it so days don't collide visually.
          label: `${String(dd).padStart(2, "0")} ${DATE_MONTHS[m]}`,
          year: y,
          count: p.count,
          sortKey: new Date(y, m, dd).getTime(),
        };
      })
      .sort((a, b) => a.sortKey - b.sortKey);
    const years = new Set(dated.map((d) => d.year));
    const multiYear = years.size > 1;
    const out = dated.map((d) => ({
      raw: d.raw,
      label: multiYear ? `${d.label} ${d.year}` : d.label,
      count: d.count,
      sortKey: d.sortKey,
    }));
    // Blank / unparseable dates → single "(No date)" row at the bottom.
    const blanks = parsedDates.filter((p) => !p.ymd);
    if (blanks.length > 0) {
      out.push({
        raw: blanks.map((b) => b.raw).join(" "), // sentinel; not used as a real raw key
        label: "(No date)",
        count: blanks.reduce((s, b) => s + b.count, 0),
        sortKey: Number.POSITIVE_INFINITY,
      });
    }
    return out;
  }, [isDateCol, parsedDates, DATE_MONTHS]);

  // The blank raws (unparseable dates) as their own list — the "(No date)"
  // row toggles all of them at once via `setRaws`.
  const dateBlankRaws = useMemo(
    () => (isDateCol ? parsedDates.filter((p) => !p.ymd).map((p) => p.raw) : []),
    [isDateCol, parsedDates],
  );

  const dateFlatFiltered = useMemo(() => {
    if (!search) return dateFlatValues;
    const lower = search.toLowerCase();
    return dateFlatValues.filter((d) => d.label.toLowerCase().includes(lower));
  }, [dateFlatValues, search]);

  // ----- Date column quick chips -----
  // Five buckets: Overdue / Today / Tomorrow / This Week / This Month.
  // Bucket math is REUSED from `datePresets` (Today / Tomorrow / This Week /
  // This Month) so it stays consistent with the "Date Filters" tab. "Overdue" =
  // strictly before today (no matching preset exists, so it is computed
  // with the same `today0()` boundary the presets use — a [−∞, yesterday]
  // range). Each chip carries the raw date strings it covers (`matchValues`)
  // + a total row count, so it slots straight into the existing
  // multi-select `toggleChip` machinery (check those raws, then OK).
  const dateChips = useMemo(() => {
    if (!isDateCol)
      return [] as { label: string; matchValues: string[]; rowCount: number }[];
    const presetRange = (label: string): [Date, Date] | null => {
      const p = datePresets.find((d) => d.label === label);
      return p ? p.range() : null;
    };
    const inRange = (from: Date, to: Date) => {
      const f = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
      const t = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
      return parsedDates.filter((pd) => {
        if (!pd.ymd) return false; // chips never select blanks
        const x = new Date(pd.ymd[0], pd.ymd[1], pd.ymd[2]).getTime();
        return x >= f && x <= t;
      });
    };
    const buckets: { label: string; entries: typeof parsedDates }[] = [];
    // Overdue — strictly before today. Reuse the preset `today0()` boundary
    // (yesterday is the inclusive upper bound) rather than inventing new math.
    const overdueEntries = parsedDates.filter((pd) => {
      if (!pd.ymd) return false;
      const x = new Date(pd.ymd[0], pd.ymd[1], pd.ymd[2]).getTime();
      return x < today0().getTime();
    });
    buckets.push({ label: "Overdue", entries: overdueEntries });
    for (const label of ["Today", "Tomorrow", "This Week", "This Month"]) {
      const r = presetRange(label);
      buckets.push({ label, entries: r ? inRange(r[0], r[1]) : [] });
    }
    return buckets.map((b) => ({
      label: b.label,
      matchValues: b.entries.map((e) => e.raw),
      rowCount: b.entries.reduce((s, e) => s + e.count, 0),
    }));
    // `datePresets` is rebuilt every render (it closes over today0/addDays/
    // weekStart) but its range fns are PURE — the only inputs that change
    // the chip output are isDateCol + parsedDates. Listing datePresets would
    // recompute this memo every render for no benefit, so it is intentionally
    // excluded. We reuse the preset math (not duplicate it) by reading the
    // same `.range()` fns inside the memo body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDateCol, parsedDates]);

  const [rngFrom, setRngFrom] = useState("");
  const [rngTo, setRngTo] = useState("");

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
      className={cn(
        "fixed z-[100] rounded border border-[#C0C0C0] bg-white shadow-lg",
        // Date columns get a roomier popover — the tree + presets need
        // bigger tap targets (tablet use on the floor).
        isDateCol ? "w-[330px]" : "w-[240px]",
      )}
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
          {isDateCol ? "Date Filters" : "Text Filters"}
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
          {/* Quick-filter chips — non-date columns only. */}
          {!isDateCol && quickFilterChips.length > 0 && (
            <div className="flex flex-wrap gap-1 px-2 py-1.5 border-t border-[#F0F0F0] bg-[#FAF8F4]">
              {quickFilterChips.map(({ prefix, matchValues, rowCount }) => {
                // Lit when this whole group is selected AND we are in a
                // filtered state (not the default everything-checked).
                const chipOn = !allChecked && allRawsOn(matchValues);
                return (
                  <button
                    key={prefix}
                    type="button"
                    className={`rounded border px-2 py-0.5 text-[10px] transition-colors ${
                      chipOn
                        ? "border-[#6B5C32] bg-[#6B5C32] text-white"
                        : "border-[#D0D0D0] bg-white text-[#333] hover:bg-[#F0ECE9]"
                    }`}
                    onClick={() => toggleChip(matchValues)}
                    title={`${chipOn ? "Remove" : "Add"} ${prefix} (${rowCount} row${rowCount === 1 ? "" : "s"}) — chips stack (e.g. Overdue + Pending); click OK to apply.`}
                  >
                    {prefix}{" "}
                    <span className={chipOn ? "text-[#E8E0CC]" : "text-[#888]"}>
                      ({rowCount})
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {/* Quick date chips — date columns only (Overdue / Today / This
              Week / This Month). Same chip style + multi-select machinery as
              the status chips above: clicking checks/unchecks the dates in
              that bucket, then OK applies. Bucket math reuses `datePresets`
              (see `dateChips`). */}
          {isDateCol && dateChips.length > 0 && (
            <div className="flex flex-wrap gap-1 px-2 py-1.5 border-t border-[#F0F0F0] bg-[#FAF8F4]">
              {dateChips.map(({ label, matchValues, rowCount }) => {
                const chipOn = !allChecked && allRawsOn(matchValues);
                const disabled = matchValues.length === 0;
                return (
                  <button
                    key={label}
                    type="button"
                    disabled={disabled}
                    className={`rounded border px-2 py-0.5 text-[10px] transition-colors ${
                      chipOn
                        ? "border-[#6B5C32] bg-[#6B5C32] text-white"
                        : "border-[#D0D0D0] bg-white text-[#333] hover:bg-[#F0ECE9]"
                    } ${disabled ? "opacity-40 cursor-not-allowed hover:bg-white" : ""}`}
                    onClick={() => { if (!disabled) toggleChip(matchValues); }}
                    title={`${chipOn ? "Remove" : "Add"} ${label} (${rowCount} row${rowCount === 1 ? "" : "s"}) — chips stack; click OK to apply.`}
                  >
                    {label}{" "}
                    <span className={chipOn ? "text-[#E8E0CC]" : "text-[#888]"}>
                      ({rowCount})
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {isDateCol ? (
            /* Flat, chronologically-sorted list of individual dates — the
               date-column analogue of the non-date value list below. Each
               row is a checkbox with a "11 Jun" label + row count; toggling
               filters exactly like the value-column checkboxes (same
               `checked` / `toggleValue` / OK machinery). The "(No date)" row
               toggles every blank/unparseable date at once. */
            <div className="max-h-[260px] overflow-y-auto border-t border-[#F0F0F0]">
              {dateFlatFiltered.length === 0 && (
                <div className="px-3 py-3 text-[12px] text-[#999]">No dates</div>
              )}
              {dateFlatFiltered.map((d) => {
                const isBlankRow = d.label === "(No date)";
                const onState = isBlankRow
                  ? allRawsOn(dateBlankRaws)
                  : checked.has(d.raw);
                return (
                  <label
                    key={isBlankRow ? "__no_date__" : d.raw}
                    className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#333] cursor-pointer hover:bg-[#F0ECE9]"
                  >
                    <input
                      type="checkbox"
                      checked={onState}
                      onChange={(e) => {
                        if (isBlankRow) setRaws(dateBlankRaws, e.target.checked);
                        else toggleValue(d.raw);
                      }}
                      className="h-4 w-4 accent-[#6B5C32]"
                    />
                    <span
                      className={`truncate flex-1 ${isBlankRow ? "italic text-[#888]" : ""}`}
                    >
                      {d.label}
                    </span>
                    <span className="text-[10px] text-[#AAA]">{d.count}</span>
                  </label>
                );
              })}
            </div>
          ) : (
            /* Values list (non-date) — bumped row height (py-0.5 → py-1.5)
               and checkbox size (h-3.5 → h-4) on 2026-05-24 because Wei
               Siang's finger on the tablet kept missing the 14-px checkbox
               and registering a tap on the 11-px label text, which read
               back as "OK did nothing on first click". The actual race
               (the 59c3141 closure fix) was solved at the code level —
               this is the touch-target follow-up so a tap that lands
               anywhere on the row toggles. */
            <div className="max-h-[200px] overflow-y-auto border-t border-[#F0F0F0]">
              {filteredValues.map(([val, count]) => (
                <label key={val} className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#333] cursor-pointer hover:bg-[#F0ECE9]">
                  <input type="checkbox" checked={checked.has(val)} onChange={() => toggleValue(val)} className="h-4 w-4 accent-[#6B5C32]" />
                  <span className="truncate flex-1">{val || "(blank)"}</span>
                  <span className="text-[10px] text-[#AAA]">{count}</span>
                </label>
              ))}
            </div>
          )}
          {/* Actions — `type="button"` everywhere to short-circuit any
              accidental form-submit behaviour, and OK reads from
              checkedRef + uniqueValuesRef so it's never staler than the
              latest checkbox click OR a poll-induced data refresh.
              2026-05-24 second bump: px-5 py-2.5 text-[12px] +
              min-w-[64px] on OK so a tablet finger that lands anywhere
              inside the button (not just dead-centre) hits it. Wei
              Siang reported "tapped OK but nothing happened" after the
              closure fix went live — turned out the click was missing
              the 49×30-px button by a few pixels and landing on the
              Close button's whitespace. */}
          <div className="flex items-center justify-between gap-3 border-t border-[#E2DDD8] px-2 py-2">
            <button
              type="button"
              className="rounded border border-[#D0D0D0] px-3 py-2 text-[12px] text-[#555] hover:bg-[#F0ECE9]"
              onClick={() => { onClear(); onClose(); }}
            >
              Clear Filter
            </button>
            <div className="flex gap-3">
              <button
                type="button"
                className="min-w-[64px] rounded border border-[#6B5C32] bg-[#6B5C32] px-5 py-2.5 text-[12px] font-semibold text-white hover:bg-[#4D4224]"
                onClick={() => {
                  // Read BOTH the checked set and the unique-values count
                  // from refs (synced every render). Reading
                  // `uniqueValues.length` from closure was the 2026-05-24
                  // regression: a passive poll between checkbox-toggle and
                  // OK left the closure with a stale length, and an
                  // accidental size match made the handler treat a
                  // narrowed selection as "all checked" → wiped the
                  // filter on the first click. See checkedRef comment.
                  const latestChecked = checkedRef.current;
                  const latestUnique = uniqueValuesRef.current;
                  // "All checked" requires BOTH equal size AND every
                  // unique value being present — a same-size mismatch
                  // (e.g. one value swapped after a poll) used to fall
                  // through the size-only check and incorrectly clear
                  // the filter. Belt-and-braces.
                  const latestAllChecked =
                    latestChecked.size === latestUnique.length &&
                    latestUnique.every(([v]) => latestChecked.has(v));
                  if (latestAllChecked) onApplyValues(null); // no filter
                  else onApplyValues(new Set(latestChecked));
                  onClose();
                }}
              >
                OK
              </button>
              <button
                type="button"
                className="min-w-[64px] rounded border border-[#D0D0D0] px-5 py-2.5 text-[12px] text-[#555] hover:bg-[#F0ECE9]"
                onClick={onClose}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : isDateCol ? (
        <div className="p-2 space-y-2">
          {/* Quick period presets — one click applies + closes. */}
          <div className="grid grid-cols-3 gap-1">
            {datePresets.map((p) => (
              <button
                key={p.label}
                type="button"
                className="rounded border border-[#D0D0D0] bg-white px-2 py-2 text-[11px] text-[#333] hover:bg-[#6B5C32] hover:text-white hover:border-[#6B5C32] transition-colors"
                onClick={() => {
                  const [f, t] = p.range();
                  applyDateRange(f, t);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          {/* Custom date range */}
          <div className="border-t border-[#F0F0F0] pt-2 space-y-1">
            <div className="text-[10px] font-medium text-[#666]">
              Custom range
            </div>
            <div className="flex items-center gap-1">
              <input
                type="date"
                value={rngFrom}
                onChange={(e) => setRngFrom(e.target.value)}
                className="flex-1 rounded border border-[#D0D0D0] bg-white py-1.5 px-2 text-[11px] text-[#333] focus:border-[#6B5C32] focus:outline-none"
              />
              <span className="text-[10px] text-[#888]">to</span>
              <input
                type="date"
                value={rngTo}
                onChange={(e) => setRngTo(e.target.value)}
                className="flex-1 rounded border border-[#D0D0D0] bg-white py-1.5 px-2 text-[11px] text-[#333] focus:border-[#6B5C32] focus:outline-none"
              />
            </div>
            <div className="flex items-center justify-between pt-1">
              <button
                type="button"
                className="rounded border border-[#D0D0D0] px-3 py-1 text-[11px] text-[#555] hover:bg-[#F0ECE9]"
                onClick={() => { onClear(); onClose(); }}
              >
                Clear Filter
              </button>
              <button
                type="button"
                className="rounded border border-[#6B5C32] bg-[#6B5C32] px-3 py-1 text-[11px] text-white hover:bg-[#4D4224] disabled:opacity-40"
                disabled={!rngFrom || !rngTo}
                onClick={() => {
                  if (!rngFrom || !rngTo) return;
                  applyDateRange(new Date(rngFrom), new Date(rngTo));
                }}
              >
                Apply
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
  printPresetLabel,
  onSaveAsPrintPreset,
  onResetPrintPreset,
}: {
  columns: Column<T>[];
  visibleKeys: Set<string>;
  columnOrder: string[];
  onToggle: (key: string) => void;
  onReorder: (order: string[]) => void;
  onClose: () => void;
  // Optional admin actions — only wired when the grid has a `gridId`
  // (without an id there's no stable key to namespace per-grid org default).
  // Async: they publish the layout org-wide to the backend (in addition to the
  // localStorage cache mirror) and resolve to whether the publish succeeded.
  onSaveAsOrgDefault?: () => Promise<boolean>;
  onResetToOrgDefault?: () => Promise<boolean>;
  // Optional print-preset actions (Wei Siang #25) — wired when the grid has a
  // gridId AND a printPresetLabel. Publishing the print preset is SUPER_ADMIN-
  // gated server-side (same bar as the org-default button below).
  printPresetLabel?: string;
  onSaveAsPrintPreset?: () => Promise<boolean>;
  onResetPrintPreset?: () => Promise<boolean>;
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
      {(onSaveAsOrgDefault || onResetToOrgDefault || onSaveAsPrintPreset) && (
        <div className="border-t border-[#E5E5E5] px-3 py-2 space-y-1.5 bg-[#FAF8F5]">
          {onSaveAsPrintPreset && printPresetLabel && (
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                className="flex items-center gap-1.5 text-[11px] font-medium text-[#6B5C32] hover:underline"
                onClick={async () => {
                  const ok = await onSaveAsPrintPreset();
                  toast[ok ? "success" : "error"](
                    ok
                      ? `Saved org-wide — printing "${printPresetLabel}" will use these columns on every browser.`
                      : "Could not save print layout.",
                  );
                }}
                title={`Use the current columns when printing the ${printPresetLabel}`}
              >
                <span aria-hidden>🖨</span>
                Save as {printPresetLabel}
              </button>
              {onResetPrintPreset && (
                <button
                  type="button"
                  className="text-[10px] text-[#888] hover:text-[#555] hover:underline"
                  onClick={async () => {
                    const ok = await onResetPrintPreset();
                    toast[ok ? "success" : "error"](
                      ok
                        ? "Print layout cleared — printout mirrors the screen again."
                        : "Could not clear print layout.",
                    );
                  }}
                  title="Forget the saved print layout"
                >
                  clear
                </button>
              )}
            </div>
          )}
          {onSaveAsOrgDefault && isSuperAdmin && (
            <button
              type="button"
              className="flex w-full items-center gap-1.5 text-[11px] font-medium text-[#6B5C32] hover:underline"
              onClick={async () => {
                const ok = await onSaveAsOrgDefault();
                if (ok) {
                  toast.success(
                    "Saved as Org Default — every user on every browser will see this layout.",
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
              onClick={async () => {
                const ok = await onResetToOrgDefault();
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

// Bold every occurrence of the active global-search term inside a plain-text
// cell so the matched part is obvious when many rows look alike (Wei Siang
// 2026-06-15: "搜了没 bold 起来,不知道哪个是我要找的"). Mirrors the global
// command-palette's highlighter; returns the raw text untouched when there's
// no query, so non-search rendering is byte-identical.
function highlightMatch(text: string, query: string): React.ReactNode {
  const q = (query || "").trim();
  if (!q || !text) return text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let from = 0;
  let i = lower.indexOf(ql, from);
  if (i === -1) return text;
  const parts: React.ReactNode[] = [];
  while (i !== -1) {
    if (i > from) parts.push(text.slice(from, i));
    parts.push(
      <mark
        key={i}
        className="rounded-[2px] bg-[#FBEFB8] px-0.5 font-semibold text-inherit"
      >
        {text.slice(i, i + q.length)}
      </mark>,
    );
    from = i + q.length;
    i = lower.indexOf(ql, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

function DefaultCellRenderer<T>({
  column,
  value,
  row,
  index,
  search,
}: {
  column: Column<T>;
  value: any;
  row: T;
  index: number;
  // Active global-search term — used to highlight matches in text cells, and
  // passed to custom column.render so those cells can highlight too.
  search?: string;
}) {
  const hl = (t: string): React.ReactNode => highlightMatch(t, search ?? "");
  if (column.render) return <>{column.render(value, row, index, hl)}</>;

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
      return <span className="tabular-nums">{hl(String(value ?? ""))}</span>;
    case "status": {
      const colors = getStatusColor(String(value ?? ""));
      return (
        <span className={cn("inline-block rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-tight", colors.bg, colors.text)}>
          {hl(String(value ?? "").replace(/_/g, " "))}
        </span>
      );
    }
    default:
      return <>{value != null ? hl(String(value)) : ""}</>;
  }
}

// ---------------------------------------------------------------------------
// DataGrid Component
// ---------------------------------------------------------------------------

// Stable empty default for the optional `alwaysSearchKeys` prop. Defined at
// module scope so the destructure default keeps the same array reference every
// render (a fresh `[]` literal would bust the filteredData useMemo each time).
const EMPTY_SEARCH_KEYS: string[] = [];
// Shared empty Set so an omitted `forceShowKeys` keeps a stable reference
// across renders (a fresh `new Set()` would bust the filteredData useMemo).
const EMPTY_FORCE_SHOW: ReadonlySet<string> = new Set();

export function DataGrid<T extends Record<string, any>>({
  columns,
  data,
  keyField,
  onDoubleClick,
  onRowClick,
  contextMenuItems,
  onSelectionChange,
  selectable = false,
  clearSelectionToken,
  rowClassName,
  emptyMessage = "No data found.",
  loading = false,
  stickyHeader = true,
  maxHeight,
  className,
  gridId,
  printPresetLabel,
  groupBy,
  autoGroup = true,
  // Defaults to gridId (destructured above) so Saved Views is reachable on
  // every grid that persists a layout, without touching 28 call sites.
  viewStorageKey = gridId,
  onFilteredDataChange,
  exportName,
  exportSheetLabel,
  detailExport,
  onSearchChange,
  initialSearch,
  alwaysSearchKeys = EMPTY_SEARCH_KEYS,
  virtualize = false,
  defaultExcludedValues,
  valueFilterKey,
  ensureColumns,
  forceShowKeys = EMPTY_FORCE_SHOW,
  defaultRowCap,
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
  // Per-user ledger of every column key this grid has ever surfaced to the
  // user. A column is "genuinely new" (added in code after the user last
  // used the grid) iff its key is absent here — that is what the
  // reconciliation effect below auto-shows. Critically this must NOT
  // resurrect a column the user deliberately hid, so the seed is the FULL
  // column universe the user last knew: the persisted column ORDER (which
  // lists hidden columns too) when present, else the current columns
  // (identical safety to the legacy behaviour — nothing resurfaces; the
  // ledger is then persisted so FUTURE additions are detectable even for
  // users who never reorder).
  const [seenKeys, setSeenKeys] = useState<Set<string>>(() => {
    if (gridId && typeof window !== "undefined") {
      try {
        const ledger = localStorage.getItem(`datagrid-seen-${gridId}-${userKey()}`);
        if (ledger) return new Set(JSON.parse(ledger) as string[]);
        const personalOrder = localStorage.getItem(`datagrid-colorder-${gridId}-${userKey()}`);
        if (personalOrder) return new Set(JSON.parse(personalOrder) as string[]);
        const orgOrder = localStorage.getItem(`datagrid-colorder-${gridId}-org-default`);
        if (orgOrder) return new Set(JSON.parse(orgOrder) as string[]);
      } catch { /* ignore */ }
    }
    return new Set(columns.map(c => c.key));
  });
  // Per-user record of which ensureColumns keys have already been
  // force-applied for this gridId, so the one-time roll-out never fights a
  // user who later hides the column.
  const [ensuredKeys, setEnsuredKeys] = useState<Set<string>>(() => {
    if (gridId && typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem(`datagrid-ensured-${gridId}-${userKey()}`);
        if (raw) return new Set(JSON.parse(raw) as string[]);
      } catch { /* ignore */ }
    }
    return new Set();
  });
  // ── Column widths (user-resizable) ──
  // Persisted per-user. Unlike visibility/order (gridId-only), widths also
  // persist on grids WITHOUT a gridId by falling back to a key derived from
  // the column set — so "remember my widths" works everywhere. personal
  // `datagrid-colw-${widthStoreId}-${userKey()}` wins, else org-default, else
  // the column def's own `width`. Map of colKey -> css width (e.g. "140px").
  const widthStoreId = gridId || `auto:${columns.map(c => c.key).join(",")}`;
  const [colWidths, setColWidths] = useState<Record<string, string>>(() => {
    if (typeof window !== "undefined") {
      try {
        const personal = localStorage.getItem(`datagrid-colw-${widthStoreId}-${userKey()}`);
        if (personal) return JSON.parse(personal);
        const orgDefault = localStorage.getItem(`datagrid-colw-${widthStoreId}-org-default`);
        if (orgDefault) return JSON.parse(orgDefault);
      } catch { /* ignore */ }
    }
    return {};
  });
  const persistColWidths = useCallback((w: Record<string, string>) => {
    try { localStorage.setItem(`datagrid-colw-${widthStoreId}-${userKey()}`, JSON.stringify(w)); } catch { /* ignore */ }
  }, [widthStoreId]);
  // Double-click the handle → drop the override (back to the column's default).
  const resetColumnWidth = useCallback((key: string) => {
    setColWidths(prev => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      persistColWidths(next);
      return next;
    });
  }, [persistColWidths]);
  // Drag the right-edge handle to resize. Min 48px so a column can't vanish.
  // We update state on each move (virtualized rows keep this cheap) and persist
  // once on mouseup.
  const startColumnResize = useCallback((e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).closest("th");
    const startX = e.clientX;
    const startW = th ? th.getBoundingClientRect().width : 120;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(48, Math.round(startW + (ev.clientX - startX)));
      setColWidths(prev => (prev[key] === `${w}px` ? prev : { ...prev, [key]: `${w}px` }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      setColWidths(prev => { persistColWidths(prev); return prev; });
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [persistColWidths]);

  const [showCustomizer, setShowCustomizer] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

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

  // Admin-only: snapshot the current Personal layout (visible columns + order +
  // widths) as the ORG-WIDE default. Persisted to the backend so EVERY user on
  // EVERY browser sees it (not just this browser). Also mirrored into the
  // localStorage org-default cache keys so the existing synchronous read paths
  // (useState initializers, production print read) keep working instantly.
  // Personal layouts always still take precedence on read, so this never
  // clobbers a user who has already customized.
  const saveAsOrgDefault = useCallback(async (): Promise<boolean> => {
    if (!gridId || typeof window === "undefined") return false;
    const cols = [...visibleKeys];
    // Local cache mirror first (fast, also the fallback if the server is down).
    try {
      localStorage.setItem(`datagrid-cols-${gridId}-org-default`, JSON.stringify(cols));
      localStorage.setItem(`datagrid-colorder-${gridId}-org-default`, JSON.stringify(columnOrder));
      localStorage.setItem(`datagrid-colw-${widthStoreId}-org-default`, JSON.stringify(colWidths));
    } catch { /* ignore */ }
    // Publish org-wide. Returns false if the backend rejected (e.g. not a
    // SUPER_ADMIN, or offline) so the toast can warn it stayed local-only.
    return putOrgLayout(gridId, "org-default", cols, columnOrder, colWidths);
  }, [gridId, visibleKeys, columnOrder, colWidths, widthStoreId]);

  // Snapshot the CURRENT layout into a dedicated PRINT preset
  // (`datagrid-cols-${gridId}-print`) — a printout reads this instead of the
  // live on-screen columns so the operator can curate a print layout once and
  // keep working with a different on-screen view. Not admin-gated. (Wei Siang #25
  // "Save as Production Schedule".)
  const saveAsPrintPreset = useCallback(async (): Promise<boolean> => {
    if (!gridId || typeof window === "undefined") return false;
    const cols = [...visibleKeys];
    // Local cache mirror first (the production print read is synchronous and
    // reads these keys; also the fallback if the server is down).
    try {
      localStorage.setItem(`datagrid-cols-${gridId}-print`, JSON.stringify(cols));
      localStorage.setItem(`datagrid-colorder-${gridId}-print`, JSON.stringify(columnOrder));
    } catch { /* ignore */ }
    // Publish org-wide so the print layout is shared across browsers/users.
    return putOrgLayout(gridId, "print", cols, columnOrder, colWidths);
  }, [gridId, visibleKeys, columnOrder, colWidths]);

  // Forget the print preset → the printout falls back to mirroring the on-screen
  // columns again.
  const resetPrintPreset = useCallback(async (): Promise<boolean> => {
    if (!gridId || typeof window === "undefined") return false;
    try {
      localStorage.removeItem(`datagrid-cols-${gridId}-print`);
      localStorage.removeItem(`datagrid-colorder-${gridId}-print`);
    } catch { /* ignore */ }
    // Clear the org-wide print preset too so it stops being re-mirrored on the
    // next load. Best-effort (SUPER_ADMIN-gated server-side).
    return deleteOrgLayout(gridId, "print");
  }, [gridId]);

  // Drop the user's Personal layout for this grid AND re-pull the ORG-WIDE
  // default from the backend so the reset lands on the latest published layout
  // (not a stale local cache). The server org-default is mirrored into the
  // localStorage cache keys, then state is re-seeded from the freshest
  // available org-default (server > local cache > column-definition defaults).
  const resetToOrgDefault = useCallback(async (): Promise<boolean> => {
    if (!gridId || typeof window === "undefined") return false;
    try {
      localStorage.removeItem(`datagrid-cols-${gridId}-${userKey()}`);
      localStorage.removeItem(`datagrid-colorder-${gridId}-${userKey()}`);
      localStorage.removeItem(`datagrid-colw-${widthStoreId}-${userKey()}`);
      localStorage.removeItem(`datagrid-seen-${gridId}-${userKey()}`);
      localStorage.removeItem(`datagrid-ensured-${gridId}-${userKey()}`);

      // Re-pull the published org-default and refresh the local cache mirror so
      // a different browser's stale cache can't win. Best-effort: a server
      // failure just falls back to whatever local org-default cache exists.
      const remote = await fetchOrgLayouts(gridId);
      if (remote?.orgDefault) {
        try {
          localStorage.setItem(`datagrid-cols-${gridId}-org-default`, JSON.stringify(remote.orgDefault.visibleCols));
          localStorage.setItem(`datagrid-colorder-${gridId}-org-default`, JSON.stringify(remote.orgDefault.colOrder));
          if (remote.orgDefault.colWidths) {
            localStorage.setItem(`datagrid-colw-${widthStoreId}-org-default`, JSON.stringify(remote.orgDefault.colWidths));
          }
        } catch { /* ignore */ }
      }

      const orgCols = localStorage.getItem(`datagrid-cols-${gridId}-org-default`);
      const orgOrder = localStorage.getItem(`datagrid-colorder-${gridId}-org-default`);
      const orgWidths = localStorage.getItem(`datagrid-colw-${widthStoreId}-org-default`);
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
      setColWidths(orgWidths ? (JSON.parse(orgWidths) as Record<string, string>) : {});
      // Re-seed the seen ledger to the post-reset universe so the
      // reconciliation effect doesn't immediately re-surface columns the
      // org default intentionally hides. Clear ensured flags so a genuine
      // new-default column can roll out again after an explicit reset.
      setSeenKeys(
        orgOrder
          ? new Set(JSON.parse(orgOrder) as string[])
          : new Set(columns.map(c => c.key)),
      );
      setEnsuredKeys(new Set());
      return true;
    } catch {
      return false;
    }
  }, [gridId, columns, widthStoreId]);

  // ── Org-wide preset hydration (server) ──
  // On mount, pull the org-wide presets for this grid from the backend. This
  // is what makes "Save as Org Default" / the print preset SHARED across
  // browsers/users instead of local-only.
  //
  //   - org-default: mirrored into the localStorage org-default cache keys
  //     (so the existing sync read paths keep working), AND applied to LIVE
  //     state ONLY when the user has NO personal override for this grid — we
  //     must never clobber a layout the user has customised.
  //   - print: ALWAYS mirrored into the print cache keys so the production
  //     print read (which reads localStorage synchronously) honours the shared
  //     print preset across browsers once the grid has mounted.
  //
  // Best-effort: a fetch failure / null result leaves the existing localStorage
  // behaviour untouched (backward compatible — never breaks the grid). Runs
  // once per grid mount; the user-key is captured so a sign-in switch re-runs.
  const orgHydratedRef = useRef<string | null>(null);
  const userKeyForHydrate = userKey();
  useEffect(() => {
    if (!gridId || typeof window === "undefined") return;
    // One hydration per (grid, user-key); a sign-in switch changes the key and
    // re-runs. The ref also guards StrictMode's intentional double-mount.
    const guardKey = `${gridId}::${userKeyForHydrate}`;
    if (orgHydratedRef.current === guardKey) return;
    orgHydratedRef.current = guardKey;
    let cancelled = false;
    (async () => {
      const remote = await fetchOrgLayouts(gridId);
      if (cancelled || !remote) return;

      // Mirror + (conditionally) apply the org-default.
      if (remote.orgDefault) {
        try {
          localStorage.setItem(`datagrid-cols-${gridId}-org-default`, JSON.stringify(remote.orgDefault.visibleCols));
          localStorage.setItem(`datagrid-colorder-${gridId}-org-default`, JSON.stringify(remote.orgDefault.colOrder));
          if (remote.orgDefault.colWidths) {
            localStorage.setItem(`datagrid-colw-${widthStoreId}-org-default`, JSON.stringify(remote.orgDefault.colWidths));
          }
        } catch { /* ignore */ }

        // Apply to LIVE state only if the user has no personal layer for this
        // grid (cols + order). Checking the raw localStorage keys (not state)
        // is the reliable "has the user customised?" signal — state is seeded
        // from defaults when they haven't.
        let hasPersonal = false;
        try {
          hasPersonal =
            localStorage.getItem(`datagrid-cols-${gridId}-${userKeyForHydrate}`) !== null ||
            localStorage.getItem(`datagrid-colorder-${gridId}-${userKeyForHydrate}`) !== null;
        } catch { /* ignore */ }
        if (!hasPersonal) {
          setVisibleKeys(new Set(remote.orgDefault.visibleCols));
          setColumnOrder(remote.orgDefault.colOrder);
          if (remote.orgDefault.colWidths) setColWidths(remote.orgDefault.colWidths);
        }
      }

      // Always mirror the print preset so the production print read (sync
      // localStorage) honours the shared layout across browsers.
      if (remote.print) {
        try {
          localStorage.setItem(`datagrid-cols-${gridId}-print`, JSON.stringify(remote.print.visibleCols));
          localStorage.setItem(`datagrid-colorder-${gridId}-print`, JSON.stringify(remote.print.colOrder));
        } catch { /* ignore */ }
      }
    })();
    return () => {
      cancelled = true;
    };
  // userKeyForHydrate in deps so a sign-in/out re-hydrates with the new
  // personal-key check; orgHydratedRef guards against the StrictMode double-run.
  }, [gridId, widthStoreId, userKeyForHydrate]);

  // When the parent passes a new `columns` array (e.g., the production page
  // changes activeTab and rebuilds dept-pill columns, or a column is added
  // in code), sync local state:
  //   - A column is "genuinely new" iff its key is absent from the per-user
  //     `seenKeys` ledger. (The legacy check used columnOrder, but that is
  //     seeded from the current columns when the user has no saved order,
  //     so brand-new columns were silently never detected for those users —
  //     they stayed hidden forever. The seen-ledger fixes that without ever
  //     resurrecting a column the user deliberately hid.)
  //   - Append genuinely-new keys to columnOrder only if not already present
  //     (so they don't sort to 999/end and aren't duplicated).
  //   - Force visible-by-default new keys into visibleKeys (don't override
  //     user-toggled visibility of already-seen columns).
  //   - Grow + persist the seen ledger so subsequent code-added columns are
  //     detectable even for users who never reorder.
  useEffect(() => {
    const allKeys = columns.map((c) => c.key);
    const fresh: string[] = [];
    const newlyVisible: string[] = [];
    for (const c of columns) {
      if (!seenKeys.has(c.key)) {
        fresh.push(c.key);
        if (!c.hidden && !c.defaultHidden) newlyVisible.push(c.key);
      }
    }
    // Establish/extend the seen ledger. Persisting it even when nothing is
    // fresh is what makes future column adds detectable for never-reorder
    // users (their seed is the current columns, so without this write the
    // ledger would never exist and a later column would re-seed as "seen").
    if (gridId && typeof window !== "undefined") {
      const ledgerKey = `datagrid-seen-${gridId}-${userKey()}`;
      try {
        if (fresh.length > 0 || localStorage.getItem(ledgerKey) === null) {
          localStorage.setItem(
            ledgerKey,
            JSON.stringify([...new Set([...seenKeys, ...allKeys])]),
          );
        }
      } catch { /* ignore */ }
    }
    if (fresh.length === 0) return;
    setSeenKeys((prev) => {
      const next = new Set(prev);
      for (const k of allKeys) next.add(k);
      return next;
    });
    const orderAdds = fresh.filter((k) => !columnOrder.includes(k));
    if (orderAdds.length > 0) {
      setColumnOrder((prev) => {
        const next = [...prev, ...orderAdds];
        if (gridId) {
          try { localStorage.setItem(`datagrid-colorder-${gridId}-${userKey()}`, JSON.stringify(next)); } catch { /* ignore */ }
        }
        return next;
      });
    }
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
  }, [columns, columnOrder, seenKeys, gridId]);

  // One-time new-default-column roll-out. For each key in `ensureColumns`
  // not yet applied for this user+grid, force it visible once and record
  // that we did so. This surfaces a freshly-added column even for users
  // whose seen-ledger was seeded from current columns (never-reorder users,
  // for whom the reconciliation effect above can't tell it's new). The
  // ensured-flag means a user who later hides the column is respected.
  useEffect(() => {
    if (!ensureColumns || ensureColumns.length === 0) return;
    const colKeys = new Set(columns.map((c) => c.key));
    const toApply = ensureColumns.filter(
      (k) => colKeys.has(k) && !ensuredKeys.has(k),
    );
    if (toApply.length === 0) return;
    setEnsuredKeys((prev) => {
      const next = new Set(prev);
      for (const k of toApply) next.add(k);
      if (gridId) {
        try { localStorage.setItem(`datagrid-ensured-${gridId}-${userKey()}`, JSON.stringify([...next])); } catch { /* ignore */ }
      }
      return next;
    });
    setVisibleKeys((prev) => {
      if (toApply.every((k) => prev.has(k))) return prev;
      const next = new Set(prev);
      for (const k of toApply) next.add(k);
      if (gridId) {
        try { localStorage.setItem(`datagrid-cols-${gridId}-${userKey()}`, JSON.stringify([...next])); } catch { /* ignore */ }
      }
      return next;
    });
  }, [ensureColumns, columns, ensuredKeys, gridId]);

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
    // The selectable checkbox gutter is pinned to exactly 32px (see its th/td
    // below) and frozen alongside the sticky run, so the first sticky column
    // sits at 32 with no gap.
    let acc = selectable ? 32 : 0;
    for (const col of visibleColumns) {
      if (!col.sticky) break; // contiguous leading run only
      out.set(col.key, acc);
      // Use the EFFECTIVE width — a user resize (colWidths) must win over the
      // declared width, else a resized sticky column drifts every following
      // sticky column's left offset and the scroll content leaks through the
      // seam ("走漏风", Wei Siang 2026-06-16). Falls back to the declared px.
      const eff = colWidths[col.key] || col.width;
      const m = eff ? /^(\d+(?:\.\d+)?)px$/.exec(eff) : null;
      if (!m) break;
      acc += parseFloat(m[1]);
    }
    return out;
  }, [visibleColumns, selectable, colWidths]);

  // ── Search / Filter ──
  // Persisted in sessionStorage keyed by gridId so the search text and
  // column-filter selections survive tab switches within the same browser
  // session. Without this, the TabbedOutlet's mount-on-activate model wipes
  // every search the user types the moment they switch tabs (Wei Siang
  // report Apr 26 2026: 'I search something, switch tabs, come back, it's
  // gone'). sessionStorage clears on browser close — the user explicitly
  // wants the search to NOT persist across days, just across tab hops.
  const filterStoreKey = gridId
    ? `datagrid-filters-${gridId}${valueFilterKey ? `-${valueFilterKey}` : ""}-${userKey()}`
    : null;
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
  // Column FILTERS are deliberately not restored — only the search text is.
  //
  // Restoring them is how a grid opens completely blank: the operator narrows
  // a column, moves on, comes back later and the page shows nothing, with only
  // a small "Clear 1 filter" link to explain it. It has now bitten twice on the
  // same screen — Sales Orders "Delivered" showing 0 of 66, and the Draft tab
  // showing 0 of 2 while two draft orders sat right there (owner 2026-08-02:
  // 「我想要它 by default 是打开的，筛选的那个不要 by default」).
  //
  // The search box still survives a tab hop, which was the original request
  // (Wei Siang, 2026-04-26: "I search something, switch tabs, come back, it's
  // gone"). A visible search term explains its own empty result; an invisible
  // column filter does not.
  const seededFilters = null as typeof seeded;
  const [searchText, setSearchText] = useState(initialSearch ?? seeded?.searchText ?? "");
  // Deferred copy of the search value. The <input> stays bound to searchText
  // (instant caret/echo), but the heavy filter+sort AND the parent
  // onSearchChange notification read deferredSearch — so a fast typist no
  // longer blocks the main thread re-filtering the whole grid on every key
  // (and on Sales, no longer re-fetches the whole dataset per keystroke).
  // Same data shown, just deferred a frame. (Wei Siang 2026-06-04 input-lag fix)
  const deferredSearch = useDeferredValue(searchText);
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>(
    seededFilters?.columnFilters ?? {},
  );
  const [columnValueFilters, setColumnValueFilters] = useState<Record<string, Set<string>>>(
    () => {
      if (!seededFilters?.columnValueFilters) return {};
      const out: Record<string, Set<string>> = {};
      for (const [k, v] of Object.entries(seededFilters.columnValueFilters)) {
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
  const hasInitialFilterState =
    !!seededFilters?.columnValueFilters &&
    Object.keys(seededFilters.columnValueFilters).length > 0;
  const [valueFilterTouched, setValueFilterTouched] = useState<boolean>(hasInitialFilterState);
  // Mirror touched into a ref so the seed effect can short-circuit
  // synchronously even when React is mid-batch between a touch event and
  // the next effect commit. The 2026-05-24 OK-first-click bug was caused
  // by the seed effect firing AFTER the operator's OK click but still
  // reading the pre-click `valueFilterTouched=false` from closure — its
  // `setColumnValueFilters(next)` then full-replaced the just-applied
  // filter with the all-but-excluded default, silently wiping the
  // selection. checkedRef-style ref keeps the guard honest.
  const valueFilterTouchedRef = useRef(valueFilterTouched);
  useEffect(() => {
    valueFilterTouchedRef.current = valueFilterTouched;
  }, [valueFilterTouched]);

  // Apply defaultExcludedValues once after data loads (and again whenever
  // data shape changes, e.g. a new status value appears) — but only if
  // the operator hasn't manually touched the value filters in this grid.
  // We compute the allowed-values Set as (all values currently in data)
  // minus (the caller's excluded list), so e.g. excluding "COMPLETED" on
  // the Status column ticks every other status box on by default.
  //
  // CRITICAL (2026-05-24): callers MUST pass a stable `defaultExcludedValues`
  // reference (useMemo or hoisted const). An inline object literal makes
  // this effect re-fire on EVERY parent render, and the prior code's
  // `setColumnValueFilters(next)` was a FULL REPLACE — so a 20s passive
  // poll on the Production page would fire this effect right after the
  // operator's OK click and clobber their selection. Two safeguards now:
  // (a) read touched from the ref so the guard sees the latest value
  //     even in cross-batch firing, and
  // (b) updater form on the setter so we never overwrite a non-empty
  //     selection — once the operator has ANY filter active, the seed
  //     stays out of the way.
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot seed of value filters */
  useEffect(() => {
    if (valueFilterTouchedRef.current) return;
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
    setColumnValueFilters(prev => {
      // Operator already has something — DON'T overwrite. The touched
      // flag is the primary guard; this is belt-and-braces for the
      // window between setValueFilterTouched(true) being queued and
      // the effect closure firing with the stale `false`.
      if (Object.keys(prev).length > 0) return prev;
      return next;
    });
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

  // Parent-driven clear (see `clearSelectionToken`). Skips the first render so
  // mounting with a token doesn't fight a selection restored by anything else;
  // only a CHANGE to the token clears. Empty-set guard keeps it from
  // re-rendering when there is nothing selected.
  const lastClearToken = useRef<number | undefined>(clearSelectionToken);
  useEffect(() => {
    if (clearSelectionToken === lastClearToken.current) return;
    lastClearToken.current = clearSelectionToken;
    setSelectedKeys((prev) => (prev.size === 0 ? prev : new Set()));
    lastClickedIndex.current = null;
  }, [clearSelectionToken]);

  // ── Context menu ──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; row: T } | null>(null);

  // ── Grouping state ──
  const [groupEnabled, setGroupEnabled] = useState(!!groupBy && autoGroup);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [groupFilter, setGroupFilter] = useState<Set<string> | null>(null); // null = show all
  const [showGroupDropdown, setShowGroupDropdown] = useState(false);

  // Sync groupEnabled when groupBy prop changes
  useEffect(() => { setGroupEnabled(!!groupBy && autoGroup); }, [groupBy, autoGroup]);

  // 2026-05-12 perf: groups default collapsed on first paint. See the effect
  // body further down (lives after the allGroupValues useMemo so we can
  // depend on it). Ref tracks initialization-per-groupBy so manually
  // expanded groups stay expanded on subsequent data refreshes.
  const initialCollapseRef = useRef<string | null>(null);

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
    setGroupEnabled(!!groupBy && autoGroup);
    setGroupFilter(null);
    setCollapsedGroups(new Set());
    setShowViewsDropdown(false);
  }, [groupBy, autoGroup]);

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

    // Global search (deferred — see deferredSearch above)
    if (deferredSearch) {
      const lower = deferredSearch.toLowerCase();
      // Search visible columns PLUS any alwaysSearchKeys, so an identifier
      // stays findable even when its column is hidden via the "Columns" menu.
      const searchKeys = new Set<string>(visibleColumns.map(c => c.key));
      for (const k of alwaysSearchKeys) searchKeys.add(k);
      result = result.filter(row => {
        for (const key of searchKeys) {
          const val = getNestedValue(row, key);
          if (String(val ?? "").toLowerCase().includes(lower)) return true;
        }
        return false;
      });
    }

    // forceShowKeys exemption (see prop doc): a row whose keyField is in the
    // allowlist bypasses the per-column TEXT and VALUE filters below, so it
    // stays visible even when its value (e.g. status COMPLETED) would normally
    // be hidden by the default-hide filter. Global search above is intentionally
    // NOT exempted — that's an explicit operator narrowing. No-op when empty.
    const hasForceShow = forceShowKeys.size > 0;
    const isForceShown = (row: T) =>
      hasForceShow && forceShowKeys.has(String(getNestedValue(row, keyField)));

    // Per-column text filters
    const activeFilters = Object.entries(columnFilters).filter(([, v]) => v);
    if (activeFilters.length > 0) {
      result = result.filter(row =>
        isForceShown(row) ||
        activeFilters.every(([key, val]) => matchesFilter(getNestedValue(row, key), val))
      );
    }

    // Per-column value filters (checkbox-based). filterAccessor on the
    // column wins over the raw key so e.g. dept-status columns can store
    // a sort number on .key but filter on a "Pending/Overdue/Done" label.
    const activeValueFilters = Object.entries(columnValueFilters);
    if (activeValueFilters.length > 0) {
      result = result.filter(row =>
        isForceShown(row) ||
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
  }, [data, deferredSearch, columnFilters, columnValueFilters, visibleColumns, alwaysSearchKeys, forceShowKeys, keyField, columns]);

  // All unique group values (for group filter dropdown)
  const allGroupValues = useMemo(() => {
    if (!groupBy) return [];
    const vals = new Set<string>();
    for (const row of filteredData) {
      vals.add(String(getNestedValue(row, groupBy) ?? "—"));
    }
    return Array.from(vals).sort();
  }, [groupBy, filteredData]);

  // 2026-05-12 perf: groups default collapsed on first paint. The pre-fix
  // behaviour mounted every row in every group on initial render because
  // the virtualizer is hard-disabled when groupBy is active (see
  // virtualizationActive gate below). Operator-visible cost: 300-1200 ms
  // freeze on DO + dept pages with groupBy="customerState" / similar.
  // Tracks initialization per groupBy column key so we don't re-collapse
  // after the operator manually expands a group on later data refreshes.
  useEffect(() => {
    if (!groupEnabled || !groupBy) {
      initialCollapseRef.current = null;
      return;
    }
    if (initialCollapseRef.current === groupBy) return;
    if (allGroupValues.length === 0) return;
    setCollapsedGroups(new Set(allGroupValues));
    initialCollapseRef.current = groupBy;
  }, [groupBy, groupEnabled, allGroupValues]);

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

  // ── Row cap (render-only) ──
  // Caps the DOM row count to `defaultRowCap` on first paint when the
  // post-filter set exceeds it, then reveals all rows when the user clicks
  // "Show all". Filter / sort / search / select-all / onFilteredDataChange
  // continue to operate on the full `sortedData` — capping is purely a render
  // optimisation. Tab/grid remount (parent supplies `key`) resets showAll, so
  // every dept tab re-opens fast.
  const [showAll, setShowAll] = useState(false);
  const rowCapActive =
    !!defaultRowCap && !showAll && sortedData.length > defaultRowCap;
  const displayedData = useMemo(() => {
    if (!rowCapActive) return sortedData;
    return sortedData.slice(0, defaultRowCap!);
  }, [sortedData, rowCapActive, defaultRowCap]);

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
    count: virtualizationActive ? displayedData.length : 0,
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
          next.add(String(getNestedValue(displayedData[i], keyField)));
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
    // Depend on sortedData too (2026-07-03, invoices stale-selection bug):
    // the emitted selection must always be a subset of the rows currently
    // shown. Previously this only re-ran on checkbox clicks, so applying a
    // filter left the parent holding rows that were no longer visible —
    // "1 selected" toolbars over an empty grid, batch actions counting
    // invisible rows. Internal selectedKeys are kept, so clearing the filter
    // restores the same ticks.
    const selected = sortedData.filter(row => selectedKeys.has(String(getNestedValue(row, keyField))));
    onSelectionChange(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKeys, sortedData]);

  // Mirror the grid's internal filter + sort result back to the parent.
  // Scoped to the stable identity of `onFilteredDataChange` so a caller
  // that passes a non-memoised callback doesn't trigger an infinite loop.
  useEffect(() => {
    if (!onFilteredDataChange) return;
    onFilteredDataChange(sortedData);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedData]);

  // Notify the parent of global-search changes so it can widen a
  // server-paginated fetch to the whole dataset while a search is
  // active. Scoped to searchText only (callback identity excluded) so a
  // non-memoised handler can't loop.
  useEffect(() => {
    if (!onSearchChange) return;
    onSearchChange(deferredSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredSearch]);

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
      <div className="flex flex-wrap items-center gap-2 border border-b-0 border-[#E2DDD8] bg-[#FAFAF8] px-2 py-1.5 rounded-t">
        {/* Search — h-9 / text-sm for finger-target on iPad Safari */}
        <div className="relative flex-1 max-w-[280px] max-md:max-w-full">
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

        {/* Export — WYSIWYG: the CURRENT visible columns over the CURRENT
            filtered+sorted rows. Opt-in per page via the `exportName` prop. */}
        {exportName && (
          <div className="relative">
            <button
              className={cn(
                "flex items-center gap-1 rounded border h-9 px-3 text-sm font-medium transition-colors",
                showExportMenu ? "border-[#6B5C32] bg-[#6B5C32]/10 text-[#6B5C32]" : "border-[#DDD] text-[#666] hover:border-[#999]",
              )}
              onClick={() => setShowExportMenu((v) => !v)}
              title="Export the current view"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
              Export
            </button>
            {showExportMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowExportMenu(false)} />
                <div className="absolute right-0 z-50 mt-1 w-64 rounded-md border border-[#E2DDD8] bg-white py-1 shadow-lg text-sm">
                  {(() => {
                    const today = new Date().toISOString().slice(0, 10);
                    const label = exportSheetLabel || exportName;
                    const listingAoa = (): Aoa =>
                      buildListingAoa(visibleColumns as unknown as ExportColumn<T>[], sortedData);
                    const run = (aoa: Aoa, kind: string, ext: "xlsx" | "csv") => {
                      setShowExportMenu(false);
                      const fname = exportFilename(exportName, kind, ext, today);
                      if (ext === "xlsx") void exportReportXlsx(fname, label, aoa);
                      else exportReportCsv(fname, aoa);
                    };
                    const Item = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) => (
                      <button
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[#333] hover:bg-[#F0ECE9]"
                        onClick={onClick}
                      >
                        {children}
                      </button>
                    );
                    return (
                      <>
                        <div className="px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#9CA3AF]">
                          Listing · {sortedData.length} rows, {visibleColumns.length} cols
                        </div>
                        <Item onClick={() => run(listingAoa(), "listing", "xlsx")}>Listing → Excel</Item>
                        <Item onClick={() => run(listingAoa(), "listing", "csv")}>Listing → CSV</Item>
                        {detailExport && (
                          <>
                            <div className="my-1 border-t border-[#F0ECE9]" />
                            <div className="px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#9CA3AF]">
                              {detailExport.label} · per line item
                            </div>
                            <Item onClick={() => run(detailExport.build(sortedData), "detail", "xlsx")}>
                              {detailExport.label} → Excel
                            </Item>
                            <Item onClick={() => run(detailExport.build(sortedData), "detail", "csv")}>
                              {detailExport.label} → CSV
                            </Item>
                          </>
                        )}
                      </>
                    );
                  })()}
                </div>
              </>
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
              printPresetLabel={gridId ? printPresetLabel : undefined}
              onSaveAsPrintPreset={gridId && printPresetLabel ? saveAsPrintPreset : undefined}
              onResetPrintPreset={gridId && printPresetLabel ? resetPrintPreset : undefined}
            />
          )}
        </div>

        {/* Row count */}
        <span className="text-[10px] text-[#999] tabular-nums">
          {sortedData.length} of {data.length} records
        </span>
      </div>

      {/* Table — no own border/rounding: the grid is wrapped in a Card on every
          list page, so a border here just drew a second frame inside the Card
          ("box in a box"). A thin top divider keeps the header separated from
          the toolbar above. */}
      <div
        ref={scrollRef}
        className="overflow-auto border-t border-[#E2DDD8]"
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
            {visibleColumns.map(col => {
              const w = colWidths[col.key] || col.width;
              return (
                <col
                  key={col.key}
                  style={w ? { width: w, minWidth: w } : undefined}
                />
              );
            })}
            {/* Kebab column — renders only when contextMenuItems is set
                so list pages without row actions stay unchanged. */}
            {hasContextMenu && <col style={{ width: "40px" }} />}
          </colgroup>

          <thead className={cn(stickyHeader && "sticky top-0 z-30")}>
            {/* Header row */}
            <tr className="border-b border-[#D0D0D0] bg-[#F0ECE9]">
              {selectable && (
                <th
                  className={cn(
                    "px-2 py-1.5 text-center bg-[#F0ECE9]",
                    // The gutter is ALWAYS the first frozen cell (left:0).
                    // It used to freeze only when a sticky column run existed,
                    // but only 4 grids declare one — on the other ~20 selectable
                    // grids the tick column simply scrolled out of sight, so the
                    // footer said "2 selected" while the owner could not see a
                    // single tick (his Service Orders screenshot, 2026-07-17).
                    // Freezing it is a no-op on grids that never scroll
                    // sideways, and it also stops the 32px the offsets reserve
                    // for it from leaking ("走漏风") where a run does exist.
                    "sticky left-0 z-20",
                  )}
                  style={{ width: "32px", minWidth: "32px", maxWidth: "32px" }}
                >
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
                    {/* Drag-to-resize handle on the column's right edge.
                        Persists per gridId (datagrid-colw-*); double-click
                        resets to the column's default width. */}
                    <span
                      role="separator"
                      aria-orientation="vertical"
                      title="Drag to resize · double-click to reset"
                      onMouseDown={(e) => startColumnResize(e, col.key)}
                      onDoubleClick={(e) => { e.stopPropagation(); resetColumnWidth(col.key); }}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize select-none hover:bg-[#6B5C32]/40 z-30"
                    />
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
              // Skeleton rows — one cell per visible column so the grid keeps
              // its shape while data loads, instead of a single centred
              // "Loading..." string that collapses the layout.
              Array.from({ length: 6 }).map((_, rowIdx) => (
                <tr key={`skeleton-${rowIdx}`} className="border-b border-[#E2DDD8]">
                  {selectable && (
                    <td className="px-2 py-2.5">
                      <Skeleton height={14} width={14} />
                    </td>
                  )}
                  {visibleColumns.map((col, colIdx) => (
                    <td key={col.key} className="px-3 py-2.5">
                      <Skeleton height={13} width={colIdx === 0 ? "60%" : "85%"} />
                    </td>
                  ))}
                  {hasContextMenu && (
                    <td className="px-1 py-2.5">
                      <Skeleton height={14} width={14} />
                    </td>
                  )}
                </tr>
              ))
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
                          className={cn(
                            "p-2 text-center cursor-pointer",
                            // Freeze the gutter with an opaque, row-matched bg —
                            // a transparent sticky cell lets the scrolling cells
                            // show through (the leak the owner saw beside Send /
                            // SO ID). Mirrors the data sticky cells' bg logic
                            // below, and must stay in step with the <th> above.
                            "sticky left-0 z-10 bg-white",
                            isEven && "bg-[#FAFAFA]",
                            rowClassName?.(row),
                            isSelected && "!bg-[#CCE0FF]",
                          )}
                          style={{ minHeight: "40px", width: "32px", minWidth: "32px", maxWidth: "32px" }}
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
                        // Cell-content sizing ("fit fit", 2026-06-11). For a
                        // column WITH a resolved width (declared `width` or a
                        // user resize) the content div clips via width:0 +
                        // min-width:100%: it contributes ~nothing to the auto
                        // table layout's intrinsic widths (the <col> width
                        // stays the column's floor), then renders at 100% of
                        // the LIVE cell width. When the declared widths sum to
                        // less than the container, the browser flexes every
                        // column proportionally — and the content now USES
                        // that flexed width instead of staying clamped at the
                        // declared px. The previous maxWidth clamp left the
                        // right side of every stretched column as permanent
                        // dead space and kept long values ellipsized even when
                        // the column had room (Wei Siang: the grid never "fit"
                        // the page). Narrow viewports are unchanged: the <col>
                        // width floors the column, the table overflows into
                        // the horizontal scrollbar exactly as before, and the
                        // div truncates at that floor. Columns with NO width
                        // keep the legacy 300px cap — they have no <col> floor,
                        // so the fill trick would let them collapse to header
                        // width. Opt out per column with `noClip` (cells that
                        // must wrap / go multi-line).
                        const resolvedWidth = colWidths[col.key] || col.width;
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
                            {col.noClip ? (
                              <DefaultCellRenderer column={col} value={value} row={row} index={index} search={deferredSearch} />
                            ) : (
                              <div
                                className="truncate"
                                style={
                                  resolvedWidth
                                    ? { width: 0, minWidth: "100%" }
                                    : { maxWidth: "300px" }
                                }
                              >
                                <DefaultCellRenderer column={col} value={value} row={row} index={index} search={deferredSearch} />
                              </div>
                            )}
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
                  virtualizationActive && displayedData.length >= VIRTUALIZE_MIN_ROWS;
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
                    (v) => v.index < displayedData.length,
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
                  const totalSize = displayedData.length * ROW_HEIGHT_PX;
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
                    const row = displayedData[v.index];
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

                displayedData.forEach((row, index) => {
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
        <span className="flex items-center gap-2">
          <span>
            {/* Count only selections VISIBLE under the current filter — the
                raw selectedKeys.size kept saying "1 selected" over a filtered
                list with zero ticked rows (BUG-2026-07-03-003 follow-up). */}
            {(() => {
              const visibleSelected = sortedData.reduce(
                (n, row) =>
                  n + (selectedKeys.has(String(getNestedValue(row, keyField))) ? 1 : 0),
                0,
              );
              return visibleSelected > 0
                ? `${visibleSelected} selected`
                : `Record 1 of ${sortedData.length.toLocaleString()}`;
            })()}
          </span>
          {/* Row cap pill — filter / sort / search still act on the full
              sortedData; this only toggles how many rows are painted. */}
          {rowCapActive && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="rounded bg-white border border-[#D8D2CB] px-2 py-0.5 font-medium text-[#1F1D1B] hover:bg-[#FAF8F4]"
              title={`Painting first ${defaultRowCap!.toLocaleString()} rows for speed. Filter and Search still scan all ${sortedData.length.toLocaleString()} rows — click to render every match.`}
            >
              Showing {displayedData.length.toLocaleString()} of {sortedData.length.toLocaleString()} rows · Show all {sortedData.length.toLocaleString()}
            </button>
          )}
          {showAll && !!defaultRowCap && sortedData.length > defaultRowCap && (
            <button
              type="button"
              onClick={() => setShowAll(false)}
              className="rounded border border-[#D8D2CB] px-2 py-0.5 text-[#6B5C32] hover:bg-white"
              title={`Re-cap to ${defaultRowCap.toLocaleString()} rows for a faster scroll.`}
            >
              Cap at {defaultRowCap.toLocaleString()}
            </button>
          )}
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
