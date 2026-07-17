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
import { getOrgId } from "../lib/tenant";
import { resolveMaintenanceConfigAsOf } from "./maintenance-config";
import {
  createProductionOrdersForSO,
  type SalesOrderRow,
  type SalesOrderItemRow,
} from "./sales-orders";
import { deriveSpecialOrderSurchargeSen } from "../../lib/special-order-surcharge";
import { loadSpecialsConfig } from "../lib/specials-config";
import { emitAudit } from "../lib/audit";
import { ensureInvoicePoLinkColumn } from "../lib/invoice-po-link";

const app = new Hono<Env>();

// Age threshold for cold data — 45 days (owner 2026-07-03, lowered from 90 to
// demote completed/closed records to the archive tables sooner and keep the
// hot working set smaller as data grows). Only COMPLETED POs / CLOSED-CANCELLED
// SOs that haven't been touched in this many days become archivable.
const COLD_DAYS = 45;

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

  // HARD-DISABLED per owner decision 2026-07-03: most read paths (search, detail,
  // dashboards, accounting) and several write paths (invoice line lookup, cost
  // cascade, status recompute) only see the hot tables, so a real archive run
  // makes rows invisible and lets writes silently no-op — and there is no
  // unarchive endpoint. Dry-run stays available for counting. Re-enabling
  // requires removing this guard AND making every consumer archive-aware first.
  if (!dryRun) {
    console.error("[archive] real run blocked — hard-disabled per owner decision 2026-07-03");
    return c.json(
      {
        success: false,
        error:
          "Archive execution is disabled. Search/detail/reporting and several write paths do not read the archive tables yet, so archived rows would disappear from the app. Dry-run (?dryRun=true) is still available.",
      },
      410,
    );
  }

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

  // Real run: build the regeneration statements FIRST (read-only — a broken
  // BOM throws here before we touch anything), THEN commit the wipe + the
  // re-INSERTs in ONE atomic db.batch. db.batch wraps every statement in a
  // single Postgres transaction (supabase-compat.ts `sql.begin`), so a mid-
  // rebuild failure rolls the whole thing back — the SO never ends up wiped
  // of production with no replacement (the all-or-nothing money/cascade
  // rule). This mirrors the correct teardown+rebuild pattern in
  // sales-orders.ts (Option D re-explosion) and import-completion.ts, and
  // fixes the earlier two-transaction gap where the wipe committed before the
  // rebuild statements were even built (a throw left the SO stripped).
  //
  // forceRebuild:true so the builder's PO-level "preExisting" idempotency
  // guard does NOT bail on the about-to-be-deleted production_orders — the
  // DELETE runs FIRST inside the same batch, freeing the deterministic poIds
  // before the INSERTs land.
  let genResult: Awaited<ReturnType<typeof createProductionOrdersForSO>>;
  try {
    genResult = await createProductionOrdersForSO(db, so, items, {
      forceRebuild: true,
    });
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

  // job_cards cascade via FK on the production_orders DELETE.
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

  // Wipe + re-INSERT in ONE transaction. Even when genResult produced no
  // statements (SO legitimately has nothing to build), still run the wipe so
  // the maintenance intent (clear stale POs) is honoured.
  await db.batch([...wipeStmts, ...genResult.statements]);

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
// POST /api/admin/ensure-perf-indexes — apply the 2026-07-14 audit's index batch.
//
// Migration files (0037/0047_perf_indexes) are INERT on deploy, so hot-query
// indexes never reached prod. This applies the audited set at runtime, each
// CREATE INDEX IF NOT EXISTS in its OWN try/catch so a wrong column name (the
// tables mix snake_case + camelCase) or an already-existing index is logged and
// SKIPPED, never fatal. Returns per-statement created/skipped/failed so the
// operator sees exactly what landed. Idempotent — safe to re-run. SUPER_ADMIN.
// Column names verified against the routes' SELECT/WHERE usage before listing.
// ---------------------------------------------------------------------------
const PERF_INDEXES: string[] = [
  // Procurement — purchase_invoices/_items had ZERO indexes (audit #13).
  "CREATE INDEX IF NOT EXISTS idx_purchase_invoice_items_pi ON purchase_invoice_items(pi_id)",
  "CREATE INDEX IF NOT EXISTS idx_purchase_invoices_status ON purchase_invoices(status)",
  "CREATE INDEX IF NOT EXISTS idx_purchase_invoices_supplier ON purchase_invoices(supplierId)",
  // Service — sales_orders.caseid scanned on every case load (audit #14).
  "CREATE INDEX IF NOT EXISTS idx_sales_orders_caseid ON sales_orders(caseid)",
  // List ORDER BY created_at DESC — composite with orgId so it is an index scan.
  "CREATE INDEX IF NOT EXISTS idx_sales_orders_org_created ON sales_orders(orgId, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_invoices_org_created ON invoices(orgId, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_do_org_created ON delivery_orders(orgId, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_po_org_created ON purchase_orders(orgId, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_consignment_orders_created ON consignment_orders(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_payment_records_org_date ON payment_records(orgId, date DESC, id DESC)",
  // Delivery / consignment child + FK joins.
  "CREATE INDEX IF NOT EXISTS idx_doi_org ON delivery_order_items(orgId)",
  "CREATE INDEX IF NOT EXISTS idx_ci_org ON consignment_items(orgId)",
  // Production hot columns (join / filter targets on the shared PO endpoint).
  "CREATE INDEX IF NOT EXISTS idx_prod_po_productCode ON production_orders(productCode)",
  "CREATE INDEX IF NOT EXISTS idx_prod_po_created ON production_orders(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_prod_po_companySOId ON production_orders(companySOId)",
  "CREATE INDEX IF NOT EXISTS idx_prod_po_companyCOId ON production_orders(companyCOId)",
  "CREATE INDEX IF NOT EXISTS idx_jc_org_dept ON job_cards(orgId, departmentCode)",
  // Products ACTIVE filter + sort.
  "CREATE INDEX IF NOT EXISTS idx_products_org_status_code ON products(orgId, status, code)",
  // Service / R&D FK joins.
  "CREATE INDEX IF NOT EXISTS idx_service_cases_status ON service_cases(status)",
  "CREATE INDEX IF NOT EXISTS idx_service_orders_caseid ON service_orders(caseId)",
  "CREATE INDEX IF NOT EXISTS idx_rd_material_issuances_project ON rd_material_issuances(projectId)",
  "CREATE INDEX IF NOT EXISTS idx_rd_labour_hours_project ON rd_labour_hours(projectId)",
  // Snapshot-freshness probe columns (dashboard/report freshness MAX(updated_at)).
  // NB: sales_order_items + invoice_items have NO updated_at column (verified —
  // delivery-snapshot.ts notes it), and cost_ledger's timestamp column is `date`
  // (not created_at) — the first ensure-run on staging caught all three via the
  // per-statement try/catch. Corrected here for the prod run.
  "CREATE INDEX IF NOT EXISTS idx_jc_updated ON job_cards(updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_whe_created ON working_hour_entries(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_cost_ledger_date ON cost_ledger(\"date\")",
];

app.post("/ensure-perf-indexes", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  const created: string[] = [];
  const failed: Array<{ stmt: string; error: string }> = [];
  for (const stmt of PERF_INDEXES) {
    try {
      await c.var.DB.prepare(stmt).run();
      created.push(stmt.replace(/^CREATE INDEX IF NOT EXISTS /, "").split(" ON ")[0]);
    } catch (e) {
      failed.push({ stmt, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return c.json({
    success: true,
    attempted: PERF_INDEXES.length,
    okCount: created.length,
    failCount: failed.length,
    created,
    failed,
  });
});

// POST /api/admin/dedupe-invoices?dryRun=true — duplicate-invoice cleanup PLANNER.
// Groups NON-CANCELLED invoices by deliveryOrderId; a group of >=2 is a duplicate
// candidate. Verifies it is a 100% duplicate (identical item signature across the
// group AND each invoice's item count == the DO's item count) so a legit partial /
// differently-priced invoice is NEVER touched. Keeps ONE (a paid one if present,
// else the earliest by invoiceNo); the rest are extras. Only UNPAID extras are
// cancel-eligible; PAID extras are flagged, never auto-cancelled.
//
// dryRun (default true) reports the plan only. Execution (status->CANCELLED with the
// GL reversal + AR reversal) is intentionally NOT wired here — it must reuse the
// invoice PUT :id void path exactly (shared cancel fn), added carefully as a
// follow-up. For now this endpoint is READ-ONLY: it produces the exact plan the
// operator confirms before the cancellations run through the proven PUT path.
app.post("/dedupe-invoices", async (c) => {
  const denied = await requirePermission(c, "users", "create");
  if (denied) return denied;
  const db = c.var.DB;
  const orgId = getOrgId(c);
  const dryRun = (c.req.query("dryRun") ?? "true").toLowerCase() !== "false";

  // 1. All non-cancelled invoices for the org that are linked to a DO.
  const invRes = await db
    .prepare(
      `SELECT id, invoiceNo, deliveryOrderId, doNo, totalSen, paidAmount, status
         FROM invoices
        WHERE orgId = ? AND status != 'CANCELLED'
          AND deliveryOrderId IS NOT NULL AND deliveryOrderId != ''`,
    )
    .bind(orgId)
    .all<{
      id: string;
      invoiceNo: string;
      deliveryOrderId: string;
      doNo: string | null;
      totalSen: number;
      paidAmount: number | null;
      status: string;
    }>();
  const invoices = invRes.results ?? [];

  // 2. Group by DO; keep only groups with >=2 active invoices.
  const byDo = new Map<string, typeof invoices>();
  for (const iv of invoices) {
    const arr = byDo.get(iv.deliveryOrderId);
    if (arr) arr.push(iv);
    else byDo.set(iv.deliveryOrderId, [iv]);
  }
  const isPaid = (iv: (typeof invoices)[number]) =>
    (iv.paidAmount ?? 0) > 0 || iv.status === "PAID" || iv.status === "PARTIAL_PAID";
  const itemSig = async (invoiceId: string) => {
    const r = await db
      .prepare(
        "SELECT productCode, quantity, unitPriceSen FROM invoice_items WHERE invoiceId = ?",
      )
      .bind(invoiceId)
      .all<{ productCode: string; quantity: number; unitPriceSen: number }>();
    const rows = r.results ?? [];
    const sig = rows
      .map((x) => `${x.productCode}:${x.quantity}@${x.unitPriceSen}`)
      .sort()
      .join("|");
    return { sig, count: rows.length };
  };

  const plan: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  let cancelCount = 0;
  let cancelSen = 0;
  let paidExtraCount = 0;

  for (const [deliveryOrderId, group] of byDo) {
    if (group.length < 2) continue;
    // DO's own item count (the standard).
    const doCntRow = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM delivery_order_items WHERE deliveryOrderId = ?",
      )
      .bind(deliveryOrderId)
      .first<{ n: number }>();
    const doItemCount = Number(doCntRow?.n ?? 0);
    // Per-invoice signatures.
    const sigs = await Promise.all(
      group.map(async (iv) => ({ iv, ...(await itemSig(iv.id)) })),
    );
    const allIdentical = sigs.every((s) => s.sig === sigs[0].sig);
    const allMatchDO = sigs.every((s) => s.count === doItemCount);
    const doNo = group[0].doNo ?? deliveryOrderId;
    // SAFETY GATE: only a group that is 100% identical AND matches the DO item
    // count is a true duplicate. Anything else is left ALONE for manual review.
    if (!allIdentical || !allMatchDO) {
      skipped.push({
        doNo,
        reason: !allIdentical
          ? "invoices differ (not 100% duplicate)"
          : "invoice item count != DO item count",
        doItemCount,
        invoices: sigs.map((s) => ({ no: s.iv.invoiceNo, items: s.count, status: s.iv.status })),
      });
      continue;
    }
    // Keep a paid one if any (its cash is real), else the earliest invoiceNo.
    const keep =
      group.find(isPaid) ??
      group.slice().sort((a, b) => a.invoiceNo.localeCompare(b.invoiceNo))[0];
    const extras = group.filter((iv) => iv !== keep);
    const cancelExtras = extras.filter((iv) => !isPaid(iv));
    const paidExtras = extras.filter(isPaid);
    cancelExtras.forEach((iv) => {
      cancelCount++;
      cancelSen += iv.totalSen;
    });
    paidExtraCount += paidExtras.length;
    plan.push({
      doNo,
      doItemCount,
      keep: keep.invoiceNo,
      cancel: cancelExtras.map((iv) => ({ id: iv.id, no: iv.invoiceNo, totalRM: iv.totalSen / 100 })),
      paidExtrasNeedManualReview: paidExtras.map((iv) => ({ no: iv.invoiceNo, status: iv.status })),
    });
  }

  return c.json({
    success: true,
    dryRun,
    note: dryRun
      ? "READ-ONLY plan. Nothing was changed. Verified: every 'cancel' target is a 100% duplicate (identical items + count == DO)."
      : "Execution is not wired in this endpoint yet — run the cancellations through the invoice PUT :id void path. This response is still the plan.",
    summary: {
      duplicateDOs: plan.length,
      invoicesToCancel_unpaid: cancelCount,
      excessBillingRM: (cancelSen / 100).toLocaleString(),
      paidExtras_needManualReview: paidExtraCount,
      skippedGroups_notPureDuplicate: skipped.length,
    },
    plan,
    skipped,
  });
});

// POST /api/admin/backfill-so-prices?dryRun=true — total-height under-billing PLANNER.
// The server unit-price recompute used to DROP totalHeightPriceSen (fixed forward in
// sales-orders.ts calculateUnitPrice calls). This finds EXISTING under-billed lines:
// for each non-service SO line with a height config (gap+divan+leg > 0), re-derives the
// total-height surcharge from the maintenance config EFFECTIVE AS OF the SO's date
// (customer scope first, else master — same precedence as the live quote) and compares.
// A line is under-billed iff its stored unit price == base+divan+leg+special (i.e. the
// total-height surcharge was dropped) AND the config has a >0 surcharge for that height.
// READ-ONLY: reports the exact per-line correction to confirm before the re-price runs.
app.post("/backfill-so-prices", async (c) => {
  const denied = await requirePermission(c, "users", "create");
  if (denied) return denied;
  const db = c.var.DB;
  const orgId = getOrgId(c);
  const dryRun = (c.req.query("dryRun") ?? "true").toLowerCase() !== "false";

  const res = await db
    .prepare(
      `SELECT soi.id, soi.salesOrderId, soi.lineNo, soi.productCode,
              soi.gapInches, soi.divanHeightInches, soi.legHeightInches,
              soi.basePriceSen, soi.divanPriceSen, soi.legPriceSen,
              soi.specialOrderPriceSen, soi.unitPriceSen, soi.quantity,
              so.customerId, so.isServiceOrder, so.companySOId, so.created_at
         FROM sales_order_items soi
         JOIN sales_orders so ON so.id = soi.salesOrderId
        WHERE so.orgId = ?
          AND (COALESCE(soi.gapInches,0) + COALESCE(soi.divanHeightInches,0)
               + COALESCE(soi.legHeightInches,0)) > 0`,
    )
    .bind(orgId)
    .all<{
      id: string; salesOrderId: string; lineNo: number; productCode: string;
      gapInches: number | null; divanHeightInches: number | null; legHeightInches: number | null;
      basePriceSen: number | null; divanPriceSen: number | null; legPriceSen: number | null;
      specialOrderPriceSen: number | null; unitPriceSen: number | null; quantity: number | null;
      customerId: string | null; isServiceOrder: unknown; companySOId: string | null; created_at: string | null;
    }>();

  // Resolve maintenance-config totalHeights[] as of a date, customer-scope first then
  // master. Cached per scope|date so a busy period is one query, not one per line.
  const cache = new Map<string, Array<{ value: string; priceSen: number }>>();
  const thTiers = async (customerId: string | null, asOf: string) => {
    const scopes = customerId ? [`customer:${customerId}`, "master"] : ["master"];
    for (const scope of scopes) {
      const key = `${scope}|${asOf}`;
      let arr = cache.get(key);
      if (arr === undefined) {
        const r = await resolveMaintenanceConfigAsOf(db, scope, asOf);
        const th = (r.config as { totalHeights?: unknown } | null)?.totalHeights;
        arr = Array.isArray(th)
          ? (th.filter((x) => x && typeof x === "object" && "value" in x && "priceSen" in x) as Array<{ value: string; priceSen: number }>)
          : [];
        cache.set(key, arr);
      }
      if (arr.length) return arr;
    }
    return [] as Array<{ value: string; priceSen: number }>;
  };

  const affected: Array<Record<string, unknown>> = [];
  let totalDeltaSen = 0;
  for (const line of res.results ?? []) {
    if (line.isServiceOrder === true || line.isServiceOrder === 1) continue;
    const totalInches =
      (line.gapInches || 0) + (line.divanHeightInches || 0) + (line.legHeightInches || 0);
    const asOf = (line.created_at || "").slice(0, 10) || "9999-12-31";
    const tiers = await thTiers(line.customerId, asOf);
    const correctTh = Number(tiers.find((t) => t.value === `${totalInches}"`)?.priceSen || 0);
    if (correctTh <= 0) continue;
    const base = line.basePriceSen || 0;
    const withoutTh = base + (line.divanPriceSen || 0) + (line.legPriceSen || 0) + (line.specialOrderPriceSen || 0);
    // Under-billed ONLY when the stored unit price is exactly the sum WITHOUT the
    // total-height surcharge (so we never double-add on a line that already has it).
    if ((line.unitPriceSen || 0) === withoutTh) {
      const qty = line.quantity || 0;
      const lineDelta = correctTh * qty;
      totalDeltaSen += lineDelta;
      affected.push({
        so: line.companySOId, line: line.lineNo, product: line.productCode,
        totalHeight: `${totalInches}"`, storedUnitRM: (line.unitPriceSen || 0) / 100,
        correctUnitRM: (withoutTh + correctTh) / 100, surchargeRM: correctTh / 100,
        qty, lineDeltaRM: lineDelta / 100,
      });
    }
  }

  return c.json({
    success: true,
    dryRun,
    note:
      "READ-ONLY. Under-billed = stored unit price == base+divan+leg+special (total-height dropped) AND the maintenance config effective on the SO date has a >0 surcharge for that height. Execution (write corrected unitPriceSen/lineTotalSen + regenerate invoices) is the careful follow-up — owner re-sends invoices.",
    summary: {
      underBilledLines: affected.length,
      totalUnderBilledRM: (totalDeltaSen / 100).toLocaleString(),
    },
    affected: affected.slice(0, 1000),
  });
});

// POST /api/admin/backfill-invoice-prices?dryRun=true — RE-DERIVES each existing
// (non-cancelled) invoice through the SYSTEM'S OWN pricer (priceForItem) with a
// corrected SO-line price index, and reports the exact per-line unit correction.
//
// Why re-derivation, not (product,price) matching: invoices are priced by
// priceForItem(idx, productionOrderId → (soId, productCode, sizeCode, fabricCode))
// with FIRST-WINS per key — it is NOT height-aware per line, so two SO lines that
// share (product,size,fabric) but differ in height collapse to one price. Matching
// invoice lines by (product,unitPrice) is therefore ambiguous (verified: 26 keys
// map to conflicting surcharges). Re-deriving through priceForItem reproduces EXACTLY
// what the invoice was priced at, so the before/after delta is unambiguous.
//
// SAFETY GATE: an invoice is only planned when its CURRENT lines reproduce byte-for-
// byte from the pre-fix index (same length, same productCode per position, stored
// unit == re-derived-before unit for EVERY line). Any invoice that diverges (a manual
// price-edit, or index drift) is SKIPPED and flagged — never auto-touched.
//
// READ-ONLY. The re-price is applied through the PROVEN PUT /api/invoices/:id
// priceEdits path (GL reverse+repost + AR delta) using the emitted newUnitSen.
app.post("/backfill-invoice-prices", async (c) => {
  const denied = await requirePermission(c, "users", "create");
  if (denied) return denied;
  const db = c.var.DB;
  const orgId = getOrgId(c);
  const { priceForItem } = await import("../lib/do-value");
  const { resolveDoSalesOrderIds } = await import("./delivery-orders");

  // ---- 1. Under-billed SO lines → correction map keyed by SO-line id. ----
  const soRes = await db
    .prepare(
      `SELECT soi.id, soi.salesOrderId, soi.productCode, soi.sizeCode, soi.fabricCode,
              soi.gapInches, soi.divanHeightInches, soi.legHeightInches,
              soi.basePriceSen, soi.divanPriceSen, soi.legPriceSen,
              soi.specialOrderPriceSen, soi.unitPriceSen,
              so.customerId, so.isServiceOrder, so.created_at
         FROM sales_order_items soi
         JOIN sales_orders so ON so.id = soi.salesOrderId
        WHERE so.orgId = ?
          AND (COALESCE(soi.gapInches,0) + COALESCE(soi.divanHeightInches,0)
               + COALESCE(soi.legHeightInches,0)) > 0`,
    )
    .bind(orgId)
    .all<{
      id: string; salesOrderId: string; productCode: string;
      sizeCode: string | null; fabricCode: string | null;
      gapInches: number | null; divanHeightInches: number | null; legHeightInches: number | null;
      basePriceSen: number | null; divanPriceSen: number | null; legPriceSen: number | null;
      specialOrderPriceSen: number | null; unitPriceSen: number | null;
      customerId: string | null; isServiceOrder: unknown; created_at: string | null;
    }>();

  const cache = new Map<string, Array<{ value: string; priceSen: number }>>();
  const thTiers = async (customerId: string | null, asOf: string) => {
    const scopes = customerId ? [`customer:${customerId}`, "master"] : ["master"];
    for (const scope of scopes) {
      const key = `${scope}|${asOf}`;
      let arr = cache.get(key);
      if (arr === undefined) {
        const r = await resolveMaintenanceConfigAsOf(db, scope, asOf);
        const th = (r.config as { totalHeights?: unknown } | null)?.totalHeights;
        arr = Array.isArray(th)
          ? (th.filter((x) => x && typeof x === "object" && "value" in x && "priceSen" in x) as Array<{ value: string; priceSen: number }>)
          : [];
        cache.set(key, arr);
      }
      if (arr.length) return arr;
    }
    return [] as Array<{ value: string; priceSen: number }>;
  };

  const correctionById = new Map<string, number>(); // soLineId → correct unitPriceSen
  const affectedSoIds = new Set<string>();
  for (const line of soRes.results ?? []) {
    if (line.isServiceOrder === true || line.isServiceOrder === 1) continue;
    const totalInches =
      (line.gapInches || 0) + (line.divanHeightInches || 0) + (line.legHeightInches || 0);
    const asOf = (line.created_at || "").slice(0, 10) || "9999-12-31";
    const tiers = await thTiers(line.customerId, asOf);
    const correctTh = Number(tiers.find((t) => t.value === `${totalInches}"`)?.priceSen || 0);
    if (correctTh <= 0) continue;
    const withoutTh =
      (line.basePriceSen || 0) + (line.divanPriceSen || 0) + (line.legPriceSen || 0) + (line.specialOrderPriceSen || 0);
    if ((line.unitPriceSen || 0) === withoutTh) {
      correctionById.set(line.id, withoutTh + correctTh);
      affectedSoIds.add(line.salesOrderId);
    }
  }

  // ---- 2. Build before/after price indexes (replicates loadSoLinePriceIndex, FIRST-
  //         WINS, adding si.id so the correction can be overlaid). ----
  type Idx = {
    poById: Map<string, { salesOrderId: string; productCode: string; sizeCode: string; fabricCode: string }>;
    byFull: Map<string, number>;
    byCode: Map<string, number>;
    byAnyCode: Map<string, number>;
  };
  const poRes = await db
    .prepare("SELECT id, salesOrderId, productCode, sizeCode, fabricCode FROM production_orders WHERE orgId = ?")
    .bind(orgId)
    .all<{ id: string; salesOrderId: string | null; productCode: string | null; sizeCode: string | null; fabricCode: string | null }>();
  const poById = new Map<string, { salesOrderId: string; productCode: string; sizeCode: string; fabricCode: string }>();
  for (const p of poRes.results ?? [])
    poById.set(p.id, { salesOrderId: p.salesOrderId ?? "", productCode: p.productCode ?? "", sizeCode: p.sizeCode ?? "", fabricCode: p.fabricCode ?? "" });
  const siRes = await db
    .prepare(
      `SELECT si.id AS id, si.salesOrderId AS salesOrderId, si.productCode AS productCode,
              si.sizeCode AS sizeCode, si.fabricCode AS fabricCode, si.unitPriceSen AS unitPriceSen
         FROM sales_order_items si JOIN sales_orders s ON s.id = si.salesOrderId
        WHERE s.orgId = ?`,
    )
    .bind(orgId)
    .all<{ id: string; salesOrderId: string | null; productCode: string | null; sizeCode: string | null; fabricCode: string | null; unitPriceSen: number }>();
  const buildIdx = (useCorrection: boolean): Idx => {
    const byFull = new Map<string, number>(), byCode = new Map<string, number>(), byAnyCode = new Map<string, number>();
    for (const si of siRes.results ?? []) {
      const so = si.salesOrderId ?? "", code = si.productCode ?? "";
      const up = useCorrection && correctionById.has(si.id) ? (correctionById.get(si.id) as number) : (si.unitPriceSen || 0);
      const fk = `${so}|${code}|${si.sizeCode ?? ""}|${si.fabricCode ?? ""}`;
      if (!byFull.has(fk)) byFull.set(fk, up);
      const ck = `${so}|${code}`;
      if (!byCode.has(ck)) byCode.set(ck, up);
      if (code && !byAnyCode.has(code)) byAnyCode.set(code, up);
    }
    return { poById, byFull, byCode, byAnyCode };
  };
  const idxBefore = buildIdx(false);
  const idxAfter = buildIdx(true);

  // ---- 3. Re-derive each affected invoice through priceForItem. ----
  const invRes = await db
    .prepare(
      `SELECT id, invoiceNo, status, deliveryOrderId, salesOrderId, totalSen, paidAmount
         FROM invoices
        WHERE orgId = ? AND status != 'CANCELLED'
          AND deliveryOrderId IS NOT NULL AND deliveryOrderId != ''`,
    )
    .bind(orgId)
    .all<{ id: string; invoiceNo: string; status: string; deliveryOrderId: string; salesOrderId: string | null; totalSen: number; paidAmount: number | null }>();

  const plan: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  let totalDeltaSen = 0, lineCount = 0;
  for (const inv of invRes.results ?? []) {
    const soIds = await resolveDoSalesOrderIds(db, inv.deliveryOrderId, inv.salesOrderId);
    if (!soIds.some((s) => affectedSoIds.has(s))) continue; // no affected SO on this invoice's DO
    const doSoId = inv.salesOrderId ?? soIds[0] ?? "";
    const doItemsRes = await db
      .prepare("SELECT productionOrderId, productCode, quantity FROM delivery_order_items WHERE deliveryOrderId = ?")
      .bind(inv.deliveryOrderId)
      .all<{ productionOrderId: string | null; productCode: string | null; quantity: number }>();
    const doItems = doItemsRes.results ?? [];
    const invItemsRes = await db
      .prepare("SELECT id, productCode, quantity, unitPriceSen, discountSen FROM invoice_items WHERE invoiceId = ? ORDER BY rowid")
      .bind(inv.id)
      .all<{ id: string; productCode: string; quantity: number; unitPriceSen: number; discountSen: number | null }>();
    const invItems = invItemsRes.results ?? [];

    // GATE: current invoice must reproduce from the pre-fix index, position-for-position.
    let clean = doItems.length === invItems.length;
    if (clean) {
      for (let i = 0; i < doItems.length; i++) {
        const rb = priceForItem(idxBefore, doItems[i].productionOrderId, doSoId, doItems[i].productCode);
        if ((invItems[i].productCode ?? "") !== (doItems[i].productCode ?? "") || (invItems[i].unitPriceSen || 0) !== rb) {
          clean = false;
          break;
        }
      }
    }
    if (!clean) {
      skipped.push({ invoiceNo: inv.invoiceNo, status: inv.status, reason: "current lines don't match the index (manual edit / drift) — needs manual review" });
      continue;
    }

    const edits: Array<Record<string, unknown>> = [];
    for (let i = 0; i < doItems.length; i++) {
      const ra = priceForItem(idxAfter, doItems[i].productionOrderId, doSoId, doItems[i].productCode);
      const old = invItems[i].unitPriceSen || 0;
      if (ra !== old) {
        const qty = invItems[i].quantity || 0;
        edits.push({
          itemId: invItems[i].id, product: invItems[i].productCode, qty,
          oldUnitSen: old, newUnitSen: ra, discountSen: invItems[i].discountSen || 0,
          lineDeltaRM: ((ra - old) * qty) / 100,
        });
      }
    }
    if (edits.length) {
      const invDelta = edits.reduce((s, e) => s + Number(e.lineDeltaRM) * 100, 0);
      totalDeltaSen += invDelta;
      lineCount += edits.length;
      plan.push({
        invoiceId: inv.id, invoiceNo: inv.invoiceNo, status: inv.status,
        paidRM: (inv.paidAmount || 0) / 100, oldTotalRM: (inv.totalSen || 0) / 100,
        deltaRM: invDelta / 100, newTotalRM: ((inv.totalSen || 0) + invDelta) / 100, edits,
      });
    }
  }

  return c.json({
    success: true,
    dryRun: true,
    note:
      "READ-ONLY. Re-derived through priceForItem (the invoice's own pricer). Apply each edit via PUT /api/invoices/:id { priceEdits:[{id:itemId, baseSen:newUnitSen, divanSen:0, legSen:0, specialSen:0, discountSen}] } — the proven GL reverse+repost + AR-delta path. `skipped` invoices diverge from the index and need manual review.",
    summary: {
      invoicesToReprice: plan.length,
      linesToReprice: lineCount,
      totalUnderBilledRM: (totalDeltaSen / 100).toLocaleString(),
      invoicesSkipped_needManualReview: skipped.length,
    },
    plan,
    skipped,
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/backfill-special-order-surcharge  — DRY-RUN PLANNER (read-only)
//
// One-shot planner for BUG-2026-07-17-002 (scanned customer POs never charged
// the special-order surcharge — the scan clients POST without
// specialOrderPriceSen, so "Divan Full Cover" stored 0 while the same option
// typed by hand charged RM 80). The forward fix is live; this reports the
// EXISTING under-billed rows so the owner can approve the correction.
//
// READ-ONLY BY CONSTRUCTION — there is no write path in this handler at all.
// The owner's ruling is to re-price the old SOs + invoices and re-send the
// invoices himself, but the write is deliberately NOT wired here yet: raising an
// issued invoice's total touches the GL and payment reconciliation, so the plan
// gets reviewed first (this repo's own precedent — the invoice money-path work
// shipped dry-run planners before any write).
//
// Sweeps the WHOLE table in SQL — NOT the paginated list endpoint, which caps at
// 500 rows and produced the first (understated) RM 8,060 estimate.
//
// Response: { success, totals, byOption, plan: [ per-SO … ] }
//   plan[].lines[] carries the exact per-line delta; plan[].invoice carries the
//   invoice status so PAID / SENT ones can be triaged separately (the owner has
//   NOT ruled on paid invoices — do not assume).
// ---------------------------------------------------------------------------
app.get("/backfill-special-order-surcharge", async (c) => {
  const su = requireSuperAdmin(c);
  if (su) return su;
  const db = c.var.DB;

  const cfgSpecials = await loadSpecialsConfig(db);

  // Every SO line that names a special order. We compute the owed surcharge in
  // JS (shared helper = same rule the write path now uses) rather than in SQL,
  // so the combined-cover cap and config overrides can't drift.
  const rows = await db
    .prepare(
      `SELECT i.id AS itemId, i.salesOrderId AS salesOrderId,
              i.productCode AS productCode, i.fabricCode AS fabricCode,
              i.specialOrder AS specialOrder,
              i.specialOrderPriceSen AS specialOrderPriceSen,
              i.basePriceSen AS basePriceSen, i.unitPriceSen AS unitPriceSen,
              i.discountSen AS discountSen, i.lineTotalSen AS lineTotalSen,
              i.quantity AS quantity,
              s.companySOId AS companySOId, s.status AS soStatus,
              s.customerName AS customerName, s.createdAt AS createdAt,
              s.isServiceOrder AS isServiceOrder
         FROM sales_order_items i
         JOIN sales_orders s ON s.id = i.salesOrderId
        WHERE i.specialOrder IS NOT NULL AND i.specialOrder != ''
          -- SERVICE ORDERS ARE FREE BY DESIGN (arch_service_order_pricing — all
          -- SV invoices are RM 0; the form deliberately posts a 0 surcharge and
          -- prices repairs via Base Price instead). The first run of this planner
          -- proposed charging SV-2607-003 RM 640 — a 0 on an SV is CORRECT, not a
          -- missed charge, so they must never enter the backfill.
          AND (s.isServiceOrder IS NULL OR s.isServiceOrder = false)`,
    )
    .all<{
      itemId: string; salesOrderId: string; productCode: string | null;
      fabricCode: string | null; specialOrder: string | null;
      specialOrderPriceSen: number | null; basePriceSen: number | null;
      unitPriceSen: number | null; discountSen: number | null;
      lineTotalSen: number | null; quantity: number | null;
      companySOId: string | null; soStatus: string | null;
      customerName: string | null; createdAt: string | null;
      isServiceOrder: boolean | number | null;
    }>();

  const bySo = new Map<string, {
    salesOrderId: string; companySOId: string; customerName: string;
    soStatus: string; createdAt: string; deltaSen: number;
    lines: Array<Record<string, unknown>>;
  }>();
  const byOption: Record<string, number> = {};
  let linesAffected = 0;
  let totalDeltaSen = 0;

  for (const r of rows.results ?? []) {
    // Belt-and-braces on the SQL guard above: an SV doc number is a service
    // order regardless of what the flag column says. Never propose charging one.
    if (r.isServiceOrder === true || r.isServiceOrder === 1) continue;
    if (String(r.companySOId ?? "").toUpperCase().startsWith("SV-")) continue;
    const charged = Number(r.specialOrderPriceSen) || 0;
    // Trust anything already charged — the typed form priced it correctly, and
    // a deliberate 0 can't be told apart from a missed one HERE, so we only
    // touch rows that owe money AND currently sit at 0.
    if (charged > 0) continue;
    const owed = deriveSpecialOrderSurchargeSen(r.specialOrder, null, cfgSpecials);
    if (owed <= 0) continue;

    const qty = Number(r.quantity) || 1;
    const delta = owed * qty;
    linesAffected++;
    totalDeltaSen += delta;
    for (const t of String(r.specialOrder ?? "").split(/[;,]/).map((s) => s.trim())) {
      if (t) byOption[t] = (byOption[t] || 0) + 1;
    }

    const key = r.salesOrderId;
    if (!bySo.has(key)) {
      bySo.set(key, {
        salesOrderId: key,
        companySOId: r.companySOId ?? "",
        customerName: r.customerName ?? "",
        soStatus: r.soStatus ?? "",
        createdAt: r.createdAt ?? "",
        deltaSen: 0,
        lines: [],
      });
    }
    const g = bySo.get(key)!;
    g.deltaSen += delta;
    g.lines.push({
      itemId: r.itemId,
      productCode: r.productCode,
      fabricCode: r.fabricCode,
      specialOrder: r.specialOrder,
      quantity: qty,
      chargedSen: charged,
      owedSurchargeSen: owed,
      deltaSen: delta,
      unitPriceSen_now: Number(r.unitPriceSen) || 0,
      unitPriceSen_after: (Number(r.unitPriceSen) || 0) + owed,
    });
  }

  // Attach invoice state per SO — the owner re-sends invoices, but a PAID one
  // can't just have its total raised (breaks reconciliation) and he hasn't ruled
  // on those. Surfaced, never assumed.
  const soIds = Array.from(bySo.keys());
  if (soIds.length > 0) {
    const ph = soIds.map(() => "?").join(",");
    const invs = await db
      .prepare(
        `SELECT id, invoiceNo, salesOrderId, status, totalSen, paidAmount
           FROM invoices WHERE salesOrderId IN (${ph})`,
      )
      .bind(...soIds)
      .all<{
        id: string; invoiceNo: string | null; salesOrderId: string;
        status: string | null; totalSen: number | null; paidAmount: number | null;
      }>();
    for (const inv of invs.results ?? []) {
      const g = bySo.get(inv.salesOrderId);
      if (!g) continue;
      (g as unknown as { invoices?: unknown[] }).invoices ??= [];
      ((g as unknown as { invoices: unknown[] }).invoices).push({
        invoiceNo: inv.invoiceNo,
        status: inv.status,
        totalSen: inv.totalSen,
        paidAmount: inv.paidAmount,
        isPaid: Number(inv.paidAmount) > 0,
      });
    }
  }

  const plan = Array.from(bySo.values()).sort((a, b) => b.deltaSen - a.deltaSen);
  const paidCount = plan.filter((p) =>
    ((p as unknown as { invoices?: Array<{ isPaid?: boolean }> }).invoices ?? [])
      .some((i) => i.isPaid),
  ).length;

  return c.json({
    success: true,
    dryRun: true,
    readOnly: true,
    note:
      "Planner only — this endpoint never writes. Scope is the WHOLE sales_order_items table (not the 500-row list cap that produced the first estimate).",
    totals: {
      salesOrdersAffected: plan.length,
      linesAffected,
      totalDeltaSen,
      totalDeltaRM: (totalDeltaSen / 100).toFixed(2),
      salesOrdersWithAPaidInvoice: paidCount,
    },
    byOption,
    plan,
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/backfill-invoice-po-link — one-shot; delete once run.
//
// BUG-2026-07-17-001. New invoices now store invoice_items.production_order_id
// (the DO line they were billed from). Existing invoices don't, so their
// printout still falls back to guessing the customer PO by product code. This
// re-attaches the link to the invoices already in the system.
//
// HOW — and why this is safe rather than another guess:
// invoice lines are generated FROM the DO's lines, in order, minus any line
// that went into a Delivery Return (computeDoInvoiceLines). So for an invoice
// whose surviving DO-line count EQUALS its invoice-line count, position i maps
// to position i. Verified on prod against DO-2606-001 / INV-2606-082: 9 lines,
// every position matching on productCode|fabricCode.
//
// The guard is what makes it honest: each position must ALSO agree on
// productCode|fabricCode. Any invoice where the counts differ or a position
// disagrees is SKIPPED whole and reported — never partially written, never
// guessed. Those keep the old fallback behaviour, exactly as today.
//
// Body: { confirm: true }. Idempotent: only fills rows still NULL.
// ---------------------------------------------------------------------------
app.post("/backfill-invoice-po-link", async (c) => {
  const su = requireSuperAdmin(c);
  if (su) return su;
  const db = c.var.DB;
  const body = await c.req.json().catch(() => ({}));
  const dryRun = (body as { confirm?: unknown })?.confirm !== true;
  // Bounded per call, and RESUMABLE: the write is idempotent (only fills NULLs)
  // and skips invoices already fully linked, so the caller just re-POSTs until
  // invoicesLinked comes back 0. Doing all ~2,000 updates in one request had the
  // client abort mid-flight — and a request that dies halfway through a money
  // table is exactly what we don't want, even when it's only additive.
  const maxInvoices = Math.max(
    1,
    Math.min(500, Number((body as { limit?: unknown })?.limit) || 60),
  );

  await ensureInvoicePoLinkColumn(db);

  const invs = await db
    .prepare(
      `SELECT id, invoiceNo, deliveryOrderId FROM invoices
        WHERE deliveryOrderId IS NOT NULL AND deliveryOrderId != ''`,
    )
    .all<{ id: string; invoiceNo: string | null; deliveryOrderId: string }>();

  let linked = 0;
  let invoicesLinked = 0;
  const skipped: Array<{ invoiceNo: string; reason: string }> = [];
  const stmts: unknown[] = [];

  // THREE queries total, not two per invoice. A per-invoice loop here would be
  // ~2 × N serialized round-trips (400+ on prod) — the exact I/O-storm shape
  // that made the schedule engine look "hung" for minutes (its 114 serialized
  // queries; Workers CPU time excludes I/O wait, so a query storm never trips a
  // CPU limit, it just never finishes). Load everything, group in memory.
  const [allItemsRes, allDoItemsRes] = await Promise.all([
    db
      .prepare(
        `SELECT ii.id, ii.invoiceId, ii.productCode, ii.fabricCode, ii.production_order_id
           FROM invoice_items ii
           JOIN invoices i ON i.id = ii.invoiceId
          WHERE i.deliveryOrderId IS NOT NULL AND i.deliveryOrderId != ''`,
      )
      .all<{
        id: string; invoiceId: string; productCode: string | null;
        fabricCode: string | null; production_order_id: string | null;
      }>(),
    db
      .prepare(
        `SELECT di.deliveryOrderId, di.productionOrderId, di.productCode, di.fabricCode
           FROM delivery_order_items di`,
      )
      .all<{
        deliveryOrderId: string; productionOrderId: string | null;
        productCode: string | null; fabricCode: string | null;
      }>(),
  ]);
  const itemsByInv = new Map<string, typeof allItemsRes.results>();
  for (const r of allItemsRes.results ?? []) {
    const arr = itemsByInv.get(r.invoiceId) ?? [];
    arr.push(r);
    itemsByInv.set(r.invoiceId, arr);
  }
  const doItemsByDo = new Map<string, typeof allDoItemsRes.results>();
  for (const r of allDoItemsRes.results ?? []) {
    const arr = doItemsByDo.get(r.deliveryOrderId) ?? [];
    arr.push(r);
    doItemsByDo.set(r.deliveryOrderId, arr);
  }

  for (const inv of invs.results ?? []) {
    const items = itemsByInv.get(inv.id) ?? [];
    const doItems = doItemsByDo.get(inv.deliveryOrderId) ?? [];
    if (items.length === 0) continue;
    if (items.every((i) => i.production_order_id)) continue; // already done

    // Returned lines drop out of the invoice, so the counts only line up when
    // nothing was returned. Anything else is ambiguous → skip whole.
    if (items.length !== doItems.length) {
      // Measured on staging (25 skips): 16 have MORE invoice lines than DO
      // lines — those were billed via computeDoInvoiceLines' fallback, which
      // bills the SO's lines directly when the DO had nothing priceable, so
      // there is no DO line behind them and no link to carry (correct to skip,
      // permanently). 1 had FEWER — a delivery return dropped a line, which
      // shifts every position after it. Either way: don't guess.
      const why =
        items.length > doItems.length
          ? "billed from the SO lines, not the DO lines (no DO line behind them) — nothing to link"
          : "a delivery return dropped a line, so positions shift — refusing to guess";
      skipped.push({
        invoiceNo: inv.invoiceNo ?? inv.id,
        reason: `line count differs (invoice ${items.length} vs DO ${doItems.length}): ${why}`,
      });
      continue;
    }
    const aligned = items.every(
      (it, i) =>
        (it.productCode ?? "").trim() === (doItems[i].productCode ?? "").trim() &&
        (it.fabricCode ?? "").trim() === (doItems[i].fabricCode ?? "").trim(),
    );
    if (!aligned) {
      skipped.push({
        invoiceNo: inv.invoiceNo ?? inv.id,
        reason: "positions disagree on productCode|fabricCode — refusing to guess",
      });
      continue;
    }

    let any = false;
    items.forEach((it, i) => {
      const po = doItems[i].productionOrderId;
      if (!po || it.production_order_id) return;
      any = true;
      linked++;
      stmts.push(
        db
          .prepare(
            "UPDATE invoice_items SET production_order_id = ? WHERE id = ? AND production_order_id IS NULL",
          )
          .bind(po, it.id),
      );
    });
    if (any) invoicesLinked++;
    // Bounded per call — re-POST to continue (see maxInvoices).
    if (!dryRun && invoicesLinked >= maxInvoices) break;
  }

  if (!dryRun && stmts.length > 0) {
    // Chunked — a single batch of thousands of statements risks the Worker's
    // subrequest ceiling, and a half-applied batch here is harmless (the column
    // is additive and the fill is idempotent) but noisy.
    const CHUNK = 500;
    for (let i = 0; i < stmts.length; i += CHUNK) {
      await db.batch(stmts.slice(i, i + CHUNK) as never[]);
    }
    await emitAudit(c, {
      resource: "invoices",
      resourceId: "backfill-invoice-po-link",
      action: "backfill-invoice-po-link",
      source: "admin",
      after: { invoicesLinked, linesLinked: linked, skipped: skipped.length, bug: "BUG-2026-07-17-001" },
    });
  }

  return c.json({
    success: true,
    dryRun,
    invoicesScanned: (invs.results ?? []).length,
    invoicesLinked,
    linesLinked: linked,
    skippedCount: skipped.length,
    skipped: skipped.slice(0, 40),
    note: dryRun
      ? "DRY RUN — nothing written. POST { confirm: true } to apply."
      : "Linked. Skipped invoices keep the old code-matching fallback.",
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/backfill-invoiced-plan — PHASE 2 planner (read-only)
//
// The 15 SOs that phase 1 skipped because they already have an invoice
// (RM 2,030). Each needs BOTH sides moved: the SO re-priced AND the invoice
// re-priced, then the owner re-sends the invoice.
//
// The invoice must go through PUT /api/invoices/:id { priceEdits } — that is the
// ONLY path that restates the GL for a SENT invoice (wholesale item replacement
// is blocked on non-DRAFT precisely because it would skip the restate and orphan
// revenue/AR on a later void). Do NOT hand-roll a GL write.
//
// Matching invoice line → SO line is done consume-once on productCode|fabricCode.
// Anything ambiguous is REFUSED, not guessed:
//   • more than one non-CANCELLED invoice on the SO (SO-2606-135 has two)
//   • an owed SO line with no matching invoice line
// Refused rows come back under `needsManual` for the owner to handle by hand.
// ---------------------------------------------------------------------------
type InvoicedFixLine = {
  invoiceItemId: string; productCode: string; owedSen: number;
  unitNow: number; unitAfter: number;
  baseSen: number; divanSen: number; legSen: number; specialSen: number; discountSen: number;
};
type InvoicedFix = {
  salesOrderId: string; companySOId: string; invoiceId: string; invoiceNo: string;
  invoiceStatus: string; deltaSen: number; lines: InvoicedFixLine[];
};

async function buildInvoicedFixPlan(
  db: {
    prepare: (sql: string) => {
      bind: (...a: unknown[]) => { all: <T>() => Promise<{ results?: T[] }> };
    };
  },
  cfgSpecials: Awaited<ReturnType<typeof loadSpecialsConfig>>,
): Promise<{ fixes: InvoicedFix[]; needsManual: Array<Record<string, unknown>> }> {
  const soRows = await db
    .prepare(
      `SELECT i.id AS itemId, i.salesOrderId AS salesOrderId,
              i.productCode AS productCode, i.fabricCode AS fabricCode,
              i.specialOrder AS specialOrder,
              i.specialOrderPriceSen AS specialOrderPriceSen,
              i.quantity AS quantity,
              s.companySOId AS companySOId, s.isServiceOrder AS isServiceOrder
         FROM sales_order_items i
         JOIN sales_orders s ON s.id = i.salesOrderId
        WHERE i.specialOrder IS NOT NULL AND i.specialOrder != ''
          AND (s.isServiceOrder IS NULL OR s.isServiceOrder = false)`,
    )
    .bind()
    .all<{
      itemId: string; salesOrderId: string; productCode: string | null;
      fabricCode: string | null; specialOrder: string | null;
      specialOrderPriceSen: number | null; quantity: number | null;
      companySOId: string | null; isServiceOrder: boolean | number | null;
    }>();

  const owedBySo = new Map<string, Array<{ key: string; owed: number; productCode: string }>>();
  const soNo = new Map<string, string>();
  for (const r of soRows.results ?? []) {
    if (r.isServiceOrder === true || r.isServiceOrder === 1) continue;
    if (String(r.companySOId ?? "").toUpperCase().startsWith("SV-")) continue;
    if ((Number(r.specialOrderPriceSen) || 0) > 0) continue;
    const owed = deriveSpecialOrderSurchargeSen(r.specialOrder, null, cfgSpecials);
    if (owed <= 0) continue;
    const key = `${(r.productCode ?? "").trim()}|${(r.fabricCode ?? "").trim()}`;
    if (!owedBySo.has(r.salesOrderId)) owedBySo.set(r.salesOrderId, []);
    owedBySo.get(r.salesOrderId)!.push({ key, owed, productCode: r.productCode ?? "" });
    soNo.set(r.salesOrderId, r.companySOId ?? "");
  }
  if (owedBySo.size === 0) return { fixes: [], needsManual: [] };

  const soIds = Array.from(owedBySo.keys());
  const ph = soIds.map(() => "?").join(",");
  const invs = await db
    .prepare(
      `SELECT id, invoiceNo, salesOrderId, status
         FROM invoices WHERE salesOrderId IN (${ph})`,
    )
    .bind(...soIds)
    .all<{ id: string; invoiceNo: string | null; salesOrderId: string; status: string | null }>();

  const bySo = new Map<string, Array<{ id: string; invoiceNo: string; status: string }>>();
  for (const v of invs.results ?? []) {
    if ((v.status ?? "").toUpperCase() === "CANCELLED") continue; // a void doc needs no correction
    if (!bySo.has(v.salesOrderId)) bySo.set(v.salesOrderId, []);
    bySo.get(v.salesOrderId)!.push({
      id: v.id, invoiceNo: v.invoiceNo ?? "", status: v.status ?? "",
    });
  }

  const fixes: InvoicedFix[] = [];
  const needsManual: Array<Record<string, unknown>> = [];

  for (const [sid, owed] of owedBySo) {
    const list = bySo.get(sid) ?? [];
    if (list.length === 0) continue; // phase 1 territory (no invoice)
    if (list.length > 1) {
      needsManual.push({
        companySOId: soNo.get(sid), reason: "more than one live invoice on this SO — refusing to guess which one to correct",
        invoices: list.map((x) => `${x.invoiceNo}:${x.status}`),
      });
      continue;
    }
    const inv = list[0];
    const itemsRes = await db
      .prepare(
        `SELECT id, productCode, fabricCode, quantity, unitPriceSen,
                basePriceSen, divanPriceSen, legPriceSen, specialOrderPriceSen, discountSen
           FROM invoice_items WHERE invoiceId = ?`,
      )
      .bind(inv.id)
      .all<{
        id: string; productCode: string | null; fabricCode: string | null;
        quantity: number | null; unitPriceSen: number | null;
        basePriceSen: number | null; divanPriceSen: number | null;
        legPriceSen: number | null; specialOrderPriceSen: number | null;
        discountSen: number | null;
      }>();
    const pool = (itemsRes.results ?? []).map((x) => ({ row: x, used: false }));

    const lines: InvoicedFixLine[] = [];
    let delta = 0;
    let failed = false;
    for (const o of owed) {
      const hit = pool.find(
        (p) =>
          !p.used &&
          `${(p.row.productCode ?? "").trim()}|${(p.row.fabricCode ?? "").trim()}` === o.key &&
          (Number(p.row.specialOrderPriceSen) || 0) === 0,
      );
      if (!hit) {
        failed = true;
        needsManual.push({
          companySOId: soNo.get(sid), invoiceNo: inv.invoiceNo,
          reason: `no unmatched invoice line for ${o.key} — refusing to guess`,
        });
        break;
      }
      hit.used = true;
      const r = hit.row;
      const unitNow = Number(r.unitPriceSen) || 0;
      const divan = Number(r.divanPriceSen) || 0;
      const leg = Number(r.legPriceSen) || 0;
      const specNow = Number(r.specialOrderPriceSen) || 0;
      // Residual base keeps whatever else is folded into unit (e.g. the
      // total-height surcharge, which has no column of its own) — the
      // priceEdits path recomputes unit as base+divan+leg+special, so the
      // residual is what stops that recompute from ERASING it.
      const base = Math.max(0, unitNow - divan - leg - specNow);
      lines.push({
        invoiceItemId: r.id, productCode: r.productCode ?? "", owedSen: o.owed,
        unitNow, unitAfter: unitNow + o.owed,
        baseSen: base, divanSen: divan, legSen: leg, specialSen: o.owed,
        discountSen: Number(r.discountSen) || 0,
      });
      delta += o.owed * (Number(r.quantity) || 1);
    }
    if (failed || lines.length === 0) continue;
    fixes.push({
      salesOrderId: sid, companySOId: soNo.get(sid) ?? "",
      invoiceId: inv.id, invoiceNo: inv.invoiceNo, invoiceStatus: inv.status,
      deltaSen: delta, lines,
    });
  }
  return { fixes, needsManual };
}

app.get("/backfill-invoiced-plan", async (c) => {
  const su = requireSuperAdmin(c);
  if (su) return su;
  const cfg = await loadSpecialsConfig(c.var.DB);
  const { fixes, needsManual } = await buildInvoicedFixPlan(
    c.var.DB as never,
    cfg,
  );
  return c.json({
    success: true,
    readOnly: true,
    totals: {
      invoicesToCorrect: fixes.length,
      linesToCorrect: fixes.reduce((s, f) => s + f.lines.length, 0),
      deltaSen: fixes.reduce((s, f) => s + f.deltaSen, 0),
      deltaRM: (fixes.reduce((s, f) => s + f.deltaSen, 0) / 100).toFixed(2),
      needsManual: needsManual.length,
    },
    fixes,
    needsManual,
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/backfill-special-order-surcharge  — THE WRITE
//
// Applies the plan the GET above reports. One-shot; delete once run.
//
// Body: { confirm: true, scope?: "uninvoiced" | "all" }
//   scope "uninvoiced" (DEFAULT, safest) — only SOs that have NO invoice at all.
//     Nothing has been issued to a customer, so re-pricing is a pure internal
//     correction: no GL, no document to re-send. This is 78 of the 93 SOs and
//     RM 10,640 of the RM 12,670.
//   scope "all" — also re-prices SOs whose invoice already exists. The invoice
//     itself is NOT touched here (that is the owner's re-price + re-send step);
//     use only when that follow-up is actually happening, or the SO and its
//     invoice will disagree.
//
// SAFETY:
//   • IDEMPOTENT — only lines with specialOrderPriceSen = 0 AND a real owed
//     surcharge are touched. Re-running changes nothing.
//   • Service orders excluded (free by design) — same guards as the planner.
//   • ADDS THE DELTA to unitPriceSen; never recomputes it from the parts.
//     totalHeightPriceSen is NOT a stored column (it is folded into
//     unitPriceSen at write time), so recomputing base+divan+leg+special would
//     silently ERASE any total-height surcharge — the exact bug fixed on
//     2026-07-14. Adding the delta preserves whatever else is in there.
//   • lineTotal = newUnit × qty − discount, clamped ≥ 0 (per-line discount,
//     migration 0179).
//   • SO subtotal/total re-derived as Σ lineTotalSen, matching the POST path.
//   • Audited per SO with before/after totals.
// ---------------------------------------------------------------------------
app.post("/backfill-special-order-surcharge", async (c) => {
  const su = requireSuperAdmin(c);
  if (su) return su;
  const db = c.var.DB;

  const body = await c.req.json().catch(() => ({}));
  const confirm = (body as { confirm?: unknown })?.confirm === true;
  const scope = String((body as { scope?: unknown })?.scope ?? "uninvoiced");
  // Optional allow-list of companySOId. REQUIRED IN PRACTICE FOR scope:"all".
  //
  // Staging rehearsal caught this: scope:"all" re-priced ALL 15 invoiced SOs
  // while only 10 of their invoices could be corrected (the other 5 were refused
  // as ambiguous — two live invoices, or no matching invoice line). That leaves
  // the SO saying RM 80 and its invoice saying RM 0 — a SILENT disagreement, and
  // worse, invisible afterwards because both planners key off
  // specialOrderPriceSen = 0. Restricting to the SOs whose invoice actually
  // moved keeps the two sides in lockstep.
  const onlySoNos = Array.isArray((body as { soNos?: unknown })?.soNos)
    ? new Set(
        ((body as { soNos: unknown[] }).soNos)
          .map((x) => String(x).trim())
          .filter(Boolean),
      )
    : null;
  if (!confirm) {
    return c.json(
      { success: false, error: "Refusing to write without { confirm: true }." },
      400,
    );
  }
  if (scope !== "uninvoiced" && scope !== "all") {
    return c.json(
      { success: false, error: 'scope must be "uninvoiced" or "all"' },
      400,
    );
  }

  const cfgSpecials = await loadSpecialsConfig(db);

  const rows = await db
    .prepare(
      `SELECT i.id AS itemId, i.salesOrderId AS salesOrderId,
              i.specialOrder AS specialOrder,
              i.specialOrderPriceSen AS specialOrderPriceSen,
              i.unitPriceSen AS unitPriceSen, i.discountSen AS discountSen,
              i.quantity AS quantity,
              s.companySOId AS companySOId, s.isServiceOrder AS isServiceOrder
         FROM sales_order_items i
         JOIN sales_orders s ON s.id = i.salesOrderId
        WHERE i.specialOrder IS NOT NULL AND i.specialOrder != ''
          AND (s.isServiceOrder IS NULL OR s.isServiceOrder = false)`,
    )
    .all<{
      itemId: string; salesOrderId: string; specialOrder: string | null;
      specialOrderPriceSen: number | null; unitPriceSen: number | null;
      discountSen: number | null; quantity: number | null;
      companySOId: string | null; isServiceOrder: boolean | number | null;
    }>();

  // Which SOs already have an invoice — needed for the default scope.
  const invoicedSoIds = new Set<string>();
  const invRes = await db
    .prepare("SELECT DISTINCT salesOrderId FROM invoices WHERE salesOrderId IS NOT NULL")
    .all<{ salesOrderId: string }>();
  for (const r of invRes.results ?? []) invoicedSoIds.add(r.salesOrderId);

  const stmts: unknown[] = [];
  const touchedSoIds = new Set<string>();
  let linesUpdated = 0;
  let deltaSen = 0;
  const skippedInvoiced = new Set<string>();

  for (const r of rows.results ?? []) {
    if (r.isServiceOrder === true || r.isServiceOrder === 1) continue;
    if (String(r.companySOId ?? "").toUpperCase().startsWith("SV-")) continue;
    if ((Number(r.specialOrderPriceSen) || 0) > 0) continue; // idempotent
    if (onlySoNos && !onlySoNos.has(String(r.companySOId ?? "").trim())) continue;
    const owed = deriveSpecialOrderSurchargeSen(r.specialOrder, null, cfgSpecials);
    if (owed <= 0) continue;
    if (scope === "uninvoiced" && invoicedSoIds.has(r.salesOrderId)) {
      skippedInvoiced.add(r.salesOrderId);
      continue;
    }

    const qty = Number(r.quantity) || 1;
    const newUnit = (Number(r.unitPriceSen) || 0) + owed; // DELTA, not recompute
    const discount = Number(r.discountSen) || 0;
    const newLineTotal = Math.max(0, newUnit * qty - discount);

    stmts.push(
      db
        .prepare(
          `UPDATE sales_order_items
              SET specialOrderPriceSen = ?, unitPriceSen = ?, lineTotalSen = ?
            WHERE id = ? AND specialOrderPriceSen = 0`,
        )
        .bind(owed, newUnit, newLineTotal, r.itemId),
    );
    linesUpdated++;
    deltaSen += owed * qty;
    touchedSoIds.add(r.salesOrderId);
  }

  if (stmts.length === 0) {
    return c.json({
      success: true,
      scope,
      linesUpdated: 0,
      note: "Nothing to do — already backfilled, or no rows in scope.",
    });
  }

  await db.batch(stmts as never[]);

  // Re-derive each touched SO's totals from its lines (Σ lineTotalSen), the
  // same rule the POST path uses.
  const soIds = Array.from(touchedSoIds);
  const ph = soIds.map(() => "?").join(",");
  const sums = await db
    .prepare(
      `SELECT salesOrderId, SUM(lineTotalSen) AS s
         FROM sales_order_items WHERE salesOrderId IN (${ph})
        GROUP BY salesOrderId`,
    )
    .bind(...soIds)
    .all<{ salesOrderId: string; s: number }>();
  const totalStmts = (sums.results ?? []).map((x) =>
    db
      .prepare("UPDATE sales_orders SET subtotalSen = ?, totalSen = ? WHERE id = ?")
      .bind(Number(x.s) || 0, Number(x.s) || 0, x.salesOrderId),
  );
  if (totalStmts.length > 0) await db.batch(totalStmts as never[]);

  await emitAudit(c, {
    resource: "sales-orders",
    resourceId: `backfill-special-order-surcharge:${scope}`,
    action: "backfill-special-order-surcharge",
    source: "admin",
    after: {
      scope,
      salesOrdersUpdated: soIds.length,
      linesUpdated,
      deltaSen,
      deltaRM: (deltaSen / 100).toFixed(2),
      bug: "BUG-2026-07-17-002",
    },
  });

  return c.json({
    success: true,
    scope,
    salesOrdersUpdated: soIds.length,
    linesUpdated,
    deltaSen,
    deltaRM: (deltaSen / 100).toFixed(2),
    skippedBecauseInvoiced: scope === "uninvoiced" ? skippedInvoiced.size : 0,
    note:
      scope === "uninvoiced"
        ? "Only SOs with no invoice were re-priced. Invoiced SOs were skipped — they need the invoice re-priced + re-sent."
        : "All in-scope SOs re-priced. Their invoices were NOT touched — re-price + re-send those separately.",
  });
});

export default app;
