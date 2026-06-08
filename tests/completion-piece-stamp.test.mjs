// ---------------------------------------------------------------------------
// completion-piece-stamp.test.mjs — locks planCompletionPieceStamps, the pure
// decision behind BUG-2026-06-08-008 (dashboard completion stamps piece_pics so
// the worker phone can't re-scan a card the office already completed).
//
// The three outcomes per physical piece:
//   • INSERT — no slot yet → create one stamped with the card PIC
//   • FILL   — slot exists but un-scanned (pic1Id empty) → fill with card PIC
//   • SKIP   — a worker already scanned it → leave it (preserve attribution)
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

const { planCompletionPieceStamps } = await import(
  pathToFileURL(
    resolve(process.cwd(), "src/api/lib/completion-piece-stamp.ts"),
  ).href
);

test("no slots yet, single-piece card → insert piece 1, nothing to fill", () => {
  assert.deepEqual(planCompletionPieceStamps(1, []), { insert: [1], fill: [] });
});

test("no slots yet, 2-piece card → insert both pieces", () => {
  assert.deepEqual(planCompletionPieceStamps(2, []), {
    insert: [1, 2],
    fill: [],
  });
});

test("existing empty slots (created but un-scanned) → fill them, insert none", () => {
  const existing = [
    { pieceNo: 1, pic1Id: null },
    { pieceNo: 2, pic1Id: null },
  ];
  assert.deepEqual(planCompletionPieceStamps(2, existing), {
    insert: [],
    fill: [1, 2],
  });
});

test("fully worker-scanned → skip everything (no insert, no fill)", () => {
  const existing = [
    { pieceNo: 1, pic1Id: "emp-1" },
    { pieceNo: 2, pic1Id: "emp-2" },
  ];
  assert.deepEqual(planCompletionPieceStamps(2, existing), {
    insert: [],
    fill: [],
  });
});

test("PARTIAL — worker did piece 1, piece 2 slot missing → insert 2, keep 1", () => {
  // The tricky case ensurePiecePicsForJc can't handle (it skips creation when
  // ANY slot exists). Piece 1 (worker) is left alone; piece 2 is created.
  const existing = [{ pieceNo: 1, pic1Id: "emp-1" }];
  assert.deepEqual(planCompletionPieceStamps(2, existing), {
    insert: [2],
    fill: [],
  });
});

test("MIXED — piece 1 scanned, piece 2 exists but empty → fill 2 only", () => {
  const existing = [
    { pieceNo: 1, pic1Id: "emp-1" },
    { pieceNo: 2, pic1Id: null },
  ];
  assert.deepEqual(planCompletionPieceStamps(2, existing), {
    insert: [],
    fill: [2],
  });
});

test("worker on piece 2 only, piece 1 missing → insert 1, skip 2", () => {
  const existing = [{ pieceNo: 2, pic1Id: "emp-9" }];
  assert.deepEqual(planCompletionPieceStamps(2, existing), {
    insert: [1],
    fill: [],
  });
});

test("empty-string pic1Id counts as un-scanned → fill", () => {
  const existing = [{ pieceNo: 1, pic1Id: "" }];
  assert.deepEqual(planCompletionPieceStamps(1, existing), {
    insert: [],
    fill: [1],
  });
});

test("wipQty null/0 clamps to a single piece", () => {
  assert.deepEqual(planCompletionPieceStamps(null, []), {
    insert: [1],
    fill: [],
  });
  assert.deepEqual(planCompletionPieceStamps(0, []), {
    insert: [1],
    fill: [],
  });
});

test("fractional wipQty floors (defensive)", () => {
  assert.deepEqual(planCompletionPieceStamps(2.9, []), {
    insert: [1, 2],
    fill: [],
  });
});
