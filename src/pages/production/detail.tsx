import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import {
  Factory, CheckCircle2, AlertTriangle, ArrowLeft,
  Play, Square, User, ChevronRight, Download, FileText, QrCode, X, Printer,
} from "lucide-react";
import { generateJobCardPdf, generateFullPOPdf } from "@/lib/generate-po-pdf";
import { getQRCodeUrl, generateStickerData } from "@/lib/qr-utils";

type JobCard = {
  id: string; departmentId: string; departmentCode: string; departmentName: string; sequence: number;
  status: "WAITING"|"IN_PROGRESS"|"PAUSED"|"COMPLETED"|"TRANSFERRED"|"BLOCKED";
  dueDate: string; prerequisiteMet: boolean;
  pic1Id: string|null; pic1Name: string; pic2Id: string|null; pic2Name: string;
  completedDate: string|null; estMinutes: number; actualMinutes: number|null;
  category: string; productionTimeMinutes: number; overdue: string;
};

type ProductionOrder = {
  id: string; poNo: string;
  salesOrderId: string; salesOrderNo: string; lineNo: number;
  customerPOId: string; customerReference: string; customerName: string; customerState: string;
  companySOId: string;
  productId: string; productCode: string; productName: string; itemCategory: "SOFA"|"BEDFRAME"|"ACCESSORY";
  sizeCode: string; sizeLabel: string; fabricCode: string; quantity: number;
  gapInches: number|null; divanHeightInches: number|null; legHeightInches: number|null;
  specialOrder: string; notes: string;
  status: "PENDING"|"IN_PROGRESS"|"COMPLETED"|"ON_HOLD"|"CANCELLED"|"PAUSED";
  currentDepartment: string; progress: number;
  jobCards: JobCard[];
  startDate: string; targetEndDate: string; completedDate: string|null;
  rackingNumber: string; stockedIn: boolean;
};

const DEPT_COLORS: Record<string, string> = {
  FAB_CUT: "#3B82F6",
  FAB_SEW: "#6366F1",
  WOOD_CUT: "#F59E0B",
  FOAM: "#8B5CF6",
  FRAMING: "#F97316",
  WEBBING: "#10B981",
  UPHOLSTERY: "#F43F5E",
  PACKING: "#06B6D4",
};

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "COMPLETED":
    case "TRANSFERRED":
      return <CheckCircle2 className="h-6 w-6 text-[#4F7C3A]" />;
    case "IN_PROGRESS":
      return (
        <div className="h-6 w-6 rounded-full border-2 border-[#A8CAD2] border-t-transparent animate-spin" />
      );
    case "PAUSED":
      return <Square className="h-6 w-6 text-[#9C6F1E]" />;
    case "BLOCKED":
      return <AlertTriangle className="h-6 w-6 text-[#9A3A2D]" />;
    default:
      return <div className="h-6 w-6 rounded-full border-2 border-[#D1CBC5]" />;
  }
}

function formatMinutes(m: number | null): string {
  if (m === null || m === undefined) return "-";
  const h = Math.floor(m / 60);
  const mins = m % 60;
  return h > 0 ? `${h}h ${mins}m` : `${mins}m`;
}

export default function ProductionOrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState<ProductionOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [qrJobCard, setQrJobCard] = useState<JobCard | null>(null);
  const [fgSticker, setFgSticker] = useState(false);
  // FG units for this PO — populated when the FG sticker modal opens.
  // Each unit corresponds to ONE physical box (unit × piece). A bedframe PO
  // with qty=3 and 3 pieces = 9 FGUnit rows = 9 stickers.
  type FGUnit = {
    id: string;
    unitSerial: string;
    shortCode: string;
    poId: string;
    poNo: string;
    productCode: string;
    productName: string;
    unitNo: number;
    totalUnits: number;
    pieceNo: number;
    totalPieces: number;
    pieceName: string;
    customerName: string;
    customerHub?: string;
    mfdDate: string | null;
    status: string;
  };
  type ProductExt = {
    skuCode?: string;
    sizeCode?: string;
    fabricColor?: string;
    pieces?: { count: number; names: string[] };
  };
  const [fgUnitList, setFgUnitList] = useState<FGUnit[]>([]);
  const [fgLoading, setFgLoading] = useState(false);
  const [productExt, setProductExt] = useState<ProductExt | null>(null);

  // Derive a WIP/component name for the job-card sticker based on the department.
  // This is the best approximation without an explicit WIP name on the JobCard type.
  const wipNameFor = (jc: JobCard, po: ProductionOrder): string => {
    const base = po.productName || po.productCode;
    const dept = jc.departmentCode;
    // Rough mapping: most departments produce the "Divan / HB" component, Packing produces FG.
    if (dept === "PACKING") return base;
    if (po.itemCategory === "BEDFRAME") {
      // Bedframes split into Divan + Bedhead — sewing/cutting/framing typically work on both
      if (dept === "WOOD_CUT" || dept === "FRAMING" || dept === "WEBBING") return `Divan ${po.sizeLabel || ""}`.trim();
      if (dept === "FAB_CUT" || dept === "FAB_SEW" || dept === "UPHOLSTERY") return `${base} (Fabric)`;
      if (dept === "FOAM") return `Foam ${po.sizeLabel || ""}`.trim();
    }
    return base;
  };

  useEffect(() => {
    fetch(`/api/production-orders/${id}`)
      .then((r) => r.json())
      .then((d) => {
        setOrder(d.success ? d.data : d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [id]);

  const updateJobCard = async (jobCardId: string, newStatus: string) => {
    setUpdating(jobCardId);
    try {
      const res = await fetch(`/api/production-orders/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobCardId, status: newStatus }),
      });
      const data = await res.json();
      if (data.success) setOrder(data.data);
    } catch {
      // handle error silently
    }
    setUpdating(null);
  };

  // When the FG sticker modal opens, fetch existing units for this PO and the
  // product's packing metadata (skuCode, fabricColor, pieces). Units are NOT
  // auto-generated on open — the user must click "Generate Units" first.
  useEffect(() => {
    if (!fgSticker || !order) return;
    let cancelled = false;
    (async () => {
      setFgLoading(true);
      try {
        const [uRes, pRes] = await Promise.all([
          fetch(`/api/fg-units?poId=${encodeURIComponent(order.id)}`).then((r) => r.json()),
          fetch(`/api/products/${encodeURIComponent(order.productId)}`).then((r) => r.json()).catch(() => null),
        ]);
        if (cancelled) return;
        setFgUnitList(uRes?.success ? uRes.data : []);
        if (pRes?.success) {
          const p = pRes.data as ProductExt;
          setProductExt({
            skuCode: p.skuCode,
            sizeCode: p.sizeCode,
            fabricColor: p.fabricColor,
            pieces: p.pieces,
          });
        } else {
          setProductExt(null);
        }
      } catch {
        // silent
      } finally {
        if (!cancelled) setFgLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [fgSticker, order]);

  const handleGenerateUnits = async () => {
    if (!order) return;
    setFgLoading(true);
    try {
      const r = await fetch(`/api/fg-units/generate/${encodeURIComponent(order.id)}`, {
        method: "POST",
      });
      const d = await r.json();
      if (d?.success) setFgUnitList(d.data);
    } catch {
      // silent
    } finally {
      setFgLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#6B5C32] border-t-transparent" />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate("/production")} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> Back to Production
        </Button>
        <div className="text-center py-20 text-[#9CA3AF]">Production order not found.</div>
      </div>
    );
  }

  const sortedJobCards = [...(order.jobCards || [])].sort((a, b) => a.sequence - b.sequence);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/production")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-[#1F1D1B] doc-number">{order.poNo}</h1>
              <Badge variant="status" status={order.status} />
            </div>
            <p className="text-xs text-[#6B7280]">{order.productName}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => generateFullPOPdf(order)}>
            <Download className="h-4 w-4" /> Full PO PDF
          </Button>
          <Button variant="outline" size="sm" onClick={() => setFgSticker(true)}>
            <QrCode className="h-4 w-4" /> FG Packing Sticker
          </Button>
          <div className="text-right">
            <p className="text-xs text-[#6B7280]">Progress</p>
            <p className="text-lg font-bold text-[#1F1D1B]">{order.progress}%</p>
          </div>
          <div className="h-10 w-10 rounded-full border-4 border-[#E2DDD8] relative">
            <svg className="h-full w-full -rotate-90" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="14" fill="none" stroke="#E2DDD8" strokeWidth="3" />
              <circle
                cx="18" cy="18" r="14" fill="none" stroke="#6B5C32" strokeWidth="3"
                strokeDasharray={`${order.progress * 0.88} 88`}
                strokeLinecap="round"
              />
            </svg>
          </div>
        </div>
      </div>

      {/* Order Info Card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Factory className="h-5 w-5 text-[#6B5C32]" />
            Order Information
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-[#9CA3AF] uppercase tracking-wide">Customer</p>
              <p className="font-medium text-[#1F1D1B]">{order.customerName}</p>
              <p className="text-xs text-[#6B7280]">{order.customerState}</p>
            </div>
            <div>
              <p className="text-xs text-[#9CA3AF] uppercase tracking-wide">Sales Order</p>
              <p className="font-medium text-[#1F1D1B] doc-number">{order.salesOrderNo}</p>
              <p className="text-xs text-[#6B7280]">Line {order.lineNo}</p>
            </div>
            <div>
              <p className="text-xs text-[#9CA3AF] uppercase tracking-wide">Product</p>
              <p className="font-medium text-[#1F1D1B]">{order.productName}</p>
              <p className="text-xs text-[#6B7280] doc-number">{order.productCode}</p>
            </div>
            <div>
              <p className="text-xs text-[#9CA3AF] uppercase tracking-wide">Category</p>
              <p className="font-medium text-[#1F1D1B]">{order.itemCategory}</p>
            </div>
            <div>
              <p className="text-xs text-[#9CA3AF] uppercase tracking-wide">Size</p>
              <p className="font-medium text-[#1F1D1B]">{order.sizeLabel}</p>
              <p className="text-xs text-[#6B7280]">{order.sizeCode}</p>
            </div>
            <div>
              <p className="text-xs text-[#9CA3AF] uppercase tracking-wide">Fabric</p>
              <p className="font-medium text-[#1F1D1B]">{order.fabricCode}</p>
            </div>
            <div>
              <p className="text-xs text-[#9CA3AF] uppercase tracking-wide">Quantity</p>
              <p className="font-medium text-[#1F1D1B]">{order.quantity}</p>
            </div>
            <div>
              <p className="text-xs text-[#9CA3AF] uppercase tracking-wide">Dates</p>
              <p className="text-xs text-[#4B5563]">Start: {formatDate(order.startDate)}</p>
              <p className="text-xs text-[#4B5563]">Target: {formatDate(order.targetEndDate)}</p>
              {order.completedDate && (
                <p className="text-xs text-[#4F7C3A]">Done: {formatDate(order.completedDate)}</p>
              )}
            </div>
          </div>

          {/* Customization details */}
          {(order.gapInches || order.divanHeightInches || order.legHeightInches || order.specialOrder || order.notes) && (
            <div className="mt-4 pt-4 border-t border-[#E2DDD8]">
              <p className="text-xs text-[#9CA3AF] uppercase tracking-wide mb-2">Customizations</p>
              <div className="flex flex-wrap gap-3">
                {order.gapInches !== null && (
                  <span className="inline-flex items-center rounded-md bg-[#F0ECE9] px-2.5 py-1 text-xs font-medium text-[#4B5563]">
                    Gap: {order.gapInches}&quot;
                  </span>
                )}
                {order.divanHeightInches !== null && (
                  <span className="inline-flex items-center rounded-md bg-[#F0ECE9] px-2.5 py-1 text-xs font-medium text-[#4B5563]">
                    Divan Height: {order.divanHeightInches}&quot;
                  </span>
                )}
                {order.legHeightInches !== null && (
                  <span className="inline-flex items-center rounded-md bg-[#F0ECE9] px-2.5 py-1 text-xs font-medium text-[#4B5563]">
                    Leg Height: {order.legHeightInches}&quot;
                  </span>
                )}
                {order.specialOrder && (
                  <span className="inline-flex items-center rounded-md bg-[#FAEFCB] px-2.5 py-1 text-xs font-medium text-[#9C6F1E] border border-[#E8D597]">
                    Special: {order.specialOrder}
                  </span>
                )}
              </div>
              {order.notes && (
                <p className="mt-2 text-sm text-[#6B7280]">{order.notes}</p>
              )}
            </div>
          )}

          {/* Racking info */}
          {order.rackingNumber && (
            <div className="mt-4 pt-4 border-t border-[#E2DDD8]">
              <div className="flex gap-4">
                <div>
                  <p className="text-xs text-[#9CA3AF] uppercase tracking-wide">Racking No</p>
                  <p className="font-medium text-[#1F1D1B]">{order.rackingNumber}</p>
                </div>
                <div>
                  <p className="text-xs text-[#9CA3AF] uppercase tracking-wide">Stocked In</p>
                  <Badge variant={order.stockedIn ? "status" : "default"} status={order.stockedIn ? "COMPLETED" : undefined}>
                    {order.stockedIn ? "Yes" : "No"}
                  </Badge>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Department Pipeline */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <ChevronRight className="h-5 w-5 text-[#6B5C32]" />
            Department Pipeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* Visual pipeline connector */}
          <div className="hidden md:flex items-center justify-between mb-6 px-4">
            {sortedJobCards.map((jc, i) => (
              <div key={jc.id} className="flex items-center flex-1">
                <div className="flex flex-col items-center">
                  <StatusIcon status={jc.status} />
                  <p className="text-[10px] text-[#6B7280] mt-1 text-center whitespace-nowrap">
                    {jc.departmentName}
                  </p>
                </div>
                {i < sortedJobCards.length - 1 && (
                  <div
                    className="flex-1 h-0.5 mx-2 mt-[-12px]"
                    style={{
                      backgroundColor:
                        jc.status === "COMPLETED" || jc.status === "TRANSFERRED"
                          ? "#10B981"
                          : "#E2DDD8",
                    }}
                  />
                )}
              </div>
            ))}
          </div>

          {/* Department Cards */}
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
            {sortedJobCards.map((jc) => {
              const color = DEPT_COLORS[jc.departmentCode] || "#6B7280";
              const isActive = jc.status === "IN_PROGRESS";
              const isCompleted = jc.status === "COMPLETED" || jc.status === "TRANSFERRED";
              const isBlocked = jc.status === "BLOCKED";
              const isWaiting = jc.status === "WAITING";

              return (
                <Card
                  key={jc.id}
                  className={`relative overflow-hidden ${
                    isActive ? "ring-2 ring-blue-400" :
                    isBlocked ? "ring-2 ring-red-400" : ""
                  }`}
                >
                  {/* Top color bar */}
                  <div className="h-1.5" style={{ backgroundColor: color }} />

                  <CardContent className="p-4 space-y-3">
                    {/* Department name and status */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <StatusIcon status={jc.status} />
                        <span className="font-semibold text-[#1F1D1B] text-sm">{jc.departmentName}</span>
                      </div>
                      <Badge variant="status" status={jc.status} />
                    </div>

                    {/* Workers */}
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 text-xs">
                        <User className="h-3 w-3 text-[#9CA3AF]" />
                        <span className="text-[#6B7280]">PIC 1:</span>
                        <span className="text-[#4B5563] font-medium">{jc.pic1Name || "-"}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs">
                        <User className="h-3 w-3 text-[#9CA3AF]" />
                        <span className="text-[#6B7280]">PIC 2:</span>
                        <span className="text-[#4B5563] font-medium">{jc.pic2Name || "-"}</span>
                      </div>
                    </div>

                    {/* Time info */}
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <p className="text-[#9CA3AF]">Estimated</p>
                        <p className="font-medium text-[#4B5563]">{formatMinutes(jc.estMinutes)}</p>
                      </div>
                      <div>
                        <p className="text-[#9CA3AF]">Actual</p>
                        <p className="font-medium text-[#4B5563]">{formatMinutes(jc.actualMinutes)}</p>
                      </div>
                      <div>
                        <p className="text-[#9CA3AF]">Category</p>
                        <p className="font-medium text-[#4B5563]">{jc.category || "-"}</p>
                      </div>
                      <div>
                        <p className="text-[#9CA3AF]">Due</p>
                        <p className="font-medium text-[#4B5563]">{jc.dueDate ? formatDate(jc.dueDate) : "-"}</p>
                      </div>
                    </div>

                    {/* Completion date */}
                    {jc.completedDate && (
                      <div className="text-xs">
                        <span className="text-[#4F7C3A]">Completed: {formatDate(jc.completedDate)}</span>
                      </div>
                    )}

                    {/* Overdue warning */}
                    {jc.overdue && jc.overdue !== "0" && !isCompleted && (
                      <div className="flex items-center gap-1 text-xs text-[#9A3A2D]">
                        <AlertTriangle className="h-3 w-3" />
                        <span>Overdue: {jc.overdue}</span>
                      </div>
                    )}

                    {/* Blocked warning */}
                    {isBlocked && !jc.prerequisiteMet && (
                      <div className="flex items-center gap-1 text-xs text-[#9A3A2D] bg-[#F9E1DA] rounded px-2 py-1">
                        <AlertTriangle className="h-3 w-3" />
                        <span>Prerequisite not met</span>
                      </div>
                    )}

                    {/* Action Buttons */}
                    {!isCompleted && (
                      <div className="flex gap-2 pt-1">
                        {isWaiting && jc.prerequisiteMet && (
                          <Button
                            variant="primary"
                            size="sm"
                            className="flex-1 gap-1"
                            disabled={updating === jc.id}
                            onClick={() => updateJobCard(jc.id, "IN_PROGRESS")}
                          >
                            <Play className="h-3 w-3" />
                            Start
                          </Button>
                        )}
                        {isActive && (
                          <Button
                            variant="primary"
                            size="sm"
                            className="flex-1 gap-1"
                            disabled={updating === jc.id}
                            onClick={() => updateJobCard(jc.id, "COMPLETED")}
                          >
                            <CheckCircle2 className="h-3 w-3" />
                            Complete
                          </Button>
                        )}
                        {jc.status === "PAUSED" && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1 gap-1"
                            disabled={updating === jc.id}
                            onClick={() => updateJobCard(jc.id, "IN_PROGRESS")}
                          >
                            <Play className="h-3 w-3" />
                            Resume
                          </Button>
                        )}
                        {isActive && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1"
                            disabled={updating === jc.id}
                            onClick={() => updateJobCard(jc.id, "PAUSED")}
                          >
                            <Square className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    )}

                    {/* View QR */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full gap-1 mt-1 text-[#6B7280]"
                      onClick={() => setQrJobCard(jc)}
                    >
                      <QrCode className="h-3 w-3" />
                      View QR
                    </Button>

                    {/* Print Job Card */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full gap-1 text-[#6B7280]"
                      onClick={() => generateJobCardPdf(order, jc.departmentCode)}
                    >
                      <FileText className="h-3 w-3" />
                      Print Job Card
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Job Card QR Modal — 50mm × 75mm sticker */}
      {qrJobCard && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 print:static print:bg-transparent print:p-0 print:block"
          onClick={() => setQrJobCard(null)}
        >
          <style>{`
            @media print {
              @page { size: 50mm 75mm; margin: 0; }
              body * { visibility: hidden !important; }
              #sticker-jobcard, #sticker-jobcard * { visibility: visible !important; }
              #sticker-jobcard {
                position: fixed !important;
                top: 0; left: 0;
                width: 50mm !important;
                height: 75mm !important;
                margin: 0 !important;
                padding: 0 !important;
              }
            }
          `}</style>
          <div
            className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 relative print:hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="absolute top-3 right-3 h-8 w-8 rounded-full hover:bg-[#F0ECE9] flex items-center justify-center text-[#6B7280]"
              onClick={() => setQrJobCard(null)}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
            <p className="text-xs uppercase tracking-wide text-[#9CA3AF] text-center">Job Card Sticker (50 × 75 mm)</p>
            <p className="text-center text-sm text-[#4B5563] mb-3">{qrJobCard.departmentName}</p>

            {/* On-screen preview — scaled */}
            <div className="flex justify-center py-2">
              <div
                id="sticker-jobcard"
                style={{ width: "50mm", height: "75mm" }}
                className="bg-white border border-[#D1CBC5] flex flex-col items-center justify-between p-[2mm] text-black overflow-hidden print:border-0"
              >
                <img
                  src={getQRCodeUrl(
                    generateStickerData(
                      order.poNo,
                      qrJobCard.departmentCode,
                      qrJobCard.id,
                      "/production/scan"
                    ),
                    300
                  )}
                  alt="Job card QR"
                  style={{ width: "34mm", height: "34mm" }}
                />
                <div
                  className="font-bold text-center leading-tight w-full"
                  style={{ fontSize: "9pt" }}
                >
                  {wipNameFor(qrJobCard, order)}
                </div>
                <div className="text-center leading-tight w-full" style={{ fontSize: "7pt" }}>
                  <div className="font-semibold">{order.poNo}</div>
                  <div>
                    {qrJobCard.departmentCode} · {order.sizeLabel || order.sizeCode} · Qty {order.quantity}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 gap-1"
                onClick={() => setQrJobCard(null)}
              >
                Close
              </Button>
              <Button
                variant="primary"
                size="sm"
                className="flex-1 gap-1"
                onClick={() => window.print()}
              >
                <Printer className="h-3 w-3" />
                Print 50×75
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* FG Packing Sticker Modal — 100mm × 150mm PER UNIT × PER PIECE */}
      {fgSticker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 print:static print:bg-transparent print:p-0 print:block"
          onClick={() => setFgSticker(false)}
        >
          <style>{`
            @media print {
              @page { size: 100mm 150mm; margin: 0; }
              body > *:not(#detail-fg-print) { display: none !important; }
              #detail-fg-print { display: block !important; }
              .sticker-fg-page {
                width: 100mm !important; height: 150mm !important;
                page-break-after: always;
                break-after: page;
                margin: 0 !important; padding: 4mm !important;
                overflow: hidden;
              }
              .sticker-fg-page:last-child {
                page-break-after: auto;
                break-after: auto;
              }
            }
          `}</style>
          <div
            className="bg-white rounded-2xl shadow-xl max-w-2xl w-full p-6 relative print:hidden max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="absolute top-3 right-3 h-8 w-8 rounded-full hover:bg-[#F0ECE9] flex items-center justify-center text-[#6B7280]"
              onClick={() => setFgSticker(false)}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
            <p className="text-xs uppercase tracking-wide text-[#9CA3AF] text-center">FG Packing Stickers (100 × 150 mm each)</p>
            <p className="text-center text-sm text-[#4B5563] mb-1">{order.productName}</p>
            <p className="text-center text-xs text-[#9CA3AF] mb-3">
              PO {order.poNo} · Qty {order.quantity}
              {productExt?.pieces ? ` · ${productExt.pieces.count} pieces/set` : ""}
              {fgUnitList.length > 0 ? ` → ${fgUnitList.length} stickers` : ""}
            </p>

            {fgUnitList.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-3">
                <p className="text-sm text-[#6B7280] text-center max-w-sm">
                  No FG units generated yet. Each physical box will get its own unique
                  sticker with its own QR and serial number.
                </p>
                <Button
                  variant="primary"
                  onClick={handleGenerateUnits}
                  disabled={fgLoading}
                >
                  {fgLoading ? "Generating..." : "Generate Units"}
                </Button>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto border border-[#E2DDD8] rounded-lg p-3 space-y-4 bg-[#FAF8F6]">
                {fgUnitList.map((u) => (
                  <FGUnitStickerPreview
                    key={u.id}
                    unit={u}
                    order={order}
                    productExt={productExt}
                  />
                ))}
              </div>
            )}

            <div className="flex gap-2 pt-3">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 gap-1"
                onClick={() => setFgSticker(false)}
              >
                Close
              </Button>
              <Button
                variant="primary"
                size="sm"
                className="flex-1 gap-1"
                onClick={() => window.print()}
                disabled={fgUnitList.length === 0}
              >
                <Printer className="h-3 w-3" />
                Print All ({fgUnitList.length})
              </Button>
            </div>
          </div>

          {/* Print-only container — renders one 100×150mm page per unit */}
          <div id="detail-fg-print" className="hidden print:block">
            {fgUnitList.map((u) => (
              <FGUnitStickerPage
                key={u.id}
                unit={u}
                order={order}
                productExt={productExt}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// FG Unit sticker rendering (per unit × per piece)
// Layout matches the physical packing sticker:
//   SKU code (bold top)
//   ─────────
//   SIZE / COLOR / PO NO / CUSTOMER / MFD
//   QR   +   "X of N" and short code
// Each sticker's QR encodes {origin}/track?s={unitSerial}.
// ---------------------------------------------------------------
type FGUnitForSticker = {
  id: string;
  unitSerial: string;
  shortCode: string;
  poNo: string;
  productCode: string;
  productName: string;
  unitNo: number;
  totalUnits: number;
  pieceNo: number;
  totalPieces: number;
  pieceName: string;
  customerName: string;
  customerHub?: string;
  mfdDate: string | null;
};
type OrderForSticker = {
  poNo: string;
  sizeLabel: string;
  sizeCode: string;
  fabricCode: string;
  customerName: string;
  customerState: string;
  productName: string;
  productCode: string;
};
type ProductExtForSticker = {
  skuCode?: string;
  sizeCode?: string;
  fabricColor?: string;
} | null;

function fmtMfd(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function buildTrackUrl(unitSerial: string): string {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "";
  return `${origin}/track?s=${encodeURIComponent(unitSerial)}`;
}

function FGStickerBody({
  unit,
  order,
  productExt,
}: {
  unit: FGUnitForSticker;
  order: OrderForSticker;
  productExt: ProductExtForSticker;
}) {
  const sku = productExt?.skuCode || order.productCode;
  const size = productExt?.sizeCode || order.sizeLabel || order.sizeCode;
  const color = productExt?.fabricColor || order.fabricCode || "-";
  const customerLine = unit.customerHub
    ? `${unit.customerName} (${unit.customerHub})`
    : unit.customerName || order.customerName;
  return (
    <div className="w-full h-full flex flex-col text-black" style={{ fontSize: "9pt" }}>
      <div className="text-center font-bold" style={{ fontSize: "13pt", lineHeight: 1.1 }}>
        {sku}
      </div>
      <div className="border-t border-black my-[1.5mm]" />
      <div className="flex-1 space-y-[0.6mm]" style={{ fontSize: "9pt", lineHeight: 1.25 }}>
        <div><span className="inline-block w-[22mm] font-semibold">SIZE</span>: {size}</div>
        <div><span className="inline-block w-[22mm] font-semibold">COLOR</span>: {color}</div>
        <div><span className="inline-block w-[22mm] font-semibold">PO NO</span>: {unit.poNo}</div>
        <div><span className="inline-block w-[22mm] font-semibold">CUSTOMER</span>: {customerLine}</div>
        <div><span className="inline-block w-[22mm] font-semibold">MFD</span>: {fmtMfd(unit.mfdDate)}</div>
      </div>
      <div className="flex items-end gap-[2mm] mt-[1mm]">
        <img
          src={getQRCodeUrl(buildTrackUrl(unit.unitSerial), 500)}
          alt="FG unit QR"
          style={{ width: "42mm", height: "42mm" }}
        />
        <div className="flex-1 text-center" style={{ fontSize: "10pt" }}>
          <div className="font-bold" style={{ fontSize: "14pt" }}>
            {unit.pieceNo} of {unit.totalPieces}
          </div>
          <div className="text-[8pt] mt-[1mm]">{unit.pieceName}</div>
          <div className="font-semibold mt-[2mm]" style={{ fontSize: "11pt" }}>
            {unit.shortCode}
          </div>
          <div className="text-[7pt] text-[#4B5563] mt-[1mm]">
            Unit {unit.unitNo}/{unit.totalUnits}
          </div>
        </div>
      </div>
    </div>
  );
}

function FGUnitStickerPreview({
  unit,
  order,
  productExt,
}: {
  unit: FGUnitForSticker;
  order: OrderForSticker;
  productExt: ProductExtForSticker;
}) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="bg-white border border-[#D1CBC5] flex-shrink-0"
        style={{ width: "100mm", height: "150mm", padding: "4mm" }}
      >
        <FGStickerBody unit={unit} order={order} productExt={productExt} />
      </div>
      <div className="flex-1 text-xs text-[#4B5563] space-y-1">
        <div className="font-semibold text-[#1F1D1B]">Unit {unit.unitNo}/{unit.totalUnits} · Piece {unit.pieceNo}/{unit.totalPieces}</div>
        <div>{unit.pieceName}</div>
        <div className="text-[#9CA3AF] break-all doc-number">{unit.unitSerial}</div>
        <div className="text-[#9CA3AF]">Code: {unit.shortCode}</div>
      </div>
    </div>
  );
}

function FGUnitStickerPage({
  unit,
  order,
  productExt,
}: {
  unit: FGUnitForSticker;
  order: OrderForSticker;
  productExt: ProductExtForSticker;
}) {
  return (
    <div
      className="sticker-fg-page bg-white text-black"
      style={{ width: "100mm", height: "150mm" }}
    >
      <FGStickerBody unit={unit} order={order} productExt={productExt} />
    </div>
  );
}
