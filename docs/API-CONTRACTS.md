# API contract inventory

The generated inventory at `docs/generated/api-contract-inventory.json` is the
machine-readable map of Hookka's Hono API surface. Run:

```bash
npm run api:contracts:write  # refresh after intentionally changing routes
npm run api:contracts:check  # CI drift check
```

The generator uses the TypeScript AST, resolves route-module mounts from
`src/api/worker.ts`, and records method, full path, auth surface and review
signals for body parsing, structured/manual validation, RBAC, tenant scope,
idempotency and transaction/batch usage. Signals identify review targets; they
are not proof that a route is safe or unsafe.

## Baseline (2026-07-20)

- 126 API source files scanned;
- 880 endpoint declarations;
- 531 mutation declarations (`POST`, `PUT`, `PATCH`, `DELETE`);
- 322 mutations read a JSON body;
- 0 JSON mutations use a detected structured schema validator;
- 39 mutations are mounted pre-auth or under an explicit auth bypass/self-auth
  surface;
- 7 mutations carry the shared HTTP idempotency wrapper.

The existing system primarily uses hand-written `if` validation. That has
worked, but it makes coercion, unknown fields and nested array rules easy to
drift between FE and BE. Structured validation should be introduced first on
customer payments, supplier payments, invoices, journals, stock adjustments
and payroll finalisation. It should not be mass-applied to all 322 handlers in
one release.

## Review order

1. Money creates: body schema, positive integer-sen rules, tenant-scoped reads
   and writes, request fingerprint/idempotency, and domain DB constraints.
2. Inventory/payroll mutations: body schema, period/stock locks, tenant scope
   and atomic batch/transaction behavior.
3. The 39 auth-bypass/self-auth mutations: verify token/secret ownership and
   rate limits explicitly. They are not assumed unsafe merely because they do
   not use dashboard RBAC.
4. Remaining CRUD: add schemas when the route is touched, with regression tests
   for legacy clients before changing coercion behavior.

## Naming policy

- route and page modules: `kebab-case.ts` / `kebab-case.tsx`;
- exported React components and component files: `PascalCase.tsx` when the file
  represents one component;
- hooks: `use-kebab-case.ts` and `useXxx` export;
- DB migration: zero-padded numeric prefix plus snake-case description;
- public API paths and JSON fields are contracts and are never renamed solely
  for style.

Existing names are migrated only when that module is already being changed and
the rename can be verified on Windows and Linux. A repository-wide rename would
create high import churn, case-only Git problems and no runtime benefit.
