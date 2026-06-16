// ---------------------------------------------------------------------------
// ocr-distill-supplier.test.mjs — the per-supplier OCR self-evolution engine
// (GRN / Purchase Invoice). Mirrors the customer distiller's safety contract:
//   • a supplier with < 2 gold samples is SKIPPED *without* an Anthropic call
//     (this cheap-skip is what makes iterating every supplier in the weekly
//     cron safe), and
//   • distillAllSupplierRules never aborts the whole sweep on one failure.
// No network: the cheap-skip path returns before any fetch, so a fake DB is
// enough. If this ever started calling Anthropic on < 2 samples the test would
// hang/throw (fetch is unavailable to the mock), which is the regression we
// want to catch.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import {
  distillSupplierRules,
  distillAllSupplierRules,
} from "../src/api/lib/ocr-distill.ts";

// Minimal D1-ish mock driven by the SQL text. `goldRows` controls how many
// gold samples the supplier_scan_samples query returns.
function makeDb({ supplier, goldRows = [], suppliers = [] }) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("FROM suppliers WHERE id"))
                return supplier ?? null;
              return null;
            },
            async all() {
              if (sql.includes("FROM supplier_scan_samples"))
                return { results: goldRows };
              if (sql.includes("FROM suppliers ORDER BY code"))
                return { results: suppliers };
              return { results: [] };
            },
            async run() {
              // ALTER / CREATE TABLE / UPDATE — all succeed in the mock.
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

const ENV = { ANTHROPIC_API_KEY: "test-key-not-used-on-skip-path" };
const SUP = { id: "sup-1", code: "SUP001", name: "ACME Textile" };

test("missing API key → error (no crash)", async () => {
  const db = makeDb({ supplier: SUP, goldRows: [{ correctedJson: "{}" }] });
  const res = await distillSupplierRules(db, {}, "org-1", "sup-1");
  assert.equal(res.status, "error");
  assert.match(res.reason, /ANTHROPIC_API_KEY/);
});

test("supplier not found → error", async () => {
  const db = makeDb({ supplier: null });
  const res = await distillSupplierRules(db, ENV, "org-1", "missing");
  assert.equal(res.status, "error");
  assert.match(res.reason, /not found/i);
});

test("< 2 gold samples → SKIPPED without an Anthropic call", async () => {
  // One sample only — must cheap-skip (no fetch). If it tried to call
  // Anthropic, the mock has no fetch wired and the test would fail.
  const db = makeDb({
    supplier: SUP,
    goldRows: [{ correctedJson: '{"docNo":"INV-1"}' }],
  });
  const res = await distillSupplierRules(db, ENV, "org-1", "sup-1");
  assert.equal(res.status, "skipped");
  assert.equal(res.sampleCount, 1);
});

test("zero gold samples → skipped with count 0", async () => {
  const db = makeDb({ supplier: SUP, goldRows: [] });
  const res = await distillSupplierRules(db, ENV, "org-1", "sup-1");
  assert.equal(res.status, "skipped");
  assert.equal(res.sampleCount, 0);
});

test("distillAllSupplierRules tallies skips and never throws", async () => {
  const db = makeDb({
    supplier: SUP,
    goldRows: [{ correctedJson: "{}" }], // 1 each → all skipped
    suppliers: [
      { id: "sup-1", orgId: "org-1" },
      { id: "sup-2", orgId: "org-1" },
    ],
  });
  const res = await distillAllSupplierRules(db, ENV, 50);
  assert.equal(res.total, 2);
  assert.equal(res.skipped, 2);
  assert.equal(res.distilled, 0);
  assert.equal(res.errored, 0);
});
