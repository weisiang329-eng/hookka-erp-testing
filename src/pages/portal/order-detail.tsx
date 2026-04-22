import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useParams } from "react-router-dom";

const CUSTOMER_ID = "cust-2";

const DEPT_LABELS: Record<string, string> = {
  FAB_CUT: "Fabric Cutting",
  FAB_SEW: "Fabric Sewing",
  WOOD_CUT: "Wood Cutting",
  FOAM: "Foam Bonding",
  FRAMING: "Framing",
  WEBBING: "Webbing",
  UPHOLSTERY: "Upholstery",
  PACKING: "Packing",
};

const DEPT_COLORS: Record<string, string> = {
  COMPLETED: "bg-[#4F7C3A]",
  IN_PROGRESS: "bg-[#3E6570]",
  WAITING: "bg-gray-300",
  PAUSED: "bg-[#9C6F1E]",
  BLOCKED: "bg-[#9A3A2D]",
  TRANSFERRED: "bg-[#4F7C3A]",
};

type JobCard = {
  departmentCode: string;
  departmentName: string;
  status: string;
  sequence: number;
  completedDate: string | null;
};

type ProductionOrder = {
  id: string;
  poNo: string;
  productCode: string;
  productName: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  currentDepartment: string;
  progress: number;
  status: string;
  targetEndDate: string;
  jobCards: JobCard[];
};

type OrderItem = {
  id: string;
  lineNo: number;
  lineSuffix: string;
  productCode: string;
  productName: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  unitPriceSen: number;
  lineTotalSen: number;
  notes: string;
};

type OrderData = {
  id: string;
  companySOId: string;
  companySODate: string;
  customerPOId: string;
  customerDeliveryDate: string;
  hookkaExpectedDD: string;
  status: string;
  totalSen: number;
  subtotalSen: number;
  notes: string;
  items: OrderItem[];
  overallProgress: number;
  productionOrders: ProductionOrder[];
};

export default function PortalOrderDetailPage() {
  const { id } = useParams();
  const [order, setOrder] = useState<OrderData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchOrder() {
      try {
        const res = await fetch(`/api/portal/orders?customerId=${CUSTOMER_ID}`);
        const data = await res.json();
        if (data.success) {
          const found = data.data.find((o: OrderData) => o.id === id);
          setOrder(found || null);
        }
      } catch {
        // silently ignore
      } finally {
        setLoading(false);
      }
    }
    fetchOrder();
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading order details...</div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="space-y-4">
        <p className="text-gray-500">Order not found.</p>
        <Link to="/portal/orders">
          <Button variant="outline">Back to Orders</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link to="/portal/orders" className="text-sm text-[#6B5C32] hover:underline">
        &larr; Back to Orders
      </Link>

      {/* Order Header */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <CardTitle className="text-xl">{order.companySOId}</CardTitle>
              <div className="text-sm text-gray-500 mt-1">
                Customer PO: {order.customerPOId} | Order Date: {formatDate(order.companySODate)}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Badge variant="status" status={order.status} />
              <div className="text-right">
                <div className="text-sm text-gray-500">Expected Delivery</div>
                <div className="font-medium">{formatDate(order.hookkaExpectedDD)}</div>
              </div>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Items Table */}
      <Card>
        <CardHeader>
          <CardTitle>Order Items</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8]">
                  <th className="text-left py-3 px-2 font-medium text-gray-500">#</th>
                  <th className="text-left py-3 px-2 font-medium text-gray-500">Product</th>
                  <th className="text-left py-3 px-2 font-medium text-gray-500">Size</th>
                  <th className="text-left py-3 px-2 font-medium text-gray-500">Fabric</th>
                  <th className="text-right py-3 px-2 font-medium text-gray-500">Qty</th>
                  <th className="text-right py-3 px-2 font-medium text-gray-500">Unit Price</th>
                  <th className="text-right py-3 px-2 font-medium text-gray-500">Line Total</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => (
                  <tr key={item.id} className="border-b border-[#E2DDD8] last:border-0">
                    <td className="py-3 px-2 text-gray-600">{item.lineNo}</td>
                    <td className="py-3 px-2">
                      <div className="font-medium text-[#1F1D1B]">{item.productName}</div>
                      <div className="text-xs text-gray-400">{item.productCode}</div>
                    </td>
                    <td className="py-3 px-2 text-gray-600">{item.sizeLabel}</td>
                    <td className="py-3 px-2 text-gray-600">{item.fabricCode}</td>
                    <td className="py-3 px-2 text-right">{item.quantity}</td>
                    <td className="py-3 px-2 text-right">{formatCurrency(item.unitPriceSen)}</td>
                    <td className="py-3 px-2 text-right font-medium">{formatCurrency(item.lineTotalSen)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[#E2DDD8]">
                  <td colSpan={6} className="py-3 px-2 text-right font-semibold text-[#1F1D1B]">
                    Order Total
                  </td>
                  <td className="py-3 px-2 text-right font-bold text-[#1F1D1B]">
                    {formatCurrency(order.totalSen)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Production Progress */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Production Progress</CardTitle>
            <div className="flex items-center gap-2">
              <div className="w-24 h-3 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#6B5C32] rounded-full transition-all"
                  style={{ width: `${order.overallProgress}%` }}
                />
              </div>
              <span className="text-sm font-medium">{order.overallProgress}%</span>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {order.productionOrders.length === 0 ? (
            <p className="text-gray-500 text-sm">Production has not started yet.</p>
          ) : (
            <div className="space-y-6">
              {order.productionOrders.map((po) => (
                <div key={po.id} className="border border-[#E2DDD8] rounded-lg p-4">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <div className="font-medium text-[#1F1D1B]">{po.poNo}</div>
                      <div className="text-sm text-gray-500">
                        {po.productName} ({po.sizeLabel}) - {po.fabricCode} x{po.quantity}
                      </div>
                    </div>
                    <div className="text-right">
                      <Badge variant="status" status={po.status} />
                      <div className="text-xs text-gray-500 mt-1">
                        Target: {formatDate(po.targetEndDate)}
                      </div>
                    </div>
                  </div>

                  {/* Department progress bar */}
                  <div className="space-y-2">
                    <div className="flex gap-1">
                      {po.jobCards
                        .sort((a, b) => a.sequence - b.sequence)
                        .map((jc) => (
                          <div
                            key={jc.departmentCode}
                            className="flex-1 group relative"
                            title={`${DEPT_LABELS[jc.departmentCode] || jc.departmentName}: ${jc.status}`}
                          >
                            <div
                              className={`h-6 rounded-sm ${DEPT_COLORS[jc.status] || "bg-gray-300"} transition-all`}
                            />
                            <div className="text-[10px] text-gray-500 text-center mt-1 truncate">
                              {jc.departmentName}
                            </div>
                          </div>
                        ))}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-400">
                      <span className="flex items-center gap-1">
                        <span className="w-3 h-3 rounded-sm bg-[#4F7C3A] inline-block" /> Completed
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="w-3 h-3 rounded-sm bg-[#3E6570] inline-block" /> In Progress
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="w-3 h-3 rounded-sm bg-gray-300 inline-block" /> Waiting
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Notes */}
      {order.notes && (
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600">{order.notes}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
