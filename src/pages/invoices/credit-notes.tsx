import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, formatDateDMY, formatRM } from "@/lib/utils";
import {
  Plus,
  FileX,
  X,
  Trash2,
} from "lucide-react";
import type { CreditNote, Invoice } from "@/lib/mock-data";

export default function CreditNotesPage() {
  const [creditNotes, setCreditNotes] = useState<CreditNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState("");
  const [reason, setReason] = useState<CreditNote["reason"]>("RETURN");
  const [reasonDetail, setReasonDetail] = useState("");
  const [items, setItems] = useState<{ description: string; quantity: number; unitPrice: number }[]>([
    { description: "", quantity: 1, unitPrice: 0 },
  ]);
  const [creating, setCreating] = useState(false);

  const fetchCreditNotes = useCallback(() => {
    fetch("/api/credit-notes")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setCreditNotes(d.data);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchCreditNotes();
  }, [fetchCreditNotes]);

  const openCreate = () => {
    fetch("/api/invoices")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setInvoices(d.data);
        setShowCreateModal(true);
      });
  };

  const addItem = () => {
    setItems([...items, { description: "", quantity: 1, unitPrice: 0 }]);
  };

  const removeItem = (idx: number) => {
    setItems(items.filter((_, i) => i !== idx));
  };

  const updateItem = (idx: number, field: string, value: string | number) => {
    const updated = [...items];
    updated[idx] = { ...updated[idx], [field]: value };
    setItems(updated);
  };

  const totalAmount = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

  const handleCreate = async () => {
    if (!selectedInvoiceId || items.length === 0) return;
    setCreating(true);
    const res = await fetch("/api/credit-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invoiceId: selectedInvoiceId,
        reason,
        reasonDetail,
        items: items.filter((i) => i.description && i.unitPrice > 0),
      }),
    });
    const data = await res.json();
    if (data.success) {
      setShowCreateModal(false);
      setSelectedInvoiceId("");
      setReason("RETURN");
      setReasonDetail("");
      setItems([{ description: "", quantity: 1, unitPrice: 0 }]);
      fetchCreditNotes();
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
      label: "View",
      action: (_row) => {},
    },
    {
      label: "Print",
      action: (_row) => {},
    },
    {
      label: "Refresh",
      action: (_row) => fetchCreditNotes(),
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
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Credit Notes</h1>
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
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Total CN Value</p>
                <p className="text-2xl font-bold text-[#9A3A2D]">-{formatCurrency(totalCNValue)}</p>
              </div>
              <FileX className="h-8 w-8 text-[#9A3A2D]" />
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
          <DataGrid
            columns={columns}
            data={creditNotes}
            keyField="id"
            gridId="credit-notes"
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
              {/* Invoice Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Invoice</label>
                <select
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={selectedInvoiceId}
                  onChange={(e) => setSelectedInvoiceId(e.target.value)}
                >
                  <option value="">Select invoice...</option>
                  {invoices.map((inv) => (
                    <option key={inv.id} value={inv.id}>
                      {inv.invoiceNo} - {inv.customerName} ({formatCurrency(inv.totalSen)})
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
                    <div key={idx} className="flex gap-2 items-start">
                      <input
                        className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm"
                        placeholder="Description"
                        value={item.description}
                        onChange={(e) => updateItem(idx, "description", e.target.value)}
                      />
                      <input
                        className="w-20 border border-gray-300 rounded-md px-3 py-2 text-sm"
                        type="number"
                        min="1"
                        placeholder="Qty"
                        value={item.quantity}
                        onChange={(e) => updateItem(idx, "quantity", parseInt(e.target.value) || 1)}
                      />
                      <input
                        className="w-32 border border-gray-300 rounded-md px-3 py-2 text-sm"
                        type="number"
                        min="0"
                        placeholder="Unit Price (sen)"
                        value={item.unitPrice || ""}
                        onChange={(e) => updateItem(idx, "unitPrice", parseInt(e.target.value) || 0)}
                      />
                      <span className="text-sm text-gray-500 py-2 w-28 text-right">
                        {formatCurrency(item.quantity * item.unitPrice)}
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
