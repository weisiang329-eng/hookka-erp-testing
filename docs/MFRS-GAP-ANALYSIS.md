# MFRS — Gap Analysis for Hookka ERP Accounting

> **Last verified: 2026-08-13** against `src/api/routes/accounting.ts`,
> `src/api/lib/journal-hash.ts`, `src/api/lib/trade-finance.ts`,
> `src/api/routes/invoices.ts`, `src/api/routes/supplier-payments.ts`,
> `migrations-postgres/` (**252** files as at 2026-08-14), plus a targeted re-grep of `src/api/`.
>
> **Every 🔴 gap is still open on 2026-08-13.** Re-grepped across `src/api/routes/`
> and `src/api/lib/`: `NRV` / `write-down` / `obsolescence` → 0 hits;
> `doubtful` / `impair` → 0 hits; `deferred tax` → 0 hits; `warranty` → 1 hit, in
> `equipment.ts` (equipment warranty dates, not a MFRS 137 provision);
> `changes in equity` → 0 hits. No migration in `migrations-postgres/` adds a
> provision, allowance, tax or SOCE table. So the assessment stands as written.
>
> Corrected 2026-08-13: one thing has changed since 2026-07-18 —
> **trade finance shipped 2026-08-11** (`migrations-postgres/0223_trade_finance.sql`,
> `src/api/lib/trade-finance.ts`, `src/lib/trade-finance.ts`): per-draw due dates and
> repayment allocations, with draw amounts always derived from the live ledger family
> net rather than stored. It is not covered by any row above and touches the same
> posting layer; assess it before quoting this file as complete.
>
> Line-number citations in the "Detail + code evidence" sections were **not**
> re-verified one by one — `accounting.ts` has moved substantially since 2026-07-18.
> Treat them as pointers to a symbol, not to a line.
>
> > **UNVERIFIED ASSERTION** (as of 2026-08-13): everything framed as what MFRS
> > *requires*, which provisions are *material*, the suggested build order, and the
> > recommendation to scope P1 with the accountant are policy and professional
> > judgement, not checkable from source. Treat as owner intent, not fact.

**Date:** 2026-07-18 · **Status:** assessment only — NO accounting code or data changed.
**Purpose:** owner asked to run the accounting to MFRS (Malaysian Financial Reporting Standards,
the IFRS-aligned standards issued by the MASB), and to see the gaps first.

---

## Headline

**The accounting engine is in far better shape than most SME ERPs.** It has a genuine,
tamper-evident, hash-chained double-entry general ledger; it recognises revenue on delivery
(the correct point for furniture sales); it runs a FIFO/periodic inventory cost basis; it
produces all four financial statements from the GL; and it has a real fixed-asset register with
depreciation posting. **The gaps are mostly the "judgement" standards** — writing inventory down
to net realisable value, providing for bad debts and warranty, and income-tax accounting — plus
some presentation-format items. **None of these are "the books are wrong"; they are "the books
don't yet reflect the estimates and disclosures MFRS requires."**

⚠️ **Do not let anyone rebuild this blindly.** It is live financial data with a hash chain and
reversal discipline. Every change below must reuse the existing posting/void paths, be dry-run
planned, and be checked against the reconciliation endpoints — the same discipline used for the
AP/AR reconciliation work.

---

## Executive summary

| MFRS area | Where we stand | Severity |
|---|---|---|
| Double-entry GL integrity | Hash-chained, balanced, reversal-not-delete, idempotent | 🟢 strong (1 gap: no DB-level immutability trigger) |
| MFRS 15 Revenue recognition | Revenue posts on delivery (performance obligation met) | 🟡 partial (no deposit/contract-liability; a create-as-SENT posting gap) |
| MFRS 102 Inventory valuation | FIFO + periodic cost basis, testable | 🟡 partial (**no lower-of-cost-and-NRV / obsolescence**) |
| MFRS 101 Presentation | TB, P&L, Balance Sheet, Cash Flow all exist, GL-sourced | 🟢 strong availability / 🟡 partial conformance |
| MFRS 9 Receivables impairment | AR aging (30/60/90) exists | 🔴 gap (no ECL / doubtful-debt provision) |
| MFRS 112 Income taxes | — | 🔴 gap (no current or deferred tax) |
| Sales tax (SST) | Posts to real 350-0000 / 706-0000 liability accounts | 🟡 partial (no SST-02 return, no tax classification) |
| MFRS 119 Employee benefits | Labour accrues to GL (410-0010) via month-end run | 🟡 partial (lump accrual; no separate statutory payables; manual step) |
| MFRS 116 PPE / depreciation | Register + straight-line + GL posting | 🟢 strong (disposal gain/loss manual; no impairment/revaluation) |
| MFRS 137 Provisions / warranty | — | 🔴 gap (no warranty provision) |
| MFRS 121 Foreign currency | AP-side realised FX (gain/loss to 530-0000) | 🟡 partial (MYR-only AR; no period-end retranslation) |

---

## Detail + code evidence

### Double-entry GL integrity — 🟢 strong
Real double-entry in `ledger_journal_entries`, one row per leg, Σdebit=Σcredit enforced at build
(`journal-hash.ts:162/262`). **Hash chain** — each row's `rowHash` = SHA-256 over the prior hash +
leg fields (`journal-hash.ts:58-74`), nightly `verifyJournalChain` (`:309`) detects tamper and
renumber. Concurrency-safe via advisory lock (`:204-206`). Idempotent (`ledgerHasSource` +
`UNIQUE(org_id, source_type, source_id, leg_no)`). **Reversal-not-delete** everywhere (voids/
restatements post opposite entries — `accounting.ts:1323`, `invoices.ts:2019-2045`).
**Gap:** immutability is enforced only in the app layer — there is **no DB `BEFORE UPDATE/DELETE`
trigger**, so a direct SQL edit is *detected* nightly, not *prevented* (`journal-hash.ts:20` notes
the trigger "flips at M3/W9"). The `hidden` flag is mutated on posted rows to hide reversed entries
from reports (outside the hashed set, so the chain holds, but it is a post-hoc soft-hide).
→ *For MFRS:* ship the DB-level immutability trigger to make the ledger tamper-**proof**, not just
tamper-evident.

### MFRS 15 Revenue recognition — 🟡 partial
**Have:** the primary flow ties revenue to the performance obligation — when a DO reaches
*delivered*, the invoice auto-creates as `SENT` and posts DR debtor / CR sales (split by product
category) / CR tax **in the same batch, on delivery** (`delivery-orders.ts:1048-1163`), not at SO
or draft. Manual invoices recognise on the DRAFT→SENT transition; cancellation reverses
(`invoices.ts:1911-2046`). Correct for point-in-time furniture sales.
**Gaps:** (1) **no deposit / advance / contract-liability** account — a customer prepayment would
land in cash/AR with no unearned-revenue liability (a real MFRS 15 gap *if* deposits are taken).
(2) A manually created invoice with `status:"SENT"` at POST does **not** post GL (only the PUT
transition does) — a known back-door where revenue can exist without a GL entry (NAV-MAP:236).
(3) No performance-obligation model for over-time or multi-PO contracts (fine for now).
→ *For MFRS:* add a contract-liability (deposits) account + close the create-as-SENT posting gap.

### MFRS 102 Inventory valuation — 🟡 partial
**Have:** a FIFO cost engine (`material-cost-fifo.ts`), a periodic-inventory model (COGS via
month-end closing/opening-stock legs, `accounting.ts:5435-5455`), a stock-take-only valuation mode,
opening-stock seeding, and an append-only `cost_ledger`.
**Gap:** **no lower-of-cost-and-NRV** anywhere (repo-wide grep for NRV/write-down/obsolescence = 0)
— inventory is always carried at cost, a direct MFRS 102 §9 non-conformance. No slow-moving /
obsolescence provision for RM/WIP/FG. Cost basis is mixed by mode; the stock-take-only mode can
misstate interim-month COGS between counts.
→ *For MFRS:* an NRV write-down mechanism (+ reversal) and an obsolescence/slow-moving provision.

### MFRS 101 Presentation of financial statements — 🟢 available / 🟡 conformant
**Have — all four primary statements, GL-sourced:** Trial Balance (`/trial-balance`,
`accounting.ts:4560`); P&L (`/pl` GL-truth `:7605` + rich `/pl-statement`, `/pl-monthly`,
`/pl-trend`); Balance Sheet (assembled inside `/pl`, `:7891-7963`, with retained-earnings
balancing line); Cash Flow (`/cashflow-statement` `:7503` via `cashflow-engine.ts`).
**Gaps:** the Cash Flow uses **bespoke sections** (REVENUE_COLLECTION, RAW_MATERIALS, DIRECT_LABOUR,
CAPEX, LOAN…) — a direct-method operational statement, **not the MFRS 107 Operating/Investing/
Financing classification** and no reconciliation to profit. **No Statement of Changes in Equity**
(MFRS 101 requires it) — only a single retained-earnings line in the BS. No notes / accounting-
policy disclosures / comparative-period framework.
→ *For MFRS:* re-map the cash-flow sections to the three MFRS 107 activities + add a Statement of
Changes in Equity. (Notes/comparatives are typically prepared at year-end by the accountant.)

### MFRS 9 Receivables impairment — 🔴 gap
**Have:** AR aging in month buckets (`accounting.ts:410`), AR control + reconciliation.
**Gap:** **no Expected Credit Loss / doubtful-debt provision / impairment** (grep for impair/ECL/
doubtful/allowance/write-off = 0). Receivables are carried gross; no allowance-for-doubtful-debts
contra account, no impairment expense, no loss-rate matrix.
→ *For MFRS:* an ECL provision matrix (loss % by aging bucket) posting to an allowance account +
impairment expense.

### MFRS 112 Income taxes — 🔴 gap
**Have:** nothing (grep for income/deferred/corporate tax = 0). The only payroll "tax" is PCB
(employee withholding), not corporate tax.
**Gap:** no current-tax provision, no tax-expense posting, no deferred tax (the fixed-asset book
depreciation vs tax capital-allowance timing difference is a classic deferred-tax trigger left
unhandled).
→ *For MFRS:* a year-end current-tax provision entry (accountant-driven) + a deferred-tax schedule
if the numbers warrant it.

### Sales tax (SST) — 🟡 partial
**Have:** output tax posts to a real liability account **350-0000 "GST PAYABLES"**
(`invoices.ts:206-218`, `note-ledger.ts:42`); input tax to **706-0000** (`other-party-bill.ts:28`).
Rate is operator-set once via kv `gst_rate_pct` and stored per document.
**Gap:** single global rate — no per-line tax code (standard/zero-rated/exempt/out-of-scope), no
SST-02 return generation, no tax-period lock, and 350-0000 vs 706-0000 are never netted into a net
payable-to-Customs.
→ *For MFRS/statutory:* tax-code classification per line + an SST return + output-vs-input
settlement. (SST is Customs law rather than MFRS, but it rides the same posting layer.)

### MFRS 119 Employee benefits — 🟡 partial
**Have:** payslips compute the full statutory split incl. employer EPF/SOCSO/EIS + PCB
— in **`src/api/routes/payslips.ts`** (`calcStatutory`, `:295`; PCB via `resolvePcb`,
`src/lib/pcb.ts:352`). *(This cited `payroll.ts:41-47`, which is a `PayrollRow` **type
declaration**, not a computation: `POST /api/payroll` returns **501** unconditionally
(`payroll.ts:125-139`) and that route computes no pay at all — corrected 2026-08-14.)* Month-end **Labour** run posts to the GL — DR each dept labour account /
CR **410-0010 "ACCRUAL - SALARY"** (`accounting.ts:9138-9194`), idempotent per month, later cleared
against the bank on payment.
**Gaps:** `payroll.ts` itself posts **no GL legs** — recognition depends on a **separate, manual,
skippable** month-end Labour run. Employer EPF/SOCSO/EIS is **lumped** into the one salary accrual;
there are **no separate statutory-payable liabilities** (EPF payable / SOCSO payable / EIS payable /
PCB payable), and employee-side deductions aren't posted as liabilities. No leave/bonus/gratuity
accrual.
→ *For MFRS:* split the accrual into wages + separate statutory payables, and make payroll posting
automatic (not a skippable manual step).

### MFRS 116 PPE / depreciation — 🟢 strong
**Have:** a full `fixed_assets` + `fixed_asset_depreciation` register with straight-line
depreciation over `usefulLifeMonths`, `openingAccumSen` for pre-system depreciation, CRUD +
account-type validation, and a monthly run that posts DR depreciation expense / CR accumulated
depreciation, idempotent per month (`accounting.ts:9691-9990`). Balance sheet nets fixed assets.
**Gaps:** disposal gain/loss is a **manual JV** (dispose just stops depreciation); straight-line
only (no reducing-balance / units-of-production); no revaluation model; **no MFRS 136 impairment
test**; no capital-allowance/tax schedule (feeds the MFRS 112 gap).
→ *For MFRS:* automate the disposal derecognition entry; add impairment testing if asset values warrant.

### MFRS 137 Provisions / warranty — 🔴 gap
**Have:** general-purpose expense accruals (410-x) can hold known liabilities; the repair/service
capability exists (`service-cases.ts`).
**Gap:** **no warranty provision of any kind** (grep for warranty = one sidebar comment). Service
cases have no warranty/coverage/expiry fields; repairs are handled reactively (priced RM 0) with no
accrued liability for expected future warranty cost. No onerous-contract/legal provisions.
→ *For MFRS:* a warranty provision (estimate based on historical repair rate × sales) if warranty
obligations are material.

### MFRS 121 Foreign currency — 🟡 partial
**Have:** multi-currency on the **purchase/AP side** — PIs carry `currency` + `fx_rate`
(`supplier-payments.ts:110-227`); realised FX on settlement posts to **530-0000 "GAIN ON FOREIGN
EXCHANGE"** (`supplier-payments.ts:9-40`).
**Gaps:** the **AR/sales side is MYR-only** (no currency on invoices/customers). **Realised FX only**
— no period-end retranslation of open foreign monetary items (open foreign PIs stay at historic
rate). Single FX account, no realised/unrealised split.
→ *For MFRS:* period-end retranslation of open foreign balances (+ AR-side currency if you ever
bill in foreign currency).

---

## Suggested build order (owner decides — nothing built yet)

The gaps split cleanly into **"affects the reported numbers"** (do first, with the accountant) and
**"presentation/format"** (do when pursuing an audit).

**P1 — affects the numbers (reuse existing posting/void paths; dry-run + reconcile first):**
1. **Inventory NRV write-down + obsolescence provision** (MFRS 102) — the most likely to change
   the reported profit.
2. **Receivables ECL provision** (MFRS 9) — a loss-% matrix over the aging buckets that already exist.
3. **Payroll → GL automation + statutory-payable split** (MFRS 119) — remove the skippable manual step.
4. **Close the create-as-SENT revenue-posting gap** + a **deposit / contract-liability** account (MFRS 15).

**P2 — statutory / audit-readiness:**
5. **Income-tax provision** entry (MFRS 112) — year-end, accountant-driven; deferred tax only if warranted.
6. **DB-level ledger immutability trigger** — make the hash-chained GL tamper-**proof**.
7. **Cash-flow re-classification to MFRS 107** (Operating/Investing/Financing) + **Statement of Changes in Equity** (MFRS 101).

**P3 — as the business needs it:**
8. **SST tax-code classification + SST-02 return** (statutory, not strictly MFRS).
9. **Warranty provision** (MFRS 137) if warranty cost is material.
10. **Period-end FX retranslation** + AR-side currency (MFRS 121) — only if foreign-currency volume grows.

**Strong recommendation:** the P1 items change reported figures, so scope them **with your
accountant / auditor** (they set the provision rates and policies) — the ERP builds the mechanism,
the accountant sets the numbers. That keeps the "software provides the system, the professional
provides the judgement" line clean, exactly as with ISO.

Related: [ISO-9001-GAP-ANALYSIS.md](ISO-9001-GAP-ANALYSIS.md) (quality side).
