import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, formatDateDMY, formatRM } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Plus,
  FileText,
  X,
  Trash2,
} from "lucide-react";
import type { DebitNote, Invoice } from "@/types";
import { fetchJson } from "@/lib/fetch-json";
import { mutationWithData } from "@/lib/schemas/common";
import { DebitNoteSchema } from "@/lib/schemas/invoice";
import { COMPANY } from "@/lib/constants";
import { amountInWords } from "@/lib/amount-in-words";
import { printVouchers, type VoucherSpec, type VoucherLine } from "@/lib/print-voucher";
import { BatchActionsBar } from "@/components/accounting/batch-actions-bar";

const DNMutationSchema = mutationWithData(DebitNoteSchema);

// COMPANY.HOOKKA → the VoucherSpec.company shape (single source of truth);
// mirrors VOUCHER_COMPANY in supplier-payments.tsx / accounting/index.tsx.
const VOUCHER_COMPANY: VoucherSpec["company"] = {
  name: COMPANY.HOOKKA.name,
  addressLines: COMPANY.HOOKKA.addressLines,
  regNo: COMPANY.HOOKKA.regNo,
  tin: COMPANY.HOOKKA.tin,
  phone: COMPANY.HOOKKA.phone,
  email: COMPANY.HOOKKA.email,
};

// One debit note → a DEBIT NOTE voucher: one line per charged item
// (Description · Qty · Unit Price · Amount), total = the note's totalAmount.
// Money stays integer sen (unitPrice / total / totalAmount are all sen),
// formatted with formatCurrency. Mirrors buildSupplierPaymentVoucher's shape.
// DebitNote has no lifecycle/void state (status is DRAFT/APPROVED/POSTED), so
// the defensive (lifecycleState ?? "ACTIVE") check always yields the live title.
function buildDebitNoteVoucher(dn: DebitNote): VoucherSpec {
  const active = ((dn as { lifecycleState?: string }).lifecycleState ?? "ACTIVE") === "ACTIVE";
  const lines: VoucherLine[] = dn.items.map((item) => ({
    cells: [
      item.description ?? "",
      String(item.quantity ?? ""),
      formatCurrency(item.unitPriceSen ?? item.unitPrice ?? 0),
      formatCurrency(item.totalSen ?? item.total ?? 0),
    ],
  }));
  const remarks = [dn.reason, dn.reasonDetail].filter(Boolean).join(" — ") || undefined;
  return {
    title: active ? "DEBIT NOTE" : "DEBIT NOTE — VOID",
    company: VOUCHER_COMPANY,
    docNo: dn.noteNumber,
    date: formatDateDMY(dn.date),
    partyLabel: "Customer",
    partyName: dn.customerName ?? "",
    columns: [
      { label: "Description" },
      { label: "Qty", align: "right" },
      { label: "Unit Price", align: "right" },
      { label: "Amount", align: "right" },
    ],
    lines,
    totalCells: ["", "", "Total", formatCurrency(dn.totalAmount)],
    footerNote: `Against Invoice: ${dn.invoiceNumber || "—"}`,
    remarks,
    amountWords: amountInWords(dn.totalAmount),
    signatures: [{ label: "Issued by" }, { label: "Approved by" }],
    printedOn: formatDateDMY(new Date()),
  };
}

export default function DebitNotesPage() {
  const { data: dnResp, loading, refresh: refreshDebitNotes } = useCachedJson<{ success?: boolean; data?: DebitNote[] }>("/api/debit-notes");
  const debitNotes: DebitNote[] = useMemo(
    () => (dnResp?.success ? dnResp.data ?? [] : Array.isArray(dnResp) ? dnResp : []),
    [dnResp]
  );
  const [showCreateModal, setShowCreateModal] = useState(false);
  const { data: invResp, refresh: refreshInvoices } = useCachedJson<{ success?: boolean; data?: Invoice[] }>(showCreateModal ? "/api/invoices" : null);
  const invoices: Invoice[] = useMemo(
    () => (invResp?.success ? invResp.data ?? [] : Array.isArray(invResp) ? invResp : []),
    [invResp]
  );
  const [selectedInvoiceId, setSelectedInvoiceId] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  // #5: pick the customer first, then list only their not-yet-settled invoices.
  const dnCustomers = useMemo(() => {
    const m = new Map<string, string>();
    for (const inv of invoices) if (inv.customerId) m.set(inv.customerId, inv.customerName);
    return [...m].map(([id, name]) => ({ value: id, label: name })).sort((a, b) => a.label.localeCompare(b.label));
  }, [invoices]);
  const dnInvoices = useMemo(
    () => invoices.filter((inv) => inv.customerId === selectedCustomerId && inv.status !== "PAID" && inv.status !== "CANCELLED"),
    [invoices, selectedCustomerId],
  );
  const [reason, setReason] = useState<DebitNote["reason"]>("UNDERCHARGE");
  const [reasonDetail, setReasonDetail] = useState("");
  // Editor rows carry a client-only `_uid` so React keys stay stable across
  // add / remove / reorder. The uid is stripped before POST in handleCreate().
  // priceStr keeps the raw text being typed so the controlled input never
  // reformats mid-entry (owner bug 2026-06-12); unitPriceSen derives from it.
  type DebitNoteItemRow = { _uid: string; description: string; quantity: number; unitPriceSen: number; priceStr?: string };
  const newDNItem = (): DebitNoteItemRow => ({
    _uid: crypto.randomUUID(),
    description: "",
    quantity: 1,
    unitPriceSen: 0,
  });
  const [items, setItems] = useState<DebitNoteItemRow[]>([newDNItem()]);
  const [creating, setCreating] = useState(false);

  // Ticked-row selection for batch print voucher + Excel/CSV export. The list
  // uses the shared DataGrid, which owns its own checkbox column (selectable)
  // and reports the picked rows via onSelectionChange — mirror that into state
  // so the BatchActionsBar can act on the selection (twin of payments.tsx).
  const [selected, setSelected] = useState<DebitNote[]>([]);

  const openCreate = () => {
    refreshInvoices();
    setShowCreateModal(true);
  };

  const addItem = () => {
    setItems([...items, newDNItem()]);
  };

  const removeItem = (idx: number) => {
    setItems(items.filter((_, i) => i !== idx));
  };

  const updateItem = (idx: number, field: string, value: string | number) => {
    const updated = [...items];
    updated[idx] = { ...updated[idx], [field]: value };
    setItems(updated);
  };

  const totalAmount = items.reduce((sum, item) => sum + item.quantity * item.unitPriceSen, 0);

  const handleCreate = async () => {
    if (!selectedInvoiceId || items.length === 0) return;
    setCreating(true);
    try {
      // Strip the client-only `_uid` before POST.
      const payloadItems = items
        .filter((i) => i.description && i.unitPriceSen > 0)
        .map((i) => ({ description: i.description, quantity: i.quantity, unitPriceSen: i.unitPriceSen }));
      const data = await fetchJson("/api/debit-notes", DNMutationSchema, {
        method: "POST",
        body: {
          invoiceId: selectedInvoiceId,
          reason,
          reasonDetail,
          items: payloadItems,
        },
      });
      if (data.success) {
        setShowCreateModal(false);
        setSelectedInvoiceId("");
        setReason("UNDERCHARGE");
        setReasonDetail("");
        setItems([newDNItem()]);
        invalidateCachePrefix("/api/debit-notes");
        invalidateCachePrefix("/api/invoices");
        refreshDebitNotes();
      }
    } catch {
      // ignore
    }
    setCreating(false);
  };

  const columns: Column<DebitNote>[] = [
    {
      key: "noteNumber",
      label: "DN Number",
      type: "docno",
      render: (_value, row) => (
        <span className="font-mono font-medium text-sm">{row.noteNumber}</span>
      ),
    },
    {
      key: "invoiceNumber",
      label: "Invoice",
      render: (_value, row) => (
        <span className="text-sm text-gray-600">{row.invoiceNumber}</span>
      ),
    },
    {
      key: "customerName",
      label: "Customer",
    },
    {
      key: "date",
      label: "Date",
      type: "date",
      render: (_value, row) => formatDateDMY(row.date),
    },
    {
      key: "totalAmount",
      label: "Amount",
      type: "currency",
      align: "right",
      render: (_value, row) => (
        <span className="font-medium text-[#3E6570]">
          +{formatRM(row.totalAmount)}
        </span>
      ),
    },
    {
      key: "reason",
      label: "Reason",
      render: (_value, row) => (
        <Badge>{row.reason.replace(/_/g, " ")}</Badge>
      ),
    },
    {
      key: "status",
      label: "Status",
      type: "status",
      render: (_value, row) => (
        <Badge variant="status" status={row.status}>
          {row.status}
        </Badge>
      ),
    },
  ];

  const contextMenuItems: ContextMenuItem[] = [
    {
      label: "Print PDF",
      action: async (row) => {
        try {
          const { generateDebitNotePdf } = await import("@/lib/generate-debit-note-pdf");
          generateDebitNotePdf(row);
        } catch {
          /* generator draws/saves itself */
        }
      },
    },
    {
      label: "Refresh",
      action: (_row) => refreshDebitNotes(),
    },
  ];

  // Summary stats
  const totalDNValue = debitNotes.reduce((s, dn) => s + dn.totalAmount, 0);
  const draftCount = debitNotes.filter((dn) => dn.status === "DRAFT").length;
  const postedCount = debitNotes.filter((dn) => dn.status === "POSTED").length;

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-md:p-4 max-sm:p-3 max-md:space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Debit Notes</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage debit notes for undercharges and additional charges
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" /> New Debit Note
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm text-gray-500">Total DN Value</p>
                <p className="text-xl font-bold text-[#3E6570] truncate">+{formatCurrency(totalDNValue)}</p>
              </div>
              <FileText className="h-8 w-8 text-[#3E6570] shrink-0" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Draft</p>
                <p className="text-2xl font-bold">{draftCount}</p>
              </div>
              <Badge variant="status" status="DRAFT">DRAFT</Badge>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Posted</p>
                <p className="text-2xl font-bold">{postedCount}</p>
              </div>
              <Badge variant="status" status="POSTED">POSTED</Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Data Grid */}
      <Card>
        <CardHeader>
          <CardTitle>All Debit Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <BatchActionsBar
            count={selected.length}
            onPrint={() => printVouchers(selected.map(buildDebitNoteVoucher))}
            exportName="debit-notes"
            exportAoa={() => [
              ["Note No", "Date", "Customer", "Status", "Invoice No", "Reason", "Voucher Total (RM)", "Description", "Qty", "Unit Price (RM)", "Amount (RM)"],
              ...selected.flatMap((dn) =>
                dn.items.map((item) => [
                  dn.noteNumber,
                  formatDateDMY(dn.date),
                  dn.customerName ?? "",
                  dn.status ?? "ACTIVE",
                  dn.invoiceNumber ?? "",
                  dn.reason ?? "",
                  (Number(dn.totalAmount ?? 0) / 100).toFixed(2),
                  item.description ?? "",
                  String(item.quantity ?? ""),
                  (Number(item.unitPriceSen ?? item.unitPrice ?? 0) / 100).toFixed(2),
                  (Number(item.totalSen ?? item.total ?? 0) / 100).toFixed(2),
                ]),
              ),
            ]}
          />
          <DataGrid
            columns={columns}
            data={debitNotes}
            keyField="id"
            virtualize
            gridId="debit-notes"
            selectable
            onSelectionChange={setSelected}
            contextMenuItems={contextMenuItems}
          />
        </CardContent>
      </Card>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b">
              <h2 className="text-lg font-semibold">Create Debit Note</h2>
              <button onClick={() => setShowCreateModal(false)}>
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              {/* #5: Customer first → only their not-yet-settled invoices. */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Customer</label>
                <SearchableSelect
                  value={selectedCustomerId}
                  onChange={(v) => { setSelectedCustomerId(v); setSelectedInvoiceId(""); }}
                  options={dnCustomers}
                  placeholder="Type customer name..."
                  allowClear
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Invoice <span className="font-normal text-gray-400">(unsettled only)</span>
                </label>
                <select
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm disabled:bg-gray-100"
                  value={selectedInvoiceId}
                  onChange={(e) => setSelectedInvoiceId(e.target.value)}
                  disabled={!selectedCustomerId}
                >
                  <option value="">
                    {selectedCustomerId ? (dnInvoices.length ? "Select invoice..." : "No unsettled invoices") : "Select a customer first"}
                  </option>
                  {dnInvoices.map((inv) => (
                    <option key={inv.id} value={inv.id}>
                      {inv.invoiceNo} ({formatCurrency(inv.totalSen)})
                    </option>
                  ))}
                </select>
              </div>

              {/* Reason */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reason</label>
                <select
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={reason}
                  onChange={(e) => setReason(e.target.value as DebitNote["reason"])}
                >
                  <option value="UNDERCHARGE">Undercharge</option>
                  <option value="ADDITIONAL_CHARGE">Additional Charge</option>
                  <option value="PRICE_ADJUSTMENT">Price Adjustment</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>

              {/* Reason Detail */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Detail</label>
                <textarea
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  rows={2}
                  value={reasonDetail}
                  onChange={(e) => setReasonDetail(e.target.value)}
                  placeholder="Describe the reason..."
                />
              </div>

              {/* Items */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">Items</label>
                  <Button variant="ghost" size="sm" onClick={addItem}>
                    <Plus className="h-4 w-4 mr-1" /> Add Item
                  </Button>
                </div>
                <div className="space-y-2">
                  {items.map((item, idx) => (
                    <div key={item._uid} className="flex gap-2 items-start">
                      <input
                        className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm"
                        placeholder="Description"
                        value={item.description}
                        onChange={(e) => updateItem(idx, "description", e.target.value)}
                      />
                      <input
                        className="w-20 border border-gray-300 rounded-md px-3 py-2 text-sm"
                        type="number" onFocus={(e) => e.currentTarget.select()}
                        min="1"
                        placeholder="Qty"
                        value={item.quantity}
                        onChange={(e) => updateItem(idx, "quantity", parseInt(e.target.value) || 1)}
                      />
                      <input
                        className="w-32 border border-gray-300 rounded-md px-3 py-2 text-sm"
                        type="number" onFocus={(e) => e.currentTarget.select()}
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        placeholder="Unit Price (RM)"
                        value={item.unitPriceSen ? (item.unitPriceSen / 100).toFixed(2) : ""}
                        onChange={(e) => {
                          const rm = parseFloat(e.target.value);
                          const sen = Number.isFinite(rm) && rm >= 0 ? Math.round(rm * 100) : 0;
                          updateItem(idx, "unitPriceSen", sen);
                        }}
                      />
                      <span className="text-sm text-gray-500 py-2 w-28 text-right">
                        {formatCurrency(item.quantity * item.unitPriceSen)}
                      </span>
                      {items.length > 1 && (
                        <button onClick={() => removeItem(idx)} className="p-2 text-[#9A3A2D] hover:text-[#7A2E24]">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-3 text-right font-medium text-sm">
                  Total: <span className="text-[#3E6570]">+{formatCurrency(totalAmount)}</span>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 p-6 border-t">
              <Button variant="ghost" onClick={() => setShowCreateModal(false)}>Cancel</Button>
              <Button
                onClick={handleCreate}
                disabled={creating || !selectedInvoiceId || items.every((i) => !i.description)}
              >
                {creating ? "Creating..." : "Create Debit Note"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
