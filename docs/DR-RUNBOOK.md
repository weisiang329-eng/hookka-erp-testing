# Disaster Recovery Runbook

**Status:** Phase C #7 quick-win scaffold landed 2026-04-25. The cron
trigger and R2 binding are commented out in `wrangler.toml`; the daily
backup code is shipped behind runtime guards. The first quarterly
**drill** is still TODO — read the "What MUST happen" section at the
bottom.

---

## Goals (from `docs/ROADMAP-PHASE-C.md` §7)

- **RPO ≤ 1 hour** — at most 1h of writes can be lost in a catastrophe.
- **RTO ≤ 4 hours** — from "primary is gone" to "dashboard serving
  traffic on restored stack" must take less than 4h.

> **Honest note:** the daily cron in this scaffold gives RPO = 24h, not
> 1h. We accept this for the quick-win because today's RPO is "no
> off-account backup at all" — every reduction is a win. The full RPO
> ≤ 1h target requires WAL-shipping and is tracked as Phase C #7
> finish (post-quick-win).

---

## What ships in this scaffold

Two complementary backup paths:

1. **`scripts/backup-supabase.mjs`** — admin-side `pg_dump -Fc`
   shelled-out and uploaded to R2. Highest fidelity, requires a host
   with `pg_dump` installed. Runs ad-hoc or via GitHub Actions on a
   schedule.

2. **`src/api/cron/daily-backup.ts`** — Workers Cron Trigger
   that does a logical SELECT-to-JSON-Lines dump and writes
   `r2://hookka-files/backups/supabase/<date>.json.gz`. Runs entirely
   inside CF infrastructure, no admin laptop required. Lower fidelity
   (no constraints, no sequences) but always-on.

Both write to the same R2 prefix:
`r2://hookka-files/backups/supabase/`. Retention: **90 days**, pruned
automatically by both paths.

---

## Step 0 — Prerequisites

* R2 bucket `hookka-files` provisioned (see `docs/R2-SETUP.md`).
* Cloudflare R2 API tokens issued for the Node script path:
  ```bash
  # In the dashboard: R2 → Manage R2 API Tokens → Create API token
  # Permissions: Object Read & Write, restricted to hookka-files.
  ```
* `pg_dump` installed where you'll run the Node script (PostgreSQL 16
  client matches Supabase's current major version).
* `@aws-sdk/client-s3` installed. The script declares this lazily so
  it doesn't bloat the Worker build:
  ```bash
  npm install --save-dev @aws-sdk/client-s3
  ```

---

## Step 1 — Schedule the Workers cron

Uncomment in `wrangler.toml`:

```toml
[triggers]
crons = ["0 18 * * *"]   # 02:00 SGT daily (UTC+8)
```

> Pages Functions does **not** support `[triggers] crons` yet (private
> beta as of 2026-04). Move this entry to a sibling Worker
> (`hookka-erp-cron`) and import the handler:
>
> ```ts
> import dailyBackup from "../../hookka-erp-testing/src/api/cron/daily-backup";
> export default dailyBackup;
> ```
>
> Or wait for the Phase B SDK split, after which the API and crons
> consolidate into one Worker.

For production, consider switching to hourly:

```toml
crons = ["0 * * * *"]
```

That gets RPO from 24h to 1h with no other infrastructure change.

---

## Step 2 — Schedule the Node-side `pg_dump` (optional but recommended)

Add a GitHub Actions job:

```yaml
# .github/workflows/backup.yml
name: Daily backup
on:
  schedule:
    - cron: "30 17 * * *"   # 01:30 SGT (30 min before the Workers cron)
  workflow_dispatch:
jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: |
          sudo apt-get update && sudo apt-get install -y postgresql-client-16
          npm install --save-dev @aws-sdk/client-s3
      - run: node scripts/backup-supabase.mjs
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          R2_ENDPOINT: ${{ secrets.R2_ENDPOINT }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          R2_BUCKET: hookka-files
```

The Workers cron is the always-on safety net; the GitHub Actions cron
gives you a higher-fidelity `.dump.gz` you can `pg_restore` with one
command.

---

## Recovery procedure

### When to invoke

Any of:
* Supabase project outage > 1h with no ETA from Supabase support.
* Confirmed data corruption (e.g. a bad migration silently truncated a
  table, ledger hash chain breaks — see Phase C #2 for the chain
  detector).
* Catastrophic loss of the Cloudflare account (phishing → credential
  takeover → data wipe).

### Steps (target: 4h end-to-end)

**1. Provision a fresh Supabase project (15 min)**

```bash
# Create via Supabase dashboard or:
npx supabase projects create hookka-erp-recovery \
  --org-id <ORG> --plan pro --region ap-southeast-1
```

Capture the new connection string — call it `$RECOVERY_DATABASE_URL`.

**2. Download the most recent backup from R2 (5 min)**

Prefer the `.dump.gz` (highest fidelity) over `.json.gz` (logical
fallback):

```bash
LATEST_DUMP=$(aws s3 ls s3://hookka-files/backups/supabase/ \
  --endpoint-url $R2_ENDPOINT \
  | grep '.dump.gz$' | sort | tail -1 | awk '{print $4}')

aws s3 cp s3://hookka-files/backups/supabase/$LATEST_DUMP ./recovery.dump.gz \
  --endpoint-url $R2_ENDPOINT

gunzip recovery.dump.gz
```

**3. Restore via `pg_restore` (45-90 min for current data size)**

```bash
pg_restore --verbose --no-owner --no-acl \
  --jobs=4 \
  --dbname=$RECOVERY_DATABASE_URL \
  ./recovery.dump
```

If only `.json.gz` is available (cron path, no Node script ran):

```bash
gunzip <date>.json.gz
# Each line is {"table":"...","row":{...}}.
# scripts/restore-from-json.mjs (TODO — write during the first drill)
# replays them into a target Postgres with INSERT...ON CONFLICT DO NOTHING.
```

**4. Reapply migrations to catch up to head (5 min)**

```bash
DATABASE_URL=$RECOVERY_DATABASE_URL node scripts/apply-postgres-migrations.mjs
```

The dump is from yesterday-ish; HEAD migrations may have moved past it.

**5. Cut over Hyperdrive (5 min)**

```bash
# Update Hyperdrive's connection string to point at the recovery project
wrangler hyperdrive update HYPERDRIVE \
  --connection-string=$RECOVERY_DATABASE_URL

# Force a deploy so Pages picks up the new Hyperdrive routing
wrangler pages deploy dist --project-name=hookka-erp-testing --branch=main
```

**6. Smoke test (10 min)**

```bash
curl https://hookka-erp-testing.pages.dev/api/pg-ping
curl https://hookka-erp-testing.pages.dev/api/health

# Login as admin, walk the dashboard. Spot-check:
#   - Recent SO (was the last day's SOs preserved?)
#   - Open invoices (do AR totals match expectations?)
#   - Production board (any stuck job cards from the cutover?)
```

**7. Communicate (5 min)**

Post in #ops-incidents (or the equivalent) with:
* RPO actually achieved (timestamp of last preserved write).
* RTO (start-of-incident → smoke test pass).
* Known data gaps (writes between the backup timestamp and incident
  start — these are LOST and need manual recovery).

### Estimated total: 1.5-3h depending on data size

If the smoke test fails: revert Hyperdrive to original (assuming
original Supabase is reachable for read), or escalate to Cloudflare
support.

---

## What MUST happen but isn't done yet

1. **First quarterly drill.** This runbook is theory. The Phase C
   roadmap is explicit: "Verified by *running the drill*, not just by
   reading the runbook." Schedule the first drill within 30 days of
   this scaffold landing.

2. **Hourly cron in production.** Daily cron is the quick-win RPO
   floor. Production target is ≤ 1h. Switch the Workers cron schedule
   to `0 * * * *` once the daily path has 30 days of green runs.

3. **WAL shipping.** True RPO ≤ 1h needs continuous WAL ship to off-
   account storage. Tracked as Phase C #7 finish.

4. **Backup integrity check.** Tracked as Phase C #7 finish: a nightly
   job that runs `pg_restore --list` against the latest dump and
   confirms a non-zero row count on a sentinel table (`sales_orders`).
   Failure → P1 alert.

5. **Restore-from-JSON tooling.** Currently the JSON-Lines fallback is
   a backup format, not a restore format. Write
   `scripts/restore-from-json.mjs` during the first drill if the
   primary `.dump.gz` is unavailable.

---

*Last updated 2026-04-25.*
