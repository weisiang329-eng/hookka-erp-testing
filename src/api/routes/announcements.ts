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
import {
  translateAnnouncement,
  type AnnouncementTranslations,
} from "../lib/translate-announcement";

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
    // Auto-translation column (added 2026-06-23). Stores ONE JSON blob with the
    // worker-portal translations: { en:{title,body}, ms:{…}, zh:{…}, my:{…} }.
    // A single JSONB column (not per-lang columns) keeps the schema stable if a
    // 5th language is ever added. The migration FILE is inert on prod — this
    // runtime ALTER is the only way the column reaches prod, awaited before the
    // first read/write. Wrapped in try/catch like ocr-distill.ensureDistillColumns
    // so a transient DDL reject can't strand the whole ensure.
    try {
      await db
        .prepare(
          "ALTER TABLE announcements ADD COLUMN IF NOT EXISTS translations JSONB",
        )
        .run();
    } catch {
      // best-effort; column may already exist or DDL transiently rejected.
      // Clear the memo so a transient DDL reject SELF-HEALS on the next call,
      // instead of caching a "success" that strands every write (the INSERT
      // would bind a non-existent `translations` column → 500) for the life of
      // the isolate.
      _announcementsMig = null;
    }
    // Per-worker read-receipt table (added 2026-06-24). ONE row per
    // (announcement, worker) the moment a worker taps "Got it" on the phone
    // popup. The popup gate is now SERVER-driven off this table (the worker GET
    // returns this worker's acked ids), so a fresh device re-pops every active
    // notice until the server records the ack. The office reads it back as a
    // read-receipt (acked vs the active roster) and "remind" re-pops the
    // un-acked. snake_case columns; the PG driver folds them to camelCase on
    // read so every read is dual-keyed (r.workerId ?? r.worker_id, etc).
    //
    // Same load-bearing pattern as the table above: the migration FILE is INERT
    // on prod — this runtime CREATE TABLE is the only way it reaches prod,
    // awaited before the first ack read/write. Wrapped in its own try/catch with
    // the memo-null self-heal so a transient DDL reject can't strand the ensure.
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS announcement_acks (
             announcement_id TEXT NOT NULL,
             worker_id       TEXT NOT NULL,
             acked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
             PRIMARY KEY (announcement_id, worker_id)
           )`,
        )
        .run();
      // Index the worker_id side: the worker GET subquery fetches "this
      // worker's acked ids" by worker_id, and the office remind/acks join keys
      // off announcement_id (already covered by the PK's leading column).
      await db
        .prepare(
          `CREATE INDEX IF NOT EXISTS idx_announcement_acks_worker
             ON announcement_acks (worker_id)`,
        )
        .run();
    } catch {
      // best-effort; table/index may already exist or DDL transiently rejected.
      // Null the memo so a transient reject self-heals on the next call instead
      // of caching a "success" that strands every ack write for the isolate.
      _announcementsMig = null;
    }
    // Reminder marker (added 2026-06-24). When the office taps "Remind", we
    // delete the un-acked workers' (absent) ack rows is a no-op, so instead we
    // stamp reminded_at on the announcement and the worker GET treats a notice
    // reminded AFTER this worker's last ack as un-acked again — re-popping it.
    // (For a never-acked worker the notice already pops, so remind is mainly a
    // way to re-pop for someone who acked an EARLIER version.) Best-effort ALTER
    // with the same self-heal posture.
    try {
      await db
        .prepare(
          "ALTER TABLE announcements ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ",
        )
        .run();
    } catch {
      _announcementsMig = null;
    }
    // Media attachments (added 2026-06-26). A lightweight JSON manifest of the
    // files attached to a notice — tutorial images/videos and SOP PDFs the
    // worker portal renders inline / as a download link. The bytes live in the
    // existing /api/files store; this column only holds
    //   [ { fileId, name, mime }, ... ]
    // as a TEXT blob (kept TEXT not JSONB so the SQLite test mirror matches).
    // INERT migration file (0192) — this runtime ALTER is the load-bearing copy,
    // awaited before the first read/write. Same self-heal posture as above.
    try {
      await db
        .prepare(
          "ALTER TABLE announcements ADD COLUMN IF NOT EXISTS attachments TEXT",
        )
        .run();
    } catch {
      _announcementsMig = null;
    }
  })();
  return _announcementsMig;
}

// One attached media file on an announcement. `fileId` points at the existing
// /api/files store; `name` is the original filename (for the PDF download
// label) and `mime` drives how the worker portal renders it (image/video/pdf).
export type AnnouncementAttachment = {
  fileId: string;
  name: string;
  mime: string;
};

// Coerce arbitrary request/DB input into a clean attachments array. Tolerates a
// parsed array OR a JSON string (the PG driver may hand TEXT back either way),
// drops any entry missing a fileId, and trims/normalizes the three fields.
function normalizeAttachments(raw: unknown): AnnouncementAttachment[] {
  let arr: unknown = raw;
  if (typeof arr === "string") {
    const s = arr.trim();
    if (!s) return [];
    try {
      arr = JSON.parse(s);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: AnnouncementAttachment[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const fileId = String(o.fileId ?? "").trim();
    if (!fileId) continue;
    out.push({
      fileId,
      name: String(o.name ?? "").trim(),
      mime: String(o.mime ?? "").trim(),
    });
  }
  return out;
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
  // Last time the office tapped "Remind" on this notice. The worker GET
  // compares it against this worker's ack time to decide whether to re-pop.
  reminded_at?: string | null;
  remindedAt?: string | null;
  // Auto-translation blob. The PG driver may hand it back as a parsed object
  // OR as a JSON string depending on the column type/path, and the toCamel
  // folder leaves the all-lowercase `translations` key as-is — but we still
  // read it dual-keyed defensively (translations / translations_json).
  translations?: AnnouncementTranslations | string | null;
  translations_json?: AnnouncementTranslations | string | null;
  // Media manifest — a JSON string (TEXT column) of {fileId,name,mime} entries.
  // The toCamel folder leaves the all-lowercase `attachments` key as-is, but we
  // read dual-keyed defensively just like translations above.
  attachments?: string | unknown[] | null;
  attachments_json?: string | unknown[] | null;
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

// True when the office reminded this notice AFTER the worker last acked it — in
// which case the popup gate should treat it as un-acked again (re-pop). A
// missing/unparseable remindedAt means "never reminded" → not reminded-since.
// A missing ackedAt means the worker never acked → handled by the caller
// (already absent from the acked set), so we conservatively return false here.
function isRemindedSince(
  remindedAt: string | null,
  ackedAt: string | null,
): boolean {
  if (!remindedAt) return false;
  const r = Date.parse(remindedAt);
  if (Number.isNaN(r)) return false;
  if (!ackedAt) return false;
  const a = Date.parse(ackedAt);
  if (Number.isNaN(a)) return false;
  return r > a;
}

// Normalize the stored translations value to a parsed object (or null). The PG
// driver may return JSONB as a real object OR as a JSON string; tolerate both.
function readTranslations(
  r: AnnouncementRow,
): AnnouncementTranslations | null {
  const raw = r.translations ?? r.translations_json ?? null;
  if (raw == null) return null;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw) as AnnouncementTranslations;
    } catch {
      return null;
    }
  }
  return raw;
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
    // All four translations (or null). The worker FE picks the one matching
    // the worker's chosen portal language, falling back to title/body above.
    translations: readTranslations(r),
    // Media attachments (image/video/PDF). Always an array (empty when none) so
    // both the worker portal and the admin list can map over it directly.
    attachments: normalizeAttachments(r.attachments ?? r.attachments_json ?? null),
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

// GET /api/announcements/:id/acks — read-receipt for one announcement. Splits
// the ACTIVE worker roster into who has acknowledged it (with the ack time) and
// who hasn't. Gated by the same `read` permission as the list. The roster is
// the canonical "all ACTIVE workers" query (matches payroll.ts / publicWorker);
// the workers table predates the snake_case rule so it's queried with bare
// camelCase column names directly. Read the join columns dual-keyed because the
// PG driver folds acked_at → ackedAt on read.
admin.get("/:id/acks", async (c) => {
  const denied = await requirePermission(c, "announcements", "read");
  if (denied) return denied;
  await ensureAnnouncementsTable(c.var.DB);
  const orgId = adminOrgId(c);
  const id = c.req.param("id");
  // Confirm the announcement exists for this org (404 otherwise) so the office
  // never sees a phantom read-receipt for a deleted/foreign id.
  const ann = await c.var.DB.prepare(
    "SELECT id FROM announcements WHERE id = ? AND org_id = ?",
  )
    .bind(id, orgId)
    .first<{ id: string }>();
  if (!ann) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  // Active roster — the "everyone who should have read this" side.
  const rosterRes = await c.var.DB.prepare(
    "SELECT id, empNo, name FROM workers WHERE status = 'ACTIVE' ORDER BY name ASC",
  ).all<{ id: string; empNo?: string | null; name?: string | null }>();
  const roster = rosterRes.results ?? [];
  // This announcement's ack rows → worker_id → acked_at (dual-keyed read).
  const ackRes = await c.var.DB.prepare(
    "SELECT worker_id, acked_at FROM announcement_acks WHERE announcement_id = ?",
  )
    .bind(id)
    .all<{
      worker_id?: string;
      workerId?: string;
      acked_at?: string | null;
      ackedAt?: string | null;
    }>();
  const ackedAtByWorker = new Map<string, string | null>();
  for (const a of ackRes.results ?? []) {
    const wid = a.workerId ?? a.worker_id;
    if (wid) ackedAtByWorker.set(wid, a.ackedAt ?? a.acked_at ?? null);
  }
  const acked: Array<{
    id: string;
    name: string;
    empNo: string;
    ackedAt: string | null;
  }> = [];
  const pending: Array<{ id: string; name: string; empNo: string }> = [];
  for (const w of roster) {
    const name = w.name ?? "";
    const empNo = w.empNo ?? "";
    if (ackedAtByWorker.has(w.id)) {
      acked.push({ id: w.id, name, empNo, ackedAt: ackedAtByWorker.get(w.id) ?? null });
    } else {
      pending.push({ id: w.id, name, empNo });
    }
  }
  // Sort acked newest-first so the most recent reads sit at the top.
  acked.sort((x, y) => {
    const tx = x.ackedAt ? Date.parse(x.ackedAt) : 0;
    const ty = y.ackedAt ? Date.parse(y.ackedAt) : 0;
    return (Number.isNaN(ty) ? 0 : ty) - (Number.isNaN(tx) ? 0 : tx);
  });
  return c.json({
    success: true,
    data: {
      total: roster.length,
      ackedCount: acked.length,
      acked,
      pending,
    },
  });
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
  // Optional media manifest — image/video/PDF already uploaded via /api/files.
  // Normalized (drops malformed entries); stored as a JSON string (null when
  // none) so the column stays empty for text-only notices.
  const attachments = normalizeAttachments(
    (body as { attachments?: unknown }).attachments,
  );
  const userId =
    (c as unknown as { get: (k: string) => string | undefined }).get(
      "userId",
    ) ?? null;
  const id = genId();
  const nowIso = new Date().toISOString();
  // Translate the notice into all four worker-portal languages ONCE on POST,
  // best-effort: a Claude failure / missing key returns null and we still
  // INSERT (workers then see the original text). Await before INSERT so the
  // row lands fully translated; the call is short + rare so blocking is fine.
  const translations = await translateAnnouncement({
    title,
    body: text,
    apiKey: c.env.ANTHROPIC_API_KEY,
  });
  await c.var.DB.prepare(
    `INSERT INTO announcements
       (id, org_id, title, body, is_active, expires_at, created_by, created_at, translations, attachments)
     VALUES (?, ?, ?, ?, TRUE, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      orgId,
      title,
      text,
      expiresAt,
      userId,
      nowIso,
      translations ? JSON.stringify(translations) : null,
      attachments.length ? JSON.stringify(attachments) : null,
    )
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
  // Track whether title/body changed so we re-translate; if either changes we
  // re-run the whole pair (translation always needs both). Seed from the
  // existing row so a title-only edit still re-translates against the old body.
  let textChanged = false;
  let nextTitle = existing.title;
  let nextText = existing.body ?? "";
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
    nextTitle = title;
    textChanged = true;
  }
  if (typeof (body as { body?: unknown }).body === "string") {
    const text = String((body as { body: string }).body).trim();
    sets.push("body = ?");
    binds.push(text);
    nextText = text;
    textChanged = true;
  }
  // Replace the media manifest when the body carries `attachments` (a full
  // array — the composer always sends the complete current set). Absent key =
  // leave the existing attachments untouched.
  if ("attachments" in (body as object)) {
    const next = normalizeAttachments(
      (body as { attachments?: unknown }).attachments,
    );
    sets.push("attachments = ?");
    binds.push(next.length ? JSON.stringify(next) : null);
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
  // Re-translate when the title or body changed (the only fields that affect
  // translations). Best-effort, same posture as POST: a failure stores null
  // and the worker FE falls back to the freshly-edited original text.
  if (textChanged) {
    const retranslated = await translateAnnouncement({
      title: nextTitle,
      body: nextText,
      apiKey: c.env.ANTHROPIC_API_KEY,
    });
    sets.push("translations = ?");
    binds.push(retranslated ? JSON.stringify(retranslated) : null);
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

// POST /api/announcements/:id/remind — re-surface the notice to the workers who
// haven't acknowledged it. The worker app has NO push, so "remind" just stamps
// reminded_at on the announcement; the (now server-driven) worker popup treats
// a notice reminded AFTER a worker's ack as un-acked again, so it re-pops on
// that worker's next app open. A never-acked worker already sees the popup, so
// remind is idempotent and sends NOTHING external. Returns the un-acked count
// so the office can show "re-popped for N" and chase them in person. Gated by
// the `update` permission (same as hide/edit).
admin.post("/:id/remind", async (c) => {
  const denied = await requirePermission(c, "announcements", "update");
  if (denied) return denied;
  await ensureAnnouncementsTable(c.var.DB);
  const orgId = adminOrgId(c);
  const id = c.req.param("id");
  const ann = await c.var.DB.prepare(
    "SELECT * FROM announcements WHERE id = ? AND org_id = ?",
  )
    .bind(id, orgId)
    .first<AnnouncementRow>();
  if (!ann) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  // Count the un-acked active roster (the same split the acks endpoint uses).
  const rosterRes = await c.var.DB.prepare(
    "SELECT id FROM workers WHERE status = 'ACTIVE'",
  ).all<{ id: string }>();
  const rosterIds = (rosterRes.results ?? []).map((w) => w.id);
  const ackRes = await c.var.DB.prepare(
    "SELECT worker_id FROM announcement_acks WHERE announcement_id = ?",
  )
    .bind(id)
    .all<{ worker_id?: string; workerId?: string }>();
  const ackedSet = new Set<string>();
  for (const a of ackRes.results ?? []) {
    const wid = a.workerId ?? a.worker_id;
    if (wid) ackedSet.add(wid);
  }
  const pendingCount = rosterIds.filter((wid) => !ackedSet.has(wid)).length;
  // Bump reminded_at so the worker gate re-pops for anyone whose ack predates
  // it (and the never-acked already see it). One stamp, no per-worker fan-out.
  await c.var.DB.prepare(
    "UPDATE announcements SET reminded_at = ? WHERE id = ? AND org_id = ?",
  )
    .bind(new Date().toISOString(), id, orgId)
    .run();
  return c.json({ success: true, pendingCount });
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
  // Clean up the read-receipt rows so a future announcement that reuses the id
  // (it won't — ids are random — but defensively) can't inherit stale acks.
  await c.var.DB.prepare(
    "DELETE FROM announcement_acks WHERE announcement_id = ?",
  )
    .bind(id)
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
// so a future handler added here can't accidentally ship unauthenticated. We
// stash the resolved workerId on the context so the ack handler below doesn't
// have to re-resolve it (the same token → the same workers.id).
worker.use("*", async (c, next) => {
  const id = await resolveWorkerToken(c.var.DB, c.req.header("x-worker-token"));
  if (!id) return c.json({ success: false, error: "Not authenticated" }, 401);
  (c as unknown as { set: (k: string, v: unknown) => void }).set(
    "workerId",
    id,
  );
  await next();
});

// Read the workerId the middleware stashed. Always present here because the
// middleware 401s before any handler runs without a valid token.
function workerIdOf(c: Context<Env>): string {
  return (
    (c as unknown as { get: (k: string) => string | undefined }).get(
      "workerId",
    ) ?? ""
  );
}

// Cap on the past/archive list so a worker phone never pulls an unbounded
// history. The office row count is tiny, but keep it bounded anyway.
const PAST_ANNOUNCEMENTS_LIMIT = 30;

worker.get("/", async (c) => {
  await ensureAnnouncementsTable(c.var.DB);
  const workerId = workerIdOf(c);

  // ── Past/archive branch (additive) ──────────────────────────────────────
  // GET /api/worker/announcements?include=past returns the notices that have
  // DROPPED OUT of the live list — i.e. hidden (is_active=false) OR expired
  // (expires_at in the past). DELETED rows are hard-deleted from the table, so
  // they can never appear here. Read-only, newest first, capped. No ack/popup
  // data — the archive is purely re-readable history. The live (default) branch
  // below is untouched, so nothing about the existing worker home changes.
  if ((c.req.query("include") ?? "").toLowerCase() === "past") {
    const pastRes = await c.var.DB.prepare(
      "SELECT * FROM announcements WHERE org_id = ? ORDER BY created_at DESC",
    )
      .bind(DEFAULT_ORG_ID)
      .all<AnnouncementRow>();
    const past = (pastRes.results ?? []).filter(
      (r) =>
        !isActiveFlag(r.isActive ?? r.is_active ?? null) ||
        !notExpired(r.expiresAt ?? r.expires_at ?? null),
    );
    return c.json({
      success: true,
      data: past.slice(0, PAST_ANNOUNCEMENTS_LIMIT).map(toPublic),
    });
  }

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
  const active = (res.results ?? []).filter(
    (r) =>
      isActiveFlag(r.isActive ?? r.is_active ?? null) &&
      notExpired(r.expiresAt ?? r.expires_at ?? null),
  );
  // This worker's ack rows (id + when they acked). Drives the SERVER-side
  // popup gate: the phone re-pops any active notice this worker has NOT acked,
  // OR has acked but was reminded AFTER that ack (remind re-pop). Read
  // dual-keyed (PG folds snake→camel on read).
  const ackRes = await c.var.DB.prepare(
    "SELECT announcement_id, acked_at FROM announcement_acks WHERE worker_id = ?",
  )
    .bind(workerId)
    .all<{
      announcement_id?: string;
      announcementId?: string;
      acked_at?: string | null;
      ackedAt?: string | null;
    }>();
  const ackedAtById = new Map<string, string | null>();
  for (const a of ackRes.results ?? []) {
    const id = a.announcementId ?? a.announcement_id;
    if (id) ackedAtById.set(id, a.ackedAt ?? a.acked_at ?? null);
  }
  // The ids the popup should treat as already-acknowledged: acked AND not
  // reminded-since. If reminded_at is newer than this worker's ack, the notice
  // is un-acked again so the popup re-shows (and a fresh tap re-stamps it).
  const ackedIds: string[] = [];
  for (const r of active) {
    if (!ackedAtById.has(r.id)) continue;
    const ackedAt = ackedAtById.get(r.id) ?? null;
    const remindedAt = r.remindedAt ?? r.reminded_at ?? null;
    if (isRemindedSince(remindedAt, ackedAt)) continue; // re-pop
    ackedIds.push(r.id);
  }
  return c.json({
    success: true,
    data: active.map(toPublic),
    // Server-driven popup gate: the phone seeds its ack set from this, falling
    // back to its localStorage cache only when this field is absent (offline).
    ackedIds,
  });
});

// POST /api/worker/announcements/:id/ack — record THIS worker's ack of one
// active announcement. Idempotent: ON CONFLICT DO NOTHING so a double-tap (or a
// retry after a flaky network) never errors and never moves the original
// acked_at. Same insert-claim posture as wip_cascade_log.
worker.post("/:id/ack", async (c) => {
  await ensureAnnouncementsTable(c.var.DB);
  const workerId = workerIdOf(c);
  const id = c.req.param("id");
  // Only allow acking a real, active, not-expired notice for the default org —
  // an ack against a hidden/expired/unknown id is a no-op success (the popup
  // would never have shown it). Guards the table from orphan rows.
  const row = await c.var.DB.prepare(
    "SELECT * FROM announcements WHERE id = ? AND org_id = ?",
  )
    .bind(id, DEFAULT_ORG_ID)
    .first<AnnouncementRow>();
  if (
    !row ||
    !isActiveFlag(row.isActive ?? row.is_active ?? null) ||
    !notExpired(row.expiresAt ?? row.expires_at ?? null)
  ) {
    return c.json({ success: true, acked: false });
  }
  await c.var.DB.prepare(
    `INSERT INTO announcement_acks (announcement_id, worker_id, acked_at)
     VALUES (?, ?, ?)
     ON CONFLICT (announcement_id, worker_id) DO NOTHING`,
  )
    .bind(id, workerId, new Date().toISOString())
    .run();
  return c.json({ success: true, acked: true });
});

export { admin as announcementsAdmin, worker as announcementsWorker };
