import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// Audit: did UPHOLSTERY really only complete 8 POs on 2026-05-06?
// Frontend "Production Revenue" only counts a PO when ALL its UPHOLSTERY
// JCs are COMPLETED/TRANSFERRED with completedDate within [from, to].
import postgres from "postgres";
const sql = postgres(
  requiredDatabaseUrl("PROD_DATABASE_URL"),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

const FROM = "2026-05-06";
const TO   = "2026-05-06";

try {
  // 1. Raw upholstery JC completions on the day (not collapsed per PO)
  const rawJC = await sql`
    SELECT status,
           COUNT(*) AS n,
           COUNT(DISTINCT production_order_id) AS distinct_pos
      FROM job_cards
     WHERE department_code = 'UPHOLSTERY'
       AND completed_date::date >= ${FROM}::date
       AND completed_date::date <= ${TO}::date
     GROUP BY status
     ORDER BY status
  `;
  console.log(`\n=== Raw UPHOLSTERY job_cards completed on ${FROM} ===`);
  for (const r of rawJC) console.log(`  ${r.status.padEnd(12)} count=${r.n}  distinct POs=${r.distinct_pos}`);

  // 2. Per-PO rollup (mirrors the API logic)
  const perPo = await sql`
    WITH per_po AS (
      SELECT production_order_id,
             COUNT(*) AS total_uph,
             SUM(CASE WHEN status IN ('COMPLETED','TRANSFERRED')
                           AND completed_date IS NOT NULL
                      THEN 1 ELSE 0 END) AS done_uph,
             MAX(CASE WHEN status IN ('COMPLETED','TRANSFERRED')
                           AND completed_date IS NOT NULL
                      THEN completed_date END) AS unit_completed_at
        FROM job_cards
       WHERE department_code = 'UPHOLSTERY'
       GROUP BY production_order_id
      HAVING COUNT(*) > 0
    )
    SELECT production_order_id, total_uph, done_uph, unit_completed_at,
           CASE WHEN done_uph = total_uph THEN 'fully done' ELSE 'partial' END AS status
      FROM per_po
     WHERE unit_completed_at::date = ${FROM}::date
     ORDER BY status DESC, production_order_id
  `;
  const fullyDone = perPo.filter(r => r.status === "fully done");
  const partial   = perPo.filter(r => r.status === "partial");
  console.log(`\n=== POs whose latest UPHOLSTERY JC completed on ${FROM} ===`);
  console.log(`  fully done (counted in revenue): ${fullyDone.length}`);
  console.log(`  partial   (NOT counted yet)    : ${partial.length}`);

  if (partial.length > 0) {
    console.log("\n  Partial-only POs (have at least one UPH JC done on day, but not all):");
    for (const r of partial.slice(0, 30)) {
      console.log(`    ${r.production_order_id}  done=${r.done_uph}/${r.total_uph}  latest=${r.unit_completed_at}`);
    }
    if (partial.length > 30) console.log(`    ... +${partial.length - 30} more`);
  }

  // 3. Detail: show the fully-done POs with PO + product + customer for sanity
  if (fullyDone.length > 0) {
    const ids = fullyDone.map(r => r.production_order_id);
    const detail = await sql`
      SELECT po.id, po.product_code, po.product_name, po.customer_name,
             po.item_category, po.quantity,
             COALESCE(po.sales_order_no, po.company_co_id) AS so_no
        FROM production_orders po
       WHERE po.id = ANY(${ids})
       ORDER BY po.item_category, po.id
    `;
    console.log("\n  Fully-done POs detail:");
    for (const d of detail) {
      console.log(`    ${d.id}  ${d.item_category.padEnd(9)} qty=${d.quantity}  ${d.product_code}  ${d.customer_name}  ${d.so_no}`);
    }
  }

  // 4. Sanity: how many POs had ANY upholstery JC completed on the day,
  // regardless of whether all done. This shows operator activity.
  const activity = await sql`
    SELECT COUNT(DISTINCT production_order_id) AS n
      FROM job_cards
     WHERE department_code = 'UPHOLSTERY'
       AND status IN ('COMPLETED','TRANSFERRED')
       AND completed_date::date = ${FROM}::date
  `;
  console.log(`\n=== Operator activity ===`);
  console.log(`  POs with at least one UPHOLSTERY JC marked done on ${FROM}: ${activity[0].n}`);
} finally { await sql.end(); }
