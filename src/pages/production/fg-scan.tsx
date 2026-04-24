// FG Scan operations page — used by packers/drivers/warehouse to mark
// individual FG units as PACKED / LOADED / DELIVERED / RETURNED. Keyboard
// and handheld-scanner friendly: serial input autofocuses and Enter submits.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, CheckCircle2, AlertTriangle, ScanLine } from "lucide-react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";

type ScanAction = "PACK" | "LOAD" | "DELIVER" | "RETURN";

type FGUnit = {
  id: string;
  unitSerial: string;
  shortCode: string;
  soNo: string;
  poNo: string;
  productCode: string;
  productName: string;
  unitNo: number;
  totalUnits: number;
  pieceNo: number;
  totalPieces: number;
  pieceName: string;
  customerName: string;
  status: "PENDING" | "PACKED" | "LOADED" | "DELIVERED" | "RETURNED";
  packerName?: string;
};

type Worker = {
  id: string;
  name: string;
  empNo?: string;
  departmentCode?: string;
};

type RecentEntry = {
  serial: string;
  action: ScanAction;
  ok: boolean;
  message: string;
  at: string;
};

const RECENT_KEY = "hookka_fg_scan_recent";
const ACTIONS: { value: ScanAction; label: string; color: string }[] = [
  { value: "PACK",    label: "Pack",     color: "bg-[#3E6570]" },
  { value: "LOAD",    label: "Load",     color: "bg-[#9C6F1E]" },
  { value: "DELIVER", label: "Deliver",  color: "bg-[#4F7C3A]" },
  { value: "RETURN",  label: "Return",   color: "bg-[#9A3A2D]" },
];

const ACTION_PAST: Record<ScanAction, string> = {
  PACK:    "PACKED",
  LOAD:    "LOADED",
  DELIVER: "DELIVERED",
  RETURN:  "RETURNED",
};

function loadRecent(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.slice(0, 10);
  } catch {
    // ignore
  }
  return [];
}

function saveRecent(entries: RecentEntry[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(entries.slice(0, 10)));
  } catch {
    // ignore
  }
}

export default function FGScanPage() {
  const [params] = useSearchParams();
  const initialAction = (params.get("action") as ScanAction | null) || "PACK";
  const initialSerial = params.get("s") || "";

  const [action, setAction] = useState<ScanAction>(
    ACTIONS.some((a) => a.value === initialAction) ? initialAction : "PACK",
  );
  const [serial, setSerial] = useState(initialSerial);
  const { data: workersResp } = useCachedJson<{ success?: boolean; data?: Worker[] }>("/api/workers");
  const workers: Worker[] = useMemo(
    () => (workersResp?.success ? workersResp.data ?? [] : Array.isArray(workersResp) ? workersResp : []),
    [workersResp]
  );
  const [workerId, setWorkerId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { kind: "success"; unit: FGUnit; message: string }
    | { kind: "error"; message: string }
    | null
  >(null);
  const [recent, setRecent] = useState<RecentEntry[]>(loadRecent);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Autofocus serial field on mount and whenever mode changes / after submit.
  useEffect(() => {
    inputRef.current?.focus();
  }, [action]);

  const actionMeta = useMemo(() => ACTIONS.find((a) => a.value === action)!, [action]);

  const submitScan = async () => {
    const s = serial.trim();
    if (!s) return;
    if (action === "PACK" && !workerId) {
      setResult({ kind: "error", message: "Please select a worker before PACK scan." });
      return;
    }
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/fg-units/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serial: s,
          action,
          workerId: action === "PACK" ? workerId : workerId || undefined,
        }),
      });
      const data = await res.json();
      const now = new Date().toISOString();

      if (data.success && data.data) {
        const unit = data.data as FGUnit;
        invalidateCachePrefix("/api/production-orders");
        const packerBit = action === "PACK" && unit.packerName ? ` Packer: ${unit.packerName}.` : "";
        const msg = `${s} marked as ${ACTION_PAST[action]}.${packerBit}`;
        setResult({ kind: "success", unit, message: msg });
        const next = [
          { serial: s, action, ok: true, message: ACTION_PAST[action], at: now },
          ...recent,
        ].slice(0, 10);
        setRecent(next);
        saveRecent(next);
        setSerial("");
        // Keep action + worker, refocus for next scan.
        setTimeout(() => inputRef.current?.focus(), 30);
      } else {
        const message = data.error || "Scan failed.";
        setResult({ kind: "error", message });
        const next = [
          { serial: s, action, ok: false, message, at: now },
          ...recent,
        ].slice(0, 10);
        setRecent(next);
        saveRecent(next);
      }
    } catch {
      setResult({ kind: "error", message: "Network error. Please try again." });
    }
    setSubmitting(false);
  };

  const clearRecent = () => {
    setRecent([]);
    saveRecent([]);
  };

  return (
    <div className="max-w-xl mx-auto space-y-4 pb-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to="/production">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">FG Unit Scan</h1>
          <p className="text-xs text-[#6B7280]">Pack / Load / Deliver / Return — scan or type a serial.</p>
        </div>
      </div>

      {/* Mode selector */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Action</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-2">
            {ACTIONS.map((a) => {
              const selected = action === a.value;
              return (
                <button
                  key={a.value}
                  type="button"
                  onClick={() => setAction(a.value)}
                  className={`rounded-lg px-3 py-3 text-sm font-bold transition border ${
                    selected
                      ? `${a.color} text-white border-transparent shadow`
                      : "bg-white text-[#1F1D1B] border-[#E2DDD8] hover:border-[#6B5C32]"
                  }`}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Input card */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-[#6B7280] mb-1">Serial / Short code</label>
            <div className="flex gap-2">
              <Input
                ref={inputRef}
                placeholder="Scan or type FG unit serial..."
                value={serial}
                onChange={(e) => setSerial(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !submitting) {
                    e.preventDefault();
                    submitScan();
                  }
                }}
                className="flex-1 h-12 text-base font-mono"
                autoFocus
              />
              <Button
                variant="primary"
                className="h-12 px-5"
                onClick={submitScan}
                disabled={submitting || !serial.trim() || (action === "PACK" && !workerId)}
              >
                {submitting ? (
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                ) : (
                  <ScanLine className="h-5 w-5" />
                )}
              </Button>
            </div>
          </div>

          {/* Worker dropdown — required for PACK, optional otherwise */}
          <div>
            <label className="block text-xs font-medium text-[#6B7280] mb-1">
              Worker {action === "PACK" ? <span className="text-[#9A3A2D]">*</span> : <span className="text-[#9CA3AF]">(optional)</span>}
            </label>
            <select
              value={workerId}
              onChange={(e) => setWorkerId(e.target.value)}
              className="w-full h-10 px-3 rounded-md border border-[#E2DDD8] bg-white text-base text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
            >
              <option value="">
                {action === "PACK" ? "Select worker..." : "(no worker)"}
              </option>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}{w.empNo ? ` (${w.empNo})` : ""}
                </option>
              ))}
            </select>
          </div>

          <p className="text-[11px] text-[#9CA3AF]">
            Tip: handheld scanners type the serial then press Enter — this page submits on Enter so it's batch-friendly.
          </p>
        </CardContent>
      </Card>

      {/* Result banner */}
      {result?.kind === "success" && (
        <div className="rounded-xl border border-[#C6DBA8] bg-[#EEF3E4] p-4 space-y-3">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-6 w-6 text-[#4F7C3A] shrink-0" />
            <div className="flex-1">
              <p className="font-bold text-[#4F7C3A]">{result.message}</p>
            </div>
          </div>
          <div className="rounded-lg bg-white border border-[#C6DBA8] p-3 text-sm grid grid-cols-2 gap-2">
            <div>
              <p className="text-[10px] uppercase text-[#9CA3AF]">Product</p>
              <p className="font-medium text-[#1F1D1B]">{result.unit.productName}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-[#9CA3AF]">Customer</p>
              <p className="font-medium text-[#1F1D1B]">{result.unit.customerName}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-[#9CA3AF]">Unit / Piece</p>
              <p className="font-medium text-[#1F1D1B]">
                {result.unit.unitNo}/{result.unit.totalUnits} · P{result.unit.pieceNo}/{result.unit.totalPieces}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-[#9CA3AF]">SO / PO</p>
              <p className="font-mono text-[11px] text-[#1F1D1B]">{result.unit.soNo} · {result.unit.poNo}</p>
            </div>
          </div>
        </div>
      )}

      {result?.kind === "error" && (
        <div className="rounded-xl border border-[#E8B2A1] bg-[#F9E1DA] p-4 flex items-start gap-3">
          <AlertTriangle className="h-6 w-6 text-[#9A3A2D] shrink-0" />
          <div>
            <p className="font-bold text-[#9A3A2D]">Scan failed</p>
            <p className="text-sm text-[#9A3A2D] mt-0.5">{result.message}</p>
          </div>
        </div>
      )}

      {/* Recent scans */}
      {recent.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Recent scans (this session)</CardTitle>
              <button onClick={clearRecent} className="text-[11px] text-[#6B5C32] hover:underline">
                Clear
              </button>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-[#E2DDD8]">
              {recent.map((r, i) => (
                <li key={i} className="py-2 flex items-center gap-3 text-xs">
                  {r.ok
                    ? <CheckCircle2 className="h-4 w-4 text-[#4F7C3A] shrink-0" />
                    : <AlertTriangle className="h-4 w-4 text-[#9A3A2D] shrink-0" />}
                  <span className="font-mono text-[11px] flex-1 truncate text-[#1F1D1B]">{r.serial}</span>
                  <Badge>{r.action}</Badge>
                  <span className={r.ok ? "text-[#4F7C3A]" : "text-[#9A3A2D]"}>
                    {r.ok ? r.message : "Failed"}
                  </span>
                  <span className="text-[#9CA3AF] tabular-nums">
                    {new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Action help */}
      <div className="text-[11px] text-[#9CA3AF] leading-relaxed bg-[#FAF9F7] border border-[#E2DDD8] rounded-lg p-3">
        <span className="font-semibold text-[#6B7280]">{actionMeta.label}</span>{" "}
        {action === "PACK" && "marks a unit as packed. Unit must be PENDING. Worker required."}
        {action === "LOAD" && "marks a unit loaded onto a truck. Unit must be PACKED."}
        {action === "DELIVER" && "marks a unit delivered to the customer. Unit must be LOADED."}
        {action === "RETURN" && "marks a unit returned from any state."}
      </div>
    </div>
  );
}
