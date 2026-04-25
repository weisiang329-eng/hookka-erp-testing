// ---------------------------------------------------------------------------
// D1-backed BOM route.
//
// Mirrors src/api/routes/bom.ts (in-memory) but queries D1. Covers two
// resources under the same mount point:
//   - /api/bom         → bom_versions (GET list, POST, GET :id, PUT :id)
//   - /api/bom/templates → bom_templates (GET, POST, PUT bulk-replace)
//
// CRITICAL: /templates routes are declared BEFORE /:id so Hono's first-match
// router resolves them correctly (otherwise "templates" is swallowed as :id).
//
// JSON columns (l1Processes, wipComponents, tree) are stored as TEXT in D1.
// They must be parsed back to objects/arrays before returning to the SPA,
// which reads e.g. `template.l1Processes[0].dept` directly.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

// --- Row types mirror the D1 schema (TEXT JSON columns are strings here) ---
type BOMTemplateRow = {
  id: string;
  productCode: string;
  baseModel: string | null;
  category: "BEDFRAME" | "SOFA" | null;
  l1Processes: string | null;
  wipComponents: string | null;
  version: string;
  versionStatus: "DRAFT" | "ACTIVE" | "OBSOLETE" | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  changeLog: string | null;
};

type BOMVersionRow = {
  id: string;
  productId: string;
  productCode: string | null;
  version: string;
  status: "ACTIVE" | "DRAFT" | "OBSOLETE" | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  tree: string | null;
  totalMinutes: number;
  labourCost: number;
  materialCost: number;
  totalCost: number;
};

function safeParse<T>(text: string | null, fallback: T): T {
  if (text == null || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function rowToTemplate(row: BOMTemplateRow) {
  return {
    id: row.id,
    productCode: row.productCode,
    baseModel: row.baseModel ?? row.productCode,
    category: (row.category ?? "BEDFRAME") as "BEDFRAME" | "SOFA",
    l1Processes: safeParse<unknown[]>(row.l1Processes, []),
    wipComponents: safeParse<unknown[]>(row.wipComponents, []),
    version: row.version,
    versionStatus: (row.versionStatus ?? "DRAFT") as
      | "DRAFT"
      | "ACTIVE"
      | "OBSOLETE",
    effectiveFrom: row.effectiveFrom ?? "",
    effectiveTo: row.effectiveTo ?? undefined,
    changeLog: row.changeLog ?? undefined,
  };
}

function rowToVersion(row: BOMVersionRow) {
  return {
    id: row.id,
    productId: row.productId,
    productCode: row.productCode ?? "",
    version: row.version,
    status: (row.status ?? "DRAFT") as "ACTIVE" | "DRAFT" | "OBSOLETE",
    effectiveFrom: row.effectiveFrom ?? "",
    effectiveTo: row.effectiveTo,
    tree: safeParse<unknown>(row.tree, null),
    totalMinutes: row.totalMinutes,
    labourCost: row.labourCost,
    materialCost: row.materialCost,
    totalCost: row.totalCost,
  };
}

function genId(): string {
  return crypto.randomUUID().slice(0, 8);
}

// ---------------------------------------------------------------------------
// bom_versions routes
// ---------------------------------------------------------------------------

// GET /api/bom — list all BOM versions, optional ?productId= filter
app.get("/", async (c) => {
  const productId = c.req.query("productId");
  const sql = productId
    ? "SELECT * FROM bom_versions WHERE productId = ? ORDER BY id"
    : "SELECT * FROM bom_versions ORDER BY id";
  const stmt = productId
    ? c.var.DB.prepare(sql).bind(productId)
    : c.var.DB.prepare(sql);
  const res = await stmt.all<BOMVersionRow>();
  const data = (res.results ?? []).map(rowToVersion);
  return c.json({ success: true, data });
});

// POST /api/bom — create BOM version
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const {
      productId,
      productCode,
      version,
      status,
      effectiveFrom,
      effectiveTo,
      tree,
      totalMinutes,
      labourCost,
      materialCost,
      totalCost,
    } = body;
    if (!productId || !productCode || !tree) {
      return c.json(
        {
          success: false,
          error: "productId, productCode, and tree are required",
        },
        400,
      );
    }
    const id = genId();
    const row = {
      id,
      productId: String(productId),
      productCode: String(productCode),
      version: version || "v1.0",
      status: status || "DRAFT",
      effectiveFrom: effectiveFrom || new Date().toISOString().slice(0, 10),
      effectiveTo: effectiveTo ?? null,
      tree: JSON.stringify(tree),
      totalMinutes: Number(totalMinutes) || 0,
      labourCost: Number(labourCost) || 0,
      materialCost: Number(materialCost) || 0,
      totalCost: Number(totalCost) || 0,
    };

    await c.var.DB.prepare(
      `INSERT INTO bom_versions (id, productId, productCode, version, status,
         effectiveFrom, effectiveTo, tree, totalMinutes, labourCost,
         materialCost, totalCost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id,
        row.productId,
        row.productCode,
        row.version,
        row.status,
        row.effectiveFrom,
        row.effectiveTo,
        row.tree,
        row.totalMinutes,
        row.labourCost,
        row.materialCost,
        row.totalCost,
      )
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM bom_versions WHERE id = ?",
    )
      .bind(id)
      .first<BOMVersionRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create BOM version" },
        500,
      );
    }
    return c.json({ success: true, data: rowToVersion(created) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// bom_templates routes — MUST be declared BEFORE /:id
// ---------------------------------------------------------------------------

// GET /api/bom/templates — list templates, all filters are SQL WHERE clauses
app.get("/templates", async (c) => {
  const category = c.req.query("category");
  const baseModel = c.req.query("baseModel");
  const search = c.req.query("search");
  const version = c.req.query("version");
  const versionStatus = c.req.query("versionStatus");
  const productCode = c.req.query("productCode");

  const where: string[] = [];
  const binds: unknown[] = [];

  if (category) {
    where.push("UPPER(category) = ?");
    binds.push(category.toUpperCase());
  }
  if (baseModel) {
    where.push("baseModel = ?");
    binds.push(baseModel);
  }
  if (productCode) {
    where.push("productCode = ?");
    binds.push(productCode);
  }
  if (version) {
    where.push("version = ?");
    binds.push(version);
  }
  if (versionStatus) {
    where.push("UPPER(versionStatus) = ?");
    binds.push(versionStatus.toUpperCase());
  }
  if (search) {
    // Postgres LIKE is case-sensitive; SQLite LIKE was case-insensitive for
    // ASCII by default.  ILIKE preserves the old behavior.  d1-compat's
    // swapDialect translates IFNULL → COALESCE, but we use COALESCE directly.
    where.push("(productCode ILIKE ? OR COALESCE(baseModel, '') ILIKE ?)");
    const needle = `%${search}%`;
    binds.push(needle, needle);
  }

  const sql =
    where.length > 0
      ? `SELECT * FROM bom_templates WHERE ${where.join(" AND ")} ORDER BY productCode`
      : "SELECT * FROM bom_templates ORDER BY productCode";

  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<BOMTemplateRow>();
  const data = (res.results ?? []).map(rowToTemplate);
  return c.json({ success: true, data });
});

// POST /api/bom/templates — create single template
app.post("/templates", async (c) => {
  try {
    const body = await c.req.json();
    const { productCode, baseModel, category, l1Processes, wipComponents } =
      body;
    if (!productCode || !baseModel || !category) {
      return c.json(
        {
          success: false,
          error: "productCode, baseModel, and category are required",
        },
        400,
      );
    }
    const id = genId();
    const row = {
      id,
      productCode: String(productCode),
      baseModel: String(baseModel),
      category: category === "SOFA" ? "SOFA" : "BEDFRAME",
      l1Processes: JSON.stringify(
        Array.isArray(l1Processes) ? l1Processes : [],
      ),
      wipComponents: JSON.stringify(
        Array.isArray(wipComponents) ? wipComponents : [],
      ),
      version: body.version || "1.0",
      versionStatus: body.versionStatus || "DRAFT",
      effectiveFrom: body.effectiveFrom || new Date().toISOString(),
      effectiveTo: body.effectiveTo ?? null,
      changeLog: body.changeLog ?? null,
    };

    await c.var.DB.prepare(
      `INSERT INTO bom_templates (id, productCode, baseModel, category,
         l1Processes, wipComponents, version, versionStatus, effectiveFrom,
         effectiveTo, changeLog)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id,
        row.productCode,
        row.baseModel,
        row.category,
        row.l1Processes,
        row.wipComponents,
        row.version,
        row.versionStatus,
        row.effectiveFrom,
        row.effectiveTo,
        row.changeLog,
      )
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM bom_templates WHERE id = ?",
    )
      .bind(id)
      .first<BOMTemplateRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create BOM template" },
        500,
      );
    }
    return c.json({ success: true, data: rowToTemplate(created) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// PUT /api/bom/templates — bulk replace. DELETE ALL + INSERT ALL in one D1
// batch (single transaction). Matches the old splice(0, length, ...sanitized).
app.put("/templates", async (c) => {
  try {
    const body = await c.req.json();
    const incoming: unknown = body?.templates;
    if (!Array.isArray(incoming)) {
      return c.json(
        { success: false, error: "templates must be an array" },
        400,
      );
    }

    type SanitizedTemplate = {
      id: string;
      productCode: string;
      baseModel: string;
      category: "BEDFRAME" | "SOFA";
      l1Processes: string;
      wipComponents: string;
      version: string;
      versionStatus: "DRAFT" | "ACTIVE" | "OBSOLETE";
      effectiveFrom: string;
      effectiveTo: string | null;
      changeLog: string | null;
    };

    const sanitized: SanitizedTemplate[] = [];
    for (const raw of incoming as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== "object") continue;
      const productCode = raw.productCode;
      if (!productCode || typeof productCode !== "string") continue;
      sanitized.push({
        id: typeof raw.id === "string" && raw.id ? raw.id : genId(),
        productCode,
        baseModel:
          typeof raw.baseModel === "string" && raw.baseModel
            ? raw.baseModel
            : productCode,
        category: raw.category === "SOFA" ? "SOFA" : "BEDFRAME",
        l1Processes: JSON.stringify(
          Array.isArray(raw.l1Processes) ? raw.l1Processes : [],
        ),
        wipComponents: JSON.stringify(
          Array.isArray(raw.wipComponents) ? raw.wipComponents : [],
        ),
        version:
          typeof raw.version === "string" && raw.version ? raw.version : "1.0",
        versionStatus:
          raw.versionStatus === "DRAFT" || raw.versionStatus === "OBSOLETE"
            ? raw.versionStatus
            : "ACTIVE",
        effectiveFrom:
          typeof raw.effectiveFrom === "string" && raw.effectiveFrom
            ? raw.effectiveFrom
            : new Date().toISOString(),
        effectiveTo:
          typeof raw.effectiveTo === "string" ? raw.effectiveTo : null,
        changeLog: typeof raw.changeLog === "string" ? raw.changeLog : null,
      });
    }

    // Single atomic batch: wipe + re-insert.
    const statements = [
      c.var.DB.prepare("DELETE FROM bom_templates"),
      ...sanitized.map((t) =>
        c.var.DB
          .prepare(
            `INSERT INTO bom_templates (id, productCode, baseModel, category,
               l1Processes, wipComponents, version, versionStatus,
               effectiveFrom, effectiveTo, changeLog)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            t.id,
            t.productCode,
            t.baseModel,
            t.category,
            t.l1Processes,
            t.wipComponents,
            t.version,
            t.versionStatus,
            t.effectiveFrom,
            t.effectiveTo,
            t.changeLog,
          ),
      ),
    ];
    await c.var.DB.batch(statements);

    return c.json({ success: true, count: sanitized.length });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// PUT /api/bom/templates/:id — partial update for a single template row.
// The Module Builder save flow calls this once per user-triggered save so D1
// is never rewritten in bulk from stale client state. Only the fields the
// caller sends are updated; JSON fields (l1Processes, wipComponents) are
// re-stringified from whatever array the client sends. Returns 404 if the
// id doesn't exist — callers should POST /templates to create new rows.
app.put("/templates/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM bom_templates WHERE id = ?",
  )
    .bind(id)
    .first<BOMTemplateRow>();
  if (!existing) {
    return c.json({ success: false, error: "BOM template not found" }, 404);
  }
  try {
    const body = await c.req.json();
    const patch: Record<string, string | number | null> = {};
    if (typeof body.productCode === "string") patch.productCode = body.productCode;
    if (typeof body.baseModel === "string") patch.baseModel = body.baseModel;
    if (body.category === "SOFA" || body.category === "BEDFRAME") {
      patch.category = body.category;
    }
    if (Array.isArray(body.l1Processes)) {
      patch.l1Processes = JSON.stringify(body.l1Processes);
    }
    if (Array.isArray(body.wipComponents)) {
      patch.wipComponents = JSON.stringify(body.wipComponents);
    }
    if (typeof body.version === "string") patch.version = body.version;
    if (
      body.versionStatus === "DRAFT" ||
      body.versionStatus === "ACTIVE" ||
      body.versionStatus === "OBSOLETE"
    ) {
      patch.versionStatus = body.versionStatus;
    }
    if (typeof body.effectiveFrom === "string") patch.effectiveFrom = body.effectiveFrom;
    if (typeof body.effectiveTo === "string" || body.effectiveTo === null) {
      patch.effectiveTo = body.effectiveTo;
    }
    if (typeof body.changeLog === "string" || body.changeLog === null) {
      patch.changeLog = body.changeLog;
    }

    const keys = Object.keys(patch);
    if (keys.length > 0) {
      const setClause = keys.map((k) => `${k} = ?`).join(", ");
      await c.var.DB.prepare(
        `UPDATE bom_templates SET ${setClause} WHERE id = ?`,
      )
        .bind(...keys.map((k) => patch[k]), id)
        .run();
    }

    const refreshed = await c.var.DB.prepare(
      "SELECT * FROM bom_templates WHERE id = ?",
    )
      .bind(id)
      .first<BOMTemplateRow>();
    if (!refreshed) {
      return c.json(
        { success: false, error: "Failed to read back BOM template" },
        500,
      );
    }
    return c.json({ success: true, data: rowToTemplate(refreshed) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// bom_versions dynamic-id routes — MUST come AFTER /templates
// ---------------------------------------------------------------------------

// GET /api/bom/:id — single BOM version
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.var.DB.prepare("SELECT * FROM bom_versions WHERE id = ?")
    .bind(id)
    .first<BOMVersionRow>();
  if (!row) {
    return c.json({ success: false, error: "BOM version not found" }, 404);
  }
  return c.json({ success: true, data: rowToVersion(row) });
});

// PUT /api/bom/:id — update BOM version (shallow merge over existing)
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM bom_versions WHERE id = ?",
  )
    .bind(id)
    .first<BOMVersionRow>();
  if (!existing) {
    return c.json({ success: false, error: "BOM version not found" }, 404);
  }
  try {
    const body = await c.req.json();

    // Decode existing + merge incoming partial, mirroring the old
    // `{ ...bomVersions[idx], ...body, id }` spread behavior.
    const current = rowToVersion(existing);
    const merged = { ...current, ...body, id };

    const row = {
      id,
      productId: String(merged.productId),
      productCode: merged.productCode ?? null,
      version: merged.version ?? existing.version,
      status: merged.status ?? existing.status,
      effectiveFrom: merged.effectiveFrom ?? existing.effectiveFrom,
      effectiveTo: merged.effectiveTo ?? existing.effectiveTo,
      tree:
        merged.tree === undefined ? existing.tree : JSON.stringify(merged.tree),
      totalMinutes: Number(merged.totalMinutes) || 0,
      labourCost: Number(merged.labourCost) || 0,
      materialCost: Number(merged.materialCost) || 0,
      totalCost: Number(merged.totalCost) || 0,
    };

    await c.var.DB.prepare(
      `UPDATE bom_versions SET
         productId = ?, productCode = ?, version = ?, status = ?,
         effectiveFrom = ?, effectiveTo = ?, tree = ?, totalMinutes = ?,
         labourCost = ?, materialCost = ?, totalCost = ?
       WHERE id = ?`,
    )
      .bind(
        row.productId,
        row.productCode,
        row.version,
        row.status,
        row.effectiveFrom,
        row.effectiveTo,
        row.tree,
        row.totalMinutes,
        row.labourCost,
        row.materialCost,
        row.totalCost,
        id,
      )
      .run();

    const updated = await c.var.DB.prepare(
      "SELECT * FROM bom_versions WHERE id = ?",
    )
      .bind(id)
      .first<BOMVersionRow>();
    if (!updated) {
      return c.json(
        { success: false, error: "Failed to reload BOM version" },
        500,
      );
    }
    return c.json({ success: true, data: rowToVersion(updated) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;
