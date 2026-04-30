// ---------------------------------------------------------------------------
// R&D Team Members route — the "Maintenance" surface for R&D-only people.
//
// Distinct from the existing /api/workers (production-floor staff with full
// payroll calculation rules). R&D folks are a much smaller set with a
// simpler model:
//   * FULL_TIME: hourlyRateSen drives auto-computed labour cost on a project
//     when hours are logged (hours * hourlyRateSen).
//   * PART_TIME: monthlyFixedCostSen is a flat overhead recorded per member;
//     it does NOT get allocated per logged hour against a project's labour
//     cost (see rd-projects.ts cost computation comment for the rationale).
//
// Soft delete: DELETE flips active=false rather than removing the row, so
// historical rd_labour_hours rows still resolve to a member name.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type EmploymentType = "FULL_TIME" | "PART_TIME";

type TeamMemberRow = {
  id: string;
  name: string;
  employmentType: EmploymentType;
  hourlyRateSen: number | null;
  monthlyFixedCostSen: number | null;
  active: boolean;
  notes: string | null;
  orgId: string;
  createdAt: string;
  updatedAt: string | null;
};

function rowToMember(row: TeamMemberRow) {
  return {
    id: row.id,
    name: row.name,
    employmentType: row.employmentType,
    hourlyRateSen: row.hourlyRateSen ?? null,
    monthlyFixedCostSen: row.monthlyFixedCostSen ?? null,
    active: row.active,
    notes: row.notes ?? "",
    orgId: row.orgId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function genId(): string {
  return `rdtm-${crypto.randomUUID().slice(0, 8)}`;
}

function isEmploymentType(v: unknown): v is EmploymentType {
  return v === "FULL_TIME" || v === "PART_TIME";
}

// GET /api/rd-team-members?active=true — list members, optionally only active.
app.get("/", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "read");
  if (denied) return denied;
  const onlyActive = c.req.query("active") === "true";
  const stmt = onlyActive
    ? c.var.DB.prepare(
        "SELECT * FROM rd_team_members WHERE active = true ORDER BY name",
      )
    : c.var.DB.prepare("SELECT * FROM rd_team_members ORDER BY name");
  const res = await stmt.all<TeamMemberRow>();
  const data = (res.results ?? []).map(rowToMember);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/rd-team-members — create.
// Body: { name, employmentType, hourlyRateSen?, monthlyFixedCostSen?, notes? }
app.post("/", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "create");
  if (denied) return denied;
  try {
    const body = (await c.req.json()) as Partial<{
      name: string;
      employmentType: string;
      hourlyRateSen: number | null;
      monthlyFixedCostSen: number | null;
      notes: string | null;
    }>;

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return c.json({ success: false, error: "name is required" }, 400);
    }
    if (!isEmploymentType(body.employmentType)) {
      return c.json(
        {
          success: false,
          error: "employmentType must be FULL_TIME or PART_TIME",
        },
        400,
      );
    }

    // FT requires hourlyRateSen > 0; PT requires monthlyFixedCostSen >= 0.
    // Coerce nulls/undefined to 0 for the "off-side" field so the column
    // stays NULL in the DB.
    const hourlyRateSen =
      body.employmentType === "FULL_TIME"
        ? typeof body.hourlyRateSen === "number" && body.hourlyRateSen >= 0
          ? Math.round(body.hourlyRateSen)
          : null
        : null;
    const monthlyFixedCostSen =
      body.employmentType === "PART_TIME"
        ? typeof body.monthlyFixedCostSen === "number" &&
          body.monthlyFixedCostSen >= 0
          ? Math.round(body.monthlyFixedCostSen)
          : null
        : null;

    if (body.employmentType === "FULL_TIME" && hourlyRateSen === null) {
      return c.json(
        {
          success: false,
          error: "hourlyRateSen is required for FULL_TIME members",
        },
        400,
      );
    }
    if (body.employmentType === "PART_TIME" && monthlyFixedCostSen === null) {
      return c.json(
        {
          success: false,
          error: "monthlyFixedCostSen is required for PART_TIME members",
        },
        400,
      );
    }

    const id = genId();
    const nowIso = new Date().toISOString();

    await c.var.DB.prepare(
      `INSERT INTO rd_team_members
         (id, name, employmentType, hourlyRateSen, monthlyFixedCostSen,
          active, notes, orgId, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, true, ?, 'hookka', ?, ?)`,
    )
      .bind(
        id,
        name,
        body.employmentType,
        hourlyRateSen,
        monthlyFixedCostSen,
        typeof body.notes === "string" ? body.notes : null,
        nowIso,
        nowIso,
      )
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM rd_team_members WHERE id = ?",
    )
      .bind(id)
      .first<TeamMemberRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create team member" },
        500,
      );
    }
    return c.json({ success: true, data: rowToMember(created) }, 201);
  } catch (err) {
    console.error("[rd-team-members] POST failed:", err);
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// PUT /api/rd-team-members/:id — update.
// Same body shape as POST; everything optional, partial update.
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM rd_team_members WHERE id = ?",
    )
      .bind(id)
      .first<TeamMemberRow>();
    if (!existing) {
      return c.json({ success: false, error: "Team member not found" }, 404);
    }
    const body = (await c.req.json()) as Partial<{
      name: string;
      employmentType: string;
      hourlyRateSen: number | null;
      monthlyFixedCostSen: number | null;
      active: boolean;
      notes: string | null;
    }>;

    const nextEmploymentType = isEmploymentType(body.employmentType)
      ? body.employmentType
      : existing.employmentType;

    // When employmentType flips, clear the off-side cost field rather than
    // leaving stale data on the row.
    const nextHourlyRateSen =
      nextEmploymentType === "FULL_TIME"
        ? body.hourlyRateSen !== undefined
          ? body.hourlyRateSen === null
            ? null
            : Math.round(body.hourlyRateSen)
          : existing.hourlyRateSen
        : null;
    const nextMonthlyFixedCostSen =
      nextEmploymentType === "PART_TIME"
        ? body.monthlyFixedCostSen !== undefined
          ? body.monthlyFixedCostSen === null
            ? null
            : Math.round(body.monthlyFixedCostSen)
          : existing.monthlyFixedCostSen
        : null;

    const nextName =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : existing.name;
    const nextActive =
      typeof body.active === "boolean" ? body.active : existing.active;
    const nextNotes =
      body.notes !== undefined ? body.notes : (existing.notes ?? null);

    await c.var.DB.prepare(
      `UPDATE rd_team_members
          SET name = ?,
              employmentType = ?,
              hourlyRateSen = ?,
              monthlyFixedCostSen = ?,
              active = ?,
              notes = ?,
              updatedAt = ?
        WHERE id = ?`,
    )
      .bind(
        nextName,
        nextEmploymentType,
        nextHourlyRateSen,
        nextMonthlyFixedCostSen,
        nextActive,
        nextNotes,
        new Date().toISOString(),
        id,
      )
      .run();

    const updated = await c.var.DB.prepare(
      "SELECT * FROM rd_team_members WHERE id = ?",
    )
      .bind(id)
      .first<TeamMemberRow>();
    if (!updated) {
      return c.json({ success: false, error: "Team member not found" }, 404);
    }
    return c.json({ success: true, data: rowToMember(updated) });
  } catch (err) {
    console.error("[rd-team-members] PUT failed:", err);
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/rd-team-members/:id — soft delete (active = false).
// Hard delete would orphan rd_labour_hours rows (FK on team_member_id without
// ON DELETE CASCADE — by design, so historical hours stay attributable).
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "rd-projects", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM rd_team_members WHERE id = ?",
  )
    .bind(id)
    .first<TeamMemberRow>();
  if (!existing) {
    return c.json({ success: false, error: "Team member not found" }, 404);
  }

  await c.var.DB.prepare(
    "UPDATE rd_team_members SET active = false, updatedAt = ? WHERE id = ?",
  )
    .bind(new Date().toISOString(), id)
    .run();

  const updated = await c.var.DB.prepare(
    "SELECT * FROM rd_team_members WHERE id = ?",
  )
    .bind(id)
    .first<TeamMemberRow>();
  return c.json({
    success: true,
    data: updated ? rowToMember(updated) : null,
  });
});

export default app;
