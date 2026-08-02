// ---------------------------------------------------------------------------
// snapshot-swr.test.mjs — withSnapshot() single-flight + serve-stale-while-
// revalidate behaviour (the "不卡 / 不爆" hardening, 2026-06-06).
//
// withSnapshot needs a D1Database, so we hand it a tiny SQL-routing mock:
//   • information_schema probe  -> returns updated_at columns for both tables
//   • SELECT MAX(...) AS maxUpdatedAt -> the cross-table freshness watermark
//   • readSnapshot (SELECT ... AS "builtFrom") -> the (optional) prior row
//   • INSERT INTO ... (writeSnapshot) -> recorded, so we can assert write-back
//
// We assert four behaviours:
//   1. cold cache         -> computeFresh runs once, result written back
//   2. single-flight      -> concurrent cold reads share ONE computeFresh (爆)
//   3. SWR + waitUntil     -> stale copy returned instantly, refresh in bg (卡)
//   4. SWR, no runtime     -> falls back to a synchronous recompute (tests)
//   5. fresh cache        -> served as-is, computeFresh never runs
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on Node 22+.
}

const { withSnapshot } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/snapshot.ts")).href
);

const CONFIG = {
  tableName: "production_orders_list_snapshot",
  sourceTables: ["production_orders", "job_cards"],
};

function makeDb({ snapshotRow = null, currentMax = "2030-01-01T00:00:00.000Z" } = {}) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (sql.includes('"maxUpdatedAt"')) return { maxUpdatedAt: currentMax };
          // readSnapshot is a star select as of 2026-08-02 (v1 named the new
          // source_rows column explicitly and ran DDL on the read path, which
          // took production down). Match either shape.
          if (sql.includes("SELECT * FROM") || sql.includes('"builtFrom"')) {
            return snapshotRow;
          }
          return null;
        },
        async all() {
          if (sql.includes("information_schema")) {
            return {
              results: [
                { tableName: "production_orders", columnName: "updated_at" },
                { tableName: "job_cards", columnName: "updated_at" },
              ],
            };
          }
          // Cross-table freshness probe — UNION of per-table MAX(col)::text AS t.
          // 2026-06-08: the probe now takes the chronological MAX in JS via
          // .all() (was a lexical SQL MAX(t)::first()) — see snapshot-freshness.ts.
          // Hand it the watermark as one per-table row.
          if (sql.includes("AS t")) {
            // The probe now also returns COUNT(*) AS n — the only signal that
            // can perceive a DELETE. Echo the snapshot's own count so these
            // SWR cases stay about staleness, not about row counts.
            // `n` is OMITTED unless the fixture opts in: Number(undefined) is
            // NaN, so getSourceSignature reports rowCount null and the count
            // check is skipped. These cases are about staleness, not deletes —
            // the delete behaviour has its own file.
            return {
              results: [
                snapshotRow?.sourceRows === undefined
                  ? { t: currentMax }
                  : { t: currentMax, n: snapshotRow.sourceRows },
              ],
            };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO")) writes.push(sql);
          return {};
        },
      };
    },
  };
}

function staleRow(v = "stale") {
  return {
    data: { v },
    builtFrom: "2020-01-01T00:00:00.000Z",
    builtAt: "2020-01-01T00:00:00.000Z",
    refreshCount: 1,
  };
}

test("cold cache → computeFresh runs once and writes back", async () => {
  const db = makeDb({ snapshotRow: null });
  let calls = 0;
  const out = await withSnapshot(
    db,
    CONFIG,
    "org1",
    async () => {
      calls++;
      return { v: "fresh" };
    },
    "k-cold",
  );
  assert.equal(calls, 1);
  assert.deepEqual(out, { v: "fresh" });
  assert.ok(db.writes.length >= 1, "snapshot written back on cold compute");
});

test("single-flight: concurrent cold reads share ONE computeFresh", async () => {
  const db = makeDb({ snapshotRow: null });
  let calls = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const compute = async () => {
    calls++;
    await gate;
    return { v: calls };
  };
  const a = withSnapshot(db, CONFIG, "org1", compute, "k-singleflight");
  const b = withSnapshot(db, CONFIG, "org1", compute, "k-singleflight");
  // Let both reach the in-flight registry while the compute is gated.
  await new Promise((r) => setTimeout(r, 15));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1, "computeFresh deduped to a single run");
  assert.deepEqual(ra, rb, "both callers get the same result");
});

test("SWR + waitUntil: stale copy returned instantly, refreshed in background", async () => {
  const db = makeDb({ snapshotRow: staleRow(), currentMax: "2030-01-01T00:00:00.000Z" });
  let calls = 0;
  let revalidated = 0;
  const bg = [];
  const fakeC = { env: {}, executionCtx: { waitUntil: (p) => bg.push(p) } };
  const out = await withSnapshot(
    db,
    CONFIG,
    "org1",
    async () => {
      calls++;
      return { v: "fresh" };
    },
    "k-swr",
    fakeC,
    { staleWhileRevalidate: true, onRevalidated: () => { revalidated++; } },
  );
  assert.deepEqual(out, { v: "stale" }, "served the stale copy immediately");
  assert.equal(bg.length, 1, "scheduled exactly one background refresh");
  await Promise.all(bg);
  assert.equal(calls, 1, "background recompute ran once");
  assert.equal(revalidated, 1, "onRevalidated fired after the refresh landed");
});

test("SWR requested but no Worker runtime → synchronous recompute", async () => {
  const db = makeDb({ snapshotRow: staleRow(), currentMax: "2030-01-01T00:00:00.000Z" });
  let calls = 0;
  const out = await withSnapshot(
    db,
    CONFIG,
    "org1",
    async () => {
      calls++;
      return { v: "fresh" };
    },
    "k-swr-nort",
    { env: {} }, // no executionCtx
    { staleWhileRevalidate: true },
  );
  assert.equal(calls, 1, "fell back to a synchronous recompute");
  assert.deepEqual(out, { v: "fresh" });
});

test("fresh snapshot → served from cache, computeFresh never runs", async () => {
  const fresh = {
    data: { v: "cached" },
    builtFrom: "2030-06-01T00:00:00.000Z",
    builtAt: "2030-06-01T00:00:00.000Z",
    refreshCount: 5,
  };
  const db = makeDb({ snapshotRow: fresh, currentMax: "2030-01-01T00:00:00.000Z" });
  let calls = 0;
  const out = await withSnapshot(
    db,
    CONFIG,
    "org1",
    async () => {
      calls++;
      return { v: "fresh" };
    },
    "k-fresh",
  );
  assert.equal(calls, 0, "no recompute when the snapshot is fresh");
  assert.deepEqual(out, { v: "cached" });
});
