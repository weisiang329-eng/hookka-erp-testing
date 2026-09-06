import { useState, useEffect, useLayoutEffect, useCallback, useDeferredValue, useMemo, useRef, useTransition, startTransition, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useUrlState, useUrlBatch } from "@/lib/use-url-state";
import { useSessionState } from "@/lib/use-session-state";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Plus, Lock, ExternalLink, Filter } from "lucide-react";
import { DataGrid } from "@/components/ui/data-grid";
import type { Column, ContextMenuItem } from "@/components/ui/data-grid";
import { getQRCodeDataURL, generateStickerData, generateCompartmentStickerData } from "@/lib/qr-utils";
import { appOrigin } from "@/lib/app-origin";
import { todayYmdMY } from "@/lib/utils";
import { deriveBarcodeToken } from "@/lib/job-card-id";
import { packingRackScanUrl } from "@/api/lib/jobcard-qr-token";
// Static import (not dynamic) so the schedule code is generated SYNCHRONOUSLY
// inside the print click gesture — an await before window.open would trip the
// pop-up blocker. `qrcode` is already a dependency (the sticker QRs use it), so
// this adds no new chunk. Its toCanvas(canvas, text, opts, cb) overload runs
// fully synchronously when a callback is passed (see jobCardQrDataUrl below).
import JsBarcode from "jsbarcode";
import { QRImg } from "@/components/qr-img";
import { useCachedJson, invalidateCachePrefix, isUnknownOutcome } from "@/lib/cached-fetch";
// useTimeout — P4.3 effect-replacement (still referenced at L2386+).
import { useTimeout } from "@/lib/scheduler";
import { useToast } from "@/components/ui/toast";
import { getCurrentUser } from "@/lib/auth";
import { readCsrfCookie, CSRF_HEADER_NAME } from "@/lib/csrf";
import { workerCoversDept } from "@/lib/worker";
import { fetchVariantsConfig } from "@/lib/kv-config";
import { legPacksSeparately, type LegHeightOption } from "@/lib/leg-packing";
import { jcMinutesTotal } from "@/lib/job-card-minutes";

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

// `Worker` from ./types is the employee/worker RECORD type — aliased to
// WorkerRec here so the DOM `Worker` global (used for the baseRows compute
// Web Worker, Phase 2) is not shadowed inside this module.
import type { CellState, JobCard, ProductionOrder, Worker as WorkerRec, DeptRow, DeptSched } from "./types";
import {
  DEPARTMENTS,
  cellFor,
  fmtShortDate,
  todayISO,
} from "./utils";
import type { BaseRowsResponse } from "./baserows.worker";
// Pure row-builder shared with baserows.worker.ts. The FAB_SEW sticker
// loader (Fab Cut tab) runs this synchronously on a freshly-fetched,
// all-dept order set so its DeptRow output is byte-identical to the grid's
// — see loadFabSewStickers.
import { buildOnePickerEntry, buildBaseRows, type PickerByDept } from "./baserows-core";
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
  | "qty" | "customerDD" | "ourExpectedDD"
  | "FAB_CUT" | "FAB_SEW" | "FOAM_CUTTING" | "FOAM" | "WOOD_CUT"
  | "FRAMING" | "WEBBING" | "UPHOLSTERY" | "PACKING";
type OverviewSort = { key: OverviewSortKey; dir: "asc" | "desc" } | null;

// ----- Overview matrix: user-resizable column widths -----
// Wei Siang 2026-05-29: drag a header's right edge to resize; double-click to
// reset. Widths persist per-browser in localStorage. Shared with every header
// cell via context so we don't thread two callbacks through 15 call sites.
// Render a WIP's SHORT 10-digit barcode token (`<deptNN><8hash>`) as a 1D
// Code 128 barcode PNG data URL, SYNCHRONOUSLY, for the Production Schedule print.
//
// History: a 2026-06-24 change had switched this to a QR (the OLD Code 128 of a
// LONGER id needed ~70mm to stay PHONE-scannable → only 3-4 per row). Owner
// 2026-06-25: the floor scans the printed schedule with a 1D BARCODE GUN, not a
// phone — so Code 128 is right (guns read 1D faster + at finer bar widths than a
// phone camera, and the gun was the actual scan tool all along). Encoding the
// SHORT 10-digit token keeps the bars narrow enough to fit the column (the old
// too-wide complaint was a long id). The ENCODED VALUE is unchanged
// (deriveBarcodeToken), so the scanner's parseJobCardBarcode + the worker.ts /
// public-rack-qr.ts dept-scoped re-derivation resolve it with zero change, and
// the sticker QR flows (getQRCodeDataURL) are untouched — only the schedule's 1D
// column reverts.
//
// JsBarcode draws synchronously to the canvas, so there is no await before
// window.open and the pop-up blocker is never tripped. "" on failure so a bad
// row never blocks the print.
function jobCardBarcodeDataUrl(token: string): string {
  try {
    const canvas = document.createElement("canvas");
    JsBarcode(canvas, token, {
      format: "CODE128",
      // RENDER resolution (canvas px per module) — NOT the print width. The
      // print CSS (td.bc img, ~116px) sets the DISPLAY size, so a HIGH value here
      // only makes the source bitmap crisp; a low value printed blurry /
      // unscannable (owner 2026-06-25 "很模糊?會敏感嗎?"). 4px/module = sharp +
      // gun-scannable; the displayed barcode stays the same narrow ~116px.
      width: 4,
      height: 100,
      // The human WIP caption prints below the cell (.bccode), so the bars need
      // no embedded text.
      displayValue: false,
      // Quiet zone — REQUIRED for a scanner to lock on; survives edge clipping.
      margin: 8,
    });
    return canvas.toDataURL("image/png");
  } catch {
    return "";
  }
}

const OVERVIEW_FIXED_COLS = ["soId", "product", "customer", "customerPO", "specialOrder", "qty", "customerDD", "ourExpectedDD"] as const;
const OVERVIEW_COL_KEYS: string[] = [...OVERVIEW_FIXED_COLS, ...DEPARTMENTS.map((d) => d.code)];
const OVERVIEW_DEFAULT_WIDTHS: Record<string, number> = {
  soId: 120, product: 220, customer: 110, customerPO: 120, specialOrder: 130, qty: 50, customerDD: 104, ourExpectedDD: 118,
  FAB_CUT: 108, FAB_SEW: 108, FOAM_CUTTING: 108, FOAM: 108, WOOD_CUT: 108, FRAMING: 108, WEBBING: 108, UPHOLSTERY: 108, PACKING: 108,
};
const OVERVIEW_COLW_STORAGE = "prod-overview-colwidths-v1";
// Width (px) of the leading multi-select checkbox gutter prepended to the
// Overview matrix grid. Kept OUT of OVERVIEW_COL_KEYS so it isn't sortable,
// filterable, or resizable — it's a fixed gutter, not a data column. The
// header + every body row prepend a `${OVERVIEW_SELECT_COL_W}px` track to
// the shared grid template so they stay column-aligned. (Wei Siang 2026-06-03:
// batch set-due-date on the Overview, mirroring the dept sheet + tracker.)
const OVERVIEW_SELECT_COL_W = 36;
const OverviewResizeCtx = createContext<{ start: (e: React.MouseEvent, key: string) => void; reset: (key: string) => void } | null>(null);

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
  const overviewResize = useContext(OverviewResizeCtx);
  // Portal the filter popover to <body> with fixed positioning anchored to the
  // funnel button. Required because the matrix now lives inside a horizontal
  // scroll container — an in-flow absolute popover would be clipped by that
  // overflow box. Re-anchors on scroll/resize so it tracks the button.
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const [popPos, setPopPos] = useState<{ top: number; left: number } | null>(null);
  /* eslint-disable react-hooks/set-state-in-effect -- measure-then-position a
     portaled popover before paint; synchronous setState inside useLayoutEffect
     is the intended pattern for anchoring an element to a measured DOM rect. */
  useLayoutEffect(() => {
    if (!open) { setPopPos(null); return; }
    const place = () => {
      const r = filterBtnRef.current?.getBoundingClientRect();
      if (!r) return;
      const PANEL_W = 200;
      const left = Math.max(8, Math.min(r.right - PANEL_W, window.innerWidth - PANEL_W - 8));
      setPopPos({ top: r.bottom + 4, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */
  return (
    <div
      data-ovh
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
          ref={filterBtnRef}
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
      {open && popPos && createPortal(
        <>
          {/* Outside-click capture overlay so the popover dismisses cleanly.
              Portaled to <body> (with the panel) so the horizontal-scroll
              container around the matrix can't clip it. */}
          <div
            className="fixed inset-0 z-[60]"
            onClick={() => setOpenFilterCol(null)}
          />
          <div
            className="fixed z-[61] bg-white border border-[#E6E0D9] rounded-md shadow-lg p-3 min-w-[180px] normal-case tracking-normal text-[12px] font-normal text-[#1F1D1B]"
            style={{ top: popPos.top, left: popPos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            {renderFilter()}
          </div>
        </>,
        document.body,
      )}
      {overviewResize && (
        <span
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize · double-click to reset"
          onMouseDown={(e) => overviewResize.start(e, filterCol)}
          onDoubleClick={(e) => { e.stopPropagation(); overviewResize.reset(filterCol); }}
          onClick={(e) => e.stopPropagation()}
          className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize select-none hover:bg-[#6B5C32]/40 z-10"
        />
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

// Component-type badge label for a job-card sticker (HB / Divan / Base /
// Armrest / Cushion / Leg), or null when the piece doesn't map to one of the
// six (whole/full product, HEADREST, untyped/accessory). Derived from the
// SAME normalized wipType the grid already produced (baserows-core.ts), with a
// case-insensitive wipName fallback for legs / un-typed bedframe rows. Shared
// by BOTH the printed 100×150mm Fab Cut/Sew sticker AND the on-screen QR
// Stickers preview tile so the two never drift — see the print badge call site
// in the large-sticker branch and renderLargeStickerTile.
function componentBadgeLabel(s: { wipType?: string; wipName?: string }): string | null {
  const wt = (s.wipType || "").toUpperCase();
  const wn = (s.wipName || "").toUpperCase();
  // Primary: the normalized wipType the grid already derived.
  if (wt === "HB" || wt === "HEADBOARD") return "HB";
  if (wt === "DIVAN") return "Divan";
  if (wt === "BASE" || wt === "SOFA_BASE") return "Base";
  if (wt === "ARMREST" || wt === "SOFA_ARMREST") return "Armrest";
  if (wt === "CUSHION" || wt === "SOFA_CUSHION") return "Cushion";
  if (wt === "LEG") return "Leg";
  // Fallback: match the WIP description text (case-insensitive) for rows where
  // wipType is blank or a leg piece.
  if (/\bDIVAN\b/.test(wn)) return "Divan";
  if (/HEADBOARD|\bHB\b/.test(wn)) return "HB";
  if (/ARM\s?REST|ARMREST|\b(LEFT|RIGHT)\s+ARM\b/.test(wn)) return "Armrest";
  if (/CUSHION/.test(wn)) return "Cushion";
  if (/\bLEG\b/.test(wn)) return "Leg";
  if (/\bBASE\b/.test(wn)) return "Base";
  // No confident match → omit the badge.
  return null;
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
  const { confirm } = useConfirm();
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
  const { data: workersResp } = useCachedJson<{ success?: boolean; data?: WorkerRec[] }>("/api/workers");
  const { data: warehouseResp } = useCachedJson<{ success?: boolean; data?: Array<{ rack: string; status: string; productCode?: string; customerName?: string }> }>("/api/warehouse");
  // OEM Tag/Label marking — per customer × category (customers.oem_marking).
  // Shown on the Fab Cut / Fab Sew sticker Notes so the line knows to attach
  // the customer's tag or label. Matched by customer NAME + product category,
  // so SO and Consignment stickers behave identically.
  const { data: customersResp } = useCachedJson<{ data?: Array<{ name?: string; oemMarking?: { bedframe?: string; sofa?: string; accessory?: string } }> }>("/api/customers");
  const custOemMap = useMemo(() => {
    const m = new Map<string, { bedframe: string; sofa: string; accessory: string }>();
    for (const cst of customersResp?.data ?? []) {
      if (cst.name)
        m.set(cst.name, {
          bedframe: cst.oemMarking?.bedframe ?? "NONE",
          sofa: cst.oemMarking?.sofa ?? "NONE",
          accessory: cst.oemMarking?.accessory ?? "NONE",
        });
    }
    return m;
  }, [customersResp]);
  const custOemRef = useRef(custOemMap);
  custOemRef.current = custOemMap;
  const oemMarkFor = (row: {
    customerName?: string;
    /** Production-sheet rows carry `itemCategory`… */
    itemCategory?: string;
    /** …while a sticker carries the same value as `category`. */
    category?: string;
  }): string => {
    // Read BOTH. This function was written against the production-sheet row
    // and then called only with STICKERS, which name the field `category` —
    // so `itemCategory` was always undefined, `key` was always "", and the
    // OEM tag never printed for anyone. Owner 2026-08-06: Houzs Century is
    // set to TAG for sofa and SO-2608-082-01 came out with no tag on it.
    const cat = (row.itemCategory || row.category || "").toUpperCase();
    const key = cat === "BEDFRAME" ? "bedframe" : cat === "SOFA" ? "sofa" : cat === "ACCESSORY" ? "accessory" : "";
    if (!key) return "";
    const mk = custOemRef.current.get(row.customerName || "");
    const v = mk?.[key as "bedframe" | "sofa" | "accessory"];
    return v === "TAG" || v === "LABEL" ? v : "";
  };
  const [orders, setOrders] = useState<ProductionOrder[]>([]);

  // Phase 2 — baseRows Web Worker state. Declared here (with the other
  // state hooks) so the filter-row "Updating…" hint can read
  // `baserowsPending`; the effects that instantiate the worker, post
  // inputs to it, and consume its replies live further down by the
  // `deptRows` derivation. See baserows.worker.ts.
  const baserowsWorkerRef = useRef<Worker | null>(null);
  // Monotonically increasing request id. Each post carries the next id;
  // only the reply whose id === baserowsReqRef.current is accepted, so a
  // stale result from a superseded post (operator changed the filter
  // again mid-compute) is dropped instead of flashing outdated rows.
  const baserowsReqRef = useRef(0);
  // Phase 3 — incremental picker-index cache. The worker keeps a per-PO
  // picker-index cache and rebuilds an entry only for POs whose jobCards
  // actually changed; a pure filter / dept change rebuilds nothing. To
  // drive that, the page diffs `orders` PO-by-PO whenever the array
  // reference changes: every optimistic edit / batch / refetch does
  // `prev.map(o => o.id !== id ? o : {...o})`, so an UNCHANGED PO keeps
  // its object identity and a CHANGED PO gets a fresh reference. A
  // reference-level diff therefore yields the exact set of POs the worker
  // must re-index. `pendingDirtyPoIdsRef` accumulates those ids across
  // every render until the post effect consumes (and clears) them — more
  // than one render can land between two worker posts.
  const ordersIdentityRef = useRef<ProductionOrder[] | null>(null);
  const prevOrdersByIdRef = useRef<Map<string, ProductionOrder>>(new Map());
  const pendingDirtyPoIdsRef = useRef<Set<string>>(new Set());
  if (ordersIdentityRef.current !== orders) {
    const prevById = prevOrdersByIdRef.current;
    const nextById = new Map<string, ProductionOrder>();
    for (const o of orders) {
      nextById.set(o.id, o);
      // A PO is dirty when it's new or its object reference changed
      // (a JC was patched on it). Unchanged POs keep their identity.
      if (prevById.get(o.id) !== o) pendingDirtyPoIdsRef.current.add(o.id);
    }
    ordersIdentityRef.current = orders;
    prevOrdersByIdRef.current = nextById;
  }
  // The worker's most recent result. Starts empty — a brief empty grid on
  // the very first compute is acceptable; on later recomputes the previous
  // rows stay rendered until the new ones land, so a filter change never
  // flashes the grid to empty.
  const [baseRows, setBaseRows] = useState<Array<DeptRow & { _deptCode: string }>>([]);
  // True between posting inputs to the worker and receiving the matching
  // reply. Wired to the existing "Updating…" hint in the filter row.
  const [baserowsPending, setBaserowsPending] = useState(false);

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
  const [workers, setWorkers] = useState<WorkerRec[]>([]);
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
  // fltCategory hoisted up here (from ~853) for the same reason — it's
  // now baked into the server-side fetch URL via `&cat=…` so the API
  // returns only the rows for the active category instead of shipping
  // everything for a client-side .filter() pass.
  const [fltCategory, setFltCategory] = useUrlState<string>("cat", "");
  const dueQueryFrag =
    (effectiveDueFrom ? `&dueFrom=${encodeURIComponent(effectiveDueFrom)}` : "") +
    (effectiveDueTo ? `&dueTo=${encodeURIComponent(effectiveDueTo)}` : "");
  // Wei Siang 2026-05-14: Clear All v2 — first version wiped sessionStorage
  // but the DataGrid's defaultExcludedValues useEffect re-applied the
  // "hide COMPLETED/TRANSFERRED" Status filter on remount, so the user
  // still saw the same filtered rowcount. While this flag is true,
  // defaultExcludedValues passes through as undefined so the grid mounts
  // with truly empty filter state. Resets on dept-tab change so navigating
  // to a different dept restores the first-visit hide-COMPLETED default.
  // Moved up from line ~1149 on 2026-05-24 because the fetch URL below
  // also needs to honour it (Phase 4: skip COMPLETED at SQL level).
  const [clearAllActive, setClearAllActive] = useState(false);
  // Phase 4 (2026-05-24): drop COMPLETED / TRANSFERRED / CANCELLED rows at
  // SQL level by default. The Production grid's defaultExcludedValues
  // already hides those statuses client-side — shipping them just to
  // discard them after JSON.parse wastes ~60% of the wire payload + ~1.3s
  // of main-thread parse on tab switch (measured 2026-05-24 on /production/
  // fab-sew: 7.6 MB decompressed → ~3 MB after this slim). When operator
  // hits "Clear all" (clearAllActive=true) they explicitly want history →
  // drop the flag so the refetch ships completed rows too.
  // When the operator is searching (top-bar search active) OR has hit "Clear
  // all", drop the server-side excludeCompleted flag so a COMPLETED / old
  // order can come back in the payload and be found client-side. The search is
  // purely client-side over haystackByPo, so the matching order MUST be in the
  // fetched payload first (gate 1 of 3 — see also dueFrag for gate 2, and on
  // the per-dept grid the deptForceShowKeys search exemption for gate 3, which
  // re-surfaces a matched COMPLETED row past the grid's seeded Status hide).
  // 2026-06-23.
  const searchActive = fltSearch.trim().length > 0;
  const excludeCompletedFrag =
    clearAllActive || searchActive ? "" : "&excludeCompleted=true";
  // Same reasoning for the date window: on standalone dept routes the cold
  // start seeds from=to=today, which would drop a non-today order the operator
  // is searching for. Send NO date window while a search is active so the
  // match survives the server's dueFrom/dueTo filter (gate 2 of 3).
  const dueFrag = searchActive ? "" : dueQueryFrag;
  const baseUrl =
    mode === "dept" && deptCode
      ? `/api/production-orders?fields=minimal&dept=${encodeURIComponent(deptCode)}${excludeCompletedFrag}${dueFrag}${fltCategory ? `&cat=${encodeURIComponent(fltCategory)}` : ""}`
      : `/api/production-orders?fields=minimal${excludeCompletedFrag}${dueFrag}${fltCategory ? `&cat=${encodeURIComponent(fltCategory)}` : ""}`;
  const ordersUrl: string | null = shouldFetch && datesSeeded ? baseUrl : null;
  // Phase 5 was reverted on 2026-05-24: the worker-parse path added
  // structured-clone overhead that ate the JSON.parse savings on desktop
  // (no measurable iPad win to justify the complexity either). Replaced
  // by Phase 6 — server-side KV snapshot cache — which gives every
  // repeat fetch a <200ms response instead of trying to optimise the
  // first-fetch parse cost.
  const { data: ordersResp, loading, failure: ordersFailure, refresh: refreshOrders } = useCachedJson<{ success?: boolean; data?: ProductionOrder[] }>(ordersUrl);
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
  // NOT gated on `shouldFetch` (2026-06-23). The overdue chips are the
  // Overview's primary KPI and now ALSO drive the grid filter (clicking
  // "Bedframe ⚠ N" filters the grid to those N), so they must populate on a
  // cold landing — otherwise the chips read 0, look wrong, and clicking them
  // filters to nothing (the bug verify-live caught: cold Overview never flips
  // shouldFetch, so the counts never loaded). This endpoint is a cheap
  // ~5 KB / ~50 ms aggregate, snapshot-cached server-side (withSnapshot) and
  // client-side (useCachedJson), so firing it on every Overview mount is fine;
  // the heavy orders grid below stays lazy (still gated on shouldFetch), and a
  // chip click arms that fetch via anyFilterActive.
  const overdueCountsUrl: string | null = datesSeeded
    ? `/api/production-orders/overdue-counts${overdueDept ? `?dept=${encodeURIComponent(overdueDept)}` : ""}`
    : null;
  const { data: overdueCountsResp, refresh: refreshOverdueCounts } = useCachedJson<{
    success?: boolean;
    data?: {
      bedframeCount: number;
      sofaCount: number;
      breakdown: OverdueSORow[];
      // PO-id sets per category — used to filter the main grid to exactly the
      // overdue work the chips count (same server overdue set, ship-exclusion
      // included). Optional so a cached older payload (pre-2026-06-23) still
      // parses. When ABSENT (an old-shape cache written before these arrays
      // existed) the grid-filter treats it as "ids not loaded yet" and skips
      // the id-filter while forcing a refetch — it must NOT collapse to an
      // empty set, which would filter the grid to 0 even though the chip
      // count is right (BUG-2026-06-23: stale-shape cache → "0 of 1032").
      overdueBedframePoIds?: string[];
      overdueSofaPoIds?: string[];
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
  // fltCategory hoisted up to the dueQueryFrag block (TDZ — baked into
  // the server-side fetch URL now that the API filters by `?cat=…`).
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
  // Overdue chip filter mode. The two red chips in the filter bar
  // ("Bedframe ⚠ N" / "Sofa ⚠ N") each toggle a grid filter scoped to that
  // itemCategory's overdue set (owner request 2026-06-23: filter the main grid
  // below INSTEAD of popping a separate SO list). null = no overdue filter.
  // Click the active chip again to clear, or click the other chip to switch.
  // Date-filter-independent — the id-set comes from
  // /api/production-orders/overdue-counts which scans the whole PO set.
  const [overduePanelMode, setOverduePanelMode] = useState<
    "BEDFRAME" | "SOFA" | null
  >(null);
  // Anchor for scrolling the grid into view when an overdue chip is clicked
  // (the grid sits below the filter bar; on a tall page it can be off-screen).
  const gridSectionRef = useRef<HTMLDivElement | null>(null);
  // selectOverdueChip is declared further down (after clearAllOverviewFilters
  // + setUrlBatch) so its activate branch can reuse the Clear-all pattern
  // without a use-before-declaration / TDZ error. 2026-06-23.
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
    // Date-range filters on the two order-level planning dates (replaced the
    // old single targetEndDate "Due" column — Wei Siang 2026-06-03).
    customerDDFrom: string; // YYYY-MM-DD
    customerDDTo: string;
    ourExpectedDDFrom: string;
    ourExpectedDDTo: string;
    deptStatuses: Partial<Record<string, ("pending" | "overdue" | "done")[]>>;
    // Per-dept date-range filter (the displayed cell date — done cells use
    // latestCompleted; others use earliestDue). Independent of deptStatuses
    // so operators can combine both: "FAB CUT pending AND due before 12 May".
    deptDates: Partial<Record<string, { from: string; to: string }>>;
  };
  const emptyOverviewFilters: OverviewFilters = {
    soId: "", product: "", customers: [], customerPO: "", specialOrder: "",
    qtyMin: "", qtyMax: "",
    customerDDFrom: "", customerDDTo: "", ourExpectedDDFrom: "", ourExpectedDDTo: "",
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

  // ── Overview matrix: multi-select → batch set due date ──
  // Wei Siang 2026-06-03: tick rows in the Overview, pick a department scope
  // ("All departments" or one dept), pick a date, Apply — sets that due date
  // across the selected orders' job cards. Mirrors the dept-sheet batch toolbar
  // and the planning tracker's analog. Selection is keyed by ORDER id (each
  // matrix row is one ProductionOrder spanning up to 8 dept job cards) and is
  // deliberately SEPARATE from `selectedDeptRows` (the dept-sheet's per-job-card
  // selection) so the two views never clobber each other.
  const [selectedOverviewIds, setSelectedOverviewIds] = useState<Set<string>>(new Set());
  const [overviewBatchDept, setOverviewBatchDept] = useState<string>("ALL");
  const [overviewBatchDueDateOpen, setOverviewBatchDueDateOpen] = useState(false);

  // ── Overview matrix: user-resizable column widths ──
  // colKey -> px. Empty = use OVERVIEW_DEFAULT_WIDTHS. Persisted per-browser.
  const [overviewColWidths, setOverviewColWidths] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(OVERVIEW_COLW_STORAGE);
      if (raw) return JSON.parse(raw) as Record<string, number>;
    } catch { /* ignore */ }
    return {};
  });
  const overviewColW = useCallback(
    (key: string) => overviewColWidths[key] ?? OVERVIEW_DEFAULT_WIDTHS[key] ?? 100,
    [overviewColWidths],
  );
  // Leading `OVERVIEW_SELECT_COL_W`px track = the multi-select checkbox
  // gutter. The header row + every body row reuse this same template, so the
  // gutter keeps them aligned without touching the resizable data columns.
  const overviewTemplate = useMemo(
    () => `${OVERVIEW_SELECT_COL_W}px ${OVERVIEW_COL_KEYS.map((k) => `${overviewColW(k)}px`).join(" ")}`,
    [overviewColW],
  );
  const overviewMinWidth = useMemo(
    () => OVERVIEW_SELECT_COL_W + OVERVIEW_COL_KEYS.reduce((s, k) => s + overviewColW(k), 0),
    [overviewColW],
  );
  const resetOverviewWidth = useCallback((key: string) => {
    setOverviewColWidths((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      try { localStorage.setItem(OVERVIEW_COLW_STORAGE, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const startOverviewResize = useCallback((e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    const cell = (e.currentTarget as HTMLElement).closest("[data-ovh]") as HTMLElement | null;
    const startX = e.clientX;
    const startW = cell ? cell.getBoundingClientRect().width : (OVERVIEW_DEFAULT_WIDTHS[key] ?? 100);
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(48, Math.round(startW + (ev.clientX - startX)));
      setOverviewColWidths((prev) => (prev[key] === w ? prev : { ...prev, [key]: w }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      setOverviewColWidths((prev) => {
        try { localStorage.setItem(OVERVIEW_COLW_STORAGE, JSON.stringify(prev)); } catch { /* ignore */ }
        return prev;
      });
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);
  const overviewResizeValue = useMemo(
    () => ({ start: startOverviewResize, reset: resetOverviewWidth }),
    [startOverviewResize, resetOverviewWidth],
  );

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
      case "customerDD": return !!f.customerDDFrom || !!f.customerDDTo;
      case "ourExpectedDD": return !!f.ourExpectedDDFrom || !!f.ourExpectedDDTo;
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
    if (f.soId || f.product || f.customerPO || f.specialOrder || f.qtyMin || f.qtyMax || f.customerDDFrom || f.customerDDTo || f.ourExpectedDDFrom || f.ourExpectedDDTo) return true;
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

  // Toggle an overdue chip: click to filter the grid to that category's
  // overdue set, click the same chip again to clear, click the other to
  // switch. On ACTIVATE, clear the layered narrowing filters (search /
  // state / customer / category + the per-column Overview filters) so the
  // chip shows its FULL overdue set — a leftover search/customer would
  // otherwise hide part of the overdue rows the count promised. The date
  // range (from/to) is LEFT ALONE because the overdue set is already
  // date-independent. 2026-06-23. The next mode is computed with a plain
  // read (NOT inside a setState updater) so the updater stays pure and the
  // clears run once in the handler body.
  const selectOverdueChip = useCallback(
    (cat: "BEDFRAME" | "SOFA") => {
      const next = overduePanelMode === cat ? null : cat;
      if (next) {
        // Clear the layered narrowing filters so the full overdue set shows.
        setUrlBatch({ q: "", state: "", customer: "", cat: "" });
        setFltSearchInput("");
        clearAllOverviewFilters();
        // Defer so the scroll target exists / the grid has re-filtered.
        requestAnimationFrame(() => {
          gridSectionRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        });
      }
      setOverduePanelMode(next);
    },
    [overduePanelMode, setUrlBatch, clearAllOverviewFilters],
  );

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
    !!fltCategory ||
    // An active overdue chip filters the grid too — arm the fetch so clicking
    // a chip on a cold (un-fetched) Overview loads the rows it selects.
    !!overduePanelMode;
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
  type DeptRowLite = { id: string; poId: string; jobCardId: string; prodTime: number; soId: string };
  const [selectedDeptRows, setSelectedDeptRows] = useState<DeptRowLite[]>([]);
  const [batchDateOpen, setBatchDateOpen] = useState(false);
  const [batchDueDateOpen, setBatchDueDateOpen] = useState(false);
  const [batchPicOpen, setBatchPicOpen] = useState(false);
  const [batchFolderOpen, setBatchFolderOpen] = useState(false);
  // Dual-keyed: the LIST endpoint camelCases the `jc_count` SQL alias to
  // `jcCount`, the POST response hand-builds `jc_count`. (BUG-2026-08-13-032)
  type FolderOption = { id: string; name: string; jcCount?: number; jc_count?: number };
  const [folderList, setFolderList] = useState<FolderOption[]>([]);
  // Wei Siang 2026-05-13: bumping this counter forces the DataGrid to
  // remount with a fresh `key`, which causes it to re-read its
  // sessionStorage-backed filter state. Combined with wiping the
  // datagrid-filters-* keys in Clear All, this gives a true "wipe every
  // filter on the page including the per-column ones inside the listing"
  // experience that the operator asked for: "彻彻底底、干干净净地把
  // Filter 都清掉".
  const [gridResetNonce, setGridResetNonce] = useState(0);
  // clearAllActive moved up near the fetch URL — declared above so the
  // server-side excludeCompleted flag can flip when the operator wants
  // history. See its first use in `excludeCompletedFrag` above.
  // 2026-05-24 — keep the defaultExcludedValues object STABLE across
  // renders. An inline literal was breaking the column-filter OK click
  // because DataGrid's seed effect re-fires whenever this prop changes
  // reference, and the 20s passive poll triggered enough re-renders to
  // clobber the operator's just-applied selection. See BUG-2026-05-24-003.
  const DEPT_STATUS_EXCLUDE = useMemo(
    () => ({ status: ["COMPLETED", "TRANSFERRED"] }),
    [],
  );
  // "Clear all" → drop the hide-COMPLETED/TRANSFERRED Status value-filter.
  // This ONLY works for Clear All because that path ALSO bumps gridResetNonce
  // (see the Clear-all button + the grid `key`), remounting the grid so its
  // value-filter state re-seeds from the now-empty sessionStorage with this
  // prop = undefined → the seed effect early-returns and no Status filter is
  // applied.
  //
  // Search does NOT use this `undefined` flip (and must not): a top-bar search
  // does NOT remount the grid (that would wipe the multi-select), so the
  // Status value-filter the seed effect already applied on cold mount stays in
  // place. data-grid.tsx's seed effect early-returns on a falsy
  // defaultExcludedValues — it never CLEARS an already-applied default — so
  // flipping this to undefined on search was a no-op: the COMPLETED row that
  // matched the search stayed hidden (the v2 gate-3 attempt; corrected
  // 2026-06-23). Search instead reveals the matching rows via forceShowKeys —
  // which IS exempt from value filters (data-grid.tsx:2211-2218) — see
  // deptForceShowKeys below. So keep the default-hide ON during search; the
  // force-show allowlist surfaces exactly the searched rows.
  const deptDefaultExcluded = clearAllActive ? undefined : DEPT_STATUS_EXCLUDE;
  // BUG-2026-06-23-004 force-show allowlist. Holds the DeptRow `id`
  // (`${po.id}:${jc.id}`) of every row the operator just batch-flipped to
  // COMPLETED via "Apply Completion". Passed to <DataGrid forceShowKeys> so
  // those rows STAY VISIBLE (showing the completion) even though the default
  // "hide COMPLETED" Status value-filter would otherwise drop them — matching
  // what a single-cell completion edit and the Folder already do. Lives in
  // component state only (NOT sessionStorage) so it survives in-session re-
  // renders / polls but resets on a full page reload: the long-term active
  // list stays clean. CRITICAL: it does NOT feed the grid `key`, so updating
  // it never remounts the grid — the checkbox selection + BatchActionToolbar
  // + Apply-Completion→Apply-PIC→Save-to-Folder chaining all survive. Only
  // "Apply Completion" populates it; Apply Due Date / Apply PIC don't change
  // status (no hide) so they leave it alone.
  const [forceShowCompletedIds, setForceShowCompletedIds] = useState<ReadonlySet<string>>(() => new Set());
  // Single-row completion (the per-row completion cell + the Status-cell flip)
  // feeds the SAME force-show allowlist the batch "Apply Completion" uses, so a
  // row completed one-at-a-time ALSO stays visible until reload instead of
  // vanishing on the next ~20s poll — keeps single, batch and folder behaviour
  // consistent (BUG-2026-06-23-004 follow-up). Updating the Set never remounts
  // the grid, so it's cheap.
  const markRowCompletedVisible = useCallback(
    (rowId: string, completed: boolean) => {
      setForceShowCompletedIds((prev) => {
        if (completed ? prev.has(rowId) : !prev.has(rowId)) return prev;
        const next = new Set(prev);
        if (completed) next.add(rowId);
        else next.delete(rowId);
        return next;
      });
    },
    [],
  );
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
    // Switching dept = a fresh sheet; drop the force-show reveal so the new
    // dept opens with the clean default-hide view.
    setForceShowCompletedIds((prev) => (prev.size === 0 ? prev : new Set()));
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
    // The unguessable 64-hex token for the PUBLIC packing-sticker → rack page
    // (/p/<token>). Resolved + minted at print/show time by the authed
    // POST /api/production-orders/packing-rack-tokens (keyed by poNo+pieceName →
    // the PO's ONE matching PACKING job_card). When present, the printed QR
    // encodes /p/<token> so a storekeeper with NO Worker-Portal PIN can set the
    // rack; when absent (no single PACKING card resolved, or the mint failed)
    // the QR keeps the /worker/scan deep link so the logged-in worker flow is
    // never broken.
    packingToken?: string;
    // The resolved PACKING job_card id (from the same mint call). Embedded on
    // the /worker/scan fallback URL as &jc= so an external scan can resolve by
    // card id even when the printed poNo drifted AND the token mint couldn't
    // persist — the FG-PACKING sticker otherwise carries only po= (TASK 2).
    packingJobCardId?: string;
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
  // FAB_CUT-only "pull the next stage" sticker pair. On the Fab Cut tab the
  // operator can also print the downstream Fabric Sewing (FAB_SEW) QR
  // stickers for the SAME orders the Fab Cut grid is showing — so cut + sew
  // stickers leave the cutting station together. Mirrors the Foam Bonding →
  // Packing Show/Print split, but sourced from each order's FAB_SEW job
  // cards (the WIP dept stickers, same kind as onScreenStickers /
  // JobCardSticker) instead of FG stickers. Lazy like every other QR strip:
  // the FAB_SEW stickers are only FETCHED + built once intent is signalled
  // (Show / Print clicked) so Fab Cut tab entry stays cheap — no extra
  // render cost until the operator actually asks for the sewing stickers.
  const [showFabSewStrip, setShowFabSewStrip] = useState(false);
  // The built FAB_SEW stickers for the orders visible in the Fab Cut grid.
  // Populated by loadFabSewStickers (an on-click fetch of every dept's job
  // cards — see the loader for why a fetch is required instead of reading
  // the in-memory dept-scoped rows). Empty until the operator clicks Show /
  // Print, and cleared on filter change + tab leave.
  const [fabSewStickers, setFabSewStickers] = useState<JobCardSticker[]>([]);
  // True while loadFabSewStickers is fetching + building. Shown on both the
  // Show and Print buttons (mirrors loadingFoamPrint for the Foam pair).
  const [loadingFabSew, setLoadingFabSew] = useState(false);
  // Loading flag shown on the "Print Fab Sew Stickers" button while the
  // batch of QRs pre-renders (mirrors printingJobCards for the native pair).
  const [printingFabSew, setPrintingFabSew] = useState(false);
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
  // Foam Bonding's "Print Packing Stickers" runs the same fgStickers
  // pipeline but on a SO-scoped fetch (all POs of the SO, not just FOAM
  // dept). Stored in a SEPARATE state so the PACKING tab's preview tiles
  // + grid-scoped `visibleFgStickers` are NOT polluted when the foam
  // print fires from a different tab. The hidden print container
  // chooses which array to iterate based on whichever print flag is
  // active (fgPrintRequested → visibleFgStickers, foamPrintRequested →
  // foamPrintStickers). Both arrays go through the SAME pure aggregator
  // (fetchFgStickersForOrders) so the sticker output is byte-identical
  // between the two entry points.
  const [foamPrintStickers, setFoamPrintStickers] = useState<FgSticker[]>([]);
  const [foamPrintRequested, setFoamPrintRequested] = useState(false);
  // 2026-05-24 — Wei Siang asked for an on-screen preview of the foam
  // packing stickers (mirroring the Show QR / Print All split on the
  // existing dept QR Stickers section). When true + foamPrintStickers
  // populated, the tiles render under the QR Stickers panel.
  const [showFoamPackingPreview, setShowFoamPackingPreview] = useState(false);
  const [loadingFoamPrint, setLoadingFoamPrint] = useState(false);

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
  // Replaces the native browser window.confirm "Mark all as Sent?" prompt shown
  // at print time with a system-styled dialog. When set, the dialog renders; its
  // buttons re-invoke the print handler with the decision (true = mark + print,
  // false = print only) — crucially from the button-click gesture, so the
  // window.open print popup the handler opens is not pop-up-blocked.
  const [printSentPrompt, setPrintSentPrompt] = useState<
    { count: number; which: "schedule" | "total" } | null
  >(null);

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

  // BUG-2026-06-08 (the "flicker"): even AFTER a PATCH confirms (the JC leaves
  // pendingJcPatchesRef), the cached orders snapshot can stay STALE for a few
  // seconds — the row's `updated_at` bump invalidates the snapshot but the
  // rebuild lags behind. A poll that lands in that window overlays the stale
  // row, so a cell the operator JUST cleared (Completion Date / PIC) visibly
  // pops back to "complete", then clears again once the snapshot rebuilds.
  // This map pins each freshly-patched JC's expected value over the snapshot
  // until EITHER the server snapshot catches up (the fetched row matches what
  // we wrote) OR a safety window elapses — so the operator never sees the
  // bounce. ref (not state): read by the cache merger without a re-render.
  const recentlyPatchedRef = useRef<
    Map<string, { expiry: number; expect: Record<string, unknown> }>
  >(new Map());
  // Safety ceiling: if the snapshot somehow never catches up, release the pin
  // after this long so a stuck pin can't hide a genuine later server change.
  //
  // BUG-2026-06-09: this was 30s, but it's a *ceiling*, not the normal release
  // path — the pin releases EARLY the moment the refetched row matches what we
  // wrote (caughtUp). The problem: after the snapshot-freshness fix (BUG-...-007)
  // the cache self-heals on read but takes ~1-3 MIN (serve-stale-then-revalidate,
  // measured live), while 30s expired the pin first — so a SUCCESSFUL save's cell
  // silently reverted to the stale value with no error in that window. Raised to
  // 5 min so the ceiling outlasts the cache lag; normal saves still release on
  // catch-up well before this. Trade-off (small-shop-acceptable): a *concurrent*
  // edit to the same cell by another user is hidden until catch-up or this cap.
  const PATCH_PIN_MS = 300_000;

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
    // 8s (was 20s) — Wei Siang 2026-06-07 wanted scans to show on the operator's
    // sheet within a few seconds. Each poll is a KV cache HIT (~20-50ms, no DB)
    // until a scan bumps the version, so 2.5x more polls is cheap at this scale.
    const POLL_INTERVAL_MS = 8_000;
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
      // 3s gate (was 5 min) — the operator's real workflow is "scan on the phone,
      // look back at the computer". A 5-minute gate meant that look-back refetch
      // almost never fired, so the sheet sat stale. 3s still de-bounces rapid tab
      // flips; in-flight PATCHes are already skipped above, drafts via fetchOrders.
      if (Date.now() - lastFetchAtRef.current < 3_000) return;
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

    // BUG-2026-06-08 (flicker): also preserve JCs patched moments ago whose
    // value the cached snapshot hasn't caught up to. Pin each until the fetched
    // row matches what we wrote (server caught up) or the safety window lapses.
    const freshJcMap = new Map<string, JobCard>();
    for (const po of fresh)
      for (const jc of po.jobCards) freshJcMap.set(jc.id, jc);
    const blankVal = (v: unknown) => v === null || v === undefined || v === "";
    const caughtUp = (jc: JobCard, expect: Record<string, unknown>) => {
      const row = jc as unknown as Record<string, unknown>;
      for (const k of Object.keys(expect)) {
        if (!((blankVal(row[k]) && blankVal(expect[k])) || row[k] === expect[k]))
          return false;
      }
      return true;
    };
    const pinnedIds = new Set<string>();
    const nowMs = Date.now();
    for (const [jcId, pin] of Array.from(recentlyPatchedRef.current.entries())) {
      if (nowMs > pin.expiry) {
        recentlyPatchedRef.current.delete(jcId);
        continue;
      }
      const freshJc = freshJcMap.get(jcId);
      if (freshJc && caughtUp(freshJc, pin.expect)) {
        recentlyPatchedRef.current.delete(jcId); // server caught up — release
        continue;
      }
      pinnedIds.add(jcId);
    }

    if (pending.size === 0 && draftedIds.size === 0 && pinnedIds.size === 0) {
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
            if (pending.has(jc.id) || draftedIds.has(jc.id) || pinnedIds.has(jc.id))
              prevJcMap.set(jc.id, jc);
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
      const list: WorkerRec[] =
        (d.success ? d.data : Array.isArray(d) ? d : []) as WorkerRec[];
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
  // True while network/5xx failures are kept + auto-retrying (BUG-2026-06-09).
  // Drives the red "retrying" banner so the operator sees it's working, not stuck.
  const [retryPending, setRetryPending] = useState(false);
  // Near-immediate save (owner 2026-06-26: "点了改了直接存进去"). Was 2000ms —
  // that batched DENSE editing, but the floor edits one row at a time (at most a
  // 20-30 Batch Edit, which is its own path), so the 2s wait gave NO batching
  // benefit, only a "2s loading" feel. CRITICAL: the data-loss SAFETY is NOT the
  // debounce — it's retry+rollback (BUG-2026-06-09), the post-write direct read-
  // back (mergeFreshPOs), refetch-preserves-staged-drafts (BUG-2026-05-12-004),
  // and CSRF (BUG-2026-05-12-005, now the global window.fetch interceptor) — ALL
  // UNCHANGED. So shrinking the debounce only makes the save fire ~immediately;
  // genuinely rapid edits within 250ms still coalesce into one batched flush.
  const DEBOUNCE_MS = 250;

  // True when a written patch touched PIC1 / PIC2 / Completion — the three
  // fields whose post-write display must come from a direct-to-DB read (see
  // mergeFreshPOs). Due-date / racking / distributedAt edits don't suffer the
  // same stale-snapshot pop, so they keep the existing pin-only path.
  const PIC_COMPLETION_KEYS = [
    "pic1Id",
    "pic1Name",
    "pic2Id",
    "pic2Name",
    "completedDate",
  ] as const;
  const touchesPicOrCompletion = (patch: Record<string, unknown>): boolean =>
    PIC_COMPLETION_KEYS.some((k) => k in patch);

  // mergeFreshPOs — direct-to-DB read-back for PIC / Completion edits.
  //
  // After a PIC1 / PIC2 / Completion write lands, the cached LIST refetch
  // serves the STALE backend snapshot (production_orders_list_snapshot, served
  // serve-stale-while-revalidate) for the ~1-3 min rebuild window, popping the
  // old value back — the "flicker" that the recentlyPatchedRef pin alone never
  // reliably killed (patched 8×). Instead of trusting the list, fetch the ONE
  // PO we just edited straight from the DB (?fresh=1 bypasses KV + the snapshot)
  // and MERGE that authoritative row into the grid. We also (re)set the pin from
  // the FRESH JC values so the slow background LIST refetch can't clobber the
  // merged row until it catches up to the same values.
  //
  // Concurrency: JCs of the same PO that still have an in-flight write
  // (pendingJcPatchesRef) or a staged draft (draftsRef) are NOT overwritten by
  // the fresh row — their local value is preserved, mirroring the cache merger.
  // Fresh-read failures are swallowed: the optimistic value + the value-pin are
  // already on screen, and the next poll self-heals — a read blip must never
  // erase a write the server already accepted.
  const mergeFreshPOs = useCallback(
    async (targets: Array<{ poId: string; jcIds: string[] }>) => {
      // Collapse to one fetch per PO; union the JC ids to pin per PO.
      const byPo = new Map<string, Set<string>>();
      for (const t of targets) {
        if (!t.poId) continue;
        const set = byPo.get(t.poId) ?? new Set<string>();
        for (const jcId of t.jcIds) if (jcId) set.add(jcId);
        byPo.set(t.poId, set);
      }
      if (byPo.size === 0) return;
      const deptFrag =
        mode === "dept" && deptCode
          ? `&dept=${encodeURIComponent(deptCode)}`
          : "";
      await Promise.all(
        Array.from(byPo.entries()).map(async ([poId, jcIdSet]) => {
          let fresh: ProductionOrder | null = null;
          try {
            const res = await fetch(
              `/api/production-orders/${encodeURIComponent(poId)}?fresh=1${deptFrag}`,
              { credentials: "include" },
            );
            if (!res.ok) return;
            const j = (await res.json()) as {
              success?: boolean;
              data?: ProductionOrder;
            };
            if (!j.success || !j.data) return;
            fresh = j.data;
          } catch {
            // Network blip on the read-back — leave the optimistic value + pin
            // in place; the poll will reconcile. Never erase the write.
            return;
          }
          const freshPo = fresh;
          // Pin each just-written JC to the FRESH DB value so the next LIST
          // refetch (still stale for 1-3 min) can't pop the old value back.
          // Releases early the moment the list catches up to this value
          // (caughtUp in the cache merger), else after PATCH_PIN_MS.
          const freshJcById = new Map<string, JobCard>();
          for (const jc of freshPo.jobCards) freshJcById.set(jc.id, jc);
          for (const jcId of jcIdSet) {
            const fjc = freshJcById.get(jcId);
            if (!fjc) continue;
            recentlyPatchedRef.current.set(jcId, {
              expiry: Date.now() + PATCH_PIN_MS,
              expect: {
                pic1Id: fjc.pic1Id,
                pic1Name: fjc.pic1Name,
                pic2Id: fjc.pic2Id,
                pic2Name: fjc.pic2Name,
                completedDate: fjc.completedDate,
                status: fjc.status,
              },
            });
          }
          // Replace the one PO with the fresh row, but keep any JC that still
          // has an unsent draft / in-flight write (a concurrent edit on a
          // DIFFERENT cell of the same PO) so the read-back can't stomp it.
          setOrders((prev) => {
            const prevPo = prev.find((o) => o.id === poId);
            const merged: ProductionOrder = prevPo
              ? {
                  ...freshPo,
                  jobCards: freshPo.jobCards.map((jc) => {
                    const stillLocal =
                      (pendingJcPatchesRef.current.has(jc.id) ||
                        draftsRef.current.has(jc.id)) &&
                      !jcIdSet.has(jc.id);
                    if (!stillLocal) return jc;
                    const prevJc = prevPo.jobCards.find((p) => p.id === jc.id);
                    return prevJc ?? jc;
                  }),
                }
              : freshPo;
            let replaced = false;
            const next = prev.map((o) => {
              if (o.id !== poId) return o;
              replaced = true;
              return merged;
            });
            // PO wasn't in the current slice (e.g. filtered out) — don't inject
            // it; the merged row would violate the active filter. The pin still
            // protects it if it later reappears.
            return replaced ? next : prev;
          });
        }),
      );
    },
    [mode, deptCode],
  );

  // sendOneDraft — the actual HTTP write with retry. Extracted from the
  // pre-batching patchJobCard so flushDrafts and retryFailure can share it.
  // Returns success / error data; never throws (caller decides UI handling).
  const sendOneDraft = useCallback(
    async (
      d: Pick<DraftEntry, "poId" | "jcId" | "patch">,
    ): Promise<{ success: boolean; error?: string; attemptsUsed: number; permanent: boolean }> => {
      const MAX_ATTEMPTS = 3;
      const RETRY_DELAYS_MS = [500, 1500];
      let lastError = "";
      let attemptsUsed = 0;
      // `permanent` = the server DEFINITIVELY rejected it (a 4xx that isn't
      // 408/429). false = transient (network down / 5xx / timeout) — the caller
      // KEEPS the value and re-queues instead of erasing it (BUG-2026-06-09).
      let permanent = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        attemptsUsed = attempt;
        let retryable = true;
        try {
          const res = await fetch(`/api/production-orders/${d.poId}`, {
            method: "PATCH",
            headers: csrfHeaders(),
            body: JSON.stringify({ jobCardId: d.jcId, ...d.patch }),
          });
          if (res.ok) return { success: true, attemptsUsed, permanent: false };
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
        if (!retryable) {
          permanent = true;
          break;
        }
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
        }
      }
      return { success: false, error: lastError, attemptsUsed, permanent };
    },
    [],
  );

  // Latest flushDrafts — lets the transient-failure retry timer re-flush
  // without making flushDrafts depend on itself. Assigned after the callback.
  const flushDraftsRef = useRef<(() => Promise<void>) | null>(null);

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
      result: { success: boolean; error?: string; attemptsUsed: number; permanent?: boolean };
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
          results?: Array<{
            poId: string;
            jobCardId: string;
            success: boolean;
            error?: string;
            // Upstream sequence lock. Carried so the reverted cell can say
            // WHICH department it is waiting for instead of a bare failure —
            // the operator needs to know where to go, not that something broke.
            code?: string;
          }>;
        };
        const perJc = new Map<string, { success: boolean; error?: string; code?: string }>();
        for (const r of body.results ?? []) perJc.set(r.jobCardId, r);
        results = drafts.map((d) => {
          const r = perJc.get(d.jcId);
          return {
            draft: d,
            result: r
              ? {
                  success: r.success,
                  // A locked cell is not a fault to retry — it is a step whose
                  // turn has not come. Marking it permanent stops the retry
                  // loop from hammering a gate that will not open until someone
                  // finishes the upstream work.
                  error:
                    r.code === "UPSTREAM_INCOMPLETE"
                      ? `Locked — ${r.error ?? "an earlier step is not finished"}`
                      : r.error,
                  attemptsUsed: 1,
                }
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

    // Split failures (BUG-2026-06-09 "laggy network erased my entry"):
    //   • permanent — the server DEFINITIVELY rejected it (4xx, not 408/429):
    //     roll the cell back, the value is genuinely invalid/unauthorised.
    //   • transient — network down / 5xx / timeout (`permanent === false`):
    //     KEEP the operator's value on screen and re-queue it, so a slow line
    //     never silently throws away a typed completion/PIC. The old code rolled
    //     back EVERY failure. Bulk per-row failures carry no `permanent` flag →
    //     they are server-side verify-readback rejects → treated as permanent.
    const transientFails = results.filter(
      (r) => !r.result.success && r.result.permanent === false,
    );
    const permanentFails = results.filter(
      (r) => !r.result.success && r.result.permanent !== false,
    );

    // Roll back ONLY the permanent failures.
    if (permanentFails.length > 0) {
      setOrders((prev) => {
        let next = prev;
        for (const { draft } of permanentFails) {
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
    }

    // Transient failures: put the draft back in the buffer (value stays on
    // screen) and re-arm a retry so it saves itself when the line recovers.
    if (transientFails.length > 0) {
      for (const { draft } of transientFails) {
        if (!draftsRef.current.has(draft.jcId)) {
          draftsRef.current.set(draft.jcId, draft);
        }
      }
      setUnsavedCount(draftsRef.current.size);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        void flushDraftsRef.current?.();
      }, 5000);
    }

    // Outcomes: success → pin + green; transient → amber pulse (kept, retrying,
    // no per-draft toast — one shared notice below); permanent → red + revert.
    for (const { draft, result } of results) {
      if (result.success) {
        // Pin this just-written value over the (briefly stale) cached snapshot
        // until the server catches up — kills the "cleared cell pops back" flicker.
        recentlyPatchedRef.current.set(draft.jcId, {
          expiry: Date.now() + PATCH_PIN_MS,
          expect: { ...draft.patch },
        });
        if (draft.feedback?.flashKey) flashCell(draft.feedback.flashKey, "ok");
        if (draft.feedback?.successMsg) toast.success(draft.feedback.successMsg);
      } else if (result.permanent === false) {
        // Transient — value kept + re-queued. Amber pulse, no per-draft toast.
        if (draft.feedback?.flashKey) flashCell(draft.feedback.flashKey, "err");
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

    // One shared "kept + retrying" notice for transient failures (no spam when
    // several cells are in flight).
    if (transientFails.length > 0) {
      const n = transientFails.length;
      toast.warning(
        `Network slow — your ${n} change${n > 1 ? "s are" : " is"} kept and will save automatically when the connection comes back.`,
      );
    }
    setRetryPending(transientFails.length > 0);
    setSavingNow(false);

    // Direct-to-DB read-back for the PIC / Completion writes that just
    // succeeded — fetch each touched PO fresh (?fresh=1, bypassing the
    // serve-stale list snapshot) and merge the authoritative row in. This is
    // what makes a cleared/changed PIC or completion STICK instead of popping
    // back to the snapshot's pre-write value. Fire-and-forget: it owns its own
    // merge + pin and swallows read failures (the optimistic value + pin set
    // above already hold the cell). Only PIC/Completion drafts qualify; due
    // date / racking keep the pin-only path.
    const freshTargets = results
      .filter((r) => r.result.success && touchesPicOrCompletion(r.draft.patch))
      .map((r) => ({ poId: r.draft.poId, jcIds: [r.draft.jcId] }));
    if (freshTargets.length > 0) void mergeFreshPOs(freshTargets);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- touchesPicOrCompletion is a pure module-stable helper (no closure deps); listing it would force a useless re-memo each render.
  }, [sendOneDraft, flashCell, toast, mergeFreshPOs]);

  // Keep the retry-timer's reference to flushDrafts current (see flushDraftsRef).
  flushDraftsRef.current = flushDrafts;

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
        if (result.success) {
          recentlyPatchedRef.current.set(jobCardId, {
            expiry: Date.now() + PATCH_PIN_MS,
            expect: { ...patch },
          });
          // PIC / Completion edits read back the fresh PO so the value sticks
          // over the serve-stale list snapshot (see mergeFreshPOs).
          if (touchesPicOrCompletion(patch as Record<string, unknown>)) {
            void mergeFreshPOs([{ poId, jcIds: [jobCardId] }]);
          }
          return;
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- touchesPicOrCompletion is a pure module-stable helper (no closure deps); listing it would force a useless re-memo each render.
    [sendOneDraft, flushDrafts, mergeFreshPOs],
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
          // MUST send the CSRF token (every other mutating call here uses
          // csrfHeaders()); a bare Content-Type PATCH was rejected 403, so the
          // manual rack dropdown silently rolled back — owner 2026-06-25 "放
          // Rack 9 不会跑出来". The worker/public rack writes worked because they
          // already send csrfHeaders().
          headers: csrfHeaders(),
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

  // BUG-2026-08-13-146 (docs/BUG-CLASSES.md C15 — "`0` is a claim, not a
  // blank"). `orders` is `[]` in three DIFFERENT situations and every count
  // derived from it — the matrix footer's "N of M work orders · D/T cells
  // complete" and the tab bar's per-dept fractions — printed a confident `0`
  // in all of them:
  //
  //   1. COLD LANDING. `shouldFetch` starts `false` in overview/full mode
  //      (:588), so `ordersUrl` is null and NO REQUEST IS EVER MADE. The page
  //      rendered "No orders loaded yet." and, in the same viewport, the
  //      footer asserted "0 of 0 work orders · 0/0 cells complete". The matrix
  //      block is gated on `activeTab === "ALL"` alone, which is why the two
  //      contradicted each other on screen.
  //   2. IN FLIGHT — the fetch is armed but has not landed.
  //   3. DEAD READ — a timeout, the 30 s global abort or a 5xx. `useCachedJson`
  //      hands back `data = null, loading = false` for that, byte-identical to
  //      a successful empty response, unless `failure` is read.
  //
  // Only the fourth situation — an observed 2xx body that genuinely contained
  // no orders — licenses the number 0. `isUnknownOutcome` is the repo's single
  // decision for (3) and is reused here rather than inventing a second one.
  const ordersLoadFailed = ordersUrl != null && isUnknownOutcome(ordersFailure);
  const ordersObserved =
    ordersUrl != null && (orders.length > 0 || (!loading && !ordersLoadFailed));
  // Why the figures are unsourceable, in the operator's words — a count that
  // cannot be produced has to say which of the three cases it is in, otherwise
  // "—" is only a prettier lie than "0".
  const ordersUnobservedReason = !ordersObserved
    ? ordersUrl == null
      ? "not loaded yet — pick a filter or Load all"
      : ordersLoadFailed
        ? "couldn't load — this is unknown, not empty"
        : "loading…"
    : null;

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

  // Perf 2026-05-22 — true while a filter change is still being absorbed by
  // the heavy downstream recompute (the useDeferredValue lag). Drives the
  // "Updating…" hint in the filter row so the operator sees the click
  // registered and doesn't re-click (re-clicking restarts the recompute).
  // Scalar filters only — the object-valued overview filters would
  // false-positive on every render.
  const filtersPending =
    fltSearch !== deferredFltSearch ||
    fltState !== deferredFltState ||
    fltCustomer !== deferredFltCustomer ||
    fltDueFrom !== deferredFltDueFrom ||
    fltDueTo !== deferredFltDueTo ||
    fltCategory !== deferredFltCategory ||
    incompleteOnly !== deferredIncompleteOnly;

  // Phase 2 — also surface "Updating…" while the baseRows Web Worker is
  // mid-compute. `filtersPending` only covers the brief useDeferredValue
  // lag before the new filter value is applied; the heavy row build then
  // runs in the worker (`baserowsPending`). ORing them keeps the hint
  // visible for the whole "click filter → grid refreshed" window.
  const updatingHint = filtersPending || baserowsPending;

  // Set of production-order ids the active overdue chip selects (null when no
  // chip is active). Reuses the SAME server-computed overdue set the chip
  // counts come from — including the per-piece ship-exclusion the FE
  // isOverduePO lacks — so the filtered grid can never drift from 29 / 25.
  // Clicking "Bedframe ⚠ 29" → the 29 overdue bedframe pieces; "Sofa ⚠ 25" →
  // every overdue sofa piece (PO) making up those 25 sets. Declared before
  // `filteredOrders` because that memo reads it.
  const overduePoIdSet = useMemo<Set<string> | null>(() => {
    if (!overduePanelMode) return null;
    const ids =
      overduePanelMode === "BEDFRAME"
        ? overdueCountsResp?.data?.overdueBedframePoIds
        : overdueCountsResp?.data?.overdueSofaPoIds;
    // CRITICAL distinction (BUG-2026-06-23):
    //   • ABSENT (undefined) → the loaded counts payload predates the id
    //     arrays (a stale-SHAPED localStorage cache written before
    //     2026-06-23). We do NOT know the overdue ids yet, so return null to
    //     SKIP the id-filter entirely. Collapsing absent→empty Set was the
    //     bug: it filtered all 1032 rows out → "No production orders found"
    //     under a banner promising 29. A refetch is forced in the effect
    //     below; the real ids replace this within ~50ms and narrow the grid.
    //   • PRESENT-BUT-EMPTY ([]) → the server genuinely returned 0 overdue
    //     for this category. Build the empty Set so the grid correctly shows
    //     0 (the chip would read 0 too; both agree).
    if (!ids) return null;
    return new Set(ids);
  }, [overduePanelMode, overdueCountsResp]);

  // Self-heal a stale-SHAPED counts cache (BUG-2026-06-23). When an overdue
  // chip is active but the loaded counts payload has no id array for it (an
  // old-shape localStorage entry that predates the arrays), force a
  // cache-bypass refetch so the array-bearing payload arrives. useCachedJson
  // already refetches on mount, but this guarantees the heal even if the
  // mount refetch was deduped/aborted, and re-arms if the chip is switched
  // before the fresh payload lands. Self-corrects every existing stale browser
  // with no hard reload. The data dep below is intentionally the whole
  // response object so this re-evaluates once the fresh ids replace the stale
  // payload (at which point the absent-id condition is false and we stop).
  useEffect(() => {
    if (!overduePanelMode) return;
    const ids =
      overduePanelMode === "BEDFRAME"
        ? overdueCountsResp?.data?.overdueBedframePoIds
        : overdueCountsResp?.data?.overdueSofaPoIds;
    if (overdueCountsResp && !ids) refreshOverdueCounts();
  }, [overduePanelMode, overdueCountsResp, refreshOverdueCounts]);

  // Apply the page-level filter panel to `orders` first, then scope further
  // by active tab (Overview = everything; dept tab = only orders that have
  // a non-empty cell in that dept).
  const filteredOrders = useMemo(() => {
    const q = deferredFltSearch.trim().toLowerCase();
    return orders.filter((o) => {
      // Overdue chip filter (date-INDEPENDENT, like the chips). When a chip is
      // active, keep ONLY the POs in that category's server overdue set and
      // SKIP the date-range narrowing below — the operator clicked "show me
      // the overdue ones", not "the overdue ones that also fall in my date
      // window". Other filters (search / customer / state / category) still
      // layer on top so the operator can narrow further within the overdue set.
      if (overduePoIdSet && !overduePoIdSet.has(o.id)) return false;
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
      // Skip the date window while an overdue chip is active — the overdue set
      // is date-independent (matches the chip), so a stale date filter must not
      // hide overdue rows from the chip's own selection. Also skip while a
      // search is active (`q`) so the client-side date window can't re-hide a
      // COMPLETED / old order the operator searched for — mirrors the fetch +
      // grid value-filter bypasses above. With no search active, byte-identical.
      if (!overduePoIdSet && !q) {
        if (deferredFltDueFrom && axisVal && axisVal < deferredFltDueFrom) return false;
        if (deferredFltDueTo && axisVal && axisVal > deferredFltDueTo) return false;
      }
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
    // Overdue chip filter — recompute when the active chip / its id-set changes.
    overduePoIdSet,
    showCancelled,
    deferredIncompleteOnly,
    // activeTab drives the dueDate axis branch added 2026-05-07 (overview
    // → PO.targetEndDate, dept page → matching dept's JC.dueDate). Without
    // it in the deps the memo retains stale results when the route changes.
    activeTab,
  ]);

  // Per-category overdue counts. Pre-aggregated server-side (see
  // /api/production-orders/overdue-counts above). The endpoint applies the same
  // isOverduePO / earliestOverdueDateOnPO rules per `overdueDept`, so the counts
  // match the matrix's red cells. (The old SO-grouped `breakdown` drill-down
  // panel was replaced 2026-06-23 by the grid-filter `overduePoIdSet` above —
  // clicking a chip now narrows the grid below instead of popping a list.)
  const bedframeOverdueCount = overdueCountsResp?.data?.bedframeCount ?? 0;
  const sofaOverdueCount = overdueCountsResp?.data?.sofaCount ?? 0;

  // True while an overdue chip is active but the matching id array hasn't
  // loaded yet — either a stale-SHAPED cache (old payload, no arrays; being
  // refetched by the self-heal effect above) or the very first cold fetch
  // still in flight. In this window overduePoIdSet is null (id-filter skipped)
  // so the banner must say "loading the list" rather than promise N rows the
  // grid isn't yet narrowed to. PRESENT-BUT-EMPTY ([]) is NOT loading — that's
  // a genuine 0 and the count shown is correct. (BUG-2026-06-23)
  const overdueIdsLoading =
    !!overduePanelMode &&
    !(overduePanelMode === "BEDFRAME"
      ? overdueCountsResp?.data?.overdueBedframePoIds
      : overdueCountsResp?.data?.overdueSofaPoIds);

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
      // Search-active flag derived from the DEFERRED search (not the urgent
      // `searchActive`) so it flips in lockstep with `filteredOrders` (which
      // also reads deferredFltSearch). Gating the dept-column-filter bypass
      // below on the urgent flag would, for one render, bypass the dept
      // filters before filteredOrders had narrowed to the search match —
      // flashing every completed order. Deferred keeps the two in sync.
      const searchActiveOverview = deferredFltSearch.trim().length > 0;
      // Cell-state cache so dept-status filter + dept-sort don't recompute
      // cellFor() N×M times.
      const cellCache = new Map<string, ReturnType<typeof cellFor>>();
      const cellAt = (o: ProductionOrder, dept: string) => {
        const k = `${o.id}|${dept}`;
        let v = cellCache.get(k);
        if (!v) {
          // Full `orders` (not filteredOrders) so the FAB_CUT sibling-walk can
          // always resolve the anchor — matches the render site (~6996). With
          // filteredOrders, a page-level filter hiding the anchor would read a
          // borrowed FAB_CUT as "empty" and could wrongly drop the row when a
          // FAB_CUT column-status / date filter is also active.
          v = cellFor(o, dept, orders);
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
        const custDD = o.customerDeliveryDate || "";
        if (f.customerDDFrom && custDD && custDD < f.customerDDFrom) return false;
        if (f.customerDDTo && custDD && custDD > f.customerDDTo) return false;
        const ourDD = o.hookkaExpectedDD || "";
        if (f.ourExpectedDDFrom && ourDD && ourDD < f.ourExpectedDDFrom) return false;
        if (f.ourExpectedDDTo && ourDD && ourDD > f.ourExpectedDDTo) return false;
        // Per-dept column filters (status + date). These are the Overview's
        // equivalent of the dept grid's seeded hide-COMPLETED value filter:
        // an operator who once set a dept column to show only Pending/Overdue
        // (excluding Done) keeps that filter forever via localStorage
        // (OVERVIEW_TABLE_LS_KEY), so a fully-completed ("done") order is
        // dropped here. While a top-bar search is active, BYPASS these
        // dept-column filters so a searched COMPLETED / TRANSFERRED order
        // surfaces on the Overview — exactly mirroring the dept grid's
        // forceShowKeys search-exemption (deptForceShowKeys ~L3297) and the
        // `filteredOrders` date-window `!q` skip (~L2774). The page-level
        // search/customer/state/category/date predicates already ran (in
        // filteredOrders), so a search that matches NOTHING leaves these rows
        // empty and reveals no completed orders; a search that matches a
        // completed order now renders it. With NO search active this is
        // byte-identical (the loops run exactly as before). The count line
        // (~L6849, reads filteredOrders) and the body (visibleOrders) now
        // agree for searched completed rows — no count-line change needed.
        // BUG-2026-06-24-001 (Overview half of BUG-2026-06-23-004). 2026-06-24.
        if (!searchActiveOverview) {
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
          if (key === "customerDD") return cmpStr(a.customerDeliveryDate || "", b.customerDeliveryDate || "");
          if (key === "ourExpectedDD") return cmpStr(a.hookkaExpectedDD || "", b.hookkaExpectedDD || "");
          // Department column — sort by earliest dept due date.
          const ca = cellAt(a, key);
          const cb = cellAt(b, key);
          return cmpStr(ca.earliestDue || "", cb.earliestDue || "");
        });
      }
    }
    return rows;
    // deferredFltSearch: the Overview dept-column-filter bypass while searching
    // (see searchActiveOverview above) must recompute when the search changes.
  }, [filteredOrders, activeTab, deferredOverviewSort, deferredOverviewFilters, deferredFltSearch]);

  // ── Overview multi-select (batch set due date) ──
  // The selected orders, intersected with the live `visibleOrders` so a row
  // that got filtered out / removed can't linger in the selection or in the
  // batch toolbar's count.
  const selectedOverviewOrders = useMemo(
    () => visibleOrders.filter((o) => selectedOverviewIds.has(o.id)),
    [visibleOrders, selectedOverviewIds],
  );
  // Total production time (minutes) of the selected orders, scoped to the
  // chosen batch department ("ALL" = every dept). Mirrors the dept-sheet
  // footer's "Prod Time" = per-jc productionTimeMinutes × wipQty.
  // (Wei Siang 2026-06-03: show the workload of a multi-select before applying.)
  const overviewBatchTotalMin = useMemo(() => {
    let sum = 0;
    for (const o of selectedOverviewOrders) {
      for (const jc of o.jobCards) {
        if (overviewBatchDept !== "ALL" && jc.departmentCode !== overviewBatchDept) continue;
        const perUnit =
          Number((jc as JobCard & { productionTimeMinutes?: number }).productionTimeMinutes) ||
          Number((jc as JobCard & { estMinutes?: number }).estMinutes) || 0;
        // FAB_CUT stores the per-SET total (wipQty = piece count); jcMinutesTotal
        // skips the ×wipQty there so the workload preview isn't 3× inflated.
        sum += jcMinutesTotal(perUnit, jc);
      }
    }
    return sum;
  }, [selectedOverviewOrders, overviewBatchDept]);
  // Select-all is scoped to the CURRENTLY-VISIBLE (filtered + sorted) rows.
  const allOverviewVisibleSelected =
    visibleOrders.length > 0 && visibleOrders.every((o) => selectedOverviewIds.has(o.id));
  const someOverviewVisibleSelected =
    !allOverviewVisibleSelected && visibleOrders.some((o) => selectedOverviewIds.has(o.id));
  const toggleOverviewRow = useCallback((id: string) => {
    setSelectedOverviewIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const toggleOverviewSelectAll = useCallback(() => {
    setSelectedOverviewIds((prev) => {
      // All visible already selected → clear just the visible ones; else add
      // every visible row to the selection.
      if (visibleOrders.length > 0 && visibleOrders.every((o) => prev.has(o.id))) {
        const next = new Set(prev);
        for (const o of visibleOrders) next.delete(o.id);
        return next;
      }
      const next = new Set(prev);
      for (const o of visibleOrders) next.add(o.id);
      return next;
    });
  }, [visibleOrders]);

  // Batch Due Date apply — reuses the EXACT endpoint + patch shape the dept
  // sheet + planning tracker + folder detail page use:
  //   POST /api/production-orders/bulk-patch { patches: [{ poId, jobCardId, dueDate }] }
  // Builds one patch per (selected order × matching department job card),
  // scoped to overviewBatchDept ("ALL" → every dept job card on the order).
  // dueDate only — status is intentionally untouched (schedule vs progress).
  const applyOverviewBatchDueDate = useCallback(async (date: string) => {
    setOverviewBatchDueDateOpen(false);
    const patches: Array<{ poId: string; jobCardId: string; dueDate: string }> = [];
    for (const order of selectedOverviewOrders) {
      for (const jc of order.jobCards) {
        if (overviewBatchDept !== "ALL" && jc.departmentCode !== overviewBatchDept) continue;
        patches.push({ poId: order.id, jobCardId: jc.id, dueDate: date });
      }
    }
    if (patches.length === 0) {
      toast.error(
        overviewBatchDept === "ALL"
          ? "Selected orders have no job cards to update."
          : `No ${DEPARTMENTS.find((d) => d.code === overviewBatchDept)?.name ?? overviewBatchDept} job cards on the selected orders.`,
      );
      return;
    }
    try {
      const res = await fetch("/api/production-orders/bulk-patch", {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify({ patches }),
        credentials: "include",
      });
      const j = (await res.json()) as { results?: Array<{ success: boolean; error?: string }>; error?: string; missingPermission?: string };
      if (!res.ok) {
        toast.error(
          j.missingPermission
            ? "Save failed — you don't have permission to make this change. Nothing was saved."
            : `Save failed — ${j.error ?? `error ${res.status}`}. Nothing was saved.`,
        );
        return;
      }
      const failed = (j.results || []).filter((x) => !x.success);
      if (failed.length > 0) {
        toast.error(`${failed.length} of ${patches.length} failed: ${failed[0].error ?? "unknown"}`);
      } else {
        const scope = overviewBatchDept === "ALL"
          ? "all departments"
          : (DEPARTMENTS.find((d) => d.code === overviewBatchDept)?.name ?? overviewBatchDept);
        const verb = date ? "Set due date" : "Cleared due date";
        toast.success(`${verb} (${scope}) on ${selectedOverviewOrders.length} order${selectedOverviewOrders.length === 1 ? "" : "s"}.`);
      }
      // Optimistic local write so the new dates show before the refetch lands —
      // mirrors the dept-sheet batch handler. Then drop the cached matrix +
      // refetch so any server-side recompute (overdue colouring) reconciles.
      const patchedJcIds = new Set(patches.map((p) => p.jobCardId));
      setOrders((prev) =>
        prev.map((po) => {
          if (!patches.some((p) => p.poId === po.id)) return po;
          return {
            ...po,
            jobCards: po.jobCards.map((jc) =>
              patchedJcIds.has(jc.id) ? { ...jc, dueDate: date || "" } : jc,
            ),
          };
        }),
      );
      invalidateCachePrefix("/api/production-orders");
      refreshOrders();
      setSelectedOverviewIds(new Set());
    } catch (err) {
      toast.error(`Batch save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [selectedOverviewOrders, overviewBatchDept, toast, refreshOrders]);

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
  // When a column filter narrows the matrix, reset the body scroll to the top
  // so the row virtualizer re-anchors. Without this it can hold a stale scroll
  // offset whose row indices no longer exist after the filter, leaving the
  // visible area blank (Wei Siang's "整列变空白" — and different users saw
  // different empty-row counts depending on their prior scroll position).
  useEffect(() => {
    if (overviewBodyRef.current) overviewBodyRef.current.scrollTop = 0;
  }, [overviewFilters]);

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
  //
  // Phase 2 (Production performance refactor): the heavy buildPickerIndex
  // → buildBaseRows pass — which used to run synchronously in two useMemos
  // here and froze the main thread for hundreds of ms on every filter
  // change / dept switch — now runs inside baserows.worker.ts (a module
  // Web Worker). This page posts the render-scope inputs to the worker
  // whenever they change and writes the worker's reply into `baseRows`
  // state. The pure functions are unchanged, so the rendered grid is
  // identical — it just no longer blocks paint while it computes.
  // (The worker ref + `baseRows` / `baserowsPending` state are declared
  // up with the other state hooks so the filter-row "Updating…" hint can
  // read `baserowsPending`; the effects that drive them live here.)

  // Instantiate the worker once. Vite's native worker syntax — no extra
  // vite.config.ts setup needed (the { type: "module" } worker is bundled
  // automatically). Terminated on unmount so a dept-page navigation
  // doesn't leak a worker.
  useEffect(() => {
    const worker = new Worker(
      new URL("./baserows.worker.ts", import.meta.url),
      { type: "module" },
    );
    baserowsWorkerRef.current = worker;
    worker.onmessage = (e: MessageEvent<BaseRowsResponse>) => {
      const { reqId, rows } = e.data;
      // Drop stale replies: a newer post has already superseded this one.
      if (reqId !== baserowsReqRef.current) return;
      setBaseRows(rows);
      setBaserowsPending(false);
    };
    return () => {
      worker.terminate();
      baserowsWorkerRef.current = null;
    };
  }, []);

  // Post the render-scope inputs to the worker whenever they change. An
  // optimistic cell edit mutates `orders` (see patchJobCard's setOrders
  // splice), which flows through `filteredOrders` and re-fires this
  // effect — so an edit reaches the grid after one worker round-trip.
  // The worker turnaround is fast (structured-clone in + pure off-thread
  // compute + clone out) and the previous rows stay rendered until the
  // reply lands, so an edit never blanks or sticks the grid.
  //
  // Phase 3 — cut the structured-clone cost. The page no longer clones
  // the full unfiltered `orders` (~15k job cards) into the worker. It
  // posts only `filteredOrders` — the rows the grid will actually build —
  // plus `dirtyPoIds`, the POs whose jobCards changed since the last post
  // (drained from pendingDirtyPoIdsRef). The worker keeps a per-PO
  // picker-index cache and rebuilds an entry only for a dirty / uncached
  // PO, so:
  //   • a pure filter / dept change posts a (often small) filteredOrders
  //     with ZERO dirty POs → the worker reuses its whole cached index;
  //   • an optimistic cell edit posts filteredOrders with exactly one
  //     dirty PO → the worker re-indexes one order, not all 1040.
  // Either way the grid is byte-identical: the SAME buildBaseRows runs
  // over the SAME filteredOrders, and every index entry it reads equals
  // a fresh buildPickerIndex entry (entries are per-PO independent).
  useEffect(() => {
    const worker = baserowsWorkerRef.current;
    if (!worker) return;
    const today = todayYmdMY();
    const reqId = ++baserowsReqRef.current;
    setBaserowsPending(true);
    // Drain the accumulated dirty-PO set — this post takes ownership of
    // it so the worker's cache is brought current; later edits start a
    // fresh set.
    const dirtyPoIds = Array.from(pendingDirtyPoIdsRef.current);
    pendingDirtyPoIdsRef.current = new Set();
    worker.postMessage({
      reqId,
      filteredOrders,
      dirtyPoIds,
      // Cache generation is currently constant — the per-PO dirty diff is
      // exact, so the worker's cache never needs a blanket reset. Kept as
      // a forward-compatible safety valve (see baserows.worker.ts).
      cacheGeneration: 0,
      mode,
      activeTab,
      today,
    });
    // `orders` is in the deps so a genuine `orders` change re-fires this
    // effect (and the dirty-PO diff above will already have recorded
    // which POs changed); mode + activeTab drive the scopeDept guard
    // inside buildBaseRows. In "full" mode activeTab does not affect the
    // result (scopeDept = null), so it's excluded there to avoid a
    // redundant recompute on every in-page tab switch — mirrors the old
    // memo deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, filteredOrders, mode, mode === "full" ? null : activeTab]);

  const deptRows = useMemo<DeptRow[]>(() => {
    if (activeTab === "ALL") return [];
    // Live editable-field overlay (owner 2026-06-26 "填进去会一瞬间不见"). The
    // baseRows web worker rebuilds a PO's rows a beat after an edit (~2s on a
    // complex PO). Without this, an edited cell shows its OLD value until the
    // worker catches up — the flicker / vanish on rack / PIC / completion /
    // Sent. The patch* handlers update `orders` optimistically + synchronously,
    // so we overlay those editable fields from the LIVE job card here → every
    // edit reflects INSTANTLY; the worker still rebuilds the DERIVED fields
    // (scheduling / overdue) in the background. The overlay equals the live
    // values, so it's a no-op whenever nothing is in flight.
    const liveJc = new Map<string, Record<string, unknown>>();
    for (const o of filteredOrders) {
      for (const jc of o.jobCards) {
        liveJc.set(jc.id, jc as unknown as Record<string, unknown>);
      }
    }
    // Resolve a PIC's display name from its worker id when the live job card
    // carries pic{1,2}Id but no pic{1,2}Name. After assigning a PIC, the
    // fresh-PO read-back + the list snapshot return the stored pic ID but not
    // always the JOINED name, so reading pic1Name alone blanked the cell for a
    // beat ("选了人 → 出现 → 不见 → 又出来"). pic1Id is always present, so this
    // keeps the name on screen continuously. Completion date never flickered
    // because it's a stored field with no join. BUG-2026-06-26-002.
    const workerNameById = new Map<string, string>();
    for (const w of workers) workerNameById.set(w.id, w.name);
    const picName = (name: unknown, id: unknown): string =>
      (name as string) ||
      (typeof id === "string" ? workerNameById.get(id) ?? "" : "") ||
      "";
    const rows: DeptRow[] = baseRows
      .filter((r) => r._deptCode === activeTab)
      .map((r, i) => {
        // Drop the internal _deptCode marker + renumber rowNo for the
        // filtered view. Spreading into a fresh object avoids mutating
        // baseRows (which React would otherwise see as unchanged refs).
        const { _deptCode: _drop, ...clean } = r;
        void _drop;
        const jc = liveJc.get(clean.jobCardId);
        if (!jc) return { ...clean, rowNo: i + 1 };
        // Mirror baserows-core.ts's exact field formulas so the overlay equals
        // what the worker would produce (identical when idle, instant on edit).
        const distributedAt =
          (jc.distributedAt as string | null | undefined) ?? null;
        return {
          ...clean,
          rowNo: i + 1,
          rack: ((jc.rackingNumber as string) || "") as DeptRow["rack"],
          dueDate: (jc.dueDate as string) || "",
          completedDate: (jc.completedDate as string) || "",
          distributedAt,
          sent: distributedAt ? "Yes" : "No",
          pic1: picName(jc.pic1Name, jc.pic1Id),
          pic2: picName(jc.pic2Name, jc.pic2Id),
          status: ((jc.status as string) || "") as DeptRow["status"],
        };
      });

    // FAB_CUT used to merge multiple component JCs into one row (sofa: by
    // SO+fabric, BF/accessory: by poId), with downstream fan-out PATCH and
    // a sentinel sticker. That merge / fan-out / sentinel split was the
    // source of duplicate-row, qty-mismatch and mixed-status filter bugs
    // (Wei Siang Apr 26 2026). FAB_CUT now behaves identically to every
    // other dept — one row per matching JobCard, no merge.
    return rows;
  }, [baseRows, activeTab, filteredOrders, workers]);

  // Force-show allowlist passed to the dept <DataGrid>. Two sources unioned:
  //   1. forceShowCompletedIds — rows the operator just flipped to COMPLETED
  //      this session (BUG-2026-06-23-004), kept visible despite the hide.
  //   2. While a top-bar search is active — EVERY current deptRows id. This is
  //      the dept-tab search fix (2026-06-23): the page already narrows the
  //      grid to the search match upstream (filteredOrders filters `orders` by
  //      haystackByPo at the SO/PO level, then buildBaseRows → baseRows →
  //      deptRows carries only those orders' rows — deptRows is PRE-SEARCH-
  //      FILTERED, it never holds a non-matching order). But the grid's seeded
  //      hide-COMPLETED Status value-filter still drops a matched COMPLETED /
  //      TRANSFERRED row, and the seed effect won't clear that filter without a
  //      remount (which would wipe the multi-select). forceShowKeys IS exempt
  //      from value filters (data-grid.tsx:2211-2218), so exempting the current
  //      deptRows ids reveals exactly the searched rows — including the
  //      completed/transferred ones — while a search that matches NOTHING
  //      leaves deptRows empty (nothing to reveal). Only built while searching,
  //      so with no search active this is just forceShowCompletedIds and the
  //      grid is byte-identical. Does NOT feed the grid `key`, so it never
  //      remounts the grid (selection + batch toolbar survive).
  const deptForceShowKeys = useMemo<ReadonlySet<string>>(() => {
    if (!searchActive) return forceShowCompletedIds;
    const next = new Set<string>(forceShowCompletedIds);
    for (const r of deptRows) next.add(r.id);
    return next;
  }, [searchActive, forceShowCompletedIds, deptRows]);

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
              patch.completedDate = todayYmdMY();
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
            // Keep the row visible (until reload) when it flips to a hidden
            // status (COMPLETED/TRANSFERRED) — same allowlist as batch; drop it
            // when it leaves DONE. Matches the completion-cell + batch paths.
            markRowCompletedVisible(
              row.id,
              next === "COMPLETED" || next === "TRANSFERRED",
            );
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

  // Due Date binding (Wei Siang 2026-05-28, corrected): the binding key is
  // the SOID = the line-suffixed production-order id (row.poId / row.soId),
  // NOT the parent sales order. One SO with 4 items = 4 SOIDs, each with
  // its OWN due date. Within ONE department, the WIP job cards of the SAME
  // SOID must share a due date (a single item-line can fan into multiple
  // WIP pieces in one dept — base frame + armrest etc.). Different SOIDs
  // and different departments stay independent.
  //
  // deptRows is already filtered to the active dept, so grouping by poId
  // gives exactly "same SOID + same department". Each sibling goes through
  // the patchJobCard queue (optimistic update + draft-debounce + rollback
  // per JC).
  const applyDueDateBound = (row: DeptRow, v: string) => {
    const siblings = deptRows.filter((r) => r.poId === row.poId);
    for (const sib of siblings) {
      patchJobCard(sib.poId, sib.jobCardId, { dueDate: v });
    }
    if (siblings.length > 1) {
      toast.success(
        `Due date applied to ${siblings.length} ${activeTab.replace(/_/g, " ")} WIP cards of ${row.soId}`,
      );
    }
  };

  const renderDueCell = (row: DeptRow) =>
    renderDateCell(row, "dueDate", row.dueDate, (v) => applyDueDateBound(row, v));

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
              // Keep a just-completed row visible (until reload), same as batch.
              markRowCompletedVisible(row.id, !!v);
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
        // ON HOLD reason (0185) — only when this row's parent order is on hold
        // AND a reason was captured. The full reason + who + when goes in the
        // chip's hover/tap tooltip; a faint truncated one-liner sits under the
        // SO ID so the operator sees "why paused" at a glance without clutter.
        const onHold = row.poStatus === "ON_HOLD";
        const holdReason = onHold ? (row.holdReason || "").trim() : "";
        const holdTooltip = holdReason
          ? `On hold: ${holdReason}${
              row.heldBy ? ` — ${row.heldBy}` : ""
            }${row.heldAt ? ` (${row.heldAt})` : ""}`
          : "";
        return (
          <span className="flex flex-col min-w-0 leading-tight tabular-nums">
            <span className="flex items-center gap-1.5 min-w-0">
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
                  className={`text-[9px] font-semibold px-1.5 py-[1px] rounded uppercase tracking-wide cursor-default ${pillCls}`}
                  title={holdTooltip || undefined}
                >
                  {pillLabel}
                </span>
              )}
            </span>
            {holdReason && (
              <span
                className="text-[10px] italic text-[#9C6F1E]/70 truncate"
                title={holdTooltip}
              >
                {holdReason}
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
    // Pieces to cut — the cutting-recipe panel / piece count for this WIP.
    // Distinct from Qty: a single sofa / divan order (Qty 1) can need
    // several fabric pieces cut (combined sofa = one per compartment,
    // Queen/King divan = 2 panels). Surfaced as its own column so the
    // floor sees how many pieces to cut without the Qty column lying
    // about the order quantity. See BUG-2026-06-01-001.
    { key: "piecesToCut",   label: "Pieces",         type: "number", width: "70px",  sortable: true, align: "right" },
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
    // Planning aids (2026-05-28) — read-only. Customer DD = what the
    // customer asked for; Our Expected DD = Hookka's internal target.
    // Helps the operator schedule the editable Due column without
    // overshooting the promise. Default-hidden on tablet to save width.
    {
      key: "customerDeliveryDate",
      label: "Customer DD",
      type: "date",
      width: "110px",
      sortable: true,
      align: "center",
      defaultHidden: isTablet,
      // Match the default date-cell styling (tabular-nums, inherited font
      // size) so the column lines up with the neighbouring Due / Completion
      // dates instead of rendering smaller + grey + baseline-shifted.
      render: (_v, row) => (
        <span className="tabular-nums">
          {row.customerDeliveryDate ? fmtShortDate(row.customerDeliveryDate) : "—"}
        </span>
      ),
    },
    {
      key: "hookkaExpectedDD",
      label: "Our Expected DD",
      type: "date",
      width: "120px",
      sortable: true,
      align: "center",
      defaultHidden: isTablet,
      render: (_v, row) => (
        <span className="tabular-nums">
          {row.hookkaExpectedDD ? fmtShortDate(row.hookkaExpectedDD) : "—"}
        </span>
      ),
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
    {
      // "Barcode" — toggleable in the Columns menu like any other (Wei Siang
      // 2026-06-15: "应该做在 column 那边"). On screen it shows the SHORT 10-digit
      // barcode token (Wei Siang 2026-06-16 "很多字是多余的"); the scannable QR of
      // the same token is drawn by the Print Schedule output (see
      // handlePrintSchedule / jobCardQrDataUrl). The key MUST stay "scanCode"
      // (the print CSS class + the showScan check key off it); only the label
      // is "Barcode" — it propagates to the printed column header too (the print
      // header reads c.label), so this one rename covers both surfaces.
      // Owner 2026-06-27: the schedule barcode is now scanned routinely, so this
      // column is VISIBLE BY DEFAULT (defaultHidden:false). The Columns toggle
      // stays — operators can still hide it. Users who already saved a personal
      // column layout keep theirs (their saved set wins over this default); only
      // users who never customized get the column shown.
      key: "scanCode",
      label: "Barcode",
      type: "text",
      width: "120px",
      sortable: false,
      defaultHidden: false,
      render: (_v, row) => {
        if (!row.jobCardId) return null;
        const token = deriveBarcodeToken(row.jobCardId, activeTab);
        return (
          <span className="font-mono text-[11px] text-[#6B7280]">{token}</span>
        );
      },
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
        (activeTab === "FAB_SEW" || activeTab === "FAB_CUT") &&
        (row.wipType === "CUSHION" ||
          row.wipType === "ARMREST" ||
          row.wipType === "HEADREST")
      ) {
        continue;
      }
      // FAB_CUT / FAB_SEW: ONE sticker per sofa variant — the BASE represents
      // the whole variant (CUSHION/ARMREST/HEADREST skipped above). Its QR
      // encodes the FG-<DEPT> sentinel, so scanning routes to scan-complete-dept,
      // which fans out and marks EVERY compartment job card of this variant in
      // this department complete in one scan (Wei Siang 2026-06-03: one worker
      // does the whole variant). Every other dept keeps per-JC stickers + the
      // standard /scan-complete flow. The variant PO travels in the QR `po` param.
      const opId =
        activeTab === "FAB_SEW"
          ? "FG-FAB_SEW"
          : activeTab === "FAB_CUT"
            ? "FG-FAB_CUT"
            : row.jobCardId;
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
      // Fan out one physical sticker PER PIECE — use piecesToCut (the
      // cutting-recipe panel count), NOT qty (the order quantity, always
      // 1). See BUG-2026-06-01-001: qty used to carry the piece count;
      // it now carries order quantity, so the piece count moved here.
      // FAB_CUT stays ONE sticker per variant (one worker cuts the whole
      // variant — Wei Siang 2026-06-03). FAB_SEW now fans out PER PIECE like
      // every other dept (Wei Siang 2026-06-06: a qty-2 Divan = 2 Fab Sew
      // stickers, scan each to complete that piece). The shared FG-FAB_SEW
      // sentinel is kept (one sticker still serves both Sewing and Upholstery —
      // the completing dept is decided by who scans, and pieceNo flows in the
      // QR p=/t= so the backend completes just the scanned piece).
      // FAB_SEW per-piece fan-out is ONLY for bedframe pieces (Divan / Headboard),
      // which are separately scannable. A sofa BASE represents the WHOLE variant
      // (base + cushion + armrest sewn together — Wei Siang 2026-06-03 / -07), so
      // it stays ONE sticker. FAB_CUT is one-per-variant too.
      const pieceCount =
        activeTab === "FAB_CUT" ||
        (activeTab === "FAB_SEW" && row.wipType === "BASE")
          ? 1
          : Math.max(1, row.piecesToCut || 1);
      const displayQty = pieceCount > 1 ? 1 : Math.max(1, row.piecesToCut || 1);
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
      // Fab Sew sticker carries the SHORT compartment subtype (the wipKey's 3rd
      // ::-segment, e.g. DIVAN / SOFA_BASE) so the QR stays low-density (v5,
      // scannable like Fab Cut). Empty for a wipKey-less row → op=<jobCardId>.
      const fsCompartment =
        activeTab === "FAB_SEW" ? (row.wipKey || "").split("::")[2] || "" : "";
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
          // Fab Sew sticker = the SHORT compartment form (c=<subtype>) so the QR
          // is low-density (v5) and scans like Fab Cut; the dense wipKey/UUID blob
          // (v6+) was what the camera couldn't lock onto. Completion resolves the
          // right dept server-side: handleConfirmScan routes a FAB_SEW card to
          // scan-complete-shared (dept by the worker's section; a sofa BASE fans
          // out to the whole variant). wipKey-less rows fall back to op=jobCardId.
          // FAB_CUT keeps its FG sentinel; other depts already use op=<jobCardId>.
          qrPayload:
            activeTab !== "FAB_SEW"
              ? generateStickerData(
                  order.poNo,
                  activeTab,
                  opId,
                  "/worker/scan",
                  pieceCount > 1 ? p : undefined,
                  pieceCount > 1 ? pieceCount : undefined,
                )
              : fsCompartment
                ? generateCompartmentStickerData(
                    order.poNo,
                    fsCompartment,
                    "/worker/scan",
                    pieceCount > 1 ? p : undefined,
                    pieceCount > 1 ? pieceCount : undefined,
                  )
                : generateStickerData(
                    order.poNo,
                    "FAB_SEW",
                    row.jobCardId,
                    "/worker/scan",
                    pieceCount > 1 ? p : undefined,
                    pieceCount > 1 ? pieceCount : undefined,
                  ),
        });
      }
    }
    return stickers;
  }, [filteredOrders, activeTab, wipNameFor, deptRows, gridFilteredDeptRows]);

  // FAB_CUT only: load + build the downstream Fabric Sewing (FAB_SEW)
  // stickers for the SAME orders the Fab Cut grid is currently showing.
  // Output is the exact same JobCardSticker shape — fed through the same
  // large tile + the same #batch-jobcard-print container — so a Fab Sew
  // sticker pulled from the Fab Cut tab is byte-identical to one printed
  // from the Fab Sew tab itself.
  //
  // Why a FETCH (not the in-memory baseRows): on the FAB_CUT tab the page
  // loads orders DEPT-SCOPED — the production-orders fetch carries
  // `&dept=FAB_CUT`, so the in-memory orders / baseRows contain ONLY
  // FAB_CUT job cards. There are zero FAB_SEW rows to find in memory, so
  // the old baseRows-sourced memo always produced "No Fab Sew job cards".
  // We copy the Foam Bonding → Packing fix: on click, re-fetch
  // /api/production-orders?fields=minimal&include=jobCards WITHOUT `&dept=`
  // (so every department's job cards come back), scope to the SO ids
  // currently visible in the Fab Cut grid, then build the FAB_SEW rows
  // client-side with the SAME pure builder the grid's worker runs
  // (buildBaseRows in "full" mode — all-dept output, tagged `_deptCode`).
  //
  // The fan-out loop is identical to the old memo / the FAB_SEW branch of
  // onScreenStickers: skip CUSHION/ARMREST/HEADREST sub-components,
  // BASE→productCode WIP label, piecesToCut piece fan-out, p=N&t=M payload.
  //
  // Lazy: only runs on click of Show Fab Sew QR / Print Fab Sew Stickers
  // (sets loadingFabSew while in flight, stores into fabSewStickers) so
  // plain Fab Cut tab entry never pays for this fetch.
  const loadFabSewStickers = useCallback(async (): Promise<JobCardSticker[]> => {
    if (activeTab !== "FAB_CUT") return [];
    // Scope to whatever the Fab Cut sheet is SHOWING — its column filters /
    // in-grid search applied — falling back to the full FAB_CUT set until
    // the DataGrid reports. Mirrors how the FG preview loader scopes: by the
    // per-line production-order id (row.poId === order.id), NOT the parent
    // sales-order id. Scoping by SO id pulled EVERY line of the parent SO
    // (e.g. 216-01/02/03/04 when only 216-04 + 216-01 were on screen), so the
    // Fab Sew preview must constrain to exactly the line-rows the grid shows.
    const fabCutRows =
      (gridFilteredDeptRows as unknown as DeptRow[] | null) ?? deptRows;
    const poIds = new Set(
      fabCutRows.map((r) => r.poId).filter(Boolean),
    );
    if (poIds.size === 0) {
      toast.info("No Fab Cut rows are visible. Adjust the filter and try again.");
      return [];
    }
    setLoadingFabSew(true);
    try {
      // Scoped fetch (2026-06-24 perf): pull ONLY the visible Fab Cut orders +
      // their SO/CO group siblings, not the whole org. Two phases keep each
      // request tiny. The Fab Cut grid merges a sofa's pieces into ONE anchor
      // row, so phase 2 expands each visible SOFA anchor to its group — the
      // siblings carry the OTHER pieces' Fab Sew job cards.
      const FETCH_BASE =
        "/api/production-orders?fields=minimal&include=jobCards";
      const fetchScope = async (
        tokens: string[],
      ): Promise<ProductionOrder[]> => {
        if (tokens.length === 0) return [];
        const r = await fetch(
          `${FETCH_BASE}&scope=${encodeURIComponent(tokens.join(","))}`,
          { credentials: "include" },
        );
        const j = (await r.json().catch(() => null)) as
          | { success?: boolean; data?: ProductionOrder[] }
          | null;
        return j?.success && Array.isArray(j.data) ? j.data : [];
      };
      let all = await fetchScope(Array.from(poIds));
      const sofaGids = new Set<string>();
      for (const o of all) {
        if (o.itemCategory !== "SOFA" || !poIds.has(o.id)) continue;
        const gid =
          o.companySOId ||
          o.salesOrderId ||
          o.companyCOId ||
          o.consignmentOrderId ||
          "";
        if (gid) sofaGids.add(gid);
      }
      if (sofaGids.size > 0) {
        const seen = new Set(all.map((o) => o.id));
        for (const sib of await fetchScope(Array.from(sofaGids))) {
          if (!seen.has(sib.id)) {
            all.push(sib);
            seen.add(sib.id);
          }
        }
      }
      // Safety net: a scoped fetch that came back empty (unexpected backend
      // hiccup) while rows ARE visible falls back to the full fetch so a print
      // is never silently short. Slower, but correct beats fast-but-wrong.
      if (all.length === 0) {
        const r = await fetch(FETCH_BASE, { credentials: "include" });
        const j = (await r.json().catch(() => null)) as
          | { success?: boolean; data?: ProductionOrder[] }
          | null;
        all = j?.success && Array.isArray(j.data) ? j.data : [];
      }
      if (all.length === 0) {
        toast.warning("Could not load production orders.");
        return [];
      }
      // The Fab Cut grid MERGES a sofa's per-variant FC job cards into ONE
      // anchor row (Option C), so a 2-piece sofa (e.g. SO-2605-225 = 1A(LHF) +
      // 1A(RHF)) shows a single Fab Cut row carrying only the anchor PO's id.
      // Its sibling POs hold the OTHER pieces' Fab Sew job cards — scoping by
      // the visible poId alone would print only the anchor's Fab Sew sticker (1)
      // instead of the full set the Fab Sew page shows (2). Expand each visible
      // SOFA poId to its merge-group siblings using the SAME recipe as
      // buildBaseRows' cross-PO scan (groupId = companySOId | salesOrderId |
      // companyCOId | consignmentOrderId, then SOFA must also match base model +
      // fabric), so "Print Fab Sew" produces exactly what the Fab Sew page does.
      // BF/ACC keep their own per-PO FC rows, so this loop is a no-op for them —
      // it does NOT regress the "don't pull the whole parent SO's lines" rule.
      const byId = new Map(all.map((o) => [o.id, o] as const));
      const groupIndex = new Map<string, ProductionOrder[]>();
      for (const o of all) {
        const gid =
          o.companySOId || o.salesOrderId || o.companyCOId || o.consignmentOrderId || "";
        if (!gid) continue;
        const arr = groupIndex.get(gid);
        if (arr) arr.push(o);
        else groupIndex.set(gid, [o]);
      }
      const expandedIds = new Set(poIds);
      for (const pid of Array.from(poIds)) {
        const anchor = byId.get(pid);
        if (!anchor || anchor.itemCategory !== "SOFA") continue;
        const gid =
          anchor.companySOId || anchor.salesOrderId || anchor.companyCOId || anchor.consignmentOrderId || "";
        if (!gid) continue;
        const myBase = (anchor.productCode || "").split("-")[0];
        const myFabric = anchor.fabricCode || "";
        for (const sib of groupIndex.get(gid) || []) {
          if (sib.id === anchor.id) continue;
          if ((sib.fabricCode || "") !== myFabric) continue;
          if ((sib.productCode || "").split("-")[0] !== myBase) continue;
          expandedIds.add(sib.id);
        }
      }
      const scoped = all.filter((o) => expandedIds.has(o.id));
      if (scoped.length === 0) {
        toast.warning("Could not match the visible Fab Cut rows to any production orders.");
        return [];
      }
      // Build the all-dept DeptRow list for the scoped orders with the SAME
      // pure pass the grid's worker runs, so the FAB_SEW rows (and every
      // field the fan-out reads) are byte-identical to the Fab Sew tab's.
      const today = todayISO();
      const pickerIndex = new Map<string, PickerByDept>();
      for (const o of scoped) pickerIndex.set(o.id, buildOnePickerEntry(o));
      const builtRows = buildBaseRows(scoped, pickerIndex, "full", "FAB_SEW", today);
      const fabSewRows = builtRows.filter((r) => r._deptCode === "FAB_SEW");
      const orderById = new Map(scoped.map((o) => [o.id, o] as const));
      const stickers: JobCardSticker[] = [];
      for (const row of fabSewRows) {
        const order = orderById.get(row.poId);
        if (!order) continue;
        // Same FAB_SEW rule as onScreenStickers: the operator sews the whole
        // upholstery assembly in one pass — skip the Back Cushion / Armrest /
        // Headrest sub-component JCs; the BASE sticker travels with the
        // assembly.
        if (
          row.wipType === "CUSHION" ||
          row.wipType === "ARMREST" ||
          row.wipType === "HEADREST"
        ) {
          continue;
        }
        // FAB_SEW shared sticker — sentinel opId (one sticker serves both
        // Sewing and Upholstery; completing dept decided by who scans). Fans
        // out PER PIECE (Wei Siang 2026-06-06), mirroring the FAB_SEW branch of
        // onScreenStickers — a qty-2 Divan = 2 stickers, scan each.
        const opId = "FG-FAB_SEW";
        // Sofa BASE = one sticker for the whole variant; only bedframe pieces
        // (Divan / Headboard) fan per piece (mirror onScreenStickers).
        const pieceCount =
          row.wipType === "BASE" ? 1 : Math.max(1, row.piecesToCut || 1);
        const displayQty = pieceCount > 1 ? 1 : Math.max(1, row.piecesToCut || 1);
        // BASE on FAB_SEW shows the variant-qualified product code as the WIP
        // label (e.g. "5540-1A(LHF)"), not the long fabric-encoded string —
        // identical to the FAB_SEW branch of onScreenStickers.
        const stickerWipName =
          row.wipType === "BASE"
            ? row.productCode || row.model || row.wip || ""
            : row.wip;
        // Short compartment subtype for the low-density QR (mirror onScreenStickers).
        const fsCompartment = (row.wipKey || "").split("::")[2] || "";
        for (let p = 1; p <= pieceCount; p++) {
          stickers.push({
            key: pieceCount > 1 ? `fabsew:${row.id}:${p}` : `fabsew:${row.id}`,
            poNo: order.poNo,
            deptCode: "FAB_SEW",
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
            // SHORT compartment form (c=<subtype>) → low-density v5 QR (mirror
            // onScreenStickers); wipKey-less rows fall back to op=<jobCardId>.
            qrPayload: fsCompartment
              ? generateCompartmentStickerData(
                  order.poNo,
                  fsCompartment,
                  "/worker/scan",
                  pieceCount > 1 ? p : undefined,
                  pieceCount > 1 ? pieceCount : undefined,
                )
              : generateStickerData(
                  order.poNo,
                  "FAB_SEW",
                  row.jobCardId,
                  "/worker/scan",
                  pieceCount > 1 ? p : undefined,
                  pieceCount > 1 ? pieceCount : undefined,
                ),
          });
        }
      }
      setFabSewStickers(stickers);
      return stickers;
    } catch (err) {
      console.error("[loadFabSewStickers] failed", err);
      toast.error("Failed to load Fab Sew stickers.");
      return [];
    } finally {
      setLoadingFabSew(false);
    }
  }, [activeTab, gridFilteredDeptRows, deptRows, toast]);

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
      const ok = await confirm({
        title: "Print all stickers?",
        message: `This will print ${onScreenStickers.length} job card stickers (${onScreenStickers.length} pages of 50×75 mm). Continue?`,
      });
      if (!ok) return;
    }
    setPrintingJobCards(true);
    try {
      // Re-generate every QR locally so the print preview doesn't depend on
      // hundreds of external HTTP calls loading in the 300 ms print timeout.
      const batch: JobCardSticker[] = await Promise.all(
        onScreenStickers.map(async (s) => ({
          ...s,
          qrDataUrl: await getQRCodeDataURL(s.qrPayload, 600),
        })),
      );
      setFgStickers([]); // never mix modes in one print job
      setJobCardStickers(batch);
    } finally {
      setPrintingJobCards(false);
    }
  }, [onScreenStickers, activeTab, toast, confirm]);

  // FAB_CUT only: Show / Print the downstream Fab Sew stickers. Mirrors the
  // Foam Bonding Show Packing Preview / Print Packing pair, but acts on the
  // fetched-and-built `fabSewStickers`.
  //
  // Show: if already showing, just hide (keep the loaded stickers around so
  // a re-show without changing filter is instant). Otherwise fetch + build
  // (loadFabSewStickers) and reveal the on-screen tile strip. The first
  // click pays the fetch; the loading flag drives the button label.
  const handleShowFabSewStrip = useCallback(async () => {
    if (showFabSewStrip) {
      setShowFabSewStrip(false);
      return;
    }
    const stickers = await loadFabSewStickers();
    if (stickers.length === 0) return;
    setShowFabSewStrip(true);
  }, [showFabSewStrip, loadFabSewStickers]);

  // Print: if the preview already loaded the stickers, print those directly
  // (operator can WYSIWYG check before printing). Otherwise fetch + build,
  // then push the batch into the SAME hidden #batch-jobcard-print container
  // via setJobCardStickers — exactly like handlePrintJobCardStickers.
  // Because we're on the FAB_CUT tab, the print container's `useLargeSticker`
  // flag is already true, so the FAB_SEW tiles render through the 100×150mm
  // large layout identical to the Fab Sew tab.
  const handlePrintFabSewStickers = useCallback(async () => {
    const source =
      fabSewStickers.length > 0 ? fabSewStickers : await loadFabSewStickers();
    if (source.length === 0) {
      // loadFabSewStickers already surfaced the reason via toast.
      return;
    }
    // Same mega-print guard-rail as the native pair.
    if (source.length > 500) {
      const ok = await confirm({
        title: "Print all stickers?",
        message: `This will print ${source.length} Fab Sew stickers (${source.length} pages of 100×150 mm). Continue?`,
      });
      if (!ok) return;
    }
    setPrintingFabSew(true);
    try {
      // Re-generate every QR locally — same reason as the native print path:
      // the 300 ms print timeout can't wait on hundreds of external HTTP QRs.
      const batch: JobCardSticker[] = await Promise.all(
        source.map(async (s) => ({
          ...s,
          qrDataUrl: await getQRCodeDataURL(s.qrPayload, 600),
        })),
      );
      setFgStickers([]); // never mix modes in one print job
      setJobCardStickers(batch);
    } finally {
      setPrintingFabSew(false);
    }
  }, [fabSewStickers, loadFabSewStickers, confirm]);

  // Shared 230×380px on-screen sticker tile (the FAB_CUT / FAB_SEW large
  // tile). Extracted so the native QR Stickers strip AND the FAB_CUT "Show
  // Fab Sew QR" strip render through the exact same markup — a Fab Sew tile
  // pulled from the Fab Cut tab is then pixel-identical to one shown on the
  // Fab Sew tab (and, since it's the same JobCardSticker shape, identical to
  // its 100×150mm print page too). Wei Siang 2026-05-15 layout (mockup #3):
  // PO No headline → Customer/Model/WIP → Size/Colour/Gap/Divan/Leg/Total H/
  // Notes → QR + Fab Cut / Fab Sew sign-off lines + Qty.
  const renderLargeStickerTile = useCallback((s: JobCardSticker) => (
    <div
      key={s.key}
      className="flex-shrink-0 border border-[#E6E0D9] rounded-md bg-white flex flex-col p-2 overflow-hidden"
      style={{ width: "230px", height: "380px" }}
      title={`${s.customerPOId || s.poNo} · ${s.model} · Qty ${s.qty}`}
    >
      <div className="text-center font-bold leading-tight" style={{ fontSize: "16px" }}>
        {s.poNo}
      </div>
      <div className="border-t border-black my-1" />
      <div className="space-y-[2px] text-[13px] leading-tight text-[#1F1D1B]">
        <div className="truncate"><span className="inline-block w-[100px] font-semibold text-[#6B7280]">PO No</span>: {s.customerPOId || "—"}</div>
        <div className="flex items-baseline gap-1">
          <span className="inline-block w-[100px] font-semibold text-[#6B7280] shrink-0">Customer Name</span>
          <span
            className="flex-1 min-w-0 truncate"
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
              className="flex-1 min-w-0 truncate"
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
      </div>
      {/* Notes fills the space above the QR block and wraps into it. flex-1 +
          overflow-hidden: on a field-heavy BEDFRAME sticker (Gap/Divan/Leg/Total
          H rows) a long note clips ITSELF rather than pushing the QR + Fab Cut/
          Sew + Qty block off the card (owner 2026-07-11). Sofa (fewer rows) just
          shows more note lines in the bigger gap. */}
      <div className="flex items-start gap-1 flex-1 min-h-0 overflow-hidden text-[13px] leading-tight text-[#1F1D1B] pt-[2px]">
        <span className="inline-block w-[100px] font-semibold text-[#9A3A2D] shrink-0">Notes</span>
        <span
          className="flex-1 min-w-0 whitespace-normal break-words"
          style={{
            fontSize: "11px",
            lineHeight: 1.2,
          }}
        >: {oemMarkFor(s) ? <span className="font-bold text-[#6B5C32]">{oemMarkFor(s)} </span> : null}{s.specialOrder ? <span className="font-bold text-[#9A3A2D]">★ {s.specialOrder}</span> : (oemMarkFor(s) ? null : "—")}</span>
      </div>
      <div className="pt-1 border-t border-dashed border-[#6B5C32]">
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
            <div className="flex items-end justify-between mt-1">
              <span className="font-bold" style={{ fontSize: "13px" }}>Qty {s.qty}</span>
              {/* Bottom-right component-type badge — same label + omit rule as
                  the 100×150mm printout (componentBadgeLabel), scaled down for
                  the on-screen card so the operator's preview matches the
                  printed sticker. */}
              <div className="text-right leading-tight flex flex-col items-end gap-[2px]">
                {(() => {
                  const label = componentBadgeLabel(s);
                  if (!label) return null;
                  return (
                    <div
                      className="font-bold uppercase border-2 border-black text-center"
                      style={{
                        fontSize: "11px",
                        lineHeight: 1.05,
                        padding: "0px 4px",
                        borderRadius: "3px",
                      }}
                    >
                      {label}
                    </div>
                  );
                })()}
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
    </div>
  ), []);

  // Race-guard token — incremented on every loadFgStickers call so a slow
  // earlier fetch can't OVERWRITE a faster newer one. When user changes a
  // filter while the previous load is still in flight, the old fetch
  // completes after the new one (returning stale, wrong-category data)
  // and was clobbering the correct result. Bumping a ref-counter and
  // checking it against the snapshot at finish-time discards stale writes.
  const fgLoadVersion = useRef(0);
  // Pure-ish aggregator: takes a scoped list of POs, fetches their FG
  // units + product details + sales-order customerSO, runs the SO-level
  // sofa + leg-pair + pillow-pair aggregation, and returns the resulting
  // FgSticker[]. No React state writes — both `loadFgStickers` (PACKING
  // tab preview + Print All) and `handlePrintFoamPackingStickers`
  // (Foam-tab pre-print) call this so both produce IDENTICAL stickers.
  // Refactored 2026-05-24: previously this logic lived inline in
  // loadFgStickers; extracting it lets the Foam button share the exact
  // same pipeline (sofa-SO grouping, legs-into-comp1 pairing, pillow-
  // into-last-comp pairing, fullCompartment label) instead of falling
  // back to the simpler jspdf-based generateBatchStickersPdf path.
  const fetchFgStickersForOrders = useCallback(async (
    ordersToProcess: ProductionOrder[],
  ): Promise<FgSticker[]> => {
    if (ordersToProcess.length === 0) return [];
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
            | { success?: boolean; data?: { customerSO?: string | null; customerSOId?: string | null } }
            | null;
          if (j?.success && j.data) {
            // Prefer the populated customerSOId column over the sparse
            // customerSO column (same resolution as the Delivery page fix,
            // commit 2c548b60).
            customerSOBySo.set(id, j.data.customerSOId || j.data.customerSO || "");
          }
        } catch {
          // tolerate single-fetch failure — sticker just shows "—"
        }
      }),
    );
    // Whether a leg gets its own pack is now driven by the per-leg-height
    // "Pack leg separately" flag set once in the Product Catalog
    // (Maintenance > Leg Heights). When ticked, the leg gets its own pack,
    // PHYSICALLY placed inside Compartment 1 of the SO and labelled with a
    // 2-in-1 sticker shared with Compartment 1 (the composite logic below):
    // the leg never prints as its own physical sticker, but it still counts
    // as its own piece in the X/N count via the comboPairKey machinery.
    // Legacy fallback: if a leg height has no explicit flag (or no catalog
    // row), the old "leg taller than 1 inch packs separately" rule applies,
    // so pre-existing orders are unchanged. Sofa legs use sofaLegHeights;
    // bedframe / divan legs use legHeights.
    // Sofa leg-height catalog. The bedframe/divan path does not (today)
    // build a separate leg box on the FG sticker, so only the sofa list is
    // needed to drive hasLegs. The "Pack leg separately" checkbox is still
    // exposed for divan legs in the catalog (legHeights) for the owner to
    // set, but wiring a divan-leg box onto the bedframe sticker is a
    // follow-up — flagged in the build report.
    // Sofa legs use `sofaLegHeights`; bedframe / divan legs use `legHeights`.
    // Each list is managed independently in Products > Maintenance, and a leg
    // packs separately ONLY when its row's "Pack leg separately" flag is ticked.
    let legHeightOptions: LegHeightOption[] = [];
    let bedframeLegHeightOptions: LegHeightOption[] = [];
    try {
      const vc = await fetchVariantsConfig();
      const pickOptions = (list: unknown): LegHeightOption[] =>
        Array.isArray(list)
          ? (list.filter(
              (o) => o && typeof o === "object" && "value" in (o as object),
            ) as LegHeightOption[])
          : [];
      legHeightOptions = pickOptions(vc?.sofaLegHeights);
      bedframeLegHeightOptions = pickOptions(vc?.legHeights);
    } catch {
      // Catalog fetch failed — an empty option list means legPacksSeparately
      // returns false, so legs simply don't split until the config loads.
    }

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

    // Per-order sticker fetch. Each order makes the same two-call
    // Promise.all as before (generate fg-units + fetch product). Returns
    // that order's slice of stickers so the caller can place it back into
    // its original position — preserving the exact order the old serial
    // loop produced (nonSofa downstream keeps insertion order).
    const buildStickersForOrder = async (
      o: ProductionOrder,
    ): Promise<FgSticker[]> => {
      const slice: FgSticker[] = [];
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
        slice.push({
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
      return slice;
    };

    // Bounded-parallel fetch. The old code awaited each order INSIDE a
    // for...of, so all ~138 orders ran fully sequentially (~12-22s). Run
    // up to MAX_CONCURRENCY orders at once instead. Cap is intentionally
    // modest (not unbounded 138) to stay within D1/Hyperdrive connection
    // limits — each order already issues two backend calls. Results are
    // written into their original index positions, so the flattened `all`
    // array is identical to what the serial loop produced (nonSofa
    // downstream relies on this insertion order).
    const all: FgSticker[] = [];
    try {
      const MAX_CONCURRENCY = 10;
      const slices: FgSticker[][] = new Array(ordersToProcess.length);
      let nextIndex = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = nextIndex++;
          if (i >= ordersToProcess.length) return;
          slices[i] = await buildStickersForOrder(ordersToProcess[i]);
        }
      };
      const poolSize = Math.min(MAX_CONCURRENCY, ordersToProcess.length);
      await Promise.all(Array.from({ length: poolSize }, () => worker()));
      for (const slice of slices) {
        if (slice) all.push(...slice);
      }
    } catch (err) {
      console.error("[fetchFgStickersForOrders] failed", err);
      return [];
    }
    // SO-level sofa pack aggregation. Sofa pack count is computed across
    // every sofa PO in the same SO (not per PO). Within a sofa SO we also:
    //   - Inject a synthetic Legs sticker as 2-in-1 with Compartment 1
    //     when any sofa line's leg height has the catalog "Pack leg
    //     separately" flag set (legacy fallback: leg taller than 1").
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

    // Bedframe legs — mirror the sofa leg behaviour, but PER BED (per PO
    // line), because each bedframe SKU line picks its own leg in Maintenance.
    // When a bed's leg height is ticked "pack separately" in the BEDFRAME leg
    // catalog (legHeights), inject a synthetic leg piece for that bed:
    //   - numbered last for the bed (e.g. HB + 2 Divan + Leg → leg is 4/4),
    //   - badge shows the actual leg size (e.g. "6\" leg"),
    //   - rendered 2-in-1 with the bed's FIRST piece (the headboard) via the
    //     same comboPairKey machinery as sofa — never a standalone page.
    // The HB box-height number is left exactly as-is (Wei Siang 2026-06-02:
    // splitting the leg's packing does not change the headboard height).
    const bedframeBeds = new Map<string, FgSticker[]>();
    for (const s of nonSofa) {
      if (s.itemCategory === "BEDFRAME" && s.salesOrderId) {
        const bedKey = `${s.poId || s.poNo}__${s.unitNo}`;
        const list = bedframeBeds.get(bedKey) ?? [];
        list.push(s);
        bedframeBeds.set(bedKey, list);
      }
    }
    const bedframeLegStickers: FgSticker[] = [];
    for (const [, bed] of bedframeBeds) {
      const hasLegs = bed.some((s) =>
        legPacksSeparately(s.legHeightInches, bedframeLegHeightOptions),
      );
      if (!hasLegs) continue;
      bed.sort((a, b) => a.pieceNo - b.pieceNo);
      const totalWithLeg = bed.length + 1;
      const heights = Array.from(
        new Set(
          bed
            .map((s) => s.legHeightInches)
            .filter((h): h is number => h !== null && h !== undefined && h > 0),
        ),
      ).sort((a, b) => a - b);
      const legsInfo = heights.length ? heights.map((h) => `${h}"`).join(", ") : "";
      // Bump every real piece's total so they read 1/4, 2/4, 3/4...; keep
      // their existing pieceNo (HB = 1, Divans follow) and HB box label.
      for (const s of bed) s.totalPieces = totalWithLeg;
      const first = bed[0]; // HB for a full bedframe, first Divan for divan-only
      const legBadge = legsInfo ? `${legsInfo} leg` : "leg";
      bedframeLegStickers.push({
        ...first,
        key: `legs-${first.key}`,
        unitSerial: `${first.unitSerial}-LEGS`,
        shortCode: "LEGS",
        pieceNo: totalWithLeg,
        totalPieces: totalWithLeg,
        pieceName: legBadge,
        isSyntheticLegs: true,
        comboPairKey: first.key,
        legsInfo: legsInfo || first.legsInfo,
      });
    }
    nonSofa.push(...bedframeLegStickers);

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
      //
      // The leg now becomes its own piece when ANY sofa line in the SO
      // carries a leg height whose catalog "Pack leg separately" flag is
      // ticked (legPacksSeparately resolves the flag, falling back to the
      // legacy >1" rule for un-flagged / unknown heights).
      const hasLegs = group.some(
        (s) => legPacksSeparately(s.legHeightInches, legHeightOptions),
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

    return aggregated;
  }, []);

  // Enrich a built FG sticker set with the PUBLIC packing-rack tokens so the
  // printed QR can deep-link to /p/<token> (the no-login rack-assignment page)
  // instead of /worker/scan. One batched, authed call to
  // POST /api/production-orders/packing-rack-tokens resolves each sticker's
  // (poNo, pieceName) to its ONE PACKING job_card and lazily mints that card's
  // token; the result maps "<poNo>|<pieceName>" → token. Best-effort: any
  // sticker without a token keeps the /worker/scan fallback (so the worker scan
  // + completion flow is unaffected), and a failed call leaves every sticker on
  // the fallback. Synthetic Legs/Pillow stickers carry no PACKING card of their
  // own — they print inside their primary's card — so they are not requested.
  const enrichWithPackingTokens = useCallback(
    async (stickers: FgSticker[]): Promise<FgSticker[]> => {
      if (stickers.length === 0) return stickers;
      const realPieces = stickers.filter(
        (s) => !s.isSyntheticLegs && !s.isSyntheticPillow && s.poNo,
      );
      if (realPieces.length === 0) return stickers;
      const items = realPieces.map((s) => ({
        poNo: s.poNo,
        pieceName: s.pieceName,
      }));
      try {
        const res = await fetch(
          "/api/production-orders/packing-rack-tokens",
          {
            method: "POST",
            headers: csrfHeaders(),
            body: JSON.stringify({ items }),
          },
        );
        if (!res.ok) return stickers;
        const j = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          data?: {
            tokens?: Record<string, string>;
            cardIds?: Record<string, string>;
          };
        };
        const tokens = j?.data?.tokens;
        if (!tokens || typeof tokens !== "object") return stickers;
        const cardIds = j?.data?.cardIds;
        return stickers.map((s) => {
          const key = `${s.poNo}|${s.pieceName}`;
          const token = tokens[key];
          const jcId =
            cardIds && typeof cardIds === "object" ? cardIds[key] : undefined;
          if (!token && !jcId) return s;
          return {
            ...s,
            ...(token ? { packingToken: token } : {}),
            ...(jcId ? { packingJobCardId: jcId } : {}),
          };
        });
      } catch {
        // Network hiccup — keep the /worker/scan fallback on every sticker.
        return stickers;
      }
    },
    [],
  );

  // The QR value a packing sticker should encode. PREFER the public no-login
  // rack page (/p/<token>) so a storekeeper without a Worker-Portal PIN can set
  // the rack by just scanning with the phone camera. FALL BACK to the existing
  // /worker/scan deep link (FG-PACKING sentinel) when no token resolved — that
  // keeps the logged-in worker scan + completion flow working unchanged. Takes
  // the source sticker (poNo / piece markers / pieceName) so all four render
  // sites — on-screen primary, pillow pair, print primary, print pillow — build
  // the URL identically and can never drift.
  const packingStickerUrl = useCallback(
    (s: {
      poNo: string;
      pieceNo: number;
      totalPieces: number;
      pieceName: string;
      packingToken?: string;
      packingJobCardId?: string;
    }): string => {
      // Canonical origin: a packing sticker printed from the legacy prod
      // pages.dev URL still encodes erp.hookka.com (owner 2026-06-26).
      const origin = appOrigin();
      // Pass the piece number so each physical sticker of a multi-piece WIP gets
      // its OWN public rack link (/p/<token>?p=<pieceNo>) and can be racked
      // separately. Single-piece cards (pieceNo 1, totalPieces 1) still send
      // ?p=1 — harmless, the route only diverges from card-level when the piece
      // actually carries a per-piece rack.
      if (s.packingToken)
        return packingRackScanUrl(origin, s.packingToken, s.pieceNo);
      // Fallback deep-link. ADD &jc=<packing card id> when known so the scan
      // resolves by the stable card id even if the printed poNo drifted (TASK
      // 2). Additive — po=/p=/t=/pn= unchanged, so OLD stickers (and stickers
      // minted before a card id was available) still resolve exactly as before.
      let url = `${origin}/worker/scan?op=FG-PACKING&po=${encodeURIComponent(
        s.poNo,
      )}&p=${s.pieceNo}&t=${s.totalPieces}&pn=${encodeURIComponent(
        s.pieceName,
      )}`;
      if (s.packingJobCardId) {
        url += `&jc=${encodeURIComponent(s.packingJobCardId)}`;
      }
      return url;
    },
    [],
  );

  // PACKING/UPH on-screen FG sticker loader. Wraps fetchFgStickersForOrders
  // with the page-level + grid-level scope, the loading flag, the version
  // guard (prevents stale concurrent loads from overwriting newer data),
  // and the React state writes that drive the preview tiles + the hidden
  // print container's #batch-fg-print render path.
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
    setLoadingFgPreview(true);
    const built = await fetchFgStickersForOrders(ordersToProcess);
    // Mint + attach the public /p/ tokens BEFORE we show or print, so the
    // printed QR is ALWAYS the no-login /p/<token> link, never the /worker/scan
    // fallback (which opens the LOGIN page when an external phone scans it).
    // The Print flow renders from this fgStickers state, so painting the
    // fallback first then upgrading let a quick Print grab the fallback — the
    // external-scan regression (owner 2026-06-26 "外部手机扫又不行了"). The mint
    // endpoint is now BATCHED (fast), so awaiting it here doesn't stall the
    // preview the way the old serial loop did.
    const aggregated = await enrichWithPackingTokens(built);
    // Stale-load guard (filters changed mid-fetch).
    if (myVersion !== fgLoadVersion.current) return aggregated;
    setJobCardStickers([]);
    setFgStickers(aggregated);
    setLoadingFgPreview(false);
    return aggregated;
  }, [
    filteredOrders,
    gridFilteredDeptRows,
    fetchFgStickersForOrders,
    enrichWithPackingTokens,
  ]);

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

  // Foam Bonding pre-print of Packing stickers (Wei Siang 2026-05-23,
  // refactored 2026-05-24 to share the PACKING tab pipeline).
  // Operators want to print the warehouse-style Packing stickers at the
  // Foam Bonding stage so they're ready when Packing later actually
  // processes the SO. The catch: a bedframe SO's DIVAN piece never has
  // a FOAM job card, so the Foam tab's `orders` state (loaded with
  // ?dept=FOAM) is missing those POs. We re-fetch without the dept
  // filter scoped to the current search string and pipe the result
  // through `fetchFgStickersForOrders` — the SAME aggregator the
  // PACKING tab uses (sofa-SO grouping, legs-into-comp1 pairing,
  // pillow-into-last-comp pairing, fullCompartment label). The output
  // is then injected into the hidden #batch-fg-print container via
  // its own `foamPrintStickers` state (kept separate from the PACKING
  // tab's `fgStickers` so the two flows can't pollute each other),
  // and the print is triggered the same way (window.print() inside a
  // useTimeout that waits for QR images to settle).
  //
  // Behaviour:
  //   • Disabled until the operator types something into the Search
  //     box (fltSearch matches the same haystack the page-level filter
  //     uses: poNo / companySOId / customerName / productCode / fabric
  //     / sizeLabel).
  //   • On click: fetch /api/production-orders?fields=minimal&include=jobCards
  //     (no &dept= so we get every PO of the SO), filter client-side by
  //     the same haystack rule, then call fetchFgStickersForOrders →
  //     setFoamPrintStickers → setFoamPrintRequested(true). The
  //     useTimeout below fires window.print() once the hidden tree has
  //     mounted + QRs have generated.
  //   • If the operator's filter pulled in non-SO results (the haystack
  //     is freeform), we still print whatever matched — surfacing
  //     "narrow your search" is on the operator.
  // 2026-05-24 — load-only path (no print trigger). Returns the loaded
  // stickers AND sets foamPrintStickers state so the on-screen preview +
  // hidden print container both pull from the same array. Accepts TWO
  // scope sources:
  //   1. Top-bar search (`fltSearch`) — operator types SO id / customer.
  //      Haystack match across all POs in the system.
  //   2. Grid-scoped rows (`gridFilteredDeptRows`) — operator narrowed
  //      the Foam sheet via column filters / in-grid search. Use the
  //      visible rows' SO ids as scope so sibling POs (Divan-only,
  //      sofa components on other dept paths) still come through.
  const loadFoamPackingStickers = useCallback(async (): Promise<FgSticker[]> => {
    const q = (fltSearch || "").trim().toLowerCase();
    // Mirror Show QR: the natural scope is whatever the Foam grid is
    // currently SHOWING (its column filters / in-grid search applied),
    // falling back to all rows before the DataGrid has reported. No row-
    // ticking and no ≤10-SO cap required — filter the sheet, then print
    // exactly what's visible (Wei Siang 2026-06-02: "像 Show QR 那样跟
    // filter 一样的").
    const visibleRows =
      (gridFilteredDeptRows as unknown as DeptRow[] | null) ?? deptRows;
    // Scope source 0 (optional override): ticked job-card rows. If the
    // operator has ticked specific rows, pack exactly those SOs instead of
    // the whole visible set.
    // BUG-2026-06-08: the ticked-rows scope matched the WRONG id. The ticked
    // rows carry `soId` = the human number (SOFA → companySOId "SO-2605-225";
    // BF → poNo "…-01"), but the filter below compared it against o.salesOrderId
    // (an internal DB id) → never matched → ticking rows then printing produced
    // 0 stickers for sofas AND bedframes. Fix: keep soId here and compare it
    // against the matching human fields (poNo / companySOId / companyCOId) in
    // the scope filter. Matching companySOId pulls all of a sofa's sibling lines
    // (every compartment) — exactly what packing the whole sofa needs. The
    // default filter + Show/Print path (scoped by poId) was unaffected.
    const selSoIds = new Set(
      selectedDeptRows.map((r) => r.soId).filter(Boolean),
    );
    const hasSelectionScope = selSoIds.size > 0;
    const hasGridScope = visibleRows.length > 0;
    if (!q && !hasSelectionScope && !hasGridScope) {
      toast.info("No Foam rows are visible to pack. Type an SO in the top Search box or adjust the filter.");
      return [];
    }
    setLoadingFoamPrint(true);
    try {
      // Scoped fetch (2026-06-24 perf): pull only what the active scope needs,
      // not the whole org. Ticked rows → their SO/CO/po identifiers (a sofa's
      // companySOId pulls all its compartments); visible grid → the visible po
      // ids. The free-text Search path matches any field, so it can't be
      // pre-scoped — it keeps the full fetch.
      const FETCH_BASE =
        "/api/production-orders?fields=minimal&include=jobCards";
      let scopeTokens: string[] = [];
      if (hasSelectionScope) scopeTokens = Array.from(selSoIds);
      else if (!q && hasGridScope)
        scopeTokens = visibleRows.map((r) => r.poId || "").filter(Boolean);
      const url =
        scopeTokens.length > 0
          ? `${FETCH_BASE}&scope=${encodeURIComponent(scopeTokens.join(","))}`
          : FETCH_BASE;
      const res = await fetch(url, { credentials: "include" });
      const json = (await res.json().catch(() => null)) as
        | { success?: boolean; data?: ProductionOrder[] }
        | null;
      let all: ProductionOrder[] = json?.success && Array.isArray(json.data) ? json.data : [];
      // Safety net: a scoped fetch that returned nothing falls back to the full
      // fetch so packing is never silently short.
      if (all.length === 0 && url !== FETCH_BASE) {
        const r2 = await fetch(FETCH_BASE, { credentials: "include" });
        const j2 = (await r2.json().catch(() => null)) as
          | { success?: boolean; data?: ProductionOrder[] }
          | null;
        all = j2?.success && Array.isArray(j2.data) ? j2.data : [];
      }
      if (all.length === 0) {
        toast.warning("Could not load production orders.");
        return [];
      }
      let scoped: ProductionOrder[];
      if (hasSelectionScope) {
        scoped = all.filter(
          (o) =>
            selSoIds.has(o.poNo) ||
            selSoIds.has(o.companySOId || "") ||
            selSoIds.has(o.companyCOId || ""),
        );
      } else if (q) {
        scoped = all.filter((o) => {
          const hay = [
            o.poNo, o.companySOId, o.customerPOId, o.customerReference,
            o.customerName, o.productCode, o.productName, o.fabricCode,
            o.sizeLabel,
          ].map((v) => (v || "").toLowerCase()).join(" ");
          return hay.includes(q);
        });
      } else {
        // Scope to the EXACT visible production lines, by per-line po id —
        // NOT salesOrderId. The parent SO id is shared by sibling lines
        // (-01/-02/-03), so scoping by it leaked every sibling's stickers in
        // even when the grid was filtered to one line (9 stickers instead of
        // 3). poId matches the grid's per-line filter granularity. 2026-06-06.
        const poIds = new Set(
          visibleRows.map((r) => r.poId || "").filter(Boolean),
        );
        scoped = all.filter((o) => poIds.has(o.id));
      }
      if (scoped.length === 0) {
        toast.warning(
          hasSelectionScope
            ? "Could not match the ticked rows to any production orders."
            : q
              ? `No production orders matched "${fltSearch}".`
              : "Could not match the visible Foam rows to any production orders.",
        );
        return [];
      }
      const built = await fetchFgStickersForOrders(scoped);
      if (built.length === 0) {
        toast.warning("No FG units to print for the matched orders.");
        return [];
      }
      // Same public packing-rack token enrichment as the PACKING tab loader so
      // a Foam-stage pre-print also carries the /p/<token> deep link.
      const stickers = await enrichWithPackingTokens(built);
      setFoamPrintStickers(stickers);
      return stickers;
    } catch (err) {
      console.error("[loadFoamPackingStickers] failed", err);
      toast.error("Failed to generate Packing stickers.");
      return [];
    } finally {
      setLoadingFoamPrint(false);
    }
  }, [fltSearch, toast, fetchFgStickersForOrders, enrichWithPackingTokens, gridFilteredDeptRows, deptRows, selectedDeptRows]);

  // Preview toggle — loads (fresh, so a changed grid filter is honoured)
  // and reveals the on-screen tile strip under the QR Stickers panel.
  const handleShowFoamPackingPreview = useCallback(async () => {
    if (showFoamPackingPreview) {
      // Already showing — just hide. Keep loaded stickers around so a
      // subsequent Show without changing filter is instant.
      setShowFoamPackingPreview(false);
      return;
    }
    const stickers = await loadFoamPackingStickers();
    if (stickers.length === 0) return;
    setShowFoamPackingPreview(true);
  }, [showFoamPackingPreview, loadFoamPackingStickers]);

  // Print — if preview already loaded the stickers, print those directly
  // (operator can WYSIWYG check before printing). Otherwise load + print.
  const handlePrintFoamPackingStickers = useCallback(async () => {
    if (foamPrintStickers.length > 0) {
      setFoamPrintRequested(true);
      return;
    }
    const stickers = await loadFoamPackingStickers();
    if (stickers.length === 0) return;
    setFoamPrintRequested(true);
  }, [foamPrintStickers, loadFoamPackingStickers]);

  // Filter scope changed → invalidate any preview/print payload so the next
  // Show / Print fetches fresh. Key on a STABLE signature of the filtered
  // scope (the sorted set of po ids), NOT the gridFilteredDeptRows array
  // reference — that reference churns on every 20s poll / serve-stale
  // revalidate even when the filtered set is unchanged, which used to
  // auto-close a just-opened preview a beat after it rendered. 2026-06-06.
  const foamScopeKey = useMemo(
    () =>
      ((gridFilteredDeptRows as unknown as DeptRow[] | null) ?? [])
        .map((r) => r.poId)
        .sort()
        .join(","),
    [gridFilteredDeptRows],
  );
  /* eslint-disable react-hooks/set-state-in-effect -- intentional cache invalidation on filter change */
  useEffect(() => {
    setFoamPrintStickers([]);
    setShowFoamPackingPreview(false);
  }, [fltSearch, foamScopeKey]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Leaving the Fab Cut tab → collapse the Fab Sew strip and DROP the loaded
  // stickers, so re-entering Fab Cut is cheap again (no FAB_SEW fetch until
  // the operator clicks Show / Print). loadFabSewStickers gates on
  // activeTab === "FAB_CUT", so this just resets the UI + cached data.
  /* eslint-disable react-hooks/set-state-in-effect -- collapse Fab Sew strip on tab leave */
  useEffect(() => {
    if (activeTab !== "FAB_CUT") {
      setShowFabSewStrip(false);
      setFabSewStickers([]);
    }
  }, [activeTab]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Fab Cut filter scope changed → invalidate any loaded Fab Sew preview so
  // the next Show / Print fetches fresh against the new visible orders. Key on
  // the STABLE foamScopeKey (sorted po-id signature), NOT the raw
  // gridFilteredDeptRows reference — that reference churns on every 20s poll /
  // serve-stale revalidate even when the filtered set is unchanged, which used
  // to auto-close a just-opened Fab Sew QR strip a beat after it rendered (the
  // same bug as the Foam packing preview above). 2026-06-06.
  /* eslint-disable react-hooks/set-state-in-effect -- intentional cache invalidation on filter change */
  useEffect(() => {
    setFabSewStickers([]);
    setShowFabSewStrip(false);
  }, [foamScopeKey]);
  /* eslint-enable react-hooks/set-state-in-effect */

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

  // Foam-tab print timer — mirror of the PACKING-tab timer above. Same
  // 1500ms QR-settle delay; clears `foamPrintStickers` after the dialog
  // closes (the foam state is single-use per click, unlike `fgStickers`
  // which keeps the PACKING preview tiles alive between prints).
  useTimeout(
    () => {
      if (foamPrintStickers.length === 0) {
        setFoamPrintRequested(false);
        return;
      }
      window.print();
      // eslint-disable-next-line no-restricted-syntax -- one-shot post-print cleanup, fires from print callback
      setTimeout(() => {
        setFoamPrintRequested(false);
        setFoamPrintStickers([]);
      }, 500);
    },
    foamPrintRequested ? 1500 : null,
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
    const ok = await confirm({
      title: "Sync Job Cards from BOM?",
      message:
        "This scans every production order and inserts any job cards that the current BOM expects but the PO is missing. " +
        "Existing job cards (dueDate, status, PIC) are NOT modified.\n\n" +
        "Proceed?",
    });
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
  }, [toast, confirm]);

  // Prefetch the ORG-WIDE print preset into the localStorage print cache for
  // the active dept grid, so handlePrintSchedule (which reads localStorage
  // synchronously below) honours the shared "Save as Production Schedule"
  // layout across browsers — even on a cold first Print click before the
  // DataGrid's own mount-effect has mirrored it. Read-only GET, best-effort:
  // any failure is swallowed and the existing localStorage fallback stands.
  useEffect(() => {
    if (activeTab === "ALL" || typeof window === "undefined") return;
    const gridId = `production-dept-${String(activeTab).toLowerCase()}`;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/datagrid-layouts?gridId=${encodeURIComponent(gridId)}`,
          { credentials: "include", headers: { Accept: "application/json" } },
        );
        if (!res.ok) return;
        const json = (await res.json()) as {
          print?: { visibleCols?: string[]; colOrder?: string[] } | null;
        };
        if (cancelled || !json?.print) return;
        if (Array.isArray(json.print.visibleCols)) {
          localStorage.setItem(`datagrid-cols-${gridId}-print`, JSON.stringify(json.print.visibleCols));
        }
        if (Array.isArray(json.print.colOrder)) {
          localStorage.setItem(`datagrid-colorder-${gridId}-print`, JSON.stringify(json.print.colOrder));
        }
      } catch { /* ignore — print falls back to local cache / on-screen view */ }
    })();
    return () => { cancelled = true; };
  }, [activeTab]);

  const handlePrintSchedule = useCallback((markDecision: boolean | null = null) => {
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
          // FAB_CUT total is already per-SET (wipQty = piece count) — don't re-×.
          totalProdMinutes += jcMinutesTotal(perUnit, jc);
        }
      }
      const rowsHtml = visibleOrders.map((o) => {
        const cells = DEPARTMENTS.map((d) => {
          // Full order list for the FAB_CUT sibling-walk (same fix as the
          // on-screen Overview render — a filter must not blank borrowed cuts).
          const c = cellFor(o, d.code, orders);
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
          <td>${fmt(o.customerDeliveryDate || "")}</td>
          <td>${fmt(o.hookkaExpectedDD || "")}</td>
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
              <th>Cust DD</th>
              <th>Our DD</th>
              ${DEPARTMENTS.map((d) => `<th class="m">${d.name}</th>`).join("")}
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>`;
      // 6 fixed columns (SO ID, Product, Customer, Qty, Cust DD, Our DD) + 8 dept matrix columns.
      columnCount = 6 + DEPARTMENTS.length;
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
      // Mark-as-Sent at print time (dept sub-tab only). Printing the
      // schedule IS the act of handing it to the floor, so offer a one-click
      // "tick every Sent box" instead of the operator clicking each row.
      // Operates on EXACTLY the printRows set above (respects page-level +
      // grid filters and the per-row due filter). Skips rows already Sent so
      // we don't re-stamp distributedAt. Writes via the SAME per-JC patch the
      // Sent checkbox uses (patchJobCardRef.current → distributedAt), which
      // coalesces through the drafts buffer into one bulk-patch call; we then
      // flush immediately (saveAllNow) instead of waiting out the debounce.
      // Mark-as-Sent gate. On the first (operator) click markDecision is null:
      // we hand off to the system-styled dialog, which re-invokes this handler
      // with the decision from its OWN button-click gesture (so the window.open
      // print popup below is not pop-up-blocked). markDecision === true marks
      // every unsent row before printing; false prints only. We do NOT await the
      // save before printing — the optimistic state already ticks the checkboxes
      // and the printout is built from in-memory rows.
      const unsentPrintRows = printRows.filter((r) => !r.distributedAt && r.jobCardId);
      if (unsentPrintRows.length > 0) {
        if (markDecision === null) {
          setPrintSentPrompt({ count: unsentPrintRows.length, which: "schedule" });
          return;
        }
        if (markDecision === true) {
          const now = new Date().toISOString();
          for (const r of unsentPrintRows) {
            patchJobCardRef.current(r.poId, r.jobCardId, { distributedAt: now });
          }
          // Flush the staged distributedAt writes now rather than waiting for
          // the 2s debounce, so the "Sent" state persists right after print.
          saveAllNow();
          toast.success(`Marked ${unsentPrintRows.length} item(s) as Sent`);
        }
      }
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
      // "Save as Production Schedule" print preset wins (Wei Siang #25) — a
      // curated print layout independent of the on-screen view; then the user's
      // personal layout, then the org default.
      const visibleSetRaw =
        readJson(`datagrid-cols-${gridId}-print`) ??
        readJson(`datagrid-cols-${gridId}-${userEmailLc}`) ??
        readJson(`datagrid-cols-${gridId}-org-default`);
      const visibleSet = Array.isArray(visibleSetRaw)
        ? new Set<string>(visibleSetRaw as string[])
        : new Set<string>(deptColumns.filter((c) => !c.hidden && !c.defaultHidden).map((c) => c.key));
      const orderRaw =
        readJson(`datagrid-colorder-${gridId}-print`) ??
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
      // Pre-render one QR per WIP row ONLY when the "Barcode" column is visible
      // (toggled in the Columns menu like any other column). Scanning it on the
      // phone marks that WIP complete — the same scan as the sticker QR for the
      // no-sticker depts. Off by default; when hidden the schedule is
      // byte-identical to before this feature.
      const showScan = orderedColumns.some((c) => c.key === "scanCode");
      const barcodeByJc = new Map<string, string>();
      if (showScan) {
        for (const r of printRows) {
          if (r.jobCardId && !barcodeByJc.has(r.jobCardId)) {
            // Encode the SHORT 10-digit barcode token (<deptNN><8hash>) as a 1D
            // Code 128 barcode. The scanner resolves it by re-deriving across the
            // dept's cards (dept = the 2 digits) — works for new AND old cards
            // alike, no id migration. (Owner 2026-06-25: the floor scans the
            // schedule with a barcode GUN, so 1D Code 128, not a QR.)
            const token = deriveBarcodeToken(r.jobCardId, activeTab);
            barcodeByJc.set(r.jobCardId, jobCardBarcodeDataUrl(token));
          }
        }
      }
      const renderCell = (col: Column<DeptRow>, r: DeptRow): string => {
        const key = col.key;
        // "Barcode" column: the 1D Code 128 barcode (image) + the human WIP name below it.
        if (key === "scanCode") {
          const bc = (r.jobCardId && barcodeByJc.get(r.jobCardId)) || "";
          if (!bc) return "";
          // Caption = the human WIP name (token-stripped), NOT the cryptic id —
          // the worker reads it to confirm the code matches the piece in hand.
          // Any stray __SIZE__/__MODEL__ template token is stripped defensively;
          // the scannable token lives in the QR + the img alt.
          const wipRaw = String(
            (r as unknown as Record<string, unknown>).wip ?? "",
          );
          const cap =
            wipRaw
              .replace(/__[A-Z0-9_]+__/g, "")
              .replace(/\s{2,}/g, " ")
              .trim() || (r.jobCardId || "");
          return `<img src="${bc}" alt="${escapeHtml(r.jobCardId || "")}" /><span class="bccode">${escapeHtml(cap)}</span>`;
        }
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
        if (col.key === "scanCode") return "bc";
        if (col.align === "right" || col.type === "number") return "num";
        if (col.key === "soId") return "so";
        return "";
      };
      const headerCellsHtml = orderedColumns
        .map((c) => `<th${cellClassFor(c) ? ` class="${cellClassFor(c)}"` : ""}>${escapeHtml(c.label)}</th>`)
        .join("");
      const rowsHtml = printRows
        .map((r) => {
          const cells = orderedColumns
            .map((c) => {
              const cls = cellClassFor(c);
              return `<td${cls ? ` class="${cls}"` : ""}>${renderCell(c, r)}</td>`;
            })
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("");
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
    /* "Barcode" column — one QR per WIP row of the 10-digit token. A QR is a
       SQUARE 2D code (vs the old wide 1D Code 128), so it prints small + dense:
       ~12mm square fits far more per A4-landscape row, and a phone reads a v1 QR
       far more reliably than thin bars. Sized by WIDTH with height:auto so the
       square is never distorted. Column ~16mm wide (was 276px / ~73mm). */
    table.schedule td.bc, table.schedule th.bc { text-align: center; width: 124px; }
    table.schedule td.bc img { width: 116px; height: auto; display: block; margin: 0 auto; }
    /* The human WIP name printed below the QR so the worker can confirm the
       code matches the piece. Wraps on word breaks (it's a readable name). */
    table.schedule td.bc .bccode { display: block; font-family: Arial, sans-serif; font-size: 9px; line-height: 1.1; color: #000; margin-top: 1px; word-break: normal; overflow-wrap: anywhere; }
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
    saveAllNow, toast,
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
  const handlePrintTotalListing = useCallback((markDecision: boolean | null = null) => {
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
          // FAB_CUT total is already per-SET (wipQty = piece count) — don't re-×.
          totalProdMinutes += jcMinutesTotal(perUnit, jc);
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
      // Mark-as-Sent at print time (dept sub-tab only) — same intent as
      // handlePrintSchedule: printing the Total Listing also hands the work
      // to the floor. Marks EXACTLY this printRows source set (the unmerged
      // dept job cards behind the merged WIP buckets), skipping rows already
      // Sent, via the same per-JC distributedAt patch the Sent checkbox uses.
      // markDecision === null → hand off to the styled dialog (which re-invokes
      // this handler with the decision from its own button gesture). See the
      // identical gate in handlePrintSchedule for the pop-up-blocker rationale.
      const unsentPrintRows = printRows.filter((r) => !r.distributedAt && r.jobCardId);
      if (unsentPrintRows.length > 0) {
        if (markDecision === null) {
          setPrintSentPrompt({ count: unsentPrintRows.length, which: "total" });
          return;
        }
        if (markDecision === true) {
          const now = new Date().toISOString();
          for (const r of unsentPrintRows) {
            patchJobCardRef.current(r.poId, r.jobCardId, { distributedAt: now });
          }
          saveAllNow();
          toast.success(`Marked ${unsentPrintRows.length} item(s) as Sent`);
        }
      }
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
        // "Total Qty" on this merged WIP cutting-schedule print means
        // total PIECES to cut for the WIP, so sum piecesToCut (panel
        // count), NOT qty (order quantity, always 1). See
        // BUG-2026-06-01-001 — qty used to carry the piece count.
        b.qty += r.piecesToCut || 0;
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
    saveAllNow, toast,
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
      {(unsavedCount > 0 || savingNow || retryPending) && (
        <div className={`sticky top-0 z-40 -mx-4 px-4 py-2 border-y flex items-center justify-between gap-3 shadow-sm ${retryPending && !savingNow ? "bg-red-100 border-red-300" : "bg-amber-100 border-amber-300"}`}>
          <div className="flex items-center gap-2 text-sm">
            {savingNow ? (
              <>
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-amber-700 border-t-transparent" />
                <span className="font-medium text-amber-900">Saving {unsavedCount > 0 ? unsavedCount : ""}…</span>
              </>
            ) : retryPending ? (
              <>
                <span className="text-red-700">⚠</span>
                <span className="font-medium text-red-900">
                  Network slow — retrying {unsavedCount} change{unsavedCount === 1 ? "" : "s"} automatically…
                </span>
                <span className="text-red-700 text-xs">· your edits are kept</span>
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
            <Button size="sm" onClick={saveAllNow} className={retryPending ? "bg-red-700 hover:bg-red-800 text-white" : "bg-amber-700 hover:bg-amber-800 text-white"}>
              {retryPending ? "Retry now" : "Save All Now"}
            </Button>
          )}
        </div>
      )}
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Production Tracking</h1>
          <p className="text-xs text-[#6B7280]">Real-time production status across all 8 departments</p>
        </div>
        <div className="flex flex-wrap gap-2">
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
          {/* The "Barcode" column (a scannable QR on the printout) is toggled in
              the grid's Columns menu (default hidden) like any other column — no
              separate checkbox (Wei Siang 2026-06-15: "应该做在 column 那边"). */}
          <Button
            variant="outline"
            onClick={() =>
              printMode === "total"
                ? handlePrintTotalListing()
                : handlePrintSchedule()
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
          {/* Foam Bonding packing-stickers entry point was MOVED out of
              this header on 2026-05-24 per Wei Siang: he wanted the
              Show / Print pair to live inside the QR Stickers panel
              below (alongside Show QR / Print All) so the buttons sit
              right next to the production-sheet grid that scopes them.
              See the QR Stickers section render around line 6064. */}
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
        {/* Per-category overdue chips — date-filter-INDEPENDENT. Units DIFFER
            by category (owner rule 2026-06-12): Bedframe counts overdue
            PIECES (sold per SKU), Sofa counts overdue SETS (= distinct SOs,
            since one set's -01/-02/-03 pieces share an SO). Both exclude any
            piece already on a dispatched/delivered DO. Counts come from
            /api/production-orders/overdue-counts (server-side), not the
            date-windowed `filteredOrders`. Owner request 2026-06-23: clicking
            a chip FILTERS THE GRID BELOW to exactly that category's overdue
            set (reusing the same server overdue ids the count comes from),
            INSTEAD of popping a separate SO list. Click again to clear; click
            the other chip to switch. Greyed out at zero so "all clear" reads
            explicit. */}
        <button
          type="button"
          onClick={() => selectOverdueChip("BEDFRAME")}
          className={`text-xs px-2 py-1.5 rounded border transition font-semibold ${
            bedframeOverdueCount > 0
              ? overduePanelMode === "BEDFRAME"
                ? "bg-[#D9534F] text-white border-[#D9534F]"
                : "bg-[#FDECEA] text-[#A12C28] border-[#F1B5B0] hover:bg-[#F8D7D4]"
              : "bg-white text-[#9CA3AF] border-[#E6E0D9] cursor-default"
          }`}
          disabled={bedframeOverdueCount === 0}
          aria-pressed={overduePanelMode === "BEDFRAME"}
          title={
            bedframeOverdueCount > 0
              ? overduePanelMode === "BEDFRAME"
                ? "Showing the overdue Bedframe pieces in the grid below. Click to clear this filter."
                : `${bedframeOverdueCount} overdue Bedframe piece${bedframeOverdueCount === 1 ? "" : "s"} (counted by piece; independent of date filter). Click to filter the grid below to these.`
              : "No overdue Bedframe pieces system-wide"
          }
        >
          Bedframe ⚠ {bedframeOverdueCount}
        </button>
        <button
          type="button"
          onClick={() => selectOverdueChip("SOFA")}
          className={`text-xs px-2 py-1.5 rounded border transition font-semibold ${
            sofaOverdueCount > 0
              ? overduePanelMode === "SOFA"
                ? "bg-[#D9534F] text-white border-[#D9534F]"
                : "bg-[#FDECEA] text-[#A12C28] border-[#F1B5B0] hover:bg-[#F8D7D4]"
              : "bg-white text-[#9CA3AF] border-[#E6E0D9] cursor-default"
          }`}
          disabled={sofaOverdueCount === 0}
          aria-pressed={overduePanelMode === "SOFA"}
          title={
            sofaOverdueCount > 0
              ? overduePanelMode === "SOFA"
                ? "Showing the overdue Sofa pieces in the grid below. Click to clear this filter."
                : `${sofaOverdueCount} overdue Sofa set${sofaOverdueCount === 1 ? "" : "s"} (counted by set = SO; independent of date filter). Click to filter the grid below to the overdue sofa pieces.`
              : "No overdue Sofa sets system-wide"
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
          {!shouldFetch ? (
            "Pick a filter (or Load all) to fetch orders"
          ) : updatingHint ? (
            <span className="text-[#9C6F1E] font-semibold">Updating…</span>
          ) : ordersObserved ? (
            `${filteredOrders.length} of ${orders.length} orders`
          ) : (
            // BUG-2026-08-13-146 — a dead read printed "0 of 0 orders" here.
            <span title={ordersUnobservedReason ?? undefined}>
              — orders ({ordersUnobservedReason})
            </span>
          )}
        </span>
      </div>

      {/* Active overdue-filter banner. Owner request 2026-06-23: clicking an
          overdue chip now FILTERS THE GRID BELOW (instead of popping a separate
          SO list). This thin banner just confirms the active filter + restates
          the chip's metric, and offers a one-click clear. The actual rows are
          the grid below, narrowed via `overduePoIdSet` in `filteredOrders`. */}
      {overduePanelMode && shouldFetch && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-[#F1B5B0] bg-[#FFF7F6] px-3 py-2">
          <span className="text-xs text-[#A12C28]">
            <span className="font-semibold">
              {overduePanelMode === "BEDFRAME" ? "Bedframe" : "Sofa"} overdue filter on
            </span>{" "}
            {overdueIdsLoading ? (
              // Self-heal window (BUG-2026-06-23): the overdue id list hasn't
              // loaded yet (stale-shape cache being refetched, or first cold
              // fetch in flight). Don't promise N filtered rows the grid isn't
              // narrowed to — say we're loading the list. Refreshes by itself.
              <>— loading the overdue list…</>
            ) : (
              <>
                — grid below shows{" "}
                {overduePanelMode === "BEDFRAME"
                  ? `the ${bedframeOverdueCount} overdue Bedframe piece${bedframeOverdueCount === 1 ? "" : "s"}`
                  : `the overdue Sofa pieces making up ${sofaOverdueCount} set${sofaOverdueCount === 1 ? "" : "s"}`}
                {" "}(independent of the date range).
              </>
            )}
          </span>
          <button
            type="button"
            onClick={() => setOverduePanelMode(null)}
            className="shrink-0 text-[11px] font-medium text-[#A12C28] hover:underline"
          >
            Clear overdue filter
          </button>
        </div>
      )}

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
      <div ref={gridSectionRef} className="rounded-lg border border-[#E6E0D9] bg-[#FAF8F4] p-1 overflow-x-auto scroll-mt-4">
        <div className="grid grid-cols-9 gap-1">
          <button
            onClick={() => startTransition(() => setActiveTab("ALL"))}
            className={`px-3 py-2 rounded text-xs font-semibold transition ${
              activeTab === "ALL"
                ? "bg-white text-[#1F1D1B] shadow-sm border border-[#E6E0D9]"
                : "text-[#6B7280] hover:text-[#1F1D1B]"
            }`}
          >
            {/* Same unsourceable-zero as the matrix footer below
                (BUG-2026-08-13-146): on a cold landing no request has been
                made, so this fraction has no source. */}
            Overview{" "}
            <span className="opacity-60 font-normal" title={ordersUnobservedReason ?? undefined}>
              {ordersObserved ? `${overallDone}/${overallTotal}` : "—"}
            </span>
          </button>
          {deptFractions.map((d) => (
            <button
              key={d.code}
              onClick={() => startTransition(() => setActiveTab(d.code))}
              className={`px-2 py-2 rounded text-[11px] font-semibold uppercase tracking-wide transition truncate ${
                activeTab === d.code
                  ? "bg-white text-[#1F1D1B] shadow-sm border border-[#6B5C32]"
                  : "text-[#8A7F73] hover:text-[#1F1D1B]"
              }`}
            >
              {d.name}{" "}
              <span
                className="opacity-60 font-normal normal-case"
                title={ordersUnobservedReason ?? undefined}
              >
                {ordersObserved ? `${d.done}/${d.total}` : "—"}
              </span>
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
            // "Save as Production Schedule" in the Columns popover → snapshots
            // the current columns into a print preset the schedule printout uses
            // (independent of the on-screen view). Wei Siang #25.
            printPresetLabel="Production Schedule"
            // Roll out the newly-added Customer SO column to existing users
            // whose saved column layout predates it (one-time per user/grid).
            ensureColumns={["customerSO"]}
            // Rendering is handled by `virtualize` (windowed — only the
            // on-screen rows are painted), so the dept sheet needs no
            // defaultRowCap. Removed 2026-05-22 to unify every grid on the
            // one virtualize path (no "Showing 500 of N" footer).
            onFilteredDataChange={setGridFilteredDeptRows}
            // Batch-action multi-select. Adds the checkbox column on the
            // left + populates `selectedDeptRows` for the toolbar below.
            selectable
            onSelectionChange={(rows: DeptRow[]) =>
              setSelectedDeptRows(
                rows.map((r) => ({
                  id: r.id,
                  poId: r.poId,
                  jobCardId: r.jobCardId,
                  prodTime: Number(r.prodTime) || 0,
                  // SO this row belongs to — lets the Foam packing-sticker
                  // buttons scope to the ticked rows (Wei Siang 2026-06-02).
                  // MUST be the HUMAN doc number (DeptRow.soId = companySOId
                  // for SOFA, line-suffixed poNo for BF/ACC), NOT the internal
                  // salesOrderId/consignmentOrderId primary key: the Foam
                  // packing matcher in loadFoamPackingStickers compares this
                  // set against o.poNo / o.companySOId / o.companyCOId (all
                  // human numbers). Storing the UUID primary key here made
                  // every comparison miss → "Could not match the ticked rows
                  // to any production orders" even though the header counted
                  // the SOs correctly (UUIDs are still distinct per SO).
                  // Regression of the BUG-2026-06-08 fix; re-fixed 2026-06-22.
                  soId: r.soId || "",
                })),
              )
            }
            // Hide already-completed / transferred dept cards by default
            // so the operator opens the page and immediately sees only
            // the live work in front of them. They can re-tick
            // COMPLETED / TRANSFERRED in the Status filter to see
            // history. Mirrors the operator's request: fewer rows
            // means faster page open and a more focused live view.
            defaultExcludedValues={deptDefaultExcluded}
            // BUG-2026-06-23-004: rows the operator just batch-flipped to
            // COMPLETED stay visible (exempt from the hide-COMPLETED Status
            // filter) for the session. Changing this Set does NOT remount the
            // grid, so the checkbox selection + batch toolbar + chaining survive.
            // deptForceShowKeys also folds in EVERY current deptRows id while a
            // top-bar search is active (2026-06-23 dept-tab search fix) — those
            // rows are already the search matches (deptRows is pre-search-
            // filtered upstream), so this surfaces a searched COMPLETED /
            // TRANSFERRED order that the seeded hide would otherwise drop, while
            // a non-matching search reveals nothing (empty deptRows).
            forceShowKeys={deptForceShowKeys}
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
            prodTimeTotalMin={selectedDeptRows.reduce((s, r) => s + (Number(r.prodTime) || 0), 0)}
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
          // BUG-2026-06-23-004: capture the DeptRow composite ids of the rows
          // being completed so we can force-show them after the optimistic
          // write (see setForceShowCompletedIds below). Snapshotted here, up
          // front, independent of the selection which is intentionally kept.
          const completedRowIds = date ? selectedDeptRows.map((r) => r.id) : [];
          const clearedRowIds = date ? [] : selectedDeptRows.map((r) => r.id);
          try {
            const res = await fetch("/api/production-orders/bulk-patch", {
              method: "POST",
              headers: csrfHeaders(),
              body: JSON.stringify({ patches }),
              credentials: "include",
            });
            const j = (await res.json()) as { success?: boolean; results?: Array<{ success: boolean; error?: string }>; error?: string; missingPermission?: string };
            if (!res.ok) {
              toast.error(
                j.missingPermission
                  ? "Save failed — you don't have permission to make this change. Nothing was saved."
                  : `Save failed — ${j.error ?? `error ${res.status}`}. Nothing was saved.`,
              );
              return;
            }
            const failed = (j.results || []).filter((x) => !x.success);
            if (failed.length > 0) {
              toast.error(`${failed.length} of ${patches.length} failed: ${failed[0].error ?? "unknown"}`);
            } else if (date) {
              // BUG-2026-06-23-004: these rows just flipped to COMPLETED and
              // would normally vanish under the default hide-COMPLETED filter.
              // The toast tells the operator they're saved AND kept on screen.
              toast.success(`Marked ${patches.length} job card${patches.length === 1 ? "" : "s"} Completed — saved & kept visible (they hide on next reload; also in the Folder).`);
            } else {
              toast.success(`Cleared completion date on ${patches.length} job card${patches.length === 1 ? "" : "s"}.`);
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
            // BUG-2026-06-23-004 force-show: keep the just-completed rows on
            // screen (exempt from the default hide-COMPLETED Status filter)
            // for the rest of the session. Updating this Set does NOT remount
            // the grid (it's NOT part of the grid `key`), so the checkbox
            // selection + batch toolbar + chaining all survive. Rows that were
            // un-completed (date cleared → WAITING) are dropped from the set —
            // WAITING isn't hidden, so they don't need the exemption.
            if (completedRowIds.length > 0 || clearedRowIds.length > 0) {
              setForceShowCompletedIds((prev) => {
                const next = new Set(prev);
                for (const id of completedRowIds) next.add(id);
                for (const id of clearedRowIds) next.delete(id);
                // Reference is unchanged only when nothing actually moved.
                return next.size === prev.size &&
                  completedRowIds.every((id) => prev.has(id)) &&
                  clearedRowIds.every((id) => !prev.has(id))
                  ? prev
                  : next;
              });
            }
            invalidateCachePrefix("/api/production-orders");
            // Read each touched PO fresh (?fresh=1) so the stamped/cleared
            // completion sticks over the serve-stale list snapshot + pins it.
            void mergeFreshPOs(
              patches.map((p) => ({ poId: p.poId, jcIds: [p.jobCardId] })),
            );
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
            const j = (await res.json()) as { success?: boolean; results?: Array<{ success: boolean; error?: string }>; error?: string; missingPermission?: string };
            if (!res.ok) {
              toast.error(
                j.missingPermission
                  ? "Save failed — you don't have permission to make this change. Nothing was saved."
                  : `Save failed — ${j.error ?? `error ${res.status}`}. Nothing was saved.`,
              );
              return;
            }
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
            const j = (await res.json()) as { success?: boolean; results?: Array<{ success: boolean; error?: string }>; error?: string; missingPermission?: string };
            if (!res.ok) {
              toast.error(
                j.missingPermission
                  ? "Save failed — you don't have permission to make this change. Nothing was saved."
                  : `Save failed — ${j.error ?? `error ${res.status}`}. Nothing was saved.`,
              );
              return;
            }
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
            // Read each touched PO fresh (?fresh=1) so the applied/cleared PIC
            // sticks over the serve-stale list snapshot + pins it. `patches`
            // here is Record<string, unknown> (PIC slots are conditionally
            // added), so coerce the id fields — they originate from
            // selectedDeptRows (always strings).
            void mergeFreshPOs(
              patches.map((p) => ({
                poId: String(p.poId),
                jcIds: [String(p.jobCardId)],
              })),
            );
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
        {/* Widen dept columns + scroll the whole matrix left/right as one unit.
            Header and body share minWidth:1684 so they scroll together; the
            column filter popovers are portaled to <body> so this overflow box
            can't clip them. — Wei Siang 2026-05-29 */}
        <OverviewResizeCtx.Provider value={overviewResizeValue}>
        <div className="overflow-x-auto">
        {/* Header row */}
        <div
          className="grid text-[10px] font-semibold uppercase tracking-wider text-[#6B7280] bg-[#FAF8F4] border-b border-[#E6E0D9] relative z-20"
          style={{ gridTemplateColumns: overviewTemplate, minWidth: overviewMinWidth }}
        >
          {/* Select-all checkbox gutter. Scopes to the currently-visible
              (filtered + sorted) rows = visibleOrders. */}
          <div className="flex items-center justify-center px-1.5 py-2.5">
            <input
              type="checkbox"
              aria-label="Select all visible orders"
              checked={allOverviewVisibleSelected}
              ref={(el) => {
                if (el) el.indeterminate = someOverviewVisibleSelected;
              }}
              onChange={toggleOverviewSelectAll}
              disabled={visibleOrders.length === 0}
              className="cursor-pointer align-middle"
            />
          </div>
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
            label="Customer DD"
            align="center"
            sortKey="customerDD"
            sort={overviewSort}
            cycle={cycleOverviewSort}
            filterCol="customerDD"
            filterActive={isFilterActive("customerDD")}
            openFilterCol={openFilterCol}
            setOpenFilterCol={setOpenFilterCol}
            renderFilter={() => (
              <DateRangeFilter
                from={overviewFilters.customerDDFrom}
                to={overviewFilters.customerDDTo}
                onChange={(from, to) => setOverviewFilters((p) => ({ ...p, customerDDFrom: from, customerDDTo: to }))}
              />
            )}
          />
          <OverviewHeader
            label="Our Expected DD"
            align="center"
            sortKey="ourExpectedDD"
            sort={overviewSort}
            cycle={cycleOverviewSort}
            filterCol="ourExpectedDD"
            filterActive={isFilterActive("ourExpectedDD")}
            openFilterCol={openFilterCol}
            setOpenFilterCol={setOpenFilterCol}
            renderFilter={() => (
              <DateRangeFilter
                from={overviewFilters.ourExpectedDDFrom}
                to={overviewFilters.ourExpectedDDTo}
                onChange={(from, to) => setOverviewFilters((p) => ({ ...p, ourExpectedDDFrom: from, ourExpectedDDTo: to }))}
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
          // Same BUG-2026-08-13-146 gate as the footer: "No production orders
          // found." is a statement about the factory, and only an observed 2xx
          // body licenses it. A cold landing, an in-flight fetch and a dead
          // read all produced this sentence too.
          <div className="px-4 py-12 text-center text-sm text-[#9A918A]">
            {ordersObserved
              ? "No production orders found."
              : `Orders not shown — ${ordersUnobservedReason}.`}
          </div>
        ) : (
          <div
            ref={overviewBodyRef}
            // overflow-x-hidden: the body only scrolls VERTICALLY. Horizontal
            // scrolling is owned by the outer wrapper (which keeps header +
            // rows aligned). Without this the body grew its own, unsynced
            // horizontal scrollbar from the vertical scrollbar's gutter —
            // two left/right scrollbars. — Wei Siang 2026-05-29
            className="overflow-y-auto overflow-x-hidden"
            style={{ maxHeight: "calc(100vh - 320px)", minWidth: overviewMinWidth }}
          >
          <div
            style={{
              height: `${overviewRowVirtualizer.getTotalSize()}px`,
              position: "relative",
              width: "100%",
            }}
          >
          {overviewRowVirtualizer
            .getVirtualItems()
            .filter((virtualRow) => virtualRow.index < visibleOrders.length)
            .map((virtualRow) => {
            const order = visibleOrders[virtualRow.index];
            if (!order) return null;
            const isSelected = selectedOverviewIds.has(order.id);
            // Lifecycle row styling — amber background for ON_HOLD, grey +
            // strikethrough for CANCELLED. Matches the dept DataGrid rule.
            // A ticked row gets the same warm highlight the dept sheet / tracker
            // use, overriding the lifecycle tint so the selection reads clearly.
            const rowCls = isSelected
              ? "bg-[#FFF8E6] hover:bg-[#FBEFC9]"
              : order.status === "ON_HOLD"
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
            // ON HOLD reason (0185) — full reason + who + when in the chip
            // tooltip; faint truncated one-liner under the product code.
            const ovHoldReason =
              order.status === "ON_HOLD" ? (order.holdReason || "").trim() : "";
            const ovHoldTooltip = ovHoldReason
              ? `On hold: ${ovHoldReason}${
                  order.heldBy ? ` — ${order.heldBy}` : ""
                }${order.heldAt ? ` (${order.heldAt})` : ""}`
              : "";
            return (
            <div
              key={order.id}
              ref={overviewRowVirtualizer.measureElement}
              data-index={virtualRow.index}
              className={`grid items-stretch border-b border-[#F0EBE3] cursor-pointer ${rowCls}`}
              style={{
                gridTemplateColumns: overviewTemplate,
                minWidth: overviewMinWidth,
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              // Single-click anywhere on the row toggles its selection (the
              // operator asked to tick by clicking the row, not just the small
              // checkbox). Double-click still opens the order.
              onClick={() => toggleOverviewRow(order.id)}
              onDoubleClick={() => {
                if (order.salesOrderId) navigate(`/sales/${order.salesOrderId}`);
                else if (order.consignmentOrderId)
                  navigate(`/consignment/${order.consignmentOrderId}`);
              }}
            >
              {/* Multi-select checkbox gutter. stopPropagation keeps the tick
                  from triggering the row's double-click navigation. */}
              <div
                className="flex items-center justify-center"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  aria-label={`Select order ${order.poNo}`}
                  checked={isSelected}
                  onChange={() => toggleOverviewRow(order.id)}
                  className="cursor-pointer align-middle"
                />
              </div>
              <div className="px-3 py-1.5 text-xs text-[#1F1D1B] flex items-center gap-1.5 tabular-nums">
                <span className="truncate">{order.poNo}</span>
                {pillLabel && (
                  <span
                    className={`text-[9px] font-semibold px-1.5 py-[1px] rounded uppercase tracking-wide no-underline cursor-default ${pillCls}`}
                    title={ovHoldTooltip || undefined}
                  >
                    {pillLabel}
                  </span>
                )}
              </div>
              <div className="px-3 py-1.5 min-w-0 flex flex-col justify-center">
                <div className="text-xs font-semibold text-[#1F1D1B] truncate">{order.productCode}</div>
                <ProductDetailLine order={order} />
                {ovHoldReason && (
                  <div
                    className="text-[10px] italic text-[#9C6F1E]/70 truncate"
                    title={ovHoldTooltip}
                  >
                    On hold: {ovHoldReason}
                  </div>
                )}
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
              {/* Customer DD + Our Expected DD — read-only planning dates (sourced
                  from the SO). Replaced the old editable targetEndDate "Due"
                  column on the Overview (Wei Siang 2026-06-03). */}
              <div className="px-2 py-1.5 text-[11px] text-[#6B7280] flex items-center justify-center tabular-nums">
                {order.customerDeliveryDate ? fmtShortDate(order.customerDeliveryDate) : "—"}
              </div>
              <div className="px-2 py-1.5 text-[11px] text-[#6B7280] flex items-center justify-center tabular-nums">
                {order.hookkaExpectedDD ? fmtShortDate(order.hookkaExpectedDD) : "—"}
              </div>
              {DEPARTMENTS.map((d) => {
                // FAB_CUT sibling-walk (cellFor "Option C") must search the
                // FULL order list, not visibleOrders. A column filter (e.g.
                // FAB SEW = Overdue) can hide the ONE sibling that actually
                // holds the set's fabric-cut JC; with visibleOrders the walk
                // then fails and the borrowed FAB_CUT vanishes from every other
                // piece in the set. Wei Siang 2026-06-05: "no filter → Fab Cut
                // is there; filter → same row's Fab Cut disappears."
                const c = cellFor(order, d.code, orders);
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
        </div>{/* /overflow-x-auto matrix scroll wrapper */}
        </OverviewResizeCtx.Provider>

        {/* Footer */}
        {/* BUG-2026-08-13-146 — see `ordersObserved`. This footer used to
            assert "0 of 0 work orders · 0/0 cells complete" underneath the
            "No orders loaded yet." callout, off a request that was never
            sent. */}
        <div className="px-4 py-2 bg-[#FAF8F4] border-t border-[#E6E0D9] text-[10px] text-[#8A7F73] flex items-center justify-between">
          {ordersObserved ? (
            <>
              <span>{visibleOrders.length} of {orders.length} work orders</span>
              <span>{overallDone}/{overallTotal} cells complete</span>
            </>
          ) : (
            <>
              <span>— work orders</span>
              <span title={ordersUnobservedReason ?? undefined}>
                — cells complete ({ordersUnobservedReason})
              </span>
            </>
          )}
        </div>

        {/* Batch Due Date — multi-select rows, pick a department scope + a
            date, Apply. Reuses the dept sheet's BatchActionToolbar +
            ApplyBatchDueDateDialog + /api/production-orders/bulk-patch endpoint.
            The department scope picker is matrix-specific: each row is a whole
            order spanning up to 8 dept job cards, so the operator chooses which
            department's due date to set (or all). (Wei Siang 2026-06-03) */}
        {/* Batch Due Date bar — ONLY the department scope picker + Apply Due
            Date + Clear (Wei Siang 2026-06-03: the Overview needs just these;
            Completion / PIC / Save-to-Folder live on the dept sheet). */}
        {selectedOverviewOrders.length > 0 && (
          <div className="sticky bottom-3 left-3 right-3 z-30 flex flex-wrap items-center gap-2 rounded-md border border-[#C9A227] bg-[#FFF8E6] px-3 py-2 shadow-md">
            <span className="text-[12px] font-semibold text-[#5A4500]">
              {selectedOverviewOrders.length} selected
            </span>
            <span className="text-[12px] text-[#5A4500]">· Due Date department:</span>
            <select
              value={overviewBatchDept}
              onChange={(e) => setOverviewBatchDept(e.target.value)}
              className="h-8 rounded border border-[#D4CFC7] bg-white px-2 text-[12px] text-[#3A2E22] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
            >
              <option value="ALL">All departments</option>
              {DEPARTMENTS.map((d) => (
                <option key={d.code} value={d.code}>{d.name}</option>
              ))}
            </select>
            {/* Total production time of the selection, scoped to the chosen
                department — workload preview before applying. (Wei Siang 2026-06-03) */}
            <span className="text-[12px] font-semibold text-[#5A4500]">
              · Prod time: {overviewBatchTotalMin.toLocaleString()} min
              <span className="font-normal text-[#7A6A35]"> ({(overviewBatchTotalMin / 60).toFixed(1)} h)</span>
            </span>
            <button
              type="button"
              onClick={() => setOverviewBatchDueDateOpen(true)}
              className="h-8 rounded-md bg-[#6B5C32] px-3 text-[12px] font-semibold text-white hover:bg-[#5A4D2A]"
            >
              Apply Due Date
            </button>
            <button
              type="button"
              onClick={() => setSelectedOverviewIds(new Set())}
              className="h-8 rounded-md border border-[#D4CFC7] bg-white px-3 text-[12px] text-[#5A5550] hover:bg-[#F5F2ED]"
            >
              Clear
            </button>
            <span className="ml-auto text-[11px] text-[#9C7A1E]">
              {overviewBatchDept === "ALL"
                ? "Sets the date on every department job card of the selected orders."
                : `Sets the date on the ${DEPARTMENTS.find((d) => d.code === overviewBatchDept)?.name} job card of the selected orders.`}
            </span>
          </div>
        )}

        <ApplyBatchDueDateDialog
          open={overviewBatchDueDateOpen}
          count={selectedOverviewOrders.length}
          onCancel={() => setOverviewBatchDueDateOpen(false)}
          onApply={applyOverviewBatchDueDate}
        />
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
          <div className="flex gap-2 flex-wrap justify-end">
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
            {/* Foam-only Packing-sticker controls. Scope mirrors Show QR:
                the buttons act on whatever the Foam grid is currently
                SHOWING (its column filters / search applied) — no row-
                ticking and no SO-count cap. Filter the sheet, then Show
                (on-screen WYSIWYG check) or Print (same payload to the
                hidden print container). A top-bar Search or ticked rows
                still work as optional narrower scopes. */}
            {activeTab === "FOAM" && (() => {
              const hasTopSearch = !!fltSearch.trim();
              // Whatever the grid is showing right now, falling back to all
              // rows until the DataGrid reports its filtered set.
              const visibleRows =
                (gridFilteredDeptRows as unknown as DeptRow[] | null) ?? deptRows;
              const distinctSoIds = new Set<string>();
              for (const r of visibleRows) {
                const sid = r.salesOrderId || r.consignmentOrderId;
                if (sid) distinctSoIds.add(sid);
              }
              // Ticked rows are an optional override — pack just those SOs.
              const selSoIds = new Set(
                selectedDeptRows.map((r) => r.soId).filter(Boolean),
              );
              const hasSelectionScope = selSoIds.size > 0;
              const hasVisibleRows = visibleRows.length > 0;
              const scopeOK = hasTopSearch || hasSelectionScope || hasVisibleRows;
              const enabled = scopeOK && !loadingFoamPrint && !foamPrintRequested;
              const tooltipBase = hasSelectionScope
                ? `Packing stickers for the ${selSoIds.size} SO${selSoIds.size === 1 ? "" : "s"} in your ${selectedDeptRows.length} ticked row${selectedDeptRows.length === 1 ? "" : "s"}`
                : hasTopSearch
                  ? `Packing stickers (HB / Divan / Sofa pieces) for every piece of the SO in the Search box`
                  : hasVisibleRows
                    ? `Packing stickers for the ${distinctSoIds.size} SO${distinctSoIds.size === 1 ? "" : "s"} shown in the Foam grid — filter the grid to narrow`
                    : "Filter the Foam grid, tick rows, or type an SO in the top Search box";
              return (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleShowFoamPackingPreview}
                    disabled={!enabled && !showFoamPackingPreview}
                    title={`Preview — ${tooltipBase}`}
                  >
                    {loadingFoamPrint
                      ? "Loading…"
                      : showFoamPackingPreview
                        ? "Hide Packing"
                        : "Show Packing Stickers"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePrintFoamPackingStickers}
                    disabled={!enabled}
                    title={`Print — ${tooltipBase}`}
                  >
                    {loadingFoamPrint || foamPrintRequested
                      ? "Preparing…"
                      : "Print Packing Stickers"}
                  </Button>
                </>
              );
            })()}
            {/* FAB_CUT-only: pull the downstream Fab Sew QR stickers for the
                same orders the Fab Cut grid is showing — so the cutting
                station can also print the next-stage sewing stickers. Mirrors
                the native Show QR / Print All pair (and the Foam → Packing
                split), but acts on the fetched-and-built `fabSewStickers`.
                The native Fab Cut Show QR / Print All buttons above are
                untouched. */}
            {activeTab === "FAB_CUT" && (() => {
              // Count is only meaningful once the stickers have been fetched +
              // built (on click); before that the label just invites the load.
              const count = fabSewStickers.length;
              return (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleShowFabSewStrip}
                    disabled={loadingFabSew}
                    title="Show the downstream Fabric Sewing QR stickers for the orders in the current Fab Cut filter"
                  >
                    {loadingFabSew
                      ? "Loading…"
                      : showFabSewStrip
                        ? "Hide Fab Sew QR"
                        : count > 0
                          ? `Show Fab Sew QR (${count})`
                          : "Show Fab Sew QR"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePrintFabSewStickers}
                    disabled={printingFabSew || loadingFabSew}
                    title="Print the downstream Fabric Sewing QR stickers for the orders in the current Fab Cut filter"
                  >
                    {printingFabSew ? "Generating…" : "Print Fab Sew Stickers"}
                  </Button>
                </>
              );
            })()}
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
                  // Reuse the shared 230×380px large tile so the on-
                  // screen preview is identical to the print page and to
                  // the FAB_CUT Fab Sew strip below.
                  return renderLargeStickerTile(s);
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
        {/* FAB_CUT-only: on-screen preview of the downstream Fab Sew QR
            stickers for the orders the Fab Cut grid is showing. Lives INSIDE
            the QR Stickers panel (alongside the Foam → Packing preview), so
            the operator's mental model stays "this panel = stickers I can pull
            from this dept". Each tile is rendered through the SAME
            renderLargeStickerTile helper the native FAB_CUT / FAB_SEW strip
            uses, so a Fab Sew tile pulled here is pixel-identical to one on
            the Fab Sew tab — and to its 100×150mm print page. Gated on
            showFabSewStrip so it only mounts the <QRImg> tree on intent. */}
        {activeTab === "FAB_CUT" && showFabSewStrip && fabSewStickers.length > 0 && (
          <div className="border-t border-[#F0F0F0]">
            <div className="px-4 py-2 bg-[#FAF8F4] border-b border-[#F0F0F0] text-xs text-[#6B5C32] font-semibold flex items-center justify-between">
              <span>
                Fab Sew Stickers preview · {fabSewStickers.length} sticker
                {fabSewStickers.length === 1 ? "" : "s"}
              </span>
              <span className="text-[#8A7F73] font-normal">
                Same layout, size, content as the Fab Sew dept print
              </span>
            </div>
            <div className="overflow-x-auto">
              <div className="flex gap-3 p-3 min-w-min">
                {fabSewStickers.map((s) => renderLargeStickerTile(s))}
              </div>
            </div>
          </div>
        )}
        {/* FAB_CUT-only: empty-state hint when the operator clicked Show but
            no FAB_SEW job cards exist for the visible Fab Cut orders. */}
        {activeTab === "FAB_CUT" && showFabSewStrip && fabSewStickers.length === 0 && (
          <div className="border-t border-[#F0F0F0] px-4 py-6 text-center text-xs text-[#9A918A]">
            No Fab Sew job cards for the orders in the current Fab Cut filter.
          </div>
        )}
        {/* Foam-only Packing-sticker on-screen preview. Lives INSIDE
            the QR Stickers panel so the operator's mental model stays
            "this panel = stickers from this dept", but the panel header
            counter still shows the dept JC count (not packing count).
            Each tile mirrors the 100×150mm print layout 1:1 at ~50%
            scale so what they see = what prints, including the WIP
            distinction between HB ("…-HB20\"") and Divan ("8\" Divan-SS"). */}
        {activeTab === "FOAM" && showFoamPackingPreview && foamPrintStickers.length > 0 && (
          <div className="border-t border-[#F0F0F0]">
            <div className="px-4 py-2 bg-[#FAF8F4] border-b border-[#F0F0F0] text-xs text-[#6B5C32] font-semibold flex items-center justify-between">
              <span>
                Packing Stickers preview · {foamPrintStickers.filter(s => !s.isSyntheticLegs && !s.isSyntheticPillow).length} sticker
                {foamPrintStickers.filter(s => !s.isSyntheticLegs && !s.isSyntheticPillow).length === 1 ? "" : "s"}
              </span>
              <span className="text-[#8A7F73] font-normal">
                Same layout, size, content as Packing dept print
              </span>
            </div>
            <div className="overflow-x-auto">
              <div className="flex gap-3 p-3 min-w-min">
                {foamPrintStickers
                  .filter(s => !s.isSyntheticLegs && !s.isSyntheticPillow)
                  .map((s) => {
                    const legsPair = foamPrintStickers.find(
                      (x) => x.isSyntheticLegs && x.comboPairKey === s.key,
                    );
                    const pillowPair = foamPrintStickers.find(
                      (x) => x.isSyntheticPillow && x.comboPairKey === s.key,
                    );
                    const customerLine = s.customerHub || s.customerName;
                    return (
                      <div
                        key={s.key}
                        className="flex-shrink-0 border border-[#E6E0D9] rounded-md bg-white flex flex-col overflow-hidden"
                        style={{ width: "200px", height: "330px", padding: "6px" }}
                        title={`${s.poNo} · ${s.productCode} · ${s.pieceName} ${s.pieceNo}/${s.totalPieces}`}
                      >
                        <div className="text-center font-bold leading-tight" style={{ fontSize: "13px" }}>
                          {customerLine || s.customerName || "—"}
                        </div>
                        <div className="border-t border-black my-1" />
                        <div className="space-y-[1.5px] leading-tight text-[#1F1D1B]" style={{ fontSize: "9px" }}>
                          <div className="truncate"><span className="inline-block w-[58px] font-semibold text-[#6B7280]">PO No</span>: {s.customerPOId || "—"}</div>
                          <div className="truncate"><span className="inline-block w-[58px] font-semibold text-[#6B7280]">Cust Ref</span>: {s.customerRef || "—"}</div>
                          <div className="truncate"><span className="inline-block w-[58px] font-semibold text-[#6B7280]">Cust SO</span>: {s.customerSO || "—"}</div>
                          <div className="truncate"><span className="inline-block w-[58px] font-semibold text-[#6B7280]">Our SO</span>: {s.salesOrderNo || "—"}</div>
                          <div className="truncate"><span className="inline-block w-[58px] font-semibold text-[#6B7280]">Model</span>: <span className="font-bold">{s.productCode || "—"}</span></div>
                          {s.boxLabel && (
                            <div className="truncate"><span className="inline-block w-[58px] font-semibold text-[#6B7280]">WIP</span>: {s.boxLabel}</div>
                          )}
                        </div>
                        <div className="border-t border-black my-1" />
                        <div className="space-y-[1.5px] leading-tight text-[#1F1D1B]" style={{ fontSize: "9px" }}>
                          <div><span className="inline-block w-[58px] font-semibold text-[#6B7280]">Size</span>: {s.sizeLabel || "—"}</div>
                          {s.itemCategory === "SOFA" && s.seatSize && (
                            <div><span className="inline-block w-[58px] font-semibold text-[#6B7280]">Seat</span>: {s.seatSize}"</div>
                          )}
                          <div><span className="inline-block w-[58px] font-semibold text-[#6B7280]">Colour</span>: {s.fabricCode || "—"}</div>
                          {s.itemCategory === "BEDFRAME" && (
                            <>
                              <div><span className="inline-block w-[58px] font-semibold text-[#6B7280]">Gap</span>: {s.gapInches != null ? `${s.gapInches}"` : "—"}</div>
                              <div><span className="inline-block w-[58px] font-semibold text-[#6B7280]">Divan</span>: {s.divanHeightInches != null ? `${s.divanHeightInches}"` : "—"}</div>
                            </>
                          )}
                          <div><span className="inline-block w-[58px] font-semibold text-[#6B7280]">Leg</span>: {s.legHeightInches != null && s.legHeightInches > 0 ? `${s.legHeightInches}"` : "—"}</div>
                          {s.specialOrder && (
                            <div className="truncate text-[#9A3A2D] font-bold">★ {s.specialOrder}</div>
                          )}
                        </div>
                        <div className="mt-auto pt-1 border-t border-dashed border-black flex items-end gap-1">
                          <QRImg
                            eager
                            data={packingStickerUrl(s)}
                            size={pillowPair ? 48 : 64}
                            alt="FG QR"
                            className="block shrink-0"
                          />
                          <div className="flex-1 text-center min-w-0">
                            {legsPair && (
                              <>
                                <div className="font-bold leading-none" style={{ fontSize: "14px" }}>
                                  {legsPair.pieceNo}/{legsPair.totalPieces}
                                </div>
                                <div className="font-bold uppercase" style={{ fontSize: "8px" }}>{legsPair.pieceName}</div>
                                <div className="text-[7px] text-[#888]">{legsPair.shortCode}</div>
                                <div className="border-t border-dotted my-0.5" />
                              </>
                            )}
                            <div className="font-bold leading-none" style={{ fontSize: "18px" }}>
                              {s.pieceNo}/{s.totalPieces}
                            </div>
                            <div className="font-bold uppercase" style={{ fontSize: "9px" }}>{s.pieceName}</div>
                            <div className="text-[7px] text-[#888]">{s.shortCode}</div>
                          </div>
                          {pillowPair && (
                            <div className="text-center min-w-0">
                              <QRImg
                                eager
                                data={packingStickerUrl(pillowPair)}
                                size={50}
                                alt="Pillow QR"
                                className="block"
                              />
                              <div className="font-bold leading-none" style={{ fontSize: "10px" }}>
                                {pillowPair.pieceNo}/{pillowPair.totalPieces}
                              </div>
                              <div className="font-bold uppercase" style={{ fontSize: "7px" }}>{pillowPair.pieceName}</div>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
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
                    // One sticker per physical piece — sum piecesToCut
                    // (cutting-recipe panel count), NOT qty (order
                    // quantity, always 1). See BUG-2026-06-01-001.
                    const qtySum = visibleRows.reduce(
                      (s, r) => s + ((r as { piecesToCut?: number }).piecesToCut ?? 0),
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
                  // FG/packing sticker QR = a worker-scan completion code (Wei Siang
                  // 2026-06-06: the /track tracking page isn't used; this sticker
                  // is scanned at Packing to mark the unit done + assign a rack).
                  // Prefer the public no-login rack page (/p/<token>) so a
                  // storekeeper without a Worker-Portal PIN can set the rack; fall
                  // back to the /worker/scan deep link (FG-PACKING sentinel, dept
                  // derived) when no token resolved — that keeps the logged-in
                  // worker scan + completion flow working. See packingStickerUrl —
                  // both render sites build this identically.
                  const trackUrl = packingStickerUrl(s);
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
                          <span className="inline-block w-[72px] font-semibold text-[#6B7280] shrink-0">Model</span>
                          <span className="font-bold whitespace-nowrap" style={{ fontSize: `${Math.max(11, Math.min(16, Math.round(200 / ((s.productCode || "—").length + 2))))}px` }}>: {s.productCode || "—"}</span>
                        </div>
                        {s.boxLabel && (
                          <div className="flex items-baseline gap-1">
                            <span className="inline-block w-[72px] font-semibold text-[#6B7280] shrink-0">WIP</span>
                            <span
                              className="flex-1 min-w-0 truncate"
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
                            className="flex-1 min-w-0 truncate"
                            style={{
                              fontSize: "11px",
                              lineHeight: 1.2,
                            }}
                          >: {oemMarkFor(s) ? <span className="font-bold text-[#6B5C32]">{oemMarkFor(s)} </span> : null}{s.specialOrder ? <span className="font-bold text-[#9A3A2D]">★ {s.specialOrder}</span> : (oemMarkFor(s) ? null : "—")}</span>
                        </div>
                      </div>
                      {/* Wei Siang 2026-05-15 (revised again): leg moves
                          INTO the right column ABOVE the SOFA piece-name
                          / pieceNo. Single dashed separator at the top
                          of the bottom block (between Spec section and
                          this block). Pillow stays side-by-side. */}
                      <div className="mt-auto pt-1 border-t border-dashed border-[#6B5C32]">
                        <div className="flex items-end gap-2 pt-1">
                          <QRImg data={trackUrl} size={pillowPair ? 64 : 78} alt="FG unit QR" className="block shrink-0" />
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
                /* Padding bumped (large 4→6mm, small 2→4mm) so the QR — bottom-
                   left on the 100mm card, top-centre on the 50mm one — clears a
                   printer's ~5mm non-printable margin instead of being shaved
                   off, same fix as the FG box label (Wei Siang 2026-06-16). The
                   QR's new quiet zone covers the rest. */
                padding: ${useLargeSticker ? "6mm" : "4mm"} !important;
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
                        className="flex-1 min-w-0 truncate"
                        style={{
                          fontSize: "11pt",
                          lineHeight: 1.2,
                        }}
                      >: {s.customerName || "—"}</span>
                    </div>
                    <div className="flex items-baseline gap-[1mm]">
                      <span className="inline-block w-[35mm] font-semibold shrink-0">Model</span>
                      {/* one line — nowrap + length-based shrink so a long model
                          (e.g. 1030(HF)(W)-(Q)) never wraps and pushes the QR. */}
                      <span
                        className="font-bold whitespace-nowrap"
                        style={{ fontSize: `${Math.max(10, Math.min(15, Math.round(230 / ((s.model || "—").length + 2))))}pt` }}
                      >: {s.model || "—"}</span>
                    </div>
                    {s.wipName && (
                      <div className="flex items-baseline gap-[1mm]">
                        <span className="font-semibold shrink-0" style={{ width: "35mm" }}>WIP</span>
                        <span
                          className="flex-1 min-w-0 truncate"
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
                  </div>
                  {/* Notes fills the space above the QR block and clips ITSELF
                      (flex-1 + overflow-hidden) so a long note never pushes the
                      QR + sign-off + Qty block off a field-heavy BEDFRAME card
                      when printed (owner 2026-07-11). */}
                  <div className="flex items-start gap-[1mm] flex-1 min-h-0 overflow-hidden" style={{ fontSize: "11pt", lineHeight: 1.2 }}>
                    <span className="font-semibold shrink-0" style={{ width: "35mm", color: "#9A3A2D" }}>Notes</span>
                    <span className="flex-1 min-w-0 whitespace-normal break-words">
                      : {oemMarkFor(s) ? <span className="font-bold" style={{ color: "#6B5C32" }}>{oemMarkFor(s)} </span> : null}{s.specialOrder ? <span className="font-bold" style={{ color: "#9A3A2D" }}>★ {s.specialOrder}</span> : (oemMarkFor(s) ? null : "—")}
                    </span>
                  </div>
                  {/* Bottom block — dashed top border + QR (left) + Fab Cut/Sew
                      sign-off + Qty (right). Pinned below the flex-1 Notes. */}
                  <div className="pt-[1.5mm] border-t border-dashed border-black">
                    <div className="flex items-end gap-[2mm] pt-[1.5mm]">
                      {s.qrDataUrl && (
                        // Fab Cut 100x150mm: QR gets its OWN left/bottom margin
                        // (on top of the 6mm page padding) so it sits further from
                        // the edge than the text — same anti-clip treatment as the
                        // Packing FG box label.
                        <img
                          src={s.qrDataUrl}
                          alt="Job card QR"
                          style={{ width: "34mm", height: "34mm" }}
                          className="shrink-0 ml-[2mm] mb-[1.5mm]"
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
                        <div className="flex items-end justify-between mt-[2mm]" style={{ fontSize: "13pt" }}>
                          <span className="font-bold">Qty {s.qty}</span>
                          {/* Bottom-right component-type label so a worker knows at
                              a glance what this piece is (owner request). Derived
                              from the SAME normalized piece field the grid uses —
                              s.wipType, produced by the wipType helper in
                              baserows-core.ts (HB / DIVAN / BASE / CUSHION / ARMREST
                              / HEADREST). We do NOT re-derive the piece here; we only
                              MAP that label (plus a case-insensitive wipName fallback
                              for legs / un-typed bedframe rows) to one of the six
                              human labels: HB / Divan / Base / Armrest / Cushion /
                              Leg. A piece that maps to none of the six (whole/full
                              product, HEADREST, accessory) shows NO badge rather than
                              a wrong label. Boxed + large so it reads on a B/W print. */}
                          <div className="text-right leading-tight flex flex-col items-end gap-[1mm]">
                            {(() => {
                              // Shared with the on-screen QR Stickers preview tile
                              // (renderLargeStickerTile) via componentBadgeLabel so
                              // the printout and the preview never drift.
                              const label = componentBadgeLabel(s);
                              // No confident match → omit the badge.
                              if (!label) return null;
                              return (
                                <div
                                  className="font-bold uppercase border-2 border-black text-center"
                                  style={{
                                    fontSize: "18pt",
                                    lineHeight: 1.05,
                                    padding: "0.5mm 2mm",
                                    borderRadius: "1mm",
                                  }}
                                >
                                  {label}
                                </div>
                              );
                            })()}
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
              </div>
            ) : (
              // ----- Default 50×75mm sticker (other depts) -----
              <div
                key={s.key}
                className="sticker-jc-page bg-white text-black flex flex-col items-center"
                style={{ width: "50mm", height: "75mm" }}
              >
                {/* 50x75mm: QR is top-centred (already clear left/right). Give it
                    a top margin too so its top edge clears the printer margin —
                    parity with the larger labels' anti-clip treatment. */}
                <img
                  src={s.qrDataUrl}
                  alt="Job card QR"
                  style={{ width: "30mm", height: "30mm" }}
                  className="mt-[1mm]"
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

      {/* Batch FG stickers — one 100×150mm page per filtered PO. The
          source list switches based on which print is active:
            • fgPrintRequested  → visibleFgStickers (PACKING tab Print All,
              grid-filter scoped, Wei Siang 2026-05-10)
            • foamPrintRequested → foamPrintStickers (Foam tab Print Packing
              Stickers, SO-scoped, refactored 2026-05-24 to share this
              same hidden container instead of generating a jspdf file)
          The two paths are mutually exclusive — only one button at a
          time can be in flight. Either source produces the same FgSticker
          shape (built by fetchFgStickersForOrders) so the rendering loop
          below is identical for both. */}
      {(visibleFgStickers.length > 0 || foamPrintStickers.length > 0) && (
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
                /* 6mm inner padding (was 4mm) so NOTHING — especially the
                   bottom-left QR — sits inside a printer's ~5-6mm non-printable
                   margin and gets shaved off (Wei Siang 2026-06-15: the Packing
                   QR was "挤出去了"). Combined with the QR's new 2-module quiet
                   zone, the scannable area clears the edge with room to spare. */
                margin: 0 !important; padding: 6mm !important;
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
            {(() => {
              // Pick the active source. Mutually exclusive — both print
              // paths flip their flag and the useTimeout fires
              // window.print() within 1500ms; the operator can't click
              // the second button in between because the first click
              // grabs focus into the OS print dialog.
              if (!fgPrintRequested && !foamPrintRequested) return null;
              const printSource: FgSticker[] = foamPrintRequested
                ? foamPrintStickers
                : visibleFgStickers;
              return printSource.map((s) => {
              // Paired secondaries (Legs / Pillow) print inside their
              // primary's page — skip standalone.
              if (s.isSyntheticLegs || s.isSyntheticPillow) return null;
              // FG/packing sticker QR = a worker-scan completion code (Wei Siang
              // 2026-06-06: the /track tracking page isn't used; this sticker
              // is scanned at Packing to mark the unit done + assign a rack).
              // Prefer the public no-login rack page (/p/<token>); fall back to
              // the /worker/scan deep link when no token resolved. See
              // packingStickerUrl — both render sites build this identically.
              const trackUrl = packingStickerUrl(s);
              // Hub-only when set — see on-screen tile comment above.
              const customerLine = s.customerHub || s.customerName;
              // Legs / Pillow render INSIDE their primary's print page —
              // never as a standalone .sticker-fg-page (Wei Siang spec:
              // FG sticker 是要合成逻辑的). The standalone case is
              // filtered out above with `if (s.isSyntheticLegs ||
              // s.isSyntheticPillow) return null;`.
              const legsPair = printSource.find(
                (x) => x.isSyntheticLegs && x.comboPairKey === s.key,
              );
              const pillowPair = printSource.find(
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
                        <span className="inline-block w-[30mm] font-semibold shrink-0">Model</span>
                        {/* Model MUST stay on ONE line — a wrapped model pushes the
                            whole card down and shoves the bottom QR off the label
                            (owner: "QR 又爆了 … model 一定要放进去同一排"). nowrap +
                            length-based auto-shrink: short codes print big (20pt),
                            long ones (e.g. 1030(HF)(W)-(Q)) shrink to fit, floor 11pt. */}
                        <span
                          className="font-bold whitespace-nowrap"
                          style={{ fontSize: `${Math.max(11, Math.min(20, Math.round(250 / ((s.productCode || "—").length + 2))))}pt`, lineHeight: 1.1 }}
                        >: {s.productCode || "—"}</span>
                      </div>
                      {s.boxLabel && (
                        <div className="flex items-baseline gap-[1mm]">
                          <span className="font-semibold shrink-0" style={{ width: "30mm" }}>WIP</span>
                          <span
                            className="flex-1 min-w-0 truncate"
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
                      {/* Hide the upper "Leg : N"" row when the legsPair
                          renders at the bottom — the info is duplicated
                          there AND the extra bottom block (~13mm) leaves no
                          room for two upper rows, so the printer's
                          overflow:hidden clips Leg+Notes (Wei Siang 2026-06-29:
                          "preview 沒問題 可是 print 出來就歪了"). Same SO with
                          NO legsPair (e.g. HB piece) keeps the upper Leg row
                          and prints all measurements. */}
                      {!legsPair && (
                        <div><span className="inline-block w-[30mm] font-semibold">Leg</span>: {s.legHeightInches != null && s.legHeightInches > 0 ? `${s.legHeightInches}"` : "—"}</div>
                      )}
                      {/* Notes — also skip when empty so a "—" placeholder
                          doesn't burn the one row needed by the legsPair
                          bottom block. */}
                      {(s.specialOrder || !legsPair) && (
                        <div className="flex items-baseline gap-[1mm]">
                          <span className="font-semibold shrink-0" style={{ width: "30mm", color: "#9A3A2D" }}>Notes</span>
                          <span
                            className="flex-1 min-w-0 truncate"
                            style={{
                              fontSize: "11pt",
                              lineHeight: 1.2,
                            }}
                          >
                            : {oemMarkFor(s) ? <span className="font-bold" style={{ color: "#6B5C32" }}>{oemMarkFor(s)} </span> : null}{s.specialOrder ? <span className="font-bold" style={{ color: "#9A3A2D" }}>★ {s.specialOrder}</span> : (oemMarkFor(s) ? null : "—")}
                          </span>
                        </div>
                      )}
                    </div>
                    {/* Wei Siang 2026-05-15 (revised again): leg moves
                        INTO the right column ABOVE the main piece
                        name / pieceNo. Single dashed separator at the
                        top of this bottom block. Pillow stays side-
                        by-side. Same 100×150mm physical card. */}
                    <div className="mt-auto pt-[2mm] border-t border-dashed border-black">
                      <div className="flex items-end gap-[2mm] pt-[2mm]">
                        {/* Slightly smaller + its OWN left/bottom margin (on top
                            of the page's 6mm padding) so the QR sits further from
                            the edge than the text — the text can lose a sliver,
                            the QR must survive. With the quiet zone + Q-level
                            error correction it scans even if a corner is shaved. */}
                        <QRImg eager data={trackUrl} size={pillowPair ? 72 : 104} alt="FG unit QR" className="block ml-[2mm] mb-[1.5mm] shrink-0" />
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
            });
            })()}
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

      {/* Mark-as-Sent prompt shown at print time — a system-styled replacement
          for the native browser window.confirm ("erp.hookka.com says…"). Its
          buttons re-invoke the matching print handler with the decision, from
          THIS button-click gesture, so the handler's window.open print popup is
          not pop-up-blocked. Mounted at the root so it overlays everything. */}
      {printSentPrompt && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30">
          <div className="w-[420px] rounded-md border border-[#E6E0D9] bg-white p-4 shadow-lg">
            <h3 className="mb-2 text-[14px] font-semibold text-[#3A2E22]">
              Mark items as Sent?
            </h3>
            <p className="mb-4 text-[12px] leading-relaxed text-[#6B5E50]">
              Printing this schedule hands the work to the floor. Mark all{" "}
              <strong>{printSentPrompt.count}</strong> item
              {printSentPrompt.count === 1 ? "" : "s"} in it as{" "}
              <strong>Sent</strong> (distributed to the department)?
            </p>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPrintSentPrompt(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const which = printSentPrompt.which;
                  setPrintSentPrompt(null);
                  if (which === "total") handlePrintTotalListing(false);
                  else handlePrintSchedule(false);
                }}
              >
                Print only
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const which = printSentPrompt.which;
                  setPrintSentPrompt(null);
                  if (which === "total") handlePrintTotalListing(true);
                  else handlePrintSchedule(true);
                }}
              >
                Mark all &amp; print
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* PatchFailureModal removed 2026-05-12 — failures now surface as
          toast.error from flushDrafts. Cell auto-reverts on failure, so the
          operator sees the value disappear + the toast at the same time. */}
    </div>
  );
}
