# Context Pack: Security, Auth, and RBAC

Use this pack for login/session handling, CSRF, OAuth, TOTP, worker portal access, permissions, tenancy, and audit trails.

## Read first

- `src/lib/api-client.ts`
- `src/api/lib/auth-middleware.ts`
- `src/api/lib/rbac.ts`
- `src/api/lib/tenant.ts`
- `src/api/routes/auth.ts`
- `src/api/routes/auth-oauth.ts`
- `src/api/routes/auth-totp.ts`
- `src/api/routes/users.ts`
- `src/api/routes/worker-auth.ts`
- `src/api/routes/worker.ts`

## Useful searches

```bash
rg -n "hookka_session|hookka_csrf|CSRF|HttpOnly|SameSite" src docs tests
rg -n "requirePermission|hasPermission|role|permission|audit" src/api tests
rg -n "PUBLIC|public|worker-auth|worker token|org_id|tenant" src/api/lib src/api/routes tests
```

## Tests to inspect first

- `tests/security-*.mjs`
- `tests/permissions.test.mjs`
- `tests/tenant-isolation.test.mjs`
- Auth, session, and worker portal tests matching the changed route.
