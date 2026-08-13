# Context Pack: Core ERP Flow

> **Last verified: 2026-08-13** — every route file, page directory and shared-logic file listed here exists (`src/api/lib/document-lifecycle.ts`, `src/lib/production-order-builder.ts`, `src/api/lib/journal-hash.ts`, the 9 route files, the 5 page directories).

Use this pack for the main Hookka ERP flow: Sales Order → Production Order → Job Card → Finished Goods → Delivery Order → Invoice → Accounting.

> Flow / status-transition / cascade changes are **deep review** — trace the exact flow before editing and add/keep tests. See `docs/DEV-OPERATING-FRAMEWORK.md`; `src/api/lib/document-lifecycle.ts` + `src/lib/delivery-pipeline.ts` own the transitions.

## Read first

### Frontend

- `src/pages/sales/`
- `src/pages/production/`
- `src/pages/delivery/`
- `src/pages/invoices/`
- `src/pages/accounting/`

### Backend

- `src/api/routes/sales-orders.ts`
- `src/api/routes/production-orders.ts`
- `src/api/routes/job-cards.ts`
- `src/api/routes/fg-units.ts`
- `src/api/routes/delivery-orders.ts`
- `src/api/routes/packing-lists.ts`
- `src/api/routes/invoices.ts`
- `src/api/routes/payments.ts`
- `src/api/routes/accounting.ts`

### Shared logic and DB

- `src/api/lib/document-lifecycle.ts`
- `src/api/lib/journal-hash.ts`
- `src/lib/production-order-builder.ts`
- Relevant migrations for `sales_orders`, `production_orders`, `job_cards`, `fg_units`, `delivery_orders`, `invoices`, and accounting tables.

## Useful searches

```bash
rg -n "sales_orders|production_orders|job_cards|fg_units|delivery_orders|invoices|journal" migrations-postgres src/api src/pages tests
rg -n "CONFIRMED|IN_PRODUCTION|READY_TO_SHIP|DELIVERED|INVOICED|CLOSED|CANCELLED" src/api src/pages docs
rg -n "/api/(sales-orders|production-orders|job-cards|fg-units|delivery-orders|invoices|accounting)" src/pages
```

## Suggested output format for audits

- Frontend page and user action.
- API endpoint called.
- Backend handler and validation.
- DB tables read/written.
- Status transition or accounting effect.
- Tests that cover the behavior.
