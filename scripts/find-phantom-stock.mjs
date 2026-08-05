import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";
const sql = postgres(stagingUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  // For each non-FC wip_items row with stock != 0, compute the EXPECTED stock from JC state.
  // Producer = JC where wip_label = code AND status DONE
  // Consumer = next-dept JC in same wipKey (sequence > producer.sequence) AND status DONE
  //
  // For SEW: producer = SEW JC done. Consumer = UPH JC done in same wipKey (which is the branch terminal — UPH consumes from highest seq in branch).
  //
  // Simplified rule for SEW WIP audit:
  //   expected_stock_qty = SUM(SEW jc.wipQty WHERE status DONE)
  //                       - SUM(UPH jc.wipQty WHERE status DONE AND same wipKey)
  
  const mismatches = await sql`
    WITH sew_done AS (
      SELECT jc.wip_label, SUM(jc.wip_qty)::int AS total_done
      FROM job_cards jc
      WHERE jc.department_code = 'FAB_SEW'
        AND jc.status IN ('COMPLETED','TRANSFERRED')
        AND jc.wip_label IS NOT NULL
      GROUP BY jc.wip_label
    ),
    -- For each SEW wip_label, find UPH JCs in same PO same wipKey that consumed from this terminal
    uph_consumed AS (
      SELECT sjc.wip_label, SUM(uph.wip_qty)::int AS total_consumed
      FROM job_cards uph
      JOIN job_cards sjc ON sjc.production_order_id = uph.production_order_id
        AND sjc.wip_key = uph.wip_key
        AND sjc.department_code = 'FAB_SEW'
      WHERE uph.department_code = 'UPHOLSTERY'
        AND uph.status IN ('COMPLETED','TRANSFERRED')
      GROUP BY sjc.wip_label
    ),
    expected AS (
      SELECT 
        COALESCE(s.wip_label, u.wip_label) AS code,
        COALESCE(s.total_done, 0) - COALESCE(u.total_consumed, 0) AS expected_qty
      FROM sew_done s
      FULL OUTER JOIN uph_consumed u ON s.wip_label = u.wip_label
    )
    SELECT e.code, e.expected_qty, w.stock_qty AS actual
    FROM wip_items w
    JOIN expected e ON e.code = w.code
    WHERE w.dept_status = 'FAB_SEW'
      AND w.stock_qty <> e.expected_qty;
  `;
  console.log(`SEW stock_qty mismatches (phantom stock from rolled-back DONE→WAITING): ${mismatches.length}`);
  for (const m of mismatches.slice(0, 30)) {
    console.log(`  expected=${String(m.expected_qty).padStart(3)}  actual=${String(m.actual).padStart(3)}  diff=${m.actual - m.expected_qty}  ${m.code}`);
  }
  console.log(`\nTotal phantom: ${mismatches.reduce((s, m) => s + (m.actual - m.expected_qty), 0)} units across ${mismatches.length} rows`);
} finally { await sql.end(); }
