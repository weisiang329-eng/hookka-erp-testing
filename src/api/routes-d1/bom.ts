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

// PUT /api/bom/templates/:id — UPSERT for a single template row.
// The Module Builder save flow calls this once per user-triggered save so D1
// is never rewritten in bulk from stale client state. Only the fields the
// caller sends are updated; JSON fields (l1Processes, wipComponents) are
// re-stringified from whatever array the client sends.
//
// If the row does not exist, it is INSERTed with the body fields plus sane
// defaults for any required columns the body omitted. This supports the
// frontend "Create from Default Template" / "Start Blank" flow in bom.tsx,
// where a template is constructed locally with `id: bom-${Date.now()}` and
// then saved via PUT — there is no prior POST to /templates.
app.put("/templates/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM bom_templates WHERE id = ?",
  )
    .bind(id)
    .first<BOMTemplateRow>();
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

    // Diagnostic surface: the response carries `debug` so the network tab
    // shows exactly what the server tried to write. Once the BOM-edit
    // persistence regression is verified fixed across all entry points
    // (Edit BOM dialog, per-product save, BOM tree edits) this block can
    // be deleted alongside the bulk-process-edit one above.
    const debug: Record<string, unknown> = {
      existingFound: existing != null,
      keys: Object.keys(patch),
    };

    if (existing) {
      const keys = Object.keys(patch);
      if (keys.length > 0) {
        const setClause = keys.map((k) => `${k} = ?`).join(", ");
        const sql = `UPDATE bom_templates SET ${setClause} WHERE id = ?`;
        const updateResult = await c.var.DB.prepare(sql)
          .bind(...keys.map((k) => patch[k]), id)
          .run();
        debug.sql = sql;
        debug.updateMetaChanges = updateResult.meta?.changes;
        // Surface a hard failure when the SET clause matched zero rows even
        // though `existing` proved the row IS there. That state used to
        // return `success: true` with stale data — the user-reported
        // "PUT succeeds but DB unchanged" symptom that this fix targets.
        if (
          (updateResult.meta?.changes ?? 0) === 0 &&
          keys.length > 0
        ) {
          console.error(
            `[bom PUT /templates/:id] UPDATE matched 0 rows for id=${id} despite existing row — keys=${keys.join(",")}`,
          );
          return c.json(
            {
              success: false,
              error:
                "BOM template update affected 0 rows — row exists but UPDATE silently failed",
              debug,
            },
            500,
          );
        }
      } else {
        debug.skippedUpdate = "no keys in patch";
      }
    } else {
      // INSERT path: row doesn't exist yet. Fill in required columns with
      // sensible defaults if the body didn't supply them.
      const insertRow: Record<string, string | number | null> = {
        id,
        productCode: typeof patch.productCode === "string" ? patch.productCode : id,
        version: typeof patch.version === "string" ? patch.version : "v1.0",
        versionStatus:
          typeof patch.versionStatus === "string" ? patch.versionStatus : "ACTIVE",
        category: typeof patch.category === "string" ? patch.category : "BEDFRAME",
      };
      // Carry over any other supplied optional columns.
      for (const k of Object.keys(patch)) {
        if (!(k in insertRow)) {
          insertRow[k] = patch[k];
        }
      }
      const cols = Object.keys(insertRow);
      const placeholders = cols.map(() => "?").join(", ");
      const sql = `INSERT INTO bom_templates (${cols.join(", ")}) VALUES (${placeholders})`;
      const insertResult = await c.var.DB.prepare(sql)
        .bind(...cols.map((k) => insertRow[k]))
        .run();
      debug.sql = sql;
      debug.insertMetaChanges = insertResult.meta?.changes;
    }

    const refreshed = await c.var.DB.prepare(
      "SELECT * FROM bom_templates WHERE id = ?",
    )
      .bind(id)
      .first<BOMTemplateRow>();
    if (!refreshed) {
      return c.json(
        { success: false, error: "Failed to read back BOM template", debug },
        500,
      );
    }
    return c.json({ success: true, data: rowToTemplate(refreshed), debug });
  } catch (err) {
    // Was bare `} catch {` returning 400 "Invalid request body" — masked
    // every internal error (DB constraint, schema mismatch, SQL syntax)
    // as if the client sent bad JSON. Mirrors the cleanup that commit
    // 5bc2ace did for delivery-orders / sales-orders / etc.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[bom PUT /templates/:id] id=${id} err=${message}`,
    );
    if (err instanceof SyntaxError) {
      return c.json(
        { success: false, error: "Invalid JSON in request body" },
        400,
      );
    }
    return c.json({ success: false, error: message }, 500);
  }
});

// POST /api/bom/templates/bulk-process-edit — batch-update process category
// (and minutes) on existing per-product BOM templates. Powers the
// Dept-Pivot Category Editor dialog in src/pages/bom.tsx.
//
// Body shape:
//   {
//     edits: Array<{
//       templateId: string;
//       path: number[];        // [wipItemIdx, childIdx, childIdx, ...] — the
//                              // chain through wipComponents to the WIP node
//                              // that owns the process. May be [] for L1.
//       processIndex: number;  // index into the target node's processes[]
//       newCategory: string;
//       newMinutes: number;
//     }>;
//   }
//
// Edits are grouped by templateId. For each template we read the current
// wipComponents JSON, walk to each process and mutate its category +
// minutes, then UPDATE the row. l1Processes are addressable with an empty
// path (path === []).
//
// Each template's update is wrapped in its own batch — if one template's
// update fails (bad JSON, missing path, DB error) we record it in `failed`
// and keep going so a single bad row doesn't abort the whole save.
//
// Response: { success: true, updated: N, failed: [{templateId, error}] }
app.post("/templates/bulk-process-edit", async (c) => {
  try {
    const body = await c.req.json();
    const incoming: unknown = body?.edits;
    if (!Array.isArray(incoming)) {
      return c.json(
        { success: false, error: "edits must be an array" },
        400,
      );
    }

    type Edit = {
      templateId: string;
      path: number[];
      processIndex: number;
      newCategory: string;
      newMinutes: number;
    };

    // Sanitize incoming edits — drop anything malformed rather than 400'ing
    // the whole batch. The caller already validated client-side.
    const edits: Edit[] = [];
    for (const raw of incoming as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== "object") continue;
      const templateId = raw.templateId;
      const path = raw.path;
      const processIndex = raw.processIndex;
      const newCategory = raw.newCategory;
      const newMinutes = raw.newMinutes;
      if (typeof templateId !== "string" || !templateId) continue;
      if (!Array.isArray(path)) continue;
      if (!path.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)) continue;
      if (typeof processIndex !== "number" || !Number.isInteger(processIndex) || processIndex < 0) continue;
      if (typeof newCategory !== "string" || !newCategory) continue;
      if (typeof newMinutes !== "number" || !Number.isFinite(newMinutes)) continue;
      edits.push({
        templateId,
        path: path as number[],
        processIndex,
        newCategory,
        newMinutes,
      });
    }

    // Group by templateId so we touch each row only once.
    const byTemplate = new Map<string, Edit[]>();
    for (const e of edits) {
      const arr = byTemplate.get(e.templateId);
      if (arr) arr.push(e);
      else byTemplate.set(e.templateId, [e]);
    }

    type WipNode = {
      processes?: Array<Record<string, unknown>>;
      children?: WipNode[];
    };

    let updated = 0;
    const failed: Array<{ templateId: string; error: string }> = [];
    const debug: Array<Record<string, unknown>> = [];

    for (const [templateId, templateEdits] of byTemplate) {
      try {
        const row = await c.var.DB.prepare(
          "SELECT * FROM bom_templates WHERE id = ?",
        )
          .bind(templateId)
          .first<BOMTemplateRow>();
        if (!row) {
          failed.push({ templateId, error: "Template not found" });
          continue;
        }

        const wipComponents = safeParse<WipNode[]>(row.wipComponents, []);
        const l1Processes = safeParse<Array<Record<string, unknown>>>(
          row.l1Processes,
          [],
        );

        let editError: string | null = null;

        for (const e of templateEdits) {
          // Resolve target processes[] array. Empty path means l1Processes.
          let processes: Array<Record<string, unknown>> | null = null;
          if (e.path.length === 0) {
            processes = l1Processes;
          } else {
            let node: WipNode | undefined = wipComponents[e.path[0]];
            for (let i = 1; i < e.path.length && node; i++) {
              node = node.children?.[e.path[i]];
            }
            if (node && Array.isArray(node.processes)) {
              processes = node.processes;
            }
          }
          if (!processes) {
            editError = `Path [${e.path.join(",")}] not found in template`;
            break;
          }
          const target = processes[e.processIndex];
          if (!target || typeof target !== "object") {
            editError = `processIndex ${e.processIndex} out of range`;
            break;
          }
          target.category = e.newCategory;
          target.minutes = e.newMinutes;
        }

        if (editError) {
          failed.push({ templateId, error: editError });
          continue;
        }

        const updateResult = await c.var.DB.prepare(
          `UPDATE bom_templates
             SET l1Processes = ?, wipComponents = ?
             WHERE id = ?`,
        )
          .bind(
            JSON.stringify(l1Processes),
            JSON.stringify(wipComponents),
            templateId,
          )
          .run();
        debug.push({
          templateId,
          editsApplied: templateEdits.length,
          wipComponentsBytes: JSON.stringify(wipComponents).length,
          l1ProcessesBytes: JSON.stringify(l1Processes).length,
          updateMetaChanges: updateResult.meta?.changes,
        });
        updated += 1;
      } catch (err) {
        failed.push({
          templateId,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    return c.json({
      success: true,
      updated,
      failed,
      debug: {
        incoming: incoming.length,
        validated: edits.length,
        templates: byTemplate.size,
        perTemplate: debug,
      },
    });
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
