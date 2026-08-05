// Add supplier_description column to supplier_material_bindings.
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
const sql = postgres(prodUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  await sql`ALTER TABLE supplier_material_bindings ADD COLUMN IF NOT EXISTS supplier_description TEXT`;
  const c = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'supplier_material_bindings' AND column_name = 'supplier_description'`;
  console.log("supplier_description column:", c.length > 0 ? "added" : "missing");
} finally { await sql.end(); }
