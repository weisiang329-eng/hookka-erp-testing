# hookka-mail-sync — Hostinger IMAP → ERP

Pulls mail from the company **Hostinger** mailboxes into the ERP Mail Center.

The @hookka.com mailboxes (support@, finance@, hr@, lim@, violet@) are hosted on
Hostinger. This job connects to each over **IMAP, read-only** (it never marks
your mail as read), and POSTs every message to the ERP's
`POST /api/mail-center/inbound`. The ERP **dedups by Message-ID**, so re-running —
including the one-time history import — never creates duplicates.

It runs on a **GitHub Actions cron** (`.github/workflows/mail-sync.yml`), every
10 minutes. It is NOT part of the Cloudflare Worker — it's an independent Node
script, so it can use the mature `imapflow` IMAP client.

This replaces the need for the Cloudflare Email-Routing / MX-cutover path: the
mail stays on Hostinger, the ERP just reads it. Both paths feed the same ingest.

## One-time setup

### 1. Pick a shared secret

Generate a random string ≥ 16 chars (the inbound secret). You will set the
**same value** in two places.

- **GitHub** → repo **Settings → Secrets and variables → Actions → New repository secret**
  - `MAIL_INBOUND_SECRET` = _that string_
- **Cloudflare Pages** (the ERP) → the `hookka-erp-testing` Pages project →
  **Settings → Environment variables** (Preview/staging, and later Production) →
  add **`MAIL_INBOUND_SECRET`** = _the same string_ (mark as a Secret). The ERP
  rejects inbound posts unless this is set and ≥ 16 chars.

### 2. Add each mailbox's IMAP password (GitHub secrets)

Same Secrets page, one per mailbox (the value is the mailbox's email login
password, or a Hostinger app-specific password):

| Secret name | Mailbox |
|---|---|
| `HOSTINGER_PW_SUPPORT` | support@hookka.com |
| `HOSTINGER_PW_FINANCE` | finance@hookka.com |
| `HOSTINGER_PW_HR` | hr@hookka.com |
| `HOSTINGER_PW_LIM` | lim@hookka.com |
| `HOSTINGER_PW_VIOLET` | violet@hookka.com |

A mailbox with no secret is simply skipped (logged), so you can roll them out one
at a time.

### 3. (Optional) point at production

The script defaults to the **staging** ERP URL. For production, add a repo
**Variable** (not secret): `MAIL_ERP_INBOUND_URL` =
`https://erp.hookka.com/api/mail-center/inbound`.

Defaults you usually don't need to touch (override via repo **Variables**):
`MAIL_IMAP_HOST` = `imap.hostinger.com`, `MAIL_IMAP_PORT` = `993`,
`MAIL_MAILBOXES` = the 5 boxes above.

## First run (import history)

Actions tab → **Mail Sync (Hostinger IMAP -> ERP)** → **Run workflow** →
pick the **staging** branch → tick **backfill** → Run. This imports all existing
mail (e.g. support@'s ~850). Watch the run log for the per-mailbox summary.

After that, leave it — the cron keeps pulling new mail every 10 minutes.

> **Cron + branch:** scheduled runs only fire from the repo's **default** branch.
> While testing on `staging`, use **Run workflow** (manual) to trigger it. Once
> the workflow file is on the default branch, the 10-minute cron is automatic.

## Notes / limits

- **Read-only**: opens `INBOX` with EXAMINE and fetches with `BODY.PEEK[]`, so
  unread counts in Hostinger webmail are never touched.
- **Incremental window**: each cron run fetches the last `SINCE_DAYS` (default 3)
  and relies on Message-ID dedup — robust against missed ticks/downtime.
- **INBOX only** for now (incoming mail). Syncing the Sent folder (to mirror mail
  sent from Hostinger webmail) can be added later.
- This handles **receive**. Sending from the ERP is separate (see the Mail Center
  send path).
