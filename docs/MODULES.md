# Modules

Per-module reference — what each screen does, what API it talks to, and what
entity in `mock-data.ts` it touches. Modules are listed in the order they
appear in the left sidebar.

If you need implementation-level detail, `src/pages/<module>/*` is the code;
this file is the map.

---

## Dashboard

**Route** `/dashboard` • **Code** `src/pages/dashboard/`

Landing page with KPI tiles and quick-glance summaries:

- Today's orders, production throughput, deliveries out
- AR aging / AP aging snapshots
- Stock alert list (out of stock + low stock, pulled via stock thresholds)
- Recent activity feed

Reads: most GET endpoints. Writes: none.

---

## Sales

**Route** `/sales` • **Code** `src/pages/sales/`

Quotations → Sales Orders. The system of record for customer commitments.

| Screen     | Route                | Purpose                                     |
| ---------- | -------------------- | ------------------------------------------- |
| Index      | `/sales`             | Filterable list of all SOs, by status       |
| Create     | `/sales/create`      | Wizard: customer → items → pricing → review |
| Detail     | `/sales/:id`         | Full SO view with status actions + PDF      |
| Edit       | `/sales/:id/edit`    | Re-enter wizard in edit mode                |

**Entities** — `SalesOrder`, `SalesOrderItem`, `SOStatusChange`,
`PriceOverride`
**API** — `/api/sales-orders`
**Status lifecycle** — DRAFT → CONFIRMED → IN_PRODUCTION → READY_TO_SHIP →
SHIPPED → DELIVERED → INVOICED → CLOSED (plus ON_HOLD / CANCELLED branches)

Confirming a DRAFT SO auto-generates the corresponding Production Orders via
`lib/production-order-builder.ts`.

---

## Production

**Route** `/production` • **Code** `src/pages/production/`

Production Orders (one per SO item per department), job cards, QR scanning
for stage sign-off, FG sticker printing.

| Screen           | Route                               | Purpose                                                                 |
| ---------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| Index            | `/production`                       | All POs, filter by status / department / SO                             |
| Detail           | `/production/:id`                   | Single PO, job cards per department, material picks, scan history       |
| Department       | `/production/department/:code`      | Shop-floor view — queue of pending job cards for ONE department         |
| Scan             | `/production/scan`                  | QR entry point for workers (scan badge → scan job card → sign off)      |
| FG Scan          | `/production/fg-scan`               | Scan finished-unit sticker to mark PACKED / LOADED / DELIVERED          |

**Entities** — `ProductionOrder`, `JobCard`, `FGUnit`, `QCInspection`
**API** — `/api/production-orders`, `/api/fg-units`, `/api/qc-inspections`
**Persistence** — in-progress job-card state auto-saves to localStorage via
`lib/job-card-persistence.ts`

### Production-test (`/production-test`)

Parallel copy with an experimental sticker-identity flow (batch-level
identity instead of SO-item identity). Shares no API endpoints with the main
flow — see `docs/B-FLOW.md`.

---

## Delivery

**Route** `/delivery` • **Code** `src/pages/delivery/`

Truck dispatch, loading sheets, POD.

| Screen | Route             | Purpose                                                     |
| ------ | ----------------- | ----------------------------------------------------------- |
| Index  | `/delivery`       | All DOs, by status / lorry / driver / date                  |
| Detail | `/delivery/:id`   | Single DO, FG units loaded, driver + lorry, sign-off, POD   |

**Entities** — `DeliveryOrder`, `DeliveryOrderItem`, `Lorry`, `Driver`
**API** — `/api/delivery-orders`, `/api/lorries`, `/api/drivers`
**Status lifecycle** — DRAFT → LOADED → DISPATCHED → IN_TRANSIT → SIGNED →
DELIVERED → INVOICED → CANCELLED

### Delivery-test (`/delivery-test`)

Parallel copy using Master-QR + sign-all flow. See `docs/B-FLOW.md`.

---

## Invoices

**Route** `/invoices` • **Code** `src/pages/invoices/`

Accounts-receivable side — invoices, payments, credit/debit notes, e-invoice
submission to the MY portal.

| Screen        | Route                       | Purpose                                           |
| ------------- | --------------------------- | ------------------------------------------------- |
| Index         | `/invoices`                 | All invoices, filter by customer / status / aging |
| Detail        | `/invoices/:id`             | Single invoice, line items, payments, PDF         |
| Payments      | `/invoices/payments`        | Payment log with allocations                      |
| Credit Notes  | `/invoices/credit-notes`    | CN issuance + printing                            |
| Debit Notes   | `/invoices/debit-notes`     | DN issuance + printing                            |
| E-Invoice     | `/invoices/e-invoice`       | LHDN MyInvois submission + status                 |

**Entities** — `Invoice`, `InvoiceLine`, `Payment`, `CreditNote`, `DebitNote`,
`EInvoice`
**API** — `/api/invoices`, `/api/payments`, `/api/credit-notes`,
`/api/debit-notes`, `/api/e-invoices`

---

## Procurement

**Route** `/procurement` • **Code** `src/pages/procurement/`

Supplier-side counterpart to Sales.

| Screen        | Route                        | Purpose                                              |
| ------------- | ---------------------------- | ---------------------------------------------------- |
| Index         | `/procurement`               | All purchase orders, by supplier / status            |
| Detail        | `/procurement/:id`           | Single PO, items, 3-way match status, GRN linkage    |
| GRN           | `/procurement/grn`           | Goods-receipt notes — match PO vs invoice vs receipt |
| In Transit    | `/procurement/in-transit`    | International shipments (ETA, customs, hand-off)     |
| Maintenance   | `/procurement/maintenance`   | Supplier master + material map                       |
| PI            | `/procurement/pi`            | Proforma invoices (pre-GRN)                          |
| Pricing       | `/procurement/pricing`       | Unit-price history per supplier × material           |

**Entities** — `PurchaseOrder`, `GRN`, `Supplier`, `SupplierMaterial`,
`SupplierScorecard`, `ThreeWayMatch`, `GoodsInTransit`, `PriceHistory`
**API** — `/api/purchase-orders`, `/api/grn`, `/api/suppliers`,
`/api/supplier-materials`, `/api/supplier-scorecards`,
`/api/three-way-match`, `/api/goods-in-transit`, `/api/price-history`

`lib/po-parser.ts` extracts structured line-items from supplier-emailed PO
PDFs so procurement doesn't re-enter them by hand.

---

## Inventory

**Route** `/inventory` • **Code** `src/pages/inventory/`

On-hand stock across every category (FG / WIP / raw materials).

| Screen       | Route                       | Purpose                                                       |
| ------------ | --------------------------- | ------------------------------------------------------------- |
| Index        | `/inventory`                | Tabbed: FG, WIP (with age), Raw Materials                     |
| Fabrics      | `/inventory/fabrics`        | Fabric rolls + issue/return log                               |
| Stock Value  | `/inventory/stock-value`    | Monetary valuation per category                               |

**Entities** — everything under `StockItem`, `WIPItem`, `Fabric`, plus
`RackLocation` in Warehouse.
**API** — `/api/inventory`, `/api/fabrics`, `/api/fabric-tracking`,
`/api/stock-value`
**Thresholds** — `STOCK_THRESHOLD` and `WIP_AGE_THRESHOLD` in
`design-tokens.ts` drive the colour coding.

---

## BOM and Products

**Routes** `/bom`, `/products` • **Code** `src/pages/bom/`, `src/pages/products/`

Product catalogue + BOM hierarchy.

| Screen           | Route                   | Purpose                                                |
| ---------------- | ----------------------- | ------------------------------------------------------ |
| BOM browser      | `/bom`                  | All BOM versions, rolled-up RM totals per FG           |
| Products list    | `/products`             | Product master (SKU, variants, pricing matrix)         |
| Product BOM      | `/products/:id/bom`     | Per-product BOM tree: FG → WIP → RM                    |

**Entities** — `Product`, `ProductConfig`, `BOMVersion`, `BOMLine`
**API** — `/api/products`, `/api/product-configs`, `/api/bom`

BOM hierarchy: `FG → WIP (Divan + Headboard for bedframes) → RM`. WIP rows
are *not* a static catalogue — they're derived per SO variant from the
department configs in the Production Sheet.

---

## Customers

**Route** `/customers` • **Code** `src/pages/customers.tsx`

Customer master with per-customer delivery hubs.

**Entities** — `Customer`, `CustomerHub`
**API** — `/api/customers`, `/api/customer-hubs`

Key principle: one customer has many delivery addresses (`CustomerHub`),
not many customer records. The hub is what DOs reference.

---

## Employees

**Route** `/employees` • **Code** `src/pages/employees.tsx`

Workers, attendance, leaves, payroll.

**Entities** — `Worker`, `AttendanceRecord`, `LeaveRequest`, `Payroll`,
`Payslip`
**API** — `/api/workers`, `/api/attendance`, `/api/leaves`,
`/api/payroll`, `/api/payslips`

The payslip PDF generator (`lib/generate-payslip-pdf.ts`) mirrors the
statutory format (EPF / SOCSO / EIS columns).

---

## Warehouse

**Route** `/warehouse` • **Code** `src/pages/warehouse.tsx`

Rack layout, occupancy per slot, put-away + picking suggestions.

**Entities** — `RackLocation`, `StockItem.rackId`
**API** — `/api/warehouse`
**Status colour** — `RACK_STATUS_COLOR` (EMPTY = success, OCCUPIED = info,
RESERVED = warning)

---

## Consignment

**Route** `/consignment` • **Code** `src/pages/consignment/`

Stock placed at customer branches — sells through, returns, damaged
write-off.

| Screen  | Route                   | Purpose                                              |
| ------- | ----------------------- | ---------------------------------------------------- |
| Index   | `/consignment`          | All consignment stock, filter by branch / status     |
| Detail  | `/consignment/:id`      | Single consignment item                              |
| Create  | `/consignment/create`   | Place new stock at branch                            |
| Note    | `/consignment/note`     | Consignment note PDF (movement receipt)              |
| Return  | `/consignment/return`   | Pull stock back from branch                          |

**Entities** — `Consignment`, `ConsignmentNote`
**API** — `/api/consignments`, `/api/consignment-notes`
**Status** — AT_BRANCH → SOLD / RETURNED / DAMAGED

---

## Accounting

**Route** `/accounting` • **Code** `src/pages/accounting/`

Chart of accounts + the four canonical financial statements.

| Screen    | Route                     | Purpose                                             |
| --------- | ------------------------- | --------------------------------------------------- |
| Index     | `/accounting`             | Chart of accounts, P&L, Balance Sheet               |
| Cash Flow | `/accounting/cash-flow`   | Direct-method cash-flow statement + monthly roll-up |

**Entities** — `ChartOfAccount`, `JournalEntry`, `CashFlowEntry`
**API** — `/api/accounting`, `/api/cash-flow`
**Colour convention** — `COA_TYPE_COLOR` in design-tokens (Asset = info,
Liability = danger, Equity = plum, Revenue = success, Expense = warning).
P&L section tints (Revenue / COGS / Opex) and Balance-Sheet section tints
(Assets / Liabilities / Equity) follow the same map.

---

## Planning

**Route** `/planning` • **Code** `src/pages/planning/`

Capacity planning + Material Requirements Planning.

| Screen | Route            | Purpose                                    |
| ------ | ---------------- | ------------------------------------------ |
| Index  | `/planning`      | Capacity board, promise date calculator    |
| MRP    | `/planning/mrp`  | RM shortfall vs open POs (netting + suggest) |

**API** — `/api/scheduling`, `/api/mrp`, `/api/promise-date`,
`/api/production/leadtimes`
**Helper** — `lib/scheduling.ts` is the capacity-aware scheduler.

---

## Quality

**Route** `/quality` • **Code** `src/pages/quality.tsx`

QC inspections per production stage. PASS / CONDITIONAL_PASS / FAIL /
MINOR / MAJOR / CRITICAL severity.

**Entities** — `QCInspection`
**API** — `/api/qc-inspections`

---

## R&D

**Route** `/rd` • **Code** `src/pages/rd/`

Project pipeline with stages CONCEPT → DESIGN → PROTOTYPE → TESTING →
APPROVED → PRODUCTION_READY.

| Screen | Route       | Purpose                                               |
| ------ | ----------- | ----------------------------------------------------- |
| Index  | `/rd`       | Kanban / list of projects, filter by stage / type     |
| Detail | `/rd/:id`   | Project detail + prototype lineage                    |

**Entities** — `RDProject`, `Prototype`
**API** — `/api/rd-projects`
**Colour map** — `RD_STAGE_COLOR`, `RD_PROJECT_TYPE_COLOR`.

---

## Analytics — Forecast

**Route** `/analytics/forecast` • **Code** `src/pages/analytics/forecast.tsx`

Historical-sales-driven demand forecast + variance vs actual.

**API** — `/api/forecasts`, `/api/historical-sales`

---

## Reports / Documents / Notifications / Approvals / Maintenance

Single-page modules. Each one is a filtered list backed by its eponymous API:

- **Reports** (`/reports`) — pre-defined operational reports, exported to PDF
- **Documents** (`/documents`) — uploaded attachments per entity
- **Notifications** (`/notifications`) — system + user notifications log
- **Approvals** (`/approvals`) — queued approval requests (price overrides,
  leave, PO > threshold, etc.)
- **Maintenance** (`/maintenance`) — equipment maintenance logs

---

## Settings

**Route** `/settings` • **Code** `src/pages/settings/`

| Screen        | Route                         | Purpose                                     |
| ------------- | ----------------------------- | ------------------------------------------- |
| Index         | `/settings`                   | Feature flags + app-wide config             |
| Organisations | `/settings/organisations`     | Multi-tenant support (company entities)     |
| Variants      | `/settings/variants`          | Product-variant matrix editor               |

**API** — `/api/organisations`, `/api/product-configs`

---

## Portal

**Route** `/portal` • **Code** `src/pages/portal/`

Customer-facing self-service. Separate layout (`PortalLayout`), not behind
the staff sidebar. Designed mobile-first.

| Screen      | Route                         | Purpose                                    |
| ----------- | ----------------------------- | ------------------------------------------ |
| Home        | `/portal`                     | Hub — recent orders, outstanding balance   |
| Orders      | `/portal/orders`              | All customer orders                        |
| Order detail| `/portal/orders/:id`          | Status + expected delivery + documents     |
| Deliveries  | `/portal/deliveries`          | In-transit + delivered shipments           |
| Account     | `/portal/account`             | Statements, aging, e-invoices              |

**API** — `/api/portal` (single façade) plus resource-scoped reads.

---

## Track

**Route** `/track` • **Code** `src/pages/track.tsx`

Standalone public FG-unit tracking. No auth. Mobile-friendly. Encoded in
the sticker QR so anyone scanning the sticker sees current status. Does not
leak PII — status + order number + product name only.

**Helper** — `lib/qr-utils.ts` builds the track URL.

---

## Auth

**Route** `/login` • **Code** `src/pages/login.tsx`

UI stub only. No real auth flow today.
