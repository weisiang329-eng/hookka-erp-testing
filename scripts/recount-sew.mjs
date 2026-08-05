import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";
const sql = postgres(stagingUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  // Recount: what SHOULD SEW stock be?
  // For each SEW JC done: contributes +wipQty to wip_items[wipLabel].stock
  // For each UPH JC done: consumes its branch terminal's wipLabel by wipQty
  // Net = sum done SEW wipQty - sum done UPH consumption (per branch terminal of UPH)
  
  // Simpler view: per wipLabel, count DONE producer JCs (SEW) vs DONE consumer JCs (UPH+downstream that consume from this label)
  
  // Top 5 SEW rows: cross-check producer/consumer JC count
  const top = ['10" Divan- 5FT PC151-01', '5530 -Back Cushion 28 BO315-12', '5530 -Back Cushion 28 BO315-22', '5536 -Back Cushion 30 BO315-22', '5530 -Back Cushion 32 BO315-21'];
  for (const code of top) {
    console.log(`\n=== ${code} ===`);
    const w = await sql`SELECT stock_qty FROM wip_items WHERE code = ${code};`;
    console.log(`  current stock_qty = ${w[0]?.stock_qty}`);
    
    const producers = await sql`
      SELECT jc.id, jc.production_order_id, jc.wip_qty, jc.status, po.company_so_id
      FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
      WHERE jc.wip_label = ${code} AND jc.department_code = 'FAB_SEW'
      ORDER BY po.company_so_id;
    `;
    console.log(`  SEW JCs (producers): ${producers.length}`);
    let totalProducedQty = 0, doneProducedQty = 0;
    for (const p of producers) {
      const isDone = p.status === 'COMPLETED' || p.status === 'TRANSFERRED';
      totalProducedQty += p.wip_qty;
      if (isDone) doneProducedQty += p.wip_qty;
    }
    console.log(`    done qty: ${doneProducedQty} / total qty: ${totalProducedQty}`);

    // Find UPH JCs in same POs whose wipKey matches this SEW's wipKey (consumes from terminal)
    const consumers = await sql`
      SELECT jc.id, jc.status, po.company_so_id, jc.wip_qty
      FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
      WHERE jc.department_code = 'UPHOLSTERY'
        AND jc.production_order_id IN (
          SELECT production_order_id FROM job_cards WHERE wip_label = ${code} AND department_code = 'FAB_SEW'
        )
        AND jc.wip_key IN (
          SELECT wip_key FROM job_cards WHERE wip_label = ${code} AND department_code = 'FAB_SEW'
        )
      ORDER BY po.company_so_id;
    `;
    let doneConsumedQty = 0;
    for (const c of consumers) {
      if (c.status === 'COMPLETED' || c.status === 'TRANSFERRED') doneConsumedQty += c.wip_qty;
    }
    console.log(`  UPH JCs (consumers, same wipKey same PO): ${consumers.length}, done qty: ${doneConsumedQty}`);
    console.log(`  Expected stock = produced (${doneProducedQty}) - consumed (${doneConsumedQty}) = ${doneProducedQty - doneConsumedQty}`);
  }
} finally { await sql.end(); }
