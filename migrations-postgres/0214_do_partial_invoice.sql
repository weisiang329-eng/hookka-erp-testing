-- 0214 — one delivery order, several invoices (the sales-side convert chain).
--
-- Purchasing has had a per-line consumed counter for a long time
-- (purchase_order_items.received_qty, grn_items.invoiced_qty, plus
-- purchase_invoice_items.grn_item_id naming the line a bill draws on). That is
-- what makes a goods receipt billable across SEVERAL purchase invoices and what
-- lets a deleted / cancelled invoice hand its quantities back.
--
-- The sales side had none of it: delivery_order_items had `quantity` and
-- nothing else, invoice_items had no link to the DO line it billed, and the
-- partial unique index uniq_invoice_active_delivery_order (migration 0208)
-- forbade a second live invoice per delivery order at the storage layer. So a
-- delivery was billed whole or not at all, and a wrong invoice could only be
-- replaced, never trimmed.
--
-- Owner's rule (2026-08-07): 「这种转换不是整张单锁死的 … 我应该可以在其中一个
-- Purchase Invoice 里面 delete 掉，然后重新 generate 成另外一个 Invoice.」
--
-- NOTE: deploys do NOT replay these files. The load-bearing copy of every
-- statement below is the runtime self-apply `ensureDoPartialInvoiceColumns` in
-- src/api/lib/do-partial-invoice.ts, awaited before the first write. This file
-- is the record + the SQLite test mirror.

-- The per-line consumed counter. INTEGER: delivered goods are whole units
-- (grn_items.invoiced_qty is NUMERIC because metre/length raw materials can be
-- received fractionally — finished goods cannot).
ALTER TABLE delivery_order_items
  ADD COLUMN IF NOT EXISTS invoiced_qty INTEGER NOT NULL DEFAULT 0;

-- The link from a bill line back to the delivery line it bills. Nullable by
-- design: every pre-existing invoice line has none (see the backwards-
-- compatibility note below), and the two invoice-building fallbacks (bill the
-- sales-order lines / bill the sales-order header total) have no DO line to
-- point at in the first place.
ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS delivery_order_item_id TEXT;

CREATE INDEX IF NOT EXISTS idx_invoice_items_do_item_id
  ON invoice_items (delivery_order_item_id);

-- The storage-layer backstop that REPLACES uniq_invoice_active_delivery_order.
-- That index existed to stop a concurrent double-create (BUG-2026-07-14-006);
-- it has to go, because a second live invoice is now the whole point. The race
-- worth guarding is no longer "two invoices exist" but "two concurrent bills
-- together draw more than the delivery delivered" — and this CHECK is what
-- makes the second one fail at the storage layer instead of over-billing.
ALTER TABLE delivery_order_items
  ADD CONSTRAINT chk_doi_invoiced_qty
  CHECK (invoiced_qty >= 0 AND invoiced_qty <= quantity);

DROP INDEX IF EXISTS uniq_invoice_active_delivery_order;

-- BACKWARDS COMPATIBILITY — deliberately NO backfill.
--
-- Every invoice raised before this migration has lines with no
-- delivery_order_item_id, and the counters above start at 0. Deriving billed
-- state from the counters alone would make every already-billed delivery order
-- read as UNBILLED and become re-billable — an invitation to charge customers
-- twice.
--
-- The application therefore derives:
--     fullyInvoiced = (remaining quantity is 0)
--                     OR (a LIVE invoice on this DO has no linked lines)
-- The second clause is the legacy whole-document bill. Today's data keeps
-- behaving exactly as it does today: one live invoice ⇒ fully billed ⇒ a
-- second is refused. Void it and the DO becomes billable again with zero
-- consumed, which is correct — a voided invoice bills nothing.
--
-- A backfill was rejected on purpose: the mapping would have to be guessed by
-- product code, and the two fallback invoice shapes have no DO line behind
-- their rows at all. A guess that lands short is a licence to bill the
-- difference twice, silently. See src/api/lib/do-partial-invoice.ts.
