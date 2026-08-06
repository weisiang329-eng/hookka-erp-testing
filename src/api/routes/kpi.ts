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
import { computeMetric } from "../lib/kpi-metrics";

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
        shape: def.shape, unit: def.unit, available: false,
        blockedBy: def.blockedBy, drillPath: def.drillPath,
        target: Number(a.target), weight: Number(a.weight),
        actual: null, attainment: null, points: null,
        evidence: def.blockedBy ?? "Not measurable yet", sampleSize: 0,
      });
      continue;
    }

    const m = await computeMetric(c, def.key, period);
    const att =
      m.actual === null ? null : attainment(def, Number(a.target), m.actual);
    lines.push({
      key: def.key, label: def.label, detail: def.detail,
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
  return c.json({ success: true, saved: rows.length });
});

export default app;
