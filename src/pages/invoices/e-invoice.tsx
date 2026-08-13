import { useState, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import {
  FileCheck,
  Send,
  CheckCircle2,
  AlertTriangle,
  Clock,
  XCircle,
  FileText,
  Code,
  BarChart3,
  RefreshCw,
  Ban,
} from "lucide-react";
import type { EInvoice } from "@/types";

type Invoice = {
  id: string;
  invoiceNo: string;
  customerName: string;
  customerState: string;
  invoiceDate: string;
  totalSen: number;
  status: string;
};

type TabId = "dashboard" | "generate" | "xml";

export default function EInvoicePage() {
  const { data: eResp, loading: eLoading, refresh: refreshEInvoices } = useCachedJson<{ success?: boolean; data?: EInvoice[] }>("/api/e-invoices");
  const { data: iResp, loading: iLoading, refresh: refreshInvoices } = useCachedJson<{ success?: boolean; data?: Invoice[] }>("/api/invoices");
  const eInvoices: EInvoice[] = useMemo(
    () => (eResp?.success ? eResp.data ?? [] : Array.isArray(eResp) ? eResp : []),
    [eResp]
  );
  const invoices: Invoice[] = useMemo(
    () => (iResp?.success ? iResp.data ?? [] : Array.isArray(iResp) ? iResp : []),
    [iResp]
  );
  const loading = eLoading || iLoading;
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  const [selectedXmlId, setSelectedXmlId] = useState<string | null>(null);

  const fetchData = async () => {
    invalidateCachePrefix("/api/e-invoices");
    invalidateCachePrefix("/api/invoices");
    refreshEInvoices();
    refreshInvoices();
  };

  // KPI calculations
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const submittedMTD = eInvoices.filter(
    (e) => e.submittedAt && e.submittedAt.startsWith(currentMonth)
  ).length;
  const validCount = eInvoices.filter((e) => e.status === "VALID").length;
  const pendingCount = eInvoices.filter((e) => e.status === "PENDING").length;
  const invalidCount = eInvoices.filter(
    (e) => e.status === "INVALID"
  ).length;

  // Invoices not yet submitted as e-invoices
  const eInvoiceInvoiceIds = useMemo(
    () => new Set(eInvoices.map((e) => e.invoiceId)),
    [eInvoices]
  );
  const eInvoiceInvoiceNos = useMemo(
    () => new Set(eInvoices.map((e) => e.invoiceNo)),
    [eInvoices]
  );
  const availableInvoices = useMemo(
    () =>
      invoices.filter(
        (inv) =>
          !eInvoiceInvoiceIds.has(inv.id) &&
          !eInvoiceInvoiceNos.has(inv.invoiceNo) &&
          inv.status !== "DRAFT" &&
          inv.status !== "CANCELLED"
      ),
    [invoices, eInvoiceInvoiceIds, eInvoiceInvoiceNos]
  );

  const toggleSelect = (id: string) => {
    setSelectedInvoiceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedInvoiceIds.size === availableInvoices.length) {
      setSelectedInvoiceIds(new Set());
    } else {
      setSelectedInvoiceIds(new Set(availableInvoices.map((inv) => inv.id)));
    }
  };

  const generateEInvoices = async () => {
    if (selectedInvoiceIds.size === 0) return;
    setGenerating(true);

    for (const invoiceId of selectedInvoiceIds) {
      await fetch("/api/e-invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceId }),
      });
    }

    setSelectedInvoiceIds(new Set());
    await fetchData();
    setGenerating(false);
    setActiveTab("dashboard");
  };

  // Submitting to LHDN is NOT implemented — the route now refuses (501) rather
  // than minting a random submission ID + UUID and flipping the row to VALID,
  // which is what it did until BUG-2026-08-13-014. The refusal is surfaced
  // here: this function used to throw the response away entirely, so a failure
  // would have looked like a button that simply did nothing.
  const submitToLHDN = async (eInvoiceId: string) => {
    setSubmitting(eInvoiceId);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/e-invoices/${eInvoiceId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit" }),
      });
      const json = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string }
        | null;
      if (!res.ok || !json?.success) {
        setSubmitError(
          json?.error ??
            `Submission failed (HTTP ${res.status}). Nothing was sent to LHDN.`,
        );
      }
    } catch {
      setSubmitError(
        "Submission failed: the request could not be sent. Nothing was sent to LHDN.",
      );
    }
    await fetchData();
    setSubmitting(null);
  };

  const cancelEInvoice = async (eInvoiceId: string) => {
    setCancelling(eInvoiceId);
    await fetch(`/api/e-invoices/${eInvoiceId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    });
    setCancelConfirmId(null);
    await fetchData();
    setCancelling(null);
  };

  const statusBadge = (status: EInvoice["status"]) => {
    const config: Record<
      EInvoice["status"],
      { bg: string; text: string; icon: React.ReactNode }
    > = {
      PENDING: {
        bg: "bg-[#FAEFCB] border-[#E8D597]",
        text: "text-[#9C6F1E]",
        icon: <Clock className="h-3 w-3" />,
      },
      SUBMITTED: {
        bg: "bg-[#E0EDF0] border-[#A8CAD2]",
        text: "text-[#3E6570]",
        icon: <Send className="h-3 w-3" />,
      },
      VALID: {
        bg: "bg-[#EEF3E4] border-[#C6DBA8]",
        text: "text-[#4F7C3A]",
        icon: <CheckCircle2 className="h-3 w-3" />,
      },
      INVALID: {
        bg: "bg-[#F9E1DA] border-[#E8B2A1]",
        text: "text-[#9A3A2D]",
        icon: <AlertTriangle className="h-3 w-3" />,
      },
      CANCELLED: {
        bg: "bg-gray-50 border-gray-200",
        text: "text-gray-500",
        icon: <XCircle className="h-3 w-3" />,
      },
    };
    const c = config[status];
    return (
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${c.bg} ${c.text}`}
      >
        {c.icon}
        {status}
      </span>
    );
  };

  const selectedXml = useMemo(
    () => eInvoices.find((e) => e.id === selectedXmlId),
    [eInvoices, selectedXmlId]
  );

  // Window both e-invoice tables so large invoice volumes stay light.
  const submissionsScrollRef = useRef<HTMLDivElement>(null);
  const submissionsVirtualizer = useVirtualizer({
    count: eInvoices.length,
    getScrollElement: () => submissionsScrollRef.current,
    estimateSize: () => 53,
    overscan: 10,
  });
  const availableScrollRef = useRef<HTMLDivElement>(null);
  const availableVirtualizer = useVirtualizer({
    count: availableInvoices.length,
    getScrollElement: () => availableScrollRef.current,
    estimateSize: () => 49,
    overscan: 10,
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#6B7280]">
        Loading...
      </div>
    );
  }

  return (
    <div className="space-y-6 max-md:space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">e-Invoice</h1>
          <p className="text-xs text-[#6B7280]">
            LHDN MyInvois - Malaysian e-Invoice XML generation. Transmission to
            LHDN is not connected.
          </p>
        </div>
        <Button variant="outline" onClick={fetchData} className="gap-2">
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Standing notice. Until BUG-2026-08-13-014 the Submit button minted a
          random `LHDN-SUB-…` id and a random 15-char UUID, marked the row
          VALID and showed a green badge — with no LHDN client in the codebase
          at all. Any VALID row created before this fix carries an identifier
          LHDN never issued. */}
      <div className="rounded-md border border-[#E8D597] bg-[#FAEFCB] px-3 py-2 text-xs text-[#7A5712]">
        <span className="font-semibold">Not connected to LHDN.</span> This page
        builds and stores the e-Invoice UBL XML. It does not transmit anything —
        submit through MyInvois. Any row already marked <em>VALID</em> with a
        submission ID or UUID was stamped locally, not cleared by LHDN.
      </div>

      {submitError && (
        <div className="rounded-md border border-[#E8B2A1] bg-[#F9E1DA] px-3 py-2 text-xs text-[#9A3A2D]">
          {submitError}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#E2DDD8] overflow-x-auto">
        {(
          [
            { id: "dashboard" as TabId, label: "Dashboard", icon: BarChart3 },
            { id: "generate" as TabId, label: "Generate e-Invoice", icon: FileText },
            { id: "xml" as TabId, label: "XML Preview", icon: Code },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-[#6B5C32] text-[#6B5C32]"
                : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab 1: Dashboard */}
      {activeTab === "dashboard" && (
        <>
          {/* KPI Cards */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
            <Card>
              <CardContent className="p-2.5 flex items-center justify-between">
                <div>
                  <p className="text-xs text-[#6B7280]">Submitted (MTD)</p>
                  <p className="text-xl font-bold text-[#1F1D1B]">
                    {submittedMTD}
                  </p>
                </div>
                <Send className="h-5 w-5 text-[#6B5C32]" />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-2.5 flex items-center justify-between">
                <div>
                  <p className="text-xs text-[#6B7280]">Validated</p>
                  <p className="text-xl font-bold text-[#4F7C3A]">
                    {validCount}
                  </p>
                </div>
                <CheckCircle2 className="h-5 w-5 text-[#4F7C3A]" />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-2.5 flex items-center justify-between">
                <div>
                  <p className="text-xs text-[#6B7280]">Pending</p>
                  <p className="text-xl font-bold text-[#9C6F1E]">
                    {pendingCount}
                  </p>
                </div>
                <Clock className="h-5 w-5 text-[#9C6F1E]" />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-2.5 flex items-center justify-between">
                <div>
                  <p className="text-xs text-[#6B7280]">Invalid / Rejected</p>
                  <p className="text-xl font-bold text-[#9A3A2D]">
                    {invalidCount}
                  </p>
                </div>
                <AlertTriangle className="h-5 w-5 text-[#9A3A2D]" />
              </CardContent>
            </Card>
          </div>

          {/* Recent Submissions Table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                <FileCheck className="h-5 w-5 text-[#6B5C32]" />
                e-Invoice Submissions
              </CardTitle>
            </CardHeader>
            <CardContent>
              {eInvoices.length === 0 ? (
                <p className="text-sm text-[#6B7280] text-center py-8">
                  No e-invoices found. Go to the Generate tab to create one.
                </p>
              ) : (
                <div
                  ref={submissionsScrollRef}
                  className="overflow-auto"
                  style={{ maxHeight: "calc(100vh - 340px)" }}
                >
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10">
                      <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                        <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                          Invoice No
                        </th>
                        <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                          Customer
                        </th>
                        <th className="text-right py-3 px-4 text-xs font-bold text-[#4B5563]">
                          Total
                        </th>
                        <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                          Submitted
                        </th>
                        <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                          Status
                        </th>
                        <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const vItems = submissionsVirtualizer.getVirtualItems();
                        const padTop = vItems.length > 0 ? vItems[0].start : 0;
                        const padBottom =
                          vItems.length > 0
                            ? submissionsVirtualizer.getTotalSize() -
                              vItems[vItems.length - 1].end
                            : 0;
                        return (
                          <>
                            {padTop > 0 && (
                              <tr aria-hidden="true">
                                <td colSpan={6} style={{ height: padTop, padding: 0, border: 0 }} />
                              </tr>
                            )}
                            {vItems.map((vi) => {
                              const einv = eInvoices[vi.index];
                              if (!einv) return null;
                              return (
                        <tr
                          key={einv.id}
                          data-index={vi.index}
                          ref={submissionsVirtualizer.measureElement}
                          className="border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/50"
                        >
                          <td className="py-3 px-4 font-medium text-[#1F1D1B]">
                            {einv.invoiceNo}
                          </td>
                          <td className="py-3 px-4 text-[#4B5563]">
                            {einv.customerName}
                          </td>
                          <td className="py-3 px-4 text-right font-medium text-[#1F1D1B]">
                            RM {einv.totalIncludingTax.toFixed(2)}
                          </td>
                          <td className="py-3 px-4 text-[#4B5563]">
                            {einv.submittedAt
                              ? formatDate(einv.submittedAt)
                              : "-"}
                          </td>
                          <td className="py-3 px-4">{statusBadge(einv.status)}</td>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-1">
                              {(einv.status === "PENDING" ||
                                einv.status === "INVALID") && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-[#3E6570] hover:text-[#2E4D57] hover:bg-[#E0EDF0]"
                                  onClick={() => submitToLHDN(einv.id)}
                                  disabled={submitting === einv.id}
                                >
                                  <Send className="h-3 w-3 mr-1" />
                                  {submitting === einv.id
                                    ? "Submitting..."
                                    : "Submit"}
                                </Button>
                              )}
                              {(einv.status === "VALID" ||
                                einv.status === "SUBMITTED") && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-[#9A3A2D] hover:text-[#7A2E24] hover:bg-[#F9E1DA]"
                                  onClick={() => setCancelConfirmId(einv.id)}
                                  disabled={cancelling === einv.id}
                                >
                                  <Ban className="h-3 w-3 mr-1" />
                                  Cancel
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-[#6B5C32] hover:bg-[#F0ECE9]"
                                onClick={() => {
                                  setSelectedXmlId(einv.id);
                                  setActiveTab("xml");
                                }}
                              >
                                <Code className="h-3 w-3 mr-1" />
                                XML
                              </Button>
                            </div>
                            {einv.errorMessage && (
                              <p className="text-xs text-[#9A3A2D] mt-1">
                                {einv.errorMessage}
                              </p>
                            )}
                          </td>
                        </tr>
                              );
                            })}
                            {padBottom > 0 && (
                              <tr aria-hidden="true">
                                <td colSpan={6} style={{ height: padBottom, padding: 0, border: 0 }} />
                              </tr>
                            )}
                          </>
                        );
                      })()}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* Tab 2: Generate e-Invoice */}
      {activeTab === "generate" && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-[#6B5C32]" />
                Invoices Available for e-Invoice Generation
              </CardTitle>
              <Button
                variant="primary"
                disabled={selectedInvoiceIds.size === 0 || generating}
                onClick={generateEInvoices}
              >
                <FileCheck className="h-4 w-4 mr-1" />
                {generating
                  ? "Generating..."
                  : `Generate e-Invoice (${selectedInvoiceIds.size})`}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {availableInvoices.length === 0 ? (
              <p className="text-sm text-[#6B7280] text-center py-8">
                All invoices have been submitted as e-invoices.
              </p>
            ) : (
              <div
                ref={availableScrollRef}
                className="overflow-auto"
                style={{ maxHeight: "calc(100vh - 340px)" }}
              >
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10">
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                      <th className="py-3 px-4 text-left">
                        <input
                          type="checkbox"
                          checked={
                            selectedInvoiceIds.size ===
                              availableInvoices.length &&
                            availableInvoices.length > 0
                          }
                          onChange={toggleSelectAll}
                          className="rounded border-[#E2DDD8] text-[#6B5C32] focus:ring-[#6B5C32]"
                        />
                      </th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                        Invoice No
                      </th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                        Customer
                      </th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                        Date
                      </th>
                      <th className="text-right py-3 px-4 text-xs font-bold text-[#4B5563]">
                        Total
                      </th>
                      <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const vItems = availableVirtualizer.getVirtualItems();
                      const padTop = vItems.length > 0 ? vItems[0].start : 0;
                      const padBottom =
                        vItems.length > 0
                          ? availableVirtualizer.getTotalSize() -
                            vItems[vItems.length - 1].end
                          : 0;
                      return (
                        <>
                          {padTop > 0 && (
                            <tr aria-hidden="true">
                              <td colSpan={6} style={{ height: padTop, padding: 0, border: 0 }} />
                            </tr>
                          )}
                          {vItems.map((vi) => {
                            const inv = availableInvoices[vi.index];
                            if (!inv) return null;
                            return (
                        <tr
                          key={inv.id}
                          data-index={vi.index}
                          ref={availableVirtualizer.measureElement}
                          className={`border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/50 cursor-pointer ${
                            selectedInvoiceIds.has(inv.id)
                              ? "bg-[#6B5C32]/5"
                              : ""
                          }`}
                          onClick={() => toggleSelect(inv.id)}
                        >
                          <td className="py-3 px-4">
                            <input
                              type="checkbox"
                              checked={selectedInvoiceIds.has(inv.id)}
                              onChange={() => toggleSelect(inv.id)}
                              className="rounded border-[#E2DDD8] text-[#6B5C32] focus:ring-[#6B5C32]"
                            />
                          </td>
                          <td className="py-3 px-4 font-medium text-[#1F1D1B]">
                            {inv.invoiceNo}
                          </td>
                          <td className="py-3 px-4 text-[#4B5563]">
                            {inv.customerName}
                          </td>
                          <td className="py-3 px-4 text-[#4B5563]">
                            {formatDate(inv.invoiceDate)}
                          </td>
                          <td className="py-3 px-4 text-right font-medium text-[#1F1D1B]">
                            {formatCurrency(inv.totalSen)}
                          </td>
                          <td className="py-3 px-4">
                            <Badge variant="status" status={inv.status} />
                          </td>
                        </tr>
                            );
                          })}
                          {padBottom > 0 && (
                            <tr aria-hidden="true">
                              <td colSpan={6} style={{ height: padBottom, padding: 0, border: 0 }} />
                            </tr>
                          )}
                        </>
                      );
                    })()}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Tab 3: XML Preview */}
      {activeTab === "xml" && (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Selector */}
          <Card className="lg:col-span-1">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Select e-Invoice</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="max-h-[500px] overflow-y-auto">
                {eInvoices.map((einv) => (
                  <button
                    key={einv.id}
                    className={`w-full text-left px-4 py-3 border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/50 transition-colors ${
                      selectedXmlId === einv.id
                        ? "bg-[#6B5C32]/10 border-l-2 border-l-[#6B5C32]"
                        : ""
                    }`}
                    onClick={() => setSelectedXmlId(einv.id)}
                  >
                    <p className="text-sm font-medium text-[#1F1D1B]">
                      {einv.invoiceNo}
                    </p>
                    <p className="text-xs text-[#6B7280]">
                      {einv.customerName}
                    </p>
                    <div className="mt-1">{statusBadge(einv.status)}</div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* XML Content */}
          <Card className="lg:col-span-3">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                <Code className="h-5 w-5 text-[#6B5C32]" />
                XML Preview
                {selectedXml && (
                  <span className="text-sm font-normal text-[#6B7280]">
                    - {selectedXml.invoiceNo}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!selectedXml ? (
                <p className="text-sm text-[#6B7280] text-center py-12">
                  Select an e-invoice from the list to preview its XML content.
                </p>
              ) : !selectedXml.xmlContent ? (
                <p className="text-sm text-[#6B7280] text-center py-12">
                  No XML content available for this e-invoice.
                </p>
              ) : (
                <div>
                  {/* Meta info */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 max-sm:grid-cols-1">
                    <div className="bg-[#F0ECE9] rounded-md p-3">
                      <p className="text-xs text-[#6B7280]">Submission ID</p>
                      <p className="text-sm font-mono font-medium text-[#1F1D1B] truncate">
                        {selectedXml.submissionId || "Not submitted"}
                      </p>
                    </div>
                    <div className="bg-[#F0ECE9] rounded-md p-3">
                      <p className="text-xs text-[#6B7280]">UUID</p>
                      <p className="text-sm font-mono font-medium text-[#1F1D1B] truncate">
                        {selectedXml.uuid || "N/A"}
                      </p>
                    </div>
                    <div className="bg-[#F0ECE9] rounded-md p-3">
                      <p className="text-xs text-[#6B7280]">Customer TIN</p>
                      <p className="text-sm font-mono font-medium text-[#1F1D1B]">
                        {selectedXml.customerTIN || "N/A"}
                      </p>
                    </div>
                    <div className="bg-[#F0ECE9] rounded-md p-3">
                      <p className="text-xs text-[#6B7280]">Status</p>
                      <div className="mt-0.5">
                        {statusBadge(selectedXml.status)}
                      </div>
                    </div>
                  </div>

                  {/* XML code block */}
                  <div className="bg-[#FAFAF8] border border-[#E2DDD8] rounded-lg overflow-auto max-h-[500px]">
                    <pre className="p-4 text-xs font-mono text-[#1F1D1B] leading-relaxed whitespace-pre">
                      {selectedXml.xmlContent}
                    </pre>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Cancel Confirmation Modal */}
      {cancelConfirmId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold text-[#1F1D1B] mb-2">
              Cancel e-Invoice
            </h2>
            <p className="text-sm text-[#6B7280] mb-4">
              Are you sure you want to cancel this e-invoice? This action will
              notify LHDN and the e-invoice will be marked as cancelled. This
              cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setCancelConfirmId(null)}
              >
                No, Keep It
              </Button>
              <Button
                variant="primary"
                className="bg-[#9A3A2D] hover:bg-[#9A3A2D]"
                onClick={() => cancelEInvoice(cancelConfirmId)}
                disabled={cancelling === cancelConfirmId}
              >
                {cancelling === cancelConfirmId
                  ? "Cancelling..."
                  : "Yes, Cancel e-Invoice"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
