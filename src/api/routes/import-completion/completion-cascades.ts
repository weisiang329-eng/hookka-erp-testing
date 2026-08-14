import { Hono } from "hono";
import type { Env } from "../../worker";
import { requirePermission } from "../../lib/rbac";
import { invalidateProductionListCaches } from "../../lib/po-list-cache";
import { applyWipInventoryChange, type JobCardRow, type ProductionOrderRow } from "../production-orders";
import { postJobCardLabor } from "../../lib/po-cost-cascade";
import { loadLeadTimes, type LeadTimeMap } from "../../lib/lead-times";
import { getOrgId } from "../../lib/tenant";
import { ensureJobCardCompletedAt } from "../../lib/job-card-completed-at";
import { type RequestBody, type PicWarning, type ErrorEntry, type WorkerCache, findJobCardsByPO, loadProductionOrderById, processRow, CASCADE_DATE_CLAMP, cascadeAllowed, type CandidateRow, type AnchorRow, type CandidatePlan, addDaysISO, type LeakAnchorRow, type LeakCandidatePlan } from "./_shared";

const app = new Hono<Env>();


// ---------------------------------------------------------------------------
// POST /api/import/job-card-completion
// ---------------------------------------------------------------------------
app.post("/job-card-completion", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: RequestBody;
  try {
    body = (await c.req.json()) as RequestBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  if (!body || !Array.isArray(body.rows)) {
    return c.json(
      { success: false, error: "body.rows must be an array" },
      400,
    );
  }

  const dryRun = body.dryRun === true;

  // Cursor + limit: rows are processed sequentially from the supplied
  // body.rows array. ?cursor=<n> skips the first N rows; default 0.
  // ?limit=<m> caps the chunk; default 100, hard cap 500. Caller loops
  // until cursor.hasMore === false.
  const cursorParam = c.req.query("cursor");
  const limitParam = c.req.query("limit");
  const startIdx = cursorParam ? Math.max(0, parseInt(cursorParam, 10) || 0) : 0;
  const rawLimit = limitParam ? parseInt(limitParam, 10) || 100 : 100;
  const limit = Math.min(500, Math.max(1, rawLimit));
  const endIdx = Math.min(body.rows.length, startIdx + limit);
  const slice = body.rows.slice(startIdx, endIdx);

  const db = c.var.DB;
  const workerCache: WorkerCache = new Map();

  let matched = 0;
  let noSoMatch = 0;
  let noJcMatch = 0;
  let jcUpdated = 0;
  let posCompleted = 0;
  const picWarnings: PicWarning[] = [];
  const errors: ErrorEntry[] = [];

  for (let i = 0; i < slice.length; i++) {
    const absoluteIdx = startIdx + i;
    const r = slice[i];
    try {
      const res = await processRow(db, absoluteIdx, r, workerCache, dryRun, getOrgId(c));
      if (res.matched) matched++;
      if (res.noSoMatch) noSoMatch++;
      if (res.noJcMatch) noJcMatch++;
      jcUpdated += res.jcUpdated;
      posCompleted += res.posCompleted;
      picWarnings.push(...res.warnings);
      errors.push(...res.errors);
    } catch (err) {
      errors.push({
        row: absoluteIdx,
        custPONo: r?.custPONo ?? "",
        message: `unhandled error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  // A completion import moves job_cards AND flips production_orders to
  // COMPLETED in bulk — the dept sheets would keep listing finished work.
  // Skipped on a dry run, which writes nothing. See
  // tests/production-write-invalidation-class.test.mjs.
  if (!dryRun) {
    try {
      await invalidateProductionListCaches(c, getOrgId(c));
    } catch (err) {
      console.warn(
        "[import-completion] cache invalidation failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const hasMore = endIdx < body.rows.length;
  const nextCursor = hasMore ? String(endIdx) : null;

  return c.json({
    success: true,
    dryRun,
    totalRows: body.rows.length,
    matched,
    noSoMatch,
    noJcMatch,
    jcUpdated,
    picWarnings,
    posCompleted,
    errors,
    cursor: { hasMore, nextCursor },
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/clear-future-completions
//
// One-shot cleanup: any job_card whose completedDate is strictly > today gets
// reset (status → WAITING, completedDate → null, actualMinutes → null,
// pic1/pic2 → null, overdue → null). The historical migration ingested some
// source rows whose completion date column had been used as a "scheduled"
// future date by mistake; this endpoint reverses those imports without
// touching legitimately recent completions.
//
// Returns the count of rows reset and a sample.
// Permission: production-orders:update.
// ---------------------------------------------------------------------------
app.post("/clear-future-completions", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  // Migrations are inert on deploy (CLAUDE.md) — awaited before the UPDATE
  // below clears the column.
  await ensureJobCardCompletedAt(db);
  const dryRun = c.req.query("dryRun") === "true";
  const today = new Date().toISOString().slice(0, 10);

  // Find all jcs with completedDate strictly > today.
  const sel = await db
    .prepare(
      `SELECT id, departmentCode, completedDate, dueDate, status, pic1Name
         FROM job_cards
        WHERE completedDate IS NOT NULL AND completedDate > ?`,
    )
    .bind(today)
    .all<{
      id: string;
      departmentCode: string | null;
      completedDate: string | null;
      dueDate: string | null;
      status: string;
      pic1Name: string | null;
    }>();
  const rows = sel.results ?? [];

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      today,
      wouldReset: rows.length,
      sample: rows.slice(0, 8),
    });
  }

  let reset = 0;
  const errors: Array<{ jcId: string; message: string }> = [];
  for (const jc of rows) {
    try {
      await db
        .prepare(
          // completedAt travels with completedDate in every statement that
          // writes the date. This endpoint UN-completes the card, so the
          // instant it was observed at describes nothing any more.
          `UPDATE job_cards
              SET status = 'WAITING', completedDate = NULL,
                  completedAt = NULL,
                  actualMinutes = NULL,
                  pic1Id = NULL, pic1Name = '',
                  pic2Id = NULL, pic2Name = '',
                  overdue = NULL
            WHERE id = ?`,
        )
        .bind(jc.id)
        .run();
      reset++;
    } catch (err) {
      errors.push({
        jcId: jc.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    today,
    reset,
    errors,
  });
});

app.post("/cascade-upstream-completion", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  // Migrations are inert on deploy (CLAUDE.md) — awaited before the UPDATE
  // below mentions completed_at.
  await ensureJobCardCompletedAt(db);
  const dryRun = c.req.query("dryRun") === "true";

  // Load production_lead_times into the (cat, dept) → days map BEFORE we
  // start computing offsets. Falls back to in-file defaults for any
  // missing pair. ACCESSORY POs reuse BEDFRAME values via leadDaysFor.
  const leadTimes: LeadTimeMap = await loadLeadTimes(db);
  const ltLookup = (cat: string | null, dept: string | null): number | null => {
    if (!dept) return null;
    const normCat = (cat || "").toUpperCase() === "SOFA" ? "SOFA" : "BEDFRAME";
    const v = leadTimes[normCat]?.[dept];
    return typeof v === "number" && v >= 0 ? v : null;
  };

  // Two-pass approach (NOT a single CTE join). The single-CTE version
  // tripped a D1 column-aliasing quirk: SELECT j.completedDate AND
  // a.anchor_date from the same underlying column returned anchor_date
  // as undefined for every row. So instead:
  //   1. Build the anchor map (productionOrderId, wipKey) → {seq, date, dept}
  //      from a query that selects ONLY anchor-side columns (no name
  //      collision with job_cards' own completedDate).
  //   2. Fetch all candidate JCs (every non-done row) and join in JS.
  // Alias note: anchorWt has NO underscore on purpose — empirically the
  // underscore-aliased `anchor_wipType` came back as undefined regardless of
  // camel/snake casing checks (likely a D1 quirk specific to mixed-case
  // identifiers after an underscore). A no-underscore alias passes through
  // cleanly.
  const anchorRes = await db
    .prepare(
      `SELECT j.productionOrderId AS productionOrderId,
              COALESCE(j.wipKey,'') AS wk,
              COALESCE(j.branchKey,'') AS bk,
              j.sequence AS anchor_seq,
              j.completedDate AS anchor_date,
              j.departmentCode AS anchor_dept,
              j.wipType AS "anchorWt"
         FROM job_cards j
         JOIN (
           SELECT productionOrderId,
                  COALESCE(wipKey,'') AS wk2,
                  COALESCE(branchKey,'') AS bk2,
                  MAX(sequence) AS max_seq
             FROM job_cards
            WHERE status IN ('COMPLETED','TRANSFERRED') AND completedDate IS NOT NULL
            GROUP BY productionOrderId, COALESCE(wipKey,''), COALESCE(branchKey,'')
         ) m
           ON m.productionOrderId = j.productionOrderId
          AND m.wk2 = COALESCE(j.wipKey,'')
          AND m.bk2 = COALESCE(j.branchKey,'')
          AND m.max_seq = j.sequence
        WHERE j.status IN ('COMPLETED','TRANSFERRED') AND j.completedDate IS NOT NULL`,
    )
    .all<AnchorRow>();

  // Build a map: "<poId>||<wk>||<bk>" → {anchor_seq, anchor_date, anchor_dept}
  // Per-branchKey scoping so each BOM sub-branch (e.g. fabric vs wood under
  // SOFA_BASE) gets its own anchor and cascades independently.
  // D1 quirk: snake_case aliases get camelCased on the way out, so
  // `anchor_date` becomes `anchorDate` in the result row. Try both forms.
  const anchorMap = new Map<
    string,
    {
      anchor_seq: number;
      anchor_date: string;
      anchor_dept: string | null;
      anchor_wipType: string | null;
    }
  >();
  for (const a of anchorRes.results ?? []) {
    const raw = a as unknown as Record<string, unknown>;
    const seq =
      typeof raw.anchorSeq === "number"
        ? (raw.anchorSeq as number)
        : typeof raw.anchor_seq === "number"
          ? (raw.anchor_seq as number)
          : null;
    const date =
      typeof raw.anchorDate === "string"
        ? (raw.anchorDate as string)
        : typeof raw.anchor_date === "string"
          ? (raw.anchor_date as string)
          : null;
    const dept =
      typeof raw.anchorDept === "string"
        ? (raw.anchorDept as string)
        : typeof raw.anchor_dept === "string"
          ? (raw.anchor_dept as string)
          : null;
    // anchorWt: no-underscore alias used to dodge the same D1 quirk that hit
    // anchor_date. Keep both forms as a belt-and-braces fallback.
    const wt =
      typeof raw.anchorWt === "string"
        ? (raw.anchorWt as string)
        : typeof raw.anchorwt === "string"
          ? (raw.anchorwt as string)
          : null;
    if (seq == null || !date) continue;
    const poId =
      typeof raw.productionOrderId === "string"
        ? (raw.productionOrderId as string)
        : "";
    const wk = typeof raw.wk === "string" ? (raw.wk as string) : "";
    const bk = typeof raw.bk === "string" ? (raw.bk as string) : "";
    const key = `${poId}||${wk}||${bk}`;
    anchorMap.set(key, {
      anchor_seq: seq,
      anchor_date: date,
      anchor_dept: dept,
      anchor_wipType: wt,
    });
  }

  // Fetch every non-done JC that lives in a group with an anchor.
  // We pull the full set of non-done rows; any row whose group has no
  // anchor (i.e. nothing completed in that wipKey at all) is filtered
  // out in JS — those are legitimately untouched orders.
  // JOIN to production_orders to surface itemCategory for the leadtime
  // category lookup.
  const candRes = await db
    .prepare(
      `SELECT j.id AS id, j.productionOrderId AS productionOrderId,
              j.wipKey AS wipKey, j.branchKey AS branchKey,
              j.departmentCode AS departmentCode,
              j.wipType AS wipType, j.sequence AS sequence,
              j.estMinutes AS estMinutes,
              j.productionTimeMinutes AS productionTimeMinutes,
              j.status AS status, j.completedDate AS completedDate,
              po.itemCategory AS itemCategory
         FROM job_cards j
         LEFT JOIN production_orders po ON po.id = j.productionOrderId
        WHERE (j.status NOT IN ('COMPLETED','TRANSFERRED') OR j.completedDate IS NULL)`,
    )
    .all<CandidateRow>();

  const allNonDone = candRes.results ?? [];

  // Compute per-row newDate + actualMinutes, build histogram alongside.
  // Defensive: skip rows whose anchor lookup returns nothing OR whose
  // anchor_date doesn't match ISO YYYY-MM-DD.
  const plans: CandidatePlan[] = [];
  const dateHistogram: Record<string, number> = {};
  const skipped: Array<{ jcId: string; reason: string }> = [];
  let groupHadAnchor = 0;
  let fallbackToSequence = 0;
  let parallelChainSkipped = 0;
  let clampedToAnchor = 0;
  for (const cand of allNonDone) {
    const key = `${cand.productionOrderId}||${cand.wipKey ?? ""}||${cand.branchKey ?? ""}`;
    const anchor = anchorMap.get(key);
    if (!anchor) continue; // branch has no completed sibling — leave alone
    groupHadAnchor++;
    if (cand.sequence === anchor.anchor_seq) continue; // shouldn't happen (anchor row is by definition done) but guard

    // Restricted cascade: only 4 anchor depts trigger fills, and each
    // anchor only cascades to a fixed allow-list of target depts. Any
    // other anchor dept (FOAM, WOOD_CUT, FAB_CUT, PACKING, ...)
    // → group skipped, nothing planned.
    const anchorDept = (anchor.anchor_dept || "").toUpperCase();
    const targetDept = (cand.departmentCode || "").toUpperCase();
    const allowedTargets = cascadeAllowed(anchor.anchor_wipType, anchorDept);
    if (!allowedTargets.length || !allowedTargets.includes(targetDept)) {
      parallelChainSkipped++;
      continue;
    }

    const anchorDate = anchor.anchor_date;
    if (
      typeof anchorDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)
    ) {
      skipped.push({
        jcId: cand.id,
        reason: `anchor_date not ISO YYYY-MM-DD: ${JSON.stringify(anchorDate)}`,
      });
      continue;
    }

    // Leadtime-driven offset. ltAnchor < ltTarget → upstream target →
    // negative offset → earlier date. ltAnchor > ltTarget → downstream
    // target → positive offset → later date.
    const ltAnchor = ltLookup(cand.itemCategory, anchor.anchor_dept);
    const ltTarget = ltLookup(cand.itemCategory, cand.departmentCode);
    let rawOffset: number;
    let fallback = false;
    if (ltAnchor == null || ltTarget == null) {
      // Missing leadtime data — fall back to 1-day-per-sequence-step so
      // we never silently skip a candidate.
      rawOffset = cand.sequence - anchor.anchor_seq;
      fallback = true;
      fallbackToSequence++;
    } else {
      rawOffset = ltAnchor - ltTarget;
    }

    // Clamp: backfilled completion can never exceed the anchor's date.
    // Upstream depts have larger leadtimes so their offset is naturally <= 0
    // and this clamp is a no-op. The case that triggers is downstream
    // backfill from an UPHOLSTERY anchor — e.g. PACKING in SOFA where
    // lt_UPH=4 and lt_PACKING=3 gives +1 (one day past UPH), which the user
    // says must not happen. Squashed to 0 = same date as anchor.
    let offset = rawOffset;
    let clamped = false;
    if (offset > 0) {
      offset = 0;
      clamped = true;
      clampedToAnchor++;
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
      cand: {
        ...cand,
        anchor_seq: anchor.anchor_seq,
        anchor_date: anchorDate,
        anchor_dept: anchor.anchor_dept,
        anchor_wipType: anchor.anchor_wipType,
      },
      newDate,
      actualMinutes,
      offsetDays: offset,
      rawOffsetDays: rawOffset,
      fallback,
      clampedToAnchor: clamped,
    });
    dateHistogram[newDate] = (dateHistogram[newDate] ?? 0) + 1;
  }
  const candidatesCount = groupHadAnchor;

  // Offset summary: min/max/median across plans for a quick sanity check
  // on the spread of the new dates.
  let byOffsetSummary: { min: number; max: number; median: number } | null =
    null;
  if (plans.length > 0) {
    const offsets = plans.map((p) => p.offsetDays).sort((a, b) => a - b);
    const mid = Math.floor(offsets.length / 2);
    const median =
      offsets.length % 2 === 0
        ? Math.round((offsets[mid - 1] + offsets[mid]) / 2)
        : offsets[mid];
    byOffsetSummary = {
      min: offsets[0],
      max: offsets[offsets.length - 1],
      median,
    };
  }

  // Stable, easy-to-read 5-row sample with the load-bearing fields.
  const sample = plans.slice(0, 5).map((p) => ({
    id: p.cand.id,
    productionOrderId: p.cand.productionOrderId,
    wipKey: p.cand.wipKey,
    branchKey: p.cand.branchKey,
    departmentCode: p.cand.departmentCode,
    wipType: p.cand.wipType,
    itemCategory: p.cand.itemCategory,
    sequence: p.cand.sequence,
    anchor_seq: p.cand.anchor_seq,
    anchor_date: p.cand.anchor_date,
    anchor_dept: p.cand.anchor_dept,
    anchor_wipType: p.cand.anchor_wipType,
    offsetDays: p.offsetDays,
    rawOffsetDays: p.rawOffsetDays,
    clampedToAnchor: p.clampedToAnchor,
    fallback: p.fallback,
    newDate: p.newDate,
  }));

  // Targeted sample: rows where rawOffsetDays was positive and got clamped
  // back to 0 (typically PACKING target on a SOFA UPHOLSTERY anchor).
  const clampedToAnchorSample = plans
    .filter((p) => p.clampedToAnchor)
    .slice(0, 3)
    .map((p) => ({
      id: p.cand.id,
      productionOrderId: p.cand.productionOrderId,
      wipKey: p.cand.wipKey,
      anchor_dept: p.cand.anchor_dept,
      anchor_wipType: p.cand.anchor_wipType,
      anchor_date: p.cand.anchor_date,
      departmentCode: p.cand.departmentCode,
      wipType: p.cand.wipType,
      itemCategory: p.cand.itemCategory,
      rawOffsetDays: p.rawOffsetDays,
      offsetDays: p.offsetDays,
      newDate: p.newDate,
    }));

  // Stratified sample: one row per (anchor_dept, target_dept) combination
  // to verify the DAG filter is keeping each anchor on its own sub-chain.
  // Caller wants to see e.g. WOOD-anchor → wood-chain only, FAB-anchor →
  // fabric-chain only, UPHOLSTERY-anchor → all upstream depts.
  const stratifiedMap = new Map<string, CandidatePlan>();
  for (const p of plans) {
    const k = `${p.cand.anchor_dept}__${p.cand.departmentCode}`;
    if (!stratifiedMap.has(k)) stratifiedMap.set(k, p);
  }
  const stratifiedSample = Array.from(stratifiedMap.values()).map((p) => ({
    productionOrderId: p.cand.productionOrderId,
    wipKey: p.cand.wipKey,
    anchor_dept: p.cand.anchor_dept,
    departmentCode: p.cand.departmentCode,
    offsetDays: p.offsetDays,
    newDate: p.newDate,
  }));

  // Anchor-dept breakdown: { [anchor_dept]: { [target_dept]: count } } so
  // the caller can confirm zero cross-chain leakage.
  const anchorBreakdown: Record<string, Record<string, number>> = {};
  for (const p of plans) {
    const aDept = p.cand.anchor_dept || "UNKNOWN";
    const tDept = p.cand.departmentCode || "UNKNOWN";
    if (!anchorBreakdown[aDept]) anchorBreakdown[aDept] = {};
    anchorBreakdown[aDept][tDept] = (anchorBreakdown[aDept][tDept] ?? 0) + 1;
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      count: candidatesCount,
      planned: plans.length,
      parallelChainSkipped,
      fallbackToSequence,
      clampedToAnchor,
      skipped,
      dateHistogram,
      byOffsetSummary,
      anchorBreakdown,
      stratifiedSample,
      clampedToAnchorSample,
      sample,
    });
  }

  let updated = 0;
  const errors: Array<{ jcId: string; message: string }> = [];

  // Per-PO cache so we only fetch (po, allJcs) once even when multiple
  // candidates in the same PO get cascaded in this run. allJcs is mutated
  // in place as each candidate's status flips so subsequent siblings see
  // the updated view (mirrors the refresh-then-apply pattern in
  // /job-card-completion).
  const poCache = new Map<
    string,
    { po: ProductionOrderRow; allJcs: JobCardRow[] }
  >();

  for (const plan of plans) {
    try {
      await db
        .prepare(
          // completedAt travels with completedDate in every statement that
          // writes the date. This is a BACKFILL: the date is derived from a
          // downstream anchor, not observed, so there is no instant to record
          // and NULL is the honest value. Inventing a time of day here is the
          // C15 class (a figure that reads as measured and is not).
          `UPDATE job_cards
              SET status = 'COMPLETED',
                  completedDate = ?,
                  completedAt = NULL,
                  actualMinutes = ?,
                  overdue = 'COMPLETED'
            WHERE id = ?`,
        )
        .bind(plan.newDate, plan.actualMinutes, plan.cand.id)
        .run();
      updated++;
    } catch (err) {
      errors.push({
        jcId: plan.cand.id,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // BUG-2026-04-30 fix: this endpoint used to be metadata-only, leaving
    // ~1300 phantom UPH consumes without compensating producer-adds because
    // upstream JCs were WAITING when downstream completed. Now mirror the
    // /job-card-completion flow: after the JC UPDATE commits, fire the
    // producer-add (applyWipInventoryChange) and labor ledger
    // (postJobCardLabor) for each WAITING → COMPLETED transition.
    // Skip UPHOLSTERY (its consume already fired earlier) and PACKING
    // (no WIP terminal). Best-effort with defensive try/catch — a cascade
    // failure must NOT roll back the JC UPDATE that already committed.
    const targetDept = (plan.cand.departmentCode || "").toUpperCase();
    if (targetDept === "UPHOLSTERY" || targetDept === "PACKING") continue;

    const poId = plan.cand.productionOrderId;
    let cached = poCache.get(poId);
    if (!cached) {
      try {
        const po = await loadProductionOrderById(db, poId);
        if (!po) {
          console.error(
            "[cascade-upstream-completion] PO not found for cascade",
            { jcId: plan.cand.id, poId },
          );
          continue;
        }
        const allJcs = await findJobCardsByPO(db, poId);
        cached = { po, allJcs };
        poCache.set(poId, cached);
      } catch (err) {
        console.error(
          "[cascade-upstream-completion] PO/JC load failed",
          {
            jcId: plan.cand.id,
            poId,
            err: err instanceof Error ? err.message : String(err),
          },
        );
        continue;
      }
    }

    // Build the post-UPDATE JC snapshot. Re-use the canonical row from
    // findJobCardsByPO so applyWipInventoryChange gets the full JobCardRow
    // shape (branchKey, dueDate, etc.) — CandidateRow drops several fields.
    const idx = cached.allJcs.findIndex((j) => j.id === plan.cand.id);
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
      console.error("[cascade-upstream-completion] WIP cascade failed", {
        jcId: plan.cand.id,
        poId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await postJobCardLabor(db, plan.cand.id, poId);
    } catch (err) {
      console.error(
        "[cascade-upstream-completion] postJobCardLabor failed",
        {
          jcId: plan.cand.id,
          poId,
          err: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    count: candidatesCount,
    planned: plans.length,
    parallelChainSkipped,
    fallbackToSequence,
    clampedToAnchor,
    skipped,
    updated,
    errors,
    dateHistogram,
    byOffsetSummary,
    sample,
  });
});

app.post("/cascade-leak-pass", async (c) => {
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

  // Anchor query: most-downstream COMPLETED JC per productionOrderId
  // (no wipKey grouping). Same MAX(sequence) trick as the strict cascade.
  const anchorRes = await db
    .prepare(
      `SELECT j.productionOrderId AS productionOrderId,
              j.sequence AS anchor_seq,
              j.completedDate AS anchor_date,
              j.departmentCode AS anchor_dept
         FROM job_cards j
         JOIN (
           SELECT productionOrderId,
                  MAX(sequence) AS max_seq
             FROM job_cards
            WHERE status IN ('COMPLETED','TRANSFERRED') AND completedDate IS NOT NULL
            GROUP BY productionOrderId
         ) m
           ON m.productionOrderId = j.productionOrderId
          AND m.max_seq = j.sequence
        WHERE j.status IN ('COMPLETED','TRANSFERRED') AND j.completedDate IS NOT NULL`,
    )
    .all<LeakAnchorRow>();

  const anchorByPo = new Map<
    string,
    { anchor_seq: number; anchor_date: string; anchor_dept: string }
  >();
  for (const a of anchorRes.results ?? []) {
    const raw = a as unknown as Record<string, unknown>;
    const seq =
      typeof raw.anchorSeq === "number"
        ? (raw.anchorSeq as number)
        : typeof raw.anchor_seq === "number"
          ? (raw.anchor_seq as number)
          : null;
    const date =
      typeof raw.anchorDate === "string"
        ? (raw.anchorDate as string)
        : typeof raw.anchor_date === "string"
          ? (raw.anchor_date as string)
          : null;
    const dept =
      typeof raw.anchorDept === "string"
        ? (raw.anchorDept as string)
        : typeof raw.anchor_dept === "string"
          ? (raw.anchor_dept as string)
          : null;
    const poId =
      typeof raw.productionOrderId === "string"
        ? (raw.productionOrderId as string)
        : "";
    if (!poId || seq == null || !date || !dept) continue;
    // If two JCs share max_seq (shouldn't happen, but defensive), keep first.
    if (anchorByPo.has(poId)) continue;
    anchorByPo.set(poId, {
      anchor_seq: seq,
      anchor_date: date,
      anchor_dept: dept.toUpperCase(),
    });
  }

  // Fetch every non-done JC.
  const candRes = await db
    .prepare(
      `SELECT j.id AS id, j.productionOrderId AS productionOrderId,
              j.wipKey AS wipKey, j.departmentCode AS departmentCode,
              j.wipType AS wipType, j.sequence AS sequence,
              j.estMinutes AS estMinutes,
              j.productionTimeMinutes AS productionTimeMinutes,
              j.status AS status, j.completedDate AS completedDate,
              po.itemCategory AS itemCategory
         FROM job_cards j
         LEFT JOIN production_orders po ON po.id = j.productionOrderId
        WHERE (j.status NOT IN ('COMPLETED','TRANSFERRED') OR j.completedDate IS NULL)`,
    )
    .all<CandidateRow>();

  const allNonDone = candRes.results ?? [];

  const plans: LeakCandidatePlan[] = [];
  const skipped: Array<{ jcId: string; reason: string }> = [];
  let groupHadAnchor = 0;
  let parallelChainSkipped = 0;
  let fallbackToSequence = 0;
  let clampedToAnchor = 0;
  for (const cand of allNonDone) {
    const anchor = anchorByPo.get(cand.productionOrderId);
    if (!anchor) continue; // PO has no completed JC — leave alone
    groupHadAnchor++;

    if (cand.sequence >= anchor.anchor_seq) {
      // Candidate is at or downstream of the anchor — skip; the cascade only
      // fills upstream gaps (the rule set is strictly upstream by design).
      // We allow equality just to be safe; the strict cascade also treated
      // anchor's own sequence as a guard.
      parallelChainSkipped++;
      continue;
    }

    const anchorDept = anchor.anchor_dept;
    const targetDept = (cand.departmentCode || "").toUpperCase();
    const allowedTargets = cascadeAllowed(cand.wipType, anchorDept);
    if (!allowedTargets.length || !allowedTargets.includes(targetDept)) {
      parallelChainSkipped++;
      continue;
    }

    const anchorDate = anchor.anchor_date;
    if (
      typeof anchorDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)
    ) {
      skipped.push({
        jcId: cand.id,
        reason: `anchor_date not ISO YYYY-MM-DD: ${JSON.stringify(anchorDate)}`,
      });
      continue;
    }

    const ltAnchor = ltLookup(cand.itemCategory, anchorDept);
    const ltTarget = ltLookup(cand.itemCategory, cand.departmentCode);
    let rawOffset: number;
    let fallback = false;
    if (ltAnchor == null || ltTarget == null) {
      rawOffset = cand.sequence - anchor.anchor_seq;
      fallback = true;
      fallbackToSequence++;
    } else {
      rawOffset = ltAnchor - ltTarget;
    }

    let offset = rawOffset;
    let clamped = false;
    if (offset > 0) {
      offset = 0;
      clamped = true;
      clampedToAnchor++;
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
      jcId: cand.id,
      productionOrderId: cand.productionOrderId,
      wipKey: cand.wipKey,
      departmentCode: cand.departmentCode,
      wipType: cand.wipType,
      itemCategory: cand.itemCategory,
      sequence: cand.sequence,
      status: cand.status,
      currentCompletedDate: cand.completedDate,
      anchor_seq: anchor.anchor_seq,
      anchor_date: anchorDate,
      anchor_dept: anchorDept,
      newDate,
      actualMinutes,
      offsetDays: offset,
      rawOffsetDays: rawOffset,
      fallback,
      clampedToAnchor: clamped,
    });
  }

  // Anchor x target breakdown.
  const anchorBreakdown: Record<string, Record<string, number>> = {};
  for (const p of plans) {
    const a = p.anchor_dept;
    const t = (p.departmentCode || "UNKNOWN").toUpperCase();
    if (!anchorBreakdown[a]) anchorBreakdown[a] = {};
    anchorBreakdown[a][t] = (anchorBreakdown[a][t] ?? 0) + 1;
  }

  // wipKey-mismatch surface: among the leak candidates, how many have a
  // wipKey different from the anchor's wipKey on the same PO? We don't have
  // anchor's wipKey in this query, but we can compare candidate's wipKey to
  // the most common wipKey of completed siblings on the same PO. Simpler:
  // just count distinct (PO, wipKey) pairs in the leak set so the user can
  // see how many wipKey buckets are involved.
  const distinctPoWipPairs = new Set<string>();
  for (const p of plans) {
    distinctPoWipPairs.add(`${p.productionOrderId}||${p.wipKey ?? ""}`);
  }

  const sample = plans.slice(0, 5).map((p) => ({
    jcId: p.jcId,
    productionOrderId: p.productionOrderId,
    wipKey: p.wipKey,
    departmentCode: p.departmentCode,
    wipType: p.wipType,
    itemCategory: p.itemCategory,
    sequence: p.sequence,
    status: p.status,
    currentCompletedDate: p.currentCompletedDate,
    anchor_seq: p.anchor_seq,
    anchor_date: p.anchor_date,
    anchor_dept: p.anchor_dept,
    offsetDays: p.offsetDays,
    rawOffsetDays: p.rawOffsetDays,
    fallback: p.fallback,
    clampedToAnchor: p.clampedToAnchor,
    newDate: p.newDate,
  }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      candidatesWithAnchor: groupHadAnchor,
      planned: plans.length,
      parallelChainSkipped,
      fallbackToSequence,
      clampedToAnchor,
      distinctLeakPoWipPairs: distinctPoWipPairs.size,
      skipped,
      anchorBreakdown,
      sample,
    });
  }

  let updated = 0;
  const errors: Array<{ jcId: string; message: string }> = [];
  for (const p of plans) {
    try {
      await db
        .prepare(
          // completedAt travels with completedDate in every statement that
          // writes the date. This is a BACKFILL: the date is derived from a
          // downstream anchor, not observed, so there is no instant to record
          // and NULL is the honest value. Inventing a time of day here is the
          // C15 class (a figure that reads as measured and is not).
          `UPDATE job_cards
              SET status = 'COMPLETED',
                  completedDate = ?,
                  completedAt = NULL,
                  actualMinutes = ?,
                  overdue = 'COMPLETED'
            WHERE id = ?`,
        )
        .bind(p.newDate, p.actualMinutes, p.jcId)
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
    candidatesWithAnchor: groupHadAnchor,
    planned: plans.length,
    parallelChainSkipped,
    fallbackToSequence,
    clampedToAnchor,
    updated,
    errors,
    anchorBreakdown,
    sample,
  });
});

export default app;
