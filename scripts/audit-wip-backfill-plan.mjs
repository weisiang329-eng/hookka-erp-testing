// Read-only audit: for every negative wip_items row, find the upstream
// WAITING job_cards that need to be marked COMPLETED to resolve the stub.
// No mutations. Outputs the backfill plan for review.
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";

const url =
  prodUrl();

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

try {
  // 1) Pull every negative wip_items row.
  const negatives = await sql`
    SELECT id, code, type, related_product, dept_status, stock_qty, status
    FROM wip_items
    WHERE stock_qty < 0
    ORDER BY stock_qty ASC;
  `;
  console.log(`\n=== Negative wip_items: ${negatives.length} rows ===`);

  // 2) For each, find matching WAITING JCs by wipLabel (the JC's stored label
  //    or the synthesized "<productCode> <wipCode> (<DEPT>)" form).
  //
  //    Strategy:
  //    - Try exact wipLabel match first (covers cases where the JC has a
  //      stored wipLabel that the cascade used).
  //    - Then fallback: parse "(DEPT)" suffix from the negative code, find
  //      JCs in same dept + same PO chain via wipKey.
  //
  //    For the audit, just match by wipLabel = wip_items.code first and
  //    surface unmatched rows for human review.

  let totalJcsToBackfill = 0;
  const byDept = new Map();
  const unmatched = [];
  const matched = [];

  for (const w of negatives) {
    // Exact wipLabel match — JCs not yet COMPLETED with this label
    const jcs = await sql`
      SELECT jc.id, jc.production_order_id, jc.department_code, jc.status,
             jc.wip_label, jc.wip_qty, jc.sequence,
             po.po_no, po.company_so_id, po.product_code, po.quantity AS po_qty
      FROM job_cards jc
      JOIN production_orders po ON po.id = jc.production_order_id
      WHERE jc.wip_label = ${w.code}
        AND jc.status NOT IN ('COMPLETED','TRANSFERRED')
      ORDER BY jc.department_code, po.po_no;
    `;
    if (jcs.length === 0) {
      unmatched.push({ code: w.code, qty: w.stock_qty, type: w.type });
      continue;
    }
    matched.push({ wip: w, jcs });
    totalJcsToBackfill += jcs.length;
    for (const jc of jcs) {
      const dept = jc.department_code || "?";
      byDept.set(dept, (byDept.get(dept) || 0) + 1);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Negative wip rows: ${negatives.length}`);
  console.log(`Matched (have WAITING upstream JCs): ${matched.length}`);
  console.log(`Unmatched (no WAITING JC with that wipLabel): ${unmatched.length}`);
  console.log(`Total JCs that would be COMPLETED: ${totalJcsToBackfill}`);
  console.log(`\nBy department:`);
  for (const [d, n] of [...byDept.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${d.padEnd(14)} ${n}`);
  }

  console.log(`\n=== Detail: Top 10 worst negatives + their backfill JCs ===`);
  for (const m of matched.slice(0, 10)) {
    console.log(
      `\n[${m.wip.stock_qty}]  ${m.wip.type}  ${m.wip.code}`,
    );
    for (const jc of m.jcs) {
      console.log(
        `   → JC ${jc.id.slice(0, 14)}…  dept=${(jc.department_code || "").padEnd(10)}  status=${jc.status.padEnd(10)}  qty=${jc.wip_qty}  PO=${jc.po_no}  ${jc.product_code}`,
      );
    }
  }

  if (unmatched.length > 0) {
    console.log(`\n=== UNMATCHED (no WAITING JC for these — needs human investigation) ===`);
    for (const u of unmatched) {
      console.log(`  [${u.qty}]  ${u.type}  ${u.code}`);
    }
  }
} finally {
  await sql.end();
}
