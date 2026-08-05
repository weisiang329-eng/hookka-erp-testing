// Reproduce the frontend picker logic for SO-2604-347 to confirm whether
// byDept.get("*") returns the merged FC JC.
import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";

const sql = postgres(
  stagingUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

try {
  const poId = "pord-so-f4f9fbb9-01";
  const jcs = await sql`
    SELECT id, department_code, wip_key, wip_label, status,
           completed_date, due_date
    FROM job_cards
    WHERE production_order_id = ${poId}
    ORDER BY department_code, id;
  `;
  console.log(`PO ${poId} has ${jcs.length} JCs:`);
  for (const jc of jcs) {
    console.log(
      `  ${jc.department_code.padEnd(12)} | ${jc.status.padEnd(10)} | ${(jc.wip_key || "").padEnd(60)} | ${jc.wip_label || ""}`,
    );
  }

  // Build pickerIndex for this PO (mirrors src/pages/production/index.tsx:1421-1455)
  const byDept = new Map();
  for (const j of jcs) {
    const code = j.department_code;
    if (!byDept.has(code)) byDept.set(code, new Map());
    const m = byDept.get(code);
    const wipKey = j.wip_key || "";
    const prev = m.get(wipKey);
    if (
      !prev ||
      (j.due_date || "").localeCompare(prev.due_date || "") > 0
    ) {
      m.set(wipKey, j);
    }
    const prevAny = m.get("*");
    if (
      !prevAny ||
      (j.due_date || "").localeCompare(prevAny.due_date || "") > 0
    ) {
      m.set("*", j);
    }
  }

  // Simulate picker for each SEW row's wipKey looking up FAB_CUT
  console.log("\n=== Picker simulation ===");
  for (const sew of jcs.filter((j) => j.department_code === "FAB_SEW")) {
    console.log(`\nSEW row wipKey: "${sew.wip_key}"`);
    // Step 1: strict match
    const fcMap = byDept.get("FAB_CUT");
    if (!fcMap) {
      console.log("  ❌ byDept.get('FAB_CUT') is undefined!");
      continue;
    }
    console.log(`  byDept('FAB_CUT') has ${fcMap.size} entries: ${[...fcMap.keys()].join(" | ")}`);
    const exact = fcMap.get(sew.wip_key);
    if (exact) {
      console.log(`  ✅ exact match → returning ${exact.id}`);
      continue;
    }
    console.log(`  no exact match for "${sew.wip_key}"`);
    // Step 2: byDept.get("*") fallback (b0a5833)
    const fallback = fcMap.get("*");
    if (fallback) {
      console.log(`  ✅ "*" fallback → returning ${fallback.id} (status=${fallback.status}, completed=${fallback.completed_date})`);
    } else {
      console.log(`  ❌ "*" fallback also missing!`);
    }
  }
} finally {
  await sql.end();
}
