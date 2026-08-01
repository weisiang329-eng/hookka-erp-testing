# System Health — coverage map, open issues, and the weekly review

Owner ask 2026-08-01: make health REAL (done — see wrangler.toml CF_ACCOUNT_ID
notes), audit coverage, fix what past data says is still broken, then review on
a cadence. This doc is the standing checklist for that cadence.

## 1. What /admin/health already captures (verified live 2026-08-01)

| Area | Endpoint(s) | Status |
|---|---|---|
| Latency P50/75/95, long tasks, cache ratio, volume | /kpis | ✅ live |
| Per-endpoint latency + error drill-down | /by-endpoint, /errors-by-endpoint, /errors-hourly, /status-breakdown, /error-messages | ✅ live |
| Trend + deploys + CI | /daily-trend, /deploys, /github-runs | ✅ live |
| Slow SQL (≥500ms) + long tasks | /slow-sql, /long-tasks | ✅ live |
| Audit + security events | /audit-feed, /security-events | ✅ live |
| Front-end: JS errors, perf (LCP/longtask), API view, stuck-UI | /fe-errors, /fe-perf, /fe-api, /fe-stuck | ✅ live |
| Config self-check | /kpis-diag (now runs the EXACT prod SQL) | ✅ live |

Retention: Analytics Engine ≈92 days. 90d range exists in the UI.

## 2. Known coverage gaps (the honest list)

1. **Nobody is paged.** The dashboard is pull-only. Mitigation: the weekly
   review below is a scheduled task, not a human memory.
2. **Cron/scheduled work is unmonitored** — snapshot warmers, MV refresh,
   agent heartbeat. A dead cron looks like "slightly slower pages", not an
   alert. Candidate: emitCounter('cron.ran'/'cron.failed') per job + a health
   card. NOT built yet.
3. **Staging (Pages preview) health is mock by design** — separate env vars.
   Do not diagnose prod config from staging (2026-08-01 lesson, see
   wrangler.toml).
4. **Email outbox / WhatsApp sends** have no failure counter in AE.

## 3. Open issues found in the FIRST real data read (24h window, 2026-08-01)

| # | Issue | Evidence | State |
|---|---|---|---|
| H1 | `/api/production-orders` P50 8s, P95 30s | health by-endpoint; owner-reported "打开卡很久" | **OPEN — fix path known.** A warmer (be17d4b4) was built then REVERTED (071fcee7): its snapshot key `dept=X&excludeCompleted=true&fields=minimal` missed the dept page's today-relative `dueFrom/dueTo` params, so it warmed a key nobody requested. Re-do with the key built EXACTLY like the dept sheet's request (mirror its dueFrom/dueTo derivation, or make the key ignore the date window). |
| H2 | `/worker/scan` — 1,609 UI freezes/24h; JS errors "The associated Track is in an invalid state" ×16, "Unsupported focusMode" ×5 | fe-errors + fe-perf | **OPEN.** These are camera/MediaStreamTrack errors from the QR scanner on worker phones — calling ImageCapture/focusMode on tracks that are stopping or on devices without focus support. Fix: feature-detect + try/catch around focusMode/ImageCapture, and stop treating scanner-teardown races as unhandled rejections. |
| H3 | 26× HTTP 500 in 24h | status-breakdown; error endpoints: `/api/consignment-orders/status-changes`, `/api/historical-sales`, `/api/production-orders/*/scan-complete` | **OPEN — needs trace-id follow-up** (each row carries trace). |
| H4 | 409 ×27 (stale-version conflicts) | status-breakdown | Likely legitimate optimistic-lock rejections; verify sample before calling it a bug. |
| H5 | Cache hit ratio 35% | /kpis | Only sales-orders list/stats emit cache counters — ratio is not comparable yet; wire remaining withSnapshot callers before judging. |

## 4. The weekly review (scheduled — do not rely on memory)

Every week, on prod (erp.hookka.com/admin/health, range=7d):
1. Status banner + KPIs: compare against last week's numbers in this doc's log.
2. 500s: any NEW endpoint erroring → open a fix task same day.
3. slow-sql + by-endpoint: top 3 — better or worse than last week?
4. fe-errors/fe-stuck: any new message shape → task.
5. github-runs: any red CI on main → root-cause, never ignore.
6. kpis-diag: `_source` must stay "ae"; `CF_ACCOUNT_ID_set:true` prefix 27cd35.
   If mock ever returns, read `_mockReason` FIRST.
7. Append one line to the log below; tick fixed H-items; add new H-items.

### Review log
| Date | P50/P95 (7d) | 500s | Notes |
|---|---|---|---|
| 2026-08-01 | 409ms / 1389ms (24h) | 26 | Baseline — first real read ever. H1-H5 opened. |
