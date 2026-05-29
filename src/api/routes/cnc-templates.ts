// ---------------------------------------------------------------------------
// CNC fabric-cutting templates route.
//
// A "CNC template" is one named set of up to three CAD/cutter files
// (.dgt / .prj / .emf) the CNC fabric cutter loads to cut a specific product
// piece (ARM, CUSHION, DIVAN ...) at a specific size and fabric width. The
// file BYTES live in Supabase Storage (bucket "hookka-files"); this table
// stores only metadata + the opaque storage object keys. The keys are NEVER
// returned to the client — list/get expose hasDgt/hasPrj/hasEmf booleans
// instead, and downloads flow through GET /:id/file/:kind (a signed-URL 302
// or a worker-proxied stream).
//
// Storage backend: reuses src/api/lib/supabase-storage.ts (putFile / getFile /
// signedDownloadUrl / deleteFile). When SUPABASE_PROJECT_REF /
// SUPABASE_SERVICE_KEY aren't configured the helper throws
// SupabaseStorageNotConfiguredError, which every storage-touching route here
// catches and maps to HTTP 503 (the page degrades cleanly instead of 500ing).
//
// NOTE: the SupabaseAdapter rewrites SQL identifiers to snake_case on the way
// IN, and postgres.js's transform.column.from returns result rows with
// camelCase keys on the way OUT (same pattern as packing-lists.ts /
// delivery-orders.ts). So the SQL strings below use snake_case column names,
// but every result row is read as camelCase.
//
// Migration: migrations-postgres/0140_cnc_templates.sql (apply with
// `npm run db:migrate:supabase`).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { emitAudit } from "../lib/audit";
import {
  SupabaseStorageNotConfiguredError,
  DEFAULT_BUCKET,
  putFile,
  getFile,
  signedDownloadUrl,
  deleteFile,
} from "../lib/supabase-storage";

const app = new Hono<Env>();

// The three file kinds a template can carry, and the row column each maps to.
type FileKind = "dgt" | "prj" | "emf";
const FILE_KINDS: FileKind[] = ["dgt", "prj", "emf"];

// Raw row as it comes back from the adapter (camelCase keys, snake_case in SQL).
type CncTemplateRow = {
  id: string;
  orgId: string;
  productCode: string | null;
  sizeLabel: string | null;
  fabricWidth: string | null;
  pieceLabel: string | null;
  displayName: string | null;
  folder: string | null;
  dgtKey: string | null;
  prjKey: string | null;
  emfKey: string | null;
  driveFolderId: string | null;
  sizeBytes: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const SELECT_COLS =
  "id, org_id, product_code, size_label, fabric_width, piece_label, display_name, folder, dgt_key, prj_key, emf_key, drive_folder_id, size_bytes, created_at, updated_at";

// Client-facing shape. The raw storage keys (dgt_key/prj_key/emf_key) are
// deliberately NOT leaked — only the presence booleans are.
function rowToCncTemplate(r: CncTemplateRow) {
  return {
    id: r.id,
    productCode: r.productCode ?? "",
    sizeLabel: r.sizeLabel ?? "",
    fabricWidth: r.fabricWidth ?? "",
    pieceLabel: r.pieceLabel ?? "",
    displayName: r.displayName ?? "",
    folder: r.folder ?? "",
    hasDgt: Boolean(r.dgtKey && r.dgtKey.length > 0),
    hasPrj: Boolean(r.prjKey && r.prjKey.length > 0),
    hasEmf: Boolean(r.emfKey && r.emfKey.length > 0),
    sizeBytes: Number(r.sizeBytes ?? 0),
    updatedAt: r.updatedAt,
  };
}

function isMissingTable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /relation .*cnc_templates.* does not exist|no such table/i.test(msg);
}

// Pick the storage key column for a given file kind off a row.
function keyForKind(r: CncTemplateRow, kind: FileKind): string {
  if (kind === "dgt") return r.dgtKey ?? "";
  if (kind === "prj") return r.prjKey ?? "";
  return r.emfKey ?? "";
}

// Strip path traversal from a filename — keep the basename only.
function safeBasename(name: string): string {
  return name.split(/[\\/]/).pop() || "file";
}

function genId(): string {
  return `cnc-${crypto.randomUUID().slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// GET / — list templates. Optional ?q= (case-insensitive on product_code /
// display_name / piece_label) and ?productCode= exact filter. Ordered by
// product_code, size_label.
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const denied = await requirePermission(c, "products", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const q = (c.req.query("q") ?? "").trim();
  const productCode = (c.req.query("productCode") ?? "").trim();

  let sql = `SELECT ${SELECT_COLS} FROM cnc_templates WHERE org_id = ?`;
  const binds: unknown[] = [orgId];
  if (productCode) {
    sql += " AND product_code = ?";
    binds.push(productCode);
  }
  if (q) {
    // LOWER(col) LIKE LOWER(?) — case-insensitive substring match across the
    // three searchable columns.
    sql +=
      " AND (LOWER(product_code) LIKE LOWER(?) OR LOWER(display_name) LIKE LOWER(?) OR LOWER(piece_label) LIKE LOWER(?))";
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  sql += " ORDER BY product_code, size_label";

  try {
    const res = await c.var.DB.prepare(sql)
      .bind(...binds)
      .all<CncTemplateRow>();
    const data = (res.results ?? []).map(rowToCncTemplate);
    return c.json({ success: true, data });
  } catch (e) {
    // Table not migrated yet — don't break the page; return empty.
    if (isMissingTable(e)) return c.json({ success: true, data: [] });
    throw e;
  }
});

// ---------------------------------------------------------------------------
// GET /:id — one template (metadata only).
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, "products", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  try {
    const row = await c.var.DB.prepare(
      `SELECT ${SELECT_COLS} FROM cnc_templates WHERE id = ? AND org_id = ?`,
    )
      .bind(id, orgId)
      .first<CncTemplateRow>();
    if (!row) return c.json({ success: false, error: "Template not found." }, 404);
    return c.json({ success: true, data: rowToCncTemplate(row) });
  } catch (e) {
    if (isMissingTable(e))
      return c.json({ success: false, error: "Template not found." }, 404);
    throw e;
  }
});

// ---------------------------------------------------------------------------
// GET /:id/file/:kind — download one file (kind ∈ {dgt,prj,emf}).
// Prefers a short-lived signed-URL 302; falls back to a worker-proxied stream
// when signing isn't available on this runtime.
// ---------------------------------------------------------------------------
app.get("/:id/file/:kind", async (c) => {
  const denied = await requirePermission(c, "products", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  const kindParam = c.req.param("kind").toLowerCase();
  if (!FILE_KINDS.includes(kindParam as FileKind)) {
    return c.json({ success: false, error: "Invalid file kind." }, 400);
  }
  const kind = kindParam as FileKind;

  let row: CncTemplateRow | null;
  try {
    row = await c.var.DB.prepare(
      `SELECT ${SELECT_COLS} FROM cnc_templates WHERE id = ? AND org_id = ?`,
    )
      .bind(id, orgId)
      .first<CncTemplateRow>();
  } catch (e) {
    if (isMissingTable(e))
      return c.json({ success: false, error: "Template not found." }, 404);
    throw e;
  }
  if (!row) return c.json({ success: false, error: "Template not found." }, 404);

  const key = keyForKind(row, kind);
  if (!key) {
    return c.json(
      { success: false, error: `This template has no .${kind} file.` },
      404,
    );
  }

  try {
    const url = await signedDownloadUrl(c.env, DEFAULT_BUCKET, key, 300);
    if (url) return c.redirect(url, 302);

    // Signing unavailable on this runtime — stream the bytes via the worker.
    const obj = await getFile(c.env, DEFAULT_BUCKET, key);
    if (!obj) return c.json({ success: false, error: "File not found." }, 404);
    const filename = `${safeBasename(row.displayName || row.id)}.${kind}`;
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.contentType || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof SupabaseStorageNotConfiguredError) {
      return c.json({ success: false, error: "File storage unavailable." }, 503);
    }
    console.error("[cnc-templates/file] download failed:", err);
    return c.json({ success: false, error: "Download failed." }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST / — create one template (multipart/form-data). Fields: productCode,
// sizeLabel, fabricWidth, pieceLabel, displayName, folder, plus up to 3 files
// (form fields named dgt / prj / emf). Each provided file is uploaded under
// cnc-templates/<productCode>/<displayName>.<ext> and its key stored.
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "products", "create");
  if (denied) return denied;
  const orgId = getOrgId(c);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ success: false, error: "Invalid multipart body." }, 400);
  }

  const productCode = String(form.get("productCode") ?? "").trim();
  const sizeLabel = String(form.get("sizeLabel") ?? "").trim();
  const fabricWidth = String(form.get("fabricWidth") ?? "").trim();
  const pieceLabel = String(form.get("pieceLabel") ?? "").trim();
  const displayName = String(form.get("displayName") ?? "").trim();
  const folder = String(form.get("folder") ?? "").trim();

  if (!productCode) {
    return c.json({ success: false, error: "productCode is required." }, 400);
  }
  if (!displayName) {
    return c.json({ success: false, error: "displayName is required." }, 400);
  }

  // Gather the provided files keyed by kind.
  const files: Partial<Record<FileKind, File>> = {};
  for (const kind of FILE_KINDS) {
    const f = form.get(kind);
    if (f instanceof File && f.size > 0) files[kind] = f;
  }

  const id = genId();
  const now = new Date().toISOString();
  // Key scheme: cnc-templates/<productCode>/<displayName>.<ext>. Strip any
  // path traversal from displayName so it can't escape the prefix.
  const keyBase = `cnc-templates/${productCode}/${safeBasename(displayName)}`;

  const keys: Record<FileKind, string> = { dgt: "", prj: "", emf: "" };
  let totalBytes = 0;
  const uploaded: string[] = [];

  try {
    for (const kind of FILE_KINDS) {
      const f = files[kind];
      if (!f) continue;
      const key = `${keyBase}.${kind}`;
      const ct = f.type || "application/octet-stream";
      await putFile(c.env, DEFAULT_BUCKET, key, await f.arrayBuffer(), ct);
      keys[kind] = key;
      totalBytes += f.size;
      uploaded.push(key);
    }

    await c.var.DB.prepare(
      `INSERT INTO cnc_templates
         (id, org_id, product_code, size_label, fabric_width, piece_label,
          display_name, folder, dgt_key, prj_key, emf_key, drive_folder_id,
          size_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        orgId,
        productCode,
        sizeLabel,
        fabricWidth,
        pieceLabel,
        displayName,
        folder,
        keys.dgt,
        keys.prj,
        keys.emf,
        "",
        totalBytes,
        now,
        now,
      )
      .run();

    await emitAudit(c, {
      resource: "cnc-templates",
      resourceId: id,
      action: "create",
      after: { productCode, sizeLabel, fabricWidth, pieceLabel, displayName, sizeBytes: totalBytes },
    }).catch(() => {});

    const created = await c.var.DB.prepare(
      `SELECT ${SELECT_COLS} FROM cnc_templates WHERE id = ?`,
    )
      .bind(id)
      .first<CncTemplateRow>();
    return c.json(
      { success: true, data: created ? rowToCncTemplate(created) : null },
      201,
    );
  } catch (err) {
    if (err instanceof SupabaseStorageNotConfiguredError) {
      return c.json({ success: false, error: "File storage unavailable." }, 503);
    }
    if (isMissingTable(err)) {
      return c.json(
        {
          success: false,
          error:
            "CNC template storage is not set up yet. Apply migration 0140.",
        },
        503,
      );
    }
    // Best-effort cleanup of any objects we uploaded before the failure.
    for (const key of uploaded) {
      try {
        await deleteFile(c.env, DEFAULT_BUCKET, key);
      } catch {
        // Already gone / transient — a sweeper will catch the orphan.
      }
    }
    console.error("[cnc-templates/POST] create failed:", err);
    return c.json(
      { success: false, error: err instanceof Error ? err.message : "Create failed." },
      400,
    );
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id — remove a template: drop the 3 storage objects (ignore
// missing), then the row.
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "products", "delete");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const id = c.req.param("id");

  let row: CncTemplateRow | null;
  try {
    row = await c.var.DB.prepare(
      `SELECT ${SELECT_COLS} FROM cnc_templates WHERE id = ? AND org_id = ?`,
    )
      .bind(id, orgId)
      .first<CncTemplateRow>();
  } catch (e) {
    if (isMissingTable(e))
      return c.json({ success: false, error: "Template not found." }, 404);
    throw e;
  }
  if (!row) return c.json({ success: false, error: "Template not found." }, 404);

  // Delete the storage objects best-effort. Missing keys are a no-op
  // (deleteFile is idempotent); storage-not-configured is non-fatal — we
  // still drop the DB row so the list reflects the operator's intent.
  for (const kind of FILE_KINDS) {
    const key = keyForKind(row, kind);
    if (!key) continue;
    try {
      await deleteFile(c.env, DEFAULT_BUCKET, key);
    } catch (err) {
      if (err instanceof SupabaseStorageNotConfiguredError) {
        console.warn(
          "[cnc-templates/DELETE] storage unavailable — dropping DB row only, leaving orphan key",
          key,
        );
      } else {
        console.error("[cnc-templates/DELETE] storage delete failed:", err);
        return c.json({ success: false, error: "Delete failed." }, 500);
      }
    }
  }

  await c.var.DB.prepare("DELETE FROM cnc_templates WHERE id = ? AND org_id = ?")
    .bind(id, orgId)
    .run();

  await emitAudit(c, {
    resource: "cnc-templates",
    resourceId: id,
    action: "delete",
  }).catch(() => {});

  return c.json({ success: true });
});

export default app;
