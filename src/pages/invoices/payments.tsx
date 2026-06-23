import { useState, useMemo, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, formatDateDMY, formatRM } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { defaultBankCode } from "@/lib/default-bank";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { CreditCard } from "lucide-react";
import type { PaymentRecord, Invoice } from "@/types";
import { fetchJson } from "@/lib/fetch-json";
import { mutationWithData } from "@/lib/schemas/common";
import { PaymentSchema } from "@/lib/schemas/invoice";

const PaymentMutationSchema = mutationWithData(PaymentSchema);

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
  const { data: custResp } = useCachedJson<{ success?: boolean; data?: { id: string; name: string }[] }>("/api/customers");
  const { data: invResp, refresh: refreshInvoices } = useCachedJson<{ success?: boolean; data?: Invoice[] }>("/api/invoices");
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
  const [method, setMethod] = useState<PaymentRecord["method"]>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  // Owner: the receipt deposits into a SPECIFIC bank/cash account, not a
  // method-derived default. Options = SBK/SCH accounts from the COA.
  const [bankAccount, setBankAccount] = useState("");
  const [bankOptions, setBankOptions] = useState<{ code: string; name: string }[]>([]);
  const [allocations, setAllocations] = useState<{ invoiceId: string; amount: number }[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetch("/api/accounting/coa")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { code: string; name: string; specialAccountType?: string }[] }>)
      .then((j) => {
        if (!j?.success) return;
        const opts = (j.data ?? [])
          .filter((a) => a.specialAccountType === "SBK" || a.specialAccountType === "SCH")
          .map((a) => ({ code: a.code, name: a.name }));
        setBankOptions(opts);
        // Default the deposit account to Hong Leong Bank (owner preference);
        // shared helper matches HLBB/HLB, falls back to the first bank/cash.
        setBankAccount((prev) => prev || defaultBankCode(opts));
      })
      .catch(() => {});
  }, []);

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

  // Supplier-payment-style upsert: typing an amount creates the allocation if
  // it isn't there yet; clearing it (0) drops the invoice from the receipt.
  const setAllocAmount = (invId: string, sen: number) => {
    setAllocations((prev) => {
      const others = prev.filter((a) => a.invoiceId !== invId);
      return sen > 0 ? [...others, { invoiceId: invId, amount: sen }] : others;
    });
  };

  const totalAllocated = allocations.reduce((sum, a) => sum + a.amount, 0);

  const handleCreate = async () => {
    if (!selectedCustomerId || totalAllocated <= 0) return;
    setCreating(true);
    try {
      // Sprint 3 #4 — idempotency. Payment is the highest-risk POST
      // in the app; a retry under network blip would double-collect.
      const data = await fetchJson("/api/payments", PaymentMutationSchema, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: {
          customerId: selectedCustomerId,
          amount: totalAllocated,
          method,
          reference,
          bankAccount,
          allocations,
        },
      });
      if (data.success) {
        setSelectedCustomerId("");
        setMethod("BANK_TRANSFER");
        setReference("");
        setAllocations([]);
        invalidateCachePrefix("/api/payments");
        invalidateCachePrefix("/api/invoices");
        refreshPayments();
        refreshInvoices();
      }
    } catch {
      // ignore
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
    // (Removed dead no-op "View"/"Print" — no payment detail page or payment
    // PDF exists, so they did nothing when clicked.)
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
    <div className="p-6 space-y-6 max-md:p-4 max-sm:p-3 max-md:space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Payment Tracking</h1>
          <p className="text-sm text-gray-500 mt-1">
            Record and track customer payments with invoice allocation
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm text-gray-500">Total Received</p>
                <p className="text-xl font-bold text-[#4F7C3A] truncate">{formatCurrency(totalReceived)}</p>
              </div>
              <CreditCard className="h-8 w-8 text-[#4F7C3A] shrink-0" />
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

      {/* Record Payment — inline (unified with Supplier Payment) */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Record Payment</CardTitle>
            <Button onClick={handleCreate} disabled={creating || !selectedCustomerId || totalAllocated <= 0} size="sm">
              {creating ? "Recording..." : "Record Payment"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
              {/* Customer Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Customer</label>
                <SearchableSelect
                  value={selectedCustomerId}
                  onChange={handleCustomerChange}
                  options={customers.map((c) => ({ value: c.id, label: c.name }))}
                  placeholder="Type customer name..."
                  allowClear
                />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-sm:grid-cols-1">
                {/* Deposit To — the actual bank/cash account the money lands
                    in (drives the GL bank leg; Method stays as metadata). */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Deposit To</label>
                  <select
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                    value={bankAccount}
                    onChange={(e) => setBankAccount(e.target.value)}
                  >
                    {bankOptions.length === 0 && <option value="">— bank/cash —</option>}
                    {bankOptions.map((a) => (
                      <option key={a.code} value={a.code}>{a.code} {a.name}</option>
                    ))}
                  </select>
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

                {/* Knock-off total — kept at the top beside Reference (matches
                    the supplier-payment layout). */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Total (RM)</label>
                  <div className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-right tabular-nums font-bold text-[#4F7C3A]">
                    {formatCurrency(totalAllocated)}
                  </div>
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
                    <div className="border rounded-md overflow-hidden overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="text-left px-3 py-2 font-medium text-gray-600">Invoice #</th>
                            <th className="text-right px-3 py-2 font-medium text-gray-600">Invoice Amount</th>
                            <th className="text-right px-3 py-2 font-medium text-gray-600">Previously Paid</th>
                            <th className="text-right px-3 py-2 font-medium text-gray-600">Outstanding</th>
                            <th className="text-right px-3 py-2 font-medium text-gray-600">This Payment</th>
                            <th className="text-center px-3 py-2 font-medium text-gray-600">Full</th>
                          </tr>
                        </thead>
                        <tbody>
                          {customerInvoices.map((inv) => {
                            const alloc = allocations.find((a) => a.invoiceId === inv.id);
                            const outstanding = inv.totalSen - inv.paidAmount;
                            const isFull = !!alloc && alloc.amount === outstanding;
                            return (
                              <tr key={inv.id} className="border-t hover:bg-gray-50">
                                <td className="px-3 py-2 font-mono">{inv.invoiceNo}</td>
                                <td className="px-3 py-2 text-right">{formatCurrency(inv.totalSen)}</td>
                                <td className="px-3 py-2 text-right text-gray-500">{formatCurrency(inv.paidAmount)}</td>
                                <td className="px-3 py-2 text-right font-medium">{formatCurrency(outstanding)}</td>
                                <td className="px-3 py-2 text-right">
                                  <input
                                    type="number" onFocus={(e) => e.currentTarget.select()}
                                    step="0.01"
                                    inputMode="decimal"
                                    min="0"
                                    className="w-28 border border-gray-300 rounded px-2 py-1 text-sm text-right tabular-nums"
                                    value={alloc && alloc.amount ? (alloc.amount / 100).toFixed(2) : ""}
                                    placeholder="0.00"
                                    onChange={(e) => {
                                      const rm = parseFloat(e.target.value);
                                      const sen = Number.isFinite(rm) && rm >= 0 ? Math.round(rm * 100) : 0;
                                      setAllocAmount(inv.id, sen);
                                    }}
                                  />
                                </td>
                                <td className="px-3 py-2 text-center">
                                  <input
                                    type="checkbox"
                                    checked={isFull}
                                    onChange={(e) => setAllocAmount(inv.id, e.target.checked ? outstanding : 0)}
                                    className="rounded border-gray-300"
                                  />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
        </CardContent>
      </Card>

      {/* All Payments */}
      <Card>
        <CardHeader>
          <CardTitle>All Payments</CardTitle>
        </CardHeader>
        <CardContent>
          <DataGrid
            columns={columns}
            data={payments}
            keyField="id"
            virtualize
            gridId="payments"
            contextMenuItems={contextMenuItems}
          />
        </CardContent>
      </Card>
    </div>
  );
}
