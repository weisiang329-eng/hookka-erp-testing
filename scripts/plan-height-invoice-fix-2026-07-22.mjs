// GROUP B planner (read-only): the 23 height lines that already shipped, and
// exactly which invoice line each one has to be corrected on.
//
// Matching, in the order it is attempted — the 2026-07-17 DO-judgment method:
//   1. invoice_items.production_order_id = pord-<soId>-<NN>   (direct, newer rows)
//   2. otherwise: the SO line's DO line carries that production_order_id, every
//      invoice carries ONE delivery_order_id, and invoice items are 1:1 with
//      their DO's items in the same order — so DO position gives the invoice
//      line deterministically. The product code must also agree, or it is not
//      reported as matched (duplicate SKUs on consolidated invoices are exactly
//      what broke naive SKU matching last time).
//
// Anything that survives neither route is printed as needsManual — never guessed.
//
// Usage: $env:DATABASE_URL="postgresql://…"; node scripts/plan-height-invoice-fix-2026-07-22.mjs
import postgres from "postgres";
import fs from "node:fs";

let url = process.env.DATABASE_URL;
if (!url) {
  const s = fs.readFileSync(new URL("./audit-wip-both-dbs.mjs", import.meta.url), "utf8");
  const m = s.match(/"(postgresql:\/\/[^"]*vpwdqtsxexpiqxzweivd[^"]*)"/);
  if (m) url = m[1];
}
if (!url) throw new Error("set DATABASE_URL");
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 30 });
const rm = (s) => `RM ${(Number(s || 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}`;

const cfgRow = await sql`SELECT value FROM kv_config WHERE key = 'variants-config'`;
const cfg = typeof cfgRow[0].value === "string" ? JSON.parse(cfgRow[0].value) : cfgRow[0].value;
const priceFor = (list, inches) => {
  for (const e of cfg[list] ?? []) {
    const m = String(e.value ?? "").match(/-?\d+(?:\.\d+)?/);
    if (m && Number(m[0]) === Number(inches)) return Number(e.priceSen) || 0;
  }
  return 0;
};

const lines = await sql`
  SELECT so.id AS so_id, so.company_so_id, so.status, so.customer_name,
         soi.line_no, soi.product_code, soi.quantity,
         soi.divan_height_inches, soi.divan_price_sen,
         soi.leg_height_inches, soi.leg_price_sen,
         soi.base_price_sen, soi.special_order_price_sen, soi.unit_price_sen
    FROM sales_order_items soi JOIN sales_orders so ON so.id = soi.sales_order_id
   WHERE so.status IN ('INVOICED','SHIPPED','DELIVERED','CLOSED')
     AND NOT COALESCE(so.is_service_order, false)
   ORDER BY so.company_so_id, soi.line_no`;

const matched = [], needsManual = [];
for (const l of lines) {
  const wantDivan = Number(l.divan_price_sen || 0) === 0 ? priceFor("divanHeights", l.divan_height_inches) : Number(l.divan_price_sen);
  const wantLeg = Number(l.leg_price_sen || 0) === 0 ? priceFor("legHeights", l.leg_height_inches) : Number(l.leg_price_sen);
  const add = (wantDivan - Number(l.divan_price_sen || 0)) + (wantLeg - Number(l.leg_price_sen || 0));
  if (add <= 0) continue;
  const poId = `pord-${l.so_id}-${String(l.line_no).padStart(2, "0")}`;
  const rec = { ...l, wantDivan, wantLeg, add, poId, perUnitAdd: add };

  // route 1 — the invoice line carries the production order id
  let hit = (await sql`
    SELECT i.invoice_no, i.id AS invoice_id, i.status, i.total_sen, COALESCE(i.paid_amount,0) AS paid,
           ii.id AS item_id, ii.product_code, ii.quantity, ii.unit_price_sen,
           ii.base_price_sen, ii.divan_price_sen, ii.leg_price_sen, ii.special_order_price_sen
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
     WHERE ii.production_order_id = ${poId} AND i.status <> 'CANCELLED'`)[0];
  let route = hit ? "poId" : null;

  // route 2 — the DO says WHICH invoice; identity within it comes from the
  // SKU triple (code + size + fabric), not from row order. Ordering by `id`
  // is meaningless here: ids are random strings, so "same position" was never
  // a real correspondence. Only an UNAMBIGUOUS single candidate is accepted.
  if (!hit) {
    const doLine = (await sql`
      SELECT di.delivery_order_id, di.id AS do_item_id, d.do_no
        FROM delivery_order_items di JOIN delivery_orders d ON d.id = di.delivery_order_id
       WHERE di.production_order_id = ${poId}`)[0];
    if (doLine) {
      const inv = (await sql`SELECT id, invoice_no, status, total_sen, COALESCE(paid_amount,0) AS paid FROM invoices WHERE delivery_order_id = ${doLine.delivery_order_id} AND status <> 'CANCELLED'`)[0];
      if (inv) {
        const soLine = (await sql`SELECT size_label, fabric_code FROM sales_order_items WHERE sales_order_id = ${l.so_id} AND line_no = ${l.line_no}`)[0];
        const cands = await sql`
          SELECT id, product_code, size_label, fabric_code, quantity, unit_price_sen,
                 base_price_sen, divan_price_sen, leg_price_sen, special_order_price_sen
            FROM invoice_items
           WHERE invoice_id = ${inv.id} AND product_code = ${l.product_code}`;
        const narrowed = cands.length > 1 && soLine
          ? cands.filter((x) => (x.fabric_code ?? "") === (soLine.fabric_code ?? "") &&
                                (x.size_label ?? "") === (soLine.size_label ?? ""))
          : cands;
        if (narrowed.length === 1) {
          const cand = narrowed[0];
          hit = { invoice_no: inv.invoice_no, invoice_id: inv.id, status: inv.status, total_sen: inv.total_sen, paid: inv.paid, item_id: cand.id, ...cand };
          route = `DO ${doLine.do_no} → ${inv.invoice_no}, unique SKU match`;
        } else {
          rec.why = narrowed.length === 0
            ? `${inv.invoice_no} (via ${doLine.do_no}) has no line for ${l.product_code}`
            : `${inv.invoice_no} (via ${doLine.do_no}) has ${narrowed.length} identical ${l.product_code} lines — ambiguous`;
        }
      } else rec.why = `DO ${doLine.do_no} has no live invoice`;
    } else rec.why = "no DO line carries this production order id";
  }

  if (hit) matched.push({ ...rec, inv: hit, route });
  else needsManual.push(rec);
}

console.log(`GROUP B: ${matched.length + needsManual.length} lines owed, ${matched.length} matched to an invoice line, ${needsManual.length} need manual judgement\n`);
let sum = 0;
console.log("=== MATCHED — ready to correct ===");
for (const m of matched) {
  const qty = Number(m.inv.quantity || 1);
  const newUnit = Number(m.inv.unit_price_sen) + m.perUnitAdd;
  sum += m.perUnitAdd * qty;
  console.log(
    `  ${m.company_so_id} L${m.line_no} ${String(m.product_code).padEnd(18)} +${rm(m.perUnitAdd)}/unit x${qty}\n` +
      `      → ${m.inv.invoice_no} (${m.inv.status}, paid ${rm(m.inv.paid)}) item ${m.inv.item_id}\n` +
      `        unit ${rm(m.inv.unit_price_sen)} → ${rm(newUnit)}   [base ${rm(m.inv.base_price_sen)} divan ${rm(m.inv.divan_price_sen)} leg ${rm(m.inv.leg_price_sen)} special ${rm(m.inv.special_order_price_sen)}]  via ${m.route}`,
  );
}
console.log(`  subtotal to add: ${rm(sum)}`);

console.log("\n=== NEEDS MANUAL JUDGEMENT — not guessed ===");
for (const n of needsManual)
  console.log(`  ${n.company_so_id} L${n.line_no} ${String(n.product_code).padEnd(18)} owed ${rm(n.add)} — ${n.why}`);
await sql.end();
