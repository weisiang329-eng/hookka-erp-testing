import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBugIndex,
  parseBugHistory,
  searchBugHistory,
} from "./lib/bug-history.mjs";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const SOURCE_PATH = resolve(ROOT, "docs/BUG-HISTORY.md");
const INDEX_PATH = resolve(ROOT, "docs/bug-history-index.json");
const POLICY_FROM = "2026-07-20";

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function validateBugHistory(entries) {
  const errors = [];
  const seen = new Map();
  for (const entry of entries) {
    seen.set(entry.id, (seen.get(entry.id) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count > 1) errors.push(`${id} is used ${count} times; bug IDs must be unique.`);
  }

  for (const entry of entries.filter(({ date }) => date >= POLICY_FROM)) {
    const prefix = entry.id;
    if (!entry.headingHasStatus) {
      errors.push(`${prefix}: heading needs a status marker (🔴, 🟡, or 🟢).`);
    }
    if (entry.categories.length === 0) {
      errors.push(`${prefix}: heading needs at least one \`category-tag\`.`);
    }
    if (["Fixed", "Partial"].includes(entry.status)) {
      if (!entry.hasRootCause) errors.push(`${prefix}: fixed entry needs **Root cause:**.`);
      if (!entry.hasFix) errors.push(`${prefix}: fixed entry needs **Fix:**.`);
      if (entry.tests.length === 0 && !entry.regressionWaiver) {
        errors.push(
          `${prefix}: fixed entry needs a tests/*.test.mjs reference or ` +
            `"Regression: N/A — <specific reason>".`,
        );
      }
    }
    for (const test of entry.tests) {
      if (!existsSync(resolve(ROOT, test))) {
        errors.push(`${prefix}: referenced regression test does not exist: ${test}`);
      }
    }
  }
  return errors;
}

function printSearch(entries, query) {
  const matches = searchBugHistory(entries, query);
  if (matches.length === 0) {
    console.log(`[bug-history] no matches for "${query}"`);
    return;
  }
  for (const entry of matches) {
    console.log(
      `${entry.id} ${entry.statusIcon} [${entry.categories.join(", ")}] ${entry.title}`,
    );
    if (entry.tests.length > 0) console.log(`  tests: ${entry.tests.join(", ")}`);
  }
}

const raw = readFileSync(SOURCE_PATH, "utf8");
const entries = parseBugHistory(raw);
const index = buildBugIndex(entries, POLICY_FROM);
const expected = serialize(index);
const [command, ...rest] = process.argv.slice(2);

if (command === "--search") {
  printSearch(entries, rest.join(" "));
  process.exit(0);
}

const errors = validateBugHistory(entries);
if (command === "--check") {
  const current = existsSync(INDEX_PATH) ? readFileSync(INDEX_PATH, "utf8") : "";
  if (current !== expected) {
    errors.push("docs/bug-history-index.json is stale; run npm run bugs:index.");
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`[bug-history] ERROR: ${error}`);
    process.exit(1);
  }
  console.log(
    `[bug-history] OK — ${entries.length} unique entries; policy enforced from ${POLICY_FROM}.`,
  );
  process.exit(0);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[bug-history] ERROR: ${error}`);
  process.exit(1);
}
writeFileSync(INDEX_PATH, expected, "utf8");
console.log(`[bug-history] wrote ${INDEX_PATH} (${entries.length} entries).`);
