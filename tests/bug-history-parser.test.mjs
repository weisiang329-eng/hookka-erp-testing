import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBugIndex,
  parseBugHistory,
  searchBugHistory,
} from "../scripts/lib/bug-history.mjs";

const MODERN = `
## BUG-2026-07-20-001 — cache served stale stock after dispatch \`inventory\` \`snapshot\` 🟢
**Root cause:** the invalidation list omitted stock movements.
**Fix:** use the shared invalidation helper.
**Regression test:** \`tests/snapshot-freshness.test.mjs\`.
`;

test("modern heading exposes title, all categories, status and test", () => {
  const [entry] = parseBugHistory(MODERN);
  assert.equal(entry.id, "BUG-2026-07-20-001");
  assert.equal(entry.title, "cache served stale stock after dispatch");
  assert.deepEqual(entry.categories, ["inventory", "snapshot"]);
  assert.equal(entry.status, "Fixed");
  assert.deepEqual(entry.tests, ["tests/snapshot-freshness.test.mjs"]);
  assert.equal(entry.hasRootCause, true);
  assert.equal(entry.hasFix, true);
});

test("legacy Status and Category fields remain readable", () => {
  const [entry] = parseBugHistory(`
## BUG-2026-06-01-001 — legacy entry
**Status:** Fixed (2026-06-02)
**Category:** accounting
`);
  assert.equal(entry.status, "Fixed");
  assert.equal(entry.statusIcon, "🟢");
  assert.equal(entry.statusDate, "2026-06-02");
  assert.deepEqual(entry.categories, ["accounting"]);
});

test("index is deterministic and search includes root-cause prose", () => {
  const entries = parseBugHistory(MODERN);
  const first = buildBugIndex(entries, "2026-07-20");
  const second = buildBugIndex(entries, "2026-07-20");
  assert.deepEqual(first, second);
  assert.equal("generatedAt" in first, false);
  assert.equal(searchBugHistory(entries, "invalidation")[0]?.id, entries[0].id);
});
