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
  Plus,
} from "lucide-react";
import type { ConsignmentNote, Customer } from "@/lib/mock-data";

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
  driverId: string | null; // 3PL provider id (legacy column name) — for company lookup
  driverCompany: string;
  driverName: string;
  vehicleNo: string;
  remarks: string;
  // Carry the full items array on the row so the Return + Convert dialogs
  // can address line items by their real DB id (consignment_items.id) when
  // POSTing to /:id/return or /:id/convert-to-invoice. Synthesizing fake
  // ids client-side broke the new return endpoint's validation, so we
  // surface the canonical ids here.
  //
  // sizeLabel + salesOrderNo / poNo are joined client-side via
  // productSizeMap and poToSoMap so the bottom DataGrid can render the
  // same Product Code / Size / Sales Order columns DO does (BUG-2026-04-28
  // user complaint #2: CN row only showed "1 item" with no product detail).
  items: Array<{
    id: string;
    productCode: string;
    productName: string;
    sizeLabel: string;
    quantity: number;
    unitPrice: number;
    productionOrderId: string | null;
    consignmentOrderNo: string;
  }>;
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

function mapCNToRow(
  cn: ConsignmentNote,
  productSizeMap: Map<string, string>,
  poToCoNoMap: Map<string, string>,
): ConsignmentNoteRow {
  const totalQty = cn.items.reduce((s, i) => s + i.quantity, 0);
  // Prefer the new consignmentOrderId column (added by migration 0066);
  // fall back to noteNumber when it's null on legacy rows so the column
  // still renders something instead of blank.
  return {
    id: cn.id,
    cnNo: cn.noteNumber,
    coRef: cn.consignmentOrderId || cn.noteNumber,
    consignmentId: cn.consignmentOrderId || cn.id,
    customerId: cn.customerId,
    customerName: cn.customerName,
    branchName: cn.branchName,
    itemCount: cn.items.length,
    totalQty,
    totalValueSen: cn.totalValue,
    // dispatchDate prefers the dispatchedAt timestamp (when status moved
    // to PARTIALLY_SOLD); falls back to sentDate (the CN creation date)
    // for legacy rows where the timestamp is null.
    dispatchDate: cn.dispatchedAt || cn.sentDate || null,
    deliveredDate: cn.deliveredAt || null,
    status: cnStatusFromBackend(cn.status),
    // Display the 3PL company name (driverContactPerson holds the dispatcher
    // contact, but for the Transport Co. column we want the company itself —
    // resolved from cn.driverId via the providers list at render time, with
    // driverName as fallback to keep legacy rows visible).
    driverId: cn.driverId ?? null,
    driverCompany: cn.driverContactPerson || "",
    driverName: cn.driverName || "",
    vehicleNo: cn.vehicleNo || "",
    remarks: cn.notes || "",
    items: (cn.items || []).map((it) => ({
      id: it.id,
      productCode: it.productCode || "",
      productName: it.productName || "",
      sizeLabel: productSizeMap.get(it.productCode || "") || "",
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      productionOrderId: it.productionOrderId ?? null,
      // Look up the parent CO number from the linked PO (mirrors DO's
      // items[].salesOrderNo lookup pattern). Falls back to the CN's
      // own coRef if the PO row hasn't been pulled yet.
      consignmentOrderNo:
        (it.productionOrderId && poToCoNoMap.get(it.productionOrderId)) || "",
    })),
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

  // Transfer dialogs. The CN-to-DO path was removed 2026-04-28 (consignment
  // goods are already at the customer's branch — DO is for SO-origin
  // dispatches and doesn't apply here). Two flows remain:
  //   * Consignment Return (CR)  — wired to POST /:id/return
  //   * Sales Invoice (SI)        — wired to POST /:id/convert-to-invoice
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

  // ----- Mark-Dispatched dialog (mirrors DO's Create-DO 3PL section) -----
  // Opens when the operator picks "Mark Dispatched" from the context menu
  // on a Pending Dispatch CN row. Same provider → vehicle → driver chain
  // DO uses; on confirm, PUTs /api/consignment-notes/:id with the picked
  // ids + status:'PARTIALLY_SOLD'. Backend (resolveTransport in
  // consignment-note-shared.ts) re-resolves driver/vehicle metadata from
  // the picked rows and stamps dispatchedAt automatically.
  const [dispatchDialog, setDispatchDialog] = useState<ConsignmentNoteRow | null>(null);
  const [dispatchForm, setDispatchForm] = useState({
    providerId: "",
    vehicleId: "",
    driverPersonId: "",
  });
  const [dispatchSaving, setDispatchSaving] = useState(false);

  // Per-provider vehicle + driver-person caches for the dispatch dialog.
  // Loaded lazily when the provider id changes — same pattern DO uses for
  // its createDialogVehicles / createDialogDrivers state. ratePerTripSen +
  // ratePerExtraDropSen are pulled so the Create CN dialog's Est. Delivery
  // Cost row can compute against the picked vehicle's per-vehicle rate
  // (mirrors DO's identical formula).
  type ThreePLVehicleShape = {
    id: string;
    plateNo: string;
    vehicleType?: string;
    ratePerTripSen?: number;
    ratePerExtraDropSen?: number;
    status: "ACTIVE" | "INACTIVE";
  };
  type ThreePLDriverShape = {
    id: string;
    name: string;
    phone?: string;
    status: "ACTIVE" | "INACTIVE";
  };
  const [dispatchVehicles, setDispatchVehicles] = useState<ThreePLVehicleShape[]>([]);
  const [dispatchDrivers, setDispatchDrivers] = useState<ThreePLDriverShape[]>([]);

  // ----- Create CN dialog (mirrors DO's createDODialog) -----
  // Holds the picked PO rows when the dialog is open, null when closed. The
  // user picks transport (3PL provider / vehicle / driver), delivery hub,
  // delivery date, and remarks here BEFORE the CN row gets created — so the
  // resulting CN list row immediately shows Transport Co. / Driver / Vehicle
  // populated (vs the old "create blank, fill in at Mark Dispatched" flow
  // that left those columns "—" until dispatch).
  const [createCNDialog, setCreateCNDialog] = useState<ReadyPORow[] | null>(null);
  const [createCNForm, setCreateCNForm] = useState({
    providerId: "",
    vehicleId: "",
    driverPersonId: "",
    hubId: "",
    deliveryDate: "",
    remarks: "",
  });
  // Per-provider vehicle + driver-person caches for the Create CN dialog.
  // Separate from dispatchVehicles/dispatchDrivers so opening Create CN
  // doesn't disturb the Mark Dispatched dialog's already-loaded lists (and
  // vice versa). Same pattern DO uses with createDialogVehicles vs
  // editDialogVehicles.
  const [createCNVehicles, setCreateCNVehicles] = useState<ThreePLVehicleShape[]>([]);
  const [createCNDrivers, setCreateCNDrivers] = useState<ThreePLDriverShape[]>([]);

  // ----- Customers cache (for hub picker on the Create CN dialog) -----
  // Mirrors DO's customersData state. Pulled lazily — only the Create CN
  // dialog needs this, so the cache stays warm but doesn't block the
  // initial render of the CN list.
  const [customersData, setCustomersData] = useState<Customer[]>([]);

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

  // Product master for per-unit m³ + sizeLabel — same source DO uses. The
  // sizeLabel join lets the CN row surface "5FT" / "Q" next to each item's
  // product code, mirroring DO's per-row product info columns.
  const { data: prodRaw, loading: prodLoading, refresh: refreshProducts } =
    useCachedJson<{
      success?: boolean;
      data?: { code: string; unitM3: number; sizeLabel?: string }[];
    }>("/api/products");

  // 3PL providers — same /api/drivers endpoint DO uses to resolve the
  // Transport Co. column from driverId. Loaded once and cached so the
  // Mark Dispatched dialog can populate its provider picker without an
  // extra fetch.
  type ThreePLProviderShape = {
    id: string;
    name: string;
    contactPerson?: string;
    status: "ACTIVE" | "INACTIVE";
  };
  const { data: providersRaw } = useCachedJson<{
    success?: boolean;
    data?: ThreePLProviderShape[];
  }>("/api/drivers");
  const providers = useMemo<ThreePLProviderShape[]>(
    () =>
      providersRaw?.success && Array.isArray(providersRaw.data)
        ? providersRaw.data
        : [],
    [providersRaw],
  );

  // Customers (with deliveryHubs) for the Create CN dialog's hub picker.
  // Same /api/customers endpoint DO uses on its Create dialog.
  const { data: custRaw } = useCachedJson<{ success?: boolean; data?: Customer[] }>(
    "/api/customers",
  );
  /* eslint-disable react-hooks/set-state-in-effect -- mirror SWR data into local state */
  useEffect(() => {
    if (custRaw?.success && Array.isArray(custRaw.data)) {
      setCustomersData(custRaw.data as Customer[]);
    }
  }, [custRaw]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Per-provider rates also let the Create CN dialog fall back to company-
  // level rates when no vehicle is picked. Mirrors DO's identical fallback.
  type ThreePLProviderRated = ThreePLProviderShape & {
    ratePerTripSen?: number;
    ratePerExtraDropSen?: number;
  };
  const providersRated = providers as ThreePLProviderRated[];

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

  // Lookup: productCode → sizeLabel. Used by mapCNToRow to stamp each CN
  // item with its product's display size (e.g. "5FT", "Q") so the bottom
  // DataGrid can show product detail per the user's complaint that CN rows
  // only said "1 item" without surfacing the actual product info.
  const productSizeMap = useMemo(() => {
    const m = new Map<string, string>();
    const arr = prodRaw?.success ? prodRaw.data : null;
    if (Array.isArray(arr)) {
      for (const p of arr) {
        if (p?.code) m.set(p.code, p.sizeLabel || "");
      }
    }
    return m;
  }, [prodRaw]);

  // Lookup: productionOrderId → companyCOId. Mirrors DO's items[].salesOrderNo
  // join (DO walks the PO list to find the parent SO number for each
  // delivery_order_items.productionOrderId). Same trick on the CN side: each
  // consignment_items.productionOrderId resolves to the parent CO's
  // companyCOId so the bottom grid can show the SO/CO column even when the
  // CN itself was created from multiple POs.
  const poToCoNoMap = useMemo(() => {
    const m = new Map<string, string>();
    const arr = poRaw?.success ? poRaw.data : null;
    if (Array.isArray(arr)) {
      for (const po of arr) {
        if (po?.id) m.set(po.id, po.companyCOId || "");
      }
    }
    return m;
  }, [poRaw]);

  // Fetch per-provider vehicles + drivers when the dispatch dialog's
  // provider picker changes. Mirrors DO's createDialogVehicles /
  // createDialogDrivers effect — same /api/three-pl-vehicles and
  // /api/three-pl-drivers endpoints, scoped by ?providerId=. Empty
  // providerId clears both lists so the dropdowns disable until a
  // provider is picked.
  /* eslint-disable react-hooks/set-state-in-effect -- mirror remote data into local state */
  useEffect(() => {
    const pid = dispatchForm.providerId;
    if (!pid) {
      setDispatchVehicles([]);
      setDispatchDrivers([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      fetch(`/api/three-pl-vehicles?providerId=${pid}`).then(
        (r) => r.json() as Promise<{ success?: boolean; data?: ThreePLVehicleShape[] }>,
      ),
      fetch(`/api/three-pl-drivers?providerId=${pid}`).then(
        (r) => r.json() as Promise<{ success?: boolean; data?: ThreePLDriverShape[] }>,
      ),
    ])
      .then(([vRes, dRes]) => {
        if (cancelled) return;
        if (vRes?.success && Array.isArray(vRes.data)) setDispatchVehicles(vRes.data);
        if (dRes?.success && Array.isArray(dRes.data)) setDispatchDrivers(dRes.data);
      })
      .catch(() => {
        /* swallow — same swallow pattern DO uses */
      });
    return () => {
      cancelled = true;
    };
  }, [dispatchForm.providerId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Same per-provider lookup but for the Create CN dialog. Kept in a
  // separate state pair (createCNVehicles/createCNDrivers) so opening
  // Create CN doesn't stomp the Mark Dispatched dialog's lists when both
  // happen to be open in quick succession. Mirrors how DO keeps a
  // create-dialog cache distinct from its edit-dialog cache.
  /* eslint-disable react-hooks/set-state-in-effect -- mirror remote data into local state */
  useEffect(() => {
    const pid = createCNForm.providerId;
    if (!pid) {
      setCreateCNVehicles([]);
      setCreateCNDrivers([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      fetch(`/api/three-pl-vehicles?providerId=${pid}`).then(
        (r) => r.json() as Promise<{ success?: boolean; data?: ThreePLVehicleShape[] }>,
      ),
      fetch(`/api/three-pl-drivers?providerId=${pid}`).then(
        (r) => r.json() as Promise<{ success?: boolean; data?: ThreePLDriverShape[] }>,
      ),
    ])
      .then(([vRes, dRes]) => {
        if (cancelled) return;
        if (vRes?.success && Array.isArray(vRes.data)) setCreateCNVehicles(vRes.data);
        if (dRes?.success && Array.isArray(dRes.data)) setCreateCNDrivers(dRes.data);
      })
      .catch(() => {
        /* swallow — same swallow pattern DO uses */
      });
    return () => {
      cancelled = true;
    };
  }, [createCNForm.providerId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Mirror SWR data → local state. Same eslint suppression as DO.
  /* eslint-disable react-hooks/set-state-in-effect -- mirror SWR data into mutable local state for optimistic UI */
  useEffect(() => {
    const anyLoading = cnLoading || poLoading || coOrdersLoading || prodLoading;
    setLoading(anyLoading);

    // Map CN rows. productSizeMap + poToCoNoMap are lookup tables built
    // above; mapCNToRow stamps each item with its sizeLabel + parent CO
    // number so the bottom DataGrid can render product detail columns.
    if (cnRaw?.success && Array.isArray(cnRaw.data)) {
      setCnList(
        (cnRaw.data as ConsignmentNote[]).map((cn) =>
          mapCNToRow(cn, productSizeMap, poToCoNoMap),
        ),
      );
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

      // CN dedup (precise as of migration 0066): walk every CN's items
      // array and collect productionOrderId for any CN that's not
      // CANCELLED. Mirrors DO's exact pattern (linkedPOIds set built from
      // delivery_order_items.productionOrderId). Excludes CLOSED so a
      // PO that already shipped + acknowledged doesn't permanently
      // hide. Falls back to per-customer dedup on legacy CNs that
      // pre-date 0066 (productionOrderId is null on those rows).
      const cnLinkedPOIds = new Set<string>();
      const cnLinkedCustomersLegacy = new Set<string>();
      if (cnRaw?.success && Array.isArray(cnRaw.data)) {
        for (const cn of cnRaw.data as ConsignmentNote[]) {
          if (cn.status === "CLOSED") continue;
          let foundPoLink = false;
          for (const item of cn.items) {
            if (item.productionOrderId) {
              cnLinkedPOIds.add(item.productionOrderId);
              foundPoLink = true;
            }
          }
          // Legacy CN (pre-0066) — items have no productionOrderId, so
          // fall back to per-customer dedup so its POs still hide.
          if (
            !foundPoLink &&
            (cn.status === "ACTIVE" || cn.status === "PARTIALLY_SOLD")
          ) {
            cnLinkedCustomersLegacy.add(cn.customerId);
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
        .filter(
          (po) =>
            !cnLinkedPOIds.has(po.id) &&
            !cnLinkedCustomersLegacy.has(po.customerId || ""),
        )
        .map(mapPO);
      setReadyPOs(ready);
    }
  }, [cnRaw, poRaw, coOrdersRaw, cnLoading, poLoading, coOrdersLoading, prodLoading, productM3Map, productSizeMap, poToCoNoMap]);
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
  // Mirrors DO's openCreateDODialog 1:1. Picks the customer's default hub
  // (or matching state hub) up-front so the dialog opens with sensible
  // defaults pre-filled. Multi-customer selections are NOT supported on
  // CN — each CN is per-branch — so callers should ensure pos all share
  // a customerId before opening. (The Pending CN UI doesn't enforce this
  // today; the confirm handler groups by customer and posts one CN per
  // group as a fallback.)
  const openCreateCNDialog = useCallback(
    (pos: ReadyPORow[]) => {
      if (pos.length === 0) return;
      const first = pos[0];
      // Pre-fill hub: prefer one matching the customer's state, then
      // default hub, then first hub. Mirrors DO's identical lookup chain.
      const cust = customersData.find((c) => c.id === first.customerId);
      const matchedHub =
        cust?.deliveryHubs.find((h) => h.state === first.customerState) ??
        cust?.deliveryHubs.find((h) => h.isDefault) ??
        cust?.deliveryHubs[0];
      setCreateCNForm({
        providerId: "",
        vehicleId: "",
        driverPersonId: "",
        hubId: matchedHub?.id ?? "",
        deliveryDate: "",
        remarks: "",
      });
      setCreateCNDialog(pos);
    },
    [customersData],
  );

  // ---------- Confirm Create CN ----------
  // POSTs /api/consignment-notes with the body shape the backend expects
  // (consignment_notes.ts POST handler). Field mapping:
  //   FE deliveryDate → BE sentDate     (CN has no separate deliveryDate column)
  //   FE remarks      → BE notes         (CN's remark column is named notes)
  //   FE hubId        → BE hubId         (resolves branchName via JOIN)
  //   FE providerId/vehicleId/driverPersonId → BE providerId/vehicleId/driverId
  //                                       (resolveTransport denormalizes the
  //                                        company name + driver-person + plate)
  //   FE productionOrderIds → BE productionOrderIds (writes one
  //                                        consignment_items row per PO)
  // Multi-customer selection: if the user picked POs from multiple customers,
  // we group by customer and POST one CN per group — same defensive behavior
  // the old openCreateCN had. Single-customer selections (the common case)
  // produce exactly one CN.
  const confirmCreateCN = useCallback(async () => {
    if (!createCNDialog) return;
    // Pull live selection from selectedReadyPOs (mirrors DO's pattern of
    // honoring last-second checkbox toggles after the dialog opened).
    const livePos = readyPOs.filter((po) => selectedReadyPOs.has(po.id));
    const pos = livePos.length > 0 ? livePos : createCNDialog;
    if (pos.length === 0) {
      setCreateCNDialog(null);
      return;
    }
    setCreatingCNFromPO(true);
    try {
      // Group by customer — one CN per branch destination. Same rationale
      // the old openCreateCN had (CN is per-branch, can't span customers).
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
        // For multi-customer batches, re-resolve the hub for each group's
        // customer (createCNForm.hubId is only valid for the first one).
        // Single-customer (the typical case) uses the dialog's hub.
        const cust = customersData.find((c) => c.id === first.customerId);
        const groupHubId =
          (byCustomer.size === 1
            ? createCNForm.hubId
            : cust?.deliveryHubs.find((h) => h.state === first.customerState)?.id ??
              cust?.deliveryHubs.find((h) => h.isDefault)?.id ??
              cust?.deliveryHubs[0]?.id) ?? null;

        const body: Record<string, unknown> = {
          type: "OUT",
          customerId: first.customerId,
          customerName: first.customerName,
          // Backend resolves branchName from hubId when provided; passing
          // the customerState as a fallback mirrors the legacy behavior.
          branchName: first.customerState || "Branch",
          // FE deliveryDate → BE sentDate. Empty string falls back to
          // server-side default (today) inside the POST handler.
          sentDate: createCNForm.deliveryDate || new Date().toISOString().split("T")[0],
          consignmentOrderId: first.consignmentOrderId || null,
          // FE remarks → BE notes
          notes: createCNForm.remarks || `Created from CO ${first.consignmentOrderNo}`,
          productionOrderIds: group.map((po) => po.id),
          hubId: groupHubId,
          // Carrier — null when blank so the backend's resolveTransport
          // treats them as "unset" rather than wiping with empty strings.
          providerId: createCNForm.providerId || null,
          vehicleId: createCNForm.vehicleId || null,
          driverId: createCNForm.driverPersonId || null,
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
      setCreateCNDialog(null);
      setSelectedReadyPOs(new Set());
      fetchData();
    }
  }, [
    createCNDialog,
    createCNForm,
    customersData,
    readyPOs,
    selectedReadyPOs,
    fetchData,
    toast,
  ]);

  // ---------- Mark Dispatched — confirm handler ----------
  // Wired to the Mark Dispatched dialog's Confirm button. PUT-by-id with
  // the picked transport ids + status:'PARTIALLY_SOLD'. Backend
  // resolveTransport (consignment-note-shared.ts) re-resolves the company
  // name + driver-person name + vehicle plate from the picked rows and
  // stamps dispatchedAt automatically. Mirrors the CN-side equivalent of
  // DO's status='LOADED' transition.
  const confirmDispatch = useCallback(async () => {
    if (!dispatchDialog) return;
    setDispatchSaving(true);
    try {
      const res = await fetch(`/api/consignment-notes/${dispatchDialog.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "PARTIALLY_SOLD",
          // Send providerId / vehicleId / driverId on the body shape
          // resolveTransport expects. Empty string → null so the helper
          // treats unpicked fields as "unset" rather than overwriting
          // existing data with empty strings.
          providerId: dispatchForm.providerId || null,
          vehicleId: dispatchForm.vehicleId || null,
          driverId: dispatchForm.driverPersonId || null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error || "Failed to mark dispatched");
      } else {
        toast.success(`${dispatchDialog.cnNo} dispatched`);
        setDispatchDialog(null);
        setDispatchForm({ providerId: "", vehicleId: "", driverPersonId: "" });
        fetchData();
      }
    } catch {
      toast.error("Failed to mark dispatched");
    } finally {
      setDispatchSaving(false);
    }
  }, [dispatchDialog, dispatchForm, fetchData, toast]);

  // ---------- Reverse status helpers ----------
  // Used by the "Reverse to Pending Dispatch" / "Reverse to Dispatched"
  // context-menu items. Backend (updateConsignmentNoteById) auto-nulls the
  // matching lifecycle timestamp when the new status is earlier in the
  // lifecycle than the old one — relies on STATUS_RANK in
  // consignment-note-shared.ts. We do NOT send `clearTimestamps:true`
  // because that wipes ALL three timestamps; for a half-step reverse
  // (e.g. CLOSED → FULLY_SOLD = "Reverse to Delivered") the deliveredAt
  // timestamp should stay intact since the row is still delivered.
  const reverseStatus = useCallback(
    async (row: ConsignmentNoteRow, toStatus: string, label: string) => {
      try {
        const res = await fetch(`/api/consignment-notes/${row.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: toStatus }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(body.error || `Failed to reverse to ${label}`);
        } else {
          toast.success(`${row.cnNo} reversed to ${label}`);
          fetchData();
        }
      } catch {
        toast.error(`Failed to reverse to ${label}`);
      }
    },
    [fetchData, toast],
  );

  // "Reverse to Pending CN" deletes the CN entirely (cleaner than a
  // CANCELLED ghost row — the underlying POs go back into the Pending CN
  // dedup pool automatically because the CN dedup walks live CNs). Hits
  // the legacy DELETE /api/consignments/:id endpoint (the consignments.ts
  // route — consignment-notes.ts has no DELETE today). Confirms before
  // destructive action so the operator can back out.
  const reverseToPendingCN = useCallback(
    async (row: ConsignmentNoteRow) => {
      if (
        !confirm(
          `Delete ${row.cnNo} and return its POs to Pending CN? This cannot be undone.`,
        )
      ) {
        return;
      }
      try {
        const res = await fetch(`/api/consignments/${row.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          toast.error(body.error || "Failed to delete CN");
        } else {
          toast.success(`${row.cnNo} deleted — POs returned to Pending CN`);
          fetchData();
        }
      } catch {
        toast.error("Failed to delete CN");
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
        // Mirrors DO's Sales Orders column: collect the distinct
        // companyCOId values from the items array (each consignment_items
        // row carries productionOrderId → joined to CO via poToCoNoMap).
        // Falls back to row.coRef when items have no PO link (legacy CN
        // rows pre-migration 0066).
        render: (_value, row) => {
          const cos = Array.from(
            new Set(
              (row.items || [])
                .map((it) => it.consignmentOrderNo)
                .filter((s): s is string => Boolean(s)),
            ),
          );
          if (cos.length === 0) {
            return (
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
            );
          }
          return (
            <button
              type="button"
              className="doc-number text-[#6B5C32] hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/consignment/${row.consignmentId}`);
              }}
              title="Open parent Consignment Order"
            >
              {cos.join(", ")}
            </button>
          );
        },
      },
      // Product Code — first item's code, with "+N more" badge when the CN
      // spans multiple lines. Mirrors DO's per-row product info treatment
      // (DO surfaces this via the items array on the detail panel; CN
      // surfaces a summary directly in the row per user request 2026-04-28).
      {
        key: "_productCode",
        label: "Product Code",
        type: "text",
        width: "150px",
        sortable: false,
        render: (_value, row) => {
          if (row.items.length === 0) {
            return <span className="text-[#9CA3AF]">—</span>;
          }
          const first = row.items[0];
          return (
            <span className="text-[#1F1D1B]">
              <span className="doc-number">{first.productCode || "—"}</span>
              {row.items.length > 1 && (
                <span className="text-[#9C6F1E] text-xs ml-1">
                  +{row.items.length - 1} more
                </span>
              )}
            </span>
          );
        },
      },
      // Size — sourced via productSizeMap from /api/products. Same "first
      // item + N-more" treatment as Product Code.
      {
        key: "_sizeLabel",
        label: "Size",
        type: "text",
        width: "80px",
        sortable: false,
        render: (_value, row) => {
          if (row.items.length === 0) {
            return <span className="text-[#9CA3AF]">—</span>;
          }
          return (
            <span className="text-[#4B5563]">
              {row.items[0].sizeLabel || <span className="text-[#9CA3AF]">—</span>}
            </span>
          );
        },
      },
      // Qty — sum of every item's quantity (a CN with two lines of 3 + 2
      // shows "5"). Operator wanted a top-level qty number visible without
      // opening detail.
      {
        key: "totalQty",
        label: "Qty",
        type: "number",
        width: "60px",
        align: "right",
        sortable: true,
        render: (_value, row) => (
          <span className="tabular-nums text-[#1F1D1B]">{row.totalQty}</span>
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
      // Transport Co. = the 3PL provider COMPANY. Resolves
      // consignment_notes.driverId (legacy column name; holds providerId
      // post-3PL refactor) against the cached providers list. Mirrors
      // DO's identical column 1:1 — same lookup, same fallback.
      {
        key: "driverId",
        label: "Transport Co.",
        type: "text",
        width: "180px",
        sortable: true,
        render: (_value, row) => {
          const company = providers.find((p) => p.id === row.driverId)?.name;
          const display = company || row.driverCompany || "";
          return (
            <span className="text-[#1F1D1B]">
              {display || <span className="text-[#9CA3AF]">—</span>}
            </span>
          );
        },
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
    [navigate, providers],
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
      // Mark Dispatched — opens a dialog that mirrors DO's Create-DO 3PL
      // section (Provider company → Vehicle → Driver person). On confirm,
      // PUTs the picked transport ids + status:'PARTIALLY_SOLD' so the
      // backend's resolveTransport denormalizes everything into the CN
      // row. Bug fix 2026-04-28: previously this just flipped status with
      // no transport pick, leaving the CN row showing "—" for Transport
      // Co. / Driver / Vehicle indefinitely.
      {
        label: "Mark Dispatched",
        icon: <Send className="h-3.5 w-3.5" />,
        disabled: row.status !== "PENDING",
        action: () => {
          setDispatchForm({ providerId: "", vehicleId: "", driverPersonId: "" });
          setDispatchDialog(row);
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
      // ---- Reverse actions (mirrors DO's "Reverse to Pending Dispatch") ----
      // Each reverse PUT just sends the new status — the backend infers
      // the timestamp wipe from STATUS_RANK in consignment-note-shared.ts
      // (any timestamp at-or-after the new rank gets nulled, so a half-
      // step reverse like CLOSED → FULLY_SOLD only clears acknowledgedAt
      // and leaves deliveredAt intact). clearTimestamps:true is reserved
      // for explicit "wipe everything" backfill, which the operator
      // never wants from a context-menu reverse.
      {
        label: "Reverse to Pending CN",
        icon: <RotateCcw className="h-3.5 w-3.5" />,
        disabled: row.status !== "PENDING",
        action: () => reverseToPendingCN(row),
      },
      {
        label: "Reverse to Pending Dispatch",
        icon: <RotateCcw className="h-3.5 w-3.5" />,
        disabled: row.status !== "DISPATCHED" && row.status !== "IN_TRANSIT",
        action: () => reverseStatus(row, "ACTIVE", "Pending Dispatch"),
      },
      {
        label: "Reverse to Dispatched",
        icon: <RotateCcw className="h-3.5 w-3.5" />,
        disabled: row.status !== "DELIVERED",
        action: () => reverseStatus(row, "PARTIALLY_SOLD", "Dispatched"),
      },
      {
        label: "Reverse to Delivered",
        icon: <RotateCcw className="h-3.5 w-3.5" />,
        disabled: row.status !== "ACKNOWLEDGED",
        action: () => reverseStatus(row, "FULLY_SOLD", "Delivered"),
      },
      { label: "", separator: true, action: () => {} },
      // CN-to-DO removed 2026-04-28 — consignment goods are at the customer
      // already; DO is for SO-origin dispatches and doesn't apply.
      {
        label: "Transfer to Sales Invoice",
        icon: <FileText className="h-3.5 w-3.5" />,
        action: () => setTransferSIRow(row),
      },
      {
        label: "Transfer to Consignment Return",
        icon: <RotateCcw className="h-3.5 w-3.5" />,
        action: () => {
          // Seed selection state with the REAL consignment_items.id values
          // (post-2026-04-28 wiring — the new POST /:id/return endpoint
          // validates each id against the DB, so synthetic keys would fail).
          const qtys: Record<string, number> = {};
          const selected: Record<string, boolean> = {};
          for (const it of row.items) {
            qtys[it.id] = it.quantity;
            selected[it.id] = true;
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
    [fetchData, toast, reverseStatus, reverseToPendingCN],
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

  // ---------- Transfer Handlers ----------
  // Returns hit the new POST /api/consignment-notes/:id/return endpoint
  // which atomically updates the CN status, decrements consignment_items
  // quantities (or flips them RETURNED), flips matching fg_units back to
  // RETURNED, and writes a stock_movements audit row per item. The old
  // path (POST /api/consignments with type=RETURN) just created a sibling
  // CN row without touching the source — that's what we replaced.
  const handleTransferToCR = async () => {
    if (!transferCRRow) return;
    const selectedItemIds = Object.entries(crSelectedItems)
      .filter(([, sel]) => sel)
      .map(([id]) => id);
    if (selectedItemIds.length === 0) {
      toast.warning("Please select at least one item to return.");
      return;
    }
    setTransferCRLoading(true);
    try {
      const res = await fetch(
        `/api/consignment-notes/${transferCRRow.id}/return`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: selectedItemIds.map((id) => ({
              id,
              quantity: crReturnQtys[id] ?? 1,
            })),
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "Failed to process return");
      }
      const json = (await res.json()) as {
        data?: { noteNumber?: string; status?: string };
      };
      invalidateCachePrefix("/api/consignment-notes");
      invalidateCachePrefix("/api/consignments");
      invalidateCachePrefix("/api/invoices");
      invalidateCachePrefix("/api/fg-units");
      const newNo = json.data?.noteNumber ?? transferCRRow.cnNo;
      const finalStatus = json.data?.status ?? "PARTIALLY_SOLD";
      toast.success(
        finalStatus === "RETURNED"
          ? `Return processed for ${newNo} (fully returned)`
          : `Return processed for ${newNo} (partial)`,
      );
      setTransferCRRow(null);
      fetchData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Failed to process return: ${msg}`);
    } finally {
      setTransferCRLoading(false);
    }
  };

  // Sales-Invoice conversion hits the new POST /:id/convert-to-invoice
  // endpoint. Backend assigns the invoice number via the shared
  // nextInvoiceNo() sequence (no more random-number generation client
  // side — that produced colliding INV-YYMM-NNN numbers before
  // 2026-04-28). On success we navigate to the new invoice's detail page.
  const handleTransferToSI = async () => {
    if (!transferSIRow) return;
    setTransferSILoading(true);
    try {
      const res = await fetch(
        `/api/consignment-notes/${transferSIRow.id}/convert-to-invoice`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "Failed to create Sales Invoice");
      }
      const json = (await res.json()) as {
        data?: { invoiceId?: string; invoiceNo?: string };
      };
      invalidateCachePrefix("/api/consignment-notes");
      invalidateCachePrefix("/api/consignments");
      invalidateCachePrefix("/api/invoices");
      const invoiceId = json.data?.invoiceId;
      const invoiceNo = json.data?.invoiceNo;
      toast.success(`Created Sales Invoice ${invoiceNo ?? ""}`);
      setTransferSIRow(null);
      if (invoiceId) {
        navigate(`/sales/invoices/${invoiceId}`);
      } else {
        navigate("/sales");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Failed to create Sales Invoice: ${msg}`);
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
                    openCreateCNDialog(selected);
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
              {/* CN-to-DO removed 2026-04-28: consignment goods are at the
                  customer; DO is for SO-origin dispatches. */}
              <Button
                variant="outline"
                onClick={() => {
                  // Real consignment_items.id keys (post-2026-04-28 wiring).
                  const qtys: Record<string, number> = {};
                  const selected: Record<string, boolean> = {};
                  for (const it of detailCN.items) {
                    qtys[it.id] = it.quantity;
                    selected[it.id] = true;
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

      {/* Transfer-to-Delivery-Order dialog removed 2026-04-28: consignment
          goods are at the customer's branch already; DO doesn't apply. */}

      {/* -------- Create CN Dialog -------- */}
      {/* Mirrors DO's Create-DO dialog 1:1. Opens when the operator clicks
          Create CN (N) on the Pending CN tab. Collects 3PL Provider /
          Vehicle / Driver / Hub / Delivery Date / Remarks BEFORE the CN
          row is created so the resulting list row immediately shows
          Transport Co. / Driver / Vehicle populated. */}
      {createCNDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => !creatingCNFromPO && setCreateCNDialog(null)}
          />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            <div className="px-6 py-4 border-b border-[#E2DDD8]">
              <h2 className="text-lg font-bold text-[#1F1D1B]">Create Consignment Note</h2>
              <p className="text-xs text-[#6B7280]">
                Assign 3PL provider, delivery hub, and generate CN
              </p>
            </div>
            <div className="px-6 py-5 space-y-4">
              {/* Items summary — read-only, shows the picked POs. Same layout
                  DO uses on its convert-mode panel. */}
              <div className="bg-[#E0EDF0] border border-[#A8CAD2] rounded-lg p-3">
                <p className="text-sm text-[#3E6570] font-medium mb-2">
                  Items ({createCNDialog.length})
                </p>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {createCNDialog.map((po) => (
                    <div key={po.id} className="flex items-center justify-between text-xs">
                      <span className="font-mono text-[#3E6570]">
                        {po.productCode} — {po.sizeLabel}
                      </span>
                      <span className="text-[#3E6570]">
                        {po.customerName} · Qty {po.quantity}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* 3PL Provider — picks the company; vehicle + driver pickers
                  below filter to that provider's three_pl_vehicles +
                  three_pl_drivers rows respectively. */}
              <div>
                <label className="text-xs text-[#6B7280] font-medium">3PL Provider</label>
                <select
                  value={createCNForm.providerId}
                  onChange={(e) =>
                    // Reset vehicle + driver picks when provider changes —
                    // their option lists are scoped to the chosen company.
                    setCreateCNForm((f) => ({
                      ...f,
                      providerId: e.target.value,
                      vehicleId: "",
                      driverPersonId: "",
                    }))
                  }
                  className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                >
                  <option value="">— Select 3PL Provider —</option>
                  {providers
                    .filter((p) => p.status === "ACTIVE")
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </div>

              {/* Vehicle — optional. Per-vehicle rate overrides the company
                  rate when computing Est. Delivery Cost. */}
              <div>
                <label className="text-xs text-[#6B7280] font-medium">Vehicle</label>
                <select
                  value={createCNForm.vehicleId}
                  onChange={(e) =>
                    setCreateCNForm((f) => ({ ...f, vehicleId: e.target.value }))
                  }
                  disabled={!createCNForm.providerId}
                  className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32] disabled:bg-[#F9F7F5] disabled:text-[#999]"
                >
                  <option value="">
                    {createCNForm.providerId ? "— Optional —" : "Pick provider first"}
                  </option>
                  {createCNVehicles
                    .filter((v) => v.status === "ACTIVE")
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.plateNo}
                        {v.vehicleType ? ` — ${v.vehicleType}` : ""}
                        {typeof v.ratePerTripSen === "number"
                          ? ` (RM${(v.ratePerTripSen / 100).toFixed(0)}/trip)`
                          : ""}
                      </option>
                    ))}
                </select>
              </div>

              {/* Driver — optional, the actual person from three_pl_drivers. */}
              <div>
                <label className="text-xs text-[#6B7280] font-medium">Driver</label>
                <select
                  value={createCNForm.driverPersonId}
                  onChange={(e) =>
                    setCreateCNForm((f) => ({ ...f, driverPersonId: e.target.value }))
                  }
                  disabled={!createCNForm.providerId}
                  className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32] disabled:bg-[#F9F7F5] disabled:text-[#999]"
                >
                  <option value="">
                    {createCNForm.providerId ? "— Optional —" : "Pick provider first"}
                  </option>
                  {createCNDrivers
                    .filter((d) => d.status === "ACTIVE")
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {d.phone ? ` — ${d.phone}` : ""}
                      </option>
                    ))}
                </select>
              </div>

              {/* Delivery Destination — CN typically delivers to ONE customer
                  hub. Mirrors DO's drops UI but collapsed to a single hub
                  picker since multi-drop doesn't apply here. */}
              {(() => {
                const first = createCNDialog[0];
                const cust = customersData.find((c) => c.id === first?.customerId);
                const hubs = cust?.deliveryHubs ?? [];
                return (
                  <div>
                    <label className="text-xs text-[#6B7280] font-medium mb-2 block">
                      Delivery Destination
                    </label>
                    <div className="bg-[#FAF9F7] border border-[#E2DDD8] rounded-lg p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-[#1F1D1B]">
                          {first?.customerName ?? "—"}
                        </span>
                        <span className="text-[10px] text-[#999]">
                          {createCNDialog.length} item
                          {createCNDialog.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      <select
                        value={createCNForm.hubId}
                        onChange={(e) =>
                          setCreateCNForm((f) => ({ ...f, hubId: e.target.value }))
                        }
                        className="w-full h-8 px-2 rounded border border-[#DDD] text-xs bg-white focus:outline-none focus:border-[#6B5C32]"
                      >
                        {hubs.length === 0 && <option value="">No hubs configured</option>}
                        {hubs.map((h) => (
                          <option key={h.id} value={h.id}>
                            {h.shortName} ({h.state})
                          </option>
                        ))}
                      </select>
                      {(() => {
                        const hub = hubs.find((h) => h.id === createCNForm.hubId);
                        if (!hub) return null;
                        return (
                          <>
                            <p className="text-[11px] text-[#666] leading-snug mt-1.5">
                              {hub.address}
                            </p>
                            <p className="text-[10px] text-[#999] mt-0.5">
                              {hub.contactName || "—"} · {hub.phone || "—"}
                            </p>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                );
              })()}

              {/* Est. Delivery Cost — picks per-vehicle rate when a vehicle
                  is chosen, falls back to the legacy company rate otherwise.
                  CN is single-drop so the multi-drop scaling DO uses
                  reduces to the base trip rate. */}
              <div className="flex items-center justify-between bg-[#F5F3F0] rounded-lg px-3 py-2">
                <span className="text-xs text-[#6B7280]">Est. Delivery Cost</span>
                <span className="text-sm font-semibold text-[#1F1D1B]">
                  {(() => {
                    const v = createCNVehicles.find((vv) => vv.id === createCNForm.vehicleId);
                    if (v && typeof v.ratePerTripSen === "number") {
                      return `RM ${(v.ratePerTripSen / 100).toFixed(2)}`;
                    }
                    const p = providersRated.find((pr) => pr.id === createCNForm.providerId);
                    if (p && typeof p.ratePerTripSen === "number") {
                      return `RM ${(p.ratePerTripSen / 100).toFixed(2)}`;
                    }
                    return "—";
                  })()}
                </span>
              </div>

              {/* Delivery Date — planned dispatch date. Optional at create
                  time so users with no firm date can still cut a CN; can
                  be filled in later via Edit. Mapped to BE sentDate on
                  POST since CN has no separate deliveryDate column. */}
              <div>
                <label className="text-xs text-[#6B7280] font-medium">Delivery Date</label>
                <input
                  type="date"
                  value={createCNForm.deliveryDate}
                  onChange={(e) =>
                    setCreateCNForm((f) => ({ ...f, deliveryDate: e.target.value }))
                  }
                  className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                />
              </div>

              {/* Remarks — mapped to BE notes on POST. */}
              <div>
                <label className="text-xs text-[#6B7280] font-medium">Remarks</label>
                <input
                  type="text"
                  value={createCNForm.remarks}
                  onChange={(e) =>
                    setCreateCNForm((f) => ({ ...f, remarks: e.target.value }))
                  }
                  className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-[#E2DDD8] flex items-center justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setCreateCNDialog(null)}
                disabled={creatingCNFromPO}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={confirmCreateCN}
                disabled={creatingCNFromPO}
              >
                {creatingCNFromPO ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" /> Creating...
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4" /> Create CN
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* -------- Mark Dispatched Dialog -------- */}
      {/* Mirrors the 3PL section of DO's Create-DO dialog 1:1. Three pickers
          (Provider company → Vehicle → Driver person) chained so vehicle +
          driver lists scope to the picked provider. On confirm, PUTs the
          picked ids onto the CN row + flips status='PARTIALLY_SOLD'. */}
      {dispatchDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => !dispatchSaving && setDispatchDialog(null)}
          />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 border border-[#E2DDD8]">
            <div className="px-6 py-4 border-b border-[#E2DDD8] flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-[#1F1D1B]">Mark Dispatched</h2>
                <p className="text-xs text-[#6B7280]">
                  Pick transport for {dispatchDialog.cnNo} · {dispatchDialog.customerName}
                </p>
              </div>
              <button
                onClick={() => !dispatchSaving && setDispatchDialog(null)}
                className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              {/* 3PL Provider — picks the company; vehicle + driver pickers
                  below filter to that provider's three_pl_vehicles +
                  three_pl_drivers rows respectively. */}
              <div>
                <label className="text-xs text-[#6B7280] font-medium">3PL Provider</label>
                <select
                  value={dispatchForm.providerId}
                  onChange={(e) =>
                    // Reset vehicle + driver picks when provider changes —
                    // their option lists are scoped to the chosen company.
                    setDispatchForm((f) => ({
                      ...f,
                      providerId: e.target.value,
                      vehicleId: "",
                      driverPersonId: "",
                    }))
                  }
                  className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                >
                  <option value="">— Select 3PL Provider —</option>
                  {providers
                    .filter((p) => p.status === "ACTIVE")
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </div>

              {/* Vehicle — optional; scoped to provider via dispatchVehicles. */}
              <div>
                <label className="text-xs text-[#6B7280] font-medium">Vehicle</label>
                <select
                  value={dispatchForm.vehicleId}
                  onChange={(e) =>
                    setDispatchForm((f) => ({ ...f, vehicleId: e.target.value }))
                  }
                  disabled={!dispatchForm.providerId}
                  className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32] disabled:bg-[#F9F7F5] disabled:text-[#999]"
                >
                  <option value="">
                    {dispatchForm.providerId ? "— Optional —" : "Pick provider first"}
                  </option>
                  {dispatchVehicles
                    .filter((v) => v.status === "ACTIVE")
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.plateNo}
                        {v.vehicleType ? ` — ${v.vehicleType}` : ""}
                      </option>
                    ))}
                </select>
              </div>

              {/* Driver person — optional; scoped to provider via dispatchDrivers. */}
              <div>
                <label className="text-xs text-[#6B7280] font-medium">Driver</label>
                <select
                  value={dispatchForm.driverPersonId}
                  onChange={(e) =>
                    setDispatchForm((f) => ({ ...f, driverPersonId: e.target.value }))
                  }
                  disabled={!dispatchForm.providerId}
                  className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32] disabled:bg-[#F9F7F5] disabled:text-[#999]"
                >
                  <option value="">
                    {dispatchForm.providerId ? "— Optional —" : "Pick provider first"}
                  </option>
                  {dispatchDrivers
                    .filter((d) => d.status === "ACTIVE")
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {d.phone ? ` — ${d.phone}` : ""}
                      </option>
                    ))}
                </select>
              </div>

              <p className="text-xs text-[#9CA3AF] pt-1">
                Provider is optional — leaving everything blank still flips the CN to
                Dispatched, but the Transport Co. / Driver / Vehicle columns will stay
                empty until edited.
              </p>
            </div>
            <div className="px-6 py-4 border-t border-[#E2DDD8] flex items-center justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setDispatchDialog(null)}
                disabled={dispatchSaving}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={confirmDispatch}
                disabled={dispatchSaving}
              >
                {dispatchSaving ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" /> Dispatching...
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" /> Mark Dispatched
                  </>
                )}
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
                      <th className="text-right px-3 py-2 text-xs text-[#9CA3AF] font-medium w-20">Sent</th>
                      <th className="text-right px-3 py-2 text-xs text-[#9CA3AF] font-medium w-24">Return Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Iterate the real consignment_items so the row keys match
                        the DB ids the new POST /:id/return endpoint expects. */}
                    {transferCRRow.items.map((item) => (
                      <tr key={item.id} className={`border-t border-[#E2DDD8] ${!crSelectedItems[item.id] ? "opacity-50" : ""}`}>
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={!!crSelectedItems[item.id]}
                            onChange={(e) => setCrSelectedItems((prev) => ({ ...prev, [item.id]: e.target.checked }))}
                            className="rounded border-[#E2DDD8] text-[#6B5C32] focus:ring-[#6B5C32]"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <p className="font-medium">{item.productName || item.productCode || "Unnamed item"}</p>
                          <p className="text-xs text-[#9CA3AF]">{item.productCode}</p>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{item.quantity}</td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            min={1}
                            max={item.quantity}
                            value={crReturnQtys[item.id] ?? item.quantity}
                            onChange={(e) => {
                              const val = Math.max(1, Math.min(item.quantity, parseInt(e.target.value) || 1));
                              setCrReturnQtys((prev) => ({ ...prev, [item.id]: val }));
                            }}
                            disabled={!crSelectedItems[item.id]}
                            className="w-20 rounded-md border border-[#E2DDD8] px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32] disabled:bg-gray-100"
                          />
                        </td>
                      </tr>
                    ))}
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
