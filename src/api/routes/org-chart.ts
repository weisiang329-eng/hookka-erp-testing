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

/** Fallback for a worker with no department of their own. */
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
    .prepare(
      "SELECT id, empNo, name, position, status, departmentCode FROM workers WHERE empNo NOT LIKE 'TEST%'",
    )
    .all<{
      id: string;
      empNo: string | null;
      name: string | null;
      position: string | null;
      status: string | null;
      departmentCode?: string | null;
      departmentcode?: string | null;
    }>();
  for (const w of wRes.results ?? []) {
    people.push({
      key: personKey("worker", w.id),
      source: "worker",
      id: String(w.id),
      name: (w.name || w.empNo || String(w.id)).trim(),
      position: (w.position ?? "").trim(),
      // Every worker used to be forced to "Production", which put all 40 of
      // them in ONE column and left the chart with nothing to divide by —
      // owner 2026-08-02:「Employee 那边,需要按照部门去划分」. They already
      // carry their real department (FAB_CUT, FAB_SEW, WOOD_CUT…); the chart
      // was just throwing it away. Dual-keyed, per the repo rule.
      departmentCode:
        (w.departmentCode ?? w.departmentcode ?? "").trim() || WORKER_DEPARTMENT,
      ref: (w.empNo ?? "").trim(),
      active: (w.status ?? "").toUpperCase() === "ACTIVE",
      managerKey: null,
    });
  }

  // Explicit edges win over the legacy users.reportsTo fallback.
  //
  // Read through batch() — i.e. inside `sql.begin` — ON PURPOSE. Hyperdrive
  // caches plain read queries, and `SELECT person_key, manager_key FROM
  // org_reporting` is about as cacheable as a query gets: same text every
  // time, tiny result. Measured on staging 2026-08-02: after a PUT that
  // returned 200, GET flapped between the new value and the old one for tens
  // of seconds across otherwise identical requests. To an operator that is
  // 「完全没有反应」— they set a manager, the chart does not move, they set it
  // again. Hyperdrive does not cache inside an explicit transaction, so the
  // one read that MUST be read-your-writes goes through one.
  type EdgeRow = {
    personKey?: string;
    person_key?: string;
    managerKey?: string | null;
    manager_key?: string | null;
  };
  const eBatch = await db.batch<EdgeRow>([
    db.prepare("SELECT person_key, manager_key FROM org_reporting"),
  ]);
  const eRes = { results: eBatch[0]?.results ?? [] };
  const edges = new Map<string, string | null>();
  // DUAL-KEY. db-pg's columnFrom camelCases every column it returns, so these
  // rows arrive as personKey / managerKey — reading `e.person_key` gave
  // `undefined`, the map became { undefined => null }, `edges.has(p.key)` was
  // never true, and EVERY saved reporting line was invisible. The PUT returned
  // 200 with the right body and the chart still showed "no manager (top)":
  // owner 2026-08-02「完全没有反应」. See docs/PLAYBOOKS.md → fix-camelCase-read-bug.
  for (const e of eRes.results ?? []) {
    const pk = e.personKey ?? e.person_key;
    if (!pk) continue;
    edges.set(pk, e.managerKey ?? e.manager_key ?? null);
  }
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
  // Ship the department list alongside the people so a department added in
  // Settings shows up on the chart with its real NAME and its real order,
  // instead of falling to the end of a hardcoded list under its raw code
  // (owner 2026-08-02: 「无论是有新添加的人或者部门…这整个东西就会做出来」).
  // Best-effort: the chart still renders from the codes if this read fails.
  let departments: Array<{ code: string; name: string; sequence: number }> = [];
  try {
    const dRes = await c.var.DB.prepare(
      "SELECT code, name, sequence FROM departments ORDER BY sequence, name",
    ).all<{ code: string; name: string | null; sequence: number | null }>();
    departments = (dRes.results ?? []).map((d, i) => ({
      code: d.code,
      name: (d.name ?? d.code).trim(),
      sequence: Number(d.sequence ?? i),
    }));
  } catch (e) {
    console.error("[org-chart] department list unavailable:", e);
  }
  return c.json({
    success: true,
    data: people,
    departments,
    total: people.length,
  });
});

// ---------------------------------------------------------------------------
// POST /api/org-chart/auto-wire-production
//
// Builds the FACTORY half of the tree in one go. Owner 2026-08-02: the chart
// showed 44 separate roots because nothing infers a hierarchy — the dropdown
// sets ONE edge at a time, and marking yourself "no manager (top)" only says
// you have no manager; it pulls nobody under you.
//
// The rules, from the owner, in order:
//   1. an Operator Leader is their department's head
//   2. every other worker in that department reports to their department's head
//   3. a department with no leader reports straight to the Production Head
//   4. the leaders themselves report to the Production Head
//
// Deliberately scoped to WORKERS. The office reporting lines are already set by
// hand (Violet → owner, Production Head → Violet, and so on) and this must not
// touch them — 「就跟着 reporting line」. It never writes an edge for a `user:`
// key, and it never overwrites an existing worker edge unless asked to.
//
// Category (BEDFRAME / SOFA) is NOT used to split anyone. Only the two leaders
// carry one; all fifteen operators under them are blank, so splitting on it
// would be guessing. Owner: 「暂时不看 category 之后才看 先根据部门区分」.
// Houzs reach the same conclusion in their own UI copy — sub-groups are
// "for visibility only", not a reporting line.
//
// DRY-RUN BY DEFAULT. It rewires the whole factory; ?apply=1 to write.
// ---------------------------------------------------------------------------
app.post("/auto-wire-production", async (c) => {
  const denied = await requirePermission(c, "users", "update");
  if (denied) return denied;
  await ensureOrgReporting(c.var.DB);

  const productionHeadKey = (c.req.query("head") ?? "").trim();
  if (!parsePersonKey(productionHeadKey)) {
    return c.json(
      {
        success: false,
        error:
          "head=<user:id|worker:id> is required — the Production Head everything hangs from.",
      },
      400,
    );
  }
  const apply = c.req.query("apply") === "1";
  const overwrite = c.req.query("overwrite") === "1";

  const people = await loadPeople(c.var.DB);
  const byKey = new Map(people.map((p) => [p.key, p]));
  if (!byKey.has(productionHeadKey)) {
    return c.json({ success: false, error: "Production Head not found" }, 400);
  }

  // ACTIVE workers only. A resigned operator on the chart is a person the
  // factory no longer has, and their line would outlive them.
  const workers = people.filter((p) => p.source === "worker" && p.active);

  // One head per department: its Operator Leader. Two leaders in the same
  // department is real here (Upholstery has two), so the SECOND one becomes a
  // head in its own right rather than a report of the first — they are peers.
  const leadersByDept = new Map<string, string[]>();
  for (const w of workers) {
    if (!/leader|head|supervisor/i.test(w.position ?? "")) continue;
    const d = (w.departmentCode || "").trim();
    if (!d) continue;
    const arr = leadersByDept.get(d) ?? [];
    arr.push(w.key);
    leadersByDept.set(d, arr);
  }

  // Explicit department -> head overrides, for the cases the data cannot state:
  // a leader who also covers a department they are not filed under (the owner's
  // ANN covers Fabric Cutting as well as her own Fabric Sewing), and a
  // department whose two leaders must be split between them.
  //   ?map=FAB_CUT:worker-d636133a,FRAMING:worker-f8ad8074
  for (const pair of (c.req.query("map") ?? "").split(",")) {
    const [dept, id] = pair.split(":");
    if (!dept || !id) continue;
    const key = id.includes(":") ? id : personKey("worker", id);
    if (byKey.has(key)) leadersByDept.set(dept.trim(), [key]);
  }

  const planned: Array<{ personKey: string; name: string; managerKey: string; why: string }> = [];
  for (const w of workers) {
    if (w.key === productionHeadKey) continue;
    const dept = (w.departmentCode || "").trim();
    const heads = leadersByDept.get(dept) ?? [];
    // A leader is a PEER of every other leader, wherever they are filed.
    // ZAW LIN's primary department is Upholstery but he heads Framing, so
    // checking only his OWN department made him a report of Upholstery's head
    // — one Operator Leader under another, a rank nobody stated.
    const isHeadAnywhere = [...leadersByDept.values()].some((ks) => ks.includes(w.key));
    const manager = isHeadAnywhere || heads.length === 0 ? productionHeadKey : heads[0];
    const why = isHeadAnywhere
      ? `${dept} head → Production Head`
      : heads.length === 0
        ? `${dept} has no leader → Production Head`
        : `${dept} → its leader`;
    if (!overwrite && w.managerKey && w.managerKey !== manager) continue;
    if (w.managerKey === manager) continue;
    planned.push({ personKey: w.key, name: w.name, managerKey: manager, why });
  }

  if (!apply) {
    return c.json({
      success: true,
      dryRun: true,
      wouldWire: planned.length,
      productionHead: byKey.get(productionHeadKey)?.name ?? productionHeadKey,
      heads: [...leadersByDept.entries()].map(([d, ks]) => ({
        department: d,
        heads: ks.map((k) => byKey.get(k)?.name ?? k),
      })),
      data: planned,
      hint: "POST again with ?apply=1 to write. Office reporting lines are never touched.",
    });
  }

  const now = new Date().toISOString();
  for (const p of planned) {
    await c.var.DB.batch([
      c.var.DB.prepare("DELETE FROM org_reporting WHERE person_key = ?").bind(p.personKey),
      c.var.DB
        .prepare(
          "INSERT INTO org_reporting (person_key, manager_key, updated_at) VALUES (?, ?, ?)",
        )
        .bind(p.personKey, p.managerKey, now),
    ]);
  }
  return c.json({ success: true, dryRun: false, wired: planned.length, data: planned });
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
