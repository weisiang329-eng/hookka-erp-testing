# Midnight auto-refresh — investigation notes

User report: "Every midnight there's also an auto-refresh."

## What was investigated

### 1. `src/lib/use-version-check.ts`

`useVersionCheck` polls `/` every 5 minutes, parses the first `/assets/...`
script-hash from the response, and fires `onNewVersion` when the hash
changes. The hook is mounted exactly once at the top of `DashboardLayout`
(via `<NewVersionWatcher />`). On change, it pops a toast and a
`window.confirm()` asking the user to reload — **the reload itself is user-
triggered**, not automatic.

So this hook by itself doesn't auto-refresh. But:

- If a CI/CD job ships a deploy at the same time every day (common: 00:00
  UTC = 08:00 SGT, or 00:00 SGT = 16:00 UTC), every open SPA tab fires the
  banner around the same wall-clock minute.
- The user might be clicking "Reload now" out of habit and remembering it
  as "auto-refresh".

### 2. Cloudflare Pages / cron triggers

`wrangler.toml` (lines 74-86, 133-142) documents that **Pages Functions do
not natively support `[triggers] crons`**. The repo has a `daily-backup.ts`
scheduled handler at `src/api/cron/daily-backup.ts`, but its `crons`
declaration is commented out — the comment says it needs an external
trigger (sibling Worker / cron-job.org / GitHub Action) to actually fire.

The backup job is purely server-side anyway (writes to Supabase
Storage; was R2 before the storage-supabase-migration). It cannot
cause client-side refreshes.

### 3. Session TTL

All four session-issuance points use a 30-day TTL:
- `src/api/routes-d1/auth.ts:18` — `SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000`
- `src/api/routes-d1/auth-totp.ts:45` — same
- `src/api/routes-d1/auth-oauth.ts:37` — same
- `src/api/routes/worker-auth.ts:85` — same

So a daily session expiry is NOT the cause. A user logged in 3 days ago
still has 27 days of token left.

### 4. Search for `setInterval` / midnight constants

`grep` for `midnight | 86400 | 24 * 60 * 60` in `src/`:
- All matches are server-side date-arithmetic (age comparisons) or
  retention-window math. No client-side "fire at midnight" code path.

`location.reload()` call sites:
- `src/layouts/DashboardLayout.tsx:29` — inside the `useVersionCheck`
  banner confirm flow
- `src/components/layout/sidebar.tsx:271` — manual reload button
- `src/components/ui/error-boundary.tsx:90` — error-boundary "Reload"
  button

None of these run on a timer; all are user-triggered.

## Best hypothesis

**Daily CI/CD deploy at a fixed time** is interpreted by `useVersionCheck`
as a new bundle, which surfaces the "new version" banner. If the user
clicks the banner's "Reload now" button (or has clicked through it
absent-mindedly), the page reloads — once per day, around the same wall-
clock time, hence "every midnight".

This is **not a bug**: the version-check is intentional and correct
behavior, and the prompt is opt-in. But the UX wording could make it
clearer that the user can dismiss the banner if mid-edit.

## Recommended follow-up

1. Confirm the CI deploy schedule. If it's set to fire daily near 00:00,
   the timing matches the user's report.
2. Consider adding a "Don't ask for 1 hour" snooze on the version-update
   banner so a mid-edit user can defer.
3. Add a small inline indicator (e.g. "v1.2.3 → v1.2.4 available") that
   stays visible after dismissal, so the user can choose when to reload
   without losing visibility of the pending update.

## What was NOT found

- No `setInterval(..., 24 * 3600 * 1000)` triggering at midnight.
- No `location.reload()` on a timer.
- No 24-hour session TTL.
- No client-side cache that auto-flushes daily.
- No service-worker `update()` call on a daily schedule.

## TL;DR

Most likely cause: daily CI/CD deploy + the version-check banner →
user-triggered reload. Not a code bug. If the user says the reload
happens **without them clicking anything**, then re-investigate; that
would imply a different mechanism (browser-restored session, OS-level
power event, browser-extension reload).
