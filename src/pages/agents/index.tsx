// ---------------------------------------------------------------------------
// Agent Console (/agents) — SUPER_ADMIN-only mission control for the ERP's
// agents (Production live; Delivery / Customer Service / Procurement coming
// soon per AGENTS-BLUEPRINT). One card per agent with:
//
//   • status light — green ok (<26h since a successful run), yellow (last run
//     errored), red (paused / global kill switch), gray (never ran)
//   • last run / next run per task, today's outputs, month token totals
//   • one-click controls: Run now · Pause/Resume · Kill all · Rollback last
//     batch · Auto-approve gate — destructive ones behind useConfirm
//   • the learning loop's pending parameter proposals (approve → writes
//     kv_config['planning_capacity'], the engine picks it up immediately)
//
// Every button calls /api/agents/* (requireSuperAdmin + audit_events row per
// action). English UI only.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { csrfHeaders } from "@/lib/csrf";
import {
  Bot,
  Loader2,
  Play,
  Pause,
  OctagonAlert,
  Undo2,
  ShieldCheck,
  ShieldOff,
  RefreshCw,
  CheckCircle2,
  X,
} from "lucide-react";

// ── Types mirroring GET /api/agents/status ──

type AgentRun = {
  id: string;
  agent: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: string;
  summary: string | null;
  tokensIn: number;
  tokensOut: number;
  error: string | null;
};

type AgentTask = {
  agent: string;
  label: string;
  nextRun: string;
  lastRun: AgentRun | null;
};

type AgentStatus = {
  id: string;
  live: boolean;
  paused: boolean;
  autoApprove: boolean;
  tasks: AgentTask[];
  today: { runs: number; proposalsGenerated: number; pendingProposals: number } | null;
  cs?: { promises30d: number; enginePromises30d: number } | null;
  pendingConfigProposals: number;
  month: { runs: number; tokensIn: number; tokensOut: number } | null;
  recentErrors: AgentRun[];
};

type LlmUsage = {
  month: string;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  estCostMyr: number;
  budgetMyrPerAgent: number;
  byFamily: Array<{
    family: string;
    runs: number;
    tokensIn: number;
    tokensOut: number;
    estCostMyr: number;
    budgetMyr: number;
    pctOfBudget: number;
    allowed: boolean;
  }>;
};

type StatusResponse = {
  success?: boolean;
  error?: string;
  data?: {
    killAll: boolean;
    generatedAt: string;
    agents: AgentStatus[];
    llm?: LlmUsage | null;
  };
};

type AgentReview = {
  windowDays: number;
  production: {
    decisions: { approved: number; rejected: number; rolledBack: number };
    weekOnTime: { total: number; onTime: number; pct: number | null };
  };
  delivery: {
    decisions: { approved: number; rejected: number };
    threePl: { trips90d: number; onTimePct: number | null; freightVarianceSen: number };
  };
  cs: {
    promises30d: number;
    enginePromises30d: number;
    hitRate: { measured: number; hits: number; pct: number | null };
  };
};

type ConfigProposal = {
  id: string;
  generatedAt: string | null;
  paramKey: string;
  currentValue: string | null;
  proposedValue: string;
  reason: string;
  status: string;
};

const AGENT_LABEL: Record<string, string> = {
  PRODUCTION: "Production Agent",
  DELIVERY: "Delivery Agent",
  CS: "Customer Service Agent",
  PROCUREMENT: "Procurement Agent",
  FINANCE: "Finance / AR Agent",
  SALES: "Sales / Quotation Agent",
  HR: "HR / Payroll Agent",
  DATA_QUALITY: "Data Quality Agent",
  INVENTORY: "Inventory Agent",
  SERVICE: "Service Case Agent",
  CHIEF_OF_STAFF: "Chief-of-Staff Agent",
};

const AGENT_BLURB: Record<string, string> = {
  PRODUCTION:
    "Morning brief · schedule proposals · learning loop (plan-vs-actual, flexible handoffs, humane forward OT).",
  DELIVERY:
    "Daily load plans, invoice-gap + POD closure, 3PL learning, transit-drift proposals that tune the CS promise engine.",
  CS: "Promise-date orchestrator across production, materials and delivery. Every answer is logged for hit-rate learning.",
  PROCUREMENT: "Shortage → PO drafts, expediting, supplier reliability.",
  FINANCE: "Missed invoices, aging + staged collection drafts, per-customer payment profiles.",
  SALES: "OCR PO → SO draft, engine-backed promise dates in quotes, price-anomaly interception.",
  HR: "Attendance/efficiency anomaly digests, pre-payroll checks. Never touches approved pay.",
  DATA_QUALITY: "The 0711 tally audit, automated nightly: cross-page metric drift, future dates, orphans.",
  INVENTORY: "Safety-stock triggers, dead-stock lists, batch aging.",
  SERVICE: "New-case triage against original orders, repair-scope suggestions.",
  CHIEF_OF_STAFF: "One page of everything awaiting your decision, across all agents.",
};

// Blueprint agents not yet returned by /status (no runtime yet) — rendered as
// COMING SOON roster cards so the console shows the full JD lineup.
const PLANNED_AGENT_IDS = [
  "FINANCE",
  "SALES",
  "HR",
  "DATA_QUALITY",
  "INVENTORY",
  "SERVICE",
  "CHIEF_OF_STAFF",
];

const PARAM_LABEL: Record<string, string> = {
  "chain.sewHandoffDays": "Fab Cut → Fab Sew handoff (days)",
  "chain.woodHandoffDays": "Fab Sew → Wood Cut handoff (days)",
  "chain.frameHandoffDays": "Wood Cut → Framing handoff (days)",
  "chain.foamHandoffDays": "Framing → Foam handoff (days)",
  "chain.uphHandoffDays": "→ Upholstery handoff (days)",
};

function paramLabel(key: string): string {
  const fixed = PARAM_LABEL[key];
  if (fixed) return fixed;
  const cs = /^cs\.transitDays\.([A-Z]{2,3})$/.exec(key);
  if (cs) return `CS promise transit to ${cs[1]} (working days)`;
  return key;
}

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-MY", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Light = "green" | "yellow" | "red" | "gray";

function lightOf(a: AgentStatus, killAll: boolean): Light {
  if (!a.live) return "gray";
  if (killAll || a.paused) return "red";
  const last = a.tasks
    .map((t) => t.lastRun)
    .filter((r): r is AgentRun => r != null)
    .sort((x, y) => (y.startedAt ?? "").localeCompare(x.startedAt ?? ""))[0];
  if (!last) return "gray";
  if (last.status === "error") return "yellow";
  const ageH = (Date.now() - new Date(last.startedAt ?? 0).getTime()) / 36e5;
  return ageH < 26 ? "green" : "yellow";
}

const LIGHT_STYLE: Record<Light, { dot: string; label: string }> = {
  green: { dot: "bg-[#4F7C3A]", label: "Healthy" },
  yellow: { dot: "bg-[#B8860B]", label: "Attention" },
  red: { dot: "bg-[#9A3A2D]", label: "Paused" },
  gray: { dot: "bg-[#9CA3AF]", label: "Idle" },
};

export default function AgentConsolePage() {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [killAll, setKillAll] = useState(false);
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [llm, setLlm] = useState<LlmUsage | null>(null);
  const [review, setReview] = useState<AgentReview | null>(null);
  const [configProposals, setConfigProposals] = useState<ConfigProposal[]>([]);

  // The Scorecard (/review) is the heavy call — it recomputes 90 days of 3PL
  // learning + a job-card adherence scan. Load it SEPARATELY so the page
  // renders as soon as the fast status + proposals arrive; the scorecard fills
  // in a moment later instead of blocking the whole page open.
  const loadReview = useCallback(async () => {
    try {
      const r = await fetch("/api/agents/review", { credentials: "include" });
      const rj = (await r.json()) as { success?: boolean; data?: AgentReview };
      setReview(rj?.data ?? null);
    } catch {
      setReview(null);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const [statusRes, cpRes] = await Promise.all([
        fetch("/api/agents/status", { credentials: "include" }),
        fetch("/api/agents/config-proposals?status=PENDING", { credentials: "include" }),
      ]);
      const sj = (await statusRes.json()) as StatusResponse;
      if (!statusRes.ok || !sj?.success || !sj.data) {
        throw new Error(sj?.error || `HTTP ${statusRes.status}`);
      }
      setKillAll(sj.data.killAll);
      setAgents(sj.data.agents);
      setLlm(sj.data.llm ?? null);
      const cj = (await cpRes.json()) as { success?: boolean; data?: ConfigProposal[] };
      setConfigProposals(cj?.data ?? []);
    } catch (err) {
      toast.error(`Failed to load agent status: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount; same pattern as sidebar.tsx / planning
    void load();
    void loadReview(); // non-blocking — scorecard fills in when ready
  }, [load, loadReview]);

  const post = useCallback(
    async (path: string, body: unknown, okMsg: string, busyKey: string) => {
      setBusy(busyKey);
      try {
        const res = await fetch(`/api/agents/${path}`, {
          method: "POST",
          headers: csrfHeaders(),
          body: JSON.stringify(body ?? {}),
          credentials: "include",
        });
        const j = (await res.json()) as { success?: boolean; error?: string; data?: unknown };
        if (!res.ok || !j?.success) throw new Error(j?.error || `HTTP ${res.status}`);
        toast.success(okMsg);
        await load();
        return j.data;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [load, toast],
  );

  const runNow = async (agent: "brief" | "proposals" | "learning" | "delivery") => {
    await post("run-now", { agent }, `Run started and finished: ${agent}.`, `run-${agent}`);
  };

  const togglePause = async (a: AgentStatus) => {
    const next = !a.paused;
    const ok = await confirm({
      title: next ? "Pause agent" : "Resume agent",
      message: next
        ? `${AGENT_LABEL[a.id]} will stop running automatically (cron + generation). You can still trigger runs manually.`
        : `${AGENT_LABEL[a.id]} will resume its automatic runs.`,
      confirmLabel: next ? "Pause" : "Resume",
      danger: next,
    });
    if (!ok) return;
    await post(
      "pause",
      { agent: a.id, paused: next },
      next ? `${AGENT_LABEL[a.id]} paused.` : `${AGENT_LABEL[a.id]} resumed.`,
      `pause-${a.id}`,
    );
  };

  const toggleKillAll = async () => {
    const next = !killAll;
    const ok = await confirm({
      title: next ? "KILL ALL agents" : "Lift the kill switch",
      message: next
        ? "Emergency stop: EVERY agent's automatic actions stop immediately (morning brief, proposal generation, learning). Manual runs are blocked too until the switch is lifted."
        : "All agents resume their normal schedules (individually paused agents stay paused).",
      confirmLabel: next ? "Kill all" : "Lift kill switch",
      danger: next,
    });
    if (!ok) return;
    await post(
      "kill-all",
      { on: next },
      next ? "Kill switch ON — all agents stopped." : "Kill switch lifted.",
      "kill-all",
    );
  };

  const rollbackLastBatch = async () => {
    const ok = await confirm({
      title: "Rollback last approved batch",
      message:
        "Every job card in the most recently approved schedule-proposal batch gets its due date set back to the value it had before approval. Cards that already started/completed are left untouched. This cannot be un-done (but you can re-generate + re-approve).",
      confirmLabel: "Rollback batch",
      danger: true,
    });
    if (!ok) return;
    const data = (await post(
      "rollback-last-batch",
      {},
      "Batch rolled back.",
      "rollback",
    )) as { reverted?: number; skipped?: number; cards?: number } | null;
    if (data) {
      toast.success(`Reverted ${data.reverted ?? 0} of ${data.cards ?? 0} card(s); ${data.skipped ?? 0} skipped (no longer waiting).`);
    }
  };

  const toggleGate = async (a: AgentStatus) => {
    const next = !a.autoApprove;
    const ok = await confirm({
      title: next ? "Switch to full-auto" : "Back to propose-then-approve",
      message: next
        ? "Full auto — no approvals. The agent applies its own proposals AND self-tunes its own parameters (handoff / transit days, bounded + logged) on its scheduled runs. Production writes due dates on WAITING cards (every batch rollbackable); Delivery marks its plans approved (still never creates or sends documents). You keep Pause, Kill all, Rollback, and every change stays visible on the console."
        : "The agent goes back to waiting for your approval before anything is applied.",
      confirmLabel: next ? "Go full-auto" : "Require my approval",
      danger: next,
    });
    if (!ok) return;
    await post(
      "gate",
      { agent: a.id, autoApprove: next },
      next ? "Auto-approve flag ON." : "Auto-approve flag OFF.",
      `gate-${a.id}`,
    );
  };

  const decideConfig = async (id: string, action: "approve" | "reject") => {
    await post(
      "config-proposals/decide",
      { ids: [id], action },
      action === "approve"
        ? "Parameter approved — written to the live planning config."
        : "Parameter proposal rejected.",
      `cp-${id}`,
    );
  };

  const production = agents.find((a) => a.id === "PRODUCTION");
  const others = agents.filter((a) => a.id !== "PRODUCTION");

  return (
    <div className="space-y-4">
      {/* Header + global controls */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[#1F1D1B] flex items-center gap-2">
            <Bot className="h-5 w-5" />
            Agent Console
          </h1>
          <p className="text-sm text-[#6B7280] mt-0.5">
            Status and one-click controls for every agent. Every action is audited.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void load();
              void loadReview();
            }}
            disabled={loading}
          >
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => void toggleKillAll()}
            disabled={busy === "kill-all"}
            className={
              killAll
                ? "bg-[#4F7C3A] hover:bg-[#3F632E] text-white"
                : "bg-[#9A3A2D] hover:bg-[#7E2F24] text-white"
            }
          >
            {busy === "kill-all" ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <OctagonAlert className="h-4 w-4 mr-1" />
            )}
            {killAll ? "Lift kill switch" : "Kill all"}
          </Button>
        </div>
      </div>

      {killAll && (
        <div className="rounded-md border border-[#9A3A2D] bg-[#9A3A2D]/10 px-4 py-2.5 text-sm text-[#9A3A2D] font-medium">
          Global kill switch is ON — all agents are stopped (automatic and manual runs).
        </div>
      )}

      {/* ── Agent Scorecard — review agents like staff: what they SAID vs what
          actually HAPPENED, plus the owner's own decision tally on their
          proposals. Auto-computed from system records; no self-grading. ── */}
      {!loading && review && (
        <Card>
          <CardContent className="p-4">
            <div className="text-xs font-semibold text-[#6B7280] mb-2">
              Agent Scorecard — last {review.windowDays} days (said vs happened)
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2">
                <div className="text-[11px] font-semibold text-[#4B5563] mb-1">Production</div>
                <div className="text-sm text-[#1F1D1B]">
                  Cards due last 7d finished on time:{" "}
                  <span className="font-semibold">
                    {review.production.weekOnTime.pct == null
                      ? "no due cards"
                      : `${review.production.weekOnTime.pct}% (${review.production.weekOnTime.onTime}/${review.production.weekOnTime.total})`}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-[#6B7280]">
                  Your verdicts: {review.production.decisions.approved} approved ·{" "}
                  {review.production.decisions.rejected} rejected ·{" "}
                  {review.production.decisions.rolledBack} rolled back
                </div>
              </div>
              <div className="rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2">
                <div className="text-[11px] font-semibold text-[#4B5563] mb-1">Delivery</div>
                <div className="text-sm text-[#1F1D1B]">
                  3PL on-time (90d):{" "}
                  <span className="font-semibold">
                    {review.delivery.threePl.onTimePct == null
                      ? "no rated trips"
                      : `${review.delivery.threePl.onTimePct}%`}
                  </span>{" "}
                  <span className="text-[11px] text-[#6B7280]">
                    over {review.delivery.threePl.trips90d} trips · freight vs card{" "}
                    {review.delivery.threePl.freightVarianceSen >= 0 ? "+" : "−"}RM{" "}
                    {(Math.abs(review.delivery.threePl.freightVarianceSen) / 100).toFixed(0)}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-[#6B7280]">
                  Your verdicts: {review.delivery.decisions.approved} approved ·{" "}
                  {review.delivery.decisions.rejected} rejected
                </div>
              </div>
              <div className="rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2">
                <div className="text-[11px] font-semibold text-[#4B5563] mb-1">
                  Customer Service
                </div>
                <div className="text-sm text-[#1F1D1B]">
                  Promise hit rate:{" "}
                  <span className="font-semibold">
                    {review.cs.hitRate.pct == null
                      ? "collecting (no delivered promises yet)"
                      : `${review.cs.hitRate.pct}% (${review.cs.hitRate.hits}/${review.cs.hitRate.measured})`}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-[#6B7280]">
                  {review.cs.promises30d} promises given · {review.cs.enginePromises30d}{" "}
                  engine-grade
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── LLM spend monitor — per-agent month cost against the RM budget
          (owner: RM 150 / agent / month; kv agent_schedule.llmMonthlyBudgetMyr).
          At an agent's limit only ITS AI paragraphs stop; engines keep
          running and every other agent keeps talking. ── */}
      {!loading && llm && (
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-[#6B7280]">
                  AI spend this month ({llm.month}) — estimate
                </div>
                <div className="text-xl font-bold text-[#1F1D1B]">
                  ≈ RM {llm.estCostMyr.toFixed(2)}
                  <span className="ml-2 text-xs font-normal text-[#6B7280]">
                    (US${llm.estCostUsd.toFixed(2)} · {llm.tokensIn.toLocaleString()} in /{" "}
                    {llm.tokensOut.toLocaleString()} out tokens)
                  </span>
                </div>
              </div>
              <div className="text-xs text-[#6B7280]">
                Limit: RM {llm.budgetMyrPerAgent.toLocaleString()} per agent / month
              </div>
            </div>
            {llm.byFamily.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {llm.byFamily.map((b) => (
                  <div key={b.family} className="flex items-center gap-3">
                    <span className="w-28 shrink-0 text-[11px] font-medium text-[#4B5563]">
                      {AGENT_LABEL[b.family]?.replace(" Agent", "") ?? b.family}
                    </span>
                    <div className="flex-1 h-2 rounded-full bg-[#F0ECE9] overflow-hidden">
                      <div
                        className={`h-full rounded-full ${b.pctOfBudget >= 80 ? "bg-[#9A3A2D]" : "bg-[#4F7C3A]"}`}
                        style={{ width: `${Math.min(100, b.pctOfBudget)}%` }}
                      />
                    </div>
                    <span className="w-40 shrink-0 text-right text-[11px] text-[#6B7280]">
                      RM {b.estCostMyr.toFixed(2)} · {b.runs} runs
                      {!b.allowed && (
                        <span className="ml-1 font-semibold text-[#9A3A2D]">LIMIT HIT</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-[#6B7280]">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          Loading agents…
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {/* ── Production (live) ── */}
          {production && (
            <Card className="xl:col-span-2">
              <CardHeader>
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-[#1F1D1B]">
                      {(() => {
                        const l = lightOf(production, killAll);
                        return (
                          <span
                            className={`inline-block h-3 w-3 rounded-full ${LIGHT_STYLE[l].dot}`}
                            title={LIGHT_STYLE[l].label}
                          />
                        );
                      })()}
                      {AGENT_LABEL.PRODUCTION}
                      {production.paused && (
                        <span className="text-[11px] font-semibold rounded-full bg-[#9A3A2D]/10 text-[#9A3A2D] px-2 py-0.5">
                          PAUSED
                        </span>
                      )}
                      {production.autoApprove && (
                        <span className="text-[11px] font-semibold rounded-full bg-[#6B5C32]/10 text-[#6B5C32] px-2 py-0.5">
                          AUTO-APPROVE FLAG
                        </span>
                      )}
                    </CardTitle>
                    <p className="mt-1 text-xs text-[#6B7280]">{AGENT_BLURB.PRODUCTION}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void togglePause(production)}
                      disabled={busy === `pause-PRODUCTION`}
                    >
                      {production.paused ? (
                        <Play className="h-4 w-4 mr-1" />
                      ) : (
                        <Pause className="h-4 w-4 mr-1" />
                      )}
                      {production.paused ? "Resume" : "Pause"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void toggleGate(production)}
                      disabled={busy === `gate-PRODUCTION`}
                    >
                      {production.autoApprove ? (
                        <ShieldOff className="h-4 w-4 mr-1" />
                      ) : (
                        <ShieldCheck className="h-4 w-4 mr-1" />
                      )}
                      {production.autoApprove ? "Back to proposals" : "Auto-approve"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-[#9A3A2D]"
                      onClick={() => void rollbackLastBatch()}
                      disabled={busy === "rollback"}
                    >
                      {busy === "rollback" ? (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      ) : (
                        <Undo2 className="h-4 w-4 mr-1" />
                      )}
                      Rollback last batch
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Stats */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  {[
                    { label: "Runs today", value: production.today?.runs ?? 0 },
                    {
                      label: "Proposals generated today",
                      value: production.today?.proposalsGenerated ?? 0,
                    },
                    {
                      label: "Pending schedule proposals",
                      value: production.today?.pendingProposals ?? 0,
                    },
                    {
                      label: "Pending parameter proposals",
                      value: production.pendingConfigProposals,
                    },
                    {
                      label: "Tokens this month (in / out)",
                      value: `${(production.month?.tokensIn ?? 0).toLocaleString()} / ${(production.month?.tokensOut ?? 0).toLocaleString()}`,
                    },
                  ].map((s) => (
                    <div
                      key={s.label}
                      className="rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2"
                    >
                      <div className="text-[11px] text-[#6B7280]">{s.label}</div>
                      <div className="text-base font-semibold text-[#1F1D1B]">{s.value}</div>
                    </div>
                  ))}
                </div>

                {/* Tasks */}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-[#F0ECE9]">
                      <tr className="border-b border-[#E2DDD8]">
                        <th className="h-9 px-3 text-left font-medium text-[#374151]">Task</th>
                        <th className="h-9 px-3 text-left font-medium text-[#374151]">Last run</th>
                        <th className="h-9 px-3 text-left font-medium text-[#374151]">Result</th>
                        <th className="h-9 px-3 text-left font-medium text-[#374151]">Next run</th>
                        <th className="h-9 px-3 text-right font-medium text-[#374151]">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {production.tasks.map((t) => {
                        const key = t.agent.replace("production-", "") as
                          | "brief"
                          | "proposals"
                          | "learning";
                        return (
                          <tr key={t.agent} className="border-b border-[#E2DDD8]">
                            <td className="px-3 py-2 font-medium text-[#1F1D1B] whitespace-nowrap">
                              {t.label}
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              {fmtWhen(t.lastRun?.startedAt)}
                              {t.lastRun && (
                                <span
                                  className={`ml-2 text-[11px] font-semibold ${
                                    t.lastRun.status === "ok"
                                      ? "text-[#4F7C3A]"
                                      : t.lastRun.status === "error"
                                        ? "text-[#9A3A2D]"
                                        : "text-[#6B7280]"
                                  }`}
                                >
                                  {t.lastRun.status.toUpperCase()}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-xs text-[#6B7280]">
                              {t.lastRun?.error ?? t.lastRun?.summary ?? "—"}
                            </td>
                            <td className="px-3 py-2 text-xs text-[#6B7280] whitespace-nowrap">
                              {t.nextRun}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void runNow(key)}
                                disabled={busy === `run-${key}` || killAll}
                              >
                                {busy === `run-${key}` ? (
                                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                ) : (
                                  <Play className="h-4 w-4 mr-1" />
                                )}
                                Run now
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Parameter proposals from the learning loop */}
                <div>
                  <div className="text-sm font-semibold text-[#1F1D1B] mb-1.5">
                    Parameter proposals ({configProposals.length} pending)
                  </div>
                  {configProposals.length === 0 ? (
                    <div className="text-xs text-[#6B7280]">
                      None pending — the learning loop raises one when a chain handoff drifts
                      more than a working day from the configured value.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[#F0ECE9]">
                          <tr className="border-b border-[#E2DDD8]">
                            <th className="h-9 px-3 text-left font-medium text-[#374151]">Parameter</th>
                            <th className="h-9 px-3 text-right font-medium text-[#374151]">Current</th>
                            <th className="h-9 px-3 text-right font-medium text-[#374151]">Proposed</th>
                            <th className="h-9 px-3 text-left font-medium text-[#374151]">Why</th>
                            <th className="h-9 px-3 text-right font-medium text-[#374151]">Decide</th>
                          </tr>
                        </thead>
                        <tbody>
                          {configProposals.map((p) => (
                            <tr key={p.id} className="border-b border-[#E2DDD8]">
                              <td className="px-3 py-2 font-medium text-[#1F1D1B] whitespace-nowrap">
                                {paramLabel(p.paramKey)}
                              </td>
                              <td className="px-3 py-2 text-right">{p.currentValue ?? "—"}</td>
                              <td className="px-3 py-2 text-right font-semibold text-[#4F7C3A]">
                                {p.proposedValue}
                              </td>
                              <td className="px-3 py-2 text-xs text-[#6B7280]">{p.reason}</td>
                              <td className="px-3 py-2 text-right whitespace-nowrap">
                                <Button
                                  size="sm"
                                  className="bg-[#4F7C3A] hover:bg-[#3F632E] text-white mr-1"
                                  disabled={busy === `cp-${p.id}`}
                                  onClick={() => void decideConfig(p.id, "approve")}
                                >
                                  <CheckCircle2 className="h-4 w-4 mr-1" />
                                  Approve
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-[#9A3A2D]"
                                  disabled={busy === `cp-${p.id}`}
                                  onClick={() => void decideConfig(p.id, "reject")}
                                >
                                  <X className="h-4 w-4 mr-1" />
                                  Reject
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Recent errors */}
                {production.recentErrors.length > 0 && (
                  <div>
                    <div className="text-sm font-semibold text-[#9A3A2D] mb-1.5">Recent errors</div>
                    <ul className="space-y-1">
                      {production.recentErrors.map((e) => (
                        <li key={e.id} className="text-xs text-[#6B7280]">
                          <span className="font-medium text-[#1F1D1B]">{e.agent}</span> ·{" "}
                          {fmtWhen(e.startedAt)} — <span className="text-[#9A3A2D]">{e.error}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Delivery — full console lifecycle (pause gates its cron, run-now,
              run log + tokens). CS — live, question-driven (no cron): KPI
              counters from the promise log. Procurement — parked behind its
              data-readiness gate. ── */}
          {others.map((a) => {
            const live = a.live;
            const lastRun = a.tasks[0]?.lastRun ?? null;
            return (
              <Card key={a.id} className={live ? "" : "opacity-70"}>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-[#1F1D1B]">
                        {(() => {
                          const l = lightOf(a, killAll);
                          return (
                            <span
                              className={`inline-block h-3 w-3 rounded-full ${LIGHT_STYLE[l].dot}`}
                              title={LIGHT_STYLE[l].label}
                            />
                          );
                        })()}
                        {AGENT_LABEL[a.id] ?? a.id}
                        <span
                          className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${live ? "bg-[#EEF3E4] text-[#4F7C3A]" : "bg-[#F0ECE9] text-[#6B7280]"}`}
                        >
                          {live ? "LIVE" : "COMING SOON"}
                        </span>
                        {a.paused && (
                          <span className="text-[11px] font-semibold rounded-full bg-[#9A3A2D]/10 text-[#9A3A2D] px-2 py-0.5">
                            PAUSED
                          </span>
                        )}
                      </CardTitle>
                      <p className="mt-1 text-xs text-[#6B7280]">{AGENT_BLURB[a.id] ?? ""}</p>
                    </div>
                    {a.id === "DELIVERY" && live && (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void runNow("delivery")}
                          disabled={busy === "run-delivery" || killAll}
                        >
                          {busy === "run-delivery" ? (
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                          ) : (
                            <Play className="h-4 w-4 mr-1" />
                          )}
                          Run now
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void togglePause(a)}
                          disabled={busy === `pause-${a.id}`}
                        >
                          {a.paused ? (
                            <Play className="h-4 w-4 mr-1" />
                          ) : (
                            <Pause className="h-4 w-4 mr-1" />
                          )}
                          {a.paused ? "Resume" : "Pause"}
                        </Button>
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  {a.id === "DELIVERY" && live ? (
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        {[
                          {
                            label: "Proposals generated today",
                            value: a.today?.proposalsGenerated ?? 0,
                          },
                          {
                            label: "Pending delivery proposals",
                            value: a.today?.pendingProposals ?? 0,
                          },
                          {
                            label: "Last run",
                            value: lastRun
                              ? `${fmtWhen(lastRun.startedAt)} · ${lastRun.status}`
                              : "never",
                          },
                        ].map((s) => (
                          <div
                            key={s.label}
                            className="rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2"
                          >
                            <div className="text-[11px] text-[#6B7280]">{s.label}</div>
                            <div className="text-base font-semibold text-[#1F1D1B]">{s.value}</div>
                          </div>
                        ))}
                      </div>
                      {lastRun?.summary && (
                        <div className="text-xs text-[#6B7280]">{lastRun.summary}</div>
                      )}
                      <div className="text-xs text-[#4B5563]">
                        Working surface: Delivery page → “Delivery Agent” tab (load plans,
                        invoice gaps, POD chases, AI focus). First run 07:30 MYT, then it
                        self-schedules extra sweeps when dispatches/deliveries spike — each
                        run logs its own reason. Transit-drift findings appear above as CS
                        parameter proposals.
                      </div>
                    </div>
                  ) : a.id === "CS" && live ? (
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        {[
                          { label: "Promises answered (30d)", value: a.cs?.promises30d ?? 0 },
                          {
                            label: "Engine-grade answers (30d)",
                            value: a.cs?.enginePromises30d ?? 0,
                          },
                          {
                            label: "Answer channel",
                            value: "Hookka AI · API",
                          },
                        ].map((s) => (
                          <div
                            key={s.label}
                            className="rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2"
                          >
                            <div className="text-[11px] text-[#6B7280]">{s.label}</div>
                            <div className="text-base font-semibold text-[#1F1D1B]">{s.value}</div>
                          </div>
                        ))}
                      </div>
                      <div className="text-xs text-[#4B5563]">
                        Ask Hookka AI “when can SO-xxx be delivered” — materials → production →
                        delivery reasoning chain. Every answer is logged; hit-rate KPI activates
                        as deliveries land against promises.
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-[#9CA3AF]">
                      {a.id === "PROCUREMENT"
                        ? "Parked until the data-readiness gate passes (supplier lead times ≥90%, PO expected dates ≥90%, MRP ≤7 days old) — see GET /api/cs-agent/procurement/readiness."
                        : "Planned in the agents blueprint — controls activate when the agent ships."}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}

          {/* ── Blueprint roster — designed (JD in docs/AGENTS-BLUEPRINT.md), not
              yet built. Kept visible so the console always shows the full
              lineup and what's next. ── */}
          {PLANNED_AGENT_IDS.map((id) => (
            <Card key={id} className="opacity-70">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-[#1F1D1B]">
                  <span className="inline-block h-3 w-3 rounded-full bg-[#9CA3AF]" />
                  {AGENT_LABEL[id] ?? id}
                  <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-[#F0ECE9] text-[#6B7280]">
                    COMING SOON
                  </span>
                </CardTitle>
                <p className="mt-1 text-xs text-[#6B7280]">{AGENT_BLURB[id] ?? ""}</p>
              </CardHeader>
              <CardContent>
                <div className="text-xs text-[#9CA3AF]">
                  Planned in the agents blueprint — controls activate when the agent ships.
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {confirmDialog}
    </div>
  );
}
