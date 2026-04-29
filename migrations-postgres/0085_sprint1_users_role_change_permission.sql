-- ---------------------------------------------------------------------------
-- 0077_users_role_change_permission.sql
--
-- Sprint 1 (pre-launch hardening): split `users:update` into two permissions
-- so a generic ops user with `users:update` (display name, email, isActive
-- toggle) can NOT promote themselves or others to SUPER_ADMIN by setting
-- `role` in the PUT body.
--
-- New permission: users:role-change. Seeded only on the SUPER_ADMIN role
-- (and any future "RBAC_ADMIN" we may carve out).
--
-- Code-side gate added at src/api/routes/users.ts PUT /:id — when the body
-- changes the role, the handler additionally requires `users:role-change`.
-- For the existing single-tenant rollout this is functionally a no-op
-- (today only SUPER_ADMIN had `users:update` per practical usage) but the
-- separate permission closes the future-tenant footgun where an ops role
-- might be granted `users:update` for routine cleanup.
-- ---------------------------------------------------------------------------

INSERT INTO permissions (id, resource, action, description) VALUES
  ('perm_users_role_change', 'users', 'role-change', 'Change a user role')
ON CONFLICT DO NOTHING;

-- Grant to SUPER_ADMIN only.
INSERT INTO role_permissions (roleId, permissionId)
SELECT 'role_super_admin', id FROM permissions
 WHERE resource = 'users' AND action = 'role-change'
ON CONFLICT DO NOTHING;
