// ---------------------------------------------------------------------------
// Org chart — the ONE place that answers "who reports to whom" across both
// tables of people.
//
//   GET  /api/org-chart            → every person + their reporting line
//   PUT  /api/org-chart/reporting  → set or clear one person's manager
//
// Hookka keeps office accounts in `users` and the factory floor in `workers`,
// with no link between them (owner 2026-08-01: 「要的」— workers belong on the
// chart). So a node is keyed by (source, id) and the edges live in their own
// table, which is the only way an edge can cross the two: a Fab Cut operator
// reporting to the Production Manager is one row, and neither side needs an
// account it does not have.
//
// Every factory worker is placed in Production regardless of their production
// sub-department (Fab Cut, Framing, …) — that split is a costing dimension, not
// a reporting line.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import {
  personKey,
  parsePersonKey,
  wouldCycle,
  type OrgPerson,
} from "../../lib/org-people";

const app = new Hono<Env>();

/** Factory workers all sit under one department on the chart. */
const WORKER_DEPARTMENT = "Production";

// Runtime self-apply. Migrations are inert on deploy in this repo — the table
// exists only because this runs and is AWAITED before the first read or write.
let _mig: Promise<void> | null = null;
function ensureOrgReporting(db: D1Database): Promise<void> {
  if (_mig) return _mig;
  _mig = (async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS org_reporting (
           person_key  TEXT PRIMARY KEY,
           manager_key TEXT,
           updated_at  TEXT
         )`,
      )
      .run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_org_reporting_manager ON org_reporting (manager_key)",
      )
      .run();
  })();
  return _mig;
}

/** For tests — reset the module-level migration cache. */
export function _resetOrgReportingMigForTests(): void {
  _mig = null;
}

/**
 * Everyone on the chart, from both tables.
 *
 * `users.reportsTo` is honoured as a FALLBACK for office accounts that were
 * already wired up before this table existed, so the existing chart does not
 * reset itself to flat on the day this ships.
 */
async function loadPeople(db: D1Database): Promise<OrgPerson[]> {
  const people: OrgPerson[] = [];

  const uRes = await db
    .prepare(
      "SELECT id, displayName, email, department, position, reportsTo, isActive FROM users",
    )
    .all<{
      id: string;
      displayName: string | null;
      email: string | null;
      department: string | null;
      position: string | null;
      reportsTo: string | null;
      isActive: boolean | number | null;
    }>();
  for (const u of uRes.results ?? []) {
    people.push({
      key: personKey("user", u.id),
      source: "user",
      id: String(u.id),
      name: (u.displayName || u.email || String(u.id)).trim(),
      position: (u.position ?? "").trim(),
      departmentCode: (u.department ?? "").trim(),
      ref: (u.email ?? "").trim(),
      active: u.isActive !== false && u.isActive !== 0,
      managerKey: u.reportsTo ? personKey("user", u.reportsTo) : null,
    });
  }

  const wRes = await db
    .prepare("SELECT id, empNo, name, position, status FROM workers WHERE empNo NOT LIKE 'TEST%'")
    .all<{
      id: string;
      empNo: string | null;
      name: string | null;
      position: string | null;
      status: string | null;
    }>();
  for (const w of wRes.results ?? []) {
    people.push({
      key: personKey("worker", w.id),
      source: "worker",
      id: String(w.id),
      name: (w.name || w.empNo || String(w.id)).trim(),
      position: (w.position ?? "").trim(),
      departmentCode: WORKER_DEPARTMENT,
      ref: (w.empNo ?? "").trim(),
      active: (w.status ?? "").toUpperCase() === "ACTIVE",
      managerKey: null,
    });
  }

  // Explicit edges win over the legacy users.reportsTo fallback.
  const eRes = await db
    .prepare("SELECT person_key, manager_key FROM org_reporting")
    .all<{ person_key: string; manager_key: string | null }>();
  const edges = new Map<string, string | null>();
  for (const e of eRes.results ?? []) edges.set(e.person_key, e.manager_key ?? null);
  for (const p of people) {
    if (edges.has(p.key)) p.managerKey = edges.get(p.key) ?? null;
  }
  return people;
}

app.get("/", async (c) => {
  const denied = await requirePermission(c, "users", "read");
  if (denied) return denied;
  await ensureOrgReporting(c.var.DB);
  const people = await loadPeople(c.var.DB);
  return c.json({ success: true, data: people, total: people.length });
});

app.put("/reporting", async (c) => {
  const denied = await requirePermission(c, "users", "update");
  if (denied) return denied;
  let body: { personKey?: unknown; managerKey?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
  const pk = typeof body.personKey === "string" ? body.personKey.trim() : "";
  const mkRaw = typeof body.managerKey === "string" ? body.managerKey.trim() : "";
  const mk = mkRaw || null;

  if (!parsePersonKey(pk)) {
    return c.json({ success: false, error: "personKey must be user:<id> or worker:<id>" }, 400);
  }
  if (mk && !parsePersonKey(mk)) {
    return c.json({ success: false, error: "managerKey must be user:<id> or worker:<id>" }, 400);
  }

  await ensureOrgReporting(c.var.DB);
  const people = await loadPeople(c.var.DB);
  const byKey = new Map(people.map((p) => [p.key, p]));
  if (!byKey.has(pk)) return c.json({ success: false, error: "Person not found" }, 400);
  if (mk && !byKey.has(mk)) return c.json({ success: false, error: "Manager not found" }, 400);

  // A cycle does not throw — it silently drops everyone inside the loop off the
  // chart, with nothing to explain where they went. Refuse before writing.
  const managerOf = new Map(people.map((p) => [p.key, p.managerKey]));
  if (wouldCycle(pk, mk, managerOf)) {
    return c.json(
      { success: false, error: "That reporting line would create a loop." },
      400,
    );
  }

  const now = new Date().toISOString();
  await c.var.DB.batch([
    c.var.DB.prepare("DELETE FROM org_reporting WHERE person_key = ?").bind(pk),
    c.var.DB
      .prepare(
        "INSERT INTO org_reporting (person_key, manager_key, updated_at) VALUES (?, ?, ?)",
      )
      .bind(pk, mk, now),
  ]);
  return c.json({ success: true, data: { personKey: pk, managerKey: mk } });
});

export default app;
