# Mid-Year Opening Support — Design (2026-07-02)

> **Last verified: 2026-08-13** against the `POST /opening-balance/post` handler at `src/api/routes/accounting.ts:12452` and a repo-wide search for `opening_doc_includes` / `openingDocIncludes`.
> Corrected 2026-08-13 — **this spec is HALF SHIPPED; the two features have opposite status:**
> - **Feature 1 (opening form accepts P&L accounts): SHIPPED.** The `!["ASSET","LIABILITY","EQUITY"].includes(acct.type)` rejection is gone from the handler; the SDC/SCC control-account block, one-side-only check and balance check all survive as specced.
> - **Feature 2 (opening include-list for pre-opening docs): NOT BUILT.** `opening_doc_includes` appears **nowhere** in `src/` or in `migrations-postgres/` — no table, no `ensureOpeningDocIncludes`, no route, no "Pre-opening supplier invoices" card. The 36 "Keep"-list PIs (RM 42,442.40) therefore still do **not** appear in creditor aging.
>
> This is the only doc in the 2026-08-13 docs audit with real unbuilt work. Feature 2's owner iron rule still stands: 之前录入的不删不改 — the marker must stay row-external.

Owner-approved scope (session 2026-07-02, debtor/creditor opening工程). Two features, one branch.

## Why

Opening date is **2026-05-22, mid-FY** (FYE 31 Aug). The old books' TB as at 22/05 carries
current-FY P&L balances (sales/purchases/expenses) that MUST appear in the new system's FY
P&L — they are not prior-year retained earnings. The existing `/opening-balance/post`
hard-rejects P&L accounts (designed for FY-start openings).

Separately, 36 already-entered PIs (MEDITEX ×17, OCEAN SKY ×17, NLY ×1, HEAP HEANG ×1 —
"Keep" list, RM 42,442.40) must appear in creditor aging with full detail, **without any
UPDATE to those rows** (owner iron rule: 之前录入的不删不改). 8 other pre-opening PIs
(3 phantoms + 5 wrong-amount) must stay hidden. A row-external marker is required.

## Feature 1 — Opening form accepts P&L accounts

`POST /opening-balance/post` (accounting.ts ~9576):
- DROP the `!["ASSET","LIABILITY","EQUITY"].includes(acct.type)` rejection.
- KEEP: SDC/SCC control-account block, one-side-only check, balance check, re-post
  (reverse-prior-net) cycle. P&L legs ride the same `opening_balance` sourceType, dated
  at openingDate (22/05 — floor is strict `<`, so opening-day legs are extracted; the
  opening_balance sourceType is additionally floor-exempt as an opening seed already).
- Frontend Opening Balance page: allow picking P&L accounts in the rows editor (currently
  filtered?—verify; adjust account picker filter + section grouping).
- P&L statement note: SALES/expense sections read GL → opening legs appear in May window.
  The MATERIAL/purchase section is PI-driven (piPurchaseCum) and will NOT read these GL
  legs — expected and accepted by owner (TB/GL alignment is the goal; material P&L runs
  on its own engine: opening stock + PI purchases + stock take).

## Feature 2 — Opening include-list for existing pre-opening docs

New table `opening_doc_includes`:
```sql
CREATE TABLE IF NOT EXISTS opening_doc_includes (
  org_id     TEXT NOT NULL,
  doc_type   TEXT NOT NULL,           -- 'purchase_invoice' (AR not needed: debtor opening = new entries)
  doc_id     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, doc_type, doc_id)
);
```
Runtime self-apply (`ensureOpeningDocIncludes`, ADD TABLE IF NOT EXISTS pattern) — no
manual migration dependency; paired migrations-postgres/ + migrations/ files for record.

Semantics for an included PI (is_opening stays 0 — row untouched):
- **Aging / supplier statement / creditor ledger / ap-control**: treated exactly like
  `is_opening=1` — exempt from the opening floor (`rowBeforeOpening(...) && !included`),
  shown per-invoice with detail.
- **`openingControlSums()`**: 400-0000 auto-leg = existing isOpening PIs + included PIs.
- **GL**: their original posted legs stay floored out (pre-opening, not opening seeds) —
  the control balance comes solely from the opening entry. No double count.
- **Payments**: allocation/knock-off works as normal (paid_amount flows back to the row —
  that is a normal business mutation, not an "edit").

UI: Opening Balance page gains a "Pre-opening supplier invoices" card — lists PIs with
`invoiceDate < opening_date` and status in (CONFIRMED/APPROVED/PARTIAL_PAID) with
checkbox per row (supplier, piNo, date, amount). Tick = INSERT into include table,
untick = DELETE. Original rows never written.

Read paths to touch (mirror the is_opening exemption everywhere it exists for AP):
grep `is_opening`/`isOpening` exemptions in accounting.ts + opening-floor call sites —
wire `included` set through the same guards. Keep the resolver one-load-per-request.

## Explicitly out of scope
- No data entry (76 opening PIs, advances, opening form values) — owner keys/orders later.
- No AR include-list (debtor opening uses new HKM-IV/OSM-IV entries).
- No deletion/edit of the 8 wrong/phantom PIs (stay unticked → hidden by floor).
- Dup-invoice cleanup (16 groups) — separate handover list, owner's ops side.

## Verify
- Unit: floor exemption via include set; openingControlSums addition; include CRUD.
- Canary: tick a staging PI → appears in aging w/ detail; opening post with P&L rows
  balances and re-posts cleanly; untick reverts. Then owner verifies on canary; merge on
  his word. Deploy notes: new table self-applies; no prod SQL needed for the feature.
