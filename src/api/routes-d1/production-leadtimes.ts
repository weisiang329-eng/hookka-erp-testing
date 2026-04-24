// ---------------------------------------------------------------------------
// D1-backed Production Lead Times.
//
// GET / — returns the full (category → deptCode → days) map.
// PUT / — accepts { BEDFRAME: {...}, SOFA: {...} } and upserts each entry.
//
// Response shape matches the original mock route so the Planning page
// (src/pages/planning/index.tsx) doesn't need changes:
//   { success: true, data: { BEDFRAME: { FAB_CUT: 7, ... }, SOFA: {...} } }
//
// Seeding: on the first GET/PUT after deploy the table may be empty —
// `ensureLeadTimesSeeded` inserts safe defaults (see ../lib/lead-times.ts).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import {
  ensureLeadTimesSeeded,
  loadLeadTimes,
  ensureHookkaDDBufferSeeded,
  loadHookkaDDBuffer,
  leadDaysFor,
  hookkaDDBufferFor,
  addDays,
  type LeadTimeMap,
  type HookkaDDBuffer,
} from "../lib/lead-times";

const app = new Hono<Env>();

const CATEGORIES = ["BEDFRAME", "SOFA"] as const;
type Category = (typeof CATEGORIES)[number];

type LeadTimesResponse = LeadTimeMap & {
  hookkaDDBuffer: HookkaDDBuffer;
};

const RECALC_BATCH_SIZE = 50;

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

function packingAnchorFor(po: PORow, buffer: HookkaDDBuffer): string | null {
  const category = po.itemCategory || "BEDFRAME";
  if (po.hookkaExpectedDD) return po.hookkaExpectedDD;
  if (po.customerDeliveryDate) {
    return addDays(po.customerDeliveryDate, -hookkaDDBufferFor(buffer, category));
  }
  if (po.targetEndDate) return po.targetEndDate;
  return null;
}

function computeNewDueDates(
  jcs: JCRow[],
  category: string,
  packingAnchor: string,
  leadTimes: LeadTimeMap,
): Map<string, string> {
  const out = new Map<string, string>();
  const byWip = new Map<string, JCRow[]>();
  for (const jc of jcs) {
    const key = jc.wipKey || "__default__";
    const bucket = byWip.get(key);
    if (bucket) bucket.push(jc);
    else byWip.set(key, [jc]);
  }
  for (const chain of byWip.values()) {
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

async function buildResponsePayload(db: D1Database): Promise<LeadTimesResponse> {
  const [lead, buffer] = await Promise.all([
    loadLeadTimes(db),
    loadHookkaDDBuffer(db),
  ]);
  return { ...lead, hookkaDDBuffer: buffer };
}

// GET /
app.get("/", async (c) => {
  await ensureLeadTimesSeeded(c.env.DB);
  await ensureHookkaDDBufferSeeded(c.env.DB);
  const data = await buildResponsePayload(c.env.DB);
  return c.json({ success: true, data });
});

// PUT /
// Accepts { BEDFRAME: { DEPT: n, ... }, SOFA: {...}, hookkaDDBuffer: { BEDFRAME: n, SOFA: n } }
// All three top-level keys are optional — any missing key is left unchanged.
app.put("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ success: false, error: "Body must be an object" }, 400);
  }

  await ensureLeadTimesSeeded(c.env.DB);
  await ensureHookkaDDBufferSeeded(c.env.DB);

  const statements: D1PreparedStatement[] = [];
  for (const cat of CATEGORIES) {
    const incoming = (body as Record<string, unknown>)[cat];
    if (!incoming || typeof incoming !== "object") continue;
    for (const [deptCode, raw] of Object.entries(
      incoming as Record<string, unknown>,
    )) {
      const n = Number(raw);
      // Preserve original validation: reject non-finite and negative; coerce to int.
      if (!Number.isFinite(n) || n < 0) continue;
      const days = Math.round(n);
      statements.push(
        c.env.DB.prepare(
          "INSERT OR REPLACE INTO production_lead_times (category, deptCode, days) VALUES (?, ?, ?)",
        ).bind(cat as Category, deptCode, days),
      );
    }
  }

  // Hookka Expected DD buffer — accepts { BEDFRAME: n, SOFA: n }.
  const bufferBody = (body as Record<string, unknown>).hookkaDDBuffer;
  if (bufferBody && typeof bufferBody === "object") {
    for (const cat of CATEGORIES) {
      const raw = (bufferBody as Record<string, unknown>)[cat];
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) continue;
      const days = Math.round(n);
      statements.push(
        c.env.DB.prepare(
          "INSERT OR REPLACE INTO hookka_dd_buffer (category, days) VALUES (?, ?)",
        ).bind(cat as Category, days),
      );
    }
  }

  if (statements.length > 0) {
    await c.env.DB.batch(statements);
  }

  const data = await buildResponsePayload(c.env.DB);
  return c.json({ success: true, data });
});

// POST /recalc-all — bulk reschedule every PO's job_card dueDates using the
// current lead-time config. Mirrors the reverse-schedule in sales-orders.ts.
// Orphans (no SO, no DD, no targetEndDate) are counted in `skipped`.
app.post("/recalc-all", async (c) => {
  try {
    await ensureLeadTimesSeeded(c.env.DB);
    await ensureHookkaDDBufferSeeded(c.env.DB);
    const [leadTimes, hookkaBuffer] = await Promise.all([
      loadLeadTimes(c.env.DB),
      loadHookkaDDBuffer(c.env.DB),
    ]);

    const poRes = await c.env.DB
      .prepare(
        `SELECT po.id AS id, po.itemCategory AS itemCategory,
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

    const jcRes = await c.env.DB
      .prepare(
        `SELECT id, productionOrderId, departmentCode, sequence, wipKey FROM job_cards`,
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
      if (!anchor) { skipped++; continue; }
      const jcs = jcsByPo.get(po.id) ?? [];
      if (jcs.length === 0) continue;
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
    for (let i = 0; i < updateStatements.length; i += RECALC_BATCH_SIZE) {
      const chunk = updateStatements.slice(i, i + RECALC_BATCH_SIZE);
      if (chunk.length > 0) await c.env.DB.batch(chunk);
    }
    return c.json({ success: true, updatedPOs, updatedJCs, skipped });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: msg }, 500);
  }
});

export default app;
