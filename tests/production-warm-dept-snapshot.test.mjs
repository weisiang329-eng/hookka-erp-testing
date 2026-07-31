// ---------------------------------------------------------------------------
// production-warm-dept-snapshot.test.mjs — the per-dept snapshot warmer (perf
// 2026-07-31). Dept sheets (Fab Cut / Fab Sew / … / Packing) each have a
// DISTINCT snapshot key the delivery/planning warmers don't cover, so the first
// operator to open one post-deploy paid a ~5–8s cold recompute. The warm cron
// now pre-builds each dept variant with the exact key the dept page requests.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const helpers = readFileSync(resolve(process.cwd(), "src/api/routes/production-orders/_helpers.ts"), "utf8");
const route = readFileSync(resolve(process.cwd(), "src/api/routes/production-orders.ts"), "utf8");
const worker = readFileSync(resolve(process.cwd(), "src/api/worker.ts"), "utf8");

test("warmPoListDeptVariant builds the dept sheet's exact snapshot key", () => {
  const f = helpers.replace(/\s+/g, " ");
  assert.match(f, /export async function warmPoListDeptVariant\(/);
  // key must equal the dept page's sorted &-joined query string
  assert.match(f, /const snapshotCacheKey = `dept=\$\{dept\}&excludeCompleted=true&fields=minimal`/);
  // built via the same fetchFilteredPOs path (deptFilter + excludeCompleted)
  assert.match(f, /await fetchFilteredPOs\(/);
});

test("it is re-exported and the warm cron loops every dept", () => {
  assert.match(route, /warmPoListDeptVariant,/);
  const w = worker.replace(/\s+/g, " ");
  assert.match(w, /const \{ warmPoListDeptVariant \} = await import\("\.\/routes\/production-orders"\)/);
  assert.match(w, /const \{ DEPT_ORDER \} = await import\("\.\/lib\/lead-times"\)/);
  assert.match(w, /for \(const dept of DEPT_ORDER\)/);
  assert.match(w, /warmPoListDeptVariant\(c, DEFAULT_ORG_ID, dept\)/);
});
