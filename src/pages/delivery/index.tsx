import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useUrlState, useUrlStateNumber } from "@/lib/use-url-state";
import { useSessionState } from "@/lib/use-session-state";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RepairPartsBadge } from "@/components/sales/repair-scope-picker";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { cn, formatDate, formatRM } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { useNavigate } from "react-router-dom";
import {
  Truck,
  Package,
  PackageCheck,
  Send,
  CheckCircle2,
  FileText,
  ClipboardList,
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
  QrCode,
  Mail,
  Bot,
  Undo2,
} from "lucide-react";
import DeliveryAgentTab from "./agent-tab";
import type { DeliveryOrder, ProofOfDelivery, ThreePLProvider, Customer } from "@/types";
import PODDialog from "@/components/delivery/POD-dialog";
import DoQrDialog from "@/components/delivery/do-qr-dialog";
import { fetchDoQrDataUrl } from "@/lib/do-qr";
import PrintDO from "@/components/delivery/print-do";
import type { PrintDOData, PrintMode } from "@/components/delivery/print-do";
import { compareDoLinesByCustomerPO } from "@/lib/do-item-order";
import { fetchJson, FetchJsonError } from "@/lib/fetch-json";
import { verifiedSave, formatMismatchError } from "@/lib/verified-save";
import { mutationWithData, MutationResultSchema } from "@/lib/schemas/common";
import { DeliveryOrderSchema } from "@/lib/schemas/delivery-order";
import { SalesOrderSchema } from "@/lib/schemas/sales-order";
import {
  isHbOnlySpecial,
  pickRelevantUphCards,
  poInPlanning,
  poReadyForDelivery,
} from "@/lib/delivery-pipeline";
import { MALAYSIA_STATES, resolveStateCode } from "@/lib/malaysia-states";
import { aggregateRacksFromPackingCards } from "@/lib/rack-format";

const DOMutationSchema = mutationWithData(DeliveryOrderSchema);
const SOMutationSchema = mutationWithData(SalesOrderSchema);

// ---------------------------------------------------------------------------
// EditableExpectedDD — shared inline cell for the "Expected DD" (Hookka
// Expected Delivery Date) column on the Planning and Pending Delivery boards.
//
// NO naked edits: the cell shows the date read-only with a pencil affordance.
// Clicking it enters an edit state holding a LOCAL draft; the PUT only fires on
// an explicit ✓ Save (✕ cancels, Escape cancels). It never commits on blur, so
// a stray click-away can't silently mutate a delivery date. Errors are surfaced
// by the parent's onSave (toast + optimistic revert).
// ---------------------------------------------------------------------------
function EditableExpectedDD({
  row,
  onSave,
}: {
  row: { id: string; salesOrderId: string; hookkaExpectedDD: string | null };
  onSave: (salesOrderId: string, newDate: string, rowId: string, prevDate: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(row.hookkaExpectedDD ? row.hookkaExpectedDD.slice(0, 10) : "");
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setSaving(false);
  };
  const commit = () => {
    // Deliberate Save only. No-op when blank or unchanged.
    if (!draft || draft === (row.hookkaExpectedDD ? row.hookkaExpectedDD.slice(0, 10) : "")) {
      cancel();
      return;
    }
    setSaving(true);
    onSave(row.salesOrderId, draft, row.id, row.hookkaExpectedDD ?? null);
    setEditing(false);
    setSaving(false);
  };

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <input
          type="date"
          autoFocus
          value={draft}
          disabled={saving}
          className="h-7 w-[120px] text-xs rounded border border-[#E2DDD8] px-1.5 focus:outline-none focus:border-[#6B5C32]"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
        />
        <button
          type="button"
          title="Save"
          aria-label="Save Expected DD"
          disabled={saving}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-[#3F7D3A] hover:bg-[#EAF3EA] disabled:opacity-50"
          onClick={commit}
        >
          <Save className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Cancel"
          aria-label="Cancel editing Expected DD"
          disabled={saving}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-[#6B7280] hover:bg-[#F0EDEA] disabled:opacity-50"
          onClick={cancel}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }

  const isOverdue = row.hookkaExpectedDD && new Date(row.hookkaExpectedDD) < new Date();
  return (
    <span className="group inline-flex items-center gap-1">
      <span className={isOverdue ? "text-[#9A3A2D] font-medium" : "text-[#1F1D1B]"}>
        {row.hookkaExpectedDD ? formatDate(row.hookkaExpectedDD) : <span className="text-[#9CA3AF]">—</span>}
      </span>
      <button
        type="button"
        title="Edit Expected DD"
        aria-label="Edit Expected DD"
        className="inline-flex h-6 w-6 items-center justify-center rounded text-[#9CA3AF] opacity-0 transition-opacity hover:bg-[#F0EDEA] hover:text-[#6B5C32] group-hover:opacity-100 focus:opacity-100"
        onClick={startEdit}
      >
        <Pencil className="h-3 w-3" />
      </button>
    </span>
  );
}

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
  // Partial-repair scope (raw JSON) for the "Repair: <parts> (code)" badge.
  repairScope?: string | null;
  // Per-row customer references — each item resolves to its OWN sales order
  // (a DO can consolidate several SOs on one truck), so every line carries
  // its own customer PO / SO / Ref instead of one DO-level summary.
  customerPOId: string;
  customerSO: string;
  customerRef: string;
};

type DeliveryOrderRow = {
  id: string;           // DO id (for API calls + row key)
  doNo: string;
  companySO: string;
  customerPOId: string;
  // Customer-side reference numbers, joined client-side from the already-
  // loaded /api/sales-orders list via salesOrderId (NOT on the DO payload).
  // customerRef = sales_orders.reference (the customer's own ref string);
  // customerSO  = sales_orders.customerSO (the customer's own SO number).
  // Empty string when the linked SO has none / the SO isn't in the list.
  customerRef: string;
  customerSO: string;
  salesOrderId: string;
  // Distinct SO numbers this DO covers (from items), deduped + comma-joined.
  // Kept as a scalar field — NOT just computed inside the column render — so
  // the grid's global search + sort can match on it. Without this, searching
  // an SO number never hit the "Sales Orders" column (Wei Siang 2026-05-29:
  // searching "098" missed DO-2605-039 which clearly lists SO-2604-098,
  // because the search reads row.salesOrderNos which didn't exist).
  salesOrderNos: string;
  customerId: string;
  customerName: string;
  hubBranch: string;    // customerState (legacy fallback — kept for old DOs that have customerState set but no hubId)
  hubState: string;     // delivery_hubs.state resolved via hubId on the API; preferred display in the State column when present
  hubName: string;      // delivery_hubs.name resolved via hubId on the API; used as the destination title on the consolidated packing list
  itemCount: number;    // number of items in this DO
  totalM3: number;
  valueSen: number;     // Sales Figure — linked SO line value (server-derived; delivery_orders has no monetary column)
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
  // Invoice this DO was transferred to (invoices.deliveryOrderId = do.id, one
  // invoice per DO). Returned by the DO list endpoint; shown as "Transfer To"
  // on the Delivered tab. Empty string when no invoice references the DO yet.
  invoiceNo: string;
};

// A saved packing list (one truck run grouping several DOs). Mirrors the
// /api/packing-lists response shape.
type PackingListRecord = {
  id: string;
  packingNo: string;
  status: string;
  doIds: string[];
  stopCount: number;
  totalUnits: number;
  totalM3: number;
  remarks: string;
  createdAt: string | null;
  createdBy: string | null;
  // Computed live by GET /api/packing-lists: revenueSen = Σ goods value of the
  // PL's DOs; costSen = the one-trip 3PL transport cost (null when no rate).
  revenueSen: number;
  costSen: number | null;
  // Live: how many DOs the PL carries, and how many DISTINCT delivery
  // addresses (= real truck stops — several DOs to one address are ONE stop).
  // null when not computed; fall back to the stored stopCount (legacy DO count).
  doCount: number | null;
  stops: number | null;
  // Distinct delivery states across the PL's DOs (e.g. ["KL"] or
  // ["KL","PG"]); null when not computed.
  states: string[] | null;
  // Live per-status DO tally (pending = DRAFT, dispatched = LOADED +
  // IN_TRANSIT, delivered = DELIVERED + INVOICED; CANCELLED counts toward
  // none). Drives the Delivery chip + the PL-level bulk status buttons.
  doStatusCounts: {
    pending: number;
    dispatched: number;
    delivered: number;
  } | null;
};

// One row of the Packing-List-first grouping preview — mirrors the `groups`
// payload of POST /api/delivery-orders/packing-list-first (preview: true).
// Each group becomes ONE delivery order (one customer + one hub).
type PlFirstPreviewGroup = {
  customerId: string;
  customerName: string;
  hubId: string;
  hubName: string;
  customerState: string;
  poCount: number;
  unitCount: number;
  poNos: string[];
};

// Cap (m³) auto-fills from the cargo box dimensions — exact ft³ → m³
// conversion (1 ft = 0.3048 m, so ×0.028316846592). Owner spec 2026-06-11:
// fill all three FEET fields and the m³ computes itself (e.g. 17 × 7.2 ×
// 7.2 ft → 24.95 m³); Cap stays hand-editable while any dimension is
// missing, and a later manual Cap edit is overwritten only when a dimension
// changes again.
function withAutoCap<
  T extends {
    boxLengthFt: string;
    boxWidthFt: string;
    boxHeightFt: string;
    capacityM3: string;
  },
>(f: T): T {
  const L = Number(f.boxLengthFt);
  const W = Number(f.boxWidthFt);
  const H = Number(f.boxHeightFt);
  if (
    f.boxLengthFt !== "" &&
    f.boxWidthFt !== "" &&
    f.boxHeightFt !== "" &&
    isFinite(L) && L > 0 &&
    isFinite(W) && W > 0 &&
    isFinite(H) && H > 0
  ) {
    return { ...f, capacityM3: (L * W * H * 0.028316846592).toFixed(2) };
  }
  return f;
}

// ---------------------------------------------------------------------------
// Map real DeliveryOrder from API to one row per DO
// ---------------------------------------------------------------------------

function mapDOToRow(
  d: DeliveryOrder,
  // SO id -> { customerSO, reference }. Built once from the already-loaded
  // /api/sales-orders list (see useEffect below) so the grid can show the
  // customer's own SO + reference per DO without any new backend route.
  soRefMap?: Map<
    string,
    { customerSO: string; reference: string; customerPO: string }
  >,
): DeliveryOrderRow {
  // Status passes through unchanged. The previous code aliased backend
  // "LOADED" → frontend "DISPATCHED" which decoupled the type from
  // VALID_TRANSITIONS and made it impossible to wire the LOADED →
  // IN_TRANSIT button (you'd need to map back at PUT time). Now the
  // wire-shape and UI-shape are the same string; only the rendered
  // label differs (see STATUS_LABEL.LOADED = "Dispatched").
  const status = d.status as DOStatus;

  const items: DOItem[] = (d.items || []).map((i) => {
    const soNo =
      ((i as Record<string, unknown>).salesOrderNo as string) ||
      d.companySO ||
      "";
    // Resolve THIS line's own customer PO / SO / Ref from its sales order.
    const ref = soRefMap?.get(soNo);
    return {
      id: i.id,
      productionOrderId: i.productionOrderId || "",
      salesOrderNo: soNo,
      poNo: i.poNo || "",
      productCode: i.productCode || "",
      productName: i.productName || "",
      sizeLabel: i.sizeLabel || "",
      fabricCode: i.fabricCode || "",
      quantity: i.quantity || 0,
      itemM3: i.itemM3 || 0,
      rackingNumber: i.rackingNumber || "",
      repairScope:
        ((i as Record<string, unknown>).repairScope as string) || null,
      customerPOId: ref?.customerPO || "",
      customerSO: ref?.customerSO || "",
      customerRef: ref?.reference || "",
    };
  });

  // A DO can span several SOs (one truck consolidating multiple orders).
  // Resolve customer PO / SO / Ref across EVERY SO the DO touches —
  // exactly the distinct set the "Sales Orders" column lists — deduped
  // and comma-joined, instead of only the single header salesOrderId
  // (which is blank on multi-SO DOs, leaving the columns empty).
  const _soNos = Array.from(
    new Set(items.map((i) => i.salesOrderNo).filter(Boolean)),
  );
  const _aggr = (
    pick: (v: { customerSO: string; reference: string; customerPO: string }) => string,
  ): string => {
    const vals = Array.from(
      new Set(
        _soNos
          .map((n) => soRefMap?.get(n))
          .filter((v): v is NonNullable<typeof v> => Boolean(v))
          .map(pick)
          .filter(Boolean),
      ),
    );
    if (vals.length) return vals.join(", ");
    const single = soRefMap?.get(d.salesOrderId || "");
    return single ? pick(single) : "";
  };

  return {
    id: d.id,
    doNo: d.doNo,
    companySO: d.companySO || "",
    customerPOId: _aggr((v) => v.customerPO) || d.customerPOId || "",
    customerRef: _aggr((v) => v.reference),
    customerSO: _aggr((v) => v.customerSO),
    salesOrderId: d.salesOrderId || "",
    // Same distinct set the "Sales Orders" column renders — exposed as a
    // scalar so global search/sort can match SO numbers (see type comment).
    salesOrderNos: _soNos.join(", "),
    customerId: d.customerId || "",
    customerName: d.customerName || "",
    hubBranch: d.customerState || "",
    hubState: ((d as Record<string, unknown>).hubState as string) || "",
    hubName: ((d as Record<string, unknown>).hubName as string) || "",
    itemCount: items.length,
    totalM3: d.totalM3 ?? 0,
    valueSen: d.valueSen ?? 0,
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
    invoiceNo: ((d as Record<string, unknown>).invoiceNo as string) || "",
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

// Delivery workflow tabs. The old "Invoice" tab was removed (2026-05-18):
// it only ever showed DOs whose status = INVOICED and was always empty/
// confusing — auto-created invoices stay DRAFT and the DO stays DELIVERED,
// so the bucket read 0 forever. Invoices are tracked on the Invoices page.
const ALL_TABS = [
  { key: "planning", label: "Planning" },
  { key: "pending_delivery", label: "Pending Delivery" },
  { key: "pending_dispatch", label: "Pending Dispatch" },
  { key: "dispatched", label: "Dispatched" },
  { key: "delivered", label: "Delivered" },
  { key: "packing_list", label: "Packing List" },
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
  // "Delivered" keeps INVOICED rows too (Wei Siang 2026-06-15): once a
  // delivered DO is converted to an invoice it flips to INVOICED — without
  // this it vanished from the Delivered tab, losing the delivery record. A
  // delivered-AND-invoiced DO is still a delivered DO, so it stays here.
  delivered: ["DELIVERED", "INVOICED"],
};

// PO-based tabs (show production orders, not delivery orders)
const PO_TABS = new Set(["planning", "pending_delivery"]);

// Identifier keys that must stay searchable on every delivery grid even when
// the operator hides that column via the "Columns" menu. Passed to DataGrid's
// `alwaysSearchKeys` so a DO/PO is always findable by SO no., customer
// PO/SO/Ref, DO no., customer name, or vehicle plate. Module-scoped so the
// array reference is stable across renders (keeps DataGrid's filter memo warm).
const DO_SEARCH_KEYS = [
  "doNo",
  "companySO",
  "salesOrderNos",
  "customerPOId",
  "customerSO",
  "customerRef",
  "customerName",
  "vehicleNo",
];
const PO_SEARCH_KEYS = [
  "salesOrderNo",
  "poNo",
  "customerPOId",
  "customerReference",
  "customerSO",
  "customerName",
];

// Reverse of TAB_DO_STATUSES: which DO tab a given status lives on. Derived
// from the one map above so the two can never drift apart. INVOICED now maps
// to the "delivered" tab (see above), so searching an invoiced DO jumps there.
const TAB_FOR_STATUS: Partial<Record<DOStatus, string>> = (() => {
  const m: Partial<Record<DOStatus, string>> = {};
  for (const [tab, statuses] of Object.entries(TAB_DO_STATUSES)) {
    for (const s of statuses) m[s] = tab;
  }
  return m;
})();

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
  // Customer-side reference numbers (all already returned by
  // /api/production-orders — see ProductionOrderApiShape note).
  // customerPOId = production_orders.customerPOId (customer's PO no.);
  // customerReference = production_orders.customerReference (customer ref);
  // customerSO = sales_orders.customerSO joined server-side.
  customerPOId: string;
  customerReference: string;
  customerSO: string;
  customerId: string;
  customerName: string;
  customerState: string;
  productCode: string;
  productName: string;
  itemCategory: string;          // SOFA / BEDFRAME / ACCESSORY — drives the SO ID display rule
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  // Service-order Repair Scope snapshot (raw JSON) — drives the "Repair: <parts>
  // (code)" badge next to the product name on partial-repair rows. null on a
  // normal sales PO.
  repairScope: string | null;
  valueSen: number;              // Sales Figure — this PO's SO line value (SO unit price × qty)
  unitM3: number;                // per-unit volume from /api/products (Products page · Unit M³)
  completedDate: string | null;
  uphCompletedDate: string | null;
  // Latest PACKING job-card completion — only set when EVERY packing card on
  // the PO is done. Date present = fully packed; blank = not packed yet (the
  // Ready-for-DO gate stays on UPHOLSTERY, this column just surfaces packing).
  packingCompletedDate: string | null;
  rackingNumber: string;
  hookkaExpectedDD: string;
  currentDepartment: string;
  progress: number;
  // Sibling-set check (added 2026-05-06) — only meaningful for SOFA rows.
  // setTotalSiblings: total active POs of this row's parent SO (excludes
  // CANCELLED / already-in-DO / consignment); setReadySiblings: subset of
  // those whose upholstery JCs are all COMPLETED. setComplete = the entire
  // sofa set is ready to ship as one unit. When false on a SOFA row, the
  // grid disables selection so an operator can't accidentally Create DO
  // with a partial set (user pain point: shipped 3 of 5 compartments
  // because the other 2 weren't visible in Pending Delivery).
  // BF/ACC rows ship independently per piece — no sibling concern, fields
  // default to total=1, ready=1, complete=true.
  setTotalSiblings: number;
  setReadySiblings: number;
  setComplete: boolean;
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
  // Migration 0064: a PO can come from a Consignment Order instead of a
  // Sales Order (mutex). Surfaced so the delivery page can route CO POs
  // to the CN flow rather than the DO flow.
  consignmentOrderId?: string;
  companyCOId?: string;
  // Customer-side reference numbers. /api/production-orders already returns
  // all three: customerPOId + customerReference come straight off
  // production_orders; customerSO is batch-joined from sales_orders.customerSO
  // by attachCustomerSO() at the route boundary (CO POs fall back to the
  // consignment customer-CO no.). No backend change needed to surface them.
  customerPOId?: string;
  customerReference?: string;
  customerSO?: string;
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
  // Mirrored from production_orders.specialOrder so the HB-only completion
  // gate stays in step with the backend (cascadeUpholsteryToSO drops DIVAN
  // UPH JCs from the readiness check when this contains "Headboard Only").
  specialOrder?: string;
  // Service-order Repair Scope snapshot (0160). poInPlanning /
  // poReadyForDelivery key their no-UPHOLSTERY fallback on it.
  repairScope?: string | null;
  // wipType lets us identify DIVAN UPHOLSTERY rows for the HB-only filter
  // — see isHbOnlySpecial / pickRelevantUphCards below. wipLabel +
  // rackingNumber are the per-PACKING-card fields the Rack column aggregates:
  // /api/production-orders?fields=minimal&include=jobCards already emits them
  // per card (rowToMinimalJobCard), so the per-piece rack ("Rack 3, 4") comes
  // straight off the payload — no reliance on the lossy production_orders mirror.
  jobCards?: {
    departmentCode: string;
    status: string;
    completedDate?: string | null;
    wipType?: string;
    wipLabel?: string;
    rackingNumber?: string;
  }[];
};

// isHbOnlySpecial / pickRelevantUphCards / poInPlanning / poReadyForDelivery
// / buildLinkedPOIds now live in src/lib/delivery-pipeline.ts so the
// dashboard's "Pending Delivery" card and this page's "Pending Delivery"
// tab share ONE gate and can never drift apart.

// ---------------------------------------------------------------------------
// Customer goods-movement notices (2026-06-11). After a SUCCESSFUL status
// transition, the page fires POST /api/delivery-orders/:id/notify-customer:
//   * → LOADED:    dispatch notice with the REAL branded DO PDF attached
//     (same generateDOPdf path the Print buttons use).
//   * → DELIVERED: invoice notice with the REAL branded Invoice PDF attached
//     (same generateInvoicePdf path the Invoice page uses); when the client
//     PDF can't be produced, the backend attaches a server-rendered simple
//     invoice PDF instead.
// Strictly fire-and-forget: every failure here is swallowed — an email must
// NEVER block, slow, or roll back the delivery flow. The backend owns the
// recipient rules (hub/customer email chains), the idempotency stamps, and
// every number (doNo / dates / invoice row); this side only contributes the
// PDF plus display fields derived from ONE fetched print-extras object — the
// same object that feeds the attached PDF, so email and PDF cannot diverge.
// ---------------------------------------------------------------------------
// Render the DELIVERED invoice notice PDF (the SAME unified generator the
// Invoice page downloads) for a delivered DO — find its live invoice, pull the
// invoice + print-extras, render to base64. Returns {} on any failure so the
// caller falls back to the backend's own server-rendered invoice. Shared by
// the auto-notice (sendCustomerNotice) AND the manual Re-send so both attach
// the exact same document.
async function renderDeliveredInvoicePdf(
  doId: string,
  customerId: string,
): Promise<{ pdfBase64?: string; pdfFilename?: string }> {
  try {
    const lr = await fetch(
      `/api/invoices?customerId=${encodeURIComponent(customerId)}&_v=${Date.now()}`,
      { cache: "no-store" },
    );
    const lj = (await lr.json()) as {
      success?: boolean;
      data?: Array<{
        id: string;
        invoiceNo: string;
        deliveryOrderId?: string;
        status?: string;
        createdAt?: string;
      }>;
    };
    const slim = (lj?.success ? (lj.data ?? []) : [])
      .filter((inv) => inv.deliveryOrderId === doId && inv.status !== "CANCELLED")
      .sort((a, b) =>
        String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
      )[0];
    if (!slim) return {};
    const [ir, er] = await Promise.all([
      fetch(`/api/invoices/${encodeURIComponent(slim.id)}`),
      fetch(`/api/invoices/${encodeURIComponent(slim.id)}/print-extras`),
    ]);
    const ij = (await ir.json()) as {
      success?: boolean;
      data?: import("@/types").Invoice;
    };
    const ej = (await er.json().catch(() => ({}))) as {
      success?: boolean;
      data?: import("@/lib/generate-invoice-pdf").InvoicePrintExtras;
    };
    const invoice = ij?.success ? ij.data : undefined;
    if (!invoice) return {};
    // Email the SAME jsPDF the operator prints. The pdf-lib "unified" render
    // was a second engine that looked different from Print ("歪", owner
    // 2026-07-04); generateInvoicePdfBase64 IS exactly what the Print button
    // produces, so the customer now receives what the operator sees.
    const { generateInvoicePdfBase64 } = await import(
      "@/lib/generate-invoice-pdf"
    );
    return {
      pdfBase64: generateInvoicePdfBase64(
        invoice,
        ej?.success ? ej.data : undefined,
      ),
      pdfFilename: `INV-${invoice.invoiceNo}.pdf`,
    };
  } catch {
    return {};
  }
}

async function sendCustomerNotice(
  row: DeliveryOrderRow,
  kind: "DISPATCHED" | "DELIVERED",
): Promise<"queued" | "skipped" | "failed"> {
  try {
    let pdfBase64: string | undefined;
    let pdfFilename: string | undefined;
    let itemsBreakdown: string | undefined;
    let customerPOIds: string[] | undefined;

    if (kind === "DISPATCHED") {
      let extras: import("@/lib/generate-do-pdf").DOPrintExtras = {};
      try {
        const r = await fetch(
          `/api/delivery-orders/${encodeURIComponent(row.id)}/print-extras`,
        );
        const j = (await r.json()) as {
          success?: boolean;
          data?: import("@/lib/generate-do-pdf").DOPrintExtras;
        };
        if (j?.success && j.data) extras = j.data;
      } catch {
        /* graceful — the notice still goes out without the breakdown */
      }
      const { buildDoComponentBreakdown, collectCustomerPOIds } = await import(
        "@/lib/do-component-breakdown"
      );
      itemsBreakdown = buildDoComponentBreakdown(row.items, extras);
      customerPOIds = collectCustomerPOIds(row.items, extras, row.customerPOId);
      try {
        // Email the SAME jsPDF the operator prints (owner 2026-07-04: the
        // pdf-lib email version looked different/"歪"). Same row + extras the
        // Print-DO handler passes — no delivery QR on the customer email.
        const { generateDoPdfBase64 } = await import("@/lib/generate-do-pdf");
        pdfBase64 = generateDoPdfBase64(
          row as unknown as import("@/types").DeliveryOrder,
          extras,
        );
        pdfFilename = `${row.doNo.startsWith("DO-") ? row.doNo : `DO-${row.doNo}`}.pdf`;
      } catch {
        /* graceful — backend sends the notice without the attachment */
      }
    } else {
      // DELIVERED — find the DO's live invoice (auto-created by the DELIVERED
      // cascade, committed before this runs) and render the real unified
      // invoice PDF. Any failure → {} → POST without pdfBase64 and let the
      // backend attach its server-rendered fallback.
      const rendered = await renderDeliveredInvoicePdf(row.id, row.customerId);
      pdfBase64 = rendered.pdfBase64;
      pdfFilename = rendered.pdfFilename;
    }

    const r = await fetch(
      `/api/delivery-orders/${encodeURIComponent(row.id)}/notify-customer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          pdfBase64,
          pdfFilename,
          itemsBreakdown,
          customerPOIds,
        }),
      },
    );
    const j = (await r.json().catch(() => ({}))) as {
      queued?: boolean;
      skipped?: boolean;
    };
    if (r.ok && j?.queued) return "queued";
    if (r.ok && j?.skipped) return "skipped";
    return "failed";
  } catch {
    return "failed";
  }
}

export default function DeliveryPage() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const navigate = useNavigate();
  // Top-level "Orders" / "3PL" / "Agent" tab — URL-synced so refresh and
  // back/forward both keep the user where they were.
  const [pageTab, setPageTab] = useUrlState<"orders" | "3pl" | "agent">("section", "orders");
  const [deliveryOrders, setDeliveryOrders] = useState<DeliveryOrderRow[]>([]);
  // Whole-table search matches (across every status), populated only while a
  // search is active. Separate from deliveryOrders so the browse-derived
  // counts/lists stay correct during a search.
  const [searchResults, setSearchResults] = useState<DeliveryOrderRow[]>([]);
  const [planningPOs, setPlanningPOs] = useState<ReadyPORow[]>([]);
  const [readyPOs, setReadyPOs] = useState<ReadyPORow[]>([]);
  const [loading, setLoading] = useState(true);
  // Active inner tab — URL-synced for the same reason as pageTab above.
  const [activeTab, setActiveTab] = useUrlState<string>("tab", "planning");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detailDO, setDetailDO] = useState<DeliveryOrderRow | null>(null);
  // Per-line customer PO / SO no. for the open DO. The /api/sales-orders
  // list only carries the SO-header customerPO/customerSO (blank on most
  // orders); the authoritative per-line value lives on the production
  // order and is surfaced by /print-extras. Fetched when the modal opens.
  const [detailExtras, setDetailExtras] = useState<{
    forId: string;
    data: import("@/lib/generate-do-pdf").DOPrintExtras;
  } | null>(null);
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
  const [plRemarks, setPlRemarks] = useState("");
  const [plCreating, setPlCreating] = useState(false);
  // ---------- Packing-List-first (auto-split) ----------
  // "Create Packing List" on Pending Delivery: multi-select POs across
  // customers/hubs → preview the (customer, hub) grouping fetched from the
  // backend (the SAME grouping creation will use) → one confirm creates one
  // DRAFT DO per group + ONE packing list carrying them all. Reuses
  // createDOForm for the shared 3PL / vehicle / driver / date / remarks
  // fields so the provider→vehicle/driver list fetch effect serves both
  // dialogs (they are never open at the same time; both reset it on open).
  const [plFirstDialogOpen, setPlFirstDialogOpen] = useState(false);
  // null = preview still loading; [] = loaded but empty (shouldn't happen
  // with a non-empty selection).
  const [plFirstGroups, setPlFirstGroups] = useState<PlFirstPreviewGroup[] | null>(null);
  const [plFirstPreviewError, setPlFirstPreviewError] = useState<string | null>(null);
  const [plFirstCreating, setPlFirstCreating] = useState(false);
  // When set, the packing-list dialog is in EDIT mode (re-assign driver/lorry/
  // provider on an existing list) rather than CREATE mode. pendingDriverName
  // pre-selects the Driver dropdown once that provider's drivers load — the DO
  // only stores the driver's NAME, not the person id, so we re-match by name.
  const [editingPL, setEditingPL] = useState<PackingListRecord | null>(null);
  const [pendingDriverName, setPendingDriverName] = useState("");
  // Truck assignment for the packing list: 3PL provider → lorry + driver.
  // On Create these are written onto every DO in the run (overwrite), so each
  // hub's DO carries the right driver + lorry. plProviderId holds the 3PL
  // company id (mirrors the Create-DO form's legacy `driverId` slot).
  const [plProviderId, setPlProviderId] = useState("");
  const [plVehicleId, setPlVehicleId] = useState("");
  const [plDriverPersonId, setPlDriverPersonId] = useState("");
  const [plDialogVehicles, setPlDialogVehicles] = useState<ThreePLVehicle[]>([]);
  const [plDialogDrivers, setPlDialogDrivers] = useState<ThreePLDriverPerson[]>([]);
  const [invoiceDialog, setInvoiceDialog] = useState<DeliveryOrderRow | null>(null);
  const [podDialog, setPodDialog] = useState<DeliveryOrderRow | null>(null);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  // DO id whose customer invoice email is currently being re-sent (Feature A:
  // per-DO Resend). Drives the spinner + disables the Resend button.
  const [resendingId, setResendingId] = useState<string | null>(null);
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
    boxLengthFt: number | null;
    boxWidthFt: number | null;
    boxHeightFt: number | null;
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
    boxLengthFt: "", boxWidthFt: "", boxHeightFt: "",
  });
  const [driverEditing, setDriverEditing] = useState<ThreePLDriverPerson | "new" | null>(null);
  const [driverForm, setDriverForm] = useState({
    name: "", phone: "", status: "ACTIVE" as "ACTIVE" | "INACTIVE", remarks: "",
  });

  // ----- 3PL State Rate Card (per-provider, per-state pricing) -----
  // Fixed 16-row grid keyed by canonical state code; values are RM strings
  // ("" = unset, mirrors the 0/0-in-sen house rule). Loaded from
  // GET /api/three-pl-state-rates?providerId=..., saved wholesale via
  // PUT /api/three-pl-state-rates/bulk. ratesDirty powers the same
  // "unsaved sub-form" guard the Vehicles / Drivers inline editors get
  // in saveProvider.
  type ProviderDialogTab = "info" | "rates" | "fleet" | "drivers";
  const [providerDialogTab, setProviderDialogTab] = useState<ProviderDialogTab>("info");
  const emptyRateGrid = () =>
    Object.fromEntries(
      MALAYSIA_STATES.map((s) => [s.code, { trip: "", drop: "" }]),
    ) as Record<string, { trip: string; drop: string }>;
  const [stateRates, setStateRates] = useState<Record<string, { trip: string; drop: string }>>(emptyRateGrid);
  const [ratesLoading, setRatesLoading] = useState(false);
  const [ratesSaving, setRatesSaving] = useState(false);
  const [ratesDirty, setRatesDirty] = useState(false);

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
  // Mirror of customersData kept in a ref so the email lookup is correct even
  // from a memoized closure (the row context menu is built via
  // useCallback([fetchData]) and would otherwise capture a stale/empty list).
  const customersDataRef = useRef<Customer[]>([]);
  useEffect(() => {
    customersDataRef.current = customersData;
  }, [customersData]);
  // Open-DO customer email, from STATE (not the ref) so the detail "Resend
  // invoice email" button reads it WITHOUT a ref-access-during-render (the
  // react-hooks/refs lint). Empty when no DO is open / no email on file.
  const detailEmail = useMemo(
    () =>
      detailDO
        ? (
            customersData.find((cu) => cu.id === detailDO.customerId)?.email ??
            ""
          ).trim()
        : "",
    [detailDO, customersData],
  );

  // ----- Inline Expected DD editing -----
  // Per-cell draft + edit state now lives inside EditableExpectedDD (no naked
  // edits: it commits only on an explicit Save). Nothing shared at this level.

  // ---------- Pagination (DO list only) ----------
  // Server-side pagination for the DO fetch; PO-based tabs (planning,
  // pending_delivery) and the other sibling fetches (POs, SOs, customers)
  // remain full-set and unaffected.
  // 200 — same rationale as sales/invoices: big enough that daily working
  // set fits on page 1 so search works normally.
  const PAGE_SIZE = 200;
  const [page, setPage] = useUrlStateNumber("page", 1);
  // Mirrors the DO grid's global search box (fed via DataGrid onSearchChange).
  // Drives cross-status search: while non-empty, filteredOrders spans every
  // status instead of just the active tab, so a DO is findable regardless of
  // which stage/tab it sits on.
  // ONE search state shared by every delivery tab (Planning, Pending Delivery,
  // and the three DO tabs). Unified so a term typed on any tab drives the same
  // server fetch + cross-tab jump, and clearing the box on ANY tab fully resets
  // the page. (The old split poGridSearch/doGridSearch left the server fetch
  // stuck filtered when you cleared on a tab different from where you typed.)
  const [search, setSearch] = useState("");

  // ---------- Fetch ----------
  // Browse load — ALWAYS paginated, NEVER search-filtered. This is the set the
  // page derives from: linkedPOIds (→ Pending Delivery / readyPOs), deliveredMTD,
  // tab counts. It must stay whole regardless of search, or POs already on
  // other DOs wrongly resurface as "ready" the moment you type a search term.
  const { data: doRaw, loading: doLoading, refresh: refreshDOs } = useCachedJson<{
    success?: boolean;
    data?: DeliveryOrder[];
    page?: number;
    limit?: number;
    total?: number;
  }>(`/api/delivery-orders?page=${page}&limit=${PAGE_SIZE}`);
  // Search load — SEPARATE from the browse load so it never disturbs the
  // derivations above. When the operator is searching, hit the server with the
  // term (high limit) so matches come from the WHOLE table across every status,
  // not just the current 200-row browse page. Skipped entirely when not
  // searching (null URL → no fetch). Feeds only the grid + cross-tab jump.
  const doServerSearch = search.trim();
  const { data: doSearchRaw } = useCachedJson<{
    success?: boolean;
    data?: DeliveryOrder[];
    total?: number;
  }>(
    doServerSearch
      ? `/api/delivery-orders?search=${encodeURIComponent(doServerSearch)}&limit=2000`
      : null,
  );
  // Whole-dataset status bucket counts — summary cards and tab badges read
  // from this so counts reflect the full table, not just the current
  // paginated page.
  const { data: doStatsRaw, refresh: refreshDOStats } = useCachedJson<{
    success?: boolean;
    byStatus?: Record<string, number>;
    valueByStatus?: Record<string, number>;
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
  // 2026-05-12 perf: fields=minimal drops piece_pics + ~20 unused PO fields
  // from the response. include=jobCards keeps the per-PO JC array (DO page
  // needs uph JC statuses to compute Planning vs Pending Delivery). Cuts
  // the response from 2-6 MB to 200-600 KB.
  // perf 2026-07-13: Planning + "Ready for DO" are now computed SERVER-SIDE
  // (GET /api/delivery-orders/ready-planning runs the SHARED buildReadyPlanning
  // from src/lib/delivery-pipeline.ts — the SAME code the client pipeline below
  // used, so the rows are byte-identical). The page no longer pulls the ~1.2MB
  // /api/production-orders?fields=minimal&include=jobCards payload just to derive
  // these two lists — it fetches the small { ready, planning } result instead.
  const { data: rpRaw, loading: poLoading, refresh: refreshPOs } = useCachedJson<{ success?: boolean; ready?: ReadyPORow[]; planning?: ReadyPORow[] }>("/api/delivery-orders/ready-planning");
  // Slim projection: this page joins Customer PO/SO + reference + expected-DD
  // onto DO rows, plus a per-SO {productCode → unitPriceSen} price map for the
  // PO-based Planning / Pending Delivery Sales-Figure fallback. ?fields=
  // delivery-refs serves the SAME cached snapshot down to just those ref
  // scalars + SLIM items (product code + unit price only — no scan image, no
  // other line fields) — the full list was ~1.4MB; the slim variant is a
  // fraction of that.
  const { data: soRaw, loading: soLoading, refresh: refreshSOs } = useCachedJson<{ success?: boolean; data?: { id: string; hookkaExpectedDD?: string; companySOId?: string; customerId?: string; customerSO?: string; customerSOId?: string; customerPO?: string; customerPOId?: string; reference?: string; items?: { productCode?: string; unitPriceSen?: number }[] }[] }>("/api/sales-orders?fields=delivery-refs");
  // Exact per-PO Sales Figure from the server (same resolver the DO /
  // invoice path uses) so Planning / Pending Delivery reconcile to the
  // cent instead of the page guessing price by product code.
  const { data: poValRaw, refresh: refreshPoVals } = useCachedJson<{ success?: boolean; values?: Record<string, number> }>("/api/delivery-orders/po-values");
  // Authoritative "already on a DO" set from the WHOLE table — not just the
  // current 200-row browse page. The paginated doRaw missed POs delivered on
  // older off-page DOs, so they wrongly resurfaced as Pending Delivery
  // (BUG-2026-06-27, e.g. SO-2603-157 delivered on March DOs).
  const { data: linkedRaw } = useCachedJson<{ success?: boolean; poIds?: string[] }>("/api/delivery-orders/linked-po-ids");
  const { data: custRaw, loading: custLoading, refresh: refreshCustomers } = useCachedJson<{ success?: boolean; data?: Customer[] }>("/api/customers");
  // Pull product master data so each Planning / Pending Delivery row can
  // surface its per-unit m³ next to the qty. Source-of-truth is the
  // Products page (`unitM3` column) — fetching the same /api/products
  // payload here keeps the value in lockstep with whatever the user last
  // edited there.
  const { data: prodRaw, loading: prodLoading, refresh: refreshProducts } =
    useCachedJson<{ success?: boolean; data?: { code: string; unitM3: number }[] }>("/api/products");
  // Saved packing lists (one per truck run, grouping several DOs). Populates
  // the "Packing List" tab. Defaults to empty if the endpoint/table isn't
  // ready so it never blocks the delivery page.
  // Perf 2026-07-14: DEFERRED off the default Planning/Pending-Delivery landing.
  // packingLists feeds only the DO grid's "already in PL" marks (doPackingMap) +
  // the Packing List tab render + its badge — all governed by activeTab and none
  // of them on the PO_TABS (planning / pending_delivery). Passing null on those
  // two tabs skips the ~2.4s /api/packing-lists fetch until the operator leaves
  // Planning (any DO-grid or Packing-List tab loads it). No dead-data risk — the
  // PO-based Ready/Planning logic never reads packingLists.
  const { data: plRaw, refresh: refreshPLs } =
    useCachedJson<{ success?: boolean; data?: PackingListRecord[] }>(
      PO_TABS.has(activeTab) ? null : "/api/packing-lists",
    );

  const fetchData = useCallback(() => {
    invalidateCachePrefix("/api/delivery-orders");
    invalidateCachePrefix("/api/production-orders");
    invalidateCachePrefix("/api/sales-orders");
    invalidateCachePrefix("/api/customers");
    invalidateCachePrefix("/api/products");
    invalidateCachePrefix("/api/packing-lists");
    refreshDOs();
    refreshDOStats();
    refreshPOs();
    refreshSOs();
    refreshPoVals();
    refreshCustomers();
    refreshProducts();
    refreshPLs();
  }, [refreshDOs, refreshDOStats, refreshPOs, refreshSOs, refreshPoVals, refreshCustomers, refreshProducts, refreshPLs]);

  // Packing list records, mirrored from the SWR fetch.
  const packingLists: PackingListRecord[] = useMemo(
    () => (plRaw?.success && Array.isArray(plRaw.data) ? plRaw.data : []),
    [plRaw],
  );

  // Which packing list each DO already belongs to (doId → packingNo). Used to
  // mark already-grouped DOs on the grid (ticked + locked) so the operator
  // doesn't try to add them to another list and hit the "already in PL-xxx"
  // error.
  const doPackingMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const pl of packingLists) {
      for (const did of pl.doIds || []) m.set(did, pl.packingNo);
    }
    return m;
  }, [packingLists]);

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
    const sRes = doSearchRaw || { success: false };
    // Planning + Ready come from the server now (rpRaw). The old client-side
    // pipeline below is kept but INERT (poRes.success stays false so it never
    // runs) pending a follow-up dead-code cleanup — it's the source the shared
    // buildReadyPlanning was extracted from, left as a reference for one release.
    if (rpRaw?.success) {
      setPlanningPOs(rpRaw.planning ?? []);
      setReadyPOs(rpRaw.ready ?? []);
    }
    const poRes: { success?: boolean; data?: ProductionOrderApiShape[] } = {
      success: false,
    };
    const soRes = soRaw || { success: false };
    const custRes = custRaw || { success: false };
    // Exact server-computed value per production order (same resolver as
    // the DO/invoice path). Used for Planning / Pending Delivery so they
    // reconcile to the cent; falls back to the product-code estimate if
    // a PO isn't in the map yet.
    const poValMap = new Map<string, number>();
    if (poValRaw?.values) {
      for (const [k, v] of Object.entries(poValRaw.values))
        poValMap.set(k, Number(v) || 0);
    }
    {
      {
        // Store customers for hub address lookup
        if (custRes.success && Array.isArray(custRes.data)) {
          setCustomersData(custRes.data as Customer[]);
        }
        // SO id -> customer's own SO no. + reference, from the already-
        // loaded /api/sales-orders list. Lets the DO grids show "Customer
        // SO" / "Customer Ref" per row without a new backend route (the DO
        // payload doesn't carry these; only /print-extras did, one DO at a
        // time). Reused below for the PO-based Pending Delivery rows too.
        // Keyed by BOTH the SO primary id AND the company SO number
        // (companySOId, e.g. "SO-2604-323") so a DO that spans several
        // SOs can resolve each one from its items' salesOrderNo — the
        // same set the "Sales Orders" column lists.
        const soRefMap = new Map<
          string,
          { customerSO: string; reference: string; customerPO: string }
        >();
        if (soRes.success && Array.isArray(soRes.data)) {
          for (const so of soRes.data as {
            id: string;
            companySOId?: string;
            customerSO?: string;
            customerSOId?: string;
            customerPO?: string;
            customerPOId?: string;
            reference?: string;
          }[]) {
            // Prefer the *Id columns. sales_orders has two near-duplicate
            // fields for each (customerPO/customerPOId, customerSO/customerSOId):
            // when both are set they are identical (verified 0 conflicts), but
            // the *Id columns are far better populated (PO 681 vs 279, SO 511
            // vs 219 of 682 SOs). The grid + DO detail used to read the sparse
            // plain columns, so hundreds of DOs showed blank Customer PO/SO that
            // actually exist. Reading *Id first makes Customer PO findable on
            // 100% of DOs (133/133) and Customer SO on 96/133; the rest are
            // genuinely empty at source (customer never gave an SO number).
            const v = {
              customerSO: so.customerSOId || so.customerSO || "",
              reference: so.reference || "",
              customerPO: so.customerPOId || so.customerPO || "",
            };
            if (so.id) soRefMap.set(so.id, v);
            if (so.companySOId) soRefMap.set(so.companySOId, v);
          }
        }
        if (dRes.success && dRes.data) {
          const realRows = (dRes.data as DeliveryOrder[])
            .filter((d) => !d.id.startsWith("virt-"))
            .map((d) => mapDOToRow(d, soRefMap));
          setDeliveryOrders(realRows);
        }

        // Map the separate search payload with the SAME row mapper so the grid
        // and the cross-tab jump see fully-formed rows. Empty when not searching.
        if (sRes.success && Array.isArray(sRes.data)) {
          setSearchResults(
            (sRes.data as DeliveryOrder[])
              .filter((d) => !d.id.startsWith("virt-"))
              .map((d) => mapDOToRow(d, soRefMap)),
          );
        } else {
          setSearchResults([]);
        }

        if (poRes.success && Array.isArray(poRes.data)) {
          // Build SO lookup for hookkaExpectedDD + customerId
          const soMap = new Map<string, { hookkaExpectedDD: string; companySOId: string; customerId: string }>();
          // Wei Siang 2026-05-16: SO unit price per product code, so the
          // PO-based tabs (Planning / Pending Delivery) can show the same
          // Sales Figure the DO tabs do — value = SO unit price × PO qty.
          // Mirrors the DO value formula (productCode → SO unitPriceSen).
          const soPriceByProduct = new Map<string, Map<string, number>>();
          if (soRes.success && Array.isArray(soRes.data)) {
            for (const so of soRes.data as {
              id: string;
              hookkaExpectedDD?: string;
              companySOId?: string;
              customerId?: string;
              items?: { productCode?: string; unitPriceSen?: number }[];
            }[]) {
              soMap.set(so.id, {
                hookkaExpectedDD: so.hookkaExpectedDD || "",
                companySOId: so.companySOId || "",
                customerId: so.customerId || "",
              });
              const priceMap = new Map<string, number>();
              for (const it of so.items ?? []) {
                if (it.productCode)
                  priceMap.set(it.productCode, Number(it.unitPriceSen) || 0);
              }
              soPriceByProduct.set(so.id, priceMap);
            }
          }

          // Build the set of PO IDs already on a non-cancelled DO so the
          // "Production Complete — Ready for DO" list excludes them
          // (BUG-2026-04-27: previous SO-level dedup wrongly kept POs
          // visible whose SO's OTHER POs were on a multi-SO DO — the DO
          // stores only one representative salesOrderId, so SO-level
          // matching missed siblings carried via the items array).
          // BUG-2026-06-27: source this from the COMPLETE server endpoint
          // (/api/delivery-orders/linked-po-ids) instead of buildLinkedPOIds
          // over the capped 200-row browse page — older off-page DOs were
          // missed, so already-delivered POs wrongly resurfaced as pending.
          const linkedPOIds = new Set(linkedRaw?.poIds ?? []);

          const allPOs = poRes.data as ProductionOrderApiShape[];

          // ---------------------------------------------------------------
          // Sibling-set readiness map (added 2026-05-06).
          // For each SO we count how many of its active POs (not CANCELLED,
          // not in DO, not consignment) have ALL their upholstery JCs done.
          // The Pending Delivery grid uses this to flag SOFA rows that are
          // visually "ready" but whose set is INCOMPLETE — preventing the
          // operator from shipping a partial sofa (3 of 5 compartments
          // bug user hit 2026-05-06).
          // BF/ACC are independently shippable so we still compute but the
          // row defaults treat them as complete (set total/ready = 1).
          // ---------------------------------------------------------------
          const allUphDone = (po: ProductionOrderApiShape): boolean => {
            // HB-only BEDFRAME POs: ignore stranded DIVAN UPH cards so the
            // PO can register as ready once the HB UPH is packed. Mirrors
            // filterJcsForCompletionGate on the backend.
            const uph = pickRelevantUphCards(po);
            if (uph.length === 0) return false;
            return uph.every((j) => j.status === "COMPLETED" || j.status === "TRANSFERRED");
          };
          const siblingsBySo = new Map<string, { total: number; ready: number }>();
          for (const po of allPOs) {
            if (po.status === "CANCELLED") continue;
            if (po.consignmentOrderId) continue;
            if (linkedPOIds.has(po.id)) continue;
            const uphCards = pickRelevantUphCards(po);
            if (uphCards.length === 0) continue;
            const soId = po.salesOrderId || "";
            if (!siblingsBySo.has(soId)) siblingsBySo.set(soId, { total: 0, ready: 0 });
            const slot = siblingsBySo.get(soId)!;
            slot.total += 1;
            if (allUphDone(po)) slot.ready += 1;
          }

          const mapPO = (po: ProductionOrderApiShape): ReadyPORow => {
            const soInfo = soMap.get(po.salesOrderId || "");
            const isSofa = (po.itemCategory || "").toUpperCase() === "SOFA";
            // BF/ACC: each row is its own set (siblings don't matter for
            // shipping decisions). SOFA: pull the parent SO's tally.
            const sib = isSofa
              ? siblingsBySo.get(po.salesOrderId || "") ?? { total: 1, ready: 1 }
              : { total: 1, ready: 1 };
            // The relevant PACKING cards for this PO — one per top-level
            // component, each with its own rackingNumber. HB-only BEDFRAME
            // specials drop their stranded DIVAN card (it isn't shipping, so
            // its rack is not a load location). Computed ONCE: both the Packed
            // date and the per-piece Rack aggregation key off this same set.
            const hbOnlyPacking =
              (po.itemCategory || "").toUpperCase() === "BEDFRAME" &&
              isHbOnlySpecial(po.specialOrder);
            const packingCards = (po.jobCards ?? []).filter(
              (j) =>
                j.departmentCode === "PACKING" &&
                (!hbOnlyPacking || (j.wipType || "").toUpperCase() !== "DIVAN"),
            );
            return {
              id: po.id,
              poNo: po.poNo,
              salesOrderId: po.salesOrderId || "",
              salesOrderNo: po.companySOId || soInfo?.companySOId || po.salesOrderNo || "",
              // customerPOId + customerReference come straight off the PO.
              // customerSO is the server-joined value; fall back to the
              // SO-ref map (same /api/sales-orders list the DO grids use)
              // if the route-boundary join returned empty for this PO.
              customerPOId: po.customerPOId || "",
              customerReference: po.customerReference || "",
              customerSO:
                po.customerSO ||
                soRefMap.get(po.salesOrderId || "")?.customerSO ||
                "",
              customerId: po.customerId || soInfo?.customerId || "",
              customerName: po.customerName || "",
              customerState: po.customerState || "",
              productCode: po.productCode || "",
              productName: po.productName || "",
              itemCategory: po.itemCategory || "",
              sizeLabel: po.sizeLabel || "",
              fabricCode: po.fabricCode || "",
              quantity: po.quantity || 0,
              repairScope: po.repairScope ?? null,
              valueSen:
                poValMap.get(po.id) ??
                (soPriceByProduct
                  .get(po.salesOrderId || "")
                  ?.get(po.productCode || "") ?? 0) * (po.quantity || 0),
              unitM3: productM3Map.get(po.productCode || "") ?? 0,
              completedDate: po.completedDate || null,
              uphCompletedDate: (() => {
                // HB-only filter applied so the "uph completed" date
                // reflects the date the HB UPH cards finished, not a
                // null from a never-completed legacy DIVAN UPH card.
                const uphCards = pickRelevantUphCards(po);
                if (uphCards.length === 0) return null;
                // Find the latest completion date among upholstery cards
                const dates = uphCards.map(j => j.completedDate).filter((d): d is string => !!d);
                return dates.length > 0 ? dates.sort().reverse()[0] : null;
              })(),
              packingCompletedDate: (() => {
                // Packed = EVERY PACKING card done; show the latest packing
                // date. Any packing card still open ⇒ blank (not packed yet).
                // packingCards already drops HB-only specials' stranded DIVAN
                // card, same rule pickRelevantUphCards applies to UPH.
                if (packingCards.length === 0) return null;
                const allDone = packingCards.every(
                  (j) => j.status === "COMPLETED" || j.status === "TRANSFERRED",
                );
                if (!allDone) return null;
                const dates = packingCards
                  .map((j) => j.completedDate)
                  .filter((d): d is string => !!d);
                return dates.length > 0 ? dates.sort().reverse()[0] : null;
              })(),
              // Per-piece rack aggregation: a unit whose HB sits on Rack 3 and
              // DIVAN on Rack 4 shows "Rack 3, 4", not the lossy single rack
              // from production_orders.rackingNumber. Distinct racks across the
              // PACKING cards, numerically sorted, compact-formatted (shared
              // helper, same dedup/sort the DO PDF manifest uses). The DIVAN
              // drop is already baked into packingCards.
              rackingNumber: aggregateRacksFromPackingCards(packingCards),
              hookkaExpectedDD: soInfo?.hookkaExpectedDD || po.targetEndDate || "",
              currentDepartment: po.currentDepartment || "",
              progress: po.progress || 0,
              setTotalSiblings: sib.total,
              setReadySiblings: sib.ready,
              setComplete: sib.ready === sib.total,
            };
          };

          // Planning: POs still in production (upholstery not yet complete)
          // Excludes CO-sourced POs — those route to the Consignment Note
          // flow (parallel branch), not Delivery. Mirror of the same guard
          // on the Pending Delivery filter below; bug surfaced 2026-05-06
          // (CO POs were leaking into Delivery's Planning tab).
          const planning = allPOs.filter(poInPlanning).map(mapPO);
          setPlanningPOs(planning);

          // Pending Delivery: production complete, not yet on a real DO.
          // Exclude POs that came from a Consignment Order (have
          // consignmentOrderId set) - those route to the Consignment
          // Note flow, not the Delivery Order flow. Bug fix 2026-04-28
          // per user: a CO that finished production was wrongly
          // appearing in DO's "Ready for DO" list.
          // Only recompute once the authoritative linked-PO set has loaded —
          // otherwise an empty set would briefly flash EVERY complete PO as
          // pending before the exclusion arrives (BUG-2026-06-27 guard).
          if (linkedRaw !== undefined) {
            const ready = allPOs
              .filter((po) => poReadyForDelivery(po, linkedPOIds))
              .map(mapPO);
            setReadyPOs(ready);
          }
        }
      }
    }
  }, [doRaw, doSearchRaw, rpRaw, soRaw, poValRaw, custRaw, linkedRaw, doLoading, poLoading, soLoading, custLoading]);
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
    // Every open starts on the Info section with a clean rate grid; the
    // currentProviderId effect below loads the live card for existing rows.
    setProviderDialogTab("info");
    setStateRates(emptyRateGrid());
    setRatesDirty(false);
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
    // Same guard for the State Rate Card: edited cells only persist via the
    // card's own "Save Rates" button (PUT /bulk). Saving the provider here
    // closes the dialog, which would silently drop those edits.
    if (ratesDirty) {
      toast.error(
        "You have unsaved State Rates. Click 'Save Rates' inside the State Rate Card section first, or reopen the dialog to discard them.",
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
    if (!(await confirm({ title: "Delete provider", message: "Delete this 3PL provider?", danger: true }))) return;
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

  // Server returns one entry per canonical state (16 rows, lazily seeded).
  // sen → RM strings for the inputs; 0 renders as "" (blank = not served).
  type StateRateEntry = {
    state: string;
    ratePerTripSen: number;
    ratePerExtraDropSen: number;
  };
  const rateEntriesToGrid = useCallback((entries: StateRateEntry[]) => {
    const next = Object.fromEntries(
      MALAYSIA_STATES.map((s) => [s.code, { trip: "", drop: "" }]),
    ) as Record<string, { trip: string; drop: string }>;
    for (const r of entries) {
      if (next[r.state]) {
        next[r.state] = {
          trip: r.ratePerTripSen ? String(r.ratePerTripSen / 100) : "",
          drop: r.ratePerExtraDropSen ? String(r.ratePerExtraDropSen / 100) : "",
        };
      }
    }
    return next;
  }, []);

  const fetchProviderStateRates = useCallback(async (providerId: string) => {
    setRatesLoading(true);
    try {
      const res = await fetch(`/api/three-pl-state-rates?providerId=${providerId}`);
      const body = (await res.json()) as { success?: boolean; data?: StateRateEntry[] };
      if (body?.success && Array.isArray(body.data)) {
        setStateRates(rateEntriesToGrid(body.data));
        setRatesDirty(false);
      }
    } catch {
      /* swallow — grid stays blank, retry on next dialog open */
    }
    setRatesLoading(false);
  }, [rateEntriesToGrid]);

  const saveStateRates = async () => {
    if (!currentProviderId) return;
    setRatesSaving(true);
    // Blank / invalid input → 0 sen (unset). Backend re-validates: canonical
    // state codes only, non-negative integers (reject-don't-normalize).
    const rates = MALAYSIA_STATES.map((s) => ({
      state: s.code,
      ratePerTripSen: Math.round((Number(stateRates[s.code]?.trip) || 0) * 100),
      ratePerExtraDropSen: Math.round((Number(stateRates[s.code]?.drop) || 0) * 100),
    }));
    try {
      const res = await fetch("/api/three-pl-state-rates/bulk", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: currentProviderId, rates }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        data?: StateRateEntry[];
      };
      if (!res.ok || !body?.success) {
        toast.error(body?.error || `Failed to save rates (HTTP ${res.status})`);
      } else {
        if (Array.isArray(body.data)) setStateRates(rateEntriesToGrid(body.data));
        setRatesDirty(false);
        toast.success("State rates saved");
        // Refresh the provider list so the "States covered" badges update.
        fetchProviders();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error — rates not saved");
    }
    setRatesSaving(false);
  };

  // Refetch sub-tables whenever the dialog target changes. fetchProvider*
  // call setState internally — that's intentional (they're async fetches
  // synchronizing with an external source), so the lint rule about
  // setState-in-effect is suppressed for this body.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (currentProviderId) {
      fetchProviderVehicles(currentProviderId);
      fetchProviderDrivers(currentProviderId);
      fetchProviderStateRates(currentProviderId);
    } else {
      setProviderVehicles([]);
      setProviderDrivers([]);
    }
    // Also reset any in-progress vehicle/driver inline editor when the
    // host provider dialog opens/closes/changes. (The state-rate grid is
    // reset by openProviderDialog and re-filled by the fetch above.)
    setVehicleEditing(null);
    setDriverEditing(null);
  }, [currentProviderId, fetchProviderVehicles, fetchProviderDrivers, fetchProviderStateRates]);
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

  // Same vehicle + driver fetch for the Create Packing List dialog's truck
  // pickers, scoped to the chosen 3PL provider.
  useEffect(() => {
    const pid = plProviderId;
    if (!pid) {
      setPlDialogVehicles([]);
      setPlDialogDrivers([]);
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
        if (vRes?.success && Array.isArray(vRes.data)) setPlDialogVehicles(vRes.data);
        if (dRes?.success && Array.isArray(dRes.data)) setPlDialogDrivers(dRes.data);
      })
      .catch(() => {
        /* swallow */
      });
    return () => {
      cancelled = true;
    };
  }, [plProviderId]);

  // Edit mode: a DO stores only the driver's NAME, not the person id, so once
  // the chosen provider's drivers have loaded we re-select the person whose
  // name matches — pre-filling the Driver dropdown on Edit.
  useEffect(() => {
    if (!pendingDriverName || plDialogDrivers.length === 0) return;
    const match = plDialogDrivers.find((d) => d.name === pendingDriverName);
    if (match) setPlDriverPersonId(match.id);
    setPendingDriverName("");
  }, [plDialogDrivers, pendingDriverName]);

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
        boxLengthFt: "", boxWidthFt: "", boxHeightFt: "",
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
        boxLengthFt: v.boxLengthFt != null ? String(v.boxLengthFt) : "",
        boxWidthFt: v.boxWidthFt != null ? String(v.boxWidthFt) : "",
        boxHeightFt: v.boxHeightFt != null ? String(v.boxHeightFt) : "",
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
      boxLengthFt: vehicleForm.boxLengthFt !== "" ? Number(vehicleForm.boxLengthFt) || null : null,
      boxWidthFt: vehicleForm.boxWidthFt !== "" ? Number(vehicleForm.boxWidthFt) || null : null,
      boxHeightFt: vehicleForm.boxHeightFt !== "" ? Number(vehicleForm.boxHeightFt) || null : null,
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
    if (!(await confirm({ title: "Delete vehicle", message: "Delete this vehicle?", danger: true }))) return;
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
    if (!(await confirm({ title: "Delete driver", message: "Delete this driver?", danger: true }))) return;
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
    // Cross-status search (Wei Siang 2026-05-29): while the user is typing in
    // the grid search box, span EVERY status so a DO is findable no matter
    // which stage/tab it's on — searching an SO number must surface its DO
    // even if that DO sits on another tab. The DataGrid then narrows these by
    // the search term. Empty search keeps the normal tab-scoped view.
    // While searching, show the server's whole-table matches across every
    // status (searchResults is a separate set so the browse-derived counts/
    // lists above stay correct). Empty search = normal tab-scoped view.
    if (search.trim()) return searchResults;
    return deliveryOrders.filter((d) => statuses.includes(d.status));
  }, [deliveryOrders, searchResults, activeTab, search]);

  // Unified search index (Wei Siang 2026-06-02): one record-type-agnostic
  // index so the auto-jump below works for all 4 delivery tabs, not just the
  // 3 DO tabs. Each entry = { tab, haystack }. DO rows map to their stage tab
  // via TAB_FOR_STATUS; PO rows (Pending Delivery) map to the fixed
  // "pending_delivery" tab. Note the field-name trap: DO rows expose
  // customerRef, PO rows expose customerReference — using the wrong one
  // silently drops the customer-ref match.
  const searchJumpIndex = useMemo(() => {
    const entries: { tab: string; haystack: string }[] = [];
    // While searching, the DOs that matter live in searchResults (whole-table
    // matches); the browse-page deliveryOrders may not contain the hit at all.
    const doSource = search.trim() ? searchResults : deliveryOrders;
    for (const d of doSource) {
      const tab = TAB_FOR_STATUS[d.status];
      if (!tab) continue; // status with no tab (e.g. INVOICED) — never a jump target
      entries.push({
        tab,
        haystack: [
          d.doNo,
          d.companySO,
          d.salesOrderNos,
          d.customerPOId,
          d.customerSO,
          d.customerRef,
          d.customerName,
          d.vehicleNo,
        ]
          .join(" ")
          .toLowerCase(),
      });
    }
    // Planning POs (still in production) — previously omitted entirely, which
    // made an order whose lines were still being made invisible to the
    // cross-tab search/jump. Tag them to the "planning" tab so a search can
    // surface (and jump to) work that hasn't reached Pending Delivery yet.
    for (const po of planningPOs) {
      entries.push({
        tab: "planning",
        haystack: [
          po.salesOrderNo,
          po.poNo,
          po.customerPOId,
          po.customerReference,
          po.customerSO,
          po.customerName,
        ]
          .join(" ")
          .toLowerCase(),
      });
    }
    for (const po of readyPOs) {
      entries.push({
        tab: "pending_delivery",
        haystack: [
          po.salesOrderNo,
          po.poNo,
          po.customerPOId,
          po.customerReference,
          po.customerSO,
          po.customerName,
        ]
          .join(" ")
          .toLowerCase(),
      });
    }
    return entries;
  }, [deliveryOrders, searchResults, search, readyPOs, planningPOs]);

  // Per-tab match counts for the active search — powers the "found in other
  // stages" bar so a search that matches DOs on another tab never looks dead
  // (e.g. searching an SO that's already dispatched while on Pending Delivery).
  const searchTabCounts = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return null;
    const counts: Record<string, number> = {};
    for (const e of searchJumpIndex) {
      if (e.haystack.includes(term)) counts[e.tab] = (counts[e.tab] ?? 0) + 1;
    }
    return counts;
  }, [search, searchJumpIndex]);

  // Follow the record to its tab (Wei Siang 2026-06-02): a matching record is
  // surfaced no matter which tab it sits on, but the tab header should follow
  // so the page context matches what the operator searched. We look at where
  // the matches actually live across the unified index: if every match sits on
  // ONE tab, hop to that tab. Matches spanning several tabs leave the tab
  // alone. The active tab is read OUTSIDE the deps on purpose so a manual tab
  // click during an active search is respected, not yanked back.
  useEffect(() => {
    const term = search.trim().toLowerCase();
    if (!term) return;
    const tabsHit = new Set<string>();
    for (const entry of searchJumpIndex) {
      if (entry.haystack.includes(term)) tabsHit.add(entry.tab);
    }
    if (tabsHit.size === 1) {
      const only = Array.from(tabsHit)[0];
      if (only !== activeTab) setActiveTab(only);
    }
    // activeTab intentionally excluded — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, searchJumpIndex]);

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
      // Delivered count = DELIVERED + INVOICED so the badge matches the tab
      // list (which now keeps invoiced DOs — see TAB_DO_STATUSES).
      delivered: (byStatus.DELIVERED ?? 0) + (byStatus.INVOICED ?? 0),
    };
  }, [doStatsRaw]);
  // Wei Siang 2026-05-16: RM value per DO-status bucket so the tab
  // strip shows the money in each stage, not just the count.
  const valueDOsByStatus = useMemo(() => {
    const v = doStatsRaw?.valueByStatus ?? {};
    return {
      draft: v.DRAFT ?? 0,
      dispatched: v.LOADED ?? 0,
      inTransit: v.IN_TRANSIT ?? 0,
      delivered: (v.DELIVERED ?? 0) + (v.INVOICED ?? 0),
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
    // Select all (incl. DOs already in a packing list) so the whole truck can
    // be Marked Dispatched/Delivered together. "Create as Packing List" skips
    // already-grouped DOs itself.
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
  // Manual "+ Create DO" entry point removed 2026-05-28 (Wei Siang) — DOs are
  // created from the Pending Delivery convert flow. The shared Create Delivery
  // Order dialog stays for that convert flow.

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
      const selectedPOsForDO = readyPOs.filter((po) =>
        selectedReadyPOs.has(po.id),
      );
      const poIds = selectedPOsForDO.map((po) => po.id);
      if (poIds.length === 0) {
        setCreateDODialog(null);
        return;
      }
      // One DO = one customer ("DO 对标顾客"). Block a multi-customer selection
      // up front with a clear message instead of letting the backend reject it
      // with a 400. Mirrors the CUSTOMER-CONSISTENCY GUARD in the POST route.
      const distinctCustomerIds = new Set(
        selectedPOsForDO.map((po) => po.customerId).filter(Boolean),
      );
      if (distinctCustomerIds.size > 1) {
        const names = Array.from(
          new Set(selectedPOsForDO.map((po) => po.customerName).filter(Boolean)),
        ).join(", ");
        toast.error(
          `A delivery order can only be for one customer. You picked ${distinctCustomerIds.size} (${names}). Create one DO per customer, or use Quick Dispatch which splits automatically.`,
        );
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

  // ---------- Packing-List-first (auto-split) ----------
  // Opens the dialog and fetches the grouping PREVIEW from the backend
  // (preview: true runs the same load + group + pre-validate steps creation
  // uses, and creates nothing) so the table can never drift from what the
  // confirm will actually do. Validation errors (credit limit, already
  // delivered, CO POs) surface here, before anything exists.
  const openPlFirstDialog = async () => {
    const poIds = readyPOs
      .filter((po) => selectedReadyPOs.has(po.id))
      .map((po) => po.id);
    if (poIds.length === 0) return;
    setCreateDOForm({ driverId: "", vehicleId: "", driverPersonId: "", remarks: "", deliveryDate: "" });
    setPlFirstGroups(null);
    setPlFirstPreviewError(null);
    setPlFirstDialogOpen(true);
    try {
      const r = await fetch("/api/delivery-orders/packing-list-first", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productionOrderIds: poIds, preview: true }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        groups?: PlFirstPreviewGroup[];
        error?: string;
      };
      if (!r.ok || !j.success) {
        setPlFirstPreviewError(j.error || "Could not load the grouping preview.");
        return;
      }
      setPlFirstGroups(j.groups ?? []);
    } catch (e) {
      setPlFirstPreviewError(
        e instanceof Error ? e.message : "Could not load the grouping preview.",
      );
    }
  };

  // One confirm: the backend re-groups the LIVE selection, creates one DRAFT
  // DO per (customer, hub) group sequentially, then one packing list with
  // every new DO — all-or-nothing (any failure creates nothing).
  const confirmCreatePlFirst = async () => {
    // Derive poIds from the LIVE selection (not the dialog-open snapshot) —
    // same rationale as confirmCreateDO (BUG-2026-04-27 stale snapshot).
    const poIds = readyPOs
      .filter((po) => selectedReadyPOs.has(po.id))
      .map((po) => po.id);
    if (poIds.length === 0) {
      setPlFirstDialogOpen(false);
      return;
    }
    if (!createDOForm.driverId) {
      toast.error("Pick a 3PL provider first");
      return;
    }
    setPlFirstCreating(true);
    try {
      const r = await fetch("/api/delivery-orders/packing-list-first", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productionOrderIds: poIds,
          providerId: createDOForm.driverId || null,
          vehicleId: createDOForm.vehicleId || null,
          driverId: createDOForm.driverPersonId || null,
          deliveryDate: createDOForm.deliveryDate || "",
          remarks: createDOForm.remarks,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        data?: {
          packingList?: PackingListRecord | null;
          deliveryOrders?: { id: string; doNo: string }[];
        };
        error?: string;
      };
      if (!r.ok || !j.success) {
        toast.error(j.error || "Failed to create the packing list");
        return;
      }
      const doNos = (j.data?.deliveryOrders ?? []).map((d) => d.doNo);
      toast.success(
        `Packing list ${j.data?.packingList?.packingNo ?? ""} created with ${doNos.join(", ")}`,
      );
      setPlFirstDialogOpen(false);
      setSelectedReadyPOs(new Set());
      fetchData();
      setActiveTab("packing_list");
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to create the packing list",
      );
    } finally {
      setPlFirstCreating(false);
    }
  };

  // Opens the "Create Packing List" confirm dialog from the multi-selected DOs.
  const handlePrintPackingList = () => {
    if (selectedIds.size === 0) return;
    const all = deliveryOrders.filter((d) => selectedIds.has(d.id));
    // Skip DOs already in another packing list — a DO belongs to one list.
    const fresh = all.filter((d) => !doPackingMap.has(d.id));
    if (fresh.length === 0) {
      toast.error("All selected delivery orders are already in a packing list.");
      return;
    }
    setPlRemarks("");
    setPlProviderId("");
    setPlVehicleId("");
    setPlDriverPersonId("");
    setPrintDialog(fresh);
  };

  // Saves the selected DOs as a new packing list (POST), then jumps to the
  // Packing List tab where the operator prints it.
  const handleConfirmCreatePackingList = async () => {
    const dos = printDialog;
    if (!dos || dos.length === 0) {
      setPrintDialog(null);
      return;
    }
    setPlCreating(true);
    try {
      const r = await fetch("/api/packing-lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doIds: dos.map((d) => d.id),
          remarks: plRemarks.trim() || undefined,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        data?: PackingListRecord;
        error?: string;
      };
      if (!r.ok || !j.success) {
        toast.error(j.error || "Failed to create packing list");
        return;
      }

      // Stamp the chosen lorry + driver onto every DO in the run (overwrite),
      // reusing the DO edit path so driver/vehicle names denormalize the same
      // way. Sequential to avoid hammering the heavy DO write path.
      if (plProviderId || plVehicleId || plDriverPersonId) {
        const truckBody = {
          providerId: plProviderId || null,
          vehicleId: plVehicleId || null,
          driverId: plDriverPersonId || null,
        };
        const failed: string[] = [];
        for (const d of dos) {
          try {
            const tr = await fetch(`/api/delivery-orders/${d.id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(truckBody),
            });
            if (!tr.ok) failed.push(d.doNo);
          } catch {
            failed.push(d.doNo);
          }
        }
        if (failed.length) {
          toast.error(
            `Packing list created, but driver/lorry didn't save on ${failed.length} DO(s): ${failed.slice(0, 3).join(", ")}`,
          );
        }
        invalidateCachePrefix("/api/delivery-orders");
        refreshDOs();
      }

      toast.success(`Packing list ${j.data?.packingNo ?? ""} created`);
      setPrintDialog(null);
      setPlRemarks("");
      setSelectedIds(new Set());
      invalidateCachePrefix("/api/packing-lists");
      refreshPLs();
      setActiveTab("packing_list");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create packing list");
    } finally {
      setPlCreating(false);
    }
  };

  // Render a saved packing list — fetch its DOs from the backend (works
  // regardless of which DOs are on the current page). mode="view" opens it on
  // screen to read first; mode="download" saves the PDF.
  const handlePrintPackingListRecord = async (
    pl: PackingListRecord,
    mode: "download" | "view" = "download",
  ) => {
    try {
      const r = await fetch(`/api/packing-lists/${pl.id}`);
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        data?: { orders?: { id: string }[] };
        error?: string;
      };
      if (!r.ok || !j.success || !j.data) {
        toast.error(j.error || "Failed to load packing list");
        return;
      }
      const orders = j.data.orders ?? [];
      if (orders.length === 0) {
        toast.error("This packing list has no delivery orders.");
        return;
      }
      // Pull the same per-DO print-extras (customer PO/SO/Ref, bedframe
      // dims, BOM piece breakdown) the single-DO print uses, so each DO in
      // the packing list renders identically to its standalone DO.
      const extrasById: Record<
        string,
        import("@/lib/generate-do-pdf").DOPrintExtras
      > = {};
      await Promise.all(
        orders.map(async (o) => {
          try {
            const er = await fetch(
              `/api/delivery-orders/${encodeURIComponent(o.id)}/print-extras`,
            );
            const ej = (await er.json()) as {
              success?: boolean;
              data?: import("@/lib/generate-do-pdf").DOPrintExtras;
            };
            if (ej?.success && ej.data) extrasById[o.id] = ej.data;
          } catch {
            /* graceful — DO still renders without extras */
          }
        }),
      );
      const { generateConsolidatedDoPdf } = await import("@/lib/generate-do-pdf");
      // Delivery-status QR for the whole run (best-effort) — one scan on the
      // printed manifest marks every member DO Dispatched / Delivered.
      const plQrDataUrl = await fetchDoQrDataUrl("PL", pl.id);
      // Packing list prints as a standalone driver manifest only — no DO forms
      // bundled behind it (operator request 2026-06-02).
      generateConsolidatedDoPdf(
        orders as unknown as import("@/types").DeliveryOrder[],
        extrasById,
        mode,
        pl.packingNo,
        false,
        plQrDataUrl,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to generate packing list");
    }
  };

  // Delete a saved packing list (frees its DOs to be grouped again).
  const handleDeletePackingList = async (pl: PackingListRecord) => {
    if (
      !(await confirm({
        title: "Delete packing list",
        message: `Delete packing list ${pl.packingNo}? Its ${pl.doCount ?? pl.stopCount} delivery order(s) will be freed to add to another list. This does not delete the DOs.`,
        danger: true,
      }))
    )
      return;
    try {
      const r = await fetch(`/api/packing-lists/${pl.id}`, { method: "DELETE" });
      const j = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!r.ok || !j.success) {
        toast.error(j.error || "Failed to delete packing list");
        return;
      }
      toast.success(`Packing list ${pl.packingNo} deleted`);
      invalidateCachePrefix("/api/packing-lists");
      refreshPLs();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete packing list");
    }
  };

  // Open the packing-list dialog in EDIT mode to re-assign the driver / lorry /
  // 3PL provider. The carrier is stamped identically on every DO in the run,
  // so we read it off the first DO to pre-fill the pickers. On a DO the
  // driverId column holds the 3PL PROVIDER id and vehicleId the lorry; the
  // driver person id isn't stored (only driverName), so we stash the name in
  // pendingDriverName and re-match it once that provider's drivers load.
  const handleEditPackingList = async (pl: PackingListRecord) => {
    try {
      const r = await fetch(`/api/packing-lists/${pl.id}`);
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        data?: {
          orders?: Array<{
            id: string;
            doNo: string;
            customerName?: string;
            hubName?: string;
            driverId?: string | null;
            vehicleId?: string | null;
            driverName?: string | null;
          }>;
        };
        error?: string;
      };
      if (!r.ok || !j.success || !j.data) {
        toast.error(j.error || "Failed to load packing list");
        return;
      }
      const orders = j.data.orders ?? [];
      if (orders.length === 0) {
        toast.error("This packing list has no delivery orders.");
        return;
      }
      const first = orders[0];
      setPlProviderId(first.driverId || "");
      setPlVehicleId(first.vehicleId || "");
      setPlDriverPersonId("");
      setPendingDriverName(first.driverName || "");
      setPlRemarks(pl.remarks || "");
      setPrintDialog(orders as unknown as DeliveryOrderRow[]);
      setEditingPL(pl);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load packing list");
    }
  };

  // Save an EDIT — re-stamp the chosen driver / lorry / provider onto every DO
  // in the list (overwrite, same path as Create). Carrier lives on the DOs, so
  // there is no packing_lists row to update here.
  const handleConfirmEditPackingList = async () => {
    const dos = printDialog;
    const pl = editingPL;
    if (!dos || !pl) {
      setPrintDialog(null);
      setEditingPL(null);
      return;
    }
    setPlCreating(true);
    try {
      const truckBody = {
        providerId: plProviderId || null,
        vehicleId: plVehicleId || null,
        driverId: plDriverPersonId || null,
      };
      const failed: string[] = [];
      for (const d of dos) {
        try {
          const tr = await fetch(`/api/delivery-orders/${d.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(truckBody),
          });
          if (!tr.ok) failed.push(d.doNo);
        } catch {
          failed.push(d.doNo);
        }
      }
      if (failed.length) {
        toast.error(
          `Saved, but driver/lorry didn't update on ${failed.length} DO(s): ${failed.slice(0, 3).join(", ")}`,
        );
      } else {
        toast.success(`Packing list ${pl.packingNo} updated`);
      }
      invalidateCachePrefix("/api/delivery-orders");
      refreshDOs();
      invalidateCachePrefix("/api/packing-lists");
      refreshPLs();
      setPrintDialog(null);
      setEditingPL(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update packing list");
    } finally {
      setPlCreating(false);
    }
  };

  // The customer's "PIC Email" (customers.email) for a DO row — looked up from
  // the already-loaded customers list (via the ref, so it's correct even from
  // a memoized closure). Empty string when the customer has no email on file
  // (the silent-skip case the warning + Resend surface).
  const customerEmailFor = (row: { customerId: string }): string =>
    (
      customersDataRef.current.find((cu) => cu.id === row.customerId)?.email ??
      ""
    ).trim();

  // Feature B — no-email warning. The backend silently SKIPS the customer
  // notice when the customer has no email on file (returns {skipped, reason:
  // 'no recipient'}), so delivering/invoicing such a DO sends nothing with no
  // signal. After a transition we check the customer's email and, when blank,
  // raise a clear non-blocking warning toast so the operator knows the invoice
  // didn't email (and can add the email + Resend). NEVER blocks the flow — the
  // transition is already committed by the time this runs.
  const warnIfNoCustomerEmail = (
    row: { customerId: string; customerName: string; doNo: string },
    kind: "DISPATCHED" | "DELIVERED",
  ) => {
    if (customerEmailFor(row)) return;
    toast.warning(
      kind === "DELIVERED"
        ? `⚠ ${row.doNo} not emailed — ${row.customerName} has no email on file. Add it on the customer, then Resend.`
        : `⚠ ${row.doNo} dispatch notice not emailed — ${row.customerName} has no email on file. Add it on the customer, then Resend.`,
    );
  };

  // Feature A — per-DO FORCE re-send of the customer invoice/dispatch email.
  // Clears the email-sent stamp on the backend so the same notice helper can
  // re-fire (recipient chain + server PDF fallback + no-recipient skip all
  // reused), then toasts what actually happened. Confirmed first; when the
  // customer has no email on file the caller disables the button, but we still
  // guard here and surface the warning if it slips through.
  const resendCustomerNotice = async (
    row: { id: string; customerId: string; customerName: string; doNo: string },
    kind: "DISPATCHED" | "DELIVERED" = "DELIVERED",
  ) => {
    if (resendingId) return;
    const email = customerEmailFor(row);
    const noun = kind === "DELIVERED" ? "invoice" : "dispatch";
    if (!email) {
      toast.warning(
        `${row.customerName} has no email on file — add the PIC Email on the customer, then Resend.`,
      );
      return;
    }
    if (
      !(await confirm({
        title: `Re-send ${noun} email`,
        message: `Re-send the ${noun} email for ${row.doNo} to ${email}?`,
        danger: false,
      }))
    )
      return;
    setResendingId(row.id);
    try {
      // Render the SAME unified invoice PDF the Invoice page downloads so an
      // edited-then-resent invoice carries the exact document (not the backend
      // fallback). Only for DELIVERED (invoice); DISPATCHED re-send leaves the
      // backend to render the DO. {} on failure → backend fallback.
      const rendered =
        kind === "DELIVERED"
          ? await renderDeliveredInvoicePdf(row.id, row.customerId)
          : {};
      const r = await fetch(
        `/api/delivery-orders/${encodeURIComponent(row.id)}/resend-notice`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            pdfBase64: rendered.pdfBase64,
            pdfFilename: rendered.pdfFilename,
          }),
        },
      );
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        sent?: boolean;
        skipped?: boolean;
        reason?: string;
        to?: string;
        error?: string;
      };
      if (r.ok && j?.sent) {
        toast.success(
          `${kind === "DELIVERED" ? "Invoice" : "Dispatch"} email re-sent to ${j.to || email}`,
        );
      } else if (r.ok && j?.skipped) {
        toast.warning(
          j.reason === "no recipient"
            ? `${row.customerName} has no email on file — nothing sent.`
            : `Nothing sent (${j.reason || "skipped"}).`,
        );
      } else {
        toast.error(j?.error || `Failed to re-send (HTTP ${r.status})`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error — email not re-sent");
    } finally {
      setResendingId(null);
    }
  };

  // Queue the customer notices for the DOs that JUST transitioned —
  // kicked off (not awaited) so the page stays snappy; inside, the POSTs
  // run sequentially after the transitions finished. One summary toast
  // when ≥1 notice actually queued; silent when everything was skipped
  // (no email on file / already sent) or failed.
  const notifyCustomersAfterTransition = (
    rows: DeliveryOrderRow[],
    kind: "DISPATCHED" | "DELIVERED",
  ) => {
    if (rows.length === 0) return;
    void (async () => {
      let queued = 0;
      for (const row of rows) {
        if ((await sendCustomerNotice(row, kind)) === "queued") queued++;
      }
      if (queued > 0) {
        toast.success(
          kind === "DISPATCHED"
            ? `Dispatch notice emailed for ${queued} DO(s)`
            : `Invoice notice emailed for ${queued} DO(s)`,
        );
      }
    })();
  };

  // Wei Siang 2026-05-16: bulk Mark Dispatched / Mark Delivered run
  // the DO PUTs SEQUENTIALLY, not in parallel. Each DO transition is
  // a heavy multi-statement batch (fg_units, COGS, auto-invoice, SO
  // status cascade). Firing 25 in parallel caused:
  //   - "deadlock detected": two DELIVERED batches UPDATE the same
  //     shared sales_orders row (DOs frequently share SOs) in
  //     different lock order.
  //   - "duplicate key ux_invoices_invoice_no": nextInvoiceNo() is
  //     read-MAX-then-+1; parallel auto-invoice creation all read the
  //     same max (none committed yet) → same invoiceNo → unique
  //     constraint violation.
  // Running one-at-a-time lets each batch commit before the next
  // starts: invoice numbers stay unique, no concurrent SO-row locks.
  // Slower for big selections but correct; the operator does this
  // once per dispatch run, not in a hot loop.
  const runBulkDoTransition = async (
    doIds: string[],
    nextStatus: "LOADED" | "DELIVERED",
    successVerb: string,
  ) => {
    if (doIds.length === 0) return;
    const failures: string[] = [];
    const succeededIds: string[] = [];
    for (const id of doIds) {
      try {
        const r = await fetch(`/api/delivery-orders/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus }),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          failures.push(body?.error || `HTTP ${r.status}`);
        } else {
          succeededIds.push(id);
        }
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (failures.length) {
      toast.error(`${failures.length} of ${doIds.length} failed: ${failures[0]}`);
    } else {
      toast.success(`${doIds.length} delivery orders ${successVerb}`);
      setSelectedIds(new Set());
    }
    // A bulk transition to DELIVERED auto-creates invoices + CLOSEs SOs on the
    // backend; without these broadcasts the Invoices/Sales lists stay stale
    // until a manual refresh (2026-07-04 cache sweep — matched the single
    // invoice-gen path fixed earlier).
    if (nextStatus === "DELIVERED") {
      invalidateCachePrefix("/api/invoices");
      invalidateCachePrefix("/api/sales-orders");
    }
    fetchData();
    // Customer notices for every DO that actually transitioned — covers the
    // bulk buttons AND the PL-level bulk actions (runPlBulkTransition reuses
    // this path). Fire-and-forget; transitions above are already committed.
    notifyCustomersAfterTransition(
      deliveryOrders.filter((d) => succeededIds.includes(d.id)),
      nextStatus === "LOADED" ? "DISPATCHED" : "DELIVERED",
    );
  };

  const handleMarkDispatched = async () => {
    if (selectedIds.size === 0) return;
    const doIds = deliveryOrders
      .filter((d) => selectedIds.has(d.id) && d.status === "DRAFT")
      .map((d) => d.id);
    await runBulkDoTransition(doIds, "LOADED", "marked dispatched");
  };

  const handleMarkDelivered = async () => {
    if (selectedIds.size === 0) return;
    const doIds = deliveryOrders
      .filter((d) => selectedIds.has(d.id) && (d.status === "LOADED" || d.status === "IN_TRANSIT"))
      .map((d) => d.id);
    await runBulkDoTransition(doIds, "DELIVERED", "marked delivered");
  };

  // PL-level one-click status (Wei Siang 2026-06-11: "我可以直接 mark as
  // dispatched,里面的 DO 全部就已经是出货状态" — manage the whole truck run
  // from the Packing List row instead of DO by DO). Reuses the EXACT same
  // sequential per-DO transition path as the bulk buttons above
  // (runBulkDoTransition), so every guard + cascade (fg_units, COGS,
  // auto-invoice, SO status) runs once per DO exactly as if the operator
  // clicked each DO — no second write path to drift.
  const [plBulkBusy, setPlBulkBusy] = useState<string | null>(null);
  // Delivery-status QR modal (DO or PL) — drivers scan the printed QR to
  // Mark Dispatched / Delivered from their own phones, no login
  // (/d/<token> + routes/public-do-qr.ts).
  const [qrDialog, setQrDialog] = useState<{
    kind: "DO" | "PL";
    id: string;
    docNo: string;
  } | null>(null);
  const runPlBulkTransition = async (
    pl: PackingListRecord,
    nextStatus: "LOADED" | "DELIVERED",
  ) => {
    if (plBulkBusy) return;
    const eligible = deliveryOrders.filter(
      (d) =>
        pl.doIds.includes(d.id) &&
        (nextStatus === "LOADED"
          ? d.status === "DRAFT"
          : d.status === "LOADED" || d.status === "IN_TRANSIT"),
    );
    const verb = nextStatus === "LOADED" ? "Dispatched" : "Delivered";
    if (eligible.length === 0) {
      toast.error(
        nextStatus === "LOADED"
          ? `No pending DOs in ${pl.packingNo} — they are already dispatched or delivered.`
          : `No dispatched DOs in ${pl.packingNo} — dispatch them first, or they are already delivered.`,
      );
      return;
    }
    if (
      !(await confirm({
        title: `Mark ${verb}`,
        message: `Mark ${eligible.length} delivery order(s) in ${pl.packingNo} as ${verb}? (${eligible
          .map((d) => d.doNo)
          .slice(0, 5)
          .join(", ")}${eligible.length > 5 ? "…" : ""})`,
        danger: false,
      }))
    )
      return;
    setPlBulkBusy(pl.id);
    try {
      await runBulkDoTransition(
        eligible.map((d) => d.id),
        nextStatus,
        `marked ${verb.toLowerCase()}`,
      );
      invalidateCachePrefix("/api/packing-lists");
      refreshPLs();
    } finally {
      setPlBulkBusy(null);
    }
  };

  const handleGenerateInvoice = (doRow: DeliveryOrderRow) => {
    setInvoiceDialog(doRow);
  };

  const handleSubmitPOD = async (pod: ProofOfDelivery) => {
    if (!podDialog) return;
    try {
      // 2026-05-27 verifiedSave migration. POD submit transitions DO to
      // DELIVERED which cascades to SO + auto-invoice. Read back so a
      // stale-snapshot 200 doesn't show green when the row didn't move.
      const result = await verifiedSave<DeliveryOrder>({
        endpoint: `/api/delivery-orders/${podDialog.id}`,
        method: "PUT",
        body: { status: "DELIVERED", proofOfDelivery: pod },
        readback: async () => {
          const r = await fetch(`/api/delivery-orders/${podDialog.id}?_v=${Date.now()}`, {
            credentials: "include",
            cache: "no-store",
          });
          if (!r.ok) return null;
          const j = (await r.json()) as { success?: boolean; data?: DeliveryOrder } | DeliveryOrder;
          return (j as { data?: DeliveryOrder })?.data ?? (j as DeliveryOrder) ?? null;
        },
        // DELIVERED auto-creates the invoice and bumps the DO straight to
        // INVOICED — both are a successful delivery, so accept either.
        expect: { status: ["DELIVERED", "INVOICED"] },
      });
      if (result.ok) {
        // Invoice notice (fire-and-forget) — the DELIVERED cascade just
        // auto-created the invoice; email it with the invoice PDF attached.
        notifyCustomersAfterTransition([podDialog], "DELIVERED");
        // Feature B — surface the silent skip: if the customer has no email
        // on file, nothing was emailed. Warn (non-blocking) so the operator
        // knows to add the email + Resend.
        warnIfNoCustomerEmail(podDialog, "DELIVERED");
        setPodDialog(null);
        fetchData();
      } else if (result.reason === "mismatch") {
        toast.error(formatMismatchError(result.diffs));
      } else if (result.reason === "http") {
        let parsedErr = result.body;
        try {
          const j = JSON.parse(result.body) as { error?: string };
          if (j.error) parsedErr = j.error;
        } catch { /* keep raw body */ }
        toast.error(parsedErr || `Failed to mark delivered (HTTP ${result.status})`);
      } else {
        toast.error(`Save failed: ${result.details}`);
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
    // verifiedSave (2026-06-09): the old handler did `catch { /* ignore */ }`,
    // so a failed invoice creation closed the dialog with NO error — the
    // operator thought the invoice was generated when it wasn't. Invoice
    // creation flips the DO to INVOICED on the backend (invoices route), so we
    // read the DO back with a cache-bust and confirm; a 200 that didn't persist
    // (stale snapshot / half-write) or any failure now tells the operator
    // honestly instead of silently. Mirrors the POD / driver handlers above.
    const result = await verifiedSave<{ status?: string | null }>({
      endpoint: "/api/invoices",
      method: "POST",
      body: {
        salesOrderId: invoiceDialog.salesOrderId,
        doNo: invoiceDialog.doNo,
        customerId: invoiceDialog.customerId,
        customerName: invoiceDialog.customerName,
      },
      readback: async () => {
        const r = await fetch(
          `/api/delivery-orders/${invoiceDialog.id}?_v=${Date.now()}`,
          { credentials: "include", cache: "no-store" },
        );
        if (!r.ok) return null;
        const j = (await r.json()) as
          | { data?: { status?: string | null } }
          | { status?: string | null };
        return (j as { data?: { status?: string | null } }).data ?? (j as { status?: string | null });
      },
      expect: { status: "INVOICED" },
    });
    setInvoiceLoading(false);
    if (!result.ok) {
      if (result.reason === "mismatch") {
        toast.error(formatMismatchError(result.diffs));
      } else if (result.reason === "http") {
        let msg = result.body;
        try {
          const j = JSON.parse(result.body) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {
          /* non-json body — central toast net humanises it */
        }
        toast.error(msg || "Couldn't generate the invoice. Please try again.");
      } else {
        toast.error("Couldn't generate the invoice — please check your connection and try again.");
      }
      return; // keep the dialog open so the operator can retry
    }
    // Confirmed persisted → apply the optimistic INVOICED flip + close.
    // Cross-tab freshness (2026-07-03 audit): invoice creation also CLOSEs the
    // SO on the backend, and this handler previously invalidated NOTHING — an
    // invoice generated here didn't show in the Invoices list (own tab or
    // another) until the cache TTL. Broadcast all three affected prefixes.
    invalidateCachePrefix("/api/invoices");
    invalidateCachePrefix("/api/sales-orders");
    invalidateCachePrefix("/api/delivery-orders");
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
    toast.success("Invoice generated");
    // Feature B — the DELIVERED→INVOICED flip fires the customer invoice notice
    // on the backend choke-point; if the customer has no email on file nothing
    // was emailed, so warn the operator (non-blocking).
    warnIfNoCustomerEmail(invoiceDialog, "DELIVERED");
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
      customerPOId: po.customerPOId || "",
      customerSO: po.customerSO || "",
      customerRef: po.customerReference || "",
    };
    setEditItems((prev) => [...prev, newItem]);
  };

  // Available POs that can be added (not already in editItems)
  const addablePOs = useMemo(() => {
    if (!showAddItemPanel || !detailDO) return [];
    const existingPOIds = new Set(editItems.map((i) => i.productionOrderId));
    // A DO delivers to ONE customer and ONE place. Only offer ready POs going
    // to the SAME customer AND the SAME state as this DO, so a wrong-state
    // order (e.g. Penang into a KL DO) never even appears in the picker
    // (Wei Siang 2026-06-11). The backend hub guard is the exact safety net;
    // this is the can't-even-click filter. resolveStateCode lets legacy
    // shorthand (KL/PG…) and canonical codes compare equal. When the DO has
    // no resolvable state yet (e.g. a hub-less service DO), fall back to
    // customer-only so the picker isn't empty.
    const doState = resolveStateCode(detailDO.hubState || detailDO.hubBranch);
    const sameCustomer = (po: ReadyPORow) =>
      detailDO.customerId
        ? po.customerId === detailDO.customerId
        : (po.customerName || "") === (detailDO.customerName || "");
    let filtered = readyPOs.filter(
      (po) =>
        !existingPOIds.has(po.id) &&
        sameCustomer(po) &&
        (doState === null || resolveStateCode(po.customerState) === doState),
    );
    if (addItemSearch) {
      const q = addItemSearch.toLowerCase();
      filtered = filtered.filter(
        (po) =>
          po.poNo.toLowerCase().includes(q) ||
          po.productCode.toLowerCase().includes(q) ||
          po.productName.toLowerCase().includes(q) ||
          po.customerName.toLowerCase().includes(q) ||
          po.salesOrderNo.toLowerCase().includes(q) ||
          // Customer-side refs are shown in each picker row, so the packer
          // must be able to search them too — typing "8891" off the
          // customer PO PO-008891 returned nothing before (Wei Siang
          // 2026-06-02).
          (po.customerPOId || "").toLowerCase().includes(q) ||
          (po.customerSO || "").toLowerCase().includes(q) ||
          (po.customerReference || "").toLowerCase().includes(q),
      );
    }
    return filtered;
  }, [showAddItemPanel, editItems, readyPOs, addItemSearch, detailDO]);

  const saveEditDO = async () => {
    if (!detailDO) return;
    setEditSaving(true);
    try {
      // 3PL refactor: send providerId for the company plus the new
      // vehicleId / driverId (PERSON) pickers. Backend's denormalize
      // step fills in vehicleNo/vehicleType/driverName/driverPhone from
      // the picked vehicle + person rows; providerId mirrors into the
      // legacy driverId column on delivery_orders for backwards-compat.
      // 2026-05-27 verifiedSave migration. Driver / vehicle / address
      // edits drive what the warehouse and the driver see — a stale-
      // cache silent overwrite would send the wrong driver. Read back
      // and confirm the header fields persisted (items rebuild server-
      // side so we don't compare those).
      const requestBody = {
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
      };
      const result = await verifiedSave<DeliveryOrder>({
        endpoint: `/api/delivery-orders/${detailDO.id}`,
        method: "PUT",
        body: requestBody,
        readback: async () => {
          const r = await fetch(`/api/delivery-orders/${detailDO.id}?_v=${Date.now()}`, {
            credentials: "include",
            cache: "no-store",
          });
          if (!r.ok) return null;
          const j = (await r.json()) as { success?: boolean; data?: DeliveryOrder } | DeliveryOrder;
          return (j as { data?: DeliveryOrder })?.data ?? (j as DeliveryOrder) ?? null;
        },
        expect: {
          deliveryAddress: editForm.deliveryAddress,
          contactPerson: editForm.contactPerson,
          contactPhone: editForm.contactPhone,
          remarks: editForm.remarks,
        },
      });
      if (result.ok) {
        setEditMode(false);
        setShowAddItemPanel(false);
        const updated = mapDOToRow(result.data);
        setDetailDO(updated);
        fetchData();
      } else if (result.reason === "mismatch") {
        toast.error(formatMismatchError(result.diffs));
      } else if (result.reason === "http") {
        let parsedErr = result.body;
        try {
          const j = JSON.parse(result.body) as { error?: string };
          if (j.error) parsedErr = j.error;
        } catch { /* keep raw body */ }
        toast.error(parsedErr || `Failed to save changes (HTTP ${result.status})`);
      } else {
        toast.error(`Save failed: ${result.details}`);
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
  const triggerPrint = async (row: DeliveryOrderRow, mode: PrintMode) => {
    // Best-effort print enrichment: customerSO / customerRef / bedframe
    // dims come from the read-only /print-extras endpoint. Never block the
    // printout if it fails — the fields just render "-".
    type Extras = {
      customerSO?: string;
      customerRef?: string;
      items?: Record<
        string,
        {
          gapInches: number | null;
          divanHeightInches: number | null;
          legHeightInches: number | null;
          totalHeightInches: number | null;
        }
      >;
    };
    let extras: Extras = {};
    try {
      const r = await fetch(
        `/api/delivery-orders/${encodeURIComponent(row.id)}/print-extras`,
      );
      const j = (await r.json()) as { success?: boolean; data?: Extras };
      if (j?.success && j.data) extras = j.data;
    } catch {
      /* graceful — print without the extra fields */
    }
    const exItems = extras.items ?? {};
    const data: PrintDOData = {
      doNo: row.doNo,
      companySO: row.companySO,
      customerSO: extras.customerSO ?? "",
      customerPOId: row.customerPOId,
      customerRef: extras.customerRef ?? "",
      customerName: row.customerName,
      deliveryBranch: row.hubState || row.hubBranch || "",
      deliveryAddress: row.deliveryAddress,
      contactPerson: row.contactPerson,
      contactPhone: row.contactPhone,
      driverName: row.driverName,
      vehicleNo: row.vehicleNo,
      dispatchDate: row.dispatchDate,
      items: row.items.map((i) => {
        const ex = exItems[i.id];
        return {
          id: i.id,
          salesOrderNo: i.salesOrderNo,
          poNo: i.poNo,
          // Per-line customer PO — drives the print sort order. Comes off
          // the DO line item itself (print-extras only carries the height
          // fields, not customer PO), falling back to empty.
          customerPOId: i.customerPOId ?? "",
          productCode: i.productCode,
          productName: i.productName,
          sizeLabel: i.sizeLabel,
          fabricCode: i.fabricCode,
          quantity: i.quantity,
          itemM3: i.itemM3,
          rackingNumber: i.rackingNumber,
          gapInches: ex?.gapInches ?? null,
          divanHeightInches: ex?.divanHeightInches ?? null,
          legHeightInches: ex?.legHeightInches ?? null,
          totalHeightInches: ex?.totalHeightInches ?? null,
        };
      }),
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

  // When the detail/edit modal opens, pull the read-only print-extras so
  // each item row can show its OWN customer PO / SO no. (production-order
  // sourced — the values the printed DO uses). Cleared on close.
  useEffect(() => {
    const id = detailDO?.id;
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/delivery-orders/${encodeURIComponent(id)}/print-extras`,
        );
        const j = (await r.json()) as {
          success?: boolean;
          data?: import("@/lib/generate-do-pdf").DOPrintExtras;
        };
        if (!cancelled && j?.success && j.data)
          setDetailExtras({ forId: id, data: j.data });
      } catch {
        /* graceful — table falls back to the SO-list values */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detailDO?.id]);

  // Resolve a line's customer PO / SO / Ref, preferring the per-line
  // production-order values from /print-extras over the (often blank)
  // SO-header values carried on the row. Gated by forId so a previous
  // DO's extras never bleed into the next one while its fetch is in
  // flight.
  const lineRefs = (item: DOItem) => {
    const ext =
      detailExtras && detailExtras.forId === detailDO?.id
        ? detailExtras.data
        : undefined;
    const ex = ext?.items?.[item.id];
    return {
      customerPOId: ex?.customerPOId || item.customerPOId || "",
      salesOrderNo: ex?.salesOrderNo || item.salesOrderNo || "",
      customerSO: item.customerSO || ext?.customerSO || "",
      customerRef: item.customerRef || ext?.customerRef || "",
    };
  };

  // Per-row "Print DO" — generates the formal DO PDF straight from the
  // list (no need to open the detail). Pulls the read-only print-extras
  // (customerSO/ref + per-item PO/dims), best-effort.
  const printDOPdf = async (
    row: DeliveryOrderRow,
    mode: "download" | "view" = "download",
  ) => {
    let extras: import("@/lib/generate-do-pdf").DOPrintExtras = {};
    try {
      const r = await fetch(
        `/api/delivery-orders/${encodeURIComponent(row.id)}/print-extras`,
      );
      const j = (await r.json()) as {
        success?: boolean;
        data?: import("@/lib/generate-do-pdf").DOPrintExtras;
      };
      if (j?.success && j.data) extras = j.data;
    } catch {
      /* graceful — PDF still renders without extras */
    }
    // Delivery-status QR onto the printed DO (best-effort, print flow only —
    // never on the customer-email PDF).
    extras.qrDataUrl = await fetchDoQrDataUrl("DO", row.id);
    const { generateDOPdf } = await import("@/lib/generate-do-pdf");
    generateDOPdf(
      row as unknown as import("@/types").DeliveryOrder,
      extras,
      mode,
    );
  };

  // ---------- Expected DD inline update ----------
  // NO naked edits: the date cell (EditableExpectedDD) holds a local draft and
  // only calls this on an explicit Save click — never on blur. We optimistically
  // patch both boards, then surface any failure via toast and revert.
  const updateExpectedDD = useCallback(async (salesOrderId: string, newDate: string, rowId: string, prevDate: string | null) => {
    if (!salesOrderId) return;
    // Optimistic patch on both boards (the row may live in either list).
    setPlanningPOs((prev) =>
      prev.map((r) => (r.id === rowId ? { ...r, hookkaExpectedDD: newDate } : r))
    );
    setReadyPOs((prev) =>
      prev.map((r) => (r.id === rowId ? { ...r, hookkaExpectedDD: newDate } : r))
    );
    try {
      const json = await fetchJson(`/api/sales-orders/${salesOrderId}`, SOMutationSchema, {
        method: "PUT",
        body: { hookkaExpectedDD: newDate },
      });
      if (!json.success) throw new Error("Save was rejected by the server");
      toast.success("Expected DD updated");
    } catch (e) {
      // Surface the error and revert the optimistic value.
      setPlanningPOs((prev) =>
        prev.map((r) => (r.id === rowId ? { ...r, hookkaExpectedDD: prevDate ?? "" } : r))
      );
      setReadyPOs((prev) =>
        prev.map((r) => (r.id === rowId ? { ...r, hookkaExpectedDD: prevDate ?? "" } : r))
      );
      const msg =
        e instanceof FetchJsonError
          ? (e.body as { error?: string } | undefined)?.error || e.message
          : e instanceof Error
            ? e.message
            : "Network error";
      toast.error(`Failed to update Expected DD: ${msg}`);
    }
  }, [toast]);

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
      {
        key: "productName",
        label: "Product",
        type: "text",
        sortable: true,
        render: (value, row, _index, highlight) => (
          <span className="inline-flex flex-col items-start gap-0.5">
            <span>{highlight(String(value ?? ""))}</span>
            <RepairPartsBadge
              repairScope={row.repairScope}
              productCode={row.productCode}
            />
          </span>
        ),
      },
      { key: "sizeLabel", label: "Size", type: "text", width: "80px", sortable: true },
      { key: "fabricCode", label: "Fabric", type: "text", width: "80px", sortable: true },
      { key: "customerName", label: "Customer", type: "text", width: "120px", sortable: true },
      { key: "customerState", label: "State", type: "text", width: "60px", sortable: true },
      // Customer-side reference numbers (operator request 2026-05-19) — same
      // data the Pending Delivery grid uses (ReadyPORow, mapPO). "—" when
      // the customer didn't supply that number.
      {
        key: "customerPOId",
        label: "Customer PO",
        type: "text",
        width: "130px",
        sortable: true,
        render: (_v, row) => row.customerPOId
          ? <span className="text-[#1F1D1B]">{row.customerPOId}</span>
          : <span className="text-[#9CA3AF]">{"—"}</span>,
      },
      {
        key: "customerReference",
        label: "Customer Ref",
        type: "text",
        width: "130px",
        sortable: true,
        render: (_v, row) => row.customerReference
          ? <span className="text-[#1F1D1B]">{row.customerReference}</span>
          : <span className="text-[#9CA3AF]">{"—"}</span>,
      },
      {
        key: "customerSO",
        label: "Customer SO",
        type: "text",
        width: "130px",
        sortable: true,
        render: (_v, row) => row.customerSO
          ? <span className="text-[#1F1D1B]">{row.customerSO}</span>
          : <span className="text-[#9CA3AF]">{"—"}</span>,
      },
      { key: "quantity", label: "Qty", type: "number", width: "60px", align: "right", sortable: true },
      {
        // Sales Figure \u2014 this PO's SO line value (SO unit price \u00D7 qty),
        // same basis as the DO-based tabs so the money is comparable
        // across every delivery stage.
        key: "valueSen",
        label: "Amount",
        type: "text",
        width: "120px",
        sortable: true,
        render: (_v, row) => (
          <span className="font-medium text-[#1F1D1B] tabular-nums">
            {formatRM(row.valueSen ?? 0)}
          </span>
        ),
      },
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
        width: "150px",
        sortable: true,
        render: (_v, row) => <EditableExpectedDD row={row} onSave={updateExpectedDD} />,
      },
    ],
    [updateExpectedDD]
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
      {
        key: "productName",
        label: "Product",
        type: "text",
        sortable: true,
        render: (value, row, _index, highlight) => (
          <span className="inline-flex flex-col items-start gap-0.5">
            <span>{highlight(String(value ?? ""))}</span>
            <RepairPartsBadge
              repairScope={row.repairScope}
              productCode={row.productCode}
            />
          </span>
        ),
      },
      { key: "sizeLabel", label: "Size", type: "text", width: "80px", sortable: true },
      { key: "fabricCode", label: "Fabric", type: "text", width: "80px", sortable: true },
      { key: "customerName", label: "Customer", type: "text", width: "120px", sortable: true },
      { key: "customerState", label: "State", type: "text", width: "60px", sortable: true },
      // Customer-side reference numbers (operator request 2026-05-19) \u2014 the
      // customer's own PO / ref / SO so the warehouse can match against the
      // customer's paperwork while preparing the delivery. Sourced per-PO
      // from /api/production-orders (customerPOId + customerReference) and
      // sales_orders.customerSO (server-joined). "\u2014" when the customer
      // didn't supply that number.
      {
        key: "customerPOId",
        label: "Customer PO",
        type: "docno",
        width: "130px",
        sortable: true,
        render: (_v, row) => row.customerPOId
          ? <span className="doc-number">{row.customerPOId}</span>
          : <span className="text-[#9CA3AF]">{"\u2014"}</span>,
      },
      {
        key: "customerReference",
        label: "Customer Ref",
        type: "text",
        width: "130px",
        sortable: true,
        render: (_v, row) => row.customerReference
          ? <span className="text-[#1F1D1B]">{row.customerReference}</span>
          : <span className="text-[#9CA3AF]">{"\u2014"}</span>,
      },
      {
        key: "customerSO",
        label: "Customer SO",
        type: "docno",
        width: "130px",
        sortable: true,
        render: (_v, row) => row.customerSO
          ? <span className="doc-number">{row.customerSO}</span>
          : <span className="text-[#9CA3AF]">{"\u2014"}</span>,
      },
      { key: "quantity", label: "Qty", type: "number", width: "60px", align: "right", sortable: true },
      {
        // Sales Figure \u2014 this PO's SO line value (SO unit price \u00d7 qty),
        // same basis as the DO-based tabs so the money is comparable
        // across every delivery stage.
        key: "valueSen",
        label: "Amount",
        type: "text",
        width: "120px",
        sortable: true,
        render: (_v, row) => (
          <span className="font-medium text-[#1F1D1B] tabular-nums">
            {formatRM(row.valueSen ?? 0)}
          </span>
        ),
      },
      {
        // Set Status column (added 2026-05-06) \u2014 flags SOFA rows whose
        // sibling compartments aren't all ready, so an operator doesn't
        // ship a partial set (e.g. 3 of 5). BF/ACC render "\u2014" since each
        // piece ships independently. Selection is also guarded in
        // onSelectionChange so incomplete-set rows can't reach Create DO.
        key: "setStatus" as keyof ReadyPORow,
        label: "Set Status",
        type: "text",
        width: "160px",
        align: "left",
        sortable: false,
        render: (_v, row) => {
          if ((row.itemCategory || "").toUpperCase() !== "SOFA") {
            return <span className="text-[#9CA3AF]">{"\u2014"}</span>;
          }
          if (row.setComplete) {
            return (
              <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200 tabular-nums">
                {row.setReadySiblings}/{row.setTotalSiblings} Ship
              </span>
            );
          }
          const remaining = row.setTotalSiblings - row.setReadySiblings;
          return (
            <span
              className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-200 tabular-nums"
              title={`Set incomplete \u2014 ${remaining} sibling PO${remaining === 1 ? "" : "s"} still in production. Selection disabled.`}
            >
              {row.setReadySiblings}/{row.setTotalSiblings} {"\u2014"} {remaining} pending
            </span>
          );
        },
      },
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
        key: "packingCompletedDate",
        label: "Packed",
        type: "date",
        width: "110px",
        sortable: true,
        // Date = every packing card on the PO is completed (fully packed).
        // Blank = upholstery may be done but packing hasn't finished.
        render: (_v, row) => (
          <span className="tabular-nums">
            {row.packingCompletedDate ? formatDate(row.packingCompletedDate) : "-"}
          </span>
        ),
      },
      {
        key: "hookkaExpectedDD",
        label: "Expected DD",
        type: "date",
        width: "150px",
        sortable: true,
        render: (_v, row) => <EditableExpectedDD row={row} onSave={updateExpectedDD} />,
      },
    ],
    [selectedReadyPOs, updateExpectedDD]
  );

  // ---------- DO Columns ----------
  const columns: Column<DeliveryOrderRow>[] = useMemo(
    () => [
      {
        key: "_select",
        label: "",
        width: "40px",
        align: "center",
        render: (_value, row) => {
          const inPL = doPackingMap.get(row.id);
          // Stays selectable even when already in a packing list — the
          // operator still needs to select it for Mark Dispatched / Delivered.
          // The green PL badge column flags membership; "Create as Packing
          // List" skips already-grouped DOs so they're never double-added.
          return (
            <input
              type="checkbox"
              checked={selectedIds.has(row.id)}
              title={inPL ? `Already in ${inPL}` : undefined}
              onChange={(e) => {
                e.stopPropagation();
                toggleSelect(row.id);
              }}
              className="h-4 w-4 rounded border-[#E2DDD8] accent-[#6B5C32]"
            />
          );
        },
      },
      {
        key: "_packingList",
        label: "Packing List",
        width: "110px",
        align: "center",
        render: (_value, row) => {
          const inPL = doPackingMap.get(row.id);
          return inPL ? (
            <span className="inline-flex items-center rounded-full bg-[#EEF3E4] px-2 py-0.5 text-[11px] font-medium text-[#4F7C3A]">
              {inPL}
            </span>
          ) : (
            <span className="text-[#C9C2BA]">—</span>
          );
        },
      },
      {
        key: "_view",
        label: "",
        width: "46px",
        align: "center",
        render: (_value, row) => (
          <button
            type="button"
            title="View this DO (Print is inside)"
            onClick={(e) => {
              e.stopPropagation();
              setDetailDO(row);
            }}
            className="p-1 rounded hover:bg-[#F0ECE9] text-[#6B5C32] cursor-pointer"
          >
            <Eye className="h-4 w-4" />
          </button>
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
        render: (_value, row, _index, highlight) => {
          const sos = Array.from(
            new Set(
              (row.items || [])
                .map((it) => it.salesOrderNo)
                .filter((s): s is string => Boolean(s))
            )
          );
          if (sos.length === 0) {
            return <span className="text-[#9CA3AF]">{highlight(row.salesOrderId || "-")}</span>;
          }
          return <span className="text-[#1F1D1B]">{highlight(sos.join(", "))}</span>;
        },
      },
      // Customer-side reference numbers (operator request 2026-05-19) — the
      // customer's own PO / ref / SO so the warehouse can match against the
      // customer's paperwork while preparing / dispatching the delivery.
      // customerPOId is on the DO payload; customerRef / customerSO are
      // joined client-side from the already-loaded /api/sales-orders list
      // via the DO's salesOrderId (sales_orders.reference / .customerSO).
      // "—" when the customer didn't supply that number, or the linked SO
      // isn't in the loaded list.
      {
        key: "customerPOId",
        label: "Customer PO",
        type: "text",
        width: "150px",
        sortable: true,
        render: (_value, row, _index, highlight) => row.customerPOId
          ? <span className="text-[#1F1D1B]">{highlight(row.customerPOId)}</span>
          : <span className="text-[#9CA3AF]">{"—"}</span>,
      },
      {
        key: "customerRef",
        label: "Customer Ref",
        type: "text",
        width: "130px",
        sortable: true,
        render: (_value, row, _index, highlight) => row.customerRef
          ? <span className="text-[#1F1D1B]">{highlight(row.customerRef)}</span>
          : <span className="text-[#9CA3AF]">{"—"}</span>,
      },
      {
        key: "customerSO",
        label: "Customer SO",
        type: "text",
        width: "150px",
        sortable: true,
        render: (_value, row, _index, highlight) => row.customerSO
          ? <span className="text-[#1F1D1B]">{highlight(row.customerSO)}</span>
          : <span className="text-[#9CA3AF]">{"—"}</span>,
      },
      {
        // Wei Siang 2026-05-16: per-row Sales Figure — the DO's linked
        // sales-order line value (qty × SO unit price). Server-derived
        // (delivery_orders has no monetary column); same formula that
        // feeds the tab-strip aggregate so the column sums to the tab.
        key: "valueSen",
        label: "Amount",
        type: "text",
        width: "120px",
        sortable: true,
        render: (_value, row) => (
          <span className="font-medium text-[#1F1D1B] tabular-nums">
            {formatRM(row.valueSen ?? 0)}
          </span>
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
              {row.itemCount} item{row.itemCount === 1 ? "" : "s"} · {(row.totalM3 ?? 0).toFixed(2)} m³
            </span>
          </div>
        ),
      },
      // Transfer To — the invoice this delivered DO became (invoices.
      // deliveryOrderId = do.id). Only shown on the Delivered tab, where the
      // operator wants to see at a glance which DOs have already been turned
      // into an invoice (e.g. INV-2605-xxx) and which still need transferring.
      ...(activeTab === "delivered"
        ? [
            {
              key: "invoiceNo",
              label: "Transfer To",
              type: "text" as const,
              width: "150px",
              sortable: true,
              render: (_value: unknown, row: DeliveryOrderRow) =>
                row.invoiceNo ? (
                  // Match the normal doc-number style used everywhere else
                  // (DO No. / SO No. / Invoice No. all render as type "docno" =
                  // tabular-nums, default 12px text). Drops the olive-green
                  // monospace that made this column look out of place.
                  <span className="tabular-nums">{row.invoiceNo}</span>
                ) : (
                  <span className="text-[#9CA3AF]">Not invoiced</span>
                ),
            } as Column<DeliveryOrderRow>,
          ]
        : []),
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
          <span className="doc-number text-[#1F1D1B]">{row.vehicleNo || <span className="text-[#9CA3AF]">—</span>}</span>
        ),
      },
    ],
    [selectedIds, providers, doPackingMap, activeTab]
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
        // Unified: every "Print DO" entry point produces the SAME
        // canonical DO PDF (was previously the old HTML print here).
        action: () => void printDOPdf(row),
      },
      {
        label: "Print Packing List",
        icon: <FileText className="h-3.5 w-3.5" />,
        action: () => triggerPrint(row, "packing-list"),
      },
      {
        label: "QR — Driver Scan",
        icon: <QrCode className="h-3.5 w-3.5" />,
        action: () => setQrDialog({ kind: "DO", id: row.id, docNo: row.doNo }),
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Mark Dispatched",
        icon: <Send className="h-3.5 w-3.5" />,
        action: async () => {
          // 2026-05-27 verifiedSave migration — confirms the status flip
          // landed before reporting success.
          const result = await verifiedSave<DeliveryOrder>({
            endpoint: `/api/delivery-orders/${row.id}`,
            method: "PUT",
            body: { status: "LOADED" },
            readback: async () => {
              const r = await fetch(`/api/delivery-orders/${row.id}?_v=${Date.now()}`, {
                credentials: "include",
                cache: "no-store",
              });
              if (!r.ok) return null;
              const j = (await r.json()) as { success?: boolean; data?: DeliveryOrder } | DeliveryOrder;
              return (j as { data?: DeliveryOrder })?.data ?? (j as DeliveryOrder) ?? null;
            },
            expect: { status: "LOADED" },
          });
          if (!result.ok) {
            if (result.reason === "mismatch") toast.error(formatMismatchError(result.diffs));
            else if (result.reason === "http") {
              let parsedErr = result.body;
              try {
                const j = JSON.parse(result.body) as { error?: string };
                if (j.error) parsedErr = j.error;
              } catch { /* keep raw body */ }
              toast.error(parsedErr || `Failed to mark dispatched (HTTP ${result.status})`);
            } else toast.error(`Save failed: ${result.details}`);
          } else {
            // Dispatch notice (fire-and-forget) with the branded DO PDF.
            notifyCustomersAfterTransition([row], "DISPATCHED");
            // Feature B — warn (non-blocking) when the customer has no email.
            warnIfNoCustomerEmail(row, "DISPATCHED");
          }
          fetchData();
        },
        disabled: row.status !== "DRAFT",
      },
      {
        label: "Reverse to Pending Dispatch",
        icon: <Package className="h-3.5 w-3.5" />,
        action: async () => {
          if (!(await confirm({ title: "Reverse DO", message: "Reverse this DO back to Pending Dispatch?", danger: true }))) return;
          // 2026-05-27 verifiedSave migration.
          const result = await verifiedSave<DeliveryOrder>({
            endpoint: `/api/delivery-orders/${row.id}`,
            method: "PUT",
            body: { status: "DRAFT" },
            readback: async () => {
              const r = await fetch(`/api/delivery-orders/${row.id}?_v=${Date.now()}`, {
                credentials: "include",
                cache: "no-store",
              });
              if (!r.ok) return null;
              const j = (await r.json()) as { success?: boolean; data?: DeliveryOrder } | DeliveryOrder;
              return (j as { data?: DeliveryOrder })?.data ?? (j as DeliveryOrder) ?? null;
            },
            expect: { status: "DRAFT" },
          });
          if (!result.ok) {
            if (result.reason === "mismatch") toast.error(formatMismatchError(result.diffs));
            else if (result.reason === "http") {
              let parsedErr = result.body;
              try {
                const j = JSON.parse(result.body) as { error?: string };
                if (j.error) parsedErr = j.error;
              } catch { /* keep raw body */ }
              toast.error(parsedErr || `Failed to reverse (HTTP ${result.status})`);
            } else toast.error(`Save failed: ${result.details}`);
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
          // 2026-05-27 verifiedSave migration.
          const result = await verifiedSave<DeliveryOrder>({
            endpoint: `/api/delivery-orders/${row.id}`,
            method: "PUT",
            body: { status: "IN_TRANSIT" },
            readback: async () => {
              const r = await fetch(`/api/delivery-orders/${row.id}?_v=${Date.now()}`, {
                credentials: "include",
                cache: "no-store",
              });
              if (!r.ok) return null;
              const j = (await r.json()) as { success?: boolean; data?: DeliveryOrder } | DeliveryOrder;
              return (j as { data?: DeliveryOrder })?.data ?? (j as DeliveryOrder) ?? null;
            },
            expect: { status: "IN_TRANSIT" },
          });
          if (!result.ok) {
            if (result.reason === "mismatch") toast.error(formatMismatchError(result.diffs));
            else if (result.reason === "http") {
              let parsedErr = result.body;
              try {
                const j = JSON.parse(result.body) as { error?: string };
                if (j.error) parsedErr = j.error;
              } catch { /* keep raw body */ }
              toast.error(parsedErr || `Failed to mark in transit (HTTP ${result.status})`);
            } else toast.error(`Save failed: ${result.details}`);
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
      {
        // Feature A — per-DO Resend (row menu). Re-fires the customer invoice
        // email for a delivered/invoiced DO (force: clears the email-sent stamp
        // then re-queues the SAME notice helper). resendCustomerNotice confirms
        // first and surfaces the no-email case via a warning toast.
        label: "Resend invoice email",
        icon: <Mail className="h-3.5 w-3.5" />,
        action: () => resendCustomerNotice(row, "DELIVERED"),
        disabled:
          row.status !== "DELIVERED" && row.status !== "INVOICED",
      },
      {
        // Post-delivery: some goods came back. Opens the Delivery Return
        // builder pre-selecting this DO so the office ticks the returned lines
        // (partial). DELIVERED / INVOICED only.
        label: "Convert to Delivery Return",
        icon: <Undo2 className="h-3.5 w-3.5" />,
        action: () => navigate(`/delivery-returns?createFrom=${row.id}`),
        disabled:
          row.status !== "DELIVERED" && row.status !== "INVOICED",
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Refresh",
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        action: () => fetchData(),
      },
    ],
    [fetchData, navigate]
  );

  // ---------- Tab counts ----------
  const tabCounts: Record<string, number> = {
    planning: planningPOs.length,
    pending_delivery: readyPOs.length,
    pending_dispatch: pendingDispatchCount,
    dispatched: dispatchedCount,
    delivered: uniqueDOsByStatus.delivered,
    packing_list: packingLists.length,
  };

  // ---------- Tab RM value (Sales Figure in every bucket) ----------
  // Wei Siang 2026-05-16: show the money at every stage. Planning /
  // Pending Delivery are PO-based — sum each PO's SO line value (same
  // productCode × SO unit price basis the DO tabs use, so the figure is
  // comparable across the whole flow). DO tabs read the whole-dataset
  // /stats aggregate. "Dispatched" shows LOADED + IN_TRANSIT because the
  // tab lists both (TAB_DO_STATUSES.dispatched), so its money must too.
  const tabValueSen: Record<string, number | null> = {
    planning: planningPOs.reduce((s, p) => s + (p.valueSen || 0), 0),
    pending_delivery: readyPOs.reduce((s, p) => s + (p.valueSen || 0), 0),
    pending_dispatch: valueDOsByStatus.draft,
    dispatched: valueDOsByStatus.dispatched + valueDOsByStatus.inTransit,
    delivered: valueDOsByStatus.delivered,
  };

  return (
    <div className="space-y-6 max-md:space-y-4">
      {/* Top-level tab bar */}
      <div className="flex items-center gap-1 border-b border-[#E2DDD8] overflow-x-auto">
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
        <button
          onClick={() => setPageTab("agent")}
          className={`flex items-center gap-2 px-4 pb-3 pt-1 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            pageTab === "agent"
              ? "border-[#6B5C32] text-[#6B5C32]"
              : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
          }`}
        >
          <Bot className="h-4 w-4" /> Delivery Agent
        </button>
      </div>

      {/* Delivery Agent — proposal-first TMS surface (see agent-tab.tsx). */}
      {pageTab === "agent" && <DeliveryAgentTab />}

      {pageTab === "orders" && <>
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Delivery Orders</h1>
          <p className="text-xs text-[#6B7280]">
            Manage delivery orders, packing lists, and dispatch tracking
          </p>
        </div>
        {/* Selection actions (Create as Packing List / Mark Dispatched /
            Mark Delivered) all live in the grid card header now, right next
            to the row selection, so they're easy to find. */}
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FAEFCB] p-2.5 shrink-0">
              <Package className="h-5 w-5 text-[#9C6F1E]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#9C6F1E]">{loading ? "-" : pendingDispatchCount}</p>
              <p className="text-xs text-[#6B7280]">Pending Dispatch</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#E0EDF0] p-2.5 shrink-0">
              <Send className="h-5 w-5 text-[#3E6570]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#3E6570]">{loading ? "-" : dispatchedCount}</p>
              <p className="text-xs text-[#6B7280]">Dispatched</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#F1E6F0] p-2.5 shrink-0">
              <Truck className="h-5 w-5 text-[#6B4A6D]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#6B4A6D]">{loading ? "-" : inTransitCount}</p>
              <p className="text-xs text-[#6B7280]">In Transit</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#EEF3E4] p-2.5 shrink-0">
              <CheckCircle2 className="h-5 w-5 text-[#4F7C3A]" />
            </div>
            <div className="min-w-0">
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
              className={`flex flex-col items-start gap-0.5 pb-3 text-sm font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                activeTab === tab.key
                  ? "border-[#6B5C32] text-[#6B5C32]"
                  : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
              }`}
            >
              <span className="flex items-center gap-2">
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
              </span>
              {/* Wei Siang 2026-05-16: RM value of the bucket. DO-based
                  tabs only; Planning / Pending Delivery show nothing
                  (PO-based, price not loaded here yet). */}
              {tabValueSen[tab.key] != null && (
                <span className="text-[10px] font-normal text-[#9CA3AF] tabular-nums">
                  {formatRM(tabValueSen[tab.key] as number)}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* ============================================================== */}
      {/* Tab Content                                                     */}
      {/* ============================================================== */}

      {/* Cross-stage match bar — while searching, show which stages the term
          hits (with counts) so a match on another tab is never hidden behind
          an empty grid. Tap a chip to jump there. */}
      {search.trim() && searchTabCounts && Object.values(searchTabCounts).some((n) => n > 0) && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2 text-sm">
          <span className="text-[#6B7280]">
            Matches for <span className="font-semibold text-[#1F1D1B]">&ldquo;{search.trim()}&rdquo;</span>:
          </span>
          {ALL_TABS.filter((t) => (searchTabCounts[t.key] ?? 0) > 0).map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                activeTab === t.key
                  ? "border-[#6B5C32] bg-[#6B5C32] text-white"
                  : "border-[#E2DDD8] bg-white text-[#4B5563] hover:border-[#6B5C32]/40",
              )}
            >
              {t.label}
              <span className="tabular-nums opacity-80">{searchTabCounts[t.key]}</span>
            </button>
          ))}
        </div>
      )}

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
              virtualize
              maxHeight="calc(100vh - 280px)"
              emptyMessage="No items in planning."
              groupBy="customerState"
              autoGroup={false}
              initialSearch={search}
              onSearchChange={setSearch}
              alwaysSearchKeys={PO_SEARCH_KEYS}
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
                <div className="flex items-center gap-2">
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
                  {/* Packing-List-first: mixed customers/hubs allowed — the
                      backend auto-splits into one DO per customer + hub and
                      wraps every DO into ONE packing list. */}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={creatingDOFromPO || plFirstCreating}
                    onClick={openPlFirstDialog}
                  >
                    <ClipboardList className="h-3.5 w-3.5" /> Create Packing List ({selectedReadyPOs.size})
                  </Button>
                </div>
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
              virtualize
              maxHeight="calc(100vh - 280px)"
              emptyMessage="No items pending delivery."
              groupBy="customerState"
              autoGroup={false}
              selectable
              initialSearch={search}
              onSearchChange={setSearch}
              alwaysSearchKeys={PO_SEARCH_KEYS}
              onSelectionChange={(rows) =>
                // Drop incomplete SOFA sets defensively — even if the user
                // clicks the row's checkbox, an incomplete set can't make
                // it into selectedReadyPOs and therefore can't reach the
                // Create DO POST. setComplete is true for BF/ACC and for
                // ready SOFA sets, false only for partial SOFA sets.
                setSelectedReadyPOs(
                  new Set(rows.filter((r) => r.setComplete).map((r) => r.id)),
                )
              }
            />
          </CardContent>
        </Card>
      )}

      {/* ---- DO-based tabs: Pending Dispatch / Dispatched / Delivered ---- */}
      {!PO_TABS.has(activeTab) && activeTab !== "packing_list" && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Truck className="h-5 w-5 text-[#6B5C32]" /> Delivery Orders
              </CardTitle>
              <div className="flex items-center gap-3 flex-wrap">
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
                {/* Primary action once DOs are ticked — sits right next to the
                    selection so it's obvious (the old top-toolbar copy was far
                    from the grid and got missed). */}
                {selectedIds.size > 0 && (
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handlePrintPackingList}
                    >
                      <ClipboardList className="h-3.5 w-3.5" /> Create as Packing List ({selectedIds.size})
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleMarkDispatched}>
                      <Send className="h-3.5 w-3.5" /> Mark Dispatched
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleMarkDelivered}>
                      <CheckCircle2 className="h-3.5 w-3.5" /> Mark Delivered
                    </Button>
                  </>
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
              virtualize
              maxHeight="calc(100vh - 280px)"
              emptyMessage="No delivery orders found."
              onDoubleClick={(row) => setDetailDO(row)}
              initialSearch={search}
              onSearchChange={setSearch}
              alwaysSearchKeys={DO_SEARCH_KEYS}
              contextMenuItems={getContextMenuItems}
            />

            {/* Pagination footer */}
            <div className="flex items-center justify-between border-t border-[#E2DDD8] pt-3 mt-3 text-sm text-[#6B7280] flex-wrap gap-2">
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

      {/* ---- Packing List Tab ---- */}
      {activeTab === "packing_list" && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <ClipboardList className="h-5 w-5 text-[#6B5C32]" /> Packing Lists
              </CardTitle>
              <span className="text-xs text-[#6B7280]">
                One saved sheet per truck run, grouped by hub. Print to load the truck.
              </span>
            </div>
          </CardHeader>
          <CardContent>
            {packingLists.length === 0 ? (
              <div className="py-12 text-center text-sm text-[#6B7280]">
                No packing lists yet. Go to{" "}
                <span className="font-medium">Pending Dispatch</span>, tick the DOs
                going on one truck, then click{" "}
                <span className="font-medium">Create as Packing List</span>.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    {/* whitespace-nowrap inherits to every th/td: a squeezed
                        table was mid-word-wrapping "PL-2606-010" onto three
                        lines and splitting "RM" from its amount (owner
                        screenshot 2026-06-11). Long free text (Remarks) is
                        explicitly clipped with truncate instead. */}
                    <tr className="border-b border-[#E2DDD8] text-left text-xs text-[#6B7280] whitespace-nowrap">
                      <th className="py-2 px-3 font-medium">Packing No</th>
                      <th className="py-2 px-3 font-medium text-center">DOs</th>
                      <th className="py-2 px-3 font-medium text-center">Stops</th>
                      <th className="py-2 px-3 font-medium text-center">State</th>
                      <th className="py-2 px-3 font-medium text-center">Units</th>
                      <th className="py-2 px-3 font-medium text-right">Total M³</th>
                      <th className="py-2 px-3 font-medium text-right">Revenue</th>
                      <th className="py-2 px-3 font-medium text-right">Cost</th>
                      <th className="py-2 px-3 font-medium text-center">Delivery</th>
                      <th className="py-2 px-3 font-medium">Created</th>
                      <th className="py-2 px-3 font-medium">Remarks</th>
                      <th className="py-2 px-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {packingLists.map((pl) => (
                      <tr
                        key={pl.id}
                        className="border-b border-[#F0ECE9] hover:bg-[#FAF9F7]"
                      >
                        <td className="py-2.5 px-3 font-medium text-[#1F1D1B] whitespace-nowrap">
                          {pl.packingNo}
                        </td>
                        <td className="py-2.5 px-3 text-center tabular-nums">
                          {pl.doCount ?? pl.stopCount}
                        </td>
                        <td className="py-2.5 px-3 text-center tabular-nums">
                          {pl.stops ?? "—"}
                        </td>
                        <td className="py-2.5 px-3 text-center whitespace-nowrap">
                          {pl.states && pl.states.length > 0
                            ? pl.states.join(", ")
                            : "—"}
                        </td>
                        <td className="py-2.5 px-3 text-center tabular-nums">
                          {pl.totalUnits}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums">
                          {pl.totalM3.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                          {formatRM(pl.revenueSen ?? 0)}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                          {pl.costSen == null ? "—" : formatRM(pl.costSen)}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          {(() => {
                            // Live rollup of the member DOs' statuses — the
                            // PL mirrors the DOs, so a status change on
                            // either side shows here on the next load.
                            const cnt = pl.doStatusCounts;
                            const total = cnt
                              ? cnt.pending + cnt.dispatched + cnt.delivered
                              : 0;
                            if (!cnt || total === 0)
                              return <span className="text-[#9CA3AF]">—</span>;
                            if (cnt.delivered === total)
                              return (
                                <span className="inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium bg-[#E3EBE6] text-[#2F5D3F]">
                                  Delivered {total}/{total}
                                </span>
                              );
                            if (cnt.dispatched + cnt.delivered > 0)
                              return (
                                <span className="inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium bg-[#E0EDF0] text-[#3E6570]">
                                  Dispatched {cnt.dispatched + cnt.delivered}/{total}
                                </span>
                              );
                            return (
                              <span className="inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium bg-[#F5EDDC] text-[#9C6F1E]">
                                Pending {total}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="py-2.5 px-3 text-[#6B7280] whitespace-nowrap">
                          {pl.createdAt ? formatDate(pl.createdAt) : "-"}
                        </td>
                        {/* Remarks is the one free-text cell — clip it with an
                            ellipsis instead of letting it wrap the row taller;
                            the full text shows on hover via title. */}
                        <td
                          className="py-2.5 px-3 text-[#6B7280] max-w-[180px] truncate"
                          title={pl.remarks || undefined}
                        >
                          {pl.remarks || "-"}
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="flex items-center justify-end gap-2">
                            {(pl.doStatusCounts?.pending ?? 0) > 0 && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={plBulkBusy !== null}
                                onClick={() => void runPlBulkTransition(pl, "LOADED")}
                              >
                                <Send className="h-3.5 w-3.5" /> Dispatch
                              </Button>
                            )}
                            {(pl.doStatusCounts?.dispatched ?? 0) > 0 && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={plBulkBusy !== null}
                                onClick={() => void runPlBulkTransition(pl, "DELIVERED")}
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" /> Delivered
                              </Button>
                            )}
                            {/* Icon-only with hover tooltips — five labeled
                                buttons per row squeezed the data columns into
                                mid-word wraps (owner screenshot 2026-06-11).
                                Dispatch / Delivered keep their labels above:
                                they change real order status and must read
                                unambiguously. */}
                            <Button
                              variant="outline"
                              size="sm"
                              title="QR — drivers scan to mark Dispatched / Delivered"
                              onClick={() =>
                                setQrDialog({
                                  kind: "PL",
                                  id: pl.id,
                                  docNo: pl.packingNo,
                                })
                              }
                            >
                              <QrCode className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              title="Edit"
                              onClick={() => void handleEditPackingList(pl)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              title="View"
                              onClick={() => void handlePrintPackingListRecord(pl, "view")}
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              title="Print"
                              onClick={() => void handlePrintPackingListRecord(pl, "download")}
                            >
                              <Printer className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              title="Delete"
                              onClick={() => void handleDeletePackingList(pl)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
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

      {/* ---------- Packing-List-first Dialog (auto-split by customer + hub) ---------- */}
      {plFirstDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => { if (!plFirstCreating) setPlFirstDialogOpen(false); }}
          />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            <div className="px-6 py-4 border-b border-[#E2DDD8]">
              <h2 className="text-lg font-bold text-[#1F1D1B]">Create Packing List</h2>
              <p className="text-xs text-[#6B7280]">
                Splits the selected orders into one delivery order per customer + hub, then groups every new DO into one packing list.
              </p>
            </div>
            <div className="px-6 py-5 space-y-4">
              {/* Grouping preview — fetched from the backend (the same split
                  creation enforces), so the table can never drift from what
                  the confirm button will actually create. */}
              <div>
                <label className="text-xs text-[#6B7280] font-medium mb-2 block">
                  Delivery order split
                  {plFirstGroups
                    ? ` — will create ${plFirstGroups.length} delivery order${plFirstGroups.length === 1 ? "" : "s"}`
                    : ""}
                </label>
                {plFirstPreviewError ? (
                  <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-xs text-rose-700">
                    {plFirstPreviewError}
                  </div>
                ) : plFirstGroups === null ? (
                  <div className="bg-[#FAF9F7] border border-[#E2DDD8] rounded-lg p-3 text-xs text-[#6B7280]">
                    Loading grouping preview...
                  </div>
                ) : (
                  <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-[#FAF9F7] text-[#6B7280]">
                          <th className="text-left px-3 py-2 font-medium">#</th>
                          <th className="text-left px-3 py-2 font-medium">Customer</th>
                          <th className="text-left px-3 py-2 font-medium">Hub</th>
                          <th className="text-left px-3 py-2 font-medium">State</th>
                          <th className="text-right px-3 py-2 font-medium">Orders</th>
                          <th className="text-right px-3 py-2 font-medium">Units</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plFirstGroups.map((g, i) => (
                          <tr key={`${g.customerId}-${g.hubId}-${i}`} className="border-t border-[#F0ECE9]">
                            <td className="px-3 py-2 text-[#9CA3AF] whitespace-nowrap">DO {i + 1}</td>
                            <td className="px-3 py-2 font-medium text-[#1F1D1B]">{g.customerName}</td>
                            <td className="px-3 py-2 text-[#6B7280]">{g.hubName || "—"}</td>
                            <td className="px-3 py-2 text-[#6B7280]">{g.customerState || "—"}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{g.poCount}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{g.unitCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* 3PL Provider — required: the whole truck run shares one
                  provider; it is stamped onto every DO the split creates. */}
              <div>
                <label className="text-xs text-[#6B7280] font-medium">
                  3PL Provider <span className="text-rose-600">*</span>
                </label>
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

              {/* Vehicle / Lorry — optional, shared across all the new DOs. */}
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

              {/* Est. Delivery Cost — each new DO is one customer + one hub
                  = one drop, so every DO costs the flat per-trip rate
                  (vehicle rate beats company rate, same as DO create). */}
              <div className="flex items-center justify-between bg-[#F5F3F0] rounded-lg px-3 py-2">
                <span className="text-xs text-[#6B7280]">Est. Delivery Cost</span>
                <span className="text-sm font-semibold text-[#1F1D1B]">
                  {(() => {
                    const n = plFirstGroups?.length ?? 0;
                    const v = createDialogVehicles.find((vv) => vv.id === createDOForm.vehicleId);
                    const perTripSen = v
                      ? v.ratePerTripSen
                      : providers.find((pr) => pr.id === createDOForm.driverId)?.ratePerTripSen;
                    if (!n || perTripSen == null) return "—";
                    return `${n} DO × RM ${(perTripSen / 100).toFixed(2)} = RM ${((n * perTripSen) / 100).toFixed(2)}`;
                  })()}
                </span>
              </div>

              {/* Delivery Date — shared by every DO in the run. Optional. */}
              <div>
                <label className="text-xs text-[#6B7280] font-medium">Delivery Date</label>
                <input
                  type="date"
                  value={createDOForm.deliveryDate}
                  onChange={(e) => setCreateDOForm((f) => ({ ...f, deliveryDate: e.target.value }))}
                  className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                />
              </div>

              {/* Remarks — stamped on every DO and on the packing list. */}
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
              <Button
                variant="outline"
                disabled={plFirstCreating}
                onClick={() => setPlFirstDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={confirmCreatePlFirst}
                disabled={
                  plFirstCreating ||
                  plFirstGroups === null ||
                  plFirstGroups.length === 0 ||
                  !!plFirstPreviewError ||
                  !createDOForm.driverId
                }
              >
                {plFirstCreating ? (
                  <><RefreshCw className="h-4 w-4 animate-spin" /> Creating...</>
                ) : (
                  <>
                    <ClipboardList className="h-4 w-4" /> Create Packing List
                    {plFirstGroups && plFirstGroups.length > 0
                      ? ` + ${plFirstGroups.length} DO${plFirstGroups.length === 1 ? "" : "s"}`
                      : ""}
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Create Packing List Dialog ---------- */}
      {printDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => { if (!plCreating) { setPrintDialog(null); setEditingPL(null); } }} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 border border-[#E2DDD8]">
            <div className="px-6 py-4 border-b border-[#E2DDD8]">
              <h2 className="text-lg font-bold text-[#1F1D1B]">
                {editingPL ? `Edit Packing List ${editingPL.packingNo}` : "Create Packing List"}
              </h2>
              <p className="text-xs text-[#6B7280]">
                {editingPL
                  ? `Re-assign the driver, lorry & 3PL provider for these ${printDialog.length} delivery order${printDialog.length === 1 ? "" : "s"}. The change is saved onto every DO in the list.`
                  : `Groups these ${printDialog.length} delivery order${printDialog.length === 1 ? "" : "s"} into one saved packing list. Print it from the Packing List tab.`}
              </p>
            </div>
            <div className="px-6 py-5 space-y-3">
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {printDialog.map((d) => (
                  <div key={d.id} className="flex items-center justify-between text-sm bg-[#FAF9F7] rounded-lg px-3 py-2">
                    <span className="font-mono font-medium text-[#1F1D1B]">{d.doNo}</span>
                    <span className="text-[#6B7280]">{d.customerName}{d.hubName ? ` · ${d.hubName}` : ""}</span>
                  </div>
                ))}
              </div>

              {/* Assign the truck for this run — written onto every DO above. */}
              <div className="border-t border-[#E2DDD8] pt-3 space-y-3">
                <p className="text-xs font-medium text-[#1F1D1B]">
                  Assign driver &amp; lorry{" "}
                  <span className="font-normal text-[#9CA3AF]">
                    — saved onto all {printDialog.length} DO{printDialog.length === 1 ? "" : "s"}
                  </span>
                </p>
                <div>
                  <label className="text-xs text-[#6B7280] font-medium">3PL Provider</label>
                  <select
                    value={plProviderId}
                    onChange={(e) => {
                      setPlProviderId(e.target.value);
                      setPlVehicleId("");
                      setPlDriverPersonId("");
                    }}
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
                <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                  <div>
                    <label className="text-xs text-[#6B7280] font-medium">Lorry</label>
                    <select
                      value={plVehicleId}
                      onChange={(e) => setPlVehicleId(e.target.value)}
                      disabled={!plProviderId}
                      className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32] disabled:bg-[#F9F7F5] disabled:text-[#999]"
                    >
                      <option value="">{plProviderId ? "— Select —" : "Pick provider first"}</option>
                      {plDialogVehicles
                        .filter((v) => v.status === "ACTIVE")
                        .map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.plateNo} — {v.vehicleType || "—"}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-[#6B7280] font-medium">Driver</label>
                    <select
                      value={plDriverPersonId}
                      onChange={(e) => setPlDriverPersonId(e.target.value)}
                      disabled={!plProviderId}
                      className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32] disabled:bg-[#F9F7F5] disabled:text-[#999]"
                    >
                      <option value="">{plProviderId ? "— Select —" : "Pick provider first"}</option>
                      {plDialogDrivers
                        .filter((d) => d.status === "ACTIVE")
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                            {d.phone ? ` — ${d.phone}` : ""}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              </div>

              {!editingPL && (
                <div>
                  <label className="text-xs text-[#6B7280] font-medium">Remarks (optional)</label>
                  <input
                    type="text"
                    value={plRemarks}
                    onChange={(e) => setPlRemarks(e.target.value)}
                    placeholder="e.g. Lorry A — morning run"
                    className="mt-1 w-full h-9 px-3 rounded-md border border-[#E2DDD8] text-sm focus:outline-none focus:border-[#6B5C32]"
                  />
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-[#E2DDD8] flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => { setPrintDialog(null); setEditingPL(null); }} disabled={plCreating}>Cancel</Button>
              {editingPL ? (
                <Button variant="primary" onClick={handleConfirmEditPackingList} disabled={plCreating}>
                  {plCreating ? (
                    <><RefreshCw className="h-4 w-4 animate-spin" /> Saving...</>
                  ) : (
                    <><Pencil className="h-4 w-4" /> Save Changes</>
                  )}
                </Button>
              ) : (
                <Button variant="primary" onClick={handleConfirmCreatePackingList} disabled={plCreating}>
                  {plCreating ? (
                    <><RefreshCw className="h-4 w-4 animate-spin" /> Creating...</>
                  ) : (
                    <><ClipboardList className="h-4 w-4" /> Create Packing List</>
                  )}
                </Button>
              )}
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
              <div className="grid grid-cols-2 gap-3 text-sm max-sm:grid-cols-1">
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
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-5xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
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
                        if (!(await confirm({ title: "Delete DO", message: `Delete ${detailDO.doNo}? Items will return to Pending Delivery.`, danger: true }))) return;
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
                      onClick={() => void printDOPdf(detailDO)}
                      className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors"
                      title="Print DO"
                    >
                      <Printer className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => void printDOPdf(detailDO, "view")}
                      className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors"
                      title="View Documentation (opens on screen)"
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
            <div className="px-6 py-5 space-y-5 max-md:px-4 max-sm:px-3">
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
                  <div className="grid grid-cols-3 gap-4 text-sm max-sm:grid-cols-1">
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
                  <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
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
                        type="number" onFocus={(e) => e.currentTarget.select()}
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
                  <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
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
                  <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
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
                  <div className="grid grid-cols-3 gap-4 text-sm max-sm:grid-cols-1">
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
                        {/* tabular-nums (NOT doc-number) so a long
                            multi-SO list wraps onto further lines instead
                            of running off the modal. */}
                        <p className="font-medium tabular-nums break-words leading-relaxed">
                          {sos.join(", ")}
                        </p>
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
                    <div className="grid grid-cols-2 gap-4 text-sm max-sm:grid-cols-1">
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
                    <div className="grid grid-cols-2 gap-4 text-sm max-sm:grid-cols-1">
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
                    <div className="grid grid-cols-2 gap-4 text-sm max-sm:grid-cols-1">
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
                          // A blank Deliver-To is a data fault (the hub/
                          // address never resolved) — flag it red instead of a
                          // silent "-" so the operator fixes it before the
                          // truck rolls (Wei Siang 2026-06-11).
                          if (!addr.trim()) {
                            return (
                              <p className="font-medium text-xs text-[#DC2626]">
                                ⚠ No delivery address — check the delivery hub
                              </p>
                            );
                          }
                          return (
                            <p className="font-medium text-xs">{addr}</p>
                          );
                        })()}
                      </div>
                      {(() => {
                        // Delivery State — sourced from the hub (set when the
                        // Sales Order was created), the reliable signal for
                        // where this DO goes. Shown on Pending / Dispatch so the
                        // 3PL state matches (Wei Siang 2026-06-11).
                        const raw = detailDO.hubState || detailDO.hubBranch || "";
                        const code = resolveStateCode(raw);
                        const label =
                          MALAYSIA_STATES.find((s) => s.code === code)?.label ?? raw;
                        return (
                          <div>
                            <p className="text-[#9CA3AF] text-xs mb-0.5">Delivery State</p>
                            {label ? (
                              <p className="font-medium text-xs">{label}</p>
                            ) : (
                              <p className="font-medium text-xs text-[#DC2626]">
                                ⚠ No state — check the delivery hub
                              </p>
                            )}
                          </div>
                        );
                      })()}
                      <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
                        <div>
                          <p className="text-[#9CA3AF] text-xs mb-0.5">Recipient Contact</p>
                          <p className="font-medium">{detailDO.contactPerson || "-"}</p>
                        </div>
                        <div>
                          <p className="text-[#9CA3AF] text-xs mb-0.5">Recipient Phone</p>
                          <p className="font-medium doc-number">{detailDO.contactPhone || "-"}</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
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

                {/* Customer PO / SO / Ref now live per row in the table
                    below — a DO can consolidate several sales orders, so a
                    single DO-level summary was misleading. */}

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
                            <div className="flex items-center gap-3 flex-wrap">
                              <span className="text-[#3E6570]">{po.poNo}</span>
                              <span className="text-[#6B7280]">{po.salesOrderNo}</span>
                              {/* Customer-side refs so the packer can match the
                                  customer's own paperwork while picking, not just
                                  the company SO no. (user request 2026-06-02). */}
                              {po.customerPOId && (
                                <span className="text-[#6B7280]">PO: <span className="text-[#1F1D1B]">{po.customerPOId}</span></span>
                              )}
                              {po.customerSO && (
                                <span className="text-[#6B7280]">Cust SO: <span className="text-[#1F1D1B]">{po.customerSO}</span></span>
                              )}
                              <span>{po.productName}</span>
                              <RepairPartsBadge repairScope={po.repairScope} productCode={po.productCode} />
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
                        <th className="text-left px-2.5 py-1.5 font-medium text-xs">#</th>
                        <th className="text-left px-2.5 py-1.5 font-medium text-xs whitespace-nowrap">SO ID</th>
                        <th className="text-left px-2.5 py-1.5 font-medium text-xs whitespace-nowrap">Customer PO</th>
                        <th className="text-left px-2.5 py-1.5 font-medium text-xs whitespace-nowrap">Customer SO</th>
                        <th className="text-left px-2.5 py-1.5 font-medium text-xs whitespace-nowrap">Customer Ref</th>
                        <th className="text-left px-2.5 py-1.5 font-medium text-xs whitespace-nowrap">Product Code</th>
                        <th className="text-left px-2.5 py-1.5 font-medium text-xs whitespace-nowrap">Variant</th>
                        <th className="text-left px-2.5 py-1.5 font-medium text-xs whitespace-nowrap">Product Name</th>
                        <th className="text-left px-2.5 py-1.5 font-medium text-xs">Size</th>
                        <th className="text-left px-2.5 py-1.5 font-medium text-xs">Fabric</th>
                        <th className="text-right px-2.5 py-1.5 font-medium text-xs">Qty</th>
                        <th className="text-right px-2.5 py-1.5 font-medium text-xs">M³</th>
                        <th className="text-left px-2.5 py-1.5 font-medium text-xs">Rack</th>
                        {editMode && <th className="text-center px-2.5 py-1.5 font-medium text-xs w-[40px]"></th>}
                      </tr>
                    </thead>
                    <tbody>
                      {/* Sort a COPY for display only — by customer PO
                          ascending (blanks last), then SO — so identical
                          Customer PO / SO group together instead of
                          scattering across non-adjacent rows. editItems /
                          detailDO.items themselves are untouched, so totals
                          and the saved order never change. */}
                      {[...(editMode ? editItems : detailDO.items)]
                        .sort((a, b) => {
                          const ra = lineRefs(a);
                          const rb = lineRefs(b);
                          return compareDoLinesByCustomerPO(
                            { customerPOId: ra.customerPOId, salesOrderNo: ra.salesOrderNo },
                            { customerPOId: rb.customerPOId, salesOrderNo: rb.salesOrderNo },
                          );
                        })
                        .map((item, idx) => {
                        const refs = lineRefs(item);
                        return (
                        <tr key={item.id} className="border-t border-[#E2DDD8]">
                          <td className="px-2.5 py-1 text-[#9CA3AF] text-xs whitespace-nowrap">{idx + 1}</td>
                          <td className="px-2.5 py-1 text-xs text-[#6B7280] whitespace-nowrap">{refs.salesOrderNo || item.poNo || "—"}</td>
                          <td className="px-2.5 py-1 text-xs text-[#1F1D1B] whitespace-nowrap">{refs.customerPOId || "—"}</td>
                          <td className="px-2.5 py-1 text-xs text-[#1F1D1B] whitespace-nowrap">{refs.customerSO || "—"}</td>
                          <td className="px-2.5 py-1 text-xs text-[#6B7280] whitespace-nowrap">{refs.customerRef || "—"}</td>
                          <td className="px-2.5 py-1 text-xs text-[#6B5C32] whitespace-nowrap">{item.productCode}</td>
                          <td className="px-2.5 py-1 text-xs text-[#6B7280] whitespace-nowrap">{(() => { const c = item.productCode || ""; const i = c.indexOf("-"); return i >= 0 ? c.slice(i + 1) : "—"; })()}</td>
                          <td className="px-2.5 py-1 whitespace-nowrap">
                            <span className="inline-flex flex-col items-start gap-0.5">
                              <span>{item.productName}</span>
                              <RepairPartsBadge repairScope={item.repairScope} productCode={item.productCode} />
                            </span>
                          </td>
                          <td className="px-2.5 py-1 text-[#6B7280] whitespace-nowrap">{item.sizeLabel}</td>
                          <td className="px-2.5 py-1 text-[#6B7280] whitespace-nowrap">{item.fabricCode}</td>
                          <td className="px-2.5 py-1 text-right tabular-nums">{item.quantity}</td>
                          <td className="px-2.5 py-1 text-right tabular-nums">{(item.itemM3 * item.quantity).toFixed(2)}</td>
                          <td className="px-2.5 py-1 text-xs text-[#6B7280]">{item.rackingNumber || "—"}</td>
                          {editMode && (
                            <td className="px-2.5 py-1 text-center">
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
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-[#FAF9F7]">
                      <tr className="border-t border-[#E2DDD8] font-medium">
                        <td colSpan={10} className="px-2.5 py-1 text-right text-xs text-[#6B7280]">Total</td>
                        <td className="px-2.5 py-1 text-right tabular-nums">
                          {(editMode ? editItems : detailDO.items).reduce((s, i) => s + i.quantity, 0)}
                        </td>
                        <td className="px-2.5 py-1 text-right tabular-nums">
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
                          // 2026-05-27 verifiedSave migration.
                          const result = await verifiedSave<DeliveryOrder>({
                            endpoint: `/api/delivery-orders/${detailDO.id}`,
                            method: "PUT",
                            body: { status: "LOADED" },
                            readback: async () => {
                              const r = await fetch(`/api/delivery-orders/${detailDO.id}?_v=${Date.now()}`, {
                                credentials: "include",
                                cache: "no-store",
                              });
                              if (!r.ok) return null;
                              const j = (await r.json()) as { success?: boolean; data?: DeliveryOrder } | DeliveryOrder;
                              return (j as { data?: DeliveryOrder })?.data ?? (j as DeliveryOrder) ?? null;
                            },
                            expect: { status: "LOADED" },
                          });
                          if (result.ok) {
                            // Dispatch notice (fire-and-forget) with the
                            // branded DO PDF attached.
                            notifyCustomersAfterTransition([detailDO], "DISPATCHED");
                            // Feature B — warn (non-blocking) when no email.
                            warnIfNoCustomerEmail(detailDO, "DISPATCHED");
                            setDetailDO({ ...detailDO, status: "LOADED", dispatchDate: new Date().toISOString() });
                            fetchData();
                          } else if (result.reason === "mismatch") {
                            toast.error(formatMismatchError(result.diffs));
                          } else if (result.reason === "http") {
                            let parsedErr = result.body;
                            try {
                              const j = JSON.parse(result.body) as { error?: string };
                              if (j.error) parsedErr = j.error;
                            } catch { /* keep raw body */ }
                            toast.error(parsedErr || `Failed to mark dispatched (HTTP ${result.status})`);
                          } else {
                            toast.error(`Save failed: ${result.details}`);
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
                  {/* Feature A — per-DO Resend invoice email. Shown once the DO
                      is delivered/invoiced (the states the invoice notice
                      fires for). Disabled when the customer has no email on
                      file (with a "no email on file" hint), since there is
                      nowhere to send it. */}
                  {(detailDO.status === "DELIVERED" ||
                    detailDO.status === "INVOICED") && (
                    <Button
                      variant="outline"
                      disabled={!detailEmail || resendingId === detailDO.id}
                      title={
                        detailEmail
                          ? `Re-send the invoice email to ${detailEmail}`
                          : "No email on file — add the PIC Email on the customer"
                      }
                      onClick={() =>
                        resendCustomerNotice(detailDO, "DELIVERED")
                      }
                    >
                      {resendingId === detailDO.id ? (
                        <>
                          <RefreshCw className="h-4 w-4 animate-spin" /> Sending...
                        </>
                      ) : (
                        <>
                          <Mail className="h-4 w-4" />{" "}
                          {detailEmail
                            ? "Resend invoice email"
                            : "No email on file"}
                        </>
                      )}
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
                      <th className="text-left px-4 py-2 font-medium">States Covered</th>
                      <th className="text-right px-4 py-2 font-medium">Vehicles</th>
                      <th className="text-right px-4 py-2 font-medium">Drivers</th>
                      <th className="text-center px-4 py-2 font-medium">Status</th>
                      <th className="text-right px-4 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providersLoading ? (
                      <tr><td colSpan={8} className="text-center py-8 text-[#6B7280]">Loading...</td></tr>
                    ) : filteredProviders.length === 0 ? (
                      <tr><td colSpan={8} className="text-center py-8 text-[#6B7280]">No providers found.</td></tr>
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
                          <td className="px-4 py-2">
                            {(p.ratedStates ?? []).length === 0 ? (
                              <span className="text-[#9CA3AF]">&mdash;</span>
                            ) : (
                              <div className="flex flex-wrap gap-1 max-w-[260px]">
                                {(p.ratedStates ?? []).map((code) => (
                                  <span
                                    key={code}
                                    className="inline-block px-1.5 py-0.5 rounded border border-[#E2DDD8] bg-[#F9F7F5] text-[#6B5C32] text-[10px] font-mono font-medium"
                                  >
                                    {code}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{p.vehicleCount ?? 0}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{p.driverCount ?? 0}</td>
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
              <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-5xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
                {/* Sticky header + section pills (house big-dialog style) */}
                <div className="sticky top-0 bg-white border-b border-[#E2DDD8] rounded-t-xl z-10">
                  <div className="px-6 py-4 flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-bold text-[#1F1D1B]">
                        {providerDialog === "new" ? "New 3PL Provider" : "Edit 3PL Provider"}
                      </h2>
                      <p className="text-xs text-[#6B7280]">
                        {providerDialog === "new"
                          ? "Create the company first, then add state rates, vehicles and drivers"
                          : (providerDialog as ThreePLProvider).name}
                      </p>
                    </div>
                    <button onClick={() => setProviderDialog(null)} className="p-1.5 rounded hover:bg-[#F0ECE9] text-[#6B7280]">
                      <X className="h-5 w-5" />
                    </button>
                  </div>
                  <div className="px-6 pb-3 flex items-center gap-2 flex-wrap">
                    {(
                      [
                        { key: "info", label: "Info" },
                        {
                          key: "rates",
                          label: `State Rate Card (${
                            Object.values(stateRates).filter(
                              (r) => (Number(r.trip) || 0) > 0 || (Number(r.drop) || 0) > 0,
                            ).length
                          })`,
                        },
                        { key: "fleet", label: `Fleet (${providerVehicles.length})` },
                        { key: "drivers", label: `Drivers & Contacts (${providerDrivers.length})` },
                      ] as { key: ProviderDialogTab; label: string }[]
                    ).map((t) => (
                      <button
                        key={t.key}
                        onClick={() => setProviderDialogTab(t.key)}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                          providerDialogTab === t.key
                            ? "bg-[#111827] text-white"
                            : "bg-white text-[#6B7280] border border-[#E2DDD8] hover:bg-[#F3F4F6]"
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="px-6 py-5 space-y-5">
                  {/* --- Section 1: Info — company-level fields --- */}
                  {providerDialogTab === "info" && (
                  <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
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
                  )}

                  {/* --- Section 2: State Rate Card --- */}
                  {/* Fixed 16-row grid, one row per canonical Malaysia state.
                      Inputs are RM; saved to the backend in sen via the one
                      "Save Rates" button (PUT /api/three-pl-state-rates/bulk).
                      Blank / 0 = provider does not serve that state (0/0 =
                      unset house rule) — the list's "States Covered" badges
                      skip those. */}
                  {providerDialogTab === "rates" && (
                  <div>
                    <div className="flex items-start justify-between mb-2 gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-[#1F1D1B]">State Rate Card</h3>
                        <p className="text-xs text-[#6B7280]">
                          Per-state pricing for this provider. Leave a row blank for states it does not serve.
                        </p>
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={saveStateRates}
                        disabled={!currentProviderId || ratesSaving || ratesLoading}
                      >
                        {ratesSaving ? (
                          <><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Saving...</>
                        ) : (
                          <><Save className="h-3.5 w-3.5 mr-1" /> Save Rates</>
                        )}
                      </Button>
                    </div>
                    {!currentProviderId ? (
                      <div className="text-xs text-[#6B7280] py-3 px-2 bg-[#F9F7F5] rounded-md border border-[#E2DDD8]">
                        Save the provider first to set state rates.
                      </div>
                    ) : (
                      <div className="border border-[#E2DDD8] rounded-md overflow-hidden">
                        <table className="w-full text-xs">
                          <thead className="bg-[#F9F7F5] text-[#6B7280]">
                            <tr>
                              <th className="text-left px-3 py-1.5 font-medium">State</th>
                              <th className="text-right px-3 py-1.5 font-medium w-44">Base / Trip (RM)</th>
                              <th className="text-right px-3 py-1.5 font-medium w-44">Per Extra Drop (RM)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {MALAYSIA_STATES.map((s) => {
                              const row = stateRates[s.code] ?? { trip: "", drop: "" };
                              return (
                                <tr key={s.code} className="border-t border-[#E2DDD8]">
                                  <td className="px-3 py-1.5">
                                    <span className="inline-block w-9 font-mono text-[10px] text-[#6B7280]">{s.code}</span>
                                    <span className="font-medium text-[#1F1D1B]">{s.label}</span>
                                  </td>
                                  <td className="px-3 py-1.5 text-right">
                                    <input
                                      type="number" min="0" step="0.01"
                                      onFocus={(e) => e.currentTarget.select()}
                                      value={row.trip}
                                      onChange={(e) => {
                                        const v = e.target.value;
                                        setStateRates((prev) => ({
                                          ...prev,
                                          [s.code]: { ...(prev[s.code] ?? { trip: "", drop: "" }), trip: v },
                                        }));
                                        setRatesDirty(true);
                                      }}
                                      disabled={ratesLoading || ratesSaving}
                                      className="w-36 h-8 px-2 rounded border border-[#E2DDD8] text-xs text-right focus:outline-none focus:border-[#6B5C32] disabled:bg-[#F9F7F5]"
                                    />
                                  </td>
                                  <td className="px-3 py-1.5 text-right">
                                    <input
                                      type="number" min="0" step="0.01"
                                      onFocus={(e) => e.currentTarget.select()}
                                      value={row.drop}
                                      onChange={(e) => {
                                        const v = e.target.value;
                                        setStateRates((prev) => ({
                                          ...prev,
                                          [s.code]: { ...(prev[s.code] ?? { trip: "", drop: "" }), drop: v },
                                        }));
                                        setRatesDirty(true);
                                      }}
                                      disabled={ratesLoading || ratesSaving}
                                      className="w-36 h-8 px-2 rounded border border-[#E2DDD8] text-xs text-right focus:outline-none focus:border-[#6B5C32] disabled:bg-[#F9F7F5]"
                                    />
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {currentProviderId && ratesLoading && (
                      <div className="text-xs text-[#6B7280] mt-2">Loading rates...</div>
                    )}
                    {currentProviderId && ratesDirty && !ratesSaving && (
                      <div className="text-xs text-[#B45309] mt-2">
                        Unsaved changes — click "Save Rates" to apply.
                      </div>
                    )}
                  </div>
                  )}

                  {/* --- Section 3: Fleet — Vehicles sub-table --- */}
                  {providerDialogTab === "fleet" && (
                  <div>
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
                              {/* Per-truck rates are legacy overrides now —
                                  per-state pricing lives on the State Rate
                                  Card. Kept (Phase 1 changes no cost math). */}
                              <th className="text-right px-2 py-1.5 font-medium">Override Rate/Trip (legacy)</th>
                              <th className="text-right px-2 py-1.5 font-medium">Override +Drop (legacy)</th>
                              <th className="text-left px-2 py-1.5 font-medium">Box (L×W×H ft)</th>
                              <th className="text-left px-2 py-1.5 font-medium">Status</th>
                              <th className="text-right px-2 py-1.5 font-medium w-20">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {providerVehicles.length === 0 ? (
                              <tr>
                                <td colSpan={8} className="text-center text-[#6B7280] py-3">
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
                                  <td className="px-2 py-1.5 whitespace-nowrap tabular-nums">
                                    {v.boxLengthFt != null && v.boxWidthFt != null && v.boxHeightFt != null
                                      ? `${v.boxLengthFt.toFixed(2)} × ${v.boxWidthFt.toFixed(2)} × ${v.boxHeightFt.toFixed(2)}`
                                      : "-"}
                                  </td>
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
                        <div className="grid grid-cols-3 gap-2 max-sm:grid-cols-1">
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
                              type="number" onFocus={(e) => e.currentTarget.select()}
                              value={vehicleForm.capacityM3}
                              onChange={(e) => setVehicleForm((f) => ({ ...f, capacityM3: e.target.value }))}
                              className="mt-1 w-full h-8 px-2 rounded border border-[#E2DDD8] text-xs focus:outline-none focus:border-[#6B5C32]"
                            />
                            <p className="mt-0.5 text-[10px] text-[#9CA3AF]">
                              Auto-calculated from L×W×H (ft)
                            </p>
                          </div>
                          <div>
                            <label className="text-[10px] text-[#6B7280] font-medium">Override Rate/Trip (RM, legacy)</label>
                            <input
                              type="number" onFocus={(e) => e.currentTarget.select()}
                              step="0.01"
                              value={vehicleForm.ratePerTripRM}
                              onChange={(e) => setVehicleForm((f) => ({ ...f, ratePerTripRM: e.target.value }))}
                              className="mt-1 w-full h-8 px-2 rounded border border-[#E2DDD8] text-xs focus:outline-none focus:border-[#6B5C32]"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-[#6B7280] font-medium">Override +Drop (RM, legacy)</label>
                            <input
                              type="number" onFocus={(e) => e.currentTarget.select()}
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
                          {/* Box dimensions row — optional, three inputs on one line */}
                          <div>
                            <label className="text-[10px] text-[#6B7280] font-medium">Length (ft)</label>
                            <input
                              type="number" onFocus={(e) => e.currentTarget.select()}
                              step="0.01"
                              value={vehicleForm.boxLengthFt}
                              onChange={(e) => setVehicleForm((f) => withAutoCap({ ...f, boxLengthFt: e.target.value }))}
                              className="mt-1 w-full h-8 px-2 rounded border border-[#E2DDD8] text-xs focus:outline-none focus:border-[#6B5C32]"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-[#6B7280] font-medium">Width (ft)</label>
                            <input
                              type="number" onFocus={(e) => e.currentTarget.select()}
                              step="0.01"
                              value={vehicleForm.boxWidthFt}
                              onChange={(e) => setVehicleForm((f) => withAutoCap({ ...f, boxWidthFt: e.target.value }))}
                              className="mt-1 w-full h-8 px-2 rounded border border-[#E2DDD8] text-xs focus:outline-none focus:border-[#6B5C32]"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-[#6B7280] font-medium">Height (ft)</label>
                            <input
                              type="number" onFocus={(e) => e.currentTarget.select()}
                              step="0.01"
                              value={vehicleForm.boxHeightFt}
                              onChange={(e) => setVehicleForm((f) => withAutoCap({ ...f, boxHeightFt: e.target.value }))}
                              className="mt-1 w-full h-8 px-2 rounded border border-[#E2DDD8] text-xs focus:outline-none focus:border-[#6B5C32]"
                            />
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
                  )}

                  {/* --- Section 4: Drivers & Contacts — Drivers sub-table --- */}
                  {providerDialogTab === "drivers" && (
                  <div>
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
                        <div className="grid grid-cols-3 gap-2 max-sm:grid-cols-1">
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
                  )}
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

      {/* Hidden Print Container — rendered at page level so it's accessible
          from any tab. The PrintDO root carries `hidden print:block` so it's
          display:none on screen and only renders into the print pipeline.
          Pre-2026-05-12 this was wrapped in a `position: fixed; z-index: -1`
          stacking context, which made Save-as-PDF capture the print template
          BEHIND the page's white background → completely blank output. The
          existing production FG / Job Card sticker prints already used the
          `hidden print:block` pattern; this brings PrintDO in line. */}
      {printData && (
        <PrintDO ref={printRef} data={printData.data} mode={printData.mode} />
      )}

      {/* Delivery-status QR (DO or PL — driver scan → /d/<token>, no login) */}
      {qrDialog && (
        <DoQrDialog
          open
          kind={qrDialog.kind}
          recordId={qrDialog.id}
          docNo={qrDialog.docNo}
          onClose={() => setQrDialog(null)}
        />
      )}
    </div>
  );
}
