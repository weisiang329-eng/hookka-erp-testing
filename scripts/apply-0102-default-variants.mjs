import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// One-shot migration applier for 0102_product_default_variants.sql.
// Adds the column directly + records the migration in _migrations so the
// incremental applier won't re-run it.
import postgres from "postgres";
import fs from "node:fs";

const PROD = requiredDatabaseUrl("PROD_DATABASE_URL");
const sql = postgres(PROD, { ssl: "require", max: 1, idle_timeout: 5, prepare: false });

const FILE = "0102_product_default_variants.sql";
const PATH = `migrations-postgres/${FILE}`;

try {
  console.log(`\n== Applying ${FILE} ==`);

  // Pre-check: is the column already there?
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'products' AND column_name = 'default_variants';
  `;
  if (cols.length > 0) {
    console.log("  Column products.default_variants already exists. Skipping ALTER.");
  } else {
    const sqlText = fs.readFileSync(PATH, "utf8");
    console.log("  Running migration...");
    await sql.unsafe(sqlText);
    console.log("  Column added.");
  }

  // Verify _migrations tracker is up.
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  const tracker = await sql`SELECT 1 FROM _migrations WHERE filename = ${FILE};`;
  if (tracker.length > 0) {
    console.log(`  Tracker row already exists for ${FILE}.`);
  } else {
    await sql`INSERT INTO _migrations (filename) VALUES (${FILE});`;
    console.log(`  Recorded ${FILE} in _migrations.`);
  }

  // Final check
  const verify = await sql`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'products' AND column_name = 'default_variants';
  `;
  console.log("\nFinal column state:");
  console.log(JSON.stringify(verify, null, 2));

  console.log("\n✓ DONE");
} finally {
  await sql.end();
}
