# Foundation Hardening — PR Descriptions

Copy-paste the relevant block when opening each PR via `gh pr create --base main --head <branch> --body "$(cat below)"`.

Recommended merge order (minimizes conflicts):

1. Sprint 1 → 2. Sprint 6 → 3. Sprint 3 → 4. Sprint 2 → 5. Sprint 4 → 6. Sprint 7 → 7. Sprint 5

---

## Sprint 1 — Quick wins + security headers

**Branch:** `claude/nostalgic-cannon-65bafb`
**Base:** `main`

### Summary
Foundation low-hanging fruit + HTTP security headers. 9 atomic commits.

### What changed
- **PII strip** on public `/api/fg-units/:id` — `customerName`, `customerHub`, `packerName`, `upholsteredByName` no longer returned to anonymous QR scanners
- **Soft-auth** in `auth-middleware.ts` — public-allowlisted routes still populate `userId` if a valid Bearer token is present
- **DEV reset button removed** from `src/pages/production/index.tsx:2966` + companion `/api/admin/clear-all-completion-dates` endpoint
- **MV refresh cron** wired via `.github/workflows/refresh-mvs.yml` (every 15 min POST `/api/internal/refresh-mvs`)
- **Catch-all 404** instead of `{success:true, data:[], _stub:true}` on unmounted `/api/*` paths
- **`pg-ping` snapshot test** — pre-auth route allowlist now locked via `parsePreAuthRoutes()`
- **`users:role-change` permission** split — `migrations-postgres/0085_*` seeds it on SUPER_ADMIN only
- **`job-card-persistence.ts`** moved from `src/lib/` (where Vite could pull it into the bundle) to `src/api/lib/`
- **File upload MIME validation** + magic-byte sniff on `/api/files`
- **HTTP security headers** middleware — X-Content-Type-Options, X-Frame-Options, HSTS, Referrer-Policy, Permissions-Policy, CSP report-only
- **`docs/ARCHITECTURE.md`** refreshed for post-D1-migration reality (BLOCKER-1)

### Test plan
- [x] `npm run typecheck:app` — clean
- [x] `npm test` — 85/85 passing
- [ ] After deploy: hit `/api/fg-units/<id>` without auth → confirm `customerName` absent
- [ ] After deploy: hit `/api/wat` → confirm 404 not 200
- [ ] After deploy: response headers include `Strict-Transport-Security`

### Pre-launch ops
- [ ] Set `CRON_SECRET` repo secret + Cloudflare Pages env (same value)
- [ ] Apply migration `0085_sprint1_users_role_change_permission.sql`
- [ ] Re-deploy Pages so `CRON_SECRET` env var is live

---

## Sprint 6 — Test foundation

**Branch:** `claude/sprint-6-test-foundation`
**Base:** `main` (or after Sprint 1 merge — additive, no conflicts expected)

### Summary
Critical money/audit/E2E test coverage. 7 commits. `npm test` count: 89 → 179.

### What changed
- **`tests/money.test.mjs`** (27 cases) — `formatRM`, sen↔RM, pricing line totals, labor rate floating algorithm
- **`tests/e2e-happy-path.test.mjs`** (14 cases) — pins SO→PO→JC→FG→DO→Invoice route surface (method/path/RBAC gate/status verbs)
- **`tests/hash-chain.test.mjs`** (12 cases) — `appendJournalEntries` integrity + tamper detect + idempotency
- **`verifyJournalChain` helper** added to `src/api/lib/journal-hash.ts`
- **RBAC route-coverage floor** raised from 9 to 86 (17 gated files all pinned)
- **4 orphan tests** wired into `npm test` script: `permissions`, `worker-auth`, `worker-auth-default-protect`, `scheduler` (had stale schema; fixed in this PR)
- **`.husky/pre-commit`** — added shebang + blocking `npm test` (fixes the Windows MSYS git "Exec format error" that all sprints hit)
- **`.github/workflows/deploy.yml`** — bundle-size step flipped from `continue-on-error: true` to blocking. Lint kept non-blocking (P2).

### Test plan
- [x] `npm test` — 179/179 passing
- [x] `npm run typecheck:app` — clean
- [ ] After merge: confirm pre-commit hook fires on Windows without "Exec format error"

### Notes
- E2E test is route-surface pattern presence (not full hermetic integration with stubbed DB). Per Sprint spec fallback — full integration is a P2.
- RBAC floor 86 is the actual count, not the ~104 estimate I'd written earlier.
- Invoice "post" verb in this codebase is `SENT`, not `POSTED` (DRAFT→SENT is the irreversible transition).

---

## Sprint 3 — Data integrity

**Branch:** `claude/sprint-3-data-integrity`
**Base:** previous merges

### Summary
Schema constraint hardening + atomic JE/audit batching + advisory lock + idempotency on money routes. 6 commits.

### What changed
- **`migrations-postgres/0077_constraint_audit.sql`**:
  - 8 UNIQUE indexes on document numbers (po_no, invoice_no, do_no, grn_number, entry_no, e_invoices.uuid, credit/debit_notes.note_number)
  - NOT NULL DEFAULT NOW() on transaction tables' `created_at`/`updated_at`
  - CHECK on `purchase_orders.status` / `invoices.status` / `bank_transactions.type`
  - `journal_lines` debit XOR credit invariant
  - DROP 5 redundant indexes (covered by composites in 0037/0040/0047)
- **`appendJournalEntries`** refactored — `buildJournalEntryStatements()` returns prepared statements; caller folds into its own `db.batch()` so JE writes are atomic with the business mutation
- **`pg_advisory_xact_lock(hashtext('journal_hash:'||orgId)::bigint)`** as first batch statement — serializes concurrent invoice posts on the chain head, prevents fork
- **`emitAudit` → `buildAuditStatement`** — same pattern; audit row in same txn as the mutation
- **Idempotency-Key** on POST `/api/sales-orders`, `/api/sales-orders/:id/confirm`, `/api/invoices`, `/api/payments` via new `src/api/lib/idempotency.ts` (KV 24h TTL, pending sentinel → 409 to concurrent retries)
- **5 frontend callers** auto-attach `Idempotency-Key: <uuid>` header
- **`bom_templates.baseModel`** lookup replaces `productCode.split("-")[0]` heuristic (BUG-2026-04-27-009)
- **Settings page** loads from `/api/kv-config/<key>` instead of overwriting with hardcoded defaults

### Test plan
- [x] `npm test` — 84/84 passing
- [x] `npm run typecheck:app` — clean
- [ ] Apply `0077_constraint_audit.sql` to staging Supabase first; confirm no UNIQUE-violation errors on existing data
- [ ] Smoke: double-click "Post Invoice" — should produce 1 invoice + 1 journal entry chain row, not 2

### Pre-launch ops
- [ ] Apply migration `0077_constraint_audit.sql` to prod Supabase

---

## Sprint 2 — Auth hardening

**Branch:** `claude/sprint-2-auth-hardening`
**Base:** previous merges

### Summary
Rate limiting + PIN 6-digit + RBAC on 51 routes + BOM whitelist + auth/file audit + audit_dlq. 8 commits.

### What changed
- **`src/api/lib/rate-limit.ts`** (new) — KV-backed counter, 10 attempts / 15 min → 429
- Wired on: `auth.ts` login, `auth-totp.ts` login-verify, `auth-oauth.ts` callback, `worker-auth.ts` login + reset-pin
- **Worker PIN 4 → 6 digits** + force-reset migration:
  - `migrations-postgres/0079_worker_pin_reset_force.sql` adds `must_reset BOOLEAN DEFAULT 1`
  - `worker-auth.ts` validators changed to `z.string().length(6)`
  - Frontend login UI `maxLength=6 pattern=\d{6}`
- **51 mutating route files** gated with `requirePermission(c, "<resource>", "<action>")` (was 17 — 51 added)
- **BOM PUT `:id`** field whitelist — `{ ...current, ...body, id }` mass-assignment replaced with explicit allowlist
- **Auth + file audit emit** — login success/fail, logout, password change, TOTP enroll/disable/verify, OAuth callback, file upload/delete (9 emit points)
- **`migrations-postgres/0080_audit_dlq.sql`** + `job_card_events` failure path — failed audit batches go to DLQ instead of `console.error` swallow

### Test plan
- [x] `npm test` — 84/84 passing
- [x] `npm run typecheck:app` — clean
- [ ] After deploy: 11 failed login attempts in 15 min from same IP → 11th gets 429
- [ ] After deploy: WORKER token curl on any of 51 mutating routes → 403
- [ ] After deploy: PIN with 4 digits → rejected; with 6 digits → accepted

### Pre-launch ops
- [ ] Apply migrations `0079_worker_pin_reset_force.sql` + `0080_audit_dlq.sql`
- [ ] Day-1 broadcast to floor: all workers must re-set 6-digit PIN at first login (must_reset=1 forces it)
- [ ] Note: `audit_dlq` replay sweeper is a P2 follow-up (not in this PR)

### Notes
- WORKER role's seed permissions in `migrations-postgres/0045_rbac.sql` were already restricted (read-only on payslips/attendance/production-orders/job-cards). No schema change needed.
- `src/api/routes-mock/worker-auth.ts` (dev mock) still validates 4-digit PINs — left alone deliberately. Production routing uses `src/api/routes/worker-auth.ts`.

---

## Sprint 4 — Tenant isolation + DR + email outbox

**Branch:** `claude/sprint-4-tenant-dr-email`
**Base:** previous merges

### Summary
Multi-tenant `withOrgScope` real activation + 70-table org_id rollout + R2 backup workflow + 7d session with sliding refresh + email outbox with retry. 12 commits.

### What changed

**Multi-tenant activation (5 commits)**
- `src/api/lib/tenant.ts` — `withOrgScope` now binds real `WHERE orgId = ?`; `getOrgId` throws `OrgIdRequiredError` instead of defaulting to `'hookka'`; `tryGetOrgId` exposed for cron paths
- `src/api/worker.ts` — `app.onError` translates `OrgIdRequiredError` → 401
- **`migrations-postgres/0078_org_id_full_rollout.sql`** — adds `org_id NOT NULL DEFAULT 'hookka'` + `idx_<t>_org_id` to ~70 transaction tables. Idempotent.
- 28 high-leverage list routes wrapped with `withOrgScope` (45 tail routes documented as TODO; can be done as touched)
- **`tests/tenant-isolation.test.mjs`** — 5 invariants

**DR (2 commits)**
- `wrangler.toml` — uncommented FILES R2 binding (bucket creation is a one-shot ops step)
- `.github/workflows/backup.yml` — daily 18:00 UTC `pg_dump -Fc` to R2 with size sanity check + 4 required GH secrets documented in header
- `docs/DR-RUNBOOK.md` — added 8-step pre-launch restore drill checklist + secrets table + Supabase PITR section + recorded-RTO/RPO table (placeholders)

**Session hardening (1 commit)**
- `src/api/routes/auth.ts` — `SESSION_TTL_MS` 30d → 7d
- `src/api/lib/auth-middleware.ts` — sliding refresh: when `expiresAt - now < 24h`, push `expiresAt` to `now + 7d` via `waitUntil`

**Email outbox (1 commit)**
- **`migrations-postgres/0081_email_outbox.sql`** — `outbox_emails` table with status enum, attempts, partial index `WHERE status IN ('PENDING','RETRYING')`
- `src/api/lib/email-outbox.ts` — `enqueueEmail()` + `processOutbox()` (cron drain, 25-row batches, exponential backoff 0/60/300s, 3-attempt cap)
- `POST /api/internal/process-email-outbox` — CRON_SECRET-gated
- `.github/workflows/process-email-outbox.yml` — every-5-min cron
- `users.ts` (invite) and `purchase-orders.ts` (supplier PO notify) refactored to use `enqueueEmail`

### Test plan
- [x] `npm test` — 89/89 passing
- [x] `npm run typecheck:app` — clean
- [ ] Apply migrations `0078_org_id_full_rollout.sql` + `0081_email_outbox.sql`
- [ ] After deploy: spawn a fake second org, login as a user there, confirm only that org's data visible
- [ ] After deploy: GitHub Actions backup workflow `workflow_dispatch` → confirm R2 bucket has new `.dump` file
- [ ] After deploy: leave a user idle 7d → confirm logout; active user crosses 7d → confirm sliding refresh extends

### Pre-launch ops (CRITICAL)
- [ ] GH secrets: `SUPABASE_PROD_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `CRON_SECRET`
- [ ] Cloudflare Pages env: `CRON_SECRET` (same value)
- [ ] R2 bucket `hookka-files` created
- [ ] Supabase Pro PITR enabled in dashboard
- [ ] First restore drill executed; RTO recorded in `DR-RUNBOOK.md`

### Known incomplete
- 45/72 list routes still need `withOrgScope` binding — 28 high-leverage are done; tail can land as routes are touched. Documented in commit summary.
- `audit_dlq` replay sweeper not written (P2 from Sprint 2).

---

## Sprint 7 — UI keys + HttpOnly cookie + CSRF

**Branch:** `claude/sprint-7-ui-cookie`
**Base:** previous merges

### Summary
Stable React keys on 8 mutable editor surfaces + token migrated from localStorage to HttpOnly cookie with double-submit CSRF. 5 commits.

### What changed

**Stable keys (Task 1)**
8 editor surfaces use stable client-only `_uid` (UUID, stripped before submit) instead of `key={idx}`:
- `accounting/index.tsx` — journal entry line editor
- `invoices/credit-notes.tsx`, `invoices/debit-notes.tsx` — line item editors
- `sales/create.tsx` — added `makeEmptyLine()` factory, fixed clone path, draft restore backfills `_uid`
- `sales/edit.tsx` — uses `id ?? _uid ?? idx` so existing rows keep their server id
- `consignment/create.tsx`, `consignment/edit.tsx` — mirror of sales
- `components/scan-po-modal.tsx` — Claude PO item table key now scoped per uploaded file

Static error/warning/skeleton lists deliberately left alone (immutable).

**Cookie + CSRF (Task 2)**

Backend (`auth-middleware.ts`, `auth.ts`, `auth-totp.ts`):
- Login / accept-invite / TOTP-login-verify Set-Cookie `hookka_session` (HttpOnly, Secure, SameSite=Strict) + `hookka_csrf` (Secure, SameSite=Strict, JS-readable)
- Login response body: `{ user, csrfToken }` — no `token` field
- Auth middleware prefers cookie; **Bearer fallback retained for one release window**
- CSRF only enforced on POST/PUT/PATCH/DELETE when authenticated via cookie (Bearer callers immune during migration)
- Logout clears both cookies via `Max-Age=0`

Frontend (`auth.ts`, new `csrf.ts`, `api-client.ts`, `fetch-json.ts`, `kv-config.ts`, `use-presence.ts`, `login.tsx`, `InviteAccept.tsx`, `bom.tsx`):
- `AuthBlob` no longer carries the token; `getAuthToken()` is a deprecated no-op shim
- `csrf.ts` reads `hookka_csrf` cookie via `document.cookie`
- Global `window.fetch` interceptor and `fetchJson` add `credentials: 'include'` on `/api/*` and `X-CSRF-Token` on mutating methods
- Login / accept-invite stop pulling `token` from response body

**Worker portal** (`/api/worker/*`) intentionally NOT migrated — stays on `x-worker-token` (mobile-friendly PIN auth).

### Test plan
- [x] `npm test` — 84/84 passing
- [x] `npm run typecheck:app` — clean
- [ ] After deploy: any user signed in via old localStorage flow gets a single 401 on next /api/* → bounced to /login → re-authenticate once
- [ ] After deploy: `Set-Cookie: hookka_session=...; HttpOnly; Secure; SameSite=Strict` visible on login response
- [ ] After deploy: POST without `X-CSRF-Token` (when cookie-authed) returns 403

### Migration risk
Documented in commit messages: any user signed in via old localStorage flow will get a single 401 on the next `/api/*` call, bounced to `/login`, and re-authenticate once. The migration window keeps Bearer fallback for one release.

---

## Sprint 5 — Performance + monitoring + production search

**Branch:** `claude/sprint-5-performance-monitoring`
**Base:** previous merges (LAST in the sequence)

### Summary
POD photo compression off main thread + 326KB mock-data bundle eliminated + PDF/XLSX dynamic imports + production search F1-F4 + optional Sentry. 8 commits.

### What changed

**1. POD photo compression off main thread**
`src/lib/image-compress.ts` (new) — `createImageBitmap` + `OffscreenCanvas.convertToBlob` on modern browsers, falls back to FileReader/canvas on Safari < 16.4. Updated 4 callers (POD-dialog, service-cases create + detail, service-orders create) with sequential per-photo loop and `Compressing N / M…` spinner.

**2. mock-data.ts bundle pruning (326KB → 0 in SPA)**
- `src/lib/pricing-options.ts` (new) — pricing constants
- All `from "@/lib/mock-data"` value imports in `src/pages/**` and `src/components/**` rerouted to `@/types` (types) or `@/lib/pricing-options` (constants)
- ESLint `no-restricted-imports` rule blocks regression
- Backfilled missing types into `src/types/index.ts`

**3. PDF generators dynamic import**
12 static imports converted to `await import("@/lib/generate-...-pdf")` inside click handlers across sales/index, sales/detail, consignment/index, consignment/detail, delivery/detail, procurement/index, procurement/detail, production/department, customers, invoices/detail. The 1MB `pdf` chunk is now lazy.

**4. XLSX dynamic import**
`src/components/ui/batch-import-dialog.tsx` — `await import("xlsx")` inside handlers. 421KB chunk no longer ships on every page.

**5. Drain raw setTimeout to scheduler hooks**
The two documented P4.3-followup `setTimeout`-in-`useEffect` blocks in `src/pages/production/index.tsx` migrated to `useTimeout(fn, condition ? 300 : null)`.

**6. Filter input debounce**
`src/pages/consignment/return.tsx` wraps free-text customer filter in `useDeferredValue`.

**7. Production overview F1-F4 search optimization**
In `src/pages/production/index.tsx`:
- F1: 200ms debounce between input state and URL `q` param
- F2: `Map<poId, string>` haystack pre-computed once when `orders` lands
- F3: `Map<poId, Set<string>>` itemType flags pre-computed once
- F4: `Map<poId, Map<deptCode, Map<wipKey, JobCard>>>` picker index — replaces per-row filter+sort with O(1) lookups

Expected: laptop per-keystroke latency 30-50ms → <5ms; Android 100-200ms → <20ms.

**8. Optional Sentry / GlitchTip monitoring**
- `src/lib/monitoring.ts` (frontend) and `src/api/lib/monitoring.ts` (worker) — both no-op when DSN env unset
- Both dynamic-import the SDK (`@sentry/react` / `toucan-js`) via string-variable form so TS doesn't fail on missing-package
- Wired `initMonitoring()` into `src/main.tsx` and `app.onError(...)` into `src/api/worker.ts`
- `SENTRY_DSN?` added to worker `Env.Bindings` type and documented in `.dev.vars.example` and `wrangler.toml`
- **Packages NOT in `package.json`** — installation is opt-in (run `npm install @sentry/react toucan-js` if you want it active)

### Test plan
- [x] `npm test` — 84/84 passing
- [x] `npm run typecheck:app` — clean
- [x] `npm run build:strict` — passes
- [x] `node scripts/check-bundle-size.mjs` — 115 stems within +5% of refreshed baseline
- [ ] After deploy: F12 record on /production overview, type filter — confirm < 5ms per key
- [ ] After deploy: open POD dialog on Android over 4G with 5×10MB photos — confirm no main-thread freeze

### Pre-launch ops
- [ ] (optional) `npm install @sentry/react toucan-js` + set `SENTRY_DSN` if you want error monitoring active

---

## Final integrated test plan (after all 7 merge)

```bash
# In the merged main:
npm run typecheck:app    # 0 errors expected
npm run lint:app         # ~92 known errors (P2 — see docs/KNOWN-ISSUES.md)
npm test                 # 179+ tests pass
npm run build:strict     # build succeeds
node scripts/check-bundle-size.mjs  # within +5% of baseline; mock-data chunk removed
```

Smoke tests on staging:
1. Login flow (cookie set, CSRF token returned)
2. Curl with WORKER token on any of 51 gated mutating routes → 403
3. Curl `/api/fg-units/<id>` without auth → no PII fields
4. Double-click "Post Invoice" → 1 invoice, 1 journal entry chain row
5. POD photo upload on mid-tier Android over throttled 4G → no UI freeze
6. F12 record on /production overview filter typing → < 5ms per key
