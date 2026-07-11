// ---------------------------------------------------------------------------
// production-brief.ts — the Production Agent's Morning Brief (Phase 1).
//
// One email/HTML/JSON assembled every working morning (07:00 MYT cron via the
// existing daily-reports pipeline — see reports.ts + daily-reports.yml):
//
//   1. Today's plan        — reuses collectScheduleData (JCs due today by dept)
//   2. CNC cutting queue   — the NEW minutes-based model (owner 2026-07-11):
//                            bedframe set 8min · sofa set 20min · accessory
//                            4min · +10min per fabric change, ONE machine.
//                            Queue is grouped by FABRIC because the CNC cuts
//                            one fabric at a time (fabric-first batching).
//   3. Overdue             — reuses collectOverdueData (top offenders)
//   4. Yesterday's actuals — reuses collectEfficiencyData (prev working day):
//                            overall efficiency + below-60% workers
//   5. Drift check (the learning loop, v0 — deterministic): actual CNC
//      minutes-per-set over the last 7 days vs the configured 8/20/4. A >25%
//      gap is flagged so the owner can approve a config update — the same
//      mechanism that would have caught the slots→CNC transition itself.
//   6. AI focus (optional) — a short Chinese "今日焦点" written by Claude from
//      the assembled numbers. Skipped silently when no ANTHROPIC_API_KEY or
//      on any API error: the brief NEVER fails because the AI hiccuped.
//
// Read-only by design: nothing here writes to the ERP. Scheduler v2 (fabric-
// first cut batching + due-date proposals) builds on the same cnc config.
// ---------------------------------------------------------------------------

import {
  collectScheduleData,
  collectOverdueData,
  type ScheduleReport,
  type OverdueReport,
} from "./schedule-overdue-report";
import {
  collectEfficiencyData,
  type EfficiencyData,
} from "./efficiency-report";
import { loadCapacityConfig, type CapacityConfig } from "./planning-capacity";
import { runLearning, type LearningData } from "./agent-learning";

// D1-compat DB shape (matches the SupabaseAdapter used across routes).
interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

export interface CncQueueFabric {
  fabricCode: string;
  bedframeSets: number;
  sofaSets: number;
  accessoryPieces: number;
  minutes: number; // cutting minutes for this fabric (excl. the changeover)
}

export interface CncQueue {
  bedframeSets: number;
  sofaSets: number;
  accessoryPieces: number;
  fabricCount: number;
  cuttingMinutes: number; // Σ per-piece minutes
  changeoverMinutes: number; // fabricCount × fabricChangeMin
  totalMinutes: number;
  /** totalMinutes ÷ cnc.referenceDayMin — "≈ N days of CNC work queued". */
  referenceDays: number;
  topFabrics: CncQueueFabric[]; // largest first, capped at 8 for the email
}

export interface CutRateDrift {
  category: "BEDFRAME" | "SOFA" | "ACCESSORY";
  configuredMin: number;
  actualMin: number | null; // null = no completions in the window
  sets: number;
  driftPct: number | null; // (actual-configured)/configured × 100
  flagged: boolean; // |driftPct| > 25
}

export interface BriefData {
  date: string; // today (the plan side)
  prevDate: string; // previous working day (the actuals side)
  generatedAtIso: string;
  schedule: ScheduleReport;
  overdue: OverdueReport;
  efficiency: EfficiencyData;
  lowWorkers: Array<{ name: string; departmentName: string; pct: number }>;
  cnc: CncQueue;
  cncConfig: CapacityConfig["cnc"];
  drift: CutRateDrift[];
  /** Phase 2: PENDING due-date proposals awaiting the owner's approval. */
  proposals: { pending: number };
  /**
   * Phase 3: the learning loop (plan-vs-actual adherence, flexible-handoff
   * parameter proposals, forward OT signal). Null when the caller skipped it
   * (dashboard-card JSON) or when the learner errored — the brief NEVER
   * fails because learning hiccuped.
   */
  learning: LearningData | null;
  aiFocus: string | null;
}

/** Options for collectBriefData (all default off = Phase-1/2 behaviour). */
export interface BriefOptions {
  /** Run the Phase-3 learning loop and add its sections. */
  learning?: boolean;
  /**
   * Let the learning loop WRITE new config_proposals rows for sustained
   * handoff drift. Only cron / Run-now set this — plain GET renders never
   * write.
   */
  emitConfigProposals?: boolean;
  /** Filled with the AI-focus call's Anthropic token usage (Agent Console). */
  usageSink?: { tokensIn: number; tokensOut: number };
}

// ---------------------------------------------------------------------------
// Phase 2 — pending due-date proposals (Planning > Schedule Proposals).
// The table is a runtime self-apply owned by schedule-proposals.ts; if it
// hasn't been created yet on this environment the count is simply 0 — the
// brief NEVER fails because of the proposals feature.
// ---------------------------------------------------------------------------

async function collectPendingProposals(db: DbLike): Promise<number> {
  try {
    const r = await db
      .prepare("SELECT COUNT(*) AS n FROM schedule_proposals WHERE status = 'PENDING'")
      .bind()
      .first<{ n: number | string }>();
    return Number(r?.n) || 0;
  } catch {
    return 0; // table not self-applied yet
  }
}

// ---------------------------------------------------------------------------
// CNC queue — every ACTIVE Fabric Cutting job card, grouped by fabric.
// ---------------------------------------------------------------------------

async function collectCncQueue(
  db: DbLike,
  cnc: CapacityConfig["cnc"],
): Promise<CncQueue> {
  const res = await db
    .prepare(
      `SELECT COALESCE(po.itemCategory,'') AS cat,
              COALESCE(po.fabricCode,'')   AS fab,
              COALESCE(jc.wipQty, 1)       AS qty
         FROM job_cards jc
         JOIN production_orders po ON po.id = jc.productionOrderId
        WHERE jc.departmentCode = 'FAB_CUT'
          AND jc.status NOT IN ('COMPLETED','CANCELLED','TRANSFERRED')
          AND po.status IN ('IN_PROGRESS','PENDING')`,
    )
    .bind()
    .all<{ cat: string; fab: string; qty: number | string }>();

  const byFabric = new Map<string, CncQueueFabric>();
  let bedframeSets = 0;
  let sofaSets = 0;
  let accessoryPieces = 0;
  for (const r of res.results ?? []) {
    const qty = Math.max(1, Number(r.qty) || 1);
    const fab = (r.fab || "(no fabric)").trim() || "(no fabric)";
    const cat = (r.cat || "").toUpperCase();
    const e =
      byFabric.get(fab) ??
      ({ fabricCode: fab, bedframeSets: 0, sofaSets: 0, accessoryPieces: 0, minutes: 0 } as CncQueueFabric);
    if (cat === "BEDFRAME") {
      bedframeSets += qty;
      e.bedframeSets += qty;
      e.minutes += qty * cnc.bedframeSetMin;
    } else if (cat === "SOFA") {
      sofaSets += qty;
      e.sofaSets += qty;
      e.minutes += qty * cnc.sofaSetMin;
    } else {
      accessoryPieces += qty;
      e.accessoryPieces += qty;
      e.minutes += qty * cnc.accessoryPieceMin;
    }
    byFabric.set(fab, e);
  }
  const cuttingMinutes =
    bedframeSets * cnc.bedframeSetMin +
    sofaSets * cnc.sofaSetMin +
    accessoryPieces * cnc.accessoryPieceMin;
  const fabricCount = byFabric.size;
  const changeoverMinutes = fabricCount * cnc.fabricChangeMin;
  const totalMinutes = cuttingMinutes + changeoverMinutes;
  const topFabrics = [...byFabric.values()]
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 8);
  return {
    bedframeSets,
    sofaSets,
    accessoryPieces,
    fabricCount,
    cuttingMinutes,
    changeoverMinutes,
    totalMinutes,
    referenceDays:
      cnc.referenceDayMin > 0
        ? Math.round((totalMinutes / (cnc.referenceDayMin * cnc.machines)) * 10) / 10
        : 0,
    topFabrics,
  };
}

// ---------------------------------------------------------------------------
// Drift check — actual CNC minutes/set over the last 7 calendar days vs the
// configured model. FAB_CUT est/actualMinutes are already the per-CARD total
// (NOT ×wipQty — see job-card-minutes.ts), so rate = Σminutes ÷ Σsets.
// ---------------------------------------------------------------------------

async function collectCutRateDrift(
  db: DbLike,
  cnc: CapacityConfig["cnc"],
  today: string,
): Promise<CutRateDrift[]> {
  const since = (() => {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  })();
  const res = await db
    .prepare(
      `SELECT COALESCE(po.itemCategory,'') AS cat,
              SUM(COALESCE(jc.actualMinutes, jc.estMinutes, 0)) AS mins,
              SUM(COALESCE(jc.wipQty, 1)) AS sets
         FROM job_cards jc
         JOIN production_orders po ON po.id = jc.productionOrderId
        WHERE jc.departmentCode = 'FAB_CUT'
          AND jc.status IN ('COMPLETED','TRANSFERRED')
          AND substr(jc.completedDate::text, 1, 10) >= ?
        GROUP BY 1`,
    )
    .bind(since)
    .all<{ cat: string; mins: number | string; sets: number | string }>();
  const actualByCat = new Map<string, { mins: number; sets: number }>();
  for (const r of res.results ?? []) {
    actualByCat.set((r.cat || "").toUpperCase(), {
      mins: Number(r.mins) || 0,
      sets: Number(r.sets) || 0,
    });
  }
  const spec: Array<{ category: CutRateDrift["category"]; configuredMin: number }> = [
    { category: "BEDFRAME", configuredMin: cnc.bedframeSetMin },
    { category: "SOFA", configuredMin: cnc.sofaSetMin },
    { category: "ACCESSORY", configuredMin: cnc.accessoryPieceMin },
  ];
  return spec.map(({ category, configuredMin }) => {
    const a = actualByCat.get(category);
    if (!a || a.sets <= 0 || a.mins <= 0) {
      return { category, configuredMin, actualMin: null, sets: a?.sets ?? 0, driftPct: null, flagged: false };
    }
    const actualMin = Math.round((a.mins / a.sets) * 10) / 10;
    const driftPct = Math.round(((actualMin - configuredMin) / configuredMin) * 100);
    return {
      category,
      configuredMin,
      actualMin,
      sets: a.sets,
      driftPct,
      flagged: Math.abs(driftPct) > 25,
    };
  });
}

// ---------------------------------------------------------------------------
// AI focus — optional, best-effort, never blocks the brief.
// ---------------------------------------------------------------------------

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const BRIEF_MODEL = "claude-sonnet-4-5-20250929"; // same as the in-app assistant

async function generateAiFocus(
  apiKey: string | undefined,
  data: Omit<BriefData, "aiFocus">,
  usageSink?: { tokensIn: number; tokensOut: number },
): Promise<string | null> {
  if (!apiKey) return null;
  try {
    const compact = {
      date: data.date,
      todayPlan: {
        jobCards: data.schedule.totals.jobCards,
        departments: data.schedule.byDepartment.map((d) => ({
          dept: d.name,
          cards: d.count,
          minutes: d.prodMinutes,
        })),
      },
      cncQueue: {
        bedframeSets: data.cnc.bedframeSets,
        sofaSets: data.cnc.sofaSets,
        accessoryPieces: data.cnc.accessoryPieces,
        fabrics: data.cnc.fabricCount,
        totalHours: Math.round(data.cnc.totalMinutes / 6) / 10,
        referenceDays: data.cnc.referenceDays,
        topFabrics: data.cnc.topFabrics.slice(0, 5).map((f) => ({
          fabric: f.fabricCode,
          minutes: f.minutes,
        })),
      },
      overdue: {
        count: data.overdue.totals.salesOrders,
        worstDays: data.overdue.totals.worstDays,
        top: data.overdue.rows.slice(0, 5).map((r) => ({
          so: r.companySOId,
          customer: r.customerName,
          daysLate: r.daysOverdue,
        })),
      },
      yesterday: {
        date: data.prevDate,
        efficiencyPct: data.efficiency.totals.efficiencyPct,
        present: data.efficiency.totals.presentCount,
        lowWorkers: data.lowWorkers.slice(0, 5),
      },
      cutRateDrift: data.drift.filter((d) => d.flagged),
      pendingScheduleProposals: data.proposals.pending,
      // Phase 3 learning payload — adherence + parameter drift + humane OT
      // outlook so the AI focus can point at the day's real lever.
      learning: data.learning
        ? {
            planAdherencePct: data.learning.overallAdherencePct,
            worstDepts: data.learning.adherence
              .filter((a) => a.adherencePct != null && a.adherencePct < 80)
              .slice(0, 3)
              .map((a) => ({
                dept: a.dept,
                adherencePct: a.adherencePct,
                reason: a.topReason,
              })),
            handoffDrift: data.learning.handoffs
              .filter((h) => h.flagged)
              .map((h) => ({
                chain: `${h.fromDepts.join("/")}->${h.toDept}`,
                configuredDays: h.configuredDays,
                actualDays: h.actualAvgDays,
              })),
            pendingConfigProposals: data.learning.pendingConfigProposals,
            otOutlook: data.learning.ot.slice(0, 3).map((o) => ({
              dept: o.dept,
              mode: o.mode,
              overloadedDays: o.overloadedDays.length,
              note: o.note,
            })),
          }
        : null,
    };
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: BRIEF_MODEL,
        max_tokens: 700,
        system:
          "你是 Hookka 家具厂的生产 Agent。根据 JSON 数据用中文写一段《今日焦点》给老板：" +
          "4-6 句话，先讲今天最要紧的事（逾期最严重的单、CNC 排布建议——同布料的排在一起换布最少、" +
          "哪个部门今天最重),再点出昨天的异常（效率低的人、切割速度和配置偏差)。" +
          "口吻直接、工厂白话、不用技术词。只输出这段话本身，不要标题、不要列表符号。",
        messages: [
          { role: "user", content: JSON.stringify(compact) },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[brief/ai] Anthropic ${res.status}`);
      return null;
    }
    const j = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    // Surface Anthropic token usage to the Agent Console's run log.
    if (usageSink && j.usage) {
      usageSink.tokensIn += Number(j.usage.input_tokens) || 0;
      usageSink.tokensOut += Number(j.usage.output_tokens) || 0;
    }
    const text = (j.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("")
      .trim();
    return text || null;
  } catch (err) {
    console.warn("[brief/ai] failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export async function collectBriefData(
  db: DbLike,
  date: string,
  prevDate: string,
  anthropicApiKey?: string,
  opts: BriefOptions = {},
): Promise<BriefData> {
  const cfg = await loadCapacityConfig(db);
  const [schedule, overdue, efficiency, cnc, drift, pendingProposals, learning] =
    await Promise.all([
      collectScheduleData(db as never, date),
      collectOverdueData(db as never, date),
      collectEfficiencyData(db as never, prevDate),
      collectCncQueue(db, cfg.cnc),
      collectCutRateDrift(db, cfg.cnc, date),
      collectPendingProposals(db),
      // Phase 3 — optional + best-effort: a learner error never sinks the brief.
      opts.learning
        ? runLearning(db as never, {
            emitProposals: opts.emitConfigProposals === true,
          }).catch((err) => {
            console.warn("[brief/learning] failed:", err);
            return null;
          })
        : Promise.resolve(null),
    ]);
  const lowWorkers = efficiency.workers
    .filter((w) => w.workingMinutes > 0 && w.efficiencyPct < 60)
    .sort((a, b) => a.efficiencyPct - b.efficiencyPct)
    .slice(0, 10)
    .map((w) => ({
      name: w.name,
      departmentName: w.departmentName,
      pct: w.efficiencyPct,
    }));
  const base: Omit<BriefData, "aiFocus"> = {
    date,
    prevDate,
    generatedAtIso: new Date().toISOString(),
    schedule,
    overdue,
    efficiency,
    lowWorkers,
    cnc,
    cncConfig: cfg.cnc,
    drift,
    proposals: { pending: pendingProposals },
    learning,
  };
  const aiFocus = await generateAiFocus(anthropicApiKey, base, opts.usageSink);
  return { ...base, aiFocus };
}

// ---------------------------------------------------------------------------
// Renderers — email-safe HTML (inline styles, tables) + plain text.
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function hm(min: number): string {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
}

export function renderBriefHtml(d: BriefData): string {
  const deptRows = d.schedule.byDepartment
    .map(
      (x) =>
        `<tr><td style="padding:4px 10px;border-bottom:1px solid #eee">${esc(x.name)}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${x.count}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${x.quantity}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${hm(x.prodMinutes)}</td></tr>`,
    )
    .join("");
  const fabricRows = d.cnc.topFabrics
    .map(
      (f) =>
        `<tr><td style="padding:4px 10px;border-bottom:1px solid #eee">${esc(f.fabricCode)}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${f.bedframeSets}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${f.sofaSets}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${f.accessoryPieces}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${hm(f.minutes)}</td></tr>`,
    )
    .join("");
  const overdueRows = d.overdue.rows
    .slice(0, 8)
    .map(
      (r) =>
        `<tr><td style="padding:4px 10px;border-bottom:1px solid #eee">${esc(r.companySOId)}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee">${esc(r.customerName)}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee">${esc(r.productSummary)}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right;color:#9A3A2D;font-weight:600">${r.daysOverdue}d late</td></tr>`,
    )
    .join("");
  const lowRows = d.lowWorkers
    .map(
      (w) =>
        `<tr><td style="padding:4px 10px;border-bottom:1px solid #eee">${esc(w.name)}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee">${esc(w.departmentName)}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right;color:#9A3A2D">${w.pct}%</td></tr>`,
    )
    .join("");
  const driftRows = d.drift
    .map((x) => {
      const actual = x.actualMin == null ? "—" : `${x.actualMin} min`;
      const drift =
        x.driftPct == null
          ? "—"
          : `${x.driftPct > 0 ? "+" : ""}${x.driftPct}%`;
      const color = x.flagged ? "#9A3A2D" : "#4F7C3A";
      return (
        `<tr><td style="padding:4px 10px;border-bottom:1px solid #eee">${x.category}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${x.configuredMin} min</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${actual}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right;color:${color};font-weight:600">${drift}${x.flagged ? " ⚠" : ""}</td></tr>`
      );
    })
    .join("");
  const h2 = 'style="font:600 15px/1.3 Arial;margin:22px 0 8px;color:#1F1D1B"';
  const th = 'style="padding:5px 10px;text-align:left;background:#F0ECE9;font:600 12px Arial;color:#374151"';
  const thR = 'style="padding:5px 10px;text-align:right;background:#F0ECE9;font:600 12px Arial;color:#374151"';
  const table = 'style="border-collapse:collapse;width:100%;font:13px Arial;color:#1F1D1B"';
  return `<!doctype html><html><body style="margin:0;padding:20px;background:#FAF9F7;font-family:Arial">
<div style="max-width:720px;margin:0 auto;background:#fff;border:1px solid #E2DDD8;border-radius:10px;padding:24px">
<div style="border-bottom:2px solid #1F1D1B;padding-bottom:10px;margin-bottom:6px">
  <div style="font:700 20px Georgia;color:#1F1D1B">Hookka · Production Morning Brief</div>
  <div style="font:12px Arial;color:#6B7280;margin-top:2px">${d.date} · plan for today, actuals from ${d.prevDate}</div>
</div>
${d.aiFocus ? `<div style="background:#FBF7EC;border:1px solid #E2D9C3;border-radius:8px;padding:12px 14px;font:14px/1.6 Arial;color:#4B3F1D;margin:14px 0">${esc(d.aiFocus)}</div>` : ""}
${d.proposals.pending > 0 ? `<div style="background:#EEF3EA;border:1px solid #CBDCC0;border-radius:8px;padding:10px 14px;font:13px/1.5 Arial;color:#33512A;margin:14px 0">排产提案：<b>${d.proposals.pending}</b> 张卡待批准排产 — Planning &gt; Schedule Proposals 里一键批准后写入交期。</div>` : ""}
<h2 ${h2}>1 · Today's Plan — ${d.schedule.totals.jobCards} job cards · ${hm(d.schedule.totals.prodMinutes)}</h2>
<table ${table}><tr><th ${th}>Department</th><th ${thR}>Cards</th><th ${thR}>Units</th><th ${thR}>Time</th></tr>${deptRows || `<tr><td colspan="4" style="padding:8px 10px;color:#9CA3AF">Nothing due today.</td></tr>`}</table>
<h2 ${h2}>2 · CNC Cutting Queue — ${hm(d.cnc.totalMinutes)} (≈ ${d.cnc.referenceDays} days)</h2>
<div style="font:12px Arial;color:#6B7280;margin-bottom:6px">
  ${d.cnc.bedframeSets} bedframe sets × ${d.cncConfig.bedframeSetMin}m · ${d.cnc.sofaSets} sofa sets × ${d.cncConfig.sofaSetMin}m · ${d.cnc.accessoryPieces} accessories × ${d.cncConfig.accessoryPieceMin}m ·
  ${d.cnc.fabricCount} fabrics × ${d.cncConfig.fabricChangeMin}m changeover = ${hm(d.cnc.changeoverMinutes)} lost to fabric changes.
  Cut same-fabric batches together to keep changeovers down.
</div>
<table ${table}><tr><th ${th}>Fabric</th><th ${thR}>BF sets</th><th ${thR}>Sofa sets</th><th ${thR}>Acc</th><th ${thR}>Cut time</th></tr>${fabricRows || `<tr><td colspan="5" style="padding:8px 10px;color:#9CA3AF">CNC queue is empty.</td></tr>`}</table>
<h2 ${h2}>3 · Overdue — ${d.overdue.totals.salesOrders} orders (worst ${d.overdue.totals.worstDays}d)</h2>
<table ${table}><tr><th ${th}>SO</th><th ${th}>Customer</th><th ${th}>Items</th><th ${thR}>Late</th></tr>${overdueRows || `<tr><td colspan="4" style="padding:8px 10px;color:#4F7C3A">Nothing overdue 🎉</td></tr>`}</table>
<h2 ${h2}>4 · Yesterday (${d.prevDate}) — ${d.efficiency.totals.efficiencyPct}% overall efficiency · ${d.efficiency.totals.presentCount} present</h2>
<table ${table}><tr><th ${th}>Below 60%</th><th ${th}>Department</th><th ${thR}>Efficiency</th></tr>${lowRows || `<tr><td colspan="3" style="padding:8px 10px;color:#4F7C3A">Nobody below 60% yesterday.</td></tr>`}</table>
<h2 ${h2}>5 · CNC Speed Check — last 7 days vs configured</h2>
<table ${table}><tr><th ${th}>Category</th><th ${thR}>Configured</th><th ${thR}>Actual /set</th><th ${thR}>Drift</th></tr>${driftRows}</table>
<div style="font:11px Arial;color:#9CA3AF;margin-top:6px">⚠ = actual speed is >25% off the configured model — worth updating the CNC settings (Planning → capacity config).</div>
${renderLearningHtml(d, h2, th, thR, table)}
<div style="border-top:1px solid #E2DDD8;margin-top:20px;padding-top:10px;font:11px Arial;color:#9CA3AF">
  Generated ${d.generatedAtIso} · Hookka Production Agent · full detail in the ERP dashboard (Agent Console: /agents).
</div>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Phase 3 — learning-loop sections (6 plan-vs-actual · 7 parameter proposals
// · 8 forward OT outlook). Renders nothing when learning was skipped/failed.
// ---------------------------------------------------------------------------

function renderLearningHtml(
  d: BriefData,
  h2: string,
  th: string,
  thR: string,
  table: string,
): string {
  const L = d.learning;
  if (!L) return "";

  const adherenceRows = L.adherence
    .map((a) => {
      const pct = a.adherencePct == null ? "—" : `${a.adherencePct}%`;
      const color =
        a.adherencePct == null || a.adherencePct >= 80 ? "#4F7C3A" : "#9A3A2D";
      return (
        `<tr><td style="padding:4px 10px;border-bottom:1px solid #eee">${esc(a.dept)}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${a.due}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${a.onTime}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${a.late + a.stillOpen}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right;color:${color};font-weight:600">${pct}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;font:11px Arial;color:#6B7280">${esc(a.topReason ?? "—")}</td></tr>`
      );
    })
    .join("");

  const handoffRows = L.handoffs
    .map((h) => {
      const actual = h.actualAvgDays == null ? "—" : `${h.actualAvgDays}d`;
      const drift =
        h.driftDays == null ? "—" : `${h.driftDays > 0 ? "+" : ""}${h.driftDays}d`;
      const color = h.flagged ? "#9A3A2D" : "#4F7C3A";
      return (
        `<tr><td style="padding:4px 10px;border-bottom:1px solid #eee">${esc(h.fromDepts.join("/"))} → ${esc(h.toDept)}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${h.configuredDays}d</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${actual}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${h.samples}</td>` +
        `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right;color:${color};font-weight:600">${drift}${h.flagged ? " ⚠" : ""}</td></tr>`
      );
    })
    .join("");

  const otBlocks = L.ot
    .map((o) => {
      const dayRows = o.overloadedDays
        .slice(0, 10)
        .map(
          (day) =>
            `<tr><td style="padding:4px 10px;border-bottom:1px solid #eee">${day.date}</td>` +
            `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right;color:#9A3A2D;font-weight:600">${day.overloadPct}%</td>` +
            `<td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right">${day.suggestedOtHours > 0 ? `${day.suggestedOtHours}h` : "spread"}</td>` +
            `<td style="padding:4px 10px;border-bottom:1px solid #eee;font:11px Arial;color:#6B7280">${esc(day.soRefs.join(", ") || "—")}</td></tr>`,
        )
        .join("");
      const delays =
        o.delayCandidates.length > 0
          ? `<div style="font:12px Arial;color:#9A3A2D;margin-top:4px">Delay candidates (latest customer DD first): ${esc(
              o.delayCandidates
                .map((x) => `${x.soRef}${x.customerDd ? ` (DD ${x.customerDd})` : ""}`)
                .join(" · "),
            )}</div>`
          : "";
      return `<div style="margin:10px 0">
<div style="font:600 13px Arial;color:#1F1D1B">${esc(o.dept)} — ${o.mode === "SPREAD" ? "rebalance (no OT)" : o.mode === "OT" ? "early spread OT" : "OT caps insufficient — delay orders"}</div>
<div style="font:12px Arial;color:#6B7280;margin:2px 0 4px">${esc(o.note)}</div>
<table ${table}><tr><th ${th}>Date</th><th ${thR}>Load</th><th ${thR}>OT (≤2h)</th><th ${th}>Affected SOs</th></tr>${dayRows}</table>
${delays}</div>`;
    })
    .join("");

  return `
<h2 ${h2}>6 · Plan vs Actual (${L.prevDate}) — ${L.overallAdherencePct == null ? "nothing was due" : `${L.overallAdherencePct}% adherence`}</h2>
<table ${table}><tr><th ${th}>Department</th><th ${thR}>Due</th><th ${thR}>On time</th><th ${thR}>Missed</th><th ${thR}>Adherence</th><th ${th}>Top slippage reason</th></tr>${adherenceRows || `<tr><td colspan="6" style="padding:8px 10px;color:#9CA3AF">No job cards were due.</td></tr>`}</table>
<h2 ${h2}>7 · Handoff Learning — actual vs configured (last 30 days)</h2>
<table ${table}><tr><th ${th}>Chain step</th><th ${thR}>Configured</th><th ${thR}>Actual avg</th><th ${thR}>Orders</th><th ${thR}>Drift</th></tr>${handoffRows}</table>
<div style="font:11px Arial;color:#9CA3AF;margin-top:6px">⚠ = sustained drift >1 working day — a parameter proposal is raised for your approval.${L.pendingConfigProposals > 0 ? ` <b style="color:#6B5C32">${L.pendingConfigProposals} parameter proposal(s) pending in the Agent Console.</b>` : ""}</div>
<h2 ${h2}>8 · Forward OT Outlook — next 21 working days${L.ot.length === 0 ? " — all clear" : ""}</h2>
${otBlocks || `<div style="font:13px Arial;color:#4F7C3A">No department is overloaded in the window — no OT needed.</div>`}
<div style="font:11px Arial;color:#9CA3AF;margin-top:6px">Rules: spread to lighter days FIRST; OT only as a fallback, max 2h/day, started early and spread flat — never a last-minute spike. If capped OT still isn't enough, the humane answer is to delay the lowest-priority orders and inform customers early.</div>`;
}

export function renderBriefEmailText(d: BriefData): string {
  const lines: string[] = [];
  lines.push(`Hookka Production Morning Brief — ${d.date}`);
  if (d.aiFocus) {
    lines.push("", d.aiFocus);
  }
  lines.push(
    "",
    `1) Today's plan: ${d.schedule.totals.jobCards} job cards, ${hm(d.schedule.totals.prodMinutes)} across ${d.schedule.totals.departments} departments.`,
    `2) CNC queue: ${d.cnc.bedframeSets} BF sets + ${d.cnc.sofaSets} sofa sets + ${d.cnc.accessoryPieces} accessories over ${d.cnc.fabricCount} fabrics = ${hm(d.cnc.totalMinutes)} (~${d.cnc.referenceDays} days incl. ${hm(d.cnc.changeoverMinutes)} of fabric changes).`,
    `3) Overdue: ${d.overdue.totals.salesOrders} orders, worst ${d.overdue.totals.worstDays} days.`,
    `4) Yesterday (${d.prevDate}): ${d.efficiency.totals.efficiencyPct}% overall; ${d.lowWorkers.length} worker(s) below 60%.`,
  );
  const flagged = d.drift.filter((x) => x.flagged);
  if (flagged.length > 0) {
    lines.push(
      `5) CNC speed drift: ${flagged
        .map((x) => `${x.category} actual ${x.actualMin}m vs configured ${x.configuredMin}m (${x.driftPct}%)`)
        .join("; ")} — consider updating the CNC config.`,
    );
  }
  if (d.proposals.pending > 0) {
    lines.push(`排产提案: ${d.proposals.pending} 张卡待批准排产 (Planning > Schedule Proposals).`);
  }
  const L = d.learning;
  if (L) {
    lines.push(
      `6) Plan vs actual (${L.prevDate}): ` +
        (L.overallAdherencePct == null
          ? "nothing was due."
          : `${L.overallAdherencePct}% adherence.` +
            (() => {
              const worst = L.adherence.filter(
                (a) => a.adherencePct != null && a.adherencePct < 80,
              );
              return worst.length > 0
                ? ` Worst: ${worst
                    .slice(0, 3)
                    .map((a) => `${a.dept} ${a.adherencePct}% (${a.topReason ?? "?"})`)
                    .join("; ")}.`
                : "";
            })()),
    );
    const flaggedHandoffs = L.handoffs.filter((h) => h.flagged);
    if (flaggedHandoffs.length > 0 || L.pendingConfigProposals > 0) {
      lines.push(
        `7) Handoff learning: ${flaggedHandoffs
          .map(
            (h) =>
              `${h.fromDepts.join("/")}->${h.toDept} actual ${h.actualAvgDays}d vs configured ${h.configuredDays}d`,
          )
          .join("; ")}${flaggedHandoffs.length > 0 ? " — " : ""}${L.pendingConfigProposals} parameter proposal(s) pending approval (Agent Console).`,
      );
    }
    if (L.ot.length > 0) {
      lines.push(
        `8) Forward OT outlook (21 working days): ${L.ot
          .map(
            (o) =>
              `${o.dept} ${o.mode === "SPREAD" ? "rebalance, no OT" : o.mode === "OT" ? `early spread OT (max 2h/day)` : "OT caps insufficient — delay lowest-priority orders"} — ${o.overloadedDays.length} overloaded day(s)`,
          )
          .join("; ")}.`,
      );
    } else {
      lines.push("8) Forward OT outlook: all clear — no OT needed in the window.");
    }
  }
  return lines.join("\n");
}
