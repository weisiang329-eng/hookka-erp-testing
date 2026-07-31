# CRM redesign — unified Lead ↔ Customer (owner 2026-07-30)

## The ask (owner, in his words)
- Sales Pipeline should look/behave like a real SaaS pipeline (no raw enum codes on screen).
- Kanban cards must **drag** between columns (today only a dropdown moves stages).
- A lead (Case) must hold **full CRM info** — who I met, contact log, all the basics — so **any salesperson can take over** if someone quits. Nothing lives only in one person's head.
- On WON, the Case **moves into the Customer module**. Before it becomes a formal customer, these approval fields must be filled: **Credit Code, Customer Name, Delivery Hubs, PIC, PIC Contact, Terms, Credit Limit**. Then **one-click convert**.
- Pipeline ↔ Customer must be **deeply connected**: assign Category / Catalog / price / Sofa Combo, and carry SSM / e-Invoice ID — for **both** informal (lead) and formal (customer) records.
- Owner's proposed shape: **one record with status Confirmed / Unconfirmed**; a lead = an Unconfirmed customer. "Push the Customer module's underlying logic into the Pipeline."

## Architecture decision — "shared entity id", not one giant table

The owner's instinct (unify) is right. But literally putting **Unconfirmed customers into the `customers` table** is high-risk: `customers` feeds orders, credit limits, AR/aging, invoicing, statements — dozens of read sites. An unconfirmed lead leaking into any of those corrupts money/inventory reporting. Auditing every one in a single migration is where bugs hide.

**Chosen design (same UX, contained blast radius):**
- Leads keep living in `sales_leads` (the pipeline's own table). **A lead is the "Unconfirmed" state.**
- The **rich CRM data already lives in entity-keyed side tables** — `customer_contacts`, `customer_activities`, `customer_wishlist`, `customer_onboarding` all key on a free-text `customer_id`. These panels work **unchanged** if we pass them the **lead id** as the entity id. So a lead gets Contacts + Activity timeline + Wishlist + KYC with zero schema change → **takeover** solved.
- **Convert** = create a real `customers` row from the approval fields, then **re-point** the lead's side-table rows (`customer_id = lead_id → new customer_id`) and stamp `sales_leads.won_customer_id`. Nothing financial ever saw the unconfirmed record.
- Catalog / price / Sofa Combo assignment (`customer_products`, `sofa_combo_rules`) **stay customer-only** for now (they join to `customers` and feed quotations). Assigning those to a lead is deferred to a later slice with an explicit "provisional assignment" table, so we never join a lead id into the quotation/pricing SQL.

This gives the owner: leads with full CRM info + takeover today, one-click convert that carries everything over, and a clean `customers`/finance layer. The "Confirmed/Unconfirmed" label is real (lead vs customer); the *data* is unified by a shared entity id.

## Slices (each its own PR → staging)
1. **Pipeline usable + takeover** (this PR): drag-drop board; a **Lead detail** view that mounts the existing CRM panels (Contacts, Activity, Wishlist, KYC) keyed on the lead id; SaaS-style labels (no raw enum codes); phone/email input standardization on the lead + New Lead form.
2. **Convert to customer**: WON → a convert dialog collecting Credit Code, Name, Delivery Hubs, PIC, PIC Contact, Terms, Credit Limit → creates the customer, re-points CRM side-tables, links `won_customer_id`, shows the new customer.
3. **Deep assignment**: provisional Category/Catalog/price/Sofa Combo on a lead (separate provisional table), merged into the customer on convert.
4. **System-wide standardization (乙)**: shared Phone input (+60 default, country pick, intl) + email-format validation + State/Postcode dropdowns, applied across Customers, Leads, Suppliers, Delivery Hubs.

## Non-negotiables carried in
- New columns snake_case; tables runtime self-applied (migrations inert on deploy).
- RBAC-gate every route on `customers`; tenant-scope by `org_id`.
- No unconfirmed record in any orders/credit/AR/invoice read path.
- Structural test per slice; build:strict + full suite green before each PR.
