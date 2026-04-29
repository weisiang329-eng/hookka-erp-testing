// ---------------------------------------------------------------------------
// D1-backed QC Inspections route.
//
// Uses qc_inspections + qc_defects tables (already in 0001_init.sql).
// Schema stores `created_at` snake; API returns `createdAt` camel.
// Defects join nested under each inspection — matches the old mock shape.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type InspectionRow = {
  id: string;
  inspectionNo: string;
  productionOrderId: string | null;
  poNo: string | null;
  productCode: string | null;
  productName: string | null;
  customerName: string | null;
  department: string | null;
  inspectorId: string | null;
  inspectorName: string | null;
  result: string | null;
  notes: string | null;
  inspectionDate: string | null;
  createdAt: string | null;
  // Phase-1 columns (added in 0066). Null on legacy rows.
  templateId: string | null;
  templateSnapshot: string | null;
  stage: string | null;
  itemCategory: string | null;
  subjectType: string | null;
  subjectId: string | null;
  subjectLabel: string | null;
  triggerType: string | null;
  scheduledSlotAt: string | null;
  status: string | null;
  skipReason: string | null;
  completedAt: string | null;
};

type DefectRow = {
  id: string;
  qcInspectionId: string;
  type: string | null;
  severity: string | null;
  description: string | null;
  actionTaken: string | null;
};

type InspectionItemRow = {
  id: string;
  inspectionId: string;
  sequence: number;
  itemName: string;
  criteria: string | null;
  severity: string | null;
  isMandatory: number;
  result: string | null;
  notes: string | null;
  photoUrl: string | null;
};

function rowToInspection(
  row: InspectionRow,
  defects: DefectRow[] = [],
  items: InspectionItemRow[] = [],
) {
  return {
    id: row.id,
    inspectionNo: row.inspectionNo,
    productionOrderId: row.productionOrderId ?? "",
    poNo: row.poNo ?? "",
    productCode: row.productCode ?? "",
    productName: row.productName ?? "",
    customerName: row.customerName ?? "",
    department: row.department ?? "UPHOLSTERY",
    inspectorId: row.inspectorId ?? "",
    inspectorName: row.inspectorName ?? "",
    result: row.result ?? "PASS",
    notes: row.notes ?? "",
    inspectionDate: row.inspectionDate ?? "",
    createdAt: row.createdAt ?? "",
    // Phase 1 fields (null on legacy rows)
    templateId: row.templateId ?? "",
    templateSnapshot: row.templateSnapshot ? safeParseJson(row.templateSnapshot) : null,
    stage: row.stage,
    itemCategory: row.itemCategory,
    subjectType: row.subjectType,
    subjectId: row.subjectId ?? "",
    subjectLabel: row.subjectLabel ?? "",
    triggerType: row.triggerType ?? "",
    scheduledSlotAt: row.scheduledSlotAt ?? "",
    status: row.status ?? "",
    skipReason: row.skipReason ?? "",
    completedAt: row.completedAt ?? "",
    defects: defects
      .filter((d) => d.qcInspectionId === row.id)
      .map((d) => ({
        id: d.id,
        type: d.type ?? "OTHER",
        severity: d.severity ?? "MINOR",
        description: d.description ?? "",
        actionTaken: d.actionTaken ?? "ACCEPT",
      })),
    items: items
      .filter((i) => i.inspectionId === row.id)
      .sort((a, b) => a.sequence - b.sequence)
      .map((i) => ({
        id: i.id,
        sequence: i.sequence,
        itemName: i.itemName,
        criteria: i.criteria ?? "",
        severity: i.severity ?? "MAJOR",
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

function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function getNextQCNo(db: D1Database): Promise<string> {
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

// GET /api/qc-inspections
//
// Returns COMPLETED + SKIPPED inspections by default (the "history" view —
// the new Phase-1 page calls this for the History tab). Pass ?status=ALL to
// also include PENDING / IN_PROGRESS rows. The legacy quality.tsx page used
// this same endpoint for its inspections table; the new shape adds `items`,
// `templateSnapshot`, `stage`, `subject*` etc. — which are null on legacy
// rows, so the old UI keeps working.
app.get("/", async (c) => {
  const department = c.req.query("department");
  const result = c.req.query("result");
  const dateFrom = c.req.query("dateFrom");
  const dateTo = c.req.query("dateTo");
  const stage = c.req.query("stage");
  const itemCategory = c.req.query("itemCategory");
  const status = c.req.query("status");

  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (department) {
    clauses.push("department = ?");
    params.push(department);
  }
  if (result) {
    clauses.push("result = ?");
    params.push(result);
  }
  if (dateFrom) {
    clauses.push("inspectionDate >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    clauses.push("inspectionDate <= ?");
    params.push(dateTo);
  }
  if (stage) {
    clauses.push("stage = ?");
    params.push(stage);
  }
  if (itemCategory) {
    clauses.push("itemCategory = ?");
    params.push(itemCategory);
  }
  // Default = history view: completed + skipped + legacy rows (status NULL).
  // Pass ?status=ALL to opt out, or ?status=PENDING etc. to override.
  if (!status) {
    clauses.push("(status IN ('COMPLETED','SKIPPED') OR status IS NULL)");
  } else if (status !== "ALL") {
    clauses.push("status = ?");
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT * FROM qc_inspections ${where} ORDER BY created_at DESC LIMIT 500`;

  const inspRes = await c.var.DB.prepare(sql).bind(...params).all<InspectionRow>();
  const inspections = inspRes.results ?? [];
  const ids = inspections.map((i) => i.id);

  const [defRes, itemRes] = await Promise.all([
    ids.length
      ? c.var.DB
          .prepare(`SELECT * FROM qc_defects WHERE qcInspectionId IN (${ids.map(() => "?").join(",")})`)
          .bind(...ids)
          .all<DefectRow>()
      : Promise.resolve({ results: [] as DefectRow[] }),
    ids.length
      ? c.var.DB
          .prepare(`SELECT * FROM qc_inspection_items WHERE inspectionId IN (${ids.map(() => "?").join(",")})`)
          .bind(...ids)
          .all<InspectionItemRow>()
      : Promise.resolve({ results: [] as InspectionItemRow[] }),
  ]);
  const data = inspections.map((r) =>
    rowToInspection(r, defRes.results ?? [], itemRes.results ?? []),
  );
  return c.json({ success: true, data, total: data.length });
});

// POST /api/qc-inspections
app.post("/", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const id = genId("qc");
    const inspectionNo = await getNextQCNo(c.var.DB);
    const createdAt = new Date().toISOString();
    const inspectionDate =
      body.inspectionDate || new Date().toISOString().split("T")[0];

    await c.var.DB.prepare(
      `INSERT INTO qc_inspections (id, inspectionNo, productionOrderId, poNo, productCode,
         productName, customerName, department, inspectorId, inspectorName, result,
         notes, inspectionDate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        inspectionNo,
        body.productionOrderId ?? "",
        body.poNo ?? "",
        body.productCode ?? "",
        body.productName ?? "",
        body.customerName ?? "",
        body.department ?? "UPHOLSTERY",
        body.inspectorId ?? "",
        body.inspectorName ?? "QA Manager",
        body.result ?? "PASS",
        body.notes ?? "",
        inspectionDate,
        createdAt,
      )
      .run();

    const defectRows: DefectRow[] = [];
    const defects = Array.isArray(body.defects) ? body.defects : [];
    if (defects.length) {
      const stmts = defects.map((d: Record<string, unknown>) => {
        const did = genId("qcd");
        const row: DefectRow = {
          id: did,
          qcInspectionId: id,
          type: (d.type as string) ?? "OTHER",
          severity: (d.severity as string) ?? "MINOR",
          description: (d.description as string) ?? "",
          actionTaken: (d.actionTaken as string) ?? "ACCEPT",
        };
        defectRows.push(row);
        return c.var.DB.prepare(
          "INSERT INTO qc_defects (id, qcInspectionId, type, severity, description, actionTaken) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(
          row.id,
          row.qcInspectionId,
          row.type,
          row.severity,
          row.description,
          row.actionTaken,
        );
      });
      await c.var.DB.batch(stmts);
    }

    const created = await c.var.DB.prepare(
      "SELECT * FROM qc_inspections WHERE id = ?",
    )
      .bind(id)
      .first<InspectionRow>();
    if (!created) {
      return c.json({ success: false, error: "Failed to create inspection" }, 500);
    }
    return c.json(
      { success: true, data: rowToInspection(created, defectRows) },
      201,
    );
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/qc-inspections/:id
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [row, defs, items] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM qc_inspections WHERE id = ?")
      .bind(id)
      .first<InspectionRow>(),
    c.var.DB.prepare("SELECT * FROM qc_defects WHERE qcInspectionId = ?")
      .bind(id)
      .all<DefectRow>(),
    c.var.DB.prepare("SELECT * FROM qc_inspection_items WHERE inspectionId = ? ORDER BY sequence")
      .bind(id)
      .all<InspectionItemRow>(),
  ]);
  if (!row) {
    return c.json({ success: false, error: "QC inspection not found" }, 404);
  }
  return c.json({
    success: true,
    data: rowToInspection(row, defs.results ?? [], items.results ?? []),
  });
});

// PUT /api/qc-inspections/:id
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM qc_inspections WHERE id = ?",
    )
      .bind(id)
      .first<InspectionRow>();
    if (!existing) {
      return c.json({ success: false, error: "QC inspection not found" }, 404);
    }
    const body = await c.req.json();
    const merged = {
      result: body.result ?? existing.result,
      notes: body.notes ?? existing.notes ?? "",
      department: body.department ?? existing.department,
    };
    await c.var.DB.prepare(
      "UPDATE qc_inspections SET result = ?, notes = ?, department = ? WHERE id = ?",
    )
      .bind(merged.result, merged.notes, merged.department, id)
      .run();

    // Defects replace on full array
    if (Array.isArray(body.defects)) {
      await c.var.DB.prepare(
        "DELETE FROM qc_defects WHERE qcInspectionId = ?",
      )
        .bind(id)
        .run();
      if (body.defects.length) {
        const stmts = body.defects.map((d: Record<string, unknown>) =>
          c.var.DB.prepare(
            "INSERT INTO qc_defects (id, qcInspectionId, type, severity, description, actionTaken) VALUES (?, ?, ?, ?, ?, ?)",
          ).bind(
            (d.id as string) || genId("qcd"),
            id,
            (d.type as string) ?? "OTHER",
            (d.severity as string) ?? "MINOR",
            (d.description as string) ?? "",
            (d.actionTaken as string) ?? "ACCEPT",
          ),
        );
        await c.var.DB.batch(stmts);
      }
    }

    if (body.addDefect) {
      const d = body.addDefect as Record<string, unknown>;
      await c.var.DB.prepare(
        "INSERT INTO qc_defects (id, qcInspectionId, type, severity, description, actionTaken) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(
          genId("qcd"),
          id,
          (d.type as string) ?? "OTHER",
          (d.severity as string) ?? "MINOR",
          (d.description as string) ?? "",
          (d.actionTaken as string) ?? "ACCEPT",
        )
        .run();
    }

    const [updated, defs] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM qc_inspections WHERE id = ?")
        .bind(id)
        .first<InspectionRow>(),
      c.var.DB.prepare("SELECT * FROM qc_defects WHERE qcInspectionId = ?")
        .bind(id)
        .all<DefectRow>(),
    ]);
    if (!updated) {
      return c.json({ success: false, error: "QC inspection not found" }, 404);
    }
    return c.json({
      success: true,
      data: rowToInspection(updated, defs.results ?? []),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/qc-inspections/:id
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const [row, defs] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM qc_inspections WHERE id = ?")
      .bind(id)
      .first<InspectionRow>(),
    c.var.DB.prepare("SELECT * FROM qc_defects WHERE qcInspectionId = ?")
      .bind(id)
      .all<DefectRow>(),
  ]);
  if (!row) {
    return c.json({ success: false, error: "QC inspection not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM qc_inspections WHERE id = ?")
    .bind(id)
    .run();
  // qc_defects cascades via FK
  return c.json({
    success: true,
    data: rowToInspection(row, defs.results ?? []),
  });
});

export default app;
