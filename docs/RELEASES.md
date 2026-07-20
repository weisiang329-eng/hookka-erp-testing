# Hookka ERP release policy

Hookka uses SemVer for functional releases and a commit SHA for every deployed
artifact. The current functional baseline is `v0.1.0`; the project remains
pre-1.0 while the FE/BE/DB contract and staging gates are being hardened.

## Release identity

Every build exposes the same metadata in three places:

- `/version.json` — static frontend build identity;
- `/api/health` — backend build identity;
- `/api/pg-ping` — backend identity plus expected and applied DB schema.

Examples:

- staging: `0.1.0-staging+abcdef123456`;
- production: `0.1.0+abcdef123456`;
- schema: the highest numbered file in `migrations-postgres/` (for example
  `0207`).

The identity is deterministic. Rebuilding the same commit for the same channel
does not invent a new version. This also namespaces browser caches without the
old `Date.now()` ambiguity.

## Version bump rules

- patch (`0.1.0` → `0.1.1`): compatible bug, security or performance fix;
- minor (`0.1.x` → `0.2.0`): new module or materially changed workflow;
- major (`0.x` → `1.0.0`): the production contract and migration discipline
  are declared stable.

Update both `package.json` and `package-lock.json` in the staging release PR.
One production version may identify only one commit. After a verified main
deployment, CI creates the annotated tag `erp-v<version>`.

## Promotion flow

1. Merge feature/fix PRs into `staging`.
2. Apply pending Postgres migrations to the staging DB only.
3. Verify the deployed staging UI and critical workflows.
4. Open a PR from the exact `staging` head into `main`.
5. The production release gate verifies:
   - main is an ancestor of staging (no reverse-only production changes);
   - the version has not already been released;
   - `/version.json` and `/api/pg-ping` report the exact staging SHA;
   - FE, BE, source schema and applied staging schema agree.
6. Merge only after the gate and manual acceptance pass. Production deploys
   that exact main commit; a successful deploy receives the release tag.

Production data is never copied back from staging. The scheduled DB refresh is
one-way: production → staging, followed by credential revocation and `ANALYZE`.
