# Docs vs Code — prose audit

> **Last verified: 2026-08-14** against `docs/context-packs/HOOKKA-GOTCHAS.md`,
> `docs/BUG-CLASSES.md`, `docs/DEV-OPERATING-FRAMEWORK.md`, `docs/PLAYBOOKS.md`,
> `docs/CODEBASE-MAP.md`, `CLAUDE.md`, `docs/API.md`, `docs/BUG-HISTORY.md` (all 576 entries)
> — and, on the code side, `src/api/routes/attendance.ts`, `worker.ts`,
> `working-hour-entries.ts`, `scheduling.ts`, `products.ts`, `bom.ts`,
> `production-orders.ts`, `import-completion/{_shared,completion-cascades,wip-fixes,sofa-pricing}.ts`,
> `src/lib/{utils,production-order-builder,app-origin,api-client,delivery-pipeline}.ts`,
> `src/api/lib/{db-pg,column-rename-map.json,efficiency-report,compliance-report,ensure-kpi-tables}.ts`,
> `src/pages/employees.tsx`, `src/api/routes/fg-units.ts`, plus `git ls-files`, `wc -l`,
> a full `npm test` run and `node scripts/gen-api-docs.mjs`.

## Why this file exists

> 「我的文档跟权威的代码不一样也是个问题」

**The source code is the authority. A doc that contradicts it is worse than a missing doc** —
a gap makes someone go look, a confident wrong claim makes them act on it.

Three mechanical gates already exist and are **not** re-done here:
`check-codebase-map.mjs` (paths / `file:LINE` / symbol anchors — **`docs/CODEBASE-MAP.md`
only**), `check-docs-freshness.mjs` (stamps, duplicate bug ids), `gen-api-docs.mjs --check`
(API.md is generated). This audit is the layer none of them reach: **prose that asserts
behaviour**.

**Scope.** The 80 live docs under `docs/` (excluding `docs/archive/`) plus `CLAUDE.md`.
`docs/BUG-HISTORY.md` is an **append-only ledger** — a dated entry describing what was true
then is correct history, not a stale claim; only header/body status contradictions were
looked for there.

**Standard of proof.** Every row below was verified by opening the file and reading the logic.
Where a claim needed enumeration (who writes a column) `node scripts/who-writes.mjs` was run
and both spellings plus the literal value were searched. **No claim about live production
state appears in this file** — this session had no DB credentials, so anything needing live
data is marked UNMEASURED.

---

## Contradictions found and FIXED

| # | Doc + line | The claim | What the code actually does | Sev | Fix applied |
|---|---|---|---|---|---|
| **D1** | `docs/context-packs/HOOKKA-GOTCHAS.md` (standard-time table, `attendance_records` row) | *"`attendance_records.production_time_minutes` … `= working_minutes × 0.85` … `attendance.ts:332` — a hardcoded constant. `efficiencyPct` and `deptBreakdown` on that row derive from it"* | **Nothing writes it.** `attendance.ts:332` is the `DELETE /:id` handler. All three writers — `attendance.ts:461`, `worker.ts:1151`, `working-hour-entries.ts:117` — **omit the column from their INSERT column list**, and `rowToAttendance` (`attendance.ts:200-205`) returns `productionTimeMinutes: null`, `efficiencyPct: null`, `deptBreakdown: []` without reading the row. `0.85` survives in `src/api` at exactly one place, `scheduling.ts:291`, as a *labelled planning assumption*. Migration `0227` dropped the NOT NULL + DEFAULT so "not measured" is expressible. | **HIGH** | Row rewritten to state NULL + the three omitting INSERTs, with the ×0.85 kept as explicitly-labelled history. The doc's own next paragraph already said the writer was removed — **the table and the paragraph five lines below it contradicted each other.** |
| **D2** | same doc, same table | source proof cites **`production-builder.ts:890/893`** | **That path has never existed.** The two files that do are `src/api/routes/_shared/production-builder.ts` (1,029 lines — no such bind) and **`src/lib/production-order-builder.ts:183/186`**, which is the real site: `estMinutes: p.minutes` / `productionTimeMinutes: p.minutes`. | med | Corrected to `src/lib/production-order-builder.ts:183/186`. |
| **D3** | same doc | `import-completion/_shared.ts:464` / `:468`; `completion-cascades.ts:413,838`; `wip-fixes.ts:112,445`; `employees.tsx:4217` | The claims all still hold, at `_shared.ts:493`, `completion-cascades.ts:424,858`, `wip-fixes.ts:116,456`, `employees.tsx:4241`. | low | Line refs re-derived. **No gate covers this doc** — see D16. |
| **D4** | `docs/DEV-OPERATING-FRAMEWORK.md` "Don't re-derive what's already mapped" | *"`docs/context-packs/HOOKKA-GOTCHAS.md` (**corrected 2026-08-13** — it is not at `docs/context-packs/HOOKKA-GOTCHAS.md`)"* | The file **is** at `docs/context-packs/HOOKKA-GOTCHAS.md`. A 2026-08-13 correction was applied to both halves of the sentence, leaving it asserting the file is not where it is. | med | Sentence repaired; the correction note kept, describing what actually happened. |
| **D5** | same doc, guardrail 1 + header | *"375 test files carrying ~3,700 `test(`/`it(` cases"* | **410** `tests/*.test.mjs`; `npm test` = **4,123 tests / 4,120 pass / 3 skip / 0 fail** (measured 2026-08-14 on this branch, including the 4 added here). Wall-clock is NOT stable — 33 s idle vs 208 s with four agents running — so it should not be quoted at all. | low | Re-measured, with a note that the figure moves every few days — re-measure rather than quote. |
| **D6** | same doc, high-risk table | Status-lifecycle key files: *"`document-lifecycle.ts`, `delivery-pipeline.ts`"* | `document-lifecycle.ts` is at `src/api/lib/`; **`delivery-pipeline.ts` is at `src/lib/`**, because it is shared with the frontend (`src/pages/delivery/index.tsx:60` imports it as `@/lib/delivery-pipeline`). This doc's own header records fixing the same bare-filename trap for `column-rename-map.json`. | low | Both paths spelled out. |
| **D7** | `docs/PLAYBOOKS.md` P3 step 2 | *"`npm test` — 3,768 tests / 3,765 pass / 3 skip / 0 fail, **~45 s**"* | 4,123 tests. The wall-clock claim is the worse half: measured **33 s idle and 208 s under concurrent load** in this one session, so "~45 s" is a best case presented as a constant, and a reader budgeting it concludes the run has hung. | med | Re-measured; "budget minutes, not seconds" added. |
| **D8** | `docs/CODEBASE-MAP.md` Sales table + "Start here" | *"`src/api/routes/sales-orders.ts` — **5318** lines"*, twice | **5,704** lines (+ `sales-orders/_helpers.ts`, 1,462). **This same doc's header names 5,318 as the stale figure it corrected** — the correction never reached the two places that carry the number. | med | Both sites updated, with the `_helpers.ts` sibling named. |
| **D9** | `docs/CODEBASE-MAP.md` Planning section | *"NOTE: **7606-line** route … — **L1-7606**"* for `production-orders.ts` | The file is **3,944** lines; 7,606 is its **pre-split** length. The range ran ~3,600 lines past EOF — precisely the "anchor above the real length pointed past end-of-file" failure the same doc's header warns about. `check-codebase-map.mjs` does not catch it because `L1-7606` is prose, not `file.ts:123`. | **HIGH** | Corrected to 3,944 + a pointer to `production-orders/_helpers.ts` (5,882), and the old figure recorded as the trap it was. |
| **D10** | `docs/CODEBASE-MAP.md` header split table | *"Actually **3,010** / **3,903** / **5,626**"* and helpers *"5,254 / 5,799 / 1,452"* | `wc -l` 2026-08-14: **3,095 / 3,944 / 5,704**, helpers **5,313 / 5,882 / 1,462**. | low | Re-derived and the column re-titled with the measurement date. |
| **D11** | `docs/CODEBASE-MAP.md` intro | *"Formerly `docs/CODEBASE-MAP.md`. Retired duplicates now pointing here: `docs/CODEBASE-MAP.md`"* | This file **is** `docs/CODEBASE-MAP.md`. A rename left it naming itself as both its former name and a retired duplicate of itself. | low | Rewritten; the artefact recorded. |
| **D12** | `docs/BUG-CLASSES.md` C20 row 3 | `job_cards.actual_minutes` *"exists but measures nothing … ⬜ **open, and it is the NEXT one**"* | `docs/context-packs/HOOKKA-GOTCHAS.md`, **corrected by the owner on 2026-08-14**, says the opposite: Hookka runs **standard costing**, the BOM time IS the production hours, elapsed start→end duration is deliberately not computed, so `actual_minutes = est_minutes` is correct and intended — *"Do not 'fix' it."* **Two required-reading docs ordered opposite actions on one column.** | **HIGH** | Row closed as ❌ not-a-defect with the owner's ruling quoted and a link to GOTCHAS; a **scope box** added at the top of C20 so the class cannot re-swallow the costing model. Guarded by `tests/docs-required-reading-truth.test.mjs`. |
| **D13** | `docs/BUG-CLASSES.md` C20 "How it hides" #2 | *"`job_cards.actual_minutes` is non-null on 4,289 rows … Populated, plausible, and carrying no information"*, framed as the trap | The row count is a **dated historical measurement** and is fine as history, but it carried no date and no UNMEASURED marker, and its verdict contradicted D12's ruling. | med | Dated, marked UNMEASURED-since, and the verdict separated from the (still-correct) technique: *keep the technique, drop the verdict*. |
| **D14** | `CLAUDE.md` §5 | *"(139 mounts, **935** handlers …)"*; and API.md described as trustworthy | The generator reports **139 mounts / 936 handlers / 1 unmounted route file**. Worse: **`docs/API.md` was STALE on `main`** (`gen-api-docs.mjs --check` → *"docs/API.md is stale"*), and the committed copy carried **four duplicated mount rows** (`/api/workers`, `/api/worker-auth`, `/api/announcements`, `/api/worker`) listing **two different line sets for the same handlers**. | med | Count corrected; API.md **regenerated** (the duplicate rows are gone); a "run `--check` before trusting it" warning added. |
| **D15** | `CLAUDE.md` intro | *"they TIME OUT on this repo's size (**~1,600** tracked files)"* | `git ls-files \| wc -l` = **2,122**. | low | Re-measured. |
| **D16** | *(gap, not a single doc)* | `check-codebase-map.mjs` is described as the guard for doc pointers | Its `const MAP = "docs/CODEBASE-MAP.md"` means the **other four required-reading docs had no pointer gate at all** — which is why D2 (a path that never existed) survived. | med | New `tests/docs-required-reading-truth.test.mjs` extends path + `file:LINE` checking to `CLAUDE.md`, `PLAYBOOKS.md`, `HOOKKA-GOTCHAS.md`, `DEV-OPERATING-FRAMEWORK.md`, `BUG-CLASSES.md`, and pins D1 and D12 to the code. |

---

## Checked and CONFIRMED STILL TRUE

Recorded so the next reader does not re-derive them.

- **`docs/BUG-HISTORY.md` — all 576 entries scanned for header/body status contradictions:
  ZERO.** Every entry whose header carries a 🔴/🟡/🟢 agrees with the status line in its body.
  (The one instance of this shape, BUG-2026-07-17-002, was fixed earlier the same day.)
  Entries that carry no header emoji state their status as `🟢 Fixed`/`🟡 …` on the first body
  line instead — a style variation, not a contradiction.
- **GOTCHAS: the CSRF claim.** `src/lib/api-client.ts:33,76` really does replace
  `window.fetch` globally. An audit flagging "N fetches missing the CSRF token" is all false
  positives, as stated.
- **GOTCHAS: the duplicate rename-map key.** `column-rename-map.json:819-820` maps **both**
  `"supplierSKU"` and `"supplierSku"` to `supplier_sku`, and `db-pg.ts:52-57` builds
  `snakeToCamel` with `Object.fromEntries`, which keeps the **last** duplicate — so `SELECT *`
  really does deliver `supplierSku` only. *(The doc says lines 815-816; the pair is now at
  819-820 — line drift only, claim intact.)*
- **GOTCHAS: bedframe `sizeCode` is REQUIRED.** `products.ts:601-612` (POST) and `:813-820`
  (PUT) both `return … 400` when category is `BEDFRAME` and `sizeCode` is blank.
- **GOTCHAS: the whole-ringgit round-up.** `roundUpToRinggitSen` is at `src/lib/utils.ts:270`,
  beside `roundSen` (`:244`) and `distributeRoundSen` (`:292`);
  `tests/whole-ringgit-unit-price.test.mjs` exists.
- **GOTCHAS: sofa-combo give-the-excess-back.** `distributeComboUnitPrices` is called by
  `sofa-combo-pass.ts`, `sofa-pricing.ts` **and** `src/pages/sales/create.tsx` — one function,
  both sides, as claimed. `/recompute-so-sofa-prices` (`sofa-pricing.ts:689`) and
  `/recompute-co-sofa-prices` (`:1228`) both exist.
- **GOTCHAS: `canonicalizeOrigin` / `appOrigin`** are at `src/lib/app-origin.ts:28` / `:42`,
  exactly as cited; `packing-rack-write.ts`, `packing-piece-identity.ts` and
  `public-rack-qr.ts` all exist.
- **BUG-CLASSES: every `tests/*.test.mjs` path it cites exists** — 0 missing, checked
  mechanically over the whole file.
- **BUG-CLASSES C15 row 34** (`kpi_periods` *"has no writer anywhere"*): `who-writes.mjs`
  finds exactly one hit in the whole tree, the `CREATE TABLE IF NOT EXISTS` at
  `src/api/lib/ensure-kpi-tables.ts:40`. No INSERT, no UPDATE. **Still open, correctly.**
- **BUG-CLASSES C15 row 31** (attendance % is *"100.0% by construction"*): all three
  `INSERT INTO attendance_records` sites bind the **literal `'PRESENT'`**
  (`attendance.ts:465`, `worker.ts:1155`, `working-hour-entries.ts:121`), and the only
  `'ABSENT'` in `src/api` is a *derived display value* in `efficiency-report.ts:304`, not a
  write. **Still open, correctly.**
- **CLAUDE.md / GOTCHAS / PLAYBOOKS: `build:strict` is clean.**
  `npx tsc -p tsconfig.app.json --noEmit` → exit 0, zero errors. The retired
  "ignore 3 jsbarcode/@zxing errors" carve-out still does not reproduce.
- **PLAYBOOKS P4/P7 primitives** all exist at the named paths: `roundSen`,
  `distributeRoundSen`, `formatRM`, `drawLetterhead`, `drawSectionLabel`, `tableTheme`,
  `drawDocFooter`, `splitCodeName`, `money-input`, `discount-input`, `data-grid`.
- **DEV-OPERATING-FRAMEWORK's mode names** match `docs/AI-DEVELOPMENT-MODES.md`:
  Fast lane / Focused change / Flow change / Deep review.

---

## COLLECTED — judgement calls, NOT decided here

Per the owner's standing rule, a judgement call gets asked, not decided.

- **J1 — the unstamped prod figures in HOOKKA-GOTCHAS.** The standard-costing section states
  *"That is exactly what Employees → Department Performance computes **(80%)**"* and *"The
  daily spread on this figure **(101 / 71 / 84 / 76 / 80)** is real signal"*. These are claims
  about live production data with **no measurement date and no UNMEASURED marker**, in the doc
  that sits directly under `CLAUDE.md`'s rule that *"any claim about the CURRENT state of
  production is either MEASURED, or it carries the word UNMEASURED. No third option."* They
  were almost certainly measured when written and they carry real meaning (they are the
  owner's evidence that >100% is normal). **Left untouched.** Should they be date-stamped in
  place, or moved into a dated note? This session had no DB access and cannot re-measure them.
- **J2 — `scheduling.ts:291` `const EFFICIENCY = 0.85`.** Now the only `0.85` left in
  `src/api`. Its own comment says it is a labelled planning assumption, that
  `GET /api/scheduling/capacity` **is consumed by nothing today**, and that *"whether to delete
  it is in the PR's owner-decision list"*. Still undeleted, still unconsumed. Delete, or keep
  as a documented assumption? Not a defect either way — but a live `× 0.85` in a codebase that
  just removed one for fabricating data is a trap for the next reader.
- **J3 — three modes or four?** `DEV-OPERATING-FRAMEWORK.md` cites four risk tiers
  (Fast lane / Focused / Flow / Deep) from `AI-DEVELOPMENT-MODES.md`, then its own decision
  section is headed *"FAST vs FOCUSED vs DEEP"* and documents only three — **Flow change has
  no entry**. Add Flow to the framework, or drop it from the citation? Both docs are internally
  coherent; they just disagree on the count.
- **J4 — `TaskCreate`/`TaskUpdate`.** `DEV-OPERATING-FRAMEWORK.md` already flags this as an
  *"UNVERIFIED ASSERTION"*: the tool names depend on the agent harness and are not checkable
  from this repo. Re-checked 2026-08-14 — **still not checkable from the repo.** Keep the
  honest flag, or drop the tool names and keep only the intent?

---

## How to keep this file honest

1. `node scripts/check-codebase-map.mjs` — the map's pointers.
2. `node scripts/check-docs-freshness.mjs` — stamps + duplicate bug ids.
3. `node scripts/gen-api-docs.mjs --check` — API.md.
4. **`npm test -- tests/docs-required-reading-truth.test.mjs`** (new) — pointers in the other
   four required-reading docs, plus the two claims above that no path check can express.

None of the four can read a sentence. **The prose layer is still audited by a human opening
the file** — which is what produced every row above.

---

## Part 2 — the wider sweep (module, infra, process and audit docs)

Same standard of proof: every row was re-read against the source before the fix was applied.
Severity is "what a reader who believed it would do".

### 2a — Operations / disaster recovery (the ones that fail when it matters)

| # | Doc | The claim | What the code actually does | Sev | Fixed |
|---|---|---|---|---|---|
| **D17** | `docs/DR-RUNBOOK.md` (secrets list, ×2 + drill table) | provision `SUPABASE_PROD_URL` and `SUPABASE_SERVICE_ROLE_KEY` | **Neither secret name exists in any of the 26 workflows.** `backup.yml:78,94` reads `secrets.PROD_DATABASE_URL`; `:80,121,158` read `secrets.SUPABASE_SERVICE_KEY`; its own guard at `:83-85` errors on exactly those two names. (`SUPABASE_SERVICE_ROLE_KEY` is only the *step-local env var* the workflow maps the real secret onto.) `runbooks/ROTATE-DB-PASSWORDS.md:75` had it right — **the two docs disagreed.** An operator provisioning from this runbook gets a backup job that hard-fails at step 2, silently, until a restore is needed. | **HIGH** | ✅ both names corrected, with the env-var-vs-secret distinction spelled out |
| **D18** | `docs/DR-RUNBOOK.md` (restore procedure, both copies) | download `backup-YYYY-MM-DD.dump`, then `pg_restore ./recovery.dump` | The dump is uploaded **SPLIT**: `backup.yml:125` runs `split -b 40M`, and the objects are `backup-<date>.dump.part-000/-001/…` plus a `.manifest` (the single-object endpoint 413'd on the ~400 MB dump). `backup.yml:167-169` states the whole object **is never uploaded and asking for it would 404**. The runbook's `grep -oE '"backup-[0-9-]+\.dump"'` requires a closing quote and therefore matches **zero** part files — `LATEST` comes back empty and the download 404s, in the middle of an outage. | **HIGH** | ✅ reassembly path (`cat …part-* > recovery.dump`) documented in both copies |
| **D19** | `docs/DR-RUNBOOK.md` | the workflow installs `postgresql-client-16`; *"Postgres 16 matches Supabase's current major version"* | `backup.yml:59-68` installs **`postgresql-client-17`** from PGDG, because Supabase runs 17.6 and `pg_dump` **refuses** to dump a newer server. A manual pre-migration snapshot taken per the doc produces **no dump at all**. | **HIGH** | ✅ corrected, incl. the pg_wrapper `$PATH` trap |
| **D20** | `docs/PERF-BACKLOG.md` | *"GitHub Actions is billing-blocked — **private repo** … Do NOT 'solve' this by making the repo public"* | The repo **is already public** — `runbooks/ROTATE-DB-PASSWORDS.md:51` says so and instructs treating both DB passwords as *already disclosed*; `ios-build.yml:14` and `secret-hygiene.yml:11-14` describe it as public in the present tense; `deploy.yml` and `refresh-bundle-baseline.yml` both fire on `main`. **A reader trusting this concludes the credentials are still contained.** | **HIGH** | ✅ rewritten — rotation is outstanding *remediation*, not hygiene |
| **D21** | `docs/runbooks/ROTATE-DB-PASSWORDS.md` | the rotation surface is "FOUR places" | A **third, separately-named** GitHub secret holds a prod DSN: `deploy.yml:369` `DATABASE_URL: ${{ secrets.DATABASE_URL }}`, feeding `scripts/check-schema-applied.mjs`. That script **soft-skips with only a `::warning::`** when unset, so a missed rotation degrades the schema-drift guard silently rather than failing. | **HIGH** | ⚠️ **RECORDED, NOT EDITED** — see the note below |
| **D22** | `docs/PERF-BACKLOG.md` bundle bullet | *"`check-bundle-size.mjs` FAILS on main … baseline not regenerated"* | `.bundle-baseline.json` already carries `finance-dashboard: 31684` and is **auto-regenerated and committed on every push to `main`** (`refresh-bundle-baseline.yml:26`). A stale "CI is red" claim costs triage and invites hand-editing a generated file. | med | ✅ |
| **D23** | `docs/PERF-BACKLOG.md` P13 / P11 / P10 | three items described as un-shipped or as current defects | P13 merged (#324 — `department-performance.ts:205` `view=summary` is present); P11's mobile home now reads `/api/delivery-orders/pending-value`; P10's `revenue × 0.65` COGS and the four hardcoded expense literals were replaced (`reports.tsx:1344-1352`). **Prod deploy state UNMEASURED.** | med | recorded (P13/P11/P10 rows re-read; see J8 for why the bulk edit was not made) |
| **D24** | `docs/PERF-BACKLOG.md` + `docs/UI-CONVENTIONS.md` | *"ignore only the 3 known jsbarcode / @zxing errors"* | **MEASURED: `npx tsc -p tsconfig.app.json --noEmit` → exit 0, zero errors.** `CLAUDE.md` retired this carve-out on 2026-08-13; these two docs kept it. A standing licence to ignore N errors is how a real one gets waved through. | med | ✅ both |
| **D25** | `docs/AUTH-OAUTH-SETUP.md:143` | re-calling `/enroll` *"returns only the QR"* | `auth-totp.ts:96-104` returns **HTTP 409** once `totpEnrolledAt` is set. A UI built to the doc ships a "re-show my QR" button that can only 409. | med | ✅ |
| **D26** | `docs/INFRA-RESILIENCE-PLAYBOOK.md:58` | "don't logout on transient failure" — ⬜ **not started** | The **backend half shipped**: `auth-middleware.ts:415-431` returns 503, not 401, on a session-verify DB error, under a comment saying a 401 *"would force-bounce an authenticated user to /login on a momentary DB blip"*. Only the frontend retry is missing. | med | ✅ row split |
| **D27** | `docs/OBSERVABILITY.md:116` | `cacheHitRatio` is a *"placeholder until we instrument cache hits"* | It is **real on the AE path** — `snapshot.ts:419,428` emit `cache.hit`/`cache.miss` and `admin-health.ts:331-348` computes the ratio over them. Placeholder only in the `_mock: true` branch. | med | ✅ |
| **D28** | `docs/SETUP.md:205` | add a font to `src/assets/fonts/…` and register it in `pdf-utils.ts` | **Neither exists.** `src/assets/` holds `hero.png`, `hookka-logo.png`, `vite.svg`; `pdf-utils.ts` has zero `addFont`/`addFileToVFS` calls and only ever calls `doc.setFont("helvetica", …)`. There is nothing to register into. | med | ✅ |

> **D21 is deliberately RECORDED rather than edited.** `docs/runbooks/ROTATE-DB-PASSWORDS.md`
> is a live security runbook mid-rotation. Adding a fourth credential to its checklist changes
> what the owner must do during an incident, and the rotation is his outstanding decision.
> **Owner: `deploy.yml:369` reads a separate `DATABASE_URL` secret that the runbook does not
> list; it needs rotating too, and `check-schema-applied.mjs` will only WARN — not fail — if it
> is missed.**

### 2b — Design system / UI conventions (documented safety nets that do not exist)

| # | Doc | The claim | What the code actually does | Sev | Fixed |
|---|---|---|---|---|---|
| **D29** | `docs/SETUP.md:150` + `docs/UI-CONVENTIONS.md:32` | adding a status value is *"enforced by the compiler"* / `StatusBadge` is *"compile-checked per enum"* | **Neither.** `status-badge.tsx:63` types the prop `value: string`, and `:81` does `(map as Record<string, SemanticStyle>)[value] ?? resolveUnknownStatus(...)` — the cast erases the union. And `design-tokens.ts:427` re-declares the union as an **inline literal**, importing nothing from `src/types/index.ts`, so step 1 cannot fail step 2. A new status ships as a **grey chip, no build error**. `ARCHITECTURE.md` and `DESIGN-SYSTEM.md` state it correctly — these two were the outliers. | **HIGH** | ✅ both |
| **D30** | `docs/DESIGN-SYSTEM.md:276` | `Button` has five CVA variants | **Seven** (`button.tsx:11-19`), including **`primary` = brand gold `#6B5C32`**. A dev reading the doc concludes no brand button exists and hand-rolls `bg-[#6B5C32]` — the exact anti-pattern the same doc bans. | **HIGH** | ✅ |
| **D31** | `docs/DESIGN-SYSTEM.md:383` | Card padding *"handled by `<Card>` variants"* | `card.tsx` has **no `variant` prop and no `cva`**. `p-4` is the responsive breakpoint: `max-md:p-4` baked into `CardHeader` (`:17`) and `CardContent` (`:38`). Contradicted this same doc's own correction ~100 lines above. | **HIGH** | ✅ |
| **D32** | `docs/DESIGN-SYSTEM.md:173` | *"`<PageHeader>` — Every route-level page uses this. **No exceptions.**"* | Record **detail** pages use `<ObjectPageHeader>` (`sales/detail.tsx:28,1096` imports it and never mentions `PageHeader`). Contradicted `UI-CONVENTIONS.md:26` and `UI-DATA-DOCUMENT-STANDARDS.md:107`. | **HIGH** | ✅ |
| **D33** | `docs/UI-DATA-DOCUMENT-STANDARDS.md:133` | all new PDF generators must call **`tableTheme`** | `tableTheme()` renders a **solid bronze header band** — the style the owner rejected (`pdf-utils.ts:94-96`: house standard is "no coloured accent bar"). Only **2 of 17** `generate-*-pdf.ts` call it; the two reference generators (`generate-do-pdf.ts`, `generate-invoice-pdf.ts`) do not import it at all. The doc mandated a rejected style for new **customer-facing** documents. | **HIGH** | ✅ |
| **D34** | `docs/ARCHITECTURE.md:387` | *"Three overlapping approaches coexist (`swr`, …)"* | `src/lib/swr-fetcher.ts` does not exist and nothing under `src/` imports `swr`; it survives only as an unused `package.json` entry. **Two** approaches. This doc says so correctly 200 lines earlier (`:175-180`). | low | ✅ |

### 2c — Module guides (`docs/modules/*.md`)

| # | Doc | The claim | What the code actually does | Sev | Fixed |
|---|---|---|---|---|---|
| **D35** | `docs/modules/inventory.md` (×2) | `finishedProducts.stockQty` is **hard-coded `0`** | It is **`null`**, deliberately (`inventory.ts:215-227`), under a 16-line comment: *"It used to be the literal `0`, which is a different claim … five screens printed that assertion as a measured on-hand quantity."* A reader trusting the doc writes `?? 0` and re-ships **BUG-2026-08-13-014**. | **HIGH** | ✅ |
| **D36** | `docs/modules/inventory.md:78` | fg-units *"the list/get support optional-Bearer public access"* | **Only `GET /:id` is public.** `auth-middleware.ts:125-128`: `FG_UNIT_PUBLIC_GET_RE = /^\/api\/fg-units\/[^/]+$/`, whose comment says *"only the single-unit GET is public … otherwise anyone on the internet can dump inventory or mutate unit status."* `GET /` calls `getOrgId(c)` and throws without a session. A security-posture claim, stated backwards. | **HIGH** | ✅ |
| **D37** | `docs/modules/accounting.md:102` | *"`cost_ledger` … Accounting reads only; **never** write it from these routes"* | `accounting.ts:10907` `POST /landed-cost` **UPDATEs `rm_batches.unitCostSen` and INSERTs an `ADJUSTMENT`/`LANDED_COST` row into `cost_ledger`** (`:10950`). It is the only such writer in the file — but it is real, and `/landed-cost` appears nowhere in the doc's route list. Money path. | **HIGH** | ✅ |
| **D38** | `docs/modules/delivery.md:10` | status machine is the linear `DRAFT → LOADED → IN_TRANSIT → DELIVERED → INVOICED` | `VALID_TRANSITIONS` (`delivery-orders/_helpers.ts:94-108`) adds **two non-linear edges on purpose**: CANCELLED from every live status, and **INVOICED → DELIVERED**. The comment above them records why: a DO past DRAFT *"used to be IMMORTAL"*, and a voided invoice simply **lost the revenue**. The doc omits exactly the two edges that exist because their absence caused those losses. | **HIGH** | ✅ |
| **D39** | `docs/modules/production.md:79` | office PATCH `/:id` at `production-orders.ts:8419` | The file is **3,944 lines** — `:8419` is the pre-split number, ~4,500 lines past EOF. The handler is at `:3813`. Same failure as **D9**, and it sits in the one gotcha warning against re-inlining the piece-identity formula. | med | ✅ |
| **D40** | `docs/modules/dashboard.md` (×4) | KV key `dashboard:overview:<org>:**v22**:<period>`; "bump the `v22` key" | `dashboard-overview.ts:145` is **`v23`**. `v22` appears nowhere in the file. The doc is the stated procedure for forcing a refresh — the key it gives will not be found. | med | ✅ |
| **D41** | `docs/modules/planning.md:82` (+ `:5` *"All three named tests exist"*) | verify with `tests/scheduling.test.mjs` | Deleted in `d157e997` (dead-code sweep). The scheduling engine's stated verification gate silently no-ops. | med | ✅ → `tests/scheduler-sent-lock.test.mjs` |
| **D42** | `docs/context-packs/database.md:3` | *"244 migration files, latest `0223_trade_finance.sql`"* | **251** files; newest prefix **`0229`, shared by TWO files** (`0229_pcb_tax_profile.sql`, `0229_worker_leave_entitlements.sql`). The stamp also hid the prefix collision. Same stale count in `INVENTORY-WIP-FLOW.md:20` and `ARCHITECTURE.md:64`. | med | ✅ all three |
| **D43** | 12 module guides | `worker.ts:NNNN` mount lines | **Every one off by exactly +1** — a line was inserted early in `src/api/worker.ts` after the 2026-08-13 stamp. Two landed on the wrong thing: `rnd.md`'s `:1379` is `qc-inspections`, `reports.md`'s `:1430` is an `import`. `employees.md` additionally cited `routes/worker.ts:147 / 1025 / 1288` for `getWorker` / `/clock` / `/dept-scan`; the real lines are `:160 / 1045 / 1302`. | med | ✅ all — each corrected ref was then re-read to confirm it lands on its `app.route`/`app.post` |
| **D44** | `docs/modules/quality-warehouse.md` + `production.md` | `applyPackingRack` at `packing-rack-write.ts:72`; `api-client.ts:58` | `:71` and `:76`. `production.md` disagreed with **itself** — its own table already said `:71`. | low | ✅ |

### 2d — Process, index and audit docs

| # | Doc | The claim | What the repo actually is | Sev | Fixed |
|---|---|---|---|---|---|
| **D45** | `docs/HOME.md:38` | `[[SYMBOLS]] — API endpoint index` | `SYMBOLS.md` was **DELETED 2026-08-13** (~75% of its offsets were wrong). `DOCS-INDEX.md:67` and `ONBOARDING-PATH.md:6-10` both record the deletion; HOME was restamped the same day and kept the link — in its "Find fast" section, where a new reader is sent. | **HIGH** | ✅ → `[[API]]` |
| **D46** | `docs/HOME.md:18` | `[[MODULES]] — module-by-module product reference`, listed under *live* product reference | Only `docs/archive/MODULES.md` exists, whose own banner says *"do not treat as current"* and which `LLM-CONTEXT-STRATEGY.md:76` forbids loading outright. Obsidian wikilinks resolve by note name across folders, so this link lands on exactly the file three other docs forbid. | **HIGH** | ✅ removed |
| **D47** | `docs/HEALTH-REVIEW.md:164` | *"`/fe-perf` only ever returns the `longtask` metric"* | `fe-rum.ts` emits **five** — `longtask:417`, `lcp:428`, `fcp:439`, `ttfb:453`, `nav:460` — ingest is metric-agnostic (`:184`), and `admin-health.ts:1622` groups and ranks all of them through an explicit `metricOrder` map (`:1662`). The 2026-08-01 reading predates the emitters. | **HIGH** | ✅ |
| **D48** | `docs/PAYROLL-AND-WORKER-PORTAL-GUIDE.md:13` | day-rate divisor at `payroll.ts:26`, `:167`, `:212` | `payroll.ts` is **205 lines** — `:212` is past EOF — and it **computes no pay at all**: `POST /` returns **501** (`:125-139`) and its own header points at `POST /api/payslips`. The real divisor is `labor-engine.ts:563-566`, fallback `FALLBACK_WORKING_DAYS_PER_MONTH = 26` at `:55`. The conclusion was right; all three citations were wrong. | **HIGH** | ✅ |
| **D49** | `docs/GITHUB-WORKFLOW-GOVERNANCE.md` | *"all 24 files in `.github/workflows/`"* + a full enumeration | **26** files. The two omitted are **`docs-freshness.yml`** and **`secret-hygiene.yml`** — the doc-freshness gate and the secret gate, in the doc whose entire subject is workflow governance. | med | ✅ |
| **D50** | `docs/LLM-CONTEXT-STRATEGY.md:45` | *"`rg -n … src docs tests migrations-postgres`"* | That is the whole tracked tree. `ONBOARDING-PATH.md:50`, `DOCS-INDEX.md:16` and `HOME.md:11` all say **never** grep the whole repo because it times out. Restamped 2026-08-13 without reconciling. | med | ✅ |
| **D51** | `docs/DEV-EFFICIENCY-SYSTEM.md:98,99,108` | Navigation 🔨 *building*, Methodology ⏭️ *next*, roadmap SoT = `PROGRAM-90D` | Its **own layer table 70 lines above** marks both ✅ built — and they are (`CODEBASE-MAP.md`, 15 module guides, `PLAYBOOKS.md` with exactly 8 procedures P1–P8). `PROGRAM-90D-EXECUTION.md` was **archived 2026-08-13**; its 90 days elapsed in July. | med | ✅ |
| **D52** | `docs/INVENTORY-WIP-FLOW.md:251` | `deriveFGStock` is a frontend roll-up at `src/pages/inventory/index.tsx:259-326` | It has **no definition under `src/pages/` at all** — it lives in `src/lib/fg-stock.ts` and is imported and run **server-side** by `inventory.ts:24` / `:585`. The doc's own banner records the correction; the section body was never rewritten. | med | ✅ |
| **D53** | `docs/DRAFTS.md:12` | Sofa Stool Orders — *"Status: Parked — user to fix tomorrow"*, under a heading reading "not yet implemented" | Shipped as its own product line (`mock-data.ts:325`, `5537-STOOL`, `sizeCode: "STOOL"`, per-seat-height prices). `stoolModel`/`stoolSize` have zero hits in `src/`. A reader scanning for open work picks it up. | med | ✅ |
| **D54** | `docs/AUDIT-UNSWEPT-ROUTES.md:22` | *"Nothing in this audit had been fixed as of this verification."* | Contradicted by **its own table rows 2 and 3** (both ✅) and by the code for findings 3, 5 and 6: `analytics/forecast.tsx:200-204` returns `{accuracy: null}` (the `84.2` literal is gone); `adjustments.tsx:224` reads `costPriceSen`, `:216` renders `null → "—"`, `:203` fetches `?buckets=finishedProducts`; and **all nine** `/api/inventory` call sites now pass `?buckets=` (`inventory.ts:176-189`). | **HIGH** | ✅ |
| **D55** | `docs/AUDIT-THIN-MODULES.md` A1 | *"🔴 the 'delivered with issues' billing hold **never fires** (VERIFIED, not fixed)"* | All four sites are dual-keyed today: `invoices.ts:1795`, `_helpers.ts:593` and `:4297`, `delivery-orders.ts:2758`. The hold fires. What survives is the **data** question — deliveries invoiced while it was dead — and that is **UNMEASURED**. | **HIGH** | ✅ |
| **D56** | `docs/AUDIT-THIN-MODULES.md` A3 | `GET /journals` unscoped, `POST /journals` omits `orgId` from both INSERTs | Both closed (BUG-2026-08-13-083): `accounting.ts:1179-1192` scopes both queries on `orgId`; `:1240` and `:1256` stamp it, under a comment reading *"read scoping without write stamping is only half a boundary."* | med | ✅ |
| **D57** | `docs/ERP-FEATURE-GAP.md:661` | audit read endpoint has *"no `requirePermission`, no org filter"* | `audit-events.ts:68` **is** `requirePermission(c, resource, "read")`, and `:78` / `:88` apply `getOrgId(c)` + `AND (orgId = ? OR orgId IS NULL)`. Filed under a *security exposure* tier that no longer exists. | **HIGH** | ✅ closed |
| **D58** | `docs/ERP-FEATURE-GAP.md:151` | Leave has *"**no entitlement, balance or accrual** of any kind"* | `src/lib/leave-entitlement.ts` implements entitlement resolution, statutory service-year tiers, a leave-year boundary, public-holiday exclusion and `computeLeaveBalance`; `GET /api/leaves/balances` (`leaves.ts:106-160`) serves it from real columns. Accrual and carry-forward really are absent. | **HIGH** | ✅ narrowed to the true gap |
| **D59** | `docs/ERP-FEATURE-GAP.md:280` | Consignment Returns is *"the **only** place in the system still rendering random business figures"* | `buildMockCRs` is gone (BUG-2026-08-13-071); the page reads `/api/consignments` and renders `—` with a "Value Basis" column where it cannot source a figure. No `Math.random()` outside the explanatory header. | **HIGH** | ✅ |
| **D60** | `docs/ISO-9001-GAP-ANALYSIS.md:24` **vs** `docs/ERP-FEATURE-GAP.md:665` | ISO: `fg_units.batchId` *"is now stamped **and backfilled**"* · GAP: *"backfill written but not run"* | The **writer** exists; whether the **backfill has been RUN on prod is UNMEASURED** from this branch. The in-repo note at `stock-breakdown.ts:509-516` says it had not, as of 2026-08-08. Two docs asserting opposite production states, neither measured. | med | ✅ both reconciled to UNMEASURED |
| **D61** | `docs/AI-CONTEXT-IMPROVEMENT-BACKLOG.md:30` · `docs/KNOWN-ISSUES.md:28` · `docs/SDK-MIGRATION-STATUS.md` | 375 / 381 test files; 174 files under `src/pages/` | **410** test files; **194** under `src/pages/`. The first two carry the *same* claimed measurement date and disagree with each other by 6. (The load-bearing SDK claim — **0** page files import `@/lib/api` — was re-verified and holds.) | low | ✅ |
| **D62** | `docs/PERF-DURABLE-ARCHITECTURE.md:14` | `keyset.ts` — *"exactly one route imports it"* | **No route imports it.** `production-orders.ts:3338` only mentions the file in a comment; `keysetPage` / `keysetResult` / `encodeKeysetCursor` / `decodeKeysetCursor` appear solely in `keyset.ts` and its own test. Tested, unused. | med | ✅ |
| **D63** | `docs/design/CHANGELOG.md:86` · `CHANGELOG-zh.md:90` | `dist/Hookka ERP Mobile (standalone).html`; fold breakpoint **≥700px** | No `dist/` under `docs/design/` — the file is `standalone/Hookka ERP Mobile (Phone).html`. The breakpoint is **720px** (`MobileLayout.tsx:87`). `design/README.md` was right on both; the two changelogs disagreed with it. | low | ✅ |
| **D64** | `docs/superpowers/specs/2026-07-02-midyear-opening-design.md:3` · `docs/AUDIT-LAYER-CONSISTENCY.md:105` | `accounting.ts:12452`; `so-co-do-backfills.ts:795` | `:12532` and `:810`. Both docs' substantive verdicts hold; only the anchors drifted. | low | ✅ |

---

## Additional COLLECTED items — judgement calls, NOT decided here

- **J5 — `docs/DOCS-INDEX.md` omits 34 live docs.** It bills itself as the navigation map and
  claims *"every link below was checked"*. Every path it lists does resolve — but
  `BUG-HISTORY.md`, `UI-CONVENTIONS.md`, `PERF-BACKLOG.md`, `DR-RUNBOOK.md`, `OBSERVABILITY.md`,
  `PRE-DEPLOY-CHECKLIST.md`, `ONBOARDING-PATH.md` and 27 others are absent — several of them
  named as *the* live entry point by other docs in the same index. **Add the entries, or restate
  the scope line as "a curated subset"?** Both are defensible; the current state is neither.
- **J6 — `docs/AGENTS-COMMIT-HYGIENE.md` makes citing an archived board a per-commit rule.**
  It instructs agents to cite task IDs from `docs/archive/UPGRADE-CONTROL-BOARD.md` and to
  "cite both commits in the control board's Done lane" — i.e. **write to an archived file** —
  while `SDK-MIGRATION-STATUS.md:85-87` says outright *"Do not use it to check current status."*
  Repointing it at `WORK-TRACKER.md` changes a standing commit convention: owner's call.
- **J7 — `docs/PERF-DURABLE-ARCHITECTURE.md` "Delivery deep-fix spec"** references `poRaw` and a
  30-field `mapPO` shape at `delivery/index.tsx:1406-1476`. Neither exists — the spec's own work
  shipped and deleted them. **Archive the section, or label it "HISTORICAL SPEC"?**
- **J8 — the systematic `file:line` drift across 11 module guides.** Anchors in `sales.md`,
  `accounting.md`, and the `payslips`/`workers` rows of `employees.md` have drifted 13–232 lines
  since their 2026-08-13 stamps, while the same docs instruct *"Never grep the whole repo — use
  the file:line below."* The past-EOF anchors and the ±1 mount refs were fixed here; the **bulk
  re-derivation was deliberately not done**, because it will re-rot within days unless the
  structure changes. **Re-derive on a schedule, or stop hand-carrying `file:line` for anything
  `docs/API.md` already generates?**
- **J9 — `docs/QUEUES-SETUP.md`'s smoke test can never pass.** It says the consumer *"calls the
  existing `notifySupplierPoSubmitted` helper"*, tells the admin to look for an `[email stub] …`
  log line, and to revoke `RESEND_API_KEY` to force a dead-letter. The consumer
  (`po-emission-consumer.ts:117`) only `console.log`s a stub, does **not** import
  `notifySupplierPoSubmitted`, and sends no mail — so revoking the key cannot force a retry and
  no `[email stub]` string exists anywhere. **Fix the runbook to describe the stub, or wire the
  real send?** The second is a product decision.
