import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// One-shot backfill — strip trailing inch-quote from SOFA sizeLabel rows
// in sales_order_items + production_orders so they align with the
// kv_config.sofaSizes canonical (bare numerics: ["24","26","28","30","32","35"]).
//
// Background: cd6a417 + earlier inline normalize logic added quotes to bare
// values at SO POST/PUT, producing 257 SO + 257 PO rows like `28"`. CO POST
// has no normalize, so its 13 rows stayed as `28` (the dropdown's actual
// value). Wei Siang confirmed: "我的 dropdown 明明是 28 选了 怎么可以出来 28""
// — bare is canonical, the quoted rows are dirty.
//
// Defensive logic: strip trailing `"` ONLY when the result is a bare numeric
// AND that bare numeric is in kv_config.sofaSizes. Anything else (e.g. a
// custom `24" x 37"`) is left alone + flagged.
//
// Dry-run by default. Pass --apply to actually UPDATE.
//
// Usage:
//   node scripts/backfill-sofa-size-strip-quote-2026-05-09.mjs           # dry-run
//   node scripts/backfill-sofa-size-strip-quote-2026-05-09.mjs --apply   # write
import postgres from "postgres";

const url =
  requiredDatabaseUrl("PROD_DATABASE_URL");

const APPLY = process.argv.includes("--apply");

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

try {
  console.log(APPLY ? "MODE: APPLY (writes)" : "MODE: DRY-RUN (read-only)");

  const kv = await sql`SELECT value FROM kv_config WHERE key = 'variants-config' LIMIT 1`;
  if (!kv[0]?.value) {
    console.error("kv_config variants-config row missing — abort");
    process.exit(1);
  }
  const cfg = JSON.parse(kv[0].value);
  const canonical = new Set(
    Array.isArray(cfg.sofaSizes)
      ? cfg.sofaSizes.filter((s) => typeof s === "string")
      : [],
  );
  if (canonical.size === 0) {
    console.error("kv_config.sofaSizes is empty — abort");
    process.exit(1);
  }
  console.log(`canonical sofaSizes: ${[...canonical].join(", ")}`);

  for (const tbl of ["sales_order_items", "production_orders"]) {
    console.log(`\n=== ${tbl} ===`);
    // Pull every SOFA row whose size_label matches `<digits>"` pattern.
    const rows = await sql.unsafe(
      `SELECT id, size_label
         FROM "${tbl}"
        WHERE item_category = 'SOFA'
          AND size_label IS NOT NULL
          AND size_label ~ '^[0-9]+(\\.[0-9]+)?"$'
        ORDER BY size_label;`,
    );
    console.log(`  candidate rows (match regex): ${rows.length}`);

    const updates = [];
    const skipped = [];
    for (const r of rows) {
      const stripped = r.size_label.replace(/"$/, "");
      if (canonical.has(stripped)) {
        updates.push({ id: r.id, from: r.size_label, to: stripped });
      } else {
        skipped.push({ id: r.id, from: r.size_label, stripped });
      }
    }
    console.log(`  would-update: ${updates.length}`);
    console.log(`  would-skip (stripped not in canonical): ${skipped.length}`);
    if (skipped.length > 0) {
      console.log(`  skipped sample:`);
      for (const s of skipped.slice(0, 5)) {
        console.log(`    id=${s.id} from="${s.from}" stripped="${s.stripped}"`);
      }
    }

    // Group updates by (from, to) for a compact preview
    const byPair = new Map();
    for (const u of updates) {
      const k = `${u.from} → ${u.to}`;
      byPair.set(k, (byPair.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...byPair.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k}  × ${n}`);
    }

    if (APPLY && updates.length > 0) {
      // Atomic: one UPDATE per row by id. Postgres handles the regex
      // already so we could do `UPDATE ... SET size_label = REGEXP_REPLACE(...)
      // WHERE size_label ~ ...` — but listing IDs gives the script better
      // logs + lets us cap the safety check (only touch rows whose stripped
      // value is canonical).
      const ids = updates.map((u) => u.id);
      const { count } = await sql.unsafe(
        `UPDATE "${tbl}"
            SET size_label = REGEXP_REPLACE(size_label, '"$', '')
          WHERE id = ANY($1::text[])
            AND item_category = 'SOFA'
            AND size_label ~ '^[0-9]+(\\.[0-9]+)?"$';`,
        [ids],
      );
      console.log(`  UPDATED: ${count} row(s)`);
    }
  }

  console.log(APPLY ? "\nDONE — rows updated." : "\nDONE — dry-run only. Re-run with --apply to write.");
} finally {
  await sql.end();
}
