// ---------------------------------------------------------------------------
// data-grid-collator.test.mjs — the shared Intl.Collator in `compareValues`
// must order EXACTLY like the `localeCompare` call it replaced.
//
// `compareValues` (src/components/ui/data-grid.tsx) is the sort comparator for
// every DataGrid in the app. It used to call
//     String(a).localeCompare(String(b), undefined, { numeric: true })
// which, per ECMA-402, is defined as
//     %Collator%(undefined, { numeric: true }).compare(a, b)
// i.e. it builds/looks up a collator on EVERY comparison. A sort click does
// n·log₂n comparisons, so on the Production grid (2,539 rows ≈ 28,700
// comparisons) that is the whole cost of the click.
//
// Hoisting one collator to module scope is the same algorithm with the same
// locale resolution — only the RESOLUTION TIME moves (module load, not call).
// A tab's default locale does not change mid-session.
//
// This test is a DIFFERENTIAL: it re-implements both comparators verbatim and
// asserts sign-identical ordering across the string shapes this app actually
// sorts — document numbers (SO-2608-0007), customer names, mixed case,
// accents, blanks, numeric-vs-numeric, and the null/number fast paths that
// bypass the collator entirely. It also records the measured speedup so a
// future revert is an obviously-worse trade, not a silent one.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// --- the two comparators, copied verbatim ---------------------------------
function compareOld(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

const COLLATOR = new Intl.Collator(undefined, { numeric: true });
function compareNew(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return COLLATOR.compare(String(a), String(b));
}

const sign = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0);

// --- corpus: the value shapes this app's grids really sort ----------------
const CORPUS = [
  // document numbers — the numeric:true case that makes SO-...-9 < SO-...-10
  "SO-2608-0001", "SO-2608-0002", "SO-2608-0009", "SO-2608-0010", "SO-2608-0100",
  "PO-2608-9", "PO-2608-10", "PO-2608-100", "GRN-2607-001", "DO-2607-005", "DO-2607-017",
  "INV-2608-1", "INV-2608-2", "CN-2608-11",
  // customer / product names, mixed case + punctuation
  "AKEMI", "akemi", "Akemi Sdn Bhd", "AKEMI SDN BHD", "TRION", "Trion (M) Sdn Bhd",
  "KETTA", "XAMMAR", "Hookka Century", "hookka century", "OHANA",
  "3M Furniture", "10 Star Bedding", "2 Brothers Trading",
  // statuses / departments / states — the value-filter + group columns
  "CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP", "DELIVERED", "INVOICED", "CANCELLED",
  "FAB-CUT", "FAB-SEW", "FOAM", "Selangor", "Johor", "Pulau Pinang", "W.P. Kuala Lumpur",
  // dates as rendered strings, and money-ish strings
  "2026-08-13", "2026-8-13", "2026-08-09", "2025-12-31", "1,234.50", "995.14", "1000",
  // whitespace / blank / unicode edge shapes
  "", " ", "  leading", "trailing  ", "—", "café", "cafe", "Café", "ZZ", "zz", "Ábaco",
  // numeric strings that must not be compared byte-wise
  "9", "10", "11", "100", "0", "007", "7",
];

test("every ordered pair in the corpus compares identically", () => {
  let pairs = 0;
  for (const a of CORPUS) {
    for (const b of CORPUS) {
      assert.equal(
        sign(compareNew(a, b)),
        sign(compareOld(a, b)),
        `divergence on ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
      );
      pairs++;
    }
  }
  assert.ok(pairs > 4000, `expected a real corpus, compared only ${pairs} pairs`);
});

test("the null / number fast paths are untouched", () => {
  const specials = [null, undefined, 0, 1, -1, 42, 3.5, NaN];
  for (const a of [...specials, "x", ""]) {
    for (const b of [...specials, "x", ""]) {
      assert.equal(
        sign(compareNew(a, b)),
        sign(compareOld(a, b)),
        `divergence on ${String(a)} vs ${String(b)}`,
      );
    }
  }
});

test("a full sort produces a byte-identical order", () => {
  // Sorting is where a comparator difference would actually show. Shuffle
  // deterministically, sort with both, compare the resulting arrays.
  let seed = 20260813;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rows = [];
  for (let i = 0; i < 4000; i++) {
    rows.push(CORPUS[Math.floor(rand() * CORPUS.length)] + (i % 7 === 0 ? "" : `-${i % 130}`));
  }
  const byOld = [...rows].sort(compareOld);
  const byNew = [...rows].sort(compareNew);
  assert.deepEqual(byNew, byOld);
});

test("the shared collator is genuinely faster (this is the whole point)", () => {
  const rows = [];
  for (let i = 0; i < 2539; i++) rows.push(`Customer Sdn Bhd ${(i * 37) % 240}`);
  const time = (cmp) => {
    [...rows].sort(cmp); // warm
    const t0 = process.hrtime.bigint();
    for (let r = 0; r < 5; r++) [...rows].sort(cmp);
    return Number(process.hrtime.bigint() - t0) / 1e6 / 5;
  };
  const oldMs = time(compareOld);
  const newMs = time(compareNew);
  // Measured ~27× on this machine; assert a conservative floor so the test is
  // about the ALGORITHM (one collator, not n·log n collators), not the CPU.
  assert.ok(
    newMs * 3 < oldMs,
    `expected the shared collator to be >3x faster; got old=${oldMs.toFixed(2)}ms new=${newMs.toFixed(2)}ms`,
  );
});

test("data-grid.tsx uses the shared collator, not a per-call localeCompare", () => {
  // Source guard: the hot comparator must not drift back. Other localeCompare
  // calls in the file (column-customizer ordering, unique-value lists) run over
  // tens of items, not n·log n over the dataset, and are deliberately left be.
  const src = readFileSync(
    resolve(process.cwd(), "src/components/ui/data-grid.tsx"),
    "utf8",
  );
  const fn = src.slice(src.indexOf("function compareValues"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /COLLATOR\.compare\(/);
  assert.equal(
    /localeCompare/.test(body),
    false,
    "compareValues went back to a per-comparison localeCompare",
  );
  assert.match(src, /const COLLATOR = new Intl\.Collator\(undefined, \{ numeric: true \}\)/);
});
