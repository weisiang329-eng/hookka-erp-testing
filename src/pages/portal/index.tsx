import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";

const CUSTOMER_ID = "cust-2";

type OrderData = {
  id: string;
  companySOId: string;
  companySODate: string;
  status: string;
  totalSen: number;
  items: { productName: string; quantity: number }[];
  overallProgress: number;
};

type DeliveryData = {
  id: string;
  doNo: string;
  deliveryDate: string;
  status: string;
  totalItems: number;
  items: { productName: string; quantity: number }[];
};

type InvoiceData = {
  id: string;
  invoiceNo: string;
  totalSen: number;
  paidAmount: number;
  status: string;
  dueDate: string;
};

export default function PortalDashboard() {
  const [orders, setOrders] = useState<OrderData[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryData[]>([]);
  const [invoices, setInvoices] = useState<InvoiceData[]>([]);
  const [outstandingSen, setOutstandingSen] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [ordersRes, deliveriesRes, accountRes] = await Promise.all([
          fetch(`/api/portal/orders?customerId=${CUSTOMER_ID}`),
          fetch(`/api/portal/deliveries?customerId=${CUSTOMER_ID}`),
          fetch(`/api/portal/account?customerId=${CUSTOMER_ID}`),
        ]);

        const ordersData = await ordersRes.json();
        const deliveriesData = await deliveriesRes.json();
        const accountData = await accountRes.json();

        if (ordersData.success) setOrders(ordersData.data);
        if (deliveriesData.success) setDeliveries(deliveriesData.data);
        if (accountData.success) {
          setInvoices(accountData.data.invoices);
          setOutstandingSen(accountData.data.customer.outstandingSen);
        }
      } catch {
        // silently ignore
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  const activeOrders = orders.filter(
    (o) => !["DELIVERED", "CLOSED", "CANCELLED"].includes(o.status)
  );
  const pendingDeliveries = deliveries.filter(
    (d) => !["DELIVERED", "CANCELLED"].includes(d.status)
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading portal data...</div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Welcome */}
      <div>
        <h1 className="text-xl font-bold text-[#1F1D1B]">Welcome, HOUZS KL</h1>
        <p className="text-gray-500 mt-1">
          View your orders, deliveries, and account status below.
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-6">
            <div className="text-sm text-gray-500">Active Orders</div>
            <div className="text-3xl font-bold text-[#1F1D1B] mt-1">{activeOrders.length}</div>
            <div className="text-xs text-gray-400 mt-1">of {orders.length} total orders</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-sm text-gray-500">Pending Deliveries</div>
            <div className="text-3xl font-bold text-[#1F1D1B] mt-1">{pendingDeliveries.length}</div>
            <div className="text-xs text-gray-400 mt-1">scheduled for delivery</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-sm text-gray-500">Outstanding Amount</div>
            <div className="text-3xl font-bold text-[#1F1D1B] mt-1">
              {formatCurrency(outstandingSen)}
            </div>
            <div className="text-xs text-gray-400 mt-1">unpaid invoices</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-sm text-gray-500">Recent Activity</div>
            <div className="text-3xl font-bold text-[#1F1D1B] mt-1">{invoices.length}</div>
            <div className="text-xs text-gray-400 mt-1">invoices this period</div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Orders */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Recent Orders</CardTitle>
            <Link to="/portal/orders" className="text-sm text-[#6B5C32] hover:underline">
              View all
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {orders.length === 0 ? (
            <p className="text-gray-500 text-sm">No orders found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left py-3 px-2 font-medium text-gray-500">SO Number</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Date</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Items</th>
                    <th className="text-right py-3 px-2 font-medium text-gray-500">Total</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Status</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.slice(0, 5).map((order) => (
                    <tr key={order.id} className="border-b border-[#E2DDD8] last:border-0 hover:bg-[#F0ECE9]/50">
                      <td className="py-3 px-2">
                        <Link to={`/portal/orders/${order.id}`} className="text-[#6B5C32] hover:underline font-medium">
                          {order.companySOId}
                        </Link>
                      </td>
                      <td className="py-3 px-2 text-gray-600">{formatDate(order.companySODate)}</td>
                      <td className="py-3 px-2 text-gray-600">{order.items.length} item(s)</td>
                      <td className="py-3 px-2 text-right font-medium">{formatCurrency(order.totalSen)}</td>
                      <td className="py-3 px-2">
                        <Badge variant="status" status={order.status} />
                      </td>
                      <td className="py-3 px-2">
                        <div className="flex items-center gap-2">
                          <div className="w-20 h-2 bg-gray-200 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-[#6B5C32] rounded-full transition-all"
                              style={{ width: `${order.overallProgress}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-500">{order.overallProgress}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Upcoming Deliveries */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Upcoming Deliveries</CardTitle>
            <Link to="/portal/deliveries" className="text-sm text-[#6B5C32] hover:underline">
              View all
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {pendingDeliveries.length === 0 ? (
            <p className="text-gray-500 text-sm">No upcoming deliveries.</p>
          ) : (
            <div className="space-y-3">
              {pendingDeliveries.map((delivery) => (
                <div
                  key={delivery.id}
                  className="flex items-center justify-between p-4 rounded-lg border border-[#E2DDD8] bg-white"
                >
                  <div>
                    <div className="font-medium text-[#1F1D1B]">{delivery.doNo}</div>
                    <div className="text-sm text-gray-500 mt-0.5">
                      {delivery.items.map((i) => `${i.productName} x${i.quantity}`).join(", ")}
                    </div>
                  </div>
                  <div className="text-right">
                    <Badge variant="status" status={delivery.status} />
                    <div className="text-sm text-gray-500 mt-1">
                      Expected: {formatDate(delivery.deliveryDate)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
