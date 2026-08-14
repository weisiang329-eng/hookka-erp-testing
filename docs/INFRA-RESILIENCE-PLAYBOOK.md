# Infra Resilience & Performance Playbook

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `src/api/lib/supabase-compat.ts:256` (`withConnRetry`, wired into every query path at :285-312), `src/api/routes/auth.ts:174-193` (graceful 503 on login), `.github/workflows/keep-warm.yml` (`*/5 * * * *` → `GET /api/pg-ping`), `wrangler.toml` (`[vars] SENTRY_DSN` set), and `src/api/worker.ts:1082,1474`.
> Corrected 2026-08-13: the status columns were four levers behind. `withConnRetry` and the graceful-503 login are **shipped, not "written, not deployed"**; the keep-warm heartbeat is **live** as a GitHub Action; and the Sentry DSN **is set**, worker-side and client-side.
> **UNVERIFIED ASSERTION** (as of 2026-08-13): everything in the Supabase dashboard — pool size 50, compute tier, PITR, the platform-incident block — cannot be checked from this repo. Treat those rows as the owner's last-known state, not fact.

> **Purpose.** A reusable, copy-to-any-project playbook for keeping a
> **Cloudflare Workers + Supabase Postgres** app (like Hookka ERP) **fast and
> reliable — especially on weak networks**. Written so a sister project can copy
> the same setup step by step.
>
> **Plain-language framing for non-engineers:** this whole topic is called
> **SRE (Site Reliability Engineering) / DevOps / Infrastructure** — "make the
> system fast and don't let it fall over." The specific job here is **database
> performance tuning + scaling + fault tolerance**.

---

## 1. The problem this solves

On weak factory wifi the ERP became effectively unusable: **login took 3–30 s,
threw 500 errors, and kept force-logging people out.** Tested from a *good*
internet connection too — so it was **mostly server-side, not the wifi**. The
weak wifi only *amplified* an already server-side problem.

**Root cause:** every request opens a **fresh database connection**; the pooled
connections were too few (default 15), the database was too small (Nano, shared
CPU) and went cold when idle, so under any load requests **queued → 30 s hang →
500 → and any failure bounced the user to the login page.**

```
你按一個頁面 → 要跟資料庫拿資料 → 要借一條連線
  連線太少(15) → 排隊 → 卡30秒
  資料庫太小/睡著 → 接線本身就慢(20-30秒)
  接太久 → 失敗 → 白屏/500 → 被踢回登入頁
弱wifi = 在以上每一關再加一刀
```

---

## 2. The full lever menu (priority order)

Each lever: **what it is (IT term) · what it buys · how · status in this repo.**
Status legend: ✅ live · ⚠️ written, not deployed · ⏳ blocked/waiting · ⬜ not started.

### Tier 0 — Capacity (the biggest, mostly owner/dashboard)
| Lever | IT term | What it buys | How | Status |
|---|---|---|---|---|
| Raise pool size to ~50 | **Connection pooling** | Removes the "everyone queues behind 15 connections" hang | Supabase → Settings → Database → Connection pooling → Pool size = 50 | ✅ set |
| Bigger compute | **Vertical scaling / scaling up** | More RAM/CPU + higher connection ceiling; faster + raises the safe pool-size limit | Supabase → Settings → Compute and Disk → **Small** (2 GB). Restart, do off-hours. **Pool size & compute scale together — don't raise one without the other** | ⏳ blocked by a Supabase platform incident (project resizing was failing globally — see status.supabase.com) |
| Disable auto-pause | **Keep-warm (config)** | No cold-wake on the first login after idle | Supabase compute settings | ⬜ check (may not apply on paid compute) |

### Tier 1 — Fault tolerance (our code — the resilience layer)
| Lever | IT term | What it buys | How | Status |
|---|---|---|---|---|
| Retry a failed DB **connection** once | **Retry / fault tolerance / resilience** | A transient "couldn't create a connection" becomes a successful (slightly slower) request instead of a hard 500. Safe because it only retries *connection-establishment* errors (nothing was executed yet → no double-writes) | `src/api/lib/supabase-compat.ts:256` → `withConnRetry`, wrapping every query path at :285-312 | ✅ **shipped** (committed and on `main`) |
| Graceful login fallback | **Graceful degradation** | If the DB is truly down, login shows "busy, try again" (HTTP 503) instead of a raw 500 white screen | `src/api/routes/auth.ts:174-193` — try/catch → 503 with the "login can't reach the DB" comment | ✅ **shipped** |
| Don't logout on a transient failure | **Fault tolerance** | A laggy request no longer force-bounces the user to `/login`. Backend returns 503 (retriable), frontend retries before clearing the session | backend: return 503 not 401 when the DB errors during session verify (`auth-middleware.ts`); frontend: retry once before `clearAuth()` (`api-client.ts`) | **SPLIT — re-checked 2026-08-14.** Backend ✅ **SHIPPED**: the session-verify `catch` returns 503, not 401 (`auth-middleware.ts:415-431`, *"returning 401 here would force-bounce an authenticated user to /login on a momentary DB blip"*). Frontend ⬜ not started: `api-client.ts:168-178` still clears auth immediately on 401 — but the transient case now arrives as 503, so it no longer logs anyone out. |
| Keep-warm heartbeat | **Warm-up / keep-alive** | The DB connection never goes cold, so the *first* user after a quiet spell doesn't pay the 20–30 s cold-start | `.github/workflows/keep-warm.yml` — `cron: '*/5 * * * *'`, curls the public `GET /api/pg-ping`, 3 attempts, best-effort | ✅ **live** (GitHub Action, since 2026-06-30) |

### Tier 2 — Knowing before it breaks (observability)
| Lever | IT term | What it buys | How | Status |
|---|---|---|---|---|
| Error tracking | **Observability / error tracking** | You get alerted the moment errors spike — before workers complain | Sentry. Worker DSN is in `wrangler.toml [vars] SENTRY_DSN` and consumed by `src/api/worker.ts:1474` → `reportWorkerError`; the browser DSN is injected as `VITE_SENTRY_DSN` by `.github/workflows/deploy.yml` | ✅ **DSN set, both sides** |
| Uptime + alerts | **Monitoring / alerting** | A text/email if the site or DB goes down. The pinger doubles as keep-warm | UptimeRobot (free) on `/api/health` + `/api/pg-ping`; Supabase dashboard alerts | ⬜ not started |
| Health dashboard | **Observability** | One screen for CPU / memory / connections / error rate | Supabase → Reports → Database; app's own `/admin/health` | ✅ exists (Supabase) |

### Tier 3 — Safety net & scale (do as you grow)
| Lever | IT term | What it buys | How | Status |
|---|---|---|---|---|
| Point-in-time recovery | **Backups / disaster recovery (PITR)** | Restore to *any minute* if data is corrupted/deleted — critical for an ERP holding orders, money, stock | Supabase add-on (daily backups already on; PITR is the upgrade) | ⬜ daily-only today |
| Slow-query tuning | **Query optimization / indexing** | Fix the few slowest queries → everything feels faster | Supabase → Reports shows "slow queries"; add indexes / rewrite | ⬜ ongoing |
| Read replica | **Horizontal read scaling** | Heavy reports run on a copy, so they don't slow operational work | Supabase read replica add-on | ⬜ later |
| Cache stable data at the edge | **Caching / CDN** | Reference data (catalog, customers, config) served instantly. **NEVER cache live money/stock/orders** — staleness is dangerous | Cloudflare KV / edge cache, **write-through invalidated** (bust on every write) | ⚠️ partial (sessions cached in KV; frontend uses stale-while-revalidate that *always* re-fetches) |
| Offline-capable shop floor | **Offline-first / resilience** | Punch/scan works even when wifi drops, syncs on reconnect | IndexedDB queue + UUID idempotency (parked Level-2 work) | ⬜ parked |
| Network hardware | **Infrastructure** | The hard floor under weak wifi | Mesh APs + 4G failover (owner) | 🔧 owner, in progress |

---

## 3. Honest status for THIS project (Hookka ERP)

### As re-measured from source, 2026-08-13

- ✅ **Live and verified in code:** DB connection-retry (`withConnRetry`);
  graceful-503 login; keep-warm heartbeat every 5 min via
  `.github/workflows/keep-warm.yml`; Sentry DSN set worker-side and
  client-side.
- ⬜ **Still not started:** don't-logout-on-transient (the
  `auth-middleware.ts` 503-instead-of-401 + `api-client.ts` retry pair);
  UptimeRobot / external alerting.
- ❓ **Not checkable from this repo** (dashboard-only — ask the owner):
  pool size 50, compute tier, auto-pause, PITR, read replica.

### Original 2026-06-30 snapshot (kept for provenance — superseded above)

- ✅ **Live then:** OCR multi-page fix (timeout + 3-strike retry + self-heal);
  pool size 50 (set in Supabase).
- ⚠️ **Written but NOT deployed:** the DB connection-retry + graceful-503 login
  — sitting uncommitted in the working tree. *(Both have since shipped.)*
- ⏳ **Blocked:** compute → Small (Supabase platform incident on project
  resizing; retry once their status page clears). Verify it lands on the **prod**
  project `vpwdqtsxexpiqxzweivd` ("weisiang329-eng's Project"), not a sibling.
  *(Outcome unknown from source.)*
- ⬜ **Not started:** keep-warm heartbeat; don't-logout-on-transient; Sentry DSN;
  uptime alerting; PITR. *(Keep-warm and Sentry have since landed.)*

---

## 4. Copy-to-a-new-project checklist

To give another Cloudflare Workers + Supabase app the same resilience:

1. **Pooling:** Supabase → Database → Connection pooling → pool size ≈ 50
   (keep it under ~80% of the compute's max connections, or you get a warning).
2. **Compute:** size it to your real concurrency (start Small/2 GB; watch
   Reports → if CPU/Memory/Connections stay < ~70–80% at peak, it's enough).
   Raise pool size and compute *together*.
3. **Connection retry:** copy `withConnRetry` (Tier 1) into the DB adapter so
   every query retries a transient connection-create failure once.
4. **Graceful auth:** login + session-verify return **503 (retriable)**, never a
   raw 500, when the DB is unreachable; the frontend retries before logging out.
5. **Keep-warm:** a 1–5 min scheduled ping to a tiny `/pg-ping` route
   (GitHub Action or UptimeRobot — Pages can't cron).
6. **Monitoring:** set `SENTRY_DSN`; add an UptimeRobot monitor on `/health`.
7. **Backups:** turn on PITR for anything holding money/orders/stock.
8. **Caching rule:** cache only stable reference data, write-through invalidated;
   never cache live money/stock/orders.

---

## 5. Glossary (so you can talk to engineers / Google it)

| 我們做的事 | IT 術語 | 白話 |
|---|---|---|
| 連線數調 50 | Connection Pooling | 開幾個櫃檯 |
| 升 Small | Scaling Up / Vertical Scaling | 換大台機器 |
| 保溫心跳 | Warm-up / Keep-alive | 讓引擎一直熱著 |
| 失敗自動重試 | Retry / Fault Tolerance / Resilience | 失敗了自動再試 |
| 看 CPU/記憶體/錯誤 | Monitoring / Observability | 儀表板看健康 |
| 「能撐多少人」規劃 | Capacity Planning | 算清楚要多大 |
| 隨時能還原資料 | Backups / Disaster Recovery (PITR) | 出事救得回來 |
| 整體目標 | Performance & Reliability (SRE) | 又快又穩 |

---

*Living doc — update the status columns as each lever ships. Origin:
weak-wifi / login-500 investigation, 2026-06-30. (The cited
`docs/archive/HANDOFF-ERP-PERFORMANCE.md` does not exist as of 2026-08-13 — dead
link, do not go looking for it.)*
