-- 0139_packing_lists.sql
-- New persisted "Packing List" entity. A delivery order is hub-restricted
-- (one DO = one hub = one drop), so a truck that drops at several hubs is
-- several DOs. A packing list groups the DOs going on ONE truck run into a
-- single saved document the warehouse prints to load the whole truck.
--
-- do_ids holds a JSON array of delivery_orders.id. The summary columns
-- (stop_count / total_units / total_m3) are snapshotted at create time for
-- the list view; the printed PDF re-reads the live DO line items.
CREATE TABLE IF NOT EXISTS packing_lists (
  id          text PRIMARY KEY,
  packing_no  text NOT NULL,
  status      text NOT NULL DEFAULT 'OPEN',
  do_ids      text NOT NULL DEFAULT '[]',
  stop_count  integer NOT NULL DEFAULT 0,
  total_units integer NOT NULL DEFAULT 0,
  total_m3    numeric NOT NULL DEFAULT 0,
  remarks     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  org_id      text NOT NULL DEFAULT 'hookka'
);

CREATE INDEX IF NOT EXISTS idx_packing_lists_org ON packing_lists (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_packing_lists_no ON packing_lists (org_id, packing_no);
