import { useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataGrid } from "@/components/ui/data-grid";
import type { Column, ContextMenuItem } from "@/components/ui/data-grid";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { formatCurrency, cn } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { useUrlState } from "@/lib/use-url-state";
import type { Supplier } from "@/types";
import {
  FileText,
  Clock,
  AlertTriangle,
  CheckCircle2,
  DollarSign,
  X,
  Eye,
  Printer,
  RefreshCw,
  ArrowRight,
  Download,
  Plus,
  ScanLine,
  FolderInput,
  List,
} from "lucide-react";
import {
  FromSourceModal,
  type SourceSelection,
} from "@/components/from-source-modal";

// ============================================================
// Types
// ============================================================
// Lifecycle simplification (owner 2026-06-29): DRAFT → CONFIRMED → PAID.
// PENDING_APPROVAL / APPROVED kept in the union only so legacy rows that
// still carry those values don't break TypeScript reads; the UI renders
// them as CONFIRMED (see normalizePiStatus below).
type PIStatus = "DRAFT" | "CONFIRMED" | "PAID" | "PENDING_APPROVAL" | "APPROVED" | "CANCELLED";

type PurchaseInvoice = {
  id: string;
  piNo: string;
  poRef: string;
  supplierId: string;
  supplier: string;
  invoiceDate: string;
  dueDate: string;
  amountSen: number;
  status: PIStatus;
  remarks: string;
  purchaseOrgCode?: string;
};

// Result of POST /purchase-invoices/backfill-gl-postings — admin maintenance
// response, read defensively (all fields optional).
type BackfillResult = {
  success?: boolean;
  error?: string;
  posted?: number;
  postedRm?: number;
  alreadyPosted?: number;
  failed?: number;
};

// Fold legacy PENDING_APPROVAL / APPROVED rows into CONFIRMED so the UI
// shows one active state. The backend may still emit either value until
// migrated — read-side only normalization, never written back.
function normalizePiStatus(s: string): string {
  if (s === "PENDING_APPROVAL" || s === "APPROVED") return "CONFIRMED";
  return s;
}

// ============================================================
// STATUS OPTIONS
// ============================================================
const ALL_PI_STATUSES = [
  { value: "", label: "All Statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "PAID", label: "Paid" },
  { value: "CANCELLED", label: "Cancelled" },
];

// ============================================================
// MAIN PAGE
// ============================================================
export default function PurchaseInvoicesPage() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const navigate = useNavigate();

  // One-time maintenance: post CONFIRMED PIs that are missing from the general
  // ledger (POST /backfill-gl-postings). Dry-run → confirm with the totals →
  // post. from = the opening cutoff (earlier PIs are carried by opening
  // balances, never re-posted). Idempotent — already-posted PIs are skipped.
  const [postingGl, setPostingGl] = useState(false);
  const runGlBackfill = useCallback(async () => {
    setPostingGl(true);
    try {
      const dry: BackfillResult = await (
        await fetch("/api/purchase-invoices/backfill-gl-postings?dry=1&from=2026-05-22", { method: "POST" })
      ).json();
      if (!dry?.success) { toast.error(dry?.error || "Preview failed"); return; }
      if (!dry.posted) { toast.success(`All caught up — ${dry.alreadyPosted ?? 0} invoice(s) already on the GL.`); return; }
      const ok = await confirm({
        title: "Post invoices to GL",
        message: `Post ${dry.posted} purchase invoice(s) totalling RM ${Number(dry.postedRm ?? 0).toLocaleString()} to the general ledger? Already-posted invoices are skipped — safe to re-run.`,
        danger: false,
      });
      if (!ok) return;
      const real: BackfillResult = await (
        await fetch("/api/purchase-invoices/backfill-gl-postings?from=2026-05-22", { method: "POST" })
      ).json();
      if (real?.success) {
        toast.success(`Posted ${real.posted} invoice(s) · RM ${Number(real.postedRm ?? 0).toLocaleString()}${real.failed ? ` · ${real.failed} failed` : ""}`);
      } else {
        toast.error(real?.error || "Posting failed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Posting failed");
    } finally {
      setPostingGl(false);
    }
  }, [confirm, toast]);

  // Tabs — single "Purchase Invoices" tab, same skeleton as Sales Invoice list
  const [activeTab] = useState<"list">("list");

  // Draft / Confirmed split — mirrors the Sales Order list. CONFIRMED tab
  // shows everything that ISN'T DRAFT (so CONFIRMED + PAID + CANCELLED all
  // live here); DRAFT tab is only DRAFT rows. URL-synced so refresh and
  // shared links land on the same view.
  const [tab, setTab] = useUrlState<"DRAFT" | "CONFIRMED">("tab", "CONFIRMED");
  const [selectedRows, setSelectedRows] = useState<PurchaseInvoice[]>([]);
  const [bulkConverting, setBulkConverting] = useState(false);
  // Bumped to clear the DataGrid's OWN selection (its checkboxes), which
  // emptying selectedRows alone does not touch.
  const [clearSelectionToken, setClearSelectionToken] = useState(0);
  const selectedDraftCount = useMemo(
    () => selectedRows.filter((r) => r.status === "DRAFT").length,
    [selectedRows],
  );

  // Filters
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSupplier, setFilterSupplier] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  // From PO / GRN picker
  const [fromSourceOpen, setFromSourceOpen] = useState(false);
  const handleFromSource = (sel: SourceSelection) => {
    const param =
      sel.type === "po" ? `poId=${sel.id}` : `grnId=${sel.id}`;
    navigate(`/procurement/pi/create?${param}`);
  };

  // Wired to /api/purchase-invoices 2026-04-26 — replaces the previous
  // generateMockPIs + invoiceOverrides client-side state. Status changes
  // (Approve / Mark Paid) now PUT through the real backend so refreshes
  // and other tabs see the same data.
  const { data: piResp, loading, refresh: fetchData } = useCachedJson<{
    success?: boolean;
    data?: PurchaseInvoice[];
  }>("/api/purchase-invoices");
  const invoices: PurchaseInvoice[] = useMemo(
    () => piResp?.data ?? [],
    [piResp],
  );

  // Suppliers populate the create dialog's supplier picker. Lazy-loaded the
  // same way procurement/create.tsx does — the cache is shared so the PO
  // create page warms it too.
  const { data: supResp } = useCachedJson<{
    success?: boolean;
    data?: Supplier[];
  }>("/api/suppliers");
  const suppliers: Supplier[] = useMemo(
    () => supResp?.data ?? [],
    [supResp],
  );
  // Purchase Company letterhead registry — print each PI under its supplier's
  // buying company (accounting stays HOOKKA).
  const { data: orgsResp } = useCachedJson<{ organisations?: Array<{ code?: string; name?: string; regNo?: string; tin?: string; address?: string; phone?: string; email?: string }> }>("/api/organisations");

  const updateStatus = useCallback(
    async (id: string, nextStatus: PIStatus, extra?: Record<string, unknown>) => {
      try {
        const res = await fetch(`/api/purchase-invoices/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...extra, status: nextStatus }),
        });
        const j = (await res.json().catch(() => null)) as
          | { success?: boolean; error?: string }
          | null;
        if (!res.ok || !j?.success) {
          toast.error(j?.error || `Failed to update PI to ${nextStatus}`);
          return;
        }
        invalidateCachePrefix("/api/purchase-invoices");
        fetchData();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update PI");
      }
    },
    [toast, fetchData],
  );

  // ---- Filters ----
  const hasActiveFilters = filterStatus || filterSupplier || filterDateFrom || filterDateTo;

  const clearFilters = () => {
    setFilterStatus("");
    setFilterSupplier("");
    setFilterDateFrom("");
    setFilterDateTo("");
  };

  const filteredByUserFilters = useMemo(() => {
    return invoices.filter(pi => {
      // Status filter normalizes the row so a CONFIRMED filter also matches
      // legacy PENDING_APPROVAL / APPROVED rows during the lifecycle migration.
      if (filterStatus && normalizePiStatus(pi.status) !== filterStatus) return false;
      if (filterSupplier && pi.supplierId !== filterSupplier) return false;
      if (filterDateFrom && pi.invoiceDate < filterDateFrom) return false;
      if (filterDateTo && pi.invoiceDate > filterDateTo) return false;
      return true;
    });
  }, [invoices, filterStatus, filterSupplier, filterDateFrom, filterDateTo]);

  // Tab filter — DRAFT tab shows only DRAFT rows; CONFIRMED tab shows
  // everything else (CONFIRMED + legacy PENDING_APPROVAL/APPROVED + PAID +
  // CANCELLED). Mirrors the Sales Order list split.
  const filteredInvoices = useMemo(() => {
    return filteredByUserFilters.filter(pi => {
      if (tab === "DRAFT" && pi.status !== "DRAFT") return false;
      if (tab === "CONFIRMED" && pi.status === "DRAFT") return false;
      return true;
    });
  }, [filteredByUserFilters, tab]);

  // Tab badge counts — whole-list, not the current filter, so the operator
  // always sees the real Draft backlog.
  const draftCount = useMemo(
    () => invoices.filter(pi => pi.status === "DRAFT").length,
    [invoices],
  );
  const tabConfirmedCount = useMemo(
    () => invoices.filter(pi => pi.status !== "DRAFT").length,
    [invoices],
  );

  // Bulk DRAFT → CONFIRMED — parallel PUTs, then cache invalidation. Per the
  // BE lifecycle map only DRAFT rows are valid sources for this transition.
  const bulkConvertDrafts = useCallback(async () => {
    const drafts = selectedRows.filter(r => r.status === "DRAFT");
    if (drafts.length === 0) return;
    if (
      !(await confirm({
        title: "Convert drafts",
        message: `Convert ${drafts.length} draft invoice(s) to CONFIRMED?`,
        danger: false,
      }))
    )
      return;
    setBulkConverting(true);
    const results = await Promise.all(
      drafts.map(async (pi) => {
        try {
          const res = await fetch(`/api/purchase-invoices/${pi.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "CONFIRMED" }),
          });
          const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
          if (!res.ok || !j?.success) {
            return { ok: false, id: pi.piNo, err: j?.error || `HTTP ${res.status}` };
          }
          return { ok: true, id: pi.piNo };
        } catch (e) {
          return { ok: false, id: pi.piNo, err: (e as Error).message };
        }
      }),
    );
    setBulkConverting(false);
    const failed = results.filter(r => !r.ok);
    invalidateCachePrefix("/api/purchase-invoices");
    fetchData();
    setSelectedRows([]);
    if (failed.length > 0) {
      const sample = failed.slice(0, 3).map(f => f.id).join(", ");
      toast.error(`Converted ${results.length - failed.length} · Failed ${failed.length} (${sample})`);
    } else {
      toast.success(`Converted ${results.length} invoice${results.length !== 1 ? "s" : ""} successfully.`);
    }
    if (results.length - failed.length > 0) setTab("CONFIRMED");
  }, [selectedRows, confirm, toast, fetchData, setTab]);

  // ---- Export CSV ----
  const exportCSV = () => {
    const headers = ["PI No.", "PO Ref", "Supplier", "Invoice Date", "Due Date", "Amount (RM)", "Status"];
    const rows = filteredInvoices.map(pi => [
      pi.piNo,
      pi.poRef,
      pi.supplier,
      pi.invoiceDate,
      pi.dueDate,
      (pi.amountSen / 100).toFixed(2),
      pi.status,
    ]);
    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `purchase-invoices-${new Date().toISOString().split("T")[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // ---- Summary stats — reflect the user's active filters so the cards
  // ---- always match the table below. Owner ruling 2026-06-30: if I filter
  // ---- to a date range, the totals must follow.
  const totalPIs = filteredByUserFilters.length;
  // "Pending payment" = anything not yet PAID and not cancelled. DRAFT +
  // CONFIRMED (incl. legacy PENDING_APPROVAL / APPROVED) all count.
  const pendingPayment = filteredByUserFilters.filter(pi => {
    const s = normalizePiStatus(pi.status);
    return s !== "PAID" && s !== "CANCELLED";
  }).length;
  const today = new Date().toISOString().split("T")[0];
  const overdue = filteredByUserFilters.filter(pi => normalizePiStatus(pi.status) !== "PAID" && pi.dueDate < today).length;
  const totalValueSen = filteredByUserFilters.reduce((sum, pi) => sum + pi.amountSen, 0);

  // ---- Status pipeline (post-lifecycle simplification) ----
  const confirmedCount = invoices.filter(pi => {
    const s = normalizePiStatus(pi.status);
    return s === "CONFIRMED";
  }).length;
  const statusCounts = [
    { label: "Draft", status: "DRAFT", count: invoices.filter(pi => pi.status === "DRAFT").length },
    { label: "Confirmed", status: "CONFIRMED", count: confirmedCount },
    { label: "Paid", status: "PAID", count: invoices.filter(pi => pi.status === "PAID").length },
  ];

  // ---- Unique suppliers ----
  const uniqueSuppliers = useMemo(() => {
    const map = new Map<string, string>();
    for (const pi of invoices) {
      if (pi.supplierId && pi.supplier) {
        map.set(pi.supplierId, pi.supplier);
      }
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [invoices]);

  // Purchase company display map: org code → legal name (badge).
  const orgNameByCode = useMemo(() => {
    const out: Record<string, string> = {};
    for (const o of orgsResp?.organisations ?? []) {
      if (o.code) out[o.code] = o.name || o.code;
    }
    return out;
  }, [orgsResp]);

  // ---- Columns ----
  const piGridColumns: Column<PurchaseInvoice>[] = useMemo(() => [
    { key: "piNo", label: "PI No.", type: "docno", width: "130px", sortable: true },
    { key: "poRef", label: "PO Ref", type: "docno", width: "130px", sortable: true },
    { key: "supplier", label: "Supplier", type: "text", sortable: true },
    // Supplier-side reference numbers (migration 0105). Operator-critical:
    // these are what the supplier writes on their own invoice/DO and what
    // the AP team matches against. Owner ruling 2026-06-29 evening: these
    // belong as first-class columns next to the supplier.
    { key: "supplierInvoiceNo", label: "Supplier Inv No.", type: "text", width: "140px", sortable: true },
    { key: "supplierDoNo", label: "Supplier DO No.", type: "text", width: "140px", sortable: true },
    {
      key: "purchaseOrgCode",
      label: "Purchase co",
      type: "text",
      width: "120px",
      sortable: true,
      render: (_v: unknown, row: PurchaseInvoice) => {
        const code = row.purchaseOrgCode || "HOOKKA";
        const label = orgNameByCode[code] || code;
        return (
          <span
            className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-[#F0ECE9] text-[#6B5C32]"
            title={code}
          >
            {label}
          </span>
        );
      },
    },
    { key: "invoiceDate", label: "Invoice Date", type: "date", width: "120px", sortable: true },
    { key: "dueDate", label: "Due Date", type: "date", width: "120px", sortable: true },
    { key: "amountSen", label: "Amount", type: "currency", width: "130px", sortable: true },
    {
      key: "status",
      label: "Status",
      type: "status",
      width: "140px",
      sortable: true,
      // Lifecycle simplification (2026-06-29): legacy PENDING_APPROVAL / APPROVED
      // rows render as CONFIRMED so the operator only sees the new vocabulary.
      render: (_v: unknown, row: PurchaseInvoice) => {
        const shown = normalizePiStatus(row.status);
        return <Badge variant="status" status={shown}>{shown.replace(/_/g, " ")}</Badge>;
      },
    },
  ], [orgNameByCode]);

  // One printable PI. List rows are lean (rowToPI ships no items[]), so the
  // full invoice is fetched before printing. Shared by the row menu's
  // "Print PI" and the bulk print below, so a single print and a bulk print
  // can never render the document differently (letterhead, supplier block).
  // Returns null on any failure; the caller decides how loudly to complain.
  const loadPiForPrint = useCallback(
    async (id: string) => {
      const [{ letterheadForPurchaseOrg }] = await Promise.all([
        import("@/lib/generate-purchase-order-pdf"),
      ]);
      const res = await fetch(`/api/purchase-invoices/${id}`);
      const j = (await res.json().catch(() => null)) as
        | { success?: boolean; data?: Record<string, unknown> }
        | null;
      if (!res.ok || !j?.success || !j.data) return null;
      const supId = (j.data as { supplierId?: string }).supplierId;
      const sup = suppliers.find((s) => s.id === supId);
      return {
        pi: {
          ...(j.data as Record<string, unknown>),
          supplierAddress: sup?.address,
          supplierContact: sup?.contactPerson,
          supplierPhone: sup?.phone,
          supplierEmail: sup?.email,
        },
        letterhead: letterheadForPurchaseOrg(
          sup?.purchaseOrgCode || "HOOKKA",
          orgsResp?.organisations,
        ),
      };
    },
    [suppliers, orgsResp],
  );

  const piGridContextMenu = useCallback((row: PurchaseInvoice): ContextMenuItem[] => {
    return [
      {
        label: "View",
        icon: <Eye className="h-3.5 w-3.5" />,
        action: () => navigate(`/procurement/pi/${row.id}`),
      },
      {
        label: "Print PI",
        icon: <Printer className="h-3.5 w-3.5" />,
        action: async () => {
          try {
            const loaded = await loadPiForPrint(row.id);
            if (!loaded) {
              toast.error("Could not load the invoice to print.");
              return;
            }
            const { generatePurchaseInvoicePdf } = await import(
              "@/lib/generate-purchase-invoice-pdf"
            );
            generatePurchaseInvoicePdf(
              loaded.pi as unknown as Parameters<typeof generatePurchaseInvoicePdf>[0],
              loaded.letterhead,
            );
          } catch {
            toast.error("Could not generate the PDF.");
          }
        },
      },
      { label: "", separator: true, action: () => {} },
      {
        // Lifecycle simplification (2026-06-29): one Confirm step takes a
        // DRAFT straight to CONFIRMED — no Pending Approval / Approve hop.
        label: "Confirm",
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
        action: () => updateStatus(row.id, "CONFIRMED" as PIStatus),
        disabled: row.status !== "DRAFT",
      },
      {
        label: "Mark Paid",
        icon: <DollarSign className="h-3.5 w-3.5" />,
        action: () => {
          // Phase 3.6 — a foreign PI settles at the PAYMENT-DAY rate; the
          // realised difference vs the booking rate posts to 530-0000.
          const fx = row as unknown as { currency?: string; fxRate?: number | null };
          if (fx.currency && fx.currency !== "MYR") {
            const r = parseFloat(window.prompt(
              `${fx.currency} invoice — payment-day rate (MYR per 1 ${fx.currency}; booked at ${fx.fxRate ?? "?"}):`,
              String(fx.fxRate ?? ""),
            ) || "");
            if (!Number.isFinite(r) || r <= 0) return;
            updateStatus(row.id, "PAID", { payFxRate: r });
          } else {
            updateStatus(row.id, "PAID");
          }
        },
        // Mark Paid available from any active state (CONFIRMED, or legacy
        // APPROVED while the backend transitions over).
        disabled: !["CONFIRMED", "APPROVED"].includes(row.status),
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Refresh",
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        action: () => fetchData(),
      },
    ];
  }, [navigate, toast, fetchData, updateStatus, loadPiForPrint]);

  // ---- Bulk print ----
  // The one bulk action this page was missing: the row menu could already
  // print ONE invoice and generateCombinedPurchaseInvoicePdf ("PI list → bulk
  // Download PDF") was written for exactly this and never called. Same loader
  // as the single print, so the merged file is the single documents in order.
  // A row that fails to load is reported by number rather than silently
  // dropped — a short PDF that says nothing is the worst outcome here.
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const printSelected = useCallback(async () => {
    if (selectedRows.length === 0 || downloadingPdf) return;
    setDownloadingPdf(true);
    try {
      const { generateCombinedPurchaseInvoicePdf } = await import(
        "@/lib/generate-purchase-invoice-pdf"
      );
      type CombinedArg = Parameters<typeof generateCombinedPurchaseInvoicePdf>[0][number];
      const ok: CombinedArg[] = [];
      const failed: string[] = [];
      const loaded = await Promise.all(
        selectedRows.map(async (row) => {
          try {
            return { row, one: await loadPiForPrint(row.id) };
          } catch {
            return { row, one: null };
          }
        }),
      );
      for (const { row, one } of loaded) {
        if (one) ok.push({ pi: one.pi as unknown as CombinedArg["pi"], letterhead: one.letterhead });
        else failed.push(row.piNo);
      }
      if (ok.length === 0) {
        toast.error("Could not load any of the selected invoices to print.");
        return;
      }
      await generateCombinedPurchaseInvoicePdf(ok, `PurchaseInvoices-${ok.length}.pdf`);
      if (failed.length > 0) {
        toast.error(
          `Printed ${ok.length}; ${failed.length} could not be loaded (${failed.slice(0, 3).join(", ")}).`,
        );
      }
    } catch {
      toast.error("Could not generate the PDF.");
    } finally {
      setDownloadingPdf(false);
    }
  }, [selectedRows, downloadingPdf, loadPiForPrint, toast]);

  // Shell renders immediately — grid shows skeleton rows (loading prop) until
  // data lands. Mirrors the Sales Invoice list (no full-page loading gate).
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Purchase Invoices</h1>
          <p className="text-xs text-[#6B7280]">Track supplier invoices and payment status</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            onClick={runGlBackfill}
            disabled={postingGl}
            title="Post confirmed purchase invoices missing from the general ledger (one-time fix; safe to re-run — already-posted are skipped)"
          >
            <RefreshCw className={cn("h-4 w-4", postingGl && "animate-spin")} /> Post to GL
          </Button>
          <Button
            variant="outline"
            onClick={() => navigate("/procurement/pi/create?scan=1")}
          >
            <ScanLine className="h-4 w-4" /> Scan PI
          </Button>
          <Button
            variant="outline"
            onClick={() => setFromSourceOpen(true)}
            title="Import from a Purchase Order or Goods Receipt"
          >
            <FolderInput className="h-4 w-4" /> From PO / GRN
          </Button>
          <Button variant="primary" onClick={() => navigate("/procurement/pi/create")}>
            <Plus className="h-4 w-4" /> Create Invoice
          </Button>
        </div>
      </div>

      {/* KPI Cards — gold card style: p-4 flex items-center gap-3, colored icon-box left, text-2xl font-bold */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#F0ECE9] p-2.5 shrink-0">
              <FileText className="h-5 w-5 text-[#6B5C32]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#1F1D1B]">{totalPIs}</p>
              <p className="text-xs text-[#6B7280]">Total PIs</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FAEFCB] p-2.5 shrink-0">
              <Clock className="h-5 w-5 text-[#9C6F1E]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#9C6F1E]">{pendingPayment}</p>
              <p className="text-xs text-[#6B7280]">Pending Payment</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FDECEA] p-2.5 shrink-0">
              <AlertTriangle className="h-5 w-5 text-[#9A3A2D]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#9A3A2D]">{overdue}</p>
              <p className="text-xs text-[#6B7280]">Overdue</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#F0ECE9] p-2.5 shrink-0">
              <DollarSign className="h-5 w-5 text-[#6B5C32]" />
            </div>
            <div className="min-w-0">
              <p className="text-xl font-bold text-[#1F1D1B] truncate">{formatCurrency(totalValueSen)}</p>
              <p className="text-xs text-[#6B7280]">Total Value</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs — single tab bar matching Sales Invoice list skeleton */}
      <div className="flex gap-1 border-b border-[#E2DDD8]">
        <button
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "list"
              ? "border-[#6B5C32] text-[#6B5C32]"
              : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
          }`}
        >
          <List className="h-4 w-4" />
          Purchase Invoices
        </button>
      </div>

      {activeTab === "list" && (
        <>
          {/* Status Pipeline */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between overflow-x-auto gap-2">
                {statusCounts.map((s, i) => (
                  <div key={s.label} className="flex items-center gap-2">
                    <div
                      className="text-center min-w-[80px] cursor-pointer"
                      onClick={() => setFilterStatus(filterStatus === s.status ? "" : s.status)}
                    >
                      <Badge variant="status" status={s.status}>{s.count}</Badge>
                      <p className={`text-xs mt-1 ${filterStatus === s.status ? "text-[#6B5C32] font-medium" : "text-[#6B7280]"}`}>{s.label}</p>
                    </div>
                    {i < statusCounts.length - 1 && <ArrowRight className="h-4 w-4 text-[#D1CBC5] shrink-0" />}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Filters — always-visible, matching Sales Invoice list style */}
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">
                    Status
                  </label>
                  <select
                    className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                    value={filterStatus}
                    onChange={(e) => setFilterStatus(e.target.value)}
                  >
                    {ALL_PI_STATUSES.map(s => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">
                    Supplier
                  </label>
                  <select
                    className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                    value={filterSupplier}
                    onChange={(e) => setFilterSupplier(e.target.value)}
                  >
                    <option value="">All Suppliers</option>
                    {uniqueSuppliers.map(([id, name]) => (
                      <option key={id} value={id}>{name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">
                    From Date
                  </label>
                  <Input
                    type="date"
                    value={filterDateFrom}
                    onChange={(e) => setFilterDateFrom(e.target.value)}
                    className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">
                    To Date
                  </label>
                  <Input
                    type="date"
                    value={filterDateTo}
                    onChange={(e) => setFilterDateTo(e.target.value)}
                    className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
                  />
                </div>
                {hasActiveFilters && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[#6B7280]"
                    onClick={clearFilters}
                  >
                    <X className="h-3 w-3" />
                    Clear
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* PI DataGrid */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-[#6B5C32]" />
                  All Purchase Invoices
                  {hasActiveFilters && (
                    <span className="text-sm font-normal text-[#6B7280]">
                      ({filteredInvoices.length} of {invoices.length})
                    </span>
                  )}
                </CardTitle>
                <div className="flex flex-wrap items-center gap-2">
                  {/* Draft / Confirmed toggle — mirrors SO list shell. */}
                  <div className="inline-flex rounded-md border border-[#E2DDD8] bg-[#FAF9F7] p-0.5">
                    <button
                      onClick={() => { setTab("DRAFT"); setSelectedRows([]); }}
                      className={cn(
                        "px-4 py-1.5 text-sm rounded transition-colors",
                        tab === "DRAFT"
                          ? "bg-[#FAEFCB] text-[#9C6F1E] font-medium shadow-sm"
                          : "text-[#6B7280] hover:text-[#1F1D1B]"
                      )}
                    >
                      Draft ({draftCount})
                    </button>
                    <button
                      onClick={() => { setTab("CONFIRMED"); setSelectedRows([]); }}
                      className={cn(
                        "px-4 py-1.5 text-sm rounded transition-colors",
                        tab === "CONFIRMED"
                          ? "bg-[#E0EDF0] text-[#3E6570] font-medium shadow-sm"
                          : "text-[#6B7280] hover:text-[#1F1D1B]"
                      )}
                    >
                      Confirmed ({tabConfirmedCount})
                    </button>
                  </div>
                  <Button variant="outline" size="sm" onClick={exportCSV}>
                    <Download className="h-4 w-4" /> Export CSV
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <DataGrid<PurchaseInvoice>
                columns={piGridColumns}
                data={filteredInvoices}
                keyField="id"
                virtualize
                // Stable id — the column picker / drag / resize state persists
                // under it. Renaming it silently discards saved layouts.
                gridId="purchase-invoices-list"
                loading={loading}
                stickyHeader={true}
                selectable
                onSelectionChange={setSelectedRows}
                onDoubleClick={(row) => navigate(`/procurement/pi/${row.id}`)}
                contextMenuItems={piGridContextMenu}
                maxHeight="calc(100vh - 300px)"
                emptyMessage={tab === "DRAFT" ? "No draft invoices." : "No purchase invoices found."}
                // WYSIWYG export of the current columns over the current rows.
                // Listing only: GET /api/purchase-invoices maps rows through
                // rowToPI, which carries no `items[]` — the same reason the
                // row menu's "Print PI" re-fetches the invoice before printing.
                // A per-line listing here needs that re-fetch per row.
                exportName="purchase-invoices"
                exportSheetLabel="Purchase Invoices"
                clearSelectionToken={clearSelectionToken}
              />
            </CardContent>
          </Card>
        </>
      )}

      {/* Bulk actions — the shared BulkActionBar, replacing the page's own
          inline amber strip. It offers ONLY what this page can already do to
          one row: print (the row menu's "Print PI") and confirm a draft (the
          row menu's "Confirm"). Confirm appears only when the selection
          actually contains drafts, so it is never a button that would 409. */}
      <BulkActionBar
        selectedCount={selectedRows.length}
        onClear={() => {
          setSelectedRows([]);
          // Also untick the boxes — clearing only the page's mirror leaves the
          // grid's own selection intact and the checkboxes visibly still on.
          setClearSelectionToken((t) => t + 1);
        }}
        noun="invoice"
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/10"
              disabled={downloadingPdf}
              onClick={printSelected}
            >
              <Printer className="h-4 w-4" />
              {downloadingPdf ? "Preparing…" : `Print (${selectedRows.length})`}
            </Button>
            {selectedDraftCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-white hover:bg-white/10"
                disabled={bulkConverting}
                onClick={bulkConvertDrafts}
              >
                <CheckCircle2 className="h-4 w-4" />
                {bulkConverting ? "Converting…" : `Confirm ${selectedDraftCount} draft${selectedDraftCount === 1 ? "" : "s"}`}
              </Button>
            )}
          </>
        }
      />

      {/* From PO / GRN picker — navigates to PI create with pre-fill param */}
      <FromSourceModal
        open={fromSourceOpen}
        onClose={() => setFromSourceOpen(false)}
        onSelect={handleFromSource}
      />
    </div>
  );
}
