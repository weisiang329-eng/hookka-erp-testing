> **ARCHIVED / SUPERSEDED — stopped being true 2026-08-01.** A one-off dated session checklist whose open items have all resolved: its item C (CRM wishlist) was RETIRED by owner decision on 2026-08-01 — `src/components/customer/WishlistPanel.tsx` no longer exists and `src/api/routes/customer-crm.ts:410` records "整个功能删掉，我们 assign SKU 就行了"; its "Purchase Return slices 2/3" pending item shipped 2026-07-31 (`src/api/lib/purchase-return-create.ts` carries the Slice-2 inventory reversal at L200 and the Slice-3 supplier Debit Note at L309); its "CRM slice 3" pending item shipped as the lead-catalog provisional assignments at `src/api/routes/sales-leads.ts:369`. Kept for history only; do not treat as current.

# 2026-07-30 Session — What was built, and how to test it all at once

Everything below was built this session. Test on **staging** after the deploy runs.
Legend: ✅ merged to staging · 🟡 open PR (needs review/merge) · ⏳ not built yet.

---

## A. Leg height → raw-material SKU binding  ✅ (PR #130, merged)
Bind each leg height to the exact leg SKU it consumes; consumption uses the bound SKU.
- [ ] Products → **Maintenance → Leg Heights** (bedframe + sofa): each row has a **SKU picker**. Bind e.g. `6"` → a leg SKU. Save.
- [ ] Complete a PO whose SO chose that leg height → the BOUND leg SKU is deducted (not a guessed one). Unbound heights still deduct the old way (no regression).

## B. BOM editor — reorder + insert-in-the-middle  🟡 (PR #131, merged to staging)
- [ ] Open a BOM. Each **process** row has **↑ / ↓** — add a process (lands at bottom) then ↑ it between two others (e.g. between Framing & Webbing).
- [ ] Each **WIP** row has ↑ / ↓, plus **"+ Above"** to insert a whole new level in the middle.
- [ ] First row can't go up, last can't go down (arrows disabled).

## C. CRM — wishlist + one-click email quotation  ✅ (PR #132, merged)
- [ ] Open a customer → **Wishlist — styles liked**: add a SKU or a free-text style + note.
- [ ] Customer Products header → **Email Quotation** button → confirm recipient (prefilled) → sends the quote PDF + logs a "QUOTE_SENT" activity. (Only actually emails if an email provider is configured; else it says so.)

## D. Foam Cutting + Foam Bonding departments  ✅ (PR #129, merged)
- [ ] Sidebar → Production shows **Foam Cutting** AND **Foam Bonding** (the old "Foam" is renamed).

## E. CRM redesign — pipeline usable + convert + standardization  🟡 (PR #134)
- [ ] **Sales Pipeline**: drag a card between columns (stage moves). Target column highlights.
- [ ] Click a card → **Lead detail drawer**: edit fields; add a **contact**, log an **activity**, add a **wishlist** item, fill **KYC** — all saved on the lead (so anyone can take over).
- [ ] Drawer → **Convert to customer →**: fill Credit Code / Name / Terms / Credit Limit / PIC / PIC contact / (optional) hub → **Convert** → a real customer is created and the lead's contacts/activity/wishlist/KYC move onto it.
- [ ] Phone inputs everywhere (Lead + Customer + hub) now have a **+60 country-code dropdown** (pick another country for foreign numbers). Email fields reject bad formats. Hub state is a shared dropdown.

## F. Purchase Return — create from a PI  🟡 (PR #135, slice 1 of 4)
- [ ] Sidebar → Procurement → **Purchase Return** → **New Purchase Return** → pick a PI → tick lines → return qty / editable cost / reason → **Create return**. It lists.
- [ ] (No stock/AP movement yet — that's slices 2/3, coming with your verification.)

---

## G. FILLER (sponge) area-based consumption  ⏳ (this PR — in progress)
The one we just designed: sponge deducts by **area ratio** = cut (L×W) ÷ sheet (L×W) = a fraction of a sheet.
- [ ] **Raw Materials → a sponge SKU (S.FILLER)**: new **Sheet Length / Width (inch)** fields. Fill e.g. 96 × 48.
- [ ] **BOM → a material line that points to a sponge (FILLER)**: new **Cut Length / Width (inch)** fields. Fill e.g. 48 × 24.
- [ ] Complete a PO for that product → the sponge SKU deducts **(48×24)/(96×48) = 0.25 sheet** per piece (decimal stock), and the material cost = 0.25 × the sheet's FIFO unit cost.
- [ ] A sponge line WITHOUT cut dims still deducts the old way (no regression).

---

## Still pending (needs your input / later)
- ⏳ **Foam Cutting capacity scheduling** — needs your 2 numbers: pieces/day + handoff days.
- ⏳ **Purchase Return slices 2/3** — inventory reversal + Debit Note/AP (money; verify each on staging).
- ⏳ **CRM slice 3** — assign Category/Catalog/price/Sofa Combo on a lead.
