// Recheck wip_items — UI says 597 rows incl negatives. My earlier audit said
// 242 rows / 0 negatives. Either DB changed or there's another source.
import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";

const url =
  stagingUrl();

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

try {
  console.log("=== wip_items totals (NOW) ===");
  const totals = await sql`
    SELECT
      COUNT(*) AS total_rows,
      COUNT(*) FILTER (WHERE stock_qty < 0)  AS negative_rows,
      COUNT(*) FILTER (WHERE stock_qty = 0)  AS zero_rows,
      COUNT(*) FILTER (WHERE stock_qty > 0)  AS positive_rows,
      COUNT(*) FILTER (WHERE stock_qty <> 0) AS nonzero_rows,
      MIN(stock_qty) AS min_qty,
      MAX(stock_qty) AS max_qty,
      SUM(stock_qty) AS sum_qty
    FROM wip_items;
  `;
  console.log(JSON.stringify(totals[0], null, 2));

  console.log("\n=== Top 30 most-negative wip_items (if any) ===");
  const worst = await sql`
    SELECT id, code, type, related_product, dept_status, stock_qty, status
    FROM wip_items
    WHERE stock_qty < 0
    ORDER BY stock_qty ASC
    LIMIT 30;
  `;
  console.log(`negative count: ${worst.length}`);
  for (const r of worst) {
    console.log(
      `  qty=${String(r.stock_qty).padStart(5)}  ${(r.type || "").padEnd(10)}  ${(r.status || "").padEnd(12)}  dept=${(r.dept_status || "-").padEnd(12)}  rel=${(r.related_product || "-").padEnd(12)}  ${r.code}`,
    );
  }

  console.log("\n=== Top 5 most-positive (sanity) ===");
  const tops = await sql`
    SELECT code, type, dept_status, stock_qty, status
    FROM wip_items
    WHERE stock_qty > 0
    ORDER BY stock_qty DESC
    LIMIT 5;
  `;
  for (const r of tops) {
    console.log(`  qty=${r.stock_qty}  ${r.type}  ${r.code}`);
  }

  console.log("\n=== Are negatives correlated with a particular dept_status? ===");
  const negByDept = await sql`
    SELECT dept_status, COUNT(*) AS n, MIN(stock_qty) AS worst, SUM(stock_qty) AS sum
    FROM wip_items
    WHERE stock_qty < 0
    GROUP BY dept_status
    ORDER BY n DESC;
  `;
  console.log(JSON.stringify(negByDept, null, 2));

  console.log("\n=== Any duplicate (code, dept_status) combos? ===");
  const dups = await sql`
    SELECT code, dept_status, COUNT(*) AS n
    FROM wip_items
    GROUP BY code, dept_status
    HAVING COUNT(*) > 1
    ORDER BY n DESC
    LIMIT 10;
  `;
  console.log(`duplicate combos: ${dups.length}`);
  for (const r of dups) console.log(`  n=${r.n}  ${r.dept_status}  ${r.code}`);
} finally {
  await sql.end();
}
