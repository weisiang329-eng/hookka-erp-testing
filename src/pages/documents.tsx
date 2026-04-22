import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate, formatCurrency } from "@/lib/utils";
import { Link } from "react-router-dom";
import {
  FileText,
  ShoppingCart,
  Package,
  Factory,
  Truck,
  Receipt,
  ClipboardCheck,
  Search,
  ChevronRight,
  Loader2,
  ArrowRight,
} from "lucide-react";

// Unified document type for the table
type UnifiedDocument = {
  id: string;
  docType: "SALES_ORDER" | "DELIVERY_ORDER" | "INVOICE" | "PURCHASE_ORDER" | "PRODUCTION_ORDER" | "QC_REPORT";
  docTypeLabel: string;
  documentNo: string;
  relatedRef: string;
  customerOrSupplier: string;
  date: string;
  status: string;
  amountSen: number | null;
  detailUrl: string;
  // For document flow
  salesOrderId?: string;
  salesOrderNo?: string;
};

function getDocTypeIcon(docType: string) {
  switch (docType) {
    case "SALES_ORDER": return <ShoppingCart className="h-4 w-4 text-[#3E6570]" />;
    case "DELIVERY_ORDER": return <Truck className="h-4 w-4 text-[#3E6570]" />;
    case "INVOICE": return <Receipt className="h-4 w-4 text-[#6B4A6D]" />;
    case "PURCHASE_ORDER": return <Package className="h-4 w-4 text-[#B8601A]" />;
    case "PRODUCTION_ORDER": return <Factory className="h-4 w-4 text-[#3E6570]" />;
    case "QC_REPORT": return <ClipboardCheck className="h-4 w-4 text-[#4F7C3A]" />;
    default: return <FileText className="h-4 w-4 text-gray-500" />;
  }
}

export default function DocumentsPage() {
  const [loading, setLoading] = useState(true);
  const [documents, setDocuments] = useState<UnifiedDocument[]>([]);
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selectedSOId, setSelectedSOId] = useState<string | null>(null);

  // Fetch all document sources
  useEffect(() => {
    async function fetchAll() {
      setLoading(true);
      try {
        const [soRes, doRes, invRes, poRes, prodRes] = await Promise.all([
          fetch("/api/sales-orders").then((r) => r.json()),
          fetch("/api/delivery-orders").then((r) => r.json()),
          fetch("/api/invoices").then((r) => r.json()),
          fetch("/api/purchase-orders").then((r) => r.json()),
          fetch("/api/production-orders").then((r) => r.json()),
        ]);

        const unified: UnifiedDocument[] = [];

        // Sales Orders
        if (soRes.success && soRes.data) {
          for (const so of soRes.data) {
            unified.push({
              id: so.id,
              docType: "SALES_ORDER",
              docTypeLabel: "Sales Order",
              documentNo: so.companySOId,
              relatedRef: so.customerPOId || so.reference || "-",
              customerOrSupplier: so.customerName,
              date: so.companySODate,
              status: so.status,
              amountSen: so.totalSen,
              detailUrl: `/sales/${so.id}`,
              salesOrderId: so.id,
              salesOrderNo: so.companySOId,
            });
          }
        }

        // Delivery Orders
        if (doRes.success && doRes.data) {
          for (const d of doRes.data) {
            unified.push({
              id: d.id,
              docType: "DELIVERY_ORDER",
              docTypeLabel: "Delivery Order",
              documentNo: d.doNo,
              relatedRef: d.companySOId || "-",
              customerOrSupplier: d.customerName,
              date: d.deliveryDate,
              status: d.status,
              amountSen: null,
              detailUrl: `/delivery/${d.id}`,
              salesOrderId: d.salesOrderId,
              salesOrderNo: d.companySOId,
            });
          }
        }

        // Invoices
        if (invRes.success && invRes.data) {
          for (const inv of invRes.data) {
            unified.push({
              id: inv.id,
              docType: "INVOICE",
              docTypeLabel: "Invoice",
              documentNo: inv.invoiceNo,
              relatedRef: inv.doNo || inv.companySOId || "-",
              customerOrSupplier: inv.customerName,
              date: inv.invoiceDate,
              status: inv.status,
              amountSen: inv.totalSen,
              detailUrl: `/accounting`,
              salesOrderId: inv.salesOrderId,
              salesOrderNo: inv.companySOId,
            });
          }
        }

        // Purchase Orders
        if (poRes.success && poRes.data) {
          for (const po of poRes.data) {
            unified.push({
              id: po.id,
              docType: "PURCHASE_ORDER",
              docTypeLabel: "Purchase Order",
              documentNo: po.poNo,
              relatedRef: "-",
              customerOrSupplier: po.supplierName,
              date: po.orderDate,
              status: po.status,
              amountSen: po.totalSen,
              detailUrl: `/procurement`,
            });
          }
        }

        // Production Orders
        if (prodRes.success && prodRes.data) {
          for (const pr of prodRes.data) {
            unified.push({
              id: pr.id,
              docType: "PRODUCTION_ORDER",
              docTypeLabel: "Production Order",
              documentNo: pr.poNo,
              relatedRef: pr.companySOId || "-",
              customerOrSupplier: pr.customerName,
              date: pr.startDate,
              status: pr.status,
              amountSen: null,
              detailUrl: `/production`,
              salesOrderId: pr.salesOrderId,
              salesOrderNo: pr.companySOId,
            });
          }
        }

        // Sort by date descending
        unified.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        setDocuments(unified);
      } catch (err) {
        console.error("Failed to fetch documents:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchAll();
  }, []);

  // Filtered documents
  const filtered = useMemo(() => {
    return documents.filter((doc) => {
      if (typeFilter !== "ALL" && doc.docType !== typeFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (
          !doc.documentNo.toLowerCase().includes(q) &&
          !doc.customerOrSupplier.toLowerCase().includes(q) &&
          !doc.relatedRef.toLowerCase().includes(q)
        ) return false;
      }
      if (dateFrom && doc.date < dateFrom) return false;
      if (dateTo && doc.date > dateTo) return false;
      return true;
    });
  }, [documents, typeFilter, searchQuery, dateFrom, dateTo]);

  // KPI counts
  const totalDocs = documents.length;
  const salesDocs = documents.filter((d) => d.docType === "SALES_ORDER").length;
  const purchaseDocs = documents.filter((d) => d.docType === "PURCHASE_ORDER").length;
  const productionDocs = documents.filter((d) => d.docType === "PRODUCTION_ORDER").length;

  // Document flow for selected SO
  const documentFlow = useMemo(() => {
    if (!selectedSOId) return null;
    const so = documents.find((d) => d.docType === "SALES_ORDER" && d.id === selectedSOId);
    if (!so) return null;

    const relatedProds = documents.filter(
      (d) => d.docType === "PRODUCTION_ORDER" && d.salesOrderId === selectedSOId
    );
    const relatedDOs = documents.filter(
      (d) => d.docType === "DELIVERY_ORDER" && d.salesOrderId === selectedSOId
    );
    const relatedInvs = documents.filter(
      (d) => d.docType === "INVOICE" && d.salesOrderId === selectedSOId
    );

    return { so, productions: relatedProds, deliveries: relatedDOs, invoices: relatedInvs };
  }, [selectedSOId, documents]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[#1F1D1B]">Documents</h1>
        <p className="text-sm text-[#6B7280]">
          Central document hub - all generated documents across the ERP
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#6B7280]">Total Documents</p>
              <p className="text-2xl font-bold text-[#1F1D1B]">
                {loading ? "-" : totalDocs}
              </p>
            </div>
            <FileText className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#6B7280]">Sales Documents</p>
              <p className="text-2xl font-bold text-[#3E6570]">
                {loading ? "-" : salesDocs}
              </p>
            </div>
            <ShoppingCart className="h-5 w-5 text-[#3E6570]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#6B7280]">Purchase Documents</p>
              <p className="text-2xl font-bold text-[#B8601A]">
                {loading ? "-" : purchaseDocs}
              </p>
            </div>
            <Package className="h-5 w-5 text-[#B8601A]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#6B7280]">Production Documents</p>
              <p className="text-2xl font-bold text-[#3E6570]">
                {loading ? "-" : productionDocs}
              </p>
            </div>
            <Factory className="h-5 w-5 text-[#3E6570]" />
          </CardContent>
        </Card>
      </div>

      {/* Filter Bar */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
            >
              <option value="ALL">All Types</option>
              <option value="SALES_ORDER">Sales Orders</option>
              <option value="DELIVERY_ORDER">Delivery Orders</option>
              <option value="INVOICE">Invoices</option>
              <option value="PURCHASE_ORDER">Purchase Orders</option>
              <option value="PRODUCTION_ORDER">Production Orders</option>
            </select>

            <div className="relative">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#9CA3AF]" />
              <input
                placeholder="Search document no..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-10 pl-9 pr-3 rounded-md border border-[#E2DDD8] bg-white text-sm placeholder:text-[#9CA3AF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
              />
              <span className="text-sm text-[#9CA3AF]">to</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
              />
            </div>

            {(typeFilter !== "ALL" || searchQuery || dateFrom || dateTo) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setTypeFilter("ALL");
                  setSearchQuery("");
                  setDateFrom("");
                  setDateTo("");
                }}
              >
                Clear Filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Document Flow Section */}
      {documentFlow && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <ArrowRight className="h-5 w-5 text-[#6B5C32]" />
                Document Flow: {documentFlow.so.documentNo}
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => setSelectedSOId(null)}>
                Close
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2">
              {/* SO */}
              <div className="flex items-center gap-1.5 rounded-lg border border-[#A8CAD2] bg-[#E0EDF0] px-3 py-2">
                <ShoppingCart className="h-4 w-4 text-[#3E6570]" />
                <span className="text-sm font-medium text-[#3E6570]">{documentFlow.so.documentNo}</span>
              </div>

              {documentFlow.productions.length > 0 && (
                <>
                  <ChevronRight className="h-4 w-4 text-[#9CA3AF]" />
                  {documentFlow.productions.map((p) => (
                    <div key={p.id} className="flex items-center gap-1.5 rounded-lg border border-[#A8CAD2] bg-[#E0EDF0] px-3 py-2">
                      <Factory className="h-4 w-4 text-[#3E6570]" />
                      <span className="text-sm font-medium text-[#3E6570]">{p.documentNo}</span>
                    </div>
                  ))}
                </>
              )}

              {documentFlow.deliveries.length > 0 && (
                <>
                  <ChevronRight className="h-4 w-4 text-[#9CA3AF]" />
                  {documentFlow.deliveries.map((d) => (
                    <div key={d.id} className="flex items-center gap-1.5 rounded-lg border border-[#A8CAD2] bg-[#E0EDF0] px-3 py-2">
                      <Truck className="h-4 w-4 text-[#3E6570]" />
                      <span className="text-sm font-medium text-[#3E6570]">{d.documentNo}</span>
                    </div>
                  ))}
                </>
              )}

              {documentFlow.invoices.length > 0 && (
                <>
                  <ChevronRight className="h-4 w-4 text-[#9CA3AF]" />
                  {documentFlow.invoices.map((inv) => (
                    <div key={inv.id} className="flex items-center gap-1.5 rounded-lg border border-[#D1B7D0] bg-[#F1E6F0] px-3 py-2">
                      <Receipt className="h-4 w-4 text-[#6B4A6D]" />
                      <span className="text-sm font-medium text-[#6B4A6D]">{inv.documentNo}</span>
                    </div>
                  ))}
                </>
              )}

              {documentFlow.productions.length === 0 &&
                documentFlow.deliveries.length === 0 &&
                documentFlow.invoices.length === 0 && (
                  <span className="text-sm text-[#9CA3AF] ml-2">No linked documents yet</span>
                )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Document List Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-[#6B5C32]" />
            All Documents
            <span className="text-sm font-normal text-[#9CA3AF]">
              ({filtered.length} of {totalDocs})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 className="h-6 w-6 animate-spin text-[#6B5C32]" />
              <span className="ml-2 text-sm text-[#6B7280]">Loading documents...</span>
            </div>
          ) : (
            <div className="rounded-md border border-[#E2DDD8] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                    <th className="h-12 px-4 text-left font-medium text-[#374151]">Type</th>
                    <th className="h-12 px-4 text-left font-medium text-[#374151]">Document No</th>
                    <th className="h-12 px-4 text-left font-medium text-[#374151]">Related Ref</th>
                    <th className="h-12 px-4 text-left font-medium text-[#374151]">Customer / Supplier</th>
                    <th className="h-12 px-4 text-left font-medium text-[#374151]">Date</th>
                    <th className="h-12 px-4 text-left font-medium text-[#374151]">Status</th>
                    <th className="h-12 px-4 text-right font-medium text-[#374151]">Amount</th>
                    <th className="h-12 px-4 text-center font-medium text-[#374151]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="h-24 text-center text-[#9CA3AF]">
                        No documents found.
                      </td>
                    </tr>
                  ) : (
                    filtered.map((doc) => (
                      <tr
                        key={`${doc.docType}-${doc.id}`}
                        className={`border-b border-[#E2DDD8] hover:bg-[#FAF9F7] transition-colors ${
                          doc.docType === "SALES_ORDER" ? "cursor-pointer" : ""
                        } ${selectedSOId === doc.id ? "bg-[#E0EDF0]" : ""}`}
                        onClick={() => {
                          if (doc.docType === "SALES_ORDER") {
                            setSelectedSOId(selectedSOId === doc.id ? null : doc.id);
                          }
                        }}
                      >
                        <td className="h-12 px-4 align-middle">
                          <div className="flex items-center gap-2">
                            {getDocTypeIcon(doc.docType)}
                            <span className="text-xs text-[#6B7280]">{doc.docTypeLabel}</span>
                          </div>
                        </td>
                        <td className="h-12 px-4 align-middle">
                          <span className="font-medium text-[#1F1D1B]">{doc.documentNo}</span>
                        </td>
                        <td className="h-12 px-4 align-middle text-[#6B7280]">
                          {doc.relatedRef}
                        </td>
                        <td className="h-12 px-4 align-middle text-[#4B5563]">
                          {doc.customerOrSupplier}
                        </td>
                        <td className="h-12 px-4 align-middle text-[#4B5563]">
                          {formatDate(doc.date)}
                        </td>
                        <td className="h-12 px-4 align-middle">
                          <Badge variant="status" status={doc.status} />
                        </td>
                        <td className="h-12 px-4 align-middle text-right text-[#4B5563]">
                          {doc.amountSen != null ? formatCurrency(doc.amountSen) : "-"}
                        </td>
                        <td className="h-12 px-4 align-middle text-center">
                          <Link to={doc.detailUrl}>
                            <Button variant="ghost" size="sm">
                              View
                            </Button>
                          </Link>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
