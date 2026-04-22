// ---------------------------------------------------------------------------
// D1-backed QC Inspections route.
//
// Uses qc_inspections + qc_defects tables (already in 0001_init.sql).
// Schema stores `created_at` snake; API returns `createdAt` camel.
// Defects join nested under each inspection — matches the old mock shape.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

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
  created_at: string | null;
};

type DefectRow = {
  id: string;
  qcInspectionId: string;
  type: string | null;
  severity: string | null;
  description: string | null;
  actionTaken: string | null;
};

function rowToInspection(row: InspectionRow, defects: DefectRow[] = []) {
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
    createdAt: row.created_at ?? "",
    defects: defects
      .filter((d) => d.qcInspectionId === row.id)
      .map((d) => ({
        id: d.id,
        type: d.type ?? "OTHER",
        severity: d.severity ?? "MINOR",
        description: d.description ?? "",
        actionTaken: d.actionTaken ?? "ACCEPT",
      })),
  };
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
app.get("/", async (c) => {
  const department = c.req.query("department");
  const result = c.req.query("result");
  const dateFrom = c.req.query("dateFrom");
  const dateTo = c.req.query("dateTo");

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
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT * FROM qc_inspections ${where} ORDER BY created_at DESC`;

  const [inspRes, defRes] = await Promise.all([
    c.env.DB.prepare(sql)
      .bind(...params)
      .all<InspectionRow>(),
    c.env.DB.prepare("SELECT * FROM qc_defects").all<DefectRow>(),
  ]);
  const data = (inspRes.results ?? []).map((r) =>
    rowToInspection(r, defRes.results ?? []),
  );
  return c.json({ success: true, data, total: data.length });
});

// POST /api/qc-inspections
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const id = genId("qc");
    const inspectionNo = await getNextQCNo(c.env.DB);
    const createdAt = new Date().toISOString();
    const inspectionDate =
      body.inspectionDate || new Date().toISOString().split("T")[0];

    await c.env.DB.prepare(
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
        return c.env.DB.prepare(
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
      await c.env.DB.batch(stmts);
    }

    const created = await c.env.DB.prepare(
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
  const [row, defs] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM qc_inspections WHERE id = ?")
      .bind(id)
      .first<InspectionRow>(),
    c.env.DB.prepare("SELECT * FROM qc_defects WHERE qcInspectionId = ?")
      .bind(id)
      .all<DefectRow>(),
  ]);
  if (!row) {
    return c.json({ success: false, error: "QC inspection not found" }, 404);
  }
  return c.json({
    success: true,
    data: rowToInspection(row, defs.results ?? []),
  });
});

// PUT /api/qc-inspections/:id
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await c.env.DB.prepare(
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
    await c.env.DB.prepare(
      "UPDATE qc_inspections SET result = ?, notes = ?, department = ? WHERE id = ?",
    )
      .bind(merged.result, merged.notes, merged.department, id)
      .run();

    // Defects replace on full array
    if (Array.isArray(body.defects)) {
      await c.env.DB.prepare(
        "DELETE FROM qc_defects WHERE qcInspectionId = ?",
      )
        .bind(id)
        .run();
      if (body.defects.length) {
        const stmts = body.defects.map((d: Record<string, unknown>) =>
          c.env.DB.prepare(
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
        await c.env.DB.batch(stmts);
      }
    }

    if (body.addDefect) {
      const d = body.addDefect as Record<string, unknown>;
      await c.env.DB.prepare(
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
      c.env.DB.prepare("SELECT * FROM qc_inspections WHERE id = ?")
        .bind(id)
        .first<InspectionRow>(),
      c.env.DB.prepare("SELECT * FROM qc_defects WHERE qcInspectionId = ?")
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
  const id = c.req.param("id");
  const [row, defs] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM qc_inspections WHERE id = ?")
      .bind(id)
      .first<InspectionRow>(),
    c.env.DB.prepare("SELECT * FROM qc_defects WHERE qcInspectionId = ?")
      .bind(id)
      .all<DefectRow>(),
  ]);
  if (!row) {
    return c.json({ success: false, error: "QC inspection not found" }, 404);
  }
  await c.env.DB.prepare("DELETE FROM qc_inspections WHERE id = ?")
    .bind(id)
    .run();
  // qc_defects cascades via FK
  return c.json({
    success: true,
    data: rowToInspection(row, defs.results ?? []),
  });
});

export default app;
