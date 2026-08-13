# Map fragment — Scanning Queue, OCR, Public QR, AI Assistant, TOTP, Orgs & CRM/Leads

> **Last verified: 2026-08-13** against the eight route files below, `src/api/worker.ts`
> (mount lines), `src/api/lib/auth-middleware.ts` (`PUBLIC_PATHS` / `PUBLIC_PREFIXES`),
> `src/api/lib/rbac.ts` (`requirePermission`), `src/api/lib/tenant.ts` (`getOrgId`),
> `src/api/lib/api-rate-limit-config.ts`, `migrations/0026_po_scan_samples.sql`,
> `migrations/0049_multi_tenant_skeleton.sql`, `src/router.tsx`, `src/dashboard-routes.tsx`,
> and every test named here. Every endpoint line ref was read in the file, not grepped.
>
> **This is a FRAGMENT** staged for assembly into `docs/CODEBASE-MAP.md` — none of these
> eight routers had ever been named in the map. Do not treat it as a second map.
>
> **Line counts are `wc -l`.** Editors that count a final unterminated line report +1.

**All eight routers are LIVE** (mounted in `src/api/worker.ts`). Every mount below sits
*after* the global gate `app.use("/api/*", authMiddleware)` (`src/api/worker.ts:913`), so a
route is public only when its path is listed in `PUBLIC_PATHS` / `PUBLIC_PREFIXES` inside
`src/api/lib/auth-middleware.ts`. `customerScopeMiddleware` (`src/api/worker.ts:927`),
`tenantMiddleware` (`src/api/worker.ts:934`) and `apiRateLimit` (`src/api/worker.ts:949`)
run after it, so **public routes still pass through the rate limiter** but reach the
handler with no `userId`, no `userRole` and no orgId on the context.

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/components/scan-po-modal.tsx` — customer-PO scan wizard, in-modal queue polling (3442) | `src/api/routes/scan-queue.ts` — async OCR queue for PO + supplier scans (1541); mounted `src/api/worker.ts:1406` | `scan_queue` (self-created, `src/api/routes/scan-queue.ts:108`) | `tests/ocr-accuracy-sampleid.test.mjs` |
| `src/components/scan-supplier-modal.tsx` — supplier PI/GRN scan wizard (5876) · `src/lib/scan-queue-client.ts` — consume + source-doc upload helpers (98) | `src/api/routes/scan-po.ts` — customer-PO OCR + few-shot samples + per-customer prompt rules (1075); mounted `src/api/worker.ts:1396` | `po_scan_samples` (**no org column** — `migrations/0026_po_scan_samples.sql`) / `customers.ocrPromptRules` | `tests/ocr-accuracy-customer-grouping.test.mjs` |
| `src/pages/do-scan.tsx` — PUBLIC driver scan page, routed `/d/:token` (`src/router.tsx:105`) (1031) | `src/api/routes/public-do-qr.ts` — **PUBLIC** DO / packing-list dispatch+deliver QR flow (1019); mounted `src/api/worker.ts:1210` | `delivery_orders` / `delivery_order_items` / `packing_lists` / `production_orders` / `sales_orders` / `job_cards` (+ everything the DO cascade writes) | `tests/do-qr-public.test.mjs` / `tests/security-public-endpoints.test.mjs` / `tests/delivery-incomplete-dual-key.test.mjs` |
| `src/components/assistant/AssistantSlideOver.tsx` — chat panel (1318) · `src/components/assistant/FloatingChatButton.tsx` | `src/api/routes/assistant.ts` — Hookka AI SSE chat + tool loop (995); mounted `src/api/worker.ts:1441` (history router first at `src/api/worker.ts:1440`) | `audit_events` (one row per tool call) + whatever `src/api/lib/assistant-tools.ts` reads (60 tools incl. an arbitrary-SELECT tool) | `tests/assistant-agent-command-prompt.test.mjs` |
| `src/pages/setup-2fa.tsx` — soft-prompt 2FA setup (278) · `src/pages/login.tsx` — step-2 code entry | `src/api/routes/auth-totp.ts` — TOTP enroll / verify / login-verify / disable (546); mounted `src/api/worker.ts:1278` | `users` (`totpSecret` / `totpEnrolledAt` / `totpRecoveryHashes`) / `user_sessions` / `audit_events` | **NONE** — only the public-path snapshot `tests/security-public-endpoints.test.mjs` lists `/api/auth/totp/login-verify`; no test exercises any handler |
| `src/pages/settings/organisations.tsx` — sister-company registry (796) | `src/api/routes/organisations.ts` — org registry CRUD + active-org switch (568); mounted `src/api/worker.ts:1193` | `organisations` / `inter_company_config` / `suppliers.purchase_org_code` | **NONE** |
| `src/components/customer/CrmPanel.tsx` — contacts + timeline (294) · `src/components/customer/KycPanel.tsx` — onboarding/KYC (124) | `src/api/routes/customer-crm.ts` — contacts / activities / follow-ups / onboarding / send-quote (509); mounted `src/api/worker.ts:1190` | `customer_contacts` / `customer_activities` / `customer_onboarding` / `customer_wishlist` (retired, rows kept) | `tests/customer-crm.test.mjs` / `tests/crm-activity-and-catalog.test.mjs` / `tests/customer-kyc.test.mjs` / `tests/customer-crm-wishlist-send.test.mjs` |
| `src/pages/leads/index.tsx` — pipeline board, routed `/leads` (`src/dashboard-routes.tsx:414`) (929) | `src/api/routes/sales-leads.ts` — pre-sale pipeline + lead catalog + convert (437); mounted `src/api/worker.ts:1191` | `sales_leads` / `lead_products` / `customers` / `customer_products` / the four CRM side-tables | `tests/sales-leads.test.mjs` / `tests/lead-catalog.test.mjs` / `tests/lead-convert.test.mjs` |

> **Every test in the right-hand column is a SOURCE-TEXT test** — it `readFileSync`s the
> route and asserts the source contains (or no longer contains) a pattern. None of them
> boot the worker or hit a DB. They pin shape, not behaviour: a handler can be structurally
> correct and still return the wrong rows. Treat "covered" here as "a rename or a deletion
> trips CI", nothing stronger.

---

## Endpoints + auth posture

Posture is read off the handler body, not the header comment. `requirePermission`
(`src/api/lib/rbac.ts:188`) short-circuits `null` for SUPER_ADMIN and ADMIN
(`src/api/lib/rbac.ts:210`), so every "permission-gated" row below is fully open to those
two roles. "Org-scoped" means the SQL carries an `org_id` / `orgId` bind.

### `src/api/routes/scan-queue.ts` — async OCR queue

| Method + path | Ref | Posture | Org scope |
|---|---|---|---|
| POST `/api/scan-queue/upload` | `src/api/routes/scan-queue.ts:698` | `purchase-orders:create` | writes `org_id` from `getOrgId` |
| GET `/api/scan-queue/batch/:batchId` | `src/api/routes/scan-queue.ts:876` | `purchase-orders:create` | `(org_id = ? OR org_id IS NULL)` |
| GET `/api/scan-queue/pending` | `src/api/routes/scan-queue.ts:956` | `purchase-orders:create` | org + `created_by = <caller>` |
| GET `/api/scan-queue/:id` | `src/api/routes/scan-queue.ts:1081` | `purchase-orders:create` | org-filtered |
| GET `/api/scan-queue/:id/bytes` | `src/api/routes/scan-queue.ts:1141` | `purchase-orders:create` | org-filtered; returns raw PDF/image bytes |
| POST `/api/scan-queue/:id/retry` | `src/api/routes/scan-queue.ts:1201` | `purchase-orders:create` | org-filtered SELECT, then an id-only UPDATE (transitively safe) |
| POST `/api/scan-queue/:id/consume` | `src/api/routes/scan-queue.ts:1273` | `purchase-orders:create` | org-filtered |

The sweeper is **not** in this router: `sweepStuckScans` (`src/api/routes/scan-queue.ts:1414`)
is exported and mounted by hand as `POST /api/internal/scan-queue-sweep`
(`src/api/worker.ts:790`), registered **before** `authMiddleware` and gated by a
constant-time `CRON_SECRET` compare that 503s when the secret is unset or under 16 chars
(`src/api/worker.ts:791-798`). Its SQL is deliberately org-blind — it is a system sweep.

Internals: `ensureScanQueueTable` (`src/api/routes/scan-queue.ts:101`) ·
`hydrateRow` (`src/api/routes/scan-queue.ts:235`) ·
`processBatch` (`src/api/routes/scan-queue.ts:317`) ·
`processOneAtATime` (`src/api/routes/scan-queue.ts:328`) ·
`sweepStuckBatch` (`src/api/routes/scan-queue.ts:1495`, the real recovery path — Pages has
no cron, so the poll endpoints self-heal).

### `src/api/routes/scan-po.ts` — customer-PO OCR

| Method + path | Ref | Posture | Org scope |
|---|---|---|---|
| GET `/api/scan-po/catalog` | `src/api/routes/scan-po.ts:486` | `purchase-orders:create` | org-scoped catalog load |
| POST `/api/scan-po/extract` | `src/api/routes/scan-po.ts:525` | `purchase-orders:create` **plus a secret-header bypass** (below) | reads org-scoped catalog; writes an org-less sample row |
| POST `/api/scan-po/samples/:id/confirm` | `src/api/routes/scan-po.ts:712` | `purchase-orders:create` | **none** on the sample UPDATE; the customer-name read at `:767` is also org-blind |
| GET `/api/scan-po/samples/by-po/:poIdentifier` | `src/api/routes/scan-po.ts:847` | `purchase-orders:create` | **none** |
| PATCH `/api/scan-po/samples/by-po/:poIdentifier` | `src/api/routes/scan-po.ts:904` | `purchase-orders:create` | **none** |
| GET `/api/scan-po/customer-rules/:customerId` | `src/api/routes/scan-po.ts:946` | `customers:read` | `AND orgId = ?` |
| PUT `/api/scan-po/customer-rules/:customerId` | `src/api/routes/scan-po.ts:977` | `customers:update` | `AND orgId = ?` |
| POST `/api/scan-po/customer-rules/:customerId/distill` | `src/api/routes/scan-po.ts:1033` | `customers:update` | orgId passed to the distiller |

**The secret-header bypass is real and easy to miss.** `authMiddleware` grants a
SUPER_ADMIN identity to any POST to exactly `/api/scan-po/extract` or
`/api/scan-supplier/extract` that presents a matching `x-scan-worker` header
(`src/api/lib/auth-middleware.ts:338-357`, constant-time compare, secret must be ≥16
chars). It stamps `userId = "scan-worker"` / `userRole = "SUPER_ADMIN"`, which is what
makes the in-route `requirePermission` pass. The comment above it describes a self-fetch
that **no longer happens** — `src/api/routes/scan-queue.ts:690-691` records that the queue
worker now calls `runExtract` directly, with "no self-fetch, no SCAN_WORKER_TOKEN". The
bypass is dead code with a live key.

Post-processing helpers: `reparseSpec` (`src/api/routes/scan-po.ts:115`) ·
`applySofaLhfRhfFromTv` (`src/api/routes/scan-po.ts:176`) ·
`normalizeForMatch` (`src/api/routes/scan-po.ts:259`) ·
`validateAndEnrichPO` (`src/api/routes/scan-po.ts:268`).

### `src/api/routes/public-do-qr.ts` — PUBLIC, unauthenticated

Auth bypass is the prefix `"/api/public/do-qr/"` (`src/api/lib/auth-middleware.ts:93`).
**The 64-hex `qrtoken` IS the entire credential** — there is no session, no CSRF (the CSRF
check only fires when a session cookie is present, `src/api/lib/auth-middleware.ts:383`),
and no expiry on the token. Rate limit is tightened to 30/min + 300/hr per client IP
(`src/api/lib/api-rate-limit-config.ts:63`).

| Method + path | Ref | Posture |
|---|---|---|
| GET `/api/public/do-qr/:token/edit` | `src/api/routes/public-do-qr.ts:616` | **PUBLIC** — DRAFT-only item-edit model |
| GET `/api/public/do-qr/:token` | `src/api/routes/public-do-qr.ts:665` | **PUBLIC** — minimal summary |
| POST `/api/public/do-qr/:token/advance` | `src/api/routes/public-do-qr.ts:713` | **PUBLIC** — forward-only DISPATCH / DELIVER |

Token shape is pinned by a regex at `src/api/routes/public-do-qr.ts:67` and checked before
any DB touch in all three handlers. Resolution covers both tables:
`resolveToken` (`src/api/routes/public-do-qr.ts:187`) tries `delivery_orders.qrtoken`
first, then `packing_lists.qrtoken` (a PL token fans out to all its member DOs).
`summarizeDos` (`src/api/routes/public-do-qr.ts:126`) and
`buildSummaryPayload` (`src/api/routes/public-do-qr.ts:261`) build the no-price payload.
`loadDoEditModel` (`src/api/routes/public-do-qr.ts:322`) builds the trusted edit set.

**Why the write path is safe despite being public** — worth reading before touching it:

- The transition is not reimplemented. `applyDeliveryOrderUpdate` (imported from
  `src/api/routes/delivery-orders.ts`) is the *same* function behind the office
  `PUT /api/delivery-orders/:id`, called at `src/api/routes/public-do-qr.ts:944`, so
  fg_units stamping, STOCK_OUT movements, the SO cascade, FIFO COGS and the auto-DRAFT
  invoice all fire identically. A guard added to the office path protects the QR path for
  free — and one removed there is removed here too.
- Forward-only by table lookup at `src/api/routes/public-do-qr.ts:686`: DISPATCH is
  DRAFT→LOADED, DELIVER is LOADED/IN_TRANSIT→DELIVERED. Past statuses are SKIPPED, not
  errored; anything else is BLOCKED. No reversal is reachable.
- The item edit never trusts the body. The page posts only production-order **ids**; the
  server rebuilds each line from `allowedById` (current DO items ∪ same-customer,
  same-state, delivery-ready POs) and 409s on an id outside that set
  (`src/api/routes/public-do-qr.ts:836-849`).
- Tenancy comes off the resolved row, not the request: the DO's own `orgId` is stashed onto
  the context at `src/api/routes/public-do-qr.ts:908` before the cascade runs, and a row
  with no org is FAILED rather than defaulted (`src/api/routes/public-do-qr.ts:899`).

### `src/api/routes/assistant.ts` — Hookka AI

| Method + path | Ref | Posture |
|---|---|---|
| POST `/api/assistant/chat` | `src/api/routes/assistant.ts:501` | **any logged-in user**; SUPER_ADMIN gets all tools, everyone else gets 3 |

**The file's own header comment (`src/api/routes/assistant.ts:6`) and the mount comment
(`src/api/worker.ts:1433`) both say "SUPER_ADMIN only". Both are stale.** The owner opened
the chat to all staff on 2026-07-28; the code now allows any authenticated caller and
narrows the *tools* instead, in two independent places:

1. Schema filter — non-super-admins are only offered `agent_overview`, `agent_control`,
   `teach_agent` (set at `src/api/routes/assistant.ts:544`, applied at
   `src/api/routes/assistant.ts:738`).
2. Dispatch guard — even a hallucinated tool name is refused at the dispatcher for a
   non-super-admin (`src/api/routes/assistant.ts:915`).

So the data / SQL / payroll tools (including the arbitrary-`SELECT` tool in
`src/api/lib/assistant-tools.ts`) stay owner-only. Other things read from the code, not the
comments: a kill switch fires before anything else when `ASSISTANT_ENABLED === "false"` and
returns a normal 200 SSE stream (`src/api/routes/assistant.ts:510`); the per-user daily
question cap is checked at `src/api/routes/assistant.ts:591` and **SUPER_ADMIN is exempt**
(`src/api/routes/assistant.ts:588`). Wire format helper: `sseEvent`
(`src/api/routes/assistant.ts:496`). The prompt is exported for the offline eval harness
(`src/api/routes/assistant.ts:72`).

### `src/api/routes/auth-totp.ts` — second factor

| Method + path | Ref | Posture |
|---|---|---|
| POST `/api/auth/totp/enroll` | `src/api/routes/auth-totp.ts:77` | session required; acts on `c.get("userId")` only |
| POST `/api/auth/totp/verify` | `src/api/routes/auth-totp.ts:134` | session required |
| POST `/api/auth/totp/login-verify` | `src/api/routes/auth-totp.ts:183` | **PUBLIC** (`src/api/lib/auth-middleware.ts:40`) — issues a full session |
| POST `/api/auth/totp/setup-start` | `src/api/routes/auth-totp.ts:330` | session required |
| POST `/api/auth/totp/setup-confirm` | `src/api/routes/auth-totp.ts:406` | session required |
| POST `/api/auth/totp/dismiss-prompt` | `src/api/routes/auth-totp.ts:477` | session required |
| POST `/api/auth/totp/disable` | `src/api/routes/auth-totp.ts:499` | session required **+ password re-auth** |

Only `/login-verify` is public, and that is explicit in the middleware — the sibling
`/setup-start`, `/setup-confirm` and `/dismiss-prompt` are NOT public, and the middleware
says so in place (`src/api/lib/auth-middleware.ts:41-44`). Every session-required handler
resolves its subject from the context via `ctxUserId` (`src/api/routes/auth-totp.ts:69`) and
never from the body, so there is no cross-user reach. `/login-verify` is throttled at 10
attempts / 15 min keyed on `totp:<userId>` (`src/api/routes/auth-totp.ts:203-205`), burns a
recovery-code hash on use (`src/api/routes/auth-totp.ts:234-239`), and audits both the fail
and the success. Read the finding below before assuming it is a complete 2FA.

Two schema facts that stop repeat archaeology: there is **no `user_totp_secrets` table** —
state lives on `users`, and "pending vs enabled" is `totpEnrolledAt IS NULL` vs a timestamp
(`src/api/routes/auth-totp.ts:312-316`). Enrollment writes the secret immediately and only
flips `totpEnrolledAt` on a proven code, so an abandoned enrollment is inert.

### `src/api/routes/organisations.ts` — org registry

| Method + path | Ref | Posture | Org scope |
|---|---|---|---|
| GET `/api/organisations` | `src/api/routes/organisations.ts:216` | authenticated, **no `requirePermission`** | **none** |
| POST `/api/organisations` | `src/api/routes/organisations.ts:242` | `organisations:update` | writes a hard-coded `'hookka'` org (`src/api/routes/organisations.ts:295`) |
| PATCH `/api/organisations/:id` | `src/api/routes/organisations.ts:328` | `organisations:update` | **none** |
| DELETE `/api/organisations/:id` | `src/api/routes/organisations.ts:429` | `organisations:update` | **none**; soft-delete, refuses the default org |
| PUT `/api/organisations` | `src/api/routes/organisations.ts:454` | `organisations:update` | **none**; three body shapes (`orgId` switch / `organisation` patch / `interCompanyConfig`) |

The GET response shape has no `success` wrapper — the Settings page and the sidebar switcher
consume `{ organisations, activeOrgId, interCompanyConfig }` directly. It degrades in two
steps: `loadOrganisations` (`src/api/routes/organisations.ts:161`) falls back to a legacy
column list when migration 0142's columns are missing, then to a hardcoded two-org constant
(`src/api/routes/organisations.ts:107`) when the table itself is absent. The new columns
reach prod only through the runtime self-apply `ensureOrganisationRegistry`
(`src/api/routes/organisations.ts:187`) — which is called by POST/PATCH/DELETE but **not**
by GET, which is why GET needs the fallback at all.

`inter_company_config` is a **singleton row `id = 1`**. The org switcher writes
`active_org_id` on that one row (`src/api/routes/organisations.ts:466`), so "which org is
active" is global state shared by every user in every tenant, not a per-user preference.

### `src/api/routes/customer-crm.ts` — CRM layer

| Method + path | Ref | Posture | Org scope |
|---|---|---|---|
| GET `/api/customer-crm/contacts` | `src/api/routes/customer-crm.ts:175` | `customers:read` | yes |
| POST `/api/customer-crm/contacts` | `src/api/routes/customer-crm.ts:191` | `customers:update` | yes |
| PUT `/api/customer-crm/contacts/:id` | `src/api/routes/customer-crm.ts:224` | `customers:update` | yes |
| DELETE `/api/customer-crm/contacts/:id` | `src/api/routes/customer-crm.ts:252` | `customers:delete` | yes |
| GET `/api/customer-crm/activities` | `src/api/routes/customer-crm.ts:266` | `customers:read` | yes |
| POST `/api/customer-crm/activities` | `src/api/routes/customer-crm.ts:285` | `customers:update` | yes |
| DELETE `/api/customer-crm/activities/:id` | `src/api/routes/customer-crm.ts:322` | `customers:delete` | yes |
| GET `/api/customer-crm/follow-ups` | `src/api/routes/customer-crm.ts:336` | `customers:read` | yes |
| GET `/api/customer-crm/onboarding` | `src/api/routes/customer-crm.ts:359` | `customers:read` | yes |
| PUT `/api/customer-crm/onboarding` | `src/api/routes/customer-crm.ts:374` | `customers:update` | writes org, but see the upsert note |
| POST `/api/customer-crm/send-quote` | `src/api/routes/customer-crm.ts:425` | `customers:update` | activity row carries org |

This is the best-scoped router of the eight: every read and every write carries
`AND org_id = ?`. Two edges to know. (1) The onboarding upsert is
`ON CONFLICT(customer_id)` (`src/api/routes/customer-crm.ts:385`) and
`customer_onboarding.customer_id` is the whole primary key
(`src/api/routes/customer-crm.ts:109`) — the conflict target does not include `org_id`, so
in a real second tenant two orgs sharing a customer id would overwrite each other's KYC
block. (2) PUT/DELETE return `success: true` without checking `changes`, so a wrong id and
a cross-org id are both reported as a successful edit.

Tables are runtime self-applied by `createCrmTables`
(`src/api/routes/customer-crm.ts:55`) behind the promise memo `ensureTables`
(`src/api/routes/customer-crm.ts:45`) — a boolean memo here was a real bug (concurrent
first-requests each ran the whole DDL block, and a failed round was remembered as done).
The wishlist feature is retired but its table is deliberately kept
(`src/api/routes/customer-crm.ts:409-413`) — do not "clean it up".

### `src/api/routes/sales-leads.ts` — pre-sale pipeline

| Method + path | Ref | Posture | Org scope |
|---|---|---|---|
| GET `/api/sales-leads` | `src/api/routes/sales-leads.ts:102` | `customers:read` | yes |
| POST `/api/sales-leads` | `src/api/routes/sales-leads.ts:155` | `customers:update` | lead row yes; the customer it mints, **no** |
| PUT `/api/sales-leads/:id` | `src/api/routes/sales-leads.ts:228` | `customers:update` | yes |
| PUT `/api/sales-leads/:id/stage` | `src/api/routes/sales-leads.ts:258` | `customers:update` | yes |
| POST `/api/sales-leads/:id/convert` | `src/api/routes/sales-leads.ts:295` | `customers:update` | side-tables yes; `customer_products` copy **no** |
| DELETE `/api/sales-leads/:id` | `src/api/routes/sales-leads.ts:359` | `customers:delete` | yes |
| GET `/api/sales-leads/lead-products` | `src/api/routes/sales-leads.ts:374` | `customers:read` | yes |
| POST `/api/sales-leads/lead-products` | `src/api/routes/sales-leads.ts:389` | `customers:update` | yes |
| DELETE `/api/sales-leads/lead-products/:id` | `src/api/routes/sales-leads.ts:427` | `customers:delete` | yes |

A lead **is** a potential customer (owner 2026-08-01): POST mints a real `customers` row
immediately via `createPotentialCustomerForLead` (`src/api/routes/sales-leads.ts:136`),
stamped `customer_stage = 'POTENTIAL'` with no creditor code and zero credit limit, and
links it back onto `sales_leads.customer_id`. That insert is **best-effort on purpose**
(`src/api/routes/sales-leads.ts:199`) — losing the typed-in lead because a customer insert
hiccuped would be worse than a lead without an account. Convert
(`src/api/routes/sales-leads.ts:295`) never creates the customer; it re-points the four
entity-keyed CRM side-tables listed at `src/api/routes/sales-leads.ts:288` from the lead id
to the customer id, copies `lead_products` into `customer_products`, and stamps WON. Lead
products live in their own table specifically so an unconfirmed lead cannot leak into the
pricing engine (`src/api/routes/sales-leads.ts:56-60`).

---

## Gotchas

- **`assistant.ts`'s own header says SUPER_ADMIN-only and is wrong** (`src/api/routes/assistant.ts:6`,
  echoed at `src/api/worker.ts:1433`). The gate moved from the route to the tool list on
  2026-07-28. Any staff role can open the chat; only the tool set differs. `tests/assistant-agent-command-prompt.test.mjs`
  pins the current behaviour — trust the test and the code, not the two comments.
- **`scan-queue.ts` says the browser navigates to `/scan-queue/<batchId>`** (`src/api/routes/scan-queue.ts:19`).
  **That page does not exist** — no such route is registered in `src/router.tsx` or
  `src/dashboard-routes.tsx`. Polling happens inside the modals: `src/components/scan-po-modal.tsx:109`
  and `src/components/scan-supplier-modal.tsx:581` poll `/batch/:batchId`, and both resume
  via `/pending`. Do not go looking for a queue page.
- **`(org_id = ? OR org_id IS NULL)` is the scan-queue tenancy idiom** (seven places in
  `src/api/routes/scan-queue.ts`). It is legacy tolerance for rows written before the
  column existed — but it also means any row that lands with a NULL org is visible to
  every tenant. New writes always stamp the org, so the null-tolerant half should shrink,
  not grow.
- **`po_scan_samples` has no org column at all** — see `migrations/0026_po_scan_samples.sql`.
  Every read, write and the few-shot selection over that table is therefore global. This is
  the root of finding S2 below; treat the table as a single shared pool until a column is
  added.
- **The DO QR token never expires and is not rotated.** Minting is authed-only (the
  `/:id/qr-token` endpoints on the DO and PL routers) and `public-do-qr.ts` never mints —
  `tests/do-qr-public.test.mjs` pins both properties. But a printed DO that leaves the
  building carries a permanently valid dispatch/deliver credential for that document.
- **`public-do-qr.ts`'s header claims "minimal exposure"** (`src/api/routes/public-do-qr.ts:19`).
  True for `GET /:token`. **Not true for `GET /:token/edit`**, added later for the item-edit
  flow: it also returns every *addable* production order for that customer and state — PO
  number, product code and name, size, fabric code, quantity, racking number, SO number and
  customer PO number (`src/api/routes/public-do-qr.ts:517-531`). Still no prices, still one
  customer, but it is a pipeline listing, not a document summary.
- **`delivery_incomplete` must be read dual-keyed.** The row type declares both spellings
  with the reason in place (`src/api/routes/public-do-qr.ts:88-94`) and
  `tests/delivery-incomplete-dual-key.test.mjs` fails any reader that drops the camelCase
  fallback. This is the camelCase read trap from `docs/BUG-CLASSES.md`, and this column is
  one of its recorded instances.
- **`organisations` GET is the one unpermissioned endpoint in these eight.** Any logged-in
  user — any role — gets the full registry including registration number, TIN, address,
  phone and email for every organisation row. That is probably intentional (the sidebar org
  switcher needs the list for everyone), but it is not gated and it is not org-filtered; see
  finding S1.
- **Active-org is global, not per-user.** `PUT /api/organisations` with `{ orgId }` writes
  `inter_company_config.active_org_id` on the singleton row
  (`src/api/routes/organisations.ts:466`). One user switching the org switcher changes it
  for everybody.
- **A lead's customer row is minted org-blind.** `createPotentialCustomerForLead`
  (`src/api/routes/sales-leads.ts:144-150`) does not list `orgId` in its INSERT, so the row
  takes the SQL default `'hookka'` from `migrations/0049_multi_tenant_skeleton.sql:32`
  regardless of who created it. Same shape as the write-side gap already recorded for
  consignments in `docs/BUG-CLASSES.md` C12 — see finding S3.
- **`send-quote` will email an arbitrary attachment to an arbitrary address.** Recipient and
  base64 PDF both come from the request body (`src/api/routes/customer-crm.ts:431-432`) and
  neither the `customerId` nor the recipient is checked against the customer's stored email
  or even against the org. Capped at ~5 MB, gated only on `customers:update`. Deliberate
  ("the operator clicked Send"), but it is an outbound mail primitive on the company's
  sending domain — see finding S4.
- **Tests here pin source text, not behaviour.** `tests/sales-leads.test.mjs` asserting
  "tenant-scoped" means the string `org_id = ?` appears in the file — it did not notice that
  the `customers` INSERT three functions down has no org at all. When you add a scope, add
  the assertion for *that statement*, not for the file.

---

## Security findings (raised to the owner 2026-08-13, not silently filed)

Ranked by what an attacker actually gets. **S1–S3 are cross-tenant issues that are inert
today because prod is a single org (`'hookka'`)** — they are pre-existing traps for the
second tenant, not live leaks. S4 and S5 apply now.

**S1 — `organisations.ts` is entirely org-blind, read AND write.** `loadOrganisations`
(`src/api/routes/organisations.ts:161`) selects the whole table with no `WHERE org_id`,
even though the column exists and the router itself creates a `(org_id, code)` unique index
(`src/api/routes/organisations.ts:193`, `:201`). PATCH (`:328`), DELETE (`:429`) and PUT
(`:454`) resolve rows by bare `id`, so `organisations:update` in one tenant edits or
soft-deletes another tenant's company record. POST hard-codes `'hookka'` (`:295`) and its
duplicate check is `WHERE code = ?` with no org (`:266`). GET is additionally the only
endpoint in these eight with no `requirePermission` — every authenticated user reads every
org's TIN and registration number. Same class as the `audit-events.ts` leak fixed earlier
this session.

**S2 — the OCR few-shot pool is a shared, unpartitioned corpus.** `po_scan_samples` has no
org column (`migrations/0026_po_scan_samples.sql`), and `GET /api/scan-po/samples/by-po/:poIdentifier`
(`src/api/routes/scan-po.ts:847`) returns the full extracted PO JSON — customer, PO number,
line items, unit prices — to anyone with `purchase-orders:create` who can name the PO
string, with no org filter. `PATCH .../by-po/:poIdentifier` (`:904`) writes across orgs the
same way. Worse than a read: few-shot selection at `src/api/lib/scan-engine.ts:1090-1103`
draws the top 3 confirmed samples with **no org predicate**, so one tenant's confirmed
customer PO can be injected verbatim into another tenant's OCR prompt.

**S3 — `sales-leads.ts` mints customers into the wrong org.** `createPotentialCustomerForLead`
(`src/api/routes/sales-leads.ts:144`) omits `orgId`, which defaults to `'hookka'`
(`migrations/0049_multi_tenant_skeleton.sql:32`). A lead created by a second tenant produces
a customer account in tenant one. `POST /:id/convert`'s `customer_products` copy
(`src/api/routes/sales-leads.ts:332`) has the same omission.

**S4 — `POST /api/customer-crm/send-quote` is an authenticated open mail relay.** Recipient,
subject, note and the entire base64 attachment are caller-supplied
(`src/api/routes/customer-crm.ts:429-462`); nothing ties the recipient to the named customer
or the caller's org. Anyone with `customers:update` can send an arbitrary ≤5 MB PDF from the
company's configured sending identity to any address. The body note is HTML-escaped
(`src/api/routes/customer-crm.ts:500`), so this is exfiltration/abuse surface, not injection.
**Owner decision needed** — this may be exactly what was wanted; if so it should say so in
the code, and if not the fix is to bind `to` to the customer's stored contacts.

**S5 — 2FA step 2 does not re-check the password, by design; please confirm that is still
what you want.** `POST /api/auth/totp/login-verify` (`src/api/routes/auth-totp.ts:183`) takes
`{ userId, code }` and issues a full session (`src/api/routes/auth-totp.ts:255-268`). It
never verifies that the caller completed step 1 — no pending token, no password. The
intent is explicit at `src/api/routes/auth.ts:237-238` ("Returning userId (NOT a token) is
intentional — userId alone is useless without a valid TOTP/recovery code"), so this is a
recorded decision, not an oversight. The consequence is that for an enrolled user the
password stops being a factor: possession of a valid TOTP code or one recovery code is
sufficient, given the user id. Mitigations that hold today: user ids are UUIDs, the throttle
is 10 attempts / 15 min per user id (`src/api/routes/auth-totp.ts:203`) which puts a 6-digit
brute force out of reach, and recovery codes are 10 characters of CSPRNG output
(`src/api/lib/totp.ts:98-116`). The cheap hardening, if wanted, is a short-lived
server-side pending-2FA token minted by `/login` and required here.

**Not a finding, checked and clear:** the public QR write path (org taken from the resolved
row, forward-only, server-rebuilt item set, shared cascade); `scan-queue.ts` (org-scoped
throughout, and the `/retry` id-only UPDATE is gated by an org-filtered SELECT above it);
`customer-crm.ts` (org-scoped on every statement); `auth-totp.ts`'s six session-required
handlers (subject always from the context, never the body); and the assistant's two-layer
tool gate.
