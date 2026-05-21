import { useState, useEffect, useLayoutEffect, useCallback, useDeferredValue, useMemo, useRef, useTransition } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useUrlState, useUrlBatch } from "@/lib/use-url-state";
import { useSessionState } from "@/lib/use-session-state";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Plus, Lock, ExternalLink, Filter } from "lucide-react";
import { DataGrid } from "@/components/ui/data-grid";
import type { Column, ContextMenuItem } from "@/components/ui/data-grid";
import { getQRCodeDataURL, generateStickerData } from "@/lib/qr-utils";
import { QRImg } from "@/components/qr-img";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
// useTimeout — P4.3 effect-replacement (still referenced at L2386+).
import { useTimeout } from "@/lib/scheduler";
import { useToast } from "@/components/ui/toast";
import { getCurrentUser } from "@/lib/auth";
import { readCsrfCookie, CSRF_HEADER_NAME } from "@/lib/csrf";
import { workerCoversDept } from "@/lib/worker";

// Build headers for mutating fetches. The default Hookka fetcher (fetchJson)
// auto-injects X-CSRF-Token, but Phase 2.5's sendOneDraft / flushDrafts go
// through raw `fetch` (so we can distinguish status codes for retry logic +
// inspect the bulk-patch per-row payload). Forgetting the header surfaces as
// "CSRF token missing or invalid" 403 in the failure modal — Wei Siang hit
// this on a FAB_SEW PIC patch 2026-05-12 and saw it auto-retry 1×, both
// without the header, and finally land in the modal.
function csrfHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...(extra || {}) };
  const csrf = readCsrfCookie();
  if (csrf) h[CSRF_HEADER_NAME] = csrf;
  return h;
}

import type { CellState, JobCard, ProductionOrder, Worker } from "./types";
import {
  DEPARTMENTS,
  cellFor,
  fmtShortDate,
  todayISO,
} from "./utils";
import { CellBox } from "./components/CellBox";
import { ProductDetailLine } from "./components/ProductDetailLine";
import { CreateStockPODialog } from "./components/CreateStockPODialog";
import {
  BatchActionToolbar,
  ApplyBatchDateDialog,
  ApplyBatchDueDateDialog,
  ApplyBatchPicDialog,
  SaveToFolderDialog,
} from "./components/BatchActionToolbar";
// PatchFailureModal removed 2026-05-12 — see flushDrafts toast.error branch.

// ----- Overdue breakdown row (mirrors /api/production-orders/overdue-counts) -----
// Server returns overdueCategories as string[] (it was Set<string> when the FE
// computed it locally; arrays serialise cleanly through JSON whereas Sets do
// not). Consumers below use .includes() instead of .has().
type OverdueSORow = {
  soId: string;          // grouping key — companySOId / salesOrderId / CO equivalent
  displaySoId: string;   // human-facing label (e.g. "SO-2604-001")
  customer: string;
  totalPos: number;      // total non-CANCELLED POs under this SO
  overduePos: number;
  earliest: string;      // earliest overdue JC dueDate (or PO.targetEndDate in Overview mode)
  poStatus: string;      // representative PO status seen first in the group
  salesOrderId: string;  // canonical id for navigation (may be empty for CO-only)
  overdueCategories: string[]; // itemCategory list across this SO's *overdue* POs
};

// ----- Overview sort / filter shared types (used by header sub-components) -----
type OverviewSortKey =
  | "soId" | "product" | "customer" | "customerPO" | "specialOrder"
  | "qty" | "due"
  | "FAB_CUT" | "FAB_SEW" | "FOAM" | "WOOD_CUT"
  | "FRAMING" | "WEBBING" | "UPHOLSTERY" | "PACKING";
type OverviewSort = { key: OverviewSortKey; dir: "asc" | "desc" } | null;

// ----- Overview header cell — sort indicator + filter popover trigger -----
//
// Memoized internally via the shallow comparison of the props the cell
// reads (sort + open + active flags). Filter popover bodies are rendered
// lazily (only when openFilterCol === filterCol) so we don't pay the
// render cost for 14 hidden popovers on every keystroke.
function OverviewHeader({
  label,
  align,
  border,
  sortKey,
  sort,
  cycle,
  filterCol,
  filterActive,
  openFilterCol,
  setOpenFilterCol,
  renderFilter,
}: {
  label: string;
  align?: "left" | "center";
  border?: boolean;
  sortKey: OverviewSortKey;
  sort: OverviewSort;
  cycle: (k: OverviewSortKey) => void;
  filterCol: string;
  filterActive: boolean;
  openFilterCol: string | null;
  setOpenFilterCol: (v: string | null) => void;
  renderFilter: () => React.ReactNode;
}) {
  const isSorted = sort?.key === sortKey;
  const dir = isSorted ? sort?.dir : null;
  const open = openFilterCol === filterCol;
  return (
    <div
      className={`relative px-1.5 py-2.5 ${align === "center" ? "text-center" : "text-left"} ${border ? "border-l border-[#E6E0D9]" : ""}`}
    >
      <div className={`flex items-center gap-1 ${align === "center" ? "justify-center" : ""}`}>
        <button
          type="button"
          className="flex items-center gap-0.5 hover:text-[#1F1D1B] cursor-pointer truncate text-[10px] font-semibold uppercase tracking-wider text-[#6B7280]"
          onClick={() => cycle(sortKey)}
          title={`Sort by ${label} — click to cycle asc / desc / off`}
        >
          <span className="truncate">{label}</span>
          <span className="text-[8px] leading-none flex flex-col flex-shrink-0">
            <span className={dir === "asc" ? "text-[#6B5C32]" : "text-[#D1CCC4]"}>▲</span>
            <span className={dir === "desc" ? "text-[#6B5C32]" : "text-[#D1CCC4]"}>▼</span>
          </span>
        </button>
        <button
          type="button"
          className="relative h-4 w-4 flex items-center justify-center rounded hover:bg-[#E6E0D9] cursor-pointer flex-shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            setOpenFilterCol(open ? null : filterCol);
          }}
          title="Filter this column"
        >
          <Filter
            className={`h-2.5 w-2.5 ${filterActive ? "text-[#6B5C32]" : "text-[#9CA3AF]"}`}
          />
          {filterActive && (
            <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-[#9C6F1E]" />
          )}
        </button>
      </div>
      {open && (
        <>
          {/* Outside-click + esc capture overlay so the popover dismisses
              cleanly without trapping clicks anywhere else. */}
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpenFilterCol(null)}
          />
          <div
            className="absolute top-full left-0 mt-1 z-40 bg-white border border-[#E6E0D9] rounded-md shadow-lg p-3 min-w-[180px] normal-case tracking-normal text-[12px] font-normal text-[#1F1D1B]"
            onClick={(e) => e.stopPropagation()}
          >
            {renderFilter()}
          </div>
        </>
      )}
    </div>
  );
}

function TextContainsFilter({
  value, onChange, placeholder,
}: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full h-7 px-2 border border-[#E6E0D9] rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/40"
      autoFocus
    />
  );
}

function NumericRangeFilter({
  min, max, onChange,
}: { min: string; max: string; onChange: (min: string, max: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        value={min}
        placeholder="Min"
        onChange={(e) => onChange(e.target.value, max)}
        className="w-16 h-7 px-2 border border-[#E6E0D9] rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/40"
      />
      <span className="text-[#9CA3AF]">–</span>
      <input
        type="number"
        value={max}
        placeholder="Max"
        onChange={(e) => onChange(min, e.target.value)}
        className="w-16 h-7 px-2 border border-[#E6E0D9] rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/40"
      />
    </div>
  );
}

function DateRangeFilter({
  from, to, onChange,
}: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-1.5 text-[11px] text-[#6B7280]">
        <span className="w-8">From</span>
        <input
          type="date"
          value={from}
          onChange={(e) => onChange(e.target.value, to)}
          className="flex-1 h-7 px-2 border border-[#E6E0D9] rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/40"
        />
      </label>
      <label className="flex items-center gap-1.5 text-[11px] text-[#6B7280]">
        <span className="w-8">To</span>
        <input
          type="date"
          value={to}
          onChange={(e) => onChange(from, e.target.value)}
          className="flex-1 h-7 px-2 border border-[#E6E0D9] rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/40"
        />
      </label>
      {(from || to) && (
        <button
          type="button"
          className="text-[11px] text-[#6B5C32] hover:underline self-end"
          onClick={() => onChange("", "")}
        >
          Clear
        </button>
      )}
    </div>
  );
}

function MultiSelectFilter({
  options, selected, onChange,
}: { options: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  const set = new Set(selected);
  const toggle = (v: string) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange(Array.from(next));
  };
  return (
    <div className="flex flex-col gap-1 max-h-56 overflow-y-auto pr-1 min-w-[200px]">
      {selected.length > 0 && (
        <button
          type="button"
          className="text-[11px] text-[#6B5C32] hover:underline self-end"
          onClick={() => onChange([])}
        >
          Clear ({selected.length})
        </button>
      )}
      {options.length === 0 ? (
        <span className="text-[11px] text-[#9CA3AF]">No options</span>
      ) : options.map((opt) => (
        <label key={opt} className="flex items-center gap-1.5 cursor-pointer hover:bg-[#FAF8F4] rounded px-1 py-0.5">
          <input
            type="checkbox"
            checked={set.has(opt)}
            onChange={() => toggle(opt)}
            className="h-3 w-3"
          />
          <span className="text-[12px] truncate" title={opt}>{opt}</span>
        </label>
      ))}
    </div>
  );
}

function DeptStatusFilter({
  selected, onChange,
  dateRange, onDateRangeChange,
}: {
  selected: ("pending" | "overdue" | "done")[];
  onChange: (next: ("pending" | "overdue" | "done")[]) => void;
  dateRange?: { from: string; to: string };
  onDateRangeChange?: (next: { from: string; to: string }) => void;
}) {
  const opts: { value: "pending" | "overdue" | "done"; label: string; dot: string }[] = [
    { value: "pending", label: "Pending", dot: "bg-[#F4B860]" },
    { value: "overdue", label: "Overdue", dot: "bg-[#D9534F]" },
    { value: "done", label: "Completed", dot: "bg-[#4F7C3A]" },
  ];
  const set = new Set(selected);
  const toggle = (v: "pending" | "overdue" | "done") => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange(Array.from(next));
  };
  const range = dateRange ?? { from: "", to: "" };
  const hasAny = selected.length > 0 || !!range.from || !!range.to;
  const clearAll = () => {
    onChange([]);
    onDateRangeChange?.({ from: "", to: "" });
  };
  return (
    <div className="flex flex-col gap-1 min-w-[180px]">
      {opts.map((o) => (
        <label key={o.value} className="flex items-center gap-1.5 cursor-pointer hover:bg-[#FAF8F4] rounded px-1 py-0.5">
          <input
            type="checkbox"
            checked={set.has(o.value)}
            onChange={() => toggle(o.value)}
            className="h-3 w-3"
          />
          <span className={`h-2 w-2 rounded-full ${o.dot}`} />
          <span className="text-[12px]">{o.label}</span>
        </label>
      ))}
      {onDateRangeChange && (
        <>
          <div className="border-t border-[#E6E0D9] my-1" />
          <div className="text-[10px] text-[#6B7280] px-1">Date range</div>
          <input
            type="date"
            value={range.from}
            onChange={(e) => onDateRangeChange({ ...range, from: e.target.value })}
            className="text-[11px] px-1.5 py-0.5 border border-[#E6E0D9] rounded"
            title="From (cell date)"
          />
          <input
            type="date"
            value={range.to}
            onChange={(e) => onDateRangeChange({ ...range, to: e.target.value })}
            className="text-[11px] px-1.5 py-0.5 border border-[#E6E0D9] rounded"
            title="To (cell date)"
          />
        </>
      )}
      {hasAny && (
        <button
          type="button"
          className="text-[11px] text-[#6B5C32] hover:underline self-end mt-1"
          onClick={clearAll}
        >
          Clear
        </button>
      )}
    </div>
  );
}

// Mirrors api/routes/fg-units.ts isHeadboardOnlySpecial — single rule shared
// across the codebase so the production "Filter Incomplete" toggle stays in
// step with the backend cascade. Inline duplicate of the helper in
// pages/delivery/index.tsx; consolidate to src/lib/ when a third caller shows
// up (see feedback_validation_frontend_backend_unified.md).
function isHbOnlySpecial(specialOrder: string | null | undefined): boolean {
  if (!specialOrder) return false;
  return specialOrder.toLowerCase().includes("headboard only");
}

// Drop DIVAN UPH JCs when the PO is a BEDFRAME + Headboard Only — matches
// filterJcsForCompletionGate in the backend production-orders route. Legacy
// HB-only POs (created before commit 9086352) carry stranded DIVAN job cards
// that will never complete; ignoring them lets the row drop out of the
// "Filter Incomplete" view once the only piece that matters (HB) is done.
function pickRelevantUphCards(po: ProductionOrder): JobCard[] {
  const uph = (po.jobCards || []).filter(
    (j) => j.departmentCode === "UPHOLSTERY",
  );
  const isBf = (po.itemCategory || "").toUpperCase() === "BEDFRAME";
  if (!isBf || !isHbOnlySpecial(po.specialOrder)) return uph;
  return uph.filter((j) => (j.wipType || "").toUpperCase() !== "DIVAN");
}

// ----- main page -----

// Rendering mode — injected by the per-route wrappers in overview.tsx / dept.tsx.
//   - full (default): legacy behavior — all tabs visible, starts on Overview.
//   - overview:       hides the dept tab bar + dept sub-view; shows only
//                     the overview matrix. Served at /production.
//   - dept:           hides the tab bar; locks activeTab to `deptCode` and
//                     narrows the network fetch to that dept only. Served at
//                     /production/<code> (e.g. /production/fab-cut).
export type ProductionPageMode = "full" | "overview" | "dept";

export default function ProductionPage({
  mode = "full",
  deptCode,
}: { mode?: ProductionPageMode; deptCode?: string } = {}) {
  const navigate = useNavigate();
  const { toast } = useToast();
  // Tablet breakpoint — default-hide low-priority DataGrid columns when the
  // viewport is narrower than ~lg (1280px gives a safety margin over the
  // Tailwind lg=1024 breakpoint so iPad Mini landscape ~1180px also hides
  // them). Operator can still re-enable via the Columns picker.
  const isTablet = useMediaQuery("(max-width: 1280px)");
  // Slim payload opt-in: fields=minimal drops ~20 unused PO fields + the
  // entire piece_pics tree on the wire. The Production page never reads
  // them and this response ships ~530 POs × ~9k JCs — the largest payload
  // in the app. Server still returns the full shape by default for
  // backward compat with the PO detail page + other consumers.
  //
  // When mounted in dept mode, also pass ?dept=CODE so the backend narrows
  // each PO's jobCards array to only that dept's rows. For a typical PO
  // with 15 JCs spread across 8 depts, this drops the response to ~1/8 the
  // size (minimal ~1.5MB → ~200KB for FAB_CUT, less for depts with fewer
  // JCs like FOAM / WEBBING).
  //
  // LAZY LOAD: the bare URL is `null` until the user touches a filter (or
  // explicitly hits "Load all"). useCachedJson skips the fetch when URL is
  // null, so the initial /production render is instant and the 533-PO
  // payload is only pulled when the operator actually wants to look at
  // something. Per-dept routes (mode="dept") still auto-fetch since landing
  // there means the user already wants the dept's queue.
  // No PO-status pre-filter at the API layer (2026-04-27 user request) —
  // load ALL POs (PENDING / IN_PROGRESS / ON_HOLD / COMPLETED /
  // CANCELLED) and let the per-column Status filter on the grid handle
  // any narrowing the operator wants. Total PO count is ~560 so the
  // payload size penalty is negligible vs the dropped Lifecycle dropdown
  // it replaces (which was redundant with the column filter the user
  // already had at hand).
  // shouldFetch needs to live up here because some downstream effects
  // depend on it. baseUrl / dueQueryFrag are deferred to AFTER
  // fltDueFrom/fltDueTo are declared (~line 791) to dodge a TDZ error.
  const [shouldFetch, setShouldFetch] = useState<boolean>(mode === "dept");
  // Date-seed gate for the orders fetch.
  //
  // Before F1 (2026-05-11): this returned false on cold dept-mount when
  // the URL had no from/to, which gated the orders fetch off until the
  // first-mount seed useEffect landed today in the URL — a 2-effect / 3-
  // render waterfall (~280ms cold-start cost) before the main fetch
  // could fire.
  //
  // After F1: we ALWAYS return true for dept mode. The cold-start today
  // fallback (effectiveDueFrom/effectiveDueTo below) ensures the fetch
  // URL has from/to on the very first render, so we no longer need to
  // gate. The first-mount seed useEffect still runs (writes today to
  // the URL for shareable / refresh-safe deep links) but it's a
  // background concern now, not on the fetch critical path.
  // Always true now — see comment above. Kept as state-shaped for minimal
  // diff with surrounding code that reads `datesSeeded` directly.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- setDatesSeeded retained for future flip if needed; intentionally unused after F1
  const [datesSeeded, setDatesSeeded] = useState<boolean>(true);
  const { data: workersResp } = useCachedJson<{ success?: boolean; data?: Worker[] }>("/api/workers");
  const { data: warehouseResp } = useCachedJson<{ success?: boolean; data?: Array<{ rack: string; status: string; productCode?: string; customerName?: string }> }>("/api/warehouse");
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  // When mounted at /production/<code>, lock activeTab to that dept code
  // immediately so the first render skips the Overview matrix. overview.tsx
  // leaves it at ALL. The plain /production mount (mode=full) also starts
  // on ALL, matching legacy behavior.
  const initialTab = mode === "dept" && deptCode ? deptCode : "ALL";
  const [activeTab, setActiveTabRaw] = useState<"ALL" | string>(initialTab);
  // Keep activeTab in sync with the deptCode prop on dept-to-dept hops.
  // Sibling dept routes (/production/fab-cut → /production/foam) reuse
  // this component instance (the dept.tsx wrapper deliberately does NOT
  // set key={code} — see its comment for why). Without atomic syncing
  // the operator sees the OLD dept's H2 / sidebar / rows for several
  // seconds until React's deferred work commits.
  //
  // useLayoutEffect (not useEffect) — fires BEFORE paint so the very
  // first frame on the new dept already has activeTab pointing at the
  // new dept. orders are cleared atomically so the DataGrid empty
  // state (and the loading flag below) shows immediately and the
  // operator never sees Foam's H2 over Fab Sew's rows.
  /* eslint-disable react-hooks/set-state-in-effect -- syncing activeTab to URL deptCode on route change */
  useLayoutEffect(() => {
    if (mode === "dept" && deptCode && deptCode !== activeTab) {
      // activeTab stays an URGENT update — the H2 / sidebar / column set
      // must flip on the first frame of the new dept (see comment above).
      setActiveTabRaw(deptCode);
      // The setOrders([]) clear forces baseRows to rebuild every grid row.
      // Run it as an interruptible transition so the operator's clicks
      // during the switch aren't blocked by that synchronous recompute.
      startDeptSwitch(() => {
        setOrders([]);
      });
    } else if (mode === "overview" && activeTab !== "ALL") {
      setActiveTabRaw("ALL");
    }
  }, [mode, deptCode, activeTab]);
  /* eslint-enable react-hooks/set-state-in-effect */
  // Wrapped setter that marks tab-switch start time; the matching end is
  // recorded at the top of the next render via useEffect below. Over 200ms
  // gets a [slow-tab] warn.
  const tabSwitchStart = useRef<number | null>(null);
  const setActiveTab = useCallback((next: "ALL" | string) => {
    tabSwitchStart.current = performance.now();
    setActiveTabRaw(next);
  }, []);
  useEffect(() => {
    if (tabSwitchStart.current == null) return;
    const dur = Math.round(performance.now() - tabSwitchStart.current);
    tabSwitchStart.current = null;
    if (dur >= 200) {
      console.warn(`[slow-tab] tab=${activeTab} dur_ms=${dur}`);
    }
  }, [activeTab]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  // Warehouse rack slots — fetched once, used by the Packing dept Rack
  // column's dropdown. Each entry carries its occupancy state so the <select>
  // can grey out taken racks.
  const [rackOptions, setRackOptions] = useState<
    { label: string; occupied: boolean; occupant: string }[]
  >([]);

  // Single shared hidden <input type="date"> used by every clickable pill /
  // cell on the page. Rendering one input per row × dept was 3k+ DOM nodes
  // and made the Overview matrix noticeably laggy on click; this pool-of-1
  // approach keeps the page light. Click handler rewires value + onChange
  // on the fly and calls showPicker() to pop the native calendar.
  //
  // 2026-05-10 bug fix — operator reported clicking production completion
  // date cells did nothing. showPicker() was opening the calendar but
  // picking a date wasn't firing patchJobCard. Two separate root causes:
  //   1. The input had `pointer-events: none` so Chromium would not deliver
  //      the native `change` event when the picker committed. The original
  //      reason for pointer-events:none was so the 1×1 input at top-left
  //      wouldn't intercept clicks — but at 1×1 in the corner it can't be
  //      reached by the cursor anyway, and once we resize+reposition over a
  //      cell we WANT it interactable.
  //   2. React's synthetic onChange runs through root-level event delegation;
  //      with the input cycled across many cells per second the delegated
  //      handler can be stale. Binding `change` natively to the actual DOM
  //      node guarantees delivery.
  // Fix is in the ref + useEffect below, plus removed pointer-events:none in
  // the JSX. See also `pickerSupportedRef` for the iPad-Safari fallback.
  const sharedDateInputRef = useRef<HTMLInputElement>(null);
  const sharedDateChangeRef = useRef<(v: string) => void>(() => {});
  // Native `change` listener — see comment block above. Binds once on mount,
  // reads the LIVE ref each invocation so successive openDatePicker calls
  // always route to the latest onChange.
  useEffect(() => {
    const el = sharedDateInputRef.current;
    if (!el) return;
    const handler = () => {
      try {
        sharedDateChangeRef.current(el.value);
      } catch (err) {
        console.error("[sharedDatePicker] onChange threw", err);
      }
    };
    el.addEventListener("change", handler);
    return () => el.removeEventListener("change", handler);
  }, []);
  // Feature-detect showPicker once at mount (iOS < 16.4 / older Safari /
  // some Android WebViews don't have it). Used both to pick the open path
  // and so we can show the operator a toast if it's missing.
  const pickerSupportedRef = useRef<boolean>(true);
  useEffect(() => {
    const el = sharedDateInputRef.current;
    pickerSupportedRef.current = !!el && typeof el.showPicker === "function";
  }, []);
  // Opens the shared native date picker. `anchor` is the cell element that
  // was clicked — we reposition the invisible input on top of it so the
  // browser anchors the popup calendar near the cell instead of at the
  // page's bottom-left corner (where fixed 0,0 would put it).
  const openDatePicker = useCallback(
    (seed: string, onChange: (v: string) => void, anchor?: Element | null) => {
      const el = sharedDateInputRef.current;
      if (!el) return;
      sharedDateChangeRef.current = onChange;
      el.value = seed ? seed.slice(0, 10) : "";
      // Position + SIZE the hidden input to overlay the clicked cell. Chromium
      // anchors showPicker() to where the input physically renders — a 1×1
      // node at the corner ends up dragging the popup to the page's top-left
      // (the symptom Wei Siang flagged 2026-05-05). Resizing to the cell box
      // forces the popup to anchor right under the cell.
      if (anchor instanceof HTMLElement) {
        const r = anchor.getBoundingClientRect();
        el.style.left = `${r.left}px`;
        el.style.top = `${r.top}px`;
        el.style.width = `${Math.max(r.width, 1)}px`;
        el.style.height = `${Math.max(r.height, 1)}px`;
      } else {
        // No anchor — fall back to current viewport top-left (legacy callers
        // that don't pass an anchor; still useful for keyboard shortcuts).
        el.style.left = "0px";
        el.style.top = "0px";
        el.style.width = "1px";
        el.style.height = "1px";
      }
      // Force a synchronous layout flush — Chromium's showPicker() anchors
      // the calendar to where the input was laid out, NOT the styles we just
      // assigned. Without this read, the very FIRST click after page load
      // pops the calendar at the input's cached origin (top-left of the
      // viewport, i.e. its initial 0,0 fixed position) even though the
      // inline style now points at the cell. Reading getBoundingClientRect
      // forces the browser to recompute layout before showPicker() reads it.
      void el.getBoundingClientRect();

      const tryShowPicker = () => {
        if (pickerSupportedRef.current) {
          try {
            el.showPicker();
            return;
          } catch (err) {
            // showPicker can throw if the input is disconnected, not focusable,
            // or the user-gesture chain was broken. Fall through to focus/click
            // and surface the failure so the operator knows to refresh rather
            // than silently typing into thin air.
            console.warn("[openDatePicker] showPicker threw", err);
          }
        }
        // Fallback path — focus + synthetic click. On iPad Safari 16.4+ this
        // still pops the calendar; on older WebViews it focuses the (now
        // visible-via-1px-square) input so keyboard typing works as a last
        // resort. If even focus throws, surface a toast — silent failure was
        // the original 2026-05-10 bug surface.
        try {
          el.focus();
          el.click();
        } catch (err) {
          console.error("[openDatePicker] fallback failed", err);
          toast.error("Could not open date picker. Please refresh the page.");
        }
      };

      // 2026-05-12: Wei Siang reported "click on Completion Date sometimes
      // does nothing; clicking another column then back makes it work."
      // Root cause: even with the getBoundingClientRect() read above to
      // flush styles, showPicker() runs in the same microtask and sometimes
      // hits Chromium's pre-paint cache, anchoring the calendar at the
      // input's PREVIOUS position. The calendar opens — visually off-screen
      // or hidden behind elements — and the operator interprets the lack of
      // visible popup as "no response", dismisses it, and only after a
      // second cell click (which re-flushed positioning) does the popup
      // anchor correctly.
      //
      // Fix: defer showPicker() to the next animation frame. rAF callbacks
      // run AFTER the browser has committed style writes, so showPicker()
      // reads the freshly-positioned coordinates. The user-activation window
      // for showPicker() lasts ~5s after the click (verified in Chromium
      // source), so a 1-frame deferral is well within bounds — no rejection.
      requestAnimationFrame(tryShowPicker);
    },
    [toast],
  );
  // Page-level filters — apply to BOTH the Overview matrix and all dept
  // sub-tabs. URL-synced so a refresh / nav-and-back / share-link all
  // keep the user's exact view. The dept-tab itself is already URL'd via
  // the route (/production/<code>); these are the dropdowns alongside.
  // Sprint 5 F1: debounce the search query before it hits the URL. Direct
  // useUrlState binding pushed history.replace + a full filter useMemo on
  // every keystroke; on a 1k-PO dataset that re-runs through the picker /
  // baseRows pipeline four times per character. The local input state
  // updates instantly so the field stays responsive; the URL + filter
  // run lags by 200ms, which is below human perception for "did the
  // results filter".
  const [fltSearch, setFltSearch] = useUrlState<string>("q", "");
  const [fltSearchInput, setFltSearchInput] = useState(fltSearch);
  useEffect(() => {
    // eslint-disable-next-line no-restricted-syntax -- debounce timer with cancellation; useTimeout doesn't compose with the per-effect cleanup pattern here
    const t = setTimeout(() => setFltSearch(fltSearchInput), 200);
    return () => clearTimeout(t);
  }, [fltSearchInput, setFltSearch]);
  const [fltState, setFltState] = useUrlState<string>("state", "");
  const [fltCustomer, setFltCustomer] = useUrlState<string>("customer", "");
  // Date filters: URL is source of truth. Default value here is "" so
  // useUrlState NEVER falls back to today() on the round-trip — that
  // fallback caused Clear all + native picker Clear to silently snap
  // back to today (operators couldn't view full history). The first-
  // mount seed effect below writes today via the atomic useUrlBatch
  // helper so the operator's initial view stays narrowed to today.
  const [fltDueFrom, setFltDueFrom] = useUrlState<string>("from", "");
  const [fltDueTo, setFltDueTo] = useUrlState<string>("to", "");
  // Local mirrors so the date inputs stay responsive on iPad while the
  // URL setter (which triggers a re-render across the whole page) runs
  // in a transition. Without this, every keystroke / picker-commit fired
  // a synchronous re-render that included filter useMemos + DataGrid
  // re-shape — 1.2-1.6s of long-task blocking per change on prod data.
  const [fltDueFromInput, setFltDueFromInput] = useState(fltDueFrom);
  const [fltDueToInput, setFltDueToInput] = useState(fltDueTo);
  const [, startDateTransition] = useTransition();
  // Dept-switch transition. A department hop (Fab Cut → Fab Sew) clears
  // `orders` then refills it once the new dept's fetch lands. Both writes
  // force the heavy filteredOrders → pickerIndex → baseRows recompute
  // (baseRows rebuilds every grid row for ALL departments). Run those two
  // setOrders writes inside this transition so React renders the recompute
  // as INTERRUPTIBLE work — the operator's clicks during the switch are no
  // longer dropped while the main thread rebuilds rows. The existing
  // `loading` badge (driven by the fetch) already covers the visible wait,
  // so the transition's pending flag is intentionally not consumed.
  const [, startDeptSwitch] = useTransition();
  // Re-sync local mirror when URL state changes externally (Clear all,
  // first-mount seed, deep link, back-button). Skip when the input
  // already matches to dodge a self-loop.
  useEffect(() => {
    setFltDueFromInput((prev) => (prev === fltDueFrom ? prev : fltDueFrom));
  }, [fltDueFrom]);
  useEffect(() => {
    setFltDueToInput((prev) => (prev === fltDueTo ? prev : fltDueTo));
  }, [fltDueTo]);

  // F1 cold-start today fallback (2026-05-11).
  //
  // Problem: on a cold cold dept-page mount with no from/to in the URL,
  // the legacy flow was:
  //   render 1 → seed useEffect fires setUrlBatch(today, today) → state
  //   update → render 2 → datesSeeded-flip useEffect fires → render 3
  //   → useCachedJson sees the new URL → orders fetch fires.
  //
  // Net result: ~280ms of React work between bundle ready and the first
  // orders fetch firing — pure waterfall, no useful concurrency.
  //
  // Fix: before the seed useEffect lands, the fetch URL uses today as the
  // EFFECTIVE date filter. The URL state (fltDueFrom/fltDueTo) is still
  // empty on render 1 — we only inject today into the fetch URL string.
  // The seed useEffect later updates the URL state to match, which is a
  // no-op as far as the fetch is concerned (same URL string, useCachedJson
  // skips the duplicate). isColdStartRef gates this to ONLY render 1 of
  // each mount so that a user CLEARING the date filter post-mount still
  // gets the "show all history" semantic (open-ended fetch URL) — matches
  // the pre-F1 behavior the L591-596 doc-block was guarding.
  // F1.1 (2026-05-12) — atomic ref-flip + URL-seed (single layoutEffect).
  //
  // Background: the original F1 used two separate effects — a
  // useLayoutEffect to flip isColdStartRef and a regular useEffect to
  // call setUrlBatch. Between the two, there's a render window where
  // ref.current === false but fltDueFrom/fltDueTo are still '' (URL
  // hasn't been re-read by useUrlState yet). useColdStartTodayFallback
  // evaluates false in that window, effectiveDueFrom/To collapse to '',
  // and useCachedJson fires a SECOND fetch against the bare URL
  // (`?fields=minimal&dept=X` — no date filter). On Foam / Fab Cut this
  // showed up as 3 production-orders network calls per cold mount
  // (todayed → unbounded → todayed), the middle one wasting ~280ms.
  //
  // Fix: combine the ref-flip and the URL-seed into ONE useLayoutEffect
  // so React processes them atomically before the next render commits.
  // The old standalone seed useEffect below has been removed too.
  const isColdStartRef = useRef(true);
  useLayoutEffect(() => {
    isColdStartRef.current = false;
    if (mode === "dept" && !fltDueFrom && !fltDueTo) {
      const today = todayISO();
      setUrlBatch({ from: today, to: today });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot first-mount cold-start handler; deps frozen on purpose
  }, []);
  const useColdStartTodayFallback =
    mode === "dept" && isColdStartRef.current && !fltDueFrom && !fltDueTo;
  const effectiveDueFrom = useColdStartTodayFallback ? todayISO() : fltDueFrom;
  const effectiveDueTo = useColdStartTodayFallback ? todayISO() : fltDueTo;

  // dueQueryFrag/baseUrl/ordersResp moved here from earlier in the file
  // to satisfy the TDZ for fltDueFrom/fltDueTo (declared just above).
  const dueQueryFrag =
    (effectiveDueFrom ? `&dueFrom=${encodeURIComponent(effectiveDueFrom)}` : "") +
    (effectiveDueTo ? `&dueTo=${encodeURIComponent(effectiveDueTo)}` : "");
  const baseUrl =
    mode === "dept" && deptCode
      ? `/api/production-orders?fields=minimal&dept=${encodeURIComponent(deptCode)}${dueQueryFrag}`
      : `/api/production-orders?fields=minimal${dueQueryFrag}`;
  const ordersUrl: string | null = shouldFetch && datesSeeded ? baseUrl : null;
  const { data: ordersResp, loading, refresh: refreshOrders } = useCachedJson<{ success?: boolean; data?: ProductionOrder[] }>(ordersUrl);
  // Date-filter-INDEPENDENT fetch used solely by the "Total Overdue SO"
  // header chip + drill-down panel. Pulls ALL POs (no dueFrom/dueTo, no
  // dept narrowing) so the count reflects the system-wide overdue state,
  // not just the slice the operator has windowed into via the date inputs
  // above. Gated on `shouldFetch` so it doesn't fire on a cold landing —
  // the existing first-mount seed (from/to → today) flips shouldFetch on
  // anyway, so in practice this fetches once per session alongside the
  // main orders fetch.
  //
  // 2026-05-08: replaced the bare `/api/production-orders?fields=minimal`
  // fetch with a thin aggregate endpoint. The page used to pull ~800 POs +
  // 12k JCs (~8 MB body, ~4s TTFB) JUST to compute the Bedframe / Sofa
  // overdue counts + the drill-down breakdown rows. The new endpoint does
  // the GROUP BY in SQL and returns ~5 KB / ~50 ms. Dept context comes from
  // activeTab — Overview ("ALL") uses the targetEndDate vs UPHOLSTERY rule,
  // dept tabs use that dept's JC.dueDate rule (mirrors isOverduePO in
  // src/pages/production/utils.ts).
  const overdueDept: string | null = activeTab === "ALL" ? null : activeTab;
  const overdueCountsUrl: string | null =
    shouldFetch && datesSeeded
      ? `/api/production-orders/overdue-counts${overdueDept ? `?dept=${encodeURIComponent(overdueDept)}` : ""}`
      : null;
  const { data: overdueCountsResp } = useCachedJson<{
    success?: boolean;
    data?: {
      bedframeCount: number;
      sofaCount: number;
      breakdown: OverdueSORow[];
    };
  }>(overdueCountsUrl);
  // (Lifecycle dropdown removed 2026-04-27 — replaced by the Status
  // column's per-column filter. The grid loads all PO statuses now.)
  // New filters (2026-04-25):
  //   • Category — itemCategory (BEDFRAME / SOFA / ACCESSORY).
  //   • Date axis — switches the from/to range between targetEndDate
  //     (production due), customerDeliveryDate (promised to customer),
  //     and createdAt (when the PO was raised). Defaults to dueDate.
  //     TODO: confirm with user which "Date" axis they actually wanted —
  //     customerDeliveryDate isn't on the production_orders payload today
  //     (lives on the SO). Until that's wired, the dropdown still shows
  //     the option but matches against the field if/when present.
  // (Item type + Model filters removed 2026-05-08 per operator request —
  //  they didn't narrow the view in practice; the data now shows all
  //  item types + models by default. State hooks, URL params, and
  //  itemTypesByPo memo are gone with them.)
  const [fltCategory, setFltCategory] = useUrlState<string>("cat", "");
  // Date-axis dropdown removed 2026-05-07 — fltDateAxis is now a constant
  // 'dueDate'. The state hook stays so the filter logic conditional below
  // still resolves correctly without a deeper refactor.
  const [fltDateAxis] =
    useUrlState<"dueDate" | "customerDeliveryDate" | "created_at">("axis", "dueDate");
  // Hide CANCELLED POs by default (2026-05-06 user request — they were
  // showing as strikethrough rows that cluttered the daily view). Toggle
  // via ?showCancelled=1 in the URL when needed.
  const [showCancelled] = useUrlState<string>("showCancelled", "");
  // "Filter Incomplete" toggle (2026-05-08 operator request) — narrows
  // visible POs to those whose UPHOLSTERY JC is NOT yet COMPLETED /
  // TRANSFERRED. Sits ON TOP of the date-range filter so the operator can
  // ask "what's still in scope but hasn't shipped yet?". Persisted to
  // localStorage so the toggle survives reloads.
  const INCOMPLETE_FILTER_LS_KEY = "production:overview:incompleteFilter";
  const [incompleteOnly, setIncompleteOnly] = useState<boolean>(() => {
    try {
      return localStorage.getItem(INCOMPLETE_FILTER_LS_KEY) === "1";
    } catch {
      return false;
    }
  });

  // PIC dropdown — "Show all workers" override. False by default (strict
  // per-dept filter, operator-requested 2026-05-12). Flipping true expands
  // every PIC dropdown on the page to the full worker roster, for the
  // cross-dept temporary-assignment case (e.g. an Upholstery operator
  // helping out Fab Sew for a shift). Session-only — operators rarely need
  // it, and resetting on reload keeps the default short-list behaviour
  // sticky for the common path.
  const [picShowAll, setPicShowAll] = useState<boolean>(false);
  useEffect(() => {
    try {
      localStorage.setItem(INCOMPLETE_FILTER_LS_KEY, incompleteOnly ? "1" : "0");
    } catch {
      // ignore quota / private-mode failures
    }
  }, [incompleteOnly]);
  // Overdue drill-down panel mode. Two cards in the filter bar
  // ("Bedframe Overdue: N" + "Sofa Overdue: N") each toggle the panel
  // scoped to that itemCategory. null = panel closed. Click the active
  // card again to close, or click the other card to switch categories.
  // Date-filter-independent — counts come from
  // /api/production-orders/overdue-counts which scans the whole PO set.
  const [overduePanelMode, setOverduePanelMode] = useState<
    "BEDFRAME" | "SOFA" | null
  >(null);
  // Atomic multi-key URL writer for "Clear all". Sequential useUrlState
  // setters race under React 18 batching — see useUrlBatch jsdoc.
  const setUrlBatch = useUrlBatch();

  // First-mount seed: MOVED into the F1.1 ref-flip useLayoutEffect above
  // (search for "isColdStartRef"). Splitting them produced an intermediate
  // render where ref=false but URL state empty → a spurious unbounded
  // fetch. See the comment block at the consolidated layoutEffect for the
  // full diagnosis.

  // Datesseeded-flip useEffect removed in F1 (2026-05-11). `datesSeeded`
  // now initialises to `true` unconditionally — see the cold-start today
  // fallback (`effectiveDueFrom` / `effectiveDueTo`) just below the
  // useUrlState calls above. The seed useEffect above still writes today
  // to the URL state for shareable / refresh-safe deep links; it just no
  // longer gates the fetch.

  // Overview-matrix-only sort + filter state. Persisted to localStorage so
  // the operator's column preferences (e.g. "sort by Customer asc, hide
  // completed Packing rows") survive a page reload. The dept-tab DataGrid
  // has its own filter UI; this state only drives the Overview matrix.
  //
  // Sort: ONE column at a time (key + direction). null = unsorted.
  // Filter: per-column text/multi/range/multi-status — see OverviewFilters.
  // Cell flash: short-lived map of `${jcId}|${dept}` → "ok"|"err". On a
  // successful PATCH the cell paints bg-green-100 for 800ms; on failure
  // it paints bg-red-100. Auto-cleared by setTimeout. SO ID column flash
  // for the PO-level dueDate edit uses key `${poId}|DUE`.
  // (OverviewSortKey + OverviewSort declared at module top so the header
  // sub-components above can share the type.)
  type OverviewFilters = {
    soId: string;
    product: string;
    customers: string[]; // multi-select; empty = all
    customerPO: string;
    specialOrder: string;
    qtyMin: string; // string so empty box stays empty
    qtyMax: string;
    dueFrom: string; // YYYY-MM-DD
    dueTo: string;
    deptStatuses: Partial<Record<string, ("pending" | "overdue" | "done")[]>>;
    // Per-dept date-range filter (the displayed cell date — done cells use
    // latestCompleted; others use earliestDue). Independent of deptStatuses
    // so operators can combine both: "FAB CUT pending AND due before 12 May".
    deptDates: Partial<Record<string, { from: string; to: string }>>;
  };
  const emptyOverviewFilters: OverviewFilters = {
    soId: "", product: "", customers: [], customerPO: "", specialOrder: "",
    qtyMin: "", qtyMax: "", dueFrom: "", dueTo: "",
    deptStatuses: {},
    deptDates: {},
  };
  const OVERVIEW_TABLE_LS_KEY = "hookka-production-overview-table-state";
  type OverviewTableState = { sort: OverviewSort; filters: OverviewFilters };
  const loadOverviewTableState = (): OverviewTableState => {
    try {
      const raw = localStorage.getItem(OVERVIEW_TABLE_LS_KEY);
      if (!raw) return { sort: null, filters: emptyOverviewFilters };
      const parsed = JSON.parse(raw) as Partial<OverviewTableState>;
      return {
        sort: parsed.sort ?? null,
        filters: { ...emptyOverviewFilters, ...(parsed.filters || {}) },
      };
    } catch {
      return { sort: null, filters: emptyOverviewFilters };
    }
  };
  const initialOverviewState = loadOverviewTableState();
  const [overviewSort, setOverviewSort] = useState<OverviewSort>(initialOverviewState.sort);
  const [overviewFilters, setOverviewFilters] = useState<OverviewFilters>(initialOverviewState.filters);
  const [openFilterCol, setOpenFilterCol] = useState<string | null>(null);
  // Cell flash map — `${jcId}|${dept}` → "ok"|"err"; "${poId}|DUE" for the
  // PO-level due-date column. Tracked separately from optimistic UI so the
  // tint can fade independently of the data update.
  const [cellFlash, setCellFlash] = useState<Record<string, "ok" | "err">>({});
  const flashCell = useCallback((key: string, kind: "ok" | "err") => {
    setCellFlash((prev) => ({ ...prev, [key]: kind }));
    // eslint-disable-next-line no-restricted-syntax -- one-shot fade fired from event handler, not render
    setTimeout(() => {
      setCellFlash((prev) => {
        if (prev[key] !== kind) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }, 800);
  }, []);
  // Persist sort + filter to localStorage on change.
  useEffect(() => {
    try {
      localStorage.setItem(
        OVERVIEW_TABLE_LS_KEY,
        JSON.stringify({ sort: overviewSort, filters: overviewFilters }),
      );
    } catch {
      // ignore quota / private-mode failures
    }
  }, [overviewSort, overviewFilters]);
  // Cycle a column's sort: unset → asc → desc → unset.
  const cycleOverviewSort = useCallback((key: OverviewSortKey) => {
    setOverviewSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }, []);
  // Active-filter helpers — drives the coloured-dot indicator on each header.
  const isFilterActive = useCallback((col: string): boolean => {
    const f = overviewFilters;
    switch (col) {
      case "soId": return !!f.soId;
      case "product": return !!f.product;
      case "customer": return f.customers.length > 0;
      case "customerPO": return !!f.customerPO;
      case "specialOrder": return !!f.specialOrder;
      case "qty": return !!f.qtyMin || !!f.qtyMax;
      case "due": return !!f.dueFrom || !!f.dueTo;
      default: {
        const arr = f.deptStatuses[col];
        const hasStatus = !!(arr && arr.length > 0);
        const range = f.deptDates[col];
        const hasDate = !!(range && (range.from || range.to));
        return hasStatus || hasDate;
      }
    }
  }, [overviewFilters]);
  const anyOverviewFilterActive = useMemo(() => {
    const f = overviewFilters;
    if (f.soId || f.product || f.customerPO || f.specialOrder || f.qtyMin || f.qtyMax || f.dueFrom || f.dueTo) return true;
    if (f.customers.length > 0) return true;
    for (const k of Object.keys(f.deptStatuses)) {
      if ((f.deptStatuses[k] || []).length > 0) return true;
    }
    for (const k of Object.keys(f.deptDates)) {
      const r = f.deptDates[k];
      if (r && (r.from || r.to)) return true;
    }
    return false;
  }, [overviewFilters]);
  const clearAllOverviewFilters = useCallback(() => {
    setOverviewFilters(emptyOverviewFilters);
    setOverviewSort(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lazy-load trigger: any filter being non-default flips shouldFetch=true,
  // which arms ordersUrl in the useCachedJson call above. Once fetched the
  // data is cached in localStorage, so subsequent filter changes filter
  // client-side without re-fetching. The "Refresh" button forces a refetch.
  // Lifecycle defaults to "active", DateAxis defaults to "dueDate" — both
  // are excluded from the trigger because they're the user's baseline view.
  const anyFilterActive =
    !!fltSearch ||
    !!fltState ||
    !!fltCustomer ||
    !!fltDueFrom ||
    !!fltDueTo ||
    !!fltCategory;
  /* eslint-disable react-hooks/set-state-in-effect -- gate fetch on first filter activation */
  useEffect(() => {
    if (anyFilterActive && !shouldFetch) setShouldFetch(true);
  }, [anyFilterActive, shouldFetch]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Scroll position restoration — keyed per active dept tab so each dept
  // remembers its own scroll independently. sessionStorage so the value
  // dies when the tab closes.
  const [savedScroll, setSavedScroll] = useSessionState<number>(
    `production:scrollY:${activeTab}`,
    0,
  );
  useEffect(() => {
    if (savedScroll > 0 && window.scrollY === 0) {
      window.scrollTo(0, savedScroll);
    }
    const onScroll = () => {
      setSavedScroll(window.scrollY);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
    // savedScroll is read on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Mirror of the Production Sheet DataGrid's internal filter + sort result.
  // When a dept tab is active, Print Schedule and the on-screen QR Stickers
  // row drive off this instead of the raw `deptRows`, so whatever the user
  // sees filtered in the grid is exactly what prints / renders as QRs.
  // `null` = DataGrid hasn't reported filtered rows yet (first render /
  // tab-switch). We must DISTINGUISH this from `[]` (legitimate empty filter
  // match) because the QR tile row uses `gridFilterIdSet` to scope stickers
  // to visible grid rows — an empty Set would hide every sticker, so we
  // only treat it as a real filter once the grid has actually reported.
  const [gridFilteredDeptRows, setGridFilteredDeptRows] = useState<
    Array<{ id: string; poId: string; jobCardId: string }> | null
  >(null);
  // Reset the mirror when the active tab changes — the new dept's grid will
  // report its own rows once it mounts. Without this, stale rows from the
  // previous dept would briefly filter the QR tile row to an empty set.
  /* eslint-disable react-hooks/set-state-in-effect -- reset mirror on tab change */
  useEffect(() => { setGridFilteredDeptRows(null); }, [activeTab]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Batch-action selection state — populated when the operator ticks the
  // checkbox column on the dept grid. The toolbar (rendered just under
  // the grid) reads from `selectedDeptRows` and dispatches into the bulk-
  // patch endpoint or the production-folders endpoint. Per Wei Siang's
  // 2026-05-12 ask: multi-select rows → batch Apply Date / Apply PIC /
  // Save into a Folder so paper-schedule sheets are easy to find again.
  type DeptRowLite = { id: string; poId: string; jobCardId: string };
  const [selectedDeptRows, setSelectedDeptRows] = useState<DeptRowLite[]>([]);
  const [batchDateOpen, setBatchDateOpen] = useState(false);
  const [batchDueDateOpen, setBatchDueDateOpen] = useState(false);
  const [batchPicOpen, setBatchPicOpen] = useState(false);
  const [batchFolderOpen, setBatchFolderOpen] = useState(false);
  type FolderOption = { id: string; name: string; jc_count: number };
  const [folderList, setFolderList] = useState<FolderOption[]>([]);
  // Wei Siang 2026-05-13: bumping this counter forces the DataGrid to
  // remount with a fresh `key`, which causes it to re-read its
  // sessionStorage-backed filter state. Combined with wiping the
  // datagrid-filters-* keys in Clear All, this gives a true "wipe every
  // filter on the page including the per-column ones inside the listing"
  // experience that the operator asked for: "彻彻底底、干干净净地把
  // Filter 都清掉".
  const [gridResetNonce, setGridResetNonce] = useState(0);
  // Wei Siang 2026-05-14: Clear All v2 — the first version wiped
  // sessionStorage but the DataGrid's defaultExcludedValues useEffect
  // re-applied the "hide COMPLETED/TRANSFERRED" Status filter on
  // remount, so the user still saw the same filtered rowcount. While
  // this flag is true, defaultExcludedValues passes through as
  // undefined so the grid mounts with truly empty filter state.
  // Resets on dept-tab change so navigating to a different dept
  // restores the first-visit hide-COMPLETED default behaviour.
  const [clearAllActive, setClearAllActive] = useState(false);
  // Reset selection + close batch dialogs when the dept tab changes.
  /* eslint-disable react-hooks/set-state-in-effect -- reset on tab change */
  useEffect(() => {
    setSelectedDeptRows([]);
    setBatchDateOpen(false);
    setBatchDueDateOpen(false);
    setBatchPicOpen(false);
    setBatchFolderOpen(false);
    // Tab change resets Clear All — re-entering a dept gets the
    // default-hide behaviour back.
    setClearAllActive(false);
  }, [activeTab]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Batch sticker printing — populated when the user clicks "Print Job Card
  // Stickers" or "Print FG Stickers" in the header. Each entry renders into
  // the hidden print container, then window.print() fires. After printing,
  // state is cleared so the container is gone for the next action.
  type JobCardSticker = {
    key: string;
    poNo: string;
    deptCode: string;
    jobCardId: string;
    wipName: string;
    // Short WIP code from the BOM (e.g. "WD-5FT-DV"). Printed under the
    // full WIP name so shop-floor workers can cross-check the piece
    // against the cutting list without reading the long label.
    wipCode?: string;
    sizeLabel: string;
    qty: number;
    // Extra fields mirrored from the Production Sheet row so the on-screen
    // sticker carries the same context the user is looking at — Customer PO,
    // state, model, component type, fabric colour and bedframe heights (when
    // applicable). Keeps the sticker visually 1:1 with the row above it.
    customerPOId?: string;
    customerState?: string;
    // Customer name + our company SO id — needed by the FAB_CUT 100×150mm
    // sticker (Wei Siang 2026-05-14 spec). Other dept stickers stay on
    // the 50×75mm layout and don't render these, so they're optional.
    customerName?: string;
    customerRef?: string;
    salesOrderNo?: string;
    model?: string;
    wipType?: string;
    category?: string;
    colour?: string;
    gap?: string;
    divan?: string;
    leg?: string;
    totalHeight?: string;
    specialOrder?: string;
    pieceNo: number;
    totalPieces: number;
    // Raw data the QR should encode (a URL to /production/scan). Preview
    // tiles render this through <QRImg> which generates the PNG in-browser
    // — no api.qrserver.com round-trips, so scrolling the preview grid
    // doesn't stall the page.
    qrPayload: string;
    // Pre-rendered base64 PNG populated only when Print is clicked. Kept
    // separate from qrPayload so the preview path doesn't await a batch
    // QR generation just to show the thumbnails.
    qrDataUrl?: string;
  };
  // Each FgSticker now = one FG unit (one physical box), NOT one PO.
  // A PO with qty=3 and 3 pieces/set produces 9 FgSticker rows.
  type FgSticker = {
    key: string;                // fgUnit.id (or synthetic id for leg-pack)
    unitSerial: string;         // full canonical serial for QR
    shortCode: string;          // human-readable batch+piece
    poNo: string;
    poId: string;
    productName: string;
    productCode: string;
    sku: string;                // product.skuCode (fallback to productCode) — kept for compatibility, header now uses productCode directly per Wei Siang spec 2026-05-09
    sizeLabel: string;          // product.sizeCode (e.g. "5 FTS") or order.sizeLabel
    // SOFA-only seat depth in inches (e.g. "28"). Surfaced on the
    // sticker as a separate "Seat" row in ADDITION to sizeLabel (the
    // variant code "1A(LHF)" stays). Empty for non-sofa categories.
    seatSize?: string;
    fabricCode: string;
    fabricColor: string;
    customerName: string;
    customerHub: string;
    salesOrderNo: string;
    salesOrderId: string;       // for SO-level sofa pack aggregation
    // WIP-style label shown on the sticker body. For SOFA this is the SO-
    // wide joined compartment string (e.g. "5530-1A(LHF)+1NA+1A(RHF)") so
    // packers see the full sofa configuration on every compartment box.
    // For BEDFRAME this is the per-PO size+fabric WIP label.
    wipLabel?: string;
    // Sofa-only: the SO-wide leg height summary (string for display).
    legsInfo?: string;
    // Sofa: per-line "Special order" note from the SO (free-text).
    specialOrder?: string;
    // Customer-facing references shown on the body, between Company SO
    // and Special. customerPOId = customer's own PO number; customerRef =
    // customer's free-text reference (e.g. ship-to dept code).
    customerPOId?: string;
    customerRef?: string;
    // Customer SO — customer's own SO number (sales_orders.customerSO).
    // Distinct from companySOId; shown on bedframe stickers per Wei
    // Siang spec (2026-05-09). Sofa stickers don't need this field.
    customerSO?: string;
    // Bedframe: divan height in inches (used both as a body field and to
    // build the Divan box's "Code" line "{N}\" Divan {sizeLabel}").
    divanHeightInches?: number | null;
    // Bedframe: gap height in inches (used in totalH = gap + divan + leg
    // for the HB box's WIP label "{productCode}-HB{totalH}\"").
    gapInches?: number | null;
    // The "Code" line on the sticker body — describes what's physically in
    // THIS box (vs the top header which shows the product/WIP). Set by
    // the aggregator per piece-type:
    //   BF HB:    "{productCode} {sizeCode} HB"     (e.g. "1013 Q HB")
    //   BF Divan: "{divanH}\" Divan {sizeLabel}"    (e.g. "8\" Divan 6FT")
    //   Sofa:     {fullCompartment}                 (SO-wide concat)
    //   Pillow:   {productName}                     (e.g. "Square Pillow")
    boxLabel?: string;
    // Synthetic Pillow sticker — same pairing pattern as legs but pinned
    // to the LAST compartment as a 2-in-1.
    isSyntheticPillow?: boolean;
    pieceNo: number;
    totalPieces: number;
    pieceName: string;
    unitNo: number;
    totalUnits: number;
    mfdDate: string | null;
    // Category + leg height — needed by the SO-level sofa aggregator that
    // renumbers pieceNo across all sofa POs in the same SO and inserts a
    // synthetic Legs sticker when any sofa line in the SO has
    // legHeightInches > 0.5". Not persisted; populated from the source PO
    // when stickers are loaded.
    itemCategory?: "BEDFRAME" | "SOFA" | "ACCESSORY";
    legHeightInches?: number | null;
    // Combined-sticker pairing. When set, this sticker shares a physical
    // card with `comboPairKey`. The aggregator pairs Compartment 1 with
    // the Legs sticker so they print on a single 2-in-1 label.
    comboPairKey?: string;
    // True when this sticker is a synthetic leg-pack injected by the
    // aggregator (no fg_units row backing it). Used by the renderer to
    // skip standalone rendering — the combined card carries both.
    isSyntheticLegs?: boolean;
  };
  const [jobCardStickers, setJobCardStickers] = useState<JobCardSticker[]>([]);
  const [fgStickers, setFgStickers] = useState<FgSticker[]>([]);
  // Loading flag shown on the header button while a batch of QRs pre-renders.
  const [printingJobCards, setPrintingJobCards] = useState(false);
  // QR preview sections (Job Card strip + FG Sticker preview) are collapsed
  // by default because mounting 100-1000 <QRImg> tiles on every tab change
  // was making the Production page feel laggy — even with lazy-generation
  // via IntersectionObserver, the React commit for that many components
  // is a noticeable hitch. Users who want to print or scan open the
  // section explicitly.
  const [showQRStrip, setShowQRStrip] = useState(false);
  const [showFgPreview, setShowFgPreview] = useState(false);
  // Collapse both on tab change so the new tab starts fast; user re-opens
  // per tab if they actually need the QR grid.
  /* eslint-disable react-hooks/set-state-in-effect -- collapse panels on tab change */
  useEffect(() => {
    setShowQRStrip(false);
    setShowFgPreview(false);
  }, [activeTab]);
  /* eslint-enable react-hooks/set-state-in-effect */
  // When true, the fgStickers useEffect will fire window.print() on next
  // populate. Auto-population on UPH/PACK tab entry leaves this false so
  // the preview tiles render without triggering a print dialog.
  const [fgPrintRequested, setFgPrintRequested] = useState(false);
  // Loading flag while the FG preview is being populated (tab entry).
  const [loadingFgPreview, setLoadingFgPreview] = useState(false);

  // Stock PO creation dialog — lets the factory spin up a PO against a
  // placeholder SOH-YYMM-NNN when there's spare capacity. Item pool comes
  // from what's been produced historically (by JobCard wipLabel for WIP,
  // by product+size+fabric for FG), so the picker only shows SKUs the
  // factory has actually built before — no need to prefill a catalog.
  const [stockDialogOpen, setStockDialogOpen] = useState(false);
  // Print Schedule mode toggle. "detailed" → handlePrintSchedule (one row
  // per PO/JC). "total" → handlePrintTotalListing (rows merged on
  // model+spec so the floor sees "make N of X").
  const [printMode, setPrintMode] = useState<"detailed" | "total">("detailed");

  const fetchOrders = useCallback(() => {
    invalidateCachePrefix("/api/production-orders");
    refreshOrders();
  }, [refreshOrders]);

  // Pending JC PATCHes (optimistic). Any JC ID in this set has an in-flight
  // server write that hasn't confirmed yet — the cache merger below skips
  // those JCs when overlaying refetch results so a tab-switch refetch can't
  // wipe a Completion Date / PIC the user JUST clicked. ref (not state) so
  // the merger reads the latest value without re-rendering on every PATCH.
  const pendingJcPatchesRef = useRef<Set<string>>(new Set());

  // Last successful refetch timestamp — gates the visibilitychange auto
  // refresh so quick tab-flips (Sheets / WhatsApp / Alt-Tab to look up an
  // order number) don't keep stomping mid-edit state. 30s is short enough
  // that returning to the tab after a real break still picks up server
  // changes, long enough that incidental focus loss is a no-op.
  // Init at 0 (not Date.now()) to keep the useRef call pure — react-hooks/
  // purity flags Date.now() during render. The first refetch via the cache
  // merger below stamps the real timestamp.
  const lastFetchAtRef = useRef<number>(0);

  // Auto-refresh on tab visibility return. Use visibilitychange ONLY
  // (not window.focus) — focus fires when ANY in-page popup closes
  // (native date picker, autocomplete, browser context menu) which
  // triggered a full refetch + re-render every time the user clicked a
  // date input, making the picker feel unresponsive (it would close
  // itself before the user could pick a date because the React tree
  // reconciled). visibilitychange only fires on tab switch / window
  // minimize / programmatic hide, so date pickers stay interactive.
  //
  // Throttle: only fire if it's been >5min since the last fetch AND no
  // optimistic PATCH is in-flight. The latter prevents the classic race
  // where the user edits a PIC, glances at another tab, comes back, and
  // the visibility refetch lands BEFORE the PATCH commits — wiping the
  // edit they just made.
  // 2026-05-08: bumped from 30s to 5min. /api/production-orders runs
  // 5-17s on prod; the old 30s throttle let normal alt-tab patterns
  // re-fire the fetch while a previous one was still in flight, which
  // stacked queries on Hyperdrive and froze the renderer for 15-20s
  // when the response payloads finally arrived together.
  // Phase 2.5-D-lite — passive auto-refresh polling.
  //
  // Real Supabase Realtime would push job_cards mutations directly to the
  // browser via WebSocket (~1s latency), but it needs: a new dependency
  // (@supabase/supabase-js), RLS policies on the table (Hookka uses
  // service_role via Hyperdrive — no RLS today), and anon key wiring per
  // env. Too invasive for this iteration.
  //
  // Instead we lean on Phase 2.5-C: a quiet 20s setInterval re-fetches the
  // matrix while the tab is visible. With KV cache in front, the typical
  // request is a HIT (~20-50ms, no DB work). When ANY operator (including
  // this one) mutates, the bump invalidates the cache → next poll within
  // 20s sees fresh data. Net result: cross-operator changes are visible
  // within ~20-30s, without infra changes.
  //
  // Skips:
  //   * pending optimistic patches (don't stomp in-flight writes)
  //   * staged drafts (don't refetch over a buffer the operator is still
  //     editing — would clobber unsaved cells)
  //   * tab not visible (no point computing for an unviewed tab)
  useEffect(() => {
    const POLL_INTERVAL_MS = 20_000;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      if (pendingJcPatchesRef.current.size > 0) return;
      if (draftsRef.current.size > 0) return;
      lastFetchAtRef.current = Date.now();
      fetchOrders();
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchOrders]);

  // Warn the operator if they try to leave the page with unsaved drafts in
  // the buffer (closing tab, navigating away, hitting back). Modern browsers
  // ignore the custom message and show their own generic prompt, but they
  // DO show the prompt — which is the protection we want. `draftsRef`
  // is read at the moment of the event, not at hook-bind time, so it always
  // reflects the latest count.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (draftsRef.current.size === 0) return;
      // Try to flush synchronously via sendBeacon-style fire-and-forget; if
      // it lands, great — operator avoids the prompt. But we still show the
      // prompt because we can't await the flush in this event handler.
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (pendingJcPatchesRef.current.size > 0) return;
      if (Date.now() - lastFetchAtRef.current < 300_000) return;
      lastFetchAtRef.current = Date.now();
      fetchOrders();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchOrders]);

  // Sync cached orders response into local state so optimistic PATCHes keep
  // working. When refetch lands while an optimistic PATCH is still in-flight
  // (pendingJcPatchesRef), preserve the prior local JC for those IDs so the
  // server's stale snapshot doesn't blank out the value the user just typed.
  // useEffect (not set-state-during-render) because we also need to mutate
  // lastFetchAtRef and read pendingJcPatchesRef.current — both forbidden
  // during render under react-hooks/purity + react-hooks/refs.
  useEffect(() => {
    if (!ordersResp) return;
    lastFetchAtRef.current = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = ordersResp;
    const fresh: ProductionOrder[] = d?.success
      ? d.data
      : Array.isArray(d)
        ? d
        : [];
    const pending = pendingJcPatchesRef.current;
    // BUG-2026-05-12: previously this only checked `pending` (in-flight
    // PATCHes). Drafts staged in the debounce buffer but not yet flushed are
    // NOT in pending, so a fetch that resolved AFTER the operator clicked a
    // cell would visually overwrite the just-typed value (the data still
    // survives in draftsRef and lands on the next flush, but the operator
    // sees the cell flicker back). Also splice draftsRef so staged-but-unsent
    // edits stay visible on the matrix until they hit the server.
    const draftedIds = new Set(Array.from(draftsRef.current.keys()));
    if (pending.size === 0 && draftedIds.size === 0) {
      // Refilling `orders` after a dept switch re-runs the heavy baseRows
      // rebuild. Run it as an interruptible transition so the operator's
      // clicks stay responsive while React reshapes the grid. Behaviour is
      // unchanged — same `fresh` data lands, just rendered without blocking.
      startDeptSwitch(() => {
        setOrders(fresh);
      });
      return;
    }
    // Splice the optimistic JC version back over the server snapshot so the
    // PATCH-in-flight value the user can see survives the refetch.
    // Also wrapped in the dept-switch transition for the same reason — the
    // optimistic splice still happens, just as interruptible render work.
    startDeptSwitch(() => {
      setOrders((prev) => {
        const prevJcMap = new Map<string, JobCard>();
        for (const po of prev) {
          for (const jc of po.jobCards) {
            if (pending.has(jc.id) || draftedIds.has(jc.id)) prevJcMap.set(jc.id, jc);
          }
        }
        if (prevJcMap.size === 0) return fresh;
        return fresh.map((po) => ({
          ...po,
          jobCards: po.jobCards.map((jc) =>
            prevJcMap.has(jc.id) ? (prevJcMap.get(jc.id) as JobCard) : jc,
          ),
        }));
      });
    });
  }, [ordersResp]);

  // Fetch the 20 warehouse racks once so the Packing Rack dropdown is populated.
  const [lastSeenWarehouseResp, setLastSeenWarehouseResp] = useState<typeof warehouseResp>(null);
  if (warehouseResp !== lastSeenWarehouseResp) {
    setLastSeenWarehouseResp(warehouseResp);
    if (warehouseResp?.success) {
      const locs = (warehouseResp.data || []) as Array<{
        rack: string; status: string;
        productCode?: string; customerName?: string;
      }>;
      setRackOptions(
        locs.map((l) => ({
          label: l.rack,
          occupied: l.status === "OCCUPIED",
          occupant: l.productCode || l.customerName || "",
        })),
      );
    }
  }

  // Workers list — powers PIC 1 / PIC 2 dropdowns. The API exposes a
  // `departmentCode` on every worker record; we fetch all workers once
  // here and filter client-side per active tab below.
  const [lastSeenWorkersResp, setLastSeenWorkersResp] = useState<typeof workersResp>(null);
  if (workersResp !== lastSeenWorkersResp) {
    setLastSeenWorkersResp(workersResp);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = workersResp;
    if (d) {
      const list: Worker[] =
        (d.success ? d.data : Array.isArray(d) ? d : []) as Worker[];
      if (Array.isArray(list)) setWorkers(list);
    }
  }

  // Optimistic PATCH helper for inline job-card edits (due date, completion,
  // PIC1, PIC2). Updates local state immediately so the grid reflows, then
  // fires the server request and only clears the in-flight marker once the
  // server confirms. The marker (pendingJcPatchesRef) protects against the
  // tab-switch race where a visibilitychange refetch lands before the PATCH
  // commits and overwrites the optimistic value with a stale server snapshot
  // — the cache merger above splices the optimistic JC back when its id is
  // in the pending set. PATCH failures surface as a toast so the operator
  // knows to retry instead of silently losing the edit (was console.error
  // only; you'd never see it).
  // 2026-05-12 simplification: per-cell save failures were tracked in a
  // setPatchFailures state and surfaced via <PatchFailureModal>. Both removed
  // — failures now surface as toast.error in flushDrafts (cell auto-reverts
  // to pre-edit value via the setOrders splice above). Trade-off: lost the
  // persistent "Retry" button; operator re-clicks the cell.

  // -----------------------------------------------------------------------
  // Phase 2.5 — Debounced write batching.
  // -----------------------------------------------------------------------
  // Cell clicks no longer fire a PATCH per click. Instead each click is
  // staged into `draftsRef` and a 2s debounce timer accumulates additional
  // edits. When the timer fires (or the operator clicks "Save All"), every
  // staged draft is sent in parallel. This collapses a typical "click 8
  // cells in 5 seconds" pattern from 8 HTTPs into ~1 burst, which Hyperdrive
  // + the Worker route serialise far faster than 8 separate roundtrips.
  //
  // Why drafts live in a ref (not state): the render path doesn't depend on
  // their contents — only `unsavedCount` does, and that's a separate state
  // we update explicitly. Keeping drafts off the render path means the page
  // doesn't re-paint on every keystroke during a rapid-click burst.
  //
  // Silent callers (bulk fan-out, scan-modal — feedback.silent=true) keep
  // their old synchronous semantics: they bypass the queue and send + await
  // + throw on failure as before, because they rely on awaiting the result.

  type DraftEntry = {
    poId: string;
    jcId: string;
    patch: Record<string, unknown>;
    // Pre-edit values for every field in `patch`. Captured at first stage;
    // preserved across merges with later staging on the same JC, so rollback
    // restores the ORIGINAL value (not an intermediate one).
    prevState: Record<string, unknown>;
    deptCode: string;
    deptName: string;
    feedback?: { flashKey?: string; successMsg?: string };
    stagedAt: number;
  };
  const draftsRef = useRef<Map<string, DraftEntry>>(new Map());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [unsavedCount, setUnsavedCount] = useState(0);
  const [savingNow, setSavingNow] = useState(false);
  const DEBOUNCE_MS = 2000;

  // sendOneDraft — the actual HTTP write with retry. Extracted from the
  // pre-batching patchJobCard so flushDrafts and retryFailure can share it.
  // Returns success / error data; never throws (caller decides UI handling).
  const sendOneDraft = useCallback(
    async (
      d: Pick<DraftEntry, "poId" | "jcId" | "patch">,
    ): Promise<{ success: boolean; error?: string; attemptsUsed: number }> => {
      const MAX_ATTEMPTS = 3;
      const RETRY_DELAYS_MS = [500, 1500];
      let lastError = "";
      let attemptsUsed = 0;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        attemptsUsed = attempt;
        let retryable = true;
        try {
          const res = await fetch(`/api/production-orders/${d.poId}`, {
            method: "PATCH",
            headers: csrfHeaders(),
            body: JSON.stringify({ jobCardId: d.jcId, ...d.patch }),
          });
          if (res.ok) return { success: true, attemptsUsed };
          let msg = `HTTP ${res.status}`;
          try {
            const body = (await res.json()) as { error?: string } | null;
            if (body && typeof body.error === "string") msg = body.error;
          } catch {
            /* non-json body */
          }
          lastError = msg;
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
            retryable = false;
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : "network error";
        }
        if (!retryable) break;
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
        }
      }
      return { success: false, error: lastError, attemptsUsed };
    },
    [],
  );

  // flushDrafts — Phase 2.5-B: try the bulk endpoint first (1 HTTP for all
  // drafts in the buffer); fall back to per-draft sendOneDraft on bulk
  // failure (network error, 4xx, server doesn't yet know /bulk-patch).
  // Either way, per-draft outcomes feed the same success/rollback path.
  // Clears the debounce timer up front; idempotent on empty drafts.
  const flushDrafts = useCallback(async () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const drafts = Array.from(draftsRef.current.values());
    if (drafts.length === 0) return;
    draftsRef.current.clear();
    setUnsavedCount(0);
    setSavingNow(true);

    for (const d of drafts) pendingJcPatchesRef.current.add(d.jcId);

    // Try bulk endpoint first (1 HTTP for the whole buffer). On any failure
    // (network, 5xx, endpoint not deployed yet on this preview, 4xx
    // malformed), fall back to per-draft sendOneDraft so the operator still
    // gets save semantics. The fallback path also keeps the per-draft retry
    // (3 attempts) that Phase 2.5-A introduced.
    type DraftResult = {
      draft: (typeof drafts)[number];
      result: { success: boolean; error?: string; attemptsUsed: number };
    };
    let results: DraftResult[] = [];
    let bulkOK = false;
    try {
      const res = await fetch("/api/production-orders/bulk-patch", {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify({
          patches: drafts.map((d) => ({ poId: d.poId, jobCardId: d.jcId, ...d.patch })),
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          results?: Array<{ poId: string; jobCardId: string; success: boolean; error?: string }>;
        };
        const perJc = new Map<string, { success: boolean; error?: string }>();
        for (const r of body.results ?? []) perJc.set(r.jobCardId, r);
        results = drafts.map((d) => {
          const r = perJc.get(d.jcId);
          return {
            draft: d,
            result: r
              ? { success: r.success, error: r.error, attemptsUsed: 1 }
              : { success: false, error: "no result in bulk response", attemptsUsed: 1 },
          };
        });
        bulkOK = true;
      }
    } catch {
      /* fall through to per-draft path */
    }

    if (!bulkOK) {
      results = await Promise.all(
        drafts.map(async (d) => {
          const r = await sendOneDraft(d);
          return { draft: d, result: r };
        }),
      );
    }
    for (const d of drafts) pendingJcPatchesRef.current.delete(d.jcId);

    // Apply per-draft outcomes. Successful drafts: optimistic state already
    // reflects the desired value, just flash green. Failed drafts: roll the
    // affected JC's fields back to prevState AND push to the failure modal.
    setOrders((prev) => {
      let next = prev;
      for (const { draft, result } of results) {
        if (result.success) continue;
        next = next.map((o) =>
          o.id !== draft.poId
            ? o
            : {
                ...o,
                jobCards: o.jobCards.map((j) =>
                  j.id !== draft.jcId ? j : { ...j, ...draft.prevState },
                ),
              },
        );
      }
      return next;
    });

    // Per-draft outcome: success → flash green + optional success toast;
    // failure → flash red + toast.error with the JC dept and error message.
    // Optimistic state was already rolled back in the setOrders splice above,
    // so the operator sees the cell revert + the toast at the same time.
    // BUG-2026-05-12 simplification: PatchFailureModal replaced with toast —
    // less state, less code, same operator signal (cell reverts visibly +
    // toast appears). Trade-off: lost the persistent "Retry" button; operator
    // has to re-click the cell to retry. Acceptable for a small-shop workflow.
    for (const { draft, result } of results) {
      if (result.success) {
        if (draft.feedback?.flashKey) flashCell(draft.feedback.flashKey, "ok");
        if (draft.feedback?.successMsg) toast.success(draft.feedback.successMsg);
      } else {
        if (draft.feedback?.flashKey) flashCell(draft.feedback.flashKey, "err");
        const label = draft.deptCode ? `${draft.deptCode} JC` : "Job card";
        toast.error(`${label} save failed: ${result.error ?? "unknown"}. Cell reverted — click again to retry.`);
        console.error("[flushDrafts] draft failed after retries", {
          jcId: draft.jcId,
          patch: draft.patch,
          error: result.error,
        });
      }
    }
    setSavingNow(false);
  }, [sendOneDraft, flashCell, toast]);

  // saveAllNow — manual "Save All" button. Cancels the debounce and flushes
  // immediately. Also used by the failure modal's retry helpers to push
  // through without waiting.
  const saveAllNow = useCallback(() => {
    void flushDrafts();
  }, [flushDrafts]);

  // patchJobCard — primary API for every cell-edit handler on the page.
  // Non-silent callers (the default) → stage into drafts + reset debounce.
  // Silent callers (bulk fan-out) → send synchronously, throw on failure to
  // preserve the pre-batch contract.
  const patchJobCard = useCallback(
    async (
      poId: string,
      jobCardId: string,
      patch: Partial<Pick<JobCard, "dueDate" | "completedDate" | "status" | "pic1Id" | "pic1Name" | "pic2Id" | "pic2Name">> & { distributedAt?: string | null },
      feedback?: { flashKey?: string; silent?: boolean; successMsg?: string },
    ) => {
      // 1. Snapshot + optimistic update (same as Phase 1, atomic inside setOrders).
      const prevState: Record<string, unknown> = {};
      let deptCode = "";
      let deptName = "";
      setOrders((prev) => {
        const order = prev.find((o) => o.id === poId);
        const jc = order?.jobCards.find((j) => j.id === jobCardId);
        if (jc) {
          for (const key of Object.keys(patch)) {
            prevState[key] = (jc as unknown as Record<string, unknown>)[key];
          }
          deptCode = jc.departmentCode || "";
          deptName = jc.departmentName || "";
        }
        return prev.map((o) =>
          o.id !== poId
            ? o
            : {
                ...o,
                jobCards: o.jobCards.map((j) =>
                  j.id !== jobCardId ? j : { ...j, ...patch },
                ),
              },
        );
      });
      pendingJcPatchesRef.current.add(jobCardId);

      // 2a. Silent caller (bulk fan-out etc.) → bypass the queue and use the
      //     pre-batching synchronous contract: await result, rollback +
      //     throw on failure.
      if (feedback?.silent) {
        const result = await sendOneDraft({ poId, jcId: jobCardId, patch });
        pendingJcPatchesRef.current.delete(jobCardId);
        if (result.success) return;
        // Rollback this specific JC.
        setOrders((prev) =>
          prev.map((o) =>
            o.id !== poId
              ? o
              : {
                  ...o,
                  jobCards: o.jobCards.map((j) =>
                    j.id !== jobCardId ? j : { ...j, ...prevState },
                  ),
                },
          ),
        );
        throw new Error(result.error ?? "unknown");
      }

      // 2b. Default path: stage the draft. Merge with any in-flight draft on
      //     the SAME JC so successive edits roll up into one PATCH and the
      //     ORIGINAL prevState (before the first edit) is preserved for
      //     rollback. Reset the debounce timer.
      const existing = draftsRef.current.get(jobCardId);
      const merged: DraftEntry = {
        poId,
        jcId: jobCardId,
        patch: { ...(existing?.patch ?? {}), ...(patch as Record<string, unknown>) },
        prevState: existing?.prevState ?? prevState,
        deptCode: existing?.deptCode || deptCode,
        deptName: existing?.deptName || deptName,
        feedback: feedback
          ? { flashKey: feedback.flashKey, successMsg: feedback.successMsg }
          : undefined,
        stagedAt: existing?.stagedAt ?? Date.now(),
      };
      draftsRef.current.set(jobCardId, merged);
      setUnsavedCount(draftsRef.current.size);

      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        void flushDrafts();
      }, DEBOUNCE_MS);
    },
    [sendOneDraft, flushDrafts],
  );

  // 2026-05-12 simplification: retryFailure / discardFailure /
  // retryAllFailures / discardAllFailures all removed — operator now
  // retries by re-clicking the cell. See the failure branch in flushDrafts
  // for the new toast-based UX.

  // Optimistic PATCH for the Packing Rack dropdown. Writes rackingNumber to
  // the specific JobCard (so two WIPs under the same PO can land on different
  // racks) and mirrors it to the PO-level field for legacy readers. Captures
  // the previous rack value per (po,jc) so we can roll back if the API rejects.
  const patchRack = useCallback(
    async (poId: string, jobCardId: string, rack: string) => {
      let prevPoRack = "";
      let prevJcRack = "";
      setOrders((prev) =>
        prev.map((o) => {
          if (o.id !== poId) return o;
          prevPoRack = o.rackingNumber || "";
          return {
            ...o,
            rackingNumber: rack,
            jobCards: o.jobCards.map((j) => {
              if (j.id !== jobCardId) return j;
              prevJcRack = j.rackingNumber || "";
              return { ...j, rackingNumber: rack };
            }),
          };
        }),
      );
      try {
        const res = await fetch(`/api/production-orders/${poId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobCardId, rackingNumber: rack }),
        });
        if (!res.ok) {
          const body = (await res
            .json()
            .catch(() => ({}))) as { error?: string };
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
      } catch (err) {
        // Roll back optimistic update.
        setOrders((prev) =>
          prev.map((o) =>
            o.id !== poId
              ? o
              : {
                  ...o,
                  rackingNumber: prevPoRack,
                  jobCards: o.jobCards.map((j) =>
                    j.id === jobCardId ? { ...j, rackingNumber: prevJcRack } : j,
                  ),
                },
          ),
        );
        const detail = err instanceof Error ? err.message : "try again";
        toast.error(`Failed to set rack: ${detail}`);
        console.error("[patchRack] network error", err);
      }
    },
    [toast],
  );

  // Dept fractions for tab bar: done/total rows across all orders per dept.
  // Counts must match what the Production Sheet shows when that tab is open.
  // FAB_CUT used to be special-cased (one merged row per PO) — removed as
  // part of the FAB_CUT normalisation (Wei Siang Apr 26 2026), now uses the
  // same per-JC `cellFor` count as every other dept.
  const deptFractions = useMemo(() => {
    return DEPARTMENTS.map((d) => {
      let done = 0;
      let total = 0;
      for (const o of orders) {
        const c = cellFor(o, d.code, orders);
        if (c.state === "empty") continue;
        total += c.totalCards;
        done += c.doneCards;
      }
      return { ...d, done, total };
    });
  }, [orders]);

  const overallTotal = deptFractions.reduce((s, d) => s + d.total, 0);
  const overallDone  = deptFractions.reduce((s, d) => s + d.done, 0);

  // Sprint 5 F2: pre-compute the lowercased haystack string for every PO
  // once when `orders` lands, then look it up by id during filter. The
  // previous implementation rebuilt 9 toLowerCase()+join() per row per
  // keystroke — at 1k POs and a 5-char query that's 45k string ops on the
  // hot path. Now: 9k once at load, O(1) lookup per filter pass.
  const haystackByPo = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of orders) {
      m.set(o.id, [
        o.poNo, o.companySOId, o.customerPOId, o.customerReference,
        o.customerName, o.productCode, o.productName, o.fabricCode,
        o.sizeLabel,
      ].map((v) => (v || "").toLowerCase()).join(" "));
    }
    return m;
  }, [orders]);

  // (itemTypesByPo memo removed 2026-05-08 — was only consumed by the
  // now-deleted Item type filter dropdown.)

  // F5 (2026-05-11) — defer heavy useMemo deps so filter clicks feel
  // instant.
  //
  // Problem: every keystroke / Clear / date pick fires a state update that
  // cascades through filteredOrders + visibleOrders + baseRows useMemos,
  // each O(N×depts) over the full PO set (~1.8k POs × 8 depts on Fab Sew).
  // The cascade runs synchronously in the render commit — main thread
  // blocks 0.5-2s and click events queue behind it ("点 Clear 没反应、点
  // 日期没反应" — Wei Siang 2026-05-11).
  //
  // Fix: pass the deferred copy of each filter value into the heavy
  // useMemo deps. The deferred value lags by one render cycle, so the
  // urgent render (input field updates, button highlights, URL state
  // writes) commits and paints first — user sees instant click feedback.
  // The heavy filter pass + sched matrix rebuild happens in the next
  // commit (a low-priority render React schedules off the main thread's
  // critical path).
  //
  // Input bindings still use the IMMEDIATE values (fltDueFrom etc.) so
  // typing into a date field shows the new value in the input the moment
  // the keystroke lands. Only the expensive downstream reads use the
  // deferred values.
  const deferredFltSearch = useDeferredValue(fltSearch);
  const deferredFltState = useDeferredValue(fltState);
  const deferredFltCustomer = useDeferredValue(fltCustomer);
  const deferredFltDueFrom = useDeferredValue(fltDueFrom);
  const deferredFltDueTo = useDeferredValue(fltDueTo);
  const deferredFltCategory = useDeferredValue(fltCategory);
  const deferredIncompleteOnly = useDeferredValue(incompleteOnly);
  const deferredOverviewFilters = useDeferredValue(overviewFilters);
  const deferredOverviewSort = useDeferredValue(overviewSort);

  // Apply the page-level filter panel to `orders` first, then scope further
  // by active tab (Overview = everything; dept tab = only orders that have
  // a non-empty cell in that dept).
  const filteredOrders = useMemo(() => {
    const q = deferredFltSearch.trim().toLowerCase();
    return orders.filter((o) => {
      if (q) {
        const hay = haystackByPo.get(o.id) || "";
        if (!hay.includes(q)) return false;
      }
      if (deferredFltState && o.customerState !== deferredFltState) return false;
      if (deferredFltCustomer && o.customerName !== deferredFltCustomer) return false;
      // Category — itemCategory column on the PO.
      if (deferredFltCategory && o.itemCategory !== deferredFltCategory) return false;
      // (Item type + Model filters removed 2026-05-08 — data shows all
      //  item types + models by default; operators narrow via search /
      //  category / state / date instead.)
      // Date range filter — axis depends on which page the operator is on:
      //   overview ("ALL") → PO.targetEndDate  (whole-order packing anchor)
      //   dept page        → that dept's JC.dueDate (the dept's own deadline)
      // The dept-level switch matches user mental model: on /production/fab-cut
      // they expect a "due ≤ 7/5" filter to mean "FAB_CUT due ≤ 7/5", not
      // "the whole PO's PACKING date ≤ 7/5" (which would silently let
      // FAB_CUT-overdue rows through if PACKING is also past 7/5 by even more).
      let axisVal = "";
      if (activeTab === "ALL") {
        axisVal =
          (fltDateAxis === "dueDate"
            ? o.targetEndDate
            : fltDateAxis === "customerDeliveryDate"
              ? (o.customerDeliveryDate || "")
              : (o.createdAt || "")) || "";
      } else {
        // Dept page — find the matching JC's dueDate. Skip filter when the
        // PO has no JC for this dept (don't silently hide it; the cell will
        // render empty and the operator can choose to widen the filter).
        const jc = (o.jobCards ?? []).find((j) => j.departmentCode === activeTab);
        axisVal = jc?.dueDate || "";
      }
      if (deferredFltDueFrom && axisVal && axisVal < deferredFltDueFrom) return false;
      if (deferredFltDueTo && axisVal && axisVal > deferredFltDueTo) return false;
      // "Filter Incomplete" toggle — dept-aware:
      //   Overview ("ALL")  → keep POs whose UPHOLSTERY JC isn't done.
      //                       UPH gates ship-readiness, so this answers
      //                       "what's still in scope but hasn't shipped?"
      //   Per-dept tab      → keep POs whose JC for that dept isn't done.
      //                       Same question, scoped to "what's still on
      //                       this dept's plate?".
      // POs with no JC for the gating dept stay visible — we can't tell
      // those are "done" and silently hiding them would lie about what's
      // still in scope.
      if (deferredIncompleteOnly) {
        const gateDept = activeTab === "ALL" ? "UPHOLSTERY" : activeTab;
        // For UPHOLSTERY (Overview gate + UPH dept tab), drop DIVAN UPH JCs
        // when the PO is BEDFRAME + Headboard Only. Mirrors the backend
        // cascade and the delivery page's pickRelevantUphCards — legacy
        // HB-only POs carry a stranded DIVAN UPH JC that will never complete,
        // and the only piece that gates ship-readiness is the HB UPH JC.
        const gateJcs = gateDept === "UPHOLSTERY"
          ? pickRelevantUphCards(o)
          : (o.jobCards ?? []).filter((j) => j.departmentCode === gateDept);
        if (gateJcs.length > 0) {
          const stillOpen = gateJcs.some(
            (j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED",
          );
          if (!stillOpen) return false;
        }
      }
      // Hide CANCELLED POs unless explicitly opted in via ?showCancelled=1.
      if (!showCancelled && o.status === "CANCELLED") return false;
      // (Lifecycle filter removed 2026-04-27 — moved to per-column Status
      // filter on the grid. ON_HOLD / COMPLETED rows still get the colored
      // row background via rowClassName so they stay visually distinct in
      // the unfiltered view.)
      return true;
    });
  }, [
    orders, haystackByPo,
    // F5: filter values consumed via deferred copies above. Listing the
    // deferred deps (not the raw filt* state) is what makes useDeferredValue
    // work — the memo recomputes only when the deferred value catches up,
    // not on the urgent render that fires when the input changes.
    deferredFltSearch, deferredFltState, deferredFltCustomer,
    deferredFltDueFrom, deferredFltDueTo, fltDateAxis,
    deferredFltCategory,
    showCancelled,
    deferredIncompleteOnly,
    // activeTab drives the dueDate axis branch added 2026-05-07 (overview
    // → PO.targetEndDate, dept page → matching dept's JC.dueDate). Without
    // it in the deps the memo retains stale results when the route changes.
    activeTab,
  ]);

  // Overdue breakdown + per-category counts. Pre-aggregated server-side
  // (see /api/production-orders/overdue-counts above) so this is a thin
  // pass-through. The endpoint already applies the same isOverduePO /
  // earliestOverdueDateOnPO rules per `overdueDept`, so the rows match
  // what the matrix's red cells show. An SO with both BEDFRAME + SOFA
  // overdue POs counts in BOTH cards (no dedup) — same as before.
  const overdueBreakdown: OverdueSORow[] = useMemo(
    () => overdueCountsResp?.data?.breakdown ?? [],
    [overdueCountsResp],
  );
  const bedframeOverdueCount = overdueCountsResp?.data?.bedframeCount ?? 0;
  const sofaOverdueCount = overdueCountsResp?.data?.sofaCount ?? 0;

  const visibleOrders = useMemo(() => {
    let rows = filteredOrders;
    if (activeTab !== "ALL") {
      rows = rows.filter(
        (o) => cellFor(o, activeTab, filteredOrders).state !== "empty",
      );
    }
    // Overview-only column-level filters + sort. Applied AFTER the
    // page-level filter pass above so the operator can layer column
    // filters on top of the global Customer / Date filters.
    if (activeTab === "ALL") {
      // F5: use deferred overviewFilters here so Clear / per-column filter
      // edits don't block the click on the heavy recompute.
      const f = deferredOverviewFilters;
      // Cell-state cache so dept-status filter + dept-sort don't recompute
      // cellFor() N×M times.
      const cellCache = new Map<string, ReturnType<typeof cellFor>>();
      const cellAt = (o: ProductionOrder, dept: string) => {
        const k = `${o.id}|${dept}`;
        let v = cellCache.get(k);
        if (!v) {
          v = cellFor(o, dept, filteredOrders);
          cellCache.set(k, v);
        }
        return v;
      };
      rows = rows.filter((o) => {
        if (f.soId && !o.poNo.toLowerCase().includes(f.soId.toLowerCase())) return false;
        if (f.product && !(o.productCode || "").toLowerCase().includes(f.product.toLowerCase())) return false;
        if (f.customers.length > 0 && !f.customers.includes(o.customerName)) return false;
        if (f.customerPO && !((o.customerPOId || "").toLowerCase().includes(f.customerPO.toLowerCase()))) return false;
        if (f.specialOrder && !((o.specialOrder || "").toLowerCase().includes(f.specialOrder.toLowerCase()))) return false;
        if (f.qtyMin && Number(o.quantity) < Number(f.qtyMin)) return false;
        if (f.qtyMax && Number(o.quantity) > Number(f.qtyMax)) return false;
        const dueVal = o.targetEndDate || "";
        if (f.dueFrom && dueVal && dueVal < f.dueFrom) return false;
        if (f.dueTo && dueVal && dueVal > f.dueTo) return false;
        // Dept status filters — only check depts the user actually picked.
        for (const deptCode of Object.keys(f.deptStatuses)) {
          const wanted = f.deptStatuses[deptCode] || [];
          if (wanted.length === 0) continue;
          const c = cellAt(o, deptCode);
          if (c.state === "empty") return false;
          if (!wanted.includes(c.state as "pending" | "overdue" | "done")) return false;
        }
        // Dept date-range filters — applied to the displayed cell date
        // (done → latestCompleted; else → earliestDue). Empty cells fall
        // out of any non-empty filter.
        for (const deptCode of Object.keys(f.deptDates)) {
          const range = f.deptDates[deptCode];
          if (!range || (!range.from && !range.to)) continue;
          const c = cellAt(o, deptCode);
          if (c.state === "empty") return false;
          const cellDate =
            c.state === "done"
              ? (c.latestCompleted || c.earliestDue)
              : c.earliestDue;
          if (!cellDate) return false;
          if (range.from && cellDate < range.from) return false;
          if (range.to && cellDate > range.to) return false;
        }
        return true;
      });
      // Sort — single key, asc/desc. Empty values park at the end so they
      // don't dominate ascending order. F5: deferred copy for the same
      // reason as filters above — sort clicks should feel instant.
      if (deferredOverviewSort) {
        const { key, dir } = deferredOverviewSort;
        const sign = dir === "asc" ? 1 : -1;
        const cmpStr = (av: string, bv: string) => {
          if (!av && !bv) return 0;
          if (!av) return 1; // empties always last
          if (!bv) return -1;
          return av < bv ? -1 * sign : av > bv ? 1 * sign : 0;
        };
        const cmpNum = (a: number, b: number) =>
          a === b ? 0 : a < b ? -1 * sign : 1 * sign;
        rows = [...rows].sort((a, b) => {
          if (key === "soId") return cmpStr(a.poNo || "", b.poNo || "");
          if (key === "product") return cmpStr(a.productCode || "", b.productCode || "");
          if (key === "customer") return cmpStr(a.customerName || "", b.customerName || "");
          if (key === "customerPO") return cmpStr(a.customerPOId || "", b.customerPOId || "");
          if (key === "specialOrder") return cmpStr(a.specialOrder || "", b.specialOrder || "");
          if (key === "qty") return cmpNum(Number(a.quantity || 0), Number(b.quantity || 0));
          if (key === "due") return cmpStr(a.targetEndDate || "", b.targetEndDate || "");
          // Department column — sort by earliest dept due date.
          const ca = cellAt(a, key);
          const cb = cellAt(b, key);
          return cmpStr(ca.earliestDue || "", cb.earliestDue || "");
        });
      }
    }
    return rows;
  }, [filteredOrders, activeTab, deferredOverviewSort, deferredOverviewFilters]);

  // Overview matrix row virtualization. Pre-fix: every order in
  // visibleOrders was rendered to a hand-rolled CSS-grid <div>, so a
  // ~540-row matrix mounted ~7,500 React component nodes (14 cells per
  // row) on every page entry — Wei Siang reported the resulting 5.4s
  // main-thread block 2026-05-11. Mounting only the ~30 rows in the
  // viewport drops the body reconciliation by an order of magnitude.
  // Hooks always run; the body render below switches between
  // virtualized and legacy (matrix on Overview tab only) so dept tabs
  // stay on their existing DataGrid path. estimateSize=36 matches the
  // typical row height (single-line product); rows that wrap (long
  // model + spec line) are auto-measured via `measureElement`.
  const overviewBodyRef = useRef<HTMLDivElement>(null);
  const overviewRowVirtualizer = useVirtualizer({
    count: activeTab === "ALL" ? visibleOrders.length : 0,
    getScrollElement: () => overviewBodyRef.current,
    estimateSize: () => 36,
    overscan: 8,
  });

  // Unique customer + state options for the filter dropdowns, derived
  // live from the order set so they auto-update when data changes.
  // (modelOptions removed 2026-05-08 with the Model filter.)
  const customerOptions = useMemo(
    () =>
      Array.from(new Set(orders.map((o) => o.customerName).filter(Boolean))).sort(),
    [orders],
  );
  const stateOptions = useMemo(
    () =>
      Array.from(new Set(orders.map((o) => o.customerState).filter(Boolean))).sort(),
    [orders],
  );

  // BOM-driven upstream derivation: for the active dept, walk every JC in
  // the loaded POs that matches activeTab and collect every sibling JC
  // (same wipKey) with a smaller `sequence`.  Their dept codes are the
  // BOM-defined upstreams.
  //
  // The previous hardcoded UPSTREAM map disagreed with the BOM in two
  // places: it claimed FOAM had FAB_SEW upstream (true for BF Headboard,
  // false for Sofa Base where they're parallel) and PACKING was always
  // downstream of just UPHOLSTERY (also a special-case assumption).
  // Reading sequence per wipKey makes whatever the BOM says the source
  // of truth, no map maintenance.  Falls back to no upstreams if the
  // active tab has no JCs loaded yet (initial render).
  const upstreamDepts = useMemo<Set<string>>(() => {
    const set = new Set<string>();
    if (!activeTab || activeTab === "ALL") return set;
    for (const o of filteredOrders) {
      for (const jc of o.jobCards) {
        if (jc.departmentCode !== activeTab) continue;
        if (jc.wipKey == null) continue;
        for (const sib of o.jobCards) {
          if (sib.id === jc.id) continue;
          if (sib.wipKey !== jc.wipKey) continue;
          if (sib.sequence >= jc.sequence) continue;
          if (sib.departmentCode) set.add(sib.departmentCode);
        }
      }
    }
    return set;
  }, [filteredOrders, activeTab]);


  // Dept-view rows: one row per JobCard in the selected dept, flattened
  // across all production orders. Matches the "Production Sheet" columns
  // the user showed. Each row also carries the upstream (previous) dept's
  // scheduling/completion info so the grid can render a pending/overdue/
  // done pill like the Google sheet.
  type PrevState = "pending" | "overdue" | "done" | "none";
  type DeptSched = {
    due: string;         // YYYY-MM-DD
    completed: string;   // YYYY-MM-DD or ""
    state: PrevState;    // "none" when no JobCard exists for this dept
    sortKey: number;     // overdue(3)>pending(2)>done(1)>none(0) — for column sort
    poId: string;        // parent production order id (for PATCH routing)
    jobCardId: string;   // the underlying job card id to patch
    deptCode: string;    // this cell's dept code (needed for upstream-lock check)
    wipKey: string;      // this cell's wipKey (scopes the upstream-lock check)
    // True when any job card LATER in DEPT_ORDER within the same wipKey is
    // already COMPLETED or TRANSFERRED. When true, the cell's date picker
    // is disabled — the operator must un-complete the downstream dept first.
    locked: boolean;
  };
  type DeptRow = {
    id: string;            // `${po.id}:${jc.id}`
    poId: string;
    jobCardId: string;
    rowNo: number;
    soId: string;          // line-suffixed SO ID, unique per production line (= poNo)
    salesOrderNo: string;  // parent sales order id, NOT unique per line
    salesOrderId: string;  // SO primary key — used to route double-click to /sales/:id
    consignmentOrderId: string;  // CO primary key — used to route to /consignment/:id when SO id is empty
    customerPOId: string;
    customerRef: string;
    customerSO: string;   // customer's own SO no. (CO no. for CO-origin rows)
    customerName: string;
    customerState: string;
    model: string;
    // Full product code (includes variant suffix for SOFA, e.g.
    // "5540-1A(LHF)" / "5540-2A(LHF)"). Bedframe/Accessory share the
    // same value as `model` since their productCode IS the model. Used
    // by the FAB_SEW BASE sticker so workers see which sofa variant
    // they're sewing (1A LHF / 2A RHF / etc.), not just the bare base
    // model number.
    productCode: string;
    wip: string;
    category: string;     // SOFA / BEDFRAME / ACCESSORY (from PO/SO item)
    wipType: string;      // DIVAN / HEADBOARD / SOFA_BASE / SOFA_CUSHION / SOFA_ARMREST
    size: string;
    colour: string;
    gap: string;
    divan: string;
    leg: string;
    totalHeight: string;  // gap + divan + leg, inches
    qty: number;
    specialOrder: string; // free-text note from the SO line ("custom legs", "no piping", etc.)
    prodTime: number;     // per-jc production minutes (merged sum on FAB_CUT rows)
    rack: string;         // Packing dept — assigned rack location ("Rack 3")
    dueDate: string;
    completedDate: string;
    // Per-piece progress for the Completion column. piecesTotal floors
    // at 1 (single-piece JCs); piecesDone is 0 until at least one piece
    // has been QR-scanned. Renders "X/Y" when 0 < piecesDone < piecesTotal.
    piecesTotal: number;
    piecesDone: number;
    // ISO timestamp of the "Sent to floor" tick (job_cards.distributedAt).
    // NULL until the operator hands the printed sheet to the production
    // worker. Drives the leftmost Sent column on the dept grid.
    distributedAt: string | null;
    // Derived "Yes"/"No" so the column-level Values filter can group
    // rows by sent-state. Without this the filter sees only the
    // ISO-timestamp string and dumps every row into "(blank)".
    sent: "Yes" | "No";
    // Predicted fabric meters for this WIP, computed server-side by
    // walking the parent PO's BOM template (bom_templates.wipComponents)
    // and summing FAB_CUT-node fabric materials × node.quantity ×
    // po.quantity × scaling. Populated only for FAB_CUT JCs; 0 for
    // every other dept. Drives the FAB_CUT dept page's Fabric Usage
    // column.
    fabricUsage: number;
    pic1: string;
    pic2: string;
    status: string;        // job_card status
    poStatus: string;      // parent production_order status — drives ON_HOLD / CANCELLED styling
    // Scheduling info for every one of the 8 departments — NOT just
    // upstreams. The user can toggle any dept column on/off via the grid's
    // Columns button. Each entry is flattened into `sched_<CODE>` keys so
    // DataGrid can sort/filter per-column without touching a nested object.
    sched_FAB_CUT: DeptSched;
    sched_FAB_SEW: DeptSched;
    sched_FOAM: DeptSched;
    sched_WOOD_CUT: DeptSched;
    sched_FRAMING: DeptSched;
    sched_WEBBING: DeptSched;
    sched_UPHOLSTERY: DeptSched;
    sched_PACKING: DeptSched;
  };

  // Build a DeptSched from a candidate JobCard (or null if no card exists).
  // `poJobCards` is every JobCard on the parent PO. The `locked` flag is
  // computed by filtering to the **card's own** wipKey — NOT the row's
  // wipKey — so that a column showing a different wipKey's JC (e.g. the
  // FAB_CUT column on a WOOD_CUT row, where Wood Cut is the Divan chain
  // and Fab Cut is the HB chain in a Bedframe BOM) only locks if a later
  // dept in THAT card's own chain has completed. Previously the caller
  // pre-filtered siblings by the row's wipKey, which created a false-
  // positive lock when a row's column displayed a card from a different
  // chain (Wood Cut DONE wrongly locked Fab Cut + Fab Sew on the same
  // row even though those three are independent component chains —
  // reported by user 2026-04-26).
  // Aggregate-form DeptSched for the sofa PACKING merge-row case (wipKey
  // === "FG"). At PACKING, sofa's 3 component branches (Base / Cushion /
  // Armrest) collapse into one JC keyed "FG". For each upstream dept we
  // need to summarize across ALL component-branch JCs in that dept on
  // this PO — NOT pick one JC scoped to the row's wipKey (FG has no
  // upstream). Mirrors `cellFor()`'s semantics for the Overview matrix.
  //
  // Output shape matches buildSched so the same DataGrid renderer works:
  //   - due       = earliest non-empty dueDate across cards
  //   - completed = max completedDate iff EVERY card is COMPLETED/
  //                 TRANSFERRED, else "" (matches user spec — only show a
  //                 date when the merged dept is fully done)
  //   - state     = "done" if all done; else "overdue" if earliest due
  //                 already passed; else "pending"
  // jobCardId/deptCode/wipKey come from the first card so the patch
  // route still resolves, but the cell is conceptually a roll-up — see
  // TODO below.
  const buildSchedAgg = (
    cards: JobCard[],
    today: string,
    poId: string,
  ): DeptSched => {
    if (cards.length === 0) {
      return {
        due: "", completed: "", state: "none", sortKey: 0, poId,
        jobCardId: "", deptCode: "", wipKey: "", locked: false,
      };
    }
    const due =
      cards.map((c) => c.dueDate || "").filter(Boolean).sort()[0] || "";
    const allDone = cards.every(
      (c) => c.status === "COMPLETED" || c.status === "TRANSFERRED",
    );
    const completed = allDone
      ? cards.map((c) => c.completedDate || "").filter(Boolean).sort().slice(-1)[0] || ""
      : "";
    let state: PrevState;
    if (allDone) state = "done";
    else if (due && due < today) state = "overdue";
    else state = "pending";
    const sortKey = state === "overdue" ? 3 : state === "pending" ? 2 : 1;
    // TODO: aggregate cells aren't directly patch-clickable — jobCardId/
    // deptCode/wipKey reflect the first underlying card only. The
    // PACKING merge-row's upstream date columns are read-only from the
    // operator's perspective; date edits happen on the per-component
    // dept tabs (Fab Cut / Foam / Wood Cut etc.) where individual JCs
    // are still rendered.
    const first = cards[0];
    return {
      due, completed, state, sortKey, poId,
      jobCardId: first.id,
      deptCode: first.departmentCode,
      wipKey: first.wipKey || "",
      locked: false,
    };
  };

  const buildSched = (
    card: JobCard | null,
    today: string,
    poId: string,
    poJobCards: JobCard[] = [],
  ): DeptSched => {
    if (!card) {
      return {
        due: "", completed: "", state: "none", sortKey: 0, poId,
        jobCardId: "", deptCode: "", wipKey: "", locked: false,
      };
    }
    const due = card.dueDate || "";
    const completed = card.completedDate || "";
    const isDone = card.status === "COMPLETED" || card.status === "TRANSFERRED";
    let state: PrevState;
    if (isDone) state = "done";
    else if (due && due < today) state = "overdue";
    else state = "pending";
    const sortKey = state === "overdue" ? 3 : state === "pending" ? 2 : 1;
    // Lock UI disabled (2026-04-26) — aligns with backend.
    //
    // Backend already disabled the upstream-lock predicate at
    // src/api/routes/production-orders.ts:1255 + :2121 (PATCH guard +
    // scan-complete guard are no-ops). Frontend used to compute `locked`
    // from the same flat DEPT_ORDER + wipKey heuristic which:
    //   (a) fired false positives across BOM parallel branches — Wood Cut
    //       DONE wrongly locked Fab Cut/Sew on the same wipKey row, even
    //       though backend would happily accept the patch
    //   (b) rendered misleading 🔒 icons that no longer reflected any
    //       backend gate — UX worse than full-off
    // Until BOM-driven (per-branch) lock chain lands, set `locked = false`
    // unconditionally so frontend matches backend reality. `poJobCards`
    // stays in the signature for the eventual rewrite.
    void poJobCards;
    const locked = false;
    return {
      due, completed, state, sortKey, poId,
      jobCardId: card.id,
      deptCode: card.departmentCode,
      wipKey: card.wipKey || "",
      locked,
    };
  };

  // Heavy row-building pass — keyed on `filteredOrders` only so tab
  // switches don't trigger the full JC-to-row transformation + every
  // per-JC picker chain. Each row carries its own `_deptCode` so the
  // cheap `deptRows` memo below can filter without re-running picker
  // logic or buildSched per dept.
  //
  // Attaching _deptCode on the row (rather than filtering JCs upstream)
  // keeps the sched_FAB_CUT…sched_PACKING grid-column data intact for
  // every row — those columns are user-toggleable on any dept tab.
  // Sprint 5 F4: pre-compute the picker index. Per (poId, deptCode, wipKey)
  // store the latest-due JobCard; per (poId, deptCode, "*") store the
  // fallback (any wipKey on that PO/dept). The previous implementation
  // ran o.jobCards.filter twice + a sort INSIDE picker(code) for every
  // (PO, JC) × every dept-column the grid renders — at 500 POs × 8 JCs ×
  // 8 dept-columns that's 32k filter+sort passes per render. Now: 8 ×
  // (jobCards × 2) per PO at index time, O(1) lookups during render.
  type PickerByDept = Map<string, Map<string, JobCard>>;
  const pickerIndex = useMemo(() => {
    const idx = new Map<string, PickerByDept>();
    for (const o of filteredOrders) {
      const byDept: PickerByDept = new Map();
      for (const j of o.jobCards) {
        const code = j.departmentCode;
        let m = byDept.get(code);
        if (!m) {
          m = new Map();
          byDept.set(code, m);
        }
        const wipKey = j.wipKey || "";
        // Latest-due wins (mirrors the previous picker's sort step).
        const prevForKey = m.get(wipKey);
        if (
          !prevForKey ||
          (j.dueDate || "").localeCompare(prevForKey.dueDate || "") > 0
        ) {
          m.set(wipKey, j);
        }
        // Track the fallback ("*") = latest-due across ALL wipKeys in
        // this (PO, dept). Mirrors the picker's second pass when no
        // wipKey-matched card exists.
        const prevAny = m.get("*");
        if (
          !prevAny ||
          (j.dueDate || "").localeCompare(prevAny.dueDate || "") > 0
        ) {
          m.set("*", j);
        }
      }
      idx.set(o.id, byDept);
    }
    return idx;
  }, [filteredOrders]);

  const baseRows = useMemo<Array<DeptRow & { _deptCode: string }>>(() => {
    const today = new Date().toISOString().slice(0, 10);
    const rows: Array<DeptRow & { _deptCode: string }> = [];
    let n = 1;

    // Pre-index orders by their merge-group key so the picker's cross-PO
    // sibling scan below is O(1) lookup instead of O(N) over ALL filtered
    // orders. The full scan was the main thread freeze the operator hit
    // when navigating between dept pages on large depts (e.g. fab-sew with
    // 1.8k orders × 3 JCs × 8 dept columns × 1.8k inner-scan ≈ 80M iters
    // → 45s renderer hang, "需要 refresh 才 load" symptom). The group key
    // recipe MUST stay in sync with the per-sibling computation in the
    // picker fallback (companySOId || salesOrderId || companyCOId ||
    // consignmentOrderId) — otherwise siblings vanish from the index and
    // SOFA cross-PO FAB_CUT lookups silently return null again.
    const ordersByGroup = new Map<string, ProductionOrder[]>();
    for (const o of filteredOrders) {
      const gid =
        o.companySOId ||
        o.salesOrderId ||
        o.companyCOId ||
        o.consignmentOrderId ||
        "";
      if (!gid) continue;
      const arr = ordersByGroup.get(gid);
      if (arr) arr.push(o);
      else ordersByGroup.set(gid, [o]);
    }

    for (const o of filteredOrders) {
      const poDeptIndex = pickerIndex.get(o.id);
      for (const jc of o.jobCards) {
        // F4: O(1) picker lookup against the pre-built (deptCode, wipKey)
        // index. wipKey-strict only — NO cross-wipKey fallback. Previously
        // a `byDept.get("*")` fallback returned "any wipKey" JC on this PO
        // when no exact wipKey match existed, which leaked HEADBOARD's
        // FOAM JC into DIVAN rows' FOAM column (DIVAN has no FOAM JC in
        // its wipKey, so the fallback picked HB's FOAM date and showed it
        // in the wrong row). Reported by Wei Siang 2026-04-30. Now an
        // empty cell appears when this row's wipKey doesn't include the
        // queried dept — accurate to the BOM.
        const picker = (code: string): JobCard | null => {
          const byDept = poDeptIndex?.get(code);
          if (byDept && jc.wipKey) {
            const exact = byDept.get(jc.wipKey);
            if (exact) return exact;
          }
          // Option C FAB_CUT lookup: post-merge there's at most one FC JC
          // per PO (BF/ACC) or per merged (SO+baseModel+fabric) group
          // (SOFA). FAB_SEW (and other downstream) rows still have their
          // per-piece wipKey, which won't match the merged FC's wipKey,
          // so the strict per-wipKey lookup above misses. Restore the
          // "any FC on this PO" fallback ONLY for FAB_CUT — safe now
          // because per-piece FC JCs were collapsed into one.
          //
          // CRITICAL: do NOT bail on `if (!byDept) return null;` before
          // running the cross-PO scan. The merged-FC-on-anchor case (SOFA
          // sibling POs that have ZERO FC JCs of their own) needs the
          // cross-PO scan to walk the SO and find the anchor's FC, but
          // bailing on undefined byDept short-circuits before the scan
          // ever runs — the row would render "—" indefinitely.
          // Option-C-aware fallback. Two symmetric directions:
          //   (A) Looking UP at FAB_CUT from any non-FC row. The merged FC
          //       JC has a new wipKey schema that doesn't match per-piece
          //       downstream wipKeys, so the strict lookup above misses.
          //       Restore the "*" fallback ONLY for FAB_CUT — safe now
          //       because per-piece FC JCs were collapsed into one merged
          //       JC per group. If still missing on the same PO (SOFA
          //       case where FC lives on the anchor PO), scan sibling POs.
          //   (B) Looking DOWN at any dept from a FAB_CUT row. The FC row
          //       represents a merged group; per-piece downstream JCs
          //       (FAB_SEW / FRAME / etc.) on this PO have wipKeys that
          //       don't match the merged FC's wipKey. Allow "*" fallback
          //       for any dept so the FC row can surface downstream
          //       progress. For SOFA cross-PO merge, scan sibling POs of
          //       the same companySOId for that dept's JC.
          const lookingForFc = code === "FAB_CUT";
          const fromFcRow = jc.departmentCode === "FAB_CUT";
          if (lookingForFc || fromFcRow) {
            const samePoAny = byDept ? byDept.get("*") : undefined;
            if (samePoAny) return samePoAny;
            // Cross-PO scan for the merge group's siblings.
            //   SOFA  → group key is (parentDocId + baseModel + fabricCode);
            //           sibling POs span multiple modules of the same sofa.
            //   BF/ACC → group key is parentDocId itself.
            // CO-origin POs use companyCOId / consignmentOrderId — without
            // these in the fallback, every CO sofa sibling row rendered
            // FAB_CUT blank even though the anchor PO carried the merged
            // FC JC.
            const myGroupId =
              o.companySOId ||
              o.salesOrderId ||
              o.companyCOId ||
              o.consignmentOrderId ||
              "";
            if (myGroupId) {
              const isSofa = o.itemCategory === "SOFA";
              const myBase = (o.productCode || "").split("-")[0];
              const myFabric = o.fabricCode || "";
              // O(1) groupId lookup against the pre-indexed map at the top
              // of this useMemo — no more O(N_filteredOrders) scan per call.
              // Group key recipe is duplicated in the index builder; keep
              // them in lockstep.
              const sibs = ordersByGroup.get(myGroupId);
              if (sibs) {
                for (const sib of sibs) {
                  if (sib.id === o.id) continue;
                  // SOFA must also match baseModel + fabric since multiple
                  // sofa products can coexist in one parent doc.
                  if (isSofa) {
                    if ((sib.fabricCode || "") !== myFabric) continue;
                    const sibBase = (sib.productCode || "").split("-")[0];
                    if (sibBase !== myBase) continue;
                  }
                  const sibJc = sib.jobCards.find(
                    (j) => j.departmentCode === code,
                  );
                  if (sibJc) return sibJc;
                }
              }
            }
          }
          return null;
        };

        // Pass the full PO JC list to buildSched — it filters siblings by
        // each CARD's own wipKey, so a per-column DeptSched only sees
        // wipKey-matching JCs. Pre-filtering by the row's wipKey here was
        // the source of the cross-chain false-positive lock (Wood Cut DONE
        // locking Fab Cut on the same row).
        const poJobCards: JobCard[] = o.jobCards;

        rows.push({
          id: `${o.id}:${jc.id}`,
          poId: o.id,
          jobCardId: jc.id,
          rowNo: n++,
          // SO ID display rule (sofa drops -NN suffix, BF/ACC keep it):
          //   SOFA   → parent SO (companySOId, e.g. SO-2604-293) because a
          //           sofa set spans multiple variant-POs and no single
          //           -01/-02 suffix belongs to the whole set. Multiple
          //           sofa rows from the same SO will display the same SO
          //           ID — operators distinguish by product / variant /
          //           fabric columns.
          //   BF/ACC → line-suffixed poNo (e.g. SO-2604-293-01) because
          //           qty>1 already fans out into per-piece POs and the
          //           suffix genuinely identifies one physical piece.
          // Applies to every dept tab — soId is computed once at row
          // construction and consumed by all dept render paths uniformly.
          //
          // CO-origin POs (migration 0064): companySOId is empty and the
          // parent doc id lives on companyCOId. Fall back so SOFA rows
          // from a CO display CO-YYMM-NNN instead of a blank cell. The
          // BF/ACC branch already works because o.poNo is line-suffixed
          // for both SO and CO POs (CO-2604-001-01 etc.).
          soId: (o.itemCategory === "SOFA"
                  ? (o.companySOId || o.companyCOId)
                  : o.poNo) || "",
          salesOrderNo: o.companySOId || o.companyCOId || "",   // parent doc (SO or CO), not unique per line
          salesOrderId: o.salesOrderId || "",
          consignmentOrderId: o.consignmentOrderId || "",
          customerPOId: o.customerPOId || "",
          customerRef: o.customerReference || "",
          customerSO: o.customerSO || "",
          customerName: o.customerName || "",
          customerState: o.customerState || "",
          // Model column display rule: sofa drops the variant suffix
          // ("5531-2A(LHF)" → "5531") because the merged FAB_CUT row joins
          // multiple variants into the WIP column already, and a Model
          // value of just "5531" matches how Wei Siang refers to sofas
          // ("5531/5535/..." base). BF/ACC keep the full productCode
          // (e.g. "1013-(Q)") since the variant IS the model identity.
          model: o.itemCategory === "SOFA"
            ? (o.productCode || "").split("-")[0]
            : (o.productCode || ""),
          productCode: o.productCode || "",
          wip: jc.wipLabel || jc.wipCode || (() => {
            // Derive WIP code from PO data when job card doesn't carry it
            if (o.itemCategory === "BEDFRAME") {
              const totalH = (o.gapInches ?? 0) + (o.divanHeightInches ?? 0) + (o.legHeightInches ?? 0);
              // Divan-producing depts
              if (["WOOD_CUT", "FRAMING", "WEBBING"].includes(jc.departmentCode) && o.divanHeightInches) {
                return `${o.divanHeightInches}" Divan-${o.sizeLabel || o.sizeCode || ""}`;
              }
              // HB-producing depts
              if (["FAB_CUT", "FAB_SEW", "FOAM", "UPHOLSTERY", "PACKING"].includes(jc.departmentCode) && totalH > 0) {
                return `${o.productCode}-HB${totalH}"`;
              }
            }
            if (o.itemCategory === "SOFA") {
              return o.productCode || "";
            }
            return "";
          })(),
          // Category: BEDFRAME / SOFA / ACCESSORY from the PO (mirrors the
          // SO item category). Shown in its own toggleable column.
          category: o.itemCategory || "",
          // wipType short label — aligned with inventory WIP page enum:
          //   HB, DIVAN, BASE, CUSHION, ARMREST, HEADREST
          // so the Production "Type" filter can line up with the inventory
          // stock filter labels.
          wipType: (() => {
            const t = (jc.wipType || "").toUpperCase();
            if (t === "HEADBOARD") return "HB";
            if (t === "SOFA_BASE") return "BASE";
            if (t === "SOFA_CUSHION") return "CUSHION";
            if (t === "SOFA_ARMREST") return "ARMREST";
            if (t === "SOFA_HEADREST") return "HEADREST";
            if (t === "DIVAN") return "DIVAN";
            if (t) return t;
            // Derive from dept + category when not set
            if (o.itemCategory === "BEDFRAME") {
              if (["WOOD_CUT", "FRAMING", "WEBBING"].includes(jc.departmentCode) && o.divanHeightInches) return "DIVAN";
              return "HB";
            }
            if (o.itemCategory === "SOFA") {
              if (o.sizeCode?.includes("A")) return "BASE";
              return "CUSHION";
            }
            return "";
          })(),
          size: o.sizeLabel || "",
          colour: o.fabricCode || "",
          // Gap / Divan / Total H are bedframe-only concepts — sofas don't
          // have them. Force empty on sofa / accessory even if DB has a
          // stray value (legacy data may have misfiled seat size into the
          // divan column). Leg is kept because sofa does have optional leg
          // heights via maintenance config.
          gap: o.itemCategory === "BEDFRAME" && o.gapInches != null ? `${o.gapInches}"` : "",
          divan: o.itemCategory === "BEDFRAME" && o.divanHeightInches != null ? `${o.divanHeightInches}"` : "",
          leg: o.legHeightInches != null ? `${o.legHeightInches}"` : "",
          // Total height = gap + divan + leg, only meaningful for bedframes.
          // Sofa TotalH would just mirror Leg so it's intentionally blank.
          totalHeight: (() => {
            if (o.itemCategory !== "BEDFRAME") return "";
            const g = o.gapInches ?? 0;
            const d = o.divanHeightInches ?? 0;
            const l = o.legHeightInches ?? 0;
            const sum = g + d + l;
            return sum > 0 ? `${sum}"` : "";
          })(),
          qty: (jc as JobCard & { wipQty?: number }).wipQty ?? o.quantity ?? 0,
          specialOrder: o.specialOrder || "",
          // Per-jc production time (minutes), TOTAL = per-unit × wipQty so the
          // sheet column shows hours of work, not per-piece. Populated on every
          // dept sheet — the FAB_CUT merge step below aggregates this across
          // merged children so the collapsed row reports a sum, matching what
          // the sticker prints.
          prodTime:
            ((jc.productionTimeMinutes || jc.estMinutes || 0) as number) *
            (((jc as JobCard & { wipQty?: number }).wipQty ?? 1) || 1),
          rack: (jc as JobCard & { rackingNumber?: string }).rackingNumber || "",
          dueDate: jc.dueDate || "",
          completedDate: jc.completedDate || "",
          // Surface per-piece progress so renderCompletionCell can show
          // "X/Y" when a multi-piece JC is partially scanned. Floor
          // piecesTotal at max(1, wipQty) to mirror the API contract;
          // piecesDone defaults to 0 so single-piece JCs / payloads
          // without the new fields don't trip the partial-render branch.
          piecesTotal: Math.max(1, jc.piecesTotal ?? jc.wipQty ?? 1),
          piecesDone: jc.piecesDone ?? 0,
          // ISO timestamp the operator clicked the "Sent" tick. NULL =
          // not yet handed out; truthy = printed + given to the floor.
          distributedAt: jc.distributedAt ?? null,
          sent: jc.distributedAt ? "Yes" : "No",
          // Predicted fabric meters for FAB_CUT JCs, computed server-side
          // from bom_templates (see rowToMinimalJobCard in
          // production-orders.ts). 0 / undefined for non-FC depts —
          // surfaces as "—" in the dept sheet's Fabric Usage column.
          fabricUsage:
            (jc as JobCard & { fabricUsageMeters?: number })
              .fabricUsageMeters ?? 0,
          pic1: jc.pic1Name || "",
          pic2: jc.pic2Name || "",
          status: jc.status || "",
          poStatus: o.status || "",
          // Sofa PACKING merge case: jc.wipKey === "FG" means this row IS
          // the merged Packing JC (sofa's 3 component branches —
          // Base / Cushion / Armrest — collapse here). Upstream depts
          // still have per-component JCs in this PO with non-"FG"
          // wipKeys. The picker would scope by jc.wipKey="FG" → no
          // match → fall back to most-recent-due card, which is
          // semantically wrong for a merge view. Use per-dept aggregate
          // across ALL JCs in that dept on this PO instead.  Bedframe
          // PACKING JCs use wipKeys like `1007-(K)::0::DIVAN::...` (not
          // "FG"), so this branch leaves the existing picker path alone
          // for bedframes — only the sofa Packing merge row aggregates.
          ...(jc.wipKey === "FG"
            ? {
                sched_FAB_CUT:    buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "FAB_CUT"),    today, o.id),
                sched_FAB_SEW:    buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "FAB_SEW"),    today, o.id),
                sched_FOAM:       buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "FOAM"),       today, o.id),
                sched_WOOD_CUT:   buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "WOOD_CUT"),   today, o.id),
                sched_FRAMING:    buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "FRAMING"),    today, o.id),
                sched_WEBBING:    buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "WEBBING"),    today, o.id),
                sched_UPHOLSTERY: buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "UPHOLSTERY"), today, o.id),
                sched_PACKING:    buildSchedAgg(o.jobCards.filter((j) => j.departmentCode === "PACKING"),    today, o.id),
              }
            : {
                sched_FAB_CUT:    buildSched(picker("FAB_CUT"),    today, o.id, poJobCards),
                sched_FAB_SEW:    buildSched(picker("FAB_SEW"),    today, o.id, poJobCards),
                sched_FOAM:       buildSched(picker("FOAM"),       today, o.id, poJobCards),
                sched_WOOD_CUT:   buildSched(picker("WOOD_CUT"),   today, o.id, poJobCards),
                sched_FRAMING:    buildSched(picker("FRAMING"),    today, o.id, poJobCards),
                sched_WEBBING:    buildSched(picker("WEBBING"),    today, o.id, poJobCards),
                sched_UPHOLSTERY: buildSched(picker("UPHOLSTERY"), today, o.id, poJobCards),
                sched_PACKING:    buildSched(picker("PACKING"),    today, o.id, poJobCards),
              }),
          _deptCode: jc.departmentCode,
        });
      }
    }
    return rows;
    // buildSched is stable (defined in render) but references no state we
    // care about beyond `today`; excluding it keeps the memo from recomputing
    // on every render. Intentionally not listed. pickerIndex is recomputed
    // when filteredOrders changes so listing both is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredOrders, pickerIndex]);

  const deptRows = useMemo<DeptRow[]>(() => {
    if (activeTab === "ALL") return [];
    // Cheap pass: filter the precomputed flat row list by the active tab's
    // departmentCode. Previously this pass rebuilt every row (with the full
    // picker + buildSched chain) on every tab switch.
    const rows: DeptRow[] = baseRows
      .filter((r) => r._deptCode === activeTab)
      .map((r, i) => {
        // Drop the internal _deptCode marker + renumber rowNo for the
        // filtered view. Spreading into a fresh object avoids mutating
        // baseRows (which React would otherwise see as unchanged refs).
        const { _deptCode: _drop, ...clean } = r;
        void _drop;
        return { ...clean, rowNo: i + 1 };
      });

    // FAB_CUT used to merge multiple component JCs into one row (sofa: by
    // SO+fabric, BF/accessory: by poId), with downstream fan-out PATCH and
    // a sentinel sticker. That merge / fan-out / sentinel split was the
    // source of duplicate-row, qty-mismatch and mixed-status filter bugs
    // (Wei Siang Apr 26 2026). FAB_CUT now behaves identically to every
    // other dept — one row per matching JobCard, no merge.
    return rows;
  }, [baseRows, activeTab]);

  // Per-dept pill renderer. Click anywhere on the pill to fill the
  // completion date for that department's underlying JobCard. Filling
  // (non-empty) also flips the status to COMPLETED; clearing reverts to
  // WAITING. The pill color reflects current state:
  //   done → cyan, pending → amber, overdue → rose, none → em-dash.
  const renderDeptSchedCell = (s: DeptSched) => {
    if (s.state === "none") {
      return <span className="text-[#BDB4A8] text-[11px] pl-2">—</span>;
    }
    const base =
      "flex items-center justify-between gap-1 px-1.5 py-[2px] rounded-sm text-[10px] font-semibold whitespace-nowrap leading-tight w-full";
    let cls = "bg-[#FAEFCB] text-[#9C6F1E]";
    let word = "PENDING";
    let date = s.due;
    if (s.state === "done") {
      cls = "bg-[#E0EDF0] text-[#3E6570]";
      word = "DONE";
      date = s.completed || s.due;
    } else if (s.state === "overdue") {
      cls = "bg-[#F9E1DA] text-[#9A3A2D]";
      word = "OVERDUE";
    }
    // Upstream-lock: when a downstream dept (later in DEPT_ORDER) has already
    // been COMPLETED/TRANSFERRED for this same wipKey, this cell becomes
    // read-only. Greyed pill + lock icon + no onClick so the date picker
    // stays shut. Server-side guard in production-orders.ts PATCH enforces
    // the same rule even if the client state gets bypassed.
    if (s.locked) {
      return (
        <div
          className="relative w-full h-full cursor-not-allowed"
          title="Locked — undo later department first."
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <span className={`${base} ${cls}`} style={{ opacity: 0.6 }}>
            <span className="flex items-center gap-1">
              <Lock className="w-2.5 h-2.5" strokeWidth={2.5} />
              <span className="opacity-80">{word}</span>
            </span>
            <span>{fmtShortDate(date)}</span>
          </span>
        </div>
      );
    }
    return (
      <div
        className="relative w-full h-full cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          const seed =
            s.state === "done" && s.completed ? s.completed : s.due || "";
          openDatePicker(
            seed,
            (v) => {
              if (!v) return;
              patchJobCard(s.poId, s.jobCardId, { dueDate: v });
            },
            e.currentTarget,
          );
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        title="Click to reschedule"
      >
        <span className={`${base} ${cls}`}>
          <span className="opacity-80">{word}</span>
          <span>{fmtShortDate(date)}</span>
        </span>
      </div>
    );
  };

  // PIC dropdown — smart filter (operator request 2026-05-12).
  // Default: narrow to workers whose departmentCodes include the active
  // tab — operators see a short relevant list. The `picShowAll` toggle
  // expands every PIC dropdown to the full roster, for cross-dept
  // temporary-assignment cases (e.g. an Upholstery operator helping out
  // Fab Sew for a shift, or any worker whose Employee Master record
  // hasn't been filled in yet). See workerCoversDept() in
  // src/lib/worker.ts. On the "ALL" overview tab there's no inline PIC
  // editor, so the filter is bypassed there as a defensive fallback.
  const deptWorkers = useMemo(() => {
    const list = [...(workers || [])].sort((a, b) =>
      (a.name || "").localeCompare(b.name || ""),
    );
    if (activeTab === "ALL" || picShowAll) return list;
    return list.filter((w) => workerCoversDept(w, activeTab));
  }, [workers, activeTab, picShowAll]);

  // Full-cell clickable date input. Renders as a spreadsheet cell showing
  // the formatted date; clicking anywhere in the cell opens the picker.
  // The hidden-but-sized native input sits on top to capture clicks.
  const renderDateCell = (
    _row: DeptRow,
    _field: "dueDate" | "completedDate",
    value: string,
    onChange: (v: string) => void,
    placeholder = "— Set —",
  ) => {
    const has = !!value;
    return (
      <div
        className="relative w-full h-full min-h-[22px] cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          openDatePicker(value, onChange, e.currentTarget);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        title="Click to edit date"
      >
        <span
          className={`flex items-center justify-center px-1.5 py-[2px] rounded-sm text-[10px] font-semibold whitespace-nowrap leading-tight w-full ${
            has
              ? "bg-[#F5F2EE] text-[#1F1D1B]"
              : "text-[#BDB4A8] border border-dashed border-[#E6E0D9] hover:bg-[#FFF8E6]"
          }`}
        >
          {has ? fmtShortDate(value) : placeholder}
        </span>
      </div>
    );
  };

  // Full-cell clickable status dropdown. Changing to COMPLETED/TRANSFERRED
  // auto-stamps today as the completion date (unless one already exists);
  // changing back to a non-done state clears the completion stamp. This is
  // the convention the user asked for: "completion 存在就会被 completion 取代"
  // so the two fields stay in sync.
  const STATUS_OPTIONS: JobCard["status"][] = [
    "WAITING",
    "IN_PROGRESS",
    "PAUSED",
    "COMPLETED",
    "TRANSFERRED",
    "BLOCKED",
  ];
  const statusStyle: Record<string, string> = {
    COMPLETED:   "bg-[#E0EDF0] text-[#3E6570]",
    TRANSFERRED: "bg-[#E0EDF0] text-[#3E6570]",
    IN_PROGRESS: "bg-[#FAEFCB] text-[#9C6F1E]",
    PAUSED:      "bg-[#FAEFCB] text-[#9C6F1E]",
    WAITING:     "bg-[#F5F2EE] text-[#8A7F73]",
    BLOCKED:     "bg-[#F9E1DA] text-[#9A3A2D]",
  };
  const renderStatusCell = (row: DeptRow) => {
    const s = row.status;
    const cls = statusStyle[s] || "bg-[#F5F2EE] text-[#8A7F73]";
    return (
      <div className="relative w-full h-full min-h-[28px] group">
        <div
          className={`absolute inset-0 m-1 flex items-center justify-center text-[10px] font-semibold rounded pointer-events-none ${cls}`}
        >
          {s || "—"}
        </div>
        <select
          value={s || ""}
          onChange={(e) => {
            const next = e.target.value as JobCard["status"];
            const becomingDone =
              (next === "COMPLETED" || next === "TRANSFERRED") &&
              !(s === "COMPLETED" || s === "TRANSFERRED");
            const patch: Parameters<typeof patchJobCard>[2] = { status: next };
            if (becomingDone && !row.completedDate) {
              patch.completedDate = new Date().toISOString().slice(0, 10);
            }
            // BUG-2026-05-12 (frontend twin of the backend fix in
            // production-orders.ts:3211): previously, flipping status from
            // COMPLETED → WAITING on the FAB_CUT row sent completedDate="" to
            // the API, which then NULL'd the column. Status is a FILTER label,
            // not a date controller — leaving DONE must NOT wipe the date the
            // operator explicitly stamped. To actually clear the date, the
            // operator clicks the completion date cell and clears it there
            // (which sets status=WAITING + date=null together, the correct
            // user-driven path).
            // Single-JC patch — FAB_CUT no longer merges rows, so every
            // dept (including FC) updates exactly the row's own jobCardId.
            patchJobCard(row.poId, row.jobCardId, patch);
          }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </div>
    );
  };

  const renderDueCell = (row: DeptRow) =>
    renderDateCell(row, "dueDate", row.dueDate, (v) =>
      patchJobCard(row.poId, row.jobCardId, { dueDate: v }),
    );

  // Clickable completion date cell. Shows the stamped date in a cyan
  // pill when present, or a subtle "— Set —" placeholder when empty. The
  // full cell area is a native date picker, matching the dept column pill
  // UX so the user can fill/clear from one place.
  //
  // Partial-progress branch: when wipQty > 1 and 0 < piecesDone < piecesTotal,
  // the JC is mid-flight — some pieces have been QR-scanned, others haven't.
  // Render an amber "X/Y" pill (matching the dept column's PENDING palette)
  // so office staff can see partial progress at a glance instead of an empty
  // cell. Click still opens the same date picker so a user can stamp the
  // whole JC done if they want; the next API refresh will overwrite.
  const renderCompletionCell = (row: DeptRow) => {
    const has = !!row.completedDate;
    const total = row.piecesTotal;
    const done = row.piecesDone;
    const isPartial = total > 1 && done > 0 && done < total && !has;
    // Single-JC stamp/clear — FAB_CUT no longer fans out to merged
    // siblings.
    return (
      <div
        className="relative w-full h-full min-h-[22px] cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          openDatePicker(
            row.completedDate,
            (v) => {
              const patch: Parameters<typeof patchJobCard>[2] = {
                completedDate: v,
                status: v ? "COMPLETED" : "WAITING",
              };
              patchJobCard(row.poId, row.jobCardId, patch);
            },
            e.currentTarget,
          );
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        title={
          isPartial
            ? `${done} of ${total} pieces scanned — click to stamp completion date`
            : "Click to set completion date"
        }
      >
        <span
          className={`flex items-center justify-center px-1.5 py-[2px] rounded-sm text-[10px] font-semibold whitespace-nowrap leading-tight w-full ${
            has
              ? "bg-[#E0EDF0] text-[#3E6570]"
              : isPartial
              ? "bg-[#FAEFCB] text-[#9C6F1E]"
              : "text-[#BDB4A8] border border-dashed border-[#E6E0D9] hover:bg-[#FFF8E6]"
          }`}
        >
          {has
            ? fmtShortDate(row.completedDate)
            : isPartial
            ? `${done}/${total}`
            : "— Set —"}
        </span>
      </div>
    );
  };

  // Full-cell clickable PIC dropdown. Native <select> is stretched to fill
  // the whole cell so any click lands on it. Keeps native dropdown UX.
  const renderPicCell = (row: DeptRow, slot: 1 | 2) => {
    const currentName = slot === 1 ? row.pic1 : row.pic2;
    return (
      <div className="relative w-full h-full min-h-[28px] group">
        <div
          className={`absolute inset-0 flex items-center justify-between gap-1 px-2 text-[11px] rounded pointer-events-none group-hover:bg-[#FFF8E6] ${
            currentName ? "text-[#1F1D1B]" : "text-[#BDB4A8]"
          }`}
        >
          <span className="truncate">{currentName || "— Select —"}</span>
          <span className="text-[#BDB4A8] text-[8px]">▼</span>
        </div>
        <select
          value={currentName || ""}
          onChange={(e) => {
            const name = e.target.value;
            const w = workers.find((x) => x.name === name);
            const patch =
              slot === 1
                ? { pic1Id: w?.id ?? null, pic1Name: name }
                : { pic2Id: w?.id ?? null, pic2Name: name };
            patchJobCard(row.poId, row.jobCardId, patch);
          }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        >
          <option value="">— Select —</option>
          {deptWorkers.map((w) => (
            <option key={w.id} value={w.name}>
              {w.name}
            </option>
          ))}
        </select>
      </div>
    );
  };

  // Memoised so the array identity stays stable across renders. Unstable
  // columns were forcing DataGrid's internal memos to invalidate every tick,
  // which cascaded through sortedData → render → onFilteredDataChange →
  // parent setState → back here. Dept code is the only thing that changes
  // the column set meaningfully (activeTab).
  //
  // Render functions inside columns capture closures at memo-creation time.
  // We pin patchJobCard through a ref so the closure's click handlers
  // always invoke the latest version even though the column array itself
  // doesn't depend on it (and shouldn't — that'd defeat the memo).
  const patchJobCardRef = useRef(patchJobCard);
  useEffect(() => {
    patchJobCardRef.current = patchJobCard;
  }, [patchJobCard]);
  const deptColumns: Column<DeptRow>[] = useMemo(() => [
    // Sent — leftmost tick column (added 2026-05-07). Operator clicks to mark
    // the JC as printed + handed to the floor; persists via the same
    // distributedAt PATCH the print-view uses. Sticky so it stays visible
    // when the grid is scrolled horizontally.
    {
      key: "sent",
      label: "Sent",
      type: "text",
      width: "60px",
      align: "center",
      sticky: true,
      sortable: true,
      render: (_v, row) => {
        const isSent = !!row.distributedAt;
        return (
          <input
            type="checkbox"
            checked={isSent}
            title={
              isSent && row.distributedAt
                ? `Sent at ${new Date(row.distributedAt).toLocaleString()}`
                : "Tick when handed to the floor"
            }
            onChange={() => {
              const next = isSent ? null : new Date().toISOString();
              patchJobCardRef.current(row.poId, row.jobCardId, { distributedAt: next });
            }}
            className="h-4 w-4 cursor-pointer"
          />
        );
      },
    },
    // rowNo + soId are frozen to the left so operators always know which
    // row they're scanning when the grid is scrolled horizontally — this
    // sheet has 30+ columns and the SO ID falls off-screen quickly.
    { key: "rowNo",         label: "#",              type: "number", width: "50px",  align: "right", sortable: true, sticky: true },
    {
      key: "soId",
      label: "SO ID",
      type: "docno",
      width: "170px",
      sortable: true,
      sticky: true,
      // Append an ON HOLD / CANCELLED pill when the parent PO is paused or
      // cancelled so operators can see at-a-glance why the row looks different.
      render: (_v, row) => {
        const pillCls =
          row.poStatus === "ON_HOLD"
            ? "bg-[#FAEFCB] text-[#9C6F1E]"
            : row.poStatus === "CANCELLED"
              ? "bg-[#E5E7EB] text-[#4B5563]"
              : "";
        const pillLabel =
          row.poStatus === "ON_HOLD"
            ? "ON HOLD"
            : row.poStatus === "CANCELLED"
              ? "CANCELLED"
              : "";
        // CO-aware parent-doc navigation: SO POs → /sales/:id, CO POs →
        // /consignment/:id. Without the CO branch, every CO row's SO ID
        // cell rendered as plain text (no link).
        const parentRoute = row.salesOrderId
          ? `/sales/${row.salesOrderId}`
          : row.consignmentOrderId
            ? `/consignment/${row.consignmentOrderId}`
            : null;
        return (
          <span className="flex items-center gap-1.5 tabular-nums">
            {parentRoute ? (
              <button
                type="button"
                className="doc-number truncate text-[#6B5C32] hover:underline cursor-pointer text-left bg-transparent p-0 border-0"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(parentRoute);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
                title={`Open ${row.salesOrderId ? "Sales" : "Consignment"} Order ${row.soId}`}
              >
                {row.soId}
              </button>
            ) : (
              <span className="doc-number truncate">{row.soId}</span>
            )}
            {pillLabel && (
              <span
                className={`text-[9px] font-semibold px-1.5 py-[1px] rounded uppercase tracking-wide ${pillCls}`}
              >
                {pillLabel}
              </span>
            )}
          </span>
        );
      },
    },
    // Customer PO + Customer SO sit together right after the sticky SO ID
    // so operators can read both customer-side reference numbers without
    // scrolling. customerSO is the customer's own SO number (CO number for
    // CO-origin rows), batch-joined onto the payload server-side.
    { key: "customerPOId",  label: "Customer PO",    type: "docno",  width: "130px", sortable: true },
    { key: "customerSO",    label: "Customer SO",    type: "docno",  width: "130px", sortable: true },
    // Low-priority on tablet — operator can re-enable via Columns picker.
    // The on-screen Production matrix has 13+ cols at full width (~2050px).
    // On iPad Mini landscape (~1180px content), customerRef / state / divan /
    // leg / totalHeight / prodTime are nice-to-have not load-bearing for the
    // floor supervisor, so they get hidden by default below lg.
    { key: "customerRef",   label: "Customer Ref",   type: "text",   width: "120px", sortable: true, defaultHidden: isTablet },
    { key: "customerName",  label: "Customer Name",  type: "text",   width: "130px", sortable: true },
    { key: "customerState", label: "State",          type: "text",   width: "70px",  sortable: true, defaultHidden: isTablet },
    { key: "category",      label: "Category",       type: "text",   width: "90px",  sortable: true },
    { key: "model",         label: "Model",          type: "text",   width: "110px", sortable: true },
    // Type column (HEADBOARD / DIVAN / BASE / CUSHION / ARMREST / etc.) —
    // post Option C the FAB_CUT merge collapses multiple piece types into
    // one row so the anchor's wipType is misleading on a merged row.
    // Hide by default on FAB_CUT tab; other dept tabs keep it visible
    // since each row is still per-piece for them. Wei Siang explicitly
    // asked to hide on Fab Cut: "type 的话你可能需要换掉了。要不然我们就直接
    // hide 起来吧". Also hide on tablet to save horizontal space.
    { key: "wipType",       label: "Type",           type: "text",   width: "90px",  sortable: true, defaultHidden: activeTab === "FAB_CUT" || isTablet },
    { key: "wip",           label: "WIP",            type: "text",   width: "220px", sortable: true },
    { key: "size",          label: "Size",           type: "text",   width: "70px",  sortable: true },
    { key: "colour",        label: "Colour",         type: "text",   width: "100px", sortable: true },
    { key: "gap",           label: "Gap",            type: "text",   width: "60px",  sortable: true, align: "right" },
    { key: "divan",         label: "Divan",          type: "text",   width: "70px",  sortable: true, align: "right", defaultHidden: isTablet },
    { key: "leg",           label: "Leg",            type: "text",   width: "60px",  sortable: true, align: "right", defaultHidden: isTablet },
    { key: "totalHeight",   label: "Total H",        type: "text",   width: "75px",  sortable: true, align: "right", defaultHidden: isTablet },
    { key: "specialOrder",  label: "Special Order",  type: "text",   width: "130px", sortable: true },
    { key: "qty",           label: "Qty",            type: "number", width: "60px",  sortable: true, align: "right" },
    // Fabric Usage column — predicted meters of fabric this WIP will consume.
    // Server computes by walking the PO's bom_templates.wipComponents tree
    // (see rowToMinimalJobCard in production-orders.ts), summing FC-node
    // fabric × node.quantity × po.quantity × symmetric scaling. Visible only
    // on the Fab Cut tab since other depts don't consume fabric raw material.
    {
      key: "fabricUsage",
      label: "Fabric Usage (m)",
      type: "number",
      width: "120px",
      sortable: true,
      align: "right",
      hidden: activeTab !== "FAB_CUT",
      render: (_v, row) => {
        if (!row.fabricUsage || row.fabricUsage <= 0) {
          return <span className="text-[#9C9690]">—</span>;
        }
        // 2-decimal display matches the BOM editor's MTR field convention.
        return (
          <span className="tabular-nums font-medium">
            {row.fabricUsage.toFixed(2)}
          </span>
        );
      },
    },
    // Per-row production minutes — supervisors use this as a capacity /
    // time-budget read. On FAB_CUT the merged row sums across all
    // components (Base + Cushion + Arm cut together) so the number
    // reflects the actual lay-down time, not any single component.
    { key: "prodTime",      label: "Prod Time (min)", type: "number", width: "100px", sortable: true, align: "right", defaultHidden: isTablet },
    // Rack — only meaningful for the Packing dept. Hidden on every other
    // tab so the sheet stays clean. Renders as a dropdown of warehouse rack
    // slots; selecting one PATCHes the PO's rackingNumber so the delivery
    // packing list can later read it via the API.
    {
      key: "rack",
      label: "Rack",
      type: "text",
      width: "140px",
      sortable: true,
      hidden: activeTab !== "PACKING",
      render: (_v, row) => (
        <select
          value={row.rack || ""}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => patchRack(row.poId, row.jobCardId, e.target.value)}
          className="h-7 w-full rounded border border-[#E2DDD8] bg-white px-1.5 text-xs text-[#1F1D1B] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
        >
          <option value="">— Select —</option>
          {rackOptions.map((r) => (
            <option key={r.label} value={r.label}>
              {r.label}
              {r.occupied && r.label !== row.rack
                ? ` (${r.occupant || "used"})`
                : ""}
            </option>
          ))}
        </select>
      ),
    },
    // One pill column per department. Each uses a nested "sortKey" path so
    // the grid's dot-notation sort handles overdue > pending > done > none
    // automatically. Every dept appears in the Columns toggle list so the
    // user can add downstream-dept visibility on demand; by default we show
    // only the active dept + its upstreams to keep the sheet uncluttered.
    ...DEPARTMENTS.map((d): Column<DeptRow> => {
      const objKey = `sched_${d.code}` as keyof DeptRow;
      const isActive = d.code === activeTab;
      const isUpstream = upstreamDepts.has(d.code);
      return {
        key: `${objKey}.sortKey`,
        label: d.name,
        type: "number",
        width: "140px",
        sortable: true,
        defaultHidden: !(isActive || isUpstream),
        render: (_v, row) => renderDeptSchedCell(row[objKey] as DeptSched),
        // The filter dropdown for a dept column shows status labels
        // (Pending / Overdue / Done / —) instead of the sortKey number,
        // so the operator can tick "show only Overdue Fab Sew rows" the
        // same way they'd tick a Status column anywhere else. Sort still
        // runs off the numeric sortKey via column.key, so the existing
        // overdue→pending→done→none sort order is unchanged.
        //
        // Wei Siang 2026-05-14: "我现在只能 filter Done、Pending 和
        // Overdue，我需要能 filter 到日期也是" — include the formatted
        // date alongside the status label so the Values dropdown lists
        // every distinct (status, date) combination. Operator can now
        // tick "Overdue 9 May" / "Done 12 May" / etc. to narrow to a
        // specific schedule slot. Done cells use completedDate when set
        // (matches the cell render which prefers completed-on-date).
        filterAccessor: (row) => {
          const s = row[objKey] as DeptSched;
          if (s.state === "none") return "—";
          const rawDate = s.state === "done" ? (s.completed || s.due) : s.due;
          const dateStr = rawDate ? fmtShortDate(rawDate) : "";
          switch (s.state) {
            case "overdue": return dateStr ? `Overdue ${dateStr}` : "Overdue";
            case "pending": return dateStr ? `Pending ${dateStr}` : "Pending";
            case "done":    return dateStr ? `Done ${dateStr}` : "Done";
            default:        return "—";
          }
        },
      };
    }),
    // Due stays plain text (user's preference). Completion is a clickable
    // date picker overlay — same UX as the 8 dept pill columns — so the
    // operator can stamp the completion date directly from the sheet.
    {
      key: "dueDate",
      label: "Due",
      type: "date",
      width: "100px",
      sortable: true,
      render: (_v, row) => renderDueCell(row),
    },
    {
      key: "completedDate",
      label: "Completion",
      type: "date",
      width: "110px",
      sortable: true,
      render: (_v, row) => renderCompletionCell(row),
    },
    {
      key: "pic1",
      label: "PIC 1",
      type: "text",
      width: "120px",
      sortable: true,
      render: (_v, row) => renderPicCell(row, 1),
    },
    {
      key: "pic2",
      label: "PIC 2",
      type: "text",
      width: "120px",
      sortable: true,
      render: (_v, row) => renderPicCell(row, 2),
    },
    {
      key: "status",
      label: "Status",
      type: "status",
      width: "130px",
      sortable: true,
      render: (_v, row) => renderStatusCell(row),
    },
  ], [activeTab, upstreamDepts, isTablet]);

  const activeDept = DEPARTMENTS.find((d) => d.code === activeTab);

  // Derive a WIP/component name for a job-card sticker. Most departments
  // produce the Divan / HB component; Packing produces the FG itself.
  const wipNameFor = useCallback(
    (jc: JobCard, po: ProductionOrder): string => {
      const base = po.productName || po.productCode;
      const dept = jc.departmentCode;
      if (jc.wipLabel) return jc.wipLabel;
      if (dept === "PACKING") return base;
      if (po.itemCategory === "BEDFRAME") {
        if (dept === "WOOD_CUT" || dept === "FRAMING" || dept === "WEBBING") {
          return `Divan ${po.sizeLabel || ""}`.trim();
        }
        if (dept === "FAB_CUT" || dept === "FAB_SEW" || dept === "UPHOLSTERY") {
          return `${base} (Fabric)`;
        }
        if (dept === "FOAM") return `Foam ${po.sizeLabel || ""}`.trim();
      }
      return base;
    },
    [],
  );

  // On-screen QR tile list — mirrors the print-sticker shape but always visible
  // below the grid. When a specific dept tab is active, scope to that dept's
  // job cards only (the QRs correspond to whatever the user is staring at).
  // When Overview is active, show every JC across the filtered POs — but skip
  // Upholstery + Packing: those two depts use the FG Sticker flow, not the
  // Job Card sticker flow, so their cards must NEVER appear in the Job Card
  // tile grid (one dept never carries both sticker types).
  //
  // The preview uses the external qrserver.com URL (only a handful of tiles
  // are visible at once, so rate-limits are not a concern). The batch-print
  // path in `handlePrintJobCardStickers` regenerates every QR locally via
  // `getQRCodeDataURL` so the print preview does NOT depend on hundreds of
  // external HTTP calls completing in time.
  // When a dept sub-tab is active, the Production Sheet DataGrid does its
  // own in-component filtering (search + per-column value/text filters).
  // Mirror that set of visible row ids so the on-screen QR tile row and the
  // Print-All button scope to exactly what the user sees in the grid.
  const gridFilterIdSet = useMemo(() => {
    if (activeTab === "ALL") return null;
    // `null` = grid hasn't reported yet → show everything (no filter).
    // A real filter with zero matches is still a non-null empty array.
    if (gridFilteredDeptRows === null) return null;
    return new Set(gridFilteredDeptRows.map((r) => r.id));
  }, [gridFilteredDeptRows, activeTab]);

  const onScreenStickers = useMemo<JobCardSticker[]>(() => {
    const stickers: JobCardSticker[] = [];

    // Overview: one sticker per job card across every dept, fanned out to
    // qty physical pieces when the job card covers more than one. Each
    // piece gets its own QR payload (p=N&t=M) so the worker portal can
    // reject duplicate scans on the same sticker.
    if (activeTab === "ALL") {
      for (const o of filteredOrders) {
        for (const jc of o.jobCards) {
          const jcWipQty = (jc as { wipQty?: number }).wipQty;
          const rowQty = Math.max(1, Math.floor(jcWipQty || o.quantity || 0) || 1);
          for (let p = 1; p <= rowQty; p++) {
            stickers.push({
              key: `${o.id}:${jc.id}:${p}`,
              poNo: o.poNo,
              deptCode: jc.departmentCode,
              jobCardId: jc.id,
              wipName: wipNameFor(jc, o),
              wipCode: jc.wipCode,
              sizeLabel: o.sizeLabel || o.sizeCode || "",
              qty: rowQty,
              customerPOId: o.customerPOId || "",
              customerState: o.customerState || "",
              customerName: o.customerName || "",
              customerRef: o.customerReference || "",
              salesOrderNo: o.companySOId || o.companyCOId || "",
              model: o.productCode || "",
              wipType: (jc as { wipType?: string }).wipType || "",
              category: o.itemCategory || "",
              colour: o.fabricCode || "",
              gap: o.itemCategory === "BEDFRAME" && o.gapInches != null ? `${o.gapInches}"` : "",
              divan: o.itemCategory === "BEDFRAME" && o.divanHeightInches != null ? `${o.divanHeightInches}"` : "",
              leg: o.legHeightInches != null ? `${o.legHeightInches}"` : "",
              specialOrder: o.specialOrder || "",
              pieceNo: p,
              totalPieces: rowQty,
              qrPayload: generateStickerData(
                o.poNo,
                jc.departmentCode,
                jc.id,
                "/worker/scan",
                rowQty > 1 ? p : undefined,
                rowQty > 1 ? rowQty : undefined,
              ),
            });
          }
        }
      }
      return stickers;
    }

    // Dept tab: derive stickers straight from `deptRows`, so the count is
    // always 1:1 with what the user sees in the Production Sheet above —
    // including the FAB_CUT per-PO fabric merge (one merged row → one
    // merged sticker that fans out via the FG-FAB_CUT sentinel when
    // scanned). `gridFilteredDeptRows` reflects the grid's current
    // search/filter; falls back to the full deptRows until the grid
    // reports back on first paint.
    const orderById = new Map(filteredOrders.map((o) => [o.id, o] as const));
    // Cast via unknown because gridFilteredDeptRows is declared with a
    // narrower inline type (id/poId/jobCardId) above where DeptRow is
    // defined — it actually receives full DeptRow objects from the grid.
    const rowsSource = (gridFilteredDeptRows as unknown as DeptRow[] | null) ?? deptRows;
    for (const row of rowsSource) {
      const order = orderById.get(row.poId);
      if (!order) continue;
      // Wei Siang 2026-05-15: on the FAB_SEW tab for sofa, the
      // operator sews the whole upholstery assembly in one pass —
      // they don't need separate stickers for Back Cushion / Armrest /
      // Headrest. Skip those sub-component JCs in the sticker list.
      // The BASE sticker is the one that travels with the assembly.
      if (
        activeTab === "FAB_SEW" &&
        (row.wipType === "CUSHION" ||
          row.wipType === "ARMREST" ||
          row.wipType === "HEADREST")
      ) {
        continue;
      }
      // Each JC gets its own sticker — no FG-FAB_CUT sentinel anymore.
      // Operators scan once per JC, going through the standard
      // scan-complete flow (scan-complete-dept fan-out is dead).
      const opId = row.jobCardId;
      // qty > 1 fans the row into N physical piece stickers, each with
      // its own p=N&t=M marker so the worker portal can reject double-
      // scans. qty=1 stays single-sticker.
      //
      // Wei Siang 2026-05-15 (REVISED later same day): fan out for ALL
      // dept tabs including FAB_CUT / FAB_SEW. A row with qty=6 now
      // produces 6 physical stickers, each with its own Fab Cut /
      // Fab Sew sign-off line and "Piece N of 6" marker. Each fanned-
      // out sticker represents one physical fabric panel, so displayQty
      // is 1 (the "Qty" line on the body says "Qty 1" — this sticker
      // covers 1 piece). The piece-position marker conveys batch context.
      const pieceCount = Math.max(1, row.qty || 1);
      const displayQty = pieceCount > 1 ? 1 : Math.max(1, row.qty || 1);
      // Wei Siang 2026-05-15: BASE on FAB_SEW shows the variant-
      // qualified product code (e.g. "5540-1A(LHF)" / "5540-2A(RHF)")
      // as the WIP label, NOT the long fabric-encoded string
      // (e.g. "5537-2S -Base 28 GD8371-02") and NOT just the bare
      // model ("5540"). The sewing operator needs to see the variant
      // marker so they know WHICH compartment of the sofa they're
      // assembling.
      const stickerWipName =
        activeTab === "FAB_SEW" && row.wipType === "BASE"
          ? row.productCode || row.model || row.wip || ""
          : row.wip;
      for (let p = 1; p <= pieceCount; p++) {
        stickers.push({
          key: pieceCount > 1 ? `${row.id}:${p}` : row.id,
          poNo: order.poNo,
          deptCode: activeTab,
          jobCardId: opId,
          wipName: stickerWipName,
          wipCode: "",
          sizeLabel: row.size || "",
          qty: displayQty,
          customerPOId: row.customerPOId || "",
          customerState: row.customerState || "",
          customerName: row.customerName || "",
          customerRef: row.customerRef || "",
          salesOrderNo: row.salesOrderNo || "",
          model: row.model || "",
          wipType: row.wipType || "",
          category: row.category || "",
          colour: row.colour || "",
          gap: row.gap || "",
          divan: row.divan || "",
          leg: row.leg || "",
          totalHeight: row.totalHeight || "",
          specialOrder: row.specialOrder || "",
          pieceNo: p,
          totalPieces: pieceCount,
          qrPayload: generateStickerData(
            order.poNo,
            activeTab,
            opId,
            "/worker/scan",
            pieceCount > 1 ? p : undefined,
            pieceCount > 1 ? pieceCount : undefined,
          ),
        });
      }
    }
    return stickers;
  }, [filteredOrders, activeTab, wipNameFor, deptRows, gridFilteredDeptRows]);

  // Build + trigger batch print for job-card stickers. Fires once state is
  // rendered into the hidden container via the useEffect below.
  const handlePrintJobCardStickers = useCallback(async () => {
    if (onScreenStickers.length === 0) {
      toast.info(
        activeTab === "ALL"
          ? "No job-card stickers to print. Upholstery & Packing use FG Stickers instead."
          : "No job cards in the current filter.",
      );
      return;
    }
    // Guard-rail for accidental mega-prints.
    if (onScreenStickers.length > 500) {
      const ok = window.confirm(
        `This will print ${onScreenStickers.length} job card stickers (${onScreenStickers.length} pages of 50×75 mm). Continue?`,
      );
      if (!ok) return;
    }
    setPrintingJobCards(true);
    try {
      // Re-generate every QR locally so the print preview doesn't depend on
      // hundreds of external HTTP calls loading in the 300 ms print timeout.
      const batch: JobCardSticker[] = await Promise.all(
        onScreenStickers.map(async (s) => ({
          ...s,
          qrDataUrl: await getQRCodeDataURL(s.qrPayload, 300),
        })),
      );
      setFgStickers([]); // never mix modes in one print job
      setJobCardStickers(batch);
    } finally {
      setPrintingJobCards(false);
    }
  }, [onScreenStickers, activeTab, toast]);

  // Race-guard token — incremented on every loadFgStickers call so a slow
  // earlier fetch can't OVERWRITE a faster newer one. When user changes a
  // filter while the previous load is still in flight, the old fetch
  // completes after the new one (returning stale, wrong-category data)
  // and was clobbering the correct result. Bumping a ref-counter and
  // checking it against the snapshot at finish-time discards stale writes.
  const fgLoadVersion = useRef(0);
  // Populate `fgStickers` state without firing window.print(). Used in two
  // places: (1) auto-fired on entry to UPHOLSTERY/PACKING tabs so the preview
  // tiles render, (2) called by `handlePrintFgStickers` which then flips
  // `fgPrintRequested` to trigger the print useEffect.
  //
  // Returns the populated list (also stored in state) so callers can short-
  // circuit if nothing came back. Silent — no alerts.
  const loadFgStickers = useCallback(async (): Promise<FgSticker[]> => {
    const myVersion = ++fgLoadVersion.current;
    if (filteredOrders.length === 0) {
      if (myVersion === fgLoadVersion.current) setFgStickers([]);
      return [];
    }
    // Match what the Production Sheet shows above. The grid does its
    // own search + per-column filter on top of the page-level filters
    // (filteredOrders). Without this scoping the FG preview balloons
    // to "125 units" while the sheet only shows 11 rows. Pull the
    // visible PO ids from gridFilteredDeptRows (which the DataGrid
    // mirrors via setGridFilteredDeptRows on every filter/sort).
    const visiblePoIds = gridFilteredDeptRows
      ? new Set(gridFilteredDeptRows.map((r) => r.poId))
      : null;
    const ordersToProcess = visiblePoIds
      ? filteredOrders.filter((o) => visiblePoIds.has(o.id))
      : filteredOrders;
    if (ordersToProcess.length === 0) {
      if (myVersion === fgLoadVersion.current) setFgStickers([]);
      return [];
    }
    type ProductMini = {
      id: string; code: string;
      skuCode?: string; sizeCode?: string; fabricColor?: string;
      pieces?: { count: number; names: string[] };
    };
    type FGUnitMini = {
      id: string; unitSerial: string; shortCode: string;
      poId: string; poNo: string;
      productCode: string; productName: string;
      unitNo: number; totalUnits: number;
      pieceNo: number; totalPieces: number; pieceName: string;
      customerName: string; customerHub?: string;
      mfdDate: string | null;
    };

    // Pre-fetch sales_orders for unique salesOrderIds in this batch — we
    // need sales_orders.customerSO (the customer's own SO number, distinct
    // from companySOId). Used on bedframe stickers per Wei Siang spec.
    // production_orders does not carry customerSO so we fetch SOs directly.
    const uniqueSoIds = Array.from(
      new Set(ordersToProcess.map((o) => o.salesOrderId).filter(Boolean)),
    );
    const customerSOBySo = new Map<string, string>();
    await Promise.all(
      uniqueSoIds.map(async (id) => {
        try {
          const r = await fetch(`/api/sales-orders/${encodeURIComponent(id)}`);
          const j = (await r.json().catch(() => null)) as
            | { success?: boolean; data?: { customerSO?: string | null } }
            | null;
          if (j?.success && j.data) {
            customerSOBySo.set(id, j.data.customerSO || "");
          }
        } catch {
          // tolerate single-fetch failure — sticker just shows "—"
        }
      }),
    );
    // Sofa legs <= 1" sit inside the compartment box (no separate pack).
    // Anything taller (>= 2") gets its own pack, PHYSICALLY placed
    // inside Compartment 1 of the SO and labelled with a 2-in-1 sticker
    // shared with Compartment 1. Wei Siang 2026-05-14 clarification:
    // the合成 (composite) logic is REQUIRED — the leg should not
    // print as its own physical sticker, but it also shouldn't
    // disappear. It goes ON the Compartment 1 sticker as a paired
    // secondary section (legsPair → comboPairKey machinery below).
    const LEG_PACK_THRESHOLD_INCHES = 1;

    // Mirror of joinModelLabel from src/api/routes/_shared/production-builder.ts:
    // join multiple sofa productCodes into a single composite "fullcompartment"
    // string with shared-prefix stripping. Preserves order + duplicates so the
    // packer sees every component on the sticker.
    //   ["5530-1A(LHF)", "5530-1NA", "5530-1A(RHF)"]
    //     → "5530-1A(LHF)+1NA+1A(RHF)"
    const joinModelLabel = (codes: string[]): string => {
      const all = codes.filter(Boolean);
      if (all.length === 0) return "";
      if (all.length === 1) return all[0];
      const firstDash = all[0].indexOf("-");
      if (firstDash > 0) {
        const prefix = all[0].slice(0, firstDash + 1);
        if (all.every((m) => m.startsWith(prefix))) {
          return prefix + all.map((m) => m.slice(prefix.length)).join("+");
        }
      }
      return all.join("+");
    };

    const all: FgSticker[] = [];
    setLoadingFgPreview(true);
    try {
      for (const o of ordersToProcess) {
        const [gRes, pRes] = await Promise.all([
          fetch(`/api/fg-units/generate/${encodeURIComponent(o.id)}`, { method: "POST" })
            .then((r) => r.json() as Promise<{ success?: boolean; data?: FGUnitMini[] }>),
          fetch(`/api/products/${encodeURIComponent(o.productId)}`)
            .then((r) => r.json() as Promise<{ success?: boolean; data?: ProductMini }>)
            .catch(() => null),
        ]);
        const units: FGUnitMini[] = gRes?.success ? (gRes.data ?? []) : [];
        const p: ProductMini | undefined = pRes?.success ? pRes.data : undefined;
        for (const u of units) {
          all.push({
            key: u.id,
            unitSerial: u.unitSerial,
            shortCode: u.shortCode,
            poNo: u.poNo,
            poId: u.poId,
            productName: u.productName,
            productCode: u.productCode,
            sku: p?.skuCode || u.productCode,
            sizeLabel: p?.sizeCode || o.sizeLabel || o.sizeCode || "",
            // Wei Siang 2026-05-15: SOFA stickers need BOTH the variant
            // code ("1A(LHF)" — kept on the Size row above) AND the
            // SEAT size (depth in inches, e.g. "28"). The seat size
            // lives on the SO line's sizeLabel — kv_config.sofaSizes
            // dropdown bare numerics (sales-orders.ts L1500-1504).
            // Empty for non-sofa categories.
            seatSize: o.itemCategory === "SOFA" ? (o.sizeLabel || o.sizeCode || "") : "",
            fabricCode: o.fabricCode || "",
            fabricColor: p?.fabricColor || o.fabricCode || "",
            customerName: u.customerName || o.customerName || "",
            customerHub: u.customerHub || "",
            // CO-aware + line-suffix: For BEDFRAME / ACCESSORY use the
            // FG unit's poNo which IS the line-suffixed PO id (e.g.
            // "CO-2605-007-01" / "SO-2604-218-01"). For SOFA fall back
            // to the parent SO/CO id (no line suffix) because a sofa
            // SET spans multiple variant-POs and the parent id is
            // what identifies the set. Wei Siang 2026-05-15:
            // "consignment order 也是要 show consignment order 出来".
            salesOrderNo:
              o.itemCategory === "SOFA"
                ? (o.salesOrderNo || o.companySOId || o.companyCOId || u.poNo || "")
                : (u.poNo || o.salesOrderNo || o.companySOId || o.companyCOId || ""),
            // SO id used by aggregateSofaStickers to group sofa POs of
            // the same SO so pieceNo / totalPieces span the whole SO.
            salesOrderId: o.salesOrderId || o.consignmentOrderId || "",
            pieceNo: u.pieceNo,
            totalPieces: u.totalPieces,
            pieceName: u.pieceName,
            unitNo: u.unitNo,
            totalUnits: u.totalUnits,
            mfdDate: u.mfdDate,
            itemCategory: (o.itemCategory as "BEDFRAME" | "SOFA" | "ACCESSORY" | undefined),
            legHeightInches: o.legHeightInches ?? null,
            divanHeightInches: o.divanHeightInches ?? null,
            gapInches: o.gapInches ?? null,
            specialOrder: o.specialOrder ?? "",
            customerPOId: o.customerPOId ?? "",
            customerRef: o.customerReference ?? "",
            customerSO: customerSOBySo.get(o.salesOrderId) ?? "",
          });
        }
      }
    } catch (err) {
      console.error("[loadFgStickers] failed", err);
      setLoadingFgPreview(false);
      return [];
    }
    // SO-level sofa pack aggregation. Sofa pack count is computed across
    // every sofa PO in the same SO (not per PO). Within a sofa SO we also:
    //   - Inject a synthetic Legs sticker as 2-in-1 with Compartment 1
    //     when any sofa line has legs > LEG_PACK_THRESHOLD_INCHES.
    //   - Pull the SO's pillow stickers (ACCESSORY POs whose productName
    //     contains "pillow") out of nonSofa and append them as the LAST
    //     pack — last sofa compartment becomes 2-in-1 with the pillow.
    // The pillow is its own real fg_unit (not synthetic like legs) so its
    // QR scans normally; it just gets renumbered + paired into the
    // compartment chain.
    const isPillowSticker = (s: FgSticker): boolean =>
      s.itemCategory === "ACCESSORY" &&
      /pillow/i.test(s.productName + " " + s.productCode);

    const sofaBySo = new Map<string, FgSticker[]>();
    const pillowsBySo = new Map<string, FgSticker[]>();
    const nonSofa: FgSticker[] = [];
    for (const s of all) {
      if (s.itemCategory === "SOFA" && s.salesOrderId) {
        const list = sofaBySo.get(s.salesOrderId) ?? [];
        list.push(s);
        sofaBySo.set(s.salesOrderId, list);
      } else if (isPillowSticker(s) && s.salesOrderId) {
        const list = pillowsBySo.get(s.salesOrderId) ?? [];
        list.push(s);
        pillowsBySo.set(s.salesOrderId, list);
      } else {
        nonSofa.push(s);
      }
    }
    // Pillows belonging to a SO that has NO sofa go back into nonSofa
    // (they print as standalone 1/1 stickers, no aggregation).
    for (const [soId, pillows] of pillowsBySo) {
      if (!sofaBySo.has(soId)) {
        nonSofa.push(...pillows);
        pillowsBySo.delete(soId);
      }
    }

    // Bedframe boxLabel — matches Production Sheet's WIP column format.
    //   Full bedframe (HB + Divan):
    //     HB box    → "{productCode}-HB{totalH}\""    e.g. "1005-(Q)-HB22\""
    //     Divan box → "{divanH}\" Divan-{sizeLabel}"  e.g. "8\" Divan-6FT"
    //   Divan-only (productCode starts "DIVAN"):
    //     ALL boxes are Divan boxes, no HB.
    //   totalH = gapInches + divanHeightInches + legHeightInches
    for (const s of nonSofa) {
      if (s.itemCategory === "BEDFRAME") {
        const parts = [s.sizeLabel, s.fabricCode].filter(Boolean);
        s.wipLabel = parts.join(" | ");
        const isDivanOnly = (s.productCode || "").toUpperCase().startsWith("DIVAN");
        // Divan-only: every box is a Divan. Full BF: pieceNo 1 = HB, rest = Divan.
        if (!isDivanOnly && s.pieceNo === 1) {
          const totalH = (s.gapInches ?? 0) + (s.divanHeightInches ?? 0) + (s.legHeightInches ?? 0);
          s.boxLabel = totalH > 0
            ? `${s.productCode}-HB${totalH}"`
            : `${s.productCode}-HB`;
          s.pieceName = "HB";
        } else {
          const divanH = s.divanHeightInches != null ? `${s.divanHeightInches}"` : "";
          const sizeLbl = s.sizeLabel || "";
          s.boxLabel = divanH && sizeLbl
            ? `${divanH} Divan-${sizeLbl}`
            : `${divanH || sizeLbl} Divan`.trim() || (s.productCode + " Divan");
          s.pieceName = "Divan";
        }
      }
    }

    const aggregated: FgSticker[] = [...nonSofa];
    for (const [soId, group] of sofaBySo) {
      // Deterministic order so renumbering is stable across loads.
      group.sort((a, b) =>
        a.poNo.localeCompare(b.poNo) ||
        a.unitNo - b.unitNo ||
        a.pieceNo - b.pieceNo,
      );
      // Wei Siang 2026-05-14 clarified the leg behaviour: KEEP the
      // synthetic leg sticker (so the piece count is correct, e.g.
      // 4/4 for "3 sofa + 1 leg"), but RENDER it as a 2-in-1 with
      // Compartment 1's physical card — never as a standalone fourth
      // page. The comboPairKey + pair-lookup below already implements
      // the 2-in-1 visual; just hasLegs needs to track real legs
      // again so the legs sticker actually gets generated.
      const hasLegs = group.some(
        (s) => (s.legHeightInches ?? 0) > LEG_PACK_THRESHOLD_INCHES,
      );
      const rawPillows = pillowsBySo.get(soId) ?? [];
      // Group pillows by productCode so the badge shows
      // "Square Pillow x3" instead of producing 3 separate stickers.
      // Each group → 1 representative sticker (uses the first fg_unit's
      // QR; others are dropped from rendering).
      const pillowGroups = new Map<string, FgSticker[]>();
      for (const p of rawPillows) {
        const k = p.productCode || p.productName || "PILLOW";
        const list = pillowGroups.get(k) ?? [];
        list.push(p);
        pillowGroups.set(k, list);
      }
      const hasPillow = pillowGroups.size > 0;
      const compartmentCount = group.length;
      const totalPacks =
        compartmentCount + (hasLegs ? 1 : 0) + pillowGroups.size;

      // Sofa fullCompartment label — joined productCodes of every sofa PO
      // in the SO (preserving order + duplicates) with shared-prefix
      // stripping. Same string lives on every compartment sticker so the
      // packer sees the full sofa config on each box.
      const fullCompartment = joinModelLabel(group.map((s) => s.productCode));
      // Sofa legs summary — distinct heights across the SO. Usually one
      // height; multi-height SOs surface all values.
      const legHeights = Array.from(
        new Set(
          group
            .map((s) => s.legHeightInches)
            .filter((h): h is number => h !== null && h !== undefined && h > 0),
        ),
      ).sort((a, b) => a - b);
      const legsInfo =
        legHeights.length === 0
          ? ""
          : legHeights.map((h) => `${h}"`).join(", ");

      // Renumber sofa compartments. Wei Siang spec 2026-05-10:
      //   Sofas: 1, 2, ..., N (in SO line order)
      //   Leg (if any): N+1 (after ALL sofas, not position 2)
      //   Pillow (if any): N+2 (after leg) — or N+1 if no leg
      // Physical 2合1 pairings unchanged: Leg shares Compartment 1's
      // box, Pillow shares the LAST compartment's box.
      group.forEach((s, idx) => {
        s.pieceNo = idx + 1;
        s.totalPieces = totalPacks;
        s.wipLabel = fullCompartment;
        // boxLabel = SO-wide joined fullCompartment so the WIP body
        // line is meaningfully DIFFERENT from the productCode header.
        // (Listing format = productCode but that duplicates the header
        // — packer wants to see all sibling components on the sticker.)
        s.boxLabel = fullCompartment;
        s.pieceName = "sofa";
        if (legsInfo) s.legsInfo = legsInfo;
      });

      // Build the output in pieceNo order:
      //   Sofas 1..N (in SO line order)
      //   Leg at N+1 (if any) — physically 2合1 with Compartment 1
      //   Pillows at N+1+i (or N+2 with leg, etc) — first pillow 2合1
      //     with the LAST sofa compartment
      // Pairing direction: secondary.comboPairKey → primary. The
      // render-time lookup walks the sticker list and finds any
      // secondary whose comboPairKey points back to a given primary,
      // so primary cards display their paired secondary inline.
      const compartment1 = group[0];
      const lastCompartment = group[group.length - 1];

      const outputForSo: FgSticker[] = [];
      // Sofas first, in order
      outputForSo.push(...group);
      // Leg (after all sofas, position N+1)
      if (hasLegs) {
        const legsKey = `legs-${compartment1.salesOrderId}`;
        const legBadge = legsInfo ? `${legsInfo} leg` : "leg";
        const legsSticker: FgSticker = {
          ...compartment1,
          key: legsKey,
          unitSerial: `${compartment1.salesOrderNo || compartment1.salesOrderId}-LEGS`,
          shortCode: "LEGS",
          pieceNo: compartmentCount + 1,
          totalPieces: totalPacks,
          pieceName: legBadge,
          boxLabel: fullCompartment,
          isSyntheticLegs: true,
          comboPairKey: compartment1.key,
          wipLabel: fullCompartment,
          legsInfo: legsInfo || compartment1.legsInfo,
        };
        outputForSo.push(legsSticker);
      }
      // Pillows (after leg, last)
      if (hasPillow) {
        const legShift = hasLegs ? 1 : 0;
        let pillowIdx = 0;
        for (const [, pillowGroup] of pillowGroups) {
          const rep = pillowGroup[0];
          const qty = pillowGroup.length;
          const name = rep.productName || rep.productCode || "Pillow";
          // Include fabric color so packers see "Square Pillow KN390-2 x3"
          // instead of just "Square Pillow x3" — color is what differentiates
          // pillow groups within the same SO.
          const fabric = rep.fabricCode ? ` ${rep.fabricCode}` : "";
          const labelWithFabric = `${name}${fabric} x${qty}`;
          rep.pieceNo = compartmentCount + legShift + 1 + pillowIdx;
          rep.totalPieces = totalPacks;
          rep.wipLabel = fullCompartment;
          rep.boxLabel = labelWithFabric;
          rep.pieceName = labelWithFabric;
          if (pillowIdx === 0) {
            rep.comboPairKey = lastCompartment.key;
            rep.isSyntheticPillow = true;
          }
          outputForSo.push(rep);
          pillowIdx++;
        }
      }

      aggregated.push(...outputForSo);
    }

    // Guard: only commit if no newer load has started. Prevents the
    // stale-overwrite race when filters change mid-fetch.
    if (myVersion !== fgLoadVersion.current) return aggregated;
    setJobCardStickers([]);
    setFgStickers(aggregated);
    setLoadingFgPreview(false);
    return aggregated;
  }, [filteredOrders, gridFilteredDeptRows]);

  const handlePrintFgStickers = useCallback(async () => {
    if (filteredOrders.length === 0) {
      toast.info("No orders in the current filter.");
      return;
    }
    // If tiles already populated (auto-loaded on tab entry), print directly.
    // Otherwise fetch first, then request print.
    const list = fgStickers.length > 0 ? fgStickers : await loadFgStickers();
    if (list.length === 0) {
      toast.info("No FG units to print.");
      return;
    }
    setFgPrintRequested(true);
  }, [filteredOrders, fgStickers, loadFgStickers, toast]);

  // Grid-filter scoped FG stickers — single source of truth shared by the
  // on-screen FG preview tiles AND the hidden print container, so what the
  // operator sees printed matches what the grid filter shows. Without this
  // shared predicate, filtering "WIP contains Divan" would still print the
  // HB sticker because the print loop iterated raw `fgStickers` (Wei Siang
  // report 2026-05-10).
  const visibleFgStickers = useMemo<FgSticker[]>(() => {
    const visibleRowsForKey =
      (gridFilteredDeptRows as unknown as DeptRow[] | null) ?? deptRows;
    const visiblePoIds = new Set(visibleRowsForKey.map((r) => r.poId));
    const visibleBfKeys = new Set<string>();
    for (const r of visibleRowsForKey) {
      if (r.category === "BEDFRAME") {
        visibleBfKeys.add(`${r.poId}::${r.wipType}`);
      }
    }
    return fgStickers.filter((s) => {
      if (!visiblePoIds.has(s.poId)) return false;
      if (s.itemCategory === "BEDFRAME") {
        const t =
          s.pieceName === "HB" ? "HB" :
          s.pieceName === "Divan" ? "DIVAN" :
          "";
        return t === "" || visibleBfKeys.has(`${s.poId}::${t}`);
      }
      return true;
    });
  }, [fgStickers, gridFilteredDeptRows, deptRows]);

  // Lazy-load the FG sticker tiles. Mirrors the job-card sticker flow on
  // every other dept tab, where `jobCardStickers` is empty until the
  // operator clicks Print All — tab entry stays cheap, and we only pay
  // the load + render cost when the operator actually wants to see or
  // print stickers (Wei Siang 2026-05-10: "为了防止页面卡顿, 默认都是先
  // 隐藏着的, 只有当我点击 Show All 的时候内容才会显示出来"). Two triggers:
  //   1. Operator clicks Show QR → setShowFgPreview(true) → load + render
  //      visible tiles.
  //   2. Operator clicks Print All → setFgPrintRequested(true) →
  //      handlePrintFgStickers loads if needed then triggers print.
  // While the preview is open, re-load whenever the grid filter changes
  // so the tile set tracks what the operator sees in the sheet above.
  // Other tabs always clear so the hidden print container can't carry
  // stale data into a job-card print job.
  /* eslint-disable react-hooks/set-state-in-effect -- on-demand FG load + tab-leave cleanup */
  useEffect(() => {
    if (activeTab !== "UPHOLSTERY" && activeTab !== "PACKING") {
      setFgStickers([]);
      return;
    }
    // Only load when the operator has signalled intent — clicking Show QR
    // or Print All. Without these gates, every Packing tab entry was
    // firing a full /api/fg-units sweep + sales-orders fan-out + the
    // aggregator pass over hundreds of pieces, which the operator felt
    // as page lag even though the visible preview was collapsed.
    if (!showFgPreview && !fgPrintRequested) return;
    // Same race-condition guard as before: wait for the DataGrid to
    // report its filtered rows so the load matches what's on screen.
    if (gridFilteredDeptRows === null) return;
    loadFgStickers();
  }, [
    activeTab,
    showFgPreview,
    fgPrintRequested,
    gridFilteredDeptRows,
    loadFgStickers,
  ]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Once the batch container is rendered, fire the print dialog. Small
  // timeout lets React paint the hidden container first; QR images are
  // external URLs but that's OK — the dialog waits for them to load.
  // P4.3 final: replaced raw setTimeout-in-effect with useTimeout, which
  // pauses on document.hidden and auto-clears on unmount. The inner
  // post-print cleanup is intentionally still raw — it fires from inside
  // the print() callback, not from a React lifecycle, so the hook would
  // need an extra state pair to express it.
  useTimeout(
    () => {
      window.print();
      // Clear after print dialog closes. onafterprint isn't universally
      // reliable; a follow-up timeout keeps state clean either way.
      // eslint-disable-next-line no-restricted-syntax -- one-shot post-print state cleanup, fires from print callback
      setTimeout(() => setJobCardStickers([]), 500);
    },
    jobCardStickers.length === 0 ? null : 300,
  );

  useTimeout(
    () => {
      // Use the grid-filter scoped count — when the operator narrows the
      // PACKING grid down to nothing, Print All shouldn't fire window.print()
      // against an empty `#batch-fg-print` container.
      if (visibleFgStickers.length === 0) {
        setFgPrintRequested(false);
        return;
      }
      window.print();
      // Don't clear fgStickers here anymore — the on-screen preview on UPH/
      // PACK tabs depends on that state. Reset just the print-requested flag.
      // eslint-disable-next-line no-restricted-syntax -- one-shot post-print state cleanup, fires from print callback
      setTimeout(() => setFgPrintRequested(false), 500);
    },
    // 1500ms — gives the eager <QRImg> tree time to generate all QR data
    // URLs before window.print() fires. Pre-2026-05-12 this was 300ms
    // under the (incorrect) assumption that mounting the tree inside the
    // hidden print container would let IntersectionObserver kick off QR
    // generation. The observer never fires for `display: none` parents,
    // so the QRs would stay as gray placeholders → operator-reported
    // blank/broken FG sticker prints. The `eager` flag on the print-only
    // <QRImg> instances below skips the observer; this bumped delay
    // accommodates ~100 sequential 500px QR generations (~10-30ms each).
    fgPrintRequested ? 1500 : null,
  );

  // Print the current filtered schedule as an A4 landscape listing. Opens
  // a new window populated with inline HTML + @page size:A4 landscape so
  // the user can Cmd/Ctrl+P → Save PDF or send straight to printer. The
  // layout mirrors what's on screen: Overview → matrix across 8 depts,
  // dept sub-tab → Production Sheet rows with prev-dept pills.
  // Sync each PO's job_cards set with its CURRENT BOM template. Idempotent:
  // only INSERTs missing (wipKey, deptCode) pairs — never touches existing
  // JC dueDate / status. Fixes the class of bug where a BOM gets edited
  // after POs were already created (sofa UPH/PKG, FAB_CUT missing on
  // 5536-CSL / 5537-STOOL, etc.) without needing another ad-hoc migration.
  const _handleSyncJobCardsFromBom = useCallback(async () => {
    const ok = window.confirm(
      "Sync Job Cards from BOM?\n\n" +
        "This scans every production order and inserts any job cards that the current BOM expects but the PO is missing. " +
        "Existing job cards (dueDate, status, PIC) are NOT modified.\n\n" +
        "Proceed?",
    );
    if (!ok) return;
    try {
      const res = await fetch("/api/production/sync-jobcards-from-bom", {
        method: "POST",
        credentials: "include",
      });
      const json = (await res.json()) as {
        success?: boolean;
        scannedPOs?: number;
        createdJCs?: number;
        error?: string;
      };
      if (!res.ok || !json.success) {
        toast.error(`Sync failed: ${json.error || res.statusText}`);
        return;
      }
      const scanned = json.scannedPOs ?? 0;
      const created = json.createdJCs ?? 0;
      toast.success(`Created ${created} job cards across ${scanned} orders`);
      invalidateCachePrefix("/api/production-orders");
      invalidateCachePrefix("/api/job-cards");
    } catch (err) {
      toast.error(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [toast]);

  const handlePrintSchedule = useCallback(() => {
    const today = new Date().toLocaleDateString("en-MY", {
      year: "numeric", month: "short", day: "numeric",
    });
    const fmt = (iso: string) => {
      if (!iso) return "";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      return `${d.getDate()} ${d.toLocaleString("en-US", { month: "short" })}`;
    };
    // Page-level filter bits. Grid-level column filters (Status: WAITING,
    // Product Code contains "1005", etc.) are appended later inside the
    // dept branch where the grid filter store key is computed. filterLine
    // itself is built after the body branch so it can include both
    // page-level and grid-level chips (operator report 2026-05-13 —
    // "filter status waiting的 product code啊等等 全部都要 show 出来").
    const filterBits: string[] = [];
    if (fltSearch) filterBits.push(`Search: "${fltSearch}"`);
    if (fltCustomer) filterBits.push(`Customer: ${fltCustomer}`);
    if (fltState) filterBits.push(`State: ${fltState}`);
    if (fltCategory) {
      const catLabel =
        fltCategory === "ACCESSORY" ? "Accessories" :
        fltCategory === "BEDFRAME" ? "Bedframe" :
        fltCategory === "SOFA" ? "Sofa" :
        fltCategory;
      filterBits.push(`Category: ${catLabel}`);
    }
    if (fltDueFrom || fltDueTo) {
      filterBits.push(`Due: ${fltDueFrom || "…"} → ${fltDueTo || "…"}`);
    }
    if (incompleteOnly) {
      filterBits.push("Incomplete only");
    }

    const title =
      activeTab === "ALL" ? "Production Schedule — Overview" : `Production Schedule — ${activeDept?.name}`;

    const cellClass = (state: CellState) =>
      state === "done" ? "done" :
      state === "overdue" ? "overdue" :
      state === "pending" ? "pending" : "empty";

    let body = "";
    let columnCount = 0;
    // Total production minutes across the printed scope — printed as a
    // footer line ("Total Production Time: 1,180 min (19.7 h)") so the
    // operator can size a shift / capacity against the schedule at a
    // glance. Computed per branch because Overview reads visibleOrders'
    // jobCards directly while Dept already has the per-jc total
    // (DeptRow.prodTime = productionTimeMinutes × wipQty) materialised.
    let totalProdMinutes = 0;
    if (activeTab === "ALL") {
      // Overview matrix: one row per filtered order × 8 dept columns.
      for (const o of visibleOrders) {
        for (const jc of o.jobCards || []) {
          const perUnit = Number(jc.productionTimeMinutes) || Number(jc.estMinutes) || 0;
          const wipQty = (jc as JobCard & { wipQty?: number }).wipQty ?? 1;
          totalProdMinutes += perUnit * (wipQty || 1);
        }
      }
      const rowsHtml = visibleOrders.map((o) => {
        const cells = DEPARTMENTS.map((d) => {
          const c = cellFor(o, d.code, visibleOrders);
          if (c.state === "empty") return `<td class="m empty"></td>`;
          if (c.state === "done") {
            return `<td class="m done">✓<br/><small>${fmt(c.latestCompleted || c.earliestDue)}</small></td>`;
          }
          return `<td class="m ${cellClass(c.state)}"><b>${c.doneCards}/${c.totalCards}</b><br/><small>${fmt(c.earliestDue)}</small></td>`;
        }).join("");
        const details: string[] = [];
        if (o.fabricCode) details.push(o.fabricCode);
        if (o.sizeLabel) details.push(o.sizeLabel);
        if (o.divanHeightInches != null) details.push(`DV ${o.divanHeightInches}"`);
        if (o.legHeightInches != null) details.push(`LG ${o.legHeightInches}"`);
        if (o.gapInches != null) details.push(`GP ${o.gapInches}"`);
        return `<tr>
          <td class="so">${o.poNo || ""}</td>
          <td class="prod"><b>${o.productCode || ""}</b><br/><small>${details.join(" · ")}</small></td>
          <td>${o.customerName || ""}</td>
          <td class="num">${o.quantity || ""}</td>
          <td>${fmt(o.targetEndDate)}</td>
          ${cells}
        </tr>`;
      }).join("");
      body = `
        <table class="schedule">
          <thead>
            <tr>
              <th>SO ID</th>
              <th>Product</th>
              <th>Customer</th>
              <th class="num">Qty</th>
              <th>Due</th>
              ${DEPARTMENTS.map((d) => `<th class="m">${d.name}</th>`).join("")}
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>`;
      // 5 fixed columns (SO ID, Product, Customer, Qty, Due) + 8 dept matrix columns.
      columnCount = 5 + DEPARTMENTS.length;
    } else {
      // Dept sub-tab: print template mirrors the on-screen Production Sheet
      // columns 1:1 so the operator sees the same data on paper. Trimmed to
      // fit A4 landscape without overflow.
      // Source rows: when the DataGrid has handed us its post-sort +
      // post-filter mirror (gridFilteredDeptRows), use it directly — it
      // preserves the column sort the operator clicked in the grid. Only
      // fall back to raw deptRows when the mirror hasn't been populated
      // yet (first render, before the grid's onFilteredDataChange fires).
      //
      // Then re-apply the PER-ROW Due-date filter (page-level
      // fltDueFrom/fltDueTo): the PO-level filter uses find(), which lets
      // a row through whenever ANY JC of its PO is in range — so the
      // CUSHION row of a 19-May-due PO leaks in even when the BASE JC is
      // 28-Apr. Filtering again per-row removes those stragglers.
      const baseRows =
        (gridFilteredDeptRows as unknown as DeptRow[] | null) ?? deptRows;
      const printRows = baseRows.filter((r) => {
        if (fltDueFrom && r.dueDate && r.dueDate < fltDueFrom) return false;
        if (fltDueTo && r.dueDate && r.dueDate > fltDueTo) return false;
        return true;
      });
      // Sum the per-jc prodTime (productionTimeMinutes × wipQty) on the
      // dept rows we're actually printing. Mirrors the on-screen Total
      // footer at line 5292+ so the printed total matches what the
      // operator sees above when they hit Print.
      totalProdMinutes = printRows.reduce(
        (s, r) => s + (Number(r.prodTime) || 0),
        0,
      );
      // ---- Dynamic column resolution: print whatever the user has visible ----
      // Read the user's column visibility + order from localStorage (same
      // keys the DataGrid writes to). Falls back to defaultHidden=false
      // columns if no personal layout is saved yet. Print template now
      // mirrors the on-screen sheet 1:1 — toggle a column off in the UI,
      // it disappears from the printout.
      const gridId = `production-dept-${activeTab.toLowerCase()}`;
      // Match data-grid.tsx userKey() — same fallback to "anon".
      const userEmailLc = (() => {
        try {
          const u = getCurrentUser();
          return u?.email ? u.email.toLowerCase() : "anon";
        } catch { return "anon"; }
      })();
      const readJson = (key: string): unknown => {
        try {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : null;
        } catch { return null; }
      };

      // Pull the DataGrid's column filters / value-filter checkbox state /
      // grid search out of sessionStorage so the printout's "Filters —"
      // header lists what the operator is ACTUALLY looking at — not just
      // the page-level filter bar at the top. Storage key + payload
      // shape mirror data-grid.tsx filterStoreKey + the JSON it writes
      // there (line 1080+ in that file). Reading errors are swallowed
      // intentionally: a parse / quota failure should never block a print.
      try {
        const filterStoreKey = `datagrid-filters-${gridId}-${userEmailLc}`;
        const raw = sessionStorage.getItem(filterStoreKey);
        if (raw) {
          const parsed = JSON.parse(raw) as {
            searchText?: string;
            columnFilters?: Record<string, string>;
            columnValueFilters?: Record<string, string[]>;
          };
          const colLabel = new Map(deptColumns.map((c) => [c.key, c.label]));
          if (parsed.searchText) {
            filterBits.push(`Grid search: "${parsed.searchText}"`);
          }
          for (const [key, val] of Object.entries(parsed.columnFilters ?? {})) {
            if (val) filterBits.push(`${colLabel.get(key) ?? key}: ${val}`);
          }
          for (const [key, vals] of Object.entries(parsed.columnValueFilters ?? {})) {
            if (Array.isArray(vals) && vals.length > 0) {
              filterBits.push(`${colLabel.get(key) ?? key}: ${vals.join(", ")}`);
            }
          }
        }
      } catch { /* ignore — don't block print on storage errors */ }
      const visibleSetRaw =
        readJson(`datagrid-cols-${gridId}-${userEmailLc}`) ??
        readJson(`datagrid-cols-${gridId}-org-default`);
      const visibleSet = Array.isArray(visibleSetRaw)
        ? new Set<string>(visibleSetRaw as string[])
        : new Set<string>(deptColumns.filter((c) => !c.hidden && !c.defaultHidden).map((c) => c.key));
      const orderRaw =
        readJson(`datagrid-colorder-${gridId}-${userEmailLc}`) ??
        readJson(`datagrid-colorder-${gridId}-org-default`);
      const order: string[] = Array.isArray(orderRaw)
        ? (orderRaw as string[])
        : deptColumns.map((c) => c.key);
      const orderedColumns = order
        .map((k) => deptColumns.find((c) => c.key === k))
        .filter((c): c is Column<DeptRow> => !!c && !c.hidden && visibleSet.has(c.key));

      // Per-column HTML renderer for the print export. Given (column, row)
      // returns the inner cell HTML. Special-cases the few columns that
      // need formatting (dept pill, due, completion, PIC, sticker
      // badges); everything else falls through to the row's plain value.
      const escapeHtml = (s: string) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const renderPillFor = (
        r: DeptRow,
        deptCode: string,
      ): string => {
        const objKey = `sched_${deptCode}` as keyof DeptRow;
        const sched = r[objKey] as DeptSched | undefined;
        if (!sched || sched.state === "none") return "—";
        const word =
          sched.state === "done" ? "DONE" :
          sched.state === "overdue" ? "OVERDUE" :
          "PENDING";
        const date = sched.state === "done"
          ? sched.completed || sched.due
          : sched.due;
        return `<span class="pill ${sched.state}">${word}${date ? " " + fmt(date) : ""}</span>`;
      };
      const renderCell = (col: Column<DeptRow>, r: DeptRow): string => {
        const key = col.key;
        // Dept pill columns — keys look like "sched_FAB_CUT.sortKey".
        const deptMatch = key.match(/^sched_([A-Z_]+)\.sortKey$/);
        if (deptMatch) return renderPillFor(r, deptMatch[1]);
        // Date columns get formatted.
        if (key === "dueDate") return fmt(r.dueDate);
        if (key === "completedDate") return fmt(r.completedDate);
        // Generic string cell. Look up the value off the row.
        const raw = (r as unknown as Record<string, unknown>)[key];
        if (raw == null || raw === "") return "";
        return escapeHtml(String(raw));
      };
      const cellClassFor = (col: Column<DeptRow>): string => {
        if (col.align === "right" || col.type === "number") return "num";
        if (col.key === "soId") return "so";
        return "";
      };
      const headerCellsHtml = orderedColumns
        .map((c) => `<th${cellClassFor(c) ? ` class="${cellClassFor(c)}"` : ""}>${escapeHtml(c.label)}</th>`)
        .join("");
      const rowsHtml = printRows.map((r) => {
        const cells = orderedColumns
          .map((c) => {
            const cls = cellClassFor(c);
            return `<td${cls ? ` class="${cls}"` : ""}>${renderCell(c, r)}</td>`;
          })
          .join("");
        return `<tr>${cells}</tr>`;
      }).join("");
      body = `
        <table class="schedule">
          <thead><tr>${headerCellsHtml}</tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>`;
      columnCount = orderedColumns.length;
    }

    // Build the final filter chip strip. Constructed AFTER the body
    // branch so grid-level column / value / search filters (appended
    // inside the dept branch above) are included alongside the
    // page-level chips collected at the top.
    const filterLine = filterBits.length
      ? `<div class="filters">Filters — ${filterBits.join(" · ")}</div>`
      : "";

    // Tier-based font/padding scaling so the printout fills A4 landscape
    // regardless of how many columns the user has visible. Few columns →
    // larger, easier-to-read text. Many columns → tighter, fits without
    // wrapping. Tiers picked empirically on A4 landscape (281mm usable
    // after 8mm margin):
    //   lg (≤6 cols)   → 10px table, 5×7 padding   — legible from arm's length
    //   md (7-9 cols)  → 8.5px table, 4×5 padding  — comfortable mid-density
    //   sm (≥10 cols)  → 7.5px table, 3×4 padding  — original, dense fit
    const tier =
      columnCount <= 6 ? "lg" :
      columnCount <= 9 ? "md" : "sm";
    const sizes = tier === "lg" ? {
      body: 11, table: 10, th: 9, small: 8.5, pill: 9,
      padY: 5, padX: 7, mWidth: 65, mPad: 3,
      filters: 9, footer: 8, brand: 16, brandSmall: 8, metaT: 11.5, meta: 9,
    } : tier === "md" ? {
      body: 9.5, table: 8.5, th: 8, small: 7.5, pill: 8,
      padY: 4, padX: 5, mWidth: 60, mPad: 2.5,
      filters: 8, footer: 7, brand: 15, brandSmall: 7.5, metaT: 10.5, meta: 8.5,
    } : {
      body: 8.5, table: 7.5, th: 7, small: 6.5, pill: 7,
      padY: 3, padX: 4, mWidth: 55, mPad: 2,
      filters: 7.5, footer: 6.5, brand: 14, brandSmall: 7, metaT: 10, meta: 8,
    };

    const deptPrintCount = gridFilterIdSet
      ? deptRows.filter((r) => gridFilterIdSet.has(r.id)).length
      : deptRows.length;
    const rowCount = activeTab === "ALL" ? visibleOrders.length : deptPrintCount;
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    /* A4 landscape — matches on-screen listing. White-only to save ink. */
    @page { size: A4 landscape; margin: 8mm; background: #ffffff; }
    * { box-sizing: border-box; }
    html, body { background: #ffffff; }
    body {
      font-family: "Segoe UI", Helvetica, Arial, sans-serif;
      color: #000;
      font-size: ${sizes.body}px;
      margin: 0;
      padding: 0;
    }
    .header {
      display: flex; align-items: center; justify-content: space-between;
      border-bottom: 1.5px solid #000; padding-bottom: 5px; margin-bottom: 6px;
    }
    .brand {
      font-size: ${sizes.brand}px; font-weight: 700; color: #000; letter-spacing: 0.5px;
    }
    .brand small {
      display: block; font-size: ${sizes.brandSmall}px; font-weight: 500; color: #555;
      letter-spacing: 1px; text-transform: uppercase;
    }
    .meta { text-align: right; font-size: ${sizes.meta}px; color: #333; }
    .meta .t { font-size: ${sizes.metaT}px; font-weight: 700; color: #000; }
    .filters {
      margin-bottom: 4px; font-size: ${sizes.filters}px; color: #333;
      padding: 2px 5px; background: #fff; border-left: 2px solid #000;
    }
    table.schedule {
      width: 100%; border-collapse: collapse; font-size: ${sizes.table}px;
      table-layout: auto; background: #ffffff;
    }
    table.schedule th {
      background: #ffffff; color: #000; font-weight: 700;
      text-align: left; padding: ${sizes.padY}px ${sizes.padX}px; border: 0.75px solid #000;
      text-transform: uppercase; font-size: ${sizes.th}px; letter-spacing: 0.3px;
    }
    table.schedule td {
      padding: ${sizes.padY}px ${sizes.padX}px; border: 0.5px solid #333; vertical-align: middle;
      background: #ffffff; color: #000;
    }
    table.schedule td.num, table.schedule th.num { text-align: right; }
    table.schedule td.m, table.schedule th.m {
      text-align: center; width: ${sizes.mWidth}px; padding: ${sizes.mPad}px;
    }
    table.schedule td.so { font-weight: 700; white-space: nowrap; }
    table.schedule td.prod small,
    table.schedule tbody small { color: #555; font-size: ${sizes.small}px; }
    td.m.done    { background: #fff; color: #000; font-weight: 700; }
    td.m.pending { background: #fff; color: #000; font-style: italic; }
    td.m.overdue { background: #fff; color: #000; font-weight: 700; text-decoration: underline; }
    td.m.empty   { background: #fff; }
    /* Dept-pill rendering inside the dept-tab print template. Print-friendly
       (B/W) — done = bold, overdue = bold + underlined, pending = italic.
       Mirrors the screen pill semantics without colour so it stays readable
       on greyscale printers. */
    span.pill          { font-size: ${sizes.pill}px; padding: 1px 3px; white-space: nowrap; }
    span.pill.done     { font-weight: 700; }
    span.pill.overdue  { font-weight: 700; text-decoration: underline; }
    span.pill.pending  { font-style: italic; }
    tr { page-break-inside: avoid; }
    thead { display: table-header-group; }
    .totals {
      margin-top: 6px;
      padding: 4px 6px;
      font-size: ${sizes.body}px;
      font-weight: 700;
      text-align: right;
      border-top: 0.5px solid #000;
      background: #ffffff;
    }
    .totals .hours {
      font-weight: 500;
      color: #555;
      margin-left: 4px;
    }
    .footer {
      margin-top: 8px; padding-top: 3px; border-top: 0.5px solid #666;
      font-size: ${sizes.footer}px; color: #333; text-align: center;
    }
    @media print {
      .no-print { display: none !important; }
      html, body { background: #ffffff !important; }
    }
    .no-print {
      position: fixed; top: 10px; right: 10px; z-index: 1000;
    }
    .no-print button {
      background: #000; color: #fff; border: 0; padding: 8px 14px;
      border-radius: 4px; cursor: pointer; font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="no-print"><button onclick="window.print()">Print / Save as PDF</button></div>
  <div class="header">
    <div class="brand">HOOKKA<small>Furniture Manufacturing</small></div>
    <div class="meta">
      <div class="t">${title}</div>
      <div>Generated: ${today} · ${rowCount} item(s)</div>
    </div>
  </div>
  ${filterLine}
  ${body}
  ${totalProdMinutes > 0 ? `<div class="totals">Total Production Time: ${totalProdMinutes.toLocaleString()} min<span class="hours">(${(totalProdMinutes / 60).toFixed(1)} h)</span></div>` : ""}
  <div class="footer">Hookka Manufacturing ERP — Production Schedule · Printed ${today}</div>
  <script>setTimeout(function(){ window.print(); }, 300);</${''}script>
</body>
</html>`;

    const w = window.open("", "_blank", "width=1200,height=800");
    if (!w) return;
    w.document.open();
    w.document.write(html);
    w.document.close();
  }, [
    activeTab, activeDept, visibleOrders, deptRows, deptColumns,
    filteredOrders.length,
    fltSearch, fltCustomer, fltState, fltCategory, fltDueFrom, fltDueTo, incompleteOnly,
    gridFilterIdSet, gridFilteredDeptRows,
  ]);

  // "Total Listing" — sibling to handlePrintSchedule. Same filter inputs,
  // same print-window pattern, same CSS — but rows are merged so the floor
  // operator sees "make N of X" instead of one-row-per-PO/JC.
  //
  // Dept sub-tab grouping key: wip | size | colour. Model/gap/divan/leg/
  // status intentionally NOT in the key — same WIP code is the same
  // physical production unit (the variant differences are already baked
  // into the wip code itself, e.g. `8" Divan- 5FT` vs `10" Divan- 6FT`).
  // SO/customer/due also excluded — those naturally differ across merged
  // rows but the floor still makes one batch.
  //
  // Overview grouping key: productCode | sizeLabel | fabricCode. Same
  // principle: divan/leg/gap encode model variants, not separate items.
  // For per-PO progress detail, use Detailed mode.
  const handlePrintTotalListing = useCallback(() => {
    const today = new Date().toLocaleDateString("en-MY", {
      year: "numeric", month: "short", day: "numeric",
    });
    const fmt = (iso: string) => {
      if (!iso) return "";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      return `${d.getDate()} ${d.toLocaleString("en-US", { month: "short" })}`;
    };
    // Earliest non-empty ISO date string. Empty strings are skipped so
    // a row missing a due date doesn't claim "earliest" by sorting first.
    const earliestIso = (dates: string[]) => {
      const valid = dates.filter((s) => s && !isNaN(new Date(s).getTime()));
      if (!valid.length) return "";
      return valid.sort()[0]!;
    };
    const escapeHtml = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Page-level filter bits. Grid-level chips (Status / Product Code /
    // checkbox value filters / grid search) are appended later in the
    // dept branch where gridFilterIdSet is consumed; filterLine itself
    // is built after the body branch so it covers both layers. Mirrors
    // handlePrintSchedule for consistency.
    const filterBits: string[] = [];
    if (fltSearch) filterBits.push(`Search: "${fltSearch}"`);
    if (fltCustomer) filterBits.push(`Customer: ${fltCustomer}`);
    if (fltState) filterBits.push(`State: ${fltState}`);
    if (fltCategory) {
      const catLabel =
        fltCategory === "ACCESSORY" ? "Accessories" :
        fltCategory === "BEDFRAME" ? "Bedframe" :
        fltCategory === "SOFA" ? "Sofa" :
        fltCategory;
      filterBits.push(`Category: ${catLabel}`);
    }
    if (fltDueFrom || fltDueTo) {
      filterBits.push(`Due: ${fltDueFrom || "…"} → ${fltDueTo || "…"}`);
    }
    if (incompleteOnly) {
      filterBits.push("Incomplete only");
    }

    const title =
      activeTab === "ALL"
        ? "Production Schedule — Total Listing — Overview"
        : `Production Schedule — Total Listing — ${activeDept?.name}`;

    let body = "";
    let sourceCount = 0;
    let mergedCount = 0;
    let totalQty = 0;
    // Total production minutes across the printed source scope — printed
    // as a totals line under the merged table so the operator can size a
    // shift / capacity against the schedule at a glance. Mirrors
    // handlePrintSchedule's totals; computed per branch.
    let totalProdMinutes = 0;

    if (activeTab === "ALL") {
      // Overview merge: group by (productCode, sizeLabel, fabricCode).
      // divan/leg/gap intentionally excluded — those are model variants
      // already encoded in productCode where they matter.
      type Bucket = {
        productCode: string;
        fabricCode: string;
        sizeLabel: string;
        qty: number;
        earliestDue: string;
        soIds: Set<string>;
        customers: Set<string>;
      };
      const buckets = new Map<string, Bucket>();
      for (const o of visibleOrders) {
        const key = [
          o.productCode || "",
          o.sizeLabel || "",
          o.fabricCode || "",
        ].join("|");
        let b = buckets.get(key);
        if (!b) {
          b = {
            productCode: o.productCode || "",
            fabricCode: o.fabricCode || "",
            sizeLabel: o.sizeLabel || "",
            qty: 0,
            earliestDue: "",
            soIds: new Set(),
            customers: new Set(),
          };
          buckets.set(key, b);
        }
        b.qty += o.quantity || 0;
        b.earliestDue = earliestIso([b.earliestDue, o.targetEndDate].filter(Boolean));
        if (o.poNo) b.soIds.add(o.poNo);
        if (o.customerName) b.customers.add(o.customerName);
      }
      sourceCount = visibleOrders.length;
      // Sum jobCard prodTime across all visible orders — mirrors the
      // Overview branch in handlePrintSchedule.
      for (const o of visibleOrders) {
        for (const jc of o.jobCards || []) {
          const perUnit = Number(jc.productionTimeMinutes) || Number(jc.estMinutes) || 0;
          const wipQty = (jc as JobCard & { wipQty?: number }).wipQty ?? 1;
          totalProdMinutes += perUnit * (wipQty || 1);
        }
      }
      const list = Array.from(buckets.values()).sort((a, b) => {
        const m = a.productCode.localeCompare(b.productCode);
        if (m !== 0) return m;
        const s = a.sizeLabel.localeCompare(b.sizeLabel);
        if (s !== 0) return s;
        return a.fabricCode.localeCompare(b.fabricCode);
      });
      mergedCount = list.length;
      totalQty = list.reduce((s, x) => s + x.qty, 0);
      const rowsHtml = list.map((b, i) => {
        return `<tr>
          <td class="num">${i + 1}</td>
          <td class="prod"><b>${escapeHtml(b.productCode)}</b></td>
          <td>${escapeHtml(b.sizeLabel)}</td>
          <td>${escapeHtml(b.fabricCode)}</td>
          <td class="num"><b>${b.qty}</b></td>
          <td>${fmt(b.earliestDue)}</td>
          <td class="num">${b.soIds.size}</td>
          <td class="num">${b.customers.size}</td>
        </tr>`;
      }).join("");
      body = `
        <table class="schedule">
          <thead>
            <tr>
              <th class="num">#</th>
              <th>Product</th>
              <th>Size</th>
              <th>Fabric</th>
              <th class="num">Total Qty</th>
              <th>Earliest Due</th>
              <th class="num">N orders</th>
              <th class="num">N customers</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>`;
    } else {
      // Dept sub-tab merge: group by WIP code ONLY. The user has already
      // baked every relevant attribute (size, fabric, dept tag like (WD)
      // / (Frame) / NINJA 08 Foam) into the WIP code itself, so the WIP
      // string is the canonical "what to produce" identifier. Splitting
      // by separate size/colour columns just inflates the printout with
      // duplicate rows that read identically to the operator. Same WIP =
      // same physical production unit, regardless of which model variant
      // / customer / due date the source row carried.
      const printRows = gridFilterIdSet
        ? deptRows.filter((r) => gridFilterIdSet.has(r.id))
        : deptRows;
      // Mirror the dept branch in handlePrintSchedule: DeptRow.prodTime
      // already has productionTimeMinutes × wipQty baked in for this
      // dept's job cards, so a flat sum gives the correct total.
      totalProdMinutes = printRows.reduce(
        (s, r) => s + (Number(r.prodTime) || 0),
        0,
      );

      // Pull grid-level filters (column text filter, value-checkbox
      // filter, grid search) out of sessionStorage so the merged-listing
      // printout's "Filters" line reflects everything the operator has
      // narrowed the view by. Same storage shape as data-grid.tsx
      // writes; see handlePrintSchedule's identical block for context.
      try {
        const gridId = `production-dept-${activeTab.toLowerCase()}`;
        const userEmailLc = (() => {
          try {
            const u = getCurrentUser();
            return u?.email ? u.email.toLowerCase() : "anon";
          } catch { return "anon"; }
        })();
        const filterStoreKey = `datagrid-filters-${gridId}-${userEmailLc}`;
        const raw = sessionStorage.getItem(filterStoreKey);
        if (raw) {
          const parsed = JSON.parse(raw) as {
            searchText?: string;
            columnFilters?: Record<string, string>;
            columnValueFilters?: Record<string, string[]>;
          };
          const colLabel = new Map(deptColumns.map((c) => [c.key, c.label]));
          if (parsed.searchText) {
            filterBits.push(`Grid search: "${parsed.searchText}"`);
          }
          for (const [key, val] of Object.entries(parsed.columnFilters ?? {})) {
            if (val) filterBits.push(`${colLabel.get(key) ?? key}: ${val}`);
          }
          for (const [key, vals] of Object.entries(parsed.columnValueFilters ?? {})) {
            if (Array.isArray(vals) && vals.length > 0) {
              filterBits.push(`${colLabel.get(key) ?? key}: ${vals.join(", ")}`);
            }
          }
        }
      } catch { /* ignore — don't block print on storage errors */ }
      type Bucket = {
        wip: string;
        qty: number;
        earliestDue: string;
        sourceRows: number;
        customers: Set<string>;
      };
      const buckets = new Map<string, Bucket>();
      for (const r of printRows) {
        const key = r.wip;
        let b = buckets.get(key);
        if (!b) {
          b = {
            wip: r.wip,
            qty: 0,
            earliestDue: "",
            sourceRows: 0,
            customers: new Set(),
          };
          buckets.set(key, b);
        }
        b.qty += r.qty || 0;
        b.sourceRows += 1;
        b.earliestDue = earliestIso([b.earliestDue, r.dueDate].filter(Boolean));
        if (r.customerName) b.customers.add(r.customerName);
      }
      sourceCount = printRows.length;
      const list = Array.from(buckets.values()).sort((a, b) =>
        a.wip.localeCompare(b.wip),
      );
      mergedCount = list.length;
      totalQty = list.reduce((s, x) => s + x.qty, 0);
      const rowsHtml = list.map((b, i) => {
        return `<tr>
          <td class="num">${i + 1}</td>
          <td><b>${escapeHtml(b.wip)}</b></td>
          <td class="num"><b>${b.qty}</b></td>
          <td>${fmt(b.earliestDue)}</td>
          <td class="num">${b.sourceRows}</td>
          <td class="num">${b.customers.size}</td>
        </tr>`;
      }).join("");
      body = `
        <table class="schedule">
          <thead>
            <tr>
              <th class="num">#</th>
              <th>WIP</th>
              <th class="num">Total Qty</th>
              <th>Earliest Due</th>
              <th class="num">N orders</th>
              <th class="num">N customers</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>`;
    }

    // Final filter chip strip — constructed after the body branch so it
    // covers both page-level chips (top of function) and grid-level chips
    // (appended inside the dept branch above).
    const filterLine = filterBits.length
      ? `<div class="filters">Filters — ${filterBits.join(" · ")}</div>`
      : "";

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    /* A4 landscape — matches on-screen listing. White-only to save ink. */
    @page { size: A4 landscape; margin: 8mm; background: #ffffff; }
    * { box-sizing: border-box; }
    html, body { background: #ffffff; }
    body {
      font-family: "Segoe UI", Helvetica, Arial, sans-serif;
      color: #000;
      font-size: 8.5px;
      margin: 0;
      padding: 0;
    }
    .header {
      display: flex; align-items: center; justify-content: space-between;
      border-bottom: 1.5px solid #000; padding-bottom: 5px; margin-bottom: 6px;
    }
    .brand {
      font-size: 14px; font-weight: 700; color: #000; letter-spacing: 0.5px;
    }
    .brand small {
      display: block; font-size: 7px; font-weight: 500; color: #555;
      letter-spacing: 1px; text-transform: uppercase;
    }
    .meta { text-align: right; font-size: 8px; color: #333; }
    .meta .t { font-size: 10px; font-weight: 700; color: #000; }
    .filters {
      margin-bottom: 4px; font-size: 7.5px; color: #333;
      padding: 2px 5px; background: #fff; border-left: 2px solid #000;
    }
    table.schedule {
      width: 100%; border-collapse: collapse; font-size: 7.5px;
      table-layout: auto; background: #ffffff;
    }
    table.schedule th {
      background: #ffffff; color: #000; font-weight: 700;
      text-align: left; padding: 3px 4px; border: 0.75px solid #000;
      text-transform: uppercase; font-size: 7px; letter-spacing: 0.3px;
    }
    table.schedule td {
      padding: 3px 4px; border: 0.5px solid #333; vertical-align: middle;
      background: #ffffff; color: #000;
    }
    table.schedule td.num, table.schedule th.num { text-align: right; }
    table.schedule td.so { font-weight: 700; white-space: nowrap; }
    table.schedule td.prod small,
    table.schedule tbody small { color: #555; font-size: 6.5px; }
    tr { page-break-inside: avoid; }
    thead { display: table-header-group; }
    .totals {
      margin-top: 6px;
      padding: 4px 6px;
      font-size: 9px;
      font-weight: 700;
      text-align: right;
      border-top: 0.5px solid #000;
      background: #ffffff;
    }
    .totals .hours {
      font-weight: 500;
      color: #555;
      margin-left: 4px;
    }
    .footer {
      margin-top: 8px; padding-top: 3px; border-top: 0.5px solid #666;
      font-size: 6.5px; color: #333; text-align: center;
    }
    @media print {
      .no-print { display: none !important; }
      html, body { background: #ffffff !important; }
    }
    .no-print {
      position: fixed; top: 10px; right: 10px; z-index: 1000;
    }
    .no-print button {
      background: #000; color: #fff; border: 0; padding: 8px 14px;
      border-radius: 4px; cursor: pointer; font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="no-print"><button onclick="window.print()">Print / Save as PDF</button></div>
  <div class="header">
    <div class="brand">HOOKKA<small>Furniture Manufacturing</small></div>
    <div class="meta">
      <div class="t">${title}</div>
      <div>Generated: ${today} · ${mergedCount} unique item(s)</div>
    </div>
  </div>
  ${filterLine}
  ${body}
  ${totalProdMinutes > 0 ? `<div class="totals">Total Production Time: ${totalProdMinutes.toLocaleString()} min<span class="hours">(${(totalProdMinutes / 60).toFixed(1)} h)</span></div>` : ""}
  <div class="footer">Hookka Manufacturing ERP — Production Schedule (Total Listing) · Merged from ${sourceCount} source rows into ${mergedCount} unique items · Total qty across all items: ${totalQty} · Printed ${today}</div>
  <script>setTimeout(function(){ window.print(); }, 300);</${''}script>
</body>
</html>`;

    const w = window.open("", "_blank", "width=1200,height=800");
    if (!w) return;
    w.document.open();
    w.document.write(html);
    w.document.close();
  }, [
    activeTab, activeDept, visibleOrders, deptRows,
    fltSearch, fltCustomer, fltState, fltCategory, fltDueFrom, fltDueTo, incompleteOnly, gridFilterIdSet, deptColumns,
  ]);

  // NOTE: loading is intentionally NOT an early-return — that previously
  // unmounted the entire page (header, filter bar, open native date picker
  // popups) on every refetch, which killed mid-interaction calendars and
  // forced the user to start over. Instead the spinner renders as a small
  // fixed badge so the filter UI remains live during refetch.

  return (
    <div className="space-y-4">
      {loading && (
        <div className="fixed top-2 right-2 z-50 flex items-center gap-2 px-3 py-1.5 bg-white border border-[#E6E0D9] rounded shadow-sm text-xs text-[#6B5C32]">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-[#6B5C32] border-t-transparent" />
          Loading…
        </div>
      )}
      {/* Unsaved changes banner — surfaces the pending draft buffer when the
          debounce timer is still counting down. Operators see a live
          unsaved-count + can force an immediate flush via "Save All Now".
          Bar is sticky so it's visible while scrolling the matrix. */}
      {(unsavedCount > 0 || savingNow) && (
        <div className="sticky top-0 z-40 -mx-4 px-4 py-2 bg-amber-100 border-y border-amber-300 flex items-center justify-between gap-3 shadow-sm">
          <div className="flex items-center gap-2 text-sm">
            {savingNow ? (
              <>
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-amber-700 border-t-transparent" />
                <span className="font-medium text-amber-900">Saving {unsavedCount > 0 ? unsavedCount : ""}…</span>
              </>
            ) : (
              <>
                <span className="text-amber-700">●</span>
                <span className="font-medium text-amber-900">
                  {unsavedCount} unsaved change{unsavedCount === 1 ? "" : "s"}
                </span>
                <span className="text-amber-700 text-xs">· auto-saving in 2s</span>
              </>
            )}
          </div>
          {!savingNow && unsavedCount > 0 && (
            <Button size="sm" onClick={saveAllNow} className="bg-amber-700 hover:bg-amber-800 text-white">
              Save All Now
            </Button>
          )}
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Production Tracking</h1>
          <p className="text-xs text-[#6B7280]">Real-time production status across all 8 departments</p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => setStockDialogOpen(true)}
            className="bg-[#6B5C32] hover:bg-[#574A28] text-white gap-1.5"
          >
            <Plus className="w-4 h-4" />
            Create Stock PO
          </Button>
          <Button variant="outline" onClick={() => navigate("/planning?tab=tracker")}>Master Tracker</Button>
          {/* Print Schedule mode picker. Detailed = one row per PO/JC
              (handlePrintSchedule). Total Listing = rows merged by
              model+spec for the floor (handlePrintTotalListing). Both
              modes respect the same on-screen filters. */}
          <label className="flex items-center gap-1.5 text-xs text-[#6B7280]">
            Mode:
            <select
              value={printMode}
              onChange={(e) => setPrintMode(e.target.value as "detailed" | "total")}
              className="text-xs px-2 py-1.5 border border-[#E6E0D9] rounded bg-white"
              title="Print Schedule mode"
            >
              <option value="detailed">Detailed</option>
              <option value="total">Total Listing</option>
            </select>
          </label>
          <Button
            variant="outline"
            onClick={
              printMode === "total" ? handlePrintTotalListing : handlePrintSchedule
            }
          >
            Print Schedule
          </Button>
          {/* UPHOLSTERY & PACKING scan the finished good, not job cards. Keep
              the FG sticker entry point for those depts only; the QR Stickers
              section below handles job-card printing for all others via its
              own "Print All" button. */}
          {(activeTab === "UPHOLSTERY" || activeTab === "PACKING") && (
            <Button variant="outline" onClick={handlePrintFgStickers}>Print FG Stickers</Button>
          )}
        </div>
      </div>

      {/* Filter bar — applies to Overview matrix AND all dept sub-tabs.
          Setting any filter (or clicking Load all) arms the lazy-load fetch
          via shouldFetch. While the response is in-flight the page shows a
          spinner below. The "Refresh" button forces a re-fetch even when
          shouldFetch is already on. */}
      <div className="rounded-lg border border-[#E6E0D9] bg-white p-3 flex flex-wrap gap-2 items-center">
        <input
          type="text"
          placeholder="Search SO / customer / model / fabric…"
          value={fltSearchInput}
          onChange={(e) => setFltSearchInput(e.target.value)}
          className="flex-1 min-w-[240px] text-xs px-3 py-1.5 border border-[#E6E0D9] rounded focus:outline-none focus:border-[#6B5C32]"
        />
        <select
          value={fltCustomer}
          onChange={(e) => setFltCustomer(e.target.value)}
          className="text-xs px-2 py-1.5 border border-[#E6E0D9] rounded bg-white"
        >
          <option value="">All customers</option>
          {customerOptions.map((c) => (<option key={c} value={c}>{c}</option>))}
        </select>
        <select
          value={fltState}
          onChange={(e) => setFltState(e.target.value)}
          className="text-xs px-2 py-1.5 border border-[#E6E0D9] rounded bg-white"
        >
          <option value="">All states</option>
          {stateOptions.map((s) => (<option key={s} value={s}>{s}</option>))}
        </select>
        {/* Category — itemCategory column. Note the canonical value is
            ACCESSORY (singular) on the API; we surface "Accessories" as
            the human label for the option. */}
        <select
          value={fltCategory}
          onChange={(e) => setFltCategory(e.target.value)}
          className="text-xs px-2 py-1.5 border border-[#E6E0D9] rounded bg-white"
          title="Product category"
        >
          <option value="">All categories</option>
          <option value="BEDFRAME">Bedframe</option>
          <option value="SOFA">Sofa</option>
          <option value="ACCESSORY">Accessories</option>
        </select>
        {/* Item-type + Model dropdowns removed 2026-05-08 per operator
            request — they didn't help narrow the view in practice and just
            added clutter beside the more useful state/category filters.
            Data now shows all item types + models by default. */}
        {/* (Lifecycle status dropdown removed 2026-04-27 — replaced by
            the per-column Status filter on the dept grid. Operators
            click ▼ on the Status column header to narrow by JC status
            (WAITING / DONE / OVERDUE) and the colored row background
            still flags ON_HOLD / CANCELLED / COMPLETED PO rows.) */}
        {/* Date-axis dropdown removed 2026-05-07 per operator preference —
            from/to range always filters on dueDate (production target end
            date). The customerDeliveryDate + created_at axes were unused. */}
        {/* Filters always apply to dueDate. Labels removed 2026-05-07 — */}
        {/* the from/to inputs sit in the standard left-to-right reading */}
        {/* order so the relationship is self-evident. */}
        <input
          type="date"
          value={fltDueFromInput}
          onChange={(e) => {
            const v = e.target.value;
            setFltDueFromInput(v);
            startDateTransition(() => setFltDueFrom(v));
          }}
          className="text-xs px-2 py-1.5 border border-[#E6E0D9] rounded"
          title="From (due date)"
        />
        <input
          type="date"
          value={fltDueToInput}
          onChange={(e) => {
            const v = e.target.value;
            setFltDueToInput(v);
            startDateTransition(() => setFltDueTo(v));
          }}
          className="text-xs px-2 py-1.5 border border-[#E6E0D9] rounded"
          title="To (due date)"
        />
        {/* Per-category overdue chips — date-filter-INDEPENDENT counts of
            SOs with at least one overdue PO of that itemCategory. Counts
            come from /api/production-orders/overdue-counts (server-side
            GROUP BY), not the date-windowed `filteredOrders`.
            Click either to drill the panel below into that category; click
            again to close. An SO with both BEDFRAME + SOFA overdue POs is
            counted in BOTH cards (no dedup — both signals matter to the
            operator). Greyed out at zero so "all clear" reads explicit. */}
        <button
          type="button"
          onClick={() =>
            setOverduePanelMode((m) => (m === "BEDFRAME" ? null : "BEDFRAME"))
          }
          className={`text-xs px-2 py-1.5 rounded border transition font-semibold ${
            bedframeOverdueCount > 0
              ? overduePanelMode === "BEDFRAME"
                ? "bg-[#D9534F] text-white border-[#D9534F]"
                : "bg-[#FDECEA] text-[#A12C28] border-[#F1B5B0] hover:bg-[#F8D7D4]"
              : "bg-white text-[#9CA3AF] border-[#E6E0D9] cursor-default"
          }`}
          disabled={bedframeOverdueCount === 0}
          title={
            bedframeOverdueCount > 0
              ? `Click to view ${bedframeOverdueCount} SO${bedframeOverdueCount === 1 ? "" : "s"} with overdue BEDFRAME POs (independent of date filter)`
              : "No overdue Bedframe SOs system-wide"
          }
        >
          Bedframe ⚠ {bedframeOverdueCount}
        </button>
        <button
          type="button"
          onClick={() =>
            setOverduePanelMode((m) => (m === "SOFA" ? null : "SOFA"))
          }
          className={`text-xs px-2 py-1.5 rounded border transition font-semibold ${
            sofaOverdueCount > 0
              ? overduePanelMode === "SOFA"
                ? "bg-[#D9534F] text-white border-[#D9534F]"
                : "bg-[#FDECEA] text-[#A12C28] border-[#F1B5B0] hover:bg-[#F8D7D4]"
              : "bg-white text-[#9CA3AF] border-[#E6E0D9] cursor-default"
          }`}
          disabled={sofaOverdueCount === 0}
          title={
            sofaOverdueCount > 0
              ? `Click to view ${sofaOverdueCount} SO${sofaOverdueCount === 1 ? "" : "s"} with overdue SOFA POs (independent of date filter)`
              : "No overdue Sofa SOs system-wide"
          }
        >
          Sofa ⚠ {sofaOverdueCount}
        </button>
        {/* Wei Siang 2026-05-13: removed the "Filter Incomplete" button —
            its narrowing wasn't matching the operator's mental model
            ("Production Filter 不完整"). The same effect is available via
            the Status column's value filter on each dept grid (untick
            COMPLETED / TRANSFERRED). `incompleteOnly` state is kept
            (always false) so every place that reads the flag continues to
            work — removing it would touch ~12 filter-predicate sites. */}
        {/* Wei Siang 2026-05-13: removed the page-level "All PIC" toggle.
            The batch Apply PIC dialog already exposes its own "Show all
            departments" button for cross-dept assignment; inline cells
            stay smart-filtered by active dept. picShowAll state kept
            (false forever) to avoid touching deptWorkers / Clear-all wiring. */}
        {!shouldFetch && (
          <button
            onClick={() => setShouldFetch(true)}
            className="text-[10px] px-2 py-1 rounded border border-[#6B5C32] text-[#6B5C32] hover:bg-[#FAF8F4]"
            title="Skip filtering and load every active production order"
          >
            Load all
          </button>
        )}
        {/* Clear all — restored 2026-05-12. The 2026-05-05 removal was
            because clearing from/to caused a 1-2s main-thread freeze
            (~9k JC refetch + grid re-render); commit 1fdb903 fixed that
            by deferring the heavy filter useMemo deps. The trigger for
            bringing it back was iPad Safari: the native <input type="date">
            picker has no Clear (X) button on iPadOS, so operators on the
            shop-floor tablet couldn't empty the date range once set. One
            tap here wipes the date inputs and every other page-level
            filter in a single atomic URL write. */}
        <button
          type="button"
          onClick={() => {
            // 1. Page-level filter bar (search / customer / state / category
            //    / date range) — URL-state-backed, atomic write.
            setUrlBatch({ q: "", state: "", customer: "", cat: "", from: "", to: "" });
            setFltSearchInput("");
            setIncompleteOnly(false);
            setPicShowAll(false);
            clearAllOverviewFilters();
            setOverduePanelMode(null);
            // 2. DataGrid's INTERNAL filter state for every dept tab —
            //    Wei Siang 2026-05-13: "Clear All 应该把下面 Listing 在内
            //    的整个内容、彻彻底底干干净净地把 Filter 都清掉". The grid
            //    stashes search-text / per-column text filters / value
            //    filters in sessionStorage under
            //    `datagrid-filters-${gridId}-${userKey()}` (see
            //    src/components/ui/data-grid.tsx L1013). Wiping every
            //    production-dept-* key here covers all 8 dept tabs in one
            //    pass, even ones the operator hasn't visited this session.
            if (typeof window !== "undefined") {
              try {
                const keysToRemove: string[] = [];
                for (let i = 0; i < sessionStorage.length; i++) {
                  const k = sessionStorage.key(i);
                  if (k && k.startsWith("datagrid-filters-production-dept-")) {
                    keysToRemove.push(k);
                  }
                }
                for (const k of keysToRemove) sessionStorage.removeItem(k);
              } catch { /* sessionStorage disabled — best-effort clear */ }
            }
            // 3. Force the visible DataGrid to remount so its in-memory
            //    filter state (searchText / columnFilters / columnValueFilters)
            //    re-seeds from the now-empty sessionStorage. Without this
            //    bump the existing instance keeps its React state and the
            //    operator still sees stale filters until a tab switch.
            setGridResetNonce((n) => n + 1);
            // 4. Also flip the "bypass default-hide" flag on so the grid's
            //    defaultExcludedValues useEffect doesn't immediately re-
            //    apply the hide-COMPLETED Status filter on remount. The
            //    flag resets on dept-tab change so navigating away +
            //    back restores the first-visit default.
            setClearAllActive(true);
          }}
          className="text-[10px] px-2 py-1 rounded border border-[#E6E0D9] text-[#6B5C32] hover:bg-[#FAF8F4]"
          title="Clear every filter on the page, including search + per-column filters in the grid below"
        >
          Clear all
        </button>
        <span className="ml-auto text-[10px] text-[#8A7F73]">
          {shouldFetch
            ? `${filteredOrders.length} of ${orders.length} orders`
            : "Pick a filter (or Load all) to fetch orders"}
        </span>
      </div>

      {/* Overdue SO drill-down panel — toggled by the chips above. Filter
          mode comes from `overduePanelMode` (BEDFRAME / SOFA): only rows
          whose overdue PO set contains that itemCategory render. An SO
          with both BF + sofa overdue POs appears in either panel.
          Date-filter-independent: rows come from the
          /api/production-orders/overdue-counts breakdown payload. Click
          an SO row → navigate to /sales/<id> when we have a salesOrderId,
          otherwise the row stays read-only (CO-only orders don't have an
          SO detail page). */}
      {overduePanelMode && (() => {
        const filteredRows = overdueBreakdown.filter((r) =>
          r.overdueCategories.includes(overduePanelMode),
        );
        if (filteredRows.length === 0) return null;
        const label = overduePanelMode === "BEDFRAME" ? "Bedframe" : "Sofa";
        return (
        <div className="rounded-lg border border-[#F1B5B0] bg-[#FFF7F6] overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-[#F1B5B0] bg-[#FDECEA]">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold text-[#A12C28]">
                {label} Overdue ({filteredRows.length})
              </span>
              <span className="text-[10px] text-[#A12C28]/70">
                System-wide — independent of the date filter above
              </span>
            </div>
            <button
              type="button"
              onClick={() => setOverduePanelMode(null)}
              className="text-[11px] text-[#A12C28] hover:underline"
            >
              Close
            </button>
          </div>
          <div className="max-h-[320px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF7F6] border-b border-[#F1B5B0] sticky top-0">
                <tr className="text-left text-[10px] uppercase tracking-wider text-[#A12C28]/80">
                  <th className="px-3 py-1.5 font-semibold">SO</th>
                  <th className="px-3 py-1.5 font-semibold">Customer</th>
                  <th className="px-3 py-1.5 font-semibold text-center">Overdue / Total</th>
                  <th className="px-3 py-1.5 font-semibold">Earliest Overdue</th>
                  <th className="px-3 py-1.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => {
                  const clickable = !!row.salesOrderId;
                  return (
                    <tr
                      key={row.soId}
                      onClick={() => {
                        if (clickable) navigate(`/sales/${row.salesOrderId}`);
                      }}
                      className={`border-b border-[#F1B5B0]/40 last:border-b-0 ${
                        clickable
                          ? "cursor-pointer hover:bg-[#FDECEA]"
                          : "cursor-default"
                      }`}
                      title={
                        clickable
                          ? `Open ${row.displaySoId}`
                          : "No linked SO detail page"
                      }
                    >
                      <td className="px-3 py-1.5 font-mono text-[11px] text-[#1F1D1B]">
                        {row.displaySoId}
                        {clickable && (
                          <ExternalLink className="inline-block ml-1 h-3 w-3 text-[#9CA3AF]" />
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-[#1F1D1B]">{row.customer || "—"}</td>
                      <td className="px-3 py-1.5 text-center">
                        <span className="font-semibold text-[#A12C28]">
                          {row.overduePos}
                        </span>
                        <span className="text-[#9CA3AF]"> / {row.totalPos} POs</span>
                      </td>
                      <td className="px-3 py-1.5 text-[#A12C28] font-medium">
                        {fmtShortDate(row.earliest) || "—"}
                      </td>
                      <td className="px-3 py-1.5 text-[10px] text-[#6B7280]">
                        {row.poStatus}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        );
      })()}

      {/* Lazy-load placeholder: before any filter is set we don't fetch
          the payload at all — the user sees the filter bar above plus this
          callout. Clicking any filter (handled by the useEffect that flips
          shouldFetch) or "Load all" arms the request. */}
      {!shouldFetch && (
        <div className="rounded-lg border border-dashed border-[#E6E0D9] bg-[#FAF8F4] px-4 py-12 text-center">
          <p className="text-sm text-[#6B5C32] font-medium">
            No orders loaded yet.
          </p>
          <p className="mt-1 text-xs text-[#8A7F73]">
            Pick any filter above (or click <em>Load all</em>) to fetch the
            production payload. Skipping the fetch keeps the page snappy when
            you only need to navigate to a specific order.
          </p>
        </div>
      )}

      {/* Tab bar: Overview + 8 depts, all equal width (grid-cols-9).
          Only rendered in legacy "full" mode. The per-route pages
          (/production vs /production/<code>) navigate via the sidebar
          instead, so the in-page tab bar would be redundant. */}
      {mode === "full" && (
      <div className="rounded-lg border border-[#E6E0D9] bg-[#FAF8F4] p-1">
        <div className="grid grid-cols-9 gap-1">
          <button
            onClick={() => setActiveTab("ALL")}
            className={`px-3 py-2 rounded text-xs font-semibold transition ${
              activeTab === "ALL"
                ? "bg-white text-[#1F1D1B] shadow-sm border border-[#E6E0D9]"
                : "text-[#6B7280] hover:text-[#1F1D1B]"
            }`}
          >
            Overview <span className="opacity-60 font-normal">{overallDone}/{overallTotal}</span>
          </button>
          {deptFractions.map((d) => (
            <button
              key={d.code}
              onClick={() => setActiveTab(d.code)}
              className={`px-2 py-2 rounded text-[11px] font-semibold uppercase tracking-wide transition truncate ${
                activeTab === d.code
                  ? "bg-white text-[#1F1D1B] shadow-sm border border-[#6B5C32]"
                  : "text-[#8A7F73] hover:text-[#1F1D1B]"
              }`}
            >
              {d.name} <span className="opacity-60 font-normal normal-case">{d.done}/{d.total}</span>
            </button>
          ))}
        </div>
      </div>
      )}

      {/* Legend — only for Overview matrix */}
      {activeTab === "ALL" && (
        <div className="flex items-center gap-4 text-[10px] text-[#6B7280] px-1">
          <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm bg-[#3E6570]" /> Completed</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm bg-[#9C6F1E]" /> Pending</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm bg-[#9A3A2D]" /> Overdue</span>
        </div>
      )}

      {/* Dept view: Production Sheet-style DataGrid (sort/filter/resize built in) */}
      {activeTab !== "ALL" && activeDept && (
        <div className="rounded-lg border border-[#E6E0D9] bg-white">
          <div className="px-4 py-2.5 border-b border-[#E6E0D9] bg-[#FAF8F4] flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#6B5C32]" />
            <h2 className="text-sm font-semibold text-[#1F1D1B]">
              {activeDept.name} — Production Sheet
              <span className="ml-2 text-xs font-normal text-[#8A7F73]">
                {loading && deptRows.length === 0
                  ? "(loading…)"
                  : (
                  <>
                    ({(gridFilteredDeptRows ?? deptRows).length}
                    {gridFilteredDeptRows && gridFilteredDeptRows.length !== deptRows.length
                      ? ` of ${deptRows.length}`
                      : ""} items)
                  </>
                )}
              </span>
            </h2>
            {/* Wei Siang 2026-05-14: removed the "Open in Google Sheets" +
                "Export as Excel" header buttons. The Sheets gids were never
                populated (the GID_BY_DEPT map was a TODO stub), and the
                Excel export hasn't been part of the daily workflow —
                operator wanted a cleaner header. The data-grid still has
                its own copy/csv path via the Columns ▼ menu's "Export"
                action if needed in the future. */}
          </div>
          <DataGrid<DeptRow>
            // Including gridResetNonce here forces a fresh mount when Clear
            // All fires, so the grid re-reads its now-empty sessionStorage
            // filter state instead of preserving its in-memory copy.
            key={`dept-grid-${activeDept.code}-${gridResetNonce}`}
            columns={deptColumns}
            data={deptRows}
            keyField="id"
            stickyHeader
            maxHeight="calc(100vh - 300px)"
            emptyMessage={loading ? `Loading ${activeDept.name}…` : `No job cards in ${activeDept.name}.`}
            onDoubleClick={(row) => {
              if (row.salesOrderId) navigate(`/sales/${row.salesOrderId}`);
              else if (row.consignmentOrderId) navigate(`/consignment/${row.consignmentOrderId}`);
            }}
            contextMenuItems={(row): ContextMenuItem[] => [
              {
                label: row.salesOrderId
                  ? "Open Sales Order"
                  : "Open Consignment Order",
                icon: <ExternalLink className="h-3.5 w-3.5" />,
                action: () => {
                  if (row.salesOrderId) navigate(`/sales/${row.salesOrderId}`);
                  else if (row.consignmentOrderId)
                    navigate(`/consignment/${row.consignmentOrderId}`);
                },
                disabled: !row.salesOrderId && !row.consignmentOrderId,
              },
            ]}
            gridId={`production-dept-${activeDept.code.toLowerCase()}`}
            // Roll out the newly-added Customer SO column to existing users
            // whose saved column layout predates it (one-time per user/grid).
            ensureColumns={["customerSO"]}
            // Render-only cap so the initial paint on Fab Sew (~1.2k rows)
            // and similar large depts stays snappy. Filter / Search / Sort /
            // Print / QR / Total strip all act on the full filtered set via
            // gridFilteredDeptRows — capping is purely how many rows get
            // painted into the DOM at once. Operator can click "Show all N"
            // in the grid footer to lift the cap for that session.
            // (Confirmed NOT the cause of the bottom-right-corner judder —
            // removing it 2026-05-21 did not stop the judder; re-enabled.)
            defaultRowCap={500}
            onFilteredDataChange={setGridFilteredDeptRows}
            // Batch-action multi-select. Adds the checkbox column on the
            // left + populates `selectedDeptRows` for the toolbar below.
            selectable
            onSelectionChange={(rows: DeptRow[]) =>
              setSelectedDeptRows(
                rows.map((r) => ({ id: r.id, poId: r.poId, jobCardId: r.jobCardId })),
              )
            }
            // Hide already-completed / transferred dept cards by default
            // so the operator opens the page and immediately sees only
            // the live work in front of them. They can re-tick
            // COMPLETED / TRANSFERRED in the Status filter to see
            // history. Mirrors the operator's request: fewer rows
            // means faster page open and a more focused live view.
            defaultExcludedValues={clearAllActive ? undefined : { status: ["COMPLETED", "TRANSFERRED"] }}
            // Re-enabled 2026-05-10 after measuring a 5.4s React-render
            // block on Fab Sew (~1.4k rows × 25 cols) immediately after
            // clearing the From-date filter — operator's "卡着 needs refresh"
            // symptom. Long-task profile pinned the cost on the body's
            // tbody reconciliation, not on the data prep (baseRows fix
            // already trimmed compute to <100ms). With virtualize=true
            // DataGrid only mounts the ~30 rows in the viewport, dropping
            // body reconciliation by ~50×.
            //
            // The 2026-05-04 alignment-drift report (sticky # / SO ID
            // columns lining up against the header instead of the row)
            // was the reason this was off. The clipping + totalSize
            // safeguards added in DataGrid since (Apr 26 2026 fixes plus
            // the VIRTUALIZE_MIN_ROWS=100 fall-through) should keep this
            // path stable, but if the alignment regresses on the live
            // grid, flip back to virtualize={false} — fast revert.
            virtualize
            // ON_HOLD → amber background; CANCELLED → grey + strikethrough.
            // rowClassName appends onto the grid's default row class so alt-row
            // striping still works when no lifecycle class applies.
            rowClassName={(row) => {
              if (row.poStatus === "ON_HOLD") {
                return "bg-[#FEF6D8] hover:bg-[#FBEBAE]";
              }
              if (row.poStatus === "CANCELLED") {
                return "bg-[#F3F4F6] text-[#9CA3AF] line-through hover:bg-[#E5E7EB]";
              }
              return "";
            }}
          />
          {/* Totals strip — sum of Prod Time + Qty across the rows
              currently visible in the grid (after filters). Mirrors
              gridFilteredDeptRows so a "show only Overdue" filter
              immediately reflects the total time budget for the
              filtered subset. Falls back to the unfiltered set when
              the grid hasn't reported filtered rows yet. */}
          {(() => {
            // Cast back to DeptRow — the gridFilteredDeptRows mirror is
            // typed loosely (id/poId/jobCardId) but the runtime objects
            // are full DeptRow instances passed straight through from the
            // grid via onFilteredDataChange.
            const visible = (gridFilteredDeptRows as unknown as DeptRow[] | null) ?? deptRows;
            const totalProdTime = visible.reduce((sum, r) => sum + (Number(r.prodTime) || 0), 0);
            const totalQty = visible.reduce((sum, r) => sum + (Number(r.qty) || 0), 0);
            return (
              <div className="border-t-2 border-[#E6E0D9] bg-[#FAF8F4] px-4 py-2.5 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
                <span className="font-semibold text-[#1F1D1B]">Total ({visible.length} rows)</span>
                <span className="text-[#6B7280]">
                  Prod Time: <span className="font-semibold text-[#1F1D1B] tabular-nums">{totalProdTime.toLocaleString()} min</span>
                  <span className="text-[#9CA3AF] ml-1">({(totalProdTime / 60).toFixed(1)} h)</span>
                </span>
                <span className="text-[#6B7280]">
                  Qty: <span className="font-semibold text-[#1F1D1B] tabular-nums">{totalQty.toLocaleString()}</span>
                </span>
              </div>
            );
          })()}
          {/* Batch action toolbar — floats above the grid bottom when the
              operator has multi-selected rows. */}
          <BatchActionToolbar
            count={selectedDeptRows.length}
            onClear={() => setSelectedDeptRows([])}
            onApplyDate={() => setBatchDateOpen(true)}
            onApplyDueDate={() => setBatchDueDateOpen(true)}
            onApplyPic={() => setBatchPicOpen(true)}
            onSaveToFolder={async () => {
              // Load folders fresh each open so a folder created in another
              // tab is visible. Fast endpoint (<100ms) so no UX cost.
              try {
                const res = await fetch("/api/production-folders", { credentials: "include" });
                if (res.ok) {
                  const j = (await res.json()) as { success: boolean; data: FolderOption[] };
                  if (j.success) setFolderList(j.data || []);
                }
              } catch {/* show dialog with empty existing list — operator can still create new */}
              setBatchFolderOpen(true);
            }}
          />
        </div>
      )}

      {/* Batch dialogs — mounted at page level so they overlay everything */}
      <ApplyBatchDateDialog
        open={batchDateOpen}
        count={selectedDeptRows.length}
        onCancel={() => setBatchDateOpen(false)}
        onApply={async (date) => {
          setBatchDateOpen(false);
          const patches = selectedDeptRows.map((r) => ({
            poId: r.poId,
            jobCardId: r.jobCardId,
            completedDate: date,
            status: date ? "COMPLETED" : "WAITING",
          }));
          try {
            const res = await fetch("/api/production-orders/bulk-patch", {
              method: "POST",
              headers: csrfHeaders(),
              body: JSON.stringify({ patches }),
              credentials: "include",
            });
            const j = (await res.json()) as { success?: boolean; results?: Array<{ success: boolean; error?: string }> };
            const failed = (j.results || []).filter((x) => !x.success);
            if (failed.length > 0) {
              toast.error(`${failed.length} of ${patches.length} failed: ${failed[0].error ?? "unknown"}`);
            } else {
              const verb = date ? "Stamped completion date on" : "Cleared completion date on";
              toast.success(`${verb} ${patches.length} job card${patches.length === 1 ? "" : "s"}.`);
            }
            // Wei Siang 2026-05-13: operator wants to chain batch ops
            // (Apply Date → Apply PIC → Save to Folder) without re-selecting
            // every time. Optimistic-write the patched fields to local
            // state + KEEP the selection. fetchOrders() removed because
            // it would (a) trigger a DataGrid re-render that drops the
            // checkbox selection, and (b) overwrite the optimistic values
            // until KV cache fully propagates. The 20s auto-poll catches
            // cross-operator changes; bumpPoListCacheVersion on the BE
            // already invalidates for next genuine refetch.
            const patchedJcIds = new Set(patches.map((p) => p.jobCardId));
            setOrders((prev) =>
              prev.map((po) => {
                if (!patches.some((p) => p.poId === po.id)) return po;
                return {
                  ...po,
                  jobCards: po.jobCards.map((jc) => {
                    if (!patchedJcIds.has(jc.id)) return jc;
                    return {
                      ...jc,
                      completedDate: date || null,
                      status: (date ? "COMPLETED" : "WAITING") as typeof jc.status,
                    };
                  }),
                };
              }),
            );
            invalidateCachePrefix("/api/production-orders");
          } catch (err) {
            toast.error(`Batch save failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      />
      <ApplyBatchDueDateDialog
        open={batchDueDateOpen}
        count={selectedDeptRows.length}
        onCancel={() => setBatchDueDateOpen(false)}
        onApply={async (date) => {
          setBatchDueDateOpen(false);
          // Status is INTENTIONALLY not changed here — dueDate is the
          // scheduled-completion target, not the actual progress flag.
          // Mirroring the Apply Completion handler otherwise: optimistic
          // local write + keep selection so operator can chain
          // (Apply Due → Apply PIC → Save to Folder) without re-selecting.
          const patches = selectedDeptRows.map((r) => ({
            poId: r.poId,
            jobCardId: r.jobCardId,
            dueDate: date,
          }));
          try {
            const res = await fetch("/api/production-orders/bulk-patch", {
              method: "POST",
              headers: csrfHeaders(),
              body: JSON.stringify({ patches }),
              credentials: "include",
            });
            const j = (await res.json()) as { success?: boolean; results?: Array<{ success: boolean; error?: string }> };
            const failed = (j.results || []).filter((x) => !x.success);
            if (failed.length > 0) {
              toast.error(`${failed.length} of ${patches.length} failed: ${failed[0].error ?? "unknown"}`);
            } else {
              const verb = date ? "Set due date on" : "Cleared due date on";
              toast.success(`${verb} ${patches.length} job card${patches.length === 1 ? "" : "s"}.`);
            }
            const patchedJcIds = new Set(patches.map((p) => p.jobCardId));
            setOrders((prev) =>
              prev.map((po) => {
                if (!patches.some((p) => p.poId === po.id)) return po;
                return {
                  ...po,
                  jobCards: po.jobCards.map((jc) => {
                    if (!patchedJcIds.has(jc.id)) return jc;
                    return { ...jc, dueDate: date || "" };
                  }),
                };
              }),
            );
            invalidateCachePrefix("/api/production-orders");
          } catch (err) {
            toast.error(`Batch save failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      />
      <ApplyBatchPicDialog
        open={batchPicOpen}
        count={selectedDeptRows.length}
        // Wei Siang 2026-05-13 (corrected): default = smart per-dept filter
        // (same as inline cell PIC dropdowns) — operator wants the short
        // relevant list first. The "All departments" toggle inside the
        // dialog widens to the full roster when needed.
        workers={deptWorkers.map((w) => ({ id: w.id, name: w.name }))}
        allWorkers={(workers || [])
          .slice()
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
          .map((w) => ({ id: w.id, name: w.name }))}
        onCancel={() => setBatchPicOpen(false)}
        onApply={async ({ pic1, pic2 }) => {
          setBatchPicOpen(false);
          // pic1/pic2 semantics:
          //   undefined → leave that slot alone (don't include the key)
          //   null      → explicitly clear the slot
          //   {id,name} → set to that worker
          const patches = selectedDeptRows.map((r) => {
            const p: Record<string, unknown> = { poId: r.poId, jobCardId: r.jobCardId };
            if (pic1 !== undefined) p.pic1Id = pic1?.id ?? null;
            if (pic2 !== undefined) p.pic2Id = pic2?.id ?? null;
            return p;
          });
          try {
            const res = await fetch("/api/production-orders/bulk-patch", {
              method: "POST",
              headers: csrfHeaders(),
              body: JSON.stringify({ patches }),
              credentials: "include",
            });
            const j = (await res.json()) as { success?: boolean; results?: Array<{ success: boolean; error?: string }> };
            const failed = (j.results || []).filter((x) => !x.success);
            const slots = [pic1 !== undefined ? "PIC 1" : null, pic2 !== undefined ? "PIC 2" : null].filter(Boolean).join(" + ");
            if (failed.length > 0) {
              toast.error(`${failed.length} of ${patches.length} failed: ${failed[0].error ?? "unknown"}`);
            } else {
              toast.success(`Set ${slots} on ${patches.length} job card${patches.length === 1 ? "" : "s"}.`);
            }
            // Keep selection + optimistic-write PIC fields so the operator
            // can chain into the next batch action. See the Apply Date
            // branch above for the rationale.
            const patchedJcIds = new Set(patches.map((p) => p.jobCardId));
            const pic1Name = pic1 ? pic1.name : "";
            const pic2Name = pic2 ? pic2.name : "";
            setOrders((prev) =>
              prev.map((po) => {
                if (!patches.some((p) => p.poId === po.id)) return po;
                return {
                  ...po,
                  jobCards: po.jobCards.map((jc) => {
                    if (!patchedJcIds.has(jc.id)) return jc;
                    const next = { ...jc };
                    if (pic1 !== undefined) {
                      next.pic1Id = pic1?.id ?? null;
                      next.pic1Name = pic1Name;
                    }
                    if (pic2 !== undefined) {
                      next.pic2Id = pic2?.id ?? null;
                      next.pic2Name = pic2Name;
                    }
                    return next;
                  }),
                };
              }),
            );
            invalidateCachePrefix("/api/production-orders");
          } catch (err) {
            toast.error(`Batch save failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      />
      <SaveToFolderDialog
        open={batchFolderOpen}
        count={selectedDeptRows.length}
        existing={folderList}
        onCancel={() => setBatchFolderOpen(false)}
        onSave={async (args) => {
          setBatchFolderOpen(false);
          const jobCardIds = selectedDeptRows.map((r) => r.jobCardId);
          try {
            if (args.mode === "new") {
              const res = await fetch("/api/production-folders", {
                method: "POST",
                headers: csrfHeaders(),
                body: JSON.stringify({ name: args.name, jobCardIds }),
                credentials: "include",
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              toast.success(`Saved ${jobCardIds.length} job card${jobCardIds.length === 1 ? "" : "s"} into "${args.name}".`);
            } else {
              const res = await fetch(`/api/production-folders/${encodeURIComponent(args.folderId)}/add-jcs`, {
                method: "POST",
                headers: csrfHeaders(),
                body: JSON.stringify({ jobCardIds }),
                credentials: "include",
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const folder = folderList.find((f) => f.id === args.folderId);
              toast.success(`Added ${jobCardIds.length} job card${jobCardIds.length === 1 ? "" : "s"} to "${folder?.name ?? "folder"}".`);
            }
            setSelectedDeptRows([]);
          } catch (err) {
            toast.error(`Save to folder failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      />

      {/* Overview matrix grid (only shown when Overview tab is active) */}
      {activeTab === "ALL" && (
      <div className="rounded-lg border border-[#E6E0D9] bg-white overflow-visible">
        {/* Clear-all-filters bar — shown only when at least one column
            filter or sort is active so the operator has a one-click
            reset without scrubbing each column individually. */}
        {(anyOverviewFilterActive || overviewSort) && (
          <div className="px-4 py-2 bg-[#FFFBEC] border-b border-[#F0E6BC] text-[11px] text-[#6B5C32] flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Filter className="h-3 w-3" />
              Column filters / sort active
            </span>
            <button
              type="button"
              className="text-[11px] font-semibold text-[#6B5C32] hover:underline"
              onClick={clearAllOverviewFilters}
            >
              Clear all filters
            </button>
          </div>
        )}
        {/* Header row */}
        <div
          className="grid text-[10px] font-semibold uppercase tracking-wider text-[#6B7280] bg-[#FAF8F4] border-b border-[#E6E0D9] relative z-20"
          style={{ gridTemplateColumns: "120px minmax(220px,1.4fr) 110px 120px 130px 50px 70px repeat(8,minmax(0,1fr))" }}
        >
          <OverviewHeader
            label="SO ID"
            sortKey="soId"
            sort={overviewSort}
            cycle={cycleOverviewSort}
            filterCol="soId"
            filterActive={isFilterActive("soId")}
            openFilterCol={openFilterCol}
            setOpenFilterCol={setOpenFilterCol}
            renderFilter={() => (
              <TextContainsFilter
                value={overviewFilters.soId}
                onChange={(v) => setOverviewFilters((p) => ({ ...p, soId: v }))}
                placeholder="Contains…"
              />
            )}
          />
          <OverviewHeader
            label="Product"
            sortKey="product"
            sort={overviewSort}
            cycle={cycleOverviewSort}
            filterCol="product"
            filterActive={isFilterActive("product")}
            openFilterCol={openFilterCol}
            setOpenFilterCol={setOpenFilterCol}
            renderFilter={() => (
              <TextContainsFilter
                value={overviewFilters.product}
                onChange={(v) => setOverviewFilters((p) => ({ ...p, product: v }))}
                placeholder="Contains…"
              />
            )}
          />
          <OverviewHeader
            label="Customer"
            sortKey="customer"
            sort={overviewSort}
            cycle={cycleOverviewSort}
            filterCol="customer"
            filterActive={isFilterActive("customer")}
            openFilterCol={openFilterCol}
            setOpenFilterCol={setOpenFilterCol}
            renderFilter={() => (
              <MultiSelectFilter
                options={Array.from(new Set(visibleOrders.concat(orders).map((o) => o.customerName).filter(Boolean))).sort()}
                selected={overviewFilters.customers}
                onChange={(next) => setOverviewFilters((p) => ({ ...p, customers: next }))}
              />
            )}
          />
          <OverviewHeader
            label="Customer PO"
            sortKey="customerPO"
            sort={overviewSort}
            cycle={cycleOverviewSort}
            filterCol="customerPO"
            filterActive={isFilterActive("customerPO")}
            openFilterCol={openFilterCol}
            setOpenFilterCol={setOpenFilterCol}
            renderFilter={() => (
              <TextContainsFilter
                value={overviewFilters.customerPO}
                onChange={(v) => setOverviewFilters((p) => ({ ...p, customerPO: v }))}
                placeholder="Contains…"
              />
            )}
          />
          <OverviewHeader
            label="Special Order"
            sortKey="specialOrder"
            sort={overviewSort}
            cycle={cycleOverviewSort}
            filterCol="specialOrder"
            filterActive={isFilterActive("specialOrder")}
            openFilterCol={openFilterCol}
            setOpenFilterCol={setOpenFilterCol}
            renderFilter={() => (
              <TextContainsFilter
                value={overviewFilters.specialOrder}
                onChange={(v) => setOverviewFilters((p) => ({ ...p, specialOrder: v }))}
                placeholder="Contains…"
              />
            )}
          />
          <OverviewHeader
            label="Qty"
            align="center"
            sortKey="qty"
            sort={overviewSort}
            cycle={cycleOverviewSort}
            filterCol="qty"
            filterActive={isFilterActive("qty")}
            openFilterCol={openFilterCol}
            setOpenFilterCol={setOpenFilterCol}
            renderFilter={() => (
              <NumericRangeFilter
                min={overviewFilters.qtyMin}
                max={overviewFilters.qtyMax}
                onChange={(min, max) => setOverviewFilters((p) => ({ ...p, qtyMin: min, qtyMax: max }))}
              />
            )}
          />
          <OverviewHeader
            label="Due"
            sortKey="due"
            sort={overviewSort}
            cycle={cycleOverviewSort}
            filterCol="due"
            filterActive={isFilterActive("due")}
            openFilterCol={openFilterCol}
            setOpenFilterCol={setOpenFilterCol}
            renderFilter={() => (
              <DateRangeFilter
                from={overviewFilters.dueFrom}
                to={overviewFilters.dueTo}
                onChange={(from, to) => setOverviewFilters((p) => ({ ...p, dueFrom: from, dueTo: to }))}
              />
            )}
          />
          {DEPARTMENTS.map((d) => (
            <OverviewHeader
              key={d.code}
              label={d.name}
              align="center"
              border
              sortKey={d.code as OverviewSortKey}
              sort={overviewSort}
              cycle={cycleOverviewSort}
              filterCol={d.code}
              filterActive={isFilterActive(d.code)}
              openFilterCol={openFilterCol}
              setOpenFilterCol={setOpenFilterCol}
              renderFilter={() => (
                <DeptStatusFilter
                  selected={overviewFilters.deptStatuses[d.code] || []}
                  onChange={(next) =>
                    setOverviewFilters((p) => ({
                      ...p,
                      deptStatuses: { ...p.deptStatuses, [d.code]: next },
                    }))
                  }
                  dateRange={overviewFilters.deptDates[d.code] || { from: "", to: "" }}
                  onDateRangeChange={(next) =>
                    setOverviewFilters((p) => ({
                      ...p,
                      deptDates: { ...p.deptDates, [d.code]: next },
                    }))
                  }
                />
              )}
            />
          ))}
        </div>

        {/* Body rows. Wrapped in a scroll container + virtualizer so we
            only mount the ~30 rows currently in viewport. See the
            useVirtualizer setup near visibleOrders for the rationale.
            Each row's outer <div> is augmented with absolute positioning
            via translateY so the virtualizer can place it at the right
            offset, plus measureElement wiring (data-index + ref) so
            rows that wrap (long product line) get their real height
            measured. */}
        {visibleOrders.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-[#9A918A]">
            No production orders found.
          </div>
        ) : (
          <div
            ref={overviewBodyRef}
            className="overflow-y-auto"
            style={{ maxHeight: "calc(100vh - 320px)" }}
          >
          <div
            style={{
              height: `${overviewRowVirtualizer.getTotalSize()}px`,
              position: "relative",
              width: "100%",
            }}
          >
          {overviewRowVirtualizer.getVirtualItems().map((virtualRow) => {
            const order = visibleOrders[virtualRow.index];
            if (!order) return null;
            // Lifecycle row styling — amber background for ON_HOLD, grey +
            // strikethrough for CANCELLED. Matches the dept DataGrid rule.
            const rowCls =
              order.status === "ON_HOLD"
                ? "bg-[#FEF6D8] hover:bg-[#FBEBAE]"
                : order.status === "CANCELLED"
                  ? "bg-[#F3F4F6] text-[#9CA3AF] line-through hover:bg-[#E5E7EB]"
                  : "hover:bg-[#FDFBF7]";
            const pillLabel =
              order.status === "ON_HOLD"
                ? "ON HOLD"
                : order.status === "CANCELLED"
                  ? "CANCELLED"
                  : "";
            const pillCls =
              order.status === "ON_HOLD"
                ? "bg-[#FAEFCB] text-[#9C6F1E]"
                : order.status === "CANCELLED"
                  ? "bg-[#E5E7EB] text-[#4B5563]"
                  : "";
            return (
            <div
              key={order.id}
              ref={overviewRowVirtualizer.measureElement}
              data-index={virtualRow.index}
              className={`grid items-stretch border-b border-[#F0EBE3] cursor-pointer ${rowCls}`}
              style={{
                gridTemplateColumns: "120px minmax(220px,1.4fr) 110px 120px 130px 50px 70px repeat(8,minmax(0,1fr))",
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              onDoubleClick={() => {
                if (order.salesOrderId) navigate(`/sales/${order.salesOrderId}`);
                else if (order.consignmentOrderId)
                  navigate(`/consignment/${order.consignmentOrderId}`);
              }}
            >
              <div className="px-3 py-1.5 text-xs text-[#1F1D1B] flex items-center gap-1.5 tabular-nums">
                <span className="truncate">{order.poNo}</span>
                {pillLabel && (
                  <span className={`text-[9px] font-semibold px-1.5 py-[1px] rounded uppercase tracking-wide no-underline ${pillCls}`}>
                    {pillLabel}
                  </span>
                )}
              </div>
              <div className="px-3 py-1.5 min-w-0 flex flex-col justify-center">
                <div className="text-xs font-semibold text-[#1F1D1B] truncate">{order.productCode}</div>
                <ProductDetailLine order={order} />
              </div>
              <div className="px-3 py-1.5 text-xs text-[#6B7280] truncate flex items-center">{order.customerName}</div>
              <div
                className="px-3 py-1.5 text-xs text-[#1F1D1B] doc-number truncate flex items-center"
                title={order.customerPOId || ""}
              >
                {order.customerPOId || "—"}
              </div>
              <div
                className={`px-3 py-1.5 text-xs truncate flex items-center ${
                  order.specialOrder ? "text-[#9A3A2D] font-semibold" : "text-[#D1CCC4]"
                }`}
                title={order.specialOrder || ""}
              >
                {order.specialOrder || "—"}
              </div>
              <div className="px-2 py-1.5 text-xs text-center text-[#6B7280] flex items-center justify-center">{order.quantity}</div>
              <div
                className={`px-2 py-1.5 text-[11px] text-[#6B7280] flex items-center cursor-pointer hover:text-[#6B5C32] hover:underline transition-colors ${
                  cellFlash[`${order.id}|DUE`] === "ok"
                    ? "bg-green-100"
                    : cellFlash[`${order.id}|DUE`] === "err"
                      ? "bg-red-100"
                      : ""
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  openDatePicker(
                    order.targetEndDate || "",
                    (v) => {
                      if (!v) return;
                      setOrders((prev) =>
                        prev.map((o) => o.id === order.id ? { ...o, targetEndDate: v } : o)
                      );
                      const flashKey = `${order.id}|DUE`;
                      fetch(`/api/production-orders/${order.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ targetEndDate: v }),
                      }).then((res) => {
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        invalidateCachePrefix("/api/production-orders");
                        invalidateCachePrefix("/api/sales-orders");
                        flashCell(flashKey, "ok");
                        toast.success("Date updated");
                      }).catch((err) => {
                        flashCell(flashKey, "err");
                        const detail = err instanceof Error ? err.message : "network error";
                        toast.error(`Save failed (${detail})`);
                      });
                    },
                    e.currentTarget,
                  );
                }}
                title="Click to change due date"
              >{fmtShortDate(order.targetEndDate)}</div>
              {DEPARTMENTS.map((d) => {
                const c = cellFor(order, d.code, visibleOrders);
                const isActiveCol = false; // inside ALL view, no column highlighted
                // Flash state for this dept cell. The cell may contain
                // multiple JCs (a sofa with multiple WIPs in one dept) — we
                // key per-JC for green-tint accuracy, but for the cell tint
                // we OR them: any "err" wins, then any "ok".
                const deptCards = order.jobCards.filter((j) => j.departmentCode === d.code);
                let cellTint: "ok" | "err" | "" = "";
                for (const jc of deptCards) {
                  const k = cellFlash[`${jc.id}|${d.code}`];
                  if (k === "err") { cellTint = "err"; break; }
                  if (k === "ok") cellTint = "ok";
                }
                const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
                  if (c.state === "empty") return;
                  e.stopPropagation();
                  const seed =
                    c.state === "done"
                      ? c.latestCompleted || c.earliestDue || ""
                      : c.earliestDue || "";
                  const anchor = e.currentTarget;
                  openDatePicker(
                    seed,
                    (v) => {
                      if (!v) return;
                      // Fan out PATCH per dept JC. Each one carries its own
                      // flash key so the green tint paints exactly the cell
                      // that landed. Suppress per-JC toasts (silent) and
                      // emit a single "Date updated" once we know all of
                      // them landed (or surface the first failure).
                      let okCount = 0;
                      let errMsg: string | null = null;
                      const promises = deptCards.map((jc) =>
                        patchJobCard(order.id, jc.id, { dueDate: v }, {
                          flashKey: `${jc.id}|${d.code}`,
                          silent: true,
                        }).then(() => { okCount++; })
                          .catch((err) => {
                            errMsg = err instanceof Error ? err.message : "network error";
                          }),
                      );
                      Promise.allSettled(promises).then(() => {
                        if (errMsg) toast.error(`Save failed (${errMsg})`);
                        else if (okCount > 0) toast.success("Date updated");
                      });
                    },
                    anchor,
                  );
                };
                return (
                  <div
                    key={d.code}
                    className={`relative border-l border-[#F0EBE3] min-h-[34px] transition-colors ${isActiveCol ? "bg-[#FAF8F4]" : ""} ${c.state !== "empty" ? "cursor-pointer" : ""} ${
                      cellTint === "ok" ? "bg-green-100" : cellTint === "err" ? "bg-red-100" : ""
                    }`}
                    onClick={handleClick}
                    onDoubleClick={(e) => e.stopPropagation()}
                    title={c.state !== "empty" ? "Click to reschedule" : undefined}
                  >
                    <CellBox cell={c} />
                  </div>
                );
              })}
            </div>
            );
          })}
          </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-4 py-2 bg-[#FAF8F4] border-t border-[#E6E0D9] text-[10px] text-[#8A7F73] flex items-center justify-between">
          <span>{visibleOrders.length} of {orders.length} work orders</span>
          <span>{overallDone}/{overallTotal} cells complete</span>
        </div>
      </div>
      )}

      {/* On-screen QR tile row — mirrors the print stickers but always
          visible. Shown on every dept tab so the QR count always matches
          the Production Sheet count above, 1:1 (FAB_CUT respects the per-
          PO fabric merge, UPHOLSTERY gets one sticker per job card).
          Hidden on Overview (dashboard) and on Packing (which uses the
          richer FG Sticker Preview below — each physical box carries its
          own piece-N-of-M numbering that differs between bedframes and
          sofas). Horizontally scrollable so the row stays one line. */}
      {activeTab !== "ALL" && activeTab !== "PACKING" && (
      <div className="rounded-lg border border-[#E6E0D9] bg-white">
        <div className="px-4 py-2.5 border-b border-[#E6E0D9] bg-[#FAF8F4] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#6B5C32]" />
            <h2 className="text-sm font-semibold text-[#1F1D1B]">
              QR Stickers
              <span className="ml-2 text-xs font-normal text-[#8A7F73]">
                ({onScreenStickers.length} sticker{onScreenStickers.length === 1 ? "" : "s"} in {activeDept?.name || activeTab})
              </span>
            </h2>
          </div>
          <div className="flex gap-2">
            {onScreenStickers.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowQRStrip((v) => !v)}
              >
                {showQRStrip ? "Hide QR" : "Show QR"}
              </Button>
            )}
            {onScreenStickers.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handlePrintJobCardStickers}
                disabled={printingJobCards}
              >
                {printingJobCards ? "Generating…" : "Print All"}
              </Button>
            )}
          </div>
        </div>
        {onScreenStickers.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-[#9A918A]">
            No job cards match the current filter.
          </div>
        ) : !showQRStrip ? (
          <div className="px-4 py-6 text-center text-xs text-[#9A918A]">
            {onScreenStickers.length} sticker{onScreenStickers.length === 1 ? "" : "s"} ready · click <span className="font-semibold text-[#6B5C32]">Show QR</span> to render the tiles.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className="flex gap-3 p-3 min-w-min">
              {onScreenStickers.map((s) => {
                // Wei Siang 2026-05-15: FAB_CUT and FAB_SEW on-screen
                // tiles must be a 1:1 preview of the 100×150mm print
                // sticker — same size as the Packing FG tile (230×380px),
                // mockup #3 layout (PO No huge headline → SO/Customer/
                // Model/WIP → Size/Colour/Gap/Divan/Leg/Total/Notes →
                // blank Fabric Cutting + Fabric Sewing sign-off lines).
                // Other dept tabs keep the old compact 180px tile.
                const useLargeTile = activeTab === "FAB_CUT" || activeTab === "FAB_SEW";
                if (useLargeTile) {
                  return (
                    <div
                      key={s.key}
                      className="flex-shrink-0 border border-[#E6E0D9] rounded-md bg-white flex flex-col p-2 overflow-hidden"
                      style={{ width: "230px", height: "380px" }}
                      title={`${s.customerPOId || s.poNo} · ${s.model} · Qty ${s.qty}`}
                    >
                      {/* Wei Siang 2026-05-15: "FG sticker 你就做到很好啊"
                          — mirror FG sticker proportions / fonts exactly.
                          Same 230×380px tile, same 10px row fonts, same
                          16px title, same w-[72px] label column, same
                          space-y-[2px] density. Only the BOTTOM block
                          differs: instead of FG's QR + piece-position,
                          Fab Cut/Sew puts QR (smaller) + Fabric Cutting /
                          Fabric Sewing sign-off lines + Qty. */}
                      <div className="text-center font-bold leading-tight" style={{ fontSize: "16px" }}>
                        {s.poNo}
                      </div>
                      <div className="border-t border-black my-1" />
                      {/* Wei Siang 2026-05-15: template MUST be uniform across
                          all stickers — same row count, same heights, same
                          positions. Long-value rows (Customer Name, WIP,
                          Notes) use a smaller value font + truncate so they
                          stay on 1 line regardless of content length.
                          Short-value rows (PO No, Size, Colour, etc.) keep
                          the bigger 12px font. */}
                      <div className="space-y-[2px] text-[13px] leading-tight text-[#1F1D1B]">
                        <div className="truncate"><span className="inline-block w-[100px] font-semibold text-[#6B7280]">PO No</span>: {s.customerPOId || "—"}</div>
                        <div className="flex items-baseline gap-1">
                          <span className="inline-block w-[100px] font-semibold text-[#6B7280] shrink-0">Customer Name</span>
                          {/* Wei Siang 2026-05-15: long-value cells
                              (Customer Name, WIP, Notes) wrap freely
                              via break-words at slightly smaller font.
                              No line-clamp / truncation — Wei Siang's
                              rule: "你不可以删啊 我还是要看得到东西".
                              Container-level overflow-hidden on the
                              tile is the only bound; in practice tiles
                              have enough vertical slack since sofa
                              skips Gap/Divan/Total H rows. */}
                          <span
                            className="flex-1 break-words"
                            style={{
                              fontSize: "12px",
                              lineHeight: 1.2,
                            }}
                          >: {s.customerName || "—"}</span>
                        </div>
                        <div className="flex items-baseline gap-1">
                          <span className="inline-block w-[100px] font-semibold text-[#6B7280]">Model</span>
                          <span className="font-bold" style={{ fontSize: "16px" }}>: {s.model || "—"}</span>
                        </div>
                        {s.wipName && (
                          <div className="flex items-baseline gap-1">
                            <span className="inline-block w-[100px] font-semibold text-[#6B7280] shrink-0">WIP</span>
                            <span
                              className="flex-1 break-words"
                              style={{
                                fontSize: "11px",
                                lineHeight: 1.2,
                              }}
                            >: {s.wipName}</span>
                          </div>
                        )}
                      </div>
                      <div className="border-t border-[#E6E0D9] my-1" />
                      <div className="space-y-[2px] text-[13px] leading-tight text-[#1F1D1B]">
                        <div className="truncate"><span className="inline-block w-[100px] font-semibold text-[#6B7280]">Size</span>: {s.sizeLabel || "—"}</div>
                        <div className="truncate"><span className="inline-block w-[100px] font-semibold text-[#6B7280]">Colour</span>: {s.colour || "—"}</div>
                        {s.gap && <div><span className="inline-block w-[100px] font-semibold text-[#6B7280]">Gap</span>: {s.gap}</div>}
                        {s.divan && <div><span className="inline-block w-[100px] font-semibold text-[#6B7280]">Divan</span>: {s.divan}</div>}
                        {s.leg && <div><span className="inline-block w-[100px] font-semibold text-[#6B7280]">Leg</span>: {s.leg}</div>}
                        {s.totalHeight && <div><span className="inline-block w-[100px] font-semibold text-[#6B7280]">Total H</span>: {s.totalHeight}</div>}
                        <div className="flex items-baseline gap-1">
                          <span className="inline-block w-[100px] font-semibold text-[#9A3A2D] shrink-0">Notes</span>
                          <span
                            className="flex-1 break-words"
                            style={{
                              fontSize: "11px",
                              lineHeight: 1.2,
                            }}
                          >: {s.specialOrder ? <span className="font-bold text-[#9A3A2D]">★ {s.specialOrder}</span> : "—"}</span>
                        </div>
                      </div>
                      {/* Bottom block: QR on left + sign-off + Qty on
                          right. Same dashed-top + mt-auto pattern as
                          FG sticker's QR+piece-position section.
                          Wei Siang 2026-05-15: bigger top info + more
                          space between Fabric Cutting / Fabric Sewing
                          sign-off lines (factory operator writes name
                          + date on each line). */}
                      <div className="mt-auto pt-1 border-t border-dashed border-[#6B5C32]">
                        <div className="flex items-end gap-2 pt-1">
                          <QRImg data={s.qrPayload} size={84} alt="Job card QR" className="block shrink-0" />
                          <div className="flex-1 min-w-0 self-stretch flex flex-col justify-between text-[11px]">
                            <div className="space-y-3">
                              <div className="flex items-end gap-1">
                                <span className="font-semibold whitespace-nowrap text-[10px]">Fab Cut :</span>
                                <span className="flex-1 border-b border-black h-[22px]" />
                              </div>
                              <div className="flex items-end gap-1">
                                <span className="font-semibold whitespace-nowrap text-[10px]">Fab Sew :</span>
                                <span className="flex-1 border-b border-black h-[22px]" />
                              </div>
                            </div>
                            <div className="flex items-baseline justify-between mt-1">
                              <span className="font-bold" style={{ fontSize: "13px" }}>Qty {s.qty}</span>
                              {s.totalPieces > 1 && (
                                <span className="font-semibold text-[#6B7280]" style={{ fontSize: "10px" }}>
                                  {s.pieceNo} of {s.totalPieces}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }
                // Default 180px compact tile for other dept tabs
                return (
                  <div
                    key={s.key}
                    className="flex-shrink-0 border border-[#E6E0D9] rounded-md bg-white flex flex-col items-center p-2"
                    style={{ width: "180px" }}
                    title={`${s.customerPOId || s.poNo} · ${s.model} · ${s.wipType} · ${s.wipName} · ${s.sizeLabel} · ${s.colour} · Qty ${s.qty}`}
                  >
                    <QRImg data={s.qrPayload} size={100} alt="Job card QR" className="block" />
                    <div
                      className="mt-1.5 text-center leading-tight w-full font-semibold tabular-nums truncate text-[#1F1D1B]"
                      style={{ fontSize: "11px" }}
                    >
                      {s.poNo}
                      {s.customerState ? ` · ${s.customerState}` : ""}
                    </div>
                    {s.model && (
                      <div
                        className="mt-0.5 text-center leading-tight w-full font-bold text-[#6B5C32] truncate"
                        style={{ fontSize: "11px" }}
                      >
                        Model {s.model}
                      </div>
                    )}
                    {s.wipName && (
                      <div
                        className="mt-1 text-center leading-snug w-full text-[#1F1D1B] break-words"
                        style={{ fontSize: "9px", minHeight: "25px" }}
                      >
                        WIP-{s.wipName}
                      </div>
                    )}
                    {s.leg && (
                      <div
                        className="text-center leading-tight w-full text-[#1F1D1B] truncate"
                        style={{ fontSize: "9px" }}
                      >
                        Leg-{s.leg}
                      </div>
                    )}
                    {s.specialOrder && (
                      <div
                        className="mt-0.5 text-center leading-tight w-full text-[#9A3A2D] font-semibold truncate"
                        style={{ fontSize: "9px" }}
                      >
                        ★ {s.specialOrder}
                      </div>
                    )}
                    <div
                      className="mt-1 text-center font-bold text-[#1F1D1B]"
                      style={{ fontSize: "10px" }}
                    >
                      Qty {s.qty}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      )}

      {/* FG Sticker preview — shown on PACKING only. One tile per physical
          box with SKU, size, fabric colour, PO no, customer, MFD, 100×100
          QR, piece-N-of-M, and short code. The BF vs SF piece numbering
          lives here (computed by /api/fg-units/generate/:poId — BF counts
          per-PO, SF counts SO-wide per commit 3185b48). Upholstery uses
          the JC-based QR row above because its 1184 component JCs don't
          map 1:1 to 663 FG units. */}
      {activeTab === "PACKING" && (
        <div className="rounded-lg border border-[#E6E0D9] bg-white">
          <div className="px-4 py-2.5 border-b border-[#E6E0D9] bg-[#FAF8F4] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-[#6B5C32]" />
              <h2 className="text-sm font-semibold text-[#1F1D1B]">
                FG Sticker Preview
                <span className="ml-2 text-xs font-normal text-[#8A7F73]">
                  {(() => {
                    // Two-source count, mirrors how UPH's QR Stickers
                    // header always carries onScreenStickers.length:
                    //   • Before the operator hits Show QR / Print All
                    //     (fgStickers not loaded yet) → estimate from
                    //     the sheet above. 1 grid row × qty = 1 box per
                    //     Wei Siang spec.
                    //   • After load → exact count from visibleFgStickers
                    //     (matches the grid filter, drops synthetic
                    //     Legs/Pillow tiles which are rendered as
                    //     children of their primary).
                    // Both branches stay in sync with whatever the body
                    // says (placeholder vs tiles vs "no match"), so the
                    // header never advertises a count the body can't
                    // back up.
                    if (fgStickers.length > 0) {
                      const realCount = visibleFgStickers.filter(
                        (s) => !s.isSyntheticLegs && !s.isSyntheticPillow,
                      ).length;
                      return `(${realCount} sticker${realCount === 1 ? "" : "s"} in ${activeDept?.name || activeTab})`;
                    }
                    const visibleRows = gridFilteredDeptRows ?? deptRows;
                    const qtySum = visibleRows.reduce(
                      (s, r) => s + ((r as { qty?: number }).qty ?? 0),
                      0,
                    );
                    return `(${qtySum} sticker${qtySum === 1 ? "" : "s"} in ${activeDept?.name || activeTab})`;
                  })()}
                </span>
              </h2>
            </div>
            {/* Show QR / Print All — mirrors the QR Stickers section on
                non-PACK dept tabs (line 4851). Tiles stay collapsed by
                default to keep tab entry fast (mounting 100+ <QRImg>s on
                every tab change is laggy); operator clicks Show QR when
                they actually need to scan/inspect. Print All triggers the
                same hidden #batch-fg-print path the toolbar button uses,
                and the print loop iterates `visibleFgStickers` so the
                grid filter is honoured (Wei Siang 2026-05-10). */}
            <div className="flex gap-2">
              {/* Buttons gated on deptRows (the sheet above), not on
                  fgStickers.length — the load is on-demand now, so
                  fgStickers is empty until the operator actually clicks.
                  Mirrors the UPH job-card panel where buttons appear as
                  soon as the dept has rows. */}
              {deptRows.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowFgPreview((v) => !v)}
                >
                  {showFgPreview ? "Hide QR" : "Show QR"}
                </Button>
              )}
              {deptRows.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePrintFgStickers}
                >
                  Print All
                </Button>
              )}
            </div>
          </div>
          {loadingFgPreview ? (
            <div className="px-4 py-8 text-center text-xs text-[#9A918A]">
              Loading FG units…
            </div>
          ) : fgStickers.length === 0 && !showFgPreview ? (
            // Default state on tab entry — nothing fetched yet. Mirrors
            // the UPH "X stickers ready · click Show QR" placeholder, but
            // without a count because we haven't loaded the FG units to
            // count from yet. Click Show QR or Print All triggers the
            // load via the on-demand effect above.
            <div className="px-4 py-6 text-center text-xs text-[#9A918A]">
              Click <span className="font-semibold text-[#6B5C32]">Show QR</span> to render the tiles for this filter.
            </div>
          ) : visibleFgStickers.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-[#9A918A]">
              No FG units match the current filter.
            </div>
          ) : !showFgPreview ? (
            <div className="px-4 py-6 text-center text-xs text-[#9A918A]">
              {visibleFgStickers.filter((s) => !s.isSyntheticLegs && !s.isSyntheticPillow).length} sticker{visibleFgStickers.filter((s) => !s.isSyntheticLegs && !s.isSyntheticPillow).length === 1 ? "" : "s"} ready · click <span className="font-semibold text-[#6B5C32]">Show QR</span> to render the tiles.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="flex gap-3 p-3 min-w-min">
                {visibleFgStickers.map((s) => {
                  // Paired secondary stickers (Legs after Compartment 1,
                  // Pillow after the LAST Compartment) render inside their
                  // pair partner's card — skip standalone.
                  if (s.isSyntheticLegs || s.isSyntheticPillow) return null;
                  const origin =
                    typeof window !== "undefined" && window.location?.origin
                      ? window.location.origin
                      : "";
                  const trackUrl = `${origin}/track?s=${encodeURIComponent(s.unitSerial)}`;
                  // Wei Siang 2026-05-15: drop the parent customer name
                  // when a hub is set — "Houzs Century (Houzs KL)" wrapped
                  // to two lines on the 100mm-wide sticker and ate too
                  // much space. The hub alone ("Houzs KL") is what the
                  // packer needs anyway. Falls back to customerName when
                  // hub is absent.
                  const customerLine = s.customerHub || s.customerName;
                  // Pair lookup — back-direction. Each secondary (Legs /
                  // Pillow) carries comboPairKey pointing to its primary;
                  // we find them by walking the list. Both Legs and
                  // Pillow render INSIDE their primary's tile (never as
                  // a standalone card) — operator wants 合成 not 分开.
                  const legsPair = visibleFgStickers.find(
                    (x) => x.isSyntheticLegs && x.comboPairKey === s.key,
                  );
                  const pillowPair = visibleFgStickers.find(
                    (x) => x.isSyntheticPillow && x.comboPairKey === s.key,
                  );
                  return (
                    <div
                      key={s.key}
                      className="flex-shrink-0 border border-[#E6E0D9] rounded-md bg-white flex flex-col p-2 overflow-hidden"
                      style={{ width: "230px", height: "380px" }}
                      title={`${s.customerName} — ${s.poNo} · ${s.sizeLabel} · piece ${s.pieceNo} of ${s.totalPieces}`}
                    >
                      {/* Wei Siang 2026-05-14 redesign — customer name takes
                          the top spot (was previously productCode), so
                          packers see who they're packing for at a glance.
                          Model + WIP live in the middle, measurements below,
                          QR + piece position at the bottom. Removed the
                          synthetic legs pair UI — each compartment sticker
                          carries its own Leg line so the separate "4/4 LEG"
                          sticker no longer prints. */}
                      <div className="text-center font-bold leading-tight" style={{ fontSize: "18px" }}>
                        {customerLine || s.customerName || "—"}
                      </div>
                      <div className="border-t border-black my-1" />
                      <div className="space-y-[2px] text-[13px] leading-tight text-[#1F1D1B]">
                        <div className="truncate"><span className="inline-block w-[72px] font-semibold text-[#6B7280]">PO No</span>: {s.customerPOId || "—"}</div>
                        <div className="truncate"><span className="inline-block w-[72px] font-semibold text-[#6B7280]">Cust Ref</span>: {s.customerRef || "—"}</div>
                        <div className="truncate"><span className="inline-block w-[72px] font-semibold text-[#6B7280]">Cust SO</span>: {s.customerSO || "—"}</div>
                        <div className="truncate"><span className="inline-block w-[72px] font-semibold text-[#6B7280]">Our SO No</span>: {s.salesOrderNo || "—"}</div>
                        <div className="flex items-baseline gap-1">
                          <span className="inline-block w-[72px] font-semibold text-[#6B7280]">Model</span>
                          <span className="font-bold" style={{ fontSize: "16px" }}>: {s.productCode || "—"}</span>
                        </div>
                        {s.boxLabel && (
                          <div className="flex items-baseline gap-1">
                            <span className="inline-block w-[72px] font-semibold text-[#6B7280] shrink-0">WIP</span>
                            <span
                              className="flex-1 break-words"
                              style={{
                                fontSize: "11px",
                                lineHeight: 1.2,
                              }}
                            >: {s.boxLabel}</span>
                          </div>
                        )}
                      </div>
                      <div className="border-t border-[#E6E0D9] my-1" />
                      <div className="space-y-[2px] text-[13px] leading-tight text-[#1F1D1B]">
                        <div className="truncate"><span className="inline-block w-[72px] font-semibold text-[#6B7280]">Size</span>: {s.sizeLabel || "—"}</div>
                        {s.itemCategory === "SOFA" && s.seatSize && (
                          <div className="truncate"><span className="inline-block w-[72px] font-semibold text-[#6B7280]">Seat</span>: {s.seatSize}"</div>
                        )}
                        <div className="truncate"><span className="inline-block w-[72px] font-semibold text-[#6B7280]">Colour</span>: {s.fabricCode || "—"}</div>
                        {s.itemCategory === "BEDFRAME" && (
                          <>
                            <div><span className="inline-block w-[72px] font-semibold text-[#6B7280]">Gap</span>: {s.gapInches != null ? `${s.gapInches}"` : "—"}</div>
                            <div><span className="inline-block w-[72px] font-semibold text-[#6B7280]">Divan</span>: {s.divanHeightInches != null ? `${s.divanHeightInches}"` : "—"}</div>
                          </>
                        )}
                        <div><span className="inline-block w-[72px] font-semibold text-[#6B7280]">Leg</span>: {s.legHeightInches != null && s.legHeightInches > 0 ? `${s.legHeightInches}"` : "—"}</div>
                        <div className="flex items-baseline gap-1">
                          <span className="inline-block w-[72px] font-semibold text-[#9A3A2D] shrink-0">Notes</span>
                          <span
                            className="flex-1 break-words"
                            style={{
                              fontSize: "11px",
                              lineHeight: 1.2,
                            }}
                          >: {s.specialOrder ? <span className="font-bold text-[#9A3A2D]">★ {s.specialOrder}</span> : "—"}</span>
                        </div>
                      </div>
                      {/* Wei Siang 2026-05-15 (revised again): leg moves
                          INTO the right column ABOVE the SOFA piece-name
                          / pieceNo. Single dashed separator at the top
                          of the bottom block (between Spec section and
                          this block). Pillow stays side-by-side. */}
                      <div className="mt-auto pt-1 border-t border-dashed border-[#6B5C32]">
                        <div className="flex items-end gap-2 pt-1">
                          <QRImg data={trackUrl} size={pillowPair ? 82 : 98} alt="FG unit QR" className="block" />
                          <div className="flex-1 text-center min-w-0 self-stretch flex flex-col justify-end">
                            {legsPair && (
                              <>
                                <div className="font-bold leading-tight" style={{ fontSize: "18px" }}>
                                  {legsPair.pieceNo}/{legsPair.totalPieces}
                                </div>
                                <div className="leading-tight uppercase font-semibold text-[#6B7280] mb-1" style={{ fontSize: "10px" }}>
                                  {legsPair.pieceName}
                                </div>
                              </>
                            )}
                            <div className="leading-tight truncate uppercase font-semibold text-[#6B7280]" style={{ fontSize: "10px" }}>
                              {s.pieceName || "Packing"}
                            </div>
                            <div className="font-bold leading-tight" style={{ fontSize: "22px" }}>
                              {s.pieceNo}/{s.totalPieces}
                            </div>
                            <div className="font-semibold mt-1 leading-tight truncate text-[#6B7280]" style={{ fontSize: "9px" }}>
                              {s.shortCode}
                            </div>
                          </div>
                          {pillowPair && (
                            <>
                              <div className="border-l border-dashed border-[#6B5C32] self-stretch" />
                              <div className="flex-1 text-center min-w-0 self-stretch flex flex-col justify-end">
                                <div className="font-bold leading-tight" style={{ fontSize: "16px" }}>
                                  {pillowPair.pieceNo}/{pillowPair.totalPieces}
                                </div>
                                <div className="leading-tight text-center uppercase" style={{ fontSize: "10px" }}>
                                  {pillowPair.pieceName}
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Single shared native date picker — see sharedDateInputRef above.
          One input node replaces ~3k per-cell inputs for much smoother
          clicking on the Overview matrix and dept pill columns. Position
          is driven entirely by inline style set inside openDatePicker so
          the calendar pops anchored to the clicked cell — no Tailwind
          left/bottom utilities here, they would override the inline
          coords and pin the popup to the corner of the viewport.
          NOTE: pointer-events MUST stay enabled (was 'none' until the
          2026-05-10 bug fix). With pointer-events:none, Chromium silently
          dropped the `change` event when the user picked a date so
          patchJobCard never fired. At 1×1 in the corner
          the input can't be reached by an actual cursor click — the
          original concern that prompted pointer-events:none doesn't
          apply. The change handler is bound natively in a useEffect
          above (NOT via React onChange) to bypass synthetic-event
          delegation races. opacity:0.001 instead of 0 — some browsers
          treat 0-opacity as render-skipped which can also drop events. */}
      <input
        ref={sharedDateInputRef}
        type="date"
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          width: 1,
          height: 1,
          opacity: 0.001,
        }}
        tabIndex={-1}
        aria-hidden
      />

      {/* Batch Job Card stickers — page size + layout switches by dept.
          Both FAB_CUT and FAB_SEW print on 100×150mm with the mockup-3
          layout (Wei Siang 2026-05-15: "Fabric Sewing 的 sticker 没有
          根据我上面说的去做" — the same big sticker with two sign-off
          lines should print at both Fab Cut AND Fab Sew). Every other
          dept stays on the existing 50×75mm thermal layout. */}
      {jobCardStickers.length > 0 && (() => {
        const useLargeSticker = activeTab === "FAB_CUT" || activeTab === "FAB_SEW";
        return (
        <>
          <style>{`
            @media print {
              @page { size: ${useLargeSticker ? "100mm 150mm" : "50mm 75mm"}; margin: 0; }
              /* visibility: hidden on ancestors still lets visible:visible
                 descendants render. display:none would clip the whole chain,
                 which is why the old body>* selector produced a blank page
                 when the container was nested inside layout wrappers. */
              html, body { background: #fff !important; }
              body * { visibility: hidden !important; }
              #batch-jobcard-print,
              #batch-jobcard-print * { visibility: visible !important; }
              #batch-jobcard-print {
                position: absolute !important;
                left: 0 !important; top: 0 !important;
                width: ${useLargeSticker ? "100mm" : "50mm"} !important;
                margin: 0 !important; padding: 0 !important;
              }
              .sticker-jc-page {
                width: ${useLargeSticker ? "100mm" : "50mm"} !important;
                height: ${useLargeSticker ? "150mm" : "75mm"} !important;
                page-break-after: always;
                break-after: page;
                margin: 0 !important;
                padding: ${useLargeSticker ? "4mm" : "2mm"} !important;
                overflow: hidden;
              }
              .sticker-jc-page:last-child {
                page-break-after: auto;
                break-after: auto;
              }
            }
          `}</style>
          <div id="batch-jobcard-print" className="hidden print:block">
            {jobCardStickers.map((s) => useLargeSticker ? (
              // ----- FAB_CUT 100×150mm sticker (mockup #3) -----
              <div
                key={s.key}
                className="sticker-jc-page bg-white text-black"
                style={{ width: "100mm", height: "150mm" }}
              >
                <div className="w-full h-full flex flex-col" style={{ fontSize: "9pt" }}>
                  {/* Wei Siang 2026-05-15: mirror the FG sticker shape
                      exactly — same density, same proportions, same
                      mt-auto bottom block. Title = our line-suffixed
                      SO No. Bottom block swaps FG's "QR + piece
                      position" for Fab Cut's "QR + sign-off lines +
                      Qty". */}
                  <div className="text-center font-bold" style={{ fontSize: "14pt", lineHeight: 1.1 }}>
                    {s.poNo}
                  </div>
                  {/* Wei Siang 2026-05-15: uniform template — long-value
                      rows (Customer Name, WIP, Notes) use smaller value
                      font + truncate so they stay on 1 line per sticker
                      regardless of content length. Print mirrors the
                      on-screen tile. */}
                  <div className="border-t border-black my-[1.5mm]" />
                  <div className="space-y-[1mm]" style={{ fontSize: "11pt", lineHeight: 1.3 }}>
                    <div className="truncate"><span className="inline-block w-[35mm] font-semibold">PO No</span>: {s.customerPOId || "—"}</div>
                    <div className="flex items-baseline gap-[1mm]">
                      <span className="inline-block w-[35mm] font-semibold shrink-0">Customer Name</span>
                      <span
                        className="flex-1 break-words"
                        style={{
                          fontSize: "11pt",
                          lineHeight: 1.2,
                        }}
                      >: {s.customerName || "—"}</span>
                    </div>
                    <div className="flex items-baseline gap-[1mm]">
                      <span className="inline-block w-[35mm] font-semibold">Model</span>
                      <span className="font-bold" style={{ fontSize: "15pt" }}>: {s.model || "—"}</span>
                    </div>
                    {s.wipName && (
                      <div className="flex items-baseline gap-[1mm]">
                        <span className="font-semibold shrink-0" style={{ width: "35mm" }}>WIP</span>
                        <span
                          className="flex-1 break-words"
                          style={{
                            fontSize: "11pt",
                            lineHeight: 1.2,
                          }}
                        >: {s.wipName}</span>
                      </div>
                    )}
                  </div>
                  <div className="border-t border-[#E6E0D9] my-[1.5mm]" />
                  <div className="space-y-[1mm]" style={{ fontSize: "11pt", lineHeight: 1.3 }}>
                    <div className="truncate"><span className="inline-block w-[35mm] font-semibold">Size</span>: {s.sizeLabel || "—"}</div>
                    <div className="truncate"><span className="inline-block w-[35mm] font-semibold">Colour</span>: {s.colour || "—"}</div>
                    {s.gap && <div><span className="inline-block w-[35mm] font-semibold">Gap</span>: {s.gap}</div>}
                    {s.divan && <div><span className="inline-block w-[35mm] font-semibold">Divan</span>: {s.divan}</div>}
                    {s.leg && <div><span className="inline-block w-[35mm] font-semibold">Leg</span>: {s.leg}</div>}
                    {s.totalHeight && <div><span className="inline-block w-[35mm] font-semibold">Total H</span>: {s.totalHeight}</div>}
                    <div className="flex items-baseline gap-[1mm]">
                      <span className="font-semibold shrink-0" style={{ width: "35mm", color: "#9A3A2D" }}>Notes</span>
                      <span
                        className="flex-1 break-words"
                        style={{
                          fontSize: "11pt",
                          lineHeight: 1.2,
                        }}
                      >
                        : {s.specialOrder ? <span className="font-bold" style={{ color: "#9A3A2D" }}>★ {s.specialOrder}</span> : "—"}
                      </span>
                    </div>
                  </div>
                  {/* Bottom block — same shape as FG sticker, mt-auto +
                      dashed top border + QR (left) + content (right).
                      Content is Fab Cut / Fab Sew sign-off lines + Qty.
                      Wei Siang 2026-05-15: top info bigger (11pt rows,
                      30mm label column) and sign-off lines need more
                      breathing room — taller writing area (10mm) and
                      bigger gap between Cutting / Sewing rows (6mm). */}
                  <div className="mt-auto pt-[1.5mm] border-t border-dashed border-black">
                    <div className="flex items-end gap-[2mm] pt-[1.5mm]">
                      {s.qrDataUrl && (
                        <img
                          src={s.qrDataUrl}
                          alt="Job card QR"
                          style={{ width: "34mm", height: "34mm" }}
                          className="shrink-0"
                        />
                      )}
                      <div className="flex-1 min-w-0 self-stretch flex flex-col justify-between" style={{ fontSize: "11pt" }}>
                        <div className="space-y-[6mm]">
                          <div className="flex items-end gap-[1.5mm]">
                            <span className="font-semibold whitespace-nowrap">Fabric Cutting :</span>
                            <span className="flex-1 border-b border-black h-[10mm]" />
                          </div>
                          <div className="flex items-end gap-[1.5mm]">
                            <span className="font-semibold whitespace-nowrap">Fabric Sewing :</span>
                            <span className="flex-1 border-b border-black h-[10mm]" />
                          </div>
                        </div>
                        <div className="flex items-baseline justify-between mt-[2mm]" style={{ fontSize: "13pt" }}>
                          <span className="font-bold">Qty {s.qty}</span>
                          {s.totalPieces > 1 && (
                            <span className="font-semibold" style={{ fontSize: "9pt" }}>
                              Piece {s.pieceNo} of {s.totalPieces}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              // ----- Default 50×75mm sticker (other depts) -----
              <div
                key={s.key}
                className="sticker-jc-page bg-white text-black flex flex-col items-center"
                style={{ width: "50mm", height: "75mm" }}
              >
                <img
                  src={s.qrDataUrl}
                  alt="Job card QR"
                  style={{ width: "30mm", height: "30mm" }}
                />
                <div
                  className="font-bold text-center leading-tight w-full"
                  style={{ fontSize: "9pt", marginTop: "1mm" }}
                >
                  {s.poNo}{s.customerState ? ` · ${s.customerState}` : ""}
                </div>
                {s.model && (
                  <div
                    className="font-bold text-center leading-tight w-full"
                    style={{ fontSize: "8pt" }}
                  >
                    Model {s.model}
                  </div>
                )}
                <div
                  className="text-center leading-snug w-full"
                  style={{ fontSize: "7pt", marginTop: "0.5mm", wordBreak: "break-word" }}
                >
                  {s.wipName && (
                    <div style={{ minHeight: "5mm" }}>WIP-{s.wipName}</div>
                  )}
                  {s.leg && <div style={{ marginTop: "0.5mm" }}>Leg-{s.leg}</div>}
                </div>
                {s.specialOrder && (
                  <div
                    className="font-bold text-center leading-tight w-full"
                    style={{ fontSize: "7pt", color: "#9A3A2D" }}
                  >
                    ★ {s.specialOrder}
                  </div>
                )}
                <div
                  className="font-bold text-center leading-tight w-full"
                  style={{ fontSize: "8pt", marginTop: "auto" }}
                >
                  {s.totalPieces > 1
                    ? `Piece ${s.pieceNo} of ${s.totalPieces}`
                    : `Qty ${s.qty}`}
                </div>
              </div>
            ))}
          </div>
        </>
        );
      })()}

      {/* Batch FG stickers — one 100×150mm page per filtered PO. Iterates
          `visibleFgStickers` (grid-filter scoped) so Print All on the
          PACKING tab honours whatever the operator has narrowed the grid
          down to (Wei Siang 2026-05-10). */}
      {visibleFgStickers.length > 0 && (
        <>
          <style>{`
            @media print {
              @page { size: 100mm 150mm; margin: 0; }
              /* See jobcard block — visibility trick works through any
                 layout nesting, display: none would hide the whole chain. */
              html, body { background: #fff !important; }
              body * { visibility: hidden !important; }
              #batch-fg-print,
              #batch-fg-print * { visibility: visible !important; }
              #batch-fg-print {
                position: absolute !important;
                left: 0 !important; top: 0 !important;
                width: 100mm !important;
                margin: 0 !important; padding: 0 !important;
              }
              .sticker-fg-page {
                width: 100mm !important; height: 150mm !important;
                page-break-after: always;
                break-after: page;
                margin: 0 !important; padding: 4mm !important;
                overflow: hidden;
              }
              .sticker-fg-page:last-child {
                page-break-after: auto;
                break-after: auto;
              }
            }
          `}</style>
          {/* Hidden-by-default print container. Only mount the heavy
              <QRImg> tree when the operator actually clicks Print All,
              not on every Packing tab entry. Pre-fix: visibleFgStickers
              was iterated unconditionally — `className="hidden"` removes
              the page from layout but React still constructs every
              component, and even with QRImg's IntersectionObserver gate
              the React reconciliation of ~1000 siblings made tab entry
              feel like the QR grid was opening (Wei Siang 2026-05-10:
              "一打开就直接 show 出来会很卡"). The handlePrintFgStickers
              path flips fgPrintRequested true, the useTimeout below
              fires window.print() at ~1500ms — enough time for the
              `eager` <QRImg> instances inside this hidden container to
              generate all their data URLs synchronously on mount. The
              eager flag is required: IntersectionObserver never fires
              inside a `display: none` parent (operator-reported blank
              FG sticker bug 2026-05-12), so the on-screen lazy gate
              would leave every QR stuck as a gray placeholder.
              Reset 500ms after print closes wipes the tree again. */}
          <div id="batch-fg-print" className="hidden print:block">
            {fgPrintRequested && visibleFgStickers.map((s) => {
              // Paired secondaries (Legs / Pillow) print inside their
              // primary's page — skip standalone.
              if (s.isSyntheticLegs || s.isSyntheticPillow) return null;
              const origin =
                typeof window !== "undefined" && window.location?.origin
                  ? window.location.origin
                  : "";
              const trackUrl = `${origin}/track?s=${encodeURIComponent(s.unitSerial)}`;
              // Hub-only when set — see on-screen tile comment above.
              const customerLine = s.customerHub || s.customerName;
              // Legs / Pillow render INSIDE their primary's print page —
              // never as a standalone .sticker-fg-page (Wei Siang spec:
              // FG sticker 是要合成逻辑的). The standalone case is
              // filtered out above with `if (s.isSyntheticLegs ||
              // s.isSyntheticPillow) return null;`.
              const legsPair = visibleFgStickers.find(
                (x) => x.isSyntheticLegs && x.comboPairKey === s.key,
              );
              const pillowPair = visibleFgStickers.find(
                (x) => x.isSyntheticPillow && x.comboPairKey === s.key,
              );
              return (
                <div
                  key={s.key}
                  className="sticker-fg-page bg-white text-black"
                  style={{ width: "100mm", height: "150mm" }}
                >
                  <div className="w-full h-full flex flex-col" style={{ fontSize: "10pt" }}>
                    {/* Wei Siang 2026-05-14 redesign — customer name big
                        at the top, identifiers + measurements stacked
                        below, QR + piece position pinned to the bottom.
                        See the on-screen tile above for the same shape. */}
                    <div className="text-center font-bold" style={{ fontSize: "22pt", lineHeight: 1.1 }}>
                      {customerLine || s.customerName || "—"}
                    </div>
                    <div className="border-t-2 border-black my-[2mm]" />
                    <div className="space-y-[1.5mm]" style={{ fontSize: "14pt", lineHeight: 1.25 }}>
                      <div><span className="inline-block w-[30mm] font-semibold">PO No</span>: {s.customerPOId || "—"}</div>
                      <div><span className="inline-block w-[30mm] font-semibold">Cust Ref</span>: {s.customerRef || "—"}</div>
                      <div><span className="inline-block w-[30mm] font-semibold">Cust SO</span>: {s.customerSO || "—"}</div>
                      <div><span className="inline-block w-[30mm] font-semibold">Our SO No</span>: {s.salesOrderNo || "—"}</div>
                      <div className="flex items-baseline gap-[1mm]">
                        <span className="inline-block w-[30mm] font-semibold">Model</span>
                        <span className="font-bold" style={{ fontSize: "20pt" }}>: {s.productCode || "—"}</span>
                      </div>
                      {s.boxLabel && (
                        <div className="flex items-baseline gap-[1mm]">
                          <span className="font-semibold shrink-0" style={{ width: "30mm" }}>WIP</span>
                          <span
                            className="flex-1 break-words"
                            style={{
                              fontSize: "11pt",
                              lineHeight: 1.2,
                            }}
                          >: {s.boxLabel}</span>
                        </div>
                      )}
                    </div>
                    <div className="border-t border-black my-[2mm]" />
                    <div className="space-y-[1.5mm]" style={{ fontSize: "14pt", lineHeight: 1.25 }}>
                      <div><span className="inline-block w-[30mm] font-semibold">Size</span>: {s.sizeLabel || "—"}</div>
                      {s.itemCategory === "SOFA" && s.seatSize && (
                        <div><span className="inline-block w-[30mm] font-semibold">Seat</span>: {s.seatSize}"</div>
                      )}
                      <div><span className="inline-block w-[30mm] font-semibold">Colour</span>: {s.fabricCode || "—"}</div>
                      {s.itemCategory === "BEDFRAME" && (
                        <>
                          <div><span className="inline-block w-[30mm] font-semibold">Gap</span>: {s.gapInches != null ? `${s.gapInches}"` : "—"}</div>
                          <div><span className="inline-block w-[30mm] font-semibold">Divan</span>: {s.divanHeightInches != null ? `${s.divanHeightInches}"` : "—"}</div>
                        </>
                      )}
                      <div><span className="inline-block w-[30mm] font-semibold">Leg</span>: {s.legHeightInches != null && s.legHeightInches > 0 ? `${s.legHeightInches}"` : "—"}</div>
                      <div className="flex items-baseline gap-[1mm]">
                        <span className="font-semibold shrink-0" style={{ width: "30mm", color: "#9A3A2D" }}>Notes</span>
                        <span
                          className="flex-1 break-words"
                          style={{
                            fontSize: "11pt",
                            lineHeight: 1.2,
                          }}
                        >
                          : {s.specialOrder ? <span className="font-bold" style={{ color: "#9A3A2D" }}>★ {s.specialOrder}</span> : "—"}
                        </span>
                      </div>
                    </div>
                    {/* Wei Siang 2026-05-15 (revised again): leg moves
                        INTO the right column ABOVE the main piece
                        name / pieceNo. Single dashed separator at the
                        top of this bottom block. Pillow stays side-
                        by-side. Same 100×150mm physical card. */}
                    <div className="mt-auto pt-[2mm] border-t border-dashed border-black">
                      <div className="flex items-end gap-[2mm] pt-[2mm]">
                        <QRImg eager data={trackUrl} size={pillowPair ? 98 : 150} alt="FG unit QR" className="block" />
                        <div className="flex-1 text-center min-w-0">
                          {legsPair && (
                            <>
                              <div className="font-bold" style={{ fontSize: "22pt", lineHeight: 1 }}>
                                {legsPair.pieceNo}/{legsPair.totalPieces}
                              </div>
                              <div className="font-bold uppercase mb-[2mm]" style={{ fontSize: "12pt" }}>
                                {legsPair.pieceName}
                              </div>
                            </>
                          )}
                          <div className="uppercase font-semibold" style={{ fontSize: "11pt" }}>
                            {s.pieceName || "Packing"}
                          </div>
                          <div className="font-bold" style={{ fontSize: pillowPair || legsPair ? "22pt" : "28pt", lineHeight: 1 }}>
                            {s.pieceNo}/{s.totalPieces}
                          </div>
                          <div className="font-semibold mt-[1mm]" style={{ fontSize: "9pt" }}>
                            {s.shortCode}
                          </div>
                        </div>
                        {pillowPair && (
                          <>
                            <div className="border-l border-dashed border-black self-stretch" />
                            <div className="flex flex-col items-center justify-end flex-1 min-w-0">
                              <div className="font-bold text-center" style={{ fontSize: "20pt", lineHeight: 1 }}>
                                {pillowPair.pieceNo}/{pillowPair.totalPieces}
                              </div>
                              <div className="font-bold text-center uppercase mt-[1mm]" style={{ fontSize: "12pt" }}>
                                {pillowPair.pieceName}
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Stock PO creation modal — mounted at the root so it overlays
          everything else. Uses backend /historical-wips and /historical-fgs
          for the picker, then POSTs to /stock to clone the source PO's
          JobCards under a fresh SOH-YYMM-NNN placeholder SO. */}
      <CreateStockPODialog
        open={stockDialogOpen}
        onClose={() => setStockDialogOpen(false)}
        onCreated={fetchOrders}
      />

      {/* PatchFailureModal removed 2026-05-12 — failures now surface as
          toast.error from flushDrafts. Cell auto-reverts on failure, so the
          operator sees the value disappear + the toast at the same time. */}
    </div>
  );
}
