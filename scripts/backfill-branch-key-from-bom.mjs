// ---------------------------------------------------------------------------
// Walk each PO's actual BOM template (bom_templates.wip_components JSON) and
// stamp branchKey on every job_card by tree position — NOT by category /
// dept hardcoded mapping.
//
// Algorithm per PO:
//   1. Load bomRow = bom_templates WHERE product_code = po.product_code AND
//      version_status = 'ACTIVE' (fall back to most recent if none active).
//   2. JSON.parse(wip_components) → BOM tree.
//   3. Walk top-level wipComponents. For each top-level node:
//      - Top-level processes (e.g. UPHOLSTERY, PACKING) → branchKey = ""
//      - First descent into a child → branchKey = child.wipCode (raw)
//      - Deeper descents → inherit parent branchKey
//   4. Build a map { wipCode → branchKey } per top-level subtree
//      (since multiple processes can share a wipCode at the same node).
//   5. UPDATE job_cards SET branch_key = <walked> WHERE production_order_id
//      = po.id AND wip_code = <walked-wipCode>.
//
// Stops at first error per PO; logs aggregate stats at end.
// ---------------------------------------------------------------------------
import postgres from "postgres";

const DB_URL =
  "postgresql://postgres.vpwdqtsxexpiqxzweivd:Hookka%402026@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres";

const sql = postgres(DB_URL);

function resolveWipTokens(template, ctx) {
  if (!template || !template.includes("{")) return template;
  const c = ctx || {};
  const divanH =
    c.divanHeightInches != null && Number(c.divanHeightInches) > 0
      ? `${Number(c.divanHeightInches)}"`
      : "";
  const totalH =
    (Number(c.gapInches) || 0) +
    (Number(c.divanHeightInches) || 0) +
    (Number(c.legHeightInches) || 0);
  const totalStr = totalH > 0 ? `${totalH}"` : "";
  const size = c.sizeLabel || c.sizeCode || "";
  const productCode = c.productCode || "";
  const model = c.model || productCode;
  const fabric = c.fabricCode || "";
  return template
    .replace(/\{DIVAN_HEIGHT\}/g, divanH)
    .replace(/\{SIZE\}/g, size)
    .replace(/\{FABRIC\}/g, fabric)
    .replace(/\{PRODUCT_CODE\}/g, productCode)
    .replace(/\{MODEL\}/g, model)
    .replace(/\{TOTAL_HEIGHT\}/g, totalStr)
    .replace(/\{SEAT_SIZE\}/g, c.sizeCode || "")
    .replace(/\s+/g, " ")
    .trim();
}

// Walk the BOM tree and emit { resolvedWipCode → branchKey } for every node.
function walkBomTree(wipComponents, variants) {
  const map = new Map();
  function walk(node, branchKey) {
    if (!node) return;
    const rawCode = String(node.wipCode || "");
    const resolved = resolveWipTokens(rawCode, variants);
    if (resolved && !map.has(resolved)) {
      map.set(resolved, branchKey);
    }
    const kids = Array.isArray(node.children) ? node.children : [];
    for (const c of kids) {
      // First descent from root: branchKey is "" → adopt child's raw wipCode.
      // Deeper descents: inherit parent's branchKey.
      const childBranch = branchKey || String(c.wipCode || "");
      walk(c, childBranch);
    }
  }
  for (const top of wipComponents || []) {
    walk(top, "");
  }
  return map;
}

async function loadBomTemplate(productCode) {
  if (!productCode) return null;
  const active = await sql`
    SELECT wip_components, base_model FROM bom_templates
     WHERE product_code = ${productCode} AND version_status = 'ACTIVE'
     ORDER BY effective_from DESC LIMIT 1
  `;
  if (active[0]) return active[0];
  const latest = await sql`
    SELECT wip_components, base_model FROM bom_templates
     WHERE product_code = ${productCode}
     ORDER BY effective_from DESC LIMIT 1
  `;
  return latest[0] ?? null;
}

async function main() {
  // First reset every branch_key to NULL so we can verify backfill coverage.
  await sql`UPDATE job_cards SET branch_key = NULL`;

  // Joint terminals — UPH and PACKING are at root in every BOM.
  await sql`UPDATE job_cards SET branch_key = '' WHERE department_code IN ('UPHOLSTERY','PACKING')`;

  const pos = await sql`
    SELECT id, product_code, size_label, size_code, fabric_code,
           divan_height_inches, leg_height_inches, gap_inches
      FROM production_orders
  `;

  let updated = 0;
  let skippedNoBom = 0;
  let skippedNoMatch = 0;
  let processed = 0;

  for (const po of pos) {
    processed++;
    const bom = await loadBomTemplate(po.product_code);
    if (!bom?.wip_components) {
      skippedNoBom++;
      continue;
    }
    let tree;
    try {
      tree = JSON.parse(bom.wip_components);
    } catch {
      skippedNoBom++;
      continue;
    }
    const variants = {
      productCode: po.product_code,
      model: bom.base_model || po.product_code,
      sizeLabel: po.size_label,
      sizeCode: po.size_code,
      fabricCode: po.fabric_code,
      divanHeightInches: po.divan_height_inches,
      legHeightInches: po.leg_height_inches,
      gapInches: po.gap_inches,
    };
    const wipCodeToBranch = walkBomTree(tree, variants);

    if (wipCodeToBranch.size === 0) {
      skippedNoMatch++;
      continue;
    }

    // Bulk update per (po, wipCode) pair. Skip rows whose wipCode wasn't in
    // the BOM walk (e.g. legacy synthesized FG_MAIN — those keep their
    // existing default later in the joint-terminal step or stay NULL).
    for (const [resolvedWipCode, branchKey] of wipCodeToBranch) {
      const r = await sql`
        UPDATE job_cards
           SET branch_key = ${branchKey}
         WHERE production_order_id = ${po.id}
           AND wip_code = ${resolvedWipCode}
           AND branch_key IS NULL
      `;
      updated += r.count;
    }

    if (processed % 50 === 0) {
      console.log(`  processed ${processed}/${pos.length}, updated ${updated} so far`);
    }
  }

  // Anything still NULL after BOM walk + UPH/PACK pass — set to "" so the
  // (wipKey, branchKey) sibling filter doesn't accidentally exclude them.
  const tail = await sql`UPDATE job_cards SET branch_key = '' WHERE branch_key IS NULL`;

  const dist = await sql`
    SELECT branch_key, count(*) FROM job_cards
     GROUP BY branch_key ORDER BY count(*) DESC LIMIT 20
  `;

  console.log("\n=== summary ===");
  console.log(`POs processed: ${processed}`);
  console.log(`UPDATEs from BOM walk: ${updated}`);
  console.log(`Joint-terminal UPH/PACK: (set first; not counted above)`);
  console.log(`Tail set to "" (no BOM match): ${tail.count}`);
  console.log(`Skipped (no BOM): ${skippedNoBom}`);
  console.log(`Skipped (BOM but empty walk): ${skippedNoMatch}`);
  console.log("\nFinal branch_key distribution:");
  for (const r of dist) {
    console.log(`  '${r.branch_key}' → ${r.count}`);
  }

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
