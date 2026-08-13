# Cloudflare Migration Plan — [HISTORICAL / SUPERSEDED]

> **Last verified: 2026-08-13** against `wrangler.toml`, `src/api/worker.ts:279-311`, `ls src/api/routes/*.ts` (136 files), and `package.json`.
> Corrected 2026-08-13: this doc plans a migration **to D1**, which was executed and then RETIRED on 2026-04-27 (commit `7059259`). Its target architecture, its `routes-d1/` convention, its 58-file route inventory, and its D1 deploy commands are all dead. Kept only because `wrangler.toml` cites it as the record of the Cloudflare account id. **Recommend moving to `docs/archive/`.**
>
> **What is actually true today** (read this, not the plan below):
> - Runtime: Cloudflare Pages SPA + Hono API as a Pages Function at `functions/api/[[route]].ts` → `src/api/worker.ts`. This part of the plan shipped.
> - Data: Supabase Postgres via the `HYPERDRIVE` binding. `c.var.DB` is a `SupabaseAdapter` (`src/api/lib/supabase-compat.ts`) presenting a D1-shaped `prepare/bind/all` API over Postgres. There is no `[[d1_databases]]` block in `wrangler.toml`.
> - Routes live in `src/api/routes/` (136 `.ts` files), **not** `src/api/routes-d1/` — that directory does not exist.
> - Migrations: `migrations-postgres/` (244 files, head `0223_trade_finance.sql`), applied with `npm run db:migrate:supabase`. The `migrations/` directory holds 131 dead SQLite files.
> - `wrangler d1 …` commands below will do nothing useful; the `db:migrate:*` D1 npm scripts survive only as `_LEGACY_*` echo stubs.

Tracking doc for the hookka-erp-vite → Cloudflare Pages + D1 migration.
Source GitHub: `github.com/hello-houzs/hookka-erp @ vite-migration`
Target GitHub: `github.com/weisiang329-eng/hookka-erp-testing @ main`

## Cloudflare resources

- **Account**: weisiang329@gmail.com (`27cd35c9d93a9f81daa809d0b800b059`)
  — still current; `wrangler.toml [vars] CF_ACCOUNT_ID` cites this doc as
  the source of record for it.
- **D1 database**: `hookka-erp-db` (`f17f29b5-b511-4824-a476-34767e5d9001`)
  — **unbound since 2026-04-27**; retained in Cloudflare for snapshot
  rollback only, zero live traffic.
- **Pages project**: `hookka-erp-testing`. Production is served at
  `https://erp.hookka.com`; `hookka-erp-testing.pages.dev` still resolves
  and is in the CORS allowlist.

## Architecture (as planned in April — see the banner for what shipped)

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
D1 (SQLite) bound as `c.env.DB`     ← RETIRED. Today: c.var.DB →
                                       SupabaseAdapter → Hyperdrive →
                                       Supabase Postgres.
```

## Phase checklist

- [x] **0. Scaffolding** — wrangler.toml, functions/, worker.ts, dev deps
- [ ] **1. Schema + seed** — 0001_init.sql, generate-seed-sql.ts (subagent)
- [ ] **2. Core routes** — customers, products, bom, workers, departments, customer-hubs, organisations
- [ ] **3. Sales flow** — sales-orders, purchase-orders, delivery-orders, invoices, payments, credit-notes, debit-notes, e-invoices
- [ ] **4. Production flow** — production-orders, job cards, piece pics, fg-units, inventory (+ batches), cost-ledger, grn, fabric-tracking
- [ ] **5. Supporting routes** — accounting, approvals, attendance, leaves, payroll, payslips, qc-inspections, rd-projects, maintenance-logs, equipment, consignments, consignment-notes, forecasts, mrp, scheduling, portal, worker-auth, warehouse, stock-accounts, stock-value, suppliers, supplier-materials, supplier-scorecards, notifications, goods-in-transit, historical-sales, price-history, production-leadtimes, promise-date, product-configs, three-way-match, lorries, drivers, fabrics, fg-units, dev
- [ ] **6. Deploy** — connect GitHub to Pages, first production deploy, E2E validation

## Route inventory (58 files — HISTORICAL; there are 136 today)

> This list froze in April 2026. `ls src/api/routes/*.ts` returns 136 files
> as of 2026-08-13. Do not use it to answer "what routes exist" — read the
> directory, or `docs/CODEBASE-MAP.md`.


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

### Conventions — DEAD, do not follow

> `src/api/routes-d1/` does not exist. `c.env.DB` does not exist.
> `DB.batch([...])` still works, but through the Postgres adapter, not D1.

- Put D1-backed routes under `src/api/routes-d1/` — leaves the old in-memory routes alone until we flip the switch
- All SQL is parameterized with `.bind(...)` (never string-concat)
- ID generation: `crypto.randomUUID().slice(0, 8)` — matches existing `cust-1`-style prefixes
- Timestamps: `new Date().toISOString()` for `created_at`/`updated_at`
- Errors → `c.json({ success: false, error: "..." }, 400)` (mirror existing format)
- Transactions for multi-table writes: use `c.env.DB.batch([...])` (D1 supports it)

## Deploy (Phase 6) — DONE; steps 2-3 are dead D1 commands

1. ~~Verify all migrated routes work locally with `wrangler pages dev`~~ →
   `npm run dev:worker`
2. ~~`wrangler d1 migrations apply hookka-erp-db --remote`~~ → schema now
   applies with `npm run db:migrate:supabase` (operator-run, manually —
   `.github/workflows/deploy.yml` deliberately does NOT auto-apply)
3. ~~`wrangler d1 execute … --file=./scripts/seed.sql`~~ → no such flow
4. Done — GitHub is connected; `.github/workflows/deploy.yml` deploys on
   push to `main`, `claude/**`, `staging`, and on PRs to `main`
5. Done
6. Done — custom domain `erp.hookka.com` cut over 2026-05-27
