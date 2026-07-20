import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// Read-only audit — count rows in sales_order_items / consignment_order_items
// / production_orders whose fabricCode is non-empty but doesn't exist in
// raw_materials with a fabric itemGroup. Surfaces the data we'd need to clean
// before turning the validateFabricCodes gate on for stock PO creation
// (commit 7c30c9c) without blocking operators.
//
// Usage: node scripts/audit-dirty-fabriccode-2026-05-09.mjs
import postgres from "postgres";

const url =
  requiredDatabaseUrl("PROD_DATABASE_URL");

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

const FABRIC_GROUPS = ["B.M-FABR", "S-FABR", "S.M-FABR", "LINING", "WEBBING"];

try {
  console.log("=== Canonical fabric catalog size (raw_materials) ===");
  const cat = await sql`
    SELECT COUNT(*)::int AS n
    FROM raw_materials
    WHERE item_code IS NOT NULL
      AND item_group = ANY(${FABRIC_GROUPS});
  `;
  console.log(`  raw_materials fabric rows: ${cat[0].n}`);

  console.log("\n=== Legacy fabric_trackings size (for comparison) ===");
  const ft = await sql`SELECT COUNT(*)::int AS n FROM fabric_trackings;`;
  console.log(`  fabric_trackings rows: ${ft[0].n}`);

  console.log(
    "\n=== fabric_trackings rows that DON'T exist in raw_materials (legacy duplicates) ===",
  );
  const ftOrphans = await sql`
    SELECT ft.fabric_code, ft.fabric_description
    FROM fabric_trackings ft
    WHERE ft.fabric_code IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM raw_materials rm
        WHERE rm.item_code = ft.fabric_code
          AND rm.item_group = ANY(${FABRIC_GROUPS})
      )
    ORDER BY ft.fabric_code;
  `;
  console.log(`  ${ftOrphans.length} orphan(s):`);
  for (const r of ftOrphans.slice(0, 30)) {
    console.log(`    ${r.fabric_code.padEnd(20)} ${r.fabric_description ?? ""}`);
  }
  if (ftOrphans.length > 30) console.log(`    ... +${ftOrphans.length - 30} more`);

  for (const tbl of [
    "sales_order_items",
    "consignment_order_items",
    "production_orders",
  ]) {
    console.log(`\n=== ${tbl}: dirty fabricCode (not in raw_materials) ===`);
    const rows = await sql.unsafe(
      `SELECT fabric_code AS code, COUNT(*)::int AS n
         FROM "${tbl}"
        WHERE fabric_code IS NOT NULL
          AND fabric_code <> ''
          AND NOT EXISTS (
            SELECT 1 FROM raw_materials rm
            WHERE rm.item_code = "${tbl}".fabric_code
              AND rm.item_group = ANY($1)
          )
        GROUP BY fabric_code
        ORDER BY n DESC, code ASC;`,
      [FABRIC_GROUPS],
    );
    if (rows.length === 0) {
      console.log("  ✓ clean — every fabricCode resolves");
    } else {
      const total = rows.reduce((s, r) => s + r.n, 0);
      console.log(`  ${rows.length} distinct dirty code(s), ${total} total row(s):`);
      for (const r of rows.slice(0, 30)) {
        console.log(`    ${(r.code ?? "(null)").padEnd(20)} × ${r.n}`);
      }
      if (rows.length > 30) console.log(`    ... +${rows.length - 30} more`);
    }
  }
} finally {
  await sql.end();
}
