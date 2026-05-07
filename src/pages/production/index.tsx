import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useUrlState, useUrlBatch } from "@/lib/use-url-state";
import { useSessionState } from "@/lib/use-session-state";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Plus, Lock, ExternalLink } from "lucide-react";
import { DataGrid } from "@/components/ui/data-grid";
import type { Column, ContextMenuItem } from "@/components/ui/data-grid";
import { getQRCodeDataURL, generateStickerData } from "@/lib/qr-utils";
import { QRImg } from "@/components/qr-img";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
// useTimeout — P4.3 effect-replacement (still referenced at L2386+).
import { useTimeout } from "@/lib/scheduler";
import { useToast } from "@/components/ui/toast";
import { getCurrentUser } from "@/lib/auth";

import type { CellState, JobCard, ProductionOrder, Worker } from "./types";
import { DEPARTMENTS, cellFor, fmtShortDate, todayISO } from "./utils";
import { CellBox } from "./components/CellBox";
import { ProductDetailLine } from "./components/ProductDetailLine";
import { CreateStockPODialog } from "./components/CreateStockPODialog";

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
  const { data: workersResp } = useCachedJson<{ success?: boolean; data?: Worker[] }>("/api/workers");
  const { data: warehouseResp } = useCachedJson<{ success?: boolean; data?: Array<{ rack: string; status: string; productCode?: string; customerName?: string }> }>("/api/warehouse");
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  // When mounted at /production/<code>, lock activeTab to that dept code
  // immediately so the first render skips the Overview matrix. overview.tsx
  // leaves it at ALL. The plain /production mount (mode=full) also starts
  // on ALL, matching legacy behavior.
  const initialTab = mode === "dept" && deptCode ? deptCode : "ALL";
  const [activeTab, setActiveTabRaw] = useState<"ALL" | string>(initialTab);
  // Keep activeTab in sync with the deptCode prop when navigating between
  // sibling dept routes (React Router reuses the component instance on
  // /production/fab-cut → /production/fab-sew transitions).
  /* eslint-disable react-hooks/set-state-in-effect -- syncing activeTab to URL deptCode on route change */
  useEffect(() => {
    if (mode === "dept" && deptCode && deptCode !== activeTab) {
      setActiveTabRaw(deptCode);
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
      if (typeof el.showPicker === "function") {
        try { el.showPicker(); return; } catch { /* showPicker not supported — fall through to focus/click */ }
      }
      el.focus();
      el.click();
    },
    [],
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
  // dueQueryFrag/baseUrl/ordersResp moved here from earlier in the file
  // to satisfy the TDZ for fltDueFrom/fltDueTo (declared just above).
  const dueQueryFrag =
    (fltDueFrom ? `&dueFrom=${encodeURIComponent(fltDueFrom)}` : "") +
    (fltDueTo ? `&dueTo=${encodeURIComponent(fltDueTo)}` : "");
  const baseUrl =
    mode === "dept" && deptCode
      ? `/api/production-orders?fields=minimal&dept=${encodeURIComponent(deptCode)}${dueQueryFrag}`
      : `/api/production-orders?fields=minimal${dueQueryFrag}`;
  const ordersUrl: string | null = shouldFetch ? baseUrl : null;
  const { data: ordersResp, loading, refresh: refreshOrders } = useCachedJson<{ success?: boolean; data?: ProductionOrder[] }>(ordersUrl);
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
  //   • Item type — substring match on each PO's job-card wipType
  //     (HB→HEADBOARD, DIVAN, BASE→SOFA_BASE, CUSHION→SOFA_CUSHION, etc.).
  //   • Model — exact productCode match, drawn from already-loaded orders.
  const [fltCategory, setFltCategory] = useUrlState<string>("cat", "");
  // Date-axis dropdown removed 2026-05-07 — fltDateAxis is now a constant
  // 'dueDate'. The state hook stays so the filter logic conditional below
  // still resolves correctly without a deeper refactor.
  const [fltDateAxis] =
    useUrlState<"dueDate" | "customerDeliveryDate" | "created_at">("axis", "dueDate");
  const [fltItemType, setFltItemType] = useUrlState<string>("itype", "");
  const [fltModel, setFltModel] = useUrlState<string>("model", "");
  // Hide CANCELLED POs by default (2026-05-06 user request — they were
  // showing as strikethrough rows that cluttered the daily view). Toggle
  // via ?showCancelled=1 in the URL when needed.
  const [showCancelled] = useUrlState<string>("showCancelled", "");
  // Atomic multi-key URL writer for "Clear all". Sequential useUrlState
  // setters race under React 18 batching — see useUrlBatch jsdoc.
  const setUrlBatch = useUrlBatch();

  // First-mount seed: when both date params are blank, narrow to today
  // so the operator lands on the daily slice. Atomic write via
  // useUrlBatch dodges the React 18 batching race that two sequential
  // setSearchParams hit (and that previously caused a freeze — see
  // useUrlBatch jsdoc). Once the user clears or changes either field,
  // the URL holds a real value and this branch never re-fires.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot URL-seed on first mount only
  useEffect(() => {
    if (!fltDueFrom && !fltDueTo) {
      const today = todayISO();
      setUrlBatch({ from: today, to: today });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Overview-matrix-only sort. The dept-tab Production Sheet has DataGrid's
  // built-in sort; this state drives the Overview "Due" header click-to-sort.
  // null = original order; "asc"/"desc" = sorted by targetEndDate.
  const [overviewDueSort, setOverviewDueSort] = useState<"asc" | "desc" | null>(null);

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
    !!fltItemType ||
    !!fltModel;
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
  // QR preview sections (Job Card strip + FG Sticker preview) are collapsed
  // by default because mounting 100-1000 <QRImg> tiles on every tab change
  // was making the Production page feel laggy — even with lazy-generation
  // via IntersectionObserver, the React commit for that many components
  // is a noticeable hitch. Users who want to print or scan open the
  // section explicitly.
  const [showQRStrip, setShowQRStrip] = useState(false);
  const [_showFgPreview, setShowFgPreview] = useState(false);
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
  // Throttle: only fire if it's been >30s since the last fetch AND no
  // optimistic PATCH is in-flight. The latter prevents the classic race
  // where the user edits a PIC, glances at another tab, comes back, and
  // the visibility refetch lands BEFORE the PATCH commits — wiping the
  // edit they just made.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (pendingJcPatchesRef.current.size > 0) return;
      if (Date.now() - lastFetchAtRef.current < 30_000) return;
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
    if (pending.size === 0) {
      setOrders(fresh);
      return;
    }
    // Splice the optimistic JC version back over the server snapshot so the
    // PATCH-in-flight value the user can see survives the refetch.
    setOrders((prev) => {
      const prevJcMap = new Map<string, JobCard>();
      for (const po of prev) {
        for (const jc of po.jobCards) {
          if (pending.has(jc.id)) prevJcMap.set(jc.id, jc);
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
      pendingJcPatchesRef.current.add(jobCardId);
      try {
        const res = await fetch(`/api/production-orders/${poId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobCardId, ...patch }),
        });
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try {
            const body = (await res.json()) as { error?: string } | null;
            if (body && typeof body.error === "string") msg = body.error;
          } catch { /* non-json body — keep status code */ }
          throw new Error(msg);
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : "network error";
        console.error("[patchJobCard]", detail);
        toast.error(`Save failed (${detail}). Refresh and retry.`);
      } finally {
        pendingJcPatchesRef.current.delete(jobCardId);
      }
    },
    [toast],
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
      // No invalidation — optimistic setOrders already reflects the rack change.
      fetch(`/api/production-orders/${poId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobCardId, rackingNumber: rack }),
      }).catch((err) => console.error("[patchRack] network error", err));
    },
    [],
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

  // Sprint 5 F3: pre-compute the set of WIP item-type flags present on
  // each PO's job cards. Filter checks become Set.has() instead of
  // jcs.some(j => predicate(j.wipType.toUpperCase())) per row per render.
  const itemTypesByPo = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const o of orders) {
      const flags = new Set<string>();
      for (const j of o.jobCards ?? []) {
        const t = String(j.wipType || "").toUpperCase();
        if (t === "HEADBOARD" || t === "HB") flags.add("HB");
        if (t === "DIVAN") flags.add("DIVAN");
        if (t.endsWith("BASE")) flags.add("BASE");
        if (t.endsWith("CUSHION")) flags.add("CUSHION");
        if (t.endsWith("ARMREST")) flags.add("ARMREST");
        if (t.endsWith("HEADREST")) flags.add("HEADREST");
      }
      m.set(o.id, flags);
    }
    return m;
  }, [orders]);

  // Apply the page-level filter panel to `orders` first, then scope further
  // by active tab (Overview = everything; dept tab = only orders that have
  // a non-empty cell in that dept).
  const filteredOrders = useMemo(() => {
    const q = fltSearch.trim().toLowerCase();
    return orders.filter((o) => {
      if (q) {
        const hay = haystackByPo.get(o.id) || "";
        if (!hay.includes(q)) return false;
      }
      if (fltState && o.customerState !== fltState) return false;
      if (fltCustomer && o.customerName !== fltCustomer) return false;
      // Category — itemCategory column on the PO.
      if (fltCategory && o.itemCategory !== fltCategory) return false;
      // Model — exact productCode match.
      if (fltModel && o.productCode !== fltModel) return false;
      // Item Type — at least one JC on the PO must match. POs with no JCs
      // (legacy / partially-built) bypass this filter rather than getting
      // hidden, since we can't tell what they are.
      if (fltItemType) {
        const flags = itemTypesByPo.get(o.id);
        const jcs = o.jobCards ?? [];
        if (flags && jcs.length > 0 && !flags.has(fltItemType)) return false;
      }
      // Date range against the user-chosen axis. Falls back to targetEndDate
      // when customerDeliveryDate isn't on the payload (TODO near the state
      // declaration). Empty axis values DO NOT filter the row out — that
      // prevents POs with missing dates from disappearing the moment a
      // from-date is set. Previous bug: `"" < fltDueFrom` was always true
      // so undated POs got dropped silently as soon as any from-date was
      // entered.
      const axisVal: string =
        (fltDateAxis === "dueDate"
          ? o.targetEndDate
          : fltDateAxis === "customerDeliveryDate"
            ? (o.customerDeliveryDate || "")
            : (o.createdAt || "")) || "";
      if (fltDueFrom && axisVal && axisVal < fltDueFrom) return false;
      if (fltDueTo && axisVal && axisVal > fltDueTo) return false;
      // Hide CANCELLED POs unless explicitly opted in via ?showCancelled=1.
      if (!showCancelled && o.status === "CANCELLED") return false;
      // (Lifecycle filter removed 2026-04-27 — moved to per-column Status
      // filter on the grid. ON_HOLD / COMPLETED rows still get the colored
      // row background via rowClassName so they stay visually distinct in
      // the unfiltered view.)
      return true;
    });
  }, [
    orders, haystackByPo, itemTypesByPo,
    fltSearch, fltState, fltCustomer,
    fltDueFrom, fltDueTo, fltDateAxis,
    fltCategory, fltItemType, fltModel,
    showCancelled,
  ]);

  const visibleOrders = useMemo(() => {
    let rows = filteredOrders;
    if (activeTab !== "ALL") {
      rows = rows.filter(
        (o) => cellFor(o, activeTab, filteredOrders).state !== "empty",
      );
    }
    // Overview-only Due sort. Empty due dates park at the end regardless
    // of direction so undated rows don't dominate ascending order.
    if (activeTab === "ALL" && overviewDueSort) {
      const dir = overviewDueSort === "asc" ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const av = a.targetEndDate || "";
        const bv = b.targetEndDate || "";
        if (!av && !bv) return 0;
        if (!av) return 1;
        if (!bv) return -1;
        return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
      });
    }
    return rows;
  }, [filteredOrders, activeTab, overviewDueSort]);

  // Unique customer + state + model options for the filter dropdowns,
  // derived live from the order set so they auto-update when data changes.
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
  const modelOptions = useMemo(
    () =>
      Array.from(new Set(orders.map((o) => o.productCode).filter(Boolean))).sort(),
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
              for (const sib of filteredOrders) {
                if (sib.id === o.id) continue;
                const sibGroupId =
                  sib.companySOId ||
                  sib.salesOrderId ||
                  sib.companyCOId ||
                  sib.consignmentOrderId ||
                  "";
                if (sibGroupId !== myGroupId) continue;
                // SOFA must also match baseModel + fabric since multiple
                // sofa products can coexist in one parent doc.
                if (isSofa) {
                  if ((sib.fabricCode || "") !== myFabric) continue;
                  const sibBase = (sib.productCode || "").split("-")[0];
                  if (sibBase !== myBase) continue;
                }
                const sibJc = sib.jobCards.find((j) => j.departmentCode === code);
                if (sibJc) return sibJc;
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
  const deptColumns: Column<DeptRow>[] = useMemo(() => [
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
    { key: "customerPOId",  label: "Customer PO ID", type: "docno",  width: "130px", sortable: true },
    { key: "customerRef",   label: "Customer Ref",   type: "text",   width: "120px", sortable: true },
    { key: "customerName",  label: "Customer Name",  type: "text",   width: "130px", sortable: true },
    { key: "customerState", label: "State",          type: "text",   width: "70px",  sortable: true },
    { key: "category",      label: "Category",       type: "text",   width: "90px",  sortable: true },
    { key: "model",         label: "Model",          type: "text",   width: "110px", sortable: true },
    // Type column (HEADBOARD / DIVAN / BASE / CUSHION / ARMREST / etc.) —
    // post Option C the FAB_CUT merge collapses multiple piece types into
    // one row so the anchor's wipType is misleading on a merged row.
    // Hide by default on FAB_CUT tab; other dept tabs keep it visible
    // since each row is still per-piece for them. Wei Siang explicitly
    // asked to hide on Fab Cut: "type 的话你可能需要换掉了。要不然我们就直接
    // hide 起来吧".
    { key: "wipType",       label: "Type",           type: "text",   width: "90px",  sortable: true, defaultHidden: activeTab === "FAB_CUT" },
    { key: "wip",           label: "WIP",            type: "text",   width: "220px", sortable: true },
    { key: "size",          label: "Size",           type: "text",   width: "70px",  sortable: true },
    { key: "colour",        label: "Colour",         type: "text",   width: "100px", sortable: true },
    { key: "gap",           label: "Gap",            type: "text",   width: "60px",  sortable: true, align: "right" },
    { key: "divan",         label: "Divan",          type: "text",   width: "70px",  sortable: true, align: "right" },
    { key: "leg",           label: "Leg",            type: "text",   width: "60px",  sortable: true, align: "right" },
    { key: "totalHeight",   label: "Total H",        type: "text",   width: "75px",  sortable: true, align: "right" },
    { key: "specialOrder",  label: "Special Order",  type: "text",   width: "130px", sortable: true },
    { key: "qty",           label: "Qty",            type: "number", width: "60px",  sortable: true, align: "right" },
    // Per-row production minutes — supervisors use this as a capacity /
    // time-budget read. On FAB_CUT the merged row sums across all
    // components (Base + Cushion + Arm cut together) so the number
    // reflects the actual lay-down time, not any single component.
    { key: "prodTime",      label: "Prod Time (min)", type: "number", width: "100px", sortable: true, align: "right" },
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
        filterAccessor: (row) => {
          const s = row[objKey] as DeptSched;
          switch (s.state) {
            case "overdue": return "Overdue";
            case "pending": return "Pending";
            case "done":    return "Done";
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
  ], [activeTab, upstreamDepts]);

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
              model: o.productCode || "",
              wipType: (jc as { wipType?: string }).wipType || "",
              category: o.itemCategory || "",
              colour: o.fabricCode || "",
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
      // Each JC gets its own sticker — no FG-FAB_CUT sentinel anymore.
      // Operators scan once per JC, going through the standard
      // scan-complete flow (scan-complete-dept fan-out is dead).
      const opId = row.jobCardId;
      // qty > 1 fans the row into N physical piece stickers, each with
      // its own p=N&t=M marker so the worker portal can reject double-
      // scans. qty=1 stays single-sticker.
      const pieceCount = Math.max(1, row.qty || 1);
      for (let p = 1; p <= pieceCount; p++) {
        stickers.push({
          key: pieceCount > 1 ? `${row.id}:${p}` : row.id,
          poNo: order.poNo,
          deptCode: activeTab,
          jobCardId: opId,
          wipName: row.wip,
          wipCode: "",
          sizeLabel: row.size || "",
          qty: pieceCount,
          customerPOId: row.customerPOId || "",
          customerState: row.customerState || "",
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
          qrDataUrl: await getQRCodeDataURL(s.qrPayload, 300),
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
            fabricCode: o.fabricCode || "",
            fabricColor: p?.fabricColor || o.fabricCode || "",
            customerName: u.customerName || o.customerName || "",
            customerHub: u.customerHub || "",
            // CO-aware: fall back through SO ids → CO ids so the sticker
            // for a CO-origin PO shows CO-YYMM-NNN instead of blank.
            salesOrderNo:
              o.salesOrderNo ||
              o.companySOId ||
              o.companyCOId ||
              "",
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
  /* eslint-disable react-hooks/set-state-in-effect -- auto-load FG stickers on UPH/PACK tab */
  useEffect(() => {
    if (activeTab === "UPHOLSTERY" || activeTab === "PACKING") {
      loadFgStickers();
    } else {
      setFgStickers([]);
    }
  }, [activeTab, loadFgStickers]);
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
      if (fgStickers.length === 0) {
        setFgPrintRequested(false);
        return;
      }
      window.print();
      // Don't clear fgStickers here anymore — the on-screen preview on UPH/
      // PACK tabs depends on that state. Reset just the print-requested flag.
      // eslint-disable-next-line no-restricted-syntax -- one-shot post-print state cleanup, fires from print callback
      setTimeout(() => setFgPrintRequested(false), 500);
    },
    fgPrintRequested ? 300 : null,
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
        alert(`Sync failed: ${json.error || res.statusText}`);
        return;
      }
      const scanned = json.scannedPOs ?? 0;
      const created = json.createdJCs ?? 0;
      alert(`Created ${created} job cards across ${scanned} orders`);
      invalidateCachePrefix("/api/production-orders");
      invalidateCachePrefix("/api/job-cards");
    } catch (err) {
      alert(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

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
    let columnCount = 0;
    if (activeTab === "ALL") {
      // Overview matrix: one row per filtered order × 8 dept columns.
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
      // Respect the DataGrid's internal filter state — if the user filtered
      // down to 18 of 457 rows, print those 18, not all 457.
      const printRows = gridFilterIdSet
        ? deptRows.filter((r) => gridFilterIdSet.has(r.id))
        : deptRows;
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
    fltSearch, fltCustomer, fltState, fltDueFrom, fltDueTo, gridFilterIdSet,
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
      activeTab === "ALL"
        ? "Production Schedule — Total Listing — Overview"
        : `Production Schedule — Total Listing — ${activeDept?.name}`;

    let body = "";
    let sourceCount = 0;
    let mergedCount = 0;
    let totalQty = 0;

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
    fltSearch, fltCustomer, fltState, fltDueFrom, fltDueTo, gridFilterIdSet,
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
        {/* Item type (wipType, substring-matched against each PO's job
            cards). Helpful when a supervisor wants to see only e.g. every
            PO with a Headboard component currently in production. */}
        <select
          value={fltItemType}
          onChange={(e) => setFltItemType(e.target.value)}
          className="text-xs px-2 py-1.5 border border-[#E6E0D9] rounded bg-white"
          title="WIP item type (matches against job-card wipType)"
        >
          <option value="">All item types</option>
          <option value="HB">HB</option>
          <option value="DIVAN">Divan</option>
          <option value="BASE">Base</option>
          <option value="CUSHION">Cushion</option>
          <option value="ARMREST">Armrest</option>
          <option value="HEADREST">Headrest</option>
        </select>
        {/* Model dropdown — distinct productCodes from already-loaded orders. */}
        <select
          value={fltModel}
          onChange={(e) => setFltModel(e.target.value)}
          className="text-xs px-2 py-1.5 border border-[#E6E0D9] rounded bg-white"
          title="Product code (model)"
        >
          <option value="">All models</option>
          {modelOptions.map((m) => (<option key={m} value={m}>{m}</option>))}
        </select>
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
          value={fltDueFrom}
          onChange={(e) => setFltDueFrom(e.target.value)}
          className="text-xs px-2 py-1.5 border border-[#E6E0D9] rounded"
          title="From (due date)"
        />
        <input
          type="date"
          value={fltDueTo}
          onChange={(e) => setFltDueTo(e.target.value)}
          className="text-xs px-2 py-1.5 border border-[#E6E0D9] rounded"
          title="To (due date)"
        />
        {!shouldFetch && (
          <button
            onClick={() => setShouldFetch(true)}
            className="text-[10px] px-2 py-1 rounded border border-[#6B5C32] text-[#6B5C32] hover:bg-[#FAF8F4]"
            title="Skip filtering and load every active production order"
          >
            Load all
          </button>
        )}
        {shouldFetch && (
          <button
            onClick={fetchOrders}
            className="text-[10px] px-2 py-1 rounded border border-[#E6E0D9] text-[#6B5C32] hover:bg-[#FAF8F4]"
            title="Re-fetch the orders payload (bypasses local cache)"
          >
            Refresh
          </button>
        )}
        {/* Removed 2026-05-05: the "Clear all" button wiped from/to dates as
            part of the URL batch, which caused a full-table refetch (~9k JCs)
            + grid re-render that froze the main thread for 1-2s and broke
            the date picker pop. Operators preferred just adjusting the
            from/to inputs directly (or using "Load all"), so the shortcut
            is gone. The URL params themselves still work — sharing a link
            with explicit q/state/customer/cat etc. params still filters. */}
        <span className="ml-auto text-[10px] text-[#8A7F73]">
          {shouldFetch
            ? `${filteredOrders.length} of ${orders.length} orders`
            : "Pick a filter (or Load all) to fetch orders"}
        </span>
      </div>

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
                ({(gridFilteredDeptRows ?? deptRows).length}
                {gridFilteredDeptRows && gridFilteredDeptRows.length !== deptRows.length
                  ? ` of ${deptRows.length}`
                  : ""} items)
              </span>
            </h2>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  // Each dept tab has its own gid in the live Sheet. The map
                  // is populated once after the sheet is provisioned; until
                  // then we fall back to the spreadsheet root and the user
                  // picks the tab manually.
                  const SHEET_ID = "1hDGUYeKuWHpCXKrZptFI2eIKh9yNdhw7JeKbTjxT-x8";
                  const GID_BY_DEPT: Record<string, string> = {
                    // TODO: fill in real gids after sheet provisioning.
                  };
                  const gid = GID_BY_DEPT[activeDept.code];
                  const url = gid
                    ? `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${gid}`
                    : `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
                  window.open(url, "_blank", "noopener,noreferrer");
                }}
                title="Open the live Google Sheet (Completion Date / PIC editable there)"
                className="h-7 text-xs"
              >
                Open in Google Sheets
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  // Export the rows the user is currently looking at —
                  // gridFilteredDeptRows mirrors the DataGrid's post-filter
                  // state (id+poId+jobCardId only), so we resolve back to
                  // the full row via a Map. Falls back to all deptRows
                  // when no filter is active.
                  const rowsById = new Map(deptRows.map((r) => [r.id, r]));
                  const source: DeptRow[] =
                    gridFilteredDeptRows
                      ? (gridFilteredDeptRows
                          .map((f) => rowsById.get(f.id))
                          .filter((r): r is DeptRow => Boolean(r)))
                      : deptRows;
                  if (source.length === 0) {
                    toast.error("Nothing to export.");
                    return;
                  }
                  // Header order chosen to mirror what a Production
                  // operator scans for: identifiers first, then product,
                  // then schedule/PIC. Excel auto-recognises ISO dates
                  // when the column is consistent yyyy-mm-dd.
                  const cols: { label: string; get: (r: DeptRow) => string | number }[] = [
                    { label: "PO No",         get: (r) => r.soId },
                    { label: "Customer PO",   get: (r) => r.customerPOId },
                    { label: "Customer Ref",  get: (r) => r.customerRef },
                    { label: "Customer",      get: (r) => r.customerName },
                    { label: "State",         get: (r) => r.customerState },
                    { label: "Model",         get: (r) => r.model },
                    { label: "WIP",           get: (r) => r.wip },
                    { label: "Category",      get: (r) => r.category },
                    { label: "Size",          get: (r) => r.size },
                    { label: "Colour",        get: (r) => r.colour },
                    { label: "Qty",           get: (r) => r.qty },
                    { label: "Prod Time (m)", get: (r) => r.prodTime },
                    { label: "Due Date",      get: (r) => r.dueDate },
                    { label: "Completed",     get: (r) => r.completedDate },
                    { label: "PIC 1",         get: (r) => r.pic1 },
                    { label: "PIC 2",         get: (r) => r.pic2 },
                    { label: "Status",        get: (r) => r.status },
                  ];
                  function escape(v: string | number): string {
                    const s = String(v ?? "");
                    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
                    return s;
                  }
                  const lines = [cols.map((c) => escape(c.label)).join(",")];
                  for (const row of source) {
                    lines.push(cols.map((c) => escape(c.get(row))).join(","));
                  }
                  // UTF-8 BOM prepended so Excel renders ASCII headers and
                  // any non-ASCII customer names without mojibake.
                  const csv = "﻿" + lines.join("\r\n");
                  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  const stamp = new Date().toISOString().slice(0, 10);
                  a.href = url;
                  a.download = `${activeDept.code}-production-${stamp}.csv`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                }}
                disabled={deptRows.length === 0}
                title="Download the currently visible rows as a CSV that opens in Excel / Google Sheets"
                className="h-7 text-xs"
              >
                Export as Excel
              </Button>
            </div>
          </div>
          <DataGrid<DeptRow>
            key={`dept-grid-${activeDept.code}`}
            columns={deptColumns}
            data={deptRows}
            keyField="id"
            stickyHeader
            maxHeight="calc(100vh - 300px)"
            emptyMessage={`No job cards in ${activeDept.name}.`}
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
            onFilteredDataChange={setGridFilteredDeptRows}
            // Hide already-completed / transferred dept cards by default
            // so the operator opens the page and immediately sees only
            // the live work in front of them. They can re-tick
            // COMPLETED / TRANSFERRED in the Status filter to see
            // history. Mirrors the operator's request: fewer rows
            // means faster page open and a more focused live view.
            defaultExcludedValues={{ status: ["COMPLETED", "TRANSFERRED"] }}
            // Virtualization disabled (2026-05-04): the virtualizer +
            // sticky header + frozen-left columns combination drifts the
            // frozen track by one row when scrolled — user reported the
            // SO ID column lining up against the column header instead of
            // the matching data row. The earlier perf gain (5c8aad7) only
            // matters on Fab Sew (~1,200 rows); other depts top out around
            // 500 and render fine without windowing. Re-enable once
            // DataGrid's frozen track gets its own sticky-header offset
            // pass, or split Fab Sew onto its own virtualized variant.
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
        </div>
      )}

      {/* Overview matrix grid (only shown when Overview tab is active) */}
      {activeTab === "ALL" && (
      <div className="rounded-lg border border-[#E6E0D9] bg-white overflow-hidden">
        {/* Header row */}
        <div
          className="grid text-[10px] font-semibold uppercase tracking-wider text-[#6B7280] bg-[#FAF8F4] border-b border-[#E6E0D9]"
          style={{ gridTemplateColumns: "120px minmax(220px,1.4fr) 110px 130px 50px 70px repeat(8,minmax(0,1fr))" }}
        >
          <div className="px-3 py-2.5">SO ID</div>
          <div className="px-3 py-2.5">Product</div>
          <div className="px-3 py-2.5">Customer</div>
          <div className="px-3 py-2.5">Special Order</div>
          <div className="px-2 py-2.5 text-center">Qty</div>
          <button
            type="button"
            className="px-2 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-[#6B7280] flex items-center gap-1 hover:text-[#1F1D1B] cursor-pointer"
            onClick={() =>
              setOverviewDueSort((p) =>
                p === null ? "asc" : p === "asc" ? "desc" : null,
              )
            }
            title="Sort by due date — click to cycle asc / desc / off"
          >
            Due
            <span className="text-[8px] leading-none flex flex-col">
              <span className={overviewDueSort === "asc" ? "text-[#6B5C32]" : "text-[#D1CCC4]"}>▲</span>
              <span className={overviewDueSort === "desc" ? "text-[#6B5C32]" : "text-[#D1CCC4]"}>▼</span>
            </span>
          </button>
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
              style={{ gridTemplateColumns: "120px minmax(220px,1.4fr) 110px 130px 50px 70px repeat(8,minmax(0,1fr))" }}
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
                className={`px-3 py-1.5 text-xs truncate flex items-center ${
                  order.specialOrder ? "text-[#9A3A2D] font-semibold" : "text-[#D1CCC4]"
                }`}
                title={order.specialOrder || ""}
              >
                {order.specialOrder || "—"}
              </div>
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
                      }).then(() => {
                        invalidateCachePrefix("/api/production-orders");
                        invalidateCachePrefix("/api/sales-orders");
                      }).catch(() => {});
                    },
                    e.currentTarget,
                  );
                }}
                title="Click to change due date"
              >{fmtShortDate(order.targetEndDate)}</div>
              {DEPARTMENTS.map((d) => {
                const c = cellFor(order, d.code, visibleOrders);
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
                // Mirror the fields the user sees in the Production Sheet row
                // above: Customer PO · State · Model · Type (WIP category) ·
                // WIP label · Size · Colour · (bedframe heights) · Qty ·
                // Special Order (when the SO line carries a custom note).
                // For bedframes the height line surfaces gap/divan/leg + total;
                // for sofas the seat size is already in sizeLabel.
                const heightLine = s.totalHeight
                  ? [s.gap, s.divan, s.leg].filter(Boolean).join(" · ") +
                    (s.totalHeight ? ` = ${s.totalHeight}` : "")
                  : [s.gap, s.divan, s.leg].filter(Boolean).join(" · ");
                return (
                  <div
                    key={s.key}
                    className="flex-shrink-0 border border-[#E6E0D9] rounded-md bg-white flex flex-col items-center p-2"
                    style={{ width: "180px" }}
                    title={`${s.customerPOId || s.poNo} · ${s.model} · ${s.wipType} · ${s.wipName} · ${s.sizeLabel} · ${s.colour} · Qty ${s.qty}`}
                  >
                    <QRImg data={s.qrPayload} size={100} alt="Job card QR" className="block" />
                    <div
                      className="mt-1.5 font-bold text-center leading-tight w-full truncate"
                      style={{ fontSize: "11px" }}
                    >
                      {s.model || s.wipName}
                    </div>
                    {(s.category || s.wipType) && (
                      <div
                        className="text-center leading-tight w-full text-[#6B5C32] truncate"
                        style={{ fontSize: "9px" }}
                      >
                        {[s.category, s.wipType].filter(Boolean).join(" · ")}
                      </div>
                    )}
                    <div
                      className="mt-0.5 text-center leading-tight w-full text-[#1F1D1B] truncate"
                      style={{ fontSize: "9px" }}
                    >
                      {s.wipName}
                    </div>
                    <div
                      className="mt-1 text-center leading-tight w-full text-[#6B7280] space-y-[1px]"
                      style={{ fontSize: "9px" }}
                    >
                      {s.customerPOId && (
                        <div className="font-semibold text-[#1F1D1B] tabular-nums truncate">
                          {s.customerPOId}
                          {s.customerState ? ` · ${s.customerState}` : ""}
                        </div>
                      )}
                      <div className="tabular-nums truncate">
                        {s.poNo}
                      </div>
                      <div className="truncate">
                        {s.deptCode}
                        {s.sizeLabel ? ` · ${s.sizeLabel}` : ""}
                        {s.colour ? ` · ${s.colour}` : ""}
                      </div>
                      {heightLine && (
                        <div className="truncate">{heightLine}</div>
                      )}
                      {s.specialOrder && (
                        <div className="truncate text-[#9A3A2D] font-semibold">
                          ★ {s.specialOrder}
                        </div>
                      )}
                      <div className="font-semibold text-[#1F1D1B]">
                        Qty {s.qty}
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
                        <QRImg data={trackUrl} size={110} alt="FG unit QR" className="block" />
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
                      <QRImg data={trackUrl} size={500} alt="FG unit QR" className="block" />
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
