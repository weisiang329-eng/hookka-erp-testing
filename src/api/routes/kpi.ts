// ---------------------------------------------------------------------------
// kpi.ts — the KPI module.
//
// Owner 2026-08-06: "直接 assign 到他的户口，只有他自己可以看得到 … 这部分只有
// Super Admin 可以操作."
//
// So there are two audiences and they are separated at the ROUTE, not in the
// page:
//   GET  /api/kpi/me              — my own card. Any signed-in user.
//   GET  /api/kpi/users/:id       — someone else's. SUPER_ADMIN only.
//   GET  /api/kpi/catalog         — what KPIs exist. SUPER_ADMIN only.
//   GET  /api/kpi/assignments/:id — what a person is measured on. SUPER_ADMIN.
//   PUT  /api/kpi/assignments/:id — set it. SUPER_ADMIN only.
//
// `/me` reads the caller's own id off the context and NEVER takes a user id
// from the request. A page that asks "whose card?" is one query-string edit
// away from being everyone's card.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { requireSuperAdmin } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { ensureKpiTables } from "../lib/ensure-kpi-tables";
import {
  KPI_CATALOG,
  GATE_FAIL_CAP,
  attainment,
  kpiByKey,
  kpisForRole,
  type KpiDef,
} from "../lib/kpi-catalog";
import { computeMetric, checklistProgress } from "../lib/kpi-metrics";

const app = new Hono<Env>();

const ctxGet = (c: Context<Env>, k: string): string =>
  (c as unknown as { get: (k: string) => string | undefined }).get(k) ?? "";

/** YYYY-MM, defaulting to the current month. */
function periodOf(c: Context<Env>): string {
  const p = (c.req.query("period") ?? "").trim();
  return /^\d{4}-\d{2}$/.test(p) ? p : new Date().toISOString().slice(0, 7);
}

interface AssignmentRow {
  kpiKey: string;
  target: number;
  weight: number;
  isActive: boolean;
}

async function loadAssignments(
  c: Context<Env>,
  userId: string,
): Promise<Map<string, AssignmentRow>> {
  const res = await c.var.DB.prepare(
    `SELECT kpiKey, target, weight, isActive FROM kpi_assignments
      WHERE userId = ? AND orgId = ?`,
  )
    .bind(userId, getOrgId(c))
    .all<AssignmentRow>();
  const m = new Map<string, AssignmentRow>();
  for (const r of res.results ?? []) m.set(String(r.kpiKey), r);
  return m;
}

interface CardLine {
  key: string;
  label: string;
  detail: string;
  scoring: KpiDef["scoring"];
  /** Plain-English derivation, shown to the person being measured. */
  formula: string;
  checklistItems?: string[];
  shape: KpiDef["shape"];
  unit: KpiDef["unit"];
  available: boolean;
  blockedBy?: string;
  drillPath?: string;
  target: number;
  weight: number;
  actual: number | null;
  attainment: number | null;
  points: number | null;
  evidence: string;
  sampleSize: number;
}

/**
 * Build one person's card for one month.
 *
 * A LOCKED period is served from kpi_periods verbatim — a settled month must
 * not move because a target was edited afterwards. An open month is computed
 * live, so the person can watch it during the month rather than finding out on
 * the 1st.
 */
async function buildCard(c: Context<Env>, userId: string, role: string, period: string) {
  await ensureKpiTables(c.var.DB);
  const orgId = getOrgId(c);

  const locked = await c.var.DB.prepare(
    `SELECT kpiKey, target, weight, actual, attainment, points, detail
       FROM kpi_periods
      WHERE userId = ? AND period = ? AND orgId = ? AND lockedAt IS NOT NULL`,
  )
    .bind(userId, period, orgId)
    .all<{
      kpiKey: string; target: number; weight: number;
      actual: number | null; attainment: number | null;
      points: number | null; detail: string | null;
    }>();
  const lockedRows = locked.results ?? [];
  const isLocked = lockedRows.length > 0;

  const assigned = await loadAssignments(c, userId);
  const offered = kpisForRole(role);
  // A person is measured on what they were ASSIGNED. The role catalogue is
  // only the menu Super Admin picks from — assigning nothing must show an
  // empty card, not silently score them on every default.
  const lines: CardLine[] = [];

  for (const def of offered) {
    const a = assigned.get(def.key);
    if (!a || a.isActive === false) continue;

    if (isLocked) {
      const row = lockedRows.find((r) => r.kpiKey === def.key);
      if (!row) continue;
      lines.push({
        key: def.key, label: def.label, detail: def.detail,
        scoring: def.scoring, formula: def.formula, checklistItems: def.checklistItems,
        shape: def.shape, unit: def.unit, available: def.available,
        blockedBy: def.blockedBy, drillPath: def.drillPath,
        target: Number(row.target), weight: Number(row.weight),
        actual: row.actual === null ? null : Number(row.actual),
        attainment: row.attainment === null ? null : Number(row.attainment),
        points: row.points === null ? null : Number(row.points),
        evidence: row.detail ?? "", sampleSize: 0,
      });
      continue;
    }

    if (!def.available) {
      lines.push({
        key: def.key, label: def.label, detail: def.detail,
        scoring: def.scoring, formula: def.formula, checklistItems: def.checklistItems,
        shape: def.shape, unit: def.unit, available: false,
        blockedBy: def.blockedBy, drillPath: def.drillPath,
        target: Number(a.target), weight: Number(a.weight),
        actual: null, attainment: null, points: null,
        evidence: def.blockedBy ?? "Not measurable yet", sampleSize: 0,
      });
      continue;
    }

    const m =
      def.scoring === "CHECKLIST"
        ? await checklistProgress(c, userId, def.key, period, def.checklistItems?.length ?? 0)
        : await computeMetric(c, def.key, period);
    const att =
      m.actual === null ? null : attainment(def, Number(a.target), m.actual);
    lines.push({
      key: def.key, label: def.label, detail: def.detail,
      scoring: def.scoring, formula: def.formula, checklistItems: def.checklistItems,
      shape: def.shape, unit: def.unit, available: true,
      drillPath: def.drillPath,
      target: Number(a.target), weight: Number(a.weight),
      actual: m.actual,
      attainment: def.shape === "GATE" ? null : att,
      points:
        def.shape === "GATE" || att === null
          ? null
          : Math.round((att / 100) * Number(a.weight) * 10) / 10,
      evidence: m.detail, sampleSize: m.sampleSize,
    });
  }

  // Weighted total over the RATIO lines only, then the gate cap.
  const ratio = lines.filter((l) => l.shape !== "GATE" && l.points !== null);
  const weightUsed = ratio.reduce((s, l) => s + l.weight, 0);
  const earned = ratio.reduce((s, l) => s + (l.points ?? 0), 0);
  // Scored out of the weight ACTUALLY measurable, so the two unbuilt KPIs do
  // not drag the score to 60% of itself and make the number meaningless.
  const raw = weightUsed > 0 ? Math.round((earned / weightUsed) * 1000) / 10 : null;

  const gates = lines.filter((l) => l.shape === "GATE");
  const gateFailed = gates.some(
    (g) => g.actual !== null && g.actual > g.target,
  );
  const score =
    raw === null ? null : gateFailed ? Math.min(GATE_FAIL_CAP, raw) : raw;

  return {
    period,
    userId,
    role,
    locked: isLocked,
    lines,
    rawScore: raw,
    score,
    gateFailed,
    gateCap: GATE_FAIL_CAP,
    weightMeasured: weightUsed,
    weightUnbuilt: lines
      .filter((l) => !l.available)
      .reduce((s, l) => s + l.weight, 0),
  };
}

// ---- My own card ----------------------------------------------------------
app.get("/me", async (c) => {
  const userId = ctxGet(c, "userId");
  if (!userId) return c.json({ success: false, error: "Unauthorized" }, 401);
  const role = ctxGet(c, "userRole").toUpperCase();
  const data = await buildCard(c, userId, role, periodOf(c));
  return c.json({ success: true, data });
});

// ---- Anyone's card — SUPER_ADMIN only -------------------------------------
app.get("/users/:id", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  const id = c.req.param("id");
  const u = await c.var.DB.prepare(
    "SELECT id, role FROM users WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; role: string }>();
  if (!u) return c.json({ success: false, error: "User not found" }, 404);
  const data = await buildCard(c, String(u.id), String(u.role).toUpperCase(), periodOf(c));
  return c.json({ success: true, data });
});

// ---- Checklist ticks -------------------------------------------------------
//
// A person ticks their OWN items; Super Admin may tick anyone's and is the one
// who verifies. Both go through here, and the id comes from the context for a
// self-tick — never from the body — so "my checklist" cannot be pointed at
// someone else's month.
app.put("/checklist/:kpiKey", async (c) => {
  await ensureKpiTables(c.var.DB);
  const kpiKey = c.req.param("kpiKey");
  const def = kpiByKey(kpiKey);
  if (!def || def.scoring !== "CHECKLIST") {
    return c.json({ success: false, error: `${kpiKey} is not a checklist KPI` }, 400);
  }

  let body: { userId?: string; period?: string; itemIndex?: number; done?: boolean; note?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const self = ctxGet(c, "userId");
  const isAdmin = requireSuperAdmin(c) === null;
  // Only a Super Admin may tick on someone else's behalf.
  const userId = body.userId && isAdmin ? String(body.userId) : self;
  if (!userId) return c.json({ success: false, error: "Unauthorized" }, 401);
  if (body.userId && !isAdmin && String(body.userId) !== self) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  const period = /^\d{4}-\d{2}$/.test(String(body.period ?? "")) ? String(body.period) : periodOf(c);
  const idx = Number(body.itemIndex);
  const total = def.checklistItems?.length ?? 0;
  if (!Number.isInteger(idx) || idx < 0 || idx >= total) {
    return c.json({ success: false, error: `itemIndex must be 0–${total - 1}` }, 400);
  }

  // A settled month is closed to edits — the score was agreed against it.
  const locked = await c.var.DB.prepare(
    `SELECT 1 AS x FROM kpi_periods
      WHERE userId = ? AND period = ? AND lockedAt IS NOT NULL LIMIT 1`,
  )
    .bind(userId, period)
    .first<{ x: number }>();
  if (locked) {
    return c.json({ success: false, error: `${period} is already settled` }, 400);
  }

  const done = body.done !== false;
  await c.var.DB.prepare(
    `INSERT INTO kpi_checklist_ticks
       (id, userId, period, kpiKey, itemIndex, done, verifiedBy, verifiedAt, note, orgId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (userId, period, kpiKey, itemIndex) DO UPDATE
       SET done = EXCLUDED.done, verifiedBy = EXCLUDED.verifiedBy,
           verifiedAt = EXCLUDED.verifiedAt, note = EXCLUDED.note, updatedAt = NOW()`,
  )
    .bind(
      `kct_${userId}_${period}_${kpiKey}_${idx}`,
      userId, period, kpiKey, idx, done,
      isAdmin ? self : null,
      isAdmin ? new Date().toISOString() : null,
      body.note ?? null,
      getOrgId(c),
    )
    .run();
  return c.json({ success: true });
});

/** Which items are ticked, for rendering the boxes. */
app.get("/checklist/:kpiKey", async (c) => {
  await ensureKpiTables(c.var.DB);
  const kpiKey = c.req.param("kpiKey");
  const self = ctxGet(c, "userId");
  const isAdmin = requireSuperAdmin(c) === null;
  const wanted = c.req.query("userId");
  const userId = wanted && isAdmin ? wanted : self;
  if (!userId) return c.json({ success: false, error: "Unauthorized" }, 401);
  const res = await c.var.DB.prepare(
    `SELECT itemIndex, done, verifiedBy, note FROM kpi_checklist_ticks
      WHERE userId = ? AND period = ? AND kpiKey = ?`,
  )
    .bind(userId, periodOf(c), kpiKey)
    .all<{ itemIndex: number; done: boolean; verifiedBy: string | null; note: string | null }>();
  return c.json({ success: true, data: res.results ?? [] });
});

// ---- Library: every KPI, its live value, and who holds it ------------------
//
// Answers the question the old screen could not: "what KPIs do we have?"
// You had to pick a person and open the assign dialog before any KPI was
// visible, which is backwards — the target is decided by looking at the
// current number, so the current number has to be on the list.
app.get("/library", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  await ensureKpiTables(c.var.DB);
  const period = periodOf(c);
  const orgId = getOrgId(c);

  const holders = await c.var.DB.prepare(
    `SELECT a.kpiKey, u.id AS "userId", u.email, u.displayName, u.role
       FROM kpi_assignments a
       JOIN users u ON u.id = a.userId
      WHERE a.orgId = ? AND a.isActive = TRUE`,
  )
    .bind(orgId)
    .all<{ kpiKey: string; userId: string; email: string; displayName: string | null; role: string }>();

  const byKpi = new Map<string, Array<{ userId: string; name: string; role: string }>>();
  for (const h of holders.results ?? []) {
    const list = byKpi.get(String(h.kpiKey)) ?? [];
    list.push({
      userId: String(h.userId),
      name: h.displayName || String(h.email).split("@")[0],
      role: String(h.role ?? ""),
    });
    byKpi.set(String(h.kpiKey), list);
  }

  const data = [];
  for (const def of KPI_CATALOG) {
    // The company-level current value, so a target can be set against reality
    // rather than against a guess.
    const m = def.available
      ? await computeMetric(c, def.key, period)
      : { actual: null, sampleSize: 0, detail: def.blockedBy ?? "" };
    data.push({
      ...def,
      current: m.actual,
      evidence: m.detail,
      sampleSize: m.sampleSize,
      assignedTo: byKpi.get(def.key) ?? [],
    });
  }
  return c.json({ success: true, period, data, gateCap: GATE_FAIL_CAP });
});

// ---- People: everyone's score for a period, without clicking in -----------
app.get("/people", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  await ensureKpiTables(c.var.DB);
  const period = periodOf(c);

  const users = await c.var.DB.prepare(
    `SELECT id, email, displayName, role FROM users
      WHERE role IS NOT NULL AND role <> '' ORDER BY role, email`,
  ).all<{ id: string; email: string; displayName: string | null; role: string }>();

  // Owner 2026-08-06 asked for the previous month alongside. A score with no
  // comparison says nothing about whether anything is being fixed — 22 after a
  // 45 is a different conversation from 22 after a 9.
  const [py, pm] = period.split("-").map(Number);
  const prevDate = new Date(Date.UTC(py, pm - 2, 1));
  const prevPeriod = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, "0")}`;

  const out = [];
  for (const u of users.results ?? []) {
    const role = String(u.role).toUpperCase();
    const card = await buildCard(c, String(u.id), role, period);
    // Only pay for the second computation when there is something to compare.
    const prev = card.lines.length
      ? await buildCard(c, String(u.id), role, prevPeriod)
      : null;
    // Only people who actually carry KPIs are interesting here; the rest are
    // listed with a dash so it is obvious nobody was skipped.
    out.push({
      userId: String(u.id),
      name: u.displayName || String(u.email).split("@")[0],
      email: String(u.email),
      role,
      kpiCount: card.lines.length,
      score: card.score,
      rawScore: card.rawScore,
      gateFailed: card.gateFailed,
      prevPeriod,
      prevScore: prev?.score ?? null,
      delta:
        card.score !== null && prev?.score != null
          ? Math.round((card.score - prev.score) * 10) / 10
          : null,
    });
  }
  return c.json({ success: true, period, data: out });
});

// ---- The menu Super Admin assigns from ------------------------------------
app.get("/catalog", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  const role = (c.req.query("role") ?? "").toUpperCase();
  return c.json({
    success: true,
    data: role ? kpisForRole(role) : KPI_CATALOG,
    gateCap: GATE_FAIL_CAP,
  });
});

// ---- Read / set a person's assignments ------------------------------------
app.get("/assignments/:id", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  await ensureKpiTables(c.var.DB);
  const res = await c.var.DB.prepare(
    `SELECT kpiKey, target, weight, isActive FROM kpi_assignments
      WHERE userId = ? AND orgId = ?`,
  )
    .bind(c.req.param("id"), getOrgId(c))
    .all<AssignmentRow>();
  return c.json({ success: true, data: res.results ?? [] });
});

app.put("/assignments/:id", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  await ensureKpiTables(c.var.DB);
  const userId = c.req.param("id");
  const orgId = getOrgId(c);
  const actor = ctxGet(c, "userId");

  let body: { assignments?: Array<{ kpiKey: string; target: number; weight: number; isActive?: boolean }> };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const rows = Array.isArray(body.assignments) ? body.assignments : [];

  for (const r of rows) {
    const def = kpiByKey(String(r.kpiKey));
    if (!def) {
      return c.json(
        { success: false, error: `Unknown KPI: ${r.kpiKey}` },
        400,
      );
    }
    const target = Number(r.target);
    const weight = Number(r.weight);
    if (!Number.isFinite(target) || target < 0) {
      return c.json({ success: false, error: `${r.kpiKey}: target must be a number ≥ 0` }, 400);
    }
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
      return c.json({ success: false, error: `${r.kpiKey}: weight must be 0–100` }, 400);
    }
    await c.var.DB.prepare(
      `INSERT INTO kpi_assignments (id, userId, kpiKey, target, weight, isActive, assignedBy, orgId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (userId, kpiKey) DO UPDATE
         SET target = EXCLUDED.target, weight = EXCLUDED.weight,
             isActive = EXCLUDED.isActive, assignedBy = EXCLUDED.assignedBy,
             updatedAt = NOW()`,
    )
      .bind(
        `kpia_${userId}_${r.kpiKey}`,
        userId,
        String(r.kpiKey),
        target,
        weight,
        r.isActive !== false,
        actor,
        orgId,
      )
      .run();
  }
  return c.json({ success: true, saved: rows.length, ...weightAdvice(rows) });
});

/**
 * Assign ONE KPI to several people at once.
 *
 * The per-person route still exists, but the library assigns the other way
 * round — you are looking at a KPI and deciding who carries it. Doing that
 * through the per-person endpoint would mean one request per person and a
 * half-applied state if one failed.
 */
app.put("/kpi/:kpiKey/assignees", async (c) => {
  const denied = requireSuperAdmin(c);
  if (denied) return denied;
  await ensureKpiTables(c.var.DB);
  const kpiKey = c.req.param("kpiKey");
  const def = kpiByKey(kpiKey);
  if (!def) return c.json({ success: false, error: `Unknown KPI: ${kpiKey}` }, 400);

  let body: { assignees?: Array<{ userId: string; target: number; weight?: number; isActive?: boolean }> };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const rows = Array.isArray(body.assignees) ? body.assignees : [];
  const orgId = getOrgId(c);
  const actor = ctxGet(c, "userId");

  for (const r of rows) {
    const target = Number(r.target);
    // A gate earns no points, so its weight is always 0 whatever is sent.
    const weight = def.shape === "GATE" ? 0 : Number(r.weight ?? def.defaultWeight);
    if (!Number.isFinite(target) || target < 0) {
      return c.json({ success: false, error: `${r.userId}: target must be ≥ 0` }, 400);
    }
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
      return c.json({ success: false, error: `${r.userId}: weight must be 0–100` }, 400);
    }
    await c.var.DB.prepare(
      `INSERT INTO kpi_assignments (id, userId, kpiKey, target, weight, isActive, assignedBy, orgId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (userId, kpiKey) DO UPDATE
         SET target = EXCLUDED.target, weight = EXCLUDED.weight,
             isActive = EXCLUDED.isActive, assignedBy = EXCLUDED.assignedBy,
             updatedAt = NOW()`,
    )
      .bind(
        `kpia_${r.userId}_${kpiKey}`,
        String(r.userId), kpiKey, target, weight,
        r.isActive !== false, actor, orgId,
      )
      .run();
  }
  // One KPI across several people — a weight TOTAL is meaningless here (it is
  // per person, not per KPI), so no advice is returned.
  return c.json({ success: true, saved: rows.length });
});

/**
 * Weights should total 100 across a person's RATIO KPIs.
 *
 * Reported, not enforced: a half-finished assignment is a normal state to save
 * in, and refusing it would make the admin juggle the last two rows to get out
 * of the dialog. The card shows what it was actually scored out of either way.
 */
function weightAdvice(rows: Array<{ kpiKey: string; weight?: number; isActive?: boolean }>) {
  let total = 0;
  for (const r of rows) {
    if (r.isActive === false) continue;
    if (kpiByKey(String(r.kpiKey))?.shape === "GATE") continue;
    total += Number(r.weight) || 0;
  }
  return {
    weightTotal: Math.round(total * 10) / 10,
    weightWarning:
      total === 100 ? null : `Weights total ${Math.round(total * 10) / 10}, not 100`,
  };
}

export default app;
