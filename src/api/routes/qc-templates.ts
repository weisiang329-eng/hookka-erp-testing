// ---------------------------------------------------------------------------
// QC Templates — checklist definitions (Phase 1).
//
// One template per (department × product_category × stage) combination.
// Each template has N items (qc_template_items). When the cron generates a
// PENDING qc_inspection it snapshots the items into the inspection row so
// historical inspections survive future template edits.
//
// Schema: migrations-postgres/0066_qc_module_phase1.sql
//
// Endpoints:
//   GET    /                — list templates (?active=1, ?stage=, ?deptCode=, ?itemCategory=)
//   GET    /:id             — one template + its items
//   POST   /                — create template (with items)
//   PUT    /:id             — update template (replaces items if items array provided)
//   DELETE /:id             — soft-delete (sets active=0). Hard-delete only if no inspection references it.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type Stage = "RM" | "WIP" | "FG";
type ItemCategory = "SOFA" | "BEDFRAME" | "ACCESSORY" | "GENERAL";
type Severity = "MINOR" | "MAJOR" | "CRITICAL";

const VALID_STAGES: Stage[] = ["RM", "WIP", "FG"];
const VALID_CATEGORIES: ItemCategory[] = ["SOFA", "BEDFRAME", "ACCESSORY", "GENERAL"];
const VALID_SEVERITIES: Severity[] = ["MINOR", "MAJOR", "CRITICAL"];

type TemplateRow = {
  id: string;
  name: string;
  deptCode: string;
  deptName: string | null;
  itemCategory: ItemCategory;
  stage: Stage;
  active: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string | null;
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

function genTemplateId(): string {
  return `qct-${crypto.randomUUID().slice(0, 8)}`;
}
function genItemId(): string {
  return `qcti-${crypto.randomUUID().slice(0, 8)}`;
}

function rowToTemplate(t: TemplateRow, items: TemplateItemRow[] = []) {
  return {
    id: t.id,
    name: t.name,
    deptCode: t.deptCode,
    deptName: t.deptName ?? "",
    itemCategory: t.itemCategory,
    stage: t.stage,
    active: t.active === 1,
    notes: t.notes ?? "",
    createdAt: t.createdAt,
    updatedAt: t.updatedAt ?? "",
    items: items
      .filter((i) => i.templateId === t.id)
      .sort((a, b) => a.sequence - b.sequence)
      .map((i) => ({
        id: i.id,
        sequence: i.sequence,
        itemName: i.itemName,
        criteria: i.criteria ?? "",
        severity: i.severity,
        isMandatory: i.isMandatory === 1,
      })),
  };
}

// ---- GET /api/qc-templates ----------------------------------------------
app.get("/", async (c) => {
  const active = c.req.query("active");
  const stage = c.req.query("stage");
  const deptCode = c.req.query("deptCode");
  const itemCategory = c.req.query("itemCategory");

  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (active === "1" || active === "0") {
    clauses.push("active = ?");
    params.push(Number(active));
  }
  if (stage) {
    clauses.push("stage = ?");
    params.push(stage);
  }
  if (deptCode) {
    clauses.push("deptCode = ?");
    params.push(deptCode);
  }
  if (itemCategory) {
    clauses.push("itemCategory = ?");
    params.push(itemCategory);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const [tplRes, itemRes] = await Promise.all([
    c.var.DB
      .prepare(`SELECT * FROM qc_templates ${where} ORDER BY deptCode, itemCategory, stage, name`)
      .bind(...params)
      .all<TemplateRow>(),
    c.var.DB.prepare("SELECT * FROM qc_template_items").all<TemplateItemRow>(),
  ]);

  const data = (tplRes.results ?? []).map((t) => rowToTemplate(t, itemRes.results ?? []));
  return c.json({ success: true, data, total: data.length });
});

// ---- GET /api/qc-templates/:id ------------------------------------------
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [tpl, items] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM qc_templates WHERE id = ?").bind(id).first<TemplateRow>(),
    c.var.DB
      .prepare("SELECT * FROM qc_template_items WHERE templateId = ? ORDER BY sequence")
      .bind(id)
      .all<TemplateItemRow>(),
  ]);
  if (!tpl) return c.json({ success: false, error: "Template not found" }, 404);
  return c.json({ success: true, data: rowToTemplate(tpl, items.results ?? []) });
});

// ---- POST /api/qc-templates ---------------------------------------------
// Body: { name, deptCode, deptName?, itemCategory, stage, notes?, items: [{itemName, criteria?, severity, isMandatory?}] }
app.post("/", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const name = String(body.name ?? "").trim();
    const deptCode = String(body.deptCode ?? "").trim();
    const deptName = body.deptName ? String(body.deptName) : null;
    const itemCategory = body.itemCategory as ItemCategory;
    const stage = body.stage as Stage;
    const items = Array.isArray(body.items) ? body.items : [];

    if (!name) return c.json({ success: false, error: "name is required" }, 400);
    if (!deptCode) return c.json({ success: false, error: "deptCode is required" }, 400);
    if (!VALID_CATEGORIES.includes(itemCategory)) {
      return c.json({ success: false, error: `itemCategory must be one of ${VALID_CATEGORIES.join("/")}` }, 400);
    }
    if (!VALID_STAGES.includes(stage)) {
      return c.json({ success: false, error: `stage must be one of ${VALID_STAGES.join("/")}` }, 400);
    }
    if (items.length === 0) {
      return c.json({ success: false, error: "At least one check item is required" }, 400);
    }

    const id = genTemplateId();
    const now = new Date().toISOString();
    const stmts: D1PreparedStatement[] = [];

    stmts.push(
      c.var.DB
        .prepare(
          `INSERT INTO qc_templates (id, name, deptCode, deptName, itemCategory, stage, active, notes, created_at, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .bind(id, name, deptCode, deptName, itemCategory, stage, body.notes ?? null, now, now),
    );

    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx] as Record<string, unknown>;
      const itemName = String(it.itemName ?? "").trim();
      if (!itemName) {
        return c.json({ success: false, error: `items[${idx}].itemName is required` }, 400);
      }
      const sev = (it.severity as Severity) ?? "MAJOR";
      if (!VALID_SEVERITIES.includes(sev)) {
        return c.json({ success: false, error: `items[${idx}].severity invalid` }, 400);
      }
      stmts.push(
        c.var.DB
          .prepare(
            `INSERT INTO qc_template_items (id, templateId, sequence, itemName, criteria, severity, isMandatory)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            genItemId(),
            id,
            (it.sequence as number) ?? idx + 1,
            itemName,
            (it.criteria as string) ?? null,
            sev,
            it.isMandatory === false ? 0 : 1,
          ),
      );
    }

    await c.var.DB.batch(stmts);

    const [tpl, itemRes] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM qc_templates WHERE id = ?").bind(id).first<TemplateRow>(),
      c.var.DB.prepare("SELECT * FROM qc_template_items WHERE templateId = ?").bind(id).all<TemplateItemRow>(),
    ]);
    if (!tpl) return c.json({ success: false, error: "Failed to reload template" }, 500);
    return c.json({ success: true, data: rowToTemplate(tpl, itemRes.results ?? []) }, 201);
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : "Invalid request body" }, 400);
  }
});

// ---- PUT /api/qc-templates/:id ------------------------------------------
// Replaces items wholesale if `items` array is provided.
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB
      .prepare("SELECT * FROM qc_templates WHERE id = ?")
      .bind(id)
      .first<TemplateRow>();
    if (!existing) return c.json({ success: false, error: "Template not found" }, 404);

    const body = await c.req.json();
    const merged = {
      name: body.name ?? existing.name,
      deptCode: body.deptCode ?? existing.deptCode,
      deptName: body.deptName ?? existing.deptName,
      itemCategory: body.itemCategory ?? existing.itemCategory,
      stage: body.stage ?? existing.stage,
      active: body.active === undefined ? existing.active : body.active === false ? 0 : 1,
      notes: body.notes ?? existing.notes,
    };
    if (merged.itemCategory && !VALID_CATEGORIES.includes(merged.itemCategory as ItemCategory)) {
      return c.json({ success: false, error: "itemCategory invalid" }, 400);
    }
    if (merged.stage && !VALID_STAGES.includes(merged.stage as Stage)) {
      return c.json({ success: false, error: "stage invalid" }, 400);
    }

    const now = new Date().toISOString();
    await c.var.DB
      .prepare(
        `UPDATE qc_templates SET name = ?, deptCode = ?, deptName = ?, itemCategory = ?, stage = ?, active = ?, notes = ?, updatedAt = ? WHERE id = ?`,
      )
      .bind(
        merged.name,
        merged.deptCode,
        merged.deptName,
        merged.itemCategory,
        merged.stage,
        merged.active,
        merged.notes,
        now,
        id,
      )
      .run();

    if (Array.isArray(body.items)) {
      await c.var.DB.prepare("DELETE FROM qc_template_items WHERE templateId = ?").bind(id).run();
      const itemStmts: D1PreparedStatement[] = [];
      for (let idx = 0; idx < body.items.length; idx++) {
        const it = body.items[idx] as Record<string, unknown>;
        const itemName = String(it.itemName ?? "").trim();
        if (!itemName) continue;
        const sev = (it.severity as Severity) ?? "MAJOR";
        itemStmts.push(
          c.var.DB
            .prepare(
              `INSERT INTO qc_template_items (id, templateId, sequence, itemName, criteria, severity, isMandatory)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              (it.id as string) || genItemId(),
              id,
              (it.sequence as number) ?? idx + 1,
              itemName,
              (it.criteria as string) ?? null,
              sev,
              it.isMandatory === false ? 0 : 1,
            ),
        );
      }
      if (itemStmts.length) await c.var.DB.batch(itemStmts);
    }

    const [tpl, itemRes] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM qc_templates WHERE id = ?").bind(id).first<TemplateRow>(),
      c.var.DB.prepare("SELECT * FROM qc_template_items WHERE templateId = ?").bind(id).all<TemplateItemRow>(),
    ]);
    if (!tpl) return c.json({ success: false, error: "Template not found after update" }, 500);
    return c.json({ success: true, data: rowToTemplate(tpl, itemRes.results ?? []) });
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : "Invalid request body" }, 400);
  }
});

// ---- DELETE /api/qc-templates/:id ---------------------------------------
// Soft-delete by default (sets active=0). Pass ?hard=1 to hard-delete; that
// only succeeds if no qc_inspections row references this template.
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "qc-inspections", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const hard = c.req.query("hard") === "1";
  const existing = await c.var.DB
    .prepare("SELECT * FROM qc_templates WHERE id = ?")
    .bind(id)
    .first<TemplateRow>();
  if (!existing) return c.json({ success: false, error: "Template not found" }, 404);

  if (hard) {
    const refRes = await c.var.DB
      .prepare("SELECT COUNT(*) as n FROM qc_inspections WHERE templateId = ?")
      .bind(id)
      .first<{ n: number }>();
    if ((refRes?.n ?? 0) > 0) {
      return c.json(
        {
          success: false,
          error: `Cannot hard-delete: ${refRes?.n} inspection(s) reference this template. Soft-delete (active=0) is fine.`,
        },
        409,
      );
    }
    await c.var.DB.prepare("DELETE FROM qc_templates WHERE id = ?").bind(id).run();
  } else {
    await c.var.DB
      .prepare("UPDATE qc_templates SET active = 0, updatedAt = ? WHERE id = ?")
      .bind(new Date().toISOString(), id)
      .run();
  }

  return c.json({ success: true, data: { id, deleted: hard, deactivated: !hard } });
});

export default app;
