// ---------------------------------------------------------------------------
// job-card-completed-at.test.mjs — BUG-2026-08-13-120.
//
// The factory could not measure how long any job takes, and not because nobody
// records it — because the system threw the time away at the moment of capture.
// Every completion write path had the full ISO timestamp in scope and stored
// `nowIso.split("T")[0]` into `job_cards.completed_date`.
//
// Measured on prod 2026-08-14:
//   · job_cards.distributed_at      = "2026-08-13T01:03:11.395Z"  (full instant)
//   · job_cards.completed_date      = "2026-08-14"                (date only)
//   · production_time_minutes = est_minutes on all 36,796 rows (0 differ)
//   · actual_minutes          = est_minutes on 100% of rows with a value
//
// This file guards the capture, and nothing beyond it. It deliberately asserts
// NOTHING about any efficiency figure — making those honest is a separate
// change; this one only starts recording the truth so a real measurement
// becomes possible later.
//
// Four things are pinned:
//
//   1. THE DECISION IS PURE AND CANNOT INVENT. `reconcileCompletedAt` may only
//      ever return the instant it was handed, or null. Property-tested over the
//      whole input cross-product, because "never fabricates" is the one
//      guarantee a single hand-picked case cannot establish.
//   2. completed_at TRAVELS WITH completed_date. Every SQL statement in
//      src/api that writes the DATE must write the INSTANT in the SAME
//      statement — otherwise the pair can disagree and a stale instant survives
//      a card being re-dated, un-completed or blocked. This is the class guard:
//      a new completion writer fails here until it is wired.
//   3. THE OBSERVATION SITES KEEP THE WHOLE TIMESTAMP. The four places that
//      record a completion AS IT HAPPENS must bind `nowIso`, not `today` — the
//      truncation is the entire bug, and it is one character away from coming
//      back.
//   4. completed_date IS UNTOUCHED. It is still stamped from the date-only
//      `today` at every one of those sites, and no statement writes a full ISO
//      instant into it. A great deal of code depends on its shape.
//
// Plus: the migration performs NO backfill. The time is already gone for
// existing rows and inventing one would be C15 (a figure that reads as measured
// and is not). Historical completed_at stays NULL, visibly.
//
// EOL note: these are CRLF files. Every read below normalises to "\n" first —
// a literal "\n" anchor against the raw bytes silently matches nothing, which
// has produced false all-clears in this repo before.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const {
  reconcileCompletedAt,
  readCompletedAt,
  observedCompletionAt,
  JOB_CARD_COMPLETED_AT_STATEMENTS,
} = await import("../src/api/lib/job-card-completed-at.ts");

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const HELPERS = "src/api/routes/production-orders/_helpers.ts";
const ROUTES = "src/api/routes/production-orders.ts";
const MIGRATION = "migrations-postgres/0228_job_cards_completed_at.sql";

// ---------------------------------------------------------------------------
// 1. The decision function cannot invent an instant.
// ---------------------------------------------------------------------------

test("reconcileCompletedAt keeps an observation only while it still describes the date", () => {
  const instant = "2026-08-14T09:31:07.412Z";

  // Same day → the observation survives, byte-identical.
  assert.equal(reconcileCompletedAt("2026-08-14", instant), instant);

  // Re-dated to another day → dropped. An instant that contradicts its own
  // date column is worse than no instant.
  assert.equal(reconcileCompletedAt("2026-08-11", instant), null);

  // Completion cleared → nothing to describe.
  assert.equal(reconcileCompletedAt(null, instant), null);
  assert.equal(reconcileCompletedAt("", instant), null);

  // Never observed → stays NULL. This is the no-fabrication rule: a date alone
  // must never be promoted into a timestamp.
  assert.equal(reconcileCompletedAt("2026-08-14", null), null);
  assert.equal(reconcileCompletedAt("2026-08-14", undefined), null);

  // A stored value that is itself a full instant on the same day still matches
  // a date-only column, because both are compared on their leading YYYY-MM-DD.
  assert.equal(
    reconcileCompletedAt("2026-08-14T00:00:00.000Z", instant),
    instant,
  );
});

test("reconcileCompletedAt returns the input instant or null — never anything else", () => {
  const dates = [
    null,
    undefined,
    "",
    "2026-08-14",
    "2026-08-13",
    "2026-08-14T23:59:59.999Z",
    "1970-01-01",
  ];
  const instants = [
    null,
    undefined,
    "",
    "2026-08-14T09:31:07.412Z",
    "2026-08-13T00:00:00.000Z",
    "2026-08-14",
  ];
  for (const d of dates) {
    for (const i of instants) {
      const out = reconcileCompletedAt(d, i);
      const acceptable = out === null || out === String(i);
      assert.ok(
        acceptable,
        `reconcileCompletedAt(${JSON.stringify(d)}, ${JSON.stringify(i)}) ` +
          `returned ${JSON.stringify(out)} — it must be the supplied instant ` +
          `or null, never a value derived from the date`,
      );
    }
  }
});

test("readCompletedAt survives either spelling, and an absent column", () => {
  assert.equal(readCompletedAt({ completedAt: "2026-08-14T01:00:00.000Z" }), "2026-08-14T01:00:00.000Z");
  assert.equal(readCompletedAt({ completed_at: "2026-08-14T02:00:00.000Z" }), "2026-08-14T02:00:00.000Z");
  // A `SELECT *` taken before the ALTER lands has neither key.
  assert.equal(readCompletedAt({}), null);
  assert.equal(readCompletedAt(null), null);
  assert.equal(readCompletedAt(undefined), null);
});

test("observedCompletionAt keeps the whole instant", () => {
  const nowIso = "2026-08-14T09:31:07.412Z";
  const out = observedCompletionAt(nowIso);
  assert.equal(out, nowIso);
  assert.ok(out.includes("T"), "the time component is the whole point");
  assert.ok(out.length > 10, "10 characters would be the date-only truncation");
});

// ---------------------------------------------------------------------------
// 2. Class guard — completed_at travels with completed_date.
// ---------------------------------------------------------------------------

/** Every .ts file under src/api. */
function walkTs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Pull out every SQL string literal that mentions `UPDATE job_cards`.
 *
 * Walks back from the match to the opening quote and forward to its partner,
 * rather than regexing whole literals — the SET clauses here span many lines
 * and a lazy literal pattern is exactly the kind of anchor that matches nothing
 * and reports "clean".
 */
function jobCardUpdateStatements(raw) {
  // Blank out comment-ONLY lines first. Prose describing a statement
  // ("5. dryRun=false → UPDATE job_cards SET completedDate = proposed") is not
  // a statement, and an apostrophe in that prose is what the backward walk
  // would otherwise mistake for an opening quote. Whole lines only: the naive
  // block-comment stripper the older guards use ate ~200 lines of a page once,
  // and `--` (SQL's own comment) never opens a line in these literals.
  const src = raw
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n");
  const found = [];
  const re = /UPDATE\s+job_cards\b/gi;
  let m;
  while ((m = re.exec(src))) {
    let start = m.index;
    while (start > 0 && src[start] !== "`" && src[start] !== '"' && src[start] !== "'") {
      start--;
    }
    const quote = src[start];
    if (quote !== "`" && quote !== '"' && quote !== "'") continue;
    const end = src.indexOf(quote, m.index);
    if (end === -1) continue;
    const sql = src.slice(start + 1, end);
    // A real UPDATE has a SET clause; anything else is prose that survived.
    if (!/\bSET\b/i.test(sql)) continue;
    found.push(sql);
  }
  return found;
}

const API_FILES = walkTs(join(ROOT, "src", "api"));

const WRITES_DATE = /\bcompleted_?[Dd]ate\s*=/;
const WRITES_INSTANT = /\bcompleted_?[Aa]t\s*=/;

test("every job_cards statement that writes completedDate also writes completedAt", () => {
  const offenders = [];
  let checked = 0;
  for (const file of API_FILES) {
    const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    for (const sql of jobCardUpdateStatements(src)) {
      if (!WRITES_DATE.test(sql)) continue;
      checked++;
      if (!WRITES_INSTANT.test(sql)) {
        offenders.push(
          `${file.slice(ROOT.length + 1)}\n    ${sql.replace(/\s+/g, " ").slice(0, 160)}`,
        );
      }
    }
  }
  // The guard must be looking at something. If a refactor moves these
  // statements out of inline SQL the count collapses and this fails loudly
  // instead of passing over an empty set.
  assert.ok(
    checked >= 15,
    `expected the sweep to find at least 15 job_cards completion writes, saw ${checked} — ` +
      `the extractor has stopped matching, which would make this whole guard vacuous`,
  );
  assert.deepEqual(
    offenders,
    [],
    "these statements write job_cards.completedDate without writing completedAt in the " +
      "same statement, so the pair can drift:\n  " + offenders.join("\n  "),
  );
});

test("every file that writes completed_at awaits the self-apply before doing so", () => {
  const offenders = [];
  for (const file of API_FILES) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
    if (rel === "src/api/lib/job-card-completed-at.ts") continue;
    const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const statements = jobCardUpdateStatements(src);
    if (!statements.some((sql) => WRITES_INSTANT.test(sql))) continue;

    const awaitAt = src.indexOf("await ensureJobCardCompletedAt(");
    if (awaitAt === -1) {
      offenders.push(`${rel}: writes completed_at but never awaits ensureJobCardCompletedAt`);
      continue;
    }
    // Migrations are INERT on deploy here (CLAUDE.md) — the column exists only
    // because the self-apply ran, and it has to run BEFORE the first statement
    // that names the column, not somewhere after it.
    const firstWrite = src.search(/UPDATE\s+job_cards/i);
    if (awaitAt > firstWrite) {
      offenders.push(
        `${rel}: ensureJobCardCompletedAt is awaited at ${awaitAt}, after the first ` +
          `job_cards write at ${firstWrite}`,
      );
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n  "));
});

test("the self-apply DDL is idempotent, additive, and indexes the column", () => {
  const stmts = JOB_CARD_COMPLETED_AT_STATEMENTS.join("\n");
  assert.match(stmts, /ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS completed_at/i);
  assert.match(stmts, /CREATE INDEX IF NOT EXISTS \S+ ON job_cards\(completed_at\)/i);
  // completed_date must not be touched by the migration in any way.
  assert.ok(
    !/completed_date/i.test(stmts),
    "the self-apply must never alter, drop or rewrite completed_date",
  );
});

// ---------------------------------------------------------------------------
// 3. The observation sites keep the whole timestamp.
// ---------------------------------------------------------------------------

test("the three scan endpoints stamp the full nowIso, not the truncated day", () => {
  const src = read(ROUTES);
  const dateStamps = src.match(/mergedJc\.completedDate = today;/g) ?? [];
  const instantStamps =
    src.match(/mergedJc\.completedAt = observedCompletionAt\(nowIso\);/g) ?? [];
  assert.equal(
    dateStamps.length,
    3,
    "expected the three scan-completion sites (/scan-complete, /scan-complete-dept, " +
      "/scan-complete-shared) to still stamp the date-only completedDate",
  );
  assert.equal(
    instantStamps.length,
    3,
    "every scan-completion site must stamp the full instant beside the date",
  );
  // The bug in one line: passing `today` here would re-truncate.
  assert.ok(
    !/observedCompletionAt\(today\)/.test(src),
    "observedCompletionAt must be handed nowIso — handing it `today` is the original bug",
  );
});

test("the office PATCH stamps the full instant when it auto-completes a card", () => {
  const src = read(HELPERS);
  // Take the `if (isDone)` block that auto-stamps the completion and require
  // both writes inside IT, rather than anywhere in a 5,800-line file.
  const anchor = src.indexOf("if (!updated.completedDate) {");
  assert.notEqual(anchor, -1, "the auto-stamp branch has moved — re-anchor this guard");
  const block = src.slice(anchor, src.indexOf("updated.overdue = \"COMPLETED\";", anchor));
  assert.match(
    block,
    /updated\.completedDate = today;/,
    "completed_date must still be the date-only value",
  );
  assert.match(
    block,
    /updated\.completedAt = observedCompletionAt\(nowIso\);/,
    "the instant must be captured in the same branch that stamps the date",
  );
});

test("an operator-supplied date reconciles rather than mints an instant", () => {
  const src = read(HELPERS);
  const anchor = src.indexOf("if (body.completedDate !== undefined) {");
  assert.notEqual(anchor, -1, "the explicit-date branch has moved — re-anchor this guard");
  const block = src.slice(anchor, anchor + 1400);
  assert.match(
    block,
    /updated\.completedAt = reconcileCompletedAt\(/,
    "a typed date is an assertion about a day, not an observation — it must go " +
      "through reconcileCompletedAt, which can only keep or drop an existing instant",
  );
  assert.ok(
    !/updated\.completedAt = observedCompletionAt/.test(block),
    "an operator typing a date must never mint a fresh timestamp",
  );
});

// ---------------------------------------------------------------------------
// 4. completed_date semantics are untouched.
// ---------------------------------------------------------------------------

test("no completion write path stores a full instant into completedDate", () => {
  const offenders = [];
  for (const file of API_FILES) {
    const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    if (/completedDate\s*=\s*nowIso\b/.test(src)) {
      offenders.push(file.slice(ROOT.length + 1));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "completed_date is date-only BY DESIGN — the efficiency scan, the dept sheets, " +
      "the job-card list filters and every substr(completedDate,1,10) comparison " +
      "depend on its shape:\n  " + offenders.join("\n  "),
  );
});

test("the migration is additive and performs no backfill", () => {
  const sql = read(MIGRATION);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS completed_at TEXT/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS/i);
  // The time is gone for existing rows. Any UPDATE here would be inventing one.
  assert.ok(
    !/\bUPDATE\b/i.test(sql.replace(/^--.*$/gm, "")),
    "historical completed_at must stay NULL — a backfill would fabricate a measurement",
  );
  assert.ok(
    !/\bDROP\b|\bALTER COLUMN\b/i.test(sql.replace(/^--.*$/gm, "")),
    "completed_date must not be dropped or redefined",
  );
});
