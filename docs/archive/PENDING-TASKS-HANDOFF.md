> **ARCHIVED / SUPERSEDED — stopped being true 2026-06-26.** Both open tasks shipped that same day: TASK 1 (mint resolves poNo-drifted stickers) in commit `ac29f46f` — `src/api/routes/production-orders.ts:1706-1762` now carries the CI-poNo retry *and* the `SELECT poNo, poId FROM fg_units …` fallback; TASK 2 (per-piece stacked rack layout) in commit `bf7e0459` — `generatePackingListPdf(order, extras?: DOPrintExtras)` at `src/lib/generate-packing-pdf.ts:37` with 4 `componentRacks` uses. Its `docs/archive/PACKING-SCAN-HANDOFF.md` pointer is also dead (that file is now under `docs/archive/`). Kept for history only; do not treat as current.

# Pending Tasks Handoff (excluding packing-scan)

> Single source-of-truth for every pending Hookka ERP dev task **except** the packing-sticker
> scanning + completion work — that has its own dedicated doc:
> **[`docs/archive/PACKING-SCAN-HANDOFF.md`](PACKING-SCAN-HANDOFF.md)** (mint `/p/` robustness, `jc=` sticker
> fallback, completed-row-vanish allowlist, tests). Do not duplicate that work here.
>
> Verified against `main` on 2026-06-26. Each task below was re-read at `file:line` before
> being listed — stale/already-shipped items are called out explicitly so you don't fix
> non-problems.

---

## Non-negotiable rules (read before touching anything)

These bite hardest. Full detail in `CLAUDE.md` + `docs/context-packs/HOOKKA-GOTCHAS.md`.

1. **Additive, never destructive.** A feature/fix = ADD on top. Any change to a SHARED artifact
   (a QR/sticker URL scheme, a shared component, an endpoint, a PDF/print helper, a data format)
   MUST check **every** consumer still works — internal + external, FE + BE, every scan/print/read
   site. The `/p/<token>` packing-QR change once broke the internal Worker-Portal scanner while
   only external worked.
2. **build:strict before every push:** `npx tsc -p tsconfig.app.json --noEmit` (ignore only the 3
   jsbarcode / @zxing sandbox errors). The base `tsconfig.json` is looser and lets through errors
   that fail the deploy. The pre-push hook runs tests, NOT this strict typecheck — run it yourself.
3. **Migrations do NOT auto-apply on deploy.** A new column reaches prod ONLY via the runtime
   self-apply (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, awaited at the top of the POST/PUT before
   the first write). A migration file alone is inert.
4. **New DB columns = snake_case.** A camelCase column in route SQL needs a
   `column-rename-map.json` entry or it silently 400s "Invalid request body". Read rows dual-keyed:
   `r.camelCase ?? r.snake_case`.
5. **Money = integer sen** (RM × 100); use `MoneyInput` / `roundSen`, never floats.
6. **UI mockup BEFORE building any UI/PDF change.** Owner standing requirement: render a live
   visual mockup via `mcp__visualize__show_widget` (load `read_me` modules:["mockup"] first),
   faithful to brand colours → owner approves/tweaks → THEN code.
7. **Verify live on prod after every deploy** — READ path AND WRITE path. Deploy exit 0 ≠ feature
   works. Then log the bug to `docs/BUG-HISTORY.md` (newest-first) and add a regression test.
8. **Routing:** bug fixes merge straight to `main`/prod; features go to `staging`. UI is 100% English.

---

## TASK 1 — Mint endpoint: resolve poNo-drifted packing stickers — HIGH

**Status:** REAL — not started. (This is the mint-side twin of the worker-scan fix that already
shipped; see below.)

**What it is.** The packing-sticker token mint endpoint resolves PACKING job cards by an **exact**
`poNo` or `id` match only. If an SO line was edited after the sticker was printed (line
renumbered, trailing space, case change), the mint finds no card → emits no `/p/` token → the
printed fallback URL (`/worker/scan`) opens the Worker-Portal **login page** on an external phone
instead of completing the pack.

**Verified current state (2026-06-26):**
- `src/api/routes/production-orders.ts:6055` — the mint query is still literally
  `SELECT id, poNo FROM production_orders WHERE poNo IN (…) OR id IN (…)`. No trim/case-insensitive
  retry, no `fg_units` fallback. **Confirmed unfixed.**
- The **worker-scan side** WAS fixed by commit `e92f8ce3` (2026-06-26): scan-lookup now falls back
  to (a) trim/case-insensitive poNo, then (b) `fg_units` (sticker `po` = unit's stored poNo →
  stable `poId` → live PO) after the exact poNo/id + jc-id + barcode paths miss. The mint endpoint
  was NOT brought into lock-step — that is this task.

**Files (file:line):**
- `src/api/routes/production-orders.ts:6021` — `POST /packing-rack-tokens` handler.
- `src/api/routes/production-orders.ts:6052-6065` — the PO lookup + `poIdByKey` map to extend.
- `src/api/routes/worker.ts` (scan-lookup, ~lines 481–500) — the **reference** fallback to mirror.

**Approach:**
1. After the exact `poNo IN (…) OR id IN (…)` lookup (6055) produces `poIdByKey`, for any wanted
   `poNo` that did NOT resolve, add two fallbacks (mirror worker.ts exactly, spirit byte-identical):
   - **(a)** trim/case-insensitive retry on the poNo against `production_orders`.
   - **(b)** `SELECT poId FROM fg_units WHERE poNo = ? AND poId IS NOT NULL` → load that
     `production_order` → use its id.
2. Feed the recovered poId into the same `cardsByPo` / `pickPackingCard` / `getOrCreateJobCardQrToken`
   path already there — do not fork the mint logic.
3. Keep it ADDITIVE: only recover *misses*; never override an exact hit. Only resolve to a **live**
   PO (a purged PO → honest "Not found" → reprint, same contract as worker.ts).
4. Owner reprints affected stickers; external-phone scan then mints a real `/p/` token.

**Sub-tasks:**
- [ ] Extend the PO lookup with trim/CI + fg_units fallback.
- [ ] Regression test (see TASK 3).
- [ ] BUG-HISTORY entry ("FG-PACKING mint robustness on poNo drift", 🟢 Fixed).
- [ ] Verify-live: print a drifted-poNo sticker, scan on external phone, confirm `/p/` opens.

**Gotchas:**
- `requirePermission(c, "production-orders", "read")` gates this endpoint — minting is treated as a
  read-level internal detail of "print the sticker" (same as the DO qr-token endpoint). Keep that.
- The handler is already **batched** (one PO query, one cards query, parallel mint). Add the
  fallback as a second batched query for the unresolved set — do NOT reintroduce a per-poNo loop.
- FG-PACKING stickers carry ONLY `po=` (no `jc=` like dept stickers) — that asymmetry is exactly
  what makes this fallback necessary; see TASK 2 in the packing-scan handoff for the `jc=` add.

---

## TASK 2 — Packing List PDF: per-piece STACKED rack layout — MEDIUM

**Status:** REAL — not started.

**What it is.** Owner wants the Packing List PDF to show each bedframe's component pieces stacked
**vertically with their per-component rack numbers** under the order line, instead of one flat
"RACK LOCATION" cell far to the right. For a bedframe with HB → Rack 6 and 2× Divan → Rack 19, the
operator currently sees a single merged cell ("Rack 6, 19") that loses which piece is in which rack.

Desired, per order line:
```
1 Headboard / Rack 6
2 Divan     / Rack 19
```

**Verified current state (2026-06-26):**
- `src/lib/generate-packing-pdf.ts:16` — `export function generatePackingListPdf(order: DeliveryOrder)`
  takes **only** `order`. No `extras` / `componentRacks` parameter. **Confirmed unimplemented.**
- `src/lib/generate-packing-pdf.ts:107` — the rack cell is the flat `item.rackingNumber || "-"`
  (the compact aggregate). The per-component breakdown never reaches the PDF.
- The per-component data **already exists** in the backend: `deriveComponentRacks()` returns
  `[{ label, racks }]` and the `DOPrintExtras` type already declares
  `componentRacks?: { label: string; racks: string[] }[]`. It is simply not threaded into the PDF.

**Files (file:line):**
- `src/lib/generate-packing-pdf.ts:16` — function signature to extend with an `extras` param.
- `src/lib/generate-packing-pdf.ts:100-155` — `tableBody` build + column headers/styles.
- `src/api/routes/delivery-orders.ts:3130-3149` — where `formatRacksCompact()` flattens
  componentRacks into `item.rackingNumber` (keep for back-compat; ALSO pass raw componentRacks).
- `src/api/routes/delivery-orders.ts:4590-4614` — `GET /:id/print-extras` response (already returns
  `componentRacks` per item per the type; verify it is actually populated in the payload).
- `src/lib/print-extras-shared.ts:291-349` — `deriveComponentRacks()` (source of `{label,racks}`);
  `:109-251` — `piecesFor()` (canonical HB→Divan→others ordering).
- `src/lib/generate-do-pdf.ts:128-144` — `fmtComponentRacks()`, an existing per-component formatter
  to reuse/adapt for the newline-stacked form.

**Approach:**
1. **Mockup FIRST** (owner rule): render stacked-vs-flat side by side, get approval.
2. **Backend:** confirm `GET /api/delivery-orders/:id/print-extras` returns `componentRacks` per
   item in the payload (not just the flattened `rackingNumber`). Keep `rackingNumber` for back-compat.
3. **Frontend PDF:** add an `extras?: DOPrintExtras` param to `generatePackingListPdf`. In the
   `tableBody` map, read `extras?.items?.[item.id]?.componentRacks` and build a multi-line string
   `"${label} / ${racks.join(', ') || '-'}"` joined by `\n`. jsPDF autoTable line-breaks on `\n`
   natively — no special config, just widen that column. Fallback to `item.rackingNumber` (flat)
   when componentRacks is empty/null.
4. **Ordering:** the stacked lines MUST follow `piecesFor()` order (HB first, Divan second, others
   by first-seen) so pieces and racks stay aligned.
5. **Call site:** the invoker must now `await` the print-extras fetch and pass it in.

**Sub-tasks:**
- [ ] Live mockup → owner approval.
- [ ] Backend: verify/ensure print-extras payload includes per-item `componentRacks`.
- [ ] Frontend: `extras` param + stacked formatter + widened column + graceful fallback.
- [ ] Update the call site to fetch + pass extras.
- [ ] Test print: bedframe with pieces in different racks → confirm stacked alignment.
- [ ] **CN parity:** check `generate-cn-pdf.ts` for a packing-list equivalent and apply the same.

**Gotchas:**
- `print-extras-shared.ts` is SHARED between DO and CN — any change there hits both document types.
  Prefer adapting the existing `fmtComponentRacks()` over hand-rolling a new formatter.
- `item.rackingNumber` is the COMPACT aggregate, kept for back-compat — do not remove it; layer the
  stacked view on top (additive).
- componentRacks empty where line items lack a rack# (known, expected) — that's why the `"-"`
  fallback per line matters.

---

## TASK 3 — Regression tests + BUG-HISTORY for the mint fix — MEDIUM

**Status:** REAL — depends on TASK 1 (and the packing-scan handoff's TASK 1/2).

**What it is.** Lock in TASK 1 (and, once shipped, the packing-scan handoff's mint/`jc=` work)
with a regression test, and log to BUG-HISTORY.

**Files (file:line):**
- Test: existing packing-card resolve test if present (search `tests/` for `packing-card` /
  `packing-rack-tokens`), else add a new `tests/packing-mint-resolve.test.mjs`.
- Docs: `docs/BUG-HISTORY.md` (newest-first, follow the template).

**Approach / sub-tasks:**
- [ ] Mint endpoint: poNo drifted → fg_units fallback resolves → token minted (assert non-empty token).
- [ ] Mint endpoint: trim/case-mismatch poNo → resolves → token minted.
- [ ] Mint endpoint: purged PO → no token (honest miss), no crash.
- [ ] BUG-HISTORY entry for TASK 1, 🟢 Fixed, newest-first.

**Gotchas:**
- Mirror whatever fixture style the worker.ts scan-lookup test already uses so the two paths stay
  comparable; the goal is mint and scan resolving the *same* drifted sticker identically.

---

## Stale / already-shipped — do NOT redo

These appeared in the original scoping but are **already done** (or never were a task). Confirmed
against git log / source on 2026-06-26.

- **STICKER-SCOPE feature (TaskList #60–64).** FULLY SHIPPED in commit `73cb3879` (2026-06-24):
  the two sticker loaders (`loadFabSewStickers` at `src/pages/production/index.tsx:4407`,
  `loadFoamPackingStickers` at `:5515`) already scope to the visible/ticked SO/CO group via
  `?scope=<tokens>`, the backend `GET /api/production-orders` already accepts `?scope=` and narrows
  the JC fetch, tests exist (`tests/production-sticker-scope.test.mjs`), tsc clean, full suite green.
  The `[pending]` flags on #60–64 are a task-list sync lag, not real work. **Action: update task
  status only; no code.**
- **Completed-row-vanish inconsistency.** Largely addressed: `forceShowCompletedIds` allowlist
  (commits `baa3a07b`, `0f694524`) plus the live editable-field overlay (`d5bcbe20`, 2026-06-26)
  now show rack/PIC/completion/Sent edits instantly with no flicker. Treat as **awaiting owner
  floor verification** (below), not a coding task — only revisit if the owner reports a specific
  completion path that still drops a row, then wire that path into `forceShowCompletedIds`.

---

## Awaiting owner verification (NOT dev tasks)

Backend-shipped and waiting on live confirmation by the owner — no code to write unless a check
fails. Items reference `docs/WORK-TRACKER.md`.

1. **Packing sticker scanning on staging:** owner picks Rack 9 on the packing sheet → confirm it
   appears in the Warehouse grid; preview/print is fast now. Backend shipped (`3ec97e43`,
   `bcb000d4`, `152ad257`). Full spec in `docs/archive/PACKING-SCAN-HANDOFF.md`.
2. **Completed-row reveal on the floor** (see Stale section): owner to confirm one-by-one and
   multi-dept completion paths keep the row visible until reload.
3. **Document-date reporting basis:** GL/P&L now bucket by document date, not entry date
   (`src/lib/doc-date.ts`). Owner verifies a backdated invoice lands in its DOCUMENT month.
   Shipped `f7c49d8a` + migrations 0190/0191.
4. **Opening_date hard floor:** all financial reports exclude pre-opening data (floor = 2026-05-22,
   17 read paths). Expected near-zero AR/AP/P&L/BS post-05-22 until real opening balances are
   entered. Backend shipped, 11 tests.
5. **purchase_invoices PARTIAL_PAID constraint:** migration `Hookka迁移11` must be pasted into the
   Supabase SQL Editor, then live-test one partial supplier payment / discount allocation. Runtime
   relaxation already applied; the migration adds the permanent named constraint. Shipped `78f47bb2`.
6. **QR canonical domain:** prod's legacy `hookka-erp-testing.pages.dev` now renders as
   `erp.hookka.com` on every QR; staging/preview/local keep their own origin. Shipped `fb31ab80`.
7. **Barcode column + QR resolution bump:** Schedule "Barcode" column switched from QR to 1D
   Code 128 (gun-scannable); FG-sticker/schedule QR render bumped 300→600px. Shipped `5af9bb40`,
   `84e18f74`.
8. **Customer email drain:** `/deliver` + `/invoice` now stamp dispatchEmailAt/invoiceEmailAt on the
   DO at the backend transition choke-point. Owner does ONE real dispatch/invoice (watch the stamp
   live) or uses the resend button. Shipped (`8c91864b`).

---

### Pointers
- **Packing-scan work** (mint `/p/` robustness, `jc=` sticker fallback, completed-row allowlist,
  tests): **[`docs/archive/PACKING-SCAN-HANDOFF.md`](PACKING-SCAN-HANDOFF.md)** — single source of truth;
  TASK 1 above is the mint-endpoint half of that effort surfaced here because it lives in
  `production-orders.ts`.
- **Find the code:** `docs/CODEBASE-MAP.md`. **How to do recurring tasks:**
  `docs/PLAYBOOKS.md`. **Traps:** `docs/context-packs/HOOKKA-GOTCHAS.md`.
