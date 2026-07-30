import type { Env } from "../worker";

// ---------------------------------------------------------------------------
// ensure-inventory-perf-indexes.ts — fg-stock hot-path indexes.
//
// `GET /api/inventory/fg-stock` derives finished-goods stock for the whole org.
// On a cold / expired snapshot it runs a whole-org compute (self-documented as
// "~8s", BUG-2026-07-13-001 in inventory.ts) that FULL-SCANS the two biggest
// tables on the path — `job_cards` and `piece_pics` — plus a per-request
// freshness probe that takes `MAX(updated_at)` across six source tables. As
// prod data grew, that compute crossed the frontend's 30s `/api/*` abort → the
// endpoint 504s. A 504 here then crashes the Inventory page on ANY refetch
// (delete / edit-save / refresh), so this is the root cause of the "delete a
// SKU and the whole page flashes back to the dashboard" report.
//
// These indexes remove the full scans on both the cold-compute path and the
// (every-request) freshness probe. Migrations do NOT auto-apply on deploy (see
// CLAUDE.md); the canonical DDL is in migrations/0209_inventory_perf_indexes.sql
// but it only reaches PROD via this runtime ensure.
//
// Column casing: the route SQL uses camelCase identifiers (`WHERE orgId = ?`,
// `GROUP BY jobCardId`, `pic1Id IS NOT NULL`) that a rewrite layer translates
// to the snake_case PHYSICAL columns (column-rename-map.json: orgId→org_id,
// jobCardId→job_card_id, pic1Id→pic1_id, updatedAt→updated_at). DDL run directly
// here is NOT rewritten, so it must name the physical snake_case columns — same
// as ensure-finance-org.ts. Using camelCase would create an index on a
// non-existent column (or nothing) and silently defeat the fix.
//
// Idempotent (`CREATE INDEX IF NOT EXISTS`, cheap no-op once built) and each
// statement is wrapped in try/catch so a missing table / column or a
// no-DDL-perms environment degrades gracefully (the endpoint just keeps using
// today's slower path) rather than failing the request. Memoised per isolate.
// ---------------------------------------------------------------------------

const INVENTORY_PERF_INDEX_STATEMENTS: readonly string[] = [
  // Cold whole-org compute — the two full-scanned big tables + the products read.
  "CREATE INDEX IF NOT EXISTS idx_job_cards_org_id ON job_cards (org_id)",
  "CREATE INDEX IF NOT EXISTS idx_piece_pics_org_jc_done ON piece_pics (org_id, job_card_id) WHERE pic1_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_products_org_status ON products (org_id, status)",
  // Per-request freshness probe: MAX(updated_at) over each fg-stock source table.
  "CREATE INDEX IF NOT EXISTS idx_job_cards_updated_at ON job_cards (updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_production_orders_updated_at ON production_orders (updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_delivery_orders_updated_at ON delivery_orders (updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_delivery_order_items_updated_at ON delivery_order_items (updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_consignment_notes_updated_at ON consignment_notes (updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_consignment_items_updated_at ON consignment_items (updated_at)",
];

let inventoryPerfIndexPromise: Promise<void> | null = null;

export function ensureInventoryPerfIndexes(
  db: Env["Variables"]["DB"],
): Promise<void> {
  if (inventoryPerfIndexPromise) return inventoryPerfIndexPromise;
  inventoryPerfIndexPromise = (async () => {
    let hadFailure = false;
    for (const sql of INVENTORY_PERF_INDEX_STATEMENTS) {
      try {
        await db.prepare(sql).run();
      } catch {
        // Best-effort: table/column missing or no DDL perms. The fg-stock
        // endpoint keeps working via its existing (unindexed) path.
        hadFailure = true;
      }
    }
    // Self-heal: a transient DDL reject clears the memo so the next request
    // retries rather than caching a partial-apply as "done".
    if (hadFailure) inventoryPerfIndexPromise = null;
  })();
  return inventoryPerfIndexPromise;
}
