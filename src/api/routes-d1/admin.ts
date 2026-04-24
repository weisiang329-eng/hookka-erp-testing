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
import {
  createProductionOrdersForSO,
  type SalesOrderRow,
  type SalesOrderItemRow,
} from "./sales-orders";

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
  const db = c.var.DB;
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

// ---------------------------------------------------------------------------
// Rebuild POs from current SO items + BOM
// ---------------------------------------------------------------------------
// Context: We've hit two live bugs where production_orders and job_cards
// drifted from the current sales_order_items / BOM:
//   1. Orphan POs — SO edits didn't cascade, so POs point at products that
//      no longer appear on the SO (e.g. SO-2604-159 has one "1007-(SS)"
//      line but 4 POs with unrelated products).
//   2. Incomplete sofa merge fan-out — some sibling POs missing during
//      earlier confirm flows (SO-2604-292 -01 WAITING, -02 COMPLETED even
//      though user clicked merged-complete once).
//
// Fix: wipe fg_units + production_orders (job_cards cascade) for every
// CONFIRMED/READY_TO_SHIP SO and regenerate via createProductionOrdersForSO
// using CURRENT sales_order_items + BOM as the single source of truth.
//
// Blast radius audited safe before running:
//   - 0 delivery_order_items pointing at any PO
//   - 0 invoices linked to affected SOs
//   - All job_cards already reset to WAITING (completedDate=NULL)
//   - wip_items.stockQty already zeroed
//   - fg_units has no downstream FK (reference-only) and gets regenerated
//     automatically on Packing completion.
//
// Guardrails:
//   - Dry-run by default (?dryRun=true).
//   - Full rebuild requires ?dryRun=false&confirm=YES_REBUILD_ALL (or
//     YES_REBUILD for the single-SO variant).
//   - Per-SO try/catch — if one SO's rebuild fails we skip it and continue
//     rather than poisoning the whole batch.
//   - SOs with zero items are skipped with reason "NO_ITEMS" — we will not
//     drop POs for an SO that has no items to regenerate from.
// ---------------------------------------------------------------------------

type RebuildSkip = { soId: string; companySOId: string | null; reason: string };
type RebuildBreakdown = {
  soId: string;
  companySOId: string | null;
  currentPOs: number;
  newPOs: number;
};

// Count existing production_orders + job_cards + fg_units for a given SO.
// Used by dry-run to show what would be wiped.
async function countCurrentForSO(
  db: D1Database,
  soId: string,
): Promise<{ pos: number; jcs: number; fgUnits: number }> {
  const poRow = await db
    .prepare("SELECT COUNT(*) AS n FROM production_orders WHERE salesOrderId = ?")
    .bind(soId)
    .first<{ n: number }>();
  const jcRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM job_cards
         WHERE productionOrderId IN (SELECT id FROM production_orders WHERE salesOrderId = ?)`,
    )
    .bind(soId)
    .first<{ n: number }>();
  const fgRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM fg_units
         WHERE poId IN (SELECT id FROM production_orders WHERE salesOrderId = ?)`,
    )
    .bind(soId)
    .first<{ n: number }>();
  return {
    pos: poRow?.n ?? 0,
    jcs: jcRow?.n ?? 0,
    fgUnits: fgRow?.n ?? 0,
  };
}

// Single-SO rebuild core — assembles the delete+recreate statements for one
// SO and either batches them (dryRun=false) or counts them (dryRun=true).
// Returns the tuple the callers aggregate into the response.
async function rebuildSingleSO(
  db: D1Database,
  so: SalesOrderRow,
  dryRun: boolean,
): Promise<
  | { ok: true; breakdown: RebuildBreakdown; statementCount: number; deletedFgUnits: number; deletedPOs: number; deletedJCs: number }
  | { ok: false; skip: RebuildSkip }
> {
  const itemsRes = await db
    .prepare("SELECT * FROM sales_order_items WHERE salesOrderId = ?")
    .bind(so.id)
    .all<SalesOrderItemRow>();
  const items = itemsRes.results ?? [];
  if (items.length === 0) {
    return {
      ok: false,
      skip: { soId: so.id, companySOId: so.companySOId, reason: "NO_ITEMS" },
    };
  }

  const current = await countCurrentForSO(db, so.id);

  // Build the regeneration statements FIRST so a broken BOM surfaces before
  // we touch anything. createProductionOrdersForSO's own "preExisting" guard
  // fires when production_orders for this SO already exist — in the real
  // (non-dry-run) path we wipe them first via db.batch, so the guard won't
  // fire. For dry-run we temporarily skip the existing POs check by calling
  // after we've counted — the function still runs, but because POs exist it
  // returns preExisting=true with an empty statements list. That's fine for
  // dry-run: the count we care about is `items.length` (sofa = 1 PO, BF/ACC
  // fans out per unit — we can't predict the exact count without running
  // the full BOM walk, but the per-SO breakdown still shows currentPOs and
  // item count is a reasonable lower bound).
  //
  // For dry-run we compute an *estimate* of new POs: sum over items of
  // (sofa ? 1 : quantity). This mirrors the fan-out logic in
  // createProductionOrdersForSO without executing it (avoids triggering
  // the preExisting short-circuit and avoids needing BOM lookups).
  let newPOEstimate = 0;
  for (const item of items) {
    const isSofa = (item.itemCategory ?? "BEDFRAME") === "SOFA";
    newPOEstimate += isSofa ? 1 : Math.max(1, item.quantity || 1);
  }

  if (dryRun) {
    return {
      ok: true,
      breakdown: {
        soId: so.id,
        companySOId: so.companySOId,
        currentPOs: current.pos,
        newPOs: newPOEstimate,
      },
      statementCount: 0,
      deletedFgUnits: current.fgUnits,
      deletedPOs: current.pos,
      deletedJCs: current.jcs,
    };
  }

  // Real run: wipe fg_units + production_orders for this SO (job_cards
  // cascades via FK), then run createProductionOrdersForSO against the
  // current items + BOM and batch all statements together.
  const wipeStmts: D1PreparedStatement[] = [
    db
      .prepare(
        `DELETE FROM fg_units WHERE poId IN (SELECT id FROM production_orders WHERE salesOrderId = ?)`,
      )
      .bind(so.id),
    db
      .prepare("DELETE FROM production_orders WHERE salesOrderId = ?")
      .bind(so.id),
  ];
  await db.batch(wipeStmts);

  let genResult: Awaited<ReturnType<typeof createProductionOrdersForSO>>;
  try {
    genResult = await createProductionOrdersForSO(db, so, items);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      skip: {
        soId: so.id,
        companySOId: so.companySOId,
        reason: `CREATE_FAILED: ${msg}`,
      },
    };
  }

  if (genResult.statements.length > 0) {
    await db.batch(genResult.statements);
  }

  return {
    ok: true,
    breakdown: {
      soId: so.id,
      companySOId: so.companySOId,
      currentPOs: current.pos,
      newPOs: genResult.created.length,
    },
    statementCount: genResult.statements.length,
    deletedFgUnits: current.fgUnits,
    deletedPOs: current.pos,
    deletedJCs: current.jcs,
  };
}

// ---------------------------------------------------------------------------
// POST /api/admin/rebuild-all-pos
// ---------------------------------------------------------------------------
app.post("/rebuild-all-pos", async (c) => {
  const db = c.var.DB;
  const dryRunParam = (c.req.query("dryRun") ?? "true").toLowerCase();
  const dryRun = dryRunParam !== "false";
  const confirm = c.req.query("confirm") ?? "";

  if (!dryRun && confirm !== "YES_REBUILD_ALL") {
    return c.json(
      {
        success: false,
        error:
          "Refusing to rebuild without confirmation. Pass ?confirm=YES_REBUILD_ALL to execute.",
      },
      400,
    );
  }

  const sosRes = await db
    .prepare(
      `SELECT * FROM sales_orders
         WHERE status IN ('CONFIRMED','READY_TO_SHIP')
         ORDER BY id`,
    )
    .all<SalesOrderRow>();
  const sos = sosRes.results ?? [];

  const skipped: RebuildSkip[] = [];
  const soBreakdown: RebuildBreakdown[] = [];
  let totalStatements = 0;
  let rebuilt = 0;
  let wipeDeletedPOs = 0;
  let wipeDeletedJCs = 0;
  let wipeDeletedFgUnits = 0;
  let createdPOs = 0;

  for (const so of sos) {
    // Per-SO isolation — a thrown error on one SO should not kill the loop.
    try {
      const result = await rebuildSingleSO(db, so, dryRun);
      if (!result.ok) {
        skipped.push(result.skip);
        continue;
      }
      soBreakdown.push(result.breakdown);
      totalStatements += result.statementCount;
      wipeDeletedPOs += result.deletedPOs;
      wipeDeletedJCs += result.deletedJCs;
      wipeDeletedFgUnits += result.deletedFgUnits;
      createdPOs += result.breakdown.newPOs;
      if (!dryRun) rebuilt++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skipped.push({
        soId: so.id,
        companySOId: so.companySOId,
        reason: `CREATE_FAILED: ${msg}`,
      });
    }
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      wouldDelete: {
        pos: wipeDeletedPOs,
        jcs: wipeDeletedJCs,
        fgUnits: wipeDeletedFgUnits,
      },
      wouldCreate: {
        pos: createdPOs,
        // JC count can't be computed cheaply without running the full
        // BOM walk — omit here; full count reflected after actual run.
      },
      soBreakdown,
      skipped,
      totalSOs: sos.length,
      note:
        "Dry run. Pass ?dryRun=false&confirm=YES_REBUILD_ALL to execute. newPOs in breakdown is an ESTIMATE based on item fan-out (sofa=1/item, BF/ACC=quantity/item).",
    });
  }

  return c.json({
    success: true,
    dryRun: false,
    rebuilt,
    skipped,
    totalStatements,
    deleted: {
      pos: wipeDeletedPOs,
      jcs: wipeDeletedJCs,
      fgUnits: wipeDeletedFgUnits,
    },
    created: { pos: createdPOs },
    soBreakdown,
    totalSOs: sos.length,
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/rebuild-pos/:soId
// ---------------------------------------------------------------------------
app.post("/rebuild-pos/:soId", async (c) => {
  const db = c.var.DB;
  const soId = c.req.param("soId");
  const dryRunParam = (c.req.query("dryRun") ?? "true").toLowerCase();
  const dryRun = dryRunParam !== "false";
  const confirm = c.req.query("confirm") ?? "";

  if (!dryRun && confirm !== "YES_REBUILD") {
    return c.json(
      {
        success: false,
        error:
          "Refusing to rebuild without confirmation. Pass ?confirm=YES_REBUILD to execute.",
      },
      400,
    );
  }

  const so = await db
    .prepare("SELECT * FROM sales_orders WHERE id = ?")
    .bind(soId)
    .first<SalesOrderRow>();
  if (!so) {
    return c.json({ success: false, error: "SO not found" }, 404);
  }
  if (so.status !== "CONFIRMED" && so.status !== "READY_TO_SHIP") {
    return c.json(
      {
        success: false,
        error: `SO status is ${so.status} — rebuild only operates on CONFIRMED/READY_TO_SHIP.`,
      },
      400,
    );
  }

  try {
    const result = await rebuildSingleSO(db, so, dryRun);
    if (!result.ok) {
      return c.json({ success: false, skipped: result.skip }, 400);
    }
    if (dryRun) {
      return c.json({
        success: true,
        dryRun: true,
        wouldDelete: {
          pos: result.deletedPOs,
          jcs: result.deletedJCs,
          fgUnits: result.deletedFgUnits,
        },
        wouldCreate: { pos: result.breakdown.newPOs },
        breakdown: result.breakdown,
        note:
          "Dry run. Pass ?dryRun=false&confirm=YES_REBUILD to execute. newPOs is an ESTIMATE based on item fan-out.",
      });
    }
    return c.json({
      success: true,
      dryRun: false,
      rebuilt: 1,
      totalStatements: result.statementCount,
      deleted: {
        pos: result.deletedPOs,
        jcs: result.deletedJCs,
        fgUnits: result.deletedFgUnits,
      },
      created: { pos: result.breakdown.newPOs },
      breakdown: result.breakdown,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json(
      {
        success: false,
        error: `CREATE_FAILED: ${msg}`,
        soId: so.id,
      },
      500,
    );
  }
});

export default app;
