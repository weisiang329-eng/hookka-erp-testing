import { Hono } from "hono";
import type { Env } from "../../worker";
import { requirePermission } from "../../lib/rbac";
import { applyWipInventoryChange, type JobCardRow, type ProductionOrderRow } from "../production-orders";
import { consumeRawMaterialsForPO, postJobCardLabor } from "../../lib/po-cost-cascade";
import { loadLeadTimes, type LeadTimeMap } from "../../lib/lead-times";
import { getOrgId } from "../../lib/tenant";
import { ensureJobCardCompletedAt } from "../../lib/job-card-completed-at";
import { breakBomIntoWips, type BomVariantContext } from "../../lib/bom-wip-breakdown";
import { findJobCardsByPO, loadProductionOrderById, CASCADE_DATE_CLAMP, addDaysISO, UPH_POFOLD_TARGET_DEPTS, UPH_POFOLD_DEPT_ORDER, type UphPofoldCandidate, type FcCandidate, type RefundCandidateRow, type RefundSiblingRow, type RebuildJcRow, type RebuildPoRow, type RebuildWipRow, type JcBackfillRow, type DriftSample, ACTIVE_JC_STATUSES, COMPLETED_JC_STATUSES, type RefreshJcRow } from "./_shared";

const app = new Hono<Env>();


app.post("/uph-pofold-backfill", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  // Migrations are inert on deploy (CLAUDE.md) — awaited before the UPDATE
  // below mentions completed_at.
  await ensureJobCardCompletedAt(db);
  const dryRun = c.req.query("dryRun") === "true";

  const leadTimes: LeadTimeMap = await loadLeadTimes(db);
  const ltLookup = (cat: string | null, dept: string | null): number | null => {
    if (!dept) return null;
    const normCat = (cat || "").toUpperCase() === "SOFA" ? "SOFA" : "BEDFRAME";
    const v = leadTimes[normCat]?.[dept];
    return typeof v === "number" && v >= 0 ? v : null;
  };

  // Per-WIP UPH anchor map: (productionOrderId, wipKey) → completedDate.
  // Only includes (PO, wipKey) where the UPH JC is COMPLETED/TRANSFERRED
  // with a non-null completedDate. wipKey is COALESCEd to '' so empty-key
  // rows still group cleanly.
  const uphAnchorRes = await db
    .prepare(
      `SELECT productionOrderId,
              COALESCE(wipKey,'') AS wk,
              completedDate AS "uphDate"
         FROM job_cards
        WHERE departmentCode = 'UPHOLSTERY'
          AND status IN ('COMPLETED','TRANSFERRED')
          AND completedDate IS NOT NULL`,
    )
    .all<{ productionOrderId: string; wk: string; uphDate: string }>();
  const uphAnchorMap = new Map<string, string>();
  for (const r of uphAnchorRes.results ?? []) {
    const raw = r as unknown as Record<string, unknown>;
    const date =
      typeof raw.uphDate === "string"
        ? (raw.uphDate as string)
        : typeof raw.uphdate === "string"
          ? (raw.uphdate as string)
          : null;
    if (!date) continue;
    uphAnchorMap.set(`${r.productionOrderId}||${r.wk}`, date);
  }

  // Candidate JCs: WAITING earlier-dept rows whose (PO, wipKey) has an
  // UPH anchor in the map above. Only six target depts.
  const candRes = await db
    .prepare(
      `SELECT j.id              AS id,
              j.productionOrderId AS productionOrderId,
              COALESCE(j.wipKey,'')  AS wipKey,
              j.branchKey       AS branchKey,
              j.departmentCode  AS departmentCode,
              j.wipType         AS wipType,
              po.itemCategory   AS itemCategory,
              j.sequence        AS sequence,
              j.estMinutes      AS estMinutes,
              j.productionTimeMinutes AS productionTimeMinutes
         FROM job_cards j
         LEFT JOIN production_orders po ON po.id = j.productionOrderId
        WHERE j.status = 'WAITING'
          AND j.completedDate IS NULL
          AND j.departmentCode IN ('FAB_CUT','FAB_SEW','WOOD_CUT','FOAM','FRAMING','WEBBING')`,
    )
    .all<Omit<UphPofoldCandidate, "anchorDate" | "newDate" | "actualMinutes" | "offsetDays" | "clampedToAnchor">>();
  const allWaiting = candRes.results ?? [];

  let noUphAnchorSkipped = 0;
  const plans: UphPofoldCandidate[] = [];
  const dateHistogram: Record<string, number> = {};
  const deptCounts: Record<string, number> = {};
  for (const cand of allWaiting) {
    const key = `${cand.productionOrderId}||${cand.wipKey ?? ""}`;
    const anchorDate = uphAnchorMap.get(key);
    if (!anchorDate) {
      // (PO, wipKey) has no completed UPH — that WIP is still in production,
      // skip per Policy B.
      noUphAnchorSkipped++;
      continue;
    }
    if (!UPH_POFOLD_TARGET_DEPTS.has(cand.departmentCode)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) continue;

    const ltAnchor = ltLookup(cand.itemCategory, "UPHOLSTERY");
    const ltTarget = ltLookup(cand.itemCategory, cand.departmentCode);
    let offset: number;
    let clamped = false;
    if (ltAnchor == null || ltTarget == null) {
      offset = 0;
    } else {
      offset = ltAnchor - ltTarget;
      if (offset > 0) {
        offset = 0;
        clamped = true;
      }
    }
    let newDate = addDaysISO(anchorDate, offset);
    if (newDate > CASCADE_DATE_CLAMP) newDate = CASCADE_DATE_CLAMP;

    const actualMinutes =
      cand.productionTimeMinutes != null
        ? cand.productionTimeMinutes
        : cand.estMinutes != null
          ? cand.estMinutes
          : 0;

    plans.push({
      ...cand,
      anchorDate,
      newDate,
      actualMinutes,
      offsetDays: offset,
      clampedToAnchor: clamped,
    });
    dateHistogram[newDate] = (dateHistogram[newDate] ?? 0) + 1;
    deptCounts[cand.departmentCode] =
      (deptCounts[cand.departmentCode] ?? 0) + 1;
  }

  // Sort by DEPT_ORDER then by PO+wipKey for stable + cascade-safe order.
  const deptRank: Record<string, number> = {};
  UPH_POFOLD_DEPT_ORDER.forEach((d, i) => {
    deptRank[d] = i;
  });
  plans.sort((a, b) => {
    const dA = deptRank[a.departmentCode] ?? 99;
    const dB = deptRank[b.departmentCode] ?? 99;
    if (dA !== dB) return dA - dB;
    const k = `${a.productionOrderId}||${a.wipKey}`.localeCompare(
      `${b.productionOrderId}||${b.wipKey}`,
    );
    if (k !== 0) return k;
    return a.sequence - b.sequence;
  });

  const sample = plans.slice(0, 10).map((p) => ({
    id: p.id,
    productionOrderId: p.productionOrderId,
    wipKey: p.wipKey,
    branchKey: p.branchKey,
    departmentCode: p.departmentCode,
    wipType: p.wipType,
    itemCategory: p.itemCategory,
    anchorDate: p.anchorDate,
    newDate: p.newDate,
    offsetDays: p.offsetDays,
    clampedToAnchor: p.clampedToAnchor,
    actualMinutes: p.actualMinutes,
  }));

  // Distinct (PO, wipKey) pairs in scope — useful counter alongside JC count.
  const distinctWips = new Set(plans.map((p) => `${p.productionOrderId}||${p.wipKey}`));
  const distinctPOs = new Set(plans.map((p) => p.productionOrderId));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      candidatesScanned: allWaiting.length,
      noUphAnchorSkipped,
      planned: plans.length,
      distinctWipKeysAffected: distinctWips.size,
      distinctPOsAffected: distinctPOs.size,
      deptCounts,
      dateHistogram,
      sample,
    });
  }

  let updated = 0;
  const errors: Array<{ jcId: string; message: string }> = [];

  // Per-PO load cache so multiple flips in the same PO share one fetch.
  const poCache = new Map<
    string,
    { po: ProductionOrderRow; allJcs: JobCardRow[] }
  >();

  for (const plan of plans) {
    try {
      await db
        .prepare(
          // completedAt travels with completedDate in every statement that
          // writes the date. BACKFILL — the date is derived, not observed, so
          // NULL is the honest value; see src/api/lib/job-card-completed-at.ts.
          `UPDATE job_cards
              SET status = 'COMPLETED',
                  completedDate = ?,
                  completedAt = NULL,
                  actualMinutes = ?,
                  overdue = 'COMPLETED'
            WHERE id = ?`,
        )
        .bind(plan.newDate, plan.actualMinutes, plan.id)
        .run();
      updated++;
    } catch (err) {
      errors.push({
        jcId: plan.id,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const poId = plan.productionOrderId;
    let cached = poCache.get(poId);
    if (!cached) {
      try {
        const po = await loadProductionOrderById(db, poId);
        if (!po) continue;
        const allJcs = await findJobCardsByPO(db, poId);
        cached = { po, allJcs };
        poCache.set(poId, cached);
      } catch (err) {
        console.error("[uph-pofold-backfill] PO/JC load failed", {
          jcId: plan.id,
          poId,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    const idx = cached.allJcs.findIndex((j) => j.id === plan.id);
    if (idx === -1) continue;
    const prevStatus = cached.allJcs[idx].status;
    const updatedJc: JobCardRow = {
      ...cached.allJcs[idx],
      status: "COMPLETED",
      completedDate: plan.newDate,
      actualMinutes: plan.actualMinutes,
      overdue: "COMPLETED",
    };
    cached.allJcs[idx] = updatedJc;

    try {
      await applyWipInventoryChange(
        db,
        cached.po,
        updatedJc,
        "COMPLETED",
        cached.allJcs,
        prevStatus,
        { orgId: getOrgId(c), source: "BACKFILL" },
      );
    } catch (err) {
      console.error("[uph-pofold-backfill] WIP cascade failed", {
        jcId: plan.id,
        poId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await postJobCardLabor(db, plan.id, poId);
    } catch (err) {
      console.error("[uph-pofold-backfill] postJobCardLabor failed", {
        jcId: plan.id,
        poId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    candidatesScanned: allWaiting.length,
    noUphAnchorSkipped,
    planned: plans.length,
    distinctWipKeysAffected: distinctWips.size,
    distinctPOsAffected: distinctPOs.size,
    updated,
    errors,
    deptCounts,
    dateHistogram,
    sample,
  });
});

app.post("/fab-cut-pofold-backfill", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  // Migrations are inert on deploy (CLAUDE.md) — awaited before the UPDATE
  // below mentions completed_at.
  await ensureJobCardCompletedAt(db);
  const dryRun = c.req.query("dryRun") === "true";

  // 1. Pull all WAITING FAB_CUT JCs + their owning PO context. Avoid
  //    custom aliases — D1/Postgres adapter sometimes lowercases mixed-
  //    case aliases on the way out, leaving `fcPoId` as undefined.
  const fcRes = await db
    .prepare(
      `SELECT j.id,
              COALESCE(j.wipKey,'') AS wipKey,
              j.wipLabel,
              j.productionOrderId,
              j.estMinutes,
              j.productionTimeMinutes,
              po.companySOId,
              po.salesOrderId,
              po.companyCOId,
              po.consignmentOrderId,
              po.productCode,
              po.fabricCode,
              po.itemCategory
         FROM job_cards j
         LEFT JOIN production_orders po ON po.id = j.productionOrderId
        WHERE j.departmentCode = 'FAB_CUT'
          AND j.status = 'WAITING'
          AND j.completedDate IS NULL`,
    )
    .all<Record<string, unknown>>();
  const allFcs = (fcRes.results ?? []).map((r) => {
    const get = (k: string): unknown =>
      r[k] !== undefined ? r[k] : r[k.toLowerCase()];
    return {
      fcId: String(get("id") ?? ""),
      fcWipKey: String(get("wipKey") ?? ""),
      fcWipLabel: get("wipLabel") as string | null,
      fcPoId: String(get("productionOrderId") ?? ""),
      fcEstMinutes: get("estMinutes") as number | null,
      fcProductionTimeMinutes: get("productionTimeMinutes") as number | null,
      companySOId: get("companySOId") as string | null,
      salesOrderId: get("salesOrderId") as string | null,
      companyCOId: get("companyCOId") as string | null,
      consignmentOrderId: get("consignmentOrderId") as string | null,
      productCode: get("productCode") as string | null,
      fabricCode: get("fabricCode") as string | null,
      itemCategory: get("itemCategory") as string | null,
    };
  });

  // 2. Build a per-FC trigger lookup: scan completed FAB_SEW JCs in
  //    matching POs. Cache bom_templates baseModel lookups.
  const baseModelCache = new Map<string, string>();
  const lookupBaseModel = async (productCode: string): Promise<string> => {
    if (!productCode) return "";
    if (baseModelCache.has(productCode)) return baseModelCache.get(productCode)!;
    const r = await db
      .prepare(
        `SELECT baseModel FROM bom_templates
         WHERE productCode = ?
         ORDER BY effectiveFrom DESC LIMIT 1`,
      )
      .bind(productCode)
      .first<{ baseModel: string | null }>();
    const bm = r?.baseModel || productCode;
    baseModelCache.set(productCode, bm);
    return bm;
  };

  let noTriggerSkipped = 0;
  const plans: FcCandidate[] = [];
  const dateHistogram: Record<string, number> = {};
  const skippedReasons: Record<string, number> = {};

  for (const fc of allFcs) {
    if (!fc.productCode) {
      noTriggerSkipped++;
      skippedReasons["no_product_code"] = (skippedReasons["no_product_code"] ?? 0) + 1;
      continue;
    }
    const baseModel = await lookupBaseModel(fc.productCode);
    const fabricCode = fc.fabricCode || "";
    // Parent-doc key — match either SO or CO ids so CO-origin sofa
    // FCs find their cross-PO SEW siblings.
    const parentDocKey =
      fc.companySOId ||
      fc.salesOrderId ||
      fc.companyCOId ||
      fc.consignmentOrderId ||
      "";

    // Find COMPLETED FAB_SEW JCs that point back to this FC via the same
    // (parentDocKey | productionOrderId)::baseModel::fabricCode::FAB_CUT
    // key pattern that production-orders.ts:1481-1552 uses to resolve
    // from SEW to FC. Reverse lookup: SEW lives on a PO whose parent
    // doc id matches this FC's group key (either side).
    const sewRows = await db
      .prepare(
        `SELECT j.id, j.completedDate, po.productCode
           FROM job_cards j
           JOIN production_orders po ON po.id = j.productionOrderId
          WHERE j.departmentCode = 'FAB_SEW'
            AND j.status IN ('COMPLETED','TRANSFERRED')
            AND j.completedDate IS NOT NULL
            AND COALESCE(po.fabricCode,'') = ?
            AND (
              po.id = ?
              OR (
                ? <> ''
                AND (
                  COALESCE(po.companySOId,'') = ?
                  OR COALESCE(po.companyCOId,'') = ?
                )
              )
            )`,
      )
      .bind(fabricCode, fc.fcPoId, parentDocKey, parentDocKey, parentDocKey)
      .all<Record<string, unknown>>();

    // Filter SEW results to those whose PO's productCode also resolves to
    // the same baseModel (avoids cross-model bleed within an SO group).
    const candidateSews: { sewId: string; sewDate: string }[] = [];
    for (const sew of sewRows.results ?? []) {
      const get = (k: string): unknown =>
        sew[k] !== undefined ? sew[k] : sew[k.toLowerCase()];
      const sewId = String(get("id") ?? "");
      const sewDate = String(get("completedDate") ?? "");
      const sewProductCode = String(get("productCode") ?? "");
      if (!sewId || !sewDate || !/^\d{4}-\d{2}-\d{2}$/.test(sewDate)) continue;
      const sewBaseModel = sewProductCode
        ? await lookupBaseModel(sewProductCode)
        : "";
      if (sewBaseModel === baseModel) {
        candidateSews.push({ sewId, sewDate });
      }
    }

    if (candidateSews.length === 0) {
      noTriggerSkipped++;
      skippedReasons["no_completed_fab_sew_sibling"] =
        (skippedReasons["no_completed_fab_sew_sibling"] ?? 0) + 1;
      continue;
    }

    // FAB_CUT happens BEFORE FAB_SEW. Date = min(sew dates) − 1 (FAB_CUT
    // lead = 1, FAB_SEW lead = 1, offset = 0 → use min sew date directly,
    // then clamp to today). Subtract 1 day to keep chronology strict.
    const sortedDates = candidateSews
      .map((s) => s.sewDate)
      .sort();
    const minSewDate = sortedDates[0];
    let newDate = addDaysISO(minSewDate, -1);
    if (newDate > CASCADE_DATE_CLAMP) newDate = CASCADE_DATE_CLAMP;

    const actualMinutes =
      fc.fcProductionTimeMinutes != null
        ? fc.fcProductionTimeMinutes
        : fc.fcEstMinutes != null
          ? fc.fcEstMinutes
          : 0;

    plans.push({
      fcId: fc.fcId,
      fcWipKey: fc.fcWipKey,
      fcWipLabel: fc.fcWipLabel,
      fcPoId: fc.fcPoId,
      fcEstMinutes: fc.fcEstMinutes,
      fcProductionTimeMinutes: fc.fcProductionTimeMinutes,
      newDate,
      actualMinutes,
      triggerSewIds: candidateSews.map((s) => s.sewId),
      triggerSewMinDate: minSewDate,
    });
    dateHistogram[newDate] = (dateHistogram[newDate] ?? 0) + 1;
  }

  const sample = plans.slice(0, 10).map((p) => ({
    fcId: p.fcId,
    fcWipKey: p.fcWipKey,
    fcWipLabel: p.fcWipLabel,
    fcPoId: p.fcPoId,
    newDate: p.newDate,
    triggerSewMinDate: p.triggerSewMinDate,
    triggerSewCount: p.triggerSewIds.length,
  }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      totalWaitingFcJcs: allFcs.length,
      noTriggerSkipped,
      skippedReasons,
      planned: plans.length,
      dateHistogram,
      sample,
    });
  }

  let updated = 0;
  const errors: Array<{ fcId: string; message: string }> = [];
  const poCache = new Map<
    string,
    { po: ProductionOrderRow; allJcs: JobCardRow[] }
  >();

  for (const plan of plans) {
    try {
      await db
        .prepare(
          // completedAt travels with completedDate in every statement that
          // writes the date. BACKFILL — the date is derived, not observed, so
          // NULL is the honest value; see src/api/lib/job-card-completed-at.ts.
          `UPDATE job_cards
              SET status = 'COMPLETED',
                  completedDate = ?,
                  completedAt = NULL,
                  actualMinutes = ?,
                  overdue = 'COMPLETED'
            WHERE id = ?`,
        )
        .bind(plan.newDate, plan.actualMinutes, plan.fcId)
        .run();
      updated++;
    } catch (err) {
      errors.push({
        fcId: plan.fcId,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let cached = poCache.get(plan.fcPoId);
    if (!cached) {
      try {
        const po = await loadProductionOrderById(db, plan.fcPoId);
        if (!po) continue;
        const allJcs = await findJobCardsByPO(db, plan.fcPoId);
        cached = { po, allJcs };
        poCache.set(plan.fcPoId, cached);
      } catch (err) {
        console.error("[fab-cut-pofold-backfill] PO/JC load failed", {
          fcId: plan.fcId,
          poId: plan.fcPoId,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    const idx = cached.allJcs.findIndex((j) => j.id === plan.fcId);
    if (idx === -1) continue;
    const prevStatus = cached.allJcs[idx].status;
    const updatedJc: JobCardRow = {
      ...cached.allJcs[idx],
      status: "COMPLETED",
      completedDate: plan.newDate,
      actualMinutes: plan.actualMinutes,
      overdue: "COMPLETED",
    };
    cached.allJcs[idx] = updatedJc;

    try {
      await applyWipInventoryChange(
        db,
        cached.po,
        updatedJc,
        "COMPLETED",
        cached.allJcs,
        prevStatus,
        { orgId: getOrgId(c), source: "BACKFILL" },
      );
    } catch (err) {
      console.error("[fab-cut-pofold-backfill] WIP cascade failed", {
        fcId: plan.fcId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await postJobCardLabor(db, plan.fcId, plan.fcPoId);
    } catch (err) {
      console.error("[fab-cut-pofold-backfill] postJobCardLabor failed", {
        fcId: plan.fcId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    totalWaitingFcJcs: allFcs.length,
    noTriggerSkipped,
    skippedReasons,
    planned: plans.length,
    updated,
    errors,
    dateHistogram,
    sample,
  });
});

app.post("/refund-backfill-overconsume", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // Refund candidates: cascade-backfilled DOWNSTREAM consumer JCs.
  //
  // Restrict to the depts that consume an upstream sibling in
  // applyWipInventoryChange (production-orders.ts line ~1146-1206):
  //   FAB_SEW    — consumes upstream FAB_CUT '(FC)'
  //   FRAMING    — consumes upstream WOOD_CUT '(WD)'  (no over-consume of
  //                Frame itself, but in chains where WOOD_CUT is CSV
  //                AND FRAMING is backfilled, FRAMING-backfill consumes
  //                (WD) -2 a second time too — same Model-B logic
  //                applies to refund (WD).)
  //   WEBBING    — consumes upstream FRAMING 'Frame'
  //   FOAM       — consumes upstream FRAMING 'Frame' (HEADBOARD chain
  //                where FOAM follows FRAMING; covered by the same
  //                generic per-component consume rule).
  //
  // FAB_CUT and WOOD_CUT are producer-only (no upstream consume) — skip.
  // UPHOLSTERY consumed correctly originally — skip.
  // PACKING is metadata-only — skip.
  //
  // Filter signature mirrors /backfill-cascade-wip-producers exactly so
  // we hit the same JC set the backfill processed.
  const candRes = await db
    .prepare(
      `SELECT id, productionOrderId, departmentCode, wipKey, wipLabel,
              wipQty, completedDate, branchKey, sequence, estMinutes,
              productionTimeMinutes, actualMinutes, overdue
         FROM job_cards
        WHERE status IN ('COMPLETED','TRANSFERRED')
          AND completedDate IS NOT NULL
          AND overdue = 'COMPLETED'
          AND UPPER(COALESCE(departmentCode,''))
              IN ('FAB_SEW','FRAMING','WEBBING','FOAM')
          AND actualMinutes = COALESCE(productionTimeMinutes, estMinutes, 0)
          AND pic1Id IS NULL
          AND COALESCE(pic1Name,'') = ''
          AND completedDate >= ?
          AND completedDate <= ?`,
    )
    .bind(
      c.req.query("from") || "2026-01-01",
      c.req.query("to") || "2026-04-30",
    )
    .all<RefundCandidateRow>();
  const candidates = candRes.results ?? [];

  // Group candidates by PO so we can fetch siblings once per PO.
  const byPo = new Map<string, RefundCandidateRow[]>();
  for (const r of candidates) {
    const list = byPo.get(r.productionOrderId) ?? [];
    list.push(r);
    byPo.set(r.productionOrderId, list);
  }

  // Plan list — entries we'd actually UPDATE.
  type RefundPlan = {
    jcId: string;
    poId: string;
    dept: string;
    wipQty: number;
    upstreamWipLabel: string;
    upstreamDept: string;
    upstreamPic: string | null; // for sample only — confirms CSV
  };
  const plan: RefundPlan[] = [];
  const skipReasons: Record<string, number> = {
    noWipKey: 0,
    noWipQty: 0,
    noUpstreamSibling: 0,
    upstreamNoPicTooBackfill: 0,
    upstreamNoLabel: 0,
  };

  for (const [poId, cands] of byPo) {
    // Load every sibling in the PO once. A "sibling" here is any JC in
    // the same productionOrderId — we then filter by (wipKey, branchKey,
    // sequence < cand.sequence) to find the per-component upstream that
    // applyWipInventoryChange would have consumed from.
    const sibsRes = await db
      .prepare(
        `SELECT id, productionOrderId, departmentCode, wipKey, wipLabel,
                wipQty, branchKey, sequence, status, pic1Id, pic1Name,
                actualMinutes, productionTimeMinutes, estMinutes,
                overdue, completedDate
           FROM job_cards
          WHERE productionOrderId = ?`,
      )
      .bind(poId)
      .all<RefundSiblingRow>();
    const sibs = sibsRes.results ?? [];

    for (const cand of cands) {
      if (!cand.wipKey) {
        skipReasons.noWipKey++;
        continue;
      }
      const wipQty = cand.wipQty ?? 0;
      if (!wipQty) {
        skipReasons.noWipQty++;
        continue;
      }
      const myBranch = cand.branchKey ?? "";
      // Mirror production-orders.ts line 1158-1166: same wipKey, same
      // branchKey, sequence < own, take highest. This is the JC whose
      // wipLabel applyWipInventoryChange consumed from at backfill time.
      const upstreams = sibs
        .filter(
          (s) =>
            s.wipKey === cand.wipKey &&
            (s.branchKey ?? "") === myBranch &&
            s.sequence < cand.sequence,
        )
        .sort((a, b) => b.sequence - a.sequence);
      const upstream = upstreams[0];
      if (!upstream) {
        skipReasons.noUpstreamSibling++;
        continue;
      }
      if (!upstream.wipLabel) {
        skipReasons.upstreamNoLabel++;
        continue;
      }

      // Model B gate: refund only when upstream is NOT in the backfill
      // set. "In backfill" matches the same filter used by
      // /backfill-cascade-wip-producers: pic1Id IS NULL AND pic1Name=''.
      // If upstream has PIC, it was CSV-completed → its produce already
      // landed at CSV time; the backfill-D's consume is then the only
      // consume on its label, no double-count, no refund.
      //
      // BUT: that's the OPPOSITE of what we want. Re-read the trace in
      // the header. The "double consume" arises when CSV-D's consume
      // ALREADY FIRED (CSV had a row for D), then cascade overwrote D's
      // metadata, then backfill picked D up and fired D's consume AGAIN.
      // The signature for that case is "D's upstream U has PIC (was
      // also in CSV)" — implying CSV had pairs of (U,D) entries that
      // both fired at CSV time, and only D got cascade-overwritten.
      //
      // The cleanest detector is: "upstream U has PIC". That's what we
      // gate on.
      const upPicId = (upstream.pic1Id ?? "").trim();
      const upPicName = (upstream.pic1Name ?? "").trim();
      const upHasPic = upPicId !== "" || upPicName !== "";
      if (!upHasPic) {
        skipReasons.upstreamNoPicTooBackfill++;
        continue;
      }

      plan.push({
        jcId: cand.id,
        poId,
        dept: (cand.departmentCode || "").toUpperCase(),
        wipQty,
        upstreamWipLabel: upstream.wipLabel,
        upstreamDept: (upstream.departmentCode || "").toUpperCase(),
        upstreamPic: upPicName || upPicId || null,
      });
    }
  }

  // Aggregate stats
  const deptCounts: Record<string, number> = {};
  const upstreamLabelTotals: Record<string, number> = {};
  let totalRefundQty = 0;
  for (const p of plan) {
    deptCounts[p.dept] = (deptCounts[p.dept] ?? 0) + 1;
    upstreamLabelTotals[p.upstreamWipLabel] =
      (upstreamLabelTotals[p.upstreamWipLabel] ?? 0) + p.wipQty;
    totalRefundQty += p.wipQty;
  }
  const sample = plan.slice(0, 10);

  // Top 10 labels by refund magnitude (for cross-check vs current
  // negative wip_items magnitudes).
  const topRefundLabels = Object.entries(upstreamLabelTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([wipLabel, refundQty]) => ({ wipLabel, refundQty }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      candidateCount: candidates.length,
      planCount: plan.length,
      totalRefundQty,
      deptCounts,
      topRefundLabels,
      skipReasons,
      sample,
    });
  }

  // Live mode: direct UPDATE on wip_items only.
  // INSERT is unnecessary — every upstream wipLabel in our plan came
  // from a CSV-completed upstream JC, which means applyWipInventoryChange
  // already inserted/upserted that label's row at CSV time. We just
  // adjust stockQty.
  //
  // 2026-05-11 — sign param for revert mode. The endpoint is NOT
  // idempotent by design: running it twice double-credits. Add
  // `?revert=true` (sign=-1) to subtract the same qty back, used as a
  // one-shot when refund was accidentally re-run. The plan list is
  // deterministic (same SELECT filter → same rows) so revert on the
  // same dataset exactly inverts a prior wet-run.
  const revertMode = c.req.query("revert") === "true";
  const sign = revertMode ? -1 : 1;
  let updated = 0;
  let skippedRowMissing = 0;
  const errors: Array<{ jcId: string; message: string }> = [];

  for (const p of plan) {
    try {
      const exists = await db
        .prepare("SELECT id FROM wip_items WHERE code = ?")
        .bind(p.upstreamWipLabel)
        .first<{ id: string }>();
      if (!exists) {
        // Defensive: if the upstream label genuinely has no row, skip
        // rather than INSERT a positive stub (would mis-attribute on the
        // FE wip view, which keys negative rows by missing-producer
        // semantics). A missing row means our model is wrong about the
        // CSV-produce having fired — investigate manually.
        skippedRowMissing++;
        continue;
      }
      await db
        .prepare(
          `UPDATE wip_items SET stockQty = stockQty + ? WHERE code = ?`,
        )
        .bind(sign * p.wipQty, p.upstreamWipLabel)
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
    candidateCount: candidates.length,
    planCount: plan.length,
    totalRefundQty,
    updated,
    skippedRowMissing,
    deptCounts,
    topRefundLabels,
    skipReasons,
    errors,
    sample,
  });
});

// ---------------------------------------------------------------------------
// /dedupe-wip-items — Layer 4 cleanup pass.
//
// Background. After Layer 1 (backfill), Layer 2 (refund), Layer 3 (fullwidth
// paren normalize), residual state is 1,118 wip_items rows / 209 negative
// rows / -316 magnitude. A trace agent identified that 112 of those 209
// negative rows have a sibling positive row at the SAME `code` (different
// `id`) — i.e. the producer-add wrote to one row and the consume-decrement
// wrote to another instead of upserting onto the same row. Net 84% of
// residual magnitude is "same-code duplicates".
//
// Root cause. wip_items has no UNIQUE constraint on `code` (PK is `id`,
// `code` only carries the non-UNIQUE idx_wip_items_code from migration
// 0037). applyWipInventoryChange (production-orders.ts ~1071-1351) does a
// SELECT-by-code → if NULL INSERT a new row, otherwise UPDATE by id. Two
// concurrent JC PATCHes for the same code can both see NULL and both
// INSERT, producing two rows that diverge (one accumulates +qty from the
// producer side, one accumulates -qty from the consume side). Earlier
// rollback paths use `UPDATE ... WHERE code = ?` which then mass-updates
// every dup row simultaneously, compounding drift.
//
// What this endpoint does. Pure SQL — does NOT call applyWipInventoryChange.
//   1. Find groups of wip_items rows sharing the same `code` (COUNT > 1).
//   2. For each group: pick a canonical row (prefer non-PENDING deptStatus,
//      then non-empty relatedProduct, ties broken by lowest id).
//   3. Sum stockQty across all rows in the group → set canonical.stockQty
//      to that sum.
//   4. DELETE the non-canonical rows.
//
// Dry-run returns full counts + 10-row sample. Live-mode runs the merge
// inside a single db.batch() (D1's atomic-batch primitive — "transaction"
// without BEGIN/COMMIT, mirrors /normalize-fullwidth-parens above).
// ---------------------------------------------------------------------------
app.post("/dedupe-wip-items", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  type WipRow = {
    id: string;
    code: string;
    type: string;
    relatedProduct: string | null;
    deptStatus: string | null;
    stockQty: number;
    status: string;
  };

  // ----- Step 1 — find dup-code groups -----
  // Inner query: codes where COUNT(*) > 1.
  // Outer fetch: every row whose code is in that set, with all the
  // columns we need to pick a canonical and report the sample.
  const dupCodesRes = await db
    .prepare(
      `SELECT code, COUNT(*) AS n, SUM(stockQty) AS "netQty"
         FROM wip_items
        GROUP BY code
       HAVING COUNT(*) > 1`,
    )
    .all<{ code: string; n: number; netQty: number }>();
  const dupCodes = dupCodesRes.results ?? [];

  if (dupCodes.length === 0) {
    return c.json({
      success: true,
      dryRun,
      groupCount: 0,
      rowsToMerge: 0,
      rowsToUpdate: 0,
      message: "No duplicate-code groups found in wip_items.",
    });
  }

  // Pull every row in every dup-code group in one query. SQLite's IN
  // clause with bound list keeps this clean for the typical N≈100 groups.
  const codesList = dupCodes.map((d) => d.code);
  const placeholders = codesList.map(() => "?").join(",");
  const rowsRes = await db
    .prepare(
      `SELECT id, code, type, relatedProduct, deptStatus, stockQty, status
         FROM wip_items
        WHERE code IN (${placeholders})`,
    )
    .bind(...codesList)
    .all<WipRow>();
  const allRows = rowsRes.results ?? [];

  // Group by code.
  const byCode = new Map<string, WipRow[]>();
  for (const r of allRows) {
    const list = byCode.get(r.code) ?? [];
    list.push(r);
    byCode.set(r.code, list);
  }

  // ----- Step 2 — pick canonical + plan merges -----
  // Canonical preference: non-PENDING deptStatus > non-empty relatedProduct
  // > lowest id. Score each row, pick the lowest score.
  function canonicalScore(r: WipRow): [number, number, string] {
    const deptStatusScore =
      (r.deptStatus || "").toUpperCase() === "PENDING" ? 1 : 0;
    const relatedScore = (r.relatedProduct ?? "").trim() === "" ? 1 : 0;
    return [deptStatusScore, relatedScore, r.id];
  }
  function pickCanonical(rows: WipRow[]): WipRow {
    return rows.slice().sort((a, b) => {
      const sa = canonicalScore(a);
      const sb = canonicalScore(b);
      if (sa[0] !== sb[0]) return sa[0] - sb[0];
      if (sa[1] !== sb[1]) return sa[1] - sb[1];
      return sa[2] < sb[2] ? -1 : sa[2] > sb[2] ? 1 : 0;
    })[0];
  }

  type Plan = {
    code: string;
    canonical: WipRow;
    rows: WipRow[];
    netSum: number;
    nonCanonicalIds: string[];
  };
  const plan: Plan[] = [];
  let predictedNegativeAfter = 0;
  let rowsToMerge = 0;

  for (const [code, rows] of byCode) {
    const canonical = pickCanonical(rows);
    const netSum = rows.reduce((acc, r) => acc + (r.stockQty || 0), 0);
    const nonCanonicalIds = rows
      .filter((r) => r.id !== canonical.id)
      .map((r) => r.id);
    rowsToMerge += nonCanonicalIds.length;
    if (netSum < 0) predictedNegativeAfter += 1;
    plan.push({ code, canonical, rows, netSum, nonCanonicalIds });
  }

  // ----- Pre/post stats over the WHOLE wip_items table -----
  // Three separate queries — the combined SUM(CASE)+COUNT(*) variant came
  // back with NULL fields under D1 in dry-run #1 (likely an alias quoting
  // quirk), so split for robustness.
  const totalRowsRes = await db
    .prepare(`SELECT COUNT(*) AS n FROM wip_items`)
    .first<{ n: number }>();
  const totalRowsBefore = totalRowsRes?.n ?? 0;
  const negRowsRes = await db
    .prepare(`SELECT COUNT(*) AS n FROM wip_items WHERE stockQty < 0`)
    .first<{ n: number }>();
  const negRowsBefore = negRowsRes?.n ?? 0;
  const negTotalRes = await db
    .prepare(
      `SELECT COALESCE(SUM(stockQty), 0) AS n FROM wip_items WHERE stockQty < 0`,
    )
    .first<{ n: number }>();
  const negTotalBefore = negTotalRes?.n ?? 0;

  // Predicted residual:
  //   - rows: totalRowsBefore - rowsToMerge (we DELETE rowsToMerge rows;
  //     canonical updates don't change row count).
  //   - negative rows: count groups where netSum < 0, plus any rows
  //     OUTSIDE dup-code groups that are already negative. Since
  //     non-dup negatives stay untouched, the post count =
  //     (negRowsBefore − negativeRowsInDupGroups) + predictedNegativeAfter.
  let negativeRowsInDupGroupsBefore = 0;
  let negativeMagnitudeInDupGroupsBefore = 0;
  for (const [, rows] of byCode) {
    for (const r of rows) {
      if ((r.stockQty || 0) < 0) {
        negativeRowsInDupGroupsBefore += 1;
        negativeMagnitudeInDupGroupsBefore += r.stockQty || 0;
      }
    }
  }
  // Sum of netSum for groups where netSum < 0 — magnitude of negatives that
  // SURVIVE the dedupe (groups that net out positive contribute 0 to neg
  // total post-dedupe).
  let predictedNegativeMagnitudeAfter = 0;
  for (const p of plan) {
    if (p.netSum < 0) predictedNegativeMagnitudeAfter += p.netSum;
  }

  const predictedNegRowsTotalAfter =
    negRowsBefore - negativeRowsInDupGroupsBefore + predictedNegativeAfter;
  const predictedNegTotalAfter =
    negTotalBefore -
    negativeMagnitudeInDupGroupsBefore +
    predictedNegativeMagnitudeAfter;

  // ----- Sample for the dry-run response -----
  const sampleGroups = plan.slice(0, 10).map((p) => ({
    code: p.code,
    rows: p.rows.map((r) => ({
      id: r.id,
      stockQty: r.stockQty,
      deptStatus: r.deptStatus,
      relatedProduct: r.relatedProduct,
      status: r.status,
    })),
    canonical: p.canonical.id,
    canonicalReason:
      ((p.canonical.deptStatus || "").toUpperCase() !== "PENDING"
        ? "non-PENDING deptStatus"
        : "PENDING (no non-PENDING in group)") +
      ((p.canonical.relatedProduct ?? "").trim() !== ""
        ? " + non-empty relatedProduct"
        : " + empty relatedProduct") +
      " + lowest id tiebreak",
    netSum: p.netSum,
  }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      groupCount: plan.length,
      rowsToMerge,
      rowsToUpdate: plan.length,
      negativeMagnitudeBefore: negTotalBefore,
      negativeRowsBefore: negRowsBefore,
      totalRowsBefore,
      predictedNegativeAfter: predictedNegRowsTotalAfter,
      predictedNegativeMagnitudeAfter: predictedNegTotalAfter,
      predictedTotalRowsAfter: totalRowsBefore - rowsToMerge,
      negativeRowsInDupGroupsBefore,
      negativeMagnitudeInDupGroupsBefore,
      sampleGroups,
    });
  }

  // ----- Live mode — single atomic batch -----
  // Per-group: 1 UPDATE (canonical.stockQty := netSum) + N DELETEs (where
  // N = nonCanonicalIds.length). D1 batch is atomic, so partial state
  // can't leak.
  const stmts: D1PreparedStatement[] = [];
  for (const p of plan) {
    stmts.push(
      db
        .prepare(`UPDATE wip_items SET stockQty = ? WHERE id = ?`)
        .bind(p.netSum, p.canonical.id),
    );
    for (const id of p.nonCanonicalIds) {
      stmts.push(db.prepare(`DELETE FROM wip_items WHERE id = ?`).bind(id));
    }
  }

  let batchOk = true;
  let batchError: string | null = null;
  let updatesApplied = 0;
  let deletesApplied = 0;
  try {
    const batchResults = await db.batch(stmts);
    let i = 0;
    for (const p of plan) {
      const upd = batchResults[i++];
      if ((upd?.meta?.changes ?? 0) > 0) updatesApplied += 1;
      for (const _id of p.nonCanonicalIds) {
        const del = batchResults[i++];
        if ((del?.meta?.changes ?? 0) > 0) deletesApplied += 1;
      }
    }
  } catch (e) {
    batchOk = false;
    batchError = e instanceof Error ? e.message : String(e);
  }

  return c.json({
    success: batchOk,
    dryRun: false,
    groupCount: plan.length,
    rowsToMerge,
    rowsToUpdate: plan.length,
    updatesApplied,
    deletesApplied,
    negativeMagnitudeBefore: negTotalBefore,
    negativeRowsBefore: negRowsBefore,
    totalRowsBefore,
    predictedNegativeAfter: predictedNegRowsTotalAfter,
    predictedNegativeMagnitudeAfter: predictedNegTotalAfter,
    predictedTotalRowsAfter: totalRowsBefore - rowsToMerge,
    sampleGroups,
    batchError,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/zero-out-negative-wips
//
// One-shot cleanup for the residual ~96 negative wip_items rows accumulated
// by BUG-2026-04-30-002 (double-consume on WAITING→IN_PROGRESS→COMPLETED;
// the code-side fix landed in production-orders.ts in the same deploy).
// These negatives are bug artifacts, not legitimate "missed dept"
// visibility signals — the user wants them zeroed out.
//
// Logic: find every wip_items row with stockQty < 0 and set its stockQty
// to 0 in a single UPDATE. This endpoint deliberately does NOT call
// applyWipInventoryChange — it's a pure raw-SQL cleanup, no cascades, no
// labor entries, no fg_units side effects. The double-consume code fix
// must already be deployed when this runs live so no NEW negatives accrue
// during the cleanup window.
//
// Dry-run mode (?dryRun=true): SELECT only, returns count + magnitude +
// sample 10. Live mode (?dryRun=false): single UPDATE statement.
// Permission gate: production-orders:update (same as the rest of this
// file's privileged backfill endpoints).
// ---------------------------------------------------------------------------
app.post("/zero-out-negative-wips", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // Pre-stats: count + total magnitude of all currently-negative rows.
  const countRes = await db
    .prepare(`SELECT COUNT(*) AS n FROM wip_items WHERE stockQty < 0`)
    .first<{ n: number }>();
  const negativeRowsBefore = countRes?.n ?? 0;
  const magnitudeRes = await db
    .prepare(
      `SELECT COALESCE(SUM(stockQty), 0) AS n FROM wip_items WHERE stockQty < 0`,
    )
    .first<{ n: number }>();
  const totalMagnitudeBefore = magnitudeRes?.n ?? 0;

  // Sample 10 for spot-check visibility in the dry-run response.
  const sampleRes = await db
    .prepare(
      `SELECT code, stockQty, deptStatus
         FROM wip_items
        WHERE stockQty < 0
        ORDER BY stockQty ASC
        LIMIT 10`,
    )
    .all<{ code: string; stockQty: number; deptStatus: string | null }>();
  const sample = (sampleRes.results ?? []).map((r) => ({
    code: r.code,
    qty: r.stockQty,
    deptStatus: r.deptStatus,
  }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      rowsAffected: negativeRowsBefore,
      totalMagnitudeBefore,
      sample,
    });
  }

  // Live: single UPDATE. D1 reports affected row count via meta.changes.
  const updRes = await db
    .prepare(`UPDATE wip_items SET stockQty = 0 WHERE stockQty < 0`)
    .run();
  const rowsAffected = updRes.meta?.changes ?? 0;

  return c.json({
    success: true,
    dryRun: false,
    rowsAffected,
    totalMagnitudeBefore,
    sample,
  });
});

app.post("/rebuild-wip-from-jcs", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // BUG-2026-05-12: full-scan rebuild blew past Cloudflare's request wall on
  // prod-size data (5000+ JCs × 5000+ POs in-memory diff). Operator couldn't
  // get FOAM 326-stuck-at-326 corrected because every dry-run hung > 3 min.
  // Two scope filters bolted on so the operator can run dept-scoped (or
  // code-substring-scoped) rebuilds that fit inside the request budget:
  //
  //   ?byDept=FOAM          → filter `expected` map to codes whose JC is in
  //                           that dept (uses the (DEPT) suffix in the
  //                           synthesized label as the heuristic). Also
  //                           filters wip_items SELECT to a subset.
  //   ?codeContains=<frag>  → filter wip_items + expected codes by substring
  //                           (case-sensitive). Use for ad-hoc cleanup of a
  //                           specific product code or wipKey.
  //
  // When both filters are unset the endpoint behaves exactly as before
  // (whole-tenant rebuild). Filters compose with AND.
  const scopeByDept = (c.req.query("byDept") || "").trim().toUpperCase();
  const scopeCodeContains = (c.req.query("codeContains") || "").trim();
  const hasScope = scopeByDept !== "" || scopeCodeContains !== "";
  const matchesScope = (code: string): boolean => {
    if (!hasScope) return true;
    if (scopeByDept && !code.includes(`(${scopeByDept})`)) return false;
    if (scopeCodeContains && !code.includes(scopeCodeContains)) return false;
    return true;
  };

  // ----- Step 1 — load all JCs (one query) -----
  const jcRes = await db
    .prepare(
      `SELECT id, productionOrderId, departmentCode, status, sequence,
              wipKey, wipLabel, wipQty, branchKey
         FROM job_cards`,
    )
    .all<RebuildJcRow>();
  const allJcs = jcRes.results ?? [];

  // ----- Step 2 — load PO essentials for sofa-FAB_SEW edge case -----
  // We need itemCategory, salesOrderId, fabricCode for sofa zero-out, and
  // productCode + quantity for the synthesized fallback wipLabel logic
  // (mirrors applyWipInventoryChange's wipLabel fallback at line 1003-1015).
  const poRes = await db
    .prepare(
      `SELECT id, productCode, itemCategory, salesOrderId,
              consignmentOrderId, fabricCode, quantity
         FROM production_orders`,
    )
    .all<RebuildPoRow>();
  const poById = new Map<string, RebuildPoRow>();
  for (const p of poRes.results ?? []) poById.set(p.id, p);

  // ----- Step 3 — load current wip_items rows -----
  const wipRes = await db
    .prepare(
      `SELECT id, code, type, relatedProduct, deptStatus, stockQty, status
         FROM wip_items`,
    )
    .all<RebuildWipRow>();
  const wipByCode = new Map<string, RebuildWipRow>();
  for (const w of wipRes.results ?? []) {
    // Defensive: if duplicates somehow exist (post-dedupe should be 0),
    // keep the first; rebuild will collapse via UPDATE on canonical id.
    if (!wipByCode.has(w.code)) wipByCode.set(w.code, w);
  }
  const totalRowsBefore = wipRes.results?.length ?? 0;

  // Helper: synthesize wipLabel exactly as applyWipInventoryChange does
  // when jcRow.wipLabel is empty (line 1003-1015). This guarantees the
  // rebuild keys match what the live cascade would have written.
  const synthLabel = (jc: RebuildJcRow, po: RebuildPoRow | undefined): string => {
    const direct = (jc.wipLabel ?? "").trim();
    if (direct) return direct;
    const dept = (jc.departmentCode ?? "").toUpperCase();
    const parts: string[] = [];
    const pc = (po?.productCode ?? "").trim();
    if (pc) parts.push(pc);
    const wc = (jc.wipKey ?? "").trim();
    if (wc) parts.push(wc);
    if (dept) parts.push(`(${dept})`);
    return parts.join(" ").trim();
  };

  // Helper: effective wipQty mirrors `jcRow.wipQty || poRow.quantity || 1`.
  const effQty = (jc: RebuildJcRow, po: RebuildPoRow | undefined): number => {
    const q = jc.wipQty;
    if (typeof q === "number" && q !== 0) return q;
    const pq = po?.quantity;
    if (typeof pq === "number" && pq !== 0) return pq;
    return 1;
  };

  // ----- Step 4 — index siblings per (productionOrderId) for sibling lookup -----
  // applyWipInventoryChange's child lookup walks `allJcRows` filtered by
  // (wipKey, branchKey, sequence < own). The original code's `allJcRows`
  // was the JC list FOR THAT PO — sibling matching never crossed PO
  // boundaries. Preserve that: index by productionOrderId.
  const jcsByPo = new Map<string, RebuildJcRow[]>();
  for (const jc of allJcs) {
    const list = jcsByPo.get(jc.productionOrderId) ?? [];
    list.push(jc);
    jcsByPo.set(jc.productionOrderId, list);
  }

  const findUpstream = (jc: RebuildJcRow): RebuildJcRow | null => {
    if (!jc.wipKey) return null;
    const myBranch = jc.branchKey ?? "";
    const siblings = jcsByPo.get(jc.productionOrderId) ?? [];
    let best: RebuildJcRow | null = null;
    for (const s of siblings) {
      if (s.wipKey !== jc.wipKey) continue;
      if ((s.branchKey ?? "") !== myBranch) continue;
      if (s.sequence >= jc.sequence) continue;
      if (!s.wipLabel) continue;
      if (!best || s.sequence > best.sequence) best = s;
    }
    return best;
  };

  // For UPH branch-terminal consume: per UPH JC, return one sibling per
  // branchKey at MAX sequence below UPH's seq.
  const findUphBranchTerminals = (uph: RebuildJcRow): RebuildJcRow[] => {
    if (!uph.wipKey) return [];
    const siblings = jcsByPo.get(uph.productionOrderId) ?? [];
    const byBranch = new Map<string, RebuildJcRow>();
    for (const s of siblings) {
      if (s.wipKey !== uph.wipKey) continue;
      if (s.sequence >= uph.sequence) continue;
      if (!s.wipLabel) continue;
      const bk = s.branchKey ?? "";
      const cur = byBranch.get(bk);
      if (!cur || s.sequence > cur.sequence) byBranch.set(bk, s);
    }
    return Array.from(byBranch.values());
  };

  // ----- Step 5 — accumulate expected stockQty per code -----
  const expected = new Map<string, number>();
  // Track first-seen JC metadata per code so INSERT path has type/related.
  const codeMeta = new Map<
    string,
    { type: string; relatedProduct: string; deptStatus: string }
  >();
  const bumpExpected = (code: string, delta: number): void => {
    if (!code) return;
    expected.set(code, (expected.get(code) ?? 0) + delta);
  };
  const recordMeta = (
    code: string,
    type: string,
    relatedProduct: string,
    deptStatus: string,
  ): void => {
    if (!code) return;
    if (codeMeta.has(code)) return;
    codeMeta.set(code, { type, relatedProduct, deptStatus });
  };

  const shortType = (wipType: string | null | undefined, deptCode: string): string => {
    const t = (wipType ?? "").toUpperCase();
    if (t === "HEADBOARD") return "HB";
    if (t === "SOFA_BASE") return "BASE";
    if (t === "SOFA_CUSHION") return "CUSHION";
    if (t === "SOFA_ARMREST") return "ARMREST";
    if (t) return t;
    return deptCode || "WIP";
  };

  // BUG-2026-04-30-003 mirror: Plan B "UPH-all-done subtract".
  // Pre-compute the set of POs where EVERY UPH JC is COMPLETED/TRANSFERRED.
  // In production-orders.ts:1346-1381, when an UPH JC transitions to DONE
  // and ALL UPH JCs in the PO are now DONE, the cascade subtracts each
  // UPH JC's +wipQty from its own wipLabel (WIP→FG transition).
  //
  // Net effect for an UPH JC in a fully-UPH-complete PO:
  //   producer-add (+wipQty) + Plan B subtract (-wipQty) = 0
  //
  // Simpler form: SKIP the producer-add for UPH JCs whose PO is fully
  // UPH-complete. Both forms are equivalent; skipping is cleaner.
  // Reverse symmetry (production-orders.ts:1067-1102) is structurally
  // mirrored too: a partially-UPH-done PO sees its DONE UPH JCs producer-add
  // normally (because Plan B subtract has not fired and Plan B reverse
  // does not apply), which matches the live ledger state.
  const fullUphPoIds = new Set<string>();
  {
    type UphCounts = { total: number; done: number };
    const perPo = new Map<string, UphCounts>();
    for (const jc of allJcs) {
      const dept = (jc.departmentCode ?? "").toUpperCase();
      if (dept !== "UPHOLSTERY") continue;
      const slot = perPo.get(jc.productionOrderId) ?? { total: 0, done: 0 };
      slot.total += 1;
      const st = (jc.status ?? "").toUpperCase();
      if (st === "COMPLETED" || st === "TRANSFERRED") slot.done += 1;
      perPo.set(jc.productionOrderId, slot);
    }
    for (const [poId, c] of perPo) {
      if (c.total > 0 && c.done === c.total) fullUphPoIds.add(poId);
    }
  }

  // 5a — producer-add: every JC with status DONE, dept != PACKING, label
  // non-empty contributes +effQty to its own wipLabel.
  // 5b — UPH self-add is just the same loop (UPH falls through with
  // dept!=PACKING and gets its own row written too — see line 1284-1306).
  // BUG-2026-04-30-003 mirror: skip producer-add for UPH JCs in
  // fully-UPH-complete POs (their net contribution is 0 after Plan B
  // subtract).
  for (const jc of allJcs) {
    const dept = (jc.departmentCode ?? "").toUpperCase();
    if (dept === "PACKING") continue;
    const status = (jc.status ?? "").toUpperCase();
    const isDone = status === "COMPLETED" || status === "TRANSFERRED";
    if (!isDone) continue;
    // BUG-2026-04-30-003 mirror: UPH in fully-UPH-done PO → net 0, skip.
    if (dept === "UPHOLSTERY" && fullUphPoIds.has(jc.productionOrderId)) {
      continue;
    }
    const po = poById.get(jc.productionOrderId);
    const label = synthLabel(jc, po);
    if (!label) continue;
    const qty = effQty(jc, po);
    bumpExpected(label, +qty);
    // wipType isn't on RebuildJcRow (we omitted it from SELECT — the
    // shortType is dept-aware enough). Use deptCode as the type seed.
    // The shortType helper only really needs wipType for a few enum
    // outputs; absent that, the dept code is a reasonable fallback for
    // INSERT metadata. (wip_items.type is informational, not load-bearing
    // for stock math.)
    recordMeta(
      label,
      shortType(null, dept),
      po?.productCode ?? "",
      dept === "UPHOLSTERY" ? "UPHOLSTERY" : dept,
    );
  }

  // 5c — per-component consume: non-UPH, non-FAB_CUT, non-WOOD_CUT,
  // non-PACKING JCs with status active|done — each contributes -effQty
  // to its upstream sibling's wipLabel.
  for (const jc of allJcs) {
    const dept = (jc.departmentCode ?? "").toUpperCase();
    if (
      dept === "UPHOLSTERY" ||
      dept === "FAB_CUT" ||
      dept === "WOOD_CUT" ||
      dept === "PACKING" ||
      dept === ""
    ) {
      continue;
    }
    const status = (jc.status ?? "").toUpperCase();
    const isActive =
      status === "IN_PROGRESS" ||
      status === "COMPLETED" ||
      status === "TRANSFERRED";
    if (!isActive) continue;
    const upstream = findUpstream(jc);
    if (!upstream || !upstream.wipLabel) continue;
    const po = poById.get(jc.productionOrderId);
    const qty = effQty(jc, po);
    bumpExpected(upstream.wipLabel, -qty);
    // If the upstream wip_items row doesn't exist yet (skipped dept), make
    // sure we still record meta so an INSERT can land if needed.
    const upPo = poById.get(upstream.productionOrderId);
    recordMeta(
      upstream.wipLabel,
      shortType(null, (upstream.departmentCode ?? "").toUpperCase()),
      upPo?.productCode ?? "",
      "PENDING",
    );
  }

  // 5d — UPH branch-terminal consume: each UPH JC (DONE) consumes -effQty
  // on each of its branch terminals' wipLabels.
  for (const jc of allJcs) {
    const dept = (jc.departmentCode ?? "").toUpperCase();
    if (dept !== "UPHOLSTERY") continue;
    const status = (jc.status ?? "").toUpperCase();
    const isDone = status === "COMPLETED" || status === "TRANSFERRED";
    if (!isDone) continue;
    const po = poById.get(jc.productionOrderId);
    const qty = effQty(jc, po);
    const terminals = findUphBranchTerminals(jc);
    for (const t of terminals) {
      if (!t.wipLabel) continue;
      bumpExpected(t.wipLabel, -qty);
      const tPo = poById.get(t.productionOrderId);
      recordMeta(
        t.wipLabel,
        shortType(null, (t.departmentCode ?? "").toUpperCase()),
        tPo?.productCode ?? "",
        "PENDING",
      );
    }
  }

  // ----- Step 6 — sofa FAB_SEW zero-out edge case -----
  // Group sofa POs by (parentDocId, fabricCode). parentDocId = SO id OR
  // CO id — without the CO branch, CO sofa groups skipped this step
  // entirely and FAB_CUT WIP for CO sofas drifted away from truth.
  // If any FAB_SEW JC across the group is IN_PROGRESS|COMPLETED|
  // TRANSFERRED, every FAB_CUT wipLabel in that group's POs is forced
  // to 0.
  type SofaGroupKey = string; // `${parentDocId}|${fabricCode}`
  const sofaGroups = new Map<SofaGroupKey, RebuildPoRow[]>();
  for (const po of poById.values()) {
    if ((po.itemCategory ?? "").toUpperCase() !== "SOFA") continue;
    const parentDocId = po.salesOrderId || po.consignmentOrderId || "";
    if (!parentDocId || !po.fabricCode) continue;
    const k = `${parentDocId}|${po.fabricCode}`;
    const list = sofaGroups.get(k) ?? [];
    list.push(po);
    sofaGroups.set(k, list);
  }

  const zeroedFabCutLabels = new Set<string>();
  for (const [, pos] of sofaGroups) {
    // Has any FAB_SEW in this group transitioned past WAITING?
    let triggered = false;
    for (const po of pos) {
      const jcs = jcsByPo.get(po.id) ?? [];
      for (const jc of jcs) {
        if ((jc.departmentCode ?? "").toUpperCase() !== "FAB_SEW") continue;
        const st = (jc.status ?? "").toUpperCase();
        if (
          st === "IN_PROGRESS" ||
          st === "COMPLETED" ||
          st === "TRANSFERRED"
        ) {
          triggered = true;
          break;
        }
      }
      if (triggered) break;
    }
    if (!triggered) continue;
    // Force every FAB_CUT wipLabel in this group to 0.
    for (const po of pos) {
      const jcs = jcsByPo.get(po.id) ?? [];
      for (const jc of jcs) {
        if ((jc.departmentCode ?? "").toUpperCase() !== "FAB_CUT") continue;
        const label = synthLabel(jc, po);
        if (!label) continue;
        zeroedFabCutLabels.add(label);
      }
    }
  }
  for (const label of zeroedFabCutLabels) {
    expected.set(label, 0);
  }

  // ----- Step 7 — diff against current wip_items, build plan -----
  type UpdatePlan = { id: string; code: string; from: number; to: number };
  type InsertPlan = {
    code: string;
    qty: number;
    type: string;
    relatedProduct: string;
    deptStatus: string;
  };
  type DeletePlan = { id: string; code: string; from: number };

  const updates: UpdatePlan[] = [];
  const inserts: InsertPlan[] = [];
  const deletes: DeletePlan[] = [];

  // Drift before = sum(current stockQty across all rows) — sum(expected
  // across all expected codes ∪ current codes).
  let totalCurrentSum = 0;
  for (const w of wipRes.results ?? []) totalCurrentSum += w.stockQty || 0;
  let totalExpectedSum = 0;
  for (const v of expected.values()) totalExpectedSum += v;
  // For codes that exist in wip_items but NOT in expected, treat expected as 0.
  for (const w of wipRes.results ?? []) {
    if (!expected.has(w.code)) {
      // expected effectively 0 for this code; drift is -(current).
    }
  }
  const totalDriftBefore = totalCurrentSum - totalExpectedSum;

  // For each code in expected: if existing row, plan UPDATE (or DELETE if
  // expected==0 and current!=0); else if expected != 0, plan INSERT.
  for (const [code, qty] of expected) {
    if (!matchesScope(code)) continue;
    const cur = wipByCode.get(code);
    if (cur) {
      if ((cur.stockQty || 0) === qty) continue;
      if (qty === 0) {
        deletes.push({ id: cur.id, code, from: cur.stockQty });
      } else {
        updates.push({ id: cur.id, code, from: cur.stockQty, to: qty });
      }
    } else if (qty !== 0) {
      const meta = codeMeta.get(code) ?? {
        type: "WIP",
        relatedProduct: "",
        deptStatus: "PENDING",
      };
      inserts.push({
        code,
        qty,
        type: meta.type,
        relatedProduct: meta.relatedProduct,
        deptStatus: meta.deptStatus,
      });
    }
  }

  // For codes in wip_items but NOT in expected: expected = 0. If
  // current != 0, plan DELETE. (If current == 0, leave alone — don't
  // delete already-zero unrelated rows.)
  for (const w of wipRes.results ?? []) {
    if (!matchesScope(w.code)) continue;
    if (expected.has(w.code)) continue;
    if ((w.stockQty || 0) !== 0) {
      deletes.push({ id: w.id, code: w.code, from: w.stockQty });
    }
  }

  // ----- Aggregates for response -----
  // Per-dept summary (rough — keyed off codeMeta.type which is dept-ish).
  const byDept: Record<
    string,
    { update: number; insert: number; delete: number; netDelta: number }
  > = {};
  const deptOf = (code: string): string => {
    const meta = codeMeta.get(code);
    if (meta) return meta.deptStatus || meta.type || "UNKNOWN";
    // Fall back to whatever the existing wip_items row says.
    const w = wipByCode.get(code);
    return w?.deptStatus || w?.type || "UNKNOWN";
  };
  const bumpDept = (code: string, kind: "update" | "insert" | "delete", delta: number): void => {
    const k = deptOf(code);
    const slot = byDept[k] ?? { update: 0, insert: 0, delete: 0, netDelta: 0 };
    slot[kind] += 1;
    slot.netDelta += delta;
    byDept[k] = slot;
  };
  for (const u of updates) bumpDept(u.code, "update", u.to - u.from);
  for (const i of inserts) bumpDept(i.code, "insert", i.qty);
  for (const d of deletes) bumpDept(d.code, "delete", -d.from);

  // Sample: 20 biggest absolute changes (worst inflated rows getting
  // brought down, biggest insertions, biggest deletions).
  type SampleRow = {
    code: string;
    currentQty: number;
    expectedQty: number;
    diff: number;
    op: "update" | "insert" | "delete";
  };
  const sampleAll: SampleRow[] = [];
  for (const u of updates) {
    sampleAll.push({
      code: u.code,
      currentQty: u.from,
      expectedQty: u.to,
      diff: u.to - u.from,
      op: "update",
    });
  }
  for (const i of inserts) {
    sampleAll.push({
      code: i.code,
      currentQty: 0,
      expectedQty: i.qty,
      diff: i.qty,
      op: "insert",
    });
  }
  for (const d of deletes) {
    sampleAll.push({
      code: d.code,
      currentQty: d.from,
      expectedQty: 0,
      diff: -d.from,
      op: "delete",
    });
  }
  sampleAll.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const sample = sampleAll.slice(0, 20);

  // Drift after: should be 0 if formula is correct. Compute by simulating
  // the planned writes.
  let projectedSum = totalCurrentSum;
  for (const u of updates) projectedSum += u.to - u.from;
  for (const i of inserts) projectedSum += i.qty;
  for (const d of deletes) projectedSum += -d.from;
  const totalDriftAfter = projectedSum - totalExpectedSum;

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      totalRowsBefore,
      totalCodesExpected: expected.size,
      rowsToUpdate: updates.length,
      rowsToInsert: inserts.length,
      rowsToDelete: deletes.length,
      totalCurrentSum,
      totalExpectedSum,
      totalDriftBefore,
      totalDriftAfter,
      sofaFabCutZeroedLabelCount: zeroedFabCutLabels.size,
      fullUphPoCount: fullUphPoIds.size,
      byDept,
      sample,
    });
  }

  // ----- Live mode — single atomic batch -----
  const stmts: D1PreparedStatement[] = [];
  for (const u of updates) {
    stmts.push(
      db
        .prepare(`UPDATE wip_items SET stockQty = ? WHERE id = ?`)
        .bind(u.to, u.id),
    );
  }
  for (const i of inserts) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO wip_items (id, code, type, relatedProduct, deptStatus, stockQty, status)
           VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
           ON CONFLICT (org_id, code) DO UPDATE SET
             stockQty = EXCLUDED.stockQty,
             deptStatus = EXCLUDED.deptStatus`,
        )
        .bind(
          `wip-rebuild-${crypto.randomUUID().slice(0, 8)}`,
          i.code,
          i.type,
          i.relatedProduct,
          i.deptStatus,
          i.qty,
        ),
    );
  }
  for (const d of deletes) {
    stmts.push(
      db.prepare(`DELETE FROM wip_items WHERE id = ?`).bind(d.id),
    );
  }

  let batchOk = true;
  let batchError: string | null = null;
  let updatesApplied = 0;
  let insertsApplied = 0;
  let deletesApplied = 0;
  try {
    const batchResults = await db.batch(stmts);
    let i = 0;
    for (const _u of updates) {
      const r = batchResults[i++];
      if ((r?.meta?.changes ?? 0) > 0) updatesApplied += 1;
    }
    for (const _ins of inserts) {
      const r = batchResults[i++];
      if ((r?.meta?.changes ?? 0) > 0) insertsApplied += 1;
    }
    for (const _d of deletes) {
      const r = batchResults[i++];
      if ((r?.meta?.changes ?? 0) > 0) deletesApplied += 1;
    }
  } catch (err) {
    batchOk = false;
    batchError = err instanceof Error ? err.message : String(err);
  }

  return c.json({
    success: batchOk,
    dryRun: false,
    totalRowsBefore,
    rowsUpdated: updatesApplied,
    rowsInserted: insertsApplied,
    rowsDeleted: deletesApplied,
    rowsToUpdate: updates.length,
    rowsToInsert: inserts.length,
    rowsToDelete: deletes.length,
    totalDriftBefore,
    totalDriftAfter,
    sofaFabCutZeroedLabelCount: zeroedFabCutLabels.size,
    byDept,
    sample,
    batchError,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-fabcut-rm-issue?dryRun=true|false
//
// One-shot data migration: walk every production_orders row that has at
// least one FAB_CUT JC in COMPLETED/TRANSFERRED status but no RM_ISSUE
// cost_ledger row yet (refType='PRODUCTION_ORDER', refId=po.id).
//
// For each PO, run consumeRawMaterialsForPO(po.id) which:
//   - Resolves materials from bom_templates.wipComponents (active)
//     scoped by po.productCode
//   - Multiplies per-piece qty × parent FC node's pieceCount × po.quantity
//   - FIFO-consumes rm_batches
//   - Writes one cost_ledger RM_ISSUE row per slice (refType=PRODUCTION_ORDER)
//   - Decrements raw_materials.balanceQty
//
// Idempotent on re-run (consumeRawMaterialsForPO checks for existing
// RM_ISSUE row keyed on refType='PRODUCTION_ORDER', refId=po.id).
//
// Why this exists: as of 2026-05-07 the F1 trigger moved from PO
// completion to FAB_CUT JC completion. POs whose FAB_CUT JCs were
// completed BEFORE that change still consume at PO completion if they
// finish; this endpoint forces a retroactive consume for POs that have
// FAB_CUT done but PO not yet COMPLETED (so haven't naturally triggered
// the legacy F1 path either).
//
// dryRun=true → counts only, no DB writes (default)
// dryRun=false → executes the consume batch
// ---------------------------------------------------------------------------
app.post("/backfill-fabcut-rm-issue", async (c) => {
  // This was the ONLY handler of the eleven in this file with no permission
  // check — the other ten all gate on exactly this pair. An omission, not a
  // decision: with `?dryRun=false` it calls consumeRawMaterialsForPO, which
  // writes rm_batches, raw_materials.balanceQty and cost_ledger RM_ISSUE, so
  // any authenticated user of any role could move stock and cost.
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const dryRun = c.req.query("dryRun") !== "false";
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? 200), 10),
    1000,
  );
  const db = c.var.DB;

  // Find DISTINCT POs that have at least one done FAB_CUT JC but no
  // PO-level RM_ISSUE row. Bound at `limit` per call so a single Workers
  // invocation finishes before hitting wall-clock budget.
  const cursor = c.req.query("cursor") || "";
  const candidates = await db
    .prepare(
      `SELECT DISTINCT po.id, po.poNo, po.productCode, po.fabricCode,
              po.itemCategory, po.status
         FROM production_orders po
         INNER JOIN job_cards jc ON jc.productionOrderId = po.id
         WHERE jc.departmentCode = 'FAB_CUT'
           AND jc.status IN ('COMPLETED', 'TRANSFERRED')
           AND po.id > ?
           AND NOT EXISTS (
             SELECT 1 FROM cost_ledger cl
              WHERE cl.refType = 'PRODUCTION_ORDER'
                AND cl.refId = po.id
                AND cl.type = 'RM_ISSUE'
           )
         ORDER BY po.id ASC
         LIMIT ?`,
    )
    .bind(cursor, limit)
    .all<{
      id: string;
      poNo: string | null;
      productCode: string | null;
      fabricCode: string | null;
      itemCategory: string | null;
      status: string | null;
    }>();

  const candidateRows = candidates.results ?? [];
  const total = candidateRows.length;

  if (dryRun) {
    const byCategory: Record<string, number> = {};
    for (const r of candidateRows) {
      const k = r.itemCategory || "(unknown)";
      byCategory[k] = (byCategory[k] ?? 0) + 1;
    }
    const lastId =
      candidateRows.length > 0
        ? candidateRows[candidateRows.length - 1].id
        : "";
    return c.json({
      success: true,
      dryRun: true,
      candidatesScanned: total,
      candidatesByCategory: byCategory,
      sample: candidateRows.slice(0, 10).map((r) => ({
        poId: r.id,
        poNo: r.poNo,
        productCode: r.productCode,
        fabricCode: r.fabricCode,
        itemCategory: r.itemCategory,
        status: r.status,
      })),
      nextCursor: candidateRows.length === limit ? lastId : null,
    });
  }

  // Real run: invoke consumeRawMaterialsForPO per candidate PO. Each
  // call is idempotent. Collect per-PO results.
  let consumed = 0;
  let skipped = 0;
  const errors: { poId: string; error: string }[] = [];
  let totalMaterialCostSen = 0;
  let totalLinesConsumed = 0;
  const shortageSamples: {
    poId: string;
    materialName: string;
    shortageQty: number;
  }[] = [];

  for (const r of candidateRows) {
    try {
      const result = await consumeRawMaterialsForPO(db, r.id);
      if (result.skipped) {
        skipped++;
      } else {
        consumed++;
        totalMaterialCostSen += result.materialCostSen;
        totalLinesConsumed += result.linesConsumed;
        for (const s of result.shortages.slice(0, 3)) {
          if (shortageSamples.length < 20) {
            shortageSamples.push({ poId: r.id, ...s });
          }
        }
      }
    } catch (err) {
      errors.push({
        poId: r.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const lastId =
    candidateRows.length > 0
      ? candidateRows[candidateRows.length - 1].id
      : "";
  return c.json({
    success: true,
    dryRun: false,
    scanned: total,
    consumed,
    skipped,
    errorCount: errors.length,
    errors: errors.slice(0, 10),
    totalMaterialCostSen,
    totalLinesConsumed,
    shortageSamples,
    nextCursor: candidateRows.length === limit ? lastId : null,
  });
});

app.post("/backfill-jc-production-time-from-bom", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  // Default ON per operator directive — only set false to opt back into
  // active-only scope.
  const includeCompleted = c.req.query("includeCompleted") !== "false";

  // 1. Load every JC across the statuses we care about, joined to PO so we
  // have the variant context the BOM walker needs without a second pass.
  const allStatuses = [...ACTIVE_JC_STATUSES, ...COMPLETED_JC_STATUSES];
  const placeholders = allStatuses.map(() => "?").join(",");
  const sel = await db
    .prepare(
      `SELECT
         jc.id                    AS id,
         jc.productionOrderId     AS productionOrderId,
         jc.status                AS status,
         jc.wipKey                AS wipKey,
         jc.departmentCode        AS departmentCode,
         jc.productionTimeMinutes AS productionTimeMinutes,
         jc.estMinutes            AS estMinutes,
         po.poNo                  AS poNo,
         po.productCode           AS productCode,
         po.quantity              AS quantity,
         po.itemCategory          AS itemCategory,
         po.sizeCode              AS sizeCode,
         po.sizeLabel             AS sizeLabel,
         po.fabricCode            AS fabricCode,
         po.divanHeightInches     AS divanHeightInches,
         po.legHeightInches       AS legHeightInches,
         po.gapInches             AS gapInches
       FROM job_cards jc
       LEFT JOIN production_orders po ON po.id = jc.productionOrderId
       WHERE jc.status IN (${placeholders})
       ORDER BY jc.id ASC`,
    )
    .bind(...allStatuses)
    .all<JcBackfillRow>();
  const rows = sel.results ?? [];

  // 2. Cache BOM template lookups per-productCode. Many JCs share the same
  // product, so a Map saves O(n) DB calls.
  type BomCacheEntry = {
    wipComponents: string | null;
    l1Processes: string | null;
    baseModel: string | null;
  } | null;
  const bomCache = new Map<string, BomCacheEntry>();
  async function loadBom(productCode: string): Promise<BomCacheEntry> {
    if (bomCache.has(productCode)) return bomCache.get(productCode)!;
    const active = await db
      .prepare(
        `SELECT wipComponents, l1Processes, baseModel FROM bom_templates
           WHERE productCode = ? AND versionStatus = 'ACTIVE'
           ORDER BY effectiveFrom DESC LIMIT 1`,
      )
      .bind(productCode)
      .first<{
        wipComponents: string | null;
        l1Processes: string | null;
        baseModel: string | null;
      }>();
    if (active) {
      bomCache.set(productCode, active);
      return active;
    }
    const latest = await db
      .prepare(
        `SELECT wipComponents, l1Processes, baseModel FROM bom_templates
           WHERE productCode = ? ORDER BY effectiveFrom DESC LIMIT 1`,
      )
      .bind(productCode)
      .first<{
        wipComponents: string | null;
        l1Processes: string | null;
        baseModel: string | null;
      }>();
    bomCache.set(productCode, latest ?? null);
    return latest ?? null;
  }

  // 3. Walk each JC, look up its expected per-WIP per-dept minutes from the
  // current BOM tree, classify drift.
  const activeDrifts: DriftSample[] = [];
  const completedDrifts: DriftSample[] = [];
  const updates: Array<{ id: string; newMinutes: number }> = [];
  // 5536-CSL / 5540-CSL guard: BOM walker emitted 0 minutes but stored
  // value is non-zero — preserve and surface for operator audit.
  const bomZeroPreservedSamples: Array<{
    jcId: string;
    poNo: string;
    productCode: string;
    wipKey: string;
    deptCode: string;
    storedMinutes: number;
    status: string;
  }> = [];
  let bomZeroPreservedCount = 0;
  let scanned = 0;
  let unchanged = 0;
  let skippedNoBom = 0;
  let skippedFg = 0;
  let skippedNoMatch = 0;

  for (const r of rows) {
    scanned++;
    const productCode = r.productCode ?? "";
    const wipKey = r.wipKey ?? "";
    const deptCode = r.departmentCode ?? "";
    if (!productCode || !wipKey || !deptCode) {
      skippedNoMatch++;
      continue;
    }
    // FG-level (wipKey="FG") JCs are driven by l1Processes, which is the
    // master Production Times path — out of scope for the BOM-tree backfill.
    if (wipKey === "FG") {
      skippedFg++;
      continue;
    }

    const bom = await loadBom(productCode);
    if (!bom || !bom.wipComponents) {
      skippedNoBom++;
      continue;
    }

    const variants: BomVariantContext = {
      productCode,
      model: bom.baseModel ?? productCode,
      sizeLabel: r.sizeLabel ?? "",
      sizeCode: r.sizeCode ?? "",
      fabricCode: r.fabricCode ?? "",
      divanHeightInches: r.divanHeightInches ?? null,
      legHeightInches: r.legHeightInches ?? null,
      gapInches: r.gapInches ?? null,
    };
    const wips = breakBomIntoWips(bom.wipComponents, productCode, variants);
    const wip = wips.find((w) => w.wipKey === wipKey);
    if (!wip) {
      skippedNoMatch++;
      continue;
    }
    const proc = wip.processes.find((p) => p.deptCode === deptCode);
    if (!proc) {
      skippedNoMatch++;
      continue;
    }

    const oldMinutes = r.productionTimeMinutes ?? 0;
    const newMinutes = proc.minutes;

    // 5536-CSL / 5540-CSL guard: BOM walker says 0 but JC has non-zero
    // stored minutes. Likely a missing UPH stanza on the top-level BOM
    // node — DO NOT zero out (would erase already-credited work). Surface
    // for operator review and skip the write.
    if (newMinutes === 0 && oldMinutes > 0) {
      bomZeroPreservedCount++;
      if (bomZeroPreservedSamples.length < 50) {
        bomZeroPreservedSamples.push({
          jcId: r.id,
          poNo: r.poNo ?? "",
          productCode,
          wipKey,
          deptCode,
          storedMinutes: oldMinutes,
          status: r.status,
        });
      }
      continue;
    }

    if (oldMinutes === newMinutes && (r.estMinutes ?? 0) === newMinutes) {
      unchanged++;
      continue;
    }

    const sample: DriftSample = {
      jcId: r.id,
      poNo: r.poNo ?? "",
      productCode,
      wipKey,
      deptCode,
      status: r.status,
      oldMinutes,
      newMinutes,
      delta: newMinutes - oldMinutes,
    };
    if (COMPLETED_JC_STATUSES.includes(r.status)) {
      completedDrifts.push(sample);
      // Operator directive 2026-05-08: when includeCompleted=true (default)
      // also queue the COMPLETED/TRANSFERRED rows for UPDATE. Surgical —
      // only productionTimeMinutes + estMinutes change, not status / pics /
      // completedDate / actualMinutes.
      if (includeCompleted) {
        updates.push({ id: r.id, newMinutes });
      }
    } else {
      activeDrifts.push(sample);
      updates.push({ id: r.id, newMinutes });
    }
  }

  // Sort top-N by absolute delta so the operator sees the worst drifts first.
  const sortByAbsDelta = (a: DriftSample, b: DriftSample) =>
    Math.abs(b.delta) - Math.abs(a.delta);
  activeDrifts.sort(sortByAbsDelta);
  completedDrifts.sort(sortByAbsDelta);

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      includeCompleted,
      scanned,
      activeDrifted: activeDrifts.length,
      completedDrifted: completedDrifts.length,
      // wouldUpdate reflects the actual write queue for the configured
      // includeCompleted scope — easier for operator to compare against
      // the live-run `updated` count.
      wouldUpdate: updates.length,
      unchanged,
      bomZeroPreserved: bomZeroPreservedCount,
      skipped: {
        fgWipKey: skippedFg,
        noBom: skippedNoBom,
        noWipOrDeptMatch: skippedNoMatch,
      },
      topActiveDrifts: activeDrifts.slice(0, 30),
      topCompletedDrifts: completedDrifts.slice(0, 30),
      bomZeroPreservedSamples,
    });
  }

  // 4. Real run — apply UPDATEs in chunks of 50.
  const CHUNK = 50;
  let updated = 0;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    const stmts = slice.map((u) =>
      db
        .prepare(
          `UPDATE job_cards
             SET productionTimeMinutes = ?, estMinutes = ?
             WHERE id = ?`,
        )
        .bind(u.newMinutes, u.newMinutes, u.id),
    );
    if (stmts.length > 0) {
      try {
        await db.batch(stmts);
        updated += stmts.length;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json(
          {
            success: false,
            error: `Batch UPDATE failed at chunk ${i}: ${message}`,
            updatedBeforeFailure: updated,
          },
          500,
        );
      }
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    includeCompleted,
    scanned,
    activeDrifted: activeDrifts.length,
    completedDrifted: completedDrifts.length,
    updated,
    unchanged,
    bomZeroPreserved: bomZeroPreservedCount,
    skipped: {
      fgWipKey: skippedFg,
      noBom: skippedNoBom,
      noWipOrDeptMatch: skippedNoMatch,
    },
    topActiveDrifts: activeDrifts.slice(0, 30),
    topCompletedDrifts: completedDrifts.slice(0, 30),
    bomZeroPreservedSamples,
  });
});

app.post("/refresh-jcs-by-id", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: { jcIds?: unknown; dryRun?: unknown };
  try {
    body = (await c.req.json()) as { jcIds?: unknown; dryRun?: unknown };
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const jcIds = Array.isArray(body.jcIds)
    ? body.jcIds.filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      )
    : null;
  if (!jcIds || jcIds.length === 0) {
    return c.json(
      {
        success: false,
        error: "body.jcIds must be a non-empty array of strings",
      },
      400,
    );
  }
  const dryRun = body.dryRun === true;
  const db = c.var.DB;

  // Load JCs by exact id list — no sweep, no filter, just SELECT WHERE IN.
  const placeholders = jcIds.map(() => "?").join(",");
  const sel = await db
    .prepare(
      `SELECT
         jc.id                AS id,
         jc.productionOrderId AS productionOrderId,
         jc.status            AS status,
         jc.wipKey            AS wipKey,
         jc.departmentCode    AS departmentCode,
         jc.wipCode           AS wipCode,
         jc.wipLabel          AS wipLabel,
         po.poNo              AS poNo,
         po.productCode       AS productCode,
         po.itemCategory      AS itemCategory,
         po.sizeCode          AS sizeCode,
         po.sizeLabel         AS sizeLabel,
         po.fabricCode        AS fabricCode,
         po.divanHeightInches AS divanHeightInches,
         po.legHeightInches   AS legHeightInches,
         po.gapInches         AS gapInches
       FROM job_cards jc
       LEFT JOIN production_orders po ON po.id = jc.productionOrderId
       WHERE jc.id IN (${placeholders})`,
    )
    .bind(...jcIds)
    .all<RefreshJcRow>();
  const rows = sel.results ?? [];
  const foundIds = new Set(rows.map((r) => r.id));
  const notFound = jcIds.filter((id) => !foundIds.has(id));

  // BOM cache (one ACTIVE template per productCode; falls back to most
  // recent draft if no ACTIVE row).
  const bomCache = new Map<
    string,
    { wipComponents: string | null; baseModel: string | null } | null
  >();
  async function loadBom(productCode: string) {
    if (bomCache.has(productCode)) return bomCache.get(productCode);
    const active = await db
      .prepare(
        `SELECT wipComponents, baseModel FROM bom_templates
           WHERE productCode = ? AND versionStatus = 'ACTIVE'
           ORDER BY effectiveFrom DESC LIMIT 1`,
      )
      .bind(productCode)
      .first<{ wipComponents: string | null; baseModel: string | null }>();
    if (active) {
      bomCache.set(productCode, active);
      return active;
    }
    const latest = await db
      .prepare(
        `SELECT wipComponents, baseModel FROM bom_templates
           WHERE productCode = ? ORDER BY effectiveFrom DESC LIMIT 1`,
      )
      .bind(productCode)
      .first<{ wipComponents: string | null; baseModel: string | null }>();
    bomCache.set(productCode, latest ?? null);
    return latest;
  }

  type Result = {
    jcId: string;
    poNo?: string;
    productCode?: string;
    deptCode?: string;
    isFcMerge?: boolean;
    before?: { wipCode: string; wipLabel: string };
    after?: { wipCode: string; wipLabel: string };
    changed?: boolean;
    error?: string;
  };
  const results: Result[] = [];
  const updates: Array<{
    id: string;
    newWipCode: string;
    newWipLabel: string;
  }> = [];

  for (const r of rows) {
    const productCode = r.productCode || "";
    if (!productCode) {
      results.push({ jcId: r.id, error: "PO missing productCode" });
      continue;
    }
    // FC-merge detection: jcId convention OR wipKey shape. The id-prefix
    // form was added later (jc-fc-so- / jc-fc-po-); legacy FC-merge JCs
    // created before that convention have jcId `jc-pord-so-...` but their
    // wipKey still follows the merge format
    // `{idShape}::{baseModel}::{fabricCode}::FAB_CUT` where segment 0 is
    // a poId / SO- / CO- id (NOT a productCode). Detect both forms so the
    // walker uses buildFcWipLabel-style logic instead of trying to match
    // a non-existent BOM tree node.
    const wkSegs = (r.wipKey || "").split("::");
    const isFcMergeByKey =
      wkSegs.length === 4 &&
      wkSegs[3] === "FAB_CUT" &&
      (wkSegs[0].startsWith("pord-") ||
        wkSegs[0].startsWith("SO-") ||
        wkSegs[0].startsWith("CO-"));
    const isFcMerge =
      r.id.startsWith("jc-fc-so-") ||
      r.id.startsWith("jc-fc-po-") ||
      isFcMergeByKey;
    const oldWipCode = r.wipCode ?? "";
    const oldWipLabel = r.wipLabel ?? "";
    let newWipCode = oldWipCode;
    let newWipLabel = oldWipLabel;

    if (isFcMerge) {
      // FAB_CUT cross-PO merge JC: wipLabel format is buildFcWipLabel-style
      // (productCode | (size) | (totalH") | (DV divanH") | fabric | (FC));
      // wipCode is the BOM walker's FAB_CUT process output for the anchor
      // piece (DIVAN/HEADBOARD).
      const totalH =
        (r.gapInches ?? 0) +
        (r.divanHeightInches ?? 0) +
        (r.legHeightInches ?? 0);
      const isBF = r.itemCategory === "BEDFRAME";
      newWipLabel = [
        productCode,
        r.sizeLabel ? `(${r.sizeLabel})` : "",
        isBF && totalH > 0 ? `(${totalH}")` : "",
        isBF && r.divanHeightInches ? `(DV ${r.divanHeightInches}")` : "",
        r.fabricCode || "",
        "(FC)",
      ]
        .filter(Boolean)
        .join(" | ");

      const bom = await loadBom(productCode);
      if (bom?.wipComponents) {
        const variants: BomVariantContext = {
          productCode,
          model: bom.baseModel ?? productCode,
          sizeLabel: r.sizeLabel ?? "",
          sizeCode: r.sizeCode ?? "",
          fabricCode: r.fabricCode ?? "",
          divanHeightInches: r.divanHeightInches ?? null,
          legHeightInches: r.legHeightInches ?? null,
          gapInches: r.gapInches ?? null,
        };
        const wips = breakBomIntoWips(
          bom.wipComponents,
          productCode,
          variants,
        );
        const anchor = wips.find((w) =>
          w.processes.some((p) => p.deptCode === "FAB_CUT"),
        );
        if (anchor) {
          const proc = anchor.processes.find((p) => p.deptCode === "FAB_CUT");
          newWipCode = proc?.wipCode || anchor.wipCode || oldWipCode;
        }
      }
    } else {
      // Standard BOM-tree JC: re-walk current ACTIVE BOM, match by wipKey
      // or single-dept fallback, use process's wipCode/wipLabel.
      const bom = await loadBom(productCode);
      if (!bom?.wipComponents) {
        results.push({
          jcId: r.id,
          poNo: r.poNo ?? undefined,
          productCode,
          deptCode: r.departmentCode ?? undefined,
          error: "No active BOM template",
        });
        continue;
      }
      const variants: BomVariantContext = {
        productCode,
        model: bom.baseModel ?? productCode,
        sizeLabel: r.sizeLabel ?? "",
        sizeCode: r.sizeCode ?? "",
        fabricCode: r.fabricCode ?? "",
        divanHeightInches: r.divanHeightInches ?? null,
        legHeightInches: r.legHeightInches ?? null,
        gapInches: r.gapInches ?? null,
      };
      const wips = breakBomIntoWips(bom.wipComponents, productCode, variants);
      let wip = wips.find((w) => w.wipKey === r.wipKey);
      // Fallback 1: match on wipKey segments 0-2 (productCode::idx::wipType).
      // The 4th segment is the rawTopCode template — if the BOM template was
      // edited, the old JC's wipKey diverges from the new walker's output but
      // the first 3 segments are stable. Common case: BOM editor changed
      // {DIVAN_HEIGHT} Divan- {SIZE} → {PRODUCT_CODE} Divan- {SIZE} (or
      // similar), JCs created under the old template need to match the new
      // walker output by wipType + position.
      if (!wip && r.wipKey) {
        const oldSegs = r.wipKey.split("::");
        if (oldSegs.length >= 3) {
          const oldPrefix = oldSegs.slice(0, 3).join("::");
          wip = wips.find((w) => {
            const newSegs = w.wipKey.split("::");
            return newSegs.slice(0, 3).join("::") === oldPrefix;
          });
        }
      }
      // Fallback 2: match on wipKey segments 1-2 only (idx::wipType), ignoring
      // segment 0 (productCode). Used when PO's productCode was corrected
      // (e.g. SOFA variant swap LHF↔RHF via /backfill-po-from-so-lines): the
      // JC's old wipKey has the stale productCode but idx + wipType are
      // stable within the BOM tree so segments 1-2 still identify the WIP.
      if (!wip && r.wipKey) {
        const oldSegs = r.wipKey.split("::");
        if (oldSegs.length >= 3) {
          const oldIdxType = `${oldSegs[1]}::${oldSegs[2]}`;
          wip = wips.find((w) => {
            const newSegs = w.wipKey.split("::");
            return (
              newSegs.length >= 3 &&
              `${newSegs[1]}::${newSegs[2]}` === oldIdxType
            );
          });
        }
      }
      // Fallback 3: pick the only WIP that has a process for this dept.
      if (!wip && r.departmentCode) {
        const candidates = wips.filter((w) =>
          w.processes.some((p) => p.deptCode === r.departmentCode),
        );
        if (candidates.length === 1) wip = candidates[0];
      }
      if (!wip) {
        results.push({
          jcId: r.id,
          poNo: r.poNo ?? undefined,
          productCode,
          deptCode: r.departmentCode ?? undefined,
          error:
            "No matching WIP in BOM (wipKey + segment-prefix + idx-type + dept fallback all failed)",
        });
        continue;
      }
      const proc = wip.processes.find((p) => p.deptCode === r.departmentCode);
      if (!proc) {
        results.push({
          jcId: r.id,
          poNo: r.poNo ?? undefined,
          productCode,
          deptCode: r.departmentCode ?? undefined,
          error: "Matched WIP but no process for this dept",
        });
        continue;
      }
      newWipCode = proc.wipCode || wip.wipCode || oldWipCode;
      newWipLabel = proc.wipLabel || wip.wipLabel || oldWipLabel;
    }

    const changed = newWipCode !== oldWipCode || newWipLabel !== oldWipLabel;
    results.push({
      jcId: r.id,
      poNo: r.poNo ?? undefined,
      productCode,
      deptCode: r.departmentCode ?? undefined,
      isFcMerge,
      before: { wipCode: oldWipCode, wipLabel: oldWipLabel },
      after: { wipCode: newWipCode, wipLabel: newWipLabel },
      changed,
    });
    if (changed) {
      updates.push({ id: r.id, newWipCode, newWipLabel });
    }
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      requested: jcIds.length,
      found: rows.length,
      notFound,
      changed: updates.length,
      unchanged: rows.length - updates.length,
      results,
    });
  }

  // Live UPDATE in chunks of 50 (D1 batch limit-friendly). On chunk error,
  // record + continue so partial progress lands; caller can re-run.
  const CHUNK = 50;
  let updated = 0;
  const errors: Array<{ chunk: number; message: string }> = [];
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    const stmts = slice.map((u) =>
      db
        .prepare(
          `UPDATE job_cards SET wipCode = ?, wipLabel = ? WHERE id = ?`,
        )
        .bind(u.newWipCode, u.newWipLabel, u.id),
    );
    if (stmts.length === 0) continue;
    try {
      await db.batch(stmts);
      updated += stmts.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ chunk: i, message });
    }
  }

  return c.json({
    success: errors.length === 0,
    dryRun: false,
    requested: jcIds.length,
    found: rows.length,
    notFound,
    updated,
    changed: updates.length,
    unchanged: rows.length - updates.length,
    results,
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/delete-jcs-by-ids
//
// Surgical job_cards cleanup — deletes only the explicit JC IDs passed in
// the body. Used after /append-missing-pos when the appendOnly cascade
// emits a duplicate FAB_CUT JC for a PO that already had a per-piece
// FAB_CUT JC tracked under a different jcId convention (legacy long-form
// vs new aggregator short-form jc-fc-po-).
//
// Body: { jcIds: string[], dryRun: boolean }
// Permission: production-orders:update.
// ---------------------------------------------------------------------------
app.post("/delete-jcs-by-ids", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: { jcIds?: unknown; dryRun?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const ids = Array.isArray(body.jcIds)
    ? body.jcIds.filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      )
    : null;
  if (!ids || ids.length === 0) {
    return c.json(
      { success: false, error: "body.jcIds must be a non-empty array" },
      400,
    );
  }
  const dryRun = body.dryRun === true;
  const db = c.var.DB;

  const placeholders = ids.map(() => "?").join(",");
  const existing = await db
    .prepare(
      `SELECT id, status, departmentCode, wipKey, productionOrderId
         FROM job_cards WHERE id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{
      id: string;
      status: string;
      departmentCode: string;
      wipKey: string;
      productionOrderId: string;
    }>();
  const rows = existing.results ?? [];
  const found = new Set(rows.map((r) => r.id));
  const notFound = ids.filter((id) => !found.has(id));

  // Refuse to delete COMPLETED / TRANSFERRED JCs (work credit + cost ledger
  // entries already posted; deleting would orphan those).
  const unsafe = rows.filter((r) =>
    ["COMPLETED", "TRANSFERRED"].includes(r.status),
  );
  if (unsafe.length > 0) {
    return c.json(
      {
        success: false,
        error: `Refuse to delete JCs with status COMPLETED/TRANSFERRED: ${unsafe.map((u) => `${u.id}(${u.status})`).slice(0, 5).join(", ")}`,
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
        status: r.status,
        deptCode: r.departmentCode,
        wipKey: r.wipKey,
      })),
    });
  }

  try {
    await db
      .prepare(`DELETE FROM job_cards WHERE id IN (${placeholders})`)
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
    deleted: rows.length,
    notFound,
  });
});

// ---------------------------------------------------------------------------
// /cleanup-headboard-only-divans
//
// One-shot backfill: BEDFRAME SOs/COs with specialOrder "Headboard Only"
// were generating full HB+DIVAN job_cards and fg_units before the fix
// landed. Real customer order is HB only — DIVAN pieces should never have
// been created. Sweep existing data and delete the orphaned DIVAN rows.
//
// Production-lock guard (per memory feedback_protect_completed_work.md):
//   - DIVAN job_cards with status='COMPLETED' are NEVER deleted — that
//     represents real completed factory work and is inviolate.
//   - DIVAN fg_units with status != 'PENDING' are NEVER deleted — anything
//     UPHOLSTERED / PACKED / LOADED / DELIVERED / RETURNED / etc. has
//     downstream contracts and must be preserved.
//
// Idempotent: safe to call multiple times. Default ?dryRun=true.
// ---------------------------------------------------------------------------
app.post("/cleanup-headboard-only-divans", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: { dryRun?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // empty body OK — defaults to dryRun=true
  }
  const dryRun = body.dryRun !== false;
  const db = c.var.DB;

  type Po = {
    id: string;
    poNo: string;
    salesOrderId: string | null;
    consignmentOrderId: string | null;
    productCode: string | null;
    specialOrder: string | null;
  };

  // Find every PO whose source line had specialOrder containing "Headboard
  // Only". We match on production_orders.specialOrder directly (the column
  // is denormalised from the SO/CO line at PO creation), so this works for
  // both SO-origin and CO-origin POs.
  const posRes = await db
    .prepare(
      `SELECT id, poNo, salesOrderId, consignmentOrderId, productCode, specialOrder
         FROM production_orders
        WHERE itemCategory = 'BEDFRAME'
          AND LOWER(IFNULL(specialOrder, '')) LIKE '%headboard only%'`,
    )
    .all<Po>();
  const pos = posRes.results ?? [];

  type Jc = {
    id: string;
    productionOrderId: string;
    wipType: string | null;
    departmentCode: string | null;
    status: string;
  };
  type Fgu = {
    id: string;
    poId: string | null;
    pieceName: string | null;
    status: string;
  };

  let scanned = 0;
  let eligibleSOs = 0;
  let deletedJCs = 0;
  let deletedFgUnits = 0;
  let skippedJcs = 0;
  let skippedFgUnits = 0;
  const sample: Array<{
    soId: string | null;
    coId: string | null;
    poNo: string;
    productCode: string | null;
    deletedPieces: string[];
  }> = [];

  const deleteStmts: D1PreparedStatement[] = [];

  for (const po of pos) {
    scanned++;

    // DIVAN job_cards on this PO. wipType is the canonical signal — every
    // DIVAN-piece JC has wipType='DIVAN' (see bom-wip-breakdown.ts).
    const jcRes = await db
      .prepare(
        `SELECT id, productionOrderId, wipType, departmentCode, status
           FROM job_cards
          WHERE productionOrderId = ?
            AND UPPER(IFNULL(wipType, '')) = 'DIVAN'`,
      )
      .bind(po.id)
      .all<Jc>();
    const divanJcs = jcRes.results ?? [];

    // DIVAN fg_units on this PO. pieceName 'Divan' (case-insensitive) is
    // the marker the existing pieces config emits.
    const fguRes = await db
      .prepare(
        `SELECT id, poId, pieceName, status
           FROM fg_units
          WHERE poId = ?
            AND UPPER(IFNULL(pieceName, '')) LIKE '%DIVAN%'`,
      )
      .bind(po.id)
      .all<Fgu>();
    const divanFgus = fguRes.results ?? [];

    if (divanJcs.length === 0 && divanFgus.length === 0) {
      continue;
    }
    eligibleSOs++;

    const deletedPieces: string[] = [];

    for (const jc of divanJcs) {
      // Production-lock: COMPLETED is real factory work — never delete.
      if (jc.status === "COMPLETED") {
        skippedJcs++;
        continue;
      }
      deletedJCs++;
      deletedPieces.push(`JC:${jc.departmentCode ?? "?"}`);
      if (!dryRun) {
        deleteStmts.push(
          db.prepare(`DELETE FROM job_cards WHERE id = ?`).bind(jc.id),
        );
      }
    }

    for (const fg of divanFgus) {
      // Production-lock: anything past PENDING (UPHOLSTERED, PACKED,
      // LOADED, DELIVERED, RETURNED) has a downstream contract.
      if (fg.status !== "PENDING") {
        skippedFgUnits++;
        continue;
      }
      deletedFgUnits++;
      deletedPieces.push(`FG:${fg.pieceName ?? "?"}`);
      if (!dryRun) {
        deleteStmts.push(
          db.prepare(`DELETE FROM fg_units WHERE id = ?`).bind(fg.id),
        );
      }
    }

    if (sample.length < 5 && deletedPieces.length > 0) {
      sample.push({
        soId: po.salesOrderId,
        coId: po.consignmentOrderId,
        poNo: po.poNo,
        productCode: po.productCode,
        deletedPieces,
      });
    }
  }

  if (!dryRun && deleteStmts.length > 0) {
    const chunkSize = 80;
    for (let i = 0; i < deleteStmts.length; i += chunkSize) {
      await db.batch(deleteStmts.slice(i, i + chunkSize));
    }
  }

  return c.json({
    success: true,
    dryRun,
    scanned,
    eligibleSOs,
    deletedJCs,
    deletedFgUnits,
    skippedDueToLocks: { jcs: skippedJcs, fgUnits: skippedFgUnits },
    sample,
  });
});

export default app;
