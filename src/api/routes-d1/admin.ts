// ---------------------------------------------------------------------------
// Admin routes — manually-invoked maintenance endpoints.
//
// Phase 5 (hot/cold split):
//   POST /api/admin/archive/run
//     Moves completed + aged records from hot tables to their "_archive"
//     siblings created by migrations/0038_archive_tables.sql. Dry-run
//     mode previews counts without touching any rows. Full run requires
//     either ENVIRONMENT === "production" OR { confirm: true } in the
//     request body — guardrail against an accidental curl-from-a-shell.
//
// Cold criteria (per phase-5 spec):
//   production_orders → status = 'COMPLETED' AND updated_at < now-90d
//   job_cards         → parent production_order is in archive (cascade)
//   sales_orders      → status IN ('CLOSED','CANCELLED') AND
//                         updated_at < now-90d
//                       (spec says COMPLETED/CANCELLED; SO enum has no
//                        COMPLETED — CLOSED is the terminal equivalent.)
//   sales_order_items → parent SO is in archive (cascade)
//
// Tables NOT archived here (compliance retention, need legal review):
//   invoices, invoice_items, invoice_payments, cost_ledger, journal_*,
//   ap_aging/ar_aging, bank_transactions, fg_units, fg_batches.
//
// NOTE: writes the movements inside a single `db.batch([...])` call so
// insert + delete for each hot table land atomically. If the batch fails
// the whole phase rolls back (D1 wraps the batch in an implicit txn).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

// Age threshold for cold data — 90 days, per spec.
const COLD_DAYS = 90;

type Counts = {
  production_orders: number;
  job_cards: number;
  sales_orders: number;
  sales_order_items: number;
};

// Compute the ISO timestamp that represents "90 days ago" relative to now.
// Using toISOString keeps the format compatible with how updated_at is
// written elsewhere (new Date().toISOString() is the canonical pattern).
function coldCutoffIso(): string {
  const ms = Date.now() - COLD_DAYS * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

// Count-only preview used for both dry-run and the pre-flight stats on a
// real run. Uses the same WHERE clauses the INSERT…SELECT below will use,
// so the preview never drifts from the actual behavior.
async function countCold(
  db: D1Database,
  cutoff: string,
): Promise<Counts> {
  // production_orders: COMPLETED + aged
  const poRow = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM production_orders
        WHERE status = 'COMPLETED'
          AND COALESCE(updated_at, '') <> ''
          AND updated_at < ?`,
    )
    .bind(cutoff)
    .first<{ n: number }>();

  // job_cards: every JC whose parent PO is in the cold set. Using EXISTS
  // rather than IN so the planner can leverage idx_jc_poId.
  const jcRow = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM job_cards jc
        WHERE EXISTS (
          SELECT 1 FROM production_orders p
           WHERE p.id = jc.productionOrderId
             AND p.status = 'COMPLETED'
             AND COALESCE(p.updated_at, '') <> ''
             AND p.updated_at < ?
        )`,
    )
    .bind(cutoff)
    .first<{ n: number }>();

  // sales_orders: CLOSED/CANCELLED + aged. CLOSED is the SO-enum terminal
  // state (there's no 'COMPLETED' on sales_orders — see 0001_init.sql:395).
  const soRow = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM sales_orders
        WHERE status IN ('CLOSED','CANCELLED')
          AND COALESCE(updated_at, '') <> ''
          AND updated_at < ?`,
    )
    .bind(cutoff)
    .first<{ n: number }>();

  // sales_order_items: every row whose parent SO is cold.
  const soiRow = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM sales_order_items soi
        WHERE EXISTS (
          SELECT 1 FROM sales_orders s
           WHERE s.id = soi.salesOrderId
             AND s.status IN ('CLOSED','CANCELLED')
             AND COALESCE(s.updated_at, '') <> ''
             AND s.updated_at < ?
        )`,
    )
    .bind(cutoff)
    .first<{ n: number }>();

  return {
    production_orders: poRow?.n ?? 0,
    job_cards: jcRow?.n ?? 0,
    sales_orders: soRow?.n ?? 0,
    sales_order_items: soiRow?.n ?? 0,
  };
}

// ---------------------------------------------------------------------------
// POST /api/admin/archive/run
//
// Query params:
//   ?dryRun=true    — default. Counts only, no writes.
//   ?dryRun=false   — actually performs the archive. Requires either
//                     ENVIRONMENT === "production" in wrangler.toml OR
//                     a body of { "confirm": true }.
//
// Response:
//   { success, dryRun, cutoff, moved: { production_orders, job_cards, ... } }
// ---------------------------------------------------------------------------
app.post("/archive/run", async (c) => {
  const db = c.env.DB;
  const dryRunParam = (c.req.query("dryRun") ?? "true").toLowerCase();
  const dryRun = dryRunParam !== "false";

  const body = await c.req.json().catch(() => ({}));
  const confirm = body && typeof body === "object" && (body as { confirm?: unknown }).confirm === true;

  // Guardrail: only bypass the confirm flag when ENVIRONMENT === "production".
  // Literal reading of the phase-5 spec:
  //   "Require ENVIRONMENT === 'production' || body.confirm === true"
  // i.e. at least one of those two must be true to proceed with a real run.
  if (!dryRun && c.env.ENVIRONMENT !== "production" && !confirm) {
    return c.json(
      {
        success: false,
        error:
          "Refusing to run archive without confirmation. Pass { confirm: true } in body or set ENVIRONMENT=production.",
      },
      400,
    );
  }

  const cutoff = coldCutoffIso();
  const counts = await countCold(db, cutoff);

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      cutoff,
      moved: counts,
      note: "Dry run — no rows moved. Pass ?dryRun=false to execute.",
    });
  }

  // ---- actual run --------------------------------------------------------
  const now = new Date().toISOString();

  // Order matters:
  //   1. sales_order_items (children of cold SOs)
  //   2. sales_orders (parents)
  //   3. job_cards (children of cold POs)
  //   4. production_orders (parents)
  //
  // INSERT…SELECT copies the full hot-row into the archive table. D1's
  // batch API preserves statement order, so each table's INSERT runs
  // before its matching DELETE inside the same implicit txn.
  //
  // The `archivedAt` column is appended explicitly in the SELECT list so
  // it lands alongside the cloned columns. For the parent tables we use
  // the same `now` for every row; for the children we use the parent's
  // archivedAt via a correlated lookup would be more accurate, but a single
  // batch timestamp is plenty for the audit use case and keeps the SQL
  // trivially reviewable.

  const statements: D1PreparedStatement[] = [];

  // 1) sales_order_items INSERT
  statements.push(
    db
      .prepare(
        `INSERT INTO sales_order_items_archive
           SELECT soi.*, ? AS archivedAt
             FROM sales_order_items soi
            WHERE EXISTS (
              SELECT 1 FROM sales_orders s
               WHERE s.id = soi.salesOrderId
                 AND s.status IN ('CLOSED','CANCELLED')
                 AND COALESCE(s.updated_at, '') <> ''
                 AND s.updated_at < ?
            )`,
      )
      .bind(now, cutoff),
  );
  // 1b) sales_order_items DELETE
  statements.push(
    db
      .prepare(
        `DELETE FROM sales_order_items
          WHERE EXISTS (
            SELECT 1 FROM sales_orders s
             WHERE s.id = sales_order_items.salesOrderId
               AND s.status IN ('CLOSED','CANCELLED')
               AND COALESCE(s.updated_at, '') <> ''
               AND s.updated_at < ?
          )`,
      )
      .bind(cutoff),
  );

  // 2) sales_orders INSERT
  statements.push(
    db
      .prepare(
        `INSERT INTO sales_orders_archive
           SELECT s.*, ? AS archivedAt
             FROM sales_orders s
            WHERE s.status IN ('CLOSED','CANCELLED')
              AND COALESCE(s.updated_at, '') <> ''
              AND s.updated_at < ?`,
      )
      .bind(now, cutoff),
  );
  // 2b) sales_orders DELETE
  statements.push(
    db
      .prepare(
        `DELETE FROM sales_orders
          WHERE status IN ('CLOSED','CANCELLED')
            AND COALESCE(updated_at, '') <> ''
            AND updated_at < ?`,
      )
      .bind(cutoff),
  );

  // 3) job_cards INSERT (children of cold POs)
  statements.push(
    db
      .prepare(
        `INSERT INTO job_cards_archive
           SELECT jc.*, ? AS archivedAt
             FROM job_cards jc
            WHERE EXISTS (
              SELECT 1 FROM production_orders p
               WHERE p.id = jc.productionOrderId
                 AND p.status = 'COMPLETED'
                 AND COALESCE(p.updated_at, '') <> ''
                 AND p.updated_at < ?
            )`,
      )
      .bind(now, cutoff),
  );
  // 3b) job_cards DELETE
  statements.push(
    db
      .prepare(
        `DELETE FROM job_cards
          WHERE EXISTS (
            SELECT 1 FROM production_orders p
             WHERE p.id = job_cards.productionOrderId
               AND p.status = 'COMPLETED'
               AND COALESCE(p.updated_at, '') <> ''
               AND p.updated_at < ?
          )`,
      )
      .bind(cutoff),
  );

  // 4) production_orders INSERT
  statements.push(
    db
      .prepare(
        `INSERT INTO production_orders_archive
           SELECT p.*, ? AS archivedAt
             FROM production_orders p
            WHERE p.status = 'COMPLETED'
              AND COALESCE(p.updated_at, '') <> ''
              AND p.updated_at < ?`,
      )
      .bind(now, cutoff),
  );
  // 4b) production_orders DELETE
  statements.push(
    db
      .prepare(
        `DELETE FROM production_orders
          WHERE status = 'COMPLETED'
            AND COALESCE(updated_at, '') <> ''
            AND updated_at < ?`,
      )
      .bind(cutoff),
  );

  await db.batch(statements);

  return c.json({
    success: true,
    dryRun: false,
    cutoff,
    archivedAt: now,
    moved: counts,
  });
});

export default app;
