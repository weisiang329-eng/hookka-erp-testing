# Phase C — Enterprise Upgrade Arc (6-Month Roadmap)

**Status:** Draft, written 2026-04-25
**Prerequisites:** Phase A complete (TypeScript clean, RBAC matrix live, audit log writing on every mutation), Phase B complete (Workers SDK split, CI strict-build gate, OAuth-ready auth, Supabase Storage attachment store [was R2 pre-storage-supabase-migration], canary deploy pipeline)
**Owner:** TBD (recommend a dedicated tech lead, ~0.5 FTE for the full 6 months)

---

## Why Phase C exists

Phase A and B make the system *correct and shippable*. Phase C makes it *defensible at enterprise scale* — second tenant, audit-grade ledger, queue-driven workflows, deduped masters, sub-second dashboards even at 5x the data, SSO/SCIM, and a real DR drill. Each milestone here is the gate that lets Hookka sell to a customer who has a procurement checklist instead of a friend-of-the-founder relationship.

Total estimated effort: **~36 engineer-weeks** spread over 6 calendar months, assuming 1.5 engineers active. The plan is built so each milestone can ship a 1-2 week quick-win first to start delivering value before the full milestone lands.

---

## 1. Multi-tenant boundaries

### What

Every table that holds tenant-owned data gets an `org_id` column. Every query goes through middleware that injects `WHERE org_id = ?` from the JWT. Every UI route reads the active `org_id` from the session and never lets a user see a row from another tenant. Cross-tenant joins are a runtime error, not a possibility.

### Acceptance criteria

- Two tenants seeded into the same Cloudflare D1 / Postgres database (e.g., `org_id=hookka` and `org_id=demo-buyer`) cannot see each other's:
  - SOs, POs, DOs, invoices
  - Customer hubs, supplier records
  - Inventory ledgers, BOM templates, production scans
  - Audit log entries
  - User accounts (a user belongs to exactly one org unless explicitly granted multi-org admin)
- An automated test suite spins up two orgs, creates 10 records in each, and asserts that `GET /api/sales-orders` from org A's JWT returns exactly 10 rows — none of org B's leak through.
- Tables to add `org_id` to (concrete list):
  - `customers`, `customer_addresses`, `suppliers`
  - `sales_orders`, `sales_order_items`, `sales_order_variants`
  - `purchase_orders`, `purchase_order_items`
  - `delivery_orders`, `delivery_order_items`
  - `invoices`, `payments`, `credit_notes`
  - `bom_templates`, `bom_template_items`
  - `inventory_movements`, `inventory_balances`
  - `production_jobs`, `production_scans`, `wip_items`
  - `audit_log`, `notifications`
  - `users` (already nullable for global admins; enforce on application users)

### Why this matters in $

A second paying tenant is the difference between SaaS and a custom one-off. At $2k MRR per tenant, every additional tenant is ~$24k ARR. Without `org_id` you cannot sign one. A leaked row across tenants is also a GDPR / PDPA reportable breach — fines start at 4% of revenue.

### Cost

**5 engineer-weeks.** ~3 weeks on schema migration + middleware + query helpers, ~1.5 weeks on tests, ~0.5 weeks on UI tenant switcher.

### Dependencies

- Phase A audit log must already be running (so the migration is itself audited).
- Phase B JWT must carry `org_id` claim (one-line addition during this milestone if not).

### Quick-win subset (1-2 weeks)

Add `org_id` to the **5 highest-leak tables** only: `sales_orders`, `customers`, `invoices`, `inventory_balances`, `audit_log`. Hard-code `org_id='hookka'` everywhere else for now. Ship the middleware. This proves the pattern and stops the most damaging leaks while the long tail of tables gets done in batches.

---

## 2. Immutable accounting ledger

### What

Replace the editable `invoices` / `payments` model with an append-only journal. Every posted entry gets a SHA-256 hash chain (`prev_hash || canonical_json => hash`). A `posting_status` column moves draft → posted → reversed. `posted` and `reversed` rows are read-only at the database level (a trigger raises if anyone tries `UPDATE` or `DELETE`). Reversals are themselves new entries that point back at the original via `reverses_entry_id`.

### Acceptance criteria

- A `journal_entries` table exists with columns: `id`, `org_id`, `entry_date`, `account_id`, `debit`, `credit`, `currency`, `posting_status`, `prev_hash`, `hash`, `reverses_entry_id`, `posted_by`, `posted_at`.
- Posted entries are immutable: the trigger blocks `UPDATE` / `DELETE` and raises a structured error.
- A "tamper detection" job runs nightly, recomputes the hash chain end-to-end, and alerts if any link breaks.
- An invoice cannot be edited after it has a posted journal entry. The only way to "fix" a posted invoice is to issue a credit note, which itself posts a reversing journal entry.
- A test creates an invoice, posts it, attempts to edit it (fails with 409), issues a CN that posts a reversal, and verifies the chain hash still validates.

### Why this matters in $

This is the single biggest blocker to passing an external audit (Big-4 or local SSM-equivalent). For a glove factory hoping to list on Bursa or get a HSBC trade-finance line, "our books are immutable and tamper-evident" is table stakes. Without it, an auditor will issue a qualified opinion, which kills the financing conversation. Cost of a qualified audit: at least $50k of refit work plus a delayed financing round.

### Cost

**6 engineer-weeks.** ~2 weeks schema + trigger + hash chain, ~2 weeks rewriting invoice/payment endpoints to post journal entries, ~1 week tamper-check job, ~1 week tests + admin UI for browsing the ledger.

### Dependencies

- Multi-tenant boundaries (#1) — `journal_entries.org_id` must scope correctly.
- Phase A audit log — the `posted_by` / `posted_at` foreign keys point at the same audit subject table.

### Quick-win subset (1-2 weeks)

Ship the `journal_entries` table and the hash chain, and have invoice posting *also* write a journal entry (dual-write). Don't yet flip the trigger to immutable; just start collecting the chain. Once 30 days of clean chain data exists, flip the trigger.

---

## 3. Event-driven workflows

### What

Replace the current synchronous "SO confirm clicks 6 endpoints in a row" flow with a Cloudflare Queues + Workflows pipeline. Each step is a queue consumer:

```
SO confirm  ->  PO emission  ->  JC scaffolding  ->  DO release  ->  Invoice post  ->  Payment chase
```

Each step is idempotent (keyed by `(workflow_run_id, step_name)`). Retries are independent. A step that needs human input (PO approval) parks the workflow until a webhook resumes it.

### Acceptance criteria

- A failed PO emission (supplier email bounces) does not roll back the SO confirm — it retries on its own schedule, and the SO stays confirmed.
- A workflow_run table tracks the state of every in-flight cascade. A dashboard lists "stuck" runs (>1 hour in the same step) so ops can intervene.
- A killed worker mid-step does not double-emit. Idempotency keys prevent duplicate POs even if Queues redeliver.
- An end-to-end test: confirm an SO, kill the JC-scaffolding worker, restart it, verify the workflow continues from JC-scaffolding (not from SO confirm) and ends in invoice-posted state.

### Why this matters in $

Today, a transient SMTP failure during PO emission leaves the SO in "half-confirmed" purgatory and ops has to manually unstick it. At ~5 SOs/day with a ~2% failure rate, that's ~30 manual recoveries per quarter, ~2 hours each. ~$3k/quarter in ops time. More importantly, customers see delayed POs and lose confidence — the dollar impact of "Hookka is unreliable" is much larger than the ops cost.

### Cost

**7 engineer-weeks.** ~2 weeks setting up Queues + Workflows on Cloudflare, ~3 weeks rewriting the cascade as queue consumers, ~1 week building the workflow_run dashboard, ~1 week chaos-testing the retry semantics.

### Dependencies

- Phase B SDK split (so Worker code can be deployed independently of the React app).
- Multi-tenant boundaries (#1) — every queue message carries `org_id` so consumers don't cross tenants.

### Quick-win subset (1-2 weeks)

Migrate just the **PO emission** step to a queue. SO confirm still runs synchronously, but it pushes one message instead of awaiting SMTP. This kills the most common failure mode (~70% of stuck cascades) before tackling the full workflow.

---

## 4. MDM (Master Data Management)

### What

Single golden record per Customer / Supplier / Product. A merge engine that detects duplicates by (SSM no, normalized name, phone), computes a confidence score, and either auto-merges (>0.95) or flags for human review. A change-tracking layer that says "this customer's address changed on 2026-04-20, here's the diff, here's who approved it."

### Acceptance criteria

- Two customer rows for the same SSM number get auto-merged within 15 minutes of the second row being created. The merge writes a `master_data_merges` audit row with the source row IDs, the chosen golden values, and the confidence score.
- After merge, every FK that pointed at the duplicate row (SOs, invoices, etc.) is repointed at the golden record. No orphans.
- A human-review queue surfaces near-duplicates (0.7-0.95 confidence) with a side-by-side diff and a one-click "merge" / "keep separate" action.
- A customer's address change is a versioned write — `customer_addresses_history` keeps the prior values and the user who changed them. A query "what was customer X's address on 2026-01-15" returns the right answer.

### Why this matters in $

Duplicate customers cause double-shipped DOs (a real incident in Q1 2026 — DO-3217 went to the wrong hub because two records existed for "Mr Lim"). Each duplicate-shipment incident costs ~$200 in reverse logistics plus reputational damage. At ~3-5 duplicate customers per quarter, that's $2-3k direct + unbounded indirect. Equally important: clean masters unlock useful BI ("top 10 customers by revenue") that today is misleading because the same customer is split across 3 rows.

### Cost

**5 engineer-weeks.** ~2 weeks dedupe engine + scoring, ~1 week merge transaction + FK repoint, ~1 week human-review UI, ~1 week change-tracking history tables.

### Dependencies

- Multi-tenant boundaries (#1) — merges are scoped per `org_id`.
- Immutable ledger (#2) — merging a customer doesn't retroactively change posted invoices; the merge writes its own audit trail and the invoices keep pointing at the golden ID.

### Quick-win subset (1-2 weeks)

Ship the **detection** half only — a nightly job that flags suspected duplicates into a review queue. No automatic merging yet. Ops can manually merge through the existing UI. This catches the bleeding while the full merge transaction is built carefully.

---

## 5. Read replica + BI marts

### What

Move dashboard reads off the primary database. Add a read replica (Supabase has this as a one-click feature; for D1 we use `--read-replication`). Add a `kpi_marts` schema with materialized views that pre-aggregate the slow queries (revenue-by-month, GP-by-product, AR-aging-by-customer). A nightly job refreshes the marts. Dashboard queries hit the marts, not the source tables.

### Acceptance criteria

- Dashboard p95 latency < 300ms even when the data set is 5x today's size (synthetic data: ~50k SOs, ~250k invoice lines, ~1M inventory movements).
- A long-running BI query (e.g. "GP by SKU for the past 24 months") cannot block a transactional write on the primary. Verify with a load test: 50 concurrent BI queries + 100 concurrent SO inserts, no insert latency degradation.
- Materialized views refresh nightly at 02:00 local. A failure to refresh raises an alert.
- The dashboard UI clearly indicates "data as of <last refresh>" so users don't think they're looking at real-time numbers when they aren't.

### Why this matters in $

Dashboards are slow today (some KPI tiles take 4-7 seconds at current data size; this gets exponentially worse). A slow dashboard means execs don't use it, which means decisions get made on intuition, which means the ERP doesn't pay for itself. Concretely: Hookka pricing decisions for 2026 H2 will be informed by the dashboard's "GP by destination market" tile. If that tile takes 30s to load (projected at 5x data), it will not be used, and pricing will be intuition-driven again.

### Cost

**5 engineer-weeks.** ~1 week read replica setup, ~2 weeks defining and building marts, ~1 week refresh job + monitoring, ~1 week migrating dashboard queries off the primary.

### Dependencies

- Multi-tenant boundaries (#1) — marts are pre-aggregated per `org_id` so cross-tenant leaks remain impossible.
- Immutable ledger (#2) — financial KPI marts read from the journal, not from invoices, for audit-clean numbers.

### Quick-win subset (1-2 weeks)

Build **just one materialized view**: `mv_revenue_by_month_by_org`. Point the homepage's revenue chart at it. This is the single most-loaded query and will buy headroom while the rest of the marts catch up.

---

## 6. Enterprise auth

### What

OAuth login via Google Workspace and Microsoft 365 for company SSO. TOTP 2FA enforced on all admin roles. SCIM 2.0 endpoints so the customer's IdP (Okta / Azure AD) can provision and deprovision users automatically. Session-per-device with a "sign me out everywhere" button and a "current sessions" list.

### Acceptance criteria

- A user offboarded in Okta loses access to Hookka ERP within 5 minutes via the SCIM webhook (or immediately via manual revoke).
- A login attempt with a correct password but missing 2FA token is rejected for any role marked `requires_2fa`.
- A user can see all their active sessions ("Chrome on MacBook, last seen 5 min ago") and revoke any of them. Revocation invalidates the JWT within one cache cycle (≤60s).
- An OAuth login from an unrecognized device sends an email alert to the user.
- SCIM endpoints pass the standard SCIM 2.0 conformance test suite (User CRUD + Group CRUD + Patch).

### Why this matters in $

Every enterprise customer's procurement checklist asks "do you support SSO and SCIM?". Today the answer is "no" and that ends the conversation. Conservative estimate: 1 enterprise deal blocked per year that's worth ~$50k ARR. Add the 2FA requirement for SOC2 Type II eligibility and the multiplier grows. Also a hard requirement for the Bursa-listed parent of any of our prospect customers.

### Cost

**5 engineer-weeks.** ~1.5 weeks OAuth + 2FA, ~2 weeks SCIM endpoints + IdP testing, ~1 week session-per-device + revoke, ~0.5 weeks security review.

### Dependencies

- Phase B Auth (must already have JWT-based sessions and a "real" user model, not just hard-coded admin).
- Multi-tenant boundaries (#1) — SCIM provisions users into a specific `org_id`.

### Quick-win subset (1-2 weeks)

Ship **Google Workspace OAuth only**, no SCIM yet, no Microsoft yet. Hookka's own team (and the most likely first enterprise prospect, based on Q1 2026 conversations) is on Google Workspace. This unblocks ~80% of the value while the long-tail providers wait.

---

## 7. Disaster recovery

### What

Documented and *drilled* recovery process. Daily automated logical backup (`pg_dump` for Supabase) to an off-vendor object store with 90-day retention. (Originally specced as Cloudflare R2; the storage-supabase-migration moved daily dumps to Supabase Storage, with the same-vendor-as-Postgres caveat called out in `docs/DR-RUNBOOK.md` plus a GitHub Actions artifact retained for 90 days as the off-vendor floor.) A runbook that walks through restoring to a fresh project. A quarterly drill where someone *actually does* the restore on a Friday afternoon and times it.

### Acceptance criteria

- **RPO ≤ 1 hour:** continuous WAL shipping to off-account storage. The most data we can lose in a catastrophe is 1 hour of writes.
- **RTO ≤ 4 hours:** from "primary is gone" to "dashboard serving traffic on restored stack" must take less than 4 hours. Verified by drill.
- A `pg_dump` from yesterday's backup, when restored to a fresh Supabase project, lets the dashboard render without errors. Verified by *running the drill*, not just by reading the runbook.
- Backup integrity checked nightly (gzip CRC + restore-to-scratch + sample-row-count check). Failure raises a P1 alert.
- Quarterly drill report filed with timing, gaps found, and fixes scheduled.

### Why this matters in $

A primary-region Cloudflare incident (rare but real — Jun 2025 outage) without DR = days of downtime = customers churn and prospects walk away. One catastrophic data loss event would be company-ending. The drill is what separates "we have a backup" (untested) from "we have DR" (tested). Cost of one catastrophic event: probably the company. Cost of one quarter of "DR theater" customer-trust loss: ~$100k of stalled deals.

### Cost

**3 engineer-weeks** + 1 day per quarter ongoing for drills. ~1 week WAL shipping + Storage sink, ~1 week runbook + restore tooling, ~1 week first drill + lessons-learned cleanup.

### Dependencies

- Immutable ledger (#2) — the hash chain is the integrity check on the restored ledger; if hashes validate post-restore, we know nothing was silently corrupted.
- Multi-tenant boundaries (#1) — restore is per-org if we ever need to surgically restore one tenant.

### Quick-win subset (1-2 weeks)

Ship **daily logical backups to Supabase Storage** (was R2 in the
original Phase C draft; updated by storage-supabase-migration) with
90-day retention. No drill yet. This stops the bleeding (today there
is no off-vendor backup at all). The drill follows once the rest of
Phase C settles.

---

## 6-month dependency-ordered sequence

The order below respects the dependency graph (each item only starts after its blockers are at least at quick-win stage). Single-track sequence, assuming 1.5 engineers active.

| Month | Weeks | Milestone | What ships |
|-------|-------|-----------|------------|
| **M1** | W1-W2 | #1 quick-win | `org_id` on the 5 leak-critical tables + middleware |
| | W3-W4 | #1 finish | `org_id` everywhere, two-tenant isolation test green |
| **M2** | W5-W6 | #2 quick-win | Dual-write to `journal_entries` (chain collecting, not yet enforced) |
| | W7-W8 | #2 part 2 | Reversal model + tamper-check job |
| **M3** | W9 | #2 finish | Flip immutability trigger; ledger is read-only |
| | W10-W11 | #7 quick-win | Daily `pg_dump` to off-vendor object store (Supabase Storage post-migration), 90-day retention |
| | W12 | #4 quick-win | Duplicate-detection nightly job + review queue |
| **M4** | W13-W14 | #3 quick-win | PO emission moved to Cloudflare Queue (kills ~70% of stuck cascades) |
| | W15-W17 | #3 finish | Full SO->payment cascade as Workflows; idempotency + retry |
| **M5** | W18-W19 | #5 quick-win | First mart (`mv_revenue_by_month_by_org`) live; homepage chart hits it |
| | W20-W21 | #5 finish | Read replica wired, all dashboard queries on marts, p95 < 300ms verified at 5x |
| | W22 | #4 finish | Auto-merge engine live, golden-record FK repoint working |
| **M6** | W23-W24 | #6 quick-win | Google Workspace OAuth + 2FA on admin roles |
| | W25 | #6 finish | SCIM endpoints + Microsoft 365 + session-per-device |
| | W26 | #7 finish | First quarterly DR drill executed end-to-end; runbook hardened |

**Total: 26 weeks (6 months) at 1.5 FTE = ~36 engineer-weeks of work.** Matches the per-milestone estimates above (5+6+7+5+5+5+3 = 36).

### What slips first if we run hot

In rough order of "least painful to defer":

1. #4 finish (auto-merge) — the quick-win detection queue is 80% of the value; full auto-merge can slip to Phase D.
2. #6 SCIM — Google OAuth + 2FA covers the realistic 6-month sales pipeline; SCIM only matters once we sign a customer that demands it.
3. #5 finish — one mart for the homepage chart will buy enough time at current data growth that the full mart layer can wait if pressed.

### What MUST NOT slip

1. #1 multi-tenant boundaries — without this, no second customer ships, period.
2. #2 immutable ledger — without this, no audit-eligible accounting, no financing conversation.
3. #7 quick-win backup — without this, one bad night ends the company.

---

## Out of scope for Phase C (queued for Phase D)

- International tax / multi-currency consolidation (Phase D)
- Mobile-native warehouse scanner app (Phase D)
- ML-based demand forecasting on the BI marts (Phase D — needs Phase C #5 to land first)
- White-label tenant theming (Phase D — needs Phase C #1 to land first)
- Public REST API + API key management for tenant integrations (Phase D)

---

*Last updated 2026-04-25. Revisit at the end of each milestone — quick-wins that ship may collapse the timeline; surprises in #2 (the ledger work is the most architecturally invasive) may extend it.*
