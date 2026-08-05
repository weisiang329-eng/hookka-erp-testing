import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
const sql = postgres(prodUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const ts = new Date().toISOString();
  console.log(`=== PROD BASELINE @ ${ts} ===`);
  const so = await sql`SELECT COUNT(*) AS n FROM sales_orders;`;
  const po = await sql`SELECT COUNT(*) AS n FROM production_orders;`;
  const jcByStatus = await sql`SELECT status, COUNT(*) AS n FROM job_cards GROUP BY status ORDER BY status;`;
  const jcByDept = await sql`SELECT department_code, COUNT(*) AS n FROM job_cards GROUP BY department_code ORDER BY department_code;`;
  const wip = await sql`SELECT COUNT(*) AS n, SUM(stock_qty) AS sum FROM wip_items WHERE stock_qty != 0;`;
  const wipByDept = await sql`SELECT dept_status, COUNT(*) AS n, SUM(stock_qty) AS sum FROM wip_items WHERE stock_qty != 0 GROUP BY dept_status ORDER BY dept_status;`;

  console.log(`sales_orders: ${so[0].n}`);
  console.log(`production_orders: ${po[0].n}`);
  console.log(`\nJC by status:`); console.log(JSON.stringify(jcByStatus, null, 2));
  console.log(`\nJC by dept:`); console.log(JSON.stringify(jcByDept, null, 2));
  console.log(`\nwip_items stock != 0: ${wip[0].n} rows, sum=${wip[0].sum}`);
  console.log(`\nwip_items by dept_status (non-zero):`); console.log(JSON.stringify(wipByDept, null, 2));
} finally { await sql.end(); }
