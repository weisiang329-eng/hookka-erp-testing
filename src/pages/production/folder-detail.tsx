// Production Folder detail page.
//
// Shows every job card archived in the folder, in the SAME column layout as
// the Production dept page (so the operator opens a folder and sees an
// instantly-familiar view — just narrowed to the folder's contents). Two
// columns are always visible: dept code (since folders can span depts) +
// the same dept / status / PIC / dates the Production page shows.
//
// Operator actions:
//   - Multi-select + Apply Date / Apply PIC (reuses BatchActionToolbar)
//   - Remove from Folder (pops a JC out of this folder, doesn't touch the JC)
//   - Delete the whole folder
import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Trash2, ArrowLeft, Printer } from "lucide-react";
import { DataGrid } from "@/components/ui/data-grid";
import type { Column } from "@/components/ui/data-grid";
import { readCsrfCookie, CSRF_HEADER_NAME } from "@/lib/csrf";
import {
  BatchActionToolbar,
  ApplyBatchDateDialog,
  ApplyBatchPicDialog,
} from "./components/BatchActionToolbar";

function csrfHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const csrf = readCsrfCookie();
  if (csrf) h[CSRF_HEADER_NAME] = csrf;
  return h;
}

// The SupabaseAdapter auto-camelCases snake_case columns on read, so
// created_at / created_by from the DB come back as createdAt / createdBy
// in the JSON payload. Surfaced by a crash on the folder detail page —
// Date(undefined).toISOString() threw RangeError.
type FolderData = {
  id: string;
  name: string;
  description: string | null;
  createdBy: string | null;
  createdAt: string;
  jobCardIds: string[];
};

type FolderJcRow = {
  id: string;                  // job_card_id
  poId: string;
  jobCardId: string;
  poNo: string | null;
  // Sales Order number (e.g. "SO-2605-148") — surfaced as its own column so
  // operators can scan the folder by SO at a glance. Falls back to the CO
  // number for consignment-driven POs. Requested by Wei Siang 2026-05-12.
  salesOrderNo: string | null;
  salesOrderId: string | null;
  productCode: string | null;
  productName: string | null;
  customerName: string | null;
  departmentCode: string | null;
  status: string | null;
  dueDate: string | null;
  completedDate: string | null;
  pic1Name: string | null;
  qty: number;
};

type Worker = { id: string; name: string; departmentCode: string | null; departmentCodes?: string[] | null };

export default function ProductionFolderDetailPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const params = useParams<{ id: string }>();
  const folderId = params.id ?? "";
  const [folder, setFolder] = useState<FolderData | null>(null);
  const [rows, setRows] = useState<FolderJcRow[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<FolderJcRow[]>([]);
  const [dateOpen, setDateOpen] = useState(false);
  const [picOpen, setPicOpen] = useState(false);

  const fetchAll = async () => {
    if (!folderId) return;
    setLoading(true);
    try {
      // 1. Folder metadata + member JC ids.
      const fRes = await fetch(`/api/production-folders/${encodeURIComponent(folderId)}`, { credentials: "include" });
      if (!fRes.ok) throw new Error(`folder fetch HTTP ${fRes.status}`);
      const fJson = (await fRes.json()) as { success: boolean; data: FolderData };
      if (!fJson.success) throw new Error("folder fetch failed");
      setFolder(fJson.data);
      const memberSet = new Set(fJson.data.jobCardIds);

      // 2. Pull production-orders matrix (minimal payload) and pick out the
      //    JCs whose id is in this folder. Could be optimised with a
      //    dedicated /folder-rows endpoint later, but this reuses the
      //    matrix's KV cache so it's fast.
      const poRes = await fetch("/api/production-orders?fields=minimal&include=jobCards", { credentials: "include" });
      const poJson = (await poRes.json()) as {
        success: boolean;
        data: Array<{
          id: string;
          poNo?: string;
          salesOrderId?: string;
          companySOId?: string;
          companyCOId?: string;
          productCode?: string;
          productName?: string;
          customerName?: string;
          jobCards?: Array<{
            id: string;
            departmentCode?: string;
            status?: string;
            dueDate?: string;
            completedDate?: string;
            pic1Name?: string;
            wipQty?: number;
          }>;
        }>;
      };
      const collected: FolderJcRow[] = [];
      for (const po of poJson.data || []) {
        for (const jc of po.jobCards || []) {
          if (!memberSet.has(jc.id)) continue;
          // Prefer the SO number; fall back to CO number for consignment POs
          // (companySOId is null on CO-driven production orders).
          const soNo = po.companySOId ?? po.companyCOId ?? "";
          collected.push({
            id: jc.id,
            poId: po.id,
            jobCardId: jc.id,
            poNo: po.poNo ?? "",
            salesOrderNo: soNo,
            salesOrderId: po.salesOrderId ?? null,
            productCode: po.productCode ?? "",
            productName: po.productName ?? "",
            customerName: po.customerName ?? "",
            departmentCode: jc.departmentCode ?? "",
            status: jc.status ?? "",
            dueDate: jc.dueDate ?? null,
            completedDate: jc.completedDate ?? null,
            pic1Name: jc.pic1Name ?? "",
            qty: jc.wipQty ?? 0,
          });
        }
      }
      setRows(collected);

      // 3. Workers list for the Apply PIC dialog.
      const wRes = await fetch("/api/workers", { credentials: "include" });
      const wJson = (await wRes.json()) as { success?: boolean; data?: Worker[] };
      setWorkers(wJson.data || []);
    } catch (err) {
      toast.error(`Load failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setLoading(false);
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetchAll cascades setState through loading + folder + rows, but only inside .then handlers, never synchronously
    void fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchAll closes over folderId already
  }, [folderId]);

  const handleDeleteFolder = async () => {
    if (!folder) return;
    if (!confirm(`Delete folder "${folder.name}"?\n\nThis only removes the folder. The ${rows.length} job card${rows.length === 1 ? "" : "s"} inside stay untouched.`)) return;
    try {
      const res = await fetch(`/api/production-folders/${encodeURIComponent(folder.id)}`, {
        method: "DELETE",
        headers: csrfHeaders(),
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(`Deleted "${folder.name}".`);
      navigate("/production/folders");
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRemoveFromFolder = async () => {
    if (selected.length === 0) return;
    if (!confirm(`Remove ${selected.length} job card${selected.length === 1 ? "" : "s"} from this folder?\n\nThe job card${selected.length === 1 ? "" : "s"} stay in production — only the folder reference is removed.`)) return;
    try {
      const res = await fetch(`/api/production-folders/${encodeURIComponent(folderId)}/remove-jcs`, {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify({ jobCardIds: selected.map((r) => r.jobCardId) }),
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const removed = selected.length;
      const removedSet = new Set(selected.map((r) => r.jobCardId));
      setRows((prev) => prev.filter((r) => !removedSet.has(r.jobCardId)));
      setSelected([]);
      toast.success(`Removed ${removed} from folder.`);
    } catch (err) {
      toast.error(`Remove failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const columns: Column<FolderJcRow>[] = [
    // SO# is sticky so it stays visible while operator scrolls horizontally.
    // Clicking the cell navigates to the SO detail page.
    { key: "salesOrderNo", label: "SO #", width: "120px", render: (_v, r) => r.salesOrderNo ? (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); if (r.salesOrderId) navigate(`/sales/${r.salesOrderId}`); }}
        className="text-[#3F6F8B] hover:underline"
      >{r.salesOrderNo}</button>
    ) : "" },
    { key: "poNo", label: "PO #", width: "110px" },
    { key: "customerName", label: "Customer", width: "160px" },
    { key: "productCode", label: "Product", width: "160px" },
    { key: "departmentCode", label: "Dept", width: "90px" },
    { key: "status", label: "Status", width: "110px" },
    { key: "qty", label: "Qty", width: "60px" },
    { key: "dueDate", label: "Due", width: "95px", render: (_v, r) => r.dueDate ?? "" },
    { key: "completedDate", label: "Completed", width: "95px", render: (_v, r) => r.completedDate ?? "" },
    { key: "pic1Name", label: "PIC", width: "120px" },
  ];

  // Safe date formatter — `created_at` was previously stringly-typed and an
  // invalid value (or undefined from a snake/camel typo) crashed the entire
  // page with `Date.toISOString` throwing RangeError. Caught + ignored here.
  const fmtDate = (iso: string | null | undefined): string => {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      return d.toISOString().slice(0, 10);
    } catch {
      return "";
    }
  };

  // ---------------------------------------------------------------------
  // Print Schedule — opens a new window with an A4-landscape paper layout
  // mirroring the on-screen folder columns, then auto-fires window.print().
  // Mirrors the existing handlePrintSchedule on the Production page so the
  // operator sees a familiar layout. Folder name + created-by + today's
  // date land in the header so the printed sheet is self-describing when
  // handed to the floor.
  // ---------------------------------------------------------------------
  const handlePrintSchedule = (): void => {
    if (rows.length === 0) {
      toast.error("Folder is empty — nothing to print.");
      return;
    }
    const today = new Date().toLocaleDateString("en-MY", {
      year: "numeric", month: "short", day: "numeric",
    });
    const fmt = (iso: string | null | undefined): string => {
      if (!iso) return "";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      return `${d.getDate()} ${d.toLocaleString("en-US", { month: "short" })}`;
    };
    const escape = (s: string | null | undefined): string => {
      if (!s) return "";
      return String(s).replace(/[&<>"']/g, (c) =>
        c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
      );
    };
    const folderName = folder?.name ?? "Folder";
    const createdLine = [
      folder?.createdBy ? `Created by ${folder.createdBy}` : "",
      folder?.createdAt ? fmtDate(folder.createdAt) : "",
    ].filter(Boolean).join(" · ");

    const rowsHtml = rows.map((r) => `
      <tr>
        <td>${escape(r.salesOrderNo)}</td>
        <td>${escape(r.poNo)}</td>
        <td>${escape(r.customerName)}</td>
        <td><b>${escape(r.productCode)}</b></td>
        <td>${escape(r.departmentCode)}</td>
        <td class="status ${(r.status || '').toLowerCase()}">${escape(r.status)}</td>
        <td class="num">${r.qty || ""}</td>
        <td>${fmt(r.dueDate)}</td>
        <td>${fmt(r.completedDate)}</td>
        <td>${escape(r.pic1Name)}</td>
      </tr>
    `).join("");

    const html = `<!doctype html><html><head>
      <meta charset="utf-8" />
      <title>${escape(folderName)} — Production Schedule</title>
      <style>
        @page { size: A4 landscape; margin: 10mm; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1F1D1B; font-size: 10pt; }
        .header { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 8px; border-bottom: 2px solid #1F1D1B; padding-bottom: 4px; }
        .header h1 { margin: 0; font-size: 14pt; }
        .header .meta { font-size: 9pt; color: #6B5E50; }
        table { width: 100%; border-collapse: collapse; font-size: 9pt; }
        th, td { border: 1px solid #C9BFB1; padding: 4px 6px; text-align: left; vertical-align: top; }
        th { background: #F0E6D2; font-weight: 600; }
        .num { text-align: right; }
        .status.completed { background: #DCEFD8; }
        .status.in_progress { background: #FFF3CC; }
        .status.waiting { color: #6B5E50; }
        tr { page-break-inside: avoid; }
        .signoff { margin-top: 16px; font-size: 9pt; display: flex; gap: 40px; }
        .signoff div { flex: 1; border-top: 1px solid #1F1D1B; padding-top: 4px; }
        @media print { .noprint { display: none; } }
      </style>
    </head><body>
      <div class="header">
        <div>
          <h1>${escape(folderName)}</h1>
          <div class="meta">${escape(createdLine)} · Printed ${today}</div>
        </div>
        <div class="meta">${rows.length} job card${rows.length === 1 ? "" : "s"}</div>
      </div>
      <table>
        <thead>
          <tr>
            <th>SO #</th>
            <th>PO #</th>
            <th>Customer</th>
            <th>Product</th>
            <th>Dept</th>
            <th>Status</th>
            <th class="num">Qty</th>
            <th>Due</th>
            <th>Completed</th>
            <th>PIC</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="signoff">
        <div>Supervisor signature & date</div>
        <div>Floor lead signature & date</div>
      </div>
    </body></html>`;

    const w = window.open("", "_blank", "width=1200,height=800");
    if (!w) {
      toast.error("Print window blocked by browser. Allow pop-ups and try again.");
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    // Defer print() so the new window's DOM finishes laying out fonts/borders
    // before the print dialog opens. 250ms is plenty on any modern desktop.
    w.setTimeout(() => {
      w.focus();
      w.print();
    }, 250);
  };

  if (!folderId) {
    return (
      <div className="p-4">
        <div className="text-[12px] text-red-600">Folder id missing in URL.</div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-7xl mx-auto">
      <div className="mb-3 flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => navigate("/production/folders")} title="Back to folders">
          <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold text-[#3A2E22] truncate">
            {folder?.name ?? (loading ? "Loading…" : "Folder")}
          </h1>
          <div className="text-[11px] text-[#8A7F73]">
            {rows.length} job card{rows.length === 1 ? "" : "s"}
            {folder?.createdBy ? ` · Created by ${folder.createdBy}` : ""}
            {folder?.createdAt ? ` · ${fmtDate(folder.createdAt)}` : ""}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={fetchAll}>Refresh</Button>
        <Button size="sm" variant="outline" onClick={handlePrintSchedule} title="Print this folder as a paper schedule">
          <Printer className="h-3.5 w-3.5 mr-1" /> Print Schedule
        </Button>
        <Button size="sm" variant="outline" onClick={handleDeleteFolder} title="Delete this folder">
          <Trash2 className="h-3.5 w-3.5 mr-1 text-red-600" /> Delete Folder
        </Button>
      </div>

      <div className="rounded-lg border border-[#E6E0D9] bg-white overflow-visible">
        <DataGrid<FolderJcRow>
          columns={columns}
          data={rows}
          keyField="id"
          stickyHeader
          maxHeight="calc(100vh - 250px)"
          emptyMessage={loading ? "Loading folder…" : "This folder is empty."}
          gridId={`production-folder-${folderId}`}
          selectable
          onSelectionChange={(sel) => setSelected(sel)}
          virtualize
        />
      </div>

      <BatchActionToolbar
        count={selected.length}
        onClear={() => setSelected([])}
        onApplyDate={() => setDateOpen(true)}
        onApplyPic={() => setPicOpen(true)}
        onSaveToFolder={() => toast.error("Already inside a folder. Use Apply Date / PIC, or Remove from Folder.")}
        onRemoveFromFolder={handleRemoveFromFolder}
      />

      <ApplyBatchDateDialog
        open={dateOpen}
        count={selected.length}
        onCancel={() => setDateOpen(false)}
        onApply={async (date) => {
          setDateOpen(false);
          const patches = selected.map((r) => ({
            poId: r.poId,
            jobCardId: r.jobCardId,
            completedDate: date,
            status: date ? "COMPLETED" : "WAITING",
          }));
          try {
            const res = await fetch("/api/production-orders/bulk-patch", {
              method: "POST",
              headers: csrfHeaders(),
              body: JSON.stringify({ patches }),
              credentials: "include",
            });
            const j = (await res.json()) as { results?: Array<{ success: boolean; error?: string }> };
            const failed = (j.results || []).filter((x) => !x.success);
            if (failed.length > 0) toast.error(`${failed.length} of ${patches.length} failed: ${failed[0].error ?? "unknown"}`);
            else toast.success(`Stamped on ${patches.length}.`);
            setSelected([]);
            await fetchAll();
          } catch (err) {
            toast.error(`Batch save failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      />
      <ApplyBatchPicDialog
        open={picOpen}
        count={selected.length}
        // Wei Siang 2026-05-13 (corrected): default = smart filter by union
        // of the SELECTED JCs' depts (same UX as inline cell dropdowns +
        // production page batch dialog). The dialog's "All departments"
        // toggle widens to the full roster.
        workers={(() => {
          const selectedDepts = new Set(
            selected.map((r) => (r.departmentCode || "").toUpperCase()).filter(Boolean),
          );
          const sorted = workers
            .slice()
            .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
          if (selectedDepts.size === 0) {
            return sorted.map((w) => ({ id: w.id, name: w.name }));
          }
          const filtered = sorted.filter((w) => {
            const codes =
              Array.isArray(w.departmentCodes) && w.departmentCodes.length > 0
                ? w.departmentCodes
                : w.departmentCode
                  ? [w.departmentCode]
                  : [];
            return codes.some((c) => selectedDepts.has((c || "").toUpperCase()));
          });
          return (filtered.length > 0 ? filtered : sorted).map((w) => ({ id: w.id, name: w.name }));
        })()}
        // Full roster behind the dialog's "All departments" toggle.
        allWorkers={workers
          .slice()
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
          .map((w) => ({ id: w.id, name: w.name }))}
        onCancel={() => setPicOpen(false)}
        onApply={async ({ pic1, pic2 }) => {
          setPicOpen(false);
          const patches = selected.map((r) => {
            const p: Record<string, unknown> = { poId: r.poId, jobCardId: r.jobCardId };
            if (pic1 !== undefined) p.pic1Id = pic1?.id ?? null;
            if (pic2 !== undefined) p.pic2Id = pic2?.id ?? null;
            return p;
          });
          try {
            const res = await fetch("/api/production-orders/bulk-patch", {
              method: "POST",
              headers: csrfHeaders(),
              body: JSON.stringify({ patches }),
              credentials: "include",
            });
            const j = (await res.json()) as { results?: Array<{ success: boolean; error?: string }> };
            const failed = (j.results || []).filter((x) => !x.success);
            const slots = [pic1 !== undefined ? "PIC 1" : null, pic2 !== undefined ? "PIC 2" : null].filter(Boolean).join(" + ");
            if (failed.length > 0) toast.error(`${failed.length} of ${patches.length} failed: ${failed[0].error ?? "unknown"}`);
            else toast.success(`Set ${slots} on ${patches.length} job card${patches.length === 1 ? "" : "s"}.`);
            setSelected([]);
            await fetchAll();
          } catch (err) {
            toast.error(`Batch save failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      />
    </div>
  );
}
