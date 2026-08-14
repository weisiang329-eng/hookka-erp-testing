// ---------------------------------------------------------------------------
// compliance-unknown-outcome.test.mjs — BUG-2026-08-13-141.
//
// The Daily Report could not say "I could not check".
//
// Every one of its fifteen checks ended `catch (err) { console.error(…);
// return []; }`. A check whose query THREW therefore contributed 0 to its chip
// and 0 to the headline — byte-identical to a check that ran and found nothing.
// The page then printed a green `0` under "A Quiet Day on the Floor", and the
// Command Center tile printed the same 0 under "All clear — nothing flagged
// today", over a sweep that had partly not happened. The owner reads that
// number every morning.
//
// This is C15 (`docs/BUG-CLASSES.md`): `0` is a claim, not a blank. It is also
// BUG-2026-08-13-096's lesson one layer up — a count over an incomplete
// population must publish that population.
//
// The fix keeps the "one bad query cannot 500 the report" property that the old
// catches existed for. It just moves the decision to ONE place — `runCheck` in
// `collectComplianceData` — instead of leaving fifteen catch blocks to each
// independently choose the word "clean".
//
// Part BEHAVIOURAL (a stub DB that breaks exactly one check) and part
// STRUCTURAL (the two renderers — a green 0 is valid markup, so only the source
// can pin the branch order). Every assertion was proved RED by reintroducing
// the exact removed expression, with the file's bytes asserted changed on disk
// before the run.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { collectComplianceData } from "../src/api/lib/compliance-report.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const read = (rel) =>
  readFileSync(join(root, rel), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
function stripComments(src) {
  return src
    .replace(/^[ \t]*\{?\/\*[\s\S]*?\*\/\}?[ \t]*$/gm, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

const SRC = "src/api/lib/compliance-report.ts";
const PAGE = "src/pages/daily-report.tsx";
const DASH = "src/pages/dashboard-b/index.tsx";

/**
 * A D1-shaped stub that returns nothing for every query — a genuinely clean
 * day — except that any statement matching `breakOn` throws.
 */
function db({ breakOn = null } = {}) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              if (breakOn && breakOn.test(sql)) throw new Error("boom");
              return { results: [] };
            },
            async first() {
              if (breakOn && breakOn.test(sql)) throw new Error("boom");
              return null;
            },
          };
        },
      };
    },
  };
}

// ===========================================================================
// BEHAVIOUR
// ===========================================================================

test("a genuinely clean day reports zeros AND full coverage", () => {
  return collectComplianceData(db(), "2026-08-14").then((d) => {
    assert.deepEqual(d.unavailable, [], "nothing failed");
    assert.equal(d.counts.total, 0);
    assert.equal(d.counts.checksRun, d.counts.checksTotal);
    assert.equal(
      d.counts.doPendingDispatch,
      0,
      "a check that RAN and found nothing counts 0 — that is still the honest " +
        "answer and must not become null",
    );
  });
});

test("a check that throws reports NULL, not zero, and names itself", async () => {
  // `delivery_orders` + DRAFT is checkDoPendingDispatch's query.
  const d = await collectComplianceData(
    db({ breakOn: /FROM delivery_orders[\s\S]*DRAFT/ }),
    "2026-08-14",
  );
  assert.ok(
    d.unavailable.length > 0,
    "the failure must be published, not logged and forgotten",
  );
  const failed = d.unavailable.map((u) => u.check);
  assert.ok(
    failed.includes("doPendingDispatch"),
    `expected doPendingDispatch to be unavailable, got: ${failed.join(", ")}`,
  );
  assert.equal(
    d.counts.doPendingDispatch,
    null,
    "an unavailable check must be null — `0` says 'we looked and it is clean'",
  );
  assert.ok(
    d.counts.checksRun < d.counts.checksTotal,
    "coverage must show the sweep was partial",
  );
});

test("the report still does not 500 when a check breaks", async () => {
  // The property the old catch blocks existed for is kept — it is only the
  // MEANING of the empty result that changed.
  const d = await collectComplianceData(
    db({ breakOn: /FROM delivery_orders/ }),
    "2026-08-14",
  );
  assert.ok(d.generatedAtIso, "a payload is still produced");
  assert.equal(d.today, "2026-08-14");
  assert.ok(Array.isArray(d.groups.doPendingDispatch), "its group is still an array");
});

test("an unavailable check contributes nothing to the total — not a zero", async () => {
  const clean = await collectComplianceData(db(), "2026-08-14");
  const broken = await collectComplianceData(
    db({ breakOn: /FROM delivery_orders/ }),
    "2026-08-14",
  );
  assert.equal(clean.counts.total, 0);
  assert.equal(broken.counts.total, 0);
  // Identical totals, different meanings — which is precisely why the total
  // alone may never be rendered as an all-clear.
  assert.ok(
    broken.counts.checksRun < clean.counts.checksRun,
    "the ONLY thing separating those two days is the coverage, so it has to " +
      "be in the payload and it has to be read",
  );
});

// ===========================================================================
// STRUCTURAL — no check may quietly return [] again
// ===========================================================================

test("no check swallows its own error back into an empty result", () => {
  const src = stripComments(read(SRC));
  const swallows = [...src.matchAll(/catch \(err\) \{[\s\S]{0,200}?\n  \}/g)]
    .map((m) => m[0])
    .filter((block) => /return \[\];/.test(block));
  assert.deepEqual(
    swallows,
    [],
    "a check returning [] on failure is indistinguishable from a clean one — " +
      "rethrow and let runCheck record it",
  );
  assert.ok(
    /async function runCheck</.test(src),
    "the single place that decides what an unreadable check means must exist",
  );
  assert.ok(
    /unavailable\.push\(\{ check: key, message: o\.message \}\)/.test(src),
    "and it must record WHICH check, or the report cannot name what it missed",
  );
});

test("the sibling money detectors rethrow too", () => {
  // The class's own rule: fix every instance, not the flagged one. These two
  // run inside the same sweep and had the same swallow — and pricing-integrity
  // is the file whose header records a type error that threw on every row and
  // was reported as a clean book.
  for (const f of ["src/api/lib/pricing-integrity.ts", "src/api/lib/cogs-integrity.ts"]) {
    const src = stripComments(read(f));
    const bad = [...src.matchAll(/catch[\s\S]{0,160}?\n  \}/g)]
      .map((m) => m[0])
      .filter((b) => /return \[\];|return null;/.test(b));
    assert.deepEqual(bad, [], `${f} still swallows a failure into an all-clear`);
  }
});

// ===========================================================================
// STRUCTURAL — neither renderer may print a clean day over a partial sweep
// ===========================================================================

test("'A Quiet Day' requires every check to have run", () => {
  const src = stripComments(read(PAGE));
  assert.ok(
    /counts\.total === 0 && unavailableCount === 0 \?/.test(src),
    "the quiet-day branch must require BOTH nothing found and nothing missed",
  );
  assert.ok(
    /const unavailableCount =/.test(src),
    "the page must derive the coverage before it renders any verdict",
  );
  assert.ok(
    /An Unknown Day on the Floor/.test(src),
    "a zero over a partial sweep needs its own honest headline",
  );
});

test("a per-check tile renders an em dash, not a green zero", () => {
  const src = stripComments(read(PAGE));
  assert.ok(
    /const unknown = value == null;/.test(src),
    "CountTile must distinguish 'could not check' from 'zero'",
  );
  assert.ok(
    /\{unknown \? "—" : value\}/.test(src),
    "an unavailable check must print — , never a number it did not measure",
  );
  assert.ok(
    /count == null \?[\s\S]{0,300}?Couldn&apos;t check/.test(src),
    "the Section badge must say so instead of 'Clear'",
  );
});

test("the Command Center tile refuses 'All clear' over a partial sweep", () => {
  const src = stripComments(read(DASH));
  assert.ok(
    /const compPartial = !compFailed && compUnavailable > 0;/.test(src),
    "the tile must read the per-check coverage, not only the fetch outcome — " +
      "a 200 response can still carry a sweep that half ran",
  );
  assert.ok(
    /compPartial\s*\?[\s\S]{0,300}?All clear/.test(src),
    "the 'All clear' caption must sit BEHIND the partial branch",
  );
  assert.ok(
    /checks couldn't run/.test(src),
    "and the tile has to say how many, or the reader cannot size the gap",
  );
});
