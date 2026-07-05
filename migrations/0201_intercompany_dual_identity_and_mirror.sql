-- ---------------------------------------------------------------------------
-- 0201 — Multi-Company Phase 3: dual-identity link + inter-company mirror log.
--
-- ADDITIVE, opt-in, default OFF. Nothing changes for a normal external
-- customer / supplier / PO / SO.
--
-- 1) Dual-identity link. A customer AND a supplier that are the SAME real group
--    company (HOOKKA / OHANA / HOUZS / HKMFG) are tied together by a shared org
--    code stored on BOTH tables. suppliers already had is_group_company
--    (migration 0023); this adds the explicit org code on both sides.
--       • '' (default) = a normal external party — byte-identical behaviour.
--       • e.g. 'HOUZS' = this row IS Houzs Century (a group company).
--    The customer with group_org_code = 'HOUZS' and the supplier with
--    group_org_code = 'HOUZS' are understood to be the one Houzs company wearing
--    its two hats (buys from us = AR/customer; we buy from it = AP/supplier —
--    two separate document streams that stay separate).
--
-- 2) Inter-company mirror log. Idempotency guard for the PO→SO mirror: when a
--    Purchase Order names a SISTER group company as the seller, we auto-create a
--    mirror SALES ORDER under that sister. UNIQUE (source_type, source_id) +
--    INSERT ... ON CONFLICT DO NOTHING makes a retry / re-save a no-op — never a
--    duplicate mirror.
--
-- Runtime self-apply lives in:
--   • src/api/routes/purchase-orders.ts  — suppliers.group_org_code + the mirror
--     call (createPurchaseOrderMirror) after PO create.
--   • src/api/routes/customers.ts         — customers.group_org_code.
--   • src/api/routes/suppliers.ts         — suppliers.group_org_code write path.
--   • src/api/lib/intercompany-mirror-create.ts — intercompany_mirror_log table.
-- This file is the historical record — deploy does NOT replay migration files,
-- so the runtime ALTER ... ADD COLUMN IF NOT EXISTS is what actually reaches
-- prod (per arch_per_line_discount).
--
-- TODO(intercompany-pnl-elimination): the mirror SO records the intra-group sale
-- at PO cost. Consolidated group P&L must LATER eliminate this intra-group
-- revenue/COGS pair so an internal transfer is not double-counted as group
-- profit. NOT done here — this is the document-mirroring foundation only.
--
-- TODO(grn-mirror): mirror the goods-receipt (GRN) the same way once an
-- inventory-safe design is in place (GRN posts stock + cost ledger, unlike the
-- side-effect-free PO⟷SO document mirror added here).
-- ---------------------------------------------------------------------------

ALTER TABLE customers ADD COLUMN IF NOT EXISTS group_org_code TEXT NOT NULL DEFAULT '';
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS group_org_code TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS intercompany_mirror_log (
  id text PRIMARY KEY,
  org_id text NOT NULL DEFAULT 'hookka',
  source_type text NOT NULL,       -- 'PO' (later: 'GRN')
  source_id text NOT NULL,         -- the source document id
  mirror_type text NOT NULL,       -- 'SO'
  mirror_id text NOT NULL,         -- the created mirror document id
  sister_org_code text NOT NULL,   -- the sister company the mirror is booked under
  buyer_org_code text NOT NULL,    -- the buying entity (default HOOKKA)
  created_at text
);

CREATE UNIQUE INDEX IF NOT EXISTS intercompany_mirror_log_source_uniq
  ON intercompany_mirror_log (source_type, source_id);
