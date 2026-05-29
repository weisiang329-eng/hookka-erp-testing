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
// Filename parsing for the BULK import endpoint.
//
// Files arrive named by a BUYI cutter naming convention that the operator
// types by hand, so it's loose and inconsistent. We parse the base filename
// (extension stripped) into the structured columns best-effort. The parser
// NEVER throws — when a token can't be classified it lands in pieceLabel, and
// the worst case falls back to productCode='' + pieceLabel=base so the row is
// still importable and editable later.
//
// Worked examples (base → parsed fields):
//   "1007 5 FT 20' dgt"  → code 1007, size 5FT,   width 20',  piece ""
//   "2041 6FT 24''"      → code 2041, size 6FT,   width 24'', piece ""
//   "5535 ARM"           → code 5535, size "",    width "",   piece ARM
//   "5535 CUSHION 30'"   → code 5535, size "",    width 30',  piece CUSHION
//   "1013-1"             → code 1013, size "",    width "",   piece 1
// ---------------------------------------------------------------------------

// File extensions we accept. Anything else is ignored by the importer.
const IMPORT_EXTS = new Set(["dgt", "prj", "emf"]);

// Recognised "piece" words from the cutter convention. Matched case-insensitively.
const PIECE_WORDS = new Set([
  "ARM",
  "TANGAN",
  "CUSHION",
  "DIVAN",
  "2S",
  "3S",
  "1S",
  "NA",
  "HB",
]);

type ParsedTemplateName = {
  productCode: string;
  sizeLabel: string;
  fabricWidth: string;
  pieceLabel: string;
};

// Split "name.ext" into [base, ext-lowercased]. A filename with no dot returns
// an empty extension. Path separators are stripped first (defence in depth —
// the caller already takes the basename).
function splitNameExt(filename: string): { base: string; ext: string } {
  const name = safeBasename(filename);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() };
}

// Remove a trailing literal "dgt" word from a base (e.g. "1007 5 FT 20' dgt").
// Some operators append the kind to the name; it isn't part of the identity.
function stripTrailingDgtWord(base: string): string {
  return base.replace(/[\s_-]+dgt\s*$/i, "").trim();
}

// A token looks like a fabric width when it's digits followed by one or two
// inch marks: 20', 24'', 30'. (NOT a foot size — those carry an explicit FT.)
function isWidthToken(tok: string): boolean {
  return /^\d+\s*''?'?$/.test(tok) && /['']/.test(tok);
}

// A token looks like a foot size when it's a number followed by FT: 5FT, 3.5FT.
function isSizeToken(tok: string): boolean {
  return /^\d+(\.\d+)?\s*FT$/i.test(tok);
}

// Normalise a foot-size token to the compact "5FT" / "3.5FT" form.
function normalizeSizeToken(tok: string): string {
  const m = tok.match(/^(\d+(?:\.\d+)?)\s*FT$/i);
  return m ? `${m[1]}FT` : tok;
}

// Parse a base filename into structured fields. Tolerant + never throws.
function parseTemplateName(rawBase: string): ParsedTemplateName {
  const base = stripTrailingDgtWord(rawBase);
  const result: ParsedTemplateName = {
    productCode: "",
    sizeLabel: "",
    fabricWidth: "",
    pieceLabel: "",
  };
  try {
    if (!base) return result;

    // productCode = leading token: digits, optionally a trailing letter and/or
    // a parenthesised group (e.g. "1007", "315A", "BO315(2)"), up to the first
    // space or '-'. We anchor on the start of the string.
    const codeMatch = base.match(/^([A-Za-z]*\d+[A-Za-z]?(?:\([^)]*\))?)/);
    if (codeMatch) result.productCode = codeMatch[1];

    // Remainder after the productCode, split on spaces, '-', and underscores
    // into candidate tokens. The leading separator (space or '-') is consumed.
    const rest = base.slice(result.productCode.length).replace(/^[\s_-]+/, "");
    const tokens = rest.split(/[\s_]+/).flatMap((t) => t.split("-")).filter(Boolean);

    const leftovers: string[] = [];
    // Foot sizes can arrive as two tokens ("5" then "FT") — fold a bare number
    // followed by a standalone "FT" back together before classifying.
    const merged: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const cur = tokens[i];
      const next = tokens[i + 1];
      if (/^\d+(\.\d+)?$/.test(cur) && next && /^FT$/i.test(next)) {
        merged.push(`${cur}${next}`);
        i++; // consume the FT token
      } else {
        merged.push(cur);
      }
    }

    for (const tok of merged) {
      if (!result.sizeLabel && isSizeToken(tok)) {
        result.sizeLabel = normalizeSizeToken(tok);
      } else if (!result.fabricWidth && isWidthToken(tok)) {
        result.fabricWidth = tok.replace(/\s+/g, "");
      } else if (!result.pieceLabel && PIECE_WORDS.has(tok.toUpperCase())) {
        result.pieceLabel = tok.toUpperCase();
      } else {
        leftovers.push(tok);
      }
    }

    // Any non-size/non-width token that wasn't a recognised piece word still
    // carries meaning (e.g. "1" in "1013-1", or an unlisted piece name). Fold
    // the leftovers into pieceLabel if we don't already have one.
    if (!result.pieceLabel && leftovers.length > 0) {
      result.pieceLabel = leftovers.join(" ");
    }

    // Last-resort guard: if we couldn't even find a productCode, keep the whole
    // base as the pieceLabel so the row is still meaningful and editable.
    if (!result.productCode && !result.pieceLabel) {
      result.pieceLabel = base;
    }
  } catch {
    // Defensive: never let a weird filename break the whole import batch.
    return { productCode: "", sizeLabel: "", fabricWidth: "", pieceLabel: base };
  }
  return result;
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
// POST /import — BULK upload. multipart/form-data with one or more files under
// the repeated field name `files` (accept .dgt / .prj / .emf only). The server
// PARSES each filename into productCode / sizeLabel / fabricWidth / pieceLabel
// (see parseTemplateName), GROUPS files that share the same
// (productCode, base-without-trailing-"dgt") into ONE row, and UPSERTs:
//   * existing row with the same (product_code, display_name) → update its
//     dgt_key/prj_key/emf_key + size_bytes (re-uploading any kind replaces it)
//   * otherwise → insert a new row
// Returns { success, imported: <rows>, files: <accepted files>, rows: [...] }.
// ---------------------------------------------------------------------------
app.post("/import", async (c) => {
  const denied = await requirePermission(c, "products", "create");
  if (denied) return denied;
  const orgId = getOrgId(c);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ success: false, error: "Invalid multipart body." }, 400);
  }

  // Collect every uploaded file under the repeated `files` field.
  const incoming = form
    .getAll("files")
    .filter((v): v is File => v instanceof File && v.size > 0);
  if (incoming.length === 0) {
    return c.json({ success: false, error: "No files were uploaded." }, 400);
  }

  // Group files by (productCode + display identity). The display identity is
  // the base filename with any trailing "dgt" word stripped, so the .dgt/.prj/
  // .emf trio that share a base collapse into one row.
  type Group = {
    parsed: ParsedTemplateName;
    displayName: string;
    files: Partial<Record<FileKind, File>>;
  };
  const groups = new Map<string, Group>();
  let acceptedFiles = 0;

  for (const file of incoming) {
    const { base, ext } = splitNameExt(file.name);
    if (!IMPORT_EXTS.has(ext)) continue; // ignore non-cutter extensions
    const kind = ext as FileKind;
    const identity = stripTrailingDgtWord(base);
    const parsed = parseTemplateName(base);
    // displayName is the base verbatim (sans trailing "dgt"), so the trio
    // shares one display name and one row.
    const displayName = identity || base;
    const groupKey = `${parsed.productCode}|${displayName.toLowerCase()}`;

    let g = groups.get(groupKey);
    if (!g) {
      g = { parsed, displayName, files: {} };
      groups.set(groupKey, g);
    }
    // Last one wins if the same kind appears twice in the batch.
    g.files[kind] = file;
    acceptedFiles++;
  }

  if (groups.size === 0) {
    return c.json(
      {
        success: false,
        error: "No .dgt / .prj / .emf files found in the upload.",
      },
      400,
    );
  }

  const now = new Date().toISOString();
  const outRows: ReturnType<typeof rowToCncTemplate>[] = [];
  const uploaded: string[] = []; // track for best-effort cleanup on failure

  try {
    for (const g of groups.values()) {
      const productCode = g.parsed.productCode;
      const displayName = g.displayName;

      // Upload each provided kind under the existing key scheme:
      // cnc-templates/<productCode>/<displayName>.<ext>
      const keyBase = `cnc-templates/${productCode}/${safeBasename(displayName)}`;
      const newKeys: Partial<Record<FileKind, string>> = {};
      let batchBytes = 0;
      for (const kind of FILE_KINDS) {
        const f = g.files[kind];
        if (!f) continue;
        const key = `${keyBase}.${kind}`;
        const ct = f.type || "application/octet-stream";
        await putFile(c.env, DEFAULT_BUCKET, key, await f.arrayBuffer(), ct);
        newKeys[kind] = key;
        batchBytes += f.size;
        uploaded.push(key);
      }

      // Look for an existing row with the same (product_code, display_name).
      const existing = await c.var.DB.prepare(
        `SELECT ${SELECT_COLS} FROM cnc_templates
           WHERE org_id = ? AND product_code = ? AND display_name = ?`,
      )
        .bind(orgId, productCode, displayName)
        .first<CncTemplateRow>();

      let rowId: string;
      if (existing) {
        // UPDATE: only overwrite the key columns for kinds we actually
        // re-uploaded; keep any previously-stored keys for the other kinds.
        rowId = existing.id;
        const finalKeys: Record<FileKind, string> = {
          dgt: newKeys.dgt ?? existing.dgtKey ?? "",
          prj: newKeys.prj ?? existing.prjKey ?? "",
          emf: newKeys.emf ?? existing.emfKey ?? "",
        };
        await c.var.DB.prepare(
          `UPDATE cnc_templates
             SET dgt_key = ?, prj_key = ?, emf_key = ?,
                 size_label = ?, fabric_width = ?, piece_label = ?,
                 size_bytes = ?, updated_at = ?
           WHERE id = ? AND org_id = ?`,
        )
          .bind(
            finalKeys.dgt,
            finalKeys.prj,
            finalKeys.emf,
            // Fill blanks from the parse, but don't clobber existing values.
            existing.sizeLabel || g.parsed.sizeLabel,
            existing.fabricWidth || g.parsed.fabricWidth,
            existing.pieceLabel || g.parsed.pieceLabel,
            batchBytes,
            now,
            rowId,
            orgId,
          )
          .run();
      } else {
        // INSERT a new row.
        rowId = genId();
        await c.var.DB.prepare(
          `INSERT INTO cnc_templates
             (id, org_id, product_code, size_label, fabric_width, piece_label,
              display_name, folder, dgt_key, prj_key, emf_key, drive_folder_id,
              size_bytes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            rowId,
            orgId,
            productCode,
            g.parsed.sizeLabel,
            g.parsed.fabricWidth,
            g.parsed.pieceLabel,
            displayName,
            "",
            newKeys.dgt ?? "",
            newKeys.prj ?? "",
            newKeys.emf ?? "",
            "",
            batchBytes,
            now,
            now,
          )
          .run();
      }

      const saved = await c.var.DB.prepare(
        `SELECT ${SELECT_COLS} FROM cnc_templates WHERE id = ? AND org_id = ?`,
      )
        .bind(rowId, orgId)
        .first<CncTemplateRow>();
      if (saved) outRows.push(rowToCncTemplate(saved));

      await emitAudit(c, {
        resource: "cnc-templates",
        resourceId: rowId,
        action: existing ? "update" : "create",
        after: {
          productCode,
          displayName,
          sizeLabel: g.parsed.sizeLabel,
          fabricWidth: g.parsed.fabricWidth,
          pieceLabel: g.parsed.pieceLabel,
          sizeBytes: batchBytes,
          source: "import",
        },
      }).catch(() => {});
    }

    return c.json({
      success: true,
      imported: outRows.length,
      files: acceptedFiles,
      rows: outRows,
    });
  } catch (err) {
    if (err instanceof SupabaseStorageNotConfiguredError) {
      return c.json({ success: false, error: "File storage unavailable." }, 503);
    }
    if (isMissingTable(err)) {
      return c.json(
        {
          success: false,
          error: "CNC template storage is not set up yet. Apply migration 0140.",
        },
        503,
      );
    }
    // Best-effort cleanup of objects uploaded before the failure.
    for (const key of uploaded) {
      try {
        await deleteFile(c.env, DEFAULT_BUCKET, key);
      } catch {
        // Already gone / transient — a sweeper will catch the orphan.
      }
    }
    console.error("[cnc-templates/import] bulk import failed:", err);
    return c.json(
      { success: false, error: err instanceof Error ? err.message : "Import failed." },
      500,
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
