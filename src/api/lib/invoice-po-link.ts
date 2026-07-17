// ---------------------------------------------------------------------------
// invoice-po-link.ts — carry the DO's per-line link onto invoice_items.
//
// BUG-2026-07-17-001. `delivery_order_items` stores `productionOrderId` per
// line, which resolves to the exact SO + line the piece was ordered under.
// `invoice_items` stored only productCode / fabricCode / sizeLabel — the link
// was THROWN AWAY at invoice creation. So the printout had to reconstruct the
// customer PO by matching on product code, first-one-wins
// (invoice-print-extras.ts). On a consolidated DO carrying repeated
// product+fabric lines from DIFFERENT sales orders that mislabels lines:
// INV-2607-060 printed the WRONG customer PO on 4 of its 12 lines, and three
// SOs' PO numbers never appeared at all while one appeared three times.
//
// The fix is not a smarter guess — the DO already knows. Store the link.
//
// Owner put it best (2026-07-17): 「跟著看DO在哪裏」.
//
// Column is snake_case (`production_order_id`) so no column-rename-map entry is
// needed. Deploys do NOT replay migration files here, so the runtime ALTER
// below is the load-bearing copy and must be awaited before the first
// read/write of the column.
// ---------------------------------------------------------------------------
import type { D1Database } from "@cloudflare/workers-types";

let _mig: Promise<void> | null = null;

/**
 * Runtime self-apply for `invoice_items.production_order_id`. Memoised per
 * isolate — the ALTER is idempotent but we don't want it on every request.
 * Best-effort: a transient DDL reject must not block invoicing (the column is
 * additive; a missing value only degrades the printout to its old guess).
 */
export function ensureInvoicePoLinkColumn(db: D1Database): Promise<void> {
  if (!_mig) {
    _mig = db
      .prepare(
        "ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS production_order_id TEXT",
      )
      .run()
      .then(() => undefined)
      .catch((err) => {
        console.warn(
          "[invoice-po-link] ensure production_order_id failed:",
          err instanceof Error ? err.message : String(err),
        );
        return undefined;
      });
  }
  return _mig;
}

/**
 * Read the link off an invoice-item row, dual-keyed — the runtime ALTER makes
 * it snake_case, but a driver/mirror echoing camelCase must not silently read
 * undefined (that would send the printout back to guessing without a word).
 */
export function readInvoiceItemPoLink(
  row: Record<string, unknown> | null | undefined,
): string | null {
  if (!row) return null;
  const v =
    (row as { productionOrderId?: unknown }).productionOrderId ??
    (row as { production_order_id?: unknown }).production_order_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}
