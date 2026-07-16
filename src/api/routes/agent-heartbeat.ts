// ---------------------------------------------------------------------------
// agent-heartbeat.ts — POST /api/internal/agents/heartbeat (CRON_SECRET).
//
// The external cron (GH Actions, every 30 min) is deliberately DUMB: it just
// beats. Which agents actually run on a given beat is decided by the agents
// themselves in lib/agent-scheduler.ts from the factory's live pulse (owner
// ruling 2026-07-12: cadence is the agent's decision, not the owner's).
//
// Per beat: decideAgentRuns() → execute each decision inside recordAgentRun
// (console visibility + token accounting), with the decision's REASON in the
// run summary so the console always answers "why did it run at 14:30?".
//
// Overrides honoured here: global kill switch stops every run; per-family
// pause is already respected inside the decision pass. LLM spend control:
// only the first delivery run of the day writes a fresh AI focus — extra
// event-driven sweeps are pure engine (zero tokens).
//
// The punctual 07:00 report cron (brief + learning) and the 07:30 delivery
// cron stay as-is; the heartbeat sees their agent_runs rows and self-skips,
// acting as their fallback when they fail.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { DEFAULT_ORG_ID } from "../lib/tenant";
import {
  isAgentPaused,
  isAutoApproveOn,
  isAutoTuneOn,
  isKillSwitchOn,
  recordAgentRun,
  llmKeyIfBudgetAllows,
} from "../lib/agent-console";
import { runEmployeeDigest } from "../lib/employee-agent";
import { runServiceDigest } from "../lib/service-agent";
import { decideAgentRuns } from "../lib/agent-scheduler";
import { generateProposals, applyPendingProposals } from "../lib/schedule-proposals";
import { autoApplyConfigProposals } from "../lib/agent-learning";
import { runDeliveryAgent, constantTimeEqual } from "./delivery-agent";

const app = new Hono<Env>();
export default app;

app.post("/heartbeat", async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[agents/heartbeat] CRON_SECRET unset or too short — refusing");
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }

  const db = c.var.DB;
  if (await isKillSwitchOn(db)) {
    return c.json({ ok: true, ran: [], skipped: [{ task: "ALL", reason: "kill switch" }] });
  }

  // Run the beat in the BACKGROUND and return immediately (owner 2026-07-15).
  // Once the agents were un-paused, one beat does generate ~1600 + apply a
  // batch synchronously — that ran past the cron's 120s curl timeout, which
  // returned HTTP 000 and GitHub marked the beat "failed" (looked like the
  // agents clocked off at night). waitUntil lets the worker finish the beat
  // after the response, so the cron always sees a fast 200.
  c.executionCtx.waitUntil(
    (async () => {
      try {
  const ran: Array<{ task: string; reason: string; summary?: string }> = [];

  // ── 0 · Reap stuck runs ────────────────────────────────────────────────────
  // A run killed mid-flight (Worker limits) leaves its agent_runs row at
  // 'running' forever: the console shows a permanent RUNNING and the row still
  // counts toward runsToday, starving the real work. Anything still 'running'
  // after 15 minutes is dead — mark it errored so the console tells the truth.
  try {
    const stuckCut = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await db
      .prepare(
        `UPDATE agent_runs SET status = 'error', finished_at = ?,
                error = 'killed mid-run (exceeded worker limits)'
          WHERE status = 'running' AND started_at < ?`,
      )
      .bind(new Date().toISOString(), stuckCut)
      .run();
  } catch (err) {
    console.warn("[agents/heartbeat] stuck-run reap failed:", err);
  }

  // ── 1 · Backlog drain FIRST ────────────────────────────────────────────────
  // Applying queued due dates is the light, high-value work; generating fresh
  // proposals is the heavy engine run. It used to be the other way round, so a
  // heavy generation that blew the Worker's limits killed the whole beat before
  // a single due date was written — the backlog grew to 1,700 while the console
  // said full-auto (owner 2026-07-16). Drain first: even if generation dies
  // later this beat, the queue still moved.
  try {
    const hourDrain = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
    if (hourDrain >= 8 && hourDrain < 20 && (await isAutoApproveOn(db, "PRODUCTION"))) {
      const pend = await db
        .prepare("SELECT COUNT(*) AS n FROM schedule_proposals WHERE status = 'PENDING'")
        .bind()
        .first<{ n: number | string }>();
      if ((Number(pend?.n) || 0) > 0) {
        await recordAgentRun(db, "production-proposals", async (run) => {
          const a = await applyPendingProposals(db, { decidedBy: "AGENT_AUTO", limit: 150 });
          const summary = `auto-applied ${a.approved} queued due date(s), ${a.remainingPending} remaining (heartbeat drain)`;
          run.setSummary(summary);
          ran.push({ task: "production-proposals", reason: "backlog drain", summary });
          return a;
        });
      }
    }
  } catch (err) {
    console.error("[agents/heartbeat] backlog drain failed:", err);
  }

  const { decisions, skipped } = await decideAgentRuns(db);

  for (const d of decisions) {
    try {
      if (d.task === "delivery-run") {
        await recordAgentRun(db, "delivery-run", async (run) => {
          const sink = { tokensIn: 0, tokensOut: 0 };
          const r = await runDeliveryAgent(db, DEFAULT_ORG_ID, {
            // Token control: fresh AI focus only on the day's first run, and
            // only while the monthly LLM budget cap has headroom.
            anthropicApiKey: d.firstOfDay
              ? await llmKeyIfBudgetAllows(db, c.env.ANTHROPIC_API_KEY, "DELIVERY")
              : undefined,
            usageSink: sink,
          });
          run.addTokens(sink.tokensIn, sink.tokensOut);
          const summary = `${r.date} · plans ${r.proposals.loadPlans} · invoice gaps ${r.proposals.invoiceGaps} · POD ${r.proposals.podChases} · transit drifts ${r.transitDrifts} (heartbeat: ${d.reason})`;
          run.setSummary(summary);
          ran.push({ task: d.task, reason: d.reason, summary });
          return r;
        });
      } else if (d.task === "production-proposals") {
        // GENERATE ONLY. Generation is a full run of the planning engine over
        // every WAITING card; bolting the apply onto the same invocation blew
        // the Worker's limits and the run got killed before writing a single
        // due date (owner 2026-07-16 — backlog hit 1,700 under "full-auto").
        // The drain at the top of the beat does the applying, on its own.
        await recordAgentRun(db, "production-proposals", async (run) => {
          const r = await generateProposals(db);
          const summary = `proposed ${r.proposed} (unscheduled ${r.unscheduled} · overdue ${r.overdue} · superseded ${r.superseded}) (heartbeat: ${d.reason})`;
          run.setSummary(summary);
          ran.push({ task: d.task, reason: d.reason, summary });
          return r;
        });
      }
    } catch (err) {
      // One agent's failure never blocks another's beat; the error row is
      // already in agent_runs via recordAgentRun.
      console.error(`[agents/heartbeat] ${d.task} failed:`, err);
      skipped.push({ task: d.task, reason: "run errored (see agent_runs)" });
    }
  }

  // Config-param auto-apply sweep (owner 2026-07-15: "flag 亮着参数还躺着").
  // The AUTO-APPROVE flag must MEAN "the agent applies its own learned params".
  // This used to be trapped inside the gated production-proposals decision, so
  // the flag could be ON while params sat PENDING (production is capped at 3
  // runs/day, and the delivery cs.transitDays.* params were never swept here at
  // all — only PRODUCTION was). Now it runs every beat, for BOTH families,
  // gated only by each family's own flag (isAutoApproveOn is already false when
  // the family is paused) + working hours (clocks off after 8pm like the rest).
  try {
    const hourMytSweep = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
    if (hourMytSweep >= 8 && hourMytSweep < 20) {
      for (const family of ["PRODUCTION", "DELIVERY"] as const) {
        if (await isAutoTuneOn(db, family)) {
          const n = await autoApplyConfigProposals(db, family, "AGENT_AUTO").catch((err) => {
            console.warn(`[agents/heartbeat] ${family} param sweep failed:`, err);
            return 0;
          });
          if (n > 0) {
            ran.push({
              task: `${family.toLowerCase()}-param-tune`,
              reason: "auto-approve flag on",
              summary: `self-tuned ${n} param(s)`,
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("[agents/heartbeat] param sweep failed:", err);
  }

  // Employee daily digest — the Employee agent's read-only run (owner 0716).
  // Fires once per working day after 07:00 MYT: recomputes the anomaly counts
  // and refreshes the console snapshot. Idempotent (overwrites the snapshot),
  // so the once-a-day guard need not be exact around midnight.
  try {
    const mytE = new Date(Date.now() + 8 * 3600 * 1000);
    const hourE = mytE.getUTCHours();
    const todayE = mytE.toISOString().slice(0, 10);
    if (hourE >= 7 && hourE < 20 && !(await isAgentPaused(db, "EMPLOYEE"))) {
      const already = await db
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_runs WHERE agent = 'employee-agent' AND status <> 'error' AND substr(started_at,1,10) = ?",
        )
        .bind(todayE)
        .first<{ n: number | string }>();
      if ((Number(already?.n) || 0) === 0) {
        await recordAgentRun(db, "employee-agent", async (run) => {
          const digest = await runEmployeeDigest(db);
          await db
            .prepare(
              `INSERT INTO kv_config (key, value) VALUES ('employee-digest', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            )
            .bind(
              JSON.stringify({
                date: digest.date,
                counts: digest.counts,
                generatedAt: new Date().toISOString(),
              }),
            )
            .run()
            .catch(() => {});
          run.setSummary(
            `${digest.date} · absent ${digest.counts.absent} · late ${digest.counts.late} · pending approvals ${digest.counts.pendingApprovals} · low-eff ${digest.counts.lowEfficiency} (daily)`,
          );
          ran.push({ task: "employee-agent", reason: "daily digest", summary: "employee digest" });
          return digest;
        });
      }
    }
  } catch (err) {
    console.error("[agents/heartbeat] employee digest failed:", err);
  }

  // Service (after-sales) daily digest — same once-per-working-day cadence.
  try {
    const mytS = new Date(Date.now() + 8 * 3600 * 1000);
    const hourS = mytS.getUTCHours();
    const todayS = mytS.toISOString().slice(0, 10);
    if (hourS >= 7 && hourS < 20 && !(await isAgentPaused(db, "SERVICE"))) {
      const already = await db
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_runs WHERE agent = 'service-agent' AND status <> 'error' AND substr(started_at,1,10) = ?",
        )
        .bind(todayS)
        .first<{ n: number | string }>();
      if ((Number(already?.n) || 0) === 0) {
        await recordAgentRun(db, "service-agent", async (run) => {
          const digest = await runServiceDigest(db);
          await db
            .prepare(
              `INSERT INTO kv_config (key, value) VALUES ('service-digest', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            )
            .bind(
              JSON.stringify({
                date: digest.date,
                counts: digest.counts,
                generatedAt: new Date().toISOString(),
              }),
            )
            .run()
            .catch(() => {});
          run.setSummary(
            `${digest.date} · new cases ${digest.counts.newCases} · untriaged ${digest.counts.untriaged} · QC fails ${digest.counts.qcFails} (daily)`,
          );
          ran.push({ task: "service-agent", reason: "daily digest", summary: "service digest" });
          return digest;
        });
      }
    }
  } catch (err) {
    console.error("[agents/heartbeat] service digest failed:", err);
  }

      } catch (beatErr) {
        console.error("[agents/heartbeat] background beat failed:", beatErr);
      }
    })(),
  );
  return c.json({ ok: true, background: true });
});
