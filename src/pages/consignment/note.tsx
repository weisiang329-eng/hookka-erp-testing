// ---------------------------------------------------------------------------
// Consignment Notes (CN) page — refactored 2026-04-28 to mirror the
// Delivery Orders (DO) page at src/pages/delivery/index.tsx.
//
// Domain mapping (Hookka has two parallel post-production flows):
//   Sales Order      (SO)  ↔  Consignment Order (CO)        — `/api/consignment-orders`
//   Delivery Order   (DO)  ↔  Consignment Note  (CN)        — `/api/consignment-notes`
//   PO source on prod_orders.salesOrderId  ↔  prod_orders.consignmentOrderId
//
// Why the mirror: the user sees DO and CN as two visually identical
// post-production dispatch boards — one for SO-origin furniture, one for
// CO-origin (consignment). Before this refactor, CN was a barebones list
// missing the KPI strip, the planning tabs, the "Production Complete →
// Ready for CN" panel, and the polished DataGrid columns. Operators
// complained the two pages "look different" — this commit aligns them.
//
// Backend constraints (kept as-is per task scope):
//   - CN backend (consignment_notes table) does NOT yet store
//     dispatchedAt / deliveredAt / driverId / vehicleId. The legacy CN
//     status enum (ACTIVE/PARTIALLY_SOLD/FULLY_SOLD/RETURNED/CLOSED) is
//     mapped to the DO-style lifecycle below; transport columns render
//     "—" until the backend grows those columns. Documented for follow-up.
//   - CN does NOT store productionOrderId or consignmentOrderId, so
//     the Pending-CN dedup is approximate (matches by customer + CO
//     existence rather than per-PO linkage). Same caveat documented.
// ---------------------------------------------------------------------------
import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useUrlState, useUrlStateNumber } from "@/lib/use-url-state";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import {
  Package,
  PackageCheck,
  Truck,
  Send,
  CheckCircle2,
  Eye,
  Printer,
  RefreshCw,
  Download,
  FileText,
  RotateCcw,
  X,
  ClipboardList,
} from "lucide-react";
import type { ConsignmentNote } from "@/lib/mock-data";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// CN lifecycle in the UI mirrors DO's 4-stage flow. The legacy
// ACTIVE/PARTIALLY_SOLD/FULLY_SOLD/CLOSED states from consignment_notes
// are mapped onto these codes for display; backend stores the legacy
// codes unchanged. See cnStatusFromBackend() below.
type CNStatus = "PENDING" | "DISPATCHED" | "IN_TRANSIT" | "DELIVERED" | "ACKNOWLEDGED";

// View-model for one row in the CN DataGrid. Mirrors DeliveryOrderRow on
// the DO page — every field has a parallel meaning, with SO/DO swapped
// for CO/CN respectively.
type ConsignmentNoteRow = {
  id: string;             // CN id (for API + row key) — DO equivalent: doNo
  cnNo: string;           // CON-YYMM-XXX — DO equivalent: doNo
  coRef: string;          // parent CO's company id (CO-YY###) — DO equiv: companySO
  consignmentId: string;  // parent CO id (for drill-through) — DO equiv: salesOrderId
  customerId: string;
  customerName: string;
  branchName: string;     // CN destination branch — DO equiv: hubState/hubBranch
  itemCount: number;
  totalQty: number;
  totalValueSen: number;
  dispatchDate: string | null;
  deliveredDate: string | null;
  status: CNStatus;
  // Transport fields — backend doesn't store these on CN today, but the
  // columns are rendered (showing "—") so the layout matches DO and the
  // schema can grow into them without UI changes. DO equivalents:
  // driverId/driverName/vehicleNo.
  driverCompany: string;
  driverName: string;
  vehicleNo: string;
  remarks: string;
};

// CN status mapping. See note on CNStatus above for why we re-skin the
// legacy status enum into a DO-shaped lifecycle.
function cnStatusFromBackend(s: string | undefined | null): CNStatus {
  switch (s) {
    case "ACTIVE": return "PENDING";          // created, not yet dispatched
    case "PARTIALLY_SOLD": return "DISPATCHED"; // some items left the warehouse
    case "FULLY_SOLD": return "DELIVERED";    // all items delivered to branch
    case "RETURNED": return "DELIVERED";      // returns are still "delivered" from a logistics view
    case "CLOSED": return "ACKNOWLEDGED";     // branch confirmed receipt and closed
    default: return "PENDING";
  }
}

// ---------------------------------------------------------------------------
// Status helpers — labels match DO so operators see the same phrase across
// both boards.
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<CNStatus, string> = {
  PENDING: "Pending Dispatch",
  DISPATCHED: "Dispatched",
  IN_TRANSIT: "In Transit",
  DELIVERED: "Delivered",
  ACKNOWLEDGED: "Acknowledged",
};

// 6-stage CN workflow tabs. Mirrors DO's ALL_TABS structure:
//   Planning           — POs from CO that are still in production (no upholstery done)
//   Pending CN         — POs production-complete, no CN yet (DO equiv: Pending Delivery)
//   Pending Dispatch   — CN created, not yet dispatched (DO equiv: same name)
//   Dispatched         — CN dispatched, in transit
//   Delivered          — CN delivered to branch
//   Acknowledged       — branch confirmed receipt (DO equiv: Invoice — but CN doesn't generate invoices on dispatch)
const ALL_TABS = [
  { key: "planning", label: "Planning" },
  { key: "pending_cn", label: "Pending CN" },
  { key: "pending_dispatch", label: "Pending Dispatch" },
  { key: "dispatched", label: "Dispatched" },
  { key: "delivered", label: "Delivered" },
  { key: "acknowledged", label: "Acknowledged" },
] as const;

// Which CN statuses map to which CN-list tab. Planning + Pending CN are
// PO-based tabs (show production_orders, not consignment_notes) — handled
// in PO_TABS below.
const TAB_CN_STATUSES: Record<string, CNStatus[]> = {
  pending_dispatch: ["PENDING"],
  dispatched: ["DISPATCHED", "IN_TRANSIT"],
  delivered: ["DELIVERED"],
  acknowledged: ["ACKNOWLEDGED"],
};

const PO_TABS = new Set(["planning", "pending_cn"]);

// ---------------------------------------------------------------------------
// Production order row (used for Planning + Pending CN tabs). Mirrors
// ReadyPORow on the DO page — same shape, same display rules. The CO
// equivalent of an SO is surfaced via consignmentOrderId / companyCOId
// (production_orders columns added in migration 0064).
// ---------------------------------------------------------------------------
type ReadyPORow = {
  id: string;
  poNo: string;
  consignmentOrderId: string;       // CO id — DO equiv: salesOrderId
  consignmentOrderNo: string;       // companyCOId (CO-YY###) — DO equiv: salesOrderNo
  customerId: string;
  customerName: string;
  customerState: string;
  productCode: string;
  productName: string;
  itemCategory: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  unitM3: number;
  completedDate: string | null;
  uphCompletedDate: string | null;
  rackingNumber: string;
  hookkaExpectedDD: string;
  currentDepartment: string;
  progress: number;
};

// Same line-set rule as DO: Sofa POs span variant suffixes for one set,
// Bedframe / Accessory POs are 1 PO = 1 piece. Display the CO ID without
// the -NN suffix for sofa rows so a 4-piece set reads as one line.
function displayCoId(row: { poNo: string; itemCategory: string }): string {
  if ((row.itemCategory || "").toUpperCase() === "SOFA") {
    return row.poNo.replace(/-\d+$/, "");
  }
  return row.poNo;
}

type ProductionOrderApiShape = {
  id: string;
  poNo: string;
  salesOrderId?: string;
  salesOrderNo?: string;
  companySOId?: string;
  consignmentOrderId?: string;
  companyCOId?: string;
  customerId?: string;
  customerName?: string;
  customerState?: string;
  productCode?: string;
  productName?: string;
  itemCategory?: string;
  sizeLabel?: string;
  fabricCode?: string;
  quantity?: number;
  status: string;
  currentDepartment?: string;
  progress?: number;
  completedDate?: string | null;
  targetEndDate?: string;
  rackingNumber?: string;
  jobCards?: { departmentCode: string; status: string; completedDate?: string | null }[];
};

// Shape we read from /api/consignment-orders so we can join hookkaExpectedDD
// onto each Pending-CN row (same trick DO uses with /api/sales-orders).
type ConsignmentOrderApiShape = {
  id: string;
  hookkaExpectedDD?: string;
  companyCOId?: string;
  customerId?: string;
};

// ---------------------------------------------------------------------------
// Map ConsignmentNote (legacy backend shape) → ConsignmentNoteRow.
// Equivalent to DO's mapDOToRow.
// ---------------------------------------------------------------------------

function mapCNToRow(cn: ConsignmentNote): ConsignmentNoteRow {
  const totalQty = cn.items.reduce((s, i) => s + i.quantity, 0);
  // Backend currently stores noteNumber as both the CN identifier AND
  // the closest thing to a CO ref (legacy CN had no separate CO concept).
  // When the schema grows a real consignmentOrderId column we'll prefer
  // that; until then, use noteNumber for both fields so the column
  // renders something rather than blank.
  return {
    id: cn.id,
    cnNo: cn.noteNumber,
    coRef: cn.noteNumber,
    consignmentId: cn.id,
    customerId: cn.customerId,
    customerName: cn.customerName,
    branchName: cn.branchName,
    itemCount: cn.items.length,
    totalQty,
    totalValueSen: cn.totalValue,
    dispatchDate: cn.sentDate || null,
    deliveredDate: null, // not tracked in legacy schema
    status: cnStatusFromBackend(cn.status),
    driverCompany: "",
    driverName: "",
    vehicleNo: "",
    remarks: cn.notes || "",
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ConsignmentNotePage() {
  const { toast } = useToast();
  const navigate = useNavigate();

  // Top-level page tab. CN page has no "3PL Providers" sister section
  // (that's owned by the DO page), so we skip the second tab — but keep
  // the variable so future expansion is symmetric with DO.
  const [pageTab] = useUrlState<"orders">("section", "orders");
  void pageTab;

  // Active inner tab — URL-synced so refresh and back/forward keep position.
  const [activeTab, setActiveTab] = useUrlState<string>("tab", "planning");

  // ----- Data state (mirrors DO) -----
  const [cnList, setCnList] = useState<ConsignmentNoteRow[]>([]);
  const [planningPOs, setPlanningPOs] = useState<ReadyPORow[]>([]);
  const [readyPOs, setReadyPOs] = useState<ReadyPORow[]>([]);
  const [loading, setLoading] = useState(true);

  // ----- Detail / dialog state -----
  const [detailCN, setDetailCN] = useState<ConsignmentNoteRow | null>(null);

  // Transfer dialogs (preserved from the original CN page — these flows
  // still work and the user expects them in the right-click menu).
  const [transferDORow, setTransferDORow] = useState<ConsignmentNoteRow | null>(null);
  const [transferDOLoading, setTransferDOLoading] = useState(false);
  const [transferCRRow, setTransferCRRow] = useState<ConsignmentNoteRow | null>(null);
  const [transferCRLoading, setTransferCRLoading] = useState(false);
  const [crReturnQtys, setCrReturnQtys] = useState<Record<string, number>>({});
  const [crSelectedItems, setCrSelectedItems] = useState<Record<string, boolean>>({});
  const [transferSIRow, setTransferSIRow] = useState<ConsignmentNoteRow | null>(null);
  const [transferSILoading, setTransferSILoading] = useState(false);

  // ----- Selection (Pending CN list) -----
  const [selectedReadyPOs, setSelectedReadyPOs] = useState<Set<string>>(new Set());
  const [creatingCNFromPO, setCreatingCNFromPO] = useState(false);

  // ----- Inline Expected DD editing on Planning / Pending CN -----
  const [editingDDId, setEditingDDId] = useState<string | null>(null);
  const [editingDDValue, setEditingDDValue] = useState("");

  // ---------- Pagination ----------
  // Same rationale as DO: 200 page size keeps daily working set on page 1.
  const PAGE_SIZE = 200;
  const [page, setPage] = useUrlStateNumber("page", 1);

  // ---------- Fetch ----------
  // Pull CN list from /api/consignment-notes (legacy CN dispatch table).
  const { data: cnRaw, loading: cnLoading, refresh: refreshCNs } = useCachedJson<{
    success?: boolean;
    data?: ConsignmentNote[];
  }>(`/api/consignment-notes?page=${page}&limit=${PAGE_SIZE}`);

  // Pull POs to build Planning + Pending CN tabs. Same endpoint DO uses,
  // but we filter for `consignmentOrderId` set instead of `salesOrderId`.
  const { data: poRaw, loading: poLoading, refresh: refreshPOs } =
    useCachedJson<{ success?: boolean; data?: ProductionOrderApiShape[] }>("/api/production-orders");

  // Pull CO list for hookkaExpectedDD + companyCOId join (DO uses
  // /api/sales-orders for the same purpose).
  const { data: coOrdersRaw, loading: coOrdersLoading, refresh: refreshCOs } =
    useCachedJson<{ success?: boolean; data?: ConsignmentOrderApiShape[] }>("/api/consignment-orders");

  // Product master for per-unit m³ — same source DO uses.
  const { data: prodRaw, loading: prodLoading, refresh: refreshProducts } =
    useCachedJson<{ success?: boolean; data?: { code: string; unitM3: number }[] }>("/api/products");

  const fetchData = useCallback(() => {
    invalidateCachePrefix("/api/consignment-notes");
    invalidateCachePrefix("/api/consignment-orders");
    invalidateCachePrefix("/api/production-orders");
    invalidateCachePrefix("/api/products");
    refreshCNs();
    refreshCOs();
    refreshPOs();
    refreshProducts();
  }, [refreshCNs, refreshCOs, refreshPOs, refreshProducts]);

  // Lookup: productCode → unitM3 (mirrors DO's productM3Map).
  const productM3Map = useMemo(() => {
    const m = new Map<string, number>();
    const arr = prodRaw?.success ? prodRaw.data : null;
    if (Array.isArray(arr)) {
      for (const p of arr) {
        if (p?.code) m.set(p.code, Number(p.unitM3) || 0);
      }
    }
    return m;
  }, [prodRaw]);

  // Mirror SWR data → local state. Same eslint suppression as DO.
  /* eslint-disable react-hooks/set-state-in-effect -- mirror SWR data into mutable local state for optimistic UI */
  useEffect(() => {
    const anyLoading = cnLoading || poLoading || coOrdersLoading || prodLoading;
    setLoading(anyLoading);

    // Map CN rows
    if (cnRaw?.success && Array.isArray(cnRaw.data)) {
      setCnList((cnRaw.data as ConsignmentNote[]).map(mapCNToRow));
    }

    // Build PO-based tab data (Planning + Pending CN)
    if (poRaw?.success && Array.isArray(poRaw.data)) {
      // CO lookup map for hookkaExpectedDD + companyCOId join.
      const coMap = new Map<string, { hookkaExpectedDD: string; companyCOId: string; customerId: string }>();
      if (coOrdersRaw?.success && Array.isArray(coOrdersRaw.data)) {
        for (const co of coOrdersRaw.data) {
          coMap.set(co.id, {
            hookkaExpectedDD: co.hookkaExpectedDD || "",
            companyCOId: co.companyCOId || "",
            customerId: co.customerId || "",
          });
        }
      }

      // CN dedup approximation: backend doesn't link CN ↔ PO ↔ CO yet,
      // so we can't filter "PO is on a non-cancelled CN" the way DO
      // does for DOs. Best-effort fallback: dedup by customer match on
      // any CN with status PENDING/DISPATCHED — coarse but better than
      // nothing. Documented as a follow-up: add productionOrderId or
      // consignmentOrderId column to consignment_notes.
      const cnLinkedCustomers = new Set<string>();
      if (cnRaw?.success && Array.isArray(cnRaw.data)) {
        for (const cn of cnRaw.data as ConsignmentNote[]) {
          if (cn.status === "ACTIVE" || cn.status === "PARTIALLY_SOLD") {
            cnLinkedCustomers.add(cn.customerId);
          }
        }
      }

      const allPOs = poRaw.data as ProductionOrderApiShape[];

      const mapPO = (po: ProductionOrderApiShape): ReadyPORow => {
        const coInfo = coMap.get(po.consignmentOrderId || "");
        return {
          id: po.id,
          poNo: po.poNo,
          consignmentOrderId: po.consignmentOrderId || "",
          consignmentOrderNo: po.companyCOId || coInfo?.companyCOId || "",
          customerId: po.customerId || coInfo?.customerId || "",
          customerName: po.customerName || "",
          customerState: po.customerState || "",
          productCode: po.productCode || "",
          productName: po.productName || "",
          itemCategory: po.itemCategory || "",
          sizeLabel: po.sizeLabel || "",
          fabricCode: po.fabricCode || "",
          quantity: po.quantity || 0,
          unitM3: productM3Map.get(po.productCode || "") ?? 0,
          completedDate: po.completedDate || null,
          uphCompletedDate: (() => {
            const uphCards = (po.jobCards || []).filter((j) => j.departmentCode === "UPHOLSTERY");
            if (uphCards.length === 0) return null;
            const dates = uphCards.map((j) => j.completedDate).filter((d): d is string => !!d);
            return dates.length > 0 ? dates.sort().reverse()[0] : null;
          })(),
          rackingNumber: po.rackingNumber || "",
          hookkaExpectedDD: coInfo?.hookkaExpectedDD || po.targetEndDate || "",
          currentDepartment: po.currentDepartment || "",
          progress: po.progress || 0,
        };
      };

      // Planning: CO-origin POs still in production (upholstery not yet
      // complete). Mirrors DO's "planning" filter but on consignmentOrderId.
      const planning = allPOs
        .filter((po) => {
          if (po.status === "COMPLETED" || po.status === "CANCELLED") return false;
          if (!po.consignmentOrderId) return false; // SO-origin POs go to DO page
          const uphCards = (po.jobCards || []).filter((j) => j.departmentCode === "UPHOLSTERY");
          if (uphCards.length === 0) return false;
          return uphCards.some((j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED");
        })
        .map(mapPO);
      setPlanningPOs(planning);

      // Pending CN: CO-origin POs with all upholstery done, no CN yet
      // for that customer. Mirrors DO's "Ready for DO" — see dedup
      // caveat above.
      const ready = allPOs
        .filter((po) => {
          if (po.status === "CANCELLED") return false;
          if (!po.consignmentOrderId) return false;
          const uphCards = (po.jobCards || []).filter((j) => j.departmentCode === "UPHOLSTERY");
          if (uphCards.length === 0) return false;
          return uphCards.every((j) => j.status === "COMPLETED" || j.status === "TRANSFERRED");
        })
        .filter((po) => !cnLinkedCustomers.has(po.customerId || ""))
        .map(mapPO);
      setReadyPOs(ready);
    }
  }, [cnRaw, poRaw, coOrdersRaw, cnLoading, poLoading, coOrdersLoading, prodLoading, productM3Map]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ---------- Filtered data (CN-list tabs only) ----------
  const filteredCNs = useMemo(() => {
    const statuses = TAB_CN_STATUSES[activeTab];
    if (!statuses) return []; // PO-based tab — no CN rows
    return cnList.filter((c) => statuses.includes(c.status));
  }, [cnList, activeTab]);

  // ---------- Summary counts (mirrors DO's KPI strip) ----------
  // Counts pulled from the loaded CN list. CN backend has no /stats
  // endpoint yet, so we compute client-side. Will move to server-side
  // counts once /api/consignment-notes/stats lands (follow-up).
  const pendingDispatchCount = useMemo(
    () => cnList.filter((c) => c.status === "PENDING").length,
    [cnList],
  );
  const dispatchedCount = useMemo(
    () => cnList.filter((c) => c.status === "DISPATCHED").length,
    [cnList],
  );
  const inTransitCount = useMemo(
    () => cnList.filter((c) => c.status === "IN_TRANSIT").length,
    [cnList],
  );
  const deliveredMTD = useMemo(() => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    return cnList.filter(
      (c) =>
        c.status === "DELIVERED" &&
        c.deliveredDate &&
        new Date(c.deliveredDate) >= startOfMonth,
    ).length;
  }, [cnList]);
  // Pending-CN count ignores the customer dedup since the user wants to
  // see the raw pipeline pressure.
  const pendingCNCount = readyPOs.length;

  // ---------- Pending Dispatch (Pending CN) → Create CN ----------
  // Mirrors DO's Create-DO flow but POSTs to /api/consignment-notes.
  // Backend's POST shape is permissive (it accepts customerId + items)
  // — we synthesize one CN per (customerId+CO) group from the selected
  // POs, with line items derived from PO data.
  const openCreateCN = useCallback(
    async (pos: ReadyPORow[]) => {
      if (pos.length === 0) return;
      setCreatingCNFromPO(true);
      try {
        // Group selected POs by customer — one CN per customer batch.
        // (Multi-customer in one CN doesn't make sense — each CN has a
        // single branch destination.)
        const byCustomer = new Map<string, ReadyPORow[]>();
        for (const po of pos) {
          const key = po.customerId || "_unknown";
          const arr = byCustomer.get(key) || [];
          arr.push(po);
          byCustomer.set(key, arr);
        }

        let okCount = 0;
        for (const [, group] of byCustomer.entries()) {
          const first = group[0];
          const body = {
            type: "OUT",
            customerId: first.customerId,
            customerName: first.customerName,
            branchName: first.customerState || "Branch",
            sentDate: new Date().toISOString().split("T")[0],
            notes: `Auto-created from CO ${first.consignmentOrderNo} on Pending CN dispatch`,
            items: group.map((po) => ({
              productId: "",
              productName: po.productName,
              productCode: po.productCode,
              quantity: po.quantity,
              unitPrice: 0, // CN unit price not tracked at PO level — future: pull from CO line items
            })),
          };
          const res = await fetch("/api/consignment-notes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (res.ok) okCount += 1;
        }
        if (okCount > 0) {
          toast.success(`Created ${okCount} consignment note${okCount === 1 ? "" : "s"}`);
        } else {
          toast.error("Failed to create consignment notes");
        }
      } catch {
        toast.error("Failed to create consignment notes");
      } finally {
        setCreatingCNFromPO(false);
        setSelectedReadyPOs(new Set());
        fetchData();
      }
    },
    [fetchData, toast],
  );

  // ---------- Inline Expected DD update on the CO ----------
  // DO updates SO.hookkaExpectedDD via PUT /api/sales-orders/:id; same
  // pattern here against /api/consignment-orders/:id.
  const updateExpectedDD = useCallback(
    async (consignmentOrderId: string, newDate: string, rowId: string) => {
      if (!consignmentOrderId) return;
      try {
        const res = await fetch(`/api/consignment-orders/${consignmentOrderId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hookkaExpectedDD: newDate }),
        });
        if (res.ok) {
          setPlanningPOs((prev) =>
            prev.map((r) => (r.id === rowId ? { ...r, hookkaExpectedDD: newDate } : r)),
          );
          setReadyPOs((prev) =>
            prev.map((r) => (r.id === rowId ? { ...r, hookkaExpectedDD: newDate } : r)),
          );
        }
      } catch {
        /* swallow — same pattern as DO */
      } finally {
        setEditingDDId(null);
      }
    },
    [],
  );

  // ---------- Planning columns (CO-origin POs in production) ----------
  // 1:1 mirror of DO's planningColumns with SO → CO renames.
  const planningColumns: Column<ReadyPORow>[] = useMemo(
    () => [
      { key: "consignmentOrderNo", label: "CO No.", type: "docno", width: "130px", sortable: true },
      {
        key: "poNo",
        label: "CO ID",
        type: "docno",
        width: "150px",
        sortable: true,
        render: (_v, row) => <span className="doc-number">{displayCoId(row)}</span>,
      },
      { key: "productCode", label: "Product Code", type: "docno", width: "110px", sortable: true },
      { key: "productName", label: "Product", type: "text", sortable: true },
      { key: "sizeLabel", label: "Size", type: "text", width: "80px", sortable: true },
      { key: "fabricCode", label: "Fabric", type: "text", width: "80px", sortable: true },
      { key: "customerName", label: "Customer", type: "text", width: "120px", sortable: true },
      { key: "customerState", label: "State", type: "text", width: "60px", sortable: true },
      { key: "quantity", label: "Qty", type: "number", width: "60px", align: "right", sortable: true },
      {
        key: "unitM3",
        label: "Unit (m³)",
        type: "number",
        width: "100px",
        align: "right",
        sortable: true,
        render: (_v, row) => (
          <span className="tabular-nums">{(row.unitM3 ?? 0).toFixed(3)}</span>
        ),
      },
      { key: "currentDepartment", label: "Current Dept", type: "text", width: "100px", sortable: true },
      {
        key: "progress",
        label: "Progress",
        type: "number",
        width: "120px",
        align: "right",
        sortable: true,
        render: (_v, row) => (
          <div className="flex items-center gap-1.5 justify-end">
            <div className="w-14 h-1.5 bg-[#E2DDD8] rounded-full overflow-hidden">
              <div className="h-full bg-[#6B5C32] rounded-full" style={{ width: `${row.progress}%` }} />
            </div>
            <span className="text-xs tabular-nums text-[#6B7280]">{row.progress}%</span>
          </div>
        ),
      },
      {
        key: "hookkaExpectedDD",
        label: "Expected DD",
        type: "date",
        width: "110px",
        sortable: true,
        render: (_v, row) => {
          if (editingDDId === row.id) {
            return (
              <input
                type="date"
                autoFocus
                value={editingDDValue}
                className="h-7 w-[120px] text-xs rounded border border-[#E2DDD8] px-1.5 focus:outline-none focus:border-[#6B5C32]"
                onChange={(e) => setEditingDDValue(e.target.value)}
                onBlur={() => {
                  if (editingDDValue) {
                    updateExpectedDD(row.consignmentOrderId, editingDDValue, row.id);
                  } else {
                    setEditingDDId(null);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (editingDDValue) {
                      updateExpectedDD(row.consignmentOrderId, editingDDValue, row.id);
                    } else {
                      setEditingDDId(null);
                    }
                  } else if (e.key === "Escape") {
                    setEditingDDId(null);
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            );
          }
          const isOverdue = row.hookkaExpectedDD && new Date(row.hookkaExpectedDD) < new Date();
          return (
            <span
              className={`cursor-pointer hover:underline hover:text-[#6B5C32] ${isOverdue ? "text-[#9A3A2D] font-medium" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setEditingDDId(row.id);
                setEditingDDValue(row.hookkaExpectedDD ? row.hookkaExpectedDD.slice(0, 10) : "");
              }}
            >
              {row.hookkaExpectedDD ? formatDate(row.hookkaExpectedDD) : <span className="text-[#9CA3AF]">—</span>}
            </span>
          );
        },
      },
    ],
    [editingDDId, editingDDValue, updateExpectedDD],
  );

  // ---------- Pending CN columns (CO-origin POs ready for CN) ----------
  // 1:1 mirror of DO's pendingDeliveryColumns. SO → CO rename.
  const pendingCNColumns: Column<ReadyPORow>[] = useMemo(
    () => [
      { key: "consignmentOrderNo", label: "CO No.", type: "docno", width: "130px", sortable: true },
      {
        key: "poNo",
        label: "CO ID",
        type: "docno",
        width: "150px",
        sortable: true,
        render: (_v, row) => <span className="doc-number">{displayCoId(row)}</span>,
      },
      { key: "productCode", label: "Product Code", type: "docno", width: "110px", sortable: true },
      { key: "productName", label: "Product", type: "text", sortable: true },
      { key: "sizeLabel", label: "Size", type: "text", width: "80px", sortable: true },
      { key: "fabricCode", label: "Fabric", type: "text", width: "80px", sortable: true },
      { key: "customerName", label: "Customer", type: "text", width: "120px", sortable: true },
      { key: "customerState", label: "State", type: "text", width: "60px", sortable: true },
      { key: "quantity", label: "Qty", type: "number", width: "60px", align: "right", sortable: true },
      {
        key: "unitM3",
        label: "Unit (m³)",
        type: "number",
        width: "100px",
        align: "right",
        sortable: true,
        render: (_v, row) => (
          <span className="tabular-nums">{(row.unitM3 ?? 0).toFixed(3)}</span>
        ),
      },
      { key: "rackingNumber", label: "Rack", type: "text", width: "80px", sortable: true },
      {
        key: "uphCompletedDate",
        label: "Uph. Completed",
        type: "date",
        width: "120px",
        sortable: true,
        render: (_v, row) => (
          <span className="tabular-nums">{row.uphCompletedDate ? formatDate(row.uphCompletedDate) : "-"}</span>
        ),
      },
      {
        key: "hookkaExpectedDD",
        label: "Expected DD",
        type: "date",
        width: "110px",
        sortable: true,
        render: (_v, row) => {
          if (editingDDId === row.id) {
            return (
              <input
                type="date"
                autoFocus
                value={editingDDValue}
                className="h-7 w-[120px] text-xs rounded border border-[#E2DDD8] px-1.5 focus:outline-none focus:border-[#6B5C32]"
                onChange={(e) => setEditingDDValue(e.target.value)}
                onBlur={() => {
                  if (editingDDValue) {
                    updateExpectedDD(row.consignmentOrderId, editingDDValue, row.id);
                  } else {
                    setEditingDDId(null);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (editingDDValue) {
                      updateExpectedDD(row.consignmentOrderId, editingDDValue, row.id);
                    } else {
                      setEditingDDId(null);
                    }
                  } else if (e.key === "Escape") {
                    setEditingDDId(null);
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            );
          }
          const isOverdue = row.hookkaExpectedDD && new Date(row.hookkaExpectedDD) < new Date();
          return (
            <span
              className={`cursor-pointer hover:underline hover:text-[#6B5C32] ${isOverdue ? "text-[#9A3A2D] font-medium" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setEditingDDId(row.id);
                setEditingDDValue(row.hookkaExpectedDD ? row.hookkaExpectedDD.slice(0, 10) : "");
              }}
            >
              {row.hookkaExpectedDD ? formatDate(row.hookkaExpectedDD) : <span className="text-[#9CA3AF]">—</span>}
            </span>
          );
        },
      },
    ],
    [editingDDId, editingDDValue, updateExpectedDD],
  );

  // ---------- CN columns (bottom DataGrid for CN list tabs) ----------
  // Mirrors DO's columns array. SO → CO rename for the "Sales Orders"
  // column ("Consignment Orders" here). Transport columns render "—"
  // until the backend grows those fields — see top-of-file note.
  const cnColumns: Column<ConsignmentNoteRow>[] = useMemo(
    () => [
      {
        key: "dispatchDate",
        label: "Dispatch Date",
        type: "date",
        width: "120px",
        sortable: true,
        render: (_value, row) => (
          <span>{row.dispatchDate ? formatDate(row.dispatchDate) : <span className="text-[#9CA3AF]">-</span>}</span>
        ),
      },
      { key: "cnNo", label: "CN No.", type: "docno", width: "130px", sortable: true },
      {
        key: "customerName",
        label: "Customers",
        type: "text",
        width: "150px",
        sortable: true,
        render: (_value, row) => <span className="text-[#1F1D1B]">{row.customerName || "-"}</span>,
      },
      {
        key: "branchName",
        label: "State",
        type: "text",
        width: "100px",
        sortable: true,
        render: (_value, row) => (
          <span className="text-[#4B5563]">{row.branchName || "-"}</span>
        ),
      },
      {
        key: "coRef",
        label: "Consignment Orders",
        type: "text",
        width: "180px",
        sortable: true,
        render: (_value, row) => (
          <button
            type="button"
            className="doc-number text-[#6B5C32] hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/consignment/${row.consignmentId}`);
            }}
            title="Open parent Consignment Order"
          >
            {row.coRef}
          </button>
        ),
      },
      {
        key: "status",
        label: "Status",
        type: "status",
        width: "180px",
        sortable: true,
        render: (_value, row) => (
          <div className="flex flex-col gap-0.5 text-xs leading-tight">
            <span className="font-medium">{STATUS_LABEL[row.status] ?? row.status}</span>
            <span className="text-[#9CA3AF] tabular-nums">
              {row.itemCount} item{row.itemCount === 1 ? "" : "s"} · {formatCurrency(row.totalValueSen)}
            </span>
          </div>
        ),
      },
      // Transport columns — placeholders until backend grows the fields.
      // Same column widths as DO so the two grids visually align.
      {
        key: "driverCompany",
        label: "Transport Co.",
        type: "text",
        width: "180px",
        sortable: true,
        render: (_value, row) => (
          <span className="text-[#1F1D1B]">{row.driverCompany || <span className="text-[#9CA3AF]">—</span>}</span>
        ),
      },
      {
        key: "driverName",
        label: "Driver",
        type: "text",
        width: "120px",
        sortable: true,
        render: (_value, row) => (
          <span className="text-[#4B5563]">{row.driverName || <span className="text-[#9CA3AF]">—</span>}</span>
        ),
      },
      {
        key: "vehicleNo",
        label: "Vehicle",
        type: "text",
        width: "110px",
        sortable: true,
        render: (_value, row) => (
          <span className="font-mono text-[#1F1D1B]">{row.vehicleNo || <span className="text-[#9CA3AF]">—</span>}</span>
        ),
      },
    ],
    [navigate],
  );

  // ---------- Context menu for CN rows ----------
  const getContextMenuItems = useCallback(
    (row: ConsignmentNoteRow): ContextMenuItem[] => [
      {
        label: "View Details",
        icon: <Eye className="h-3.5 w-3.5" />,
        action: () => setDetailCN(row),
      },
      {
        label: "Print CN",
        icon: <Printer className="h-3.5 w-3.5" />,
        action: () => toast.info(`Printing CN: ${row.cnNo} — coming soon`),
      },
      { label: "", separator: true, action: () => {} },
      // Mark Dispatched — flips ACTIVE → PARTIALLY_SOLD on the backend
      // (which we re-skin as PENDING → DISPATCHED in the UI). Same
      // transition the DO board offers as DRAFT → LOADED.
      {
        label: "Mark Dispatched",
        icon: <Send className="h-3.5 w-3.5" />,
        disabled: row.status !== "PENDING",
        action: async () => {
          try {
            const res = await fetch("/api/consignment-notes", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: row.id, status: "PARTIALLY_SOLD" }),
            });
            if (!res.ok) {
              toast.error("Failed to mark dispatched");
            } else {
              fetchData();
            }
          } catch {
            toast.error("Failed to mark dispatched");
          }
        },
      },
      {
        label: "Mark Delivered",
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
        disabled: row.status !== "DISPATCHED" && row.status !== "IN_TRANSIT",
        action: async () => {
          try {
            const res = await fetch("/api/consignment-notes", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: row.id, status: "FULLY_SOLD" }),
            });
            if (!res.ok) {
              toast.error("Failed to mark delivered");
            } else {
              fetchData();
            }
          } catch {
            toast.error("Failed to mark delivered");
          }
        },
      },
      {
        label: "Mark Acknowledged",
        icon: <PackageCheck className="h-3.5 w-3.5" />,
        disabled: row.status !== "DELIVERED",
        action: async () => {
          try {
            const res = await fetch("/api/consignment-notes", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: row.id, status: "CLOSED" }),
            });
            if (!res.ok) {
              toast.error("Failed to mark acknowledged");
            } else {
              fetchData();
            }
          } catch {
            toast.error("Failed to mark acknowledged");
          }
        },
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Transfer to Delivery Order",
        icon: <Truck className="h-3.5 w-3.5" />,
        action: () => setTransferDORow(row),
      },
      {
        label: "Transfer to Sales Invoice",
        icon: <FileText className="h-3.5 w-3.5" />,
        action: () => setTransferSIRow(row),
      },
      {
        label: "Transfer to Consignment Return",
        icon: <RotateCcw className="h-3.5 w-3.5" />,
        action: () => {
          const qtys: Record<string, number> = {};
          const selected: Record<string, boolean> = {};
          for (let i = 0; i < row.itemCount; i++) {
            const key = `${row.id}-item-${i}`;
            qtys[key] = 1;
            selected[key] = true;
          }
          setCrReturnQtys(qtys);
          setCrSelectedItems(selected);
          setTransferCRRow(row);
        },
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Refresh",
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        action: () => fetchData(),
      },
    ],
    [fetchData, toast],
  );

  // ---------- Tab counts (mirrors DO) ----------
  const tabCounts: Record<string, number> = {
    planning: planningPOs.length,
    pending_cn: pendingCNCount,
    pending_dispatch: pendingDispatchCount,
    dispatched: dispatchedCount + inTransitCount,
    delivered: cnList.filter((c) => c.status === "DELIVERED").length,
    acknowledged: cnList.filter((c) => c.status === "ACKNOWLEDGED").length,
  };

  // ---------- Pagination derivations ----------
  const totalCNs = cnList.length;
  const totalPages = Math.max(1, Math.ceil(totalCNs / PAGE_SIZE));

  // ---------- Transfer Handlers (preserved from original) ----------
  const handleTransferToDO = async () => {
    if (!transferDORow) return;
    setTransferDOLoading(true);
    // eslint-disable-next-line no-restricted-syntax -- UX pacing delay inside async event handler
    await new Promise((r) => setTimeout(r, 600));
    setTransferDOLoading(false);
    setTransferDORow(null);
    navigate("/delivery");
  };

  const handleTransferToCR = async () => {
    if (!transferCRRow) return;
    const selectedCount = Object.values(crSelectedItems).filter(Boolean).length;
    if (selectedCount === 0) {
      toast.warning("Please select at least one item to return.");
      return;
    }
    setTransferCRLoading(true);
    try {
      const res = await fetch("/api/consignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "RETURN",
          sourceId: transferCRRow.consignmentId,
          customerId: transferCRRow.customerId,
          customerName: transferCRRow.customerName,
          branchName: transferCRRow.branchName,
          items: Object.entries(crSelectedItems)
            .filter(([, sel]) => sel)
            .map(([key]) => ({ id: key, quantity: crReturnQtys[key] ?? 1 })),
          notes: "Return from " + transferCRRow.cnNo,
        }),
      });
      if (!res.ok) throw new Error("Failed to create Consignment Return");
      invalidateCachePrefix("/api/consignments");
      invalidateCachePrefix("/api/consignment-notes");
      invalidateCachePrefix("/api/invoices");
      setTransferCRRow(null);
      navigate("/consignment/return");
    } catch {
      toast.error("Failed to create Consignment Return. Please try again.");
    } finally {
      setTransferCRLoading(false);
    }
  };

  const handleTransferToSI = async () => {
    if (!transferSIRow) return;
    setTransferSILoading(true);
    try {
      const invNo = `INV-${new Date().getFullYear().toString().slice(-2)}${(new Date().getMonth() + 1).toString().padStart(2, "0")}-${String(Math.floor(Math.random() * 900) + 100)}`;
      const res = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consignmentNoteId: transferSIRow.id,
          cnNo: transferSIRow.cnNo,
          coRef: transferSIRow.coRef,
          customerId: transferSIRow.customerId,
          customerName: transferSIRow.customerName,
          invoiceNo: invNo,
          totalSen: transferSIRow.totalValueSen,
          items: transferSIRow.itemCount,
        }),
      });
      if (!res.ok) throw new Error("Failed");
      invalidateCachePrefix("/api/consignment-notes");
      invalidateCachePrefix("/api/consignments");
      invalidateCachePrefix("/api/invoices");
      setTransferSIRow(null);
      navigate("/sales");
    } catch {
      toast.error("Failed to create Sales Invoice. Please try again.");
    } finally {
      setTransferSILoading(false);
    }
  };

  // ---------- Export CSV ----------
  const handleExportCSV = () => {
    const headers = ["Dispatch Date", "CN No.", "CO Ref", "Customer", "Branch", "Items", "Total Value", "Status"];
    const csvRows = filteredCNs.map((r) => [
      r.dispatchDate ? formatDate(r.dispatchDate) : "",
      r.cnNo,
      r.coRef,
      r.customerName,
      r.branchName,
      r.itemCount,
      (r.totalValueSen / 100).toFixed(2),
      STATUS_LABEL[r.status],
    ]);
    const csv = [headers, ...csvRows].map((row) => row.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `consignment-notes-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Header — mirrors DO. New CN button is a passthrough toast for now;
          create flow lives on the Pending CN tab via Create CN button. */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Consignment Notes</h1>
          <p className="text-xs text-[#6B7280]">
            Manage consignment notes, branch dispatch, and acknowledgment tracking
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleExportCSV}>
            <Download className="h-4 w-4" /> Export CSV
          </Button>
          <Button
            variant="outline"
            onClick={() => fetchData()}
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>
      </div>

      {/* ====================================================== */}
      {/* KPI Strip — 4 cards, mirrors DO. Labels per task spec:  */}
      {/*   Pending CN · Dispatched · In Transit · Delivered MTD  */}
      {/* ====================================================== */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FAEFCB] p-2.5">
              <Package className="h-5 w-5 text-[#9C6F1E]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#9C6F1E]">{loading ? "-" : pendingCNCount}</p>
              <p className="text-xs text-[#6B7280]">Pending CN</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#E0EDF0] p-2.5">
              <Send className="h-5 w-5 text-[#3E6570]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#3E6570]">{loading ? "-" : dispatchedCount}</p>
              <p className="text-xs text-[#6B7280]">Dispatched</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#F1E6F0] p-2.5">
              <Truck className="h-5 w-5 text-[#6B4A6D]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#6B4A6D]">{loading ? "-" : inTransitCount}</p>
              <p className="text-xs text-[#6B7280]">In Transit</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#EEF3E4] p-2.5">
              <CheckCircle2 className="h-5 w-5 text-[#4F7C3A]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#4F7C3A]">{loading ? "-" : deliveredMTD}</p>
              <p className="text-xs text-[#6B7280]">Delivered (MTD)</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ============================================================ */}
      {/* Tabs — 6-stage CN workflow, count badges per tab (mirrors DO). */}
      {/* ============================================================ */}
      <div className="border-b border-[#E2DDD8]">
        <nav className="flex gap-4 overflow-x-auto" aria-label="Tabs">
          {ALL_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => {
                setActiveTab(tab.key);
                setSelectedReadyPOs(new Set());
              }}
              className={`flex items-center gap-2 pb-3 text-sm font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                activeTab === tab.key
                  ? "border-[#6B5C32] text-[#6B5C32]"
                  : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
              }`}
            >
              {tab.label}
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  activeTab === tab.key
                    ? "bg-[#6B5C32] text-white"
                    : "bg-[#F0ECE9] text-[#6B7280]"
                }`}
              >
                {tabCounts[tab.key] ?? 0}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {/* ============================================================ */}
      {/* Tab Content                                                   */}
      {/* ============================================================ */}

      {/* ---- Planning Tab (CO POs still in production) ---- */}
      {activeTab === "planning" && (
        <Card>
          <CardContent>
            <DataGrid<ReadyPORow>
              columns={planningColumns}
              data={planningPOs}
              keyField="id"
              loading={loading}
              stickyHeader
              maxHeight="calc(100vh - 280px)"
              emptyMessage="No CO items in planning."
              groupBy="customerState"
            />
          </CardContent>
        </Card>
      )}

      {/* ---- Pending CN Tab ---- */}
      {/* Mirrors DO's "Production Complete — Ready for DO" panel.       */}
      {/* Selecting POs and clicking Create CN POSTs one CN per customer. */}
      {activeTab === "pending_cn" && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <PackageCheck className="h-5 w-5 text-[#6B5C32]" /> Production Complete — Ready for CN
              </CardTitle>
              {selectedReadyPOs.size > 0 && (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={creatingCNFromPO}
                  onClick={() => {
                    const selected = readyPOs.filter((po) => selectedReadyPOs.has(po.id));
                    openCreateCN(selected);
                  }}
                >
                  {creatingCNFromPO ? (
                    <><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Creating...</>
                  ) : (
                    <><PackageCheck className="h-3.5 w-3.5" /> Create CN ({selectedReadyPOs.size})</>
                  )}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <DataGrid<ReadyPORow>
              columns={pendingCNColumns}
              data={readyPOs}
              keyField="id"
              loading={loading}
              stickyHeader
              maxHeight="calc(100vh - 280px)"
              emptyMessage="No CO items pending CN."
              groupBy="customerState"
              selectable
              onSelectionChange={(rows) =>
                setSelectedReadyPOs(new Set(rows.map((r) => r.id)))
              }
            />
          </CardContent>
        </Card>
      )}

      {/* ---- CN-list tabs: Pending Dispatch / Dispatched / Delivered / Acknowledged ---- */}
      {!PO_TABS.has(activeTab) && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <ClipboardList className="h-5 w-5 text-[#6B5C32]" /> Consignment Notes
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <DataGrid<ConsignmentNoteRow>
              columns={cnColumns}
              data={filteredCNs}
              keyField="id"
              loading={loading}
              stickyHeader
              maxHeight="calc(100vh - 280px)"
              emptyMessage="No consignment notes found."
              onDoubleClick={(row) => setDetailCN(row)}
              contextMenuItems={getContextMenuItems}
            />

            {/* Pagination footer — same shape as DO. */}
            <div className="flex items-center justify-between border-t border-[#E2DDD8] pt-3 mt-3 text-sm text-[#6B7280]">
              <span>
                {totalCNs.toLocaleString()} consignment note{totalCNs === 1 ? "" : "s"}
              </span>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page <= 1 || cnLoading}
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
                  disabled={page >= totalPages || cnLoading}
                >
                  Next →
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---------- Detail Dialog ---------- */}
      {/* Preserved from the original page — works as-is. */}
      {detailCN && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setDetailCN(null)}
          />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            <div className="sticky top-0 bg-white border-b border-[#E2DDD8] px-6 py-4 flex items-center justify-between rounded-t-xl">
              <div>
                <h2 className="text-lg font-bold text-[#1F1D1B]">{detailCN.cnNo}</h2>
                <p className="text-xs text-[#6B7280]">Consignment Note Detail</p>
              </div>
              <button
                onClick={() => setDetailCN(null)}
                className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-[#F0ECE9] text-[#6B5C32]">
                  {STATUS_LABEL[detailCN.status]}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">CN Number</p>
                  <p className="font-medium doc-number">{detailCN.cnNo}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">CO Reference</p>
                  <p className="font-medium doc-number">{detailCN.coRef}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Customer</p>
                  <p className="font-medium">{detailCN.customerName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Branch</p>
                  <p className="font-medium">{detailCN.branchName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Items</p>
                  <p className="font-medium">{detailCN.itemCount}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Total Value</p>
                  <p className="font-medium">{formatCurrency(detailCN.totalValueSen)}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Dispatch Date</p>
                  <p className="font-medium">
                    {detailCN.dispatchDate ? formatDate(detailCN.dispatchDate) : "-"}
                  </p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Delivered Date</p>
                  <p className="font-medium">
                    {detailCN.deliveredDate ? formatDate(detailCN.deliveredDate) : "-"}
                  </p>
                </div>
              </div>

              {detailCN.remarks && (
                <div className="border-t border-[#E2DDD8] pt-4">
                  <h3 className="text-sm font-semibold text-[#1F1D1B] mb-2">Remarks</h3>
                  <p className="text-xs text-[#6B7280]">{detailCN.remarks}</p>
                </div>
              )}
            </div>

            <div className="sticky bottom-0 bg-white border-t border-[#E2DDD8] px-6 py-4 flex items-center justify-end gap-2 rounded-b-xl">
              {(detailCN.status === "PENDING" || detailCN.status === "DISPATCHED") && (
                <Button
                  variant="primary"
                  onClick={() => {
                    setDetailCN(null);
                    setTransferDORow(detailCN);
                  }}
                >
                  <Truck className="h-4 w-4" /> Transfer to Delivery Order
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  const qtys: Record<string, number> = {};
                  const selected: Record<string, boolean> = {};
                  for (let i = 0; i < detailCN.itemCount; i++) {
                    const key = `${detailCN.id}-item-${i}`;
                    qtys[key] = 1;
                    selected[key] = true;
                  }
                  setCrReturnQtys(qtys);
                  setCrSelectedItems(selected);
                  setDetailCN(null);
                  setTransferCRRow(detailCN);
                }}
              >
                <RotateCcw className="h-4 w-4" /> Transfer to Return
              </Button>
              <Button variant="outline" onClick={() => setDetailCN(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* -------- Transfer to Delivery Order Dialog (preserved) -------- */}
      {transferDORow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setTransferDORow(null)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            <div className="sticky top-0 bg-white border-b border-[#E2DDD8] px-6 py-4 flex items-center justify-between rounded-t-xl">
              <div>
                <h2 className="text-lg font-bold text-[#1F1D1B]">Transfer to Delivery Order</h2>
                <p className="text-xs text-[#6B7280]">Create a DO from {transferDORow.cnNo}</p>
              </div>
              <button onClick={() => setTransferDORow(null)} className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">CN Number</p>
                  <p className="font-medium doc-number">{transferDORow.cnNo}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">CO Reference</p>
                  <p className="font-medium doc-number">{transferDORow.coRef}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Customer</p>
                  <p className="font-medium">{transferDORow.customerName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Branch</p>
                  <p className="font-medium">{transferDORow.branchName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Items</p>
                  <p className="font-medium">{transferDORow.itemCount} item(s)</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Total Value</p>
                  <p className="font-medium">{formatCurrency(transferDORow.totalValueSen)}</p>
                </div>
              </div>
              <div className="bg-[#FAF9F7] border border-[#E2DDD8] rounded-lg p-3">
                <p className="text-sm text-[#6B7280]">
                  This will create a Delivery Order for dispatching CN <strong>{transferDORow.cnNo}</strong> to <strong>{transferDORow.branchName}</strong>.
                </p>
              </div>
            </div>
            <div className="sticky bottom-0 bg-white border-t border-[#E2DDD8] px-6 py-4 flex items-center justify-end gap-2 rounded-b-xl">
              <Button variant="outline" onClick={() => setTransferDORow(null)} disabled={transferDOLoading}>Cancel</Button>
              <Button variant="primary" onClick={handleTransferToDO} disabled={transferDOLoading}>
                <Truck className="h-4 w-4" /> {transferDOLoading ? "Creating..." : "Create Delivery Order"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* -------- Transfer to Sales Invoice Dialog (preserved) -------- */}
      {transferSIRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-[480px] overflow-hidden">
            <div className="px-6 py-4 border-b border-[#E2DDD8] flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-[#1F1D1B]">Transfer to Sales Invoice</h2>
                <p className="text-xs text-[#6B7280]">Create Sales Invoice from {transferSIRow.cnNo}</p>
              </div>
              <button onClick={() => setTransferSIRow(null)} className="p-1 hover:bg-gray-100 rounded">
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-gray-500">CN No:</span><p className="font-medium doc-number">{transferSIRow.cnNo}</p></div>
                <div><span className="text-gray-500">CO Ref:</span><p className="font-medium doc-number">{transferSIRow.coRef}</p></div>
                <div><span className="text-gray-500">Customer:</span><p className="font-medium">{transferSIRow.customerName}</p></div>
                <div><span className="text-gray-500">Branch:</span><p className="font-medium">{transferSIRow.branchName}</p></div>
                <div><span className="text-gray-500">Items:</span><p className="font-medium">{transferSIRow.itemCount}</p></div>
                <div><span className="text-gray-500">Total Value:</span><p className="font-medium text-[#6B5C32]">{formatCurrency(transferSIRow.totalValueSen)}</p></div>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
                <p className="font-medium">CN serves as Delivery Order</p>
                <p className="text-xs mt-1 text-amber-600">This consignment note will be used as the delivery reference for the invoice.</p>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-[#E2DDD8] flex justify-end gap-2">
              <Button variant="outline" onClick={() => setTransferSIRow(null)} disabled={transferSILoading}>Cancel</Button>
              <Button onClick={handleTransferToSI} disabled={transferSILoading} className="bg-[#6B5C32] hover:bg-[#5A4D2A] text-white">
                {transferSILoading ? "Creating..." : "Create Sales Invoice"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* -------- Transfer to Consignment Return Dialog (preserved) -------- */}
      {transferCRRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setTransferCRRow(null)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            <div className="sticky top-0 bg-white border-b border-[#E2DDD8] px-6 py-4 flex items-center justify-between rounded-t-xl">
              <div>
                <h2 className="text-lg font-bold text-[#1F1D1B]">Transfer to Consignment Return</h2>
                <p className="text-xs text-[#6B7280]">Return items from {transferCRRow.cnNo}</p>
              </div>
              <button onClick={() => setTransferCRRow(null)} className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">CN Number</p>
                  <p className="font-medium doc-number">{transferCRRow.cnNo}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Customer</p>
                  <p className="font-medium">{transferCRRow.customerName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Branch</p>
                  <p className="font-medium">{transferCRRow.branchName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Total Items</p>
                  <p className="font-medium">{transferCRRow.itemCount} item(s)</p>
                </div>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-sm text-amber-800">
                  Select the items and quantities you want to return from this consignment note.
                </p>
              </div>
              <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-[#FAF9F7]">
                    <tr>
                      <th className="text-left px-3 py-2 text-xs text-[#9CA3AF] font-medium w-8"></th>
                      <th className="text-left px-3 py-2 text-xs text-[#9CA3AF] font-medium">Item</th>
                      <th className="text-right px-3 py-2 text-xs text-[#9CA3AF] font-medium w-24">Return Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: transferCRRow.itemCount }, (_, i) => {
                      const key = `${transferCRRow.id}-item-${i}`;
                      return (
                        <tr key={key} className={`border-t border-[#E2DDD8] ${!crSelectedItems[key] ? "opacity-50" : ""}`}>
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={!!crSelectedItems[key]}
                              onChange={(e) => setCrSelectedItems((prev) => ({ ...prev, [key]: e.target.checked }))}
                              className="rounded border-[#E2DDD8] text-[#6B5C32] focus:ring-[#6B5C32]"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <p className="font-medium">Item {i + 1}</p>
                            <p className="text-xs text-[#9CA3AF]">From {transferCRRow.cnNo}</p>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              min={1}
                              value={crReturnQtys[key] ?? 1}
                              onChange={(e) => {
                                const val = Math.max(1, parseInt(e.target.value) || 1);
                                setCrReturnQtys((prev) => ({ ...prev, [key]: val }));
                              }}
                              disabled={!crSelectedItems[key]}
                              className="w-20 rounded-md border border-[#E2DDD8] px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32] disabled:bg-gray-100"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-between text-sm px-1">
                <span className="text-[#6B7280]">
                  Selected: {Object.values(crSelectedItems).filter(Boolean).length} of {transferCRRow.itemCount} items
                </span>
              </div>
            </div>
            <div className="sticky bottom-0 bg-white border-t border-[#E2DDD8] px-6 py-4 flex items-center justify-end gap-2 rounded-b-xl">
              <Button variant="outline" onClick={() => setTransferCRRow(null)} disabled={transferCRLoading}>Cancel</Button>
              <Button variant="primary" onClick={handleTransferToCR} disabled={transferCRLoading}>
                <RotateCcw className="h-4 w-4" /> {transferCRLoading ? "Creating..." : "Confirm Return"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
