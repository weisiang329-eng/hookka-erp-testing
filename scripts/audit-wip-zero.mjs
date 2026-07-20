import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// Follow-up: 239/242 wip_items have stock_qty=0. Are these all "completed/archived"
// or is the qty just not getting updated? Break down by type/status, show the 3 positives.
import postgres from "postgres";

const url =
  requiredDatabaseUrl("STAGING_DATABASE_URL");

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

try {
  console.log("=== wip_items breakdown by (type, status) ===");
  const breakdown = await sql`
    SELECT type, status,
           COUNT(*) AS n,
           COUNT(*) FILTER (WHERE stock_qty > 0) AS positive,
           COUNT(*) FILTER (WHERE stock_qty = 0) AS zero,
           COUNT(*) FILTER (WHERE stock_qty < 0) AS negative,
           SUM(stock_qty) AS sum_qty
    FROM wip_items
    GROUP BY type, status
    ORDER BY type, status;
  `;
  console.log(JSON.stringify(breakdown, null, 2));

  console.log("\n=== The 3 positive rows ===");
  const positives = await sql`
    SELECT id, code, type, related_product, dept_status, stock_qty, status
    FROM wip_items
    WHERE stock_qty > 0
    ORDER BY stock_qty DESC;
  `;
  for (const r of positives) {
    console.log(
      `  qty=${String(r.stock_qty).padStart(3)}  ${r.type.padEnd(10)}  ${r.status.padEnd(12)}  dept=${(r.dept_status ?? "-").padEnd(12)}  code=${r.code}  rel=${r.related_product ?? "-"}`,
    );
  }

  console.log("\n=== Zero rows: status distribution (sample) ===");
  const zerosByStatus = await sql`
    SELECT status, COUNT(*) AS n
    FROM wip_items
    WHERE stock_qty = 0
    GROUP BY status
    ORDER BY n DESC;
  `;
  console.log(JSON.stringify(zerosByStatus, null, 2));

  console.log("\n=== Compare: wip_items vs job_cards expected WIP picture ===");
  console.log("How many job_cards are not yet completed (status indicates WIP should exist)?");
  const jcOpen = await sql`
    SELECT status, COUNT(*) AS n
    FROM job_cards
    GROUP BY status
    ORDER BY n DESC;
  `;
  console.log(JSON.stringify(jcOpen, null, 2));

  console.log("\n=== Sample 10 zero wip_items with status='ACTIVE' or similar (if any) ===");
  const activeZeros = await sql`
    SELECT id, code, type, related_product, dept_status, stock_qty, status
    FROM wip_items
    WHERE stock_qty = 0
      AND status NOT IN ('COMPLETED','DONE','CLOSED','ARCHIVED','SHIPPED','DELIVERED')
    ORDER BY id
    LIMIT 15;
  `;
  console.log(`active-but-zero count: ${activeZeros.length}`);
  for (const r of activeZeros) {
    console.log(
      `  ${r.type.padEnd(10)}  ${r.status.padEnd(12)}  dept=${(r.dept_status ?? "-").padEnd(12)}  ${r.code}`,
    );
  }
} finally {
  await sql.end();
}
