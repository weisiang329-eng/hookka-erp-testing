// ---------------------------------------------------------------------------
// self-apply-retry.test.mjs — a failed round of runtime DDL must be RETRIED,
// not remembered as done.
//
// Migrations are inert on deploy here (CLAUDE.md), so `ALTER TABLE … ADD COLUMN
// IF NOT EXISTS` awaited at the top of the first write is the ONLY path a new
// column takes to production. Every one of those blocks was written as
// `try { … } catch { /* ignore */ }` inside a module-scope promise that is set
// once per isolate boot — and still marked RESOLVED on failure.
//
// So one transient blip (a cold Hyperdrive pool, which this repo runs a
// keep-warm cron against precisely because it happens) on the first write after
// an isolate boots left the column unapplied and never retried for the life of
// that isolate. Every later write in that isolate then failed on a missing
// column, with nothing anywhere saying why.
//
// Same lesson as Houzs-ERP's pg-migration-dropped-defaults COE from the other
// direction: when the runtime path is the ONLY path, it cannot be best-effort.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import {
  runSelfApply,
  memoizeSelfApply,
  isBenignSelfApplyError,
} from "../src/api/lib/self-apply.ts";

function db(failOn = () => null) {
  const ran = [];
  return {
    ran,
    prepare(sql) {
      return {
        async run() {
          ran.push(sql);
          const err = failOn(sql);
          if (err) throw err;
          return {};
        },
      };
    },
  };
}

test("re-running idempotent DDL is the normal case, not a failure", () => {
  for (const m of [
    "column \"foo\" of relation \"bar\" already exists",
    'column "gone" does not exist',
    "duplicate column name: x",
  ]) {
    assert.ok(isBenignSelfApplyError(new Error(m)), m);
  }
  assert.ok(!isBenignSelfApplyError(new Error("Timed out while creating a new server connection")));
  assert.ok(!isBenignSelfApplyError(new Error("permission denied for table sales_orders")));
});

test("every statement is attempted even after one fails", () => {
  // A permission problem on one ALTER must not mask the rest — that half of
  // the original best-effort loop was right.
  const d = db((sql) => (sql.includes("B") ? new Error("permission denied") : null));
  return runSelfApply(d, "t", ["A", "B", "C"]).then(
    () => assert.fail("should have thrown"),
    () => assert.deepEqual(d.ran, ["A", "B", "C"]),
  );
});

test("a benign error does not fail the round", async () => {
  const d = db(() => new Error('column "x" already exists'));
  await runSelfApply(d, "t", ["A", "B"]);
  assert.deepEqual(d.ran, ["A", "B"]);
});

test("a real failure names the statement that failed", async () => {
  const d = db((sql) => (sql === "BAD" ? new Error("boom") : null));
  await assert.rejects(runSelfApply(d, "sales-orders", ["OK", "BAD"]), (e) => {
    assert.match(e.message, /sales-orders/);
    assert.match(e.message, /BAD/, "the failing statement IS the diagnosis");
    assert.match(e.message, /boom/);
    return true;
  });
});

test("THE BUG: a failed round is not remembered as done", async () => {
  let memo = null;
  let attempt = 0;
  const run = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("transient: cold pool");
  };
  const call = () =>
    memoizeSelfApply(
      () => memo,
      (p) => {
        memo = p;
      },
      run,
    );

  await assert.rejects(call(), /transient/);
  assert.equal(memo, null, "the failed round must NOT be left memoised");
  // The next request gets another chance — this is the entire fix.
  await call();
  assert.equal(attempt, 2);
});

test("a successful round still runs exactly once per isolate", async () => {
  let memo = null;
  let attempt = 0;
  const call = () =>
    memoizeSelfApply(
      () => memo,
      (p) => {
        memo = p;
      },
      async () => {
        attempt += 1;
      },
    );
  await Promise.all([call(), call(), call()]);
  await call();
  assert.equal(attempt, 1, "the memo must still collapse concurrent callers");
});

test("the canonical call site uses the helper", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/api/routes/sales-orders/_helpers.ts", "utf8");
  assert.match(src, /memoizeSelfApply\(/);
  assert.match(src, /runSelfApply\(db, "sales-orders", stmts\)/);
  assert.doesNotMatch(
    src,
    /catch \{\s*\n\s*\/\/ ignore — column may already exist/,
    "the swallow-everything loop must not return",
  );
});

// --- the sweep --------------------------------------------------------------

test("EVERY self-apply site uses the helper — the class, not one instance", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const walk = (d, out = []) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  };
  const offenders = [];
  for (const f of walk("src/api")) {
    if (f.endsWith("self-apply.ts")) continue;
    const src = readFileSync(f, "utf8");
    if (/for \(const sql of stmts\)/.test(src)) offenders.push(f);
  }
  assert.deepEqual(
    offenders,
    [],
    "a hand-rolled self-apply loop swallows errors AND memoises the failure — use runSelfApply",
  );
});

test("every converted site drops its memo when the round fails", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const walk = (d, out = []) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  };
  const missing = [];
  for (const f of walk("src/api")) {
    if (f.endsWith("self-apply.ts")) continue;
    const src = readFileSync(f, "utf8");
    if (!src.includes("runSelfApply(")) continue;
    // Either the explicit memoizeSelfApply wrapper, or the IIFE's .catch reset.
    const guarded =
      src.includes("memoizeSelfApply(") || /\)\(\)\.catch\(\(err\) => \{/.test(src);
    if (!guarded) missing.push(f);
  }
  assert.deepEqual(
    missing,
    [],
    "a rejected memo that is never cleared is as bad as a swallowed error",
  );
});
