# Delivery & Consignment — Module Guide

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](../DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `src/api/routes/delivery-orders.ts`, `src/api/routes/delivery-orders/_helpers.ts`, `src/api/routes/{packing-lists,cn-packing-lists,delivery-agent,consignment-notes,consignment-orders,drivers,three-pl-state-rates}.ts`, `src/api/lib/delivery-agent.ts`, `src/pages/delivery/*`, `src/pages/consignment/note.tsx`, and `tests/`.
> Corrected 2026-08-13: **`delivery-orders.ts` was split** — it is now 3,010 lines of route handlers plus `src/api/routes/delivery-orders/_helpers.ts` (5,254 lines) holding every shared helper. Fourteen anchors this doc gave as `delivery-orders.ts:NNNN` pointed past that file's end or at unrelated code; all are re-pointed at `_helpers.ts` below. CN handler anchors moved 60–120 lines.

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Owns the goods-out lifecycle: **Delivery Orders** (DO) from confirmed SOs through the status
machine (DRAFT → LOADED → IN_TRANSIT → DELIVERED → INVOICED **plus two non-linear edges added
2026-08-07, both in `VALID_TRANSITIONS` at `delivery-orders/_helpers.ts:94-108`: CANCELLED is
reachable from EVERY live status and is terminal, and INVOICED → DELIVERED exists so a voided
invoice hands the DO back — without them a DO past DRAFT was immortal and a voided invoice lost
the revenue**), the driver-sticker QR scan path,
**packing lists** (truck-run grouping), **3PL provider management** (vehicles / in-house + 3PL
drivers / per-state rate cards), and the **Consignment Note** (CN) track — an intentional DO-parity
mirror for consignment stock. A **Delivery Agent** (AI ops layer) generates a daily brief +
approve/reject proposals (POD chasing, delivered-not-invoiced, cheapest-3PL routing). Dispatch/
deliver write `stock_movements` and read `fg_units`, and fire idempotent customer emails
(dispatch → DO PDF, delivered → Invoice PDF). Money is integer sen.

## Entry points
- Pages
  - `/delivery` → `src/pages/delivery/index.tsx:882` (`DeliveryPage`) — DO workbench **and** the whole
    3PL provider UI, behind a `pageTab` toggle (`orders` | `3pl` | `agent`, URL `?section=`).
  - `/delivery/:id` → `src/pages/delivery/detail.tsx` (single DO detail; the drawer's "Open full page")
  - DO detail **drawer** (right slide-over, opened from a row) → chrome `src/components/ui/document-detail-drawer.tsx`,
    model `src/lib/document-drawer.ts`, body inline in `delivery/index.tsx` (was a centred modal until 2026-08-08)
  - Delivery Agent tab → `src/pages/delivery/agent-tab.tsx:128` (`DeliveryAgentTab`; rendered inline when `pageTab==="agent"`)
  - `/consignment/note` → `src/pages/consignment/note.tsx:454` (`ConsignmentNotePage`; CN workbench, DO-parity)
  - CO list/create/edit/detail/return → `src/pages/consignment/{index,create,edit,detail,return}.tsx`
- API routes
  - DO routes → `src/api/routes/delivery-orders.ts` (3010 lines) — **handlers only**; every shared
    helper lives in `src/api/routes/delivery-orders/_helpers.ts` (5254). Mounted `worker.ts:1202`.
  - Delivery-side packing lists → `src/api/routes/packing-lists.ts` (802)
  - Delivery Agent (brief / proposals / run) → `src/api/routes/delivery-agent.ts` (780) + engine `src/api/lib/delivery-agent.ts` (1256)
  - Consignment Notes → `src/api/routes/consignment-notes.ts` (2152); CN packing lists → `src/api/routes/cn-packing-lists.ts` (731)
  - Consignment Orders → `src/api/routes/consignment-orders.ts` (2815); legacy/aggregate → `src/api/routes/consignments.ts` (588)
  - In-house drivers → `src/api/routes/drivers.ts` (314); 3PL → `three-pl-drivers.ts` / `three-pl-vehicles.ts` / `three-pl-state-rates.ts`
  - Shared PDF/piece helpers → `src/api/lib/print-extras-shared.ts`

## Data model
- `delivery_orders` / `delivery_order_items` — DO header + lines. `status` follows `VALID_TRANSITIONS`
  (`delivery-orders/_helpers.ts:87`). Runtime-added notify stamps `dispatchEmailAt` / `deliveredEmailAt` and the
  `deliveryIncomplete` flag are IF-NOT-EXISTS self-applied (`ensureNotifyEmailColumns` `_helpers.ts:3567`, `ensureDeliveryIncompleteColumn` `_helpers.ts:3601`).
- `packing_lists` / `cn_packing_lists` — truck-run grouping of DOs / CNs (snake_case).
- `consignment_notes` / `consignment_items` — CN = consignment DO-equivalent (dispatch → delivered → acknowledged / RETURNED).
- `delivery_proposals` / `delivery_briefs` — Delivery Agent output (snake_case; created by `ensureDeliveryAgentTables` in `src/api/lib/delivery-agent.ts`).
- `drivers`, `three_pl_vehicles` / `three_pl_drivers` / `three_pl_state_rates` — fleet + per-state rate card.
- `consignment_orders` — CO header that CNs draw value from (CO CRUD in `consignment-orders.ts`; see [[sales]]).
- Cross-reads: `sales_orders`, `fg_units`, `stock_movements`, `invoices`, `cost_ledger` (append-only).
- Relationships: dispatch/deliver writes `stock_movements` + reads `fg_units`; DELIVERED→INVOICED builds an
  invoice (`buildDoDeliveredSoAndInvoice` `_helpers.ts:1558`) and cascades the SO. DOs/CNs chain through a `hubId` composition guard
  (`validateDoComposition` `_helpers.ts:2035` on create and edit).
- DO ids/nos generated by `genDoId` (`_helpers.ts:630`) / `genNextDoNo` (`:642`); rows shaped by `rowToOrder` (`:461`) / `rowToOrderList` (`:595`) / `rowToItem` (`:317`) — all in `_helpers.ts`.

## Core flows
1. **Create DO from POs** — `app.post("/")` `delivery-orders.ts:1939` → `createDeliveryOrderForPOs` (`_helpers.ts:2164`), after
   `validateDoComposition` (`_helpers.ts:2035`) enforces the hub-integrity guard. PL-first variant: `app.post("/packing-list-first")` (`delivery-orders.ts:1986`).
2. **Status transition + edit** — `app.put("/:id")` `delivery-orders.ts:2949` → `applyDeliveryOrderUpdate` (`_helpers.ts:4194`); every
   move is checked against `VALID_TRANSITIONS[existing.status]` (`_helpers.ts:4249`). Bulk moves come from FE `runBulkDoTransition`
   (`delivery/index.tsx:3002`). DELIVERED→INVOICED builds SO + invoice via `buildDoDeliveredSoAndInvoice` (`_helpers.ts:1558`) /
   `computeDoInvoiceLines` (`_helpers.ts:1342`).
3. **Customer notice (backend safety-net)** — any transition calls `fireCustomerNoticeBestEffort` (`_helpers.ts:131`),
   which fire-and-forgets `queueDoCustomerNotice` (`_helpers.ts:3637`). Idempotency = atomic `UPDATE … WHERE dispatchEmailAt/deliveredEmailAt IS NULL`;
   whichever caller (QR scan, bulk action, FE button) wins the claim sends exactly one email. Manual re-send: `app.post("/:id/resend-notice")` (`delivery-orders.ts:2536`).
4. **Delivery Agent** — `app.get("/brief.json")` (`delivery-agent.ts:144`) serves `collectDeliveryBrief` (`lib/:633`);
   `app.post("/proposals/generate")` (`:165`) → `generateDeliveryProposals` (`lib/:868`); approve `:260` / reject just below.
   Cheapest-3PL routing via `loadStateRateCard` / `cheapestForState` in `src/api/lib/delivery-agent.ts`.
5. **Consignment Note** — `app.post("/")` `consignment-notes.ts:798` (create), `app.post("/:id/return")` (`:1073`),
   `app.post("/:id/convert-to-invoice")` (`:1419`), `app.post("/:id/notify-customer")` (`:1771`), `app.put("/:id")` (`:2109`).

## Key functions / sections (locate-to-function)
| Symbol / section | file:line | Role |
|---|---|---|
| `DeliveryPage` | `src/pages/delivery/index.tsx:882` | DO workbench + 3PL + agent, `pageTab` toggle |
| `runBulkDoTransition` | `src/pages/delivery/index.tsx:3002` | FE bulk status move (all guards/cascades) |
| `resendCustomerNotice` / `warnIfNoCustomerEmail` | `delivery/index.tsx:2891 / :2873` | Feature A per-DO resend / Feature B no-email warning |
| `columns` (DataGrid) | `src/pages/delivery/index.tsx` (~3.9k) | DO grid column defs |
| `getContextMenuItems` | `src/pages/delivery/index.tsx` (~4.4k) | THE DO status table — row menu **and** the drawer's action bar |
| `detailLive` | `src/pages/delivery/index.tsx:3653` | Drawer's document re-read from the list; its bar filtered from the row menu |
| `lineSpec` | `src/pages/delivery/index.tsx:3686` | One-line build spec per DO line, via the shared `buildSpec` |
| `drawerActionBar` / `drawerLineSpec` / `DRAWER_DOC_CONFIG` | `src/lib/document-drawer.ts` | Drawer model: full-page route, action-bar filter, spec-line delegation |
| `DocumentDetailDrawer` | `src/components/ui/document-detail-drawer.tsx` | Shared slide-over chrome (chrome only, no domain knowledge) |
| 3PL Providers block | `src/pages/delivery/index.tsx` (~6.5k) | `pageTab==="3pl"` list + Create/Edit dialog |
| `DeliveryAgentTab` | `src/pages/delivery/agent-tab.tsx:128` | Brief strip + proposal approve/reject |
| `ConsignmentNotePage` | `src/pages/consignment/note.tsx:454` | CN workbench (DO-parity mirror) |
| `VALID_TRANSITIONS` | `delivery-orders/_helpers.ts:87` | DO status machine |
| `fireCustomerNoticeBestEffort` | `delivery-orders/_helpers.ts:131` | Backend notice safety-net (waitUntil) |
| `createDeliveryOrderForPOs` | `delivery-orders/_helpers.ts:2164` | Build a DO from POs |
| `validateDoComposition` | `delivery-orders/_helpers.ts:2035` | Hub-integrity composition guard |
| `applyDeliveryOrderUpdate` | `delivery-orders/_helpers.ts:4194` | DO edit + transition apply |
| `buildDoDeliveredSoAndInvoice` / `computeDoInvoiceLines` | `delivery-orders/_helpers.ts:1558 / 1342` | DELIVERED→INVOICED SO + invoice build |
| `queueDoCustomerNotice` | `delivery-orders/_helpers.ts:3637` | Recipient chain + idempotent email claim |
| `app.post("/packing-list-first")` | `src/api/routes/delivery-orders.ts:1986` | PL-first auto-split create |
| `createPackingListCore` | `src/api/routes/packing-lists.ts:628` | Truck-run packing-list build |
| `collectDeliveryBrief` / `generateDeliveryProposals` | `src/api/lib/delivery-agent.ts:633 / 868` | Agent brief + proposals |
| `cheapestForState` / `loadStateRateCard` | `src/api/lib/delivery-agent.ts` | Cheapest-3PL routing |
| `ensureThreePlStateRatesSchema` | `src/api/routes/three-pl-state-rates.ts:43` | 3PL rate-card self-apply |
| `ensureDeliveryAgentTables` | `src/api/lib/delivery-agent.ts` | Creates `delivery_proposals` / `delivery_briefs` |
| CN create / return / convert-to-invoice / edit | `consignment-notes.ts:798 / 1073 / 1419 / 2109` | CN lifecycle handlers |
| CN packing list build | `src/api/routes/cn-packing-lists.ts:663` | POST create CN packing list |
| Drivers CRUD | `src/api/routes/drivers.ts:72 / 143 / 211 / 300` | In-house driver list / create / update / delete |

## Gotchas
- **CN is an intentional DO-parity mirror.** `delivery/index.tsx` and `consignment/note.tsx` share patterns — a fix
  usually must land in **both**. Shared PDF/piece logic lives in `print-extras-shared.ts`; the bulk-move helper
  `runBulkDoTransition` is shared FE — don't fork them.
- **Owner rulings.** CNs NEVER carry invoices; 3PL stays DO-side only. CN value is **derived** from the Consignment
  Order value, not stored.
- **ONE status table for the DO, not one per surface (2026-08-08).** The detail drawer's sticky action bar is
  `getContextMenuItems(row)` filtered by `drawerActionBar` — it does NOT re-derive what a status allows. The drawer
  used to keep its own `status === "DRAFT"` / `"LOADED"` ladder in the footer, which is how it ended up with a second
  Mark-Dispatched implementation. Add a move to the row menu and it appears on the bar (add the label to
  `DRAWER_DOC_CONFIG.DELIVERY_ORDER.actionBarLabels`); never add a button beside the bar.
- **The drawer's spec line is the PRINTED line.** `lineSpec` → `drawerLineSpec` → `buildSpec`
  (`src/lib/doc-line-format.ts`), the same formatter the DO / Invoice / CN / DR PDFs use. There are already three
  `describe()` copies in the PDF generators; do not make the screen a fourth. The heights / gap / category /
  special-order inputs come from `/print-extras`, i.e. the payload the PDF is built from.
- **Status machine is a guard, not labels.** Moves must satisfy `VALID_TRANSITIONS` (`delivery-orders/_helpers.ts:87`). The
  `dispatched` tab deliberately includes IN_TRANSIT (row stays visible after loading); DB status for "dispatched" is `LOADED`. Don't bypass the guard.
- **Notify idempotency lives in folded-lowercase cols.** `dispatchemailat` / `deliveredemailat` — db-pg `toCamel` does NOT
  recover these; read dual-keyed (`r.dispatchEmailAt ?? r.dispatchemailat`). CN dispatch uses `dispatchemailat` (mig 0163).
  The notice safety-net fires from the backend transition choke-point so QR-scan / bulk / stale-FE paths still email exactly once.
- **PL-first auto-split.** DOs auto-split by 3PL state/packing before dispatch. Known gap: DO write paths still lack a
  `0/0 hasRate` guard on 3PL state rates.
- **Production locks are inviolate.** Dispatch/deliver respect COMPLETED job_cards / non-PENDING fg_units; movements go into `stock_movements`, `cost_ledger` is append-only.
- **New DB columns = snake_case** + a `column-rename-map.json` entry or the write 400s "Invalid request body". Notify/incomplete
  columns are runtime self-applied (`ensureNotifyEmailColumns` / `ensureDeliveryIncompleteColumn`), not by migration file alone.
- **QR sticker URLs encode `window.location.origin`** (print-time domain); scanning is path-based + domain-agnostic. See `tests/do-qr-public.test.mjs`.

## Common tasks (mini-playbook)
- **Add a field to a DO** → runtime `ALTER … ADD COLUMN IF NOT EXISTS` (pattern `ensureNotifyEmailColumns` `_helpers.ts:3567`)
  awaited before the first write in `app.put("/:id")` (`delivery-orders.ts:2949`); persist in `applyDeliveryOrderUpdate` (`_helpers.ts:4194`); surface in
  `rowToOrder` (`_helpers.ts:461`) / `rowToOrderList` (`:595`); render in the `delivery/index.tsx` grid columns. snake_case + rename-map if camelCase. Mirror in CN if applicable.
- **Change the DO status cascade** → edit `VALID_TRANSITIONS` (`_helpers.ts:87`) + `applyDeliveryOrderUpdate` (`_helpers.ts:4194`); keep the
  DELIVERED→INVOICED build (`buildDoDeliveredSoAndInvoice` `_helpers.ts:1558`) and `fireCustomerNoticeBestEffort` (`_helpers.ts:131`) in sync.
- **Touch the notice email** → change `queueDoCustomerNotice` (`_helpers.ts:3637`) only; never scatter new FE triggers. Verify with `tests/delivery-pipeline.test.mjs`.
- **Adjust Delivery Agent proposals** → `generateDeliveryProposals` / `collectDeliveryBrief` (`lib/delivery-agent.ts:868 / 633`); routing in `cheapestForState` (same file).
- **Touch CN flow** → mirror the DO change in `consignment-notes.ts` (create `:798`, return `:1073`, convert-to-invoice `:1419`, edit `:2109`) and `consignment/note.tsx`.

## Related modules
[[sales]] [[accounting]] [[procurement]] [[production]] [[inventory]]
