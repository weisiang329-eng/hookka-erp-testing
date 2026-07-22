// GROUP A backfill — price the divan / leg height surcharge onto SO lines that
// have NOT been invoiced yet, so the invoice bills right when it is raised.
//
// Prices from the LIVE owner config (kv_config variants-config), never the
// static catalog — that is the RM 30 mistake the 2026-07-17 exercise caught.
// All five customer lists were verified identical to master before running.
//
// Only touches sales_order_items.{divanPriceSen, legPriceSen, unitPriceSen,
// lineTotalSen} and the parent sales_orders.{subtotalSen, totalSen}, exactly
// the way the create path computes them:
//     unit  = base + divan + leg + special
//     line  = max(0, unit x qty - discount)
//     order = SUM(line)              (total = subtotal; no tax)
// Nothing invoiced is in scope, so nothing here touches the GL.
//
//   node scripts/backfill-height-surcharge-2026-07-22.mjs            # dry run
//   node scripts/backfill-height-surcharge-2026-07-22.mjs --execute
import postgres from "postgres";
import fs from "node:fs";

let url = process.env.DATABASE_URL;
if (!url) {
  const s = fs.readFileSync(new URL("./audit-wip-both-dbs.mjs", import.meta.url), "utf8");
  const m = s.match(/"(postgresql:\/\/[^"]*vpwdqtsxexpiqxzweivd[^"]*)"/);
  if (m) url = m[1];
}
if (!url) throw new Error("set DATABASE_URL");
const EXECUTE = process.argv.includes("--execute");
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

const INVOICED = ["INVOICED", "SHIPPED", "DELIVERED", "CLOSED", "CANCELLED"];
const lines = await sql`
  SELECT so.id AS so_id, so.company_so_id, so.status, so.customer_name,
         soi.id AS line_id, soi.line_no, soi.product_code, soi.quantity,
         soi.divan_height_inches, soi.divan_price_sen,
         soi.leg_height_inches, soi.leg_price_sen,
         soi.base_price_sen, soi.special_order_price_sen,
         soi.unit_price_sen, soi.line_total_sen, COALESCE(soi.discount_sen,0) AS discount_sen
    FROM sales_order_items soi
    JOIN sales_orders so ON so.id = soi.sales_order_id
   WHERE NOT (so.status = ANY(${INVOICED}))
     AND NOT COALESCE(so.is_service_order, false)
   ORDER BY so.company_so_id, soi.line_no`;

const plan = [];
for (const l of lines) {
  const wantDivan = Number(l.divan_price_sen || 0) === 0 ? priceFor("divanHeights", l.divan_height_inches) : Number(l.divan_price_sen);
  const wantLeg = Number(l.leg_price_sen || 0) === 0 ? priceFor("legHeights", l.leg_height_inches) : Number(l.leg_price_sen);
  const addDivan = wantDivan - Number(l.divan_price_sen || 0);
  const addLeg = wantLeg - Number(l.leg_price_sen || 0);
  if (addDivan <= 0 && addLeg <= 0) continue;
  const qty = Number(l.quantity || 1);
  const newUnit = Number(l.base_price_sen || 0) + wantDivan + wantLeg + Number(l.special_order_price_sen || 0);
  const newLineTotal = Math.max(0, newUnit * qty - Number(l.discount_sen || 0));
  plan.push({
    ...l, wantDivan, wantLeg, newUnit, newLineTotal,
    delta: newLineTotal - Number(l.line_total_sen || 0),
  });
}
const total = plan.reduce((t, p) => t + p.delta, 0);
console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} — ${plan.length} lines across ${new Set(plan.map((p) => p.so_id)).size} SOs, +${rm(total)}\n`);

// Sanity: the stored unit must equal its own components before we touch it.
const inconsistent = plan.filter(
  (p) => Number(p.unit_price_sen) !==
    Number(p.base_price_sen || 0) + Number(p.divan_price_sen || 0) + Number(p.leg_price_sen || 0) + Number(p.special_order_price_sen || 0),
);
if (inconsistent.length) {
  console.log(`REFUSING: ${inconsistent.length} line(s) have a unit price that is not the sum of their components — fix those by hand first:`);
  for (const p of inconsistent) console.log(`   ${p.company_so_id} L${p.line_no} unit ${rm(p.unit_price_sen)} vs parts ${rm(Number(p.base_price_sen||0)+Number(p.divan_price_sen||0)+Number(p.leg_price_sen||0)+Number(p.special_order_price_sen||0))}`);
  await sql.end();
  process.exit(1);
}

if (!EXECUTE) {
  for (const p of plan.slice(0, 12))
    console.log(`  ${p.company_so_id} L${p.line_no} ${String(p.product_code).padEnd(18)} unit ${rm(p.unit_price_sen)} → ${rm(p.newUnit)}  line ${rm(p.line_total_sen)} → ${rm(p.newLineTotal)}`);
  console.log(`  … ${Math.max(0, plan.length - 12)} more. Re-run with --execute to write.`);
  await sql.end();
  process.exit(0);
}

// Restore point before any write.
const stamp = "2026-07-22";
const restore = `scripts/_restore-height-backfill-${stamp}.json`;
fs.writeFileSync(restore, JSON.stringify(plan.map((p) => ({
  lineId: p.line_id, soId: p.so_id, companySOId: p.company_so_id, lineNo: p.line_no,
  before: { divanPriceSen: Number(p.divan_price_sen || 0), legPriceSen: Number(p.leg_price_sen || 0), unitPriceSen: Number(p.unit_price_sen), lineTotalSen: Number(p.line_total_sen) },
  after: { divanPriceSen: p.wantDivan, legPriceSen: p.wantLeg, unitPriceSen: p.newUnit, lineTotalSen: p.newLineTotal },
})), null, 1));
console.log(`restore point written: ${restore}`);

const soIds = [...new Set(plan.map((p) => p.so_id))];
await sql.begin(async (tx) => {
  for (const p of plan) {
    await tx`
      UPDATE sales_order_items
         SET divan_price_sen = ${p.wantDivan},
             leg_price_sen   = ${p.wantLeg},
             unit_price_sen  = ${p.newUnit},
             line_total_sen  = ${p.newLineTotal}
       WHERE id = ${p.line_id}`;
  }
  for (const soId of soIds) {
    await tx`
      UPDATE sales_orders so
         SET subtotal_sen = sub.t, total_sen = sub.t, updated_at = ${new Date().toISOString()}
        FROM (SELECT COALESCE(SUM(line_total_sen),0) AS t FROM sales_order_items WHERE sales_order_id = ${soId}) sub
       WHERE so.id = ${soId}`;
  }
});
console.log(`wrote ${plan.length} lines, re-summed ${soIds.length} SOs`);

// --- read-back ------------------------------------------------------------
const bad = [];
for (const p of plan) {
  const r = (await sql`SELECT divan_price_sen d, leg_price_sen l, unit_price_sen u, line_total_sen t FROM sales_order_items WHERE id = ${p.line_id}`)[0];
  if (Number(r.d) !== p.wantDivan || Number(r.l) !== p.wantLeg || Number(r.u) !== p.newUnit || Number(r.t) !== p.newLineTotal)
    bad.push({ line: `${p.company_so_id} L${p.line_no}`, got: r, want: { d: p.wantDivan, l: p.wantLeg, u: p.newUnit, t: p.newLineTotal } });
}
const drift = await sql`
  SELECT so.company_so_id, so.total_sen, sub.t AS want
    FROM sales_orders so
    JOIN (SELECT sales_order_id, SUM(line_total_sen) t FROM sales_order_items GROUP BY 1) sub ON sub.sales_order_id = so.id
   WHERE so.id = ANY(${soIds}) AND so.total_sen <> sub.t`;
console.log(`READ-BACK: ${bad.length} line mismatches, ${drift.length} SO totals out of step`);
for (const b of bad.slice(0, 10)) console.log("  MISMATCH " + JSON.stringify(b));
for (const d of drift.slice(0, 10)) console.log("  DRIFT " + JSON.stringify(d));
await sql.end();
