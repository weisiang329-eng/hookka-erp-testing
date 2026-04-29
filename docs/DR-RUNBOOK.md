# Disaster Recovery Runbook

**Status:** Phase C #7 quick-win scaffold landed 2026-04-25; rewritten to
target Supabase Storage (was Cloudflare R2) on 2026-04-29 by the
storage-supabase-migration. The cron trigger is still commented out in
`wrangler.toml`; the daily backup code is shipped behind runtime guards.
The first quarterly **drill** is still TODO — read the "What MUST happen"
section at the bottom.

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

> **Storage trade-off (2026-04-29):** moving from R2 to Supabase Storage
> means the daily dump now lives **in the same vendor** as the primary
> Postgres — a true "Supabase region wipe" event would take both with
> it. Mitigations: (a) the `.dump` is also a download artifact on every
> GitHub Actions run for 90 days; (b) Supabase Pro PITR (7 days) covers
> the most common "oops" failure modes; (c) a quarterly off-vendor
> snapshot (manual download → 1Password attachment) covers the
> doomsday case until WAL shipping lands. Document these as you turn
> them on.

---

## What ships in this scaffold

Two complementary backup paths, both writing to **Supabase Storage**
(bucket `hookka-files`, private):

1. **`.github/workflows/backup.yml`** — GitHub Actions runner that does
   `pg_dump -Fc` against Supabase prod and `curl`-uploads the .dump to
   `hookka-files/backups/supabase/`. Highest fidelity. Runs daily at
   18:00 UTC + on `workflow_dispatch`.

2. **`src/api/cron/daily-backup.ts`** — Workers Cron Trigger that does
   a logical SELECT-to-JSON-Lines dump and writes
   `hookka-files/backups/supabase/<date>.json.gz` via the Supabase
   Storage v1 REST API. Runs entirely inside CF infrastructure, no
   admin laptop required. Lower fidelity (no constraints, no sequences)
   but always-on.

Both write to the same Storage prefix:
`hookka-files/backups/supabase/`. Retention: **90 days**, pruned
automatically by the Workers cron path (Supabase Storage doesn't have
native lifecycle rules the way Cloudflare R2 did, so the prune is now a
code-level concern only — see `daily-backup.ts:pruneOldBackups`).

---

## Step 0 — Prerequisites

* **Supabase Storage bucket bootstrap (one-time, manual):**
  1. Supabase Dashboard → Storage → New bucket
  2. Name: `hookka-files`
  3. Visibility: **Private**
  4. (Optional) Storage → Policies → confirm a `service_role can do
     anything` policy exists; service_role bypasses RLS but explicit
     policies make audits cleaner.
* **GitHub repo secrets** (set BEFORE the daily backup ever fires):
  * `SUPABASE_PROD_URL` — pooler connection string for `pg_dump`.
    Supabase dashboard → Project Settings → Database → Pooler URL.
    MUST include `?sslmode=require`.
  * `SUPABASE_PROJECT_REF` — slug before `.supabase.co` in your project
    URL. Not a hard secret on its own but kept here so prod / preview
    can swap independently.
  * `SUPABASE_SERVICE_ROLE_KEY` — service_role key from Project
    Settings → API. Treat like a root password.
  * `CRON_SECRET` — `openssl rand -hex 32`, mirror to CF Pages.
* **Wrangler secrets** for the Workers cron path:
  * `wrangler secret put SUPABASE_SERVICE_KEY` — same service_role key
    as above. (`SUPABASE_PROJECT_REF` lives in `wrangler.toml [vars]`.)
* `pg_dump` installed on whichever runner does the .dump path. The
  GitHub Actions workflow auto-installs `postgresql-client-16`; if you
  re-introduce a Node script, install it locally (Postgres 16 matches
  Supabase's current major version).

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

## Step 2 — `.github/workflows/backup.yml` is already wired

The repo ships the GitHub Actions workflow at
`.github/workflows/backup.yml`. It runs daily at 18:00 UTC, does
`pg_dump -Fc -Z 9` against `SUPABASE_PROD_URL`, and POSTs the .dump to
the Supabase Storage REST endpoint:

```
https://<SUPABASE_PROJECT_REF>.supabase.co/storage/v1/object/hookka-files/backups/supabase/backup-YYYY-MM-DD.dump
```

Auth is `Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY`. The
workflow verifies the upload by HEADing the object info endpoint and
checking the size sentinel (>1 KB).

The Workers cron is the always-on safety net; this workflow gives you a
higher-fidelity `.dump` you can `pg_restore` with one command.

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

**2. Download the most recent backup from Supabase Storage (5 min)**

Prefer the `.dump` (highest fidelity, from `.github/workflows/backup.yml`)
over `.json.gz` (logical fallback, from the Workers cron):

```bash
# List the latest dumps via the Supabase Storage v1 list endpoint.
LIST=$(curl -sS \
  -X POST "https://${SUPABASE_PROJECT_REF}.supabase.co/storage/v1/object/list/hookka-files" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prefix":"backups/supabase","limit":50,"sortBy":{"column":"name","order":"desc"}}')

# Pick the newest backup-*.dump filename out of the response.
LATEST=$(echo "$LIST" | grep -oE '"name":"backup-[0-9-]+\.dump"' \
  | head -1 | sed -E 's/.*"name":"(.*)".*/\1/')
echo "Restoring from: $LATEST"

# Download it.
curl -sS -o ./recovery.dump \
  "https://${SUPABASE_PROJECT_REF}.supabase.co/storage/v1/object/authenticated/hookka-files/backups/supabase/${LATEST}" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

ls -lh ./recovery.dump
```

**3. Restore via `pg_restore` (45-90 min for current data size)**

```bash
pg_restore --verbose --no-owner --no-acl \
  --jobs=4 \
  --dbname=$RECOVERY_DATABASE_URL \
  ./recovery.dump
```

(If the GitHub Actions step uploaded a gzipped `.dump.gz` rather than a
raw `.dump`, `gunzip recovery.dump.gz` first. The current workflow
ships an already-zlib-compressed custom-format dump — `pg_restore`
reads that natively.)

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

## Pre-launch Restore Drill — Step-by-Step Checklist

> **Status:** TO BE EXECUTED BEFORE LAUNCH. The procedure below is what
> the operator MUST run end-to-end before flipping the production switch
> on. Numbers in the closing summary (RTO actual, last-write-preserved
> timestamp) are placeholders until the first dry run lands them.
>
> Run the drill once with the operator and a dev pair, then again solo
> 30 days later — that's how we prove the runbook stays current under
> staff turnover.

### Required GitHub repo secrets (set BEFORE the daily backup ever fires)

| Secret name                 | Where to get it                                                | Notes                                  |
| --------------------------- | -------------------------------------------------------------- | -------------------------------------- |
| `SUPABASE_PROD_URL`         | Supabase dashboard → Project Settings → Database → Pooler URL  | Must include `?sslmode=require`        |
| `SUPABASE_PROJECT_REF`      | Slug from your Supabase project URL (`<ref>.supabase.co`)      | Public-ish but kept here for env parity |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Project Settings → API → service_role     | Treat like a root password; bypasses RLS |
| `CRON_SECRET`               | Generate via `openssl rand -hex 32` once; mirror to CF Pages   | Required by qc-cron.yml + future MV-refresh worker |

`gh secret set <NAME> --body "<value>"` for each.

> **Removed (was on R2):** `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
> `R2_ENDPOINT`. Drop these from the repo / org-level secrets after
> the migration deploys; they're no longer referenced anywhere.

### Drill steps (target end-to-end ≤ 4 hours; record actual)

1. **Provision a fresh Supabase project (15 min).**
   - Dashboard → New project → name `hookka-erp-recovery-YYYY-MM-DD`,
     pro plan, region `ap-southeast-1`, database password from 1Password.
   - Copy the pooler connection string. Set `RECOVERY_DATABASE_URL` in
     your local shell — DO NOT commit it.

2. **Pull the latest backup from Supabase Storage (5 min).**
   ```bash
   # List the .dump files under backups/supabase/.
   LIST=$(curl -sS \
     -X POST "https://${SUPABASE_PROJECT_REF}.supabase.co/storage/v1/object/list/hookka-files" \
     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
     -H "Content-Type: application/json" \
     -d '{"prefix":"backups/supabase","limit":50,"sortBy":{"column":"name","order":"desc"}}')

   LATEST=$(echo "$LIST" | grep -oE '"name":"backup-[0-9-]+\.dump"' \
     | head -1 | sed -E 's/.*"name":"(.*)".*/\1/')
   echo "Restoring from: $LATEST"

   curl -sS -o ./recovery.dump \
     "https://${SUPABASE_PROJECT_REF}.supabase.co/storage/v1/object/authenticated/hookka-files/backups/supabase/${LATEST}" \
     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
   ```
   Verify the local file is ≥ 1 MB (a silent pg_dump truncation slips
   past the workflow's 1 KB sentinel only when the dataset is tiny).

3. **Restore via `pg_restore` (45-90 min on current dataset).**
   ```bash
   pg_restore --verbose --no-owner --no-acl --jobs=4 \
     --dbname="$RECOVERY_DATABASE_URL" \
     ./recovery.dump
   ```
   Expected non-fatal warnings: "role 'postgres' does not exist" — the
   `--no-owner` flag handles ownership remapping. ANY other error
   means the dump itself was bad; abort and investigate before
   continuing.

4. **Verify migration version (5 min).**
   ```bash
   DATABASE_URL=$RECOVERY_DATABASE_URL \
     node scripts/check-schema-applied.mjs
   ```
   Expected output: lists every applied migration. If HEAD migrations
   landed AFTER the dump timestamp, run:
   ```bash
   DATABASE_URL=$RECOVERY_DATABASE_URL \
     node scripts/apply-postgres-migrations.mjs
   ```
   to bring the recovery DB up to head.

5. **Sentinel SQL — row counts on critical tables.**
   Run against BOTH the recovery DB and a known-good production
   snapshot (use `psql "$DATABASE_URL"` for prod, `psql
   "$RECOVERY_DATABASE_URL"` for recovery). The numbers should match
   within the writes-since-last-backup tolerance.

   ```sql
   SELECT 'sales_orders'      AS t, COUNT(*) FROM sales_orders
   UNION ALL SELECT 'production_orders', COUNT(*) FROM production_orders
   UNION ALL SELECT 'job_cards',         COUNT(*) FROM job_cards
   UNION ALL SELECT 'invoices',          COUNT(*) FROM invoices
   UNION ALL SELECT 'customers',         COUNT(*) FROM customers
   UNION ALL SELECT 'fg_units',          COUNT(*) FROM fg_units
   UNION ALL SELECT 'audit_events',      COUNT(*) FROM audit_events;
   ```
   Record both result sets in the drill log.

6. **Ledger hash chain integrity (5 min).**
   ```bash
   DATABASE_URL=$RECOVERY_DATABASE_URL \
     node scripts/verify-journal-hash-chain.mjs
   ```
   Must report 0 broken hashes. If it doesn't, the dump captured a
   write mid-transaction — escalate.

7. **Time the whole drill.**
   - Note the wall-clock from step 1 → step 6 completion.
   - Record three numbers in this runbook (replace the placeholders
     under "Recorded RTO/RPO" below):
     - **Actual RTO** = drill duration (Step 1 start → Step 6 pass)
     - **Last preserved write timestamp** = the `MAX(updated_at)` from
       sales_orders + invoices in the recovery DB
     - **Actual RPO** = current time at start of drill MINUS last
       preserved write timestamp

8. **Tear down (5 min).**
   - Suspend the recovery Supabase project (don't delete — keep it for
     30 days as a known-good snapshot).
   - Wipe the local `recovery.dump`.
   - Post the drill summary in #ops-incidents.

### Recorded RTO/RPO

| Drill date | Actual RTO | Actual RPO | Tested by | Notes                        |
| ---------- | ---------- | ---------- | --------- | ---------------------------- |
| _TBD pre-launch_ | _TBD_  | _TBD_      | _TBD_     | First drill, must-pass       |
| _90 days later_  | _TBD_  | _TBD_      | _TBD_     | Solo re-run (no pair)        |

When this table has a row with `Actual RTO ≤ 4h` AND `Actual RPO ≤ 24h`
(or 1h once hourly cron is enabled), the DR posture is verified. Until
then, treat the launch as gated on it.

---

## Supabase Point-in-Time Recovery (PITR)

> **Status:** MUST be enabled in the Supabase dashboard BEFORE the
> launch checklist closes. PITR is independent of (and complementary
> to) the Storage-resident dumps in this runbook — Supabase Pro plan
> provides up to 7 days of WAL retention so you can roll the prod
> project back to any second within that window without losing the
> dump-bridge writes.
>
> The Supabase Storage dumps are the disaster-recovery floor (the cron
> is broken, a migration corrupts a table, the prior week's backup is
> the only place a row still exists). PITR is the day-to-day "oops,
> that migration truncated a column" undo button.
>
> **Caveat after the storage-supabase-migration:** the dumps now live
> on Supabase Storage, in the same vendor as the primary database. A
> full-vendor outage takes both with it. Mitigations:
> (a) GitHub Actions retains the .dump as a workflow artifact for 90
>     days — that's an off-vendor floor accessible via `gh run download`.
> (b) Plan a quarterly manual download → 1Password attachment for the
>     deep-doomsday case until WAL-shipping to a third vendor lands.

### Enable / verify checklist

- [ ] Supabase dashboard → Project Settings → **Add-ons** → enable
      **Point in Time Recovery**. Pro-plan upgrade required if the
      project is on the free tier.
- [ ] Choose **7-day WAL retention** (the default Pro tier; bump to
      14 if storage budget allows).
- [ ] Verify by going to **Database → Backups → Point in Time
      Recovery** — the panel should show "Available recovery window:
      now − 7 days". Take a screenshot, paste into the drill log.
- [ ] Document the on-call procedure: WHO clicks the PITR button, WHO
      authorizes the rollback, what the cutoff for "use PITR vs
      reverse the bad write manually" is.

### How PITR vs Storage dumps relate

| Failure mode                                  | Use PITR              | Use Storage dump       | GitHub Actions artifact |
| --------------------------------------------- | --------------------- | ---------------------- | ----------------------- |
| Bad migration / dropped column / typo'd UPDATE | Yes (within 7 days)  | No (overkill — 24h granularity) | No |
| > 7-day-old data corruption notice            | No (out of window)    | Yes (90-day retention) | Yes (90 days) |
| Supabase project hard-deleted / billing lapse | No (data is gone)     | No (Storage is gone too) | Yes — last off-vendor copy |
| Workflow upload failed silently for a week    | Yes (PITR independent)| Possibly stale         | Yes (artifact still there) |

The three layers cover each other's failure modes. The artifact column
exists *because* Storage now lives in the same vendor as Postgres after
the storage-supabase-migration — see the caveat above.

---

*Last updated Sprint 4 (2026-04-29).*
