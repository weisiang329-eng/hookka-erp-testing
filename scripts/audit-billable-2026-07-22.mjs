// Read-only: what is actually billable / collectable right now.
//
// Usage: $env:DATABASE_URL="postgresql://…"; node scripts/audit-billable-2026-07-22.mjs
import postgres from "postgres";
import fs from "node:fs";

let url = process.env.DATABASE_URL;
if (!url) {
  const s = fs.readFileSync(new URL("./audit-wip-both-dbs.mjs", import.meta.url), "utf8");
  const m = s.match(/"(postgresql:\/\/[^"]*vpwdqtsxexpiqxzweivd[^"]*)"/);
  if (m) url = m[1];
}
if (!url) throw new Error("set DATABASE_URL");
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 20 });
const rm = (s) => `RM ${(Number(s || 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}`;

console.log("=== A. shipped but NOT yet invoiced — bill these ===");
const un = await sql`
  SELECT d.do_no, d.customer_name, d.hub_name, d.status, d.delivery_date, d.id
    FROM delivery_orders d LEFT JOIN invoices i ON i.delivery_order_id = d.id
   WHERE d.status IN ('LOADED', 'IN_TRANSIT', 'DELIVERED') AND i.id IS NULL
   ORDER BY d.delivery_date, d.do_no`;
let grand = 0;
for (const d of un) {
  // Value each DO line from its SO line (invoice is generated the same way).
  const rows = await sql`
    SELECT COALESCE(SUM(soi.unit_price_sen * di.quantity), 0)::bigint AS val,
           COUNT(*)::int AS lines,
           COUNT(*) FILTER (WHERE soi.id IS NULL)::int AS unpriced
      FROM delivery_order_items di
      LEFT JOIN production_orders po ON po.id = di.production_order_id
      LEFT JOIN sales_order_items soi
        ON soi.sales_order_id = po.sales_order_id
       AND soi.line_no = NULLIF(RIGHT(di.production_order_id, 2), '')::int
     WHERE di.delivery_order_id = ${d.id}`;
  const v = Number(rows[0].val);
  grand += v;
  console.log(
    `  ${d.do_no}  ${d.customer_name} / ${d.hub_name}  ${d.status}  ${String(d.delivery_date).slice(0, 10)}  ` +
      `${rows[0].lines} lines  ≈ ${rm(v)}${rows[0].unpriced ? `  (${rows[0].unpriced} line(s) unpriced — service/repair)` : ""}`,
  );
}
console.log(`  TOTAL not yet invoiced ≈ ${rm(grand)} across ${un.length} DOs`);

console.log("\n=== B. issued invoices still owing ===");
let owed = 0;
for (const r of await sql`
  SELECT customer_name, status, COUNT(*)::int n,
         SUM(total_sen)::bigint AS billed,
         SUM(COALESCE(paid_amount, 0))::bigint AS paid
    FROM invoices
   WHERE status NOT IN ('CANCELLED', 'PAID')
   GROUP BY 1, 2 ORDER BY 1, 2`) {
  const bal = Number(r.billed) - Number(r.paid);
  owed += bal;
  console.log(`  ${r.customer_name} ${r.status}: ${r.n} inv, billed ${rm(r.billed)}, paid ${rm(r.paid)}, OWING ${rm(bal)}`);
}
console.log(`  TOTAL OWING ${rm(owed)}`);

console.log("\n=== C. oldest unpaid invoices (chase these first) ===");
for (const r of await sql`
  SELECT invoice_no, customer_name, invoice_date, due_date, total_sen,
         COALESCE(paid_amount, 0) AS paid, status
    FROM invoices
   WHERE status NOT IN ('CANCELLED', 'PAID') AND total_sen > COALESCE(paid_amount, 0)
   ORDER BY invoice_date LIMIT 15`)
  console.log(
    `  ${r.invoice_no}  ${r.customer_name}  issued ${String(r.invoice_date).slice(0, 10)}  due ${String(r.due_date).slice(0, 10)}  ` +
      `owing ${rm(Number(r.total_sen) - Number(r.paid))}`,
  );
await sql.end();
