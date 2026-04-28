// ---------------------------------------------------------------------------
// QC Pending Inspections + Cron Trigger (Phase 1).
//
// Time-triggered QC: every day at 12:00 and 16:00 (factory's local time) we
// generate a PENDING qc_inspections row per active qc_templates row. The
// inspector picks each up, samples a real subject (RM batch / job card /
// FG batch), and either fills in the per-item results (PASS/FAIL/NA) or
// marks the slot SKIPPED ("no production at this stage today").
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
//   DELETE /api/qc-pending/:id          — cancel a PENDING slot (e.g., template
//                                         was deactivated mid-day).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

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

async function getNextInspectionNo(db: D1Database): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `QC-${yymm}-`;
  const res = await db
    .prepare("SELECT COUNT(*) as n FROM qc_inspections WHERE inspectionNo LIKE ?")
    .bind(`${prefix}%`)
    .first<{ n: number }>();
  const seq = (res?.n ?? 0) + 1;
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

/**
 * Compute the most-recent past 12:00 / 16:00 slot in the user's local TZ.
 * Returns ISO string in UTC.
 *
 * The factory operates in UTC+8 (Singapore / Malaysia). We anchor the slot
 * boundaries to local clock time so "12:00 noon" means noon LOCAL.
 */
function currentSlotIso(now = new Date()): string {
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
 * Generate one PENDING qc_inspections row per active template, snapshotting
 * the template's items into the row. Idempotent — if a row already exists for
 * (templateId, scheduledSlotAt) we skip it. Returns count of new rows created.
 */
async function generatePendingForSlot(
  db: D1Database,
  slotIso: string,
): Promise<{ created: number; skipped: number }> {
  const [tplRes, tplItemRes, existingRes] = await Promise.all([
    db.prepare("SELECT * FROM qc_templates WHERE active = 1").all<TemplateRow>(),
    db.prepare("SELECT * FROM qc_template_items").all<TemplateItemRow>(),
    db
      .prepare("SELECT templateId FROM qc_inspections WHERE scheduledSlotAt = ?")
      .bind(slotIso)
      .all<{ templateId: string }>(),
  ]);

  const templates = tplRes.results ?? [];
  const tplItems = tplItemRes.results ?? [];
  const existingTplIds = new Set((existingRes.results ?? []).map((r) => r.templateId));

  const stmts: D1PreparedStatement[] = [];
  const slotDate = slotIso.split("T")[0];
  let created = 0;
  let skipped = 0;

  for (const tpl of templates) {
    if (existingTplIds.has(tpl.id)) {
      skipped++;
      continue;
    }
    const inspId = genInspId();
    const inspNo = await getNextInspectionNo(db);
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
  return { created, skipped };
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
// Side-effects on FAIL:
//   • One qc_tags row per FAIL item (status='ACTIVE')
//   • qc_defects rows kept in sync for backwards-compat with the old view
//   • If stage='WIP' and subjectType='JOB_CARD', reset the JC: status=BLOCKED,
//     completedDate=null, wipQty=0, actualMinutes=null, productionTimeMinutes=0.
app.post("/:id/complete", async (c) => {
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
    const body = (await c.req.json()) as Record<string, unknown>;
    const subjectType = body.subjectType as SubjectType;
    const subjectId = body.subjectId as string;
    const subjectLabel = (body.subjectLabel as string) ?? "";
    const subjectCode = (body.subjectCode as string) ?? "";
    const items = (Array.isArray(body.items) ? body.items : []) as Array<{
      id: string;
      result: "PASS" | "FAIL" | "NA";
      notes?: string;
      photoUrl?: string;
    }>;
    const overallNotes = (body.overallNotes as string) ?? "";
    const inspectorId = (body.inspectorId as string) ?? existing.inspectorId ?? null;
    const inspectorName = (body.inspectorName as string) ?? existing.inspectorName ?? null;

    if (!subjectType) return c.json({ success: false, error: "subjectType is required" }, 400);
    if (!subjectId) return c.json({ success: false, error: "subjectId is required" }, 400);
    if (items.length === 0) return c.json({ success: false, error: "items array is required" }, 400);

    // Load existing per-item rows so we can map by id and detect missing
    const itemRowsRes = await c.var.DB
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
          return c.json(
            { success: false, error: `Item "${ir.itemName}" is mandatory and must be PASS / FAIL / NA` },
            400,
          );
        }
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
        c.var.DB
          .prepare(
            `UPDATE qc_inspection_items SET result = ?, notes = ?, photoUrl = ? WHERE id = ?`,
          )
          .bind(it.result, it.notes ?? null, it.photoUrl ?? null, it.id),
      );
    }

    // 2. Update the inspection header
    stmts.push(
      c.var.DB
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
    const failItems = items.filter((it) => it.result === "FAIL");
    for (const it of failItems) {
      const row = itemRowsById.get(it.id);
      if (!row) continue;
      const tagId = genTagId();
      stmts.push(
        c.var.DB
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
        c.var.DB
          .prepare(
            `INSERT INTO qc_defects (id, qcInspectionId, type, severity, description, actionTaken)
             VALUES (?, ?, 'OTHER', ?, ?, 'REWORK')`,
          )
          .bind(genDefectId(), id, row.severity, `${row.itemName}: ${it.notes ?? "(no detail)"}`),
      );
    }

    // 4. WIP-stage + JOB_CARD subject + FAIL → reset the Job Card.
    if (overallFail && existing.stage === "WIP" && subjectType === "JOB_CARD") {
      stmts.push(
        c.var.DB
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
    }

    await c.var.DB.batch(stmts);

    // Reload + return
    const [updated, updatedItems] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM qc_inspections WHERE id = ?").bind(id).first<InspectionRow>(),
      c.var.DB
        .prepare("SELECT * FROM qc_inspection_items WHERE inspectionId = ? ORDER BY sequence")
        .bind(id)
        .all<InspectionItemRow>(),
    ]);
    if (!updated) return c.json({ success: false, error: "Reload failed" }, 500);

    return c.json({
      success: true,
      data: rowToInspection(updated, updatedItems.results ?? []),
      sideEffects: {
        tagsCreated: failItems.length,
        jobCardReset: overallFail && existing.stage === "WIP" && subjectType === "JOB_CARD",
      },
    });
  } catch (err) {
    console.error("[qc-pending/complete] error:", err);
    return c.json({ success: false, error: err instanceof Error ? err.message : "Invalid body" }, 400);
  }
});

// DELETE /api/qc-pending/:id — cancel a PENDING / IN_PROGRESS slot
app.delete("/:id", async (c) => {
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
