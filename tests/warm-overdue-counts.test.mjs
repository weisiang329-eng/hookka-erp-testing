// ---------------------------------------------------------------------------
// warm-overdue-counts.test.mjs
//
// /api/production-orders/overdue-counts measured p50 7,990ms / p95 30,010ms on
// 2026-08-01 - HALF of all calls paid an ~8s cold snapshot recompute, and the
// slowest hit the client's 30s abort outright. Every dept page requests it on
// open. Same cold-snapshot class as the dept sheet (#167); the warm cron simply
// never covered this endpoint.
//
// The failure mode to guard is NOT "is it warmed" - it is "is it warmed under
// the key the page actually asks for". Attempt 1 at warming the dept sheets
// (be17d4b4) warmed a key nobody requested and had to be reverted. So the route
// and the warmer must share ONE key definition, and these tests pin that.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping handles the .ts import */
}

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const flat = (p) => read(p).replace(/\s+/g, " ");

test("the route builds its cache key from the shared helper, not inline", () => {
  const f = flat("src/api/routes/production-orders.ts");
  assert.match(
    f,
    /const cacheKey = overdueCountsCacheKey\(dept, today\)/,
    "the handler must use the shared key builder",
  );
  // The inline template that used to live here is what the warmer could drift
  // from. It must be gone, not merely duplicated.
  assert.ok(
    !/const cacheKey = `v3&dept=\$\{dept \?\? ""\}&today=\$\{today\}`/.test(f),
    "the inline key template must be replaced by the shared helper",
  );
});

test("the key helper is exported and stable in shape", async () => {
  const { overdueCountsCacheKey } = await import(
    "../src/api/routes/production-orders.ts"
  );
  assert.equal(
    overdueCountsCacheKey("FAB_CUT", "2026-08-01"),
    "v3&dept=FAB_CUT&today=2026-08-01",
  );
  // dept=null is the Overview variant the /production landing page requests.
  assert.equal(
    overdueCountsCacheKey(null, "2026-08-01"),
    "v3&dept=&today=2026-08-01",
  );
});

test("the day is UTC here - NOT the MYT day the dept sheet key uses", async () => {
  const { overdueTodayUtc } = await import(
    "../src/api/routes/production-orders.ts"
  );
  // Deliberately different from todayMytISO() in _helpers.ts. Harmonising them
  // would silently orphan every stored overdue snapshot row, so the difference
  // is pinned rather than "cleaned up" by a future reader.
  assert.equal(overdueTodayUtc(), new Date().toISOString().slice(0, 10));
  const helpers = flat("src/api/routes/production-orders/_helpers.ts");
  assert.match(
    helpers,
    /8 \* 60 \* 60 \* 1000/,
    "the dept-sheet helper still uses the MYT shift - the two are intentionally different",
  );
});

// ---------------------------------------------------------------------------
// This block used to assert `await app.request("/overdue-counts…")` — i.e. it
// pinned the MECHANISM, and the mechanism did not work. A synthetic Hono
// sub-request gets a fresh context with an EMPTY c.var, and the DB binding is
// attached by middleware on the PARENT app, so the handler threw every time.
// The cron's own output on 2026-08-02:
//
//   "overdueCounts":{"ok":false,"warmed":0,"failed":["overview:500",
//     "FAB_CUT:500","FAB_SEW:500","WOOD_CUT:500","FOAM_CUTTING:500","FOAM:500",
//     "FRAMING:500","WEBBING:500","UPHOLSTERY:500","PACKING:500"]}
//
// Not one key had ever been warmed, which is why p50 stayed at ~8s after the
// warmer "shipped" — and this test was green throughout. It now pins the
// GUARANTEE (one body, one key, shared by route and cron) and forbids the
// broken call shape.
// ---------------------------------------------------------------------------
test("the warmer shares the route's computation — without faking a request", () => {
  const f = flat("src/api/routes/production-orders.ts");
  assert.match(f, /export async function warmOverdueCounts\(/);
  const warmer = f.slice(f.indexOf("export async function warmOverdueCounts("));
  const body = warmer.slice(0, warmer.indexOf("return { warmed, failed }"));
  assert.ok(
    !body.includes("app.request("),
    "app.request drops c.var (the DB binding) — every warm call 500s",
  );
  assert.match(
    body,
    /computeOverdueCounts\(c, dept \|\| null\)/,
    "the warmer must call the shared computation with the REAL context",
  );
  // Same function behind the route, so payload and cache key cannot drift.
  assert.match(
    f.slice(f.indexOf('app.get("/overdue-counts"')).slice(0, 400),
    /computeOverdueCounts\(c,/,
    "the route must delegate to the same function",
  );
  // Overview ("" = dept omitted) must be warmed too - it is the priciest one.
  assert.match(f, /for \(const dept of \["", \.\.\.depts\]\)/);
});

test("a warm failure is still counted and reported", () => {
  // `ok:false` in the cron output is the only reason this was ever found.
  const f = flat("src/api/routes/production-orders.ts");
  const warmer = f.slice(f.indexOf("export async function warmOverdueCounts("));
  assert.match(warmer.slice(0, 900), /failed\.push\(/);
});

test("the cron warms it, and one bad dept cannot abort the rest", () => {
  const w = flat("src/api/worker.ts");
  assert.match(w, /const \{ warmOverdueCounts \} = await import\("\.\/routes\/production-orders"\)/);
  assert.match(w, /warmOverdueCounts\(c, DEPT_ORDER\)/);
  // Reports which variants failed rather than a bare ok:false.
  assert.match(w, /out\.overdueCounts = \{ ok: r\.failed\.length === 0, warmed: r\.warmed, failed: r\.failed \}/);
  // Wrapped so a failure here never kills the other warmers in the cron.
  assert.match(w, /catch \(e\) \{ console\.error\("\[warm-lists\] overdueCounts failed:", e\)/);
});
