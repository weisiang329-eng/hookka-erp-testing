# Plan — Customer: Potential vs Confirmed, and the Sales Pipeline split

**Owner ask:** 2026-08-01 (WhatsApp, 5 screenshots)
**Branch:** `feat/customer-potential-confirmed` off `staging`
**Status:** PLAN — not implemented. Three decisions below block the build.

---

## 1. What the owner asked for

> 这个 Customer 地方我要分成两个种类：(1) 已经是正确 confirm 的顾客 (2) 没有 confirm 的顾客
> ——也就是在 Sales Pipeline 里我已经添加并联系了他，把公司、联系人和资料都录入进来了，所以会
> create 出来。然后我就会在这个 customer 的界面去 assign 他这些 product category 等等，
> 要不然我不习惯。
>
> CRM 还有 wishlist，就不需要放在这个 customer 的 module 了，把这两个放进 Sales Pipeline 就可以了。
> Sales Pipeline 专门记录我跟顾客的整个 contact 和 activities，还有 wishlist（其实也不是
> wishlist，就是那些 activities 就可以了）。
>
> 先 create 一个 new customer,也就是 potential customer。接着在 customer 页面 assign SKU,
> 同时也可以 assign Master Maintenance,比如 set 个 sofa combo。再来可以直接 export
> quotation、email quotation、export catalog PDF。第五张照片这边要有 salesperson 的名字,
> 从 my members / user management 那边添加。

The load-bearing sentence is **"要不然我不习惯"** — the owner wants to do SKU assignment,
combo config and quotation/catalogue export on a customer **before the deal is closed**.
Everything else follows from that.

---

## 2. What already exists (do NOT rebuild)

This is most of the ask. Surveyed 2026-08-01:

| Owner's ask | Status | Where |
| --- | --- | --- |
| Pipeline records contacts + activities | **Already built** | Lead drawer mounts `CrmPanel` keyed on the **lead id** — `src/pages/leads/index.tsx:507` area |
| Pipeline has a wishlist | **Already built** | `WishlistPanel customerId={lead.id}` — same drawer |
| Assign SKU on a customer | **Already built** | `AssignSkuModal` `customers.tsx:3121`; `CustomerProductsPanel` `customers.tsx:194-1196` |
| Assign Master Maintenance / sofa combo | **Already built** | `CustomerMaintenancePanel` L1542, `CustomerSofaCombosPanel` L2306 |
| Export Quotation PDF / Email Quotation / Export Catalogue PDF | **Already built** | Customer Products panel header; `src/api/routes/customer-quotation.ts` |
| Lead → customer conversion, carrying contacts/activity/wishlist/KYC | **Already built** | `leads/index.tsx:517-610` — has an approval gate + account-opening form |

**So the genuinely new work is small:** a customer *type*, a salesperson field, moving the
creation point earlier, and deleting two panels from the customer page.

---

## 3. Changes

### 3.1 Customer type — `confirmed` vs `potential`

- New column `customers.customer_stage TEXT NOT NULL DEFAULT 'CONFIRMED'` (snake_case per
  CLAUDE.md; values `POTENTIAL` | `CONFIRMED`).
- **Every existing row defaults to CONFIRMED** — the 5 live customers are real accounts.
- Reaches prod ONLY via a runtime self-apply (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`,
  awaited at the top of the customers POST/PUT before the first write). A migration file
  alone is inert on deploy — see CLAUDE.md.
- Read dual-keyed (`r.customerStage ?? r.customer_stage`). The Supabase driver's
  `transform.column.from` returns camelCase; snake-only reads silently return `undefined`.
  This exact trap killed Component Kits on 2026-08-01 — do not repeat it.
- Customers list: a segmented filter **Confirmed | Potential | All**, defaulting to
  **Confirmed** so the existing view is unchanged on day one. The KPI tiles (Total
  Customers / Outstanding / Credit Limit) count the **filtered** set — a potential customer
  has no A/R and would otherwise distort "Total Outstanding".

### 3.2 Create the customer at lead-entry, not at conversion

Today: lead lives alone → "Convert" → customer is born.
Wanted: lead is entered → a `POTENTIAL` customer is born immediately → SKU/combo/quotation
work → deal closes → the same row flips to `CONFIRMED`.

**This collides with the existing convert flow, which is why decision D2 below must be
settled before any code is written.**

### 3.3 Salesperson on the customer

- New column `customers.salesperson_user_id TEXT NULL`, FK-by-convention to `users.id`.
- Picker sourced from user management (`users`), same list Settings → Users manages.
- Shown as a column in the customers grid (owner's screenshot 5) and on the edit dialog.
- Store the **user id**, render the name. Storing the name would rot on rename.

### 3.4 Remove CRM + Wishlist from the customer page

In `customers.tsx` (~L4038) the expanded customer renders:

```
<CrmPanel …/>          ← REMOVE (lives in the Pipeline drawer)
<WishlistPanel …/>     ← REMOVE (see decision D1)
<KycPanel …/>          ← keep (owner did not ask to move this)
<CustomerProductsPanel …/> <CustomerMaintenancePanel …/> <CustomerSofaCombosPanel …/>  ← keep
```

Removing the **mounts** only. The components stay in `src/components/customer/` because the
Pipeline drawer imports the same ones.

### 3.5 Pipeline stage labels

Already shipped separately — PR #153 (`Potential / Contacted / Quoted / Negotiating /
Confirmed / Dropped`, labels only, keys untouched). Vocabulary already matches this plan.

---

## 4. Decisions — ANSWERED by owner 2026-08-01

| # | Decision | Owner's answer |
| --- | --- | --- |
| D1 | Wishlist | **Retire the feature entirely** — "整个功能删掉，我们 assign SKU 就行了". Removed from BOTH the Customer page and the Pipeline drawer. *Recorded deviation:* the plan recommended keeping it in the Pipeline; the owner overrode that. **The `customer_wishlist` data is NOT dropped** — UI and write paths go, the table stays dormant. Deleting a panel is reversible; deleting rows is not, and the owner asked to remove a feature, not to wipe records. |
| D2 | Convert flow | **Convert becomes "Confirm"** — same approval gate and account-opening form, but it flips the existing row `POTENTIAL → CONFIRMED` instead of INSERTing. Credit limit / terms keep a human gate. |
| D3 | Creditor code | **Nullable while POTENTIAL, required at Confirm**, plus a hard server-side rule that a POTENTIAL customer can never be used on SO / Invoice / DO / accounting documents. |

### Original write-up (kept for the reasoning)

### D1 — What happens to Wishlist?

The owner said *"其实也不是 wishlist，就是那些 activities 就可以了"*. Two readings:

- **(a) Remove the panel from the Customer page only**, keep it in the Pipeline drawer.
  Zero data loss, fully reversible.
- **(b) Retire the feature entirely** — remove from both, stop writing
  `customer_wishlist` rows.

**Recommendation: (a).** (b) destroys data for a sentence that reads more like "the
Pipeline only needs activities" than "delete the wishlist feature". (b) is still available
later; un-deleting data is not.

### D2 — What happens to the existing "Convert" flow?

It currently carries an approval gate plus an account-opening form (creditor code, credit
terms, credit limit, SSM, address). If the customer row is born at lead entry, that gate
has to land somewhere.

- **(a) Convert becomes "Confirm customer"** — same form, same gate, but it *flips*
  `POTENTIAL → CONFIRMED` and fills in the account-opening fields instead of INSERTing a
  new row. The lead keeps pointing at the same customer id throughout.
- **(b) Drop the gate** — a lead entry creates a fully-fledged customer straight away.

**Recommendation: (a).** The gate is where credit limit and terms get set; a customer that
can be invoiced should not be created by a salesperson typing a name into the pipeline.
(a) also means the CRM/wishlist/KYC "move over" step disappears entirely — they were
already attached to the right row from the start, which removes a whole class of migration
bug.

### D3 — What creditor code does a POTENTIAL customer get?

`POST /api/customers` **requires** `code` + `name` and runs `validateDebtorCode`
(`customers.ts` POST). Live codes look like `300-2`, `300-C`, `300-H`. A lead has no code
yet, so one of:

- **(a) Nullable code while POTENTIAL** — relax the NOT-NULL/validation for
  `customer_stage = 'POTENTIAL'`, require it at the Confirm step. Needs care: every
  downstream join that assumes a code exists must be checked.
- **(b) Auto-provisional code** — e.g. `P-0001`, swapped for the real code at Confirm.
  Risk: a provisional code leaking onto a document or into accounting.
- **(c) Ask for the code up front** in the pipeline form.

**Recommendation: (a)**, with a hard rule that a POTENTIAL customer can never be selected
on a Sales Order, Invoice, DO or any accounting document. That rule is the real safety
boundary and must be enforced **server-side**, not just hidden in the UI.

---

## 5. Safety notes

- **A potential customer must be invisible to the money path.** SO / invoice / DO /
  accounting customer pickers filter to `CONFIRMED` only, and the server rejects a
  `POTENTIAL` customer id on those routes. This is the single most important guard in the
  whole change — get it wrong and unbillable accounts reach the ledger.
- `customers.tsx` is 3,846 lines. Follow the "touching a monster file" playbook: edit by
  section banner, do not reformat.
- Both new columns are additive and nullable/defaulted — no backfill, no destructive
  migration.
- `customer-maintenance.ts` is a snapshot mirror that refuses to write when the master
  config is corrupt. Do not bypass that guard when wiring maintenance for potential
  customers.

---

## 6. Phasing

| Phase | Content | Ships |
| --- | --- | --- |
| 1 | `customer_stage` column + runtime self-apply + list filter + KPI scoping + **server-side money-path guard** | independently useful |
| 2 | `salesperson_user_id` + grid column + edit-dialog picker | independent of phase 1 |
| 3 | Remove CrmPanel + WishlistPanel mounts from `customers.tsx` | trivial, no deps |
| 4 | Rework Convert → Confirm per D2; create POTENTIAL customer at lead entry per D3 | **depends on D2 + D3** |

Phases 1–3 can start the moment D1 is answered. Phase 4 is the one that needs D2 and D3.

## 7. Tests

- `customer-stage.test.mjs` (new) — default CONFIRMED for existing rows; dual-keyed read;
  list filter; **server rejects a POTENTIAL customer on SO/invoice/DO create** (the guard).
- `customer-salesperson.test.mjs` (new) — stores user id, renders name, survives a rename.
- Extend `customer-crm.test.mjs` / `customer-crm-wishlist-send.test.mjs` to assert the
  panels are mounted in the **Pipeline drawer** and no longer in `customers.tsx`.
- `lead-convert.test.mjs` — rewrite for whichever D2 branch is chosen.
