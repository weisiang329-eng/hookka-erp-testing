# Customers & Platform — Module Guide

> **Last verified: 2026-08-13** against `src/pages/customers.tsx`, `src/pages/settings/Users.tsx`, `src/api/routes/{customers,customer-products,customer-maintenance,customer-hubs,customer-quotation,users,auth,worker-auth,mail-center,files,kv-config}.ts`, and `tests/`.
> Corrected 2026-08-13: `customers.tsx:3207` was labelled `CustomersPage` but is actually `AssignSkuModal` — every `customers.tsx` anchor had drifted ~198 lines; `customers.ts` is 795 lines (not 606) and `kv-config.ts` 117 (not 93). All named test files verified to exist.

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Owns **customers** (the debtor master) and the **platform plumbing** every other module rides on: user accounts + RBAC, the two separate auth systems (office users vs factory workers), per-customer product pricing, per-customer maintenance/combo config snapshots, customer→hub routing, the internal Mail Center, generic file upload/download, and the KV config store. Per-customer prices (`customer_products` / `customer_product_prices`) **shadow** the master `product_prices`; customer maintenance/combo config are **snapshot mirrors** of the master variant config. Customer hubs feed the DO / Service hub cascade. Account mutations are hard-gated to SUPER_ADMIN.

## Entry points
- Pages
  - `/customers` → `src/pages/customers.tsx:3405` (`CustomersPage` — list/KPI/CRUD + nested pricing/maintenance/combo panels)
  - Users/Org/Mailbox → `src/pages/settings/Users.tsx:226` (`UsersPage`; SUPER_ADMIN-gated account admin)
  - `src/pages/settings/index.tsx` (settings shell) · `src/pages/settings/organisations.tsx` (sister-company config)
  - Mail Center → `src/pages/mail-center/index.tsx` (Gmail-style shell) + `detail.tsx` / `compose.tsx`
  - Master config editors (config only, NOT combo math): `src/pages/maintenance.tsx`, `src/pages/maintenance/sofa-combos.tsx`
- API routes
  - Customer CRUD → `src/api/routes/customers.ts` (795 lines)
  - Per-customer pricing + bulk/copy → `src/api/routes/customer-products.ts` (1235)
  - Per-customer config snapshot mirror → `src/api/routes/customer-maintenance.ts` (185)
  - Per-customer hubs → `src/api/routes/customer-hubs.ts` (75) · quotation pricing → `src/api/routes/customer-quotation.ts` (268)
  - User accounts (SUPER_ADMIN gate) → `src/api/routes/users.ts` (1037)
  - Office auth → `src/api/routes/auth.ts` (1201) + `auth-oauth.ts` (240) / `auth-totp.ts` (546)
  - Factory-worker auth (separate system) → `src/api/routes/worker-auth.ts` (349)
  - Mail engine → `src/api/routes/mail-center.ts` (2476) · files → `files.ts` (571) · KV → `kv-config.ts` (117)

## Data model
- `customers` — debtor master. `default_company_code`, `group_org_code` (multi-company dual-identity link, mirror of `suppliers.group_org_code`), `oem_marking` (JSON) all runtime self-applied.
- `customer_products` / `customer_product_prices` — per-customer pricing that shadows master `product_prices`; history-tracked (effective-dated price rows).
- `customer_hubs` / `delivery_hubs` — per-customer hub routing feeding the DO/Service hub chain.
- `maintenance_config_history` — master variant config; `customer-maintenance.ts` mirrors EVERY snapshot per customer. `sofa_combo_rules` — combo rule data (config only).
- `users` / `user_invites` / `user_sessions` / `password_reset_tokens` / `role_permissions` — accounts, invites, sessions, RBAC.
- `email_threads` / `email_messages` / `email_addresses` / `email_attachments` / `email_labels` / `mail_user_scope` — Mail Center. `kv_config` — shared generic KV store. `audit_events` — action audit.

## Core flows
1. **Create / edit customer** — `app.post("/")` `customers.ts:350` and `app.put("/:id")` `:500`. Both self-apply the company/group/OEM columns, then run `validateDebtorCode` (`:76`) before write. Reads go through `rowToCustomer` (`:271`), which dual-keys camel/snake and buckets hubs.
2. **Per-customer pricing (shadow master)** — `CustomerProductsPanel` (`customers.tsx:192`) mirrors the Products bulk-edit dirty-edits pattern; backend `customer-products.ts` assigns SKUs (`app.post("/bulk-assign")` `:743`), seeds from master (`app.post("/copy-from-master")` `:833`), and writes effective-dated price rows (`app.post("/:customerProductId/prices")` `:434`). Price resolution: `resolveCustomerPriceAsOf` (`:1004`).
3. **Maintenance/combo config snapshot** — `app.post("/:customerId/copy-from-master")` `customer-maintenance.ts:30` mirrors every master `maintenance_config_history` snapshot per customer, refusing to write if the master config is corrupt (guard ~`:65`).
4. **Office login/session** — `app.post("/login")` `auth.ts:148` issues a `user_sessions` row; `/me/permissions` `:487`; password reset and invite-accept handlers live further down the same file. OAuth (`auth-oauth.ts`) / TOTP (`auth-totp.ts`) are bolt-ons.
5. **Account admin (SUPER_ADMIN-gated)** — every mutation in `users.ts` calls `requireSuperAdmin(c)` (imported from `../lib/rbac`, `:20`); the gate fires at `:166`, `:259`, `:361`, `:556`, `:633`, `:778`, `:941`, `:996` — create / edit / delete / reset-password / invite / invite-resend / invite-delete.
6. **Factory-worker auth (separate)** — `worker-auth.ts` PIN login `:124`, reset-pin `:241`, logout `:297`, me `:312`. NOT interchangeable with office auth; has a 'default-protect' invariant.

## Key functions / sections (locate-to-function)
| Symbol / section | file:line | Role |
|---|---|---|
| `CustomersPage` | `src/pages/customers.tsx:3405` | List/KPI/columns/CRUD/context menu (default export) |
| `CustomerProductsPanel` | `src/pages/customers.tsx:192` | Per-customer pricing (mirrors Products bulk-edit) |
| `CustomerMaintenancePanel` | `src/pages/customers.tsx:1628` | Per-customer config snapshot tabs |
| `CustomerSofaCombosPanel` | `src/pages/customers.tsx:2392` | Per-customer combo pricing (config editor) |
| `CustomerPriceHistoryDialog` | `src/pages/customers.tsx:2681` | Price-history viewer |
| `AssignSkuModal` | `src/pages/customers.tsx:3207` | SKU assignment modal |
| `UsersPage` | `src/pages/settings/Users.tsx:226` | Users/Org/Mailbox tab shell |
| `validateDebtorCode` | `src/api/routes/customers.ts:76` | Debtor-code validation on create/edit |
| `rowToCustomer` | `src/api/routes/customers.ts:271` | Dual-key row → customer, buckets hubs |
| `app.post("/")` / `app.put("/:id")` | `src/api/routes/customers.ts:350 / 500` | Customer create / edit (+ column self-apply) |
| `resolvePrices` | `src/api/routes/customer-products.ts:95` | Merge master + per-customer prices |
| `app.post("/copy-from-master")` | `src/api/routes/customer-products.ts:833` | Seed per-customer prices from master |
| `app.post("/bulk-assign")` | `src/api/routes/customer-products.ts:743` | Bulk-assign SKUs to a customer |
| `resolveCustomerPriceAsOf` | `src/api/routes/customer-products.ts:1004` | Effective-dated price lookup |
| `app.post("/:customerId/copy-from-master")` | `src/api/routes/customer-maintenance.ts:30` | Snapshot-mirror master config (corrupt-guard) |
| `requireSuperAdmin`-gated mutations | `src/api/routes/users.ts:166/259/361/556/633` | Create/edit/delete/reset/invite (all SUPER_ADMIN) |
| `app.post("/login")` | `src/api/routes/auth.ts:148` | Office login → `user_sessions` |
| `app.post("/login")` | `src/api/routes/worker-auth.ts:124` | Factory-worker PIN login (separate system) |

## Gotchas
- **Snapshot mirror, not a live join.** `customer-maintenance.ts` copies EVERY master `maintenance_config_history` snapshot per customer and REFUSES to write when the master config is corrupt — don't bypass that guard or write per-customer config directly.
- **RBAC is a hard gate.** `users.ts` calls `requireSuperAdmin(c)` on all account mutations — rejects any role != SUPER_ADMIN even with `*:*`. `Users.tsx` hides Disable/Reset/Delete/invite unless SUPER_ADMIN. ADMIN deliberately cannot manage accounts.
- **Two separate auth systems.** `auth.ts` / `auth-oauth.ts` / `auth-totp.ts` (office users) vs `worker-auth.ts` (factory workers) — NOT interchangeable; worker-auth has a 'default-protect' invariant with its own test.
- **camelCase/snake_case.** Read paths dual-key (`r.effectiveFrom ?? r.effective_from ?? r.effectivefrom`; `r.groupOrgCode ?? r.group_org_code`). Any new camelCase WRITE column needs a `column-rename-map.json` entry or it 400s. Prefer snake_case; new columns reach prod only via runtime `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (see `ensureCustomerCompanyColumn`, `customers.ts:39`).
- **Combo pricing is backend-unified** via `applySofaCombos` wired into sales-orders POST/PUT — do NOT re-implement combo math in `customers.tsx` or `maintenance/sofa-combos.tsx`; those are config editors only. (See [[sales]].)
- **Per-customer prices SHADOW master.** `CustomerProductsPanel` intentionally MIRRORS the Products page bulk-edit dirty-edits pattern — keep in sync, don't fork.
- **Customer hubs feed the DO/Service hub chain.** `hub-cascade-completeness` + `service-hub-chain` tests guard the cascade; editing hub routes can break downstream delivery/consignment integrity.
- **`/api/files` is shared.** Serves customer, product-doc and modular uploads with attachment disposition, but `<img src=…/download>` still renders — don't special-case per `resourceType`.
- **`kv_config` is a shared generic store** (e.g. `public_holidays` consumed by payroll) — changing its shape can affect unrelated modules.
- **Mail Center is Gmail-style with 3 client-side view toggles** (`mail-prefs.ts`): density, reading-pane, category-tabs. The Primary/Notifications split is a client heuristic (`classifyCategory`) — no backend columns, threads API unchanged. Don't move the heuristic server-side.

## Common tasks (mini-playbook)
- **Add a field to the customer** → runtime `ALTER … ADD COLUMN IF NOT EXISTS` helper next to `ensureCustomerCompanyColumn` (`customers.ts:39`); persist in POST (`:350`) and PUT (`:500`); surface in `rowToCustomer` (`:271`); render in `customers.tsx:3405`. snake_case (+ rename-map if camelCase).
- **Adjust per-customer pricing** → backend in `customer-products.ts` (prices `:434`, bulk-assign `:743`, copy-from-master `:833`, resolve `:1004`); FE in `CustomerProductsPanel` (`customers.tsx:192`) — mirror the Products bulk-edit pattern. Test `tests/customer-notify.test.mjs`.
- **Change account/RBAC rules** → keep the `requireSuperAdmin(c)` gate on every `users.ts` mutation and the matching UI hide in `Users.tsx`; verify with `tests/worker-auth-default-protect.test.mjs`.
- **Touch customer hubs** → `customer-hubs.ts` (75 lines — read it whole) + the master hub config; re-run `tests/hub-cascade-completeness.test.mjs` and `tests/service-hub-chain.test.mjs`.
- **Touch worker auth** → `worker-auth.ts` (login `:124`, reset-pin `:241`); preserve the default-protect invariant (`tests/worker-auth-default-protect.test.mjs`).

## Related modules
[[sales]] [[delivery]] [[accounting]] [[procurement]] [[production]]
