# Reports & Analytics — Module Guide

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](../DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `src/pages/{reports,daily-report}.tsx`, `src/pages/analytics/forecast.tsx`, `src/api/routes/{reports,forecasts,dashboard-overview}.ts`, `src/api/lib/{compliance-report,efficiency-report,schedule-overdue-report,operations-report,production-brief}.ts`, `src/lib/{print-report,export-report}.ts`, and `src/api/worker.ts`.
> Corrected 2026-08-13: `ReportsPage` is at `reports.tsx:1855`, not :1315, and all five tab components had drifted 108–428 lines. `reports.ts` handler anchors shifted ~108 lines (mount is `worker.ts:1431`, internal `:1432`; `/api/forecasts` `:1345`; `/api/dashboard/overview` `:1304`). All five `src/api/lib/*-report.ts` collectors verified within ±15 lines.

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Two unrelated report worlds share the name **Reports**:
1. **Reports hub** (`/reports`) — a 5-tab client-side page (Sales / Production / Inventory / Financial / Employee). Each tab fetches the *source module's own* list API and computes its summaries in the browser; it does NOT call `/api/reports/*`.
2. **Emailed / cron reports** (`src/api/routes/reports.ts` + `src/api/lib/*-report.ts`) — server-rendered HTML+text reports pushed on a schedule or on demand: **Efficiency** (worker piece-rate efficiency), **Schedule** & **Overdue** (production schedule / late orders), **Operations** (daily/weekly/monthly ops rollup), **Production Brief** (morning CNC/cut brief, LLM-assisted), and the **Compliance / Daily Report** exception engine (`/daily-report`). Route handlers are thin shims; the real logic lives in `src/api/lib/`. Plus a small **Forecasts** CRUD route and the consolidated **Dashboard Overview** payload.

## Entry points
- Pages
  - `/reports` → `src/pages/reports.tsx:2048` (`ReportsPage` — tab router, `?tab=` URL sync)
  - `/daily-report` → `src/pages/daily-report.tsx:1009` (`DailyReportPage` — newspaper-style compliance exceptions; consumes `/api/reports/compliance.json`)
  - `/analytics/forecast` → `src/pages/analytics/forecast.tsx:50` (`ForecastPage` — demand forecast vs historical sales)
  - `/dashboard-b` → `src/pages/dashboard-b/index.tsx` (the production dashboard; `/dashboard-b` redirects to `/dashboard` — `dashboard-routes.tsx:233`. See [[dashboard]].)
- API routes (mounted in `src/api/worker.ts`)
  - `/api/reports/*` → `src/api/routes/reports.ts` (973 lines) — mount `worker.ts:1431`
  - `/api/internal/reports/*` → `internal` export of `reports.ts` (cron triggers) — mount `worker.ts:1432`
  - `/api/forecasts` → `src/api/routes/forecasts.ts` (155) — mount `worker.ts:1346`
  - `/api/dashboard/overview` → `src/api/routes/dashboard-overview.ts` (2316) — mount `worker.ts:1304`
- Report engines (logic lives here, not in the route)
  - `src/api/lib/compliance-report.ts` (1519) · `efficiency-report.ts` (644) · `schedule-overdue-report.ts` (713) · `operations-report.ts` (1248) · `production-brief.ts` (738)
- Shared client engines: `src/lib/print-report.ts` (351, WYSIWYG print) · `src/lib/export-report.ts` (146, CSV/XLSX/PDF export)

## Data model
- `forecast_entries` — the ONLY table `forecasts.ts` reads/writes (mig 0013; camelCase cols `productId`, `forecastQty`, `actualQty`).
- Compliance / Daily Report reads across the whole order→delivery→invoice + procurement chain: `sales_orders` / `sales_order_items` / `delivery_orders` / `invoices` / `purchase_orders` / `purchase_invoices` / `grns` / `production_orders` / `job_cards` (exception detectors, not one owned table).
- Efficiency: `workers` / `departments` / `working_hour_entries` / `piece_pics` / `attendance_records` (piece-rate efficiency vs allowance).
- Schedule / Overdue: `production_orders` / `job_cards` (+ delivery promise dates).
- Recipients: `kv_config` (`daily_report_recipients`) with fallback to active SUPER_ADMIN `users` / `roles`.
- Reports hub tabs own no tables — they read `/api/sales-orders`, `/api/invoices`, `/api/production-orders`, `/api/products`, `/api/purchase-orders`, `/api/workers` and aggregate client-side.

## Core flows
1. **Daily Report (compliance)** — `GET /compliance.json` `reports.ts:596` → `buildComplianceCached` (`:648`, SWR snapshot cache, serve-stale + background refresh) → `collectComplianceData` (`compliance-report.ts:1398`) returns `ComplianceData` (`:360`: grouped exception rows + counts). `daily-report.tsx:1009` renders it.
2. **Emailed report dispatch** — cron `POST /api/internal/reports/{efficiency,schedule,overdue,brief}-trigger` (`reports.ts:836/842/848/854`) → `cronGate` (`:811`, `authCron` shared-secret + skip Sun/PH) → `dispatchReport` (`:761`) resolves date + `resolveRecipients` (`:169`) → `runAndSendReport` (`:891`) collects data, renders HTML+text, `sendMail`.
3. **Manual send-now** — UI buttons hit `POST /efficiency/send` (`:374`), `/schedule/send` (`:875`), `/overdue/send` (`:880`), `/brief/send` (`:532`); all funnel into the same `dispatchReport` path but bypass the cron working-day gate.
4. **Production Brief** — `brief-trigger` (`:854`) is Agent-Console-gated (`isAgentPaused("PRODUCTION")`) and wrapped in `recordAgentRun` for token accounting; LLM budget via `llmKeyIfBudgetAllows`.
5. **Reports hub tab** — e.g. `SalesReportTab` (`reports.tsx:428`) fetches `/api/sales-orders` + `/api/invoices` and computes summaries in-browser; print via `printReport`, export via `exportReportCsv`/`Xlsx`/`Pdf`.

## Key functions / sections (locate-to-function)
| Symbol / handler | file:line | Role |
|---|---|---|
| `ReportsPage` | `src/pages/reports.tsx:2048` | Tab router + `?tab=` sync (default export) |
| `SalesReportTab` … `EmployeeReportTab` | `reports.tsx:428 / 663 / 922 / 1090 / 1552` | The 5 client-side tabs (Sales/Prod/Inv/Fin/Emp) |
| `TABS` | `reports.tsx:406` | Tab definitions |
| `DailyReportPage` | `src/pages/daily-report.tsx:1009` | Compliance exceptions page |
| `ForecastPage` | `src/pages/analytics/forecast.tsx:50` | Forecast vs historical-sales view |
| `GET /compliance.json` | `src/api/routes/reports.ts:596` | Daily Report JSON (cached) |
| `buildComplianceCached` | `reports.ts:648` | SWR snapshot wrapper (serve-stale) |
| `collectComplianceData` | `src/api/lib/compliance-report.ts:1398` | Daily Report exception engine |
| `dispatchReport` | `reports.ts:761` | Shared send path (cron + Agent Console + manual) |
| `resolveRecipients` | `reports.ts:169` | kv_config → SUPER_ADMIN fallback |
| `cronGate` / `runAndSendReport` | `reports.ts:811 / 934` | Working-day gate · collect+render+send |
| `internal` (Hono) | `reports.ts:738` | `/api/internal/reports/*` cron triggers |
| `GET /operations.json` | `reports.ts:345` | Ops rollup (daily/weekly/monthly) |
| `collectEfficiencyData` / `renderEfficiencyHtml` | `efficiency-report.ts:133 / 439` | Worker efficiency data + HTML |
| `collectScheduleData` / `collectOverdueData` | `schedule-overdue-report.ts:113 / 229` | Schedule + overdue data |
| `collectOperationsReport` | `operations-report.ts:1112` | Ops report builder |
| `collectBriefData` / `renderBriefHtml` | `production-brief.ts:386 / 467` | Morning production brief |
| `GET /` (list) / `POST /` (create) | `src/api/routes/forecasts.ts:55 / 80` | `forecast_entries` CRUD |
| `GET /` (overview) | `src/api/routes/dashboard-overview.ts:49` | Consolidated dashboard payload |
| `buildReportHTML` / `printReport` | `src/lib/print-report.ts:218 / 339` | Shared WYSIWYG print engine |
| `exportReportCsv/Xlsx/Pdf` | `src/lib/export-report.ts:27 / 41 / 82` | Shared export helpers |

## Gotchas
- **The Reports hub and `/api/reports/*` do NOT share data.** `reports.tsx` tabs fetch source-module list APIs and aggregate client-side; only `daily-report.tsx` consumes `/api/reports/compliance.json`. Don't expect matching shapes.
- **Logic lives in `src/api/lib/*`, not the route.** `reports.ts` (973) is a thin shim over `compliance-report.ts` (1519), `efficiency-report.ts` (644), `schedule-overdue-report.ts` (713), `operations-report.ts` (1248), `production-brief.ts` (738). Edit the lib, not the handler.
- **`/send` endpoints touch the email/cron path** — they resolve recipients from `kv_config` + `users` and call `sendMail`; not a pure read. The cron `-trigger` variants add `authCron` (`x-cron-secret`) + `cronGate` (skip Sunday / public holidays).
- **Daily Report is expensive → snapshot-cached.** `collectComplianceData` cold-computes ~6s across the whole order/delivery/invoice/procurement chain; `buildComplianceCached` (`reports.ts:648`) serves last-good instantly and refreshes in the background. Numbers are byte-identical.
- **Production Brief is Agent-Console-gated.** A paused `PRODUCTION` agent (or global kill switch) silences the automatic brief; manual `/brief/send` still works. It also runs under `recordAgentRun` for token accounting.
- **`forecasts.ts` reads only `forecast_entries`.** The forecast *page* additionally pulls `/api/historical-sales` and `/api/promise-date`; the route itself is a plain CRUD over one table (camelCase cols).
- **`dashboard-b/` IS the production dashboard** (it is not experimental — the legacy `/dashboard` page was retired 2026-05-21); `/dashboard-b` redirects to `/dashboard`. `charts.tsx` is lazy-loaded to defer the ~357KB recharts/d3 bundle — don't import recharts eagerly into `index.tsx`. See [[dashboard]].
- **Reuse the shared print/export engines** (`print-report.ts`, `export-report.ts`) — don't hand-roll print or CSV/XLSX/PDF.

## Common tasks (mini-playbook)
- **Add a Reports-hub tab** → new entry in `TABS` (`reports.tsx:406`) + a `<XReportTab/>` component following the existing tab pattern (fetch source API, aggregate client-side, `printReport`/`exportReport*`). No `/api/reports/*` route needed.
- **Change a Daily-Report exception rule** → edit the detector in `compliance-report.ts` and the `ComplianceData` shape (`:360`); the route + cache wrapper stay untouched. Grace windows are in `GraceDays` (`compliance-report.ts:80`).
- **Add / change an emailed report** → add a collect+render pair in a `src/api/lib/*-report.ts`, wire a `ReportKind` into `dispatchReport` (`reports.ts:761`) + a `-trigger` on the `internal` Hono (`:738`) + a manual `/send`. Recipients via `resolveRecipients` (`:169`).
- **Change report recipients / schedule** → `kv_config['daily_report_recipients']` (fallback SUPER_ADMINs); cron workflows drive the `-trigger` endpoints. Working-day skip logic is `cronGate`/`nonWorkingDayReason` (`reports.ts:811 / 154`).
- **Touch forecasts** → `forecasts.ts` CRUD (`:55 / :80`) over `forecast_entries`; the page composes it with historical-sales + promise-date.

## Related modules
[[sales]] [[production]] [[procurement]] [[delivery]] [[accounting]] [[inventory]]
