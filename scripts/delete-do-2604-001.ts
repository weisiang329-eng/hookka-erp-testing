// One-shot cleanup:
//  1. Remove test DO-2604-001 + its items + related stock_movements
//  2. Revert any fg_units that the OLD POST flow stamped LOADED for it
//  3. Inspect FG inventory state and clear UPHOLSTERY completion dates so
//     the Inventory page shows 0 (user reset request 2026-04-27).
import fs from "node:fs";
import postgres from "postgres";

function loadEnv(): Record<string, string> {
  const txt = fs.readFileSync(".dev.vars", "utf8");
  const env: Record<string, string> = {};
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

async function main() {
  const env = loadEnv();
  const sql = postgres(env.DATABASE_URL, { ssl: "require" });
  const doId = "do-0800ad91"; // DO-2604-001

  const fgStamped = await sql<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM fg_units WHERE do_id = ${doId}
  `;
  const stampedCount = fgStamped[0]?.n ?? 0;
  const movs = await sql<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM stock_movements WHERE reason LIKE 'DO DO-2604-001%'
  `;
  const movCount = movs[0]?.n ?? 0;
  const itemCount = await sql<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM delivery_order_items WHERE delivery_order_id = ${doId}
  `;

  // FG count: POs whose UPHOLSTERY JCs are all done = "in stock" on inventory page.
  const completedUph = await sql<Array<{ n: number }>>`
    SELECT COUNT(DISTINCT production_order_id)::int AS n
      FROM job_cards
     WHERE department_code = 'UPHOLSTERY'
       AND status IN ('COMPLETED','TRANSFERRED')
  `;
  const completedUphCount = completedUph[0]?.n ?? 0;

  console.log(`Will delete:`);
  console.log(`  - delivery_order_items: ${itemCount[0]?.n ?? 0}`);
  console.log(`  - delivery_orders:      1 (DO-2604-001 / ${doId})`);
  console.log(`  - revert fg_units:      ${stampedCount} → PENDING`);
  console.log(`  - delete stock_movements: ${movCount}`);
  console.log(`Will reset FG inventory:`);
  console.log(`  - clear UPHOLSTERY completion on ~${completedUphCount} POs (job_cards)`);

  await sql.begin(async (tx) => {
    if (stampedCount > 0) {
      await tx`
        UPDATE fg_units
           SET do_id = NULL, status = 'PENDING', loaded_at = NULL
         WHERE do_id = ${doId}
      `;
    }
    if (movCount > 0) {
      await tx`DELETE FROM stock_movements WHERE reason LIKE 'DO DO-2604-001%'`;
    }
    await tx`DELETE FROM delivery_order_items WHERE delivery_order_id = ${doId}`;
    await tx`DELETE FROM delivery_orders WHERE id = ${doId}`;

    // Full reset — mirrors POST /api/admin/clear-all-completion-dates:
    // resets every job_card to WAITING + clears completion + reverts every
    // production_order to PENDING. Required so the Inventory page shows 0.
    await tx`
      UPDATE job_cards
         SET status = 'WAITING',
             completed_date = NULL,
             overdue = 'PENDING'
       WHERE status IN ('COMPLETED','TRANSFERRED','IN_PROGRESS')
          OR completed_date IS NOT NULL
    `;
    const nowIso = new Date().toISOString();
    await tx`
      UPDATE production_orders
         SET status = 'PENDING',
             progress = 0,
             current_department = '',
             completed_date = NULL,
             updated_at = ${nowIso}
       WHERE status IN ('IN_PROGRESS','COMPLETED')
    `;
  });

  console.log("Done.");
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
