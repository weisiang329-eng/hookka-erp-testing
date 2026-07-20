import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// Verify overdue-counts endpoint output. Run the same SQL the new endpoint
// runs and compare against the broader set we'd EXPECT to be overdue.
import postgres from "postgres";

const url =
  requiredDatabaseUrl("PROD_DATABASE_URL");

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

const ORG = "hookka";
const DEPT = "WOOD_CUT";
const TODAY = new Date().toISOString().slice(0, 10);

try {
  console.log(`Today (server clock): ${TODAY}`);

  console.log(`\n=== Distribution of due_date in job_cards (WOOD_CUT only) ===`);
  const dist = await sql`
    SELECT MIN(due_date) AS min_due, MAX(due_date) AS max_due,
           COUNT(*) AS total,
           COUNT(due_date) AS with_due,
           COUNT(*) FILTER (WHERE due_date < ${TODAY}::text) AS past_today,
           COUNT(*) FILTER (WHERE due_date < ${TODAY}::text
                            AND status NOT IN ('COMPLETED','TRANSFERRED')) AS past_open
    FROM job_cards
    WHERE org_id = ${ORG} AND department_code = ${DEPT};
  `;
  console.log(JSON.stringify(dist[0], null, 2));

  console.log(`\n=== POs the endpoint would mark overdue (dept=WOOD_CUT) ===`);
  const r = await sql`
    SELECT po.id, po.company_so_id, po.sales_order_id, po.item_category, po.status,
           (SELECT MIN(jc.due_date) FROM job_cards jc
             WHERE jc.production_order_id = po.id
               AND jc.department_code = ${DEPT}
               AND jc.due_date IS NOT NULL
               AND jc.due_date < ${TODAY}::text
               AND jc.status NOT IN ('COMPLETED','TRANSFERRED')) AS earliest_overdue
    FROM production_orders po
    WHERE po.org_id = ${ORG}
      AND po.status NOT IN ('COMPLETED','CANCELLED');
  `;
  const overdue = r.filter((p) => p.earliest_overdue);
  console.log(`POs flagged overdue: ${overdue.length} / ${r.length} eligible`);
  for (const p of overdue.slice(0, 10)) {
    console.log(`  ${p.company_so_id || p.id}  cat=${p.item_category}  status=${p.status}  earliest=${p.earliest_overdue}`);
  }

  console.log(`\n=== JC dueDate values that ARE < today ===`);
  const jcs = await sql`
    SELECT due_date, status, COUNT(*) AS n
    FROM job_cards
    WHERE org_id = ${ORG} AND department_code = ${DEPT}
      AND due_date IS NOT NULL AND due_date < ${TODAY}::text
    GROUP BY due_date, status
    ORDER BY due_date ASC
    LIMIT 30;
  `;
  for (const j of jcs) console.log(`  due=${j.due_date}  status=${j.status}  n=${j.n}`);

  console.log(`\n=== Sample of all WOOD_CUT JCs with their due_date (any) ===`);
  const all = await sql`
    SELECT due_date, status, COUNT(*) AS n
    FROM job_cards
    WHERE org_id = ${ORG} AND department_code = ${DEPT} AND due_date IS NOT NULL
    GROUP BY due_date, status
    ORDER BY due_date ASC
    LIMIT 10;
  `;
  for (const j of all) console.log(`  due=${j.due_date}  status=${j.status}  n=${j.n}`);
  const nullDue = await sql`
    SELECT status, COUNT(*) AS n
    FROM job_cards
    WHERE org_id = ${ORG} AND department_code = ${DEPT} AND due_date IS NULL
    GROUP BY status;
  `;
  console.log(`  --- with NULL due_date ---`);
  for (const j of nullDue) console.log(`  status=${j.status}  n=${j.n}`);
} finally {
  await sql.end();
}
