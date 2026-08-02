// ---------------------------------------------------------------------------
// DataGrid org-wide layouts — shared column presets for the generic DataGrid.
//
// Problem this fixes: the DataGrid's "Save as Org Default" and the print
// preset ("Save as Production Schedule") used to write ONLY to the local
// browser's localStorage, so a different browser / consultant / user never
// saw them (the old toast even admitted "new users on THIS browser"). This
// route persists those two presets to the backend, scoped to the org, so any
// user on any browser loads them.
//
// Two kinds per grid:
//   - 'org-default' : the curated initial layout for users who have not yet
//                     personalised this grid. Published by a SUPER_ADMIN.
//   - 'print'       : the curated layout a printout uses instead of the live
//                     on-screen columns (Wei Siang #25 "Save as Production
//                     Schedule"). Also SUPER_ADMIN-gated to publish (same bar
//                     as the FE save button on the org-wide presets).
//
// The PERSONAL per-user layout stays in localStorage — per-user-per-browser is
// fine for a personal view and keeps the hot path free of a round-trip.
//
// Resolution order on the client stays: personal localStorage > server
// org-default (mirrored into the localStorage cache keys) > code defaults.
//
// Deliberate isolation (same posture as routes/mail-center.ts): ALL SQL here
// is snake_case so it passes the camelCase→snake translator (supabase-compat)
// UNCHANGED and needs ZERO edits to column-rename-map.json. The table is
// created lazily here (CREATE TABLE IF NOT EXISTS at the top of every handler)
// because migration files are INERT on prod — a new table reaches prod ONLY
// via this runtime self-apply.
//
// Tenancy: every row carries org_id; reads + writes scope by getOrgId(c).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requireSuperAdmin } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

const VALID_KINDS = new Set(["org-default", "print"]);

// ---------------------------------------------------------------------------
// Lazy schema. Module-level promise = one flight per isolate; per-statement
// try/catch so a benign "already exists" never poisons the cached promise.
// Same pattern as routes/mail-center.ts (ensureMailSchema).
// ---------------------------------------------------------------------------
let pendingSchema = false;
async function ensureLayoutSchema(db: D1Database): Promise<void> {
  if (pendingSchema) return;

  const stmts = [
    // One row per (org, grid, kind). visible_cols / col_order are JSON-stringified
    // arrays; col_widths is a JSON-stringified object (or NULL when never saved).
    // updated_at is written via new Date().toISOString() so it MUST stay TEXT
    // (never timestamptz) for the SupabaseAdapter to round-trip it unchanged.
    `CREATE TABLE IF NOT EXISTS datagrid_org_layouts (
       id TEXT PRIMARY KEY,
       org_id TEXT NOT NULL DEFAULT 'hookka',
       grid_id TEXT NOT NULL,
       kind TEXT NOT NULL,
       visible_cols TEXT,
       col_order TEXT,
       col_widths TEXT,
       updated_by TEXT,
       updated_at TEXT
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_datagrid_org_layouts_org_grid_kind
       ON datagrid_org_layouts (org_id, grid_id, kind)`,
  ];
  for (const stmt of stmts) {
    try {
      await db.prepare(stmt).run();
    } catch (e) {
      console.error("[datagrid-layouts] schema init failed:", e);
    }
  }
  pendingSchema = true;
}

type LayoutRow = {
  visibleCols?: string | null;
  visible_cols?: string | null;
  colOrder?: string | null;
  col_order?: string | null;
  colWidths?: string | null;
  col_widths?: string | null;
  kind?: string;
};

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// Shape one DB row into the FE-friendly preset object, or null when absent.
function rowToPreset(row: LayoutRow | null): {
  visibleCols: string[];
  colOrder: string[];
  colWidths: Record<string, string> | null;
} | null {
  if (!row) return null;
  const visibleCols = parseJson<string[]>(row.visibleCols ?? row.visible_cols);
  const colOrder = parseJson<string[]>(row.colOrder ?? row.col_order);
  const colWidths = parseJson<Record<string, string>>(
    row.colWidths ?? row.col_widths,
  );
  // A preset is only meaningful if at least the visible columns survived
  // parsing; otherwise treat as absent so the client falls back cleanly.
  if (!Array.isArray(visibleCols)) return null;
  return {
    visibleCols,
    colOrder: Array.isArray(colOrder) ? colOrder : visibleCols,
    colWidths: colWidths && typeof colWidths === "object" ? colWidths : null,
  };
}

// ---------------------------------------------------------------------------
// GET /api/datagrid-layouts?gridId=...
// Returns { orgDefault: preset|null, print: preset|null } for the caller's org.
// Any authenticated user may read (so every browser loads the shared layout).
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const orgId = getOrgId(c);
  const gridId = c.req.query("gridId");
  if (!gridId) {
    return c.json({ success: false, error: "gridId is required" }, 400);
  }
  await ensureLayoutSchema(c.var.DB);
  try {
    const res = await c.var.DB.prepare(
      `SELECT kind, visible_cols, col_order, col_widths
         FROM datagrid_org_layouts
        WHERE org_id = ? AND grid_id = ?`,
    )
      .bind(orgId, gridId)
      .all<LayoutRow>();
    let orgDefault: ReturnType<typeof rowToPreset> = null;
    let print: ReturnType<typeof rowToPreset> = null;
    for (const row of res.results ?? []) {
      if (row.kind === "org-default") orgDefault = rowToPreset(row);
      else if (row.kind === "print") print = rowToPreset(row);
    }
    return c.json({ success: true, orgDefault, print });
  } catch (e) {
    console.error("[datagrid-layouts] GET failed:", e);
    // Fail soft — the FE falls back to its localStorage behavior on any error,
    // so a 500 here must never break a grid. Return empty presets.
    return c.json({ success: true, orgDefault: null, print: null });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/datagrid-layouts
// Body: { gridId, kind, visibleCols, colOrder, colWidths? }
// Upsert the org-wide preset. SUPER_ADMIN only (same bar as the FE save button).
// ---------------------------------------------------------------------------
app.put("/", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;

  const orgId = getOrgId(c);
  const userId = (c.get as unknown as (k: string) => string | undefined)(
    "userId",
  );

  let body: {
    gridId?: string;
    kind?: string;
    visibleCols?: unknown;
    colOrder?: unknown;
    colWidths?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const gridId = typeof body.gridId === "string" ? body.gridId.trim() : "";
  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!gridId) {
    return c.json({ success: false, error: "gridId is required" }, 400);
  }
  if (!VALID_KINDS.has(kind)) {
    return c.json(
      { success: false, error: "kind must be 'org-default' or 'print'" },
      400,
    );
  }
  if (!Array.isArray(body.visibleCols) || !Array.isArray(body.colOrder)) {
    return c.json(
      { success: false, error: "visibleCols and colOrder must be arrays" },
      400,
    );
  }

  const visibleCols = JSON.stringify(
    (body.visibleCols as unknown[]).map(String),
  );
  const colOrder = JSON.stringify((body.colOrder as unknown[]).map(String));
  const colWidths =
    body.colWidths && typeof body.colWidths === "object"
      ? JSON.stringify(body.colWidths)
      : null;
  const now = new Date().toISOString();

  await ensureLayoutSchema(c.var.DB);
  try {
    // UPSERT keyed on the unique (org_id, grid_id, kind) index. ON CONFLICT
    // keeps it to a single statement so concurrent admin saves can't duplicate.
    await c.var.DB.prepare(
      `INSERT INTO datagrid_org_layouts
         (id, org_id, grid_id, kind, visible_cols, col_order, col_widths, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_id, grid_id, kind) DO UPDATE SET
         visible_cols = excluded.visible_cols,
         col_order    = excluded.col_order,
         col_widths   = excluded.col_widths,
         updated_by   = excluded.updated_by,
         updated_at   = excluded.updated_at`,
    )
      .bind(
        crypto.randomUUID(),
        orgId,
        gridId,
        kind,
        visibleCols,
        colOrder,
        colWidths,
        userId ?? null,
        now,
      )
      .run();
    return c.json({ success: true });
  } catch (e) {
    console.error("[datagrid-layouts] PUT failed:", e);
    return c.json({ success: false, error: "Could not save layout" }, 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/datagrid-layouts?gridId=&kind=
// Remove the org-wide preset ("Reset to Org Default" clears the published
// org-default). SUPER_ADMIN only.
// ---------------------------------------------------------------------------
app.delete("/", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;

  const orgId = getOrgId(c);
  const gridId = c.req.query("gridId");
  const kind = c.req.query("kind") ?? "";
  if (!gridId) {
    return c.json({ success: false, error: "gridId is required" }, 400);
  }
  if (!VALID_KINDS.has(kind)) {
    return c.json(
      { success: false, error: "kind must be 'org-default' or 'print'" },
      400,
    );
  }
  await ensureLayoutSchema(c.var.DB);
  try {
    await c.var.DB.prepare(
      `DELETE FROM datagrid_org_layouts
        WHERE org_id = ? AND grid_id = ? AND kind = ?`,
    )
      .bind(orgId, gridId, kind)
      .run();
    return c.json({ success: true });
  } catch (e) {
    console.error("[datagrid-layouts] DELETE failed:", e);
    return c.json({ success: false, error: "Could not clear layout" }, 500);
  }
});

export default app;
