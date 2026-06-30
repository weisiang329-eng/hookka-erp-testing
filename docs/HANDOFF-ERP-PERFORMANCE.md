# Session Handoff — ERP slowness / login 500 / weak-wifi unusable

> Pick this up in a fresh session. Self-contained: problem → confirmed diagnosis
> (with measured numbers) → root causes → 3-prong fix plan → files → first
> actions. Owner = Wei Siang (non-technical, communicates in Chinese; UI 100%
> English; bug fixes → `main`, features → `staging`).

## The problem (owner-reported, 2026-06-29/30)
On weak factory wifi the ERP is effectively unusable: the **login shows
"Timed out while creating a new server connection" and the console logs a 500**
on `/api/auth/login`. Owner's sharp point: **"other apps work fine on the SAME
wifi — only this ERP can't load."** So it is NOT simply the wifi.

## Confirmed diagnosis — it is SERVER-SIDE, not the wifi
Tested `POST /api/auth/login` with dummy creds (→ 401, correct) from a **good
internet connection** (so wifi is out of the picture):

| host | run 1 | run 2 | run 3 |
|---|---|---|---|
| **prod** (erp.hookka.com) | **30.3 s** | 3.1 s | **19.9 s** |
| **staging** (staging.hookka-erp-testing.pages.dev) | 4.2 s | 2.5 s | 1.4 s |

So the login backend is **3–30 s server-side**, prod worse + erratic. The owner
also hit an outright **500** (the connection failed, not just slow). Page RENDER
is fast (LCP 0.86 s, INP 48 ms) — the pain is (a) downloading a big JS bundle,
(b) waiting on / failing the DB backend.

## Root causes (two, both ours — not the wifi)
1. **DB connection layer.** Stack = Cloudflare Workers + Supabase Postgres via
   Hyperdrive → Supavisor transaction pooler (6543). Per-request a new
   `postgres` client is created (`src/api/lib/db-pg.ts getSql`, `max:1`,
   `prepare:false`). **Cold connection creation = 20–30 s → 500/timeout.** The
   prod (Hyperdrive) branch has **NO `connect_timeout`** (removed 2026-06-04 —
   a 10 s cap was fast-failing slow-but-working requests under load, blanking
   lists). The erratic 30/3/20 s pattern = connection-pool contention. Strong
   signal of **Supabase capacity** (compute / connection-limit / pooler
   saturation / possibly auto-pause), not app logic — the error is literally
   "creating a new server **connection**".
2. **Big JS bundle.** Owner 2026-06-29: `react-vendor.js` took **38 s** to
   download on weak wifi. Heavy libs (pdf-lib, jspdf, qrcode, jsbarcode,
   @zxing, possibly xlsx) are likely eagerly bundled. First-load weight is the
   "needs strong wifi" feeling; other apps are smaller / already cached.

## The fix plan — 3 prongs (real ERPs get all three right)
1. **Supabase capacity — OWNER (their account).** Check prod Supabase
   (`vpwdqtsxexpiqxzweivd`, Singapore): active connection count vs the tier
   limit, compute size, and whether it auto-pauses/scales. **Right-size it.**
   This is the biggest lever on the 3–30 s / 500. (Stage = `zaxygxwadidiqcphibma`,
   Tokyo.)
2. **Code — THE DEV WORK:**
   - **Login/DB resilience (URGENT).** In the per-request DB middleware
     (`src/api/worker.ts` ~line 285, runs before authMiddleware) or in `getSql`,
     add a **connection retry** (1–2 attempts, short backoff) so a transient
     cold connect → retry instead of a hard 500, and surface a graceful error
     instead of a raw 500. ⚠️ Do NOT reintroduce a tight `connect_timeout` (the
     2026-06-04 revert shows a 10 s cap fast-fails under load and blanks lists);
     a RETRY is the safe lever. Verify-live: cold login should stop 500ing.
   - **Bundle code-split (HIGH).** In `vite.config.*` (manualChunks) split the
     vendor chunk; **lazy-load heavy libs only when used** (PDF / Excel /
     scanner via `React.lazy` / dynamic `import()`), so the login + core pages
     don't pull pdf-lib/xlsx/@zxing. Confirm the service worker caches the
     chunks so the 2nd load is instant. Target: cut first-load JS sharply.
3. **Wifi — OWNER (hardware).** The parked **Level 1** (mesh AP + 4G failover).
   Software helps the first load + resilience, but a weak floor network has a
   hard floor. See `MEMORY.md` → weak-wifi campaign.

## Diagnosis specifics (scoped diagnosis, 2026-06-30) — exact findings

### Supabase — THE BIGGEST LEVER (owner's dashboard; may fix the login NOW, no code)
Prod = `vpwdqtsxexpiqxzweivd` (Singapore). The prod-30s-vs-staging-1-4s pattern
points straight here:
1. **Connection Pooling → Supavisor → Max Connections: raise to ≥ 50.** The
   default (~10-15) is FAR too low — every Cloudflare Worker request opens its
   own connection via Hyperdrive, so under any concurrency the pooler STARVES and
   new connections wait → the 30 s hang / 500. **Most likely the real cause.**
2. **Configuration → Auto-pause: DISABLE for prod.** Idle pause adds a 1-3 s+
   cold-wake on the first login after a quiet period.
3. **General → Compute size: ensure ≥ Standard (Small), NOT Nano/Micro.** Low
   tiers (~1 GB RAM) cap connection concurrency, compounding the starvation.

### Login 500 / DB connection (code — the dev work)
- **No retry + raw 500.** `src/api/worker.ts` dbInject (~310-322) creates a new
  `postgres` client per request with NO retry; a transient connection failure
  becomes a raw 500. **Fix:** wrap `getSql()` in a retry (catch "Timed out while
  creating a new server connection", sleep ~50-100 ms, retry once); on the 2nd
  failure return **503** (retriable), not 500.
- **Login query unwrapped.** `src/api/routes/auth.ts` login (~160-164; batch ~235)
  has no try/catch around the user SELECT → a DB timeout surfaces as a raw 500 via
  `app.onError`. **Fix:** try/catch → 503 "Login service temporarily unavailable,
  please try again"; audit-log the error (not the raw exception).
- **⚠️ connect_timeout — DECIDE CAREFULLY.** The diagnosis suggests restoring
  `connect_timeout: 5000` on the Hyperdrive branch (`db-pg.ts` ~88-106). BUT the
  2026-06-04 EMERGENCY REVERT removed a 10 s cap because under load it fast-failed
  slow-but-working LIST queries (blanked Sales/Delivery). 5 s is TIGHTER than that
  10 s, so a blanket connect_timeout risks re-introducing that regression on the
  heavy lists. **The safe lever is the RETRY above, not a tight global timeout.**
  If you add one, scope it so it can't fast-fail the heavy list endpoints, and
  test under load.
- **Observability.** Add per-stage `console.warn` timers in the login handler
  (after rate-limit / user SELECT / password verify / session batch) to localize
  future slowness. PBKDF2 (100k iters) is async — confirmed NOT the bottleneck;
  the connection lag is.

### Bundle (code) — a real config regression
- **React vendor chunk is NOT being split despite the config.** `vite.config.ts`
  (~92-114) DEFINES manualChunks (react-core / react-dom / react-router) but the
  build emits a SINGLE `react-vendor-*.js` (267 KB — bigger than the 87 KB the
  comment assumes); no separate react-core/react-dom/react-router chunks exist.
  The split condition isn't matching node_modules paths (suspected path-separator
  issue at build). **Fix:** correct the manualChunks path match so React/
  scheduler/react-dom/react-router emit as separate chunks → HTTP/2 parallel
  streaming → faster first paint on weak wifi. [code-quick]
- Heavy libs (pdf-lib, jspdf, xlsx, recharts) ARE already lazy-loaded ✓; the
  pre-paint loading UI is in place ✓. So the infra is good — the react-vendor
  split is the regression to fix first; lucide-react icons could be lazier on
  icon-light routes.

## Relevant files
- DB connection: `src/api/lib/db-pg.ts` (`getSql`); `src/api/worker.ts`
  (~278 `pickDbUrl` Hyperdrive-vs-DATABASE_URL; ~285 the DB middleware that
  creates the connection per request — the place to add a retry).
- Login handler: `src/api/routes/auth.ts` (the `/login` route — count its DB
  queries; check for a slow bcrypt/argon; sequential vs parallel).
- Bundle: `vite.config.*` (chunking); heavy-lib import sites
  (`src/lib/generate-*-pdf.ts`, `src/lib/qr-utils.ts`, any `xlsx` import).
- Pre-paint loading state: `index.html` (already added; keep).

## First actions for the new session
1. Re-run a scoped diagnosis (DB-connection/login-500 code-fixable-vs-infra +
   bundle quick-wins) to get the exact retry code + the exact lazy-load splits —
   OR just implement from the plan above.
2. Ship the **login-500 resilience (connection retry)** → `main` → verify-live
   (cold login stops 500ing).
3. Implement the **bundle code-split** quick wins → measure first-load JS before/after.
4. Tell the owner the **Supabase capacity** check (connections / compute / auto-pause).

## Other open work (separate handoff docs already in the repo)
- `docs/PACKING-SCAN-HANDOFF.md` — packing-sticker scan + completion (mint `/p/`
  robustness on poNo drift, `jc=` sticker fallback, completed-row-vanish, tests).
  The completion logic is CONFIRMED CORRECT (first scan completes; PIC2 = labor split).
- `docs/PENDING-TASKS-HANDOFF.md` — remaining pending (most already shipped; the
  real dev items: mint `/p/` robustness [HIGH], Packing-List stacked rack layout
  [mockup-first], regression tests).
- An `IMPLEMENTATION-DRAFTS.md` (copy-pasteable code drafts) was in progress but
  NOT finished — regenerate it if the new owner wants paste-ready drafts.

## Non-negotiable rules
- **build:strict before every push:** `npx tsc -p tsconfig.app.json --noEmit`
  AND `npx tsc -p tsconfig.json --noEmit` (ignore only the 3 jsbarcode/@zxing
  sandbox errors).
- Migrations do NOT auto-apply on deploy — new columns reach prod via runtime
  `ALTER TABLE … ADD COLUMN IF NOT EXISTS` awaited before the first write.
- New DB columns = snake_case; read dual-keyed `r.camelCase ?? r.snake_case`.
- Money = integer sen. CSRF is global (`src/lib/api-client.ts` patches
  `window.fetch`) — no fetch is "missing CSRF". QR/sticker URLs follow the
  print-time origin, canonicalized to `erp.hookka.com` on prod.
- Additive, never break existing. Verify live on prod after deploy. UI mockup
  before any UI/PDF change. Bug fixes → `main`, features → `staging`. UI English.
- Entry docs: `CLAUDE.md`, `docs/context-packs/NAVIGATION-MAP.md` (find code),
  `docs/context-packs/HOOKKA-GOTCHAS.md` (traps), `docs/WORK-TRACKER.md` (state).
