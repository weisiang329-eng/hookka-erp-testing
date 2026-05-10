// ---------------------------------------------------------------------------
// Phase 4.1 — Supplier detail page (scorecard panel)
//
// Reads:
//   GET /api/suppliers/:id            { success, data: Supplier }
//   GET /api/supplier-scorecards/:id  { success, data: { onTimeRate, defectRate,
//                                       averageLeadDays, last10POs[] } }
//
// Layout:
//   - Header card: code, name, contact, payment terms, status
//   - Scorecard tile: 3 KPI tiles (on-time rate %, defect rate %, average
//     lead days). Source: live aggregation server-side, NOT the cached
//     supplier_scorecards row.
//   - Last 10 POs table: poNo, status, ordered/received qty, expected vs
//     actual delivery date.
// ---------------------------------------------------------------------------
import { useMemo } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Supplier } from "@/types";
import {
  ArrowLeft,
  Building2,
  Clock,
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
  Package,
  Plus,
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
  const navigate = useNavigate();

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/procurement/maintenance">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-bold text-[#1F1D1B] flex items-center gap-2">
              <Building2 className="h-5 w-5 text-[#6B5C32]" />
              {supplier.code} - {supplier.name}
            </h1>
            <p className="text-xs text-[#6B7280]">Supplier scorecard and recent purchase order history</p>
          </div>
        </div>
        <Badge variant="status" status={supplier.status} />
      </div>

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

      {/* SKU mappings — per-supplier code/description list */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Package className="h-4 w-4 text-[#6B5C32]" />
              SKU Mappings
              <span className="text-xs text-[#9CA3AF] font-normal">
                ({skus.length} {skus.length === 1 ? "code" : "codes"})
              </span>
            </CardTitle>
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                navigate(
                  `/procurement/maintenance?tab=sku-costing&supplier=${encodeURIComponent(id ?? "")}&action=add`,
                )
              }
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
            <div className="rounded-md border border-[#E2DDD8] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Internal Code</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Internal Description</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Supplier Code</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Supplier Description</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Unit Price</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">Lead Time</th>
                    <th className="h-10 px-3 text-right font-medium text-[#374151]">MOQ</th>
                    <th className="h-10 px-3 text-left font-medium text-[#374151]">Main</th>
                  </tr>
                </thead>
                <tbody>
                  {skus.map((s, idx) => (
                    <tr
                      key={s.id}
                      onDoubleClick={() =>
                        navigate(
                          `/procurement/maintenance?tab=sku-costing&supplier=${encodeURIComponent(id ?? "")}`,
                        )
                      }
                      className={`border-b border-[#E2DDD8] last:border-b-0 cursor-pointer hover:bg-[#FAF7EE] ${idx % 2 === 1 ? "bg-[#FAF9F7]" : ""}`}
                      title="Double-click to manage in Maintenance"
                    >
                      <td className="h-10 px-3 font-medium text-[#6B5C32]">{s.materialCode}</td>
                      <td className="h-10 px-3 text-[#374151]">{s.materialName}</td>
                      <td className="h-10 px-3 text-[#374151]">{s.supplierSku}</td>
                      <td className="h-10 px-3 text-[#6B7280]">{s.supplierDescription || "—"}</td>
                      <td className="h-10 px-3 text-right text-[#1F1D1B]">
                        {formatCurrency(s.unitPrice)} {s.currency !== "MYR" ? s.currency : ""}
                      </td>
                      <td className="h-10 px-3 text-right text-[#4B5563]">{s.leadTimeDays}d</td>
                      <td className="h-10 px-3 text-right text-[#4B5563]">{s.moq}</td>
                      <td className="h-10 px-3">
                        {s.isMainSupplier ? (
                          <Badge className="bg-green-50 text-green-800 border-green-300">Main</Badge>
                        ) : (
                          <span className="text-[#9CA3AF] text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
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
    </div>
  );
}
