// ---------------------------------------------------------------------------
// hookka-agent-heartbeat — standalone Cloudflare Cron Worker
// ---------------------------------------------------------------------------
// Self-contained. NOT part of the hookka-erp-testing Pages app.
//
// WHY THIS EXISTS
//   The ERP's agent system (production scheduler, delivery agent, employee /
//   service digests, backlog drain, the punctual 07:00 report + 07:30 delivery
//   crons' fallback) is driven by a single dumb beat: POST
//   /api/internal/agents/heartbeat. The endpoint carries NO cadence knowledge —
//   each beat it asks the scheduler which agents are due and self-throttles
//   (min 1h gap between real agent runs, max 6/day, per-agent once-a-day
//   digests, owner Pause / kill switch). So calling it too often is HARMLESS:
//   every extra beat just self-skips work that already ran.
//
//   The beat used to be driven ONLY by GitHub Actions cron
//   (.github/workflows/agent-heartbeat.yml). GitHub does NOT honour a schedule:
//   measured 2026-07-16, a nominally-hourly beat actually fired every 1–3.5
//   HOURS (a 23:58 → 03:27 gap), starving every agent and delaying the morning
//   brief. Cloudflare's own Cron Triggers fire on time, so this worker is the
//   RELIABLE driver; the GitHub workflow stays as a belt-and-suspenders
//   fallback (the endpoint dedups/self-throttles, so double-firing is a no-op).
//
//   Pages Functions cannot host a Cron Trigger (Workers-only) — see the root
//   wrangler.toml "Cron Trigger" note. Hence this sibling Worker, mirroring the
//   hookka-mail-inbound pattern.
//
// WHAT IT DOES
//   On each scheduled() tick: POST HEARTBEAT_URL with the x-cron-secret header
//   (constant-time-compared server-side against the ERP's CRON_SECRET). That's
//   it — all the intelligence lives in the endpoint. A non-200 is logged and
//   rethrown so the failure shows in `wrangler tail` / the CF dashboard.
// ---------------------------------------------------------------------------

interface Env {
  // Shared secret presented to the ERP as `x-cron-secret`. MUST equal the ERP's
  // CRON_SECRET (>= 16 chars). Secret — set via `wrangler secret put CRON_SECRET`,
  // never in wrangler.toml.
  CRON_SECRET: string;
  // The ERP heartbeat endpoint. Plain var (not a secret) so it travels with the
  // deploy: https://erp.hookka.com/api/internal/agents/heartbeat
  HEARTBEAT_URL: string;
}

// Minimal local shapes so this type-checks without @cloudflare/workers-types.
interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

async function beat(env: Env): Promise<void> {
  if (!env.CRON_SECRET || env.CRON_SECRET.length < 16) {
    // Fail loud rather than silently POSTing an empty secret (which the ERP
    // rejects 401). Surfaces in the deploy/tail logs so the missing
    // `wrangler secret put CRON_SECRET` step is obvious.
    throw new Error(
      "[hookka-agent-heartbeat] CRON_SECRET unset or too short — run `wrangler secret put CRON_SECRET`",
    );
  }
  const url = env.HEARTBEAT_URL || "https://erp.hookka.com/api/internal/agents/heartbeat";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": env.CRON_SECRET },
    body: "{}",
  });
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    // Throw so the tick is marked failed in the CF dashboard / `wrangler tail`.
    // The next tick (30 min later) retries — the endpoint is idempotent.
    throw new Error(`heartbeat POST failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  console.log(`[hookka-agent-heartbeat] ${res.status} ${body}`.trim());
}

export default {
  // Cloudflare invokes this on every cron tick declared in wrangler.toml.
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(beat(env));
  },

  // Optional manual trigger: `curl https://<worker-url>/` (or the dashboard's
  // "Send request") fires one beat, handy for verifying the secret is set
  // without waiting for the cron. No auth on this path beyond the CRON_SECRET
  // the worker itself holds — it only ever calls the ERP, exposes nothing.
  async fetch(_req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      await beat(env);
      return new Response("beat ok\n", { status: 200 });
    } catch (err) {
      return new Response(`beat failed: ${err instanceof Error ? err.message : String(err)}\n`, {
        status: 500,
      });
    }
  },
};
