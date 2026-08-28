# Customers & Platform — Module Guide

> **Last verified: 2026-08-19** against `src/pages/customers.tsx`, `src/pages/settings/Users.tsx`,
> `src/pages/mail-center/{index.tsx,mail-prefs.ts}`, `src/api/routes/customers.ts`,
> `customer-products.ts`, `customer-maintenance.ts` (read in full), `customer-hubs.ts`,
> `customer-quotation.ts`, `users.ts`, `auth.ts`, `worker-auth.ts`, `files.ts`,
> `src/api/lib/column-rename-map.json`, `tests/db-schema.json`, `tests/customer-notify.test.mjs`,
> `tests/customer-quotation-batched.test.mjs`.
> Corrected 2026-08-19: `customer-maintenance.ts` copy-from-master was described as a
> `maintenance_config_history` mirror ONLY — it is primarily a `kv_config` blob copy
> (`variants-config` → `variants-config:<customerId>`) with the history mirror as a second
> step; `app.put("/:id")` is `:508` (was `:500`); `/me/permissions` is `auth.ts:521`
> (was `:487` — 34 lines off, landing in the logout handler); `app.post("/login")` is `:149`;
> `CustomerProductsPanel` `:193`, `AssignSkuModal` `:3218`; the `users.ts` gate list omitted
> `:166` = `/backfill-org-from-aliases` and mislabelled the rest; the `/api/files` disposition
> claim described the wrong handler; the pricing playbook cited a delivery-email test.
> Every entry-point LINE COUNT in this guide was re-measured and is exact.

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Owns **customers** (the debtor master) and the **platform plumbing** every other module rides on: user accounts + RBAC, the two separate auth systems (office users vs factory workers), per-customer product pricing, per-customer maintenance/combo config snapshots, customer→hub routing, the internal Mail Center, generic file upload/download, and the KV config store. Per-customer prices (`customer_products` / `customer_product_prices`) **shadow** the master `product_prices`; customer maintenance/combo config are **snapshot mirrors** of the master variant config. Customer hubs feed the DO / Service hub cascade. Account mutations are hard-gated to SUPER_ADMIN.

## Entry points
- Pages
  - `/customers` → `src/pages/customers.tsx:3424` (`CustomersPage` — list/KPI/CRUD + nested pricing/maintenance/combo panels)
  - Users/Org/Mailbox → `src/pages/settings/Users.tsx:226` (`UsersPage`; SUPER_ADMIN-gated account admin)
  - `src/pages/settings/index.tsx` (settings shell) · `src/pages/settings/organisations.tsx` (sister-company config)
  - Mail Center → `src/pages/mail-center/index.tsx` (Gmail-style shell) + `detail.tsx` / `compose.tsx`; client view prefs in `src/pages/mail-center/mail-prefs.ts`
  - Master config editors (config only, NOT combo math): `src/pages/maintenance.tsx`, `src/pages/maintenance/sofa-combos.tsx`
- API routes
  - Customer CRUD → `src/api/routes/customers.ts` (803 lines)
  - Per-customer pricing + bulk/copy → `src/api/routes/customer-products.ts` (1235)
  - Per-customer config snapshot mirror → `src/api/routes/customer-maintenance.ts` (185)
  - Per-customer hubs → `src/api/routes/customer-hubs.ts` (75) · quotation pricing → `src/api/routes/customer-quotation.ts` (268)
  - User accounts (SUPER_ADMIN gate) → `src/api/routes/users.ts` (1037)
  - Office auth → `src/api/routes/auth.ts` (1235) + `auth-oauth.ts` (240) / `auth-totp.ts` (612)
  - Factory-worker auth (separate system) → `src/api/routes/worker-auth.ts` (349)
  - Mail engine → `src/api/routes/mail-center.ts` (2476) · files → `files.ts` (571) · KV → `kv-config.ts` (117)

## Data model
- `customers` — debtor master. `default_company_code`, `group_org_code` (multi-company dual-identity link, mirror of `suppliers.group_org_code`), `oem_marking` (JSON) all runtime self-applied.
- `customer_products` / `customer_product_prices` — per-customer pricing that shadows master `product_prices`; history-tracked (effective-dated price rows).
- `customer_hubs` / `delivery_hubs` — per-customer hub routing feeding the DO/Service hub chain.
- `kv_config['variants-config']` — the MASTER variants blob (Divan/Total Heights, Gaps, Leg Heights, Specials, Sofa sizes, Fabrics). Each customer's copy is the namespaced key `variants-config:<customerId>` in the SAME `kv_config` table — there is no per-customer config table. `maintenance_config_history` — the effective-dated config table owned by [[products]]; `customer-maintenance.ts` ALSO mirrors every `scope='master'` row into `scope='customer:<id>'` so the per-item history dialog has a timeline. `sofa_combo_rules` — combo rule data (config only).
- `users` / `user_invites` / `user_sessions` / `password_reset_tokens` / `role_permissions` — accounts, invites, sessions, RBAC.
- `email_threads` / `email_messages` / `email_addresses` / `email_attachments` / `email_labels` / `mail_user_scope` — Mail Center. `kv_config` — shared generic KV store. `audit_events` — action audit.

## Core flows
1. **Create / edit customer** — `app.post("/")` `customers.ts:350` and `app.put("/:id")` `:508`. Both self-apply the company/group/OEM columns, then run `validateDebtorCode` (`:76`) before write. Reads go through `rowToCustomer` (`:271`), which dual-keys camel/snake and buckets hubs.
2. **Per-customer pricing (shadow master)** — `CustomerProductsPanel` (`customers.tsx:193`) mirrors the Products bulk-edit dirty-edits pattern; backend `customer-products.ts` assigns SKUs (`app.post("/bulk-assign")` `:743`), seeds from master (`app.post("/copy-from-master")` `:833`), and writes effective-dated price rows (`app.post("/:customerProductId/prices")` `:434`). Price resolution: `resolveCustomerPriceAsOf` (`:1004`).
3. **Maintenance/combo config snapshot** — `app.post("/:customerId/copy-from-master")` `customer-maintenance.ts:30` (the file's ONLY endpoint). It (a) checks the customer exists, (b) reads `kv_config['variants-config']` and refuses if it is missing (404) or malformed JSON (500, guard `:66-73`), (c) upserts it to `kv_config['variants-config:<customerId>']` (`:81-89`), then (d) mirrors every `maintenance_config_history` row with `scope='master'` into `scope='customer:<customerId>'`, skipping `(effective_from, config)` pairs that already exist and batching 50 inserts at a time (`:91-171`). Returns `mirroredHistoryRows`.
4. **Office login/session** — `app.post("/login")` `auth.ts:149` issues a `user_sessions` row; `/me` `:491`, `/me/permissions` `:521`; password reset and invite-accept handlers live further down the same file. OAuth (`auth-oauth.ts`) / TOTP (`auth-totp.ts`) are bolt-ons.
5. **Account admin (SUPER_ADMIN-gated)** — every one of the EIGHT mutating handlers in `users.ts` calls `requireSuperAdmin(c)` (imported from `../lib/rbac`, `:20`). Gate → handler, verified pairwise: `:166`→`POST /backfill-org-from-aliases` (`:165`), `:259`→`POST /` create (`:253`), `:361`→`PUT /:id` (`:350`), `:556`→`DELETE /:id` (`:551`), `:633`→`POST /:id/reset-password` (`:627`), `:778`→`POST /invite` (`:772`), `:941`→`POST /invites/:token/resend` (`:938`), `:996`→`DELETE /invites/:token` (`:993`). The three GETs (`:224`, `:917`, `:1023`) are not gated by it.
6. **Factory-worker auth (separate)** — `worker-auth.ts` PIN login `:124`, reset-pin `:241`, logout `:297`, me `:312`. NOT interchangeable with office auth; has a 'default-protect' invariant.

## Key functions / sections (locate-to-function)
| Symbol / section | file:line | Role |
|---|---|---|
| `CustomersPage` | `src/pages/customers.tsx:3424` | List/KPI/columns/CRUD/context menu (default export) |
| `CustomerProductsPanel` | `src/pages/customers.tsx:193` | Per-customer pricing (mirrors Products bulk-edit) |
| `CustomerMaintenancePanel` | `src/pages/customers.tsx:1639` | Per-customer config snapshot tabs |
| `CustomerSofaCombosPanel` | `src/pages/customers.tsx:2403` | Per-customer combo pricing (config editor) |
| `CustomerPriceHistoryDialog` | `src/pages/customers.tsx:2692` | Price-history viewer |
| `AssignSkuModal` | `src/pages/customers.tsx:3218` | SKU assignment modal |
| `UsersPage` | `src/pages/settings/Users.tsx:226` | Users/Org/Mailbox tab shell |
| `validateDebtorCode` | `src/api/routes/customers.ts:76` | Debtor-code validation on create/edit |
| `rowToCustomer` | `src/api/routes/customers.ts:271` | Dual-key row → customer, buckets hubs |
| `app.post("/")` / `app.put("/:id")` | `src/api/routes/customers.ts:350 / 508` | Customer create / edit (+ column self-apply) |
| `resolvePrices` | `src/api/routes/customer-products.ts:95` | Merge master + per-customer prices |
| `app.post("/copy-from-master")` | `src/api/routes/customer-products.ts:833` | Seed per-customer prices from master |
| `app.post("/bulk-assign")` | `src/api/routes/customer-products.ts:743` | Bulk-assign SKUs to a customer |
| `resolveCustomerPriceAsOf` | `src/api/routes/customer-products.ts:1004` | Effective-dated price lookup |
| `app.post("/:customerId/copy-from-master")` | `src/api/routes/customer-maintenance.ts:30` | Copy `kv_config` master blob + mirror `maintenance_config_history` (corrupt-guard) |
| `requireSuperAdmin`-gated mutations | `src/api/routes/users.ts:166/259/361/556/633` | backfill-org / create / edit / delete / reset-password (also `:778` invite, `:941` resend, `:996` invite-delete) |
| `app.post("/login")` | `src/api/routes/auth.ts:149` | Office login → `user_sessions` |
| `app.post("/login")` | `src/api/routes/worker-auth.ts:124` | Factory-worker PIN login (separate system) |

## Gotchas
- **Snapshot copy, not a live join.** Per-customer config lives in `kv_config` under `variants-config:<customerId>` — a POINT-IN-TIME copy of the master blob, so later master edits do NOT reach a seeded customer. `customer-maintenance.ts` refuses to write when the master blob is missing or malformed JSON, and separately mirrors every master `maintenance_config_history` row into the customer scope. Don't bypass that guard or write per-customer config directly.
- **RBAC is a hard gate.** `users.ts` calls `requireSuperAdmin(c)` on all account mutations — rejects any role != SUPER_ADMIN even with `*:*`. `Users.tsx` hides Disable/Reset/Delete/invite unless SUPER_ADMIN. ADMIN deliberately cannot manage accounts.
- **Two separate auth systems.** `auth.ts` / `auth-oauth.ts` / `auth-totp.ts` (office users) vs `worker-auth.ts` (factory workers) — NOT interchangeable; worker-auth has a 'default-protect' invariant with its own test.
- **camelCase/snake_case.** Read paths dual-key (`r.effectiveFrom ?? r.effective_from ?? r.effectivefrom`; `r.groupOrgCode ?? r.group_org_code`). Any new camelCase WRITE column needs a `column-rename-map.json` entry or it 400s. Prefer snake_case; new columns reach prod only via runtime `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (see `ensureCustomerCompanyColumn`, `customers.ts:39`).
- **Combo pricing is backend-unified** via `applySofaCombos` wired into sales-orders POST/PUT — do NOT re-implement combo math in `customers.tsx` or `maintenance/sofa-combos.tsx`; those are config editors only. (See [[sales]].)
- **Per-customer prices SHADOW master.** `CustomerProductsPanel` intentionally MIRRORS the Products page bulk-edit dirty-edits pattern — keep in sync, don't fork.
- **Customer hubs feed the DO/Service hub chain.** `hub-cascade-completeness` + `service-hub-chain` tests guard the cascade; editing hub routes can break downstream delivery/consignment integrity.
- **`/api/files` is shared** across customer, product-doc and modular uploads, keyed only by `resourceType`+`resourceId` — don't special-case per `resourceType`. Two read paths, and they differ: `GET /:id/download` (`files.ts:446`) **302-redirects** to a short-lived Supabase signed URL with `?download=<filename>`; `GET /:id/stream` (`:485`) is the proxy fallback and is the ONLY one this route sets `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` on (`:503-511`). `<img src=…/download>` still renders in both cases — browsers ignore the disposition for subresource loads.
- **`kv_config` is a shared generic store** (e.g. `public_holidays` consumed by payroll) — changing its shape can affect unrelated modules.
- **Mail Center is Gmail-style with 3 client-side view toggles** (`src/pages/mail-center/mail-prefs.ts:24`, persisted in `localStorage` key `hookka-mail-prefs:v1`): `density` (compact|comfortable, default compact), `readingPane` (split|full, default **full** — owner's call), `categoryTabs` (bool, default true). The Primary/Notifications split is a client heuristic (`classifyCategory`, `mail-prefs.ts:155`, called from `mail-center/index.tsx:1124` and `:1135`) — no backend columns, threads API unchanged. Don't move the heuristic server-side.

## Common tasks (mini-playbook)
- **Add a field to the customer** → runtime `ALTER … ADD COLUMN IF NOT EXISTS` helper next to `ensureCustomerCompanyColumn` (`customers.ts:39`); persist in POST (`:350`) and PUT (`:508`); surface in `rowToCustomer` (`:271`); render in `customers.tsx:3416`. snake_case (+ rename-map if camelCase).
- **Adjust per-customer pricing** → backend in `customer-products.ts` (prices `:434`, bulk-assign `:743`, copy-from-master `:833`, resolve `:1004`); FE in `CustomerProductsPanel` (`customers.tsx:193`) — mirror the Products bulk-edit pattern. Test `tests/customer-quotation-batched.test.mjs` (it is the one that actually pins `customer-products.ts`'s batched resolver + `FROM customer_product_prices`). `tests/customer-notify.test.mjs` is about DO/invoice/CN dispatch EMAIL templates and does not touch pricing.
- **Change account/RBAC rules** → keep the `requireSuperAdmin(c)` gate on every `users.ts` mutation and the matching UI hide in `Users.tsx`; verify with `tests/worker-auth-default-protect.test.mjs`.
- **Touch customer hubs** → `customer-hubs.ts` (75 lines — read it whole) + the master hub config; re-run `tests/hub-cascade-completeness.test.mjs` and `tests/service-hub-chain.test.mjs`.
- **Touch worker auth** → `worker-auth.ts` (login `:124`, reset-pin `:241`); preserve the default-protect invariant (`tests/worker-auth-default-protect.test.mjs`).

## Related modules
[[sales]] [[delivery]] [[accounting]] [[procurement]] [[production]]
