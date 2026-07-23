# Reports & Analytics — Module Guide

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Two unrelated report worlds share the name **Reports**:
1. **Reports hub** (`/reports`) — a 5-tab client-side page (Sales / Production / Inventory / Financial / Employee). Each tab fetches the *source module's own* list API and computes its summaries in the browser; it does NOT call `/api/reports/*`.
2. **Emailed / cron reports** (`src/api/routes/reports.ts` + `src/api/lib/*-report.ts`) — server-rendered HTML+text reports pushed on a schedule or on demand: **Efficiency** (worker piece-rate efficiency), **Schedule** & **Overdue** (production schedule / late orders), **Operations** (daily/weekly/monthly ops rollup), **Production Brief** (morning CNC/cut brief, LLM-assisted), and the **Compliance / Daily Report** exception engine (`/daily-report`). Route handlers are thin shims; the real logic lives in `src/api/lib/`. Plus a small **Forecasts** CRUD route and the consolidated **Dashboard Overview** payload.

## Entry points
- Pages
  - `/reports` → `src/pages/reports.tsx:1315` (`ReportsPage` — tab router, `?tab=` URL sync)
  - `/daily-report` → `src/pages/daily-report.tsx:967` (`DailyReportPage` — newspaper-style compliance exceptions; consumes `/api/reports/compliance.json`)
  - `/analytics/forecast` → `src/pages/analytics/forecast.tsx:17` (`ForecastPage` — demand forecast vs historical sales)
  - `/dashboard-b` → `src/pages/dashboard-b/index.tsx` (experimental; URL redirects to `/dashboard` — `dashboard-routes.tsx:214`)
- API routes (mounted in `src/api/worker.ts`)
  - `/api/reports/*` → `src/api/routes/reports.ts` (908 lines) — mount `worker.ts:1313`
  - `/api/internal/reports/*` → `internal` export of `reports.ts` (cron triggers) — mount `worker.ts:1314`
  - `/api/forecasts` → `src/api/routes/forecasts.ts` (131) — mount `worker.ts:1231`
  - `/api/dashboard/overview` → `src/api/routes/dashboard-overview.ts` (2043) — mount `worker.ts:1195`
- Report engines (logic lives here, not in the route)
  - `src/api/lib/compliance-report.ts` (1302) · `efficiency-report.ts` (644) · `schedule-overdue-report.ts` (678) · `operations-report.ts` · `production-brief.ts`
- Shared client engines: `src/lib/print-report.ts` (305, WYSIWYG print) · `src/lib/export-report.ts` (146, CSV/XLSX/PDF export)

## Data model
- `forecast_entries` — the ONLY table `forecasts.ts` reads/writes (mig 0013; camelCase cols `productId`, `forecastQty`, `actualQty`).
- Compliance / Daily Report reads across the whole order→delivery→invoice + procurement chain: `sales_orders` / `sales_order_items` / `delivery_orders` / `invoices` / `purchase_orders` / `purchase_invoices` / `grns` / `production_orders` / `job_cards` (exception detectors, not one owned table).
- Efficiency: `workers` / `departments` / `working_hour_entries` / `piece_pics` / `attendance_records` (piece-rate efficiency vs allowance).
- Schedule / Overdue: `production_orders` / `job_cards` (+ delivery promise dates).
- Recipients: `kv_config` (`daily_report_recipients`) with fallback to active SUPER_ADMIN `users` / `roles`.
- Reports hub tabs own no tables — they read `/api/sales-orders`, `/api/invoices`, `/api/production-orders`, `/api/products`, `/api/purchase-orders`, `/api/workers` and aggregate client-side.

## Core flows
1. **Daily Report (compliance)** — `GET /compliance.json` `reports.ts:529` → `buildComplianceCached` (`:581`, SWR snapshot cache, serve-stale + background refresh) → `collectComplianceData` (`compliance-report.ts:1219`) returns `ComplianceData` (`:281`: grouped exception rows + counts). `daily-report.tsx:967` renders it.
2. **Emailed report dispatch** — cron `POST /api/internal/reports/{efficiency,schedule,overdue,brief}-trigger` (`reports.ts:771/777/783/789`) → `cronGate` (`:746`, `authCron` shared-secret + skip Sun/PH) → `dispatchReport` (`:696`) resolves date + `resolveRecipients` (`:164`) → `runAndSendReport` (`:826`) collects data, renders HTML+text, `sendMail`.
3. **Manual send-now** — UI buttons hit `POST /efficiency/send` (`:369`), `/schedule/send` (`:810`), `/overdue/send` (`:815`), `/brief/send` (`:517`); all funnel into the same `dispatchReport` path but bypass the cron working-day gate.
4. **Production Brief** — `brief-trigger` (`:789`) is Agent-Console-gated (`isAgentPaused("PRODUCTION")`) and wrapped in `recordAgentRun` for token accounting; LLM budget via `llmKeyIfBudgetAllows`.
5. **Reports hub tab** — e.g. `SalesReportTab` (`reports.tsx:320`) fetches `/api/sales-orders` + `/api/invoices` and computes summaries in-browser; print via `printReport`, export via `exportReportCsv`/`Xlsx`/`Pdf`.

## Key functions / sections (locate-to-function)
| Symbol / handler | file:line | Role |
|---|---|---|
| `ReportsPage` | `src/pages/reports.tsx:1315` | Tab router + `?tab=` sync (default export) |
| `SalesReportTab` … `EmployeeReportTab` | `reports.tsx:320 / 547 / 741 / 872 / 1124` | The 5 client-side tabs (Sales/Prod/Inv/Fin/Emp) |
| `TABS` | `reports.tsx:298` | Tab definitions |
| `DailyReportPage` | `src/pages/daily-report.tsx:967` | Compliance exceptions page |
| `ForecastPage` | `src/pages/analytics/forecast.tsx:17` | Forecast vs historical-sales view |
| `GET /compliance.json` | `src/api/routes/reports.ts:529` | Daily Report JSON (cached) |
| `buildComplianceCached` | `reports.ts:581` | SWR snapshot wrapper (serve-stale) |
| `collectComplianceData` | `src/api/lib/compliance-report.ts:1219` | Daily Report exception engine |
| `dispatchReport` | `reports.ts:696` | Shared send path (cron + Agent Console + manual) |
| `resolveRecipients` | `reports.ts:164` | kv_config → SUPER_ADMIN fallback |
| `cronGate` / `runAndSendReport` | `reports.ts:746 / 826` | Working-day gate · collect+render+send |
| `internal` (Hono) | `reports.ts:673` | `/api/internal/reports/*` cron triggers |
| `GET /operations.json` | `reports.ts:340` | Ops rollup (daily/weekly/monthly) |
| `collectEfficiencyData` / `renderEfficiencyHtml` | `efficiency-report.ts:133 / 439` | Worker efficiency data + HTML |
| `collectScheduleData` / `collectOverdueData` | `schedule-overdue-report.ts:113 / 229` | Schedule + overdue data |
| `collectOperationsReport` | `operations-report.ts:1088` | Ops report builder |
| `collectBriefData` / `renderBriefHtml` | `production-brief.ts:378 / 452` | Morning production brief |
| `GET /` (list) / `POST /` (create) | `src/api/routes/forecasts.ts:47 / 72` | `forecast_entries` CRUD |
| `GET /` (overview) | `src/api/routes/dashboard-overview.ts:49` | Consolidated dashboard payload |
| `buildReportHTML` / `printReport` | `src/lib/print-report.ts:200 / 293` | Shared WYSIWYG print engine |
| `exportReportCsv/Xlsx/Pdf` | `src/lib/export-report.ts:27 / 41 / 82` | Shared export helpers |

## Gotchas
- **The Reports hub and `/api/reports/*` do NOT share data.** `reports.tsx` tabs fetch source-module list APIs and aggregate client-side (`reports.tsx:340` etc.); only `daily-report.tsx` consumes `/api/reports/compliance.json`. Don't expect matching shapes.
- **Logic lives in `src/api/lib/*`, not the route.** `reports.ts` (908) is a thin shim over `compliance-report.ts` (1302), `efficiency-report.ts` (644), `schedule-overdue-report.ts` (678), `operations-report.ts`, `production-brief.ts`. Edit the lib, not the handler.
- **`/send` endpoints touch the email/cron path** — they resolve recipients from `kv_config` + `users` and call `sendMail`; not a pure read. The cron `-trigger` variants add `authCron` (`x-cron-secret`) + `cronGate` (skip Sunday / public holidays).
- **Daily Report is expensive → snapshot-cached.** `collectComplianceData` cold-computes ~6s across the whole order/delivery/invoice/procurement chain; `buildComplianceCached` (`reports.ts:581`) serves last-good instantly and refreshes in the background. Numbers are byte-identical.
- **Production Brief is Agent-Console-gated.** A paused `PRODUCTION` agent (or global kill switch) silences the automatic brief; manual `/brief/send` still works. It also runs under `recordAgentRun` for token accounting.
- **`forecasts.ts` reads only `forecast_entries`.** The forecast *page* additionally pulls `/api/historical-sales` and `/api/promise-date`; the route itself is a plain CRUD over one table (camelCase cols).
- **`dashboard-b/` is disposable/experimental** and mirrors `/dashboard`; `/dashboard-b` redirects to `/dashboard`. `charts.tsx` is lazy-loaded to defer the ~357KB recharts/d3 bundle — don't import recharts eagerly into `index.tsx`.
- **Reuse the shared print/export engines** (`print-report.ts`, `export-report.ts`) — don't hand-roll print or CSV/XLSX/PDF.

## Common tasks (mini-playbook)
- **Add a Reports-hub tab** → new entry in `TABS` (`reports.tsx:298`) + a `<XReportTab/>` component following the existing tab pattern (fetch source API, aggregate client-side, `printReport`/`exportReport*`). No `/api/reports/*` route needed.
- **Change a Daily-Report exception rule** → edit the detector in `compliance-report.ts` and the `ComplianceData` shape (`:281`); the route + cache wrapper stay untouched. Grace windows are in `GraceDays` (`compliance-report.ts:52`).
- **Add / change an emailed report** → add a collect+render pair in a `src/api/lib/*-report.ts`, wire a `ReportKind` into `dispatchReport` (`reports.ts:696`) + a `-trigger` on the `internal` Hono (`:673`) + a manual `/send`. Recipients via `resolveRecipients` (`:164`).
- **Change report recipients / schedule** → `kv_config['daily_report_recipients']` (fallback SUPER_ADMINs); cron workflows drive the `-trigger` endpoints. Working-day skip logic is `cronGate`/`nonWorkingDayReason` (`reports.ts:746 / 149`).
- **Touch forecasts** → `forecasts.ts` CRUD (`:47 / :72`) over `forecast_entries`; the page composes it with historical-sales + promise-date.

## Related modules
[[sales]] [[production]] [[procurement]] [[delivery]] [[accounting]] [[inventory]]
