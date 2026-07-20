import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// Migrate the 23 single-piece FC JCs (standalone DIVAN / PILLOW etc) to
// Option C wipKey schema. Original backfill SKIPPED single-slot groups
// because there's nothing to merge — but the wipKey schema mismatch
// breaks audit checks. Rebuild wipKey/wipLabel/wipType to be uniform
// with the rest of the merged FC universe.
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("STAGING_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });

function buildLabel(modelLabel, sizeLabel, totalH, divanH, fabric, isBF) {
  return [
    modelLabel,
    sizeLabel ? `(${sizeLabel})` : "",
    isBF && totalH > 0 ? `(${totalH}")` : "",
    isBF && divanH ? `(DV ${divanH}")` : "",
    fabric || "",
    "(FC)",
  ].filter(Boolean).join(" | ");
}

try {
  const rows = await sql`
    SELECT jc.id, jc.wip_key, jc.wip_label, jc.wip_type, jc.production_order_id,
           po.product_code, po.fabric_code, po.size_label,
           po.gap_inches, po.divan_height_inches, po.leg_height_inches,
           po.item_category, po.company_so_id,
           bt.base_model AS bom_base_model
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.production_order_id
    LEFT JOIN bom_templates bt ON bt.product_code = po.product_code AND bt.version_status = 'ACTIVE'
    WHERE jc.department_code = 'FAB_CUT'
      AND jc.wip_key NOT LIKE '%::FAB_CUT'
      AND jc.wip_key IS NOT NULL;
  `;
  console.log(`Found ${rows.length} old-schema FC JCs to migrate`);

  for (const r of rows) {
    const baseModel = r.bom_base_model || r.product_code || "";
    const fabric = r.fabric_code || "";
    const totalH = (r.gap_inches ?? 0) + (r.divan_height_inches ?? 0) + (r.leg_height_inches ?? 0);
    const isBF = r.item_category === 'BEDFRAME';
    const isSofa = r.item_category === 'SOFA';
    const newWipKey = isSofa
      ? `${r.company_so_id}::${baseModel}::${fabric}::FAB_CUT`
      : `${r.production_order_id}::${baseModel}::${fabric}::FAB_CUT`;
    const newLabel = buildLabel(r.product_code, r.size_label || "", totalH, r.divan_height_inches, fabric, isBF);
    const newType = r.item_category || r.wip_type;

    await sql`
      UPDATE job_cards
      SET wip_key = ${newWipKey}, wip_label = ${newLabel}, wip_type = ${newType}
      WHERE id = ${r.id};
    `;
    console.log(`  ${r.company_so_id} ${r.product_code}: wipKey → ${newWipKey}`);
  }

  // Verify
  const after = await sql`SELECT COUNT(*) AS n FROM job_cards WHERE department_code = 'FAB_CUT' AND wip_key NOT LIKE '%::FAB_CUT';`;
  console.log(`\nRemaining old-schema: ${after[0].n}`);
} finally { await sql.end(); }
