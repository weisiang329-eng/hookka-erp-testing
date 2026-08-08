// ---------------------------------------------------------------------------
// What each DEPARTMENT is actually checked on.
//
// Owner 2026-08-08: "像我们这些部门，比如我们自己做沙发厂、被褥厂的，去部门检查
// 需要检查什么东西呢？"
//
// The 11 WIP templates from 0068 existed but were three to five bare phrases
// with NO criteria at all — "Stitch consistency", "Overall finish look
// acceptable" — nothing saying how many pieces to look at, what to measure, or
// what to write down. That is a list people learn to tick, and it is exactly
// how QC became theatre here once already.
//
// A WIP check is a DIFFERENT question from an incoming one. Incoming asks "is
// this batch good?"; WIP asks "is this DEPARTMENT following the standard?" — so
// these tests hold the shape of that: every item observable, every item
// recordable, no opinions, and the method/conformance items actually present.
//
// The content is data and lives in the migrations, so that is what is read.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SQL = ["0068_qc_module_phase1.sql", "0219_qc_wip_department_checklists.sql"]
  .map((f) => readFileSync(new URL(`../migrations-postgres/${f}`, import.meta.url), "utf8"))
  .join("\n");

const WIP_TEMPLATES = [
  "qct-wip-sofa-fabcut",
  "qct-wip-sofa-fabsew",
  "qct-wip-sofa-foam",
  "qct-wip-sofa-framing",
  "qct-wip-sofa-webbing",
  "qct-wip-sofa-uph",
  "qct-wip-bf-woodcut",
  "qct-wip-bf-framing",
  "qct-wip-bf-fabcut",
  "qct-wip-bf-fabsew",
  "qct-wip-bf-uph",
];

// --- a small SQL literal scanner -------------------------------------------
// Regex cannot split these tuples: the criteria text is full of commas and of
// '' escapes. Walk the characters instead.
function splitTopLevel(text, open = "(", close = ")") {
  const groups = [];
  let depth = 0;
  let inStr = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "'") {
        if (text[i + 1] === "'") i++; // '' escape
        else inStr = false;
      }
      continue;
    }
    if (c === "'") { inStr = true; continue; }
    if (c === open) { if (depth === 0) start = i + 1; depth++; continue; }
    if (c === close) { depth--; if (depth === 0) groups.push(text.slice(start, i)); continue; }
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

/** Every qc_template_items row inserted across both files. */
function parseInsertedItems() {
  const items = [];
  const re = /INSERT INTO qc_template_items \([^)]*\) VALUES/gi;
  let m;
  while ((m = re.exec(SQL))) {
    const rest = SQL.slice(m.index + m[0].length);
    for (const g of splitTopLevel(rest)) {
      const f = splitFields(g);
      if (f.length < 7) continue;
      items.push({
        id: f[0],
        templateId: f[1],
        sequence: Number(f[2]),
        itemName: f[3],
        criteria: f[4] === "NULL" ? null : f[4],
        severity: f[5],
        isMandatory: Number(f[6]),
      });
    }
  }
  return items;
}

/** Every `UPDATE qc_template_items SET criteria = '…' … WHERE id = '…'`. */
function parseCriteriaBackfills() {
  const out = new Map();
  const re = /UPDATE qc_template_items\s+SET\s+([\s\S]*?)\s+WHERE\s+id = '([^']+)'([\s\S]*?);/gi;
  let m;
  while ((m = re.exec(SQL))) {
    const setClause = m[1];
    const id = m[2];
    const tail = m[3];
    const crit = /criteria\s*=\s*'((?:[^']|'')*)'/i.exec(setClause);
    if (crit) out.set(id, { criteria: crit[1].replace(/''/g, "'"), guardedOnNull: /criteria IS NULL/i.test(tail) });
  }
  return out;
}

const ITEMS = parseInsertedItems();
const BACKFILLS = parseCriteriaBackfills();

function wipItems(templateId) {
  return ITEMS.filter((i) => i.templateId === templateId);
}
function effectiveCriteria(item) {
  return item.criteria ?? BACKFILLS.get(item.id)?.criteria ?? null;
}

// --- the tests --------------------------------------------------------------

test("the parser actually found the templates — a silently empty parse would pass everything", () => {
  assert.ok(ITEMS.length > 100, `only parsed ${ITEMS.length} items`);
  for (const t of WIP_TEMPLATES) {
    assert.ok(wipItems(t).length > 0, `${t} parsed to nothing`);
  }
});

test("every WIP department has a checklist worth opening, not three bare phrases", () => {
  for (const t of WIP_TEMPLATES) {
    const n = wipItems(t).length;
    assert.ok(n >= 7, `${t} has only ${n} items — 0068 left these at 3-5 and nobody read them`);
  }
});

test("every WIP item says HOW to check it and what to write down", () => {
  // An item an inspector cannot answer with evidence is an item they learn to
  // tick. This is the whole difference between the 0068 lists and these.
  const missing = [];
  for (const t of WIP_TEMPLATES) {
    for (const item of wipItems(t)) {
      if (!effectiveCriteria(item)) missing.push(`${item.id} (${item.itemName})`);
    }
  }
  assert.deepEqual(missing, [], `items with no criteria: ${missing.join(", ")}`);
});

test("every WIP item asks for something RECORDED — a number, a count, a comparison", () => {
  const RECORDS = /write down|count|measure|tape-measure|callipers|try-square|compare|weigh|write the/i;
  const weak = [];
  for (const t of WIP_TEMPLATES) {
    for (const item of wipItems(t)) {
      const c = effectiveCriteria(item) ?? "";
      if (!RECORDS.test(c)) weak.push(`${item.id} (${item.itemName})`);
    }
  }
  assert.deepEqual(weak, [], `items that record nothing: ${weak.join(", ")}`);
});

test("no WIP item is an OPINION", () => {
  // "Overall finish look acceptable" cannot be disagreed with, which is exactly
  // why it never caught anything. Both 0068 opinions are re-stated as
  // measurements in 0219.
  const OPINION = /\bas expected\b|\bacceptable\b|\blooks ok\b|\bsatisfactory\b|\bgood enough\b/i;
  const offenders = [];
  for (const t of WIP_TEMPLATES) {
    for (const item of wipItems(t)) {
      const backfilled = BACKFILLS.get(item.id);
      // The item NAME as it will finally read: 0219 rewrites two of them.
      const rewritten = new RegExp(`SET\\s+item_name = '[^']+',[\\s\\S]{0,400}WHERE id = '${item.id}'`).test(SQL);
      if (rewritten) continue;
      if (OPINION.test(item.itemName)) offenders.push(`${item.id}: ${item.itemName}`);
      if (backfilled && OPINION.test(backfilled.criteria)) offenders.push(`${item.id} criteria`);
    }
  }
  assert.deepEqual(offenders, [], `opinion items left: ${offenders.join(", ")}`);
});

test("the two 0068 opinions are rewritten into things that can be measured", () => {
  assert.match(SQL, /item_name = 'Seat sinks within spec under a standard load'/);
  assert.match(SQL, /WHERE id = 'qcti-wsup-3' AND item_name = 'Cushion firmness as expected'/,
    "guarded on the OLD text, so an owner edit is never clobbered");
  assert.match(SQL, /item_name = 'Unit matches the retained reference sample'/);
  assert.match(SQL, /WHERE id = 'qcti-wsup-5' AND item_name = 'Overall finish look acceptable'/);
});

test("each station carries the CONFORMANCE item — built to the document, not to memory", () => {
  // The question a WIP check exists to ask. A panel can measure perfectly and
  // still be cut from the wrong model's marker.
  const conformance = {
    "qct-wip-sofa-fabcut": /marker for THIS model/i,
    "qct-wip-bf-fabcut": /marker for THIS headboard size/i,
    "qct-wip-bf-woodcut": /cut list for THIS bed size/i,
    "qct-wip-bf-framing": /bed size ORDERED/i,
    "qct-wip-sofa-framing": /frame dimensions match the BOM/i,
    "qct-wip-sofa-webbing": /webbing type matches the BOM/i,
    "qct-wip-sofa-foam": /piece count per unit matches the BOM/i,
  };
  for (const [tpl, re] of Object.entries(conformance)) {
    const hit = wipItems(tpl).some((i) => re.test(i.itemName));
    assert.ok(hit, `${tpl} has no conformance item matching ${re}`);
  }
});

test("the cutting stations carry a FIRST-OFF item — the check that catches a whole batch", () => {
  // A stop block that moved 3mm is one bad piece if somebody measured the first
  // one and a whole day's work if nobody did.
  for (const tpl of ["qct-wip-sofa-fabcut", "qct-wip-sofa-foam", "qct-wip-bf-woodcut"]) {
    const hit = wipItems(tpl).some((i) => /first (panel|piece)/i.test(i.itemName));
    assert.ok(hit, `${tpl} has no first-off check`);
  }
});

test("the process-STEP items are present at the stations that skip them", () => {
  // Glue before fastening, corner blocks, centre rail, locked seam ends: the
  // steps that pass a look and fail in the customer's house.
  const steps = [
    ["qct-wip-sofa-framing", /corner blocks|gussets/i],
    ["qct-wip-bf-framing", /centre rail/i],
    ["qct-wip-sofa-fabsew", /backstitch|lockstitch/i],
    ["qct-wip-bf-fabsew", /backstitch|lockstitch/i],
    ["qct-wip-sofa-uph", /build-up layers/i],
  ];
  for (const [tpl, re] of steps) {
    assert.ok(wipItems(tpl).some((i) => re.test(i.itemName)), `${tpl} is missing ${re}`);
  }
});

test("re-running 0219 changes nothing and never clobbers an owner edit", () => {
  const file = readFileSync(
    new URL("../migrations-postgres/0219_qc_wip_department_checklists.sql", import.meta.url),
    "utf8",
  );
  const inserts = file.match(/INSERT INTO qc_template_items/gi) ?? [];
  const guards = file.match(/ON CONFLICT \(id\) DO NOTHING/gi) ?? [];
  assert.equal(inserts.length, guards.length, "every INSERT needs its ON CONFLICT guard");

  // Every criteria backfill only fills a BLANK.
  const fills = file.match(/UPDATE qc_template_items SET criteria = '(?:[^']|'')*'\s+WHERE id = '[^']+'[^;]*;/gi) ?? [];
  assert.ok(fills.length > 20, `only found ${fills.length} criteria backfills`);
  for (const f of fills) {
    assert.match(f, /criteria IS NULL/, `unguarded criteria overwrite: ${f.slice(0, 90)}…`);
  }
});

test("no item id collides across the QC migrations", () => {
  const seen = new Set();
  const dupes = [];
  for (const i of ITEMS) {
    if (seen.has(i.id)) dupes.push(i.id);
    seen.add(i.id);
  }
  assert.deepEqual(dupes, [], `duplicate item ids: ${dupes.join(", ")}`);
});

test("the new items are sequenced clear of the 0068 ones", () => {
  // 0068 used 1..5; 0219 starts at 11, so the original ordering is untouched and
  // it stays obvious on screen what arrived when.
  for (const t of WIP_TEMPLATES) {
    const seqs = wipItems(t).map((i) => i.sequence).sort((a, b) => a - b);
    assert.equal(new Set(seqs).size, seqs.length, `${t} has a duplicate sequence`);
    assert.ok(seqs.filter((s) => s > 10).length > 0, `${t} gained no new items`);
  }
});
