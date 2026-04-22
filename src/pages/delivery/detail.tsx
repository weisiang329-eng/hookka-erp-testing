import { useState, useEffect } from "react";
import { useToast } from "@/components/ui/toast";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate, formatDateTime } from "@/lib/utils";
import {
  ArrowLeft,
  User,
  MapPin,
  Phone,
  Truck,
  CheckCircle2,
  PackageCheck,
  Send,
  ReceiptText,
  Download,
  ClipboardList,
  MapPinned,
  AlertTriangle,
  Box,
} from "lucide-react";
import { generateDOPdf } from "@/lib/generate-do-pdf";
import { generatePackingListPdf } from "@/lib/generate-packing-pdf";
import PODDialog from "@/components/delivery/POD-dialog";
import type { ProofOfDelivery } from "@/lib/mock-data";
import { usePresence } from "@/lib/use-presence";
import { PresenceBanner } from "@/components/presence-banner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DeliveryOrderItem = {
  id: string;
  productionOrderId: string;
  poNo: string;
  productCode: string;
  productName: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  itemM3: number;
  rackingNumber: string;
  packingStatus: string;
};

type DeliveryOrder = {
  id: string;
  doNo: string;
  salesOrderId: string;
  companySOId: string;
  customerId: string;
  customerPOId: string;
  customerName: string;
  customerState: string;
  hubId?: string | null;
  hubName?: string;
  deliveryAddress: string;
  contactPerson: string;
  contactPhone: string;
  deliveryDate: string;
  hookkaExpectedDD: string;
  driverId: string | null;
  driverName: string;
  vehicleNo: string;
  items: DeliveryOrderItem[];
  totalM3: number;
  totalItems: number;
  status: "DRAFT" | "LOADED" | "IN_TRANSIT" | "DELIVERED" | "INVOICED" | "CANCELLED";
  overdue: string;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  remarks: string;
  lorryId?: string | null;
  lorryName?: string;
  proofOfDelivery?: ProofOfDelivery | null;
};

type LorryInfo = {
  id: string;
  name: string;
  plateNumber: string;
  capacity: number;
  driverName: string;
  driverContact: string;
  status: "AVAILABLE" | "IN_USE" | "MAINTENANCE";
};

// ---------------------------------------------------------------------------
// Status flow
// ---------------------------------------------------------------------------

const STATUS_FLOW: Record<string, { next: string; label: string; icon: React.ReactNode }> = {
  DRAFT: { next: "LOADED", label: "Load & Generate DO", icon: <PackageCheck className="h-4 w-4" /> },
  LOADED: { next: "IN_TRANSIT", label: "Dispatch", icon: <Send className="h-4 w-4" /> },
  IN_TRANSIT: { next: "DELIVERED", label: "Mark Delivered", icon: <CheckCircle2 className="h-4 w-4" /> },
};

const ALL_STATUSES = ["DRAFT", "LOADED", "IN_TRANSIT", "DELIVERED", "INVOICED"];

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Packing List",
  LOADED: "Loaded",
  IN_TRANSIT: "In Transit",
  DELIVERED: "Delivered",
  INVOICED: "Invoiced",
};

function calculateOverdueDays(deliveryDate: string, deliveredAt: string | null): number {
  if (!deliveryDate) return 0;
  const target = new Date(deliveryDate);
  const comparison = deliveredAt ? new Date(deliveredAt) : new Date();
  const diff = Math.floor((comparison.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));
  return diff;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DeliveryDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const otherEditors = usePresence("delivery_order", id, Boolean(id));
  const [order, setOrder] = useState<DeliveryOrder | null>(null);
  const [lorries, setLorries] = useState<LorryInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [podOpen, setPodOpen] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(`/api/delivery-orders/${id}`).then((r) => r.json()),
      fetch("/api/lorries").then((r) => r.json()),
    ])
      .then(([doData, lorryData]) => {
        setOrder(doData.data ?? doData ?? null);
        setLorries(lorryData.data ?? lorryData ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [id]);

  const advanceStatus = async (nextStatus?: string) => {
    if (!order) return;
    const target = nextStatus || STATUS_FLOW[order.status]?.next;
    if (!target) return;

    // Gate DELIVERED transition on proof of delivery
    if (target === "DELIVERED" && !order.proofOfDelivery) {
      setPodOpen(true);
      return;
    }

    setUpdating(true);
    try {
      const res = await fetch(`/api/delivery-orders/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: target }),
      });
      const data = await res.json();
      if (data.success) setOrder(data.data);
    } finally {
      setUpdating(false);
    }
  };

  const handleSubmitPOD = async (pod: ProofOfDelivery) => {
    if (!order) return;
    setUpdating(true);
    try {
      // If order is already DELIVERED, just attach proof; otherwise transition.
      const body: Record<string, unknown> = { proofOfDelivery: pod };
      if (order.status !== "DELIVERED") body.status = "DELIVERED";
      const res = await fetch(`/api/delivery-orders/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setOrder(data.data);
        setPodOpen(false);
      } else {
        toast.error(data.error || "Failed to save proof of delivery");
      }
    } finally {
      setUpdating(false);
    }
  };

  const assignLorry = async (lorryId: string) => {
    if (!order) return;
    setUpdating(true);
    try {
      const res = await fetch(`/api/delivery-orders/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lorryId }),
      });
      const data = await res.json();
      if (data.success) setOrder(data.data);
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-[#6B7280]">Loading delivery order...</div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="text-[#6B7280]">Delivery order not found</div>
        <Button variant="outline" onClick={() => navigate("/delivery")}>
          Back to Deliveries
        </Button>
      </div>
    );
  }

  const flow = STATUS_FLOW[order.status];
  const overdueDays = calculateOverdueDays(order.deliveryDate, order.deliveredAt);
  const currentLorry = lorries.find((l) => l.id === order.lorryId);

  return (
    <div className="space-y-6">
      <PresenceBanner holders={otherEditors} />
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/delivery")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-[#1F1D1B] doc-number">{order.doNo}</h1>
            <Badge variant="status" status={order.status}>
              {STATUS_LABEL[order.status] || order.status.replace(/_/g, " ")}
            </Badge>
            {overdueDays > 0 && order.status !== "DELIVERED" && order.status !== "INVOICED" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#F9E1DA] border border-[#E8B2A1] px-2.5 py-0.5 text-xs font-medium text-[#9A3A2D]">
                <AlertTriangle className="h-3 w-3" />
                {overdueDays}d overdue
              </span>
            )}
          </div>
          <p className="text-xs text-[#6B7280]">
            {order.customerName} &middot; {order.companySOId}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              generateDOPdf(order as unknown as import("@/lib/mock-data").DeliveryOrder)
            }
          >
            <Download className="h-4 w-4" /> Download DO PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              generatePackingListPdf(order as unknown as import("@/lib/mock-data").DeliveryOrder)
            }
          >
            <ClipboardList className="h-4 w-4" /> Print Packing List
          </Button>
          {flow && (
            <Button variant="primary" size="sm" onClick={() => advanceStatus()} disabled={updating}>
              {flow.icon} {updating ? "Updating..." : flow.label}
            </Button>
          )}
          {order.status === "DELIVERED" && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => advanceStatus("INVOICED")}
              disabled={updating}
            >
              <ReceiptText className="h-4 w-4" />
              {updating ? "Updating..." : "Convert to Invoice"}
            </Button>
          )}
        </div>
      </div>

      {/* Info Cards */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        {/* Customer Info */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <User className="h-4 w-4 text-[#6B5C32]" /> Customer Information
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-[#9CA3AF]">Customer Name</p>
                <p className="font-medium text-[#1F1D1B]">{order.customerName}</p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">State</p>
                <p className="font-medium text-[#4B5563]">{order.customerState}</p>
              </div>
              <div className="col-span-2">
                <p className="text-xs text-[#9CA3AF] flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> Delivery Hub
                </p>
                <p className="font-medium text-[#1F1D1B]">
                  {order.hubName || "-"}
                  {order.hubName ? (
                    <span className="text-xs text-[#9CA3AF] font-normal">
                      {" "}(from {order.customerName})
                    </span>
                  ) : null}
                </p>
              </div>
              <div className="col-span-2">
                <p className="text-xs text-[#9CA3AF] flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> Delivery Address
                </p>
                <p className="font-medium text-[#4B5563]">{order.deliveryAddress}</p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Contact Person</p>
                <p className="font-medium text-[#4B5563]">{order.contactPerson}</p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF] flex items-center gap-1">
                  <Phone className="h-3 w-3" /> Phone
                </p>
                <p className="font-medium text-[#4B5563]">{order.contactPhone}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Delivery Info */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <Truck className="h-4 w-4 text-[#6B5C32]" /> Delivery Information
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-[#9CA3AF]">Delivery Date</p>
                <p className="font-medium">{order.deliveryDate ? formatDate(order.deliveryDate) : "-"}</p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Expected DD (Hookka)</p>
                <p className="font-medium">{order.hookkaExpectedDD ? formatDate(order.hookkaExpectedDD) : "-"}</p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Driver</p>
                <p className="font-medium text-[#4B5563]">{order.driverName || "-"}</p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Vehicle No.</p>
                <p className="font-medium doc-number">{order.vehicleNo || "-"}</p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Dispatched At</p>
                <p className="font-medium">
                  {order.dispatchedAt ? formatDateTime(order.dispatchedAt) : "-"}
                </p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Delivered At</p>
                <p className="font-medium">
                  {order.deliveredAt ? formatDateTime(order.deliveredAt) : "-"}
                </p>
              </div>
            </div>
            {order.remarks && (
              <div className="mt-4 rounded-md bg-[#FAF9F7] border border-[#E2DDD8] p-3">
                <p className="text-xs text-[#9CA3AF] mb-1">Remarks</p>
                <p className="text-sm text-[#4B5563]">{order.remarks}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Lorry Assignment & M3 Summary */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <Box className="h-4 w-4 text-[#6B5C32]" /> Loading &amp; Volume
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <p className="text-xs text-[#9CA3AF]">Total M&sup3;</p>
                <p className="text-xl font-bold text-[#1F1D1B]">{order.totalM3.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-xs text-[#9CA3AF]">Total Items</p>
                <p className="text-xl font-bold text-[#1F1D1B]">{order.totalItems}</p>
              </div>
            </div>

            {/* Current lorry assignment */}
            <div className="rounded-md border border-[#E2DDD8] p-3 mb-3">
              <p className="text-xs text-[#9CA3AF] mb-2">Assigned Lorry</p>
              {currentLorry ? (
                <div>
                  <p className="font-medium text-[#1F1D1B]">{currentLorry.name}</p>
                  <p className="text-xs text-[#6B7280] doc-number">{currentLorry.plateNumber}</p>
                  <p className="text-xs text-[#6B7280]">{currentLorry.driverName} | {currentLorry.driverContact}</p>
                  <p className="text-xs text-[#9CA3AF] mt-1">
                    Capacity: {currentLorry.capacity} M&sup3;
                  </p>
                </div>
              ) : (
                <p className="text-sm text-[#9CA3AF]">No lorry assigned</p>
              )}
            </div>

            {/* Lorry selection (only for non-delivered orders) */}
            {(order.status === "DRAFT" || order.status === "LOADED") && (
              <div>
                <p className="text-xs text-[#9CA3AF] mb-2">Assign to Lorry</p>
                <div className="flex flex-wrap gap-2">
                  {lorries.map((lorry) => (
                    <Button
                      key={lorry.id}
                      variant={order.lorryId === lorry.id ? "primary" : "outline"}
                      size="sm"
                      className="text-xs"
                      onClick={() => assignLorry(lorry.id)}
                      disabled={updating}
                    >
                      <Truck className="h-3 w-3" />
                      {lorry.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Proof of Delivery */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-[#6B5C32]" /> Proof of Delivery
          </CardTitle>
        </CardHeader>
        <CardContent>
          {order.proofOfDelivery ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-[#9CA3AF]">Receiver Name</p>
                  <p className="font-medium text-[#111827]">
                    {order.proofOfDelivery.receiverName}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[#9CA3AF]">Receiver IC / ID</p>
                  <p className="font-medium text-[#4B5563]">
                    {order.proofOfDelivery.receiverIC || "-"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[#9CA3AF]">Delivered At</p>
                  <p className="font-medium text-[#4B5563]">
                    {formatDateTime(order.proofOfDelivery.deliveredAt)}
                  </p>
                </div>
                {order.proofOfDelivery.capturedBy && (
                  <div>
                    <p className="text-xs text-[#9CA3AF]">Captured By</p>
                    <p className="font-medium text-[#4B5563]">
                      {order.proofOfDelivery.capturedBy}
                    </p>
                  </div>
                )}
              </div>

              {order.proofOfDelivery.remarks && (
                <div className="rounded-md bg-[#FAF9F7] border border-[#E2DDD8] p-3">
                  <p className="text-xs text-[#9CA3AF] mb-1">Remarks</p>
                  <p className="text-sm text-[#4B5563]">
                    {order.proofOfDelivery.remarks}
                  </p>
                </div>
              )}

              {order.proofOfDelivery.signatureDataUrl && (
                <div>
                  <p className="text-xs text-[#9CA3AF] mb-1">Signature</p>
                  <div className="rounded-md border border-[#E2DDD8] bg-white inline-block p-2">
                    <img
                      src={order.proofOfDelivery.signatureDataUrl}
                      alt="Receiver signature"
                      className="max-h-32"
                    />
                  </div>
                </div>
              )}

              {order.proofOfDelivery.photoDataUrls.length > 0 && (
                <div>
                  <p className="text-xs text-[#9CA3AF] mb-1">
                    Photos ({order.proofOfDelivery.photoDataUrls.length})
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {order.proofOfDelivery.photoDataUrls.map((src, idx) => (
                      <img
                        key={idx}
                        src={src}
                        alt={`POD photo ${idx + 1}`}
                        className="w-32 h-32 object-cover rounded-md border border-[#E2DDD8]"
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-sm text-[#9CA3AF]">No proof captured yet</p>
              {(order.status === "DELIVERED" ||
                order.status === "IN_TRANSIT" ||
                order.status === "LOADED") && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPodOpen(true)}
                >
                  <CheckCircle2 className="h-4 w-4" /> Capture POD
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Items Table with M3 and Racking */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Items ({order.items.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-[#E2DDD8] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                  <th className="h-10 px-4 text-left font-medium text-[#374151] w-8">#</th>
                  <th className="h-10 px-4 text-left font-medium text-[#374151]">SO ID</th>
                  <th className="h-10 px-4 text-left font-medium text-[#374151]">Product</th>
                  <th className="h-10 px-4 text-left font-medium text-[#374151]">Size</th>
                  <th className="h-10 px-4 text-left font-medium text-[#374151]">Fabric</th>
                  <th className="h-10 px-4 text-right font-medium text-[#374151]">Qty</th>
                  <th className="h-10 px-4 text-right font-medium text-[#374151]">Unit M&sup3;</th>
                  <th className="h-10 px-4 text-right font-medium text-[#374151]">Total M&sup3;</th>
                  <th className="h-10 px-4 text-left font-medium text-[#374151]">Rack #</th>
                  <th className="h-10 px-4 text-left font-medium text-[#374151]">Packing</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item, idx) => (
                  <tr key={item.id} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7]">
                    <td className="h-12 px-4 text-[#9CA3AF]">{idx + 1}</td>
                    <td className="h-12 px-4 doc-number font-medium">{item.poNo}</td>
                    <td className="h-12 px-4">
                      <p className="font-medium text-[#1F1D1B]">{item.productName}</p>
                      <p className="text-xs text-[#9CA3AF] doc-number">{item.productCode}</p>
                    </td>
                    <td className="h-12 px-4 text-[#4B5563]">{item.sizeLabel}</td>
                    <td className="h-12 px-4 text-[#4B5563]">{item.fabricCode}</td>
                    <td className="h-12 px-4 text-right font-medium">{item.quantity}</td>
                    <td className="h-12 px-4 text-right">{item.itemM3.toFixed(2)}</td>
                    <td className="h-12 px-4 text-right font-medium">
                      {(item.itemM3 * item.quantity).toFixed(2)}
                    </td>
                    <td className="h-12 px-4">
                      {item.rackingNumber ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-[#FAEFCB] border border-[#E8D597] px-2 py-0.5 text-xs font-bold text-[#9C6F1E] doc-number">
                          <MapPinned className="h-3 w-3" />
                          {item.rackingNumber}
                        </span>
                      ) : (
                        <span className="text-[#9CA3AF]">-</span>
                      )}
                    </td>
                    <td className="h-12 px-4">
                      <Badge
                        variant="status"
                        status={item.packingStatus === "PACKED" ? "COMPLETED" : "PENDING"}
                      >
                        {item.packingStatus}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-[#F0ECE9]">
                  <td colSpan={5} className="px-4 py-3 text-right font-semibold text-[#374151]">
                    Total
                  </td>
                  <td className="px-4 py-3 text-right font-bold">
                    {order.items.reduce((s, i) => s + i.quantity, 0)}
                  </td>
                  <td className="px-4 py-3 text-right text-[#9CA3AF]">-</td>
                  <td className="px-4 py-3 text-right font-bold">
                    {order.items.reduce((s, i) => s + i.itemM3 * i.quantity, 0).toFixed(2)}
                  </td>
                  <td />
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Delivery Timeline */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Delivery Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-0 overflow-x-auto">
            {ALL_STATUSES.map((status, i, arr) => {
              const isActive = status === order.status;
              const isPast = arr.indexOf(order.status) > i;
              const statusIdx = arr.indexOf(order.status);

              let stepDate = "";
              if (status === "DRAFT" && (isPast || isActive)) {
                stepDate = order.deliveryDate ? formatDate(order.deliveryDate) : "Created";
              } else if (status === "LOADED" && (isPast || isActive) && statusIdx >= 1) {
                stepDate = order.dispatchedAt ? formatDateTime(order.dispatchedAt) : "Loaded";
              } else if (status === "IN_TRANSIT" && (isPast || isActive) && statusIdx >= 2) {
                stepDate = order.dispatchedAt ? formatDateTime(order.dispatchedAt) : "Dispatched";
              } else if (status === "DELIVERED" && (isPast || isActive) && statusIdx >= 3) {
                stepDate = order.deliveredAt ? formatDateTime(order.deliveredAt) : "Delivered";
              } else if (status === "INVOICED" && isActive) {
                stepDate = "Invoiced";
              }

              return (
                <div key={status} className="flex items-center">
                  <div className="flex flex-col items-center min-w-[100px]">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 ${
                        isActive
                          ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                          : isPast
                          ? "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]"
                          : "bg-gray-50 text-gray-400 border-gray-200"
                      }`}
                    >
                      {isPast ? (
                        <CheckCircle2 className="h-4 w-4" />
                      ) : (
                        i + 1
                      )}
                    </div>
                    <p
                      className={`text-xs font-medium mt-1.5 whitespace-nowrap ${
                        isActive
                          ? "text-[#6B5C32]"
                          : isPast
                          ? "text-[#4F7C3A]"
                          : "text-gray-400"
                      }`}
                    >
                      {STATUS_LABEL[status] || status.replace(/_/g, " ")}
                    </p>
                    {stepDate && (
                      <p className="text-[10px] text-[#9CA3AF] mt-0.5 whitespace-nowrap">
                        {stepDate}
                      </p>
                    )}
                  </div>
                  {i < arr.length - 1 && (
                    <div
                      className={`h-0.5 w-8 mt-[-16px] ${
                        isPast ? "bg-[#4F7C3A]" : "bg-gray-200"
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* POD Capture Dialog */}
      <PODDialog
        open={podOpen}
        doNo={order.doNo}
        customerName={order.customerName}
        onClose={() => setPodOpen(false)}
        onSubmit={handleSubmitPOD}
      />
    </div>
  );
}
