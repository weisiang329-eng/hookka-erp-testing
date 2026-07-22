// Read-only: can a delivery order actually MIX two hubs, or is only its header
// label wrong? For every DO, compare the hub on the DO header against the set
// of hubs carried by the sales orders its line items belong to.
//
// Usage: $env:DATABASE_URL="postgresql://…"; node scripts/audit-do-hub-composition-2026-07-22.mjs
import postgres from "postgres";
import fs from "node:fs";

// Fall back to the connection string already committed in the older one-shot
// scripts so this runs without re-entering it. Never printed.
let url = process.env.DATABASE_URL;
if (!url) {
  const s = fs.readFileSync(new URL("./audit-wip-both-dbs.mjs", import.meta.url), "utf8");
  const m = s.match(/"(postgresql:\/\/[^"]*vpwdqtsxexpiqxzweivd[^"]*)"/);
  if (m) url = m[1];
}
if (!url) throw new Error("set DATABASE_URL");
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 15 });

// Line-level hub set per DO, via delivery_order_items.sales_order_no → SO.
const rows = await sql`
  SELECT d.do_no,
         d.hub_id   AS header_hub_id,
         d.hub_name AS header_hub_name,
         d.status,
         d.created_at,
         COUNT(DISTINCT so.hub_id)::int          AS distinct_line_hubs,
         ARRAY_AGG(DISTINCT so.hub_name)         AS line_hubs,
         COUNT(DISTINCT so.customer_id)::int     AS distinct_customers
    FROM delivery_orders d
    JOIN delivery_order_items i ON i.delivery_order_id = d.id
    LEFT JOIN sales_orders so ON so.company_so_id = i.sales_order_no
   WHERE so.id IS NOT NULL
   GROUP BY d.do_no, d.hub_id, d.hub_name, d.status, d.created_at
   ORDER BY d.created_at`;

const mixed = rows.filter((r) => r.distinct_line_hubs > 1);
const mislabelled = rows.filter(
  (r) => r.distinct_line_hubs === 1 && r.header_hub_id && r.header_hub_name !== r.line_hubs[0],
);
const multiCustomer = rows.filter((r) => r.distinct_customers > 1);

console.log(`DOs with resolvable lines: ${rows.length}`);
console.log(`  TRUE MIXED-HUB (guard breach): ${mixed.length}`);
console.log(`  header label != the one real hub: ${mislabelled.length}`);
console.log(`  more than one customer: ${multiCustomer.length}\n`);

const dump = (label, arr) => {
  console.log(`--- ${label} (${arr.length}) ---`);
  for (const r of arr)
    console.log(
      `  ${r.do_no}  header=${r.header_hub_name}  lines=${JSON.stringify(r.line_hubs)}  ${r.status}  ${String(r.created_at).slice(0, 10)}`,
    );
  console.log();
};
dump("TRUE MIXED-HUB DOs", mixed);
dump("MISLABELLED DOs (lines all one hub, header says another)", mislabelled);
dump("MULTI-CUSTOMER DOs", multiCustomer);
await sql.end();
