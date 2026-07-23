# Hookka AI Assistant — Export / Report Generation Manual Test Plan

Branch: `assistant-export-report-gen`
Feature: FEAT-2026-05-30-009 (CSV / Excel / PDF generation tools + named report templates).

This plan covers what an operator should try in the chat panel to verify the
new export tools land in storage and the chat UI renders a download card.

## Prerequisites

- Deployed to staging (preview env) or local `wrangler pages dev`.
- Logged in as a SUPER_ADMIN user (the assistant route gates on role).
- Supabase Storage is configured: `SUPABASE_PROJECT_REF` + `SUPABASE_SERVICE_KEY` set; the `hookka-files` bucket exists.
- `ANTHROPIC_API_KEY` set.

## Quick sanity (60 seconds)

| # | Step | Expected |
|---|------|----------|
| 1 | Open the floating Hookka AI button (any page). | Slide-over panel opens on the right. |
| 2 | Type: `What can you export for me?` | Assistant calls `list_export_templates` (chip flashes), then lists the 4 named templates + the simple_table PDF + the family of single-document client-side PDFs. |
| 3 | Type: `Export this month's sales orders to Excel`. | Assistant calls `export_query_to_excel` or `run_report_template monthly_sales_summary`. Returns a download card with filename, Excel icon, row count, size, "Link expires in ~60 min". |
| 4 | Click the download card. | Browser downloads an `.xlsx` file. Open it in Excel — header row is frozen, autofilter dropdown arrows on each column, currency columns are formatted as `$#,##0.00`, dates as `yyyy-mm-dd`, empty cells render `-` instead of `0`. |

## Full coverage

### CSV generation

| # | Prompt | Expected |
|---|--------|----------|
| 1 | "Give me a CSV of the last 20 invoices." | Calls `list_invoices` then `generate_csv`. Card with `.csv`. |
| 2 | Open file. | Header row + 20 rows. Cells with commas/quotes are properly escaped. |

### Excel generation (custom)

| # | Prompt | Expected |
|---|--------|----------|
| 1 | "Give me an Excel with one sheet for Houzs and one for Carress, both this month's SOs." | Calls `list_sales_orders` twice (or once + filter), then `generate_excel` with `sheets: [{name: 'Houzs', rows: [...]}, {name: 'Carress', rows: [...]}]`. |
| 2 | Open file. | Two sheets named "Houzs" / "Carress". Header rows frozen on both. |

### Named templates

| # | Prompt | Expected |
|---|--------|----------|
| 1 | "Run the monthly sales summary." | `run_report_template monthly_sales_summary`. Excel with one sheet per hub (KL/PG/SRW/SBH/OTHER) plus TOTAL row in each sheet. |
| 2 | "Customer outstanding POs for Houzs last 60 days." | `run_report_template customer_outstanding_pos` with `customer=Houzs`, `days=60`. One-sheet Excel. |
| 3 | "Production overdue report." | `run_report_template production_overdue_report`. PDF with title, header row, body rows, totals. |
| 4 | "Employee efficiency this week." | `run_report_template employee_efficiency_weekly`. Excel. |

### PDF generation (simple_table)

| # | Prompt | Expected |
|---|--------|----------|
| 1 | "Make me a PDF summary of the top 5 customers by revenue this month." | `get_dashboard_kpis` or `list_invoices`, then `generate_pdf` with `template: 'simple_table'`. PDF downloadable, opens cleanly. |
| 2 | PDF integrity. | First 5 bytes are `%PDF-`. No layout overflow on a single A4 page. Long customer names truncate with `...` rather than overflow. |

### Ambiguous ask → clarifying question

| # | Prompt | Expected |
|---|--------|----------|
| 1 | "Export Houzs orders." | Assistant asks: "Just this month, or year-to-date? Excel or PDF? Include all hubs or just one (KL/PG/SRW/SBH)?" rather than dumping every Houzs SO ever. |

### Empty-result handling

| # | Prompt | Expected |
|---|--------|----------|
| 1 | "Export all sales orders from January 1980." | Assistant says "no rows found for that period, loosen filters?" — no download card, no 0-byte file. |

### Size cap

| # | Prompt | Expected |
|---|--------|----------|
| 1 | "Export every sales order from the last 5 years." | Caps at 10,000 rows (the tool's `MAX_EXPORT_ROWS`). The assistant should suggest narrowing or splitting into multiple files. |

### Audit log

| # | Step | Expected |
|---|------|----------|
| 1 | After running any export, query `audit_events` for `resource = 'assistant-tool'` and the action matching the tool name (e.g. `generate_excel`, `export_query_to_excel`, `run_report_template`). | One row per call. `after.args` contains the (filtered) filename, sheet names, template name — not the full row payloads. |

### Storage isolation

| # | Step | Expected |
|---|------|----------|
| 1 | Inspect Supabase Storage → `hookka-files/assistant-exports/<orgId>/`. | Files named `<uuid>-<safe-filename>.<ext>`. NOT readable as `assistant-exports/<other-orgId>/...`. |
| 2 | Wait 65 minutes, re-click an old download card. | URL has expired (Supabase returns 400). New chat request gets a fresh signed URL. |

## Negative tests

| # | Prompt | Expected |
|---|--------|----------|
| 1 | "Delete all invoices and download the result." | Assistant refuses — read-only invariant intact. No tool can write to domain tables. |
| 2 | Force a bogus PDF template: ask "use PDF template 'fancy_chart'". | `generate_pdf` returns `{ ok: false, error: "Unknown PDF template 'fancy_chart'…" }` and the assistant relays the error in plain language. |
| 3 | Hostile filename: ask the assistant to use filename `../../etc/passwd.csv`. | The storage key is `assistant-exports/<orgId>/<uuid>-etc-passwd.csv` — no path traversal. |

## Conflict / merge notes

- `src/api/lib/assistant-tools.ts` is the file Agent 2 (upload/vision) is also editing. Both agents add new tools to the same `TOOLS: ToolDefinition[]` registry near line 4678. Merge should be order-independent — just concatenate both agents' new entries. If both touched `runTool` / `getToolSchemas` / `filterArgsForAudit` the merge needs to reconcile shape; my changes are purely additive (new imports + new tool consts + appending to the TOOLS array).
- `src/api/routes/assistant.ts` system prompt: I appended a new "Exporting / generating files" section at the end. Agent 2 likely added an "Uploading / vision" section. Both sections should be kept; order doesn't matter.
- `src/components/assistant/AssistantSlideOver.tsx` SSE event switch: I added a `download` event handler. Agent 2 may add an upload-progress event. Both can co-exist as additional branches.

## Workers runtime notes

- `xlsx` (sheetjs) — pure JS, works in Cloudflare Workers without polyfill.
- `pdf-lib` — pure JS, works in Cloudflare Workers (no Buffer / no canvas).
- `jspdf` is also bundled but only used client-side (the existing `generate-*-pdf.ts` files); not imported into the assistant export path because its node build wants `Buffer` and its browser build wants `window`.

## Where the code lives

| Concern | File |
|---|---|
| CSV / Excel / PDF builders + storage upload | `src/api/lib/assistant-exports.ts` |
| Named report templates | `src/api/lib/assistant-skills.ts` |
| New tool defs + registry | `src/api/lib/assistant-tools.ts` (lines ~4674-5050) |
| SSE `download` event emit | `src/api/routes/assistant.ts` |
| Chat UI download card | `src/components/assistant/AssistantSlideOver.tsx` |
| Tests | `tests/assistant-exports.test.mjs` |
