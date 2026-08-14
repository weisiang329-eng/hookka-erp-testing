// ---------------------------------------------------------------------------
// check-first-one-wins-blast-radius.mjs — READ-ONLY. Writes nothing.
//
// BUG-2026-08-13-144 … -147. How many rows the four first-one-wins guesses
// could actually have touched is UNMEASURED — the branch that fixed them was
// developed with no database credential. This script is that measurement, for
// whoever has the credential to run it. Do NOT quote a number for any of these
// sections without running it.
//
//   HOOKKA_PROD_DB_URL='...' \
//     node --import tsx/esm scripts/check-first-one-wins-blast-radius.mjs
//
// (`--import tsx/esm` is required: section 5 imports `deriveBarcodeToken` from
// the TS source rather than re-implementing the hash. A second copy of that
// formula would drift, and then this script would measure a token space the
// application does not use — docs/BUG-CLASSES.md C4.)
//
// WHAT IT COUNTS, section by section — each mirrors the exact condition under
// which the OLD code guessed:
//
//  1  -144a  MULTI-ORDER RECEIPTS WITH AN UNOWNED LINE.  A GRN whose lines name
//            two or more `po_id`s AND which has at least one line naming none.
//            Those lines were priced against `pos[0]` — an arbitrary order —
//            at their own `poItemIndex`. THE MONEY EXPOSURE.
//
//  2  -144b  RECEIPTS WHOSE HEADER ORDER IS NOT A LINE ORDER.  `grns.poId` not
//            in the set its lines draw on, so `pos.find(p => p.id === grn.poId)`
//            missed on every one of them and `pos[0]` decided the header.
//
//  3  -144c  POSITIONAL LINES ON A REORDERED PURCHASE ORDER.  Lines with no
//            `po_item_id` (so the index is load-bearing) whose order has a
//            `line_no` sequence that DISAGREES with `id` order. This file read
//            the index against `ORDER BY id`; `grn.ts` reads it against
//            `line_no NULLS LAST, id`. Where they disagree, the receipt drew
//            stock from one PO line and was priced against another.
//
//  4  -144d  PERSISTED MATCH ROWS AT RISK.  `three_way_matches` rows whose GRN
//            appears in section 1, 2 or 3 — i.e. verdicts that were computed
//            through a guess. Broken out by `matchStatus`: a FULL_MATCH here is
//            the expensive shape, because it says "checked, all fine".
//
//  5  -146   BARCODE-TOKEN COLLISIONS.  `deriveBarcodeToken` folds the job-card
//            id to 8 digits. Re-derived here over EVERY job card, grouped by
//            department: any group of 2+ ids sharing a token is a pair the old
//            `.find` could resolve to the wrong card.
//
//  6  -147   PIECE STICKERS PAST THE END OF THEIR CARD.  Job cards whose
//            `wipQty` is now SMALLER than their highest `piece_pics.pieceNo` —
//            a sticker printed for a piece the card no longer has. A scan of
//            one used to complete piece 1 instead.
//
// Nothing here is a repair plan. It is a count, so the next session can say a
// measured number instead of a plausible one.
// ---------------------------------------------------------------------------
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
import { deriveBarcodeToken } from "../src/lib/job-card-id.ts";

const sql = postgres(prodUrl(), { ssl: "require", max: 1 });

const h = (s) => console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`);

try {
  // ═══ 1 + 2 + 3 — the three-way-match guesses ═════════════════════════════
  //
  // One read of the receipt lines; the classification is done here rather than
  // in SQL so the rule is visibly the same one `resolveGrnPoLine` applies.
  const grnLines = await sql`
    SELECT g.id            AS grn_id,
           g."grnNumber"   AS grn_no,
           g."poId"        AS header_po,
           gi.id           AS line_id,
           gi.po_id        AS line_po,
           gi.po_item_id   AS line_po_item,
           gi."poItemIndex" AS idx
      FROM grns g
      JOIN grn_items gi ON gi."grnId" = g.id
  `;

  const byGrn = new Map();
  for (const r of grnLines) {
    let g = byGrn.get(r.grn_id);
    if (!g) {
      g = { grnNo: r.grn_no, headerPo: r.header_po, linePos: new Set(), lines: [] };
      byGrn.set(r.grn_id, g);
    }
    const lp = (r.line_po ?? "").trim();
    if (lp) g.linePos.add(lp);
    g.lines.push({ id: r.line_id, po: lp, poItem: (r.line_po_item ?? "").trim(), idx: r.idx });
  }

  const multiUnowned = [];
  const headerNotALineOrder = [];
  for (const [grnId, g] of byGrn) {
    const orders = [...g.linePos];
    if (orders.length > 1) {
      const unowned = g.lines.filter((l) => !l.po && !l.poItem);
      if (unowned.length > 0) {
        multiUnowned.push({ grnId, grnNo: g.grnNo, orders: orders.length, lines: unowned.length });
      }
    }
    if (orders.length > 0 && g.headerPo && !g.linePos.has(String(g.headerPo).trim())) {
      headerNotALineOrder.push({ grnId, grnNo: g.grnNo, headerPo: g.headerPo, orders: orders.length });
    }
  }

  h("1  -144a  multi-order receipts with a line naming no order (MONEY)");
  console.log(`receipts affected : ${multiUnowned.length}`);
  console.log(`lines mispriced   : ${multiUnowned.reduce((s, x) => s + x.lines, 0)}`);
  for (const x of multiUnowned.slice(0, 40)) {
    console.log(`  ${x.grnNo}  ${x.orders} orders, ${x.lines} unowned line(s)`);
  }
  if (multiUnowned.length > 40) console.log(`  … and ${multiUnowned.length - 40} more`);

  h("2  -144b  receipts whose header order is not among its line orders");
  console.log(`receipts affected : ${headerNotALineOrder.length}`);
  for (const x of headerNotALineOrder.slice(0, 40)) {
    console.log(`  ${x.grnNo}  header ${x.headerPo} not in its ${x.orders} line order(s)`);
  }
  if (headerNotALineOrder.length > 40) console.log(`  … and ${headerNotALineOrder.length - 40} more`);

  // ── 3 — orders whose paper order disagrees with id order ─────────────────
  const poItems = await sql`
    SELECT "purchaseOrderId" AS po, id, line_no
      FROM purchase_order_items
     ORDER BY "purchaseOrderId", id
  `;
  const byPo = new Map();
  for (const r of poItems) {
    const a = byPo.get(r.po) ?? [];
    a.push(r);
    byPo.set(r.po, a);
  }
  const reordered = new Set();
  for (const [po, rows] of byPo) {
    // rows are in `id` order; PO_ITEMS_ORDER is `line_no NULLS LAST, id`.
    const paper = [...rows].sort((a, b) => {
      const an = a.line_no, bn = b.line_no;
      if (an == null && bn == null) return String(a.id).localeCompare(String(b.id));
      if (an == null) return 1;
      if (bn == null) return -1;
      if (an !== bn) return an - bn;
      return String(a.id).localeCompare(String(b.id));
    });
    if (paper.some((r, i) => r.id !== rows[i].id)) reordered.add(po);
  }
  let positionalOnReordered = 0;
  const positionalGrns = new Set();
  for (const [grnId, g] of byGrn) {
    for (const l of g.lines) {
      if (l.poItem) continue; // identity join — the order does not matter
      const owner = l.po || (g.linePos.size === 1 ? [...g.linePos][0] : g.headerPo);
      if (owner && reordered.has(String(owner).trim())) {
        positionalOnReordered++;
        positionalGrns.add(g.grnNo ?? grnId);
      }
    }
  }
  h("3  -144c  positional receipt lines whose order was REORDERED");
  console.log(`purchase orders whose line_no order != id order : ${reordered.size}`);
  console.log(`receipt lines relying on the position there     : ${positionalOnReordered}`);
  console.log(`receipts involved                               : ${positionalGrns.size}`);
  for (const n of [...positionalGrns].slice(0, 40)) console.log(`  ${n}`);

  // ── 4 — persisted verdicts computed through a guess ──────────────────────
  const suspectGrns = new Set([
    ...multiUnowned.map((x) => x.grnId),
    ...headerNotALineOrder.map((x) => x.grnId),
  ]);
  const twm = await sql`
    SELECT id, "grnId" AS grn_id, "matchStatus" AS status, "grnNumber" AS grn_no,
           "poNumber" AS po_no, variance, "variancePercent" AS pct
      FROM three_way_matches
  `;
  const at_risk = twm.filter((r) => suspectGrns.has(r.grn_id));
  const byStatus = new Map();
  for (const r of at_risk) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  h("4  -144d  persisted match verdicts computed through a guess");
  console.log(`three_way_matches rows total : ${twm.length}`);
  console.log(`rows over a suspect receipt  : ${at_risk.length}`);
  for (const [s, n] of byStatus) console.log(`  ${s.padEnd(16)} ${n}`);
  const fullMatches = at_risk.filter((r) => r.status === "FULL_MATCH");
  if (fullMatches.length) {
    console.log(`\n  ⚠ ${fullMatches.length} FULL_MATCH row(s) over a guessed price — each says`);
    console.log(`    "checked, all fine" about a comparison that did not happen:`);
    for (const r of fullMatches.slice(0, 40)) {
      console.log(`      ${r.grn_no} / ${r.po_no}  variance ${r.variance} (${r.pct}%)`);
    }
  }

  // ═══ 5 — barcode-token collisions ════════════════════════════════════════
  const jcs = await sql`
    SELECT id, "departmentCode" AS dept FROM job_cards
  `;
  const tokens = new Map(); // `${dept}|${token}` → ids
  for (const j of jcs) {
    const dept = j.dept ?? "";
    const t = deriveBarcodeToken(j.id, dept);
    const k = `${dept}|${t}`;
    const a = tokens.get(k) ?? [];
    a.push(j.id);
    tokens.set(k, a);
  }
  const collisions = [...tokens.entries()].filter(([, ids]) => ids.length > 1);
  h("5  -146  barcode tokens claimed by more than one job card");
  console.log(`job cards scanned : ${jcs.length}`);
  console.log(`colliding tokens  : ${collisions.length}`);
  console.log(`cards involved    : ${collisions.reduce((s, [, ids]) => s + ids.length, 0)}`);
  for (const [k, ids] of collisions.slice(0, 40)) {
    console.log(`  ${k}  →  ${ids.join(", ")}`);
  }
  if (collisions.length === 0) {
    console.log(`  (none today — the refusal is still required: the population grows`);
    console.log(`   with every job card, and the SELECT has no status filter)`);
  }

  // ═══ 6 — piece stickers past the end of their card ═══════════════════════
  const shrunk = await sql`
    SELECT jc.id, jc."wipQty" AS wip_qty, MAX(pp."pieceNo") AS max_piece,
           COUNT(pp.id) AS slots
      FROM job_cards jc
      JOIN piece_pics pp ON pp."jobCardId" = jc.id
     GROUP BY jc.id, jc."wipQty"
    HAVING MAX(pp."pieceNo") > GREATEST(COALESCE(jc."wipQty", 1), 1)
  `;
  h("6  -147  job cards whose piece count SHRANK below a printed sticker");
  console.log(`cards affected : ${shrunk.length}`);
  for (const r of shrunk.slice(0, 40)) {
    console.log(`  ${r.id}  wipQty ${r.wip_qty} but ${r.slots} slot(s), highest piece ${r.max_piece}`);
  }

  console.log(
    `\nEvery number above is MEASURED against this database at ${new Date().toISOString()}.\n` +
      `Sections 1 and 4 are the money ones. Section 4's FULL_MATCH rows are the\n` +
      `only ones that actively assert correctness, so start there.\n`,
  );
} finally {
  await sql.end();
}
