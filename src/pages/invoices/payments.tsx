import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, formatDateDMY, formatRM } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import {
  Plus,
  CreditCard,
  X,
} from "lucide-react";
import type { PaymentRecord, Invoice } from "@/lib/mock-data";

type CustomerOption = {
  id: string;
  name: string;
};

export default function PaymentsPage() {
  const { data: payResp, loading, refresh: refreshPayments } = useCachedJson<{ success?: boolean; data?: PaymentRecord[] }>("/api/payments");
  const payments: PaymentRecord[] = useMemo(
    () => (payResp?.success ? payResp.data ?? [] : Array.isArray(payResp) ? payResp : []),
    [payResp]
  );
  const [showCreateModal, setShowCreateModal] = useState(false);
  const { data: custResp, refresh: refreshCustomers } = useCachedJson<{ success?: boolean; data?: { id: string; name: string }[] }>(showCreateModal ? "/api/customers" : null);
  const { data: invResp, refresh: refreshInvoices } = useCachedJson<{ success?: boolean; data?: Invoice[] }>(showCreateModal ? "/api/invoices" : null);
  const customers: CustomerOption[] = useMemo(() => {
    const raw = custResp?.success ? custResp.data ?? [] : Array.isArray(custResp) ? (custResp as { id: string; name: string }[]) : [];
    return raw.map((c) => ({ id: c.id, name: c.name }));
  }, [custResp]);
  const invoices: Invoice[] = useMemo(
    () => (invResp?.success ? invResp.data ?? [] : Array.isArray(invResp) ? invResp : []),
    [invResp]
  );

  // Create form state
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [amount, setAmount] = useState<number>(0);
  const [method, setMethod] = useState<PaymentRecord["method"]>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [allocations, setAllocations] = useState<{ invoiceId: string; amount: number }[]>([]);
  const [creating, setCreating] = useState(false);

  const openCreate = () => {
    refreshCustomers();
    refreshInvoices();
    setShowCreateModal(true);
  };

  // Outstanding invoices for the selected customer
  const customerInvoices = invoices.filter(
    (inv) =>
      inv.customerId === selectedCustomerId &&
      inv.status !== "PAID" &&
      inv.status !== "CANCELLED"
  );

  const handleCustomerChange = (custId: string) => {
    setSelectedCustomerId(custId);
    setAllocations([]);
  };

  const toggleAllocation = (invId: string) => {
    const existing = allocations.find((a) => a.invoiceId === invId);
    if (existing) {
      setAllocations(allocations.filter((a) => a.invoiceId !== invId));
    } else {
      const inv = invoices.find((i) => i.id === invId);
      if (inv) {
        const remaining = inv.totalSen - inv.paidAmount;
        setAllocations([...allocations, { invoiceId: invId, amount: remaining }]);
      }
    }
  };

  const updateAllocationAmount = (invId: string, amt: number) => {
    setAllocations(
      allocations.map((a) => (a.invoiceId === invId ? { ...a, amount: amt } : a))
    );
  };

  const totalAllocated = allocations.reduce((sum, a) => sum + a.amount, 0);

  const handleCreate = async () => {
    if (!selectedCustomerId || amount <= 0) return;
    setCreating(true);
    const res = await fetch("/api/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerId: selectedCustomerId,
        amount,
        method,
        reference,
        allocations,
      }),
    });
    const data = await res.json();
    if (data.success) {
      setShowCreateModal(false);
      setSelectedCustomerId("");
      setAmount(0);
      setMethod("BANK_TRANSFER");
      setReference("");
      setAllocations([]);
      invalidateCachePrefix("/api/payments");
      invalidateCachePrefix("/api/invoices");
      refreshPayments();
    }
    setCreating(false);
  };

  const columns: Column<PaymentRecord>[] = [
    {
      key: "receiptNumber",
      label: "Receipt #",
      type: "docno",
      render: (_value, row) => (
        <span className="font-mono font-medium text-sm">{row.receiptNumber}</span>
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
      key: "amount",
      label: "Amount",
      type: "currency",
      align: "right",
      render: (_value, row) => (
        <span className="font-medium text-[#4F7C3A]">
          {formatRM(row.amount)}
        </span>
      ),
    },
    {
      key: "method",
      label: "Method",
      render: (_value, row) => (
        <Badge>{row.method.replace(/_/g, " ")}</Badge>
      ),
    },
    {
      key: "reference",
      label: "Reference",
      render: (_value, row) => (
        <span className="text-sm text-gray-600 font-mono">{row.reference || "-"}</span>
      ),
    },
    {
      key: "status",
      label: "Status",
      type: "status",
      render: (_value, row) => {
        const statusMap: Record<string, string> = {
          RECEIVED: "RECEIVED",
          CLEARED: "COMPLETED",
          BOUNCED: "FAIL",
        };
        return (
          <Badge variant="status" status={statusMap[row.status] || row.status}>
            {row.status}
          </Badge>
        );
      },
    },
    {
      key: "allocations",
      label: "Allocated",
      render: (_value, row) => {
        if (row.allocations.length === 0)
          return <span className="text-sm text-gray-400">Unallocated</span>;
        return (
          <span className="text-sm text-gray-600">
            {row.allocations.length} invoice{row.allocations.length > 1 ? "s" : ""}
          </span>
        );
      },
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
      action: (_row) => refreshPayments(),
    },
  ];

  // Summary stats
  const totalReceived = payments.reduce((s, p) => s + p.amount, 0);
  const clearedCount = payments.filter((p) => p.status === "CLEARED").length;
  const pendingCount = payments.filter((p) => p.status === "RECEIVED").length;
  const bouncedCount = payments.filter((p) => p.status === "BOUNCED").length;

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
          <h1 className="text-xl font-bold text-gray-900">Payment Tracking</h1>
          <p className="text-sm text-gray-500 mt-1">
            Record and track customer payments with invoice allocation
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" /> Record Payment
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Total Received</p>
                <p className="text-2xl font-bold text-[#4F7C3A]">{formatCurrency(totalReceived)}</p>
              </div>
              <CreditCard className="h-8 w-8 text-[#4F7C3A]" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div>
              <p className="text-sm text-gray-500">Cleared</p>
              <p className="text-2xl font-bold">{clearedCount}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div>
              <p className="text-sm text-gray-500">Pending</p>
              <p className="text-2xl font-bold text-[#9C6F1E]">{pendingCount}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div>
              <p className="text-sm text-gray-500">Bounced</p>
              <p className="text-2xl font-bold text-[#9A3A2D]">{bouncedCount}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Data Grid */}
      <Card>
        <CardHeader>
          <CardTitle>All Payments</CardTitle>
        </CardHeader>
        <CardContent>
          <DataGrid
            columns={columns}
            data={payments}
            keyField="id"
            gridId="payments"
            contextMenuItems={contextMenuItems}
          />
        </CardContent>
      </Card>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b">
              <h2 className="text-lg font-semibold">Record Payment</h2>
              <button onClick={() => setShowCreateModal(false)}>
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              {/* Customer Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Customer</label>
                <select
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={selectedCustomerId}
                  onChange={(e) => handleCustomerChange(e.target.value)}
                >
                  <option value="">Select customer...</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-3 gap-4">
                {/* Amount */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount (sen)</label>
                  <input
                    type="number"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                    value={amount || ""}
                    onChange={(e) => setAmount(parseInt(e.target.value) || 0)}
                    placeholder="e.g. 100000 = RM1,000"
                  />
                  {amount > 0 && (
                    <p className="text-xs text-gray-500 mt-1">= {formatCurrency(amount)}</p>
                  )}
                </div>

                {/* Method */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
                  <select
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                    value={method}
                    onChange={(e) => setMethod(e.target.value as PaymentRecord["method"])}
                  >
                    <option value="BANK_TRANSFER">Bank Transfer</option>
                    <option value="CHEQUE">Cheque</option>
                    <option value="CASH">Cash</option>
                    <option value="CREDIT_CARD">Credit Card</option>
                  </select>
                </div>

                {/* Reference */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Reference</label>
                  <input
                    type="text"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="Cheque #, Transfer ref..."
                  />
                </div>
              </div>

              {/* Invoice Allocation */}
              {selectedCustomerId && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Allocate to Invoices
                  </label>
                  {customerInvoices.length === 0 ? (
                    <p className="text-sm text-gray-400 italic">No outstanding invoices for this customer</p>
                  ) : (
                    <div className="border rounded-md overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="text-left px-3 py-2 font-medium text-gray-600">Select</th>
                            <th className="text-left px-3 py-2 font-medium text-gray-600">Invoice #</th>
                            <th className="text-right px-3 py-2 font-medium text-gray-600">Invoice Amount</th>
                            <th className="text-right px-3 py-2 font-medium text-gray-600">Previously Paid</th>
                            <th className="text-right px-3 py-2 font-medium text-gray-600">This Payment</th>
                            <th className="text-right px-3 py-2 font-medium text-gray-600">Remaining</th>
                          </tr>
                        </thead>
                        <tbody>
                          {customerInvoices.map((inv) => {
                            const alloc = allocations.find((a) => a.invoiceId === inv.id);
                            const remaining = inv.totalSen - inv.paidAmount - (alloc?.amount || 0);
                            return (
                              <tr key={inv.id} className="border-t hover:bg-gray-50">
                                <td className="px-3 py-2">
                                  <input
                                    type="checkbox"
                                    checked={!!alloc}
                                    onChange={() => toggleAllocation(inv.id)}
                                    className="rounded border-gray-300"
                                  />
                                </td>
                                <td className="px-3 py-2 font-mono">{inv.invoiceNo}</td>
                                <td className="px-3 py-2 text-right">{formatCurrency(inv.totalSen)}</td>
                                <td className="px-3 py-2 text-right text-gray-500">{formatCurrency(inv.paidAmount)}</td>
                                <td className="px-3 py-2 text-right">
                                  {alloc ? (
                                    <input
                                      type="number"
                                      className="w-28 border border-gray-300 rounded px-2 py-1 text-sm text-right"
                                      value={alloc.amount}
                                      onChange={(e) =>
                                        updateAllocationAmount(inv.id, parseInt(e.target.value) || 0)
                                      }
                                    />
                                  ) : (
                                    <span className="text-gray-400">-</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right">
                                  <span className={remaining < 0 ? "text-[#9A3A2D]" : "text-gray-600"}>
                                    {formatCurrency(Math.max(0, remaining))}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      <div className="px-3 py-2 bg-gray-50 border-t text-sm font-medium flex justify-between">
                        <span>Total Allocated:</span>
                        <span className={totalAllocated > amount ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}>
                          {formatCurrency(totalAllocated)}
                          {amount > 0 && totalAllocated !== amount && (
                            <span className="text-gray-400 ml-2">
                              (Unallocated: {formatCurrency(amount - totalAllocated)})
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 p-6 border-t">
              <Button variant="ghost" onClick={() => setShowCreateModal(false)}>Cancel</Button>
              <Button
                onClick={handleCreate}
                disabled={creating || !selectedCustomerId || amount <= 0}
              >
                {creating ? "Recording..." : "Record Payment"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
