# ERP Feature Gap Analysis

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against HEAD `145af0b9`, by reading route handlers, libs,
> migrations, workflows and `wrangler.toml` directly. Every "exists" and "does not exist"
> claim below carries a `file:line`. Route inventory taken from the generated
> [`API.md`](API.md) (139 mounts, 136 route files, 935 handlers), not counted by hand.
>
> **There was no production database session for this analysis.** Nothing below is a
> measured production fact unless it is explicitly attributed — either to the owner, or to
> an in-repo comment where a previous author recorded a measurement with its date. Claims
> about production row counts that could not be sourced that way are marked *unverified*.

**Question this answers:** what does a mature manufacturing ERP have that this one does not?

---

## How to read this

Three existing docs already do part of this job and are **not** repeated here:

| Doc | Covers | Status |
|---|---|---|
| [`MFRS-GAP-ANALYSIS.md`](MFRS-GAP-ANALYSIS.md) | accounting conformance to Malaysian financial reporting standards | verified 2026-08-13, still accurate |
| [`ISO-9001-GAP-ANALYSIS.md`](ISO-9001-GAP-ANALYSIS.md) | the quality-management spine (NCR, CAPA, document control, calibration, training) | verified 2026-08-13, still accurate |
| [`ROADMAP-PHASE-C.md`](ROADMAP-PHASE-C.md) | the owner's own enterprise-upgrade intent | **a record of intent, not a plan in flight** |

This document covers what those three do not: manufacturing, supply chain, sales/CRM,
cross-cutting operations, and — most importantly — the places where a feature looks present
but is a shell. Where a finding overlaps one of the above, it is cross-referenced rather
than restated.

**One structural warning first.** `docs/ENTERPRISE-ERP-ARCHITECTURE.md` is a *target-state
blueprint*, not a description of this system, and says so in its own header. Do not cite it
as evidence that a component exists — none of its reference stack (Redis, Kafka,
OpenSearch, BFF, read replica) is in this codebase.

---

## §1 — What exists, and how deep it goes

The honest headline: **this is a genuinely capable ERP for its size.** 511,289 lines of
TypeScript/TSX across 805 files, 139 API mounts over 136 route files, 243 Postgres
migrations, 383 test files. The transactional spine — order → production → receipt →
delivery → invoice → payment → GL — is real, posts real double-entry, and handles the
awkward cases (multi-PO receipts, partial invoicing, compensating reversals) with more care
than most mid-market installs.

### 1.1 Genuinely strong

**The general ledger.** Real double-entry in `ledger_journal_entries`, one row per leg,
Σdebit = Σcredit enforced at build (`src/api/lib/journal-hash.ts:162`, `:262`). A SHA-256
**hash chain** over the prior hash + leg fields (`journal-hash.ts:58-74`), a per-org chain
head (`:92-106`), and a Postgres advisory lock as the first statement of every posting batch
so two concurrent writers cannot fork the chain (`:204-206`). Idempotency is a real
`UNIQUE(orgId, sourceType, sourceId, legNo)` index
(`migrations-postgres/0117_ledger_idempotency.sql`). Reversal-not-delete throughout.
*(Two caveats in §3.)*

**Financial statements, all four, GL-sourced.** Trial balance with a real
`balanced: totalDr === totalCr` check (`src/api/routes/accounting.ts:4792-4858`); P&L
(`:7578`, `:7645`, `:7840`); balance sheet — built **inside `GET /pl` at `:8126-8155`**, not
at a `/balance-sheet` route, with un-closed earnings injected cumulatively as a synthetic
`NP-CURRENT` equity line (`:8156-8179`) so the sheet actually balances; cash flow (`:7826`).
Fiscal-year-end aware via `src/api/lib/fiscal.ts:20-65`.

**Fixed assets with real depreciation posting.** Register + straight-line over
`usefulLifeMonths`, opening accumulated depreciation for pre-system assets, and a monthly
run that posts DR expense / CR accumulated depreciation **in the same batch** as the
depreciation rows, idempotent per asset per month via `UNIQUE (asset_id, month)`
(`accounting.ts:11256-11337`, `migrations-postgres/0161_fixed_assets.sql:38`).

**Bank reconciliation with real matching.** Automatch requires exact signed amount equality
within ±7 days and commits **only when exactly one candidate matches**
(`accounting.ts:11615-11633`) — deliberately conservative. Manual match enforces same
account after alias resolution and exact amount (`:11515-11530`).

**Landed cost that actually revalues inventory.** `POST /api/accounting/landed-cost`
(`accounting.ts:10827`) updates `rm_batches.unitCostSen` and writes a `cost_ledger`
ADJUSTMENT per batch, allocating by batch value with largest-remainder rounding so
allocations sum exactly (`:10764-10791`). It refuses when a batch has been partly issued
(`:10843-10854`). A real costing feature, not a report.

**Realised FX on the purchase side.** PIs carry `currency` + `fx_rate`, immutable after
booking (`src/api/routes/purchase-invoices.ts:1117-1126`, `:1977-1988`); realised gain/loss
posts to `530-0000` on settlement (`:2358-2372`,
`src/api/routes/supplier-payments.ts:474-487`), with pure math unit-tested in
`tests/supplier-payment-alloc.test.mjs`.

**Purchasing that handles the real-world mess.** A goods receipt may span several purchase
orders, each line carrying its own `po_id`/`po_item_id`; the over-invoicing ceiling is
checked per PO rather than pooled; a supplier document naming `2607-003/2607-020` in one
field is split and matched per reference (`src/lib/po-ref-match.ts`,
`src/lib/po-line-allocate.ts`). Posted receipts are editable through a compensating cascade
with a **per-line** downstream lock rather than a document-level freeze. `CODEBASE-MAP.md:158-187`
carries the full ruleset — this area is unusually well reasoned and heavily tested.

**Production planning.** Not a throughput number — a genuine finite-capacity forward
scheduler with per-department, per-lane caps (`src/api/lib/planning-capacity.ts:100-116`),
inter-department handoff lead days, a CNC model carrying the system's only setup time
(`fabricChangeMin`, `:168-175`), a walk-in reserve (`:81-83`), a 3-day freeze window
(`src/api/routes/planning-schedule.ts:301`), planned overtime capped at 120 min/day
(`src/api/lib/planning-chain.ts:409`), and — the best part — **measured** capacity: a
trimmed mean of 15 working days of actual output with a ±20%/day drift limit
(`src/api/lib/planning-adaptive-capacity.ts:81`, `:106`, `:51`). Runtime-overridable via
`kv_config['planning_capacity']` (`planning-capacity.ts:405`).

**Observability.** App-wide server-timing middleware writing to Cloudflare Analytics Engine
with DB time separated from total time (`src/api/worker.ts:194`, `:318-324`,
`src/api/lib/observability.ts:50-53`), W3C traceparent propagation, 1% prod sampling that
**slow requests bypass entirely** so regressions cannot be sampled away (`:32-36`), real
front-end RUM ingestion (`src/api/routes/fe-rum.ts`), and 23 read endpoints over it
(`src/api/routes/admin-health.ts`).

**Grid export.** A WYSIWYG CSV/XLSX/PDF export built from the grid's *current visible
columns* over its *current filtered and sorted rows*, living in the shared DataGrid
(`src/components/ui/data-grid.tsx:2911-2968`) rather than reimplemented per page, with
currency exported as real numbers so Excel can SUM them (`src/lib/grid-export.ts:56-60`).

**Backups.** `.github/workflows/backup.yml` runs `pg_dump -Fc -Z 9` nightly, splits the
~400 MB dump into 40 MB parts, uploads to Supabase Storage with a manifest, verifies the
first part is > 1 KB, and calls a secret-gated prune endpoint. Recent commits `c435aacf`
and `382455d9` show it is actively maintained. *(Caveat in §3.4.)*

**GitHub Actions is the real scheduler.** `wrangler.toml` has **no** `[triggers] crons` —
every block is commented out (`:151-174`, `:200-208`). The 24 workflows in
`.github/workflows/` are what actually run on a schedule: daily reports at four fixed times
(`daily-reports.yml:21-24`), backup (`backup.yml:45`), auto-clockout, QC generation,
delivery agent, agent heartbeat, counter rebuilds. Anyone looking for cron in
`wrangler.toml` will wrongly conclude nothing is scheduled.

**The strict typecheck gate is clean.** `npx tsc -p tsconfig.app.json --noEmit` measured
**exit 0, zero errors** in this worktree on 2026-08-13.

### 1.2 Real, but shallower than the name suggests

| Capability | Depth actually built | Evidence |
|---|---|---|
| **MRP** | A persisted 4-bucket net-requirements **report** with MOQ-rounded suggestions and supplier lead times. Multi-level through the BOM tree, but emits no planned orders for sub-assemblies and **does not create purchase orders** — `/api/purchase-orders/from-mrp` exists only in a comment | `src/api/routes/mrp.ts:536`, `:696-748`, `:53` |
| **Routings** | Operations with run minutes exist per WIP node (`processes[]`), but the **sequence is a TypeScript constant**, not data — a product-specific routing cannot be defined without editing code. No setup-vs-run split | `src/api/lib/wip-times-core.ts:36`, `:132-149`; `src/api/lib/bom-wip-breakdown.ts:270-299` |
| **Rework** | A real WIP rework loop: a QC FAIL on a job card resets it to BLOCKED, zeroes `wipQty`/`actualMinutes` and clears the piece PICs so a re-scan cannot resurrect the old completion. A FAIL on an FG or RM batch writes tags and nothing else | `src/api/routes/qc-pending.ts:2267-2296` |
| **Supplier scorecards** | The **live** metrics are real and correct — on-time rate, average lead days, defect rate from POSTED GRNs, computed from `purchase_orders`/`grns`. The *stored-table* variant is a shell (§2.2 ④) | `src/api/routes/supplier-scorecards.ts:94`, `:182`, `:271-293` |
| **Reorder point** | `raw_materials.minStock`/`maxStock` are real and drive a prefilled reorder PO — but the logic is **entirely client-side**, there is no alert, and finished goods have no reorder level at all | `src/pages/procurement/index.tsx:1497-1553`; `src/api/routes/raw-materials.ts:282-283` |
| **Shortage forecast** | Solid, and distinct from MRP: walks confirmed SOs through the BOM, subtracts on-hand, and **adds incoming PO quantity** due within 14 days | `src/api/routes/inventory.ts:294`, `:339-349` |
| **Customer returns** | Deep on the inventory side — FIFO COGS reversal, idempotent `cost_ledger` ADJUSTMENT, `fg_units` → RETURNED, paired stock events, restock and repair mutually exclusive | `src/api/routes/delivery-returns.ts:280-334`, `:357-362` |
| **Credit control** | Three genuine 409 `CREDIT_LIMIT_EXCEEDED` gates — single DO create, bulk packing-list-first create, and consignment-note→invoice convert. `outstandingSen` is properly maintained across invoice create/edit/cancel | `src/api/routes/delivery-orders/_helpers.ts:2568-2632`; `delivery-orders.ts:2312-2340`; `consignment-notes.ts:1498-1537` |
| **Intercompany** | A PO whose supplier is a flagged sister company creates a mirror DRAFT sales order under that sister, idempotent via `intercompany_mirror_log` with `UNIQUE(source_type, source_id)`, non-blocking, no back-door customer creation | `src/api/lib/intercompany-mirror-create.ts:222-376`; `src/api/routes/purchase-orders.ts:606-659` |
| **Budget** | Not a budget module: one `kv_config` row (`forecast_pnl`) holding projected sales per month and each P&L line as basis points of sales. It **is** genuinely compared against actuals on the finance dashboard. No budget table exists — the only match for `budget` in `accounting.ts` is a comment about a row limit (`:10993`) | `accounting.ts:10663`, `:10688-10704`, `:10593-10605`; `src/pages/finance-dashboard.tsx:280-357` |
| **Audit trail** | The write helper is excellent — full before/after JSON in the **same batch** as the mutation, with actor name snapshotted so it survives user deletion. Coverage is the problem (§3, second tier) | `src/api/lib/audit.ts:87`, `:112-135` |
| **RBAC** | ~75 resources, 5 code-defined roles + 7 DB-resolved, `NEVER_WILDCARD` on `users` so a broad role cannot promote its own holder. Row-level scoping exists for SALES only; field-level exists at exactly two call sites | `src/api/lib/role-policy.ts:76-136`, `:354-360`; `src/api/lib/customer-scope.ts:33`; `src/api/lib/rbac.ts:264-283` |
| **Multi-company** | "Company" (HOOKKA / OHANA / HOUZS / HKMFG) is a **display and filter dimension** on documents (`sales_org_code`, `purchase_org_code`), explicitly independent of the tenant-isolation `orgId`. The registry carries regNo/TIN/MSIC and a transfer-pricing % | `src/lib/company-dimension.ts:1-20`; `src/api/routes/organisations.ts:26-50` |
| **Leave** | **CORRECTED 2026-08-14** — no longer "no entitlement of any kind". A request record **plus** per-worker entitlement (`workers.annual_leave_entitlement_days` / `.medical_leave_entitlement_days`, NULL → statutory default), a calendar leave-year boundary, public-holiday exclusion and computed balances, all in ONE shared module used by both the office and the phone. Still absent: monthly **accrual** and **carry-forward**. | `src/lib/leave-entitlement.ts`; `GET /api/leaves/balances` (`src/api/routes/leaves.ts:106-160`) |

### 1.3 Where the code actually lives

Facts worth knowing before reading anything, because several of them will send a reader to
the wrong file.

**Scale, measured 2026-08-13.** 805 `.ts`/`.tsx` files, 511,289 lines: 152,564 in
`src/api/routes`, 205,559 in `src/pages`. **28 files exceed 3,000 lines, 14 exceed 5,000,
3 exceed 10,000.**

| File | Lines |
|---|---|
| `src/api/routes/accounting.ts` | 13,054 |
| `src/pages/employees.tsx` | 11,746 |
| `src/pages/accounting/index.tsx` | 11,147 |
| `src/pages/production/index.tsx` | 9,645 |
| `src/lib/mock-data.ts` | 7,831 |
| `src/pages/delivery/index.tsx` | 7,479 |
| `src/api/lib/assistant-tools.ts` | 6,826 |
| `src/pages/bom.tsx` | 6,616 |

These are single components, not directories of parts: `EmployeesPage` is one 9-tab shell
whose default export sits at `src/pages/employees.tsx:11424`, near end-of-file, with the tab
bodies above it. `accounting.ts` holds ~120 handlers spanning aging, COA, journals, AR/AP
control, fixed assets, bank reco, landed cost, year-close, opening balances, trade finance
and the P&L/BS/cash-flow engines in one module.

**Three route files were split without the docs following.** `CODEBASE-MAP.md:14-23`
records the correction: `delivery-orders.ts` is 3,010 lines with helpers in
`delivery-orders/_helpers.ts` (5,254); `production-orders.ts` is 3,903 with
`production-orders/_helpers.ts` (5,799); `sales-orders.ts` has
`sales-orders/_helpers.ts` (1,452). **If a function is not in the handler file, look in the
sibling `_helpers.ts` before concluding it was deleted.**

**Two files named almost identically, one of them dead.** The real production-order builder
used by the API is `src/api/routes/_shared/production-builder.ts` (42 KB).
`src/lib/production-order-builder.ts` (12 KB) is the mock-data-era one and is imported by
exactly one thing — `src/lib/mock-data.ts:7689`. Compounding it,
`tests/production-order-builder.test.mjs:5` states *"There is no file literally named
`production-order-builder.ts`"* — which is false; that file exists.

**One router, two mount prefixes.** `production-leadtimes.ts` is mounted at both
`/api/production-leadtimes` and `/api/production/leadtimes` with an identical path set (see
the two adjacent rows in `API.md`).

**One business surface, three routers over two table pairs.** Consignment spans
`consignment-orders.ts` (CO), `consignment-notes.ts` (CN) and the legacy `consignments.ts`,
which reads the *same* `consignment_notes`/`consignment_items` as the CN router; a change to
one usually belongs in all three (`CODEBASE-MAP.md:105`).

**`mock-data.ts` is not only mock data — it is still a type module.** Its own header
(`:1-9`) says types are canonically in `@/types/index.ts` and that it re-exports them "for
backward compatibility". Six PDF generators still `import type` from it —
`generate-so-pdf.ts:6`, `generate-do-pdf.ts:3`, `generate-co-pdf.ts:5`,
`generate-packing-pdf.ts:3`, `generate-purchase-order-pdf.ts:3`. So the 7,831-line mock file
cannot simply be deleted, and it stays in the dependency graph of live code. Its header also
still reads *"Simulates database until PostgreSQL is connected"* — Postgres has been
connected since 2026-04.

**Documentation is genuinely current, and unusually so.** 49 of 53 docs in `docs/` and
**15 of 15** module guides carry a `Last verified: <date> against <what>` stamp.
`docs/API.md` is generated (`node scripts/gen-api-docs.mjs`; `--check` reports staleness),
which is why it is used as the route inventory here — its hand-maintained predecessor
`SYMBOLS.md` had drifted to 25% accuracy with 94 of 891 offsets pointing past end-of-file,
and was deleted for that reason.

**There is no local database.** `npm run dev` starts Vite only, and `vite.config.ts:221`
proxies `/api` to port 3001 where **nothing listens** — the standalone Node API server was
removed at the Cloudflare Pages move (`docs/SETUP.md`, verified 2026-08-13). Anything
touching the API needs `npm run dev:worker` plus a `.dev.vars` `DATABASE_URL` pointing at a
real Supabase Postgres. UI-only work needs no credentials; everything else needs a database
handed to it.

**What gates a change.** `npm run build:strict` = `typecheck:app && build`; `npm test` runs
`tests/*.test.mjs` under Node's test runner. Of the 383 test files, **219 use
`readFileSync`** — they assert on *source text* (that a guard exists, that a handler stays
inside a size window) rather than executing routes against a database. That is a deliberate
and effective pattern for pinning regressions in a Workers codebase with no local DB, but it
means "tested" frequently means "the code still contains this line", not "this endpoint
behaves correctly".

---

## §2 — Scaffolding masquerading as a feature

**The highest-value section.** A shell that looks present is worse than a known absence,
because it gets trusted.

### 2.1 The two known fakes — both now remediated, and worth knowing about

Both were fixed on `main` under a sweep tagged **`BUG-2026-08-13-014`**. Anyone citing them
as live behaviour is out of date; they remain the calibration examples for everything else
in this section.

- **LHDN e-invoice submit** minted a fake government clearance:
  `` submissionId = `LHDN-SUB-${yyyymmdd}-${Math.floor(Math.random()*999)}` `` plus a random
  UUID, then set `status='VALID'`, rendering a green **VALID** badge carrying a fabricated
  clearance number. It now returns **501** with an explanation
  (`src/api/routes/e-invoices.ts:303-316`; the removed code is quoted verbatim in the comment
  at `:275-303`). **There is still no LHDN/MyInvois client anywhere in the repo.**
  *(Owner-supplied production fact: 0 e-invoices in production. Not independently verified —
  no DB session.)*
- **`POST /api/payroll`** invented overtime with three `Math.random()` dice rolls and flat
  SOCSO/EIS constants, reading no attendance table. It now returns **501**
  (`src/api/routes/payroll.ts:125-140`; removed code quoted at `:99-101`). The real engine is
  `POST /api/payslips` → `computeMonthlyLabor` (`src/lib/labor-engine.ts`).
  *(Owner-supplied production fact: 0 rows in the payroll table, 138 in payslips. Not
  independently verified.)*

**Two residues survive both fixes:**

1. `GET`/`PUT /api/payroll` still read and write `payroll_records`
   (`payroll.ts:78-91`, `:145-203`), and the AI assistant's `get_payroll` tool reads that
   table directly (`src/api/lib/assistant-tools.ts:4057-4079`). Any row the old generator
   wrote would still be answerable as "what did this worker earn". The owner's count of 0
   rows makes this harmless today; it stays a trap if a row ever appears.
2. `src/lib/mock-data.ts:4451-4695` still holds 12 seed rows carrying hardcoded
   `LHDN-SUB-…` identifiers (e.g. `:4472`). Whether seed data ever reached production is
   *unverified*.

Note also the still-open **latent bug** in the surviving e-invoice code path:
`e-invoices.ts:175-177` hardcodes `const taxAmount = 0;` and sets
`totalExcludingTax = totalIncludingTax`, never reading `invoices.taxSen`, which the invoice
does store (`invoices.ts:1728`, `:1767`). Harmless while the SST rate is 0; wrong on every
document the day it is not.

### 2.2 Live shells, ranked by how likely they are to be believed

**① Consignment Returns page — ✅ FIXED 2026-08-13 (BUG-2026-08-13-071), re-read 2026-08-14.**
`buildMockCRs` is GONE. The page now reads `/api/consignments` via `useCachedJson`, the invented
four-stage PENDING→INSPECTED→ACCEPTED→RESTOCKED pipeline was deleted rather than stubbed, and
where it cannot source a figure it renders `—` with a "Value Basis" column publishing how many
lines carried a price. No `Math.random()` survives outside the explanatory header. **The claim
below that this is "the only place in the system still rendering random business figures" is
therefore no longer true of this page.** Original finding kept for the record:

**① (as originally written) Consignment Returns page — random business numbers, rendered and exportable.**
`src/pages/consignment/return.tsx` is routed (`src/dashboard-routes.tsx:545`) and in the
sidebar (`src/components/layout/sidebar.tsx:98`). Everything on it is fabricated client-side
by `buildMockCRs` (`:52`; the comment at `:47` reads "Mock CR data generator"):

- return dates are `Math.random() * 10` days ago (`:61`);
- workflow status is a dice roll — `if (rand > 0.75) "RESTOCKED"; else if (rand > 0.5) "ACCEPTED"; …` (`:62-66`);
- CR numbers come from a module counter (`:70`);
- "Accept Return" and "Restock Items" only call `setCrRows` — React state; a refresh re-rolls everything (`:344-366`);
- the KPI cards ("Pending", "Restocked MTD") count dice rolls (`:238-250`);
- `handleExportCSV` (`:253-273`) exports the fabricated rows **including RM values** to a file that looks like a report.

A real returns API exists (`src/api/routes/delivery-returns.ts`) and this page does not use
it. **This is the only place in the system still rendering random business figures, and it
is the direct analogue of the two fakes in §2.1 — same failure mode, still live.**

**② Notifications — a bell over a table nothing writes.**
`src/api/routes/notifications.ts` has only `GET /` (`:71`) and `PUT /` mark-as-read (`:101`)
— **no POST**, and no `INSERT INTO notifications` anywhere in `src/`. The only inserts are
demo rows in `scripts/seed.sql:4295-4312`, one of which reads *"Daily system backup completed
successfully — all data secured"* (`:4302`) — a fake reassurance about backups. Whether that
seed reached production is *unverified*; either way there is **no notification engine**.

**③ `scheduling.ts GET /capacity` — a second, disagreeing capacity model.** Mounted at
`src/api/worker.ts:1381`, it computes `workerCount × hoursPerDay × 60 × 0.85` with a
hardcoded efficiency constant (`src/api/routes/scheduling.ts:287`, `:328-330`). Its own
comment at `:283-286` says nothing consumes it, and the planning page confirms
(`src/pages/planning/index.tsx:516-520`). The real engine is `src/api/lib/planning-*.ts` —
see §1.1.

**④ The `supplier_scorecards` table has no writer.** `supplier_scorecards` across `src/`
returns only SELECTs (`src/api/routes/supplier-scorecards.ts:54`, `:64`, `:203`) — no
INSERT, no UPDATE, no cron, despite the "refreshed on a cron" comment at `:76`.
Consequences: `GET /api/supplier-scorecards` (the list) reads an unwritten table,
`overallRating` always falls back to `0` (`:319`), and the **entire scorecard block on the
supplier price-comparison card is dead UI** (`src/pages/procurement/maintenance.tsx:210-232`,
fetched at `:888`) — `qualityRate`, `leadTimeAccuracy` and `avgPriceTrend` have no derivation
anywhere in the repo. The *live-computed* endpoints (`/summary`, `/:supplierId`) are real.
One feature, one real half and one fake half, behind one name.

**⑤ Efficiency percentages are 100% by construction.**
`src/api/routes/production-orders.ts:412-438` records that every non-zero `actualMinutes`
value on production is byte-identical to that card's own `estMinutes` — the column was
populated by copying the estimate (`src/api/routes/import-completion/_shared.ts:468`).
`src/pages/reports.tsx:781-789` now correctly prints `—` instead of a ratio, but the *data
collection* is not working, and the assistant's `analyze_po_delay` variance
(`src/api/lib/assistant-tools.ts:3264-3266`) is structurally always zero.

**⑥ `POST /api/admin/archive/run` is hard-disabled.** Returns **410** for any non-dry-run
(`src/api/routes/admin.ts:169-179`), per an owner decision recorded at `:163-168`: read and
write paths only see the hot tables, so archiving makes rows invisible and lets writes
silently no-op — and there is no unarchive endpoint. The execution body (`:209-353`) is dead
code. The `sales_orders_archive` tables therefore imply a working archive that does not run.

**⑦ Demand forecasting is a table with no math and no consumer.**
`src/api/routes/forecasts.ts:8-14` says so itself; `actualQty` is hardcoded NULL on insert
(`:129`) so no forecast can ever be scored; `method` (`SMA_3|SMA_6|WMA`) is a label with no
math behind it. `src/api/routes/mrp.ts` contains **zero** matches for `forecast`. The UI is
honest — `src/pages/analytics/forecast.tsx:116-131` renders a banner saying nothing writes
the table.

**⑧ `price_histories.approvalStatus` is called an approval workflow and is not one.**
Written defaulting to `"PENDING"` (`src/api/routes/price-history.ts:31`, `:137-141`), but the
router has **no PUT/PATCH** — only `GET /` (`:56`) and `POST /` (`:100`). Nothing transitions
it, nothing gates on it, and the binding price updates immediately regardless. Its only
consumer is a display badge (`src/pages/suppliers/detail.tsx:1001-1002`). `ISO-9001-GAP-ANALYSIS.md`
§7.5 cites this as "a real approval workflow exists but only for supplier prices" — that
citation is too generous.

**⑨ `approval_requests` — a designed table, never wired.**
`migrations-postgres/0001_init.sql:1207-1223` defines it with
`type IN ('PRICE_OVERRIDE','DISCOUNT','PO_APPROVAL','LEAVE_REQUEST','STOCK_ADJUSTMENT','CREDIT_OVERRIDE','SO_CANCELLATION')`,
`requested_by`, `approved_by`, `amount_sen`. **Nothing in `src/` reads or writes it.**
Likewise `purchase_invoices.status` permits `'PENDING_APPROVAL'`
(`migrations-postgres/0057_purchase_invoices.sql:30-31`) — a state no route sets and no
approver clears.

**⑩ `maintenance_logs.downtimeHours` is write-only.** Written at
`src/api/routes/equipment.ts:263-275` and `maintenance-logs.ts:94-106`; the only readers are
a simple average and a display (`src/pages/maintenance.tsx:128`, `:856`). No OEE, no
availability, no feed into capacity.

### 2.3 Dead code and misleading artefacts

- **`src/api/lib/job-card-persistence.ts`** (304 lines) — `import fs from "node:fs"` at
  `:1`, the only `node:fs` import in `src/api`, in a codebase targeting Cloudflare Workers
  where it cannot run. It mutates runtime mock arrays (`:3`, `:129-265`) and writes JSON to
  `.data/`. Nothing imports it; the only reference is a TODO comment at
  `src/api/routes/production-orders.ts:18` that points a reader straight at it.
- **`src/lib/scheduling.ts`** — "Backward Scheduling Engine", imports `deptLeadTimes` from
  `mock-data` (`:7`). **Zero importers.** Anyone searching for a scheduling engine lands here
  before the real `src/api/lib/planning-*.ts`.
- **`src/lib/material-lookup.ts`** — zero importers; referenced only in comments.
- **148 stale `D1` references across 81 route files**, most of them the file's own opening
  line: `accounting.ts:2` "D1-backed accounting route", `auth.ts:2`, `bom.ts:2`,
  `attendance.ts:3`, `leaves.ts:2` and so on. **The D1 binding was retired 2026-04-27**
  (`wrangler.toml:33-40`; commit `7059259`) and every route now runs on Supabase Postgres
  through a compatibility adapter. `package.json` handles this correctly — the legacy D1
  scripts were renamed `_LEGACY_db:migrate:local` etc. and now echo an explanation — but the
  route headers were never updated, so the most prominent comment in most route files
  describes a database that is gone.
- **47 `POST /backfill-*` one-off repair endpoints are permanently mounted** across
  `src/api/routes` — 8 on `delivery-orders.ts` alone (`:751`, `:849`, `:995`, `:1122`,
  `:1354`, `:1718`, `:1822`), 4 on `invoices.ts` (`:733`, `:859`, `:867`, `:1010`), 8 on
  `admin.ts`. Each was written to repair a specific historical data problem and left in
  place. They are permission-gated, but they are live mutation endpoints whose safety depends
  on data conditions that were true once.

### 2.4 Configuration present but not switched on

All in `wrangler.toml`, and all fail-closed (503) rather than silently wrong:

| Thing | State | Line |
|---|---|---|
| PO emission queue bindings | commented out; producer falls back to inline notify | `:151-174` |
| Google Sheets sync secrets | commented out; routes 503 | `:309-323` |
| Google OAuth vars | commented out; `/api/auth/oauth/google/start` 503s | `:303-307` |
| Dashboard materialized-view refresh | **no scheduler exists** — the comment says so: "WHAT'S MISSING: something actually hitting that endpoint on a schedule" | `:124-149` |

The MV one is a live staleness bug rather than scaffolding — though note that
`migrations-postgres/0123_drop_dashboard_mvs.sql` dropped an earlier MV set, so scope it
before acting.

### 2.5 Correcting the record — things that are *not* dead

Stated because each is easy to mistake for a shell:

- **`src/api/routes/import-completion.ts`** is not dead. `API.md`'s static scan finds no
  routes in it because `:56-64` is an aggregator that `app.route("/", …)`s eight sub-routers;
  it is mounted at `src/api/worker.ts:1411`.
- **`src/api/routes/_fabric-cascade.ts`** is not dead. The `_` prefix means helper, not
  route; it is imported at `src/api/routes/raw-materials.ts:34`.
- **`admin-health.ts`'s mock fallback is honest by design** — flagged `_mock: true` /
  `_source: "mock"` with a UI banner, and it logs the fallback explicitly because a silent
  one cost a day of debugging on 2026-08-01 (`src/api/routes/admin-health.ts:479-488`).
- **No third-party integration is falsely claimed.** Real HTTP clients exist for Anthropic,
  Brevo/Resend email, Google Sheets, Google OAuth, Supabase Storage, Web Push and Cloudflare
  Analytics Engine. There is no WhatsApp, Twilio or payment-gateway client — and none is
  claimed anywhere.

---

## §3 — Ranked gaps

Ranked by **business impact × how painful it is today**. This is a make-to-order furniture
maker running four registered companies at roughly 1,300 orders/quarter — it does not need
everything an SAP install has, and several classic ERP gaps are correctly ranked low.

Each entry names the **partial implementation already in the tree**, because in almost every
case there is one.

### 3.1 No accounting period lock — a journal can be posted into a closed month or year

**Impact: very high. Effort: low.** The best ratio in this document.

`POST /api/accounting/journals` (`accounting.ts:1184`) validates exactly three things:
`date` is truthy, debits equal credits, and the total is non-zero (`:1190-1212`). **Any date
string is accepted.** `PUT /journals/:id` transitioning to POSTED (`:1314-1408`) validates
account existence and postability, and nothing about the date. The only date guards in the
whole finance surface are *upper* bounds — "not in the future" (`:5245`, `:11266`, `:5709`).

There is no lock anywhere: no `period_lock` / `closed_period` / `posting_lock` table or
column, no lock key among the sixteen `kv_config` keys `accounting.ts` reads, and
`POST /year-close` (`:5235-5364`) writes **no lock flag** — it posts a correct, idempotent
retained-earnings entry and locks nothing. (The only period lock in the repo is a *payroll*
one, `src/api/lib/attendance-deduct.ts:337`.)

**Why it bites harder than it looks:** every report dates a ledger leg by its *document*
date, not `postedAt` — `loadDocDateResolver` (`:11743-11788`) maps `sourceType 'manual'`
back to `journal_entries.date`, and the trial balance (`:4823`), P&L/BS (`:7913`) and GL
(`:4936`) all filter on it. A JV dated `2024-03-15` and posted today silently lands in March
2024's P&L and changes an already-reported year. `year-close` is idempotent per FY and will
*refuse* to re-close, so the amount never reaches retained earnings — it surfaces instead in
the "current year earnings (unclosed)" plug line (`:8161-8179`). Prior-period reports change
retroactively and nothing warns anyone.

**Build on:** the `kv_config` pattern already used for `opening_date` and `fye_month`, and
the existing opening-date read-side floor (`legBeforeOpening`/`rowBeforeOpening`, applied at
`:4824`, `:5170`, `:7913` and ~20 other read surfaces) — a closed-period floor is that same
shape applied on the write side.

### 3.2 LHDN MyInvois: the XML is built, nothing can transmit it

**Impact: statutory and deadline-driven. Effort: a project, not a fix.**

`POST /api/e-invoices` builds and stores real UBL XML (`e-invoices.ts:69-116`, `:180-215`).
Submission returns **501** (`:303-316`) and **there is no LHDN/MyInvois client anywhere in
the repo**. The UI is honest about it (`src/pages/invoices/e-invoice.tsx:254-273`). Owner's
production count: 0 e-invoices.

Two things must ship together: the real integration (credentials, TIN validation, digital
signature, the 72-hour rejection window) and the `taxAmount = 0` hardcode described in §2.1,
which becomes wrong on every document the day SST is switched on.

> **Assumption, not a code fact:** which MyInvois phase this business falls into is a matter
> for the accountant, not something checkable from source. The ranking assumes it is either
> already mandatory or imminent.

**Build on:** the UBL builder and `e_invoices` table are done; the company registry already
carries `tin` and `msic` per company (`organisations.ts:26-50`, `src/lib/constants.ts:11-12`).

**Adjacent, same layer:** there is **no SST return**. Output tax posts to `350-0000` and
input tax to `706-0000` (`invoices.ts:229-241`, `purchase-invoices.ts:206-221`), but the rate
is one global `kv_config` value with no per-line tax code, no exempt/zero-rated
classification, no SST-02/03 generation, and the two accounts are never netted. See
`MFRS-GAP-ANALYSIS.md` §"Sales tax (SST)".

### 3.3 Four registered companies, one set of books

**Impact: high and structural. Effort: high — scope with the accountant first.**

The business issues documents under separate legal entities with their own registration
numbers and TINs (`src/lib/constants.ts:5-38`, plus the dynamic `organisations` registry).
The general ledger does not know they exist:

- `ledger_journal_entries` carries `org_id` — the **tenant**, defaulting to `'hookka'`
  (`migrations-postgres/0051_journal_entries.sql:52`; `src/api/lib/tenant.ts:31`) — and no
  company/legal-entity column.
- `accounting.ts` (13,054 lines) contains **zero** references to `sales_org_code`,
  `purchase_org_code`, `OHANA`, `HOUZS` or `HKMFG`. `journal-hash.ts` has no company concept.
- `companyFilter` (`tenant.ts:200-214`) is a *report* dimension applied to seven finance
  reports, and its own header says it "is not the tenant-isolation boundary".
  **Terminology trap:** the code calls the unfiltered default "consolidated"
  (`accounting.ts:471`, `:484`, `:1676`, `:2475`, `:4797`) — meaning *sum of all rows*, not
  accounting consolidation.
- No intercompany control accounts (`due from`/`due to related company` return zero matches;
  the only "due to" accounts are director loans, `0115_chart_of_accounts_real.sql:87-88`),
  and no elimination — `eliminat*` returns zero matches across `src/api/routes`.
- Fixed assets and bank statement lines have **no `org_id` at all**
  (`0161_fixed_assets.sql:16-30`, `0160_bank_statement_lines.sql:12-22`), so those
  sub-ledgers cannot even be filtered by company.

**Build on:** the intercompany PO↔SO mirror already exists and is well built
(`src/api/lib/intercompany-mirror-create.ts`), the `organisations` registry already carries a
`transferPricingPct`, and the gap is acknowledged in-code as
`TODO(intercompany-pnl-elimination)` (`:28-31`), with the GRN mirror named as the next step
(`:34-36`).

### 3.4 Disaster recovery: backups run; a restore has never been drilled

**Impact: existential. Effort: one day of drill, plus one decision.**

The backup pipeline is real and actively maintained (§1.1). Three things are not:

1. **No restore has ever been performed.** `docs/DR-RUNBOOK.md:446-456` — the "Recorded
   RTO/RPO" table is entirely `_TBD_`.
2. **No off-vendor copy.** The dump lives in Supabase Storage, the same vendor as the primary
   Postgres. The runbook header (verified 2026-08-13) records that the claimed 90-day GitHub
   Actions artifact **does not exist** — `backup.yml` has zero `upload-artifact` steps — and
   calls this "the single largest open gap in this runbook".
3. **No rollback path for schema.** No workflow or script implements a deployment rollback;
   the one "Rollback" heading in the repo (`docs/CANARY-DEPLOY.md:145`) is about disabling
   the canary workflow. And because **migrations do not auto-apply on deploy** — a new column
   reaches production only through the runtime self-apply
   (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `src/api/lib/self-apply.ts`) — a Cloudflare
   Pages rollback reverts the code but leaves the column in place.

**Build on:** the runbook is written; it needs executing, timing, and one quarterly
off-vendor copy.

### 3.5 No approval workflow, and no segregation of duties on money

**Impact: high. Effort: medium.**

`/:id/lifecycle` endpoints are **not approval** —
`DocState = "ACTIVE" | "VOID" | "DELETED"` with actions `void | delete | unvoid`
(`src/lib/lifecycle-machine.ts:15-22`). The underlying void engine is well built (idempotent
GL reversal, `prevState` returned for boundary-aware side effects,
`src/api/lib/document-lifecycle.ts:36-133`); it is simply not an approval engine.

- **Nothing prevents one user creating and then voiding the same payment.** Both sit under
  the same resource (`payments:create`, `payments:update` — `src/api/routes/payments.ts:1251`),
  and FINANCE, ADMIN and SUPER_ADMIN all hold both. No maker-checker, no second signature.
- **No amount thresholds anywhere.** No PO, payment or discount value triggers a higher
  approver. The one amount-based gate in the system is the credit limit, and it is a hard 409
  with **no override path** — a director cannot approve past it
  (`consignment-notes.ts:1513-1536`).
- **No discount approval.** Per-line `discountSen` is accepted raw and unbounded on SO and CO
  create/edit — only `Math.max(0, …)` (`sales-orders.ts:2023-2024`, `:3562-3563`;
  `consignment-orders.ts:746`, `:2092`).
- One permission mismatch worth fixing in passing: voiding a *supplier* payment is gated on
  `invoices:update` (`supplier-payments.ts:1377`).

**Build on:** the abandoned `approval_requests` table (§2.2 ⑨) already has the right shape,
`purchase_invoices.status` already permits `PENDING_APPROVAL`, and `requireFinance`
(`rbac.ts:315-329`) is the pattern for a role-shaped gate.

### 3.6 Nothing tells anyone anything — there is no notification engine

**Impact: high, and the gap most likely to be felt daily. Effort: medium.**

The in-app bell reads a table with no producer (§2.2 ②). Web push exists but has exactly two
triggers — a clock reminder and a human posting an announcement (`src/api/routes/push.ts:237`,
`src/api/routes/announcements.ts:647`). Scheduled email reports are real
(`.github/workflows/daily-reports.yml:21-24`, `src/api/routes/reports.ts:879-914`).

But **there is no rule anywhere of the shape "X is N days late → notify role Y → escalate to
Z"**. No event bus, no subscription table, no per-role routing. "Overdue" is a *report*
emailed to a fixed recipient list at 17:00. Everything time-critical depends on somebody
looking at a screen.

**Build on:** the `notifications` table, read path, feed lib and bell UI are all built and
correctly org/user-scoped (`notifications.ts:35-39`) — what is missing is emitters.
`sendPushToSubscribers` is already exported for exactly this purpose (`push.ts:242`).

### 3.7 MRP systematically under-plans, and disagrees with the other shortage engine

**Impact: high — it drives purchasing. Effort: low for the three defects.**

Three verified defects in `src/api/routes/mrp.ts`:

1. **`const onOrder = 0;` is hardcoded** (`:701`). Open purchase orders are never netted off,
   so every already-covered material reports as a shortage. Meanwhile
   `GET /api/inventory/shortage-forecast` **does** add incoming PO quantity within 14 days
   (`inventory.ts:339-349`) — **two shortage engines that disagree by construction.**
2. **BOM `wastePct` is ignored.** It is real and applied at consumption
   (`src/api/lib/po-cost-cascade.ts:757-762`, `src/api/lib/fabric-usage.ts:118-126`) but the
   MRP explosion never reads it, so MRP plans less material than production will take.
3. **Component kits are not exploded.** `mrp.ts` never calls `explodeKits`
   (`src/api/lib/component-bom.ts:248-260`), so kit children — screws, fittings — that *are*
   consumed and costed are invisible to MRP.

Beyond the defects: MRP reads firm production orders only — no forecast, no MPS, no safety
stock, no reorder point — and emits no planned orders for sub-assemblies. `safety_stock`
returns zero matches across `src/api/routes` and `migrations-postgres`; min/max are
hand-entered constants, not derived from lead-time demand.

**Build on:** the explosion, MOQ rounding, supplier lead-time lookup and suggested-order-date
maths are all already there (`mrp.ts:696-748`) — these are three targeted fixes, not a
rewrite.

### 3.8 You cannot tell where production time or margin actually goes

**Impact: high for a make-to-order manufacturer. Effort: high — data capture, not just code.**

Three findings compound:

1. **No standard cost exists.** `standardCost|standard_cost|stdCost|targetCost` return
   **zero** hits across `src/api`. Costing is pure actual/FIFO, so there is no material price
   variance, no usage variance, no labour rate or efficiency variance to report.
2. **Shop-floor scans capture who, when and which piece — never a duration, never
   good-vs-bad.** The three scan handlers stamp `piece_pics.pic1Id/pic2Id + completedAt` and
   roll the card up (`src/api/routes/production-orders.ts:1910-1914`, `:2206-2220`,
   `:2282-2297`). `actualMinutes` is not in that UPDATE at all — which is why every
   efficiency ratio is 100% (§2.2 ⑤). No start/stop pair, no reject count, no reason code.
3. **Two labour numbers that are never reconciled.** `/api/accounting/labor/post`
   (`accounting.ts:9499`) posts to the GL from **payslips**, per department, idempotent per
   month (`:9517-9551`) — it never reads `job_cards` or `cost_ledger`. Separately,
   `postJobCardLabor` (`src/api/lib/po-cost-cascade.ts:953`) posts a management-costing
   `LABOR_POSTED` row using *standard* minutes × the worker's actual rate. Neither is checked
   against the other.

Also: **rework is free.** `postJobCardLabor` is idempotent on `cost_ledger` where
`refType='JOB_CARD' AND refId=jcId` (`po-cost-cascade.ts:966-974`), and the QC reset does not
delete that row — so a second pass through a department posts zero additional labour. And
there is **no scrap accounting**: no scrap quantity field, no GL scrap account
(`stock_adjustments` returns zero hits in `accounting.ts`), only a manual stock adjustment
with a `WRITE_OFF` reason (`src/api/routes/stock-adjustments.ts:76-83`) that reaches the P&L
only implicitly through closing stock.

**Build on:** `department-performance.ts:18-33` already divides earned standard minutes by
**real clocked minutes** from `working_hour_entries` — a true efficiency ratio, and the right
foundation. The scan handlers need a second timestamp and a quantity field, not a new
subsystem.

---

### Second tier — real gaps, lower urgency at this scale

| Gap | Evidence | Note |
|---|---|---|
| **Warranty does not exist for customer products** | `warranty` across `src/` matches only factory equipment (`equipment.ts:39-40`) and a document-upload category. `service-cases.ts` has zero matches for `warranty\|chargeable\|billable`; service SOs price 0 by design | No warranty period per product, no expiry check, no warranty-vs-chargeable split — every repair is free with no way to bill an out-of-warranty one |
| **Return → credit note is two disconnected actions** | `delivery-returns.ts:422-438` stores a bare `creditNoteId` string with no validation that a CN exists or matches the value; the header comment `:384-386` says so | Restock and GL reversal both exist; nothing joins them. Contrast the *supplier* return path, which is a real cascade (`purchase-returns.ts:203`, `:215`) |
| **No credit gate on the sales order** | `sales-orders.ts` has no credit check; the gates are at DO and CN-convert only, documented as deliberate "Policy A" (`delivery-orders/_helpers.ts:2569-2573`) | Also: no manual hold flag on `customers`, no override path, and the gate uses the outstanding total, never aging. `customers.credit_terms` is decorative — due dates come from `nextMonthDueDate` (`invoices.ts:1734`) |
| **No quotation document** | `migrations-postgres/0179_per_line_discount.sql:20`: "quotation_items does not exist in this codebase — skip." `customer-quotation.ts` is a price-list snapshot; `/send-quote` emails a browser-built PDF and logs an activity row | No quote numbering, revisions, expiry or convert-to-SO |
| **No RFQ** | `rfq\|request_for_quote\|quotation_request` → zero matches in `migrations-postgres`. `generate-supplier-quotation-pdf.ts:11-17` prints standing bindings; `ComparisonTab` compares standing bindings, with no award action | |
| **No sales commission; salesperson is on the customer, not the order** | `commission` matches nothing outside the substring in `DECOMMISSIONED`. `customers.salesperson_user_id` exists purely for row-level visibility (`sales-orders.ts:1127-1128`) | Attribution is by account owner and moves if the account is reassigned |
| **Fixed-asset disposal posts nothing** | `PUT /fixed-assets/:id` with `{dispose:true}` only sets `disposedAt` (`accounting.ts:11166-11173`) | Cost and accumulated depreciation stay on the balance sheet forever; no gain/loss recognised |
| **No unrealised FX / period-end retranslation; AR is MYR-only** | `revalu*\|unrealis*` → zero matches in routes, libs, migrations, pages. `currency\|fx_rate` → zero in `invoices.ts` and `payments.ts` | Open foreign PIs stay at historic rate; the whole FX effect lands at settlement |
| **Ledger tamper-detection is never run; immutability is app-layer only** | `CREATE TRIGGER` → **no matches** anywhere in `migrations-postgres/`. `verifyJournalChain` (`journal-hash.ts:309`) has **no production caller** — only its definition, a comment, and `tests/hash-chain.test.mjs` | "Append-only" is a convention plus a detector that is never invoked. Also in `MFRS-GAP-ANALYSIS.md` |
| **Audit coverage is 33 of 136 route files** | Measured 2026-08-13: 33 of the 136 top-level files in `src/api/routes/` import `src/api/lib/audit.ts` (`emitAudit`/`buildAuditStatement`, `:87`, `:154`). `products.ts` (1,245 lines) has **zero**; so do `customers.ts`, `inventory.ts`, `suppliers.ts`, `price-history.ts`, `pay-rules.ts`, `organisations.ts`. Documents and user accounts are well covered (`sales-orders.ts:4350`, `users.ts:521-540`) | Master data, pricing, inventory quantities and pay rates are largely unaudited |
| ~~**The audit read endpoint has no authorization**~~ **✅ CLOSED — re-read 2026-08-14** | `audit-events.ts:68` is `const denied = await requirePermission(c, resource, "read"); if (denied) return denied;`, and the org filter exists too — `getOrgId(c)` at `:78` feeding `AND (orgId = ? OR orgId IS NULL)` at `:88` (NULL admitted for rows written before the column was populated). | No exposure. This row asserted "no `requirePermission`, no org filter" against code that has both. |
| **No retention policy, and archiving is disabled** | `gdpr\|pdpa\|retention polic` → nothing in `src/api` or `docs`. User deletion is soft (`users.ts:12`). Archive returns 410 (§2.2 ⑥) | No subject-erasure path, no maximum age on any table |
| **No subcontracting** | `subcontract\|outsource\|toll` in routes matches only 3PL *delivery* and `workers.isOutsource` (outsourced labour on the payroll, `workers.ts:587-595`) | No way to send WIP out, hold it at a third party, receive it back, or cost the service |
| **No work centres or machines in planning** | `work.?cent\|machine_id\|workcenter` → **zero** across routes and libs. `equipment.department` is free text and no planning lib reads it | Capacity is per department, per lane. Reasonable at this scale; note it before anyone plans machine-level |
| **No traceability report** | The links exist — `cost_ledger` RM_ISSUE rows carry `batchId` + `refId=poId` (`po-cost-cascade.ts:884-900`), `fg_units` carries `poId`/`soId`/`doId`. There is no genealogy endpoint or page (`genealog\|traceab` → nothing) | Two production data gaps recorded in code would break the join anyway: `rm_batches.grnId` NULL on all GRN-sourced lots and `fg_units.batchId` NULL on all rows, with the backfill written but not run (`stock-breakdown.ts:121-125`, `:509-516`) — *quoted from in-repo comments, not re-measured*. Also `ISO-9001-GAP-ANALYSIS.md` §8.5.2 |
| **No ad-hoc reporting** | Every report is a hand-coded endpoint or a client-side aggregation; no builder, no saved report definitions | Mitigated by the strong grid export — though `exportName` is set on only 13 of 174 page files |
| **FG `shortCode` is random with no uniqueness constraint** | `fg-units.ts:432` `String(100000 + Math.floor(Math.random() * 900000))`, used as a scan lookup key at `:1065` / `:586` with `LIMIT 1`. No UNIQUE index found in `migrations-postgres/*.sql` (searched, not exhaustively read — treat as likely, not certain) | A collision resolves a scan to an arbitrary wrong physical unit |

### Explicitly *not* recommended at this scale

Multi-currency AR, deferred tax, an event bus, micro-frontends, a data warehouse,
machine-level finite scheduling, and full MFRS provisioning (ECL, NRV, warranty provision)
are all real absences — see `MFRS-GAP-ANALYSIS.md` — but none of them is what costs this
business time or money today. Build the eight above first.
