import { Hono } from "hono";
import type { Env } from "../../worker";
import { requirePermission } from "../../lib/rbac";
import { generateFGUnitsForPO } from "../fg-units";
import { createProductionOrdersForOrder } from "../_shared/production-builder";
import { getOrgId } from "../../lib/tenant";
import { ensureJobCardCompletedAt } from "../../lib/job-card-completed-at";
import { validateFabricCodes } from "../../lib/fabric-validation";
import { type FcRow, joinModelLabel, buildFcWipLabel, type FcRefreshJcRow, type PoRow, type SplitCandidatePo } from "./_shared";

const app = new Hono<Env>();


app.post("/backfill-fab-cut-merge", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  // Migrations are inert on deploy (CLAUDE.md) — awaited before the anchor
  // UPDATE below mentions completed_at.
  await ensureJobCardCompletedAt(db);
  const dryRun = c.req.query("dryRun") === "true";

  // Pull every FAB_CUT JC with its PO context + bom_templates baseModel in
  // one query. The LEFT JOIN tolerates orphan POs / missing BOM rows
  // (legacy seed data) — we fall back to productCode as baseModel below.
  // Use double-quoted AS aliases so Postgres preserves the camelCase
  // exactly as written. Unquoted aliases get folded to all-lowercase
  // (`poProductCode` → `poproductcode`) and the db-pg snake→camel
  // transform can't resurrect them. Bug: dry-run reported 1380 FC JCs
  // but every newWipKey came out as `pord-XXX::::::FAB_CUT` (empty
  // baseModel + fabric) because row.poProductCode was undefined.
  const rowsRes = await db
    .prepare(
      `SELECT
         jc.id, jc.productionOrderId, jc.wipKey, jc.wipLabel, jc.wipCode,
         jc.wipType, jc.wipQty, jc.status, jc.completedDate, jc.dueDate,
         jc.sequence, jc.branchKey, jc.category, jc.productionTimeMinutes,
         jc.estMinutes, jc.pic1Id, jc.pic1Name, jc.pic2Id, jc.pic2Name,
         po.productCode       AS "poProductCode",
         po.fabricCode        AS "poFabricCode",
         po.sizeLabel         AS "poSizeLabel",
         po.gapInches         AS "poGapInches",
         po.divanHeightInches AS "poDivanHeightInches",
         po.legHeightInches   AS "poLegHeightInches",
         po.itemCategory      AS "poItemCategory",
         po.companySOId       AS "poCompanySOId",
         po.salesOrderId      AS "poSalesOrderId",
         po.companyCOId       AS "poCompanyCOId",
         po.consignmentOrderId AS "poConsignmentOrderId",
         bt.baseModel         AS "bomBaseModel"
       FROM job_cards jc
       JOIN production_orders po ON po.id = jc.productionOrderId
       LEFT JOIN bom_templates bt
         ON bt.productCode = po.productCode
        AND bt.versionStatus = 'ACTIVE'
       WHERE jc.departmentCode = 'FAB_CUT'`,
    )
    .all<FcRow>();
  const allRows = rowsRes.results ?? [];

  // Category-aware grouping (mirrors production-builder.ts aggregateFcSlots).
  //   SOFA  → cross-PO merge by (companySOId, baseModel, fabric)
  //   BF/ACC → per-PO merge (each set already has its own line-suffixed
  //            po_no — distinct sets must NOT collapse just because they
  //            share baseModel + fabric, e.g. 2 BF lines of same model in
  //            same SO are 2 different cutting jobs).
  const groups = new Map<string, FcRow[]>();
  let skippedNoSO = 0;
  for (const row of allRows) {
    // Parent doc id — SO id or CO id. Without the CO branch, every CO
    // sofa row hit `skippedNoSO++` and never participated in merge.
    const parentDocKey =
      row.poCompanySOId ??
      row.poSalesOrderId ??
      row.poCompanyCOId ??
      row.poConsignmentOrderId ??
      "";
    const baseModel = row.bomBaseModel || row.poProductCode || "";
    const fabric = row.poFabricCode ?? "";
    const isSofa = (row.poItemCategory ?? "") === "SOFA";
    if (isSofa && !parentDocKey) {
      skippedNoSO++;
      continue;
    }
    const key = isSofa
      ? `SOFA::${parentDocKey}::${baseModel}::${fabric}`
      : `PO::${row.productionOrderId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  // Plan per group. Single-JC groups are no-ops; multi-JC groups become a
  // merge: anchor = first row (ordered by createdAt via id sort), the rest
  // get deleted, anchor gets UPDATE-d to merged values.
  type Plan = {
    mergeKey: string;
    anchorJcId: string;
    siblingJcIds: string[];
    newWipKey: string;
    newWipLabel: string;
    // Merged FC wipType = itemCategory so cascade stamps wip_items.type
    // with the set-level category instead of the anchor's per-piece type.
    newWipType: string;
    newWipQty: number;
    newProdTime: number;
    completedDate: string | null;
    status: string;
    dueDate: string | null;
    pieceCount: number;
  };
  const plans: Plan[] = [];
  let alreadyMerged = 0;
  for (const [mergeKey, group] of groups.entries()) {
    if (group.length === 0) continue;
    if (group.length === 1) {
      // Single-JC group — already-merged shape OR a one-piece BF SOID. No-op
      // either way.
      alreadyMerged++;
      continue;
    }
    // Pick anchor = lowest-id row (deterministic). Sort siblings same way.
    const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));
    const anchor = sorted[0];
    const siblings = sorted.slice(1);
    const totalProdTime = sorted.reduce(
      (sum, r) => sum + (r.productionTimeMinutes ?? r.estMinutes ?? 0),
      0,
    );
    // SOFA cross-PO merge needs to count each PO ONCE, not once per WIP node.
    // backfillJobCardsForPo creates one FAB_CUT JC per WIP component
    // (SOFA_BASE / SOFA_CUSHION / SOFA_ARMREST), so a 6-PO sofa group can
    // surface as 18 rows here — collapse to 1 row per productionOrderId
    // before computing wipQty / label so:
    //   - wipQty = sum of unique PO line qtys (= 6, not 18)
    //   - label  = joinModelLabel of unique PO productCodes (= 6 entries
    //              repeated by line qty, not 18 = 3 WIPs × 6 POs).
    // BF/ACC same-PO merge keeps the per-row min logic — set count semantics
    // (HB qty=1 + DV qty=2 → min=1 set) was correct for per-WIP rows.
    const isSofaForQty = (anchor.poItemCategory ?? "") === "SOFA";
    const perPoRows = isSofaForQty
      ? Array.from(
          sorted
            .reduce((m, r) => {
              if (!m.has(r.productionOrderId)) m.set(r.productionOrderId, r);
              return m;
            }, new Map<string, FcRow>())
            .values(),
        )
      : sorted;
    const newWipQty = isSofaForQty
      ? perPoRows.reduce((sum, r) => sum + (r.wipQty || 1), 0)
      : Math.min(...sorted.map((r) => r.wipQty || 1));
    const productCodes = perPoRows.map((r) => r.poProductCode ?? "");
    const modelLabel = joinModelLabel(productCodes);
    const totalH =
      (anchor.poGapInches ?? 0) +
      (anchor.poDivanHeightInches ?? 0) +
      (anchor.poLegHeightInches ?? 0);
    const isBF = (anchor.poItemCategory ?? "") === "BEDFRAME";
    const newWipLabel = buildFcWipLabel(
      modelLabel,
      anchor.poSizeLabel ?? "",
      totalH,
      anchor.poDivanHeightInches,
      anchor.poFabricCode ?? "",
      isBF,
    );
    const baseModel = anchor.bomBaseModel || anchor.poProductCode || "";
    const isSofa = (anchor.poItemCategory ?? "") === "SOFA";
    const newWipKey = isSofa
      ? `${anchor.poCompanySOId ?? anchor.poSalesOrderId}::${baseModel}::${anchor.poFabricCode ?? ""}::FAB_CUT`
      : `${anchor.productionOrderId}::${baseModel}::${anchor.poFabricCode ?? ""}::FAB_CUT`;
    // If ANY child already DONE, the merged JC carries that DONE state +
    // earliest completedDate. Otherwise WAITING.
    const doneRows = sorted.filter(
      (r) => r.status === "COMPLETED" || r.status === "TRANSFERRED",
    );
    const status = doneRows.length === sorted.length ? "COMPLETED" : "WAITING";
    const completedDate =
      status === "COMPLETED"
        ? doneRows
            .map((r) => r.completedDate)
            .filter((d): d is string => !!d)
            .sort()[0] ?? null
        : null;
    const dueDate =
      sorted
        .map((r) => r.dueDate)
        .filter((d): d is string => !!d)
        .sort()[0] ?? null;
    plans.push({
      mergeKey,
      anchorJcId: anchor.id,
      siblingJcIds: siblings.map((r) => r.id),
      newWipKey,
      newWipLabel,
      // BEDFRAME / SOFA / ACCESSORY — set-level category. Falls back to
      // the anchor's wipType only when itemCategory is somehow missing
      // (legacy seed without proper category).
      newWipType:
        anchor.poItemCategory ?? anchor.wipType ?? "FAB_CUT",
      newWipQty,
      newProdTime: totalProdTime,
      completedDate,
      status,
      dueDate,
      pieceCount: sorted.length,
    });
  }

  if (dryRun) {
    return c.json({
      mode: "dry-run",
      totalFcJcs: allRows.length,
      skippedNoSO,
      groupsTotal: groups.size,
      groupsAlreadyMerged: alreadyMerged,
      groupsToMerge: plans.length,
      jcsToDelete: plans.reduce((s, p) => s + p.siblingJcIds.length, 0),
      sample: plans.slice(0, 10),
    });
  }

  // Execute. UPDATE each anchor with merged fields + DELETE all siblings.
  // Wrap each group's writes in a single batch so a partial failure
  // doesn't leave a half-merged group.
  let mergedGroups = 0;
  let deletedSiblings = 0;
  const errors: { mergeKey: string; error: string }[] = [];
  for (const plan of plans) {
    try {
      const stmts: D1PreparedStatement[] = [
        db
          // completedAt travels with completedDate in every statement that
          // writes the date. This merge rebuilds an anchor card from a PLAN
          // (the earliest sibling's date), not from an observation, so the
          // instant is dropped rather than guessed.
          .prepare(
            `UPDATE job_cards
                SET wipKey = ?, wipLabel = ?, wipType = ?, wipQty = ?,
                    productionTimeMinutes = ?, estMinutes = ?,
                    actualMinutes = ?,
                    status = ?, completedDate = ?, completedAt = NULL, dueDate = ?,
                    sequence = 0, prerequisiteMet = 1,
                    branchKey = ''
              WHERE id = ?`,
          )
          .bind(
            plan.newWipKey,
            plan.newWipLabel,
            plan.newWipType,
            plan.newWipQty,
            plan.newProdTime,
            plan.newProdTime,
            plan.status === "COMPLETED" ? plan.newProdTime : null,
            plan.status,
            plan.completedDate,
            plan.dueDate,
            plan.anchorJcId,
          ),
      ];
      for (const id of plan.siblingJcIds) {
        stmts.push(
          db.prepare("DELETE FROM job_cards WHERE id = ?").bind(id),
        );
      }
      await db.batch(stmts);
      mergedGroups++;
      deletedSiblings += plan.siblingJcIds.length;
    } catch (err) {
      errors.push({
        mergeKey: plan.mergeKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    mode: "executed",
    totalFcJcs: allRows.length,
    skippedNoSO,
    groupsTotal: groups.size,
    groupsAlreadyMerged: alreadyMerged,
    groupsToMerge: plans.length,
    mergedGroups,
    deletedSiblings,
    errors,
  });
});

app.post("/backfill-fc-label-refresh", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const orgId = getOrgId(c);
  const dryRun = c.req.query("dryRun") === "true";

  // 1. Pull every FAB_CUT JC with its anchor PO context. Each JC has ONE
  //    anchor PO (productionOrderId). For SOFA cross-PO merged JCs the
  //    anchor is whichever PO won the deterministic jcId seed; siblings
  //    are NOT in job_cards anymore (they were lumped into the anchor),
  //    so we'll find them by querying production_orders separately.
  const jcRowsRes = await db
    .prepare(
      `SELECT
         jc.id, jc.productionOrderId, jc.wipLabel, jc.wipQty,
         jc.productionTimeMinutes, jc.estMinutes,
         po.productCode       AS "poProductCode",
         po.fabricCode        AS "poFabricCode",
         po.sizeLabel         AS "poSizeLabel",
         po.gapInches         AS "poGapInches",
         po.divanHeightInches AS "poDivanHeightInches",
         po.legHeightInches   AS "poLegHeightInches",
         po.itemCategory      AS "poItemCategory",
         po.companySOId       AS "poCompanySOId",
         po.salesOrderId      AS "poSalesOrderId",
         po.companyCOId       AS "poCompanyCOId",
         po.consignmentOrderId AS "poConsignmentOrderId",
         bt.baseModel         AS "bomBaseModel"
       FROM job_cards jc
       JOIN production_orders po ON po.id = jc.productionOrderId
       LEFT JOIN bom_templates bt
         ON bt.productCode = po.productCode
        AND bt.versionStatus = 'ACTIVE'
       WHERE jc.departmentCode = 'FAB_CUT'
         AND jc.orgId = ?`,
    )
    .bind(orgId)
    .all<FcRefreshJcRow>();
  const jcRows = jcRowsRes.results ?? [];

  // 2. Pull all production_orders (org-scoped) with their baseModel so we
  //    can reconstruct each merge group's full PO list. SOFA merged JCs
  //    span multiple POs that share (companySOId, baseModel, fabricCode).
  const posRes = await db
    .prepare(
      `SELECT
         po.id, po.productCode, po.companySOId, po.salesOrderId,
         po.companyCOId, po.consignmentOrderId, po.fabricCode,
         po.itemCategory,
         bt.baseModel AS "bomBaseModel"
       FROM production_orders po
       LEFT JOIN bom_templates bt
         ON bt.productCode = po.productCode
        AND bt.versionStatus = 'ACTIVE'
       WHERE po.orgId = ?`,
    )
    .bind(orgId)
    .all<PoRow>();
  const allPos = posRes.results ?? [];

  // 3. Build groupKey → PO rows index. Same keying as production-builder
  //    `aggregateFcSlots`:
  //      SOFA  → SOFA::{parentDocKey}::{baseModel}::{fabric}
  //      BF/ACC → PO::{poId}
  const groupKeyForPo = (po: PoRow): string => {
    const isSofa = (po.itemCategory ?? "") === "SOFA";
    if (!isSofa) return `PO::${po.id}`;
    const parentDocKey =
      po.companySOId ??
      po.salesOrderId ??
      po.companyCOId ??
      po.consignmentOrderId ??
      "";
    const baseModel = po.bomBaseModel || po.productCode || "";
    const fabric = po.fabricCode ?? "";
    return `SOFA::${parentDocKey}::${baseModel}::${fabric}`;
  };
  const posByGroup = new Map<string, PoRow[]>();
  for (const po of allPos) {
    const key = groupKeyForPo(po);
    if (!posByGroup.has(key)) posByGroup.set(key, []);
    posByGroup.get(key)!.push(po);
  }

  // 4. For each FC JC, compute the merge groupKey from its anchor PO,
  //    pull the PO list from the index, and rebuild the label.
  type Plan = {
    jcId: string;
    groupKey: string;
    poCount: number;
    oldLabel: string;
    newLabel: string;
    oldQty: number;
    newQty: number;
    oldProdTime: number | null;
    newProdTime: number;
  };
  const plans: Plan[] = [];
  let skippedNoAnchorPo = 0;
  let skippedNoGroup = 0;
  let unchanged = 0;

  for (const jc of jcRows) {
    if (!jc.poItemCategory) {
      // PO context missing — can't recompute, skip rather than corrupt.
      skippedNoAnchorPo++;
      continue;
    }
    const anchorPo: PoRow = {
      id: jc.productionOrderId,
      productCode: jc.poProductCode,
      companySOId: jc.poCompanySOId,
      salesOrderId: jc.poSalesOrderId,
      companyCOId: jc.poCompanyCOId,
      consignmentOrderId: jc.poConsignmentOrderId,
      fabricCode: jc.poFabricCode,
      itemCategory: jc.poItemCategory,
      bomBaseModel: jc.bomBaseModel,
    };
    const key = groupKeyForPo(anchorPo);
    const groupPos = posByGroup.get(key);
    if (!groupPos || groupPos.length === 0) {
      skippedNoGroup++;
      continue;
    }
    // Per-PO collapse: each PO contributes ONE productCode entry to the
    // label. Sort by id so the order is deterministic across runs (and
    // matches createdAt for the SO line order, since poIds are seeded
    // pord-{soId}-{NN}).
    const sortedPos = [...groupPos].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const productCodes = sortedPos
      .map((p) => p.productCode ?? "")
      .filter(Boolean);
    const modelLabel = joinModelLabel(productCodes);
    const isBF = (jc.poItemCategory ?? "") === "BEDFRAME";
    const totalH =
      (jc.poGapInches ?? 0) +
      (jc.poDivanHeightInches ?? 0) +
      (jc.poLegHeightInches ?? 0);
    const newLabel = buildFcWipLabel(
      modelLabel,
      jc.poSizeLabel ?? "",
      totalH,
      jc.poDivanHeightInches,
      jc.poFabricCode ?? "",
      isBF,
    );

    // wipQty:
    //   SOFA → 1 set per PO (SOFA qty=1 enforced upstream) → poCount.
    //   BF/ACC → group is 1 PO, qty stays as it was (cascade-correct).
    const isSofa = (jc.poItemCategory ?? "") === "SOFA";
    const newQty = isSofa ? sortedPos.length : jc.wipQty;

    // productionTimeMinutes — wasn't part of the cascade bug, but if the
    // backfill-fab-cut-merge endpoint stamped a value derived from
    // inflated slot rows it may be too high. Leave it as-is unless the
    // operator explicitly requests a recompute via a future flag.
    const newProdTime =
      jc.productionTimeMinutes ?? jc.estMinutes ?? 0;

    if (newLabel === jc.wipLabel && newQty === jc.wipQty) {
      unchanged++;
      continue;
    }
    plans.push({
      jcId: jc.id,
      groupKey: key,
      poCount: sortedPos.length,
      oldLabel: jc.wipLabel,
      newLabel,
      oldQty: jc.wipQty,
      newQty,
      oldProdTime: jc.productionTimeMinutes,
      newProdTime,
    });
  }

  if (dryRun) {
    return c.json({
      mode: "dry-run",
      totalFcJcs: jcRows.length,
      totalPos: allPos.length,
      groupsIndexed: posByGroup.size,
      skippedNoAnchorPo,
      skippedNoGroup,
      unchanged,
      toUpdate: plans.length,
      sample: plans.slice(0, 20),
    });
  }

  // Execute. Only UPDATE wipLabel + wipQty — leave status / completedDate /
  // PIC / dueDate / sequence untouched so in-progress JCs keep their
  // scanned state.
  let updated = 0;
  const errors: { jcId: string; error: string }[] = [];
  for (const plan of plans) {
    try {
      await db
        .prepare(
          `UPDATE job_cards
              SET wipLabel = ?, wipQty = ?
            WHERE id = ?`,
        )
        .bind(plan.newLabel, plan.newQty, plan.jcId)
        .run();
      updated++;
    } catch (err) {
      errors.push({
        jcId: plan.jcId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    mode: "executed",
    totalFcJcs: jcRows.length,
    totalPos: allPos.length,
    groupsIndexed: posByGroup.size,
    skippedNoAnchorPo,
    skippedNoGroup,
    unchanged,
    toUpdate: plans.length,
    updated,
    errors,
  });
});

app.post("/backfill-split-multi-qty", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // 1. Find all non-SOFA POs with quantity > 1. Sofa stays single-PO by
  //    design (one set per line), so its quantity carries through unchanged.
  const candRes = await db
    .prepare(
      `SELECT id AS "poId", poNo, salesOrderId, consignmentOrderId,
              status, quantity, itemCategory
         FROM production_orders
        WHERE itemCategory <> 'SOFA'
          AND quantity > 1`,
    )
    .all<SplitCandidatePo>();
  const candidates = candRes.results ?? [];

  // 2. Group by source-order id (SO or CO). The cascade re-run operates
  //    at the order level — one rebuild emits all the order's POs together,
  //    so we can't split SO-A and SO-B work independently if both happen
  //    to need the fix.
  const bySource = new Map<string, SplitCandidatePo[]>();
  for (const p of candidates) {
    const sourceId = p.salesOrderId ?? p.consignmentOrderId ?? "";
    if (!sourceId) continue; // Orphan PO — skip; nothing to re-cascade.
    if (!bySource.has(sourceId)) bySource.set(sourceId, []);
    bySource.get(sourceId)!.push(p);
  }

  type Plan = {
    sourceType: "SO" | "CO";
    sourceId: string;
    sourceNumber: string | null;
    affectedPoNos: string[];
    skipReason?: string;
  };
  const plans: Plan[] = [];

  for (const [sourceId, pos] of bySource.entries()) {
    const sourceType: "SO" | "CO" = pos[0].salesOrderId ? "SO" : "CO";
    const sourceNumber = pos[0].poNo.replace(/-\d+$/, "");

    // Pre-flight A: all POs of this SO must be PENDING. Any IN_PROGRESS /
    // COMPLETED / CANCELLED row means hand-edits or partial work — skip.
    const allPosForSource = await db
      .prepare(
        `SELECT id, status FROM production_orders
          WHERE ${sourceType === "SO" ? "salesOrderId" : "consignmentOrderId"} = ?`,
      )
      .bind(sourceId)
      .all<{ id: string; status: string }>();
    const allPos = allPosForSource.results ?? [];
    const nonPending = allPos.filter((p) => p.status !== "PENDING");
    if (nonPending.length > 0) {
      plans.push({
        sourceType,
        sourceId,
        sourceNumber,
        affectedPoNos: pos.map((p) => p.poNo),
        skipReason: `${nonPending.length} non-PENDING PO(s) on this order — skipping to preserve in-flight work`,
      });
      continue;
    }
    const allPoIds = allPos.map((p) => p.id);
    const placeholders = allPoIds.map(() => "?").join(", ");

    // Pre-flight B: no JC has been scanned (pic1Id or pic2Id set).
    if (allPoIds.length > 0) {
      const scannedRes = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM job_cards
            WHERE productionOrderId IN (${placeholders})
              AND (pic1Id IS NOT NULL OR pic2Id IS NOT NULL)`,
        )
        .bind(...allPoIds)
        .first<{ n: number }>();
      if ((scannedRes?.n ?? 0) > 0) {
        plans.push({
          sourceType,
          sourceId,
          sourceNumber,
          affectedPoNos: pos.map((p) => p.poNo),
          skipReason: `${scannedRes?.n} job card(s) already scanned — pic data would be lost`,
        });
        continue;
      }
    }

    // Pre-flight C: no cost_ledger entry references any of these POs.
    if (allPoIds.length > 0) {
      const ledgerRes = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM cost_ledger
            WHERE refType = 'PRODUCTION_ORDER'
              AND refId IN (${placeholders})`,
        )
        .bind(...allPoIds)
        .first<{ n: number }>();
      if ((ledgerRes?.n ?? 0) > 0) {
        plans.push({
          sourceType,
          sourceId,
          sourceNumber,
          affectedPoNos: pos.map((p) => p.poNo),
          skipReason: `${ledgerRes?.n} cost_ledger entries reference these POs — refusing to delete`,
        });
        continue;
      }
    }

    // Pre-flight D: every fg_unit on these POs must still be PENDING.
    // fg_units rows are stubbed at PO-fan-out time (one per piece) so any
    // PO will have rows; only PENDING means no physical FG exists yet.
    // PACKED / LOADED / DELIVERED / RETURNED / UPHOLSTERED means real-world
    // work the operator should not lose. fg_scan_history CASCADEs on
    // fg_unit_id so deleting PENDING fg_units cleans its history too.
    if (allPoIds.length > 0) {
      const fguRes = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM fg_units
            WHERE po_id IN (${placeholders}) AND status <> 'PENDING'`,
        )
        .bind(...allPoIds)
        .first<{ n: number }>();
      if ((fguRes?.n ?? 0) > 0) {
        plans.push({
          sourceType,
          sourceId,
          sourceNumber,
          affectedPoNos: pos.map((p) => p.poNo),
          skipReason: `${fguRes?.n} fg_unit(s) past PENDING — refusing to delete (real FG exists)`,
        });
        continue;
      }
    }

    // Pre-flight E: no fg_batches row points at these POs. Only created
    // on PO completion which the PENDING guard above already excludes,
    // but a stray row would FK-block the DELETE.
    if (allPoIds.length > 0) {
      const fgbRes = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM fg_batches
            WHERE production_order_id IN (${placeholders})`,
        )
        .bind(...allPoIds)
        .first<{ n: number }>();
      if ((fgbRes?.n ?? 0) > 0) {
        plans.push({
          sourceType,
          sourceId,
          sourceNumber,
          affectedPoNos: pos.map((p) => p.poNo),
          skipReason: `${fgbRes?.n} fg_batches row(s) reference these POs — refusing to delete`,
        });
        continue;
      }
    }

    plans.push({
      sourceType,
      sourceId,
      sourceNumber,
      affectedPoNos: pos.map((p) => p.poNo),
    });
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      candidatePoCount: candidates.length,
      affectedSourceCount: bySource.size,
      plans,
    });
  }

  // Execute. Per-source rebuild: hard-delete all POs (cascade kills JCs +
  // piece_pics), then call createProductionOrdersForOrder which fans out
  // fresh POs through the modern split path.
  const executed: Array<{
    sourceId: string;
    sourceNumber: string | null;
    deletedPoCount: number;
    createdPoNos: string[];
  }> = [];
  const skipped: Plan[] = [];

  for (const plan of plans) {
    if (plan.skipReason) {
      skipped.push(plan);
      continue;
    }
    if (plan.sourceType !== "SO") {
      skipped.push({ ...plan, skipReason: "CO re-cascade not implemented in this backfill" });
      continue;
    }

    // Re-load SO header + items.
    const so = await db
      .prepare(`SELECT * FROM sales_orders WHERE id = ?`)
      .bind(plan.sourceId)
      .first<{
        id: string;
        companySOId: string | null;
        companySODate: string | null;
        customerPOId: string | null;
        reference: string | null;
        customerName: string;
        customerState: string | null;
        hookkaExpectedDD: string | null;
        customerDeliveryDate: string | null;
      }>();
    if (!so) {
      skipped.push({ ...plan, skipReason: "Source SO not found" });
      continue;
    }
    const itemsRes = await db
      .prepare(`SELECT * FROM sales_order_items WHERE salesOrderId = ?`)
      .bind(plan.sourceId)
      .all<{
        lineNo: number;
        productId: string | null;
        productCode: string | null;
        productName: string | null;
        itemCategory: string | null;
        sizeCode: string | null;
        sizeLabel: string | null;
        fabricCode: string | null;
        quantity: number;
        gapInches: number | null;
        divanHeightInches: number | null;
        legHeightInches: number | null;
        specialOrder: string | null;
        notes: string | null;
      }>();
    const items = itemsRes.results ?? [];
    if (items.length === 0) {
      skipped.push({ ...plan, skipReason: "Source SO has no items" });
      continue;
    }

    // Re-run cascade FIRST (it does pure reads + builds statements). We then
    // run DELETE + the cascade INSERTs together in one batch so a partial
    // failure can't leave the SO with deleted POs and no replacements.
    // forceRebuild=true so the builder doesn't bail on the about-to-be-
    // deleted POs; deterministic poIds (pord-{soId}-NN) collide with the
    // existing rows but the DELETE in the same batch frees them first.
    const built = await createProductionOrdersForOrder(
      db,
      {
        id: so.id,
        sourceType: "SO",
        companyOrderId: so.companySOId ?? "",
        companyOrderDate: so.companySODate,
        customerPOId: so.customerPOId,
        reference: so.reference,
        customerName: so.customerName,
        customerState: so.customerState,
        hookkaExpectedDD: so.hookkaExpectedDD,
        customerDeliveryDate: so.customerDeliveryDate,
      },
      items.map((it) => ({
        lineNo: it.lineNo,
        productId: it.productId,
        productCode: it.productCode,
        productName: it.productName,
        itemCategory: it.itemCategory,
        sizeCode: it.sizeCode,
        sizeLabel: it.sizeLabel,
        fabricCode: it.fabricCode,
        quantity: it.quantity,
        gapInches: it.gapInches,
        divanHeightInches: it.divanHeightInches,
        legHeightInches: it.legHeightInches,
        specialOrder: it.specialOrder,
        notes: it.notes,
      })),
      { forceRebuild: true },
    );
    // Delete order matters: fg_units → production_orders. fg_units.po_id is
    // a NOT-NULL FK with no CASCADE, so it has to come out first or the
    // PO DELETE FK-fails. fg_scan_history CASCADEs on fg_unit_id and
    // job_cards CASCADE on productionOrderId (piece_pics in turn CASCADE
    // on jobCardId), so those subtrees clean up by themselves.
    const deleteFgUnitsStmt = db
      .prepare(
        `DELETE FROM fg_units WHERE po_id IN (
           SELECT id FROM production_orders WHERE salesOrderId = ?)`,
      )
      .bind(plan.sourceId);
    const deletePosStmt = db
      .prepare(`DELETE FROM production_orders WHERE salesOrderId = ?`)
      .bind(plan.sourceId);
    await db.batch([deleteFgUnitsStmt, deletePosStmt, ...built.statements]);

    executed.push({
      sourceId: plan.sourceId,
      sourceNumber: plan.sourceNumber,
      deletedPoCount: plan.affectedPoNos.length,
      createdPoNos: built.created.map((c) => c.poNo),
    });
  }

  return c.json({
    success: true,
    dryRun: false,
    candidatePoCount: candidates.length,
    affectedSourceCount: bySource.size,
    executedCount: executed.length,
    skippedCount: skipped.length,
    executed,
    skipped,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/audit-orphan-fabric-codes
//
// Read-only diagnostic. Scans production_orders, sales_order_items, and
// consignment_order_items for any non-empty `fabricCode` that does NOT
// resolve to a row in `raw_materials` with a fabric `itemGroup`. For each
// orphan, suggests a canonical match by stripping leading zeros from the
// LAST hyphen-separated segment (the historical typo pattern: M2402-04
// instead of M2402-4).
//
// Response:
//   {
//     totalOrphanRecords: <sum of affectedTables across all codes>,
//     byCode: [
//       {
//         wrongCode, suggestedCode (or null), isSafeTypo,
//         affectedTables: { production_orders, sales_order_items,
//                           consignment_order_items }
//       }
//     ]
//   }
//
// `isSafeTypo` is true ONLY when the leading-zero-stripped form is
// already a valid raw_material — caller can then auto-apply via the
// `/apply-fabric-code-fixes` endpoint without manual review. Anything
// else (pattern doesn't match, or the stripped form still doesn't exist)
// returns isSafeTypo=false and requires a human-supplied mapping.
// ---------------------------------------------------------------------------
app.post("/audit-orphan-fabric-codes", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;

  // 1. Pull every distinct non-empty fabricCode used across the three tables,
  //    along with per-table row counts. UNION ALL preserves duplicates so we
  //    can sum them per-code in one pass.
  const usageRes = await db
    .prepare(
      `SELECT fabricCode, source, n FROM (
         SELECT fabricCode AS fabricCode, 'production_orders' AS source,
                COUNT(*) AS n
           FROM production_orders
          WHERE fabricCode IS NOT NULL AND fabricCode <> ''
          GROUP BY fabricCode
         UNION ALL
         SELECT fabricCode AS fabricCode, 'sales_order_items' AS source,
                COUNT(*) AS n
           FROM sales_order_items
          WHERE fabricCode IS NOT NULL AND fabricCode <> ''
          GROUP BY fabricCode
         UNION ALL
         SELECT fabricCode AS fabricCode, 'consignment_order_items' AS source,
                COUNT(*) AS n
           FROM consignment_order_items
          WHERE fabricCode IS NOT NULL AND fabricCode <> ''
          GROUP BY fabricCode
       ) t`,
    )
    .all<{ fabricCode: string; source: string; n: number }>();
  const usageRows = usageRes.results ?? [];

  // 2. Pull the canonical fabric set from raw_materials so we can both
  //    (a) classify orphans and (b) verify safe-typo suggestions.
  const rmRes = await db
    .prepare(
      `SELECT itemCode FROM raw_materials
        WHERE itemCode IS NOT NULL
          AND itemGroup IN ('B.M-FABR','S-FABR','S.M-FABR','LINING','WEBBING')`,
    )
    .all<{ itemCode: string | null }>();
  const knownCodes = new Set<string>();
  for (const r of rmRes.results ?? []) {
    if (r.itemCode) knownCodes.add(r.itemCode);
  }

  // 3. Aggregate per-code counts, filtering to orphans (codes not in
  //    raw_materials).
  type Counts = {
    production_orders: number;
    sales_order_items: number;
    consignment_order_items: number;
  };
  const byCode = new Map<string, Counts>();
  for (const u of usageRows) {
    if (!u.fabricCode || knownCodes.has(u.fabricCode)) continue;
    let agg = byCode.get(u.fabricCode);
    if (!agg) {
      agg = {
        production_orders: 0,
        sales_order_items: 0,
        consignment_order_items: 0,
      };
      byCode.set(u.fabricCode, agg);
    }
    if (u.source === "production_orders") agg.production_orders += Number(u.n) || 0;
    else if (u.source === "sales_order_items") agg.sales_order_items += Number(u.n) || 0;
    else if (u.source === "consignment_order_items")
      agg.consignment_order_items += Number(u.n) || 0;
  }

  // 4. Suggestion rule — strip leading zeros from the LAST hyphen-separated
  //    segment. If the stripped form already exists in raw_materials,
  //    flag isSafeTypo=true. Anything else returns suggestedCode=null.
  const suggestFor = (wrong: string): string | null => {
    const idx = wrong.lastIndexOf("-");
    if (idx < 0 || idx === wrong.length - 1) return null;
    const head = wrong.slice(0, idx);
    const tail = wrong.slice(idx + 1);
    // Only strip when the tail is purely digits with at least one leading zero.
    if (!/^0+\d+$/.test(tail)) return null;
    const stripped = String(parseInt(tail, 10));
    return `${head}-${stripped}`;
  };

  const result: Array<{
    wrongCode: string;
    suggestedCode: string | null;
    isSafeTypo: boolean;
    affectedTables: Counts;
  }> = [];
  let totalOrphanRecords = 0;
  // Stable ordering for human review — alpha by wrongCode.
  const orphanCodes = Array.from(byCode.keys()).sort();
  for (const wrongCode of orphanCodes) {
    const counts = byCode.get(wrongCode)!;
    const sum =
      counts.production_orders +
      counts.sales_order_items +
      counts.consignment_order_items;
    totalOrphanRecords += sum;
    const candidate = suggestFor(wrongCode);
    const isSafeTypo = candidate !== null && knownCodes.has(candidate);
    result.push({
      wrongCode,
      suggestedCode: isSafeTypo ? candidate : null,
      isSafeTypo,
      affectedTables: counts,
    });
  }

  return c.json({
    totalOrphanRecords,
    byCode: result,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/apply-fabric-code-fixes
//
// Body: { mapping: { "M2402-04": "M2402-4", ... }, dryRun?: boolean }
//
// For each wrongCode → correctCode pair:
//   1. Re-validate that correctCode exists in raw_materials with a fabric
//      itemGroup (don't trust the caller — a hand-rolled mapping could
//      otherwise sneak an orphan code into the orphan-fix path).
//   2. Run UPDATEs against production_orders, sales_order_items,
//      consignment_order_items in a single db.batch() — the three writes
//      either all land or none do, so a partial cascade can't desync the
//      tables.
//   3. Collect affected production_orders.id values so the caller can
//      regen job-cards / fabric-cut JCs downstream (the regen itself is
//      out of scope for this endpoint — it's a separate cascade).
//
// Returns:
//   {
//     applied: [
//       { from, to, rowsUpdated: { ... }, affectedPoIds: [...] }
//     ],
//     rejected: [
//       { from, to, reason }
//     ]
//   }
// ---------------------------------------------------------------------------
app.post("/apply-fabric-code-fixes", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  type Body = {
    mapping?: Record<string, string>;
    dryRun?: boolean;
  };
  let body: Body = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as Body;
  } catch {
    body = {};
  }
  const dryRun = body?.dryRun === true;
  const mapping = body?.mapping && typeof body.mapping === "object"
    ? body.mapping
    : {};
  const pairs = Object.entries(mapping)
    .filter(
      ([from, to]) =>
        typeof from === "string" &&
        typeof to === "string" &&
        from.trim() !== "" &&
        to.trim() !== "",
    )
    .map(([from, to]) => ({ from: from.trim(), to: to.trim() }));

  if (pairs.length === 0) {
    return c.json({
      success: false,
      error: "mapping is required and must contain at least one non-empty pair",
    }, 400);
  }

  const db = c.var.DB;

  // Pre-validate every target in one round-trip — cheap and lets us reject
  // bad pairs before attempting any UPDATEs. Note we ONLY check the target
  // (`to`) side: the source (`from`) is by definition an orphan, that's
  // why we're fixing it.
  const targetCheck = await validateFabricCodes(
    db,
    pairs.map((p) => p.to),
  );
  const unknownTargets = new Set(targetCheck.unknown);

  const applied: Array<{
    from: string;
    to: string;
    rowsUpdated: {
      production_orders: number;
      sales_order_items: number;
      consignment_order_items: number;
    };
    affectedPoIds: string[];
  }> = [];
  const rejected: Array<{ from: string; to: string; reason: string }> = [];

  for (const pair of pairs) {
    if (pair.from === pair.to) {
      rejected.push({
        from: pair.from,
        to: pair.to,
        reason: "from and to are identical — nothing to do",
      });
      continue;
    }
    if (unknownTargets.has(pair.to)) {
      rejected.push({
        from: pair.from,
        to: pair.to,
        reason: "target not in raw_materials",
      });
      continue;
    }

    // Snapshot affected PO ids BEFORE the UPDATE — caller needs them for
    // downstream JC regen. Doing this read in dryRun mode too returns the
    // same ids the live mode would touch.
    const affectedRes = await db
      .prepare(
        `SELECT id FROM production_orders WHERE fabricCode = ?`,
      )
      .bind(pair.from)
      .all<{ id: string }>();
    const affectedPoIds = (affectedRes.results ?? []).map((r) => r.id);

    // Count rows that would change in each table. For the dryRun path we
    // return these counts without writing; for the live path we use them
    // as the expected-rowcount report (db.batch results don't always
    // surface row counts on the postgres compat shim, so we count here).
    const [poCountRes, soiCountRes, coiCountRes] = await Promise.all([
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM production_orders WHERE fabricCode = ?",
        )
        .bind(pair.from)
        .first<{ n: number }>(),
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sales_order_items WHERE fabricCode = ?",
        )
        .bind(pair.from)
        .first<{ n: number }>(),
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM consignment_order_items WHERE fabricCode = ?",
        )
        .bind(pair.from)
        .first<{ n: number }>(),
    ]);
    const rowsUpdated = {
      production_orders: Number(poCountRes?.n) || 0,
      sales_order_items: Number(soiCountRes?.n) || 0,
      consignment_order_items: Number(coiCountRes?.n) || 0,
    };

    if (!dryRun) {
      // Atomic three-statement batch — production_orders, sales_order_items,
      // consignment_order_items must all flip together. db.batch() is the
      // closest primitive the pg compat shim exposes to a transaction; if
      // any statement throws, the whole batch fails and we surface the
      // pair as rejected.
      try {
        await db.batch([
          db
            .prepare(
              "UPDATE production_orders SET fabricCode = ? WHERE fabricCode = ?",
            )
            .bind(pair.to, pair.from),
          db
            .prepare(
              "UPDATE sales_order_items SET fabricCode = ? WHERE fabricCode = ?",
            )
            .bind(pair.to, pair.from),
          db
            .prepare(
              "UPDATE consignment_order_items SET fabricCode = ? WHERE fabricCode = ?",
            )
            .bind(pair.to, pair.from),
        ]);
      } catch (err) {
        rejected.push({
          from: pair.from,
          to: pair.to,
          reason:
            err instanceof Error
              ? `update batch failed: ${err.message}`
              : "update batch failed",
        });
        continue;
      }
    }

    applied.push({
      from: pair.from,
      to: pair.to,
      rowsUpdated,
      affectedPoIds,
    });
  }

  return c.json({
    dryRun,
    applied,
    rejected,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/delete-fg-units-by-ids
//
// Surgical fg_units cleanup — deletes only the explicit unit IDs passed in
// the body. Used after /correct-so-line-qty-cascade scaled a PO down: the
// FG cascade originally generated more units than actually exist, so we
// need to drop the over-counted ones.
//
// Body: { unitIds: string[], dryRun: boolean }
// Returns: { success, dryRun, deleted, errors }
//
// Permission: production-orders:update (FG mgmt is downstream of PO).
// ---------------------------------------------------------------------------
app.post("/delete-fg-units-by-ids", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: { unitIds?: unknown; dryRun?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const ids = Array.isArray(body.unitIds)
    ? body.unitIds.filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      )
    : null;
  if (!ids || ids.length === 0) {
    return c.json(
      { success: false, error: "body.unitIds must be a non-empty array" },
      400,
    );
  }
  const dryRun = body.dryRun === true;
  const db = c.var.DB;

  // Pre-flight: verify these units exist + check status (refuse to delete
  // anything beyond PACKED — DELIVERED/RETURNED/INVOICED are immutable
  // historical records).
  const placeholders = ids.map(() => "?").join(",");
  const existing = await db
    .prepare(
      `SELECT id, status, unit_serial AS unitSerial, po_id AS poId
         FROM fg_units WHERE id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{ id: string; status: string; unitSerial: string; poId: string }>();
  const rows = existing.results ?? [];
  const found = new Set(rows.map((r) => r.id));
  const notFound = ids.filter((id) => !found.has(id));
  const unsafeStatuses = ["DELIVERED", "RETURNED", "LOADED"];
  const unsafe = rows.filter((r) => unsafeStatuses.includes(r.status));
  if (unsafe.length > 0) {
    return c.json(
      {
        success: false,
        error: `Refuse to delete fg_units with status in ${unsafeStatuses.join("/")}: ${unsafe.map((u) => `${u.id}(${u.status})`).slice(0, 5).join(", ")}`,
      },
      409,
    );
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      requested: ids.length,
      found: rows.length,
      notFound,
      wouldDelete: rows.map((r) => ({
        id: r.id,
        unitSerial: r.unitSerial,
        status: r.status,
      })),
    });
  }

  // Live DELETE
  try {
    await db
      .prepare(`DELETE FROM fg_units WHERE id IN (${placeholders})`)
      .bind(...ids)
      .run();
  } catch (err) {
    return c.json(
      {
        success: false,
        error: `DELETE failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }

  return c.json({
    success: true,
    dryRun: false,
    requested: ids.length,
    found: rows.length,
    deleted: rows.length,
    notFound,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/regen-fg-units
//
// One-shot regenerator for fg_units rows. Use case: pieces logic changed
// (e.g. bedframe size auto-derive landed 2026-05-09) and existing fg_units
// were generated under the old logic. This endpoint deletes the in-stock
// fg_units (status='PACKED') for the given PO/SO scope and re-runs
// generateFGUnitsForPO so the new pieces config takes effect.
//
// Safety:
//   - Only deletes status='PACKED' rows. LOADED / DELIVERED / RETURNED
//     fg_units are physical state and must not be regenerated — caller
//     gets a `skipped` entry per PO that had non-PACKED units.
//   - fg_unit_events is FK CASCADE → automatic cleanup when an fg_unit
//     row is deleted.
//   - dryRun mode lists what would be done without writing.
//
// Body: { poIds?: string[], soIds?: string[], dryRun?: boolean }
//   - At least one of poIds / soIds must be provided.
//   - soIds resolved into the matching production_orders' poIds.
//   - dryRun defaults true.
//
// Per project_migration_in_progress: this is a one-shot tool, will be
// removed post-migration. Don't generalize.
// ---------------------------------------------------------------------------
app.post("/regen-fg-units", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: { poIds?: unknown; soIds?: unknown; dryRun?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // empty body OK
  }
  const dryRun = body.dryRun !== false;
  const poIdsIn = Array.isArray(body.poIds)
    ? body.poIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const soIdsIn = Array.isArray(body.soIds)
    ? body.soIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  if (poIdsIn.length === 0 && soIdsIn.length === 0) {
    return c.json(
      { success: false, error: "Provide at least one of body.poIds or body.soIds" },
      400,
    );
  }

  const db = c.var.DB;

  // Resolve SO ids → PO ids. Accept both internal id and companySOId.
  const resolvedPoIds = new Set<string>(poIdsIn);
  for (const soIdRaw of soIdsIn) {
    let soId: string | null = null;
    const direct = await db
      .prepare("SELECT id FROM sales_orders WHERE id = ? LIMIT 1")
      .bind(soIdRaw)
      .first<{ id: string }>();
    if (direct) {
      soId = direct.id;
    } else {
      const byCompany = await db
        .prepare("SELECT id FROM sales_orders WHERE companySOId = ? LIMIT 1")
        .bind(soIdRaw)
        .first<{ id: string }>();
      if (byCompany) soId = byCompany.id;
    }
    if (!soId) continue;
    const posRes = await db
      .prepare("SELECT id FROM production_orders WHERE salesOrderId = ?")
      .bind(soId)
      .all<{ id: string }>();
    for (const r of posRes.results ?? []) resolvedPoIds.add(r.id);
  }

  type PoResult = {
    poId: string;
    poNo?: string;
    status: "regenerated" | "skipped" | "error";
    deletedCount?: number;
    createdCount?: number;
    blockedByStatuses?: string[];
    error?: string;
  };
  const results: PoResult[] = [];

  for (const poId of resolvedPoIds) {
    try {
      // Bail if any fg_unit on this PO is already physically out the
      // door. PENDING / PENDING_UPHOLSTERY / UPHOLSTERED / PACKED all
      // mean the unit is still in our control (not yet on a delivery)
      // — safe to regen. LOADED / DELIVERED / RETURNED are physical
      // state past the packing line — keep their serials stable.
      const REGEN_SAFE = new Set([
        "PENDING",
        "PENDING_UPHOLSTERY",
        "UPHOLSTERED",
        "PACKED",
      ]);
      const unitsRes = await db
        .prepare("SELECT id, status FROM fg_units WHERE poId = ?")
        .bind(poId)
        .all<{ id: string; status: string }>();
      const units = unitsRes.results ?? [];
      const blocked = units.filter((u) => !REGEN_SAFE.has(u.status));
      if (blocked.length > 0) {
        results.push({
          poId,
          status: "skipped",
          blockedByStatuses: Array.from(new Set(blocked.map((b) => b.status))),
        });
        continue;
      }

      const poRow = await db
        .prepare("SELECT poNo FROM production_orders WHERE id = ?")
        .bind(poId)
        .first<{ poNo: string }>();

      if (dryRun) {
        results.push({
          poId,
          poNo: poRow?.poNo,
          status: "regenerated",
          deletedCount: units.length,
          createdCount: -1, // unknown until live run
        });
        continue;
      }

      // Live: delete then regen.
      await db
        .prepare("DELETE FROM fg_units WHERE poId = ?")
        .bind(poId)
        .run();
      const gen = await generateFGUnitsForPO(db, poId);
      results.push({
        poId,
        poNo: poRow?.poNo,
        status: "regenerated",
        deletedCount: units.length,
        createdCount: gen.units.length,
      });
    } catch (err) {
      results.push({
        poId,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun,
    scanned: resolvedPoIds.size,
    regenerated: results.filter((r) => r.status === "regenerated").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errors: results.filter((r) => r.status === "error").length,
    results,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-pillow-packing-jc
//
// Wei Siang spec (2026-05-10): pillow PACKING JCs should aggregate at
// (salesOrderId, productCode, fabricCode) level — one operator scan
// completes all matching pieces. Currently per-PO fan-out produces N
// separate PACKING JCs (one per pillow piece); operators want ONE JC
// with combined qty.
//
// Pillow detection: itemCategory='ACCESSORY' AND
//   (productCode LIKE '%PILLOW%' OR productName LIKE '%PILLOW%').
//
// For each (soId, productCode, fabricCode) group of pillow POs:
//   1. Find any existing PACKING JCs on those POs.
//   2. If exactly one aggregated JC already exists on the anchor PO
//      (wipKey starts with "pillow-pack-") → skip, idempotent.
//   3. Else: DELETE all existing PACKING JCs in the group, INSERT one
//      aggregated JC on the FIRST (anchor) PO with wipQty = sum.
//
// Body: { dryRun: boolean (default true) }
//
// Per project_migration_in_progress: one-shot, will be removed
// post-migration.
// ---------------------------------------------------------------------------
app.post("/backfill-pillow-packing-jc", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: { dryRun?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // empty body OK
  }
  const dryRun = body.dryRun !== false;
  const db = c.var.DB;

  // 1. Find PACKING department metadata.
  const packingDept = await db
    .prepare("SELECT id, code, name FROM departments WHERE code = 'PACKING' LIMIT 1")
    .first<{ id: string; code: string; name: string }>();
  if (!packingDept) {
    return c.json({ success: false, error: "PACKING department not found" }, 500);
  }

  // 2. Find all pillow POs.
  type PillowPO = {
    id: string;
    poNo: string;
    salesOrderId: string | null;
    productCode: string | null;
    productName: string | null;
    fabricCode: string | null;
    quantity: number;
    targetEndDate: string | null;
  };
  const posRes = await db
    .prepare(
      `SELECT id, poNo, salesOrderId, productCode, productName, fabricCode,
              quantity, targetEndDate
         FROM production_orders
         WHERE itemCategory = 'ACCESSORY'
           AND (UPPER(productCode) LIKE '%PILLOW%' OR UPPER(productName) LIKE '%PILLOW%')
           AND status <> 'CANCELLED'`,
    )
    .all<PillowPO>();
  const pillowPOs = posRes.results ?? [];

  // 3. Group by (salesOrderId, productCode, fabricCode).
  const groups = new Map<string, PillowPO[]>();
  for (const po of pillowPOs) {
    if (!po.salesOrderId) continue;
    const key = `${po.salesOrderId}::${po.productCode}::${po.fabricCode || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(po);
  }

  type GroupResult = {
    groupKey: string;
    soId: string;
    productCode: string | null;
    fabricCode: string | null;
    poCount: number;
    totalQty: number;
    status: "skipped" | "created" | "would-create" | "error";
    deletedJcCount?: number;
    aggregatedWipKey?: string;
    error?: string;
  };
  const results: GroupResult[] = [];

  for (const [groupKey, pos] of groups) {
    // Sort by id for deterministic anchor selection.
    pos.sort((a, b) => a.id.localeCompare(b.id));
    const anchor = pos[0];
    const totalQty = pos.reduce((s, p) => s + (p.quantity || 1), 0);
    const aggregatedWipKey =
      `pillow-pack-${anchor.salesOrderId}-${anchor.productCode}-${anchor.fabricCode || ""}`
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 200);

    // Find existing PACKING JCs on any PO in this group.
    const placeholders = pos.map(() => "?").join(",");
    const existingRes = await db
      .prepare(
        `SELECT id, productionOrderId, wipKey, wipQty
           FROM job_cards
           WHERE productionOrderId IN (${placeholders}) AND departmentCode = 'PACKING'`,
      )
      .bind(...pos.map((p) => p.id))
      .all<{ id: string; productionOrderId: string; wipKey: string; wipQty: number }>();
    const existing = existingRes.results ?? [];

    // Already correctly aggregated? (one JC on anchor with our wipKey)
    const hasAggregated =
      existing.length === 1 &&
      existing[0].productionOrderId === anchor.id &&
      existing[0].wipKey === aggregatedWipKey &&
      existing[0].wipQty === totalQty;
    if (hasAggregated) {
      results.push({
        groupKey,
        soId: anchor.salesOrderId!,
        productCode: anchor.productCode,
        fabricCode: anchor.fabricCode,
        poCount: pos.length,
        totalQty,
        status: "skipped",
      });
      continue;
    }

    if (dryRun) {
      results.push({
        groupKey,
        soId: anchor.salesOrderId!,
        productCode: anchor.productCode,
        fabricCode: anchor.fabricCode,
        poCount: pos.length,
        totalQty,
        status: "would-create",
        deletedJcCount: existing.length,
        aggregatedWipKey,
      });
      continue;
    }

    try {
      const stmts: D1PreparedStatement[] = [];
      // DELETE existing per-PO PACKING JCs.
      for (const jc of existing) {
        stmts.push(db.prepare("DELETE FROM job_cards WHERE id = ?").bind(jc.id));
      }
      // INSERT aggregated JC on anchor PO.
      const jcId = `jc-pilo-${anchor.id}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
      const wipLabel = `${anchor.productCode || ""} ${anchor.fabricCode || ""} x${totalQty}`.trim();
      stmts.push(
        db
          .prepare(
            `INSERT INTO job_cards (id, productionOrderId, departmentId, departmentCode,
                departmentName, sequence, status, dueDate, wipKey, wipCode, wipType, wipLabel,
                wipQty, prerequisiteMet, pic1Id, pic1Name, pic2Id, pic2Name, completedDate,
                estMinutes, actualMinutes, category, productionTimeMinutes, overdue, rackingNumber, branchKey)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            jcId,
            anchor.id,
            packingDept.id,
            "PACKING",
            packingDept.name,
            99, // high sequence — same as l1Process default
            "WAITING",
            anchor.targetEndDate,
            aggregatedWipKey,
            anchor.productCode || "",
            "FG",
            wipLabel,
            totalQty,
            0,
            null,
            "",
            null,
            "",
            null,
            0,
            null,
            "",
            0,
            "PENDING",
            null,
            "",
          ),
      );
      await db.batch(stmts);
      results.push({
        groupKey,
        soId: anchor.salesOrderId!,
        productCode: anchor.productCode,
        fabricCode: anchor.fabricCode,
        poCount: pos.length,
        totalQty,
        status: "created",
        deletedJcCount: existing.length,
        aggregatedWipKey,
      });
    } catch (err) {
      results.push({
        groupKey,
        soId: anchor.salesOrderId!,
        productCode: anchor.productCode,
        fabricCode: anchor.fabricCode,
        poCount: pos.length,
        totalQty,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun,
    scannedPOs: pillowPOs.length,
    scannedGroups: groups.size,
    created: results.filter((r) => r.status === "created").length,
    wouldCreate: results.filter((r) => r.status === "would-create").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errors: results.filter((r) => r.status === "error").length,
    results,
  });
});

export default app;
