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

// Guarantee the `material` column exists before any handler reads SELECT_COLS
// (which lists it). Cached → one ALTER per worker instance, then a no-op await.
app.use("*", async (c, next) => {
  await ensureMaterialColumn(c.var.DB);
  await next();
});

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
  totalHeight: string | null;
  material: string | null;
  driveFolderId: string | null;
  sizeBytes: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

// SELECT clause used by every read. `total_height` is wrapped in COALESCE
// against an empty literal so the query still succeeds when migration 0141
// hasn't been applied — the column simply doesn't appear and we fall through
// the catch below.
const SELECT_COLS =
  "id, org_id, product_code, size_label, fabric_width, piece_label, display_name, folder, dgt_key, prj_key, emf_key, total_height, material, drive_folder_id, size_bytes, created_at, updated_at";

// Fallback SELECT used when total_height is missing — same columns minus
// total_height (the adapter will return undefined for the field on the row).
// `material` is self-applied at runtime (route middleware) so it's always
// present here; only total_height can be absent (pre-0141 migration).
const SELECT_COLS_NO_HEIGHT =
  "id, org_id, product_code, size_label, fabric_width, piece_label, display_name, folder, dgt_key, prj_key, emf_key, material, drive_folder_id, size_bytes, created_at, updated_at";

// Client-facing shape. The raw storage keys (dgt_key/prj_key/emf_key) are
// deliberately NOT leaked — only the presence booleans are.
function rowToCncTemplate(r: CncTemplateRow) {
  return {
    id: r.id,
    productCode: r.productCode ?? "",
    sizeLabel: r.sizeLabel ?? "",
    fabricWidth: r.fabricWidth ?? "",
    pieceLabel: r.pieceLabel ?? "",
    totalHeight: r.totalHeight ?? "",
    // 'fabric' | 'wood' — all legacy rows are the BUYI fabric cutter, so null
    // defaults to fabric. Wood templates are tagged via PATCH.
    material: r.material === "wood" ? "wood" : "fabric",
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

// Postgres raises 42703 "column \"<name>\" does not exist" when the migration
// hasn't been applied. We use this to fall back to the legacy column set so
// the route keeps working on staging/prod between deploy and migration apply.
function isMissingTotalHeightColumn(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /column .*total_height.* does not exist/i.test(msg);
}

// Runtime self-apply of the `material` column ('fabric' | 'wood'), so the
// fabric/wood split works on prod without waiting for a manual migration
// (same pattern as ensureBindingColumns in supplier-materials.ts). Idempotent,
// once per worker instance; the route middleware below calls it before every
// request so SELECT_COLS (which lists `material`) always has the column.
// `material` is a single lowercase word — no rename-map entry needed.
let materialColEnsured = false;
async function ensureMaterialColumn(db: DbLike): Promise<void> {
  if (materialColEnsured) return;

  try {
    await db
      .prepare("ALTER TABLE cnc_templates ADD COLUMN IF NOT EXISTS material TEXT")
      .bind()
      .run();
  } catch {
    // already exists / transient DDL reject — ignore (rowToCncTemplate
    // defaults a missing value to 'fabric').
  }
  materialColEnsured = true;
}

// Minimal D1-style prepared-statement contract this route relies on. Avoids
// pulling in the Cloudflare D1 types just to type the helpers below.
type DbLike = {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
  };
};

// SELECT one template by (id, orgId) with backward-compat fallback for
// pre-0141 deployments. Returns null when no row matches.
async function selectOneTemplate(
  db: DbLike,
  id: string,
  orgId: string,
): Promise<CncTemplateRow | null> {
  try {
    return await db
      .prepare(`SELECT ${SELECT_COLS} FROM cnc_templates WHERE id = ? AND org_id = ?`)
      .bind(id, orgId)
      .first<CncTemplateRow>();
  } catch (e) {
    if (isMissingTotalHeightColumn(e)) {
      return await db
        .prepare(
          `SELECT ${SELECT_COLS_NO_HEIGHT} FROM cnc_templates WHERE id = ? AND org_id = ?`,
        )
        .bind(id, orgId)
        .first<CncTemplateRow>();
    }
    throw e;
  }
}

// SELECT one template by id (no orgId) — used right after INSERT to fetch the
// just-created row by its surrogate key.
async function selectOneTemplateById(
  db: DbLike,
  id: string,
): Promise<CncTemplateRow | null> {
  try {
    return await db
      .prepare(`SELECT ${SELECT_COLS} FROM cnc_templates WHERE id = ?`)
      .bind(id)
      .first<CncTemplateRow>();
  } catch (e) {
    if (isMissingTotalHeightColumn(e)) {
      return await db
        .prepare(`SELECT ${SELECT_COLS_NO_HEIGHT} FROM cnc_templates WHERE id = ?`)
        .bind(id)
        .first<CncTemplateRow>();
    }
    throw e;
  }
}

// INSERT one template row. Tries the modern shape (with total_height) first
// and falls back to the legacy shape if migration 0141 hasn't been applied.
async function insertTemplateRow(
  db: DbLike,
  row: {
    id: string;
    orgId: string;
    productCode: string;
    sizeLabel: string;
    fabricWidth: string;
    pieceLabel: string;
    totalHeight: string;
    displayName: string;
    folder: string;
    dgtKey: string;
    prjKey: string;
    emfKey: string;
    sizeBytes: number;
    now: string;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO cnc_templates
           (id, org_id, product_code, size_label, fabric_width, piece_label,
            display_name, folder, dgt_key, prj_key, emf_key, total_height,
            drive_folder_id, size_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.orgId,
        row.productCode,
        row.sizeLabel,
        row.fabricWidth,
        row.pieceLabel,
        row.displayName,
        row.folder,
        row.dgtKey,
        row.prjKey,
        row.emfKey,
        row.totalHeight,
        "",
        row.sizeBytes,
        row.now,
        row.now,
      )
      .run();
    return;
  } catch (e) {
    if (!isMissingTotalHeightColumn(e)) throw e;
  }
  // Fallback: legacy shape without total_height. The operator can still write
  // a height once the migration lands and the row is updated.
  await db
    .prepare(
      `INSERT INTO cnc_templates
         (id, org_id, product_code, size_label, fabric_width, piece_label,
          display_name, folder, dgt_key, prj_key, emf_key,
          drive_folder_id, size_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.orgId,
      row.productCode,
      row.sizeLabel,
      row.fabricWidth,
      row.pieceLabel,
      row.displayName,
      row.folder,
      row.dgtKey,
      row.prjKey,
      row.emfKey,
      "",
      row.sizeBytes,
      row.now,
      row.now,
    )
    .run();
}

// UPDATE one template row's metadata + storage keys + size_bytes.
async function updateTemplateRow(
  db: DbLike,
  row: {
    id: string;
    orgId: string;
    sizeLabel: string;
    fabricWidth: string;
    pieceLabel: string;
    totalHeight: string;
    dgtKey: string;
    prjKey: string;
    emfKey: string;
    sizeBytes: number;
    now: string;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE cnc_templates
           SET dgt_key = ?, prj_key = ?, emf_key = ?,
               size_label = ?, fabric_width = ?, piece_label = ?,
               total_height = ?, size_bytes = ?, updated_at = ?
         WHERE id = ? AND org_id = ?`,
      )
      .bind(
        row.dgtKey,
        row.prjKey,
        row.emfKey,
        row.sizeLabel,
        row.fabricWidth,
        row.pieceLabel,
        row.totalHeight,
        row.sizeBytes,
        row.now,
        row.id,
        row.orgId,
      )
      .run();
    return;
  } catch (e) {
    if (!isMissingTotalHeightColumn(e)) throw e;
  }
  // Fallback: legacy shape without total_height.
  await db
    .prepare(
      `UPDATE cnc_templates
         SET dgt_key = ?, prj_key = ?, emf_key = ?,
             size_label = ?, fabric_width = ?, piece_label = ?,
             size_bytes = ?, updated_at = ?
       WHERE id = ? AND org_id = ?`,
    )
    .bind(
      row.dgtKey,
      row.prjKey,
      row.emfKey,
      row.sizeLabel,
      row.fabricWidth,
      row.pieceLabel,
      row.sizeBytes,
      row.now,
      row.id,
      row.orgId,
    )
    .run();
}

// UPDATE one template row's METADATA ONLY (product_code / size_label /
// fabric_width / piece_label / total_height / display_name) — no storage keys.
// Used by PATCH /:id so the operator can re-assign a template to a different
// model (or fix its size/piece) after upload. The stored dgt/prj/emf keys are
// absolute object paths, so changing product_code here does NOT move or break
// the already-uploaded files; downloads keep working off the stored keys.
async function updateTemplateMeta(
  db: DbLike,
  row: {
    id: string;
    orgId: string;
    productCode: string;
    sizeLabel: string;
    fabricWidth: string;
    pieceLabel: string;
    totalHeight: string;
    material: string;
    displayName: string;
    now: string;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE cnc_templates
           SET product_code = ?, size_label = ?, fabric_width = ?,
               piece_label = ?, total_height = ?, material = ?, display_name = ?,
               updated_at = ?
         WHERE id = ? AND org_id = ?`,
      )
      .bind(
        row.productCode,
        row.sizeLabel,
        row.fabricWidth,
        row.pieceLabel,
        row.totalHeight,
        row.material,
        row.displayName,
        row.now,
        row.id,
        row.orgId,
      )
      .run();
    return;
  } catch (e) {
    if (!isMissingTotalHeightColumn(e)) throw e;
  }
  // Fallback: legacy shape without total_height (migration 0141 not applied).
  // `material` is self-applied (middleware) so it's safe to set here.
  await db
    .prepare(
      `UPDATE cnc_templates
         SET product_code = ?, size_label = ?, fabric_width = ?,
             piece_label = ?, material = ?, display_name = ?, updated_at = ?
       WHERE id = ? AND org_id = ?`,
    )
    .bind(
      row.productCode,
      row.sizeLabel,
      row.fabricWidth,
      row.pieceLabel,
      row.material,
      row.displayName,
      row.now,
      row.id,
      row.orgId,
    )
    .run();
}

// SELECT existing template by (orgId, productCode, displayName). Used by the
// /import upsert to decide between UPDATE and INSERT.
async function selectOneTemplateByName(
  db: DbLike,
  orgId: string,
  productCode: string,
  displayName: string,
): Promise<CncTemplateRow | null> {
  const where =
    " FROM cnc_templates WHERE org_id = ? AND product_code = ? AND display_name = ?";
  try {
    return await db
      .prepare(`SELECT ${SELECT_COLS}${where}`)
      .bind(orgId, productCode, displayName)
      .first<CncTemplateRow>();
  } catch (e) {
    if (isMissingTotalHeightColumn(e)) {
      return await db
        .prepare(`SELECT ${SELECT_COLS_NO_HEIGHT}${where}`)
        .bind(orgId, productCode, displayName)
        .first<CncTemplateRow>();
    }
    throw e;
  }
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
//   "1005 6 FT 20' dgt"  → code 1005, size 6FT,   totalHeight 20, piece ""
//   "5535 2S 30'"        → code 5535, size 2S,    totalHeight 30, piece ""
//   "5535 ARM"           → code 5535, size "",    totalHeight "", piece ARM
//   "5535 TANGAN"        → code 5535, size "",    totalHeight "", piece TANGAN
//   "1007 3'5 FT 20' dgt"→ code 1007, size 3.5FT, totalHeight 20, piece ""
//   "5535 1A(LHF) 28'"   → code 5535, size 1A(LHF), totalHeight 28, piece ""
//   "5535 ARM L"         → code 5535, size "",    totalHeight "", piece "ARM L"
//   "1013-1"             → code 1013, size "",    totalHeight "", piece 1
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

// Tokens that disambiguate L/R orientation of the piece (e.g. ARM L, ARM RHF).
// Matched case-insensitively. When one of these follows a recognised piece word
// we fold it into the pieceLabel (e.g. "ARM" + "L" → "ARM L").
const ORIENTATION_WORDS = new Set(["L", "R", "LEFT", "RIGHT", "LHF", "RHF"]);

type ParsedTemplateName = {
  productCode: string;
  sizeLabel: string;
  fabricWidth: string;
  pieceLabel: string;
  totalHeight: string;
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

// A token looks like a total-height marker when it's digits (optionally with a
// decimal) ending in a SINGLE apostrophe and nothing else: 20', 24', 30',
// 3.5'. The trailing apostrophe is BUYI shorthand for cm — we drop it on the
// way into total_height (digits only).
function isHeightToken(tok: string): boolean {
  return /^\d+(\.\d+)?'$/.test(tok);
}

// A token looks like a foot size when it's a number followed by FT: 5FT, 3.5FT.
function isSizeToken(tok: string): boolean {
  return /^\d+(\.\d+)?\s*FT$/i.test(tok);
}

// A token looks like a sofa seat-config when it's a 1-3 digit prefix +
// {NA,A,S} + optional (LHF)/(RHF). E.g., "1A", "2S", "1NA", "1A(LHF)",
// "3S(RHF)". The bedframe "FT" tokens win when both match (handled by check
// order below).
function isSeatConfigToken(tok: string): boolean {
  return /^[1-3](NA|A|S)(\(LHF\)|\(RHF\))?$/i.test(tok);
}

// Normalise a seat-config token: keep digits + uppercase the suffix + keep any
// (LHF)/(RHF) marker uppercased.
function normalizeSeatConfigToken(tok: string): string {
  return tok.toUpperCase();
}

// Normalise a foot-size token to the compact "5FT" / "3.5FT" form.
function normalizeSizeToken(tok: string): string {
  const m = tok.match(/^(\d+(?:\.\d+)?)\s*FT$/i);
  return m ? `${m[1]}FT` : tok;
}

// Parse a base filename into structured fields. Tolerant + never throws.
//
// Pre-normalisation:
//   1. Strip trailing literal "dgt" word (some operators append the kind).
//   2. Collapse whitespace runs to a single space.
//   3. Replace digit-apostrophe-digit (e.g. "3'5") with a decimal ("3.5") so
//      the FT-detector sees "3.5 FT" instead of choking on the apostrophe.
//
// Token classification (first match wins, in this order):
//   - isSizeToken  → sizeLabel (bedframe, e.g. "5FT", "3.5FT")
//   - isSeatConfigToken → sizeLabel (sofa, e.g. "2S", "1A(LHF)")
//   - isHeightToken → totalHeight (digits only, e.g. "20", "30")
//   - PIECE_WORDS  → pieceLabel ("ARM", "CUSHION", "DIVAN" ...)
//   - ORIENTATION_WORDS following a piece word → folded into pieceLabel
function parseTemplateName(rawBase: string): ParsedTemplateName {
  // 1) Strip trailing "dgt", 2) collapse whitespace, 3) digit'-digit → decimal.
  const base = stripTrailingDgtWord(rawBase)
    .replace(/\s+/g, " ")
    .replace(/(\d)'(\d)/g, "$1.$2")
    .trim();
  const result: ParsedTemplateName = {
    productCode: "",
    sizeLabel: "",
    fabricWidth: "",
    pieceLabel: "",
    totalHeight: "",
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

    // Foot sizes can arrive as two tokens ("5" then "FT") — fold a bare number
    // followed by a standalone "FT" back together before classifying. (Note:
    // we do NOT fold "3.5" then "FT" because the digit-apostrophe-digit
    // normalisation already turned "3'5 FT" → "3.5 FT" and the pair still
    // matches this branch.)
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

    const pieceParts: string[] = [];
    const leftovers: string[] = [];
    for (let i = 0; i < merged.length; i++) {
      const tok = merged[i];
      const upper = tok.toUpperCase();

      if (!result.sizeLabel && isSizeToken(tok)) {
        result.sizeLabel = normalizeSizeToken(tok);
        continue;
      }
      if (!result.sizeLabel && isSeatConfigToken(tok)) {
        result.sizeLabel = normalizeSeatConfigToken(tok);
        continue;
      }
      if (!result.totalHeight && isHeightToken(tok)) {
        result.totalHeight = tok.replace(/'$/, "");
        continue;
      }
      if (PIECE_WORDS.has(upper)) {
        // Greedy fold: any immediately-following orientation token belongs to
        // this piece label (e.g. "ARM" + "L" → "ARM L").
        let label = upper;
        const next = merged[i + 1];
        if (next && ORIENTATION_WORDS.has(next.toUpperCase())) {
          label = `${label} ${next.toUpperCase()}`;
          i++; // consume the orientation token
        }
        pieceParts.push(label);
        continue;
      }
      leftovers.push(tok);
    }

    if (pieceParts.length > 0) {
      result.pieceLabel = pieceParts.join(" ");
    } else if (leftovers.length > 0) {
      // Any non-size/non-height token that wasn't a recognised piece word still
      // carries meaning (e.g. "1" in "1013-1", or an unlisted piece name). Fold
      // the leftovers into pieceLabel if we don't already have one.
      result.pieceLabel = leftovers.join(" ");
    }

    // Last-resort guard: if we couldn't even find a productCode, keep the whole
    // base as the pieceLabel so the row is still meaningful and editable.
    if (!result.productCode && !result.pieceLabel) {
      result.pieceLabel = base;
    }
  } catch {
    // Defensive: never let a weird filename break the whole import batch.
    return {
      productCode: "",
      sizeLabel: "",
      fabricWidth: "",
      pieceLabel: base,
      totalHeight: "",
    };
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

  // Build the WHERE/ORDER tail once; the SELECT column list is the only thing
  // that differs between the modern shape and the pre-0141 fallback.
  let tail = " FROM cnc_templates WHERE org_id = ?";
  const binds: unknown[] = [orgId];
  if (productCode) {
    tail += " AND product_code = ?";
    binds.push(productCode);
  }
  if (q) {
    // LOWER(col) LIKE LOWER(?) — case-insensitive substring match across the
    // three searchable columns.
    tail +=
      " AND (LOWER(product_code) LIKE LOWER(?) OR LOWER(display_name) LIKE LOWER(?) OR LOWER(piece_label) LIKE LOWER(?))";
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  tail += " ORDER BY product_code, size_label";

  try {
    const res = await c.var.DB.prepare(`SELECT ${SELECT_COLS}${tail}`)
      .bind(...binds)
      .all<CncTemplateRow>();
    const data = (res.results ?? []).map(rowToCncTemplate);
    return c.json({ success: true, data });
  } catch (e) {
    // Migration 0141 not applied yet — retry without total_height.
    if (isMissingTotalHeightColumn(e)) {
      const res = await c.var.DB.prepare(`SELECT ${SELECT_COLS_NO_HEIGHT}${tail}`)
        .bind(...binds)
        .all<CncTemplateRow>();
      const data = (res.results ?? []).map(rowToCncTemplate);
      return c.json({ success: true, data });
    }
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
    const row = await selectOneTemplate(c.var.DB, id, orgId);
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
    row = await selectOneTemplate(c.var.DB, id, orgId);
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
  const totalHeight = String(form.get("totalHeight") ?? "").trim();
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

    await insertTemplateRow(c.var.DB, {
      id,
      orgId,
      productCode,
      sizeLabel,
      fabricWidth,
      pieceLabel,
      totalHeight,
      displayName,
      folder,
      dgtKey: keys.dgt,
      prjKey: keys.prj,
      emfKey: keys.emf,
      sizeBytes: totalBytes,
      now,
    });

    await emitAudit(c, {
      resource: "cnc-templates",
      resourceId: id,
      action: "create",
      after: { productCode, sizeLabel, fabricWidth, pieceLabel, totalHeight, displayName, sizeBytes: totalBytes },
    });

    const created = await selectOneTemplateById(c.var.DB, id);
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

  // Optional upload-time overrides chosen in the model picker. When present,
  // productCode is PREFERRED over the filename-parsed code for every grouped
  // row, and displayName overrides the auto-derived display name. Both fall
  // back to the existing filename parse when absent.
  const overrideProductCode = (() => {
    const v = form.get("productCode");
    return typeof v === "string" && v.trim() ? v.trim() : "";
  })();
  const overrideDisplayName = (() => {
    const v = form.get("displayName");
    return typeof v === "string" && v.trim() ? v.trim() : "";
  })();

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
    // Prefer the operator-chosen model over the filename-parsed code, so every
    // file in the upload is filed under the picked model.
    if (overrideProductCode) parsed.productCode = overrideProductCode;
    // Group by each file's OWN base name (the .dgt/.prj/.emf trio that share a
    // base collapse into one row). Do NOT use the single displayName override
    // here — applying one name to every file would collapse a multi-file upload
    // into one template and overwrite the rest (data loss). The override is
    // applied below, only when the whole upload is a single template.
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

  // Apply the operator's chosen file name ONLY when the upload is a single
  // template (one base name → one group, e.g. an arm.dgt/arm.prj/arm.emf trio).
  // For multi-file uploads (several different pieces) we keep each file's own
  // name so they stay as separate templates under the picked model.
  if (overrideDisplayName && groups.size === 1) {
    const only = [...groups.values()][0];
    only.displayName = overrideDisplayName;
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
      const existing = await selectOneTemplateByName(
        c.var.DB,
        orgId,
        productCode,
        displayName,
      );

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
        await updateTemplateRow(c.var.DB, {
          id: rowId,
          orgId,
          dgtKey: finalKeys.dgt,
          prjKey: finalKeys.prj,
          emfKey: finalKeys.emf,
          // Fill blanks from the parse, but don't clobber existing values.
          sizeLabel: existing.sizeLabel || g.parsed.sizeLabel,
          fabricWidth: existing.fabricWidth || g.parsed.fabricWidth,
          pieceLabel: existing.pieceLabel || g.parsed.pieceLabel,
          totalHeight: existing.totalHeight || g.parsed.totalHeight,
          sizeBytes: batchBytes,
          now,
        });
      } else {
        // INSERT a new row.
        rowId = genId();
        await insertTemplateRow(c.var.DB, {
          id: rowId,
          orgId,
          productCode,
          sizeLabel: g.parsed.sizeLabel,
          fabricWidth: g.parsed.fabricWidth,
          pieceLabel: g.parsed.pieceLabel,
          totalHeight: g.parsed.totalHeight,
          displayName,
          folder: "",
          dgtKey: newKeys.dgt ?? "",
          prjKey: newKeys.prj ?? "",
          emfKey: newKeys.emf ?? "",
          sizeBytes: batchBytes,
          now,
        });
      }

      const saved = await selectOneTemplate(c.var.DB, rowId, orgId);
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
          totalHeight: g.parsed.totalHeight,
          sizeBytes: batchBytes,
          source: "import",
        },
      });
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
// PATCH /:id — edit one template's metadata (re-assign model / fix size /
// piece / height / display name). JSON body; every field is optional and only
// the provided ones are changed. Does NOT touch the stored files — the dgt/prj/
// emf object keys stay as-is, so downloads keep working after a model change.
// productCode is required to be non-empty when present (the whole point is to
// ASSIGN a model — we don't let an edit blank it out).
// ---------------------------------------------------------------------------
app.patch("/:id", async (c) => {
  const denied = await requirePermission(c, "products", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const id = c.req.param("id");

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body." }, 400);
  }

  let existing: CncTemplateRow | null;
  try {
    existing = await selectOneTemplate(c.var.DB, id, orgId);
  } catch (e) {
    if (isMissingTable(e))
      return c.json({ success: false, error: "Template not found." }, 404);
    throw e;
  }
  if (!existing) return c.json({ success: false, error: "Template not found." }, 404);

  // For each editable field: use the provided value when the key is present,
  // otherwise keep the existing value. Strings are trimmed.
  const pick = (key: string, fallback: string): string =>
    Object.prototype.hasOwnProperty.call(body, key)
      ? String(body[key] ?? "").trim()
      : fallback;

  const productCode = pick("productCode", existing.productCode ?? "");
  const sizeLabel = pick("sizeLabel", existing.sizeLabel ?? "");
  const fabricWidth = pick("fabricWidth", existing.fabricWidth ?? "");
  const pieceLabel = pick("pieceLabel", existing.pieceLabel ?? "");
  const totalHeight = pick("totalHeight", existing.totalHeight ?? "");
  const displayName = pick("displayName", existing.displayName ?? "");
  // Fabric/wood tag — only ever 'fabric' or 'wood'; anything else → fabric.
  const materialRaw = pick("material", existing.material ?? "fabric").toLowerCase();
  const material = materialRaw === "wood" ? "wood" : "fabric";

  if (!productCode) {
    return c.json(
      { success: false, error: "A model (product code) is required." },
      400,
    );
  }
  if (!displayName) {
    return c.json({ success: false, error: "Display name cannot be empty." }, 400);
  }

  const now = new Date().toISOString();
  try {
    await updateTemplateMeta(c.var.DB, {
      id,
      orgId,
      productCode,
      sizeLabel,
      fabricWidth,
      pieceLabel,
      totalHeight,
      material,
      displayName,
      now,
    });
  } catch (e) {
    if (isMissingTable(e))
      return c.json({ success: false, error: "Template not found." }, 404);
    throw e;
  }

  await emitAudit(c, {
    resource: "cnc-templates",
    resourceId: id,
    action: "update",
    before: {
      productCode: existing.productCode,
      sizeLabel: existing.sizeLabel,
      fabricWidth: existing.fabricWidth,
      pieceLabel: existing.pieceLabel,
      totalHeight: existing.totalHeight,
      material: existing.material,
      displayName: existing.displayName,
    },
    after: { productCode, sizeLabel, fabricWidth, pieceLabel, totalHeight, material, displayName },
  });

  const updated = await selectOneTemplate(c.var.DB, id, orgId);
  return c.json({ success: true, data: updated ? rowToCncTemplate(updated) : null });
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
    row = await selectOneTemplate(c.var.DB, id, orgId);
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
  });

  return c.json({ success: true });
});

export default app;
