# Google Sheets <-> ERP Bidirectional Sync

> **Last verified: 2026-08-13** against `src/api/lib/sheets-sync.ts` (`syncJobCardToSheet:99`, `removeJobCardFromSheet:155`, `backfillAllJobCards:213`, `buildWebhookHmacPayload:345`, `verifyWebhookSignature:363`), `src/api/routes/sheets-sync.ts`, `scripts/apps-script-onedit.gs`, and `wrangler.toml` (all three sheets vars still commented out / unset).
> Corrected 2026-08-13: backfill curl examples repointed at the live domain `erp.hookka.com`. Everything else matched the code as written.

Operator-facing production tracking lives in Google Sheets; the ERP is the
source of truth. This document covers the sync layer that keeps the two in
agreement.

## Architecture

```
                    ERP (Cloudflare Pages + Hono)
                    +------------------------------+
   SO confirm  ---> | applyPoUpdate / scan-complete|
   PATCH JC    ---> | + production-builder cascade |
   scan        ---> +-------------+----------------+
                                  |
                                  | fire-and-forget
                                  | c.executionCtx.waitUntil(...)
                                  v
                    +------------------------------+
                    | lib/sheets-sync.ts           |
                    |   syncJobCardToSheet()       |
                    |   removeJobCardFromSheet()   |
                    |   backfillAllJobCards()      |
                    +-------------+----------------+
                                  |
                                  | OAuth2 (service-account JWT, RS256)
                                  v
                    +------------------------------+
                    | sheets.googleapis.com v4     |
                    +-------------+----------------+
                                  ^
                                  | HMAC-SHA256 + timestamp window
                                  | POST /api/sheets-sync/apps-script-webhook
                                  |
                    +------------------------------+
                    | Apps Script onEdit trigger   |
                    | scripts/apps-script-onedit.gs|
                    +------------------------------+
```

ERP -> Sheets is fire-and-forget on every JC mutation request hot path
(SO confirm cascade, PATCH /:id with body.jobCardId, scan-complete).
Sheets -> ERP rides the Apps Script onEdit trigger and only accepts edits to
Completion Date, PIC 1, PIC 2 (columns I, J, K).

## Required environment variables

All three optional during rollout — when any is missing the helpers no-op
silently and the routes return 503. The build is safe to deploy with none
of these set.

| Var | Where set | Notes |
| --- | --- | --- |
| `GOOGLE_SHEETS_SA_KEY` | `wrangler pages secret put` | Full service-account JSON, stringified. Created in GCP. |
| `SHEETS_SYNC_SECRET` | `wrangler pages secret put` | Random hex (e.g. `openssl rand -hex 32`). Same value goes into Sheets Script Properties. |
| `SHEETS_SPREADSHEET_ID` | `wrangler.toml` `[vars]` (public) | `1hDGUYeKuWHpCXKrZptFI2eIKh9yNdhw7JeKbTjxT-x8` for the production sheet. |

Local dev: drop the same names into `.dev.vars`.

## One-time GCP setup checklist (user task)

1. **Create a GCP project** (or reuse the existing one).
2. **Enable the Google Sheets API** on that project: APIs & Services -> Library -> Google Sheets API -> Enable.
3. **Create a service account** under IAM & Admin -> Service Accounts. Name it `hookka-erp-sheets-sync`. No project-level roles required.
4. **Create a JSON key** for the SA: Keys -> Add Key -> Create new key -> JSON. Save the file.
5. **Share the spreadsheet** with the service account's email (`hookka-erp-sheets-sync@<project>.iam.gserviceaccount.com`) as **Editor**.
6. **Push the key into the worker**:
   ```sh
   wrangler pages secret put GOOGLE_SHEETS_SA_KEY
   # paste the entire JSON contents (one line) when prompted
   ```
7. **Generate and push the HMAC secret**:
   ```sh
   openssl rand -hex 32        # copy the output
   wrangler pages secret put SHEETS_SYNC_SECRET
   ```
8. **Set the spreadsheet id** in `wrangler.toml` `[vars]` (uncomment the existing line) and redeploy.

After step 8 the ERP starts pushing every JC mutation to the sheet
automatically. No code change needed.

## Apps Script paste-and-trigger instructions

1. Open the spreadsheet.
2. Extensions -> Apps Script. Replace `Code.gs` with the contents of [`scripts/apps-script-onedit.gs`](../scripts/apps-script-onedit.gs).
3. Project Settings (gear icon) -> Script Properties -> Add property:
   - `SHEETS_SYNC_SECRET` = same value you put into the worker secret.
   - (Optional) `ERP_WEBHOOK_URL` = override the default deploy URL if you ever rename the project.
4. Triggers (clock icon) -> Add Trigger:
   - Function: `onEditTrigger`
   - Event source: From spreadsheet
   - Event type: On edit
   - Failure notification: Notify me daily
5. Save and approve the OAuth consent (read access + external HTTP).

The trigger fires whenever a user edits Completion Date / PIC 1 / PIC 2 on
any of the eight dept tabs. Edits to the other 10 columns are ignored.

## HMAC payload shape (must match on both sides)

The Apps Script signs the canonical string

```
<jobCardId>|<timestamp>|<completionDate>|<pic1Name>|<pic2Name>
```

with HMAC-SHA256, hex-encoded, using `SHEETS_SYNC_SECRET` as the key.
- `timestamp` is JS `Date.now()` (epoch ms).
- Empty fields (cleared cells) are signed as the empty string, not "null".
- `completionDate` is normalised to `YYYY-MM-DD` before signing; otherwise the value passes through verbatim.

The ERP-side verifier (`buildWebhookHmacPayload` + `verifyWebhookSignature`
in `src/api/lib/sheets-sync.ts`) reconstructs the same string and rejects
the request if the signature mismatches OR if the timestamp drift exceeds 5
minutes.

## Running the backfill

After provisioning all three env vars, push every active JC to the sheet
in one shot:

```sh
# Dry-run first — returns counts + sample, writes nothing.
curl -X POST https://erp.hookka.com/api/sheets-sync/backfill \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'

# Apply.
curl -X POST https://erp.hookka.com/api/sheets-sync/backfill \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": false}'
```

Returns `{ success, scanned, pushed, errors[] }`. Per-row failures don't
abort the run — they collect into `errors` so a partial backfill still
makes progress.

## What is NOT hooked

By design, only request-driven JC mutations push to Sheets. The following
bulk paths leave Sheets stale; rerun the backfill if you use them:

- `POST /api/production-orders/:poId/regen-job-cards`
- `POST /api/sales-orders/regen-job-cards` (admin bulk)
- SO cancel cascade (sets PO to CANCELLED but doesn't touch Sheets)

## Troubleshooting

- **Webhook returns 503 with "sheets sync not configured"**: `SHEETS_SYNC_SECRET` missing on the worker.
- **Webhook returns 401 "invalid signature"**: secret mismatch between ERP and Apps Script Script Properties. Re-set both to the same value.
- **Webhook returns 401 "stale or future-dated timestamp"**: the Apps Script clock drifted more than 5 min from the worker. Apps Script timestamps are UTC; verify the worker isn't on a stale deploy.
- **No edits reach the ERP**: open the Apps Script editor -> Executions tab to check the trigger fired. If it didn't, re-add the onEdit trigger.
- **Sheets-side rows aren't appearing**: check `wrangler pages deployment tail` for `[sheets-sync]` errors. The service account may not be shared on the spreadsheet (give it Editor access).
