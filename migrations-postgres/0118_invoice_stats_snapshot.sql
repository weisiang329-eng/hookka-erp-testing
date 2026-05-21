-- ---------------------------------------------------------------------------
-- 0118_invoice_stats_snapshot.sql — Cache-aside snapshot for the Invoice
-- stats endpoint.
--
-- Same pattern as migrations 0115 (dashboard_snapshot) and 0117 (delivery
-- snapshots). Caches GET /api/invoices/stats — the COUNT(*) GROUP BY
-- status aggregate that feeds the Invoices page KPI cards.
--
-- Source table for the Layer 2 freshness check: invoices.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invoice_stats_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
