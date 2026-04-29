-- ---------------------------------------------------------------------------
-- 0096_service_orders_permissions.sql
--
-- Seed RBAC permissions for the service-orders / service-cases module.
--
-- Why this exists: the original 0045_rbac.sql seeded every (resource, action)
-- pair that existed at the time, then granted SUPER_ADMIN every row in the
-- permissions table. service-orders + service-cases were added later
-- (migrations 0069 / 0074) but no follow-up migration ever added the
-- corresponding permission rows. As a result requirePermission(c,
-- "service-orders", *) checks were silently denying EVERY caller — including
-- SUPER_ADMIN — because the resource simply isn't in role_permissions.
--
-- Surfaced by user dogfood 2026-04-29: "Forbidden" toast on POST /api/
-- service-cases (case creation) and PUT /api/service-cases/:id (affected
-- products edit, RCA edit). Both routes gate on resource="service-orders".
--
-- Grants:
--   SUPER_ADMIN: read / create / update / delete (full)
--   READ_ONLY:   read (matches 0045's "all reads" rule)
--   SALES:       read / create / update — they're the front line for
--                customer issues. Delete stays locked to SUPER_ADMIN since
--                cancel-via-status (PUT /:id/status with CANCELLED) is the
--                preferred soft-cancel path.
--
-- KV invalidation: callers may keep seeing 403 for up to 5 min after this
-- lands because rbac.ts caches the per-role permission set in KV
-- (SESSION_CACHE) under "rbac:perms:<ROLE>". After deploy, hit
-- /api/admin/rbac/invalidate (or wait out the TTL) to see the change.
-- ---------------------------------------------------------------------------

INSERT INTO permissions (id, resource, action, description) VALUES
  ('perm_service_orders_read',   'service-orders', 'read',   'View service cases and service orders'),
  ('perm_service_orders_create', 'service-orders', 'create', 'Open service cases / spawn service orders'),
  ('perm_service_orders_update', 'service-orders', 'update', 'Edit service cases / advance status'),
  ('perm_service_orders_delete', 'service-orders', 'delete', 'Hard-delete OPEN service cases')
ON CONFLICT DO NOTHING;

-- SUPER_ADMIN: full access.
INSERT INTO role_permissions (roleId, permissionId)
SELECT 'role_super_admin', id FROM permissions WHERE resource = 'service-orders'
ON CONFLICT DO NOTHING;

-- READ_ONLY: view only.
INSERT INTO role_permissions (roleId, permissionId)
SELECT 'role_read_only', id FROM permissions
 WHERE resource = 'service-orders' AND action = 'read'
ON CONFLICT DO NOTHING;

-- SALES: handle the customer-facing case workflow (open, edit, advance) but
-- not delete.
INSERT INTO role_permissions (roleId, permissionId)
SELECT 'role_sales', id FROM permissions
 WHERE resource = 'service-orders' AND action IN ('read', 'create', 'update')
ON CONFLICT DO NOTHING;
