-- ============================================================================
-- Migration 0077 — Service Cases: affected products list
--
-- Per design 2026-04-29: cases need a way to attach 0..N product SKUs
-- (operator's request: "Product SKU 应该是要可以无限添加的"). For SO/CO-sourced
-- cases the products can be derived from the source order, but EXTERNAL cases
-- have no order to derive from — and even SO-sourced cases sometimes have a
-- different product than what was on the order (shipment swap, customer
-- complaint about a different SKU than ordered, etc.).
--
-- Stored as JSON array of objects on service_cases.affected_product_ids:
--   [{ productId: string, code: string, name: string, qty?: number }, ...]
--
-- JSON instead of a separate junction table because the small-shop reality
-- is that most cases have 0 or 1 affected products, and we never query by
-- product → list-of-cases (the workflow is always case → products).
-- ============================================================================

ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS affected_product_ids TEXT;
