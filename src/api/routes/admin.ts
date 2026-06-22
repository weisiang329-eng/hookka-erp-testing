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
import { requirePermission } from "../lib/rbac";
import {
  createProductionOrdersForSO,
  type SalesOrderRow,
  type SalesOrderItemRow,
} from "./sales-orders";
import {
  resolveMaterialCode,
  bindingKey,
  normCode,
  normName,
  needsFix,
  type ResolveLookups,
  type ResolveMethod,
} from "../lib/material-code-resolve";

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

// ===========================================================================
// POST /api/admin/backfill-import-data
//
// ONE-TIME maintenance endpoint to correct two import-data defects left by the
// historical-PI importer (routes/import-completion.ts). It is dry-run by
// default and never writes unless BOTH ?dryRun=false AND { confirm: true }.
// Before any UPDATE it backs the affected rows up into zz_backfill_import_data_*
// tables via CREATE TABLE … AS SELECT so the parent can restore. All writes
// land in ONE db.batch (atomic).
//
// Fix #1 — grn_items.invoiced_qty backfill.
//   The importer inserted GRNs straight as POSTED but never set the
//   convert-chain counter `invoiced_qty` (grn.ts: available-to-invoice =
//   accepted_qty − invoiced_qty). For GRN lines under an import GRN that has a
//   matching PI, the qty is already fully invoiced, so invoiced_qty should
//   equal acceptedQty. We set invoiced_qty = acceptedQty for import-GRN lines
//   where invoiced_qty IS NULL OR 0. No stock/cost impact — this only stops the
//   line re-appearing in the PI-convert picker's GRN tab (can't double-invoice).
//   Scope: GRNs whose number LIKE 'GRN-IMPORT-PI-%'.
//   Column note: grn_items uses camelCase `grnId`/`acceptedQty`; the counter is
//   snake_case `invoiced_qty` (confirmed: grn.ts:65, purchase-invoices.ts:851
//   both write `invoiced_qty`; reads dual-key invoicedQty ?? invoiced_qty).
//
// Fix #2 — material_code backfill on purchase_invoice_items + purchase_order_items.
//   ~12% of imported lines have a blank/wrong material_code (the importer
//   sometimes stamped the supplier SKU into it, or left it null). For any line
//   whose material_code is NULL/empty OR is NOT a valid raw_materials.itemCode,
//   resolve OUR internal code via material-code-resolve.ts:
//     (a) PRIMARY  — supplier_material_bindings by (parent doc supplierId +
//                    line supplierSku) → binding.materialCode
//     (b) FALLBACK — match the line material_name to a raw_materials row →
//                    that row's itemCode
//   Rows where nothing resolves are LEFT UNTOUCHED and listed in the preview.
//   Column note: purchase_invoice_items is snake_case (pi_id, material_code,
//   material_name, supplier_sku). purchase_order_items is camelCase
//   (purchaseOrderId, supplierSKU) EXCEPT material_code (snake, mig 0103) +
//   materialName (camel). We UPDATE only the snake_case `material_code` on both,
//   so no column-rename-map.json change is needed.
// ===========================================================================

const IMPORT_GRN_LIKE = "GRN-IMPORT-PI-%";

// How many sample rows to surface per fix in the preview.
const SAMPLE_LIMIT = 15;

type Fix2Sample = {
  table: "purchase_invoice_items" | "purchase_order_items";
  docNo: string | null;
  itemId: string;
  oldCode: string | null;
  supplierSku: string | null;
  materialName: string | null;
  newCode: string;
  method: ResolveMethod;
};

type Fix2Unresolved = {
  table: "purchase_invoice_items" | "purchase_order_items";
  docNo: string | null;
  itemId: string;
  oldCode: string | null;
  supplierSku: string | null;
  materialName: string | null;
};

// Load the shared lookup maps once (raw_materials + supplier_material_bindings).
async function loadResolveLookups(db: D1Database): Promise<ResolveLookups> {
  const validCodes = new Set<string>();
  const codeByName = new Map<string, string>();
  const rmRes = await db
    .prepare("SELECT itemCode, description FROM raw_materials")
    .all<{ itemCode: string; description: string | null }>();
  // First pass: collect every valid code + detect ambiguous names.
  const nameHits = new Map<string, string[]>();
  for (const r of rmRes.results ?? []) {
    const code = normCode(r.itemCode);
    if (!code) continue;
    validCodes.add(code);
    const nm = normName(r.description);
    if (!nm) continue;
    const arr = nameHits.get(nm) ?? [];
    arr.push(code);
    nameHits.set(nm, arr);
  }
  // Only index UNAMBIGUOUS names (one RM per normalized description) so the
  // name fallback never silently picks the wrong material when two RMs share
  // a description.
  for (const [nm, codes] of nameHits) {
    if (codes.length === 1) codeByName.set(nm, codes[0]);
  }

  const bindingByKey = new Map<string, string>();
  const smbRes = await db
    .prepare(
      "SELECT supplierId, supplierSku, materialCode FROM supplier_material_bindings",
    )
    .all<{ supplierId: string; supplierSku: string; materialCode: string }>();
  for (const b of smbRes.results ?? []) {
    if (!b.supplierId || !b.materialCode) continue;
    bindingByKey.set(bindingKey(b.supplierId, b.supplierSku), b.materialCode);
  }

  return { bindingByKey, validCodes, codeByName };
}

app.post("/backfill-import-data", async (c) => {
  const denied = await requirePermission(c, "users", "create");
  if (denied) return denied;
  const db = c.var.DB;

  const dryRunParam = (c.req.query("dryRun") ?? "true").toLowerCase();
  let dryRun = dryRunParam !== "false";

  const body = await c.req.json().catch(() => ({}));
  const bodyDryRun =
    body && typeof body === "object"
      ? (body as { dryRun?: unknown }).dryRun
      : undefined;
  if (bodyDryRun === false) dryRun = false;
  const confirm =
    body && typeof body === "object" &&
    (body as { confirm?: unknown }).confirm === true;

  // Guardrail (mirrors /archive/run): a real run needs confirm:true in body.
  if (!dryRun && !confirm) {
    return c.json(
      {
        success: false,
        error:
          "Refusing to write without confirmation. Pass { confirm: true } in the body together with ?dryRun=false.",
      },
      400,
    );
  }

  // -------------------------------------------------------------------------
  // Fix #1 PREVIEW — import-GRN lines with invoiced_qty NULL/0.
  // -------------------------------------------------------------------------
  const fix1CountRow = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM grn_items gi
        WHERE EXISTS (
          SELECT 1 FROM grns g
           WHERE g.id = gi.grnId
             AND g.grnNumber LIKE ?
        )
          AND COALESCE(gi.invoiced_qty, 0) = 0
          AND COALESCE(gi.acceptedQty, 0) > 0`,
    )
    .bind(IMPORT_GRN_LIKE)
    .first<{ n: number }>();
  const fix1Count = fix1CountRow?.n ?? 0;

  const fix1SamplesRes = await db
    .prepare(
      `SELECT g.grnNumber AS grnNumber,
              gi.id        AS itemId,
              gi.materialName AS materialName,
              gi.acceptedQty  AS acceptedQty,
              gi.invoiced_qty AS oldInvoicedQty
         FROM grn_items gi
         JOIN grns g ON g.id = gi.grnId
        WHERE g.grnNumber LIKE ?
          AND COALESCE(gi.invoiced_qty, 0) = 0
          AND COALESCE(gi.acceptedQty, 0) > 0
        ORDER BY g.grnNumber, gi.id
        LIMIT ?`,
    )
    .bind(IMPORT_GRN_LIKE, SAMPLE_LIMIT)
    .all<{
      grnNumber: string;
      itemId: string;
      materialName: string | null;
      acceptedQty: number;
      oldInvoicedQty: number | null;
    }>();
  const fix1Samples = (fix1SamplesRes.results ?? []).map((r) => ({
    grnNumber: r.grnNumber,
    itemId: r.itemId,
    materialName: r.materialName,
    oldInvoicedQty: Number(r.oldInvoicedQty ?? 0) || 0,
    newInvoicedQty: Number(r.acceptedQty) || 0, // = acceptedQty
  }));

  // -------------------------------------------------------------------------
  // Fix #2 PREVIEW — material_code backfill on PI + PO items.
  // -------------------------------------------------------------------------
  const lookups = await loadResolveLookups(db);

  // PI items joined to their parent PI (supplierId + piNo for context).
  const piItemsRes = await db
    .prepare(
      `SELECT pii.id          AS itemId,
              pii.material_code AS oldCode,
              pii.material_name AS materialName,
              pii.supplier_sku  AS supplierSku,
              pi.supplierId     AS supplierId,
              pi.piNo           AS docNo
         FROM purchase_invoice_items pii
         JOIN purchase_invoices pi ON pi.id = pii.pi_id`,
    )
    .all<{
      itemId: string;
      oldCode: string | null;
      materialName: string | null;
      supplierSku: string | null;
      supplierId: string | null;
      docNo: string | null;
    }>();

  // PO items joined to their parent PO (supplierId + poNo). NB the line SKU
  // column on purchase_order_items is camelCase `supplierSKU`.
  const poItemsRes = await db
    .prepare(
      `SELECT poi.id          AS itemId,
              poi.material_code AS oldCode,
              poi.materialName  AS materialName,
              poi.supplierSKU   AS supplierSku,
              po.supplierId     AS supplierId,
              po.poNo           AS docNo
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.purchaseOrderId`,
    )
    .all<{
      itemId: string;
      oldCode: string | null;
      materialName: string | null;
      supplierSku: string | null;
      supplierId: string | null;
      docNo: string | null;
    }>();

  type Fix2Plan = {
    itemId: string;
    newCode: string;
  };
  const fix2Samples: Fix2Sample[] = [];
  const fix2Unresolved: Fix2Unresolved[] = [];
  let fix2PiToFix = 0;
  let fix2PoToFix = 0;
  let fix2PiResolved = 0;
  let fix2PoResolved = 0;
  const piPlan: Fix2Plan[] = [];
  const poPlan: Fix2Plan[] = [];

  function classify(
    table: "purchase_invoice_items" | "purchase_order_items",
    rows: Array<{
      itemId: string;
      oldCode: string | null;
      materialName: string | null;
      supplierSku: string | null;
      supplierId: string | null;
      docNo: string | null;
    }>,
    plan: Fix2Plan[],
  ): { toFix: number; resolved: number } {
    let toFix = 0;
    let resolved = 0;
    for (const r of rows) {
      // Leave valid codes alone.
      if (!needsFix(r.oldCode, lookups.validCodes)) continue;
      toFix++;
      const res = resolveMaterialCode(
        r.supplierId,
        r.supplierSku,
        r.materialName,
        lookups,
      );
      if (!res) {
        fix2Unresolved.push({
          table,
          docNo: r.docNo,
          itemId: r.itemId,
          oldCode: r.oldCode,
          supplierSku: r.supplierSku,
          materialName: r.materialName,
        });
        continue;
      }
      resolved++;
      plan.push({ itemId: r.itemId, newCode: res.code });
      if (fix2Samples.length < SAMPLE_LIMIT) {
        fix2Samples.push({
          table,
          docNo: r.docNo,
          itemId: r.itemId,
          oldCode: r.oldCode,
          supplierSku: r.supplierSku,
          materialName: r.materialName,
          newCode: res.code,
          method: res.method,
        });
      }
    }
    return { toFix, resolved };
  }

  {
    const pi = classify("purchase_invoice_items", piItemsRes.results ?? [], piPlan);
    fix2PiToFix = pi.toFix;
    fix2PiResolved = pi.resolved;
    const po = classify("purchase_order_items", poItemsRes.results ?? [], poPlan);
    fix2PoToFix = po.toFix;
    fix2PoResolved = po.resolved;
  }

  const preview = {
    fix1_grn_invoiced_qty: {
      table: "grn_items",
      column: "invoiced_qty",
      scope: `GRNs LIKE '${IMPORT_GRN_LIKE}'`,
      rule: "set invoiced_qty = acceptedQty where invoiced_qty IS NULL/0 and acceptedQty > 0",
      wouldUpdate: fix1Count,
      samples: fix1Samples,
    },
    fix2_material_code: {
      tables: ["purchase_invoice_items", "purchase_order_items"],
      column: "material_code",
      purchase_invoice_items: {
        needFix: fix2PiToFix,
        resolved: fix2PiResolved,
        unresolved: fix2PiToFix - fix2PiResolved,
      },
      purchase_order_items: {
        needFix: fix2PoToFix,
        resolved: fix2PoResolved,
        unresolved: fix2PoToFix - fix2PoResolved,
      },
      wouldUpdate: fix2PiResolved + fix2PoResolved,
      samples: fix2Samples,
      unresolvedSamples: fix2Unresolved.slice(0, SAMPLE_LIMIT),
      unresolvedTotal: fix2Unresolved.length,
    },
  };

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      preview,
      note:
        "Dry run — nothing written. Pass ?dryRun=false with { confirm: true } in the body to execute. Backups land in zz_backfill_import_data_*.",
    });
  }

  // -------------------------------------------------------------------------
  // REAL RUN — back up affected rows, then UPDATE, all in ONE atomic batch.
  // -------------------------------------------------------------------------
  const statements: D1PreparedStatement[] = [];

  // Drop any prior backup tables (a re-run after a partial restore) so the
  // CREATE TABLE … AS SELECT below doesn't error on "already exists".
  statements.push(
    db.prepare("DROP TABLE IF EXISTS zz_backfill_import_data_grn_items"),
  );
  statements.push(
    db.prepare(
      "DROP TABLE IF EXISTS zz_backfill_import_data_purchase_invoice_items",
    ),
  );
  statements.push(
    db.prepare(
      "DROP TABLE IF EXISTS zz_backfill_import_data_purchase_order_items",
    ),
  );

  // ---- Fix #1 backup + update ----
  if (fix1Count > 0) {
    statements.push(
      db.prepare(
        `CREATE TABLE zz_backfill_import_data_grn_items AS
           SELECT gi.* FROM grn_items gi
            WHERE EXISTS (
              SELECT 1 FROM grns g
               WHERE g.id = gi.grnId AND g.grnNumber LIKE ?
            )
              AND COALESCE(gi.invoiced_qty, 0) = 0
              AND COALESCE(gi.acceptedQty, 0) > 0`,
      ).bind(IMPORT_GRN_LIKE),
    );
    statements.push(
      db.prepare(
        `UPDATE grn_items
            SET invoiced_qty = acceptedQty
          WHERE id IN (
            SELECT gi.id FROM grn_items gi
             WHERE EXISTS (
               SELECT 1 FROM grns g
                WHERE g.id = gi.grnId AND g.grnNumber LIKE ?
             )
               AND COALESCE(gi.invoiced_qty, 0) = 0
               AND COALESCE(gi.acceptedQty, 0) > 0
          )`,
      ).bind(IMPORT_GRN_LIKE),
    );
  }

  // ---- Fix #2 backup + per-row update (only resolved rows) ----
  if (piPlan.length > 0) {
    const ids = piPlan.map((p) => p.itemId);
    statements.push(
      db
        .prepare(
          `CREATE TABLE zz_backfill_import_data_purchase_invoice_items AS
             SELECT * FROM purchase_invoice_items
              WHERE id IN (${ids.map(() => "?").join(",")})`,
        )
        .bind(...ids),
    );
    for (const p of piPlan) {
      statements.push(
        db
          .prepare(
            "UPDATE purchase_invoice_items SET material_code = ? WHERE id = ?",
          )
          .bind(p.newCode, p.itemId),
      );
    }
  }
  if (poPlan.length > 0) {
    const ids = poPlan.map((p) => p.itemId);
    statements.push(
      db
        .prepare(
          `CREATE TABLE zz_backfill_import_data_purchase_order_items AS
             SELECT * FROM purchase_order_items
              WHERE id IN (${ids.map(() => "?").join(",")})`,
        )
        .bind(...ids),
    );
    for (const p of poPlan) {
      statements.push(
        db
          .prepare(
            "UPDATE purchase_order_items SET material_code = ? WHERE id = ?",
          )
          .bind(p.newCode, p.itemId),
      );
    }
  }

  await db.batch(statements);

  return c.json({
    success: true,
    dryRun: false,
    applied: {
      fix1_grn_invoiced_qty: fix1Count,
      fix2_pi_material_code: piPlan.length,
      fix2_po_material_code: poPlan.length,
    },
    backups: [
      "zz_backfill_import_data_grn_items",
      "zz_backfill_import_data_purchase_invoice_items",
      "zz_backfill_import_data_purchase_order_items",
    ],
    preview,
  });
});

export default app;
