// Read-only — explain the slow /api/production-orders?fields=minimal
// queries against prod DB to identify missing indexes.
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";

const url =
  prodUrl();

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

const ORG = "hookka";
const DEPT = "WOOD_CUT";
const FROM = "2026-05-08";
const TO = "2026-05-08";

try {
  console.log("=== Existing indexes on production_orders + job_cards ===");
  const idx = await sql`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('production_orders','job_cards')
    ORDER BY tablename, indexname;
  `;
  for (const r of idx) console.log(`  ${r.tablename.padEnd(20)} ${r.indexname}\n      ${r.indexdef}`);

  console.log("\n=== Row counts ===");
  const counts = await sql`
    SELECT
      (SELECT COUNT(*) FROM production_orders) AS po_total,
      (SELECT COUNT(*) FROM job_cards) AS jc_total,
      (SELECT COUNT(*) FROM job_cards WHERE department_code = ${DEPT}) AS jc_dept,
      (SELECT COUNT(*) FROM production_orders WHERE company_so_id IS NOT NULL) AS po_with_so,
      (SELECT COUNT(*) FROM production_orders WHERE company_co_id IS NOT NULL) AS po_with_co;
  `;
  console.log(JSON.stringify(counts[0], null, 2));

  console.log("\n=== Q1: PO list with EXISTS(JC dept + due) ===");
  const q1 = await sql.unsafe(`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT * FROM production_orders
    WHERE org_id = $1
      AND EXISTS (
        SELECT 1 FROM job_cards jc
        WHERE jc.production_order_id = production_orders.id
          AND jc.department_code = $2
          AND (jc.due_date IS NULL OR jc.due_date >= $3)
          AND (jc.due_date IS NULL OR jc.due_date <= $4)
      )
    ORDER BY created_at DESC, id DESC
  `, [ORG, DEPT, FROM, TO]);
  for (const r of q1) console.log("  " + r["QUERY PLAN"]);

  console.log("\n=== Q2: JC fan-out with 3-way OR (the suspect) ===");
  const q2 = await sql.unsafe(`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT * FROM job_cards
    WHERE org_id = $1
      AND production_order_id IN (
        SELECT po.id FROM production_orders po
        WHERE po.org_id = $1
          AND (po.id IN (SELECT production_order_id FROM job_cards WHERE org_id = $1 AND department_code = $2)
               OR (po.company_so_id IS NOT NULL AND po.company_so_id IN (
                    SELECT po2.company_so_id FROM production_orders po2
                    JOIN job_cards jc2 ON jc2.production_order_id = po2.id
                    WHERE jc2.org_id = $1 AND jc2.department_code = $2 AND po2.company_so_id IS NOT NULL))
               OR (po.company_co_id IS NOT NULL AND po.company_co_id IN (
                    SELECT po3.company_co_id FROM production_orders po3
                    JOIN job_cards jc3 ON jc3.production_order_id = po3.id
                    WHERE jc3.org_id = $1 AND jc3.department_code = $2 AND po3.company_co_id IS NOT NULL)))
      )
  `, [ORG, DEPT]);
  for (const r of q2) console.log("  " + r["QUERY PLAN"]);

  console.log("\n=== Q3: bare /api/production-orders?fields=minimal — full PO + JC pull ===");
  const q3a = await sql.unsafe(`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT * FROM production_orders WHERE org_id = $1 ORDER BY created_at DESC, id DESC
  `, [ORG]);
  console.log("--- POs:");
  for (const r of q3a) console.log("  " + r["QUERY PLAN"]);
  const q3b = await sql.unsafe(`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT * FROM job_cards WHERE org_id = $1
  `, [ORG]);
  console.log("--- JCs:");
  for (const r of q3b) console.log("  " + r["QUERY PLAN"]);
} finally {
  await sql.end();
}
