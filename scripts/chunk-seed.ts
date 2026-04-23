// Split migrations/seed.sql into size-bounded chunks suitable for
// `wrangler d1 execute --remote --file=<chunk>`.
//
// D1 rejects a single request body over ~1MB (SQLITE_TOOBIG). We target
// ~400KB per chunk to stay well clear of the limit.
//
// Output: migrations/seed-chunks/NNN_<section>.sql

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.resolve(__dirname, "./seed.sql");
const OUT_DIR = path.resolve(__dirname, "../migrations/seed-chunks");
const TARGET_BYTES = 400_000;

const raw = fs.readFileSync(SEED, "utf8");

// Strip the outer BEGIN/COMMIT — each chunk wraps its own. Keep section
// comments so the split files are readable.
const stripped = raw
  .replace(/^\s*BEGIN TRANSACTION;\s*$/m, "")
  .replace(/^\s*COMMIT;\s*$/m, "")
  .replace(/^\s*PRAGMA defer_foreign_keys = TRUE;\s*$/m, "");

// Split into logical statements. seed.sql is generated — every INSERT is
// on a single line ending in ';'. Comments use '--'. Split on lines, then
// regroup consecutive comment+INSERT pairs.
const lines = stripped.split(/\r?\n/);

type Chunk = { name: string; body: string[] };
const chunks: Chunk[] = [];
let current: Chunk = { name: "", body: [] };
let currentBytes = 0;
let sectionLabel = "misc";

function flush() {
  if (current.body.length === 0) return;
  current.name = sectionLabel;
  chunks.push(current);
  current = { name: "", body: [] };
  currentBytes = 0;
}

for (const line of lines) {
  // Track section headers like `-- ========... Sales orders ...`.
  const sectionMatch = line.match(/^-- \s*([A-Za-z][\w &/+\-]+)\s*$/);
  if (sectionMatch && lines[lines.indexOf(line) - 1]?.startsWith("-- ====")) {
    const label = sectionMatch[1]
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    if (label) sectionLabel = label;
  }

  if (currentBytes + line.length + 1 > TARGET_BYTES && currentBytes > 0) {
    flush();
  }
  current.body.push(line);
  currentBytes += line.length + 1;
}
flush();

// Write chunks
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

chunks.forEach((chunk, i) => {
  const n = String(i + 1).padStart(3, "0");
  const file = path.join(OUT_DIR, `${n}_${chunk.name}.sql`);
  // No BEGIN/COMMIT/PRAGMA — D1 rejects SQL-level transaction markers
  // and manages the transaction itself. seed.sql is already ordered so
  // parent rows precede children.
  fs.writeFileSync(file, chunk.body.join("\n") + "\n");
});

// Summary
const totalBytes = chunks.reduce((s, c) => s + c.body.join("\n").length, 0);
console.log(`Wrote ${chunks.length} chunks to ${OUT_DIR}`);
console.log(`Total body bytes: ${totalBytes}`);
chunks.forEach((c, i) => {
  const size = c.body.join("\n").length;
  console.log(`  ${String(i + 1).padStart(3, "0")}_${c.name}.sql  ${size} bytes  ${c.body.filter(l => l.startsWith("INSERT")).length} inserts`);
});
