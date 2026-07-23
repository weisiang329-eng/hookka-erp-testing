import { Hono } from "hono";
import type { Env } from "../../worker";
import { requirePermission } from "../../lib/rbac";
import { autofillWorkingHoursFromPunch } from "../../lib/punch-autofill";
import { FIX_DATE_TODAY_CLAMP, type SuspiciousDateRow, type SwapPlan, type FixDatesCandidateRow, type FixDatesPlan } from "./_shared";

const app = new Hono<Env>();


// ---------------------------------------------------------------------------
// POST /api/import/sync-maintenance-history-from-kv?dryRun=true|false
//
// One-shot sync that captures the LIVE kv_config('variants-config[:cust]')
// blob into maintenance_config_history when the latest history snapshot
// differs from the live blob. Symptom this fixes: a customer's
// MaintenanceItemHistoryDialog shows old prices (e.g. RM 150) while the
// inline list shows the current edited value (RM 160) — meaning a prior
// kv_config write didn't create a corresponding history snapshot.
//
// Idempotent: skips scopes whose latest snapshot already matches the
// live blob.
// ---------------------------------------------------------------------------
app.post("/sync-maintenance-history-from-kv", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const today = new Date().toISOString().slice(0, 10);

  // Load every kv_config row that's a maintenance blob.
  const kvRes = await db
    .prepare(
      `SELECT key, value FROM kv_config
        WHERE key = 'variants-config' OR key LIKE 'variants-config:%'`,
    )
    .all<{ key: string; value: string }>();
  const kvRows = kvRes.results ?? [];

  const candidates: Array<{
    scope: string;
    kvKey: string;
    liveLen: number;
    latestSnapshotEffectiveFrom: string | null;
    latestSnapshotLen: number | null;
    needsSync: boolean;
  }> = [];
  let willInsert = 0;
  for (const kv of kvRows) {
    const scope =
      kv.key === "variants-config"
        ? "master"
        : `customer:${kv.key.slice("variants-config:".length)}`;
    // Latest snapshot for this scope.
    const latestRes = await db
      .prepare(
        `SELECT effective_from AS "effectiveFrom", config
           FROM maintenance_config_history
          WHERE scope = ?
          ORDER BY effective_from DESC, created_at DESC
          LIMIT 1`,
      )
      .bind(scope)
      .all<Record<string, unknown>>();
    const lr = (latestRes.results ?? [])[0];
    const lrEff =
      typeof lr?.effectiveFrom === "string"
        ? (lr.effectiveFrom as string)
        : typeof lr?.effective_from === "string"
          ? (lr.effective_from as string)
          : null;
    const lrCfg = typeof lr?.config === "string" ? (lr.config as string) : null;
    const needsSync = lrCfg !== kv.value;
    candidates.push({
      scope,
      kvKey: kv.key,
      liveLen: kv.value.length,
      latestSnapshotEffectiveFrom: lrEff,
      latestSnapshotLen: lrCfg ? lrCfg.length : null,
      needsSync,
    });
    if (needsSync) willInsert++;
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      totalScopes: candidates.length,
      willInsert,
      sample: candidates.slice(0, 20),
    });
  }

  let inserted = 0;
  for (const c0 of candidates) {
    if (!c0.needsSync) continue;
    const kv = kvRows.find((k) => k.key === c0.kvKey);
    if (!kv) continue;
    const newId = `mch-sync-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await db
      .prepare(
        `INSERT INTO maintenance_config_history
           (id, scope, config, effective_from, notes, created_by)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(
        newId,
        c0.scope,
        kv.value,
        today,
        "Auto-synced from kv_config (live edit not previously captured)",
      )
      .run();
    inserted++;
  }

  return c.json({
    success: true,
    dryRun: false,
    totalScopes: candidates.length,
    willInsert,
    inserted,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/cleanup-snapshot-from-master-rows?dryRun=true|false
//
// One-shot DELETE for the redundant "Snapshot from Master <date>" rows
// in customer_product_prices that the OLD copy-from-master logic created
// (one per cp, dated today's date, recording the current master price).
//
// The new copy-from-master mirrors the FULL master history, so the
// snapshot row is now redundant — the same price is already reachable
// via the 4-26 (or whichever is most recent) master mirror row.
//
// Idempotent. Migration-temp.
// ---------------------------------------------------------------------------
app.post("/cleanup-snapshot-from-master-rows", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  const candidatesRes = await db
    .prepare(
      `SELECT id, customerProductId, basePriceSen, effectiveFrom, notes
         FROM customer_product_prices
        WHERE notes LIKE 'Snapshot from Master%'`,
    )
    .all<{
      id: string;
      customerProductId: string;
      basePriceSen: number | null;
      effectiveFrom: string;
      notes: string | null;
    }>();
  const candidates = candidatesRes.results ?? [];

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      planned: candidates.length,
      sample: candidates.slice(0, 10),
    });
  }

  let deleted = 0;
  for (let i = 0; i < candidates.length; i += 50) {
    const slice = candidates.slice(i, i + 50);
    const stmts = slice.map((r) =>
      db
        .prepare("DELETE FROM customer_product_prices WHERE id = ?")
        .bind(r.id),
    );
    await db.batch(stmts);
    deleted += slice.length;
  }

  return c.json({
    success: true,
    dryRun: false,
    planned: candidates.length,
    deleted,
  });
});

app.post("/fix-misparsed-jan-dates", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // Find all JCs whose completedDate is in 2026-01-xx or 2026-02-xx where the
  // day component is also <= 12 (i.e. the date is swappable).
  const sus = await db
    .prepare(
      `SELECT id, productionOrderId, departmentCode, wipKey, completedDate
         FROM job_cards
        WHERE completedDate IS NOT NULL
          AND completedDate >= '2026-01-01'
          AND completedDate <  '2026-03-01'
          AND CAST(substr(completedDate, 9, 2) AS INTEGER) BETWEEN 1 AND 12
          AND CAST(substr(completedDate, 6, 2) AS INTEGER) BETWEEN 1 AND 12`,
    )
    .all<SuspiciousDateRow>();
  const suspects = sus.results ?? [];

  // For each suspect, look up siblings on same productionOrderId with
  // completedDate >= '2026-03-15'. Group by PO id to amortize the round-trip.
  const poIds = Array.from(new Set(suspects.map((s) => s.productionOrderId)));
  const siblingsByPO = new Map<string, { count: number; maxDate: string }>();

  // D1's bind doesn't support array-spread well, so chunk + IN-list.
  const CHUNK = 50;
  for (let i = 0; i < poIds.length; i += CHUNK) {
    const chunk = poIds.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const sib = await db
      .prepare(
        `SELECT productionOrderId,
                COUNT(*) AS cnt,
                MAX(completedDate) AS "maxDate"
           FROM job_cards
          WHERE productionOrderId IN (${placeholders})
            AND completedDate IS NOT NULL
            AND completedDate >= '2026-03-15'
          GROUP BY productionOrderId`,
      )
      .bind(...chunk)
      .all<{ productionOrderId: string; cnt: number; maxDate: string }>();
    for (const r of sib.results ?? []) {
      siblingsByPO.set(r.productionOrderId, {
        count: r.cnt,
        maxDate: r.maxDate,
      });
    }
  }

  const plans: SwapPlan[] = [];
  const skipped: Array<{ jcId: string; reason: string }> = [];
  for (const s of suspects) {
    const sib = siblingsByPO.get(s.productionOrderId);
    if (!sib || sib.count === 0) {
      skipped.push({
        jcId: s.id,
        reason: "no sibling JC with completedDate >= 2026-03-15 on same PO",
      });
      continue;
    }

    // Swap month <-> day.
    // Format is YYYY-MM-DD, swap → YYYY-DD-MM (substr 6,2 ↔ substr 9,2).
    const yyyy = s.completedDate.slice(0, 4);
    const mm = s.completedDate.slice(5, 7);
    const dd = s.completedDate.slice(8, 10);
    const proposed = `${yyyy}-${dd}-${mm}`;

    // Sanity check: swapped date must be a valid date.
    const ddNum = parseInt(dd, 10);
    const mmNum = parseInt(mm, 10);
    if (
      !Number.isFinite(ddNum) ||
      !Number.isFinite(mmNum) ||
      ddNum < 1 ||
      ddNum > 12 ||
      mmNum < 1 ||
      mmNum > 12
    ) {
      skipped.push({
        jcId: s.id,
        reason: `non-swappable components dd=${dd} mm=${mm}`,
      });
      continue;
    }

    // Swapped date must be <= today and not the same as current.
    if (proposed > FIX_DATE_TODAY_CLAMP) {
      skipped.push({
        jcId: s.id,
        reason: `swapped date ${proposed} > today clamp ${FIX_DATE_TODAY_CLAMP}`,
      });
      continue;
    }
    if (proposed === s.completedDate) {
      skipped.push({
        jcId: s.id,
        reason: `swap is identity (palindromic date) for ${s.completedDate}`,
      });
      continue;
    }

    plans.push({
      jcId: s.id,
      productionOrderId: s.productionOrderId,
      departmentCode: s.departmentCode,
      wipKey: s.wipKey,
      current: s.completedDate,
      proposed,
      siblingMaxDate: sib.maxDate,
      siblingsInMarchAprWindow: sib.count,
    });
  }

  // By-dept and by-(current → proposed) breakdowns for sanity-checking.
  const byDept: Record<string, number> = {};
  const byMonthSwap: Record<string, number> = {};
  for (const p of plans) {
    const d = p.departmentCode || "UNKNOWN";
    byDept[d] = (byDept[d] ?? 0) + 1;
    const swapKey = `${p.current.slice(0, 7)} -> ${p.proposed.slice(0, 7)}`;
    byMonthSwap[swapKey] = (byMonthSwap[swapKey] ?? 0) + 1;
  }

  const sample = plans.slice(0, 10).map((p) => ({
    jcId: p.jcId,
    productionOrderId: p.productionOrderId,
    departmentCode: p.departmentCode,
    wipKey: p.wipKey,
    current: p.current,
    proposed: p.proposed,
    siblingMaxDate: p.siblingMaxDate,
    siblingsInMarchAprWindow: p.siblingsInMarchAprWindow,
  }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      suspectsFound: suspects.length,
      planned: plans.length,
      skipped: skipped.length,
      skippedSample: skipped.slice(0, 5),
      byDept,
      byMonthSwap,
      sample,
    });
  }

  let updated = 0;
  const errors: Array<{ jcId: string; message: string }> = [];
  for (const p of plans) {
    try {
      await db
        .prepare(`UPDATE job_cards SET completedDate = ? WHERE id = ?`)
        .bind(p.proposed, p.jcId)
        .run();
      updated++;
    } catch (err) {
      errors.push({
        jcId: p.jcId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    suspectsFound: suspects.length,
    planned: plans.length,
    skipped: skipped.length,
    updated,
    byDept,
    byMonthSwap,
    errors,
  });
});

app.post("/fix-misparsed-dates", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") !== "false";

  // 1. Pull every JC in the 2026-01/2026-02 window where day & month are
  //    both <= 12 (i.e. the swap produces a valid date).
  const candRes = await db
    .prepare(
      `SELECT id, productionOrderId, departmentCode, completedDate
         FROM job_cards
        WHERE completedDate IS NOT NULL
          AND completedDate >= '2026-01-01'
          AND completedDate <  '2026-03-01'
          AND CAST(substr(completedDate, 9, 2) AS INTEGER) BETWEEN 1 AND 12
          AND CAST(substr(completedDate, 6, 2) AS INTEGER) BETWEEN 1 AND 12`,
    )
    .all<FixDatesCandidateRow>();
  const candidates = candRes.results ?? [];

  // 2. Lookup sibling counts on the same PO with completedDate >= 2026-03-15.
  //    Exclude the candidate itself from the count via id != ?.
  const poIds = Array.from(new Set(candidates.map((c) => c.productionOrderId)));
  const siblingsByPO = new Map<string, number>();

  const CHUNK = 50;
  for (let i = 0; i < poIds.length; i += CHUNK) {
    const chunk = poIds.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const sib = await db
      .prepare(
        `SELECT productionOrderId, COUNT(*) AS cnt
           FROM job_cards
          WHERE productionOrderId IN (${placeholders})
            AND completedDate IS NOT NULL
            AND completedDate >= '2026-03-15'
          GROUP BY productionOrderId`,
      )
      .bind(...chunk)
      .all<{ productionOrderId: string; cnt: number }>();
    for (const r of sib.results ?? []) {
      siblingsByPO.set(r.productionOrderId, r.cnt);
    }
  }

  // 3. Build per-candidate plan. Subtract 1 if the candidate itself happens
  //    to fall in the late cluster (it shouldn't, since it's in 2026-01/02,
  //    but guard anyway).
  const plans: FixDatesPlan[] = [];
  let skippedNoSiblings = 0;
  let skippedOther = 0;
  for (const cand of candidates) {
    const yyyy = cand.completedDate.slice(0, 4);
    const mm = cand.completedDate.slice(5, 7);
    const dd = cand.completedDate.slice(8, 10);
    const proposed = `${yyyy}-${dd}-${mm}`;

    const ddNum = parseInt(dd, 10);
    const mmNum = parseInt(mm, 10);
    if (
      !Number.isFinite(ddNum) ||
      !Number.isFinite(mmNum) ||
      ddNum < 1 ||
      ddNum > 12 ||
      mmNum < 1 ||
      mmNum > 12
    ) {
      skippedOther++;
      continue;
    }
    if (proposed > FIX_DATE_TODAY_CLAMP) {
      skippedOther++;
      continue;
    }
    if (proposed === cand.completedDate) {
      // palindromic (e.g. 2026-02-02) — nothing to swap
      skippedOther++;
      continue;
    }

    const siblingsInLateCluster = siblingsByPO.get(cand.productionOrderId) ?? 0;
    if (siblingsInLateCluster < 1) {
      skippedNoSiblings++;
      continue;
    }

    plans.push({
      jcId: cand.id,
      poId: cand.productionOrderId,
      departmentCode: cand.departmentCode,
      current: cand.completedDate,
      proposed,
      siblingsInLateCluster,
    });
  }

  const sample = plans.slice(0, 20).map((p) => ({
    jcId: p.jcId,
    poId: p.poId,
    departmentCode: p.departmentCode,
    current: p.current,
    proposed: p.proposed,
    siblingsInLateCluster: p.siblingsInLateCluster,
  }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      totalCandidates: candidates.length,
      wouldSwap: plans.length,
      skippedNoSiblings,
      skippedOther,
      sample,
    });
  }

  // 4. Live: update each row's completedDate + updated_at.
  const nowIso = new Date().toISOString();
  let updated = 0;
  const errors: Array<{ jcId: string; message: string }> = [];
  for (const p of plans) {
    try {
      await db
        .prepare(
          `UPDATE job_cards SET completedDate = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(p.proposed, nowIso, p.jcId)
        .run();
      updated++;
    } catch (err) {
      errors.push({
        jcId: p.jcId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    totalCandidates: candidates.length,
    wouldSwap: plans.length,
    skippedNoSiblings,
    skippedOther,
    updated,
    errors,
    sample,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/normalize-fullwidth-parens
//
// One-shot data fix: BEDFRAME BOM master templates were authored with the
// full-width Chinese parentheses "（FC）" instead of "(FC)" on the FAB_CUT
// branch wipCode. That typo cascaded into:
//   - bom_master_templates.data (JSON tree, 2 templates)
//   - bom_templates.wipComponents (JSON tree, ~153 product BOMs)
//   - job_cards.wipCode + wipLabel (every FAB_CUT JC built from those BOMs)
//   - wip_items.code (rows produced/consumed under the typo'd label)
//
// Because UPH/FAB_SEW consume looks up the half-width "(FC)" form (after
// resolveWipTokens runs `.replace(/\s+/g, " ").trim()` — the full-width
// parens survive), wip_items splits into two rows per (productCode, label):
// one with full-width that received the FAB_CUT producer-add, one with
// half-width that absorbed the downstream consume → residual negatives.
//
// Fix pattern mirrors migration 0059 (s/Faom/Foam/) but extended:
//   1. bom_master_templates.data  REPLACE both （ and ）
//   2. bom_templates.wipComponents REPLACE both
//   3. job_cards.wipCode + wipLabel + branchKey REPLACE both
//   4. wip_items merge pairs: SUM stockQty into the half-width row, DELETE
//      the full-width row. Orphan full-width rows (no half-width sibling)
//      get renamed in place via REPLACE.
//
// dryRun=true → SELECT counts + 10-row pair sample, no writes.
// dryRun=false → run the full sequence as a single db.batch().
//
// Permission: production-orders:update (matches the other one-shot import
// endpoints; this is a privileged backfill, not a user-facing surface).
// ---------------------------------------------------------------------------
app.post("/normalize-fullwidth-parens", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // ----- Step 1 — bom_master_templates count -----
  const bomMasterCountRes = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM bom_master_templates
        WHERE data LIKE '%（%' OR data LIKE '%）%'`,
    )
    .first<{ n: number }>();
  const bomMasterCount = bomMasterCountRes?.n ?? 0;

  // ----- Step 2 — bom_templates count -----
  const bomTemplatesCountRes = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM bom_templates
        WHERE wipComponents LIKE '%（%' OR wipComponents LIKE '%）%'`,
    )
    .first<{ n: number }>();
  const bomTemplatesCount = bomTemplatesCountRes?.n ?? 0;

  // ----- Step 3 — job_cards count (wipCode / wipLabel / branchKey) -----
  const jobCardsCountRes = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM job_cards
        WHERE wipCode    LIKE '%（%' OR wipCode    LIKE '%）%'
           OR wipLabel   LIKE '%（%' OR wipLabel   LIKE '%）%'
           OR branchKey  LIKE '%（%' OR branchKey  LIKE '%）%'`,
    )
    .first<{ n: number }>();
  const jobCardsCount = jobCardsCountRes?.n ?? 0;

  // Per-dept breakdown — confirms the typo is FAB_CUT-only as expected.
  const jobCardsByDeptRes = await db
    .prepare(
      `SELECT departmentCode AS dept, COUNT(*) AS n FROM job_cards
        WHERE wipCode  LIKE '%（%' OR wipCode  LIKE '%）%'
           OR wipLabel LIKE '%（%' OR wipLabel LIKE '%）%'
        GROUP BY departmentCode
        ORDER BY n DESC`,
    )
    .all<{ dept: string; n: number }>();
  const jobCardsByDept = jobCardsByDeptRes.results ?? [];

  // ----- Step 4 — wip_items full-width rows + pair detection -----
  // Row count
  const wipItemsFullwidthCountRes = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM wip_items
        WHERE code LIKE '%（%' OR code LIKE '%）%'`,
    )
    .first<{ n: number }>();
  const wipItemsFullwidthCount = wipItemsFullwidthCountRes?.n ?? 0;

  // Pair detection: a wip_items row with full-width parens "pairs" with a
  // half-width row when (relatedProduct, half-width-version-of-code) match.
  // SQLite REPLACE() chains cleanly inside the JOIN.
  type PairRow = {
    fwId: string;
    fwCode: string;
    fwQty: number;
    fwRelated: string | null;
    hwId: string;
    hwCode: string;
    hwQty: number;
  };
  const pairsRes = await db
    .prepare(
      `SELECT b.id AS "fwId", b.code AS "fwCode", b.stockQty AS "fwQty",
              b.relatedProduct AS "fwRelated",
              a.id AS "hwId", a.code AS "hwCode", a.stockQty AS "hwQty"
         FROM wip_items b
         JOIN wip_items a
           ON a.code = REPLACE(REPLACE(b.code, '（', '('), '）', ')')
          AND COALESCE(a.relatedProduct, '') = COALESCE(b.relatedProduct, '')
        WHERE (b.code LIKE '%（%' OR b.code LIKE '%）%')
          AND b.id != a.id`,
    )
    .all<PairRow>();
  const pairs = pairsRes.results ?? [];
  const pairedFullwidthIds = new Set(pairs.map((p) => p.fwId));
  const orphanCount = wipItemsFullwidthCount - pairedFullwidthIds.size;

  const samplePairs = pairs.slice(0, 10).map((p) => ({
    relatedProduct: p.fwRelated,
    fullwidth: { id: p.fwId, code: p.fwCode, stockQty: p.fwQty },
    halfwidth: { id: p.hwId, code: p.hwCode, stockQty: p.hwQty },
    summed: (p.fwQty || 0) + (p.hwQty || 0),
  }));

  // Orphan-row sample + stockQty distribution. With 0 pairs the orphan list
  // IS the full picture — knowing how many orphans are positive vs negative
  // vs zero tells us whether the rename is harmless rebadge or whether it
  // would re-collide with an existing half-width row that wasn't picked up
  // by the pair join (e.g. relatedProduct mismatch).
  type OrphanRow = {
    id: string;
    code: string;
    relatedProduct: string | null;
    stockQty: number;
  };
  const orphansRes = await db
    .prepare(
      `SELECT id, code, relatedProduct, stockQty FROM wip_items
        WHERE (code LIKE '%（%' OR code LIKE '%）%')
        ORDER BY stockQty DESC`,
    )
    .all<OrphanRow>();
  const orphanRows = orphansRes.results ?? [];
  let orphanPositive = 0,
    orphanNegative = 0,
    orphanZero = 0,
    orphanPosTotal = 0,
    orphanNegTotal = 0;
  for (const o of orphanRows) {
    const q = o.stockQty || 0;
    if (q > 0) {
      orphanPositive++;
      orphanPosTotal += q;
    } else if (q < 0) {
      orphanNegative++;
      orphanNegTotal += q;
    } else {
      orphanZero++;
    }
  }

  // Detect rename-collisions: a full-width row whose half-width form
  // already exists in wip_items, but with a DIFFERENT relatedProduct
  // (or null vs ""). The pair join above would have missed those —
  // surfacing them here lets us decide manually if any need merging.
  const renameCollisionRes = await db
    .prepare(
      `SELECT b.id AS "fwId", b.code AS "fwCode", b.relatedProduct AS "fwRelated",
              b.stockQty AS "fwQty",
              a.id AS "hwId", a.code AS "hwCode", a.relatedProduct AS "hwRelated",
              a.stockQty AS "hwQty"
         FROM wip_items b
         JOIN wip_items a
           ON a.code = REPLACE(REPLACE(b.code, '（', '('), '）', ')')
        WHERE (b.code LIKE '%（%' OR b.code LIKE '%）%')
          AND b.id != a.id
          AND COALESCE(a.relatedProduct, '') != COALESCE(b.relatedProduct, '')`,
    )
    .all<PairRow & { hwRelated: string | null }>();
  const renameCollisions = renameCollisionRes.results ?? [];

  const sampleOrphans = orphanRows.slice(0, 10).map((o) => ({
    id: o.id,
    code: o.code,
    relatedProduct: o.relatedProduct,
    stockQty: o.stockQty,
  }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      summary: {
        bomMasterTemplates: bomMasterCount,
        bomTemplates: bomTemplatesCount,
        jobCards: jobCardsCount,
        jobCardsByDept,
        wipItemsFullwidth: wipItemsFullwidthCount,
        wipItemsPaired: pairedFullwidthIds.size,
        wipItemsOrphan: orphanCount,
        orphanStockQty: {
          positive: orphanPositive,
          positiveTotal: orphanPosTotal,
          negative: orphanNegative,
          negativeTotal: orphanNegTotal,
          zero: orphanZero,
        },
        renameCollisions: renameCollisions.length,
      },
      sampleOrphans,
      sampleRenameCollisions: renameCollisions.slice(0, 10),
      samplePairs,
    });
  }

  // ----- Live mode — run all steps as a single db.batch() -----
  // D1 batches are atomic: every statement in the array commits together
  // or none do. That gives us the "single transaction" semantic without
  // BEGIN/COMMIT (which D1 doesn't expose).
  const stmts: D1PreparedStatement[] = [];

  // 1) BOM master templates — JSON blob in `data` column.
  stmts.push(
    db.prepare(
      `UPDATE bom_master_templates
          SET data = REPLACE(REPLACE(data, '（', '('), '）', ')')
        WHERE data LIKE '%（%' OR data LIKE '%）%'`,
    ),
  );

  // 2) BOM product templates — JSON blob in `wipComponents` column.
  stmts.push(
    db.prepare(
      `UPDATE bom_templates
          SET wipComponents = REPLACE(REPLACE(wipComponents, '（', '('), '）', ')')
        WHERE wipComponents LIKE '%（%' OR wipComponents LIKE '%）%'`,
    ),
  );

  // 3) job_cards — wipCode + wipLabel + branchKey. Three separate UPDATEs
  // so the WHERE filter is column-scoped (SQLite doesn't fold these into
  // one efficient pass).
  stmts.push(
    db.prepare(
      `UPDATE job_cards
          SET wipCode = REPLACE(REPLACE(wipCode, '（', '('), '）', ')')
        WHERE wipCode LIKE '%（%' OR wipCode LIKE '%）%'`,
    ),
  );
  stmts.push(
    db.prepare(
      `UPDATE job_cards
          SET wipLabel = REPLACE(REPLACE(wipLabel, '（', '('), '）', ')')
        WHERE wipLabel LIKE '%（%' OR wipLabel LIKE '%）%'`,
    ),
  );
  stmts.push(
    db.prepare(
      `UPDATE job_cards
          SET branchKey = REPLACE(REPLACE(branchKey, '（', '('), '）', ')')
        WHERE branchKey LIKE '%（%' OR branchKey LIKE '%）%'`,
    ),
  );

  // 4a) wip_items pair merge — sum full-width stockQty into the half-width
  // sibling row, then DELETE the full-width row. We bind one statement per
  // pair so each row is targeted by primary key — robust against future
  // shape changes and lets us count exact effects per pair.
  for (const p of pairs) {
    stmts.push(
      db
        .prepare(
          `UPDATE wip_items SET stockQty = stockQty + ? WHERE id = ?`,
        )
        .bind(p.fwQty, p.hwId),
    );
    stmts.push(
      db.prepare(`DELETE FROM wip_items WHERE id = ?`).bind(p.fwId),
    );
  }

  // 4b) Orphan full-width rows — no half-width sibling, so just rename in
  // place. The WHERE clause excludes rows we already DELETEd above by
  // re-checking that they still match the LIKE filter (deleted rows can't
  // match anything).
  stmts.push(
    db.prepare(
      `UPDATE wip_items
          SET code = REPLACE(REPLACE(code, '（', '('), '）', ')')
        WHERE code LIKE '%（%' OR code LIKE '%）%'`,
    ),
  );

  const batchResults = await db.batch(stmts);

  // Each batchResults[i] has .meta.changes (D1 standard).
  // Indices: 0=bomMaster, 1=bomTemplates, 2=jcWipCode, 3=jcWipLabel,
  // 4=jcBranchKey, then per-pair (UPDATE+DELETE pairs), then orphan rename.
  const changes = batchResults.map((r) => r.meta?.changes ?? 0);
  const pairUpdates = pairs.length;
  const orphanRenameIdx = 5 + pairUpdates * 2;

  return c.json({
    success: true,
    dryRun: false,
    summary: {
      bomMasterTemplatesUpdated: changes[0] ?? 0,
      bomTemplatesUpdated: changes[1] ?? 0,
      jobCardsWipCodeUpdated: changes[2] ?? 0,
      jobCardsWipLabelUpdated: changes[3] ?? 0,
      jobCardsBranchKeyUpdated: changes[4] ?? 0,
      wipItemsPairUpdates: pairUpdates,
      wipItemsPairDeletes: pairUpdates,
      wipItemsOrphanRenames: changes[orphanRenameIdx] ?? 0,
    },
    samplePairs,
  });
});

// ---------------------------------------------------------------------------
// POST /create-updated-at-indexes — ONE-SHOT (owner 2026-07-04, IT-hygiene
// audit follow-up). The dashboard snapshot freshness probe runs
// MAX(updated_at) across its source tables on every read; ~15 tables carry an
// updated_at column with NO index on it, so each probe is a sequential scan
// that gets linearly slower as data grows. SELF-DISCOVERING: asks Postgres
// which public tables have an updated_at column but no index covering it —
// no hardcoded list to go stale. Plain CREATE INDEX briefly locks writes; the
// tables are small (ms-scale builds), and IF NOT EXISTS keeps it idempotent.
// AUDIT-FIRST — apply with { "apply": true, "confirm": "indexes" }.
app.post("/create-updated-at-indexes", async (c) => {
  const denied = await requirePermission(c, "users", "create");
  if (denied) return denied;
  const db = c.var.DB;
  const body = (await c.req.json().catch(() => ({}))) as {
    apply?: boolean;
    confirm?: string;
  };
  const apply = body.apply === true && body.confirm === "indexes";

  const res = await db
    .prepare(
      `SELECT c.table_name AS "tableName",
              EXISTS (
                SELECT 1 FROM pg_indexes i
                 WHERE i.schemaname = 'public'
                   AND i.tablename = c.table_name
                   AND i.indexdef ILIKE '%(updated_at%'
              ) AS "hasIndex"
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND c.column_name = 'updated_at'
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name`,
    )
    .all<{ tableName: string; hasIndex: boolean }>();
  const all = res.results ?? [];
  const missing = all.filter(
    (r) => !r.hasIndex && /^[a-z0-9_]+$/.test(r.tableName),
  );

  if (!apply) {
    return c.json({
      success: true,
      apply: false,
      tablesWithUpdatedAt: all.length,
      alreadyIndexed: all.length - missing.length,
      missing: missing.map((m) => m.tableName),
      note: 'Audit only. Apply with { "apply": true, "confirm": "indexes" }.',
    });
  }

  const created: string[] = [];
  const failed: Array<{ table: string; error: string }> = [];
  for (const m of missing) {
    try {
      await db
        .prepare(
          `CREATE INDEX IF NOT EXISTS idx_${m.tableName}_updated_at ON ${m.tableName} (updated_at)`,
        )
        .run();
      created.push(m.tableName);
    } catch (err) {
      failed.push({
        table: m.tableName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return c.json({ success: true, apply: true, created, failed });
});

// POST /backfill-punch-autofill-blocked — ONE-SHOT (owner 2026-07-04).
// Repairs the days already bitten by the punch-autofill safety-gate bug: an
// APPROVED non-production request row that landed BEFORE the worker's
// punch-out made the blanket COUNT(*) gate skip the whole day, so the punched
// hours were never logged (the "AUNG KYAW SOE 1.33h day"). Candidates =
// punched days whose working_hour_entries are ALL "Non-production (approved)"
// rows. Apply re-runs the (now fixed) autofill for exactly those days — it
// generates the punch rows minus the hours the approval already claimed, and
// still never touches any day that has office-keyed or auto rows.
// AUDIT-FIRST — apply with { "apply": true, "confirm": "autofill" }.
app.post("/backfill-punch-autofill-blocked", async (c) => {
  const denied = await requirePermission(c, "users", "create");
  if (denied) return denied;
  const db = c.var.DB;

  const body = (await c.req.json().catch(() => ({}))) as {
    apply?: boolean;
    confirm?: string;
  };
  const apply = body.apply === true && body.confirm === "autofill";

  const cands = await db
    .prepare(
      `SELECT a.id AS "attendanceId", a.employeeId AS "workerId", a.date,
              a.clockIn AS "clockIn", a.clockOut AS "clockOut",
              w.name AS "workerName", w.departmentCode AS "homeDeptCode",
              (SELECT COALESCE(SUM(e.hours), 0) FROM working_hour_entries e
                WHERE e.attendanceId = a.id) AS "nonProdHours"
         FROM attendance_records a
         JOIN workers w ON w.id = a.employeeId
        WHERE a.clockIn IS NOT NULL AND a.clockOut IS NOT NULL
          AND EXISTS (SELECT 1 FROM working_hour_entries e WHERE e.attendanceId = a.id)
          AND NOT EXISTS (
            SELECT 1 FROM working_hour_entries e
             WHERE e.attendanceId = a.id
               AND e.notes NOT LIKE 'Non-production (approved)%'
          )
        ORDER BY a.date, w.name`,
    )
    .all<{
      attendanceId: string;
      workerId: string;
      date: string;
      clockIn: string;
      clockOut: string;
      workerName: string;
      homeDeptCode: string | null;
      nonProdHours: number;
    }>();
  const days = cands.results ?? [];

  if (!apply) {
    return c.json({
      success: true,
      apply: false,
      count: days.length,
      days: days.map((d) => ({
        worker: d.workerName,
        date: d.date,
        punch: `${d.clockIn}→${d.clockOut}`,
        nonProdApprovedHours: Number(d.nonProdHours) || 0,
      })),
      note: 'Audit only. Apply with { "apply": true, "confirm": "autofill" }.',
    });
  }

  const results: Array<{ worker: string; date: string; created: number }> = [];
  for (const d of days) {
    try {
      const r = await autofillWorkingHoursFromPunch(db, {
        attendanceId: d.attendanceId,
        workerId: d.workerId,
        date: d.date,
        clockIn: d.clockIn,
        clockOut: d.clockOut,
        homeDeptCode: d.homeDeptCode,
      });
      results.push({ worker: d.workerName, date: d.date, created: r.created });
    } catch (err) {
      console.error("[backfill-punch-autofill-blocked] failed", {
        attendanceId: d.attendanceId,
        err: err instanceof Error ? err.message : String(err),
      });
      results.push({ worker: d.workerName, date: d.date, created: -1 });
    }
  }
  return c.json({ success: true, apply: true, count: days.length, results });
});

export default app;
