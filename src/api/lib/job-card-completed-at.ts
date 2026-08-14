import { runSelfApply } from "./self-apply";

// ---------------------------------------------------------------------------
// job-card-completed-at.ts — capture the INSTANT a job card was completed.
//
// The problem this exists to fix
// ------------------------------
// The factory could not measure how long any job actually takes, and not
// because nobody recorded it — because the system threw the time away at the
// moment of capture. Every completion write path had the full ISO timestamp in
// scope and stored `nowIso.split("T")[0]` / `.slice(0, 10)` into
// `job_cards.completed_date`. Measured on prod 2026-08-14:
//
//   · job_cards.distributed_at  = "2026-08-13T01:03:11.395Z"  (full instant)
//   · job_cards.completed_date  = "2026-08-14"                (date only)
//
// so elapsed time per card is not derivable, and every "production time"
// column is the ESTIMATE standing in for a measurement:
// `production_time_minutes = est_minutes` on all 36,796 rows (0 differ), and
// `actual_minutes = est_minutes` on 100% of the rows that have a value.
//
// What this module adds
// ---------------------
// `job_cards.completed_at` — nullable, snake_case, indexed — ALONGSIDE
// `completed_date`. `completed_date` is untouched: its date-only semantics and
// shape are load-bearing for a great deal of code (the efficiency scan, the
// dept sheets, `substr(completedDate::text,1,10)` comparisons all over
// agent-learning, the job-card list filters, the archive union). This column is
// purely additive.
//
// The rule: completed_at is a MEASUREMENT, never a derivation
// ----------------------------------------------------------
// It is written with the FULL `nowIso` ONLY where the code is observing the
// completion happen — the three shop-floor scan endpoints and the office
// PATCH's auto-stamp. It is NOT written by:
//
//   · an operator typing / editing a completion date (that is an ASSERTION
//     about a day, not an observation of an instant);
//   · the Google-Sheets inbound sync (a date somebody keyed into a sheet);
//   · any import / backfill endpoint (a historical date from a spreadsheet).
//
// Historical rows stay NULL. Inventing an instant for them would be exactly the
// C15 class this repo keeps producing — a figure that reads as measured and is
// not. A NULL is readable as "not measured"; a fabricated 09:00 is not.
//
// Type note (deliberate): TEXT, not TIMESTAMPTZ. The value this column exists
// to be subtracted FROM is `job_cards.distributed_at`, which is TEXT holding an
// ISO-8601 instant. Storing both as the same shape keeps the duration maths a
// plain `Date.parse(a) - Date.parse(b)` on two identical formats, and keeps
// `SELECT *` rows uniformly `string | null` (postgres.js hands back a `Date`
// object for a timestamptz, which would make `JobCardRow.completedAt` lie).
// ---------------------------------------------------------------------------

/** DDL — idempotent, and the ONLY way this column reaches prod. */
export const JOB_CARD_COMPLETED_AT_STATEMENTS: readonly string[] = [
  "ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS completed_at TEXT",
  "CREATE INDEX IF NOT EXISTS idx_job_cards_completed_at ON job_cards(completed_at)",
];

type Runner = { prepare(sql: string): unknown };

let completedAtMigration: Promise<void> | null = null;

/**
 * Self-apply `job_cards.completed_at`.
 *
 * Migrations are INERT on deploy in this repo (CLAUDE.md): the migration file
 * `migrations-postgres/0227_job_cards_completed_at.sql` is the record, this is
 * the mechanism. Await it at the TOP of every handler that writes the column,
 * before the first statement that mentions it.
 *
 * Memoised per isolate, and the memo is DROPPED on failure (C9) so one
 * transient DDL blip does not leave the column unapplied for the life of the
 * isolate.
 */
export function ensureJobCardCompletedAt(db: Runner): Promise<void> {
  if (completedAtMigration) return completedAtMigration;
  completedAtMigration = (async () => {
    await runSelfApply(
      db as Parameters<typeof runSelfApply>[0],
      "job-card-completed-at",
      [...JOB_CARD_COMPLETED_AT_STATEMENTS],
    );
  })().catch((err) => {
    completedAtMigration = null;
    throw err;
  });
  return completedAtMigration;
}

/** Test-only: forget the memo so a fresh round can be asserted. */
export function __resetJobCardCompletedAtMemo(): void {
  completedAtMigration = null;
}

/** Read the stored instant off a `SELECT *` row, whichever spelling won. */
export function readCompletedAt(
  row: { completedAt?: string | null; completed_at?: string | null } | null | undefined,
): string | null {
  if (!row) return null;
  const v = row.completedAt ?? row.completed_at ?? null;
  return v ? String(v) : null;
}

/**
 * The instant to store when the card is being observed to complete RIGHT NOW.
 * Deliberately the whole `nowIso` — the truncation is the bug.
 */
export function observedCompletionAt(nowIso: string): string {
  return nowIso;
}

/**
 * Carry a previously OBSERVED instant forward, or drop it.
 *
 * Used by every write path that sets `completed_date` from something other than
 * an observation (an operator edit, a sheet, a date-fix backfill). It never
 * invents an instant; it only decides whether the one already on the row still
 * describes the date being written.
 *
 *   · no completion date          → no instant (a cleared card has no moment)
 *   · nothing was ever observed   → stays NULL (never derive one from the date)
 *   · the date still matches      → keep the observation
 *   · the date was reassigned     → drop it; that instant describes a different
 *                                   day, and a timestamp contradicting its own
 *                                   date column is worse than no timestamp
 *
 * Both sides are compared on their leading `YYYY-MM-DD`, which is how the rest
 * of this codebase compares a completion date (`substr(completedDate,1,10)`).
 */
export function reconcileCompletedAt(
  completedDate: string | null | undefined,
  priorCompletedAt: string | null | undefined,
): string | null {
  if (!completedDate) return null;
  if (!priorCompletedAt) return null;
  const dayOfDate = String(completedDate).slice(0, 10);
  const dayOfInstant = String(priorCompletedAt).slice(0, 10);
  return dayOfDate === dayOfInstant ? String(priorCompletedAt) : null;
}
