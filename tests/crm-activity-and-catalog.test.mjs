// ---------------------------------------------------------------------------
// crm-activity-and-catalog.test.mjs — the CRM panel records a real call, and
// the lead catalog is picked by MODEL with multiselect.
//
// Owner 2026-08-02, three asks on one screen:
//   「我应该能记录几时 call 他、call 之后发生了什么,以及我 call 的是谁」
//   「系统未必要强求 mention next follow-up,只要能提醒我下一次 follow-up 的
//     时候,具体要 follow up 什么东西就行」
//   「不能根据我的 catalog 去选吗？…直接带出这个 catalog 里面所有的 SKU」
//   「难道不能 multiselect 吗？如果不能 multiselect 的话,就不好用了」
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panel = () => readFileSync("src/components/customer/CrmPanel.tsx", "utf8");
const route = () => readFileSync("src/api/routes/customer-crm.ts", "utf8");
const leads = () => readFileSync("src/pages/leads/index.tsx", "utf8");

// --- Activity & follow-ups --------------------------------------------------

test("a call can be dated to the day it HAPPENED, not the day it was typed", () => {
  // The old form stamped created_at = now only, so a call logged the next
  // morning was filed under the wrong day and sorted above calls actually made
  // that day.
  const src = panel();
  assert.match(src, /occurredAt: todayIso\(\)/, "defaults to today, still editable");
  assert.match(src, /value=\{aForm\.occurredAt\}/);

  const r = route();
  assert.match(r, /ALTER TABLE customer_activities ADD COLUMN IF NOT EXISTS occurred_at TEXT/);
  assert.match(r, /occurred_at/, "the insert carries it");
});

test("the timeline orders by when it happened, and old rows keep their place", () => {
  const r = route();
  assert.match(
    r,
    /ORDER BY COALESCE\(occurred_at, substr\(created_at, 1, 10\)\) DESC/,
    "every row written before occurred_at existed must still sort sensibly",
  );
  // The display falls back the same way, or old rows would render blank dates.
  assert.match(panel(), /\(a\.occurred_at \?\? a\.created_at\)\?\.slice\(0, 10\)/);
});

test("what came of the call is recordable — the column existed but had no input", () => {
  // `outcome` and `detail` were already in the POST payload and the table, and
  // there was no field for either, so they were永远 null.
  const src = panel();
  assert.match(src, /placeholder="Outcome — what came of it\?"/);
  assert.match(src, /value=\{aForm\.outcome\}/);
  assert.match(src, /\{a\.outcome \? /, "and it is shown back on the timeline");
});

test("who you spoke to is picked from the contacts already loaded", () => {
  // Free text beside a known list is how one person ends up with three
  // spellings. It stays an input, not a select, so the receptionist who
  // answered can still be named.
  const src = panel();
  assert.match(src, /list=\{`crm-contacts-\$\{customerId\}`\}/);
  assert.match(src, /<datalist id=\{`crm-contacts-\$\{customerId\}`\}>/);
  assert.match(src, /contacts\.map\(\(c\) => \(/);
});

test("the follow-up carries a TOPIC, and the date is not required", () => {
  // The owner was explicit that the date must not be forced. A reminder that
  // only says "follow up" tells you nothing when it fires, so the topic is the
  // part that matters.
  const src = panel();
  assert.match(src, /placeholder="Next time, follow up on… \(optional\)"/);
  assert.match(src, /followUpTopic/);
  // Log is gated on the summary ALONE — never on a follow-up date.
  assert.match(src, /disabled=\{saving \|\| !aForm\.summary\.trim\(\)\}/);
  assert.doesNotMatch(src, /!aForm\.nextFollowUp/, "the date must not gate logging");

  // The timeline shows the topic even when no date was set, or the topic would
  // be written and never seen.
  assert.match(src, /a\.follow_up_topic \|\| a\.next_follow_up \?/);
  assert.match(src, /\{a\.follow_up_topic \|\| "follow up"\}/);

  assert.match(route(), /ADD COLUMN IF NOT EXISTS follow_up_topic TEXT/);
});

test("the new columns reach prod through self-apply, not a migration file", () => {
  // CREATE TABLE IF NOT EXISTS is a no-op against the existing production
  // table, so the ALTERs are the ONLY path these columns take (CLAUDE.md).
  // runSelfApply, so a real failure is logged with its statement and thrown
  // rather than swallowed and remembered as done.
  const r = route();
  assert.match(r, /import \{ runSelfApply, memoizeSelfApply \} from "\.\.\/lib\/self-apply"/);
  assert.match(r, /runSelfApply\(\s*db[^,]*,\s*"customer-crm"/s);
  // And the memo is a PROMISE that is dropped when the round fails — a boolean
  // set after the awaits ran the whole block once per concurrent caller and had
  // no rejection path. The sweep in self-apply-retry.test.mjs caught this file.
  assert.match(r, /let tablesPending: Promise<void> \| null = null;/);
  assert.match(r, /memoizeSelfApply\(/);
  assert.doesNotMatch(r, /tablesEnsured/, "the boolean guard must not return");
});

// --- Lead catalog: model first, then multiselect -----------------------------

test("SKUs are chosen by MODEL, grouped exactly as the Catalog page groups them", () => {
  // One bedframe model carries fourteen SKUs (1003-(K), 1003(A)-(Q),
  // 1003(A)(HF)(W)-(SS)…). The old control was one free-text datalist over
  // every SKU in the company.
  const src = leads();
  assert.match(src, /import \{ familyOf \} from "@\/lib\/product-family"/,
    "the same grouping the Catalog page uses, so the two cannot disagree");
  assert.match(src, /familyOf\(p\.code\) \|\| p\.code/);
  assert.match(src, /Pick a model from the catalog…/);
  assert.doesNotMatch(src, /placeholder="Pick a SKU…"/, "the flat SKU datalist is gone");
});

test("picking a model brings out ALL its SKUs, tickable", () => {
  const src = leads();
  assert.match(src, /\{modelSkus\.length\} SKUs in this model/);
  assert.match(src, /type="checkbox"/);
  assert.match(src, />\s*Select all\s*</);
  assert.match(src, />\s*Clear\s*</);
});

test("a SKU already on the lead is ticked and LOCKED", () => {
  // Otherwise a second pass over the same model silently duplicates lines.
  const src = leads();
  assert.match(src, /const alreadyOn = useMemo/);
  assert.match(src, /checked=\{on \|\| ticked\.has\(p\.id\)\}/);
  assert.match(src, /disabled=\{on\}/);
  // Select all must not re-tick them either.
  assert.match(src, /modelSkus\.filter\(\(p\) => !alreadyOn\.has\(p\.code\.toUpperCase\(\)\)\)/);
});

test("the batch adds sequentially, not all at once", () => {
  // The endpoint self-applies its DDL on the first write; ten concurrent
  // creates against a cold isolate race that.
  const src = leads();
  assert.match(src, /for \(const p of chosen\) \{/);
  assert.doesNotMatch(src, /Promise\.all\(chosen/);
});

test("Add is disabled until something is ticked, and says how many", () => {
  const src = leads();
  assert.match(src, /disabled=\{saving \|\| ticked\.size === 0\}/);
  assert.match(src, /Add \$\{ticked\.size \|\| ""\} SKU/);
});

test("changing model clears the ticks", () => {
  // Carrying ticks across models would add SKUs the operator never saw.
  assert.match(leads(), /setModel\(e\.target\.value\); setTicked\(new Set\(\)\)/);
});

test("a model is labelled with the MODEL's name, not one member's size", () => {
  // The first SKU of 1003 is "HILTON BEDFRAME (6FT) (183X190CM)", so taking its
  // name verbatim made the dropdown read "1003 — HILTON BEDFRAME (6FT)
  // (183X190CM) (14 SKUs)" — as though the model itself were a 6FT.
  const src = leads();
  assert.match(src, /\.replace\(\/\(\\s\*\\\(\[\^\)\]\*\\\)\)\+\\s\*\$\/, ""\)/,
    "trailing size parentheticals are stripped");
  // Never leaves a blank label.
  assert.match(src, /\.trim\(\) \|\| \(skus\[0\]\?\.name \?\? key\)/);
});
