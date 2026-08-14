// ---------------------------------------------------------------------------
// docs-required-reading-truth.test.mjs — the required-reading docs are gated
// like the map is.
//
// WHY THIS EXISTS
// `scripts/check-codebase-map.mjs` validates paths, `file:LINE` refs and symbol
// anchors — but ONLY inside `docs/CODEBASE-MAP.md`. The four other docs that
// `CLAUDE.md` tells every session and every agent to read first had NO
// mechanical gate at all, so a wrong pointer in them survived indefinitely.
// The 2026-08-14 prose audit (`docs/DOCS-VS-CODE-AUDIT.md`) found exactly that:
//
//   · HOOKKA-GOTCHAS cited `src/api/lib/production-builder.ts:890/893` — a path
//     that has never existed (the file is `src/lib/production-order-builder.ts`)
//   · its `attendance_records` row asserted a LIVE `working_minutes × 0.85`
//     writer at `attendance.ts:332`, five lines above a paragraph saying that
//     writer had been removed; `attendance.ts:332` is a `DELETE /:id` handler
//   · BUG-CLASSES C20 row 3 ordered the reader to "fix" `job_cards.actual_minutes`
//     while HOOKKA-GOTCHAS — corrected by the OWNER the same day — orders the
//     reader not to, because it is standard costing working as designed
//
// A gap makes someone go and look. A confident wrong claim makes them act.
//
// EOL NOTE: these are CRLF files on this machine. Every read is normalised
// before matching — a literal "\n" anchor against CRLF bytes matches NOTHING
// and has produced five false all-clears this week.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const lineCount = (rel) => read(rel).split("\n").length;

const REQUIRED_READING = [
  "CLAUDE.md",
  "docs/PLAYBOOKS.md",
  "docs/context-packs/HOOKKA-GOTCHAS.md",
  "docs/DEV-OPERATING-FRAMEWORK.md",
  "docs/BUG-CLASSES.md",
];

// A repo path inside backticks, optionally with `:123`, `:12-34` or `:12,34`.
const REF_RE =
  /`([A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|json|sql|md|toml|yml))(?::(\d+(?:[,-]\d+)*))?`/g;
// Only these prefixes are repo-rooted. A BARE filename (`utils.ts`) is a
// deliberate shorthand in these docs and is not resolvable — do not fail it.
const REPO_ROOTED = [
  "src/",
  "tests/",
  "scripts/",
  "docs/",
  "migrations-postgres/",
  "functions/",
];

test("every repo path cited in the required-reading docs exists", () => {
  const missing = [];
  for (const doc of REQUIRED_READING) {
    read(doc)
      .split("\n")
      .forEach((line, i) => {
        for (const m of line.matchAll(REF_RE)) {
          const p = m[1];
          if (!REPO_ROOTED.some((r) => p.startsWith(r))) continue;
          if (!existsSync(join(ROOT, p))) missing.push(`${doc}:${i + 1} → ${p}`);
        }
      });
  }
  assert.deepEqual(
    missing,
    [],
    `required-reading docs cite ${missing.length} path(s) that do not exist:\n  ` +
      missing.join("\n  "),
  );
});

test("every file:LINE ref in the required-reading docs is inside its file", () => {
  const outOfRange = [];
  for (const doc of REQUIRED_READING) {
    read(doc)
      .split("\n")
      .forEach((line, i) => {
        for (const m of line.matchAll(REF_RE)) {
          const [, p, nums] = m;
          if (!nums) continue;
          if (!REPO_ROOTED.some((r) => p.startsWith(r))) continue;
          if (!existsSync(join(ROOT, p))) continue; // reported by the test above
          const len = lineCount(p);
          for (const n of nums.split(/[,-]/).map(Number)) {
            if (n > len) outOfRange.push(`${doc}:${i + 1} → ${p}:${n} (file is ${len} lines)`);
          }
        }
      });
  }
  assert.deepEqual(
    outOfRange,
    [],
    `required-reading docs point past end-of-file ${outOfRange.length} time(s):\n  ` +
      outOfRange.join("\n  "),
  );
});

// --- the two claim-specific guards ----------------------------------------

test("no attendance_records writer stores a production-time ratio, and GOTCHAS does not say one does", () => {
  // (a) the code: all three INSERT sites omit the two unmeasured columns.
  for (const rel of [
    "src/api/routes/attendance.ts",
    "src/api/routes/worker.ts",
    "src/api/routes/working-hour-entries.ts",
  ]) {
    const src = read(rel);
    const inserts = [...src.matchAll(/INSERT INTO attendance_records \(([\s\S]*?)\)/g)];
    assert.ok(inserts.length > 0, `${rel}: expected at least one INSERT INTO attendance_records`);
    for (const ins of inserts) {
      const cols = ins[1];
      assert.ok(
        !/productionTimeMinutes|production_time_minutes/.test(cols),
        `${rel}: an INSERT INTO attendance_records names productionTimeMinutes again — ` +
          `that column has never been measured (BUG-2026-08-13-103, class C15).`,
      );
      assert.ok(
        !/efficiencyPct|efficiency_pct/.test(cols),
        `${rel}: an INSERT INTO attendance_records names efficiencyPct again.`,
      );
    }
  }

  // (b) the doc must not describe that removed writer as current behaviour.
  const gotchas = read("docs/context-packs/HOOKKA-GOTCHAS.md");
  const table = gotchas.slice(
    gotchas.indexOf("| Column | What it really is |"),
    gotchas.indexOf("They are not *coincidentally* equal"),
  );
  assert.ok(table.length > 0, "the standard-time table moved — re-anchor this guard");
  const attRow = table
    .split("\n")
    .find((l) => l.includes("attendance_records.production_time_minutes"));
  assert.ok(attRow, "the attendance_records row vanished from the standard-time table");
  assert.ok(
    /NULL/.test(attRow) && !/^\|[^|]*\|\s*`?=\s*working_minutes\s*×\s*0\.85/.test(attRow),
    "HOOKKA-GOTCHAS' standard-time table must say attendance_records.production_time_minutes " +
      "is NULL/unwritten. It read `= working_minutes × 0.85` until 2026-08-14, contradicting " +
      "its own next paragraph. Row was: " + attRow,
  );
});

test("BUG-CLASSES C20 row 3 does not order the opposite of HOOKKA-GOTCHAS on job_cards.actual_minutes", () => {
  const classes = read("docs/BUG-CLASSES.md");
  const row = classes
    .split("\n")
    .find((l) => l.startsWith("| 3 |") && l.includes("job_cards.actual_minutes"));
  assert.ok(row, "C20 row 3 (job_cards.actual_minutes) is gone — re-anchor this guard");
  assert.ok(
    !row.includes("⬜"),
    "C20 row 3 is marked OPEN again. `actual_minutes = est_minutes` is Hookka's standard-costing " +
      "model, ruled by the owner on 2026-08-14, and HOOKKA-GOTCHAS says \"Do not 'fix' it.\" " +
      "Two required-reading docs must not order opposite things about one column.",
  );
  assert.ok(
    /HOOKKA-GOTCHAS/.test(row),
    "C20 row 3 must point the reader at HOOKKA-GOTCHAS' standard-costing section.",
  );

  // The owner's ruling must still be stated where the row sends the reader.
  const gotchas = read("docs/context-packs/HOOKKA-GOTCHAS.md");
  assert.ok(
    /STANDARD TIME, BY DESIGN/.test(gotchas) && /Do not "fix" it/.test(gotchas),
    "HOOKKA-GOTCHAS lost the owner's standard-costing ruling; C20 row 3 now points at nothing.",
  );
});
