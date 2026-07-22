// DRY-RUN PLANNER (read-only) for the divan / leg height surcharge backfill.
//
// Prices every affected line from the LIVE owner config (kv_config
// variants-config.divanHeights / .legHeights) — never the static catalog. That
// is the RM 30 mistake the 2026-07-17 exercise caught on read-back.
//
// Splits the work the way it has to be executed:
//   GROUP A — SO not yet invoiced → fix the SO line, the invoice then bills right
//   GROUP B — already invoiced/shipped → SO line + PUT /api/invoices/:id {priceEdits}
//
// Usage: $env:DATABASE_URL="postgresql://…"; node scripts/plan-height-backfill-2026-07-22.mjs
import postgres from "postgres";
import fs from "node:fs";

let url = process.env.DATABASE_URL;
if (!url) {
  const s = fs.readFileSync(new URL("./audit-wip-both-dbs.mjs", import.meta.url), "utf8");
  const m = s.match(/"(postgresql:\/\/[^"]*vpwdqtsxexpiqxzweivd[^"]*)"/);
  if (m) url = m[1];
}
if (!url) throw new Error("set DATABASE_URL");
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 25 });
const rm = (s) => `RM ${(Number(s || 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}`;

// --- live config -----------------------------------------------------------
const cfgRow = await sql`SELECT value FROM kv_config WHERE key = 'variants-config'`;
const cfg = typeof cfgRow[0].value === "string" ? JSON.parse(cfgRow[0].value) : cfgRow[0].value;
const priceFor = (list, inches) => {
  for (const e of cfg[list] ?? []) {
    const m = String(e.value ?? "").match(/-?\d+(?:\.\d+)?/);
    if (m && Number(m[0]) === Number(inches)) return Number(e.priceSen) || 0;
  }
  return 0;
};
console.log("live config — divan:", (cfg.divanHeights ?? []).map((e) => `${e.value}=${rm(e.priceSen)}`).join("  "));
console.log("live config — leg:  ", (cfg.legHeights ?? []).map((e) => `${e.value}=${rm(e.priceSen)}`).join("  "));

// --- affected lines --------------------------------------------------------
const lines = await sql`
  SELECT so.id AS so_id, so.company_so_id, so.status, so.customer_name, so.is_service_order,
         soi.id AS line_id, soi.line_no, soi.product_code, soi.quantity,
         soi.divan_height_inches, soi.divan_price_sen,
         soi.leg_height_inches, soi.leg_price_sen,
         soi.base_price_sen, soi.special_order_price_sen, soi.unit_price_sen,
         (so.customer_po_image_b64 IS NOT NULL) AS from_scan
    FROM sales_order_items soi
    JOIN sales_orders so ON so.id = soi.sales_order_id
   WHERE so.status <> 'CANCELLED' AND NOT COALESCE(so.is_service_order, false)
   ORDER BY so.company_so_id, soi.line_no`;

const plan = [];
for (const l of lines) {
  const wantDivan = COALESCE0(l.divan_price_sen) === 0 ? priceFor("divanHeights", l.divan_height_inches) : 0;
  const wantLeg = COALESCE0(l.leg_price_sen) === 0 ? priceFor("legHeights", l.leg_height_inches) : 0;
  if (wantDivan === 0 && wantLeg === 0) continue;
  plan.push({ ...l, wantDivan, wantLeg, delta: (wantDivan + wantLeg) * Number(l.quantity || 1) });
}
function COALESCE0(v) { return Number(v || 0); }

const INVOICED = new Set(["INVOICED", "SHIPPED", "DELIVERED", "CLOSED"]);
const groupA = plan.filter((p) => !INVOICED.has(p.status));
const groupB = plan.filter((p) => INVOICED.has(p.status));
const sum = (a) => a.reduce((t, p) => t + p.delta, 0);

console.log(`\n=== GROUP A — not yet invoiced, fix the SO line only (${groupA.length} lines, ${rm(sum(groupA))}) ===`);
for (const p of groupA)
  console.log(
    `  ${p.company_so_id} L${p.line_no} ${String(p.product_code).padEnd(20)} ${p.status.padEnd(14)} ` +
      `divan ${p.divan_height_inches ?? "-"}" +${rm(p.wantDivan)}  leg ${p.leg_height_inches ?? "-"}" +${rm(p.wantLeg)}  ` +
      `x${p.quantity} = +${rm(p.delta)}   unit ${rm(p.unit_price_sen)} → ${rm(Number(p.unit_price_sen) + p.wantDivan + p.wantLeg)}`,
  );

console.log(`\n=== GROUP B — already invoiced/shipped, needs an invoice correction (${groupB.length} lines, ${rm(sum(groupB))}) ===`);
for (const p of groupB) {
  const poId = `pord-${p.so_id}-${String(p.line_no).padStart(2, "0")}`;
  const inv = await sql`
    SELECT i.invoice_no, i.status, i.total_sen, COALESCE(i.paid_amount,0) AS paid,
           ii.id AS item_id, ii.unit_price_sen, ii.base_price_sen, ii.divan_price_sen,
           ii.leg_price_sen, ii.special_order_price_sen, ii.quantity
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
     WHERE ii.production_order_id = ${poId} AND i.status <> 'CANCELLED'`;
  const v = inv[0];
  console.log(
    `  ${p.company_so_id} L${p.line_no} ${String(p.product_code).padEnd(20)} ${p.status.padEnd(10)} +${rm(p.delta)}` +
      (v
        ? `  → ${v.invoice_no} (${v.status}, paid ${rm(v.paid)}) line unit ${rm(v.unit_price_sen)} → ${rm(Number(v.unit_price_sen) + p.wantDivan + p.wantLeg)}`
        : `  → NO invoice line found for ${poId} — needs manual matching`),
  );
}

console.log(`\nTOTAL to recover: ${rm(sum(plan))}  (A ${rm(sum(groupA))} + B ${rm(sum(groupB))})`);
console.log(`Scanned-PO share: ${plan.filter((p) => p.from_scan).length} of ${plan.length} lines`);
await sql.end();
