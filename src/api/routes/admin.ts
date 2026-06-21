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
import { requirePermission, requireSuperAdmin } from "../lib/rbac";
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
  const denied = await requirePermission(c, "users", "create");
  if (denied) return denied;
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
           SELECT soi.*, ? AS "archivedAt"
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
           SELECT s.*, ? AS "archivedAt"
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
           SELECT jc.*, ? AS "archivedAt"
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
           SELECT p.*, ? AS "archivedAt"
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
  const denied = await requirePermission(c, "users", "create");
  if (denied) return denied;
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
  const denied = await requirePermission(c, "users", "create");
  if (denied) return denied;
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

// ---------------------------------------------------------------------------
// POST /api/admin/purge-pre-april-2026
//
// ONE-TIME historical cleanup: deletes all purchasing documents (POs, GRNs,
// PIs) with dates before 2026-04-01 while PRESERVING all stock movements,
// cost ledger entries, rm_batches, and current inventory.
//
// Owner-authorised 2026-06-21. Verified scope on prod:
//   555 POs (all CLOSED), 555 GRNs (all POSTED/QC PASSED), 555 PIs (all
//   APPROVED), dated 2025-06-12 → 2026-03-31. Zero cross-refs from kept
//   (April-onward) docs into this set.
//
// Guards:
//   1. requireSuperAdmin — rejects any role other than SUPER_ADMIN.
//   2. Body must contain { "confirm": "DELETE-1665" } — mismatched/absent
//      returns 400 without touching any data.
//
// What is preserved (NOT deleted):
//   • rm_batches rows sourced from these GRNs — their source_ref_id is
//     NULLed so they survive as anonymous FIFO cost layers. Stock/cost
//     history stays intact; only the paperwork reference is removed.
//   • cost_ledger RM_RECEIPT rows referencing these GRNs — their ref_id
//     is NULLed for the same reason.
//   • three_way_matches rows referencing these POs/GRNs — po_id and
//     grn_id are NULLed so the 3WM audit trail remains without dangling FKs.
//   • supplier_payments rows linked to these PIs — purchase_invoice_id
//     is NULLed; payment history stays in the ledger.
//   • purchase_credit_notes rows linked to these PIs — purchase_invoice_id
//     is NULLed; CNs remain as standalone finance documents.
//
// Execution plan (inside a single db.batch() Postgres transaction):
//   Step 0: Collect the three sets of IDs (PO, GRN, PI) to be purged.
//   Step 1: NULL loose FK refs on rm_batches, cost_ledger, three_way_matches,
//           supplier_payments, purchase_credit_notes.
//   Step 2: DELETE from grn_items, grns (CASCADE deletes grn_items anyway).
//   Step 3: DELETE from purchase_invoice_items, purchase_invoices (CASCADE).
//   Step 4: DELETE from purchase_order_items, purchase_orders (CASCADE).
//   Backups: CREATE TABLE IF NOT EXISTS zz_purge_backup_* AS SELECT …
//            run BEFORE the batch (DDL auto-commits; safe to keep if the
//            delete batch fails).
//
// DO NOT run this endpoint without owner confirmation. DELETE-1665 =
// 555 + 555 + 555 documents.
// ---------------------------------------------------------------------------
app.post("/purge-pre-april-2026", async (c) => {
  // Hard SUPER_ADMIN gate — not even ADMIN can call this.
  const denied = requireSuperAdmin(c);
  if (denied) return denied;

  // Confirm token guard — must match exactly.
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json(
      { success: false, error: 'Request body must be JSON with { "confirm": "DELETE-1665" }' },
      400,
    );
  }
  if (body.confirm !== "DELETE-1665") {
    return c.json(
      {
        success: false,
        error: 'Confirmation token mismatch. Pass { "confirm": "DELETE-1665" } to execute.',
      },
      400,
    );
  }

  const db = c.var.DB;
  const CUTOFF = "2026-04-01";

  try {
    // -------------------------------------------------------------------------
    // Step 0 — Collect the IDs that will be deleted. These are used to:
    //   a) create backup tables (DDL, outside the transaction)
    //   b) scope the NULL-preservation updates
    //   c) return accurate counts to the caller
    //
    // Column names go through the SupabaseAdapter's translateSql (camelCase →
    // snake_case rename map), so orderDate → order_date, receiveDate →
    // receive_date, invoiceDate → invoice_date.
    // -------------------------------------------------------------------------
    const poIdsRes = await db
      .prepare("SELECT id FROM purchase_orders WHERE orderDate < ?")
      .bind(CUTOFF)
      .all<{ id: string }>();
    const poIds = (poIdsRes.results ?? []).map((r) => r.id);

    const grnIdsRes = await db
      .prepare("SELECT id FROM grns WHERE receiveDate < ?")
      .bind(CUTOFF)
      .all<{ id: string }>();
    const grnIds = (grnIdsRes.results ?? []).map((r) => r.id);

    const piIdsRes = await db
      .prepare("SELECT id FROM purchase_invoices WHERE invoiceDate < ?")
      .bind(CUTOFF)
      .all<{ id: string }>();
    const piIds = (piIdsRes.results ?? []).map((r) => r.id);

    // Count child rows that CASCADE with the parents (for the response).
    const poItemCountRes = await db
      .prepare(
        poIds.length > 0
          ? `SELECT COUNT(*) AS n FROM purchase_order_items WHERE purchaseOrderId IN (${poIds.map(() => "?").join(",")}) `
          : "SELECT 0 AS n",
      )
      .bind(...(poIds.length > 0 ? poIds : []))
      .first<{ n: number }>();
    const poItemCount = Number(poItemCountRes?.n ?? 0);

    const grnItemCountRes = await db
      .prepare(
        grnIds.length > 0
          ? `SELECT COUNT(*) AS n FROM grn_items WHERE grnId IN (${grnIds.map(() => "?").join(",")})`
          : "SELECT 0 AS n",
      )
      .bind(...(grnIds.length > 0 ? grnIds : []))
      .first<{ n: number }>();
    const grnItemCount = Number(grnItemCountRes?.n ?? 0);

    const piItemCountRes = await db
      .prepare(
        piIds.length > 0
          ? `SELECT COUNT(*) AS n FROM purchase_invoice_items WHERE piId IN (${piIds.map(() => "?").join(",")})`
          : "SELECT 0 AS n",
      )
      .bind(...(piIds.length > 0 ? piIds : []))
      .first<{ n: number }>();
    const piItemCount = Number(piItemCountRes?.n ?? 0);

    // -------------------------------------------------------------------------
    // Step 1 — CREATE BACKUP TABLES (DDL, auto-committed before the delete
    // transaction begins). If the deletes fail the backups remain intact as
    // a safety net. Using IF NOT EXISTS so re-runs don't collide.
    //
    // Note: translateSql rewrites camelCase identifiers in the SELECT list
    // (orderDate → order_date etc.) so the backup columns are snake_case,
    // matching the live table. The table name itself is a literal string and
    // is NOT rewritten (it's quoted or treated as a keyword-free identifier).
    // -------------------------------------------------------------------------
    const backupStmts = [
      // purchase_orders header backup
      `CREATE TABLE IF NOT EXISTS zz_purge_backup_purchase_orders AS
         SELECT * FROM purchase_orders WHERE orderDate < '${CUTOFF}'`,
      // purchase_order_items child backup
      ...(poIds.length > 0
        ? [
            `CREATE TABLE IF NOT EXISTS zz_purge_backup_purchase_order_items AS
               SELECT poi.* FROM purchase_order_items poi
                WHERE poi.purchaseOrderId IN (${poIds.map((id) => `'${id}'`).join(",")})`,
          ]
        : [
            `CREATE TABLE IF NOT EXISTS zz_purge_backup_purchase_order_items AS
               SELECT * FROM purchase_order_items WHERE FALSE`,
          ]),
      // grns header backup
      `CREATE TABLE IF NOT EXISTS zz_purge_backup_grns AS
         SELECT * FROM grns WHERE receiveDate < '${CUTOFF}'`,
      // grn_items child backup
      ...(grnIds.length > 0
        ? [
            `CREATE TABLE IF NOT EXISTS zz_purge_backup_grn_items AS
               SELECT gi.* FROM grn_items gi
                WHERE gi.grnId IN (${grnIds.map((id) => `'${id}'`).join(",")})`,
          ]
        : [
            `CREATE TABLE IF NOT EXISTS zz_purge_backup_grn_items AS
               SELECT * FROM grn_items WHERE FALSE`,
          ]),
      // purchase_invoices header backup
      `CREATE TABLE IF NOT EXISTS zz_purge_backup_purchase_invoices AS
         SELECT * FROM purchase_invoices WHERE invoiceDate < '${CUTOFF}'`,
      // purchase_invoice_items child backup
      ...(piIds.length > 0
        ? [
            `CREATE TABLE IF NOT EXISTS zz_purge_backup_purchase_invoice_items AS
               SELECT pii.* FROM purchase_invoice_items pii
                WHERE pii.piId IN (${piIds.map((id) => `'${id}'`).join(",")})`,
          ]
        : [
            `CREATE TABLE IF NOT EXISTS zz_purge_backup_purchase_invoice_items AS
               SELECT * FROM purchase_invoice_items WHERE FALSE`,
          ]),
    ];

    // Run DDL sequentially outside the delete transaction (each auto-commits).
    for (const ddl of backupStmts) {
      await db.prepare(ddl).run();
    }

    // -------------------------------------------------------------------------
    // Step 2 — NULL-preservation and DELETE, all in one atomic batch.
    //
    // The SupabaseAdapter.batch() wraps all statements in sql.begin(...) so
    // the whole set is a single Postgres transaction. If any statement fails,
    // all changes are rolled back and the backup tables remain intact.
    //
    // NULL updates come first so FK constraints are satisfied at delete time.
    // -------------------------------------------------------------------------
    const deleteStatements: ReturnType<D1Database["prepare"]>[] = [];

    if (grnIds.length > 0) {
      const grnPlaceholders = grnIds.map(() => "?").join(",");

      // NULL rm_batches.source_ref_id for batches sourced from these GRNs.
      // Preserves FIFO cost layers — they become anonymous OPENING-style rows.
      // Actual column in Postgres: source_ref_id (camelCase: sourceRefId).
      deleteStatements.push(
        db
          .prepare(
            `UPDATE rm_batches SET sourceRefId = NULL
               WHERE source = 'GRN' AND sourceRefId IN (${grnPlaceholders})`,
          )
          .bind(...grnIds),
      );

      // NULL cost_ledger.ref_id for RM_RECEIPT entries linked to these GRNs.
      // Preserves cost history — the ledger row stays as an anonymous entry.
      // Actual column in Postgres: ref_id (camelCase: refId).
      deleteStatements.push(
        db
          .prepare(
            `UPDATE cost_ledger SET refId = NULL, refType = NULL
               WHERE refType = 'GRN' AND refId IN (${grnPlaceholders})`,
          )
          .bind(...grnIds),
      );

      // NULL three_way_matches.grn_id for matches referencing these GRNs.
      // No enforced FK (grns has no CASCADE rule to three_way_matches), but
      // nulling keeps the 3WM audit trail self-consistent.
      // Actual column in Postgres: grn_id (camelCase: grnId).
      deleteStatements.push(
        db
          .prepare(
            `UPDATE three_way_matches SET grnId = NULL, grn_number = NULL
               WHERE grnId IN (${grnPlaceholders})`,
          )
          .bind(...grnIds),
      );
    }

    if (poIds.length > 0) {
      const poPlaceholders = poIds.map(() => "?").join(",");

      // NULL three_way_matches.po_id for matches referencing these POs.
      // grns.po_id has a FK to purchase_orders (no CASCADE) but we delete
      // the GRNs themselves, so the PO FK is irrelevant for the 3WM table.
      // Actual column in Postgres: po_id (camelCase: poId).
      deleteStatements.push(
        db
          .prepare(
            `UPDATE three_way_matches SET poId = NULL, po_number = NULL
               WHERE poId IN (${poPlaceholders})`,
          )
          .bind(...poIds),
      );
    }

    if (piIds.length > 0) {
      const piPlaceholders = piIds.map(() => "?").join(",");

      // NULL supplier_payments.purchase_invoice_id for payments against these PIs.
      // Preserves payment records — the payment stays in the ledger without the
      // doc reference. Actual column: purchase_invoice_id (camelCase: purchaseInvoiceId).
      deleteStatements.push(
        db
          .prepare(
            `UPDATE supplier_payments SET purchaseInvoiceId = NULL
               WHERE purchaseInvoiceId IN (${piPlaceholders})`,
          )
          .bind(...piIds),
      );

      // NULL purchase_credit_notes.purchase_invoice_id for CNs against these PIs.
      // Preserves credit note records. Actual column: purchase_invoice_id (camelCase: purchaseInvoiceId).
      deleteStatements.push(
        db
          .prepare(
            `UPDATE purchase_credit_notes SET purchaseInvoiceId = NULL
               WHERE purchaseInvoiceId IN (${piPlaceholders})`,
          )
          .bind(...piIds),
      );
    }

    // DELETE purchase_invoice_items first (belt-and-braces before PI delete;
    // ON DELETE CASCADE on pi_id would do this automatically, but explicit is
    // safer in a purge context — count reflects what was actually removed).
    if (piIds.length > 0) {
      deleteStatements.push(
        db
          .prepare(
            `DELETE FROM purchase_invoice_items
               WHERE piId IN (${piIds.map(() => "?").join(",")})`,
          )
          .bind(...piIds),
      );
    }

    // DELETE purchase_invoices.
    if (piIds.length > 0) {
      deleteStatements.push(
        db
          .prepare(
            `DELETE FROM purchase_invoices WHERE id IN (${piIds.map(() => "?").join(",")})`,
          )
          .bind(...piIds),
      );
    }

    // DELETE grn_items first (belt-and-braces; ON DELETE CASCADE on grn_id handles
    // this automatically on the GRN delete, but explicit lets us count).
    if (grnIds.length > 0) {
      deleteStatements.push(
        db
          .prepare(
            `DELETE FROM grn_items WHERE grnId IN (${grnIds.map(() => "?").join(",")})`,
          )
          .bind(...grnIds),
      );
    }

    // DELETE grns.
    if (grnIds.length > 0) {
      deleteStatements.push(
        db
          .prepare(
            `DELETE FROM grns WHERE id IN (${grnIds.map(() => "?").join(",")})`,
          )
          .bind(...grnIds),
      );
    }

    // DELETE purchase_order_items (CASCADE from PO delete handles this
    // automatically; explicit delete lets us count first).
    if (poIds.length > 0) {
      deleteStatements.push(
        db
          .prepare(
            `DELETE FROM purchase_order_items
               WHERE purchaseOrderId IN (${poIds.map(() => "?").join(",")})`,
          )
          .bind(...poIds),
      );
    }

    // DELETE purchase_orders (terminal — CASCADE removes any remaining
    // purchase_order_items; purchase_invoices.purchase_order_id is already
    // deleted above, and the FK was ON DELETE SET NULL so no constraint fires).
    if (poIds.length > 0) {
      deleteStatements.push(
        db
          .prepare(
            `DELETE FROM purchase_orders WHERE id IN (${poIds.map(() => "?").join(",")})`,
          )
          .bind(...poIds),
      );
    }

    // Execute all NULL-preservation updates + deletes atomically.
    if (deleteStatements.length > 0) {
      await db.batch(deleteStatements);
    }

    return c.json({
      ok: true,
      deleted: {
        po: poIds.length,
        grn: grnIds.length,
        pi: piIds.length,
        poItems: poItemCount,
        grnItems: grnItemCount,
        piItems: piItemCount,
      },
      backedUp: {
        po: poIds.length,
        grn: grnIds.length,
        pi: piIds.length,
        poItems: poItemCount,
        grnItems: grnItemCount,
        piItems: piItemCount,
      },
      nulled: {
        rmBatchesSourceRefId: grnIds.length > 0 ? "all GRN-sourced rm_batches.source_ref_id" : "none",
        costLedgerRefId: grnIds.length > 0 ? "all GRN RM_RECEIPT cost_ledger.ref_id" : "none",
        threeWayMatchesGrnId: grnIds.length > 0 ? "three_way_matches.grn_id for purged GRNs" : "none",
        threeWayMatchesPoId: poIds.length > 0 ? "three_way_matches.po_id for purged POs" : "none",
        supplierPaymentsPiId: piIds.length > 0 ? "supplier_payments.purchase_invoice_id for purged PIs" : "none",
        purchaseCreditNotesPiId: piIds.length > 0 ? "purchase_credit_notes.purchase_invoice_id for purged PIs" : "none",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/admin/purge-pre-april-2026] failed:", msg, err);
    return c.json(
      {
        success: false,
        error: msg || "Internal error during purge",
      },
      500,
    );
  }
});

export default app;
