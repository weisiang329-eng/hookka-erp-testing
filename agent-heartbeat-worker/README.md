# hookka-agent-heartbeat

A tiny standalone Cloudflare **Cron Worker** that drives the ERP agent heartbeat
reliably.

## Why

The ERP's whole agent system (production scheduler, delivery agent, employee /
service daily digests, the proposals-backlog drain, and the fallback for the
punctual 07:00 report + 07:30 delivery crons) runs off one dumb beat:

```
POST https://erp.hookka.com/api/internal/agents/heartbeat   (x-cron-secret gated)
```

The endpoint carries no cadence — each beat it asks the scheduler what's due and
**self-throttles** (min 1h between real agent runs, max 6/day, once-a-day
digests, owner Pause / kill switch). So calling it too often is harmless.

It used to be driven **only** by GitHub Actions cron. GitHub does not honour a
schedule: measured 2026-07-16, a nominally-hourly beat fired every **1–3.5
hours** (a 23:58 → 03:27 gap), starving every agent and delaying the morning
brief. Cloudflare's own Cron Triggers fire on time — so this worker is the
reliable driver. The GitHub workflow stays as a belt-and-suspenders fallback
(the endpoint dedups, so double-firing is a no-op).

Pages Functions can't host a Cron Trigger (Workers-only), so this lives as a
sibling Worker — same pattern as `../mail-inbound-worker`.

## Deploy (one-time)

From this directory:

```bash
# 1. Deploy the worker + its cron trigger (uses the Hookka CF account already
#    pinned in wrangler.toml; `wrangler whoami` should show account
#    816e457307d7fa0491c2a08a72ad5dcd).
npx wrangler deploy

# 2. Set the shared secret — MUST be the SAME value as the ERP's CRON_SECRET
#    (the one agent-heartbeat.yml uses). Paste it when prompted; it is never
#    stored in the repo.
npx wrangler secret put CRON_SECRET
```

That's it. The cron (`*/30 * * * *`) starts firing on the next half-hour.

## Verify

```bash
# Fire one beat by hand (no need to wait for the cron) and watch the response:
curl -i https://hookka-agent-heartbeat.<your-workers-subdomain>.workers.dev/
#   200 "beat ok" + the endpoint's JSON  → secret is right, wired up
#   500 "beat failed: 401 …"             → CRON_SECRET doesn't match the ERP's

# Live logs:
npx wrangler tail
```

Or confirm from the ERP side: the **Agent Console** should start showing beats
every 30 min, and `agent_runs` rows should stop having multi-hour gaps.

## Config

| What | Where | Notes |
|------|-------|-------|
| Cadence | `wrangler.toml` `[triggers] crons` | `*/30 * * * *` — tighter than hourly on purpose (prompt fallback + faster backlog drain); endpoint self-throttles real runs to 1h. |
| Endpoint | `wrangler.toml` `[vars] HEARTBEAT_URL` | plain var, travels with the deploy |
| Secret | `wrangler secret put CRON_SECRET` | must equal the ERP's `CRON_SECRET`; never in the repo |

## Rollback

```bash
npx wrangler delete            # removes the worker + its cron entirely
```

The GitHub Actions heartbeat keeps running, so deleting this only returns you to
the old (unreliable) cadence — nothing else breaks.
