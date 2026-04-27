// ---------------------------------------------------------------------------
// backfill-do-itemm3-2026-04-27
//
// One-shot fix for legacy DOs created before the productM3Map work landed.
// Two writers were storing item_m3 = 0 directly into delivery_order_items:
//   1) sales/index.tsx Transfer-to-DO action (hardcoded 0)
//   2) earlier delivery/index.tsx confirmCreateDO before the map was wired
//
// This script updates every delivery_order_items row where item_m3 = 0 and
// the matching products.unit_m3 > 0, then recomputes delivery_orders.total_m3
// for every affected DO. Read-time enrichment in routes-d1/delivery-orders.ts
// already shows correct values; this script just persists them.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import postgres from "postgres";

function loadEnv(): Record<string, string> {
  const txt = fs.readFileSync(".dev.vars", "utf8");
  const env: Record<string, string> = {};
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

async function main() {
  const env = loadEnv();
  const sql = postgres(env.DATABASE_URL, { ssl: "require" });

  console.log("Inspecting delivery_order_items with item_m3 = 0 ...");
  const stale = await sql<
    Array<{
      id: string;
      delivery_order_id: string;
      product_code: string | null;
      quantity: number;
      product_unit_m3: number | null;
    }>
  >`
    SELECT doi.id, doi.delivery_order_id, doi.product_code, doi.quantity,
           p.unit_m3 AS product_unit_m3
      FROM delivery_order_items doi
      LEFT JOIN products p ON p.code = doi.product_code
     WHERE doi.item_m3 = 0
       AND p.unit_m3 IS NOT NULL
       AND p.unit_m3 > 0
  `;
  console.log(`Found ${stale.length} stale item rows to backfill.`);
  if (stale.length === 0) {
    await sql.end();
    return;
  }

  const affectedDoIds = new Set<string>();
  for (const row of stale) {
    affectedDoIds.add(row.delivery_order_id);
    await sql`
      UPDATE delivery_order_items
         SET item_m3 = ${row.product_unit_m3}
       WHERE id = ${row.id}
    `;
  }
  console.log(`Updated ${stale.length} item rows. Recomputing total_m3 for ${affectedDoIds.size} DOs...`);

  for (const doId of affectedDoIds) {
    const sums = await sql<Array<{ total: number | null }>>`
      SELECT COALESCE(SUM(item_m3 * quantity), 0) AS total
        FROM delivery_order_items
       WHERE delivery_order_id = ${doId}
    `;
    const newTotal = Math.round(Number(sums[0]?.total ?? 0) * 100) / 100;
    await sql`
      UPDATE delivery_orders
         SET total_m3 = ${newTotal}
       WHERE id = ${doId}
    `;
  }
  console.log("Done.");
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
