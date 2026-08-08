// ---------------------------------------------------------------------------
// No QC criterion may depend on a RETAINED SAMPLE.
//
// Owner 2026-08-08: "留样登记应该就不需要了，因为我们正常都不会做留样登记的."
//
// This is not a style rule. There is no retained-sample, swatch or
// golden-sample table anywhere in the schema — the only two tables with
// "sample" in the name are `po_scan_samples` / `supplier_scan_samples`, which
// are OCR training data for the document scanner. The factory files no
// reference material and never has. So an item that says "compare against the
// retained sample" cannot be answered by anybody standing in front of the
// goods, and an item that cannot be answered is an item that gets ticked —
// which is precisely how 3,009 inspections came to sit PENDING for three
// months with none ever completed.
//
// Seventeen such criteria were seeded by 0215 / 0217 / 0219 and are rewritten
// by 0220. This test reads the migrations in order, replays every INSERT and
// every guarded UPDATE, and asserts that the FINAL state of each seeded item
// mentions no retained reference. It also asserts the rewrites are real —
// that they still say what to measure and what to write down, so "fixing" the
// wording by deleting the substance would fail here too.
//
// The content is data and lives in the migrations, so that is what is read.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// In apply order. 0068 seeds the original bare items; 0215-0219 add and enrich;
// 0220 removes the retained-sample dependency.
const FILES = [
  "0068_qc_module_phase1.sql",
  "0215_qc_rm_per_receipt_and_fg_order_check.sql",
  "0216_qc_rm_one_check_per_day.sql",
  "0217_qc_stored_material_daily_check.sql",
  "0218_qc_fg_risk_weighted_sample.sql",
  "0219_qc_wip_department_checklists.sql",
  "0220_qc_no_retained_sample.sql",
];

const SOURCES = FILES.map((f) => ({
  file: f,
  sql: readFileSync(new URL(`../migrations-postgres/${f}`, import.meta.url), "utf8"),
}));

// The phrases that name a reference this factory does not keep. "reference
// unit" is in here because 0219 used it as a synonym; "sample" on its own is
// NOT, because "SAMPLE: 5 sheets per receipt" is a sample SIZE and is exactly
// what these criteria are supposed to say.
const BANNED = [
  /retain(ed|s)?\b/i,
  /swatch/i,
  /reference sample/i,
  /reference unit/i,
  /golden sample/i,
  /filed reference/i,
];

// --- a small SQL literal scanner -------------------------------------------
// Regex cannot split these tuples: the criteria text is full of commas and of
// '' escapes. Walk the characters instead. (Same approach as
// tests/qc-wip-templates.test.mjs — kept local so neither test can silently
// change the other's parse.)
function splitTopLevel(text) {
  const groups = [];
  let depth = 0;
  let inStr = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "'") {
        if (text[i + 1] === "'") i++;
        else inStr = false;
      }
      continue;
    }
    if (c === "'") { inStr = true; continue; }
    if (c === "(") { if (depth === 0) start = i + 1; depth++; continue; }
    if (c === ")") { depth--; if (depth === 0) groups.push(text.slice(start, i)); continue; }
    if (depth === 0 && c === ";") break;
  }
  return groups;
}

function splitFields(group) {
  const out = [];
  let inStr = false;
  let cur = "";
  for (let i = 0; i < group.length; i++) {
    const c = group[i];
    if (inStr) {
      if (c === "'") {
        if (group[i + 1] === "'") { cur += "'"; i++; }
        else inStr = false;
      } else cur += c;
      continue;
    }
    if (c === "'") { inStr = true; continue; }
    if (c === ",") { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** Strip `-- …` line comments so a comment quoting the old wording is not
 *  mistaken for live data. Comments are where the REASON lives and they are
 *  allowed to say "retained sample"; only the SQL is scanned. */
function stripComments(sql) {
  return sql
    .split("\n")
    .map((line) => {
      let inStr = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "'") {
          if (inStr && line[i + 1] === "'") { i++; continue; }
          inStr = !inStr;
          continue;
        }
        if (!inStr && line[i] === "-" && line[i + 1] === "-") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/**
 * Replay the migrations into the final state of every qc_template_items row.
 * INSERT … VALUES seeds; UPDATE … SET … WHERE id = '…' overwrites item_name
 * and/or criteria. Guards (`AND criteria IS NULL`, `AND criteria = '…'`,
 * `AND criteria ILIKE '%retain%'`) are honoured so the replay matches what the
 * database actually ends up with rather than what the file hopes for.
 */
function replay() {
  const rows = new Map();
  for (const { file, sql: raw } of SOURCES) {
    const sql = stripComments(raw);

    const insertRe = /INSERT INTO qc_template_items \([^)]*\) VALUES/gi;
    let m;
    while ((m = insertRe.exec(sql))) {
      for (const g of splitTopLevel(sql.slice(m.index + m[0].length))) {
        const f = splitFields(g);
        if (f.length < 7) continue;
        // ON CONFLICT (id) DO NOTHING everywhere — first writer wins.
        if (rows.has(f[0])) continue;
        rows.set(f[0], {
          id: f[0],
          templateId: f[1],
          itemName: f[3],
          criteria: f[4] === "NULL" ? null : f[4],
          seededIn: file,
        });
      }
    }

    const updRe =
      /UPDATE qc_template_items\s+SET\s+([\s\S]*?)\s+WHERE\s+id = '([^']+)'([\s\S]*?);/gi;
    while ((m = updRe.exec(sql))) {
      const [, setClause, id, tail] = m;
      const row = rows.get(id);
      if (!row) continue;
      const cur = row.criteria ?? "";
      if (/criteria IS NULL/i.test(tail) && row.criteria != null) continue;
      const eq = /criteria\s*=\s*'((?:[^']|'')*)'/i.exec(tail);
      if (eq && cur !== eq[1].replace(/''/g, "'")) continue;
      const likes = [...tail.matchAll(/(criteria|item_name)\s+ILIKE\s+'%([^%']+)%'/gi)];
      if (likes.length) {
        const hit = likes.some(([, col, needle]) =>
          (col.toLowerCase() === "criteria" ? cur : row.itemName)
            .toLowerCase()
            .includes(needle.toLowerCase()),
        );
        if (!hit) continue;
      }
      const nameSet = /item_name\s*=\s*'((?:[^']|'')*)'/i.exec(setClause);
      const critSet = /criteria\s*=\s*'((?:[^']|'')*)'/i.exec(setClause);
      if (nameSet) row.itemName = nameSet[1].replace(/''/g, "'");
      if (critSet) row.criteria = critSet[1].replace(/''/g, "'");
    }
  }
  return [...rows.values()];
}

const ROWS = replay();

// The seventeen the owner's ruling lands on. Named explicitly so a rewrite
// that silently DELETES an item instead of fixing it fails here.
const REWRITTEN = [
  "qcti-rmf-1", "qcti-rmf-9", "qcti-rmp-5", "qcti-rmb-1", "qcti-rmg-6",
  "qcti-rma-1", "qcti-fgs-so3", "qcti-fgb-so3", "qcti-sto-1", "qcti-stf-3",
  "qcti-stz-3", "qcti-wsup-3", "qcti-wsup-5", "qcti-wsfs-16", "qcti-wswb-11",
  "qcti-wbfs-14", "qcti-wbup-11",
];

test("the parser found the seeded items — a silently empty replay would pass everything", () => {
  assert.ok(ROWS.length > 200, `only replayed ${ROWS.length} items`);
  for (const id of REWRITTEN) {
    assert.ok(ROWS.find((r) => r.id === id), `${id} is missing from the seed entirely`);
  }
});

test("no seeded criterion asks the inspector to compare against a retained sample", () => {
  const offenders = [];
  for (const row of ROWS) {
    for (const field of ["itemName", "criteria"]) {
      const text = row[field];
      if (!text) continue;
      const bad = BANNED.find((re) => re.test(text));
      if (bad) offenders.push(`${row.id}.${field} matches ${bad}: ${text.slice(0, 120)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "there is no retained-sample / swatch / golden-sample table in this database, " +
      "so any criterion naming one is unanswerable:\n" + offenders.join("\n"),
  );
});

test("the rewritten items still say what to do and what to record", () => {
  for (const id of REWRITTEN) {
    const row = ROWS.find((r) => r.id === id);
    assert.ok(row.criteria, `${id} has no criteria at all after the rewrite`);
    assert.ok(
      row.criteria.length >= 80,
      `${id} was shortened to ${row.criteria.length} chars — a criterion is a method, not a slogan`,
    );
    assert.match(
      row.criteria,
      /write down|write it down|write both down|write them down|write that figure/i,
      `${id} no longer tells the inspector what to RECORD — removing the retained sample must not remove the record`,
    );
  }
});

test("each rewrite points at something that physically exists: paperwork, the delivery, the rack, or a measurement", () => {
  // The four replacement strategies 0220 documents. Every rewritten item has
  // to land on at least one of them — otherwise it is a different unanswerable
  // instruction wearing new words.
  const ANCHORS =
    /PO line|purchase order|\bBOM\b|sales-order line|spec drawing|model spec|cutting marker|cutting docket|job card|packing list|in the rack|already in store|on the floor|same order|each other|itself|mm\b|count\b/i;
  for (const id of REWRITTEN) {
    const row = ROWS.find((r) => r.id === id);
    assert.match(row.criteria, ANCHORS, `${id} names no comparator the inspector can actually reach`);
  }
});
