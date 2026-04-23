import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Check, Plus, Lock } from "lucide-react";
import { DataGrid } from "@/components/ui/data-grid";
import type { Column } from "@/components/ui/data-grid";
import { getQRCodeUrl, getQRCodeDataURL, generateStickerData } from "@/lib/qr-utils";

// ----- types -----
type JobCard = {
  id: string; departmentId: string; departmentCode: string; departmentName: string; sequence: number;
  status: "WAITING"|"IN_PROGRESS"|"PAUSED"|"COMPLETED"|"TRANSFERRED"|"BLOCKED";
  dueDate: string; prerequisiteMet: boolean;
  pic1Id: string|null; pic1Name: string; pic2Id: string|null; pic2Name: string;
  completedDate: string|null; estMinutes: number; actualMinutes: number|null;
  category: string; productionTimeMinutes: number; overdue: string;
  wipKey?: string; wipCode?: string; wipType?: string; wipLabel?: string;
  wipQty?: number; rackingNumber?: string;
};

type ProductionOrder = {
  id: string; poNo: string;
  salesOrderId: string; salesOrderNo: string; lineNo: number;
  customerPOId: string; customerReference: string; customerName: string; customerState: string;
  companySOId: string;
  productId: string; productCode: string; productName: string; itemCategory: "SOFA"|"BEDFRAME"|"ACCESSORY";
  sizeCode: string; sizeLabel: string; fabricCode: string; quantity: number;
  gapInches: number|null; divanHeightInches: number|null; legHeightInches: number|null;
  specialOrder: string; notes: string;
  status: "PENDING"|"IN_PROGRESS"|"COMPLETED"|"ON_HOLD"|"CANCELLED"|"PAUSED";
  currentDepartment: string; progress: number;
  jobCards: JobCard[];
  startDate: string; targetEndDate: string; completedDate: string|null;
  rackingNumber: string; stockedIn: boolean;
};

// ----- constants -----
const DEPARTMENTS = [
  { name: "Fab Cut",    code: "FAB_CUT" },
  { name: "Fab Sew",    code: "FAB_SEW" },
  { name: "Foam",       code: "FOAM" },
  { name: "Wood Cut",   code: "WOOD_CUT" },
  { name: "Framing",    code: "FRAMING" },
  { name: "Webbing",    code: "WEBBING" },
  { name: "Upholstery", code: "UPHOLSTERY" },
  { name: "Packing",    code: "PACKING" },
] as const;

// Workflow order used by the upstream-lock rule: once a later dept's JC is
// COMPLETED/TRANSFERRED we lock dueDate/completedDate edits on every earlier
// dept's JC within the same wipKey. Mirrors src/api/lib/lead-times.ts DEPT_ORDER
// (WOOD_CUT comes before FOAM there, but on the UI we keep the presentation
// order the operator already knows — what matters is relative position between
// a given pair for the lock decision).
const DEPT_ORDER: readonly string[] = [
  "FAB_CUT",
  "FAB_SEW",
  "FOAM",
  "WOOD_CUT",
  "FRAMING",
  "WEBBING",
  "UPHOLSTERY",
  "PACKING",
] as const;

// Simplified 3-state palette per user spec:
//   completed = cyan, pending = amber, overdue = rose.
// "active/blocked/ready" all collapse into "pending" since work is unfinished.
type CellState = "done" | "pending" | "overdue" | "empty";
type Cell = {
  state: CellState;
  totalCards: number;
  doneCards: number;
  earliestDue: string; // YYYY-MM-DD
  latestCompleted: string; // latest completedDate across this dept's cards
};

function fmtShortDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const mm = d.toLocaleString("en-US", { month: "short" });
  return `${d.getDate()} ${mm}`;
}

function cellFor(order: ProductionOrder, deptCode: string): Cell {
  const cards = order.jobCards.filter((j) => j.departmentCode === deptCode);
  if (cards.length === 0) {
    return { state: "empty", totalCards: 0, doneCards: 0, earliestDue: "", latestCompleted: "" };
  }
  const done = cards.filter(
    (c) => c.status === "COMPLETED" || c.status === "TRANSFERRED",
  ).length;
  const earliestDue =
    cards.map((c) => c.dueDate).filter(Boolean).sort()[0] || "";
  const latestCompleted =
    cards.map((c) => c.completedDate || "").filter(Boolean).sort().slice(-1)[0] || "";

  let state: CellState;
  if (done === cards.length) state = "done";
  else {
    const today = new Date().toISOString().slice(0, 10);
    state = earliestDue && earliestDue < today ? "overdue" : "pending";
  }
  return { state, totalCards: cards.length, doneCards: done, earliestDue, latestCompleted };
}

// ----- cell renderer -----
// Each cell shows state colour + the relevant date. Text is white so it
// stays legible against the teal/olive/red state backgrounds — previously
// text-color matched bg-color and both the ✓ and date were invisible.
function CellBox({ cell }: { cell: Cell }) {
  const base =
    "h-full w-full flex flex-col items-center justify-center text-[10px] leading-tight relative";

  if (cell.state === "empty") {
    return <div className={`${base} bg-transparent`} />;
  }
  if (cell.state === "done") {
    return (
      <div className={`${base} bg-[#3E6570] text-white`}>
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
        <span className="text-[9px] mt-0.5 font-semibold">
          {fmtShortDate(cell.latestCompleted || cell.earliestDue)}
        </span>
      </div>
    );
  }
  if (cell.state === "overdue") {
    return (
      <div className={`${base} bg-[#9A3A2D] text-white cursor-pointer hover:bg-[#B04536]`}>
        <span className="font-bold">{cell.doneCards}/{cell.totalCards}</span>
        <span className="text-[9px] font-semibold">{fmtShortDate(cell.earliestDue)}</span>
      </div>
    );
  }
  // pending
  return (
    <div className={`${base} bg-[#9C6F1E] text-white cursor-pointer hover:bg-[#B38023]`}>
      <span className="font-bold">{cell.doneCards}/{cell.totalCards}</span>
      <span className="text-[9px] font-semibold">{fmtShortDate(cell.earliestDue)}</span>
    </div>
  );
}

// ----- product detail block (inline under product code) -----
function ProductDetailLine({ order }: { order: ProductionOrder }) {
  const bits: string[] = [];
  if (order.fabricCode) bits.push(order.fabricCode);
  if (order.sizeLabel) bits.push(order.sizeLabel);
  if (order.divanHeightInches != null) bits.push(`DV ${order.divanHeightInches}"`);
  if (order.legHeightInches != null) bits.push(`LG ${order.legHeightInches}"`);
  if (order.gapInches != null) bits.push(`GP ${order.gapInches}"`);
  return (
    <div className="text-[10px] text-[#9A918A] mt-0.5">{bits.join(" · ")}</div>
  );
}

// ----- Stock PO dialog -----
// Lets the factory create a "make-to-stock" production order against a
// placeholder SOH-YYMM-NNN SO when capacity is free and no real customer
// order is queued. Two modes:
//   - WIP: build only a sub-assembly (e.g. a Divan group off a bedframe BOM).
//     Item list is sourced from /historical-wips — distinct wipLabels across
//     every JobCard the factory has ever run.
//   - FG:  build the full finished good (complete pipeline incl. PACKING).
//     Item list is sourced from /historical-fgs — distinct product+size+fabric
//     trios from past POs.
// Only SKUs previously produced show up — this is intentional so we don't
// have to maintain a separate "stockable items" catalog.
type HistoricalWip = {
  wipLabel: string;
  wipKey?: string;
  wipCode?: string;
  wipType?: string;       // DIVAN / HEADBOARD / SOFA_BASE / SOFA_CUSHION / SOFA_ARMREST
  itemCategory?: string;  // BEDFRAME / SOFA
  sourcePoId: string;
  sourceJcId: string;
  sourcePoNo: string;
  productCode: string;
  productName: string;
  sizeCode: string;
  sizeLabel: string;
  fabricCode: string;
};
type HistoricalFg = {
  sourcePoId: string;
  sourcePoNo: string;
  productCode: string;
  productName: string;
  sizeCode: string;
  sizeLabel: string;
  fabricCode: string;
};

function CreateStockPODialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [type, setType] = useState<"WIP" | "FG">("WIP");
  const [wips, setWips] = useState<HistoricalWip[]>([]);
  const [fgs, setFgs] = useState<HistoricalFg[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [search, setSearch] = useState("");
  // Dropdown filters layered on top of the search box. Category ("BEDFRAME"
  // / "SOFA") narrows the pool to one product family; WIP type (Divan / HB /
  // Base / Cushion / Arm, derived from wipType) narrows by component kind;
  // size and fabric match the existing dedup-key fields. Blank = no filter
  // on that axis. Applies to both the WIP and FG panes — FG rows have no
  // wipType so the WIP filter collapses to itemCategory+size+fabric there.
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [filterWipType, setFilterWipType] = useState<string>("");
  const [filterSize, setFilterSize] = useState<string>("");
  const [filterFabric, setFilterFabric] = useState<string>("");
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [quantity, setQuantity] = useState<number>(1);
  const [targetEndDate, setTargetEndDate] = useState<string>(() => {
    // Default: two weeks out. Covers average bedframe/sofa lead time
    // comfortably, but the operator can push it later.
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().slice(0, 10);
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string>("");

  // Load whichever list is active (WIP or FG) whenever the dialog opens
  // or the Type toggle changes. Keeps the picker data fresh — if the user
  // just created a new PO, its wipLabels should show up on the next open.
  useEffect(() => {
    if (!open) return;
    setSelectedKey("");
    setSearch("");
    setFilterCategory("");
    setFilterWipType("");
    setFilterSize("");
    setFilterFabric("");
    setErr("");
    setLoadingList(true);
    const url = type === "WIP"
      ? "/api/production-orders/historical-wips"
      : "/api/production-orders/historical-fgs";
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        if (!d?.success) {
          setWips([]); setFgs([]); setLoadingList(false); return;
        }
        if (type === "WIP") { setWips(d.data || []); setFgs([]); }
        else { setFgs(d.data || []); setWips([]); }
        setLoadingList(false);
      })
      .catch(() => setLoadingList(false));
  }, [open, type]);

  // Unique value lists used to populate the dropdown filters. Computed off
  // whichever pane (WIP / FG) is active so the options always match what's
  // pickable — e.g. the wipType dropdown is empty on the FG pane since FGs
  // don't carry one.
  const filterOptions = useMemo(() => {
    const cats = new Set<string>();
    const types = new Set<string>();
    const sizes = new Set<string>();
    const fabrics = new Set<string>();
    const source = type === "WIP" ? wips : fgs;
    for (const row of source) {
      const r = row as HistoricalWip & { itemCategory?: string };
      if (r.itemCategory) cats.add(r.itemCategory);
      if ("wipType" in r && r.wipType) types.add(r.wipType);
      if (r.sizeCode) sizes.add(r.sizeCode);
      if (r.fabricCode) fabrics.add(r.fabricCode);
    }
    return {
      categories: [...cats].sort(),
      wipTypes: [...types].sort(),
      sizes: [...sizes].sort(),
      fabrics: [...fabrics].sort(),
    };
  }, [type, wips, fgs]);

  // Filtered list for the picker. Dropdown filters narrow the pool first,
  // then the free-text search runs against the label / product / size /
  // fabric strings so the operator can still type "Divan" or "QN" to hit
  // their target quickly.
  const filteredOptions = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matchFilters = (
      cat: string | undefined,
      wt: string | undefined,
      sz: string,
      fab: string,
    ) =>
      (!filterCategory || cat === filterCategory) &&
      (!filterWipType || wt === filterWipType) &&
      (!filterSize || sz === filterSize) &&
      (!filterFabric || fab === filterFabric);

    if (type === "WIP") {
      const rows = wips
        .filter((w) =>
          matchFilters(w.itemCategory, w.wipType, w.sizeCode, w.fabricCode),
        )
        .map((w) => ({
          key: `${w.sourcePoId}::${w.sourceJcId}`,
          label: w.wipLabel,
          sub: `${w.productName} · ${w.sizeLabel} · ${w.fabricCode || "—"}`,
          ref: w.sourcePoNo,
        }));
      return q
        ? rows.filter((r) =>
            (r.label + " " + r.sub).toLowerCase().includes(q))
        : rows;
    } else {
      const rows = fgs
        .filter((f) =>
          matchFilters(
            (f as HistoricalFg & { itemCategory?: string }).itemCategory,
            undefined,
            f.sizeCode,
            f.fabricCode,
          ),
        )
        .map((f) => ({
          key: f.sourcePoId,
          label: `${f.productCode} — ${f.productName}`,
          sub: `${f.sizeLabel} · ${f.fabricCode || "—"}`,
          ref: f.sourcePoNo,
        }));
      return q
        ? rows.filter((r) =>
            (r.label + " " + r.sub).toLowerCase().includes(q))
        : rows;
    }
  }, [
    type,
    wips,
    fgs,
    search,
    filterCategory,
    filterWipType,
    filterSize,
    filterFabric,
  ]);

  async function handleSubmit() {
    if (!selectedKey) { setErr("Pick an item first."); return; }
    if (!quantity || quantity < 1) { setErr("Quantity must be ≥ 1."); return; }
    if (!targetEndDate) { setErr("Pick a target end date."); return; }

    let body: Record<string, unknown>;
    if (type === "WIP") {
      const [sourcePoId, sourceJcId] = selectedKey.split("::");
      body = { type, sourcePoId, sourceJcId, quantity, targetEndDate };
    } else {
      body = { type, sourcePoId: selectedKey, quantity, targetEndDate };
    }

    setSubmitting(true);
    setErr("");
    try {
      const res = await fetch("/api/production-orders/stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok || !d?.success) {
        setErr(d?.error || `Failed (${res.status}).`);
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
      onCreated();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-xl w-[640px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <div>
            <h2 className="text-lg font-bold text-[#111827]">Create Stock Production Order</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Uses spare capacity to build against a placeholder SOH- SO.
              When a real order arrives, the SO number is replaced in place.
            </p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Type toggle */}
          <div>
            <label className="text-sm font-medium text-[#111827]">Type</label>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setType("WIP")}
                className={`flex-1 px-3 py-2 rounded-md border text-sm ${
                  type === "WIP"
                    ? "border-[#6B5C32] bg-[#6B5C32]/10 text-[#6B5C32] font-medium"
                    : "border-[#E2DDD8] text-[#374151] hover:bg-[#FAF9F7]"
                }`}
              >
                WIP <span className="text-[10px] text-gray-500 ml-1">(sub-assembly, e.g. Divan)</span>
              </button>
              <button
                type="button"
                onClick={() => setType("FG")}
                className={`flex-1 px-3 py-2 rounded-md border text-sm ${
                  type === "FG"
                    ? "border-[#6B5C32] bg-[#6B5C32]/10 text-[#6B5C32] font-medium"
                    : "border-[#E2DDD8] text-[#374151] hover:bg-[#FAF9F7]"
                }`}
              >
                FG <span className="text-[10px] text-gray-500 ml-1">(full finished good)</span>
              </button>
            </div>
          </div>

          {/* Item picker */}
          <div>
            <label className="text-sm font-medium text-[#111827]">
              Item {type === "WIP" ? "(historical WIPs)" : "(historical finished goods)"}
            </label>
            <input
              type="text"
              placeholder={`Search ${type === "WIP" ? "WIP label / product / fabric" : "product / size / fabric"}…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full mt-1 px-3 py-2 text-sm border border-[#E2DDD8] rounded-md bg-[#FAF9F7] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
            />
            {/* Dropdown filters — layered on top of the search box. Options
              * come from the current list's own values so the dropdowns only
              * ever show selectable choices. WIP Type hides on the FG pane
              * because FGs don't carry one. */}
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="px-2 py-1.5 text-xs border border-[#E2DDD8] rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
              >
                <option value="">All Categories</option>
                {filterOptions.categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              {type === "WIP" && (
                <select
                  value={filterWipType}
                  onChange={(e) => setFilterWipType(e.target.value)}
                  className="px-2 py-1.5 text-xs border border-[#E2DDD8] rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
                >
                  <option value="">All WIP Types</option>
                  {filterOptions.wipTypes.map((t) => (
                    <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                  ))}
                </select>
              )}
              <select
                value={filterSize}
                onChange={(e) => setFilterSize(e.target.value)}
                className="px-2 py-1.5 text-xs border border-[#E2DDD8] rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
              >
                <option value="">All Sizes</option>
                {filterOptions.sizes.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <select
                value={filterFabric}
                onChange={(e) => setFilterFabric(e.target.value)}
                className="px-2 py-1.5 text-xs border border-[#E2DDD8] rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
              >
                <option value="">All Fabrics</option>
                {filterOptions.fabrics.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>
            <div className="mt-2 max-h-[260px] overflow-y-auto border border-[#E2DDD8] rounded-md divide-y divide-[#E2DDD8]">
              {loadingList ? (
                <div className="px-4 py-6 text-center text-sm text-gray-400">Loading…</div>
              ) : filteredOptions.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-gray-400">
                  {type === "WIP"
                    ? "No WIPs produced yet — create a normal PO first, or switch to FG."
                    : "No finished goods produced yet — create a normal PO first."}
                </div>
              ) : (
                filteredOptions.slice(0, 80).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setSelectedKey(opt.key)}
                    className={`w-full text-left px-3 py-2 transition-colors ${
                      selectedKey === opt.key ? "bg-[#6B5C32]/10" : "hover:bg-[#FAF9F7]"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium text-[#111827]">{opt.label}</div>
                        <div className="text-xs text-gray-500 mt-0.5">{opt.sub}</div>
                      </div>
                      <div className="text-[10px] text-gray-400">from {opt.ref}</div>
                    </div>
                  </button>
                ))
              )}
            </div>
            {filteredOptions.length > 80 && (
              <p className="text-xs text-gray-400 mt-1">Showing first 80 of {filteredOptions.length}</p>
            )}
          </div>

          {/* Quantity + due date side by side */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-[#111827]">Quantity</label>
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                className="w-full mt-1 px-3 py-2 text-sm border border-[#E2DDD8] rounded-md focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-[#111827]">Target End Date</label>
              <input
                type="date"
                value={targetEndDate}
                onChange={(e) => setTargetEndDate(e.target.value)}
                className="w-full mt-1 px-3 py-2 text-sm border border-[#E2DDD8] rounded-md focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
              />
            </div>
          </div>

          {err && (
            <div className="px-3 py-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">
              {err}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#E2DDD8] flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !selectedKey}
            className="bg-[#6B5C32] hover:bg-[#574A28] text-white"
          >
            {submitting ? "Creating…" : "Create Stock PO"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ----- main page -----
type Worker = { id: string; name: string; departmentCode?: string };

export default function ProductionPage() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"ALL" | string>("ALL");
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
  const sharedDateInputRef = useRef<HTMLInputElement>(null);
  const sharedDateChangeRef = useRef<(v: string) => void>(() => {});
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
      if (anchor instanceof HTMLElement) {
        const r = anchor.getBoundingClientRect();
        el.style.left = `${r.left}px`;
        el.style.top = `${r.bottom}px`;
      }
      if (typeof el.showPicker === "function") {
        try { el.showPicker(); return; } catch { /* showPicker not supported — fall through to focus/click */ }
      }
      el.focus();
      el.click();
    },
    [],
  );
  // Page-level filters — apply to BOTH the Overview matrix and all dept
  // sub-tabs. The user wanted unified filtering across the whole production
  // page plus a printable schedule output.
  const [fltSearch, setFltSearch] = useState("");
  const [fltState, setFltState] = useState("");
  const [fltCustomer, setFltCustomer] = useState("");
  const [fltDueFrom, setFltDueFrom] = useState("");
  const [fltDueTo, setFltDueTo] = useState("");
  // Status lifecycle filter: Active (default) hides ON_HOLD + CANCELLED.
  // "all" shows everything; "onhold" / "cancelled" / "completed" isolate
  // a single bucket for supervisors auditing the queue.
  const [fltLifecycle, setFltLifecycle] = useState<
    "active" | "all" | "onhold" | "cancelled" | "completed"
  >("active");

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
  useEffect(() => { setGridFilteredDeptRows(null); }, [activeTab]);

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
    // When a job card covers N pieces we print N stickers — one per
    // physical piece. Each sticker carries its own QR (p=N&t=M) so the
    // worker portal can tell piece 1 from piece 2 and reject duplicates.
    pieceNo: number;
    totalPieces: number;
    qrDataUrl: string;            // locally-generated base64 PNG (no network)
  };
  // Each FgSticker now = one FG unit (one physical box), NOT one PO.
  // A PO with qty=3 and 3 pieces/set produces 9 FgSticker rows.
  type FgSticker = {
    key: string;                // fgUnit.id
    unitSerial: string;         // full canonical serial for QR
    shortCode: string;          // human-readable batch+piece
    poNo: string;
    poId: string;
    productName: string;
    productCode: string;
    sku: string;                // product.skuCode (fallback to productCode)
    sizeLabel: string;          // product.sizeCode (e.g. "5 FTS") or order.sizeLabel
    fabricCode: string;
    fabricColor: string;
    customerName: string;
    customerHub: string;
    salesOrderNo: string;
    pieceNo: number;
    totalPieces: number;
    pieceName: string;
    unitNo: number;
    totalUnits: number;
    mfdDate: string | null;
  };
  const [jobCardStickers, setJobCardStickers] = useState<JobCardSticker[]>([]);
  const [fgStickers, setFgStickers] = useState<FgSticker[]>([]);
  // Loading flag shown on the header button while a batch of QRs pre-renders.
  const [printingJobCards, setPrintingJobCards] = useState(false);
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

  const fetchOrders = useCallback(() => {
    setLoading(true);
    fetch("/api/production-orders")
      .then((r) => r.json())
      .then((d) => {
        setOrders(d.success ? d.data : Array.isArray(d) ? d : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  // Fetch the 20 warehouse racks once so the Packing Rack dropdown is populated.
  useEffect(() => {
    fetch("/api/warehouse")
      .then((r) => r.json())
      .then((d) => {
        if (!d?.success) return;
        const locs = (d.data || []) as Array<{
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
      })
      .catch(() => {});
  }, []);

  // Workers list — powers PIC 1 / PIC 2 dropdowns. The API exposes a
  // `departmentCode` on every worker record; we fetch all workers once
  // here and filter client-side per active tab below.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/workers");
        if (!r.ok) return;
        const d = await r.json();
        const list: Worker[] =
          (d.success ? d.data : Array.isArray(d) ? d : []) as Worker[];
        if (Array.isArray(list)) setWorkers(list);
      } catch { /* network error — workers list stays empty */ }
    })();
  }, []);

  // Optimistic PATCH helper for inline job-card edits (due date, completion,
  // PIC1, PIC2). Updates local state immediately so the grid reflows, then
  // fires the server request in the background and refetches on success.
  const patchJobCard = useCallback(
    async (
      poId: string,
      jobCardId: string,
      patch: Partial<Pick<JobCard, "dueDate" | "completedDate" | "status" | "pic1Id" | "pic1Name" | "pic2Id" | "pic2Name">>,
    ) => {
      setOrders((prev) =>
        prev.map((o) =>
          o.id !== poId
            ? o
            : {
                ...o,
                jobCards: o.jobCards.map((j) =>
                  j.id !== jobCardId ? j : { ...j, ...patch },
                ),
              },
        ),
      );
      // Fire-and-forget PATCH. Replacing the whole PO with the server
      // response on every edit caused a second full-table re-render per
      // click (457 rows × closures), which felt laggy. Optimistic state is
      // enough; explicit refetch only happens on mount / tab switch.
      fetch(`/api/production-orders/${poId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobCardId, ...patch }),
      }).catch((err) => {
        console.error("[patchJobCard] network error", err);
      });
    },
    [],
  );

  // Optimistic PATCH for the Packing Rack dropdown. Writes rackingNumber to
  // the specific JobCard (so two WIPs under the same PO can land on different
  // racks) and mirrors it to the PO-level field for legacy readers.
  const patchRack = useCallback(
    (poId: string, jobCardId: string, rack: string) => {
      setOrders((prev) =>
        prev.map((o) =>
          o.id !== poId
            ? o
            : {
                ...o,
                rackingNumber: rack,
                jobCards: o.jobCards.map((j) =>
                  j.id === jobCardId ? { ...j, rackingNumber: rack } : j,
                ),
              },
        ),
      );
      fetch(`/api/production-orders/${poId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobCardId, rackingNumber: rack }),
      }).catch((err) => console.error("[patchRack] network error", err));
    },
    [],
  );

  // Dept fractions for tab bar: done/total cells across all orders per dept
  const deptFractions = useMemo(() => {
    return DEPARTMENTS.map((d) => {
      let done = 0;
      let total = 0;
      for (const o of orders) {
        const c = cellFor(o, d.code);
        if (c.state === "empty") continue;
        total += c.totalCards;
        done += c.doneCards;
      }
      return { ...d, done, total };
    });
  }, [orders]);

  const overallTotal = deptFractions.reduce((s, d) => s + d.total, 0);
  const overallDone  = deptFractions.reduce((s, d) => s + d.done, 0);

  // Apply the page-level filter panel to `orders` first, then scope further
  // by active tab (Overview = everything; dept tab = only orders that have
  // a non-empty cell in that dept).
  const filteredOrders = useMemo(() => {
    const q = fltSearch.trim().toLowerCase();
    return orders.filter((o) => {
      if (q) {
        const hay = [
          o.poNo, o.companySOId, o.customerPOId, o.customerReference,
          o.customerName, o.productCode, o.productName, o.fabricCode,
          o.sizeLabel,
        ].map((v) => (v || "").toLowerCase()).join(" ");
        if (!hay.includes(q)) return false;
      }
      if (fltState && o.customerState !== fltState) return false;
      if (fltCustomer && o.customerName !== fltCustomer) return false;
      if (fltDueFrom && (o.targetEndDate || "") < fltDueFrom) return false;
      if (fltDueTo && (o.targetEndDate || "") > fltDueTo) return false;
      // Lifecycle filter — "active" is the default since day-to-day operators
      // don't want ON_HOLD / CANCELLED POs cluttering their queue. Supervisors
      // can flip to "all" or drill into a specific bucket.
      switch (fltLifecycle) {
        case "active":
          if (o.status === "ON_HOLD" || o.status === "CANCELLED") return false;
          break;
        case "onhold":
          if (o.status !== "ON_HOLD") return false;
          break;
        case "cancelled":
          if (o.status !== "CANCELLED") return false;
          break;
        case "completed":
          if (o.status !== "COMPLETED") return false;
          break;
        // "all" — no-op
      }
      return true;
    });
  }, [orders, fltSearch, fltState, fltCustomer, fltDueFrom, fltDueTo, fltLifecycle]);

  const visibleOrders = useMemo(() => {
    if (activeTab === "ALL") return filteredOrders;
    return filteredOrders.filter(
      (o) => cellFor(o, activeTab).state !== "empty",
    );
  }, [filteredOrders, activeTab]);

  // Unique customer + state options for the filter dropdowns, derived live
  // from the order set so they auto-update when mock data changes.
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

  // Upstream dept chain derived from the real BOM tree structure.
  // Key = current dept; value = list of upstream dept codes. ALL entries
  // are shown as separate pills so convergent depts (Upholstery, Packing)
  // surface the full status of every feeder process — e.g. Upholstery
  // shows Foam + Framing + Sewing side-by-side per the user's workflow.
  const UPSTREAM: Record<string, string[]> = {
    FAB_CUT:    [],
    FAB_SEW:    ["FAB_CUT"],
    WOOD_CUT:   [],
    FRAMING:    ["WOOD_CUT"],
    WEBBING:    ["FRAMING"],
    FOAM:       ["FAB_SEW"],
    UPHOLSTERY: ["FOAM", "FRAMING", "FAB_SEW"],
    PACKING:    ["UPHOLSTERY"],
  };

  // Short labels for the prev-dept pills (saves horizontal space when
  // multiple pills stack in the Upholstery / Packing rows).
  const DEPT_SHORT: Record<string, string> = {
    FAB_CUT: "FC",
    FAB_SEW: "SEW",
    WOOD_CUT: "WD",
    FRAMING: "FR",
    WEBBING: "WB",
    FOAM: "FM",
    UPHOLSTERY: "UPH",
    PACKING: "PK",
  };

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
    customerPOId: string;
    customerRef: string;
    customerName: string;
    customerState: string;
    model: string;
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
    rack: string;         // Packing dept — assigned rack location ("Rack 3")
    dueDate: string;
    completedDate: string;
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
  // `siblings` is the list of job cards in the SAME wipKey branch on the
  // same PO — used to compute the `locked` flag (true when any later-dept
  // JC within the branch is COMPLETED or TRANSFERRED, which freezes this
  // cell's dueDate / completedDate edits client-side).
  const buildSched = (
    card: JobCard | null,
    today: string,
    poId: string,
    siblings: JobCard[] = [],
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
    const myPos = DEPT_ORDER.indexOf(card.departmentCode);
    const locked = myPos >= 0 && siblings.some((j) => {
      if (j.id === card.id) return false;
      const jPos = DEPT_ORDER.indexOf(j.departmentCode);
      if (jPos <= myPos) return false;
      return j.status === "COMPLETED" || j.status === "TRANSFERRED";
    });
    return {
      due, completed, state, sortKey, poId,
      jobCardId: card.id,
      deptCode: card.departmentCode,
      wipKey: card.wipKey || "",
      locked,
    };
  };

  const deptRows = useMemo<DeptRow[]>(() => {
    if (activeTab === "ALL") return [];
    const today = new Date().toISOString().slice(0, 10);
    const rows: DeptRow[] = [];
    let n = 1;
    for (const o of filteredOrders) {
      for (const jc of o.jobCards) {
        if (jc.departmentCode !== activeTab) continue;

        // For every department in the workflow, find the JobCard in the
        // same wipKey branch (so Divan Fab Sew is scoped to the Divan side,
        // not HB). Fall back to any card in that dept for this PO if the
        // branch has none. This populates one DeptSched per department so
        // the grid's Columns toggle can show/hide any dept's date column.
        const picker = (code: string): JobCard | null => {
          let cands = o.jobCards.filter(
            (j) => j.departmentCode === code && jc.wipKey && j.wipKey === jc.wipKey,
          );
          if (cands.length === 0) {
            cands = o.jobCards.filter((j) => j.departmentCode === code);
          }
          if (cands.length === 0) return null;
          return cands.sort(
            (a, b) => (b.dueDate || "").localeCompare(a.dueDate || ""),
          )[0];
        };

        // Sibling JCs used by buildSched to compute the upstream-lock flag.
        // Scope to same wipKey when the row carries one — fall back to every
        // JC on the PO so legacy rows without wipKey still lock sensibly.
        const siblings: JobCard[] = jc.wipKey
          ? o.jobCards.filter((j) => j.wipKey === jc.wipKey)
          : o.jobCards;

        rows.push({
          id: `${o.id}:${jc.id}`,
          poId: o.id,
          jobCardId: jc.id,
          rowNo: n++,
          soId: o.poNo || "",                  // line-suffixed, unique
          salesOrderNo: o.companySOId || "",   // parent SO (not unique per line)
          customerPOId: o.customerPOId || "",
          customerRef: o.customerReference || "",
          customerName: o.customerName || "",
          customerState: o.customerState || "",
          model: o.productCode || "",
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
          gap: o.gapInches != null ? `${o.gapInches}"` : "",
          divan: o.divanHeightInches != null ? `${o.divanHeightInches}"` : "",
          leg: o.legHeightInches != null ? `${o.legHeightInches}"` : "",
          // Total height = gap + divan + leg, matching the sales/create
          // formula used elsewhere in the system.
          totalHeight: (() => {
            const g = o.gapInches ?? 0;
            const d = o.divanHeightInches ?? 0;
            const l = o.legHeightInches ?? 0;
            const sum = g + d + l;
            return sum > 0 ? `${sum}"` : "";
          })(),
          qty: (jc as JobCard & { wipQty?: number }).wipQty ?? o.quantity ?? 0,
          rack: (jc as JobCard & { rackingNumber?: string }).rackingNumber || "",
          dueDate: jc.dueDate || "",
          completedDate: jc.completedDate || "",
          pic1: jc.pic1Name || "",
          pic2: jc.pic2Name || "",
          status: jc.status || "",
          poStatus: o.status || "",
          sched_FAB_CUT:    buildSched(picker("FAB_CUT"),    today, o.id, siblings),
          sched_FAB_SEW:    buildSched(picker("FAB_SEW"),    today, o.id, siblings),
          sched_FOAM:       buildSched(picker("FOAM"),       today, o.id, siblings),
          sched_WOOD_CUT:   buildSched(picker("WOOD_CUT"),   today, o.id, siblings),
          sched_FRAMING:    buildSched(picker("FRAMING"),    today, o.id, siblings),
          sched_WEBBING:    buildSched(picker("WEBBING"),    today, o.id, siblings),
          sched_UPHOLSTERY: buildSched(picker("UPHOLSTERY"), today, o.id, siblings),
          sched_PACKING:    buildSched(picker("PACKING"),    today, o.id, siblings),
        });
      }
    }
    return rows;
  }, [filteredOrders, activeTab]);

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

  // PIC dropdown shows ALL workers regardless of department — many staff
  // cover multiple depts, so filtering by activeTab hides valid assignees.
  // Sort alphabetically by name for easier scanning.
  const deptWorkers = useMemo(() => {
    return [...(workers || [])].sort((a, b) =>
      (a.name || "").localeCompare(b.name || ""),
    );
  }, [workers]);

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
            const leavingDone =
              (s === "COMPLETED" || s === "TRANSFERRED") &&
              !(next === "COMPLETED" || next === "TRANSFERRED");
            const patch: Parameters<typeof patchJobCard>[2] = { status: next };
            if (becomingDone && !row.completedDate) {
              patch.completedDate = new Date().toISOString().slice(0, 10);
            }
            if (leavingDone) {
              patch.completedDate = "";
            }
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
  const renderCompletionCell = (row: DeptRow) => {
    const has = !!row.completedDate;
    return (
      <div
        className="relative w-full h-full min-h-[22px] cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          openDatePicker(
            row.completedDate,
            (v) => {
              patchJobCard(row.poId, row.jobCardId, {
                completedDate: v,
                status: v ? "COMPLETED" : "WAITING",
              });
            },
            e.currentTarget,
          );
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        title="Click to set completion date"
      >
        <span
          className={`flex items-center justify-center px-1.5 py-[2px] rounded-sm text-[10px] font-semibold whitespace-nowrap leading-tight w-full ${
            has ? "bg-[#E0EDF0] text-[#3E6570]" : "text-[#BDB4A8] border border-dashed border-[#E6E0D9] hover:bg-[#FFF8E6]"
          }`}
        >
          {has ? fmtShortDate(row.completedDate) : "— Set —"}
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

  const deptColumns: Column<DeptRow>[] = [
    { key: "rowNo",         label: "#",              type: "number", width: "50px",  align: "right", sortable: true },
    {
      key: "soId",
      label: "SO ID",
      type: "docno",
      width: "170px",
      sortable: true,
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
        return (
          <span className="flex items-center gap-1.5 tabular-nums">
            <span className="doc-number truncate">{row.soId}</span>
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
    { key: "customerPOId",  label: "Customer PO ID", type: "docno",  width: "130px", sortable: true },
    { key: "customerRef",   label: "Customer Ref",   type: "text",   width: "120px", sortable: true },
    { key: "customerName",  label: "Customer Name",  type: "text",   width: "130px", sortable: true },
    { key: "customerState", label: "State",          type: "text",   width: "70px",  sortable: true },
    { key: "category",      label: "Category",       type: "text",   width: "90px",  sortable: true, hidden: true },
    { key: "model",         label: "Model",          type: "text",   width: "110px", sortable: true },
    { key: "wipType",       label: "Type",           type: "text",   width: "90px",  sortable: true },
    { key: "wip",           label: "WIP",            type: "text",   width: "220px", sortable: true },
    { key: "size",          label: "Size",           type: "text",   width: "70px",  sortable: true },
    { key: "colour",        label: "Colour",         type: "text",   width: "100px", sortable: true },
    { key: "gap",           label: "Gap",            type: "text",   width: "60px",  sortable: true, align: "right" },
    { key: "divan",         label: "Divan",          type: "text",   width: "70px",  sortable: true, align: "right" },
    { key: "leg",           label: "Leg",            type: "text",   width: "60px",  sortable: true, align: "right" },
    { key: "totalHeight",   label: "Total H",        type: "text",   width: "75px",  sortable: true, align: "right", hidden: true },
    { key: "qty",           label: "Qty",            type: "number", width: "60px",  sortable: true, align: "right" },
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
    // automatically. Users toggle visibility via the grid's Columns button
    // — by default we show only the upstream depts for the active tab so
    // the sheet isn't cluttered.
    ...DEPARTMENTS.map((d): Column<DeptRow> => {
      const objKey = `sched_${d.code}` as keyof DeptRow;
      const upstreams = UPSTREAM[activeTab] || [];
      const isActive = d.code === activeTab;
      const isUpstream = upstreams.includes(d.code);
      return {
        key: `${objKey}.sortKey`,
        label: d.name,
        type: "number",
        width: "140px",
        sortable: true,
        hidden: !(isActive || isUpstream),
        render: (_v, row) => renderDeptSchedCell(row[objKey] as DeptSched),
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
  ];

  const activeDept = DEPARTMENTS.find((d) => d.code === activeTab);

  // Derive a WIP/component name for a job-card sticker. Mirrors the helper
  // in production/detail.tsx — most departments produce the Divan / HB
  // component; Packing produces the FG itself.
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
  const FG_STICKER_DEPTS = useMemo(() => new Set(["UPHOLSTERY", "PACKING"]), []);
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
    for (const o of filteredOrders) {
      for (const jc of o.jobCards) {
        if (activeTab === "ALL") {
          if (FG_STICKER_DEPTS.has(jc.departmentCode)) continue;
        } else {
          if (jc.departmentCode !== activeTab) continue;
          // Respect the DataGrid's internal filter when a dept is active.
          // `gridFilterIdSet` is null only on first render before the grid
          // has reported back — in that case fall through to show all.
          if (gridFilterIdSet && !gridFilterIdSet.has(`${o.id}:${jc.id}`)) continue;
        }
        // One sticker per physical piece produced by THIS job card. The
        // piece count lives on `jc.wipQty` — computed at PO build time as
        // (BOM node.quantity × parent wipQty × SO item.quantity). A bedframe
        // SO qty=1 with BOM Divan quantity=2 → jc.wipQty=2 → two stickers,
        // even though the parent PO quantity is 1. Falling back to o.quantity
        // keeps legacy seed data (pre-BOM wipQty) working.
        //
        // Each piece carries its OWN QR payload (p=N&t=M) so the worker
        // portal can tell piece 1 from piece 2 — otherwise a double-scan of
        // the same sticker would silently credit two completions for one
        // physical piece.
        const jcWipQty = (jc as { wipQty?: number }).wipQty;
        const total = Math.max(
          1,
          Math.floor(jcWipQty || o.quantity || 0) || 1,
        );
        for (let p = 1; p <= total; p++) {
          stickers.push({
            key: `${o.id}:${jc.id}:${p}`,
            poNo: o.poNo,
            deptCode: jc.departmentCode,
            jobCardId: jc.id,
            wipName: wipNameFor(jc, o),
            wipCode: jc.wipCode,
            sizeLabel: o.sizeLabel || o.sizeCode || "",
            qty: o.quantity || 0,
            pieceNo: p,
            totalPieces: total,
            qrDataUrl: getQRCodeUrl(
              generateStickerData(
                o.poNo,
                jc.departmentCode,
                jc.id,
                "/production/scan",
                p,
                total,
              ),
              300,
            ),
          });
        }
      }
    }
    return stickers;
  }, [filteredOrders, activeTab, wipNameFor, FG_STICKER_DEPTS, gridFilterIdSet]);

  // Build + trigger batch print for job-card stickers. Fires once state is
  // rendered into the hidden container via the useEffect below.
  const handlePrintJobCardStickers = useCallback(async () => {
    if (onScreenStickers.length === 0) {
      alert(
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
          qrDataUrl: await getQRCodeDataURL(
            generateStickerData(
              s.poNo,
              s.deptCode,
              s.jobCardId,
              "/production/scan",
              s.pieceNo,
              s.totalPieces,
            ),
            300,
          ),
        })),
      );
      setFgStickers([]); // never mix modes in one print job
      setJobCardStickers(batch);
    } finally {
      setPrintingJobCards(false);
    }
  }, [onScreenStickers, activeTab]);

  // Populate `fgStickers` state without firing window.print(). Used in two
  // places: (1) auto-fired on entry to UPHOLSTERY/PACKING tabs so the preview
  // tiles render, (2) called by `handlePrintFgStickers` which then flips
  // `fgPrintRequested` to trigger the print useEffect.
  //
  // Returns the populated list (also stored in state) so callers can short-
  // circuit if nothing came back. Silent — no alerts.
  const loadFgStickers = useCallback(async (): Promise<FgSticker[]> => {
    if (filteredOrders.length === 0) {
      setFgStickers([]);
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
    const all: FgSticker[] = [];
    setLoadingFgPreview(true);
    try {
      for (const o of filteredOrders) {
        const [gRes, pRes] = await Promise.all([
          fetch(`/api/fg-units/generate/${encodeURIComponent(o.id)}`, { method: "POST" })
            .then((r) => r.json()),
          fetch(`/api/products/${encodeURIComponent(o.productId)}`)
            .then((r) => r.json()).catch(() => null),
        ]);
        const units: FGUnitMini[] = gRes?.success ? gRes.data : [];
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
            fabricCode: o.fabricCode || "",
            fabricColor: p?.fabricColor || o.fabricCode || "",
            customerName: u.customerName || o.customerName || "",
            customerHub: u.customerHub || "",
            salesOrderNo: o.salesOrderNo || o.companySOId || "",
            pieceNo: u.pieceNo,
            totalPieces: u.totalPieces,
            pieceName: u.pieceName,
            unitNo: u.unitNo,
            totalUnits: u.totalUnits,
            mfdDate: u.mfdDate,
          });
        }
      }
    } catch (err) {
      console.error("[loadFgStickers] failed", err);
      setLoadingFgPreview(false);
      return [];
    }
    setJobCardStickers([]);
    setFgStickers(all);
    setLoadingFgPreview(false);
    return all;
  }, [filteredOrders]);

  const handlePrintFgStickers = useCallback(async () => {
    if (filteredOrders.length === 0) {
      alert("No orders in the current filter.");
      return;
    }
    // If tiles already populated (auto-loaded on tab entry), print directly.
    // Otherwise fetch first, then request print.
    const list = fgStickers.length > 0 ? fgStickers : await loadFgStickers();
    if (list.length === 0) {
      alert("No FG units to print.");
      return;
    }
    setFgPrintRequested(true);
  }, [filteredOrders, fgStickers, loadFgStickers]);

  // Auto-populate the FG preview tiles when entering the UPHOLSTERY or
  // PACKING tab. Orders change (dept switch, filter tweak) retrigger the
  // load so the tiles stay in sync with what the operator is looking at.
  // Other tabs clear the list so the hidden print container doesn't carry
  // stale data into a job-card print job.
  useEffect(() => {
    if (activeTab === "UPHOLSTERY" || activeTab === "PACKING") {
      loadFgStickers();
    } else {
      setFgStickers([]);
    }
  }, [activeTab, loadFgStickers]);

  // Once the batch container is rendered, fire the print dialog. Small
  // timeout lets React paint the hidden container first; QR images are
  // external URLs but that's OK — the dialog waits for them to load.
  useEffect(() => {
    if (jobCardStickers.length === 0) return;
    const t = setTimeout(() => {
      window.print();
      // Clear after print dialog closes. onafterprint isn't universally
      // reliable; a follow-up timeout keeps state clean either way.
      setTimeout(() => setJobCardStickers([]), 500);
    }, 300);
    return () => clearTimeout(t);
  }, [jobCardStickers]);

  useEffect(() => {
    if (!fgPrintRequested) return;
    if (fgStickers.length === 0) {
      setFgPrintRequested(false);
      return;
    }
    const t = setTimeout(() => {
      window.print();
      // Don't clear fgStickers here anymore — the on-screen preview on UPH/
      // PACK tabs depends on that state. Reset just the print-requested flag.
      setTimeout(() => setFgPrintRequested(false), 500);
    }, 300);
    return () => clearTimeout(t);
  }, [fgStickers, fgPrintRequested]);

  // Print the current filtered schedule as an A4 landscape listing. Opens
  // a new window populated with inline HTML + @page size:A4 landscape so
  // the user can Cmd/Ctrl+P → Save PDF or send straight to printer. The
  // layout mirrors what's on screen: Overview → matrix across 8 depts,
  // dept sub-tab → Production Sheet rows with prev-dept pills.
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
    const filterBits: string[] = [];
    if (fltSearch) filterBits.push(`Search: "${fltSearch}"`);
    if (fltCustomer) filterBits.push(`Customer: ${fltCustomer}`);
    if (fltState) filterBits.push(`State: ${fltState}`);
    if (fltDueFrom || fltDueTo) {
      filterBits.push(`Due: ${fltDueFrom || "…"} → ${fltDueTo || "…"}`);
    }
    const filterLine = filterBits.length
      ? `<div class="filters">Filters — ${filterBits.join(" · ")}</div>`
      : "";

    const title =
      activeTab === "ALL" ? "Production Schedule — Overview" : `Production Schedule — ${activeDept?.name}`;

    const cellClass = (state: CellState) =>
      state === "done" ? "done" :
      state === "overdue" ? "overdue" :
      state === "pending" ? "pending" : "empty";

    let body = "";
    if (activeTab === "ALL") {
      // Overview matrix: one row per filtered order × 8 dept columns.
      const rowsHtml = visibleOrders.map((o) => {
        const cells = DEPARTMENTS.map((d) => {
          const c = cellFor(o, d.code);
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
    } else {
      // Dept sub-tab: print template mirrors the on-screen Production Sheet
      // columns 1:1 so the operator sees the same data on paper. Trimmed to
      // fit A4 landscape without overflow.
      // Respect the DataGrid's internal filter state — if the user filtered
      // down to 18 of 457 rows, print those 18, not all 457.
      const printRows = gridFilterIdSet
        ? deptRows.filter((r) => gridFilterIdSet.has(r.id))
        : deptRows;
      const rowsHtml = printRows.map((r) => {
        return `<tr>
          <td class="num">${r.rowNo}</td>
          <td class="so">${r.soId}</td>
          <td>${r.customerPOId || ""}</td>
          <td>${r.customerRef || ""}</td>
          <td>${r.customerName}</td>
          <td>${r.customerState}</td>
          <td><b>${r.model}</b></td>
          <td>${r.wip}</td>
          <td>${r.size}</td>
          <td>${r.colour}</td>
          <td class="num">${r.gap || ""}</td>
          <td class="num">${r.divan || ""}</td>
          <td class="num">${r.leg || ""}</td>
          <td class="num">${r.qty || ""}</td>
          <td>${fmt(r.dueDate)}</td>
          <td>${r.status || ""}</td>
        </tr>`;
      }).join("");
      body = `
        <table class="schedule">
          <thead>
            <tr>
              <th class="num">#</th>
              <th>SO ID</th>
              <th>Customer PO ID</th>
              <th>Customer Ref</th>
              <th>Customer Name</th>
              <th>State</th>
              <th>Model</th>
              <th>WIP</th>
              <th>Size</th>
              <th>Colour</th>
              <th class="num">Gap</th>
              <th class="num">Divan</th>
              <th class="num">Leg</th>
              <th class="num">Qty</th>
              <th>Due</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>`;
    }

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
    table.schedule td.m, table.schedule th.m {
      text-align: center; width: 55px; padding: 2px;
    }
    table.schedule td.so { font-weight: 700; white-space: nowrap; }
    table.schedule td.prod small,
    table.schedule tbody small { color: #555; font-size: 6.5px; }
    td.m.done    { background: #fff; color: #000; font-weight: 700; }
    td.m.pending { background: #fff; color: #000; font-style: italic; }
    td.m.overdue { background: #fff; color: #000; font-weight: 700; text-decoration: underline; }
    td.m.empty   { background: #fff; }
    tr { page-break-inside: avoid; }
    thead { display: table-header-group; }
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
      <div>Generated: ${today} · ${rowCount} item(s)</div>
    </div>
  </div>
  ${filterLine}
  ${body}
  <div class="footer">Hookka ERP — Production Schedule · Printed ${today}</div>
  <script>setTimeout(function(){ window.print(); }, 300);</${''}script>
</body>
</html>`;

    const w = window.open("", "_blank", "width=1200,height=800");
    if (!w) return;
    w.document.open();
    w.document.write(html);
    w.document.close();
  }, [
    activeTab, activeDept, visibleOrders, deptRows, filteredOrders.length,
    fltSearch, fltCustomer, fltState, fltDueFrom, fltDueTo, gridFilterIdSet,
  ]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#6B5C32] border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
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
          <Button variant="outline" onClick={handlePrintSchedule}>Print Schedule</Button>
          {/* UPHOLSTERY & PACKING scan the finished good, not job cards. Keep
              the FG sticker entry point for those depts only; the QR Stickers
              section below handles job-card printing for all others via its
              own "Print All" button. */}
          {(activeTab === "UPHOLSTERY" || activeTab === "PACKING") && (
            <Button variant="outline" onClick={handlePrintFgStickers}>Print FG Stickers</Button>
          )}
        </div>
      </div>

      {/* Filter bar — applies to Overview matrix AND all dept sub-tabs */}
      <div className="rounded-lg border border-[#E6E0D9] bg-white p-3 flex flex-wrap gap-2 items-center">
        <input
          type="text"
          placeholder="Search SO / customer / model / fabric…"
          value={fltSearch}
          onChange={(e) => setFltSearch(e.target.value)}
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
        {/* Lifecycle status filter — default "Active" hides ON_HOLD + CANCELLED */}
        <select
          value={fltLifecycle}
          onChange={(e) =>
            setFltLifecycle(
              e.target.value as
                | "active" | "all" | "onhold" | "cancelled" | "completed",
            )
          }
          className="text-xs px-2 py-1.5 border border-[#E6E0D9] rounded bg-white"
          title="Production order lifecycle filter"
        >
          <option value="active">Active</option>
          <option value="all">All</option>
          <option value="onhold">On Hold</option>
          <option value="cancelled">Cancelled</option>
          <option value="completed">Completed</option>
        </select>
        <label className="text-[10px] text-[#6B7280]">Due from</label>
        <input
          type="date"
          value={fltDueFrom}
          onChange={(e) => setFltDueFrom(e.target.value)}
          className="text-xs px-2 py-1.5 border border-[#E6E0D9] rounded"
        />
        <label className="text-[10px] text-[#6B7280]">to</label>
        <input
          type="date"
          value={fltDueTo}
          onChange={(e) => setFltDueTo(e.target.value)}
          className="text-xs px-2 py-1.5 border border-[#E6E0D9] rounded"
        />
        {(fltSearch || fltState || fltCustomer || fltDueFrom || fltDueTo || fltLifecycle !== "active") && (
          <button
            onClick={() => {
              setFltSearch(""); setFltState(""); setFltCustomer("");
              setFltDueFrom(""); setFltDueTo(""); setFltLifecycle("active");
            }}
            className="text-[10px] text-[#6B5C32] hover:underline"
          >
            Clear all
          </button>
        )}
        <span className="ml-auto text-[10px] text-[#8A7F73]">
          {filteredOrders.length} of {orders.length} orders
        </span>
      </div>

      {/* Tab bar: Overview + 8 depts, all equal width (grid-cols-9) */}
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
              <span className="ml-2 text-xs font-normal text-[#8A7F73]">({deptRows.length} items)</span>
            </h2>
          </div>
          <DataGrid<DeptRow>
            key={`dept-grid-${activeDept.code}`}
            columns={deptColumns}
            data={deptRows}
            keyField="id"
            stickyHeader
            maxHeight="calc(100vh - 300px)"
            emptyMessage={`No job cards in ${activeDept.name}.`}
            onDoubleClick={(row) => navigate(`/production/${row.poId}`)}
            gridId={`production-dept-${activeDept.code.toLowerCase()}`}
            onFilteredDataChange={setGridFilteredDeptRows}
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
        </div>
      )}

      {/* Overview matrix grid (only shown when Overview tab is active) */}
      {activeTab === "ALL" && (
      <div className="rounded-lg border border-[#E6E0D9] bg-white overflow-hidden">
        {/* Header row */}
        <div
          className="grid text-[10px] font-semibold uppercase tracking-wider text-[#6B7280] bg-[#FAF8F4] border-b border-[#E6E0D9]"
          style={{ gridTemplateColumns: "120px minmax(220px,1.4fr) 110px 50px 70px repeat(8,minmax(0,1fr))" }}
        >
          <div className="px-3 py-2.5">SO ID</div>
          <div className="px-3 py-2.5">Product</div>
          <div className="px-3 py-2.5">Customer</div>
          <div className="px-2 py-2.5 text-center">Qty</div>
          <div className="px-2 py-2.5">Due</div>
          {DEPARTMENTS.map((d) => (
            <div
              key={d.code}
              className={`px-1 py-2.5 text-center border-l border-[#E6E0D9] truncate`}
            >
              {d.name}
            </div>
          ))}
        </div>

        {/* Body rows */}
        {visibleOrders.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-[#9A918A]">
            No production orders found.
          </div>
        ) : (
          visibleOrders.map((order) => {
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
              className={`grid items-stretch border-b border-[#F0EBE3] last:border-b-0 cursor-pointer ${rowCls}`}
              style={{ gridTemplateColumns: "120px minmax(220px,1.4fr) 110px 50px 70px repeat(8,minmax(0,1fr))" }}
              onDoubleClick={() => navigate(`/production/${order.id}`)}
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
              <div className="px-2 py-1.5 text-xs text-center text-[#6B7280] flex items-center justify-center">{order.quantity}</div>
              <div
                className="px-2 py-1.5 text-[11px] text-[#6B7280] flex items-center cursor-pointer hover:text-[#6B5C32] hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  openDatePicker(
                    order.targetEndDate || "",
                    (v) => {
                      if (!v) return;
                      setOrders((prev) =>
                        prev.map((o) => o.id === order.id ? { ...o, targetEndDate: v } : o)
                      );
                      fetch(`/api/production-orders/${order.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ targetEndDate: v }),
                      }).catch(() => {});
                    },
                    e.currentTarget,
                  );
                }}
                title="Click to change due date"
              >{fmtShortDate(order.targetEndDate)}</div>
              {DEPARTMENTS.map((d) => {
                const c = cellFor(order, d.code);
                const isActiveCol = false; // inside ALL view, no column highlighted
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
                      const deptCards = order.jobCards.filter(
                        (j) => j.departmentCode === d.code,
                      );
                      for (const jc of deptCards) {
                        patchJobCard(order.id, jc.id, { dueDate: v });
                      }
                    },
                    anchor,
                  );
                };
                return (
                  <div
                    key={d.code}
                    className={`relative border-l border-[#F0EBE3] min-h-[34px] ${isActiveCol ? "bg-[#FAF8F4]" : ""} ${c.state !== "empty" ? "cursor-pointer" : ""}`}
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
          })
        )}

        {/* Footer */}
        <div className="px-4 py-2 bg-[#FAF8F4] border-t border-[#E6E0D9] text-[10px] text-[#8A7F73] flex items-center justify-between">
          <span>{visibleOrders.length} of {orders.length} work orders</span>
          <span>{overallDone}/{overallTotal} cells complete</span>
        </div>
      </div>
      )}

      {/* On-screen QR tile row — mirrors the print stickers but always
          visible. Shown only on FAB_CUT/FAB_SEW/FOAM/WOOD_CUT/FRAMING/WEBBING
          dept tabs (job-card sticker depts). HIDDEN on:
            - Overview (ALL) — dashboard, not a print area
            - UPHOLSTERY / PACKING — those depts use FG stickers instead,
              rendered in the FG preview block below.
          Horizontally scrollable so the row stays one line regardless of count. */}
      {activeTab !== "ALL" && activeTab !== "UPHOLSTERY" && activeTab !== "PACKING" && (
      <div className="rounded-lg border border-[#E6E0D9] bg-white">
        <div className="px-4 py-2.5 border-b border-[#E6E0D9] bg-[#FAF8F4] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#6B5C32]" />
            <h2 className="text-sm font-semibold text-[#1F1D1B]">
              QR Stickers
              <span className="ml-2 text-xs font-normal text-[#8A7F73]">
                ({onScreenStickers.length} piece{onScreenStickers.length === 1 ? "" : "s"} in {activeDept?.name || activeTab})
              </span>
            </h2>
          </div>
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
        {onScreenStickers.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-[#9A918A]">
            No job cards match the current filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className="flex gap-3 p-3 min-w-min">
              {onScreenStickers.map((s) => (
                <div
                  key={s.key}
                  className="flex-shrink-0 border border-[#E6E0D9] rounded-md bg-white flex flex-col items-center p-2"
                  style={{ width: "130px" }}
                  title={`${s.wipName} — ${s.poNo} · ${s.deptCode} · ${s.sizeLabel} · Qty ${s.qty}`}
                >
                  <img
                    src={s.qrDataUrl}
                    alt="Job card QR"
                    style={{ width: "100px", height: "100px" }}
                  />
                  <div
                    className="mt-1.5 font-bold text-center leading-tight w-full truncate"
                    style={{ fontSize: "10px" }}
                  >
                    {s.wipName}
                  </div>
                  {s.wipCode && (
                    <div
                      className="text-center leading-tight w-full font-mono text-[#6B5C32] truncate"
                      style={{ fontSize: "9px" }}
                    >
                      {s.wipCode}
                    </div>
                  )}
                  <div
                    className="text-center leading-tight w-full text-[#6B7280]"
                    style={{ fontSize: "9px" }}
                  >
                    <div className="font-semibold text-[#1F1D1B] tabular-nums">
                      {s.poNo}
                    </div>
                    <div className="truncate">
                      {s.deptCode} · {s.sizeLabel}
                    </div>
                    <div>
                      {s.totalPieces > 1
                        ? `Piece ${s.pieceNo}/${s.totalPieces}`
                        : `Qty ${s.qty}`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      )}

      {/* FG Sticker preview — shown only on UPHOLSTERY / PACKING tabs. Each
          tile mirrors the 100×150 mm print layout (SKU, size, fabric color,
          PO no, customer, MFD, 100×100 QR, piece N/M, short code) but sized
          for screen. Auto-populated on tab entry via the useEffect that
          calls loadFgStickers. Horizontally scrollable — same card width
          pattern as the QR tiles. */}
      {(activeTab === "UPHOLSTERY" || activeTab === "PACKING") && (
        <div className="rounded-lg border border-[#E6E0D9] bg-white">
          <div className="px-4 py-2.5 border-b border-[#E6E0D9] bg-[#FAF8F4] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-[#6B5C32]" />
              <h2 className="text-sm font-semibold text-[#1F1D1B]">
                FG Sticker Preview
                <span className="ml-2 text-xs font-normal text-[#8A7F73]">
                  ({fgStickers.length} unit{fgStickers.length === 1 ? "" : "s"} in {activeDept?.name || activeTab})
                </span>
              </h2>
            </div>
          </div>
          {loadingFgPreview ? (
            <div className="px-4 py-8 text-center text-xs text-[#9A918A]">
              Loading FG units…
            </div>
          ) : fgStickers.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-[#9A918A]">
              No FG units for the current filter. FG units are generated when an
              order reaches this department.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="flex gap-3 p-3 min-w-min">
                {fgStickers.map((s) => {
                  const origin =
                    typeof window !== "undefined" && window.location?.origin
                      ? window.location.origin
                      : "";
                  const trackUrl = `${origin}/track?s=${encodeURIComponent(s.unitSerial)}`;
                  const mfd = (() => {
                    if (!s.mfdDate) return "-";
                    const d = new Date(s.mfdDate);
                    if (Number.isNaN(d.getTime())) return s.mfdDate.slice(0, 10);
                    const yy = String(d.getFullYear()).slice(-2);
                    const mm = String(d.getMonth() + 1).padStart(2, "0");
                    const dd = String(d.getDate()).padStart(2, "0");
                    return `${yy}-${mm}-${dd}`;
                  })();
                  const customerLine = s.customerHub
                    ? `${s.customerName} (${s.customerHub})`
                    : s.customerName;
                  return (
                    <div
                      key={s.key}
                      className="flex-shrink-0 border border-[#E6E0D9] rounded-md bg-white flex flex-col p-2"
                      style={{ width: "230px" }}
                      title={`${s.sku} — ${s.poNo} · ${s.sizeLabel} · piece ${s.pieceNo} of ${s.totalPieces}`}
                    >
                      <div className="text-center font-bold leading-tight" style={{ fontSize: "11px" }}>
                        {s.sku}
                      </div>
                      <div className="border-t border-[#E6E0D9] my-1" />
                      <div className="space-y-[2px] text-[9px] leading-tight text-[#1F1D1B]">
                        <div><span className="inline-block w-[52px] font-semibold text-[#6B7280]">SIZE</span>: {s.sizeLabel}</div>
                        <div className="truncate"><span className="inline-block w-[52px] font-semibold text-[#6B7280]">COLOR</span>: {s.fabricColor || "-"}</div>
                        <div className="truncate"><span className="inline-block w-[52px] font-semibold text-[#6B7280]">PO NO</span>: {s.poNo}</div>
                        <div className="truncate"><span className="inline-block w-[52px] font-semibold text-[#6B7280]">CUST</span>: {customerLine}</div>
                        <div><span className="inline-block w-[52px] font-semibold text-[#6B7280]">MFD</span>: {mfd}</div>
                      </div>
                      <div className="flex items-end gap-2 mt-2">
                        <img
                          src={getQRCodeUrl(trackUrl, 300)}
                          alt="FG unit QR"
                          style={{ width: "100px", height: "100px" }}
                        />
                        <div className="flex-1 text-center">
                          <div className="font-bold leading-tight" style={{ fontSize: "13px" }}>
                            {s.pieceNo}/{s.totalPieces}
                          </div>
                          <div className="leading-tight truncate" style={{ fontSize: "8px" }}>
                            {s.pieceName}
                          </div>
                          <div className="font-semibold mt-1 leading-tight" style={{ fontSize: "10px" }}>
                            {s.shortCode}
                          </div>
                          <div className="text-[#6B7280] mt-0.5 leading-tight" style={{ fontSize: "8px" }}>
                            Unit {s.unitNo}/{s.totalUnits}
                          </div>
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
          coords and pin the popup to the corner of the viewport. */}
      <input
        ref={sharedDateInputRef}
        type="date"
        onChange={(e) => sharedDateChangeRef.current(e.target.value)}
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "none",
        }}
        tabIndex={-1}
        aria-hidden
      />

      {/* Batch Job Card stickers — one 50×75mm page per job card across all
          currently filtered orders. Hidden on screen; the @media print block
          swaps visibility so only the container is shown when printing. */}
      {jobCardStickers.length > 0 && (
        <>
          <style>{`
            @media print {
              @page { size: 50mm 75mm; margin: 0; }
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
                width: 50mm !important;
                margin: 0 !important; padding: 0 !important;
              }
              .sticker-jc-page {
                width: 50mm !important; height: 75mm !important;
                page-break-after: always;
                break-after: page;
                margin: 0 !important; padding: 2mm !important;
                overflow: hidden;
              }
              .sticker-jc-page:last-child {
                page-break-after: auto;
                break-after: auto;
              }
            }
          `}</style>
          <div id="batch-jobcard-print" className="hidden print:block">
            {jobCardStickers.map((s) => (
              <div
                key={s.key}
                className="sticker-jc-page bg-white text-black flex flex-col items-center justify-between"
                style={{ width: "50mm", height: "75mm" }}
              >
                <img
                  src={s.qrDataUrl}
                  alt="Job card QR"
                  style={{ width: "34mm", height: "34mm" }}
                />
                <div
                  className="font-bold text-center leading-tight w-full"
                  style={{ fontSize: "9pt" }}
                >
                  {s.wipName}
                </div>
                {s.wipCode && (
                  <div
                    className="text-center leading-tight w-full font-mono"
                    style={{ fontSize: "7pt" }}
                  >
                    {s.wipCode}
                  </div>
                )}
                <div
                  className="text-center leading-tight w-full"
                  style={{ fontSize: "7pt" }}
                >
                  <div className="font-semibold">{s.poNo}</div>
                  <div>
                    {s.deptCode} · {s.sizeLabel}
                  </div>
                  <div className="font-semibold">
                    {s.totalPieces > 1
                      ? `Piece ${s.pieceNo} of ${s.totalPieces}`
                      : `Qty ${s.qty}`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Batch FG stickers — one 100×150mm page per filtered PO. */}
      {fgStickers.length > 0 && (
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
          <div id="batch-fg-print" className="hidden print:block">
            {fgStickers.map((s) => {
              const origin =
                typeof window !== "undefined" && window.location?.origin
                  ? window.location.origin
                  : "";
              const trackUrl = `${origin}/track?s=${encodeURIComponent(s.unitSerial)}`;
              const mfd = (() => {
                if (!s.mfdDate) return "-";
                const d = new Date(s.mfdDate);
                if (Number.isNaN(d.getTime())) return s.mfdDate.slice(0, 10);
                const yy = String(d.getFullYear()).slice(-2);
                const mm = String(d.getMonth() + 1).padStart(2, "0");
                const dd = String(d.getDate()).padStart(2, "0");
                return `${yy}-${mm}-${dd}`;
              })();
              const customerLine = s.customerHub ? `${s.customerName} (${s.customerHub})` : s.customerName;
              return (
                <div
                  key={s.key}
                  className="sticker-fg-page bg-white text-black"
                  style={{ width: "100mm", height: "150mm" }}
                >
                  <div className="w-full h-full flex flex-col" style={{ fontSize: "9pt" }}>
                    <div className="text-center font-bold" style={{ fontSize: "13pt", lineHeight: 1.1 }}>
                      {s.sku}
                    </div>
                    <div className="border-t border-black my-[1.5mm]" />
                    <div className="flex-1 space-y-[0.6mm]" style={{ fontSize: "9pt", lineHeight: 1.25 }}>
                      <div><span className="inline-block w-[22mm] font-semibold">SIZE</span>: {s.sizeLabel}</div>
                      <div><span className="inline-block w-[22mm] font-semibold">COLOR</span>: {s.fabricColor || "-"}</div>
                      <div><span className="inline-block w-[22mm] font-semibold">PO NO</span>: {s.poNo}</div>
                      <div><span className="inline-block w-[22mm] font-semibold">CUSTOMER</span>: {customerLine}</div>
                      <div><span className="inline-block w-[22mm] font-semibold">MFD</span>: {mfd}</div>
                    </div>
                    <div className="flex items-end gap-[2mm] mt-[1mm]">
                      <img
                        src={getQRCodeUrl(trackUrl, 500)}
                        alt="FG unit QR"
                        style={{ width: "42mm", height: "42mm" }}
                      />
                      <div className="flex-1 text-center">
                        <div className="font-bold" style={{ fontSize: "14pt" }}>
                          {s.pieceNo} of {s.totalPieces}
                        </div>
                        <div className="text-[8pt] mt-[1mm]">{s.pieceName}</div>
                        <div className="font-semibold mt-[2mm]" style={{ fontSize: "11pt" }}>
                          {s.shortCode}
                        </div>
                        <div className="text-[7pt] text-[#4B5563] mt-[1mm]">
                          Unit {s.unitNo}/{s.totalUnits}
                        </div>
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
    </div>
  );
}
