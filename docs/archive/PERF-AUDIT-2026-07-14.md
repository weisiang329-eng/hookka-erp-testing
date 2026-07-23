# Full-app read-performance audit — 2026-07-14

13 module auditors (one per NAVIGATION-MAP module) × FE/BE/DB layers → 83 findings →
synthesized + ranked. Read-only audit. Companion to `docs/PERF-DURABLE-ARCHITECTURE.md`.
**VERIFY-BEFORE-FIX every item** (re-read the file:line — audit findings drift; e.g. the
Sales #2 claim conflicts with a slim already shipped this session — check which fetch).

## Headline
Read paths are broadly healthy where the two house patterns were applied
(snapshot/serve-stale on heavy BE; minimal projection + client SWR on lists) — but
applied UNEVENLY. Surfaced: **1 real correctness bug** (AR Aging money over the loaded
page = dead-data class), a cluster of ~11 heavy endpoints that cold-recompute because a
sibling got the snapshot and they didn't, wasted whole-list fetches (12MB SO payload,
discarded audit-log/PO fetches), O(N×M) in-memory joins (one-line Map fixes), and missing
indexes (purchase_invoices/_items have ZERO; sales_orders.caseid unindexed).

## ⚠️ #1 — REAL CORRECTNESS BUG (money + dead-data, HIGH risk)
**Invoices AR Aging tab buckets per-customer money totals over the client-loaded page
only** (200 default, ≤2000 filtered) — past page 1 the aging report silently undercounts.
`invoices/index.tsx:490-532`. Fix: whole-dataset server aggregate (new `/api/invoices/aging`
GROUP BY customer+bucket in SQL, or reuse `accounting.ts /aging` AR side) rendered like the
KPI cards already read `/invoices/stats`. **Never bucket money over the loaded page.**

## Ranked fix plan (impact / effort S·M·L / risk)
| # | Module | Layer | Fix | I | E | Risk |
|---|--------|-------|-----|---|---|------|
| 1 | Accounting/Invoices | FE | AR Aging → server aggregate (bug above) | H | M | high |
| 2 | Sales | FE | SO list → `?fields=minimal&include=` (12MB→) — VERIFY, may be done | H | S | low |
| 3 | Accounting | BE | `/pl` (P&L/BS/CF) → withSnapshot+serve-stale+warm | H | M | high |
| 4 | Accounting | BE | `cash-flow /` pulls 5 whole tables → snapshot + SQL-aggregate | H | M | high |
| 5 | Accounting | BE | `/journals` O(entries×lines) + unpaginated → Map + paginate | H | M | med |
| 6 | Dashboard | BE | current-month bypasses snapshot → extend snapshot to it + warm | H | M | med |
| 7 | Inventory | BE | `/inventory/wip` uncached + scans ALL completed history → snapshot + bound stub scan | H | M | med |
| 8 | Planning | BE | 8 dept-schedule pages cold-recompute full chain → snapshot(dept+date) | H | M | med |
| 9 | Products | BE | `/api/products` uncached + O(P×B) → snapshot+warm + Map bucket | H | M | med |
| 10 | Reports | BE | operations.json (W/M) 15 sections uncached → snapshot(period,anchor)+warm | H | M | med |
| 11 | Delivery | BE | DO list recomputes whole-org value/invoice map per page → snapshot | H | M | high |
| 12 | Consignment | BE | CN list value/customer-ref map uncached (twin of #11) → snapshot | H | M | high |
| 13 | Procurement | DB | purchase_invoices/_items ZERO indexes → add (pi_id hottest) | H | S | low |
| 14 | Service | DB | sales_orders.caseid unindexed (scanned every case load) → index | H | S | low |
| 15 | Procurement | BE | PO list uncached + O(POs×lines) SKU-recovery → snapshot | M | M | med |
| 16 | Sales+CN | FE | dead status-changes fetch (fetched+decoded+discarded) → delete both + retire routes | M | S | low |
| 17 | Procurement | FE | PO page loads all + client counts + eager /api/inventory → server aggregate + keyset | M | L | med |
| 18 | Accounting | BE | `/trial-balance` + `/gl` filter whole ledger in JS → push date to SQL / snapshot | M | M | high |
| 19 | Accounting | BE | `/payments` whole table + client KPI → keyset + /stats aggregate | M | M | med |
| 20 | Dashboard | BE | snapshot has NO warm cron (02:00 DELETE only) → warm every 1-2min | M | M | med |
| 21 | Production/BOM | BE | `/bom/templates` bypasses HD cache + cross-pulls full inventory → snapshot + slim RM picker | M | M | med |
| 22 | Service+Inv | FE | pull whole sibling lists (DO/PO/customers) for one derivation → server-side per-case fields + slim po-state endpoint (do NOT slim shared DO/CN list — mobile L2) | M | M | low |
| 23 | Cross-module | BE | O(N×M) Map fixes: customers×hubs, suppliers×materials, CO×items | M | S | low |
| 24 | Employees | BE | `/production-revenue` + `/daily-breakdown` uncached (siblings got PR7) → same snapshot | M | M | med |
| 25 | Dashboard | FE | 200-row DO fetch parsed+discarded as a loading gate → drop | L | S | low |
| 26 | Reports | FE | hub tabs pull whole module lists + client date-filter → server date params | M | M | med |

## DB indexes (runtime self-apply, `CREATE INDEX IF NOT EXISTS`, snake/camel per column-rename-map)
Highest: `purchase_invoice_items(pi_id)` (ZERO indexes today), `sales_orders(caseid)`,
`purchase_invoices(invoiceDate|status|supplierId)`. Full batch (38) below — composite
`(orgId, created_at DESC)` on every list table makes ORDER BY an index scan.
See the workflow result / this plan's source for the complete `CREATE INDEX` list:
purchase_invoice_items(pi_id); purchase_invoices(invoiceDate),(status),(supplierId);
sales_orders(caseid); purchase_orders(orgId,created_at); grns(grnNumber);
sales_orders(orgId,created_at); invoices(orgId,created_at); consignment_orders(created_at);
payment_records(orgId,date,id); supplier_payments(org_id,date,payment_no,id),(purchase_invoice_id);
delivery_orders(orgId,created_at); delivery_order_items(orgId); consignment_notes(orgId,noteNumber);
consignment_items(orgId); production_orders(productCode),(created_at),(companySOId),(companyCOId);
job_cards(orgId,departmentCode),(productionOrderId,departmentCode),(wipKey),(updated_at);
bom_components(materialCode); products(orgId,status,code); service_cases(created_at),(status);
service_orders(caseId); service_order_lines(serviceOrderId); service_order_returns(serviceOrderId);
rd_material_issuances(projectId); rd_labour_hours(projectId),(teamMemberId);
cost_ledger(created_at); sales_order_items(updated_at); invoice_items(updated_at);
working_hour_entries(created_at).
⚠️ VERIFY each column's real name via column-rename-map + that the index doesn't already exist.

## Quick wins (safe, high value, do first)
1. SO list slim (VERIFY not already done) — 12MB decode gone.
2. Delete dead status-changes fetch on SO + CN lists → retire the routes.
3. Drop discarded fetches: GRN full-PO-list (grn.tsx:373), dashboard 200-row DO gate (dashboard-b/index.tsx:723).
4. PI-items + PI + sales_orders(caseid) indexes (runtime self-apply).
5. Map-bucket the customers/suppliers/CO list builders (O(N×M)→O(N+M)).
6. `(orgId, created_at)` composite index batch → every list ORDER BY becomes an index scan.

## Proposed execution waves
- **Wave A (safe, do first):** DB index batch + quick-win dead-fetch deletions + O(N×M) Map fixes. Pure additive / removal, byte-identical, low risk.
- **Wave B (the money bug):** #1 AR Aging server aggregate — VERIFY the bug live (search beyond page 1 undercounts), then fix + verify byte-identical to a full-dataset sum.
- **Wave C (snapshot cluster):** #3-#12 + #15,#20,#21,#24 — one endpoint per commit, each withSnapshot+serve-stale+warm, byte-identical money verify. High-risk ones (money reports) staged carefully.
- **Wave D (bigger):** #17,#19,#26 keyset/pagination + server aggregates.
Every item: VERIFY-BEFORE-FIX at file:line, byte-identical, no dead-data, bump cache_key on shape change, staging → owner verify → prod.
