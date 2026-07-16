// ---------------------------------------------------------------------------
// agent-tab.tsx — the "Delivery Agent" section of the Delivery page.
//
// Read + decide surface for the Delivery Agent (TMS):
//   - Brief summary strip: READY_TO_SHIP pool value, overdue-to-ship count,
//     invoice gaps, POD chases (GET /api/delivery-agent/brief.json).
//   - Proposals list (LOAD_PLAN / INVOICE_GAP / POD_CHASE) with multi-select
//     Approve / Reject (POST /api/delivery-agent/proposals/approve|reject).
//   - "Generate proposals" re-runs the engine on demand.
//
// RED LINE (mirrors the backend): approving a proposal does NOT create or
// dispatch delivery orders — it records the decision for the office to
// execute via the existing Create Packing List / invoice flows.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatRM } from "@/lib/utils";
import {
  Bot,
  CheckCircle2,
  ClipboardList,
  FileWarning,
  Loader2,
  Package,
  RefreshCw,
  Camera,
  AlertTriangle,
} from "lucide-react";

// ── Payload types (mirror src/api/lib/delivery-agent.ts) ─────────────────────

interface StateBucketSummary {
  stateCode: string;
  hubName: string;
  count: number;
  valueSen: number;
}

interface ProviderLearningRow {
  providerId: string;
  providerName: string;
  trips: number;
  ratedOnTime: number;
  onTimeTrips: number;
  onTimePct: number | null;
  costedTrips: number;
  actualFreightSen: number;
  cardFreightSen: number;
  varianceSen: number;
}

interface BriefData {
  date: string;
  generatedAtIso: string;
  pool: { count: number; valueSen: number; byStateHub: StateBucketSummary[] };
  overdueToShip: {
    count: number;
    valueSen: number;
    rows: Array<{
      soNo: string;
      customerName: string;
      stateCode: string;
      hubName: string;
      dueDate: string;
      valueSen: number;
      daysLate: number;
    }>;
  };
  doPipeline: { byStatus: Record<string, number> };
  invoiceGaps: {
    count: number;
    rows: Array<{ doNo: string; customerName: string; deliveredAt: string; daysSinceDelivered: number }>;
  };
  podChases: {
    count: number;
    rows: Array<{ doNo: string; customerName: string; deliveredAt: string; daysSinceDelivered: number }>;
  };
  returns: { openServiceCases: number };
  proposals: { pendingByKind: Record<string, number>; pending: number };
  learning: ProviderLearningRow[];
  /** Claude-written focus paragraph from the latest agent run (may be null). */
  aiFocus?: string | null;
}

interface Recipient {
  customer: string;
  hub: string;
  doCount: number;
  valueSen: number;
}

interface Proposal {
  id: string;
  generatedAt: string;
  kind: string;
  soRefs: string;
  state: string;
  hub: string;
  itemsCount: number;
  valueSen: number;
  threePlCostSen: number;
  recommendation: string;
  status: string;
  // Packing-list fields (LOAD_PLAN)
  dueDate?: string;
  doCount?: number;
  dropCount?: number;
  driver?: string;
  recipients?: Recipient[];
}

const KIND_LABEL: Record<string, string> = {
  LOAD_PLAN: "Load Plan",
  INVOICE_GAP: "Invoice Gap",
  POD_CHASE: "POD Chase",
};

const KIND_BADGE: Record<string, string> = {
  LOAD_PLAN: "bg-[#EEF3E4] text-[#4F7C3A]",
  INVOICE_GAP: "bg-[#FDECEA] text-[#9A3A2D]",
  POD_CHASE: "bg-[#FAEFCB] text-[#9C6F1E]",
};

export default function DeliveryAgentTab() {
  const { toast } = useToast();
  const { confirm } = useConfirm();

  const [brief, setBrief] = useState<BriefData | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [kindFilter, setKindFilter] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [briefRes, propRes] = await Promise.all([
        fetch("/api/delivery-agent/brief.json"),
        fetch("/api/delivery-agent/proposals?status=PENDING"),
      ]);
      const briefJson = (await briefRes.json()) as { success: boolean; data?: BriefData };
      const propJson = (await propRes.json()) as { success: boolean; data?: Proposal[] };
      if (briefJson.success && briefJson.data) setBrief(briefJson.data);
      if (propJson.success && propJson.data) setProposals(propJson.data);
      if (!briefJson.success || !propJson.success) {
        toast.error("Failed to load the Delivery Agent data");
      }
    } catch {
      toast.error("Failed to load the Delivery Agent data");
    } finally {
      setLoading(false);
      setSelected(new Set());
    }
  }, [toast]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard data-fetch effect; `load` (a useCallback also wired to the Refresh button) sets loading/data, not a cascading-render bug
    void load();
  }, [load]);

  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      const res = await fetch("/api/delivery-agent/proposals/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = (await res.json()) as {
        success: boolean;
        error?: string;
        data?: { loadPlans: number; invoiceGaps: number; podChases: number };
      };
      if (json.success && json.data) {
        const d = json.data;
        toast.success(
          `Generated ${d.loadPlans} load plan(s), ${d.invoiceGaps} invoice gap(s), ${d.podChases} POD chase(s)`,
        );
        await load();
      } else {
        toast.error(json.error || "Proposal generation failed");
      }
    } catch {
      toast.error("Proposal generation failed");
    } finally {
      setGenerating(false);
    }
  }, [load, toast]);

  const decide = useCallback(
    async (action: "approve" | "reject") => {
      const ids = [...selected];
      if (ids.length === 0) return;
      if (action === "reject") {
        const ok = await confirm({
          title: "Reject proposals",
          message: `Reject ${ids.length} proposal(s)? They will be regenerated on the next run if still relevant.`,
          confirmLabel: "Reject",
          danger: true,
        });
        if (!ok) return;
      } else {
        const ok = await confirm({
          title: "Approve proposals",
          message: `Approve ${ids.length} proposal(s)? This records the decision only — no delivery order is created or dispatched. Execute approved load plans via Create Packing List.`,
          confirmLabel: "Approve",
        });
        if (!ok) return;
      }
      setDeciding(true);
      try {
        const res = await fetch(`/api/delivery-agent/proposals/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        });
        const json = (await res.json()) as {
          success: boolean;
          error?: string;
          data?: { approved?: number; rejected?: number };
        };
        if (json.success && json.data) {
          toast.success(
            action === "approve"
              ? `Approved ${json.data.approved ?? 0} proposal(s)`
              : `Rejected ${json.data.rejected ?? 0} proposal(s)`,
          );
          await load();
        } else {
          toast.error(json.error || `Failed to ${action}`);
        }
      } catch {
        toast.error(`Failed to ${action}`);
      } finally {
        setDeciding(false);
      }
    },
    [selected, confirm, load, toast],
  );

  const visible = useMemo(
    () => (kindFilter ? proposals.filter((p) => p.kind === kindFilter) : proposals),
    [proposals, kindFilter],
  );
  const allVisibleSelected =
    visible.length > 0 && visible.every((p) => selected.has(p.id));

  const toggleAll = () => {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const p of visible) next.delete(p.id);
        return next;
      }
      const next = new Set(prev);
      for (const p of visible) next.add(p.id);
      return next;
    });
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const kinds = useMemo(() => {
    const set = new Set(proposals.map((p) => p.kind));
    return ["", ...[...set].sort()];
  }, [proposals]);

  return (
    <div className="space-y-6 max-md:space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B] flex items-center gap-2">
            <Bot className="h-5 w-5 text-[#6B5C32]" /> Delivery Agent
          </h1>
          <p className="text-xs text-[#6B7280]">
            Load-plan, invoice-gap and POD proposals — approving records the
            decision only; no delivery order is created automatically.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => void generate()} disabled={generating}>
            {generating ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <ClipboardList className="h-4 w-4 mr-1" />
            )}
            Generate Proposals
          </Button>
        </div>
      </div>

      {/* AI focus — the agent brain's read of today (written on each daily
          run / Run now; absent until the first run after this ships) */}
      {brief?.aiFocus && (
        <Card className="border-[#D9CFA8] bg-[#FBF8EF]">
          <CardContent className="p-4 flex items-start gap-3">
            <div className="rounded-lg bg-[#F0E9D2] p-2.5 shrink-0">
              <Bot className="h-5 w-5 text-[#6B5C32]" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-[#6B5C32] mb-1">Agent focus</p>
              <p className="text-sm text-[#1F1D1B] whitespace-pre-wrap">{brief.aiFocus}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary strip */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#EEF3E4] p-2.5 shrink-0">
              <Package className="h-5 w-5 text-[#4F7C3A]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#1F1D1B]">
                {brief ? brief.pool.count : "-"}
              </p>
              <p className="text-xs text-[#6B7280]">
                Ready-to-ship pool
                {brief ? ` · ${formatRM(brief.pool.valueSen)}` : ""}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FDECEA] p-2.5 shrink-0">
              <AlertTriangle className="h-5 w-5 text-[#9A3A2D]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#9A3A2D]">
                {brief ? brief.overdueToShip.count : "-"}
              </p>
              <p className="text-xs text-[#6B7280]">
                Overdue to ship
                {brief ? ` · ${formatRM(brief.overdueToShip.valueSen)}` : ""}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FDECEA] p-2.5 shrink-0">
              <FileWarning className="h-5 w-5 text-[#9A3A2D]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#1F1D1B]">
                {brief ? brief.invoiceGaps.count : "-"}
              </p>
              <p className="text-xs text-[#6B7280]">Delivered, not invoiced</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FAEFCB] p-2.5 shrink-0">
              <Camera className="h-5 w-5 text-[#9C6F1E]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#1F1D1B]">
                {brief ? brief.podChases.count : "-"}
              </p>
              <p className="text-xs text-[#6B7280]">PODs missing &gt;24h</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Proposals */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base">
            Pending Proposals ({visible.length}
            {kindFilter ? ` of ${proposals.length}` : ""})
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
              className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm text-[#1F1D1B]"
            >
              {kinds.map((k) => (
                <option key={k || "all"} value={k}>
                  {k ? (KIND_LABEL[k] ?? k) : "All kinds"}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              onClick={() => void decide("approve")}
              disabled={deciding || selected.size === 0}
            >
              <CheckCircle2 className="h-4 w-4 mr-1" />
              Approve ({selected.size})
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-[#9A3A2D] border-[#9A3A2D]/40 hover:bg-[#FDECEA]"
              onClick={() => void decide("reject")}
              disabled={deciding || selected.size === 0}
            >
              Reject ({selected.size})
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 py-8 justify-center text-sm text-[#6B7280]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-[#9CA3AF]">
              No pending proposals. Click Generate Proposals to run the agent
              against the current ready-to-ship pool.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2 text-xs text-[#6B7280]">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAll}
                  aria-label="Select all"
                />
                Select all ({visible.length})
              </label>
              {visible.map((p) => {
                const today = new Date().toISOString().slice(0, 10);
                const isPlan = p.kind === "LOAD_PLAN";
                const due = p.dueDate || "";
                const expired = !!due && due < today;
                const soon = !!due && !expired && due === today;
                return (
                  <div
                    key={p.id}
                    className="rounded-xl border border-[#E2DDD8] bg-white p-4"
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={selected.has(p.id)}
                        onChange={() => toggle(p.id)}
                        aria-label={`Select ${p.soRefs}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <Badge
                            className={KIND_BADGE[p.kind] ?? "bg-[#F0ECE9] text-[#6B7280]"}
                          >
                            {isPlan
                              ? `Packing list — ${p.state || "—"}`
                              : KIND_LABEL[p.kind] ?? p.kind}
                          </Badge>
                          {isPlan && due ? (
                            <span
                              className={
                                "whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium " +
                                (expired
                                  ? "bg-[#FDECEA] text-[#9A3A2D]"
                                  : soon
                                    ? "bg-[#FAEFCB] text-[#9C6F1E]"
                                    : "bg-[#F0ECE9] text-[#6B7280]")
                              }
                            >
                              {expired ? "expired" : soon ? "expires today" : `expires ${due}`}
                            </span>
                          ) : null}
                        </div>

                        {isPlan ? (
                          <>
                            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                              {[
                                { l: "DOs", v: String(p.doCount ?? 0) },
                                { l: "Drop points", v: String(p.dropCount ?? 0) },
                                { l: "Value", v: formatRM(p.valueSen) },
                                {
                                  l: "3PL est.",
                                  v: p.threePlCostSen > 0 ? formatRM(p.threePlCostSen) : "—",
                                },
                              ].map((m) => (
                                <div
                                  key={m.l}
                                  className="rounded-lg bg-[#F7F5F2] px-3 py-2"
                                >
                                  <div className="text-xs text-[#6B7280]">{m.l}</div>
                                  <div className="text-lg font-medium tabular-nums text-[#1F1D1B]">
                                    {m.v}
                                  </div>
                                </div>
                              ))}
                            </div>

                            {p.recipients && p.recipients.length > 0 ? (
                              <div className="mb-2 border-t border-[#F0ECE9] pt-2">
                                <div className="mb-1 text-xs text-[#6B7280]">
                                  Delivering to
                                </div>
                                <div className="flex flex-col gap-1">
                                  {p.recipients.map((r, i) => (
                                    <div
                                      key={i}
                                      className="flex items-center gap-2 text-sm"
                                    >
                                      <span className="truncate text-[#1F1D1B]">
                                        {r.customer}
                                      </span>
                                      <span className="min-w-0 flex-1 truncate text-xs text-[#6B7280]">
                                        {r.hub}
                                      </span>
                                      <span className="whitespace-nowrap text-xs text-[#6B7280]">
                                        {r.doCount} DO
                                      </span>
                                      <span className="whitespace-nowrap tabular-nums text-[#1F1D1B]">
                                        {formatRM(r.valueSen)}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}

                            <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-[#F0ECE9] pt-2 text-sm text-[#1F1D1B]">
                              <span>
                                <span className="text-[#6B7280]">Driver:</span>{" "}
                                {p.driver || "—"}
                              </span>
                              <span>
                                <span className="text-[#6B7280]">Deliver by:</span>{" "}
                                {due || "—"}
                              </span>
                              <span className="text-xs text-[#9CA3AF]">
                                {p.soRefs}
                              </span>
                            </div>
                          </>
                        ) : (
                          <div className="text-sm text-[#4B5563]">
                            <div className="mb-1 text-[#1F1D1B]">
                              {p.state || "—"}
                              {p.hub ? ` · ${p.hub}` : ""}
                              {p.soRefs ? ` · ${p.soRefs}` : ""}
                            </div>
                            <div className="text-xs">{p.recommendation}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pool by destination + 3PL learning */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ready Pool by Destination</CardTitle>
          </CardHeader>
          <CardContent>
            {!brief || brief.pool.byStateHub.length === 0 ? (
              <p className="py-4 text-center text-sm text-[#9CA3AF]">
                Nothing ready to ship.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] text-left text-xs text-[#6B7280]">
                      <th className="py-2 pr-3">State</th>
                      <th className="py-2 pr-3">Hub</th>
                      <th className="py-2 pr-3 text-right">SOs</th>
                      <th className="py-2 text-right">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {brief.pool.byStateHub.map((b, i) => (
                      <tr key={i} className="border-b border-[#F0ECE9]">
                        <td className="py-2 pr-3">{b.stateCode}</td>
                        <td className="py-2 pr-3 text-xs text-[#6B7280]">
                          {b.hubName || "—"}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{b.count}</td>
                        <td className="py-2 text-right tabular-nums whitespace-nowrap">
                          {formatRM(b.valueSen)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              3PL Learning — last 90 days
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!brief || brief.learning.length === 0 ? (
              <p className="py-4 text-center text-sm text-[#9CA3AF]">
                No delivered 3PL trips in the window yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] text-left text-xs text-[#6B7280]">
                      <th className="py-2 pr-3">Provider</th>
                      <th className="py-2 pr-3 text-right">Trips</th>
                      <th className="py-2 pr-3 text-right">On-time</th>
                      <th className="py-2 pr-3 text-right">Actual Freight</th>
                      <th className="py-2 text-right">vs Rate Card</th>
                    </tr>
                  </thead>
                  <tbody>
                    {brief.learning.map((p) => (
                      <tr key={p.providerId} className="border-b border-[#F0ECE9]">
                        <td className="py-2 pr-3">{p.providerName}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{p.trips}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {p.onTimePct == null ? "—" : `${p.onTimePct}%`}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">
                          {p.costedTrips > 0 ? formatRM(p.actualFreightSen) : "—"}
                        </td>
                        <td
                          className={`py-2 text-right tabular-nums whitespace-nowrap ${
                            p.cardFreightSen > 0 && p.varianceSen > 0
                              ? "text-[#9A3A2D]"
                              : "text-[#4F7C3A]"
                          }`}
                        >
                          {p.cardFreightSen > 0
                            ? `${p.varianceSen >= 0 ? "+" : "−"}${formatRM(Math.abs(p.varianceSen))}`
                            : "—"}
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
    </div>
  );
}
