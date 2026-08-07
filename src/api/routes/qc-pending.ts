// ---------------------------------------------------------------------------
// QC Pending Inspections + Cron Trigger (Phase 1).
//
// Time-triggered, PRODUCTION-COUPLED QC: every day at 12:00 and 16:00
// (factory's local time) we generate a PENDING qc_inspections row per active
// qc_templates row THAT HAS SOMETHING TO SAMPLE that day — a WIP department
// with work in hand, an RM stage that actually received goods, an FG stage
// that actually produced units. The inspector picks each up, samples a real
// subject (RM batch / job card / FG batch), and either fills in the per-item
// results (PASS/FAIL/NA) or marks the slot SKIPPED.
//
// It was NOT coupled until 2026-08-07: it was a blind schedule, 34 rows a day
// regardless of whether anything was made, which produced a 3,009-row backlog
// nobody could ever clear and therefore nobody read. See stageHadActivity.
//
// Endpoints:
//   GET    /api/qc-pending              — list PENDING + IN_PROGRESS rows
//                                         (filter by ?slot=, ?stage=, ?deptCode=)
//   POST   /api/qc-pending/trigger      — cron entry. CRON_SECRET-gated.
//                                         Body: { slot?: ISO timestamp }. If
//                                         omitted, uses current 12:00/16:00
//                                         slot (closest past slot today).
//                                         Idempotent: never creates duplicate
//                                         (template_id, scheduled_slot_at) rows.
//   POST   /api/qc-pending/generate-now — manual trigger from UI button (auth-gated).
//                                         Same logic as /trigger, no secret.
//   POST   /api/qc-pending/:id/start    — flip PENDING → IN_PROGRESS, attach inspector.
//   POST   /api/qc-pending/:id/complete — submit final results. Body has
//                                         { subjectType, subjectId, subjectLabel,
//                                           items: [{templateItemId, result, notes?, photoUrl?}],
//                                           overallNotes? }. Computes overall
//                                         PASS/FAIL, creates qc_tags rows for
//                                         every FAIL item, and (for WIP stage)
//                                         resets the linked job_card.
//   POST   /api/qc-pending/:id/skip     — mark SKIPPED with reason.
//   POST   /api/qc-pending/bulk-skip    — retire a backlog of old slots with a
//                                         reason. DRY RUN unless confirm:true.
//                                         HAS NOT BEEN RUN — see the handler.
//   DELETE /api/qc-pending/:id          — cancel a PENDING slot (e.g., template
//                                         was deactivated mid-day).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { recomputePoStatusAndProgress } from "./production-orders";

const app = new Hono<Env>();

// --- types ----------------------------------------------------------------
type Stage = "RM" | "WIP" | "FG";
type ItemCategory = "SOFA" | "BEDFRAME" | "ACCESSORY" | "GENERAL";
type Severity = "MINOR" | "MAJOR" | "CRITICAL";
type SubjectType = "RM_BATCH" | "JOB_CARD" | "FG_BATCH" | "RAW_MATERIAL" | "WIP_ITEM";

type InspectionRow = {
  id: string;
  inspectionNo: string | null;
  templateId: string | null;
  templateSnapshot: string | null;
  stage: Stage | null;
  itemCategory: ItemCategory | null;
  department: string | null;
  subjectType: SubjectType | null;
  subjectId: string | null;
  subjectLabel: string | null;
  triggerType: string | null;
  scheduledSlotAt: string | null;
  status: string | null;
  result: string | null;
  notes: string | null;
  inspectorId: string | null;
  inspectorName: string | null;
  inspectionDate: string | null;
  skipReason: string | null;
  completedAt: string | null;
  createdAt: string | null;
};

type TemplateRow = {
  id: string;
  name: string;
  deptCode: string;
  deptName: string | null;
  itemCategory: ItemCategory;
  stage: Stage;
  active: number;
  notes: string | null;
};

type TemplateItemRow = {
  id: string;
  templateId: string;
  sequence: number;
  itemName: string;
  criteria: string | null;
  severity: Severity;
  isMandatory: number;
};

type InspectionItemRow = {
  id: string;
  inspectionId: string;
  sequence: number;
  itemName: string;
  criteria: string | null;
  severity: Severity;
  isMandatory: number;
  result: "PASS" | "FAIL" | "NA" | null;
  notes: string | null;
  photoUrl: string | null;
};

// --- helpers --------------------------------------------------------------
function genInspId(): string {
  return `qc-${crypto.randomUUID().slice(0, 8)}`;
}
function genItemId(): string {
  return `qcii-${crypto.randomUUID().slice(0, 8)}`;
}
function genTagId(): string {
  return `qctg-${crypto.randomUUID().slice(0, 8)}`;
}
function genDefectId(): string {
  return `qcd-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * One allocator per generation run, NOT one lookup per inspection.
 *
 * BUG-2026-08-07: this used to be `getNextInspectionNo(db)` — a COUNT(*)
 * called inside the per-template loop. Every INSERT of the run is deferred to
 * a single db.batch() at the end, so the count never moved between calls and
 * EVERY inspection generated in the same slot got the SAME inspectionNo. On
 * prod that meant 17 rows per slot sharing one number, twice a day, for three
 * months — an inspection number that identifies seventeen inspections
 * identifies none of them.
 *
 * The base is now read ONCE, before the loop, and the counter is incremented
 * in memory per row. It is also taken from the highest suffix actually in use
 * rather than a row COUNT, so a deleted slot (DELETE /api/qc-pending/:id) can
 * no longer hand its number to the next run.
 */
async function inspectionNoAllocator(
  db: D1Database,
): Promise<() => string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `QC-${yymm}-`;
  const res = await db
    .prepare("SELECT inspectionNo FROM qc_inspections WHERE inspectionNo LIKE ?")
    .bind(`${prefix}%`)
    .all<{ inspectionNo: string | null }>();
  let seq = 0;
  for (const r of res.results ?? []) {
    const tail = Number((r.inspectionNo ?? "").slice(prefix.length));
    if (Number.isFinite(tail) && tail > seq) seq = tail;
  }
  return () => {
    seq += 1;
    return `${prefix}${String(seq).padStart(3, "0")}`;
  };
}

// --- is there anything to inspect? ----------------------------------------
//
// BUG-2026-08-07: generation used to be a blind schedule — one row per active
// template per slot, twice a day, forever, whether or not that station made
// anything or any goods arrived. 34 rows a day against a factory that had not
// completed a single inspection. A queue that can never be cleared is a queue
// everyone learns to ignore, and that is exactly what happened.
//
// Owner 2026-08-07: everything is SAMPLING, tied to actual volume — "他应该要
// 定期检查我们的 WIP 部门，还有我们的完成品（我们正常是抽查）… 如果是进货，也就是
// IQC 那边，基本上他应该也都是要抽查的".
//
// So a slot is only created when the thing it samples EXISTS on that date:
//   WIP — the department has work in hand (a card IN_PROGRESS or PAUSED) or
//         finished something that day. A WAITING-only department is a queue,
//         not production: nothing has been made yet, so there is nothing to
//         sample. (The phone still offers WAITING cards as subjects once a
//         slot exists — being able to inspect a card that just started is
//         fine; generating a slot for a department that has only ever queued
//         is not.)
//   RM  — goods were actually received that day (a CONFIRMED / POSTED GRN).
//         Per-material targeting ("根据不一样的 material 去抽查") is the next
//         step and is NOT implemented here; today this is per-day.
//   FG  — finished units were actually produced that day.
//
// Fail OPEN: an unknown stage, or a probe that throws, still generates. Over-
// generating is a nuisance; silently never generating is how you end up
// believing you have QC when you don't.
async function stageHadActivity(
  db: D1Database,
  stage: Stage | null,
  deptCode: string,
  slotDate: string,
): Promise<boolean> {
  try {
    if (stage === "WIP") {
      const row = await db
        .prepare(
          `SELECT 1 AS hit FROM job_cards
            WHERE departmentCode = ?
              AND (status IN ('IN_PROGRESS','PAUSED') OR completedDate = ?)
            LIMIT 1`,
        )
        .bind(deptCode, slotDate)
        .first<{ hit: number }>();
      return !!row;
    }
    if (stage === "RM") {
      const row = await db
        .prepare(
          `SELECT 1 AS hit FROM grns
            WHERE receiveDate LIKE ?
              AND status IN ('CONFIRMED','POSTED')
            LIMIT 1`,
        )
        .bind(`${slotDate}%`)
        .first<{ hit: number }>();
      return !!row;
    }
    if (stage === "FG") {
      const row = await db
        .prepare(
          `SELECT 1 AS hit FROM fg_units
            WHERE mfdDate LIKE ? OR packedAt LIKE ?
            LIMIT 1`,
        )
        .bind(`${slotDate}%`, `${slotDate}%`)
        .first<{ hit: number }>();
      return !!row;
    }
    return true;
  } catch (err) {
    console.error("[qc-pending] activity probe failed — generating anyway", {
      stage,
      deptCode,
      slotDate,
      err: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/**
 * Compute the most-recent past 12:00 / 16:00 slot in the user's local TZ.
 * Returns ISO string in UTC.
 *
 * The factory operates in UTC+8 (Singapore / Malaysia). We anchor the slot
 * boundaries to local clock time so "12:00 noon" means noon LOCAL.
 */
export function currentSlotIso(now = new Date()): string {
  // Convert to UTC+8 wall clock
  const utcMs = now.getTime();
  const localMs = utcMs + 8 * 60 * 60 * 1000;
  const local = new Date(localMs);
  const localHour = local.getUTCHours();
  // Pick the slot: 12:00 if local hour in [12, 16), 16:00 if [16, 24), else
  // yesterday's 16:00.
  const slotLocal = new Date(local);
  slotLocal.setUTCMinutes(0, 0, 0);
  if (localHour >= 16) {
    slotLocal.setUTCHours(16);
  } else if (localHour >= 12) {
    slotLocal.setUTCHours(12);
  } else {
    // Roll back one calendar day to yesterday 16:00 local
    slotLocal.setUTCDate(slotLocal.getUTCDate() - 1);
    slotLocal.setUTCHours(16);
  }
  // Convert back from UTC+8 wall clock to UTC ISO
  return new Date(slotLocal.getTime() - 8 * 60 * 60 * 1000).toISOString();
}

function rowToInspection(r: InspectionRow, items: InspectionItemRow[] = []) {
  return {
    id: r.id,
    inspectionNo: r.inspectionNo ?? "",
    templateId: r.templateId ?? "",
    templateSnapshot: r.templateSnapshot ? safeParseJson(r.templateSnapshot) : null,
    stage: r.stage,
    itemCategory: r.itemCategory,
    deptCode: r.department ?? "",
    subjectType: r.subjectType,
    subjectId: r.subjectId ?? "",
    subjectLabel: r.subjectLabel ?? "",
    triggerType: r.triggerType ?? "",
    scheduledSlotAt: r.scheduledSlotAt ?? "",
    status: r.status ?? "",
    result: r.result ?? "",
    notes: r.notes ?? "",
    inspectorId: r.inspectorId ?? "",
    inspectorName: r.inspectorName ?? "",
    inspectionDate: r.inspectionDate ?? "",
    skipReason: r.skipReason ?? "",
    completedAt: r.completedAt ?? "",
    createdAt: r.createdAt ?? "",
    items: items
      .filter((i) => i.inspectionId === r.id)
      .sort((a, b) => a.sequence - b.sequence)
      .map((i) => ({
        id: i.id,
        sequence: i.sequence,
        itemName: i.itemName,
        criteria: i.criteria ?? "",
        severity: i.severity,
        isMandatory: i.isMandatory === 1,
        result: i.result,
        notes: i.notes ?? "",
        photoUrl: i.photoUrl ?? "",
      })),
  };
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Constant-time string equality for cron-secret check. Hashes both sides.
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  if (va.length !== vb.length) return false;
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

// --- shared trigger logic -------------------------------------------------
/**
 * Generate one PENDING qc_inspections row per active template THAT HAS
 * SOMETHING TO SAMPLE on the slot's date, snapshotting the template's items
 * into the row. Idempotent — if a row already exists for (templateId,
 * scheduledSlotAt) we skip it.
 *
 * Returns { created, skipped, skippedNoActivity }. The third number is the
 * whole point of the coupling and is reported by /trigger and /generate-now:
 * "nothing generated" must be legible as "nothing was made today", not as a
 * cron that failed.
 */
export async function generatePendingForSlot(
  db: D1Database,
  slotIso: string,
): Promise<{ created: number; skipped: number; skippedNoActivity: number }> {
  const [tplRes, tplItemRes, existingRes, nextInspectionNo] = await Promise.all([
    db.prepare("SELECT * FROM qc_templates WHERE active = 1").all<TemplateRow>(),
    db.prepare("SELECT * FROM qc_template_items").all<TemplateItemRow>(),
    db
      .prepare("SELECT templateId FROM qc_inspections WHERE scheduledSlotAt = ?")
      .bind(slotIso)
      .all<{ templateId: string }>(),
    // Read the number base ONCE, before the loop — see inspectionNoAllocator.
    inspectionNoAllocator(db),
  ]);

  const templates = tplRes.results ?? [];
  const tplItems = tplItemRes.results ?? [];
  const existingTplIds = new Set((existingRes.results ?? []).map((r) => r.templateId));

  const stmts: D1PreparedStatement[] = [];
  const slotDate = slotIso.split("T")[0];
  let created = 0;
  let skipped = 0;
  let skippedNoActivity = 0;

  // One probe per (stage, deptCode) rather than one per template — several
  // templates commonly share a department.
  const activityCache = new Map<string, boolean>();

  for (const tpl of templates) {
    if (existingTplIds.has(tpl.id)) {
      skipped++;
      continue;
    }
    const activityKey = `${tpl.stage}|${tpl.deptCode}`;
    let active = activityCache.get(activityKey);
    if (active === undefined) {
      active = await stageHadActivity(db, tpl.stage, tpl.deptCode, slotDate);
      activityCache.set(activityKey, active);
    }
    if (!active) {
      skippedNoActivity++;
      continue;
    }
    const inspId = genInspId();
    const inspNo = nextInspectionNo();
    const items = tplItems
      .filter((i) => i.templateId === tpl.id)
      .sort((a, b) => a.sequence - b.sequence);
    const snapshot = JSON.stringify({
      templateName: tpl.name,
      items: items.map((i) => ({
        id: i.id,
        sequence: i.sequence,
        itemName: i.itemName,
        criteria: i.criteria,
        severity: i.severity,
        isMandatory: i.isMandatory,
      })),
    });
    const now = new Date().toISOString();

    stmts.push(
      db
        .prepare(
          `INSERT INTO qc_inspections (
             id, inspectionNo, templateId, templateSnapshot, stage, itemCategory,
             department, triggerType, scheduledSlotAt, status,
             inspectionDate, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, 'PENDING', ?, ?)`,
        )
        .bind(
          inspId,
          inspNo,
          tpl.id,
          snapshot,
          tpl.stage,
          tpl.itemCategory,
          tpl.deptCode,
          slotIso,
          slotDate,
          now,
        ),
    );

    // Pre-create the per-item rows with result=null so the inspector just fills in
    for (const it of items) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO qc_inspection_items (
               id, inspectionId, sequence, itemName, criteria, severity, isMandatory, result
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .bind(genItemId(), inspId, it.sequence, it.itemName, it.criteria, it.severity, it.isMandatory),
      );
    }
    created++;
  }

  if (stmts.length) await db.batch(stmts);
  return { created, skipped, skippedNoActivity };
}

// --- routes ---------------------------------------------------------------

// GET /api/qc-pending — list PENDING + IN_PROGRESS, optionally filtered.
app.get("/", async (c) => {
  const slot = c.req.query("slot");
  const stage = c.req.query("stage");
  const deptCode = c.req.query("deptCode");
  const includeSkipped = c.req.query("includeSkipped") === "1";

  const clauses: string[] = [
    includeSkipped
      ? "status IN ('PENDING','IN_PROGRESS','SKIPPED')"
      : "status IN ('PENDING','IN_PROGRESS')",
  ];
  const params: (string | number)[] = [];
  if (slot) {
    clauses.push("scheduledSlotAt = ?");
    params.push(slot);
  }
  if (stage) {
    clauses.push("stage = ?");
    params.push(stage);
  }
  if (deptCode) {
    clauses.push("department = ?");
    params.push(deptCode);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;

  const inspRes = await c.var.DB
    .prepare(`SELECT * FROM qc_inspections ${where} ORDER BY scheduledSlotAt DESC, department, stage`)
    .bind(...params)
    .all<InspectionRow>();
  const inspections = inspRes.results ?? [];

  let itemsResults: InspectionItemRow[] = [];
  if (inspections.length > 0) {
    const placeholders = inspections.map(() => "?").join(",");
    const itemRes = await c.var.DB
      .prepare(`SELECT * FROM qc_inspection_items WHERE inspectionId IN (${placeholders}) ORDER BY sequence`)
      .bind(...inspections.map((i) => i.id))
      .all<InspectionItemRow>();
    itemsResults = itemRes.results ?? [];
  }

  const data = inspections.map((r) => rowToInspection(r, itemsResults));
  return c.json({ success: true, data, total: data.length });
});

// POST /api/qc-pending/trigger — cron entry.
app.post("/trigger", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "create");
  if (denied) return denied;
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[qc-pending/trigger] CRON_SECRET unset or too short — refusing");
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }

  let slotIso: string;
  try {
    const body = c.req.header("content-length") ? await c.req.json().catch(() => ({})) : {};
    slotIso = (body && typeof body === "object" && "slot" in body && typeof (body as Record<string, unknown>).slot === "string")
      ? ((body as Record<string, unknown>).slot as string)
      : currentSlotIso();
  } catch {
    slotIso = currentSlotIso();
  }
  try {
    const result = await generatePendingForSlot(c.var.DB, slotIso);
    return c.json({ ok: true, slotIso, ...result });
  } catch (err) {
    console.error("[qc-pending/trigger] error:", err);
    return c.json({ ok: false, error: "trigger failed" }, 500);
  }
});

// POST /api/qc-pending/generate-now — manual trigger from UI (auth-gated by global authMiddleware)
app.post("/generate-now", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json().catch(() => ({}));
    const slotIso =
      body && typeof body === "object" && "slot" in body && typeof (body as Record<string, unknown>).slot === "string"
        ? ((body as Record<string, unknown>).slot as string)
        : currentSlotIso();
    const result = await generatePendingForSlot(c.var.DB, slotIso);
    return c.json({ success: true, slotIso, ...result });
  } catch (err) {
    console.error("[qc-pending/generate-now] error:", err);
    return c.json({ success: false, error: "failed to generate" }, 500);
  }
});

// POST /api/qc-pending/:id/start — flip PENDING → IN_PROGRESS, attach inspector.
app.post("/:id/start", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "create");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB
    .prepare("SELECT * FROM qc_inspections WHERE id = ?")
    .bind(id)
    .first<InspectionRow>();
  if (!existing) return c.json({ success: false, error: "Inspection not found" }, 404);
  if (existing.status !== "PENDING" && existing.status !== "IN_PROGRESS") {
    return c.json({ success: false, error: `Inspection is ${existing.status}, cannot start` }, 409);
  }
  try {
    const body = await c.req.json().catch(() => ({}));
    const inspectorId = (body as Record<string, unknown>).inspectorId as string | undefined;
    const inspectorName = (body as Record<string, unknown>).inspectorName as string | undefined;
    await c.var.DB
      .prepare("UPDATE qc_inspections SET status = 'IN_PROGRESS', inspectorId = ?, inspectorName = ? WHERE id = ?")
      .bind(inspectorId ?? existing.inspectorId ?? null, inspectorName ?? existing.inspectorName ?? null, id)
      .run();
    return c.json({ success: true, data: { id, status: "IN_PROGRESS" } });
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : "Invalid body" }, 400);
  }
});

// POST /api/qc-pending/:id/skip — mark SKIPPED with reason.
app.post("/:id/skip", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "create");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB
    .prepare("SELECT * FROM qc_inspections WHERE id = ?")
    .bind(id)
    .first<InspectionRow>();
  if (!existing) return c.json({ success: false, error: "Inspection not found" }, 404);
  if (existing.status === "COMPLETED" || existing.status === "SKIPPED") {
    return c.json({ success: false, error: `Already ${existing.status}` }, 409);
  }
  try {
    const body = await c.req.json().catch(() => ({}));
    const reason = String((body as Record<string, unknown>).reason ?? "").trim() || "No production at this stage today";
    const now = new Date().toISOString();
    await c.var.DB
      .prepare("UPDATE qc_inspections SET status = 'SKIPPED', skipReason = ?, completedAt = ? WHERE id = ?")
      .bind(reason, now, id)
      .run();
    return c.json({ success: true, data: { id, status: "SKIPPED", skipReason: reason } });
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : "Invalid body" }, 400);
  }
});

// --- shared completion core ------------------------------------------------
//
// Submitting an inspection is NOT just a status flip — it writes the per-item
// results, the header, a qc_tag + qc_defect per FAIL, and (WIP + JOB_CARD +
// FAIL) resets the job card, clears its piece_pics and recomputes the parent
// PO. Two surfaces now submit inspections: the desktop ERP page and the worker
// phone (POST /api/worker/qc/:id/complete). They MUST NOT each own a copy of
// that side-effect list — the phone silently skipping the piece_pics clear
// would resurrect a QC-blocked card on the next scan (BUG-2026-06-08). So the
// whole thing lives here once and both routes call it. Each surface keeps its
// OWN authorization: this function assumes the caller already decided they may
// submit THIS inspection.
export type CompleteInspectionInput = {
  subjectType: SubjectType;
  subjectId: string;
  subjectLabel?: string;
  subjectCode?: string;
  items: Array<{
    id: string;
    result: "PASS" | "FAIL" | "NA";
    notes?: string;
    photoUrl?: string;
  }>;
  overallNotes?: string;
  inspectorId?: string | null;
  inspectorName?: string | null;
};

export type CompleteInspectionResult =
  | {
      ok: true;
      data: ReturnType<typeof rowToInspection>;
      sideEffects: { tagsCreated: number; jobCardReset: boolean };
    }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

export async function completeInspection(
  db: D1Database,
  id: string,
  input: CompleteInspectionInput,
): Promise<CompleteInspectionResult> {
  const existing = await db
    .prepare("SELECT * FROM qc_inspections WHERE id = ?")
    .bind(id)
    .first<InspectionRow>();
  if (!existing) return { ok: false, status: 404, error: "Inspection not found" };
  if (existing.status === "COMPLETED" || existing.status === "SKIPPED") {
    return { ok: false, status: 409, error: `Already ${existing.status}` };
  }

  const subjectType = input.subjectType;
  const subjectId = input.subjectId;
  const subjectLabel = input.subjectLabel ?? "";
  const subjectCode = input.subjectCode ?? "";
  const items = Array.isArray(input.items) ? input.items : [];
  const overallNotes = input.overallNotes ?? "";
  const inspectorId = input.inspectorId ?? existing.inspectorId ?? null;
  const inspectorName = input.inspectorName ?? existing.inspectorName ?? null;

  if (!subjectType) return { ok: false, status: 400, error: "subjectType is required" };
  if (!subjectId) return { ok: false, status: 400, error: "subjectId is required" };
  if (items.length === 0) return { ok: false, status: 400, error: "items array is required" };

  // Load existing per-item rows so we can map by id and detect missing
  const itemRowsRes = await db
    .prepare("SELECT * FROM qc_inspection_items WHERE inspectionId = ?")
    .bind(id)
    .all<InspectionItemRow>();
  const itemRows = itemRowsRes.results ?? [];
  const itemRowsById = new Map(itemRows.map((r) => [r.id, r]));

  // Validate every mandatory item has a result
  for (const ir of itemRows) {
    if (ir.isMandatory === 1) {
      const supplied = items.find((x) => x.id === ir.id);
      if (!supplied || !supplied.result) {
        return {
          ok: false,
          status: 400,
          error: `Item "${ir.itemName}" is mandatory and must be PASS / FAIL / NA`,
        };
      }
    }
  }

  // A FAIL with no words is not a finding, it is a shrug — and it is the ONE
  // thing a reviewer needs weeks later ("what actually failed?"). Enforced
  // server-side so neither surface can skip it.
  for (const it of items) {
    if (it.result === "FAIL" && !String(it.notes ?? "").trim()) {
      const row = itemRowsById.get(it.id);
      return {
        ok: false,
        status: 400,
        error: `"${row?.itemName ?? it.id}" is marked FAIL — say what failed`,
      };
    }
  }

  const overallFail = items.some((it) => it.result === "FAIL");
  const overallResult = overallFail ? "FAIL" : "PASS";
  const now = new Date().toISOString();

  const stmts: D1PreparedStatement[] = [];

  // 1. Update each per-item row
  for (const it of items) {
    const row = itemRowsById.get(it.id);
    if (!row) continue;
    stmts.push(
      db
        .prepare(
          `UPDATE qc_inspection_items SET result = ?, notes = ?, photoUrl = ? WHERE id = ?`,
        )
        .bind(it.result, it.notes ?? null, it.photoUrl ?? null, it.id),
    );
  }

  // 2. Update the inspection header
  stmts.push(
    db
      .prepare(
        `UPDATE qc_inspections SET
           status = 'COMPLETED',
           result = ?,
           subjectType = ?,
           subjectId = ?,
           subjectLabel = ?,
           notes = ?,
           inspectorId = ?,
           inspectorName = ?,
           completedAt = ?
         WHERE id = ?`,
      )
      .bind(
        overallResult,
        subjectType,
        subjectId,
        subjectLabel,
        overallNotes,
        inspectorId,
        inspectorName,
        now,
        id,
      ),
  );

  // 3. For each FAIL item, create a qc_tag + qc_defect row.
  // The tag is the new soft-marker model; the defect row is kept in sync
  // so the old defect-tracker UI / reports still see fail data.
  // (qc_tags stay WRITE-ONLY here — Phase 2 surfacing in Inventory / as DO
  // warnings was descoped by the owner. Don't re-surface them.)
  const failItems = items.filter((it) => it.result === "FAIL");
  for (const it of failItems) {
    const row = itemRowsById.get(it.id);
    if (!row) continue;
    const tagId = genTagId();
    stmts.push(
      db
        .prepare(
          `INSERT INTO qc_tags (
             id, subjectType, subjectId, subjectCode, subjectLabel,
             inspectionId, reason, severity, status, taggedBy, taggedByName, taggedAt
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
        )
        .bind(
          tagId,
          subjectType,
          subjectId,
          subjectCode || null,
          subjectLabel || null,
          id,
          `${row.itemName}${it.notes ? ` — ${it.notes}` : ""}`,
          row.severity,
          inspectorId,
          inspectorName,
          now,
        ),
    );
    // Mirror into qc_defects so legacy views still see fail data.
    stmts.push(
      db
        .prepare(
          `INSERT INTO qc_defects (id, qcInspectionId, type, severity, description, actionTaken)
           VALUES (?, ?, 'OTHER', ?, ?, 'REWORK')`,
        )
        .bind(genDefectId(), id, row.severity, `${row.itemName}: ${it.notes ?? "(no detail)"}`),
    );
  }

  // 4. WIP-stage + JOB_CARD subject + FAIL → reset the Job Card.
  let jcResetParentPoId: string | null = null;
  if (overallFail && existing.stage === "WIP" && subjectType === "JOB_CARD") {
    stmts.push(
      db
        .prepare(
          `UPDATE job_cards SET
             status = 'BLOCKED',
             completedDate = NULL,
             wipQty = 0,
             actualMinutes = NULL,
             productionTimeMinutes = 0
           WHERE id = ?`,
        )
        .bind(subjectId),
    );
    // BUG-2026-06-08: clearing the JC's completion alone leaves the per-piece
    // scan stamps (piece_pics) in place. A later scan re-derives "all pieces
    // done" from those stamps and re-completes the card (the same vector as
    // the production-page remove fix, BUG-2026-06-08-002), silently un-doing
    // the QC block. Clear this JC's piece_pics so a re-scan after rework
    // starts fresh instead of resurrecting the old completion.
    stmts.push(
      db
        .prepare(
          `UPDATE piece_pics SET
             pic1Id = NULL, pic1Name = NULL,
             pic2Id = NULL, pic2Name = NULL,
             completedAt = NULL, lastScanAt = NULL, boundStickerKey = NULL
           WHERE jobCardId = ?`,
        )
        .bind(subjectId),
    );
    // Stash the parent PO id so we can recompute its status/progress
    // after the batch commits — flipping a JC to BLOCKED can drop the
    // parent PO from COMPLETED (extremely rare but possible) or simply
    // refresh the progress %. Fetched outside the batch so the read
    // happens before the UPDATE lands.
    try {
      const jcRow = await db
        .prepare(`SELECT productionOrderId FROM job_cards WHERE id = ?`)
        .bind(subjectId)
        .first<{ productionOrderId: string }>();
      jcResetParentPoId = jcRow?.productionOrderId ?? null;
    } catch (err) {
      console.error("[qc-pending] parent PO lookup failed", {
        jcId: subjectId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await db.batch(stmts);

  // After the batch commits, recompute the parent PO's status/progress
  // off the fresh JC view. Defensive — a recompute miss must not void
  // the inspection submission that already committed.
  if (jcResetParentPoId) {
    try {
      await recomputePoStatusAndProgress(db, jcResetParentPoId);
    } catch (err) {
      console.error("[qc-pending] recomputePoStatusAndProgress failed", {
        poId: jcResetParentPoId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Reload + return
  const [updated, updatedItems] = await Promise.all([
    db.prepare("SELECT * FROM qc_inspections WHERE id = ?").bind(id).first<InspectionRow>(),
    db
      .prepare("SELECT * FROM qc_inspection_items WHERE inspectionId = ? ORDER BY sequence")
      .bind(id)
      .all<InspectionItemRow>(),
  ]);
  if (!updated) return { ok: false, status: 500, error: "Reload failed" };

  return {
    ok: true,
    data: rowToInspection(updated, updatedItems.results ?? []),
    sideEffects: {
      tagsCreated: failItems.length,
      jobCardReset: overallFail && existing.stage === "WIP" && subjectType === "JOB_CARD",
    },
  };
}

// POST /api/qc-pending/:id/complete — submit results + side-effects.
//
// Body: {
//   subjectType: 'RM_BATCH'|'JOB_CARD'|'FG_BATCH'|'RAW_MATERIAL'|'WIP_ITEM',
//   subjectId: string,
//   subjectLabel?: string,
//   subjectCode?: string,
//   items: [{ id: string, result: 'PASS'|'FAIL'|'NA', notes?: string, photoUrl?: string }],
//   overallNotes?: string,
//   inspectorId?: string,
//   inspectorName?: string,
// }
//
// Side-effects on FAIL: see completeInspection above.
app.post("/:id/complete", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "create");
  if (denied) return denied;
  const id = c.req.param("id");

  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const res = await completeInspection(c.var.DB, id, {
      subjectType: body.subjectType as SubjectType,
      subjectId: body.subjectId as string,
      subjectLabel: (body.subjectLabel as string) ?? "",
      subjectCode: (body.subjectCode as string) ?? "",
      items: (Array.isArray(body.items) ? body.items : []) as CompleteInspectionInput["items"],
      overallNotes: (body.overallNotes as string) ?? "",
      inspectorId: (body.inspectorId as string) ?? null,
      inspectorName: (body.inspectorName as string) ?? null,
    });
    if (!res.ok) return c.json({ success: false, error: res.error }, res.status);
    return c.json({ success: true, data: res.data, sideEffects: res.sideEffects });
  } catch (err) {
    console.error("[qc-pending/complete] error:", err);
    return c.json({ success: false, error: err instanceof Error ? err.message : "Invalid body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /api/qc-pending/bulk-skip — retire a backlog of slots that were
// generated by the old blind schedule and were never answerable.
//
// THIS HAS NOT BEEN RUN. It exists so that clearing the 3,009-row backlog is a
// reviewed, recorded operation with a reason attached, instead of somebody
// running UPDATE by hand against prod. Deciding to clear it is the owner's
// call, not an agent's.
//
// Safety posture:
//   • DRY RUN BY DEFAULT. Without `confirm: true` it only COUNTS what it would
//     touch and writes nothing.
//   • `beforeSlotIso` is REQUIRED — there is no "skip everything" call. You
//     name a cut-off and it only touches slots older than it.
//   • `reason` is REQUIRED (>= 10 chars) and is written onto every row, so the
//     history says why these were retired rather than leaving 3,009 silent
//     SKIPPEDs.
//   • Only PENDING / IN_PROGRESS rows move. A COMPLETED or already-SKIPPED
//     inspection is never rewritten.
//   • Gated on qc-inspections:delete — the same permission that cancels a
//     single slot.
//
// Body: { beforeSlotIso: string, reason: string, confirm?: boolean }
// ---------------------------------------------------------------------------
app.post("/bulk-skip", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "delete");
  if (denied) return denied;
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const beforeSlotIso = String(body.beforeSlotIso ?? "").trim();
    const reason = String(body.reason ?? "").trim();
    const confirm = body.confirm === true;

    if (!beforeSlotIso) {
      return c.json({ success: false, error: "beforeSlotIso is required — name a cut-off" }, 400);
    }
    if (reason.length < 10) {
      return c.json(
        { success: false, error: "reason is required and must say something (>= 10 chars)" },
        400,
      );
    }

    const countRow = await c.var.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM qc_inspections
          WHERE status IN ('PENDING','IN_PROGRESS')
            AND scheduledSlotAt < ?`,
      )
      .bind(beforeSlotIso)
      .first<{ n: number }>();
    const matched = Number(countRow?.n ?? 0);

    if (!confirm) {
      return c.json({
        success: true,
        dryRun: true,
        matched,
        message: `${matched} inspection(s) would be marked SKIPPED. Re-send with confirm: true to apply.`,
      });
    }

    const now = new Date().toISOString();
    await c.var.DB
      .prepare(
        `UPDATE qc_inspections
            SET status = 'SKIPPED', skipReason = ?, completedAt = ?
          WHERE status IN ('PENDING','IN_PROGRESS')
            AND scheduledSlotAt < ?`,
      )
      .bind(reason, now, beforeSlotIso)
      .run();

    return c.json({ success: true, dryRun: false, matched, skipped: matched });
  } catch (err) {
    console.error("[qc-pending/bulk-skip] error:", err);
    return c.json({ success: false, error: err instanceof Error ? err.message : "Invalid body" }, 400);
  }
});

// DELETE /api/qc-pending/:id — cancel a PENDING / IN_PROGRESS slot
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB
    .prepare("SELECT * FROM qc_inspections WHERE id = ?")
    .bind(id)
    .first<InspectionRow>();
  if (!existing) return c.json({ success: false, error: "Inspection not found" }, 404);
  if (existing.status !== "PENDING" && existing.status !== "IN_PROGRESS") {
    return c.json({ success: false, error: `Cannot delete ${existing.status} inspection` }, 409);
  }
  await c.var.DB.prepare("DELETE FROM qc_inspections WHERE id = ?").bind(id).run();
  return c.json({ success: true, data: { id, deleted: true } });
});

export default app;
