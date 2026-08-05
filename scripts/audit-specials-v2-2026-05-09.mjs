// Read-only audit v2 — fixes the previous script's bugs:
//   1. CSV split now uses BOTH `;` and `,` (data uses semicolon, my v1 only
//      tried comma → false-positive dirty count).
//   2. Trims whitespace per token.
//   3. Pulls canonical from kv_config + maintenance_config_history (master)
//      + ALL customer scopes — Wei Siang's UI may write per-customer
//      overrides that v1 missed.
//
// Goal: surface only the rows whose tokens TRULY don't appear in any
// reachable canonical list.
//
// Usage: node scripts/audit-specials-v2-2026-05-09.mjs
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

try {
  // ----- Pull every canonical source -----
  const kv = await sql`SELECT value FROM kv_config WHERE key = 'variants-config' LIMIT 1`;
  const kvCfg = kv[0]?.value ? JSON.parse(kv[0].value) : {};

  const mcRows = await sql`
    SELECT scope, config
      FROM maintenance_config_history
     WHERE effective_from <= TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')
     ORDER BY effective_from DESC, created_at DESC
  `;
  // Latest config per scope
  const latestByScope = new Map();
  for (const r of mcRows) {
    if (!latestByScope.has(r.scope)) latestByScope.set(r.scope, JSON.parse(r.config));
  }

  // Union of canonical for sofaSpecials
  const sofaSpecialsCanonical = new Set(extractValues(kvCfg.sofaSpecials));
  for (const [, cfg] of latestByScope) {
    for (const v of extractValues(cfg.sofaSpecials)) sofaSpecialsCanonical.add(v);
  }
  const specialsCanonical = new Set(extractValues(kvCfg.specials));
  for (const [, cfg] of latestByScope) {
    for (const v of extractValues(cfg.specials)) specialsCanonical.add(v);
  }

  console.log(`=== Canonical sources merged ===`);
  console.log(`  scopes scanned: kv_config + ${latestByScope.size} maintenance_config scope(s) (${[...latestByScope.keys()].join(", ")})`);
  console.log(`  sofaSpecials canonical (${sofaSpecialsCanonical.size}): ${[...sofaSpecialsCanonical].join(" | ")}`);
  console.log(`  specials (BEDFRAME) canonical (${specialsCanonical.size}): ${[...specialsCanonical].join(" | ")}`);

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
    const dirtySamples = [];
    const dirtyTokens = new Map();
    for (const r of rows) {
      const tokens = splitTokens(r.val);
      const allOk = tokens.length > 0 && tokens.every((t) => canon.has(t));
      if (allOk) cleanRows += r.n;
      else {
        dirtyRows += r.n;
        dirtySamples.push({ val: r.val, n: r.n });
        for (const t of tokens) {
          if (!canon.has(t)) dirtyTokens.set(t, (dirtyTokens.get(t) ?? 0) + r.n);
        }
      }
    }
    console.log(`\n=== ${label} ===`);
    console.log(`  ${cleanRows} clean / ${dirtyRows} dirty rows`);
    if (dirtyTokens.size > 0) {
      console.log(`  ${dirtyTokens.size} distinct truly-unknown token(s):`);
      const sorted = [...dirtyTokens.entries()].sort((a, b) => b[1] - a[1]);
      for (const [t, n] of sorted.slice(0, 20)) {
        console.log(`    ✗ ${JSON.stringify(t).padEnd(35)} × ${n}`);
      }
      if (sorted.length > 20) console.log(`    ... +${sorted.length - 20} more`);
    }
  }
} finally {
  await sql.end();
}
