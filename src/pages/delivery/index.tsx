import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useUrlState, useUrlStateNumber } from "@/lib/use-url-state";
import { useSessionState } from "@/lib/use-session-state";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { cn, formatDate } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import {
  Truck,
  Package,
  PackageCheck,
  Send,
  CheckCircle2,
  FileText,
  Eye,
  Printer,
  ReceiptText,
  RefreshCw,
  Plus,
  Search,
  Pencil,
  Trash2,
  X,
  Users,
  Save,
} from "lucide-react";
import type { DeliveryOrder, ProofOfDelivery, ThreePLProvider, Customer } from "@/lib/mock-data";
import PODDialog from "@/components/delivery/POD-dialog";
import PrintDO from "@/components/delivery/print-do";
import type { PrintDOData, PrintMode } from "@/components/delivery/print-do";
import { fetchJson, FetchJsonError } from "@/lib/fetch-json";
import { mutationWithData, MutationResultSchema } from "@/lib/schemas/common";
import { DeliveryOrderSchema } from "@/lib/schemas/delivery-order";
import { SalesOrderSchema } from "@/lib/schemas/sales-order";
import { InvoiceSchema } from "@/lib/schemas/invoice";

const DOMutationSchema = mutationWithData(DeliveryOrderSchema);
const SOMutationSchema = mutationWithData(SalesOrderSchema);
const InvoiceMutationSchema = mutationWithData(InvoiceSchema);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Status enum mirrors the backend's VALID_TRANSITIONS exactly
// (src/api/routes/delivery-orders.ts:25-30). The vestigial "PENDING"
// and "DISPATCHED" labels were dropped 2026-04-26 — backend never had
// either: PENDING was unreachable code, and "DISPATCHED" was a UI alias
// for "LOADED" that drifted into a separate type member, masking the
// missing LOADED → IN_TRANSIT button. Display label "Dispatched" still
// renders for LOADED rows via STATUS_LABEL — code stays "LOADED".
type DOStatus = "DRAFT" | "LOADED" | "IN_TRANSIT" | "DELIVERED" | "INVOICED";

type DOItem = {
  id: string;
  productionOrderId: string;
  salesOrderNo: string;
  poNo: string;
  productCode: string;
  productName: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  itemM3: number;
  rackingNumber: string;
};

type DeliveryOrderRow = {
  id: string;           // DO id (for API calls + row key)
  doNo: string;
  companySO: string;
  customerPOId: string;
  salesOrderId: string;
  customerId: string;
  customerName: string;
  hubBranch: string;    // customerState (legacy fallback — kept for old DOs that have customerState set but no hubId)
  hubState: string;     // delivery_hubs.state resolved via hubId on the API; preferred display in the State column when present
  itemCount: number;    // number of items in this DO
  totalM3: number;
  items: DOItem[];      // all items for detail view
  dispatchDate: string | null;
  receivedDate: string | null;
  status: DOStatus;
  // Provider (company) — driverId historically holds the COMPANY id
  // (legacy column name; see migration 0014). driverName denormalizes
  // either the picked PERSON's name or the company name (legacy DOs).
  driverId: string;
  driverName: string;
  driverContactPerson: string;
  driverPhone: string;
  // Vehicle picked from three_pl_vehicles (added by 3PL refactor 2026-04-27).
  vehicleId: string;
  vehicleNo: string;
  vehicleType: string;
  lorryName: string;
  deliveryAddress: string;
  contactPerson: string;
  contactPhone: string;
  deliveryDate: string;
  remarks: string;
};

// ---------------------------------------------------------------------------
// Map real DeliveryOrder from API to one row per DO
// ---------------------------------------------------------------------------

function mapDOToRow(d: DeliveryOrder): DeliveryOrderRow {
  // Status passes through unchanged. The previous code aliased backend
  // "LOADED" → frontend "DISPATCHED" which decoupled the type from
  // VALID_TRANSITIONS and made it impossible to wire the LOADED →
  // IN_TRANSIT button (you'd need to map back at PUT time). Now the
  // wire-shape and UI-shape are the same string; only the rendered
  // label differs (see STATUS_LABEL.LOADED = "Dispatched").
  const status = d.status as DOStatus;

  const items: DOItem[] = (d.items || []).map((i) => ({
    id: i.id,
    productionOrderId: i.productionOrderId || "",
    salesOrderNo: (i as Record<string, unknown>).salesOrderNo as string || d.companySO || "",
    poNo: i.poNo || "",
    productCode: i.productCode || "",
    productName: i.productName || "",
    sizeLabel: i.sizeLabel || "",
    fabricCode: i.fabricCode || "",
    quantity: i.quantity || 0,
    itemM3: i.itemM3 || 0,
    rackingNumber: i.rackingNumber || "",
  }));

  return {
    id: d.id,
    doNo: d.doNo,
    companySO: d.companySO || "",
    customerPOId: d.customerPOId || "",
    salesOrderId: d.salesOrderId || "",
    customerId: d.customerId || "",
    customerName: d.customerName || "",
    hubBranch: d.customerState || "",
    hubState: ((d as Record<string, unknown>).hubState as string) || "",
    itemCount: items.length,
    totalM3: d.totalM3 ?? 0,
    items,
    dispatchDate: d.dispatchedAt || null,
    receivedDate: d.deliveredAt || null,
    status,
    driverId: d.driverId || "",
    driverName: d.driverName || "",
    driverContactPerson: (d as Record<string, unknown>).driverContactPerson as string || "",
    driverPhone: (d as Record<string, unknown>).driverPhone as string || "",
    vehicleId: (d as Record<string, unknown>).vehicleId as string || "",
    vehicleNo: d.vehicleNo || "",
    vehicleType: (d as Record<string, unknown>).vehicleType as string || "",
    lorryName: d.lorryName || "",
    deliveryAddress: d.deliveryAddress || "",
    contactPerson: d.contactPerson || "",
    contactPhone: d.contactPhone || "",
    deliveryDate: d.deliveryDate || "",
    remarks: d.remarks || "",
  };
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<DOStatus, string> = {
  DRAFT: "Pending Dispatch",
  // LOADED is rendered as "Dispatched" because the operator-facing flow
  // calls "mark this DO out the warehouse door" the dispatch moment;
  // backend keeps it as LOADED to mirror the lifecycle name.
  LOADED: "Dispatched",
  IN_TRANSIT: "In Transit",
  DELIVERED: "Delivered",
  INVOICED: "Invoiced",
};

// All 6 delivery workflow tabs
const ALL_TABS = [
  { key: "planning", label: "Planning" },
  { key: "pending_delivery", label: "Pending Delivery" },
  { key: "pending_dispatch", label: "Pending Dispatch" },
  { key: "dispatched", label: "Dispatched" },
  { key: "delivered", label: "Delivered" },
  { key: "invoiced", label: "Invoice" },
] as const;

// Which DO statuses map to which tab (only for DO-based tabs).
// "dispatched" tab now includes IN_TRANSIT so the row stays visible while
// it's out for delivery — previously IN_TRANSIT was unreachable from the
// UI (no LOADED → IN_TRANSIT button) so this never mattered; now that
// the button exists, drivers can flip a DO to IN_TRANSIT and the row
// shouldn't disappear from the queue between dispatch and delivery.
const TAB_DO_STATUSES: Record<string, DOStatus[]> = {
  pending_dispatch: ["DRAFT"],
  dispatched: ["LOADED", "IN_TRANSIT"],
  delivered: ["DELIVERED"],
  invoiced: ["INVOICED"],
};

// PO-based tabs (show production orders, not delivery orders)
const PO_TABS = new Set(["planning", "pending_delivery"]);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Production order row (used for Planning + Pending Delivery tabs)
// ---------------------------------------------------------------------------
type ReadyPORow = {
  id: string;
  poNo: string;
  salesOrderId: string;
  salesOrderNo: string;
  customerId: string;
  customerName: string;
  customerState: string;
  productCode: string;
  productName: string;
  itemCategory: string;          // SOFA / BEDFRAME / ACCESSORY — drives the SO ID display rule
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  unitM3: number;                // per-unit volume from /api/products (Products page · Unit M³)
  completedDate: string | null;
  uphCompletedDate: string | null;
  rackingNumber: string;
  hookkaExpectedDD: string;
  currentDepartment: string;
  progress: number;
};

// Same rule as src/pages/sales/detail.tsx:39 and the production grid:
//   SOFA → poNo without -NN line suffix (one set spans variant POs)
//   BF/ACC → poNo as-is (each suffix = one physical piece)
function displaySoId(row: { poNo: string; itemCategory: string }): string {
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

export default function DeliveryPage() {
  const { toast } = useToast();
  // Top-level "Orders" / "3PL" tab — URL-synced so refresh and back/forward
  // both keep the user where they were.
  const [pageTab, setPageTab] = useUrlState<"orders" | "3pl">("section", "orders");
  const [deliveryOrders, setDeliveryOrders] = useState<DeliveryOrderRow[]>([]);
  const [planningPOs, setPlanningPOs] = useState<ReadyPORow[]>([]);
  const [readyPOs, setReadyPOs] = useState<ReadyPORow[]>([]);
  const [loading, setLoading] = useState(true);
  // Active inner tab — URL-synced for the same reason as pageTab above.
  const [activeTab, setActiveTab] = useUrlState<string>("tab", "planning");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detailDO, setDetailDO] = useState<DeliveryOrderRow | null>(null);
  // "manual" sentinel = Pending Dispatch's blank-DO entry point (Path A);
  // ReadyPORow[] = converting selected Pending Delivery POs (Path B). One
  // state keeps the dialog body unified so both paths share the same 3PL /
  // date / address / remarks block instead of duplicating markup.
  const [createDODialog, setCreateDODialog] = useState<ReadyPORow[] | "manual" | null>(null);
  // driverId here is the COMPANY id (legacy field name kept for the form
  // shape — wired to body.providerId on submit per the 3PL refactor). The
  // new vehicleId / driverPersonId carry the per-trip lorry + person ids.
  const [createDOForm, setCreateDOForm] = useState({
    driverId: "",
    vehicleId: "",
    driverPersonId: "",
    remarks: "",
    deliveryDate: "",
  });
  // Customer chosen in manual mode — drives default hub lookup. Empty in
  // convert mode (customer is derived from the selected POs there).
  const [manualCustomerId, setManualCustomerId] = useState<string>("");
  // Each drop point = one customer hub destination
  const [createDODrops, setCreateDODrops] = useState<{ customerId: string; customerName: string; hubId: string; address: string; contactName: string; contactPhone: string; poIds: string[] }[]>([]);
  const [printDialog, setPrintDialog] = useState<DeliveryOrderRow[] | null>(null);
  const [invoiceDialog, setInvoiceDialog] = useState<DeliveryOrderRow | null>(null);
  const [podDialog, setPodDialog] = useState<DeliveryOrderRow | null>(null);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [selectedReadyPOs, setSelectedReadyPOs] = useState<Set<string>>(new Set());
  const [creatingDOFromPO, setCreatingDOFromPO] = useState(false);
  const [dragDropIdx, setDragDropIdx] = useState<number | null>(null);

  // ----- Detail Edit mode -----
  const [editMode, setEditMode] = useState(false);
  // editForm.driverId = COMPANY id (kept name for backwards-compat with
  // existing edit handler). vehicleId + driverPersonId added by the 3PL
  // refactor for per-trip lorry + driver-person selection.
  const [editForm, setEditForm] = useState({
    driverId: "",
    vehicleId: "",
    driverPersonId: "",
    deliveryAddress: "",
    dropPoints: "1",
    remarks: "",
    contactPerson: "",
    contactPhone: "",
    deliveryDate: "",
  });
  const [editItems, setEditItems] = useState<DOItem[]>([]);
  const [editSaving, setEditSaving] = useState(false);
  const [addItemSearch, setAddItemSearch] = useState("");
  const [showAddItemPanel, setShowAddItemPanel] = useState(false);

  // ----- Print state -----
  const [printData, setPrintData] = useState<{ data: PrintDOData; mode: PrintMode } | null>(null);
  const printRef = useRef<HTMLDivElement>(null);

  // ----- 3PL Providers state -----
  // The provider form keeps only company-level fields after the 3PL refactor
  // (vehicle / rate fields moved to per-vehicle sub-table rows). vehicleNo
  // / vehicleType / capacityM3 / rate fields are still in the form state
  // for backwards-compat reads of legacy provider rows but are no longer
  // edited from the company top-form (they're shown / managed under the
  // Vehicles sub-table below).
  const [providers, setProviders] = useState<ThreePLProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerSearch, setProviderSearch] = useUrlState<string>("psearch", "");
  const [providerDialog, setProviderDialog] = useState<ThreePLProvider | null | "new">(null);
  const [providerForm, setProviderForm] = useState({
    name: "", phone: "", contactPerson: "", vehicleNo: "", vehicleType: "",
    capacityM3: "", ratePerTripRM: "", ratePerExtraDropRM: "", status: "ACTIVE" as ThreePLProvider["status"], remarks: "",
  });
  const [providerSaving, setProviderSaving] = useState(false);

  // ----- 3PL Vehicles + Drivers sub-tables (per-provider) -----
  // Loaded into the provider edit dialog when the dialog opens for an
  // existing provider; new-provider mode shows a placeholder until the
  // company row exists (vehicles/drivers FK to providerId).
  type ThreePLVehicle = {
    id: string;
    providerId: string;
    plateNo: string;
    vehicleType: string;
    capacityM3: number;
    ratePerTripSen: number;
    ratePerExtraDropSen: number;
    status: "ACTIVE" | "INACTIVE";
    remarks: string;
  };
  type ThreePLDriverPerson = {
    id: string;
    providerId: string;
    name: string;
    phone: string;
    status: "ACTIVE" | "INACTIVE";
    remarks: string;
  };
  const [providerVehicles, setProviderVehicles] = useState<ThreePLVehicle[]>([]);
  const [providerDrivers, setProviderDrivers] = useState<ThreePLDriverPerson[]>([]);
  const [vehicleEditing, setVehicleEditing] = useState<ThreePLVehicle | "new" | null>(null);
  const [vehicleForm, setVehicleForm] = useState({
    plateNo: "", vehicleType: "", capacityM3: "",
    ratePerTripRM: "", ratePerExtraDropRM: "", status: "ACTIVE" as "ACTIVE" | "INACTIVE", remarks: "",
  });
  const [driverEditing, setDriverEditing] = useState<ThreePLDriverPerson | "new" | null>(null);
  const [driverForm, setDriverForm] = useState({
    name: "", phone: "", status: "ACTIVE" as "ACTIVE" | "INACTIVE", remarks: "",
  });

  // ----- Vehicle + Driver pickers (DO Create / Edit dialogs) -----
  // Two separate caches scoped per-provider — one feeds the Create DO
  // dialog (key by createDOForm.driverId), the other the Edit dialog
  // (key by editForm.driverId). Loaded lazily when the host dialog
  // mounts and the provider id changes.
  const [createDialogVehicles, setCreateDialogVehicles] = useState<ThreePLVehicle[]>([]);
  const [createDialogDrivers, setCreateDialogDrivers] = useState<ThreePLDriverPerson[]>([]);
  const [editDialogVehicles, setEditDialogVehicles] = useState<ThreePLVehicle[]>([]);
  const [editDialogDrivers, setEditDialogDrivers] = useState<ThreePLDriverPerson[]>([]);
  // Edit-mode bug fix: delivery_orders only persists driverId (PROVIDER company)
  // + driverName (denormalized PERSON name) - the PERSON id is not in any
  // column. Re-deriving it on Edit means we have to wait for the provider's
  // three_pl_drivers list to load and match by name. This ref carries the
  // pending name across the async fetch so the useEffect that watches
  // editDialogDrivers can finish the resolve. Cleared when match found or
  // when the user closes the edit dialog.
  const pendingDriverNameToResolveRef = useRef<string>("");

  // ----- Customer hub lookup -----
  const [customersData, setCustomersData] = useState<Customer[]>([]);

  // ----- Inline Expected DD editing -----
  const [editingDDId, setEditingDDId] = useState<string | null>(null);
  const [editingDDValue, setEditingDDValue] = useState("");

  // ---------- Pagination (DO list only) ----------
  // Server-side pagination for the DO fetch; PO-based tabs (planning,
  // pending_delivery) and the other sibling fetches (POs, SOs, customers)
  // remain full-set and unaffected.
  // 200 — same rationale as sales/invoices: big enough that daily working
  // set fits on page 1 so search works normally.
  const PAGE_SIZE = 200;
  const [page, setPage] = useUrlStateNumber("page", 1);

  // ---------- Fetch ----------
  const { data: doRaw, loading: doLoading, refresh: refreshDOs } = useCachedJson<{
    success?: boolean;
    data?: DeliveryOrder[];
    page?: number;
    limit?: number;
    total?: number;
  }>(`/api/delivery-orders?page=${page}&limit=${PAGE_SIZE}`);
  // Whole-dataset status bucket counts — summary cards and tab badges read
  // from this so counts reflect the full table, not just the current
  // paginated page.
  const { data: doStatsRaw, refresh: refreshDOStats } = useCachedJson<{
    success?: boolean;
    byStatus?: Record<string, number>;
    total?: number;
  }>("/api/delivery-orders/stats");
  const totalDOsServer = doRaw?.total ?? (doRaw?.data?.length ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalDOsServer / PAGE_SIZE));

  // Reset to page 1 when the active tab changes.
  useEffect(() => {
    setPage(1);
    // setPage is stable (memoized inside useUrlStateNumber).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Scroll position restoration — keyed per active tab so each tab
  // remembers its own scroll position independently.
  const [savedScroll, setSavedScroll] = useSessionState<number>(
    `delivery:scrollY:${pageTab}:${activeTab}`,
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
  }, [pageTab, activeTab]);
  const { data: poRaw, loading: poLoading, refresh: refreshPOs } = useCachedJson<{ success?: boolean; data?: ProductionOrderApiShape[] }>("/api/production-orders");
  const { data: soRaw, loading: soLoading, refresh: refreshSOs } = useCachedJson<{ success?: boolean; data?: { id: string; hookkaExpectedDD?: string; companySOId?: string; customerId?: string }[] }>("/api/sales-orders");
  const { data: custRaw, loading: custLoading, refresh: refreshCustomers } = useCachedJson<{ success?: boolean; data?: Customer[] }>("/api/customers");
  // Pull product master data so each Planning / Pending Delivery row can
  // surface its per-unit m³ next to the qty. Source-of-truth is the
  // Products page (`unitM3` column) — fetching the same /api/products
  // payload here keeps the value in lockstep with whatever the user last
  // edited there.
  const { data: prodRaw, loading: prodLoading, refresh: refreshProducts } =
    useCachedJson<{ success?: boolean; data?: { code: string; unitM3: number }[] }>("/api/products");

  const fetchData = useCallback(() => {
    invalidateCachePrefix("/api/delivery-orders");
    invalidateCachePrefix("/api/production-orders");
    invalidateCachePrefix("/api/sales-orders");
    invalidateCachePrefix("/api/customers");
    invalidateCachePrefix("/api/products");
    refreshDOs();
    refreshDOStats();
    refreshPOs();
    refreshSOs();
    refreshCustomers();
    refreshProducts();
  }, [refreshDOs, refreshDOStats, refreshPOs, refreshSOs, refreshCustomers, refreshProducts]);

  // Lookup map from productCode → unitM3, rebuilt whenever /api/products
  // resolves. Used by mapPO to stamp each Planning row with its product's
  // unit volume.
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

  /* eslint-disable react-hooks/set-state-in-effect -- mirror SWR data into mutable local state for optimistic UI */
  useEffect(() => {
    const anyLoading = doLoading || poLoading || soLoading || custLoading || prodLoading;
    setLoading(anyLoading);
    const dRes = doRaw || { success: false };
    const poRes = poRaw || { success: false };
    const soRes = soRaw || { success: false };
    const custRes = custRaw || { success: false };
    {
      {
        // Store customers for hub address lookup
        if (custRes.success && Array.isArray(custRes.data)) {
          setCustomersData(custRes.data as Customer[]);
        }
        if (dRes.success && dRes.data) {
          const realRows = (dRes.data as DeliveryOrder[])
            .filter((d) => !d.id.startsWith("virt-"))
            .map(mapDOToRow);
          setDeliveryOrders(realRows);
        }

        if (poRes.success && Array.isArray(poRes.data)) {
          // Build SO lookup for hookkaExpectedDD + customerId
          const soMap = new Map<string, { hookkaExpectedDD: string; companySOId: string; customerId: string }>();
          if (soRes.success && Array.isArray(soRes.data)) {
            for (const so of soRes.data as { id: string; hookkaExpectedDD?: string; companySOId?: string; customerId?: string }[]) {
              soMap.set(so.id, {
                hookkaExpectedDD: so.hookkaExpectedDD || "",
                companySOId: so.companySOId || "",
                customerId: so.customerId || "",
              });
            }
          }

          // Build the set of PO IDs already on a non-cancelled DO so the
          // "Production Complete — Ready for DO" list excludes them
          // (BUG-2026-04-27: previous SO-level dedup wrongly kept POs
          // visible whose SO's OTHER POs were on a multi-SO DO — the DO
          // stores only one representative salesOrderId, so SO-level
          // matching missed siblings carried via the items array).
          const linkedPOIds = new Set<string>();
          if (dRes.success && Array.isArray(dRes.data)) {
            for (const d of dRes.data as DeliveryOrder[]) {
              if (d.status === "CANCELLED" || d.id.startsWith("virt-")) continue;
              for (const it of d.items || []) {
                if (it.productionOrderId) linkedPOIds.add(it.productionOrderId);
              }
            }
          }

          const allPOs = poRes.data as ProductionOrderApiShape[];

          const mapPO = (po: ProductionOrderApiShape): ReadyPORow => {
            const soInfo = soMap.get(po.salesOrderId || "");
            return {
              id: po.id,
              poNo: po.poNo,
              salesOrderId: po.salesOrderId || "",
              salesOrderNo: po.companySOId || soInfo?.companySOId || po.salesOrderNo || "",
              customerId: po.customerId || soInfo?.customerId || "",
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
                const uphCards = (po.jobCards || []).filter(j => j.departmentCode === "UPHOLSTERY");
                if (uphCards.length === 0) return null;
                // Find the latest completion date among upholstery cards
                const dates = uphCards.map(j => j.completedDate).filter((d): d is string => !!d);
                return dates.length > 0 ? dates.sort().reverse()[0] : null;
              })(),
              rackingNumber: po.rackingNumber || "",
              hookkaExpectedDD: soInfo?.hookkaExpectedDD || po.targetEndDate || "",
              currentDepartment: po.currentDepartment || "",
              progress: po.progress || 0,
            };
          };

          // Planning: POs still in production (upholstery not yet complete)
          const planning = allPOs
            .filter((po) => {
              if (po.status === "COMPLETED" || po.status === "CANCELLED") return false;
              // Must have upholstery cards
              const uphCards = (po.jobCards || []).filter((j) => j.departmentCode === "UPHOLSTERY");
              if (uphCards.length === 0) return false;
              // At least one upholstery card not yet done
              return uphCards.some((j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED");
            })
            .map(mapPO);
          setPlanningPOs(planning);

          // Pending Delivery: production complete, not yet on a real DO
          const ready = allPOs
            .filter((po) => {
              if (po.status === "CANCELLED") return false;
              // Check that upholstery cards exist and ALL are done
              const uphCards = (po.jobCards || []).filter((j) => j.departmentCode === "UPHOLSTERY");
              if (uphCards.length === 0) return false;
              return uphCards.every((j) => j.status === "COMPLETED" || j.status === "TRANSFERRED");
            })
            .filter((po) => !linkedPOIds.has(po.id))
            .map(mapPO);
          setReadyPOs(ready);
        }
      }
    }
  }, [doRaw, poRaw, soRaw, custRaw, doLoading, poLoading, soLoading, custLoading]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ----- 3PL Provider helpers -----
  const { data: providersRaw, loading: providersFetching, refresh: refreshProvidersHook } = useCachedJson<{ success?: boolean; data?: ThreePLProvider[] }>("/api/drivers");

  const fetchProviders = useCallback(() => {
    invalidateCachePrefix("/api/drivers");
    refreshProvidersHook();
  }, [refreshProvidersHook]);

  /* eslint-disable react-hooks/set-state-in-effect -- mirror SWR providers data into local state */
  useEffect(() => {
    setProvidersLoading(providersFetching);
    if (providersRaw && providersRaw.success && Array.isArray(providersRaw.data)) {
      setProviders(providersRaw.data);
    }
  }, [providersRaw, providersFetching]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const filteredProviders = useMemo(() => {
    if (!providerSearch) return providers;
    const q = providerSearch.toLowerCase();
    return providers.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.phone.toLowerCase().includes(q) ||
        (p.contactPerson || "").toLowerCase().includes(q) ||
        (p.vehicleNo || "").toLowerCase().includes(q),
    );
  }, [providers, providerSearch]);

  const openProviderDialog = (p: ThreePLProvider | "new") => {
    if (p === "new") {
      setProviderForm({
        name: "", phone: "", contactPerson: "", vehicleNo: "", vehicleType: "",
        capacityM3: "", ratePerTripRM: "", ratePerExtraDropRM: "", status: "ACTIVE", remarks: "",
      });
    } else {
      setProviderForm({
        name: p.name,
        phone: p.phone,
        contactPerson: p.contactPerson || "",
        vehicleNo: p.vehicleNo || "",
        vehicleType: p.vehicleType || "",
        capacityM3: String(p.capacityM3 || ""),
        ratePerTripRM: String((p.ratePerTripSen || 0) / 100),
        ratePerExtraDropRM: String((p.ratePerExtraDropSen || 0) / 100),
        status: p.status,
        remarks: p.remarks || "",
      });
    }
    setProviderDialog(p);
  };

  const saveProvider = async () => {
    // Guard against silent data loss: the inline Vehicle / Driver forms
    // POST immediately on their own Save button. The footer Save here
    // only persists company-level fields. If the user typed real data
    // into either inline form (plate_no / driver name — the required
    // fields) but didn't click that form's own Save, surface the model
    // instead of dropping their work. Empty required field = "form is
    // open but no real input yet", so don't block.
    if (vehicleEditing !== null && vehicleForm.plateNo.trim()) {
      toast.error(
        "You have an unsaved Vehicle form. Click 'Save Vehicle' inside the Vehicles section first, or Cancel that form before saving.",
      );
      return;
    }
    if (driverEditing !== null && driverForm.name.trim()) {
      toast.error(
        "You have an unsaved Driver form. Click 'Save Driver' inside the Drivers section first, or Cancel that form before saving.",
      );
      return;
    }
    setProviderSaving(true);
    // Post-3PL refactor: only send the company-level fields. vehicle /
    // rate / capacity now live on three_pl_vehicles rows; omitting them
    // here lets the backend preserve any legacy values on update without
    // the form silently zeroing them.
    const payload = {
      name: providerForm.name,
      phone: providerForm.phone,
      contactPerson: providerForm.contactPerson,
      status: providerForm.status,
      remarks: providerForm.remarks,
    };
    try {
      const isEdit = providerDialog !== "new" && providerDialog !== null;
      const url = isEdit ? `/api/drivers/${(providerDialog as ThreePLProvider).id}` : "/api/drivers";
      const method = isEdit ? "PUT" : "POST";
      const data = await fetchJson(url, MutationResultSchema, {
        method,
        body: payload,
      });
      if (data.success) {
        setProviderDialog(null);
        fetchProviders();
      } else {
        toast.error(data.error || "Failed to save");
      }
    } catch (e) {
      if (e instanceof FetchJsonError) {
        toast.error((e.body as { error?: string } | undefined)?.error || e.message);
      } else {
        toast.error("Failed to save provider");
      }
    }
    setProviderSaving(false);
  };

  const deleteProvider = async (id: string) => {
    if (!confirm("Delete this 3PL provider?")) return;
    try {
      const res = await fetch(`/api/drivers/${id}`, { method: "DELETE" });
      if (!res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await res.json().catch(() => ({}));
        toast.error(body?.error || `Failed to delete (HTTP ${res.status})`);
        return;
      }
      fetchProviders();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error — 3PL not deleted");
    }
  };

  // ---- Vehicles + Drivers sub-table helpers (3PL refactor) ----
  // The provider edit dialog opens in either "new" mode (no providerId yet,
  // sub-tables disabled) or for an existing ThreePLProvider. When editing
  // existing, fetch the per-provider rows once on dialog open and refetch
  // after each mutation so the table reflects the live state.
  const currentProviderId =
    providerDialog && providerDialog !== "new"
      ? (providerDialog as ThreePLProvider).id
      : null;

  const fetchProviderVehicles = useCallback(async (providerId: string) => {
    try {
      const res = await fetch(`/api/three-pl-vehicles?providerId=${providerId}`);
      const body = (await res.json()) as { success?: boolean; data?: ThreePLVehicle[] };
      if (body?.success && Array.isArray(body.data)) {
        setProviderVehicles(body.data);
      }
    } catch {
      /* swallow — UI shows empty list, retry on next dialog open */
    }
  }, []);

  const fetchProviderDrivers = useCallback(async (providerId: string) => {
    try {
      const res = await fetch(`/api/three-pl-drivers?providerId=${providerId}`);
      const body = (await res.json()) as { success?: boolean; data?: ThreePLDriverPerson[] };
      if (body?.success && Array.isArray(body.data)) {
        setProviderDrivers(body.data);
      }
    } catch {
      /* swallow */
    }
  }, []);

  // Refetch sub-tables whenever the dialog target changes. fetchProvider*
  // call setState internally — that's intentional (they're async fetches
  // synchronizing with an external source), so the lint rule about
  // setState-in-effect is suppressed for this body.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (currentProviderId) {
      fetchProviderVehicles(currentProviderId);
      fetchProviderDrivers(currentProviderId);
    } else {
      setProviderVehicles([]);
      setProviderDrivers([]);
    }
    // Also reset any in-progress vehicle/driver inline editor when the
    // host provider dialog opens/closes/changes.
    setVehicleEditing(null);
    setDriverEditing(null);
  }, [currentProviderId, fetchProviderVehicles, fetchProviderDrivers]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Fetch vehicle + driver lists for the Create / Edit DO dialogs whenever
  // the chosen provider changes. Empty provider clears the lists.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const pid = createDOForm.driverId;
    if (!pid) {
      setCreateDialogVehicles([]);
      setCreateDialogDrivers([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      fetch(`/api/three-pl-vehicles?providerId=${pid}`).then(
        (r) => r.json() as Promise<{ success?: boolean; data?: ThreePLVehicle[] }>,
      ),
      fetch(`/api/three-pl-drivers?providerId=${pid}`).then(
        (r) => r.json() as Promise<{ success?: boolean; data?: ThreePLDriverPerson[] }>,
      ),
    ])
      .then(([vRes, dRes]) => {
        if (cancelled) return;
        if (vRes?.success && Array.isArray(vRes.data)) setCreateDialogVehicles(vRes.data);
        if (dRes?.success && Array.isArray(dRes.data)) setCreateDialogDrivers(dRes.data);
      })
      .catch(() => {
        /* swallow */
      });
    return () => {
      cancelled = true;
    };
  }, [createDOForm.driverId]);

  useEffect(() => {
    const pid = editForm.driverId;
    if (!pid) {
      setEditDialogVehicles([]);
      setEditDialogDrivers([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      fetch(`/api/three-pl-vehicles?providerId=${pid}`).then(
        (r) => r.json() as Promise<{ success?: boolean; data?: ThreePLVehicle[] }>,
      ),
      fetch(`/api/three-pl-drivers?providerId=${pid}`).then(
        (r) => r.json() as Promise<{ success?: boolean; data?: ThreePLDriverPerson[] }>,
      ),
    ])
      .then(([vRes, dRes]) => {
        if (cancelled) return;
        if (vRes?.success && Array.isArray(vRes.data)) setEditDialogVehicles(vRes.data);
        if (dRes?.success && Array.isArray(dRes.data)) {
          setEditDialogDrivers(dRes.data);
          // Resolve PERSON id by name match on Edit. Bug fix 2026-04-28:
          // delivery_orders only persists the PERSON's name (denormalized
          // into driverName). Without this, the Edit dialog's Driver
          // dropdown opened blank even when the DO had a saved person.
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
            // One-shot - clear so a stale name doesn't bleed into the next
            // edit session if the user opens Edit on a different DO.
            pendingDriverNameToResolveRef.current = "";
          }
        }
      })
      .catch(() => {
        /* swallow */
      });
    return () => {
      cancelled = true;
    };
  }, [editForm.driverId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const openVehicleForm = (v: ThreePLVehicle | "new") => {
    if (v === "new") {
      setVehicleForm({
        plateNo: "", vehicleType: "", capacityM3: "",
        ratePerTripRM: "", ratePerExtraDropRM: "", status: "ACTIVE", remarks: "",
      });
    } else {
      setVehicleForm({
        plateNo: v.plateNo,
        vehicleType: v.vehicleType || "",
        capacityM3: String(v.capacityM3 || ""),
        ratePerTripRM: String((v.ratePerTripSen || 0) / 100),
        ratePerExtraDropRM: String((v.ratePerExtraDropSen || 0) / 100),
        status: v.status,
        remarks: v.remarks || "",
      });
    }
    setVehicleEditing(v);
  };

  const saveVehicle = async () => {
    if (!currentProviderId) return;
    if (!vehicleForm.plateNo.trim()) {
      toast.error("Plate number is required");
      return;
    }
    const payload = {
      providerId: currentProviderId,
      plateNo: vehicleForm.plateNo.trim(),
      vehicleType: vehicleForm.vehicleType.trim(),
      capacityM3: Number(vehicleForm.capacityM3) || 0,
      ratePerTripSen: Math.round((Number(vehicleForm.ratePerTripRM) || 0) * 100),
      ratePerExtraDropSen: Math.round((Number(vehicleForm.ratePerExtraDropRM) || 0) * 100),
      status: vehicleForm.status,
      remarks: vehicleForm.remarks,
    };
    const isEdit = vehicleEditing !== "new" && vehicleEditing !== null;
    const url = isEdit
      ? `/api/three-pl-vehicles/${(vehicleEditing as ThreePLVehicle).id}`
      : "/api/three-pl-vehicles";
    const method = isEdit ? "PUT" : "POST";
    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !body?.success) {
        toast.error(body?.error || `Failed (HTTP ${res.status})`);
        return;
      }
      setVehicleEditing(null);
      fetchProviderVehicles(currentProviderId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error");
    }
  };

  const deleteVehicle = async (id: string) => {
    if (!confirm("Delete this vehicle?")) return;
    if (!currentProviderId) return;
    try {
      const res = await fetch(`/api/three-pl-vehicles/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body?.error || `Failed (HTTP ${res.status})`);
        return;
      }
      fetchProviderVehicles(currentProviderId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error");
    }
  };

  const openDriverForm = (d: ThreePLDriverPerson | "new") => {
    if (d === "new") {
      setDriverForm({ name: "", phone: "", status: "ACTIVE", remarks: "" });
    } else {
      setDriverForm({
        name: d.name,
        phone: d.phone || "",
        status: d.status,
        remarks: d.remarks || "",
      });
    }
    setDriverEditing(d);
  };

  const saveDriver = async () => {
    if (!currentProviderId) return;
    if (!driverForm.name.trim()) {
      toast.error("Driver name is required");
      return;
    }
    const payload = {
      providerId: currentProviderId,
      name: driverForm.name.trim(),
      phone: driverForm.phone.trim(),
      status: driverForm.status,
      remarks: driverForm.remarks,
    };
    const isEdit = driverEditing !== "new" && driverEditing !== null;
    const url = isEdit
      ? `/api/three-pl-drivers/${(driverEditing as ThreePLDriverPerson).id}`
      : "/api/three-pl-drivers";
    const method = isEdit ? "PUT" : "POST";
    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !body?.success) {
        toast.error(body?.error || `Failed (HTTP ${res.status})`);
        return;
      }
      setDriverEditing(null);
      fetchProviderDrivers(currentProviderId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error");
    }
  };

  const deleteDriverPerson = async (id: string) => {
    if (!confirm("Delete this driver?")) return;
    if (!currentProviderId) return;
    try {
      const res = await fetch(`/api/three-pl-drivers/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body?.error || `Failed (HTTP ${res.status})`);
        return;
      }
      fetchProviderDrivers(currentProviderId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error");
    }
  };

  // ---------- Filtered data (DO-based tabs only) ----------
  const filteredOrders = useMemo(() => {
    const statuses = TAB_DO_STATUSES[activeTab];
    if (!statuses) return []; // PO-based tab — no DO rows
    return deliveryOrders.filter((d) => statuses.includes(d.status));
  }, [deliveryOrders, activeTab]);

  // ---------- Summary counts (unique DOs, not rows) ----------
  // Read from /api/delivery-orders/stats so counts reflect the whole
  // dataset rather than just the current paginated page.
  const uniqueDOsByStatus = useMemo(() => {
    const byStatus = doStatsRaw?.byStatus ?? {};
    return {
      draft: byStatus.DRAFT ?? 0,
      // The "Dispatched" UI label maps to the LOADED DB status. The DO state
      // machine writes LOADED when a DRAFT is dispatched (see VALID_TRANSITIONS
      // in src/api/routes/delivery-orders.ts) — there is no DISPATCHED
      // bucket on the server side. Reading byStatus.DISPATCHED would always
      // return 0 and the card would silently misreport the dashboard.
      dispatched: byStatus.LOADED ?? 0,
      inTransit: byStatus.IN_TRANSIT ?? 0,
      delivered: byStatus.DELIVERED ?? 0,
      invoiced: byStatus.INVOICED ?? 0,
    };
  }, [doStatsRaw]);
  const pendingDispatchCount = uniqueDOsByStatus.draft;
  const dispatchedCount = uniqueDOsByStatus.dispatched;
  const inTransitCount = uniqueDOsByStatus.inTransit;
  const deliveredMTD = useMemo(() => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const doIds = new Set(
      deliveryOrders
        .filter(
          (d) =>
            d.status === "DELIVERED" &&
            d.receivedDate &&
            new Date(d.receivedDate) >= startOfMonth
        )
        .map((d) => d.id)
    );
    return doIds.size;
  }, [deliveryOrders]);

  // ---------- Selection ----------
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredOrders.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredOrders.map((d) => d.id)));
    }
  };

  // ---------- Actions ----------
  const openCreateDODialog = (pos: ReadyPORow[]) => {
    // Group items by unique customer+state → each becomes a drop point
    const dropMap = new Map<string, { customerId: string; customerName: string; state: string; poIds: string[] }>();
    for (const po of pos) {
      const key = `${po.customerId}__${po.customerState}`;
      const existing = dropMap.get(key);
      if (existing) {
        existing.poIds.push(po.id);
      } else {
        dropMap.set(key, {
          customerId: po.customerId,
          customerName: po.customerName,
          state: po.customerState,
          poIds: [po.id],
        });
      }
    }

    // For each unique customer+state, auto-select the matching hub
    const drops = Array.from(dropMap.values()).map((d) => {
      const cust = customersData.find((c) => c.id === d.customerId);
      const hub = cust?.deliveryHubs.find((h) => h.state === d.state)
        || cust?.deliveryHubs.find((h) => h.isDefault)
        || cust?.deliveryHubs[0];
      return {
        customerId: d.customerId,
        customerName: d.customerName,
        hubId: hub?.id || "",
        address: hub?.address || "",
        contactName: hub?.contactName || "",
        contactPhone: hub?.phone || "",
        poIds: d.poIds,
      };
    });

    setCreateDODrops(drops);
    setCreateDOForm({ driverId: "", vehicleId: "", driverPersonId: "", remarks: "", deliveryDate: "" });
    setCreateDODialog(pos);
  };

  // Manual create — Pending Dispatch tab can spawn a blank DO that has no
  // PO items yet. Customer is required (drives default hub / address);
  // items get added afterwards from Edit mode's Add-Item panel. Distinct
  // from openCreateDODialog by the "manual" sentinel so the same dialog
  // body can render either flow without duplicating markup.
  const openManualCreateDODialog = () => {
    setCreateDODrops([]);
    setCreateDOForm({ driverId: "", vehicleId: "", driverPersonId: "", remarks: "", deliveryDate: "" });
    setManualCustomerId("");
    setCreateDODialog("manual");
  };

  const confirmCreateDO = async () => {
    if (!createDODialog) return;

    const isManual = createDODialog === "manual";

    // Per-mode body assembly. Manual mode posts customerId only (blank DO,
    // 0 items); convert mode posts productionOrderIds derived from the
    // live PO selection.
    let body: Record<string, unknown>;
    if (isManual) {
      if (!manualCustomerId) {
        toast.error("Please pick a customer");
        return;
      }
      const cust = customersData.find((c) => c.id === manualCustomerId);
      const hub =
        cust?.deliveryHubs.find((h) => h.isDefault) ?? cust?.deliveryHubs[0];
      body = {
        customerId: manualCustomerId,
        productionOrderIds: [],
        providerId: createDOForm.driverId || null,
        vehicleId: createDOForm.vehicleId || null,
        driverId: createDOForm.driverPersonId || null,
        deliveryAddress: hub?.address ?? "",
        contactPerson: hub?.contactName ?? "",
        contactPhone: hub?.phone ?? "",
        dropPoints: 1,
        remarks: createDOForm.remarks,
        deliveryDate: createDOForm.deliveryDate || "",
      };
    } else {
      // Derive poIds from the LIVE selection (not the dialog-open snapshot)
      // so any checkbox toggles the user did with the dialog still open are
      // honored. Without this the snapshot from openCreateDODialog could
      // include POs the user has since deselected — backend would then see
      // multi-customer/multi-state selections and reject (BUG-2026-04-27:
      // user reported "Selected production orders span multiple customers
      // or states" toast even though only 1 row showed as selected — the
      // dialog snapshot was stale).
      const poIds = readyPOs
        .filter((po) => selectedReadyPOs.has(po.id))
        .map((po) => po.id);
      if (poIds.length === 0) {
        setCreateDODialog(null);
        return;
      }
      const deliveryAddress =
        createDODrops.length === 1
          ? createDODrops[0].address
          : createDODrops
              .map((d, i) => `Drop ${i + 1} (${d.customerName}): ${d.address}`)
              .join("\n");
      body = {
        productionOrderIds: poIds,
        providerId: createDOForm.driverId || null,
        vehicleId: createDOForm.vehicleId || null,
        driverId: createDOForm.driverPersonId || null,
        deliveryAddress,
        dropPoints: createDODrops.length,
        remarks: createDOForm.remarks,
        deliveryDate: createDOForm.deliveryDate || "",
      };
    }

    setCreatingDOFromPO(true);
    try {
      const data = await fetchJson("/api/delivery-orders", DOMutationSchema, {
        method: "POST",
        body,
      });
      if (!data.success) {
        toast.error(data.error || "Failed to create delivery order");
      }
    } catch (e) {
      if (e instanceof FetchJsonError) {
        toast.error((e.body as { error?: string } | undefined)?.error || e.message);
      } else {
        toast.error("Failed to create delivery order");
      }
    }
    setCreatingDOFromPO(false);
    setCreateDODialog(null);
    setSelectedReadyPOs(new Set());
    fetchData();
  };

  const handlePrintPackingList = () => {
    if (selectedIds.size === 0) return;
    const selected = deliveryOrders.filter((d) => selectedIds.has(d.id));
    setPrintDialog(selected);
  };

  const handleMarkDispatched = async () => {
    if (selectedIds.size === 0) return;
    const doIds = deliveryOrders
      .filter((d) => selectedIds.has(d.id) && d.status === "DRAFT")
      .map((d) => d.id);
    if (doIds.length === 0) return;
    try {
      await Promise.all(
        doIds.map((id) =>
          fetch(`/api/delivery-orders/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "LOADED" }),
          })
        )
      );
    } catch {
      toast.error("Failed to mark dispatched");
    }
    setSelectedIds(new Set());
    fetchData();
  };

  const handleMarkDelivered = async () => {
    if (selectedIds.size === 0) return;
    const doIds = deliveryOrders
      .filter((d) => selectedIds.has(d.id) && (d.status === "LOADED" || d.status === "IN_TRANSIT"))
      .map((d) => d.id);
    if (doIds.length === 0) return;
    try {
      await Promise.all(
        doIds.map((doId) =>
          fetch(`/api/delivery-orders/${doId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "DELIVERED" }),
          })
        )
      );
    } catch {
      toast.error("Failed to mark delivered");
    }
    setSelectedIds(new Set());
    fetchData();
  };

  const handleGenerateInvoice = (doRow: DeliveryOrderRow) => {
    setInvoiceDialog(doRow);
  };

  const handleSubmitPOD = async (pod: ProofOfDelivery) => {
    if (!podDialog) return;
    try {
      const data = await fetchJson(`/api/delivery-orders/${podDialog.id}`, DOMutationSchema, {
        method: "PUT",
        body: { status: "DELIVERED", proofOfDelivery: pod },
      });
      if (data.success) {
        setPodDialog(null);
        fetchData();
      } else {
        toast.error(data.error || "Failed to mark delivered");
      }
    } catch (e) {
      if (e instanceof FetchJsonError) {
        toast.error((e.body as { error?: string } | undefined)?.error || e.message);
      } else {
        toast.error("Failed to mark delivered");
      }
    }
  };

  const confirmGenerateInvoice = async () => {
    if (!invoiceDialog) return;
    setInvoiceLoading(true);
    try {
      await fetchJson("/api/invoices", InvoiceMutationSchema, {
        method: "POST",
        body: {
          salesOrderId: invoiceDialog.salesOrderId,
          doNo: invoiceDialog.doNo,
          customerId: invoiceDialog.customerId,
          customerName: invoiceDialog.customerName,
        },
      });
      setDeliveryOrders((prev) =>
        prev.map((d) =>
          d.id === invoiceDialog.id && d.status === "DELIVERED"
            ? { ...d, status: "INVOICED" as DOStatus }
            : d
        )
      );
      if (detailDO?.id === invoiceDialog.id) {
        setDetailDO({ ...invoiceDialog, status: "INVOICED" });
      }
    } catch { /* ignore */ }
    setInvoiceLoading(false);
    setInvoiceDialog(null);
  };

  // ---------- Edit mode helpers ----------
  const enterEditMode = (row: DeliveryOrderRow) => {
    // Prefer the persisted driverId (company id, post-3PL-refactor) — fall
    // back to name-match for legacy DOs that pre-date the column being
    // populated reliably.
    const matchedProvider =
      providers.find((p) => p.id === row.driverId) ??
      providers.find((p) => p.name === row.driverName);
    // PERSON id is not stored on delivery_orders - we only persist the
    // PERSON name (driverName denormalize). Stash that name so the
    // editDialogDrivers fetch effect can resolve it back to a PERSON id
    // once the provider's drivers list loads.
    pendingDriverNameToResolveRef.current = row.driverName || "";
    setEditForm({
      driverId: matchedProvider?.id || "",
      vehicleId: row.vehicleId || "",
      driverPersonId: "",
      deliveryAddress: row.deliveryAddress || "",
      dropPoints: "1",
      remarks: row.remarks || "",
      contactPerson: row.contactPerson || "",
      contactPhone: row.contactPhone || "",
      deliveryDate: row.deliveryDate ? row.deliveryDate.split("T")[0] : "",
    });
    setEditItems([...row.items]);
    setEditMode(true);
    setShowAddItemPanel(false);
    setAddItemSearch("");
  };

  const cancelEditMode = () => {
    setEditMode(false);
    setShowAddItemPanel(false);
    setAddItemSearch("");
    pendingDriverNameToResolveRef.current = "";
  };

  const removeEditItem = (itemId: string) => {
    setEditItems((prev) => prev.filter((i) => i.id !== itemId));
  };

  const addReadyPOToEdit = (po: ReadyPORow) => {
    // Check if already in items
    if (editItems.some((i) => i.productionOrderId === po.id)) return;
    const newItem: DOItem = {
      // eslint-disable-next-line react-hooks/purity -- id generation; only invoked from a click handler, never during render
      id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      productionOrderId: po.id,
      salesOrderNo: po.salesOrderNo || "",
      poNo: po.poNo,
      productCode: po.productCode,
      productName: po.productName,
      sizeLabel: po.sizeLabel,
      fabricCode: po.fabricCode,
      quantity: po.quantity,
      // itemM3 = per-unit volume from /api/products (Product header is the
      // source of truth). 0 fallback when the product code isn't in the
      // map yet — was hardcoded 0.85 before, which caused the Pending
      // Dispatch grid's Total M³ to disagree with the per-PO Unit M³ on
      // Pending Delivery (user report 2026-04-27).
      itemM3: productM3Map.get(po.productCode) ?? 0,
      rackingNumber: "",
    };
    setEditItems((prev) => [...prev, newItem]);
  };

  // Available POs that can be added (not already in editItems)
  const addablePOs = useMemo(() => {
    if (!showAddItemPanel) return [];
    const existingPOIds = new Set(editItems.map((i) => i.productionOrderId));
    let filtered = readyPOs.filter((po) => !existingPOIds.has(po.id));
    if (addItemSearch) {
      const q = addItemSearch.toLowerCase();
      filtered = filtered.filter(
        (po) =>
          po.poNo.toLowerCase().includes(q) ||
          po.productCode.toLowerCase().includes(q) ||
          po.productName.toLowerCase().includes(q) ||
          po.customerName.toLowerCase().includes(q) ||
          po.salesOrderNo.toLowerCase().includes(q),
      );
    }
    return filtered;
  }, [showAddItemPanel, editItems, readyPOs, addItemSearch]);

  const saveEditDO = async () => {
    if (!detailDO) return;
    setEditSaving(true);
    try {
      // 3PL refactor: send providerId for the company plus the new
      // vehicleId / driverId (PERSON) pickers. Backend's denormalize
      // step fills in vehicleNo/vehicleType/driverName/driverPhone from
      // the picked vehicle + person rows; providerId mirrors into the
      // legacy driverId column on delivery_orders for backwards-compat.
      const data = await fetchJson(`/api/delivery-orders/${detailDO.id}`, DOMutationSchema, {
        method: "PUT",
        body: {
          providerId: editForm.driverId || null,
          vehicleId: editForm.vehicleId || null,
          driverId: editForm.driverPersonId || null,
          deliveryAddress: editForm.deliveryAddress,
          dropPoints: Number(editForm.dropPoints) || 1,
          remarks: editForm.remarks,
          contactPerson: editForm.contactPerson,
          contactPhone: editForm.contactPhone,
          deliveryDate: editForm.deliveryDate || "",
          items: editItems.map((i) => ({
            id: i.id,
            productionOrderId: i.productionOrderId,
            salesOrderNo: i.salesOrderNo,
            poNo: i.poNo,
            productCode: i.productCode,
            productName: i.productName,
            sizeLabel: i.sizeLabel,
            fabricCode: i.fabricCode,
            quantity: i.quantity,
            itemM3: i.itemM3,
            rackingNumber: i.rackingNumber,
            packingStatus: "PACKED",
          })),
        },
      });
      if (data.success && data.data) {
        setEditMode(false);
        setShowAddItemPanel(false);
        // Update detailDO with new data
        const updated = mapDOToRow(data.data as DeliveryOrder);
        setDetailDO(updated);
        fetchData();
      } else {
        toast.error(data.error || "Failed to save changes");
      }
    } catch (e) {
      if (e instanceof FetchJsonError) {
        toast.error((e.body as { error?: string } | undefined)?.error || e.message);
      } else {
        toast.error("Failed to save changes");
      }
    }
    setEditSaving(false);
  };

  // ---------- Print helpers ----------
  const triggerPrint = (row: DeliveryOrderRow, mode: PrintMode) => {
    const data: PrintDOData = {
      doNo: row.doNo,
      companySO: row.companySO,
      customerPOId: row.customerPOId,
      customerName: row.customerName,
      hubBranch: row.hubBranch,
      deliveryAddress: row.deliveryAddress,
      contactPerson: row.contactPerson,
      contactPhone: row.contactPhone,
      driverName: row.driverName,
      vehicleNo: row.vehicleNo,
      dispatchDate: row.dispatchDate,
      items: row.items.map((i) => ({
        id: i.id,
        salesOrderNo: i.salesOrderNo,
        poNo: i.poNo,
        productCode: i.productCode,
        productName: i.productName,
        sizeLabel: i.sizeLabel,
        fabricCode: i.fabricCode,
        quantity: i.quantity,
        itemM3: i.itemM3,
        rackingNumber: i.rackingNumber,
      })),
      totalM3: row.totalM3,
      remarks: row.remarks,
    };
    setPrintData({ data, mode });
    // Wait for render, then print. Runs from the Print-button event handler,
    // not a React effect — useTimeout would tie the firing to a render and
    // make the synchronous setPrintData(null) cleanup awkward.
    // eslint-disable-next-line no-restricted-syntax -- one-shot delay inside print-button event handler
    setTimeout(() => {
      window.print();
      setPrintData(null);
    }, 300);
  };

  // ---------- Expected DD inline update ----------
  const updateExpectedDD = useCallback(async (salesOrderId: string, newDate: string, rowId: string) => {
    if (!salesOrderId) return;
    try {
      const json = await fetchJson(`/api/sales-orders/${salesOrderId}`, SOMutationSchema, {
        method: "PUT",
        body: { hookkaExpectedDD: newDate },
      });
      if (json.success) {
        setPlanningPOs((prev) =>
          prev.map((r) => (r.id === rowId ? { ...r, hookkaExpectedDD: newDate } : r))
        );
        setReadyPOs((prev) =>
          prev.map((r) => (r.id === rowId ? { ...r, hookkaExpectedDD: newDate } : r))
        );
      }
    } catch {
      // silently ignore network errors
    } finally {
      setEditingDDId(null);
    }
  }, []);

  // ---------- Planning columns ----------
  const planningColumns: Column<ReadyPORow>[] = useMemo(
    () => [
      { key: "salesOrderNo", label: "SO No.", type: "docno", width: "130px", sortable: true },
      {
        key: "poNo",
        label: "SO ID",
        type: "docno",
        width: "150px",
        sortable: true,
        render: (_v, row) => <span className="doc-number">{displaySoId(row)}</span>,
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
        label: "Unit (m\u00B3)",
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
                    updateExpectedDD(row.salesOrderId, editingDDValue, row.id);
                  } else {
                    setEditingDDId(null);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (editingDDValue) {
                      updateExpectedDD(row.salesOrderId, editingDDValue, row.id);
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
    [editingDDId, editingDDValue, updateExpectedDD]
  );

  // ---------- Pending Delivery columns ----------
  // Selection column removed 2026-04-27 (BUG dual-state: this custom
  // checkbox tracked `selectedReadyPOs` while the grid had its OWN
  // `selectedKeys` driven by row-body clicks. They could diverge — user
  // saw "1 selected" badge from the grid while the custom checkboxes
  // showed 3 ticked, then Create DO POSTed all 3 → multi-customer
  // reject. Now using the grid's built-in `selectable` prop +
  // `onSelectionChange` callback so there's exactly one source of truth.)
  const pendingDeliveryColumns: Column<ReadyPORow>[] = useMemo(
    () => [
      { key: "salesOrderNo", label: "SO No.", type: "docno", width: "130px", sortable: true },
      {
        key: "poNo",
        label: "SO ID",
        type: "docno",
        width: "150px",
        sortable: true,
        render: (_v, row) => <span className="doc-number">{displaySoId(row)}</span>,
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
        label: "Unit (m\u00B3)",
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
        render: (_v, row) => <span className="tabular-nums">{row.uphCompletedDate ? formatDate(row.uphCompletedDate) : "-"}</span>,
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
                    updateExpectedDD(row.salesOrderId, editingDDValue, row.id);
                  } else {
                    setEditingDDId(null);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (editingDDValue) {
                      updateExpectedDD(row.salesOrderId, editingDDValue, row.id);
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
    [selectedReadyPOs, editingDDId, editingDDValue, updateExpectedDD]
  );

  // ---------- DO Columns ----------
  const columns: Column<DeliveryOrderRow>[] = useMemo(
    () => [
      {
        key: "_select",
        label: "",
        width: "40px",
        align: "center",
        render: (_value, row) => (
          <input
            type="checkbox"
            checked={selectedIds.has(row.id)}
            onChange={(e) => {
              e.stopPropagation();
              toggleSelect(row.id);
            }}
            className="h-4 w-4 rounded border-[#E2DDD8] accent-[#6B5C32]"
          />
        ),
      },
      // Order matches the layout the operator asked for: Dispatch Date first
      // so today's truck plan is the primary sort target. Customer/SO/State
      // counts replace the single-customer column because a single DO can
      // consolidate multiple drops (e.g. DO-2604-002 has Carress + Houzs
      // Century — the legacy customerName field only carried the first one).
      {
        key: "dispatchDate",
        label: "Dispatch Date",
        type: "date",
        width: "120px",
        sortable: true,
        // Pending Dispatch DOs have no actual dispatchDate yet — fall back to
        // the planned deliveryDate (set at SO/DO creation) with a small
        // "(planned)" tag so operators see SOMETHING to plan against instead
        // of a "-" placeholder.
        render: (_value, row) => {
          if (row.dispatchDate) {
            return <span>{formatDate(row.dispatchDate)}</span>;
          }
          if (row.deliveryDate) {
            return (
              <span>
                {formatDate(row.deliveryDate)}{" "}
                <span className="text-[10px] text-[#9C8E72]">(planned)</span>
              </span>
            );
          }
          return <span>-</span>;
        },
      },
      { key: "doNo", label: "DO No.", type: "docno", width: "120px", sortable: true },
      {
        key: "customerCount",
        label: "Customers",
        type: "text",
        width: "150px",
        sortable: true,
        // Counts distinct customers across the items via salesOrderNo →
        // (we don't have a per-item customer field; use the DO's own
        // customerName as the primary, and bump the count if dropPoints
        // carries multi-drop info). Shows "Houzs Century +1 more" style
        // when the DO is multi-customer.
        render: (_value, row) => {
          const drops = (row as DeliveryOrderRow & { dropPoints?: number }).dropPoints ?? 1;
          if (drops > 1) {
            return (
              <span className="text-[#1F1D1B]">
                {row.customerName || "-"}{" "}
                <span className="text-[#9C6F1E] text-xs">+{drops - 1} more</span>
              </span>
            );
          }
          return <span className="text-[#1F1D1B]">{row.customerName || "-"}</span>;
        },
      },
      {
        key: "hubBranch",
        label: "State",
        type: "text",
        width: "100px",
        sortable: true,
        // Distinct hub states across items[]. Today most DOs are single-state
        // (the schema ties a DO to one hubId), so this usually renders one
        // code; when items span multiple states we show both like "PG, KL".
        // Fallback chain when items[] doesn't carry per-item hubState: prefer
        // row.hubState (resolved server-side via delivery_hubs.state on hubId)
        // over the legacy hubBranch (which mirrors customerState — frequently
        // NULL on production rows even when hubId is set).
        render: (_value, row) => {
          const states = Array.from(
            new Set(
              (row.items || [])
                .map((it) => (it as DOItem & { hubState?: string }).hubState)
                .filter((s): s is string => Boolean(s))
            )
          );
          const display =
            states.length > 0 ? states.join(", ") : row.hubState || row.hubBranch;
          return <span className="text-[#4B5563]">{display || "-"}</span>;
        },
      },
      {
        key: "salesOrderNos",
        label: "Sales Orders",
        type: "text",
        width: "180px",
        sortable: true,
        // Distinct SO numbers from items[]. A DO can span multiple SOs
        // (e.g. one truck trip consolidating SO-2604-326 + SO-2604-328);
        // shown comma-separated.
        render: (_value, row) => {
          const sos = Array.from(
            new Set(
              (row.items || [])
                .map((it) => it.salesOrderNo)
                .filter((s): s is string => Boolean(s))
            )
          );
          if (sos.length === 0) {
            return <span className="text-[#9CA3AF]">{row.salesOrderId || "-"}</span>;
          }
          return <span className="text-[#1F1D1B]">{sos.join(", ")}</span>;
        },
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
              {row.itemCount} item{row.itemCount === 1 ? "" : "s"} · {(row.totalM3 ?? 0).toFixed(2)} m³
            </span>
          </div>
        ),
      },
      // Transport Co. = the 3PL provider COMPANY (e.g. "Express Logistics
      // Sdn Bhd"). delivery_orders.driverId column holds the provider's id
      // (legacy column name, kept post-3PL refactor) - look up the actual
      // company name from the providers list. Bug fix 2026-04-28: was
      // reading row.driverName which is the picked DRIVER PERSON's name
      // (e.g. "Abu"), so the column was showing the driver in the
      // company column.
      {
        key: "driverId",
        label: "Transport Co.",
        type: "text",
        width: "180px",
        sortable: true,
        render: (_value, row) => {
          const company = providers.find((p) => p.id === row.driverId)?.name ?? row.driverId;
          return (
            <span className="text-[#1F1D1B]">{company || <span className="text-[#9CA3AF]">—</span>}</span>
          );
        },
      },
      // Driver = the actual person who's driving (e.g. "Abu"). Stored in
      // delivery_orders.driverName column (denormalized PERSON name on
      // POST/PUT). NOT driverContactPerson - that's the provider's
      // company contact (e.g. "Mr Lee"), which has nothing to do with
      // who's driving the truck.
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
      // Lorry plate from the picked vehicle (three_pl_vehicles).
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
    [selectedIds, providers]
  );

  // ---------- Context menu ----------
  const getContextMenuItems = useCallback(
    (row: DeliveryOrderRow): ContextMenuItem[] => [
      {
        label: "View Details",
        icon: <Eye className="h-3.5 w-3.5" />,
        action: () => setDetailDO(row),
      },
      {
        label: "Print DO",
        icon: <Printer className="h-3.5 w-3.5" />,
        action: () => triggerPrint(row, "do"),
      },
      {
        label: "Print Packing List",
        icon: <FileText className="h-3.5 w-3.5" />,
        action: () => triggerPrint(row, "packing-list"),
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Mark Dispatched",
        icon: <Send className="h-3.5 w-3.5" />,
        action: async () => {
          try {
            const data = await fetchJson(`/api/delivery-orders/${row.id}`, DOMutationSchema, {
              method: "PUT",
              body: { status: "LOADED" },
            });
            if (!data.success) {
              toast.error(data.error || "Failed to mark dispatched");
            }
          } catch (e) {
            if (e instanceof FetchJsonError) {
              toast.error((e.body as { error?: string } | undefined)?.error || e.message);
            } else {
              toast.error("Failed to mark dispatched");
            }
          }
          fetchData();
        },
        disabled: row.status !== "DRAFT",
      },
      {
        label: "Reverse to Pending Dispatch",
        icon: <Package className="h-3.5 w-3.5" />,
        action: async () => {
          if (!confirm("Reverse this DO back to Pending Dispatch?")) return;
          try {
            const data = await fetchJson(`/api/delivery-orders/${row.id}`, DOMutationSchema, {
              method: "PUT",
              body: { status: "DRAFT" },
            });
            if (!data.success) {
              toast.error(data.error || "Failed to reverse");
            }
          } catch (e) {
            if (e instanceof FetchJsonError) {
              toast.error((e.body as { error?: string } | undefined)?.error || e.message);
            } else {
              toast.error("Failed to reverse");
            }
          }
          fetchData();
        },
        disabled: row.status !== "LOADED",
      },
      {
        // Driver-leaves-warehouse step. Backend transition LOADED →
        // IN_TRANSIT was always there (delivery-orders.ts:28) but the
        // frontend never offered a button — the audit caught it as
        // dead-end UI: dispatched DOs stayed in "Dispatched" state with
        // no way to record they were physically out for delivery.
        label: "Mark Out for Delivery (In Transit)",
        icon: <Send className="h-3.5 w-3.5" />,
        action: async () => {
          try {
            const data = await fetchJson(`/api/delivery-orders/${row.id}`, DOMutationSchema, {
              method: "PUT",
              body: { status: "IN_TRANSIT" },
            });
            if (!data.success) {
              toast.error(data.error || "Failed to mark in transit");
            }
          } catch (e) {
            if (e instanceof FetchJsonError) {
              toast.error((e.body as { error?: string } | undefined)?.error || e.message);
            } else {
              toast.error("Failed to mark in transit");
            }
          }
          fetchData();
        },
        disabled: row.status !== "LOADED",
      },
      {
        label: "Mark Delivered (DO Signed)",
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
        action: () => setPodDialog(row),
        disabled: row.status !== "LOADED" && row.status !== "IN_TRANSIT",
      },
      {
        label: "Transfer to Invoice",
        icon: <ReceiptText className="h-3.5 w-3.5" />,
        action: () => handleGenerateInvoice(row),
        disabled: row.status !== "DELIVERED",
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Refresh",
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        action: () => fetchData(),
      },
    ],
    [fetchData]
  );

  // ---------- Tab counts ----------
  const tabCounts: Record<string, number> = {
    planning: planningPOs.length,
    pending_delivery: readyPOs.length,
    pending_dispatch: pendingDispatchCount,
    dispatched: dispatchedCount,
    delivered: uniqueDOsByStatus.delivered,
    invoiced: uniqueDOsByStatus.invoiced,
  };

  return (
    <div className="space-y-6">
      {/* Top-level tab bar */}
      <div className="flex items-center gap-1 border-b border-[#E2DDD8]">
        <button
          onClick={() => setPageTab("orders")}
          className={`flex items-center gap-2 px-4 pb-3 pt-1 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            pageTab === "orders"
              ? "border-[#6B5C32] text-[#6B5C32]"
              : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
          }`}
        >
          <Truck className="h-4 w-4" /> Delivery Orders
        </button>
        <button
          onClick={() => setPageTab("3pl")}
          className={`flex items-center gap-2 px-4 pb-3 pt-1 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            pageTab === "3pl"
              ? "border-[#6B5C32] text-[#6B5C32]"
              : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
          }`}
        >
          <Users className="h-4 w-4" /> 3PL Providers
        </button>
      </div>

      {pageTab === "orders" && <>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Delivery Orders</h1>
          <p className="text-xs text-[#6B7280]">
            Manage delivery orders, packing lists, and dispatch tracking
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <Button variant="outline" onClick={handlePrintPackingList}>
                <Printer className="h-4 w-4" /> Print Packing List
              </Button>
              <Button variant="outline" onClick={handleMarkDispatched}>
                <Send className="h-4 w-4" /> Mark Dispatched
              </Button>
              <Button variant="outline" onClick={handleMarkDelivered}>
                <CheckCircle2 className="h-4 w-4" /> Mark Delivered
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FAEFCB] p-2.5">
              <Package className="h-5 w-5 text-[#9C6F1E]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#9C6F1E]">{loading ? "-" : pendingDispatchCount}</p>
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



      {/* Tabs — 6-stage delivery workflow */}
      <div className="border-b border-[#E2DDD8]">
        <nav className="flex gap-4 overflow-x-auto" aria-label="Tabs">
          {ALL_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => {
                setActiveTab(tab.key);
                setSelectedIds(new Set());
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

      {/* ============================================================== */}
      {/* Tab Content                                                     */}
      {/* ============================================================== */}

      {/* ---- Planning Tab ---- */}
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
              emptyMessage="No items in planning."
              groupBy="customerState"
            />
          </CardContent>
        </Card>
      )}

      {/* ---- Pending Delivery Tab ---- */}
      {activeTab === "pending_delivery" && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <PackageCheck className="h-5 w-5 text-[#6B5C32]" /> Production Complete — Ready for DO
              </CardTitle>
              {selectedReadyPOs.size > 0 && (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={creatingDOFromPO}
                  onClick={() => {
                    // Multi-customer/multi-state selections are allowed
                    // (user request 2026-04-27). One DO can carry POs
                    // for multiple destinations — operator's call.
                    const selected = readyPOs.filter((po) => selectedReadyPOs.has(po.id));
                    openCreateDODialog(selected);
                  }}
                >
                  {creatingDOFromPO ? (
                    <><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Creating...</>
                  ) : (
                    <><PackageCheck className="h-3.5 w-3.5" /> Create DO ({selectedReadyPOs.size})</>
                  )}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <DataGrid<ReadyPORow>
              columns={pendingDeliveryColumns}
              data={readyPOs}
              keyField="id"
              loading={loading}
              stickyHeader
              maxHeight="calc(100vh - 280px)"
              emptyMessage="No items pending delivery."
              groupBy="customerState"
              selectable
              onSelectionChange={(rows) =>
                setSelectedReadyPOs(new Set(rows.map((r) => r.id)))
              }
            />
          </CardContent>
        </Card>
      )}

      {/* ---- DO-based tabs: Pending Dispatch / Dispatched / Delivered / Invoice ---- */}
      {!PO_TABS.has(activeTab) && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Truck className="h-5 w-5 text-[#6B5C32]" /> Delivery Orders
              </CardTitle>
              <div className="flex items-center gap-3">
                {/* Manual create — only meaningful on Pending Dispatch.
                    Dispatched / Delivered / Invoice tabs already represent
                    DOs that have moved past creation, so the entry point
                    would be confusing there. */}
                {activeTab === "pending_dispatch" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={openManualCreateDODialog}
                  >
                    <Plus className="h-3.5 w-3.5" /> Create DO
                  </Button>
                )}
                {filteredOrders.length > 0 && (
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.size === filteredOrders.length && filteredOrders.length > 0}
                      onChange={toggleSelectAll}
                      className="h-4 w-4 rounded border-[#E2DDD8] accent-[#6B5C32]"
                    />
                    <span className="text-xs text-[#6B7280]">
                      {selectedIds.size > 0 ? `${selectedIds.size} selected` : "Select all"}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <DataGrid<DeliveryOrderRow>
              columns={columns}
              data={filteredOrders}
              keyField="id"
              loading={loading}
              stickyHeader
              maxHeight="calc(100vh - 280px)"
              emptyMessage="No delivery orders found."
              onDoubleClick={(row) => setDetailDO(row)}
              contextMenuItems={getContextMenuItems}
            />

            {/* Pagination footer */}
            <div className="flex items-center justify-between border-t border-[#E2DDD8] pt-3 mt-3 text-sm text-[#6B7280]">
              <span>
                {totalDOsServer.toLocaleString()} delivery order
                {totalDOsServer === 1 ? "" : "s"}
              </span>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page <= 1 || doLoading}
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
                  disabled={page >= totalPages || doLoading}
                >
                  Next →
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---------- Create DO Dialog ---------- */}
      {createDODialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setCreateDODialog(null)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            <div className="px-6 py-4 border-b border-[#E2DDD8]">
              <h2 className="text-lg font-bold text-[#1F1D1B]">Create Delivery Order</h2>
              <p className="text-xs text-[#6B7280]">
                {createDODialog === "manual"
                  ? "Pick a customer to spawn a blank DO. Items can be added afterwards from the DO detail."
                  : "Assign 3PL provider, delivery address, and generate DO"}
              </p>
            </div>
            <div className="px-6 py-5 space-y-4">
              {createDODialog === "manual" ? (
                /* Manual mode: customer picker drives default hub for the
                   address. No items panel — operator adds POs in Edit mode
                   after the blank DO lands. */
                <div>
                  <label className="text-xs text-[#6B7280] font-medium">
                    Customer <span className="text-rose-600">*</span>
                  </label>
                  <select
                    value={manualCustomerId}
                    onChange={(e) => setManualCustomerId(e.target.value)}
                    className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                  >
                    <option value="">— Select customer —</option>
                    {customersData.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  {manualCustomerId && (() => {
                    const cust = customersData.find((c) => c.id === manualCustomerId);
                    const hub = cust?.deliveryHubs.find((h) => h.isDefault) ?? cust?.deliveryHubs[0];
                    if (!hub) {
                      return (
                        <p className="text-xs text-rose-600 mt-2">
                          This customer has no delivery hub configured. Add one before creating a DO.
                        </p>
                      );
                    }
                    return (
                      <div className="mt-2 bg-[#FAF9F7] border border-[#E2DDD8] rounded-md p-2 text-xs text-[#6B7280]">
                        <p className="font-medium text-[#1F1D1B]">{hub.address}</p>
                        <p>{hub.contactName ?? "—"} · {hub.phone ?? "—"}</p>
                      </div>
                    );
                  })()}
                </div>
              ) : (
                /* Convert mode: items pre-selected from Pending Delivery */
                <div className="bg-[#E0EDF0] border border-[#A8CAD2] rounded-lg p-3">
                  <p className="text-sm text-[#3E6570] font-medium mb-2">Items ({createDODialog.length})</p>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {createDODialog.map((po) => (
                      <div key={po.id} className="flex items-center justify-between text-xs">
                        <span className="font-mono text-[#3E6570]">{po.productCode} — {po.sizeLabel}</span>
                        <span className="text-[#3E6570]">{po.customerName} · Qty {po.quantity}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 3PL Provider — picks the company; vehicle + driver pickers
                  below filter to that provider's three_pl_vehicles +
                  three_pl_drivers rows respectively. */}
              <div>
                <label className="text-xs text-[#6B7280] font-medium">3PL Provider</label>
                <select
                  value={createDOForm.driverId}
                  onChange={(e) =>
                    // Reset vehicle + driver picks when provider changes —
                    // their option lists are scoped to the chosen company.
                    setCreateDOForm((f) => ({
                      ...f,
                      driverId: e.target.value,
                      vehicleId: "",
                      driverPersonId: "",
                    }))
                  }
                  className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                >
                  <option value="">— Select 3PL Provider —</option>
                  {providers.filter((p) => p.status === "ACTIVE").map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Vehicle / Lorry — optional. Per-vehicle rate overrides
                  the company rate when computing Est. Delivery Cost. */}
              <div>
                <label className="text-xs text-[#6B7280] font-medium">Vehicle</label>
                <select
                  value={createDOForm.vehicleId}
                  onChange={(e) => setCreateDOForm((f) => ({ ...f, vehicleId: e.target.value }))}
                  disabled={!createDOForm.driverId}
                  className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32] disabled:bg-[#F9F7F5] disabled:text-[#999]"
                >
                  <option value="">
                    {createDOForm.driverId ? "— Optional —" : "Pick provider first"}
                  </option>
                  {createDialogVehicles
                    .filter((v) => v.status === "ACTIVE")
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.plateNo} — {v.vehicleType || "—"} (RM{(v.ratePerTripSen / 100).toFixed(0)}/trip)
                      </option>
                    ))}
                </select>
              </div>

              {/* Driver — optional, the actual person from three_pl_drivers. */}
              <div>
                <label className="text-xs text-[#6B7280] font-medium">Driver</label>
                <select
                  value={createDOForm.driverPersonId}
                  onChange={(e) => setCreateDOForm((f) => ({ ...f, driverPersonId: e.target.value }))}
                  disabled={!createDOForm.driverId}
                  className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32] disabled:bg-[#F9F7F5] disabled:text-[#999]"
                >
                  <option value="">
                    {createDOForm.driverId ? "— Optional —" : "Pick provider first"}
                  </option>
                  {createDialogDrivers
                    .filter((d) => d.status === "ACTIVE")
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}{d.phone ? ` — ${d.phone}` : ""}
                      </option>
                    ))}
                </select>
              </div>

              {/* Drop Points — only meaningful in convert mode (manual mode
                  pulls a single hub from the chosen customer above) */}
              {createDODialog !== "manual" && (
              <div>
                <label className="text-xs text-[#6B7280] font-medium mb-2 block">
                  Delivery Destinations ({createDODrops.length} drop{createDODrops.length > 1 ? "s" : ""})
                </label>
                <div className="space-y-3">
                  {createDODrops.map((drop, dIdx) => {
                    const cust = customersData.find((c) => c.id === drop.customerId);
                    const hubs = cust?.deliveryHubs || [];
                    return (
                      <div
                        key={`${drop.customerId}-${dIdx}`}
                        draggable
                        onDragStart={() => setDragDropIdx(dIdx)}
                        onDragOver={(e) => { e.preventDefault(); }}
                        onDrop={() => {
                          if (dragDropIdx !== null && dragDropIdx !== dIdx) {
                            setCreateDODrops((prev) => {
                              const next = [...prev];
                              const [moved] = next.splice(dragDropIdx, 1);
                              next.splice(dIdx, 0, moved);
                              return next;
                            });
                          }
                          setDragDropIdx(null);
                        }}
                        onDragEnd={() => setDragDropIdx(null)}
                        className={cn(
                          "bg-[#FAF9F7] border rounded-lg p-3 cursor-grab active:cursor-grabbing transition-all",
                          dragDropIdx === dIdx ? "border-[#6B5C32] opacity-50" : "border-[#E2DDD8]",
                          dragDropIdx !== null && dragDropIdx !== dIdx && "border-dashed border-[#6B5C32]/40"
                        )}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-bold text-[#1F1D1B] flex items-center gap-1.5">
                            {createDODrops.length > 1 && (
                              <span className="text-[#BBB] cursor-grab" title="Drag to reorder">⠿</span>
                            )}
                            {createDODrops.length > 1 && <span className="text-[#6B5C32]">Drop {dIdx + 1}</span>}
                            {drop.customerName}
                          </span>
                          <span className="text-[10px] text-[#999]">{drop.poIds.length} item{drop.poIds.length > 1 ? "s" : ""}</span>
                        </div>
                        {/* Hub selector */}
                        <select
                          value={drop.hubId}
                          onChange={(e) => {
                            const hub = hubs.find((h) => h.id === e.target.value);
                            if (!hub) return;
                            setCreateDODrops((prev) => prev.map((d, i) =>
                              i === dIdx ? { ...d, hubId: hub.id, address: hub.address, contactName: hub.contactName, contactPhone: hub.phone } : d
                            ));
                          }}
                          className="w-full h-8 px-2 rounded border border-[#DDD] text-xs bg-white focus:outline-none focus:border-[#6B5C32]"
                        >
                          {hubs.map((h) => (
                            <option key={h.id} value={h.id}>
                              {h.shortName} ({h.state})
                            </option>
                          ))}
                          {hubs.length === 0 && <option value="">No hubs configured</option>}
                        </select>
                        {/* Address + contact */}
                        <p className="text-[11px] text-[#666] leading-snug mt-1.5">{drop.address}</p>
                        <p className="text-[10px] text-[#999] mt-0.5">{drop.contactName} · {drop.contactPhone}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
              )}

              {/* Est. Delivery Cost — picks per-vehicle rate when a vehicle
                  is chosen, falls back to the legacy company rate otherwise.
                  Drops scale via ratePerExtraDropSen. */}
              <div className="flex items-center justify-between bg-[#F5F3F0] rounded-lg px-3 py-2">
                <span className="text-xs text-[#6B7280]">Est. Delivery Cost</span>
                <span className="text-sm font-semibold text-[#1F1D1B]">
                  {(() => {
                    const drops = Math.max(1, createDODrops.length);
                    const v = createDialogVehicles.find((vv) => vv.id === createDOForm.vehicleId);
                    if (v) {
                      const cost = v.ratePerTripSen + Math.max(0, drops - 1) * v.ratePerExtraDropSen;
                      return `RM ${(cost / 100).toFixed(2)}`;
                    }
                    const p = providers.find((pr) => pr.id === createDOForm.driverId);
                    if (!p) return "—";
                    const cost = p.ratePerTripSen + Math.max(0, drops - 1) * p.ratePerExtraDropSen;
                    return `RM ${(cost / 100).toFixed(2)}`;
                  })()}
                </span>
              </div>

              {/* Delivery Date — planned drop-off date the customer expects.
                  Optional at create time so users with no firm date yet can
                  still cut a DO; can be filled in later via Edit. */}
              <div>
                <label className="text-xs text-[#6B7280] font-medium">Delivery Date</label>
                <input
                  type="date"
                  value={createDOForm.deliveryDate}
                  onChange={(e) => setCreateDOForm((f) => ({ ...f, deliveryDate: e.target.value }))}
                  className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                />
              </div>

              {/* Remarks */}
              <div>
                <label className="text-xs text-[#6B7280] font-medium">Remarks</label>
                <input
                  type="text"
                  value={createDOForm.remarks}
                  onChange={(e) => setCreateDOForm((f) => ({ ...f, remarks: e.target.value }))}
                  className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-[#E2DDD8] flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setCreateDODialog(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={confirmCreateDO}
                disabled={
                  creatingDOFromPO ||
                  (createDODialog === "manual" && !manualCustomerId)
                }
              >
                {creatingDOFromPO ? (
                  <><RefreshCw className="h-4 w-4 animate-spin" /> Creating...</>
                ) : (
                  <><PackageCheck className="h-4 w-4" /> Create DO</>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Print Packing List Dialog ---------- */}
      {printDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setPrintDialog(null)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 border border-[#E2DDD8]">
            <div className="px-6 py-4 border-b border-[#E2DDD8]">
              <h2 className="text-lg font-bold text-[#1F1D1B]">Print Packing List</h2>
            </div>
            <div className="px-6 py-5 space-y-3">
              <p className="text-xs text-[#6B7280]">Generating packing list for:</p>
              <div className="space-y-1">
                {printDialog.map((d) => (
                  <div key={d.id} className="flex items-center justify-between text-sm bg-[#FAF9F7] rounded-lg px-3 py-2">
                    <span className="font-mono font-medium text-[#1F1D1B]">{d.doNo}</span>
                    <span className="text-[#6B7280]">{d.customerName}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="px-6 py-4 border-t border-[#E2DDD8] flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setPrintDialog(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => { setPrintDialog(null); }}>
                <Printer className="h-4 w-4" /> Print
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Transfer to Invoice Dialog ---------- */}
      {invoiceDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => !invoiceLoading && setInvoiceDialog(null)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 border border-[#E2DDD8]">
            <div className="px-6 py-4 border-b border-[#E2DDD8]">
              <h2 className="text-lg font-bold text-[#1F1D1B]">Transfer to Sales Invoice</h2>
              <p className="text-xs text-[#6B7280]">Create sales invoice from delivered DO</p>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">DO Number</p>
                  <p className="font-medium font-mono">{invoiceDialog.doNo}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">SO No.</p>
                  <p className="font-medium font-mono">{invoiceDialog.companySO}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Customer</p>
                  <p className="font-medium">{invoiceDialog.customerName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Items</p>
                  <p className="font-medium">{invoiceDialog.itemCount} items</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Total M³</p>
                  <p className="font-medium">{(invoiceDialog.totalM3 ?? 0).toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Delivered Date</p>
                  <p className="font-medium">{invoiceDialog.receivedDate ? formatDate(invoiceDialog.receivedDate) : "-"}</p>
                </div>
              </div>
              <div className="bg-[#EEF3E4] border border-[#C6DBA8] rounded-lg p-3">
                <p className="text-xs text-[#4F7C3A]">DO has been signed back and confirmed delivered. A sales invoice will be created with the delivery details.</p>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-[#E2DDD8] flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setInvoiceDialog(null)} disabled={invoiceLoading}>Cancel</Button>
              <Button variant="primary" onClick={confirmGenerateInvoice} disabled={invoiceLoading}>
                {invoiceLoading ? (
                  <><RefreshCw className="h-4 w-4 animate-spin" /> Creating...</>
                ) : (
                  <><ReceiptText className="h-4 w-4" /> Create Invoice</>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Detail Dialog (inline, fixed inset-0 z-50) ---------- */}
      {detailDO && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => { if (!editMode) { setDetailDO(null); } }}
          />
          {/* Panel */}
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            {/* Header */}
            <div className="sticky top-0 bg-white border-b border-[#E2DDD8] px-6 py-4 flex items-center justify-between rounded-t-xl z-10">
              <div>
                <h2 className="text-lg font-bold text-[#1F1D1B]">{detailDO.doNo}</h2>
                <p className="text-xs text-[#6B7280]">
                  {editMode ? "Edit Delivery Order" : "Delivery Order Detail"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {!editMode && detailDO.status === "DRAFT" && (
                  <>
                    <button
                      onClick={() => enterEditMode(detailDO)}
                      className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B5C32] hover:text-[#1F1D1B] transition-colors"
                      title="Edit DO"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    {/* Delete DO — only available in DRAFT status. Items
                        return to Pending Delivery automatically (the dedup
                        list keys off delivery_order_items.productionOrderId,
                        which goes away with the DO). */}
                    <button
                      onClick={async () => {
                        if (!confirm(`Delete ${detailDO.doNo}? Items will return to Pending Delivery.`)) return;
                        try {
                          const res = await fetch(`/api/delivery-orders/${detailDO.id}`, { method: "DELETE" });
                          const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
                          if (!res.ok || !j?.success) {
                            toast.error(j?.error || "Delete failed");
                            return;
                          }
                          toast.success(`${detailDO.doNo} deleted`);
                          setDetailDO(null);
                          fetchData();
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : "Delete failed");
                        }
                      }}
                      className="rounded-md p-1.5 hover:bg-rose-50 text-rose-600 hover:text-rose-800 transition-colors"
                      title="Delete DO (DRAFT only)"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </>
                )}
                {!editMode && (
                  <>
                    <button
                      onClick={() => triggerPrint(detailDO, "do")}
                      className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors"
                      title="Print DO"
                    >
                      <Printer className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => triggerPrint(detailDO, "packing-list")}
                      className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors"
                      title="Print Packing List"
                    >
                      <FileText className="h-4 w-4" />
                    </button>
                  </>
                )}
                <button
                  onClick={() => { if (editMode) cancelEditMode(); else setDetailDO(null); }}
                  className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="px-6 py-5 space-y-5">
              {/* Status */}
              <div className="flex items-center gap-3">
                <Badge variant="status" status={detailDO.status}>
                  {STATUS_LABEL[detailDO.status]}
                </Badge>
                {editMode && (
                  <span className="text-xs text-[#9C6F1E] bg-[#FAEFCB] px-2 py-0.5 rounded-full font-medium">Editing</span>
                )}
              </div>

              {/* Info Grid — View or Edit */}
              {editMode ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-[#9CA3AF] text-xs mb-0.5">DO Number</p>
                      <p className="font-medium doc-number">{detailDO.doNo}</p>
                    </div>
                    <div>
                      <p className="text-[#9CA3AF] text-xs mb-0.5">Customer</p>
                      <p className="font-medium">{detailDO.customerName}</p>
                    </div>
                    <div>
                      <p className="text-[#9CA3AF] text-xs mb-0.5">State</p>
                      <p className="font-medium">{detailDO.hubBranch}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-[#6B7280] font-medium">3PL Provider</label>
                      <select
                        value={editForm.driverId}
                        onChange={(e) =>
                          // Reset vehicle + driver picks when provider changes —
                          // their option lists are scoped to the chosen company.
                          setEditForm((f) => ({
                            ...f,
                            driverId: e.target.value,
                            vehicleId: "",
                            driverPersonId: "",
                          }))
                        }
                        className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                      >
                        <option value="">— Select 3PL Provider —</option>
                        {providers.filter((p) => p.status === "ACTIVE").map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-[#6B7280] font-medium">Drop Points</label>
                      <input
                        type="number"
                        min={1}
                        value={editForm.dropPoints}
                        onChange={(e) => setEditForm((f) => ({ ...f, dropPoints: e.target.value }))}
                        className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-[#6B7280] font-medium">Vehicle</label>
                      <select
                        value={editForm.vehicleId}
                        onChange={(e) => setEditForm((f) => ({ ...f, vehicleId: e.target.value }))}
                        disabled={!editForm.driverId}
                        className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32] disabled:bg-[#F9F7F5] disabled:text-[#999]"
                      >
                        <option value="">
                          {editForm.driverId ? "— Optional —" : "Pick provider first"}
                        </option>
                        {editDialogVehicles
                          .filter((v) => v.status === "ACTIVE")
                          .map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.plateNo} — {v.vehicleType || "—"} (RM{(v.ratePerTripSen / 100).toFixed(0)}/trip)
                            </option>
                          ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-[#6B7280] font-medium">Driver</label>
                      <select
                        value={editForm.driverPersonId}
                        onChange={(e) => setEditForm((f) => ({ ...f, driverPersonId: e.target.value }))}
                        disabled={!editForm.driverId}
                        className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32] disabled:bg-[#F9F7F5] disabled:text-[#999]"
                      >
                        <option value="">
                          {editForm.driverId ? "— Optional —" : "Pick provider first"}
                        </option>
                        {editDialogDrivers
                          .filter((d) => d.status === "ACTIVE")
                          .map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}{d.phone ? ` — ${d.phone}` : ""}
                            </option>
                          ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-[#6B7280] font-medium">Delivery Address</label>
                    <textarea
                      value={editForm.deliveryAddress}
                      onChange={(e) => setEditForm((f) => ({ ...f, deliveryAddress: e.target.value }))}
                      rows={2}
                      className="mt-1 w-full px-3 py-2 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32] resize-none"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-[#6B7280] font-medium">Contact Person</label>
                      <input
                        type="text"
                        value={editForm.contactPerson}
                        onChange={(e) => setEditForm((f) => ({ ...f, contactPerson: e.target.value }))}
                        className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-[#6B7280] font-medium">Contact Phone</label>
                      <input
                        type="text"
                        value={editForm.contactPhone}
                        onChange={(e) => setEditForm((f) => ({ ...f, contactPhone: e.target.value }))}
                        className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                      />
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
                /* Three-section layout, redesigned 2026-04-27. The previous
                   12-cell grid showed SO No / Customer PO / State as
                   single-value fields, which silently went blank for any
                   multi-SO / multi-customer DO (the underlying columns hold
                   only one value per row). Per-line SO numbers live on the
                   items table + a "Sales Orders" chip strip below; the
                   header now only carries fields that aggregate cleanly.
                   3PL info gets its own section pulling provider name,
                   contact person (the human dispatcher / driver to call —
                   not the recipient at the address), and vehicle plate. */
                <div className="space-y-4">
                  {/* DO Basics */}
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-[#9CA3AF] text-xs mb-0.5">DO Number</p>
                      <p className="font-medium doc-number">{detailDO.doNo}</p>
                    </div>
                    <div>
                      <p className="text-[#9CA3AF] text-xs mb-0.5">Total M³</p>
                      <p className="font-medium">{(detailDO.totalM3 ?? 0).toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-[#9CA3AF] text-xs mb-0.5">Items</p>
                      <p className="font-medium">{detailDO.items.length}</p>
                    </div>
                  </div>

                  {/* Sales Orders covered — comma-separated dedup. Empty for
                      a freshly-created blank manual DO; fills in once items
                      get added. */}
                  {(() => {
                    const sos = Array.from(
                      new Set(
                        detailDO.items
                          .map((it) => it.salesOrderNo)
                          .filter((s) => !!s),
                      ),
                    );
                    if (sos.length === 0) return null;
                    return (
                      <div className="text-sm">
                        <p className="text-[#9CA3AF] text-xs mb-0.5">Sales Orders</p>
                        <p className="font-medium doc-number">{sos.join(", ")}</p>
                      </div>
                    );
                  })()}

                  {/* 3PL — split into three sections (3PL refactor 2026-04-27).
                      Provider = the company + dispatcher contact person.
                      Vehicle  = the picked lorry (plate + type) — pricing
                                 follows the truck, not the company.
                      Driver   = the actual person on the trip + their phone.
                      All three are independent and any may be blank for
                      DOs created before a pick was made. Provider name
                      lookup falls back to the legacy driverName field for
                      pre-refactor rows where no separate person was
                      captured. */}
                  <div className="border-t border-[#E2DDD8] pt-3">
                    <p className="text-xs text-[#6B7280] font-medium mb-2">Provider</p>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-[#9CA3AF] text-xs mb-0.5">Name</p>
                        <p className="font-medium">
                          {(() => {
                            const p = providers.find((pr) => pr.id === detailDO.driverId);
                            return p?.name || detailDO.driverName || "-";
                          })()}
                        </p>
                      </div>
                      <div>
                        <p className="text-[#9CA3AF] text-xs mb-0.5">Company Contact</p>
                        <p className="font-medium">{detailDO.driverContactPerson || "-"}</p>
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-[#E2DDD8] pt-3">
                    <p className="text-xs text-[#6B7280] font-medium mb-2">Vehicle</p>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-[#9CA3AF] text-xs mb-0.5">Plate No.</p>
                        <p className="font-medium doc-number">{detailDO.vehicleNo || "-"}</p>
                      </div>
                      <div>
                        <p className="text-[#9CA3AF] text-xs mb-0.5">Type</p>
                        <p className="font-medium">{detailDO.vehicleType || "-"}</p>
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-[#E2DDD8] pt-3">
                    <p className="text-xs text-[#6B7280] font-medium mb-2">Driver</p>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-[#9CA3AF] text-xs mb-0.5">Name</p>
                        <p className="font-medium">{detailDO.driverName || "-"}</p>
                      </div>
                      <div>
                        <p className="text-[#9CA3AF] text-xs mb-0.5">Driver Contact</p>
                        <p className="font-medium doc-number">{detailDO.driverPhone || "-"}</p>
                      </div>
                    </div>
                  </div>

                  {/* Delivery Info */}
                  <div className="border-t border-[#E2DDD8] pt-3">
                    <p className="text-xs text-[#6B7280] font-medium mb-2">Delivery Info</p>
                    {/* Customer line. Multi-drop renders as
                        "Drop 1: A, Drop 2: B" derived from parsing the
                        deliveryAddress string the create flow writes. We
                        keep the parse loose: the format is
                        "Drop N (Name): address\n..." for multi-drop, and
                        a plain address string for single-drop. */}
                    <div className="grid grid-cols-1 gap-3 text-sm">
                      <div>
                        <p className="text-[#9CA3AF] text-xs mb-0.5">Customer</p>
                        <p className="font-medium">{detailDO.customerName || "-"}</p>
                      </div>
                      <div>
                        <p className="text-[#9CA3AF] text-xs mb-0.5">Delivery Address</p>
                        {(() => {
                          const addr = detailDO.deliveryAddress || "";
                          // Multi-drop: split on newlines, render each as a
                          // "Drop N: <Customer>\n  <address>" stanza so the
                          // operator scans drops at a glance instead of one
                          // long blob.
                          if (addr.includes("Drop ") && addr.includes("\n")) {
                            const drops = addr.split("\n").filter((s) => s.trim());
                            return (
                              <div className="space-y-1.5">
                                {drops.map((line, i) => {
                                  // line shape: "Drop 1 (Customer Name): address blah"
                                  const m = line.match(/^(Drop \d+)\s*\(([^)]+)\):\s*(.*)$/);
                                  if (!m) {
                                    return (
                                      <p key={i} className="text-xs text-[#1F1D1B]">{line}</p>
                                    );
                                  }
                                  const [, dropLabel, custName, address] = m;
                                  return (
                                    <div key={i}>
                                      <p className="font-medium text-xs text-[#1F1D1B]">
                                        {dropLabel}: {custName}
                                      </p>
                                      <p className="text-xs text-[#6B7280] pl-3">{address}</p>
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          }
                          return (
                            <p className="font-medium text-xs">{addr || "-"}</p>
                          );
                        })()}
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className="text-[#9CA3AF] text-xs mb-0.5">Recipient Contact</p>
                          <p className="font-medium">{detailDO.contactPerson || "-"}</p>
                        </div>
                        <div>
                          <p className="text-[#9CA3AF] text-xs mb-0.5">Recipient Phone</p>
                          <p className="font-medium doc-number">{detailDO.contactPhone || "-"}</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className="text-[#9CA3AF] text-xs mb-0.5">Delivery Date</p>
                          <p className="font-medium">
                            {detailDO.deliveryDate ? formatDate(detailDO.deliveryDate) : "-"}
                          </p>
                        </div>
                        <div>
                          <p className="text-[#9CA3AF] text-xs mb-0.5">Dispatch Date</p>
                          <p className="font-medium">
                            {detailDO.dispatchDate ? formatDate(detailDO.dispatchDate) : "-"}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Items Table — Enhanced with SO No., SO ID, Racking */}
              <div className="border-t border-[#E2DDD8] pt-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-[#1F1D1B]">
                    Items ({editMode ? editItems.length : detailDO.items.length})
                  </h3>
                  {editMode && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowAddItemPanel(!showAddItemPanel)}
                    >
                      <Plus className="h-3.5 w-3.5" /> Add Items
                    </Button>
                  )}
                </div>

                {/* Add Item Panel (edit mode only) */}
                {editMode && showAddItemPanel && (
                  <div className="mb-3 border border-[#A8CAD2] rounded-lg bg-[#E0EDF0]/50 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs text-[#3E6570] font-medium">Available Production Orders</p>
                      <div className="relative">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#9CA3AF]" />
                        <input
                          type="text"
                          placeholder="Search PO, product, SO..."
                          value={addItemSearch}
                          onChange={(e) => setAddItemSearch(e.target.value)}
                          className="h-7 pl-7 pr-2 w-56 rounded border border-[#A8CAD2] text-xs focus:outline-none focus:border-[#6B5C32]"
                        />
                      </div>
                    </div>
                    <div className="max-h-40 overflow-y-auto space-y-1">
                      {addablePOs.length === 0 ? (
                        <p className="text-xs text-[#6B7280] text-center py-3">No available production orders</p>
                      ) : (
                        addablePOs.map((po) => (
                          <div
                            key={po.id}
                            className="flex items-center justify-between text-xs bg-white rounded px-2 py-1.5 border border-[#A8CAD2] hover:border-[#A8CAD2] cursor-pointer"
                            onClick={() => addReadyPOToEdit(po)}
                          >
                            <div className="flex items-center gap-3">
                              <span className="font-mono text-[#3E6570]">{po.poNo}</span>
                              <span className="text-[#6B7280]">{po.salesOrderNo}</span>
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
                        <th className="text-left px-3 py-2 font-medium text-xs">SO No.</th>
                        <th className="text-left px-3 py-2 font-medium text-xs">SO ID</th>
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
                      {(editMode ? editItems : detailDO.items).map((item, idx) => (
                        <tr key={item.id} className="border-t border-[#E2DDD8]">
                          <td className="px-3 py-1.5 text-[#9CA3AF] text-xs">{idx + 1}</td>
                          <td className="px-3 py-1.5 font-mono text-xs text-[#6B5C32]">{item.salesOrderNo || "-"}</td>
                          <td className="px-3 py-1.5 font-mono text-xs text-[#6B7280]">{item.poNo || "-"}</td>
                          <td className="px-3 py-1.5 font-mono text-xs text-[#6B5C32]">{item.productCode}</td>
                          <td className="px-3 py-1.5">{item.productName}</td>
                          <td className="px-3 py-1.5 text-[#6B7280]">{item.sizeLabel}</td>
                          <td className="px-3 py-1.5 text-[#6B7280]">{item.fabricCode}</td>
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
                          {(editMode ? editItems : detailDO.items).reduce((s, i) => s + i.quantity, 0)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {(editMode ? editItems : detailDO.items).reduce((s, i) => s + i.itemM3 * i.quantity, 0).toFixed(2)}
                        </td>
                        <td></td>
                        {editMode && <td></td>}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              {/* Dispatch / Receive Tracking (view mode only) */}
              {!editMode && (
                <div className="border-t border-[#E2DDD8] pt-4">
                  <h3 className="text-sm font-semibold text-[#1F1D1B] mb-3">Tracking</h3>
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${
                          detailDO.dispatchDate ? "bg-[#4F7C3A]" : "bg-gray-300"
                        }`}
                      >
                        1
                      </div>
                      <div>
                        <p className="text-sm font-medium">Dispatched</p>
                        <p className="text-xs text-[#9CA3AF]">
                          {detailDO.dispatchDate
                            ? formatDate(detailDO.dispatchDate)
                            : "Pending dispatch"}
                        </p>
                      </div>
                    </div>
                    <div className="ml-4 border-l-2 border-[#E2DDD8] h-4" />
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${
                          detailDO.status === "IN_TRANSIT" ? "bg-[#3E6570]" : detailDO.receivedDate ? "bg-[#4F7C3A]" : "bg-gray-300"
                        }`}
                      >
                        2
                      </div>
                      <div>
                        <p className="text-sm font-medium">In Transit</p>
                        <p className="text-xs text-[#9CA3AF]">
                          {detailDO.status === "IN_TRANSIT"
                            ? "Currently in transit"
                            : detailDO.receivedDate
                            ? "Completed"
                            : "Waiting"}
                        </p>
                      </div>
                    </div>
                    <div className="ml-4 border-l-2 border-[#E2DDD8] h-4" />
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${
                          detailDO.receivedDate ? "bg-[#4F7C3A]" : "bg-gray-300"
                        }`}
                      >
                        3
                      </div>
                      <div>
                        <p className="text-sm font-medium">Delivered (DO Signed)</p>
                        <p className="text-xs text-[#9CA3AF]">
                          {detailDO.receivedDate
                            ? formatDate(detailDO.receivedDate)
                            : "Awaiting DO sign-back"}
                        </p>
                      </div>
                    </div>
                    {detailDO.status === "INVOICED" && (
                      <>
                        <div className="ml-4 border-l-2 border-[#E2DDD8] h-4" />
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold bg-[#6B4A6D]">
                            4
                          </div>
                          <div>
                            <p className="text-sm font-medium">Invoiced</p>
                            <p className="text-xs text-[#9CA3AF]">Sales invoice generated</p>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Footer Actions */}
            <div className="sticky bottom-0 bg-white border-t border-[#E2DDD8] px-6 py-4 flex items-center justify-end gap-2 rounded-b-xl">
              {editMode ? (
                <>
                  <Button variant="outline" onClick={cancelEditMode} disabled={editSaving}>Cancel</Button>
                  <Button variant="primary" onClick={saveEditDO} disabled={editSaving || editItems.length === 0}>
                    {editSaving ? (
                      <><RefreshCw className="h-4 w-4 animate-spin" /> Saving...</>
                    ) : (
                      <><Save className="h-4 w-4" /> Save Changes</>
                    )}
                  </Button>
                </>
              ) : (
                <>
                  {detailDO.status === "DRAFT" && (
                    <>
                      <Button
                        variant="outline"
                        onClick={() => enterEditMode(detailDO)}
                      >
                        <Pencil className="h-4 w-4" /> Edit
                      </Button>
                      <Button
                        variant="primary"
                        onClick={async () => {
                          try {
                            const data = await fetchJson(`/api/delivery-orders/${detailDO.id}`, DOMutationSchema, {
                              method: "PUT",
                              body: { status: "LOADED" },
                            });
                            if (data.success) {
                              setDetailDO({ ...detailDO, status: "LOADED", dispatchDate: new Date().toISOString() });
                              fetchData();
                            } else {
                              toast.error(data.error || "Failed to mark dispatched");
                            }
                          } catch (e) {
                            if (e instanceof FetchJsonError) {
                              toast.error((e.body as { error?: string } | undefined)?.error || e.message);
                            } else {
                              toast.error("Failed to mark dispatched");
                            }
                          }
                        }}
                      >
                        <Send className="h-4 w-4" /> Mark Dispatched
                      </Button>
                    </>
                  )}
                  {(detailDO.status === "LOADED" || detailDO.status === "IN_TRANSIT") && (
                    <Button
                      variant="primary"
                      onClick={() => setPodDialog(detailDO)}
                    >
                      <CheckCircle2 className="h-4 w-4" /> Mark Delivered (DO Signed)
                    </Button>
                  )}
                  {detailDO.status === "DELIVERED" && (
                    <Button
                      variant="primary"
                      onClick={() => handleGenerateInvoice(detailDO)}
                    >
                      <ReceiptText className="h-4 w-4" /> Transfer to Invoice
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => setDetailDO(null)}>
                    Close
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* POD Capture Dialog */}
      {podDialog && (
        <PODDialog
          open={!!podDialog}
          doNo={podDialog.doNo}
          customerName={podDialog.customerName}
          onClose={() => setPodDialog(null)}
          onSubmit={handleSubmitPOD}
        />
      )}
      </>}

      {/* ================================================================ */}
      {/* 3PL Providers Tab                                                */}
      {/* ================================================================ */}
      {pageTab === "3pl" && (
        <>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-[#1F1D1B]">3PL Providers</h1>
              <p className="text-xs text-[#6B7280]">Manage third-party logistics providers</p>
            </div>
            <Button variant="primary" onClick={() => openProviderDialog("new")}>
              <Plus className="h-4 w-4" /> New 3PL
            </Button>
          </div>

          {/* Search */}
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#9CA3AF]" />
            <input
              type="text"
              placeholder="Search providers..."
              value={providerSearch}
              onChange={(e) => setProviderSearch(e.target.value)}
              className="w-full h-9 pl-9 pr-3 rounded-md border border-[#E2DDD8] bg-white text-sm text-[#1F1D1B] focus:outline-none focus:border-[#6B5C32]"
            />
          </div>

          {/* Table */}
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#FAF9F7] text-[#6B7280]">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">Name</th>
                      <th className="text-left px-4 py-2 font-medium">Contact Person</th>
                      <th className="text-left px-4 py-2 font-medium">Phone</th>
                      <th className="text-left px-4 py-2 font-medium">Vehicle No</th>
                      <th className="text-left px-4 py-2 font-medium">Vehicle Type</th>
                      <th className="text-right px-4 py-2 font-medium">Capacity (M&sup3;)</th>
                      <th className="text-right px-4 py-2 font-medium">Rate/Trip (RM)</th>
                      <th className="text-right px-4 py-2 font-medium">Rate/Extra Drop (RM)</th>
                      <th className="text-center px-4 py-2 font-medium">Status</th>
                      <th className="text-right px-4 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providersLoading ? (
                      <tr><td colSpan={10} className="text-center py-8 text-[#6B7280]">Loading...</td></tr>
                    ) : filteredProviders.length === 0 ? (
                      <tr><td colSpan={10} className="text-center py-8 text-[#6B7280]">No providers found.</td></tr>
                    ) : (
                      filteredProviders.map((p) => (
                        <tr
                          key={p.id}
                          className="border-t border-[#E2DDD8] hover:bg-[#FAF9F7] cursor-pointer"
                          onDoubleClick={() => openProviderDialog(p)}
                        >
                          <td className="px-4 py-2 font-medium text-[#1F1D1B]">{p.name}</td>
                          <td className="px-4 py-2 text-[#6B7280]">{p.contactPerson || "-"}</td>
                          <td className="px-4 py-2 text-[#6B7280]">{p.phone}</td>
                          <td className="px-4 py-2 font-mono text-xs">{p.vehicleNo || "-"}</td>
                          <td className="px-4 py-2 text-[#6B7280]">{p.vehicleType || "-"}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{p.capacityM3 ?? "-"}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{(p.ratePerTripSen / 100).toFixed(2)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{(p.ratePerExtraDropSen / 100).toFixed(2)}</td>
                          <td className="px-4 py-2 text-center">
                            <Badge
                              variant="status"
                              status={p.status === "ACTIVE" ? "ACTIVE" : p.status === "ON_LEAVE" ? "WARNING" : "INACTIVE"}
                            >
                              {p.status}
                            </Badge>
                          </td>
                          <td className="px-4 py-2 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={(e) => { e.stopPropagation(); openProviderDialog(p); }}
                                className="p-1.5 rounded hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors"
                                title="Edit"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); deleteProvider(p.id); }}
                                className="p-1.5 rounded hover:bg-[#F9E1DA] text-[#6B7280] hover:text-[#7A2E24] transition-colors"
                                title="Delete"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* 3PL Create/Edit Dialog */}
          {providerDialog !== null && (
            <div className="fixed inset-0 z-50 flex items-center justify-center">
              <div className="absolute inset-0 bg-black/40" onClick={() => !providerSaving && setProviderDialog(null)} />
              <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 border border-[#E2DDD8]">
                <div className="px-6 py-4 border-b border-[#E2DDD8] flex items-center justify-between">
                  <h2 className="text-lg font-bold text-[#1F1D1B]">
                    {providerDialog === "new" ? "New 3PL Provider" : "Edit 3PL Provider"}
                  </h2>
                  <button onClick={() => setProviderDialog(null)} className="p-1.5 rounded hover:bg-[#F0ECE9] text-[#6B7280]">
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="px-6 py-5 space-y-5 max-h-[75vh] overflow-y-auto">
                  {/* --- Company-level fields (top section) --- */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
                      <label className="text-xs text-[#6B7280] font-medium">Name *</label>
                      <input
                        type="text"
                        value={providerForm.name}
                        onChange={(e) => setProviderForm((f) => ({ ...f, name: e.target.value }))}
                        className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-[#6B7280] font-medium">Contact Person</label>
                      <input
                        type="text"
                        value={providerForm.contactPerson}
                        onChange={(e) => setProviderForm((f) => ({ ...f, contactPerson: e.target.value }))}
                        className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-[#6B7280] font-medium">Phone *</label>
                      <input
                        type="text"
                        value={providerForm.phone}
                        onChange={(e) => setProviderForm((f) => ({ ...f, phone: e.target.value }))}
                        className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-[#6B7280] font-medium">Status</label>
                      <select
                        value={providerForm.status}
                        onChange={(e) => setProviderForm((f) => ({ ...f, status: e.target.value as ThreePLProvider["status"] }))}
                        className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                      >
                        <option value="ACTIVE">Active</option>
                        <option value="INACTIVE">Inactive</option>
                        <option value="ON_LEAVE">On Leave</option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className="text-xs text-[#6B7280] font-medium">Remarks</label>
                      <textarea
                        value={providerForm.remarks}
                        onChange={(e) => setProviderForm((f) => ({ ...f, remarks: e.target.value }))}
                        rows={2}
                        className="mt-1 w-full px-3 py-2 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32] resize-none"
                      />
                    </div>
                  </div>

                  {/* --- Vehicles sub-table --- */}
                  <div className="pt-4 border-t border-[#E2DDD8]">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-semibold text-[#1F1D1B]">Vehicles</h3>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openVehicleForm("new")}
                        disabled={!currentProviderId}
                      >
                        <Plus className="h-3.5 w-3.5 mr-1" /> Add Vehicle
                      </Button>
                    </div>
                    {!currentProviderId ? (
                      <div className="text-xs text-[#6B7280] py-3 px-2 bg-[#F9F7F5] rounded-md border border-[#E2DDD8]">
                        Save the provider first to add vehicles and drivers.
                      </div>
                    ) : (
                      <div className="border border-[#E2DDD8] rounded-md overflow-hidden">
                        <table className="w-full text-xs">
                          <thead className="bg-[#F9F7F5] text-[#6B7280]">
                            <tr>
                              <th className="text-left px-2 py-1.5 font-medium">Plate</th>
                              <th className="text-left px-2 py-1.5 font-medium">Type</th>
                              <th className="text-right px-2 py-1.5 font-medium">Cap (m³)</th>
                              <th className="text-right px-2 py-1.5 font-medium">Rate/Trip</th>
                              <th className="text-right px-2 py-1.5 font-medium">+Drop</th>
                              <th className="text-left px-2 py-1.5 font-medium">Status</th>
                              <th className="text-right px-2 py-1.5 font-medium w-20">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {providerVehicles.length === 0 ? (
                              <tr>
                                <td colSpan={7} className="text-center text-[#6B7280] py-3">
                                  No vehicles yet — click "Add Vehicle" above.
                                </td>
                              </tr>
                            ) : (
                              providerVehicles.map((v) => (
                                <tr key={v.id} className="border-t border-[#E2DDD8]">
                                  <td className="px-2 py-1.5 font-medium">{v.plateNo}</td>
                                  <td className="px-2 py-1.5">{v.vehicleType || "-"}</td>
                                  <td className="px-2 py-1.5 text-right">{v.capacityM3 || "-"}</td>
                                  <td className="px-2 py-1.5 text-right">RM{(v.ratePerTripSen / 100).toFixed(2)}</td>
                                  <td className="px-2 py-1.5 text-right">RM{(v.ratePerExtraDropSen / 100).toFixed(2)}</td>
                                  <td className="px-2 py-1.5">
                                    <Badge variant="status" status={v.status} />
                                  </td>
                                  <td className="px-2 py-1.5 text-right">
                                    <button
                                      onClick={() => openVehicleForm(v)}
                                      className="p-1 rounded hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#6B5C32]"
                                      title="Edit"
                                    >
                                      <Pencil className="h-3 w-3" />
                                    </button>
                                    <button
                                      onClick={() => deleteVehicle(v.id)}
                                      className="p-1 rounded hover:bg-[#F9E1DA] text-[#6B7280] hover:text-[#7A2E24]"
                                      title="Delete"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </button>
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {/* Inline vehicle editor */}
                    {vehicleEditing !== null && currentProviderId && (
                      <div className="mt-2 border border-[#6B5C32] rounded-md p-3 bg-[#FBF9F6]">
                        <div className="text-xs font-semibold text-[#6B5C32] mb-2">
                          {vehicleEditing === "new" ? "Add Vehicle" : "Edit Vehicle"}
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <label className="text-[10px] text-[#6B7280] font-medium">Plate No *</label>
                            <input
                              type="text"
                              value={vehicleForm.plateNo}
                              onChange={(e) => setVehicleForm((f) => ({ ...f, plateNo: e.target.value }))}
                              className="mt-1 w-full h-8 px-2 rounded border border-[#E2DDD8] text-xs focus:outline-none focus:border-[#6B5C32]"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-[#6B7280] font-medium">Type</label>
                            <input
                              type="text"
                              value={vehicleForm.vehicleType}
                              onChange={(e) => setVehicleForm((f) => ({ ...f, vehicleType: e.target.value }))}
                              className="mt-1 w-full h-8 px-2 rounded border border-[#E2DDD8] text-xs focus:outline-none focus:border-[#6B5C32]"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-[#6B7280] font-medium">Cap (m³)</label>
                            <input
                              type="number"
                              value={vehicleForm.capacityM3}
                              onChange={(e) => setVehicleForm((f) => ({ ...f, capacityM3: e.target.value }))}
                              className="mt-1 w-full h-8 px-2 rounded border border-[#E2DDD8] text-xs focus:outline-none focus:border-[#6B5C32]"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-[#6B7280] font-medium">Rate/Trip (RM)</label>
                            <input
                              type="number"
                              step="0.01"
                              value={vehicleForm.ratePerTripRM}
                              onChange={(e) => setVehicleForm((f) => ({ ...f, ratePerTripRM: e.target.value }))}
                              className="mt-1 w-full h-8 px-2 rounded border border-[#E2DDD8] text-xs focus:outline-none focus:border-[#6B5C32]"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-[#6B7280] font-medium">+Drop (RM)</label>
                            <input
                              type="number"
                              step="0.01"
                              value={vehicleForm.ratePerExtraDropRM}
                              onChange={(e) => setVehicleForm((f) => ({ ...f, ratePerExtraDropRM: e.target.value }))}
                              className="mt-1 w-full h-8 px-2 rounded border border-[#E2DDD8] text-xs focus:outline-none focus:border-[#6B5C32]"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-[#6B7280] font-medium">Status</label>
                            <select
                              value={vehicleForm.status}
                              onChange={(e) => setVehicleForm((f) => ({ ...f, status: e.target.value as "ACTIVE" | "INACTIVE" }))}
                              className="mt-1 w-full h-8 px-2 rounded border border-[#E2DDD8] text-xs focus:outline-none focus:border-[#6B5C32]"
                            >
                              <option value="ACTIVE">Active</option>
                              <option value="INACTIVE">Inactive</option>
                            </select>
                          </div>
                        </div>
                        <div className="mt-2 flex justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => setVehicleEditing(null)}>
                            Cancel
                          </Button>
                          <Button variant="primary" size="sm" onClick={saveVehicle} disabled={!vehicleForm.plateNo}>
                            <Save className="h-3 w-3 mr-1" /> Save Vehicle
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* --- Drivers sub-table --- */}
                  <div className="pt-4 border-t border-[#E2DDD8]">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-semibold text-[#1F1D1B]">Drivers</h3>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openDriverForm("new")}
                        disabled={!currentProviderId}
                      >
                        <Plus className="h-3.5 w-3.5 mr-1" /> Add Driver
                      </Button>
                    </div>
                    {!currentProviderId ? (
                      <div className="text-xs text-[#6B7280] py-3 px-2 bg-[#F9F7F5] rounded-md border border-[#E2DDD8]">
                        Save the provider first to add vehicles and drivers.
                      </div>
                    ) : (
                      <div className="border border-[#E2DDD8] rounded-md overflow-hidden">
                        <table className="w-full text-xs">
                          <thead className="bg-[#F9F7F5] text-[#6B7280]">
                            <tr>
                              <th className="text-left px-2 py-1.5 font-medium">Name</th>
                              <th className="text-left px-2 py-1.5 font-medium">Phone</th>
                              <th className="text-left px-2 py-1.5 font-medium">Status</th>
                              <th className="text-right px-2 py-1.5 font-medium w-20">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {providerDrivers.length === 0 ? (
                              <tr>
                                <td colSpan={4} className="text-center text-[#6B7280] py-3">
                                  No drivers yet — click "Add Driver" above.
                                </td>
                              </tr>
                            ) : (
                              providerDrivers.map((d) => (
                                <tr key={d.id} className="border-t border-[#E2DDD8]">
                                  <td className="px-2 py-1.5 font-medium">{d.name}</td>
                                  <td className="px-2 py-1.5">{d.phone || "-"}</td>
                                  <td className="px-2 py-1.5">
                                    <Badge variant="status" status={d.status} />
                                  </td>
                                  <td className="px-2 py-1.5 text-right">
                                    <button
                                      onClick={() => openDriverForm(d)}
                                      className="p-1 rounded hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#6B5C32]"
                                      title="Edit"
                                    >
                                      <Pencil className="h-3 w-3" />
                                    </button>
                                    <button
                                      onClick={() => deleteDriverPerson(d.id)}
                                      className="p-1 rounded hover:bg-[#F9E1DA] text-[#6B7280] hover:text-[#7A2E24]"
                                      title="Delete"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </button>
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {/* Inline driver editor */}
                    {driverEditing !== null && currentProviderId && (
                      <div className="mt-2 border border-[#6B5C32] rounded-md p-3 bg-[#FBF9F6]">
                        <div className="text-xs font-semibold text-[#6B5C32] mb-2">
                          {driverEditing === "new" ? "Add Driver" : "Edit Driver"}
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <label className="text-[10px] text-[#6B7280] font-medium">Name *</label>
                            <input
                              type="text"
                              value={driverForm.name}
                              onChange={(e) => setDriverForm((f) => ({ ...f, name: e.target.value }))}
                              className="mt-1 w-full h-8 px-2 rounded border border-[#E2DDD8] text-xs focus:outline-none focus:border-[#6B5C32]"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-[#6B7280] font-medium">Phone</label>
                            <input
                              type="text"
                              value={driverForm.phone}
                              onChange={(e) => setDriverForm((f) => ({ ...f, phone: e.target.value }))}
                              className="mt-1 w-full h-8 px-2 rounded border border-[#E2DDD8] text-xs focus:outline-none focus:border-[#6B5C32]"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-[#6B7280] font-medium">Status</label>
                            <select
                              value={driverForm.status}
                              onChange={(e) => setDriverForm((f) => ({ ...f, status: e.target.value as "ACTIVE" | "INACTIVE" }))}
                              className="mt-1 w-full h-8 px-2 rounded border border-[#E2DDD8] text-xs focus:outline-none focus:border-[#6B5C32]"
                            >
                              <option value="ACTIVE">Active</option>
                              <option value="INACTIVE">Inactive</option>
                            </select>
                          </div>
                        </div>
                        <div className="mt-2 flex justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => setDriverEditing(null)}>
                            Cancel
                          </Button>
                          <Button variant="primary" size="sm" onClick={saveDriver} disabled={!driverForm.name}>
                            <Save className="h-3 w-3 mr-1" /> Save Driver
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="px-6 py-4 border-t border-[#E2DDD8] flex items-center justify-end gap-2">
                  <Button variant="outline" onClick={() => setProviderDialog(null)} disabled={providerSaving}>Cancel</Button>
                  <Button variant="primary" onClick={saveProvider} disabled={providerSaving || !providerForm.name || !providerForm.phone}>
                    {providerSaving ? <><RefreshCw className="h-4 w-4 animate-spin" /> Saving...</> : providerDialog === "new" ? "Create" : "Save Provider Info"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Hidden Print Container — rendered at page level so it's accessible from any tab */}
      {printData && (
        <div className="fixed left-0 top-0 w-full" style={{ zIndex: -1 }}>
          <PrintDO ref={printRef} data={printData.data} mode={printData.mode} />
        </div>
      )}
    </div>
  );
}
