# Accounting & Invoicing — Module Guide

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
  - `src/pages/accounting/index.tsx` — ~10.6k-line mega-page hosting ~30 tabs. Tab host /
    dispatch is `AccountingPage` at **L498-604** (URL `?tab=<key>` is source of truth; keys:
    `overview pl bs cashflow coa journals tb gl ar ap supplier-discount payments receipts
    transfer cashbook assets labor stock opening stockmap openstock stocktake maint audit …`).
    Key tabs: Overview **L606**, Opening Stock (F6 FIFO seed) **L1290** / `OpeningStockTab`
    **L1876**, COA **L2287** / `COATab` **L2289**, Journal Entries **L2872** /
    `JournalEntryForm` **L3104**, AR **L3354** / `ARTab` **L3572**, AP **L3785** / `APTab`
    **L4400**, Supplier Discount **L3944**, P&L **L4609** / `PLStatementTab` **L5144**, Other
    Debtors/Creditors **L5420**, Trial Balance `TrialBalanceTab` **L6725**, General Ledger
    `GeneralLedgerTab` **L6959**, Payment/Expense `PaymentsTab` **L7443**, Official Receipt
    `ReceiptsTab` **L7917**, Fund Transfer **L8188**, Stock Summary **L8420**, Labour month-end
    **L8674**, Fixed Assets + Depreciation **L8898**, Cash Book / Bank Recon **L9188**, Opening
    Balance **L9530**, Balance Sheet `BalanceSheetTab` **L10237**, Cash Flow `CashFlowTab`
    **L10461**.
  - `src/pages/accounting/cash-flow.tsx` — standalone cash-flow; `src/pages/accounting/tabs/AuditLogTab.tsx` — extracted F3 audit-log tab.
  - Invoicing: `src/pages/invoices/index.tsx` (list), `detail.tsx` (per-line-discount editor),
    `payments.tsx` (customer receipts), `supplier-payments.tsx` (pay PIs / FX),
    `credit-notes.tsx` / `debit-notes.tsx`, `e-invoice.tsx` (MyInvois).
- **API routes**
  - `/api/accounting/*` → `src/api/routes/accounting.ts` (~11.5k lines, Hono `app`, 143 handlers).
    Groups: COA **L690/700/780**, rename **L913**; Journals **L1025/1055**, lifecycle **L1456**;
    AR control **L1543**, AP control **L2331**; AR/AP reconciliation **L2732 / L2557**;
    debtor/creditor ledger **L3127 / L3172**; other-party bills **L3474 / L3612 / L3763** +
    payments **L3913**; trial-balance **L4560**; year-close **L4974 / L5003**; P&L **L7605** (also
    serves balance sheet), pl-statement **L7367**, cost-structure **L7146**, cost-expense-classes
    **L7238**; stock-summary **L5587**; labour post **L9138**; opening-balance **L10525 / L10928**;
    stock-take **L11085** + rm-valuation-mode **L11115**; material-opening-stock **L11362/L11411**.
  - `src/api/routes/invoices.ts` — sales invoices (~2.2k). `payments.ts` — customer receipts.
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
1. **Sales invoice create → GL post → void cascade** — `POST /api/invoices` (`invoices.ts` **L1131**)
   builds from a DO and flips the DO to INVOICED; GL legs via `buildInvoiceLedgerLegs`
   (**L79**, DR debtor-control from customer code / fallback `300-0000`, CR revenue split by
   product category). Posting fires on the DRAFT→SENT transition inside `PUT /:id` (**L1418**,
   see **L1471**). `DELETE /:id` (**L2124**) cascades to `sales_orders` / `so_status_changes` /
   `delivery_orders` + customer running balance — edit the cascade, not just the row.
   ⚠️ symmetric create-as-SENT does **not** yet post (known gap).
2. **PI → GL on APPROVED** — a purchase invoice posts whenever it *reaches* APPROVED, on both the
   PUT transition and create-as-APPROVED, via shared `buildPiApprovalLegs` (`src/lib/pi-posting.ts`
   **L35**; DR mapped buckets · CR `400-0000`), idempotent through `ledgerHasSource`
   (`src/api/lib/journal-hash.ts` **L117**). Opening PIs use `/opening-balance/ap` and post no PI legs.
3. **P&L FIFO engine** — `loadMaterialCostData` (`accounting.ts` **L6066**) replays GRN receipts +
   `cost_ledger` RM_ISSUE/ADJUSTMENT through `material-cost-fifo.ts`; `computePnlWindow` (**L6824**)
   consumes its `rmGroups/wipOpenSen/wipCloseSen/fgOpen/fgClose` and feeds `/pl` **L7605**,
   `/pl-statement` **L7367**, `/cost-structure`, `/cost-expense-classes`. `glWindowSigned` (**L5898**)
   nets ledger legs per account (incl. opening-slice — see `src/lib/opening-slice.ts`).
4. **Closing-stock journal** — `buildClosingStockLegs` (**L5435**) posts month-end 330 = closing −
   opening from `stockSummaryRange` (still the source for the journal legs, even though P&L reads FIFO).

## Key functions / sections (locate-to-function)
| Tab / endpoint / function | file:line | Role |
|---|---|---|
| `AccountingPage` (tab host) | `accounting/index.tsx:498` | URL-driven dispatch across ~30 tabs |
| `buildInvoiceLedgerLegs` | `invoices.ts:79` | Sales-invoice GL legs (debtor DR / revenue CR by category) |
| PUT invoice (DRAFT→SENT post) | `invoices.ts:1471` | Posts invoice to GL on the SENT transition |
| `buildPiApprovalLegs` | `lib/pi-posting.ts:35` | PI GL legs on APPROVED (idempotent) |
| `ledgerHasSource` | `api/lib/journal-hash.ts:117` | GL posting idempotency guard |
| knock-off / un-knock PI | `supplier-payments.ts:415 / 558` | Apply / reverse supplier payment to PI |
| Purchase credit note POST/PUT/void | `accounting.ts:1890 / 2010 / 2215` | Supplier discount (DR400/CR-purchase) |
| `GET /ar-control` · `/ap-control` | `accounting.ts:1543 · 2331` | Control-account totals + aging |
| `GET /ap-reconciliation` · `/ar-reconciliation` | `accounting.ts:2557 · 2732` | Itemized 400/300 drift breakdown |
| `GET /trial-balance` | `accounting.ts:4560` | TB from `ledger_journal_entries` |
| `GET /pl` (P&L + balance sheet) | `accounting.ts:7605` | Report engine (FIFO-fed) |
| `loadMaterialCostData` / `computePnlWindow` | `accounting.ts:6066 / 6824` | FIFO material cost + per-window P&L |
| `buildClosingStockLegs` | `accounting.ts:5435` | Month-end closing-stock journal |
| `POST /year-close` | `accounting.ts:5003` | FY profit close into retained earnings |
| `POST /labor/post` | `accounting.ts:9138` | Labour month-end GL posting |
| `PUT /rm-valuation-mode` · `GET /stock-take` | `accounting.ts:11115 · 11085` | Periodic-inventory toggle |
| `POST /opening-balance/post` | `accounting.ts:10928` | Owner-entered opening balances (incl. mid-year P&L) |

## Gotchas
- **Money = integer sen** (`amountSen`, `discount_sen`); never floats — round via `roundSen` / `distributeRoundSen` in `src/lib/utils.ts`.
- **`document_lifecycle` JOIN is load-bearing** — list endpoints must return `lifecycleState` or the FE shows void/delete on already-voided docs (F3 hotfix, commit 8221d726).
- **`journal_entries` (journal module) ≠ `ledger_journal_entries` (posted GL)** — reports read the ledger; don't cross the wires.
- **`cost_ledger` is append-only** — written side-effectually by GRN / production / DO. Accounting reads only; never write it from these routes.
- **P&L reads the FIFO engine, NOT `cost_ledger` perpetual totals** (ledger stopped being fed after 2026-03). `computePnlWindow` uses `loadMaterialCostData`; only closing-stock journal legs still use `stockSummaryRange`.
- **Ledger is immutable + hash-chained** — post new legs, never mutate; idempotency via `ledgerHasSource(...,sourceType,id)`.
- **Migrations are inert** unless runtime self-applied — new columns reach prod only via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` awaited inside the route before the first write (e.g. `invoices.ts:1123` for `discount_sen`).
- **New DB columns = snake_case** + a `column-rename-map.json` entry or writes 400 with 'Invalid request body' (CI-guarded by `tests/sql-write-column-coverage.test.mjs`).
- **Invoice mutations cascade** to `sales_orders` / `so_status_changes` / `delivery_orders` / customer balance — edit the cascade.
- **PI posts on reaching APPROVED via BOTH create and PUT** — keep both paths posting; sales invoices still post only on the PUT DRAFT→SENT transition (create-as-SENT gap unfixed).
- **Periodic-inventory mode** (`kv rm_valuation_mode`=`stock_take_only`): RM value = latest stock-take + PI purchases since; bypasses BOM/FIFO. Re-Post any posted month after flipping (`stockTakeChainValue` in `material-cost-fifo.ts`).
- **Opening-month P&L slice** is a report-layer injection (zero ledger rows) — `applyOpeningSlice` in `src/lib/opening-slice.ts`; opening legs are netted, not dropped.
- **Multi-company scoping** appends `&orgId=<code-lowercased>`; `/pl-statement` deliberately does NOT accept `orgId` (would need FIFO threaded through — out of scope).
- **`e-invoices.invoiceId` is intentionally not FK-enforced** (legacy standalone e-invoices). Service-order invoices price RM 0 by owner ruling.

## Common tasks (mini-playbook)
- **Add a money field to an invoice/PI** → snake_case column + runtime `ALTER … ADD COLUMN IF NOT EXISTS` before the INSERT (pattern `invoices.ts:1123`); add a `column-rename-map.json` entry; read dual-keyed `r.camelCase ?? r.snake_case`; store integer sen via `MoneyInput`/`roundSen`.
- **Add a GL posting for a new document type** → build legs in a `src/lib/*-posting.ts` helper, guard with `ledgerHasSource` (`journal-hash.ts:117`), post on the status transition AND the create-as-final path (see `pi-posting.ts:35`); never mutate existing ledger rows.
- **Add a report tab** → new `TabKey` in `TABS` + a `{tab === "x" && <XTab/>}` branch in `AccountingPage` (`accounting/index.tsx:498`); back it with an `app.get("/x")` reading `ledger_journal_entries` (+ `computePnlWindow` if it needs material cost).
- **Diagnose an AR/AP control-vs-subledger drift** → hit `GET /ap-reconciliation` (`accounting.ts:2557`) or `/ar-reconciliation` (**L2732**) BEFORE hand-reconciling; the itemized rows sum exactly to the drift (pure `src/lib/ap-recon.ts`).

## Related modules
[[sales]] [[procurement]] [[inventory]] [[production]] [[delivery]]
