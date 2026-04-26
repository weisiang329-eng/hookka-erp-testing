import { useState, useEffect, useCallback, Suspense } from "react";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Camera, Search, CheckCircle2, AlertTriangle, ArrowLeft, User } from "lucide-react";
import { Link } from "react-router-dom";
import { useSearchParams } from "react-router-dom";
import { parseStickerData } from "@/lib/qr-utils";
import { fetchJson } from "@/lib/fetch-json";

const WorkerListSchema = z.object({
  success: z.boolean(),
  data: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
}).passthrough();
const ProductionOrderListSchema = z.object({
  success: z.boolean(),
  data: z.array(z.unknown()),
}).passthrough();
const ScanCompleteSchema = z.object({
  success: z.boolean(),
  data: z.object({
    assignedSlot: z.union([z.literal(1), z.literal(2)]).optional(),
    workerName: z.string().optional(),
    jobCard: z.unknown().optional(),
  }).passthrough().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
}).passthrough();

type JobCard = {
  id: string;
  departmentCode: string;
  departmentName: string;
  status: "WAITING" | "IN_PROGRESS" | "PAUSED" | "COMPLETED" | "TRANSFERRED" | "BLOCKED";
  dueDate: string;
  pic1Id: string | null;
  pic1Name: string;
  pic2Id: string | null;
  pic2Name: string;
  completedDate: string | null;
  estMinutes: number;
  actualMinutes: number | null;
  category: string;
  productionTimeMinutes: number;
  overdue: string;
};

type ProductionOrder = {
  id: string;
  poNo: string;
  companySOId: string;
  customerName: string;
  customerState: string;
  customerPOId: string;
  productCode: string;
  productName: string;
  itemCategory: string;
  sizeCode: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  specialOrder: string;
  notes: string;
  jobCards: JobCard[];
};

type WorkerOption = {
  id: string;
  name: string;
  empNo?: string;
  departmentCode?: string;
};

export default function ScannerPageWrapper() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64 text-[#9CA3AF]">Loading scanner...</div>}>
      <ScannerPage />
    </Suspense>
  );
}

function ScannerPage() {
  const [searchParams] = useSearchParams();
  const [manualInput, setManualInput] = useState("");
  const [lookupResult, setLookupResult] = useState<{
    order: ProductionOrder;
    jobCard: JobCard;
  } | null>(null);
  const [lookupError, setLookupError] = useState("");
  const [loading, setLoading] = useState(false);

  const [workers, setWorkers] = useState<WorkerOption[]>([]);
  const [selectedWorkerId, setSelectedWorkerId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<
    | { kind: "success"; slot: 1 | 2; workerName: string }
    | { kind: "error"; message: string }
    | null
  >(null);
  // pieceNo from the scanned sticker URL. Defaults to 1 (legacy single-piece
  // behaviour) when the QR didn't encode &p=<n> — the server treats missing
  // pieceNo as 1 too, so this matches backend semantics.
  const [scannedPieceNo, setScannedPieceNo] = useState<number>(1);

  // Fetch worker list once
  useEffect(() => {
    fetchJson("/api/workers", WorkerListSchema)
      .then((d) => {
        if (d.success) setWorkers(d.data);
      })
      .catch(() => {
        // non-fatal — the dropdown just stays empty
      });
  }, []);

  const doLookup = useCallback(async (query?: string, fgSentinel?: string) => {
    const searchTerm = (query || manualInput).trim();
    if (!searchTerm) return;

    setLoading(true);
    setLookupError("");
    setLookupResult(null);
    setSubmitResult(null);
    setSelectedWorkerId("");

    try {
      const data = await fetchJson("/api/production-orders", ProductionOrderListSchema);
      if (!data.success) {
        setLookupError("Failed to fetch production orders.");
        setLoading(false);
        return;
      }

      const orders: ProductionOrder[] = data.data as ProductionOrder[];
      let found: { order: ProductionOrder; jobCard: JobCard } | null = null;

      // Merged FG-level scan (e.g. FAB_CUT plan-B sticker). The sentinel
      // id isn't a real job card; find the PO by poNo and synthesize a
      // display job card that carries the sentinel id so the submit
      // handler routes to scan-complete-dept.
      if (fgSentinel) {
        const deptCode = fgSentinel.replace(/^FG-/, "");
        for (const order of orders) {
          if (order.poNo.toLowerCase() === searchTerm.toLowerCase()) {
            const anyDeptJc = order.jobCards.find((j) => j.departmentCode === deptCode);
            if (anyDeptJc) {
              found = {
                order,
                jobCard: { ...anyDeptJc, id: fgSentinel },
              };
            }
            break;
          }
        }
      }

      // Search by job card ID first
      if (!found) {
        for (const order of orders) {
          const jc = order.jobCards.find((j) => j.id === searchTerm);
          if (jc) {
            found = { order, jobCard: jc };
            break;
          }
        }
      }

      // Search by PO number if not found
      if (!found) {
        for (const order of orders) {
          if (order.poNo.toLowerCase() === searchTerm.toLowerCase() || order.id === searchTerm) {
            const jc =
              order.jobCards.find(
                (j) => j.status === "IN_PROGRESS" || j.status === "WAITING"
              ) || order.jobCards[0];
            if (jc) {
              found = { order, jobCard: jc };
              break;
            }
          }
        }
      }

      if (found) {
        setLookupResult(found);
      } else {
        setLookupError(`No operation found for "${searchTerm}". Try a PO number or job card ID.`);
      }
    } catch {
      setLookupError("Network error. Please try again.");
    }
    setLoading(false);
  }, [manualInput]);

  // Check URL params on mount.
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot hydrate from QR sticker URL on mount */
  useEffect(() => {
    // Parse the full scan URL via parseStickerData so we share the same
    // decoding logic as the worker portal. We reconstruct the URL from
    // window.location because the SPA has consumed it into searchParams
    // and parseStickerData expects a URL string.
    const fullUrl =
      typeof window !== "undefined"
        ? `${window.location.origin}${window.location.pathname}${window.location.search}`
        : "";
    const parsed = fullUrl ? parseStickerData(fullUrl) : null;
    if (parsed?.pieceNo && parsed.pieceNo >= 1) {
      setScannedPieceNo(parsed.pieceNo);
    }
    const opId = parsed?.opId || searchParams.get("op");
    const poNoFromQr = parsed?.poNo || searchParams.get("po");
    if (opId) {
      setManualInput(opId);
      // Merged FG-level sticker (e.g. "FG-FAB_CUT") — lookup can't find a
      // job card with that synthetic id, so search by PO number instead
      // and keep the sentinel id on the jobCard so handleCompleteScan
      // knows to hit the fan-out endpoint.
      if (/^FG-[A-Z_]+$/.test(opId) && poNoFromQr) {
        doLookup(poNoFromQr, opId);
      } else {
        doLookup(opId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleCompleteScan = async () => {
    if (!lookupResult || !selectedWorkerId) return;
    setSubmitting(true);
    try {
      // FG-level merged sticker path (today: FAB_CUT). The opId that came
      // off the QR is the sentinel "FG-<DEPT>" — route to the fan-out
      // endpoint which flips every matching dept job card on the PO in
      // one request, instead of the per-jc scan-complete which only
      // touches one card and leaves the others pending.
      const fgMatch = /^FG-([A-Z_]+)$/.exec(lookupResult.jobCard.id);
      const endpoint = fgMatch
        ? `/api/production-orders/${lookupResult.order.id}/scan-complete-dept`
        : `/api/production-orders/${lookupResult.order.id}/scan-complete`;
      const payload = fgMatch
        ? { deptCode: fgMatch[1], workerId: selectedWorkerId }
        : {
            jobCardId: lookupResult.jobCard.id,
            workerId: selectedWorkerId,
            // Forward the per-piece number the QR sticker carried. Without
            // this, a multi-piece job card (qty=N) would always increment
            // piece 1 no matter which sticker the operator scanned — the
            // backend's sticker-binding + FIFO logic rely on pieceNo to
            // route the scan to the right piece_pics slot.
            pieceNo: scannedPieceNo,
          };
      const data = await fetchJson(endpoint, ScanCompleteSchema, {
        method: "POST",
        body: payload,
      });
      if (data.success && data.data) {
        setSubmitResult({
          kind: "success",
          slot: data.data.assignedSlot ?? 1,
          workerName: data.data.workerName ?? "",
        });
        // Reflect updated PIC state in the card
        setLookupResult({
          order: lookupResult.order,
          jobCard: data.data.jobCard as JobCard,
        });
      } else {
        let msg = data.error || "Failed to record scan.";
        if (data.error === "Max 2 PICs already recorded for this job card") {
          msg = "This QR has already been scanned by 2 workers. No more scans allowed.";
        } else if (data.code === "ALREADY_PIC1") {
          msg = "You are already PIC1 on this job card. A second scan must come from a different worker.";
        } else if (data.code === "ALREADY_PIC2") {
          msg = "You are already PIC2 on this job card. No further action needed.";
        } else if (data.code === "DEBOUNCE") {
          msg = "This QR was just scanned. Please wait a moment before scanning again.";
        }
        setSubmitResult({ kind: "error", message: msg });
        // Refresh the card view if the server returned updated state
        if (data.data?.jobCard) {
          setLookupResult({ order: lookupResult.order, jobCard: data.data.jobCard as JobCard });
        }
      }
    } catch {
      setSubmitResult({ kind: "error", message: "Network error. Please try again." });
    }
    setSubmitting(false);
  };

  const handleReset = () => {
    setLookupResult(null);
    setLookupError("");
    setManualInput("");
    setSelectedWorkerId("");
    setSubmitResult(null);
  };

  const jc = lookupResult?.jobCard;
  const bothFilled = jc ? Boolean(jc.pic1Id) && Boolean(jc.pic2Id) : false;
  const scanLocked = submitResult?.kind === "success" || bothFilled;

  return (
    <div className="max-w-lg mx-auto space-y-4 pb-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to="/production">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Production Scanner</h1>
          <p className="text-xs text-[#6B7280]">Scan QR code or enter ID manually</p>
        </div>
      </div>

      {/* Camera Scan Area */}
      {!lookupResult && (
        <Card>
          <CardContent className="p-6">
            <div className="flex flex-col items-center justify-center py-8 border-2 border-dashed border-[#E2DDD8] rounded-xl bg-[#FAF9F7]">
              <div className="h-16 w-16 rounded-full bg-[#F0ECE9] flex items-center justify-center mb-4">
                <Camera className="h-8 w-8 text-[#6B5C32]" />
              </div>
              <p className="text-base font-semibold text-[#1F1D1B] mb-1">Scan QR Code</p>
              <p className="text-xs text-[#9CA3AF] text-center max-w-[240px]">
                Point your device camera at the sticker QR code. Camera scanning requires additional library setup.
              </p>
            </div>

            {/* Manual Entry */}
            <div className="mt-6 space-y-3">
              <p className="text-sm font-medium text-[#374151]">Manual Entry</p>
              <div className="flex gap-2">
                <Input
                  placeholder="Enter PO number or Job Card ID"
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && doLookup()}
                  className="flex-1 h-12 text-base"
                />
                <Button
                  variant="primary"
                  className="h-12 px-5"
                  onClick={() => doLookup()}
                  disabled={loading || !manualInput.trim()}
                >
                  {loading ? (
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  ) : (
                    <Search className="h-5 w-5" />
                  )}
                </Button>
              </div>
            </div>

            {lookupError && (
              <div className="mt-4 p-3 bg-[#F9E1DA] border border-[#E8B2A1] rounded-lg text-sm text-[#9A3A2D]">
                {lookupError}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Result Card */}
      {lookupResult && jc && (
        <>
          {/* Product Details */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Product Details</CardTitle>
                <Button variant="ghost" size="sm" onClick={handleReset} className="text-xs">
                  Scan Another
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-[#9CA3AF] text-xs">SO Number</span>
                  <p className="font-bold text-[#6B5C32]">{lookupResult.order.companySOId}</p>
                </div>
                <div>
                  <span className="text-[#9CA3AF] text-xs">PO Number</span>
                  <p className="font-bold text-[#1F1D1B]">{lookupResult.order.poNo}</p>
                </div>
                <div>
                  <span className="text-[#9CA3AF] text-xs">Customer</span>
                  <p className="font-medium text-[#1F1D1B]">{lookupResult.order.customerName}</p>
                </div>
                <div>
                  <span className="text-[#9CA3AF] text-xs">Product</span>
                  <p className="font-medium text-[#1F1D1B]">{lookupResult.order.productCode}</p>
                </div>
                <div>
                  <span className="text-[#9CA3AF] text-xs">Size</span>
                  <p className="text-[#4B5563]">{lookupResult.order.sizeLabel}</p>
                </div>
                <div>
                  <span className="text-[#9CA3AF] text-xs">Colour</span>
                  <p className="text-[#4B5563]">{lookupResult.order.fabricCode}</p>
                </div>
              </div>

              {/* Department & Status */}
              <div className="flex items-center gap-2 pt-2 border-t border-[#E2DDD8]">
                <span className="text-xs text-[#9CA3AF]">Department:</span>
                <span className="text-xs font-medium px-2 py-0.5 rounded border border-[#E2DDD8] bg-[#FAF9F7] text-[#1F1D1B]">
                  {jc.departmentName}
                </span>
                <span className="text-xs text-[#9CA3AF] ml-auto">Status:</span>
                <Badge variant="status" status={jc.status} />
              </div>

              {/* Current PIC status */}
              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-[#E2DDD8] text-xs">
                <div>
                  <span className="text-[#9CA3AF]">PIC 1</span>
                  <p className="font-medium text-[#1F1D1B]">{jc.pic1Name || "-"}</p>
                </div>
                <div>
                  <span className="text-[#9CA3AF]">PIC 2</span>
                  <p className="font-medium text-[#1F1D1B]">{jc.pic2Name || "-"}</p>
                </div>
              </div>
              {jc.completedDate && (
                <p className="text-xs text-[#4F7C3A]">Completed: {jc.completedDate}</p>
              )}
            </CardContent>
          </Card>

          {/* Already-full warning */}
          {bothFilled && submitResult?.kind !== "success" && (
            <div className="p-4 bg-[#F9E1DA] border border-[#E8B2A1] rounded-xl text-sm text-[#9A3A2D] flex items-start gap-2">
              <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">No more scans allowed</p>
                <p className="mt-1 text-[#9A3A2D]">
                  This QR has already been scanned by 2 workers. No more scans allowed.
                </p>
              </div>
            </div>
          )}

          {/* Worker Selector + Complete button */}
          {!scanLocked && (
            <>
              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-[#F0ECE9] flex items-center justify-center shrink-0">
                      <User className="h-5 w-5 text-[#6B5C32]" />
                    </div>
                    <select
                      value={selectedWorkerId}
                      onChange={(e) => setSelectedWorkerId(e.target.value)}
                      className="flex-1 h-10 px-3 rounded-md border border-[#E2DDD8] bg-white text-base text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                    >
                      <option value="">Select worker...</option>
                      {workers.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                          {w.empNo ? ` (${w.empNo})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </CardContent>
              </Card>

              <Button
                className="w-full h-16 text-lg font-bold bg-[#4F7C3A] hover:bg-[#4F7C3A] text-white rounded-xl shadow-lg"
                onClick={handleCompleteScan}
                disabled={!selectedWorkerId || submitting}
              >
                <CheckCircle2 className="h-6 w-6 mr-3" />
                {submitting ? "Recording..." : "COMPLETE"}
              </Button>
            </>
          )}

          {submitResult?.kind === "error" && (
            <div className="p-4 bg-[#F9E1DA] border border-[#E8B2A1] rounded-xl text-sm text-[#9A3A2D] flex items-start gap-2">
              <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
              <p>{submitResult.message}</p>
            </div>
          )}

          {submitResult?.kind === "success" && (
            <div className="space-y-3">
              <div className="p-4 bg-[#EEF3E4] border border-[#C6DBA8] rounded-xl text-center">
                <CheckCircle2 className="h-8 w-8 text-[#4F7C3A] mx-auto mb-2" />
                <p className="font-bold text-[#4F7C3A]">
                  Recorded as PIC {submitResult.slot} - {submitResult.workerName}
                </p>
                <p className="text-sm text-[#4F7C3A] mt-1">Job card marked complete.</p>
              </div>
              <Button
                variant="outline"
                className="w-full h-12 text-base rounded-xl"
                onClick={handleReset}
              >
                <Camera className="h-5 w-5 mr-2" />
                Scan another QR
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
