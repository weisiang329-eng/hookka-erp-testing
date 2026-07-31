// ---------------------------------------------------------------------------
// Production Folders — archive a snapshot of selected Job Cards together so
// the operator can find them again after the paper schedule comes back from
// the floor. Each folder is just a named list of job_cards rows; no data on
// the JC is duplicated, so changes to the underlying JC stay live in the
// folder view.
//
// Created 2026-05-12 per Wei Siang feedback:
//   "我把 Production Schedule 打印出来交给他们后，如果任务完成了，我标记
//    completetion and PIC的名字，但之后想找回这些记录时会找得很辛苦. 有没有
//    可能 multi-select 几张 → 进入一个专门给我存档的 Production Schedule
//    (类似于 Create Folder 的概念) → 我可以直接批量操作..."
//
// Endpoints:
//   GET    /api/production-folders            list all folders for this org
//   POST   /api/production-folders            create a folder + optional initial JCs
//   GET    /api/production-folders/:id        folder metadata + JC ids
//   PATCH  /api/production-folders/:id        rename / edit description
//   DELETE /api/production-folders/:id        delete folder (JCs untouched)
//   POST   /api/production-folders/:id/add-jcs    push JCs into the folder
//   POST   /api/production-folders/:id/remove-jcs pop JCs out of the folder
//
// Tables (self-applied via ensurePendingMigrations):
//   production_folders (id, org_id, name, description, created_by, created_at)
//   folder_job_cards   (folder_id, job_card_id, added_at)
//     ON DELETE CASCADE on folder_id so deleting a folder cleans its rows.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { fetchPO, attachCustomerSO } from "./production-orders/_helpers";

const app = new Hono<Env>();

let pendingMigrations: Promise<void> | null = null;
function ensureSchema(db: D1Database): Promise<void> {
  if (pendingMigrations) return pendingMigrations;
  pendingMigrations = (async () => {
    const stmts = [
      // org_id is TEXT (not UUID) to match the multi-tenant skeleton from
      // migration 0049 — Hookka tables uniformly use TEXT 'hookka' as the
      // tenant scope. The 2026-05-12 first deploy declared this UUID by
      // mistake; the ALTER below idempotently flips any existing-with-UUID
      // table to TEXT.
      `CREATE TABLE IF NOT EXISTS production_folders (
         id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         org_id      TEXT NOT NULL,
         name        TEXT NOT NULL,
         description TEXT,
         created_by  TEXT,
         created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `ALTER TABLE production_folders
         ALTER COLUMN org_id TYPE TEXT USING org_id::text`,
      `CREATE TABLE IF NOT EXISTS folder_job_cards (
         folder_id   UUID NOT NULL REFERENCES production_folders(id) ON DELETE CASCADE,
         job_card_id TEXT NOT NULL,
         added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (folder_id, job_card_id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_production_folders_org_created
         ON production_folders (org_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_folder_job_cards_jc
         ON folder_job_cards (job_card_id)`,
    ];
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch (err) {
        console.warn("[production-folders.migrations] DDL skipped", {
          sql: sql.split("\n")[0],
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();
  return pendingMigrations;
}

type FolderRow = {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type FolderWithCount = FolderRow & { jc_count: number };

// GET /api/production-folders — list every folder + JC count.
app.get("/", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  await ensureSchema(c.var.DB);
  const orgId = getOrgId(c);
  const res = await c.var.DB
    .prepare(
      `SELECT f.id, f.org_id, f.name, f.description, f.created_by,
              f.created_at, f.updated_at,
              COALESCE(jc.jc_count, 0) AS jc_count
         FROM production_folders f
         LEFT JOIN (
           SELECT folder_id, COUNT(*) AS jc_count
             FROM folder_job_cards
            GROUP BY folder_id
         ) jc ON jc.folder_id = f.id
        WHERE f.org_id = ?
        ORDER BY f.created_at DESC`,
    )
    .bind(orgId)
    .all<FolderWithCount>();
  return c.json({ success: true, data: res.results ?? [] });
});

// POST /api/production-folders — create + optional initial JC list.
app.post("/", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  await ensureSchema(c.var.DB);

  type Body = { name?: string; description?: string; jobCardIds?: string[] };
  let body: Body;
  try {
    body = (await c.req.json()) as Body;
  } catch {
    return c.json({ success: false, error: "invalid JSON" }, 400);
  }
  const name = (body.name || "").trim();
  if (!name) return c.json({ success: false, error: "name required" }, 400);
  if (name.length > 200) return c.json({ success: false, error: "name too long (max 200 chars)" }, 400);

  const orgId = getOrgId(c);
  // c.var.* context keys for user identity aren't typed on Env; best-effort
  // string extraction with no-explicit-any. Falls back to "unknown" when the
  // middleware hasn't populated either key.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctxAny = c as any;
  const userEmail: string = String(ctxAny.get?.("userEmail") || ctxAny.get?.("userId") || "unknown");
  const description = (body.description || "").trim() || null;
  const jcIds = Array.isArray(body.jobCardIds) ? body.jobCardIds.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  if (jcIds.length > 500) {
    return c.json({ success: false, error: "max 500 job cards per folder on create" }, 400);
  }

  const folderId = crypto.randomUUID();
  const stmts = [
    c.var.DB
      .prepare(
        `INSERT INTO production_folders (id, org_id, name, description, created_by)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(folderId, orgId, name, description, userEmail),
  ];
  for (const jcId of jcIds) {
    stmts.push(
      c.var.DB
        .prepare(
          `INSERT INTO folder_job_cards (folder_id, job_card_id)
           VALUES (?, ?) ON CONFLICT DO NOTHING`,
        )
        .bind(folderId, jcId),
    );
  }
  await c.var.DB.batch(stmts);

  return c.json({
    success: true,
    data: { id: folderId, name, description, jc_count: jcIds.length },
  });
});

// GET /api/production-folders/:id — folder + member JC ids (lightweight).
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  await ensureSchema(c.var.DB);
  const orgId = getOrgId(c);
  const id = c.req.param("id");

  const folder = await c.var.DB
    .prepare(
      `SELECT id, org_id, name, description, created_by, created_at, updated_at
         FROM production_folders
        WHERE id = ? AND org_id = ?
        LIMIT 1`,
    )
    .bind(id, orgId)
    .first<FolderRow>();
  if (!folder) return c.json({ success: false, error: "folder not found" }, 404);

  // SELECT alias to camelCase — the SupabaseAdapter automatically maps
  // snake_case columns based on the column-rename-map, but folder_job_cards'
  // job_card_id isn't in that map (new table). Use an explicit AS so the
  // adapter's row builder gets the field under the camelCase key we expect.
  const members = await c.var.DB
    .prepare(
      `SELECT job_card_id AS "jobCardId", added_at AS "addedAt"
         FROM folder_job_cards
        WHERE folder_id = ?
        ORDER BY added_at ASC`,
    )
    .bind(id)
    .all<{ jobCardId: string; addedAt: string }>();

  return c.json({
    success: true,
    data: {
      ...folder,
      jobCardIds: (members.results ?? []).map((m) => m.jobCardId).filter(Boolean),
    },
  });
});

// GET /api/production-folders/:id/rows — the production orders (with job cards)
// that this folder's job cards belong to, in the SAME minimal PO+jobCards shape
// the list endpoint returns. folder-detail used to pull the whole ~22MB PO list
// just to filter it down to a folder's members (perf 2026-07-31); now the server
// resolves the folder → its job-card ids → their distinct POs and returns only
// those. Includes completed orders — a folder legitimately holds finished work.
app.get("/:id/rows", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  await ensureSchema(c.var.DB);
  const db = c.var.DB;
  const id = c.req.param("id");
  const orgId = getOrgId(c);
  const folder = await db
    .prepare("SELECT id FROM production_folders WHERE id = ? AND org_id = ? LIMIT 1")
    .bind(id, orgId)
    .first<{ id: string }>();
  if (!folder) return c.json({ success: false, error: "folder not found" }, 404);
  // 1) the folder's job-card ids
  const mem = await db
    .prepare('SELECT job_card_id AS "jobCardId" FROM folder_job_cards WHERE folder_id = ?')
    .bind(id)
    .all<{ jobCardId: string }>();
  const jcIds = (mem.results ?? []).map((m) => m.jobCardId).filter(Boolean);
  if (jcIds.length === 0) return c.json({ success: true, data: [] });
  // 2) the distinct production orders those job cards belong to
  const ph = jcIds.map(() => "?").join(",");
  const poRes = await db
    .prepare(`SELECT DISTINCT productionOrderId FROM job_cards WHERE id IN (${ph})`)
    .bind(...jcIds)
    .all<{ productionOrderId: string }>();
  const poIds = (poRes.results ?? []).map((r) => r.productionOrderId).filter(Boolean);
  // 3) build each PO + its job cards (minimal), reusing the shared fetchPO
  const out: NonNullable<Awaited<ReturnType<typeof fetchPO>>>[] = [];
  for (const poId of poIds) {
    const po = await fetchPO(db, poId);
    if (po) out.push(po);
  }
  await attachCustomerSO(
    db,
    out as unknown as Array<{
      salesOrderId: string;
      consignmentOrderId: string;
      customerSO: string;
    }>,
  );
  return c.json({ success: true, data: out });
});

// PATCH /api/production-folders/:id — rename / description.
app.patch("/:id", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  await ensureSchema(c.var.DB);
  const orgId = getOrgId(c);
  const id = c.req.param("id");

  type Body = { name?: string; description?: string };
  let body: Body;
  try {
    body = (await c.req.json()) as Body;
  } catch {
    return c.json({ success: false, error: "invalid JSON" }, 400);
  }

  const existing = await c.var.DB
    .prepare(
      `SELECT id FROM production_folders WHERE id = ? AND org_id = ? LIMIT 1`,
    )
    .bind(id, orgId)
    .first<{ id: string }>();
  if (!existing) return c.json({ success: false, error: "folder not found" }, 404);

  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.name !== undefined) {
    const n = body.name.trim();
    if (!n) return c.json({ success: false, error: "name cannot be empty" }, 400);
    if (n.length > 200) return c.json({ success: false, error: "name too long" }, 400);
    sets.push("name = ?");
    args.push(n);
  }
  if (body.description !== undefined) {
    sets.push("description = ?");
    args.push(body.description.trim() || null);
  }
  if (sets.length === 0) return c.json({ success: true, data: { id } });
  sets.push("updated_at = now()");
  args.push(id);

  await c.var.DB
    .prepare(
      `UPDATE production_folders SET ${sets.join(", ")} WHERE id = ?`,
    )
    .bind(...args)
    .run();
  return c.json({ success: true, data: { id } });
});

// DELETE /api/production-folders/:id — drops folder + folder_job_cards rows
// via ON DELETE CASCADE. The underlying JCs are NOT touched.
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  await ensureSchema(c.var.DB);
  const orgId = getOrgId(c);
  const id = c.req.param("id");

  const existing = await c.var.DB
    .prepare(
      `SELECT id FROM production_folders WHERE id = ? AND org_id = ? LIMIT 1`,
    )
    .bind(id, orgId)
    .first<{ id: string }>();
  if (!existing) return c.json({ success: false, error: "folder not found" }, 404);

  await c.var.DB.prepare(`DELETE FROM production_folders WHERE id = ?`).bind(id).run();
  return c.json({ success: true });
});

// POST /api/production-folders/:id/add-jcs — push JCs into folder.
app.post("/:id/add-jcs", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  await ensureSchema(c.var.DB);
  const orgId = getOrgId(c);
  const id = c.req.param("id");

  type Body = { jobCardIds?: string[] };
  let body: Body;
  try {
    body = (await c.req.json()) as Body;
  } catch {
    return c.json({ success: false, error: "invalid JSON" }, 400);
  }
  const jcIds = Array.isArray(body.jobCardIds) ? body.jobCardIds.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  if (jcIds.length === 0) return c.json({ success: false, error: "jobCardIds required" }, 400);
  if (jcIds.length > 500) return c.json({ success: false, error: "max 500 per call" }, 400);

  const existing = await c.var.DB
    .prepare(`SELECT id FROM production_folders WHERE id = ? AND org_id = ? LIMIT 1`)
    .bind(id, orgId)
    .first<{ id: string }>();
  if (!existing) return c.json({ success: false, error: "folder not found" }, 404);

  const stmts = jcIds.map((jcId) =>
    c.var.DB
      .prepare(
        `INSERT INTO folder_job_cards (folder_id, job_card_id)
         VALUES (?, ?) ON CONFLICT DO NOTHING`,
      )
      .bind(id, jcId),
  );
  stmts.push(
    c.var.DB
      .prepare(`UPDATE production_folders SET updated_at = now() WHERE id = ?`)
      .bind(id),
  );
  const results = await c.var.DB.batch(stmts);
  let added = 0;
  for (let i = 0; i < jcIds.length; i++) {
    const r = results[i] as unknown as { meta?: { changes?: number } };
    if ((r.meta?.changes ?? 0) > 0) added++;
  }

  return c.json({ success: true, data: { added, requested: jcIds.length } });
});

// POST /api/production-folders/:id/remove-jcs — pop JCs out of folder.
app.post("/:id/remove-jcs", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  await ensureSchema(c.var.DB);
  const orgId = getOrgId(c);
  const id = c.req.param("id");

  type Body = { jobCardIds?: string[] };
  let body: Body;
  try {
    body = (await c.req.json()) as Body;
  } catch {
    return c.json({ success: false, error: "invalid JSON" }, 400);
  }
  const jcIds = Array.isArray(body.jobCardIds) ? body.jobCardIds.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  if (jcIds.length === 0) return c.json({ success: false, error: "jobCardIds required" }, 400);

  const existing = await c.var.DB
    .prepare(`SELECT id FROM production_folders WHERE id = ? AND org_id = ? LIMIT 1`)
    .bind(id, orgId)
    .first<{ id: string }>();
  if (!existing) return c.json({ success: false, error: "folder not found" }, 404);

  // Inline IN (...) — Postgres adapter handles up to ~500 binds easily.
  const placeholders = jcIds.map(() => "?").join(",");
  const stmts = [
    c.var.DB
      .prepare(
        `DELETE FROM folder_job_cards
          WHERE folder_id = ? AND job_card_id IN (${placeholders})`,
      )
      .bind(id, ...jcIds),
    c.var.DB
      .prepare(`UPDATE production_folders SET updated_at = now() WHERE id = ?`)
      .bind(id),
  ];
  const results = await c.var.DB.batch(stmts);
  const removed = (results[0] as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  return c.json({ success: true, data: { removed, requested: jcIds.length } });
});

export default app;
