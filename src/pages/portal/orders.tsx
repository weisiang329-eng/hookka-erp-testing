import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";

const CUSTOMER_ID = "cust-2";

type ProductionOrder = {
  id: string;
  poNo: string;
  currentDepartment: string;
  progress: number;
  status: string;
};

type OrderData = {
  id: string;
  companySOId: string;
  companySODate: string;
  customerPOId: string;
  status: string;
  totalSen: number;
  items: { id: string; productName: string; sizeLabel: string; fabricCode: string; quantity: number; lineTotalSen: number }[];
  overallProgress: number;
  productionOrders: ProductionOrder[];
};

export default function PortalOrdersPage() {
  const [orders, setOrders] = useState<OrderData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchOrders() {
      try {
        const res = await fetch(`/api/portal/orders?customerId=${CUSTOMER_ID}`);
        const data = await res.json();
        if (data.success) setOrders(data.data);
      } catch {
        // silently ignore
      } finally {
        setLoading(false);
      }
    }
    fetchOrders();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading orders...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#1F1D1B]">Orders</h1>
        <p className="text-gray-500 mt-1">View all your sales orders and production progress.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sales Orders</CardTitle>
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
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Customer PO</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Date</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Items</th>
                    <th className="text-right py-3 px-2 font-medium text-gray-500">Total</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Status</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Production Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.id} className="border-b border-[#E2DDD8] last:border-0 hover:bg-[#F0ECE9]/50 cursor-pointer">
                      <td className="py-3 px-2">
                        <Link to={`/portal/orders/${order.id}`} className="text-[#6B5C32] hover:underline font-medium">
                          {order.companySOId}
                        </Link>
                      </td>
                      <td className="py-3 px-2 text-gray-600">{order.customerPOId}</td>
                      <td className="py-3 px-2 text-gray-600">{formatDate(order.companySODate)}</td>
                      <td className="py-3 px-2 text-gray-600">
                        <div className="space-y-0.5">
                          {order.items.map((item) => (
                            <div key={item.id} className="text-xs">
                              {item.productName} ({item.sizeLabel}) x{item.quantity}
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="py-3 px-2 text-right font-medium">{formatCurrency(order.totalSen)}</td>
                      <td className="py-3 px-2">
                        <Badge variant="status" status={order.status} />
                      </td>
                      <td className="py-3 px-2">
                        <div className="flex items-center gap-2">
                          <div className="w-24 h-2 bg-gray-200 rounded-full overflow-hidden">
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
    </div>
  );
}
