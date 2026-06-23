// ============================================================
// Announcements — office posts that every worker sees on their phone.
//
// Two audiences share ONE table (`announcements`, snake_case):
//   • ADMIN (office, dashboard) — create / list-all / deactivate / delete.
//     Gated by requirePermission (SUPER_ADMIN / ADMIN bypass everything).
//   • WORKER (mobile portal) — read-only list of currently-ACTIVE
//     (is_active && not expired) announcements, newest first. Gated by the
//     same X-Worker-Token the rest of /api/worker/* uses.
//
// v1 is deliberately tiny: NO push, NO per-worker read table. The worker app
// tracks "seen" announcement ids in localStorage for the unread dot.
//
// Mounted at BOTH:
//   /api/announcements        → admin endpoints (in worker.ts, after auth)
//   /api/worker/announcements → worker read endpoint (in worker.ts route)
// This file exports two sub-apps so each mount carries only the right auth.
//
// ── Schema self-apply (load-bearing) ───────────────────────────────────────
// Hookka deploys do NOT replay migrations-postgres/*.sql — the migration file
// (0186_announcements.sql) is INERT on prod. The table reaches prod ONLY via
// the runtime `CREATE TABLE IF NOT EXISTS` below, awaited at the TOP of every
// handler before the first read/write. Same pattern as ensurePendingMigrations
// in sales-orders.ts / ensureAttendanceGeo in worker.ts.
// ============================================================
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { DEFAULT_ORG_ID, tryGetOrgId } from "../lib/tenant";
import { resolveWorkerToken } from "./worker-auth";

// ---- runtime schema self-apply (idempotent, once per isolate) ----
let _announcementsMig: Promise<void> | null = null;
function ensureAnnouncementsTable(db: D1Database): Promise<void> {
  if (_announcementsMig) return _announcementsMig;
  _announcementsMig = (async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS announcements (
           id           TEXT PRIMARY KEY,
           org_id       TEXT NOT NULL DEFAULT 'hookka',
           title        TEXT NOT NULL,
           body         TEXT NOT NULL DEFAULT '',
           is_active    BOOLEAN NOT NULL DEFAULT TRUE,
           expires_at   TIMESTAMPTZ,
           created_by   TEXT,
           created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
           updated_at   TIMESTAMPTZ
         )`,
      )
      .run();
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_announcements_org_active_created
           ON announcements (org_id, is_active, created_at DESC)`,
      )
      .run();
  })();
  return _announcementsMig;
}

// The Postgres driver transforms snake_case columns to camelCase ON READ
// (db-pg toCamel), so a `SELECT *` hands back isActive/expiresAt/createdAt/…,
// NOT is_active/… . Declare BOTH and read dual-keyed (camelCase first,
// snake_case fallback) — the #1 Hookka read-gotcha. Without this the worker
// GET drops every row and the admin list shows everything as Hidden.
type AnnouncementRow = {
  id: string;
  org_id?: string;
  orgId?: string;
  title: string;
  body: string;
  is_active?: boolean | number | null;
  isActive?: boolean | number | null;
  expires_at?: string | null;
  expiresAt?: string | null;
  created_by?: string | null;
  createdBy?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
  updated_at?: string | null;
  updatedAt?: string | null;
};

function isActiveFlag(v: boolean | number | null): boolean {
  // Postgres returns a real boolean; the SQLite/d1-compat path can hand back
  // 0/1. Treat anything truthy-by-DB-convention as active.
  return v === true || v === 1;
}

function notExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return true; // unparseable → don't hide it
  return t > Date.now();
}

// Public (worker-facing) shape — camelCase for the frontend. Same shape the
// admin list uses so one TS type covers both pages.
function toPublic(r: AnnouncementRow) {
  return {
    id: r.id,
    title: r.title,
    body: r.body ?? "",
    isActive: isActiveFlag(r.isActive ?? r.is_active ?? null),
    expiresAt: r.expiresAt ?? r.expires_at ?? null,
    createdAt: r.createdAt ?? r.created_at ?? null,
    createdBy: r.createdBy ?? r.created_by ?? null,
  };
}

function genId(): string {
  return `ann-${crypto.randomUUID().slice(0, 12)}`;
}

// ============================================================
// ADMIN sub-app — mounted at /api/announcements (after authMiddleware).
// Every mutation is gated by requirePermission; SUPER_ADMIN/ADMIN bypass.
// ============================================================
const admin = new Hono<Env>();

// Resolve the active org for an admin request, defaulting to 'hookka' for the
// single-tenant install (matches the column default + the worker side).
function adminOrgId(c: Context<Env>): string {
  return tryGetOrgId(c) ?? DEFAULT_ORG_ID;
}

// GET /api/announcements — list ALL (active + inactive) for the office to
// manage. Newest first.
admin.get("/", async (c) => {
  const denied = await requirePermission(c, "announcements", "read");
  if (denied) return denied;
  await ensureAnnouncementsTable(c.var.DB);
  const orgId = adminOrgId(c);
  const res = await c.var.DB.prepare(
    "SELECT * FROM announcements WHERE org_id = ? ORDER BY created_at DESC",
  )
    .bind(orgId)
    .all<AnnouncementRow>();
  return c.json({ success: true, data: (res.results ?? []).map(toPublic) });
});

// POST /api/announcements — create. Body: { title, body?, expiresAt? }
admin.post("/", async (c) => {
  const denied = await requirePermission(c, "announcements", "create");
  if (denied) return denied;
  await ensureAnnouncementsTable(c.var.DB);
  const orgId = adminOrgId(c);
  const body = await c.req.json().catch(() => ({}));
  const title = String((body as { title?: unknown }).title ?? "").trim();
  const text = String((body as { body?: unknown }).body ?? "").trim();
  if (!title) {
    return c.json({ success: false, error: "Title is required" }, 400);
  }
  // Optional expiry — accept an ISO/date string; store it verbatim when it
  // parses, else reject (reject-don't-normalize). Empty/absent → never expires.
  const rawExpiry = (body as { expiresAt?: unknown }).expiresAt;
  let expiresAt: string | null = null;
  if (rawExpiry != null && String(rawExpiry).trim() !== "") {
    const t = Date.parse(String(rawExpiry));
    if (Number.isNaN(t)) {
      return c.json({ success: false, error: "Invalid expiry date" }, 400);
    }
    expiresAt = new Date(t).toISOString();
  }
  const userId =
    (c as unknown as { get: (k: string) => string | undefined }).get(
      "userId",
    ) ?? null;
  const id = genId();
  const nowIso = new Date().toISOString();
  await c.var.DB.prepare(
    `INSERT INTO announcements
       (id, org_id, title, body, is_active, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, TRUE, ?, ?, ?)`,
  )
    .bind(id, orgId, title, text, expiresAt, userId, nowIso)
    .run();
  const row = await c.var.DB.prepare(
    "SELECT * FROM announcements WHERE id = ?",
  )
    .bind(id)
    .first<AnnouncementRow>();
  return c.json({ success: true, data: row ? toPublic(row) : null }, 201);
});

// PATCH /api/announcements/:id — toggle active (deactivate/reactivate) or edit.
// Body: { isActive?, title?, body?, expiresAt? }
admin.patch("/:id", async (c) => {
  const denied = await requirePermission(c, "announcements", "update");
  if (denied) return denied;
  await ensureAnnouncementsTable(c.var.DB);
  const orgId = adminOrgId(c);
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM announcements WHERE id = ? AND org_id = ?",
  )
    .bind(id, orgId)
    .first<AnnouncementRow>();
  if (!existing) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const sets: string[] = [];
  const binds: unknown[] = [];
  if ("isActive" in (body as object)) {
    sets.push("is_active = ?");
    binds.push((body as { isActive?: unknown }).isActive ? true : false);
  }
  if (typeof (body as { title?: unknown }).title === "string") {
    const title = String((body as { title: string }).title).trim();
    if (!title) {
      return c.json({ success: false, error: "Title is required" }, 400);
    }
    sets.push("title = ?");
    binds.push(title);
  }
  if (typeof (body as { body?: unknown }).body === "string") {
    sets.push("body = ?");
    binds.push(String((body as { body: string }).body).trim());
  }
  if ("expiresAt" in (body as object)) {
    const raw = (body as { expiresAt?: unknown }).expiresAt;
    if (raw == null || String(raw).trim() === "") {
      sets.push("expires_at = ?");
      binds.push(null);
    } else {
      const t = Date.parse(String(raw));
      if (Number.isNaN(t)) {
        return c.json({ success: false, error: "Invalid expiry date" }, 400);
      }
      sets.push("expires_at = ?");
      binds.push(new Date(t).toISOString());
    }
  }
  if (sets.length === 0) {
    return c.json({ success: true, data: toPublic(existing) });
  }
  sets.push("updated_at = ?");
  binds.push(new Date().toISOString());
  binds.push(id, orgId);
  await c.var.DB.prepare(
    `UPDATE announcements SET ${sets.join(", ")} WHERE id = ? AND org_id = ?`,
  )
    .bind(...binds)
    .run();
  const row = await c.var.DB.prepare(
    "SELECT * FROM announcements WHERE id = ?",
  )
    .bind(id)
    .first<AnnouncementRow>();
  return c.json({ success: true, data: row ? toPublic(row) : null });
});

// DELETE /api/announcements/:id — hard delete (row count is tiny; the soft
// "deactivate" path above is PATCH isActive=false).
admin.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "announcements", "delete");
  if (denied) return denied;
  await ensureAnnouncementsTable(c.var.DB);
  const orgId = adminOrgId(c);
  const id = c.req.param("id");
  await c.var.DB.prepare(
    "DELETE FROM announcements WHERE id = ? AND org_id = ?",
  )
    .bind(id, orgId)
    .run();
  return c.json({ success: true });
});

// ============================================================
// WORKER sub-app — mounted at /api/worker/announcements.
// Worker-token authed (same as the rest of the worker portal). Read-only,
// returns only the ACTIVE + not-expired rows, newest first.
// ============================================================
const worker = new Hono<Env>();

// Default-protect: every route in this worker sub-app requires a valid worker
// token (the worker-portal convention — worker-auth-default-protect.test.mjs),
// so a future handler added here can't accidentally ship unauthenticated.
worker.use("*", async (c, next) => {
  const id = await resolveWorkerToken(c.var.DB, c.req.header("x-worker-token"));
  if (!id) return c.json({ success: false, error: "Not authenticated" }, 401);
  await next();
});

worker.get("/", async (c) => {
  await ensureAnnouncementsTable(c.var.DB);
  // The worker portal is single-tenant against the default org (no org scope
  // exists anywhere on the worker side); read that org's notices and keep only
  // the active + not-expired ones. We filter the is_active flag in JS (not a
  // SQL boolean literal) so the read path is agnostic to how the DB layer
  // returns the boolean (Postgres true vs a 0/1 from any compat path).
  const res = await c.var.DB.prepare(
    "SELECT * FROM announcements WHERE org_id = ? ORDER BY created_at DESC",
  )
    .bind(DEFAULT_ORG_ID)
    .all<AnnouncementRow>();
  const rows = (res.results ?? [])
    .filter(
      (r) =>
        isActiveFlag(r.isActive ?? r.is_active ?? null) &&
        notExpired(r.expiresAt ?? r.expires_at ?? null),
    )
    .map(toPublic);
  return c.json({ success: true, data: rows });
});

export { admin as announcementsAdmin, worker as announcementsWorker };
