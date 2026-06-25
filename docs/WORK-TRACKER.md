# Hookka ERP — Work Tracker

Durable, cross-session list of assigned / in-progress / shipped work so nothing is
forgotten. **Newest first. Update on every state change** (assigned → in progress →
shipped/parked). Re-read this + `MEMORY.md` at the start of each session and before
reporting "done". See `docs/DEV-OPERATING-FRAMEWORK.md` for the discipline.

Status key: 🔵 in progress · 🟡 parked/needs owner · ✅ shipped to prod · ⚪ queued

---

## 2026-06-25

### QR/Barcode · Rack · Packing · Warehouse · Payroll — rapid-QA batch (owner rapid-fire)
**✅ SHIPPED to prod + staging:**
- **Identity trio** (Customer · Customer PO · Our SO) on rack scan / rack warehouse grid / rack popup / stock-out / Packing List / DO PDF
- Rack display **dedup** (Assign-Rack SO/PO + grid "SO SO") + mobile rack **contents list**
- **Unified `/p/<token>` packing-rack scan fix** — archive-aware `resolveCard` + `pickPackingCard` tiers + token-mint hardening (BUG-2026-06-25-003..006)
- Schedule **"Barcode" column: QR → 1D Code 128** (barcode-gun reads it)
- Packing List **per-piece rack label** (HB / Divan can be on different racks)
- **Warehouse search** — partial match (Our SO / customer PO / customer / product)
- Rack card **de-cram** (cleaner per-item layout)
- **DO dispatch → auto stock-out** (whole DO's items leave their racks) — delivery-orders.ts `stampedOnDispatch`
- **Payroll TOTAL row alignment** (was missing the Allowance cell)
- Barcode + QR **render-resolution bump** (clarity)
- **Manual Rack dropdown now saves** — `patchRack` was the only mutating call missing the CSRF token → 403 → silent rollback (`f9f05433`)
- **Staging code + DB sync** (FF + sync-staging.yml)

**✅ SHIPPED (cont.) to prod + staging:**
- **Sticker show/print slowness** — preview paints instantly (fallback URL) then upgrades to /p/ in the background; mint endpoint batched (serial per-piece loop → 2 queries + parallel mint). `bcb000d4` (BUG-2026-06-25-008a)
- **Manual rack assignment → warehouse occupancy** (owner B) — `applyPackingRack` now mirrors a `rack_items` row (set/move/clear + `rack_locations` status); office dropdown / `/p/` / worker scan all now show in the Warehouse grid; NEW shared `packingPieceIdentity` locks the identity vs the `/r/` scan. `3ec97e43` + CI wiring `4604c1a0` (BUG-2026-06-25-007)
- **CSRF audit = FALSE POSITIVES** (closed, NOT a bug) — `api-client.ts` globally monkey-patches `window.fetch` to auto-inject the token; the 40 "missing-CSRF" hits are non-bugs; the earlier `patchRack` CSRF "fix" (`f9f05433`) was a no-op. Don't re-chase. (BUG-2026-06-25-008b)

**❌ Code 3-day lifecycle rule — DECLINED by owner (2026-06-26).** Owner chose **(A) always-scannable, NO time limit** after learning the old "expiry" was structural resolution failures, not a timer. NOT building a time-based expiry; the structural fixes (archive-aware resolve + pickPackingCard + token re-read) already shipped are the whole ask. See [[project_qr_no_3day_expiry]].

**🟡 PENDING / owner action:**
- **#1 external-phone scan opens Worker Portal not /p/** — owner reprint a sticker on staging + scan: old sticker = reprint; still wrong = mint bug (I dig)
- **#3 completed-piece "Complete" button** — CONFIRMED **NORMAL** (2-PIC sign-off), no change
- **Packing List stacked per-piece layout** mockup — awaiting owner OK
- **Verify on staging**: pick Rack 9 on the packing sheet → confirm it shows under Rack 9 in Warehouse; sticker preview/print is fast now

### 🔵 Owner "继续财务" → document-date reporting basis (was entry-date / postedAt)
Owner: "一切跟单据日期，不是开单日期 — 7月开6月的东西算6月." Root: the immutable ledger stores only `postedAt` (entry time) and ALL GL reports bucket/floor by it; a June invoice entered in July landed in July. Owner saw it as Monthly P&L Sales (634k, by postedAt) ≠ Command Center invoices (312k, by invoiceDate) — confirmed not my floor (pre-existing accrual-vs-issue gap). Owner approved a read-time **document-date resolver** (no DB change, postedAt fallback). Design/plan: `财务模块-单据日期口径-设计.md`/`-实施计划.md`.
- **Good news**: subledger reports (AR/AP control, statements, debtor/creditor-ledger, aging) were ALREADY document-date (read invoiceDate/date directly) — only the GL-based reports used postedAt.
- Pure `src/lib/doc-date.ts` (`stripLegSuffix` drops _void/_bounce/_reversal/_settle/_restate_rev|post:stamp → base family; `DOC_DATE_FAMILIES` maps 12 families → table/no/date cols, snake_case) + 8 tests. `loadDocDateResolver(db)` (accounting.ts) loads each family's (id, human-no → own date) ONCE, dual-keyed (sourceId is sometimes UUID, sometimes the doc number), try/catch per family, `docDate(sourceType,sourceId,postedAt)`: opening→opening_date, mapped family→doc date, period-end bookkeeping→parsed from sourceId (`parseSourceIdDate`: depreciation `dep-YYYY-MM`→month-end, closing_stock `cs-YYYY-MM`→month-end, year_close `fyclose-YYYY-MM-DD`→that date), else→**postedAt fallback (= legacy, safe)**. contra is always same-day (`today`) → postedAt is already its doc date (kept). (Follow-up 1 `f7c49d8a`: period-end parser. Follow-up 2: per owner "银行转账也需要根据文件日期" — fund_transfer (pure-ledger, no date stored day-precise) now records its date in a new `fund_transfers` table (no→date, runtime self-apply + migration 0190 / Hookka迁移12); resolver family fund_transfer→fund_transfers; the /fund-transfers list also shows the doc date. Existing transfers (no row) fall back to postedAt.)
- Wired 13 GL read paths to docDate (bucket + floor): trial-balance, gl all+one, gl-report, pl, cashflow, bank-reco+automatch, glWindowSigned (P&L windows), cost-expense-classes, computeUnclosedAsOf, ar/ap-control GL sums. Added `sourceId` to the queries that lacked it.
- **Perf**: `computePnlWindow`→`glWindowSigned` is called per-month (pl-monthly/trend); threaded a `DocDateCtx` so the resolver loads ONCE per request, not ~12 tables × N months. typecheck+eslint+1189 tests green.
- ⚠️ Backend-only (no frontend chunk change) → owner verifies live: a backdated invoice (doc date earlier than entry) should land in its DOCUMENT month on P&L/GL.

### 🔵 Owner "继续财务" → opening_date hard floor (pre-opening data not extracted) — ALL financial reports
Owner set opening_date=2026-05-22 but the GL ledger still showed pre-opening (2026-05-18) invoices — opening_date was only used to DATE opening legs, never as a floor. Owner chose "排除 + 之后重录真实期初" + "直接全做" (floor every financial report, not just AR/AP). Pure helper `src/lib/opening-floor.ts` (`legBeforeOpening` GL / `rowBeforeOpening` subledger; opening SEEDS exempt — GL opening_balance legs + invoices/PIs `is_opening=1` — so opening balances are never lost) + 11 tests. Floored (17 read paths in accounting.ts): trial-balance, gl (all+one), gl-report, pl (P&L+BS), cashflow-statement, bank-reco + automatch, computePnlWindow (pl-statement/trend/monthly), cost-expense-classes, **computeUnclosedAsOf** (BS retained earnings — would've inflated), ar-control (GL sum + invoices), ap-control (GL sum + PIs), customer/supplier-statement, debtor/creditor-ledger, aging (snapshot — added kv_config to sourceTables so it rebuilds on opening_date save), other-party-aging. Floor preserves double-entry balance (whole events skipped, both legs). NOT floored (by design): manufacturing cost/stock reports (own `material_opening_date` cutover), fixed-asset register (master data), document-list registers (fund-transfers/PV/OR — operational, not balances). ⚠️ Expected effect until owner enters real opening balances: AR/AP/P&L/BS ≈ near-zero (post-05-22 activity only). typecheck+eslint clean.

### ✅ Owner "继续财务" → "收尾小项" — task-chip cleanup batch (AP / supplier-discount) — SHIPPED (main `78f47bb2`; prod chunk `accounting-Bzp1Jg9y.js`→`accounting-D2ouG57q.js`)
🟡 **Pending owner**: run `Hookka迁移11-粘贴到SQL-Editor.sql` (permissive PARTIAL_PAID/CANCELLED constraint, names + registers it — runtime self-apply already relaxes it) + live-test one partial supplier payment / discount-allocation (status → PARTIAL_PAID, no 500). Owner confirmed the Supplier-counter card stays removed ("就先这样"). See BUG-2026-06-25-001.
Owner picked the no-data cleanup bucket. Investigated all chips against real code (did NOT trust notes blindly — one was a false alarm, one a confirmed prod bug):
- 🔴 **CONFIRMED PROD BUG — `purchase_invoices.status` CHECK rejects `PARTIAL_PAID`.** `0057_purchase_invoices.sql:30` = `CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','PAID'))` — no PARTIAL_PAID. Supplier-discount alloc (accounting.ts:2001) + supplier partial-payment both write `status='PARTIAL_PAID'` → constraint violation → POST fails in prod. Second independent reason partial payments are silently broken (migration-7 missing column is the first). FIX: (a) runtime relax in `ensurePartialPaymentColumns` (`DROP CONSTRAINT IF EXISTS purchase_invoices_status_check`); (b) extract that helper to shared lib + call from `supplier-payments.ts` routes (closes the existing "supplier-payments should call ensure" chip); (c) migration 0186 + paste `Hookka迁移11` (DO-block: drop status CHECK, add permissive named `purchase_invoices_status_chk`).
- 🔵 **CREDIT_NOTE marker defensive filter** — markers = `supplier_payments` rows (amountSen=0, method='CREDIT_NOTE', no GL leg). Add `AND COALESCE(method,'')<>'CREDIT_NOTE'` to: supplier-statement (accounting.ts:2331) + creditor-ledger (2466) [hide 0-amount noise rows], and supplier-payments void/restate reads+delete [defense-in-depth; no number collision today].
- 🔵 **Remove dead AP "Supplier running counter" card** (accounting/index.tsx:3184-3190) — `suppliers.outstandingSen` never maintained → always red drift; the real reconciliation is card #2 (Creditor control vs booked-unpaid PI, drift=0). Keep symmetric AR Customer-counter card (that one IS maintained).
- ✅ **FALSE ALARM — journal-hash.ts:113 ledger UNIQUE constraint comment is CORRECT.** Prior note said it "lies"; actually `0117_ledger_idempotency.sql` really creates `UNIQUE(org_id,source_type,source_id,leg_no)`. The mislead: stale `delivery-snapshot.ts:6` comment cites a non-existent `0117_delivery_snapshots.sql` (real file = `0124_delivery_snapshots.sql`). No change to journal-hash; fix the stale delivery-snapshot comment.
- ⚪ **Voucher-print "loose ends"** — no TODO/FIXME in print-voucher.ts; nothing concrete found. Report back for specifics.

### ✅ Owner "全部做完" — Production/Dispatch/Worker-UX backlog closed out
Scoped all 6 open items (read-only multi-agent investigation). Result: most were already shipped after the 06-23 tracker entry; built the genuine gaps.
- ✅ **#1A Overview search by Customer PO** — `customerPOId` is in the search haystack (production/index.tsx:2659) + 98% populated live → already works. Complaint predated the haystack line.
- ✅ **#1B Overdue chip clears filters** — handler at :1376-1378 already clears q/state/customer/cat + clearAllOverviewFilters() (06-23 fix). Done.
- ✅ **#2 Pending-Dispatch QR-scan popup** — `do-scan.tsx`: product code already the primary line (prior commits); added shared **Customer PO** in the per-DO header (shown once when all lines agree, `hideCustomerPO` flag avoids per-row dup). Cherry-picked `571e3806`→main, shipped.
- ✅ **#3 Print uses SAVED layout + Org Default** — print preset wired (`printPresetLabel`); DataGrid auto-wires onSaveAsOrgDefault/onResetToOrgDefault when gridId present (data-grid.tsx:2846-7); ③ made them backend-shared. Done.
- ✅ **#4 Barcode** — already migrated 1D→compact ~12mm QR, column already "Barcode". The "thick/long/hard-to-scan" complaint was the OLD 1D code. Done (shrinking further would hurt scannability).
- ✅ **#5 Sticker component-type label** — `generate-sticker-pdf.ts`: new `componentTypeLabel(wipType)` (HB/Divan/Base/Cushion/Armrest/Headrest; blank for FG/merged) on landscape bottom-right + portrait right column. `wipType` already on the sticker model (no loader change). Cherry-picked `2c3804fd`→main, shipped.
- ✅ **#6 Catalog family tile** — already implemented (products/catalog.tsx: family grouping, one-tile-per-family, variant drill-down, family-keyed photos). My 14-photo seed lit the tiles up.

### ✅ Archive includeArchive UNION 500 — FIXED (BUG-2026-06-24-009b)
Self-healing `src/api/lib/archive-union.ts` (introspect + ALTER archive to column parity + explicit quoted ordered column list, replacing the fragile SELECT * UNION) + org_id backfill so pre-multi-tenant archive rows pass the org filter. includeArchive=true now 200 (was 500). NOTE: production_orders_archive is effectively empty — the 1665 purged pre-Apr docs live in `zz_purge_backup_*`, so model "559" is NOT in this archive; awaiting owner on WHERE they saw "559".

### ✅ ③ Org-shared DataGrid layouts · ④ Production-time resync · catalog photo seed · customer-email drain — all shipped + verified earlier this session (see BUG-HISTORY FEATURE-003/004/005, BUG-006/009b).

## 2026-06-23

### ✅ Post-work bug review + fixes (owner: "check for any bugs")
Two adversarial review agents over today's diff. **Money paths CLEAN** (PI posting, supplier discount, ap-control, void — all balanced/idempotent/atomic, drift=0). **UI: no crashes/corruption.** Fixed: (1) voided PV/OR/JV now print with a **VOID** stamp (control hazard); (2) orphaned DRAFT supplier-discount hidden from history (failed-save dead-end); (3) **`BUG-2026-06-23-008`** — editing an APPROVED **foreign** PI's lines corrupted its home amount (pre-existing, currency-blind edit path) → now blocked 409 "cancel & re-raise". Noted-not-fixed (pre-existing/product-call): AP "supplier counter" drift metric is unmaintained (GL-vs-subledger reconciliation is the correct one & is 0); popup-blocked print silent; repo-wide "Loading…" hang on API error; ledger unique-constraint + CREDIT_NOTE marker hardening (task chips).

### ✅ Printable vouchers — PV / OR / JV (→ main, feature)
Owner: "can the Payment Voucher etc. print out?" — they couldn't (no print on PV/OR/JV). Added a **Print** button per row on Expense Payment (PV), Official Receipt (OR), and Journal Voucher (JV) → opens a one-page A4 voucher via the browser-print pattern (`window.open`+`print`, like `printStmt`). Letterhead from `COMPANY.HOOKKA` ("Hookka Industries", per owner). Shared renderer `src/lib/print-voucher.ts` (`printVoucher`/`buildVoucherHtml`, HTML-escaped, pure builder) + pure `src/lib/amount-in-words.ts` (`amountInWords`, Malaysian "Ringgit … And Sen … Only", 9 tests). Layout: letterhead · title · No/Date · party · account lines (PV/OR amount; JV debit/credit + Σ) · total · amount-in-words (PV/OR) · remarks · signatures (Prepared/Approved/Received etc.). **No backend change** — list endpoints already return each doc's lines. tsc + eslint clean; 1168 tests. Subagent-built, reviewed (amount-in-words spot-checked, mappers verified vs edit view).

### ✅ Supplier Discount (purchase-CN upgrade) · #6 (→ main, feature)
Owner #6: "supplier gives me a discount, I need somewhere to input it" — can apply to one / many / no specific unpaid PI. The old standalone purchase-CN form (buried in Creditor Aging, jargon-named) is upgraded into a dedicated **Supplier Discount** tab (sidebar, Debtor/Creditor): select supplier → auto-list unpaid PIs → net+SST+reason → optionally tick/allocate per PI → Save (create→post) → history + Void. Design/plan: `财务模块-供应商折扣-设计.md`/`-实施计划.md`.
- **Task 1** pure `src/lib/discount-alloc.ts computeDiscountAlloc` (validate 0/1/many allocations, ≤ each PI outstanding, Σ ≤ total) + 10 tests (`f10a078f`).
- **Task 2** backend (`6b8b1d54`): PUT post takes `allocations[]` → reduces each PI `paid_amount_sen` + a `supplier_payments` `method=CREDIT_NOTE` marker (no bank/GL leg — the CN's DR400/CR-purchase already moved the GL); new `/:id/void` reverses GL (mirror legs) + allocations + supplier counter. No migration (reuses tables).
- **Task 3** frontend `SupplierDiscountTab` + sidebar + removed old form (`25030277`, subagent-built, reviewed).
- **Task 4** adversarial money-review → **GL/subledger/void all correct, atomic, idempotent, server-validated**. Fixed one real defect: `/ap-control` double-counted an allocated discount (`49fa5228`) — piOutstandingSen now net (amount−paid, incl PARTIAL_PAID), pcnPostedSen nets only the unallocated remainder → drift stays 0 (also fixes pre-existing partial-payment coarseness). Payment-history list excludes the markers.
- **Follow-ups (non-blocking, task chip):** defensive `method<>'CREDIT_NOTE'` on supplier-payment lifecycle queries; filter zero-amount markers from supplier-statement/creditor-ledger displays; confirm prod `purchase_invoices` status CHECK allows PARTIAL_PAID (stale migration file vs prod; existing supplier-payment flow already writes it).
- tsc + eslint clean; 1156/1157 tests.

### ✅ Audit Log — search box + "who" (actor name) · #10 (→ main)
Owner #10. (1) The **By** column now shows the actor's **name**, not a raw user id: `/audit-log` (`accounting.ts`) resolves the distinct `actorUserId`s → `users.displayName` (one `IN (...)` lookup) and returns `actorName` per row. (2) New **search box** on `AuditLogTab` — client-side filter over the ≤1000 loaded rows (reference / party / who / type / state). `AuditRow` gains `actorName?`; dynamic empty-state message. tsc clean, eslint clean, 1136/1137 tests. Read-only, low-risk → main.

### ✅ Sales-invoice "create-as-SENT doesn't post" — VERIFIED NO BUG (no change)
Checked all 4 invoice-create paths: `invoices.ts:1116` (manual from-DO) + `consignment-notes.ts:1213` (CN→invoice) create **DRAFT** (post on the PUT DRAFT→SENT transition); `delivery-orders.ts:908` (auto-on-delivery) + `:2142` (re-issue) create **SENT** and post in the SAME batch via `buildInvoiceLedgerLegs(..., itemsOverride)`. **No path creates SENT without posting** — unlike PI (whose POST accepted `body.status=APPROVED`, set by the import). The memory's "invoice is symmetric" assumption was wrong; corrected. Nothing to fix.

### ✅ PI created-as-APPROVED now posts to GL (bug fix → main) · `BUG-2026-06-23-007`
Root cause: `purchase-invoices.ts` only posted GL legs on a PUT status *transition* to APPROVED; the POST handler never posted. So a PI born APPROVED (bulk import / any create-as-APPROVED) fed Creditor Aging but not the ledger → 400-0000 drifted below aging (prod: 56 APPROVED PIs RM 75,340 in aging, 1 in GL). Fix: new pure `src/lib/pi-posting.ts buildPiApprovalLegs()` (DR buckets · CR 400-0000, balances) + 6 unit tests; POST posts on create-as-APPROVED (idempotent via `ledgerHasSource`, same atomic batch); PUT refactored onto the same helper (byte-identical, no drift). Opening PIs (`/opening-balance/ap`, isOpening) unaffected; history not retroactively posted (→ owner reconciliation). Backend-only; no operational module touched. build:strict clean, 1080/1081 tests, adversarial money-review SAFE (7/7). **NEXT: symmetric sales-invoice (DRAFT→SENT) fix.** Owner acceptance: create APPROVED PI → check Trial Balance / AP control.

### Mega-message backlog (owner, late 2026-06-23) — Production / Dispatch / Worker UX
- ✅ **Apply Completion single-row revert** — owner: "一个个按本来就没事,别动它". Reverted the forceShow change on the per-row completion + Status-cell paths; restored exact prior behaviour; kept ONLY the batch multi-select fix (BUG-2026-06-23-004). tsc 0 → main (741f5fa0).
- ✅ **Customer email — live prod check** — read 199 DOs on prod: **0 have any deliveredEmailAt/dispatchEmailAt** → customer-notify NEVER actually fired (dispatch OR invoice). Validates the backend-choke-point fix (already merged). No outbox GET endpoint exists. Historical 199 NOT auto-resent. Awaiting owner: do ONE real dispatch/invoice (I watch the stamp live) OR use the resend button (building).
- 🔵 **Production Overview — search by Customer PO returns nothing** (dept tabs DO find it) + **overdue chip should CLEAR search/customer/category and show full N** (owner: clicking red should pop the N, not make me clear the search first). Workflow wf_92a58d9f-c75 FAILED on transient API 500s → re-dispatching.
- ⚪ **Pending-Dispatch QR scan popup UI** (scan PL/DO QR → item list, e.g. DO-2606-072): show (1) **Customer PO** in the header, (2) per item **Product SKU = our Product Code** (e.g. 1013-(K)) **+ colour/fabric** (e.g. PC151-01). Example: "PO2605-123 · SO2606-133 · 1013(K) · Fabrics: PC151-01".
- ⚪ **Production Schedule PRINT must use the SAVED layout** — once owner sets columns + "Save as Production Schedule", every "Print Schedule" should print THAT saved column layout (not the current on-screen view); operator shouldn't hand-hide columns each print. ALSO verify "Save as Org Default" / "Reset to Org Default" actually work.
- ⚪ **Barcode (Print Schedule)** — (a) rename the "Scan" column → **"Barcode"**; (b) printed barcodes too THICK/LONG → only 6 items/page (30 items = many pages) AND insensitive/hard to scan ("scan 到半死都 scan 不到"). Redesign: compact + reliably scannable + more per page.
- 🟡 **Production STICKER component-type label (MISSED on first pass — added after owner flagged dropped tasks)** — on the printed per-job-card production stickers (the SO-2605-302-01 cards with QR + Fab Cut/Fab Sew + Qty), the bottom-right should clearly state WHAT PART this sticker is for: **HB / Armrest / Base / Divan / Cushion / Leg** etc. Owner asked "給我設計你會怎麽做" → propose a DESIGN first (mockup), get OK, then build. Component is derivable from the WIP/piece string (reuse the existing piece derivation).
- 🔵 **Catalog photos** — owner CHOSE: collapse same-family variants into ONE base tile (e.g. 1003 covers 1003 / 1003(A) / 1003(A)(HF)(W) + sizes), click tile → see variants, ONE family-level photo applies to all. Dispatched wf_6ed2a0bc-f17 (products/, parallel-safe). Feature → decide main vs staging at merge.
- ❌ **#54 Supplier Pricing merge — DROPPED** — owner: doesn't recognise it / not needed. Removed from scope.
- 🟢 **Announcement** — owner asked how workers see it / does it pop up. Current build = banner on worker phone home screen when they OPEN the app (no web-push). Offered: forced popup-on-open if wanted.

### ✅ JV account picker dropdown un-clipped (bug fix → main)
Owner screenshot: New Journal Entry line **Account** picker cut off after ~3 rows (CAPITAL / RETAINED EARNING / RESERVES). Root cause = `<div className="overflow-x-auto">` wrapping the JV lines table → `overflow-x:auto` forces `overflow-y:auto` → clipped the `absolute` AccountPicker dropdown. Fix = drop the wrapper (`accounting/index.tsx` ~L2493), matching OD/OC (bare table) / PV-OR (`w-80`) / labour (grid). Swept all 9 AccountPicker sites on the page — JV was the last clipped one. `BUG-2026-06-23-006`. tsc clean. → main.
- *Incidental:* paid down one pre-existing lint error blocking the gate on this file — `react-hooks/set-state-in-effect` (eslint-plugin-react-hooks v7) on the debtor/creditor ledger fetch effect (L5219, from today's `52fbe419` merge, which skipped the pre-commit hook). Targeted justified `eslint-disable-next-line` (standard `useCallback` data-load reused by the Refresh button; no behavior change).

## 2026-06-22

### 🔵 Mail Center — Gmail-style redesign with toggles (worktree, feature; do NOT push/merge)
Owner showed Gmail screenshots; asked for ALL of:
1. Compact single-line conversation rows (checkbox · star · unread dot · **Sender** · Subject — snippet … date right; hover row actions; tighter rows; unread distinct). Toggle = density compact/comfortable.
2. Category tabs above list: All / Primary / Notifications. CLIENT-SIDE heuristic over fetched rows (no backend cols). Toggle = show/hide tabs.
3. Reading-pane toggle: split (list + right pane, current) vs full-width list (row opens detail route). Persist in localStorage.
4. Cleaner Gmail-like visual polish; keep left nav functional (Inbox/Starred/Sent/Archive/Drafts/Trash/All + Labels + Departments/Mailboxes).
PLUS a master toggle Gmail-view vs Classic-view OR per-feature toggles ARE the "可以开关" (document choice).
PRESERVE ALL behaviour: reply/forward/star/unread/archive/trash, labels, Assign to, mailbox+dept scoping, unread counts, search, pagination, ~300 conversations. No API-contract change. build:strict must pass; UI 100% English.

### 🔵 F6 T4b — wire FIFO engine into P&L (branch `f6-material-fifo`, only `src/api/routes/accounting.ts`)
- New `loadMaterialCost(db, orgId, startIso, endIso)` → `{rmGroups[], wipOpenSen, wipCloseSen, fgOpenSen, fgCloseSen, warnings}` using the verified engine (`computeMaterialPeriod`/`rollupByGroup`/`valueIssues`).
- RM: opening (material_opening_stock) + GRN receipts (PI-weighted-avg if APPROVED PI else grn_items.unit_price) + cost_ledger RM_ISSUE/ADJUSTMENT, post-cutover, same-date receipts before issues.
- WIP: per-PO Σ FIFO issue cost (ref=PO) + LABOR_POSTED for POs in-progress as-of-D (date reconstruction).
- FG: per completed-not-delivered batch, FIFO unit cost = (PO FIFO material@completion + labor@completion)/original_qty × undelivered-qty-as-of-D (fg_units.delivered_at).
- Swap rmGroups/wip/fg values in computePnlWindow to loadMaterialCost; keep 704-x excluded from GL bands.

---

## 2026-06-21

### ⏸️ AWAITING OWNER — 3 decisions to finish the purchasing batch
- ✅ **① PI import DONE** — Excel reconcile: all 15 Excel POs already present; 19 PIs were missing (PI-2604-019→037, OCEAN SKY, RM 7,258) → imported via a piNo-override on the PI POST (commit `95bfd036`), preserving original numbers + status APPROVED + supplier Inv#/DO# + items. Verified live (19/19 present+APPROVED, line counts + amounts match Excel). Total PIs 592→611.
- **② J cleanup** — delete ~1665 pre-1-Apr docs (PO 555 / GRN 555 / PI 555): (a) docs only, or (b) docs + their stock batches + cost ledger? Destructive → needs a one-time script (option-A lock blocks normal delete). Snapshot first.
- **③ GRN no-draft** — imports-in-transit use the arrival pipeline (Planning→Arrived) instead of Draft; local goods → direct create + post. OK?

### ✅ Effective-dated supplier pricing + Price Change Log + Supplier Quotation PDF (G/H) — shipped main `ba306a41` (effective_from, append-only price_histories, PDF matches Customer Quotation).

### ✅ Purchasing create: no-draft (PO/PI) + supplier reference numbers — shipped main `8374fc6d`
- ✅ **PART 1 — no-Draft on manual create** (owner: manual → active; only OCR → Draft, like SO).
  - **PO create** (`procurement/create.tsx`): button "Save as Draft"→"Create Purchase Order";
    payload sends `status: "CONFIRMED"` (POST takes body.status verbatim, else DRAFT). Split-by-Supplier
    groups also CONFIRMED. Summary hint → "Status will be set to CONFIRMED". PO has no OCR path.
  - **PI create** (`procurement/pi/create.tsx`): manual → `PENDING_APPROVAL` (first non-DRAFT in
    purchase-invoices.ts VALID_TRANSITIONS); OCR/scan (`?scan=1` deep-link OR in-form Scan modal's
    applyOcr) flips `ocrUsed`→DRAFT. Button "Create Invoice" unchanged. Convert-from-GRN/PO prefill =
    PENDING_APPROVAL (operator-initiated, not OCR). Convert chain (line guard + grnItemId increment)
    unaffected — status-independent.
- ✅ **PART 2 — supplier reference numbers** (snake_case + runtime self-apply + migration file + SQLite mirror):
  - `grns.supplier_do_no` (ensureGrnMigrations); `purchase_invoices.supplier_do_no` +
    `purchase_invoices.supplier_invoice_no` (ensurePiMigrations). Migration files
    `migrations-postgres/0183` + `migrations/0105`.
  - FE: "Supplier DO No." on GRN create + GRN detail (inline edit via main PUT); "Supplier Invoice No."
    + "Supplier DO No." on PI create + PI detail (edit-mode, DRAFT-only). Read dual-keyed. Persist
    through create + edit (GRN main PUT + PI PUT both extended).
- tsc clean (only 3 known jsbarcode/@zxing). `npm test` 1010 pass / 0 fail. **NOT pushed** (worktree commit only).

### 🔵 IN FLIGHT — parallel agents (owner: "全部做完，不要紧" + ultracode; review+test+confirm before prod)
- ✅ **Convert-chain backend foundation** — line-level invoice guard (partial/2nd PI ok, blocks over-draw) + per-line `availableQty` + `grn_item_id` link + **OPTION A** (owner: received/POSTED GRN LOCKED from delete+un-post → no stock-reversal hole). 17 tests. Shipped main `97a69de6`; **verified live** (DELETE posted GRN → 409). postGRNToStock untouched.
- ✅ **P2 convert UX** — `convert-from-po-modal` (GRN) + `convert-to-pi-modal` (PI, GRN+PO tabs, carries grnItemId); picks show availableQty + clamp ≤ available; GRN "From PO|Manual" toggle DROPPED (manual default + PO-linked banner). Shipped main `77ed0013`; verified live (availableQty + grn item id exposed). 1010 tests.
- ⚪ **P3 multi-source** — multi-GRN→1 PI is close (per-line grnItemId already supports it; needs picker UI). **多PO→1 GRN needs SCHEMA** (grns.poId single-column → per-line PO source) = high-risk, own branch.
- ⚪ **P4 PI→COGS cascade** — highest-risk cost cascade; own branch + owner buy-in.
- ✅ **Supplier Price History → PO view + filter/sort** — shipped `774ed7ff` (suppliers/detail.tsx).
- ✅ **GRN arrival DO-parity** — Planning rename + forward jumps (FE+BE) + DO tab layout. Shipped `dc6a880a`.
- ✅ **Price Comparison multi-select + cross-material** — multi-select, A-vs-B table, badge legend, filter+sort. Shipped `e695c3c1`.
- **NEXT after backend lands:** P2 convert UX (Convert-from buttons + line-pick pickers, drop GRN Manual toggle), P3 multi-doc consolidation endpoints, P4 PI→COGS cascade.

- 🔵 **PURCHASING CONVERT-CHAIN ALIGNMENT (the big one, owner directive + 2990 ref)** — owner wants
  Hookka's PO→GRN→PI (+PO→PI) to match 2990: create & convert = SAME page; a top-right **"Convert from
  <upstream>"** button (GRN→From PO, PI→From Goods Receipt/PO) that PRE-FILLS; manual = blank default
  (NO "From PO|Manual" toggle); every add/delete line must cascade to INVENTORY. **High-risk (inventory
  cascade) → investigate→propose→confirm + isolated branch.** Study agent `a9320f47` reading 2990 fe+be
  + Hookka gap → will return a plan. This SUPERSEDES the earlier GRN "Manual (no PO)" toggle.
- ✅ **PI/GRN/PO line-picker dropdown clip FIXED** — MaterialPicker dropdown was absolute → clipped by
  the rounded `overflow-hidden` items-table wrapper (owner: "drop down 还没展开完"). Portaled to <body>
  (fixed pos, scroll/resize tracked). tsc+tests, shipped `1dc8e361`.
- ✅ **Supplier Batch Edit** (task #54 follow-up) — upgraded grid Batch Edit to sofa-combos pattern:
  useConfirm + 4 fields (payment terms / company / status / rating). Agent `cc0e3fa3`, cherry-picked, shipped `2cbade89`.
- ✅ **Supplier Quotation PDF** — found ALREADY built (`generate-supplier-quotation-pdf.ts` + button on
  supplier detail, shared letterhead). Parked item was stale; nothing to do.
- ✅ **Purchasing Phase D — lineage SmartButtons** — new `PurchaseLineageBar` on PO/GRN/PI detail
  (PO→GRN→PI clickable, counts, client-side derived, read-only). Agent `c91834df`, cherry-picked, shipped `2cbade89`.
- ✅ **GRN list: arrival chips fixed + explicit From PO entry** — (1) arrival filter chips were
  misaligned (dot used `<Badge variant=status>` which renders the status TEXT in a 6px dot →
  overflow/overlap); swapped for a plain `getStatusColor(state).hex` dot. (2) Header only showed
  "Create GRN" though create.tsx already defaults to PO mode → added explicit **From PO / Manual
  Receipt (`?manual=1`) / Scan GRN**. tsc clean, shipped `5bcbbcd3`, **verified live** (chips clean,
  3 buttons present). Found via owner screenshot; fixed via NAVIGATION-MAP (Procurement module).

## 2026-06-20

- ✅ **CoE / Dev-Efficiency System built** — the "big plan" ([DEV-EFFICIENCY-SYSTEM.md](DEV-EFFICIENCY-SYSTEM.md)):
  Layer 4 **Navigation** = [NAVIGATION-MAP.md](context-packs/NAVIGATION-MAP.md) (**15 modules = full system
  coverage**, line-range index for ~30 monster files, spot-verified); Layer 5 **Methodology** = [PLAYBOOKS.md](PLAYBOOKS.md)
  (8 procedures); 9 Codex docs tailored; DOCS-INDEX surfaces all. **Still optional:** light docs reorg
  (merge UI-DATA-DOCUMENT-STANDARDS→UI-CONVENTIONS), Data-dictionary/glossary, ERD map, Test-selection matrix.
- ✅ **#3 / GRN read-bug fix** — dual-key read for snake_case cols folded to camelCase by
  `toCamel`. Shipped `cdfcae69`. **VERIFIED LIVE 2026-06-20:** create→read→delete round-trip on
  prod (`PO-2606-006` throwaway) → `materialCode` stored as "VERIFY-CODE-001" and **read back
  correctly** (was "" before the fix), name clean, deleted 200. GRN arrival reads dual-keyed too.
- ✅ **Employees summary stale-on-date FIX** (task #55) — wired all 6 date-bearing tabs
  (handleSummaryDateChange + onDateChange prop on Efficiency/Dept-Labor/Employee-Detail/
  Dept-Performance/Labor-Cost). Done myself via NAVIGATION-MAP (read ~250 lines not 10,951).
  tsc clean, shipped `4157cf88`, verified-live (renders clean). **SWEEP DONE (2026-06-21, CLEAN):**
  audited dashboard-b month switcher, reports, daily-report, analytics, ~10 accounting date-tabs,
  planning — all correctly put the date in the URL/deps → react. **Employees was the only real
  instance.** 2 minor non-same-class notes: reports.tsx "Generate" gate (change-date-forget-to-click
  → stale display, intentional UX); accounting AR cards mount-once (no date picker). **Task #55 DONE.**
- ✅ **Supplier Pricing → Supplier merge** (task #54) — cherry-picked `5064505c` onto main
  ([Suppliers | Price Comparison] tabs in maintenance.tsx; supplier detail [Pricing & SKUs |
  Price History]; nav "Suppliers"→maintenance; `/procurement/pricing` redirects). Reviewed diff:
  ComparisonTab was PORTED from pricing.tsx → **deleted the now-dead pricing.tsx** so there's one
  comparison surface (no drift). tsc clean. Shipped `b3b42b6c`. **TODO left: verify-live.**
- ✅ **Dev Operating Framework + Work Tracker** — this doc set + the 快准省 / review-
  discipline answer + durable tracking cadence. Committed.
- ✅ **Codex docs read + efficiency framework adopted** — read all context-packs +
  LLM-CONTEXT-STRATEGY + AI-DEVELOPMENT-MODES; saved smallest-mode discipline to memory.

## Parked — needs owner one-line confirm (from 2026-06-18 queue)

- 🟡 Supplier inline **Batch Edit** in grid (scope ambiguous).
- 🟡 Supplier **quotation export / print** (scope ambiguous).
- 🟡 Purchasing **Phase D** — document-flow lineage / SmartButtons (deferred).
