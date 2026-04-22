import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";

const CUSTOMER_ID = "cust-2";

type Payment = {
  id: string;
  date: string;
  amountSen: number;
  method: string;
  reference: string;
};

type InvoiceData = {
  id: string;
  invoiceNo: string;
  companySOId: string;
  doNo: string;
  invoiceDate: string;
  dueDate: string;
  totalSen: number;
  paidAmount: number;
  status: string;
  payments: Payment[];
};

type CustomerData = {
  id: string;
  code: string;
  name: string;
  state: string;
  creditTerms: string;
  creditLimitSen: number;
  outstandingSen: number;
  availableCreditSen: number;
};

export default function PortalAccountPage() {
  const [customer, setCustomer] = useState<CustomerData | null>(null);
  const [invoices, setInvoices] = useState<InvoiceData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchAccount() {
      try {
        const res = await fetch(`/api/portal/account?customerId=${CUSTOMER_ID}`);
        const data = await res.json();
        if (data.success) {
          setCustomer(data.data.customer);
          setInvoices(data.data.invoices);
        }
      } catch {
        // silently ignore
      } finally {
        setLoading(false);
      }
    }
    fetchAccount();
  }, []);

  const getDaysOverdue = (dueDate: string, status: string) => {
    if (status === "PAID" || status === "CANCELLED") return 0;
    const today = new Date();
    const due = new Date(dueDate);
    const diff = Math.floor((today.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
    return diff > 0 ? diff : 0;
  };

  // Collect all payments across invoices for payment history
  const allPayments = invoices
    .flatMap((inv) =>
      inv.payments.map((p) => ({
        ...p,
        invoiceNo: inv.invoiceNo,
      }))
    )
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading account data...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#1F1D1B]">Account</h1>
        <p className="text-gray-500 mt-1">View your invoices, payments, and account standing.</p>
      </div>

      {/* Account Summary */}
      {customer && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-6">
              <div className="text-sm text-gray-500">Total Outstanding</div>
              <div className="text-2xl font-bold text-[#1F1D1B] mt-1">
                {formatCurrency(customer.outstandingSen)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="text-sm text-gray-500">Credit Limit</div>
              <div className="text-2xl font-bold text-[#1F1D1B] mt-1">
                {formatCurrency(customer.creditLimitSen)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="text-sm text-gray-500">Available Credit</div>
              <div className="text-2xl font-bold text-[#4F7C3A] mt-1">
                {formatCurrency(customer.availableCreditSen)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="text-sm text-gray-500">Payment Terms</div>
              <div className="text-2xl font-bold text-[#1F1D1B] mt-1">{customer.creditTerms}</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Outstanding Invoices */}
      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-gray-500 text-sm">No invoices found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Invoice #</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">SO / DO</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Date</th>
                    <th className="text-right py-3 px-2 font-medium text-gray-500">Amount</th>
                    <th className="text-right py-3 px-2 font-medium text-gray-500">Paid</th>
                    <th className="text-right py-3 px-2 font-medium text-gray-500">Balance</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Due Date</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Status</th>
                    <th className="text-right py-3 px-2 font-medium text-gray-500">Days Overdue</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => {
                    const daysOverdue = getDaysOverdue(inv.dueDate, inv.status);
                    const balance = inv.totalSen - inv.paidAmount;
                    return (
                      <tr key={inv.id} className="border-b border-[#E2DDD8] last:border-0">
                        <td className="py-3 px-2 font-medium text-[#1F1D1B]">{inv.invoiceNo}</td>
                        <td className="py-3 px-2 text-gray-600">
                          <div>{inv.companySOId}</div>
                          <div className="text-xs text-gray-400">{inv.doNo}</div>
                        </td>
                        <td className="py-3 px-2 text-gray-600">{formatDate(inv.invoiceDate)}</td>
                        <td className="py-3 px-2 text-right">{formatCurrency(inv.totalSen)}</td>
                        <td className="py-3 px-2 text-right text-[#4F7C3A]">
                          {inv.paidAmount > 0 ? formatCurrency(inv.paidAmount) : "-"}
                        </td>
                        <td className="py-3 px-2 text-right font-medium">
                          {balance > 0 ? formatCurrency(balance) : "-"}
                        </td>
                        <td className="py-3 px-2 text-gray-600">{formatDate(inv.dueDate)}</td>
                        <td className="py-3 px-2">
                          <Badge variant="status" status={inv.status} />
                        </td>
                        <td className="py-3 px-2 text-right">
                          {daysOverdue > 0 ? (
                            <span className="text-[#9A3A2D] font-medium">{daysOverdue} days</span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Payment History */}
      <Card>
        <CardHeader>
          <CardTitle>Payment History</CardTitle>
        </CardHeader>
        <CardContent>
          {allPayments.length === 0 ? (
            <p className="text-gray-500 text-sm">No payment records found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Date</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Invoice</th>
                    <th className="text-right py-3 px-2 font-medium text-gray-500">Amount</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Method</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {allPayments.map((p) => (
                    <tr key={p.id} className="border-b border-[#E2DDD8] last:border-0">
                      <td className="py-3 px-2 text-gray-600">{formatDate(p.date)}</td>
                      <td className="py-3 px-2 font-medium text-[#1F1D1B]">{p.invoiceNo}</td>
                      <td className="py-3 px-2 text-right text-[#4F7C3A] font-medium">
                        {formatCurrency(p.amountSen)}
                      </td>
                      <td className="py-3 px-2 text-gray-600">
                        {p.method.replace(/_/g, " ")}
                      </td>
                      <td className="py-3 px-2 text-gray-500 text-xs">{p.reference}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
