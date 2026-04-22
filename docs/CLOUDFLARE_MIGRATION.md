# Cloudflare Migration Plan

Tracking doc for the hookka-erp-vite → Cloudflare Pages + D1 migration.
Source GitHub: `github.com/hello-houzs/hookka-erp @ vite-migration`
Target GitHub: `github.com/weisiang329-eng/hookka-erp-testing @ main`

## Cloudflare resources

- **Account**: weisiang329@gmail.com (`27cd35c9d93a9f81daa809d0b800b059`)
- **D1 database**: `hookka-erp-db` (`f17f29b5-b511-4824-a476-34767e5d9001`)
- **Pages project**: `hookka-erp-testing` (created on first deploy)

## Architecture

```
Browser
  │
  ▼
Cloudflare Pages (static dist/)  ← Vite SPA
  │
  │  /api/*  (Pages Functions catch-all)
  ▼
functions/api/[[route]].ts
  │
  ▼
src/api/worker.ts  (Hono app)
  │
  ▼
D1 (SQLite) bound as `c.env.DB`
```

## Phase checklist

- [x] **0. Scaffolding** — wrangler.toml, functions/, worker.ts, dev deps
- [ ] **1. Schema + seed** — 0001_init.sql, generate-seed-sql.ts (subagent)
- [ ] **2. Core routes** — customers, products, bom, workers, departments, customer-hubs, organisations
- [ ] **3. Sales flow** — sales-orders, purchase-orders, delivery-orders, invoices, payments, credit-notes, debit-notes, e-invoices
- [ ] **4. Production flow** — production-orders, job cards, piece pics, fg-units, inventory (+ batches), cost-ledger, grn, fabric-tracking
- [ ] **5. Supporting routes** — accounting, approvals, attendance, leaves, payroll, payslips, qc-inspections, rd-projects, maintenance-logs, equipment, consignments, consignment-notes, forecasts, mrp, scheduling, portal, worker-auth, warehouse, stock-accounts, stock-value, suppliers, supplier-materials, supplier-scorecards, notifications, goods-in-transit, historical-sales, price-history, production-leadtimes, promise-date, product-configs, three-way-match, lorries, drivers, fabrics, fg-units, dev
- [ ] **6. Deploy** — connect GitHub to Pages, first production deploy, E2E validation

## Route inventory (58 files)

Legend: ⭐ hot path (user-facing) · 🔧 admin/config · 📊 reporting · 🧪 dev tool

### Masters (Phase 2)
- ⭐ customers.ts
- ⭐ products.ts
- ⭐ bom.ts
- 🔧 workers.ts
- 🔧 worker-auth.ts
- 🔧 departments.ts
- 🔧 customer-hubs.ts
- 🔧 organisations.ts
- 🔧 product-configs.ts

### Sales (Phase 3)
- ⭐ sales-orders.ts
- ⭐ purchase-orders.ts
- ⭐ delivery-orders.ts
- ⭐ invoices.ts
- ⭐ payments.ts
- credit-notes.ts
- debit-notes.ts
- e-invoices.ts
- three-way-match.ts

### Production & Inventory (Phase 4)
- ⭐ production-orders.ts
- ⭐ inventory.ts
- ⭐ grn.ts
- ⭐ cost-ledger.ts
- fg-units.ts
- fabric-tracking.ts
- fabrics.ts
- warehouse.ts
- stock-accounts.ts
- stock-value.ts
- goods-in-transit.ts
- suppliers.ts
- supplier-materials.ts
- supplier-scorecards.ts
- price-history.ts

### Supporting (Phase 5)
- 📊 accounting.ts
- 📊 cash-flow.ts
- 🔧 approvals.ts
- 🔧 attendance.ts
- 🔧 leaves.ts
- 🔧 payroll.ts
- 🔧 payslips.ts
- qc-inspections.ts
- rd-projects.ts
- maintenance-logs.ts
- equipment.ts
- consignments.ts
- consignment-notes.ts
- 📊 forecasts.ts
- mrp.ts
- scheduling.ts
- 🔧 portal.ts
- historical-sales.ts
- production-leadtimes.ts
- promise-date.ts
- notifications.ts
- lorries.ts
- drivers.ts
- 🧪 dev.ts

## Migration pattern per route

Each route file follows the same transform:

**Before** (in-memory):
```ts
import { customers } from "@/lib/mock-data";
const app = new Hono();
app.get("/", (c) => c.json({ success: true, data: customers }));
app.post("/", async (c) => {
  const body = await c.req.json();
  const newCust = { id: `cust-${Date.now()}`, ...body };
  customers.push(newCust);
  return c.json({ success: true, data: newCust });
});
```

**After** (D1):
```ts
import { Hono } from "hono";
import type { Env } from "../worker";
const app = new Hono<Env>();
app.get("/", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM customer").all();
  return c.json({ success: true, data: results });
});
app.post("/", async (c) => {
  const body = await c.req.json();
  const id = `cust-${crypto.randomUUID().slice(0,8)}`;
  await c.env.DB.prepare(
    "INSERT INTO customer (id, code, name, ...) VALUES (?, ?, ?, ...)"
  ).bind(id, body.code, body.name, ...).run();
  return c.json({ success: true, data: { id, ...body } });
});
```

### Conventions

- Put D1-backed routes under `src/api/routes-d1/` — leaves the old in-memory routes alone until we flip the switch
- All SQL is parameterized with `.bind(...)` (never string-concat)
- ID generation: `crypto.randomUUID().slice(0, 8)` — matches existing `cust-1`-style prefixes
- Timestamps: `new Date().toISOString()` for `created_at`/`updated_at`
- Errors → `c.json({ success: false, error: "..." }, 400)` (mirror existing format)
- Transactions for multi-table writes: use `c.env.DB.batch([...])` (D1 supports it)

## Deploy (Phase 6)

1. Verify all migrated routes work locally with `wrangler pages dev`
2. `wrangler d1 migrations apply hookka-erp-db --remote` (applies schema to prod D1)
3. Seed prod once: `wrangler d1 execute hookka-erp-db --remote --file=./migrations/seed.sql`
4. Connect GitHub repo to Cloudflare Pages dashboard → auto-deploy on push to main
5. First deploy → validate all routes on `https://hookka-erp-testing.pages.dev`
6. (Optional) add custom domain
