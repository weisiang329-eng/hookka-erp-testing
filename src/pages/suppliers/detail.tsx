// ---------------------------------------------------------------------------
// Supplier Detail — unified per-supplier page (2026-06-20).
//
// Reads:
//   GET /api/suppliers/:id                    Supplier info
//   GET /api/supplier-scorecards/:id          Scorecard + last-10 POs
//   GET /api/supplier-materials?supplierId=   Pricing & SKUs
//   GET /api/price-history?supplierId=        Price History trail
//
// Layout:
//   - ObjectPageHeader: supplier code/name/status, Edit + Quotation PDF buttons
//   - Supplier Info card: contact, email, phone, payment terms, address
//   - Scorecard tiles (3 KPI cards) + Last 10 POs table
//   - Sub-tabs: [ Pricing & SKUs | Price History ]
//     • Pricing & SKUs : SKU mappings CRUD (DataGrid + SKUFormDialog)
//     • Price History  : price_histories trail for this supplier
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ObjectPageHeader } from "@/components/ui/object-page-header";
import { DataGrid, type Column } from "@/components/ui/data-grid";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { humanizeError } from "@/lib/humanize-error";
import { formatCurrency, formatDate } from "@/lib/utils";
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

  const { data: supResp, loading: supLoading } = useCachedJson<{
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
    () => [...priceHistory].sort((a, b) => b.changedDate.localeCompare(a.changedDate)),
    [priceHistory]
  );

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
      validFrom: b.priceValidFrom ?? "",
      validTo: b.priceValidTo ?? "",
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
      priceValidFrom: data.validFrom,
      priceValidTo: data.validTo,
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

  if (supLoading || scoreLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#6B5C32]" />
      </div>
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

  // SKU mappings grid columns. Replaces the old hand-rolled <table> so columns
  // are resizable (drag right edge, persisted per-user in localStorage) and
  // long descriptions clip instead of overflowing. The inline Edit + Delete
  // actions are preserved via a custom render on the Actions column so they
  // stay visible (not buried in a right-click menu). Double-click-to-edit is
  // wired through DataGrid's onDoubleClick below.
  const skuColumns: Column<SkuBinding>[] = [
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
  ];

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
                    contactPerson: supplier.contactPerson,
                    email: supplier.email,
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
                    priceValidFrom: b.priceValidFrom,
                    priceValidTo: b.priceValidTo,
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
                      <TrendingUp className="h-3.5 w-3.5" />
                      Price History
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
          <CardContent className="pt-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <th className="pb-3 pr-4">Date</th>
                    <th className="pb-3 pr-4">Material</th>
                    <th className="pb-3 pr-4 text-right">Old Price</th>
                    <th className="pb-3 pr-4 text-right">New Price</th>
                    <th className="pb-3 pr-4 text-right">Change %</th>
                    <th className="pb-3 pr-4">Changed By</th>
                    <th className="pb-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2DDD8]">
                  {sortedHistory.map((h) => {
                    const pct = h.oldPrice === 0 ? "N/A" : (() => {
                      const p = ((h.newPrice - h.oldPrice) / h.oldPrice) * 100;
                      return `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;
                    })();
                    const isIncrease = h.newPrice > h.oldPrice;
                    const statusColors: Record<string, string> = {
                      APPROVED: "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]",
                      PENDING: "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]",
                      REJECTED: "bg-[#F9E1DA] text-[#9A3A2D] border-[#E8B2A1]",
                    };
                    return (
                      <tr key={h.id} className="hover:bg-[#F0ECE9]/50">
                        <td className="py-3 pr-4">{formatDate(h.changedDate)}</td>
                        <td className="py-3 pr-4 font-mono text-xs">{h.materialCode}</td>
                        <td className="py-3 pr-4 text-right">{formatCurrency(h.oldPrice, h.currency)}</td>
                        <td className="py-3 pr-4 text-right font-medium">{formatCurrency(h.newPrice, h.currency)}</td>
                        <td className={`py-3 pr-4 text-right font-medium ${pct === "N/A" ? "text-gray-400" : isIncrease ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}`}>
                          {pct}
                        </td>
                        <td className="py-3 pr-4">{h.changedBy}</td>
                        <td className="py-3">
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${statusColors[h.approvalStatus] ?? "bg-gray-100 text-gray-600 border-gray-300"}`}>
                            {h.approvalStatus}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {sortedHistory.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-gray-400">
                        No price history for this supplier
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
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
