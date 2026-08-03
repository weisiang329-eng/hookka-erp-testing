// ---------------------------------------------------------------------------
// Production Lead Times — single source of truth = the *_history tables
// (migrations 0105 + 0106). Inline /planning Save and the dialog Schedule
// flow both write here; `loadLeadTimes` resolves "latest effective_from
// <= today" per (cat, dept). The legacy production_lead_times +
// hookka_dd_buffer baseline tables are no longer read; their previous
// contents were backfilled into history with effective_from='2020-01-01'
// by 0106 so historical SO confirms still find a value.
//
// GET / — returns current effective values + pending summary
// PUT / — bulk upsert "as of today" (ON CONFLICT DO UPDATE on uniq idx)
// POST /schedule — schedule one row at a chosen effective_from
// GET /history — full merged history with Pending/Active/Past
// DEL /history/:id — remove one row
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import {
  loadLeadTimes,
  loadHookkaDDBuffer,
  leadDaysFor,
  addDays,
  loadLeadTimeSettings,
  saveLeadTimeSettings,
  type LeadTimeMap,
  type HookkaDDBuffer,
} from "../lib/lead-times";

const app = new Hono<Env>();

const CATEGORIES = ["BEDFRAME", "SOFA"] as const;
type Category = (typeof CATEGORIES)[number];

// Pending summary surfaced on GET / so the /planning header can show a
// badge ("3 pending · next 2026-06-01") next to the 📅 history button
// without a second round-trip. Mirrors the hasPendingPriceChange /
// pendingEffectiveFrom pair on the products listing.
type PendingSummary = {
  count: number;
  nearestEffectiveFrom: string | null;
};

type LeadTimesResponse = {
  BEDFRAME: Record<string, number>;
  SOFA: Record<string, number>;
  hookkaDDBuffer: HookkaDDBuffer;
  pending: PendingSummary;
  // Global ON/OFF toggle for lead-time auto-scheduling of due dates. Default
  // TRUE = current behaviour (SO confirm auto-computes job_card dueDates).
  // When false, SO confirm / re-cascade / recalc-all leave dueDates blank.
  autoScheduleEnabled: boolean;
};

// Row shapes for the history table responses. Mirrors product_prices
// (see resolveProductPriceAsOf in products.ts) — id is the row PK,
// effectiveFrom is ISO YYYY-MM-DD, status is computed at read-time.
type LeadTimeHistoryRow = {
  id: string;
  kind: "leadTime";
  category: string;
  deptCode: string;
  days: number;
  effectiveFrom: string;
  notes: string;
  createdAt: string;
  status: "Pending" | "Active" | "Past";
};

type HookkaBufferHistoryRow = {
  id: string;
  kind: "hookkaBuffer";
  category: string;
  days: number;
  effectiveFrom: string;
  notes: string;
  createdAt: string;
  status: "Pending" | "Active" | "Past";
};

function genLeadTimeRowId(): string {
  return `lt-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function genHookkaBufferRowId(): string {
  return `hd-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

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

// Schedule anchor — the delivery-facing date every dept staggers BACK from.
// Explicit hookkaExpectedDD overrides (user-set internal target); otherwise
// use the customer's requested delivery date directly. Hookka DD buffer is
// no longer applied here because per-dept lead times are already measured
// relative to delivery, not relative to an internal packing target.
function scheduleAnchorFor(po: PORow, _buffer: HookkaDDBuffer): string | null {
  if (po.hookkaExpectedDD) return po.hookkaExpectedDD;
  if (po.customerDeliveryDate) return po.customerDeliveryDate;
  if (po.targetEndDate) return po.targetEndDate;
  return null;
}

// Parallel-dept schedule: each JC's dueDate = anchor − leadDays[that JC's
// deptCode]. Matches the semantics in sales-orders.ts (confirm + re-confirm
// paths): depts run concurrently on the shop floor, each just needs to
// finish its own lead-time window before the delivery anchor.
function computeNewDueDates(
  jcs: JCRow[],
  category: string,
  anchor: string,
  leadTimes: LeadTimeMap,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const jc of jcs) {
    const dept = jc.departmentCode || "PACKING";
    const leadDays = leadDaysFor(leadTimes, category, dept);
    out.set(jc.id, addDays(anchor, -leadDays));
  }
  return out;
}

async function loadPendingSummary(
  db: D1Database,
  asOfDate: string,
): Promise<PendingSummary> {
  // Count + earliest effective_from across both history tables. Used by the
  // /planning header to decide whether to highlight the 📅 button orange.
  const [ltRow, bufRow] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(effective_from) AS "nearest"
           FROM production_lead_times_history
          WHERE effective_from > ?`,
      )
      .bind(asOfDate)
      .first<{ n: number; nearest: string | null }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(effective_from) AS "nearest"
           FROM hookka_dd_buffer_history
          WHERE effective_from > ?`,
      )
      .bind(asOfDate)
      .first<{ n: number; nearest: string | null }>(),
  ]);
  const ltCount = Number(ltRow?.n ?? 0);
  const bufCount = Number(bufRow?.n ?? 0);
  const candidates = [ltRow?.nearest, bufRow?.nearest].filter(
    (v): v is string => typeof v === "string" && !!v,
  );
  const nearest = candidates.length > 0 ? candidates.sort()[0] : null;
  return { count: ltCount + bufCount, nearestEffectiveFrom: nearest };
}

async function buildResponsePayload(db: D1Database): Promise<LeadTimesResponse> {
  const asOf = todayIso();
  const [lead, buffer, pending, settings] = await Promise.all([
    loadLeadTimes(db, asOf),
    loadHookkaDDBuffer(db, asOf),
    loadPendingSummary(db, asOf),
    loadLeadTimeSettings(db),
  ]);
  return {
    BEDFRAME: lead.BEDFRAME ?? {},
    SOFA: lead.SOFA ?? {},
    hookkaDDBuffer: buffer,
    pending,
    autoScheduleEnabled: settings.autoScheduleEnabled,
  };
}

// GET /
app.get("/", async (c) => {
  const data = await buildResponsePayload(c.var.DB);
  return c.json({ success: true, data });
});

// PUT /settings — flip the global lead-time auto-schedule toggle.
// Body: { autoScheduleEnabled: boolean }. Persisted to kv_config
// (key 'lead-time-settings'). Default (missing row) = TRUE so existing
// orgs keep current behaviour until they explicitly turn it OFF.
app.put("/settings", async (c) => {
  const denied = await requirePermission(c, "production-leadtimes", "update");
  if (denied) return denied;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ success: false, error: "Body must be an object" }, 400);
  }
  const raw = (body as Record<string, unknown>).autoScheduleEnabled;
  if (typeof raw !== "boolean") {
    return c.json(
      { success: false, error: "autoScheduleEnabled (boolean) is required" },
      400,
    );
  }
  await saveLeadTimeSettings(c.var.DB, { autoScheduleEnabled: raw });
  const data = await buildResponsePayload(c.var.DB);
  return c.json({ success: true, data });
});

// PUT /
// Accepts { BEDFRAME: { DEPT: n, ... }, SOFA: {...}, hookkaDDBuffer: { BEDFRAME: n, SOFA: n } }
// All three top-level keys are optional — any missing key is left unchanged.
//
// Writes go to the *_history tables with effective_from=today (single source
// of truth, matches the dialog's scheduling flow). Same-day re-saves of the
// same (cat, dept) overwrite via ON CONFLICT DO UPDATE on the unique
// constraint added in migration 0106 — no daily-noise rows in the history
// dialog.
app.put("/", async (c) => {
  const denied = await requirePermission(c, "production-leadtimes", "update");
  if (denied) return denied;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ success: false, error: "Body must be an object" }, 400);
  }

  // Honor an optional `effectiveFrom` so the planning Save flow can queue a
  // future-dated change without having to call /schedule per row. Falls back
  // to today (existing behavior) when the field is missing or malformed.
  const effectiveFromRaw = (body as Record<string, unknown>).effectiveFrom;
  const effectiveFromCandidate =
    typeof effectiveFromRaw === "string" ? effectiveFromRaw : "";
  const effectiveFrom = /^\d{4}-\d{2}-\d{2}$/.test(effectiveFromCandidate)
    ? effectiveFromCandidate
    : todayIso();
  const notesRaw = (body as Record<string, unknown>).notes;
  const notes =
    typeof notesRaw === "string" && notesRaw.trim() ? notesRaw.trim() : null;
  const statements: D1PreparedStatement[] = [];

  for (const cat of CATEGORIES) {
    const incoming = (body as Record<string, unknown>)[cat];
    if (!incoming || typeof incoming !== "object") continue;
    for (const [deptCode, raw] of Object.entries(
      incoming as Record<string, unknown>,
    )) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) continue;
      const days = Math.round(n);
      statements.push(
        c.var.DB.prepare(
          `INSERT INTO production_lead_times_history
             (id, category, dept_code, days, effective_from, notes)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (category, dept_code, effective_from)
           DO UPDATE SET days = EXCLUDED.days,
                         notes = EXCLUDED.notes,
                         created_at = (to_char(NOW() AT TIME ZONE 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS"Z"'))`,
        ).bind(genLeadTimeRowId(), cat as Category, deptCode, days, effectiveFrom, notes),
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
        c.var.DB.prepare(
          `INSERT INTO hookka_dd_buffer_history
             (id, category, days, effective_from, notes)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (category, effective_from)
           DO UPDATE SET days = EXCLUDED.days,
                         notes = EXCLUDED.notes,
                         created_at = (to_char(NOW() AT TIME ZONE 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS"Z"'))`,
        ).bind(genHookkaBufferRowId(), cat as Category, days, effectiveFrom, notes),
      );
    }
  }

  if (statements.length > 0) {
    await c.var.DB.batch(statements);
  }

  const data = await buildResponsePayload(c.var.DB);
  return c.json({ success: true, data });
});

// POST /recalc-all — bulk reschedule every PO's job_card dueDates using the
// current lead-time config. Mirrors the reverse-schedule in sales-orders.ts.
// Orphans (no SO, no DD, no targetEndDate) are counted in `skipped`.
app.post("/recalc-all", async (c) => {
  const denied = await requirePermission(c, "production-leadtimes", "create");
  if (denied) return denied;
  try {
    // Auto-schedule OFF => recalc is a no-op so manually-entered due dates are
    // never overwritten. Server-side gate regardless of UI state.
    const settings = await loadLeadTimeSettings(c.var.DB);
    if (!settings.autoScheduleEnabled) {
      return c.json({
        success: true,
        updatedPOs: 0,
        updatedJCs: 0,
        skipped: 0,
        autoScheduleDisabled: true,
      });
    }

    const [leadTimes, hookkaBuffer] = await Promise.all([
      loadLeadTimes(c.var.DB),
      loadHookkaDDBuffer(c.var.DB),
    ]);

    const poRes = await c.var.DB
      .prepare(
        `SELECT po.id AS id, po.itemCategory AS "itemCategory",
                po.targetEndDate AS "targetEndDate",
                so.customerDeliveryDate AS "customerDeliveryDate",
                so.hookkaExpectedDD AS "hookkaExpectedDD"
           FROM production_orders po
           LEFT JOIN sales_orders so ON so.id = po.salesOrderId`,
      )
      .all<PORow>();
    const pos = poRes.results ?? [];
    if (pos.length === 0) {
      return c.json({ success: true, updatedPOs: 0, updatedJCs: 0, skipped: 0 });
    }

    const jcRes = await c.var.DB
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
      const anchor = scheduleAnchorFor(po, hookkaBuffer);
      if (!anchor) { skipped++; continue; }
      const jcs = jcsByPo.get(po.id) ?? [];
      if (jcs.length === 0) continue;
      const category = po.itemCategory || "BEDFRAME";
      const newDueByJc = computeNewDueDates(jcs, category, anchor, leadTimes);
      if (newDueByJc.size === 0) continue;
      updatedPOs++;
      for (const [jcId, newDue] of newDueByJc) {
        updateStatements.push(
          c.var.DB
            // SENT-LOCK (owner 2026-08-03): a card already handed to the floor
            // (distributedAt ticked) keeps its date. Recalculating lead times
            // must never move work the departments are already building to —
            // they would be running to a date nobody told them changed.
            .prepare(
              `UPDATE job_cards SET dueDate = ?
                WHERE id = ? AND (distributedAt IS NULL OR distributedAt = '')`,
            )
            .bind(newDue, jcId),
        );
        updatedJCs++;
      }
    }
    for (let i = 0; i < updateStatements.length; i += RECALC_BATCH_SIZE) {
      const chunk = updateStatements.slice(i, i + RECALC_BATCH_SIZE);
      if (chunk.length > 0) await c.var.DB.batch(chunk);
    }
    return c.json({ success: true, updatedPOs, updatedJCs, skipped });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: msg }, 500);
  }
});

// ---------------------------------------------------------------------------
// Lead-time + hookka-buffer history (production_lead_times_history,
// hookka_dd_buffer_history; migration 0105). Mirrors the price-history
// endpoints on /api/products/* — append-only rows with effective_from,
// resolver picks newest <= today, future-dated rows stay dormant until
// their date passes.
// ---------------------------------------------------------------------------

// GET /history — full merged history (lead-time rows + hookka-buffer rows),
// each tagged with `kind` and computed `status` (Pending / Active / Past).
// Sorted newest-first by effective_from then created_at to match the
// MasterPriceHistoryDialog table convention.
app.get("/history", async (c) => {
  const today = todayIso();
  const [ltRes, bufRes] = await Promise.all([
    c.var.DB.prepare(
      `SELECT id, category, dept_code AS "deptCode", days,
              effective_from AS "effectiveFrom",
              notes, created_at AS "createdAt"
         FROM production_lead_times_history
        ORDER BY effective_from DESC, created_at DESC`,
    ).all<{
      id: string;
      category: string;
      deptCode?: string;
      dept_code?: string;
      days: number;
      effectiveFrom?: string;
      effective_from?: string;
      notes: string | null;
      createdAt?: string;
      created_at?: string;
    }>(),
    c.var.DB.prepare(
      `SELECT id, category, days,
              effective_from AS "effectiveFrom",
              notes, created_at AS "createdAt"
         FROM hookka_dd_buffer_history
        ORDER BY effective_from DESC, created_at DESC`,
    ).all<{
      id: string;
      category: string;
      days: number;
      effectiveFrom?: string;
      effective_from?: string;
      notes: string | null;
      createdAt?: string;
      created_at?: string;
    }>(),
  ]);

  // Build (cat, dept) → newest-effective-row id, so we can mark exactly one
  // row "Active" per (cat, dept). Rows newer than today are Pending; older
  // rows that were once active become Past. Mirrors the activeId resolution
  // in MaintenanceItemHistoryDialog.
  const ltActiveByKey = new Map<string, string>();
  for (const r of ltRes.results ?? []) {
    const dept = r.deptCode ?? r.dept_code;
    const ef = r.effectiveFrom ?? r.effective_from;
    if (!dept || !ef) continue;
    const key = `${r.category}|${dept}`;
    if (ef > today) continue;
    if (!ltActiveByKey.has(key)) ltActiveByKey.set(key, r.id);
  }
  const bufActiveByKey = new Map<string, string>();
  for (const r of bufRes.results ?? []) {
    const ef = r.effectiveFrom ?? r.effective_from;
    if (!ef) continue;
    if (ef > today) continue;
    if (!bufActiveByKey.has(r.category)) bufActiveByKey.set(r.category, r.id);
  }

  const leadTimes: LeadTimeHistoryRow[] = (ltRes.results ?? [])
    .map((r): LeadTimeHistoryRow | null => {
      const dept = r.deptCode ?? r.dept_code;
      const ef = r.effectiveFrom ?? r.effective_from;
      if (!dept || !ef) return null;
      const key = `${r.category}|${dept}`;
      const status: "Pending" | "Active" | "Past" =
        ef > today ? "Pending" : ltActiveByKey.get(key) === r.id ? "Active" : "Past";
      return {
        id: r.id,
        kind: "leadTime",
        category: r.category,
        deptCode: dept,
        days: r.days,
        effectiveFrom: ef,
        notes: r.notes ?? "",
        createdAt: r.createdAt ?? r.created_at ?? "",
        status,
      };
    })
    .filter((x): x is LeadTimeHistoryRow => x !== null);

  const hookkaBuffer: HookkaBufferHistoryRow[] = (bufRes.results ?? [])
    .map((r): HookkaBufferHistoryRow | null => {
      const ef = r.effectiveFrom ?? r.effective_from;
      if (!ef) return null;
      const status: "Pending" | "Active" | "Past" =
        ef > today ? "Pending" : bufActiveByKey.get(r.category) === r.id ? "Active" : "Past";
      return {
        id: r.id,
        kind: "hookkaBuffer",
        category: r.category,
        days: r.days,
        effectiveFrom: ef,
        notes: r.notes ?? "",
        createdAt: r.createdAt ?? r.created_at ?? "",
        status,
      };
    })
    .filter((x): x is HookkaBufferHistoryRow => x !== null);

  return c.json({ success: true, data: { leadTimes, hookkaBuffer } });
});

// POST /schedule — append a new dated lead-time or hookka-buffer row.
// Body shape (kind selects which history table):
//   { kind: "leadTime",     category, deptCode, days, effectiveFrom, notes? }
//   { kind: "hookkaBuffer", category,           days, effectiveFrom, notes? }
//
// ON CONFLICT DO UPDATE on the (cat, dept_code, effective_from) /
// (cat, effective_from) unique constraint added in migration 0106 — same
// (cat, dept, date) tuple just overwrites instead of stacking duplicate
// rows. No auto-baseline logic needed since every inline /planning Save
// also writes a today-dated history row, so the historical "what was the
// value before?" gap is naturally captured.
app.post("/schedule", async (c) => {
  const denied = await requirePermission(c, "production-leadtimes", "update");
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }

  const kind = body.kind === "hookkaBuffer" ? "hookkaBuffer" : body.kind === "leadTime" ? "leadTime" : null;
  if (!kind) {
    return c.json({ success: false, error: "kind must be 'leadTime' or 'hookkaBuffer'" }, 400);
  }
  const category = String(body.category ?? "").trim();
  if (category !== "BEDFRAME" && category !== "SOFA") {
    return c.json({ success: false, error: "category must be BEDFRAME or SOFA" }, 400);
  }
  const effectiveFrom = String(body.effectiveFrom ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    return c.json({ success: false, error: "effectiveFrom (YYYY-MM-DD) is required" }, 400);
  }
  const daysRaw = Number(body.days);
  if (!Number.isFinite(daysRaw) || daysRaw < 0) {
    return c.json({ success: false, error: "days must be a non-negative number" }, 400);
  }
  const days = Math.round(daysRaw);
  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
  const createdBy = typeof body.createdBy === "string" && body.createdBy ? body.createdBy : null;

  if (kind === "leadTime") {
    const deptCode = String(body.deptCode ?? "").trim();
    if (!deptCode) {
      return c.json({ success: false, error: "deptCode is required for kind=leadTime" }, 400);
    }
    const id = genLeadTimeRowId();
    await c.var.DB
      .prepare(
        `INSERT INTO production_lead_times_history
           (id, category, dept_code, days, effective_from, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (category, dept_code, effective_from)
         DO UPDATE SET days = EXCLUDED.days,
                       notes = EXCLUDED.notes,
                       created_by = EXCLUDED.created_by,
                       created_at = (to_char(NOW() AT TIME ZONE 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS"Z"'))`,
      )
      .bind(id, category, deptCode, days, effectiveFrom, notes, createdBy)
      .run();
    return c.json({ success: true, data: { id } }, 201);
  }

  // kind === "hookkaBuffer"
  const id = genHookkaBufferRowId();
  await c.var.DB
    .prepare(
      `INSERT INTO hookka_dd_buffer_history
         (id, category, days, effective_from, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (category, effective_from)
       DO UPDATE SET days = EXCLUDED.days,
                     notes = EXCLUDED.notes,
                     created_by = EXCLUDED.created_by,
                     created_at = (to_char(NOW() AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS"Z"'))`,
    )
    .bind(id, category, days, effectiveFrom, notes, createdBy)
    .run();
  return c.json({ success: true, data: { id } }, 201);
});

// DELETE /history/:id — remove a single history row. Auto-detects whether
// the id belongs to the lead-time or hookka-buffer table by id-prefix
// (`lt-` vs `hd-`); falls back to checking each table if the prefix
// convention drifts.
app.delete("/history/:id", async (c) => {
  const denied = await requirePermission(c, "production-leadtimes", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  if (!id) return c.json({ success: false, error: "id is required" }, 400);

  const tables = id.startsWith("hd-")
    ? (["hookka_dd_buffer_history", "production_lead_times_history"] as const)
    : (["production_lead_times_history", "hookka_dd_buffer_history"] as const);

  for (const table of tables) {
    const existing = await c.var.DB
      .prepare(`SELECT id FROM ${table} WHERE id = ?`)
      .bind(id)
      .first<{ id: string }>();
    if (existing) {
      await c.var.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
      return c.json({ success: true, data: { id, table } });
    }
  }
  return c.json({ success: false, error: "History row not found" }, 404);
});

export default app;
