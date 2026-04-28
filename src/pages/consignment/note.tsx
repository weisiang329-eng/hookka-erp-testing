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
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
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
  Pencil,
  Trash2,
  ReceiptText,
  Save,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
  totalM3: number;          // sum of items[].itemM3 * items[].quantity — DO equivalent: row.totalM3
  totalValueSen: number;
  dispatchDate: string | null;
  // inTransitAt — ISO timestamp stamped on PARTIALLY_SOLD → IN_TRANSIT
  // ("Mark In Transit"). Drives the In Transit step in the Detail
  // dialog's Tracking timeline. Persisted by migration 0078; mirrors
  // DO's delivery_orders.inTransitAt. Field name matches the API
  // payload (rather than the dispatchDate/deliveredDate convention)
  // so the source-of-truth column is unambiguous in code review.
  inTransitAt: string | null;
  deliveredDate: string | null;
  status: CNStatus;
  // Transport fields — backend already stores these on CN as of migration 0066
  // (consignment_notes.vehicleId / driverId / vehicleNo / vehicleType /
  // driverName / driverPhone). We surface them on the row so the Edit dialog
  // can pre-select the persisted vehicle and the Mark Dispatched dialog can
  // pre-fill from existing data when re-dispatching. DO equivalents:
  // row.driverId / row.vehicleId / row.driverName / row.vehicleNo.
  driverId: string | null;   // 3PL provider id (legacy column name) — for company lookup
  vehicleId: string | null;  // three_pl_vehicles.id — drives Edit dialog vehicle pre-select
  driverCompany: string;     // backend `driverContactPerson` — provider's company-level dispatcher contact (Company Contact)
  driverName: string;        // person on the trip (denormalized from three_pl_drivers.name)
  driverPhone: string;       // person on the trip — phone (denormalized from three_pl_drivers.phone)
  vehicleNo: string;
  vehicleType: string;       // truck type (denormalized from three_pl_vehicles.vehicleType)
  // Destination hub. CN's `branchName` is just a free-text label; the real
  // address / contact / phone live on the customer.deliveryHubs row keyed
  // by hubId. The Detail dialog resolves these via the customer's
  // deliveryHubs list (DO equivalent: detailDO.deliveryAddress / contactPerson /
  // contactPhone are stored directly on the DO — CN doesn't denormalize
  // them, hence the join here).
  hubId: string | null;
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
    sizeLabel: string;       // joined from products.sizeLabel via productSizeMap
    fabricCode: string;      // joined from production_orders.fabricCode via poToFabricMap (only when CN was created from a PO)
    rackingNumber: string;   // joined from production_orders.rackingNumber via poToRackMap
    itemM3: number;          // joined from products.unitM3 via productM3Map (per-unit; *quantity for line total)
    quantity: number;
    unitPrice: number;
    productionOrderId: string | null;
    consignmentOrderNo: string; // joined from poToCoNoMap — the parent CO No (DO equiv: salesOrderNo)
  }>;
};

// CN status mapping. See note on CNStatus above for why we re-skin the
// legacy status enum into a DO-shaped lifecycle.
//
// IN_TRANSIT (added with migration 0078) maps 1:1 from the backend status
// — it gets its own enum value because the In Transit tab + KPI card need
// to distinguish "dispatched & still at warehouse" from "dispatched & out
// for delivery". Until 0078, the FE's IN_TRANSIT case was unreachable
// (no backend status produced it) so the In Transit tab + counter were
// always 0.
function cnStatusFromBackend(s: string | undefined | null): CNStatus {
  switch (s) {
    case "ACTIVE": return "PENDING";          // created, not yet dispatched
    case "PARTIALLY_SOLD": return "DISPATCHED"; // some items left the warehouse
    case "IN_TRANSIT": return "IN_TRANSIT";   // out for delivery to the branch (post 0078)
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
  productM3Map: Map<string, number>,
  poToCoNoMap: Map<string, string>,
  poToFabricMap: Map<string, string>,
  poToRackMap: Map<string, string>,
): ConsignmentNoteRow {
  const totalQty = cn.items.reduce((s, i) => s + i.quantity, 0);
  // totalM3 sums per-item volume × quantity, with per-unit volume joined
  // from products.unitM3 (productM3Map). Mirrors DO's totalM3 (which the
  // DO backend computes server-side); CN backend doesn't compute it, so we
  // derive client-side using the same product master that feeds the items
  // table footer (line 2824) — ensures the basics-grid Total M³ matches
  // the items-table Total M³.
  const totalM3 = (cn.items || []).reduce(
    (s, it) =>
      s + (productM3Map.get(it.productCode || "") || 0) * (it.quantity || 0),
    0,
  );
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
    totalM3,
    totalValueSen: cn.totalValue,
    // dispatchDate prefers the dispatchedAt timestamp (when status moved
    // to PARTIALLY_SOLD); falls back to sentDate (the CN creation date)
    // for legacy rows where the timestamp is null.
    dispatchDate: cn.dispatchedAt || cn.sentDate || null,
    // inTransitAt (migration 0078) — null until the operator hits Mark
    // In Transit. Read directly from the API payload so the Tracking
    // timeline shows the precise stamp rather than the dispatch date.
    inTransitAt: cn.inTransitAt || null,
    deliveredDate: cn.deliveredAt || null,
    status: cnStatusFromBackend(cn.status),
    // Display the 3PL company name (driverContactPerson holds the dispatcher
    // contact, but for the Transport Co. column we want the company itself —
    // resolved from cn.driverId via the providers list at render time, with
    // driverName as fallback to keep legacy rows visible).
    driverId: cn.driverId ?? null,
    // vehicleId — backend stores it as of migration 0066 (resolveTransport
    // in consignment-note-shared.ts persists it). Surfacing it on the row
    // lets the Edit dialog pre-select the saved vehicle (bug fix
    // 2026-04-28: dropdown was opening blank even when a vehicle was set).
    vehicleId: cn.vehicleId ?? null,
    driverCompany: cn.driverContactPerson || "",
    driverName: cn.driverName || "",
    driverPhone: cn.driverPhone || "",
    vehicleNo: cn.vehicleNo || "",
    vehicleType: cn.vehicleType || "",
    hubId: cn.hubId ?? null,
    remarks: cn.notes || "",
    items: (cn.items || []).map((it) => ({
      id: it.id,
      productCode: it.productCode || "",
      productName: it.productName || "",
      sizeLabel: productSizeMap.get(it.productCode || "") || "",
      // Fabric + racking come from the linked PO (CN doesn't store them on
      // consignment_items). DO does the same join — DO's items[].fabricCode
      // is set during DO-from-PO creation. CN gets it via the PO lookup.
      fabricCode:
        (it.productionOrderId && poToFabricMap.get(it.productionOrderId)) || "",
      rackingNumber:
        (it.productionOrderId && poToRackMap.get(it.productionOrderId)) || "",
      // Per-unit m³ from product master (mirrors DO's productM3Map join).
      itemM3: productM3Map.get(it.productCode || "") || 0,
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
  // Same name-to-id resolve trick the edit-mode flow uses — see
  // pendingDriverNameToResolveRef declaration above. The dispatch dialog
  // pre-fills providerId/vehicleId from the CN row when reopening (e.g.
  // after a Reverse to Pending Dispatch), and this ref lets it also
  // pre-fill the driverPersonId by name once the per-provider drivers
  // list resolves. Bug fix 2026-04-28: dispatch dialog opened with all
  // three dropdowns blank even when the CN already had transport set
  // from creation (CGN-2604-001 case).
  const pendingDispatchDriverNameRef = useRef<string>("");

  // ----- Detail Edit mode (mirrors DO's inline edit-mode 1:1) -----
  // editMode swaps the read-only Detail dialog into mutable inputs without
  // navigating away. enterEditMode() seeds the form/items from the
  // currently-shown detailCN; saveEditCN() PUTs the merged body to
  // /api/consignment-notes/:id. Same pattern src/pages/delivery/index.tsx
  // uses for DO — see the comment block above its `editMode` state for the
  // full design rationale.
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState({
    providerId: "",
    vehicleId: "",
    driverPersonId: "",
    hubId: "",
    deliveryDate: "",
    remarks: "",
  });
  const [editItems, setEditItems] = useState<ConsignmentNoteRow["items"]>([]);
  const [editSaving, setEditSaving] = useState(false);
  // Provider-scoped vehicle + driver caches for the edit dialog. Separate
  // from dispatch/createCN caches so opening Edit doesn't stomp those
  // lists. Same DO pattern (editDialogVehicles vs createDialogVehicles).
  const [editVehicles, setEditVehicles] = useState<ThreePLVehicleShape[]>([]);
  const [editDrivers, setEditDrivers] = useState<ThreePLDriverShape[]>([]);
  // Edit-mode bug fix 2026-04-28: consignment_notes only persists driverId
  // (PROVIDER company) + driverName (denormalized PERSON name) — the
  // PERSON id is not in any column. Re-deriving it on Edit means we have
  // to wait for the provider's three_pl_drivers list to load and match by
  // name. This ref carries the pending name across the async fetch so the
  // useEffect that watches editDrivers can finish the resolve. Cleared
  // when match found or when the user closes the edit dialog. Mirrors
  // DO's identical pendingDriverNameToResolveRef pattern at
  // src/pages/delivery/index.tsx:409.
  const pendingDriverNameToResolveRef = useRef<string>("");
  // Add Items panel — same toggle-then-search-then-click flow DO uses.
  const [editAddItemSearch, setEditAddItemSearch] = useState("");
  const [editShowAddItemPanel, setEditShowAddItemPanel] = useState(false);

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

  // Whole-dataset KPI / tab counts. Hoisted up here next to the other
  // useCachedJson hooks so fetchData() can invalidate + refetch in one
  // shot. Replaces the cnList-derived counts that were paginated to
  // PAGE_SIZE rows; route header in src/api/routes/consignment-notes.ts
  // documents the bucket → status mapping. pendingCN intentionally NOT
  // served — see route header for the deferred-work rationale.
  const {
    data: cnStatsRaw,
    refresh: refreshCNStats,
  } = useCachedJson<{
    success?: boolean;
    data?: {
      pendingDispatch?: number;
      dispatched?: number;
      inTransit?: number;
      delivered?: number;
      deliveredMTD?: number;
      acknowledged?: number;
    };
  }>("/api/consignment-notes/stats");

  const fetchData = useCallback(() => {
    invalidateCachePrefix("/api/consignment-notes");
    invalidateCachePrefix("/api/consignment-orders");
    invalidateCachePrefix("/api/production-orders");
    invalidateCachePrefix("/api/products");
    refreshCNs();
    refreshCOs();
    refreshPOs();
    refreshProducts();
    // /stats lives under /api/consignment-notes/* so invalidateCachePrefix
    // above already dropped its cached entry — explicit refresh kicks the
    // background refetch immediately so KPI cards + tab badges update
    // without waiting for the next mount/visibility change.
    refreshCNStats();
  }, [refreshCNs, refreshCOs, refreshPOs, refreshProducts, refreshCNStats]);

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

  // Lookup: productionOrderId → fabricCode. Same join trick as poToCoNoMap
  // — the CN Detail dialog's Items table needs a Fabric column to mirror
  // DO's, but consignment_items doesn't store fabricCode (DO carries it on
  // delivery_order_items because DO-from-PO creation copies it). For CN, we
  // resolve it from the linked PO at render time.
  const poToFabricMap = useMemo(() => {
    const m = new Map<string, string>();
    const arr = poRaw?.success ? poRaw.data : null;
    if (Array.isArray(arr)) {
      for (const po of arr) {
        if (po?.id) m.set(po.id, po.fabricCode || "");
      }
    }
    return m;
  }, [poRaw]);

  // Lookup: productionOrderId → rackingNumber. Same rationale as
  // poToFabricMap — Detail dialog Items table needs a Rack column. The PO
  // carries the racking assignment after upholstery completion.
  const poToRackMap = useMemo(() => {
    const m = new Map<string, string>();
    const arr = poRaw?.success ? poRaw.data : null;
    if (Array.isArray(arr)) {
      for (const po of arr) {
        if (po?.id) m.set(po.id, po.rackingNumber || "");
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
        if (dRes?.success && Array.isArray(dRes.data)) {
          setDispatchDrivers(dRes.data);
          // Resolve PERSON id by name once the drivers list loads.
          // Mirrors the edit-mode flow above — CN persists only the
          // PERSON name (driverName), not the id, so we hydrate the
          // dropdown by name match.
          const wanted = pendingDispatchDriverNameRef.current.trim();
          if (wanted) {
            const match = dRes.data.find(
              (d) => (d.name || "").trim() === wanted,
            );
            if (match) {
              setDispatchForm((f) =>
                f.driverPersonId ? f : { ...f, driverPersonId: match.id },
              );
            }
            pendingDispatchDriverNameRef.current = "";
          }
        }
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

  // Edit dialog vehicle/driver picker scope — mirrors DO's
  // editDialogVehicles / editDialogDrivers effect 1:1. Refetches whenever
  // the user picks a different provider in the inline edit-mode form.
  // Also resolves the PERSON id by name once the drivers list loads —
  // see pendingDriverNameToResolveRef declaration above for rationale.
  /* eslint-disable react-hooks/set-state-in-effect -- mirror remote data into local state */
  useEffect(() => {
    const pid = editForm.providerId;
    if (!pid) {
      setEditVehicles([]);
      setEditDrivers([]);
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
        if (vRes?.success && Array.isArray(vRes.data)) setEditVehicles(vRes.data);
        if (dRes?.success && Array.isArray(dRes.data)) {
          setEditDrivers(dRes.data);
          // Resolve PERSON id by name match on Edit (mirrors DO 1:1).
          // consignment_notes persists only the PERSON's name, not id;
          // this is the only place we can hydrate the dropdown selection.
          const wanted = pendingDriverNameToResolveRef.current.trim();
          if (wanted) {
            const match = dRes.data.find(
              (d) => (d.name || "").trim() === wanted,
            );
            if (match) {
              setEditForm((f) =>
                f.driverPersonId ? f : { ...f, driverPersonId: match.id },
              );
            }
            // One-shot — clear so a stale name doesn't bleed into the
            // next edit session if the user opens Edit on a different CN.
            pendingDriverNameToResolveRef.current = "";
          }
        }
      })
      .catch(() => {
        /* swallow — same swallow pattern DO uses */
      });
    return () => {
      cancelled = true;
    };
  }, [editForm.providerId]);
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
          mapCNToRow(
            cn,
            productSizeMap,
            productM3Map,
            poToCoNoMap,
            poToFabricMap,
            poToRackMap,
          ),
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
  }, [cnRaw, poRaw, coOrdersRaw, cnLoading, poLoading, coOrdersLoading, prodLoading, productM3Map, productSizeMap, poToCoNoMap, poToFabricMap, poToRackMap]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ---------- Filtered data (CN-list tabs only) ----------
  const filteredCNs = useMemo(() => {
    const statuses = TAB_CN_STATUSES[activeTab];
    if (!statuses) return []; // PO-based tab — no CN rows
    return cnList.filter((c) => statuses.includes(c.status));
  }, [cnList, activeTab]);

  // ---------- Summary counts (mirrors DO's KPI strip) ----------
  // Counts pulled from /api/consignment-notes/stats (hoisted hook above)
  // so KPI cards + tab badges reflect the FULL dataset, not just the
  // current paginated page. The cnList-based counts the page used
  // previously undercounted any time the production dataset crossed
  // PAGE_SIZE (200). Follow-up to migration 0078; same /stats pattern
  // as /api/delivery-orders/stats on the DO side.
  //
  // pendingCN intentionally NOT served from /stats — its derivation
  // requires walking production_orders + their job_cards + the linked CN
  // items just for a count, which would duplicate the FE's existing
  // readyPOs computation. We keep the FE-side derivation
  // (`readyPOs.length`) for now; the route header in
  // src/api/routes/consignment-notes.ts documents the deferred work.
  const cnStatsData = cnStatsRaw?.data;
  const pendingDispatchCount = cnStatsData?.pendingDispatch ?? 0;
  const dispatchedCount = cnStatsData?.dispatched ?? 0;
  const inTransitCount = cnStatsData?.inTransit ?? 0;
  const deliveredCount = cnStatsData?.delivered ?? 0;
  const acknowledgedCount = cnStatsData?.acknowledged ?? 0;
  const deliveredMTD = cnStatsData?.deliveredMTD ?? 0;
  // Pending-CN count ignores the customer dedup since the user wants to
  // see the raw pipeline pressure. Still computed client-side — see
  // /stats route header for why pendingCN was intentionally left out.
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
        // Clear pending name resolution so the next dispatch dialog open
        // (different CN) starts with a clean slate.
        pendingDispatchDriverNameRef.current = "";
        fetchData();
      }
    } catch {
      toast.error("Failed to mark dispatched");
    } finally {
      setDispatchSaving(false);
    }
  }, [dispatchDialog, dispatchForm, fetchData, toast]);

  // ---------- Edit mode helpers (mirrors DO's enterEditMode etc.) ----------
  // enterEditMode seeds the editForm/editItems from the CN row currently
  // shown in the Detail dialog, then flips editMode=true so the same dialog
  // re-renders with mutable inputs. Mirrors src/pages/delivery/index.tsx
  // line ~1340 1:1 with the CN field-name swaps.
  //
  // Bug fix 2026-04-28 (BUG-1): dropdowns previously hardcoded
  // vehicleId:"" / driverPersonId:"". Now we pre-select vehicleId from the
  // row directly and stash driverName for resolve-by-name once the
  // per-provider drivers list loads (DO's pendingDriverNameToResolveRef
  // pattern at src/pages/delivery/index.tsx:1340).
  const enterEditMode = (row: ConsignmentNoteRow) => {
    // CN persists the PROVIDER company id under the legacy `driverId`
    // column (same reuse trick DO does). Drive the picker off it directly,
    // falling back to a name-match for legacy CNs where driverId is null
    // but the company name was denormalized into driverName.
    const matchedProvider =
      providers.find((p) => p.id === row.driverId) ??
      providers.find((p) => p.name === row.driverName);
    // PERSON id is not stored on consignment_notes — only the PERSON name
    // (driverName denormalize). Stash that name so the editDrivers fetch
    // effect can resolve it back to a PERSON id once the drivers list
    // loads. One-shot — cleared on first match or on cancelEditMode.
    pendingDriverNameToResolveRef.current = row.driverName || "";
    setEditForm({
      providerId: matchedProvider?.id || "",
      // vehicleId is now persisted on the CN row (added 2026-04-28); pre-
      // select directly so the Vehicle dropdown opens populated instead
      // of "— Optional —".
      vehicleId: row.vehicleId || "",
      driverPersonId: "",
      hubId: row.hubId || "",
      // CN's wire field for "planned dispatch date" is sentDate (mapped to
      // detailCN.dispatchDate in the row VM). Slice off the time portion
      // so <input type="date"> consumes the YYYY-MM-DD prefix cleanly.
      deliveryDate: row.dispatchDate ? row.dispatchDate.split("T")[0] : "",
      remarks: row.remarks || "",
    });
    setEditItems([...row.items]);
    setEditMode(true);
    setEditShowAddItemPanel(false);
    setEditAddItemSearch("");
  };

  const cancelEditMode = () => {
    setEditMode(false);
    setEditShowAddItemPanel(false);
    setEditAddItemSearch("");
    // Clear stashed pending name so a stale value can't bleed into a
    // subsequent edit session if the user opens Edit on a different CN.
    pendingDriverNameToResolveRef.current = "";
  };

  // ---------- Open Mark Dispatched dialog with pre-fill ----------
  // Bug fix 2026-04-28 (BUG-2): the previous handlers wiped the form to
  // empty strings on open, so a CN that already had Provider + Vehicle +
  // Driver picked at create time (e.g. CGN-2604-001) showed all three
  // dropdowns blank when the operator hit Mark Dispatched. Now we
  // pre-fill from the row, mirroring the same row-derived seeding the
  // edit-mode flow uses. driverPersonId is resolved by name once the
  // per-provider drivers list loads — see pendingDispatchDriverNameRef.
  const openDispatchDialog = useCallback(
    (row: ConsignmentNoteRow) => {
      const matchedProvider =
        providers.find((p) => p.id === row.driverId) ??
        providers.find((p) => p.name === row.driverName);
      pendingDispatchDriverNameRef.current = row.driverName || "";
      setDispatchForm({
        providerId: matchedProvider?.id || "",
        vehicleId: row.vehicleId || "",
        driverPersonId: "",
      });
      setDispatchDialog(row);
    },
    [providers],
  );

  const removeEditItem = (itemId: string) => {
    setEditItems((prev) => prev.filter((i) => i.id !== itemId));
  };

  // Add a Pending-CN PO to the edit items list. Mirrors DO's addReadyPOToEdit.
  const addReadyPOToEdit = useCallback((po: ReadyPORow) => {
    if (editItems.some((i) => i.productionOrderId === po.id)) return;
    const newItem: ConsignmentNoteRow["items"][number] = {
      id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      productCode: po.productCode,
      productName: po.productName,
      sizeLabel: po.sizeLabel,
      fabricCode: po.fabricCode,
      rackingNumber: po.rackingNumber,
      itemM3: po.unitM3 ?? 0,
      quantity: po.quantity,
      unitPrice: 0,
      productionOrderId: po.id,
      consignmentOrderNo: po.consignmentOrderNo,
    };
    setEditItems((prev) => [...prev, newItem]);
  }, [editItems]);

  // Available POs for the Add Items panel. Same filter rules as DO:
  //   • exclude POs already on the CN
  //   • free-text search on PO no, product code/name, customer, CO no
  // Scoped to the CN's customerId so only same-customer POs appear (CN is
  // single-customer per row, so cross-customer adds aren't valid).
  const addableEditPOs = useMemo(() => {
    if (!editShowAddItemPanel) return [] as ReadyPORow[];
    const detailCustomerId = detailCN?.customerId || "";
    const existingPOIds = new Set(
      editItems
        .map((i) => i.productionOrderId)
        .filter((x): x is string => !!x),
    );
    let filtered = readyPOs.filter(
      (po) =>
        !existingPOIds.has(po.id) &&
        (!detailCustomerId || po.customerId === detailCustomerId),
    );
    if (editAddItemSearch) {
      const q = editAddItemSearch.toLowerCase();
      filtered = filtered.filter(
        (po) =>
          po.poNo.toLowerCase().includes(q) ||
          po.productCode.toLowerCase().includes(q) ||
          po.productName.toLowerCase().includes(q) ||
          po.customerName.toLowerCase().includes(q) ||
          po.consignmentOrderNo.toLowerCase().includes(q),
      );
    }
    return filtered;
  }, [editShowAddItemPanel, editItems, readyPOs, editAddItemSearch, detailCN]);

  // PUT the merged edit body to /api/consignment-notes/:id. Mirrors DO's
  // saveEditDO but addressed against the CN endpoint. The backend
  // (updateConsignmentNoteById) accepts providerId/vehicleId/driverId,
  // hubId, and notes — those persist. sentDate (deliveryDate) and items[]
  // are sent on the body for forward-compat but the current backend
  // doesn't update them (see follow-up notes).
  const saveEditCN = async () => {
    if (!detailCN) return;
    setEditSaving(true);
    try {
      const res = await fetch(`/api/consignment-notes/${detailCN.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: editForm.providerId || null,
          vehicleId: editForm.vehicleId || null,
          driverId: editForm.driverPersonId || null,
          hubId: editForm.hubId || null,
          // CN's "planned dispatch" wire field is sentDate. Backend
          // doesn't currently UPDATE this column on PUT; sent for
          // forward-compat so when that lands the FE keeps working.
          sentDate: editForm.deliveryDate || null,
          notes: editForm.remarks,
          items: editItems.map((i) => ({
            id: i.id,
            productionOrderId: i.productionOrderId,
            productCode: i.productCode,
            productName: i.productName,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
          })),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: ConsignmentNote;
        error?: string;
      };
      if (!res.ok || !body.success) {
        toast.error(body.error || "Failed to save changes");
        return;
      }
      // Re-map the returned CN through mapCNToRow so detailCN reflects
      // the persisted state (provider/vehicle/driver names denormalized
      // by resolveTransport, branchName resolved from hubId, etc.).
      if (body.data) {
        const updated = mapCNToRow(
          body.data as ConsignmentNote,
          productSizeMap,
          productM3Map,
          poToCoNoMap,
          poToFabricMap,
          poToRackMap,
        );
        setDetailCN(updated);
      }
      toast.success(`${detailCN.cnNo} saved`);
      setEditMode(false);
      setEditShowAddItemPanel(false);
      fetchData();
    } catch {
      toast.error("Failed to save changes");
    } finally {
      setEditSaving(false);
    }
  };

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
        // Bug fix 2026-04-28 (BUG-3): the secondary line previously showed
        // formatCurrency(totalValueSen) which read "RM 0.00" because the
        // CN backend doesn't compute a unit price on consignment items
        // today (consignment goods are priced at sale time, not dispatch
        // time). DO's identical column shows "X items · X.XX m³" instead,
        // which is the dispatch-stage info the operator actually needs.
        // Mirroring DO 1:1 here.
        render: (_value, row) => (
          <div className="flex flex-col gap-0.5 text-xs leading-tight">
            <span className="font-medium">{STATUS_LABEL[row.status] ?? row.status}</span>
            <span className="text-[#9CA3AF] tabular-nums">
              {row.itemCount} item{row.itemCount === 1 ? "" : "s"} · {(row.totalM3 ?? 0).toFixed(2)} m³
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
        // Pre-fills the dialog from the row's persisted Provider / Vehicle /
        // Driver — see openDispatchDialog comment for rationale.
        action: () => openDispatchDialog(row),
      },
      // Mark In Transit — DISPATCHED → IN_TRANSIT, stamps inTransitAt
      // server-side. Mirrors DO's "Mark Out for Delivery (In Transit)"
      // action. Until migration 0078, this transition was unreachable
      // from the FE because no backend status produced IN_TRANSIT — the
      // In Transit tab + KPI card always read 0. The button is gated to
      // DISPATCHED only (one forward step at a time); operators wanting
      // to skip straight to Delivered can still use Mark Delivered which
      // accepts both DISPATCHED and IN_TRANSIT as `from` states.
      {
        label: "Mark In Transit",
        icon: <Truck className="h-3.5 w-3.5" />,
        disabled: row.status !== "DISPATCHED",
        action: async () => {
          try {
            const res = await fetch("/api/consignment-notes", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: row.id, status: "IN_TRANSIT" }),
            });
            if (!res.ok) {
              toast.error("Failed to mark in transit");
            } else {
              toast.success(`${row.cnNo} marked in transit`);
              fetchData();
            }
          } catch {
            toast.error("Failed to mark in transit");
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
    [fetchData, toast, reverseStatus, reverseToPendingCN, openDispatchDialog],
  );

  // ---------- Tab counts (mirrors DO) ----------
  // Tab badges read from /stats (whole-dataset) for everything except the
  // PO-driven Planning + Pending CN tabs. The Dispatched tab combines
  // DISPATCHED + IN_TRANSIT to match TAB_CN_STATUSES.dispatched (the
  // operator sees a row in that tab regardless of whether it's still at
  // the warehouse or already on the road).
  const tabCounts: Record<string, number> = {
    planning: planningPOs.length,
    pending_cn: pendingCNCount,
    pending_dispatch: pendingDispatchCount,
    dispatched: dispatchedCount + inTransitCount,
    delivered: deliveredCount,
    acknowledged: acknowledgedCount,
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
  // Bug fix 2026-04-28 (second-pass parity audit): the previous CSV
  // included a "Total Value" column (totalValueSen / 100). CN rows are
  // priced at sale time, not dispatch time — totalValueSen is always 0
  // on freshly-dispatched CNs, so the column read "0.00" for every row
  // and gave operators a misleading impression that the dispatch was
  // worth nothing. Replaced with "Total M³" (sum of items[].itemM3 *
  // quantity), which is the dispatch-stage info that actually has data
  // — same pivot DO does on its row Status cell.
  const handleExportCSV = () => {
    const headers = ["Dispatch Date", "CN No.", "CO Ref", "Customer", "Branch", "Items", "Total M³", "Status"];
    const csvRows = filteredCNs.map((r) => [
      r.dispatchDate ? formatDate(r.dispatchDate) : "",
      r.cnNo,
      r.coRef,
      r.customerName,
      r.branchName,
      r.itemCount,
      (r.totalM3 ?? 0).toFixed(2),
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
      {/* KPI Strip — 5 cards per task spec (second-pass parity   */}
      {/* fix 2026-04-28). DO has 4 cards (Pending Dispatch /     */}
      {/* Dispatched / In Transit / Delivered MTD); CN adds       */}
      {/* "Pending CN" up front because the CO→CN promotion step  */}
      {/* has no DO equivalent (DO promotes from a single SO with */}
      {/* a known DD; CN must wait for the operator to bundle     */}
      {/* per-customer pickups). Order:                           */}
      {/*   Pending CN · Pending Dispatch · Dispatched · In       */}
      {/*   Transit · Delivered (MTD)                             */}
      {/* ====================================================== */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-5">
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
            <div className="rounded-lg bg-[#FDE9CF] p-2.5">
              <ClipboardList className="h-5 w-5 text-[#B5651D]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#B5651D]">{loading ? "-" : pendingDispatchCount}</p>
              <p className="text-xs text-[#6B7280]">Pending Dispatch</p>
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

      {/* ---------- Detail Dialog (DO-parity rebuild 2026-04-28) ----------
          User complaint: CN Detail was a sparse 2-col grid while DO Detail
          is a fully-fledged 3-section layout (Provider / Vehicle / Driver +
          Delivery Info + Items table + Tracking timeline). Per the new
          rule "going forward, CN UI decisions just match DO 1:1", this
          block mirrors src/pages/delivery/index.tsx's detailDO modal
          1:1, with these field substitutions:
            DO field                  →  CN field
            -------------------------    -------------------------
            doNo                      →  cnNo
            customerName              →  customerName
            hubBranch (state code)    →  branchName
            driverId / driverName     →  driverId (provider id) / driverName (person)
            driverContactPerson       →  driverCompany (Company Contact label)
            driverPhone               →  driverPhone
            vehicleNo / vehicleType   →  vehicleNo / vehicleType
            deliveryAddress (on row)  →  resolved from customersData[].deliveryHubs[hubId].address
            contactPerson  (on row)   →  resolved from deliveryHubs[hubId].contactName
            contactPhone   (on row)   →  resolved from deliveryHubs[hubId].phone
            items[].salesOrderNo      →  items[].consignmentOrderNo
            items[].poNo              →  items[].productionOrderId (rendered as CN line id)
            items[].fabricCode/Rack   →  joined from PO via poToFabricMap/poToRackMap
            dispatchDate (timeline)   →  dispatchDate
            receivedDate              →  deliveredDate (for "Delivered" step)
            INVOICED status step      →  ACKNOWLEDGED status step (CN's 4th step)

          Footer buttons mirror DO's status-conditional render:
            PENDING (DRAFT eq.)       →  Edit + Mark Dispatched
            DISPATCHED / IN_TRANSIT   →  Mark Delivered
            DELIVERED                 →  Mark Acknowledged + Convert to Sales Invoice
            ACKNOWLEDGED              →  Close only
          (Edit + Delete iconography only show on PENDING — same gate DO uses
           on its DRAFT-only Pencil/Trash2 buttons.) */}
      {detailCN && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop — backdrop click closes the dialog only when not in
              edit mode (mirrors DO's guard so an accidental backdrop click
              doesn't drop unsaved changes). */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => { if (!editMode) { setDetailCN(null); } }}
          />
          {/* Panel — widened to max-w-3xl to match DO's panel width since the
              new sections need the horizontal real estate. */}
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            {/* Header — icons row mirrors DO: Edit / Delete (PENDING only) +
                Print + Document (link to parent CO) + Close. */}
            <div className="sticky top-0 bg-white border-b border-[#E2DDD8] px-6 py-4 flex items-center justify-between rounded-t-xl z-10">
              <div>
                <h2 className="text-lg font-bold text-[#1F1D1B]">{detailCN.cnNo}</h2>
                <p className="text-xs text-[#6B7280]">
                  {editMode ? "Edit Consignment Note" : "Consignment Note Detail"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {/* Edit + Delete only on PENDING (DO equivalent: DRAFT only).
                    Edit toggles inline edit-mode in the same dialog —
                    matches DO exactly, no separate edit page. */}
                {!editMode && detailCN.status === "PENDING" && (
                  <>
                    <button
                      onClick={() => enterEditMode(detailCN)}
                      className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B5C32] hover:text-[#1F1D1B] transition-colors"
                      title="Edit CN"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    {/* Delete CN — only on PENDING. Same destructive-action
                        guard DO uses on its Trash2 button. Reuses the
                        reverseToPendingCN handler which already prompts +
                        DELETEs via /api/consignments/:id. */}
                    <button
                      onClick={() => {
                        const row = detailCN;
                        setDetailCN(null);
                        reverseToPendingCN(row);
                      }}
                      className="rounded-md p-1.5 hover:bg-rose-50 text-rose-600 hover:text-rose-800 transition-colors"
                      title="Delete CN (Pending Dispatch only)"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </>
                )}
                {/* Print + Document hidden in edit mode (DO does the same)
                    so the user isn't tempted to print a half-edited CN. */}
                {!editMode && (
                  <>
                    <button
                      onClick={() => toast.info(`Printing CN: ${detailCN.cnNo} — coming soon`)}
                      className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors"
                      title="Print CN"
                    >
                      <Printer className="h-4 w-4" />
                    </button>
                    {/* Document — drill through to parent CO detail page (DO
                        equivalent: triggerPrint("packing-list") icon, but we
                        repurpose it here as "go to source doc" since CN doesn't
                        have a separate packing list yet). */}
                    <button
                      onClick={() => navigate(`/consignment/${detailCN.consignmentId}`)}
                      className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors"
                      title="Open parent Consignment Order"
                    >
                      <FileText className="h-4 w-4" />
                    </button>
                  </>
                )}
                <button
                  onClick={() => { if (editMode) cancelEditMode(); else setDetailCN(null); }}
                  className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors"
                  title={editMode ? "Cancel edit" : "Close"}
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="px-6 py-5 space-y-5">
              {/* Status badge — uses Badge variant=status so the color
                  scheme matches the rest of the app (DO uses identical). */}
              <div className="flex items-center gap-3">
                <Badge variant="status" status={detailCN.status}>
                  {STATUS_LABEL[detailCN.status]}
                </Badge>
                {editMode && (
                  <span className="text-xs text-[#9C6F1E] bg-[#FAEFCB] px-2 py-0.5 rounded-full font-medium">Editing</span>
                )}
              </div>

              {/* Info panel — Edit (mutable inputs) vs View (read-only).
                  Mirrors DO's identical conditional layout 1:1. */}
              {editMode ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-[#9CA3AF] text-xs mb-0.5">CN Number</p>
                      <p className="font-medium doc-number">{detailCN.cnNo}</p>
                    </div>
                    <div>
                      <p className="text-[#9CA3AF] text-xs mb-0.5">Customer</p>
                      <p className="font-medium">{detailCN.customerName}</p>
                    </div>
                    {/* Show live edit-items total M³ so the operator sees
                        the volume update as they Add Items / Remove Items
                        in the panel below. Mirrors DO's identical pattern. */}
                    <div>
                      <p className="text-[#9CA3AF] text-xs mb-0.5">Total M³</p>
                      <p className="font-medium">
                        {editItems
                          .reduce((s, i) => s + i.itemM3 * i.quantity, 0)
                          .toFixed(2)}
                      </p>
                    </div>
                  </div>
                  {/* Provider / Vehicle / Driver pickers — chained the same
                      way DO + Mark-Dispatched + Create-CN do. Resetting
                      vehicle + driver on provider change keeps the option
                      list in sync. */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-[#6B7280] font-medium">3PL Provider</label>
                      <select
                        value={editForm.providerId}
                        onChange={(e) =>
                          setEditForm((f) => ({
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
                    {/* Hub picker — CN delivers to ONE hub per row (no
                        multi-drop), so this is a flat select instead of
                        DO's drag-to-reorder drop list. Hubs come from the
                        customer's deliveryHubs[] (already cached). */}
                    <div>
                      <label className="text-xs text-[#6B7280] font-medium">Delivery Hub</label>
                      {(() => {
                        const cust = customersData.find((c) => c.id === detailCN.customerId);
                        const hubs = cust?.deliveryHubs ?? [];
                        return (
                          <select
                            value={editForm.hubId}
                            onChange={(e) => setEditForm((f) => ({ ...f, hubId: e.target.value }))}
                            className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                          >
                            <option value="">— Select hub —</option>
                            {hubs.map((h) => (
                              <option key={h.id} value={h.id}>
                                {h.shortName} ({h.state})
                              </option>
                            ))}
                          </select>
                        );
                      })()}
                    </div>
                    <div>
                      <label className="text-xs text-[#6B7280] font-medium">Vehicle</label>
                      <select
                        value={editForm.vehicleId}
                        onChange={(e) => setEditForm((f) => ({ ...f, vehicleId: e.target.value }))}
                        disabled={!editForm.providerId}
                        className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32] disabled:bg-[#F9F7F5] disabled:text-[#999]"
                      >
                        <option value="">
                          {editForm.providerId ? "— Optional —" : "Pick provider first"}
                        </option>
                        {editVehicles
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
                    <div>
                      <label className="text-xs text-[#6B7280] font-medium">Driver</label>
                      <select
                        value={editForm.driverPersonId}
                        onChange={(e) => setEditForm((f) => ({ ...f, driverPersonId: e.target.value }))}
                        disabled={!editForm.providerId}
                        className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32] disabled:bg-[#F9F7F5] disabled:text-[#999]"
                      >
                        <option value="">
                          {editForm.providerId ? "— Optional —" : "Pick provider first"}
                        </option>
                        {editDrivers
                          .filter((d) => d.status === "ACTIVE")
                          .map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}{d.phone ? ` — ${d.phone}` : ""}
                            </option>
                          ))}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-[#6B7280] font-medium">
                        Delivery Date <span className="text-[#9CA3AF]">(planned)</span>
                      </label>
                      <input
                        type="date"
                        value={editForm.deliveryDate}
                        onChange={(e) => setEditForm((f) => ({ ...f, deliveryDate: e.target.value }))}
                        className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-[#6B7280] font-medium">Remarks</label>
                      <input
                        type="text"
                        value={editForm.remarks}
                        onChange={(e) => setEditForm((f) => ({ ...f, remarks: e.target.value }))}
                        className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                      />
                    </div>
                  </div>
                </div>
              ) : (
              /* View-mode three-section layout (mirrors DO's redesigned
                 2026-04-27 Detail dialog). Header carries CN basics that
                 aggregate cleanly; Provider / Vehicle / Driver are
                 independent blocks; Delivery Info pulls from the
                 customer's hub list. */
              <div className="space-y-4">
                {/* CN Basics — three-cell grid mirrors DO 1:1. Total M³
                    aggregates cleanly across multi-line CNs (sum of
                    items[].itemM3 * quantity, computed in mapCNToRow).
                    The CO Reference moved out of the basics grid into the
                    "Consignment Orders" chip strip below — same pattern DO
                    uses for "Sales Orders". */}
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="text-[#9CA3AF] text-xs mb-0.5">CN Number</p>
                    <p className="font-medium doc-number">{detailCN.cnNo}</p>
                  </div>
                  <div>
                    <p className="text-[#9CA3AF] text-xs mb-0.5">Total M³</p>
                    <p className="font-medium">{(detailCN.totalM3 ?? 0).toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-[#9CA3AF] text-xs mb-0.5">Items</p>
                    <p className="font-medium">{detailCN.items.length}</p>
                  </div>
                </div>

                {/* Consignment Orders covered — comma-separated dedup of
                    items[].consignmentOrderNo. Direct mirror of DO's
                    "Sales Orders" chip strip. Empty for legacy CNs whose
                    items don't carry productionOrderId. */}
                {(() => {
                  const cos = Array.from(
                    new Set(
                      detailCN.items
                        .map((it) => it.consignmentOrderNo)
                        .filter((s) => !!s),
                    ),
                  );
                  if (cos.length === 0) return null;
                  return (
                    <div className="text-sm">
                      <p className="text-[#9CA3AF] text-xs mb-0.5">Consignment Orders</p>
                      <p className="font-medium doc-number">{cos.join(", ")}</p>
                    </div>
                  );
                })()}

                {/* 3PL Provider — company-level info. Provider name resolves
                    from cn.driverId via the providers list (driverId is the
                    legacy column name; it actually holds the providerId
                    post-3PL refactor, same as DO). Falls back to driverName
                    for legacy rows. driverCompany maps to backend's
                    driverContactPerson — the dispatcher contact at the 3PL
                    company (NOT the recipient at the destination, which
                    sits in the Delivery Info block below). */}
                <div className="border-t border-[#E2DDD8] pt-3">
                  <p className="text-xs text-[#6B7280] font-medium mb-2">Provider</p>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-[#9CA3AF] text-xs mb-0.5">Name</p>
                      <p className="font-medium">
                        {(() => {
                          const p = providers.find((pr) => pr.id === detailCN.driverId);
                          return p?.name || detailCN.driverName || "-";
                        })()}
                      </p>
                    </div>
                    <div>
                      <p className="text-[#9CA3AF] text-xs mb-0.5">Company Contact</p>
                      <p className="font-medium">{detailCN.driverCompany || "-"}</p>
                    </div>
                  </div>
                </div>

                {/* Vehicle — plate + type. Both denormalized into the CN
                    row at dispatch time (resolveTransport in
                    consignment-note-shared.ts). Falls back to "-" for CNs
                    that haven't been dispatched yet. */}
                <div className="border-t border-[#E2DDD8] pt-3">
                  <p className="text-xs text-[#6B7280] font-medium mb-2">Vehicle</p>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-[#9CA3AF] text-xs mb-0.5">Plate No.</p>
                      <p className="font-medium doc-number">{detailCN.vehicleNo || "-"}</p>
                    </div>
                    <div>
                      <p className="text-[#9CA3AF] text-xs mb-0.5">Type</p>
                      <p className="font-medium">{detailCN.vehicleType || "-"}</p>
                    </div>
                  </div>
                </div>

                {/* Driver — actual person + their phone (NOT the company
                    dispatcher). Both denormalized at dispatch time from
                    three_pl_drivers via resolveTransport. */}
                <div className="border-t border-[#E2DDD8] pt-3">
                  <p className="text-xs text-[#6B7280] font-medium mb-2">Driver</p>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-[#9CA3AF] text-xs mb-0.5">Name</p>
                      <p className="font-medium">{detailCN.driverName || "-"}</p>
                    </div>
                    <div>
                      <p className="text-[#9CA3AF] text-xs mb-0.5">Driver Contact</p>
                      <p className="font-medium doc-number">{detailCN.driverPhone || "-"}</p>
                    </div>
                  </div>
                </div>

                {/* Delivery Info — Customer + destination address + recipient
                    contact. CN doesn't denormalize address/contact onto the
                    consignment_notes row (DO does), so we resolve these at
                    render time by walking the customer's deliveryHubs[] and
                    matching on cn.hubId. Falls back to "-" if hubId is null
                    or the customer/hub isn't loaded yet. The customer's
                    deliveryHubs[] comes from /api/customers (already cached
                    in customersData for the Create CN dialog's hub picker). */}
                <div className="border-t border-[#E2DDD8] pt-3">
                  <p className="text-xs text-[#6B7280] font-medium mb-2">Delivery Info</p>
                  {(() => {
                    // hubLookup: walk the customer's hub list to find the
                    // matching hub. Returns the address / contactName /
                    // phone we'll display. If hubId is null (CN created
                    // pre-2026-04-28 before hub linkage was wired), all
                    // three fields render "-".
                    const cust = customersData.find((c) => c.id === detailCN.customerId);
                    const hub = cust?.deliveryHubs?.find((h) => h.id === detailCN.hubId);
                    const address = hub?.address || "";
                    const recipName = hub?.contactName || "";
                    const recipPhone = hub?.phone || "";
                    return (
                      <div className="grid grid-cols-1 gap-3 text-sm">
                        <div>
                          <p className="text-[#9CA3AF] text-xs mb-0.5">Customer</p>
                          <p className="font-medium">{detailCN.customerName || "-"}</p>
                        </div>
                        <div>
                          <p className="text-[#9CA3AF] text-xs mb-0.5">Delivery Address</p>
                          <p className="font-medium text-xs">{address || "-"}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-[#9CA3AF] text-xs mb-0.5">Recipient Contact</p>
                            <p className="font-medium">{recipName || "-"}</p>
                          </div>
                          <div>
                            <p className="text-[#9CA3AF] text-xs mb-0.5">Recipient Phone</p>
                            <p className="font-medium doc-number">{recipPhone || "-"}</p>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
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
                      </div>
                    );
                  })()}
                </div>
              </div>
              )}

              {/* Items Table — column-by-column mirror of DO's items table
                  with SO→CO swaps:
                    SO No.       → CO No.       (items[].consignmentOrderNo)
                    SO ID        → CO ID        (items[].productionOrderId — the PO id)
                    Product Code → Product Code (items[].productCode)
                    Product Name → Product Name (items[].productName)
                    Size         → Size         (items[].sizeLabel — joined from products)
                    Fabric       → Fabric       (items[].fabricCode — joined from PO)
                    Qty          → Qty          (items[].quantity)
                    M³           → M³           (items[].itemM3 * quantity)
                    Rack         → Rack         (items[].rackingNumber — joined from PO) */}
              <div className="border-t border-[#E2DDD8] pt-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-[#1F1D1B]">
                    Items ({editMode ? editItems.length : detailCN.items.length})
                  </h3>
                  {editMode && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditShowAddItemPanel(!editShowAddItemPanel)}
                    >
                      <Plus className="h-3.5 w-3.5" /> Add Items
                    </Button>
                  )}
                </div>

                {/* Add Item Panel (edit mode only) — same UX DO has on its
                    edit dialog: search box + click-to-add list. Restricted
                    to POs from the same customer as the CN (CN is single-
                    customer per row). */}
                {editMode && editShowAddItemPanel && (
                  <div className="mb-3 border border-[#A8CAD2] rounded-lg bg-[#E0EDF0]/50 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs text-[#3E6570] font-medium">Available Production Orders</p>
                      <div className="relative">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#9CA3AF]" />
                        <input
                          type="text"
                          placeholder="Search PO, product, CO..."
                          value={editAddItemSearch}
                          onChange={(e) => setEditAddItemSearch(e.target.value)}
                          className="h-7 pl-7 pr-2 w-56 rounded border border-[#A8CAD2] text-xs focus:outline-none focus:border-[#6B5C32]"
                        />
                      </div>
                    </div>
                    <div className="max-h-40 overflow-y-auto space-y-1">
                      {addableEditPOs.length === 0 ? (
                        <p className="text-xs text-[#6B7280] text-center py-3">No available production orders</p>
                      ) : (
                        addableEditPOs.map((po) => (
                          <div
                            key={po.id}
                            className="flex items-center justify-between text-xs bg-white rounded px-2 py-1.5 border border-[#A8CAD2] hover:border-[#A8CAD2] cursor-pointer"
                            onClick={() => addReadyPOToEdit(po)}
                          >
                            <div className="flex items-center gap-3">
                              <span className="font-mono text-[#3E6570]">{po.poNo}</span>
                              <span className="text-[#6B7280]">{po.consignmentOrderNo}</span>
                              <span>{po.productName}</span>
                              <span className="text-[#6B7280]">{po.sizeLabel} · {po.fabricCode}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[#6B7280]">Qty {po.quantity}</span>
                              <Plus className="h-3 w-3 text-[#3E6570]" />
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                <div className="overflow-x-auto border border-[#E2DDD8] rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-[#FAF9F7] text-[#6B7280]">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium text-xs">#</th>
                        <th className="text-left px-3 py-2 font-medium text-xs">CO No.</th>
                        <th className="text-left px-3 py-2 font-medium text-xs">CO ID</th>
                        <th className="text-left px-3 py-2 font-medium text-xs">Product Code</th>
                        <th className="text-left px-3 py-2 font-medium text-xs">Product Name</th>
                        <th className="text-left px-3 py-2 font-medium text-xs">Size</th>
                        <th className="text-left px-3 py-2 font-medium text-xs">Fabric</th>
                        <th className="text-right px-3 py-2 font-medium text-xs">Qty</th>
                        <th className="text-right px-3 py-2 font-medium text-xs">M³</th>
                        <th className="text-left px-3 py-2 font-medium text-xs">Rack</th>
                        {editMode && <th className="text-center px-3 py-2 font-medium text-xs w-[40px]"></th>}
                      </tr>
                    </thead>
                    <tbody>
                      {(editMode ? editItems : detailCN.items).map((item, idx) => (
                        <tr key={item.id} className="border-t border-[#E2DDD8]">
                          <td className="px-3 py-1.5 text-[#9CA3AF] text-xs">{idx + 1}</td>
                          <td className="px-3 py-1.5 font-mono text-xs text-[#6B5C32]">{item.consignmentOrderNo || "-"}</td>
                          {/* CO ID column shows the linked PO id since one
                              CN line = one PO. Operators wanted the visible
                              PO link for traceability — same role as DO's
                              "SO ID" (which actually shows po.poNo there).
                              For CN we surface the productionOrderId. */}
                          <td className="px-3 py-1.5 font-mono text-xs text-[#6B7280]">{item.productionOrderId || "-"}</td>
                          <td className="px-3 py-1.5 font-mono text-xs text-[#6B5C32]">{item.productCode}</td>
                          <td className="px-3 py-1.5">{item.productName}</td>
                          <td className="px-3 py-1.5 text-[#6B7280]">{item.sizeLabel || "-"}</td>
                          <td className="px-3 py-1.5 text-[#6B7280]">{item.fabricCode || "-"}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{item.quantity}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{(item.itemM3 * item.quantity).toFixed(2)}</td>
                          <td className="px-3 py-1.5 font-mono text-xs text-[#6B7280]">{item.rackingNumber || "-"}</td>
                          {editMode && (
                            <td className="px-3 py-1.5 text-center">
                              <button
                                onClick={() => removeEditItem(item.id)}
                                className="p-1 rounded hover:bg-[#F9E1DA] text-[#9CA3AF] hover:text-[#7A2E24] transition-colors"
                                title="Remove item"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-[#FAF9F7]">
                      <tr className="border-t border-[#E2DDD8] font-medium">
                        <td colSpan={7} className="px-3 py-1.5 text-right text-xs text-[#6B7280]">Total</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {(editMode ? editItems : detailCN.items).reduce((s, i) => s + i.quantity, 0)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {(editMode ? editItems : detailCN.items).reduce((s, i) => s + i.itemM3 * i.quantity, 0).toFixed(2)}
                        </td>
                        <td></td>
                        {editMode && <td></td>}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              {/* Tracking Timeline + Remarks hidden in edit mode (DO does
                  the same with its tracking block). Operator focuses on
                  the form when editing. */}
              {!editMode && (<>
              {/* Tracking Timeline — 4 steps (DO has 3; CN's extra step is
                  Acknowledged, the branch-receipt confirmation that DO
                  doesn't have because DOs flow into invoices instead).
                  Step coloring: green = done, slate = active/in-progress,
                  gray = waiting. Mirrors DO's identical color scheme. */}
              <div className="border-t border-[#E2DDD8] pt-4">
                <h3 className="text-sm font-semibold text-[#1F1D1B] mb-3">Tracking</h3>
                <div className="space-y-3">
                  {/* Step 1: Dispatched. Done when dispatchDate is set
                      (status moved past PENDING). */}
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${
                        detailCN.dispatchDate ? "bg-[#4F7C3A]" : "bg-gray-300"
                      }`}
                    >
                      1
                    </div>
                    <div>
                      <p className="text-sm font-medium">Dispatched</p>
                      <p className="text-xs text-[#9CA3AF]">
                        {detailCN.dispatchDate
                          ? formatDate(detailCN.dispatchDate)
                          : "Pending dispatch"}
                      </p>
                    </div>
                  </div>
                  <div className="ml-4 border-l-2 border-[#E2DDD8] h-4" />
                  {/* Step 2: In Transit. Done (green) once deliveredDate is set
                      OR inTransitAt is stamped on a row that already moved
                      past — slate (in-progress) when status === IN_TRANSIT
                      and not yet delivered — gray (waiting) otherwise.
                      Date label pulls from the actual `inTransitAt`
                      timestamp (migration 0078) rather than a synthetic
                      "Currently in transit" placeholder so the operator
                      sees the precise stamp. Falls back to "Currently in
                      transit" when status === IN_TRANSIT but inTransitAt
                      is null (defensive: shouldn't happen post-0078). */}
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${
                        detailCN.deliveredDate
                          ? "bg-[#4F7C3A]"
                          : detailCN.status === "IN_TRANSIT"
                          ? "bg-[#3E6570]"
                          : detailCN.inTransitAt
                          ? "bg-[#4F7C3A]"
                          : "bg-gray-300"
                      }`}
                    >
                      2
                    </div>
                    <div>
                      <p className="text-sm font-medium">In Transit</p>
                      <p className="text-xs text-[#9CA3AF]">
                        {detailCN.inTransitAt
                          ? formatDate(detailCN.inTransitAt)
                          : detailCN.status === "IN_TRANSIT"
                          ? "Currently in transit"
                          : detailCN.deliveredDate
                          ? "Completed"
                          : "Awaiting in-transit"}
                      </p>
                    </div>
                  </div>
                  <div className="ml-4 border-l-2 border-[#E2DDD8] h-4" />
                  {/* Step 3: Delivered. Done when deliveredDate is set
                      (status === DELIVERED or ACKNOWLEDGED). */}
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${
                        detailCN.deliveredDate ? "bg-[#4F7C3A]" : "bg-gray-300"
                      }`}
                    >
                      3
                    </div>
                    <div>
                      <p className="text-sm font-medium">Delivered</p>
                      <p className="text-xs text-[#9CA3AF]">
                        {detailCN.deliveredDate
                          ? formatDate(detailCN.deliveredDate)
                          : "Awaiting delivery"}
                      </p>
                    </div>
                  </div>
                  <div className="ml-4 border-l-2 border-[#E2DDD8] h-4" />
                  {/* Step 4: Acknowledged — CN-only step. Done when status
                      === ACKNOWLEDGED (backend CLOSED). DO doesn't have
                      this step (DO's terminal state is INVOICED, which
                      DO renders as a 4th step on its own side). */}
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${
                        detailCN.status === "ACKNOWLEDGED" ? "bg-[#6B4A6D]" : "bg-gray-300"
                      }`}
                    >
                      4
                    </div>
                    <div>
                      <p className="text-sm font-medium">Acknowledged</p>
                      <p className="text-xs text-[#9CA3AF]">
                        {detailCN.status === "ACKNOWLEDGED"
                          ? "Branch confirmed receipt"
                          : "Awaiting branch acknowledgement"}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {detailCN.remarks && (
                <div className="border-t border-[#E2DDD8] pt-4">
                  <h3 className="text-sm font-semibold text-[#1F1D1B] mb-2">Remarks</h3>
                  <p className="text-xs text-[#6B7280]">{detailCN.remarks}</p>
                </div>
              )}
              </>)}
            </div>

            {/* Footer Actions — status-conditional, mirrors DO's pattern.
                PENDING:       Edit + Mark Dispatched + Close
                DISPATCHED/IT: Mark Delivered + Close
                DELIVERED:     Mark Acknowledged + Convert to Sales Invoice + Close
                ACKNOWLEDGED:  Close only
                Note: "Transfer to Return" is intentionally dropped from
                here per the task brief — it's a context-menu item on the
                list, not a Detail-dialog footer button (DO doesn't put
                returns in its detail footer either). */}
            <div className="sticky bottom-0 bg-white border-t border-[#E2DDD8] px-6 py-4 flex items-center justify-end gap-2 rounded-b-xl">
              {editMode ? (
                <>
                  <Button variant="outline" onClick={cancelEditMode} disabled={editSaving}>Cancel</Button>
                  <Button
                    variant="primary"
                    onClick={saveEditCN}
                    disabled={editSaving || editItems.length === 0}
                  >
                    {editSaving ? (
                      <><RefreshCw className="h-4 w-4 animate-spin" /> Saving...</>
                    ) : (
                      <><Save className="h-4 w-4" /> Save Changes</>
                    )}
                  </Button>
                </>
              ) : (
                <>
                  {detailCN.status === "PENDING" && (
                    <>
                      <Button
                        variant="outline"
                        onClick={() => enterEditMode(detailCN)}
                      >
                        <Pencil className="h-4 w-4" /> Edit
                      </Button>
                      <Button
                        variant="primary"
                        onClick={() => {
                          // Open the Mark Dispatched dialog (3PL transport
                          // picker) with pre-fill from the CN row's
                          // persisted Provider/Vehicle/Driver. Same flow
                          // the context menu's Mark Dispatched item
                          // triggers — both go through openDispatchDialog
                          // so a CN created with transport already picked
                          // doesn't lose those values when the operator
                          // confirms dispatch.
                          const row = detailCN;
                          setDetailCN(null);
                          openDispatchDialog(row);
                        }}
                      >
                        <Send className="h-4 w-4" /> Mark Dispatched
                      </Button>
                    </>
                  )}
                  {/* DISPATCHED: operator picks either Mark In Transit (next
                      step) or Mark Delivered (skip the middle step). Mirrors
                      the context-menu where both actions are gated on
                      DISPATCHED — the footer surfaces the same choice for
                      single-click access without opening the menu. The
                      Mark In Transit button is hidden once status is
                      already IN_TRANSIT to avoid no-op re-clicks; Mark
                      Delivered stays visible on both states. */}
                  {detailCN.status === "DISPATCHED" && (
                    <Button
                      variant="outline"
                      onClick={async () => {
                        // PATCH-by-id, status → IN_TRANSIT. Backend flips
                        // the row + stamps inTransitAt automatically (see
                        // updateConsignmentNoteById in
                        // consignment-note-shared.ts).
                        try {
                          const res = await fetch("/api/consignment-notes", {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ id: detailCN.id, status: "IN_TRANSIT" }),
                          });
                          if (!res.ok) {
                            toast.error("Failed to mark in transit");
                          } else {
                            toast.success(`${detailCN.cnNo} marked in transit`);
                            setDetailCN(null);
                            fetchData();
                          }
                        } catch {
                          toast.error("Failed to mark in transit");
                        }
                      }}
                    >
                      <Truck className="h-4 w-4" /> Mark In Transit
                    </Button>
                  )}
                  {(detailCN.status === "DISPATCHED" || detailCN.status === "IN_TRANSIT") && (
                    <Button
                      variant="primary"
                      onClick={async () => {
                        // PATCH-by-id (the same shape the context menu's
                        // "Mark Delivered" uses). Backend flips status →
                        // FULLY_SOLD and stamps deliveredAt automatically.
                        // Accepts both DISPATCHED and IN_TRANSIT as the
                        // `from` state — operators can skip the middle
                        // step or take it; the backend stamps deliveredAt
                        // either way.
                        try {
                          const res = await fetch("/api/consignment-notes", {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ id: detailCN.id, status: "FULLY_SOLD" }),
                          });
                          if (!res.ok) {
                            toast.error("Failed to mark delivered");
                          } else {
                            toast.success(`${detailCN.cnNo} marked delivered`);
                            setDetailCN(null);
                            fetchData();
                          }
                        } catch {
                          toast.error("Failed to mark delivered");
                        }
                      }}
                    >
                      <CheckCircle2 className="h-4 w-4" /> Mark Delivered
                    </Button>
                  )}
                  {detailCN.status === "DELIVERED" && (
                    <>
                      <Button
                        variant="outline"
                        onClick={async () => {
                          // PATCH-by-id, status → CLOSED. Backend stamps
                          // acknowledgedAt automatically.
                          try {
                            const res = await fetch("/api/consignment-notes", {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ id: detailCN.id, status: "CLOSED" }),
                            });
                            if (!res.ok) {
                              toast.error("Failed to mark acknowledged");
                            } else {
                              toast.success(`${detailCN.cnNo} acknowledged`);
                              setDetailCN(null);
                              fetchData();
                            }
                          } catch {
                            toast.error("Failed to mark acknowledged");
                          }
                        }}
                      >
                        <PackageCheck className="h-4 w-4" /> Mark Acknowledged
                      </Button>
                      <Button
                        variant="primary"
                        onClick={() => {
                          // Convert to Sales Invoice — opens the existing
                          // transferSI dialog. Same flow the context menu's
                          // "Transfer to Sales Invoice" uses.
                          const row = detailCN;
                          setDetailCN(null);
                          setTransferSIRow(row);
                        }}
                      >
                        <ReceiptText className="h-4 w-4" /> Convert to Sales Invoice
                      </Button>
                    </>
                  )}
                  <Button variant="outline" onClick={() => setDetailCN(null)}>
                    Close
                  </Button>
                </>
              )}
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
            onClick={() => {
              if (dispatchSaving) return;
              setDispatchDialog(null);
              pendingDispatchDriverNameRef.current = "";
            }}
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
                onClick={() => {
                  if (dispatchSaving) return;
                  setDispatchDialog(null);
                  pendingDispatchDriverNameRef.current = "";
                }}
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
                onClick={() => {
                  setDispatchDialog(null);
                  pendingDispatchDriverNameRef.current = "";
                }}
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
