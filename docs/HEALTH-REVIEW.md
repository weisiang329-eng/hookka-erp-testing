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
| H1 | `/api/production-orders` P50 8s, P95 30s | health by-endpoint; owner "打开卡很久" | **FIXED (#167)** — the dept-sheet warmer's snapshot key omitted the today-relative `dueFrom/dueTo` the page actually sends, so it warmed a key nobody requested (attempt 1, be17d4b4, reverted 071fcee7). Key now built by the handler's own rule. **QA OUTSTANDING:** needs a cron cycle + fresh read to confirm the latency actually drops. |
| H2 | `/worker/scan` "UI freezes"; camera errors | fe-errors + fe-perf | **PARTLY MISDIAGNOSED.** The multi-minute "stuck" figures (`/worker/pay` 845s, `/worker` 426s) were NOT stuck pages — they were `performance.now()` measured across a phone screen-lock, plus the RUM beacon reporting itself. Both fixed in #170. The camera errors ("Track is in an invalid state" ×16, "Unsupported focusMode" ×5) are REAL and still open — feature-detect + guard the scanner teardown race. |
| H3 | 26× HTTP 500 in 24h | status-breakdown | **ROOT-CAUSED AND FIXED** once #169 made the error text visible. `scan-complete` was throwing `race lost: tried to consume 6.90893484407556e-77` — float dust in the FIFO walk, not a race (#177). `historical-sales` was a Postgres GROUP BY rejection, dead for 100% of callers since the D1 cutover (#174). `cash-flow` (#148) and `consignment/status-changes` (#160) were ALREADY fixed by others — verified by comparing last-500 timestamps against merge times, and left alone. **QA OUTSTANDING:** confirm scan-complete 500s reach zero once workers generate traffic. |
| H4 | 409 ×27 | status-breakdown | Open. Likely legitimate optimistic-lock rejections; sample before calling it a bug. |
| H5 | Cache hit ratio 35% | /kpis | Open, and NOT yet comparable: only sales-orders list/stats emit cache counters. Wire the remaining `withSnapshot` callers before judging the number. |
| H6 | Telemetry was corrupting its own dashboard | fe-api | **FIXED (#170).** `/api/fe-rum/event` was the worst "endpoint" in the system (p95 299s, max 2h08m) — the patched `window.fetch` reported the beacon's own POST, feeding a loop, and suspended-tab durations inflated p95/max. Beacon excluded from self-reporting; implausible durations dropped, not clamped; beacon given the timeout it never had. |
| H7 | 500s carried NO error text | error-messages | **FIXED (#169).** 137 handlers `return c.json(…, 500)` instead of throwing, and the middleware only captured a message on `throw`. Recovered centrally from the response body. This is what unblocked H3 — without it every 500 was unroot-causable. |

### Monitoring gaps still open
- **Nobody is paged.** Pull-only; the weekly review is the mitigation.
- **Cron/scheduled work is unmonitored** — a dead warmer looks like "pages got slower", not an alert.
- **`status:"0"` 30s timeouts** (`/api/organisations`, `/api/drivers`, `/api/delivery-orders/*`) are a DISTINCT class from 5xx — the request never returned at all. Not yet investigated.
- Email/WhatsApp send failures have no counter.

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
| 2026-08-01 | 409ms / 1389ms (24h) | 26 | Baseline — first real read ever. H1–H5 opened. |
| 2026-08-01 (later) | — | — | H1/H3/H6/H7 fixed (#167 #174 #177 #170 #169). H2 partly misdiagnosed — see row. Two 500s (cash-flow, consignment) found ALREADY fixed by others and deliberately left alone. Next read must verify: scan-complete 500s → 0, production-orders P50 down from 8s. |

## 5. Finance module — full tab-by-tab measurement (2026-08-01)

Owner: 「我发现 finance 的模块很卡」/「每个 module submodule 都应该要点进去检查」.
**All 33 accounting tabs and all 9 standalone finance pages were opened one at a
time on erp.hookka.com**, each on a cold full page load, and measured for DOM
nodes, rendered `<tbody>` rows, page height, long-task total/max and slowest
APIs. Org = HOOKKA INDUSTRIES SDN BHD, super-admin session.

**The headline: loading was never the problem.** Every finance API answered in
under half a second except the four listed in "backend" below. What the owner
feels is the browser building thousands of DOM nodes for rows that are not on
screen.

### The screens that freeze the main thread

| Tab / page | rows | DOM nodes | page height | long task (max) | its slowest API |
|---|---|---|---|---|---|
| `?tab=openstock` Opening Stock | 423 | 4,552 | 21,102px | **5,795ms** | 59ms |
| `?tab=gl` General Ledger (grouped) | 1,798 | 17,413 | 63,538px | **2,494ms** | 301ms |
| `?tab=opening` Opening Balance | 246 | 2,728 | 10,488px | **951ms** | 247ms |
| `?tab=ocreditorbills` Other Creditor Bills | 33 | 1,490 | 2,477px | 524ms | 84ms |
| `?tab=coa` Chart of Accounts | 0 (div rows) | 5,121 | 8,291px | 218ms | 76ms |
| `?tab=plmonthly` Monthly P&L | 130 | 4,306 | 4,310px | 159ms | — |

Opening Stock is the worst case because every row carries TWO controlled inputs
(qty + `MoneyInput`) — 423 materials mount 846 inputs. Typing the fourth
character into its search box blocked the thread for **2,271ms** in one task.

The General Ledger grouped view is 59 per-account `<Card>`s (one `<table>`
each), which is why row windowing alone could not fix it.

### Everything else measured clean

`pl` 819n · `coststruct` 2,039n · `cashflow` 1,189n · `bs` 849n · `tb` 1,094n ·
`payments` 1,535n · `receipts` 674n · `transfer` 741n · `journals` 883n ·
`cashbook` 739n · `assets` 749n · `ar` 1,150n · `ap` 1,143n ·
`supplier-discount` 749n · `odebtor` 764n · `odebtorbills` 737n · `odebtorpay`
749n · `ocreditor` 926n · `ocreditorpay` 1,197n · `labor` 763n · `stock` 786n ·
`stockmap` 1,170n · `stocktake` 859n · `audit` 1,076n · `maint` 802n ·
`overview` 970n — all under 260ms of long task.

Standalone pages: `/invoices` 1,214n/78ms · `/invoices/payments` 1,018n ·
`/invoices/supplier-payments` 2,091n · `/invoices/credit-notes` 852n ·
`/invoices/debit-notes` 853n · `/invoices/e-invoice` 781n ·
`/finance-dashboard` 1,352n · `/forecast` 1,798n · `/accounting/cash-flow` 892n.

### Backend follow-ups (no DOM problem, real server time)

| Endpoint | Time | Seen on |
|---|---|---|
| `/api/accounting/dashboard` | **2,010ms** | `/finance-dashboard` |
| `/api/accounting/stock-summary` | 990ms | `?tab=stock` |
| `/api/accounting/cost-by-line` | 745ms | `?tab=stock` |
| `/api/accounting/wip-detail` | 594ms | `?tab=stock` |

The Stock tab fires the last three together — ~2.3s of backend before it paints.

### NEW monitoring gaps this exercise exposed

1. **`/fe-perf` only ever returns the `longtask` metric.** There is no
   page-load, interactive or LCP series in the response at all, so "which page
   is slow to load" cannot be answered from the dashboard — only "which page
   janks".
2. **`/by-endpoint` returns only the top 10 routes by hit count.** Not one
   accounting endpoint appears, so the four slow APIs above are invisible to
   health; they were found by hand. It ignores a `limit` param.
3. **`/maintenance/sofa-combos` has zero RUM rows** in 7d. The owner reports it
   as slow; on HOOKKA INDUSTRIES it measures fast (list, expand-all, New Combo,
   edit and Copy-to-customer all ≤57ms), so either it is another company's data
   or another action — and health cannot tell us which, because it never
   recorded the route.
