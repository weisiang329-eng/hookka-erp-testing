-- 0170_cn_packing_lists.sql
-- CN twin of packing_lists (migration 0139). A consignment note is
-- hub-restricted (one CN = one destination branch = one drop), so a truck
-- that drops at several branches is several CNs. A CN packing list groups the
-- CNs going on ONE truck run into a single saved document the warehouse prints
-- to load the whole truck — exactly like the DO-side packing_lists table, but
-- referencing consignment_notes instead of delivery_orders.
--
-- cn_ids holds a JSON array of consignment_notes.id. The summary columns
-- (stop_count / total_units / total_m3) are snapshotted at create time for the
-- list view; the printed PDF re-reads the live CN line items (printCnPackingList).
--
-- packing_no uses the CPL- prefix (CPL-YYMM-NNN) so it never collides with the
-- DO packing list's PL- numbers — the two run-sheet families share a shape but
-- live in separate tables and number independently.
--
-- The same CREATE also self-applies at runtime (ensureCnPackingListsTable in
-- src/api/routes/cn-packing-lists.ts) so deploy ordering can't break the CN
-- packing-list endpoints — the table lands on first use and this migration
-- makes it permanent. Mirrors the ensure pattern used by 0167's QR columns.
CREATE TABLE IF NOT EXISTS cn_packing_lists (
  id          text PRIMARY KEY,
  packing_no  text NOT NULL,
  status      text NOT NULL DEFAULT 'OPEN',
  cn_ids      text NOT NULL DEFAULT '[]',
  stop_count  integer NOT NULL DEFAULT 0,
  total_units integer NOT NULL DEFAULT 0,
  total_m3    numeric NOT NULL DEFAULT 0,
  remarks     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  org_id      text NOT NULL DEFAULT 'hookka'
);

CREATE INDEX IF NOT EXISTS idx_cn_packing_lists_org ON cn_packing_lists (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cn_packing_lists_no ON cn_packing_lists (org_id, packing_no);
