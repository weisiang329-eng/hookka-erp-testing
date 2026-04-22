# API

Reference for the Hono API that backs the frontend. Every route file lives in
`src/api/routes/` and is mounted by `src/api/index.ts`. All routes share the
same envelope, error format, and data-source (in-memory `mock-data.ts`).

---

## Server

**Entry point** — `src/api/index.ts`
**Runtime** — `@hono/node-server` via `tsx` (`npm run api`)
**Port** — `API_PORT` env, defaults to **3001**
**CORS origins** — `http://localhost:5173`, `http://localhost:3000`
**Health check** — `GET /health` → `{ status: "ok", timestamp: … }`

---

## Response envelope

Every route responds with one of two shapes:

```jsonc
// success
{
  "success": true,
  "data": <payload>,       // object or array
  "total"?: <number>       // present on list endpoints
}

// failure
{
  "success": false,
  "error": "<human-readable reason>"
}
```

HTTP status codes follow REST convention:

- `200` — successful read / update
- `201` — successful create
- `400` — bad input (missing required field, invalid body)
- `404` — resource not found
- `500` — unhandled server error (shouldn't happen under mock data)

---

## Resource conventions

Most resources expose the same six verbs:

```
GET    /api/<resource>/           # list
GET    /api/<resource>/:id        # read
POST   /api/<resource>/           # create
PUT    /api/<resource>/:id        # full update
PATCH  /api/<resource>/:id        # partial update
DELETE /api/<resource>/:id        # delete (soft where it matters)
```

Not every resource implements every verb — consult the specific route file.
Where a resource is derived (e.g. `/api/mrp`, `/api/cash-flow`) it is
read-mostly and often only exposes GET.

---

## Endpoint inventory

Mounted in `src/api/index.ts`. All paths are prefixed with `/api/`.

### Core sales → delivery → invoicing

| Route              | Resource              | File                          |
| ------------------ | --------------------- | ----------------------------- |
| `sales-orders`     | SalesOrder            | `routes/sales-orders.ts`      |
| `production-orders`| ProductionOrder       | `routes/production-orders.ts` |
| `delivery-orders`  | DeliveryOrder         | `routes/delivery-orders.ts`   |
| `invoices`         | Invoice               | `routes/invoices.ts`          |
| `payments`         | Payment               | `routes/payments.ts`          |
| `credit-notes`     | CreditNote            | `routes/credit-notes.ts`      |
| `debit-notes`      | DebitNote             | `routes/debit-notes.ts`       |
| `e-invoices`       | EInvoice (MY LHDN)    | `routes/e-invoices.ts`        |

### Customers, workers, org

| Route          | Resource         | File                       |
| -------------- | ---------------- | -------------------------- |
| `customers`    | Customer         | `routes/customers.ts`      |
| `customer-hubs`| CustomerHub      | `routes/customer-hubs.ts`  |
| `drivers`      | Driver           | `routes/drivers.ts`        |
| `lorries`      | Lorry            | `routes/lorries.ts`        |
| `workers`      | Worker           | `routes/workers.ts`        |
| `attendance`   | AttendanceRecord | `routes/attendance.ts`     |
| `leaves`       | LeaveRequest     | `routes/leaves.ts`         |
| `payroll`      | Payroll          | `routes/payroll.ts`        |
| `payslips`     | Payslip          | `routes/payslips.ts`       |
| `organisations`| Organisation     | `routes/organisations.ts`  |
| `departments`  | Department       | `routes/departments.ts`    |

### Product catalogue + BOM

| Route              | Resource                | File                          |
| ------------------ | ----------------------- | ----------------------------- |
| `products`         | Product                 | `routes/products.ts`          |
| `product-configs`  | ProductConfig (variant) | `routes/product-configs.ts`   |
| `bom`              | BOMVersion              | `routes/bom.ts`               |

### Procurement

| Route                | Resource                 | File                            |
| -------------------- | ------------------------ | ------------------------------- |
| `purchase-orders`    | PurchaseOrder            | `routes/purchase-orders.ts`     |
| `grn`                | GRN                      | `routes/grn.ts`                 |
| `suppliers`          | Supplier                 | `routes/suppliers.ts`           |
| `supplier-materials` | SupplierMaterial         | `routes/supplier-materials.ts`  |
| `supplier-scorecards`| SupplierScorecard        | `routes/supplier-scorecards.ts` |
| `three-way-match`    | ThreeWayMatchRecord      | `routes/three-way-match.ts`     |
| `goods-in-transit`   | GoodsInTransit           | `routes/goods-in-transit.ts`    |
| `price-history`      | PriceHistoryEntry        | `routes/price-history.ts`       |

### Inventory

| Route              | Resource         | File                          |
| ------------------ | ---------------- | ----------------------------- |
| `inventory`        | StockItem / WIP  | `routes/inventory.ts`         |
| `fabrics`          | FabricRoll       | `routes/fabrics.ts`           |
| `fabric-tracking`  | FabricIssueLog   | `routes/fabric-tracking.ts`   |
| `stock-value`      | StockValueRow    | `routes/stock-value.ts`       |
| `stock-accounts`   | StockAccount     | `routes/stock-accounts.ts`    |
| `warehouse`        | RackLocation     | `routes/warehouse.ts`         |
| `fg-units`         | FGUnit           | `routes/fg-units.ts`          |

### Planning / QC / R&D

| Route                   | Resource              | File                              |
| ----------------------- | --------------------- | --------------------------------- |
| `scheduling`            | ScheduleEntry         | `routes/scheduling.ts`            |
| `mrp`                   | MRPRow                | `routes/mrp.ts`                   |
| `promise-date`          | PromiseDateRow        | `routes/promise-date.ts`          |
| `production/leadtimes`  | ProductionLeadtime    | `routes/production-leadtimes.ts`  |
| `forecasts`             | DemandForecast        | `routes/forecasts.ts`             |
| `historical-sales`      | HistoricalSale        | `routes/historical-sales.ts`      |
| `qc-inspections`        | QCInspection          | `routes/qc-inspections.ts`        |
| `rd-projects`           | RDProject             | `routes/rd-projects.ts`           |

### Accounting / ops

| Route              | Resource               | File                          |
| ------------------ | ---------------------- | ----------------------------- |
| `accounting`       | ChartOfAccount + P&L   | `routes/accounting.ts`        |
| `cash-flow`        | CashFlowEntry          | `routes/cash-flow.ts`         |
| `consignments`     | Consignment            | `routes/consignments.ts`      |
| `consignment-notes`| ConsignmentNote        | `routes/consignment-notes.ts` |
| `equipment`        | Equipment              | `routes/equipment.ts`         |
| `maintenance-logs` | MaintenanceLog         | `routes/maintenance-logs.ts`  |
| `notifications`    | Notification           | `routes/notifications.ts`     |
| `approvals`        | ApprovalRequest        | `routes/approvals.ts`         |
| `portal`           | Portal façade          | `routes/portal.ts`             |
| `dev`              | Dev utilities (seed)   | `routes/dev.ts`               |

### Test-flow (B-flow) — parallel endpoints

| Route                       | File                              |
| --------------------------- | --------------------------------- |
| `test/production-orders`    | `routes/production-orders-test.ts`|
| `test/fg-units`             | `routes/fg-units-test.ts`         |
| `test/delivery-orders`      | `routes/delivery-orders-test.ts`  |

These mirror the A-flow endpoints but implement the sticker-identity flow
(see `docs/B-FLOW.md`). They share no in-memory state with the A endpoints
so the test flow cannot corrupt real data.

---

## Request/response examples

### Create a sales order

```http
POST /api/sales-orders
Content-Type: application/json

{
  "customerId": "cust_001",
  "items": [
    {
      "productCode": "BF-HERMIT-4BD",
      "seatHeight": "12\"",
      "fabricCode": "B.M-FABR-001",
      "quantity": 2
    }
  ]
}
```

Response:

```json
{
  "success": true,
  "data": {
    "id": "so_1234567890",
    "soNo": "SO-2026-0142",
    "customerId": "cust_001",
    "status": "DRAFT",
    "items": [
      {
        "id": "soi_1234567891",
        "productCode": "BF-HERMIT-4BD",
        "basePriceSen": 249900,
        "unitPriceSen": 249900,
        "totalSen": 499800,
        "quantity": 2,
        "seatHeight": "12\"",
        "fabricCode": "B.M-FABR-001"
      }
    ],
    "subtotalSen": 499800,
    "totalSen": 499800,
    "createdAt": "2026-04-20T03:14:15.926Z"
  }
}
```

### List invoices

```http
GET /api/invoices
```

```json
{
  "success": true,
  "data": [ /* Invoice[] */ ],
  "total": 87
}
```

### Read by ID (not found)

```http
GET /api/customers/cust_does_not_exist
```

```json
{ "success": false, "error": "Customer not found" }
```

Status: `404`.

### Create invoice from delivery order

Business rule: only `DELIVERED` DOs can be invoiced.

```http
POST /api/invoices
Content-Type: application/json

{ "deliveryOrderId": "do_1234" }
```

If the DO is not in `DELIVERED` status:

```json
{
  "success": false,
  "error": "Cannot create invoice: Delivery Order is \"IN_TRANSIT\". Only DELIVERED delivery orders can be invoiced."
}
```

---

## Domain-specific business rules

These are enforced at the route layer, not at the type layer.

- **SO confirm** — `status: DRAFT → CONFIRMED` auto-generates production
  orders (`production-order-builder.ts` explodes each SO item into one PO
  per department).
- **Invoice create** — requires DO in `DELIVERED`; derives line items from
  the DO (not the SO) so partial deliveries invoice correctly.
- **Payment allocate** — a single payment can settle multiple invoices;
  over-allocation returns 400.
- **GRN receive** — partial receipts allowed; 3-way match updates
  automatically when GRN quantity matches PO and supplier invoice.
- **Three-way match** — FULL_MATCH / PARTIAL_MATCH / MISMATCH; Mismatch
  blocks payment approval.
- **MRP netting** — shortfall = demand − on-hand − open PO qty (with
  lead-time alignment).
- **Cash flow classification** — Operating / Investing / Financing per
  journal line, aggregated per month.

---

## Error handling

- Validation errors → `400` with a human-readable `error` string. No
  shared error schema (yet); error messages are intended for UI display.
- Route handlers wrap `await c.req.json()` in try/catch for invalid JSON.
- 404s are explicit; "search returned no results" is a successful empty
  list (`data: []`, `total: 0`).

---

## Adding a new resource

1. Create `src/api/routes/<resource>.ts`:

   ```ts
   import { Hono } from 'hono';
   import { <collection>, generateId } from '../../lib/mock-data';

   const app = new Hono();

   app.get('/', (c) => c.json({ success: true, data: <collection> }));
   app.get('/:id', (c) => {
     const item = <collection>.find((x) => x.id === c.req.param('id'));
     return item
       ? c.json({ success: true, data: item })
       : c.json({ success: false, error: 'Not found' }, 404);
   });
   app.post('/', async (c) => {
     const body = await c.req.json();
     const item = { id: generateId(), ...body };
     <collection>.push(item);
     return c.json({ success: true, data: item }, 201);
   });

   export default app;
   ```

2. Import + mount in `src/api/index.ts`:

   ```ts
   import resource from './routes/resource';
   app.route('/api/resource', resource);
   ```

3. Add the entity shape to `src/lib/mock-data.ts` + a seed array.

4. Restart `npm run api`.

---

## Validation

Shared Zod schemas in `src/lib/validation.ts`. Not every route uses them
yet — many routes do ad-hoc checks. When tightening a route, prefer:

```ts
import { salesOrderCreateSchema } from '../../lib/validation';

app.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = salesOrderCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  }
  // ... use parsed.data
});
```

---

## Auth

None today. Every route trusts the caller. When auth is wired:

1. Add Hono middleware that verifies the session / token and populates
   `c.var.user`.
2. Apply it globally in `src/api/index.ts` before `app.route(...)` calls,
   except for `/health` and the portal-login route.
3. On the frontend, swap the bare `fetch` calls for a thin wrapper that
   attaches the `Authorization` header.
