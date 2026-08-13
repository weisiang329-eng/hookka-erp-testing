# Hookka ERP — Task Playbooks (the methodology)

> **Last verified: 2026-08-13** against `src/lib/utils.ts` (`roundSen`,
> `distributeRoundSen`, `roundUpToRinggitSen`, `formatRM`), `src/lib/pdf-utils.ts`
> (`drawLetterhead` L55, `drawSectionLabel` L134, `tableTheme` L152, `drawDocFooter` L190,
> `splitCodeName` L260), `src/components/ui/` (`money-input`, `discount-input`, `data-grid`),
> `wrangler.toml` (`APP_URL = https://erp.hookka.com`), and a full `npm test` run.
> Corrected 2026-08-13: the root-level HOOKKA-GOTCHAS link was broken (the file is at
> `docs/context-packs/HOOKKA-GOTCHAS.md`) and the P3 test count was 4× stale.

Fixed step-by-step procedures for recurring dev tasks. **Pick the playbook, follow the
steps — don't re-derive the approach each time.** Each cites the exact files/helpers.
Pair with `docs/CODEBASE-MAP.md` (where the code is) and
`docs/context-packs/HOOKKA-GOTCHAS.md` (the traps).

---

## P1 — Add a new field/column end-to-end
*When: a doc/entity needs a new stored field (e.g. `discount_sen`, `material_code`).*
1. **Name it snake_case** — avoids the rename-map 400 trap.
2. **Migration file** (record + SQLite test mirror): add `migrations-postgres/NNNN_*.sql`.
3. **⚠️ Runtime self-apply (THE load-bearing step):** add `ALTER TABLE x ADD COLUMN IF NOT EXISTS col TYPE` into the route's `ensurePendingMigrations` / `ensureXMigrations` block, awaited at the TOP of the POST/PUT handler **before the first write**. A migration file alone is **inert on prod**.
4. **Write:** add the column + its bind in the INSERT/UPDATE (snake_case passes through the compat layer untouched).
5. **Read:** in `rowToX`, dual-key it — `r.camelCase ?? r.snake_case ?? default` (result rows are `toCamel`'d). Add the key to the row TYPE.
6. **Frontend:** add the input cell (`MoneyInput` money / `DiscountInput` % / else text-number) + the field on the FE type.
7. **List / PDF** if surfaced: add the `DataGrid` column / the PDF field.
8. **Ship:** P3.
*Refs: `HOOKKA-GOTCHAS.md`, `sales-orders.ts` ensurePendingMigrations, `column-rename-map.json`.*

## P2 — Fix a "reads back blank/undefined" (camelCase) bug
*Symptom: a stored field shows empty on read but the write looked fine (200/201).*
1. Confirm the DB actually has the value (it usually does — the write passed through).
2. Open `rowToX`: the read is `r.snake_case`, but the row is `toCamel`'d → `undefined`.
3. Fix: `r.camelCase ?? r.snake_case ?? default`; add the camelCase key to the row type.
4. tsc + test + ship; **verify the read path live**.
*Refs: commit `cdfcae69` (PO `material_code` + GRN arrival), `HOOKKA-GOTCHAS.md`.*

## P3 — Ship + verify a change
1. `npx tsc -p tsconfig.app.json --noEmit` — **measured 2026-08-13 on a clean `npm install`: exit 0, ZERO errors.** The long-standing "ignore the 3 known jsbarcode / @zxing sandbox errors" instruction no longer applies here; if you see errors, they are yours.
2. `npm test` — **3,768 tests / 3,765 pass / 3 skip / 0 fail, ~45 s** (measured 2026-08-13 on `main`). Any failure is yours; this suite is green on `main`.
3. Commit on a branch (feature) or `main` (bugfix); `git pull --rebase origin main`; push.
4. Watch: `gh run watch <id> --exit-status`.
5. **Verify-live** on erp.hookka.com — check the **READ and the WRITE** path (patch → refetch → confirm). Deploy exit 0 ≠ feature works.
6. Bug? → append `docs/BUG-HISTORY.md`. Always → update `docs/WORK-TRACKER.md`.
*Refs: `HOOKKA-GOTCHAS.md` (build/ship), memory verify-live.*

## P4 — Money field
Store **sen integer** (RM×100). Input via `MoneyInput` (value `number|null` in RM, commits on blur); `%` discounts via `DiscountInput`. Round only through `roundSen` / `distributeRoundSen` (`src/lib/utils.ts`). Never float RM. Display right-aligned + `tabular-nums`, via `formatRM`.
*Refs: `arch_ui_primitives_0619`, `UI-DATA-DOCUMENT-STANDARDS.md`.*

## P5 — Fix one → sweep the whole system (fix-then-audit)
*When fixing a data bug/inconsistency for ONE case:*
1. Grep EVERY site touching the pattern (helpers / routes / pages / validation / cascades) — use `CODEBASE-MAP.md` to find them.
2. List authoritative vs stale; state explicitly what you are NOT touching.
3. Fix all instances of the same class, not just the flagged one — **the classes and their known instances are indexed in [`BUG-CLASSES.md`](BUG-CLASSES.md); this step is not doable from memory, which is why it kept being skipped.**
4. Any input-reject rule must fail at BOTH the FE Save handler AND the backend POST/PUT with the same error.
*Refs: memory fix-then-audit, scan-module-before-edit, validation-unified.*

## P6 — New list grid + filters
Use `DataGrid` (don't hand-roll a table): stable `gridId` + `keyField` (a DB id, never array index); column `key`/`label`/`width`/`type` (`docno`/`date`/`currency`/`number`/`status`); `sortAccessor`/`filterAccessor` for computed cells; `FilterBar` for page search; clear `emptyMessage`. Sort money by sen and dates by ISO — never by formatted text. **If the grid feeds a Print Report, wire `onFilteredDataChange` so print follows the on-screen filter/sort.**
*Refs: `UI-DATA-DOCUMENT-STANDARDS.md`, `data-grid.tsx`, `arch_report_print_engine`.*

## P7 — New PDF / printout
Never hand-roll header/footer/fonts. Use the shared helpers in `src/lib/pdf-utils.ts`: `drawLetterhead`, `drawSectionLabel`, `tableTheme`, `drawDocFooter`. Code-in-name docs (PO) split with `splitCodeName`; sales-side docs have a real code field. Money via `formatRM`. Sister companies pass `logo:false`.
*Refs: `arch_letterhead_unified`, `pdf-utils.ts`.*

## P8 — Touching a monster file (10k-line page)
1. Open `CODEBASE-MAP.md`, find the file's **section index**, jump to the line range — never read end-to-end.
2. These pages branch on `activeTab` / `viewMode`; confirm WHICH code path your change is in (one tab ≠ all).
3. Keep denormalized snapshots in sync if you change a write (`*_list_snapshot` tables).
*Refs: `CODEBASE-MAP.md`.*
