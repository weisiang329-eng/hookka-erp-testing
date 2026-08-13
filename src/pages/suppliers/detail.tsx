// ---------------------------------------------------------------------------
// Supplier Detail — unified per-supplier page (2026-06-20).
//
// Reads:
//   GET /api/suppliers/:id                    Supplier info
//   GET /api/supplier-scorecards/:id          Scorecard + last-10 POs
//   GET /api/supplier-materials?supplierId=   Pricing & SKUs
//   GET /api/price-history?supplierId=        Price History trail
//   GET /api/purchase-orders                  All POs (filtered to this supplier in FE)
//
// Layout:
//   - ObjectPageHeader: supplier code/name/status, Edit + Quotation PDF buttons
//   - Supplier Info card: contact, email, phone, payment terms, address
//   - Scorecard tiles (3 KPI cards) + Last 10 POs table
//   - Sub-tabs: [ Pricing & SKUs | Price History ]
//     • Pricing & SKUs : SKU mappings CRUD (DataGrid + SKUFormDialog)
//     • Price History  : PO-based purchase history (primary) + price_histories trail
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ObjectPageHeader } from "@/components/ui/object-page-header";
import { DataGrid, type Column } from "@/components/ui/data-grid";
import { useCachedJson, invalidateCachePrefix, isUnknownOutcome } from "@/lib/cached-fetch";
import { RecordLoadError } from "@/components/ui/record-load-error";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { humanizeError } from "@/lib/humanize-error";
import { formatCurrency, formatDate, formatRM } from "@/lib/utils";
import type { Supplier, PriceHistory } from "@/types";
import {
  SKUFormDialog,
  type SupplierSKU,
  type SkuFormSupplier,
  type SkuFormInventoryItem,
} from "@/pages/procurement/sku-form-dialog";
import {
  SupplierFormDialog,
  type OrgOption,
  type PaymentTerms,
  type SupplierStatus,
  type SupplierFormData,
} from "@/pages/procurement/supplier-form-dialog";
import {
  ArrowLeft,
  Building2,
  Clock,
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
  Package,
  Plus,
  Pencil,
  Trash2,
  FileText,
  Search,
  ShoppingCart,
} from "lucide-react";

type SkuBinding = {
  id: string;
  materialCode: string;
  materialName: string;
  supplierSku: string;
  supplierDescription?: string;
  unitPrice: number;
  currency: string;
  leadTimeDays: number;
  moq: number;
  isMainSupplier: boolean;
  // Effective-dated pricing: the date this price takes effect. Legacy rows
  // surface priceValidFrom (kept for back-compat reads).
  effectiveFrom?: string;
  priceValidFrom?: string;
  priceValidTo?: string;
};

type ScorecardLastPO = {
  id: string;
  poNo: string;
  status: string;
  orderDate: string;
  expectedDate: string;
  receivedDate: string;
  totalSen: number;
  orderedQty: number;
  receivedQty: number;
};

type ScorecardDetail = {
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  onTimeRate: number;
  defectRate: number;
  averageLeadDays: number;
  totalPOs: number;
  receivedPOs: number;
  onTimeCount: number;
  overallRating: number;
  last10POs: ScorecardLastPO[];
};

// One row per PO line item for the purchase history DataGrid.
type POLineRow = {
  id: string;        // unique: `${poId}-${itemId}`
  poId: string;
  poNo: string;
  orderDate: string;
  materialCode: string;
  materialName: string;
  qty: number;
  unitPriceSen: number;
  lineTotalSen: number;
};

type RawPOItem = {
  id: string;
  materialCode: string;
  materialName: string;
  quantity: number;
  unitPriceSen: number;
  totalSen: number;
};

type RawPO = {
  id: string;
  poNo: string;
  supplierId: string;
  orderDate: string;
  items: RawPOItem[];
};

function deliveryDelta(po: ScorecardLastPO): {
  label: string;
  tone: "neutral" | "ok" | "late";
} {
  if (!po.expectedDate || !po.receivedDate) {
    return { label: "-", tone: "neutral" };
  }
  const exp = new Date(po.expectedDate).getTime();
  const rec = new Date(po.receivedDate).getTime();
  if (!Number.isFinite(exp) || !Number.isFinite(rec)) {
    return { label: "-", tone: "neutral" };
  }
  const diffDays = Math.round((rec - exp) / 86400000);
  if (diffDays <= 0) {
    return {
      label: diffDays === 0 ? "on time" : `${-diffDays}d early`,
      tone: "ok",
    };
  }
  return { label: `${diffDays}d late`, tone: "late" };
}

export default function SupplierDetailPage() {
  const { id } = useParams();
  const { confirm } = useConfirm();

  const { data: supResp, loading: supLoading, failure: supFailure, refresh: refreshSupplier } = useCachedJson<{
    success?: boolean;
    data?: Supplier;
    error?: string;
  }>(id ? `/api/suppliers/${id}` : null);
  const { data: scoreResp, loading: scoreLoading } = useCachedJson<{
    success?: boolean;
    data?: ScorecardDetail;
    error?: string;
  }>(id ? `/api/supplier-scorecards/${id}` : null);
  const { data: skuResp } = useCachedJson<{
    success?: boolean;
    data?: SkuBinding[];
  }>(id ? `/api/supplier-materials?supplierId=${id}` : null);
  const skus = useMemo(
    () => (skuResp?.success ? skuResp.data ?? [] : []),
    [skuResp],
  );

  // Suppliers list — needed by the SKU form dialog's supplier dropdown.
  // We only show ACTIVE entries in the dropdown; the dialog filters that
  // itself, so just feed the full list.
  const { data: suppliersResp } = useCachedJson<
    { success?: boolean; data?: Record<string, unknown>[] } | Record<string, unknown>[]
  >("/api/suppliers");
  const supplierOptions: SkuFormSupplier[] = useMemo(() => {
    const list = Array.isArray((suppliersResp as { data?: unknown[] })?.data)
      ? ((suppliersResp as { data: Record<string, unknown>[] }).data)
      : Array.isArray(suppliersResp)
        ? (suppliersResp as Record<string, unknown>[])
        : [];
    return list.map((s) => ({
      id: String(s.id ?? s.code ?? ""),
      code: String(s.code ?? s.id ?? ""),
      name: String(s.name ?? ""),
      status: String(
        s.status ?? (s.isActive === false ? "INACTIVE" : "ACTIVE"),
      ),
    }));
  }, [suppliersResp]);

  // Inventory items — for the dialog's RM autocomplete.
  const { data: invResp } = useCachedJson<{
    success?: boolean;
    data?: {
      rawMaterials?: SkuFormInventoryItem[];
      finishedGoods?: SkuFormInventoryItem[];
      wipItems?: SkuFormInventoryItem[];
    };
  }>("/api/inventory");
  const inventoryItems: SkuFormInventoryItem[] = useMemo(() => {
    if (!invResp?.success || !invResp.data) return [];
    return [
      ...(invResp.data.rawMaterials || []),
      ...(invResp.data.finishedGoods || []),
      ...(invResp.data.wipItems || []),
    ].map((item) => ({
      id: item.id,
      itemCode: item.itemCode,
      description: item.description,
      baseUOM: item.baseUOM,
      itemGroup: item.itemGroup,
    }));
  }, [invResp]);

  // Organisation list — feeds the Edit Supplier dialog's Purchase Company
  // dropdown (mirrors /procurement/maintenance). Only code + legal name.
  const { data: orgsResp } = useCachedJson<{
    organisations?: Array<{ code: string; name: string; isActive?: boolean }>;
  }>("/api/organisations");
  const orgOptions: OrgOption[] = useMemo(() => {
    const list = orgsResp?.organisations ?? [];
    return list
      .filter((o) => o.isActive !== false)
      .map((o) => ({ code: o.code, name: o.name }));
  }, [orgsResp]);

  // Sub-tabs: Pricing & SKUs | Price History
  const [skuTab, setSkuTab] = useState<"pricing" | "price-history">("pricing");

  // Price History — fetched lazily when the tab is first opened
  const { data: historyResp } = useCachedJson<{ success?: boolean; data?: PriceHistory[] } | PriceHistory[]>(
    skuTab === "price-history" && id ? `/api/price-history?supplierId=${id}` : null
  );
  const priceHistory: PriceHistory[] = useMemo(
    () => ((historyResp as { data?: PriceHistory[] } | undefined)?.data ?? (Array.isArray(historyResp) ? historyResp as PriceHistory[] : [])),
    [historyResp]
  );
  const sortedHistory = useMemo(
    () =>
      [...priceHistory].sort((a, b) => {
        // Newest effective date first; tie-break on the recorded change date.
        const ae = a.effectiveFrom || a.changedDate;
        const be = b.effectiveFrom || b.changedDate;
        return be.localeCompare(ae) || (b.changedDate || "").localeCompare(a.changedDate || "");
      }),
    [priceHistory]
  );

  // PO purchase history — fetched lazily when Price History tab opens.
  // /api/purchase-orders returns ALL POs; we filter to this supplier client-side.
  const { data: allPOsResp } = useCachedJson<{ success?: boolean; data?: RawPO[] }>(
    skuTab === "price-history" && id ? "/api/purchase-orders" : null
  );
  const poLines: POLineRow[] = useMemo(() => {
    const pos: RawPO[] = allPOsResp?.success ? (allPOsResp.data ?? []) : [];
    const rows: POLineRow[] = [];
    for (const po of pos) {
      if (po.supplierId !== id) continue;
      for (const item of po.items ?? []) {
        rows.push({
          id: `${po.id}-${item.id}`,
          poId: po.id,
          poNo: po.poNo,
          orderDate: po.orderDate ?? "",
          materialCode: item.materialCode ?? "",
          materialName: item.materialName ?? "",
          qty: item.quantity,
          unitPriceSen: item.unitPriceSen,
          lineTotalSen: item.totalSen,
        });
      }
    }
    // Newest order first by default
    return rows.sort((a, b) => b.orderDate.localeCompare(a.orderDate) || a.poNo.localeCompare(b.poNo));
  }, [allPOsResp, id]);

  // Filter state for the PO lines table
  const [poFilter, setPoFilter] = useState("");
  const [matFilter, setMatFilter] = useState("");

  const filteredPoLines = useMemo(() => {
    const pf = poFilter.trim().toLowerCase();
    const mf = matFilter.trim().toLowerCase();
    return poLines.filter((r) => {
      if (pf && !r.poNo.toLowerCase().includes(pf)) return false;
      if (mf && !r.materialCode.toLowerCase().includes(mf) && !r.materialName.toLowerCase().includes(mf)) return false;
      return true;
    });
  }, [poLines, poFilter, matFilter]);

  // Sort state for the PO lines table
  const [poSort, setPoSort] = useState<{ key: keyof POLineRow; dir: "asc" | "desc" }>({
    key: "orderDate",
    dir: "desc",
  });

  function toggleSort(key: keyof POLineRow) {
    setPoSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" }
    );
  }

  const sortedPoLines = useMemo(() => {
    const { key, dir } = poSort;
    return [...filteredPoLines].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      let cmp = 0;
      if (typeof av === "number" && typeof bv === "number") {
        cmp = av - bv;
      } else {
        cmp = String(av ?? "").localeCompare(String(bv ?? ""), undefined, { numeric: true });
      }
      return dir === "asc" ? cmp : -cmp;
    });
  }, [filteredPoLines, poSort]);

  // SKU dialog state
  const [showSKUForm, setShowSKUForm] = useState(false);
  const [editingSKU, setEditingSKU] = useState<SupplierSKU | null>(null);

  // Supplier edit dialog state
  const [showSupplierForm, setShowSupplierForm] = useState(false);

  async function handleSaveSupplier(data: SupplierFormData) {
    if (!id) return;
    // Mirrors the list page's edit path: PUT /api/suppliers/:id then refresh
    // the cached supplier so the Supplier Info card reflects the change.
    const res = await fetch(`/api/suppliers/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      alert(humanizeError({ status: res.status, message: j?.error }, "Couldn't save. Please try again."));
      return;
    }
    invalidateCachePrefix(`/api/suppliers/${id}`);
    invalidateCachePrefix("/api/suppliers");
    setShowSupplierForm(false);
  }

  function bindingToSKU(b: SkuBinding): SupplierSKU {
    return {
      id: b.id,
      internalRMCode: b.materialCode,
      materialName: b.materialName,
      supplierId: id ?? "",
      supplierSku: b.supplierSku,
      supplierDescription: b.supplierDescription ?? "",
      unitPriceSen: b.unitPrice,
      currency: b.currency || "MYR",
      leadTimeDays: b.leadTimeDays,
      moq: b.moq,
      isMainSupplier: b.isMainSupplier,
      // Effective From (effective-dated model); fall back to the legacy
      // priceValidFrom for rows that predate the migration.
      effectiveFrom: b.effectiveFrom ?? b.priceValidFrom ?? "",
    };
  }

  async function handleSaveSKU(data: Omit<SupplierSKU, "id">) {
    const payload = {
      supplierId: data.supplierId,
      materialCode: data.internalRMCode,
      materialName: data.materialName,
      supplierSku: data.supplierSku,
      supplierDescription: data.supplierDescription,
      unitPrice: data.unitPriceSen,
      currency: data.currency,
      leadTimeDays: data.leadTimeDays,
      moq: data.moq,
      isMainSupplier: data.isMainSupplier,
      effectiveFrom: data.effectiveFrom,
    };
    const url = editingSKU
      ? `/api/supplier-materials/${editingSKU.id}`
      : "/api/supplier-materials";
    const method = editingSKU ? "PUT" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      alert(humanizeError({ status: res.status, message: j?.error }, "Couldn't save. Please try again."));
      return;
    }
    invalidateCachePrefix("/api/supplier-materials");
    setShowSKUForm(false);
    setEditingSKU(null);
  }

  async function handleDeleteSKU(b: SkuBinding) {
    if (!(await confirm({ title: "Delete SKU mapping", message: `Delete SKU mapping for ${b.materialCode}?`, danger: true }))) return;
    const res = await fetch(`/api/supplier-materials/${b.id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      alert(humanizeError({ status: res.status, message: j?.error }, "Couldn't delete. Please try again."));
      return;
    }
    invalidateCachePrefix("/api/supplier-materials");
  }

  const supplier: Supplier | null = useMemo(
    () => (supResp?.success ? supResp.data ?? null : null),
    [supResp],
  );
  const score: ScorecardDetail | null = useMemo(
    () => (scoreResp?.success ? scoreResp.data ?? null : null),
    [scoreResp],
  );

  // SKU mappings grid columns. Replaces the old hand-rolled <table> so columns
  // are resizable (drag right edge, persisted per-user in localStorage) and
  // long descriptions clip instead of overflowing. The inline Edit + Delete
  // actions are preserved via a custom render on the Actions column so they
  // stay visible (not buried in a right-click menu). Double-click-to-edit is
  // wired through DataGrid's onDoubleClick below.
  //
  // MEMOISED (must be — and must sit above the early returns to keep hook order
  // stable): a fresh `columns` array every render makes the DataGrid recompute
  // visibleColumns → filteredData → sortedData on EVERY parent render. While the
  // SKU dialog is open, each keystroke re-renders this page, so an unstable
  // reference made the 11-row grid underneath re-filter/re-sort on every key —
  // wasted work that pegs the main thread. The handlers it closes over
  // (setEditingSKU/setShowSKUForm are stable; bindingToSKU/handleDeleteSKU are
  // hoisted declarations) don't change between renders, so an empty dep list is
  // correct here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const skuColumns: Column<SkuBinding>[] = useMemo(() => [
    { key: "materialCode", label: "Internal Code", type: "docno", width: "130px", sortable: true },
    { key: "materialName", label: "Internal Description", type: "text", width: "260px", sortable: true },
    { key: "supplierSku", label: "Supplier Code", type: "text", width: "150px", sortable: true },
    {
      key: "supplierDescription",
      label: "Supplier Description",
      type: "text",
      width: "260px",
      sortable: true,
      render: (_val: unknown, row: SkuBinding) => (
        <span className="text-[#6B7280]">{row.supplierDescription || "—"}</span>
      ),
    },
    {
      key: "unitPrice",
      label: "Unit Price",
      width: "120px",
      align: "right",
      sortable: true,
      render: (_val: unknown, row: SkuBinding) => (
        <span className="text-[#1F1D1B]">
          {formatCurrency(row.unitPrice)} {row.currency !== "MYR" ? row.currency : ""}
        </span>
      ),
    },
    {
      key: "leadTimeDays",
      label: "Lead Time",
      width: "100px",
      align: "right",
      sortable: true,
      render: (_val: unknown, row: SkuBinding) => <span>{row.leadTimeDays}d</span>,
    },
    { key: "moq", label: "MOQ", type: "number", width: "80px", align: "right", sortable: true },
    {
      key: "isMainSupplier",
      label: "Main",
      width: "80px",
      sortable: true,
      render: (_val: unknown, row: SkuBinding) =>
        row.isMainSupplier ? (
          <Badge className="bg-green-50 text-green-800 border-green-300">Main</Badge>
        ) : (
          <span className="text-[#9CA3AF] text-xs">—</span>
        ),
    },
    {
      key: "actions",
      label: "Actions",
      width: "90px",
      align: "right",
      render: (_val: unknown, row: SkuBinding) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            title="Edit"
            onClick={(e) => {
              e.stopPropagation();
              setEditingSKU(bindingToSKU(row));
              setShowSKUForm(true);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Delete"
            className="text-[#9A3A2D] hover:text-[#7A2E24]"
            onClick={(e) => {
              e.stopPropagation();
              handleDeleteSKU(row);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
    },
  ], []);

  if (supLoading || scoreLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#6B5C32]" />
      </div>
    );
  }

  // A read that never landed is not an absent supplier (BUG-2026-08-13-016).
  if (!supplier && supFailure && isUnknownOutcome(supFailure)) {
    return (
      <RecordLoadError
        subject="supplier"
        failure={supFailure}
        onRetry={refreshSupplier}
        backTo="/procurement/maintenance"
        backLabel="Back to suppliers"
      />
    );
  }

  if (!supplier) {
    return (
      <div className="space-y-4">
        <Link to="/procurement/maintenance" className="inline-flex items-center gap-2 text-sm text-[#6B5C32] hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to suppliers
        </Link>
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-sm text-[#6B7280]">Supplier not found.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const otr = score?.onTimeRate ?? 0;
  const otrTone =
    otr >= 90 ? "text-[#4F7C3A]" : otr >= 75 ? "text-[#9C6F1E]" : "text-[#9A3A2D]";
  const defect = score?.defectRate ?? 0;
  const defectTone =
    defect <= 1 ? "text-[#4F7C3A]" : defect <= 3 ? "text-[#9C6F1E]" : "text-[#9A3A2D]";

  return (
    <div className="space-y-6">
      <ObjectPageHeader
        backTo="/procurement/maintenance"
        title={
          <span className="inline-flex items-center gap-2">
            <Building2 className="h-5 w-5 text-[#6B5C32]" />
            {supplier.code} - {supplier.name}
          </span>
        }
        subtitle="Supplier scorecard and recent purchase order history"
        badges={<Badge variant="status" status={supplier.status} />}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const { generateSupplierQuotationPdf } = await import(
                  "@/lib/generate-supplier-quotation-pdf"
                );
                generateSupplierQuotationPdf(
                  {
                    code: supplier.code,
                    name: supplier.name,
                    address: supplier.address,
                    contactPerson: supplier.contactPerson,
                    email: supplier.email,
                    phone: supplier.phone,
                    purchaseOrgCode: supplier.purchaseOrgCode,
                  },
                  skus.map((b) => ({
                    materialCode: b.materialCode,
                    materialName: b.materialName,
                    supplierSku: b.supplierSku,
                    supplierDescription: b.supplierDescription,
                    unitPriceSen: b.unitPrice,
                    currency: b.currency,
                    leadTimeDays: b.leadTimeDays,
                    moq: b.moq,
                    effectiveFrom: b.effectiveFrom ?? b.priceValidFrom,
                  })),
                );
              }}
            >
              <FileText className="h-4 w-4" />
              Quotation PDF
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowSupplierForm(true)}
            >
              <Pencil className="h-4 w-4" />
              Edit Supplier
            </Button>
          </>
        }
      />

      {/* Header card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Supplier Info</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-[#9CA3AF] mb-0.5">Contact</p>
              <p className="text-[#374151]">{supplier.contactPerson || "-"}</p>
            </div>
            <div>
              <p className="text-xs text-[#9CA3AF] mb-0.5">Email</p>
              <p className="text-[#374151] truncate" title={supplier.email}>{supplier.email || "-"}</p>
            </div>
            <div>
              <p className="text-xs text-[#9CA3AF] mb-0.5">Phone</p>
              <p className="text-[#374151]">{supplier.phone || "-"}</p>
            </div>
            <div>
              <p className="text-xs text-[#9CA3AF] mb-0.5">Payment terms</p>
              <p className="text-[#374151]">{supplier.paymentTerms || "-"}</p>
            </div>
            {supplier.address && (
              <div className="col-span-2 md:col-span-4">
                <p className="text-xs text-[#9CA3AF] mb-0.5">Address</p>
                <p className="text-[#374151]">{supplier.address}</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Scorecard tiles */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-[#6B7280]">On-Time Rate</p>
              <CheckCircle2 className="h-4 w-4 text-[#4F7C3A]" />
            </div>
            <p className={`text-2xl font-bold ${otrTone}`}>
              {otr.toFixed(1)}%
            </p>
            <p className="text-[11px] text-[#9CA3AF] mt-1">
              {score?.onTimeCount ?? 0} of {score?.receivedPOs ?? 0} received POs on time
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-[#6B7280]">Defect Rate</p>
              <AlertTriangle className="h-4 w-4 text-[#9A3A2D]" />
            </div>
            <p className={`text-2xl font-bold ${defectTone}`}>
              {defect.toFixed(2)}%
            </p>
            <p className="text-[11px] text-[#9CA3AF] mt-1">
              Rejected qty / total received qty across posted GRNs
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-[#6B7280]">Average Lead Days</p>
              <Clock className="h-4 w-4 text-[#3E6570]" />
            </div>
            <p className="text-2xl font-bold text-[#1F1D1B]">
              {(score?.averageLeadDays ?? 0).toFixed(1)}
            </p>
            <p className="text-[11px] text-[#9CA3AF] mt-1">
              Days from order to receipt (received POs only)
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Pricing & SKUs + Price History sub-tabs */}
      <Card>
        <CardHeader className="pb-0">
          <div className="flex items-center justify-between flex-wrap gap-2 pb-3">
            <div className="flex gap-1 border-b border-[#E2DDD8] w-full pb-0">
              {(["pricing", "price-history"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setSkuTab(tab)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    skuTab === tab
                      ? "border-[#6B5C32] text-[#6B5C32]"
                      : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                  }`}
                >
                  {tab === "pricing" ? (
                    <span className="flex items-center gap-1.5">
                      <Package className="h-3.5 w-3.5" />
                      Pricing &amp; SKUs
                      <span className="text-xs text-[#9CA3AF] font-normal">({skus.length})</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <ShoppingCart className="h-3.5 w-3.5" />
                      Price History
                      {poLines.length > 0 && (
                        <span className="text-xs text-[#9CA3AF] font-normal">({poLines.length} lines)</span>
                      )}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>

        {/* Pricing & SKUs tab */}
        {skuTab === "pricing" && (
          <>
            <CardHeader className="pt-2 pb-3">
              <div className="flex items-center justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setEditingSKU(null);
                    setShowSKUForm(true);
                  }}
                >
                  <Plus className="h-4 w-4" /> Add SKU Mapping
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {skus.length === 0 ? (
                <p className="text-sm text-[#9CA3AF] py-6 text-center">
                  No SKU mappings yet for this supplier.
                </p>
              ) : (
                <DataGrid<SkuBinding>
                  columns={skuColumns}
                  data={skus}
                  keyField="id"
                  gridId="supplier-detail-sku-mappings"
                  onDoubleClick={(row) => {
                    setEditingSKU(bindingToSKU(row));
                    setShowSKUForm(true);
                  }}
                  emptyMessage="No SKU mappings yet for this supplier."
                  stickyHeader
                  maxHeight="calc(100vh - 420px)"
                />
              )}
            </CardContent>
          </>
        )}

        {/* Price History tab */}
        {skuTab === "price-history" && (
          <CardContent className="pt-4 space-y-8">

            {/* ── Section 1: PO Purchase History ── */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <ShoppingCart className="h-4 w-4 text-[#6B5C32]" />
                <h3 className="text-sm font-semibold text-[#1F1D1B]">
                  Purchase Order History
                </h3>
                <span className="text-xs text-[#9CA3AF]">— all PO lines for this supplier</span>
              </div>

              {/* Filter bar */}
              <div className="flex flex-wrap gap-2 mb-3">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#9CA3AF]" />
                  <input
                    type="text"
                    placeholder="Filter by PO No."
                    value={poFilter}
                    onChange={(e) => setPoFilter(e.target.value)}
                    className="pl-8 pr-3 h-8 text-sm border border-[#E2DDD8] rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-[#6B5C32] w-44"
                  />
                </div>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#9CA3AF]" />
                  <input
                    type="text"
                    placeholder="Filter by material"
                    value={matFilter}
                    onChange={(e) => setMatFilter(e.target.value)}
                    className="pl-8 pr-3 h-8 text-sm border border-[#E2DDD8] rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-[#6B5C32] w-52"
                  />
                </div>
                {(poFilter || matFilter) && (
                  <button
                    onClick={() => { setPoFilter(""); setMatFilter(""); }}
                    className="h-8 px-3 text-xs text-[#9CA3AF] hover:text-[#6B5C32] border border-[#E2DDD8] rounded-md"
                  >
                    Clear
                  </button>
                )}
                {(poFilter || matFilter) && (
                  <span className="self-center text-xs text-[#9CA3AF]">
                    {sortedPoLines.length} of {poLines.length} lines
                  </span>
                )}
              </div>

              {/* Sortable table */}
              <div className="overflow-x-auto rounded-md border border-[#E2DDD8]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[#F0ECE9] border-b border-[#E2DDD8]">
                      {(
                        [
                          { key: "poNo" as const, label: "PO No.", align: "left" },
                          { key: "orderDate" as const, label: "Order Date", align: "left" },
                          { key: "materialCode" as const, label: "Internal Code", align: "left" },
                          { key: "materialName" as const, label: "Description", align: "left" },
                          { key: "qty" as const, label: "Qty", align: "right" },
                          { key: "unitPriceSen" as const, label: "Unit Price", align: "right" },
                          { key: "lineTotalSen" as const, label: "Line Total", align: "right" },
                        ] as { key: keyof POLineRow; label: string; align: string }[]
                      ).map(({ key, label, align }) => (
                        <th
                          key={key}
                          onClick={() => toggleSort(key)}
                          className={`h-10 px-3 font-medium text-[#374151] cursor-pointer select-none whitespace-nowrap text-${align} hover:bg-[#E8E3DD]`}
                        >
                          <span className="inline-flex items-center gap-1">
                            {label}
                            {poSort.key === key ? (
                              <span className="text-[#6B5C32]">{poSort.dir === "asc" ? "↑" : "↓"}</span>
                            ) : (
                              <span className="text-[#D1CBC3]">↕</span>
                            )}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPoLines.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-10 text-center text-sm text-[#9CA3AF]">
                          {poLines.length === 0
                            ? "No purchase orders found for this supplier."
                            : "No lines match the current filters."}
                        </td>
                      </tr>
                    ) : (
                      sortedPoLines.map((row, idx) => (
                        <tr
                          key={row.id}
                          className={`border-b border-[#E2DDD8] last:border-b-0 ${idx % 2 === 1 ? "bg-[#FAF9F7]" : ""} hover:bg-[#F0ECE9]/60`}
                        >
                          <td className="h-10 px-3 font-medium text-[#6B5C32]">
                            <Link to={`/procurement/${row.poId}`} className="hover:underline">
                              {row.poNo}
                            </Link>
                          </td>
                          <td className="h-10 px-3 text-[#6B7280] tabular-nums">
                            {row.orderDate ? formatDate(row.orderDate) : "—"}
                          </td>
                          <td className="h-10 px-3 font-mono text-xs text-[#374151]">
                            {row.materialCode || "—"}
                          </td>
                          <td className="h-10 px-3 text-[#374151]">
                            {row.materialName || "—"}
                          </td>
                          <td className="h-10 px-3 text-right tabular-nums text-[#4B5563]">
                            {row.qty}
                          </td>
                          <td className="h-10 px-3 text-right tabular-nums text-[#1F1D1B]">
                            {formatRM(row.unitPriceSen)}
                          </td>
                          <td className="h-10 px-3 text-right tabular-nums font-medium text-[#1F1D1B]">
                            {formatRM(row.lineTotalSen)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── Section 2: Price Change Log ── */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp className="h-4 w-4 text-[#6B5C32]" />
                <h3 className="text-sm font-semibold text-[#1F1D1B]">Price Change Log</h3>
                <span className="text-xs text-[#9CA3AF]">— effective-dated unit-price changes on SKU mappings</span>
              </div>
              <div className="overflow-x-auto rounded-md border border-[#E2DDD8]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9] text-left text-xs font-medium text-[#374151]">
                      <th className="h-10 px-3">Effective Date</th>
                      <th className="h-10 px-3">Material</th>
                      <th className="h-10 px-3 text-right">Old Price</th>
                      <th className="h-10 px-3 text-right">New Price</th>
                      <th className="h-10 px-3 text-right">Change %</th>
                      <th className="h-10 px-3">Changed By</th>
                      <th className="h-10 px-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E2DDD8]">
                    {sortedHistory.map((h) => {
                      // Old price = the price before this change (the previous
                      // effective row's price, stored as oldPrice when the change
                      // was recorded). An opening price has oldPrice 0 → "first
                      // price", so change % is not meaningful.
                      const isFirst = h.oldPrice === 0;
                      const pct = isFirst ? "—" : (() => {
                        const p = ((h.newPrice - h.oldPrice) / h.oldPrice) * 100;
                        return `${p > 0 ? "▲ +" : p < 0 ? "▼ " : ""}${p.toFixed(1)}%`;
                      })();
                      const isIncrease = h.newPrice > h.oldPrice;
                      const statusColors: Record<string, string> = {
                        APPROVED: "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]",
                        PENDING: "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]",
                        REJECTED: "bg-[#F9E1DA] text-[#9A3A2D] border-[#E8B2A1]",
                      };
                      return (
                        <tr key={h.id} className="hover:bg-[#F0ECE9]/50">
                          <td className="py-3 px-3 tabular-nums">{formatDate(h.effectiveFrom || h.changedDate)}</td>
                          <td className="py-3 px-3 font-mono text-xs">{h.materialCode}</td>
                          <td className="py-3 px-3 text-right tabular-nums">{isFirst ? "—" : formatCurrency(h.oldPrice, h.currency)}</td>
                          <td className="py-3 px-3 text-right font-medium tabular-nums">{formatCurrency(h.newPrice, h.currency)}</td>
                          <td className={`py-3 px-3 text-right font-medium tabular-nums ${isFirst ? "text-gray-400" : isIncrease ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}`}>
                            {pct}
                          </td>
                          <td className="py-3 px-3">{h.changedBy}</td>
                          <td className="py-3 px-3">
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${statusColors[h.approvalStatus] ?? "bg-gray-100 text-gray-600 border-gray-300"}`}>
                              {h.approvalStatus}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                    {sortedHistory.length === 0 && (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-[#9CA3AF]">
                          No price change records for this supplier
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

          </CardContent>
        )}
      </Card>

      {/* Last 10 POs */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-[#6B5C32]" />
            Last 10 Purchase Orders
            <span className="text-xs text-[#9CA3AF] font-normal">
              ({score?.totalPOs ?? 0} total)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {score && score.last10POs.length > 0 ? (
            <div className="rounded-md border border-[#E2DDD8] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">PO No.</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Status</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Ordered</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Received</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Total</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Expected</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Actual</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {score.last10POs.map((po, idx) => {
                    const delta = deliveryDelta(po);
                    return (
                      <tr key={po.id} className={`border-b border-[#E2DDD8] last:border-b-0 ${idx % 2 === 1 ? "bg-[#FAF9F7]" : ""}`}>
                        <td className="h-10 px-3 font-medium text-[#6B5C32]">
                          <Link to={`/procurement/${po.id}`} className="hover:underline">
                            {po.poNo}
                          </Link>
                        </td>
                        <td className="h-10 px-3">
                          <Badge variant="status" status={po.status} />
                        </td>
                        <td className="h-10 px-3 text-right text-[#4B5563]">{po.orderedQty}</td>
                        <td className="h-10 px-3 text-right text-[#4B5563]">{po.receivedQty}</td>
                        <td className="h-10 px-3 text-right text-[#1F1D1B]">{formatCurrency(po.totalSen)}</td>
                        <td className="h-10 px-3 text-[#6B7280]">{po.expectedDate ? formatDate(po.expectedDate) : "-"}</td>
                        <td className="h-10 px-3 text-[#6B7280]">{po.receivedDate ? formatDate(po.receivedDate) : "-"}</td>
                        <td className="h-10 px-3">
                          <span className={
                            delta.tone === "ok"
                              ? "text-xs font-medium text-[#4F7C3A]"
                              : delta.tone === "late"
                              ? "text-xs font-medium text-[#9A3A2D]"
                              : "text-xs text-[#9CA3AF]"
                          }>
                            {delta.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-[#9CA3AF] py-6 text-center">
              No purchase orders found for this supplier.
            </p>
          )}
        </CardContent>
      </Card>

      {showSKUForm && (
        <SKUFormDialog
          editData={editingSKU}
          suppliers={supplierOptions}
          inventoryItems={inventoryItems}
          presetSupplierId={editingSKU ? undefined : id}
          onSave={handleSaveSKU}
          onClose={() => {
            setShowSKUForm(false);
            setEditingSKU(null);
          }}
        />
      )}

      {showSupplierForm && (
        <SupplierFormDialog
          editData={{
            code: supplier.code,
            name: supplier.name,
            contactPerson: supplier.contactPerson,
            phone: supplier.phone,
            email: supplier.email,
            address: supplier.address,
            // status/paymentTerms are stored as plain strings on the @/types
            // Supplier; the form's union types are a subset of those strings.
            paymentTerms: supplier.paymentTerms as PaymentTerms,
            status: supplier.status as SupplierStatus,
            rating: supplier.rating,
            purchaseOrgCode: supplier.purchaseOrgCode || "HOOKKA",
          }}
          orgOptions={orgOptions}
          onSave={handleSaveSupplier}
          onClose={() => setShowSupplierForm(false)}
        />
      )}
    </div>
  );
}
