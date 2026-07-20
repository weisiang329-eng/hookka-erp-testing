import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// Compare wip_items rows between prod and staging to see what's missing.
import postgres from "postgres";

const stagingUrl =
  requiredDatabaseUrl("STAGING_DATABASE_URL");
const prodUrl =
  requiredDatabaseUrl("PROD_DATABASE_URL");

async function summarize(label, url) {
  const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });
  try {
    console.log(`\n=== ${label} wip_items by type + status ===`);
    const r1 = await sql`
      SELECT type, status, dept_status, COUNT(*) AS n,
             SUM(stock_qty) AS total_qty
      FROM wip_items
      GROUP BY type, status, dept_status
      ORDER BY type, status, dept_status;
    `;
    console.log(JSON.stringify(r1, null, 2));

    console.log(`\n=== ${label} total wip_items count ===`);
    const total = await sql`SELECT COUNT(*) AS n FROM wip_items`;
    console.log(JSON.stringify(total, null, 2));

    console.log(`\n=== ${label} wip_items by department (FC/SEW/FRAME/UPH/PACK markers in code) ===`);
    const byMarker = await sql`
      SELECT
        CASE
          WHEN code LIKE '%(FC)%'   THEN 'FC'
          WHEN code LIKE '%(SEW)%'  THEN 'SEW'
          WHEN code LIKE '%(FR)%'   THEN 'FR'
          WHEN code LIKE '%(UPH)%'  THEN 'UPH'
          WHEN code LIKE '%(PK)%'   THEN 'PK'
          ELSE '(other)'
        END AS dept_marker,
        COUNT(*) AS n
      FROM wip_items
      GROUP BY dept_marker
      ORDER BY dept_marker;
    `;
    console.log(JSON.stringify(byMarker, null, 2));
  } finally {
    await sql.end();
  }
}

await summarize("STAGING", stagingUrl);
await summarize("PROD", prodUrl);
