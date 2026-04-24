// ---------------------------------------------------------------------------
// Bulk reschedule of existing job_card dueDates after Planning edits lead
// times / the Hookka DD buffer.
//
// POST /api/production/leadtimes/recalc-all
//
// For every production_order that has a parent SO with a customerDeliveryDate
// (or an explicit hookkaExpectedDD), we recompute the packing anchor and walk
// each WIP's dept chain backwards to reassign dueDate on each job_card. This
// mirrors the reverse-schedule in routes-d1/sales-orders.ts (see the
// `dueByDept` walk around ~777-802) — only the UPDATE path matters here, the
// insert path is owned by the SO confirm cascade.
//
// The dept chain for each WIP is read straight off the existing job_cards
// (ordered by `sequence`), so we don't need to rebuild the BOM/WIP breakdown
// — whatever dept chain was locked in at SO-confirm time is the chain we
// reschedule against. This keeps the code short and means mid-flight BOM
// edits don't silently re-route old POs.
//
// Orphans (POs with no SO, or SOs with no customerDeliveryDate AND no
// hookkaExpectedDD) are skipped and counted in `skipped`.
//
// Batches D1 UPDATEs in groups of 50 to stay well under the binding limit.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import {
  ensureLeadTimesSeeded,
  ensureHookkaDDBufferSeeded,
  loadLeadTimes,
  loadHookkaDDBuffer,
  leadDaysFor,
  hookkaDDBufferFor,
  addDays,
  type LeadTimeMap,
  type HookkaDDBuffer,
} from "../lib/lead-times";

const app = new Hono<Env>();

const UPDATE_BATCH_SIZE = 50;

type PORow = {
  id: string;
  itemCategory: string | null;
  targetEndDate: string | null;
  customerDeliveryDate: string | null;
  hookkaExpectedDD: string | null;
};

type JCRow = {
  id: string;
  productionOrderId: string;
  departmentCode: string | null;
  sequence: number;
  wipKey: string | null;
};

// Given the job_cards belonging to a single PO + a packing anchor, compute
// the new dueDate per job_card by walking each wipKey's chain backwards from
// the anchor. Returns a Map<jcId, newDueDate>.
function computeNewDueDates(
  jcs: JCRow[],
  category: string,
  packingAnchor: string,
  leadTimes: LeadTimeMap,
): Map<string, string> {
  const out = new Map<string, string>();

  // Group job_cards by wipKey (same grouping as sales-orders.ts uses when
  // building jcIds). Fall back to "__default__" for legacy rows with no
  // wipKey so they still get rescheduled as a single chain.
  const byWip = new Map<string, JCRow[]>();
  for (const jc of jcs) {
    const key = jc.wipKey || "__default__";
    const bucket = byWip.get(key);
    if (bucket) bucket.push(jc);
    else byWip.set(key, [jc]);
  }

  for (const chain of byWip.values()) {
    // Walk the chain in sequence order so `chain[i+1]` is always the
    // "next" dept, exactly like sales-orders.ts.
    chain.sort((a, b) => a.sequence - b.sequence);
    const lastIdx = chain.length - 1;
    if (lastIdx < 0) continue;

    const dueByIdx = new Map<number, string>();
    dueByIdx.set(lastIdx, packingAnchor);
    for (let i = lastIdx - 1; i >= 0; i--) {
      const nextDept = chain[i + 1].departmentCode || "PACKING";
      const prevDue = dueByIdx.get(i + 1)!;
      const nextLeadDays = leadDaysFor(leadTimes, category, nextDept);
      dueByIdx.set(i, addDays(prevDue, -nextLeadDays));
    }
    for (let i = 0; i < chain.length; i++) {
      out.set(chain[i].id, dueByIdx.get(i) || packingAnchor);
    }
  }

  return out;
}

// Decide the packing anchor for a PO. Priority:
//   1. SO.hookkaExpectedDD (explicit)
//   2. SO.customerDeliveryDate − buffer[category]
//   3. PO.targetEndDate (already an internal target from a prior cascade)
// Returns null when we have nothing to anchor against — caller should skip.
function packingAnchorFor(
  po: PORow,
  buffer: HookkaDDBuffer,
): string | null {
  const category = po.itemCategory || "BEDFRAME";
  if (po.hookkaExpectedDD) return po.hookkaExpectedDD;
  if (po.customerDeliveryDate) {
    return addDays(po.customerDeliveryDate, -hookkaDDBufferFor(buffer, category));
  }
  if (po.targetEndDate) return po.targetEndDate;
  return null;
}

// POST / — kick off the full recalc.
app.post("/recalc-all", async (c) => {
  try {
    await ensureLeadTimesSeeded(c.env.DB);
    await ensureHookkaDDBufferSeeded(c.env.DB);
    const [leadTimes, hookkaBuffer] = await Promise.all([
      loadLeadTimes(c.env.DB),
      loadHookkaDDBuffer(c.env.DB),
    ]);

    // Pull every PO joined to its parent SO's dates. LEFT JOIN so orphan
    // stock POs (salesOrderId NULL) come through and we can count them
    // as skipped.
    const poRes = await c.env.DB
      .prepare(
        `SELECT po.id AS id,
                po.itemCategory AS itemCategory,
                po.targetEndDate AS targetEndDate,
                so.customerDeliveryDate AS customerDeliveryDate,
                so.hookkaExpectedDD AS hookkaExpectedDD
           FROM production_orders po
           LEFT JOIN sales_orders so ON so.id = po.salesOrderId`,
      )
      .all<PORow>();
    const pos = poRes.results ?? [];

    if (pos.length === 0) {
      return c.json({ success: true, updatedPOs: 0, updatedJCs: 0, skipped: 0 });
    }

    // Pull every job_card in one shot, then bucket by PO.
    const jcRes = await c.env.DB
      .prepare(
        `SELECT id, productionOrderId, departmentCode, sequence, wipKey
           FROM job_cards`,
      )
      .all<JCRow>();
    const jcsByPo = new Map<string, JCRow[]>();
    for (const jc of jcRes.results ?? []) {
      const bucket = jcsByPo.get(jc.productionOrderId);
      if (bucket) bucket.push(jc);
      else jcsByPo.set(jc.productionOrderId, [jc]);
    }

    const updateStatements: D1PreparedStatement[] = [];
    let updatedPOs = 0;
    let updatedJCs = 0;
    let skipped = 0;

    for (const po of pos) {
      const anchor = packingAnchorFor(po, hookkaBuffer);
      if (!anchor) {
        skipped++;
        continue;
      }
      const jcs = jcsByPo.get(po.id) ?? [];
      if (jcs.length === 0) {
        // PO exists but has no job_cards (e.g. not yet cascaded). Nothing
        // to reschedule; don't count as skipped since there's no failure.
        continue;
      }
      const category = po.itemCategory || "BEDFRAME";
      const newDueByJc = computeNewDueDates(jcs, category, anchor, leadTimes);
      if (newDueByJc.size === 0) continue;
      updatedPOs++;
      for (const [jcId, newDue] of newDueByJc) {
        updateStatements.push(
          c.env.DB
            .prepare("UPDATE job_cards SET dueDate = ? WHERE id = ?")
            .bind(newDue, jcId),
        );
        updatedJCs++;
      }
    }

    // Drain the update statements in chunks to stay within D1's per-batch
    // binding limit.
    for (let i = 0; i < updateStatements.length; i += UPDATE_BATCH_SIZE) {
      const chunk = updateStatements.slice(i, i + UPDATE_BATCH_SIZE);
      if (chunk.length > 0) await c.env.DB.batch(chunk);
    }

    return c.json({ success: true, updatedPOs, updatedJCs, skipped });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: msg }, 500);
  }
});

export default app;
