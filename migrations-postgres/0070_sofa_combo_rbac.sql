-- ---------------------------------------------------------------------------
-- 0070_sofa_combo_rbac.sql (Postgres)
--
-- Backfill: the sofa-combos resource was missing from 0045_rbac.sql when
-- the route + UI shipped. Backend `requirePermission(c, "sofa-combos", *)`
-- therefore returned 403 Forbidden for every non-legacy user — including
-- super-admins, because the cached permission set in KV was built from the
-- existing role_permissions rows which had no sofa-combos grants.
--
-- After applying, the per-role KV cache (SESSION_CACHE: rbac:perms:<ROLE>)
-- needs to expire (5-minute TTL) before the new grants take effect for an
-- already-logged-in session — or the user can sign out + back in to force
-- a refresh.
-- ---------------------------------------------------------------------------

INSERT INTO permissions (id, resource, action, description) VALUES
  ('perm_sofa_combos_read',   'sofa-combos', 'read',   'View sofa combo rules'),
  ('perm_sofa_combos_create', 'sofa-combos', 'create', 'Create sofa combo rules'),
  ('perm_sofa_combos_update', 'sofa-combos', 'update', 'Edit sofa combo rules'),
  ('perm_sofa_combos_delete', 'sofa-combos', 'delete', 'Delete sofa combo rules')
ON CONFLICT DO NOTHING;

-- Super-admin: re-grant every permission (idempotent — picks up any
-- newly-added rows including the four above).
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_super_admin', id FROM permissions
ON CONFLICT DO NOTHING;

-- Sales: full access on sofa-combos.
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_sales', id FROM permissions WHERE resource = 'sofa-combos'
ON CONFLICT DO NOTHING;

-- Read-only: read access on sofa-combos for visibility.
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_read_only', id FROM permissions
WHERE resource = 'sofa-combos' AND action = 'read'
ON CONFLICT DO NOTHING;
