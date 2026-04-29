// ---------------------------------------------------------------------------
// D1-backed R&D Projects route.
//
// Uses rd_projects table (already in 0001_init.sql). Complex nested fields
// (assignedTeam, milestones, productionBOM, materialIssuances, labourLogs,
// prototypes) are stored as JSON TEXT. Prototypes get their own table row
// but we load them through a separate SELECT for list endpoints.
//
// Material issuances deduct from raw_materials.balanceQty inline.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type ProjectRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  projectType: string | null;
  productCategory: string | null;
  serviceId: string | null;
  currentStage: string | null;
  targetLaunchDate: string | null;
  assignedTeam: string | null;
  totalBudget: number;
  actualCost: number;
  milestones: string | null;
  productionBOM: string | null;
  materialIssuances: string | null;
  labourLogs: string | null;
  sourceProductName: string | null;
  sourceBrand: string | null;
  sourcePurchaseRef: string | null;
  sourcePriceSen: number | null;
  sourceNotes: string | null;
  coverPhotoUrl: string | null;
  createdDate: string | null;
  status: string | null;
};

type PrototypeRow = {
  id: string;
  projectId: string;
  prototypeType: string | null;
  version: string;
  description: string | null;
  materialsCost: number;
  labourHours: number;
  testResults: string | null;
  feedback: string | null;
  improvements: string | null;
  defects: string | null;
  createdDate: string | null;
};

type RawMaterialRow = {
  id: string;
  itemCode: string;
  description: string;
  itemGroup: string;
  baseUOM: string;
  balanceQty: number;
};

function parseJSON<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function rowToProject(row: ProjectRow, prototypes: PrototypeRow[] = []) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? "",
    projectType: row.projectType ?? "DEVELOPMENT",
    productCategory: row.productCategory ?? "BEDFRAME",
    serviceId: row.serviceId ?? undefined,
    currentStage: row.currentStage ?? "CONCEPT",
    targetLaunchDate: row.targetLaunchDate ?? "",
    assignedTeam: parseJSON<string[]>(row.assignedTeam, []),
    totalBudget: row.totalBudget,
    actualCost: row.actualCost,
    milestones: parseJSON<unknown[]>(row.milestones, []),
    productionBOM: row.productionBOM
      ? parseJSON<unknown[]>(row.productionBOM, [])
      : undefined,
    materialIssuances: parseJSON<unknown[]>(row.materialIssuances, []),
    labourLogs: parseJSON<unknown[]>(row.labourLogs, []),
    sourceProductName: row.sourceProductName ?? "",
    sourceBrand: row.sourceBrand ?? "",
    sourcePurchaseRef: row.sourcePurchaseRef ?? "",
    sourcePriceSen: row.sourcePriceSen ?? null,
    sourceNotes: row.sourceNotes ?? "",
    coverPhotoUrl: row.coverPhotoUrl ?? null,
    prototypes: prototypes
      .filter((p) => p.projectId === row.id)
      .map((p) => ({
        id: p.id,
        projectId: p.projectId,
        prototypeType: p.prototypeType ?? "FABRIC_SEWING",
        version: p.version,
        description: p.description ?? "",
        materialsCost: p.materialsCost,
        labourHours: p.labourHours,
        testResults: p.testResults ?? "",
        feedback: p.feedback ?? "",
        improvements: p.improvements ?? "",
        defects: p.defects ?? "",
        createdDate: p.createdDate ?? "",
      })),
    createdDate: row.createdDate ?? "",
    status: row.status ?? "ACTIVE",
  };
}

function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function estimateFIFOCost(_itemCode: string, itemGroup: string): number {
  const groupCosts: Record<string, number> = {
    PLYWOOD: 4500,
    "B.M-FABR": 2500,
    "S.M-FABR": 3000,
    "B.OTHERS": 800,
    EQUIPMEN: 5000,
    SPONGE: 1500,
  };
  return groupCosts[itemGroup] ?? 2000;
}

// GET /api/rd-projects
app.get("/", async (c) => {
  const status = c.req.query("status");
  const stage = c.req.query("stage");
  const clauses: string[] = [];
  const params: string[] = [];
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (stage) {
    clauses.push("currentStage = ?");
    params.push(stage);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const [projRes, protoRes] = await Promise.all([
    c.var.DB.prepare(`SELECT * FROM rd_projects ${where}`)
      .bind(...params)
      .all<ProjectRow>(),
    c.var.DB.prepare("SELECT * FROM rd_prototypes").all<PrototypeRow>(),
  ]);
  const data = (projRes.results ?? []).map((r) =>
    rowToProject(r, protoRes.results ?? []),
  );
  return c.json({ success: true, data });
});

// POST /api/rd-projects
app.post("/", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { name, productCategory } = body;
    if (!name || !productCategory) {
      return c.json(
        { success: false, error: "name and productCategory are required" },
        400,
      );
    }

    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const countRes = await c.var.DB.prepare(
      "SELECT COUNT(*) as n FROM rd_projects",
    ).first<{ n: number }>();
    const seq = String((countRes?.n ?? 0) + 1).padStart(3, "0");
    const code = `RD-${yy}${mm}-${seq}`;

    const stages = [
      "CONCEPT",
      "DESIGN",
      "PROTOTYPE",
      "TESTING",
      "APPROVED",
      "PRODUCTION_READY",
    ];
    const milestones = stages.map((stage) => ({
      stage,
      targetDate: "",
      actualDate: null,
      approvedBy: null,
    }));

    const id = genId("rd");

    await c.var.DB.prepare(
      `INSERT INTO rd_projects (id, code, name, description, projectType, productCategory,
         serviceId, currentStage, targetLaunchDate, assignedTeam, totalBudget, actualCost,
         milestones, productionBOM, materialIssuances, labourLogs,
         sourceProductName, sourceBrand, sourcePurchaseRef, sourcePriceSen,
         sourceNotes, coverPhotoUrl, createdDate, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        code,
        name,
        body.description ?? "",
        body.projectType ?? "DEVELOPMENT",
        productCategory,
        body.serviceId ?? null,
        "CONCEPT",
        body.targetLaunchDate ?? "",
        JSON.stringify(body.assignedTeam ?? []),
        body.totalBudget ?? 0,
        0,
        JSON.stringify(milestones),
        null,
        JSON.stringify([]),
        JSON.stringify([]),
        body.sourceProductName ?? null,
        body.sourceBrand ?? null,
        body.sourcePurchaseRef ?? null,
        body.sourcePriceSen ?? null,
        body.sourceNotes ?? null,
        body.coverPhotoUrl ?? null,
        now.toISOString(),
        "ACTIVE",
      )
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM rd_projects WHERE id = ?",
    )
      .bind(id)
      .first<ProjectRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create R&D project" },
        500,
      );
    }
    return c.json({ success: true, data: rowToProject(created, []) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/rd-projects/:id
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [row, protos] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM rd_projects WHERE id = ?")
      .bind(id)
      .first<ProjectRow>(),
    c.var.DB.prepare("SELECT * FROM rd_prototypes WHERE projectId = ?")
      .bind(id)
      .all<PrototypeRow>(),
  ]);
  if (!row) {
    return c.json({ success: false, error: "R&D project not found" }, 404);
  }
  return c.json({
    success: true,
    data: rowToProject(row, protos.results ?? []),
  });
});

// PUT /api/rd-projects/:id
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM rd_projects WHERE id = ?",
    )
      .bind(id)
      .first<ProjectRow>();
    if (!existing) {
      return c.json({ success: false, error: "R&D project not found" }, 404);
    }
    const body = await c.req.json();

    // ─── Reverse-cascade: detect deleted issuances and credit warehouse stock ──
    // When the SPA PUTs a shorter materialIssuances[] (issuance removed via
    // the UI's trash button), we need to emit a STOCK_IN counter-movement and
    // re-credit raw_materials.balance_qty. We compare by issuance.id.
    type IssuanceLite = {
      id?: string;
      materialId?: string;
      materialCode?: string;
      materialName?: string;
      qty?: number;
      issuedBy?: string;
      notes?: string;
    };
    if (body.materialIssuances !== undefined && Array.isArray(body.materialIssuances)) {
      const previousIssuances = parseJSON<IssuanceLite[]>(
        existing.materialIssuances,
        [],
      );
      const nextIds = new Set<string>(
        (body.materialIssuances as IssuanceLite[])
          .map((i) => i.id)
          .filter((x): x is string => typeof x === "string"),
      );
      const removed = previousIssuances.filter(
        (i) => i.id && !nextIds.has(i.id),
      );
      const nowIso = new Date().toISOString();
      for (const r of removed) {
        if (!r.materialId || !r.qty || r.qty <= 0) continue;
        // Re-credit balance_qty
        await c.var.DB.prepare(
          "UPDATE raw_materials SET balanceQty = balanceQty + ? WHERE id = ?",
        )
          .bind(r.qty, r.materialId)
          .run();
        // Counter-movement (STOCK_IN) so audit trail balances
        await c.var.DB.prepare(
          `INSERT INTO stock_movements (id, type, productCode, productName,
             quantity, reason, performedBy, created_at)
           VALUES (?, 'STOCK_IN', ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            `mv-rev-${r.id}`,
            r.materialCode ?? "",
            r.materialName ?? "",
            r.qty,
            `R&D ${existing.code} issuance reversed (id=${r.id})`,
            r.issuedBy ?? "System",
            nowIso,
          )
          .run();
      }
    }

    const merged = {
      name: body.name ?? existing.name,
      description: body.description ?? existing.description ?? "",
      projectType: body.projectType ?? existing.projectType,
      serviceId:
        body.serviceId !== undefined ? body.serviceId : existing.serviceId,
      productCategory: body.productCategory ?? existing.productCategory,
      currentStage: body.currentStage ?? existing.currentStage,
      targetLaunchDate: body.targetLaunchDate ?? existing.targetLaunchDate ?? "",
      assignedTeam: body.assignedTeam
        ? JSON.stringify(body.assignedTeam)
        : existing.assignedTeam,
      totalBudget: body.totalBudget ?? existing.totalBudget,
      // When materialIssuances changes (e.g., issuance removed), recompute
      // actualCost from the new array so the budget cards stay in sync.
      actualCost:
        body.actualCost !== undefined
          ? body.actualCost
          : Array.isArray(body.materialIssuances)
          ? (body.materialIssuances as Array<{ totalCostSen?: number }>).reduce(
              (sum, i) =>
                sum + (typeof i.totalCostSen === "number" ? i.totalCostSen : 0),
              0,
            )
          : existing.actualCost,
      milestones: body.milestones
        ? JSON.stringify(body.milestones)
        : existing.milestones,
      productionBOM:
        body.productionBOM !== undefined
          ? body.productionBOM === null
            ? null
            : JSON.stringify(body.productionBOM)
          : existing.productionBOM,
      materialIssuances:
        body.materialIssuances !== undefined
          ? JSON.stringify(body.materialIssuances)
          : existing.materialIssuances,
      labourLogs:
        body.labourLogs !== undefined
          ? JSON.stringify(body.labourLogs)
          : existing.labourLogs,
      sourceProductName:
        body.sourceProductName !== undefined
          ? body.sourceProductName
          : existing.sourceProductName,
      sourceBrand:
        body.sourceBrand !== undefined
          ? body.sourceBrand
          : existing.sourceBrand,
      sourcePurchaseRef:
        body.sourcePurchaseRef !== undefined
          ? body.sourcePurchaseRef
          : existing.sourcePurchaseRef,
      sourcePriceSen:
        body.sourcePriceSen !== undefined
          ? body.sourcePriceSen
          : existing.sourcePriceSen,
      sourceNotes:
        body.sourceNotes !== undefined
          ? body.sourceNotes
          : existing.sourceNotes,
      coverPhotoUrl:
        body.coverPhotoUrl !== undefined
          ? body.coverPhotoUrl
          : existing.coverPhotoUrl,
      status: body.status ?? existing.status,
    };

    await c.var.DB.prepare(
      `UPDATE rd_projects SET
         name = ?, description = ?, projectType = ?, serviceId = ?,
         productCategory = ?, currentStage = ?, targetLaunchDate = ?,
         assignedTeam = ?, totalBudget = ?, actualCost = ?,
         milestones = ?, productionBOM = ?, materialIssuances = ?,
         labourLogs = ?, sourceProductName = ?, sourceBrand = ?,
         sourcePurchaseRef = ?, sourcePriceSen = ?, sourceNotes = ?,
         coverPhotoUrl = ?, status = ?
       WHERE id = ?`,
    )
      .bind(
        merged.name,
        merged.description,
        merged.projectType,
        merged.serviceId,
        merged.productCategory,
        merged.currentStage,
        merged.targetLaunchDate,
        merged.assignedTeam,
        merged.totalBudget,
        merged.actualCost,
        merged.milestones,
        merged.productionBOM,
        merged.materialIssuances,
        merged.labourLogs,
        merged.sourceProductName,
        merged.sourceBrand,
        merged.sourcePurchaseRef,
        merged.sourcePriceSen,
        merged.sourceNotes,
        merged.coverPhotoUrl,
        merged.status,
        id,
      )
      .run();

    const [updated, protos] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM rd_projects WHERE id = ?")
        .bind(id)
        .first<ProjectRow>(),
      c.var.DB.prepare("SELECT * FROM rd_prototypes WHERE projectId = ?")
        .bind(id)
        .all<PrototypeRow>(),
    ]);
    if (!updated) {
      return c.json({ success: false, error: "R&D project not found" }, 404);
    }
    return c.json({
      success: true,
      data: rowToProject(updated, protos.results ?? []),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// POST /api/rd-projects/:id/issue-material
app.post("/:id/issue-material", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "create");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const project = await c.var.DB.prepare(
      "SELECT * FROM rd_projects WHERE id = ?",
    )
      .bind(id)
      .first<ProjectRow>();
    if (!project) {
      return c.json({ success: false, error: "R&D project not found" }, 404);
    }
    const body = await c.req.json();
    const { materialId, qty, issuedBy, notes } = body;
    if (!materialId || !qty || qty <= 0) {
      return c.json(
        { success: false, error: "materialId and qty > 0 are required" },
        400,
      );
    }

    const rm = await c.var.DB.prepare(
      "SELECT id, itemCode, description, itemGroup, baseUOM, balanceQty FROM raw_materials WHERE id = ?",
    )
      .bind(materialId)
      .first<RawMaterialRow>();
    if (!rm) {
      return c.json({ success: false, error: "Raw material not found" }, 404);
    }
    if (rm.balanceQty < qty) {
      return c.json(
        {
          success: false,
          error: `Insufficient stock. Available: ${rm.balanceQty} ${rm.baseUOM}`,
        },
        400,
      );
    }

    // Snapshot the price at issuance time. Falls back to FIFO estimate when
    // the client didn't provide one. The snapshot is stored on the issuance
    // record itself (JSON), so historical entries keep their accurate cost
    // even if the raw_materials catalog price is later edited.
    const unitCostSen =
      body.unitCostSen ?? estimateFIFOCost(rm.itemCode, rm.itemGroup);
    const totalCostSen = Math.round(unitCostSen * qty);
    const issuanceId = genId("rdiss");
    const nowIso = new Date().toISOString();

    // 1. Deduct raw material stock (warehouse balance must drop on issuance)
    await c.var.DB.prepare(
      "UPDATE raw_materials SET balanceQty = balanceQty - ? WHERE id = ?",
    )
      .bind(qty, materialId)
      .run();

    // 2. Audit ledger: write a STOCK_OUT movement so warehouse history shows
    //    where the material went. Mirrors the pattern used in stock-adjustments.
    await c.var.DB.prepare(
      `INSERT INTO stock_movements (id, type, productCode, productName,
         quantity, reason, performedBy, created_at)
       VALUES (?, 'STOCK_OUT', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        `mv-${issuanceId}`,
        rm.itemCode,
        rm.description,
        qty,
        `R&D ${project.code} issuance${notes ? " — " + notes : ""}`,
        issuedBy ?? "System",
        nowIso,
      )
      .run();

    // 3. Append issuance to JSON column with the snapshotted price
    const existingIssuances = parseJSON<Record<string, unknown>[]>(
      project.materialIssuances,
      [],
    );
    const issuance = {
      id: issuanceId,
      rdProjectId: project.id,
      rdProjectCode: project.code,
      materialId: rm.id,
      materialCode: rm.itemCode,
      materialName: rm.description,
      qty,
      unit: rm.baseUOM,
      unitCostSen,
      totalCostSen,
      issuedDate: nowIso.slice(0, 10),
      issuedBy: issuedBy ?? "System",
      notes: notes ?? "",
    };
    const nextIssuances = [...existingIssuances, issuance];
    const nextActualCost = nextIssuances.reduce(
      (sum, i) =>
        sum + (typeof i.totalCostSen === "number" ? i.totalCostSen : 0),
      0,
    );

    await c.var.DB.prepare(
      "UPDATE rd_projects SET materialIssuances = ?, actualCost = ? WHERE id = ?",
    )
      .bind(JSON.stringify(nextIssuances), nextActualCost, id)
      .run();

    const [updated, protos] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM rd_projects WHERE id = ?")
        .bind(id)
        .first<ProjectRow>(),
      c.var.DB.prepare("SELECT * FROM rd_prototypes WHERE projectId = ?")
        .bind(id)
        .all<PrototypeRow>(),
    ]);
    if (!updated) {
      return c.json({ success: false, error: "R&D project not found" }, 404);
    }
    return c.json({
      success: true,
      data: {
        issuance,
        project: rowToProject(updated, protos.results ?? []),
      },
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// POST /api/rd-projects/:id/labour-log
app.post("/:id/labour-log", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "create");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const project = await c.var.DB.prepare(
      "SELECT * FROM rd_projects WHERE id = ?",
    )
      .bind(id)
      .first<ProjectRow>();
    if (!project) {
      return c.json({ success: false, error: "R&D project not found" }, 404);
    }
    const body = await c.req.json();
    const { workerName, hours, date, description, department } = body;
    if (!workerName || !hours || hours <= 0 || !date) {
      return c.json(
        {
          success: false,
          error: "workerName, hours > 0, and date are required",
        },
        400,
      );
    }

    const existingLogs = parseJSON<Record<string, unknown>[]>(
      project.labourLogs,
      [],
    );
    const log = {
      id: genId("rdlog"),
      rdProjectId: project.id,
      workerName,
      department: department ?? "R&D",
      hours,
      date,
      description: description ?? "",
    };
    const nextLogs = [...existingLogs, log];

    await c.var.DB.prepare(
      "UPDATE rd_projects SET labourLogs = ? WHERE id = ?",
    )
      .bind(JSON.stringify(nextLogs), id)
      .run();

    const [updated, protos] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM rd_projects WHERE id = ?")
        .bind(id)
        .first<ProjectRow>(),
      c.var.DB.prepare("SELECT * FROM rd_prototypes WHERE projectId = ?")
        .bind(id)
        .all<PrototypeRow>(),
    ]);
    if (!updated) {
      return c.json({ success: false, error: "R&D project not found" }, 404);
    }
    return c.json({
      success: true,
      data: { log, project: rowToProject(updated, protos.results ?? []) },
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/rd-projects/:id
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const [row, protos] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM rd_projects WHERE id = ?")
      .bind(id)
      .first<ProjectRow>(),
    c.var.DB.prepare("SELECT * FROM rd_prototypes WHERE projectId = ?")
      .bind(id)
      .all<PrototypeRow>(),
  ]);
  if (!row) {
    return c.json({ success: false, error: "R&D project not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM rd_projects WHERE id = ?")
    .bind(id)
    .run();
  return c.json({
    success: true,
    data: rowToProject(row, protos.results ?? []),
  });
});

export default app;
