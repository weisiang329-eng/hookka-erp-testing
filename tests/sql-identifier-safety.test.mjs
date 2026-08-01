// ---------------------------------------------------------------------------
// sql-identifier-safety.test.mjs — BUG CLASS: Postgres folds unquoted
// identifiers to lower case, and this repo's adapter only puts the case back
// for names it recognises. Two failure modes fall out of that, and BOTH are
// silent in different ways:
//
//   (A) a camelCase COLUMN not in column-rename-map.json folds to a name the
//       table does not have → hard 500 `column "xxx" does not exist`.
//   (B) a camelCase ALIAS folds to lower case, columnFrom() can't restore it
//       (postgres.toCamel leaves an underscore-free word alone), so the route
//       reads `undefined` → the number silently computes to 0 / the branch
//       never fires. NO error anywhere.
//
// Instances:
//   · 2026-07 — pricing-integrity.ts was born with it; the file's own header
//     documents `AS soUnit` coming back as `sounit`.
//   · 2026-08-02 — `GET /api/org-chart` returned 500 `column "reportsto" does
//     not exist`; the owner's report was 「完全没有反应」.
//   · 2026-08-02 — swept after reading Houzs-ERP #1471/#1472/#1480, which are
//     the same class ("the code reads a column production does not have") and
//     whose lesson is: audit every column, not the one that got reported.
//     46 dead aliases + 6 missing map entries + 1 dropped column found.
//
// Per docs/BUG-CLASSES.md these pins cover the CLASS, not the instances.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findUnsafeAliases } from "../scripts/audit-sql-aliases.mjs";

const map = JSON.parse(readFileSync("src/api/lib/column-rename-map.json", "utf8"));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// --- (B) aliases -----------------------------------------------------------

test("no SQL alias reads back undefined", () => {
  const hits = findUnsafeAliases(walk("src/api"));
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line} AS ${h.alias}`),
    [],
    "an unquoted mixed-case alias folds to lower case and reads back undefined — " +
      "spell it snake_case (postgres.toCamel restores it on read)",
  );
});

test("the audit script actually catches the shape it exists for", () => {
  // A guard that can't fail is worse than no guard. Prove it fires.
  const hits = findUnsafeAliases(["tests/fixtures/unsafe-alias-fixture.txt"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].alias, "soId2");
});

// --- (A) columns -----------------------------------------------------------

test("the six identifiers that broke the assistant tools are mapped", () => {
  // packing_lists / cnc_templates are physically snake_case; every SIBLING
  // column in the same SELECT was already mapped, which is why only these
  // six 500'd and the queries looked fine on inspection.
  for (const [camel, snake] of Object.entries({
    packingNo: "packing_no",
    stopCount: "stop_count",
    doIds: "do_ids",
    fabricWidth: "fabric_width",
    pieceLabel: "piece_label",
    totalHeight: "total_height",
  })) {
    assert.equal(map[camel], snake, `${camel} must map to ${snake}`);
  }
});

test("reportsTo stays mapped — the org chart is dead without it", () => {
  assert.equal(map.reportsTo, "reports_to");
});

test("a column DROPPED by a migration is never selected again", () => {
  // sales_orders.is_project_order was dropped by migration 0114, which also
  // removed the rename-map entry ON PURPOSE so a re-introduction would fail
  // loudly rather than route to a non-existent column. It was re-introduced
  // anyway, and killed the whole backfill route.
  assert.equal(map.isProjectOrder, undefined, "0114 removed this deliberately");
  const backfills = readFileSync(
    "src/api/routes/import-completion/procurement-backfills.ts",
    "utf8",
  );
  // Code only — the comment at the fix site names the column on purpose, so
  // that the next reader knows why it must never come back.
  const code = backfills
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  assert.doesNotMatch(code, /\bisProjectOrder\b/);
  // The route mirrors production-builder.ts and must keep the SAME condition.
  const builder = readFileSync("src/api/routes/_shared/production-builder.ts", "utf8");
  assert.match(builder, /const isSetItem = isSofa;/);
  assert.match(backfills, /const isSetItem = isSofa;/);
});

test("no route selects a column absent from every migration", () => {
  // `issueDate` was exported from `invoices`; the physical column is
  // `invoice_date` and no `issue_date` exists anywhere.
  const tools = readFileSync("src/api/lib/assistant-tools.ts", "utf8");
  assert.doesNotMatch(tools, /\bissueDate\b/);
  assert.match(tools, /dueDate, invoiceDate, created_at AS createdAt/);
});
