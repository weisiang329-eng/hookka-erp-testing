// Public FG unit tracking page — opened by customers scanning the QR sticker.
// Intentionally standalone (no dashboard/portal chrome), mobile-first, no auth.

import { useEffect, useState } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { useSearchParams } from "react-router-dom";
import { CheckCircle2, Circle, Package, AlertTriangle } from "lucide-react";

type FGUnitStatus = "PENDING" | "PACKED" | "LOADED" | "DELIVERED" | "RETURNED";

interface FGUnit {
  id: string;
  unitSerial: string;
  shortCode: string;
  soId: string;
  soNo: string;
  soLineNo: number;
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
  status: FGUnitStatus;
  packerId?: string;
  packerName?: string;
  packedAt?: string;
  loadedAt?: string;
  deliveredAt?: string;
  returnedAt?: string;
}

const STATUS_COLORS: Record<FGUnitStatus, { bg: string; text: string; label: string }> = {
  PENDING:   { bg: "bg-gray-200",   text: "text-gray-800",   label: "Pending" },
  PACKED:    { bg: "bg-[#3E6570]",   text: "text-white",      label: "Packed" },
  LOADED:    { bg: "bg-[#9C6F1E]",  text: "text-white",      label: "Loaded" },
  DELIVERED: { bg: "bg-[#4F7C3A]",  text: "text-white",      label: "Delivered" },
  RETURNED:  { bg: "bg-[#9A3A2D]",    text: "text-white",      label: "Returned" },
};

function formatWhen(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function TimelineRow({
  title,
  subtitle,
  when,
  completed,
  isLast,
  highlight,
}: {
  title: string;
  subtitle?: string;
  when?: string;
  completed: boolean;
  isLast?: boolean;
  highlight?: "normal" | "danger";
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        {completed ? (
          <div className={`h-8 w-8 rounded-full flex items-center justify-center ${highlight === "danger" ? "bg-[#9A3A2D]" : "bg-[#4F7C3A]"}`}>
            <CheckCircle2 className="h-5 w-5 text-white" strokeWidth={2.5} />
          </div>
        ) : (
          <div className="h-8 w-8 rounded-full border-2 border-dashed border-gray-300 flex items-center justify-center">
            <Circle className="h-3 w-3 text-gray-300" />
          </div>
        )}
        {!isLast && (
          <div className={`w-0.5 flex-1 min-h-[28px] ${completed ? "bg-[#4F7C3A]" : "border-l-2 border-dashed border-gray-300"}`} />
        )}
      </div>
      <div className="flex-1 pb-6">
        <p className={`text-base font-semibold ${completed ? "text-[#1F1D1B]" : "text-gray-400"}`}>{title}</p>
        {when && <p className="text-xs text-gray-500 mt-0.5">{formatWhen(when)}</p>}
        {subtitle && <p className="text-sm text-gray-600 mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

export default function TrackPage() {
  const [params] = useSearchParams();
  const serial = params.get("s") || "";
  const [unit, setUnit] = useState<FGUnit | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trackUrl = serial.trim() ? `/api/fg-units?serial=${encodeURIComponent(serial.trim())}` : null;
  const { data: d, loading: fetchLoading, error: fetchError } = useCachedJson<{ success?: boolean; data?: FGUnit[] }>(trackUrl);
  const loading = trackUrl ? fetchLoading : false;

  useEffect(() => {
    if (!serial.trim()) {
      setError("No serial number provided.");
      return;
    }
    setError(null);
    if (d) {
      if (d.success && Array.isArray(d.data) && d.data.length > 0) {
        setUnit(d.data[0] as FGUnit);
      } else {
        setError("Unit not found. Check the QR code or serial number.");
      }
    } else if (fetchError) {
      setError("Network error. Please try again.");
    }
  }, [serial, d, fetchError]);

  const status = unit?.status;
  const statusInfo = status ? STATUS_COLORS[status] : null;

  // Compute completion flags for timeline steps.
  const reached = (target: FGUnitStatus): boolean => {
    if (!status) return false;
    const order: FGUnitStatus[] = ["PENDING", "PACKED", "LOADED", "DELIVERED"];
    if (target === "RETURNED") return status === "RETURNED";
    const i = order.indexOf(target);
    const c = order.indexOf(status);
    return c >= i && c >= 0 && i >= 0;
  };

  return (
    <div className="min-h-screen bg-[#F0ECE9]">
      {/* Header */}
      <header className="bg-[#1F1D1B] text-white">
        <div className="max-w-xl mx-auto px-4 py-5 flex items-center gap-3">
          <div className="h-9 w-9 rounded bg-[#6B5C32] flex items-center justify-center">
            <Package className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">Product Tracking</h1>
            <p className="text-xs text-gray-400">HOOKKA INDUSTRIES</p>
          </div>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-4 py-6 space-y-4">
        {loading && (
          <div className="rounded-xl bg-white p-8 text-center shadow-sm border border-[#E6E0D9]">
            <div className="h-8 w-8 mx-auto rounded-full border-4 border-[#6B5C32] border-t-transparent animate-spin" />
            <p className="mt-3 text-sm text-gray-500">Looking up unit...</p>
          </div>
        )}

        {!loading && error && (
          <div className="rounded-xl bg-white p-6 shadow-sm border border-[#E8B2A1]">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-[#9A3A2D] shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-[#9A3A2D]">Unit not found</p>
                <p className="text-sm text-[#9A3A2D] mt-1">{error}</p>
                {serial && (
                  <p className="text-xs text-gray-500 mt-2 font-mono break-all">Serial: {serial}</p>
                )}
              </div>
            </div>
          </div>
        )}

        {!loading && unit && statusInfo && (
          <>
            {/* Big status badge */}
            <div className={`rounded-xl ${statusInfo.bg} ${statusInfo.text} p-5 text-center shadow-sm`}>
              <p className="text-xs uppercase tracking-widest opacity-80">Current Status</p>
              <p className="text-3xl font-bold mt-1">{statusInfo.label}</p>
            </div>

            {/* Unit info block */}
            <div className="rounded-xl bg-white shadow-sm border border-[#E6E0D9] p-5 space-y-3">
              <div>
                <p className="text-xs uppercase tracking-widest text-gray-500">Product</p>
                <p className="text-base font-semibold text-[#1F1D1B]">{unit.productName}</p>
                <p className="text-xs font-mono text-gray-600 mt-0.5">{unit.productCode}</p>
              </div>
              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-[#E6E0D9]">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-gray-500">Customer</p>
                  <p className="text-sm font-medium text-[#1F1D1B]">{unit.customerName}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-gray-500">SO</p>
                  <p className="text-sm font-mono text-[#1F1D1B]">{unit.soNo}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-gray-500">PO</p>
                  <p className="text-sm font-mono text-[#1F1D1B]">{unit.poNo}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-gray-500">Unit / Piece</p>
                  <p className="text-sm font-medium text-[#1F1D1B]">
                    Unit {unit.unitNo} of {unit.totalUnits}, Piece {unit.pieceNo}/{unit.totalPieces}
                    {unit.pieceName && <span className="text-gray-500 ml-1">({unit.pieceName})</span>}
                  </p>
                </div>
              </div>
              <div className="pt-2 border-t border-[#E6E0D9] flex items-center justify-between text-xs">
                <span className="text-gray-500">Serial</span>
                <span className="font-mono text-[#1F1D1B] break-all">{unit.unitSerial}</span>
              </div>
            </div>

            {/* Timeline */}
            <div className="rounded-xl bg-white shadow-sm border border-[#E6E0D9] p-5">
              <p className="text-sm font-semibold text-[#1F1D1B] mb-4">Progress</p>
              <TimelineRow
                title="Order Created"
                subtitle={`Sales order ${unit.soNo}`}
                when={unit.mfdDate || undefined}
                completed
              />
              <TimelineRow
                title="Packed"
                subtitle={unit.packerName ? `By ${unit.packerName}` : undefined}
                when={unit.packedAt}
                completed={reached("PACKED")}
              />
              <TimelineRow
                title="Loaded on Truck"
                when={unit.loadedAt}
                completed={reached("LOADED")}
              />
              <TimelineRow
                title="Delivered"
                when={unit.deliveredAt}
                completed={reached("DELIVERED")}
                isLast={unit.status !== "RETURNED"}
              />
              {unit.status === "RETURNED" && (
                <TimelineRow
                  title="Returned"
                  when={unit.returnedAt}
                  completed
                  isLast
                  highlight="danger"
                />
              )}
            </div>

            <p className="text-[10px] text-center text-gray-400 py-2">
              Need help? Contact the HOOKKA team with the serial above.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
