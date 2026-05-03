-- ---------------------------------------------------------------------------
-- 0070_sofa_combo_rbac.sql
--
-- Backfill: the sofa-combos resource was missing from migrations/0045_rbac.sql
-- when the route + UI shipped (Phase 5). Backend `requirePermission(c,
-- "sofa-combos", *)` therefore returned 403 Forbidden for every non-legacy
-- user — including super-admins, because the cached permission set in KV was
-- built from the existing role_permissions rows which had no sofa-combos
-- grants.
--
-- This migration:
--   1. Inserts the four resource:action permission rows
--   2. Grants all four to super_admin (idempotent re-run of the wildcard
--      INSERT in 0045's matrix section)
--   3. Grants all four to role_sales — they're the operator role that
--      manages per-customer combo deals
--
-- After applying, the per-role KV cache (SESSION_CACHE: rbac:perms:<ROLE>)
-- needs to expire (5-minute TTL) before the new grants take effect for an
-- already-logged-in session — or the user can sign out + back in to force a
-- refresh.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO permissions (id, resource, action, description) VALUES
  ('perm_sofa_combos_read',   'sofa-combos', 'read',   'View sofa combo rules'),
  ('perm_sofa_combos_create', 'sofa-combos', 'create', 'Create sofa combo rules'),
  ('perm_sofa_combos_update', 'sofa-combos', 'update', 'Edit sofa combo rules'),
  ('perm_sofa_combos_delete', 'sofa-combos', 'delete', 'Delete sofa combo rules');

-- Super-admin: re-grant every permission (idempotent — picks up any
-- newly-added rows including the four above).
INSERT OR IGNORE INTO role_permissions (roleId, permissionId)
SELECT 'role_super_admin', id FROM permissions;

-- Sales: full access on sofa-combos.
INSERT OR IGNORE INTO role_permissions (roleId, permissionId)
SELECT 'role_sales', id FROM permissions WHERE resource = 'sofa-combos';

-- Read-only: read access on sofa-combos for visibility.
INSERT OR IGNORE INTO role_permissions (roleId, permissionId)
SELECT 'role_read_only', id FROM permissions
WHERE resource = 'sofa-combos' AND action = 'read';
