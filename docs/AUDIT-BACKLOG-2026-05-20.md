# Audit Backlog — 2026-05-20

Comprehensive findings from 5 parallel background audits (Agents A/B/D/E/F/G).
This document is the **source of truth** for what was found and what's planned —
keep it updated as items get triaged or shipped.

**Total findings logged: ~120 items across 6 dimensions.**

---

## Status legend

| Symbol | Meaning |
|--------|---------|
| ✅ FIX-NOW | Included in PR 0 (`claude/critical-money-fixes`) — owner explicitly approved |
| 🔄 PLANNED-PR | Covered by a planned future PR (Dashboard snapshot, date format, etc.) |
| 🗒 BACKLOG | Deferred — needs owner triage in a future session |
| ❌ NOT-FIXING | Owner explicitly declined |

---

## ✅ PR 0 — Critical Money Fixes (the only items shipping NOW)

Branch: `claude/critical-money-fixes` off `staging`. Owner approved on 2026-05-20.

| # | File:Line | Bug | Fix approach |
|---|-----------|-----|-------------|
| 1 | `src/api/routes/payments.ts:198-310` | Two finance staff record payment on same invoice → `paidAmount` last-write-wins → payment silently swallowed → customer chased for money already paid | Atomic SQL: `UPDATE invoices SET paidAmount = paidAmount + ? ...` |
| 2 | `src/api/routes/import-completion.ts:3552-3996` (and siblings) | Backfill endpoint has no double-click protection → wip_items inflates | **Delete the backfill feature entirely** (not in use per owner) |
| 3 | `src/api/lib/po-cost-cascade.ts:471-540` | Two POs complete simultaneously, both read same rm_batch remainingQty, both decide same slice → cost_ledger doubles, inventory under-deducted | Re-read remainingQty per slice + reject over-pull |
| 4 | `src/api/routes/invoices.ts:716, 970-979, 1023` | Cancel/delete invoice doesn't reverse `customers.outstandingSen` → AR drifts up forever | Reverse outstandingSen on cancel/delete (SENT/PARTIAL_PAID/DRAFT all paths) |
| 5 | `src/api/routes/payments.ts:225, 268` | Negative payment amount accepted → bypasses Credit Note gate | Reject `amount <= 0` at backend |
| 6 | `src/api/routes/credit-notes.ts:201-209` | CN amounts ambiguous RM vs sen → potential 100× decimal error | Rename fields to `unitPriceSen` / `totalSen` to match invoice convention |
| 7 | `src/api/routes/payments.ts:268-274` | Overpayment accepted, paidAmount exceeds totalSen, customer credit vanishes | Reject when `newPaid > totalSen` (refund-balance approach declined for simplicity) |
| 8 | `src/api/routes/sales-orders.ts:580-625` | Cancel SO: IN_PROGRESS work has no cost_ledger REVERSAL row → cancelled work carries cost forever, P&L wrong | Write REVERSAL row when JC transitions to CANCELLED with cost > 0. COMPLETED JC stays inviolate per memory rule. |

---

## 🔄 PLANNED-PR (after PR 0 ships)

### PR 1 — Dashboard Snapshot
Architecture decisions already locked in via `/plan-eng-review`:
- D1: Full 4-PR plan (but PR 0 inserted before)
- D2: Incremental in-transaction + complex fields recompute (write-through cache pattern)
- D3: 9901/9902 cleanup as separate PR after Dashboard snapshot proves out
- D4: Bulk imports use `?bulk=true` flag — N/A since backfill is being deleted

Branch will be: `claude/dashboard-snapshot` off `staging`.

### PR 2 — 9901/9902 Cleanup
Delete:
- `migrations-postgres/9901_dashboard_mat_views.sql`
- `migrations-postgres/9902_mv_revenue_by_month.sql`
- `.github/workflows/refresh-mvs.yml`
- `POST /api/internal/refresh-mvs` (worker.ts:300)
- `GET /api/dashboard/summary` (worker.ts:470)
- `GET /api/dashboard/revenue` (dashboard-revenue.ts)
- MVs themselves via `DROP MATERIALIZED VIEW`

Reason: confirmed dual-dead by Agent A — MVs refresh but no frontend reads them. Stop wasting Supabase CPU.

### PR 3 — Date Format / UX
Two screenshots from owner on 2026-05-20:
- **Photo 1** (Production page filter) — keep as-is, current format is the desired one
- **Photo 2** (year > month > day nested picker on some other page) — needs changing, owner can't search by "15/5" format

TODO: identify which page/column uses the bad format, propose fix.

---

## ❌ NOT-FIXING (owner explicitly declined)

| # | Finding | Owner decision |
|---|---------|---------------|
| 1 | Same productCode different prices — Invoice uses lastWins, DO list uses firstWins (`invoices.ts:538`, `do-value.ts:122-126`) | "不碰" — declined |
| 2 | Payment date always overridden to today (`payments.ts:229, 293, 306`) — backdated payments lose their real receive date | "不ok 我们会有 backlog 处理" — deferred to backlog separately |
| 3 | All Agent F validation drift findings (sofa sizeCode quote-strip, fabricCode truthy check, productCode case-insensitive fallback, creditTerms free text, customSpecials silent normalize, credit limit NaN) | "不要限制先" — owner doesn't want more validation restrictions |
| 4 | RBAC / authorization gaps | "公司很中性的 没有这种限制 因为我们小" — small trusted team, no RBAC needed |
| 5 | Test coverage gaps | "也 ok" — not investing in test infrastructure as a project |

---

## 🗒 BACKLOG — Agent A: Abandoned / half-built work (~17 items)

| # | File:Line | What | Severity |
|---|-----------|------|----------|
| A1 | `src/api/routes/consignment-orders.ts:657` | CO status-changes API hardcodes empty array — table actually populated, CO Detail page silently shows blank history | LIVE-STALE prod bug |
| A2 | `src/api/routes/consignment-orders.ts:261-265` | CO cascade only handles CANCELLED — ON_HOLD allowed but doesn't cascade to children. Same divergence as DUP-003 in BUG-HISTORY | LIVE-STALE prod bug |
| A3 | `wrangler.toml:122-147` | "WHAT'S MISSING" comment is outdated — GH Action `refresh-mvs.yml` already exists | Stale doc, misleads future devs |
| A4 | `src/api/worker.ts:470-496` | `/api/dashboard/summary` endpoint — zero frontend callers | Covered by PR 2 cleanup |
| A5 | `src/api/worker.ts:725-728` + `src/api/routes/dashboard-revenue.ts` | `/api/dashboard/revenue` endpoint — zero frontend callers | Covered by PR 2 cleanup |
| A6 | `migrations-postgres/9901/9902` + 5 MVs | Refreshing every 15 min, serving no one | Covered by PR 2 cleanup |
| A7 | `wrangler.toml:149-172` | PO-emission queue bindings commented out, producer/consumer/call-site code all exists but unreachable | Dead scaffolding |
| A8 | `wrangler.toml:194-205` + `src/api/cron/daily-backup.ts` | Daily backup cron commented out; backup actually ships via GH Actions | Unreachable handler |
| A9 | `src/api/routes/mdm.ts:228` + `src/api/lib/mdm-detect.ts:39` | MDM detection endpoint exists but no cron / no frontend / TODO points at abandoned plan | Orphan feature |
| A10 | `migrations-postgres/0001_init.sql` | `approval_requests` table — zero references in src/ | Orphan schema |
| A11 | `migrations-postgres/0001_init.sql` | `divan_height_options` table — zero references (heights come from products.defaultVariants JSON) | Orphan schema |
| A12 | `migrations-postgres/0048_worker_sessions.sql` | `worker_sessions` table — only mock dev server uses it; prod uses JWT cookie | Orphan in prod |
| A13 | `wrangler.toml:118-120` | `ERP_METRICS` Analytics Engine binding commented out since 2026-04-26 — observability degraded to console-only | Permanently off |
| A14 | `wrangler.toml:240-244` + `auth-oauth.ts` + `oauth_identities` | OAuth Google config commented out, endpoint fails closed with 503 | Either enable or delete |
| A15 | `migrations-postgres/0050_mv_revenue_by_month.sql` | Noop placeholder `SELECT 1`, numbering-parity hack from a D1 tree that no longer exists | Ghost migration |
| A16 | `src/api/routes/consignment-orders.ts:653` | Stale TODO points at work that was finished (table added by 0104) | Stale doc, doubly misleading with A1 |
| A17 | `src/api/lib/po-cost-cascade.ts:617, 826, 853, 870` | Four `TODO(wip-phase-2)` markers — WIP layer tracking unfinished, pairs with arch_wip_idempotency_gap memory | Architecture pending |

---

## 🗒 BACKLOG — Agent B: Cascade snapshot gaps (25 items)

### Tier 1: Operator-visible (PDF shows wrong/missing data) — 12 items

| # | Field | Where | Symptom |
|---|-------|-------|---------|
| B1 | `customerAddress` | invoice has no column; DO has `delivery_address` not copied (`invoices.ts:569-598`) | PDF shows "Address: KL" (state fallback) — **OWNER ORIGINALLY REPORTED THIS** |
| B2 | `attention` (contact person) | invoice has no column; DO has `contact_person` not copied | PDF "Attention: -" |
| B3 | `customerPhone` | invoice has no column; DO has `contact_phone` not copied | PDF "Phone: -" |
| B4 | `terms`, `companyName` | invoice route never returns these | PDF hardcodes "NET 30" regardless of `customers.credit_terms` |
| B5 | `customerPOId` | DO has `customer_po_id`, invoice has no column | Customer's PO# disappears from invoice |
| B6 | `soRef`, `doRef` display strings | invoice route never builds these | PDF falls back to raw IDs instead of company SO/DO numbers |
| B7 | `customerAddress`/`attention` on Credit Note | `credit_notes` has no address columns | Currently latent (CN PDF has no caller) |
| B8 | Same as B7 on Debit Note | `debit_notes` has no address columns | Same latent |
| B9 | `customerAddress` on Statement | No statement table; PDF reads `data.customerAddress` | "-" or live customer lookup (retro-change) |
| B10 | `invoiceDate` snapshot on CN/DN | `credit_notes`/`debit_notes` store invoice_no but not date | CN PDF needs live invoice lookup |
| B11 | Hub address on consignment_note | CO has hub info, consignment_notes carries name only | Delivery address relies on live `customer_hubs.delivery_address` |
| B12 | `customerState`, `deliveryAddress`, `contactPerson`, `contactPhone` on consignment_notes | Entire delivery block missing | Consignment delivery slip has no address/contact |

### Tier 2: AR / Accounting retro-change risk — 6 items

| # | Field | Where | Risk |
|---|-------|-------|------|
| B13 | Customer address on SO/CO PDF | `generate-order-pdf.ts:161-165` uses LIVE fetch | Customer changes address → old SO/CO PDFs retro-change |
| B14 | Customer contact/phone/email on SO/CO PDF | Same site, live fetch | Same retro issue |
| B15 | `invoice_items.unitPriceSen` price lookup | `invoices.ts:536-555` uses productCode Map — duplicate codes overwrite | Two SO lines same product, different prices → second overwrites first, partial-delivery invoice wrong |
| B16 | `invoice_payments` snapshot | No payor name, no currency stored | Receipt audit can't reconstruct who paid |
| B17 | `payment_records.allocations` | JSON text, stale if invoice number changes | Receipt PDF would show stale invoice ref |
| B18 | `customer_state` on credit_notes/debit_notes | Missing | CN PDF can't even fall back to state |

### Tier 3: Internal cascade drift — 7 items

| # | What | Where |
|---|------|-------|
| B19 | `production_orders` has no `hub_id`/`hub_name` snapshot | `production-builder.ts:666-712` |
| B20 | `production_orders` has no `customer_delivery_date` snapshot | Same |
| B21 | `production_orders` missing `customer_po`/`customer_po_date`/`customer_so`/`customer_so_date` | Same |
| B22 | `delivery_order_items` has no `unit_price_sen`/`line_total_sen` | `0001_init.sql:512-527` |
| B23 | `consignment_orders` → `consignment_notes` no price snapshot | `consignment-notes.ts:334-364` |
| B24 | Invoice has no `delivery_date` equivalent | `0001_init.sql:530-557` |
| B25 | CN/DN `items` is JSON blob, no FK to invoice_items | `0001_init.sql:596,613` |

---

## 🗒 BACKLOG — Agent D: Concurrency / race conditions (17 items not in PR 0)

**Top 3 in PR 0**: D1 (payment race), D2 (backfill double — being deleted), D3 (FIFO rm_batch race).

### Tier 2: Edge-case but real — 9 items

| # | File:Line | Scenario | Damage |
|---|-----------|----------|--------|
| D4 | `src/api/routes/production-orders.ts:4905-5183` | Two workers scan same piece sticker within 100ms | Second worker's scan lost, first scan persisted alone |
| D5 | `src/api/routes/fg-units.ts:599-679` | Two warehouse workers both press PACK/LOAD/DELIVER on same FG unit | Payroll piece-count credits wrong worker |
| D6 | `src/api/routes/sales-orders.ts:2207-2370` | Admin saves SO edit while another admin clicks Cancel SO | SO ends CANCELLED with new items, or half-rebuilt state |
| D7 | `src/api/routes/production-orders.ts:4748-5253` | Worker scans final JC piece while admin cancels parent PO | PO ends CANCELLED but FG units created, labor posted |
| D8 | `src/api/routes/invoices.ts:660-779` | Concurrent invoice PUT — one edits dueDate, another posts payment | Payment delta silently overwritten |
| D9 | `src/api/routes/delivery-orders.ts:1985-2480` | Two admins flip DO DRAFT→LOADED simultaneously | stock_movements double STOCK_OUT |
| D10 | `src/api/routes/delivery-orders.ts:2492-2526` | DO dispatch cascade reads sibling SO status non-atomically | Duplicate so_status_changes rows |
| D11 | `src/api/lib/po-cost-cascade.ts:578-588` | postJobCardLabor non-atomic idempotency check | Double labor posting on race |
| D12 | `src/api/routes/payments.ts:477-528` | Two staff both mark same payment BOUNCED | Customer outstandingSen credited twice |

### Tier 3: Theoretical / specific timing — 8 items

D13-D20: status transition races with no row-level locks. Same fix pattern (`UPDATE ... WHERE status = ?` then check `changes === 1`). See agent output in `tasks/a3267957d9eb202f5.output` for full details.

---

## 🗒 BACKLOG — Agent E: Idempotency gaps (14 items not in PR 0)

`wip_items` itself is **already fixed** via migration 0100 + `wip_cascade_log`. The same pattern exists in other tables — none in PR 0 per owner direction.

### Money-affecting — 6 items

| # | Table / Route | Damage |
|---|--------------|--------|
| E1 | `invoices(delivery_order_id)` no UNIQUE — `delivery-orders.ts:592-650` | Same DO into DELIVERED twice → two invoices, customer billed twice |
| E2 | CN convert-to-invoice — `consignment-notes.ts:791-960` | Same CN converted twice → duplicate invoice |
| E3 | Payment idempotency opt-in — `payments.ts:235-309` | Frontend sends header, but no defence-in-depth at DB level |
| E4 | `cost_ledger(refType, refId, type)` no UNIQUE — affects FG_DELIVERED, RM_ISSUE, LABOR_POSTED, FG_COMPLETED | COGS doubled on cascade replay |
| E5 | Same — RM_ISSUE specifically (`po-cost-cascade.ts:419-428`) | Raw materials over-deducted |
| E6 | Same — LABOR_POSTED specifically | Factory labor doubled |
| E7 | Same — FG_COMPLETED specifically | FG unit cost double-rolled |

### Email — 2 items

| # | What | Damage |
|---|------|--------|
| E8 | `outbox_emails` no row claim (`email-outbox.ts:154-232`) | Two parallel cron triggers send same email twice |
| E9 | `enqueueEmail` no idempotency key | Retry double-enqueues, recipient gets two |

### Inventory / audit — 5 items

| # | Table | Damage |
|---|-------|--------|
| E10 | `fg_units(po_id, unit_no, piece_no)` no UNIQUE | Concurrent PO COMPLETED cascade → FG stock doubled |
| E11 | `so_status_changes` / `co_status_changes` no UNIQUE on (so_id, from, to, source_event) | Audit noise on cascade replay |
| E12 | `fabric_trackings.fabricCode` no UNIQUE | Tracker row silently duplicated |
| E13 | `stock_movements` no UNIQUE | Audit noise only (stock itself protected) |

---

## 🗒 BACKLOG — Agent F: Type drift + back-door writes (14 items)

Validation drift items (6 items) skipped per owner. Only type drift + back-door writes kept.

### Back-door writes (violate `feedback_no_back_door_writes.md` memory) — 2 items

| # | File:Line | What |
|---|-----------|------|
| F1 | `src/api/routes/invoices.ts:805-808` | Invoice PUT accepts `items[].totalSen` — UI has no input cell for total (it's qty×price). API can write inconsistent values. |
| F2 | `src/api/routes/customers.ts:96-130` | Customer POST accepts `outstandingSen` — UI has no input cell. Import scripts / curl can seed fake balances. |

### Type drift — 12 items

| # | File:Line | Drift |
|---|-----------|-------|
| F3 | `invoices.ts:111` vs `mock-data.ts:1062` | `paymentMethod` backend accepts any string; frontend offers 3; type union lists 5 |
| F4 | `delivery-orders.ts:34-39` vs `types/index.ts:11` | `DeliveryStatus` union has DISPATCHED/SIGNED with no FSM path |
| F5 | `delivery-orders.ts:1957-1973, 191` | Backend returns `hubState/driverContactPerson/driverPhone/vehicleId/vehicleType/signedByWorkerName` — not in frontend DeliveryOrder type |
| F6 | `delivery-orders.ts:2078-2103` | DO PUT accepts both `providerId` and `driverId` as aliases — frontend not audited which it sends |
| F7 | `customers.ts:188` | `creditLimitSen: "abc"` becomes NaN, passes `??` check, stored as NaN |
| F8 | `sales-orders.ts:1655` | Frontend POSTs `status:"CONFIRMED"`, backend ignores body.status, hardcodes "DRAFT", frontend chains `/confirm`. Semantic mismatch. |
| F9 | `invoices.ts:143` | `paymentMethod ?? ""` — null silently becomes empty string |
| F10 | `sales-orders.ts:209` | `lineSuffix ?? -01` — masks rows where lineSuffix never persisted |
| F11 | `production-orders.ts:813, 824` | `itemCategory ?? "BEDFRAME"`, `currentDepartment ?? ""` — masks import bugs |
| F12 | `pages/planning/index.tsx:2361-2363`, `production/tracker.tsx:432-434` | `gapInches ?? "-"`, `divanHeightInches ?? "-"`, `legHeightInches ?? "-"` — masks cascade drops |
| F13 | `customers.ts:51` | `creditTerms ?? "NET30"` — same default-masking pattern as B4 (terms hardcoded in PDF) |
| F14 | `invoices.ts:111` | `method ?? "BANK_TRANSFER"` — same pattern, masks malformed payment rows |

**Key insight from Agent F**: the `??` defensive-fallback pattern is "a bug's invisibility cloak" — it hides cascade-drop bugs (Tier 3 from Agent B) at the read site. Fixing F9-F14 would expose those Tier 3 cascade gaps as real symptoms.

---

## 🗒 BACKLOG — Agent G: Money flow edge cases (12 items not in PR 0)

**Top 5 in PR 0**: G2 (price drift — declined), G3 (AR not reversed), G5 (negative payment), G6 (overpayment), G8 (cost_ledger reversal on SO cancel). Plus G16 (CN unit cleanup).

### Money wrong — 4 items

| # | File:Line | Scenario |
|---|-----------|----------|
| G7 | `src/api/routes/invoices.ts:731-748` | PUT with lower `body.paidAmount` silently lowers paid without invoice_payments reversal |
| G9 | `src/api/routes/credit-notes.ts:112, 256` | CN amount > paidAmount but < totalSen → paidAmount > newTotal possible, status flips to PAID, no refund-due tracking |
| G10 | `src/api/routes/credit-notes.ts:256-258` | CN amount > customer outstandingSen → MAX(0, ...) clamps, overflow lost (no customer credit balance) |
| G11 | `src/api/routes/invoices.ts:514-538` | Multi-SO DO manual POST /invoices only loads first SO's prices → other SOs' items resolve to 0 unitPrice |

### Inventory wrong — 2 items

| # | File:Line | Scenario |
|---|-----------|----------|
| G12 | `src/api/routes/sales-orders.ts:2686-2748` | SO line qty reduction with existing POs → orphaned POs reference old item identity |
| G13 | `src/api/routes/delivery-orders.ts:34-39` | No CANCELLED transition in DO FSM — DRAFT DO created by mistake stuck forever |

### Status / lifecycle — 3 items

| # | File:Line | Scenario |
|---|-----------|----------|
| G14 | `delivery-orders.ts:1995-2011` + `invoices.ts:557-590` | Empty DO auto-flips DELIVERED → 0-item invoice with SO total via fallback — **OWNER ASKED FOR CLARIFICATION, NOT YET TRIAGED** |
| G15 | `invoices.ts:716, 970-979, 1023` | PARTIAL_PAID → CANCELLED allowed with nonzero paidAmount left untouched (subset of PR 0 #4) |
| G17 | `sales-orders.ts:2304-2407, 2374` | SO ON_HOLD → CANCELLED → resume path: JCs cancelled in cancel cascade not restored on resume |

### Other — 3 items

| # | File:Line | Scenario |
|---|-----------|----------|
| G18 | `sales-orders.ts:2330-2368` | Cancel-blocked when JC has completedDate, no path to retire phantom-completed SOs after return |
| G19 | `delivery-orders.ts:597-684` | Idempotent invoice-create cascade re-fires if previous DRAFT invoice was DELETED, bumps customers.outstandingSen again |
| G20 | `consignment-notes.ts:863-890` | Customer credit-limit check non-atomic — concurrent write can push past limit |

---

## 🗒 BACKLOG — Agent C: Performance landmines (25 items)

Documented in Agent C output. Top 3 currently biting:

| # | File:Line | What | When it bites |
|---|-----------|------|---------------|
| C1 | `src/api/routes/production-orders.ts:786, 389` | `rowToPO` O(N×M) filter — 530 PO × 2200 JC = 1M comparisons | Every Production page / Dashboard load |
| C2 | `src/api/routes/production-orders.ts:4906-4922` | PO scan endpoint loads all POs + all JCs, O(N×M) lookup | Every worker scan |
| C3 | `src/api/routes/cash-flow.ts:144-161` | Global fan-out — all bank_accounts, bank_transactions, journal_entries, ALL journal_lines, ALL invoices, ALL POs in one Promise.all | Accounting Cash Flow page load |

Other items: 25 entries covering O(N×M) patterns across the cascade (customers.ts, delivery-orders.ts, invoices.ts, consignment-orders.ts, service-cases.ts, service-orders.ts, qc-inspections.ts, qc-pending.ts, purchase-orders.ts, grn.ts, suppliers.ts, products.ts, rd-projects.ts, warehouse.ts), unbounded SELECTs, missing composite indexes, no log-table prune jobs.

See agent output `tasks/ab531ec12db5ff52d.output` for full details. **All deferred per owner direction — focus is PR 0 + Dashboard snapshot.**

---

## Next-session triage queue

When owner picks this up again, suggested triage order:

1. **PR 1 ships first** (Dashboard snapshot) — fixes perf for the most-painful daily page
2. **Triage Agent B Tier 1** (12 PDF bugs) — direct user-visible value
3. **Triage Agent E money items** (E1, E4 — UNIQUE indexes) — defence-in-depth for owner-confirmed PR 0 fixes
4. **Triage Agent F back-door writes** (F1, F2) — direct memory-rule violations
5. **Triage Agent G CN/refund completeness** (G7, G9, G10) — close the AR loop properly
6. **Triage Agent F `??` fallbacks** (F9-F14) — once Agent B Tier 3 cascade gaps are addressed
7. **Triage Agent A dead code** — A1, A2 are real prod bugs (CO status changes blank + ON_HOLD cascade); rest is cleanup
8. **Performance work** — once data growth justifies (Agent C items)

---

## Memory of decisions made on 2026-05-20

For continuity if a future session needs to know why things were ordered this way:

- Owner explicitly limited PR 0 scope to 8 named fixes (`只根据我说的来修 我说不碰或者没提起的就不碰`)
- Owner declined RBAC audit ("公司很中性")
- Owner declined validation rule additions ("不要限制先")
- Owner deferred test coverage investment
- Owner deferred payment date backdating ("会有 backlog 处理")
- Owner declined same-productCode price unification
- Empty DO scenario — owner asked clarification but PR 0 scope was frozen before clarification landed; logged as G14 above
- Backfill feature being DELETED (not fixed) — owner: "我们已经没有 backfill 功能了"
