import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// Read-only audit — for every kv_config-backed dropdown that lands on
// SO/CO line items, check whether the DB-stored values are a strict
// subset of what's currently in kv_config.
//
// Configs covered:
//   sofaSizes        → sales_order_items.size_label  (SOFA only) — already known dirty
//   sofaSpecials     → sales/co_items.special_order  (SOFA, CSV split)
//   specials         → sales/co_items.special_order  (BEDFRAME, CSV split)
//   sofaLegHeights   → sales/co_items.leg_height_inches (SOFA, numeric/string mix)
//   divanHeights     → sales/co_items.divan_height_inches (BEDFRAME, numeric)
//   legHeights       → sales/co_items.leg_height_inches  (BEDFRAME, numeric)
//   totalHeights     → not directly stored — derived
//   gaps             → sales/co_items.gap_inches      (BEDFRAME, numeric)
//
// Also checks BEDFRAME sales_order_items.size_label against
// products.size_label (product master FK).
//
// Usage: node scripts/audit-all-config-drift-2026-05-09.mjs
import postgres from "postgres";

const url =
  requiredDatabaseUrl("PROD_DATABASE_URL");

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

function extractValues(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => {
      if (typeof x === "string") return x;
      if (x && typeof x === "object" && "value" in x) {
        const v = x.value;
        return typeof v === "string" ? v : String(v ?? "");
      }
      return "";
    })
    .filter(Boolean);
}

function asSet(values) {
  return new Set(values);
}

async function auditEnumColumn({
  label,
  canonical,
  table,
  column,
  itemCategoryFilter,
  splitCsv = false,
}) {
  const catSet = asSet(canonical);
  const filter = itemCategoryFilter
    ? `AND item_category = '${itemCategoryFilter}'`
    : "";
  const rows = await sql.unsafe(
    `SELECT ${column} AS val, COUNT(*)::int AS n
       FROM "${table}"
      WHERE ${column} IS NOT NULL
        AND ${column} <> ''
        ${filter}
      GROUP BY ${column}
      ORDER BY n DESC, ${column} ASC;`,
  );

  let dirty = 0;
  let clean = 0;
  const dirtyValues = [];
  for (const r of rows) {
    if (splitCsv) {
      const parts = String(r.val).split(",").map((s) => s.trim()).filter(Boolean);
      const allOk = parts.length > 0 && parts.every((p) => catSet.has(p));
      if (allOk) clean += r.n;
      else { dirty += r.n; dirtyValues.push({ val: r.val, n: r.n }); }
    } else {
      const ok = catSet.has(String(r.val));
      if (ok) clean += r.n;
      else { dirty += r.n; dirtyValues.push({ val: r.val, n: r.n }); }
    }
  }

  console.log(`\n=== ${label} ===`);
  console.log(`  canonical (${catSet.size}): ${[...catSet].slice(0, 10).join(", ")}${catSet.size > 10 ? " ..." : ""}`);
  console.log(`  ${table}.${column}${itemCategoryFilter ? ` (${itemCategoryFilter})` : ""}: ${clean} clean / ${dirty} dirty`);
  if (dirtyValues.length > 0) {
    console.log(`  dirty values:`);
    for (const d of dirtyValues.slice(0, 15)) {
      console.log(`    ✗ ${JSON.stringify(d.val).padEnd(30)} × ${d.n}`);
    }
    if (dirtyValues.length > 15) console.log(`    ... +${dirtyValues.length - 15} more`);
  }
}

try {
  // Pull canonical lists from kv_config (the live source)
  const kv = await sql`SELECT value FROM kv_config WHERE key = 'variants-config' LIMIT 1`;
  const cfg = kv[0]?.value ? JSON.parse(kv[0].value) : {};
  const canonical = {
    sofaSizes: extractValues(cfg.sofaSizes),
    sofaSpecials: extractValues(cfg.sofaSpecials),
    sofaLegHeights: extractValues(cfg.sofaLegHeights),
    specials: extractValues(cfg.specials),
    divanHeights: extractValues(cfg.divanHeights),
    legHeights: extractValues(cfg.legHeights),
    totalHeights: extractValues(cfg.totalHeights),
    gaps: extractValues(cfg.gaps),
  };
  console.log("=== kv_config canonical sizes per category ===");
  for (const [k, v] of Object.entries(canonical)) {
    console.log(`  ${k.padEnd(16)}: ${v.length} entries`);
  }

  // 1. sofaSizes (already known dirty)
  await auditEnumColumn({
    label: "sofaSizes → sales_order_items.size_label (SOFA)",
    canonical: canonical.sofaSizes,
    table: "sales_order_items",
    column: "size_label",
    itemCategoryFilter: "SOFA",
  });
  await auditEnumColumn({
    label: "sofaSizes → consignment_order_items.size_label (SOFA)",
    canonical: canonical.sofaSizes,
    table: "consignment_order_items",
    column: "size_label",
    itemCategoryFilter: "SOFA",
  });

  // 2. sofaSpecials (SOFA only)
  await auditEnumColumn({
    label: "sofaSpecials → sales_order_items.special_order (SOFA, CSV)",
    canonical: canonical.sofaSpecials,
    table: "sales_order_items",
    column: "special_order",
    itemCategoryFilter: "SOFA",
    splitCsv: true,
  });
  await auditEnumColumn({
    label: "sofaSpecials → consignment_order_items.special_order (SOFA, CSV)",
    canonical: canonical.sofaSpecials,
    table: "consignment_order_items",
    column: "special_order",
    itemCategoryFilter: "SOFA",
    splitCsv: true,
  });

  // 3. specials (BEDFRAME)
  await auditEnumColumn({
    label: "specials → sales_order_items.special_order (BEDFRAME, CSV)",
    canonical: canonical.specials,
    table: "sales_order_items",
    column: "special_order",
    itemCategoryFilter: "BEDFRAME",
    splitCsv: true,
  });
  await auditEnumColumn({
    label: "specials → consignment_order_items.special_order (BEDFRAME, CSV)",
    canonical: canonical.specials,
    table: "consignment_order_items",
    column: "special_order",
    itemCategoryFilter: "BEDFRAME",
    splitCsv: true,
  });

  // 4. BEDFRAME sizeLabel — must match products.size_label per productCode
  console.log(`\n=== BEDFRAME size_label vs products master ===`);
  const bfMismatch = await sql`
    SELECT soi.size_label AS soi_size, p.size_label AS catalog_size, soi.product_code, COUNT(*)::int AS n
      FROM sales_order_items soi
      JOIN products p ON p.code = soi.product_code
     WHERE soi.item_category = 'BEDFRAME'
       AND soi.size_label IS NOT NULL
       AND soi.size_label <> ''
       AND p.size_label IS NOT NULL
       AND soi.size_label <> p.size_label
     GROUP BY soi.size_label, p.size_label, soi.product_code
     ORDER BY n DESC
     LIMIT 20;
  `;
  if (bfMismatch.length === 0) {
    console.log(`  ✓ all sales_order_items BEDFRAME rows match products.size_label`);
  } else {
    console.log(`  ✗ ${bfMismatch.length} mismatch(es):`);
    for (const r of bfMismatch) {
      console.log(`    ${r.product_code.padEnd(18)} stored="${r.soi_size}" catalog="${r.catalog_size}" × ${r.n}`);
    }
  }
} finally {
  await sql.end();
}
