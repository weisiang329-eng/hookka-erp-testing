// Read-only audit — surfaces:
//   1. Current canonical sofa size catalog from kv_config.variants-config
//      AND the resolved maintenance_config (master scope).
//   2. Distinct sizeLabel values that have actually landed in
//      sales_order_items + consignment_order_items for SOFA lines.
//   3. Distinct sizeLabel values on production_orders SOFA rows.
//   4. Any rows whose sizeLabel doesn't match an entry in the kv_config
//      canonical list — these are the "would-be-rejected" rows once the
//      DUP-001 backend gate goes in.
//
// Wei Siang's principle (2026-05-09): backend should reject anything not
// in the dropdown source. If `28` and `28"` both exist in DB, the source
// is the bug — we don't normalize on write, we clean the source + add a
// gate that rejects bad values.
//
// Usage: node scripts/audit-sofa-sizes-2026-05-09.mjs
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";

const url =
  prodUrl();

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

try {
  console.log("=== kv_config.variants-config.sofaSizes ===");
  const kv = await sql`SELECT value FROM kv_config WHERE key = 'variants-config' LIMIT 1`;
  let kvSofaSizes = [];
  if (kv[0]?.value) {
    try {
      const cfg = JSON.parse(kv[0].value);
      kvSofaSizes = Array.isArray(cfg.sofaSizes) ? cfg.sofaSizes : [];
      console.log(`  ${kvSofaSizes.length} entries:`);
      for (const s of kvSofaSizes) console.log(`    ${JSON.stringify(s)}`);
    } catch (e) {
      console.log(`  parse failed: ${e.message}`);
    }
  } else {
    console.log("  (no kv_config row found)");
  }

  console.log("\n=== maintenance_config_history (master, latest effective row) ===");
  const mc = await sql`
    SELECT effective_from, config
      FROM maintenance_config_history
     WHERE scope = 'master'
       AND effective_from <= TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')
     ORDER BY effective_from DESC, created_at DESC
     LIMIT 1
  `;
  let mcSofaSizes = [];
  if (mc[0]?.config) {
    try {
      const cfg = JSON.parse(mc[0].config);
      // Try common shapes — sofaSizes / variants.sofa.sizes / sofa.sizes
      mcSofaSizes =
        (Array.isArray(cfg.sofaSizes) && cfg.sofaSizes) ||
        (cfg.variants?.sofa?.sizes && Array.isArray(cfg.variants.sofa.sizes) ? cfg.variants.sofa.sizes : null) ||
        (cfg.sofa?.sizes && Array.isArray(cfg.sofa.sizes) ? cfg.sofa.sizes : null) ||
        [];
      console.log(`  effective_from = ${mc[0].effective_from}`);
      console.log(`  ${mcSofaSizes.length} sofa size entries:`);
      for (const s of mcSofaSizes) console.log(`    ${JSON.stringify(s)}`);
    } catch (e) {
      console.log(`  parse failed: ${e.message}`);
    }
  } else {
    console.log("  (no maintenance_config_history master row found)");
  }

  // Use kv_config as the authoritative list for the dirty-row check.
  // Normalize to plain string entries. (kv_config can hold either raw
  // strings or {value: "..."} objects depending on UI vintage.)
  const canonicalSet = new Set();
  const rawCanonical = kvSofaSizes.length > 0 ? kvSofaSizes : mcSofaSizes;
  for (const s of rawCanonical) {
    const v = typeof s === "string" ? s : s?.value;
    if (typeof v === "string" && v.length > 0) canonicalSet.add(v);
  }
  const canonical = Array.from(canonicalSet).sort();
  console.log(`\n=== Canonical (deduped) used for dirty check: ${canonical.length} entries ===`);
  for (const s of canonical) console.log(`    ${JSON.stringify(s)}`);

  for (const tbl of [
    "sales_order_items",
    "consignment_order_items",
    "production_orders",
  ]) {
    console.log(`\n=== ${tbl}: distinct SOFA sizeLabel values + counts ===`);
    const rows = await sql.unsafe(
      `SELECT size_label AS label, COUNT(*)::int AS n
         FROM "${tbl}"
        WHERE item_category = 'SOFA'
          AND size_label IS NOT NULL
          AND size_label <> ''
        GROUP BY size_label
        ORDER BY n DESC, label ASC;`,
    );
    if (rows.length === 0) {
      console.log("  (no SOFA rows)");
      continue;
    }
    let dirty = 0;
    for (const r of rows) {
      const ok = canonicalSet.has(r.label);
      const flag = ok ? "  ok " : "  ✗  ";
      console.log(`  ${flag} ${(r.label ?? "(null)").padEnd(12)} × ${r.n}`);
      if (!ok) dirty += r.n;
    }
    console.log(`  → would-be-rejected: ${dirty} row(s) total`);
  }
} finally {
  await sql.end();
}
