// ---------------------------------------------------------------------------
// production-warm-dept-snapshot.test.mjs
//
// The per-dept sheet warmer. Attempt 1 (be17d4b4) shipped a snapshot key that
// NEVER matched the live request and was reverted (071fcee7): it assumed the
// dept page sends no date window, but a cold open seeds dueFrom=dueTo=today.
// The warmer built a snapshot nobody read and burned cron time per dept.
//
// So these tests do NOT just assert "a key is produced". They reconstruct the
// key the FRONT-END actually requests, from src/pages/production/index.tsx's
// own URL construction, and assert the warmer's key is byte-identical. That is
// the only assertion that would have caught attempt 1.
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

// How the handler derives the key (production-orders.ts): the request's query
// string, sorted and "&"-joined.
const handlerKey = (url) =>
  new URL(url, "https://x").searchParams.toString().split("&").sort().join("&");

test("warm key is byte-identical to the dept sheet's cold-open request", async () => {
  const { deptWarmCacheKey, todayMytISO } = await import(
    "../src/api/routes/production-orders/_helpers.ts"
  );
  const today = todayMytISO();

  for (const dept of ["FAB_CUT", "FOAM_CUTTING", "UPHOLSTERY", "PACKING"]) {
    // Exactly what index.tsx builds on a cold dept open:
    //   `/api/production-orders?fields=minimal&dept=<D>` + `&excludeCompleted=true`
    //   + `&dueFrom=<today>&dueTo=<today>`   (searchActive=false, clearAll=false)
    const feUrl =
      `/api/production-orders?fields=minimal&dept=${encodeURIComponent(dept)}` +
      `&excludeCompleted=true` +
      `&dueFrom=${encodeURIComponent(today)}&dueTo=${encodeURIComponent(today)}`;

    assert.equal(
      deptWarmCacheKey(dept, today),
      handlerKey(feUrl),
      `warm key must equal the handler key for ${dept} — this is exactly how attempt 1 failed`,
    );
  }
});

test("the reverted (windowless) key shape is NOT what we ship", async () => {
  const { deptWarmCacheKey, todayMytISO } = await import(
    "../src/api/routes/production-orders/_helpers.ts"
  );
  const dead = "dept=FAB_CUT&excludeCompleted=true&fields=minimal";
  assert.notEqual(
    deptWarmCacheKey("FAB_CUT", todayMytISO()),
    dead,
    "regressed to attempt 1's windowless key — it matches no live request",
  );
});

test("todayMytISO agrees with the FE's todayISO (UTC+8, no DST)", async () => {
  const { todayMytISO } = await import(
    "../src/api/routes/production-orders/_helpers.ts"
  );
  const feToday = new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  assert.equal(todayMytISO(), feToday);
  assert.match(todayMytISO(), /^\d{4}-\d{2}-\d{2}$/);
  // The FE derives its window from utils.todayISO — same +8h shift. If that
  // ever changes, the key drifts a day at the UTC boundary and the warmer
  // silently stops matching again.
  assert.match(flat("src/pages/production/utils.ts"), /8 \* 60 \* 60 \* 1000/);
});

test("the warmer computes rows over the SAME window its key advertises", () => {
  const f = flat("src/api/routes/production-orders/_helpers.ts");
  // fetchFilteredPOs must receive today/today, not null/null — otherwise the
  // snapshot holds more rows than the key promises.
  assert.match(
    f,
    /dept, \/\/ deptFilter today, \/\/ dueFrom[^]*?today, \/\/ dueTo/,
    "warmer must filter by the same day window it keys on",
  );
});

test("cron warms every dept in DEPT_ORDER, and one failure can't abort the rest", () => {
  const w = flat("src/api/worker.ts");
  assert.match(w, /warmPoListDeptVariant/);
  assert.match(w, /for \(const dept of DEPT_ORDER\)/);
  // Per-dept try/catch: a single bad dept must not skip the others.
  assert.match(w, /for \(const dept of DEPT_ORDER\) \{ try \{/);
  assert.match(flat("src/api/routes/production-orders.ts"), /warmPoListDeptVariant/);
});
