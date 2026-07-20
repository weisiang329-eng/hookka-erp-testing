import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(
  requiredDatabaseUrl("PROD_DATABASE_URL"),
  { ssl: "require", max: 1, idle_timeout: 5 },
);
try {
  const rows = await sql`
    SELECT id, customer_id, base_model, component_sizes, fabric_tier, prices_by_height, effective_from, created_at
      FROM sofa_combo_rules
     WHERE base_model = '5535'
       AND (customer_id IS NULL OR customer_id IN ('cust-2','cust-f6c80b96'))
     ORDER BY component_sizes, customer_id NULLS FIRST, effective_from DESC
  `;
  console.log(`rows: ${rows.length}\n`);
  for (const r of rows) {
    const cs = typeof r.component_sizes === "string" ? r.component_sizes : JSON.stringify(r.component_sizes);
    const p = typeof r.prices_by_height === "string" ? JSON.parse(r.prices_by_height) : r.prices_by_height;
    const pStr = Object.entries(p).map(([h,v])=>`${h}=${(v/100).toFixed(2)}`).join(" ");
    console.log(`${r.id}\n  cust=${r.customer_id ?? "MASTER"}  tier=${r.fabric_tier}  eff=${r.effective_from}`);
    console.log(`  comp=${cs}`);
    console.log(`  prices=${pStr}\n`);
  }
} finally { await sql.end(); }
