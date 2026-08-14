// ---------------------------------------------------------------------------
// ensure-user-active-org.ts — BUG-2026-08-13-097.
//
// `users.active_org_id` holds WHICH COMPANY THIS USER last picked in the
// sidebar switcher. It replaces the singleton `inter_company_config.active_org_id`
// (id = 1), which made "the active company" a piece of GLOBAL mutable state:
// one operator switching to HOUZS flipped the switcher label for every other
// signed-in user, in every tenant, at once.
//
// Migrations are INERT on deploy in this repo (CLAUDE.md) — the canonical DDL
// lives in migrations-postgres/0226_user_active_org.sql, but the column reaches
// PRODUCTION only through this awaited runtime self-apply. It is awaited at the
// top of the switcher's write path (PUT /api/organisations with { orgId }),
// before the first UPDATE, exactly like ensureOrganisationRegistry.
//
// Deliberately NULLABLE with no default. NULL is a meaningful value here: it
// means "this user has never picked one", and the reader falls back to the old
// global row so that nobody's switcher visibly changes on deploy. A
// `DEFAULT 'hookka'` (the pattern used by the org_id rollout) would be wrong —
// it would stamp every user with an org id that is not even in the same
// namespace as `organisations.id` ('org-hookka', not 'hookka').
//
// The READ side does NOT call this. `GET /api/organisations` runs on every page
// load and must not pay for a DDL round-trip; it selects the column inside a
// catch that degrades to the legacy global value, which is the correct
// behaviour on an environment where this has not run yet.
//
// Memoised per isolate, and a FAILED round drops the memo so the next request
// retries — see self-apply.ts for why that mattered enough to be a module.
// ---------------------------------------------------------------------------
import { memoizeSelfApply, runSelfApply } from "./self-apply";

const USER_ACTIVE_ORG_STATEMENTS: readonly string[] = [
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS active_org_id text",
];

let userActiveOrgPromise: Promise<void> | null = null;

type Runner = { prepare(sql: string): unknown };

export function ensureUserActiveOrgColumn(db: Runner): Promise<void> {
  return memoizeSelfApply(
    () => userActiveOrgPromise,
    (p) => {
      userActiveOrgPromise = p;
    },
    () =>
      runSelfApply(
        db as Parameters<typeof runSelfApply>[0],
        "user-active-org",
        [...USER_ACTIVE_ORG_STATEMENTS],
      ),
  );
}

/**
 * Test/isolate hook — forget the memo so a fresh DB stub re-runs the DDL.
 * Production never calls this; `memoizeSelfApply` already clears the memo on
 * failure, which is the only case that matters at runtime.
 */
export function __resetUserActiveOrgMemo(): void {
  userActiveOrgPromise = null;
}
