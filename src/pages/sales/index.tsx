import { useState, useMemo, useEffect } from "react";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSOMode, soBasePath, soPageTitle, soNewButtonLabel } from "@/lib/so-mode";
import { useUrlState, useUrlStateNumber, useUrlBatch } from "@/lib/use-url-state";
import { useSessionState } from "@/lib/use-session-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { getPrimarySoCategory } from "@/lib/so-category";
import { matchesCompanyFilter } from "@/lib/company-dimension";
import { Plus, ShoppingCart, Download, Filter, X, Eye, Pencil, Printer, Truck, FileText, ClipboardList, RefreshCw, Package, CheckCircle, ScanLine, DollarSign, Building2, Trash2 } from "lucide-react";
// Note: generateSOPdf is dynamic-imported at the click handler so the
// 1MB jspdf vendor chunk only ships when the user actually prints a SO.
import { ScanPOModal } from "@/components/scan-po-modal";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import {
  OUTSTANDING_STATUSES,
  PENDING_DELIVERY_STATUSES,
  COMPLETED_STATUSES,
  CONFIRMED_STATUSES,
  sumByStatuses,
} from "@/lib/so-status";
import type { SalesOrder } from "@/types";
import type { Customer, DeliveryOrder } from "@/types";
import { fetchJson } from "@/lib/fetch-json";
import { mutationWithData } from "@/lib/schemas/common";
import { DeliveryOrderSchema } from "@/lib/schemas/delivery-order";
import { InvoiceSchema } from "@/lib/schemas/invoice";
import { z } from "zod";

const DOListSchema = z
  .object({
    success: z.boolean().optional(),
    data: z.array(DeliveryOrderSchema).optional(),
  })
  .passthrough();
const DOMutationSchema = mutationWithData(DeliveryOrderSchema);
const InvoiceMutationSchema = mutationWithData(InvoiceSchema);

type LinkedPOSummary = {
  soId: string;
  poNo: string;
  status: string;
  currentDepartment: string;
  progress: number;
  quantity: number;
};

// Production dept order — mirrors DEPT_ORDER in src/api/lib/lead-times.ts
// (inlined so the Service Orders panel doesn't pull a server lib into the
// bundle). Used to pick a multi-PO service order's EARLIEST open department.
const SO_DEPT_ORDER = [
  "FAB_CUT",
  "FAB_SEW",
  "WOOD_CUT",
  "FOAM",
  "FRAMING",
  "WEBBING",
  "UPHOLSTERY",
  "PACKING",
] as const;

// Aggregate a service order's linked production orders into one current-dept +
// progress for the Service Orders panel (#13). Single-PO SVs (the common case)
// collapse to that PO's exact values.
function aggregateServiceOrderProgress(pos: LinkedPOSummary[]): {
  dept: string | null;
  progress: number | null;
} {
  if (!pos || pos.length === 0) return { dept: null, progress: null };
  const open = pos.filter((p) => (p.status || "").toUpperCase() !== "COMPLETED");
  // Quantity-weighted progress so a big line isn't out-voted by a tiny one.
  const totQty = pos.reduce((s, p) => s + (Number(p.quantity) || 1), 0) || 1;
  const progress = Math.round(
    pos.reduce((s, p) => s + (Number(p.progress) || 0) * (Number(p.quantity) || 1), 0) /
      totQty,
  );
  if (open.length === 0) return { dept: "Done", progress: 100 };
  const rank = (d: string) => {
    const i = SO_DEPT_ORDER.indexOf(
      (d || "").toUpperCase() as (typeof SO_DEPT_ORDER)[number],
    );
    return i >= 0 ? i : SO_DEPT_ORDER.length;
  };
  const frontier = open.reduce((earliest, p) =>
    rank(p.currentDepartment) < rank(earliest.currentDepartment) ? p : earliest,
  );
  const dept = (frontier.currentDepartment || "").replace(/_/g, " ") || "—";
  return { dept, progress };
}

type SOStatusChangeEntry = {
  id: string;
  soId: string;
  fromStatus: string;
  toStatus: string;
  changedBy: string;
  timestamp: string;
  notes: string;
  autoActions: string[];
};

// OUTSTANDING_STATUSES, CONFIRMED_STATUSES, etc. are now imported from
// src/lib/so-status.ts so Sales and Consignment Orders agree on the
// definition. Previously each page had its own literal set and they
// drifted (Sales' Outstanding included ON_HOLD, CO's didn't; Sales'
// Completed was [CLOSED] only and showed 0 perpetually).
// 2026-05-26 audit: see src/lib/so-status.ts for the canonical bucket rules.
const ALL_STATUSES = [
  { value: "", label: "All Statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "CONFIRMED", label: "Confirmed (all)" },
  { value: "OUTSTANDING", label: "Outstanding" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "CLOSED", label: "Closed" },
  { value: "ON_HOLD", label: "On Hold" },
  { value: "CANCELLED", label: "Cancelled" },
];

// Page size 200 — enough to fit the entire current SO list on one page
// so search/filter work normally (client-side search can't see other
// pages). Pagination still kicks in past 200 rows, but day-to-day users
// stay on page 1.
const PAGE_SIZE = 200;

// Coarse pipeline stage for the Outstanding column. Used by BOTH the
// cell render and the column's filterAccessor so the filter dropdown
// offers real stages ("To dispatch", "Delivered", ...) instead of the
// "(blank)" it showed before (the column had no real field to read —
// the value only existed inside render). Also makes the column reflect
// the TRUE stage (Delivered / Invoiced / Closed) instead of a bare "—"
// once an order has actually shipped.
function soStageLabel(status: string): string {
  switch (status) {
    case "DRAFT":
      return "Draft";
    case "CONFIRMED":
    case "IN_PRODUCTION":
      return "In production";
    // Vocabulary aligned with the Delivery module tabs so the same real-world
    // stage reads the same word everywhere: READY_TO_SHIP = production done,
    // not yet on a DO = "Pending Delivery"; SHIPPED = on a loaded DO (left the
    // warehouse) = "Dispatched" (NOT "Delivered" — it isn't delivered yet).
    case "READY_TO_SHIP":
      return "Pending Delivery";
    case "SHIPPED":
      return "Dispatched";
    case "DELIVERED":
      return "Delivered";
    case "INVOICED":
      return "Invoiced";
    case "CLOSED":
      return "Closed";
    case "ON_HOLD":
      return "On hold";
    case "CANCELLED":
      return "Cancelled";
    default:
      return status || "—";
  }
}

export default function SalesPage() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const navigate = useNavigate();
  // 0134 — mode flips this page between the regular Sales Orders list
  // (/sales) and the Service Orders list (/service-order). The mode comes
  // from the URL pathname. See src/lib/so-mode.ts for the rationale.
  const mode = useSOMode();
  const basePath = soBasePath(mode);
  const isServiceOrderMode = mode === "service-order";
  // Append the service-order filter to the fetch URL so the backend only
  // returns the matching subset. Default (sales mode) sends
  // isServiceOrder=false; service-order mode sends isServiceOrder=true.
  const soFilterQs = isServiceOrderMode
    ? "isServiceOrder=true"
    : "isServiceOrder=false";

  // Pagination — server-side. Filter/tab changes reset to page 1.
  // URL-synced so refresh / share-link land back on the same page.
  const [page, setPage] = useUrlStateNumber("page", 1);

  // Mirror of the DataGrid's global search box. When the operator is
  // searching we must widen the fetch to the WHOLE dataset (same as a
  // dropdown filter) — otherwise the search only sees the current
  // 200-row server page and misses matches on other pages.
  const [gridSearch, setGridSearch] = useState("");

  // Filter state read up front so we can adjust the fetch URL when any
  // filter is active (filters were silently scoped to the current 200-row
  // page before — "This Year" missed the second page of orders).
  const _flStatus = useUrlState<string>("status", "");
  const _flCustomer = useUrlState<string>("customer", "");
  const _flFrom = useUrlState<string>("from", "");
  const _flTo = useUrlState<string>("to", "");
  const _flCat = useUrlState<"" | "BEDFRAME" | "SOFA" | "ACCESSORY">("cat", "");
  const _flDDFrom = useUrlState<string>("ddFrom", "");
  const _flDDTo = useUrlState<string>("ddTo", "");
  // Multi-Company Phase 2 — company filter. Default "" = ALL companies (today's
  // view, nothing hidden). Operator narrows to one org code (HOOKKA / OHANA …).
  const _flCompany = useUrlState<string>("company", "");
  const _filtersActive = !!(
    _flStatus[0] || _flCustomer[0] || _flFrom[0] || _flTo[0] ||
    _flCat[0] || _flDDFrom[0] || _flDDTo[0] || _flCompany[0] || gridSearch.trim()
  );

  const { data: ordersResp, loading, refresh: refreshOrders } = useCachedJson<{
    success?: boolean;
    data?: SalesOrder[];
    page?: number;
    limit?: number;
    total?: number;
  }>(
    _filtersActive
      // No page params → server returns the whole dataset (capped at 5000
      // server-side, well above current ~350 SOs). Client filters/paginates.
      ? `/api/sales-orders?${soFilterQs}`
      : `/api/sales-orders?page=${page}&limit=${PAGE_SIZE}&${soFilterQs}`,
  );
  // Whole-dataset status bucket counts — tab badges read from this so
  // "Draft (N)" / "Confirmed (N)" reflect the full table, not just the
  // current page of rows.
  const { data: statsResp, refresh: refreshStats } = useCachedJson<{
    success?: boolean;
    byStatus?: Record<string, number>;
    revenueByStatus?: Record<string, number>;
    total?: number;
    totalRevenueSen?: number;
    csRevenueSen?: number;
    deliveredItemsSen?: number;
    outstandingItemsSen?: number;
  }>(`/api/sales-orders/stats?${soFilterQs}`);
  const { data: customersResp, refresh: refreshCustomers } = useCachedJson<{ success?: boolean; data?: Customer[] }>("/api/customers");
  // Multi-Company Phase 2 — company registry for the "Company" column (code →
  // name) and the company filter dropdown. Mirrors procurement/index.tsx.
  const { data: orgsResp } = useCachedJson<{ organisations?: Array<{ code?: string; name?: string; isActive?: boolean }> }>("/api/organisations");
  // perf 2026-07-13: the SO list only needs per-SO production PROGRESS (6 fields:
  // salesOrderId/poNo/status/currentDepartment/progress/quantity — see the map
  // built below + aggregateProgress), NEVER job cards. The full payload was
  // ~1.4MB/13s on every Sales page load. NOTE the endpoint's include rule
  // (production-orders.ts ~L5348): `include` ABSENT still inlines jobCards
  // (~19MB decoded!), so `?fields=minimal` alone is NOT slim — must pass an
  // EXPLICIT EMPTY `include=` to drop jobCards → ~72kb, same 6 fields, values
  // byte-identical (declared MinimalPOOut props). Mirrors warehouse.tsx.
  const { data: productionOrdersResp, refresh: refreshProductionOrders } = useCachedJson<{ success?: boolean; data?: { salesOrderId: string; poNo: string; status: string; currentDepartment?: string; progress?: number; quantity?: number }[] }>("/api/production-orders?fields=minimal&include=");
  const { data: statusChangesResp, refresh: refreshStatusChanges } = useCachedJson<{ success?: boolean; data?: SOStatusChangeEntry[] }>("/api/sales-orders/status-changes");
  // Per-SO delivered quantity (items on a DELIVERED/INVOICED DO), keyed by
  // companySOId. Paired with each SO's own total qty to show partial-delivery
  // progress in the Outstanding column. Best-effort: empty map if it fails.
  const { data: deliveryProgressResp } = useCachedJson<{ success?: boolean; delivered?: Record<string, number> }>("/api/sales-orders/delivery-progress");
  const deliveredQtyMap = useMemo<Record<string, number>>(
    () => (deliveryProgressResp?.success ? deliveryProgressResp.delivered ?? {} : {}),
    [deliveryProgressResp],
  );
  const orders: SalesOrder[] = useMemo(
    () => (ordersResp?.success ? ordersResp.data ?? [] : Array.isArray(ordersResp) ? ordersResp : []),
    [ordersResp]
  );
  const totalOrdersServer = ordersResp?.total ?? orders.length;
  const totalPages = Math.max(1, Math.ceil(totalOrdersServer / PAGE_SIZE));
  // Tab badge counts come from the server-side /stats aggregate so they
  // reflect the whole dataset, not just the current paginated page.
  // "Confirmed" is anything that isn't DRAFT.
  const statsByStatus = statsResp?.byStatus ?? {};
  const statsTotalRaw = statsResp?.total ?? totalOrdersServer;
  const customers: Customer[] = useMemo(
    () => (customersResp?.data ? customersResp.data : Array.isArray(customersResp) ? customersResp : []),
    [customersResp]
  );
  const linkedPOMap = useMemo<Record<string, LinkedPOSummary[]>>(() => {
    const map: Record<string, LinkedPOSummary[]> = {};
    if (productionOrdersResp?.success && productionOrdersResp.data) {
      for (const po of productionOrdersResp.data) {
        if (!map[po.salesOrderId]) map[po.salesOrderId] = [];
        map[po.salesOrderId].push({
          soId: po.salesOrderId,
          poNo: po.poNo,
          status: po.status,
          currentDepartment: po.currentDepartment ?? "",
          progress: po.progress ?? 0,
          quantity: po.quantity ?? 1,
        });
      }
    }
    return map;
  }, [productionOrdersResp]);
  // Keep referencing the status-changes envelope so the hook stays subscribed,
  // even though we don't render from it directly (matches the previous behaviour).
  useMemo(() => statusChangesResp?.success ? statusChangesResp.data || [] : [], [statusChangesResp]);
  const [selectedRows, setSelectedRows] = useState<SalesOrder[]>([]);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [bulkConverting, setBulkConverting] = useState(false);
  // Multi-Company Phase 4 — bulk re-assign company. Target company picked in
  // the selection banner; button POSTs /batch-company. Server enforces the
  // early-status lock guard and reports moved/skipped.
  const [bulkCompany, setBulkCompany] = useState<string>("");
  const [bulkReassigning, setBulkReassigning] = useState(false);
  // Bulk-review modal — flat table of every line item across all DRAFT
  // SOs in the current view. Lets the operator scan productCode / size /
  // fabric / divan / leg / gap / special / qty for 50+ items in one
  // scroll instead of clicking into each SO detail page.
  const [showItemReview, setShowItemReview] = useState(false);
  // Tab + filter state lives in the URL so refresh, back/forward, and
  // shared links all land the user on exactly the view they had open.
  const [tab, setTab] = useUrlState<"DRAFT" | "CONFIRMED">("tab", "CONFIRMED");
  const [scanPOOpen, setScanPOOpen] = useState(false);

  // Transfer to DO / Invoice states
  const [transferDORow, setTransferDORow] = useState<SalesOrder | null>(null);
  const [transferInvRow, setTransferInvRow] = useState<SalesOrder | null>(null);
  const [transferLoading, setTransferLoading] = useState(false);
  const [doDeliveryDate, setDoDeliveryDate] = useState("");
  const [doDriverName, setDoDriverName] = useState("");
  const [doVehicleNo, setDoVehicleNo] = useState("");
  const [transferSuccess, setTransferSuccess] = useState<{ type: "do" | "inv"; docNo: string } | null>(null);
  const [matchedDO, setMatchedDO] = useState<DeliveryOrder | null>(null);

  // Filters — already wired via the early _flXXX bindings above so the
  // fetch URL can drop pagination when any filter is active. Re-bind here
  // to the same tuples so the rest of the component keeps the original
  // setFilterX names.
  const [filterStatus, setFilterStatus] = _flStatus;
  // 2026-05-24 — defaultExcludedValues MUST be a stable reference, otherwise
  // DataGrid's seed effect re-fires on every render and clobbers the
  // operator's just-applied column filter. See BUG-2026-05-24-003.
  const SHIPPED_STATUS_EXCLUDE = useMemo(
    () => ({ status: ["SHIPPED", "DELIVERED", "CLOSED", "CANCELLED"] }),
    [],
  );
  // The hide-shipped default only makes sense in the unfiltered Confirmed
  // funnel. On the Draft tab every row is DRAFT, so seeding a Status exclusion
  // there can only ever narrow a list that is already exactly what was asked
  // for — and it was half of how the tab ended up blank.
  const salesGridDefaultExcluded =
    filterStatus || tab === "DRAFT" ? undefined : SHIPPED_STATUS_EXCLUDE;
  const [filterCustomer, setFilterCustomer] = _flCustomer;
  const [filterDateFrom, setFilterDateFrom] = _flFrom;
  const [filterDateTo, setFilterDateTo] = _flTo;
  // Category matches if ANY line on the SO is the chosen category. DD axis
  // = customerDeliveryDate (sales staff filter on the date the customer
  // expects delivery, not SO entry date / internal expected DD).
  const [filterCategory, setFilterCategory] = _flCat;
  const [filterDDFrom, setFilterDDFrom] = _flDDFrom;
  const [filterDDTo, setFilterDDTo] = _flDDTo;
  const [filterCompany, setFilterCompany] = _flCompany;
  // Show/hide filter panel — sessionStorage so closing the tab forgets,
  // but a refresh keeps the panel open if user had it open.
  const [showFilters, setShowFilters] = useSessionState<boolean>("sales:showFilters", false);

  // Restore scroll position after navigating back to this page.
  const [savedScroll, setSavedScroll] = useSessionState<number>("sales:scrollY", 0);
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
  }, []);

  // Reset to page 1 when any filter or tab changes. setPage is stable
  // (memoized inside useUrlStateNumber), so omitting it from deps is safe
  // and intentional — including it would re-fire whenever any URL param
  // changed, which would itself recurse into the setPage call below.
  useEffect(() => {
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatus, filterCustomer, filterCompany, filterDateFrom, filterDateTo, filterCategory, filterDDFrom, filterDDTo, tab]);

  const fetchAll = () => {
    invalidateCachePrefix("/api/sales-orders");
    invalidateCachePrefix("/api/customers");
    invalidateCachePrefix("/api/production-orders");
    refreshOrders();
    refreshStats();
    refreshCustomers();
    refreshProductionOrders();
    refreshStatusChanges();
  };

  const hasActiveFilters = filterStatus || filterCustomer || filterDateFrom || filterDateTo || filterCategory || filterDDFrom || filterDDTo || filterCompany;

  // Atomic clear — one setSearchParams call, not seven. Each useUrlState
  // setter calls navigate() under the hood; firing seven in a row races on
  // react-router-dom v7 (later setters can read pre-clear state and re-add
  // the keys we just deleted). Build the new URL once and replace.
  const [, setSearchParams] = useSearchParams();
  const clearFilters = () => {
    setSearchParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        out.delete("status");
        out.delete("customer");
        out.delete("from");
        out.delete("to");
        out.delete("cat");
        out.delete("ddFrom");
        out.delete("ddTo");
        out.delete("company");
        return out;
      },
      { replace: true },
    );
  };

  // ── Filter application split in three ─────────────────────────────────
  //
  // The Sales page combines three different filter "scopes". Mixing them
  // up was the root cause of the 2026-05-26 KPI bugs Wei Siang flagged in
  // a sequence of three screenshots — first the cards lied under any
  // filter (snapshot stale), then the cards were tautological (Status=
  // Outstanding made Outstanding=Total=457, Pending=Completed=0).
  //
  //   1. `filteredOrdersForKpi` — applies every filter EXCEPT Status.
  //      The KPI bucket cards (Outstanding / Pending Delivery / Completed)
  //      and the Total card read from this. Status is a "focus the list"
  //      filter, not a "regroup the breakdown" filter — when the user
  //      picks Status=Outstanding + Bedframe they want to see "of the
  //      bedframe orders, how many are in each stage", not "457 / 0 / 0".
  //
  //   2. `filteredOrdersByUserFilters` — applies every filter INCLUDING
  //      Status. The Revenue (filtered) card reads from this so the
  //      money number matches the focused list, not the broader bucket
  //      view. (Different scope, on purpose.)
  //
  //   3. `filteredOrders` — adds the Draft/Confirmed TAB on top of (2).
  //      That's what the grid renders.
  //
  // Three scopes look heavy but each card / cell points at exactly one
  // and the cards stay individually informative. The earlier "split in
  // two" version had Outstanding = Total whenever Status=Outstanding,
  // which trained the operator to ignore the cards.
  const filteredOrdersForKpi = useMemo(() => {
    return orders.filter(o => {
      if (filterCustomer && o.customerId !== filterCustomer) return false;
      // Multi-Company Phase 2 — company filter. "" = ALL companies (default,
      // nothing hidden). Pre-column rows read as HOOKKA (server default).
      if (!matchesCompanyFilter(o.salesOrgCode, filterCompany)) return false;
      if (filterDateFrom) {
        const orderDate = o.companySODate.split("T")[0];
        if (orderDate < filterDateFrom) return false;
      }
      if (filterDateTo) {
        const orderDate = o.companySODate.split("T")[0];
        if (orderDate > filterDateTo) return false;
      }
      // Category: derive ONE primary category per SO (SOFA > BEDFRAME >
      // ACCESSORY) instead of "any line matches". Each SO is now exactly
      // one of the three buckets — no double-counting a sofa+pillows order
      // under both filters.
      if (filterCategory && getPrimarySoCategory(o.items) !== filterCategory) return false;
      // Customer delivery date range — what sales staff actually filter on.
      if (filterDDFrom || filterDDTo) {
        const dd = o.customerDeliveryDate ? o.customerDeliveryDate.split("T")[0] : "";
        if (!dd) return false;
        if (filterDDFrom && dd < filterDDFrom) return false;
        if (filterDDTo && dd > filterDDTo) return false;
      }
      return true;
    });
  }, [orders, filterCustomer, filterCompany, filterDateFrom, filterDateTo, filterCategory, filterDDFrom, filterDDTo]);

  const filteredOrdersByUserFilters = useMemo(() => {
    return filteredOrdersForKpi.filter(o => {
      if (filterStatus) {
        if (filterStatus === "OUTSTANDING") {
          if (!OUTSTANDING_STATUSES.has(o.status)) return false;
        } else if (filterStatus === "CONFIRMED") {
          // Synthetic group — see CONFIRMED_STATUSES in src/lib/so-status.ts.
          // Matches the dropdown's "Confirmed (all)" semantics.
          if (!CONFIRMED_STATUSES.has(o.status)) return false;
        } else if (o.status !== filterStatus) {
          return false;
        }
      }
      return true;
    });
  }, [filteredOrdersForKpi, filterStatus]);

  const filteredOrders = useMemo(() => {
    return filteredOrdersByUserFilters.filter(o => {
      if (tab === "DRAFT" && o.status !== "DRAFT") return false;
      if (tab === "CONFIRMED" && o.status === "DRAFT") return false;
      return true;
    });
  }, [filteredOrdersByUserFilters, tab]);

  // ── KPI counts ─────────────────────────────────────────────────────────
  // Bucket cards read from `filteredOrdersForKpi` (no Status filter) so
  // every bucket gets a real number even when Status=Outstanding is
  // selected. Otherwise the cards are tautological (Outstanding=Total,
  // Pending=Completed=0) and stop being informative.
  //
  // When NO filter is active, fall back to the whole-org /stats aggregate
  // (fast GROUP BY) to skip the array iteration on a cold view.
  //
  // The Sales page always fetches the WHOLE dataset (no pagination) the
  // moment any filter is set — see `_filtersActive` ternary on the
  // ordersResp fetch — so `filteredOrdersForKpi` is a complete server-side
  // dataset under filter, NOT just the current page.
  const kpiSource = useMemo(() => {
    if (hasActiveFilters) {
      const byStatus: Record<string, number> = {};
      for (const o of filteredOrdersForKpi) {
        byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      }
      return {
        total: filteredOrdersForKpi.length,
        byStatus,
      };
    }
    return { total: statsTotalRaw, byStatus: statsByStatus };
  }, [hasActiveFilters, filteredOrdersForKpi, statsTotalRaw, statsByStatus]);

  const statsTotal = kpiSource.total;
  const draftCount = kpiSource.byStatus.DRAFT ?? 0;
  const confirmedCount = Math.max(0, statsTotal - draftCount);
  // Bucket math from src/lib/so-status.ts. Buckets are now mutually
  // exclusive: every status maps to AT MOST one of Outstanding / Pending
  // Delivery / Completed. Pre-fix Sales double-counted READY_TO_SHIP in
  // both Outstanding AND Pending Delivery, and Completed = [CLOSED] only
  // (perpetually 0 for this factory's INVOICED-not-CLOSED workflow).
  const outstandingCount = sumByStatuses(kpiSource.byStatus, OUTSTANDING_STATUSES);
  const pendingDeliveryCount = sumByStatuses(kpiSource.byStatus, PENDING_DELIVERY_STATUSES);
  const completedCount = sumByStatuses(kpiSource.byStatus, COMPLETED_STATUSES);
  // Service-order mode cards (Total / Outstanding / In Production /
  // Pending Delivery / Delivered) re-use the same kpiSource so they
  // respect filters the same way.
  const inProductionCount = kpiSource.byStatus.IN_PRODUCTION ?? 0;
  const deliveredCount = (kpiSource.byStatus.DELIVERED ?? 0) + (kpiSource.byStatus.INVOICED ?? 0);

  // Bulk "Download PDF" — merge every selected sales order into one file. Each
  // order renders with the same layout as the single Print/Preview action.
  const downloadSelectedPdf = async () => {
    if (selectedRows.length === 0 || downloadingPdf) return;
    setDownloadingPdf(true);
    try {
      const { generateCombinedSOPdf } = await import("@/lib/generate-so-pdf");
      await generateCombinedSOPdf(
        selectedRows.map((o) => ({
          order: o,
          customer: customers.find((c) => c.id === o.customerId) ?? null,
        })),
        `SalesOrders-${selectedRows.length}.pdf`,
      );
    } catch {
      /* best-effort; button returns to idle on failure */
    } finally {
      setDownloadingPdf(false);
    }
  };

  const exportCSV = () => {
    const headers = [
      "SO No.", "Customer", "State", "Customer PO", "Order Date", "Expected DD",
      "Items", "Total Qty", "Total (RM)", "Status",
    ];
    const rows = filteredOrders.map(o => {
      const totalQty = o.items.reduce((s, i) => s + i.quantity, 0);
      return [
        o.companySOId,
        o.customerName,
        o.customerState,
        o.customerPOId || "",
        o.companySODate.split("T")[0],
        o.hookkaExpectedDD ? o.hookkaExpectedDD.split("T")[0] : "",
        o.items.length.toString(),
        totalQty.toString(),
        (o.totalSen / 100).toFixed(2),
        o.status,
      ];
    });

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `sales-orders-${new Date().toISOString().split("T")[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Memoized: a fresh `columns` array every render made the DataGrid's
  // filteredData/sortedData memos (which depend on columns) recompute over the
  // full ~690-row dataset on EVERY unrelated re-render (poll, selection,
  // search-mirror). Its only external dep is linkedPOMap. (2026-06-04 jank fix.)
  // Multi-Company Phase 2 — company display map (org code → legal name) for the
  // Company column, and the active-org list for the filter dropdown.
  const activeOrgs = useMemo(
    () => (orgsResp?.organisations ?? []).filter((o) => o.isActive !== false && o.code),
    [orgsResp],
  );
  const orgNameByCode = useMemo(() => {
    const out: Record<string, string> = {};
    for (const o of orgsResp?.organisations ?? []) {
      if (o.code) out[o.code] = o.name || o.code;
    }
    return out;
  }, [orgsResp]);

  const columns: Column<SalesOrder>[] = useMemo<Column<SalesOrder>[]>(() => [
    { key: "companySOId", label: "Company SO", type: "docno", width: "130px", sortable: true },
    {
      key: "salesOrgCode",
      label: "Company",
      type: "text",
      width: "120px",
      sortable: true,
      render: (_v: unknown, row: SalesOrder) => {
        const code = row.salesOrgCode || "HOOKKA";
        const label = orgNameByCode[code] || code;
        return (
          <span
            className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-[#F0ECE9] text-[#6B5C32]"
            title={code}
          >
            {label}
          </span>
        );
      },
    },
    { key: "customerSOId", label: "Customer SO", type: "docno", width: "120px", sortable: true },
    { key: "customerPOId", label: "Customer PO", type: "docno", width: "120px", sortable: true },
    { key: "customerName", label: "Customer", type: "text", width: "100px", sortable: true },
    { key: "customerDeliveryDate", label: "Customer Delivery", type: "date", width: "110px", sortable: true },
    { key: "customerState", label: "State", type: "text", width: "50px", sortable: true },
    { key: "reference", label: "Reference", type: "text", width: "100px", sortable: true },
    { key: "companySODate", label: "Order Date", type: "date", width: "90px", sortable: true },
    { key: "hookkaExpectedDD", label: "Expected DD", type: "date", width: "90px", sortable: true },
    {
      key: "items",
      label: "Items",
      type: "number",
      width: "50px",
      sortable: true,
      render: (_value, row) => <span>{row.items.length}</span>,
    },
    {
      key: "totalQty",
      label: "Qty",
      type: "number",
      width: "55px",
      align: "right" as const,
      sortable: true,
      render: (_value: unknown, row: SalesOrder) => {
        const totalQty = row.items.reduce((s, i) => s + i.quantity, 0);
        return <span>{totalQty}</span>;
      },
    },
    {
      key: "outstanding",
      label: "Outstanding",
      type: "text",
      width: "140px",
      sortable: true,
      // The dropdown reads this (real, enumerable pipeline stages)
      // instead of the non-existent "outstanding" field — which is why
      // it used to offer only "(blank)".
      filterAccessor: (row: SalesOrder) => soStageLabel(row.status),
      render: (_value: unknown, row: SalesOrder) => {
        const stage = soStageLabel(row.status);
        if (row.status === "DRAFT") {
          return <span className="text-[#9CA3AF]">—</span>;
        }
        if (row.status === "CANCELLED") {
          return <span className="text-[#9CA3AF]">Cancelled</span>;
        }
        // Still being made — keep the production-progress detail
        // operators rely on (filter still buckets it as "In production").
        if (row.status === "CONFIRMED" || row.status === "IN_PRODUCTION") {
          const totalQty = row.items.reduce((s, i) => s + i.quantity, 0);
          const linkedPOs = linkedPOMap[row.id] || [];
          const completedPOs = linkedPOs.filter(
            (p) => p.status === "COMPLETED",
          ).length;
          const totalPOs = linkedPOs.length;
          if (totalPOs === 0) {
            return (
              <span className="font-semibold text-[#9A3A2D]">
                {totalQty} pcs
              </span>
            );
          }
          const outstandingPOs = totalPOs - completedPOs;
          if (outstandingPOs > 0) {
            return (
              <span className="font-semibold text-[#9C6F1E]">
                {outstandingPOs}/{totalPOs}
              </span>
            );
          }
          return <span className="text-[#4F7C3A]">Done</span>;
        }
        if (row.status === "ON_HOLD") {
          return <span className="font-semibold text-[#9A3A2D]">On hold</span>;
        }
        // Past production — show REAL delivery progress so a partially-delivered
        // order isn't shown as if the whole thing already went out (the SO flips
        // to SHIPPED the moment ONE line ships). deliveredQty = pieces already on
        // a delivered DO; totalQty = the order's own quantity.
        const totalQty = row.items.reduce((s, i) => s + i.quantity, 0);
        const deliveredQty = deliveredQtyMap[row.companySOId] ?? 0;
        if (row.status === "INVOICED") {
          return <span className="text-[#4F7C3A]">Invoiced</span>;
        }
        if (row.status === "CLOSED") {
          return <span className="text-[#4F7C3A]">Closed</span>;
        }
        if (totalQty > 0 && deliveredQty >= totalQty) {
          return <span className="text-[#4F7C3A]">Delivered</span>;
        }
        if (deliveredQty > 0) {
          // PARTIALLY delivered — show how many pieces are actually out.
          return (
            <span
              className="font-semibold text-[#3E6570]"
              title={`${deliveredQty} of ${totalQty} pcs delivered`}
            >
              {deliveredQty}/{totalQty} delivered
            </span>
          );
        }
        // Nothing delivered yet — words aligned with the Delivery module tabs.
        if (row.status === "READY_TO_SHIP") {
          return (
            <span className="font-semibold text-[#9C6F1E]">Pending Delivery</span>
          );
        }
        if (row.status === "SHIPPED") {
          return <span className="font-semibold text-[#3E6570]">Dispatched</span>;
        }
        if (row.status === "DELIVERED") {
          return <span className="text-[#4F7C3A]">Delivered</span>;
        }
        return <span className="text-[#6B7280]">{stage}</span>;
      },
    },
    { key: "totalSen", label: "Total", type: "currency", width: "100px", sortable: true },
    // Service Orders panel only (#13): the repair's current production dept +
    // progress, aggregated from its linked production order(s) — the same
    // dept/progress the production grid shows. Hidden on the normal Sales list.
    ...(isServiceOrderMode
      ? [
          {
            key: "currentDept",
            label: "Current Dept",
            type: "text" as const,
            width: "120px",
            render: (_value: unknown, row: SalesOrder) => {
              const agg = aggregateServiceOrderProgress(linkedPOMap[row.id] ?? []);
              return agg.dept ? (
                <span>{agg.dept}</span>
              ) : (
                <span className="text-[#9CA3AF]">—</span>
              );
            },
          },
          {
            key: "poProgress",
            label: "Progress",
            type: "number" as const,
            width: "130px",
            render: (_value: unknown, row: SalesOrder) => {
              const agg = aggregateServiceOrderProgress(linkedPOMap[row.id] ?? []);
              if (agg.progress == null)
                return <span className="text-[#9CA3AF]">—</span>;
              return (
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 rounded bg-[#E2DDD8] overflow-hidden min-w-[44px]">
                    <div
                      className="h-full bg-[#6B5C32]"
                      style={{ width: `${agg.progress}%` }}
                    />
                  </div>
                  <span className="text-xs tabular-nums text-[#6B7280]">
                    {agg.progress}%
                  </span>
                </div>
              );
            },
          },
        ]
      : []),
    { key: "status", label: "Status", type: "status", width: "100px", sortable: true },
  ], [linkedPOMap, deliveredQtyMap, isServiceOrderMode, orgNameByCode]);

  // Delete one or more DRAFT sales orders. Shared by the row menu and the
  // Draft-tab bulk bar (owner 2026-08-01 — the list previously had no delete
  // affordance anywhere, so a mis-scanned draft could only be removed from its
  // own detail page).
  //
  // DRAFT-only, matching the backend guard: a confirmed order must be CANCELLED
  // (which keeps the record), never deleted. Failures are reported per order
  // rather than as one blanket message, because the usual cause — a linked
  // production order / DO / invoice — applies to specific rows.
  const deleteDrafts = async (rows: SalesOrder[]) => {
    const drafts = rows.filter((r) => r.status === "DRAFT");
    if (drafts.length === 0) return;
    const label =
      drafts.length === 1
        ? `Delete draft ${drafts[0].companySOId}?`
        : `Delete ${drafts.length} draft orders?`;
    const ok = await confirm({
      title: label,
      message:
        drafts.length === 1
          ? "The order and its line items are removed permanently. Its number becomes available again if it was the month's latest."
          : `${drafts.map((d) => d.companySOId).join(", ")}\n\nThese orders and their line items are removed permanently.`,
      danger: true,
    });
    if (!ok) return;

    const failures: string[] = [];
    let done = 0;
    for (const row of drafts) {
      try {
        const res = await fetch(`/api/sales-orders/${row.id}`, {
          method: "DELETE",
          credentials: "include",
        });
        if (res.ok) {
          done += 1;
        } else {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          failures.push(`${row.companySOId}: ${body.error || `HTTP ${res.status}`}`);
        }
      } catch (err) {
        failures.push(
          `${row.companySOId}: ${err instanceof Error ? err.message : "Network error"}`,
        );
      }
    }
    invalidateCachePrefix("/api/sales-orders");
    invalidateCachePrefix("/api/production-orders");
    setSelectedRows([]);
    fetchAll();
    if (done > 0) {
      toast.success(
        done === 1 ? "Draft deleted." : `${done} drafts deleted.`,
      );
    }
    for (const f of failures) toast.error(f);
  };

  const getContextMenuItems = (row: SalesOrder): ContextMenuItem[] => [
    {
      label: "View",
      icon: <Eye className="h-3.5 w-3.5" />,
      action: () => navigate(`${basePath}/${row.id}`),
    },
    {
      label: "Edit",
      icon: <Pencil className="h-3.5 w-3.5" />,
      action: () => navigate(`${basePath}/${row.id}/edit`),
    },
    {
      label: "",
      separator: true,
      action: () => {},
    },
    {
      label: "Print / Preview",
      icon: <Printer className="h-3.5 w-3.5" />,
      action: async () => {
        const { generateSOPdf } = await import("@/lib/generate-so-pdf");
        await generateSOPdf(row, customers.find(c => c.id === row.customerId) ?? null);
      },
    },
    {
      label: "",
      separator: true,
      action: () => {},
    },
    {
      label: "Transfer to Delivery Order",
      icon: <Truck className="h-3.5 w-3.5" />,
      action: () => {
        setDoDeliveryDate("");
        setDoDriverName("");
        setDoVehicleNo("");
        setTransferSuccess(null);
        setTransferDORow(row);
      },
    },
    {
      label: "Transfer to Invoice",
      icon: <FileText className="h-3.5 w-3.5" />,
      action: async () => {
        setTransferLoading(true);
        try {
          const d = await fetchJson("/api/delivery-orders", DOListSchema);
          if (d.success && d.data) {
            const found = d.data.find((dord) => dord.salesOrderId === row.id);
            if (found) {
              setMatchedDO(found as unknown as DeliveryOrder);
              setTransferSuccess(null);
              setTransferInvRow(row);
            } else {
              toast.warning("Please create a Delivery Order first before generating an invoice.");
            }
          } else {
            toast.warning("Please create a Delivery Order first before generating an invoice.");
          }
        } catch {
          toast.error("Failed to check delivery orders. Please try again.");
        } finally {
          setTransferLoading(false);
        }
      },
    },
    {
      label: "",
      separator: true,
      action: () => {},
    },
    {
      label: "View Document Status Change Log",
      icon: <ClipboardList className="h-3.5 w-3.5" />,
      action: () => navigate(`${basePath}/${row.id}?tab=status-log`),
    },
    {
      label: "",
      separator: true,
      action: () => {},
    },
    {
      label: "Refresh",
      icon: <RefreshCw className="h-3.5 w-3.5" />,
      action: () => fetchAll(),
    },
    // Delete — DRAFT only, mirroring the backend guard. Owner 2026-08-01:
    // 「我要可以delete SO draft，要不然如果不对的话我要删除都做不到，这只是draft」.
    // The list had NO delete affordance at all (row menu or toolbar), so a
    // mis-scanned draft could only be removed by opening its detail page.
    ...(row.status === "DRAFT"
      ? [
          {
            label: "",
            separator: true,
            action: () => {},
          },
          {
            label: "Delete draft",
            icon: <Trash2 className="h-3.5 w-3.5" />,
            danger: true,
            action: () => void deleteDrafts([row]),
          },
        ]
      : []),
  ];

  // Revenue card — server-side "CS revenue" (Confirmed Sales) excludes
  // DRAFT, ON_HOLD, and CANCELLED. Pulled from /stats so the headline
  // figure reflects the WHOLE table, not just the current paginated 200-row
  // page. Pre-server-stats this was `orders.reduce(...)` which silently
  // capped at PAGE_SIZE when no filter was active, missing ~half the
  // revenue on a 444-order dataset.
  const totalRevenue = statsResp?.csRevenueSen ?? 0;
  // Filter case still iterates the (unpaginated) loaded array — when any
  // filter is active the fetch path drops `?page&limit` and pulls all
  // orders, so this sum is whole-dataset accurate. CS exclusion is
  // applied here too so a user filtering "All Statuses" still reads the
  // CS number, not raw-including-cancelled.
  // Uses `filteredOrdersByUserFilters` (no tab filter) so the Revenue
  // card matches the KPI count cards — both should reflect the
  // user-selected filters regardless of whether Draft or Confirmed tab
  // happens to be open.
  const filteredRevenue = useMemo(
    () =>
      filteredOrdersByUserFilters
        .filter((o) => CONFIRMED_STATUSES.has(o.status))
        .reduce((sum, o) => sum + o.totalSen, 0),
    [filteredOrdersByUserFilters],
  );

  // Revenue (filtered) — SO HEADER total summed over the user-filtered
  // set. Math stays internally consistent: per-customer Revenue figures
  // sum to "All Customers" Revenue across any common filter, and per-
  // status Revenue figures sum to "All Statuses" Revenue.
  //
  // 2026-05-16 → 2026-05-26 history (Wei Siang feedback ladder):
  //  • Originally used `statsResp.outstandingItemsSen` /
  //    `deliveredItemsSen` when Status was Outstanding/Delivered to get
  //    ITEM-level accuracy on partially-delivered SOs (an order with
  //    only half its items shipped only counted the unshipped half as
  //    outstanding).
  //  • That number was a WHOLE-ORG aggregate from /stats — it didn't
  //    accept date/customer/category. Adding any non-status filter left
  //    the Revenue card stuck on the same number, so 2026-05-26 fix
  //    switched to filteredRevenue when other filters were active.
  //  • Wei Siang then noticed (per-customer revenue summed across
  //    customers) ≠ (all-customers revenue) — because individual
  //    customer views used SO header sums while All Customers still
  //    used item-level. Same metric, two formulas — confusing.
  //
  // Final decision (2026-05-26 third pass): always SO header sum when
  // any filter is active, whole-org csRevenue when no filter. Lose
  // partial-delivery item-level accuracy as a deliberate trade so the
  // numbers Wei Siang scans on his dashboard add up across slices.
  const displayRevenue = hasActiveFilters ? filteredRevenue : totalRevenue;

  // Quick date presets — see useUrlBatch jsdoc for why we can't just call
  // setFilterDateFrom + setFilterDateTo in sequence (React 18 batches the
  // two setSearchParams calls and the second's prev snapshot drops the
  // first). useUrlBatch writes both keys against the same prev.
  const setUrlBatch = useUrlBatch();
  const applyDatePreset = (preset: "this-month" | "last-month" | "this-year") => {
    const now = new Date();
    const fmt = (d: Date) => d.toISOString().split("T")[0];
    let fromStr = "";
    let toStr = "";
    if (preset === "this-month") {
      fromStr = fmt(new Date(now.getFullYear(), now.getMonth(), 1));
      toStr = fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    } else if (preset === "last-month") {
      fromStr = fmt(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      toStr = fmt(new Date(now.getFullYear(), now.getMonth(), 0));
    } else {
      fromStr = fmt(new Date(now.getFullYear(), 0, 1));
      toStr = fmt(new Date(now.getFullYear(), 11, 31));
    }
    setUrlBatch({ from: fromStr, to: toStr });
  };

  return (
    <div className="space-y-6 max-md:space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">{soPageTitle(mode)}</h1>
          <p className="text-xs text-[#6B7280]">
            {isServiceOrderMode
              ? "Aftersales orders cloned from a Sales / Consignment Order. Same production cascade, prices default to 0."
              : "Manage customer orders from creation to delivery"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Scan PO is sales-only — service orders never come from a PO scan. */}
          {!isServiceOrderMode && (
            <Button variant="outline" onClick={() => setScanPOOpen(true)}>
              <ScanLine className="h-4 w-4" /> Scan PO
            </Button>
          )}
          <Button variant="primary" onClick={() => navigate(`${basePath}/create`)}>
            <Plus className="h-4 w-4" /> {soNewButtonLabel(mode)}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-5 max-[360px]:grid-cols-1">
        {isServiceOrderMode ? (
          // Service Order mode: every card is count-based — SVs are priced
          // at 0 by default so Revenue / Outstanding RM are always 0.
          <>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="rounded-lg bg-[#F0ECE9] p-2.5 shrink-0"><ClipboardList className="h-5 w-5 text-[#6B5C32]" /></div>
                <div className="min-w-0"><p className="text-2xl font-bold text-[#1F1D1B]">{statsTotal}</p><p className="text-xs text-[#6B7280]">Total Service Orders</p></div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="rounded-lg bg-[#FAEFCB] p-2.5 shrink-0"><DollarSign className="h-5 w-5 text-[#9C6F1E]" /></div>
                <div className="min-w-0"><p className="text-2xl font-bold text-[#9C6F1E]">{outstandingCount}</p><p className="text-xs text-[#6B7280]">Outstanding</p></div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="rounded-lg bg-[#F0ECE9] p-2.5 shrink-0"><Package className="h-5 w-5 text-[#6B5C32]" /></div>
                <div className="min-w-0"><p className="text-2xl font-bold text-[#6B5C32]">{inProductionCount}</p><p className="text-xs text-[#6B7280]">In Production</p></div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="rounded-lg bg-[#E6F0F3] p-2.5 shrink-0"><Truck className="h-5 w-5 text-[#3E6570]" /></div>
                <div className="min-w-0"><p className="text-2xl font-bold text-[#3E6570]">{pendingDeliveryCount}</p><p className="text-xs text-[#6B7280]">Pending Delivery</p></div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="rounded-lg bg-[#EEF3E4] p-2.5 shrink-0"><CheckCircle className="h-5 w-5 text-[#4F7C3A]" /></div>
                <div className="min-w-0"><p className="text-2xl font-bold text-[#4F7C3A]">{deliveredCount + completedCount}</p><p className="text-xs text-[#6B7280]">Delivered</p></div>
              </CardContent>
            </Card>
          </>
        ) : (
          <>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="rounded-lg bg-[#F0ECE9] p-2.5 shrink-0"><ShoppingCart className="h-5 w-5 text-[#6B5C32]" /></div>
                <div className="min-w-0"><p className="text-2xl font-bold text-[#1F1D1B]">{statsTotal}</p><p className="text-xs text-[#6B7280]">Total Orders</p></div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="rounded-lg bg-[#F0ECE9] p-2.5 shrink-0"><DollarSign className="h-5 w-5 text-[#6B5C32]" /></div>
                <div className="min-w-0">
                  <p className={cn("text-xl font-bold truncate", hasActiveFilters ? "text-[#6B5C32]" : "text-[#1F1D1B]")}>
                    {formatCurrency(displayRevenue)}
                  </p>
                  <p
                    className="text-xs text-[#6B7280]"
                    title={hasActiveFilters ? undefined : "Excludes Draft and Cancelled"}
                  >
                    {hasActiveFilters ? "Revenue (filtered)" : "Revenue"}
                  </p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="rounded-lg bg-[#FAEFCB] p-2.5 shrink-0"><DollarSign className="h-5 w-5 text-[#9C6F1E]" /></div>
                <div className="min-w-0"><p className="text-2xl font-bold text-[#9C6F1E]">{outstandingCount}</p><p className="text-xs text-[#6B7280]">Outstanding</p></div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="rounded-lg bg-[#E6F0F3] p-2.5 shrink-0"><Truck className="h-5 w-5 text-[#3E6570]" /></div>
                <div className="min-w-0"><p className="text-2xl font-bold text-[#3E6570]">{pendingDeliveryCount}</p><p className="text-xs text-[#6B7280]">Pending Delivery</p></div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="rounded-lg bg-[#EEF3E4] p-2.5 shrink-0"><CheckCircle className="h-5 w-5 text-[#4F7C3A]" /></div>
                <div className="min-w-0"><p className="text-2xl font-bold text-[#4F7C3A]">{completedCount}</p><p className="text-xs text-[#6B7280]">Completed</p></div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={showFilters ? "primary" : "outline"}
                size="sm"
                onClick={() => setShowFilters(!showFilters)}
              >
                <Filter className="h-4 w-4" /> Filters
                {hasActiveFilters && <span className="ml-1 bg-white text-[#6B5C32] text-xs rounded-full h-5 w-5 flex items-center justify-center font-bold">!</span>}
              </Button>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="text-[#9CA3AF] hover:text-[#374151]">
                  <X className="h-4 w-4" /> Clear
                </Button>
              )}
              {hasActiveFilters && (
                <span className="text-sm text-[#6B7280]">
                  Showing {filteredOrders.length} of {orders.length} orders ·{" "}
                  <span className="font-semibold text-[#6B5C32]">
                    {formatCurrency(displayRevenue)}
                  </span>
                </span>
              )}
            </div>
            {selectedRows.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={downloadingPdf}
                onClick={downloadSelectedPdf}
              >
                <Download className="h-4 w-4" />{" "}
                {downloadingPdf
                  ? "Preparing…"
                  : `Download PDF (${selectedRows.length})`}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={exportCSV}>
              <Download className="h-4 w-4" /> Export CSV
            </Button>
          </div>

          {showFilters && (
            <>
              <div className="flex flex-wrap items-center gap-2 pt-3 pb-1 border-t border-[#E2DDD8]">
                <span className="text-xs text-[#9CA3AF]">Quick:</span>
                <Button variant="outline" size="sm" onClick={() => applyDatePreset("this-month")}>
                  This Month
                </Button>
                <Button variant="outline" size="sm" onClick={() => applyDatePreset("last-month")}>
                  Last Month
                </Button>
                <Button variant="outline" size="sm" onClick={() => applyDatePreset("this-year")}>
                  This Year
                </Button>
                <Button variant="outline" size="sm" onClick={() => setFilterCategory("SOFA")}>
                  Sofa
                </Button>
                <Button variant="outline" size="sm" onClick={() => setFilterCategory("BEDFRAME")}>
                  Bedframe
                </Button>
              </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 pt-2">
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Status</label>
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                >
                  {ALL_STATUSES.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Customer</label>
                <select
                  value={filterCustomer}
                  onChange={(e) => setFilterCustomer(e.target.value)}
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                >
                  <option value="">All Customers</option>
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>{c.code} - {c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                {/* Multi-Company Phase 2 — company filter. Default "All
                    Companies" shows every SO (nothing hidden). */}
                <label className="block text-xs text-[#9CA3AF] mb-1">Company</label>
                <select
                  value={filterCompany}
                  onChange={(e) => setFilterCompany(e.target.value)}
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                >
                  <option value="">All Companies</option>
                  {activeOrgs.map((o) => (
                    <option key={o.code} value={o.code}>{o.name || o.code}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Date From</label>
                <Input
                  type="date"
                  value={filterDateFrom}
                  onChange={(e) => setFilterDateFrom(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Date To</label>
                <Input
                  type="date"
                  value={filterDateTo}
                  onChange={(e) => setFilterDateTo(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Category</label>
                <select
                  value={filterCategory}
                  onChange={(e) => setFilterCategory(e.target.value as "" | "BEDFRAME" | "SOFA" | "ACCESSORY")}
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                >
                  <option value="">All Categories</option>
                  <option value="BEDFRAME">Bedframe</option>
                  <option value="SOFA">Sofa</option>
                  <option value="ACCESSORY">Accessories</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">DD from</label>
                <Input
                  type="date"
                  value={filterDDFrom}
                  onChange={(e) => setFilterDDFrom(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">DD to</label>
                <Input
                  type="date"
                  value={filterDDTo}
                  onChange={(e) => setFilterDDTo(e.target.value)}
                />
              </div>
            </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2"><ShoppingCart className="h-5 w-5 text-[#6B5C32]" /> {soPageTitle(mode)}</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {tab === "DRAFT" && draftCount > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowItemReview(true)}
                  title="Review every line item across all draft SOs in one flat table"
                >
                  <ClipboardList className="h-4 w-4" /> Review items
                </Button>
              )}
              <div className="inline-flex rounded-md border border-[#E2DDD8] bg-[#FAF9F7] p-0.5">
                <button
                  onClick={() => { setTab("DRAFT"); setSelectedRows([]); }}
                  className={cn(
                    "px-4 py-1.5 text-sm rounded transition-colors",
                    tab === "DRAFT"
                      ? "bg-[#FAEFCB] text-[#9C6F1E] font-medium shadow-sm"
                      : "text-[#6B7280] hover:text-[#1F1D1B]"
                  )}
                >
                  Draft ({draftCount})
                </button>
                <button
                  onClick={() => { setTab("CONFIRMED"); setSelectedRows([]); }}
                  className={cn(
                    "px-4 py-1.5 text-sm rounded transition-colors",
                    tab === "CONFIRMED"
                      ? "bg-[#E0EDF0] text-[#3E6570] font-medium shadow-sm"
                      : "text-[#6B7280] hover:text-[#1F1D1B]"
                  )}
                >
                  Confirmed ({confirmedCount})
                </button>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {tab === "DRAFT" && selectedRows.length > 0 && (
            <div className="mb-3 flex items-center justify-between rounded-md border border-[#E8D597] bg-[#FAEFCB] px-3 py-2 text-sm">
              <span className="text-[#9C6F1E]">
                {selectedRows.length} draft order(s) selected
              </span>
              <Button
                variant="primary"
                size="sm"
                disabled={bulkConverting}
                onClick={async () => {
                  const drafts = selectedRows.filter(s => s.status === "DRAFT");
                  if (drafts.length === 0) return;
                  if (!(await confirm({ title: "Convert drafts", message: `Convert ${drafts.length} draft order(s) to CONFIRMED? This will auto-create production orders.`, danger: false }))) return;
                  setBulkConverting(true);
                  let ok = 0, fail = 0;
                  const errors: string[] = [];
                  for (const so of drafts) {
                    try {
                      const res = await fetch(`/api/sales-orders/${so.id}/confirm`, {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          "Idempotency-Key": crypto.randomUUID(),
                        },
                        body: JSON.stringify({ changedBy: "Admin", notes: "Bulk confirm" }),
                      });
                      const text = await res.text();
                      let d: { success?: boolean; error?: string } = {};
                      try { d = JSON.parse(text); } catch { d = { error: text.slice(0, 200) }; }
                      if (d.success) ok++;
                      else {
                        fail++;
                        if (errors.length < 3) errors.push(`${so.companySOId}: ${d.error || `HTTP ${res.status}`}`);
                      }
                    } catch (e) {
                      fail++;
                      if (errors.length < 3) errors.push(`${so.companySOId}: ${(e as Error).message}`);
                    }
                  }
                  setBulkConverting(false);
                  setSelectedRows([]);
                  if (fail > 0) {
                    toast.error(`Converted: ${ok} · Failed: ${fail}${errors.length ? " — " + errors[0] : ""}`);
                  } else {
                    toast.success(`Converted ${ok} order${ok !== 1 ? "s" : ""} successfully.`);
                  }
                  // Jump to Confirmed tab if anything actually converted so
                  // the user can immediately see the new confirmed orders.
                  if (ok > 0) setTab("CONFIRMED");
                  invalidateCachePrefix("/api/sales-orders");
                  invalidateCachePrefix("/api/production-orders");
                  fetchAll();
                }}
              >
                <CheckCircle className="h-4 w-4" /> {bulkConverting ? "Converting..." : "Convert to Confirmed"}
              </Button>
              {/* Bulk delete — the counterpart to Convert. A batch scanned by
                  mistake is discarded here instead of one detail page at a
                  time (owner 2026-08-01). DRAFT-only, same guard as the
                  backend. */}
              <Button
                variant="outline"
                disabled={bulkConverting}
                style={{ color: "var(--text-danger, #9A3A2D)" }}
                onClick={() => void deleteDrafts(selectedRows)}
              >
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </div>
          )}
          {/* Multi-Company Phase 4 — bulk re-assign company. Shown whenever
              rows are selected (both Draft + Confirmed tabs) in real-SO mode.
              Only early-status SOs are actually moved server-side; locked ones
              (in production / shipped / invoiced …) are reported as skipped. */}
          {!isServiceOrderMode && selectedRows.length > 0 && activeOrgs.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[#DED8CF] bg-[#F5F1EA] px-3 py-2 text-sm">
              <span className="flex items-center gap-1.5 text-[#6B5C32]">
                <Building2 className="h-4 w-4" />
                Re-assign company for {selectedRows.length} order(s)
              </span>
              <div className="flex items-center gap-2">
                <select
                  className="h-9 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                  value={bulkCompany}
                  onChange={(e) => setBulkCompany(e.target.value)}
                  aria-label="Target company for bulk re-assign"
                  disabled={bulkReassigning}
                >
                  <option value="">Select company…</option>
                  {activeOrgs.map((o) => (
                    <option key={o.code} value={o.code}>{o.name || o.code}</option>
                  ))}
                </select>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={bulkReassigning || !bulkCompany}
                  onClick={async () => {
                    if (!bulkCompany) return;
                    const targetName = orgNameByCode[bulkCompany] || bulkCompany;
                    const ids = selectedRows.map((s) => s.id);
                    if (!(await confirm({
                      title: "Re-assign company",
                      message: `Move ${ids.length} selected order(s) to ${targetName}? Orders already in production, shipped, or invoiced can't be re-assigned and will be skipped.`,
                      danger: false,
                    }))) return;
                    setBulkReassigning(true);
                    try {
                      const res = await fetch(`/api/sales-orders/batch-company`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ ids, salesOrgCode: bulkCompany, changedBy: "Admin" }),
                      });
                      const text = await res.text();
                      let d: { success?: boolean; error?: string; moved?: number; skipped?: number } = {};
                      try { d = JSON.parse(text); } catch { d = { error: text.slice(0, 200) }; }
                      if (!res.ok || !d.success) {
                        toast.error(d.error || `HTTP ${res.status}`);
                      } else {
                        const moved = d.moved ?? 0;
                        const skipped = d.skipped ?? 0;
                        if (skipped > 0) {
                          toast.error(`Moved ${moved} to ${targetName} · ${skipped} skipped (locked or already there).`);
                        } else {
                          toast.success(`Moved ${moved} order${moved !== 1 ? "s" : ""} to ${targetName}.`);
                        }
                        setSelectedRows([]);
                        setBulkCompany("");
                        invalidateCachePrefix("/api/sales-orders");
                        fetchAll();
                      }
                    } catch (e) {
                      toast.error((e as Error).message);
                    } finally {
                      setBulkReassigning(false);
                    }
                  }}
                >
                  <Building2 className="h-4 w-4" /> {bulkReassigning ? "Moving..." : "Re-assign"}
                </Button>
              </div>
            </div>
          )}
          <DataGrid<SalesOrder>
            columns={columns}
            data={filteredOrders}
            keyField="id"
            loading={loading}
            stickyHeader={true}
            virtualize
            maxHeight="calc(100vh - 320px)"
            emptyMessage={tab === "DRAFT" ? "No draft orders." : "No confirmed orders."}
            onDoubleClick={(row) => navigate(`${basePath}/${row.id}`)}
            contextMenuItems={getContextMenuItems}
            selectable
            onSelectionChange={setSelectedRows}
            onSearchChange={setGridSearch}
            gridId="sales-orders-list"
            // Give each Status-dropdown selection its own filter session
            // so a sticky column-filter from a previous selection can't
            // blank the grid. BUG (Wei Siang 2026-05-16): picking
            // "Delivered" showed "0 of 66 · 1 filter active" because the
            // grid had persisted the funnel-default status exclusion and
            // never re-applied it against the new selection.
            // Every state that SEGMENTS the rows must be part of this key, or
            // the two segments share one sticky filter set. The Draft/Confirmed
            // tab was missing: the grid seeds its Status value-filter from the
            // statuses PRESENT in the current data, so a set seeded on the
            // Confirmed tab contains no "DRAFT" — switching to Draft then hid
            // every row ("0 of 2 records · 1 filter active").
            //
            // This is the SECOND time round for this class: BUG 2026-05-16 was
            // the same defect via the Status dropdown, and that fix added only
            // `filterStatus`. `tab` is the other segmenting state.
            // (Sibling grids are already safe by construction: Production bakes
            // the department into gridId, Service Cases has statusFilter as its
            // only segment.)
            valueFilterKey={`${tab}:${filterStatus || "all"}`}
            // Hide already-shipped / delivered / closed / cancelled rows
            // ONLY in the default "All Statuses" funnel view — once the
            // operator explicitly picks a Status above, filteredOrders is
            // already scoped to exactly that status, so a second grid-level
            // exclusion would wrongly hide every matching row.
            defaultExcludedValues={salesGridDefaultExcluded}
            rowClassName={(row) =>
              row.status === "DRAFT"
                ? "!bg-[#FAEFCB]/60 border-l-2 border-l-amber-400"
                : ""
            }
          />

          {/* Pagination footer */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#E2DDD8] pt-3 mt-3 text-sm text-[#6B7280]">
            <span>
              {totalOrdersServer.toLocaleString()} sales order
              {totalOrdersServer === 1 ? "" : "s"}
            </span>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page <= 1 || loading}
              >
                ← Prev
              </Button>
              <span className="tabular-nums text-[#1F1D1B]">
                Page {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages || loading}
              >
                Next →
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Transfer to Delivery Order Dialog */}
      {transferDORow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => { if (!transferLoading) setTransferDORow(null); }} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-[#6B5C32]/10 flex items-center justify-center">
                  <Truck className="h-5 w-5 text-[#6B5C32]" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[#1F1D1B]">Transfer to Delivery Order</h2>
                  <p className="text-xs text-[#6B7280]">Create a DO from {transferDORow.companySOId}</p>
                </div>
              </div>
              <button
                onClick={() => { if (!transferLoading) setTransferDORow(null); }}
                className="text-[#9CA3AF] hover:text-[#374151] transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {transferSuccess?.type === "do" ? (
              <div className="p-6 text-center space-y-4">
                <div className="mx-auto h-16 w-16 rounded-full bg-[#EEF3E4] flex items-center justify-center">
                  <CheckCircle className="h-8 w-8 text-[#4F7C3A]" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-[#1F1D1B]">Delivery Order Created</h3>
                  <p className="text-xs text-[#6B7280] mt-0.5">DO No: <span className="font-mono font-semibold text-[#6B5C32]">{transferSuccess.docNo}</span></p>
                </div>
                <div className="flex justify-center gap-3 pt-2">
                  <Button variant="outline" onClick={() => { setTransferDORow(null); setTransferSuccess(null); }}>Close</Button>
                  <Button variant="primary" onClick={() => { setTransferDORow(null); setTransferSuccess(null); navigate("/delivery"); }}>
                    Go to Delivery Orders
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {/* SO Info */}
                <div className="px-6 py-4 bg-[#FAF9F7] border-b border-[#E2DDD8]">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                    <div>
                      <span className="text-[#9CA3AF]">SO No.</span>
                      <p className="font-semibold text-[#1F1D1B]">{transferDORow.companySOId}</p>
                    </div>
                    <div>
                      <span className="text-[#9CA3AF]">Customer</span>
                      <p className="font-semibold text-[#1F1D1B]">{transferDORow.customerName}</p>
                    </div>
                    <div>
                      <span className="text-[#9CA3AF]">Items</span>
                      <p className="font-semibold text-[#1F1D1B]">{transferDORow.items.length} item(s)</p>
                    </div>
                    <div>
                      <span className="text-[#9CA3AF]">Total</span>
                      <p className="font-semibold text-[#1F1D1B]">{formatCurrency(transferDORow.totalSen)}</p>
                    </div>
                  </div>
                </div>

                {/* Delivery fields */}
                <div className="px-6 py-4 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-xs text-[#9CA3AF] mb-1">Delivery Date (optional)</label>
                      <Input
                        type="date"
                        value={doDeliveryDate}
                        onChange={(e) => setDoDeliveryDate(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#9CA3AF] mb-1">Driver Name (optional)</label>
                      <Input
                        type="text"
                        placeholder="e.g. Ahmad"
                        value={doDriverName}
                        onChange={(e) => setDoDriverName(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#9CA3AF] mb-1">Vehicle No. (optional)</label>
                      <Input
                        type="text"
                        placeholder="e.g. WA1234B"
                        value={doVehicleNo}
                        onChange={(e) => setDoVehicleNo(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Items table */}
                  <div>
                    <h3 className="text-sm font-medium text-[#1F1D1B] mb-2 flex items-center gap-2">
                      <Package className="h-4 w-4 text-[#6B5C32]" /> Items to Transfer
                    </h3>
                    <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-[#FAF9F7] border-b border-[#E2DDD8]">
                            <th className="text-left px-3 py-2 text-[#9CA3AF] font-medium">Product Code</th>
                            <th className="text-left px-3 py-2 text-[#9CA3AF] font-medium">Product Name</th>
                            <th className="text-left px-3 py-2 text-[#9CA3AF] font-medium">Size</th>
                            <th className="text-left px-3 py-2 text-[#9CA3AF] font-medium">Fabric</th>
                            <th className="text-right px-3 py-2 text-[#9CA3AF] font-medium">Qty</th>
                          </tr>
                        </thead>
                        <tbody>
                          {transferDORow.items.map((item, idx) => (
                            <tr key={idx} className="border-b border-[#E2DDD8] last:border-b-0">
                              <td className="px-3 py-2 font-mono text-xs">{item.productCode}</td>
                              <td className="px-3 py-2">{item.productName}</td>
                              <td className="px-3 py-2">{item.sizeLabel}</td>
                              <td className="px-3 py-2">{item.fabricCode}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{item.quantity}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-[#E2DDD8] flex justify-end gap-3">
                  <Button variant="outline" onClick={() => setTransferDORow(null)} disabled={transferLoading}>Cancel</Button>
                  <Button
                    variant="primary"
                    disabled={transferLoading}
                    onClick={async () => {
                      setTransferLoading(true);
                      try {
                        const mappedItems = transferDORow.items.map(item => ({
                          productCode: item.productCode,
                          productName: item.productName,
                          sizeLabel: item.sizeLabel,
                          fabricCode: item.fabricCode,
                          quantity: item.quantity,
                          itemM3: 0,
                          rackingNumber: "",
                          packingStatus: "PENDING",
                        }));
                        const d = await fetchJson("/api/delivery-orders", DOMutationSchema, {
                          method: "POST",
                          body: {
                            salesOrderId: transferDORow.id,
                            items: mappedItems,
                            ...(doDeliveryDate && { deliveryDate: doDeliveryDate }),
                            ...(doDriverName && { driverName: doDriverName }),
                            ...(doVehicleNo && { vehicleNo: doVehicleNo }),
                          },
                        });
                        if (d.success) {
                          invalidateCachePrefix("/api/delivery-orders");
                          invalidateCachePrefix("/api/sales-orders");
                          setTransferSuccess({ type: "do", docNo: (d.data?.doNo as string) || "Created" });
                          fetchAll();
                        } else {
                          toast.error(d.error || "Failed to create Delivery Order.");
                        }
                      } catch {
                        toast.error("Failed to create Delivery Order. Please try again.");
                      } finally {
                        setTransferLoading(false);
                      }
                    }}
                  >
                    {transferLoading ? "Creating..." : "Create DO"}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Transfer to Invoice Dialog */}
      {transferInvRow && matchedDO && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => { if (!transferLoading) { setTransferInvRow(null); setMatchedDO(null); } }} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-[#6B5C32]/10 flex items-center justify-center">
                  <FileText className="h-5 w-5 text-[#6B5C32]" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[#1F1D1B]">Transfer to Invoice</h2>
                  <p className="text-xs text-[#6B7280]">Generate invoice from {transferInvRow.companySOId}</p>
                </div>
              </div>
              <button
                onClick={() => { if (!transferLoading) { setTransferInvRow(null); setMatchedDO(null); } }}
                className="text-[#9CA3AF] hover:text-[#374151] transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {transferSuccess?.type === "inv" ? (
              <div className="p-6 text-center space-y-4">
                <div className="mx-auto h-16 w-16 rounded-full bg-[#EEF3E4] flex items-center justify-center">
                  <CheckCircle className="h-8 w-8 text-[#4F7C3A]" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-[#1F1D1B]">Invoice Created</h3>
                  <p className="text-xs text-[#6B7280] mt-0.5">Invoice No: <span className="font-mono font-semibold text-[#6B5C32]">{transferSuccess.docNo}</span></p>
                </div>
                <div className="flex justify-center gap-3 pt-2">
                  <Button variant="outline" onClick={() => { setTransferInvRow(null); setMatchedDO(null); setTransferSuccess(null); }}>Close</Button>
                  <Button variant="primary" onClick={() => { setTransferInvRow(null); setMatchedDO(null); setTransferSuccess(null); navigate("/invoices"); }}>
                    Go to Invoices
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {/* DO Info */}
                <div className="px-6 py-4 space-y-4">
                  <div className="bg-[#FAF9F7] rounded-lg p-4 border border-[#E2DDD8]">
                    <p className="text-xs text-[#9CA3AF] mb-2">Linked Delivery Order</p>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <span className="text-[#9CA3AF]">DO No.</span>
                        <p className="font-semibold text-[#1F1D1B]">{matchedDO.doNo}</p>
                      </div>
                      <div>
                        <span className="text-[#9CA3AF]">Status</span>
                        <p><Badge variant="status" status={matchedDO.status}>{matchedDO.status}</Badge></p>
                      </div>
                      <div>
                        <span className="text-[#9CA3AF]">Customer</span>
                        <p className="font-semibold text-[#1F1D1B]">{matchedDO.customerName}</p>
                      </div>
                      <div>
                        <span className="text-[#9CA3AF]">Items</span>
                        <p className="font-semibold text-[#1F1D1B]">{matchedDO.items.length} item(s)</p>
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-[#6B7280]">
                    This will generate an invoice based on the delivery order above. All items and pricing will be auto-populated from the sales order.
                  </p>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-[#E2DDD8] flex justify-end gap-3">
                  <Button variant="outline" onClick={() => { setTransferInvRow(null); setMatchedDO(null); }} disabled={transferLoading}>Cancel</Button>
                  <Button
                    variant="primary"
                    disabled={transferLoading}
                    onClick={async () => {
                      setTransferLoading(true);
                      try {
                        const d = await fetchJson("/api/invoices", InvoiceMutationSchema, {
                          method: "POST",
                          body: { deliveryOrderId: matchedDO.id },
                        });
                        if (d.success) {
                          invalidateCachePrefix("/api/invoices");
                          invalidateCachePrefix("/api/delivery-orders");
                          setTransferSuccess({ type: "inv", docNo: (d.data?.invoiceNo as string) || "Created" });
                          fetchAll();
                        } else {
                          toast.error(d.error || "Failed to create Invoice.");
                        }
                      } catch {
                        toast.error("Failed to create Invoice. Please try again.");
                      } finally {
                        setTransferLoading(false);
                      }
                    }}
                  >
                    {transferLoading ? "Creating..." : "Create Invoice"}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {/* Scan PO Modal */}
      <ScanPOModal
        open={scanPOOpen}
        onClose={() => setScanPOOpen(false)}
        onCreated={(soIds) => {
          toast.success(`Created ${soIds.length} Sales Order(s) from PO scan`);
          fetchAll();
        }}
      />
      {/* Bulk Items Review Modal — flat table of every DRAFT line item.
          Helps the operator scan productCode / fabric / config / qty
          across 50+ items at once after a Scan PO upload. */}
      {showItemReview && (
        <DraftItemsReviewModal
          orders={filteredOrders.filter((o) => o.status === "DRAFT")}
          onClose={() => setShowItemReview(false)}
          onOpenSO={(id) => {
            setShowItemReview(false);
            navigate(`${basePath}/${id}`);
          }}
        />
      )}
    </div>
  );
}

// =================================================================
// Draft Items Review Modal — single flat table of all draft line items
// =================================================================
function DraftItemsReviewModal({
  orders,
  onClose,
  onOpenSO,
}: {
  orders: SalesOrder[];
  onClose: () => void;
  onOpenSO: (id: string) => void;
}) {
  type Row = {
    soId: string;
    soNo: string;
    customerName: string;
    customerPO: string;
    customerDD: string;
    item: SalesOrder["items"][number];
  };
  const rows: Row[] = orders.flatMap((o) =>
    o.items.map((it) => ({
      soId: o.id,
      soNo: o.companySOId,
      customerName: o.customerName,
      customerPO: o.customerPOId || "",
      customerDD: o.customerDeliveryDate || "",
      item: it,
    })),
  );
  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-7xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <div>
            <h2 className="text-lg font-bold text-[#1F1D1B]">
              Draft items review · {rows.length} item{rows.length === 1 ? "" : "s"} across{" "}
              {orders.length} draft SO{orders.length === 1 ? "" : "s"}
            </h2>
            <p className="text-xs text-[#6B7280]">
              Click any row to open that SO. Use Ctrl+F in the table to search.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[#FAF9F7] border-b border-[#E2DDD8] z-10">
              <tr className="text-[#6B7280]">
                <th className="px-2 py-2 text-left">SO</th>
                <th className="px-2 py-2 text-left">Customer</th>
                <th className="px-2 py-2 text-left">PO</th>
                <th className="px-2 py-2 text-left">CDD</th>
                <th className="px-2 py-2 text-left">Cat</th>
                <th className="px-2 py-2 text-left">Product</th>
                <th className="px-2 py-2 text-left">Size</th>
                <th className="px-2 py-2 text-left">Fabric</th>
                <th className="px-2 py-2 text-center">Divan</th>
                <th className="px-2 py-2 text-center">Leg</th>
                <th className="px-2 py-2 text-center">Gap</th>
                <th className="px-2 py-2 text-left">Special</th>
                <th className="px-2 py-2 text-center">Qty</th>
                <th className="px-2 py-2 text-right">Price</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const it = r.item;
                return (
                  <tr
                    key={`${r.soId}-${it.id ?? i}`}
                    className="border-t border-[#E2DDD8] hover:bg-[#FAF9F7] cursor-pointer"
                    onClick={() => onOpenSO(r.soId)}
                  >
                    <td className="px-2 py-1.5 font-medium doc-number">{r.soNo}</td>
                    <td className="px-2 py-1.5">{r.customerName}</td>
                    <td className="px-2 py-1.5 doc-number">{r.customerPO || "—"}</td>
                    <td className="px-2 py-1.5">{r.customerDD ? formatDate(r.customerDD) : "—"}</td>
                    <td className="px-2 py-1.5">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#F3F4F6] text-[#374151]">
                        {(it.itemCategory || "BEDFRAME").slice(0, 2)}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 font-medium">{it.productCode || "—"}</td>
                    <td className="px-2 py-1.5">{it.sizeLabel || it.sizeCode || "—"}</td>
                    <td className="px-2 py-1.5">{it.fabricCode || "—"}</td>
                    <td className="px-2 py-1.5 text-center">
                      {it.divanHeightInches ?? "—"}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {it.legHeightInches != null ? `${it.legHeightInches}"` : "No Leg"}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {it.gapInches ?? "—"}
                    </td>
                    <td className="px-2 py-1.5">{it.specialOrder || "—"}</td>
                    <td className="px-2 py-1.5 text-center font-medium">{it.quantity}</td>
                    <td className="px-2 py-1.5 text-right doc-number">
                      {it.unitPriceSen
                        ? `RM ${(it.unitPriceSen / 100).toFixed(2)}`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-6 py-3 border-t border-[#E2DDD8] flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
