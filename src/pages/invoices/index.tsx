import { useState, useCallback, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataGrid } from "@/components/ui/data-grid";
import type { Column, ContextMenuItem } from "@/components/ui/data-grid";
import { StatusTabStrip } from "@/components/ui/status-tab-strip";
import { tabValueSen } from "@/lib/status-tab-strip";
import { formatCurrency } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import {
  Plus,
  FileText,
  DollarSign,
  AlertTriangle,
  CheckCircle2,
  X,
  BarChart3,
  List,
  Download,
  Send,
} from "lucide-react";
import type { Invoice } from "@/types";
import { fetchJson } from "@/lib/fetch-json";
import { mutationWithData } from "@/lib/schemas/common";
import { InvoiceSchema } from "@/lib/schemas/invoice";
import { useToast } from "@/components/ui/toast";
import { moneyFieldToSen, firstMoneyFieldError } from "@/lib/money-field";

const InvoiceMutationSchema = mutationWithData(InvoiceSchema);

type AgingRow = {
  customerName: string;
  current: number;
  days31_60: number;
  days61_90: number;
  days90plus: number;
  total: number;
};

// Page size 200 — client-side search only sees the current page, so big
// enough to fit typical working set in one go.
const PAGE_SIZE = 200;

// Identifier keys kept searchable on the invoices grid even when their column
// is hidden via the "Columns" menu. Module-scoped for a stable array reference
// (keeps DataGrid's filter memo from re-running every render).
const INVOICE_SEARCH_KEYS = [
  "invoiceNo",
  "doNo",
  "companySOId",
  "customerPOId",
  "customerName",
];

export default function InvoicesPage() {
  const { toast } = useToast();
  const navigate = useNavigate();

  // Pagination — server-side. Filter changes reset to page 1 (see effect below).
  const [page, setPage] = useState(1);
  // Mirrors the grid's global search box. While non-empty, the fetch below
  // switches to a server search across the WHOLE table (every page) instead of
  // the current 200-row page — so an invoice is findable by invoice no, DO no,
  // our SO, customer PO or customer name no matter which page it sits on.
  const [gridSearch, setGridSearch] = useState("");
  // Filters declared HERE (before the list + KPI fetches) so both carry them
  // server-side — owner 2026-06-27: the status/customer/date filter must span
  // the whole table (not just the loaded page) and the top cards must follow it.
  const [filterStatus, setFilterStatus] = useState("");
  const [filterCustomer, setFilterCustomer] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const filterQs = (() => {
    const qs = new URLSearchParams();
    if (filterStatus) qs.set("status", filterStatus);
    if (filterCustomer) qs.set("customerId", filterCustomer);
    if (filterDateFrom) qs.set("from", filterDateFrom);
    if (filterDateTo) qs.set("to", filterDateTo);
    return qs.toString();
  })();
  // Same filter WITHOUT the status — the status tab strip needs every bucket's
  // count and money under the customer/date filter the operator has set. Asking
  // the status-filtered aggregate would collapse the strip to the one status
  // already selected (every other tab would read 0), which is exactly the
  // "cards disagree with the list" class this page has been bitten by before.
  const filterQsNoStatus = (() => {
    const qs = new URLSearchParams();
    if (filterCustomer) qs.set("customerId", filterCustomer);
    if (filterDateFrom) qs.set("from", filterDateFrom);
    if (filterDateTo) qs.set("to", filterDateTo);
    return qs.toString();
  })();

  const { data: invResp, loading, refresh: refreshInvoices } = useCachedJson<{
    success?: boolean;
    data?: Invoice[];
    page?: number;
    limit?: number;
    total?: number;
  }>(
    gridSearch.trim()
      ? `/api/invoices?search=${encodeURIComponent(gridSearch.trim())}&limit=2000`
      : filterQs
        ? `/api/invoices?${filterQs}&limit=2000`
        : `/api/invoices?page=${page}&limit=${PAGE_SIZE}`,
  );
  // Whole-dataset KPI numbers — bucket counts AND money aggregates.
  // 2026-05-26 audit: outstandingSen / paidMTDSen were previously
  // computed on the current 200-row page only, so the KPI cards
  // undercounted as soon as the invoices table grew past one page.
  // Backend /stats now returns the sums whole-dataset.
  const { data: invStatsResp, refresh: refreshInvStats } = useCachedJson<{
    success?: boolean;
    byStatus?: Record<string, number>;
    totalByStatus?: Record<string, number>;
    total?: number;
    outstandingSen?: number;
    paidMTDSen?: number;
  }>(filterQs ? `/api/invoices/stats?${filterQs}` : "/api/invoices/stats");
  // The status tab strip's own source: the same aggregate minus the status
  // filter. When no status is selected this is byte-identical to the URL above
  // and useCachedJson serves it from the same cache entry — no extra request.
  // /api/invoices/stats narrows its GROUP BY with customerScopeSql
  // (invoices.ts:1218), so a salesperson's counts AND totals here cover only
  // their own customers' invoices.
  const { data: statusStripResp } = useCachedJson<{
    success?: boolean;
    byStatus?: Record<string, number>;
    totalByStatus?: Record<string, number>;
    total?: number;
  }>(filterQsNoStatus ? `/api/invoices/stats?${filterQsNoStatus}` : "/api/invoices/stats");
  const invoices: Invoice[] = useMemo(
    () => (invResp?.success ? invResp.data ?? [] : Array.isArray(invResp) ? invResp : []),
    [invResp]
  );
  const totalInvoicesServer = invResp?.total ?? invoices.length;
  const totalPages = Math.max(1, Math.ceil(totalInvoicesServer / PAGE_SIZE));

  // ---- Status tab strip (count + money per state) ------------------------
  // This strip IS the status filter — there is no separate Status dropdown, so
  // there is only one place the page's status can be set and only one set of
  // numbers describing it.
  //
  // Money = INVOICED TOTAL: each invoice's own totalSen (the grid's "Total"
  // column), summed over exactly the invoices that tab lists. Not the
  // outstanding balance — that is a different question and already has its own
  // card above ("Outstanding"); putting a balance under a tab labelled "Paid"
  // would read as RM 0.00 for the fully-collected book.
  const statusTabs = useMemo(() => {
    const stripByStatus = statusStripResp?.byStatus ?? {};
    const stripTotalByStatus = statusStripResp?.totalByStatus ?? {};
    const spec: { key: string; label: string }[] = [
      { key: "DRAFT", label: "Draft" },
      { key: "SENT", label: "Sent" },
      { key: "PARTIAL_PAID", label: "Partial Paid" },
      { key: "PAID", label: "Paid" },
      { key: "OVERDUE", label: "Overdue" },
      { key: "CANCELLED", label: "Cancelled" },
    ];
    // "All" is the sum of everything the aggregate returned, including any
    // legacy status not in the list above — its count and its money come from
    // the same payload, so they cannot describe different invoices.
    const allCount = statusStripResp?.total ?? 0;
    const allValue = Object.values(stripTotalByStatus).reduce((s, v) => s + (Number(v) || 0), 0);
    return [
      { key: "", label: "All", count: allCount, valueSen: tabValueSen(allValue) },
      ...spec.map((s) => ({
        key: s.key,
        label: s.label,
        count: stripByStatus[s.key] ?? 0,
        valueSen: tabValueSen(stripTotalByStatus[s.key] ?? null),
      })),
    ];
  }, [statusStripResp]);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const { data: doResp, refresh: refreshDOs } = useCachedJson<{ success?: boolean; data?: { id: string; doNo: string; customerName: string; status: string }[] }>(showCreateModal ? "/api/delivery-orders" : null);
  const deliveryOrders = useMemo(() => {
    const all = doResp?.success ? doResp.data ?? [] : Array.isArray(doResp) ? doResp : [];
    return all.filter((o) => o.status === "DELIVERED" || o.status === "LOADED");
  }, [doResp]);
  const [selectedDOId, setSelectedDOId] = useState("");
  const [creating, setCreating] = useState(false);

  // Filters — state declared above (before the list/stats fetches) so both
  // fetches carry them server-side.

  // Batch "Email to Customer" — one button for the whole selection
  // (2026-07-03, owner request: the old separate Send-to-Customer +
  // Re-send-email pair was confusing). Drafts are finalised then emailed;
  // already-sent invoices are re-emailed with the current PDF.
  const [selectedInvoices, setSelectedInvoices] = useState<Invoice[]>([]);

  // Reset to page 1 when any filter changes (stale page could be empty).
  // Also drop the checkbox selection — rows selected under the OLD filter may
  // no longer be visible, and a stale "N selected" toolbar over a different
  // result set made batch buttons count invisible rows (owner report
  // 2026-07-03: "1 selected" over an empty list).
  /* eslint-disable react-hooks/set-state-in-effect -- derived pagination reset triggered by filter change */
  useEffect(() => {
    setPage(1);
    setSelectedInvoices([]);
  }, [filterStatus, filterCustomer, filterDateFrom, filterDateTo]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Full customer list (id + name + email) for the filter dropdown AND the
  // no-email pre-flight on the batch email dialog. The dropdown previously
  // listed names harvested from the loaded invoice page only (incomplete) and
  // used the NAME as the option value (broke the ?customerId= server filter).
  const { data: custResp } = useCachedJson<{
    success?: boolean;
    data?: { id: string; name: string; email?: string | null }[];
  }>("/api/customers");
  const customers = useMemo(() => {
    const list = custResp?.success ? custResp.data ?? [] : [];
    return [...list].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [custResp]);
  const customerEmailById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of customers) if (c.email) m.set(c.id, c.email);
    return m;
  }, [customers]);

  // Tabs
  const [activeTab, setActiveTab] = useState<"list" | "aging">("list");

  // AR Aging — computed server-side over the WHOLE table (2026-07-14 bug fix).
  // Previously bucketed over the loaded 200-row page only, silently dropping
  // every invoice past page 1 (341 total → 141 missing). Fetched only when the
  // Aging tab is active; follows the page's status/customer/date filter.
  const { data: agingResp } = useCachedJson<{
    success?: boolean;
    data?: AgingRow[];
  }>(
    activeTab === "aging"
      ? filterQs
        ? `/api/invoices/aging?${filterQs}`
        : "/api/invoices/aging"
      : null,
  );

  // Inline payment
  const [payingInvoiceId, setPayingInvoiceId] = useState<string | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(
    new Date().toISOString().split("T")[0]
  );
  const [paymentReference, setPaymentReference] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("BANK_TRANSFER");
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);

  // selectedInvoices state is declared above the filter-reset effect.
  const [emailConfirmOpen, setEmailConfirmOpen] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchResult, setBatchResult] = useState<
    { ok: number; fail: number; errors: string[] } | null
  >(null);
  // Bulk "Download PDF" of the selected invoices, merged into one file.
  const [downloadingPdf, setDownloadingPdf] = useState(false);

  const openCreate = () => {
    refreshDOs();
    setShowCreateModal(true);
  };

  const createInvoice = async () => {
    if (!selectedDOId) return;
    setCreating(true);
    try {
      // Sprint 3 #4 — idempotency. A retry of the create-invoice POST
      // could fan out two invoice rows for the same DO. Send a UUID so
      // the server returns the cached response on retry.
      const data = await fetchJson("/api/invoices", InvoiceMutationSchema, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: { deliveryOrderId: selectedDOId },
      });
      if (data.success && data.data?.id) {
        setShowCreateModal(false);
        setSelectedDOId("");
        invalidateCachePrefix("/api/invoices");
        invalidateCachePrefix("/api/delivery-orders");
        invalidateCachePrefix("/api/sales-orders");
        refreshInvoices();
        refreshInvStats();
        navigate(`/invoices/${data.data.id}`);
      }
    } catch {
      // surface in form via creating state — caller renders generic error
    } finally {
      setCreating(false);
    }
  };

  const advanceStatus = async (inv: Invoice, newStatus: string) => {
    try {
      const data = await fetchJson(`/api/invoices/${inv.id}`, InvoiceMutationSchema, {
        method: "PUT",
        body: { status: newStatus },
      });
      if (data.success) {
        invalidateCachePrefix("/api/invoices");
        invalidateCachePrefix("/api/delivery-orders");
        invalidateCachePrefix("/api/sales-orders");
        refreshInvoices();
        refreshInvStats();
      }
    } catch {
      // ignore
    }
  };

  // Only DRAFT invoices can be advanced to SENT (mirrors the per-row
  // "Send to Customer" guard). Non-draft rows in the selection are ignored.
  const selectedDrafts = useMemo(
    () => selectedInvoices.filter((i) => i.status === "DRAFT"),
    [selectedInvoices]
  );
  const selectedDraftTotalSen = useMemo(
    () => selectedDrafts.reduce((s, i) => s + (i.totalSen || 0), 0),
    [selectedDrafts]
  );

  // Selected invoices whose customer has NO email on file — pre-flagged in
  // the confirm dialog so the owner isn't surprised by silent skips. Only
  // meaningful once the customers list has loaded (empty map → flag nothing;
  // the server-side notice chain still skips-and-reports as a backstop).
  const selectedNoEmail = useMemo(
    () =>
      customerEmailById.size === 0
        ? []
        : selectedInvoices.filter(
            (i) => i.customerId && !customerEmailById.has(i.customerId)
          ),
    [selectedInvoices, customerEmailById]
  );

  // One-button "Email to Customer" (2026-07-03, owner request — replaces the
  // separate Send-to-Customer and Re-send-email buttons). Per selected row:
  //   • DRAFT → finalise first (PUT status SENT — journal entries created),
  //     then email the unified PDF.
  //   • already sent → just re-email the current PDF (post-edit re-send).
  //   • no customer email on file → skipped, listed in the summary.
  // Sequential on purpose: finalising writes immutable journal entries +
  // cascades the linked SO; one-at-a-time keeps a failure isolated.
  const emailSelected = async () => {
    if (selectedInvoices.length === 0) return;
    setEmailConfirmOpen(false);
    setBatchRunning(true);
    let ok = 0;
    const errors: string[] = [];
    for (const inv of selectedInvoices) {
      if (
        customerEmailById.size > 0 &&
        inv.customerId &&
        !customerEmailById.has(inv.customerId)
      ) {
        errors.push(
          `${inv.invoiceNo}: skipped — ${inv.customerName} has no email on file (add it on the Customer page, then try again)`
        );
        continue;
      }
      try {
        if (inv.status === "DRAFT") {
          const fin = await fetchJson(
            `/api/invoices/${inv.id}`,
            InvoiceMutationSchema,
            { method: "PUT", body: { status: "SENT" } }
          );
          if (!fin.success) {
            errors.push(`${inv.invoiceNo}: couldn't finalise the draft — not emailed`);
            continue;
          }
        }
        // Pull the FULL invoice (the list row is slim — no items / DO id) so we
        // can render the exact same PDF the detail page downloads.
        const ir = await fetch(`/api/invoices/${encodeURIComponent(inv.id)}`, {
          credentials: "include",
        });
        const ij = (await ir.json()) as {
          data?: { deliveryOrderId?: string } & Record<string, unknown>;
        };
        const fullInv = ij?.data;
        const doId = fullInv?.deliveryOrderId || "";
        if (!fullInv || !doId) {
          errors.push(`${inv.invoiceNo}: no linked delivery order`);
          continue;
        }
        // Unify on ONE template (owner 2026-07-13): render with the SAME
        // unified generator the detail-page download uses (renderUnified-
        // InvoiceBase64 == downloadUnifiedInvoicePdf), so the re-sent email is
        // byte-identical to the download. print-extras adds the per-line spec.
        let pdfBase64: string | undefined;
        try {
          const [{ renderUnifiedInvoiceBase64 }, er] = await Promise.all([
            import("@/lib/unified-doc-download"),
            fetch(`/api/invoices/${encodeURIComponent(inv.id)}/print-extras`, {
              credentials: "include",
            }),
          ]);
          const ej = (await er.json().catch(() => ({}))) as {
            success?: boolean;
            data?: unknown;
          };
          pdfBase64 = await renderUnifiedInvoiceBase64(
            fullInv as Record<string, unknown> & { invoiceNo?: string },
            ej?.success ? (ej.data as Parameters<typeof renderUnifiedInvoiceBase64>[1]) : undefined
          );
        } catch {
          // Render failed — send without the client PDF; the server renders its
          // own fallback so the customer still gets the notice.
          pdfBase64 = undefined;
        }
        const r = await fetch(
          `/api/delivery-orders/${encodeURIComponent(doId)}/resend-notice`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: "DELIVERED",
              pdfBase64,
              pdfFilename: `${/^INV/i.test(inv.invoiceNo) ? inv.invoiceNo : `INV-${inv.invoiceNo}`}.pdf`,
            }),
          }
        );
        const j = (await r.json().catch(() => ({}))) as {
          success?: boolean;
          sent?: boolean;
          reason?: string;
          error?: string;
        };
        if (j?.success && j.sent) ok++;
        else errors.push(`${inv.invoiceNo}: ${j?.reason || j?.error || "not sent"}`);
      } catch (e) {
        errors.push(`${inv.invoiceNo}: ${e instanceof Error ? e.message : "failed"}`);
      }
    }
    // Drafts may have been finalised above — refresh lists + stats everywhere.
    invalidateCachePrefix("/api/invoices");
    invalidateCachePrefix("/api/delivery-orders");
    invalidateCachePrefix("/api/sales-orders");
    refreshInvoices();
    refreshInvStats();
    setBatchRunning(false);
    setSelectedInvoices([]);
    setBatchResult({ ok, fail: errors.length, errors });
  };

  // Bulk "Download PDF" — render EVERY selected invoice (any status, not just
  // drafts) into one merged PDF the owner opens/prints in a single go. The list
  // rows are the slim payload (no line items), so fetch each full invoice +
  // its print-extras, then hand them to generateCombinedInvoicePdf. Chunked so
  // a 20-30 invoice selection doesn't fire 60 requests at once.
  const downloadSelectedPdf = async () => {
    if (selectedInvoices.length === 0 || downloadingPdf) return;
    setDownloadingPdf(true);
    try {
      const ordered = [...selectedInvoices].sort((a, b) =>
        String(a.invoiceNo || "").localeCompare(String(b.invoiceNo || ""))
      );
      type CombinedItem = Parameters<
        typeof import("@/lib/unified-doc-download").downloadCombinedUnifiedInvoicePdf
      >[0][number];
      const items: CombinedItem[] = [];
      const CHUNK = 5;
      for (let i = 0; i < ordered.length; i += CHUNK) {
        const fetched = await Promise.all(
          ordered.slice(i, i + CHUNK).map(async (sel) => {
            const [invRes, exRes] = await Promise.all([
              fetch(`/api/invoices/${encodeURIComponent(sel.id)}`, {
                credentials: "include",
              }),
              fetch(
                `/api/invoices/${encodeURIComponent(sel.id)}/print-extras`,
                { credentials: "include" }
              ),
            ]);
            const invJson = (await invRes.json()) as {
              data?: CombinedItem["invoice"];
            };
            const invoice = invJson?.data ?? null;
            let extras: CombinedItem["extras"] = undefined;
            try {
              const ej = (await exRes.json()) as {
                success?: boolean;
                data?: CombinedItem["extras"];
              };
              if (ej?.success && ej.data) extras = ej.data;
            } catch {
              /* extras are optional — PDF still renders without them */
            }
            return invoice ? { invoice, extras } : null;
          })
        );
        for (const f of fetched) if (f) items.push(f);
      }
      if (items.length === 0) return;
      const { downloadCombinedUnifiedInvoicePdf } = await import(
        "@/lib/unified-doc-download"
      );
      await downloadCombinedUnifiedInvoicePdf(
        items,
        `Invoices-${items.length}.pdf`
      );
    } catch {
      /* best-effort; the button returns to idle on failure */
    } finally {
      setDownloadingPdf(false);
    }
  };

  const recordPayment = async (inv: Invoice) => {
    // BUG-2026-08-13-095 - this box IS `type="number"`, so the browser blocked
    // the comma and no wrong figure was ever posted from here; the old code
    // just `return`ed in silence, which reads as a dead button. One parser now,
    // and the refusal says why.
    const err = firstMoneyFieldError([{ label: "Payment amount (RM)", value: paymentAmount }]);
    if (err) { toast.error(err); return; }
    const amountSen = moneyFieldToSen(paymentAmount) as number;
    if (amountSen <= 0) return;

    setPaymentSubmitting(true);
    const totalPaid = inv.paidAmount + amountSen;
    try {
      const data = await fetchJson(`/api/invoices/${inv.id}`, InvoiceMutationSchema, {
        method: "PUT",
        body: {
          paidAmount: totalPaid,
          paymentMethod,
          paymentDate,
          paymentReference,
        },
      });
      if (data.success) {
        setPayingInvoiceId(null);
        setPaymentAmount("");
        setPaymentReference("");
        invalidateCachePrefix("/api/invoices");
        invalidateCachePrefix("/api/delivery-orders");
        invalidateCachePrefix("/api/sales-orders");
        refreshInvoices();
        refreshInvStats();
      }
    } catch {
      // ignore
    }
    setPaymentSubmitting(false);
  };

  // Filtered invoices. filterCustomer holds a customer ID (BUG-2026-07-03-003:
  // the dropdown used to put the customer NAME in filterCustomer while the
  // server fetch sent it as ?customerId= — the SQL matched nothing and the
  // list went blank the moment a customer was picked).
  const filteredInvoices = useMemo(() => {
    return invoices.filter((inv) => {
      if (filterStatus && inv.status !== filterStatus) return false;
      if (filterCustomer && inv.customerId !== filterCustomer) return false;
      if (filterDateFrom && inv.invoiceDate < filterDateFrom) return false;
      if (filterDateTo && inv.invoiceDate > filterDateTo) return false;
      return true;
    });
  }, [invoices, filterStatus, filterCustomer, filterDateFrom, filterDateTo]);

  // KPI calculations. All four (Total, Overdue, Outstanding RM, Collected
  // MTD) now read from the server /stats aggregate so they reflect the
  // whole dataset. 2026-05-26 audit fix — Outstanding RM and Collected MTD
  // previously iterated the current 200-row page only and undercounted
  // past page 1 (BUG-2026-05-26-003).
  const invStatsByStatus = invStatsResp?.byStatus ?? {};
  const totalInvoices = invStatsResp?.total ?? totalInvoicesServer;
  const outstandingSen = invStatsResp?.outstandingSen ?? 0;
  const paidMTDSen = invStatsResp?.paidMTDSen ?? 0;
  // OVERDUE is a first-class status in the invoices table (advanced by the
  // backend when dueDate passes). Use the stats bucket rather than iterating
  // the current page, so the KPI reflects the whole dataset.
  const overdueCount = invStatsByStatus.OVERDUE ?? 0;

  // AR Aging data — now WHOLE-dataset (server-computed, /api/invoices/aging).
  // The old client computation (kept in git history) bucketed only the loaded
  // page, undercounting AR past page 1; the server endpoint ports the exact
  // same bucket logic over every matching invoice.
  const agingData: AgingRow[] = useMemo(
    () =>
      agingResp?.success && Array.isArray(agingResp.data) ? agingResp.data : [],
    [agingResp],
  );

  const agingTotals = useMemo(() => {
    return agingData.reduce(
      (acc, row) => ({
        current: acc.current + row.current,
        days31_60: acc.days31_60 + row.days31_60,
        days61_90: acc.days61_90 + row.days61_90,
        days90plus: acc.days90plus + row.days90plus,
        total: acc.total + row.total,
      }),
      { current: 0, days31_60: 0, days61_90: 0, days90plus: 0, total: 0 }
    );
  }, [agingData]);

  // ---------- Invoice DataGrid Columns ----------
  const invoiceGridColumns: Column<Invoice>[] = useMemo(() => [
    { key: "invoiceNo", label: "Invoice No", type: "docno", width: "120px", sortable: true },
    { key: "doNo", label: "DO No", type: "docno", width: "120px", sortable: true },
    { key: "customerName", label: "Customer", type: "text", sortable: true },
    { key: "invoiceDate", label: "Invoice Date", type: "date", width: "110px", sortable: true },
    { key: "dueDate", label: "Due Date", type: "date", width: "110px", sortable: true },
    { key: "totalSen", label: "Total", type: "currency", width: "120px", sortable: true },
    { key: "paidAmount", label: "Paid", type: "currency", width: "120px", sortable: true,
      render: (value: number) => (
        <span className="text-[#4F7C3A] tabular-nums">{value > 0 ? formatCurrency(value) : "-"}</span>
      ),
    },
    { key: "status", label: "Status", type: "status", width: "110px", sortable: true },
  ], []);

  const invoiceGridContextMenu = useCallback((row: Invoice): ContextMenuItem[] => [
    { label: "View", action: () => navigate(`/invoices/${row.id}`) },
    { label: "Print Invoice", action: () => navigate(`/invoices/${row.id}`) },
    { label: "", separator: true, action: () => {} },
    { label: "Record Payment", action: () => {
        const balance = row.totalSen - row.paidAmount;
        setPaymentAmount(String(balance / 100));
        setPaymentDate(new Date().toISOString().split("T")[0]);
        setPaymentReference("");
        setPaymentMethod("BANK_TRANSFER");
        setPayingInvoiceId(row.id);
      },
      disabled: !["SENT", "PARTIAL_PAID"].includes(row.status),
    },
    { label: "", separator: true, action: () => {} },
    { label: "Send to Customer", action: () => advanceStatus(row, "SENT"),
      disabled: row.status !== "DRAFT",
    },
    { label: "", separator: true, action: () => {} },
    { label: "Refresh", action: () => { refreshInvoices(); refreshInvStats(); } },
  ], [navigate, refreshInvoices, refreshInvStats]);

  // 2026-06-04: removed the full-page `if (loading) return <Loading…>` gate.
  // It blanked the WHOLE page (no header / KPI cards / tabs) on cold load.
  // Now the shell renders immediately; the grid shows skeleton rows
  // (loading prop) and the KPI cards show "—" until /stats lands (below),
  // so nothing flashes a misleading "0". Pure display change — no data path
  // touched. (Front-end loading-smoothness pass.)
  return (
    <div className="space-y-6 max-md:space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Invoices</h1>
          <p className="text-xs text-[#6B7280]">
            Invoice management, billing, and payment tracking
          </p>
        </div>
        <Button variant="primary" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          New Invoice
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#F0ECE9] p-2.5 shrink-0"><FileText className="h-5 w-5 text-[#6B5C32]" /></div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#1F1D1B]">{invStatsResp ? totalInvoices : "—"}</p>
              <p className="text-xs text-[#6B7280]">Total Invoices</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FAEFCB] p-2.5 shrink-0"><DollarSign className="h-5 w-5 text-[#9C6F1E]" /></div>
            <div className="min-w-0">
              <p className="text-xl font-bold text-[#9C6F1E] truncate">
                {invStatsResp ? formatCurrency(outstandingSen) : "—"}
              </p>
              <p className="text-xs text-[#6B7280]">Outstanding</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#EEF3E4] p-2.5 shrink-0"><CheckCircle2 className="h-5 w-5 text-[#4F7C3A]" /></div>
            <div className="min-w-0">
              <p className="text-xl font-bold text-[#4F7C3A] truncate">
                {invStatsResp ? formatCurrency(paidMTDSen) : "—"}
              </p>
              <p className="text-xs text-[#6B7280]">Collected (MTD)</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FDECEA] p-2.5 shrink-0"><AlertTriangle className="h-5 w-5 text-[#9A3A2D]" /></div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#9A3A2D]">{invStatsResp ? overdueCount : "—"}</p>
              <p className="text-xs text-[#6B7280]">Overdue</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#E2DDD8] overflow-x-auto">
        <button
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "list"
              ? "border-[#6B5C32] text-[#6B5C32]"
              : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
          }`}
          onClick={() => setActiveTab("list")}
        >
          <List className="h-4 w-4" />
          Invoices
        </button>
        <button
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "aging"
              ? "border-[#6B5C32] text-[#6B5C32]"
              : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
          }`}
          onClick={() => setActiveTab("aging")}
        >
          <BarChart3 className="h-4 w-4" />
          AR Aging
        </button>
      </div>

      {activeTab === "list" && (
        <>
          {/* Status tab strip — each state with how many invoices are in it and
              what they are worth. Replaces the old Status dropdown: one control,
              one set of numbers. */}
          <StatusTabStrip
            variant="underline"
            value={filterStatus}
            onChange={setFilterStatus}
            moneyLabel="Invoiced total"
            ariaLabel="Invoice status"
            tabs={statusTabs}
          />

          {/* Filters */}
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">
                    Customer
                  </label>
                  <select
                    className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                    value={filterCustomer}
                    onChange={(e) => setFilterCustomer(e.target.value)}
                  >
                    <option value="">All Customers</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">
                    From Date
                  </label>
                  <input
                    type="date"
                    className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                    value={filterDateFrom}
                    onChange={(e) => setFilterDateFrom(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">
                    To Date
                  </label>
                  <input
                    type="date"
                    className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                    value={filterDateTo}
                    onChange={(e) => setFilterDateTo(e.target.value)}
                  />
                </div>
                {(filterStatus || filterCustomer || filterDateFrom || filterDateTo) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[#6B7280]"
                    onClick={() => {
                      setFilterStatus("");
                      setFilterCustomer("");
                      setFilterDateFrom("");
                      setFilterDateTo("");
                    }}
                  >
                    <X className="h-3 w-3" />
                    Clear
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Invoice Table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-[#6B5C32]" />
                All Invoices
                {(filterStatus || filterCustomer || filterDateFrom || filterDateTo) && (
                  <span className="text-sm font-normal text-[#6B7280]">
                    ({filteredInvoices.length} of {invoices.length})
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {selectedInvoices.length > 0 && (
                <div className="flex items-center justify-between bg-[#F7F4F0] border border-[#E2DDD8] rounded-md px-4 py-2 mb-3">
                  <span className="text-sm text-[#4B5563]">
                    {selectedInvoices.length} selected
                    {selectedDrafts.length !== selectedInvoices.length
                      ? ` · ${selectedDrafts.length} draft can be sent`
                      : ""}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedInvoices([])}
                    >
                      Clear
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={downloadingPdf}
                      onClick={downloadSelectedPdf}
                    >
                      <Download className="w-4 h-4 mr-1" />
                      {downloadingPdf
                        ? "Preparing…"
                        : `Download PDF (${selectedInvoices.length})`}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={batchRunning}
                      onClick={() => setEmailConfirmOpen(true)}
                      title="Email the invoice PDF to each customer — drafts are finalised first; already-sent invoices are re-emailed with the current PDF"
                    >
                      <Send className="w-4 h-4 mr-1" />
                      Email to Customer ({selectedInvoices.length})
                    </Button>
                  </div>
                </div>
              )}
              <DataGrid<Invoice>
                columns={invoiceGridColumns}
                data={filteredInvoices}
                loading={loading}
                keyField="id"
                virtualize
                // Stable id — the column picker / drag / resize state persists
                // under it. Renaming it silently discards saved layouts.
                gridId="invoices-list"
                selectable
                onSelectionChange={(rows: Invoice[]) => setSelectedInvoices(rows)}
                onDoubleClick={(row) => navigate(`/invoices/${row.id}`)}
                contextMenuItems={invoiceGridContextMenu}
                maxHeight="calc(100vh - 300px)"
                emptyMessage="No invoices found."
                initialSearch={gridSearch}
                onSearchChange={setGridSearch}
                alwaysSearchKeys={INVOICE_SEARCH_KEYS}
                // WYSIWYG export of the current columns over the current rows.
                // Listing only, deliberately: GET /api/invoices ships
                // `items: []` on every row (the 2026-05-21 list-payload trim),
                // so a per-line "Detail Listing" here would export a header
                // and a page of blank line columns. It needs a per-invoice
                // re-fetch, which is a feature, not this wiring.
                exportName="invoices"
                exportSheetLabel="Invoices"
              />

              {/* Pagination footer */}
              <div className="flex items-center justify-between border-t border-[#E2DDD8] pt-3 mt-3 text-sm text-[#6B7280]">
                <span>
                  {totalInvoicesServer.toLocaleString()} invoice
                  {totalInvoicesServer === 1 ? "" : "s"}
                </span>
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1 || loading}
                  >
                    ← Prev
                  </Button>
                  <span className="tabular-nums text-[#1F1D1B]">
                    Page {page} / {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages || loading}
                  >
                    Next →
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {activeTab === "aging" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-[#6B5C32]" />
              Accounts Receivable Aging Report
            </CardTitle>
          </CardHeader>
          <CardContent>
            {agingData.length === 0 ? (
              <p className="text-sm text-[#6B7280] text-center py-8">
                No outstanding invoices found.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                      <th className="text-left py-3 px-4 text-xs font-bold text-[#4B5563]">
                        Customer
                      </th>
                      <th className="text-right py-3 px-4 text-xs font-bold text-[#4F7C3A]">
                        Current (0-30)
                      </th>
                      <th className="text-right py-3 px-4 text-xs font-bold text-[#9C6F1E]">
                        31-60 Days
                      </th>
                      <th className="text-right py-3 px-4 text-xs font-bold text-[#B8601A]">
                        61-90 Days
                      </th>
                      <th className="text-right py-3 px-4 text-xs font-bold text-[#9A3A2D]">
                        90+ Days
                      </th>
                      <th className="text-right py-3 px-4 text-xs font-bold text-[#1F1D1B]">
                        Total Outstanding
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {agingData.map((row) => (
                      <tr
                        key={row.customerName}
                        className="border-b border-[#E2DDD8] hover:bg-[#F0ECE9]/50"
                      >
                        <td className="py-3 px-4 font-medium text-[#1F1D1B]">
                          {row.customerName}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className={row.current > 0 ? "text-[#4F7C3A] font-medium" : "text-[#9CA3AF]"}>
                            {row.current > 0 ? formatCurrency(row.current) : "-"}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className={row.days31_60 > 0 ? "text-[#9C6F1E] font-medium" : "text-[#9CA3AF]"}>
                            {row.days31_60 > 0 ? formatCurrency(row.days31_60) : "-"}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className={row.days61_90 > 0 ? "text-[#B8601A] font-medium" : "text-[#9CA3AF]"}>
                            {row.days61_90 > 0 ? formatCurrency(row.days61_90) : "-"}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className={row.days90plus > 0 ? "text-[#9A3A2D] font-medium" : "text-[#9CA3AF]"}>
                            {row.days90plus > 0 ? formatCurrency(row.days90plus) : "-"}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right font-bold text-[#1F1D1B]">
                          {formatCurrency(row.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-[#6B5C32] bg-[#F0ECE9]">
                      <td className="py-3 px-4 font-bold text-[#6B5C32]">TOTAL</td>
                      <td className="py-3 px-4 text-right font-bold text-[#4F7C3A]">
                        {agingTotals.current > 0 ? formatCurrency(agingTotals.current) : "-"}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-[#9C6F1E]">
                        {agingTotals.days31_60 > 0 ? formatCurrency(agingTotals.days31_60) : "-"}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-[#B8601A]">
                        {agingTotals.days61_90 > 0 ? formatCurrency(agingTotals.days61_90) : "-"}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-[#9A3A2D]">
                        {agingTotals.days90plus > 0 ? formatCurrency(agingTotals.days90plus) : "-"}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-[#1F1D1B] text-base">
                        {formatCurrency(agingTotals.total)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Inline Payment Modal */}
      {payingInvoiceId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            {(() => {
              const inv = invoices.find((i) => i.id === payingInvoiceId);
              if (!inv) return null;
              const balance = inv.totalSen - inv.paidAmount;
              return (
                <>
                  <h2 className="text-lg font-bold text-[#1F1D1B] mb-1">
                    Record Payment
                  </h2>
                  <p className="text-sm text-[#6B7280] mb-4">
                    {inv.invoiceNo} - {inv.customerName}
                  </p>
                  <p className="text-sm text-[#6B7280] mb-4">
                    Balance due:{" "}
                    <span className="font-bold text-[#9A3A2D]">
                      {formatCurrency(balance)}
                    </span>
                  </p>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-[#4B5563] mb-1">
                        Payment Amount (RM)
                      </label>
                      <input
                        type="number" onFocus={(e) => e.currentTarget.select()}
                        step="0.01"
                        min="0"
                        className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                        value={paymentAmount}
                        onChange={(e) => setPaymentAmount(e.target.value)}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-[#4B5563] mb-1">
                        Payment Date
                      </label>
                      <input
                        type="date"
                        className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                        value={paymentDate}
                        onChange={(e) => setPaymentDate(e.target.value)}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-[#4B5563] mb-1">
                        Reference (Cheque No / Transfer Ref)
                      </label>
                      <input
                        type="text"
                        className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                        placeholder="e.g. CHQ-001234 or TRF-20260414"
                        value={paymentReference}
                        onChange={(e) => setPaymentReference(e.target.value)}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-[#4B5563] mb-1">
                        Payment Method
                      </label>
                      <select
                        className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                        value={paymentMethod}
                        onChange={(e) => setPaymentMethod(e.target.value)}
                      >
                        <option value="CASH">Cash</option>
                        <option value="CHEQUE">Cheque</option>
                        <option value="BANK_TRANSFER">Bank Transfer</option>
                        <option value="CREDIT_CARD">Credit Card</option>
                        <option value="E_WALLET">E-Wallet</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 mt-6">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setPayingInvoiceId(null);
                        setPaymentAmount("");
                        setPaymentReference("");
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => recordPayment(inv)}
                      disabled={
                        paymentSubmitting ||
                        !paymentAmount ||
                        // Same parser as `recordPayment`, so the button and the handler
                        // can never disagree about what the box says.
                        !((moneyFieldToSen(paymentAmount) ?? 0) > 0)
                      }
                    >
                      {paymentSubmitting ? "Processing..." : "Record Payment"}
                    </Button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Create Invoice Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold text-[#1F1D1B] mb-4">
              Create Invoice from Delivery Order
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#4B5563] mb-1">
                  Select Delivery Order
                </label>
                <select
                  className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                  value={selectedDOId}
                  onChange={(e) => setSelectedDOId(e.target.value)}
                >
                  <option value="">-- Select DO --</option>
                  {deliveryOrders.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.doNo} - {d.customerName}
                    </option>
                  ))}
                </select>
                {deliveryOrders.length === 0 && (
                  <p className="text-xs text-[#9CA3AF] mt-1">
                    No eligible delivery orders found (DELIVERED or LOADED status required)
                  </p>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button
                variant="outline"
                onClick={() => {
                  setShowCreateModal(false);
                  setSelectedDOId("");
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={createInvoice}
                disabled={!selectedDOId || creating}
              >
                {creating ? "Creating..." : "Create Invoice"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Email-to-Customer confirm (one dialog for drafts + re-sends) */}
      {emailConfirmOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold text-[#1F1D1B] mb-2">
              Email {selectedInvoices.length} invoice
              {selectedInvoices.length === 1 ? "" : "s"} to customer
              {selectedInvoices.length === 1 ? "" : "s"}?
            </h2>
            {selectedDrafts.length > 0 && (
              <p className="text-sm text-[#4B5563] mb-2">
                <span className="font-semibold">{selectedDrafts.length}</span>{" "}
                draft{selectedDrafts.length === 1 ? "" : "s"} totalling{" "}
                <span className="font-semibold">
                  {formatCurrency(selectedDraftTotalSen)}
                </span>{" "}
                will be finalised first — accounting entries are created and
                this cannot be undone.
              </p>
            )}
            {selectedInvoices.length > selectedDrafts.length && (
              <p className="text-sm text-[#4B5563] mb-2">
                Already-sent invoices are re-emailed with the current PDF.
              </p>
            )}
            {selectedNoEmail.length > 0 && (
              <p className="text-sm text-[#B91C1C] mb-2">
                {selectedNoEmail.length} will be skipped — customer has no
                email on file:{" "}
                {[...new Set(selectedNoEmail.map((i) => i.customerName))].join(", ")}.
                Add the email on the Customer page first.
              </p>
            )}
            {batchRunning && (
              <p className="text-sm text-[#9C6F1E] mb-4">
                Sending… please don't close this window.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setEmailConfirmOpen(false)}
                disabled={batchRunning}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={emailSelected}
                disabled={
                  batchRunning ||
                  selectedInvoices.length - selectedNoEmail.length === 0
                }
              >
                {batchRunning
                  ? "Sending…"
                  : `Send ${selectedInvoices.length - selectedNoEmail.length} email${selectedInvoices.length - selectedNoEmail.length === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Batch result summary */}
      {batchResult && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold text-[#1F1D1B] mb-3">
              Batch send complete
            </h2>
            <p className="text-sm text-[#1F1D1B] mb-2">
              <span className="font-semibold text-[#4F7C3A]">
                {batchResult.ok}
              </span>{" "}
              sent successfully
              {batchResult.fail > 0 ? (
                <>
                  ,{" "}
                  <span className="font-semibold text-[#B91C1C]">
                    {batchResult.fail}
                  </span>{" "}
                  failed
                </>
              ) : (
                "."
              )}
            </p>
            {batchResult.errors.length > 0 && (
              <div className="max-h-48 overflow-y-auto rounded-md border border-[#E2DDD8] bg-[#FBF7F2] p-3 text-xs text-[#6B5C32] mb-4">
                {batchResult.errors.slice(0, 20).map((e, i) => (
                  <div key={i} className="font-mono">
                    {e}
                  </div>
                ))}
                {batchResult.errors.length > 20 && (
                  <div className="mt-1 italic">
                    …and {batchResult.errors.length - 20} more
                  </div>
                )}
              </div>
            )}
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => setBatchResult(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
