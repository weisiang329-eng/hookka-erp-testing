-- ============================================================================
-- Migration 0098 — R&D Maintenance: team members + labour hours + manual cost
--
-- Adds a small "Maintenance" surface for R&D-only people (separate from the
-- existing employees / workers tables which model production-floor staff
-- with payroll calc rules). For R&D the user wants something simpler:
--
--   * Full-time members: track an hourly rate. When labour hours are logged
--     against an R&D project, multiply hours * hourlyRateSen to derive the
--     project's labour cost.
--   * Part-time members: a flat monthly fixed cost that is NOT allocated
--     per hour against a project's labour cost (the user's intent: PT folks
--     are an overhead line, not a per-prototype cost). We still record
--     their hours so we can see how long things take in practice.
--
-- Cost semantics (mirrored in src/api/routes/rd-projects.ts):
--   - If rd_projects.manual_labour_cost_sen IS NOT NULL → that wins (the
--     user typed a number into the override box).
--   - Else: laborCostSen = SUM(hours * hourlyRateSen) over FT members'
--     rd_labour_hours rows for the project.
--   - partTimeFixedCostSen is a separate flat sum of PT members who logged
--     hours on this project (one charge per distinct member), shown beside
--     the auto-computed labour cost as a separate overhead line.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rd_team_members (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  employment_type          TEXT NOT NULL CHECK (employment_type IN ('FULL_TIME','PART_TIME')),
  -- FT: wage per hour in sen. Nullable because PT members don't use it.
  hourly_rate_sen          INTEGER,
  -- PT: flat fixed cost (typically monthly retainer) in sen. Nullable
  -- because FT members don't use it.
  monthly_fixed_cost_sen   INTEGER,
  active                   BOOLEAN NOT NULL DEFAULT true,
  notes                    TEXT,
  org_id                   TEXT NOT NULL DEFAULT 'hookka',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rd_team_members_org_active
  ON rd_team_members(org_id, active);

CREATE TABLE IF NOT EXISTS rd_labour_hours (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES rd_projects(id) ON DELETE CASCADE,
  team_member_id    TEXT NOT NULL REFERENCES rd_team_members(id),
  work_date         DATE NOT NULL,
  hours             NUMERIC(6,2) NOT NULL CHECK (hours > 0),
  notes             TEXT,
  org_id            TEXT NOT NULL DEFAULT 'hookka',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rd_labour_hours_project_date
  ON rd_labour_hours(project_id, work_date);
CREATE INDEX IF NOT EXISTS idx_rd_labour_hours_member_date
  ON rd_labour_hours(team_member_id, work_date);

-- Manual override on the project itself. NULL = use the auto-computed value
-- from rd_labour_hours; a number (in sen) = user typed an explicit cost.
ALTER TABLE rd_projects
  ADD COLUMN IF NOT EXISTS manual_labour_cost_sen INTEGER;
