import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";
const sql = postgres(stagingUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const oldCode = '5530-2A(LHF)+L(RHF) | (26) | BO315-22 | (FC)';
  const newCode = '5530-2A(LHF)+L(RHF) | BO315-22 | (FC)';
  const orphan = await sql`SELECT id, stock_qty FROM wip_items WHERE code = ${oldCode};`;
  if (orphan.length > 0) {
    const newRow = await sql`SELECT id, stock_qty FROM wip_items WHERE code = ${newCode};`;
    if (newRow.length > 0) {
      const sumQty = (Number(newRow[0].stock_qty) || 0) + (Number(orphan[0].stock_qty) || 0);
      await sql`UPDATE wip_items SET stock_qty = ${sumQty} WHERE id = ${newRow[0].id};`;
      await sql`DELETE FROM wip_items WHERE id = ${orphan[0].id};`;
      console.log(`Merged orphan into ${newRow[0].id}, sum=${sumQty}, deleted orphan.`);
    } else {
      await sql`UPDATE wip_items SET code = ${newCode} WHERE id = ${orphan[0].id};`;
      console.log(`Renamed orphan code → ${newCode}`);
    }
  }
  const stillOrphans = await sql`
    SELECT w.id, w.code FROM wip_items w
    WHERE w.code LIKE '%(FC)%'
      AND NOT EXISTS (SELECT 1 FROM job_cards jc WHERE jc.wip_label = w.code);
  `;
  console.log(`Remaining orphans: ${stillOrphans.length}`);
  for (const o of stillOrphans) console.log(`  ${o.id}  ${o.code}`);
} finally { await sql.end(); }
