# Docs vs Code — prose audit

> **COVERAGE: 81 of 81 live docs under `docs/` opened and read against the source**
> (plus `CLAUDE.md`). `docs/archive/` is excluded by design. Part 1 + Part 2 (below)
> read 49 of them; **Part 3 (2026-08-14, second pass) read the remaining 32** and is
> where the coverage fraction is derived mechanically. Neither pass can be trusted to
> have read a doc it does not cite by path.
>
> **Last verified: 2026-08-19** — **Part 5 (below)** closes the last three docs that had never
> been read against the source: `docs/ROADMAP-PHASE-C.md`, `docs/design/CHANGELOG-zh.md` and
> `docs/OWNER-DECISIONS.md`. With those three, **prose coverage reaches 100%** — every live doc
> under `docs/` plus `CLAUDE.md` has now been opened and checked against the code at least once.
>
> **Last verified: 2026-08-19** — **Part 4 (below)** re-audited the six module guides
> `docs/modules/{customers,procurement,products,rnd,sales,service-repair}.md` claim-by-claim
> against the source and corrected ~40 wrong anchors plus one whole stale owner ruling (the
> PI lifecycle). Coverage of *which docs have been opened* is unchanged at 81/81; Part 4
> raises the bar for those six from "opened" to "every claim in it checked".
>
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

**Scope.** The 81 live docs under `docs/` (excluding `docs/archive/`) plus `CLAUDE.md`.
Parts 1 and 2 cover **49** of them; **Part 3 covers the other 32** — see the coverage
fraction at the top.
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

---

# Part 3 — the SECOND pass: the 32 docs Part 1 and Part 2 never opened

> **Added 2026-08-14** (branch `docs/docs-audit-pass-2`). Same standard of proof:
> every row below was verified by opening the source file and reading the logic.
> **No claim about live production state appears here** — this session had no DB
> credentials, so anything needing live data is marked UNMEASURED.

## Coverage, as a fraction

**81 of 81 live docs under `docs/` have now been opened and read against the source**
(plus `CLAUDE.md`). `docs/archive/` is out of scope by design.

The first pass cited **49** of them by path. This pass opened the remaining **32**
(31 docs + this file). The split was derived mechanically, not estimated:

```
git ls-files docs | grep '\.md$' | grep -v '^docs/archive/'   → 81
    ...of which cited by path in this file before this pass   → 49
    ...opened for the first time by this pass                 → 32
```

Four of the 32 had been touched by Part 2 *by basename only* and for one narrow
claim each — `modules/{employees,reports,rnd,sales}.md` (D43's `worker.ts` mount
lines), `design/{README,CHANGELOG-zh}.md` (D63) and `ONBOARDING-PATH.md` (D45/D50).
**Their prose had still never been read**, and three of them carried a *fresh*
`Last verified: 2026-08-14` stamp over anchors that were wrong the same day. That
is the worst state a doc can be in, and it is what motivated the gate below.

## The headline: the drift class is now GATED, not just re-derived

Part 2's **J8** asked whether to re-derive the module guides' `file:line` anchors on
a schedule or to stop hand-carrying them. It deferred the bulk fix because *"it will
re-rot within days unless the structure changes."*

Measured this pass: **47 of the anchors in the 15 module guides' "Key functions"
tables had drifted off the symbol they name** — up to **193 lines** (`ReportsPage`),
and in `docs/modules/reports.md`, `employees.md`, `sales.md` and `service-repair.md`
the drift had happened *since* Part 2 restamped them, on the same day, because
`#319`, `#323` and `#327` landed in between.

This is not a doc problem that can be fixed by fixing docs. Every guide opens with
**"Never grep the whole repo — use the file:line below."** `grep` is banned here
because it times out on 2,122 files, so a reader who obeys the guide has no cheap
way to notice the offset is wrong: **the doc has removed the reader's fallback.**

So the third answer to J8: **keep the anchors, and let CI hold them to the source.**

- All **47** drifted anchors re-derived from source and corrected (table rows *and*
  the prose that repeats the same offsets — 78 replacements in 11 guides).
- New **`tests/docs-module-guide-anchors.test.mjs`** — three gates over every
  anchored row of all 15 guides: the file exists, the offset is inside the file, and
  the offset lands within 8 lines of the symbol it names (identifier, or the route
  registration for an HTTP-handler row).
- Proved RED by restoring one anchor (`sales.md` → `sales-orders.ts:1503`) with
  bytes-changed-on-disk asserted first, EOL-agnostic. **Note for the next author:**
  the first RED attempt silently passed because the replacement hit a *prose*
  mention rather than the table row the gate reads. A `\n`-anchored or
  wrong-target edit is a false all-clear — target the table row.
- `scripts/check-codebase-map.mjs` covers `CODEBASE-MAP.md` only;
  `tests/docs-required-reading-truth.test.mjs` (added by Part 1, D16) covers the five
  required-reading docs. The 15 module guides had **no gate at all** until now.

**Dated history was deliberately not rewritten.** The `> Corrected 2026-08-13:` lines
record what was true then; the bulk pass touched five of them and they were restored
verbatim.

---

## 3a — Contradictions found and FIXED

| # | Doc | The claim | What the code actually does | Sev | Fix |
|---|---|---|---|---|---|
| **D65** | `docs/AUDIT-DETAIL-PAGES.md` header (×1, load-bearing) | *"Nothing in it had been fixed as of this verification — 'Nothing was changed' is still accurate, and **D1–D13 are all open**"* | **This document's own STATUS section says the opposite**, and has since 2026-08-13: D1, D4, D5, D9, D12 SHIPPED, and its own D3 row is ✅. Re-measured: `service-cases/detail.tsx:311` fetches `?fields=case-pipeline&scope=`; `cached-fetch.ts:467` exports `isUnknownOutcome`; `procurement/detail.tsx:166` and `suppliers/detail.tsx:238` both gate on an edit flag and pass `?buckets=`. **A doc contradicting itself, with the false half in the header a reader sees first.** | **HIGH** | ✅ header rewritten to the measured split (6 shipped / 8 open) and pointed at STATUS |
| **D66** | same doc, header ×2 | `void ttlSec` is at `cached-fetch.ts:478`; `openPOs[po.id] ?? true` at `document-chain-map.tsx:416` | `:589` (and again `:706`); `:431` (and `:512`). `:478` is now inside an unrelated comment block. This is the doc's single load-bearing mechanism proof ("the cache never suppresses the refetch"), 111 lines off. | med | ✅ |
| **D67** | `docs/DASHBOARD-DATA-AUDIT.md` (PCB row) | *"`payslips.ts:230` — `pcb: pcbOn ? 0 : 0` … the per-worker `pcbEnabled` toggle does nothing … any worker above the PCB threshold has an **overstated net pay printed on a payslip**"* | **Fixed and shipped.** The literal exists nowhere but in comments recording its removal. `src/lib/pcb.ts:352` exports `resolvePcb()`; `payslips.ts:312` calls it; `pcbSen` (`:146`) and dual-keyed `pcbStatus` (`:147-151`) are persisted; migration `0229_pcb_tax_profile.sql`. The comment at `payslips.ts:309-311` names BUG-2026-08-13-121. **The owner is told his payslips overstate every taxable worker's net pay. They do not.** | **HIGH** | ✅ row + Part-6 owner question closed |
| **D68** | same doc (leave row) | *"Two hardcoded literals with **no entitlement column anywhere** (grepped `src/api` and both migration trees: zero hits). The office says 8 days, the phone says 14 … 'Remaining' never resets on 1 Jan"* | **Three present-tense claims, all false.** Both literals are gone (`employees.tsx:10198`, `worker.ts:2526` carry the removal comments). Office (`leaves.ts:153-156`) and phone (`worker.ts:2576-2577`) read `entitlementDays` from ONE module, `src/lib/leave-entitlement.ts`, whose `resolveEntitlementDays` (`:266`) reads a real per-worker column with a shared fallback; the balance carries a `leaveYear` (`:296-335`). | **HIGH** | ✅ row + Part-6 owner question closed; the true remaining gap (accrual / carry-forward) left pointing at `ERP-FEATURE-GAP.md` |
| **D69** | same doc (forgotten-punch row + Part 4 item 1) | *"The `× 0.85` fabrication has THREE sites … `worker.ts:939` and `:1178` … **Not edited here on purpose** … Whoever merges must confirm they are covered"* | All three closed. `autoCloseForgottenPunch` (now `worker.ts:961-1000`) writes `productionTimeMinutes = NULL, efficiencyPct = NULL` (`clearMetrics`, `:982-984`) under a comment naming BUG-2026-08-13-103. `grep "0\.85"` over `worker.ts` + `attendance.ts` returns **comments only** (`worker.ts:1217`, `:1534`; `attendance.ts:17,24,26,192`). **The doc also contradicted its own S1 block**, which already recorded the fix in #323. | **HIGH** | ✅ row + the standing merge instruction discharged; the still-true half (synthetic clock-out invisible because the table renders no notes column) kept |
| **D70** | same doc, Part 4 item 4 | *"`POST /api/supplier-materials` persists `leadTimeDays: … \|\| 7` and `moq: … \|\| 1` (`:206,208`) … a user who types 0 gets **1** written"* | `supplier-materials.ts:216` is `\|\| 0` and `:218` is `\|\| 0`. Both fall back to 0 — which this same document defines as UNSTATED. The two writers no longer disagree. | **HIGH** | ✅ closed as code; the **data** question (rows the old writer already wrote) kept and marked **UNMEASURED** |
| **D71** | `docs/AUDIT-INTERACTION-COST.md` §5 (×3 + table) | *"**Ten** sites still declare `columns` as a bare array literal inside the component body"* + a ten-row table + *"Not fixed here. **Ten files**"* | **Twelve.** Enumerated every `const …: Column<…>[] = [` in `src/pages` + `src/components` and classified each as module-scope / `useMemo`-wrapped / bare-in-component. Missing: **`employees.tsx:4877`** (fed to `<DataGrid columns={columns}>` at `:5260`) and **`employees.tsx:5610`** (`columns={itemColumns}` at `:5985`). A reader runs "the ten-file sweep", ships it, and closes the class with two Employees grids still re-sorting on every toast. | **HIGH** | ✅ count + table + the "Cleared" note (inventory's three really are module-scope at column 0; `employees.tsx:3939` really is `useMemo`-wrapped) |
| **D72** | `docs/STORAGE-SETUP.md` "What this delivers" | *"**Today**, attachments … have **no durable home** — they're either inlined in DB blobs or live on someone's desktop"*, framing `/api/files` as an unactivated scaffold | `/api/files` is live, shipped, load-bearing product: **20 modules** under `src/pages` + `src/components` consume it (announcement media, product/customer documents via `resource-documents.tsx` `:89/:137/:163/:246-278`, QC photos, scanned supplier POs, the `/m` screens). **The doc also contradicts itself at Step 4**, which says `SUPABASE_PROJECT_REF` is *"already set on the Cloudflare Pages dashboard for prod"*. Its Step-5 "rollback: unset either secret, the route returns 503 cleanly" is therefore an **outage of every attachment surface**, presented as a toggle. | **HIGH** | ✅ rewritten; the rollback re-labelled |
| **D73** | `docs/AGENTS-BLUEPRINT.md` capability table | *"**66 个只读工具**"* | **69**, counted over the `TOOLS` array (`assistant-tools.ts:6692`) — and **six are not read-only**: `agentControlTool` (`:6368` → `setAgentControl` `:6418`, global kill switch `:6431`, run_now), `teachAgentTool` (`:6495`, persists standing rules), `setCapacityTool` (`:6583`, pins department capacity), plus `generateCsv/Excel/PdfTool`. | med | ✅ |
| **D74** | same doc, permissions row | *"权限/审计 ✅ 已有 … **写动作全部走审批**"* — the doc's own 铁规 #1 | Contradicted by D73's tools, which **write directly from chat with no proposal and no approval**, and by `assistant-tools.ts:6400-6403`, which records the owner opening pause/resume/auto_on/auto_off/run_now **and teaching** to all staff (2026-07-28); only the global kill switch stays SUPER_ADMIN. A **security-posture claim, stated as absolute, with a documented carve-out.** | **HIGH** | ✅ narrowed to "business data writes", with the exception named as owner-authorised, not a defect |
| **D75** | same doc, §11 self-scheduling | *"GH Actions **每 30 分钟** 发一个哑心跳 (`agent-heartbeat.yml`)"* | Both halves wrong. `agent-heartbeat.yml:32` is `7,27,47 * * * *` (three beats/hour), and since 2026-07-17 that workflow is **only a fallback** — its own header (`:26-31`) records that the reliable driver is a separate Cloudflare Cron Worker, `agent-heartbeat-worker/` (`wrangler.toml:51` = `*/30` + `*/5`), because GitHub cron drifted **2–3.5 hours**. Someone debugging "the agent didn't run" checks Actions and never learns the CF Worker exists. | med | ✅ |
| **D76** | same doc, §14 Console | *"11 张卡（**4 现役 + 7 蓝图**）"* | 11 still holds, but the split is **6 live + 5 planned**: `AGENT_FAMILIES` (`agent-console.ts:28-36`) = PRODUCTION, DELIVERY, CS, EMPLOYEE, SERVICE, PROCUREMENT. `src/api/lib/employee-agent.ts` and `service-agent.ts` both exist — two of the doc's roadmap items shipped. | low | ✅ (dated as "today 6+5; was 4+7 on 2026-07-12") |
| **D77** | `docs/SHEETS-SYNC.md` "What is NOT hooked" | lists `POST /api/production-orders/:poId/regen-job-cards` and `POST /api/sales-orders/regen-job-cards` | **Both DELETED 2026-05-09.** `grep -rn "regen-job-cards" src/` returns only the two removal comments at `production-orders.ts:1859-1860` — zero registrations, zero callers. Regeneration now goes through `createProductionOrdersForOrder({ appendOnly: true })`, which is **also** un-hooked, so the warning is right about a *different* entry point. | med | ✅ |
| **D78** | `docs/SHEETS-SYNC.md` env section | *"**All three** optional during rollout — when **any** is missing the helpers no-op silently and the routes return 503"* | They do not gate as one unit. `GOOGLE_SHEETS_SA_KEY` + `SHEETS_SPREADSHEET_ID` gate the ERP→Sheets helpers (`sheets-sync.ts:106-120`, `:219-223`); `SHEETS_SYNC_SECRET` gates **only** the Sheets→ERP webhook (`routes/sheets-sync.ts:70-83`). Set the first two and not the third and ERP→Sheets goes live while Sheets→ERP 503s — a half-configured state the doc says is impossible. | low | ✅ |
| **D79** | `docs/SHEETS-SYNC.md` HMAC section | the drift check lives in `buildWebhookHmacPayload` / `verifyWebhookSignature` in `src/api/lib/sheets-sync.ts` | Neither lib function sees the timestamp. `WEBHOOK_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000` is at `src/api/routes/sheets-sync.ts:55`, applied at `:106-116`, and it fires **before** signature verification at `:146`. Someone debugging a 401 in the lib file will not find it. | low | ✅ |
| **D80** | `docs/PRE-DEPLOY-CHECKLIST.md` | *"The PR template MUST include … 'Schema diff verified against production' + 'Critical paths verified end to end'. The reviewer MUST refuse to merge until **both checkboxes** are filled."* | `.github/PULL_REQUEST_TEMPLATE.md` contains **neither string**. It has `## Impact check`, `## Production-state claims` and `## Testing`. The reviewer is told to enforce checkboxes that do not exist, so the rule silently enforces nothing. | med | ✅ restated as "does not today — paste by hand, or add the fields" |
| **D81** | `docs/modules/employees.md` core flow 3 | *"`payroll.ts POST /` **:137** is the run-header guard (blocks double-generate)"* | `POST /api/payroll` is **DISABLED**: after the `payroll:create` check it returns **501** unconditionally (`payroll.ts:125-139`), because it *"invented overtime hours with a random number generator instead of reading attendance"*; its own header calls it "a legacy duplicate". It guards nothing. Payroll generates only via `POST /api/payslips`. The file is **205 lines**, not the 308 the same doc claims. | **HIGH** | ✅ |
| **D82** | `docs/MFRS-GAP-ANALYSIS.md` §MFRS 119 | *"payslips compute the full statutory split incl. employer EPF/SOCSO/EIS + PCB (`payroll.ts:41-47`)"* | The **conclusion is right, the citation points at a dead file**: `payroll.ts:41-47` is a `PayrollRow` **type declaration** in the 501-disabled route. The real computation is `calcStatutory` (`payslips.ts:295`) + `resolvePcb` (`src/lib/pcb.ts:352`). The doc's own header disclaims *line* drift, not a wrong *file*. | med | ✅ |
| **D83** | `docs/ISO-9001-BUILD-PLAN.md`, `docs/ISO-9001-GAP-ANALYSIS.md`, `docs/MFRS-GAP-ANALYSIS.md` | *"`migrations-postgres/` (**244** files)"* — three times | **252** files as at 2026-08-14; newest is `0230_mrp_on_order_and_moq.sql`, and `0229` is still shared by two files. **D42 corrected this exact figure in three docs and missed these three** — including `ISO-9001-GAP-ANALYSIS.md`, which Part 2 *had* opened (D60). This is `BUG-CLASSES`'s own recurring shape: the fix repaired only the instances in front of the author. | med | ✅ all three |
| **D84** | `docs/context-packs/frontend.md` rollout list | `src/pages/production/tracker.tsx` listed as a page still needing responsive work | **Deleted.** `/production/tracker` is a `<Navigate to="/planning?tab=tracker">` redirect (`dashboard-routes.tsx:264`), and `global-search.tsx:120` records it as "a bare redirect since the tracker". **This doc's own header records fixing the identical trap twice** on 2026-08-13 (`pricing.tsx`, `in-transit.tsx`); the third instance survived the sweep. | med | ✅ (+ `dept.tsx` / `overview.tsx`, which exist and were missing) |
| **D85** | `docs/play-store-publishing.md` step 4 | *"copy the SHA-256 … Paste it into **BOTH** entries of `assetlinks.json` (each app uses its own app's fingerprint)"* | Self-contradictory in one sentence. `assetlinks.json` holds two independent objects whose `_comment` fields each say *"paste **this app's** … SHA-256 here"*. Following the first half leaves the Worker TWA unverified and it opens with the browser bar — the exact failure the step exists to prevent. | low | ✅ |
| **D86** | `docs/modules/reports.md` (×2, disagreeing with itself) | mount lines: header says `/api/dashboard/overview` `:1304`, body says `worker.ts:1303`; `/api/forecasts` `worker.ts:1345` | `worker.ts:1304` and `worker.ts:1346`. The doc gave two different numbers for one mount, and the forecasts mount is the **same ±1 drift D43 swept for** — it reached 12 guides and missed this line. | low | ✅ |
| **D87** | 8 module guides, present-tense file sizes | `sales-orders.ts` 5626 · `_helpers.ts` 1452 · `consignment-orders.ts` 2815 · `products/index.tsx` 5,307 · `employees.tsx` 11,746 · `payroll.ts` 308 · `payslips.ts` 1353 · `workers.ts` 1126 · `worker.ts` 4130 · `attendance.ts` 381 · `leaves.ts` 243 · `department-performance.ts` 807 · `working-hour-entries.ts` 1640 · `scan.tsx` 3203 · `customers.ts` 795 · `auth.ts` 1201 · `auth-totp.ts` 546 · `purchase-orders.ts` 1177 · `reports.ts` 1016 · `forecasts.ts` 131 · `dashboard-overview.ts` 2249 · `compliance-report.ts` 1402 · `operations-report.ts` 1223 · `rd/detail.tsx` 3143 · `service-cases/detail.tsx` 3,506 | `wc -l` 2026-08-14: 5704 · 1462 · 2986 · 5,316 · 11,897 · **205** · 1625 · 1266 · 4220 · 553 · 354 · 848 · 1643 · 3218 · 803 · 1235 · 612 · 1190 · 973 · 155 · 2316 · 1519 · 1248 · 3176 · 3,600. | low | ✅ all 25 re-measured |
| **D88** | *(gap, not a single doc)* | the module guides' `file:line` anchors had no mechanical gate | 47 drifted anchors across all 15 guides, up to 193 lines, several introduced **the same day** the guide was restamped. | **HIGH** | ✅ all 47 corrected + new `tests/docs-module-guide-anchors.test.mjs` (proved RED) |

---

## 3b — Checked and CONFIRMED STILL TRUE

Recorded so the next reader does not re-derive them.

- **`docs/ENGINEERING-ONBOARDING-SOP.md` — SOUND.** Every cited path exists; the
  2026-08-13 correction about `docs/archive/MODULES.md` is right; its scope caveat
  quotes `DEV-OPERATING-FRAMEWORK.md:146-147` verbatim.
- **`docs/context-packs/{architecture,backend,core-flow,security}.md` — SOUND.**
  Every "read first" file exists; **139** `app.route` mounts in `worker.ts` (exact);
  `requireSuperAdmin` appears **9** times in `users.ts` (exact); all four named
  security tests exist.
- **`docs/design/README.md` — SOUND.** `useMediaQuery("(min-width: 720px)")` is at
  `src/pages/m/MobileLayout.tsx:87`, exactly as cited; both `standalone/*.html` exist;
  every listed design file is present.
- **`docs/ENTERPRISE-ERP-ARCHITECTURE.md` — its UNVERIFIED banner holds.** **136**
  route files (exact); `src/api/queues/` contains exactly `po-emission-consumer.ts`,
  so "the only async lane" is right; no Redis / Kafka / OpenSearch / BFF anywhere.
- **`docs/play-store-publishing.md` is otherwise unusually accurate** — both
  `sha256_cert_fingerprints` are still the literal placeholder (so "Step 4 has never
  been done" holds), package names and `start_url`s exact, `docs/play-assets/` holds
  exactly the three named files, and `ios-build.yml` is `workflow_dispatch`-only,
  unsigned, and calls the repo public in its own header.
- **`docs/CANARY-DEPLOY.md` and `docs/PRE-DEPLOY-CHECKLIST.md`** — the canary branch
  slug/URL shape, blocking-vs-non-blocking job order, absent D1 binding, both bound
  Hyperdrives, and the three `isPreviewHostname` rules all verified. The note that
  `check-schema-applied.mjs` parses only `CREATE TABLE`, runs post-deploy and
  soft-skips without `DATABASE_URL` is **exactly right** (and is Part 2's D21).
- **`docs/SHEETS-SYNC.md`'s mechanics** — all five `file.ts:NNN` refs in its header
  are exact; 8 dept tabs on both sides; 13 columns A–M; editable columns I/J/K; the
  canonical HMAC string; all three troubleshooting error strings verbatim.
- **`docs/ONBOARDING-PATH.md`** — all 15 module guides named in its mental-model list
  exist, and its `[[API]]`-replaces-`SYMBOLS` correction holds.
- **`docs/AGENTS-BLUEPRINT.md`'s strongest claim (its header) holds in full** —
  `promiseDelivery`, `procurementReadiness`, `materialAvailability`,
  `transitDriftLearning`, `computeChainWithAssignments` and
  `autoCreateDosForApprovedLoadPlans` all exist at the cited paths, both endpoints
  carry the permissions it names, and the scheduler bounds (≤6 runs/day, ≥1h gap)
  are exact.
- **`docs/modules/{inventory,delivery,production,planning,dashboard,accounting,quality-warehouse}.md`**
  — the Part-2 anchors that were re-derived then are still correct now, except the
  five caught by the new gate (D88).

---

## 3c — COLLECTED: judgement calls, NOT decided here

Per the owner's standing rule, a judgement call gets asked, not decided.

- **J10 — `deploy.yml`'s PR bot comment still tells reviewers the canary shares
  production's database.** `.github/workflows/deploy.yml:294` posts *"This branch is
  wired to the same Hyperdrive (→ Supabase Postgres) and KV bindings as production"*,
  and `:260` says *"Hyperdrive, KV, R2 bindings — all live in preview env"* (R2 was
  retired 2026-04-27, `wrangler.toml:33-40`). `docs/CANARY-DEPLOY.md` exists
  specifically to kill that belief — but reviewers read the bot comment, not the doc.
  **This is a workflow string, not a doc**, so it was recorded rather than edited:
  changing what the deploy pipeline tells every reviewer is the owner's call. Fix the
  string, or have the doc explicitly disown that line?
- **J11 — the `docs/DASHBOARD-DATA-AUDIT.md` summary counts disagree with its own
  tables.** It says *"21 fabricated figures, 24 mislabelled ones, 15 places where a
  clean number means 'cannot see'"*; its tables hold 22 / 36 / 19 rows. A reader
  working the summary as a checklist stops twelve rows short of Part 2b. Re-count and
  restate, or drop the summary numbers and point at the tables? (Not fixed here: the
  four rows this pass corrected change the counts again, and the right total depends
  on whether a closed row still counts.)
- **J12 — roughly 45 of `DASHBOARD-DATA-AUDIT.md`'s 77 table rows remain unverified.**
  This pass opened every row it reports on, plus the ones listed sound. **Four of the
  rows checked turned out to be closed by a shipped fix**, so the unchecked remainder
  should be treated as suspect rather than trusted. Schedule a row-by-row pass, or
  restamp the file with an explicit "rows N..M unverified" scope line?
- **J13 — `AUDIT-INTERACTION-COST.md`'s LOCAL build artefacts.** It cites
  `pdf-D0Z4EJlb.js` and `detail-VI76U_z1.js` by chunk hash. Those names do not survive
  a rebuild, so the figures are unreproducible by construction. Re-state as
  "the PDF chunk" without the hash, or accept them as one-build snapshots?
- **J14 — `ENTERPRISE-ERP-ARCHITECTURE.md` §6 lists as "long-term (2-6 months)" two
  things that substantially exist:** §6.2 hard multi-tenant boundaries (`tenant.ts`,
  `withOrgScope:146`, `getOrgId` on every `/api/files` query) and §6.3 posting engine
  + immutable accounting journal (`journal-hash.ts`, append-only ledger, hash chain).
  §6.4 MDM is genuinely still a gap — the shipped `mdm.ts` is **detection-only**, not
  golden records. Annotate the two as partially shipped, or leave §6 as a pure
  aspiration list? Its UNVERIFIED banner arguably already covers this.
- **J15 — `gen-api-docs.mjs --check` reports a FALSE "stale" in a fresh worktree.**
  `CLAUDE.md` tells every session to trust `--check` before reading `docs/API.md`. In
  a newly-created worktree it printed *"docs/API.md is stale"* while `git diff`
  showed **zero** tracked change — the generator writes LF, the repo stores CRLF, and
  the comparison is byte-wise. Regenerating produced no diff at all. Normalise EOLs
  inside the check, or document the false positive? (Left alone: it is a script
  change, and a wrong "fix" here silences a real staleness signal.)

---

## 3d — What this pass did NOT verify, and why

Stated plainly, because a gap someone knows about is cheaper than one they discover.

- **Every production figure in every audit doc is UNMEASURED from this branch.**
  No DB credentials existed in this session. The row counts, byte sizes, timings and
  percentages in `AUDIT-DETAIL-PAGES.md`, `AUDIT-INTERACTION-COST.md` and
  `DASHBOARD-DATA-AUDIT.md` are dated historical measurements, correctly labelled as
  such by their own provenance tables. Nothing here confirms or refutes them.
- **`docs/WORK-TRACKER.md` (4,008 lines) was scanned, not read line by line.** It is
  a running work log — dated entries describing what was true when written, the same
  append-only shape as `BUG-HISTORY.md`. Its `file:line` refs were checked
  mechanically (13 stale paths, all inside dated historical entries; `tests/db-schema.js`
  is the recurring one — the real file is `tests/db-schema.json`). **Not rewritten**:
  correcting history is a different act from correcting a claim.
- **`AUDIT-INTERACTION-COST.md` §6's full print-feedback inventory** (13 "no feedback"
  + 4 "has feedback" refs) was spot-checked only.
- **The med/low `file:line` drift inside the three audit docs' finding rows** was
  measured but not individually re-derived and applied — roughly 30 refs across
  `employees.tsx`, `data-grid.tsx`, `cached-fetch.ts` and `accounting.ts`, each
  ~15-150 lines stale while the finding itself still holds. The durable fix for that
  class is the gate in D88, which currently covers the module guides only; extending
  it to the audit docs' tables is the obvious next step and is **not done here**.

---

---

# Part 4 — the SIX module guides that had never been checked against source

> **Last verified: 2026-08-19.** Scope: `docs/modules/customers.md`,
> `docs/modules/procurement.md`, `docs/modules/products.md`, `docs/modules/rnd.md`,
> `docs/modules/sales.md`, `docs/modules/service-repair.md`.
>
> Parts 1–3 audited *whether each doc had been opened*. These six had been opened, but
> their **claims** had only ever been checked against each other and against `wc -l`.
> This pass opened the source for every factual claim in them: file path, route, table,
> column, offset, migration number, test name and behaviour. 「我需要是可以信的」

## Method, and its limits

Three things were checked mechanically and re-read by hand afterwards:

1. **Existence + line counts** — every path cited in all six guides, via `wc -l`.
2. **Offsets** — a script dumped the actual source line under every `path:line` in
   *prose* (the `Key functions / sections` tables are already gated by
   `tests/docs-module-guide-anchors.test.mjs`, which passes at ±8 lines and therefore
   does **not** catch a 3-line drift or an anchor that lands on a JSX *usage* instead of
   the definition — two failure modes this pass found).
3. **Behaviour** — the handler/function body was read for every rule the guides assert.

**What that gate misses, demonstrated.** `docs-module-guide-anchors` was green before and
after this pass, yet the pass found ~40 wrong offsets. Two reasons: (a) prose anchors are
not in the table and are ungated; (b) a table row whose symbol cell has no backticks is
skipped entirely — that is how `| SV-order pricing skip | sales-orders.ts:1751 |` survived
while pointing 163 lines away from the guard it names.

**Source files opened for this pass** (beyond the ones the six stamps now name):
`src/api/routes/{customers,customer-products,customer-maintenance,customer-hubs,customer-quotation,users,auth,worker-auth,files,purchase-orders,grn,purchase-invoices,supplier-materials,three-way-match,supplier-payments,products,bom,bom-master-templates,maintenance-config,mdm,rd-projects,rd-team-members,sales-orders,consignment-orders,service-cases,service-orders,stock-adjustments}.ts`,
`src/api/routes/sales-orders/_helpers.ts`, `src/lib/{convert-chain,purchase-edit-rules,pi-posting,repair-scope,so-mode}.ts`,
`src/api/lib/{sofa-combo,sofa-combo-pass,bom-wip-breakdown,column-rename-map.json}`,
`src/pages/mail-center/mail-prefs.ts`, the `src/pages/{customers,products,rd,sales,procurement,suppliers,service-cases,service-orders,service-order,consignment,maintenance}` trees,
`src/dashboard-routes.tsx`, `src/api/worker.ts`, `migrations/`, `migrations-postgres/`,
`tests/db-schema.json`, `tests/customer-notify.test.mjs`, `tests/customer-quotation-batched.test.mjs`.

---

## 4a — `docs/modules/customers.md`

| # | Contradiction | Resolution |
|---|---|---|
| C1 | Three separate places said `customer-maintenance.ts` copy-from-master "mirrors EVERY master `maintenance_config_history` snapshot" — as if that were the whole operation. Reading the file end-to-end (185 lines): it is **primarily a `kv_config` blob copy**, `variants-config` → `variants-config:<customerId>` (`:81-89`), and the history mirror is a *second* step (`:91-171`). *(I initially wrote this up as "the history claim is false"; reading past line 90 refuted my own finding — the mirror is real, the description was just half the story.)* | Data model, Core flow 3 and the Gotcha rewritten to describe both steps, with the corrupt-JSON guard pinned to `:66-73` and the mirror's idempotency key `(effective_from, config)` named. |
| C2 | `app.put("/:id")` cited as `customers.ts:500` in three places. `:500` is inside the `_backfill-snapshot-names` handler. | → `:508` (flow 1, table, playbook). |
| C3 | `/me/permissions` cited as `auth.ts:487` — **34 lines off**, landing on a `Set-Cookie` clear inside `POST /logout`. | → `:521`; `/me` `:491` added. |
| C4 | `app.post("/login")` cited as `auth.ts:148`. | → `:149` (flow + table). |
| C5 | "every mutation in `users.ts` calls `requireSuperAdmin(c)` … `:166`, `:259`, `:361`, `:556`, `:633`, `:778`, `:941`, `:996` — create / edit / delete / reset-password / invite / invite-resend / invite-delete" — **8 offsets, 7 labels**, and `:166` is not create: it is `POST /backfill-org-from-aliases` (`:165`). | Every gate paired to its handler line explicitly. The *claim itself* is TRUE — all 8 mutating handlers are gated, the 3 GETs are not. |
| C6 | `CustomerProductsPanel` `customers.tsx:192` → actual `:193`; `AssignSkuModal` `:3216` → actual `:3218`. | Fixed in flow, table and playbook. |
| C7 | Playbook: "Adjust per-customer pricing … Test `tests/customer-notify.test.mjs`". That file is 1,069 lines of **DO / invoice / CN dispatch email template** tests — zero pricing content. | → `tests/customer-quotation-batched.test.mjs`, which actually asserts `customer-products.ts` exports the batched resolver and reads `FROM customer_product_prices`. The wrong pointer is called out so nobody re-adds it. |
| C8 | "`/api/files` … serves them with attachment disposition, but `<img src=…/download>` still renders" — describes the wrong handler. `GET /:id/download` (`files.ts:446`) **302-redirects** to a signed Supabase URL; the `attachment` disposition is set only by the `/stream` proxy fallback (`:485`, headers `:503-511`). | Rewritten with both handlers, and the real reason `<img>` renders (browsers ignore `Content-Disposition` on subresource loads). |
| C9 | The doc's own 2026-08-13 stamp claimed "`customers.ts` is 795 lines" while its Entry points said 803. | Superseded. Actual **803** — the Entry-points figure was right, the stamp was wrong. |

**Confirmed still true (re-measured, not assumed):** every one of the 13 entry-point line
counts is **exact** (803 / 1235 / 185 / 75 / 268 / 1037 / 1235 / 240 / 612 / 349 / 2476 /
571 / 117). `validateDebtorCode :76`, `rowToCustomer :271`, `app.post("/") :350`,
`ensureCustomerCompanyColumn :39`, `resolvePrices :95`, `prices POST :434`,
`bulk-assign :743`, `copy-from-master :833`, `resolveCustomerPriceAsOf :1004`,
`customer-maintenance :30`, all four `worker-auth.ts` handlers (`:124/241/297/312`) —
**all exact**. `resolvePrices` really is inherit-or-override (NULL → master). All 20 tables
named in Data model exist. `kv_config['public_holidays']` really is read by payroll
(`payslips.ts:508/731/1080`, `leaves.ts:37`, `payroll-hour-deductions.ts:236`). The three
Mail Center toggles are real (`mail-prefs.ts:24`) and `classifyCategory` really is
client-side (`:155`) — its path (`src/pages/mail-center/`, not `src/lib/`) is now given.

---

## 4b — `docs/modules/procurement.md`

| # | Contradiction | Resolution |
|---|---|---|
| P1 | **The whole PI lifecycle was an owner ruling out of date.** The guide described DRAFT + APPROVED with `PENDING_APPROVAL` on manual create. The live lifecycle (owner ruling **2026-06-29**, stated at `purchase-invoices.ts:8-12` and `:311-325`) is **DRAFT → CONFIRMED → PAID**; `PENDING_APPROVAL`/`APPROVED` were dropped and are backfilled to CONFIRMED by `ensurePiMigrations` (`:89`). Affected: "What it does", Core flows 4 & 5, three Gotchas, one table row, one playbook step, one Entry-points parenthetical. | All rewritten around CONFIRMED, with the legacy states explained rather than deleted (un-backfilled rows still exist in `VALID_TRANSITIONS`). |
| P2 | "PI manual → PENDING_APPROVAL; only OCR/scan (`ocrUsed`) → DRAFT." **PI create is now always DRAFT** (`:1127`) and `ocrUsed` is explicitly a legacy no-op (`:1090-1092`). | Gotcha rewritten. The PO half of the same gotcha was verified TRUE (`purchase-orders.ts:519` — `body.status ?? "DRAFT"`). |
| P3 | "PI editable in DRAFT *and* APPROVED (owner 2026-06-22)". Actual `PI_EDITABLE_STATUSES = ["DRAFT","CONFIRMED","APPROVED"]` (`purchase-edit-rules.ts:32`). | → DRAFT / CONFIRMED / legacy APPROVED. **Also flagged, not fixed:** the route's own header comment (`purchase-invoices.ts:10`) says CONFIRMED is "locked-for-editing (same as PAID)", which contradicts both `PI_EDITABLE_STATUSES` and the PUT gate at `:1959-1969`. The code wins; the stale comment is a source change and is out of scope for a docs pass. |
| P4 | **Nine Entry-points page anchors wrong**, none caught by the ±8 gate because they are prose: `detail.tsx:111`→`:113`; `grn.tsx:347`→`:351`; `grn/create.tsx:103`→`:126`; `grn-detail.tsx:129`→`:136`; `pi.tsx:93`→`:96`; `pi/create.tsx:116`→`:135`; `PurchaseInvoiceDetail.tsx:137`→`:160` (23 off); `suppliers/detail.tsx:156`→`:157`; `create.tsx` had no offset. | All re-derived. Where a default-export wrapper shadows the real component (`GRNCreatePageWrapper :110`, `CreatePurchaseInvoicePageWrapper :121`, `CreatePurchaseOrderPageWrapper :63`) both lines are now given. |
| P5 | `ThreeWayMatchPanel` cited at `detail.tsx:1349` in prose **and in the gated table** — 43 lines off. It passed CI because `:1349±8` contains the JSX *usage* at `:1341`. The definition is `:1392`. | → `:1392` in both places, with the render site noted. **This is the gate's blind spot made concrete.** |
| P6 | `fillBlankSupplierSku` `:172` → actual `:185`. | Fixed. |
| P7 | "Supplier pricing is effective-dated (**mig 0183**)" — twice. `0183` is `supplier_reference_numbers` (the `grns.supplier_do_no` migration, which the same doc separately and correctly attributes to 0183). Effective-dated binding pricing is **`0184_supplier_binding_effective_from.sql`**. | → 0184, with 0183 kept where it is right. Both verified in `migrations-postgres/`. **Note for future passes:** `migrations/` (D1, 130 files, 0001–0110 then 0194+) and `migrations-postgres/` (253 files, the live numbering) do **not** share a numbering scheme. Every migration number the six guides cite resolves in `migrations-postgres/`, and I nearly published "mig 0182 does not exist" from looking in the wrong directory. |
| P8 | The doc's own stamp said `purchase-orders.ts` is 1,177 lines while Entry points said 1190. | Actual **1,190**. Superseded. |

**Confirmed still true:** `grn.ts` 2,592 / `purchase-invoices.ts` 2,869 lines — exact. **Every
API-side anchor is exact**: `postGRNToStock :521`, `buildPostedGRNStockAdjustment :670`,
`cascadePOStatusAfterGRNPost :811`, `restorePOReceivedQtyForGRN :992`,
`cascadePOReceivedQtyDelta :1085`, `resolveRmForGRNItem :473`, GRN create `:1300`,
GRN edit `:1789`, arrival `:2174`, `COMMITTED_STATUSES :305`, PO create `:430`,
PO edit `:760`, `ensurePendingMigrations :1063`, PI create `:1047`, `ensurePiMigrations :49`,
PI edit `:1900`, `checkInvoicedQtyCeilingAfterEdit :665`, `mapPurchaseLinesToAccounts :170`,
`buildPiApprovalLegs :35`, `isPiEditable :34`, `checkGrnLineQtyEdit :135`,
`checkConvertAvailability :81`, `clampDecrement :138`, `three-way-match by-po :303`,
`supplier-payments :124/572/733`, `buildSupplierPaymentLifecycle :827`. The in-transit page
really is deleted and the redirect really is `dashboard-routes.tsx:378`. All 17 tables exist.

---

## 4c — `docs/modules/products.md`

| # | Contradiction | Resolution |
|---|---|---|
| R1 | **Every page-side anchor was 3–5 lines stale** (a block of imports moved): `ProductsPage :2004`→`:2007`, `VariantEditorDialog :651`→`:654`, `MaintenanceView :1109`→`:1112`, `CustomerAssignmentsSection :469`→`:472`, `ProductionConfig :376`→`:379`, `CategoryBadge :363`→`:366`, `BOMPage :457`→`:462`, `ProductDocumentsPage :87`→`:92`. Under the ±8 gate, all eight were "green". | All re-derived, in Entry points, the table, the Gotchas and the playbook. |
| R2 | The doc's own stamp said `index.tsx` is **5,307** lines; its Gotchas said **5,316**. | Actual **5,316** — the Gotchas were right. Stamp superseded. |
| R3 | Master-preset bulk replace cited as `bom-master-templates.ts:189`; `app.put("/")` is `:190`. | Fixed in flow, table and playbook; the two put-handlers are now distinguished by path (`/` vs `/:id`). |
| R4 | "flags a `masterPending` future master change (`:189`)". There is no `masterPending` field: it is `masterPendingByProduct` (built `:184-206`) surfaced as **`masterPendingEffectiveFrom`** (`:262`). | Renamed and re-anchored. |
| R5 | Same `/api/files` disposition error as C8. | Rewritten identically, so the two guides now agree. |

**Confirmed still true:** `products.ts` 1245, `customer-products.ts` 1235, `bom.ts` 1454,
`bom-master-templates.ts` 243, `product-configs.ts` 88, `maintenance-config.ts` 248,
`mdm.ts` 248 — all exact. **Every API anchor exact**: `ensureProductCreatedAtColumn :28`,
`rowToProduct :161`, POST `:584` / PUT `:730`, `resolveProductPriceAsOf :998`,
price-history GET `:1061`, prices POST `:1087`, `resolvePrices :95`, prices POST `:434`,
`bom.ts` templates bulk `:377` / single `:484`, `resolveMaintenanceConfigAsOf :66`,
`/resolved :120`, `/history :141`, `/changes :174`, `resolveRow :148`, detection-run `:232`,
`ProductCatalog catalog.tsx:138`. The "`/templates` must precede `/:id`" rule is real and
documented in-source at `bom.ts:9`, and holds (`GET /templates :231` before `GET /:id :1336`).
`rowToTemplateListItem :87` and the "~1.95 MB" figure both check out (`bom.ts:84`).
`baseProductCode` is at `index.tsx:36` ("near the top" ✓); modular photos really do go
through `/api/files?resourceType=modular` (`index.tsx:2901`, `catalog.tsx:29`).
MDM really is detection-only.

---

## 4d — `docs/modules/rnd.md`

| # | Contradiction | Resolution |
|---|---|---|
| D1 | "**`productionBOM` is dead (removed Task #8)**" — false on the backend. `rd_projects.production_bom` exists; `rowToProject` parses it (`:136`), create INSERTs it (`:432`), PUT persists it (`:587-592`). | Rewritten as **backend-live, UI-dead**, with the warning that a write dropping it silently blanks the column. |
| D2 | "leftover comment markers at `detail.tsx ~2225` and `~2739`" — **there are none**. `grep productionBOM src/pages/` returns zero hits repo-wide; `:2225` is a right-rail layout comment and `:2739` a defects textarea. | Claim deleted, with a note that it was checked and found absent. |
| D3 | "Pricing-target cols are snake_case … Most other R&D cols are camelCase (`projectId`, `productCategory`)" — backwards. **Every physical column is snake_case** (`tests/db-schema.json`: `actual_cost`, `product_category`, `project_type`, `production_bom`, …). The camelCase is the *identifier the route SQL writes*, rewritten by `column-rename-map.json` (921 entries). | Both the Data-model bullet and the Gotcha rewritten to name the mechanism, which is the thing that actually matters when adding a column. |
| D4 | Edit Project modal cited `detail.tsx:2421` — that line is a "Clear override" button in the manual-labour-cost card. The modal is `:2454`. | → `:2454`. |
| D5 | Status buttons cited `detail.tsx:1764-1858`; `:1764` is a prototype `labourHours` span. The action block is `:1795-1860`. | → `:1795-1860`, plus the handler lines (`handleComplete :450`, `handleHold :483`, `handleResume :489`). |
| D6 | Page anchors 1–4 lines stale: `RDProjectDetailPage :222`→`:226`, `CreateProjectDialog :984`→`:986`, `SummaryView/PipelineView/ReportsView :485/716/776`→`:487/718/778`, `ProjectCard/DraftCard/StageProgressBar :313/197/96`→`:315/199/98`, `getStageLabels :78`→`:82`, `makeBlankIssuanceLine/MilestoneStatusChip :131/150`→`:135/154`, `RDMaintenancePage :93`→`:94`. | All re-derived (table, Entry points, Gotchas, playbook). |

**Confirmed still true — this guide's API half was the most accurate of the six.** All six
status-transition endpoints (`:796/862/915/976/1038/1098`), all four `stock_movements`
INSERTs (`:1224/1460/1699/1852`), `computeLabourCostSummary :259` with its comment block
`:230-258`, the `rd_labour_hours`-missing graceful degrade (`:286`), the "PUT does not own
`actualCost`" comment (`:576-580`), `rowToProject :115`, create `:383`, PUT `:543`,
`issue-material :1157`, issuances `:1403`, batch `:1555`, reversal `:1807`,
`labour-cost PATCH :2172`, `labour-hours POST :2048`, all four `rd-team-members.ts`
handlers, the `worker.ts:1380-1381` mounts, and the 2,261 / 3,176-line counts — **every one
exact**. "No automated tests cover R&D" re-confirmed (`ls tests/` → no `rd-*`). One
enrichment: `actualCost` is recomputed at `:1281`, `:1512` **and** `:1768`, not only `:1281`.

---

## 4e — `docs/modules/sales.md`

| # | Contradiction | Resolution |
|---|---|---|
| S1 | `runSofaComboPass` "called from SO POST (`:2043`) and PUT (`:3589`)" — cited twice. Actual call sites: **`:2121`** and **`:3667`**. | Fixed in Core flows 1, 3 and 4. Confirmed these are the *only* two call sites. |
| S2 | `createProductionOrdersForSO` "called at `:2457`" → actual **`:2535`** (a second call site exists at `:3982`, previously unmentioned). | Both given. |
| S3 | `app.post("/copy-for-service-order")` `:5094` → actual **`:5172`** (78 lines off). | Fixed. |
| S4 | `ensurePendingMigrations` `_helpers.ts:1273` → actual **`:1283`**. Cited in the gated table and the playbook — and in `service-repair.md` too. | Fixed in both guides. |
| S5 | `seatHeightOf` `sofa-combo-pass.ts:46` → actual **`:64`**. | Fixed. |
| S6 | "invalidation config at `sales-orders.ts:374 / 444 / 496 / 523`" — there are **five** `withSnapshot` configs, at `:374 / 452 / 522 / 574 / 601`; three of the four listed were wrong. "The rationale comment is at `:5599`" → actual **`:5677`**. | Both corrected. |
| S7 | `SalesOrderDetailPage :337` → `:338`. | Fixed (Entry points, table, playbook). |
| S8 | Consignment playbook: CO confirm `:1578` → **`:1700`**; CO edit `:1695` → **`:1817`**. | Fixed; cancel `:2475` and hub `:2618` added. |
| S9 | Stamp said 5,626 + 1,452 lines while Entry points said 5,704 + 1,462. | Actual **5,733 / 1,462** as of 19:16 — see the concurrency note in 4g. Superseded. |

**Confirmed still true:** the three top-level handler anchors — SO create `:1581`, confirm
`:2362`, edit `:2964` — are **exact**, as are `rowToSO :243`, `rowToSOList :307`,
`createProductionOrdersForSO :576`, `cascadeSOStatusToPOs :773`, `applySofaCombos :209`,
`findComboSubset :98`, `resolveLineBasePriceSen :76`, `runSofaComboPass :132`,
CO create `:653`, CO status-changes `:1133`, `ConsignmentNotePage note.tsx:454`,
`SofaCombosPage :370`, `SalesPage :172`, `CreateSalesOrderPage :214` (+ wrapper `:206`),
`CopyFromSourceModal :2395`, `LineItemCard :3021`, and the `worker.ts:1195` mount.
All 18 tables in Data model exist. The item-catalog-snap import really is at `:42`.

---

## 4f — `docs/modules/service-repair.md`

| # | Contradiction | Resolution |
|---|---|---|
| V1 | **Every `sales-orders.ts` offset in this guide was wrong — including the ones the 2026-08-13 pass had just "corrected".** It claimed SO create `:1503`, the `isServiceOrder` flag `:1751`, `body.caseId` `:1758`, pricing guards `:1836`/`:1853`. Actual: create **`:1581`** (which `sales.md` had right all along — the two guides disagreed), flag **`:1829`**, `body.caseId` **`:1836`**, and the two `if (!isServiceOrder && …)` skips at **`:1914`** and **`:1931`**. | Core flow 3, the pricing Gotcha, the table row and the playbook all re-anchored; the `caseId`-on-a-non-service-order rejection (`:1837-1840`) and unknown-case 404 (`:1844-1852`) added. **The cross-guide disagreement is the lesson: two guides citing the same handler at two different lines means at least one is wrong, and nothing was checking.** |
| V2 | The gated table row `| SV-order pricing skip | sales-orders.ts:1751 |` was 163 lines off yet CI was green — the symbol cell has no backticks, so `docs-module-guide-anchors` skips the row entirely. | → `:1914`. Recorded here as a **gap in the gate**, not just a fixed row (see J16 below). |
| V3 | "**`caseid` is snake_case in SQL**" — it is not; it is **folded lowercase**, one word, no underscore (`tests/db-schema.json`: `sales_orders.caseid`, `stock_adjustments.caseid`, and likewise `production_orders.repairscope`, `sales_order_items.repairscope`). The distinction matters because `column-rename-map.json` maps `caseId → case_id`, a column that does not exist on these tables. | Gotcha rewritten with the rename-map warning. |
| V4 | `ensurePendingMigrations` `_helpers.ts:1273` → `:1283`; the `caseid` ALTER itself is at `:1327`. | Fixed. |
| V5 | `ServiceCaseDetailPage :203` → `:204`; `ServiceOrderDetailPage :128` → `:129`. | Fixed in Entry points, table and playbook. |
| V6 | "Never fork the ~1400-line sales list" — `src/pages/sales/index.tsx` is now **2,181** lines. (The in-code comment at `service-order/index.tsx` still says 1400; that is source, left alone.) | Figure corrected, with the stale in-code comment noted. |

**Confirmed still true — the rest of this guide is exact.** `service-orders.ts` 1,859 lines;
`ensureServiceOrderMigrations :531`, create `:556`, mode `:1214`, returns `:1468`,
scrap `:1669`. `service-cases.ts`: `STATUS_TRANSITIONS :60`, `sanitizeRootCauses :178`,
`synthesizeRootCauses :208`, `ensureCaseLinkColumns :239`, `nextCaseNo :366`,
`rowToApi :386`, create `:614`, edit `:757` — all exact. All four `repair-scope.ts` anchors
(`validateRepairScopeInput :292`, `filterWipsByRepairScope :410`,
`filterWipsByRepairComponents :443`, `canonicalizeComponentPicks :524`) exact.
`deriveTopLevelWipKey bom-wip-breakdown.ts:125`, `stock-adjustments.ts:209`,
`useSOMode so-mode.ts:27`, `worker.ts:1419-1420`, `service-cases/detail.tsx` = 3,600 lines,
and every panel anchor in it (`CasePipeline :965`, `RootCausePanel :1052`,
`StockTopUpPanel :2448`, `SpawnServiceOrderModal :3096`) — exact. The singular-vs-plural
split is real: the four `src/pages/service-order/*` files are 6–18 lines of
`export { default } from "@/pages/sales…"`, read in full. Migrations **0164**
(`stock_adjustments_caseid`) and **0165** (`sales_orders_caseid`) both exist in
`migrations-postgres/`. All four named tests exist.

---

## 4g — UNMEASURED, and what this pass did NOT check

**First, a live hazard worth more than any single correction below.**
`src/api/routes/sales-orders.ts` **was being edited by a different session throughout this
pass** — 5,704 → 5,716 (19:10) → 5,733 (19:14, rewritten again 19:16:49). Every offset into
it was re-derived three times, and one intermediate self-check read the file *mid-write* and
produced 15 spurious failures that cleared on a re-read. Two consequences:

1. **Every `sales-orders.ts` offset in `sales.md` and `service-repair.md` was true at
   `wc -l = 5,733` and was re-asserted against the live file at the end of the pass.** If that
   count has changed by the time you read this, re-derive before trusting them. No other file
   in the six guides moved during the pass.
2. **Never derive an anchor from a file another session is writing without re-reading it after.**
   A mid-write read looks exactly like real drift, and "fixing" the doc from it would have
   written 15 wrong numbers under a fresh `Last verified` stamp — precisely the failure this
   whole audit file exists to prevent.


**No production state is asserted anywhere in this pass.** No DB credentials were available
(`.dev.vars` carries a rotated password); nothing here was run against prod. Concretely:

- **Every schema claim above is from `tests/db-schema.json`, not from prod.** That file is a
  checked-in snapshot. Whether the live database matches it today is **UNMEASURED**. The
  query that would settle it is `SELECT table_name, column_name FROM
  information_schema.columns WHERE table_schema='public'` — and, per the `_centi→_sen`
  lesson, it must be unioned with `pg_matviews`, which `information_schema.views` misses.
- **Whether the `PENDING_APPROVAL`/`APPROVED` backfill has actually run on prod is
  UNMEASURED.** `ensurePiMigrations` runs it at the top of PI writes, so it should have —
  but "the code runs an UPDATE" is a claim about history, not about production today.
  `SELECT status, count(*) FROM purchase_invoices GROUP BY 1` settles it, and should be run
  before anyone acts on the corrected lifecycle section.
- **No test was executed for this pass** beyond `tests/docs-module-guide-anchors.test.mjs`,
  `scripts/check-docs-freshness.mjs` and `scripts/check-codebase-map.mjs` (all three green
  after the edits). The named tests in the six guides were verified to **exist** and, for
  `customer-notify` / `customer-quotation-batched`, to test what the guide says they test —
  the other 12 were not opened.
- **Frontend behaviour was read, not run.** Claims like "FE shows a Confirm dialog before
  saving" or "`Users.tsx` hides Disable/Reset/Delete unless SUPER_ADMIN" were left in place
  on the strength of the backend gate, not verified in a browser.
- **`consignment-notes.ts` (2,152 lines) and `sofa-combos.ts` were not opened** — only their
  line counts and mount points were checked. The CN dispatch/delivered idempotency claim
  (folded-lowercase `dispatchemailat` / `deliveredemailat`) in `sales.md` is therefore
  **carried forward unverified** from the 2026-08-13 pass.
- **`mail-center.ts` (2,476 lines) was not opened.** Only `mail-prefs.ts` and the
  `classifyCategory` call sites in `mail-center/index.tsx` were read; the Mail Center data
  model bullet in `customers.md` is carried forward unverified.
- **The three audit-doc `file:line` tables from Part 3d are still not gated** and were not
  touched here.

## 4h — COLLECTED: judgement calls, NOT decided here

- **J16 — `docs-module-guide-anchors` has two silent blind spots, both hit in this pass.**
  (a) It only reads the `Key functions / sections` table, so every anchor in Entry points,
  Core flows, Gotchas and the playbook is ungated — that is where ~30 of this pass's ~40
  wrong offsets lived. (b) A table row whose symbol cell contains no backticks is dropped
  with no warning, which is how a 163-line-stale row stayed green for a week. Extending the
  collector to prose anchors and making an unparseable symbol cell **fail** rather than skip
  are both small changes — but both will light up rows across all 15 guides at once, so the
  size of that first red build is the owner's call, not mine.
- **J17 — the ±8 window hides the drift class this pass found most often.** Nine of the
  corrections were 1–5 lines. Each is individually harmless; collectively they are the
  signal that a file moved, and they are exactly what a tighter window would catch early.
  Tighten to ±2, or accept that small drift is untracked between manual passes?
- **J18 — `purchase-invoices.ts:10`'s header comment contradicts `PI_EDITABLE_STATUSES`.**
  One says CONFIRMED is locked for editing, the other (and the live PUT gate) says it is
  editable. This pass documented the code's behaviour and flagged the comment. Fixing the
  comment is a one-line source change and needs an owner who can confirm which is intended.
- **J19 — two migration directories, one numbering namespace in the docs.** `migrations/`
  and `migrations-postgres/` number differently; the guides cite bare numbers ("mig 0183")
  that only resolve in the latter. I nearly filed a false "this migration does not exist".
  Prefix the numbers (`pg-0183`) in docs, or add a note to `CLAUDE.md`?

---

# Part 5 — the last three unread docs (2026-08-19)

`npm run trust` had reported **79 of 83** live docs read against the source for days, and named
the same three every time:

- `docs/ROADMAP-PHASE-C.md`
- `docs/design/CHANGELOG-zh.md`
- `docs/OWNER-DECISIONS.md`

They are listed literally above so the coverage counter in `scripts/trust-report.mjs` can see
them. All three are now opened and corrected.

## 5a — `docs/ROADMAP-PHASE-C.md`

**The failure mode a roadmap has is the opposite of a reference doc's:** it does not go wrong by
describing code that changed, it goes wrong by listing as *to build* something that is already
there — or, worse here, by declaring shipped something that exists but is switched off. Its
2026-08-13 header said flatly *"all seven quick-win subsets have shipped"*. Re-measured, that is
true of three of them.

| # | Doc's claim | What the tree holds | Sev | Fix applied |
|---|---|---|---|---|
| **E1** | header: *"all seven quick-win subsets have shipped"* | **3 of 7.** #3 (PO queue) and #4 (MDM nightly) are code-present but not operating, and #5 never existed in the form claimed. Detail in E2-E5. | **HIGH** | Blanket sentence withdrawn; replaced with a 7-row per-item table, each cell carrying its own proof anchor. |
| **E2** | *"#3 PO emission on a queue (`src/api/queues/po-emission-consumer.ts`)"* | The consumer and producer exist, but **both binding blocks in `wrangler.toml:165` / `:169` are commented out**, so `enqueuePoEmission` returns `{ via: "inline", reason: "PO_EMISSION_QUEUE binding not configured" }` (`src/api/lib/queue-po-emission.ts:107`) and `src/api/routes/sales-orders.ts:2583` keeps the synchronous path. The consumer's own header calls itself *"dead code path-wise"*. | **HIGH** | Marked code-only-not-active, in the header table and the sequence table. |
| **E3** | *"#4 duplicate detection (`src/api/lib/mdm-detect.ts` + `src/api/routes/mdm.ts`)"* — the quick-win is defined in §4 as *"a nightly job that flags suspected duplicates"* | Detection fires **only** from `POST /api/mdm/detection/run` (`mdm.ts:232`), whose own comment reads *"TODO once Cron infra exists … wire this to a nightly schedule"*. **No file in `.github/workflows/` mentions mdm.** `/review-queue/:id/merge` (`mdm.ts:212`) also just flags the row — no merge, no FK repoint. | **HIGH** | Marked half-built; the missing nightly and the no-op merge named explicitly. |
| **E4** | *"#5 `mv_revenue_by_month` — shipped in 0050"* | **`0050_mv_revenue_by_month.sql` is an intentionally-empty D1 placeholder** whose body is `SELECT 1 AS noop`. The real views were `9901`/`9902`, which are **no longer present in `migrations-postgres/`**, and `0123_drop_dashboard_mvs.sql` drops all five plus `refresh_dashboard_mvs()` — because, per its own header, *zero frontends read them*. The live model is the write-through `dashboard_snapshot` table (`0122`). | med | Marked never-shipped-as-written / superseded, with `0122` named as the replacement. |
| **E5** | §2 acceptance: *"a tamper detection job runs nightly"*, *"the trigger blocks UPDATE / DELETE"* | **Neither exists.** `CREATE TRIGGER` appears **zero** times in `migrations-postgres/` (253 files). `verifyJournalChain` (`src/api/lib/journal-hash.ts:309`) has **no caller anywhere in `src/`** — the only other occurrence of the name is a comment at `src/api/routes/accounting.ts:11753` — and no workflow invokes it. The chain is being collected and never checked. | **HIGH** | Both marked not-started in the sequence table; the "no caller" fact stated rather than the file's mere existence. |
| **E6** | §7 *What*: daily dump *"plus a GitHub Actions artifact retained for 90 days as the off-vendor floor"* | **No such artifact.** `.github/workflows/backup.yml` contains **zero `upload-artifact` steps**; it uploads to Supabase Storage and prunes via `POST /api/internal/backup-prune` (`:207`). Dump and store are the same vendor, so **there is no off-vendor copy at all**. `docs/DR-RUNBOOK.md:9` recorded exactly this on 2026-08-13 — **this roadmap kept asserting the opposite for six days**, which is the two-docs-one-truth shape D60 was filed for. | **HIGH** | Sentence corrected in place in §7, and again in the header; the sequence table's W10-W11 row now says "same vendor — not off-vendor". |
| **E7** | §6 quick-win *"Google Workspace OAuth only"* shipped; §6 finish = SCIM + Microsoft + session-per-device | Quick-win holds (`auth-oauth.ts`, 2 routes; `auth-totp.ts`, 7 routes). The finish step has **nothing**: `scim` and `microsoft`/`azure` each return **zero hits in `src/`**, and `user_sessions` is only INSERTed and DELETEd by token or user (`routes/auth.ts:302, 467, 721, 1042, 1215`) — no list, no per-device revoke. | low | Marked not-started with the zero-hit evidence, so nobody re-derives it. |
| **E8** | §5 *"for D1 we use `--read-replication`"* · §1 *"the same Cloudflare D1 / Postgres database"* | D1 was retired 2026-04-27 (`7059259`, confirmed in `git log`). The 2026-08-13 header already said so but left both phrases standing in the body. **No read replica is configured anywhere** — `wrangler.toml` declares only `HYPERDRIVE` + `HYPERDRIVE_STAGING`. | low | Both struck through in place (intent stays readable) and the no-replica fact added. |
| **E9** | sequence table read as a 26-week plan of work still to do | Of its 15 rows, **3 are in the code, 5 are code-present but not switched on, 7 are not started**. A reader picking up "M1 W1-W2" would rebuild `org_id` scoping that `0049`/`0087`/`0088` + `lib/tenant.ts` already provide. | **HIGH** | A **Status measured 2026-08-19** column added to all 15 rows, plus a lead-in saying the table is a record of intent. |

**A near-miss worth recording.** The first draft of the E9 status column asserted *"the two-tenant
isolation test was not found"*. `tests/tenant-isolation.test.mjs` exists. The claim came from
having checked the migrations and the middleware and *not* the test directory — the exact shape
of `CLAUDE.md`'s "NEVER STATE PROD STATE YOU DID NOT MEASURE", one level down: never state an
absence you did not search for. The row now says what the test actually is — **static analysis,
not a two-org seed**, because (its own header) *"Hyperdrive + Supabase aren't reachable from
CI"* — which is a more useful answer than either "green" or "missing".

## 5b — `docs/design/CHANGELOG-zh.md`

A closed design-session log, in Chinese, already carrying an ARCHIVED banner and the rule that
*a ✅ in this file describes the prototype, never the shipped React app*. **It stays in Chinese;
nothing was translated.** That banner is what makes most of the file unfalsifiable-by-design
against `src/`, so this pass checked the two things that ARE checkable: the paths it points at,
and the handful of claims that happen to be visible in the React app too.

| # | Doc's claim | What the tree holds | Sev | Fix applied |
|---|---|---|---|---|
| **E10** | §一·B lists `Hookka Main Login.dc.html`, `Hookka Worker Login.dc.html`, `Hookka Worker Portal Mobile.dc.html` under 「依项目内文件补记」 ("recorded from the files in the project") | **None of the three is tracked.** `git ls-files "*.dc.html"` returns exactly three files: `docs/design/Hookka ERP Desktop.dc.html`, `… Fold.dc.html`, `… Mobile.dc.html`. The sentence sends a reader to search a repo that has never held them. | med | Note added in place (in Chinese): the four bullets are design-stage history, the artefacts live on the design tool's side, do not search the repo. |
| **E11** | delivery + source paths: `standalone/Hookka ERP Mobile (Phone).html`, `standalone/Hookka ERP Fold.html`, `docs/design/Hookka ERP Mobile.dc.html`, `docs/design/Hookka ERP Fold.dc.html`, `support.js`, `hookka-logo.png`; and "no `docs/design/source/`" | **All correct.** Directory listing confirms every one, and there is no `source/` directory. The 2026-08-13 correction holds. | — | none needed |
| **E12** | fold breakpoint 720px at `src/pages/m/MobileLayout.tsx:87` | **Exact.** Line 87 is `const fold = useMediaQuery("(min-width: 720px)");`, and `docs/design/README.md:69` agrees. The 2026-08-14 correction from 700px holds. | — | none needed |
| **E13** | 底部中间凸起的「More」九宫格按钮 · 手机版 Dark/Light 在 More 菜单，即时切换、记忆设置 | **Both live in the React app.** `src/pages/m/nav.ts:53` — `{ key: "more", …, raised: true }`, with `:46` documenting the 5-slot layout. `src/pages/m/screens/More.tsx:138` carries the toggle, and its source comment **quotes this changelog's own line** back at it. | — | none needed; recorded in the stamp so the next reader does not re-derive it |

**Not checked, and deliberately so:** the module inventory in §一 (Dashboard tiles, SO/DO/PO
flows, Service Cases, R&D, Warehouse, Employees, …) describes the `.dc.html` prototypes. Those
are 300KB+ single-file HTML exports from a design tool, and per the file's own banner they assert
nothing about `src/pages/m/`. Reading them to grade a prototype against itself would produce
coverage, not truth. **That section is carried forward unverified, and the stamp says so.**

## 5c — `docs/OWNER-DECISIONS.md`

The register of what is waiting on the owner — and the one where staleness is dangerous in a
specific direction: **a row that describes a decision already taken, or a bug already fixed,
spends the owner's attention on nothing and buries the rows that are real.** Every row was
re-read against the source it cites.

| # | Row | The claim | What the tree holds | Sev | Fix applied |
|---|---|---|---|---|---|
| **E14** | **D1** | *"`/analytics/forecast` is UNREACHABLE — delete it, or route it"* | **It is routed.** `src/dashboard-routes.tsx:548` renders `src/pages/analytics/forecast.tsx` (lazy entry at `:577`). What it lacks is a nav entry: `src/components/layout/sidebar.tsx:280` points at `/forecast` — a **different** page (`src/pages/forecast.tsx`, routed at `:471`, labelled "Forecast P&L"). Half the row's own remedy had already been applied. | **HIGH** | Row rewritten: routed-but-unlinked; the live decision is delete-or-surface, plus disambiguating two similarly-named forecast screens. |
| **E15** | **D3** | *"`/admin/health` KPIs **and** agent-console FX/LLM prices are seeded-random constants. They are tagged `_mock`, so they are honest"* | **Two different things, and the "honest" half does not cover the second.** `/admin/health` is genuinely seeded-random (`mockKpis()`, `src/api/routes/admin-health.ts:72`) and does carry `_mock: true` (`:95`) with a UI banner (`src/pages/admin/health.tsx:777`). The agent-console figures are **hardcoded constants, not random, and carry no `_mock` flag**: `USD_PER_MTOK_IN = 3` / `USD_PER_MTOK_OUT = 15` / `USD_TO_MYR_EST = 4.7` (`src/api/lib/agent-console.ts:351-353`), feeding the RM number shown against the RM 150 monthly budget (`:506`). | med | Row split into (a) and (b); (b) reframed as a stale-rate risk with an unlabelled number on screen. |
| **E16** | **D4** | *"R&D material unit cost uses six hardcoded per-item-group constants. Real costing, or label as an estimate?"* | **Real costing already landed.** `resolveFifoUnitCostSen` (`src/api/routes/rd-projects.ts:330`) reads the oldest `rm_batches` row with stock remaining; `estimateFIFOCost` (`:195`) is only the **fallback** when no such batch exists. The issuance records which number it got but not which source. | med | Row narrowed to the no-batch case (label / refuse / stay silent) — the general question was answered by code. |
| **E17** | **C6** | *"SO-2607 rows carrying state 'KL' — assign hub-h1, or leave unassigned"* | Still open, but the tooling changed **today**: `POST /api/sales-orders/backfill-hub-by-state` (`sales-orders.ts:804`) is dry-run by default, never auto-touches a dispatched order (separate review list at `:920`), and as of `#338` **also cascades the corrected hub onto `fg_units`** — before today, correcting an order still left the old hub printed on the box. The 126 / 34 counts come from a **2026-07-27** read-only script; today's are **UNMEASURED**. | med | Row updated with the repair path, the cascade, and the age of its numbers. |
| **E18** | **C7** (new) | — | BUG-2026-08-19-157 fixed the forward path but **not the units already stamped**. `POST /api/fg-units/backfill-hub?execute=1` (`src/api/routes/fg-units.ts:796`) is the repair: dry-run by default, idempotent, skips `LOADED`/`DELIVERED`/`RETURNED`, returns full per-unit before/after. The sticker prints `fg_units.customerHub` **as stored** while the list screen computes a live `COALESCE(so.hubName, co.hubName)` — so a diverged unit **reads correct on screen and wrong on the box**. **How many rows diverge is UNMEASURED**; the endpoint comment's "~190 rows" is from the 2026-06-05 incident, not from now. | **HIGH** | New row **C7** added, worded as a go-ahead question with the dry-run as the mandatory first step. |
| **E19** | **B3 · C3 · C5** | rows read as open | **They were being counted as settled.** `scripts/trust-report.mjs` marks a row settled when its line matches a five-word case-insensitive alternation — a **substring** test. B3's *"already shipped"*, C5's *"if both parts shipped"* and C3's *"genuinely abandoned"* (which contains the word "done") each tripped it. Three real questions were invisible in the headline number. | **HIGH** | All three reworded (no source change); an **editing rule** added above the tables naming the five trap words. Open count corrects **17 → 21**; no new problem, it was under-reported. |
| **E20** | usage table | *"payment vouchers / official receipts — route 404"* | The handlers exist, mounted under `/api/accounting` (`worker.ts:1327`): `payment-vouchers` at `accounting.ts:8316`, `official-receipts` at `:8643`. A 404 is what a probe of a **top-level** `/api/payment-vouchers` returns. Row counts remain **UNMEASURED**. | med | Noted inside **D2**, which also gained the exact anchors for the `/restate` asymmetry (`:8584` exists; official receipts have `:8643` / `:8672` / `:8765` and no restate). |
| **E21** | **D5 · D6** | canary comment · commit convention | **Both still true**, re-verified. `deploy.yml:294` still tells reviewers the canary shares production's Hyperdrive, which `docs/CANARY-DEPLOY.md:70-78` refutes (preview → `HYPERDRIVE_STAGING`). `docs/AGENTS-COMMIT-HYGIENE.md:43` and `:51` still route commits through `docs/archive/UPGRADE-CONTROL-BOARD.md`, which `docs/SDK-MIGRATION-STATUS.md:90-91` says not to use. | low | Kept open; both rows gained exact file:line so the next pass does not re-derive them. Note the anchor for the SDK quote is `:90-91`, not the `:85-87` the earlier J6 note gave. |
| **E22** | **A1-A6 · B1-B5 · C1-C5** citations | `WORK-TRACKER:1158 / 1207 / 1294 / 1370 / 3771`, `PERF-BACKLOG:141`, plus `src/lib/pcb.ts`, `src/lib/leave-entitlement.ts`, `qc-pending.ts` bulk-skip, `three-pl-vehicles` collisions, `job_cards.completed_at` | **All resolve, and all still say what the rows say they say.** `resolvePcb` at `src/lib/pcb.ts:352`; `resolveEntitlementDays` at `src/lib/leave-entitlement.ts:266`; `POST /bulk-skip` at `src/api/routes/qc-pending.ts:2459`; `GET /collisions` at `src/api/routes/three-pl-vehicles.ts:153`; `migrations-postgres/0228_job_cards_completed_at.sql` + writers in `production-orders.ts`. | — | none needed |

## 5d — UNMEASURED, and what Part 5 did NOT check

**No production state is asserted anywhere in Part 5.** No DB credentials were available
(`.dev.vars` carries a rotated password; a connection attempt returns `28P01`), and nothing here
was run against prod. Concretely:

- **Everything in 5a is a claim about the repository, never about the deployment.** "The queue
  binding is commented out in `wrangler.toml`" is a fact about this tree; whether the deployed
  Cloudflare project has a binding declared elsewhere, or whether any migration in
  `migrations-postgres/` has actually been applied to the live database, is **UNMEASURED**.
- **How many FG units carry a stale hub (C7) is UNMEASURED.** The number the owner needs is
  the `wouldUpdate` / `moves` output of `POST /api/fg-units/backfill-hub` with **no** `execute`
  flag. That is the whole point of the row: the dry-run is the measurement, and it must be run
  by someone with access before anyone acts.
- **Row counts behind the `[LIVE]` / `[LATENT]` tags were not re-measured.** They come from the
  2026-08-14 pass; the tags were left as they stood. If a feature has been switched on since,
  a LATENT tag is now wrong and this pass would not know.
- **The `.dc.html` prototypes were not opened** (see 5b) — only the directory listing,
  `git ls-files "*.dc.html"` and the three React-side claims.
- **No test was executed for this pass** beyond the four gates: `check-docs-freshness.mjs`,
  `check-codebase-map.mjs`, `gen-api-docs.mjs --check` and `npm run trust`. Test files named in
  the corrections were verified to **exist**, and `tests/tenant-isolation.test.mjs` was read for
  what it asserts — it was not run.
- **Every dollar / engineer-week figure in `ROADMAP-PHASE-C.md` remains unverifiable from
  source.** It is business projection and is labelled as such in that doc's header.

## 5e — COLLECTED: judgement calls, NOT decided here

- **J20 — `ROADMAP-PHASE-C.md` is now more correction than roadmap.** Four of its seven
  milestones are partly built, one is superseded outright, and the header carries a table
  contradicting the body. Archive it as a historical plan and open a fresh Phase C/D doc from
  the measured state, or keep patching a 2026-04-25 draft? **Archiving changes what "the plan"
  means, so it is the owner's call, not mine.**
- **J21 — the settled-row test in `scripts/trust-report.mjs` is a substring match on the whole
  row.** E19 shows it silently mis-classifying three rows for days. The doc-side fix (reword,
  plus an editing rule) is applied; the durable fix is a source change — require an explicit
  leading marker at the start of the decision cell instead of scanning prose.
  **This audit is docs-only, so the script was not touched.**
- **J22 — `#3` and `#4` are one admin action away from being true.** Both quick-wins are written,
  reviewed and compiled; what is missing is `wrangler queues create po-emission` plus
  uncommenting two blocks, and one scheduled workflow hitting `POST /api/mdm/detection/run`.
  Provisioning infrastructure is an owner/admin action with a cost attached, so it is recorded
  here rather than filed as an engineering task.
- **J23 — nobody is checking the ledger hash chain.** `verifyJournalChain` exists, is covered by
  its own module's tests, and has no caller (E5). The chain is accumulating a guarantee that is
  never verified, which reads as stronger than "no chain at all" while being worth the same.
  Wiring it to the existing `agent-heartbeat-worker` cron is small; deciding what a broken link
  should DO (alert whom, block what) is not, and is the reason it is here.
