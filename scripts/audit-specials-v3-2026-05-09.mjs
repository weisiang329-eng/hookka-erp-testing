// Read-only audit v3 — adds rule: tokens starting with `OTHER:` are
// legitimate (they originate from the customSpecials JSON column and get
// joined into the specialOrder text column for legacy-reader compat per
// migration 0109).
//
// Token is "clean" iff:
//   - it appears verbatim in the canonical sofaSpecials/specials list, OR
//   - it starts with "OTHER:" (case-sensitive prefix per legacy joiner)
//
// Usage: node scripts/audit-specials-v3-2026-05-09.mjs
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";

const url =
  prodUrl();

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

function splitTokens(csv) {
  return String(csv).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

function isCleanToken(token, canonical) {
  if (canonical.has(token)) return true;
  if (token.startsWith("OTHER:")) return true;
  return false;
}

try {
  const kv = await sql`SELECT value FROM kv_config WHERE key = 'variants-config' LIMIT 1`;
  const kvCfg = kv[0]?.value ? JSON.parse(kv[0].value) : {};

  const mcRows = await sql`
    SELECT scope, config FROM maintenance_config_history
     WHERE effective_from <= TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')
     ORDER BY effective_from DESC, created_at DESC
  `;
  const latestByScope = new Map();
  for (const r of mcRows) {
    if (!latestByScope.has(r.scope)) latestByScope.set(r.scope, JSON.parse(r.config));
  }
  const sofaSpecialsCanonical = new Set(extractValues(kvCfg.sofaSpecials));
  const specialsCanonical = new Set(extractValues(kvCfg.specials));
  for (const [, cfg] of latestByScope) {
    for (const v of extractValues(cfg.sofaSpecials)) sofaSpecialsCanonical.add(v);
    for (const v of extractValues(cfg.specials)) specialsCanonical.add(v);
  }

  console.log(`=== Canonical (kv_config + ${latestByScope.size} maintenance scopes) ===`);
  console.log(`  sofaSpecials (${sofaSpecialsCanonical.size}): ${[...sofaSpecialsCanonical].join(" | ")}`);
  console.log(`  specials BEDFRAME (${specialsCanonical.size}): ${[...specialsCanonical].join(" | ")}`);
  console.log(`  PLUS: any token starting with "OTHER:" is also clean (customSpecials legacy join, migration 0109)`);

  for (const [tbl, cat, canon, label] of [
    ["sales_order_items", "SOFA", sofaSpecialsCanonical, "sofaSpecials → SO SOFA"],
    ["consignment_order_items", "SOFA", sofaSpecialsCanonical, "sofaSpecials → CO SOFA"],
    ["sales_order_items", "BEDFRAME", specialsCanonical, "specials → SO BEDFRAME"],
    ["consignment_order_items", "BEDFRAME", specialsCanonical, "specials → CO BEDFRAME"],
  ]) {
    const rows = await sql.unsafe(
      `SELECT special_order AS val, COUNT(*)::int AS n
         FROM "${tbl}"
        WHERE special_order IS NOT NULL
          AND special_order <> ''
          AND item_category = '${cat}'
        GROUP BY special_order
        ORDER BY n DESC, val ASC;`,
    );
    let cleanRows = 0;
    let dirtyRows = 0;
    const dirtyTokens = new Map();
    const dirtyByCategory = { snake_case: 0, free_text: 0, case_variant: 0, other: 0 };
    for (const r of rows) {
      const tokens = splitTokens(r.val);
      const allOk = tokens.length > 0 && tokens.every((t) => isCleanToken(t, canon));
      if (allOk) cleanRows += r.n;
      else {
        dirtyRows += r.n;
        for (const t of tokens) {
          if (isCleanToken(t, canon)) continue;
          dirtyTokens.set(t, (dirtyTokens.get(t) ?? 0) + r.n);
          if (/^[A-Z0-9_"]+$/.test(t) && t.includes("_")) dirtyByCategory.snake_case += r.n;
          else if ([...canon].some((c) => c.toLowerCase() === t.toLowerCase())) dirtyByCategory.case_variant += r.n;
          else if (t.toLowerCase().includes("custom") || /^stool|^csl|^\d+["']?$/i.test(t)) dirtyByCategory.free_text += r.n;
          else dirtyByCategory.other += r.n;
        }
      }
    }
    console.log(`\n=== ${label} ===`);
    console.log(`  ${cleanRows} clean / ${dirtyRows} dirty rows`);
    if (dirtyTokens.size > 0) {
      console.log(`  ${dirtyTokens.size} distinct truly-unknown token(s):`);
      const sorted = [...dirtyTokens.entries()].sort((a, b) => b[1] - a[1]);
      for (const [t, n] of sorted.slice(0, 25)) {
        console.log(`    ✗ ${JSON.stringify(t).padEnd(35)} × ${n}`);
      }
      console.log(`  category buckets: snake_case=${dirtyByCategory.snake_case}, free_text=${dirtyByCategory.free_text}, case_variant=${dirtyByCategory.case_variant}, other=${dirtyByCategory.other}`);
    }
  }
} finally {
  await sql.end();
}
