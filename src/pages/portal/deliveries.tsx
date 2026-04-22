import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";

const CUSTOMER_ID = "cust-2";

type DeliveryItem = {
  id: string;
  poNo: string;
  productName: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
};

type DeliveryData = {
  id: string;
  doNo: string;
  companySOId: string;
  deliveryDate: string;
  hookkaExpectedDD: string;
  status: string;
  totalItems: number;
  totalM3: number;
  driverName: string;
  vehicleNo: string;
  deliveredAt: string | null;
  dispatchedAt: string | null;
  remarks: string;
  items: DeliveryItem[];
};

export default function PortalDeliveriesPage() {
  const [deliveries, setDeliveries] = useState<DeliveryData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchDeliveries() {
      try {
        const res = await fetch(`/api/portal/deliveries?customerId=${CUSTOMER_ID}`);
        const data = await res.json();
        if (data.success) setDeliveries(data.data);
      } catch {
        // silently ignore
      } finally {
        setLoading(false);
      }
    }
    fetchDeliveries();
  }, []);

  const upcoming = deliveries.filter((d) => !["DELIVERED", "CANCELLED"].includes(d.status));
  const past = deliveries.filter((d) => d.status === "DELIVERED");

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading deliveries...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#1F1D1B]">Deliveries</h1>
        <p className="text-gray-500 mt-1">Track your upcoming and past deliveries.</p>
      </div>

      {/* Upcoming Deliveries */}
      <Card>
        <CardHeader>
          <CardTitle>Upcoming Deliveries</CardTitle>
        </CardHeader>
        <CardContent>
          {upcoming.length === 0 ? (
            <p className="text-gray-500 text-sm">No upcoming deliveries.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left py-3 px-2 font-medium text-gray-500">DO Number</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">SO Number</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Expected Date</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Items</th>
                    <th className="text-right py-3 px-2 font-medium text-gray-500">Total Qty</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Status</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Vehicle</th>
                  </tr>
                </thead>
                <tbody>
                  {upcoming.map((d) => (
                    <tr key={d.id} className="border-b border-[#E2DDD8] last:border-0">
                      <td className="py-3 px-2 font-medium text-[#1F1D1B]">{d.doNo}</td>
                      <td className="py-3 px-2 text-gray-600">{d.companySOId}</td>
                      <td className="py-3 px-2 text-gray-600">{formatDate(d.deliveryDate)}</td>
                      <td className="py-3 px-2 text-gray-600">
                        <div className="space-y-0.5">
                          {d.items.map((item) => (
                            <div key={item.id} className="text-xs">
                              {item.productName} ({item.sizeLabel}) x{item.quantity}
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="py-3 px-2 text-right">{d.totalItems}</td>
                      <td className="py-3 px-2">
                        <Badge variant="status" status={d.status} />
                      </td>
                      <td className="py-3 px-2 text-gray-600">{d.vehicleNo || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Past Deliveries */}
      <Card>
        <CardHeader>
          <CardTitle>Past Deliveries</CardTitle>
        </CardHeader>
        <CardContent>
          {past.length === 0 ? (
            <p className="text-gray-500 text-sm">No past deliveries.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left py-3 px-2 font-medium text-gray-500">DO Number</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">SO Number</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Delivered Date</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Items</th>
                    <th className="text-right py-3 px-2 font-medium text-gray-500">Total Qty</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Status</th>
                    <th className="text-left py-3 px-2 font-medium text-gray-500">Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {past.map((d) => (
                    <tr key={d.id} className="border-b border-[#E2DDD8] last:border-0">
                      <td className="py-3 px-2 font-medium text-[#1F1D1B]">{d.doNo}</td>
                      <td className="py-3 px-2 text-gray-600">{d.companySOId}</td>
                      <td className="py-3 px-2 text-gray-600">
                        {d.deliveredAt ? formatDate(d.deliveredAt) : "-"}
                      </td>
                      <td className="py-3 px-2 text-gray-600">
                        <div className="space-y-0.5">
                          {d.items.map((item) => (
                            <div key={item.id} className="text-xs">
                              {item.productName} ({item.sizeLabel}) x{item.quantity}
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="py-3 px-2 text-right">{d.totalItems}</td>
                      <td className="py-3 px-2">
                        <Badge variant="status" status={d.status} />
                      </td>
                      <td className="py-3 px-2 text-gray-500 text-xs">{d.remarks || "-"}</td>
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
