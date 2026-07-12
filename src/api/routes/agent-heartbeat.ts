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
import { isKillSwitchOn, recordAgentRun, llmKeyIfBudgetAllows } from "../lib/agent-console";
import { decideAgentRuns } from "../lib/agent-scheduler";
import { generateProposals } from "../lib/schedule-proposals";
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

  const { decisions, skipped } = await decideAgentRuns(db);
  const ran: Array<{ task: string; reason: string; summary?: string }> = [];

  for (const d of decisions) {
    try {
      if (d.task === "delivery-run") {
        await recordAgentRun(db, "delivery-run", async (run) => {
          const sink = { tokensIn: 0, tokensOut: 0 };
          const r = await runDeliveryAgent(db, DEFAULT_ORG_ID, {
            // Token control: fresh AI focus only on the day's first run, and
            // only while the monthly LLM budget cap has headroom.
            anthropicApiKey: d.firstOfDay
              ? await llmKeyIfBudgetAllows(db, c.env.ANTHROPIC_API_KEY)
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

  return c.json({ ok: true, ran, skipped });
});
