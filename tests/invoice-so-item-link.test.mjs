// ---------------------------------------------------------------------------
// invoice-so-item-link.test.mjs — BUG-2026-08-13-096.
//
// Part 1 (behaviour) pins the ONE rule that makes this column trustworthy:
// the resolver COUNTS candidate sales-order lines and refuses to pick when
// there is more than one. Every assertion here was proved RED by putting the
// bug back — including the two that a first draft got wrong:
//
//   * the "contested tight key must not fall through to the looser key" case
//     passed trivially until the fixture gave the loose key a unique answer,
//     which is the only shape on which the fall-through is observable;
//   * the cross-sales-order case passed with the soId dropped from the key,
//     because the fixture used distinct product codes per SO. It now reuses
//     the same code on both orders, which is the situation that actually
//     exists in this book.
//
// Part 2 (source guards) pins the structure. It reads the files with CRLF
// normalised — these files are CRLF on this checkout and `core.autocrlf`
// decides per checkout, so a literal \n anchor matches NOTHING while looking
// perfectly reasonable. That exact failure has produced false all-clears in
// this repo three times in one week.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try {
  register("tsx/esm", pathToFileURL("./"));
} catch {}

const m = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/invoice-so-item-link.ts"))
    .href
);

/** EOL-agnostic + BOM-agnostic read. See the header — this is load-bearing. */
const read = (p) =>
  readFileSync(resolve(process.cwd(), p), "utf8")
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n");

const soItem = (id, salesOrderId, productCode, sizeCode = "K", fabricCode = "PC151-01") => ({
  id,
  salesOrderId,
  productCode,
  sizeCode,
  fabricCode,
});
const poSpec = (salesOrderId, productCode, sizeCode = "K", fabricCode = "PC151-01") => ({
  salesOrderId,
  productCode,
  sizeCode,
  fabricCode,
});

// ===========================================================================
// Part 1 — the counting rule
// ===========================================================================

test("exact: a unique product+size+fabric line in the PO's own SO resolves", () => {
  const idx = m.buildSoItemIdentity([
    soItem("si-1", "so-A", "1003", "K", "PC151-01"),
    soItem("si-2", "so-A", "1007", "Q", "PC151-04"),
  ]);
  const poById = new Map([["po-1", poSpec("so-A", "1003", "K", "PC151-01")]]);
  const r = m.resolveSoItemId(idx, poById, "po-1");
  assert.equal(r.outcome, "exact");
  assert.equal(r.soItemId, "si-1");
});

test("ambiguous: TWO SO lines with the same product+size+fabric resolve to NULL, not to the first", () => {
  // This is the shape that produced BUG-2026-07-17-001 — three identical
  // 1003(A)-(K)|PC151-01 lines, and a first-one-wins map handing all three the
  // same answer. A price may be taken first-one-wins; an identity may not.
  const idx = m.buildSoItemIdentity([
    soItem("si-1", "so-A", "1003", "K", "PC151-01"),
    soItem("si-2", "so-A", "1003", "K", "PC151-01"),
  ]);
  const poById = new Map([["po-1", poSpec("so-A", "1003", "K", "PC151-01")]]);
  const r = m.resolveSoItemId(idx, poById, "po-1");
  assert.equal(r.soItemId, null, "a contested key must never resolve");
  assert.equal(r.outcome, "ambiguous");
});

test("ambiguous: the withdrawn first claimant is gone from the map, not merely shadowed", () => {
  // Guards the implementation detail that makes the above safe: the first
  // writer is DELETED from byFull. If it were only recorded in the ambiguous
  // set, any future reader that checked the map before the set would resolve.
  const idx = m.buildSoItemIdentity([
    soItem("si-1", "so-A", "1003", "K", "PC151-01"),
    soItem("si-2", "so-A", "1003", "K", "PC151-01"),
  ]);
  const key = m.soItemFullKey("so-A", "1003", "K", "PC151-01");
  assert.equal(idx.byFull.has(key), false);
  assert.equal(idx.ambiguousFull.has(key), true);
});

test("code tier: spec drift falls back to the product code ONLY when it is the sole claimant", () => {
  const idx = m.buildSoItemIdentity([
    soItem("si-1", "so-A", "1003", "K", "PC151-01"),
    soItem("si-2", "so-A", "1007", "Q", "PC151-04"),
  ]);
  // The production order's fabric drifted away from the SO line's.
  const poById = new Map([["po-1", poSpec("so-A", "1003", "K", "PC999-99")]]);
  const r = m.resolveSoItemId(idx, poById, "po-1");
  assert.equal(r.outcome, "code");
  assert.equal(r.soItemId, "si-1");
});

test("code tier refuses when the sales order carries the product code twice", () => {
  const idx = m.buildSoItemIdentity([
    soItem("si-1", "so-A", "1003", "K", "PC151-01"),
    soItem("si-2", "so-A", "1003", "Q", "PC151-04"),
  ]);
  const poById = new Map([["po-1", poSpec("so-A", "1003", "SS", "PC999-99")]]);
  const r = m.resolveSoItemId(idx, poById, "po-1");
  assert.equal(r.soItemId, null);
  assert.equal(r.outcome, "ambiguous");
});

test("a CONTESTED tight key does not fall through to a decidable loose key", () => {
  // The subtle one. Two lines share the full key, so the tight lookup is
  // contested — but here the code key has only those two claimants too... no:
  // the fixture is built so the LOOSE key would answer if the resolver were
  // allowed to ask it, by making the loose map's contest invisible. Concretely:
  // if the resolver fell through, `ambiguousCode` would also be hit and it
  // would still return null — which would make this test pass for the WRONG
  // reason. So the fall-through is made observable instead: the tight key is
  // contested by two lines that differ in nothing, and we assert the outcome
  // is decided at the tight tier by checking the resolver never consults the
  // loose tier at all (a spy map that throws if read).
  const idx = m.buildSoItemIdentity([
    soItem("si-1", "so-A", "1003", "K", "PC151-01"),
    soItem("si-2", "so-A", "1003", "K", "PC151-01"),
  ]);
  // Poison the loose tier: any read of it is a fall-through, and a fall-through
  // is the bug. Object.create keeps the Set/Map shape the resolver expects.
  const poisoned = {
    ...idx,
    byCode: {
      get() {
        throw new Error("resolver fell through to the loose key on a CONTESTED tight key");
      },
      has() {
        throw new Error("resolver fell through to the loose key on a CONTESTED tight key");
      },
    },
    ambiguousCode: {
      has() {
        throw new Error("resolver fell through to the loose key on a CONTESTED tight key");
      },
    },
  };
  const poById = new Map([["po-1", poSpec("so-A", "1003", "K", "PC151-01")]]);
  const r = m.resolveSoItemId(poisoned, poById, "po-1");
  assert.equal(r.soItemId, null);
  assert.equal(r.outcome, "ambiguous");
});

test("identity is scoped to the sales order: an identical line on ANOTHER SO neither contests nor answers", () => {
  // Same product code, size and fabric on two DIFFERENT sales orders — the
  // everyday case in this book. Dropping soId from the key would make both of
  // these ambiguous and lose two perfectly good links; keying only on code
  // would hand so-A's line to so-B's production order.
  const idx = m.buildSoItemIdentity([
    soItem("si-A", "so-A", "1003", "K", "PC151-01"),
    soItem("si-B", "so-B", "1003", "K", "PC151-01"),
  ]);
  const poById = new Map([
    ["po-A", poSpec("so-A", "1003", "K", "PC151-01")],
    ["po-B", poSpec("so-B", "1003", "K", "PC151-01")],
  ]);
  assert.deepEqual(m.resolveSoItemId(idx, poById, "po-A"), {
    soItemId: "si-A",
    outcome: "exact",
  });
  assert.deepEqual(m.resolveSoItemId(idx, poById, "po-B"), {
    soItemId: "si-B",
    outcome: "exact",
  });
});

test("the three no-answer outcomes are distinguished, not collapsed into one null", () => {
  const idx = m.buildSoItemIdentity([soItem("si-1", "so-A", "1003")]);
  const poById = new Map([
    ["po-noso", poSpec("", "1003")], // a consignment-sourced PO
    ["po-other", poSpec("so-Z", "9999")], // SO exists, no such line
  ]);
  assert.equal(m.resolveSoItemId(idx, poById, null).outcome, "no-po-link");
  assert.equal(m.resolveSoItemId(idx, poById, "").outcome, "no-po-link");
  assert.equal(m.resolveSoItemId(idx, poById, "po-missing").outcome, "po-unknown");
  assert.equal(m.resolveSoItemId(idx, poById, "po-noso").outcome, "po-has-no-so");
  assert.equal(m.resolveSoItemId(idx, poById, "po-other").outcome, "no-so-line");
  // …and every one of them yields null. The reason is for the report; the
  // value is never a guess.
  for (const id of [null, "", "po-missing", "po-noso", "po-other"]) {
    assert.equal(m.resolveSoItemId(idx, poById, id).soItemId, null);
  }
});

test("a blank sales order or product code is SKIPPED, not filed under an empty key", () => {
  // The first draft of this test was BLIND: its fixture gave the three rows
  // three distinct keys, so deleting the skip changed nothing observable and
  // the mutation survived. The danger is not a collision between two blank
  // rows — it is that a blank row ANSWERS. A production order with no product
  // code would key to `so-A||K|F`, match the blank SO line filed under exactly
  // that key, and receive a confident, entirely wrong link.
  const idx = m.buildSoItemIdentity([
    soItem("si-1", "so-A", "1003", "K", "F"),
    { id: "si-blank", salesOrderId: "so-A", productCode: null, sizeCode: "K", fabricCode: "F" },
    { id: "si-noso", salesOrderId: null, productCode: "1003", sizeCode: "K", fabricCode: "F" },
  ]);
  // A PO carrying no product code must get NOTHING, not the blank SO line.
  const blankPo = new Map([["po-blank", poSpec("so-A", "", "K", "F")]]);
  const r = m.resolveSoItemId(idx, blankPo, "po-blank");
  assert.equal(r.soItemId, null, "a blank-code production order must not be handed the blank SO line");
  assert.equal(r.outcome, "no-so-line");
  // The well-formed line next door is unaffected.
  const goodPo = new Map([["po-1", poSpec("so-A", "1003", "K", "F")]]);
  assert.equal(m.resolveSoItemId(idx, goodPo, "po-1").soItemId, "si-1");
  // …and no junk key was created at all.
  assert.equal(idx.byFull.has(m.soItemFullKey("so-A", "", "K", "F")), false);
  assert.equal(idx.byCode.has(m.soItemCodeKey("so-A", "")), false);
});

test("readInvoiceItemSoLink is dual-keyed and treats empty string as absent", () => {
  assert.equal(m.readInvoiceItemSoLink({ so_item_id: "si-1" }), "si-1");
  assert.equal(m.readInvoiceItemSoLink({ soItemId: "si-2" }), "si-2");
  assert.equal(m.readInvoiceItemSoLink({ so_item_id: "" }), null);
  assert.equal(m.readInvoiceItemSoLink(null), null);
});

// ===========================================================================
// Part 2 — structural guards
// ===========================================================================

const SRC_LINK = read("src/api/lib/invoice-so-item-link.ts");
const SRC_DOVALUE = read("src/api/lib/do-value.ts");
const SRC_INVOICES = read("src/api/routes/invoices.ts");
const SRC_DOHELPERS = read("src/api/routes/delivery-orders/_helpers.ts");
const SRC_DOROUTES = read("src/api/routes/delivery-orders.ts");

test("every INSERT INTO invoice_items that carries production_order_id also carries so_item_id", () => {
  // The forward fill is only as complete as its least-updated write path, and
  // this repo's recurring lesson (BUG-CLASSES C1) is that a fix applied to the
  // file in front of the author leaves the structural clone next door carrying
  // the bug. Enumerate the INSERTs from disk instead of trusting a sweep.
  const files = {
    "invoices.ts": SRC_INVOICES,
    "_helpers.ts": SRC_DOHELPERS,
    "delivery-orders.ts": SRC_DOROUTES,
  };
  let checked = 0;
  for (const [name, src] of Object.entries(files)) {
    const inserts = src.match(/INSERT INTO invoice_items \([\s\S]*?\)\s*VALUES/g) ?? [];
    for (const ins of inserts) {
      if (!/production_order_id/.test(ins)) continue; // CN path — no PO link at all
      checked++;
      assert.match(
        ins,
        /so_item_id/,
        `${name}: an invoice_items INSERT carries production_order_id but not so_item_id — ` +
          `that path writes an invoice an SO<->invoice audit cannot see`,
      );
      // The column list and the placeholder count must agree, or the statement
      // 400s at runtime. Counting them is what caught the C8 test's own miss.
      const cols = ins.slice(ins.indexOf("(") + 1, ins.lastIndexOf(")")).split(",").length;
      const placeholders = (src.slice(src.indexOf(ins) + ins.length).match(/^[\s\S]*?\)/)?.[0].match(/\?/g) ?? []).length;
      assert.equal(placeholders, cols, `${name}: column/placeholder count disagree on an invoice_items INSERT`);
    }
  }
  assert.ok(checked >= 5, `expected to check at least 5 PO-linked INSERTs, checked ${checked}`);
});

test("nothing joins production_orders.lineNo to sales_order_items — the counters are different", () => {
  // production-builder.ts binds `poSequence` (a per-PIECE counter) into
  // production_orders.lineNo, while sales_order_items.lineNo is `idx + 1` per
  // LINE. They agree only when every line has quantity 1. A join on lineNo
  // therefore writes wrong links on exactly the multi-quantity orders, and it
  // would look completely reasonable in review.
  for (const [name, src] of Object.entries({
    "invoice-so-item-link.ts": SRC_LINK,
    "do-value.ts": SRC_DOVALUE,
    "invoices.ts": SRC_INVOICES,
    "_helpers.ts": SRC_DOHELPERS,
  })) {
    const stripped = src.replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\*.*$/gm, "");
    assert.doesNotMatch(
      stripped,
      /sales_order_items[\s\S]{0,400}?\blineNo\b\s*=\s*(?:po|pr)/i,
      `${name}: joins an SO line by production-order lineNo — those are different counters`,
    );
  }
  // And the trap is documented where the next person will look.
  assert.match(SRC_LINK, /poSequence/, "the lineNo trap must stay documented in the module");
});

test("the self-apply is memoised as a PROMISE THAT CLEARS ON FAILURE, and it throws", () => {
  // Class C9: a memo that remembers a failed DDL round as done leaves the
  // column unapplied for the life of the isolate, and every later write fails
  // on a missing column with nothing saying why.
  assert.match(SRC_LINK, /memoizeSelfApply/);
  assert.match(SRC_LINK, /runSelfApply/);
  // No swallow-and-continue: the audit column is exactly the one whose silent
  // absence produces a "clean" report.
  const fn = SRC_LINK.slice(SRC_LINK.indexOf("export function ensureInvoiceSoItemLinkColumn"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.doesNotMatch(body, /catch/, "the self-apply must not swallow its own failure");
  assert.match(body, /ADD COLUMN IF NOT EXISTS so_item_id/);
});

test("the column is snake_case and indexed, in BOTH the runtime copy and the migration file", () => {
  // A camelCase column named in route SQL without a rename-map entry silently
  // 400s (HOOKKA-GOTCHAS). And the migration file alone is inert here, so the
  // two must not drift — the file is the record, the runtime copy is the
  // mechanism.
  assert.match(SRC_LINK, /so_item_id/);
  assert.doesNotMatch(SRC_LINK, /ADD COLUMN IF NOT EXISTS soItemId/);
  const mig = read("migrations-postgres/0226_invoice_items_so_item_id.sql");
  assert.match(mig, /ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS so_item_id TEXT/);
  assert.match(mig, /CREATE INDEX IF NOT EXISTS idx_invoice_items_so_item_id/);
  assert.match(SRC_LINK, /CREATE INDEX IF NOT EXISTS idx_invoice_items_so_item_id/);
  // The file must say it is not the mechanism, or someone will ship a column
  // that never reaches prod and verify it against this file.
  assert.match(mig, /INERT|RECORD, NOT THE MECHANISM/i);
});

test("the backfill is DRY-RUN unless ?execute=1 is passed explicitly", () => {
  const ep = SRC_INVOICES.slice(SRC_INVOICES.indexOf('app.post("/backfill-so-item-links"'));
  const body = ep.slice(0, ep.indexOf("\n});"));
  assert.ok(body.length > 0, "backfill-so-item-links endpoint not found");
  assert.match(body, /const execute = c\.req\.query\("execute"\) === "1"/);
  // Opt-IN, never opt-out: the write is guarded by `execute` being true.
  assert.match(body, /if \(execute && statements\.length\)/);
  // It must never write a non-unique link, whatever tier is requested.
  assert.match(body, /res\.outcome === "exact"/);
  // And it must report the breakdown, not one number — the whole finding is
  // that a bare "0 items" concealed a 98.5% blind spot.
  //
  // ⚠ This assertion used to search the whole handler for the WORD. That was
  // blind: `counts` appears six times in the body (the local declaration, the
  // two increments, the linkable sum), so deleting it from the returned
  // payload changed nothing and the mutation survived. Pin the RETURN BLOCK.
  const ret = body.slice(body.indexOf("return c.json({"));
  assert.ok(ret.length > 0, "the endpoint must return a json report");
  for (const k of [
    "counts",
    "valueSen",
    "remainingNullLines",
    "scannedLines",
    "wouldWriteLines",
    "samples",
    "dry",
  ]) {
    assert.match(
      ret,
      new RegExp("^\\s*" + k + ",?$|^\\s*" + k + ":", "m"),
      `the dry-run report must RETURN ${k}, not merely mention it`,
    );
  }
  // `dry` must report the real state, never a hardcoded true.
  assert.match(ret, /dry: !execute/);
});

test("the identity index counts claimants while the PRICE index stays first-one-wins", () => {
  // These two walk the same tiers over the same rows and MUST tie-break
  // oppositely. If someone ever "unifies" them, one of the two behaviours is
  // silently wrong — and the dangerous direction (identity going
  // first-one-wins) is invisible, because it produces links that look fine.
  assert.match(SRC_DOVALUE, /if \(!byFull\.has\(fk\)\) byFull\.set\(fk, up\)/);
  assert.match(SRC_DOVALUE, /soItemIdentity: buildSoItemIdentity\(/);
  assert.doesNotMatch(
    SRC_LINK,
    /if \(!byFull\.has\(fk\)\) byFull\.set\(fk, si\.id\)/,
    "the identity index must not adopt the price index's first-one-wins rule",
  );
  assert.match(SRC_LINK, /ambiguousFull\.add\(fk\)/);
});

test("the SO-line fallback carries an exact link, and the DO path resolves one", () => {
  // Two different mechanisms in the same builder, and both must stay wired:
  // the DO-sourced line resolves via its production order, while the
  // bill-the-SO-lines fallback IS the sales-order line and needs no matching.
  assert.match(SRC_DOHELPERS, /soItemId: resolveSoItemId\(/);
  assert.match(SRC_DOHELPERS, /soItemId: si\.id \?\? null/);
  // The fallback's SELECT must actually fetch the id it stores.
  const sel = SRC_DOHELPERS.slice(SRC_DOHELPERS.indexOf("FROM sales_order_items WHERE salesOrderId IN"));
  assert.match(
    SRC_DOHELPERS.slice(0, SRC_DOHELPERS.indexOf(sel)).slice(-400),
    /SELECT id, productCode/,
    "the SO-line fallback stores si.id but its SELECT does not fetch it",
  );
});

test("the invoice PUT re-resolves the link instead of only carrying the old one", () => {
  // An edit is the one moment the current spec is known. Carrying the prior
  // value forward would leave every legacy line blind forever, which is the
  // state this bug is about.
  assert.match(SRC_INVOICES, /resolveSoItemIdsForPoIds/);
  assert.match(SRC_INVOICES, /soItemIdByPo\.get\(r\.poId \?\? ""\)\?\.soItemId \?\? null/);
  // The self-apply must be awaited before that INSERT, not after.
  const putIdx = SRC_INVOICES.indexOf("const soItemIdByPo = await resolveSoItemIdsForPoIds");
  const ensureIdx = SRC_INVOICES.lastIndexOf("await ensureInvoiceSoItemLinkColumn", putIdx);
  assert.ok(ensureIdx > 0 && ensureIdx < putIdx, "self-apply must be awaited before the PUT resolve");
});

test("the narrow batched resolver loads WHOLE sales orders, not just matching lines", () => {
  // Ambiguity is decided within a sales order. Narrowing the second query by
  // product code would turn "two claimants" into "one" and start writing the
  // exact wrong links this module exists to refuse.
  const fn = SRC_LINK.slice(SRC_LINK.indexOf("export async function resolveSoItemIdsForPoIds"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /FROM sales_order_items\s*\n?\s*WHERE salesOrderId IN/);
  assert.doesNotMatch(body, /productCode IN/, "narrowing by product code would hide contested keys");
});
