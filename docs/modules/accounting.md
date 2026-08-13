# Accounting & Invoicing — Module Guide

> **Last verified: 2026-08-13** against `src/pages/accounting/index.tsx`, `src/api/routes/accounting.ts`, `src/api/routes/invoices.ts`, `src/api/routes/supplier-payments.ts`, `src/lib/pi-posting.ts`, `src/api/lib/journal-hash.ts`, `src/api/worker.ts`, and `tests/`.
> Corrected 2026-08-13: file sizes for `accounting.ts` (11.5k→13.1k) and `invoices.ts` (2.2k→3.0k) were understated, and ~25 line anchors had drifted 100–800 lines (all verified anchors below re-derived by grep). Unverified anchors are marked ±.

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Full double-entry accounting layered on a manufacturing ERP: chart of accounts, journal
entries, an immutable posted general ledger (`ledger_journal_entries`), AR/AP control +
aging, and the financial reports (P&L, balance sheet, trial balance, cash flow). Sales
invoices, customer receipts, supplier PI payments, credit/debit notes and MyInvois e-invoices
live alongside it. The P&L material cost is driven by a FIFO/periodic-inventory engine
(`src/lib/material-cost-fifo.ts`) — not by the perpetual `cost_ledger`, which is now
read-only/append-only. Money is integer sen throughout.

## Entry points
- **Pages**
  - `src/pages/accounting/index.tsx` — 11,147-line mega-page hosting ~30 tabs. Tab host /
    dispatch is `AccountingPage` at **L510** (URL `?tab=<key>` is source of truth; keys:
    `overview pl bs cashflow coa journals tb gl ar ap supplier-discount payments receipts
    transfer cashbook assets labor stock opening stockmap openstock stocktake maint audit …`).
    Key tab components (verified 2026-08-13): `OpeningStockTab` **L1892**, `COATab` **L2341**,
    `JournalEntryForm` **L3175**, `ARTab` **L3643**, `APTab` **L4471**, `PLStatementTab`
    **L5273**, `TrialBalanceTab` **L6897**, `GeneralLedgerTab` **L7194**, `PaymentsTab`
    **L7730**, `ReceiptsTab` **L8204**, `BalanceSheetTab` **L10757**, `CashFlowTab` **L10981**.
    (The per-tab `{tab === "x" && …}` JSX branches sit inside `AccountingPage`; jump by tab key,
    not by a remembered line.)
  - `src/pages/accounting/cash-flow.tsx` — standalone cash-flow; `src/pages/accounting/tabs/AuditLogTab.tsx` — extracted F3 audit-log tab.
  - Invoicing: `src/pages/invoices/index.tsx` (list), `detail.tsx` (per-line-discount editor),
    `payments.tsx` (customer receipts), `supplier-payments.tsx` (pay PIs / FX),
    `credit-notes.tsx` / `debit-notes.tsx`, `e-invoice.tsx` (MyInvois).
- **API routes**
  - `/api/accounting/*` → `src/api/routes/accounting.ts` (13,054 lines, Hono `app`), mounted at
    `worker.ts:1326`. Verified anchors: AR control **L1672**, AP control **L2470**; AP/AR
    reconciliation **L2704 / L2879**; trial-balance **L4792**; year-close **L5235**;
    stock-summary **L5819**; pl-statement **L7578**; P&L **L7840** (also serves balance sheet);
    labour post **L9499**; opening-balance post **L12452**; stock-take **L12617** +
    rm-valuation-mode **L12647**. (COA / journals / debtor-creditor ledger / other-party bills /
    cost-structure / cost-expense-classes / material-opening-stock live in the same file but
    their line anchors are unverified — grep the handler path.)
  - `src/api/routes/invoices.ts` — sales invoices (2,983 lines). `payments.ts` — customer receipts.
    `supplier-payments.ts` — pay PIs (money-critical). `cost-ledger.ts` — read-only append-only
    reads. `e-invoices.ts` — MyInvois. `cash-flow.ts`, `stock-value.ts`, `stock-accounts.ts` (~42 lines).

## Data model
- `chart_of_accounts` / `account_aliases` — accounts + code-rename aliases (mig 0157, immutable ledger keeps old codes alive).
- `journal_entries` / `journal_lines` — the **journal module** (manually-entered JVs); distinct from the GL below.
- `ledger_journal_entries` — the **posted GL** (immutable, hash-chained). P&L / balance sheet / trial balance / GL tabs read this + `chart_of_accounts`. **Do not confuse the two.**
- `invoices` / `invoice_items` (`discount_sen` mig 0179) / `invoice_payments` / `payment_records` — sales side (camelCase DB cols).
- `purchase_invoices` / `supplier_payments` / `purchase_credit_notes` — payables side.
- `document_lifecycle` — void/unvoid/delete state; **JOIN is load-bearing** on every list endpoint.
- `cost_ledger` / `stock_accounts` / `monthly_stock_values` — append-only cost data; read-only from accounting.
- `payment_vouchers` / `official_receipts` / `other_parties` — non-trade counterparty docs.
- `credit_notes` / `debit_notes`, `rm_batches` / `fg_batches`.

## Core flows
1. **Sales invoice create → GL post → void cascade** — `POST /api/invoices` (`invoices.ts` **L1544**)
   builds from a DO and flips the DO to INVOICED; GL legs via `buildInvoiceLedgerLegs`
   (**L102**, DR debtor-control from customer code / fallback `300-0000`, CR revenue split by
   product category). Posting fires on the DRAFT→SENT transition inside `PUT /:id` (**L2024**;
   the leg build is called at **L2725**). `DELETE /:id` (**L2903**) cascades to `sales_orders` / `so_status_changes` /
   `delivery_orders` + customer running balance — edit the cascade, not just the row.
   ⚠️ symmetric create-as-SENT does **not** yet post (known gap).
2. **PI → GL on APPROVED** — a purchase invoice posts whenever it *reaches* APPROVED, on both the
   PUT transition and create-as-APPROVED, via shared `buildPiApprovalLegs` (`src/lib/pi-posting.ts`
   **L35**; DR mapped buckets · CR `400-0000`), idempotent through `ledgerHasSource`
   (`src/api/lib/journal-hash.ts` **L117**). Opening PIs use `/opening-balance/ap` and post no PI legs.
3. **P&L FIFO engine** — `loadMaterialCostData` (`accounting.ts` **L6305**) replays GRN receipts +
   `cost_ledger` RM_ISSUE/ADJUSTMENT through `material-cost-fifo.ts`; `computePnlWindow` (**L7048**)
   consumes its `rmGroups/wipOpenSen/wipCloseSen/fgOpen/fgClose` and feeds `/pl` **L7840**,
   `/pl-statement` **L7578**, `/cost-structure`, `/cost-expense-classes`. `glWindowSigned` (**L6137**)
   nets ledger legs per account (incl. opening-slice — see `src/lib/opening-slice.ts`).
4. **Closing-stock journal** — `buildClosingStockLegs` (**L5667**) posts month-end 330 = closing −
   opening from `stockSummaryRange` (still the source for the journal legs, even though P&L reads FIFO).

## Key functions / sections (locate-to-function)
| Tab / endpoint / function | file:line | Role |
|---|---|---|
| `AccountingPage` (tab host) | `accounting/index.tsx:510` | URL-driven dispatch across ~30 tabs |
| `buildInvoiceLedgerLegs` | `invoices.ts:102` | Sales-invoice GL legs (debtor DR / revenue CR by category) |
| PUT invoice (DRAFT→SENT post) | `invoices.ts:2024` | Posts invoice to GL on the SENT transition |
| `buildPiApprovalLegs` | `src/lib/pi-posting.ts:35` | PI GL legs on APPROVED (idempotent) |
| `ledgerHasSource` | `src/api/lib/journal-hash.ts:117` | GL posting idempotency guard |
| knock-off / un-knock PI | `supplier-payments.ts:572 / 733` | Apply / reverse supplier payment to PI |
| `buildSupplierPaymentLifecycle` | `supplier-payments.ts:827` | Void/delete/unvoid shared core |
| `GET /ar-control` · `/ap-control` | `accounting.ts:1672 · 2470` | Control-account totals + aging |
| `GET /ap-reconciliation` · `/ar-reconciliation` | `accounting.ts:2704 · 2879` | Itemized 400/300 drift breakdown |
| `GET /trial-balance` | `accounting.ts:4792` | TB from `ledger_journal_entries` |
| `GET /pl` (P&L + balance sheet) | `accounting.ts:7840` | Report engine (FIFO-fed) |
| `loadMaterialCostData` / `computePnlWindow` | `accounting.ts:6305 / 7048` | FIFO material cost + per-window P&L |
| `buildClosingStockLegs` | `accounting.ts:5667` | Month-end closing-stock journal |
| `POST /year-close` | `accounting.ts:5235` | FY profit close into retained earnings |
| `POST /labor/post` | `accounting.ts:9499` | Labour month-end GL posting |
| `PUT /rm-valuation-mode` · `GET /stock-take` | `accounting.ts:12647 · 12617` | Periodic-inventory toggle |
| `POST /opening-balance/post` | `accounting.ts:12452` | Owner-entered opening balances (incl. mid-year P&L) |

## Gotchas
- **Money = integer sen** (`amountSen`, `discount_sen`); never floats — round via `roundSen` / `distributeRoundSen` in `src/lib/utils.ts`.
- **`document_lifecycle` JOIN is load-bearing** — list endpoints must return `lifecycleState` or the FE shows void/delete on already-voided docs (F3 hotfix, commit 8221d726).
- **`journal_entries` (journal module) ≠ `ledger_journal_entries` (posted GL)** — reports read the ledger; don't cross the wires.
- **`cost_ledger` is append-only** — written side-effectually by GRN / production / DO. Accounting reads only; never write it from these routes.
- **P&L reads the FIFO engine, NOT `cost_ledger` perpetual totals** (ledger stopped being fed after 2026-03). `computePnlWindow` uses `loadMaterialCostData`; only closing-stock journal legs still use `stockSummaryRange`.
- **Ledger is immutable + hash-chained** — post new legs, never mutate; idempotency via `ledgerHasSource(...,sourceType,id)`.
- **Migrations are inert** unless runtime self-applied — new columns reach prod only via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` awaited inside the route before the first write (e.g. `invoices.ts:1463` for `discount_sen`).
- **New DB columns = snake_case** + a `column-rename-map.json` entry or writes 400 with 'Invalid request body' (CI-guarded by `tests/sql-write-column-coverage.test.mjs`).
- **Invoice mutations cascade** to `sales_orders` / `so_status_changes` / `delivery_orders` / customer balance — edit the cascade.
- **PI posts on reaching APPROVED via BOTH create and PUT** — keep both paths posting; sales invoices still post only on the PUT DRAFT→SENT transition (create-as-SENT gap unfixed).
- **Periodic-inventory mode** (`kv rm_valuation_mode`=`stock_take_only`): RM value = latest stock-take + PI purchases since; bypasses BOM/FIFO. Re-Post any posted month after flipping (`stockTakeChainValue` in `material-cost-fifo.ts`).
- **Opening-month P&L slice** is a report-layer injection (zero ledger rows) — `applyOpeningSlice` in `src/lib/opening-slice.ts`; opening legs are netted, not dropped.
- **Multi-company scoping** appends `&orgId=<code-lowercased>`; `/pl-statement` deliberately does NOT accept `orgId` (would need FIFO threaded through — out of scope).
- **`e-invoices.invoiceId` is intentionally not FK-enforced** (legacy standalone e-invoices). Service-order invoices price RM 0 by owner ruling.

## Common tasks (mini-playbook)
- **Add a money field to an invoice/PI** → snake_case column + runtime `ALTER … ADD COLUMN IF NOT EXISTS` before the INSERT (pattern `invoices.ts:1463`); add a `column-rename-map.json` entry; read dual-keyed `r.camelCase ?? r.snake_case`; store integer sen via `MoneyInput`/`roundSen`.
- **Add a GL posting for a new document type** → build legs in a `src/lib/*-posting.ts` helper, guard with `ledgerHasSource` (`journal-hash.ts:117`), post on the status transition AND the create-as-final path (see `pi-posting.ts:35`); never mutate existing ledger rows.
- **Add a report tab** → new `TabKey` in `TABS` + a `{tab === "x" && <XTab/>}` branch in `AccountingPage` (`accounting/index.tsx:510`); back it with an `app.get("/x")` reading `ledger_journal_entries` (+ `computePnlWindow` if it needs material cost).
- **Diagnose an AR/AP control-vs-subledger drift** → hit `GET /ap-reconciliation` (`accounting.ts:2704`) or `/ar-reconciliation` (**L2879**) BEFORE hand-reconciling; the itemized rows sum exactly to the drift (pure `src/lib/ap-recon.ts`).

## Related modules
[[sales]] [[procurement]] [[inventory]] [[production]] [[delivery]]
