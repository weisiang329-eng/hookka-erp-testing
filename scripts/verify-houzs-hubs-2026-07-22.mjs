// Read-back after the 2026-07-22 hub correction: did the 3 unshipped SOs move
// to Houzs PG, did the cascade follow (production_orders.customer_state,
// fg_units.customer_hub, audit row), and are the other 4 still locked?
import postgres from "postgres";
// Connection string comes from the environment — never hardcoded here.
//   PowerShell:  $env:DATABASE_URL="postgresql://…"; node scripts/<this file>
const PROD = process.env.DATABASE_URL;
if (!PROD) throw new Error("set DATABASE_URL to the prod connection string");
const sql = postgres(PROD, { ssl: "require", max: 1, idle_timeout: 15 });

const FIXED = ["SO-2607-010", "SO-2607-087", "SO-2607-108"];
const LOCKED = ["SO-2607-074", "SO-2607-040", "SO-2607-115", "SO-2607-130"];

for (const code of [...FIXED, ...LOCKED]) {
  const so = (await sql`
    SELECT id, company_so_id, customer_po_id, hub_id, hub_name, customer_state, status, updated_at
    FROM sales_orders WHERE company_so_id = ${code}`)[0];
  const po = await sql`SELECT DISTINCT customer_state FROM production_orders WHERE sales_order_id = ${so.id}`;
  const fg = await sql`SELECT customer_hub, COUNT(*)::int n FROM fg_units WHERE so_id = ${so.id} GROUP BY 1`;
  const tag = FIXED.includes(code) ? (so.hub_name === "Houzs PG" ? "OK " : "BAD") : "LOCKED";
  console.log(`${tag} ${code} (${so.customer_po_id}) hub=${so.hub_name} state=${so.customer_state} status=${so.status} updated=${so.updated_at}`);
  console.log(`     production_orders.customer_state=${JSON.stringify(po.map((r) => r.customer_state))} fg_units=${JSON.stringify(fg)}`);
}

console.log("\n--- any of the 3 still not on hub-h2? ---");
const stillWrong = await sql`
  SELECT company_so_id, customer_po_id, hub_name, status FROM sales_orders
  WHERE customer_po_id = ANY(${["PO-009401", "PO-009467", "PO-009529"]}) AND hub_id <> 'hub-h2'`;
console.log(stillWrong.length ? JSON.stringify(stillWrong) : "none — all three now on hub-h2 (Houzs PG)");
await sql.end();
