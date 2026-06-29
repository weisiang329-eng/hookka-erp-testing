-- ---------------------------------------------------------------------------
-- 0200 — Per-document Purchase Company tracking.
--
-- Adds `purchase_org_code` to purchase_orders, grns, and purchase_invoices so
-- each procurement document records which sister-company (HOOKKA, HOUZS, …)
-- is the buyer. Mirrors the long-standing `suppliers.purchase_org_code`
-- (per-supplier default), which we now treat as the default value to prefill
-- onto a fresh PO. GRN inherits from its PO; PI inherits from its PO/GRN.
-- All editable per-document (owner ruling 2026-06-29).
--
-- Books, AR/AP, journal entries are unchanged — Purchase Company is metadata
-- only. PDF letterhead already switches per `purchase_org_code` via
-- pdf-utils.ts; this just gives it a per-document source of truth.
--
-- PI lifecycle simplification (owner 2026-06-29): drop PENDING_APPROVAL and
-- APPROVED — collapse both into CONFIRMED. PAID stays terminal. Existing rows
-- in either state are backfilled to CONFIRMED.
--
-- Backfill rule: every existing row gets HOOKKA (org code) as the default
-- buyer. Owner can edit Houzs-billed rows individually via the UI.
--
-- Runtime self-apply lives in src/api/routes/purchase-orders.ts, grn.ts,
-- purchase-invoices.ts. This file is the historical record — the runtime
-- ALTER ... ADD COLUMN IF NOT EXISTS + UPDATE is what actually reaches prod
-- (deploy does not auto-replay migration files, per arch_per_line_discount).
-- ---------------------------------------------------------------------------

ALTER TABLE purchase_orders     ADD COLUMN IF NOT EXISTS purchase_org_code TEXT;
ALTER TABLE grns                ADD COLUMN IF NOT EXISTS purchase_org_code TEXT;
ALTER TABLE purchase_invoices   ADD COLUMN IF NOT EXISTS purchase_org_code TEXT;

-- Backfill: any pre-existing row defaults to HOOKKA.
UPDATE purchase_orders     SET purchase_org_code = 'HOOKKA' WHERE purchase_org_code IS NULL;
UPDATE grns                SET purchase_org_code = 'HOOKKA' WHERE purchase_org_code IS NULL;
UPDATE purchase_invoices   SET purchase_org_code = 'HOOKKA' WHERE purchase_org_code IS NULL;

-- PI lifecycle simplification — drop PENDING_APPROVAL / APPROVED.
UPDATE purchase_invoices SET status = 'CONFIRMED'
 WHERE status IN ('PENDING_APPROVAL', 'APPROVED');

-- GRN arrival/status integrity fix (owner 2026-06-29). The one-shot cascade
-- import created `GRN-IMPORT-PI-*` rows that landed POSTED + QC PASSED but
-- never had arrival_state set — leaving the UI showing "Planning" arrival
-- on already-posted stock. POSTED requires arrived goods (cost ledger +
-- stock already incremented), so any POSTED row missing ARRIVED is data
-- drift, fixed here.
UPDATE grns SET arrival_state = 'ARRIVED'
 WHERE status = 'POSTED'
   AND (arrival_state IS NULL OR arrival_state <> 'ARRIVED');
