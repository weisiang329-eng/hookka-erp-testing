-- ---------------------------------------------------------------------------
-- 0108_so_customer_po_image.sql
--
-- Stores the original customer PO page(s) as a base64-encoded PNG on each
-- sales order. Populated by the Scan PO modal (PDF -> per-page PNG via
-- pdfjs-dist on the client) when an SO is created from an OCR'd PO. Lets
-- the operator pull up the original document when a customer disputes a
-- delivery — proves Hookka acted on what the customer actually sent.
--
-- Stored inline because:
--   - Per-SO image is small (~50-200KB PNG), one row, no fan-out.
--   - Avoids R2 + signed-URL plumbing for a feature that's read once per
--     dispute (low traffic).
--   - The column is nullable: only SOs created via PO_SCAN_CLAUDE source
--     populate it.
-- ---------------------------------------------------------------------------
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS customer_po_image_b64 TEXT;
