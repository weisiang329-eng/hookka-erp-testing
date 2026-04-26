// ---------------------------------------------------------------------------
// scripts/resync-wip-labels.ts
//
// Migration for BUG-2026-04-27-004 — re-renders existing job_cards' wipLabel
// / wipCode / wipKey against the current BOM template using the corrected
// {MODEL} resolution (which now uses bom_templates.baseModel instead of
// substituting the variant SKU).
//
// What it does:
//   1. For every production_orders row, load its BOM template (by productCode
//      → bom_templates), recompute the expected (wipKey, deptCode, wipLabel,
//      wipCode) for every JC using `breakBomIntoWips` with the new model
//      field populated.
//   2. For each existing job_cards row matching (productionOrderId, wipKey
//      old, deptCode), if the new wipLabel/wipCode/wipKey differ, UPDATE.
//   3. Rename wip_items.code in lockstep so already-accumulated stock
//      follows the new label. If a row with the new code already exists,
//      MERGE: target.stockQty += source.stockQty, then DELETE source.
//
// Safety:
//   - Default is --dry-run; pass --apply to actually mutate.
//   - All writes for one PO are wrapped in a transaction so a partial run
//     can't leave the JC tree pointing at a renamed wip_items row that the
//     transaction never created.
//
// Usage:
//   npx tsx scripts/resync-wip-labels.ts                       # dry run, all POs
//   npx tsx scripts/resync-wip-labels.ts --apply                # commit changes
//   npx tsx scripts/resync-wip-labels.ts --po pord-so-f6084c68-02 --apply
// ---------------------------------------------------------------------------
import fs from "node:fs";
import postgres from "postgres";

import {
  breakBomIntoWips,
  type BomVariantContext,
} from "../src/api/lib/bom-wip-breakdown";

const envText = fs.readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
const env = Object.fromEntries(
  envText
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const apply = process.argv.includes("--apply");
const poFlag = process.argv.indexOf("--po");
const targetPoId = poFlag >= 0 ? process.argv[poFlag + 1] : null;

const sql = postgres(env.DATABASE_URL, {
  ssl: "require",
  max: 1,
  prepare: false,
});

type ProductionOrderRow = {
  id: string;
  product_code: string | null;
  item_category: string | null;
  quantity: number | null;
  size_label: string | null;
  size_code: string | null;
  fabric_code: string | null;
  divan_height_inches: number | null;
  leg_height_inches: number | null;
  gap_inches: number | null;
};

type JobCardRow = {
  id: string;
  production_order_id: string;
  department_code: string | null;
  sequence: number | null;
  status: string | null;
  wip_key: string | null;
  wip_code: string | null;
  wip_label: string | null;
  wip_qty: number | null;
};

type BomRow = {
  wip_components: string | null;
  l1_processes: string | null;
  base_model: string | null;
};

async function loadBom(productCode: string): Promise<BomRow | null> {
  if (!productCode) return null;
  const active = await sql<BomRow[]>`
    SELECT wip_components, l1_processes, base_model
      FROM bom_templates
     WHERE product_code = ${productCode}
       AND version_status = 'ACTIVE'
     ORDER BY effective_from DESC
     LIMIT 1
  `;
  if (active.length > 0) return active[0];
  const latest = await sql<BomRow[]>`
    SELECT wip_components, l1_processes, base_model
      FROM bom_templates
     WHERE product_code = ${productCode}
     ORDER BY effective_from DESC
     LIMIT 1
  `;
  return latest[0] ?? null;
}

type ExpectedKey = {
  wipKey: string;
  deptCode: string;
  wipCode: string;
  wipLabel: string;
};

function computeExpected(
  po: ProductionOrderRow,
  bom: BomRow | null,
): Map<string, ExpectedKey> {
  // Returns a Map keyed by `${oldOrNewWipKey}::${deptCode}` → new fields.
  // We key on (wipKey, deptCode) because that's how the JC sync pairs them
  // up; if wipKey itself changed (rare — only when the BOM master rawTopCode
  // template changed), we'd miss the join. For variants where only wipLabel
  // changed (the BUG-2026-04-27-004 case), the wipKey was always stable
  // (it uses the unresolved rawTopCode by design).
  const productCode = po.product_code ?? "";
  const ctx: BomVariantContext = {
    productCode,
    model: bom?.base_model ?? productCode,
    sizeLabel: po.size_label ?? "",
    sizeCode: po.size_code ?? "",
    fabricCode: po.fabric_code ?? "",
    divanHeightInches: po.divan_height_inches ?? null,
    legHeightInches: po.leg_height_inches ?? null,
    gapInches: po.gap_inches ?? null,
  };
  const wips = breakBomIntoWips(bom?.wip_components ?? null, productCode, ctx);
  const out = new Map<string, ExpectedKey>();
  for (const wip of wips) {
    for (const p of wip.processes) {
      const key = `${wip.wipKey}::${p.deptCode}`;
      out.set(key, {
        wipKey: wip.wipKey,
        deptCode: p.deptCode,
        wipCode: p.wipCode || wip.wipCode,
        wipLabel: p.wipLabel || wip.wipLabel,
      });
    }
  }
  return out;
}

type Plan = {
  poId: string;
  productCode: string;
  jcUpdates: Array<{
    jcId: string;
    deptCode: string;
    oldLabel: string;
    newLabel: string;
    oldCode: string;
    newCode: string;
  }>;
  wipItemsRenames: Array<{ from: string; to: string }>;
};

async function planForPo(po: ProductionOrderRow): Promise<Plan> {
  const productCode = po.product_code ?? "";
  const bom = await loadBom(productCode);
  const expected = computeExpected(po, bom);

  const jcs = await sql<JobCardRow[]>`
    SELECT id, production_order_id, department_code, sequence, status,
           wip_key, wip_code, wip_label, wip_qty
      FROM job_cards
     WHERE production_order_id = ${po.id}
  `;

  const plan: Plan = {
    poId: po.id,
    productCode,
    jcUpdates: [],
    wipItemsRenames: [],
  };
  const seenRenames = new Set<string>();

  for (const jc of jcs) {
    const wipKey = jc.wip_key ?? "";
    const dept = jc.department_code ?? "";
    const exp = expected.get(`${wipKey}::${dept}`);
    if (!exp) continue;
    const oldLabel = jc.wip_label ?? "";
    const oldCode = jc.wip_code ?? "";
    if (oldLabel === exp.wipLabel && oldCode === exp.wipCode) continue;
    plan.jcUpdates.push({
      jcId: jc.id,
      deptCode: dept,
      oldLabel,
      newLabel: exp.wipLabel,
      oldCode,
      newCode: exp.wipCode,
    });
    if (oldLabel && oldLabel !== exp.wipLabel) {
      const k = `${oldLabel}=>${exp.wipLabel}`;
      if (!seenRenames.has(k)) {
        seenRenames.add(k);
        plan.wipItemsRenames.push({ from: oldLabel, to: exp.wipLabel });
      }
    }
  }
  return plan;
}

async function applyPlan(plan: Plan): Promise<void> {
  if (plan.jcUpdates.length === 0 && plan.wipItemsRenames.length === 0) return;
  await sql.begin(async (tx) => {
    for (const u of plan.jcUpdates) {
      await tx`
        UPDATE job_cards
           SET wip_label = ${u.newLabel},
               wip_code  = ${u.newCode}
         WHERE id = ${u.jcId}
      `;
    }
    for (const r of plan.wipItemsRenames) {
      // Merge if target already exists; otherwise straight rename.
      const target = await tx<{ id: string; stock_qty: number }[]>`
        SELECT id, stock_qty FROM wip_items WHERE code = ${r.to} LIMIT 1
      `;
      const source = await tx<{ id: string; stock_qty: number }[]>`
        SELECT id, stock_qty FROM wip_items WHERE code = ${r.from} LIMIT 1
      `;
      if (source.length === 0) continue;
      if (target.length === 0) {
        await tx`UPDATE wip_items SET code = ${r.to} WHERE id = ${source[0].id}`;
      } else {
        await tx`
          UPDATE wip_items
             SET stock_qty = ${(target[0].stock_qty || 0) + (source[0].stock_qty || 0)}
           WHERE id = ${target[0].id}
        `;
        await tx`DELETE FROM wip_items WHERE id = ${source[0].id}`;
      }
    }
  });
}

async function main() {
  const pos = targetPoId
    ? await sql<ProductionOrderRow[]>`
        SELECT id, product_code, item_category, quantity,
               size_label, size_code, fabric_code,
               divan_height_inches, leg_height_inches, gap_inches
          FROM production_orders WHERE id = ${targetPoId}
      `
    : await sql<ProductionOrderRow[]>`
        SELECT id, product_code, item_category, quantity,
               size_label, size_code, fabric_code,
               divan_height_inches, leg_height_inches, gap_inches
          FROM production_orders
      `;

  let totalJcChanges = 0;
  let totalRenames = 0;
  const affected: Plan[] = [];
  for (const po of pos) {
    const plan = await planForPo(po);
    if (plan.jcUpdates.length === 0 && plan.wipItemsRenames.length === 0) continue;
    affected.push(plan);
    totalJcChanges += plan.jcUpdates.length;
    totalRenames += plan.wipItemsRenames.length;
  }

  console.log(
    `Scanned ${pos.length} POs · ${affected.length} need updates · ${totalJcChanges} JC field-changes · ${totalRenames} wip_items renames`,
  );

  for (const plan of affected.slice(0, 5)) {
    console.log(`\n${plan.poId} (${plan.productCode}):`);
    for (const u of plan.jcUpdates.slice(0, 6)) {
      console.log(`  JC ${u.jcId} [${u.deptCode}]`);
      console.log(`    label: ${u.oldLabel}  →  ${u.newLabel}`);
    }
    for (const r of plan.wipItemsRenames.slice(0, 6)) {
      console.log(`  wip_items rename: ${r.from}  →  ${r.to}`);
    }
  }
  if (affected.length > 5) {
    console.log(`\n... and ${affected.length - 5} more POs`);
  }

  if (!apply) {
    console.log("\n[dry-run] no changes written. Re-run with --apply to commit.");
    await sql.end();
    return;
  }

  let applied = 0;
  for (const plan of affected) {
    await applyPlan(plan);
    applied++;
    if (applied % 25 === 0) console.log(`  applied ${applied}/${affected.length}`);
  }
  console.log(`\nDone. Applied ${applied} PO updates.`);
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
