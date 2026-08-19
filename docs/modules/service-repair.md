# Service & Repair — Module Guide

> **Last verified: 2026-08-19** against `src/api/routes/{service-cases,service-orders,sales-orders,stock-adjustments}.ts`,
> `src/lib/{repair-scope,so-mode}.ts`, `src/api/lib/bom-wip-breakdown.ts`,
> `src/api/routes/sales-orders/_helpers.ts`, all four `src/pages/service-order*/` trees
> (including reading the singular re-export files in full), `src/api/worker.ts`,
> `tests/db-schema.json`, and `ls tests/`.
> Corrected 2026-08-19 — **every `sales-orders.ts` offset in this guide was wrong**, including
> the ones the 2026-08-13 pass "corrected" to `:1503`/`:1751`. Re-derived from the source:
> SO create is `app.post("/")` **`:1593`** (matching [[sales]]); `const isServiceOrder =
> body.isServiceOrder === true` is **`:1841`**; `body.caseId` is read at **`:1848`** and
> validated against `service_cases` at `:1856-1864`; the auto-pricing skips are the two
> `if (!isServiceOrder && …)` guards at **`:1926`** and **`:1943`**.
> ⚠️ `sales-orders.ts` was being edited by ANOTHER session while this audit ran, TWICE
> (5,704 → 5,716 at 19:10, +12 above `:1593`; → **5,733** at 19:14, +17 below `:4414`).
> Every offset into it here is re-derived against the **5,733-line** file — all of them sit
> below `:2228` and so were unaffected by the second edit, but re-derive if `wc -l`
> disagrees. Also:
> `ensurePendingMigrations` is `_helpers.ts:1283` (the `caseid` ALTER is at `:1327`);
> `ServiceCaseDetailPage` `:204`; `ServiceOrderDetailPage` `:129`; and `caseid` is
> **folded-lowercase, not snake_case** — see the corrected gotcha.
> **Everything else re-verified EXACT**: all of `service-orders.ts` (`:531/556/1214/1468/1669`,
> 1,859 lines), `service-cases.ts` (`:60/178/208/239/366/386/614/757`), all four
> `repair-scope.ts` anchors (`:292/410/443/524`), `deriveTopLevelWipKey`
> `bom-wip-breakdown.ts:125`, `stock-adjustments.ts:209`, `so-mode.ts:27`, the
> `worker.ts:1419-1420` mounts, `detail.tsx` = 3,600 lines, and the columns
> `sales_orders.caseid` / `sales_orders.is_service_order` / `stock_adjustments.caseid` /
> `production_orders.repairscope` / `sales_order_items.repairscope`. All four named tests exist.

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Owns the after-sales repair lifecycle in two halves that share one case backbone:
1. **Service Cases** — the complaint/root-cause record. A case captures the issue (5W template), multi
   root-cause analysis (RCA), affected product SKUs, damaged parts, photos, an action log, and stock-only
   **replacement-part top-ups**. It spawns SV orders and rolls their progress back into a display pipeline.
2. **Service (SV) Orders** — the repair/return execution. Two flavours coexist and must not be confused:
   - **Singular `service-order/*`** = thin re-exports of the Sales pages running in SV mode (`isServiceOrder=true`).
     No own data model — they hit `/api/sales-orders`, and a SV order rides `sales_orders` linked to a case via
     `sales_orders.caseid`. **These price RM 0 by default** (auto-pricing fully skipped, BUG-016).
   - **Plural `service-orders/*`** = a real, separate returns/repair module with its own list + detail, backed by
     `/api/service-orders` (returns lifecycle, mode/scope, scrap path).

**Repair scope** narrows what a repair actually rebuilds: `production_orders.repairscope` (FULL=null=byte-identical
legacy path) plus component-level picks on `affectedProducts[].components`, all resolved through ONE shared
`deriveTopLevelWipKey` formula — never re-implement it.

## Entry points
- Pages
  - `/service-cases` → `src/pages/service-cases/index.tsx:248` (`ServiceCasesListPage` — case list)
  - `/service-cases/:id` → `src/pages/service-cases/detail.tsx:204` (`ServiceCaseDetailPage` — 3,600-line command center)
  - `/service-orders` → `src/pages/service-orders/index.tsx:119` (`ServiceOrdersListPage`; `CreateServiceOrderModal` at `:314`)
  - `/service-orders/:id` → `src/pages/service-orders/detail.tsx:129` (`ServiceOrderDetailPage` — returns, repair scope; `SetModePanel` `:845`, `LogReturnModal` `:731`)
  - `/service-order/*` (SINGULAR) → `src/pages/service-order/index.tsx` + `create/detail/edit.tsx` — re-exports of
    `@/pages/sales/*` in SV mode via `useSOMode` (`src/lib/so-mode.ts:27`). Edit `src/pages/sales/*`, never fork them.
- API routes
  - Service Cases CRUD + status + photos + RCA → `src/api/routes/service-cases.ts` (1032 lines)
  - SV-order returns/repair lifecycle + mode/scope → `src/api/routes/service-orders.ts` (1859 lines)
  - SO MODE (`isServiceOrder`) co-owner for the re-export pages → `src/api/routes/sales-orders.ts`
  - Repair-scope engine (serialize/parse/validate/filter) → `src/lib/repair-scope.ts`
  - Shared WIP-key derivation → `src/api/lib/bom-wip-breakdown.ts:125` (`deriveTopLevelWipKey`)
  - Replacement-part top-ups → `src/api/routes/stock-adjustments.ts` (reason `SERVICE_REPLACEMENT` + `caseId`)
  - Registration → `src/api/worker.ts:1419` (`/api/service-cases`) · `:1420` (`/api/service-orders`) · `/api/sales-orders` at `:1195`

## Data model
- `service_cases` — the case header (source SO/CO/EXTERNAL, status OPEN→IN_PROGRESS→CLOSED/CANCELLED, issue, RCA JSON, `affectedProducts` JSON, photos).
- `service_orders` / `service_order_lines` / `service_order_returns` — the PLURAL module's own returns/repair rows.
- `sales_orders` — a SINGULAR SV order IS a sales order; `caseid` (mig 0165) links it to a case; `is_service_order` mode flag.
- `sales_order_items` — SV order lines (may carry runtime `repairscope`); price 0 by default.
- `production_orders.repairscope` (JSON string; FULL=null) — what the repair rebuilds; `job_cards` / `fg_batches` downstream.
- `stock_adjustments` — replacement parts: reason `SERVICE_REPLACEMENT` + `caseid` (mig 0164); NO production order created.
- `stock_movements` / `cost_ledger` — written by the return **scrap** path (integrity-sensitive).
- Relationships: a case spawns SV orders (`sales_orders.caseid`); confirming a scoped SV order filters WIPs by `repairscope`; replacement parts bypass production entirely and land as stock adjustments backlinked to the case.

## Core flows
1. **Create case** — `app.post("/")` `service-cases.ts:614`. Allocates case no (`nextCaseNo` `:366`), sanitizes RCA
   (`sanitizeRootCauses` `:178`, `synthesizeRootCauses` `:208`) and `affectedProducts`, stores photos JSON.
2. **Case status transition** — `app.put("/:id/status")` in `service-cases.ts`, gated by `STATUS_TRANSITIONS` (`:60`).
   Case pipeline is auto-computed display-only in the FE (`CasePipeline` `detail.tsx:965`) from linked SV-order progress.
3. **Spawn SV order from a case** — `SpawnServiceOrderModal` (`detail.tsx:3096`) POSTs `/api/sales-orders` with
   `isServiceOrder:true` + `caseId`. Backend `sales-orders.ts:1593` reads the flag at `:1841` and `body.caseId` at `:1848`
   (rejecting a `caseId` on a non-service order, `:1849-1852`, and 404ing an unknown case, `:1856-1864`),
   writes the `caseid` column (INSERT column list at `:2228`), and **skips auto-pricing** for service orders —
   the two `if (!isServiceOrder && …)` guards at `:1926` and `:1943`.
4. **Replacement-part top-up** — `StockTopUpPanel` (`detail.tsx:2448`) POSTs `/api/stock-adjustments` with reason
   `SERVICE_REPLACEMENT` + `caseId`. Stock-only — no production order.
5. **Repair scope resolution** — component picks canonicalized (`canonicalizeComponentPicks` `repair-scope.ts:524`),
   validated write-side (`validateRepairScopeInput` `:292`), and job-card WIPs filtered by scope
   (`filterWipsByRepairScope` `:410` / `filterWipsByRepairComponents` `:443`) using `deriveTopLevelWipKey`.
6. **Return → scrap** — `app.post("/:id/returns")` `service-orders.ts:1468` records a return;
   `app.post("/:id/returns/:rid/scrap")` `:1669` scraps it, writing `stock_movements` / `cost_ledger` (mind idempotency).

## Key functions / sections (locate-to-function)
| Symbol / section | file:line | Role |
|---|---|---|
| `ServiceCasesListPage` | `src/pages/service-cases/index.tsx:248` | Case list |
| `ServiceCaseDetailPage` | `src/pages/service-cases/detail.tsx:204` | Case command center (header/tabs/orchestration) |
| `CasePipeline` | `src/pages/service-cases/detail.tsx:965` | Auto-computed display-only progress stepper |
| `RootCausePanel` | `src/pages/service-cases/detail.tsx:1052` | Multi root-cause editor (manual Add/Save; verifiedSave ref impl) |
| `StockTopUpPanel` | `src/pages/service-cases/detail.tsx:2448` | Records `SERVICE_REPLACEMENT` stock adjustments vs the case |
| `SpawnServiceOrderModal` | `src/pages/service-cases/detail.tsx:3096` | Spawns a SV order (`isServiceOrder`+`caseId`) under the case |
| `ServiceOrdersListPage` | `src/pages/service-orders/index.tsx:119` | Plural SV-order list |
| `CreateServiceOrderModal` | `src/pages/service-orders/index.tsx:314` | Create a plural SV order |
| `ServiceOrderDetailPage` | `src/pages/service-orders/detail.tsx:129` | Plural SV-order detail (returns, repair scope) |
| `app.post("/")` (case create) | `src/api/routes/service-cases.ts:614` | Create case + RCA/affected-products sanitize |
| `app.put("/:id")` (case edit) | `src/api/routes/service-cases.ts:757` | Case edit (`ensureCaseLinkColumns` `:239`) |
| `STATUS_TRANSITIONS` (case) | `src/api/routes/service-cases.ts:60` | Legal case status moves |
| `sanitizeRootCauses` / `synthesizeRootCauses` | `src/api/routes/service-cases.ts:178 / 208` | RCA normalization |
| `app.post("/")` (SV-order create) | `src/api/routes/service-orders.ts:556` | Plural SV order create (`ensureServiceOrderMigrations` `:531`) |
| `app.put("/:id/mode")` | `src/api/routes/service-orders.ts:1214` | Set SV-order mode/scope |
| `app.post("/:id/returns")` | `src/api/routes/service-orders.ts:1468` | Record a return line |
| `app.post("/:id/returns/:rid/scrap")` | `src/api/routes/service-orders.ts:1669` | Scrap a return → `stock_movements`/`cost_ledger` |
| `deriveTopLevelWipKey` | `src/api/lib/bom-wip-breakdown.ts:125` | THE shared WIP-key formula (repair scope + job cards) |
| `validateRepairScopeInput` | `src/lib/repair-scope.ts:292` | Strict write-side repair-scope validator |
| `filterWipsByRepairScope` / `filterWipsByRepairComponents` | `src/lib/repair-scope.ts:410 / 443` | Job-card WIP filter by scope/components |
| SV-order pricing skip | `src/api/routes/sales-orders.ts:1926` | Service orders keep the operator-typed price (0 = free); flag read at `:1841` |

## Gotchas
- **Two directories, near-identical names.** `service-order/*` (SINGULAR) = re-exports of Sales pages in SV mode via
  `useSOMode()` (`src/lib/so-mode.ts`); `service-orders/*` (PLURAL) = the real returns/repair module. Don't confuse them.
- **The singular pages have NO own data model** — the four files under `src/pages/service-order/` are 6–18 lines each and are literally `export { default } from "@/pages/sales…"`. They hit `/api/sales-orders` with `isServiceOrder:true`. Changing service-order behavior usually means editing `src/pages/sales/*` (NOT a fork) or `sales-orders.ts`. Never fork the sales list — it is now **2,181 lines** (the in-code comment still says ~1,400).
- **Service orders price RM 0 by default** (auto-pricing fully skipped, BUG-016; the `isServiceOrder` flag is read at `sales-orders.ts:1841` and the two skips are at `:1926` / `:1943`). 0 means 0
  (free / goodwill repair) — don't reintroduce auto-pricing on SV orders. Locked SO headers (production COMPLETED + DO delivered) cannot be zeroed.
- **Replacement parts bypass production.** A case top-up = `stock_adjustments` with reason `SERVICE_REPLACEMENT` +
  `caseid` (mig 0164) — NO production order. The panel POSTs `/api/stock-adjustments` (handler `stock-adjustments.ts:209`), not the service-cases route. Don't route replacement parts through production.
- **Repair scope has ONE key formula.** `production_orders.repairscope` (FULL=null=byte-identical legacy path);
  component picks on `affectedProducts[].components` resolve via the shared `deriveTopLevelWipKey` — never re-implement it. Stale picks throw at confirm.
- **`caseid` is FOLDED-LOWERCASE, not snake_case** — one word, no underscore, on both `sales_orders` and `stock_adjustments` (confirmed in `tests/db-schema.json`). Runtime self-applied (`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS caseid` at `sales-orders/_helpers.ts:1327`, inside `ensurePendingMigrations` `:1283`); read dual-keyed (`r.caseId ?? r.caseid`). ⚠️ `column-rename-map.json` DOES carry `caseId → case_id`, which is a DIFFERENT column name from the one that exists — so do not route a `caseId` write through the rename map for these two tables. `production_orders.repairscope` and `sales_order_items.repairscope` are folded-lowercase for the same reason. **New DB columns = snake_case** (+ `column-rename-map.json` if exposed as camelCase).
- **Scrap path is integrity-sensitive.** `POST /:id/returns/:rid/scrap` writes `stock_movements` / `cost_ledger` — mind idempotency.
- **UI is 100% English.** `window.confirm` is replaced by `useConfirm`; manual-save surfaces use `verifiedSave` + an unsaved-nav guard (`RootCausePanel` is the reference impl).

## Common tasks (mini-playbook)
- **Add a field to a Service Case** → column self-apply in `service-cases.ts` (see `ensureCaseLinkColumns` `:239`);
  persist in `app.post("/")` (`:614`) and `app.put("/:id")` (`:757`); surface via `rowToApi` (`:386`); render in
  `detail.tsx:204`. New column = snake_case.
- **Change SV-order behavior (singular)** → edit `src/pages/sales/*` or `sales-orders.ts` — never fork the sales pages.
  The `isServiceOrder` branch lives at `sales-orders.ts:1841` (flag) and `:1926` / `:1943` (pricing skips).
- **Adjust repair scope / WIP filtering** → change `src/lib/repair-scope.ts` (validate `:292`, filter `:410`/`:443`);
  the WIP key is `deriveTopLevelWipKey` (`bom-wip-breakdown.ts:125`) — shared, never re-implement. Verify with `tests/repair-scope.test.mjs`.
- **Touch the returns/scrap flow** → PLURAL `service-orders.ts` (return `:1468`, scrap `:1669`);
  keep the scrap `stock_movements`/`cost_ledger` writes idempotent. Verify with `tests/service-hub-chain.test.mjs`.
- **Tests** → `tests/case-pipeline.test.mjs`, `tests/repair-scope.test.mjs`, `tests/service-cases-rootcauses.test.mjs`, `tests/service-hub-chain.test.mjs`.

## Related modules
[[sales]] [[production]] [[inventory]] [[delivery]] [[accounting]]
