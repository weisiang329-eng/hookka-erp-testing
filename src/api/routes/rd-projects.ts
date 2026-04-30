// ---------------------------------------------------------------------------
// D1-backed R&D Projects route.
//
// Uses rd_projects table (already in 0001_init.sql). Nested fields
// (assignedTeam, milestones, productionBOM, labourLogs) are still JSON TEXT
// on the row. Prototypes get their own table row.
//
// Material issuances are owned by rd_material_issuances (migration 0092);
// they deduct from raw_materials.balanceQty inline. The legacy JSON column
// rd_projects.material_issuances is no longer written or read by this file
// (see migration 0095 for the one-shot backfill before the cutover).
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
  startedAt: string | null;
  manualLabourCostSen: number | null;
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

// Shape of the labour-cost summary surfaced on every project GET. The
// frontend consumes `effectiveLabourCostSen` for the budget card and
// `isManualLabourCost` for the "Manual" badge; the raw inputs (auto, manual,
// PT fixed) are exposed so the override dialog can reset cleanly.
type LabourCostSummary = {
  // Sum of (hours * hourlyRateSen) across FT-member rd_labour_hours rows.
  laborCostSen: number;
  // Flat sum across DISTINCT PT members who logged any hours on this
  // project. PT cost is NOT pro-rated per hour — see the comment on the
  // computeLabourCostSummary() function for the rule.
  partTimeFixedCostSen: number;
  // The user's typed override (sen). null when not overridden.
  manualLabourCostSen: number | null;
  // The value the budget card should display: manual override if set,
  // otherwise laborCostSen.
  effectiveLabourCostSen: number;
  isManualLabourCost: boolean;
  totalLabourHours: number;
};

const ZERO_LABOUR_SUMMARY: LabourCostSummary = {
  laborCostSen: 0,
  partTimeFixedCostSen: 0,
  manualLabourCostSen: null,
  effectiveLabourCostSen: 0,
  isManualLabourCost: false,
  totalLabourHours: 0,
};

function rowToProject(
  row: ProjectRow,
  prototypes: PrototypeRow[] = [],
  labourSummary: LabourCostSummary = ZERO_LABOUR_SUMMARY,
) {
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
    manualLabourCostSen: row.manualLabourCostSen ?? null,
    labourCost: labourSummary,
    milestones: parseJSON<unknown[]>(row.milestones, []),
    productionBOM: row.productionBOM
      ? parseJSON<unknown[]>(row.productionBOM, [])
      : undefined,
    // materialIssuances is no longer surfaced on the project payload —
    // callers must use GET /api/rd-projects/:id/issuances (table-backed).
    // The legacy JSON column on the row stays untouched for backfill safety
    // (see migration 0095) but is never read or returned anymore.
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
    // Default DRAFT (instead of ACTIVE) so a row with NULL status — old or
    // newly-inserted-without-status — surfaces in the Drafts tab where
    // it can't accidentally land in the live Pipeline. Migration 0090
    // also flips the column default to 'DRAFT' at the DB layer.
    status: row.status ?? "DRAFT",
    startedAt: row.startedAt ?? null,
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

// Resolve the FIFO unit cost (sen) for a raw material — the price of the
// OLDEST rm_batches row that still has remaining stock. This matches what the
// Inventory page surfaces ("the cost shown in Inventory at issue time"): the
// shop's mental model is that R&D draws from the oldest batch first, and the
// issuance record snapshots THAT price.
//
// If a single issuance qty exceeds the oldest batch's remaining_qty, we still
// just snapshot the oldest batch's unit_cost — we don't try to compute a
// weighted-average across batches. This keeps the model simple and matches
// the user's intent ("拿了什么资料，你就直接记录下来当时的价钱").
//
// Falls back to the itemGroup heuristic in estimateFIFOCost() when the
// material has no positive batches (e.g. opening-balance items that pre-date
// GRN posting).
type DbBindable = {
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => {
      all: <T>() => Promise<{ results: T[] | null }>;
      first: <T>() => Promise<T | null>;
    };
  };
};

// ---------------------------------------------------------------------------
// computeLabourCostSummary — derive the labour-cost summary for a project
// from rd_labour_hours + rd_team_members. Cost rules:
//
//   * FULL_TIME members: each rd_labour_hours row contributes
//       hours * teamMember.hourlyRateSen
//     to laborCostSen. This is the auto-computed labour cost the user
//     sees on the budget card.
//
//   * PART_TIME members: each rd_labour_hours row contributes ZERO to
//     laborCostSen (the per-hour bucket). PT folks are billed as a flat
//     monthly retainer, not a per-hour cost — pro-rating their fixed cost
//     per hour would silently allocate the same monthlyFixedCostSen across
//     every project they touched in a month, which is exactly the kind of
//     fake precision the user said they don't want.
//
//     Instead, partTimeFixedCostSen is the SUM of monthlyFixedCostSen
//     across DISTINCT PT members who logged any hours on this project.
//     This is shown as a separate "Total Fixed Cost" line on the budget
//     card. (Trade-off: a PT member who logs hours on two projects in the
//     same month gets counted on both. The user explicitly accepted this:
//     it's an upper-bound overhead figure, not a precise allocation.)
//
//   * Manual override: rd_projects.manual_labour_cost_sen, when not NULL,
//     wins over laborCostSen for the displayed labour cost. The PATCH
//     /:id/labour-cost endpoint sets / clears it.
//
// Returns ZERO_LABOUR_SUMMARY shape (with manualLabourCostSen propagated)
// even when the project has no logged hours yet.
async function computeLabourCostSummary(
  db: DbBindable,
  projectId: string,
  manualLabourCostSen: number | null,
): Promise<LabourCostSummary> {
  type RowJoin = {
    hours: number;
    employmentType: "FULL_TIME" | "PART_TIME";
    hourlyRateSen: number | null;
    monthlyFixedCostSen: number | null;
    teamMemberId: string;
  };
  let rows: { results: RowJoin[] | null } = { results: [] };
  try {
    rows = await db
      .prepare(
        `SELECT lh.hours        AS "hours",
                tm.employmentType AS "employmentType",
                tm.hourlyRateSen  AS "hourlyRateSen",
                tm.monthlyFixedCostSen AS "monthlyFixedCostSen",
                lh.teamMemberId   AS "teamMemberId"
           FROM rd_labour_hours lh
           JOIN rd_team_members tm ON tm.id = lh.teamMemberId
          WHERE lh.projectId = ?`,
      )
      .bind(projectId)
      .all<RowJoin>();
  } catch {
    // Table missing (migration 0098 not yet applied) → degrade gracefully
    // to a zeroed summary. The frontend stays usable; once the migration
    // lands the next request fills in real data.
    return {
      ...ZERO_LABOUR_SUMMARY,
      manualLabourCostSen: manualLabourCostSen ?? null,
      effectiveLabourCostSen:
        typeof manualLabourCostSen === "number" ? manualLabourCostSen : 0,
      isManualLabourCost: manualLabourCostSen !== null,
    };
  }
  let laborCostSen = 0;
  let totalLabourHours = 0;
  // Track DISTINCT PT members so each one's fixed cost is counted at most
  // once per project (see comment block above).
  const ptMembers = new Map<string, number>();
  for (const r of rows.results ?? []) {
    const hrs = typeof r.hours === "number" ? r.hours : Number(r.hours) || 0;
    totalLabourHours += hrs;
    if (r.employmentType === "FULL_TIME") {
      const rate = typeof r.hourlyRateSen === "number" ? r.hourlyRateSen : 0;
      laborCostSen += Math.round(hrs * rate);
    } else if (r.employmentType === "PART_TIME") {
      const fixed =
        typeof r.monthlyFixedCostSen === "number" ? r.monthlyFixedCostSen : 0;
      ptMembers.set(r.teamMemberId, fixed);
    }
  }
  let partTimeFixedCostSen = 0;
  for (const fixed of ptMembers.values()) partTimeFixedCostSen += fixed;
  const isManual = manualLabourCostSen !== null;
  return {
    laborCostSen,
    partTimeFixedCostSen,
    manualLabourCostSen: manualLabourCostSen ?? null,
    effectiveLabourCostSen: isManual
      ? (manualLabourCostSen ?? 0)
      : laborCostSen,
    isManualLabourCost: isManual,
    totalLabourHours: Math.round(totalLabourHours * 100) / 100,
  };
}

async function resolveFifoUnitCostSen(
  db: DbBindable,
  rmId: string,
  itemCode: string,
  itemGroup: string,
): Promise<number> {
  // Oldest batch with positive remaining qty wins. The Inventory drilldown
  // (GET /api/inventory/rm-source/:rmId) orders by `receivedDate ASC, id ASC`
  // for the same FIFO semantics — we mirror that here.
  const row = await db
    .prepare(
      `SELECT unitCostSen
         FROM rm_batches
        WHERE rmId = ? AND remainingQty > 0
        ORDER BY receivedDate ASC, id ASC
        LIMIT 1`,
    )
    .bind(rmId)
    .first<{ unitCostSen: number }>();
  if (row && Number.isFinite(row.unitCostSen)) {
    return row.unitCostSen;
  }
  return estimateFIFOCost(itemCode, itemGroup);
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
        // New projects start in DRAFT (idea backlog) per migration 0090.
        // The shop owner clicks "开启项目 / Start Project" on the Drafts
        // tab to flip status DRAFT→ACTIVE, which is when it enters the
        // live Pipeline kanban.
        "DRAFT",
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
  const labourSummary = await computeLabourCostSummary(
    c.var.DB,
    row.id,
    row.manualLabourCostSen ?? null,
  );
  return c.json({
    success: true,
    data: rowToProject(row, protos.results ?? [], labourSummary),
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

    // Note: prior versions of this handler watched body.materialIssuances for
    // a shorter array (SPA-side trash-button removal) and emitted reversal
    // STOCK_IN movements. That path is gone — all issuance create / delete
    // now flows through POST/DELETE /:id/issuances on the dedicated table.
    // The legacy JSON column is no longer written here either.

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
      // actualCost is owned by the issuance endpoints (POST/DELETE
      // /:id/issuances) which recompute it from rd_material_issuances on
      // every write. PUT only honours an explicit body.actualCost (rare,
      // mostly for migrations / admin tooling); body.materialIssuances is
      // ignored — see note above re: dual-write removal.
      actualCost:
        body.actualCost !== undefined ? body.actualCost : existing.actualCost,
      milestones: body.milestones
        ? JSON.stringify(body.milestones)
        : existing.milestones,
      productionBOM:
        body.productionBOM !== undefined
          ? body.productionBOM === null
            ? null
            : JSON.stringify(body.productionBOM)
          : existing.productionBOM,
      // materialIssuances JSON column is no longer written. Preserve whatever
      // is already on the row (read by rowToProject for back-compat display
      // until migration 0095 backfills + a future migration drops the column).
      materialIssuances: existing.materialIssuances,
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

    // Sync rd_prototypes from body.prototypes when provided. Migration moved
    // prototypes off the JSON column into the dedicated table, but the PUT
    // handler never wrote to that table — so the SPA's "Add Prototype" call
    // was dropped on the floor (success toast, no record). Upsert by id so
    // both add (new id) and edit (existing id) flows land. We don't delete
    // missing rows because the UI has no delete-prototype affordance.
    if (Array.isArray(body.prototypes)) {
      for (const p of body.prototypes as Array<Record<string, unknown>>) {
        if (!p || typeof p !== "object" || typeof p.id !== "string") continue;
        await c.var.DB.prepare(
          `INSERT INTO rd_prototypes
             (id, projectId, prototypeType, version, description,
              materialsCost, labourHours, testResults, feedback,
              improvements, defects, createdDate, orgId)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             prototypeType = excluded.prototypeType,
             version = excluded.version,
             description = excluded.description,
             materialsCost = excluded.materialsCost,
             labourHours = excluded.labourHours,
             testResults = excluded.testResults,
             feedback = excluded.feedback,
             improvements = excluded.improvements,
             defects = excluded.defects,
             createdDate = excluded.createdDate`,
        )
          .bind(
            p.id,
            id,
            (p.prototypeType as string | null) ?? "FABRIC_SEWING",
            (p.version as string | null) ?? "v1",
            (p.description as string | null) ?? "",
            typeof p.materialsCost === "number" ? p.materialsCost : 0,
            typeof p.labourHours === "number" ? p.labourHours : 0,
            (p.testResults as string | null) ?? "",
            (p.feedback as string | null) ?? "",
            (p.improvements as string | null) ?? "",
            (p.defects as string | null) ?? "",
            (p.createdDate as string | null) ?? new Date().toISOString().slice(0, 10),
            "hookka",
          )
          .run();
      }
    }

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
    // Compute the labour-cost summary so the PUT response shape matches GET.
    // Without this the SPA's setProject(data.data) after a milestone-photo
    // save (or any other PUT) would clobber the labour summary with the
    // ZERO_LABOUR_SUMMARY default — flipping the budget card to "RM 0.00"
    // until a full refetch.
    const labourSummary = await computeLabourCostSummary(
      c.var.DB,
      updated.id,
      updated.manualLabourCostSen ?? null,
    );
    return c.json({
      success: true,
      data: rowToProject(updated, protos.results ?? [], labourSummary),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /api/rd-projects/:id/start
//
// Flip a DRAFT project to ACTIVE — i.e. "开启项目 / Start Project".
// Only DRAFT rows are eligible; once ACTIVE, the project shows up in the
// Pipeline kanban and the Projects tab. See migration 0090 for the
// lifecycle definition (DRAFT → ACTIVE → ON_HOLD/COMPLETED/CANCELLED).
//
// Reuses rd-projects:update permission — flipping status is a state
// edit, doesn't warrant a new permission row in the RBAC seed.
// ---------------------------------------------------------------------------
app.post("/:id/start", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "update");
  if (denied) return denied;
  const id = c.req.param("id");

  const existing = await c.var.DB.prepare(
    "SELECT * FROM rd_projects WHERE id = ?",
  )
    .bind(id)
    .first<ProjectRow>();
  if (!existing) {
    return c.json({ success: false, error: "R&D project not found" }, 404);
  }
  if (existing.status !== "DRAFT") {
    return c.json(
      {
        success: false,
        error: "Only DRAFT projects can be started",
      },
      400,
    );
  }

  const now = new Date().toISOString();
  await c.var.DB.prepare(
    `UPDATE rd_projects SET status = 'ACTIVE', started_at = ? WHERE id = ?`,
  )
    .bind(now, id)
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
});

// ---------------------------------------------------------------------------
// POST /api/rd-projects/:id/hold       — ACTIVE → ON_HOLD
// POST /api/rd-projects/:id/resume     — ON_HOLD → ACTIVE
// POST /api/rd-projects/:id/move-to-draft — ACTIVE | ON_HOLD → DRAFT
//
// Inverse-direction state flips. The user can pause an active project
// (hold) or send it back to the Drafts backlog. Each endpoint hard-codes
// the legal source statuses to keep transitions auditable; bad source
// returns 400 with a message naming the current state.
//
// Reuses rd-projects:update permission, same as POST /:id/start.
// ---------------------------------------------------------------------------
app.post("/:id/hold", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "update");
  if (denied) return denied;
  const id = c.req.param("id");

  const existing = await c.var.DB.prepare(
    "SELECT * FROM rd_projects WHERE id = ?",
  )
    .bind(id)
    .first<ProjectRow>();
  if (!existing) {
    return c.json({ success: false, error: "R&D project not found" }, 404);
  }
  if (existing.status !== "ACTIVE") {
    return c.json(
      {
        success: false,
        error: `Only ACTIVE projects can be put on hold (current: ${existing.status})`,
      },
      400,
    );
  }

  await c.var.DB.prepare(
    "UPDATE rd_projects SET status = 'ON_HOLD' WHERE id = ?",
  )
    .bind(id)
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
});

app.post("/:id/resume", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "update");
  if (denied) return denied;
  const id = c.req.param("id");

  const existing = await c.var.DB.prepare(
    "SELECT * FROM rd_projects WHERE id = ?",
  )
    .bind(id)
    .first<ProjectRow>();
  if (!existing) {
    return c.json({ success: false, error: "R&D project not found" }, 404);
  }
  if (existing.status !== "ON_HOLD") {
    return c.json(
      {
        success: false,
        error: `Only ON_HOLD projects can be resumed (current: ${existing.status})`,
      },
      400,
    );
  }

  await c.var.DB.prepare(
    "UPDATE rd_projects SET status = 'ACTIVE' WHERE id = ?",
  )
    .bind(id)
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
});

// POST /api/rd-projects/:id/complete — ACTIVE → COMPLETED
//
// Terminal state flip when an R&D project has reached PRODUCTION_READY and the
// shop owner is ready to ship it out of the active pipeline. Only ACTIVE
// projects whose currentStage is PRODUCTION_READY are eligible — any earlier
// stage is rejected with a clear error so the SPA's button-disable logic and
// the API agree on the rule. Reuses rd-projects:update permission like the
// other state flips above.
app.post("/:id/complete", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "update");
  if (denied) return denied;
  const id = c.req.param("id");

  const existing = await c.var.DB.prepare(
    "SELECT * FROM rd_projects WHERE id = ?",
  )
    .bind(id)
    .first<ProjectRow>();
  if (!existing) {
    return c.json({ success: false, error: "R&D project not found" }, 404);
  }
  if (existing.status !== "ACTIVE") {
    return c.json(
      {
        success: false,
        error: `Only ACTIVE projects can be completed (current: ${existing.status})`,
      },
      400,
    );
  }
  if (existing.currentStage !== "PRODUCTION_READY") {
    return c.json(
      {
        success: false,
        error: `Project must reach Production Ready before it can be completed (current stage: ${existing.currentStage})`,
      },
      400,
    );
  }

  await c.var.DB.prepare(
    "UPDATE rd_projects SET status = 'COMPLETED' WHERE id = ?",
  )
    .bind(id)
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
});

app.post("/:id/move-to-draft", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "update");
  if (denied) return denied;
  const id = c.req.param("id");

  const existing = await c.var.DB.prepare(
    "SELECT * FROM rd_projects WHERE id = ?",
  )
    .bind(id)
    .first<ProjectRow>();
  if (!existing) {
    return c.json({ success: false, error: "R&D project not found" }, 404);
  }
  if (existing.status !== "ACTIVE" && existing.status !== "ON_HOLD") {
    return c.json(
      {
        success: false,
        error: `Only ACTIVE or ON_HOLD projects can be moved back to draft (current: ${existing.status})`,
      },
      400,
    );
  }

  await c.var.DB.prepare(
    "UPDATE rd_projects SET status = 'DRAFT', started_at = NULL WHERE id = ?",
  )
    .bind(id)
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

    // Snapshot the price at issuance time. The unit cost is ALWAYS resolved
    // server-side from the FIFO oldest-batch unit_cost (rm_batches ORDER BY
    // received_date ASC) — the client no longer sends unitCostSen.
    // Snapshotting onto the issuance record means historical entries keep
    // their accurate cost even if the raw_materials catalog price is later
    // edited or new GRN batches arrive.
    const unitCostSen = await resolveFifoUnitCostSen(
      c.var.DB,
      rm.id,
      rm.itemCode,
      rm.itemGroup,
    );
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
    const stockMovementId = `mv-${issuanceId}`;
    await c.var.DB.prepare(
      `INSERT INTO stock_movements (id, type, productCode, productName,
         quantity, reason, performedBy, created_at)
       VALUES (?, 'STOCK_OUT', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        stockMovementId,
        rm.itemCode,
        rm.description,
        qty,
        `R&D ${project.code} issuance${notes ? " — " + notes : ""}`,
        issuedBy ?? "System",
        nowIso,
      )
      .run();

    // 3. Insert into the dedicated rd_material_issuances table (migration
    // 0092). This is now the SOLE write target — the legacy JSON column
    // (rd_projects.materialIssuances) is no longer written. The frontend
    // reads from GET /api/rd-projects/:id/issuances. Pre-0092 environments
    // are no longer supported by this handler.
    await c.var.DB.prepare(
      `INSERT INTO rd_material_issuances
         (id, projectId, rawMaterialId, materialCode, materialName,
          qty, unit, unitCostSen, totalCostSen, issuedAt, issuedBy,
          notes, stockMovementId, orgId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        issuanceId,
        project.id,
        rm.id,
        rm.itemCode,
        rm.description,
        qty,
        rm.baseUOM,
        unitCostSen,
        totalCostSen,
        nowIso.slice(0, 10),
        issuedBy ?? null,
        notes ?? null,
        stockMovementId,
        "hookka",
        nowIso,
      )
      .run();

    // 4. Recompute actualCost on the project from the table-backed sum so the
    // budget cards stay in sync. We don't read from materialIssuances JSON
    // anymore — sum directly from rd_material_issuances.
    const sumRow = await c.var.DB.prepare(
      `SELECT COALESCE(SUM(totalCostSen), 0) AS total
         FROM rd_material_issuances WHERE projectId = ?`,
    )
      .bind(id)
      .first<{ total: number }>();
    const nextActualCost = sumRow?.total ?? 0;
    await c.var.DB.prepare(
      "UPDATE rd_projects SET actualCost = ? WHERE id = ?",
    )
      .bind(nextActualCost, id)
      .run();

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

// ---------------------------------------------------------------------------
// Material-issuance endpoints (multi-issuance feature, migration 0092).
//
// Backed by rd_material_issuances exclusively — the legacy JSON column on
// rd_projects is no longer written or read by these endpoints. See migration
// 0095 for the JSON→table backfill of pre-cutover data.
// ---------------------------------------------------------------------------

type IssuanceRow = {
  id: string;
  projectId: string;
  rawMaterialId: string;
  materialCode: string | null;
  materialName: string | null;
  qty: number;
  unit: string;
  unitCostSen: number;
  totalCostSen: number;
  issuedAt: string;
  issuedBy: string | null;
  notes: string | null;
  stockMovementId: string | null;
  orgId: string;
  createdAt: string;
};

function rowToIssuance(r: IssuanceRow) {
  return {
    id: r.id,
    projectId: r.projectId,
    rawMaterialId: r.rawMaterialId,
    materialCode: r.materialCode ?? "",
    materialName: r.materialName ?? "",
    qty: r.qty,
    unit: r.unit,
    unitCostSen: r.unitCostSen,
    totalCostSen: r.totalCostSen,
    issuedAt: r.issuedAt,
    issuedBy: r.issuedBy,
    notes: r.notes,
    stockMovementId: r.stockMovementId,
    orgId: r.orgId,
    createdAt: r.createdAt,
  };
}

// GET /api/rd-projects/:id/issuances — list all table-backed issuances for
// the project, newest first.
app.get("/:id/issuances", async (c) => {
  const id = c.req.param("id");
  try {
    const res = await c.var.DB.prepare(
      `SELECT * FROM rd_material_issuances
        WHERE projectId = ?
        ORDER BY issuedAt DESC, createdAt DESC`,
    )
      .bind(id)
      .all<IssuanceRow>();
    return c.json({
      success: true,
      data: (res.results ?? []).map(rowToIssuance),
    });
  } catch {
    // Table missing (migration 0092 not yet applied) — return empty list so
    // the UI degrades gracefully instead of erroring out.
    return c.json({ success: true, data: [] });
  }
});

// POST /api/rd-projects/:id/issuances — canonical write endpoint for
// material issuance against an R&D project. Body: { materialId, qty,
// issuedBy, notes }. Returns the inserted rd_material_issuances row in
// the RdMaterialIssuance shape. The unit cost is server-resolved from the
// FIFO oldest batch (rm_batches ORDER BY received_date ASC LIMIT 1) — the
// client does not send unitCostSen.
//
// The legacy POST /:id/issue-material handler still exists for back-compat
// callers but is no longer the path used by the SPA.
app.post("/:id/issuances", async (c) => {
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

    const unitCostSen = await resolveFifoUnitCostSen(
      c.var.DB,
      rm.id,
      rm.itemCode,
      rm.itemGroup,
    );
    const totalCostSen = Math.round(unitCostSen * qty);
    const issuanceId = genId("rdiss");
    const nowIso = new Date().toISOString();
    const stockMovementId = `mv-${issuanceId}`;

    await c.var.DB.prepare(
      "UPDATE raw_materials SET balanceQty = balanceQty - ? WHERE id = ?",
    )
      .bind(qty, materialId)
      .run();

    await c.var.DB.prepare(
      `INSERT INTO stock_movements (id, type, productCode, productName,
         quantity, reason, performedBy, created_at)
       VALUES (?, 'STOCK_OUT', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        stockMovementId,
        rm.itemCode,
        rm.description,
        qty,
        `R&D ${project.code} issuance${notes ? " — " + notes : ""}`,
        issuedBy ?? "System",
        nowIso,
      )
      .run();

    await c.var.DB.prepare(
      `INSERT INTO rd_material_issuances
         (id, projectId, rawMaterialId, materialCode, materialName,
          qty, unit, unitCostSen, totalCostSen, issuedAt, issuedBy,
          notes, stockMovementId, orgId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        issuanceId,
        project.id,
        rm.id,
        rm.itemCode,
        rm.description,
        qty,
        rm.baseUOM,
        unitCostSen,
        totalCostSen,
        nowIso.slice(0, 10),
        issuedBy ?? null,
        notes ?? null,
        stockMovementId,
        "hookka",
        nowIso,
      )
      .run();

    // Recompute actualCost from the table-backed sum so the budget cards
    // stay in sync. The legacy JSON column on rd_projects is no longer
    // written — rd_material_issuances is the single source of truth.
    const sumRow = await c.var.DB.prepare(
      `SELECT COALESCE(SUM(totalCostSen), 0) AS total
         FROM rd_material_issuances WHERE projectId = ?`,
    )
      .bind(id)
      .first<{ total: number }>();
    const nextActualCost = sumRow?.total ?? 0;
    await c.var.DB.prepare(
      "UPDATE rd_projects SET actualCost = ? WHERE id = ?",
    )
      .bind(nextActualCost, id)
      .run();

    const row = await c.var.DB.prepare(
      "SELECT * FROM rd_material_issuances WHERE id = ?",
    )
      .bind(issuanceId)
      .first<IssuanceRow>();
    return c.json(
      {
        success: true,
        data: row ? rowToIssuance(row) : null,
      },
      201,
    );
  } catch (err) {
    console.error("[rd-projects] POST /issuances failed:", err);
    return c.json({ success: false, error: "Failed to create issuance" }, 400);
  }
});

// POST /api/rd-projects/:id/issuances/batch — multi-line issuance write.
//
// Body:
//   {
//     issuedAt:  "YYYY-MM-DD" (optional, defaults to today),
//     issuedBy:  string | null,
//     notes:     string | null,
//     items: [{ rawMaterialId: string, qty: number, unit: string }, ...]
//   }
//
// All N item rows are inserted in a single c.var.DB.batch() (which the
// supabase-compat shim wraps in a Postgres transaction) so partial failure
// rolls back cleanly — no orphan stock_movements with no matching
// rd_material_issuances row, and no half-deducted raw_materials.balanceQty.
// Each line's unit cost is resolved server-side via FIFO at insert time
// (resolveFifoUnitCostSen), matching the single-line endpoint's semantics.
//
// Returns { success, created: N, items: [...] } on success; on validation
// failure (no items, missing material, insufficient stock) returns 400 with
// an `error` string the frontend can show inline.
app.post("/:id/issuances/batch", async (c) => {
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

    const body = (await c.req.json()) as {
      issuedAt?: string;
      issuedBy?: string | null;
      notes?: string | null;
      items?: Array<{ rawMaterialId?: string; qty?: number; unit?: string }>;
    };
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) {
      return c.json(
        { success: false, error: "items array is required (at least 1 line)" },
        400,
      );
    }

    const nowIso = new Date().toISOString();
    const issuedAt =
      typeof body.issuedAt === "string" && body.issuedAt
        ? body.issuedAt
        : nowIso.slice(0, 10);
    const issuedBy =
      typeof body.issuedBy === "string" && body.issuedBy.trim()
        ? body.issuedBy.trim()
        : null;
    const headerNotes =
      typeof body.notes === "string" && body.notes.trim()
        ? body.notes.trim()
        : null;

    // Pre-resolve every line: load the raw_material row, validate stock,
    // resolve FIFO unit cost. We aggregate the deduction PER material across
    // lines so a user issuing the same material twice in one dialog gets
    // their balance checked against the combined qty (not just the per-line
    // qty against the live balance). This prevents an over-issuance bug
    // where two lines of the same SKU would each individually pass the
    // balance check but together exceed it.
    type ResolvedLine = {
      issuanceId: string;
      stockMovementId: string;
      rmId: string;
      itemCode: string;
      itemDescription: string;
      itemGroup: string;
      baseUOM: string;
      qty: number;
      unitCostSen: number;
      totalCostSen: number;
    };
    const resolved: ResolvedLine[] = [];
    const aggregateByRmId = new Map<string, number>();
    const rmCache = new Map<string, RawMaterialRow>();

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const rawMaterialId = item.rawMaterialId;
      const qty = typeof item.qty === "number" ? item.qty : 0;
      if (!rawMaterialId || !Number.isFinite(qty) || qty <= 0) {
        return c.json(
          {
            success: false,
            error: `Line ${i + 1}: rawMaterialId and qty > 0 are required`,
          },
          400,
        );
      }
      let rm = rmCache.get(rawMaterialId);
      if (!rm) {
        const fetched = await c.var.DB.prepare(
          "SELECT id, itemCode, description, itemGroup, baseUOM, balanceQty FROM raw_materials WHERE id = ?",
        )
          .bind(rawMaterialId)
          .first<RawMaterialRow>();
        if (!fetched) {
          return c.json(
            { success: false, error: `Line ${i + 1}: raw material not found` },
            404,
          );
        }
        rm = fetched;
        rmCache.set(rawMaterialId, fetched);
      }
      const prevAgg = aggregateByRmId.get(rawMaterialId) ?? 0;
      const nextAgg = prevAgg + qty;
      if (rm.balanceQty < nextAgg) {
        return c.json(
          {
            success: false,
            error: `Line ${i + 1}: insufficient stock for ${rm.itemCode}. Available: ${rm.balanceQty} ${rm.baseUOM}, requested across lines: ${nextAgg}`,
          },
          400,
        );
      }
      aggregateByRmId.set(rawMaterialId, nextAgg);

      const unitCostSen = await resolveFifoUnitCostSen(
        c.var.DB,
        rm.id,
        rm.itemCode,
        rm.itemGroup,
      );
      const totalCostSen = Math.round(unitCostSen * qty);
      const issuanceId = genId("rdiss");
      resolved.push({
        issuanceId,
        stockMovementId: `mv-${issuanceId}`,
        rmId: rm.id,
        itemCode: rm.itemCode,
        itemDescription: rm.description,
        itemGroup: rm.itemGroup,
        baseUOM: rm.baseUOM,
        qty,
        unitCostSen,
        totalCostSen,
      });
    }

    // Build a single atomic batch: per-line stock deduction + STOCK_OUT
    // ledger row + rd_material_issuances row, then a final actualCost
    // recompute. Mirroring the bom.ts /resync-job-card-times pattern.
    const statements: D1PreparedStatement[] = [];
    for (const r of resolved) {
      statements.push(
        c.var.DB
          .prepare(
            "UPDATE raw_materials SET balanceQty = balanceQty - ? WHERE id = ?",
          )
          .bind(r.qty, r.rmId),
      );
      statements.push(
        c.var.DB
          .prepare(
            `INSERT INTO stock_movements (id, type, productCode, productName,
               quantity, reason, performedBy, created_at)
             VALUES (?, 'STOCK_OUT', ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            r.stockMovementId,
            r.itemCode,
            r.itemDescription,
            r.qty,
            `R&D ${project.code} issuance${headerNotes ? " — " + headerNotes : ""}`,
            issuedBy ?? "System",
            nowIso,
          ),
      );
      statements.push(
        c.var.DB
          .prepare(
            `INSERT INTO rd_material_issuances
               (id, projectId, rawMaterialId, materialCode, materialName,
                qty, unit, unitCostSen, totalCostSen, issuedAt, issuedBy,
                notes, stockMovementId, orgId, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            r.issuanceId,
            project.id,
            r.rmId,
            r.itemCode,
            r.itemDescription,
            r.qty,
            r.baseUOM,
            r.unitCostSen,
            r.totalCostSen,
            issuedAt,
            issuedBy,
            headerNotes,
            r.stockMovementId,
            "hookka",
            nowIso,
          ),
      );
    }

    try {
      await c.var.DB.batch(statements);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[rd-projects] POST /issuances/batch failed:", message);
      return c.json(
        {
          success: false,
          error: `Batch issuance failed (transaction rolled back): ${message}`,
        },
        400,
      );
    }

    // Recompute actualCost from the post-insert table sum so the budget
    // cards stay in sync. Done outside the batch (single statement, post-
    // commit) to keep the rollback story simple — if the recompute fails
    // the rows are still durable and the next issuance will resync.
    const sumRow = await c.var.DB.prepare(
      `SELECT COALESCE(SUM(totalCostSen), 0) AS total
         FROM rd_material_issuances WHERE projectId = ?`,
    )
      .bind(id)
      .first<{ total: number }>();
    const nextActualCost = sumRow?.total ?? 0;
    await c.var.DB.prepare(
      "UPDATE rd_projects SET actualCost = ? WHERE id = ?",
    )
      .bind(nextActualCost, id)
      .run();

    // Reload the inserted rows in the canonical RdMaterialIssuance shape
    // so the frontend can drop them straight into its issuances list
    // without re-fetching (though the SPA invalidates the cache anyway).
    const insertedIds = resolved.map((r) => r.issuanceId);
    const placeholders = insertedIds.map(() => "?").join(", ");
    const insertedRes = await c.var.DB.prepare(
      `SELECT * FROM rd_material_issuances WHERE id IN (${placeholders})`,
    )
      .bind(...insertedIds)
      .all<IssuanceRow>();

    return c.json(
      {
        success: true,
        created: resolved.length,
        items: (insertedRes.results ?? []).map(rowToIssuance),
      },
      201,
    );
  } catch (err) {
    console.error("[rd-projects] POST /issuances/batch failed:", err);
    return c.json(
      { success: false, error: "Failed to create batch issuance" },
      400,
    );
  }
});

// DELETE /api/rd-projects/:id/issuances/:issuanceId — reverse an issuance:
// re-credit raw_materials.balanceQty, write a STOCK_IN counter-movement, and
// delete the rd_material_issuances row. rd_projects.actualCost is recomputed
// from the post-delete table sum. The legacy JSON column on rd_projects is
// no longer touched — migration 0095 backfilled all pre-existing JSON rows
// into rd_material_issuances, so the table is the sole source of truth.
app.delete("/:id/issuances/:issuanceId", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const issuanceId = c.req.param("issuanceId");
  try {
    const project = await c.var.DB.prepare(
      "SELECT * FROM rd_projects WHERE id = ?",
    )
      .bind(id)
      .first<ProjectRow>();
    if (!project) {
      return c.json({ success: false, error: "R&D project not found" }, 404);
    }

    const row = await c.var.DB.prepare(
      "SELECT * FROM rd_material_issuances WHERE id = ? AND projectId = ?",
    )
      .bind(issuanceId, id)
      .first<IssuanceRow>();

    if (!row || !row.rawMaterialId || !row.qty || row.qty <= 0) {
      return c.json(
        { success: false, error: "Issuance not found or invalid" },
        404,
      );
    }

    const matRefId = row.rawMaterialId;
    const refQty = row.qty;
    const matCode = row.materialCode ?? "";
    const matName = row.materialName ?? "";
    const performedBy = row.issuedBy ?? "System";

    const nowIso = new Date().toISOString();

    // Re-credit balance
    await c.var.DB.prepare(
      "UPDATE raw_materials SET balanceQty = balanceQty + ? WHERE id = ?",
    )
      .bind(refQty, matRefId)
      .run();

    // Counter-movement so the audit ledger balances.
    await c.var.DB.prepare(
      `INSERT INTO stock_movements (id, type, productCode, productName,
         quantity, reason, performedBy, created_at)
       VALUES (?, 'STOCK_IN', ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        `mv-rev-${issuanceId}`,
        matCode,
        matName,
        refQty,
        `R&D ${project.code} issuance reversed (id=${issuanceId})`,
        performedBy,
        nowIso,
      )
      .run();

    // Drop the table row.
    await c.var.DB.prepare(
      "DELETE FROM rd_material_issuances WHERE id = ? AND projectId = ?",
    )
      .bind(issuanceId, id)
      .run();

    // Recompute actualCost from the post-delete table sum.
    const sumRow = await c.var.DB.prepare(
      `SELECT COALESCE(SUM(totalCostSen), 0) AS total
         FROM rd_material_issuances WHERE projectId = ?`,
    )
      .bind(id)
      .first<{ total: number }>();
    const nextActualCost = sumRow?.total ?? 0;
    await c.var.DB.prepare(
      "UPDATE rd_projects SET actualCost = ? WHERE id = ?",
    )
      .bind(nextActualCost, id)
      .run();

    return c.json({ success: true, data: { id: issuanceId } });
  } catch (err) {
    console.error("[rd-projects] DELETE /issuances failed:", err);
    return c.json({ success: false, error: "Failed to delete issuance" }, 400);
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

// ---------------------------------------------------------------------------
// rd_labour_hours endpoints — table-backed labour hours per project, joined
// to rd_team_members for the auto-computed labour cost. The legacy JSON
// `labourLogs` column on rd_projects is left untouched for back-compat
// readers; new entries go through these endpoints.
// ---------------------------------------------------------------------------

type LabourHourRow = {
  id: string;
  projectId: string;
  teamMemberId: string;
  workDate: string;
  hours: number;
  notes: string | null;
  orgId: string;
  createdAt: string;
};

type LabourHourEnrichedRow = LabourHourRow & {
  memberName: string;
  employmentType: "FULL_TIME" | "PART_TIME";
  hourlyRateSen: number | null;
  monthlyFixedCostSen: number | null;
};

function rowToLabourHour(r: LabourHourEnrichedRow) {
  // Auto-cost per row: FT = hours * hourlyRateSen, PT = 0 (per the cost
  // computation rules; PT contributes a flat fixed cost at the project
  // level instead of per-hour).
  const hrs = typeof r.hours === "number" ? r.hours : Number(r.hours) || 0;
  const autoCostSen =
    r.employmentType === "FULL_TIME"
      ? Math.round(hrs * (r.hourlyRateSen ?? 0))
      : 0;
  return {
    id: r.id,
    projectId: r.projectId,
    teamMemberId: r.teamMemberId,
    memberName: r.memberName,
    employmentType: r.employmentType,
    workDate: r.workDate,
    hours: hrs,
    notes: r.notes ?? "",
    autoCostSen,
    createdAt: r.createdAt,
  };
}

// GET /api/rd-projects/:id/labour-hours — list rows for a project, newest
// first, enriched with the member name + employment type so the table can
// render auto-cost without a second round-trip.
app.get("/:id/labour-hours", async (c) => {
  const id = c.req.param("id");
  try {
    const res = await c.var.DB.prepare(
      `SELECT lh.id              AS "id",
              lh.projectId       AS "projectId",
              lh.teamMemberId    AS "teamMemberId",
              lh.workDate        AS "workDate",
              lh.hours           AS "hours",
              lh.notes           AS "notes",
              lh.orgId           AS "orgId",
              lh.createdAt       AS "createdAt",
              tm.name            AS "memberName",
              tm.employmentType  AS "employmentType",
              tm.hourlyRateSen   AS "hourlyRateSen",
              tm.monthlyFixedCostSen AS "monthlyFixedCostSen"
         FROM rd_labour_hours lh
         JOIN rd_team_members tm ON tm.id = lh.teamMemberId
        WHERE lh.projectId = ?
        ORDER BY lh.workDate DESC, lh.createdAt DESC`,
    )
      .bind(id)
      .all<LabourHourEnrichedRow>();
    return c.json({
      success: true,
      data: (res.results ?? []).map(rowToLabourHour),
    });
  } catch {
    // Table missing (migration 0098 not yet applied) — degrade gracefully.
    return c.json({ success: true, data: [] });
  }
});

// POST /api/rd-projects/:id/labour-hours — log hours.
// Body: { teamMemberId, workDate, hours, notes? }
app.post("/:id/labour-hours", async (c) => {
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
    const body = (await c.req.json()) as Partial<{
      teamMemberId: string;
      workDate: string;
      hours: number;
      notes: string | null;
    }>;

    const teamMemberId =
      typeof body.teamMemberId === "string" ? body.teamMemberId.trim() : "";
    const workDate =
      typeof body.workDate === "string" ? body.workDate.trim() : "";
    const hours = typeof body.hours === "number" ? body.hours : 0;
    if (!teamMemberId || !workDate || !Number.isFinite(hours) || hours <= 0) {
      return c.json(
        {
          success: false,
          error: "teamMemberId, workDate, and hours > 0 are required",
        },
        400,
      );
    }

    const member = await c.var.DB.prepare(
      "SELECT id FROM rd_team_members WHERE id = ?",
    )
      .bind(teamMemberId)
      .first<{ id: string }>();
    if (!member) {
      return c.json({ success: false, error: "Team member not found" }, 404);
    }

    const logId = `rdlh-${crypto.randomUUID().slice(0, 8)}`;
    const nowIso = new Date().toISOString();
    await c.var.DB.prepare(
      `INSERT INTO rd_labour_hours
         (id, projectId, teamMemberId, workDate, hours, notes, orgId, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, 'hookka', ?)`,
    )
      .bind(
        logId,
        id,
        teamMemberId,
        workDate,
        hours,
        typeof body.notes === "string" ? body.notes : null,
        nowIso,
      )
      .run();

    const inserted = await c.var.DB.prepare(
      `SELECT lh.id              AS "id",
              lh.projectId       AS "projectId",
              lh.teamMemberId    AS "teamMemberId",
              lh.workDate        AS "workDate",
              lh.hours           AS "hours",
              lh.notes           AS "notes",
              lh.orgId           AS "orgId",
              lh.createdAt       AS "createdAt",
              tm.name            AS "memberName",
              tm.employmentType  AS "employmentType",
              tm.hourlyRateSen   AS "hourlyRateSen",
              tm.monthlyFixedCostSen AS "monthlyFixedCostSen"
         FROM rd_labour_hours lh
         JOIN rd_team_members tm ON tm.id = lh.teamMemberId
        WHERE lh.id = ?`,
    )
      .bind(logId)
      .first<LabourHourEnrichedRow>();

    return c.json(
      {
        success: true,
        data: inserted ? rowToLabourHour(inserted) : null,
      },
      201,
    );
  } catch (err) {
    console.error("[rd-projects] POST /labour-hours failed:", err);
    return c.json(
      { success: false, error: "Failed to log labour hours" },
      400,
    );
  }
});

// DELETE /api/rd-projects/:id/labour-hours/:logId — remove a row.
app.delete("/:id/labour-hours/:logId", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const logId = c.req.param("logId");
  const existing = await c.var.DB.prepare(
    "SELECT id FROM rd_labour_hours WHERE id = ? AND projectId = ?",
  )
    .bind(logId, id)
    .first<{ id: string }>();
  if (!existing) {
    return c.json({ success: false, error: "Labour hours row not found" }, 404);
  }
  await c.var.DB.prepare(
    "DELETE FROM rd_labour_hours WHERE id = ? AND projectId = ?",
  )
    .bind(logId, id)
    .run();
  return c.json({ success: true, data: { id: logId } });
});

// PATCH /api/rd-projects/:id/labour-cost — set or clear the manual override.
// Body: { manualLabourCostSen: number | null }
//   - number ≥ 0  → store, becomes the displayed labour cost
//   - null        → clear, fall back to the auto-computed value
app.patch("/:id/labour-cost", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "update");
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
    const body = (await c.req.json()) as {
      manualLabourCostSen?: number | null;
    };
    const raw = body.manualLabourCostSen;
    let next: number | null;
    if (raw === null || raw === undefined) {
      next = null;
    } else if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      next = Math.round(raw);
    } else {
      return c.json(
        {
          success: false,
          error: "manualLabourCostSen must be a non-negative number or null",
        },
        400,
      );
    }

    await c.var.DB.prepare(
      "UPDATE rd_projects SET manualLabourCostSen = ? WHERE id = ?",
    )
      .bind(next, id)
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
    const labourSummary = await computeLabourCostSummary(
      c.var.DB,
      updated.id,
      updated.manualLabourCostSen ?? null,
    );
    return c.json({
      success: true,
      data: rowToProject(updated, protos.results ?? [], labourSummary),
    });
  } catch (err) {
    console.error("[rd-projects] PATCH /labour-cost failed:", err);
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
