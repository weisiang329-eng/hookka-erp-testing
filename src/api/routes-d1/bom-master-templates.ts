// ---------------------------------------------------------------------------
// D1-backed Master BOM Templates.
//
// GET    /api/bom-master-templates              -> all templates
// GET    /api/bom-master-templates/:id          -> one
// PUT    /api/bom-master-templates/:id          -> upsert one (body is the
//                                                  whole MasterTemplate)
// DELETE /api/bom-master-templates/:id          -> delete one
// PUT    /api/bom-master-templates              -> bulk replace
//                                                  (body: { templates: [...] })
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type Row = {
  id: string;
  category: "BEDFRAME" | "SOFA";
  label: string;
  moduleKey: string | null;
  isDefault: number;
  data: string;
  updatedAt: string;
};

type TemplateBody = {
  id?: string;
  category: "BEDFRAME" | "SOFA";
  label?: string;
  moduleKey?: string | null;
  isDefault?: boolean;
  l1Processes?: unknown[];
  l1Materials?: unknown[];
  wipItems?: unknown[];
  updatedAt?: string;
};

function rowToTemplate(r: Row) {
  let body: { l1Processes?: unknown[]; l1Materials?: unknown[]; wipItems?: unknown[] } = {};
  try {
    body = JSON.parse(r.data);
  } catch {
    // malformed — return empty body so the UI still renders the template
    body = {};
  }
  return {
    id: r.id,
    category: r.category,
    label: r.label,
    moduleKey: r.moduleKey ?? undefined,
    isDefault: r.isDefault === 1,
    l1Processes: body.l1Processes ?? [],
    l1Materials: body.l1Materials ?? [],
    wipItems: body.wipItems ?? [],
    updatedAt: r.updatedAt,
  };
}

function templateToRow(t: TemplateBody, id: string): Row {
  const {
    l1Processes = [],
    l1Materials = [],
    wipItems = [],
  } = t;
  return {
    id,
    category: t.category,
    label: t.label || "Untitled",
    moduleKey: t.moduleKey && typeof t.moduleKey === "string" ? t.moduleKey : null,
    isDefault: t.isDefault ? 1 : 0,
    data: JSON.stringify({ l1Processes, l1Materials, wipItems }),
    updatedAt: t.updatedAt || new Date().toISOString(),
  };
}

// GET /api/bom-master-templates
app.get("/", async (c) => {
  const res = await c.env.DB.prepare(
    "SELECT * FROM bom_master_templates ORDER BY category, isDefault DESC, label ASC",
  ).all<Row>();
  const data = (res.results ?? []).map(rowToTemplate);
  return c.json({ success: true, data, total: data.length });
});

// GET /api/bom-master-templates/:id
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT * FROM bom_master_templates WHERE id = ?",
  )
    .bind(id)
    .first<Row>();
  if (!row) return c.json({ success: false, error: "Not found" }, 404);
  return c.json({ success: true, data: rowToTemplate(row) });
});

// PUT /api/bom-master-templates/:id — upsert
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  let body: TemplateBody;
  try {
    body = (await c.req.json()) as TemplateBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  if (body.category !== "BEDFRAME" && body.category !== "SOFA") {
    return c.json(
      { success: false, error: "category must be BEDFRAME or SOFA" },
      400,
    );
  }

  const row = templateToRow(body, id);

  // If this one is flagged default, clear any other default in the same cat.
  if (row.isDefault === 1) {
    await c.env.DB.prepare(
      "UPDATE bom_master_templates SET isDefault = 0 WHERE category = ? AND id != ?",
    )
      .bind(row.category, id)
      .run();
  }

  await c.env.DB.prepare(
    `INSERT INTO bom_master_templates (id, category, label, moduleKey, isDefault, data, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       category = excluded.category,
       label = excluded.label,
       moduleKey = excluded.moduleKey,
       isDefault = excluded.isDefault,
       data = excluded.data,
       updatedAt = excluded.updatedAt`,
  )
    .bind(
      row.id,
      row.category,
      row.label,
      row.moduleKey,
      row.isDefault,
      row.data,
      row.updatedAt,
    )
    .run();

  return c.json({ success: true, data: rowToTemplate(row) });
});

// DELETE /api/bom-master-templates/:id
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM bom_master_templates WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true });
});

// PUT /api/bom-master-templates — bulk replace (used by migrate-from-localStorage)
app.put("/", async (c) => {
  let body: { templates?: TemplateBody[]; replaceAll?: boolean };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  const templates = Array.isArray(body.templates) ? body.templates : [];
  if (templates.length === 0) {
    return c.json({ success: true, data: [], total: 0 });
  }

  const statements = [];
  if (body.replaceAll) {
    statements.push(c.env.DB.prepare("DELETE FROM bom_master_templates"));
  }
  for (const t of templates) {
    if (t.category !== "BEDFRAME" && t.category !== "SOFA") continue;
    const id = t.id || `tpl-${crypto.randomUUID().slice(0, 8)}`;
    const row = templateToRow(t, id);
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO bom_master_templates (id, category, label, moduleKey, isDefault, data, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           category = excluded.category,
           label = excluded.label,
           moduleKey = excluded.moduleKey,
           isDefault = excluded.isDefault,
           data = excluded.data,
           updatedAt = excluded.updatedAt`,
      ).bind(
        row.id,
        row.category,
        row.label,
        row.moduleKey,
        row.isDefault,
        row.data,
        row.updatedAt,
      ),
    );
  }
  await c.env.DB.batch(statements);

  const res = await c.env.DB.prepare(
    "SELECT * FROM bom_master_templates ORDER BY category, isDefault DESC, label ASC",
  ).all<Row>();
  const data = (res.results ?? []).map(rowToTemplate);
  return c.json({ success: true, data, total: data.length });
});

export default app;
