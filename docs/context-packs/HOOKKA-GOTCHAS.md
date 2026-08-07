# Hookka — Hard-Won Gotchas

Read this BEFORE touching schema, money, SQL, or shipping. These are the
non-obvious traps that have repeatedly cost real time and, in one case, nearly
shipped a broken prod. They are Hookka-specific and intentionally NOT in the
generic context packs.

## Schema / migrations (the #1 trap)

- **Deploys do NOT auto-run Postgres migration files.** `deploy.yml` does not
  replay `migrations-postgres/*.sql` (the D1 migrations step was retired). A
  migration file alone is **INERT on prod**. A new column reaches prod ONLY via
  a runtime self-apply: a module-level promise running idempotent
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, **awaited at the TOP of the
  relevant POST/PUT handler, before the first INSERT/UPDATE that uses the
  column.** Reference patterns: `ensurePendingMigrations` in
  `src/api/routes/sales-orders.ts`, `ensureGrnMigrations` in `grn.ts`. Skip this
  and the first write 500s on a missing column (BUG-2026-06-20-002 — caught in
  verify-live, one step from a broken prod). Still write the migration file too
  (record + SQLite test mirror), but the runtime self-apply is what's load-bearing.

- **Make new columns snake_case.** Route SQL is written camelCase and translated
  to snake_case by `src/api/lib/supabase-compat.ts` using
  `src/api/lib/column-rename-map.json`. A camelCase column referenced in route
  SQL **without** a rename-map entry **silently 400s** ("Invalid request body").
  snake_case columns need no map entry — prefer them. CI-guarded by
  `tests/sql-write-column-coverage.test.mjs`. (A 400 on a well-formed body is
  usually a DB write throwing inside a try/catch — suspect this first.)

## Production — bedframe packing pieces (sizeCode-driven)

- **A bedframe's Headboard + Divan sticker count is derived from its `sizeCode`**, via `bedframeSizeDefault` in `src/api/routes/fg-units.ts` (`parsePieces` priority: specialOrder "Headboard Only" → 1 HB; `products.pieces` JSON → verbatim; else the size-default). It knows **K/Q → HB+2Divan, S/SS → HB+1Divan, SK → HB+2Divan, dimension codes** ("152X200") by width (≥150cm → 2 Divan). **Anything else — a BLANK sizeCode, "SP", or an unknown code — falls through to the global `{count:1, names:["Full Product"]}` fallback → ONE unit, NO Divan sticker** (BUG-2026-06-22-008: 1052 had a blank sizeCode; 18 SK/SP/dimension SKUs had unrecognised codes — each silently shipped 1 "Full Product"). Bedframe `sizeCode` is now **REQUIRED** on products POST/PUT (blank → 400). To fix already-generated orders you must set the product's sizeCode/pieces **and then** `POST /api/import/regen-fg-units {soIds, dryRun}` — `/generate/:poId` is idempotent and will NOT re-derive existing units. The sticker render loop (`production/index.tsx`) faithfully draws one sticker per fg_unit and is never the bug; the bug is always the fg_unit COUNT.

## QR / stickers / scanning / warehouse occupancy

- **QR/sticker URLs follow `window.location.origin` — the PRINT-TIME domain.**
  `packingStickerUrl` / `packingRackScanUrl` / the DO-QR / the rack-QR all encode
  `window.location.origin`, so a sticker's QR carries whatever domain it was
  **printed from**: `erp.hookka.com` (prod custom domain), the old
  `hookka-erp-testing.pages.dev` (prod fallback), or
  `staging.hookka-erp-testing.pages.dev` (staging). Scanning is **path-based and
  domain-agnostic** (the `/p/`, `/r/`, `/worker/scan` routes resolve regardless of
  host) **BUT each site resolves against ITS OWN DB** — so a **prod-printed token
  scanned on staging fails** (token doesn't exist in the staging DB), and vice
  versa. (`erp.hookka.com` is treated as prod: `worker.ts isPreviewHostname` maps
  the custom domain to prod.) **The prod fallback origin IS canonicalized →
  `erp.hookka.com` on every QR / printed link** (`src/lib/app-origin.ts`
  `canonicalizeOrigin` / `appOrigin`, owner 2026-06-26 "比较好看"); staging /
  preview / localhost keep their OWN origin so their QRs still resolve against
  their own site + DB.

- **Codes are always-scannable — there is NO time-based expiry.** A "QR expired /
  scan failed" symptom is **never a timer**; it is a **structural resolution
  failure**: an archived card (the resolver was hot-card-only), a re-exploded/edited
  order (old card deleted+rebuilt), bedframe multi-piece ambiguity, an unpersisted
  `qr_token`, or an old pre-token login-link sticker. Owner ruling (2026-06-26):
  **always-scannable, no time limit** — a 3-day expiry was explicitly **DECLINED**.
  Do NOT build a code expiry; fix the structural dying instead (archive-aware
  `resolveCard` + `pickPackingCard` + token re-read already shipped).

- **Rack assignment now mirrors warehouse occupancy via ONE choke-point —
  `applyPackingRack` (`src/api/lib/packing-rack-write.ts`).** Assigning a packing
  rack from ANY of the three entry paths — the office Packing-sheet dropdown
  (`PATCH /api/production-orders/:id {jobCardId,rackingNumber}`), the public `/p/`
  piece-sticker scan, and the worker scan — funnels through `applyPackingRack`. It
  writes the **TEXT `rackingNumber`** (job_cards + production_orders) AND **mirrors
  ONE `rack_items` row per piece** (SET inserts / re-assign MOVES / `""` CLEARS +
  recomputes `rack_locations.status` via the same CASE as the DO-dispatch stock-out),
  so the Warehouse grid shows the piece under its rack. **Before this, only the
  `/r/` rack-QR stock-in wrote `rack_items`.** The office PATCH
  (`production-orders.ts`) now calls `applyPackingRack` after its inline UPDATE
  (best-effort, hot-card only) (BUG-2026-06-25-007).

- **Warehouse identity for a packed piece = `packingPieceIdentity` ONLY** —
  `src/api/lib/packing-piece-identity.ts`, the single shared formula
  (`description = wipLabel || (productName+" "+sizeLabel).trim() || "Item"`;
  `notes = soNo ? "SO <no>" : ""`). It is used by **both** `applyPackingRack` and
  `public-rack-qr.ts` (`/p/` resolve, `currentRackOfPiece`, `pieceNotes`) so the
  office / `/p/` / `/r/` paths converge on ONE `rack_items` row (a MOVE finds the
  old row by `productName + notes`). **If you derive a piece's description/notes
  any other way you get a DUPLICATE warehouse row.** Tests:
  `tests/packing-piece-identity.test.mjs`.

## Build / ship

- **build:strict before every push** = `npx tsc -p tsconfig.app.json --noEmit`.
  The base `tsconfig.json` is LOOSER and misses errors the deploy gate fails on.
  Ignore exactly **3 known sandbox module errors**: jsbarcode
  (`production/index.tsx`) and @zxing/library (`rack-scan.tsx`, `worker/scan.tsx`).
- **Verify live on prod after every deploy — read AND write path.** Deploy exit 0
  ≠ feature works (stale chunks, silent schema-apply failures, cache bite).
- Rapid back-to-back deploys make open tabs throw "Something went wrong" (stale
  dynamic-import chunk) — not a code bug; a hard refresh fixes it.

## Data shapes

- **Money is sen (integer)** = RM × 100. Use `MoneyInput` (value is `number|null`
  in RM dollars, commits on blur) for sen-int state fields. `DiscountInput`
  (`%`-aware) computes a discount off a base amount and emits sen.

- **Every COMPUTED unit price lands on a whole ringgit, rounded UP** (owner
  2026-08-07, "我全套系统都要整除的" — the complaint was unit prices reading
  RM 995.14 / `.98`). One primitive: **`roundUpToRinggitSen`** in
  `src/lib/utils.ts`, next to `roundSen` / `distributeRoundSen`. Never hand-roll
  `Math.ceil(x/100)*100` — a source-guard test fails on a second copy
  (`tests/whole-ringgit-unit-price.test.mjs`). Scope, all deliberate:
  **UNIT prices only** (line subtotal follows as `whole unit × qty`, so don't
  re-round subtotals or invoice totals); **SST is EXCLUDED** (owner:
  "SST 就不需要" — tax keeps its cents, `roundSen` is unchanged); **computed
  values only** (a price the operator TYPED is left as typed — this is why
  `DiscountInput`'s `%` branch rounds up but its RM branch does not).

- **Sofa combos: round up, then GIVE THE EXCESS BACK.** Combo proration exists
  to make N piece prices sum EXACTLY to a negotiated total, and rounding each
  unit up breaks that. `distributeComboUnitPrices` (`src/api/lib/sofa-combo.ts`)
  resolves it: round every unit up, then hand whole ringgit back — starting with
  the line the rounding flattered most — so **the agreed combo total still
  holds**. An agreed customer price that silently grows is worse than a `.98`.
  Both the backend pass AND `src/pages/sales/create.tsx` call this one function.

- **The round-up is FORWARD-ONLY — never retro-apply it.** Rounding up always
  moves money in our favour, so re-rounding an already-issued document is a
  customer dispute, not a fix. `/recompute-so-sofa-prices` and
  `/recompute-co-sofa-prices` (`src/api/routes/import-completion/sofa-pricing.ts`)
  reprice EXISTING orders and keep the OLD floor/round/residual maths on
  purpose — there is a 🛑 DELIBERATE DIVERGENCE banner on the copy. Do not
  "fix the drift" there.
- **PO line code is mashed into the name** as "CODE - DESCRIPTION" —
  `purchase_order_items` has no dedicated code column. Recover it with
  `splitCodeName(code, name)` in `pdf-utils.ts`. GRN/PI and all sales-side docs
  DO have a proper code field (`material_code` / `product_code`) — don't split those.

## Front-end fetch / CSRF

- **CSRF is injected GLOBALLY — no fetch is ever "missing" the token.**
  `src/lib/api-client.ts` (~line 58) monkey-patches `window.fetch` to auto-add
  `X-CSRF-Token` (unless the caller already set it) + `credentials:'include'` on
  **every mutating `/api/*` request**. So a raw `fetch('/api/...', {method:'POST'})`
  with no explicit header is STILL CSRF-protected. **An audit that flags "N fetches
  missing the CSRF token" is ALL FALSE POSITIVES** — do not chase it, do not sprinkle
  `csrfHeaders()` to "fix" it. (A `patchRack` CSRF "fix" was shipped, then found to
  be a no-op for exactly this reason — BUG-2026-06-25-008b.)

## Process (how this codebase is worked)

- **Money / inventory / payroll / cascade changes:** investigate → propose with
  options → confirm before coding; when fixing one case, sweep the whole dataset
  for the same pattern. Schema/cascade rewrites go on a dedicated branch.
- **`docs/BUG-HISTORY.md` is the living bug log** — append every diagnosed+fixed
  bug (newest first). It is the source of truth, not GitHub issues.
- **Shared UI primitives** (don't hand-roll): `ObjectPageHeader`/`PageHeader`,
  `useConfirm`, `DataGrid`, `MoneyInput`, `DiscountInput`, `SearchableSelect`;
  one shared PDF letterhead via `drawLetterhead`. See `docs/UI-CONVENTIONS.md`.
