# Context Pack: Security, Auth, and RBAC

> **Last verified: 2026-08-13** against `src/api/lib/auth-middleware.ts` (`PUBLIC_PATHS`/`PUBLIC_PREFIXES` + 4 regex-opened paths), `rbac.ts`, `tenant.ts`, `routes/auth.ts`, `auth-oauth.ts`, `auth-totp.ts`, `users.ts` (`requireSuperAdmin`, 9 call sites), `worker-auth.ts`, `worker.ts`, and the named tests (`security-permission-matrix`, `security-public-endpoints`, `security-route-coverage`, `permissions`, `tenant-isolation`). All present.

Use this pack for login/session handling, CSRF, OAuth, TOTP, worker portal access, permissions, tenancy, and audit trails.

> Security / auth / RBAC / tenancy is **always deep review** — never fast-lane it (`docs/DEV-OPERATING-FRAMEWORK.md`). Note the SUPER_ADMIN tier gate (`requireSuperAdmin`) on user-account mutations in `users.ts`.

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
