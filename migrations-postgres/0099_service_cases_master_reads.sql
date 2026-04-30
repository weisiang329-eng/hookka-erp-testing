-- ---------------------------------------------------------------------------
-- 0099_service_cases_master_reads.sql
--
-- Two-in-one fix for the Service Case detail page Forbidden toasts (user
-- dogfood 2026-04-30):
--
-- (A) Re-do 0096_service_orders_permissions.sql with snake_case columns.
--     0096 wrote `INSERT INTO role_permissions (roleId, permissionId)` but
--     the live schema (per 0045_rbac.sql line 45-48) is
--     `(role_id, permission_id)`. In Postgres, unquoted identifiers fold
--     to lowercase, so `roleId` -> `roleid`, which doesn't match the real
--     column. 0096's transaction rolled back -> no service-orders grants
--     were ever inserted -> requirePermission(c, "service-orders", *)
--     denies every caller, including SUPER_ADMIN, on:
--         POST /api/service-cases             (open a case)
--         PUT  /api/service-cases/:id         (auto-save on RCA edit)
--         PUT  /api/service-cases/:id/status  (advance / cancel)
--         DELETE /api/service-cases/:id       (only OPEN deletable)
--         and every spawned-service-order endpoint that gates the same way.
--     The permissions rows themselves never landed either (single-tx
--     rollback), so they're re-inserted below before granting.
--
-- (B) Grant master-data reads to SALES so the Root Cause categories on the
--     Service Case detail page can populate their pickers:
--         PRODUCTION / PROCESS / PICKING -> GET /api/workers           (workers:read)
--         MATERIAL                        -> GET /api/raw-materials    (raw-materials:read)
--         MATERIAL                        -> GET /api/suppliers        (suppliers:read)
--         MATERIAL with RM picked         -> GET /api/supplier-materials (supplier-materials:read)
--         TRANSPORT (3PL company list)    -> GET /api/drivers          (drivers:read)
--         TRANSPORT (vehicle dropdown)    -> GET /api/three-pl-vehicles (lorries:read)
--     products:read is already granted to SALES by 0045_rbac.sql so the
--     DESIGN category does not regress. SUPER_ADMIN and READ_ONLY are
--     already covered by 0045's wildcard inserts so they don't need rows
--     here.
--
-- Idempotency: ON CONFLICT DO NOTHING on the role_permissions composite
-- primary key (role_id, permission_id) and on permissions (resource,
-- action) UNIQUE constraint — safe to re-run.
--
-- KV invalidation: rbac.ts caches per-role permission sets in KV
-- (SESSION_CACHE) under "rbac:perms:<ROLE>" for 5 min. After deploy, hit
-- /api/admin/rbac/invalidate (or wait out the TTL) for the change to take
-- effect for already-warm sessions.
-- ---------------------------------------------------------------------------

-- (A1) Re-insert the service-orders permission rows in case 0096's
--      whole transaction rolled back (camelCase failure on the INSERT
--      below). Safe to re-run via ON CONFLICT.
INSERT INTO permissions (id, resource, action, description) VALUES
  ('perm_service_orders_read',   'service-orders', 'read',   'View service cases and service orders'),
  ('perm_service_orders_create', 'service-orders', 'create', 'Open service cases / spawn service orders'),
  ('perm_service_orders_update', 'service-orders', 'update', 'Edit service cases / advance status'),
  ('perm_service_orders_delete', 'service-orders', 'delete', 'Hard-delete OPEN service cases')
ON CONFLICT DO NOTHING;

-- (A2) SUPER_ADMIN: full access to service-orders / service-cases.
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_super_admin', id FROM permissions WHERE resource = 'service-orders'
ON CONFLICT DO NOTHING;

-- (A3) READ_ONLY: view only.
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_read_only', id FROM permissions
 WHERE resource = 'service-orders' AND action = 'read'
ON CONFLICT DO NOTHING;

-- (A4) SALES: front-line for customer issues. Read + create + update; no
--      delete (cancel-via-status is the soft-cancel path).
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_sales', id FROM permissions
 WHERE resource = 'service-orders' AND action IN ('read', 'create', 'update')
ON CONFLICT DO NOTHING;

-- (B) SALES: read access to the master tables surfaced by Root Cause
--     categories in src/pages/service-cases/detail.tsx CategoryDetailsForm.
--     Mutations stay locked - SALES still cannot create/update/delete a
--     worker, RM, supplier, supplier-material binding, driver/3PL
--     provider, or 3PL vehicle from this page or anywhere else.
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'role_sales', id FROM permissions
 WHERE action = 'read'
   AND resource IN (
     'workers',
     'raw-materials',
     'suppliers',
     'supplier-materials',
     'drivers',
     'lorries'
   )
ON CONFLICT DO NOTHING;
