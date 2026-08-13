import { useState, useMemo, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, formatDateDMY, formatRM } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Plus,
  FileX,
  X,
  Trash2,
} from "lucide-react";
import type { CreditNote, Invoice } from "@/types";
import { fetchJson } from "@/lib/fetch-json";
import { mutationWithData } from "@/lib/schemas/common";
import { CreditNoteSchema } from "@/lib/schemas/invoice";
import { COMPANY } from "@/lib/constants";
import { amountInWords } from "@/lib/amount-in-words";
import { printVouchers, type VoucherSpec, type VoucherLine } from "@/lib/print-voucher";
import { BatchActionsBar } from "@/components/accounting/batch-actions-bar";
import { parseMoneyInput } from "@/lib/parse-money";

const CNMutationSchema = mutationWithData(CreditNoteSchema);

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

// One credit note → a CREDIT NOTE voucher: one line per credited item
// (Description · Qty · Unit Price · Amount), total = the note's totalAmount.
// Money stays integer sen (unitPrice / total / totalAmount are all sen),
// formatted with formatCurrency. Mirrors buildSupplierPaymentVoucher's shape.
// CreditNote has no lifecycle/void state (status is DRAFT/APPROVED/POSTED), so
// the defensive (lifecycleState ?? "ACTIVE") check always yields the live title.
function buildCreditNoteVoucher(cn: CreditNote): VoucherSpec {
  const active = ((cn as { lifecycleState?: string }).lifecycleState ?? "ACTIVE") === "ACTIVE";
  const lines: VoucherLine[] = cn.items.map((item) => ({
    cells: [
      item.description ?? "",
      String(item.quantity ?? ""),
      formatCurrency(item.unitPriceSen ?? item.unitPrice ?? 0),
      formatCurrency(item.totalSen ?? item.total ?? 0),
    ],
  }));
  const remarks = [cn.reason, cn.reasonDetail].filter(Boolean).join(" — ") || undefined;
  return {
    title: active ? "CREDIT NOTE" : "CREDIT NOTE — VOID",
    company: VOUCHER_COMPANY,
    docNo: cn.noteNumber,
    date: formatDateDMY(cn.date),
    partyLabel: "Customer",
    partyName: cn.customerName ?? "",
    columns: [
      { label: "Description" },
      { label: "Qty", align: "right" },
      { label: "Unit Price", align: "right" },
      { label: "Amount", align: "right" },
    ],
    lines,
    totalCells: ["", "", "Total", formatCurrency(cn.totalAmount)],
    footerNote: `Against Invoice: ${cn.invoiceNumber || "—"}`,
    remarks,
    amountWords: amountInWords(cn.totalAmount),
    signatures: [{ label: "Issued by" }, { label: "Approved by" }],
    printedOn: formatDateDMY(new Date()),
  };
}

export default function CreditNotesPage() {
  const { data: cnResp, loading, refresh: refreshCreditNotes } = useCachedJson<{ success?: boolean; data?: CreditNote[] }>("/api/credit-notes");
  const creditNotes: CreditNote[] = useMemo(
    () => (cnResp?.success ? cnResp.data ?? [] : Array.isArray(cnResp) ? cnResp : []),
    [cnResp]
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
  const cnCustomers = useMemo(() => {
    const m = new Map<string, string>();
    for (const inv of invoices) if (inv.customerId) m.set(inv.customerId, inv.customerName);
    return [...m].map(([id, name]) => ({ value: id, label: name })).sort((a, b) => a.label.localeCompare(b.label));
  }, [invoices]);
  const cnInvoices = useMemo(
    () => invoices.filter((inv) => inv.customerId === selectedCustomerId && inv.status !== "PAID" && inv.status !== "CANCELLED"),
    [invoices, selectedCustomerId],
  );
  const [reason, setReason] = useState<CreditNote["reason"]>("RETURN");
  const [reasonDetail, setReasonDetail] = useState("");
  // Editor rows carry a client-only `_uid` so React keys stay stable across
  // add / remove / reorder. The uid is stripped before POST in handleCreate().
  // PR 0 (2026-05-20) — field renamed from `unitPrice` to `unitPriceSen` so
  // the unit is explicit at the contract surface. Value is integer sen
  // (RM × 100), matching the backend after the rename in credit-notes.ts.
  // priceStr keeps the raw text being typed so the controlled input never
  // reformats mid-entry (owner bug 2026-06-12); unitPriceSen derives from it.
  type CreditNoteItemRow = { _uid: string; description: string; quantity: number; unitPriceSen: number; priceStr?: string };
  const newCNItem = (): CreditNoteItemRow => ({
    _uid: crypto.randomUUID(),
    description: "",
    quantity: 1,
    unitPriceSen: 0,
  });
  const [items, setItems] = useState<CreditNoteItemRow[]>([newCNItem()]);
  const [creating, setCreating] = useState(false);

  // Pure return → land here PRE-FILLED (owner 2026-07-15): open the New CN modal
  // with reason=RETURN, one line per returned item, and (best-effort) the
  // customer + the DO's invoice pre-selected, so the operator only confirms the
  // refund amount instead of starting from a blank list.
  const [searchParams, setSearchParams] = useSearchParams();
  const fromReturn = searchParams.get("fromReturn") || "";
  // customer + invoice captured from the DR; applied to the selects once the
  // invoices list has loaded (it loads lazily when the modal opens).
  const pendingPrefill = useRef<{ customerId: string; invoiceNo: string } | null>(null);
  const prefillRan = useRef(false);

  useEffect(() => {
    if (!fromReturn || prefillRan.current) return;
    prefillRan.current = true;
    void (async () => {
      try {
        const drRes = await fetch(
          `/api/delivery-returns/${encodeURIComponent(fromReturn)}`,
        );
        const drJson = (await drRes.json()) as {
          data?: {
            returnNo?: string;
            customerId?: string;
            deliveryOrderId?: string;
            items?: Array<{ productCode?: string; productName?: string; quantity?: number }>;
          };
        };
        const dr = drJson?.data;
        if (!dr) return;
        setReason("RETURN");
        setReasonDetail(`Delivery Return ${dr.returnNo ?? ""}`.trim());
        setItems(
          (dr.items ?? []).map((it) => ({
            _uid: crypto.randomUUID(),
            description: [it.productCode, it.productName].filter(Boolean).join(" "),
            quantity: Number(it.quantity ?? 1),
            unitPriceSen: 0,
          })),
        );
        let invoiceNo = "";
        if (dr.deliveryOrderId) {
          try {
            const doRes = await fetch(
              `/api/delivery-orders/${encodeURIComponent(dr.deliveryOrderId)}`,
            );
            const doJson = (await doRes.json()) as { data?: { invoiceNo?: string } };
            invoiceNo = doJson?.data?.invoiceNo ?? "";
          } catch {
            /* best-effort — operator can pick the invoice manually */
          }
        }
        pendingPrefill.current = { customerId: dr.customerId ?? "", invoiceNo };
        setShowCreateModal(true);
      } catch {
        /* best-effort */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot, ref-guarded
  }, [fromReturn]);

  // Once the invoices list is loaded, apply the pending customer + invoice.
  useEffect(() => {
    const p = pendingPrefill.current;
    if (!p || invoices.length === 0) return;
    if (p.customerId) setSelectedCustomerId(p.customerId);
    if (p.invoiceNo) {
      const inv = invoices.find((i) => {
        const r = i as { invoiceNo?: string; invoiceNumber?: string };
        return r.invoiceNo === p.invoiceNo || r.invoiceNumber === p.invoiceNo;
      });
      if (inv) setSelectedInvoiceId(inv.id);
    }
    pendingPrefill.current = null;
    if (fromReturn) setSearchParams({});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apply once invoices arrive
  }, [invoices]);

  // Ticked rows for the batch actions bar (print vouchers + Excel/CSV export).
  const [selectedCreditNotes, setSelectedCreditNotes] = useState<CreditNote[]>([]);

  const openCreate = () => {
    refreshInvoices();
    setShowCreateModal(true);
  };

  const addItem = () => {
    setItems([...items, newCNItem()]);
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
      // PR 0 (2026-05-20) — send `unitPriceSen` (matches backend rename).
      const payloadItems = items
        .filter((i) => i.description && i.unitPriceSen > 0)
        .map((i) => ({ description: i.description, quantity: i.quantity, unitPriceSen: i.unitPriceSen }));
      const data = await fetchJson("/api/credit-notes", CNMutationSchema, {
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
        setReason("RETURN");
        setReasonDetail("");
        setItems([newCNItem()]);
        invalidateCachePrefix("/api/credit-notes");
        invalidateCachePrefix("/api/invoices");
        refreshCreditNotes();
      }
    } catch {
      // ignore
    }
    setCreating(false);
  };

  const columns: Column<CreditNote>[] = [
    {
      key: "noteNumber",
      label: "CN Number",
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
        <span className="font-medium text-[#9A3A2D]">
          -{formatRM(row.totalAmount)}
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
          const { generateCreditNotePdf } = await import("@/lib/generate-credit-note-pdf");
          generateCreditNotePdf(row);
        } catch {
          /* generator handles its own draw; nothing to surface here */
        }
      },
    },
    {
      label: "Refresh",
      action: (_row) => refreshCreditNotes(),
    },
  ];

  // Summary stats
  const totalCNValue = creditNotes.reduce((s, cn) => s + cn.totalAmount, 0);
  const draftCount = creditNotes.filter((cn) => cn.status === "DRAFT").length;
  const postedCount = creditNotes.filter((cn) => cn.status === "POSTED").length;

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
          <h1 className="text-xl font-bold text-gray-900">Credit Notes</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage credit notes for returns, price adjustments, and damages
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" /> New Credit Note
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm text-gray-500">Total CN Value</p>
                <p className="text-xl font-bold text-[#9A3A2D] truncate">-{formatCurrency(totalCNValue)}</p>
              </div>
              <FileX className="h-8 w-8 text-[#9A3A2D] shrink-0" />
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
          <CardTitle>All Credit Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <BatchActionsBar
            count={selectedCreditNotes.length}
            onPrint={() => printVouchers(selectedCreditNotes.map(buildCreditNoteVoucher))}
            exportName="credit-notes"
            exportAoa={() => [
              ["Note No", "Date", "Customer", "Status", "Invoice No", "Reason", "Voucher Total (RM)", "Description", "Qty", "Unit Price (RM)", "Amount (RM)"],
              ...selectedCreditNotes.flatMap((cn) =>
                cn.items.map((item) => [
                  cn.noteNumber,
                  formatDateDMY(cn.date),
                  cn.customerName ?? "",
                  cn.status ?? "ACTIVE",
                  cn.invoiceNumber ?? "",
                  cn.reason ?? "",
                  (Number(cn.totalAmount ?? 0) / 100).toFixed(2),
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
            data={creditNotes}
            keyField="id"
            virtualize
            gridId="credit-notes"
            selectable
            onSelectionChange={setSelectedCreditNotes}
            contextMenuItems={contextMenuItems}
          />
        </CardContent>
      </Card>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b">
              <h2 className="text-lg font-semibold">Create Credit Note</h2>
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
                  options={cnCustomers}
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
                    {selectedCustomerId ? (cnInvoices.length ? "Select invoice..." : "No unsettled invoices") : "Select a customer first"}
                  </option>
                  {cnInvoices.map((inv) => (
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
                  onChange={(e) => setReason(e.target.value as CreditNote["reason"])}
                >
                  <option value="RETURN">Return</option>
                  <option value="PRICE_ADJUSTMENT">Price Adjustment</option>
                  <option value="DAMAGE">Damage</option>
                  <option value="OVERCHARGE">Overcharge</option>
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
                        // Owner bug 2026-06-12: this was a controlled input
                        // re-formatted with toFixed(2) on EVERY keystroke, so
                        // typing "127" got mangled mid-entry. Keep the raw
                        // text the user types; derive sen from it on change.
                        value={item.priceStr ?? (item.unitPriceSen ? (item.unitPriceSen / 100).toFixed(2) : "")}
                        onChange={(e) => {
                          const txt = e.target.value;
                          // `type="number"` - the browser refuses a comma before
                          // this runs, so this was never the truncation bug.
                          // Converted so the guard survives an input-type change.
                          const rm = parseMoneyInput(txt);
                          const sen = rm !== null && rm >= 0 ? Math.round(rm * 100) : 0;
                          setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, priceStr: txt, unitPriceSen: sen } : it)));
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
                  Total: <span className="text-[#9A3A2D]">-{formatCurrency(totalAmount)}</span>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 p-6 border-t">
              <Button variant="ghost" onClick={() => setShowCreateModal(false)}>Cancel</Button>
              <Button
                onClick={handleCreate}
                disabled={creating || !selectedInvoiceId || items.every((i) => !i.description)}
              >
                {creating ? "Creating..." : "Create Credit Note"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
