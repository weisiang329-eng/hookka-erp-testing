// One-off cleanup of staging Option-C schema:
//   1. Set merged FC JCs' wip_type = itemCategory (BEDFRAME/SOFA/ACCESSORY)
//      instead of anchor's per-piece wip_type (DIVAN, SOFA_BASE, ...).
//   2. Strip the duplicate "(sizeLabel) | " segment from SOFA wipLabels
//      that came out as e.g. "5530-2A(LHF)+L(RHF) | (2A(LHF)) | PC151-18
//      | (FC)" before the buildFcWipLabel fix.
//   3. Sync wip_items.code + wip_items.type for any rows whose code/type
//      now diverge from the JC.
//   4. Decrement stock_qty for SO-2604-347's FC wip_item that didn't get
//      consumed under the old buggy SEW cascade.
import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";

const sql = postgres(
  stagingUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

function buildFcWipLabel({ modelLabel, sizeLabel, totalH, divanHeightInches, fabricCode, isBF }) {
  return [
    modelLabel,
    isBF && sizeLabel ? `(${sizeLabel})` : "",
    isBF && totalH > 0 ? `(${totalH}")` : "",
    isBF && divanHeightInches ? `(DV ${divanHeightInches}")` : "",
    fabricCode || "",
    "(FC)",
  ].filter(Boolean).join(" | ");
}

function joinModelLabel(productCodes) {
  const unique = [...new Set(productCodes.filter(Boolean))];
  if (unique.length === 0) return "";
  if (unique.length === 1) return unique[0];
  const firstDash = unique[0].indexOf("-");
  if (firstDash > 0) {
    const prefix = unique[0].slice(0, firstDash + 1);
    if (unique.every((m) => m.startsWith(prefix))) {
      return prefix + unique.map((m) => m.slice(prefix.length)).join("+");
    }
  }
  return unique.join("+");
}

try {
  console.log("=== Step 1: Pull all merged FC JCs + their PO context ===");
  const fcs = await sql`
    SELECT jc.id, jc.wip_key, jc.wip_label, jc.wip_type AS old_wip_type,
           po.id AS po_id, po.item_category, po.product_code, po.size_label,
           po.gap_inches, po.divan_height_inches, po.leg_height_inches,
           po.fabric_code, po.company_so_id
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.production_order_id
    WHERE jc.department_code = 'FAB_CUT'
      AND jc.wip_key LIKE '%::FAB_CUT';
  `;
  console.log(`Found ${fcs.length} merged FC JCs`);

  // For SOFA cross-PO merged JCs, we need ALL sibling POs to rebuild the
  // joined modelLabel. Group SOFA FCs by wip_key.
  const sofaGroups = new Map();
  for (const fc of fcs) {
    if (fc.item_category === "SOFA") {
      if (!sofaGroups.has(fc.wip_key)) sofaGroups.set(fc.wip_key, []);
      sofaGroups.get(fc.wip_key).push(fc);
    }
  }

  // For each SOFA group, fetch all member POs to rebuild the modelLabel.
  console.log("\n=== Step 2: Fetch SOFA group member POs ===");
  for (const [wipKey, group] of sofaGroups) {
    // wipKey shape: SO-XXXX::baseModel::fabric::FAB_CUT
    const [companySOId, baseModel, fabric] = wipKey.split("::");
    const sibs = await sql`
      SELECT product_code FROM production_orders
      WHERE company_so_id = ${companySOId}
        AND fabric_code = ${fabric}
        AND product_code LIKE ${baseModel + "-%"};
    `;
    const productCodes = sibs.map((s) => s.product_code);
    group._modelLabel = joinModelLabel(productCodes);
  }

  console.log("\n=== Step 3: Update each FC JC ===");
  let updated = 0;
  let unchanged = 0;
  for (const fc of fcs) {
    const isBF = fc.item_category === "BEDFRAME";
    const isSofa = fc.item_category === "SOFA";
    const totalH =
      (fc.gap_inches ?? 0) +
      (fc.divan_height_inches ?? 0) +
      (fc.leg_height_inches ?? 0);
    const modelLabel = isSofa
      ? sofaGroups.get(fc.wip_key)?._modelLabel || fc.product_code
      : fc.product_code;
    const newLabel = buildFcWipLabel({
      modelLabel,
      sizeLabel: fc.size_label || "",
      totalH,
      divanHeightInches: fc.divan_height_inches,
      fabricCode: fc.fabric_code || "",
      isBF,
    });
    const newWipType = fc.item_category || "FAB_CUT";
    if (newLabel === fc.wip_label && newWipType === fc.old_wip_type) {
      unchanged++;
      continue;
    }
    await sql`
      UPDATE job_cards
      SET wip_label = ${newLabel}, wip_type = ${newWipType}
      WHERE id = ${fc.id};
    `;
    if (newLabel !== fc.wip_label) {
      // Rename wip_items.code from old → new. If a row already exists at
      // the new code (UNIQUE (org_id, code)), merge stock + delete the
      // old row instead of renaming.
      const existingNew = await sql`
        SELECT id, stock_qty, status, dept_status FROM wip_items
        WHERE code = ${newLabel}
        LIMIT 1;
      `;
      const oldRows = await sql`
        SELECT id, stock_qty FROM wip_items
        WHERE code = ${fc.wip_label};
      `;
      if (existingNew.length > 0 && oldRows.length > 0) {
        // Merge: add old stock to existing-new row, then delete old.
        const sumOld = oldRows.reduce((s, r) => s + (r.stock_qty || 0), 0);
        await sql`
          UPDATE wip_items
          SET stock_qty = stock_qty + ${sumOld}, type = ${newWipType}
          WHERE id = ${existingNew[0].id};
        `;
        for (const o of oldRows) {
          await sql`DELETE FROM wip_items WHERE id = ${o.id};`;
        }
      } else if (oldRows.length > 0) {
        // No conflict — just rename.
        await sql`
          UPDATE wip_items
          SET code = ${newLabel}, type = ${newWipType}
          WHERE code = ${fc.wip_label};
        `;
      } else if (existingNew.length > 0) {
        // Old missing, new present — just retype.
        await sql`
          UPDATE wip_items
          SET type = ${newWipType}
          WHERE code = ${newLabel};
        `;
      }
    } else {
      await sql`
        UPDATE wip_items
        SET type = ${newWipType}
        WHERE code = ${fc.wip_label};
      `;
    }
    updated++;
  }
  console.log(`Updated ${updated} JCs (+${unchanged} unchanged)`);

  console.log("\n=== Step 4: Dedup wip_items collisions on the new labels ===");
  // After re-labelling, two rows may now share the same code (e.g. one runtime
  // wip-dyn-* and one wip-fc-jc-*). Sum stock + keep oldest id.
  const dups = await sql`
    SELECT code, COUNT(*) AS n FROM wip_items
    WHERE code LIKE '%(FC)%'
    GROUP BY code HAVING COUNT(*) >= 2;
  `;
  console.log(`Duplicate codes: ${dups.length}`);
  for (const d of dups) {
    const rows = await sql`
      SELECT id, stock_qty, status, dept_status FROM wip_items
      WHERE code = ${d.code}
      ORDER BY id;
    `;
    const keep = rows[0];
    const totalQty = rows.reduce((s, r) => s + (r.stock_qty || 0), 0);
    const keepStatus = rows.find((r) => r.status === "COMPLETED") ? "COMPLETED" : keep.status;
    const keepDept = rows.find((r) => r.dept_status === "FAB_CUT") ? "FAB_CUT" : keep.dept_status;
    await sql`
      UPDATE wip_items SET stock_qty = ${totalQty}, status = ${keepStatus}, dept_status = ${keepDept}
      WHERE id = ${keep.id};
    `;
    for (const r of rows.slice(1)) {
      await sql`DELETE FROM wip_items WHERE id = ${r.id};`;
    }
    console.log(`  Merged ${rows.length} rows for "${d.code}" → keep ${keep.id} stockQty=${totalQty}`);
  }

  console.log("\n=== Step 5: Cleanup SO-2604-347 stock_qty (consume that the buggy cascade missed) ===");
  // The DV piece SEW completed under the old buggy cascade — it should have
  // decremented FC stock_qty by 1.
  const so347fc = await sql`
    SELECT id, stock_qty FROM wip_items
    WHERE code = '1013-(Q) | (5FT) | (24") | (DV 8") | PC151-18 | (FC)';
  `;
  if (so347fc[0]) {
    const newQty = Math.max(0, (so347fc[0].stock_qty || 0) - 1);
    await sql`
      UPDATE wip_items SET stock_qty = ${newQty}
      WHERE id = ${so347fc[0].id};
    `;
    console.log(`  ${so347fc[0].id}: stock_qty ${so347fc[0].stock_qty} → ${newQty}`);
  } else {
    console.log("  (FC wip_item not found, skipping)");
  }
} finally {
  await sql.end();
}
