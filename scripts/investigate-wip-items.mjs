import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// Verify wip_items state on staging — should be 222 merged FC rows.
import postgres from "postgres";

const url =
  requiredDatabaseUrl("STAGING_DATABASE_URL");

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

try {
  console.log("=== wip_items by type ===");
  const byType = await sql`
    SELECT type, COUNT(*) AS n,
           COUNT(*) FILTER (WHERE code LIKE '%(FC)%') AS fc_label_count
    FROM wip_items
    GROUP BY type
    ORDER BY type;
  `;
  console.log(JSON.stringify(byType, null, 2));

  console.log("\n=== Sample 10 FC merged wip_items ===");
  const sample = await sql`
    SELECT id, code, type, related_product, dept_status, stock_qty, status
    FROM wip_items
    WHERE code LIKE '%(FC)%'
    LIMIT 10;
  `;
  console.log(JSON.stringify(sample, null, 2));

  console.log("\n=== Sofa-merged sample (model+model labels) ===");
  const sofaSample = await sql`
    SELECT code, type, stock_qty, status
    FROM wip_items
    WHERE code LIKE '%+%' AND code LIKE '%(FC)%'
    ORDER BY id
    LIMIT 10;
  `;
  console.log(JSON.stringify(sofaSample, null, 2));

  console.log("\n=== Find any per-piece (HB)/(DV)/(LF/RF) FC labels remaining ===");
  const perPiece = await sql`
    SELECT code, type, stock_qty
    FROM wip_items
    WHERE code LIKE '%(FC)%'
      AND (code LIKE '%(HB)%' OR code LIKE '%(DV)%' OR code LIKE '%(LF)%'
           OR code LIKE '%(RF)%' OR code LIKE '%(piece%')
    LIMIT 20;
  `;
  console.log(`Per-piece leftover: ${perPiece.length}`);
  console.log(JSON.stringify(perPiece, null, 2));

} finally {
  await sql.end();
}
