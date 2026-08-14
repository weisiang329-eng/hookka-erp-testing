# Quality, Warehouse, Scanning & Platform — Module Guide

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](../DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `src/api/routes/{qc-pending,qc-inspections,qc-templates,warehouse,public-rack-qr,public-rack-write,public-do-qr,auth}.ts`, `src/api/lib/{auth-middleware,rbac,packing-rack-write,packing-piece-identity}.ts`, `src/api/worker.ts`, `src/pages/{quality,warehouse,rack-scan,do-scan}.tsx`, and `tests/`.
> Corrected 2026-08-13: **`qc-pending.ts` is 2,494 lines, not 741** — every QC anchor was stale by 200–1,900 lines (`currentSlotIso` :310, `generatePendingForSlot` :1699, `/:id/start` :1943, `/:id/complete` :2371). The cron trigger is `worker.ts:757`. Warehouse, both public-scan routes, auth-middleware and RBAC anchors all verified within ±60 lines. All four named tests exist.

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Four cross-cutting concerns that don't belong to one business domain: **QC inspections**
(templated checklists, cron-scheduled PENDING slots, PASS/FAIL results), **Warehouse**
(rack locations, `rack_items` occupancy, stock in/out + movement history), **public no-login
scanning** (phone-camera QR flows for rack stock-in `/r/`, piece-sticker → rack `/p/`, and
DO dispatch/deliver `/do-qr/`), and the **platform spine** (session auth + double-submit
CSRF, RBAC, archive/restore, health/RUM telemetry). The scanning flows are auth-BYPASSED by
prefix and gated only by an unguessable token or the plain rack id — so tenancy/idempotency
is enforced by hand in the handler, not by the middleware.

## Entry points
- Pages
  - `/quality` → `src/pages/quality.tsx` (`QualityPage` — Pending / History / Templates tabs)
  - `/warehouse` → `src/pages/warehouse.tsx` (`WarehousePage` — Grid / Stock In-Out / History)
  - `/rack-scan` → `src/pages/rack-scan.tsx` (`RackScanPage` — mobile rack QR stock-in; per-piece)
  - `/do-scan` → `src/pages/do-scan.tsx` (`DoScanPage` — mobile DO sticker scan)
  - Platform/admin: `src/pages/admin/health.tsx`, `src/pages/settings/index.tsx`,
    `src/pages/maintenance.tsx`, `src/pages/notifications.tsx`, `src/pages/track/index.tsx`
- API routes
  - QC cron/pending generation → `src/api/routes/qc-pending.ts` (2494 lines)
  - QC inspections CRUD → `src/api/routes/qc-inspections.ts` · templates → `qc-templates.ts`
  - Warehouse racks + movements → `src/api/routes/warehouse.ts` (801)
  - PUBLIC rack stock-in (`/r/`) → `src/api/routes/public-rack-qr.ts` (980)
  - PUBLIC piece-sticker → rack (`/p/`) → `src/api/routes/public-rack-write.ts` (283)
  - PUBLIC DO dispatch/deliver → `src/api/routes/public-do-qr.ts` (1013)
  - Session auth → `src/api/routes/auth.ts` (1201) · gate + CSRF → `src/api/lib/auth-middleware.ts` (517)
  - RBAC → `src/api/lib/rbac.ts` · archive/restore → `admin.ts` · health → `admin-health.ts`
- Shared libs
  - Rack occupancy writer → `src/api/lib/packing-rack-write.ts` (`applyPackingRack`)
  - Shared piece identity → `src/api/lib/packing-piece-identity.ts` (`packingPieceIdentity`)

## Data model
- `qc_templates` / `qc_template_items` — checklist definitions (stage RM/WIP/FG, category, severity).
- `qc_inspections` / `qc_defects` — inspection instances + per-item results; `scheduledSlotAt` keys a cron slot.
- `qc_tags` — one row per FAIL item (status `ACTIVE`). **Written but intentionally NOT surfaced** (Phase 2 descoped).
- `rack_locations` / `rack_items` — physical racks + their occupancy mirror (one row per physical piece).
- `stock_movements` / `stock_adjustments` — warehouse in/out ledger + manual adjustments.
- `piece_pics` — per-piece photos; `racking_number` column (mig 0192) stamped for multi-piece WIP.
- `kv_config` — generic config store (public_holidays etc.); a bad key silently breaks unrelated modules.
- Platform: `users` / `role_permissions` (RBAC), `edit_presence`, `audit_events`, `file_assets`,
  `hookka_erp_metrics`, and `*_archive` shadow tables (`sales_orders_archive` etc.).
- Cross-refs: scanning flows read/write `fg_units`, `job_cards`, `production_orders`, `delivery_orders`.

## Core flows
1. **QC cron → PENDING inspections** — external cron hits `POST /api/qc-pending/trigger` (`worker.ts:757`,
   own CRON_SECRET check) → `generatePendingForSlot` (`qc-pending.ts:1699`) using `currentSlotIso`
   (`:310`, UTC+8 slots: 12:00 / 16:00, else yesterday 16:00). One PENDING inspection per active
   template per slot; the `scheduledSlotAt` dedupe set (`:1710`) makes re-triggers idempotent.
2. **QC inspect → complete** — `POST /:id/start` (`qc-pending.ts:1943`) → `POST /:id/complete` (`:2371`)
   records PASS/FAIL/NA per item and writes one `qc_tags` row per FAIL — those tags stay hidden.
3. **Rack stock-in (public `/r/`)** — `POST /api/public/rack-qr/:rackId/stock-in` (`public-rack-qr.ts:776`)
   → `findRack` (`:211`) → PER-PIECE: each scanned sticker = one `rack_items` row, qty forced to 1 →
   `buildRackStockInStatements` (`:131`) is move-aware + idempotent (also touches `fg_units`/`job_cards`).
4. **Piece-sticker → rack (public `/p/`)** — `POST /api/public/rack-write/:token/rack` (`public-rack-write.ts:228`)
   → `resolveCard` (`:80`, archive-aware) → `applyPackingRack` (`packing-rack-write.ts:71`) sets/clears the
   rackingNumber AND mirrors `rack_items`. Both `/r/` and `/p/` (plus office + worker) build the move-match
   key via `packingPieceIdentity` (`packing-piece-identity.ts:48`) — never re-inline it.
5. **DO dispatch/deliver (public `/do-qr/`)** — `POST /api/public/do-qr/:token/advance` (`public-do-qr.ts:707`)
   is forward-only through the SAME office PUT path: DISPATCH DRAFT→LOADED, DELIVER LOADED/IN_TRANSIT→DELIVERED.
6. **Login → session + CSRF** — `POST /api/auth/login` (`auth.ts:148`) issues the HttpOnly `hookka_session`
   cookie + non-HttpOnly `hookka_csrf`; `authMiddleware` (`auth-middleware.ts`) resolves the token and
   double-submit-checks CSRF on every mutating method. The prefix allow-list is `PUBLIC_PREFIXES` (`:66`).

## Key functions / sections (locate-to-function)
| Symbol / handler | file:line | Role |
|---|---|---|
| `currentSlotIso` | `src/api/routes/qc-pending.ts:310` | UTC+8 12:00/16:00 slot resolver |
| `generatePendingForSlot` | `src/api/routes/qc-pending.ts:1699` | Insert one PENDING inspection per active template |
| `POST /:id/start` | `src/api/routes/qc-pending.ts:1943` | Begin an inspection |
| `POST /:id/complete` | `src/api/routes/qc-pending.ts:2371` | Record results + write qc_tags on FAIL |
| `POST /` (inspection create) | `src/api/routes/qc-inspections.ts:255` | Ad-hoc QC inspection CRUD |
| `POST /` (template create) | `src/api/routes/qc-templates.ts:164` | Checklist template + items |
| `GET /` (racks list) | `src/api/routes/warehouse.ts:248` | Rack grid + occupancy read |
| `replaceRackItems` | `src/api/routes/warehouse.ts:204` | Rewrite a rack's `rack_items` set |
| `POST /movements` | `src/api/routes/warehouse.ts:497` | Stock in/out movement ledger write |
| `buildRackStockInStatements` | `src/api/routes/public-rack-qr.ts:131` | Move-aware idempotent per-piece stock-in |
| `POST /:rackId/stock-in` | `src/api/routes/public-rack-qr.ts:776` | Public rack QR stock-in handler |
| `resolveCard` | `src/api/routes/public-rack-write.ts:80` | Archive-aware token → packing card |
| `POST /:token/rack` | `src/api/routes/public-rack-write.ts:228` | Public `/p/` set/clear rackingNumber |
| `POST /:token/advance` | `src/api/routes/public-do-qr.ts:707` | Public DO forward transition (dispatch/deliver) |
| `resolveToken` | `src/api/routes/public-do-qr.ts:181` | 64-hex qrtoken → DO(s) resolver |
| `applyPackingRack` | `src/api/lib/packing-rack-write.ts:71` | Rack set/clear + `rack_items` occupancy mirror |
| `ensurePiecePicsRackingColumn` | `src/api/lib/packing-rack-write.ts:35` | Shared mig-0192 DDL self-apply |
| `packingPieceIdentity` | `src/api/lib/packing-piece-identity.ts:48` | Shared description + notes move-match key |
| `POST /login` | `src/api/routes/auth.ts:148` | Session + CSRF cookie issue (TOTP-aware) |
| `GET /me/permissions` | `src/api/routes/auth.ts:487` | Effective permission set for the FE |
| `authMiddleware` | `src/api/lib/auth-middleware.ts` | Auth gate + double-submit CSRF |
| `PUBLIC_PREFIXES` | `src/api/lib/auth-middleware.ts:66` | Prefix allow-list that bypasses the gate |
| `requirePermission` | `src/api/lib/rbac.ts:188` | Per-resource:action RBAC (ADMIN/SUPER_ADMIN bypass) |
| `requireSuperAdmin` | `src/api/lib/rbac.ts:285` | Hard SUPER_ADMIN-only gate for account mgmt |

## Gotchas
- **`public-rack-qr.ts` / `public-rack-write.ts` / `public-do-qr.ts` are auth-BYPASSED** via `PUBLIC_PREFIXES`
  (`auth-middleware.ts:66`). Any new endpoint under `/api/public/rack-qr/`, `/rack-write/`, `/do-qr/` is exposed
  with NO login — guard tenancy + idempotency by hand. Covered by `tests/security-public-endpoints.test.mjs`.
- **THREE+ paths put a piece in a rack and must agree on `rack_items` identity** (BUG-2026-06-25-007): office
  Packing dropdown + `/p/` piece-sticker + worker scan all funnel through `applyPackingRack`; the `/r/` rack-QR
  stock-in goes through `public-rack-qr.ts`. All build `description`(=`rack_items.productName`) + `notes`(=`SO <no>`)
  via `packingPieceIdentity`. Re-inline the formula and a re-assign MOVE can't find the old row (= duplicate).
- **QC Phase 2 is DESCOPED.** `qc_tags` rows still get written on FAIL but the owner does NOT want them surfaced
  in Inventory or as DO warnings — do not re-surface them.
- **Codes are ALWAYS-SCANNABLE, no time expiry** (owner ruling 2026-06-26). The old "QR expired" was never a timer —
  it was STRUCTURAL resolution failure (archived cards, re-exploded orders, unpersisted token). Keep fixing structural
  dying (archive-aware `resolveCard`); do NOT build time-based expiry.
- **QR/sticker URLs encode the print-time origin.** Scanning is path-based + domain-agnostic and resolves against the
  DB of whatever site you scan ON — a prod-printed token scanned on staging FAILS (different DB). Prod fallback origin
  is canonicalized → `erp.hookka.com` (`src/lib/app-origin.ts`).
- **CSRF is GLOBAL, not per-call.** `src/lib/api-client.ts:76` monkey-patches `window.fetch` to auto-inject
  `X-CSRF-Token`. NO raw fetch is ever "missing CSRF"; an audit flagging N such fetches is ALL false positives — never
  add `csrfHeaders()` to "fix" it (a rack CSRF "fix" shipped then proved a no-op).
- **RBAC: SUPER_ADMIN + ADMIN unconditionally bypass** (inside `requirePermission`, `rbac.ts:188`) so a never-seeded permission can't 403 them;
  account management is separately fenced to SUPER_ADMIN via `requireSuperAdmin` even if ADMIN holds `*:*`.
- **`admin.ts` archive/restore writes `*_archive` shadow tables** — restore must repopulate child tables in FK order.
- **`kv_config` is the generic store** (public_holidays consumed by payroll/costing) — a bad key silently breaks
  unrelated modules.
- **New columns referenced in route SQL need a `column-rename-map.json` entry** (CI-guarded) or they 400 'Invalid
  request body'; prefer snake_case. Migrations are inert unless runtime self-applied (see `ensurePiecePicsRackingColumn`).

## Common tasks (mini-playbook)
- **Add a QC template field** → column self-apply + persist in `qc-templates.ts` POST (`:164`) / PUT (`:266`); surface
  in `rowToTemplate` (`:77`) and the Templates tab in `quality.tsx`. New column = snake_case (+ rename-map if camelCase).
- **Change the QC cron slot logic** → edit `currentSlotIso` (`qc-pending.ts:310`) and keep `generatePendingForSlot`
  (`:1699`) dedupe on `scheduledSlotAt`; verify the trigger in `worker.ts:757` still does its CRON_SECRET check.
- **Touch a rack stock-in path** → change the shared `applyPackingRack` (`packing-rack-write.ts:71`) /
  `buildRackStockInStatements` (`public-rack-qr.ts:131`); NEVER re-implement `packingPieceIdentity`. Verify with
  `tests/rack-qr-per-piece.test.mjs` / `tests/packing-piece-identity.test.mjs`.
- **Add a public (no-login) scan endpoint** → add it under an existing `PUBLIC_PREFIXES` entry ONLY with a manual
  token/secret gate + idempotency; add a case to `tests/security-public-endpoints.test.mjs`.
- **Add an RBAC-gated route** → `await requirePermission(c, "<resource>", "<action>")` at the top of the handler;
  seed the grant in `role_permissions` (ADMIN/SUPER_ADMIN bypass, lower roles need the row).

## Related modules
[[production]] [[delivery]] [[inventory]] [[sales]]
